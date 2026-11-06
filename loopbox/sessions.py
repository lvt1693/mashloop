"""Whose library is it. Hosted (MULTIUSER), every visit opens a session with a
library of its own that starts empty and lives in memory until the visit has
been idle for SESSION_TTL_S; the songs themselves are a store shared by all
sessions. Personal, there is one library: the whole store, kept on disk."""
import secrets
import threading
import time

from . import library, worker
from .config import MAX_SESSION_TRACKS, MAX_SESSIONS, MULTIUSER, SESSION_TTL_S

_lock = threading.RLock()
_sessions: dict[str, "SessionView"] = {}
_local = None
_started = time.time()
RESTORE_GRACE_S = 180  # after a restart, the pages put their libraries back
TOUCH_EVERY_S = 300  # how often an open page marks its songs as used
# A visit with nothing in its library, quiet this long, is let go (a closed
# page, or a program opening visit after visit); one with songs keeps its
# SESSION_TTL_S, so a listener coming back finds their library.
EMPTY_IDLE_S = 900


class LimitError(Exception):
    pass


class View:
    """A library: which songs, which are in the chain, and the transitions
    between them assembled from the shared pairs."""

    def __init__(self):
        self.link_ver = 0
        self._assembled_key = None
        self._assembled = {}
        self._onward = {}
        self._assemble_lock = threading.Lock()

    # -- songs
    def track_ids(self) -> list[str]:
        raise NotImplementedError

    def metas(self) -> list[dict]:
        out = []
        for tid in self.track_ids():
            m = library.read_meta(tid)
            if m:
                out.append({**m, "enabled": self.is_enabled(tid, m)})
        return out

    def ready_ids(self) -> list[str]:
        return [m["id"] for m in self.metas() if m.get("status") == "ready"]

    def is_enabled(self, tid: str, meta: dict) -> bool:
        raise NotImplementedError

    def keep_alive(self) -> None:
        """Called whenever the page asks for its library (the personal app
        keeps its sound: nothing to do)."""

    # -- transitions
    def transitions(self, tid: str) -> list[dict]:
        return self._lists()[0].get(tid, [])

    def onward(self, tid: str) -> dict[str, list]:
        """For each song tid leads to, that song's best ways on (one step ahead)."""
        lists, ahead = self._lists()
        return {d: ahead.get(d, []) for d in {t["to"] for t in lists.get(tid, [])}}

    def _lists(self) -> tuple[dict, dict]:
        from .analysis import transitions
        ready = tuple(sorted(self.ready_ids()))
        key = (ready, self.link_ver)
        with self._assemble_lock:
            if key != self._assembled_key:
                self._assembled = transitions.assemble(list(ready))
                self._onward = transitions.onward(self._assembled)
                self._assembled_key = key
            return self._assembled, self._onward

    def link(self, tid: str | None = None) -> None:
        """Schedules the missing pairs: of one newly ready song with the rest,
        or of the whole library."""
        ready = self.ready_ids()
        for t in ([tid] if tid else ready):
            if t in ready:
                worker.enqueue_links(t, ready)

    def linked(self) -> None:
        with _lock:
            self.link_ver += 1


class SessionView(View):
    def __init__(self, sid: str):
        super().__init__()
        self.id = sid
        self.ids: list[str] = []
        self.off: set[str] = set()
        self.seen = self.created = time.time()
        self.touched = 0.0
        # Scrambles the audio this session is sent (see server.audio).
        self.key = secrets.token_bytes(32)

    def keep_alive(self) -> None:
        """An open page uses its songs: marked as used every few minutes, so
        their sound is deleted only AUDIO_TTL_S after the page last asked
        (library.drop_idle_audio), and the time shown for it is true."""
        now = time.time()
        if now - self.touched < TOUCH_EVERY_S:
            return
        self.touched = now
        for tid in self.track_ids():
            library.touch(tid)

    def track_ids(self) -> list[str]:
        return list(self.ids)

    def is_enabled(self, tid, meta):
        return tid not in self.off

    def room(self) -> int:
        """Songs the listener may still add. The sample library does not
        count: it is already on the server and costs nothing to hold."""
        samples = set(library.samples()["ids"])
        return max(0, MAX_SESSION_TRACKS - sum(1 for t in self.ids if t not in samples))

    def add(self, tid: str) -> None:
        with _lock:
            if tid in self.ids:
                return
            if tid not in library.samples()["ids"] and self.room() <= 0:
                raise LimitError(f"Thư viện đã đủ {MAX_SESSION_TRACKS} bài: bỏ bớt một bài để thêm bài khác")
            self.ids.append(tid)
        library.touch(tid)

    def remove(self, tid: str) -> None:
        with _lock:
            if tid in self.ids:
                self.ids.remove(tid)
            self.off.discard(tid)

    def set_enabled(self, tid: str, on: bool) -> None:
        with _lock:
            (self.off.discard if on else self.off.add)(tid)


class LocalView(View):
    """The personal app: the library is everything on disk."""

    id = "local"
    key = None

    def room(self):
        return 1 << 30

    def track_ids(self):
        return [m["id"] for m in library.list_tracks()]

    def metas(self):
        return library.list_tracks()

    def is_enabled(self, tid, meta):
        return meta.get("enabled") is not False

    def add(self, tid):
        library.touch(tid)

    def remove(self, tid):
        library.delete(tid)

    def set_enabled(self, tid, on):
        library.update(tid, enabled=on)


class Full(Exception):
    """The server holds MAX_SESSIONS visits, none of them empty."""


def create() -> View:
    if not MULTIUSER:
        return local()
    _sweep()
    sid = secrets.token_urlsafe(18)
    with _lock:
        if len(_sessions) >= MAX_SESSIONS:
            # Room: the empty visits that have been quiet longest go first.
            empty = sorted((v for v in _sessions.values() if not v.ids), key=lambda v: v.seen)
            for v in empty[:len(_sessions) - MAX_SESSIONS + 1]:
                _sessions.pop(v.id, None)
        if len(_sessions) >= MAX_SESSIONS:
            raise Full()
        v = SessionView(sid)
        _sessions[sid] = v
    return v


def get(sid: str | None) -> View | None:
    if not MULTIUSER:
        return local()
    with _lock:
        v = _sessions.get(sid or "")
        if v is None:
            return None
        if time.time() - v.seen > SESSION_TTL_S:
            _sessions.pop(v.id, None)
            return None
        v.seen = time.time()
        return v


def local() -> LocalView:
    global _local
    with _lock:
        if _local is None:
            _local = LocalView()
        return _local


def views() -> list[View]:
    if not MULTIUSER:
        return [local()]
    with _lock:
        return list(_sessions.values())


def in_use() -> set[str]:
    """Songs some live library holds, and the sample library: never evicted,
    and their sound never deleted for going unused."""
    keep = set(library.samples()["ids"])
    if not MULTIUSER:
        return keep | set(library.ready_ids())
    _sweep()
    with _lock:
        return keep | {t for v in _sessions.values() for t in v.ids}


def _sweep() -> None:
    now = time.time()
    with _lock:
        for sid in [s for s, v in _sessions.items()
                    if now - v.seen > SESSION_TTL_S or (not v.ids and now - v.seen > EMPTY_IDLE_S)]:
            _sessions.pop(sid, None)


# A song just analysed is linked into every library that holds it; a pair
# just computed refreshes the libraries holding both of its songs.
def _on_ready(tid: str) -> None:
    for v in views():
        if tid in v.track_ids():
            v.link(tid)


def _on_linked(tids: set[str]) -> None:
    for v in views():
        if len(tids & set(v.track_ids())) >= 2:
            v.linked()


def held(tid: str) -> bool:
    """Whether a live library holds the song (always, in the personal app)."""
    if not MULTIUSER:
        return True
    with _lock:
        return any(tid in v.ids for v in _sessions.values())


def wanted(tid: str) -> bool:
    """Whether a song still has someone waiting for it (to be downloaded).
    Just after a restart every song does, until the pages have put their
    libraries back."""
    return held(tid) or time.time() - _started < RESTORE_GRACE_S


worker.on_ready.append(_on_ready)
worker.on_linked.append(_on_linked)
worker.keep_ids = in_use
worker.wanted = wanted

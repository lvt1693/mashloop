"""Background work, in parallel. Songs from links are downloaded first, one
at a time for the whole app (a thread of the server, in the order they were
asked for, a pause after each: the queue every listener sees, where each can
call off their own); then songs are analysed in a pool of worker processes
(ANALYSIS_WORKERS, each holding its own models on the GPU), and transitions
between songs are computed in a second pool (LINK_WORKERS). The server process
schedules: it knows what is on its way and tells whoever is listening when a
song is ready or a pair of songs is linked."""
import multiprocessing as mp
import os
import statistics
import threading
import time
import traceback
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import Callable

from . import library
from .config import ANALYSIS_VERSION, ANALYSIS_WORKERS, DOWNLOAD_PAUSE_S, LINK_WORKERS, MASHUP_WORKERS, MAX_STORE_GB, \
    STEMS_MODEL, STEMS_WORKERS, TRANSITIONS_DIR, TRANSITIONS_VERSION, WORKER_THREADS

LINK_CHUNK = 6  # songs per linking job, so several link workers share a big library

_lock = threading.RLock()
_pools: dict[str, ProcessPoolExecutor] = {}
_ingesting: dict[str, int] = {}  # track id -> attempts
_linking: set[tuple[str, str]] = set()  # ordered pairs being computed
_relinking = {"on": False}
on_ready: list[Callable[[str], None]] = []  # called with a track id once it is analysed
on_linked: list[Callable[[set[str]], None]] = []  # called with the songs whose pairs were added
_evict_state = {"at": 0.0, "running": False}
keep_ids: Callable[[], set[str]] = lambda: set()  # songs that eviction must not touch (set by the server)
# Songs analysed by an older version, analysed again in the background while
# they stay ready (their old analysis serves meanwhile), only when no
# listener's song is waiting, and leaving a worker free for one.
_upgrade_queue: list[str] = []
_upgrading: set[str] = set()
UPGRADE_SLOTS = max(1, ANALYSIS_WORKERS - 1)
# Mashups waiting to be made or being made, in order (render pool).
_mashups: list[str] = []
# Vocal stems being separated again (stems pool): song -> what waits for it;
# and the songs to separate again whenever the pool is idle.
_stems_busy: dict[str, list[Callable[[], None]]] = {}
_stems_queue: list[str] = []
_stems_pause = {"until": 0.0}
# Downloads: the songs waiting, in order, the one being fetched (and whether
# it was called off), and how long the last ones took (for the wait shown).
_dl_queue: list[str] = []
_dl = {"tid": None, "cancel": False}
_dl_times: list[float] = []
_dl_cv = threading.Condition(_lock)
_dl_thread: dict = {"t": None}
wanted: Callable[[str], bool] = lambda tid: True  # whether anyone still waits for a song (set by sessions)
# Told how each download ended (tid, site, "ok" | "failed" | "cancelled", error): the admin page counts them.
on_download: Callable[[str, str, str, str | None], None] = lambda tid, site, outcome, error: None
QUEUE_SHOWN = 5  # songs of the queue named to everyone (others' unnamed); one's own always


# ------------------------------------------------------------ in the children

def _init_child(uses_torch: bool) -> None:
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMBA_NUM_THREADS"):
        os.environ[var] = str(WORKER_THREADS)
    if uses_torch:
        # The GPU is shared: fewer stranded blocks in the allocator's cache.
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        import torch
        torch.set_num_threads(WORKER_THREADS)


def _free_gpu() -> None:
    """Hands the allocator's cached blocks back after a job: the GPU is shared
    with other services and the other workers (models stay resident)."""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _ingest_job(tid: str) -> str:
    from . import ingest
    try:
        return ingest.process(tid, fetch_sound=False)  # downloaded by the server's queue, never here
    finally:
        _free_gpu()


def _upgrade_job(tid: str) -> bool:
    from . import ingest
    try:
        return ingest.upgrade(tid)
    finally:
        _free_gpu()


def _link_job(tid: str, others: list[str]) -> int:
    from .analysis import transitions
    return transitions.link(tid, others)


def _relink_job() -> None:
    from .analysis import transitions
    transitions.relink_all()


def _drums_job(tid: str) -> bool:
    from .analysis import pipeline
    return pipeline.save_drums(tid)


def _render_job(mid: str) -> bool:
    from .mashup import render
    return render.run(mid)


def _stems_job(tid: str) -> bool:
    from .analysis import pipeline
    try:
        return pipeline.restem(tid)
    finally:
        _free_gpu()


# ------------------------------------------------------------- in the server

def _pool(kind: str) -> ProcessPoolExecutor:
    with _lock:
        pool = _pools.get(kind)
        if pool is None:
            n = {"ingest": ANALYSIS_WORKERS, "link": LINK_WORKERS, "mashup": MASHUP_WORKERS,
                 "stems": STEMS_WORKERS}[kind]
            # spawn, not fork: CUDA cannot be shared with a forked child.
            pool = ProcessPoolExecutor(max_workers=max(1, n), mp_context=mp.get_context("spawn"),
                                       initializer=_init_child, initargs=(kind in ("ingest", "stems"),))
            _pools[kind] = pool
        return pool


def _reset_pool(kind: str, broken: ProcessPoolExecutor) -> None:
    """A worker process died (a native crash, the OOM killer): the pool is
    unusable, so a fresh one takes its place."""
    with _lock:
        if _pools.get(kind) is broken:
            _pools.pop(kind)
            broken.shutdown(wait=False, cancel_futures=True)


def enqueue_ingest(tid: str) -> None:
    """Prepares a song: its download first when it needs one (the queue),
    then its analysis."""
    from . import ingest
    with _lock:
        if tid in _ingesting:
            return
        _ingesting[tid] = _ingesting.get(tid, 0)
        if ingest.needs_fetch(tid):
            _dl_queue.append(tid)
            if _dl_thread["t"] is None or not _dl_thread["t"].is_alive():
                _dl_thread["t"] = threading.Thread(target=_download_loop, name="mashloop-download", daemon=True)
                _dl_thread["t"].start()
            _dl_cv.notify()
            return
        _submit_ingest(tid)


def _download_loop() -> None:
    """The downloads, one after another (download.py adds the pause after
    each); a song nobody waits for any more is skipped."""
    from . import ingest
    while True:
        with _dl_cv:
            while not _dl_queue:
                _dl_cv.wait()
            tid = _dl_queue.pop(0)
            _dl.update(tid=tid, cancel=False)
        ok, t0, outcome, error = False, None, "cancelled", None
        site = (library.read_meta(tid) or {}).get("source") or "youtube"
        try:
            if not wanted(tid):
                raise ingest.Cancelled()
            library.update(tid, stage="queued", status="queued", progress=0.0)
            t0 = time.time()
            ingest.fetch(tid, cancelled=lambda: _dl["cancel"])
            ok, outcome = True, "ok"
        except ingest.Cancelled:
            pass
        except Exception as e:  # the site refused it: shown on the song
            traceback.print_exc()
            ingest.fail(tid, e)
            outcome, error = "failed", str(e)
        if t0 is not None:  # (a song skipped before its turn was never downloaded)
            try:
                on_download(tid, site, "cancelled" if _dl["cancel"] else outcome, error)
            except Exception:
                traceback.print_exc()
        with _dl_cv:
            off = _dl["cancel"] or not ok and (library.read_meta(tid) or {}).get("status") != "error"
            _dl.update(tid=None, cancel=False)
            if ok and t0:
                _dl_times[:] = (_dl_times + [time.time() - t0])[-12:]
            if ok and not off:
                library.update(tid, stage="downloaded", status="queued", progress=0.3)
                _submit_ingest(tid)
            else:
                _ingesting.pop(tid, None)
        if off:
            _forget(tid)
        _maybe_evict()


def _forget(tid: str) -> None:
    """A song whose download was called off: back to how it was before it was
    asked for (a song analysed before keeps its analysis, without sound), or
    gone from the store."""
    from . import ingest
    m = library.read_meta(tid)
    d = library.track_dir(tid)
    for f in d.glob("source.*"):
        if m and m.get("source") != "upload":
            f.unlink(missing_ok=True)
    if m is None:
        if d.exists() and not any(d.iterdir()):
            d.rmdir()
    elif m.get("analysis_version") and library.analysis_path(tid).exists():
        library.update(tid, status="ready", stage="ready", progress=1.0, error=None)
    elif ingest.source_file(tid) is None:
        library.delete(tid)


def cancel_download(tid: str) -> bool:
    """Calls off a song's download (nobody waits for it any more): out of the
    queue, or stopped where it is. True when it was waiting or downloading."""
    with _dl_cv:
        if _dl["tid"] == tid:
            _dl["cancel"] = True
            return True
        if tid not in _dl_queue:
            return False
        _dl_queue.remove(tid)
        _ingesting.pop(tid, None)
    _forget(tid)
    return True


def download_queue(mine: set[str], everyone: bool = False) -> dict:
    """The downloads as a listener sees them: how many, which are theirs
    (named, with the wait before each), the first few of the others unnamed;
    the one being fetched with its progress, or the pause before it.
    everyone: every song named (the admin page)."""
    from . import download
    with _lock:
        order = ([_dl["tid"]] if _dl["tid"] else []) + list(_dl_queue)
        times = list(_dl_times)
    if not order:
        return {"count": 0, "items": []}
    # A song's turn: the pause before it, then its download (the last ones
    # timed from the end of the one before).
    rest = sum(DOWNLOAD_PAUSE_S) / len(DOWNLOAD_PAUSE_S)
    per = statistics.median(times) if times else 20.0 + rest
    fetch_s = max(5.0, per - rest)
    items, wait = [], 0.0
    for i, tid in enumerate(order):
        own = tid in mine
        named = own or everyone
        m = (library.read_meta(tid) or {}) if named or i == 0 else {}
        if i == 0 and _dl["tid"] == tid:
            pause = download.pause_left()
            got = min(1.0, (m.get("progress") or 0) / 0.3) if m.get("stage") == "downloading" else 0.0
            state = "downloading" if m.get("stage") == "downloading" else "pause" if pause > 0 else "starting"
            left = fetch_s * (1 - got) + (pause if state != "downloading" else 0.0)
        else:
            state, got, left = "waiting", 0.0, per
        if named or i < QUEUE_SHOWN:
            it = {"pos": i + 1, "mine": own, "state": state}
            if state == "downloading":
                it["progress"] = round(got, 3)
            if state == "pause":
                it["pause_s"] = round(download.pause_left(), 1)
            if named:
                it.update(id=tid, title=m.get("title") or "", wait_s=round(wait))
            items.append(it)
        wait += left
    return {"count": len(order), "items": items, "per_s": round(per), "rest_s": list(DOWNLOAD_PAUSE_S)}


def _submit_ingest(tid: str) -> None:
    pool = _pool("ingest")
    fut = pool.submit(_ingest_job, tid)
    fut.add_done_callback(lambda f: _ingest_done(tid, pool, f))


def _ingest_done(tid: str, pool, fut) -> None:
    status = "error"
    try:
        status = fut.result()
    except BrokenProcessPool:
        _reset_pool("ingest", pool)
        with _lock:
            tries = _ingesting.get(tid, 0) + 1
            _ingesting[tid] = tries
        if tries < 2:
            with _lock:
                _submit_ingest(tid)
            return
        library.update(tid, status="error", stage="error", progress=0.0, error="máy phân tích bị lỗi với bài này")
    except Exception:
        traceback.print_exc()
    with _lock:
        _ingesting.pop(tid, None)
    if status == "ready":
        queue_restems([tid], front=True)  # its stem by the better model, next in line
        for cb in on_ready:
            try:
                cb(tid)
            except Exception:
                traceback.print_exc()
    _maybe_evict()


def enqueue_links(tid: str, others: list[str]) -> int:
    """Schedules the missing pairs between tid and others (both ways).
    Returns how many songs that covers."""
    from .analysis import transitions
    with _lock:
        need = [o for o in dict.fromkeys(others) if o != tid
                and (tid, o) not in _linking and (o, tid) not in _linking
                and not (transitions.has_pair(tid, o) and transitions.has_pair(o, tid))]
        for o in need:
            _linking.update({(tid, o), (o, tid)})
        for k in range(0, len(need), LINK_CHUNK):
            chunk = need[k:k + LINK_CHUNK]
            pool = _pool("link")
            fut = pool.submit(_link_job, tid, chunk)
            fut.add_done_callback(lambda f, c=chunk, p=pool: _link_done(tid, c, p, f))
    return len(need)


def _link_done(tid: str, chunk: list[str], pool, fut) -> None:
    try:
        fut.result()
    except BrokenProcessPool:
        _reset_pool("link", pool)
    except Exception:
        traceback.print_exc()
    with _lock:
        for o in chunk:
            _linking.discard((tid, o))
            _linking.discard((o, tid))
    for cb in on_linked:
        try:
            cb({tid, *chunk})
        except Exception:
            traceback.print_exc()


def relink_all() -> None:
    """Recomputes every pair (personal mode: the "Tính lại" button)."""
    with _lock:
        if _relinking["on"]:
            return
        _relinking["on"] = True
    fut = _pool("link").submit(_relink_job)

    def done(f):
        try:
            f.result()
        except Exception:
            traceback.print_exc()
        _relinking["on"] = False
        for cb in on_linked:
            cb(set(library.ready_ids()))

    fut.add_done_callback(done)


def enqueue_mashup(mid: str, drums_for: list[str] | None = None, stems_for: list[str] | None = None) -> None:
    """Renders a mashup in the render pool, once its songs have their vocal
    stems by the current model (stems pool, first in line) and the drum and
    bass stems it needs (an acoustic vibe, a band rebuilt without its voice)
    are separated by the analysis workers, which hold that model already.
    Both lists are read from its plan when not given."""
    from .mashup import plan as mplan, store
    with _lock:
        if mid in _mashups:
            return
        _mashups.append(mid)
    if stems_for is None or drums_for is None:
        plan = library.read_json(store.plan_path(mid)) or {}
        if stems_for is None:
            stems_for = [s["id"] for s in plan.get("sources", [])]
        if drums_for is None:
            drums_for = mplan.parts_needed(plan) if plan.get("clips") else []

    def after_drums(f, pool, left):
        try:
            f.result()
        except BrokenProcessPool:
            _reset_pool("ingest", pool)
        except Exception:
            traceback.print_exc()
        with _lock:
            left["n"] -= 1
            go = left["n"] == 0
        if go:  # without a stem that failed, the render keeps the drums in
            _submit_render(mid)

    def after_stems():
        if not drums_for:
            _submit_render(mid)
            return
        store.update(mid, stage="drums")
        left = {"n": len(drums_for)}
        for tid in drums_for:
            pool = _pool("ingest")
            pool.submit(_drums_job, tid).add_done_callback(lambda f, p=pool: after_drums(f, p, left))

    ensure_stems(stems_for, after_stems, lambda: store.update(mid, stage="stems"))


def ensure_stems(tids: list[str], then: Callable[[], None], waiting: Callable[[], None] = lambda: None) -> None:
    """Separates the songs' vocal stems again where they are not by the
    current model (ahead of the background work), then calls `then` (also
    when a separation failed: the old stem serves). `waiting` is called first
    when there is any to do."""
    if STEMS_WORKERS <= 0:
        then()
        return
    need = [t for t in dict.fromkeys(tids) if library.needs_stem(t)]
    if not need:
        then()
        return
    waiting()
    left = {"n": len(need)}

    def one() -> None:
        with _lock:
            left["n"] -= 1
            go = left["n"] == 0
        if go:
            then()

    for t in need:
        _restem(t, one)


def _restem(tid: str, cb: Callable[[], None] | None = None) -> None:
    with _lock:
        if tid in _stems_busy:
            if cb:
                _stems_busy[tid].append(cb)
            return
        _stems_busy[tid] = [cb] if cb else []
        if tid in _stems_queue:
            _stems_queue.remove(tid)
        pool = _pool("stems")
    fut = pool.submit(_stems_job, tid)
    fut.add_done_callback(lambda f: _stems_done(tid, pool, f))


def _stems_done(tid: str, pool, fut) -> None:
    failed = False
    try:
        fut.result()
    except BrokenProcessPool:
        _reset_pool("stems", pool)
        failed = True
    except Exception as e:
        # No room on the GPU (it is shared), or a song that failed: the old stem
        # serves; the background work rests a while and the song comes again later.
        if type(e).__name__ != "NoRoom":
            traceback.print_exc()
        failed = True
    with _lock:
        cbs = _stems_busy.pop(tid, [])
    if failed:
        _stems_pause["until"] = time.time() + 120
        queue_restems([tid])
    for cb in cbs:
        try:
            cb()
        except Exception:
            traceback.print_exc()


def queue_restems(ids: list[str], front: bool = False) -> None:
    """Songs to separate again when the stems pool is idle (`front`: next)."""
    if STEMS_WORKERS <= 0:
        return
    with _lock:
        for t in ids:
            if t in _stems_busy or t in _stems_queue:
                continue
            if front:
                _stems_queue.insert(0, t)
            else:
                _stems_queue.append(t)


def _stems_tick() -> None:
    """One background separation at a time, only while nothing waits for one
    (and not for a while after one found no room)."""
    with _lock:
        if _stems_busy or not _stems_queue or time.time() < _stems_pause["until"]:
            return
        tid = _stems_queue.pop(0)
    if library.needs_stem(tid):
        _restem(tid)


def stems_left() -> int:
    with _lock:
        return len(_stems_queue) + len(_stems_busy)


def _submit_render(mid: str) -> None:
    pool = _pool("mashup")

    def done(f):
        try:
            f.result()
        except BrokenProcessPool:
            _reset_pool("mashup", pool)
            from .mashup import store
            store.fail(mid, "Máy dựng mashup bị lỗi với bài này")
        except Exception:
            traceback.print_exc()
        with _lock:
            if mid in _mashups:
                _mashups.remove(mid)

    pool.submit(_render_job, mid).add_done_callback(done)


def mashup_ahead(mid: str) -> int | None:
    """How many mashups are made before this one (0: it is being made)."""
    with _lock:
        if mid not in _mashups:
            return None
        return max(0, _mashups.index(mid) - (MASHUP_WORKERS - 1))


def mashup_backlog() -> int:
    with _lock:
        return len(_mashups)


def queue_upgrades(ids: list[str]) -> None:
    with _lock:
        for t in ids:
            if t not in _upgrading and t not in _upgrade_queue:
                _upgrade_queue.append(t)


def _upgrade_tick() -> None:
    with _lock:
        if _ingesting:  # listeners' songs first
            return
        while len(_upgrading) < UPGRADE_SLOTS and _upgrade_queue:
            tid = _upgrade_queue.pop(0)
            meta = library.read_meta(tid) or {}
            if (meta.get("status") != "ready" or meta.get("analysis_version") == ANALYSIS_VERSION
                    or not library.has_audio(tid)):
                continue
            _upgrading.add(tid)
            pool = _pool("ingest")
            fut = pool.submit(_upgrade_job, tid)
            fut.add_done_callback(lambda f, t=tid, p=pool: _upgrade_done(t, p, f))


def _upgrade_done(tid: str, pool, fut) -> None:
    ok = False
    try:
        ok = bool(fut.result())
    except BrokenProcessPool:
        _reset_pool("ingest", pool)
    except Exception:
        traceback.print_exc()
    with _lock:
        _upgrading.discard(tid)
    if ok:
        # Its transitions were found with the old analysis: found again, and
        # the libraries holding it link it anew.
        library.drop_pairs(tid)
        for cb in on_ready:
            try:
                cb(tid)
            except Exception:
                traceback.print_exc()


def upgrades_left() -> int:
    with _lock:
        return len(_upgrade_queue) + len(_upgrading)


def _upgrade_loop() -> None:
    while True:
        time.sleep(5)
        try:
            _upgrade_tick()
        except Exception:
            traceback.print_exc()
        try:
            _stems_tick()
        except Exception:
            traceback.print_exc()


def _queue_old_stems() -> None:
    """Every song separated by an older model (or that lost its stem), to be
    separated again in the background: the sample libraries first, then the
    songs used most recently."""
    samples = set(library.samples()["ids"])
    ids = [m["id"] for m in library.list_tracks() if library.needs_stem(m["id"])]
    ids.sort(key=lambda t: (t not in samples, -library.last_used(t)))
    queue_restems(ids)
    if ids:
        print(f"[mashloop] {len(ids)} vocal stems to separate again with {STEMS_MODEL}")


def backlog() -> int:
    """Songs being prepared or waiting for it, all libraries together."""
    with _lock:
        return len(_ingesting)


def status(ids: list[str]) -> dict:
    """What is still on its way for a library: songs being prepared and pairs
    of its songs being linked."""
    s = set(ids)
    with _lock:
        return {
            "processing": sum(1 for t in s if t in _ingesting),
            "linking": sum(1 for a, b in _linking if a in s and b in s) // 2,
            "relink": _relinking["on"],
        }


def _maybe_evict() -> None:
    if MAX_STORE_GB <= 0:
        return
    with _lock:
        if _evict_state["running"] or time.time() - _evict_state["at"] < 60:
            return
        _evict_state["running"] = True

    def run():
        try:
            with _lock:
                busy = set(_ingesting) | set(_upgrading) | {t for pair in _linking for t in pair}
            gone = library.evict(int(MAX_STORE_GB * 1e9), keep_ids() | busy)
            if gone:
                print(f"[mashloop] store over {MAX_STORE_GB} GB: freed the {len(gone)} least used songs")
        except Exception:
            traceback.print_exc()
        finally:
            _evict_state.update(at=time.time(), running=False)

    threading.Thread(target=run, name="mashloop-evict", daemon=True).start()


def _marker_path():
    return TRANSITIONS_DIR / "_version.json"


def stale(metas: list[dict]) -> bool:
    """True when the data on disk was written by newer code than this process
    runs: the server was started before an update and must be restarted."""
    if (library.read_json(_marker_path()) or {}).get("version", 0) > TRANSITIONS_VERSION:
        return True
    return any((m.get("analysis_version") or 0) > ANALYSIS_VERSION for m in metas)


def start_retention(max_idle_s: float | None, keep: Callable[[], set[str]]) -> None:
    """Every few minutes, deletes the sound of the songs nobody has used for
    max_idle_s (library.drop_idle_audio), except those in keep() and those
    being worked on; every minute, the mashups past their time (and the songs
    made of them for the loop)."""
    def run():
        k = 0
        while True:
            time.sleep(60)
            k += 1
            try:
                from .mashup import store
                for tid in store.sweep():
                    library.delete(tid)
            except Exception:
                traceback.print_exc()
            if k % 10 or max_idle_s is None:  # personal: the library keeps its sound
                continue
            try:
                with _lock:
                    busy = set(_ingesting) | set(_upgrading) | {t for pair in _linking for t in pair}
                gone = library.drop_idle_audio(max_idle_s, keep() | busy)
                if gone:
                    print(f"[mashloop] deleted the audio of {len(gone)} songs unused for {max_idle_s / 3600:g} h")
            except Exception:
                traceback.print_exc()

    threading.Thread(target=run, name="mashloop-retention", daemon=True).start()


def start() -> None:
    """Resumes interrupted work on startup, and queues the songs analysed by an
    older version for a background upgrade (the sample libraries first); a
    song whose sound was deleted is analysed again when someone adds it back."""
    stale = []
    for m in library.list_tracks():
        if m.get("status") == "ready" and m.get("analysis_version") != ANALYSIS_VERSION:
            if library.has_audio(m["id"]):
                stale.append(m["id"])
        elif m.get("status") not in library.FINAL_STATES:
            enqueue_ingest(m["id"])
    samples = set(library.samples()["ids"])
    queue_upgrades(sorted(stale, key=lambda t: t not in samples))
    threading.Thread(target=_upgrade_loop, name="mashloop-upgrade", daemon=True).start()
    if STEMS_WORKERS > 0:
        threading.Thread(target=_queue_old_stems, name="mashloop-stems", daemon=True).start()
    # Mashups cut short by a restart are made again from the start.
    from .mashup import store
    for mid in store.unfinished():
        enqueue_mashup(mid)

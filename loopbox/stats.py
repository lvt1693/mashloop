"""Counts for the /admin page, kept without anything that tells who a
listener is.

- Visits: pages opened (each visit is a session); returning: the ones that
  put back a library saved in their browser.
- Unique visitors per day: the address hashed with a salt that lives for that
  day only (data/stats/today.json holds the salt and the hashes); the next day
  both are thrown away and only the count stays.
- By hour: visits, the most pages open at once, seconds of listening (a page
  says whether it is playing when it asks for its library).
- How long visits last: from opening to the last request, once a visit has
  been quiet for VISIT_END_S.
- Songs added, uploaded, played (its sound fetched for a library), downloads
  and how they ended (YouTube refusing the server counted apart), refusals of
  the rate limits; and when a YouTube download last went through or failed.

One file per day (data/stats/YYYY-MM-DD.json), written every minute and at
exit; the page reads the last days from them."""
import atexit
import datetime
import hashlib
import secrets
import threading
import time
from typing import Callable

from . import library
from .config import STATS_DIR

VISIT_END_S = 600   # a visit quiet this long has ended
OPEN_S = 60         # a page that asked this recently is open
PLAYING_S = 50      # ... and playing, when it said so this recently
POLL_GAP_S = 30     # the most listening one poll may add (a page that plays asks every 20 s)
BUCKETS = ((60, "dưới 1 phút"), (300, "1–5 phút"), (900, "5–15 phút"), (3600, "15–60 phút"), (None, "trên 1 giờ"))

STARTED = time.time()
_lock = threading.RLock()
_day: dict = {}
_today = {"date": None, "salt": b"", "seen": set()}
_polls: dict[str, tuple[float, bool]] = {}   # session -> (last poll, playing)
_ended: set[str] = set()                    # sessions whose length is counted
_health = library.read_json(STATS_DIR / "health.json") or {}


def _date(t: float | None = None) -> str:
    return datetime.datetime.fromtimestamp(t or time.time()).strftime("%Y-%m-%d")


def _hour() -> int:
    return datetime.datetime.now().hour


def _blank(date: str) -> dict:
    return {"date": date, "visits": 0, "uniques": 0, "returning": 0, "peak": 0, "listen_s": 0.0,
            "hours": {"visits": [0] * 24, "peak": [0] * 24, "listen_s": [0.0] * 24},
            "durations": {label: 0 for _, label in BUCKETS},
            "added": 0, "uploads": 0, "plays": {},
            "downloads": {"ok": 0, "failed": 0, "blocked": 0, "cancelled": 0}, "limited": {}}


def _roll() -> None:
    """The current day's counts in memory (a new day starts afresh). Lock held."""
    d = _date()
    if _day.get("date") == d:
        return
    if _day:
        _write()
    saved = library.read_json(STATS_DIR / f"{d}.json")
    _day.clear()
    _day.update(saved if saved and saved.get("date") == d else _blank(d))
    t = library.read_json(STATS_DIR / "today.json") or {}
    if t.get("date") == d:
        _today.update(date=d, salt=bytes.fromhex(t["salt"]), seen=set(t.get("seen") or []))
    else:  # yesterday's salt and hashes go: only their count stayed
        _today.update(date=d, salt=secrets.token_bytes(32), seen=set())


def _write() -> None:
    STATS_DIR.mkdir(parents=True, exist_ok=True)
    library.write_json(STATS_DIR / f"{_day['date']}.json", _day)
    library.write_json(STATS_DIR / "today.json", {"date": _today["date"], "salt": _today["salt"].hex(),
                                                  "seen": sorted(_today["seen"])})
    library.write_json(STATS_DIR / "health.json", _health)


# ----------------------------------------------------------------- counting

def visit(ip: str) -> None:
    with _lock:
        _roll()
        _day["visits"] += 1
        _day["hours"]["visits"][_hour()] += 1
        h = hashlib.blake2b(ip.encode(), key=_today["salt"], digest_size=8).hexdigest()
        if h not in _today["seen"]:
            _today["seen"].add(h)
            _day["uniques"] += 1


def returning() -> None:
    with _lock:
        _roll()
        _day["returning"] += 1


def poll(sid: str, playing: bool) -> None:
    """A page asked for its library; while it plays, the time since its last
    ask is listening."""
    now = time.time()
    with _lock:
        _roll()
        last, was = _polls.get(sid, (0.0, False))
        if playing and was and last:
            dt = min(POLL_GAP_S, now - last)
            _day["listen_s"] += dt
            _day["hours"]["listen_s"][_hour()] += dt
        _polls[sid] = (now, playing)


def _count(key: str, n: int = 1) -> None:
    with _lock:
        _roll()
        _day[key] += n


def added(n: int) -> None:
    if n:
        _count("added", n)


def uploaded(n: int) -> None:
    if n:
        _count("uploads", n)


def play(tid: str) -> None:
    with _lock:
        _roll()
        _day["plays"][tid] = _day["plays"].get(tid, 0) + 1


def limited(kind: str) -> None:
    with _lock:
        _roll()
        _day["limited"][kind] = _day["limited"].get(kind, 0) + 1


def download(tid: str, site: str, outcome: str, error: str | None = None) -> None:
    """A download ended: "ok", "cancelled" or "failed" ("blocked" when YouTube
    took the server for a bot)."""
    if outcome == "failed" and error and ("chặn" in error or "not a bot" in error):
        outcome = "blocked"
    with _lock:
        _roll()
        _day["downloads"][outcome] = _day["downloads"].get(outcome, 0) + 1
        if site == "youtube" and outcome == "ok":
            _health["youtube_ok_at"] = time.time()
        elif site == "youtube" and outcome in ("failed", "blocked"):
            _health.update(youtube_fail_at=time.time(), youtube_fail=(error or "")[:300], youtube_fail_tid=tid)


# ------------------------------------------------------------------ reading

def live(views: list) -> dict:
    """Pages open now, playing now, and the visits the server still holds."""
    now = time.time()
    with _lock:
        playing = {sid for sid, (t, p) in _polls.items() if p and now - t < PLAYING_S}
    seen = [(v.id, getattr(v, "seen", now)) for v in views if hasattr(v, "ids")]
    return {"open": sum(1 for _, s in seen if now - s < OPEN_S),
            "playing": sum(1 for sid, s in seen if sid in playing and now - s < OPEN_S),
            "visits": len(seen)}


def is_playing(sid: str) -> bool:
    with _lock:
        t, p = _polls.get(sid, (0.0, False))
    return p and time.time() - t < PLAYING_S


def history(days: int) -> list[dict]:
    """The counts of the last days, oldest first (today as it stands)."""
    with _lock:
        _roll()
        today = {**_day, "plays": dict(_day["plays"])}
    out = []
    for k in range(days - 1, 0, -1):
        d = _date(time.time() - k * 86400)
        out.append(library.read_json(STATS_DIR / f"{d}.json") or _blank(d))
    out.append(today)
    return out


def health() -> dict:
    with _lock:
        return dict(_health)


# ----------------------------------------------------------------- the clock

def start(views: Callable[[], list]) -> None:
    """Every 30 s: the most pages open at once this hour, and the visits that
    have ended (their length); every minute, the day on disk."""
    def run():
        k = 0
        while True:
            time.sleep(30)
            k += 1
            try:
                now = time.time()
                vs = [v for v in views() if hasattr(v, "ids")]
                n = live(vs)["open"]
                with _lock:
                    _roll()
                    h = _hour()
                    _day["hours"]["peak"][h] = max(_day["hours"]["peak"][h], n)
                    _day["peak"] = max(_day["peak"], n)
                    for v in vs:
                        if v.id not in _ended and now - v.seen > VISIT_END_S:
                            _ended.add(v.id)
                            length = v.seen - getattr(v, "created", v.seen)
                            label = next(lab for lim, lab in BUCKETS if lim is None or length < lim)
                            _day["durations"][label] += 1
                    alive = {v.id for v in vs}
                    for sid in [s for s in _polls if s not in alive]:
                        _polls.pop(sid, None)
                    _ended.intersection_update(alive)
                    if k % 2 == 0:
                        _write()
            except Exception:
                import traceback
                traceback.print_exc()

    threading.Thread(target=run, name="mashloop-stats", daemon=True).start()
    atexit.register(_flush)


def _flush() -> None:
    """At exit (a stop by SIGKILL skips it: at most a minute is lost)."""
    if _lock.acquire(timeout=2):
        try:
            if _day:
                _write()
        finally:
            _lock.release()

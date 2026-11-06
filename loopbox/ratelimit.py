"""Per-client limits for the hosted app, so it cannot be used as a free
download service or have its YouTube access burnt: how many visits, searches,
new songs (the ones the server must fetch and analyse), uploads and audio
files one address may ask for in a window.

No address is kept: requests are counted under a keyed hash of it (the key is
random per process, so a count cannot be tied back to an address, nor survives
a restart), in memory only, and a count is forgotten once its window has passed."""
import hashlib
import secrets
import threading
import time
from collections import deque

from fastapi import HTTPException

from .config import MULTIUSER, NEW_TRACKS_DAY, VISITS_HOUR

# kind -> (requests allowed, per seconds, message)
LIMITS = {
    "session": (VISITS_HOUR, 3600, "mở trang quá nhiều lần"),
    "search": (60, 600, "tìm quá nhiều lần"),
    "new_track": (20, 3600, "thêm quá nhiều bài mới"),
    # A day's worth, so nobody turns the server into their YouTube downloader
    # (every new song is fetched with the server's YouTube cookies).
    "new_track_day": (NEW_TRACKS_DAY, 86400, "thêm quá nhiều bài mới hôm nay"),
    "upload": (30, 3600, "tải lên quá nhiều file"),
    "audio": (200, 3600, "tải nhạc quá nhiều lần"),
    "mashup": (6, 3600, "tạo quá nhiều bài mashup"),
    "mashup_preview": (600, 3600, "xem trước mashup quá nhiều lần"),
}
PURGE_EVERY_S = 300
# Tools run on the box itself (deploy/seed_*.py) reach the app on loopback;
# every visitor arrives through HAProxy, which forwards their own address.
LOCAL = {"127.0.0.1", "::1"}

_lock = threading.Lock()
_hits: dict[tuple[str, str], deque] = {}
_salt = secrets.token_bytes(32)
_purged = {"at": 0.0}
on_refused = lambda kind: None  # noqa: E731  (told of every refusal: the admin page counts them)


def _who(ip: str) -> str:
    return hashlib.blake2b(ip.encode(), key=_salt, digest_size=12).hexdigest()


def _purge(now: float) -> None:
    """Drops the counts whose window has passed (called with the lock held)."""
    if now - _purged["at"] < PURGE_EVERY_S:
        return
    _purged["at"] = now
    for key in [k for k, q in _hits.items() if not q or now - q[-1] > LIMITS[k[1]][1]]:
        _hits.pop(key, None)


def check(ip: str, kind: str, n: int = 1) -> None:
    """Counts n requests of a kind from ip, or refuses them (HTTP 429)."""
    if not MULTIUSER or ip in LOCAL:
        return
    allowed, window, what = LIMITS[kind]
    now = time.time()
    with _lock:
        _purge(now)
        q = _hits.setdefault((_who(ip), kind), deque())
        while q and now - q[0] > window:
            q.popleft()
        refused = len(q) + n > allowed
        if refused:
            wait = int(window - (now - q[0])) + 1 if q else window
        else:
            q.extend([now] * n)
    if refused:
        on_refused(kind)
        later = f"{round(wait / 3600)} giờ" if wait > 5400 else f"{max(1, wait // 60)} phút"
        raise HTTPException(429, f"Bạn {what}, thử lại sau {later}")


def room(ip: str, kind: str) -> int:
    """How many more requests of a kind ip may make right now."""
    if not MULTIUSER or ip in LOCAL:
        return 1 << 30
    allowed, window, _ = LIMITS[kind]
    now = time.time()
    with _lock:
        _purge(now)
        q = _hits.get((_who(ip), kind)) or deque()
        return max(0, allowed - sum(1 for t in q if now - t <= window))

"""Where mashups live: data/mashups/<id>/ with meta.json (status, progress,
options, times), plan.json (what plays when) and mix.mp3.

Nobody has an account: whoever creates a mashup gets a random token, kept in
their browser; only its hash is stored here, and every read needs the token.
A finished mashup is kept MASHUP_TTL_S (48 h) from when it was done, then
deleted with everything it made (the song made of it for playing in the
loop included); one that failed, or never finished (a crash), goes sooner."""
import hashlib
import hmac
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from .. import library
from ..config import DATA_DIR, MASHUP_TTL_S

MASHUPS_DIR = DATA_DIR / "mashups"
MASHUPS_DIR.mkdir(parents=True, exist_ok=True)
FAILED_TTL_S = 3600
STUCK_S = 3 * 3600
_ID = re.compile(r"^[0-9a-f]{16}$")
_lock = threading.Lock()


def valid_id(mid: str) -> bool:
    return bool(mid) and bool(_ID.match(mid))


def dir_of(mid: str) -> Path:
    if not valid_id(mid):
        raise ValueError("bad mashup id")
    return MASHUPS_DIR / mid


def audio_path(mid: str) -> Path:
    return dir_of(mid) / "mix.mp3"


def plan_path(mid: str) -> Path:
    return dir_of(mid) / "plan.json"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create(options: dict, plan: dict) -> tuple[str, str]:
    mid = secrets.token_hex(8)
    token = secrets.token_urlsafe(24)
    dir_of(mid).mkdir(parents=True)
    titles = [s["title"] for s in plan["sources"]]
    library.write_json(plan_path(mid), plan)
    library.write_json(dir_of(mid) / "meta.json", {
        "id": mid, "token": _hash(token), "status": "queued", "stage": "queued", "progress": 0.0, "error": None,
        "created_at": time.time(), "done_at": None, "expires_at": None, "seconds": plan["seconds"],
        "title": " × ".join(titles[:3]) + (" …" if len(titles) > 3 else ""), "options": options, "loop_tid": None,
    })
    return mid, token


def read(mid: str) -> dict | None:
    if not valid_id(mid):
        return None
    return library.read_json(dir_of(mid) / "meta.json")


def update(mid: str, **fields) -> dict | None:
    with _lock:
        meta = read(mid)
        if meta is None:
            return None
        meta.update(fields)
        library.write_json(dir_of(mid) / "meta.json", meta)
        return meta


def authorize(mid: str, token: str | None) -> dict | None:
    """The mashup, if the token is its own and it has not expired."""
    meta = read(mid)
    if not meta or not token or not hmac.compare_digest(meta["token"], _hash(token)):
        return None
    if _expired(meta, time.time()):
        return None
    return meta


def done(mid: str, seconds: float) -> None:
    now = time.time()
    update(mid, status="done", stage="done", progress=1.0, done_at=now, expires_at=now + MASHUP_TTL_S,
           seconds=round(seconds, 2))


def fail(mid: str, message: str) -> None:
    update(mid, status="error", stage="error", error=message, expires_at=time.time() + FAILED_TTL_S)


def delete(mid: str) -> str | None:
    """Removes a mashup; returns the song made of it for the loop, if any."""
    meta = read(mid) or {}
    shutil.rmtree(dir_of(mid), ignore_errors=True)
    return meta.get("loop_tid")


def _expired(meta: dict, now: float) -> bool:
    if meta.get("expires_at"):
        return now > meta["expires_at"]
    return now - meta.get("created_at", 0) > STUCK_S


def sweep() -> list[str]:
    """Deletes the expired mashups; returns the loop songs they had made."""
    now = time.time()
    gone = []
    for d in MASHUPS_DIR.iterdir():
        if not valid_id(d.name):
            continue
        meta = library.read_json(d / "meta.json")
        if meta is None or _expired(meta, now):
            loop = delete(d.name)
            if loop:
                gone.append(loop)
    return gone


def unfinished() -> list[str]:
    """Mashups queued or being made, oldest first (a restart cut them short)."""
    found = []
    for d in MASHUPS_DIR.iterdir():
        meta = library.read_json(d / "meta.json") if valid_id(d.name) else None
        if meta and meta.get("status") in ("queued", "rendering") and not _expired(meta, time.time()):
            found.append((meta.get("created_at", 0), d.name))
    return [mid for _, mid in sorted(found)]


def active_sources() -> set[str]:
    """The songs of the mashups waiting to be made or being made: their sound
    must stay until the render has read it."""
    out = set()
    for d in MASHUPS_DIR.iterdir():
        meta = library.read_json(d / "meta.json") if valid_id(d.name) else None
        if meta and meta.get("status") in ("queued", "rendering"):
            plan = library.read_json(d / "plan.json") or {}
            out.update(s["id"] for s in plan.get("sources", []))
    return out


def loop_ids() -> set[str]:
    """The loop songs of the live mashups (kept, sound and all, while they live)."""
    out = set()
    for d in MASHUPS_DIR.iterdir():
        meta = library.read_json(d / "meta.json") if valid_id(d.name) else None
        if meta and meta.get("loop_tid"):
            out.add(meta["loop_tid"])
    return out


def public(meta: dict) -> dict:
    keys = ("id", "status", "stage", "progress", "error", "title", "created_at", "done_at", "expires_at", "seconds",
            "loop_tid")
    out = {k: meta.get(k) for k in keys}
    out["options"] = {k: meta["options"].get(k) for k in ("style", "vibe", "length")}
    return out

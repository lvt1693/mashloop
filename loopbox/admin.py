"""The /admin page (linked from nowhere): who is here now, visits and
listening by day and by hour, how long visits last, every song in the store
and every open library, the downloads and YouTube's health (with a box for new
cookies), the banners under the deck (ads.py), the machine. Signed in with the one account (adminauth.py); without
that account /admin is a 404 like any unknown page.

The page and its API are never cached or indexed and cannot be framed; every
change is a JSON request carrying X-Admin: 1 (a header no form on another site
can send) on top of the SameSite=Strict cookie."""
import math
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import adminauth, ads, download, guard, library, sessions, stats, worker
from .config import ADMIN_WEB_DIR, AUDIO_TTL_S, COOKIES, DATA_DIR, MAX_STORE_GB, MULTIUSER

router = APIRouter()
COOKIE = "mlx_admin"
HEADERS = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; "
                               "font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; "
                               "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}
FILES = {"": ("index.html", "text/html"), "admin.js": ("admin.js", "text/javascript"),
         "admin.css": ("admin.css", "text/css")}


class Login(BaseModel):
    user: str
    password: str


class Cookies(BaseModel):
    text: str


class Block(BaseModel):
    kind: str            # "clients" | "agents" | "ips" | "trusted"
    value: str
    note: str = ""


class AdNew(BaseModel):
    title: str
    link: str
    alt: str = ""
    weight: int = 1
    image: str           # base64 (or a data: URL): the WebP the page made of the file


class AdEdit(BaseModel):
    title: str | None = None
    link: str | None = None
    alt: str | None = None
    weight: int | None = None
    active: bool | None = None


def _ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _here() -> None:
    if not adminauth.enabled():
        raise HTTPException(404, "Not Found")


def signed_in(request: Request) -> None:
    _here()
    if not adminauth.valid(request.cookies.get(COOKIE)):
        raise HTTPException(401, "Chưa đăng nhập")
    if request.method != "GET" and request.headers.get("x-admin") != "1":
        raise HTTPException(403, "Forbidden")
    guard.admin_seen(_ip(request))  # the admin's own address: trusted


# ------------------------------------------------------------------- pages

@router.get("/admin", include_in_schema=False)
@router.get("/admin/", include_in_schema=False)
def page():
    return _file("")


@router.get("/admin/{name}", include_in_schema=False)
def asset(name: str):
    return _file(name)


def _file(name: str):
    _here()
    if name not in FILES:
        raise HTTPException(404, "Not Found")
    fname, media = FILES[name]
    return FileResponse(ADMIN_WEB_DIR / fname, media_type=media, headers=HEADERS)


# ----------------------------------------------------------------- sign-in

@router.post("/api/admin/login")
def login(req: Login, request: Request, response: Response):
    _here()
    if request.headers.get("x-admin") != "1":
        raise HTTPException(403, "Forbidden")
    ip = _ip(request)
    wait = adminauth.wait_s(ip)
    if wait:
        raise HTTPException(429, f"Sai nhiều lần quá, thử lại sau {math.ceil(wait / 60)} phút")
    if not adminauth.check(ip, req.user[:100], req.password[:200]):
        raise HTTPException(401, "Sai tên đăng nhập hoặc mật khẩu")
    guard.admin_seen(ip)
    response.set_cookie(COOKIE, adminauth.new_token(), max_age=adminauth.SESSION_S, httponly=True, secure=True,
                        samesite="strict", path="/api/admin")
    response.headers.update(HEADERS)
    return {"ok": True}


@router.post("/api/admin/logout")
def logout(request: Request, response: Response):
    adminauth.drop(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/api/admin", secure=True, httponly=True, samesite="strict")
    return {"ok": True}


# -------------------------------------------------------------- the readings

_cache: dict = {}


def _cached(key: str, ttl: float, make):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = make()
    _cache[key] = (time.time(), value)
    return value


def _gpu() -> list[dict]:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3)
        out = []
        for line in r.stdout.strip().splitlines():
            name, used, total, util = [x.strip() for x in line.split(",")]
            out.append({"name": name, "used_mb": int(used), "total_mb": int(total), "util": int(util)})
        return out
    except Exception:
        return []


def _size(d: Path) -> int:
    n = 0
    try:
        for e in os.scandir(d):
            if e.is_file(follow_symlinks=False):
                n += e.stat().st_size
    except OSError:
        pass
    return n


def _cookie_state() -> dict:
    """The cookie file as names and dates only (never a value)."""
    if not COOKIES.is_file():
        return {"present": False}
    names, soonest = set(), None
    for line in COOKIES.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#") or not line.strip():
            continue
        f = line.split("\t")
        if len(f) != 7:
            continue
        names.add(f[5])
        if f[5] in download.SIGN_IN and f[4].isdigit() and int(f[4]):
            soonest = min(soonest or int(f[4]), int(f[4]))
    return {"present": True, "count": len(names), "updated_at": COOKIES.stat().st_mtime,
            "sign_in_missing": sorted(download.SIGN_IN - names), "expires_at": soonest}


def _holders() -> dict[str, int]:
    held: dict[str, int] = {}
    for v in sessions.views():
        for tid in v.track_ids():
            held[tid] = held.get(tid, 0) + 1
    return held


def _store() -> dict:
    samples = set(library.samples()["ids"])
    held = _holders()
    rows, total = [], 0
    for m in library.list_tracks():
        tid = m["id"]
        size = _size(library.track_dir(tid))
        total += size
        audio = library.has_audio(tid)
        used = library.last_used(tid)
        rows.append({"id": tid, "title": m.get("title") or "", "channel": m.get("channel") or "",
                     "source": m.get("source") or "", "url": m.get("url"), "status": m.get("status"),
                     "stage": m.get("stage"), "error": m.get("error"), "duration": m.get("duration"),
                     "added_at": m.get("added_at"), "used_at": used, "audio": audio, "sample": tid in samples,
                     "audio_until": used + AUDIO_TTL_S if audio and MULTIUSER and tid not in samples else None,
                     "size": size, "held": held.get(tid, 0), "bpm": m.get("bpm")})
    return {"rows": rows, "bytes": total}


@router.get("/api/admin/overview", dependencies=[Depends(signed_in)])
def overview():
    today = stats.history(1)[-1]
    store = _cached("store", 30, _store)
    disk = shutil.disk_usage(DATA_DIR)
    rows = store["rows"]
    return {
        "now": time.time(),
        "uptime_s": time.time() - stats.STARTED,
        "live": stats.live(sessions.views()),
        "today": {k: today[k] for k in ("visits", "uniques", "returning", "peak", "listen_s", "added", "uploads",
                                        "downloads", "limited")},
        "queue": worker.download_queue(set(), everyone=True),
        "work": {"preparing": worker.backlog(), "stems": len(worker._stems_queue),
                 "upgrades": len(worker._upgrade_queue), "linking": len(worker._linking) // 2},
        "youtube": {**stats.health(), "cookies": _cookie_state()},
        "store": {"songs": len(rows), "with_audio": sum(1 for r in rows if r["audio"]),
                  "errors": sum(1 for r in rows if r["status"] == "error"), "bytes": store["bytes"],
                  "limit_bytes": MAX_STORE_GB * 1e9 or None},
        "machine": {"gpu": _cached("gpu", 10, _gpu),
                    "disk": {"used": disk.used, "total": disk.total, "free": disk.free}},
    }


@router.get("/api/admin/history", dependencies=[Depends(signed_in)])
def history(days: int = 30):
    days = max(1, min(90, days))
    out = stats.history(days)
    plays: dict[str, int] = {}
    for d in out:
        for tid, n in (d.get("plays") or {}).items():
            plays[tid] = plays.get(tid, 0) + n
    top = []
    for tid, n in sorted(plays.items(), key=lambda kv: -kv[1])[:20]:
        m = library.read_meta(tid) if library.valid_id(tid) else None
        top.append({"id": tid, "plays": n, "title": (m or {}).get("title") or tid, "channel": (m or {}).get("channel")})
    return {"days": [{k: v for k, v in d.items() if k != "plays"} | {"plays": sum((d.get("plays") or {}).values())}
                     for d in out], "top": top}


@router.get("/api/admin/store", dependencies=[Depends(signed_in)])
def store():
    return _cached("store", 15, _store)


@router.get("/api/admin/libraries", dependencies=[Depends(signed_in)])
def libraries():
    """The libraries open now (a visit's id never shown: a short hash of it)."""
    import hashlib
    samples = {tid: lib["name"] for lib in library.samples()["libraries"] for tid in lib["ids"]}
    out, now = [], time.time()
    for v in sessions.views():
        if not hasattr(v, "ids"):
            continue
        own, kho = [], {}
        for tid in v.track_ids():
            if tid in samples:
                kho[samples[tid]] = kho.get(samples[tid], 0) + 1
                continue
            m = library.read_meta(tid) or {}
            own.append({"id": tid, "title": m.get("title") or tid, "status": m.get("status"),
                        "off": tid in v.off})
        out.append({"id": hashlib.sha256(v.id.encode()).hexdigest()[:8], "created": v.created, "seen": v.seen,
                    "open": now - v.seen < stats.OPEN_S, "playing": stats.is_playing(v.id),
                    "songs": own, "samples": kho})
    out.sort(key=lambda x: -x["seen"])
    return {"libraries": out}


# ------------------------------------------------------------------ actions

@router.post("/api/admin/cookies", dependencies=[Depends(signed_in)])
def put_cookies(req: Cookies):
    """New YouTube cookies (a Netscape cookie file's text): taken when it
    signs in; the file it replaces is kept beside it (.prev)."""
    text = req.text.replace("\r\n", "\n").strip() + "\n"
    if len(text) > 200_000:
        raise HTTPException(413, "File cookies quá lớn")
    COOKIES.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".cookies-", suffix=".txt", dir=COOKIES.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o600)
        names = download._cookie_names(tmp)
        missing = sorted(download.SIGN_IN - names)
        if not names:
            raise HTTPException(400, "Không đọc được cookies nào: cần file định dạng Netscape (cookies.txt)")
        if missing:
            raise HTTPException(400, f"Thiếu cookies đăng nhập YouTube: {', '.join(missing)}")
        if COOKIES.exists():
            shutil.copyfile(COOKIES, COOKIES.with_name(COOKIES.name + ".prev"))
            os.chmod(COOKIES.with_name(COOKIES.name + ".prev"), 0o600)
        os.replace(tmp, COOKIES)
    finally:
        tmp.unlink(missing_ok=True)
    return {"ok": True, "cookies": _cookie_state()}


@router.post("/api/admin/tracks/{tid}/retry", dependencies=[Depends(signed_in)])
def retry(tid: str):
    m = library.read_meta(tid) if library.valid_id(tid) else None
    if not m:
        raise HTTPException(404, "Không có bài này")
    if m.get("status") != "error":
        raise HTTPException(409, "Chỉ thử lại được bài đang lỗi")
    library.update(tid, status="queued", stage="queued", progress=0.0, error=None)
    worker.enqueue_ingest(tid)
    _cache.pop("store", None)
    return {"ok": True}


@router.delete("/api/admin/tracks/{tid}", dependencies=[Depends(signed_in)])
def remove(tid: str):
    """A song out of the store, unless a library holds it or it is a sample."""
    if not library.valid_id(tid) or not library.read_meta(tid):
        raise HTTPException(404, "Không có bài này")
    if tid in set(library.samples()["ids"]):
        raise HTTPException(409, "Bài của kho có sẵn, không xoá ở đây")
    if _holders().get(tid):
        raise HTTPException(409, "Đang có thư viện giữ bài này")
    worker.cancel_download(tid)
    library.delete(tid)
    _cache.pop("store", None)
    return {"ok": True}


# ---------------------------------------------------------------- suspects

@router.get("/api/admin/suspects", dependencies=[Depends(signed_in)])
def suspects():
    """Clients that behave like programs (their address only for them), the
    user agents by what they do, and what is blocked with its hits."""
    return {"clients": guard.suspects(), "agents": guard.agents(), "rules": guard.rules()}


@router.get("/api/admin/clients", dependencies=[Depends(signed_in)])
def clients():
    """Every client of the last day and what it did (the address only for suspects)."""
    return {"clients": guard.everyone()}


@router.post("/api/admin/block", dependencies=[Depends(signed_in)])
def block(req: Block):
    try:
        guard.block(req.kind, req.value, req.note)
    except ValueError as e:
        raise HTTPException(400, f"Không chặn được: {e}")
    return {"rules": guard.rules()}


@router.post("/api/admin/unblock", dependencies=[Depends(signed_in)])
def unblock(req: Block):
    guard.unblock(req.kind, req.value)
    return {"rules": guard.rules()}


# --------------------------------------------------------------------- ads

@router.get("/api/admin/ads", dependencies=[Depends(signed_in)])
def ads_list():
    return ads.everything()


@router.post("/api/admin/ads", dependencies=[Depends(signed_in)])
def ads_add(req: AdNew):
    try:
        ads.add(req.title, req.link, req.alt, req.weight, ads.image_bytes(req.image))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return ads.everything()


@router.patch("/api/admin/ads/{ad_id}", dependencies=[Depends(signed_in)])
def ads_edit(ad_id: int, req: AdEdit):
    try:
        ads.edit(ad_id, **req.model_dump())
    except KeyError:
        raise HTTPException(404, "Không có quảng cáo này")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return ads.everything()


@router.delete("/api/admin/ads/{ad_id}", dependencies=[Depends(signed_in)])
def ads_remove(ad_id: int):
    try:
        ads.remove(ad_id)
    except KeyError:
        raise HTTPException(404, "Không có quảng cáo này")
    return ads.everything()

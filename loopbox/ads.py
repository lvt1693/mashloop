"""The banners under the deck (hosted only), which pay for the server beside
the coffee QR. The admin adds them on /admin: an image about 6:1, a link, a
weight; several take turns, eight seconds each, the heavier ones more often.
Kept in data/ads/ (ads.json and one image per banner). An image never changes
once added (a new image is a new banner), so it is served to be kept for good.

Counted, and nothing else about the visitor: a banner seen (half of it on
screen for a second, once an hour per client) and a click (/go/<id>, once in
ten minutes per client), both only when the site's own page asks and not for
a search engine. By day for the last 60 days, and in total.

The admin's browser shrinks the image and makes it WebP before sending it (the
server has no imaging library); here its kind and size are read from its first
bytes, and anything that is not a whole PNG, JPEG or WebP is refused.
  python -m loopbox.ads seed <folder>   (the banners of <folder>/ads.json, each once)"""
import base64
import json
import os
import re
import secrets
import struct
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from . import guard
from .config import DATA_DIR, MULTIUSER

DIR = DATA_DIR / "ads"
FILE = DIR / "ads.json"
MAX_BYTES = 2_000_000
ROTATE_S = 8
SEEN_EVERY_S = 3600
CLICK_EVERY_S = 600
KEEP_DAYS = 60
RATIO = (4.5, 8.0)       # width over height; the slot is 6:1 and crops the rest
MEDIA = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}
NAME = re.compile(r"^\d{1,6}-[0-9a-f]{8}\.(png|jpeg|webp)$")

router = APIRouter()
_lock = threading.Lock()
_db: dict | None = None
_mtime = 0.0
_last: dict[tuple, float] = {}   # (client, ad, kind) -> when it was last counted


# ------------------------------------------------------------------ images

def sniff(data: bytes) -> tuple[str, int, int] | None:
    """(kind, width, height) of a whole PNG, JPEG or WebP, else None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        if b"IEND" not in data[-16:]:
            return None
        w, h = struct.unpack(">II", data[16:24])
        return "png", w, h
    if data[:3] == b"\xff\xd8\xff":
        if b"\xff\xd9" not in data[-64:]:
            return None
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                return None
            marker = data[i + 1]
            if marker == 0xFF:                      # fill byte
                i += 1
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD8:
                i += 2
                continue
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return "jpeg", w, h
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
        return None
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        if int.from_bytes(data[4:8], "little") + 8 > len(data):
            return None
        chunk = data[12:16]
        if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            w, h = struct.unpack("<HH", data[26:30])
            return "webp", w & 0x3FFF, h & 0x3FFF
        if chunk == b"VP8L" and data[20] == 0x2F:
            b = int.from_bytes(data[21:25], "little")
            return "webp", (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
        if chunk == b"VP8X":
            return "webp", int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    return None


def _text(s: str, n: int) -> str:
    return " ".join("".join(c for c in str(s or "") if c.isprintable()).split())[:n]


def _link(s: str) -> str:
    s = str(s or "").strip()
    u = urlparse(s)
    if u.scheme != "https" or not u.hostname or len(s) > 600 or any(c.isspace() or not c.isprintable() for c in s):
        raise ValueError("Link phải là https://, không có khoảng trắng, tối đa 600 ký tự")
    return s


# ------------------------------------------------------------------- store

def _load() -> dict:
    """The banners, read again when another process (the seed) changed the file."""
    global _db, _mtime
    try:
        m = FILE.stat().st_mtime
    except FileNotFoundError:
        m = 0.0
    if _db is None or m != _mtime:
        try:
            _db = json.loads(FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _db = {}
        _db.setdefault("next", 1)
        _db.setdefault("seeded", [])
        _db.setdefault("ads", [])
        _mtime = m
    return _db


def _save() -> None:
    global _mtime
    DIR.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".ads-", suffix=".json", dir=DIR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(_db, f, ensure_ascii=False, indent=1)
    os.replace(name, FILE)
    _mtime = FILE.stat().st_mtime


def _find(ad_id: int) -> dict | None:
    return next((a for a in _load()["ads"] if a["id"] == ad_id), None)


def add(title: str, link: str, alt: str, weight: int, data: bytes) -> dict:
    if len(data) > MAX_BYTES:
        raise ValueError(f"Ảnh quá lớn: tối đa {MAX_BYTES // 1_000_000} MB")
    info = sniff(data)
    if info is None:
        raise ValueError("Chỉ nhận ảnh PNG, JPEG hoặc WebP nguyên vẹn")
    kind, w, h = info
    if w < 600 or h < 60:
        raise ValueError(f"Ảnh nhỏ quá ({w}×{h}): cần rộng ít nhất 600 px")
    if not RATIO[0] <= w / h <= RATIO[1]:
        raise ValueError(f"Banner cần tỉ lệ khoảng 6:1, ví dụ 2400×400 (ảnh này {w}×{h})")
    link = _link(link)
    with _lock:
        db = _load()
        ad_id = db["next"]
        image = f"{ad_id}-{secrets.token_hex(4)}.{kind}"
        DIR.mkdir(parents=True, exist_ok=True)
        (DIR / image).write_bytes(data)
        ad = {"id": ad_id, "title": _text(title, 80) or urlparse(link).hostname, "link": link,
              "alt": _text(alt, 160), "weight": max(1, min(int(weight or 1), 10)), "active": True,
              "image": image, "width": w, "height": h, "created_at": time.time(),
              "seen": 0, "clicks": 0, "days": {}}
        db["next"] = ad_id + 1
        db["ads"].append(ad)
        _save()
    return ad


def edit(ad_id: int, **fields) -> dict:
    with _lock:
        ad = _find(ad_id)
        if ad is None:
            raise KeyError(ad_id)
        if fields.get("title") is not None:
            ad["title"] = _text(fields["title"], 80) or ad["title"]
        if fields.get("link") is not None:
            ad["link"] = _link(fields["link"])
        if fields.get("alt") is not None:
            ad["alt"] = _text(fields["alt"], 160)
        if fields.get("weight") is not None:
            ad["weight"] = max(1, min(int(fields["weight"]), 10))
        if fields.get("active") is not None:
            ad["active"] = bool(fields["active"])
        _save()
        return ad


def remove(ad_id: int) -> None:
    with _lock:
        db = _load()
        ad = _find(ad_id)
        if ad is None:
            raise KeyError(ad_id)
        db["ads"].remove(ad)
        _save()
        (DIR / ad["image"]).unlink(missing_ok=True)


def count(ad_id: int, kind: str, who: str) -> bool:
    """One more "seen" or "click" for a banner, unless this client was counted
    for it within the hour (seen) or ten minutes (click)."""
    every = SEEN_EVERY_S if kind == "seen" else CLICK_EVERY_S
    now = time.time()
    key = (who, ad_id, kind)
    with _lock:
        if now - _last.get(key, 0) < every:
            return False
        ad = _find(ad_id)
        if ad is None or not ad["active"]:
            return False
        _last[key] = now
        if len(_last) > 50_000:
            for k in [k for k, t in _last.items() if now - t > SEEN_EVERY_S]:
                del _last[k]
        ad[kind] += 1
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        ad["days"].setdefault(day, [0, 0])[0 if kind == "seen" else 1] += 1
        for old in sorted(ad["days"])[:-KEEP_DAYS]:
            del ad["days"][old]
        _save()
    return True


def _public(a: dict) -> dict:
    return {"id": a["id"], "title": a["title"], "alt": a["alt"], "weight": a["weight"],
            "width": a["width"], "height": a["height"], "image": f"/ads/{a['image']}", "go": f"/go/{a['id']}"}


def showing() -> dict:
    with _lock:
        ads = [_public(a) for a in _load()["ads"] if a["active"]] if MULTIUSER else []
    return {"rotate_s": ROTATE_S, "ads": ads}


def everything() -> dict:
    """For the admin: every banner, its link and its counts (today and the last 7 days too)."""
    today = time.strftime("%Y-%m-%d")
    week = {time.strftime("%Y-%m-%d", time.localtime(time.time() - d * 86400)) for d in range(7)}
    with _lock:
        out = []
        for a in sorted(_load()["ads"], key=lambda a: (not a["active"], -a["id"])):
            days = a.get("days", {})
            out.append(_public(a) | {"link": a["link"], "active": a["active"], "created_at": a["created_at"],
                                     "seen": a["seen"], "clicks": a["clicks"],
                                     "today": days.get(today, [0, 0]),
                                     "week": [sum(days[d][i] for d in days if d in week) for i in (0, 1)]})
    return {"rotate_s": ROTATE_S, "ads": out}


def seed(folder: Path) -> int:
    """The banners of <folder>/ads.json added once each (by title): one the
    admin deleted later is not brought back."""
    n = 0
    for item in json.loads((folder / "ads.json").read_text(encoding="utf-8")):
        with _lock:
            done = item["title"] in _load()["seeded"]
        if done:
            continue
        add(item["title"], item["link"], item.get("alt", ""), item.get("weight", 1),
            (folder / item["image"]).read_bytes())
        with _lock:
            _load()["seeded"].append(item["title"])
            _save()
        n += 1
    return n


# ------------------------------------------------------------------ routes

def _counts(request: Request) -> bool:
    """Only what the site's own page did in a browser counts (not a search
    engine, not a link opened from somewhere else). A browser without Fetch
    Metadata (Safari before 16.4) is believed by its Origin or Referer."""
    if guard.CRAWLER_UA.search(request.headers.get("user-agent", "")):
        return False
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        return site == "same-origin"
    came = request.headers.get("origin") or request.headers.get("referer") or ""
    return "://" in came and came.split("://", 1)[1].split("/", 1)[0] == request.headers.get("host")


def _who(request: Request) -> str:
    return guard.client(request.client.host if request.client else "?")


@router.get("/api/ads")
def api_ads():
    return showing()


@router.post("/api/ads/{ad_id}/seen")
def api_seen(ad_id: int, request: Request):
    return {"counted": _counts(request) and count(ad_id, "seen", _who(request))}


@router.get("/ads/{name}", include_in_schema=False)
def image(name: str):
    if not NAME.match(name) or not (DIR / name).is_file():
        raise HTTPException(404, "Not Found")
    return FileResponse(DIR / name, media_type=MEDIA[name.rsplit(".", 1)[1]], headers={
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    })


@router.get("/go/{ad_id}", include_in_schema=False)
def go(ad_id: int, request: Request):
    with _lock:
        ad = _find(ad_id)
        link = ad["link"] if ad else None
    if link is None:
        return RedirectResponse("/", status_code=302, headers={"X-Robots-Tag": "noindex"})
    if _counts(request):
        count(ad_id, "clicks", _who(request))
    return RedirectResponse(link, status_code=302, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})


def image_bytes(b64: str) -> bytes:
    """The image the admin's page sent (base64, or a data: URL)."""
    if "," in b64[:100]:
        b64 = b64.split(",", 1)[1]
    if len(b64) > MAX_BYTES * 4 // 3 + 8:
        raise ValueError(f"Ảnh quá lớn: tối đa {MAX_BYTES // 1_000_000} MB")
    try:
        return base64.b64decode(b64, validate=True)
    except ValueError:
        raise ValueError("Ảnh gửi lên không đọc được") from None


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "seed":
        print(f"{seed(Path(sys.argv[2]))} banner added")
    else:
        print(__doc__.rsplit("\n", 1)[-1])

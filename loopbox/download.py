"""Music from the web through yt-dlp: YouTube (and YouTube Music), SoundCloud,
Zing MP3, Bandcamp, Mixcloud and Jamendo, single songs and playlists. A JS runtime
(node or deno, MASHLOOP_JS_RUNTIME) solves YouTube's player challenges.

Only links to these sites are accepted, and yt-dlp may only use their
extractors, so the server can never be made to fetch anything else.

Ids: a YouTube video keeps its own 11-character id; a song from any other
site is "x" and 16 hex digits of a hash of the site and its id there, so the
same song is the same track whoever adds it and however it was linked.

Downloads go one at a time for the whole process, each followed by a pause
(DOWNLOAD_PAUSE_S, at random), and take the sound alone where the site offers
it, else a video no higher than MAX_VIDEO_HEIGHT. YouTube is asked with the
cookies of a logged-in browser when they are there (COOKIES): each call works
on its own copy of the file (yt-dlp writes the cookies back when it is done),
and a finished download hands its copy back, so the cookies YouTube renews
are kept."""
import contextlib
import hashlib
import os
import random
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin, urlparse

import yt_dlp

from .config import COOKIES, DOWNLOAD_PAUSE_S, JS_RUNTIME, MAX_PLAYLIST, MAX_VIDEO_HEIGHT

# The sound alone, else the best video with its sound up to the height, else
# the smallest video with sound there is.
FORMAT = f"bestaudio/best[height<=?{MAX_VIDEO_HEIGHT}]/worst"

BASE_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "js_runtimes": {JS_RUNTIME: {}},
    "socket_timeout": 30,
}

# site -> (hosts, yt-dlp extractors allowed for it)
SOURCES = {
    "youtube": ({"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}, [r"youtube.*"]),
    "soundcloud": ({"soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"}, [r"soundcloud.*"]),
    "zingmp3": ({"zingmp3.vn", "www.zingmp3.vn", "m.zingmp3.vn", "mp3.zing.vn"}, [r"zingmp3.*"]),
    "bandcamp": ({"bandcamp.com"}, [r"Bandcamp.*"]),  # and every artist.bandcamp.com
    "mixcloud": ({"mixcloud.com", "www.mixcloud.com", "m.mixcloud.com"}, [r"mixcloud.*"]),
    # Creative Commons music: each song carries its licence, credited in the UI.
    "jamendo": ({"jamendo.com", "www.jamendo.com"}, [r"Jamendo.*"]),
}
SITE_NAMES = {"youtube": "YouTube", "soundcloud": "SoundCloud", "zingmp3": "Zing MP3", "bandcamp": "Bandcamp",
              "mixcloud": "Mixcloud", "jamendo": "Jamendo"}


def cc_name(license_url_or_code: str | None) -> str | None:
    """"http://creativecommons.org/licenses/by-nc-sa/3.0/" (or "by-nc-sa") -> "CC BY-NC-SA 3.0"."""
    s = str(license_url_or_code or "").strip()
    m = re.search(r"/licenses/([a-z-]+)(?:/(\d(?:\.\d)?))?", s, re.I) or re.fullmatch(r"([a-z-]+)()", s, re.I)
    if not m or not re.fullmatch(r"by(-(nc|sa|nd))*", m.group(1).lower()):
        return None
    return " ".join(filter(None, ["CC", m.group(1).upper(), m.group(2)]))

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def site_of(url: str) -> str | None:
    try:
        u = urlparse(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https"):
        return None
    for site, (hosts, _) in SOURCES.items():
        if host in hosts or (site == "bandcamp" and host.endswith(".bandcamp.com")):
            return site
    return None


def is_youtube(url: str) -> bool:
    return site_of(url) == "youtube"


def _opts(site: str, **extra) -> dict:
    return {**BASE_OPTS, "allowed_extractors": SOURCES[site][1], **extra}


# The cookies that keep a YouTube account signed in: a renewed copy that lost
# one of these never replaces the file.
SIGN_IN = {"SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID", "LOGIN_INFO"}


def _cookie_names(path: Path) -> set[str]:
    """The names of the cookies in a Netscape cookie file (#HttpOnly_ lines too)."""
    out = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#") or not line.strip():
            continue
        f = line.split("\t")
        if len(f) == 7:
            out.add(f[5])
    return out


@contextlib.contextmanager
def _cookies(site: str, keep: Callable[[], bool] = lambda: False):
    """yt-dlp options with a private copy of the YouTube cookies (none for
    the other sites, or without the file). When keep() says so at the end,
    the copy (as yt-dlp left it: renewed cookies) replaces the file, as long
    as it still signs in; the file as it was first is kept beside it (.orig)."""
    if site != "youtube" or not COOKIES.is_file():
        yield {}
        return
    fd, name = tempfile.mkstemp(prefix=".cookies-", suffix=".txt", dir=COOKIES.parent)
    os.close(fd)
    tmp = Path(name)
    try:
        shutil.copyfile(COOKIES, tmp)
        os.chmod(tmp, 0o600)
        yield {"cookiefile": str(tmp)}
        if keep() and (_cookie_names(COOKIES) & SIGN_IN) <= _cookie_names(tmp):
            first = COOKIES.with_name(COOKIES.name + ".orig")
            if not first.exists():
                shutil.copyfile(COOKIES, first)
                os.chmod(first, 0o600)
            os.replace(tmp, COOKIES)
    finally:
        tmp.unlink(missing_ok=True)


def _sweep_copies() -> None:
    """Copies of the cookies left by a process stopped mid-call (a restart
    kills it before it cleans up), gone after an hour."""
    try:
        for p in COOKIES.parent.glob(".cookies-*.txt"):
            if time.time() - p.stat().st_mtime > 3600:
                p.unlink(missing_ok=True)
    except OSError:
        pass


_sweep_copies()


class Cancelled(Exception):
    """The download was called off (nobody waits for the song any more)."""


# One download at a time in this process, and the time the next may start.
_gate = threading.Lock()
_next = {"at": 0.0}


def pause_left() -> float:
    """Seconds until the next download may start (the pause after the last)."""
    return max(0.0, _next["at"] - time.time())


def track_id(site: str, native_id: str) -> str:
    if site == "youtube":
        return native_id
    return "x" + hashlib.sha1(f"{site}:{native_id}".encode()).hexdigest()[:16]


def _entry(e: dict, site: str = "youtube") -> dict | None:
    native = str(e.get("id") or "")
    if not native or (site == "youtube" and not _VIDEO_ID.match(native)):
        return None
    thumbs = e.get("thumbnails") or []
    thumb = e.get("thumbnail") or (thumbs[-1]["url"] if thumbs else None)
    if site == "youtube":
        url = f"https://www.youtube.com/watch?v={native}"
        thumb = thumb or f"https://i.ytimg.com/vi/{native}/mqdefault.jpg"
    else:
        url = e.get("webpage_url") or e.get("url")
        if not url or site_of(url) != site:
            return None
    title = e.get("title") or e.get("track")
    if not title:  # flat playlist entries may only carry their link: the slug stands in until download
        title = Path(urlparse(url).path).name.replace("-", " ").replace(".html", "").strip() or native
    out = {
        "id": track_id(site, native),
        "source": site,
        "title": title,
        "channel": e.get("artist") or e.get("channel") or e.get("uploader") or "",
        "duration": e.get("duration"),
        "thumbnail": thumb,
        "url": url,
    }
    if site == "jamendo" and cc_name(e.get("license")):
        # A CC licence asks for the artist, the licence and a link back to the song.
        out["credit"] = {"artist": out["channel"], "license": cc_name(e.get("license")), "license_url": None,
                         "page": url, "via": "Jamendo"}
    return out


def search(query: str, n: int = 8) -> list[dict]:
    opts = _opts("youtube", extract_flat="in_playlist", skip_download=True)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{n}:{query}", download=False)
    return [x for x in (_entry(e) for e in info.get("entries") or []) if x]


SHORT_SC = "on.soundcloud.com"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # each hop is looked at before it is followed


def _unshorten(url: str) -> str:
    """A SoundCloud share link (on.soundcloud.com/<code>) is a redirect to the
    song's soundcloud.com page, which yt-dlp's SoundCloud extractors can read.
    Followed by hand, one hop at a time, only while it stays on SoundCloud, so
    the server is never sent anywhere else."""
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(4):
        if (urlparse(url).hostname or "").lower() != SHORT_SC:
            return url
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; MashLoop)"})
        loc = None
        try:
            opener.open(req, timeout=15).close()
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                loc = e.headers.get("Location")
        except (urllib.error.URLError, OSError):
            raise ValueError("không mở được link SoundCloud rút gọn, thử lại") from None
        if not loc:
            raise ValueError("link SoundCloud rút gọn không dẫn tới bài nào")
        url = urljoin(url, loc)
        if site_of(url) != "soundcloud":
            raise ValueError("link rút gọn không dẫn tới SoundCloud")
    raise ValueError("link SoundCloud rút gọn chuyển hướng quá nhiều lần")


def resolve(text: str) -> list[dict]:
    """A song link gives one entry, a playlist (set, album) link gives its songs,
    and anything else is a YouTube search for the best match."""
    text = text.strip()
    if not re.match(r"^https?://", text):
        return search(text[:200], 1)
    site = site_of(text)
    if site is None:
        raise ValueError("chỉ nhận link YouTube, SoundCloud, Zing MP3, Bandcamp, Mixcloud hoặc Jamendo")
    if site == "soundcloud" and (urlparse(text).hostname or "").lower() == SHORT_SC:
        text = _unshorten(text)
    opts = _opts(site, extract_flat="in_playlist", skip_download=True, playlistend=MAX_PLAYLIST)
    # A watch URL that also carries &list= is treated as the single video.
    if site == "youtube" and ("watch?" in text or "youtu.be/" in text):
        opts["noplaylist"] = True
    try:
        with _cookies(site) as ck, yt_dlp.YoutubeDL({**opts, **ck}) as ydl:
            info = ydl.extract_info(text, download=False)
    except yt_dlp.utils.DownloadError as e:
        _explain(e, site)
        raise
    if info.get("_type") == "playlist" or "entries" in info:
        return [x for x in (_entry(e, site) for e in info.get("entries") or []) if x][:MAX_PLAYLIST]
    e = _entry(info, site)
    return [e] if e else []


def _explain(e: Exception, site: str) -> None:
    """Raises what a listener can read for the refusals they can do nothing
    about (and returns for the rest)."""
    msg = str(e)
    if "VIP" in msg:
        raise RuntimeError(f"bài này chỉ dành cho tài khoản VIP của {SITE_NAMES[site]}") from None
    if site == "youtube" and ("not a bot" in msg or "Sign in to confirm" in msg):
        raise RuntimeError("YouTube đang chặn server tải bài này, thử lại sau ít phút") from None


def download(meta: dict, dest_dir: Path, on_progress: Callable[[float], None] | None = None,
             cancelled: Callable[[], bool] = lambda: False) -> tuple[Path, dict]:
    """Fetches the sound of a registered track into dest_dir/source.*, after
    the downloads before it in this process and the pause after the last one.
    Raises Cancelled (nothing left behind) once cancelled() says so."""
    site = meta.get("source") or "youtube"
    url = f"https://www.youtube.com/watch?v={meta['id']}" if site == "youtube" else meta["url"]
    if site_of(url) != site:
        raise ValueError("link không thuộc nguồn được hỗ trợ")
    with _gate:
        while pause_left() > 0:
            if cancelled():
                raise Cancelled()
            time.sleep(min(0.25, pause_left()))
        if on_progress:
            on_progress(0.0)  # its turn: from here it is downloading
        try:
            return _fetch(site, url, dest_dir, on_progress, cancelled)
        except Cancelled:
            for left in dest_dir.glob("source.*"):  # a .part too
                left.unlink(missing_ok=True)
            raise
        finally:
            lo, hi = DOWNLOAD_PAUSE_S[0], DOWNLOAD_PAUSE_S[-1]
            _next["at"] = time.time() + random.uniform(lo, hi)


def _fetch(site: str, url: str, dest_dir: Path, on_progress, cancelled) -> tuple[Path, dict]:
    def hook(d):
        if cancelled():
            raise yt_dlp.utils.DownloadCancelled()
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                on_progress(min(1.0, d.get("downloaded_bytes", 0) / total))

    dest_dir.mkdir(parents=True, exist_ok=True)
    last_error = None
    # YouTube intermittently answers 403 for one player client's stream URLs;
    # another client usually gets through.
    for client in ((None, "tv", "web_safari", "mweb") if site == "youtube" else (None,)):
        if cancelled():
            raise Cancelled()
        for stale in dest_dir.glob("source.*"):
            stale.unlink(missing_ok=True)
        opts = _opts(site, format=FORMAT, noplaylist=True, outtmpl=str(dest_dir / "source.%(ext)s"),
                     progress_hooks=[hook], retries=3)
        if client:
            opts["extractor_args"] = {"youtube": {"player_client": [client]}}
        done = {"ok": False}
        try:
            with _cookies(site, keep=lambda: done["ok"]) as ck, yt_dlp.YoutubeDL({**opts, **ck}) as ydl:
                info = ydl.extract_info(url, download=True)
                done["ok"] = True
            # Go+ tracks only stream a 30-second preview to everyone else.
            previews = any("preview" in str(f.get("format_id", "")) for f in info.get("requested_downloads") or [])
            if site == "soundcloud" and (previews or (info.get("duration") or 99) <= 31):
                raise RuntimeError("SoundCloud chỉ cho nghe thử 30 giây bài này")
            path = Path(info["requested_downloads"][0]["filepath"])
            return path, _entry(info, site) or {}
        except yt_dlp.utils.DownloadCancelled:
            raise Cancelled() from None
        except yt_dlp.utils.DownloadError as e:
            if cancelled():
                raise Cancelled() from None
            last_error = e
            _explain(e, site)
            msg = str(e)
            if site != "youtube" or ("403" not in msg and "Forbidden" not in msg):
                raise
    raise last_error

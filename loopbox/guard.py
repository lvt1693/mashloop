"""Spotting and blocking abuse, for the admin page's "Nghi vấn".

Every request is counted under a keyed hash of its address (the key lives in
secrets/guard.key, so a client keeps its hash across restarts and can be
blocked by it): visits opened, the page asking for its library (what a real
page does every few seconds), refusals by the rate limits, unknown paths asked
for (a scanner's probes), admin sign-in misses, the user agents. Counts only,
in memory, for a day. A client that behaves like a program (visits opened and
dropped at once, refused again and again, a bot's or a script's user agent,
probes, sign-in misses) is a suspect, and only for a suspect the address
itself is kept, in memory, for the admin to see; nobody else's is.

Blocked (data/blocklist.json): clients by their hash, user agents by a piece
of text they contain, addresses or ranges as the admin typed them. A blocked
request gets a 403, except the admin page's own (the admin can never lock
themselves out). The blocked and trusted addresses also go to HAProxy, which
turns the blocked away before they reach the app. Trusted, never counted as a suspect nor blocked: the box
itself (loopback), the addresses or ranges the admin trusts (the server's own
public address, their home), and whatever address signed in to the admin page
in the last day.

The pass: hosted, a visit opens only with the cookie the page got when it
loaded (signed, a few hours, a few visits), so a program that only calls
/api/session is turned away (428) without anything made for it; the site's
own page in a browser is let in without it (an old copy of the page).

Blocked on its own, for a day, at the app and at HAProxy (the admin sees it
in the list and can lift it), whatever sends it: a flood (requests no page
makes in a minute), a scanner's probes, a script's user agent calling the
API, visits refused again and again. And, from a program only (the site's own
page doing this is a tab stuck on a bug of ours): many visits opened and never
used, or opened without the pass by an address that never loaded the page."""
import hashlib
import hmac
import ipaddress
import math
import os
import re
import secrets
import socket
import threading
import time
from collections import Counter

from . import library
from .config import BLOCKLIST_FILE, GUARD_KEY_FILE, HAPROXY_BLOCK_FILE, HAPROXY_SOCKET, HAPROXY_TRUST_FILE

KEEP_S = 24 * 3600
MAX_CLIENTS = 20000
BOT_UA = re.compile(r"bot|crawl|spider|slurp|python|curl|wget|httpx|aiohttp|go-http|java/|okhttp|libwww|scrapy|"
                    r"axios|node-fetch|undici|headless|phantom|puppeteer|playwright|selenium|postman|insomnia", re.I)
PROBE = re.compile(r"\.(php|asp|aspx|jsp|cgi|env|git|sql|bak|ini|xml|yml|yaml)\b|wp-|/\.|phpmyadmin|/cgi-bin|"
                   r"/vendor/phpunit|/actuator|/server-status|/etc/passwd|\.\./", re.I)
# Search engines and link previews: named by their user agent alone they are
# not suspects (they are when they behave like the others: their user agent
# can be borrowed). /.well-known/ is where the standards ask: never a probe.
CRAWLER_UA = re.compile(r"googlebot|google-|adsbot-google|mediapartners-google|bingbot|bingpreview|applebot|"
                        r"duckduckbot|yandex|baiduspider|slurp|petalbot|facebookexternalhit|facebot|twitterbot|"
                        r"linkedinbot|slackbot|slack-imgproxy|discordbot|telegrambot|whatsapp|zalo|skypeuripreview|"
                        r"bravebot",
                        re.I)
WELL_KNOWN = "/.well-known/"
# Asked for by search engines and browsers on their own: never a probe.
NOT_PROBES = re.compile(r"^/(sitemap[\w.-]*\.xml|robots\.txt|favicon\.ico|apple-touch-icon[\w-]*\.png|ads\.txt)$", re.I)
ADMIN_PATHS = ("/admin", "/api/admin")
LOCAL = {"127.0.0.1", "::1"}  # the box itself (its tools, its health checks): never blocked
# A user agent naming Chrome (90 or later; not Chrome on iOS, an Android web
# view or an Electron app, which may not): the real one sends client hints
# (Sec-CH-UA) on every request to an https site; one that sends none is a
# program wearing Chrome's name. Measured and shown, not blocked on.
CHROME_UA = re.compile(r"\bChrome/(\d+)")
NOT_CHROME = re.compile(r"; wv\)|CriOS|Electron/|HeadlessChrome")
AUTO_DRIVEN = 3  # visits refused to a browser driven by a program before it is blocked on its own
PAGES = ("/", "/index.html")
_TRACK = re.compile(r"^/api/tracks/[^/]+")
_SOUND = re.compile(r"^/api/tracks/([^/]+)/(?:audio|vocals)$")
PASS_COOKIE = "ml_pass"
PASS_S = 6 * 3600
PASS_USES = 10  # visits opened with one pass (the tabs of a browser share it)
# Blocked on its own for AUTO_S, whatever sends it: more than AUTO_FLOOD
# requests in a minute not made by the site's page, or more than
# AUTO_FLOOD_PAGE in all (the page itself sends bursts: changing a sample
# library drops up to 30 songs one by one and reads the next library's
# analyses and transitions, ~90 requests a change; measured peaks of real
# listeners 125-160 a minute), AUTO_PROBES probe paths, a script's user agent
# calling the API AUTO_SCRIPT times, AUTO_REFUSED visits refused (a page has
# its pass, or opens without it; the visit limit is 20 an hour). From a
# program only: AUTO_OPENED visits opened and hardly used, or AUTO_NOPASS
# opened without the pass by an address that never loaded the page.
AUTO_S = 24 * 3600
AUTO_FLOOD = 240
AUTO_FLOOD_PAGE = 1200
AUTO_PROBES = 10
AUTO_SCRIPT = 10
AUTO_REFUSED = 60
AUTO_OPENED = 15
AUTO_NOPASS = 20
# Shown to the admin, never blocked on: a client fetching the sound of
# DL_SONGS songs of its own (not the sample libraries) while playing less than
# DL_PLAY_S a song (taking the songs, not listening), and one playing on and on
# for BROADCAST_S (feeding a stream somewhere, or a listener who left it on).
# Playing is read from the page's polls (p=1): gaps up to PLAY_GAP_S count (a
# tab in the background polls once a minute while it plays).
DL_SONGS = 15
DL_PLAY_S = 30
BROADCAST_S = 6 * 3600
PLAY_GAP_S = 90

_lock = threading.Lock()
_sync_lock = threading.Lock()
_admin_ips: dict[str, float] = {}  # addresses signed in to the admin page -> when last
_clients: dict[str, dict] = {}
_agents: dict[str, dict] = {}
_hits: Counter = Counter()
_passes: dict[str, list] = {}  # a pass used -> [first use, visits opened]
_samples = {"at": 0.0, "ids": frozenset()}


def _sample_ids() -> frozenset:
    """The songs of the sample libraries (read again every 5 minutes)."""
    if time.time() - _samples["at"] > 300:
        try:
            _samples["ids"] = frozenset(library.samples()["ids"])
        except Exception:  # (keep the last ones)
            pass
        _samples["at"] = time.time()
    return _samples["ids"]


def _key() -> bytes:
    try:
        return GUARD_KEY_FILE.read_bytes()
    except OSError:
        GUARD_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        k = secrets.token_bytes(32)
        tmp = GUARD_KEY_FILE.with_suffix(".tmp")
        tmp.write_bytes(k)
        os.chmod(tmp, 0o600)
        os.replace(tmp, GUARD_KEY_FILE)
        return k


_KEY = _key()


def client(ip: str) -> str:
    return hashlib.blake2b(ip.encode(), key=_KEY, digest_size=8).hexdigest()


# ---------------------------------------------------------------- the pass

def _sign(body: str) -> str:
    return hashlib.blake2b(body.encode(), key=_KEY, digest_size=12, person=b"mashloop-pass").hexdigest()


def new_pass() -> str:
    """What the page brings when it loads: when it was made, a random part, signed."""
    body = f"{int(time.time()):x}.{secrets.token_hex(6)}"
    return f"{body}.{_sign(body)}"


def spend_pass(value: str | None) -> bool:
    """Whether a visit may open with this pass: made here, recent, and not
    used for more than PASS_USES visits."""
    try:
        made, nonce, sig = (value or "").split(".")
        age = time.time() - int(made, 16)
    except ValueError:
        return False
    if not -60 < age < PASS_S or not hmac.compare_digest(sig, _sign(f"{made}.{nonce}")):
        return False
    now = time.time()
    with _lock:
        if len(_passes) > 50000:
            for k in [k for k, (t, _) in _passes.items() if now - t > PASS_S]:
                _passes.pop(k, None)
        used = _passes.setdefault(nonce, [now, 0])
        used[1] += 1
        return used[1] <= PASS_USES


# ---------------------------------------------------------------- the rules

def _load() -> dict:
    d = library.read_json(BLOCKLIST_FILE) or {}
    return {k: d.get(k) or [] for k in KINDS}


KINDS = ("clients", "agents", "ips", "trusted")
_rules = _load()
_nets: list = []
_trusted_nets: list = []


def _compile() -> None:
    for kind, nets in (("ips", _nets), ("trusted", _trusted_nets)):
        nets.clear()
        for r in _rules[kind]:
            try:
                nets.append((ipaddress.ip_network(r["value"], strict=False), r["value"], r.get("until") or math.inf))
            except ValueError:
                pass


def trusted(ip: str) -> bool:
    """The box itself, an address the admin trusts, or one signed in to the
    admin page within the day: never a suspect, never blocked."""
    if ip in LOCAL or time.time() - _admin_ips.get(ip, 0.0) < KEEP_S:
        return True
    if _trusted_nets:
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(a in net for net, *_ in _trusted_nets)
    return False


def admin_seen(ip: str) -> None:
    """A signed-in admin's address: trusted for a day, and out of the suspects."""
    _admin_ips[ip] = time.time()
    with _lock:
        _clients.pop(client(ip), None)


_compile()


def start() -> None:
    """At startup: HAProxy's lists made the same as the app's; then, every
    minute, the blocks that ran out lifted."""
    threading.Thread(target=_keep, name="mashloop-guard", daemon=True).start()


def _keep() -> None:
    _haproxy_sync()
    while True:
        time.sleep(60)
        _expire()


def _expire() -> None:
    """The blocks given for a while (the ones the guard made on its own) lifted
    once over, and their clients counted afresh."""
    now = time.time()
    with _lock:
        over = {k: [r for r in v if (r.get("until") or math.inf) <= now] for k, v in _rules.items()}
        if not any(over.values()):
            return
        for k, gone in over.items():
            if gone:
                _rules[k] = [r for r in _rules[k] if r not in gone]
        for r in over["ips"]:
            _clients.pop(client(r["value"]), None)
        library.write_json(BLOCKLIST_FILE, _rules)
        _compile()
    _haproxy_sync()


def _covers_trusted(net) -> str | None:
    """A trusted address (the box, the trusted list, a signed-in admin's) that
    a range to block would take in: never blocked, at HAProxy either."""
    for t in [*LOCAL, *_admin_ips, *(r["value"] for r in _rules["trusted"])]:
        try:
            tn = ipaddress.ip_network(t, strict=False)
        except ValueError:
            continue
        if tn.version == net.version and net.overlaps(tn):
            return t
    return None


def _haproxy_sync() -> None:
    """The blocked addresses and the trusted ones for HAProxy: the files it
    loads when it starts, and its running lists through its admin socket (no
    reload). Only where HAProxy is set up for it (the block file exists)."""
    if not HAPROXY_BLOCK_FILE.exists():
        return
    with _lock:
        lists = ((HAPROXY_BLOCK_FILE, [r["value"] for r in _rules["ips"]]),
                 (HAPROXY_TRUST_FILE, sorted(LOCAL | {r["value"] for r in _rules["trusted"]})))
    with _sync_lock:  # (outside _lock: the requests being counted do not wait on HAProxy)
        for path, values in lists:
            try:
                tmp = path.with_suffix(".tmp")
                tmp.write_text("".join(f"{v}\n" for v in values))
                os.chmod(tmp, 0o644)
                os.replace(tmp, path)
            except OSError:
                continue
            _haproxy([f"clear acl {path}", *(f"add acl {path} {v}" for v in values)])


def _haproxy(commands: list[str]) -> str:
    """Commands to HAProxy's runtime API (one line, ";" between them)."""
    if not hasattr(socket, "AF_UNIX"):  # (Windows: no HAProxy here)
        return ""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(3)
            sock.connect(HAPROXY_SOCKET)
            sock.sendall(("; ".join(commands) + "\n").encode())
            out = b""
            while chunk := sock.recv(65536):
                out += chunk
            return out.decode(errors="replace")
    except OSError:
        return ""


def rules() -> dict:
    with _lock:
        return {k: [{**r, "hits": _hits[(k, r["value"])]} for r in v] for k, v in _rules.items()}


def block(kind: str, value: str, note: str = "", until: float | None = None) -> None:
    """A rule; with until, one that is lifted then (the guard's own)."""
    value = value.strip()
    if kind in ("ips", "trusted"):
        net = ipaddress.ip_network(value, strict=False)  # raises ValueError for a bad one
        if kind == "ips" and (t := _covers_trusted(net)):
            raise ValueError(f"dải này chứa địa chỉ tin cậy {t}")
    elif kind == "agents" and len(value) < 3:
        raise ValueError("cần ít nhất 3 ký tự")
    elif kind == "clients" and not re.fullmatch(r"[0-9a-f]{16}", value):
        raise ValueError("mã client không hợp lệ")
    elif kind not in KINDS:
        raise ValueError("loại chặn không hợp lệ")
    with _lock:
        if any(r["value"] == value for r in _rules[kind]):
            return
        _rules[kind].append({"value": value, "note": note[:200], "added": time.time(),
                             **({"until": round(until)} if until else {})})
        library.write_json(BLOCKLIST_FILE, _rules)
        _compile()
        if kind == "trusted":  # out of the suspects at once
            for h in [h for h, c in _clients.items() if c["ip"] and trusted(c["ip"])]:
                _clients.pop(h, None)
    if kind in ("ips", "trusted"):
        _haproxy_sync()


def unblock(kind: str, value: str) -> None:
    with _lock:
        _rules[kind] = [r for r in _rules.get(kind, []) if r["value"] != value]
        library.write_json(BLOCKLIST_FILE, _rules)
        _compile()
    if kind in ("ips", "trusted"):
        _haproxy_sync()


def is_probe(path: str) -> bool:
    """A path only a scanner asks for (/.env, /wp-login.php, /.git/config...)."""
    return (bool(PROBE.search(path)) and not path.startswith(("/api/", WELL_KNOWN))
            and not NOT_PROBES.match(path))


def _ip_rule(ip: str) -> str | None:
    """The address rule (not run out) that takes ip in, if any."""
    if not _nets:
        return None
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None
    now = time.time()
    return next((v for net, v, until in _nets if until > now and a in net), None)


def blocked(ip: str, ua: str, path: str) -> bool:
    """Whether a request is refused (the admin page's never)."""
    if path.startswith(ADMIN_PATHS) or trusted(ip):
        return False
    h = client(ip)
    hit = None
    if any(r["value"] == h for r in _rules["clients"]):
        hit = ("clients", h)
    elif ua and (low := ua.lower()) and (r := next((r for r in _rules["agents"] if r["value"].lower() in low), None)):
        hit = ("agents", r["value"])
    elif v := _ip_rule(ip):
        hit = ("ips", v)
    if hit:
        with _lock:
            _hits[hit] += 1
            c = _clients.get(h)
            if c:
                c["blocked"] += 1
                c["last"] = time.time()
        return True
    return False


# --------------------------------------------------------------- counting

def _blank(now: float) -> dict:
    return {"first": now, "last": now, "req": 0, "opened": 0, "polls": 0, "refused": Counter(), "agents": Counter(),
            "probes": Counter(), "missing": 0, "logins": 0, "blocked": 0, "ip": None,
            "kinds": Counter(), "statuses": Counter(), "pages": 0, "nopass": 0, "from_page": 0, "auto": False,
            "api": 0, "win_t": now, "win_n": 0, "peak": 0, "win_x": 0, "peak_x": 0,
            "added": 0, "songs": set(), "play_s": 0.0, "play_at": 0.0, "streak_s": 0.0, "longest_s": 0.0,
            "chrome": 0, "nohints": 0, "headless": 0, "elsewhere": 0, "driven": 0, "framed": 0}


def seen(ip: str, ua: str, method: str, path: str, status: int, from_page: bool = False,
         playing: bool = False, hints: str = "", elsewhere: bool = False, automated: bool = False,
         framed: bool = False) -> None:
    """One request and its answer (a trusted address's are not counted);
    from_page: made by the site's own page in a browser (server._from_page);
    playing: a poll of the library from a page that is playing; hints: its
    Sec-CH-UA; elsewhere: sent by another site's page (refused); automated:
    a visit asked for by a browser a program drives (refused); framed: the
    page asked for inside a frame (another site embedding it)."""
    if trusted(ip):
        return
    now = time.time()
    h = client(ip)
    ua = (ua or "")[:200]
    sound = _SOUND.match(path) if status == 200 else None
    own = bool(sound) and sound[1] not in _sample_ids()
    with _lock:
        c = _clients.get(h)
        if c is None:
            if len(_clients) >= MAX_CLIENTS:
                _forget(now)
            c = _clients[h] = _blank(now)
        c["last"] = now
        c["req"] += 1
        c["agents"][ua] += 1
        # What it asks for (a track's id left out) and what it is answered.
        kind = f"{method} {_TRACK.sub('/api/tracks/<id>', path)}" if path.startswith("/api/") else "trang và file tĩnh"
        if kind in c["kinds"] or len(c["kinds"]) < 30:
            c["kinds"][kind] += 1
        c["statuses"][status] += 1
        c["from_page"] += from_page
        c["api"] += path.startswith("/api/")
        cv = CHROME_UA.search(ua)
        if cv and int(cv[1]) >= 90 and not NOT_CHROME.search(ua):
            c["chrome"] += 1
            c["nohints"] += not hints
        c["headless"] += "HeadlessChrome" in hints
        c["elsewhere"] += elsewhere
        c["driven"] += automated
        c["framed"] += framed
        if now - c["win_t"] >= 60:  # requests per minute (whole minutes from its first)
            c["win_t"], c["win_n"], c["win_x"] = now, 0, 0
        c["win_n"] += 1
        c["win_x"] += not from_page
        c["peak"] = max(c["peak"], c["win_n"])
        c["peak_x"] = max(c["peak_x"], c["win_x"])
        if own and len(c["songs"]) < 300:
            c["songs"].add(sound[1])
        if method == "POST" and path == "/api/tracks" and status == 200:
            c["added"] += 1
        if playing and method == "GET" and status == 200:
            gap = now - c["play_at"]
            c["streak_s"] = c["streak_s"] + gap if gap <= PLAY_GAP_S else 0.0
            c["play_s"] += gap if gap <= PLAY_GAP_S else 0.0
            c["longest_s"] = max(c["longest_s"], c["streak_s"])
            c["play_at"] = now
        a = _agents.setdefault(ua, {"clients": set(), "req": 0, "opened": 0, "polls": 0, "refused": 0, "probes": 0,
                                    "last": now})
        a["req"] += 1
        a["last"] = now
        if len(a["clients"]) < 500:
            a["clients"].add(h)
        if method == "POST" and path == "/api/session" and status == 200:
            c["opened"] += 1
            a["opened"] += 1
        elif method == "POST" and path == "/api/session" and status == 428:
            c["nopass"] += 1
        elif method == "GET" and path == "/api/tracks" and status == 200:
            c["polls"] += 1
            a["polls"] += 1
        elif method in ("GET", "HEAD") and path in PAGES and status in (200, 304):
            c["pages"] += 1
        if status == 429:
            c["refused"][path] += 1
            a["refused"] += 1
        if status == 404 and not path.startswith(("/api/", WELL_KNOWN)):
            c["missing"] += 1
            if is_probe(path) and len(c["probes"]) < 50:
                c["probes"][path[:120]] += 1
                a["probes"] += 1
        if path == "/api/admin/login" and status in (401, 429):
            c["logins"] += 1
        if c["ip"] is None and _reasons(c):
            c["ip"] = ip  # a suspect: its address kept (in memory) for the admin
        auto = None if c["auto"] else _auto(c)
        if auto:
            c["auto"] = True  # once (an admin who lifts it is not overruled)
    if auto:  # (written and sent to HAProxy off the request's way)
        threading.Thread(target=_auto_block, args=(ip, auto), name="mashloop-autoblock", daemon=True).start()


def _auto(c: dict) -> str | None:
    """Why this client is to be blocked on its own, if it is. Whatever sends
    them: a flood, probes, a script calling the API, visits refused again and
    again (none of which a page of ours does, stuck or not). Only opening
    visits is left to the admin for the site's own page in a browser (a tab
    stuck opening visit after visit is a bug of ours, not a program: one did
    that for every restart while the browser kept a 410), search engines by
    name (they render the page without keeping its cookies), and a page that
    had a visit (asked with it, or was told it was lost; cookies blocked)."""
    ua = c["agents"].most_common(1)[0][0] if c["agents"] else ""
    if c["peak_x"] > AUTO_FLOOD:
        return f"{c['peak_x']} request trong một phút, không phải từ trang web"
    if c["peak"] > AUTO_FLOOD_PAGE:
        return f"{c['peak']} request trong một phút"
    if len(c["probes"]) >= AUTO_PROBES:
        return f"dò {sum(c['probes'].values())} đường dẫn lạ"
    if (not ua or BOT_UA.search(ua)) and not CRAWLER_UA.search(ua) and c["api"] >= AUTO_SCRIPT:
        return f"user-agent của script ({ua[:40] or 'không có'}), gọi API {c['api']} lần"
    if c["headless"] and c["api"] >= AUTO_SCRIPT and not CRAWLER_UA.search(ua):  # (a search engine renders headless)
        return f"Chrome headless (client hints), gọi API {c['api']} lần"
    if c["driven"] >= AUTO_DRIVEN:
        return f"trình duyệt bị điều khiển tự động (webdriver), mở phiên {c['driven']} lần"
    refused = c["nopass"] + c["refused"]["/api/session"]
    if refused >= AUTO_REFUSED:
        return f"bị từ chối mở phiên {refused} lần"
    if c["from_page"] or CRAWLER_UA.search(ua):
        return None
    if c["opened"] >= AUTO_OPENED and c["polls"] * 2 < c["opened"]:
        return f"mở {c['opened']} phiên nhưng chỉ hỏi thư viện {c['polls']} lần"
    if c["nopass"] >= AUTO_NOPASS and not c["pages"] and not c["polls"] and not c["statuses"][410]:
        return f"mở phiên {c['nopass']} lần mà chưa từng tải trang"
    return None


def _auto_block(ip: str, why: str) -> None:
    try:
        block("ips", ip, f"tự chặn 24 giờ: {why}", until=time.time() + AUTO_S)
    except ValueError:  # (a trusted address in it: never)
        pass


def _forget(now: float) -> None:
    for h in [h for h, c in _clients.items() if now - c["last"] > KEEP_S]:
        _clients.pop(h, None)
    for ua in [ua for ua, a in _agents.items() if now - a["last"] > KEEP_S]:
        _agents.pop(ua, None)
    if len(_clients) >= MAX_CLIENTS:  # still full: the quietest go
        for h, _ in sorted(_clients.items(), key=lambda kv: kv[1]["last"])[:MAX_CLIENTS // 10]:
            _clients.pop(h, None)


def _reasons(c: dict) -> list[str]:
    out = []
    dropped = c["opened"] - c["polls"]
    if c["opened"] >= 10 and c["polls"] < c["opened"]:  # (a page asks at once when it opens, then every 20 s)
        out.append(f"mở {c['opened']} phiên nhưng chỉ hỏi thư viện {c['polls']} lần")
    if c["nopass"] >= 3:
        out.append(f"mở phiên {c['nopass']} lần không qua trang" + ("" if c["pages"] else ", chưa từng tải trang"))
    refused = sum(c["refused"].values())
    if refused >= 5:
        what = {"/api/tracks": "thêm bài", "/api/session": "mở trang", "/api/search": "tìm kiếm", "/api/upload": "tải file"}
        parts = ", ".join(f"{what.get(p, p)} {n}" for p, n in c["refused"].most_common(3))
        out.append(f"chạm giới hạn {refused} lần ({parts})")
    if c["peak_x"] >= AUTO_FLOOD // 2:
        out.append(f"tới {c['peak_x']} request trong một phút không phải từ trang web")
    n = len(c["songs"])
    if n >= DL_SONGS and c["play_s"] < DL_PLAY_S * n:
        out.append(f"tải audio {n} bài của khách nhưng chỉ phát {round(c['play_s'] / 60)} phút")
    if c["longest_s"] >= BROADCAST_S:
        out.append(f"phát liên tục {c['longest_s'] / 3600:.1f} giờ")
    if c["driven"]:
        out.append(f"trình duyệt bị điều khiển tự động (webdriver) {c['driven']} lần")
    if c["headless"]:
        out.append("client hints báo Chrome headless")
    if c["elsewhere"]:
        out.append(f"gọi API từ trang của site khác {c['elsewhere']} lần (bị từ chối)")
    if c["framed"]:
        out.append(f"trang bị mở trong iframe {c['framed']} lần (trình duyệt không cho hiện)")
    if c["chrome"] >= 20 and c["nohints"] >= 0.9 * c["chrome"]:
        out.append(f"tự xưng Chrome nhưng không gửi client hints ({c['nohints']}/{c['chrome']} request)")
    main_ua = c["agents"].most_common(1)[0][0] if c["agents"] else ""
    if not main_ua:
        out.append("không gửi user-agent")
    elif BOT_UA.search(main_ua) and not CRAWLER_UA.search(main_ua):
        out.append("user-agent của bot hoặc script")
    if c["probes"]:
        out.append(f"dò {sum(c['probes'].values())} đường dẫn lạ")
    elif c["missing"] >= 20:
        out.append(f"{c['missing']} lần hỏi trang không có")
    if c["logins"] >= 3:
        out.append(f"đăng nhập admin sai {c['logins']} lần")
    if dropped > 50 and not out:
        out.append(f"bỏ ngay {dropped} phiên")
    return out


def suspects(limit: int = 50) -> list[dict]:
    now = time.time()
    with _lock:
        _forget(now)
        rows = []
        blocked_clients = {r["value"] for r in _rules["clients"]}
        for h, c in _clients.items():
            why = _reasons(c)
            if not why and not c["blocked"]:
                continue
            rows.append({"id": h, "ip": c["ip"], "first": c["first"], "last": c["last"], "req": c["req"],
                         "opened": c["opened"], "polls": c["polls"], "refused": sum(c["refused"].values()),
                         "probes": c["probes"].most_common(5), "missing": c["missing"], "logins": c["logins"],
                         "agents": c["agents"].most_common(3), "blocked": c["blocked"], "why": why,
                         "kinds": c["kinds"].most_common(8), "statuses": sorted(c["statuses"].items()),
                         "pages": c["pages"], "nopass": c["nopass"], "from_page": c["from_page"],
                         "is_blocked": h in blocked_clients or bool(c["ip"] and _ip_rule(c["ip"])),
                         "score": len(why) * 10 + min(9, c["opened"] // 50), **_use(c)})
    rows.sort(key=lambda r: (-r["score"], -r["last"]))
    return rows[:limit]


def _use(c: dict) -> dict:
    """What a client did with the site: songs brought in, songs of its own
    whose sound it took, how long it played, the busiest minute."""
    return {"added": c["added"], "songs": len(c["songs"]), "play_s": round(c["play_s"]),
            "longest_s": round(c["longest_s"]), "peak": c["peak"], "peak_x": c["peak_x"],
            "chrome": c["chrome"], "nohints": c["nohints"]}


def everyone(limit: int = 400) -> list[dict]:
    """Every client of the last day, the busiest first: what it did, by its
    hash (the address only for a suspect, as everywhere else)."""
    now = time.time()
    with _lock:
        _forget(now)
        blocked_clients = {r["value"] for r in _rules["clients"]}
        rows = [{"id": h, "ip": c["ip"], "ua": c["agents"].most_common(1)[0][0] if c["agents"] else "",
                 "first": c["first"], "last": c["last"], "req": c["req"], "from_page": c["from_page"],
                 "pages": c["pages"], "opened": c["opened"], "polls": c["polls"], "refused": sum(c["refused"].values()),
                 "why": _reasons(c), "is_blocked": h in blocked_clients or bool(c["ip"] and _ip_rule(c["ip"])), **_use(c)}
                for h, c in _clients.items()]
    rows.sort(key=lambda r: -r["req"])
    return rows[:limit]


def agents(limit: int = 40) -> list[dict]:
    with _lock:
        rows = [{"ua": ua, "clients": len(a["clients"]), "req": a["req"], "opened": a["opened"], "polls": a["polls"],
                 "refused": a["refused"], "probes": a["probes"], "last": a["last"], "bot": (bool(BOT_UA.search(ua)) and not CRAWLER_UA.search(ua)) or not ua,
                 "crawler": bool(CRAWLER_UA.search(ua))}
                for ua, a in _agents.items()]
    rows.sort(key=lambda r: (-(r["opened"] - r["polls"] / 2 + r["refused"] + r["probes"] * 5), -r["req"]))
    return rows[:limit]

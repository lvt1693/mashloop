import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("MASHLOOP_DATA") or ROOT / "data")
LIBRARY_DIR = DATA_DIR / "library"
# One file per ordered pair of songs: the transitions from the first to the
# second. Shared by every listener, so a pair is only ever computed once.
PAIRS_DIR = DATA_DIR / "pairs"
# Per-song transition lists assembled for the whole local library, read by the
# test tools (tools/sim_player.mjs, link_report.py). Written by `cli relink`.
TRANSITIONS_DIR = DATA_DIR / "transitions"
WEB_DIR = ROOT / "web"


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name) or default)


HOST = os.environ.get("MASHLOOP_HOST") or "127.0.0.1"
PORT = _env_int("MASHLOOP_PORT", 8765)

# Hosted for many listeners (MASHLOOP_MULTIUSER=1): every visit starts an empty
# library of its own, and songs anyone has added are kept as a shared cache.
# Off (the default) it is the personal app: one library, kept between visits.
MULTIUSER = os.environ.get("MASHLOOP_MULTIUSER") == "1"
# Songs analysed at once (each worker process holds its own models on the GPU)
# and processes computing transitions between songs.
ANALYSIS_WORKERS = _env_int("MASHLOOP_ANALYSIS_WORKERS", 1)
LINK_WORKERS = _env_int("MASHLOOP_LINK_WORKERS", 1)
# CPU threads per worker process (numpy, librosa, torch on the CPU parts).
WORKER_THREADS = _env_int("MASHLOOP_WORKER_THREADS", 4)
# Shared cache size: past it, the songs nobody has used for longest go.
MAX_STORE_GB = float(os.environ.get("MASHLOOP_MAX_STORE_GB") or 0)  # 0 = no limit
MAX_SESSION_TRACKS = _env_int("MASHLOOP_MAX_SESSION_TRACKS", 60)
MAX_PLAYLIST = _env_int("MASHLOOP_MAX_PLAYLIST", 25)
MAX_UPLOAD_MB = _env_int("MASHLOOP_MAX_UPLOAD_MB", 80)
SESSION_TTL_S = _env_int("MASHLOOP_SESSION_TTL_H", 12) * 3600
# Hosted, the sound of a song nobody has used for this long is deleted; what the
# analysis made stays, so adding the song again only fetches the sound (an
# uploaded file has to be uploaded again). The sample library and the songs an
# open library holds are kept.
AUDIO_TTL_S = _env_int("MASHLOOP_AUDIO_TTL_H", 12) * 3600
# Mashups (the "Tạo mashup" page): off unless MASHLOOP_MASHUPS=1 (hidden on the
# page, and no new mashup is planned or made; the ones made stay playable).
MASHUPS = os.environ.get("MASHLOOP_MASHUPS") == "1"
# Kept this long after they are made (their creator can come back to
# them), rendered this many at a time (CPU work: warping with Rubber Band, in
# MASHUP_STRETCH_JOBS processes each), and refused past this many waiting.
MASHUP_TTL_S = _env_int("MASHLOOP_MASHUP_TTL_H", 48) * 3600
MASHUP_WORKERS = _env_int("MASHLOOP_MASHUP_WORKERS", 1)
MASHUP_STRETCH_JOBS = _env_int("MASHLOOP_MASHUP_STRETCH_JOBS", 4)
MASHUP_BACKLOG = _env_int("MASHLOOP_MASHUP_BACKLOG", 8)
# The vocal stem (the voice handed over in the loop, the a cappella and the
# instrumental of the mashups) is separated by BS-RoFormer (analysis/roformer.py)
# in a pool of its own, one process holding the model on the GPU: right after a
# song is analysed, before a mashup that sings with it, and for the songs
# separated before (HTDemucs) whenever the pool is idle. A song's meta records
# the model of its stem; 0 workers keeps the HTDemucs stems.
STEMS_MODEL = "bs-roformer-viperx-1297"
STEMS_WORKERS = _env_int("MASHLOOP_STEMS_WORKERS", 1)
# JavaScript runtime yt-dlp uses for YouTube's player challenges (node or deno).
JS_RUNTIME = os.environ.get("MASHLOOP_JS_RUNTIME") or "node"
# YouTube cookies (Netscape format, from a logged-in browser) for yt-dlp, so
# the server is not taken for a bot; used when the file exists. Kept out of
# git and out of the code a deploy replaces (secrets/ beside the code).
COOKIES = Path(os.environ.get("MASHLOOP_COOKIES") or ROOT / "secrets" / "youtube-cookies.txt")
# Songs are fetched one at a time for the whole app, with a pause of this many
# seconds (drawn at random between the two) after each: the sites see one
# listener, not a burst. A video is never fetched above this height (the
# sound is what is kept).
DOWNLOAD_PAUSE_S = tuple(float(x) for x in (os.environ.get("MASHLOOP_DOWNLOAD_PAUSE_S") or "5,10").split(",")[:2])
MAX_VIDEO_HEIGHT = _env_int("MASHLOOP_MAX_VIDEO_HEIGHT", 480)
# The /admin page: its one account as a scrypt hash (set with `python -m
# loopbox.adminauth`; without the file there is no admin page), the page
# itself (outside web/: never served as a static file), and the counts it
# shows, one file per day.
ADMIN_FILE = Path(os.environ.get("MASHLOOP_ADMIN") or ROOT / "secrets" / "admin.json")
ADMIN_WEB_DIR = ROOT / "admin"
STATS_DIR = DATA_DIR / "stats"
# Spotting and blocking abuse (guard.py): the key that hashes addresses (so a
# blocked client stays blocked across restarts), and what is blocked.
GUARD_KEY_FILE = ROOT / "secrets" / "guard.key"
BLOCKLIST_FILE = DATA_DIR / "blocklist.json"
# The same blocked and trusted addresses for HAProxy, which turns the blocked
# away before the app (deploy/haproxy.cfg loads these files; the app keeps
# them and HAProxy's running lists current). Only used where the files exist.
HAPROXY_BLOCK_FILE = Path(os.environ.get("MASHLOOP_HAPROXY_BLOCK") or "/etc/haproxy/mashloop-block.lst")
HAPROXY_TRUST_FILE = Path(os.environ.get("MASHLOOP_HAPROXY_TRUST") or "/etc/haproxy/mashloop-trust.lst")
HAPROXY_SOCKET = os.environ.get("MASHLOOP_HAPROXY_SOCKET") or "/run/haproxy/admin.sock"
# Hosted: visits held at most (past it the empty ones quiet longest go first),
# new songs (the ones the server must fetch) one address may add a day, and
# pages it may open an hour.
MAX_SESSIONS = _env_int("MASHLOOP_MAX_SESSIONS", 5000)
VISITS_HOUR = _env_int("MASHLOOP_VISITS_HOUR", 20)
NEW_TRACKS_DAY = _env_int("MASHLOOP_NEW_TRACKS_DAY", 20)

# Audio stored for playback and analysis: identical samples on both sides.
SAMPLE_RATE = 44100
ANALYSIS_SR = 22050
TARGET_LUFS = -14.0
MAX_DURATION_S = _env_int("MASHLOOP_MAX_DURATION_S", 15 * 60)

DEVICE = "cuda"  # falls back to cpu at runtime when CUDA is unavailable

# Bump when the analysis output changes in a way that requires re-analysis.
ANALYSIS_VERSION = 6
# Bump when only the cross-track transition search changes.
TRANSITIONS_VERSION = 10

for d in (LIBRARY_DIR, PAIRS_DIR, TRANSITIONS_DIR):
    d.mkdir(parents=True, exist_ok=True)

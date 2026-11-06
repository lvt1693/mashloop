"""On-disk track library. One folder per track: meta.json, audio.flac,
analysis.json (sent to the browser) and features.npz (kept for linking).
Hosted, audio.flac is deleted once the song has gone unused for a while
(drop_idle_audio); the rest stays, so the song comes back without a new analysis.

Track ids are YouTube video ids (11 characters); "x" and 16 hex digits for a
song from another site (download.track_id); or, for uploaded files, "u" and
the first 16 hex digits of the file's SHA-1. The same song added twice, by
anyone, is the same track."""
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

import numpy as np

from .config import ANALYSIS_VERSION, LIBRARY_DIR, PAIRS_DIR, STEMS_MODEL, TRANSITIONS_DIR

_lock = threading.RLock()

FINAL_STATES = {"ready", "error"}
_ID = re.compile(r"^(?:[A-Za-z0-9_-]{11}|[ux][0-9a-f]{16})$")


def valid_id(tid: str) -> bool:
    return bool(tid) and bool(_ID.match(tid))


def track_dir(tid: str) -> Path:
    if not valid_id(tid):
        raise ValueError(f"bad track id {tid!r}")
    return LIBRARY_DIR / tid


def pair_path(a: str, b: str) -> Path:
    if not (valid_id(a) and valid_id(b)):
        raise ValueError("bad track id")
    return PAIRS_DIR / a / f"{b}.json"


def touch(tid: str) -> None:
    """Marks a track as just used (what the store keeps longest)."""
    try:
        (track_dir(tid) / "used").touch()
    except OSError:
        pass


def last_used(tid: str) -> float:
    d = track_dir(tid)
    for name in ("used", "meta.json"):
        try:
            return (d / name).stat().st_mtime
        except OSError:
            continue
    return 0.0


def audio_path(tid: str) -> Path:
    return track_dir(tid) / "audio.flac"


def analysis_path(tid: str) -> Path:
    return track_dir(tid) / "analysis.json"


def features_path(tid: str) -> Path:
    return track_dir(tid) / "features.npz"


def transitions_path(tid: str) -> Path:
    return TRANSITIONS_DIR / f"{tid}.json"


def has_audio(tid: str) -> bool:
    return audio_path(tid).exists()


FORMATS = ("mp3",)


def transport_path(tid: str, kind: str, fmt: str = "mp3") -> Path:
    """The copy sent to browsers: kind "audio" (encoded from audio.flac when
    the track is fetched, or when first asked for) or "vocals" (the vocal stem
    of a sung track, written by the analysis)."""
    if kind not in ("audio", "vocals") or fmt not in FORMATS:
        raise ValueError("bad sound")
    return track_dir(tid) / f"{kind}.{fmt}"


def has_vocals(tid: str) -> bool:
    d = track_dir(tid)
    return (d / "vocals.mp3").exists() or (d / "vocals.flac").exists()  # .flac: from before MP3


# Below this mean vocal presence a track is treated as instrumental: no stem kept.
STEM_MIN_VOCAL = 0.05


def needs_stem(tid: str) -> bool:
    """A ready, sung song with its sound whose vocal stem is missing (its sound
    was fetched again after being deleted, which keeps the analysis but not the
    stem) or was made by an older model than STEMS_MODEL."""
    meta = read_meta(tid) or {}
    if meta.get("status") != "ready" or not audio_path(tid).exists():
        return False
    if meta.get("stems_model") == STEMS_MODEL and has_vocals(tid):
        return False
    try:
        with np.load(features_path(tid)) as z:
            return float(z["vocal"].mean()) >= STEM_MIN_VOCAL
    except (OSError, KeyError, ValueError):
        return False


def sound_files(tid: str) -> list[Path]:
    """Everything of a track that is its sound (not what the analysis made)."""
    d = track_dir(tid)
    files = [audio_path(tid), *d.glob("audio.*"), *d.glob("vocals.*"), *d.glob("drums.*"), *d.glob("bass.*"),
             *d.glob("source.*")]
    return [f for f in dict.fromkeys(files) if f.exists()]


def drop_pairs(tid: str) -> None:
    """Forgets every transition to or from a track (they are computed again)."""
    shutil.rmtree(PAIRS_DIR / tid, ignore_errors=True)
    for d in PAIRS_DIR.iterdir():
        (d / f"{tid}.json").unlink(missing_ok=True)


def analysis_current(tid: str, meta: dict) -> bool:
    """True when the song's analysis on disk is complete and of this version, so
    sound fetched again for it needs no new analysis."""
    return (meta.get("analysis_version") == ANALYSIS_VERSION
            and analysis_path(tid).exists() and features_path(tid).exists())


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    # allow_nan=False: NaN/Infinity are not JSON and would break the browser's parser.
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    os.replace(tmp, path)


def read_json(path: Path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def read_meta(tid: str) -> dict | None:
    return read_json(track_dir(tid) / "meta.json")


def create(tid: str, **fields) -> dict:
    with _lock:
        meta = read_meta(tid)
        if meta is None:
            meta = {"id": tid, "added_at": time.time(), "enabled": True}
        meta.update(fields)
        write_json(track_dir(tid) / "meta.json", meta)
        return meta


def update(tid: str, **fields) -> dict | None:
    with _lock:
        meta = read_meta(tid)
        if meta is None:
            return None
        meta.update(fields)
        write_json(track_dir(tid) / "meta.json", meta)
        return meta


def list_tracks() -> list[dict]:
    out = []
    for d in LIBRARY_DIR.iterdir():
        if d.is_dir() and valid_id(d.name):
            meta = read_meta(d.name)
            if meta:
                out.append(meta)
    out.sort(key=lambda m: m.get("added_at", 0))
    return out


def ready_ids() -> list[str]:
    return [m["id"] for m in list_tracks() if m.get("status") == "ready"]


def delete(tid: str) -> None:
    """Removes a track and every transition to or from it."""
    with _lock:
        shutil.rmtree(track_dir(tid), ignore_errors=True)
        transitions_path(tid).unlink(missing_ok=True)
        shutil.rmtree(PAIRS_DIR / tid, ignore_errors=True)
        for d in PAIRS_DIR.iterdir():
            (d / f"{tid}.json").unlink(missing_ok=True)


def samples_path() -> Path:
    return LIBRARY_DIR.parent / "samples.json"


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "samples"


def samples() -> dict:
    """The sample libraries offered to every library, by theme (set with `cli
    samples` or deploy/seed_cc.py): {"libraries": [{"key", "name", "blurb",
    "ids"}], "ids": every song in any of them}."""
    s = read_json(samples_path()) or {}
    libs = s.get("libraries")
    if libs is None and s.get("ids"):  # the single-library file from before there were several
        libs = [{"key": _slug(s.get("name") or ""), "name": s.get("name"), "ids": s["ids"]}]
    out = []
    for lib in libs or []:
        ids = [t for t in lib.get("ids") or [] if valid_id(t)]
        if ids:
            out.append({"key": str(lib.get("key") or _slug(lib.get("name") or "")), "name": lib.get("name") or "Thư viện mẫu",
                        "blurb": lib.get("blurb") or "", "ids": ids})
    return {"libraries": out, "ids": list(dict.fromkeys(t for lib in out for t in lib["ids"]))}


def set_sample_library(key: str, name: str, ids: list[str], blurb: str = "") -> dict:
    """Adds one sample library, or replaces the one with the same key in place."""
    with _lock:
        libs = samples()["libraries"]
        new = {"key": key, "name": name, "blurb": blurb, "ids": [t for t in ids if valid_id(t)]}
        at = next((i for i, lib in enumerate(libs) if lib["key"] == key), None)
        if at is None:
            libs.append(new)
        else:
            libs[at] = new
        write_json(samples_path(), {"libraries": libs})
    return samples()


def _tree_bytes(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def drop_idle_audio(max_idle_s: float, keep: set[str]) -> list[str]:
    """Deletes the sound of finished songs not in `keep` that nobody has used
    for max_idle_s, and any download or upload left behind with them. The
    analysis, features and pairs stay: the song can come back without being
    analysed again. Returns the ids."""
    now = time.time()
    gone = []
    for d in LIBRARY_DIR.iterdir():
        tid = d.name
        if not d.is_dir() or not valid_id(tid) or tid in keep:
            continue
        if (read_meta(tid) or {}).get("status") not in FINAL_STATES or now - last_used(tid) < max_idle_s:
            continue
        files = sound_files(tid)
        for f in files:
            f.unlink(missing_ok=True)
        if files:
            gone.append(tid)
    return gone


def evict(max_bytes: int, keep: set[str]) -> list[str]:
    """Brings the library under max_bytes (with a tenth of headroom), least
    recently used first among the finished tracks not in `keep`: first by
    deleting only their sound (the analysis stays, so a song comes back without
    a new analysis), then, if that is not enough, whole tracks. Returns the ids."""
    sizes = {d.name: _tree_bytes(d) for d in LIBRARY_DIR.iterdir() if d.is_dir() and valid_id(d.name)}
    total = sum(sizes.values())
    if total <= max_bytes:
        return []
    target = 0.9 * max_bytes
    order = [t for t in sorted(sizes, key=last_used)
             if t not in keep and (read_meta(t) or {}).get("status") in FINAL_STATES]
    gone = []
    for tid in order:
        if total <= target:
            break
        files = sound_files(tid)
        freed = sum(f.stat().st_size for f in files)
        for f in files:
            f.unlink(missing_ok=True)
        total -= freed
        if freed:
            gone.append(tid)
    for tid in order:
        if total <= target:
            break
        total -= _tree_bytes(track_dir(tid))
        delete(tid)
        gone.append(tid)
    return list(dict.fromkeys(gone))

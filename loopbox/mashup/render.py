"""Makes the sound of a mashup plan (run in a worker process).

Every clip is cut from its source stem (the full mix, the vocal stem, the
mix without it rebuilt on its drums and bass, without the drums for an
acoustic vibe) and warped by Rubber
Band onto the common grid with a time map that pins every source beat to its
place there, moved into the common key at the same time (formants kept where
a voice is in it).

Each song's stems are levelled once, over the whole song (its loud parts for
a band, its sung parts for a voice), so a quiet intro stays quieter than its
chorus. Then every clip follows its automation (gain, high- and low-pass
cutoffs, the bass band, all as points on the common beat grid), and a voice
keeps, from the pickup and tail it was given, only the phrase: it comes in
where the line starts (after the last silence before its bar line) and goes
out where the line ends (at the first silence after it), never cut mid-word;
where another voice is singing its own line, the edges of this one step
back. The band makes room for the voices (a few dB off its middle while
they sing), the club vibe pumps it; the DJ moves are added (risers,
impacts, a beat of silence, echo throws, vocal chops, a loop roll, a gate,
a brake, a spinback, a reverb wash); a hall reverb is fed from the sends; the
vibe shapes the whole (a club low end, a lo-fi chill, a slowed or sped-up
resample); and the master is set to -14 LUFS under a -2 dBFS limiter and
encoded to MP3."""
import concurrent.futures as cf
import shutil
import subprocess
import tempfile
import traceback
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

from .. import audio, library
from ..analysis import transitions as T
from ..config import DATA_DIR, MASHUP_STRETCH_JOBS, SAMPLE_RATE as SR, TARGET_LUFS
from . import dsp, store

# Reverb sends by vibe (a dry pop mix keeps a little on the voice).
VOCAL_SEND = {"chill": 0.25, "slowed": 0.32, "acoustic": 0.2}
MUSIC_SEND = {"slowed": 0.18, "acoustic": 0.1}
MARGIN = 0.5    # s of source either side of a clip, for the warp to settle
TAIL = 6.0      # s after the last bar for reverb and echo tails
CHOP = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1]  # a vocal chop's pattern, in sixteenths
# Levels the stems are brought to before the plan's own gains: a band's loud
# parts and a voice's sung parts, as RMS (the master sets the loudness).
MUSIC_REF_DB = -16.0
VOICE_REF_DB = -17.0
RIDE_DB = 3.0  # the lead voice over the band, as the rider keeps it (RMS over 1.5 s)
# A phrase edge: silence is this far under the line's own level, for this long.
QUIET_DB = 20.0
QUIET_S = 0.09
HOP = 441  # 10 ms
# What the last mix found (for the tests): how each voice's edges were met,
# and the band and voice levels per section.
STATS: dict = {}


def _decode(path: Path) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR),
                        "-"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2)


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    if len(x) >= n:
        return x[:n]
    return np.concatenate([x, np.zeros((n - len(x), 2), np.float32)])


def _db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-9))


def _unvoice(inst: np.ndarray, voc: np.ndarray, floor: float = 0.25, n: int = 2048) -> np.ndarray:
    """The separated band with what is left of the voice in it pressed down:
    in every time-frequency bin where the separated voice is strong against
    the band, the band is turned down (a Wiener mask, |I|² / (|I|² + |V|²),
    never below `floor`: -12 dB), so the ghost of the lyrics that a
    subtraction leaves behind fades instead of singing along."""
    out = np.empty_like(inst)
    hop = n // 4
    for c in range(inst.shape[1]):
        _, _, si = signal.stft(inst[:, c], nperseg=n, noverlap=n - hop)
        _, _, sv = signal.stft(voc[:, c], nperseg=n, noverlap=n - hop)
        pi, pv = np.abs(si) ** 2, np.abs(sv) ** 2
        mask = np.maximum(floor, pi / (pi + pv + 1e-12)).astype(np.float32)
        del pi, pv, sv
        _, y = signal.istft(si * mask, nperseg=n, noverlap=n - hop)
        out[:, c] = _fit(y[:, None].astype(np.float32), len(inst))[:, 0]
    return out


class Sources:
    """The stems of the songs a plan uses, loaded once, and their levels."""

    def __init__(self):
        self.base: dict[tuple[str, str], np.ndarray] = {}
        self.levels: dict[tuple[str, str], float] = {}

    def _get(self, tid: str, what: str) -> np.ndarray:
        key = (tid, what)
        if key not in self.base:
            if what == "mix":
                x = audio.load(library.audio_path(tid))
            else:
                x = _fit(_decode(library.track_dir(tid) / f"{what}.mp3"), len(self._get(tid, "mix")))
            self.base[key] = x
        return self.base[key]

    def stem(self, tid: str, stem: str) -> np.ndarray:
        mix = self._get(tid, "mix")
        if stem == "full":
            return mix
        if stem == "vocals":
            return self._get(tid, "vocals")
        key = (tid, stem)
        if key not in self.base:
            if library.has_vocals(tid) and _has_parts(tid):
                # The drums and the bass as Demucs separated them (next to
                # nothing of the voice in them) kept whole; the rest (keys,
                # guitars, pads: where a separated voice leaves its ghost)
                # pressed down hard wherever the voice was, and 3 dB under
                # them (a new voice fills the middle anyway).
                voc = self._get(tid, "vocals")
                rhythm = self._get(tid, "drums") + self._get(tid, "bass")
                inst = rhythm + 0.7 * _unvoice(mix - voc - rhythm, voc, floor=0.1)
            elif library.has_vocals(tid):
                voc = self._get(tid, "vocals")
                inst = _unvoice(mix - voc, voc)
            else:
                inst = mix
            if stem == "inst":
                self.base[key] = inst
            else:
                drums = self._get(tid, "drums")
                self.base[key] = (inst if stem == "inst-drums" else mix) - drums
        return self.base[key]

    def gain(self, tid: str, stem: str) -> float:
        """The linear gain that brings a song's stem to its reference level:
        a band by its loud parts (the 90th percentile of 400 ms RMS), a voice
        by its sung parts (the 75th percentile of its 400 ms RMS above
        silence)."""
        key = (tid, stem)
        if key not in self.levels:
            x = self.stem(tid, stem)
            env = dsp.envelope(x, int(0.4 * SR))
            if stem == "vocals":
                live = env[env > 10 ** (-50 / 20)]
                lvl = float(np.percentile(live, 75)) if len(live) else 0.0
                ref = VOICE_REF_DB
            else:
                lvl = float(np.percentile(env, 90)) if len(env) else 0.0
                ref = MUSIC_REF_DB
            self.levels[key] = float(np.clip(10 ** ((ref - _db(lvl)) / 20), 0.1, 8.0)) if lvl > 0 else 1.0
        return self.levels[key]


def _warp(x: np.ndarray, beats: np.ndarray, b: int, nb: int, r: float, semis: float, m: int, spb: float,
          formant: bool, work: Path, name: str) -> np.ndarray:
    """nb source beats from beat b, warped so source beat k lands on k / r
    common beats (spb s each), moved by `semis`. Returns exactly the m common
    beats from the clip's first beat."""
    t0, t1 = float(beats[b]), float(beats[b + nb])
    s0, s1 = max(0.0, t0 - MARGIN), min(len(x) / SR, t1 + MARGIN)
    i0, i1 = int(round(s0 * SR)), int(round(s1 * SR))
    seg = x[i0:i1]
    step = spb / r  # common seconds per source beat
    last = float(beats[b + nb] - beats[b + nb - 1])
    # Rubber Band keeps the lead-in before the first key frame at its own
    # length (measured with a click on every beat: a lead-in scaled by the
    # local ratio put every beat a constant margin x (1 - ratio) late), so the
    # lead-in maps one to one and the first beat lands right after it.
    out0 = int(round((t0 - s0) * SR))
    pairs = [(0, 0)]
    for k in range(nb + 1):
        pairs.append((int(round((float(beats[b + k]) - s0) * SR)), out0 + int(round(k * step * SR))))
    end_src = len(seg) - 1
    pairs.append((end_src, pairs[-1][1] + int(round((s1 - t1) * SR * step / last))))
    keep, seen = [], -1
    for s, d in pairs:
        if s > seen and (not keep or d > keep[-1][1]):
            keep.append((s, d))
            seen = s
    src_path, dst_path, map_path = work / f"{name}.in.wav", work / f"{name}.out.wav", work / f"{name}.map"
    sf.write(str(src_path), seg, SR, subtype="FLOAT")
    map_path.write_text("".join(f"{s} {d}\n" for s, d in keep))
    ratio = (keep[-1][1] + 1) / (keep[-1][0] + 1)
    cmd = ["rubberband", "-q", "--fine", "-t", f"{ratio:.8f}", "-p", f"{semis:.4f}", "-M", str(map_path)]
    if formant:
        cmd.append("-F")
    subprocess.run(cmd + [str(src_path), str(dst_path)], check=True, capture_output=True, timeout=900)
    y, _ = sf.read(str(dst_path), dtype="float32", always_2d=True)
    for p in (src_path, dst_path, map_path):
        p.unlink(missing_ok=True)
    want = int(round(m * spb * SR))
    return _fit(y[out0:], want).astype(np.float32)


def _jobs(plan: dict) -> list[dict]:
    """Every warp the plan needs: its clips, and a bar of voice for each chop."""
    acoustic = plan["vibe"] == "acoustic"
    jobs = []
    for c in plan["clips"]:
        stem = c["stem"]
        if acoustic and c["role"] == "music" and _has_drums(c["src"]):
            stem = {"inst": "inst-drums", "full": "full-drums"}.get(stem, stem)
        jobs.append({**c, "stem": stem})
    for e in plan["events"]:
        if e["type"] == "chop":
            nb = int(round(4 * e["r"]))
            jobs.append({"src": e["src"], "stem": "vocals", "beat": e["beat"], "beats": nb, "r": e["r"],
                         "semis": e["semis"], "mbeats": 4, "chop": True})
    return jobs


def _has_drums(tid: str) -> bool:
    return (library.track_dir(tid) / "drums.mp3").exists()


def _has_parts(tid: str) -> bool:
    d = library.track_dir(tid)
    return (d / "drums.mp3").exists() and (d / "bass.mp3").exists()


def warp_all(plan: dict, srcs: Sources, feats: dict, work: Path, progress) -> list[np.ndarray]:
    jobs = _jobs(plan)
    spb = plan["spb"]
    # Stems are cut in this process (shared arrays), the warps run as Rubber
    # Band processes side by side.
    inputs = [srcs.stem(j["src"], j["stem"]) for j in jobs]
    out: list = [None] * len(jobs)
    done = 0
    with cf.ThreadPoolExecutor(max_workers=max(1, MASHUP_STRETCH_JOBS)) as ex:
        futs = {ex.submit(_warp, inputs[i], feats[j["src"]]["beats"], j["beat"], j["beats"], j["r"], j["semis"],
                          j["mbeats"], spb, j["stem"] in ("vocals", "full", "full-drums"), work, f"c{i}"): i
                for i, j in enumerate(jobs)}
        for fut in cf.as_completed(futs):
            out[futs[fut]] = fut.result()
            done += 1
            progress(done, len(jobs))
    return out, jobs


def _frame_of(beat: float, spb: float) -> int:
    return int(round(beat * spb * SR))


def _chop(bar: np.ndarray, n: int, beat: float) -> np.ndarray:
    """A vocal chop over n frames: the loudest half beat of a bar of voice,
    cut to sixteenths and played in a stuttering pattern."""
    half = int(beat / 2)
    slices = [bar[k * half:(k + 1) * half] for k in range(8) if (k + 1) * half <= len(bar)]
    if not slices:
        return np.zeros((n, 2), np.float32)
    piece = max(slices, key=dsp.rms)
    q = int(beat / 4)
    hit = piece[:q].copy()
    w = min(len(hit) // 4, int(0.003 * SR))
    if w:
        hit[:w] *= dsp.fade_in(w)[:, None]
        hit[-w:] *= dsp.fade_out(w)[:, None]
    out = np.zeros((n, 2), np.float32)
    for k in range(int(n / (beat / 4))):
        if CHOP[k % len(CHOP)]:
            a = int(round(k * beat / 4))
            m = min(len(hit), n - a)
            if m > 0:
                out[a:a + m] += hit[:m]
    return out


def _curve(points: list, at: float, n: int, spb: float, log: bool = False) -> np.ndarray:
    """An automation lane (points: [common beat, value]) over a clip of n
    frames starting at common beat `at`, one value per frame; flat beyond its
    points. Cutoffs glide evenly in octaves."""
    pts = sorted((float(b), float(v)) for b, v in points)
    xs = np.array([(b - at) * spb * SR for b, _ in pts])
    ys = np.array([np.log2(max(v, 1.0)) if log else v for _, v in pts])
    y = np.interp(np.arange(n, dtype=np.float64), xs, ys)
    return (2 ** y if log else y).astype(np.float32)


def _phrase_mask(y: np.ndarray, c0: int, c1: int, pre: int, post: int, beat: float) -> np.ndarray:
    """Where a voice clip may sound: its core (frames c0..c1), widened to the
    phrases it cuts into. Before c0 the voice comes in at the start of the
    phrase that runs into the core (after its last breath: QUIET_DB under the
    line for QUIET_S), the pickup taken whole; after c1 it goes out at the
    end of the phrase that runs out of it. Where the singer never breathes
    within the window, the cut goes to the deepest dip of the voice near the
    core's edge, cross-faded longer: between two syllables, never through one."""
    n = len(y)
    env = dsp.envelope(y, HOP)
    if len(env) == 0:
        return np.ones(n, np.float32)
    sm = np.convolve(env, np.ones(5, np.float32) / 5, mode="same")
    core = sm[max(0, c0 // HOP):max(1, c1 // HOP)]
    ref = np.percentile(core, 90) if len(core) else sm.max()
    db = 20 * np.log10(sm + 1e-9) - _db(ref)
    quiet = db < -QUIET_DB
    g = max(1, int(QUIET_S * SR / HOP))
    bh = beat / HOP
    mask = np.zeros(n, np.float32)
    # Pickup: back from the core's start to the start of its phrase.
    k0 = min(len(sm) - 1, c0 // HOP)
    lo = max(g, (c0 - pre) // HOP)
    onset = None
    for k in range(k0, lo - 1, -1):
        if quiet[k - g:k].all():
            onset = k
            break
    if onset is not None:
        start, fade, kind = onset * HOP - int(0.02 * SR), int(0.02 * SR), "phrase" if onset < k0 else "clean"
    else:
        w0, w1 = max(0, k0 - int(0.5 * bh)), min(len(sm), k0 + int(0.25 * bh) + 1)
        k = w0 + int(np.argmin(sm[w0:w1]))
        start, fade, kind = k * HOP - int(0.04 * SR), int(0.08 * SR), "dip"
    # Tail: on from the core's end to the end of its phrase.
    k1 = min(len(sm) - 1, c1 // HOP)
    hi = min(len(sm), (c1 + post) // HOP)
    end = None
    for k in range(k1, hi - g + 1):
        if quiet[k:k + g].all():
            end = k
            break
    if end is not None:
        stop, fout, tkind = end * HOP + int(0.05 * SR), int(0.05 * SR), "phrase" if end > k1 else "clean"
    else:
        w0, w1 = max(0, k1 - int(0.25 * bh)), min(len(sm), k1 + int(0.5 * bh) + 1)
        k = w0 + int(np.argmin(sm[w0:w1]))
        stop, fout, tkind = k * HOP + int(0.06 * SR), int(0.12 * SR), "dip"
    start = max(0, min(start, c1))
    stop = min(n, max(stop, start + fade + fout))
    mask[start:stop] = 1.0
    w = max(1, min(fade, stop - start))
    mask[start:start + w] *= dsp.fade_in(w)
    w = max(1, min(fout, stop - start))
    mask[stop - w:stop] *= dsp.fade_out(w)
    STATS.setdefault("edges", []).append({
        "pickup": kind, "pickup_ms": round((c0 - start) / SR * 1000),
        "tail": tkind, "tail_ms": round((stop - c1) / SR * 1000),
    })
    return mask


def _ride(music: np.ndarray, vox: list, n_all: int) -> np.ndarray:
    """A gain curve for the voices (one value per frame): over every 1.5 s
    where they sing, what brings the lead voices to RIDE_DB over the band,
    within -7..+5 dB, changing smoothly; where the band is all but silent (a
    breakdown) the voice is left as it is."""
    hop = int(0.1 * SR)
    raw = np.zeros((n_all, 2), np.float32)
    for at, y, _, _, lead2 in vox:
        if not lead2:
            raw[at:at + len(y)] += y
    m, v = dsp.envelope(music, hop), dsp.envelope(raw, hop)
    if not len(v):
        return np.ones(n_all, np.float32)
    k = np.ones(15) / 15
    m = np.sqrt(np.convolve(m.astype(np.float64) ** 2, k, mode="same"))
    v = np.sqrt(np.convolve(v.astype(np.float64) ** 2, k, mode="same"))
    mdb, vdb = 20 * np.log10(m + 1e-9), 20 * np.log10(v + 1e-9)
    g = np.clip(RIDE_DB - (vdb - mdb), -7.0, 5.0)
    g = np.where((vdb > -50) & (mdb > -40), g, 0.0)
    g = np.convolve(g, np.ones(10) / 10, mode="same")
    curve = np.repeat((10 ** (g / 20)).astype(np.float32), hop)
    if len(curve) < n_all:
        curve = np.concatenate([curve, np.full(n_all - len(curve), curve[-1] if len(curve) else 1.0, np.float32)])
    return curve[:n_all]


def mix(plan: dict, warped: list, jobs: list, feats: dict, srcs: Sources) -> np.ndarray:
    STATS.clear()
    spb = plan["spb"]
    beat = spb * SR
    end = _frame_of(plan["beats"], spb)
    n_all = end + int(TAIL * SR)
    music = np.zeros((n_all, 2), np.float32)
    voices = np.zeros((n_all, 2), np.float32)
    send = np.zeros((n_all, 2), np.float32)
    fx = np.zeros((n_all, 2), np.float32)
    vibe = plan["vibe"]
    vsend, msend = VOCAL_SEND.get(vibe, 0.12), MUSIC_SEND.get(vibe, 0.0)
    edge = int(0.008 * SR)
    chops, vox = [], []
    for y, c in zip(warped, jobs):
        if c.get("chop"):
            chops.append((c, y))
            continue
        y = y.copy()
        at = _frame_of(c["at"], spb)
        n = min(len(y), n_all - at)
        if n <= 0:
            continue
        y = y[:n]
        auto = c.get("auto") or {}
        if c.get("lead2"):
            y = dsp.filt(y, "highpass", 220.0)
        if auto.get("hp"):
            cut = _curve(auto["hp"], c["at"], n, spb, log=True)
            if cut.max() > 26.0:
                y = dsp.vary(y, "highpass", cut)
        if auto.get("lp"):
            cut = _curve(auto["lp"], c["at"], n, spb, log=True)
            if cut.min() < 17000.0:
                y = dsp.vary(y, "lowpass", cut)
        if auto.get("low"):
            low, high = dsp.split_low(y)
            y = low * _curve(auto["low"], c["at"], n, spb)[:, None] + high
        g = srcs.gain(c["src"], c["stem"]) * 10 ** (c.get("gain", 0.0) / 20)
        env = np.full(n, g, np.float32)
        if auto.get("gain"):
            env *= 10 ** (_curve(auto["gain"], c["at"], n, spb) / 20)
        if c["role"] == "vocals" and c.get("core"):
            c0 = _frame_of(c["core"][0] - c["at"], spb)
            c1 = _frame_of(c["core"][1] - c["at"], spb)
            env *= _phrase_mask(y, c0, c1, c0, n - c1, beat)
        else:
            # Clips meet on downbeats (a loop coming round, the next piece of a
            # band): the incoming one opens in 2 ms, keeping its kick's attack,
            # the outgoing one closes over 8.
            e_in, e_out = min(int(0.002 * SR), n // 4), min(edge, n // 4)
            if e_in:
                env[:e_in] *= dsp.fade_in(e_in)
            if e_out:
                env[-e_out:] *= dsp.fade_out(e_out)
        if vibe == "club" and c["role"] == "music":
            env *= dsp.pump(n, at, beat, depth=0.35)
        y *= env[:, None]
        s = c.get("send", vsend if c["role"] == "vocals" else msend)
        if c["role"] == "vocals":
            core = (at + _frame_of(c["core"][0] - c["at"], spb), at + _frame_of(c["core"][1] - c["at"], spb)) \
                if c.get("core") else (at, at + n)
            vox.append((at, y, core, s, c.get("lead2", False)))
        else:
            music[at:at + n] += y
            if s:
                send[at:at + n] += y * s

    # The rider: the voices kept about RIDE_DB over the band wherever they
    # sing, the way a mixer rides the vocal fader through a song.
    ride = _ride(music, vox, n_all)
    vox = [(at, y * ride[at:at + len(y)][:, None], core, s, lead2) for at, y, core, s, lead2 in vox]

    # Voices: where one sings its own line, another's pickup or tail steps back.
    cover = np.zeros(n_all, np.int16)
    for _, _, (a, b), _, lead2 in vox:
        if not lead2:
            cover[max(0, a):min(n_all, b)] += 1
    for at, y, (a, b), s, lead2 in vox:
        n = len(y)
        own = np.zeros(n, np.int16)
        own[max(0, a - at):max(0, min(n, b - at))] = 1
        others = cover[at:at + n] - (0 if lead2 else own)
        duck = np.where((others > 0) & (own == 0), 0.3, 1.0).astype(np.float32)
        duck = np.convolve(duck, np.ones(441, np.float32) / 441, mode="same")
        y = y * duck[:, None]
        voices[at:at + n] += y
        if s:
            send[at:at + n] += y * s

    # The band makes room for the voices: a few dB off its middle while they sing.
    venv = dsp.envelope(voices, HOP)
    if len(venv) and venv.max() > 0:
        lvl = dsp.follow(venv, 0.03, 0.35, SR / HOP)
        k = np.clip(lvl / (np.percentile(lvl[lvl > 0], 90) + 1e-9), 0, 1) if (lvl > 0).any() else lvl
        k = np.repeat(k, HOP)
        k = np.concatenate([k, np.zeros(n_all - len(k), np.float32)])[:n_all]
        mid = dsp.band(music, 900.0, 4000.0)
        music -= (1 - 10 ** (-3.5 / 20)) * k[:, None] * mid
    STATS["levels"] = []
    for s in plan.get("sections", []):
        a, b = _frame_of(s["beat"], spb), min(n_all, _frame_of(s["beat"] + s["beats"], spb))
        mv, vv = dsp.rms(music[a:b]), dsp.rms(voices[a:b])
        STATS["levels"].append({"label": s["label"], "music_db": round(_db(mv), 1),
                                "voice_db": round(_db(vv), 1) if vv > 1e-6 else None})

    chop_of = {(c["src"], c["beat"]): y for c, y in chops}
    fades = []
    for ev in plan["events"]:
        a = _frame_of(ev["at"], spb)
        b = min(n_all, _frame_of(ev["at"] + ev.get("beats", 0), spb))
        kind = ev["type"]
        if kind == "riser" and b > a:
            r = dsp.riser(b - a)
            # Swelling toward the music it leads into (the build itself is thinned).
            level = dsp.rms(music[b:b + int(2 * SR)]) or dsp.rms(music[max(0, a - (b - a)):a]) or 0.05
            fx[a:b] += r * level * 0.6
            send[a:b] += r * level * 0.15
        elif kind == "impact" and a < n_all:
            hit = dsp.impact()
            level = dsp.rms(music[a:a + int(0.5 * SR)]) or 0.05
            m = min(len(hit), n_all - a)
            fx[a:a + m] += hit[:m] * level * 2.5
            send[a:a + m] += hit[:m] * level * 1.0
        elif kind == "gap" and b > a:
            w = int(0.006 * SR)
            gate = dsp.ramp(b - a, [(0, 1.0), (w, 0.0), (b - a - w, 0.0), (b - a, 1.0)])[:, None]
            for bus in (music, voices, send):
                bus[a:b] *= gate
        elif kind == "echo" and b > a:
            if ev.get("seek"):
                # The line may end before the bar line or ring past it: the
                # throw is the last beat the voice sang, up to `seek` beats on.
                lo, hi = max(0, a - int(beat)), min(n_all, a + int(ev["seek"] * beat))
                env = dsp.envelope(voices[lo:hi], HOP)
                if len(env) and env.max() > 1e-4:
                    live = np.where(env > env.max() * 10 ** (-24 / 20))[0]
                    stop = min(n_all, lo + (int(live[-1]) + 1) * HOP)
                    a, b = max(0, stop - (b - a)), stop
            throw = voices[a:b].copy() if ev["role"] == "vocals" else music[a:b] + voices[a:b]
            rep = dsp.echo(throw, 0.75 * spb, 0.5, 6) * ev.get("level", 1.0)
            m = min(len(rep), n_all - a)
            fx[a:a + m] += rep[:m]
        elif kind == "chop" and b > a:
            bar = chop_of.get((ev["src"], ev["beat"]))
            if bar is not None:
                y = _chop(bar, b - a, beat) * srcs.gain(ev["src"], "vocals") * 0.9
                voices[a:b] += y
                send[a:b] += y * 0.3
        elif kind == "open" and b > a:
            music[a:b] = dsp.sweep(music[a:b], "lowpass", 700.0, 18000.0)
        elif kind == "roll" and b > a:
            src = (music + voices)[a:a + int(beat)].copy()
            y = dsp.roll(src, b - a, beat)
            music[a:b] = 0.0
            voices[a:b] = 0.0
            fx[a:b] += y
        elif kind == "gate" and b > a:
            g = dsp.gate(b - a, beat)[:, None]
            music[a:b] *= g
            voices[a:b] *= g
        elif kind == "brake" and b > a:
            y = dsp.brake((music + voices)[a:b].copy())
            music[a:b] = 0.0
            voices[a:b] = 0.0
            fx[a:b] += y
        elif kind == "spin" and b > a:
            before = (music + voices)[max(0, a - int(2 * beat)):a].copy()
            if len(before) > 16:
                y = dsp.spinback(before, b - a)
                music[a:b] = 0.0
                voices[a:b] = 0.0
                fx[a:b] += y
        elif kind == "wash" and b > a:
            # Everything thrown into the hall as it fades: the room swells.
            ramp = dsp.ramp(b - a, [(0, 0.0), (b - a, 1.0)])[:, None]
            send[a:b] += (music[a:b] + voices[a:b]) * ramp * 0.9
            fade = dsp.ramp(b - a, [(0, 1.0), ((b - a) // 2, 0.8), (b - a, 0.0)])[:, None]
            music[a:b] *= fade
            voices[a:b] *= fade
        elif kind == "fadeout":
            fades.append((a, b))

    out = music + voices + 0.7 * dsp.reverb(send, 3.2 if vibe == "slowed" else 2.4) + fx
    # The ending: the last bars fade, the tails ring out a moment and stop.
    stop = end + int(2.0 * SR)
    for a, b in fades:
        out[a:b] *= dsp.fade_out(b - a)[:, None]
        out[b:] = 0.0
        stop = b
    tail = int(1.5 * SR)
    stop = min(n_all, max(stop, end) + tail) if not fades else min(n_all, stop)
    out = out[:stop]
    k = min(len(out), int(0.05 * SR))
    out[-k:] *= dsp.fade_out(k)[:, None]
    return out


def shape(x: np.ndarray, vibe: str) -> np.ndarray:
    """The vibe over the whole mix."""
    if vibe == "club":
        low, _ = dsp.split_low(x, 110.0)
        high = x - dsp.filt(x, "lowpass", 8000.0)
        return x + 0.41 * low + 0.19 * high          # +3 dB of low end, +1.5 dB of air
    if vibe == "chill":
        y = dsp.filt(x, "lowpass", 7500.0)
        level = 20 * np.log10(dsp.rms(y) + 1e-9) - 30
        return y + dsp.crackle(len(y), level)
    if vibe == "acoustic":
        return x - 0.3 * (x - dsp.filt(x, "lowpass", 9000.0))  # the top softened, about -3 dB
    if vibe == "slowed":
        return dsp.filt(signal.resample_poly(x, 20, 17, axis=0).astype(np.float32), "lowpass", 11000.0)
    if vibe == "speedup":
        return signal.resample_poly(x, 50, 59, axis=0).astype(np.float32)
    return x


def master(x: np.ndarray) -> np.ndarray:
    gain = TARGET_LUFS - dsp.lufs(x)
    x = x * 10 ** (float(np.clip(gain, -20.0, 18.0)) / 20)
    # -2 dBFS: MP3 encoding overshoots the sample peaks (up to about 1 dB on dense mixes).
    return dsp.limit(x, -2.0)


def encode(x: np.ndarray, mid: str, plan: dict, work: Path) -> None:
    wav = work / "out.wav"
    sf.write(str(wav), x, SR, subtype="FLOAT")
    dst = store.audio_path(mid)
    tmp = dst.with_name(dst.name + ".part")
    title = " × ".join(s["title"] for s in plan["sources"])[:200]
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(wav), "-c:a", "libmp3lame", "-b:a", "192k",
                        "-f", "mp3", "-metadata", f"title={title}", "-metadata", "artist=Mash ∞ Loop", str(tmp)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg failed: {r.stderr[-300:]}")
    tmp.replace(dst)


def run(mid: str) -> bool:
    """Renders one mashup, its progress in its meta; True when done."""
    plan = library.read_json(store.plan_path(mid))
    if not plan:
        store.fail(mid, "Không đọc được kế hoạch của bài mashup")
        return False
    tmp_root = DATA_DIR / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"mashup-{mid}-", dir=tmp_root))

    def stage(name: str, p: float) -> None:
        store.update(mid, status="rendering", stage=name, progress=round(p, 3))

    try:
        stage("load", 0.03)
        feats = {s["id"]: T.load_features(s["id"]) for s in plan["sources"]}
        srcs = Sources()
        warped, jobs = warp_all(plan, srcs, feats, work, lambda k, n: stage("stretch", 0.05 + 0.65 * k / n))
        stage("mix", 0.72)
        out = mix(plan, warped, jobs, feats, srcs)
        del warped, srcs
        stage("master", 0.88)
        out = master(shape(out, plan["vibe"]))
        stage("encode", 0.95)
        encode(out, mid, plan, work)
        store.done(mid, len(out) / SR)
        return True
    except Exception:
        traceback.print_exc()
        store.fail(mid, "Có lỗi khi dựng bài mashup, thử lại hoặc chọn bài khác")
        return False
    finally:
        shutil.rmtree(work, ignore_errors=True)

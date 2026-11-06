"""Objective check of in-song jumps: python tools/eval_splices.py [id ...]

For every jump (after beat i play beat j) the spliced audio is rendered with
a 12 ms crossfade under the player's fade law for that jump (equal power, or
toward equal gain as its two sides correlate) and compared with what would
have played naturally:
  mismatch  mean |log-mel difference| (dB) over 350 ms after the junction,
            relative to the same measure for random same-bar-position pairs
            (1.0 = no better than a random jump, 0 = identical to the original)
  click     spectral-flux spike at the junction beyond what the natural
            audio has there (0 = no extra transient)
It also reports how much the onset alignment shift improves the mismatch."""
import sys
from pathlib import Path

import librosa
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from loopbox import audio, library  # noqa: E402
from loopbox.analysis import features  # noqa: E402

SR = 22050
XF = float(__import__("os").environ.get("LOOPBOX_XF", "0.012"))
POST = 0.35
PRE = 0.15


def logmel(x):
    m = librosa.feature.melspectrogram(y=x, sr=SR, n_fft=1024, hop_length=128, n_mels=64)
    return librosa.power_to_db(m, ref=1.0, top_db=None)


def law(rho, t):
    """The player's fade-in gain at t in [0, 1] for a splice whose sides
    correlate by rho (engine.js fadeLaw); the fade-out is law(rho, 1 - t)."""
    r = round(min(1.0, max(0.0, rho)) * 20) / 20
    if r == 0:
        return np.sin(0.5 * np.pi * t)
    v = 2 * t - 1
    return (np.sqrt((2 - (1 - r) * v * v) / (1 + r)) + v) / 2


def splice(y, s, d, rho=0.0):
    """Audio heard when playback leaves y at time s and resumes at time d."""
    n_pre, n_post, n_xf = int(PRE * SR), int(POST * SR), int(XF * SR)
    si, di = int(round(s * SR)), int(round(d * SR))
    if si - n_pre - n_xf < 0 or di + n_post + n_xf > len(y) or si + n_post > len(y) or di - n_xf < 0:
        return None, None
    ramp = np.linspace(0, 1, n_xf)
    head = y[si - n_pre - n_xf // 2: si + n_xf // 2].copy()
    tail = y[di - n_xf // 2: di + n_post].copy()
    head[-n_xf:] *= law(rho, 1 - ramp)
    tail[:n_xf] *= law(rho, ramp)
    spliced = np.concatenate([head[:-n_xf], head[-n_xf:] + tail[:n_xf], tail[n_xf:]])
    start = si - n_pre - n_xf // 2
    return spliced, y[start:start + len(spliced)]


def measure(y, s, d, rho=0.0):
    sp, nat = splice(y, s, d, rho)
    if sp is None:
        return None
    A, B = logmel(sp), logmel(nat)
    j = int(PRE * SR / 128)
    post = slice(j, A.shape[1])
    mismatch = float(np.mean(np.abs(A[:, post] - B[:, post])))
    fa = np.maximum(0, np.diff(A, axis=1)).sum(0)
    fb = np.maximum(0, np.diff(B, axis=1)).sum(0)
    w = slice(max(0, j - 3), j + 3)
    click = float(max(0.0, fa[w].max() - fb[w].max()) / (np.median(fb) + 1e-6))
    return mismatch, click


def evaluate(tid, rng):
    a = library.read_json(library.analysis_path(tid))
    y = features.mono22(audio.load(library.audio_path(tid)))
    beats = np.array(a["beats"])
    pos = np.array(a["pos"])
    n = len(beats)
    end = lambda i: beats[i + 1] if i + 1 < n else beats[i] + np.median(np.diff(beats))  # noqa: E731

    base = []
    for _ in range(80):
        i = int(rng.integers(8, n - 9))
        cands = np.where((pos == pos[i + 1]) & (np.abs(np.arange(n) - i) > 16))[0]
        if len(cands):
            m = measure(y, end(i), beats[int(rng.choice(cands))])
            if m:
                base.append(m[0])
    base = float(np.median(base))

    rows = []
    for i, j, score, shift_ms, *rest in a["jumps"]:
        rho = rest[2] if len(rest) > 2 else 0.0
        m = measure(y, end(i), beats[j] + shift_ms / 1000, rho)
        m0 = measure(y, end(i), beats[j], rho) if shift_ms else m
        if m and m0:
            rows.append((score, m[0] / base, m[1], m0[0] / base, shift_ms))
    r = np.array(rows)
    print(f"== {tid}  {a['title'][:55]}")
    print(f"   random-jump baseline mismatch {base:.2f} dB; jumps evaluated {len(r)}")
    for lo, hi in ((0, 0.15), (0.15, 0.25), (0.25, 0.35), (0.35, 0.7)):
        sel = (r[:, 0] >= lo) & (r[:, 0] < hi)
        if sel.any():
            print(f"   score {lo:.2f}-{hi:.2f}: n={sel.sum():3d}  mismatch median {np.median(r[sel, 1]):.2f}"
                  f"  p90 {np.percentile(r[sel, 1], 90):.2f}   click median {np.median(r[sel, 2]):.2f} p90 {np.percentile(r[sel, 2], 90):.2f}")
    sh = r[:, 4] != 0
    if sh.any():
        print(f"   alignment shift on {sh.sum()} jumps: mismatch {np.median(r[sh, 3]):.3f} -> {np.median(r[sh, 1]):.3f}"
              f" (improved {np.mean(r[sh, 1] < r[sh, 3]):.0%})")
    print(f"   corr(score, mismatch) = {np.corrcoef(r[:, 0], r[:, 1])[0, 1]:.2f}")
    return r


if __name__ == "__main__":
    rng = np.random.default_rng(0)
    for tid in sys.argv[1:] or library.ready_ids():
        evaluate(tid, rng)

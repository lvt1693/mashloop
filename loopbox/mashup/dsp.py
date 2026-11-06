"""Offline DSP for the mashup renderer (numpy and scipy): filters and their
sweeps, a bass split, gain curves, a hall reverb, band-limited echoes,
sidechain pumping, synthesised risers and impacts, vinyl crackle, loudness
and a peak limiter. Audio is float32 shaped (frames, 2) at SAMPLE_RATE."""
import numpy as np
from scipy import signal
from scipy.ndimage import maximum_filter1d

from ..config import SAMPLE_RATE as SR


def sos(kind: str, freq: float, order: int = 2):
    return signal.butter(order, min(max(freq, 10.0), SR * 0.45), btype=kind, fs=SR, output="sos")


def filt(x: np.ndarray, kind: str, freq: float, order: int = 2) -> np.ndarray:
    return signal.sosfilt(sos(kind, freq, order), x, axis=0).astype(np.float32)


def sweep(x: np.ndarray, kind: str, f0: float, f1: float, block: int = 512) -> np.ndarray:
    """A filter whose cutoff glides (evenly in octaves) from f0 to f1 across x,
    its state carried from block to block."""
    n = len(x)
    if n == 0:
        return x
    out = np.empty_like(x)
    zi = np.zeros((1, 2, x.shape[1]))
    for s in range(0, n, block):
        e = min(n, s + block)
        f = f0 * (f1 / f0) ** (((s + e) / 2) / n)
        y, zi = signal.sosfilt(sos(kind, f), x[s:e], axis=0, zi=zi)
        out[s:e] = y
    return out


def vary(x: np.ndarray, kind: str, cut: np.ndarray, block: int = 512) -> np.ndarray:
    """A filter whose cutoff follows `cut` (Hz per frame), its state carried
    from block to block."""
    n = len(x)
    out = np.empty_like(x)
    zi = np.zeros((1, 2, x.shape[1]))
    for s in range(0, n, block):
        e = min(n, s + block)
        y, zi = signal.sosfilt(sos(kind, float(cut[(s + e) // 2 if (s + e) // 2 < n else n - 1])), x[s:e], axis=0, zi=zi)
        out[s:e] = y
    return out


def band(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return filt(filt(x, "highpass", lo), "lowpass", hi)


def envelope(x: np.ndarray, hop: int) -> np.ndarray:
    """RMS per hop frames (mono), one value per hop."""
    m = x.mean(1) if x.ndim == 2 else x
    k = len(m) // hop
    if k == 0:
        return np.zeros(0, np.float32)
    return np.sqrt((m[:k * hop].astype(np.float64) ** 2).reshape(k, hop).mean(1)).astype(np.float32)


def follow(env: np.ndarray, attack: float, release: float, rate: float) -> np.ndarray:
    """A level follower over an envelope (one value per frame at `rate`)."""
    a = np.exp(-1.0 / max(1e-6, attack * rate))
    r = np.exp(-1.0 / max(1e-6, release * rate))
    out = np.empty_like(env)
    v = 0.0
    for i, x in enumerate(env):
        c = a if x > v else r
        v = c * v + (1 - c) * x
        out[i] = v
    return out


def roll(src: np.ndarray, n: int, beat: float) -> np.ndarray:
    """A loop roll over n frames from one beat of audio: repeated as half
    beats, then quarters, then eighths, opening up as it tightens."""
    out = np.zeros((n, 2), np.float32)
    marks = [(0.0, 0.5), (0.5, 0.25), (0.75, 0.125)]  # (from, slice length in beats) over the span
    for k, (f0, sl) in enumerate(marks):
        a = int(f0 * n)
        b = int(marks[k + 1][0] * n) if k + 1 < len(marks) else n
        size = max(64, int(sl * beat))
        piece = src[:size].copy()
        w = min(64, size // 8)
        piece[:w] *= fade_in(w)[:, None]
        piece[-w:] *= fade_out(w)[:, None]
        for s in range(a, b, size):
            m = min(size, b - s)
            out[s:s + m] += piece[:m]
    return sweep(out, "highpass", 30.0, 1500.0)


def brake(x: np.ndarray) -> np.ndarray:
    """A turntable brake over x: the platter slows to a stop (speed falling
    to nothing), the pitch with it."""
    n = len(x)
    t = np.linspace(0, 1, n)
    speed = (1 - t) ** 1.6
    pos = np.cumsum(speed)
    pos = pos / pos[-1] * (n * 0.45)
    i0 = np.clip(pos.astype(int), 0, n - 2)
    fr = (pos - i0)[:, None]
    y = x[i0] * (1 - fr) + x[i0 + 1] * fr
    return (y * fade_out(n)[:, None] ** 0.5).astype(np.float32)


def spinback(before: np.ndarray, n: int) -> np.ndarray:
    """A spinback over n frames: what just played, run backwards, fast and
    accelerating, fading out."""
    m = len(before)
    t = np.linspace(0, 1, n)
    speed = 1.5 + 3.5 * t ** 1.5
    pos = m - 1 - np.cumsum(speed)
    pos = np.clip(pos, 0, m - 2)
    i0 = pos.astype(int)
    fr = (pos - i0)[:, None]
    y = before[i0] * (1 - fr) + before[i0 + 1] * fr
    y = filt(y, "highpass", 200.0)
    return (y * fade_out(n)[:, None]).astype(np.float32)


def gate(n: int, beat: float, pattern=(1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1)) -> np.ndarray:
    """A trance gate in sixteenths, softened at each edge."""
    six = beat / 4
    g = np.zeros(n, np.float32)
    for k in range(int(np.ceil(n / six))):
        if pattern[k % len(pattern)]:
            a, b = int(k * six), min(n, int((k + 1) * six))
            g[a:b] = 1.0
    w = max(1, int(0.004 * 44100))
    kern = np.ones(w, np.float32) / w
    return np.convolve(g, kern, mode="same").astype(np.float32)


def split_low(x: np.ndarray, freq: float = 200.0) -> tuple[np.ndarray, np.ndarray]:
    """Bass below freq (a 4th-order Linkwitz-Riley low-pass) and the rest
    (the remainder, so the two always add back to x)."""
    low = filt(filt(x, "lowpass", freq), "lowpass", freq)
    return low, x - low


def ramp(n: int, points: list[tuple[int, float]]) -> np.ndarray:
    """A gain curve over n frames through (frame, gain) points, flat beyond them."""
    if not points:
        return np.ones(n, np.float32)
    fr, g = zip(*sorted(points))
    return np.interp(np.arange(n), fr, g).astype(np.float32)


def fade_in(n: int) -> np.ndarray:
    return np.sin(0.5 * np.pi * np.linspace(0, 1, max(1, n), dtype=np.float32))


def fade_out(n: int) -> np.ndarray:
    return np.cos(0.5 * np.pi * np.linspace(0, 1, max(1, n), dtype=np.float32))


_IR = {}


def hall_ir(seconds: float = 2.4, predelay: float = 0.02) -> np.ndarray:
    """Stereo decaying noise, darker as it fades (a hall), unit energy per channel."""
    if seconds in _IR:
        return _IR[seconds]
    rng = np.random.default_rng(7)
    n = int(seconds * SR)
    t = np.arange(n, dtype=np.float32) / SR
    ir = rng.standard_normal((n, 2)).astype(np.float32) * np.exp(-6.9 * t / seconds)[:, None]
    dark = filt(ir, "lowpass", 3200)
    k = np.clip(1.6 * t / seconds, 0, 1)[:, None]
    ir = filt(ir * (1 - k) + dark * k, "highpass", 250)
    ir = np.concatenate([np.zeros((int(predelay * SR), 2), np.float32), ir])
    ir /= np.sqrt((ir ** 2).sum(0, keepdims=True)) + 1e-9
    _IR[seconds] = ir
    return ir


def reverb(x: np.ndarray, seconds: float = 2.4) -> np.ndarray:
    """x through the hall, as long as x (give x room for the tail)."""
    ir = hall_ir(seconds)
    out = np.stack([signal.oaconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1)
    return out.astype(np.float32)


def echo(throw: np.ndarray, delay_s: float, feedback: float = 0.5, repeats: int = 6) -> np.ndarray:
    """The repeats of a throw (a beat of a voice), each darker and thinner,
    from the throw's own start (the throw itself is not in it)."""
    d = int(round(delay_s * SR))
    out = np.zeros((len(throw) + repeats * d, 2), np.float32)
    y = throw
    for k in range(1, repeats + 1):
        y = filt(filt(y, "highpass", 350), "lowpass", 4200) * feedback
        out[k * d:k * d + len(y)] += y
    return out


def pump(n: int, start: int, beat: float, depth: float = 0.4, release: float = 0.55) -> np.ndarray:
    """A sidechain duck on every beat of the common grid (as a four-on-the-
    floor kick would): down by `depth` on the beat, back over `release` of it.
    `start`: the frame of the grid the curve begins at."""
    phase = ((np.arange(n) + start) / beat) % 1.0
    x = np.clip(phase / release, 0, 1)
    return (1 - depth * (1 - x * x * (3 - 2 * x))).astype(np.float32)


def riser(n: int) -> np.ndarray:
    """A build-up: noise sweeping up through the spectrum and swelling to the
    downbeat, unit RMS over its last tenth."""
    rng = np.random.default_rng(11)
    x = rng.standard_normal((n, 2)).astype(np.float32) * 0.3
    y = sweep(sweep(x, "highpass", 250, 5000), "lowpass", 1200, 15000)
    y *= (np.linspace(0, 1, n, dtype=np.float32) ** 2.2)[:, None]
    tail = y[-max(1, n // 10):]
    return y / (np.sqrt((tail ** 2).mean()) + 1e-9)


def impact(seconds: float = 1.6) -> np.ndarray:
    """A hit on the downbeat: a sub falling from 90 to 38 Hz and a short burst
    of noise, peak 1."""
    n = int(seconds * SR)
    t = np.arange(n, dtype=np.float32) / SR
    f = 38 + 52 * np.exp(-t / 0.18)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.4)
    rng = np.random.default_rng(5)
    burst = filt(rng.standard_normal((n, 2)).astype(np.float32), "lowpass", 2600) * np.exp(-t / 0.07)[:, None]
    y = 0.85 * sub[:, None] + 0.3 * burst
    return (y / (np.abs(y).max() + 1e-9)).astype(np.float32)


def crackle(n: int, level_db: float = -40.0) -> np.ndarray:
    """Vinyl: sparse clicks and a little hiss."""
    rng = np.random.default_rng(3)
    clicks = (rng.random((n, 2)) < 0.0003) * rng.standard_normal((n, 2))
    hiss = rng.standard_normal((n, 2)) * 0.05
    y = filt(filt((clicks + hiss).astype(np.float32), "highpass", 900), "lowpass", 7000)
    return y * (10 ** (level_db / 20) / (np.sqrt((y ** 2).mean()) + 1e-9))


def rms(x: np.ndarray) -> float:
    return float(np.sqrt((x.astype(np.float64) ** 2).mean())) if len(x) else 0.0


def lufs(x: np.ndarray) -> float:
    import pyloudnorm
    return float(pyloudnorm.Meter(SR).integrated_loudness(x.astype(np.float64)))


def limit(x: np.ndarray, ceiling_db: float = -1.0, lookahead: float = 0.005, release: float = 0.08) -> np.ndarray:
    """A peak limiter: the gain comes down ahead of a peak (lookahead) and goes
    back up over `release`; nothing passes the ceiling."""
    c = 10 ** (ceiling_db / 20)
    la = max(1, int(lookahead * SR))
    peak = maximum_filter1d(np.abs(x).max(1), size=2 * la + 1)
    red = 1.0 - np.minimum(1.0, c / np.maximum(peak, 1e-9))
    a = np.exp(-1.0 / (release * SR))
    held = signal.lfilter([1 - a], [1, -a], red)
    g = (1.0 - np.maximum(red, held)).astype(np.float32)
    return np.clip(x * g[:, None], -c, c)

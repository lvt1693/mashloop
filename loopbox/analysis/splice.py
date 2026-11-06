"""A splice looked at sample by sample, the way an editor zooms in on the
waveform before committing a cut. For a jump (after beat x - 1, play beat y),
against what would naturally have played from beat x:

  snap   the destination nudged by up to SNAP_S so its waveform lines up with
         the natural one. The onset grid gets within a few ms, and a bass note
         3 ms out of phase dips in the crossfade. Taken only where the two
         waveforms truly match (a copied section), else the onset alignment
         stands.
  rho    the correlation of the two signals across the crossfade, which sets
         the fade law (engine.js fadeLaw): equal power for unrelated audio,
         equal gain for the same audio (Fink, Holters & Zölzer 2016). Equal
         power over identical audio swells by 3 dB in the middle of the fade.
  same   how identical the bar after the junction is to the bar that would
         have played. A section pasted in the DAW, as most pop is produced, is
         the one splice nobody can hear, whatever came before it. Read on the
         waveform as it is and once more with its highs lifted (the first
         difference, +6 dB an octave), the lower of the two: the kick and the
         bass carry most of a mix's energy, and two bars that share them but
         not their voice or hats still correlate 0.85 on the waveform alone
         (measured on 40 songs: such jumps were no better than the rest; with
         the highs lifted, those from 0.75 are)."""
import numpy as np

SNAP_S = 0.003
NEAR_S = (0.010, 0.040)    # what the snap compares: 10 ms before the junction, 40 ms after
SNAP_MIN = 0.6             # waveform correlation from which a snap is trusted
MIN_XF_S = 0.010           # rho is measured over at least this much
QUIET_DB = 40.0            # a bar this far under the song's loudest is not compared


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = float(np.sqrt((a @ a) * (b @ b)))
    return float(a @ b) / d if d > 1e-12 else 0.0


def _snap(y: np.ndarray, i0: int, j0: int, pre: int, post: int, k: int) -> tuple[int, float, float]:
    """Lag (samples, within +-k) that best lines y[j0 + lag ...] up with
    y[i0 ...] over [-pre, post), its normalised correlation, and that at 0."""
    ref = y[i0 - pre:i0 + post].astype(np.float64)
    ref = ref - ref.mean()
    seg = y[j0 - pre - k:j0 + post + k].astype(np.float64)
    L = len(ref)
    num = np.correlate(seg, ref, mode="valid")               # 2k + 1 lags
    c1 = np.r_[0.0, np.cumsum(seg)]
    c2 = np.r_[0.0, np.cumsum(seg * seg)]
    s1 = c1[L:] - c1[:-L]
    s2 = c2[L:] - c2[:-L]
    var = np.maximum(s2 - s1 * s1 / L, 0.0)
    den = np.sqrt((ref @ ref) * var)
    ncc = np.where(den > 1e-12, num / np.maximum(den, 1e-12), 0.0)
    best = int(np.argmax(ncc))
    return best - k, float(ncc[best]), float(ncc[k])


def look(y: np.ndarray, sr: float, t_nat: float, t_in: float, xf: float, bar: float, floor: float) -> tuple[float, float, float]:
    """(snap seconds, rho, same) for a splice from the natural position t_nat
    to t_in (onset-aligned already) in the mono signal y. `floor` is the
    mean square under which a bar counts as too quiet to compare."""
    pre, post, k = int(NEAR_S[0] * sr), int(NEAR_S[1] * sr), int(SNAP_S * sr)
    n_bar = int(bar * sr)
    i0, j0 = int(round(t_nat * sr)), int(round(t_in * sr))
    reach = max(post + k, n_bar + k)
    if min(i0, j0) - pre - k < 0 or max(i0, j0) + reach > len(y):
        return 0.0, 0.0, 0.0
    lag, best, at0 = _snap(y, i0, j0, pre, post, k)
    if best < SNAP_MIN or best - at0 < 0.02:
        lag = 0
    j = j0 + lag
    h = max(int(max(xf, MIN_XF_S) * sr / 2), 8)
    rho = max(0.0, _ncc(y[i0 - h:i0 + h], y[j - h:j + h]))
    a, b = y[i0:i0 + n_bar], y[j:j + n_bar]
    same = 0.0
    if float(np.mean(a.astype(np.float64) ** 2)) > floor and float(np.mean(b.astype(np.float64) ** 2)) > floor:
        same = max(0.0, min(_ncc(a, b), _ncc(np.diff(a), np.diff(b))))
    return lag / sr, rho, same


def quiet_floor(y: np.ndarray, sr: float) -> float:
    """Mean square QUIET_DB under the loudest second of the song."""
    n = int(sr)
    if len(y) < n:
        return 0.0
    ms = np.mean(y[:len(y) // n * n].astype(np.float64).reshape(-1, n) ** 2, axis=1)
    return float(ms.max()) * 10 ** (-QUIET_DB / 10)

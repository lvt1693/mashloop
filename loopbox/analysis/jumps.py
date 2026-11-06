"""In-song jump candidates.

An edge (i -> j) means "after beat i, play beat j instead of i + 1". It is good
when the music around i + 1 (the natural successor) matches the music around j:
the listener hears j's lead-in as i's and j's continuation as i + 1's.

With the song's audio at hand, the likeliest edges are also looked at sample
by sample (splice.py): where the bar after the junction is the very bar that
would have played (a section pasted in production), the jump is inaudible
whatever its features say, and it is rewarded, so a song gets more ways
around it that do not break."""
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from ..config import ANALYSIS_SR
from . import similarity as sim
from . import splice

MIN_GAP_BARS = 4     # shorter loops are seamless but make the walk feel stuck
TAU_GOOD = 0.5       # keep everything up to here; the player filters by strictness
TAU_MAX = 0.62       # never go above this, even for songs with few repeats
MAX_PER_SOURCE = 2
MAX_PER_DEST = 3
POOL = 4             # edges looked at sample by sample: this many per beat, the likeliest first
SAME_FROM = 0.75     # "same" (splice.py) from which a jump counts as a pasted section ...
SAME_BONUS = 0.2     # ... and comes off its score by up to this much, at 1.0
# (40 songs: kept jumps with same 0.75-0.9 mismatch 0.21 and from 0.95 0.10,
# the rest 0.36; the jumps the bonus brought in replaced worse ones, at 0.19.)


def _select(S: np.ndarray, n: int) -> list[tuple[int, int, float]]:
    flat = np.argsort(S, axis=None)
    vals = S.ravel()[flat]
    finite = np.isfinite(vals) & (vals <= TAU_MAX)
    flat, vals = flat[finite], vals[finite]
    min_edges = max(8, n // 12)
    max_edges = int(n * 0.6)
    per_src: dict[int, int] = {}
    per_dst: dict[int, int] = {}
    out = []
    for f, v in zip(flat, vals):
        if len(out) >= max_edges or (v > TAU_GOOD and len(out) >= min_edges):
            break
        x, y = divmod(int(f), S.shape[1])
        if per_src.get(x, 0) >= MAX_PER_SOURCE or per_dst.get(y, 0) >= MAX_PER_DEST:
            continue
        per_src[x] = per_src.get(x, 0) + 1
        per_dst[y] = per_dst.get(y, 0) + 1
        out.append((x, y, float(v)))
    return out


def _last_branch_point(edges: list[tuple[int, int, float]]) -> int:
    back = [x - 1 for x, y, _ in edges if y < x]
    return max(back) if back else -1


def _component_of(n: int, edges: list[tuple[int, int, float]], node: int) -> np.ndarray:
    """Beats in the same strongly connected component as `node`, following
    playback order plus the jumps (edge (x, y): after beat x - 1 play y)."""
    rows = list(range(n - 1)) + [x - 1 for x, _, _ in edges]
    cols = list(range(1, n)) + [y for _, y, _ in edges]
    g = csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n))
    _, labels = connected_components(g, directed=True, connection="strong")
    return np.where(labels == labels[node])[0]


def _bridge_traps(level: list, valid: np.ndarray, E: np.ndarray, n: int, lbp: int, target: int) -> list:
    """The forced jump at the last branch point can land in a stretch of music
    whose own jumps never lead further back: the walk would then circle the
    song's ending forever. Add the best jump out of such a trap (whatever its
    score) until the loop reaches back to `target`, the earliest re-entry point."""
    bridges = []
    for _ in range(12):
        edges = level + bridges
        comp = _component_of(n, edges, lbp)
        if comp.min() <= target:
            break
        src_in = np.zeros(n, dtype=bool)
        src_in[comp] = True
        X = np.arange(n)[:, None]
        Y = np.arange(n)[None, :]
        mask = valid & (Y < comp.min()) & np.roll(src_in, 1)[:, None] & (X >= 1)
        cand = np.where(mask, E, np.inf)
        if not np.isfinite(cand).any():
            break
        x, y = divmod(int(np.argmin(cand)), n)
        bridges.append((x, y, float(cand[x, y])))
    return bridges


def bar_in_phrase(pos: np.ndarray, phrase: np.ndarray) -> np.ndarray:
    """Bar index inside its 4-bar phrase (counted from the last section start),
    or -1 before the first downbeat."""
    out = np.full(len(pos), -1, dtype=np.int64)
    bar = -1
    for b in range(len(pos)):
        if phrase[b] == 3:          # section start
            bar = 0
        elif pos[b] == 0 and bar >= 0:
            bar += 1
        out[b] = bar % 4 if bar >= 0 else -1
    return out


def placement_penalty(pos: np.ndarray, phrase: np.ndarray, vocal: np.ndarray, voice_diff: np.ndarray) -> np.ndarray:
    """Where in the music a jump happens. For a junction at natural successor
    x and destination y:
      - cutting into a sung line on both sides swaps the lyric mid-sentence,
        unless the two lines are the same (a repeated chorus): scaled by how
        different the voice is around the junction (voice_diff, 1 = as
        different as two random sung beats); worse off the downbeat, where a
        held note gets chopped;
      - landing at a different bar of the 4-bar phrase breaks the phrasing
        the listener is counting (2 bars off is milder than 1 or 3);
      - off-downbeat junctions are slightly suspect in any case."""
    sing = np.maximum(vocal, np.r_[0.0, vocal[:-1]])  # sung at the junction beat or just before
    line = np.minimum(sing[:, None], sing[None, :])
    off_bar = (pos != 0)[:, None]
    differs = np.clip(np.nan_to_num(voice_diff, nan=1.0, posinf=1.5), 0.0, 1.5)
    pen = 0.16 * line * differs * np.where(off_bar, 1.6, 1.0) + 0.03 * off_bar
    bip = bar_in_phrase(pos, phrase)
    known = (bip[:, None] >= 0) & (bip[None, :] >= 0)
    d = np.abs(bip[:, None] - bip[None, :])
    pen += np.where(known & (d == 2), 0.05, 0.0) + np.where(known & (d % 2 == 1), 0.10, 0.0)
    both_phrase = (phrase[:, None] >= 2) & (phrase[None, :] >= 2)
    pen -= 0.03 * both_phrase
    return pen


def find(feat: dict, pos: np.ndarray, meter: int, scales: tuple, beats: np.ndarray,
         onset_env: np.ndarray, onset_rate: float, phrase: np.ndarray, y22: np.ndarray | None = None) -> dict:
    """y22: the song as mono at ANALYSIS_SR, for the sample-level look at the
    splices (without it, onset alignment only and the equal-power law)."""
    n = len(pos)
    mu, sd, comp_scales = scales
    comps, gate = sim.components(feat, feat, mu, sd)
    P = sim.combine(comps, comp_scales, gate)
    E = sim.window(P)

    X = np.arange(n)[:, None]
    Y = np.arange(n)[None, :]
    audible = feat["loud"] > feat["loud"].max() - 35
    valid = (
        (pos[:, None] == pos[None, :]) & (pos[:, None] >= 0)
        & (np.abs(X - Y) >= MIN_GAP_BARS * meter)
        & audible[:, None] & audible[None, :]
        & (X >= 1)
    )
    # The beats right at the junction must match on their own too, so a good
    # average cannot hide one clashing beat.
    Pm1 = np.full_like(P, np.inf)
    Pm1[1:, 1:] = P[:-1, :-1]
    J = np.maximum(P, Pm1)
    voice_diff = sim.window(comps[sim.VOICE] / comp_scales[sim.VOICE])
    with np.errstate(invalid="ignore"):
        S = E + 0.3 * np.maximum(0.0, J - E) + placement_penalty(pos, phrase, feat["vocal"], voice_diff)
    # Near the song's edges E is inf and inf - inf is NaN: those are simply unusable.
    S = np.where(valid & np.isfinite(S), np.maximum(S, 0.0), np.inf)

    ibi = float(np.median(np.diff(beats))) if n > 1 else 0.5
    dp = sim.drum_presence(feat)
    floor = splice.quiet_floor(y22, ANALYSIS_SR) if y22 is not None else 0.0
    looks: dict[tuple[int, int], tuple[float, float, float, float]] = {}

    def at(x: int, y: int) -> tuple[float, float, float, float]:
        """(shift s, rho, same, crossfade ms) of edge (x, y), measured once."""
        if (x, y) not in looks:
            shift, _ = sim.align_offset(onset_env, beats[x], onset_env, beats[y], onset_rate, ibi)
            xf = sim.crossfade_ms(max(dp[x - 1], dp[x]), max(dp[y - 1], dp[y]))
            snap, rho, same = (splice.look(y22, ANALYSIS_SR, beats[x], beats[y] + shift, xf / 1000, meter * ibi, floor)
                               if y22 is not None else (0.0, 0.0, 0.0))
            looks[(x, y)] = (shift + snap, rho, same, xf)
        return looks[(x, y)]

    if y22 is not None:
        fin = np.isfinite(S)
        k = min(POOL * n, int(fin.sum()))
        for f in (np.argpartition(np.where(fin, S, np.inf), k - 1, axis=None)[:k] if k else []):
            x, y = divmod(int(f), n)
            same = at(x, y)[2]
            if same > SAME_FROM:
                S[x, y] = max(0.0, S[x, y] - SAME_BONUS * (same - SAME_FROM) / (1 - SAME_FROM))

    chosen = _select(S, n)
    fallback = False
    lbp = _last_branch_point(chosen)
    if lbp < 0:
        # No repetition good enough: take the best backward jump at any score so
        # the song can still loop forever.
        Sb = np.where(valid & (Y < X), S, np.inf)
        if np.isfinite(Sb).any():
            f = int(np.argmin(Sb))
            x, y = divmod(f, n)
            chosen.append((x, y, float(Sb[x, y])))
            fallback = True
            lbp = x - 1
    # Destinations past the last backward jump lead to the end with no way back.
    chosen = [(x, y, s) for x, y, s in chosen if y <= lbp]

    # The player only takes jumps under the listener's strictness setting, plus
    # every jump at the last branch point. Make sure that at each setting the
    # walk can still get back to the earliest re-entry point of the song.
    bridges: list = []
    if lbp >= 0:
        target = min(y for x, y, _ in chosen if y < x)
        for tau in (0.15, 0.25, 0.35, 0.45, TAU_MAX):
            level = [e for e in chosen if e[2] <= tau or e[0] - 1 == lbp]
            bridges += _bridge_traps(level + bridges, valid, S, n, lbp, target)
    edges = {(x, y): (s, 0) for x, y, s in chosen}
    for x, y, s in bridges:
        edges[(x, y)] = (s, 1)

    jumps, pasted = [], 0
    for (x, y), (s, is_bridge) in edges.items():
        if x >= n or y >= n:
            continue
        shift, rho, same, xf = at(x, y)
        pasted += same > SAME_FROM
        # [after beat, to beat, score, shift ms, crossfade ms, bridge, rho of the fade law]
        jumps.append([int(x - 1), int(y), round(s, 4), round(shift * 1000, 2), xf, is_bridge, round(rho, 3)])
    jumps.sort()
    return {"jumps": jumps, "lbp": int(lbp), "fallback": fallback, "bridges": len(bridges), "pasted": int(pasted)}

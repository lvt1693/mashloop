"""What a mashup plays, bar by bar: an arranger.

What makes a mashup work, and what this follows (DJ and mashup practice:
match tempo and key, line up verses and choruses, keep a vocal line whole,
let the band carry the structure; DJ Earworm: "I'm trying to make pop songs,
not mixes"):

- One frame for everyone: a tempo and a key that bend and move the songs as
  little as possible all together (each clip is then warped beat by beat onto
  the tempo and moved into the key, render.py), and a mood.
- A voice sings a whole run of its own song (its verse, its pre-chorus, its
  chorus), never chopped up or reordered mid-line; it comes in where its
  phrase starts (the pickup before the bar line included) and leaves where
  its line ends (render.py finds both in the vocal stem).
- The band under a voice is played from its song's voice-free stretches (4-
  or 8-bar loops of its own mix, nothing separated): a calmer loop under the
  verse, its most driving under the chorus, each chosen where its end runs
  back into its start and its middle leaves the voice room. A song sung from
  start to end lends its band without its voice, rebuilt on its separated
  drums and bass (a last resort, scored down).
- Who sings over whom is chosen by ear-like measures: the notes the voice
  sings against the band's chords (chroma at the pitch classes the vocal
  stem sings), the groove it sang to against the band's (AutoMashUpper's
  rhythmic similarity), energy and mood, how far each is bent.
- Never a voice straight into another: a few seconds of band alone between
  them (the old voice echoing out, the bands blending), then the next line.
- A song from start to end: an intro that teases a hook, acts that rise, a
  drop, an a cappella breakdown, a finale where two hooks meet (or trade
  lines), an outro that rings out.
- Between acts, DJ moves chosen by what changes (the band, the voice, the
  energy): an EQ blend with a bass swap, a build-up into a drop swap, an echo
  out, a reverb wash, a loop roll, a trance gate, a brake, a spinback, a
  voice handing over on the same band.
- Diversity: many arrangements are drawn for the same songs, scored, and the
  best distinct ones kept in order; variant n is the n-th best, so "another
  arrangement" always gives a different one.

The plan is plain data (JSON): sources, sections and moves for the page,
clips (with gain and filter automation, and the pickup and tail a voice may
take) and events for the renderer."""
import dataclasses
import hashlib
import math
import random
from collections import Counter
from dataclasses import dataclass, field

import numpy as np

from .. import library
from ..analysis import transitions as T
from ..analysis.structure import (_CAMELOT_MAJOR, _CAMELOT_MINOR, _NAMES, PHRASE_SECTION, ROLE_BREAK, ROLE_CHORUS,
                                  ROLE_DROP, ROLE_INTRO, ROLE_OTHER, ROLE_OUTRO, ROLE_VERSE)

MIN_SECONDS, MAX_SECONDS = 60, 600
MIN_SONGS, MAX_SONGS = 2, 5
# auto: free (every technique, every pairing); duet: two songs trading
# voices and bands (A vs B, then flipped); medley: the songs one after another,
# each as itself, joined by mashed transitions.
STYLES = ("auto", "duet", "medley")
STYLE_ALIAS = {"swap": "duet", "megamix": "medley", "free": "auto"}
VIBES = ("auto", "original", "club", "chill", "slowed", "speedup", "acoustic")
ROLES = ("auto", "vocals", "music", "both")
# The techniques and the moves between acts the listener may turn off.
FX = ("teaser", "breakdown", "double", "chop", "blend", "buildup", "filter", "echo", "wash", "roll", "gate",
      "brake", "spin")
FX_DEFAULT = {k: k not in ("roll", "gate", "brake", "spin") for k in FX}  # the abrupt ones are asked for
# Bars of the band alone at the start of every act after the first: the voice
# before it has rung out, the bands have blended, then the next voice comes in.
# Four bars, two where four would last longer than LEAD_MAX_S (a slow tempo).
LEAD = 4
LEAD_MAX_S = 9.0
OUTRO_MAX_S = 16.0  # a fast mashup's outro at most (8 bars, else 4)
# How fast the mashup runs: the songs' own common tempo, or pushed up (Rubber
# Band, the pitch kept) as far as no voice is bent past VOICE_BEND.
PACES = {"natural": 1.0, "fast": 1.08, "faster": 1.14}
VOICE_BEND = {"natural": 0.16, "fast": 0.18, "faster": 0.22}  # how far a voice may be pushed for it
# And how soon it gets going: the most verse sung before a hook, how long a
# hook runs (16 bars where there is room, else 8), the intro and outro.
MAX_VERSE = {"natural": 16, "fast": 8, "faster": 4}
LONG_HOOK = {"natural": True, "fast": True, "faster": False}
MAX_STRETCH = 0.3
SUNG = 0.35
# A bar is voice-free (its own mix serves as a clean band) when no beat of it
# has more voice than this (features "vocal": 0 = the vocal stem 15 dB or
# more under the mix).
CLEAN_VOCAL = 0.12
# A song with no such bar lends its least sung ones (separated: a quiet voice
# leaves little behind), up to this.
SOFT_VOCAL = 0.55
RESAMPLE = {"slowed": 0.85, "speedup": 1.18}
CANDIDATES = 40  # arrangements drawn per plan

KIND_LABEL = {"intro": "Intro", "verse": "Verse", "build": "Build-up", "chorus": "Chorus", "drop": "Drop",
              "break": "Breakdown", "outro": "Outro", "mash": "Mash", "finale": "Finale"}


class PlanError(Exception):
    """A plan that cannot be made, with a message for the listener."""


@dataclass
class Sec:
    start: int   # beat (a downbeat)
    end: int     # beat after its last
    role: int
    bars: int
    vocal: float
    intensity: float


@dataclass
class Run:
    """A sung stretch of a song that ends on a chorus: its verse (and
    pre-chorus) bars, then its chorus bars."""
    start_bar: int
    hook_bar: int
    hook_bars: int
    strength: float

    @property
    def verse_bars(self) -> int:
        return self.hook_bar - self.start_bar


@dataclass
class Song:
    id: str
    title: str
    artist: str
    f: dict
    stems: bool
    drums: bool
    secs: list
    role: str = "auto"   # what the listener asked of it
    r: float = 1.0       # its beats per beat of the common tempo
    semis: float = 0.0   # transposition into the common key (tuning included)
    bend: float = 0.0    # how far it is stretched onto the common tempo (log ratio)
    down: np.ndarray = field(default=None, repr=False)     # downbeats (beat numbers)
    chroma: np.ndarray = field(default=None, repr=False)   # (beats, 12)
    vpc: np.ndarray = field(default=None, repr=False)      # sung pitch class per beat, -1 when none
    band: np.ndarray = field(default=None, repr=False)     # the band's own level per beat (_band_loud)
    runs: list = field(default_factory=list)
    loops: list = field(default_factory=list)              # its voice-free stretches (Loop)
    soft_loops: list = field(default_factory=list)         # without any: its least sung stretches

    @property
    def bpm(self) -> float:
        return float(self.f["bpm"])

    @property
    def n(self) -> int:
        return int(self.f["n"])

    @property
    def energy(self) -> float:
        return float(self.f["mood"].get("energy", 0.5))

    @property
    def valence(self) -> float:
        return float(self.f["mood"].get("valence", 0.5))

    @property
    def sung(self) -> float:
        """How much of the song is sung (the clearly sung share of its beats)."""
        return float((self.f["vocal"] >= SUNG).mean())

    @property
    def can_sing(self) -> bool:
        return self.stems and self.sung > 0.12 and self.role != "music" and bool(self.runs)

    @property
    def can_play(self) -> bool:
        return self.role != "vocals"

    def bars(self) -> int:
        return len(self.down)

    def beat_of_bar(self, k: int) -> int:
        if k < len(self.down):
            return int(self.down[max(0, k)])
        return int(self.down[-1]) + 4 * (k - len(self.down) + 1)

    def bar_of(self, beat: int) -> int:
        return max(0, int(np.searchsorted(self.down, beat, side="right")) - 1)

    def role_at_bar(self, k: int) -> int:
        b = self.beat_of_bar(k)
        return int(self.f["role"][min(b, self.n - 1)])

    def intensity_bars(self, k0: int, k1: int) -> float:
        a, b = self.beat_of_bar(k0), min(self.n, self.beat_of_bar(k1))
        return float(self.f["intensity"][a:b].mean()) if b > a else 0.0

    def vocal_bars(self, k0: int, k1: int) -> float:
        a, b = self.beat_of_bar(k0), min(self.n, self.beat_of_bar(k1))
        return float(self.f["vocal"][a:b].mean()) if b > a else 0.0


# ----------------------------------------------------------------- songs

def _sections(f: dict) -> list[Sec]:
    """The song's sections, each from a downbeat, with its role and how sung
    and how intense it is."""
    n = f["n"]
    down = np.where(f["pos"] == 0)[0]
    if len(down) == 0:
        return []
    starts = sorted(set(int(s) for s in np.where(f["phrase"] == PHRASE_SECTION)[0]) | {int(down[0])})
    snapped = []
    for s in starts:
        k = np.searchsorted(down, s)
        if k < len(down) and (not snapped or down[k] > snapped[-1]):
            snapped.append(int(down[k]))
    out = []
    for i, s in enumerate(snapped):
        e = snapped[i + 1] if i + 1 < len(snapped) else n
        bars = int(((down >= s) & (down < e)).sum())
        if bars < 2:
            continue
        out.append(Sec(s, e, int(f["role"][s]), bars, float(f["vocal"][s:e].mean()),
                       float(f["intensity"][s:e].mean())))
    return out


LOUD = (ROLE_CHORUS, ROLE_DROP)


def _runs(song: Song) -> list[Run]:
    """The song's sung runs into a hook, the strongest first. A hook is a
    sung section among the song's most intense (its chorus or drop when the
    analysis named one; the section labels alone are not trusted, a song can
    come out all "verse"), at least 8 bars (the sections after it joined while
    they stay as strong and sung); its lead-in is the calmer sung sections
    just before it, up to 24 bars."""
    secs, out = song.secs, []
    sung = [s for s in secs if s.vocal >= SUNG * 0.8]
    if not sung:
        return []
    cut = float(np.percentile([s.intensity for s in sung], 55))
    hooks = [i for i, s in enumerate(secs) if s.vocal >= SUNG * 0.8 and s.bars >= 4
             and (s.intensity >= cut - 1e-9 or s.role in LOUD)]
    taken = set()
    for i in hooks:
        if i in taken:
            continue
        c = secs[i]
        # The hook: this section, and the next ones while as strong and sung (to 16 bars).
        bars, j = c.bars, i
        while bars < 8 and j + 1 < len(secs) and secs[j + 1].vocal >= SUNG * 0.6 \
                and secs[j + 1].intensity >= c.intensity - 0.15:
            j += 1
            bars += secs[j].bars
            taken.add(j)
        hook_bar = song.bar_of(c.start)
        hook_bars = min(16, bars) // 4 * 4
        if hook_bars < 8 and song.bars() - hook_bar >= 8:
            hook_bars = 8  # its last bars carry on into what follows: still sung, near enough
        if hook_bars < 4:
            continue
        # The lead-in: calmer sung sections right before it.
        k = i
        while k > 0:
            p = secs[k - 1]
            if p.vocal < SUNG * 0.5 or p.intensity > c.intensity + 0.05 or p.role in (ROLE_OUTRO,):
                break
            if hook_bar - song.bar_of(p.start) > 24:
                break
            k -= 1
        start_bar = song.bar_of(secs[k].start)
        strength = c.intensity + 0.7 * c.vocal + (0.2 if c.role in LOUD else 0.0) + 0.1 * (hook_bar - start_bar >= 8)
        out.append(Run(start_bar, hook_bar, hook_bars, strength))
    out.sort(key=lambda r: -r.strength)
    return out


def load_songs(ids: list[str], roles: dict[str, str]) -> list[Song]:
    songs = []
    for tid in ids:
        meta = library.read_meta(tid) or {}
        if meta.get("status") != "ready" or not library.has_audio(tid):
            raise PlanError(f"Bài «{meta.get('title') or tid}» chưa sẵn sàng")
        f = T.load_features(tid)
        if f["meter"] != 4:
            raise PlanError(f"Bài «{meta.get('title')}» không phải nhịp 4/4, chưa ghép được")
        credit = meta.get("credit") or {}
        s = Song(id=tid, title=credit.get("title") or meta.get("title") or tid,
                 artist=credit.get("artist") or meta.get("channel") or "", f=f,
                 stems=library.has_vocals(tid), drums=has_drums(tid), secs=_sections(f),
                 role=roles.get(tid, "auto") if roles.get(tid, "auto") in ROLES else "auto")
        s.down = np.where(f["pos"] == 0)[0]
        if len(s.down) < 16:
            raise PlanError(f"«{s.title}» quá ngắn để ghép, chọn bài khác")
        s.chroma = f["chroma"].mean(1)
        vp = f["vpitch"]
        s.vpc = np.where(np.isfinite(vp), np.round(np.nan_to_num(vp)).astype(int) % 12, -1)
        s.runs = _runs(s)
        s.loops = _loops(s)
        # Where it has none, its quietly sung stretches: separated, little voice to take out.
        s.soft_loops = [] if s.loops or not s.stems else _loops(s, SOFT_VOCAL)
        songs.append(s)
    return songs


def has_drums(tid: str) -> bool:
    return (library.track_dir(tid) / "drums.mp3").exists()


def has_parts(tid: str) -> bool:
    return has_drums(tid) and (library.track_dir(tid) / "bass.mp3").exists()


def parts_needed(plan: dict) -> list[str]:
    """The songs whose drum and bass stems the render needs separated first:
    the bands of an acoustic mashup (their drums go), and every band played
    from its mix without its voice (rebuilt on its drums and bass)."""
    music = [c for c in plan["clips"] if c["role"] == "music"]
    need = {c["src"] for c in music if c["stem"] == "inst" and not has_parts(c["src"])}
    if plan["vibe"] == "acoustic":
        need |= {c["src"] for c in music if not has_drums(c["src"])}
    return sorted(need)


# ------------------------------------------------------------------ frame

def camelot(tonic: int, mode: int) -> int:
    return (_CAMELOT_MAJOR if mode == 0 else _CAMELOT_MINOR)[tonic % 12]


def shift_to(tonic: int, mode: int, number: int) -> int:
    """The smallest transposition (semitones) that puts a key on a Camelot
    number (its relative major or minor counts: they share every note)."""
    for s in sorted(range(-6, 7), key=lambda x: (abs(x), x)):
        if camelot(tonic + s, mode) == number:
            return s
    return 0


def key_name(number: int, letter: str) -> str:
    table = _CAMELOT_MAJOR if letter == "B" else _CAMELOT_MINOR
    tonic = table.index(number)
    return f"{_NAMES[tonic]} {'major' if letter == 'B' else 'minor'}"


def _fold(bpm: float, master: float) -> float:
    """The song's beats per beat of the common tempo: 2 for a song twice as
    fast (two of its beats in one), 0.5 for one half as fast, else 1."""
    return min((0.5, 1.0, 2.0), key=lambda r: abs(math.log(bpm / r / master)))


def _bend(s, master: float) -> float:
    return abs(math.log(s.bpm / _fold(s.bpm, master) / master))


def _worst(songs: list, master: float) -> float:
    """How far (log ratio) the song bent most would be bent onto master."""
    return max(_bend(s, master) for s in songs)


def _tempo(songs: list) -> float:
    """The common tempo (60-200 BPM): the least bending of all together (the
    square of each song's bend, the voices weighing more: a stretched voice
    is heard first), within what no song may be bent past."""
    grid = np.exp(np.linspace(math.log(60.0), math.log(200.0), 1400))
    w = {s.id: 1.3 if s.can_sing else 1.0 for s in songs}
    limit = math.log(1 + MAX_STRETCH)
    best = None
    for m in grid:
        m = float(m)
        bends = [_bend(s, m) for s in songs]
        cost = sum(w[s.id] * b * b for s, b in zip(songs, bends)) + (100.0 if max(bends) > limit else 0.0)
        # Between near-equal tempos, the one nearer the songs' own (no needless double time).
        cost += 1e-4 * abs(math.log(m / float(np.median([s.bpm for s in songs]))))
        if best is None or cost < best[0]:
            best = (cost, m)
    return best[1]


def _mood_label(energy: float, valence: float) -> str:
    if energy >= 0.6:
        return "sôi động, tươi" if valence >= 0.5 else "mạnh, gắt"
    if energy <= 0.4:
        return "êm, trong" if valence >= 0.5 else "lắng, buồn"
    return "vừa phải, vui" if valence >= 0.5 else "vừa phải, trầm"


def _frame(songs: list[Song], opts: dict) -> dict:
    """The common tempo, key and mood, and each song's place in them."""
    bpm_set = opts.get("bpm")
    master = float(min(200.0, max(60.0, bpm_set))) if bpm_set else _tempo(songs)
    vibe = opts["vibe"]
    energy = float(np.mean([s.energy for s in songs]))
    valence = float(np.mean([s.valence for s in songs]))
    if vibe == "auto":
        vibe = "club" if energy >= 0.62 else "chill" if energy <= 0.38 else "original"
    if not bpm_set:
        # A calmer vibe settles a little slower, unless that bends someone too far.
        eased = master * 0.9 if vibe == "chill" and master >= 95 else master * 0.95 if vibe == "acoustic" else master
        if _worst(songs, eased) <= max(_worst(songs, master), math.log(1.12)):
            master = eased
    if not bpm_set and vibe != "chill":
        # Faster, as asked: pushed up as far as no voice is bent past
        # VOICE_BEND (nor a band past MAX_STRETCH), or past where it already was.
        pace = opts.get("pace", "fast")
        voice = VOICE_BEND.get(pace, 0.16)
        limits = {s.id: max(_bend(s, master), math.log(1 + (voice if s.can_sing else MAX_STRETCH)))
                  for s in songs}
        push = PACES.get(pace, 1.0)
        while push > 1.0 + 1e-9:
            if all(_bend(s, master * push) <= limits[s.id] + 1e-9 for s in songs):
                master *= push
                break
            push -= 0.01
    master = round(master, 2)
    notes = []
    for s in songs:
        s.r = _fold(s.bpm, master)
        s.bend = off = _bend(s, master)
        if off > math.log(1 + MAX_STRETCH):
            raise PlanError(f"«{s.title}» ({s.bpm:.0f} BPM) lệch quá xa tempo chung {master:.0f} BPM: "
                            "chọn bài khác, hoặc đặt tempo chung ở giữa")
        if off > math.log(1.12):
            # (As the page shows each song's change: its tempo against its own.)
            notes.append(f"«{s.title}» được nắn {100 * abs(master * s.r / s.bpm - 1):.0f}% để khớp tempo")
    # The key: every key tried, at a cost growing with the square of each
    # shift (two songs moved a little each sound better than one moved a lot),
    # the voices weighing most; or the listener's.
    key_set = opts.get("key")
    if key_set:
        number, letter = int(key_set[:-1]), key_set[-1]
    else:
        best = None
        for number in range(1, 13):
            cost = sum((1.5 if s.can_sing else 1.0) * shift_to(s.f["key_tonic"], s.f["key_mode"], number) ** 2
                       for s in songs)
            if best is None or cost < best[0] - 1e-9:
                best = (cost, number)
        number = best[1]
        minor = sum(1 for s in songs if s.f["key_mode"] == 1)
        letter = "A" if minor * 2 >= len(songs) else "B"
    tune = float(np.median([s.f.get("tuning", 0.0) for s in songs]))
    for s in songs:
        s.semis = float(shift_to(s.f["key_tonic"], s.f["key_mode"], number))
        # The recordings' own tunings, too, where they are off by a hearable amount.
        cents = tune - s.f.get("tuning", 0.0)
        if abs(cents) >= 10:
            s.semis = round(s.semis + cents / 100.0, 3)
        if abs(round(s.semis)) >= 4:
            notes.append(f"«{s.title}» dịch {round(s.semis):+d} nửa cung cho hợp tông")
    return {"bpm": master, "number": number, "letter": letter, "vibe": vibe,
            "mood": {"energy": round(energy, 3), "valence": round(valence, 3), "label": _mood_label(energy, valence)},
            "notes": notes}


# ------------------------------------------------------------- matching

def _fit(v: Song, vbar: int, b: Song, bbar: int, bars: int) -> float:
    """How well v's sung notes from bar vbar sit on b's harmony from bar
    bbar, over `bars` common bars: the bed's chroma at the pitch classes the
    voice sings (after both are moved into the key), against the bed's mean
    chroma there (1: chance; a voice on its chord tones scores well above)."""
    k = np.arange(bars * 4)
    vb = v.beat_of_bar(vbar) + np.round(k * v.r).astype(int)
    bb = b.beat_of_bar(bbar) + np.round(k * b.r).astype(int)
    bb = np.where(bb >= b.n, b.beat_of_bar(bbar) + (bb - b.beat_of_bar(bbar)) % max(4, b.n - b.beat_of_bar(bbar)), bb)
    ok = (vb < v.n) & (bb < b.n)
    vb, bb = vb[ok], bb[ok]
    pc = v.vpc[vb]
    sung = (pc >= 0) & (v.f["vocal"][vb] >= SUNG)
    if sung.sum() < 8:
        return 1.0
    shift = int(round(v.semis)) - int(round(b.semis))
    vals = b.chroma[bb[sung], (pc[sung] + shift) % 12]
    return float(vals.mean() / (b.chroma[bb[sung]].mean() + 1e-9))


def _self_fit(v: Song, run: Run) -> float:
    """The same measure for the voice over its own band (the baseline: a
    song fits itself)."""
    bars = run.verse_bars + run.hook_bars
    vb = v.beat_of_bar(run.start_bar)
    nb = min(v.n - vb, bars * 4)
    pc = v.vpc[vb:vb + nb]
    sung = (pc >= 0) & (v.f["vocal"][vb:vb + nb] >= SUNG)
    if sung.sum() < 8:
        return 1.0
    ch = v.chroma[vb:vb + nb][sung]
    return float(ch[np.arange(len(ch)), pc[sung]].mean() / (ch.mean() + 1e-9))


@dataclass
class Loop:
    """A stretch of a song with no voice in it (its own mix is a clean band
    there: nothing separated, no artefacts), looped under another voice: its
    first bar and length in the song's own bars, how driving it is, how
    smoothly its end runs back into its start (1: as the original ran into
    it), and how busy its middle is (the space it leaves a voice: 0 is room)."""
    bar: int
    bars: int
    intensity: float
    wrap: float = 1.0
    busy: float = 0.5
    groove: dict = field(default_factory=dict, repr=False, compare=False)  # _groove's, per kind, when first asked

    @property
    def quality(self) -> float:
        return self.intensity + 0.35 * self.wrap - 0.15 * self.busy + 0.05 * (self.bars == 8)


def _wrap(song: Song, start: int, end: int) -> float:
    """How alike the loop's last beat is to the beat that led into its start
    in the original (harmony, drum pattern, level): the loop then comes round
    as if the song itself went on; a fill or a change of chord at its end
    shows as a jump every time round."""
    a, b = start - 1, end - 1
    if a < 0 or b >= song.n:
        return 0.5
    f = song.f
    ca, cb = f["chroma"][a].ravel(), f["chroma"][b].ravel()
    ra, rb = f["rhythm"][a], f["rhythm"][b]
    cos = lambda x, y: float(np.dot(x, y) / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-9))  # noqa: E731
    level = max(0.0, 1.0 - abs(float(f["loud"][a]) - float(f["loud"][b])) / 9.0)
    return 0.45 * cos(ca, cb) + 0.35 * cos(ra, rb) + 0.2 * level


def _busy(song: Song, a: int, b: int) -> float:
    """How much of the loop's sound is its middle (the "other" stem: keys,
    guitars, pads) against its drums and bass: a voice needs room there."""
    st = song.f["stems"][a:b]  # dB per beat: drums, bass, other, vocals
    if not len(st):
        return 0.5
    other = float(st[:, 2].mean())
    base = float(np.maximum(st[:, 0], st[:, 1]).mean())
    return float(np.clip((other - base + 6.0) / 12.0, 0.0, 1.0))


def _groove(song: Song, k0: int, k1: int, per_bar: bool) -> np.ndarray | None:
    """The song's groove over its bars k0..k1: where in the beat its onsets
    fall (the rhythm profile), averaged for each beat of the bar (per_bar),
    else over all its beats; unit length."""
    a, b = song.beat_of_bar(k0), min(song.n, song.beat_of_bar(k1))
    rh = song.f["rhythm"][a:b]
    if len(rh) < 4:
        return None
    if per_bar:
        pos = song.f["pos"][a:b]
        g = np.concatenate([rh[pos == p].mean(0) if (pos == p).any() else np.zeros(rh.shape[1], np.float32)
                            for p in range(4)])
    else:
        g = rh.mean(0)
    return g / (np.linalg.norm(g) + 1e-9)


GROOVE_FLOOR = 0.8  # the cosine of two grooves that have nothing in common but a beat


def _groove_sim(v: Song, vk0: int, vk1: int, b: Song, loop: Loop | None = None, bk0: int = 0, bk1: int = 0) -> float:
    """How alike the groove v sang to (its own band over its bars vk0..vk1)
    is to the band under it (a loop of b, or b's bars bk0..bk1): a voice
    phrased to one groove sits naturally on a like one (AutoMashUpper's
    rhythmic similarity). 0: unlike, 1: the same. Bar by bar when both
    songs run at the common tempo, else beat by beat."""
    per_bar = abs(v.r - 1.0) < 1e-9 and abs(b.r - 1.0) < 1e-9
    gv = _groove(v, vk0, vk1, per_bar)
    if loop is not None:
        if per_bar not in loop.groove:
            loop.groove[per_bar] = _groove(b, loop.bar, loop.bar + loop.bars, per_bar)
        gb = loop.groove[per_bar]
    else:
        gb = _groove(b, bk0, bk1, per_bar)
    if gv is None or gb is None:
        return 0.5
    return float(np.clip((float(np.dot(gv, gb)) - GROOVE_FLOOR) / (1.0 - GROOVE_FLOOR), 0.0, 1.0))


def _loops(song: Song, most: float = CLEAN_VOCAL) -> list[Loop]:
    """The song's voice-free stretches of 4 or 8 bars, the best first: bars
    where the analysis hears no voice in any beat (at most `most`) and the
    band never stops (every beat within 18 dB of its usual level). Loops start
    on a phrase line (a 4-bar line of the song's sections) inside such a run;
    each is scored on its drive, how it comes round and how much room it
    leaves a voice, and the best that do not overlap are kept."""
    # (Loops of a band played without its voice are judged on the band's own level.)
    vocal, loud = song.f["vocal"], _band_loud(song) if most > CLEAN_VOCAL else song.f["loud"]
    level = song.f.get("level")
    floor = float(np.median(loud)) - 18.0
    clean = []
    for k in range(song.bars() - 1):
        a, e = song.beat_of_bar(k), min(song.n, song.beat_of_bar(k + 1))
        clean.append(e - a >= 3 and float(vocal[a:e].max()) <= most and float(loud[a:e].min()) > floor)
    cands, k = [], 0
    while k < len(clean):
        if not clean[k]:
            k += 1
            continue
        j = k
        while j < len(clean) and clean[j]:
            j += 1
        for s in range(k, j - 3):
            on_line = s == k or level is None or int(level[song.beat_of_bar(s)]) >= 1
            if not on_line:
                continue
            for n in (8, 4):
                if s + n <= j:
                    a, b = song.beat_of_bar(s), song.beat_of_bar(s + n)
                    cands.append(Loop(s, n, song.intensity_bars(s, s + n), _wrap(song, a, b), _busy(song, a, b)))
        k = j
    # A band to sing over is full and steady: not a sparse stretch of a few
    # hits (its level swinging beat to beat) nor a quiet one (kept only when
    # the song has nothing else).
    def steady(lp: Loop) -> bool:
        a, b = song.beat_of_bar(lp.bar), song.beat_of_bar(lp.bar + lp.bars)
        return lp.intensity >= 0.3 and float(np.std(loud[a:b])) <= 6.0
    if any(steady(lp) for lp in cands):
        cands = [lp for lp in cands if steady(lp)]
    cands.sort(key=lambda lp: -lp.quality)
    out, taken = [], set()
    for lp in cands:
        bars = set(range(lp.bar, lp.bar + lp.bars))
        if bars & taken:
            continue
        out.append(lp)
        taken |= bars
        if len(out) >= 8:
            break
    return out


def _tile(song: Song, loop: Loop, bars: int, offset: int) -> list[tuple[int, int, int]]:
    """Pieces (source bar, common bars, act bar) that play `loop` over `bars`
    common bars from act bar `offset`, again and again."""
    span = max(1, int(round(loop.bars / song.r)))  # the loop in common bars
    return [(loop.bar, min(span, bars - k), offset + k) for k in range(0, bars, span)]


def _fit_idx(v: Song, vb: np.ndarray, b: Song, bb: np.ndarray) -> float:
    """How well v's sung notes at its beats vb sit on b's harmony at its beats
    bb: the bed's chroma at the pitch classes the voice sings (after both are
    moved into the key), against the bed's mean chroma there (1: chance)."""
    ok = (vb < v.n) & (bb < b.n) & (vb >= 0) & (bb >= 0)
    vb, bb = vb[ok], bb[ok]
    pc = v.vpc[vb]
    sung = (pc >= 0) & (v.f["vocal"][vb] >= SUNG)
    if sung.sum() < 8:
        return 1.0
    shift = int(round(v.semis)) - int(round(b.semis))
    vals = b.chroma[bb[sung], (pc[sung] + shift) % 12]
    return float(vals.mean() / (b.chroma[bb[sung]].mean() + 1e-9))


def _fit_loop(v: Song, vbar: int, bars: int, b: Song, loop: Loop) -> float:
    k = np.arange(bars * 4)
    vb = v.beat_of_bar(vbar) + np.round(k * v.r).astype(int)
    bb = b.beat_of_bar(loop.bar) + np.round(k * b.r).astype(int) % (loop.bars * 4)
    return _fit_idx(v, vb, b, bb)


@dataclass
class Bed:
    """The band under an act: pieces of one song, (source bar, common bars,
    act bar), from its voice-free loops (stem "full": the mix itself), or, for
    a song that has none, from the mix without its separated voice ("inst")."""
    song: Song
    pieces: list
    cuts: int
    agree: float
    fit: float
    lift: float
    stem: str = "full"
    calm: Loop | None = None   # the loop under the verse (and the lead-in)
    drive: Loop | None = None  # the loop under the chorus
    groove: float = 0.5        # how alike its groove is to the one the voice sang to (_groove_sim)

    @property
    def next_bar(self) -> int:
        """The source bar the band would play next, straight on after the act."""
        k, n, _ = self.pieces[-1]
        return k + int(round(n * self.song.r))


def _agree(b: Song, k0: int, verse: int, hook: int) -> float:
    """How well a stretch of the band from bar k0 lines up with a voice's run:
    no chorus under the verse, a chorus (or a drop, or anything driving) under
    the chorus."""
    good = 0.0
    for i in range(verse + hook):
        role = b.role_at_bar(k0 + i)
        loud = role in LOUD or b.intensity_bars(k0 + i, k0 + i + 1) >= 0.62
        if i < verse:
            good += 0.0 if role in LOUD else (0.8 if role == ROLE_INTRO else 1.0)
        else:
            good += 1.0 if loud else 0.25
    return good / max(1, verse + hook)


def _bed(v: Song, run: Run, lead: int, verse: int, hook: int, b: Song) -> Bed | None:
    """The band of song b under v's act: `lead` bars of it alone, then v's
    verse (`verse` bars), then its chorus (`hook`).

    From b's voice-free loops when it has some: a calmer one under the lead
    and the verse, the most driving under the chorus, each chosen for how the
    voice's notes sit on it. The original song (a medley's act) is played
    straight through, voice and all. A song with no voice-free stretch lends
    its mix without its separated voice, on the stretch that lines up best
    (its chorus under the chorus): a last resort, scored down."""
    vbar = run.hook_bar - verse
    if v is b:
        start = max(0, vbar - lead)
        return Bed(b, [(start, lead + verse + hook, 0)], 0, 1.0, 2.0, b.intensity_bars(run.hook_bar, run.hook_bar + hook),
                   stem="full", groove=1.0)
    if b.loops or b.soft_loops:
        # Voice-free loops of its mix; else its least sung stretches, separated.
        loops, stem = (b.loops, "full") if b.loops else (b.soft_loops, "inst")
        gh = {id(lp): _groove_sim(v, run.hook_bar, run.hook_bar + hook, b, lp) for lp in loops[:5]}
        gv = {id(lp): _groove_sim(v, vbar, run.hook_bar, b, lp) for lp in loops[:5]} if verse else gh
        best = None
        for hl in loops[:4]:
            fh = _fit_loop(v, run.hook_bar, hook, b, hl)
            for vl in loops[:5]:
                fv = _fit_loop(v, vbar, verse, b, vl) if verse else fh
                score = (0.45 * min(fv, 2.2) / 2.2 + 0.65 * min(fh, 2.2) / 2.2 + 0.5 * hl.intensity
                         - 0.3 * max(0.0, vl.intensity - hl.intensity) + (0.08 if vl is not hl else 0.0)
                         + 0.04 * (hl.bars == 8) + 0.2 * (hl.wrap + vl.wrap) / 2
                         - 0.15 * hl.busy - 0.1 * vl.busy + 0.3 * gh[id(hl)] + 0.15 * gv[id(vl)])
                if best is None or score > best[0]:
                    best = (score, vl, hl, fv, fh)
        _, vl, hl, fv, fh = best
        groove = (gv[id(vl)] * verse + gh[id(hl)] * hook) / max(1, verse + hook)
        # A chorus-only act comes in on the driving loop (its lead is a drop).
        first = vl if verse else hl
        pieces = _tile(b, first, lead + verse, 0)
        # A long chorus takes turns between its loop and the next strongest, eight bars each.
        alt = next((lp for lp in loops if lp is not hl and lp is not vl and lp.intensity >= hl.intensity - 0.12
                    and _fit_loop(v, run.hook_bar, hook, b, lp) >= 0.9 * fh), None)
        if alt is not None and hook >= 16:
            for k in range(0, hook, 8):
                pieces += _tile(b, hl if (k // 8) % 2 == 0 else alt, min(8, hook - k), lead + verse + k)
        else:
            pieces += _tile(b, hl, hook, lead + verse)
        fit = (fv * verse + fh * hook) / max(1, verse + hook)
        return Bed(b, pieces, 0, 1.0 if stem == "full" else 0.8, fit, hl.intensity, stem, vl, hl, groove)
    # No voice-free stretch: the separated band, on the stretch that lines up.
    anchors = [s for s in b.secs if s.role in LOUD and s.bars >= 4] or \
        sorted(b.secs, key=lambda s: -s.intensity)[:3]
    best = None
    for a in anchors:
        kb = b.bar_of(a.start)
        start = kb - verse - lead
        if start < 0 or kb + hook > b.bars():
            continue
        agree = _agree(b, start + lead, verse, hook)
        k = np.arange((verse + hook) * 4)
        vb = v.beat_of_bar(vbar) + np.round(k * v.r).astype(int)
        bb = b.beat_of_bar(start + lead) + np.round(k * b.r).astype(int)
        fit = _fit_idx(v, vb, b, bb)
        groove = _groove_sim(v, vbar, run.hook_bar + hook, b, None, start + lead, kb + hook)
        cand = Bed(b, [(start, lead + verse + hook, 0)], 0, agree, fit, b.intensity_bars(kb, kb + hook), "inst",
                   groove=groove)
        score = (0.9 * agree + 0.6 * min(fit, 2.2) / 2.2 + 0.4 * cand.lift - 0.15 * _stops(b, cand.pieces)
                 + 0.3 * groove)
        if best is None or score > best[0]:
            best = (score, cand)
    return best[1] if best else None


def _band_loud(b: Song) -> np.ndarray:
    """The band's own level per beat (dB): its drums, bass and other stems
    together, without the voice (a stretch sung nearly alone is a hole in a
    band played without its voice)."""
    if b.band is None:
        st = b.f["stems"][:, :3].astype(np.float64)
        b.band = (10 * np.log10((10 ** (st / 10)).sum(1) + 1e-10)).astype(np.float32)
    return b.band


def _least_sung(b: Song, bars: int, near: int) -> int:
    """The first bar of b's least sung `bars` bars (on a 4-bar line) where its
    band is full (no stop, its level within 6 dB of its usual), the nearer
    to bar `near` the better between equals."""
    band = _band_loud(b)
    usual = float(np.median(band))
    best = None
    for k in range(0, max(1, b.bars() - bars), 4):
        a, e = b.beat_of_bar(k), min(b.n, b.beat_of_bar(k + bars))
        if e - a < 4 * bars - 2:
            continue
        full = _stops(b, [(k, int(round(bars / b.r)), 0)]) <= 2 and float(band[a:e].mean()) >= usual - 6.0
        cost = float(b.f["vocal"][a:e].mean()) + (0.0 if full else 1.0) + 0.01 * abs(k - near) / 4
        if best is None or cost < best[0]:
            best = (cost, k)
    return best[1] if best else max(0, near - bars)


def _stops(b: Song, pieces: list) -> int:
    """Beats where the band all but stops (20 dB under its usual level) in
    the bars a bed plays."""
    loud = _band_loud(b)
    floor = float(np.median(loud)) - 20.0
    n = 0
    for k, bars, _ in pieces:
        a, e = b.beat_of_bar(k), min(b.n, b.beat_of_bar(k + int(round(bars * b.r))))
        n += int((loud[a:e] < floor).sum())
    return n


def _mood_sim(a: Song, b: Song) -> float:
    return 1.0 - 0.5 * (abs(a.energy - b.energy) + abs(a.valence - b.valence))


# ----------------------------------------------------------------- acts

@dataclass
class Act:
    singer: Song | None      # None: the band alone
    run: Run | None
    verse: int               # bars of the run's verse part sung (from its end)
    hook: int                # bars of its chorus
    bed: Bed
    score: float
    lead: int = 4            # bars of the band alone before the voice comes in
    layer: Song | None = None    # a second voice in the finale: two hooks at once
    layer_run: Run | None = None
    trade: bool = False          # ... or the two trading lines

    @property
    def bars(self) -> int:
        return self.lead + self.verse + self.hook

    @property
    def lift(self) -> float:
        return self.bed.lift

    @property
    def home(self) -> bool:
        """The singer over its own band: the original song, played as it is."""
        return self.singer is self.bed.song


def _act(v: Song, run: Run, lead: int, verse: int, hook: int, b: Song) -> Act | None:
    bed = _bed(v, run, lead, verse, hook, b)
    if bed is None:
        return None
    rel = min(1.3, bed.fit / max(0.6, _self_fit(v, run)))
    score = (1.2 * rel + 0.8 * bed.agree + 0.4 * bed.lift + 0.3 * _mood_sim(v, b) + 0.1 * run.strength
             + 0.4 * bed.groove)
    # A voice stretched far is heard first (past 12 % it starts to sound
    # bent); a band less so.
    score -= 1.5 * v.bend + 4.0 * max(0.0, v.bend - 0.115) + 0.6 * b.bend
    if bed.stem == "inst":
        # A separated band: artefacts where its voice was (fewer on its least sung loops).
        score -= 0.5 if bed.calm is not None else 0.9
    if v is b:
        score -= 0.35  # a song over its own band is the original: kept for the medley
    return Act(v, run, verse, hook, bed, score, lead=lead)


def _overlap(a: Song, ra: Run, b: Song, rb: Run, bars: int) -> float:
    """The share of sung beats where both choruses sing at once (two hooks
    layered only where they mostly take turns)."""
    k = np.arange(bars * 4)
    va = a.f["vocal"][np.minimum(a.n - 1, a.beat_of_bar(ra.hook_bar) + np.round(k * a.r).astype(int))] >= SUNG
    vb = b.f["vocal"][np.minimum(b.n - 1, b.beat_of_bar(rb.hook_bar) + np.round(k * b.r).astype(int))] >= SUNG
    either = (va | vb).sum()
    return float((va & vb).sum() / either) if either else 1.0


# ------------------------------------------------------------- arrange

@dataclass
class Draft:
    """One arrangement: intro, acts with their interludes, outro, and the
    move at every seam."""
    intro: int
    intro_bed: Bed
    teaser: tuple | None
    items: list           # ("act", Act) | ("drop", Bed, bars) | ("break", Song, Run, Bed, bars)
    seams: list           # one per boundary after the intro (len(items))
    outro: int
    score: float = 0.0
    signature: tuple = ()


def _weighted(rng: random.Random, items: list, weights: list):
    total = sum(max(0.0, w) for w in weights)
    if total <= 0:
        return items[0]
    x = rng.random() * total
    for it, w in zip(items, weights):
        x -= max(0.0, w)
        if x <= 0:
            return it
    return items[-1]


def _verse_from(v: Song, run: Run, want: int) -> int:
    """How many bars of a run's verse to sing (up to `want`, in fours): the
    longest whose first bar starts a phrase (the voice quiet in the beats just
    before it; the run's own start counts as one), so the voice comes in on a
    line, not halfway through one."""
    top = min(want, run.verse_bars) // 4 * 4
    best, best_q = 0, -1.0
    for vv in range(top, 0, -4):
        b = v.beat_of_bar(run.hook_bar - vv)
        before = v.f["vocal"][max(0, b - 2):b]
        q = 1.0 - (float(before.mean()) if len(before) else 0.0)
        q += 0.3 * (run.hook_bar - vv == run.start_bar) + 0.03 * vv / 4
        if q > best_q:
            best, best_q = vv, q
    return best


def _choose_act(rng, singers, beds, last_singer, last_bed, used, verse, hook, lead=LEAD, allow_self=False, cache=None):
    cands = []
    for v in singers:
        for b in beds:
            if (b is v and not allow_self) or (v is last_singer and len(singers) > 1):
                continue
            for run in v.runs[:3]:
                vv = _verse_from(v, run, verse)
                hh = min(hook, run.hook_bars)
                if hh < 8 and hook >= 8:
                    continue
                key = (v.id, b.id, run.start_bar, lead, vv, hh)
                act = cache.get(key) if cache is not None else None
                if act is None:
                    act = _act(v, run, lead, vv, hh, b)
                    if cache is not None:
                        cache[key] = act
                if act is None:
                    continue
                # Fresh voices, bands and pairings; whole runs (a verse before the hook) when asked for.
                s = (act.score - 0.35 * used[v.id] - 0.25 * used[b.id] - 0.9 * used[(v.id, b.id)]
                     - 0.3 * used[(v.id, run.hook_bar)] - (0.4 if b is last_bed else 0.0)
                     + (0.25 if verse >= 8 and vv >= 8 else 0.0))
                cands.append((s, act))
    if not cands:
        return None
    cands.sort(key=lambda c: -c[0])
    top = cands[:4]
    # A copy: the cached act is shared by every draft, the finale's layer is not.
    return dataclasses.replace(_weighted(rng, [a for _, a in top], [math.exp(4 * (s - top[0][0])) for s, _ in top]))


def _draft(songs: list[Song], style: str, nbars: int, fx: dict, rng: random.Random, cache: dict,
           pace: str = "fast", lead: int = LEAD, cap: int = 16) -> Draft:
    """One arrangement drawn with rng: `lead` bars of band alone before each
    voice after the first, the outro at most `cap` bars."""
    singers = [s for s in songs if s.can_sing]
    beds = [s for s in songs if s.can_play] or songs
    if not singers:
        raise PlanError("Cần ít nhất một bài có giọng hát (đã tách giọng) để ghép")
    # A fast mashup starts and ends quickly.
    intro = 8 if nbars >= 72 and pace == "natural" else 4
    outro = 8 if nbars >= 96 and pace == "natural" else 4
    body = nbars - intro - outro + lead  # the first act comes in without a lead (the intro is one)
    want_drop = bool(fx.get("buildup")) and body >= 96
    want_break = bool(fx.get("breakdown")) and body >= 112
    room = body - 8 * want_drop - 8 * want_break
    max_verse = MAX_VERSE.get(pace, 8)  # a fast mashup gets to its hooks sooner
    used = Counter()
    items = []
    order = sorted(songs, key=lambda s: s.energy)
    pair = _duet_pair(songs, cache, lead) if style == "duet" and len(songs) >= 2 else None
    guest_done = False
    last_singer = last_bed = None
    # Acts until the length is filled: each the band alone a few bars, a verse
    # (from its end), a chorus; choruses alone when little is left.
    shortest = 12 if pace == "natural" else 8  # (a fast one ends on a chorus alone sooner than ring out)
    while room >= shortest + lead and len(items) < 12:
        per = room - lead
        if style == "medley":
            per = min(per, max(20, room // max(1, len(songs) - len(items)) - lead))
        hook = 16 if per >= 24 and LONG_HOOK.get(pace, True) else 8
        verse = max(0, min(max_verse, (per - hook) // 4 * 4))
        i = len(items)
        if style == "medley":
            song = order[i % len(order)]
            v = song if song.can_sing else singers[i % len(singers)]
            act = _choose_act(rng, [v], [song], None, None, used, verse, hook, lead, allow_self=True, cache=cache)
        elif pair is not None:
            a, b = pair if i % 2 == 0 else pair[::-1]
            act = None
            others = [s for s in singers if s not in pair]
            if others and not guest_done and i >= 2:
                # A guest from the other songs sings an act on one of the pair's bands.
                act = _choose_act(rng, others, [s for s in pair if s.can_play], None, None, used, verse, hook,
                                  lead, cache=cache)
                guest_done = act is not None
            if act is None:
                act = _choose_act(rng, [a] if a.can_sing else singers, [b] if b.can_play else beds, None, None,
                                  used, verse, hook, lead, cache=cache)
        else:
            act = _choose_act(rng, singers, beds, last_singer, last_bed, used, verse, hook, lead, cache=cache)
        if act is None:
            act = _choose_act(rng, singers, beds, None, None, used, verse, hook, lead, allow_self=True, cache=cache)
        if act is None:
            raise PlanError("Không ghép được các bài này với nhau, thử bài khác")
        used[act.singer.id] += 1
        used[act.bed.song.id] += 1
        used[(act.singer.id, act.bed.song.id)] += 1
        used[(act.singer.id, act.run.hook_bar)] += 1
        last_singer, last_bed = act.singer, act.bed.song
        items.append(("act", act))
        room -= act.bars
    # What is left: a fast mashup keeps going (a drop before the finale);
    # the rest rings out longer.
    extra = max(0, room) // 4 * 4
    late_drop = bool(fx.get("buildup")) and pace != "natural" and extra >= 8
    extra -= 8 * late_drop
    outro += max(0, min(cap - outro, extra))
    # The energy arc: the acts rising, the strongest band last (a duet keeps
    # its alternation, turned around if it would fall; a medley its order);
    # never the same voice or the same band twice in a row where it can be helped.
    if style == "duet":
        if len(items) >= 2 and items[0][1].lift > items[-1][1].lift:
            items.reverse()
    elif style != "medley" and len(items) >= 2:
        strongest = max(items, key=lambda it: it[1].lift + 0.2 * (it[1].hook >= 16))
        rest = sorted((it for it in items if it is not strongest), key=lambda it: it[1].lift)
        items = _spread(rest + [strongest])
    # The first act follows the intro straight on: no lead of its own.
    a0 = items[0][1]
    first = _act(a0.singer, a0.run, 0, a0.verse, a0.hook, a0.bed.song) or a0
    items[0] = ("act", dataclasses.replace(first, layer=a0.layer, layer_run=a0.layer_run, trade=a0.trade))
    # The finale: two hooks at once (they mostly take turns, and the second
    # sits on the band), or the two trading lines; it needs 8 bars of hook.
    last = items[-1][1]
    if fx.get("double") and len(singers) >= 2 and last.hook >= 8:
        partners = [s for s in singers if s is not last.singer]
        rng.shuffle(partners)
        if pair is not None:  # a duet's finale is the pair's
            partners.sort(key=lambda s: s not in pair)
        for p in partners:
            pr = p.runs[0]
            fit = _fit_loop(p, pr.hook_bar, last.hook, last.bed.song, last.bed.drive) if last.bed.drive else 1.1
            if fit >= 1.05 or len(singers) == 2:
                last.layer, last.layer_run = p, pr
                last.trade = _overlap(last.singer, last.run, p, pr, last.hook) > 0.45
                break
    # Interludes: a drop after the first act, a breakdown before the finale.
    if want_drop and len(items) >= 2:
        items.insert(1, ("drop", _drop_bed(rng, beds, items[0][1]), 8))
    if late_drop and len(items) >= 2 and items[-2][0] == "act":
        items.insert(len(items) - 1, ("drop", _drop_bed(rng, beds, items[-2][1]), 8))
    elif late_drop and items[-1][0] == "act":
        items.append(("drop", _drop_bed(rng, beds, items[-1][1]), 8))  # (one act: the drop closes it)
    elif late_drop:
        outro = min(cap, outro + 8)
    if want_break and len(items) >= 2 and items[-1][0] == "act":
        fin = items[-1][1]
        v = fin.layer or fin.singer
        run = fin.layer_run if fin.layer else fin.run
        items.insert(len(items) - 1, ("break", v, run, fin.bed, 8))
    # An act after a drop comes in on it: the drop was its band alone.
    for i in range(1, len(items)):
        it = items[i][1]
        if items[i - 1][0] == "drop" and items[i][0] == "act" and it.lead:
            a = _act(it.singer, it.run, 0, it.verse, it.hook, it.bed.song) or it
            items[i] = ("act", dataclasses.replace(a, layer=it.layer, layer_run=it.layer_run, trade=it.trade))
            outro = min(cap, outro + it.lead)
    # Intro: the first band's calm loop (or, for the original song, its own
    # bars before the act); a hook of someone else teased at its end.
    fb = items[0][1].bed
    if fb.calm is not None:
        intro_bed = Bed(fb.song, _tile(fb.song, fb.calm, intro, 0), 0, 1.0, 1.0, fb.calm.intensity, fb.stem,
                        fb.calm, fb.calm)
    else:
        # The bars before the act's (the original song's own, for a medley);
        # for a band played without its voice, heard alone here, its least
        # sung full bars (where the voice was, it is hollow).
        k0 = fb.pieces[0][0]
        n = int(round(intro * fb.song.r))
        src = _least_sung(fb.song, n, k0) if fb.stem == "inst" else max(0, k0 - n)
        intro_bed = Bed(fb.song, [(src, intro, 0)], 0, 1.0, 1.0, fb.song.intensity_bars(src, src + n), fb.stem)
    teaser = None
    if fx.get("teaser"):
        # Someone heard later, neither the intro's band nor the first voice.
        cands = [s for s in singers if s is not items[0][1].singer and s is not fb.song] or \
            [s for s in singers if s is not fb.song]
        if cands:
            h = rng.choice(cands)
            teaser = (h, h.runs[0])
    seams = []
    for i in range(len(items)):
        seams.append(_seam(rng, fx, style, items, i, [s["type"] for s in seams]))
    d = Draft(intro, intro_bed, teaser, items, seams, outro)
    d.score = _score(d, songs)
    d.signature = tuple((it[0], it[1].singer.id if it[0] == "act" else "", it[1].bed.song.id if it[0] == "act" else "",
                         it[1].layer.id if it[0] == "act" and it[1].layer else "") for it in items) + \
        tuple(s["type"] for s in seams) + ((teaser[0].id,) if teaser else ())
    return d


def _spread(items: list) -> list:
    """The order kept as far as it can be while no act follows one with the
    same voice or the same band (the last one stays last)."""
    out = list(items)
    for i in range(1, len(out) - 1):
        a, b = out[i - 1][1], out[i][1]
        if a.singer is b.singer or a.bed.song is b.bed.song:
            for j in range(i + 1, len(out) - 1):
                c = out[j][1]
                if c.singer is not a.singer and c.bed.song is not a.bed.song:
                    out[i], out[j] = out[j], out[i]
                    break
    return out


def _duet_pair(songs: list[Song], cache: dict, lead: int = LEAD) -> tuple:
    """The two songs that suit each other best, each over the other's band."""
    best = None
    for a in songs:
        for b in songs:
            if a is b:
                continue
            s = 0.0
            for v, w in ((a, b), (b, a)):
                act = _choose_act(random.Random(0), [v], [w], None, None, Counter(), 8, 16, lead, cache=cache) \
                    if v.can_sing and w.can_play else None
                s += act.score if act else -0.5
            if best is None or s > best[0]:
                best = (s, (a, b))
    return best[1]


def _drop_bed(rng, beds: list[Song], after: Act) -> Bed:
    """An instrumental drop: the most driving voice-free loop of a band (the
    first act's own a little favoured: it runs on from it)."""
    best = None
    for b in beds:
        for lp in b.loops[:3]:
            score = lp.intensity + (0.25 if b is after.bed.song else 0.0) + 0.1 * rng.random()
            if best is None or score > best[0]:
                best = (score, Bed(b, _tile(b, lp, 8, 0), 0, 1.0, 1.0, lp.intensity, "full", lp, lp))
    if best is None:
        b, k = after.bed.song, after.bed.next_bar
        return Bed(b, [(k, 8, 0)], 0, 1.0, 1.0, b.intensity_bars(k, k + 8), after.bed.stem)
    return best[1]


def _start_kind(item) -> str:
    if item[0] == "act":
        return "calm" if item[1].verse >= 8 else "high"
    return "high" if item[0] == "drop" else "calm"


def _seam(rng: random.Random, fx: dict, style: str, items: list, i: int, before: list) -> dict:
    """The move into items[i] from what plays before it (the intro for the
    first); a move just made, or made often, is less likely again."""
    nxt = items[i]
    into = _start_kind(nxt)
    if i == 0:
        # From the intro: the band runs straight on (the intro is its own lead-in),
        # a build when the act starts high.
        if into == "high" and fx.get("buildup"):
            return {"type": "build", "bars": 4}
        return {"type": "straight"}
    prev = items[i - 1]
    switch = {"build": "buildup", "mash": "blend"}  # the listener's switch for each move

    def on(kind: str, weight: float) -> tuple:
        return kind, weight if fx.get(switch.get(kind, kind)) else 0.0

    if prev[0] == "break":
        opts = [("open", 1.0), on("build", 0.8)]
    elif nxt[0] == "break":
        opts = [on("wash", 1.0), on("echo", 0.8), on("blend", 0.4)]
    elif into == "high":
        # Into a chorus: a build and a drop, or the bands blending over the lead.
        opts = [on("build", 1.2), on("blend", 0.7), on("roll", 0.6), on("gate", 0.4), on("brake", 0.5),
                on("spin", 0.5), on("echo", 0.3), on("wash", 0.25)]
    else:
        # Into a verse: the new voice may start over the old band (a mash),
        # or the bands blend, or the old one rings out.
        # (Not when the new voice is the old band's own: that is just its song.)
        mash = nxt[0] == "act" and nxt[1].verse >= 8 and prev[0] == "act" and not nxt[1].home and \
            prev[1].bed.song is not nxt[1].singer
        # From a big band into a much calmer one, the old band carries the
        # energy down through the change (a blend or a mash), never a stop.
        out_lift = prev[1].lift if prev[0] == "act" else prev[1].lift if prev[0] == "drop" else 0.3
        nb = nxt[1].bed if nxt[0] == "act" else None
        in_lift = (nb.calm or nb.drive).intensity if nb is not None and (nb.calm or nb.drive) else 0.5
        falls = out_lift - in_lift > 0.22
        opts = [on("blend", 1.0), on("mash", (1.3 if style == "medley" else 0.7) if mash else 0),
                on("echo", 0 if falls else 0.7), on("wash", 0 if falls else 0.5), on("gate", 0.2),
                on("spin", 0.25), on("brake", 0.2)]
    seen = Counter(before)
    opts = [(o, w * (0.15 if before and before[-1] == o else 1.0) / (1 + 1.2 * seen[o])) for o, w in opts]
    names = [o for o, w in opts if w > 0] or ["cut"]
    weights = [w for o, w in opts if w > 0] or [1.0]
    kind = _weighted(rng, names, weights)
    bars = 8 if kind in ("blend", "mash") and rng.random() < 0.5 else 4
    return {"type": kind, "bars": bars}


def _score(d: Draft, songs: list[Song]) -> float:
    acts = [it[1] for it in d.items if it[0] == "act"]
    s = sum(a.score for a in acts) / max(1, len(acts))
    # Everyone heard (as a voice or as a band).
    heard = {a.singer.id for a in acts} | {a.bed.song.id for a in acts} | {a.layer.id for a in acts if a.layer}
    s += 0.6 * len(heard) / len(songs)
    # Variety: different moves at the seams, different pairings.
    s += 0.15 * len({x["type"] for x in d.seams})
    moves = Counter(x["type"] for x in d.seams if x["type"] != "straight")
    s -= 0.12 * max(0, max(moves.values(), default=0) - 2)  # one move over and over
    s += 0.1 * len({(a.singer.id, a.bed.song.id) for a in acts})
    # The same voice, or the same band, twice in a row (where the order could not help it).
    for a, b in zip(acts, acts[1:]):
        s -= 0.3 * (a.singer is b.singer) + 0.15 * (a.bed.song is b.bed.song)
    # The arc: rising, the finale the strongest.
    lifts = [a.lift for a in acts]
    if len(lifts) >= 2:
        s += 0.3 * (lifts[-1] >= max(lifts) - 1e-9)
    if acts and acts[-1].layer:
        s += 0.2
    return s


# ---------------------------------------------------------------- build

class _Plan:
    """Collects sections, clips, events and moves on the common beat grid."""

    def __init__(self, songs: list[Song], frame: dict, fx: dict):
        self.songs = {s.id: s for s in songs}
        self.frame = frame
        self.fx = fx
        self.sections, self.clips, self.events, self.moves = [], [], [], []

    def clip(self, song: Song, stem: str, start_bar: int, at: int, mbeats: int, role: str, **kw) -> list[dict]:
        """A clip of `mbeats` common beats from the song's bar `start_bar`,
        looped on its bars past the song's end."""
        out = []
        auto = kw.pop("auto", None) or {}
        for src, beats, off in _run(song, song.beat_of_bar(start_bar), mbeats):
            m = int(round(beats / song.r))
            # Each clip its own copy of the automation (points in common beats).
            c = {"src": song.id, "stem": stem, "beat": src, "beats": beats, "at": at + off, "mbeats": m,
                 "r": song.r, "semis": song.semis, "role": role,
                 "auto": {k: [list(pt) for pt in v] for k, v in auto.items()}, **kw}
            self.clips.append(c)
            out.append(c)
        return out

    def voice(self, song: Song, start_bar: int, at: int, mbeats: int, pickup: int = 2, tail: int = 4,
              **kw) -> list[dict]:
        """A sung line: the clip takes up to `pickup` beats before it and
        `tail` after it, where the phrase may start early or ring on (the
        renderer keeps only the phrase there)."""
        b0 = song.beat_of_bar(start_bar)
        pre = min(pickup, int(b0 / song.r))
        post = max(0, min(tail, int((song.n - 2 - b0) / song.r) - mbeats))
        src = b0 - int(round(pre * song.r))
        beats = int(round((pre + mbeats + post) * song.r))
        if src + beats > song.n - 2:
            beats = song.n - 2 - src
        m = int(round(beats / song.r))
        c = {"src": song.id, "stem": "vocals", "beat": src, "beats": beats, "at": at - pre, "mbeats": m,
             "r": song.r, "semis": song.semis, "role": "vocals", "core": [at, at + mbeats], "auto": {}, **kw}
        self.clips.append(c)
        return [c]

    def section(self, kind: str, at: int, bars: int, music: list[str], voice: list[str], label: str | None = None):
        self.sections.append({"kind": kind, "label": label or KIND_LABEL[kind], "beat": at, "beats": bars * 4,
                              "music": music, "voice": voice})


def _run(song: Song, start: int, mbeats: int) -> list[tuple[int, int, int]]:
    """Source pieces that play `mbeats` beats of the common tempo from `start`:
    (source beat, source beats, offset in common beats). Straight on while the
    song lasts; past its end the same stretch again from `start`, a bar at a
    time (a section looped on its downbeat)."""
    need = int(round(mbeats * song.r))
    last = song.n - 2  # the last beat has no true end
    bar = int(4 * song.r) if song.r >= 1 else 4
    while last - start < bar and start >= 4:
        start -= 4
    pieces, at, s = [], 0.0, start
    while need > 0:
        avail = max(0, last - s)
        take = min(need, avail - avail % bar) if avail >= bar else 0
        if take <= 0:
            if s == start:
                raise PlanError(f"«{song.title}» quá ngắn để ghép, chọn bài khác")
            s = start
            continue
        pieces.append((s, take, int(round(at))))
        at += take / song.r
        need -= take
        s = start
    return pieces


def _stem_of(song: Song) -> str:
    return "inst" if song.stems else "full"


def _name(s: Song) -> str:
    t = s.title
    for sep in (" - ", " | ", " (", " [", "【"):
        if sep in t and len(t.split(sep)[0]) >= 3:
            t = t.split(sep)[0]
    return f"«{t.strip()[:32]}»"


def _bed_clips(p: _Plan, bed: Bed, at: int, gain: float = 0.0, **kw) -> list[dict]:
    out = []
    for k, bars, off in bed.pieces:
        out += p.clip(bed.song, bed.stem, k, at + off * 4, bars * 4, "music", gain=gain, **kw)
    return out


def _tail_clips(p: _Plan, bed: Bed, at: int, bars: int, gain: float = 0.0) -> list[dict]:
    """The outgoing band played on for `bars` bars from `at`: its chorus loop
    again (a voice-free loop of its song, for the original song of a medley),
    else what follows in it, straight on."""
    loop = bed.drive or (bed.song.loops[0] if bed.song.loops else None)
    if loop is not None:
        stem = bed.stem if bed.drive is not None else "full"
        out = []
        for k, n, off in _tile(bed.song, loop, bars, 0):
            out += p.clip(bed.song, stem, k, at + off * 4, n * 4, "music", gain=gain)
        return out
    return p.clip(bed.song, bed.stem, bed.next_bar, at, bars * 4, "music", gain=gain)


def _trim_front(bed: Bed, bars: int) -> Bed:
    """The band from `bars` common bars into it (what plays after a mash's opening)."""
    pieces = []
    for k, n, off in bed.pieces:
        if off + n <= bars:
            continue
        cut = max(0, bars - off)
        pieces.append((k + int(round(cut * bed.song.r)), n - cut, off + cut))
    return dataclasses.replace(bed, pieces=pieces)


def _realise(d: Draft, songs: list[Song], frame: dict, fx: dict) -> _Plan:
    p = _Plan(songs, frame, fx)
    at = 0
    # Intro.
    ib = d.intro_bed
    intro_clips = _bed_clips(p, ib, at)
    if fx.get("filter"):
        for c in intro_clips:
            c["auto"]["lp"] = [[at, 900.0], [at + d.intro * 4 - 2, 18000.0]]
    voices = []
    if d.teaser:
        h, run = d.teaser
        t_at = at + (d.intro - 2) * 4
        for c in p.voice(h, run.hook_bar, t_at, 8, pickup=2, tail=2, gain=-2.0, send=0.4):
            c["auto"]["hp"] = [[t_at, 420.0]]
        p.events.append({"type": "echo", "role": "vocals", "at": t_at + 7, "beats": 1})
        voices = [h.id]
        p.moves.append(f"Intro: nhạc {_name(ib.song)}, hé lộ hook {_name(h)}")
    else:
        p.moves.append(f"Intro: nhạc {_name(ib.song)}" + (", mở dần" if fx.get("filter") else ""))
    p.section("intro", at, d.intro, [ib.song.id], voices)
    at += d.intro * 4
    prev_clips, prev_bed, prev_voice = intro_clips, ib, None
    sung = False  # whether a voice of its own (not the original song's) sang the last item out
    for i, item in enumerate(d.items):
        seam = d.seams[i]
        kind = item[0]
        first_bed = item[1].bed if kind == "act" else item[1] if kind == "drop" else item[3]
        same = first_bed.song is prev_bed.song
        if sung and fx.get("echo") and seam["type"] not in ("echo", "wash"):
            # The voice leaving: its last word repeats softly into the band alone.
            p.events.append({"type": "echo", "role": "vocals", "at": at - 1, "beats": 1, "level": 0.5, "seek": 4})
        sung = kind == "break" or (kind == "act" and not item[1].home)
        if kind == "act" and seam["type"] == "mash" and not same:
            # A mash: the old band plays on (its loop), the new voice starts its
            # verse over it after the lead; the new band comes in a few bars on.
            a = item[1]
            bars = min(seam.get("bars", 8), a.verse)
            span = (a.lead + bars) * 4
            for c in _tail_clips(p, prev_bed, at, a.lead + bars, gain=-1.0):
                c["auto"]["gain"] = [[at + span - 4, -1.0], [at + span, -30.0]]
                c["auto"]["low"] = [[at + span - 0.5, 1.0], [at + span + 0.5, 0.0]]
            entry = {"auto": {"hp": [[at + span - 8, 400.0], [at + span, 25.0]],
                              "low": [[at + span - 0.5, 0.0], [at + span + 0.5, 1.0]]}}
            p.moves.append(f"Mash: {_name(a.singer)} hát vào trên nhạc {_name(prev_bed.song)}, "
                           f"nhạc mới vào sau {bars} ô nhịp")
            clips, voice = _realise_act(p, dataclasses.replace(a, bed=_trim_front(a.bed, a.lead + bars)), at, entry,
                                        offset=a.lead + bars, shown_bed=prev_bed.song)
            prev_clips, prev_bed, prev_voice = clips, a.bed, voice
            at += a.bars * 4
            continue
        lead = item[1].lead if kind == "act" else 0
        entry = _apply_seam(p, seam, at, prev_clips, prev_bed, same, i == 0, lead)
        if kind == "act":
            clips, voice = _realise_act(p, item[1], at, entry)
            prev_clips, prev_bed, prev_voice = clips, item[1].bed, voice
            at += item[1].bars * 4
        elif kind == "drop":
            bed, bars = item[1], item[2]
            clips = _bed_clips(p, bed, at, **entry)
            p.section("drop", at, bars, [bed.song.id], [])
            if fx.get("chop") and prev_voice is not None:
                v, run = prev_voice
                p.events.append({"type": "chop", "src": v.id, "beat": v.beat_of_bar(run.hook_bar),
                                 "at": at + bars * 2, "beats": bars * 2, "r": v.r, "semis": v.semis})
                p.moves.append(f"Drop: nhạc {_name(bed.song)}, băm giọng {_name(v)}")
            else:
                p.moves.append(f"Drop: nhạc {_name(bed.song)}")
            prev_clips, prev_bed = clips, bed
            at += bars * 4
        else:  # a cappella breakdown over a dark pad of the finale's band
            _, v, run, fbed, bars = item
            if fbed.calm is not None:
                pad = Bed(fbed.song, _tile(fbed.song, fbed.calm, bars, 0), 0, 1.0, 1.0, 0.2, fbed.stem,
                          fbed.calm, fbed.calm)
            else:
                pad = Bed(fbed.song, [(fbed.pieces[0][0], bars, 0)], 0, 1.0, 1.0, 0.2, fbed.stem)
            clips = _bed_clips(p, pad, at, gain=-5.0)
            for c in clips:
                c["auto"]["lp"] = [[at, 260.0], [at + bars * 4 - 8, 260.0], [at + bars * 4, 900.0]]
                c["auto"]["low"] = [[at, 0.35]]
            p.voice(v, run.hook_bar, at, bars * 4, pickup=2, tail=2, send=0.45)
            p.section("break", at, bars, [fbed.song.id], [v.id])
            p.moves.append(f"Breakdown: {_name(v)} gần như a cappella, nhạc chỉ còn một lớp mờ")
            if fx.get("buildup"):
                p.events.append({"type": "riser", "at": at + bars * 2, "beats": bars * 2})
            prev_clips, prev_bed, prev_voice = clips, pad, (v, run)
            at += bars * 4
    # Outro: the last band's loop rings on, the last line echoing, a fade.
    oc = _tail_clips(p, prev_bed, at, d.outro)
    if fx.get("filter"):
        for c in oc:
            c["auto"]["lp"] = [[at, 18000.0], [at + d.outro * 4, 1200.0]]
    if fx.get("echo") and prev_voice is not None:
        p.events.append({"type": "echo", "role": "vocals", "at": at - 1, "beats": 1, "seek": 4})
    p.events.append({"type": "fadeout", "at": at + max(0, d.outro * 4 - 16), "beats": min(16, d.outro * 4)})
    p.section("outro", at, d.outro, [prev_bed.song.id], [])
    p.moves.append("Outro: câu cuối vọng lại, nhạc tắt dần")
    p.end = at + d.outro * 4
    return p


def _apply_seam(p: _Plan, seam: dict, at: int, prev_clips: list, prev_bed: Bed, same: bool, first: bool,
                lead: int) -> dict:
    """Adds the move between what was playing up to `at` and what starts
    there (an act's `lead` bars of band alone first); returns what the
    incoming band's clips take (automation)."""
    kind = seam["type"]
    bars = seam.get("bars", 4)
    fx = p.fx
    entry = {}

    def outgoing(key, points):
        for c in prev_clips:
            c["auto"][key] = c["auto"].get(key, []) + [list(pt) for pt in points]

    if kind in ("straight", "cut") or (same and kind in ("blend", "mash")):
        return entry
    if kind == "build":
        span = bars * 4
        if not first:  # (the intro is filtered already)
            outgoing("hp", [[at - span, 25.0], [at, 450.0]])
        p.events.append({"type": "riser", "at": at - span, "beats": span})
        p.events.append({"type": "impact", "at": at})
        if not first:
            p.events.append({"type": "gap", "at": at - 1, "beats": 1})
        p.moves.append("Build-up vào thẳng điệp khúc" if first else "Build-up dồn lên, drop sang nhạc mới")
    elif kind in ("blend", "mash"):
        # The two bands overlap for the lead and the bars after it: the old one
        # fades, its bass handed over halfway, then it darkens away under the
        # new voice; the new one rises from thin to full (an EQ blend).
        s = max(lead, bars) * 4
        tail = 16
        for c in _tail_clips(p, prev_bed, at, (s + tail) // 4):
            c["auto"]["gain"] = [[at, 0.0], [at + s * 0.75, -4.0], [at + s, -10.0], [at + s + tail, -40.0]]
            c["auto"]["low"] = [[at + s / 2 - 0.5, 1.0], [at + s / 2 + 0.5, 0.0]]
            c["auto"]["lp"] = [[at + s, 18000.0], [at + s + tail, 700.0]]
        entry = {"auto": {"gain": [[at, -12.0], [at + s * 0.5, -3.0], [at + s, 0.0]],
                          "low": [[at + s / 2 - 0.5, 0.0], [at + s / 2 + 0.5, 1.0]],
                          "hp": [[at, 180.0], [at + s / 2, 25.0]]}}
        p.moves.append(f"Blend {s // 4} ô nhịp: hai nền đan nhau, đổi bass giữa chừng")
    elif kind == "echo":
        p.events.append({"type": "echo", "role": "mix", "at": at - 1, "beats": 1})
        outgoing("gain", [[at - 0.5, 0.0], [at, -40.0]])
        entry = {"auto": {"lp": [[at, 500.0], [at + max(8, lead * 4), 18000.0]]}}
        p.moves.append("Echo out: câu cuối vọng lại, nhạc mới mở dần")
    elif kind == "wash":
        p.events.append({"type": "wash", "at": at - 8, "beats": 8})
        entry = {"auto": {"lp": [[at, 300.0], [at + max(16, lead * 4), 18000.0]], "gain": [[at, -8.0], [at + 8, 0.0]]}}
        p.moves.append("Reverb wash: tan vào tiếng vang")
    elif kind == "open":
        entry = {"auto": {"hp": [[at - 4, 600.0], [at, 25.0]]}}
        p.events.append({"type": "impact", "at": at})
        p.moves.append("Nhạc trở lại đầy đủ")
    elif kind in ("roll", "gate", "brake", "spin"):
        span = {"roll": 4, "gate": 8, "brake": 2, "spin": 2}[kind]
        p.events.append({"type": kind, "at": at - span, "beats": span})
        if kind != "gate":
            p.events.append({"type": "impact", "at": at})
        p.moves.append({"roll": "Cuộn nhịp vào drop", "gate": "Gate băm nhịp rồi chuyển",
                        "brake": "Phanh đĩa rồi vào", "spin": "Spinback rồi vào"}[kind])
    return entry


def _realise_act(p: _Plan, a: Act, at: int, entry: dict, offset: int = 0, shown_bed: Song | None = None
                 ) -> tuple[list, tuple]:
    """An act from `at`: its band (from `offset` bars in, after a mash), the
    band alone for its lead, then the voice (or two in the finale). The
    original song of a medley plays as it is, its own voice in it."""
    v, b = a.singer, a.bed.song
    clips = _bed_clips(p, a.bed, at, **entry)
    start_bar = a.run.hook_bar - a.verse
    sing_at = at + a.lead * 4
    hook_at = sing_at + a.verse * 4
    flipped = v is not b and any(m.endswith(f"trên nhạc {_name(v)}") for m in p.moves)
    if a.lead and not a.verse:
        p.section("drop", at, a.lead, [b.id], [], label="Nhạc dạo")
    if a.verse:
        p.section("verse", at, a.lead + a.verse, [(shown_bed or b).id] if offset >= a.lead + a.verse else [b.id],
                  [v.id])
    # The band changes loop for the chorus: the verse loop thins out over its
    # last two bars (a high-pass rising) into it, with a swell of noise when
    # the chorus loop is the bigger one, and a hit when it is much bigger.
    if a.verse >= 4 and a.bed.calm is not None and a.bed.drive is not None and a.bed.calm is not a.bed.drive \
            and not a.home:
        for c in clips:
            if c["at"] < hook_at <= c["at"] + c["mbeats"]:
                c["auto"]["hp"] = c["auto"].get("hp", []) + [[hook_at - 8, 25.0], [hook_at, 320.0]]
        lift = a.bed.drive.intensity - a.bed.calm.intensity
        if p.fx.get("buildup") and lift >= 0.05:
            p.events.append({"type": "riser", "at": hook_at - 8, "beats": 8})
            if lift >= 0.15:
                p.events.append({"type": "impact", "at": hook_at})
    if a.home:
        p.section("chorus", hook_at, a.hook, [b.id], [v.id])
        p.moves.append(f"{_name(v)} nguyên bản")
        return clips, (v, a.run)
    pickup = 4 if a.lead else 2
    if a.layer is None:
        p.voice(v, start_bar, sing_at, (a.verse + a.hook) * 4, pickup=pickup)
        p.section("chorus", hook_at, a.hook, [b.id], [v.id])
        if not offset:
            p.moves.append(f"{'Đảo vai: ' if flipped else ''}{_name(v)} hát trên nhạc {_name(b)}"
                           + ("" if a.verse else " (điệp khúc)"))
    elif not a.trade:
        # Two hooks at once: the act's voice leads, the other sits under it.
        w, wr = a.layer, a.layer_run
        p.voice(v, start_bar, sing_at, (a.verse + a.hook) * 4, pickup=pickup)
        p.voice(w, wr.hook_bar, hook_at, a.hook * 4, gain=-5.0, lead2=True, send=0.25)
        p.section("finale", hook_at, a.hook, [b.id], [v.id, w.id], label="Finale: hai hook")
        p.moves.append(f"Cao trào: hook {_name(v)} và hook {_name(w)} cùng lúc trên nhạc {_name(b)}")
    else:
        # Trading lines, four bars each, each line whole; the act's voice
        # sings its verse and the first line in one go.
        w, wr = a.layer, a.layer_run
        chunk = 16
        k = 1
        p.voice(v, start_bar, sing_at, a.verse * 4 + chunk, pickup=pickup, tail=2)
        while k * chunk < a.hook * 4:
            n = min(chunk, a.hook * 4 - k * chunk)
            who, run = (w, wr) if k % 2 else (v, a.run)
            p.voice(who, run.hook_bar + (k * chunk) // 4, hook_at + k * chunk, n, pickup=2, tail=2)
            k += 1
        p.section("finale", hook_at, a.hook, [b.id], [v.id, w.id], label="Finale: đối đáp")
        p.moves.append(f"Cao trào: {_name(v)} và {_name(w)} hát đối đáp trên nhạc {_name(b)}")
    return clips, (v, a.run)


# ------------------------------------------------------------------- entry

def clean_options(opts: dict) -> dict:
    """The listener's options, checked and completed."""
    ids = [t for t in dict.fromkeys(opts.get("ids") or []) if library.valid_id(t)]
    if not MIN_SONGS <= len(ids) <= MAX_SONGS:
        raise PlanError(f"Chọn từ {MIN_SONGS} tới {MAX_SONGS} bài")
    length = float(opts.get("length") or 180)
    fx = opts.get("fx") or {}
    key = opts.get("key")
    if key is not None:
        key = str(key).upper()
        if not (key[:-1].isdigit() and 1 <= int(key[:-1]) <= 12 and key[-1] in "AB"):
            key = None
    bpm = opts.get("bpm")
    style = STYLE_ALIAS.get(opts.get("style"), opts.get("style"))
    variant = opts.get("variant")
    return {
        "ids": ids,
        "roles": {t: r for t, r in (opts.get("roles") or {}).items() if t in ids and r in ROLES},
        "style": style if style in STYLES else "auto",
        "vibe": opts.get("vibe") if opts.get("vibe") in VIBES else "auto",
        "length": float(min(MAX_SECONDS, max(MIN_SECONDS, length))),
        "bpm": float(bpm) if isinstance(bpm, (int, float)) and 60 <= bpm <= 200 else None,
        "key": key,
        "fx": {k: bool(fx.get(k, FX_DEFAULT[k])) for k in FX},
        "variant": int(variant) if isinstance(variant, (int, float)) and 0 <= variant < 1000 else 0,
        "pace": opts.get("pace") if opts.get("pace") in PACES else "fast",
    }


def make(opts: dict) -> dict:
    """The plan for a mashup from the listener's (cleaned) options."""
    songs = load_songs(opts["ids"], opts["roles"])
    frame = _frame(songs, opts)
    spb = 60.0 / frame["bpm"]
    rate = RESAMPLE.get(frame["vibe"], 1.0)
    # The form is sized on the length as heard (after a slowed or sped-up resample).
    nbars = max(24, int(round(opts["length"] * rate / (4 * spb))) // 4 * 4)
    fx = dict(opts["fx"])
    if frame["vibe"] == "acoustic":
        fx["buildup"] = fx["roll"] = fx["gate"] = False
    # Many drafts from one seed (the songs and options): the best distinct ones
    # in order; the listener's variant n is the n-th.
    pace = opts.get("pace", "fast")
    seed = int.from_bytes(hashlib.sha1(repr((sorted(opts["ids"]), opts["style"], frame["vibe"], nbars, pace,
                                                 sorted(fx.items()), sorted(opts["roles"].items()))).encode())
                          .digest()[:4], "big")
    cache: dict = {}
    drafts, seen = [], set()
    errors = []
    lead = LEAD if LEAD * 4 * spb / rate <= LEAD_MAX_S else 2
    # A fast mashup rings out in a few seconds (8 bars, 4 at a slow tempo).
    cap = 16 if pace == "natural" else 8 if 8 * 4 * spb / rate <= OUTRO_MAX_S else 4
    for k in range(CANDIDATES):
        rng = random.Random(seed + 7919 * k)
        try:
            d = _draft(songs, opts["style"], nbars, fx, rng, cache, pace, lead, cap)
        except PlanError as e:
            errors.append(str(e))
            continue
        if d.signature in seen:
            continue
        seen.add(d.signature)
        drafts.append(d)
    if not drafts:
        raise PlanError(errors[0] if errors else "Không ghép được các bài này với nhau, thử bài khác")
    drafts.sort(key=lambda d: -d.score)
    variant = opts.get("variant", 0) % len(drafts)
    p = _realise(drafts[variant], songs, frame, fx)
    beats = p.end
    for s in p.sections:
        s["t0"] = round(s["beat"] * spb / rate, 3)
        s["t1"] = round((s["beat"] + s["beats"]) * spb / rate, 3)
    p.events = [e for e in p.events if e["type"] != "chop"
                or e["beat"] + int(round(4 * e["r"])) <= p.songs[e["src"]].n - 2]
    used = {c["src"] for c in p.clips} | {e["src"] for e in p.events if "src" in e}
    voiced = {c["src"] for c in p.clips if c["role"] == "vocals"}
    played = {c["src"] for c in p.clips if c["role"] == "music"}
    notes = list(frame["notes"])
    for sid in sorted({c["src"] for c in p.clips if c["role"] == "music" and c["stem"] == "inst"}):
        notes.append(f"«{p.songs[sid].title}» không có đoạn thuần nhạc đủ dài: nhạc của nó được tách khỏi giọng")
    return {
        "version": 3,
        "style": opts["style"],
        "pace": pace,
        "variant": variant,
        "variants": len(drafts),
        "vibe": frame["vibe"],
        "bpm": frame["bpm"],
        "rate": rate,
        "key": {"camelot": f"{frame['number']}{frame['letter']}", "name": key_name(frame["number"], frame["letter"])},
        "mood": frame["mood"],
        "bars": beats // 4,
        "beats": beats,
        "spb": spb,
        "seconds": round(beats * spb / rate, 2),
        "fx": fx,
        "sources": [{"id": s.id, "title": s.title, "artist": s.artist,
                     "use": "both" if s.id in voiced and s.id in played else "vocals" if s.id in voiced else "music",
                     "r": s.r, "stretch": round(frame["bpm"] * s.r / s.bpm, 4), "semis": s.semis}
                    for s in songs if s.id in used],
        "sections": p.sections,
        "moves": p.moves,
        "clips": p.clips,
        "events": p.events,
        "notes": notes,
    }

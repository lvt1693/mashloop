// The player decides, one beat at a time, what plays next: carry on, jump inside
// the song, or leave for another song through a planned transition. Decisions are
// made LOOKAHEAD seconds before they are heard and scheduled sample-accurately.

const LOOKAHEAD = 0.6;
const TICK_MS = 40;
const SPLICE_XFADE = 0.012;
const SEEK_XFADE = 0.04; // a seek lands anywhere, not on an analysed splice: a gentler crossfade
// Passes through the last branch point, landing near the end each time with
// no other jump in between, after which it jumps as far back as it can.
const END_PASSES = 3;
const RAMP_BEATS = 32;
const JUMP_COOLDOWN = 4;
const LOAD_LEAD = 3; // seconds needed to fetch and decode a song that is not prefetched
// Seconds a transition needing more than the next song's audio (vocal stems, a
// key-locked voice) must be planned ahead, to have them ready in time.
const PREP_LEAD = 5;
const PREFETCH_LEAD = 20; // start loading likely next songs this long before leaving is allowed
// Smooth hand-overs first: beat-matched moves, then long filtered crossfades
// and echoes, then the accents (build-up, flanger, a beat of silence); the
// abrupt effects (brake, roll, spinback, gate) last and off by default.
const TYPE_BIAS = {
  cut: 0.08, drop: 0.02, blend: 0.06, fade: 0.0, echo: -0.08, wash: -0.06, riser: -0.06, flanger: -0.08, gap: -0.1,
  roll: -0.12, gate: -0.12, brake: -0.15, spin: -0.15,
};
// Variety: the same kind twice in a row, and an effect soon after another,
// sound like a machine at work (listeners rate predictable transitions lower).
const SAME_KIND_PENALTY = 0.15;
const RECENT_FX_PENALTY = 0.3;
// The signature blends (a mashup, a double drop, a loop) are a treat: the
// same one again within three hand-overs costs as much as a recent effect.
const SIGNATURE = new Set(["mashup", "double", "loop"]);
// Utility lost per unit of mood distance between the songs: the chain drifts
// from style to style rather than lurching from a dance track to a ballad.
const MOOD_WEIGHT = 0.35;
// Effect transitions: the old song winds down over a few beats (echo, wash,
// brake, roll, build-up, spinback, gate, flanger, a beat of silence) and the
// new one comes in on its own tempo, no beat matching needed.
const FX = new Set(["echo", "wash", "brake", "roll", "riser", "spin", "gate", "flanger", "gap"]);
// Effects after which the new song comes in filtered, under the old one's tail.
const FX_UNDER_TAIL = new Set(["echo", "wash", "flanger"]);
const KILL = -60; // dB: a band switched off (engine.KILL_DB)
// Beats over which the playing song bends toward the meeting tempo before a
// tempo-bridged junction: at least 16, more for a wider gap, so the ramp
// stays under a quarter of a percent per beat (key-locked, its pitch kept).
const BEND_BEATS = 16;
const BEND_PER_BEAT = 0.0025;
const bendBeats = (pre) => Math.min(32, Math.max(BEND_BEATS, Math.ceil(Math.abs(Math.log(pre || 1)) / BEND_PER_BEAT)));
const bends = (tr) => Math.abs((tr.pre || 1) - 1) > 0.004;
// Beats per semitone over which a transposed song glides back to its own
// pitch once it plays alone: under 5 cents a second at 120 BPM, a drift
// nobody hears.
const PITCH_BEATS = 48;
// The setting that switches a kind of transition on or off.
export const allowKey = (type) => type;
// Hand-overs that keep the beat running: the next song comes in locked to it.
const BEAT_MATCHED = new Set(["cut", "drop", "blend"]);

// What the chain looks for in the next song (settings.criterion). Every
// criterion is a weighting, never a filter, so the chain cannot get stuck in
// a song with no exit that fits: it waits a little longer for a good one, and
// past dwellMax takes what there is.
//   mood: utility lost per unit of mood distance
//   beat: lost by a hand-over that does not keep the beat (fade, echo, ...)
//   tempo: lost per octave of tempo gap (bending, or the BPMs apart)
//   key: gained per unit of key fit on the Camelot wheel, centred on 0.6
//   explore: weight of the recency penalty; noise: random spread
//   ahead: weight of how well the chain could carry on from the next song
//          (one step ahead), so it does not walk into a dead end
//   arc: weight of the set's energy shape (setPhase)
//   vary: lost by a hand-over that keeps the energy where it is, after three
//          in a row that did: the chain moves up or down now and then
export const CRITERIA = {
  balanced: { mood: MOOD_WEIGHT, beat: 0, tempo: 0, key: 0, explore: 1, noise: 0.03, ahead: 0.15, arc: 0, vary: 0.12 },
  mood: { mood: 3.0, beat: 0, tempo: 0, key: 0, explore: 1, noise: 0.03, ahead: 0.15, arc: 0, vary: 0.12 },
  tempo: { mood: 0.15, beat: 0.45, tempo: 3, key: 0, explore: 1, noise: 0.03, ahead: 0.15, arc: 0, vary: 0.12 },
  key: { mood: 0.15, beat: 0, tempo: 0, key: 0.9, explore: 1, noise: 0.03, ahead: 0.15, arc: 0, vary: 0.12 },
  set: { mood: 0.3, beat: 0.15, tempo: 0, key: 0, explore: 1, noise: 0.03, ahead: 0.3, arc: 0.9, vary: 0 },
  free: { mood: 0, beat: 0, tempo: 0, key: 0, explore: 2, noise: 0.4, ahead: 0, arc: 0, vary: 0 },
};
// Energies this close count as the same level (the energy scale is 0..1).
const FLAT_ENERGY = 0.12;

// A DJ set's energy, hand-over by hand-over. The target is a place among the
// energies the playing song's exits lead into (0 the calmest, 1 the most
// driving), so it fits any library: a warm-up over the first four songs, then
// rounds of six that move every way a set does: cruising, building to the
// peak, a breather (a section with the drums out, a calmer song), and the
// lift straight out of it back to full energy (the drop after a breakdown),
// held one more song before the round starts again.
const SET_WARMUP = [0.3, 0.45, 0.6, 0.7];
const SET_ROUND = [0.7, 0.85, 0.95, 0.15, 0.9, 0.8];
const SET_ROUND_PHASE = ["cruise", "build", "peak", "breather", "lift", "peak"];
export function setPhase(n) {
  if (n < SET_WARMUP.length) return { target: SET_WARMUP[n], phase: "warmup" };
  const k = (n - SET_WARMUP.length) % SET_ROUND.length;
  return { target: SET_ROUND[k], phase: SET_ROUND_PHASE[k] };
}
// The hand-overs made to lift a set (a build-up, a drop, a swap on B's drop,
// both drops at once, a beat of silence before the hit) and those made to
// let it down (an echo, a wash, a long crossfade, a flanger, a filter blend).
const LIFTS = (tr) => ["riser", "drop", "gap"].includes(tr.type) || (tr.type === "blend" && ["swap", "double"].includes(tr.style));
const SETTLES = (tr) => ["echo", "wash", "fade", "flanger"].includes(tr.type) || (tr.type === "blend" && tr.style === "filter");

const parseCamelot = (s) => {
  const m = /^(\d{1,2})([AB])$/.exec(s || "");
  return m ? { n: +m[1], l: m[2] } : null;
};

// How well two keys sit together for a DJ (the Camelot wheel): same key 1,
// a step round the wheel 0.85, the relative major or minor 0.8, two steps
// 0.35, anything else 0. B's key moves with the pitch shift of the bridge
// (a semitone up is 7 steps round the wheel).
const wheelStep = (n, semis) => ((((n - 1 + 7 * Math.round(semis)) % 12) + 12) % 12) + 1;

// A Camelot key moved by a pitch shift, as the listener hears it in the mix.
export function shiftCamelot(cam, semis = 0) {
  const k = parseCamelot(cam);
  return k ? `${wheelStep(k.n, semis)}${k.l}` : cam;
}

export function keyFit(camA, camB, semis = 0) {
  const a = parseCamelot(camA), b = parseCamelot(camB);
  if (!a || !b) return 0.6;
  const nb = wheelStep(b.n, semis);
  const d = Math.min((a.n - nb + 12) % 12, (nb - a.n + 12) % 12);
  if (a.l === b.l) return d === 0 ? 1 : d === 1 ? 0.85 : d === 2 ? 0.35 : 0;
  return d === 0 ? 0.8 : 0;
}

// The tempo gap a transition has to cover, in octaves: the bending of a
// beat-matched hand-over, or how far apart the two songs' tempos are
// (double and half time count as the same tempo).
export function tempoGap(bpmA, bpmB, tr) {
  if (BEAT_MATCHED.has(tr.type)) {
    return Math.abs(Math.log2(tr.rate || 1)) + Math.abs(Math.log2(tr.pre || 1)) + ((tr.m || 1) !== 1 ? 0.04 : 0);
  }
  if (!bpmA || !bpmB) return 0.15;
  const r = Math.log2(bpmB / bpmA);
  return Math.abs(r - Math.round(r));
}

function sampleCurve(fn, n = 256) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.max(0, Math.min(1, fn(i / (n - 1))));
  return c;
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const FADE_A = sampleCurve((x) => Math.cos((Math.PI / 2) * x));
const db = (d) => Math.pow(10, d / 20);

// The faders of a blend, by style, over the window (x: 0..1; xP: the bar line
// of the bass swap; xBar: the end of the first bar). Both are scaled so the
// mix stays at one level (1/sqrt of the summed power, with the share of each
// song's power its EQ lets through), instead of swelling ~3 dB in the middle.
//   long, eq  B rises to -6 dB over its first bar, -2 dB by the swap, full at
//             the end; A holds until the swap, then leaves (Vande Veire 2018).
//   short     equal power: B up by the swap, A out after it.
//   filter    B rises under A, which holds and is cut on the last downbeat.
//   swap      B builds up under A to -3 dB by three quarters, full on its drop
//             at the end, where A is cut.
//   double    B builds up under A the same way to its drop at the middle
//             (xP), then both drops play at full together; A is cut at the end.
//   mashup    B (its voice alone) up within the first beat and held; A (its
//             band alone) held until the final bars (xS), then out by the end.
//   acapella  the same over eight bars: B's voice up at once, A (its band
//             alone) held to the middle, then out by the end; B's own band
//             rises under its voice from a quarter to three quarters.
function blendFaders(style, xP, xBar, xS = 0.875) {
  const cutAtEnd = style === "filter" || style === "swap" || style === "double";
  const fB = (x) => {
    if (style === "short") return Math.sin((Math.PI / 2) * clamp01(x / xP));
    if (style === "filter") return db(-1) * Math.sin((Math.PI / 2) * clamp01(x / 0.5));
    if (style === "swap") return x < 0.75 ? db(-3) * Math.sin((Math.PI / 2) * (x / 0.75)) : db(-3 + (3 * (x - 0.75)) / 0.25);
    if (style === "double") return x < xP ? db(-3) * Math.sin((Math.PI / 2) * (x / xP)) : 1;
    if (style === "mashup") return Math.sin((Math.PI / 2) * clamp01(x / 0.02));
    if (style === "acapella") return Math.sin((Math.PI / 2) * clamp01(x / 0.04));
    if (x < xBar) return 0.5 * Math.sin((Math.PI / 2) * (x / xBar));
    if (x < xP) return db(-6 + (4 * (x - xBar)) / Math.max(1e-6, xP - xBar));
    return db(-2 + (2 * (x - xP)) / Math.max(1e-6, 1 - xP));
  };
  const fA = (x) => {
    if (cutAtEnd) return x < 0.985 ? 1 : (1 - x) / 0.015;
    if (style === "mashup") return x < xS ? 1 : Math.cos((Math.PI / 2) * clamp01((x - xS) / (1 - xS)));
    return x < xP ? 1 : Math.cos((Math.PI / 2) * clamp01((x - xP) / (1 - xP)));
  };
  // B's band comes up under its voice (acapella, mashup): its share of B's power.
  const bandIn = (x, from, to) => 0.3 + 0.7 * clamp01((x - from) / Math.max(1e-6, to - from));
  const share = (x, who) => {
    // A high-pass up to 400 Hz takes little of a full mix's power; measured in
    // Chrome, this keeps the middle of a filter hand-over at the others' level.
    if (style === "filter") return who === "A" ? 1 - 0.2 * x : 0.5 + 0.5 * x;
    if (style === "swap") return who === "A" ? 1 : 0.45; // B without its bass and its highs down
    if (style === "double") return who === "A" ? (x < xP ? 1 : 0.6) : x < xP ? 0.45 : 1;
    // A band without its voice keeps ~80 % of its power, a voice alone ~30 %.
    if (style === "mashup") return who === "A" ? 0.8 : bandIn(x, xS, 1);
    if (style === "acapella") return who === "A" ? 0.8 : bandIn(x, 0.25, 0.75);

    return (who === "A") === (x < xP) ? 1 : 0.6; // the song without its bass carries ~60 % of its power
  };
  const comp = (x) => Math.min(1, 1 / Math.sqrt(fA(x) ** 2 * share(x, "A") + fB(x) ** 2 * share(x, "B") + 1e-9));
  return { A: sampleCurve((x) => fA(x) * comp(x)), B: sampleCurve((x) => fB(x) * comp(x)) };
}

// The style a stored blend asks for (older stores carry none: by its length).
const blendStyle = (tr, meter) => tr.style || (tr.len >= 16 * meter ? "long" : tr.len >= 8 * meter ? "eq" : "short");

export const DEFAULTS = {
  mode: "chain",
  jumpEvery: 20, // mean seconds between in-song jumps, whatever the tempo
  keep: 0.6, // fraction of each song's best jumps the walk may use
  dwellMin: 90, // a song may be left from here on, at the nearest good exit
  dwellMax: 200, // past this, the nearest exit is taken whatever its quality
  // Utility lost per second of waiting for an exit. 0.05: an exit 10 s later
  // must be 0.5 better in quality to be preferred (simulated: transitions start
  // a median 13 s after dwellMin, the wait mostly being the next phrase start).
  waitCost: 0.05,
  variety: 0.5,
  criterion: "balanced", // see CRITERIA
  allow: {
    cut: true, drop: true, blend: true, fade: true, echo: true, wash: true, riser: true, flanger: true, gap: true,
    brake: false, roll: false, spin: false, gate: false,
  },
  // How a blend may mix the two songs (each switched off, the chain picks among the rest).
  blendStyles: {
    long: true, eq: true, short: true, filter: true, swap: true, stem: true, acapella: true, loop: true, mashup: true,
    double: true,
  },
  // Key lock beyond tempo: the next song transposed up to two semitones to sit
  // in the playing one's key, and the playing one ramped toward a far tempo.
  keyShift: true,
  tempoRamp: true,
};

export class Player extends EventTarget {
  constructor(engine, loader) {
    super();
    this.engine = engine;
    this.loader = loader;
    this.settings = structuredClone(DEFAULTS);
    this.enabled = () => true;
    this.bias = () => 0; // extra appeal of handing over to a song (main.js: staying in a sample library)
    this.timer = null;
    this.reset();
  }

  reset() {
    this.cur = null;
    this.nextTime = 0;
    this.lastJumpAt = -Infinity;
    this.lastChanceAt = -Infinity;
    this.prefetchIds = [];
    this.prefetchedFor = null;
    this.cooldown = 0;
    this.ramp = null;
    this.pitchRamp = null;
    this.hold = 1;
    this.blend = null;
    this.fx = null;
    this.plan = null;
    this.jumpNow = false;
    this.seekTarget = null;
    this.endPasses = 0;
    this.urgent = false;
    this.history = [];
    this.timeline = [];
    this.visits = new Map();
    this.stats = { jumps: 0, transitions: 0, startedAt: 0 };
  }

  get playing() {
    return this.timer !== null && this.engine.ctx.state === "running";
  }

  async start(trackId) {
    const track = await this.loader.get(trackId);
    this.engine.stopAll();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.reset();
    await this.engine.ctx.resume();
    const t = this.engine.now + 0.15;
    this.stats.startedAt = t;
    const voice = this.engine.voice(track);
    voice.start(t, track.beats[0], 1, 0.01);
    this.cur = { track, beat: 0, rate: 1, voice };
    this._enterTrack(track, t, "start");
    this._log(t, "start");
    this.nextTime = t + track.dur[0];
    this.timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
    this.dispatchEvent(new Event("state"));
  }

  async togglePause() {
    if (!this.cur) return;
    const ctx = this.engine.ctx;
    if (ctx.state === "running") await ctx.suspend();
    else await ctx.resume();
    this.dispatchEvent(new Event("state"));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine.stopAll();
    this.reset();
    this.dispatchEvent(new Event("state"));
  }

  requestJump() {
    this.jumpNow = true;
  }

  // The listener tapped the ring: play from that beat of the playing song, on
  // the next beat. Refused (false) while a hand-over to another song is under
  // way; seekError says why ("busy", or "gone": nothing playing).
  seek(beat) {
    this.seekError = null;
    if (!this.cur) return ((this.seekError = "gone"), false);
    if (this.blend || this.fx) return ((this.seekError = "busy"), false);
    const T = this.cur.track;
    this.seekTarget = Math.max(0, Math.min(T.n - 1, Math.round(beat)));
    return true;
  }

  // Where a seek to beat b lands: on the beat of b's bar that sits where the
  // beat about to play would have sat, so the meter carries straight on.
  _seekBeat(T, i, b) {
    const pos = T.analysis.pos;
    const meter = T.analysis.meter || 4;
    if (!pos) return b;
    let d = b;
    for (let k = 0; k < meter && d > 0 && pos[d] !== 0; k++) d--;
    if (pos[d] !== 0) return b;
    const next = i + 1 < T.n ? pos[i + 1] : (pos[i] + 1) % meter;
    return Math.max(0, Math.min(T.n - 1, d + next));
  }

  // Forget the planned exit (settings changed); a bent tempo bends back.
  cancelPlan() {
    if (this.plan) this._dropPlan();
  }

  // Score limit for this song's jumps under the current strictness setting.
  maxScore(T) {
    return T.scoreCut(this.settings.keep);
  }

  requestNextSong() {
    if (!this.cur || this.blend || this.fx) return;
    this.plan = null;
    this.urgent = true;
    this._prefetch(true);
  }

  // ---------------------------------------------------------------- scheduling

  _tick() {
    if (!this.cur || this.engine.ctx.state !== "running") return;
    const horizon = this.engine.now + LOOKAHEAD;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) this._advance();
  }

  _advance() {
    const t = this.nextTime;
    const step = this._decide(t);
    this._execute(step, t);
    this.nextTime = t + step.track.dur[step.beat] / step.rate;
  }

  // Playback rate for the next beat: follows the current ramp, then holds its
  // end value (1 after a song settles, the meeting tempo while bending).
  _rate() {
    const r = this.ramp;
    if (!r) return this.hold;
    r.k++;
    const v = r.from + (r.to - r.from) * Math.min(1, r.k / r.n);
    if (r.k >= r.n) {
      this.ramp = null;
      this.hold = r.to;
    }
    return v;
  }

  _rampTo(to, beats, from = this.cur ? this.cur.rate : 1) {
    if (Math.abs(from - to) < 1e-4) {
      this.ramp = null;
      this.hold = to;
    } else {
      this.ramp = { from, to, k: 0, n: Math.max(1, Math.round(beats)) };
    }
  }

  // Pitch (semitones) for the next beat of a transposed song gliding back to
  // its own; null when nothing is gliding.
  _pitch() {
    const p = this.pitchRamp;
    if (!p) return null;
    p.k++;
    const v = p.from + (p.to - p.from) * Math.min(1, p.k / p.n);
    if (p.k >= p.n) this.pitchRamp = null;
    return v;
  }

  // Where a transition is triggered on the walk: blends and effects begin when
  // the walk arrives at a beat; cuts, drops and fades happen after a beat ends.
  _triggerOf(tr) {
    if (tr.type === "blend") return { node: tr.a, arrive: true };
    if (FX.has(tr.type)) return { node: tr.i - (tr.beats || 1) + 1, arrive: true };
    return { node: tr.i, arrive: false };
  }

  // Abandon the planned exit; a song bent toward a meeting tempo bends back.
  _dropPlan() {
    // Key-locked voices prepared for it and never started (the next song's,
    // and the playing one's for a tempo ramp that had not begun).
    this.plan?.stretch?.dispose();
    this.plan?.stretchA?.dispose();
    this.plan = null;
    if (this.cur && Math.abs(this.cur.rate - 1) > 1e-3 && !this.blend && !this.fx) this._rampTo(1, BEND_BEATS);
  }

  _decide(t) {
    const { track: T, beat: i } = this.cur;

    if (this.blend) {
      const b = this.blend;
      const k = b.k + 1;
      // Over a loop of A, A's clock goes round the loop.
      if (k < b.L) return { kind: "blend", track: T, beat: b.a + (b.loop ? k % b.loop : k), rate: b.rateA, k };
      return { kind: "promote", track: b.B, beat: b.b + Math.round(b.m * b.L), rate: b.ratesB[b.L - 1] };
    }

    if (this.fx) {
      // The old song is winding down (its audio is already scheduled): keep
      // the clock on its beats, then the new song comes in.
      const f = this.fx;
      if (i < f.end && i + 1 < T.n) return { kind: "fxBeat", track: T, beat: i + 1, rate: this.cur.rate };
      return { kind: "fxDrop", track: f.B, beat: f.tr.j, rate: 1, tr: f.tr };
    }

    if (this.seekTarget != null) {
      // The planned exit was routed from where the song was: it is dropped
      // (the chain plans again from the new place), and a key-locked glide
      // home ends here, the song back at its own tempo and pitch.
      const beat = this._seekBeat(T, i, this.seekTarget);
      this.seekTarget = null;
      if (this.plan) this._dropPlan();
      this.ramp = null;
      this.pitchRamp = null;
      this.hold = 1;
      this.endPasses = 0;
      return { kind: "jump", track: T, beat, rate: 1, shift: 0, xf: SEEK_XFADE, seek: true };
    }

    if (this.cooldown > 0) this.cooldown--;

    if (this.settings.mode === "chain" && !this.plan) {
      const elapsed = t - this.dwellStart;
      if (elapsed >= this.settings.dwellMin - PREFETCH_LEAD) this._prefetch();
      // From the minimum time on, look for an exit on every beat until one is
      // planned: the nearest good one wins, not a fixed countdown.
      if (elapsed >= this.settings.dwellMin || this.urgent) this._planExit(t);
    }

    const plan = this.plan;
    if (plan) {
      const tr = plan.tr;
      // Tempo bridge: in the bars before the junction the playing song eases
      // toward the meeting tempo, so the next one can come in at it. It ramps
      // key-locked, on a voice of its own prepared for it (plan.stretchA),
      // once the route has made its last jump; without that voice in time it
      // does not ramp, and the next song covers the whole gap.
      const pre = tr.pre || 1;
      if (!plan.bent && Math.abs(pre - 1) > 1e-4) {
        const beatsLeft = (plan.eta - t) / (T.dur[i] / this.cur.rate);
        const free = plan.bendFrom == null || i >= plan.bendFrom;
        if (beatsLeft <= (plan.bendBeats || BEND_BEATS) + 1 && free && plan.stretchA) {
          plan.bent = true;
          if (beatsLeft >= 5) {
            plan.swapA = true;
            this._rampTo(pre, Math.max(2, Math.floor(beatsLeft) - 1));
          }
        } else if (beatsLeft < 5) {
          plan.bent = true;
        }
        if (plan.bent && !plan.swapA && plan.stretchA) {
          plan.stretchA.dispose();
          plan.stretchA = null;
        }
      }
      const routeJump = plan.jumps.get(i);
      const next = routeJump !== undefined ? routeJump : i + 1;
      const trg = this._triggerOf(tr);
      const atTrigger = trg.arrive ? next === trg.node : i === trg.node;
      if (atTrigger) {
        if (!plan.target || !plan.ready) {
          // Next song (or its stems, or its key-locked voice) not ready in
          // time: drop this exit; the next beat plans again and only considers
          // songs that are ready or far enough away.
          this._dropPlan();
        } else if (tr.type === "blend") {
          return { kind: "blendStart", track: T, beat: tr.a, rate: this._rate(), splice: routeJump !== undefined, shift: 0, tr };
        } else if (FX.has(tr.type)) {
          return { kind: "fxStart", track: T, beat: next, rate: this._rate(), splice: routeJump !== undefined, tr };
        } else {
          // B starts at the tempo A has actually reached (normally `pre`).
          const rate = tr.type === "fade" ? 1 : (tr.rate / pre) * this.cur.rate;
          return {
            kind: tr.type === "drop" ? "cut" : tr.type, track: plan.target, beat: tr.j, rate,
            shift: tr.shift_ms / 1000, xf: (tr.xf_ms || 12) / 1000, tr, stretch: plan.stretch || null,
          };
        }
      } else if (routeJump !== undefined) {
        const e = T.jumps[i].find((x) => x.to === routeJump);
        return { kind: "jump", track: T, beat: routeJump, rate: this._rate(), shift: e ? e.shift : 0, xf: e ? e.xf : SPLICE_XFADE, rho: e ? e.rho : 0 };
      } else if (i + 1 < T.n) {
        return { kind: "seq", track: T, beat: i + 1, rate: this._rate(), semis: this._pitch() };
      }
      if (this.plan) this._dropPlan();
    }

    const jump = this._walk(T, i, t);
    if (jump) {
      return { kind: "jump", track: T, beat: jump.to, rate: this._rate(), shift: jump.shift, xf: jump.xf, rho: jump.rho || 0, forced: !!jump.forced };
    }
    if (i + 1 < T.n) return { kind: "seq", track: T, beat: i + 1, rate: this._rate(), semis: this._pitch() };
    // Fell off the end (no backward jump available): loop to the first beat.
    return { kind: "jump", track: T, beat: 0, rate: this._rate(), shift: 0, xf: 0.04 };
  }

  // Random in-song jumps are paced in seconds, not beats: at least 35 % of the
  // mean interval apart, then an even chance per second of playing time, so a
  // 70 BPM ballad and a 170 BPM track move around at the same pace.
  _walk(T, i, t) {
    const s = this.settings;
    if (i >= T.lbp && T.lbp >= 0) {
      const back = T.jumps[i].filter((e) => e.to <= i);
      if (back.length) return { ...this._endJump(T, back), forced: true };
    }
    if (this.cooldown > 0) return null;
    // A key-locked song still gliding back to its own tempo holds its course:
    // its stretched audio covers what lies ahead, not the whole song.
    if (this.cur.voice?.stretched) return null;
    const limit = this.maxScore(T);
    const cands = T.eligible(i, this.jumpNow ? Math.max(limit, T.scoreCut(1)) : limit);
    if (!cands.length) return null;
    if (!this.jumpNow) {
      const minGap = 0.35 * s.jumpEvery;
      if (t - this.lastJumpAt < minGap) return null;
      const since = Math.max(this.lastChanceAt, this.lastJumpAt + minGap);
      this.lastChanceAt = t;
      const p = 1 - Math.exp(-Math.max(0, t - since) / (0.65 * s.jumpEvery));
      if (Math.random() >= p) return null;
    }
    // Prefer good matches, and places we have not landed on much, so the walk
    // keeps exploring the whole song.
    const visits = this._visits(T);
    const w = cands.map((e) => Math.exp(-e.score / 0.08) / (1 + 0.6 * visits[e.to]));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    let pick = cands[cands.length - 1];
    for (let k = 0; k < cands.length; k++) {
      r -= w[k];
      if (r <= 0) {
        pick = cands[k];
        break;
      }
    }
    this.jumpNow = false;
    this.endPasses = 0;
    return pick;
  }

  // The last branch point always jumps back, or the song would run out. Its
  // jumps are drawn like the walk's (good ones first, away from where it has
  // landed before), not always the best one: that one alone can lead into a
  // stretch near the end with no other way out, played again and again. And
  // when the walk keeps coming back here with no other jump in between, it
  // takes the jump that goes furthest back.
  _endJump(T, back) {
    this.endPasses++;
    if (this.endPasses >= END_PASSES) {
      this.endPasses = 0;
      return back.reduce((a, e) => (e.to < a.to ? e : a));
    }
    const visits = this._visits(T);
    const best = Math.min(...back.map((e) => e.score));
    const w = back.map((e) => Math.exp(-(e.score - best) / 0.15) / (1 + 1.5 * visits[e.to]));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let k = 0; k < back.length; k++) {
      r -= w[k];
      if (r <= 0) return back[k];
    }
    return back[back.length - 1];
  }

  _visits(T) {
    let v = this.visits.get(T.id);
    if (!v) {
      v = new Float32Array(T.n);
      this.visits.set(T.id, v);
    }
    return v;
  }

  _execute(step, t) {
    const prev = this.cur;
    const T = step.track;
    switch (step.kind) {
      case "seq":
        if (this.plan?.swapA && this.plan.stretchA) {
          // A tempo ramp begins: the playing song moves onto its key-locked
          // voice, crossfaded over 30 ms, and ramps on it from here.
          const x = 0.03;
          const v = this.plan.stretchA;
          this.plan.stretchA = null;
          this.plan.swapA = false;
          v.shift = prev.voice.shift || 0;
          v.semis = prev.voice.semis || 0; // still gliding home from a key shift, it carries on
          v.start(t - x / 2, T.beats[step.beat] + v.shift - (x / 2) * step.rate, step.rate, x);
          prev.voice.fadeOut(t - x / 2, x);
          this.cur = { ...prev, beat: step.beat, rate: step.rate, voice: v };
          break;
        }
        if (prev.voice.stretched && !this.ramp && !this.pitchRamp && !this.blend && !prev.voice.semis
          && Math.abs(step.rate - 1) < 1e-4) {
          // The key-locked glide is over: a plain voice takes over the read
          // head, crossfaded over 30 ms.
          const x = 0.03;
          const v = this.engine.voice(T);
          v.shift = prev.voice.shift;
          v.start(t - x / 2, T.beats[step.beat] + v.shift - x / 2, 1, x);
          prev.voice.fadeOut(t - x / 2, x);
          this.cur = { ...prev, beat: step.beat, rate: 1, voice: v };
          break;
        }
        if (step.rate !== prev.rate || step.semis != null) {
          prev.voice.setRate(t, step.rate, T.beats[step.beat] + (prev.voice.shift || 0), step.semis);
        }
        this.cur = { ...prev, beat: step.beat, rate: step.rate };
        break;

      case "jump":
      case "cut": {
        const x = step.xf || SPLICE_XFADE;
        const v = (step.kind === "cut" && step.stretch) || this.engine.voice(T);
        v.shift = step.shift || 0;
        // (The fade law follows how alike the two sides are: a cut to another song has no rho.)
        v.start(t - x / 2, T.beats[step.beat] + step.shift - (x / 2) * step.rate, step.rate, x, step.rho || 0);
        prev.voice.fadeOut(t - x / 2, x, step.rho || 0);
        this.cur = { track: T, beat: step.beat, rate: step.rate, voice: v };
        if (!v.stretched) this.pitchRamp = null; // a plain voice plays at the song's own pitch
        this.cooldown = JUMP_COOLDOWN;
        // The forced jump back from the end does not hold off the walk's own
        // jumps: a short stretch near the end must not shut them out.
        if (!step.forced) this.lastJumpAt = t;
        if (step.kind === "jump") {
          this.stats.jumps++;
          this._visits(T)[step.beat] += 1;
          this._log(t, "jump", { from: prev.beat, seek: !!step.seek });
        } else {
          // B glides from the meeting tempo back to its own.
          this._rampTo(1, RAMP_BEATS, step.rate);
          const via = step.tr?.type === "drop" ? "drop" : "cut";
          this._log(t, via, { from: prev.beat, fromTrack: prev.track.id, tr: step.tr });
          this._enterTrack(T, t, via, step.tr);
        }
        break;
      }

      case "fxStart":
        this._startFx(step, prev, t);
        break;

      case "fxBeat":
        this.cur = { ...prev, beat: step.beat, rate: step.rate };
        break;

      case "fxDrop": {
        const tr = step.tr;
        const v = this.engine.voice(T);
        if (FX_UNDER_TAIL.has(tr.type)) {
          // On the downbeat, under the ringing tail, the new song comes in
          // low-passed and opens over two bars, its bass back within one.
          const bar = (T.analysis.meter || 4) * T.dur[step.beat];
          v.setBand("low", t, -12);
          v.start(t, T.beats[step.beat], 1, 0.03);
          v.sweep(t, tr.type === "echo" ? 500 : 900, 18000, 2 * bar);
          v.rampBand("low", t, 0, bar);
        } else {
          // After a brake, a roll, a build-up, a spinback, a gate or a beat
          // of silence it lands on the beat.
          v.start(t, T.beats[step.beat], 1, 0.006);
        }
        this.cur = { track: T, beat: step.beat, rate: 1, voice: v };
        this.fx = null;
        this.ramp = null;
        this.hold = 1;
        this._log(t, tr.type, { fromTrack: prev.track.id, tr });
        this._enterTrack(T, t, tr.type, tr);
        if (tr.type === "echo") this.cooldown = Math.max(this.cooldown, 12);
        break;
      }

      case "fade": {
        const secs = step.tr.seconds || 4;
        const v = this.engine.voice(T);
        // B arrives filtered and without bass and opens up as A recedes; A
        // gives up its bass first, then darkens and sinks under B. The two
        // never fight in the same register, so even far-apart moods blur.
        v.setBand("low", t, -14);
        v.start(t, T.beats[step.beat], 1, secs * 0.7);
        v.sweep(t, 420, 18000, secs * 0.75);
        v.rampBand("low", t + secs * 0.45, 0, secs * 0.3);
        prev.voice.rampBand("low", t, -16, secs * 0.35);
        prev.voice.sweep(t + secs * 0.2, 16000, 700, secs * 0.8);
        prev.voice.gainCurve(FADE_A, t, secs);
        prev.voice.stopAt(t + secs + 0.05);
        this.cur = { track: T, beat: step.beat, rate: 1, voice: v };
        this.ramp = null;
        this.hold = 1;
        // No jumps while the old song is still fading out underneath.
        this.cooldown = Math.max(this.cooldown, Math.ceil(secs / T.dur[step.beat]) + 2);
        this._log(t, "fade", { from: prev.beat, fromTrack: prev.track.id, tr: step.tr });
        this._enterTrack(T, t, "fade", step.tr);
        break;
      }

      case "blendStart":
        this._startBlend(step, prev, t);
        break;

      case "blend":
        this.blend.k = step.k;
        this.cur = { ...prev, beat: step.beat, rate: step.rate };
        break;

      case "promote": {
        const b = this.blend;
        this.blend = null;
        b.voiceB.setRate(t, step.rate, b.B.beats[step.beat] + b.voiceB.shift);
        this.cur = { track: b.B, beat: step.beat, rate: step.rate, voice: b.voiceB };
        this._rampTo(1, RAMP_BEATS, step.rate);
        // A transposed B glides back to its own pitch now that it plays alone.
        const semis = b.voiceB.semis || 0;
        this.pitchRamp = semis ? { from: semis, to: 0, k: 0, n: Math.round(Math.abs(semis) * PITCH_BEATS) } : null;
        this._enterTrack(b.B, t, "blend", b.tr);
        this._log(t, "promote");
        break;
      }
    }
    if (step.kind === "seq" || step.kind === "blend" || step.kind === "fxBeat") this._log(t, step.kind);
  }

  _startBlend(step, prev, t) {
    const tr = step.tr;
    const A = step.track;
    const plan = this.plan;
    const B = plan.target;
    const L = tr.len;
    let voiceA = prev.voice;
    let outStart = t;
    if (step.splice) {
      const e = A.jumps[prev.beat].find((x) => x.to === step.beat);
      const x = e ? e.xf : SPLICE_XFADE;
      voiceA = this.engine.voice(A);
      voiceA.shift = e ? e.shift : 0;
      voiceA.start(t - x / 2, A.beats[step.beat] + (e ? e.shift : 0) - (x / 2) * step.rate, step.rate, x, e ? e.rho : 0);
      prev.voice.fadeOut(t - x / 2, x, e ? e.rho : 0);
      outStart = t + x / 2; // let the splice fade-in finish before the blend curve
      this.stats.jumps++;
      this.lastJumpAt = t;
    } else if (step.rate !== prev.rate) {
      voiceA.setRate(t, step.rate);
    }
    // Master clock: A's beats at A's rate (round and round its loop, for a
    // blend over a loop of A). B's rate per beat makes the stretch of B laid
    // over each A beat last exactly as long: one B beat, two (B in double
    // time, m = 2) or half of one (B in half time, m = 0.5).
    const m = tr.m || 1;
    const n = tr.loop || 0;
    const times = [t];
    const ratesB = [];
    const tB = [B.beats[tr.b] + tr.shift_ms / 1000];
    for (let k = 0; k < L; k++) {
      const dM = A.dur[tr.a + (n ? k % n : k)] / step.rate;
      times.push(times[k] + dM);
      let span = 0;
      if (m >= 1) for (let q = 0; q < m; q++) span += B.dur[Math.min(B.n - 1, tr.b + m * k + q)];
      else span = B.dur[Math.min(B.n - 1, tr.b + Math.floor(k * m))] * m;
      ratesB.push(Math.max(0.8, Math.min(1.25, span / dM)));
      tB.push(tB[k] + span);
    }
    // B key-locked (prepared ahead, its stem inside) or a plain voice; it is
    // resynced to its beat on every A beat.
    const voiceB = plan.stretch || this.engine.voice(B);
    voiceB.shift = tr.shift_ms / 1000;
    voiceB.startSilent(t, tB[0], ratesB[0]);
    for (let k = 1; k < L; k++) voiceB.setRate(times[k], ratesB[k], tB[k]);
    if (plan.vocals) {
      // Both songs' voices on their own stem for a hand-over by layers.
      voiceB.attachVocals(plan.vocals.B, t, tB[0], ratesB[0]);
      voiceA.attachVocals(plan.vocals.A, t, A.beats[tr.a] + (voiceA.shift || 0), step.rate);
    }
    if (n) {
      // A's first pass through the loop plays on; every pass after it is the
      // loop again (its stem too), until A is gone.
      const from = A.beats[tr.a] + (voiceA.shift || 0);
      voiceA.loop(times[n], from, from + (times[n] - times[0]) * step.rate, step.rate, times[L] + 0.05);
    }
    plan.stretchA?.dispose(); // prepared for a tempo ramp that did not happen
    this._mixBlend(tr, A, voiceA, voiceB, times, L, outStart);
    voiceA.stopAt(times[L] + 0.05);
    this.blend = { A, B, a: tr.a, b: tr.b, L, m, loop: n, k: 0, rateA: step.rate, ratesB, voiceB, times, tB, tr };
    this.ramp = null;
    this.hold = step.rate;
    this.plan = null;
    this.cur = { track: A, beat: step.beat, rate: step.rate, voice: voiceA };
    this._log(t, "blendStart", { tr, to: B.id, end: times[L] });
  }

  // The mix of a blend on A's beat clock (times[0..L]). The bass swap falls on
  // the bar line in the middle (P): B's low band comes in and A's goes on the
  // same downbeat, never both at once. Before it, B arrives thin (mids down,
  // highs well down); after it, A's highs fade away (Vande Veire & De Bie 2018:
  // shelves cut to -26 dB). A filter hand-over instead keeps them apart in
  // register: A high-passed 30 -> 400 Hz with rising resonance, B low-passed
  // 300 Hz -> open, the bass swapped on the last downbeat as A is cut. A drop
  // swap builds B up thin under A (no bass, highs down) and cuts A on B's drop.
  // With both vocal stems, a hand-over goes by layers: B comes in without its
  // voice, which takes over from A's at the swap ("stem"), or B's voice alone
  // sings over A's band before B's own band comes in ("acapella"; at length,
  // "mashup"). A double drop builds B up under A to both drops at once; a
  // blend over a loop of A is mixed as a regular one, the loop without A's
  // voice when it was sung.
  _mixBlend(tr, A, voiceA, voiceB, times, L, outStart) {
    const meter = A.analysis.meter || 4;
    const style = blendStyle(tr, meter);
    const layered = style === "stem" || style === "acapella";
    const regular = L >= 16 * meter ? "long" : L >= 8 * meter ? "eq" : "short";
    const base = style === "stem" || style === "loop" ? regular : style;
    const t0 = times[0];
    const tEnd = times[L];
    const total = tEnd - t0;
    const P = L >> 1;
    const tP = times[P];
    const at = (k) => times[Math.max(0, Math.min(L, k))];
    const beat = at(P) - at(P - 1);
    const xP = (tP - t0) / total;
    const xBar = Math.min(xP, (at(meter) - t0) / total);
    // The mashup's final quarter, where B's band rises under its voice: four
    // bars of sixteen, eight of thirty-two.
    const endBars = Math.max(1, Math.round(L / meter / 4));
    const tS = style === "mashup" ? at(L - endBars * meter) : tEnd;
    const f = blendFaders(base, xP, xBar, (tS - t0) / total);
    voiceB.gainCurve(f.B, t0, total);
    // A's curve may start a little later (after a splice into the window): it
    // is the same curve, entered where it stands at that time.
    const skip = Math.max(0, Math.min(0.5, (outStart - t0) / total));
    const curveA = skip > 0 ? f.A.subarray(Math.floor(skip * (f.A.length - 1))) : f.A;
    voiceA.gainCurve(curveA, outStart, tEnd - outStart);
    const swap = 0.015; // the swap itself: a few ms either side of the downbeat
    if (style === "filter") {
      voiceA.hpSweep(t0, 30, 400, total);
      voiceB.setBand("low", t0, KILL);
      voiceB.sweep(t0, 300, 20000, total);
      voiceB.rampBand("low", tEnd - swap, 0, 2 * swap);
      return;
    }
    if (style === "swap") {
      voiceB.setBand("low", t0, KILL);
      voiceB.setBand("high", t0, -12);
      voiceB.rampBand("high", at(L - 2 * meter), 0, tEnd - at(L - 2 * meter));
      voiceB.rampBand("low", tEnd - swap, 0, 2 * swap);
      return;
    }
    if (style === "double") {
      // B thin under A (no bass, highs down) up to its drop in the middle;
      // from the drop both play at full, the bass B's alone; A is cut at the end.
      voiceB.setBand("low", t0, KILL);
      voiceB.setBand("high", t0, -12);
      voiceB.rampBand("high", at(P - meter), 0, tP - at(P - meter));
      voiceB.rampBand("low", tP - swap, 0, 2 * swap);
      voiceA.rampBand("low", tP - swap, KILL, 2 * swap);
      return;
    }
    if (style === "mashup") {
      // B's voice alone over A's band from the first beat; in the final bars
      // B's band rises under its voice while A goes, the bass swapped halfway
      // through them.
      const tSw = at(L - (endBars >> 1) * meter);
      voiceA.vocals(t0, "instrumental", beat);
      voiceB.vocals(t0, "acapella");
      voiceB.vocals(tS, "full", tEnd - tS);
      voiceB.setBand("low", t0, KILL);
      voiceB.rampBand("low", tSw - swap, 0, 2 * swap);
      voiceA.rampBand("low", tSw - swap, KILL, 2 * swap);
      voiceA.rampBand("high", tS, -12, tEnd - tS);
      return;
    }
    if (style === "loop" && tr.stems) voiceA.vocals(t0, "instrumental", beat);
    if (layered) {
      voiceA.vocals(t0, "full");
      if (style === "stem") {
        // B without its voice until the swap, then its voice takes over from A's.
        voiceB.vocals(t0, "instrumental");
        voiceA.vocals(tP - beat, "instrumental", beat);
        voiceB.vocals(tP - beat / 2, "full", beat);
      } else {
        // B's voice alone over A's band (A's voice out), then B's own band
        // rising under it, a little more every beat from a quarter of the way
        // to three quarters, where the bass swaps; A's highs go from the middle.
        const tRise = at(L >> 2);
        const tSwap = at((3 * L) >> 2);
        voiceA.vocals(t0, "instrumental", beat);
        voiceB.vocals(t0, "acapella");
        voiceB.vocals(tRise, "full", tSwap - tRise);
        voiceB.setBand("low", t0, KILL);
        voiceB.rampBand("low", tSwap - swap, 0, 2 * swap);
        voiceA.rampBand("low", tSwap - swap, KILL, 2 * swap);
        voiceA.rampBand("high", tP, -12, tEnd - tP);
        return;
      }
    }
    voiceB.setBand("low", t0, KILL);
    voiceB.rampBand("low", tP - swap, 0, 2 * swap);
    voiceA.rampBand("low", tP - swap, KILL, 2 * swap);
    if (base === "short") {
      voiceB.setBand("high", t0, -12);
      voiceB.rampBand("high", t0, 0, tP - t0);
      voiceA.rampBand("high", t0, -12, tP - t0);
      return;
    }
    const tHalf = at(P >> 1);
    const tQuarter = at(P + (L >> 2));
    voiceB.setBand("high", t0, -26);
    voiceB.rampBand("high", t0, -6, tHalf - t0);
    voiceB.rampBand("high", tP, 0, at(P + meter) - tP);
    voiceB.setBand("mid", t0, -6);
    voiceB.rampBand("mid", tP - beat, 0, beat);
    voiceA.rampBand("high", tP, -12, tQuarter - tP);
    voiceA.rampBand("high", tQuarter, -26, tEnd - tQuarter);
  }

  // Effect transitions. The window is the last `beats` beats of A: an echo
  // feeds a dark delay that rings on, a brake slows the platter to a stop, a
  // roll replays the window's first beat in shrinking slices, a build-up
  // rises to an impact, a spinback throws the platter backwards, a gate chops
  // the song, a flanger sweeps it, a gap leaves its last beat silent. Then B
  // comes in on its own tempo at the end of the window.
  _startFx(step, prev, t) {
    const tr = step.tr;
    const A = step.track;
    const B = this.plan.target;
    const w = tr.beats || 1;
    const rate = step.rate;
    let voiceA = prev.voice;
    if (step.splice) {
      const e = A.jumps[prev.beat].find((x) => x.to === step.beat);
      const x = e ? e.xf : SPLICE_XFADE;
      voiceA = this.engine.voice(A);
      voiceA.shift = e ? e.shift : 0;
      voiceA.start(t - x / 2, A.beats[step.beat] + (e ? e.shift : 0) - (x / 2) * rate, rate, x, e ? e.rho : 0);
      prev.voice.fadeOut(t - x / 2, x, e ? e.rho : 0);
      this.stats.jumps++;
    } else if (rate !== prev.rate) {
      voiceA.setRate(t, rate);
    }
    const times = [t];
    for (let k = 0; k < w; k++) times.push(times[k] + A.dur[Math.min(A.n - 1, step.beat + k)] / rate);
    const end = times[w];
    const beat = A.dur[step.beat] / rate;
    if (tr.type === "echo") {
      // The last beat feeds a half-beat echo; the dry song is cut on the
      // downbeat and its echo rings on into the next one.
      this.engine.echoOut(voiceA, t, end, beat * 0.5);
      voiceA.fadeOut(end - 0.005, 0.01);
    } else if (tr.type === "wash") {
      // The song swells into a long reverb and is cut on the downbeat.
      this.engine.wash(voiceA, t, end);
      voiceA.fadeOut(end - 0.005, 0.01);
    } else if (tr.type === "brake") {
      voiceA.brake(t, end, rate);
    } else if (tr.type === "riser") {
      // Build-up: the song thins out under a rising noise sweep and is cut on
      // the downbeat, where an impact lands with the new song.
      voiceA.hpSweep(t, 30, 1200, end - t);
      this.engine.riser(t, end);
      this.engine.impact(end);
      voiceA.fadeOut(end - 0.005, 0.01);
    } else if (tr.type === "spin") {
      this.engine.spinback(voiceA, t, A.beats[step.beat] + (voiceA.shift || 0), end - t, rate);
    } else if (tr.type === "gate") {
      this.engine.gate(voiceA, times, A.analysis.meter || 4);
      voiceA.fadeOut(end - 0.005, 0.01);
    } else if (tr.type === "flanger") {
      this.engine.flanger(voiceA, t, end);
      voiceA.fadeOut(end - 0.005, 0.01);
    } else if (tr.type === "gap") {
      // A beat of silence: the song stops dead (its last hit let ring a few
      // ms), and the new one hits on the next downbeat.
      voiceA.fadeOut(t, 0.04);
    } else {
      // Roll: the window's first beat repeated whole four times, then in
      // halves, quarters and eighths (two bars), getting louder; shorter
      // windows (older stores) wind up faster.
      const pattern = w >= 8
        ? [1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25, ...Array(8).fill(0.125)]
        : w >= 2 ? [0.5, 0.5, 0.25, 0.25, 0.25, 0.25] : [0.25, 0.25, 0.25, 0.25];
      const unit = (end - t) / pattern.reduce((s, u) => s + u, 0);
      const slices = [];
      let when = t;
      pattern.forEach((u, n) => {
        slices.push({ when, offset: A.beats[step.beat], dur: u * unit, rate, level: 0.7 + (0.3 * n) / (pattern.length - 1) });
        when += u * unit;
      });
      this.engine.roll(A, slices, A.analysis.gain_db);
      voiceA.fadeOut(t - 0.004, 0.008);
    }
    this.fx = { A, B, tr, end: tr.i, times };
    this.plan = null;
    this.cur = { track: A, beat: step.beat, rate, voice: voiceA };
    this._log(t, "fxStart", { tr, to: B.id, end });
  }

  // ------------------------------------------------------------ chain planning

  // `tr`: the transition that led here (none at the start).
  _enterTrack(track, t, via, tr = null) {
    // Only a blend hands over a transposed song (its glide home set at the promote).
    if (via !== "blend") this.pitchRamp = null;
    const style = tr?.type === "blend" ? blendStyle(tr, track.analysis.meter || 4) : null;
    // Whether it kept the energy where it was (unknown: counted as a move).
    const flat = tr?.oe != null && tr?.ie != null && Math.abs(tr.ie - tr.oe) < FLAT_ENERGY;
    this.dwellStart = t;
    this.plan = null;
    this.urgent = false;
    this.endPasses = 0;
    this.seekTarget = null; // a seek asked for the song that is leaving
    this.prefetchedFor = null;
    this.prefetchIds = [];
    // Let the new song settle before the first random jump.
    this.lastJumpAt = t;
    this.cooldown = Math.max(this.cooldown, JUMP_COOLDOWN * 2);
    if (via !== "start") this.stats.transitions++;
    this.history.push({ id: track.id, at: t, via, style, flat });
    if (this.history.length > 50) this.history.shift();
    this.loader.refreshTransitions(track);
    this.dispatchEvent(new CustomEvent("track", { detail: { track, via, at: t } }));
  }

  // Penalty for going back to a song heard recently or often; negative (a
  // bonus) for songs not heard yet this session. Scaled by the variety setting.
  _recency(id) {
    const recent = this.history.map((h) => h.id).reverse();
    const idx = recent.indexOf(id);
    const scale = 0.4 + 1.2 * this.settings.variety;
    if (idx < 0) return -0.3 * scale;
    const window = Math.max(1, Math.min(6, this.loader.readyCount() - 1));
    const plays = recent.filter((x) => x === id).length;
    return scale * (0.8 * Math.max(0, 1 - idx / window) + 0.06 * plays);
  }

  // How much the chain wants this transition, apart from its quality and the
  // wait for it: the kind of hand-over, the chosen criterion, and whether the
  // song was heard lately.
  _appeal(T, tr) {
    const c = CRITERIA[this.settings.criterion] || CRITERIA.balanced;
    let u = (TYPE_BIAS[tr.type] ?? 0) - c.mood * (tr.mood ?? 0) - c.explore * this._recency(tr.to) + this.bias(tr.to);
    const h = this.history;
    if (h.length && h[h.length - 1].via === tr.type) u -= SAME_KIND_PENALTY;
    if (FX.has(tr.type) && h.slice(-3).some((e) => FX.has(e.via))) u -= RECENT_FX_PENALTY;
    if (tr.type === "blend" && SIGNATURE.has(tr.style) && h.slice(-3).some((e) => e.style === tr.style)) u -= RECENT_FX_PENALTY;
    if (c.beat || c.tempo || c.key) {
      const meta = this.loader.metas?.get(tr.to);
      if (c.beat && !BEAT_MATCHED.has(tr.type)) u -= c.beat;
      if (c.tempo) u -= c.tempo * tempoGap(T.analysis.bpm, meta?.bpm, tr);
      if (c.key) u += c.key * (keyFit(T.analysis.camelot, meta?.camelot, tr.semis ?? 0) - 0.6);
    }
    if (c.ahead) u += c.ahead * (this._onwardScore(T, tr.to) - 0.5);
    if (c.arc && tr.ie != null) {
      // A breather counts more: it is the one hand-over a set cannot do
      // without. The lift and the breather each prefer the moves made for them.
      const { target, phase } = setPhase(this.stats.transitions);
      u -= c.arc * (phase === "breather" ? 1.6 : 1) * Math.abs(this._energyRank(T, tr.ie) - target);
      if (phase === "lift" && LIFTS(tr)) u += 0.15;
      if (phase === "breather" && SETTLES(tr)) u += 0.1;
    }
    if (c.vary && tr.oe != null && tr.ie != null && Math.abs(tr.ie - tr.oe) < FLAT_ENERGY) {
      const last = h.slice(-3);
      if (last.length === 3 && last.every((e) => e.flat)) u -= c.vary;
    }
    return u;
  }

  // How well the chain could carry on from song d with the beat kept: the
  // mean quality of its three best beat-matched ways on to songs in the chain
  // and not just heard (0 for each one missing), from the summary the server
  // sends with T's exits; 0.5 (no opinion) without one.
  _onwardScore(T, d) {
    const list = T.onward?.[d];
    if (!list) return 0.5;
    const recent = new Set([T.id, d, ...this.history.slice(-4).map((h) => h.id)]);
    const qs = [];
    for (const [to, q] of list) {
      if (recent.has(to) || !this.enabled(to)) continue;
      qs.push(q);
      if (qs.length === 3) break;
    }
    return qs.reduce((a, b) => a + b, 0) / 3;
  }

  // Where an energy sits among those T's exits lead into, 0..1 (mid-rank for ties).
  _energyRank(T, ie) {
    if (this.ranks?.list !== T.transitions) {
      const v = T.transitions.map((x) => x.ie).filter((x) => x != null).sort((a, b) => a - b);
      this.ranks = { list: T.transitions, v };
    }
    const v = this.ranks.v;
    if (v.length < 2) return 0.5;
    let below = 0, upTo = 0;
    for (const x of v) {
      if (x < ie) below++;
      if (x <= ie) upTo++;
    }
    return (below + upTo) / 2 / v.length;
  }

  // Loads the songs this one is most likely to hand over to, so that an exit
  // only a beat or two away can still be taken.
  _prefetch(force = false) {
    const T = this.cur?.track;
    if (!T) return;
    const key = `${T.id}|${this.history.length}`;
    if (!force && this.prefetchedFor === key) return;
    this.prefetchedFor = key;
    const best = new Map();
    for (const tr of T.transitions) {
      if (!this.settings.allow[allowKey(tr.type)] || tr.to === T.id || !this.enabled(tr.to) || !this._usable(T, tr)) continue;
      const u = tr.q + this._appeal(T, tr);
      if (!best.has(tr.to) || u > best.get(tr.to)) best.set(tr.to, u);
    }
    this.prefetchIds = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
    for (const id of this.prefetchIds) this.loader.get(id).catch(() => {});
  }

  // Runs on every beat once the song may be left, until an exit is planned.
  // Waiting costs utility per second, so the nearest good exit wins; after
  // dwellMax (or on request) waiting costs far more and any exit will do.
  _planExit(t) {
    const T = this.cur.track;
    const s = this.settings;
    const items = T.transitions.filter((tr) => s.allow[allowKey(tr.type)] && tr.to !== T.id && this.enabled(tr.to)
      && this._usable(T, tr));
    if (!items.length) return;
    const late = this.urgent || t - this.dwellStart >= s.dwellMax;
    const { dist, prev } = T.distances(this.cur.beat, this.maxScore(T));
    const lambda = late ? Math.max(0.15, s.waitCost) : s.waitCost;
    const floor = late ? 0 : 0.3;
    let best = null;
    for (const tr of items) {
      if (tr.q < floor) continue;
      const { node: trigger, arrive } = this._triggerOf(tr);
      if (trigger < 0 || trigger >= T.n) continue;
      let arrival = dist[trigger];
      if (arrive && trigger === this.cur.beat) arrival = Infinity;
      if (!isFinite(arrival)) continue;
      if (arrival < LOAD_LEAD && !this.loader.has(tr.to)) continue;
      if (arrival < PREP_LEAD && (tr.stems || (tr.keylock && this.engine.canStretch))) continue;
      // A tempo ramp needs its voice before the ramp begins.
      if (bends(tr) && arrival < PREP_LEAD + bendBeats(tr.pre) * T.dur[this.cur.beat]) continue;
      const noise = (CRITERIA[s.criterion] || CRITERIA.balanced).noise;
      const u = tr.q - lambda * arrival + this._appeal(T, tr) + Math.random() * noise;
      if (!best || u > best.u) best = { tr, u, trigger, arrival };
    }
    if (!best && late) best = this._emergencyExit(T, items);
    if (!best) return;
    this._setPlan(T, best, prev, t);
  }

  // The listener picked an exit on the stage. Plan it now if the walk can
  // reach it; returns false when it cannot (or while a blend is running).
  // The walk heads for it with any jump of the song, not only those within the
  // strictness setting: the listener asked for this exit. When it cannot be
  // planned, pickError says why: "busy" (a hand-over is under way), "gone"
  // (not an exit the chain may take any more), "unreachable" (no way there
  // from where the song is), "soon" (too close to get its key-locked voice or
  // stems ready).
  planTransition(tr) {
    this.pickError = null;
    const refuse = (why) => ((this.pickError = why), false);
    if (!this.cur) return refuse("gone");
    if (this.blend || this.fx) return refuse("busy");
    const T = this.cur.track;
    if (!T.transitions.includes(tr)) {
      // The list was refreshed under the pointer (new pairs linked): the same exit in it.
      const same = (x) => x.type === tr.type && x.to === tr.to && (x.i ?? x.a) === (tr.i ?? tr.a)
        && (x.j ?? x.b) === (tr.j ?? tr.b);
      tr = T.transitions.find(same);
    }
    if (!tr || !this.canTake(T, tr)) return refuse("gone");
    const { dist, prev } = T.distances(this.cur.beat, T.scoreCut(1));
    const { node: trigger, arrive } = this._triggerOf(tr);
    if (trigger < 0 || trigger >= T.n) return refuse("unreachable");
    let arrival = dist[trigger];
    if (arrive && trigger === this.cur.beat) arrival = Infinity;
    if (!isFinite(arrival)) return refuse("unreachable");
    if (arrival < PREP_LEAD && (tr.stems || (tr.keylock && this.engine.canStretch))) return refuse("soon");
    if (this.plan) this._dropPlan();
    this._setPlan(T, { tr, trigger, arrival }, prev, this.nextTime, true);
    return true;
  }

  // Whether the chain may take this exit of song T now: its kind and blend
  // style switched on, its song in the chain, its stems there if it needs them.
  // The stage only shows (and lets the listener pick) such exits.
  canTake(T, tr) {
    return !!this.settings.allow[allowKey(tr.type)] && tr.to !== T.id && this.enabled(tr.to) && this._usable(T, tr);
  }

  _setPlan(T, best, prev, t, picked = false) {
    const jumps = best.tr.synthetic ? new Map() : T.route(prev, this.cur.beat, best.trigger);
    // dist[] counts from the start of the beat just scheduled; a cut, drop or
    // fade happens at the end of its trigger beat, a blend or effect at its start.
    const curStart = t - T.dur[this.cur.beat] / this.cur.rate;
    const arrive = this._triggerOf(best.tr).arrive;
    const eta = curStart + best.arrival + (arrive ? 0 : T.dur[best.trigger]);
    const plan = { tr: best.tr, jumps, target: null, eta, from: T.id, picked, trigger: best.trigger };
    if (bends(best.tr)) {
      // The tempo ramp runs on the stretch of the route after its last jump
      // (route() lists the jumps from the target backwards).
      const last = jumps.size ? jumps.values().next().value : null;
      plan.bendFrom = last ?? this.cur.beat;
      plan.bendBeats = bendBeats(best.tr.pre);
    }
    this.plan = plan;
    this.loader.get(best.tr.to).then(
      (track) => {
        if (this.plan !== plan) return;
        if (plan.tr.j == null) plan.tr.j = track.entryBeat();
        plan.target = track;
        this._prepare(plan, T);
      },
      () => {
        if (this.plan === plan) this._dropPlan();
      },
    );
    this.dispatchEvent(new Event("plan"));
  }

  // What a transition needs beyond the next song's audio, made ready while the
  // walk heads for it: both songs' vocal stems (a hand-over by layers), a
  // key-locked voice of the next song (its tempo changed, or its key, its
  // pitch otherwise kept), reading from just before its entry through the
  // blend and the glides back to its own tempo and pitch, and, for a tempo
  // ramp, a key-locked voice of the playing song over the ramp and the blend.
  // Until the next song's part is ready the plan is not; a failure marks the
  // transition so the chain does not plan it again.
  _prepare(plan, A) {
    const tr = plan.tr;
    const B = plan.target;
    const layered = !!tr.stems;
    const lock = !!tr.keylock && this.engine.canStretch;
    const ramp = bends(tr) && this.engine.canStretch;
    if (!layered && !lock && !ramp) {
      plan.ready = true;
      return;
    }
    const stems = layered ? Promise.all([this.loader.vocals(A.id), this.loader.vocals(B.id)]) : Promise.resolve([null, null]);
    stems.then(async ([va, vb]) => {
      if (this.plan !== plan) return;
      if (layered && (!va || !vb)) throw new Error("no vocal stems");
      plan.vocals = layered ? { A: va, B: vb } : null;
      if (lock) {
        const entry = tr.type === "blend" ? tr.b : tr.j;
        const from = Math.max(0, B.beats[entry] + (tr.shift_ms || 0) / 1000 - 1);
        const glide = Math.max(RAMP_BEATS, Math.abs(tr.semis || 0) * PITCH_BEATS);
        const beats = (tr.type === "blend" ? Math.ceil((tr.m || 1) * tr.len) : 0) + glide + 16;
        let span = 0;
        for (let k = entry; k < Math.min(B.n, entry + beats); k++) span += B.dur[k];
        const v = await this.engine.stretchVoice(B, from, from + span + 4, layered ? vb : null, tr.semis || 0);
        if (this.plan !== plan) {
          v.dispose();
          return;
        }
        plan.stretch = v;
      }
      plan.ready = true;
      if (ramp) {
        // From the first beat the ramp may start on to the end of the blend
        // (and 24 beats past the trigger, room to ramp back if it is dropped).
        const first = Math.max(plan.bendFrom ?? 0, plan.trigger - plan.bendBeats - 2);
        const last = Math.min(A.n - 1, Math.max(tr.a + (tr.loop || tr.len), plan.trigger + 24));
        const shiftA = this.cur?.voice?.shift || 0;
        const v = await this.engine.stretchVoice(A, Math.max(0, A.beats[first] + shiftA - 1), A.beats[last] + shiftA + 2,
          layered ? va : null);
        if (this.plan !== plan || plan.bent) {
          v.dispose();
          return;
        }
        plan.stretchA = v;
      }
    }).catch(() => {
      tr.failed = true;
      if (this.plan === plan) this._dropPlan();
    });
  }

  // Whether a transition can be taken at all here: not failed before, its
  // blend style switched on, its vocal stems on the server when it hands
  // over by layers, and the key shift or tempo ramp it needs switched on
  // (both need the key-locked voice).
  _usable(T, tr) {
    if (tr.failed) return false;
    if (tr.type === "blend" && this.settings.blendStyles?.[blendStyle(tr, T.analysis.meter || 4)] === false) return false;
    if (tr.stems && !(this.loader.metas?.get(T.id)?.stems && this.loader.metas?.get(tr.to)?.stems)) return false;
    if (tr.semis && !(this.settings.keyShift !== false && this.engine.canStretch)) return false;
    if (bends(tr) && !(this.settings.tempoRamp !== false && this.engine.canStretch)) return false;
    return true;
  }

  // No analysed exit is reachable from here (strict settings can isolate a
  // stretch of the song): leave at the next phrase start ahead, into the song
  // that the analysed transitions would have favoured, with an echo (it needs
  // no shared tempo and never puts two drum kits on top of each other), or a
  // crossfade when echoes are switched off.
  _emergencyExit(T, items) {
    const ph = T.analysis.phrase;
    let k = this.cur.beat + 2;
    while (k < T.n - 1 && ph[k] < 2) k++;
    k = Math.min(k, T.n - 1);
    let arrival = 0;
    for (let b = this.cur.beat; b < k; b++) arrival += T.dur[b];
    if (arrival < LOAD_LEAD) {
      k = Math.min(T.n - 1, k + 4 * (T.analysis.meter || 4));
      arrival = 0;
      for (let b = this.cur.beat; b < k; b++) arrival += T.dur[b];
    }
    let pick = null;
    for (const tr of items) {
      const u = tr.q + this._appeal(T, tr) - (TYPE_BIAS[tr.type] ?? 0);
      if (!pick || u > pick.u) pick = { to: tr.to, u };
    }
    if (!pick) return null;
    if (this.settings.allow.echo !== false && k - 1 > this.cur.beat) {
      // The echo is fed by beat k - 1: the walk has to arrive there.
      const tr = { type: "echo", to: pick.to, i: k - 1, j: null, beats: 1, rate: 1, shift_ms: 0, q: 0.2, synthetic: true };
      return { tr, u: pick.u, trigger: k - 1, arrival: arrival - T.dur[k - 1] };
    }
    const tr = { type: "fade", to: pick.to, i: k - 1, j: null, seconds: 4, rate: 1, shift_ms: 0, q: 0.2, synthetic: true };
    return { tr, u: pick.u, trigger: k - 1, arrival };
  }

  // ------------------------------------------------------------------ UI view

  _log(t, kind, extra = {}) {
    const c = this.cur;
    this.timeline.push({ t, kind, track: c.track, beat: c.beat, rate: c.rate, ...extra });
    if (this.timeline.length > 400) this.timeline.splice(0, 100);
  }

  // The step being heard right now (the scheduler runs ahead of the speakers).
  audible() {
    const now = this.engine.audibleTime();
    const tl = this.timeline;
    for (let k = tl.length - 1; k >= 0; k--) if (tl[k].t <= now) return { entry: tl[k], now, index: k };
    return tl.length ? { entry: tl[0], now, index: 0 } : null;
  }

  recentEvents(since) {
    return this.timeline.filter((e) => e.t > since && e.t <= this.engine.audibleTime() && !["seq", "blend", "fxBeat"].includes(e.kind));
  }
}

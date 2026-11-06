// Web Audio plumbing. A Voice is one running read head into a track's buffer;
// the player creates a new voice at every splice and lets the old one fade out.

const CURVE_POINTS = 128;

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function curve(fn) {
  const c = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) c[i] = fn(i / (CURVE_POINTS - 1));
  return c;
}

export const FADE_IN = curve((x) => Math.sin((Math.PI / 2) * x));
export const FADE_OUT = curve((x) => Math.cos((Math.PI / 2) * x));

// The fade law of a splice whose two sides correlate by rho (Fink, Holters &
// Zölzer 2016): fade-in c(t) and fade-out c(1 - t) keep the sum's power
// constant, c(t)^2 + c(1 - t)^2 + 2 rho c(t) c(1 - t) = 1. With v = 2t - 1,
// c = (u + v) / 2 and u = sqrt((2 - (1 - rho) v^2) / (1 + rho)). rho 0 is the
// equal-power law (unrelated audio: kept as the sine pair), rho 1 the
// equal-gain one (the same audio, which equal power swells by 3 dB mid-fade).
const laws = new Map();
export function fadeLaw(rho) {
  const r = Math.round(Math.min(1, Math.max(0, rho || 0)) * 20) / 20;
  if (r === 0) return [FADE_IN, FADE_OUT];
  if (!laws.has(r)) {
    const c = (t) => {
      const v = 2 * t - 1;
      return (Math.sqrt((2 - (1 - r) * v * v) / (1 + r)) + v) / 2;
    };
    laws.set(r, [curve(c), curve((t) => c(1 - t))]);
  }
  return laws.get(r);
}

// A band at or below this many dB is killed outright (gain 0).
export const KILL_DB = -60;
const toGain = (db) => (db <= KILL_DB ? 0 : dbToGain(db));
// Crossover points of the isolator EQ, like a DJ mixer's three-band isolator.
const LOW_X = 200;
const HIGH_X = 2500;
// Levels of the synthesised accents, against the master bus (measured in
// Chrome against the songs' own level: the riser peaks a few dB under the
// music, the impact sits on the downbeat without pumping the limiter).
const RISER_PEAK_DB = -2;
const IMPACT_SUB_DB = -10;
const IMPACT_NOISE_DB = -14;
const FLANGER_SEND = 0.6;

function butter(ctx, type, freq) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Math.SQRT1_2;
  return f;
}

// Linkwitz-Riley (two Butterworth sections): a low and a high band of one
// crossover sum back flat, so the open EQ leaves the sound untouched.
function lr4(ctx, input, type, freq) {
  const a = butter(ctx, type, freq);
  const b = butter(ctx, type, freq);
  input.connect(a).connect(b);
  return b;
}

export class Engine {
  constructor() {
    // Same rate as the stored audio: beat times map to samples with no resampling.
    this.ctx = new AudioContext({ sampleRate: 44100, latencyHint: "playback" });
    this.master = this.ctx.createGain();
    this.master.gain.value = dbToGain(-3);
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.limiter).connect(this.analyser).connect(this.ctx.destination);
    this.voices = new Set();
  }

  get now() {
    return this.ctx.currentTime;
  }

  // Time the listener is hearing right now, on the context clock.
  audibleTime() {
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return this.ctx.currentTime - lat;
  }

  setVolume(v) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  voice(track) {
    const v = new Voice(this, track);
    this.voices.add(v);
    return v;
  }

  // Key lock needs AudioWorklet (Signalsmith Stretch runs in one).
  get canStretch() {
    return typeof AudioWorkletNode === "function" && !!this.ctx.audioWorklet;
  }

  // A voice reading [from, to] s of the track through Signalsmith Stretch, so
  // its tempo can change with its pitch kept (or its pitch moved by `semis`
  // semitones, with its tempo kept); with `vocals` (the stem's AudioBuffer)
  // both go through one stretcher, four channels, so they stay sample-aligned
  // and the voice can be taken out of the mix. Resolves once the audio is
  // loaded into the worklet (prepared ahead of the transition).
  async stretchVoice(track, from, to, vocals = null, semis = 0) {
    const { default: SignalsmithStretch } = await import("../vendor/signalsmith-stretch-1.3.2.mjs");
    const channels = vocals ? 4 : 2;
    const node = await SignalsmithStretch(this.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels] });
    const sr = track.buffer.sampleRate;
    const a = Math.max(0, Math.floor(from * sr));
    const b = Math.min(track.buffer.length, Math.ceil(to * sr));
    const take = (buf, c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).slice(a, b);
    const chans = [take(track.buffer, 0), take(track.buffer, 1)];
    if (vocals) chans.push(take(vocals, 0), take(vocals, 1));
    await node.addBuffers(chans, chans.map((c) => c.buffer));
    const v = new Voice(this, track, { node, from: a / sr, to: b / sr, channels, latency: await node.latency(), semis });
    this.voices.add(v);
    return v;
  }

  // Two seconds of stereo white noise, made once (risers, impacts).
  _noise() {
    if (this.noiseBuf) return this.noiseBuf;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(2, sr * 2, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    this.noiseBuf = buf;
    return buf;
  }

  // Build-up: white noise through a band-pass that climbs from 400 Hz to
  // 9 kHz with a rising resonance, swelling from nothing to a few dB under the
  // music over [start, end], cut on the downbeat (the impact takes over).
  riser(start, end) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(400, start);
    bp.frequency.exponentialRampToValueAtTime(9000, end);
    bp.Q.setValueAtTime(0.8, start);
    bp.Q.linearRampToValueAtTime(4, end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(dbToGain(-30), start);
    g.gain.exponentialRampToValueAtTime(dbToGain(RISER_PEAK_DB), end - 0.01);
    g.gain.linearRampToValueAtTime(0, end + 0.005);
    src.connect(bp).connect(g).connect(this.master);
    src.start(start);
    src.stop(end + 0.05);
    this._keep([src, bp, g], end + 0.1);
  }

  // Impact on the downbeat: a sub that falls from 90 to 40 Hz and dies over
  // 1.2 s, and a short burst of noise into the hall reverb.
  impact(when) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(90, when);
    osc.frequency.exponentialRampToValueAtTime(40, when + 0.6);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, when);
    og.gain.linearRampToValueAtTime(dbToGain(IMPACT_SUB_DB), when + 0.005);
    og.gain.exponentialRampToValueAtTime(0.001, when + 1.2);
    osc.connect(og).connect(this.master);
    osc.start(when);
    osc.stop(when + 1.3);
    const n = ctx.createBufferSource();
    n.buffer = this._noise();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, when);
    ng.gain.linearRampToValueAtTime(dbToGain(IMPACT_NOISE_DB), when + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.001, when + 0.25);
    const verb = ctx.createConvolver();
    verb.buffer = this._impulse();
    const vg = ctx.createGain();
    vg.gain.value = 0.5;
    n.connect(lp).connect(ng);
    ng.connect(this.master);
    ng.connect(verb).connect(vg).connect(this.master);
    n.start(when);
    n.stop(when + 0.3);
    this._keep([osc, og, n, lp, ng, verb, vg], when + 5);
  }

  // Spinback: the platter thrown backwards. The seconds before the read head
  // (`pos`, s into the track), reversed, played from where the song is,
  // speeding up to three times then winding down, darkening and fading over
  // `dur`; the song itself is cut.
  spinback(voice, when, pos, dur, rate = 1) {
    const ctx = this.ctx;
    const buf = voice.track.buffer;
    const sr = buf.sampleRate;
    const b = Math.max(1, Math.min(buf.length, Math.round(pos * sr)));
    const a = Math.max(0, b - Math.round(4 * sr));
    const rev = ctx.createBuffer(buf.numberOfChannels, b - a, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c).subarray(a, b);
      const o = rev.getChannelData(c);
      for (let i = 0, n = d.length; i < n; i++) o[i] = d[n - 1 - i];
    }
    const src = ctx.createBufferSource();
    src.buffer = rev;
    const p = src.playbackRate;
    p.setValueAtTime(rate, when);
    p.linearRampToValueAtTime(3 * rate, when + 0.25 * dur);
    p.exponentialRampToValueAtTime(0.3 * rate, when + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(16000, when);
    lp.frequency.exponentialRampToValueAtTime(900, when + dur);
    const level = dbToGain(voice.track.analysis.gain_db);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.008);
    g.gain.setValueAtTime(level, when + 0.4 * dur);
    g.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + dur + 0.05);
    voice.fadeOut(when - 0.004, 0.008);
    this._keep([src, lp, g], when + dur + 0.2);
  }

  // Gate: the song chopped by a gate on its beats (`times`, beat starts),
  // open on every eighth for the first bar, every sixteenth after and every
  // thirty-second on the last beat, each opening ~55 % of its slice with 2 ms
  // edges, under a rising high-pass.
  gate(voice, times, meter = 4) {
    const g = voice.fx.gain;
    const beats = times.length - 1;
    const t0 = times[0];
    const t1 = times[beats];
    voice.hpSweep(t0, 30, 700, t1 - t0);
    g.setValueAtTime(1, t0);
    for (let k = 0; k < beats; k++) {
      const div = k < meter ? 2 : k < beats - 1 ? 4 : 8;
      const slice = (times[k + 1] - times[k]) / div;
      for (let q = 0; q < div; q++) {
        const s = times[k] + q * slice;
        const on = s + 0.55 * slice;
        g.setValueAtTime(1, Math.max(s, on - 0.002));
        g.linearRampToValueAtTime(0, on);
        g.setValueAtTime(0, s + slice - 0.002);
        g.linearRampToValueAtTime(1, s + slice);
      }
    }
  }

  // Jet flanger: the song (before its fader) through a short delay swept from
  // 0.5 to 8 ms and back toward 2 ms, with feedback, mixed in as the window
  // goes on, under a rising high-pass; the dry song is cut at the end and the
  // flanged tail rings on for a moment under the next one.
  flanger(voice, start, end) {
    const ctx = this.ctx;
    const send = ctx.createGain();
    const dl = ctx.createDelay(0.05);
    const fb = ctx.createGain();
    const wet = ctx.createGain();
    send.gain.setValueAtTime(0, start);
    send.gain.linearRampToValueAtTime(FLANGER_SEND, start + 0.5 * (end - start));
    send.gain.setValueAtTime(FLANGER_SEND, end - 0.01);
    send.gain.linearRampToValueAtTime(0, end + 0.01);
    dl.delayTime.setValueAtTime(0.0005, start);
    dl.delayTime.exponentialRampToValueAtTime(0.008, start + 0.7 * (end - start));
    dl.delayTime.exponentialRampToValueAtTime(0.002, end + 0.3);
    fb.gain.value = 0.5;
    wet.gain.setValueAtTime(0.8, start);
    wet.gain.setValueAtTime(0.8, end);
    wet.gain.linearRampToValueAtTime(0, end + 0.4);
    voice.trim.connect(send);
    send.connect(dl);
    dl.connect(fb).connect(dl);
    dl.connect(wet).connect(this.master);
    voice.hpSweep(start, 20, 180, end - start);
    // The flanged copy adds to the dry song: the dry dips a little to keep the level.
    voice.fx.gain.setValueAtTime(1, start);
    voice.fx.gain.linearRampToValueAtTime(dbToGain(-1.5), start + 0.5 * (end - start));
    this._keep([send, dl, fb, wet], end + 0.6);
  }

  stopAll(fade = 0.08) {
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.release(t, fade);
    this.voices.clear();
    for (const n of this.fxNodes || []) n.disconnect();
    this.fxNodes = [];
  }

  _keep(nodes, until) {
    this.fxNodes = (this.fxNodes || []).concat(nodes);
    const ms = Math.max(0, (until - this.ctx.currentTime) * 1000);
    setTimeout(() => {
      for (const n of nodes) n.disconnect();
      this.fxNodes = this.fxNodes.filter((n) => !nodes.includes(n));
    }, ms + 200);
  }

  // Echo out: the voice's signal (before its fader) feeds a feedback delay for
  // the last beat only; the repeats are band-limited inside the loop (high-pass
  // 350 Hz, low-pass 4 kHz), so each one is thinner and the tail never muddies
  // the next song's bass. The tail rings on after the dry song is cut.
  echoOut(voice, start, end, delay) {
    const ctx = this.ctx;
    const send = ctx.createGain();
    const dl = ctx.createDelay(4);
    const fb = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    const hp = ctx.createBiquadFilter();
    const wet = ctx.createGain();
    send.gain.value = 0;
    dl.delayTime.value = Math.min(3.9, delay);
    fb.gain.value = 0.5;
    lp.type = "lowpass";
    lp.frequency.value = 4000;
    hp.type = "highpass";
    hp.frequency.value = 350;
    wet.gain.value = 0.85;
    voice.trim.connect(send);
    send.connect(dl).connect(lp).connect(hp);
    hp.connect(fb).connect(dl);
    hp.connect(wet).connect(this.master);
    send.gain.setValueAtTime(0, start);
    send.gain.linearRampToValueAtTime(1, start + 0.01);
    send.gain.setValueAtTime(1, Math.max(start + 0.01, end - 0.01));
    send.gain.linearRampToValueAtTime(0, end + 0.01);
    this._keep([send, dl, fb, lp, hp, wet], end + delay * 14 + 1);
  }

  // Reverb wash: the voice swells into a long, high-passed reverb over
  // [start, end] and is cut there; the tail (about 4 s) blurs whatever differs
  // between the songs while the next one comes in under it.
  wash(voice, start, end) {
    const ctx = this.ctx;
    const send = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    const verb = ctx.createConvolver();
    const ret = ctx.createGain();
    hp.type = "highpass";
    hp.frequency.value = 300;
    verb.buffer = this._impulse();
    send.gain.setValueAtTime(0, start);
    send.gain.linearRampToValueAtTime(1, end);
    send.gain.linearRampToValueAtTime(0, end + 0.02);
    ret.gain.setValueAtTime(0.9, start);
    ret.gain.setValueAtTime(0.9, end);
    ret.gain.linearRampToValueAtTime(0.5, end + 0.6); // -6 dB once the next song is in
    voice.trim.connect(send);
    send.connect(hp).connect(verb).connect(ret).connect(this.master);
    this._keep([send, hp, verb, ret], end + 5);
  }

  // A synthetic hall: stereo noise decaying 60 dB over 4 s, made once.
  _impulse() {
    if (this.ir) return this.ir;
    const sr = this.ctx.sampleRate;
    const n = Math.round(sr * 4.5);
    const buf = this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / (4 * sr)) * 0.35;
    }
    this.ir = buf;
    return buf;
  }

  // Loop roll: slices of one beat replayed back to back in a shrinking pattern
  // under a rising high-pass, so the old song winds up into the new one.
  roll(track, slices, gainDb) {
    const ctx = this.ctx;
    const t0 = slices[0].when;
    const last = slices[slices.length - 1];
    const t1 = last.when + last.dur;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(40, t0);
    hp.frequency.exponentialRampToValueAtTime(1500, t1);
    const out = ctx.createGain();
    out.gain.value = dbToGain(gainDb);
    hp.connect(out).connect(this.master);
    const nodes = [hp, out];
    for (const s of slices) {
      const src = ctx.createBufferSource();
      src.buffer = track.buffer;
      src.playbackRate.value = s.rate;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, s.when);
      g.gain.linearRampToValueAtTime(s.level, s.when + 0.003);
      g.gain.setValueAtTime(s.level, Math.max(s.when + 0.003, s.when + s.dur - 0.004));
      g.gain.linearRampToValueAtTime(0, s.when + s.dur);
      src.connect(g).connect(hp);
      src.start(s.when, Math.max(0, s.offset));
      src.stop(s.when + s.dur + 0.01);
      nodes.push(src, g);
    }
    this._keep(nodes, t1 + 0.5);
  }
}

// The vocal stem against the full track: kept out (the instrumental: the
// full mix minus the sample-aligned stem), alone (the acapella), or neither.
const VOCAL_MODES = { full: [1, 0], instrumental: [1, -1], acapella: [0, 1] };

export class Voice {
  // `stretch`: { node, from, channels, semis } for a key-locked voice
  // (Engine.stretchVoice): the track read through Signalsmith Stretch, tempo
  // changed with pitch kept, pitch moved by `semis` semitones.
  constructor(engine, track, stretch = null) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.track = track;
    this.stretch = stretch;
    this.stretched = !!stretch;
    this.semis = stretch?.semis || 0;
    this.shift = 0; // read position minus the beat time it plays (set by the player)
    // Before the EQ: the track (mainGain) and, when attached, its vocal stem
    // (vocGain), summed, so the stem can take the voice out or leave it alone.
    this.pre = ctx.createGain();
    this.mainGain = ctx.createGain();
    this.vocGain = ctx.createGain();
    this.vocGain.gain.value = 0;
    this.mix = { main: 1, voc: 0 };
    this.hasVocals = false;
    this.voc = null;
    this.mainGain.connect(this.pre);
    this.vocGain.connect(this.pre);
    if (stretch) {
      const split = ctx.createChannelSplitter(stretch.channels);
      const main = ctx.createChannelMerger(2);
      stretch.node.connect(split);
      split.connect(main, 0, 0);
      split.connect(main, 1, 1);
      main.connect(this.mainGain);
      if (stretch.channels === 4) {
        const voc = ctx.createChannelMerger(2);
        split.connect(voc, 2, 0);
        split.connect(voc, 3, 1);
        voc.connect(this.vocGain);
        this.hasVocals = true;
      }
      this.src = null;
    } else {
      // Each read head has its own gain, so a loop can crossfade one pass
      // into the next (Voice.loop).
      this.src = ctx.createBufferSource();
      this.src.buffer = track.buffer;
      this.srcGain = ctx.createGain();
      this.src.connect(this.srcGain).connect(this.mainGain);
    }
    // Three-band isolator: low (< 200 Hz), mid, high (> 2.5 kHz), one gain each,
    // so a band can be dipped or killed (the bass swap of a DJ mix).
    this.sum = ctx.createGain();
    this.bands = { low: ctx.createGain(), mid: ctx.createGain(), high: ctx.createGain() };
    this.level = { low: 1, mid: 1, high: 1 }; // last scheduled gain per band
    lr4(ctx, this.pre, "lowpass", LOW_X).connect(this.bands.low).connect(this.sum);
    lr4(ctx, lr4(ctx, this.pre, "highpass", LOW_X), "lowpass", HIGH_X).connect(this.bands.mid).connect(this.sum);
    lr4(ctx, this.pre, "highpass", HIGH_X).connect(this.bands.high).connect(this.sum);
    // Open low-pass, swept down to darken a song leaving and up to open one
    // arriving; open high-pass, swept up to thin a song out of a filter hand-over.
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.5;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = 10;
    this.hp.Q.value = Math.SQRT1_2;
    this.trim = ctx.createGain();
    this.trim.gain.value = dbToGain(track.analysis.gain_db);
    // A unity gain for effects that chop or dip the song (gate, flanger),
    // apart from the fader the player automates.
    this.fx = ctx.createGain();
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.sum.connect(this.lp).connect(this.hp).connect(this.trim).connect(this.fx).connect(this.gain).connect(engine.master);
    if (this.src) {
      // A looping voice outlives its first read head: it is freed on its own
      // schedule (Voice.loop).
      this.src.onended = () => {
        if (!this.loopSources) this._free();
      };
    }
    this.stopped = false;
  }

  _free() {
    this.engine.voices.delete(this);
    this.gain.disconnect();
  }

  start(when, offset, rate, fadeIn, rho = 0) {
    this._read(when, offset, rate);
    if (fadeIn > 0) {
      this.gain.gain.setValueAtTime(0, when);
      this._curve(fadeLaw(rho)[0], when, fadeIn);
    } else {
      this.gain.gain.setValueAtTime(1, when);
    }
  }

  // Starts reading without touching the gain: the caller automates it.
  startSilent(when, offset, rate) {
    this._read(when, offset, rate);
  }

  _read(when, offset, rate) {
    if (this.stretch) {
      // A transposed voice keeps its formants, so a singer moved two
      // semitones still sounds like themselves.
      this.stretch.node.schedule({
        active: true, input: offset - this.stretch.from, output: when, outputTime: when, rate, semitones: this.semis,
        formantCompensation: this.semis !== 0,
      });
      return;
    }
    this.src.playbackRate.setValueAtTime(rate, when);
    this.src.start(when, Math.max(0, offset));
  }

  // `pos`: the read position at `when` (a key-locked voice resyncs to it on
  // every beat; a plain voice just follows its rate). `semis`: a key-locked
  // voice's pitch from then on (a transposed song gliding home).
  setRate(when, rate, pos = null, semis = null) {
    if (this.stretch) {
      const change = { output: when, outputTime: when, rate };
      if (pos != null) change.input = pos - this.stretch.from;
      if (semis != null) {
        change.semitones = semis;
        this.semis = semis;
      }
      this.stretch.node.schedule(change);
      return;
    }
    this.src.playbackRate.setValueAtTime(rate, when);
    if (this.voc) this.voc.playbackRate.setValueAtTime(rate, when);
  }

  // The vocal stem, read alongside from `offset` at `rate` from `when` on
  // (a plain voice; a key-locked one gets it from Engine.stretchVoice).
  attachVocals(buffer, when, offset, rate) {
    if (!buffer || this.stretch || this.voc) return;
    const ctx = this.engine.ctx;
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.setValueAtTime(rate, when);
    this.vocSrcGain = ctx.createGain();
    s.connect(this.vocSrcGain).connect(this.vocGain);
    s.start(when, Math.max(0, offset));
    if (this.stopWhen != null) s.stop(this.stopWhen);
    this.voc = s;
    this.hasVocals = true;
  }

  // A loop of [from, to] s of the track: from `when` (the read head reaching
  // `to` on its first pass) the region plays again and again until `until`,
  // each pass crossfaded into the next over `xf` s around the seam, the vocal
  // stem looped alongside. A key-locked voice loops inside the stretcher (its
  // read head wraps from `to` back to `from`, the seam smoothed by the
  // stretch itself), set now: the read head is still before `to`.
  loop(when, from, to, rate, until, xf = 0.015) {
    const len = (to - from) / rate;
    if (!(len > 0.05)) return;
    if (this.stretch) {
      this.stretch.node.schedule({ loopStart: from - this.stretch.from, loopEnd: to - this.stretch.from });
      return;
    }
    const ctx = this.engine.ctx;
    this.loopSources = this.loopSources || [];
    const heads = [[this.track.buffer, this.mainGain, this.srcGain]];
    if (this.voc) heads.push([this.voc.buffer, this.vocGain, this.vocSrcGain]);
    let playing = heads.map((h) => h[2]);
    for (let t = when; t < until - 0.01; t += len) {
      const next = [];
      for (const [buffer, dest] of heads) {
        const s = ctx.createBufferSource();
        s.buffer = buffer;
        s.playbackRate.value = rate;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t - xf / 2);
        g.gain.linearRampToValueAtTime(1, t + xf / 2);
        s.connect(g).connect(dest);
        s.start(t - xf / 2, Math.max(0, from - (xf / 2) * rate));
        s.stop(Math.min(until, t + len + xf) + 0.02);
        this.loopSources.push(s);
        next.push(g);
      }
      for (const g of playing) {
        g.gain.setValueAtTime(1, t - xf / 2);
        g.gain.linearRampToValueAtTime(0, t + xf / 2);
      }
      playing = next;
    }
    const ms = Math.max(0, (until - ctx.currentTime) * 1000) + 500;
    setTimeout(() => this._free(), ms);
  }

  // full | instrumental (voice out) | acapella (voice alone), over `ramp` s.
  vocals(when, mode, ramp = 0) {
    if (!this.hasVocals) return;
    const [main, voc] = VOCAL_MODES[mode];
    const end = when + Math.max(0.005, ramp);
    for (const [k, node, to] of [["main", this.mainGain, main], ["voc", this.vocGain, voc]]) {
      node.gain.setValueAtTime(this.mix[k], when);
      node.gain.linearRampToValueAtTime(to, end);
      this.mix[k] = to;
    }
  }

  // Turntable brake: the platter slows to a near stop over [t0, t1] while the
  // sound fades through the last part of it.
  brake(t0, t1, from) {
    if (this.stretch) {
      for (let k = 0; k < 8; k++) this.setRate(t0 + ((t1 - t0) * k) / 8, from * (1 - (0.95 * k) / 8));
    } else {
      const p = this.src.playbackRate;
      p.setValueAtTime(from, t0);
      p.linearRampToValueAtTime(0.05, t1);
    }
    const tf = t0 + (t1 - t0) * 0.5;
    this._curve(FADE_OUT, tf, t1 - tf);
    this.stopAt(t1 + 0.02);
  }

  gainCurve(values, when, dur) {
    this._curve(values, when, dur);
  }

  fadeOut(when, dur, rho = 0) {
    this._curve(fadeLaw(rho)[1], when, dur);
    this.stopAt(when + dur + 0.02);
  }

  stopAt(when) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopWhen = when;
    if (this.stretch) {
      // Never a stop scheduled into the stretcher: its time map applies the
      // earliest change it holds at once (a stop meant for the end of a blend
      // would silence it now). Its fader is already down by then (every
      // caller fades first); it is muted there and freed just after.
      try {
        this.gain.gain.setValueAtTime(0, when);
      } catch (_) {
        /* inside a curve that ends at 0 anyway */
      }
      const ms = Math.max(0, (when - this.engine.ctx.currentTime) * 1000) + 500;
      setTimeout(() => this.dispose(), ms);
      return;
    }
    for (const s of [this.src, this.voc, ...(this.loopSources || [])]) {
      try {
        s?.stop(when);
      } catch (_) {
        /* already stopped */
      }
    }
    if (this.loopSources) {
      const ms = Math.max(0, (when - this.engine.ctx.currentTime) * 1000) + 500;
      setTimeout(() => this._free(), ms);
    }
  }

  // A key-locked voice frees its worklet and buffers once it has stopped.
  dispose() {
    this.engine.voices.delete(this);
    this.gain.disconnect();
    if (this.stretch) {
      this.stretch.node.disconnect();
      this.stretch.node.dropBuffers?.();
    }
  }

  // Immediate release used when the whole transport stops.
  release(t, fade) {
    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    this.stopped = false;
    this.stopAt(t + fade + 0.02);
  }

  // A band set at `when` (dB; KILL_DB and below: off).
  setBand(name, when, db) {
    const v = toGain(db);
    this.bands[name].gain.setValueAtTime(v, when);
    this.level[name] = v;
  }

  // A band moved from its last scheduled level to `db` over [when, when+dur].
  // Long moves go evenly in dB (exponentially), as a DJ turns an EQ knob;
  // a kill or a short swap goes straight.
  rampBand(name, when, db, dur) {
    const p = this.bands[name].gain;
    const from = this.level[name];
    const to = toGain(db);
    const end = when + Math.max(0.005, dur);
    p.setValueAtTime(from, when);
    if (from > 0 && to > 0 && dur > 0.25) p.exponentialRampToValueAtTime(to, end);
    else p.linearRampToValueAtTime(to, end);
    this.level[name] = to;
  }

  bass(when, db, ramp = 0.06) {
    this.rampBand("low", when, db, ramp);
  }

  // Low-pass sweep (exponential, so it sounds even across octaves).
  sweep(when, fromHz, toHz, dur) {
    const f = this.lp.frequency;
    f.setValueAtTime(fromHz, when);
    f.exponentialRampToValueAtTime(toHz, when + Math.max(0.05, dur));
  }

  // High-pass sweep with a resonance that rises as it climbs.
  hpSweep(when, fromHz, toHz, dur, qFrom = 0.7, qTo = 1.2) {
    const f = this.hp.frequency;
    const q = this.hp.Q;
    const end = when + Math.max(0.05, dur);
    f.setValueAtTime(fromHz, when);
    f.exponentialRampToValueAtTime(toHz, end);
    q.setValueAtTime(qFrom, when);
    q.linearRampToValueAtTime(qTo, end);
  }

  _curve(values, when, dur) {
    const g = this.gain.gain;
    try {
      g.setValueCurveAtTime(values, when, Math.max(0.005, dur));
    } catch (_) {
      // Overlapping automation: fall back to a ramp toward the curve's end value.
      g.cancelScheduledValues(when);
      g.setValueAtTime(g.value, when);
      g.linearRampToValueAtTime(values[values.length - 1], when + Math.max(0.005, dur));
    }
  }
}

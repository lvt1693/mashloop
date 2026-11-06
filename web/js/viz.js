// The ∞ stage. Every song is one loop: a ring of beats coloured by timbre, with
// its jump chords inside and its exits to other songs as dots outside. When the
// player plans an exit, the loop turns until that exit faces the next song,
// whose loop grows in and touches it there: the two loops make the ∞, and the
// crossing is where the mix happens. After the hand-over the new loop glides
// to the centre and the old one shrinks away.
//
// Each loop is painted in its song's colour (theme.js); the room takes the
// colour of the playing song, and around its loop a halo of the live spectrum
// breathes with the music.

import * as theme from "./theme.js";

const TAU = Math.PI * 2;
const HALO_BANDS = 48;
const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
export const KIND_VI = {
  cut: "Nối thẳng", drop: "Drop vào đoạn mới", blend: "Blend khớp nhịp", fade: "Crossfade",
  echo: "Echo vang", wash: "Reverb wash", riser: "Build-up", flanger: "Flanger", gap: "Ngắt lặng 1 beat",
  brake: "Phanh đĩa", roll: "Cuộn nhịp", spin: "Spinback", gate: "Gate",
};

// What the bridge does to the tempo and the key, in words: "hai bài cùng
// kéo tempo 6%", "dịch tông +1", "nhịp đôi".
export function bendNote(tr) {
  const notes = [];
  const pre = tr.pre || 1;
  if (Math.abs(pre - 1) > 0.004) notes.push(`hai bài cùng kéo tempo ${Math.round(Math.abs(pre - 1) * 100)}%, giữ tông`);
  else if (tr.rate && Math.abs(tr.rate - 1) > 0.015 && (tr.type === "cut" || tr.type === "drop" || tr.type === "blend")) {
    notes.push(`bài sau ${tr.rate > 1 ? "nhanh" : "chậm"} ${Math.round(Math.abs(tr.rate - 1) * 100)}% lúc vào${tr.keylock ? ", giữ tông" : ""}`);
  }
  if (tr.semis) notes.push(`bài sau dịch tông ${tr.semis > 0 ? "+" : "−"}${Math.abs(tr.semis)}`);
  if (tr.loop) notes.push(`lặp ${Math.round(tr.loop / 4) || 1} ô nhịp của bài trước`);
  if (tr.m === 2) notes.push("bài sau nhịp đôi");
  if (tr.m === 0.5) notes.push("bài sau nửa nhịp");
  if (tr.type === "fade" && tr.seconds) notes.push(`chuyển dần trong ${Math.round(tr.seconds)} giây`);
  if ((tr.mood ?? 0) > 0.9) notes.push("khác mood");
  return notes.join(" · ");
}
const SECOND_RATIO = 0.7; // the next song's loop, relative to the playing one

export function fmt(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function short(t, n = 28) {
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// YouTube titles carry upload noise ("(Official Audio)", "| Official MV").
// Split them into the song and the artist so the song can be the display line.
const NOISE = /\s*[([]([^)\]]*\b(official|audio|video|lyrics?|mv|m\/v|visuali[sz]er|remaster(ed)?|hd|4k|explicit)\b[^)\]]*)[)\]]\s*/gi;
export function splitTitle(raw, channel = "") {
  let s = String(raw || "").replace(NOISE, " ").replace(/\s*\|\s*official.*$/i, "").replace(/\s+/g, " ").trim();
  let artist = "";
  let title = s;
  const sep = s.match(/\s[-–—|]\s/);
  if (sep) {
    artist = s.slice(0, sep.index).trim();
    title = s.slice(sep.index + sep[0].length).trim();
  }
  const ft = title.match(/\s\(?(ft\.?|feat\.?|featuring)\s[^)]+\)?$/i);
  if (ft) {
    artist = `${artist || ""} ${ft[0].trim().replace(/^\(|\)$/g, "")}`.trim();
    title = title.slice(0, ft.index).trim();
  }
  if (!artist && channel) artist = channel.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
  return { title: title || s || raw, artist };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

class Ring {
  constructor(track, role) {
    this.track = track;
    this.role = role;
    this.x = null;
    this.y = null;
    this.r = 0;
    this.rot = -Math.PI / 2; // song start at twelve o'clock
    // Which way time runs round the loop: +1 clockwise, -1 counter-clockwise.
    // Neighbours in the ∞ turn opposite ways, so the path through the crossing
    // is one stroke of a figure eight.
    this.dir = 1;
    this.alpha = 0;
    this.fill = 1;
    this.target = null;
    this.layer = null;
    this.layerKey = "";
    this.col = null; // eased toward the song's colour (or the accent while it plays)
  }
}

// The section a beat is in, by its role in the song (structure.roles).
const ROLE_VI = { intro: "Intro", verse: "Verse", chorus: "Điệp khúc", breakdown: "Đoạn lắng", drop: "Drop", outro: "Outro" };

export class Viz {
  constructor(canvas, player, { center, tip, onPick, onSeek, onCaption } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.player = player;
    this.center = center;
    this.tip = tip;
    this.onPick = onPick || (() => {});
    this.onSeek = onSeek || (() => false);
    this.onCaption = onCaption || (() => {});
    this._captionId = null;
    this.titles = new Map();
    this.rings = new Map();
    this.primaryId = null;
    this.idle = 1;
    this.pulse = 0;
    this.lastBeatKey = "";
    this.lastEventT = 0;
    this.flashes = [];
    this.ripples = [];
    this.heads = { lead: null, ghost: null };
    this.leadId = null;
    this.lastCross = null;
    this.pointer = null;
    this.hover = null;
    this.armed = null; // touch: an exit tapped once, waiting for the confirming tap
    this.fieldAt = 0;
    this.bands = new Float32Array(HALO_BANDS); // the live spectrum, 0..1, smoothed
    this.bass = 0;
    this.accent = null; // the room's colour as the canvas sees it, eased
    this.secondCol = null;
    this.last = performance.now();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(canvas.parentElement);
    this._resize();
    this._bindPointer();
    const loop = (now) => {
      this._frame(now);
      requestAnimationFrame(loop);
    };
    this.started = true;
    requestAnimationFrame(loop);
  }

  setTitles(map) {
    this.titles = map;
  }

  invalidate() {
    for (const ring of this.rings.values()) ring.layerKey = "";
  }

  get reduced() {
    return reduceMQ.matches;
  }

  // ------------------------------------------------------------- geometry

  _resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(200, box.width);
    this.h = Math.max(200, box.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.baseR = Math.min(this.w, this.h) * 0.37;
    // A loop's layer takes a while to draw, and a resize (a line of text below
    // the stage wrapping differently) would otherwise blank the stage for a
    // tenth of a second while every layer is redrawn. The layers scale with
    // the loops anyway: redraw them only when the size really changed.
    if (dpr !== this.dpr || !this.layerR || Math.abs(this.baseR - this.layerR) / this.layerR > 0.15) {
      this.layerR = this.baseR;
      this.invalidate();
    }
    this.dpr = dpr;
    // Setting the canvas size cleared it: paint now, not at the next frame.
    if (this.started) this._frame(performance.now());
  }

  // Where the loops sit: one in the middle, or two touching (side by side on
  // wide stages, stacked as an 8 on tall ones). `swap` (0..1) is how far a
  // blend has got: the weight passes from the playing loop to the next one,
  // and halfway through they are the same size.
  _layout(two, swap = 0) {
    const { w, h } = this;
    const k = SECOND_RATIO;
    if (!two) return { a: { x: w / 2, y: h / 2, r: Math.min(w, h) * 0.37 } };
    const s = easeInOut(Math.max(0, Math.min(1, swap)));
    const fa = 1 - (1 - k) * s, fb = k + (1 - k) * s;
    if (w >= h * 1.05) {
      const R = Math.min(h * 0.37, (w * 0.86) / (2 * (1 + k)));
      const x0 = (w - 2 * R * (1 + k)) / 2;
      return {
        a: { x: x0 + fa * R, y: h / 2, r: fa * R, face: 0 },
        b: { x: x0 + 2 * fa * R + fb * R, y: h / 2, r: fb * R, face: Math.PI },
        cross: { x: x0 + 2 * fa * R, y: h / 2 },
      };
    }
    const R = Math.min(w * 0.37, (h * 0.86) / (2 * (1 + k)));
    const y0 = (h - 2 * R * (1 + k)) / 2;
    return {
      a: { x: w / 2, y: y0 + fa * R, r: fa * R, face: Math.PI / 2 },
      b: { x: w / 2, y: y0 + 2 * fa * R + fb * R, r: fb * R, face: -Math.PI / 2 },
      cross: { x: w / 2, y: y0 + 2 * fa * R },
    };
  }

  _thickness(R) {
    return Math.max(7, R * 0.068);
  }

  // Angle on the ring (before its rotation) for a time in the song.
  _ang(track, t) {
    return (TAU * t) / track.end;
  }

  // Angle on the stage for a time in the song, with the loop's turn and direction.
  _angle(ring, t) {
    return ring.rot + ring.dir * this._ang(ring.track, t);
  }

  _point(ring, t, radius) {
    const a = this._angle(ring, t);
    return [ring.x + radius * Math.cos(a), ring.y + radius * Math.sin(a)];
  }

  // The beat that is playing at time t of a song, and how far into it.
  _beatAt(track, t) {
    const beats = track.beats;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return { beat: lo, frac: Math.max(0, Math.min(1, (t - beats[lo]) / track.dur[lo])) };
  }

  // ---------------------------------------------------------------- layers

  // Everything about a song that does not move: drawn once, then rotated and
  // scaled as the loop travels.
  _buildLayer(track) {
    const RL = this.layerR;
    const th = this._thickness(RL);
    const S = Math.ceil(RL * 2.6);
    const c = document.createElement("canvas");
    c.width = Math.round(S * this.dpr);
    c.height = Math.round(S * this.dpr);
    const ctx = c.getContext("2d");
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(S / 2, S / 2);
    const a = track.analysis;
    const maxScore = this.player.maxScore(track);
    const loudMax = Math.max(...a.loud);
    const loudMin = Math.min(...a.loud);
    const ang = (t) => this._ang(track, t);
    const at = (t, r) => [r * Math.cos(ang(t)), r * Math.sin(ang(t))];
    const rin = RL - th / 2 - 3;
    const chord = theme.lift(theme.accentOf(track.id), 0.04);
    const colors = theme.beatColors(track.id, a.color);
    const ink = theme.inkOf(track.id);

    // Jump chords, weakest first so the best sit on top.
    const edges = [];
    for (let i = 0; i < track.n; i++) for (const e of track.jumps[i]) edges.push([i, e.to, e.score]);
    edges.sort((p, q) => q[2] - p[2]);
    ctx.lineWidth = 1;
    for (const [i, j, s] of edges) {
      const ok = s <= maxScore;
      ctx.strokeStyle = ok ? theme.css(chord, 0.08 + 0.42 * (1 - s / Math.max(maxScore, 0.01))) : theme.css(ink, 0.03);
      this._chordPath(ctx, rin, ang(track.beats[i] + track.dur[i]), ang(track.beats[j]));
      ctx.stroke();
    }

    // Dust: the ring is made of matter, denser where the song is loud.
    const rnd = seeded(track.n * 7919 + Math.round(track.end * 13));
    for (let b = 0; b < track.n; b++) {
      const lv = (a.loud[b] - loudMin) / Math.max(1, loudMax - loudMin);
      const count = 2 + Math.round(9 * lv);
      ctx.fillStyle = colors[b];
      for (let k = 0; k < count; k++) {
        const t = track.beats[b] + rnd() * track.dur[b];
        const spread = (rnd() + rnd() + rnd() - 1.5) / 1.5; // roughly normal, -1..1
        const r = RL + spread * th * 2.1;
        const [x, y] = at(t, r);
        ctx.globalAlpha = 0.12 + 0.4 * rnd() * (1 - Math.abs(spread));
        ctx.beginPath();
        ctx.arc(x, y, 0.5 + rnd() * 0.9, 0, TAU);
        ctx.fill();
      }
    }

    // Beat segments.
    for (let b = 0; b < track.n; b++) {
      const lv = (a.loud[b] - loudMin) / Math.max(1, loudMax - loudMin);
      ctx.globalAlpha = 0.3 + 0.7 * lv;
      ctx.strokeStyle = colors[b];
      ctx.lineWidth = th * (a.pos[b] === 0 ? 1 : 0.78);
      ctx.beginPath();
      ctx.arc(0, 0, RL, ang(track.beats[b]), ang(track.beats[b] + track.dur[b]) + 0.002);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The dial: a hairline tick every 15 s, longer on the minute.
    const r0 = RL + th / 2 + 8;
    ctx.strokeStyle = theme.css(ink, 0.22);
    ctx.lineWidth = 1;
    for (let t = 0; t <= track.end; t += 15) {
      const long = Math.round(t) % 60 === 0;
      const [x1, y1] = at(t, r0);
      const [x2, y2] = at(t, r0 + (long ? 7 : 3.5));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Section starts, just inside the dial.
    ctx.strokeStyle = theme.css(ink, 0.55);
    ctx.lineWidth = 1.4;
    for (const s of a.sections) {
      const [x1, y1] = at(track.beats[s], RL + th / 2 + 1);
      const [x2, y2] = at(track.beats[s], RL + th / 2 + 5);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Exits to other songs (those the chain may take).
    for (const tr of track.transitions) {
      if (!this._shown(track, tr)) continue;
      const t = this._exitTime(track, tr);
      if (t === null) continue;
      const [x, y] = at(t, this._exitRadius(RL));
      ctx.fillStyle = theme.css(theme.songColor(tr.to), 0.4 + 0.55 * tr.q);
      ctx.beginPath();
      ctx.arc(x, y, tr.type === "cut" ? 4 : 3.1, 0, TAU);
      ctx.fill();
    }
    return { canvas: c, S, RL, th };
  }

  _exitRadius(R) {
    return R + this._thickness(R) / 2 + 21;
  }

  // The moment in the song where a transition leaves it.
  _exitTime(track, tr) {
    const beat = tr.type === "blend" ? tr.a : tr.i + 1;
    if (beat < 0 || beat >= track.n) return null;
    return track.beats[beat];
  }

  _entryTime(track, tr) {
    const beat = tr.type === "blend" ? tr.b : tr.j;
    if (beat == null || beat < 0 || beat >= track.n) return track.beats[0];
    return track.beats[beat];
  }

  _chordPath(ctx, rin, a1, a2) {
    const x1 = rin * Math.cos(a1), y1 = rin * Math.sin(a1);
    const x2 = rin * Math.cos(a2), y2 = rin * Math.sin(a2);
    let sep = Math.abs(wrapAngle(a1 - a2));
    const k = (1 - 0.92 * (sep / Math.PI)) * 0.9;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(((x1 + x2) / 2) * k, ((y1 + y2) / 2) * k, x2, y2);
  }

  // A chord in stage coordinates, following the ring's position and rotation.
  _chordWorld(ctx, ring, i, j) {
    const T = ring.track;
    const s = ring.r / this.layerR;
    const rin = (this.layerR - this._thickness(this.layerR) / 2 - 3) * s;
    ctx.save();
    ctx.translate(ring.x, ring.y);
    ctx.rotate(ring.rot);
    ctx.scale(1, ring.dir);
    this._chordPath(ctx, rin, this._ang(T, T.beats[i] + T.dur[i]), this._ang(T, T.beats[j]));
    ctx.restore();
  }

  // ----------------------------------------------------------------- state

  // The mix (a blend or an effect) the listener is hearing. The scheduler runs
  // a lookahead ahead of the speakers and lets go of a mix before its end is
  // heard; the stage holds on to it until then, so the next loop does not dim
  // and come back at every hand-over.
  _mix(view) {
    const p = this.player;
    const live = p.blend || p.fx;
    if (live) {
      const blend = live === p.blend;
      this.held = { m: live, blend, end: blend ? live.times[live.L] : live.times[live.times.length - 1] };
    } else if (this.held && (!view || view.now >= this.held.end)) {
      this.held = null;
    }
    return this.held;
  }

  _roles(view) {
    const p = this.player;
    const primary = view?.entry.track || null;
    let second = null;
    let secondTr = null;
    let placeholder = null;
    // A mix is scheduled a lookahead before it is heard, and the plan is gone
    // by then: the mix itself keeps the next loop on stage from that moment.
    const mx = this.mixNow;
    if (p.plan) this.lastPlan = p.plan;
    if (mx && primary && primary.id === mx.m.A.id) {
      second = mx.m.B;
      secondTr = mx.m.tr;
    } else if (p.cur && primary && p.cur.track.id !== primary.id && p.history.at(-1)?.via !== "start") {
      // Same for a cut, a drop or a fade: the scheduler is already in the
      // next song while the listener is still in this one. Keep the ∞ until
      // the light gets to the crossing.
      second = p.cur.track;
      const tr = this.lastPlan?.tr;
      secondTr = tr && tr.to === second.id ? tr : null;
    } else if (p.plan && primary && p.plan.from === primary.id) {
      secondTr = p.plan.tr;
      if (p.plan.target) second = p.plan.target;
      else placeholder = p.plan.tr.to;
    }
    return { primary, second, secondTr, placeholder };
  }

  _ring(track, role) {
    let ring = this.rings.get(track.id);
    if (!ring) {
      ring = new Ring(track, role);
      this.rings.set(track.id, ring);
    }
    ring.track = track;
    ring.role = role;
    return ring;
  }

  _update(view, dt) {
    const { primary, second, secondTr, placeholder } = this._roles(view);
    const two = !!(second || placeholder);
    const L = this._layout(two, second && this.mixNow?.blend ? this._mixProgress(view) : 0);
    const k = this.reduced ? 1 : 1 - Math.exp(-dt / 0.22);
    const kRot = this.reduced ? 1 : 1 - Math.exp(-dt / 0.3);

    this.idle += ((primary ? 0 : 1) - this.idle) * (this.reduced ? 1 : 1 - Math.exp(-dt / 0.25));

    if (primary && primary.id !== this.primaryId) {
      // A new song is playing: the one before it leaves the stage.
      const before = this.primaryId ? this.rings.get(this.primaryId) : null;
      if (before) before.role = "leaving";
      const fresh = !this.rings.has(primary.id);
      const ring = this._ring(primary, "primary");
      if (fresh) {
        ring.x = L.a.x;
        ring.y = L.a.y;
        ring.r = L.a.r;
        ring.fill = this.reduced || before ? 1 : 0; // the very first loop sweeps in
        if (before) {
          ring.r = L.a.r * 0.7;
          ring.dir = -before.dir;
        }
      }
      this.primaryId = primary.id;
    }
    if (!primary && this.primaryId) {
      const ring = this.rings.get(this.primaryId);
      if (ring) ring.role = "leaving";
      this.primaryId = null;
    }

    for (const ring of this.rings.values()) if (ring.role === "second" || ring.role === "ghost") ring.role = "fading";

    if (primary) {
      const ring = this._ring(primary, "primary");
      ring.target = { ...L.a, alpha: 1 };
      if (two && secondTr) {
        // Turn the loop so the exit beat faces the next song.
        const t = this._exitTime(primary, secondTr);
        if (t !== null) ring.target.rot = L.a.face - ring.dir * this._ang(primary, t);
      }
      if (second) {
        const sr = this._ring(second, "second");
        // The next loop runs the other way round (set while it is still
        // faint, never on a loop the listener is watching).
        if (sr.alpha < 0.3) sr.dir = -ring.dir;
        const rot = secondTr ? L.b.face - sr.dir * this._ang(second, this._entryTime(second, secondTr)) : sr.rot;
        if (sr.x === null) {
          sr.x = L.b.x + (L.b.x - L.a.x) * 0.25;
          sr.y = L.b.y + (L.b.y - L.a.y) * 0.25;
          sr.r = L.b.r * 0.6;
          sr.rot = rot;
          sr.alpha = 0;
        }
        sr.target = { ...L.b, rot, alpha: 1 };
      }
    }
    this.placeholder = placeholder ? { id: placeholder, ...L.b, tr: secondTr } : null;
    this.cross = two ? L.cross : null;

    for (const [id, ring] of this.rings) {
      if (ring.role === "leaving" || ring.role === "fading") {
        const away = ring.role === "leaving";
        ring.target = {
          x: ring.x + (away ? -0.02 * this.w : 0),
          y: ring.y,
          r: ring.r * (away ? 0.985 : 0.99),
          alpha: 0,
        };
      }
      const tg = ring.target;
      if (!tg) continue;
      if (ring.x === null) {
        ring.x = tg.x;
        ring.y = tg.y;
        ring.r = tg.r;
      }
      ring.x += (tg.x - ring.x) * k;
      ring.y += (tg.y - ring.y) * k;
      ring.r += (tg.r - ring.r) * k;
      const fadeK = this.reduced ? Math.min(1, dt / 0.16) : k;
      ring.alpha += (tg.alpha - ring.alpha) * fadeK;
      if (tg.rot !== undefined) ring.rot += wrapAngle(tg.rot - ring.rot) * kRot;
      // The playing loop wears the room's accent; the others their own colour.
      const want = ring.role === "primary" ? theme.accentOf(ring.track.id) : theme.songColor(ring.track.id);
      ring.col = theme.ease(ring.col, want, this.reduced ? 1 : 1 - Math.exp(-dt / 0.5));
      if (ring.fill < 1) ring.fill = Math.min(1, ring.fill + dt / 1.2);
      if ((ring.role === "leaving" || ring.role === "fading") && ring.alpha < 0.02) this.rings.delete(id);
    }
  }

  // ----------------------------------------------------------------- frame

  _frame(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const ctx = this.ctx;
    const view = this.player.audible();
    this.mixNow = this._mix(view);
    this._update(view, dt);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    this._beatPulse(view, dt);
    this._spectrum(dt);
    const primary = this.primaryId ? this.rings.get(this.primaryId) : null;
    this._roomColor(primary, view, dt);
    if (this.idle > 0.01) this._drawIdle(ctx, now, this.idle);

    this.heads = this._heads(primary, view);
    this._trackCrossing(now);
    this.capPlace = this._captionPlace(primary, view);
    this.captionTrack = this.capPlace.ring?.track || null;

    this._drawLights(ctx, primary);
    if (this.heads.lead && !this.reduced) this._drawHalo(ctx, this.heads.lead);

    // Back to front: leaving, the next song, the playing song.
    const order = [...this.rings.values()].sort((a, b) => (a.role === "primary") - (b.role === "primary"));
    for (const ring of order) this._drawRing(ctx, ring);
    if (this.placeholder) this._drawPlaceholder(ctx, this.placeholder, now);
    if (this.cross && primary && primary.alpha > 0.4) this._drawCross(ctx, view, now);

    if (primary && view) this._drawLive(ctx, primary, view, now);
    this._drawHover(ctx);
    this._placeCenter(this.capPlace);
    this._updateField(primary, now);
  }

  // Where the light is. On the playing loop, until a blend reaches the
  // crossing: from there it runs on round the next loop, and the playing loop
  // keeps a ghost of it that fades as that song fades out.
  _heads(primary, view) {
    if (!primary || !view) return { lead: null, ghost: null };
    const T = primary.track;
    const e = view.entry;
    const frac = Math.max(0, Math.min(1, ((view.now - e.t) * (e.rate || 1)) / T.dur[e.beat]));
    const onA = this._head(primary, e.beat, frac);
    const b = this.mixNow?.blend ? this.mixNow.m : null;
    const sr = b && view.now >= b.times[0] ? this.rings.get(b.B.id) : null;
    if (!sr || sr.role !== "second" || sr.alpha < 0.05) return { lead: onA, ghost: null };
    let k = 0;
    while (k + 1 < b.times.length && b.times[k + 1] <= view.now) k++;
    k = Math.min(k, b.L - 1);
    const f = Math.max(0, Math.min(1, (view.now - b.times[k]) / (b.times[k + 1] - b.times[k])));
    // tB holds B's audio time at each master beat, whatever the beat ratio.
    const at = this._beatAt(sr.track, b.tB[k] + f * (b.tB[k + 1] - b.tB[k]));
    return { lead: this._head(sr, at.beat, at.frac), ghost: { ...onA, alpha: 1 - this._mixProgress(view) } };
  }

  _head(ring, beat, frac) {
    const T = ring.track;
    return { ring, beat, frac, angle: this._angle(ring, T.beats[beat] + frac * T.dur[beat]) };
  }

  // The caption sits in the loop that has the song: the playing one, or the
  // next one once a blend is past halfway (where the bass changes hands). It
  // dips out and back in as it crosses over.
  _captionPlace(primary, view) {
    const b = this.mixNow?.blend ? this.mixNow.m : null;
    const sr = b ? this.rings.get(b.B.id) : null;
    if (!primary || !sr || sr.role !== "second") return { ring: primary, dip: 1 };
    const k = this._mixProgress(view);
    return { ring: k >= 0.5 ? sr : primary, dip: Math.min(1, Math.abs(k - 0.5) * 8) };
  }

  _beatPulse(view, dt) {
    this.pulse *= Math.exp(-dt / 0.22);
    if (!view || this.reduced) return;
    const key = `${view.entry.track.id}:${view.entry.beat}`;
    if (key !== this.lastBeatKey) {
      this.lastBeatKey = key;
      const pos = view.entry.track.analysis.pos[view.entry.beat];
      this.pulse = Math.max(this.pulse, pos === 0 ? 1 : 0.5);
    }
  }

  // How the mix is going: 0 before the hand-over starts, 1 once the next song has it.
  _mixProgress(view) {
    const mx = this.mixNow;
    if (!view || !mx || view.now < mx.m.times[0]) return 0;
    return Math.min(1, (view.now - mx.m.times[0]) / Math.max(1e-3, mx.end - mx.m.times[0]));
  }

  // The room's colour: the playing song's, passing into the next song's as
  // the mix goes on. The page gets the same colour through CSS (_updateField).
  // With no loop playing, lightOf (a mashup heard in the studio) lights it.
  _roomColor(primary, view, dt) {
    const second = [...this.rings.values()].find((r) => r.role === "second");
    const nextId = second?.track.id || this.placeholder?.id || null;
    const a = primary ? theme.accentOf(primary.track.id) : this.lightOf ? theme.accentOf(this.lightOf) : theme.idleAccent();
    const target = nextId ? theme.mix(a, theme.accentOf(nextId), this._mixProgress(view)) : a;
    const k = this.reduced ? 1 : 1 - Math.exp(-dt / 0.6);
    this.accent = theme.ease(this.accent, target, k);
    this.secondCol = nextId ? theme.ease(this.secondCol, theme.songColor(nextId), k) : null;
    this.nextId = nextId;
  }

  // The live spectrum, from the analyser after the master bus. Log-spaced
  // bands, a gentle tilt so the highs register, and the volume knob taken
  // back out so the halo shows the music, not the listening level.
  _spectrum(dt) {
    const eng = this.player.engine;
    const an = eng?.analyser;
    const live = an && this.player.playing && !this.reduced;
    const rel = 1 - Math.exp(-dt / 0.2);
    if (!live) {
      for (let i = 0; i < HALO_BANDS; i++) this.bands[i] *= 1 - rel;
      this.bass *= 1 - rel;
      return;
    }
    if (!this._fbuf || this._fbuf.length !== an.frequencyBinCount) {
      this._fbuf = new Float32Array(an.frequencyBinCount);
      const hz = an.context.sampleRate / an.fftSize;
      const lo = Math.log(40), hi = Math.log(14000);
      this._edges = [];
      for (let i = 0; i <= HALO_BANDS; i++) {
        const f = Math.exp(lo + ((hi - lo) * i) / HALO_BANDS);
        this._edges.push(Math.min(an.frequencyBinCount - 1, Math.max(1, Math.round(f / hz))));
      }
      this._centre = Array.from({ length: HALO_BANDS }, (_, i) => Math.exp(lo + ((hi - lo) * (i + 0.5)) / HALO_BANDS));
    }
    an.getFloatFrequencyData(this._fbuf);
    if (!this._avg) this._avg = new Float32Array(HALO_BANDS);
    const comp = -20 * Math.log10(Math.max(1e-3, eng.master.gain.value));
    const att = 1 - Math.exp(-dt / 0.035);
    const slow = 1 - Math.exp(-dt / 1.6);
    let bass = 0, nb = 0;
    for (let i = 0; i < HALO_BANDS; i++) {
      const b0 = this._edges[i], b1 = Math.max(b0 + 1, this._edges[i + 1]);
      let s = 0;
      for (let j = b0; j < b1; j++) s += Math.pow(10, this._fbuf[j] / 10);
      const db = 10 * Math.log10(s / (b1 - b0) + 1e-12) + comp + 3 * Math.log2(this._centre[i] / 150);
      const level = Math.max(0, Math.min(1, (db + 72) / 44));
      // A dense mix keeps every band near the top: show a little of the
      // level and mostly what rises above the band's own recent average,
      // so the halo hits with the kick and the snare instead of standing still.
      this._avg[i] += (level - this._avg[i]) * slow;
      const v = Math.max(0, Math.min(1, 0.4 * level + 2.2 * (level - this._avg[i])));
      this.bands[i] += (v - this.bands[i]) * (v > this.bands[i] ? att : rel);
      if (this._centre[i] < 160) {
        bass += this.bands[i];
        nb++;
      }
    }
    this.bass = nb ? bass / nb : 0;
  }

  // The halo: the spectrum drawn around the playing loop, mirrored about the
  // playhead, lows at the playhead and highs on the far side. The music seems
  // to come out of the loop where it is being played.
  _drawHalo(ctx, head) {
    const ring = head.ring;
    if (ring.alpha < 0.05 || ring.fill < 1) return;
    let peak = 0;
    for (let i = 0; i < HALO_BANDS; i++) peak = Math.max(peak, this.bands[i]);
    if (peak < 0.02) return;
    const T = ring.track;
    const a0 = head.angle;
    const th = this._thickness(ring.r);
    const r0 = ring.r + th / 2 + 1;
    const H = ring.r * 0.1 * Math.min(1.3, theme.glowGain());
    const N = 180;
    const amp = (k) => {
      const u = 1 - Math.abs((k / N) * 2 - 1); // 1 at the playhead, 0 opposite
      const x = (1 - u) * (HALO_BANDS - 1);
      const i = Math.floor(x), f = x - i;
      const v = this.bands[i] * (1 - f) + (this.bands[Math.min(HALO_BANDS - 1, i + 1)] || 0) * f;
      return v * v * (0.55 + 0.45 * u);
    };
    const col = ring.col || theme.accentOf(T.id);
    const hi = theme.lift(col, 0.1);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = ring.alpha;
    // A soft breath of light under the hairlines.
    const g = ctx.createRadialGradient(ring.x, ring.y, r0, ring.x, ring.y, r0 + H);
    g.addColorStop(0, theme.css(col, 0.16));
    g.addColorStop(1, theme.css(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let k = 0; k <= N; k++) {
      const a = a0 + Math.PI + (k / N) * TAU;
      const r = r0 + amp(k) * H;
      const x = ring.x + r * Math.cos(a), y = ring.y + r * Math.sin(a);
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.arc(ring.x, ring.y, r0, a0 + Math.PI + TAU, a0 + Math.PI, true);
    ctx.closePath();
    ctx.fill();
    // The spectrum itself: hairlines, like the dial's ticks, grouped by
    // brightness so the whole halo costs four strokes.
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    const groups = [[], [], [], []];
    for (let k = 0; k < N; k++) {
      const v = amp(k);
      if (v < 0.015) continue;
      groups[Math.min(3, Math.floor(v * 4))].push([a0 + Math.PI + (k / N) * TAU, v]);
    }
    groups.forEach((bars, q) => {
      if (!bars.length) return;
      ctx.strokeStyle = theme.css(hi, 0.3 + 0.18 * q);
      ctx.beginPath();
      for (const [a, v] of bars) {
        const c = Math.cos(a), s = Math.sin(a);
        ctx.moveTo(ring.x + (r0 + 2) * c, ring.y + (r0 + 2) * s);
        ctx.lineTo(ring.x + (r0 + 3 + v * H) * c, ring.y + (r0 + 3 + v * H) * s);
      }
      ctx.stroke();
    });
    ctx.restore();
  }

  _drawLights(ctx, primary) {
    const gain = theme.glowGain();
    for (const ring of this.rings.values()) {
      if (ring.alpha < 0.02 || ring.x === null || !ring.col) continue;
      const isP = ring === primary;
      const base = (isP ? 0.07 + 0.05 * this.pulse + 0.09 * this.bass : 0.07) * gain;
      const g = ctx.createRadialGradient(ring.x, ring.y, ring.r * 0.2, ring.x, ring.y, ring.r * 1.55);
      g.addColorStop(0, theme.css(ring.col, base * ring.alpha));
      g.addColorStop(1, theme.css(ring.col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(ring.x - ring.r * 1.6, ring.y - ring.r * 1.6, ring.r * 3.2, ring.r * 3.2);
    }
  }

  _drawRing(ctx, ring) {
    if (ring.alpha < 0.01 || ring.x === null) return;
    const key = `${ring.track.id}|${this.player.settings.keep}|${ring.track.transitions.length}|${this.layerR.toFixed(1)}|${theme.paletteVersion()}`;
    if (ring.layerKey !== key) {
      ring.layer = this._buildLayer(ring.track);
      ring.layerKey = key;
    }
    const L = ring.layer;
    const s = ring.r / L.RL;
    ctx.save();
    ctx.globalAlpha = Math.min(1, ring.alpha);
    ctx.translate(ring.x, ring.y);
    ctx.rotate(ring.rot);
    ctx.scale(s, s * ring.dir);
    if (ring.fill < 1) {
      const f = easeOut(ring.fill);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, L.S, 0, TAU * f);
      ctx.closePath();
      ctx.clip();
    }
    ctx.drawImage(L.canvas, -L.S / 2, -L.S / 2, L.S, L.S);
    ctx.restore();

    // A soft dark pool in the middle of the loop that holds the caption keeps
    // it readable over the chords (contrast, rulebook A2.1).
    if (ring === this.capPlace?.ring) {
      const a = ring.alpha * this.capPlace.dip;
      const gr = theme.ground(ring.col || theme.accentOf(ring.track.id));
      const pool = { l: 0.15, c: gr.c, h: gr.h };
      const g = ctx.createRadialGradient(ring.x, ring.y, 0, ring.x, ring.y, ring.r * 0.72);
      g.addColorStop(0, theme.css(pool, 0.86 * a));
      g.addColorStop(0.62, theme.css(pool, 0.62 * a));
      g.addColorStop(1, theme.css(pool, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.r * 0.72, 0, TAU);
      ctx.fill();
    }

    // Minute labels stay upright while the loop turns.
    if (ring.role === "primary" && ring.alpha > 0.3 && ring.fill >= 1) {
      ctx.save();
      ctx.globalAlpha = ring.alpha * 0.7;
      ctx.fillStyle = theme.css(theme.inkOf(ring.track.id), 0.7);
      ctx.font = `400 ${Math.max(9, Math.min(11, ring.r * 0.04))}px "JetBrains Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const rLab = ring.r + this._thickness(ring.r) / 2 + 8 * s + 18;
      for (let m = 1; m * 60 < ring.track.end - 8; m++) {
        const [x, y] = this._point(ring, m * 60, rLab);
        ctx.fillText(`${m}:00`, x, y);
      }
      ctx.restore();
    }
  }

  _drawPlaceholder(ctx, ph, now) {
    ctx.save();
    ctx.strokeStyle = theme.css(theme.songColor(ph.id), 0.55);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 7]);
    ctx.lineDashOffset = this.reduced ? 0 : -now / 60;
    ctx.beginPath();
    ctx.arc(ph.x, ph.y, ph.r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = theme.css(theme.inkOf(ph.id), 0.6);
    ctx.font = '400 11px "JetBrains Mono", monospace';
    ctx.textAlign = "center";
    ctx.fillText("ĐANG TẢI", ph.x, ph.y + 4);
    ctx.restore();
  }

  // The crossing: where the two loops touch, the mix glows in both colours,
  // and its progress ring turns from this song's colour into the next one's.
  _drawCross(ctx, view, now) {
    const c = this.cross;
    const k = this._mixProgress(view);
    const primary = this.rings.get(this.primaryId);
    const ca = primary?.col || this.accent;
    const cb = this.secondCol || ca;
    const mid = this.accent || ca;
    const breathe = this.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(now / 420);
    const R = (16 + 26 * k) * (1 + 0.25 * this.bass);
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R * 2.2);
    g.addColorStop(0, theme.css(theme.lift(mid, 0.12), 0.6 + 0.3 * k));
    g.addColorStop(0.35, theme.css(mid, (0.18 + 0.12 * breathe) * theme.glowGain()));
    g.addColorStop(1, theme.css(mid, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * 2.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = theme.css(theme.lift(mid, 0.3));
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.6 + 1.2 * k, 0, TAU);
    ctx.fill();
    if (k > 0) {
      const start = -Math.PI / 2;
      const cg = ctx.createConicGradient ? ctx.createConicGradient(start, c.x, c.y) : null;
      if (cg) {
        cg.addColorStop(0, theme.css(theme.lift(ca, 0.06), 0.95));
        cg.addColorStop(Math.max(0.01, k), theme.css(theme.lift(theme.mix(ca, cb, k), 0.06), 0.95));
        cg.addColorStop(1, theme.css(cb, 0.95));
      }
      ctx.strokeStyle = cg || theme.css(theme.lift(mid, 0.06), 0.9);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(c.x, c.y, 11, start, start + TAU * k);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
  }

  _drawLive(ctx, ring, view, now) {
    const T = ring.track;
    const p = this.player;

    // New audible events start a flash along the jump that was taken.
    for (const ev of p.recentEvents(this.lastEventT)) {
      if (ev.kind === "jump" && ev.track === T) this.flashes.push({ i: ev.from, j: ev.beat, t0: now });
    }
    this.lastEventT = view.now;
    this.flashes = this.flashes.filter((f) => now - f.t0 < 900);
    const col = ring.col || theme.accentOf(T.id);
    const white = theme.lift(col, 0.3);
    for (const f of this.flashes) {
      const a = 1 - (now - f.t0) / 900;
      ctx.strokeStyle = theme.css(white, 0.9 * a);
      ctx.lineWidth = 2.4;
      this._chordWorld(ctx, ring, f.i, f.j);
      ctx.stroke();
    }

    // The route the player will take to the planned exit: a bright thread
    // that turns toward the next song's colour.
    const plan = p.plan;
    if (plan && plan.from === T.id) {
      ctx.save();
      ctx.strokeStyle = theme.css(theme.lift(theme.mix(col, theme.songColor(plan.tr.to), 0.35), 0.1), 0.88);
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 6]);
      ctx.lineDashOffset = this.reduced ? 0 : -now / 40;
      for (const [src, dst] of plan.jumps) {
        this._chordWorld(ctx, ring, src, dst);
        ctx.stroke();
      }
      ctx.restore();
      const t = this._exitTime(T, plan.tr);
      if (t !== null) {
        const [x, y] = this._point(ring, t, this._exitRadius(ring.r));
        const pulse = this.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(now / 200);
        ctx.strokeStyle = theme.css(theme.lift(theme.songColor(plan.tr.to), 0.06), 0.5 + 0.5 * pulse);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 7 + 3 * pulse, 0, TAU);
        ctx.stroke();
      }
    }

    // The light, and the ghost it leaves on the song it has crossed out of.
    const { lead, ghost } = this.heads;
    if (ghost && ghost.alpha > 0.02) this._drawHead(ctx, ghost, ghost.alpha * 0.7, false);
    if (lead) this._drawHead(ctx, lead, 1, true);
    this._drawRipples(ctx, now);
  }

  // A playhead: the beat lit on the loop, a glow and a bright core. The ghost
  // keeps only a dimmed beat and a small core.
  _drawHead(ctx, h, alpha, full) {
    const ring = h.ring;
    const T = ring.track;
    const th = this._thickness(ring.r);
    const col = ring.col || theme.accentOf(T.id);
    const a1 = this._angle(ring, T.beats[h.beat]);
    const a2 = this._angle(ring, T.beats[h.beat] + T.dur[h.beat]);
    ctx.save();
    ctx.globalAlpha = Math.min(1, ring.alpha) * alpha;
    ctx.strokeStyle = theme.css(theme.lift(col, 0.3), full ? 0.95 : 0.6);
    ctx.lineWidth = th + (full ? 5 : 2);
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, a1, a2, ring.dir < 0);
    ctx.stroke();
    const hx = ring.x + ring.r * Math.cos(h.angle), hy = ring.y + ring.r * Math.sin(h.angle);
    if (full) {
      const glow = (14 + 8 * this.pulse + 10 * this.bass) * Math.sqrt(theme.glowGain());
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, glow * 2);
      g.addColorStop(0, theme.css(theme.lift(col, 0.12), 0.9));
      g.addColorStop(1, theme.css(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hx, hy, glow * 2, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = theme.css(theme.lift(col, 0.4));
    ctx.beginPath();
    ctx.arc(hx, hy, th * (full ? 0.42 : 0.28), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // The moment the light crosses into the next loop, the crossing rings out
  // once in the next song's colour.
  _trackCrossing(now) {
    const lead = this.heads.lead;
    const id = lead ? lead.ring.track.id : null;
    // A cut or a fade hands over in the frame where the ∞ comes apart, so
    // the crossing is remembered for a moment.
    const cross = this.lastCross && now - this.lastCross.at < 300 ? this.lastCross : null;
    if (id && this.leadId && id !== this.leadId && cross && !this.reduced) {
      this.ripples.push({ x: cross.x, y: cross.y, t0: now, col: lead.ring.col || theme.songColor(id) });
    }
    this.leadId = id;
    if (this.cross) this.lastCross = { ...this.cross, at: now };
  }

  _drawRipples(ctx, now) {
    this.ripples = this.ripples.filter((r) => now - r.t0 < 900);
    for (const r of this.ripples) {
      const u = (now - r.t0) / 900;
      const e = easeOut(u);
      ctx.strokeStyle = theme.css(theme.lift(r.col, 0.15), 0.85 * (1 - u));
      ctx.lineWidth = 2 * (1 - u) + 0.6;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 8 + 52 * e, 0, TAU);
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ idle
  //
  // The waiting instrument, before any song plays: the ∞ as two ghost loops,
  // each made like a real one (faint beats whose weight follows a loudness
  // contour, a stippled halo of dust), the left in the room's colour, the
  // right in a colour drifting round the mood wheel: a song still to come.
  // They breathe slowly; jump chords come and go inside them; a light runs
  // the ∞ with a tail and a few sparks, takes each loop's colour as it crosses
  // the middle, and leaves a ripple there. Under the pointer the path glows.
  // Reduced motion: the same picture, still.

  // A little above the middle: the caption hangs under it, and the two weigh as one.
  _idleGeom() {
    const a = Math.min(this.w * 0.36, this.h * 0.95);
    return { a, cx: this.w / 2, cy: this.h * 0.42, th: Math.max(3, a * 0.024) };
  }

  // A point of the lemniscate (u: 0..2π; the right loop where cos u > 0, the
  // crossing at u = ±π/2), and the unit normal there.
  _idlePt(g, u) {
    const s = Math.sin(u), c = Math.cos(u);
    const d = 1 + s * s;
    return [g.cx + (g.a * c) / d, g.cy + (g.a * s * c) / d];
  }

  _idleNormal(g, u) {
    const [x1, y1] = this._idlePt(g, u - 0.002), [x2, y2] = this._idlePt(g, u + 0.002);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    return [-(y2 - y1) / len, (x2 - x1) / len];
  }

  // The colour of the loop still to come: the mood theme's wheel turning
  // slowly (once in 90 s) from a third of the way round the room's colour;
  // the amber preset keeps its one colour.
  _idleSecond(colA, t) {
    if (theme.themeName() === "amber") return colA;
    return theme.fit({ l: colA.l, c: Math.max(colA.c, 0.1), h: (colA.h + 110 + 360 * ((t / 90) % 1)) % 360 });
  }

  // One ghost loop drawn once (redrawn when its colour has moved a few degrees).
  _idleLayer(side, col) {
    const st = this.idleSt;
    const key = `${this.w}x${this.h}@${this.dpr}|${Math.round(col.h / 3)}|${col.l.toFixed(2)}|${theme.themeName()}`;
    const have = st.layers[side];
    if (have && have.key === key) return have.canvas;
    const g = this._idleGeom();
    const c = have?.canvas || document.createElement("canvas");
    c.width = Math.round(this.w * this.dpr);
    c.height = Math.round(this.h * this.dpr);
    const ctx = c.getContext("2d");
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const rnd = seeded(side > 0 ? 7741 : 3319);
    const N = 112; // beats round the loop
    const u0 = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    let walk = 0.5;
    for (let i = 0; i < N; i++) {
      const ua = u0 + (Math.PI * i) / N, ub = u0 + (Math.PI * (i + 1)) / N;
      walk = Math.max(0, Math.min(1, walk + (rnd() - 0.5) * 0.3));
      // Thin to nothing toward the crossing, where the two loops meet.
      const end = Math.pow(Math.sin((Math.PI * (i + 0.5)) / N), 0.6);
      const loud = (0.3 + 0.7 * walk) * end;
      const tone = { l: col.l - 0.05 + 0.1 * rnd(), c: col.c, h: col.h + (rnd() - 0.5) * 26 };
      ctx.strokeStyle = theme.css(tone, 0.12 + 0.42 * loud);
      ctx.lineWidth = g.th * (i % 4 === 0 ? 1 : 0.74) * (0.7 + 0.3 * end);
      ctx.beginPath();
      for (let q = 0; q <= 3; q++) {
        const [x, y] = this._idlePt(g, ua + ((ub - ua) * q) / 3 - (q === 3 ? 0.002 : 0));
        if (q) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      const count = 2 + Math.round(7 * loud);
      ctx.fillStyle = theme.css(tone);
      for (let k = 0; k < count; k++) {
        const u = ua + rnd() * (ub - ua);
        const [x, y] = this._idlePt(g, u);
        const [nx, ny] = this._idleNormal(g, u);
        const spread = (rnd() + rnd() + rnd() - 1.5) / 1.5;
        const off = spread * g.th * 2.6;
        ctx.globalAlpha = (0.1 + 0.4 * rnd() * (1 - Math.abs(spread))) * end;
        ctx.beginPath();
        ctx.arc(x + nx * off, y + ny * off, 0.5 + rnd() * 0.9, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    st.layers[side] = { key, canvas: c };
    return c;
  }

  // Jump chords inside a loop: each lives 9-15 s, fading in and out, then
  // comes back between two other points of the same loop.
  _idleChord(side, t) {
    const span = 0.5 + Math.random() * 1.6;
    const ua = (side > 0 ? -Math.PI / 2 : Math.PI / 2) + 0.25 + Math.random() * (Math.PI - 0.5 - span);
    return { side, ua, ub: ua + span, t0: t, life: 9 + Math.random() * 6 };
  }

  _drawIdle(ctx, now, alpha) {
    const g = this._idleGeom();
    const t = now / 1000;
    const still = this.reduced;
    const st = this.idleSt || (this.idleSt = { layers: {}, chords: [], sparks: [], ripples: [], lastCos: null, lastT: t });
    if (!st.chords.length) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 6; k++) {
          const ch = this._idleChord(side, t);
          ch.t0 -= Math.random() * ch.life; // already under way, not all at once
          st.chords.push(ch);
        }
      }
    }
    const colA = this.accent || theme.idleAccent();
    const colB = this._idleSecond(colA, still ? 0 : t);
    const loopCol = (side) => (side > 0 ? colB : colA);
    // The light's colour along the ∞: one loop's, then the other's across the middle.
    const colAt = (u) => theme.mix(colA, colB, clamp01(0.5 + 3 * Math.cos(u)));
    const breath = still ? 0.5 : 0.5 - 0.5 * Math.cos((TAU * t) / 4.8);

    ctx.save();
    // The two ghost loops, breathing.
    ctx.globalAlpha = alpha * (0.76 + 0.24 * breath);
    for (const side of [-1, 1]) ctx.drawImage(this._idleLayer(side, loopCol(side)), 0, 0, this.w, this.h);

    // The path itself, a hairline.
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.strokeStyle = theme.css(theme.lift(loopCol(side), 0.12), 0.18);
      ctx.beginPath();
      const u0 = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      for (let i = 0; i <= 120; i++) {
        const [x, y] = this._idlePt(g, u0 + (Math.PI * i) / 120);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }

    // Jump chords, curving in toward the loop's middle.
    for (let k = 0; k < st.chords.length; k++) {
      let ch = st.chords[k];
      if (!still && t - ch.t0 > ch.life) ch = st.chords[k] = this._idleChord(ch.side, t);
      const life = still ? 0.5 : (t - ch.t0) / ch.life;
      const o = Math.sin(Math.PI * clamp01(life));
      if (o < 0.02) continue;
      const [x1, y1] = this._idlePt(g, ch.ua), [x2, y2] = this._idlePt(g, ch.ub);
      const mx = g.cx + ch.side * g.a * 0.52, my = g.cy;
      ctx.strokeStyle = theme.css(theme.lift(loopCol(ch.side), 0.06), 0.15 * o);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx + ((x1 + x2) / 2 - mx) * 0.2, my + ((y1 + y2) / 2 - my) * 0.2, x2, y2);
      ctx.stroke();
    }

    // Under the pointer, the nearest stretch of the path lights up.
    if (this.pointer && !still) {
      let best = null;
      for (let i = 0; i < 240; i++) {
        const u = (TAU * i) / 240;
        const [x, y] = this._idlePt(g, u);
        const d = Math.hypot(x - this.pointer.x, y - this.pointer.y);
        if (!best || d < best.d) best = { d, x, y, u };
      }
      if (best.d < 70) {
        const k = 1 - best.d / 70;
        const glow = ctx.createRadialGradient(best.x, best.y, 0, best.x, best.y, 40);
        glow.addColorStop(0, theme.css(theme.lift(colAt(best.u), 0.1), 0.35 * k));
        glow.addColorStop(1, theme.css(colAt(best.u), 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(best.x, best.y, 40, 0, TAU);
        ctx.fill();
      }
    }

    // The light: once round the ∞ in 8 s, its tail fading and thinning.
    const uH = still ? 0.6 : (t / 8) * TAU;
    const TAIL = 64;
    let prev = this._idlePt(g, uH);
    for (let k = 1; k <= TAIL; k++) {
      const u = uH - k * 0.016;
      const p = this._idlePt(g, u);
      const f = 1 - k / TAIL;
      ctx.strokeStyle = theme.css(colAt(u), 0.75 * f * f);
      ctx.lineWidth = 0.6 + 2.6 * f;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      prev = p;
    }
    const [hx, hy] = this._idlePt(g, uH);
    const colH = colAt(uH);
    const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, 30);
    halo.addColorStop(0, theme.css(theme.lift(colH, 0.14), 0.9));
    halo.addColorStop(0.35, theme.css(colH, 0.35));
    halo.addColorStop(1, theme.css(colH, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(hx, hy, 30, 0, TAU);
    ctx.fill();
    ctx.fillStyle = theme.css(theme.lift(colH, 0.18));
    ctx.beginPath();
    ctx.arc(hx, hy, 2.4, 0, TAU);
    ctx.fill();

    if (!still) {
      const dt = Math.min(0.1, Math.max(0, t - st.lastT));
      st.lastT = t;
      // A few sparks shed by the light, drifting just off the path.
      if (Math.random() < dt * 12 && st.sparks.length < 24) {
        const [nx, ny] = this._idleNormal(g, uH);
        const side = Math.random() < 0.5 ? -1 : 1;
        const v = 3 + Math.random() * 7;
        st.sparks.push({ x: hx, y: hy, vx: nx * v * side + (Math.random() - 0.5) * 3, vy: ny * v * side + (Math.random() - 0.5) * 3,
          t0: t, col: colH });
      }
      // A ripple where the light crosses the middle (every 4 s).
      const cs = Math.cos(uH);
      if (st.lastCos != null && Math.sign(cs) !== Math.sign(st.lastCos)) st.ripples.push({ t0: t, col: colH });
      st.lastCos = cs;
      for (const s of st.sparks) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
      }
      st.sparks = st.sparks.filter((s) => t - s.t0 < 1);
      st.ripples = st.ripples.filter((r) => t - r.t0 < 1.6);
      for (const s of st.sparks) {
        const f = 1 - (t - s.t0);
        ctx.fillStyle = theme.css(theme.lift(s.col, 0.1), 0.45 * f);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 0.3 + 0.8 * f, 0, TAU);
        ctx.fill();
      }
      for (const r of st.ripples) {
        const e = easeOut((t - r.t0) / 1.6);
        ctx.strokeStyle = theme.css(theme.lift(r.col, 0.1), 0.32 * (1 - e));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, 6 + 58 * e, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.restore();
    // The caption hangs from just under the ∞ (its lowest point is a / 2√2,
    // plus the dust around it), whatever its height.
    this.idleCaptionY = g.cy + g.a * 0.354 + 3 * g.th + 22;
  }

  // ---------------------------------------------------------------- caption

  _placeCenter(place) {
    const el = this.center;
    if (!el) return;
    const ring = place.ring;
    if ((ring?.track.id || null) !== this._captionId) {
      this._captionId = ring?.track.id || null;
      this.onCaption(); // the page writes the new song's title before it fades in
    }
    let x, y, w, size, o;
    if (ring && ring.alpha > 0.05) {
      x = ring.x;
      y = ring.y;
      w = ring.r * 1.32;
      size = Math.max(15, Math.min(38, ring.r * 0.125));
      o = Math.min(1, ring.alpha * (ring.fill < 1 ? easeOut(ring.fill) : 1)) * place.dip;
    } else {
      x = this.w / 2;
      y = Math.min(this.h - 60, this.idleCaptionY || this.h * 0.78);
      w = Math.min(this.w * 0.8, 520);
      size = Math.max(16, Math.min(28, this.w * 0.03));
      o = 1;
    }
    const key = `${x.toFixed(1)}|${y.toFixed(1)}|${w.toFixed(0)}|${size.toFixed(1)}|${o.toFixed(2)}`;
    if (key === this._centerKey) return;
    this._centerKey = key;
    el.style.setProperty("--rc-x", `${x}px`);
    el.style.setProperty("--rc-y", `${y}px`);
    el.style.setProperty("--rc-w", `${w}px`);
    el.style.setProperty("--rc-size", `${size}px`);
    el.style.setProperty("--rc-o", o.toFixed(2));
    el.dataset.mode = ring ? "ring" : "idle";
    // Small loops (phones, the ∞ layout) keep the title and drop the details.
    el.dataset.size = ring && ring.r < 125 ? "s" : "m";
  }

  // The page's light field follows the loops (atmospheric field, ~10 updates/s).
  _updateField(primary, now) {
    if (now - this.fieldAt < 100) return;
    this.fieldAt = now;
    const root = document.documentElement.style;
    const rect = this.canvas.getBoundingClientRect();
    const vw = window.innerWidth || 1;
    if (primary) root.setProperty("--key-x", `${(((rect.left + primary.x) / vw) * 100).toFixed(1)}%`);
    const second = [...this.rings.values()].find((r) => r.role === "second");
    const place = second || this.placeholder;
    if (place) root.setProperty("--fill-x", `${(((rect.left + place.x) / vw) * 100).toFixed(1)}%`);
    // CSS eases these over a second or so; the targets go out unsmoothed.
    const view = this.player.audible();
    const a = primary ? theme.accentOf(primary.track.id) : this.lightOf ? theme.accentOf(this.lightOf) : theme.idleAccent();
    const target = this.nextId ? theme.mix(a, theme.accentOf(this.nextId), this._mixProgress(view)) : a;
    const second2 = this.nextId ? theme.songColor(this.nextId) : null;
    theme.applyPage(target, second2, this.nextId ? 0.1 * theme.glowGain() : 0);
    root.setProperty("--pulse", Math.min(1.4, 0.6 * this.pulse + 0.9 * this.bass).toFixed(2));
  }

  // ------------------------------------------------------------- pointer

  _bindPointer() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, type: e.pointerType };
    };
    c.addEventListener("pointermove", (e) => {
      this.pointer = pos(e);
    });
    c.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.hover = null;
      this.armed = null;
      this._showTip(null);
    });
    c.addEventListener("pointerup", (e) => {
      const p = pos(e);
      this.pointer = p;
      const hit = this._hitTest(p.x, p.y);
      if (hit?.kind === "beat" && this._seekable(hit)) {
        // A beat of the playing song: play from there (on a touch screen,
        // the first tap shows where, a second tap on the ring goes).
        if (p.type !== "mouse" && this.armed !== "seek") {
          this.armed = "seek";
          this.hover = hit;
          return;
        }
        this.armed = null;
        const ok = this.onSeek(hit.ring.track, hit.beat);
        this.pickFeedback = { kind: "seek", ok, at: performance.now(), x: hit.x, y: hit.y, t: hit.ring.track.beats[hit.beat] };
        this.hover = null;
        if (p.type !== "mouse") this.pointer = null;
        return;
      }
      if (hit?.kind !== "exit") {
        this.armed = null;
        if (p.type !== "mouse") this.hover = hit;
        return;
      }
      if (p.type !== "mouse" && this.armed !== hit.tr) {
        // First tap on a touch screen shows where the exit leads.
        this.armed = hit.tr;
        this.hover = hit;
        return;
      }
      this.armed = null;
      const ok = this.onPick(hit.tr);
      this.pickFeedback = { kind: "pick", ok, at: performance.now(), tr: hit.tr, x: hit.x, y: hit.y };
      this.hover = null;
      if (p.type !== "mouse") this.pointer = null;
    });
  }

  _hitTest(px, py) {
    const primary = this.primaryId ? this.rings.get(this.primaryId) : null;
    if (!primary || primary.alpha < 0.5) return null;
    const T = primary.track;
    const rx = this._exitRadius(primary.r);
    let best = null;
    for (const tr of T.transitions) {
      if (!this._shown(T, tr)) continue;
      const t = this._exitTime(T, tr);
      if (t === null) continue;
      const [x, y] = this._point(primary, t, rx);
      const d = Math.hypot(px - x, py - y);
      if (d < 12 && (!best || d < best.d)) best = { kind: "exit", tr, x, y, d };
    }
    if (best) return best;
    for (const ring of [primary, ...[...this.rings.values()].filter((r) => r.role === "second")]) {
      const dx = px - ring.x, dy = py - ring.y;
      const d = Math.hypot(dx, dy);
      const th = this._thickness(ring.r);
      if (Math.abs(d - ring.r) > th * 1.5) continue;
      let a = ((Math.atan2(dy, dx) - ring.rot) * ring.dir) % TAU;
      if (a < 0) a += TAU;
      const t = (a / TAU) * ring.track.end;
      return { kind: "beat", ring, beat: this._beatAt(ring.track, t).beat, t, x: px, y: py };
    }
    return null;
  }

  _drawHover(ctx) {
    if (this.pointer && this.pointer.type === "mouse") this.hover = this._hitTest(this.pointer.x, this.pointer.y);
    const h = this.hover;
    this.canvas.style.cursor = h?.kind === "exit" || (h?.kind === "beat" && this._seekable(h)) ? "pointer" : "";
    const fb = this.pickFeedback && performance.now() - this.pickFeedback.at < 1800 ? this.pickFeedback : null;
    // Right after a pick the loop turns under the pointer; the confirmation
    // wins over whatever beat slides beneath it, unless another exit is hovered.
    if (fb && !(h && h.kind === "exit" && h.tr !== fb.tr)) {
      this._showTip(this._feedbackHtml(), fb.x, fb.y);
      return;
    }
    if (!h) {
      this._showTip(null);
      return;
    }
    if (h.kind === "beat") {
      const ring = h.ring;
      const T = ring.track;
      const hi = theme.lift(ring.col || theme.accentOf(T.id), 0.12);
      ctx.strokeStyle = theme.css(hi, 0.95);
      ctx.lineWidth = 1.6;
      const limit = this.player.maxScore(T);
      const outs = T.jumps[h.beat].filter((e) => e.score <= limit || e.bridge);
      for (const e of outs) {
        this._chordWorld(ctx, ring, h.beat, e.to);
        ctx.stroke();
      }
      const a1 = this._angle(ring, T.beats[h.beat]);
      const a2 = this._angle(ring, T.beats[h.beat] + T.dur[h.beat]);
      ctx.strokeStyle = theme.css(hi, 0.9);
      ctx.lineWidth = this._thickness(ring.r) + 8;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.r, a1, a2, ring.dir < 0);
      ctx.stroke();
      const name = esc(short(this.titles.get(T.id) || T.meta.title || "", 34));
      const n = outs.length;
      const role = this._roleAt(T, h.beat);
      const action = !this._seekable(h) ? ""
        : this.armed === "seek" ? "<small>Chạm lần nữa để phát từ đây</small>" : "<small>Bấm để phát từ đây</small>";
      this._showTip(
        `<span class="mono">${fmt(T.beats[h.beat])}</span>${role ? ` · ${role}` : ""} · ${n ? `${n} nhánh nhảy` : "không có nhánh"}` +
          `<small>${name}</small>${action}`,
        h.x, h.y,
      );
      return;
    }
    // Exit dot.
    ctx.strokeStyle = theme.css(theme.lift(theme.songColor(h.tr.to), 0.2), 0.95);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 8, 0, TAU);
    ctx.stroke();
    const tr = h.tr;
    const title = esc(short(this.titles.get(tr.to) || tr.to, 36));
    const action = this.armed === tr ? "Chạm lần nữa để chuyển ở điểm này" : "Bấm để chuyển ở điểm này";
    const note = bendNote(tr);
    this._showTip(
      `<b>${KIND_VI[tr.type] || tr.type}</b> → <span class="dot" style="--c:${theme.css(theme.songColor(tr.to))}"></span>${title}<br><span class="mono">khớp ${Math.round(tr.q * 100)}%</span>` +
        `${note ? `<small>${esc(note)}</small>` : ""}<small>${action}</small>`,
      h.x, h.y,
    );
  }

  // A beat the listener may play from: on the playing song's ring.
  _seekable(hit) {
    return hit.ring.track === this.player.cur?.track;
  }

  _roleAt(T, beat) {
    const roles = T.analysis.roles || [];
    let r = null;
    for (const s of roles) if (s.start <= beat) r = s.role;
    return ROLE_VI[r] || "";
  }

  _feedbackHtml() {
    const f = this.pickFeedback;
    if (f.kind === "seek") {
      if (f.ok) return `<b>Phát từ <span class="mono">${fmt(f.t)}</span></b><small>Vào ngay ở nhịp kế tiếp</small>`;
      return this.player.seekError === "busy"
        ? `<b>Đang chuyển sang bài khác</b><small>Chọn lại khi bài sau đã vào hẳn</small>`
        : `<b>Chưa có bài nào đang phát</b>`;
    }
    if (f.ok) return `<b>Đã chọn điểm nối này</b><small>Vòng đang xoay về phía bài kế tiếp</small>`;
    return {
      busy: `<b>Đang chuyển sang bài khác</b><small>Chọn lại khi bài sau đã vào hẳn</small>`,
      unreachable: `<b>Không đi tới được điểm này</b><small>Từ chỗ đang phát không có đường tới: chọn chấm khác</small>`,
      soon: `<b>Điểm này tới quá sát</b><small>Cần vài giây chuẩn bị: chọn chấm xa hơn một chút</small>`,
    }[this.player.pickError] || `<b>Điểm này không còn dùng được</b><small>Chọn chấm khác</small>`;
  }

  // Exits shown on a ring: those the chain may take now.
  _shown(track, tr) {
    return this.player.canTake ? this.player.canTake(track, tr) : true;
  }

  _showTip(html, x = 0, y = 0) {
    const tip = this.tip;
    if (!tip) return;
    if (!html) {
      if (!tip.hidden) tip.hidden = true;
      return;
    }
    if (tip.innerHTML !== html) tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    const left = Math.max(8, Math.min(this.w - w - 8, x + 16));
    const top = Math.max(8, Math.min(this.h - hgt - 8, y - hgt - 14));
    tip.style.setProperty("--tip-x", `${left}px`);
    tip.style.setProperty("--tip-y", `${top}px`);
  }
}

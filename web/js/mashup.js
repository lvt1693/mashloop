// The mashup studio. A few songs of the library are made into one new song by
// the server (loopbox/mashup: one tempo, one key, a form from intro to outro),
// and the mashups this browser made are listed with what is left of their 48
// hours. Nobody has an account: each mashup is reached with the token the
// server gave when it was made, kept in this browser's storage. They are heard
// on the page only, as they are, or as a song of the loop (the stage).
import { api } from "./api.js";
import * as theme from "./theme.js";
import { fmt, short, splitTitle } from "./viz.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");

const STORE = "mashloop.mashups.v1";
const PREFS = "mashloop.mashup-opts.v1";
const MIN_SONGS = 2;
const MAX_SONGS = 5;
const KEEP = 30; // the server answers for this many at once
// The techniques and the moves between acts (loopbox/mashup/plan.py FX); the
// abrupt ones are off until asked for.
const FX = ["teaser", "breakdown", "double", "chop", "blend", "buildup", "filter", "echo", "wash", "roll", "gate",
  "brake", "spin"];
const FX_OFF = new Set(["roll", "gate", "brake", "spin"]);

const STYLE_VI = { auto: "Tự do", duet: "Song đấu", medley: "Liên khúc", swap: "Hoán giọng", megamix: "Megamix" };
const VIBE_VI = { auto: "Tự chọn", original: "Nguyên bản", club: "Club remix", chill: "Chill", slowed: "Slowed + reverb",
  speedup: "Speed up", acoustic: "Mộc" };
const ROLE_VI = { auto: "Tự chọn", vocals: "Giọng", music: "Nhạc" };
const USE_VI = { vocals: "lấy giọng hát", music: "lấy phần nhạc", both: "cả bài" };
const STAGE_VI = { queued: "Đang chờ tới lượt", stems: "Tách giọng hát bằng model mới", drums: "Tách tiếng trống cho bản mộc", load: "Đọc các bài",
  stretch: "Kéo về một nhịp, một tông", mix: "Trộn các lớp", master: "Cân âm lượng", encode: "Đóng gói" };
// How high each part of the form stands in its strip: the form reads as the
// song's energy from start to end.
const LIFT = { intro: 0.34, verse: 0.55, build: 0.74, chorus: 0.9, drop: 1, mash: 0.8, break: 0.3, outro: 0.36,
  finale: 1 };

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const CAM_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAM_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const keyName = (n, letter) => `${NAMES[(letter === "B" ? CAM_MAJOR : CAM_MINOR).indexOf(n)]} ${letter === "B" ? "major" : "minor"}`;

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>',
  load: '<svg class="i-load" viewBox="0 0 48 24" aria-hidden="true"><path d="M24 12 C 30 4, 42 4, 42 12 C 42 20, 30 20, 24 12 C 18 4, 6 4, 6 12 C 6 20, 18 20, 24 12 Z"/></svg>',
  inf: '<svg viewBox="0 0 48 24" aria-hidden="true"><path d="M24 12 C 30 4, 42 4, 42 12 C 42 20, 30 20, 24 12 C 18 4, 6 4, 6 12 C 6 20, 18 20, 24 12 Z"/></svg>',
  del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4v4h4"/></svg>',
};

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch (_) {
    return fallback;
  }
}

// False when this browser keeps nothing (a private window, storage blocked):
// a mashup made then is reachable until the page closes.
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------------ player

// One mashup at a time, from a media element (a 10-minute song decoded whole
// would be ~200 MB of samples), through the engine's master so the volume,
// the limiter and the room's light (the analyser) are the loop's own.
class MashPlayer extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.el = new Audio();
    this.el.preload = "auto";
    this.node = null;
    this.item = null;
    this.loading = null; // the id being fetched
    this.urls = new Map(); // id -> blob url, the last two heard
    this.unlocked = false;
    for (const e of ["play", "pause", "ended", "loadedmetadata"]) this.el.addEventListener(e, () => this.dispatchEvent(new Event("state")));
  }

  get id() {
    return this.item?.id || null;
  }

  get playing() {
    return !!this.item && !this.el.paused && !this.el.ended;
  }

  get time() {
    return this.el.currentTime || 0;
  }

  // Called inside the click: the context resumes and the element is allowed
  // to play later, once its sound has arrived (Safari asks for a gesture).
  _gesture() {
    this.engine.ctx.resume();
    if (!this.node) {
      this.node = this.engine.ctx.createMediaElementSource(this.el);
      this.node.connect(this.engine.master);
    }
    if (!this.unlocked && !this.el.src) {
      this.el.src = silence();
      this.el.play().catch(() => {});
      this.unlocked = true;
    }
  }

  async play(item, at = null) {
    this._gesture();
    if (this.loading === item.id) return;
    if (this.item?.id !== item.id || !this.ready) {
      this.el.pause();
      this.item = item;
      this.ready = false;
      let url = this.urls.get(item.id);
      if (!url) {
        this.loading = item.id;
        this.dispatchEvent(new Event("state"));
        try {
          const buf = await api.mashupAudio(item.id, item.token);
          url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
        } catch (e) {
          if (this.item?.id === item.id) this.item = null;
          throw e;
        } finally {
          if (this.loading === item.id) this.loading = null;
          this.dispatchEvent(new Event("state"));
        }
        this._keep(item.id, url);
        if (this.item?.id !== item.id) return; // another one was asked for meanwhile
      }
      this.el.src = url;
      this.ready = true;
    }
    if (at !== null) this.el.currentTime = at;
    else if (this.el.ended) this.el.currentTime = 0;
    await this.el.play();
  }

  _keep(id, url) {
    this.urls.set(id, url);
    for (const [k, u] of this.urls) {
      if (this.urls.size <= 2) break;
      if (k !== id && k !== this.item?.id) {
        URL.revokeObjectURL(u);
        this.urls.delete(k);
      }
    }
  }

  pause() {
    this.el.pause();
  }

  seek(t) {
    this.el.currentTime = Math.max(0, t);
  }

  // The mashup went (deleted, expired): forget its sound.
  close(id) {
    if (this.item?.id === id) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
      this.item = null;
      this.ready = false;
    }
    const u = this.urls.get(id);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(id);
    this.dispatchEvent(new Event("state"));
  }
}

// A few milliseconds of silence (a WAV), for unlocking the element.
let silentUrl = null;
function silence() {
  if (silentUrl) return silentUrl;
  const n = 441, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  d.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, 1, true);
  d.setUint32(24, 44100, true);
  d.setUint32(28, 88200, true);
  d.setUint16(32, 2, true);
  d.setUint16(34, 16, true);
  str(36, "data");
  d.setUint32(40, n * 2, true);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return silentUrl;
}

// ------------------------------------------------------------------ studio

export class Studio {
  // deps: engine, player (the loop), metas(), songOf(meta), paintMinis(),
  // renderLibrary(), refresh(), setLight(id), playLoop(tid), showLibrary()
  constructor(deps) {
    this.d = deps;
    this.mp = new MashPlayer(deps.engine);
    this.pick = { ids: [], roles: {} };
    const saved = read(PREFS, {});
    this.opts = {
      style: ["auto", "duet", "medley"].includes(saved.style) ? saved.style : "auto",
      vibe: VIBE_VI[saved.vibe] ? saved.vibe : "auto",
      length: Math.min(600, Math.max(60, +saved.length || 180)),
      bpm: null,
      key: null,
      fx: Object.fromEntries(FX.map((k) => [k, saved.fx?.[k] ?? !FX_OFF.has(k)])),
      variant: 0, // which of the arrangements the server drew ("Phương án khác")
      pace: ["natural", "fast", "faster"].includes(saved.pace) ? saved.pace : "fast",
    };
    this.mine = (read(STORE, []) || []).filter((m) => m && /^[0-9a-f]{16}$/.test(m.id) && m.token);
    this.views = new Map(); // id -> what the server says of it
    this.skew = 0; // server clock minus this one, seconds
    this.plan = null; // the latest preview
    this.planState = "empty";
    this.planError = "";
    this.previewSeq = 0;
    this.loopWait = new Map(); // mashup id -> the loop song being analysed for it
    this.loopError = new Map();
    this.making = false;
    this.makeError = "";
    this.stored = true;
    this.cards = new Map(); // id -> rendered html, so a card is only rebuilt when it changed
    this._bind();
    this._fillKeys();
    this.syncControls();
    this.renderSlots();
    this.renderPlan();
    this.renderMine();
    this.poll();
    setInterval(() => this.tick(), 15000);
  }

  // ------------------------------------------------------------- picking

  index(id) {
    return this.pick.ids.indexOf(id);
  }

  toggle(id) {
    const k = this.index(id);
    if (k >= 0) {
      this.pick.ids.splice(k, 1);
      delete this.pick.roles[id];
    } else if (this.pick.ids.length < MAX_SONGS) {
      this.pick.ids.push(id);
    } else {
      this._flashCount();
      return;
    }
    this.changed();
  }

  _flashCount() {
    const el = $("#mx-count");
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  // The library changed: songs gone (or no longer ready) leave the mashup;
  // a loop song being analysed for a mashup plays once it is ready.
  onMetas(metas) {
    const ready = new Set(metas.filter((m) => m.status === "ready").map((m) => m.id));
    const kept = this.pick.ids.filter((id) => ready.has(id));
    if (kept.length !== this.pick.ids.length) {
      for (const id of this.pick.ids) if (!ready.has(id)) delete this.pick.roles[id];
      this.pick.ids = kept;
      this.changed();
    } else {
      this.renderSlots();
    }
    for (const [mid, tid] of this.loopWait) {
      const m = metas.find((x) => x.id === tid);
      if (m?.status === "ready") {
        this.loopWait.delete(mid);
        this.d.playLoop(tid);
      } else if (!m || m.status === "error") {
        this.loopWait.delete(mid);
        this.loopError.set(mid, m?.error || "Không phân tích được bài mashup");
      }
    }
    this.renderMine();
    this.renderNow();
  }

  changed() {
    this.opts.variant = 0;
    this.renderSlots();
    this.d.renderLibrary();
    this.preview();
  }

  // ----------------------------------------------------------- controls

  _bind() {
    for (const r of document.querySelectorAll('input[name="mx-style"]')) {
      r.addEventListener("change", () => this.set({ style: r.value }));
    }
    for (const r of document.querySelectorAll('input[name="mx-vibe"]')) {
      r.addEventListener("change", () => this.set({ vibe: r.value }));
    }
    for (const r of document.querySelectorAll('input[name="mx-pace"]')) {
      r.addEventListener("change", () => this.set({ pace: r.value }));
    }
    $("#mx-len").addEventListener("input", (e) => {
      this.opts.length = +e.target.value;
      this.syncControls();
      this.preview();
    });
    for (const c of document.querySelectorAll(".mx-fx input")) {
      c.addEventListener("change", () => this.set({ fx: { ...this.opts.fx, [c.value]: c.checked } }));
    }
    $("#mx-plan").addEventListener("click", (e) => {
      if (!e.target.closest("[data-act=variant]") || this.planState !== "ok") return;
      // Another arrangement of the same songs and options.
      const n = this.plan?.variants || 1;
      this.opts.variant = (this.opts.variant + 1) % n;
      this.preview();
    });
    $("#mx-bpm").addEventListener("change", (e) => {
      const v = +e.target.value;
      this.set({ bpm: e.target.value && v >= 60 && v <= 200 ? v : null });
    });
    $("#mx-key").addEventListener("change", (e) => this.set({ key: e.target.value || null }));
    $("#mx-make").addEventListener("click", () => this.make());

    $("#mx-slots").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "to-lib") return this.d.showLibrary();
      const id = b.closest(".slot")?.dataset.id;
      if (!id) return;
      if (b.dataset.act === "unpick") this.toggle(id);
      else if (b.dataset.role) {
        // One bed for a swap: a song asked for its music takes that from any other.
        if (b.dataset.role === "music") for (const [k, r] of Object.entries(this.pick.roles)) if (r === "music") delete this.pick.roles[k];
        this.pick.roles[id] = b.dataset.role;
        if (b.dataset.role === "auto") delete this.pick.roles[id];
        this.changed();
      }
    });

    const mine = $("#mx-mine");
    mine.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      const card = e.target.closest(".mx");
      if (!card) return;
      const item = this.mine.find((m) => m.id === card.dataset.id);
      if (!item) return;
      if (b) return this.act(b.dataset.act, item, b);
      const form = e.target.closest(".form");
      if (form && this.views.get(item.id)?.status === "done") this.seekTo(item, form, e);
    });
    mine.addEventListener("keydown", (e) => {
      const form = e.target.closest(".form[tabindex]");
      if (!form || !this.mp.playing) return;
      const card = form.closest(".mx");
      if (card?.dataset.id !== this.mp.id) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        this.mp.seek(this.mp.time + (e.key === "ArrowRight" ? 10 : -10));
      }
    });

    this.mp.addEventListener("state", () => {
      this.renderMine();
      this._follow();
      this.renderBadge();
      // The room takes the colour of the band of the mashup being heard.
      const srcs = this.views.get(this.mp.id)?.plan?.sources || [];
      this.d.setLight(this.mp.playing ? (srcs.find((s) => s.use === "music") || srcs[0])?.id || null : null);
    });
    // One sound at a time: the loop starting (or going on) stops the mashup.
    this.d.player.addEventListener("state", () => {
      if (this.d.player.cur && this.d.player.playing && this.mp.playing) this.mp.pause();
      this.renderNow();
    });
    this.d.player.addEventListener("track", () => this.renderNow());
    $("#mx-now").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "stop-loop") this.d.player.stop();
      else if (b.dataset.act === "to-stage") location.hash = "#nghe";
    });
  }

  set(patch) {
    Object.assign(this.opts, patch, { variant: 0 });
    write(PREFS, { style: this.opts.style, vibe: this.opts.vibe, length: this.opts.length, fx: this.opts.fx,
      pace: this.opts.pace });
    this.syncControls();
    this.renderSlots(); // the roles show for a swap only
    this.preview();
  }

  _fillKeys() {
    const sel = $("#mx-key");
    const opts = [];
    for (let n = 1; n <= 12; n++) {
      for (const l of ["A", "B"]) opts.push(`<option value="${n}${l}">${n}${l} · ${keyName(n, l)}</option>`);
    }
    sel.insertAdjacentHTML("beforeend", opts.join(""));
  }

  syncControls() {
    const o = this.opts;
    for (const r of document.querySelectorAll('input[name="mx-style"]')) r.checked = r.value === o.style;
    for (const r of document.querySelectorAll('input[name="mx-vibe"]')) r.checked = r.value === o.vibe;
    for (const r of document.querySelectorAll('input[name="mx-pace"]')) r.checked = r.value === o.pace;
    const len = $("#mx-len");
    len.value = o.length;
    len.style.setProperty("--v", `${((o.length - 60) / 540) * 100}%`);
    $("#mx-v-len").textContent = fmt(o.length);
    for (const c of document.querySelectorAll(".mx-fx input")) c.checked = o.fx[c.value] !== false;
    const set = [o.bpm && `${o.bpm} BPM`, o.key].filter(Boolean).join(" · ");
    $("#mx-frame-set").textContent = set || "tự chọn";
  }

  request() {
    const o = this.opts;
    return { ids: [...this.pick.ids], roles: { ...this.pick.roles }, style: o.style, vibe: o.vibe, length: o.length,
      bpm: o.bpm, key: o.key, fx: { ...o.fx }, variant: o.variant, pace: o.pace };
  }

  // ------------------------------------------------------------ preview

  // The plan the options make, asked of the server a moment after the last change.
  preview() {
    clearTimeout(this.previewT);
    const seq = ++this.previewSeq;
    if (this.pick.ids.length < MIN_SONGS) {
      this.plan = null;
      this.planState = "empty";
      this.renderPlan();
      return;
    }
    this.planState = "loading";
    this.renderPlan();
    this.previewT = setTimeout(async () => {
      try {
        const plan = await api.previewMashup(this.request());
        if (seq !== this.previewSeq) return;
        this.plan = plan;
        this.planState = "ok";
      } catch (e) {
        if (seq !== this.previewSeq) return;
        this.plan = null;
        this.planState = "error";
        this.planError = e.message;
      }
      this.renderPlan();
    }, 380);
  }

  // ------------------------------------------------------------- making

  async make() {
    if (this.making || this.planState !== "ok") return;
    this.making = true;
    this.makeError = "";
    this.renderPlan();
    try {
      const r = await api.createMashup(this.request());
      this.mine.unshift({ id: r.id, token: r.token, at: Date.now(), req: this.request() });
      this.mine = this.mine.slice(0, KEEP);
      this.stored = write(STORE, this.mine.map(({ id, token, at, req }) => ({ id, token, at, req })));
      this.views.set(r.id, r.mashup);
      this.skew = r.mashup.now - Date.now() / 1000;
      this.renderMine();
      const card = document.querySelector(`.mx[data-id="${r.id}"]`);
      card?.scrollIntoView({ behavior: reduceMQ.matches ? "auto" : "smooth", block: "nearest" });
      this.poll();
    } catch (e) {
      this.makeError = e.message;
    }
    this.making = false;
    this.renderPlan();
  }

  save() {
    this.stored = write(STORE, this.mine.map(({ id, token, at, req }) => ({ id, token, at, req })));
  }

  // What the server says of this browser's mashups: fast while one is being
  // made, then once a minute (an expired one disappears).
  async poll() {
    clearTimeout(this.pollT);
    if (!this.mine.length) {
      this.renderMine();
      return;
    }
    try {
      const r = await api.mashups(this.mine.map(({ id, token }) => ({ id, token })));
      this.skew = r.now - Date.now() / 1000;
      for (const v of r.mashups) this.views.set(v.id, v);
      if (r.gone.length) {
        const gone = new Set(r.gone);
        this.mine = this.mine.filter((m) => !gone.has(m.id));
        for (const id of gone) {
          this.views.delete(id);
          this.mp.close(id);
        }
        this.save();
      }
      this.offline = false;
    } catch (_) {
      this.offline = true;
    }
    this.renderMine();
    const busy = [...this.views.values()].some((v) => v.status === "queued" || v.status === "rendering");
    this.pollT = setTimeout(() => this.poll(), busy ? 2000 : 60000);
  }

  tick() {
    for (const card of document.querySelectorAll(".mx")) this._sync(card, this.views.get(card.dataset.id));
    if ([...this.views.values()].some((v) => v.expires_at && this.left(v) <= 0)) this.poll();
  }

  left(v) {
    return v?.expires_at ? v.expires_at - (Date.now() / 1000 + this.skew) : null;
  }

  async act(what, item, btn) {
    const v = this.views.get(item.id);
    switch (what) {
      case "play":
        if (this.mp.id === item.id && this.mp.playing) this.mp.pause();
        else this.start(item);
        break;
      case "loop":
        this.toLoop(item, btn);
        break;
      case "retry":
        this.retry(item);
        break;
      case "delete":
        // Two taps: the first arms the button for a few seconds.
        if (btn.dataset.armed !== "1") {
          btn.dataset.armed = "1";
          btn.querySelector("span").textContent = "Xoá thật?";
          clearTimeout(btn._t);
          btn._t = setTimeout(() => {
            btn.dataset.armed = "";
            btn.querySelector("span").textContent = "Xoá";
          }, 3500);
          return;
        }
        btn.disabled = true;
        await api.deleteMashup(item.id, item.token).catch(() => {});
        this.mp.close(item.id);
        this.mine = this.mine.filter((m) => m.id !== item.id);
        this.views.delete(item.id);
        this.save();
        this.renderMine();
        if (v?.loop_tid) this.d.refresh();
        break;
    }
  }

  async start(item, at = null) {
    if (this.d.player.cur) this.d.player.stop();
    try {
      await this.mp.play(item, at);
    } catch (e) {
      if (e?.name === "AbortError") return; // another mashup was asked for meanwhile
      this.loopError.set(item.id, `Không phát được: ${e.message}`);
      this.renderMine();
    }
  }

  seekTo(item, form, e) {
    const v = this.views.get(item.id);
    const r = form.getBoundingClientRect();
    const total = this._formLength(v);
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
    if (this.mp.id === item.id && !this.mp.loading) {
      this.mp.seek(t);
      if (!this.mp.playing) this.start(item);
    } else {
      this.start(item, t);
    }
  }

  togglePlay() {
    const item = this.mine.find((m) => m.id === this.mp.id) ||
      this.mine.find((m) => this.views.get(m.id)?.status === "done");
    if (!item) return;
    if (this.mp.id === item.id && this.mp.playing) this.mp.pause();
    else this.start(item);
  }

  // As a song of the library, analysed like any other, played in the loop.
  async toLoop(item, btn) {
    this.d.engine.ctx.resume(); // inside the click: the loop may start later without one
    this.mp.pause();
    this.loopError.delete(item.id);
    btn.disabled = true;
    try {
      const r = await api.loopMashup(item.id, item.token);
      this.loopWait.set(item.id, r.tid);
      const v = this.views.get(item.id);
      if (v) v.loop_tid = r.tid;
      await this.d.refresh();
    } catch (e) {
      this.loopError.set(item.id, e.message);
    }
    this.renderMine();
  }

  retry(item) {
    if (!item.req) return;
    const ready = new Set(this.d.metas().filter((m) => m.status === "ready").map((m) => m.id));
    const ids = item.req.ids.filter((id) => ready.has(id));
    if (ids.length < MIN_SONGS) {
      this.loopError.set(item.id, "Các bài gốc không còn trong thư viện: thêm lại rồi chọn lại");
      this.renderMine();
      return;
    }
    this.pick = { ids: ids.slice(0, MAX_SONGS), roles: Object.fromEntries(Object.entries(item.req.roles || {}).filter(([k]) => ids.includes(k))) };
    const style = { swap: "duet", megamix: "medley" }[item.req.style] || item.req.style;
    Object.assign(this.opts, { style, vibe: item.req.vibe, length: item.req.length, bpm: item.req.bpm,
      key: item.req.key, fx: { ...this.opts.fx, ...item.req.fx }, variant: item.req.variant || 0 });
    $("#mx-bpm").value = this.opts.bpm || "";
    $("#mx-key").value = this.opts.key || "";
    this.syncControls();
    this.changed();
    $(".studio__build").scrollIntoView({ behavior: reduceMQ.matches ? "auto" : "smooth", block: "start" });
  }

  // ------------------------------------------------------------ drawing

  titleOf(src) {
    const m = this.d.metas().find((x) => x.id === src.id);
    return m ? this.d.songOf(m).title : splitTitle(src.title || "", src.artist || "").title || src.title || src.id;
  }

  mashTitle(v) {
    const srcs = v?.plan?.sources || [];
    if (!srcs.length) return v?.title || "Mashup";
    const names = srcs.slice(0, 3).map((s) => short(this.titleOf(s), 28));
    return names.join(" × ") + (srcs.length > 3 ? ` +${srcs.length - 3}` : "");
  }

  renderSlots() {
    const by = new Map(this.d.metas().map((m) => [m.id, m]));
    const roles = this.opts.style !== "megamix";
    const rows = this.pick.ids.map((id) => {
      const m = by.get(id) || { id, title: id };
      const song = this.d.songOf(m);
      const role = this.pick.roles[id] || "auto";
      const sings = !!m.stems;
      const pick = roles
        ? `<div class="roles" role="group" aria-label="Lấy gì từ bài ${esc(song.title)}">${Object.keys(ROLE_VI).map((r) =>
          `<button type="button" data-role="${r}" aria-pressed="${role === r}"${r === "vocals" && !sings ? ' disabled title="Bài này chưa tách được giọng"' : ""}>${ROLE_VI[r]}</button>`).join("")}</div>`
        : "";
      return `<li class="slot" data-id="${esc(id)}" style="--c:${theme.css(theme.songColor(id))}">
        <canvas class="mini" data-id="${esc(id)}" width="76" height="76" aria-hidden="true"></canvas>
        <div class="slot__text"><div class="t" title="${esc(m.title)}">${esc(song.title)}</div><div class="s">${song.artist ? `<span class="a">${esc(song.artist)}</span> · ` : ""}${m.bpm ? m.bpm.toFixed(0) : "?"} BPM · ${esc(m.camelot || "")}${sings ? "" : " · không lời"}</div></div>
        ${pick}
        <button type="button" class="slot__x" data-act="unpick" aria-label="Bỏ ${esc(song.title)} khỏi mashup" title="Bỏ khỏi mashup">${ICON.del}</button>
      </li>`;
    });
    const n = this.pick.ids.length;
    const want = n < MIN_SONGS ? MIN_SONGS : Math.min(MAX_SONGS, n + 1);
    for (let k = n; k < want; k++) {
      const text = k === n
        ? `Bấm <b class="plus">+</b> ở một bài trong <button type="button" class="linkish" data-act="to-lib">thư viện</button> để đưa vào đây${n >= MIN_SONGS ? `, tối đa ${MAX_SONGS} bài` : ""}`
        : "và thêm ít nhất một bài nữa";
      rows.push(`<li class="slot slot--empty"><span class="slot__ring" aria-hidden="true"></span><span>${text}</span></li>`);
    }
    const html = rows.join("");
    const ol = $("#mx-slots");
    if (ol.dataset.html !== html) {
      ol.dataset.html = html;
      ol.innerHTML = html;
      this.d.paintMinis();
    }
    $("#mx-count").textContent = `${n}/${MAX_SONGS}`;
    this.renderShelf();
  }

  // The library's own line in mashup view: how many are picked, and (phones)
  // the way back up to the studio.
  renderShelf() {
    const n = this.pick.ids.length;
    const a = $("#mx-shelf");
    a.innerHTML = n
      ? `<span><b>${n}/${MAX_SONGS}</b> bài đã chọn cho mashup</span><span class="go">Lên chỉnh mashup ↑</span>`
      : `<span>Bấm <b class="plus">+</b> ở một bài để đưa vào mashup</span>`;
  }

  // The strip of the form: the voices on a thin lane above, the band below,
  // each part as high as it is intense, in the colour of its song.
  formHtml(p, mode, label) {
    const secs = p.sections || [];
    if (!secs.length) return "";
    const total = secs[secs.length - 1].t1 || 1;
    const col = (id) => (id ? theme.css(theme.songColor(id)) : "transparent");
    const voice = [], band = [], names = [];
    for (const s of secs) {
      const b = Math.max(0.001, s.t1 - s.t0);
      const music = s.music || [];
      const lift = LIFT[s.kind] ?? 0.6;
      const title = `${s.label} · ${fmt(s.t0)}${s.voice?.length ? ` · giọng ${this._names(p, s.voice)}` : ""} · nhạc ${this._names(p, music)}`;
      voice.push(`<i style="--b:${b};--c:${col(s.voice?.[0])};--c2:${col(s.voice?.[1] || s.voice?.[0])}"${s.voice?.length ? "" : " data-none"}></i>`);
      band.push(`<i style="--b:${b};--e:${lift};--c:${col(music[0])};--c2:${col(music[1] || music[0])}" data-kind="${esc(s.kind)}" title="${esc(title)}"></i>`);
      names.push(`<span style="--b:${b}">${b / total >= 0.075 ? esc(s.label) : ""}</span>`);
    }
    const attrs = mode === "play" || mode === "idle"
      ? ` tabindex="0" role="slider" aria-label="${esc(label)}: chạm để phát từ đoạn đó" aria-valuemin="0" aria-valuemax="${Math.round(total)}"`
      : ` aria-hidden="true"`;
    return `<div class="form" data-mode="${mode}"${attrs}>
      <div class="form__voice">${voice.join("")}</div>
      <div class="form__band">${band.join("")}</div>
      <div class="form__names">${names.join("")}</div>
      <span class="form__dim" aria-hidden="true"></span><span class="form__head" aria-hidden="true"></span>
    </div>`;
  }

  _names(p, ids) {
    return ids.map((id) => {
      const s = (p.sources || []).find((x) => x.id === id);
      return `«${short(s ? this.titleOf(s) : id, 24)}»`;
    }).join(" + ") || "—";
  }

  _formLength(v) {
    const secs = v?.plan?.sections || [];
    return secs.length ? secs[secs.length - 1].t1 : v?.seconds || 1;
  }

  renderPlan() {
    const body = $("#mx-plan-body");
    const box = $("#mx-plan");
    box.dataset.state = this.planState;
    let html;
    if (this.planState === "empty") {
      html = `<p class="plan__empty">Chọn ít nhất hai bài để xem khung của bài: tempo, tông và mood chung, và các đoạn từ đầu tới cuối.</p>`;
    } else if (this.planState === "error") {
      html = `<p class="plan__err">${esc(this.planError)}</p>`;
    } else if (!this.plan) {
      html = `<p class="plan__empty">Đang tính khung chung…</p>`;
    } else {
      const p = this.plan;
      const rate = p.rate || 1;
      const semis = Math.round(12 * Math.log2(rate));
      const keyNote = semis ? ` · ${semis > 0 ? "nâng" : "hạ"} ${Math.abs(semis)} nửa cung khi ${semis > 0 ? "tăng tốc" : "làm chậm"}` : "";
      const srcs = (p.sources || []).map((s) => {
        const tempo = Math.round(((s.stretch || 1) - 1) * 100);
        const st = Math.abs(s.semis - Math.round(s.semis)) < 0.1 ? Math.round(s.semis) : +s.semis.toFixed(1);
        const bits = [USE_VI[s.use] || s.use,
          tempo ? `${tempo > 0 ? "nhanh" : "chậm"} hơn ${Math.abs(tempo)}%` : "giữ tempo",
          st ? `${st > 0 ? "nâng" : "hạ"} ${Math.abs(st)} nửa cung` : "giữ tông"];
        return `<li style="--c:${theme.css(theme.songColor(s.id))}"><i aria-hidden="true"></i><span class="n">${esc(short(this.titleOf(s), 40))}</span><span class="w">${bits.join(" · ")}</span></li>`;
      }).join("");
      html = `<div class="plan__nums">
          <div class="num"><b>${Math.round(p.bpm * rate)}</b><span>BPM chung${rate !== 1 ? ` (từ ${Math.round(p.bpm)})` : ""}</span></div>
          <div class="num"><b>${esc(p.key?.camelot || "")}</b><span>${esc(p.key?.name || "")}${keyNote}</span></div>
          <div class="num"><b class="txt">${esc(p.mood?.label || "")}</b><span>mood chung · ${esc(VIBE_VI[p.vibe] || p.vibe)}</span></div>
          <div class="num"><b>${fmt(p.seconds)}</b><span>${STYLE_VI[p.style] || p.style} · ${p.bars} ô nhịp</span></div>
        </div>
        ${this.formHtml(p, "preview", "Khung bài")}
        <ul class="plan__srcs">${srcs}</ul>
        ${(p.moves || []).length ? `<div class="plan__moves">
          <div class="plan__moves-head"><h3 class="label">Các bước ghép</h3>${(p.variants || 1) > 1
            ? `<button type="button" class="linkish" data-act="variant">Phương án khác</button><span class="mono">${(p.variant || 0) + 1}/${p.variants}</span>` : ""}</div>
          <ol>${p.moves.map((m) => `<li>${esc(m)}</li>`).join("")}</ol></div>` : ""}
        ${(p.notes || []).length ? `<ul class="plan__notes">${p.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
    }
    if (body.dataset.html !== html) {
      body.dataset.html = html;
      body.innerHTML = html;
    }
    const btn = $("#mx-make");
    btn.disabled = this.making || this.planState !== "ok";
    btn.toggleAttribute("data-busy", this.making);
    btn.querySelector("span").textContent = this.making ? "Đang gửi…" : "Dựng mashup";
    const hint = $("#mx-make-hint");
    hint.classList.toggle("err", !!this.makeError);
    hint.textContent = this.makeError ||
      (this.stored ? "Dựng mất khoảng một phút. Bài được giữ 48 giờ: đóng trang rồi mở lại trên trình duyệt này vẫn thấy."
        : "Trình duyệt này không cho lưu: bài vẫn được dựng, nhưng đóng trang là mất đường vào nó.");
  }

  renderMine() {
    const list = $("#mx-mine");
    const live = this.mine.filter((m) => this.views.has(m.id) || !this.views.size);
    $("#mx-mine-count").textContent = live.length ? `${live.length} bài` : "";
    $("#studio").classList.toggle("has-mine", live.length > 0);
    if (!live.length) {
      const html = `<li class="mine__empty">${ICON.inf}<span>Bài bạn dựng sẽ ở đây 48 giờ, kể cả khi đóng trang rồi quay lại. Nghe ngay trên trang, hoặc phát kiểu Mash ∞ Loop.</span></li>`;
      if (list.dataset.html !== html) {
        list.dataset.html = html;
        list.innerHTML = html;
        this.cards.clear();
      }
    } else {
      if (list.dataset.html) {
        list.dataset.html = "";
        list.innerHTML = "";
      }
      const want = live.map((m) => m.id);
      for (const el of [...list.children]) if (!want.includes(el.dataset.id)) el.remove();
      let prev = null;
      for (const item of live) {
        const v = this.views.get(item.id);
        const html = this.cardHtml(item, v);
        let el = list.querySelector(`.mx[data-id="${item.id}"]`);
        if (!el) {
          el = document.createElement("li");
          el.className = "mx";
          el.dataset.id = item.id;
          this.cards.delete(item.id);
        }
        if (this.cards.get(item.id) !== html) {
          this.cards.set(item.id, html);
          el.innerHTML = html;
        }
        el.classList.toggle("on", this.mp.id === item.id);
        el.dataset.status = v?.status || "unknown";
        if (prev ? prev.nextSibling !== el : list.firstChild !== el) {
          if (prev) prev.after(el);
          else list.prepend(el);
        }
        prev = el;
        this._sync(el, v);
      }
    }
    this.renderBadge();
  }

  cardHtml(item, v) {
    if (!v) {
      return `<div class="mx__top"><span class="mx__dot" aria-hidden="true"></span><div class="mx__title">Đang hỏi server…</div></div>`;
    }
    const p = v.plan || {};
    const title = this.mashTitle(v);
    const on = this.mp.id === item.id;
    const meta = [STYLE_VI[p.style], VIBE_VI[p.vibe], p.bpm && `${Math.round(p.bpm * (p.rate || 1))} BPM`, p.key?.camelot]
      .filter(Boolean).join(" · ");
    let lead, body = "", foot = "";
    const err = this.loopError.get(item.id);
    if (v.status === "done") {
      const loading = this.mp.loading === item.id;
      const playing = on && this.mp.playing;
      lead = `<button type="button" class="mx__play" data-act="play" data-state="${loading ? "load" : playing ? "pause" : "play"}" aria-label="${playing ? "Tạm dừng" : "Phát"} ${esc(title)}">${loading ? ICON.load : playing ? ICON.pause : ICON.play}</button>`;
      body = this.formHtml(p, on ? "play" : "idle", title);
      const waiting = this.loopWait.has(item.id);
      foot = `<span class="mx__time mono"><span data-t>0:00</span> / ${fmt(v.seconds || p.seconds || 0)}</span>
        <button type="button" class="mx__loop" data-act="loop"${waiting ? " disabled" : ""} title="Thêm vào thư viện như một bài, rồi phát lặp mãi trong vòng ∞">${ICON.inf}<span>${waiting ? "Đang phân tích…" : "Phát kiểu Mash Loop"}</span></button>
        <button type="button" class="mx__del" data-act="delete" title="Xoá bài mashup này">${ICON.del}<span>Xoá</span></button>`;
    } else if (v.status === "error") {
      lead = `<span class="mx__mark mx__mark--err" aria-hidden="true">!</span>`;
      body = `<p class="mx__err">${esc(v.error || "Có lỗi khi dựng")}</p>`;
      foot = `<span class="mx__time"></span>
        ${item.req ? `<button type="button" class="mx__loop" data-act="retry">${ICON.retry}<span>Chọn lại các bài này</span></button>` : ""}
        <button type="button" class="mx__del" data-act="delete">${ICON.del}<span>Xoá</span></button>`;
    } else {
      lead = `<span class="mx__mark" aria-hidden="true">${ICON.inf}</span>`;
      body = `<p class="mx__status"><span data-stage></span><span class="mono" data-pct></span></p>
        <div class="progress"><i data-bar></i></div>
        ${this.formHtml(p, "busy", title)}`;
      foot = `<span class="mx__time mono">~${fmt(p.seconds || v.seconds || 0)}</span>
        <button type="button" class="mx__del" data-act="delete">${ICON.del}<span>Huỷ</span></button>`;
    }
    const wait = this.loopWait.get(item.id);
    const waitMeta = wait ? this.d.metas().find((m) => m.id === wait) : null;
    const note = err ? `<p class="mx__err">${esc(err)}</p>`
      : waitMeta ? `<p class="mx__status">Đang phân tích để phát kiểu Mash Loop, xong sẽ tự phát<span class="mono" data-loop-pct></span></p>` : "";
    return `<div class="mx__top">${lead}
        <div class="mx__head"><div class="mx__title" title="${esc(title)}">${esc(title)}</div><div class="mx__meta mono">${esc(meta)}</div></div>
        <span class="mx__ttl mono" data-ttl hidden></span>
      </div>
      ${body}${note}
      <div class="mx__foot">${foot}</div>`;
  }

  // The parts of a card that move: progress, the countdown, the playhead.
  _sync(el, v) {
    if (!v) return;
    const ttl = el.querySelector("[data-ttl]");
    const left = this.left(v);
    if (ttl) {
      ttl.hidden = left === null;
      if (left !== null) {
        const total = v.done_at && v.expires_at ? v.expires_at - v.done_at : 48 * 3600;
        ttl.textContent = left <= 0 ? "đang xoá" : left > 3600 ? `còn ${Math.ceil(left / 3600)} giờ` : `còn ${Math.max(1, Math.ceil(left / 60))} phút`;
        ttl.toggleAttribute("data-soon", left <= 3600);
        ttl.style.setProperty("--left", Math.max(0, Math.min(1, left / total)).toFixed(3));
        const at = new Date((v.expires_at - this.skew) * 1000);
        ttl.title = `Tự xoá lúc ${at.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}`;
      }
    }
    if (v.status === "queued" || v.status === "rendering") {
      const stage = v.status === "queued" && v.stage !== "drums"
        ? (v.ahead ? `Đang chờ tới lượt · còn ${v.ahead} bài trước` : "Đang chờ tới lượt")
        : STAGE_VI[v.stage] || "Đang dựng";
      const p = v.status === "queued" ? 0 : v.progress || 0;
      el.querySelector("[data-stage]").textContent = stage;
      el.querySelector("[data-pct]").textContent = p ? ` · ${Math.round(p * 100)}%` : "";
      el.querySelector("[data-bar]").style.width = `${Math.round(p * 100)}%`;
      el.querySelector(".form")?.style.setProperty("--x", `${(p * 100).toFixed(1)}%`);
    }
    // A card rebuilt while its mashup is loaded (paused) keeps its playhead.
    if (v.status === "done" && this.mp.id === v.id && !this.mp.playing) {
      const t = this.mp.time;
      el.querySelector(".form")?.style.setProperty("--x", `${(Math.min(1, t / this._formLength(v)) * 100).toFixed(2)}%`);
      const tt = el.querySelector("[data-t]");
      if (tt) tt.textContent = fmt(t);
    }
    const wait = this.loopWait.get(v.id);
    const pct = wait && el.querySelector("[data-loop-pct]");
    if (pct) {
      const m = this.d.metas().find((x) => x.id === wait);
      pct.textContent = m && m.status !== "ready" ? ` · ${Math.round(100 * (m.progress || 0))}%` : "";
    }
  }

  // The playhead of the mashup being heard, every frame while it plays.
  _follow() {
    if (this._following || !this.mp.playing) return;
    this._following = true;
    const step = () => {
      const card = this.mp.id && document.querySelector(`.mx[data-id="${this.mp.id}"]`);
      if (card) {
        const v = this.views.get(this.mp.id);
        const t = this.mp.time;
        const total = this._formLength(v);
        const form = card.querySelector(".form");
        if (form) {
          form.style.setProperty("--x", `${(Math.min(1, t / total) * 100).toFixed(2)}%`);
          form.setAttribute("aria-valuenow", Math.round(t));
          form.setAttribute("aria-valuetext", fmt(t));
        }
        const tt = card.querySelector("[data-t]");
        if (tt) tt.textContent = fmt(t);
      }
      if (this.mp.playing) requestAnimationFrame(step);
      else this._following = false;
    };
    requestAnimationFrame(step);
  }

  renderBadge() {
    const b = $("#mx-badge");
    const live = this.mine.filter((m) => this.views.has(m.id));
    b.hidden = !live.length;
    b.textContent = live.length || "";
    b.toggleAttribute("data-busy", live.some((m) => ["queued", "rendering"].includes(this.views.get(m.id)?.status)));
    b.toggleAttribute("data-on", this.mp.playing);
  }

  // In the studio, a loop playing behind it is named, with a way to stop it.
  renderNow() {
    const el = $("#mx-now");
    const T = this.d.player.cur?.track;
    el.hidden = !T;
    if (!T) return;
    const title = this.d.songOf(this.d.metas().find((m) => m.id === T.id) || T.meta).title;
    const html = `<span class="mx-now__dot" aria-hidden="true"></span><span>Đang phát vòng <b>${esc(short(title, 40))}</b></span>
      <button type="button" class="linkish" data-act="to-stage">Xem vòng</button><button type="button" class="linkish" data-act="stop-loop">Dừng</button>`;
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }

  shown() {
    this.renderSlots();
    this.renderNow();
    this.poll();
  }
}

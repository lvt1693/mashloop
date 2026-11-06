import { api, hooks, Loader, ready, session } from "./api.js";
import { Engine } from "./engine.js";
import { Studio } from "./mashup.js";
import { CRITERIA, DEFAULTS, keyFit, Player, setPhase, shiftCamelot } from "./player.js";
import { noSupport, startSupport } from "./support.js";
import * as theme from "./theme.js";
import { bendNote, fmt, KIND_VI, short, splitTitle, Viz } from "./viz.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");

const engine = new Engine();
const loader = new Loader(engine);
const player = new Player(engine, loader);
const viz = new Viz($("#viz"), player, {
  center: $("#ring-center"),
  tip: $("#viz-tip"),
  onPick: (tr) => player.planTransition(tr),
  onSeek: (track, beat) => player.seek(beat),
  onCaption: () => renderStage(),
});

let metas = [];
let workerState = null;
let serverStale = false;
let lastLinks = null;
// Everyone's downloads, as the server shows them to this library (its own songs named).
let queue = { count: 0, items: [] };
// The sample libraries, by theme: songs kept analysed on the server, for a
// visit that does not know what to add. They come in ready and the chain starts.
const samples = { libraries: [], ids: [] };
let moreOpen = false; // the "add a sample library" fold under a library that has songs
// Every song this visit has seen, so the setlist still names one that has left the library.
const known = new Map();

// The sample libraries also play as a chain of their own: the library being
// heard (cur) and the next one (next), taken into this library ahead of time,
// out of sight, so the chain can mix across into it when the way there is good.
// "Kho khác" (or the timer) makes the next exit go there; once a song of it
// plays, the library left behind goes, unless the listener opened it by hand.
const kho = { cur: null, next: null, pinned: new Set(), force: false, forceAt: 0, heard: 0, visits: new Map() };
const libOf = (id) => samples.libraries.find((l) => l.ids.includes(id))?.key || null;
const libByKey = (key) => samples.libraries.find((l) => l.key === key) || null;
const shownLib = (key) => !key || kho.pinned.has(key) || key === kho.cur; // in the list (null: the listener's own song)
// The server forgot this visit's library (it restarted): add the songs back.
hooks.restore = async () => {
  const ids = metas.map((m) => m.id);
  if (ids.length) await api.restore(ids).catch(() => {});
};
const byId = () => new Map(metas.map((m) => [m.id, m]));
// A credited song (the Creative Commons libraries) has its exact title and
// artist already: "Anyway - Produced by J. Glaze" is a title, not "artist - title".
const songOf = (m) => m?.credit
  ? { title: m.title || "", artist: m.channel || m.credit.artist || "" }
  : splitTitle(m?.title || "", m?.channel || "");
const titleOf = (id) => {
  const m = byId().get(id) || known.get(id);
  return m ? songOf(m).title : id;
};

player.enabled = (id) => {
  const m = byId().get(id);
  if (!m || m.status !== "ready" || m.enabled === false) return false;
  if (!kho.cur) return true;
  const lib = libOf(id);
  if (kho.force) return lib === kho.next;
  return shownLib(lib) || (lib === kho.next && ui.crossKho);
};
// A little reluctance to leave the library being heard: the chain crosses
// into the next one when the way there is clearly the better transition.
player.bias = (id) => (kho.cur && !kho.force && libOf(id) === kho.next ? -0.12 : 0);
loader.protect = () => [player.cur?.track.id, player.plan?.tr.to, player.blend?.B.id, ...player.prefetchIds].filter(Boolean);
loader.addEventListener("transitions", () => {
  viz.invalidate();
  renderExits();
});

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M9 12h6"/></svg>',
  in: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M9 12h6M12 9v6"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4v4h4"/></svg>',
  del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  inf: '<svg viewBox="0 0 48 24" aria-hidden="true"><path d="M24 12 C 30 4, 42 4, 42 12 C 42 20, 30 20, 24 12 C 18 4, 6 4, 6 12 C 6 20, 18 20, 24 12 Z"/></svg>',
  mash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>',
};

// ------------------------------------------------------------------- views

// Two pages on one: the loop (#nghe) and the mashup studio (#mashup). The
// library panel serves both; in the studio its songs get a "+" to pick them.
// (The studio itself is made at the end, once everything it calls exists.)
let view = null;
let studio = null;

function setView(v) {
  if (v === view) return;
  view = v;
  document.body.dataset.view = v;
  $(".stage").hidden = v !== "listen";
  $("#studio").hidden = v !== "mashup";
  $("#mx-shelf").hidden = v !== "mashup";
  for (const a of document.querySelectorAll(".views a")) {
    if (a.dataset.view === v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("#lib-head").textContent = v === "mashup" ? "Chọn bài cho mashup" : "Các vòng trong thư viện";
  document.title = v === "mashup" ? "Tạo mashup · Mash ∞ Loop" : "Mash ∞ Loop";
  renderLibrary();
  if (v === "mashup") studio.shown();
  placeIndicators();
}
// Other anchors (#panel, #studio on phones) only scroll; they keep the view.
// Without the studio (mashups off on the server) there is only the loop.
const viewOfHash = () => (!studio ? "listen" : location.hash === "#mashup" ? "mashup"
  : location.hash === "#nghe" || !location.hash ? "listen" : view || (location.hash === "#studio" ? "mashup" : "listen"));
window.addEventListener("hashchange", () => setView(viewOfHash()));

// ------------------------------------------------------------- segmented

// The amber pill slides to whichever option is on (mode switch, panel tabs).
function placeIndicator(seg) {
  const on = seg.querySelector("button.on");
  const ind = seg.querySelector(".seg__ind");
  if (!on || !ind) return;
  ind.style.setProperty("--ind-x", `${on.offsetLeft}px`);
  ind.style.setProperty("--ind-w", `${on.offsetWidth}px`);
}
const placeIndicators = () => document.querySelectorAll(".seg").forEach(placeIndicator);
window.addEventListener("resize", placeIndicators);
document.fonts?.ready.then(placeIndicators);

// ------------------------------------------------------------------ settings

const STORE = "loopbox.settings.v1";
const BLEND_STYLES = ["long", "eq", "short", "filter", "swap", "stem", "acapella", "loop", "mashup", "double"];
// Every kind of transition, each with its switch (#s-<kind>).
const KINDS = ["cut", "drop", "blend", "fade", "echo", "wash", "riser", "flanger", "gap", "brake", "roll", "spin", "gate"];
// 2: the abrupt effects (brake, roll) became opt-in; older saved settings that
// had them on from the first release of effects are switched off once.
const SETTINGS_VERSION = 2;
const ui = { freq: 0.45, strict: 0.5, volume: 0.85, theme: "mood", crossKho: true, khoMinutes: 0, keepLib: true };
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || "null");
  if (saved) {
    Object.assign(ui, saved.ui || {});
    Object.assign(player.settings, saved.player || {});
    player.settings.allow = { ...DEFAULTS.allow, ...(saved.player?.allow || {}) };
    player.settings.blendStyles = { ...DEFAULTS.blendStyles, ...(saved.player?.blendStyles || {}) };
    if ((saved.v || 1) < 2) {
      player.settings.allow.brake = false;
      player.settings.allow.roll = false;
    }
  }
} catch (_) {
  /* storage unavailable */
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ v: SETTINGS_VERSION, ui, player: player.settings }));
  } catch (_) {
    /* storage unavailable */
  }
}

// Range fill: the amber part of the track follows the value.
function syncRange(input) {
  const min = +input.min || 0, max = +input.max || 1;
  input.style.setProperty("--v", `${((+input.value - min) / (max - min)) * 100}%`);
}

function applySettings() {
  const s = player.settings;
  // Log scale: 60 s between jumps at the far left, 6 s at the far right.
  s.jumpEvery = 60 * Math.pow(0.1, ui.freq);
  s.keep = 0.15 + 0.85 * ui.strict;
  if (s.dwellMax < s.dwellMin) s.dwellMax = s.dwellMin;
  engine.setVolume(ui.volume);
  $("#s-freq").value = ui.freq;
  $("#v-freq").textContent = `~${Math.round(s.jumpEvery)} giây một lần`;
  $("#s-strict").value = ui.strict;
  $("#v-strict").textContent = `giữ ${Math.round(s.keep * 100)}% điểm tốt nhất`;
  $("#s-dmin").value = s.dwellMin;
  $("#v-dmin").textContent = fmt(s.dwellMin);
  $("#s-dmax").value = s.dwellMax;
  $("#v-dmax").textContent = fmt(s.dwellMax);
  if (!CRITERIA[s.criterion]) s.criterion = "balanced";
  for (const r of document.querySelectorAll('input[name="criterion"]')) r.checked = r.value === s.criterion;
  $("#s-variety").value = s.variety;
  $("#v-variety").textContent = `${Math.round(s.variety * 100)}%`;
  for (const k of KINDS) $(`#s-${k}`).checked = s.allow[k] !== false;
  for (const k of BLEND_STYLES) $(`#s-bl-${k}`).checked = s.blendStyles[k] !== false;
  $("#s-keyshift").checked = s.keyShift !== false;
  $("#s-tempo").checked = s.tempoRamp !== false;
  // The ways to blend, and how far a blend may match, while blends are on.
  $("#blend-styles").disabled = !s.allow.blend;
  $("#blend-match").disabled = !s.allow.blend;
  $("#s-vol").value = ui.volume;
  $("#v-vol").textContent = `${Math.round(ui.volume * 100)}`;
  $("#s-cross").checked = ui.crossKho;
  $("#s-kmin").value = ui.khoMinutes;
  $("#v-kmin").textContent = ui.khoMinutes ? `${ui.khoMinutes} phút` : "tắt";
  if (!theme.THEMES[ui.theme]) ui.theme = "mood";
  for (const r of document.querySelectorAll('input[name="look"]')) r.checked = r.value === ui.theme;
  if (theme.setTheme(ui.theme)) recolor();
  document.querySelectorAll('input[type="range"]').forEach(syncRange);
  for (const b of document.querySelectorAll(".mode button")) {
    const on = b.dataset.mode === s.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  }
  placeIndicator($(".mode"));
  viz.invalidate();
  renderTransport();
  save();
}

$("#s-freq").addEventListener("input", (e) => ((ui.freq = +e.target.value), applySettings()));
$("#s-strict").addEventListener("input", (e) => ((ui.strict = +e.target.value), applySettings()));
$("#s-dmin").addEventListener("input", (e) => {
  player.settings.dwellMin = +e.target.value;
  if (player.settings.dwellMax < player.settings.dwellMin) player.settings.dwellMax = player.settings.dwellMin;
  applySettings();
});
$("#s-dmax").addEventListener("input", (e) => {
  player.settings.dwellMax = +e.target.value;
  if (player.settings.dwellMin > player.settings.dwellMax) player.settings.dwellMin = player.settings.dwellMax;
  applySettings();
});
for (const k of KINDS) {
  $(`#s-${k}`).addEventListener("change", (e) => ((player.settings.allow[k] = e.target.checked), applySettings()));
}
// A blend the chain planned under a switch now off is planned again.
const replanBlend = () => {
  if (player.plan && !player.plan.picked && player.plan.tr.type === "blend") player.cancelPlan();
  player.prefetchedFor = null;
  applySettings();
};
for (const k of BLEND_STYLES) {
  $(`#s-bl-${k}`).addEventListener("change", (e) => ((player.settings.blendStyles[k] = e.target.checked), replanBlend()));
}
$("#s-keyshift").addEventListener("change", (e) => ((player.settings.keyShift = e.target.checked), replanBlend()));
$("#s-tempo").addEventListener("change", (e) => ((player.settings.tempoRamp = e.target.checked), replanBlend()));
$("#s-vol").addEventListener("input", (e) => ((ui.volume = +e.target.value), applySettings()));
$("#s-cross").addEventListener("change", (e) => {
  ui.crossKho = e.target.checked;
  if (player.plan && !player.plan.picked) player.cancelPlan(); // planned under the old rule
  player.prefetchedFor = null;
  applySettings();
});
$("#s-kmin").addEventListener("input", (e) => ((ui.khoMinutes = +e.target.value), applySettings()));
for (const r of document.querySelectorAll('input[name="look"]')) {
  r.addEventListener("change", () => ((ui.theme = r.value), applySettings()));
}

// The theme tiles preview their colours with three songs of this library.
function renderLooks() {
  const ids = theme.spreadIds();
  for (const tile of document.querySelectorAll(".look")) {
    const cols = theme.preview(tile.querySelector("input").value, ids);
    tile.querySelectorAll(".swatch i").forEach((dot, k) => dot.style.setProperty("--c", theme.css(cols[k])));
  }
}
$("#s-variety").addEventListener("input", (e) => ((player.settings.variety = +e.target.value), applySettings()));
for (const r of document.querySelectorAll('input[name="criterion"]')) {
  r.addEventListener("change", () => {
    player.settings.criterion = r.value;
    // An exit the chain chose under the old criterion is chosen again; one
    // the listener picked on the stage stays.
    if (player.plan && !player.plan.picked) player.cancelPlan();
    player.prefetchedFor = null;
    applySettings();
  });
}
for (const b of document.querySelectorAll(".mode button")) {
  b.addEventListener("click", () => {
    player.settings.mode = b.dataset.mode;
    player.cancelPlan();
    applySettings();
  });
}
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".tabs button")) {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-selected", x === b);
    }
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t.id === `tab-${b.dataset.tab}`);
    placeIndicator($(".tabs"));
  });
}
$("#btn-relink").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Đang tính lại…";
  await api.relink().catch(() => {});
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Tính lại điểm nối giữa các bài";
  }, 2500);
  refresh();
});

// ----------------------------------------------------------------- transport

let busy = false;

async function play(id) {
  // Resume inside the click itself: browsers only unlock audio on a user gesture.
  engine.ctx.resume();
  try {
    setBusy(true);
    await player.start(id);
  } catch (e) {
    alert(`Không phát được: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  busy = b;
  renderTransport();
}

$("#btn-play").addEventListener("click", async () => {
  if (busy) return;
  if (player.cur) await player.togglePause();
  else {
    const first = metas.find((m) => m.status === "ready" && m.enabled !== false) || metas.find((m) => m.status === "ready");
    if (first) await play(first.id);
  }
  renderTransport();
});
$("#btn-jump").addEventListener("click", () => player.requestJump());
$("#btn-next").addEventListener("click", () => player.requestNextSong());
$("#btn-kho").addEventListener("click", () => switchKho());
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || document.querySelector("dialog[open]")) return;
  if (view === "mashup") {
    // In the studio Space plays or pauses the mashup last heard.
    if (e.code === "Space" && !e.target.closest("button, summary")) {
      e.preventDefault();
      studio.togglePlay();
    }
    return;
  }
  if (e.code === "Space") {
    if (e.target.closest("button")) return; // a focused button handles Space itself
    e.preventDefault();
    $("#btn-play").click();
  } else if (e.key === "j" || e.key === "J") player.requestJump();
  else if (e.key === "n" || e.key === "N") player.requestNextSong();
  else if (e.key === "k" || e.key === "K") switchKho();
});
player.addEventListener("state", renderTransport);
player.addEventListener("track", () => {
  enteredSong();
  renderLibrary();
  renderExits();
});

// ------------------------------------------------------- sample library chain

// Takes the next sample library into this one, out of sight: the one heard
// least recently (never heard first), in the shelf's order.
let preparing = null;
function prepareNext() {
  if (!kho.cur || kho.next || preparing) return preparing;
  const lib = samples.libraries
    .filter((l) => l.key !== kho.cur && !kho.pinned.has(l.key))
    .sort((a, b) => (kho.visits.get(a.key) || 0) - (kho.visits.get(b.key) || 0))[0];
  if (!lib) return null;
  preparing = (async () => {
    await api.restore(lib.ids);
    kho.next = lib.key;
    await refresh();
    loader.refreshAll(); // the song playing now learns its ways into the next library
    viz.invalidate(); // which exits the stage shows depends on the libraries in play
    renderExits();
    renderTransport();
  })().catch(() => {}).finally(() => (preparing = null));
  return preparing;
}

// A song of another sample library has started: that library is the one
// heard now, and the next comes in. The one left behind goes, unless the chain
// wandered out of a library opened by hand; "Kho khác" (or the timer) swaps
// the whole library, so then it goes too.
function enteredSong() {
  const id = player.cur?.track.id;
  const lib = id ? libOf(id) : null;
  if (!lib || lib === kho.cur || (!kho.cur && !kho.pinned.has(lib))) return;
  const left = kho.cur;
  const swapped = kho.force;
  kho.cur = lib;
  if (kho.next === lib) kho.next = null;
  kho.force = false;
  kho.heard = 0;
  kho.visits.set(lib, Date.now());
  if (left && (swapped || !kho.pinned.has(left))) {
    kho.pinned.delete(left);
    dropLib(left);
  }
  prepareNext();
  viz.invalidate();
  renderTransport();
}

function dropLib(key) {
  const keep = new Set(loader.protect());
  for (const id of libByKey(key)?.ids || []) {
    if (keep.has(id)) continue;
    loader.drop(id);
    api.remove(id).catch(() => {});
  }
  refresh();
}

// "Kho khác": the next exit goes into the next library, at the nearest good
// point, the way "Bài khác" finds one for any song.
async function switchKho() {
  if (!kho.cur || !player.cur || player.settings.mode !== "chain" || kho.force) return;
  await prepareNext();
  if (!kho.next) return;
  kho.force = true;
  kho.forceAt = performance.now();
  player.requestNextSong();
  viz.invalidate();
  renderExits();
  renderTransport();
}

// The timer counts listening time in the library being heard; a switch that
// finds no way in after half a minute starts the next library outright.
setInterval(() => {
  if (!kho.cur || !player.cur || !player.playing || player.settings.mode !== "chain") return;
  kho.heard += 2;
  if (!kho.force && ui.khoMinutes && kho.heard >= ui.khoMinutes * 60) switchKho();
  if (kho.force && performance.now() - kho.forceAt > 30000 && libOf(player.plan?.tr.to) !== kho.next) {
    const first = metas.find((m) => m.status === "ready" && libOf(m.id) === kho.next);
    if (first) play(first.id);
  }
}, 2000);
player.addEventListener("plan", renderExits);

function renderTransport() {
  const btn = $("#btn-play");
  const state = busy ? "load" : player.cur && player.playing ? "pause" : "play";
  btn.dataset.state = state;
  btn.setAttribute("aria-label", state === "load" ? "Đang tải bài" : state === "pause" ? "Tạm dừng" : player.cur ? "Tiếp tục" : "Phát");
  btn.disabled = busy || (!player.cur && !metas.some((m) => m.status === "ready"));
  $("#btn-jump").disabled = !player.cur;
  $("#btn-next").disabled = !player.cur || player.settings.mode !== "chain";
  const k = $("#btn-kho");
  k.hidden = !kho.cur;
  k.disabled = !player.cur || player.settings.mode !== "chain" || kho.force;
  k.setAttribute("aria-pressed", kho.force);
  const next = libByKey(kho.next);
  k.title = kho.force ? `Đang tìm điểm nối sang ${next?.name || "kho khác"}`
    : `Sang kho khác${next ? ` (${next.name})` : ""} ở điểm nối gần nhất (K)`;
}

// ------------------------------------------------------------------ library

const STAGES = {
  queued: "đang chờ", downloading: "đang tải về", downloaded: "đã tải về, chờ phân tích", converting: "chuyển định dạng",
  analyzing: "đang phân tích",
  loading: "đọc audio", beats: "dò beat", stems: "tách giọng và nhạc cụ", features: "đo đặc trưng", structure: "tìm cấu trúc",
  jumps: "tìm điểm nhảy", analyzed: "xong phân tích", linking: "nối với thư viện", ready: "sẵn sàng", error: "lỗi",
};

// Mini loops: each ready track drawn as a small beat ring from its analysis,
// in its own colours, so the library reads as a palette of moods.
const analysisCache = new Map(); // id -> Promise<analysis|null>
const miniCache = new Map(); // `${id}|${palette}` -> Promise<HTMLCanvasElement|null>

function analysisOf(id) {
  if (!analysisCache.has(id)) {
    analysisCache.set(id, api.analysis(id).catch(() => {
      analysisCache.delete(id);
      return null;
    }));
  }
  return analysisCache.get(id);
}

function miniRing(id) {
  const key = `${id}|${theme.paletteVersion()}`;
  if (!miniCache.has(key)) {
    miniCache.set(key, analysisOf(id).then((a) => {
      if (!a) {
        miniCache.delete(key);
        return null;
      }
      const size = 76;
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      const r = size / 2 - 7;
      const end = a.duration;
      const lmax = Math.max(...a.loud), lmin = Math.min(...a.loud);
      const colors = theme.beatColors(id, a.color);
      ctx.lineWidth = 6;
      for (let b = 0; b < a.beats.length; b++) {
        const t0 = a.beats[b], t1 = b + 1 < a.beats.length ? a.beats[b + 1] : end;
        ctx.globalAlpha = 0.35 + 0.65 * ((a.loud[b] - lmin) / Math.max(1, lmax - lmin));
        ctx.strokeStyle = colors[b];
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, r, -Math.PI / 2 + (Math.PI * 2 * t0) / end, -Math.PI / 2 + (Math.PI * 2 * t1) / end + 0.01);
        ctx.stroke();
      }
      return c;
    }));
  }
  return miniCache.get(key);
}

function forget(id) {
  analysisCache.delete(id);
  for (const k of [...miniCache.keys()]) if (k.startsWith(`${id}|`)) miniCache.delete(k);
}

// Colours changed (another theme, or the library's moods moved): repaint.
function recolor() {
  miniCache.clear();
  for (const c of document.querySelectorAll("canvas.mini[data-id]")) delete c.dataset.painted;
  paintMinis();
  viz.invalidate();
  renderLooks();
  if (setlistEl) setlistEl.dataset.html = "";
}

function paintMinis() {
  const palette = theme.paletteVersion();
  for (const c of document.querySelectorAll("canvas.mini[data-id]")) {
    if (c.dataset.painted === palette) continue;
    c.dataset.painted = palette;
    miniRing(c.dataset.id).then((img) => {
      if (!img) return;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
    });
  }
}

// A Creative Commons song carries its licence and a link back to where it lives.
function creditLine(c) {
  if (!c?.license) return "";
  const link = (href, text) => href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`
    : esc(text);
  return `<div class="s cc">${link(c.license_url, c.license)}${c.via ? ` · ${link(c.page, c.via)}` : ""}</div>`;
}

function libCards(libs) {
  return `<div class="libs">${libs.map((l) => `<button type="button" class="lib" data-act="samples" data-key="${esc(l.key)}">
      <b>${esc(l.name)}</b><span>${l.ids.length} bài${l.blurb ? ` · ${esc(l.blurb)}` : ""}</span>
    </button>`).join("")}</div>`;
}

function trackRow(m) {
  const playing = player.audible()?.entry.track.id === m.id;
  let lead, status;
  if (m.status === "ready") {
    lead = `<canvas class="mini" data-id="${esc(m.id)}" width="76" height="76" aria-hidden="true"></canvas>`;
    const artist = songOf(m).artist;
    status = `<div class="s">${artist ? `<span class="a">${esc(artist)}</span> · ` : ""}${m.bpm ? m.bpm.toFixed(0) : "?"} BPM · ${esc(m.camelot || "")}</div>${creditLine(m.credit)}`;
  } else if (m.status === "error") {
    lead = `<span class="pending" style="--p:0;opacity:.5" aria-hidden="true"></span>`;
    status = `<div class="s err">${esc(m.error || "lỗi")}</div>`;
  } else {
    lead = `<span class="pending" style="--p:${(m.progress || 0).toFixed(3)}" aria-hidden="true"></span>`;
    // Waiting its turn to be downloaded: where it stands in the queue.
    const q = queue.items.find((it) => it.id === m.id && it.state !== "downloading");
    const what = !q ? `${STAGES[m.stage] || m.stage || "đang chờ"} · ${Math.round(100 * (m.progress || 0))}%`
      : q.state !== "waiting" ? "sắp tải" : `chờ tải · thứ ${q.pos}${q.wait_s ? ` · ${waitText(q.wait_s)}` : ""}`;
    status = `<div class="s">${what}</div><div class="progress"><i style="width:${Math.round(100 * (m.progress || 0))}%"></i></div>`;
  }
  const title = esc(songOf(m).title);
  const full = esc(`${m.title}${m.status === "ready" ? ` · ${m.jumps ?? 0} nhánh nhảy · ${fmt(m.duration || 0)}` : ""}`);
  // In the studio: "+" picks the song for the mashup, its number once picked.
  const k = view === "mashup" && m.status === "ready" ? studio.index(m.id) : -2;
  const mash = k === -2 ? ""
    : `<button type="button" data-act="mash" aria-pressed="${k >= 0}" aria-label="${k >= 0 ? `Bỏ ${title} khỏi mashup` : `Đưa ${title} vào mashup`}" title="${k >= 0 ? "Bỏ khỏi mashup" : "Đưa vào mashup"}">${k >= 0 ? `<span class="mono">${k + 1}</span>` : ICON.mash}</button>`;
  const acts = m.status === "ready"
    ? `${mash}<button type="button" data-act="play" aria-label="Phát ${title}" title="Phát từ bài này">${ICON.play}</button>
       <button type="button" data-act="toggle" aria-label="${m.enabled === false ? "Đưa vào chuỗi" : "Bỏ khỏi chuỗi"}" title="${m.enabled === false ? "Đưa vào chuỗi" : "Bỏ khỏi chuỗi"}">${m.enabled === false ? ICON.in : ICON.out}</button>`
    : m.status === "error" ? `<button type="button" data-act="retry" aria-label="Thử lại" title="Thử lại">${ICON.retry}</button>` : "";
  return `<li class="track ${playing ? "playing" : ""} ${m.enabled === false ? "off" : ""} ${k >= 0 ? "picked" : ""}" data-id="${esc(m.id)}">
    ${lead}
    <div><div class="t" title="${full}">${title}</div>${status}</div>
    <div class="acts">${acts}<button type="button" data-act="delete" aria-label="Xoá ${title}" title="Xoá">${ICON.del}</button></div>
  </li>`;
}

const waitText = (s) => (s < 45 ? "dưới 1 phút" : `khoảng ${Math.round(s / 60)} phút`);

// Hosted: the limits per address under the add box, and today's new songs left
// (a song already on the server costs nothing: only the ones it must fetch count).
function renderQuota(q) {
  const el = $("#quota");
  el.hidden = !q;
  if (!q) return;
  const left = Math.max(0, Math.min(q.new_day, q.new_left));
  el.innerHTML = left
    ? `Hôm nay bạn còn thêm được <b class="mono">${left}/${q.new_day}</b> bài mới (bài đã có sẵn trên server không tính). Mỗi máy mở trang tối đa ${q.visits_hour} lần mỗi giờ.`
    : `Hôm nay bạn đã thêm đủ <b class="mono">${q.new_day}</b> bài mới: mai thêm tiếp được; bài đã có sẵn trên server và các kho có sẵn thì vẫn mở được.`;
  el.classList.toggle("quota--out", !left);
}

// ------------------------------------------------------------ saved library
// Hosted: the library is kept in this browser (the server keeps nothing about
// the listener) and put back on the next visit: its songs, the ones left out
// of the chain, the sample libraries opened. The server keeps a song's sound
// for some hours after anyone last used it (an open page uses its songs); the
// page counts that down. A song from a link whose sound went is fetched again
// (its analysis stayed); an uploaded one has to be uploaded again.
const SAVED = "mashloop.library.v1";
const memo = { restored: false, from: null, note: "", sig: "", failed: "" };

function readSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) || "null");
    return s && Array.isArray(s.ids) ? s : null;
  } catch (_) {
    return null;
  }
}

function saveLibrary() {
  if (!session.multiuser || !memo.restored) return; // (before the saved one is back: it would be overwritten)
  const shown = metas.filter((m) => shownLib(libOf(m.id)));
  // The listener's own songs from links also by their link: one the store no
  // longer has at all (deleted whole when it was full) comes back from it.
  const own = shown.filter((m) => !samples.ids.includes(m.id) && m.url && m.source !== "upload");
  const data = { ids: shown.map((m) => m.id), off: shown.filter((m) => m.enabled === false).map((m) => m.id),
    pinned: [...kho.pinned], cur: kho.cur, links: own.map((m) => ({ id: m.id, url: m.url })) };
  const sig = JSON.stringify([ui.keepLib, data]);
  if (sig === memo.sig) return;
  memo.sig = sig;
  try {
    if (ui.keepLib) localStorage.setItem(SAVED, JSON.stringify({ v: 1, at: Date.now(), ...data }));
    else localStorage.removeItem(SAVED);
  } catch (_) {
    /* storage unavailable: nothing kept */
  }
}

async function restoreSaved() {
  const saved = ui.keepLib ? readSaved() : null;
  if (!saved?.ids.length) {
    memo.restored = true;
    return;
  }
  memo.failed = "";
  renderKeep("Đang mở lại thư viện đã lưu…");
  try {
    const r = await api.restore(saved.ids, true);
    for (const key of saved.pinned || []) kho.pinned.add(key);
    if (saved.cur && !kho.cur) {
      kho.cur = saved.cur;
      kho.heard = 0;
      kho.visits.set(saved.cur, Date.now());
    }
    const added = new Set((r.added || []).map((m) => m.id));
    for (const s of saved.links || []) {
      if (added.has(s.id) || !/^https?:\/\//.test(s.url || "")) continue;
      const x = await api.add(s.url).catch(() => null);
      for (const m of x?.added || []) added.add(m.id);
    }
    for (const id of saved.off || []) if (added.has(id)) await api.patch(id, { enabled: false }).catch(() => {});
    memo.from = saved.at || null;
    memo.note = r.note || "";
    memo.restored = true;
  } catch (err) {
    memo.failed = err.message || "lỗi mạng";
  }
  await refresh();
}

const clock = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const when = (t) => {
  const d = new Date(t), two = (x) => String(x).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())} ${d.getDate()}/${d.getMonth() + 1}`;
};

// The line under the library: whether it is kept on this device, and how long
// the server still keeps its sound if the listener leaves now (ticking).
function renderKeep(busy = "") {
  const box = $("#lib-keep");
  if (!session.multiuser) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $("#keep-lib").checked = ui.keepLib;
  const until = metas.map((m) => m.audio_until).filter(Boolean);
  const parts = [];
  if (busy) parts.push(busy);
  else if (memo.failed) parts.push(`Chưa mở lại được thư viện đã lưu: ${esc(memo.failed)}. <button type="button" class="keep__retry">Thử lại</button>`);
  else if (memo.from) parts.push(`Đã mở lại thư viện lưu lúc ${when(memo.from)}.`);
  if (memo.note) parts.push(esc(memo.note));
  if (until.length) {
    parts.push(`Nhạc của bạn giữ trên server thêm <b class="mono" id="keep-clock">${clock(Math.min(...until) - Date.now() / 1000)}</b> nếu không ai nghe nữa; sau đó bài từ link tự tải lại khi mở, bài tải lên phải tải file lại.`);
  } else if (!ui.keepLib) {
    parts.push("Không lưu: tải lại trang là một thư viện mới.");
  }
  $("#keep-line").innerHTML = parts.join(" ");
}

// Ticks the countdown without redrawing the rest.
setInterval(() => {
  const el = document.querySelector("#keep-clock");
  const until = metas.map((m) => m.audio_until).filter(Boolean);
  if (el && until.length) el.textContent = clock(Math.min(...until) - Date.now() / 1000);
}, 1000);

$("#keep-lib").addEventListener("change", (e) => {
  ui.keepLib = e.target.checked;
  save();
  memo.restored = true; // a choice made now: the library on the page is the one to keep (or forget)
  saveLibrary();
  renderKeep();
});

$("#lib-keep").addEventListener("click", (e) => {
  if (e.target.closest(".keep__retry")) restoreSaved();
});

// The download queue: shown to everyone while it has songs, so a visitor who
// comes later (or from another device) knows why theirs waits; their own
// songs named, with the wait before each and a way to call them off.
let lastQueueHtml = "";
function renderQueue() {
  const box = $("#dlq");
  const q = queue;
  box.hidden = !q.count;
  if (!q.count) {
    lastQueueHtml = "";
    return;
  }
  const mine = q.items.filter((it) => it.mine);
  const [lo, hi] = q.rest_s || [5, 10];
  const why = `Server tải từng bài một và nghỉ ${lo}–${hi} giây giữa hai bài, để các trang nhạc không chặn.`;
  const first = mine[0];
  const note = first
    ? `${why} Bài của bạn đầu tiên: <b>thứ ${first.pos}</b>${first.state === "downloading" ? ", đang tải"
      : first.state !== "waiting" ? ", sắp tải" : first.wait_s ? `, còn ${waitText(first.wait_s)}` : ""}.`
    : `${why} Bài bạn thêm lúc này sẽ đứng thứ ${q.count + 1}, chờ ${waitText(q.count * (q.per_s || 25))}.`;
  const state = (it) => it.state === "downloading" ? `${Math.round(100 * (it.progress || 0))}%`
    : it.state === "pause" ? `nghỉ ${Math.ceil(it.pause_s || 0)} s`
    : it.state === "starting" ? "bắt đầu"
    : it.mine && it.wait_s ? waitText(it.wait_s) : "chờ";
  const rows = q.items.map((it) => `<li class="dlq__item${it.mine ? " mine" : ""}${it.pos === 1 ? " now" : ""}">
      <span class="dlq__n">${it.pos}</span>
      <span class="dlq__t"${it.mine ? ` title="${esc(it.title)}"` : ""}>${it.mine ? esc(short(it.title, 60)) : "Bài của người khác"}</span>
      <span class="dlq__s">${state(it)}</span>
      ${it.mine ? `<button type="button" class="dlq__x" data-id="${esc(it.id)}" aria-label="Huỷ tải ${esc(it.title)}">Huỷ</button>` : "<span></span>"}
    </li>`).join("");
  const hidden = q.count - q.items.length;
  const html = `${rows}${hidden > 0 ? `<li class="dlq__more">và ${hidden} bài khác đang chờ</li>` : ""}`;
  $("#dlq-count").textContent = `${q.count} bài`;
  $("#dlq-note").innerHTML = note;
  if (html !== lastQueueHtml) {
    lastQueueHtml = html;
    $("#dlq-list").innerHTML = html;
  }
}

// Calling off one's own song: it leaves the library, and its place in the
// queue goes to the next (another library that also wants it keeps it coming).
$("#dlq-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button.dlq__x");
  if (!btn) return;
  btn.disabled = true;
  try {
    await api.remove(btn.dataset.id);
  } catch (_) {
    btn.disabled = false;
  }
  refresh();
});

let lastListHtml = "";
function renderLibrary() {
  const shown = metas.filter((m) => shownLib(libOf(m.id))); // the next sample library stays out of sight
  const have = new Set(shown.map((m) => m.id));
  const offer = samples.libraries.filter((l) => l.ids.some((id) => !have.has(id))); // not yet wholly here
  let html;
  if (shown.length) {
    html = shown.slice().reverse().map(trackRow).join("");
    if (offer.length) {
      html += `<li class="more"><details${moreOpen ? " open" : ""}><summary>Thêm một kho có sẵn · ${offer.length} kho</summary>${libCards(offer)}</details></li>`;
    }
  } else {
    const intro = session.multiuser
      ? "Thư viện của bạn đang trống.<br>Dán link YouTube, SoundCloud, Zing MP3, Jamendo, gõ tên bài, hoặc thả file nhạc (cả file zip) vào đây."
      : "Thư viện còn trống.<br>Gõ tên một bài ở ô phía trên để thêm vòng đầu tiên.";
    html = `<li class="empty">${ICON.inf}${intro}${offer.length ? `<br>Chưa biết thêm gì? Nghe thử một kho có sẵn:${libCards(offer)}` : ""}</li>`;
  }
  if (html !== lastListHtml) {
    lastListHtml = html;
    $("#track-list").innerHTML = html;
    paintMinis();
  }
  const readyCount = metas.filter((m) => m.status === "ready").length;
  const own = metas.filter((m) => !samples.ids.includes(m.id)).length;
  $("#lib-count").textContent = session.limits.tracks
    ? `${own}/${session.limits.tracks} bài`
    : metas.length ? `${readyCount}/${metas.length}` : "";
  const w = workerState || {};
  const busy = metas.filter((m) => m.status !== "ready" && m.status !== "error");
  const active = busy.filter((m) => m.status !== "queued");
  let line = "";
  if (serverStale) line = "Server đang chạy phiên bản cũ: tắt nó (Ctrl+C) rồi chạy lại run.ps1";
  else if (w.relink) line = "Đang tính lại điểm nối giữa các bài…";
  else if (busy.length) {
    line = active.length === 1
      ? `Đang xử lý ${short(songOf(active[0]).title, 30)} · ${STAGES[active[0].stage] || active[0].stage}`
      : active.length > 1 ? `Đang xử lý ${active.length} bài cùng lúc` : "Đang chờ tới lượt xử lý";
    if (busy.length > active.length) line += ` · ${busy.length - active.length} bài chờ`;
  } else if (w.linking) line = `Đang nối các bài với nhau · còn ${w.linking} cặp`;
  $("#worker").textContent = line;
  renderQueue();
  viz.setTitles(new Map(metas.map((m) => [m.id, songOf(m).title])));
  renderTransport();
}

// The sample library the empty stage offers: one drawn at random per visit.
let stageSampleKey = null;
function stageSample() {
  const libs = samples.libraries;
  if (!libs.length) return null;
  if (!libs.some((l) => l.key === stageSampleKey)) stageSampleKey = libs[Math.floor(Math.random() * libs.length)].key;
  return libs.find((l) => l.key === stageSampleKey);
}

$("#rc-cta").addEventListener("click", (e) => loadSamples(e.currentTarget));

async function loadSamples(btn) {
  const lib = samples.libraries.find((l) => l.key === btn.dataset.key);
  if (!lib) return;
  const note = btn.querySelector("span");
  btn.disabled = true;
  note.textContent = "Đang mở…";
  engine.ctx.resume(); // inside the click: lets the chain start playing below
  try {
    await api.restore(lib.ids);
    // Opened by hand: it stays in the library while the chain wanders.
    kho.pinned.add(lib.key);
    if (kho.next === lib.key) kho.next = null;
    if (!kho.cur) {
      kho.cur = lib.key;
      kho.heard = 0;
      kho.visits.set(lib.key, Date.now());
    }
    moreOpen = false;
    await refresh();
    const first = metas.find((m) => m.status === "ready" && lib.ids.includes(m.id));
    // In the studio the songs are there to be picked, not played.
    if (first && !player.cur && view !== "mashup") await play(first.id);
    prepareNext();
    renderTransport();
  } catch (err) {
    btn.disabled = false;
    note.textContent = `Không mở được: ${err.message}`;
  }
}

$("#track-list").addEventListener("toggle", (e) => {
  if (e.target.matches(".more details")) moreOpen = e.target.open;
}, true);

$("#track-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "samples") return loadSamples(btn);
  const id = btn.closest(".track").dataset.id;
  const m = byId().get(id);
  switch (btn.dataset.act) {
    case "mash":
      studio.toggle(id);
      return;
    case "play":
      await play(id);
      break;
    case "toggle":
      await api.patch(id, { enabled: m.enabled === false });
      break;
    case "retry":
      await api.reanalyze(id);
      break;
    case "delete":
      if (!session.multiuser && !confirm(`Xoá "${m.title}" khỏi thư viện?`)) return;
      if (player.cur?.track.id === id) player.stop();
      loader.drop(id);
      forget(id);
      await api.remove(id);
      break;
  }
  refresh();
});

async function refresh() {
  try {
    const r = await api.tracks(player.playing);
    metas = r.tracks;
    for (const m of metas) known.set(m.id, m);
    workerState = r.worker;
    queue = r.queue || { count: 0, items: [] };
    renderQuota(r.quota);
    loader.setMetas(metas);
    // New pairs were linked in this library: loaded songs pick up their new exits.
    if (lastLinks !== null && r.links !== lastLinks) {
      loader.refreshAll();
      viz.invalidate();
    }
    lastLinks = r.links;
    if (theme.setMoods(metas.filter((m) => m.status === "ready"))) recolor();
    // An old server process (started before an update) is still serving: its
    // results would not match the files on disk. Servers older than this check
    // do not send the flag at all.
    serverStale = !("stale_server" in r) || r.stale_server;
    renderLibrary();
    saveLibrary();
    renderKeep();
    studio?.onMetas(metas);
  } catch (_) {
    // Refused a session (too many visits from this address): say so, and when.
    $("#worker").textContent = session.blocked?.message || "Mất kết nối tới server";
  }
}

// How often the page asks for its library: often while its own songs are
// fetched or analysed (the progress moves), less while they only wait in the
// download queue, and every 20 s otherwise. A tab left playing for hours used
// to ask every 5 s, 720 times an hour, for nothing new. Whatever the listener
// does asks at once (refresh()).
const IDLE_POLL_MS = 20000;
let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = metas.filter((m) => m.status !== "ready" && m.status !== "error");
  const working = busy.some((m) => m.status !== "queued") || workerState?.current;
  const waiting = busy.length || queue.items.some((it) => it.mine);
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, working ? 1200 : waiting ? 2500 : IDLE_POLL_MS);
}

// --------------------------------------------------------------- add / search

const isUrl = (s) => /^https?:\/\//i.test(s.trim());

// Hosted: before the first song a visitor brings in (a link, a search result,
// a file), they confirm they may use it. Asked once per visit, kept nowhere.
let consented = false;
async function consent() {
  await ready();
  if (!session.multiuser || consented) return true;
  const dlg = $("#consent");
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((resolve) => dlg.addEventListener("close", resolve, { once: true }));
  consented = dlg.returnValue === "yes";
  return consented;
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#add-input").value.trim();
  if (!text) return;
  const box = $("#search-results");
  const submit = $("#add-form button[type=submit]");
  if (isUrl(text) && !(await consent())) return;
  submit.disabled = true;
  if (isUrl(text)) {
    box.innerHTML = `<div class="msg">Đang thêm…</div>`;
    try {
      const r = await api.add(text);
      const have = r.added.filter((m) => m.status === "ready").length;
      const todo = r.added.length - have;
      box.innerHTML = `<div class="msg">${[have && `Đã thêm ${have} bài có sẵn`, todo && `${have ? "" : "Đã thêm "}${todo} bài vào hàng đợi phân tích`].filter(Boolean).join(", ") || "Không thêm được bài nào"}.${r.note ? ` ${esc(r.note)}.` : ""}</div>`;
      $("#add-input").value = "";
      setTimeout(() => (box.innerHTML = ""), 3000);
    } catch (err) {
      box.innerHTML = `<div class="msg">Không thêm được: ${esc(err.message)}</div>`;
    }
    submit.disabled = false;
    refresh();
    schedulePoll();
    return;
  }
  box.innerHTML = `<div class="msg">Đang tìm trên YouTube…</div>`;
  try {
    const { results } = await api.search(text);
    const have = byId();
    box.innerHTML = results.length
      ? results.map((r) => `<div class="result">
          <img src="${esc(r.thumbnail)}" alt="" loading="lazy" width="64" height="36">
          <div><div class="t" title="${esc(r.title)}">${esc(r.title)}</div><div class="s">${esc(r.channel)}${r.duration ? ` · ${fmt(r.duration)}` : ""}</div></div>
          <button type="button" data-url="${esc(r.url)}" ${have.has(r.id) ? "disabled" : ""}>${have.has(r.id) ? "Đã có" : "Thêm"}</button>
        </div>`).join("")
      : `<div class="msg">Không tìm thấy bài nào. Thử tên khác, hoặc dán link YouTube.</div>`;
  } catch (err) {
    box.innerHTML = `<div class="msg">Tìm không được: ${esc(err.message)}</div>`;
  }
  submit.disabled = false;
});

$("#search-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-url]");
  if (!btn || !(await consent())) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await api.add(btn.dataset.url);
    btn.textContent = "Đã thêm";
  } catch (err) {
    btn.textContent = "Lỗi";
    btn.title = err.message;
  }
  refresh();
  schedulePoll();
});

// ------------------------------------------------------------------ upload

// Files go up one after another (the server analyses several at once anyway);
// each gets a line with its progress in the results box.
const uploads = [];
let uploading = false;

function renderUploads() {
  const box = $("#search-results");
  if (!uploads.length) return;
  box.innerHTML = uploads.map((u) => `<div class="upload-row ${u.error ? "err" : ""}">
      <div class="t">${esc(u.name)}</div>
      ${u.error ? `<small>${esc(u.error)}</small>`
        : u.done ? `<small>${u.count > 1 ? `Đã thêm ${u.count} bài` : "Đã thêm"}, đang phân tích${u.note ? `. ${esc(u.note)}` : ""}</small>`
        : `<div class="progress"><i style="width:${Math.round(100 * u.p)}%"></i></div>`}
    </div>`).join("");
}

async function uploadFiles(files) {
  if (!files.length || !(await consent())) return;
  const maxMb = session.limits.upload_mb || 80;
  for (const f of files) {
    const u = { name: f.name, p: 0, done: false, error: null, file: f };
    if (f.size > maxMb * 1024 * 1024) u.error = `Lớn hơn ${maxMb} MB`;
    else if (f.type && !/^(audio|video)\/|zip/.test(f.type) && !/\.zip$/i.test(f.name)) u.error = "Không phải file âm thanh";
    uploads.push(u);
  }
  renderUploads();
  if (uploading) return;
  uploading = true;
  for (const u of uploads) {
    if (u.done || u.error) continue;
    try {
      const r = await api.upload(u.file, (p) => ((u.p = p), renderUploads()));
      u.done = true;
      u.count = r?.added?.length || 0;
      u.note = r?.note || "";
    } catch (err) {
      u.error = `Không tải lên được: ${err.message}`;
    }
    u.file = null;
    renderUploads();
    refresh();
    schedulePoll();
  }
  uploading = false;
  setTimeout(() => {
    if (uploading) return;
    uploads.length = 0;
    $("#search-results").innerHTML = "";
  }, 6000);
}

$("#file-input").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});

// Drop files anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  uploadFiles([...e.dataTransfer.files]);
});

// ------------------------------------------------------------- stage text

const KIND = {
  cut: "nối thẳng", drop: "drop", blend: "blend khớp nhịp", fade: "crossfade", echo: "echo vang", wash: "reverb wash",
  riser: "build-up", flanger: "flanger", gap: "ngắt lặng", brake: "phanh đĩa", roll: "cuộn nhịp", spin: "spinback",
  gate: "gate",
};
const KIND_CAP = KIND_VI;
// A blend named by how the two songs are mixed.
const BLEND_STYLE = { long: "blend dài", eq: "blend EQ", short: "blend ngắn", filter: "blend lọc", swap: "drop swap",
  stem: "trao giọng", acapella: "acapella", loop: "blend vòng lặp", mashup: "mashup", double: "double drop" };
const kindOf = (tr) => (tr.type === "blend" && BLEND_STYLE[tr.style]) || KIND[tr.type] || tr.type;
const kindCap = (tr) => {
  const s = tr.type === "blend" && BLEND_STYLE[tr.style];
  return s ? s[0].toUpperCase() + s.slice(1) : KIND_CAP[tr.type] || tr.type;
};
const CRIT_TAG = { mood: "CÙNG MOOD", tempo: "CÙNG NHỊP", key: "HỢP TÔNG", set: "SET DJ", free: "TỰ DO" };
// Where a set stands, for the hand-over about to happen.
const SET_PHASE = { warmup: "khởi động", cruise: "giữ nhịp", build: "đẩy lên", peak: "lên đỉnh", breather: "khoảng nghỉ",
  lift: "bùng lại" };

// Why the chain picked this exit, in the terms of the chosen criterion.
function criterionNote(T, tr) {
  const m = byId().get(tr.to);
  switch (player.settings.criterion) {
    case "mood": {
      const d = tr.mood ?? 0;
      return ` · ${d < 0.25 ? "mood rất gần" : d < 0.5 ? "mood gần" : "mood hơi khác"}`;
    }
    case "tempo":
      return m?.bpm ? ` · ${Math.round(T.analysis.bpm)} → ${Math.round(m.bpm)} BPM` : "";
    case "key": {
      if (!m?.camelot) return "";
      const fit = keyFit(T.analysis.camelot, m.camelot, tr.semis ?? 0);
      return ` · tông ${esc(T.analysis.camelot)} → ${esc(shiftCamelot(m.camelot, tr.semis ?? 0))}${fit >= 0.8 ? ", hợp" : fit > 0.3 ? ", gần hợp" : ""}`;
    }
    case "set":
      return ` · set: ${SET_PHASE[setPhase(player.stats.transitions).phase]}`;
    default:
      return "";
  }
}

function setHTML(el, html) {
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderStage() {
  const view = player.audible();
  const p = player;
  const T = view?.entry.track;
  const cta = $("#rc-cta");
  if (!T) {
    const empty = !metas.some((m) => m.status === "ready");
    // An empty library: one sample library offered right on the stage.
    const lib = empty ? stageSample() : null;
    setHTML($("#rc-kicker"), "HAI VÒNG ĐANG CHỜ");
    setHTML($("#rc-title"), empty ? "Thêm một bài để có vòng đầu tiên" : "Chọn một bài để bắt đầu vòng lặp");
    setHTML($("#rc-meta"), session.blocked ? esc(session.blocked.message)
      : !empty ? "Bấm phát, hoặc nút ▶ ở một bài trong thư viện"
        : lib ? "Gõ tên bài ở ô Thêm bài trong thư viện, hoặc nghe thử ngay" : "Gõ tên bài ở ô Thêm bài trong thư viện");
    cta.hidden = !lib || !!session.blocked;
    if (lib && !cta.disabled) {
      cta.dataset.key = lib.key;
      cta.querySelector("span").textContent = `Nghe thử kho ${lib.name}`;
    }
    setHTML($("#ro-tl"), `<b>MASH ∞ LOOP</b> // ${p.settings.mode === "chain" ? "chuỗi" : "một bài"} · chưa phát`);
    setHTML($("#ro-tr"), `<span class="mono">∞ 0:00</span><span class="ro-stats"> · chưa có vòng nào</span>`);
    setHTML($("#next-info"), "");
    return;
  }
  cta.hidden = true;
  cta.disabled = false;
  // The mix as heard (the stage holds it until its end reaches the speakers).
  const held = viz.mixNow;
  const b = held?.blend ? held.m : null;
  const fx = held && !held.blend ? held.m : null;
  const blending = b && view.now >= b.times[0];
  setHTML($("#rc-kicker"), blending ? "ĐANG BLEND" : p.settings.mode === "chain" ? "ĐANG PHÁT · CHUỖI" : "ĐANG PHÁT · LẶP MÃI");
  // Past the middle of a blend the caption has moved into the next loop.
  const shown = viz.captionTrack?.analysis ? viz.captionTrack : T;
  const sa = shown.analysis;
  const song = songOf(shown.meta);
  setHTML($("#rc-title"), esc(song.title || shown.id));
  setHTML($("#rc-meta"), `${song.artist ? `<span class="rc-artist">${esc(song.artist)}</span>` : ""}<span class="mono">${sa.bpm.toFixed(0)} BPM · ${esc(sa.camelot)} · ${esc(sa.key)}</span>`);
  const crit = p.settings.mode === "chain" && CRIT_TAG[p.settings.criterion] ? ` · ${CRIT_TAG[p.settings.criterion]}` : "";
  const inLib = libByKey(libOf(shown.id));
  setHTML($("#ro-tl"), `<b>${p.settings.mode === "chain" ? "CHUỖI" : "LẶP"}${crit}</b> // ${inLib ? `${esc(inLib.name)} · ` : ""}${esc(short(song.artist || shown.meta.title || "", 34))}`);
  const listened = Math.max(0, view.now - p.stats.startedAt);
  setHTML($("#ro-tr"), `<span class="mono">∞ ${fmt(listened)}</span><span class="ro-stats"> · ${p.stats.jumps} nhảy · ${p.stats.transitions} chuyển</span>`);

  const now = view.now;
  const name = (id) => esc(short(titleOf(id), 46));
  let next;
  if (blending) {
    const k = Math.min(1, (now - b.times[0]) / (b.times[b.L] - b.times[0]));
    const note = bendNote(b.tr);
    next = `Đang ${kindOf(b.tr)} sang <strong>${name(b.B.id)}</strong> · <span class="eta">${Math.round(k * 100)}%</span>${note ? ` · ${note}` : ""}`;
  } else if (fx) {
    next = `Đang ${KIND[fx.tr.type]} sang <strong>${name(fx.B.id)}</strong>`;
  } else if (p.plan) {
    const eta = Math.max(0, p.plan.eta - now);
    const note = bendNote(p.plan.tr);
    next = `${p.plan.picked ? "Bạn đã chọn: " : "Sắp "}${kindOf(p.plan.tr)} sang <strong>${name(p.plan.tr.to)}</strong> · <span class="eta">${fmt(eta)}</span>` +
      ` · khớp ${Math.round(p.plan.tr.q * 100)}%${criterionNote(T, p.plan.tr)}${note ? ` · ${note}` : ""}${p.plan.target ? "" : " · đang tải"}`;
  } else if (p.settings.mode === "chain") {
    const left = p.dwellStart + p.settings.dwellMin - now;
    next = left > 0
      ? `Có thể chuyển bài sau <span class="eta">${fmt(left)}</span>, ở điểm nối tốt gần nhất`
      : `Đang chờ điểm nối tốt gần nhất…`;
  } else {
    next = "Lặp mãi bài này. Chạm lên vòng để phát từ đoạn đó, chạm một chấm ngoài vòng để chuyển bài.";
  }
  setHTML($("#next-info"), next);
}

// Setlist: the session as a chain of linked loops, each in its song's colour.
const setlistEl = $("#history");
function renderSetlist() {
  const hist = player.history.filter((h) => h.at <= engine.audibleTime()).slice(-11);
  const col = (id) => theme.css(theme.songColor(id));
  const html = hist.slice(-10).map((h, k, list) => {
    const prev = k ? list[k - 1] : hist.length > list.length ? hist[0] : null;
    return `<li data-via="${h.via}" style="--hue:${col(h.id)}${prev ? `;--from:${col(prev.id)}` : ""}"><span class="loop" aria-hidden="true"></span><span>${esc(short(titleOf(h.id), 30))}</span><span class="sr">, vào bằng ${h.via === "start" ? "bắt đầu" : KIND[h.via] || h.via}</span></li>`;
  }).join("");
  const ol = setlistEl;
  if (ol.dataset.html !== html) {
    ol.dataset.html = html;
    ol.innerHTML = html;
    ol.scrollLeft = ol.scrollWidth;
  }
}

// Keyboard and screen-reader access to the exits that the stage draws as dots.
const exits = document.createElement("div");
exits.className = "exits";
exits.innerHTML = `<p class="label">Điểm nối sang bài khác</p><ul></ul>`;
$("#canvas-wrap").append(exits);

function renderExits() {
  const T = player.cur?.track;
  const list = T ? T.transitions.filter((tr) => player.canTake(T, tr)).sort((x, y) => y.q - x.q).slice(0, 8) : [];
  exits.querySelector("ul").innerHTML = list.map((tr, k) =>
    `<li><button type="button" data-k="${k}">${kindCap(tr)} → ${esc(short(titleOf(tr.to), 32))} <span class="mono">${Math.round(tr.q * 100)}%</span></button></li>`).join("");
  exits.hidden = !list.length;
  exits._list = list;
}
exits.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-k]");
  if (!btn) return;
  const ok = player.planTransition(exits._list[+btn.dataset.k]);
  btn.classList.toggle("is-bad", !ok);
  btn.title = ok ? "" : PICK_ERROR[player.pickError] || PICK_ERROR.gone;
});
const PICK_ERROR = {
  busy: "Đang chuyển sang bài khác: chọn lại khi bài sau đã vào hẳn",
  unreachable: "Từ chỗ đang phát không có đường tới điểm này",
  soon: "Điểm này tới quá sát: chọn điểm xa hơn một chút",
  gone: "Điểm này không còn dùng được",
};

setInterval(() => {
  renderStage();
  renderSetlist();
}, 250);

let lastPlaying = null;
setInterval(() => {
  const id = player.audible()?.entry.track.id || null;
  if (id !== lastPlaying) {
    lastPlaying = id;
    renderLibrary();
  }
}, 500);

// Mark: the dot runs along the ∞. One fast lap when the mark is hovered.
(function traceMark() {
  const path = document.querySelector(".brand__path");
  const dot = document.querySelector(".brand__dot");
  if (!path || !dot) return;
  const len = path.getTotalLength();
  let u = 0.25, last = performance.now(), boost = 0;
  document.querySelector(".brand").addEventListener("pointerenter", () => (boost = 1));
  const step = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    if (!reduceMQ.matches) {
      u = (u + dt * (1 / 6 + boost * 1.2)) % 1;
      boost = Math.max(0, boost - dt * 0.9);
    }
    const pt = path.getPointAtLength(u * len);
    dot.setAttribute("cx", pt.x.toFixed(2));
    dot.setAttribute("cy", pt.y.toFixed(2));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})();

// The studio, when the server has mashups on: its page in the nav, and the
// view the address asks for.
function openStudio() {
  studio = new Studio({
    engine,
    player,
    metas: () => metas,
    songOf: (m) => songOf(m),
    paintMinis: () => paintMinis(),
    renderLibrary: () => renderLibrary(),
    refresh: () => refresh(),
    setLight: (id) => (viz.lightOf = id),
    // A mashup's loop song is analysed: off to the stage, and it plays.
    playLoop: (tid) => {
      location.hash = "#nghe";
      play(tid);
    },
    showLibrary: () => {
      $(".tabs button[data-tab=library]").click();
      $("#panel").scrollIntoView({ behavior: reduceMQ.matches ? "auto" : "smooth", block: "start" });
      $("#add-input").focus({ preventScroll: true });
    },
  });
  window.loopbox.studio = studio;
  $(".views").hidden = false;
  setView(viewOfHash());
}

applySettings();
renderLooks();
renderTransport();
renderStage();
setView(viewOfHash());
placeIndicators();
ready().then(() => {
  if (session.multiuser) {
    // Hosted: a library per visit, kept in this browser for the next one;
    // pairs are linked automatically and shared.
    $("#add-hint").textContent = "Thư viện được lưu trong trình duyệt này: lần sau mở trang vẫn còn. Bài ai đó đã thêm trước sẽ vào ngay, không phải chờ phân tích.";
    $("#btn-relink").hidden = true;
    $("#fine").hidden = false;
    for (const el of document.querySelectorAll("[data-ttl]")) el.textContent = session.limits.audio_ttl_h || 12;
    restoreSaved();
    startSupport();
  } else {
    noSupport();
  }
  if (session.limits.upload_mb) $("#upload-limit").textContent = `, tối đa ${session.limits.upload_mb} MB`;
  if (session.mashups && !studio) openStudio();
  renderLibrary();
  api.samples().then((s) => {
    samples.libraries = s.libraries || [];
    samples.ids = [...new Set(samples.libraries.flatMap((l) => l.ids))];
    lastListHtml = "";
    renderLibrary();
    renderStage(); // the empty stage can offer one of them now
  }, () => {});
}).catch(noSupport);
refresh().then(schedulePoll);

// Handle for the browser console and the end-to-end test.
window.loopbox = { player, engine, loader, play, refresh, applySettings, ui, viz, session, studio };

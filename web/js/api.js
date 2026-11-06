import { Track } from "./graph.js";

// The library this page works on. Hosted, the server opens a fresh one for
// every visit (the page puts the songs it saved in this browser back into
// it: main.js); in the personal app the session is simply "local".
export const session = { id: null, multiuser: false, mashups: false, limits: {}, key: null, blocked: null };
let opening = null;
// Called after the server lost the session (it restarted): put the songs back.
export const hooks = { restore: async () => {} };

// Never from the browser's cache: Chrome kept the 410 a poll got when the
// server restarted (it had no Cache-Control) and answered every later poll
// with it, even after a reload.
const call = (url, opts = {}) => fetch(url, { cache: "no-store", ...opts });

// Hosted, a visit opens with the pass this page got when it loaded (a
// cookie); a tab left open for hours asks for a fresh one first (428). The
// page says whether a program drives the browser (navigator.webdriver): such
// a browser opens none.
async function post() {
  const opts = { method: "POST", headers: { "X-Env": `wd=${navigator.webdriver ? 1 : 0}` } };
  const r = await call("/api/session", opts);
  if (r.status !== 428) return r;
  await call("/", { method: "HEAD" }).catch(() => {});
  return call("/api/session", opts);
}

async function open() {
  // Refused for opening too many (429), or without the pass even after
  // asking for a fresh one (428: cookies blocked): asked again only once the
  // wait is over, not by every poll of the page.
  if (session.blocked && Date.now() < session.blocked.until) throw new Error(session.blocked.message);
  if (!opening) {
    opening = post()
      .then(async (r) => {
        if (r.status === 429 || r.status === 428 || r.status === 403) {
          let message = r.status === 428 ? "Hãy tải lại trang"
            : r.status === 403 ? "Không mở được phiên" : "Bạn mở trang quá nhiều lần, thử lại sau ít phút";
          try {
            message = (await r.json()).detail || message;
          } catch (_) {
            /* not json */
          }
          const min = +(message.match(/(\d+) phút/)?.[1] || 1);
          session.blocked = { until: Date.now() + min * 60000, message };
          throw new Error(message);
        }
        if (!r.ok) await fail(r);
        session.blocked = null;
        return r.json();
      })
      .then((s) => Object.assign(session, {
        id: s.sid, multiuser: s.multiuser, mashups: !!s.mashups, limits: s.limits || {},
        key: s.k ? Uint8Array.from(atob(s.k), (c) => c.charCodeAt(0)) : null,
      }))
      .finally(() => (opening = null));
  }
  return opening;
}

// Hosted, audio arrives scrambled with this session's key (server.keystream):
// the same 4 KiB block, SHA-256 of key + track id + counter, XORed over it.
// A mashup's key is made from its token instead (it outlives the session).
async function keystream(tid, key = session.key) {
  const t = new TextEncoder().encode(tid);
  const out = new Uint8Array(4096);
  for (let i = 0; i < 128; i++) {
    const msg = new Uint8Array(key.length + t.length + 4);
    msg.set(key, 0);
    msg.set(t, key.length);
    new DataView(msg.buffer).setUint32(key.length + t.length, i, false);
    out.set(new Uint8Array(await crypto.subtle.digest("SHA-256", msg)), i * 32);
  }
  return out;
}

async function unscramble(buf, tid, key = session.key) {
  const ks = new Uint32Array((await keystream(tid, key)).buffer);
  const words = Math.floor(buf.byteLength / 4);
  const data = new Uint32Array(buf, 0, words);
  for (let i = 0; i < words; i++) data[i] ^= ks[i & 1023];
  const tail = new Uint8Array(buf, words * 4);
  const ksb = new Uint8Array(ks.buffer);
  for (let i = 0; i < tail.length; i++) tail[i] ^= ksb[(words * 4 + i) & 4095];
  return buf;
}

export const ready = () => (session.id ? Promise.resolve(session) : open());

// The server lost the visit (it restarted): one new visit, the songs put back
// into it, for every request that heard so (they were in flight together; a
// late one must not drop the visit the first one just opened).
let reopening = null;
function reopen(lost) {
  if (session.id === lost) {
    session.id = null;
    reopening = open().then(() => hooks.restore()).finally(() => (reopening = null));
  }
  return reopening || ready();
}

async function sound(id, kind, kid, retry) {
  await ready();
  const sid = session.id;
  const r = await call(`/api/tracks/${id}/${kind}`, { headers: { "X-Session": sid } });
  if (r.status === 410 && retry) {
    await reopen(sid);
    return sound(id, kind, kid, false);
  }
  if (!r.ok) await fail(r);
  const buf = await r.arrayBuffer();
  return r.headers.get("X-Mash") === "1" ? unscramble(buf, kid) : buf;
}

// The sound of the songs already fetched, kept as it came (compressed, a few
// MB a song; the Loader keeps only 5 songs decoded, ~85 MB each) while there
// is room, the least recently used dropped first: a loop that comes back to a
// song does not fetch it again (a 17-song library played for a day fetched
// 1.6 GB, each song ~14 times). In memory only, for this page.
const SOUND_BUDGET = ((navigator.deviceMemory || 4) >= 8 ? 192 : 64) * 1e6;
const soundKept = new Map(); // key -> ArrayBuffer, the least recently used first
let soundBytes = 0;

async function kept(key, fetchIt) {
  const hit = soundKept.get(key);
  if (hit) {
    soundKept.delete(key);
    soundKept.set(key, hit);
    return hit.slice(0); // (decoding takes the buffer it is given)
  }
  const buf = await fetchIt();
  if (buf.byteLength <= SOUND_BUDGET / 2) {
    soundKept.set(key, buf.slice(0));
    soundBytes += buf.byteLength;
    for (const [k, b] of soundKept) {
      if (soundBytes <= SOUND_BUDGET) break;
      soundKept.delete(k);
      soundBytes -= b.byteLength;
    }
  }
  return buf;
}

async function fail(r) {
  let msg = `${r.status}`;
  try {
    msg = (await r.json()).detail || msg;
  } catch (_) {
    /* not json */
  }
  throw new Error(msg);
}

async function json(url, opts = {}, retry = true) {
  await ready();
  const sid = session.id;
  const r = await call(url, { ...opts, headers: { ...(opts.headers || {}), "X-Session": sid } });
  if (r.status === 410 && retry) {
    await reopen(sid);
    return json(url, opts, false);
  }
  if (!r.ok) await fail(r);
  return r.json();
}

async function plain(url, opts = {}) {
  const r = await call(url, opts);
  if (!r.ok) await fail(r);
  return r.json();
}

const send = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  tracks: (playing = false) => json(`/api/tracks${playing ? "?p=1" : ""}`),  // (playing: counted as listening)
  search: (q) => json(`/api/search?q=${encodeURIComponent(q)}`),
  add: (text) => json("/api/tracks", send("POST", { text })),
  restore: (ids, saved = false) => json("/api/tracks", send("POST", { ids, saved }), false),
  patch: (id, data) => json(`/api/tracks/${id}`, send("PATCH", data)),
  remove: (id) => json(`/api/tracks/${id}`, { method: "DELETE" }),
  reanalyze: (id) => json(`/api/tracks/${id}/reanalyze`, { method: "POST" }),
  relink: () => json("/api/relink", { method: "POST" }),
  analysis: (id) => json(`/api/tracks/${id}/analysis`),
  transitions: (id) => json(`/api/tracks/${id}/transitions`),
  samples: () => json("/api/samples"),
  async audio(id, retry = true) {
    return kept(`${id}|audio`, () => sound(id, "audio", id, retry));
  },
  // The vocal stem of a sung song (scrambled with its own key, "<id>:v").
  async vocals(id, retry = true) {
    return kept(`${id}|vocals`, () => sound(id, "vocals", `${id}:v`, retry));
  },
  // Mashups: made from the library's songs, then kept by their token alone
  // (listed, heard and deleted without a session: they outlive it).
  previewMashup: (opts) => json("/api/mashups/preview", send("POST", opts)),
  createMashup: (opts) => json("/api/mashups", send("POST", opts)),
  mashups: (items) => plain("/api/mashups/status", send("POST", { items })),
  deleteMashup: (id, token) => plain(`/api/mashups/${id}`, { method: "DELETE", headers: { "X-Mashup-Token": token } }),
  loopMashup: (id, token) => json(`/api/mashups/${id}/loop`, { method: "POST", headers: { "X-Mashup-Token": token } }),
  async mashupAudio(id, token) {
    const r = await call(`/api/mashups/${id}/audio`, { headers: { "X-Mashup-Token": token } });
    if (!r.ok) await fail(r);
    const buf = await r.arrayBuffer();
    if (r.headers.get("X-Mash") !== "1") return buf;
    const key = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    return unscramble(buf, id, key);
  },
  // The file is the request body; XHR because fetch cannot report upload progress.
  async upload(file, onProgress = () => {}) {
    await ready();
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/upload");
      x.setRequestHeader("X-Session", session.id);
      x.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => {
        let body = null;
        try {
          body = JSON.parse(x.responseText);
        } catch (_) {
          /* not json */
        }
        if (x.status >= 200 && x.status < 300) resolve(body);
        else reject(new Error(body?.detail || `${x.status}`));
      };
      x.onerror = () => reject(new Error("mất kết nối"));
      x.send(file);
    });
  },
};

// Fetches and decodes tracks, keeping a few decoded buffers in memory
// (a 4-minute song is ~85 MB of float samples).
export class Loader extends EventTarget {
  constructor(engine, keep = 5) {
    super();
    this.engine = engine;
    this.keep = keep;
    this.cache = new Map(); // id -> {promise, track, used}
    this.metas = new Map();
    this.protect = () => [];
  }

  setMetas(list) {
    this.metas = new Map(list.map((m) => [m.id, m]));
  }

  readyCount() {
    let n = 0;
    for (const m of this.metas.values()) if (m.status === "ready") n++;
    return n;
  }

  has(id) {
    return !!this.cache.get(id)?.track;
  }

  get(id) {
    const hit = this.cache.get(id);
    if (hit) {
      hit.used = performance.now();
      return hit.promise;
    }
    const entry = { track: null, used: performance.now() };
    entry.promise = (async () => {
      const meta = this.metas.get(id) || { id, title: id };
      const [analysis, audio, trans] = await Promise.all([api.analysis(id), api.audio(id), api.transitions(id)]);
      const buffer = await this.engine.ctx.decodeAudioData(audio);
      const track = new Track(meta, analysis, buffer);
      track.transitions = trans.items;
      track.onward = trans.onward || null; // each destination's own best ways on
      entry.track = track;
      return track;
    })();
    entry.promise.catch(() => this.cache.delete(id));
    this.cache.set(id, entry);
    this._evict();
    return entry.promise;
  }

  // New pairs were linked in this library: every loaded song re-reads its exits.
  refreshAll() {
    for (const e of this.cache.values()) if (e.track) this.refreshTransitions(e.track);
  }

  async refreshTransitions(track) {
    try {
      const { items, onward } = await api.transitions(track.id);
      track.transitions = items;
      track.onward = onward || null;
      this.dispatchEvent(new CustomEvent("transitions", { detail: track }));
    } catch (_) {
      /* keep the old list */
    }
  }

  // The vocal stem of a loaded song, decoded (null when it has none), kept as
  // long as the song: fetched only for a transition that hands over by layers.
  vocals(id) {
    if (!this.metas.get(id)?.stems) return Promise.resolve(null);
    const hit = this.cache.get(id);
    if (hit?.vocals) return hit.vocals;
    const p = (async () => {
      const raw = await api.vocals(id);
      return this.engine.ctx.decodeAudioData(raw);
    })();
    p.catch(() => {
      const e = this.cache.get(id);
      if (e && e.vocals === p) e.vocals = null;
    });
    if (hit) hit.vocals = p;
    return p;
  }

  drop(id) {
    this.cache.delete(id);
  }

  _evict() {
    if (this.cache.size <= this.keep) return;
    const keep = new Set(this.protect());
    const order = [...this.cache.entries()].filter(([id, e]) => !keep.has(id) && e.track).sort((a, b) => a[1].used - b[1].used);
    while (this.cache.size > this.keep && order.length) this.cache.delete(order.shift()[0]);
  }
}

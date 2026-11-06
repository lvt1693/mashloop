// The admin page: sign in, then the readings: now every 5 s, the open
// libraries every 15 s, the days and the store every minute. Charts are SVG
// drawn here (thin marks, hairline grid, a tooltip on hover, the numbers in a
// table under each); colours come from classes (the page's CSP allows no
// inline style attributes), positions from the CSSOM.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("vi-VN");
const num = (n) => nf.format(Math.round(n || 0));
const two = (x) => String(x).padStart(2, "0");
const hm = (t) => { const d = new Date(t * 1000); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const dm = (t) => {
  const d = new Date(t * 1000);
  return `${d.getDate()}/${d.getMonth() + 1}${d.getFullYear() !== new Date().getFullYear() ? `/${d.getFullYear()}` : ""}`;
};
const dayLabel = (iso) => { const [, m, d] = iso.split("-"); return `${+d}/${+m}`; };
function dur(s) {
  s = Math.max(0, Math.round(s || 0));
  if (s < 60) return `${s} giây`;
  if (s < 3600) return `${Math.round(s / 60)} phút`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}
const ago = (t) => (t ? `${dur(Date.now() / 1000 - t)} trước` : "chưa có");
function bytes(n) {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
const clock = (s) => (s <= 0 ? "đã tới hạn" : `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}`);

// ------------------------------------------------------------------ server

async function call(path, opts = {}) {
  const r = await fetch(path, {
    ...opts, credentials: "same-origin",
    headers: { "X-Admin": "1", ...(opts.body ? { "content-type": "application/json" } : {}) },
  });
  if (r.status === 401 && !path.endsWith("/login")) {
    showLogin();
    throw new Error("Chưa đăng nhập");
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `Lỗi ${r.status}`);
  return body;
}

// ----------------------------------------------------------------- sign-in

let timers = [];
function showLogin() {
  timers.forEach(clearInterval);
  timers = [];
  $("#dash").hidden = true;
  $("#top-end").hidden = true;
  $("#login").hidden = false;
  $("#user").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  $("#login-err").textContent = "";
  try {
    await call("/api/admin/login", { method: "POST", body: JSON.stringify({ user: $("#user").value, password: $("#pass").value }) });
    $("#pass").value = "";
    start();
  } catch (err) {
    $("#login-err").textContent = err.message;
  }
  btn.disabled = false;
});

$("#logout").addEventListener("click", async () => {
  await call("/api/admin/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ------------------------------------------------------------------ charts

const tip = $("#tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  tip.style.top = `${Math.max(8, y - h - 12)}px`;
}
const hideTip = () => (tip.hidden = true);

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const compact = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : `${+v.toFixed(v < 10 && v % 1 ? 1 : 0)}`);
const svgNS = "http://www.w3.org/2000/svg";

function frame(el, pad, reserve = 0) {
  const w = Math.max(240, el.clientWidth), h = Math.max(120, el.clientHeight - reserve);
  return { w, h, x0: pad.l, x1: w - pad.r, y0: pad.t, y1: h - pad.b };
}

function yAxis(f, max, unit = (v) => compact(v)) {
  let out = "";
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4, y = f.y1 - ((f.y1 - f.y0) * k) / 4;
    out += `<line class="grid" x1="${f.x0}" x2="${f.x1}" y1="${y}" y2="${y}"/>`;
    out += `<text class="axis" x="${f.x0 - 6}" y="${y + 3}" text-anchor="end">${esc(unit(v))}</text>`;
  }
  return out;
}

// A table of the same numbers, folded under the chart.
function dataTable(el, head, rows) {
  let d = el.nextElementSibling;
  if (!d || !d.classList.contains("adm-data")) {
    d = document.createElement("details");
    d.className = "adm-data";
    el.after(d);
  }
  const open = d.open;
  d.innerHTML = `<summary>Bảng số liệu</summary><table class="adm-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "nr" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  d.open = open;
}

// Two counts over the days: one axis, two lines, a legend, labels at the ends.
function lineChart(el, labels, series) {
  const f = frame(el, { l: 40, r: 44, t: 12, b: 24 }, 28); // (the legend above takes 28 px)
  const n = labels.length;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const X = (i) => f.x0 + (n === 1 ? (f.x1 - f.x0) / 2 : ((f.x1 - f.x0) * i) / (n - 1));
  const Y = (v) => f.y1 - ((f.y1 - f.y0) * v) / max;
  let g = yAxis(f, max);
  const every = Math.max(1, Math.ceil(n / 7));
  labels.forEach((lab, i) => {
    if (i % every === 0 || i === n - 1) g += `<text class="axis" x="${X(i)}" y="${f.h - 6}" text-anchor="middle">${esc(lab)}</text>`;
  });
  series.forEach((s, k) => {
    const d = s.values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    g += `<path class="l${k + 1}" d="${d}"/>`;
  });
  // End labels, when the two ends stand apart; else the legend and the tooltip say it.
  const ends = series.map((s) => Y(s.values[n - 1]));
  const apart = ends.length < 2 || Math.abs(ends[0] - ends[1]) >= 14;
  series.forEach((s, k) => {
    g += `<circle class="d${k + 1}" cx="${X(n - 1)}" cy="${ends[k]}" r="4"/>`;
    if (apart) g += `<text class="lbl" x="${X(n - 1) + 9}" y="${ends[k] + 4}">${num(s.values[n - 1])}</text>`;
  });
  g += `<line class="cross" id="${el.id}-x" x1="0" x2="0" y1="${f.y0}" y2="${f.y1}" visibility="hidden"/>`;
  series.forEach((_, k) => (g += `<circle class="d${k + 1}" id="${el.id}-p${k}" r="4" visibility="hidden"/>`));
  g += `<rect class="hit" x="${f.x0}" y="0" width="${f.x1 - f.x0}" height="${f.h}"/>`;
  el.innerHTML = `<div class="adm-legend">${series.map((s, k) => `<span><i class="s${k + 1}"></i>${esc(s.name)}</span>`).join("")}</div>
    <svg viewBox="0 0 ${f.w} ${f.h}" role="img" aria-label="${esc(series.map((s) => s.name).join(" và "))} theo ngày">${g}</svg>`;
  const svg = el.querySelector("svg");
  const hit = svg.querySelector(".hit");
  hit.addEventListener("mousemove", (e) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * f.w;
    const i = Math.max(0, Math.min(n - 1, Math.round(((x - f.x0) / (f.x1 - f.x0)) * (n - 1))));
    const cross = svg.getElementById(`${el.id}-x`);
    cross.setAttribute("x1", X(i));
    cross.setAttribute("x2", X(i));
    cross.setAttribute("visibility", "visible");
    series.forEach((s, k) => {
      const p = svg.getElementById(`${el.id}-p${k}`);
      p.setAttribute("cx", X(i));
      p.setAttribute("cy", Y(s.values[i]));
      p.setAttribute("visibility", "visible");
    });
    showTip(`<b>${esc(labels[i])}</b><br>${series.map((s, k) => `<i class="s${k + 1}"></i>${esc(s.name)}: ${num(s.values[i])}`).join("<br>")}`, e.clientX, e.clientY);
  });
  hit.addEventListener("mouseleave", () => {
    hideTip();
    svg.querySelectorAll("[id]").forEach((x) => x.setAttribute("visibility", "hidden"));
  });
}

// One count per slot (the hours): columns from one baseline, the top one labelled.
function columns(el, labels, values, { unit = num, every = 3, name = "" } = {}) {
  const f = frame(el, { l: 40, r: 8, t: 16, b: 22 });
  const n = values.length;
  const max = niceMax(Math.max(1, ...values));
  const band = (f.x1 - f.x0) / n;
  const bw = Math.min(24, Math.max(3, band - 2));
  const Y = (v) => f.y1 - ((f.y1 - f.y0) * v) / max;
  let g = yAxis(f, max, (v) => compact(v));
  const top = values.indexOf(Math.max(...values));
  values.forEach((v, i) => {
    const x = f.x0 + band * i + (band - bw) / 2, y = Y(v), h = f.y1 - y;
    if (h > 0.5) {
      const r = Math.min(4, h, bw / 2);
      g += `<path class="m1" d="M${x},${f.y1}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${f.y1}Z"/>`;
    }
    if (i === top && v > 0) g += `<text class="lbl" x="${x + bw / 2}" y="${y - 5}" text-anchor="middle">${esc(unit(v))}</text>`;
    if (i % every === 0) g += `<text class="axis" x="${f.x0 + band * i + band / 2}" y="${f.h - 6}" text-anchor="middle">${esc(labels[i])}</text>`;
    g += `<rect class="hit" data-i="${i}" x="${f.x0 + band * i}" y="${f.y0}" width="${band}" height="${f.y1 - f.y0}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.h}" role="img" aria-label="${esc(name)}">${g}</svg>`;
  el.querySelectorAll(".hit").forEach((r) => {
    r.addEventListener("mousemove", (e) => { const i = +r.dataset.i; showTip(`<b>${esc(labels[i])}</b><br>${esc(unit(values[i]))}`, e.clientX, e.clientY); });
    r.addEventListener("mouseleave", hideTip);
  });
}

// A few named buckets: horizontal bars, the value at each tip.
function bars(el, labels, values) {
  const f = frame(el, { l: 86, r: 40, t: 4, b: 4 });
  const n = values.length;
  const max = Math.max(1, ...values);
  const band = (f.y1 - f.y0) / n;
  const bh = Math.min(24, band - 6);
  let g = "";
  values.forEach((v, i) => {
    const y = f.y0 + band * i + (band - bh) / 2, w = ((f.x1 - f.x0) * v) / max;
    g += `<text class="lbl" x="${f.x0 - 8}" y="${y + bh / 2 + 4}" text-anchor="end">${esc(labels[i])}</text>`;
    if (w > 0.5) {
      const r = Math.min(4, w, bh / 2);
      g += `<path class="m1" d="M${f.x0},${y}H${f.x0 + w - r}Q${f.x0 + w},${y} ${f.x0 + w},${y + r}V${y + bh - r}Q${f.x0 + w},${y + bh} ${f.x0 + w - r},${y + bh}H${f.x0}Z"/>`;
    }
    g += `<text class="lbl" x="${f.x0 + w + 6}" y="${y + bh / 2 + 4}">${num(v)}</text>`;
    g += `<rect class="hit" data-i="${i}" x="0" y="${f.y0 + band * i}" width="${f.w}" height="${band}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.h}" role="img" aria-label="Thời lượng các lượt vào">${g}</svg>`;
  el.querySelectorAll(".hit").forEach((r) => {
    r.addEventListener("mousemove", (e) => { const i = +r.dataset.i; showTip(`<b>${esc(labels[i])}</b><br>${num(values[i])} lượt vào`, e.clientX, e.clientY); });
    r.addEventListener("mouseleave", hideTip);
  });
}

// -------------------------------------------------------------------- now

function tile(label, value, sub = "") {
  return `<div class="adm-tile"><span class="adm-tile__label">${esc(label)}</span><span class="adm-tile__value">${value}</span>${sub ? `<span class="adm-tile__sub">${sub}</span>` : ""}</div>`;
}

function st(kind, text) {
  return `<span class="st ${kind}">${esc(text)}</span>`;
}

function renderNow(o) {
  const t = o.today, live = o.live;
  $("#v-open").textContent = num(live.open);
  $("#v-open-sub").textContent = `${num(live.visits)} lượt vào còn giữ thư viện (12 giờ)`;
  const dl = t.downloads || {};
  $("#tiles").innerHTML = [
    tile("Đang nghe", num(live.playing), "trang đang phát nhạc"),
    tile("Lượt vào hôm nay", num(t.visits), `${num(t.uniques)} khách khác nhau`),
    tile("Quay lại hôm nay", num(t.returning), "mở lại thư viện đã lưu"),
    tile("Nghe hôm nay", esc(dur(t.listen_s)), "tổng thời gian phát"),
    tile("Đông nhất hôm nay", num(t.peak), "trang mở cùng lúc"),
    tile("Bài thêm hôm nay", num(t.added), `${num(t.uploads)} file tải lên`),
    tile("Tải về hôm nay", num(dl.ok), `${num((dl.failed || 0) + (dl.blocked || 0))} lỗi, ${num(dl.blocked)} bị YouTube chặn`),
  ].join("");
  $("#stamp").textContent = `cập nhật ${hm(o.now)}`;
}

function renderQueue(o) {
  const q = o.queue;
  $("#q-sub").textContent = q.count ? `${q.count} bài` : "";
  $("#queue").innerHTML = q.count
    ? q.items.map((it) => `<li><span class="n">${it.pos}</span><span class="t" title="${esc(it.title)}">${esc(it.title || it.id)}</span>
        <span class="s">${it.state === "downloading" ? `${Math.round(100 * (it.progress || 0))}%` : it.state === "pause" ? `nghỉ ${Math.ceil(it.pause_s || 0)} s` : it.state === "starting" ? "bắt đầu" : `~${dur(it.wait_s)}`}</span></li>`).join("")
    : `<li class="adm-empty">Không có bài nào chờ tải</li>`;
  const d = o.today.downloads || {};
  $("#dl-today").innerHTML = `<dt>Hôm nay</dt><dd>${num(d.ok)} xong · ${num(d.failed)} lỗi · ${num(d.blocked)} bị chặn · ${num(d.cancelled)} huỷ</dd>
    <dt>Đang chuẩn bị</dt><dd>${num(o.work.preparing)} bài (tải và phân tích)</dd>`;
}

function renderYoutube(o) {
  const y = o.youtube, c = y.cookies || {};
  const now = o.now;
  let state = st("good", "Ổn");
  if (!c.present) state = st("crit", "Chưa có file cookies");
  else if (c.sign_in_missing?.length) state = st("crit", "Cookies thiếu phần đăng nhập");
  else if (y.youtube_fail_at && (!y.youtube_ok_at || y.youtube_fail_at > y.youtube_ok_at) && /chặn|bot/i.test(y.youtube_fail || "")) state = st("crit", "YouTube đang chặn: thay cookies");
  else if (c.expires_at && c.expires_at - now < 14 * 86400) state = st("warn", "Cookies sắp hết hạn");
  $("#yt").innerHTML = `<dt>Tình trạng</dt><dd>${state}</dd>
    <dt>Tải được gần nhất</dt><dd>${esc(ago(y.youtube_ok_at))}</dd>
    <dt>Lỗi gần nhất</dt><dd>${y.youtube_fail_at ? `${esc(ago(y.youtube_fail_at))}<br><span class="mono">${esc(y.youtube_fail)}</span>` : "chưa có"}</dd>
    <dt>Cookies</dt><dd>${c.present ? `${num(c.count)} cookies, thay ${esc(ago(c.updated_at))}${c.expires_at ? `, hết hạn ${esc(dm(c.expires_at))} (còn ${Math.max(0, Math.round((c.expires_at - now) / 86400))} ngày)` : ""}${c.sign_in_missing?.length ? `<br>thiếu: ${esc(c.sign_in_missing.join(", "))}` : ""}` : "không có"}</dd>`;
}

function meter(label, used, total, text) {
  const p = total ? Math.min(1, used / total) : 0;
  return `<div class="adm-card"><h3 class="adm-h3">${esc(label)}</h3>
    <div class="adm-meter ${p > 0.92 ? "crit" : p > 0.8 ? "warn" : ""}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}" aria-label="${esc(label)}"><i data-p="${p}"></i></div>
    <div class="adm-tile__sub">${esc(text)}</div></div>`;
}

function renderSystem(o) {
  const m = o.machine, s = o.store, w = o.work;
  const limited = Object.entries(o.today.limited || {});
  const cards = [
    ...m.gpu.map((g) => meter(`GPU ${g.name}`, g.used_mb, g.total_mb, `${num(g.used_mb / 1024)} / ${num(g.total_mb / 1024)} GB · đang dùng ${g.util}%`)),
    meter("Ổ đĩa", m.disk.used, m.disk.total, `${bytes(m.disk.used)} / ${bytes(m.disk.total)} · còn ${bytes(m.disk.free)}`),
    s.limit_bytes ? meter("Kho nhạc", s.bytes, s.limit_bytes, `${bytes(s.bytes)} / ${bytes(s.limit_bytes)} · ${num(s.songs)} bài, ${num(s.with_audio)} còn nhạc`)
      : `<div class="adm-card"><h3 class="adm-h3">Kho nhạc</h3><div class="adm-tile__value">${bytes(s.bytes)}</div>
        <div class="adm-tile__sub">${num(s.songs)} bài, ${num(s.with_audio)} còn nhạc · không đặt giới hạn</div></div>`,
    `<div class="adm-card"><h3 class="adm-h3">Hàng việc</h3><dl class="adm-kv">
      <dt>Chuẩn bị bài</dt><dd>${num(w.preparing)}</dd><dt>Tách giọng chờ</dt><dd>${num(w.stems)}</dd>
      <dt>Phân tích lại chờ</dt><dd>${num(w.upgrades)}</dd><dt>Cặp bài đang nối</dt><dd>${num(w.linking)}</dd></dl></div>`,
    `<div class="adm-card"><h3 class="adm-h3">Bị từ chối hôm nay</h3><dl class="adm-kv">${limited.length
      ? limited.map(([k, n]) => `<dt>${esc(LIMIT_VI[k] || k)}</dt><dd>${num(n)}</dd>`).join("") : "<dt>Không có</dt><dd></dd>"}</dl></div>`,
    `<div class="adm-card"><h3 class="adm-h3">Server</h3><dl class="adm-kv"><dt>Chạy được</dt><dd>${esc(dur(o.uptime_s))}</dd>
      <dt>Bài lỗi trong kho</dt><dd>${num(s.errors)}</dd></dl></div>`,
  ];
  $("#sys").innerHTML = cards.join("");
  document.querySelectorAll(".adm-meter i").forEach((i) => (i.style.width = `${(+i.dataset.p * 100).toFixed(1)}%`));
}
const LIMIT_VI = { session: "Mở trang", search: "Tìm kiếm", new_track: "Thêm bài mới", new_track_day: "Bài mới trong ngày", upload: "Tải file lên", audio: "Tải nhạc", mashup: "Tạo mashup" };

// ------------------------------------------------------------------- days

let days = 30;
let hist = null;
function renderHistory() {
  if (!hist) return;
  const ds = hist.days;
  lineChart($("#c-days"), ds.map((d) => dayLabel(d.date)), [
    { name: "Lượt vào", values: ds.map((d) => d.visits) },
    { name: "Khách khác nhau", values: ds.map((d) => d.uniques) },
  ]);
  dataTable($("#c-days"), ["Ngày", "Lượt vào", "Khách", "Quay lại", "Nghe (phút)", "Đông nhất"],
    ds.slice().reverse().map((d) => [dayLabel(d.date), num(d.visits), num(d.uniques), num(d.returning), (d.listen_s / 60).toFixed(1), num(d.peak)]));
  const hours = Array.from({ length: 24 }, (_, h) => ds.reduce((a, d) => a + (d.hours?.visits?.[h] || 0), 0));
  const listen = Array.from({ length: 24 }, (_, h) => ds.reduce((a, d) => a + (d.hours?.listen_s?.[h] || 0), 0) / 60);
  const hl = Array.from({ length: 24 }, (_, h) => `${h}h`);
  $("#hours-sub").textContent = `${days} ngày`;
  columns($("#c-hours"), hl, hours, { name: "Lượt vào theo giờ" });
  dataTable($("#c-hours"), ["Giờ", "Lượt vào", "Phút nghe"], hl.map((h, i) => [h, num(hours[i]), listen[i].toFixed(1)]));
  const mins = (v) => `${v < 10 ? (Math.round(v * 10) / 10).toLocaleString("vi-VN") : num(v)} phút`;
  columns($("#c-listen"), hl, listen, { unit: mins, name: "Thời gian nghe theo giờ" });
  const labels = Object.keys(ds[ds.length - 1].durations || {});
  const counts = labels.map((k) => ds.reduce((a, d) => a + (d.durations?.[k] || 0), 0));
  bars($("#c-dur"), labels, counts);
  dataTable($("#c-dur"), ["Kéo dài", "Lượt vào"], labels.map((l, i) => [l, num(counts[i])]));
  $("#top-songs").innerHTML = hist.top.length
    ? hist.top.map((s, i) => `<li><span class="n">${i + 1}</span><span class="t" title="${esc(s.title)}">${esc(s.title)}</span><span class="s">${num(s.plays)} lượt</span></li>`).join("")
    : `<li class="adm-empty">Chưa có lượt nghe nào</li>`;
}

document.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => {
  days = +b.dataset.days;
  document.querySelectorAll("[data-days]").forEach((x) => x.classList.toggle("on", x === b));
  loadHistory();
}));

async function loadHistory() {
  hist = await call(`/api/admin/history?days=${days}`).catch(() => hist);
  renderHistory();
}

// -------------------------------------------------------------- libraries

async function loadLibraries() {
  const r = await call("/api/admin/libraries").catch(() => null);
  if (!r) return;
  const now = Date.now() / 1000;
  $("#libs-sub").textContent = `${r.libraries.length} lượt vào`;
  $("#libs tbody").innerHTML = r.libraries.length ? r.libraries.map((l) => {
    const state = l.playing ? st("good", "Đang nghe") : l.open ? st("", "Đang mở") : st("", `Vắng ${dur(now - l.seen)}`);
    const shown = l.songs.slice(0, 6);
    return `<tr><td class="mono">${esc(l.id)}</td><td>${state}</td><td class="mono">${hm(l.created)} ${dm(l.created)}</td>
      <td class="mono">${esc(ago(l.seen))}</td>
      <td class="songs">${shown.map((s) => `<span title="${esc(s.title)}">${esc(s.title)}${s.status !== "ready" ? ` · ${esc(STATUS_VI[s.status] || s.status)}` : ""}${s.off ? " · ngoài chuỗi" : ""}</span>`).join("")}${l.songs.length > shown.length ? `<span>và ${l.songs.length - shown.length} bài nữa</span>` : ""}${l.songs.length ? "" : "<span>không có</span>"}</td>
      <td class="songs">${Object.entries(l.samples).map(([k, n]) => `<span>${esc(k)} (${n})</span>`).join("") || "<span>không có</span>"}</td></tr>`;
  }).join("") : `<tr><td colspan="6" class="adm-empty">Không có lượt vào nào đang giữ thư viện</td></tr>`;
}

// ------------------------------------------------------------------ store

const STATUS_VI = { ready: "sẵn sàng", error: "lỗi", queued: "đang chờ", downloading: "đang tải", analyzing: "đang phân tích" };
const SOURCE_VI = { youtube: "YouTube", soundcloud: "SoundCloud", zingmp3: "Zing MP3", bandcamp: "Bandcamp", mixcloud: "Mixcloud",
  jamendo: "Jamendo", upload: "Tải lên" };
let store = null, filter = "all", sortKey = "used_at", sortDir = -1;
const LIMIT_ROWS = 300;

async function loadStore() {
  store = await call("/api/admin/store").catch(() => store);
  renderStore();
}

function renderStore() {
  if (!store) return;
  const q = $("#store-q").value.trim().toLowerCase();
  const now = Date.now() / 1000;
  let rows = store.rows.filter((r) => filter === "all" || (filter === "own" && !r.sample) || (filter === "held" && r.held)
    || (filter === "error" && r.status === "error"));
  if (q) rows = rows.filter((r) => `${r.title} ${r.channel} ${r.id}`.toLowerCase().includes(q));
  rows.sort((a, b) => {
    const x = a[sortKey] ?? -Infinity, y = b[sortKey] ?? -Infinity;
    return (typeof x === "string" ? x.localeCompare(y, "vi") : x - y) * sortDir;
  });
  const errors = store.rows.filter((r) => r.status === "error").length;
  $("#store-sub").textContent = `${num(store.rows.length)} bài · ${bytes(store.bytes)} · ${num(errors)} lỗi`;
  $("#store tbody").innerHTML = rows.slice(0, LIMIT_ROWS).map((r) => {
    const status = r.status === "ready" ? (r.audio ? st("good", "Sẵn sàng") : st("", "Đã xoá nhạc"))
      : r.status === "error" ? st("crit", "Lỗi") : st("warn", STATUS_VI[r.status] || r.status || "?");
    const until = r.sample ? "kho có sẵn" : r.audio_until ? clock(r.audio_until - now) : r.audio ? "giữ" : "—";
    const src = SOURCE_VI[r.source] || r.source || "";
    return `<tr><td class="t"><b title="${esc(r.title)}">${esc(r.title)}</b><span>${esc(r.channel)}${r.channel ? " · " : ""}${esc(r.id)}${r.sample ? " · kho có sẵn" : ""}</span></td>
      <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(src)}</a>` : esc(src)}</td>
      <td>${status}${r.status === "error" && r.error ? `<span class="err">${esc(r.error)}</span>` : ""}</td>
      <td class="nr">${r.held || ""}</td><td class="mono">${esc(ago(r.used_at))}</td><td class="mono">${esc(until)}</td>
      <td class="nr">${bytes(r.size)}</td>
      <td class="acts">${r.status === "error" ? `<button type="button" class="adm-btn adm-btn--small" data-retry="${esc(r.id)}">Thử lại</button>` : ""}
        ${!r.sample && !r.held ? `<button type="button" class="adm-btn adm-btn--small" data-del="${esc(r.id)}" data-title="${esc(r.title)}">Xoá</button>` : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="8" class="adm-empty">Không có bài nào</td></tr>`;
  $("#store-more").textContent = rows.length > LIMIT_ROWS ? `Hiện ${LIMIT_ROWS}/${num(rows.length)} bài: tìm hoặc lọc để thu hẹp.` : "";
  document.querySelectorAll("#store th[data-sort]").forEach((th) => {
    if (th.dataset.sort === sortKey) th.setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

$("#store-q").addEventListener("input", renderStore);
document.querySelectorAll("#store-f button").forEach((b) => b.addEventListener("click", () => {
  filter = b.dataset.f;
  document.querySelectorAll("#store-f button").forEach((x) => x.classList.toggle("on", x === b));
  renderStore();
}));
document.querySelectorAll("#store th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  sortDir = sortKey === th.dataset.sort ? -sortDir : -1;
  sortKey = th.dataset.sort;
  renderStore();
}));
$("#store tbody").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.retry) {
      b.disabled = true;
      await call(`/api/admin/tracks/${encodeURIComponent(b.dataset.retry)}/retry`, { method: "POST" });
    } else if (b.dataset.del) {
      if (!confirm(`Xoá hẳn «${b.dataset.title}» khỏi kho? Phần phân tích cũng mất.`)) return;
      b.disabled = true;
      await call(`/api/admin/tracks/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
    }
  } catch (err) {
    alert(err.message);
  }
  loadStore();
});

// --------------------------------------------------------------- suspects

const KIND_VI = { clients: "Client", agents: "User-agent chứa", ips: "IP", trusted: "Tin cậy" };
const BROWSER = /mozilla\/5\.0/i;
let sus = null;

async function loadSuspects() {
  sus = await call("/api/admin/suspects").catch(() => sus);
  if (!sus) return;
  const blockedUa = new Set(sus.rules.agents.map((r) => r.value.toLowerCase()));
  $("#sus-sub").textContent = `${sus.clients.length} client`;
  $("#sus tbody").innerHTML = sus.clients.length ? sus.clients.map((c) => {
    const ua = c.agents[0]?.[0] || "";
    return `<tr><td class="who"><b>${esc(c.id)}</b>${c.ip ? `<span>${esc(c.ip)}</span>` : ""}${c.is_blocked ? `<span class="st crit">đã chặn</span>` : ""}${c.from_page ? `<em class="adm-tag" title="${num(c.from_page)} request gửi từ chính trang web trong trình duyệt: nhiều khả năng là người thật có tab bị kẹt, không phải bot">trình duyệt</em>` : ""}</td>
      <td class="ua">${c.agents.map(([a, n]) => `<span title="${esc(a)}">${esc(a || "(không có)")} · ${num(n)}</span>`).join("")}</td>
      <td class="nr">${num(c.opened)}</td><td class="nr">${num(c.polls)}</td><td class="nr">${num(c.refused)}</td>
      <td class="why">${c.why.map((w) => `<span>${esc(w)}</span>`).join("")}${c.probes.map(([p, n]) => `<span class="mono">${esc(p)} × ${n}</span>`).join("")}${c.blocked ? `<span>đã chặn ${num(c.blocked)} request</span>` : ""}
        <span class="mono">${(c.kinds || []).map(([k, n]) => `${esc(k)} × ${num(n)}`).join(" · ")}</span>
        <span class="mono">mã trả về: ${(c.statuses || []).map(([k, n]) => `${k} × ${num(n)}`).join(" · ")}</span>
        <span class="mono">${use(c)}</span></td>
      <td class="mono">${esc(ago(c.last))}<br>từ ${esc(hm(c.first))}</td>
      <td class="acts">${c.is_blocked ? "" : `<button type="button" class="adm-btn adm-btn--small" data-block="clients" data-value="${esc(c.id)}" data-note="${esc(c.why[0] || "")}">Chặn client</button>`}
        ${c.ip ? `<button type="button" class="adm-btn adm-btn--small" data-block="ips" data-value="${esc(c.ip)}" data-note="${esc(c.why[0] || "")}">Chặn IP</button>
          <button type="button" class="adm-btn adm-btn--small" data-block="trusted" data-value="${esc(c.ip)}" data-note="">Tin cậy</button>` : ""}
        ${ua && !blockedUa.has(ua.toLowerCase()) ? `<button type="button" class="adm-btn adm-btn--small" data-block="agents" data-value="${esc(ua)}" data-note="${esc(c.why[0] || "")}">Chặn user-agent</button>` : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="8" class="adm-empty">Chưa thấy client nào đáng ngờ</td></tr>`;
  $("#uas tbody").innerHTML = sus.agents.map((a) => `<tr><td class="ua"><span title="${esc(a.ua)}">${esc(a.ua || "(không có user-agent)")}</span>${a.bot ? `<em class="adm-tag">bot/script</em>` : a.crawler ? `<em class="adm-tag">crawler tìm kiếm</em>` : ""}</td>
      <td class="nr">${num(a.clients)}</td><td class="nr">${num(a.req)}</td><td class="nr">${num(a.opened)}</td><td class="nr">${num(a.polls)}</td><td class="nr">${num(a.refused)}</td>
      <td class="acts">${a.ua && !a.crawler && !blockedUa.has(a.ua.toLowerCase()) ? `<button type="button" class="adm-btn adm-btn--small" data-block="agents" data-value="${esc(a.ua)}">Chặn</button>` : ""}</td></tr>`).join("")
    || `<tr><td colspan="7" class="adm-empty">Chưa có</td></tr>`;
  const rules = Object.entries(sus.rules).flatMap(([kind, list]) => list.map((r) => ({ kind, ...r })));
  $("#rules").innerHTML = rules.length ? rules.map((r) => `<li><span class="n">${esc(KIND_VI[r.kind][0])}</span>
      <span class="t" title="${esc(r.value)}">${esc(KIND_VI[r.kind])}: ${esc(r.value)}${r.note ? ` · ${esc(r.note)}` : ""}</span>
      <span class="s">${r.until ? `tự gỡ ${hm(r.until)} ${dm(r.until)} · ` : ""}${r.kind === "trusted" ? "" : `${num(r.hits)} lần chặn · `}<button type="button" class="adm-btn adm-btn--small" data-unblock="${esc(r.kind)}" data-value="${esc(r.value)}">${r.kind === "trusted" ? "Bỏ tin cậy" : "Bỏ chặn"}</button></span></li>`).join("")
    : `<li class="adm-empty">Chưa chặn gì</li>`;
}

// What a client did with the site (guard._use).
const use = (c) => `thêm ${num(c.added)} bài · audio ${num(c.songs)} bài của khách · phát ${dur(c.play_s)}`
  + `${c.longest_s ? `, liền nhất ${dur(c.longest_s)}` : ""} · đỉnh ${num(c.peak)} request/phút`
  + `${c.peak_x ? ` (${num(c.peak_x)} không từ trang)` : ""}`
  + `${c.chrome ? ` · thiếu client hints ${num(c.nohints)}/${num(c.chrome)} request Chrome` : ""}`;

async function loadClients() {
  const d = await call("/api/admin/clients").catch(() => null);
  if (!d) return;
  $("#all-sub").textContent = `${num(d.clients.length)} client`;
  $("#all tbody").innerHTML = d.clients.length ? d.clients.map((c) => `<tr>
      <td class="who"><b>${esc(c.id)}</b>${c.ip ? `<span>${esc(c.ip)}</span>` : ""}${c.is_blocked ? `<span class="st crit">đã chặn</span>` : ""}${c.why.length ? `<span class="st warn" title="${esc(c.why.join("; "))}">nghi vấn</span>` : ""}</td>
      <td class="ua"><span title="${esc(c.ua)}">${esc(c.ua || "(không có)")}</span></td>
      <td class="nr">${num(c.req)}</td><td class="nr">${num(c.from_page)}</td><td class="nr">${num(c.peak)}</td>
      <td class="nr">${num(c.opened)} / ${num(c.polls)}</td><td class="nr">${num(c.added)}</td><td class="nr">${num(c.songs)}</td>
      <td class="mono">${c.play_s ? `${esc(dur(c.play_s))}${c.longest_s ? `<br>liền ${esc(dur(c.longest_s))}` : ""}` : "chưa phát"}</td>
      <td class="mono">${esc(ago(c.last))}<br>từ ${esc(hm(c.first))}</td></tr>`).join("")
    : `<tr><td colspan="10" class="adm-empty">Chưa có</td></tr>`;
}

async function setBlock(kind, value, note, on = true) {
  if (on && kind === "agents" && BROWSER.test(value) && !/bot|crawl|spider|headless/i.test(value)
      && !confirm("User-agent này giống trình duyệt thường: chặn nó có thể chặn cả người dùng thật. Vẫn chặn?")) return;
  if (on && kind !== "agents" && !confirm(kind === "trusted" ? `Tin cậy ${value}? Địa chỉ này sẽ không bao giờ bị nghi hay bị chặn.` : `Chặn ${KIND_VI[kind].toLowerCase()} ${value}?`)) return;
  try {
    await call(on ? "/api/admin/block" : "/api/admin/unblock", { method: "POST", body: JSON.stringify({ kind, value, note: note || "" }) });
    $("#block-msg").className = "adm-err ok";
    $("#block-msg").textContent = kind === "trusted" ? (on ? `Đã tin cậy ${value}` : `Đã bỏ tin cậy ${value}`)
      : on ? `Đã chặn ${KIND_VI[kind].toLowerCase()} ${value}` : `Đã bỏ chặn ${value}`;
  } catch (err) {
    $("#block-msg").className = "adm-err";
    $("#block-msg").textContent = err.message;
  }
  loadSuspects();
}

for (const id of ["#sus", "#uas", "#rules"]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b?.dataset.block) setBlock(b.dataset.block, b.dataset.value, b.dataset.note);
    else if (b?.dataset.unblock) setBlock(b.dataset.unblock, b.dataset.value, "", false);
  });
}

$("#block-form").addEventListener("submit", (e) => {
  e.preventDefault();
  setBlock($("#block-kind").value, $("#block-value").value.trim(), $("#block-note").value.trim()).then(() => {
    $("#block-value").value = "";
    $("#block-note").value = "";
  });
});

// ---------------------------------------------------------------- cookies

$("#cookie-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#cookie-msg");
  msg.className = "adm-err";
  msg.textContent = "";
  try {
    const r = await call("/api/admin/cookies", { method: "POST", body: JSON.stringify({ text: $("#cookie-text").value }) });
    $("#cookie-text").value = "";
    msg.className = "adm-err ok";
    msg.textContent = `Đã thay: ${r.cookies.count} cookies, đủ phần đăng nhập.`;
    loadOverview();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// -------------------------------------------------------------------- ads

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(a / b < 0.01 ? 2 : 1).replace(".", ",")} %` : "chưa có");

function renderAds(r) {
  const list = r.ads || [];
  const on = list.filter((a) => a.active).length;
  $("#ads-sub").textContent = list.length ? `${num(on)} đang chạy / ${num(list.length)}` : "";
  $("#ads").innerHTML = list.length ? list.map((a) => `
    <article class="adm-card adm-ad${a.active ? "" : " off"}" data-id="${a.id}">
      <img class="adm-ad__img" src="${esc(a.image)}" alt="${esc(a.alt)}" width="${a.width}" height="${a.height}" loading="lazy">
      <div class="adm-ad__head">
        <b class="adm-ad__title">${esc(a.title)}</b>
        <span class="adm-tag">#${a.id}</span><span class="adm-tag${a.active ? " adm-tag--on" : ""}">${a.active ? "Đang chạy" : "Tạm dừng"}</span>
        <span class="adm-h3__sub">${a.width}×${a.height}, thêm ${esc(dm(a.created_at))}</span>
      </div>
      <p class="mono adm-ad__link">${esc(a.link)}</p>
      <dl class="adm-kv adm-ad__kv">
        <dt>Lượt thấy</dt><dd>${num(a.seen)} <span class="adm-h3__sub">hôm nay ${num(a.today[0])}, 7 ngày ${num(a.week[0])}</span></dd>
        <dt>Click</dt><dd>${num(a.clicks)} <span class="adm-h3__sub">hôm nay ${num(a.today[1])}, 7 ngày ${num(a.week[1])}</span></dd>
        <dt>Tỉ lệ click</dt><dd>${pct(a.clicks, a.seen)}</dd>
      </dl>
      <div class="adm-ad__acts">
        <label class="adm-ad__w">Ưu tiên <input type="number" min="1" max="10" value="${a.weight}" data-weight aria-label="Độ ưu tiên của #${a.id}"></label>
        <button type="button" class="adm-btn adm-btn--small" data-act="toggle">${a.active ? "Tạm dừng" : "Chạy lại"}</button>
        <button type="button" class="adm-btn adm-btn--small" data-act="delete">Xoá</button>
      </div>
      <details class="adm-more">
        <summary>Sửa tiêu đề, link, mô tả</summary>
        <form class="adm-ad__edit" data-edit>
          <label class="adm-field"><span>Tiêu đề</span><input name="title" maxlength="80" value="${esc(a.title)}" required></label>
          <label class="adm-field"><span>Link</span><input name="link" class="mono" value="${esc(a.link)}" required></label>
          <label class="adm-field"><span>Mô tả ảnh</span><input name="alt" maxlength="160" value="${esc(a.alt)}"></label>
          <button type="submit" class="adm-btn adm-btn--main adm-btn--small">Lưu</button>
        </form>
      </details>
      <p class="adm-err" role="status" data-msg></p>
    </article>`).join("")
    : `<p class="adm-card adm-empty">Chưa có quảng cáo nào: trang chỉ hiện mã QR mời cà phê.</p>`;
}

async function loadAds() {
  try {
    renderAds(await call("/api/admin/ads"));
  } catch (_) { /* (signed out: the sign-in shows) */ }
}

async function editAd(card, body) {
  const msg = card.querySelector("[data-msg]");
  try {
    renderAds(await call(`/api/admin/ads/${card.dataset.id}`, body ? { method: "PATCH", body: JSON.stringify(body) } : { method: "DELETE" }));
  } catch (err) {
    msg.textContent = err.message;
  }
}

$("#ads").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const card = b.closest(".adm-ad");
  if (b.dataset.act === "toggle") editAd(card, { active: card.classList.contains("off") });
  else if (confirm(`Xoá quảng cáo #${card.dataset.id}? Số lượt thấy và click của nó mất theo.`)) editAd(card, null);
});
$("#ads").addEventListener("change", (e) => {
  if (e.target.matches("[data-weight]")) editAd(e.target.closest(".adm-ad"), { weight: +e.target.value || 1 });
});
$("#ads").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements; // (by name: a form's own .title is its tooltip)
  editAd(e.target.closest(".adm-ad"), { title: f.title.value, link: f.link.value.trim(), alt: f.alt.value });
});

// The file made into what the page shows: at most 1600 px wide (twice the
// widest slot), as WebP (PNG where the browser cannot make WebP), without its
// metadata. The server has no imaging library, so this is where it happens.
let adImage = null;
function readImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Không đọc được ảnh này"));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error("Không đọc được file"));
    fr.readAsDataURL(file);
  });
}

async function shrink(img) {
  const w = Math.min(1600, img.naturalWidth), h = Math.round(img.naturalHeight * w / img.naturalWidth);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, w, h);
  const blob = await new Promise((res) => c.toBlob(res, "image/webp", 0.88));
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ data: fr.result, w, h, bytes: blob.size, type: blob.type });
    fr.readAsDataURL(blob);
  });
}

$("#ad-file").addEventListener("change", async (e) => {
  const msg = $("#ad-msg");
  msg.className = "adm-err";
  msg.textContent = "";
  adImage = null;
  $("#ad-preview").hidden = true;
  const file = e.target.files[0];
  if (!file) return;
  try {
    const img = await readImage(file);
    const ratio = img.naturalWidth / img.naturalHeight;
    if (ratio < 4.5 || ratio > 8) throw new Error(`Banner cần tỉ lệ khoảng 6:1, ví dụ 2400×400 (ảnh này ${img.naturalWidth}×${img.naturalHeight})`);
    if (img.naturalWidth < 600) throw new Error(`Ảnh nhỏ quá (${img.naturalWidth}×${img.naturalHeight}): cần rộng ít nhất 600 px`);
    adImage = await shrink(img);
    $("#ad-preview").src = adImage.data;
    $("#ad-preview").hidden = false;
    msg.className = "adm-err ok";
    msg.textContent = `Sẽ gửi ${adImage.w}×${adImage.h}, ${bytes(adImage.bytes)} (${adImage.type === "image/webp" ? "WebP" : "PNG"}).`;
    if (!$("#ad-title").value) $("#ad-title").value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 80);
  } catch (err) {
    msg.textContent = err.message;
  }
});

$("#ad-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#ad-msg"), btn = e.target.querySelector("button[type=submit]");
  if (!adImage) {
    msg.className = "adm-err";
    msg.textContent = "Chọn một ảnh banner trước";
    return;
  }
  btn.disabled = true;
  try {
    renderAds(await call("/api/admin/ads", { method: "POST", body: JSON.stringify({
      title: $("#ad-title").value, link: $("#ad-link").value.trim(), alt: $("#ad-alt").value,
      weight: +$("#ad-weight").value || 1, image: adImage.data }) }));
    e.target.reset();
    adImage = null;
    $("#ad-preview").hidden = true;
    msg.className = "adm-err ok";
    msg.textContent = "Đã thêm, đang chạy.";
  } catch (err) {
    msg.className = "adm-err";
    msg.textContent = err.message;
  }
  btn.disabled = false;
});

// ------------------------------------------------------------------ start

async function loadOverview() {
  const o = await call("/api/admin/overview");
  renderNow(o);
  renderQueue(o);
  renderYoutube(o);
  renderSystem(o);
  return o;
}

async function start() {
  try {
    await loadOverview();
  } catch (_) {
    return; // (signed out: the sign-in shows)
  }
  $("#login").hidden = true;
  $("#dash").hidden = false;
  $("#top-end").hidden = false;
  loadHistory();
  loadLibraries();
  loadSuspects();
  loadClients();
  loadStore();
  loadAds();
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => loadOverview().catch(() => {}), 5000),
    setInterval(() => { loadLibraries(); loadSuspects(); }, 15000),
    setInterval(loadClients, 30000),
    setInterval(() => { loadHistory(); loadStore(); }, 60000),
    // (Not while a banner is being edited: the form would be drawn over.)
    setInterval(() => { if (!document.querySelector("#ads [open], #ads :focus")) loadAds(); }, 60000),
  ];
}

let resizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(renderHistory, 150);
});

start();

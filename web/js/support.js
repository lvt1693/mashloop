// Hosted: what pays for the server, under the setlist. The banners (ads.py)
// take turns, eight seconds each, the heavier ones more often, crossfading;
// a banner counts as seen once half of it has been on screen for a second
// (the server counts a client once an hour). They hold still while pointed at
// or focused, while off screen or in a hidden tab, and for a visitor who asked
// for less motion (the dots still change them). The coffee opens the bank's QR,
// with the account number to copy on a phone.
const $ = (s) => document.querySelector(s);
const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
const SEEN_MS = 1000;
const ACCOUNT = "178971468";

export function startSupport() {
  coffee();
  // (Shown with the banners in one go: the kept room goes only if there are none.)
  fetch("/api/ads", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { ads: [] }))
    .catch(() => ({ ads: [] }))
    .then((r) => {
      banners(r.ads || [], (r.rotate_s || 8) * 1000);
      $("#support").hidden = false;
    });
}

// Not hosted: no room kept for a banner that never comes.
export function noSupport() {
  document.documentElement.classList.remove("hosted");
}

// ---------------------------------------------------------------- banners

function banners(ads, every) {
  if (!ads.length) return;
  const slot = $("#promo-slot"), dots = $("#promo-dots");
  slot.innerHTML = "";
  dots.innerHTML = "";
  const links = ads.map((a, i) => {
    const link = document.createElement("a");
    link.href = a.go;
    link.target = "_blank";
    link.rel = "sponsored noopener";
    const img = new Image(a.width, a.height);
    img.src = a.image;
    img.alt = a.alt || a.title;
    img.decoding = "async";
    img.fetchPriority = i ? "low" : "auto";
    link.append(img);
    slot.append(link);
    if (ads.length > 1) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.setAttribute("aria-label", `Quảng cáo ${i + 1}: ${a.title}`);
      dot.addEventListener("click", () => { show(i); restart(); });
      dots.append(dot);
    }
    return link;
  });

  // Smooth weighted turns: a banner of weight 3 shows three times for every
  // one of weight 1, spread out rather than in a row.
  const credit = ads.map(() => 0);
  const total = ads.reduce((s, a) => s + (a.weight || 1), 0);
  const nextTurn = () => {
    let best = 0;
    ads.forEach((a, i) => {
      credit[i] += a.weight || 1;
      if (credit[i] > credit[best]) best = i;
    });
    credit[best] -= total;
    return best;
  };
  // (The first one drawn by weight, so each banner gets its share of first looks.)
  let r = Math.random() * total, first = 0;
  while ((r -= ads[first].weight || 1) > 0) first++;

  let cur = -1;
  function show(i) {
    cur = i;
    links.forEach((l, j) => {
      l.classList.toggle("on", j === i);
      l.inert = j !== i;
    });
    [...dots.children].forEach((d, j) => d.setAttribute("aria-current", String(j === i)));
    watchSeen();
  }

  // Seen: half of the slot on screen, the tab visible, for a second.
  const counted = new Map(); // ad id -> when this page reported it
  let onScreen = false, seenT = null;
  function watchSeen() {
    clearTimeout(seenT);
    if (!onScreen || document.hidden) return;
    const ad = ads[cur];
    if (Date.now() - (counted.get(ad.id) || 0) < 3600e3) return;
    seenT = setTimeout(() => {
      counted.set(ad.id, Date.now());
      fetch(`/api/ads/${ad.id}/seen`, { method: "POST", cache: "no-store" }).catch(() => {});
    }, SEEN_MS);
  }
  new IntersectionObserver((es) => {
    onScreen = es[es.length - 1].intersectionRatio >= 0.49;
    watchSeen();
    restart();
  }, { threshold: [0, 0.5, 1] }).observe(slot);

  // Turns.
  let held = false, turnT = null;
  const still = () => ads.length < 2 || held || reduceMQ.matches || document.hidden || !onScreen;
  function restart() {
    clearTimeout(turnT);
    if (still()) return;
    turnT = setTimeout(() => { show(nextTurn()); restart(); }, every);
  }
  const promo = $("#promo");
  const hold = (on) => { held = on; restart(); };
  promo.addEventListener("pointerenter", () => hold(true));
  promo.addEventListener("pointerleave", () => hold(promo.contains(document.activeElement)));
  promo.addEventListener("focusin", () => hold(true));
  promo.addEventListener("focusout", (e) => hold(promo.contains(e.relatedTarget) || promo.matches(":hover")));
  document.addEventListener("visibilitychange", () => { watchSeen(); restart(); });
  reduceMQ.addEventListener("change", restart);

  // (The weighted turns start after the first: keep their order from there.)
  while (nextTurn() !== first) { /* advance */ }
  show(first);
  promo.hidden = false;
  restart();
}

// ----------------------------------------------------------------- coffee

function coffee() {
  const dlg = $("#donate"), btn = $("#coffee"), copied = $("#donate-copied");
  btn.addEventListener("click", () => {
    dlg.showModal();
    btn.setAttribute("aria-expanded", "true");
  });
  dlg.addEventListener("close", () => {
    btn.setAttribute("aria-expanded", "false");
    copied.textContent = "Sao chép";
  });
  // A click on the backdrop (outside the card) closes it too.
  dlg.addEventListener("click", (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
  });
  $("#donate-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ACCOUNT);
      copied.textContent = "Đã chép số tài khoản";
    } catch (_) {
      // (No clipboard, an http page or an old browser: the number selected to copy by hand.)
      const r = document.createRange();
      r.selectNodeContents($("#donate-copy .mono"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      copied.textContent = "Đã chọn, bấm giữ để chép";
    }
  });
}

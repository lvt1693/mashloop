// A track's beat graph: sequential edges i -> i+1 plus analysed jumps i -> j.

export class Track {
  constructor(meta, analysis, buffer) {
    this.id = meta.id;
    this.meta = meta;
    this.analysis = analysis;
    this.buffer = buffer;
    const a = analysis;
    this.n = a.beats.length;
    this.beats = a.beats;
    this.lbp = a.lbp;
    this.end = buffer ? buffer.duration : a.duration;
    this.dur = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const next = i + 1 < this.n ? a.beats[i + 1] : Math.min(this.end, a.beats[i] + this.medianIbi());
      this.dur[i] = Math.max(0.05, next - a.beats[i]);
    }
    // jumps[i] = [{to, score, shift, xf, bridge, rho}] for "after beat i, play beat to".
    // Bridges lead out of stretches that would otherwise trap the walk, so they
    // stay usable whatever the strictness setting. rho (the two sides'
    // correlation across the crossfade) sets its fade law; analyses before it
    // have none and keep equal power.
    this.jumps = Array.from({ length: this.n }, () => []);
    for (const [i, j, score, shiftMs, xfMs = 12, bridge = 0, rho = 0] of a.jumps) {
      if (i >= 0 && i < this.n && j >= 0 && j < this.n) {
        this.jumps[i].push({ to: j, score, shift: shiftMs / 1000, xf: xfMs / 1000, bridge: !!bridge, rho });
      }
    }
    this.transitions = [];
    this.sortedScores = a.jumps.map((j) => j[2]).sort((x, y) => x - y);
  }

  // Score limit that keeps the best `keep` fraction of this song's jumps.
  // Scores are not comparable between songs (a song full of different sung
  // lines scores higher than a looped groove), so strictness is relative;
  // jumps scoring 0.2 or less are near-identical repeats and always allowed.
  scoreCut(keep) {
    const s = this.sortedScores;
    if (!s.length) return 0.2;
    const k = Math.min(s.length - 1, Math.max(0, Math.ceil(keep * s.length) - 1));
    return Math.max(0.2, s[k]);
  }

  medianIbi() {
    const b = this.analysis.beats;
    const d = [];
    for (let i = 1; i < b.length; i++) d.push(b[i] - b[i - 1]);
    d.sort((x, y) => x - y);
    return d.length ? d[d.length >> 1] : 0.5;
  }

  eligible(i, maxScore) {
    return this.jumps[i].filter((e) => e.score <= maxScore || e.bridge);
  }

  // Where a song is entered when no analysed transition says otherwise.
  entryBeat() {
    const s = this.analysis.sections.find((b) => b <= this.lbp);
    return s !== undefined ? s : 0;
  }

  sectionAt(beat) {
    const s = this.analysis.sections;
    let k = 0;
    for (let i = 0; i < s.length; i++) if (s[i] <= beat) k = i;
    return k;
  }

  // Cheapest route from `start` to every beat, following playback order and
  // the given jumps. Each jump costs jumpCost extra seconds so a route only
  // jumps when that saves real time: a string of back-to-back jumps sounds
  // like a skipping record. time[v] is the playing time along that route;
  // prev[v] = [u, isJump] reconstructs it.
  distances(start, maxScore, jumpCost = 2.5) {
    const n = this.n;
    const cost = new Float64Array(n).fill(Infinity);
    const time = new Float64Array(n).fill(Infinity);
    const prev = new Array(n).fill(null);
    const heap = new MinHeap();
    cost[start] = 0;
    time[start] = 0;
    heap.push(0, start);
    while (heap.size) {
      const [c, u] = heap.pop();
      if (c > cost[u]) continue;
      const w = this.dur[u];
      const relax = (v, isJump) => {
        const nc = c + w + (isJump ? jumpCost : 0);
        if (nc < cost[v]) {
          cost[v] = nc;
          time[v] = time[u] + w;
          prev[v] = [u, isJump];
          heap.push(nc, v);
        }
      };
      if (u + 1 < n) relax(u + 1, false);
      // The last branch point always jumps back, whatever its score.
      for (const e of u === this.lbp ? this.jumps[u] : this.eligible(u, maxScore)) relax(e.to, true);
    }
    return { dist: time, cost, prev };
  }

  // Jumps to take on the way from start to target: Map(source beat -> dest beat).
  route(prev, start, target) {
    const jumps = new Map();
    let v = target;
    let guard = 0;
    while (v !== start && prev[v] && guard++ < 100000) {
      const [u, isJump] = prev[v];
      if (isJump) jumps.set(u, v);
      v = u;
    }
    return jumps;
  }
}

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

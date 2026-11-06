"""On the box: what each address did, read from HAProxy's request log
(frontend https_in, see deploy/haproxy.cfg), to find abuse.

  python3 deploy/access_report.py [log files...] [--samples data/samples.json] [--top 15]

Default log: /var/log/haproxy.log (add haproxy.log.1 for the day before; .gz
files are read too). Per address: requests, how many the site's own page made
(Sec-Fetch-Site: same-origin), the busiest minute, songs brought in, songs of
its own (not the sample libraries) whose sound it took and the bytes of it,
time playing (the page polls /api/tracks?p=1 while it plays) and the longest
stretch, and what HAProxy turned away (blocked addresses). Sections:
  taking songs   sound of many songs, little playing
  playing on     the longest stretches played (a stream fed from here, or a listener)
  not a browser  requests the site's page did not make, by user agent
  floods         the busiest minutes
  turned away    blocked addresses still knocking, and whether a browser's page
                 is behind them (a listener blocked) or not
  embedded       the page asked for inside another site's frame, and API calls
                 from another site's page (both refused), by the site (Referer)
  arrived from   the sites whose links bring people to the page
Nothing is written; addresses are printed (the report is for the admin)."""
import argparse
import gzip
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

# The captures: {user agent|Sec-Fetch-Site} until 29/10/2026, then
# {user agent|Sec-Fetch-Site|Sec-Fetch-Dest|Referer}.
LINE = re.compile(r"haproxy\[\d+\]: (?P<addr>\S+) \[(?P<ts>[^\]]+)\] \S+ (?P<be>\S+) \S+ (?P<status>-?\d+) "
                  r"(?P<bytes>\d+) \S+ \S+ (?P<term>\S+) \S+ \S+ \{(?P<ua>[^|}]*)\|(?P<sfs>[^|}]*)"
                  r"(?:\|(?P<dest>[^|}]*)\|(?P<ref>[^}]*))?\} \"(?P<method>\S+) (?P<uri>\S+)")
SOUND = re.compile(r"^/api/tracks/([^/]+)/(?:audio|vocals)$")
TRACK = re.compile(r"^/api/tracks/[^/]+")
PLAY_GAP_S = 90


def lines(paths):
    for p in paths:
        opener = gzip.open if p.suffix == ".gz" else open
        try:
            with opener(p, "rt", encoding="utf-8", errors="replace") as f:
                yield from f
        except OSError as e:
            print(f"(skipped {p}: {e})", file=sys.stderr)


def path_of(uri: str) -> tuple[str, str]:
    if "://" in uri:  # HTTP/2 logs the full URL
        rest = uri.split("://", 1)[1]
        uri = "/" + rest.split("/", 1)[1] if "/" in rest else "/"
    path, _, query = uri.partition("?")
    return path, query


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="*", default=["/var/log/haproxy.log"])
    ap.add_argument("--samples", default=str(Path(__file__).resolve().parent.parent / "data" / "samples.json"))
    ap.add_argument("--top", type=int, default=15)
    a = ap.parse_args()
    try:
        sj = json.loads(Path(a.samples).read_text())
        samples = {t for lib in sj.get("libraries") or [] for t in lib.get("ids") or []} | set(sj.get("ids") or [])
    except (OSError, ValueError, AttributeError):
        samples = set()
        print("(no samples.json: every song counts as a visitor's)", file=sys.stderr)

    ips = defaultdict(lambda: {"req": 0, "page": 0, "first": None, "last": None, "minutes": Counter(),
                               "minutes_x": Counter(), "ua": Counter(), "kinds": Counter(), "status": Counter(),
                               "added": 0, "songs": set(), "sound_bytes": 0, "searches": 0, "uploads": 0,
                               "play_s": 0.0, "play_at": None, "streak": 0.0, "longest": 0.0, "turned_away": 0})
    n = bad = 0
    framed, foreign, arrived = Counter(), Counter(), Counter()
    for raw in lines([Path(p) for p in a.logs]):
        m = LINE.search(raw)
        if not m:
            bad += "https_in" in raw and "Proxy https_in" not in raw  # (HAProxy's own notices are not requests)
            continue
        # Only Mash ∞ Loop's (a box's HAProxy may log other sites too): its backend, or a request
        # turned away before one (blocked: its user agent was captured, the other sites' are not).
        if "mashloop" not in m["be"] and not (m["be"].endswith("<NOSRV>") and m["ua"]):
            continue
        n += 1
        ip = m["addr"].rsplit(":", 1)[0].strip("[]")
        t = datetime.strptime(m["ts"], "%d/%b/%Y:%H:%M:%S.%f")
        site = re.sub(r"^[a-z]+://([^/]+).*$", r"\1", m["ref"] or "") or "(no Referer)"
        if m["dest"] in ("iframe", "frame", "embed", "object"):
            framed[(site, ip)] += 1
        if m["sfs"] in ("cross-site", "same-site") and "/api/" in m["uri"]:
            foreign[(site, ip)] += 1
        if m["sfs"] == "cross-site" and m["dest"] == "document":
            arrived[site] += 1
        s = ips[ip]
        s["req"] += 1
        s["first"] = s["first"] or t
        s["last"] = t
        page = m["sfs"] == "same-origin"
        s["page"] += page
        minute = t.strftime("%d/%m %H:%M")
        s["minutes"][minute] += 1
        s["minutes_x"][minute] += not page
        s["ua"][m["ua"][:120]] += 1
        status = int(m["status"])
        s["status"][status] += 1
        if m["be"].endswith("<NOSRV>") or m["term"].startswith("PR") or status == 403:  # HAProxy's block, the app's
            s["turned_away"] += 1
            continue
        path, query = path_of(m["uri"])
        method = m["method"]
        s["kinds"][f"{method} {TRACK.sub('/api/tracks/<id>', path)}" if path.startswith("/api/") else "page/static"] += 1
        if status != 200:
            continue
        sound = SOUND.match(path)
        if sound and sound[1] not in samples:
            s["songs"].add(sound[1])
            s["sound_bytes"] += int(m["bytes"])
        if method == "POST" and path == "/api/tracks":
            s["added"] += 1
        elif path == "/api/search":
            s["searches"] += 1
        elif path == "/api/upload":
            s["uploads"] += 1
        elif method == "GET" and path == "/api/tracks" and "p=1" in query.split("&"):
            ts = t.timestamp()
            gap = ts - s["play_at"] if s["play_at"] is not None else PLAY_GAP_S + 1
            s["streak"] = s["streak"] + gap if gap <= PLAY_GAP_S else 0.0
            s["play_s"] += gap if gap <= PLAY_GAP_S else 0.0
            s["longest"] = max(s["longest"], s["streak"])
            s["play_at"] = ts

    if not n:
        sys.exit(f"no request lines read ({bad} lines did not parse)")
    span = [min(s["first"] for s in ips.values()), max(s["last"] for s in ips.values())]
    mb = lambda b: f"{b / 1e6:.1f} MB"  # noqa: E731
    hm = lambda x: f"{x / 3600:.1f} h" if x >= 3600 else f"{x / 60:.0f} min"  # noqa: E731

    def who(ip, s):
        ua = s["ua"].most_common(1)[0][0]
        return (f"{ip:16s} req {s['req']:6d} (page {100 * s['page'] / s['req']:3.0f}%) peak {max(s['minutes'].values()):4d}/min "
                f"added {s['added']:3d} songs {len(s['songs']):3d} ({mb(s['sound_bytes'])}) play {hm(s['play_s']):>7s} "
                f"longest {hm(s['longest']):>7s} {s['first']:%d/%m %H:%M}->{s['last']:%H:%M}  {ua[:70]}")

    served = {ip: s for ip, s in ips.items() if s["req"] > s["turned_away"]}
    print(f"{n} requests from {len(ips)} addresses, {span[0]:%d/%m %H:%M} to {span[1]:%d/%m %H:%M}"
          f"{f' ({bad} lines unread)' if bad else ''}")
    print(f"  sound of visitors' songs: {sum(len(s['songs']) for s in served.values())} song-fetches, "
          f"{mb(sum(s['sound_bytes'] for s in served.values()))}; turned away by HAProxy: "
          f"{sum(s['turned_away'] for s in ips.values())} requests from {sum(1 for s in ips.values() if s['turned_away'])} addresses")

    print("\n== taking songs (sound of many songs, little playing): songs whose sound it took, per minute played")
    taking = sorted(served.items(), key=lambda kv: -(len(kv[1]["songs"]) / (1 + kv[1]["play_s"] / 60)))
    for ip, s in [kv for kv in taking if len(kv[1]["songs"]) >= 5][:a.top]:
        print("  " + who(ip, s))

    print("\n== playing on (the longest stretches)")
    for ip, s in sorted(served.items(), key=lambda kv: -kv[1]["longest"])[:a.top]:
        if s["longest"] >= 600:
            print("  " + who(ip, s))

    print("\n== not a browser's page (user agents of requests the site's page did not make)")
    other = Counter()
    for s in served.values():
        if s["page"] < s["req"]:
            other[s["ua"].most_common(1)[0][0]] += s["req"] - s["page"]
    for ua, k in other.most_common(a.top):
        print(f"  {k:6d}  {ua[:110]}")

    print("\n== floods (busiest minutes; requests not from the page in brackets)")
    for ip, s in sorted(served.items(), key=lambda kv: -max(kv[1]["minutes"].values()))[:a.top]:
        minute, k = s["minutes"].most_common(1)[0]
        print(f"  {k:5d} ({s['minutes_x'][minute]:4d}) at {minute}  " + who(ip, s))

    print("\n== turned away (blocked at HAProxy or by the app) and still knocking")
    for ip, s in sorted(((ip, s) for ip, s in ips.items() if s["turned_away"]), key=lambda kv: -kv[1]["turned_away"])[:40]:
        kind = "a browser's page (a listener?)" if s["page"] >= 0.8 * s["req"] else "not the page"
        print(f"  {ip:16s} {s['turned_away']:5d} turned away, {kind}, {s['first']:%d/%m %H:%M}->{s['last']:%H:%M}  "
              f"{s['ua'].most_common(1)[0][0][:80]}")

    print("\n== embedded: the page inside another site's frame / API calls from another site's page (refused)")
    for (site, ip), k in framed.most_common(a.top):
        print(f"  {k:5d} framed       by {site:40s} (visitor {ip})")
    for (site, ip), k in foreign.most_common(a.top):
        print(f"  {k:5d} API call     from {site:38s} (visitor {ip})")
    if not framed and not foreign:
        print("  none")

    print("\n== arrived from (links on other sites that brought people to the page)")
    for site, k in arrived.most_common(a.top):
        print(f"  {k:5d}  {site}")
    if not arrived:
        print("  none seen yet (Sec-Fetch-Dest and Referer are logged since 29/10/2026)")


if __name__ == "__main__":
    main()

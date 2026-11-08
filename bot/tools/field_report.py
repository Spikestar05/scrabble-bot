#!/usr/bin/env python3
"""Live field report straight from maincloud (public SQL endpoint, no token).

  tools/field_report.py [--since MATCH_ID] [--last N] [--bots A,B]

* hot bots: win rate, current/max win streak, avg score over recent matches
* profile (for the hot bots + Astronaut): tiles won per quarter, money spent,
  winning bids by letter class, words/match, word length, play timing,
  final balance
* head-to-head vs Astronaut in shared matches
"""
import argparse, collections, json, statistics as st, urllib.request

URL = "https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql"
ME = "Astronaut"


def q(sql):
    r = urllib.request.urlopen(urllib.request.Request(URL, data=sql.encode(), method="POST"), timeout=120)
    d = json.loads(r.read())[0]
    cols = [e["name"]["some"] for e in d["schema"]["elements"]]
    return [dict(zip(cols, row)) for row in d["rows"]]


ap = argparse.ArgumentParser()
ap.add_argument("--since", type=int, default=0)
ap.add_argument("--last", type=int, default=300, help="recent matches when --since not given")
ap.add_argument("--bots", default="")
ap.add_argument("--top", type=int, default=6)
a = ap.parse_args()

since = a.since
if not since:
    hi = max(r["match_id"] for r in q("SELECT * FROM match_participant WHERE bot_id = 212"))
    since = hi - a.last
bots = {b["id"]: b["name"] for b in q("SELECT * FROM bot")}
ids = {v: k for k, v in bots.items()}
ms = q(f"SELECT * FROM match_state WHERE id > {since}")
ended = {m["id"] for m in ms if m["status"][0] == 2}
mp = collections.defaultdict(dict)
for p in q(f"SELECT * FROM match_participant WHERE match_id > {since}"):
    if p["match_id"] in ended:
        mp[p["match_id"]][p["bot_id"]] = p
ar = collections.defaultdict(list)
for x in q(f"SELECT * FROM auction_result WHERE match_id > {since}"):
    if x["match_id"] in ended:
        ar[x["match_id"]].append(x)
for l in ar.values():
    l.sort(key=lambda x: x["auction_id"])
wp = collections.defaultdict(list)
for w in q(f"SELECT * FROM word_play WHERE match_id > {since}"):
    if w["match_id"] in ended:
        wp[w["match_id"]].append(w)
tb = {t["auction_id"]: t["top_bid"] for t in q(f"SELECT * FROM auction_top_bid_archive WHERE match_id > {since}")}

# ---- hot bots
res = collections.defaultdict(list)  # bot -> [(match, won, score, place)]
for m in sorted(mp):
    ps = sorted(mp[m].values(), key=lambda p: -p["score"])
    for i, p in enumerate(ps):
        res[p["bot_id"]].append((m, p["score"] == ps[0]["score"], p["score"], 1 + sum(o["score"] > p["score"] for o in ps)))
rows = []
for b, r in res.items():
    if len(r) < 5:
        continue
    cur = mx = run = 0
    for _, w, _, _ in r:
        run = run + 1 if w else 0
        mx = max(mx, run)
    for _, w, _, _ in reversed(r):
        if not w:
            break
        cur += 1
    rows.append((sum(w for _, w, _, _ in r) / len(r), b, len(r), st.mean(s for *_, s, _ in r), st.mean(p for *_, p in r), cur, mx))
rows.sort(reverse=True)
print(f"matches {len(mp)} (ids > {since})")
print(f"{'bot':24s} {'n':>4s} {'win%':>5s} {'avg':>6s} {'place':>5s} {'streak':>6s} {'max':>4s}")
for wr, b, n, avg, pl, cur, mx in rows[:20]:
    print(f"{bots.get(b, b)[:24]:24s} {n:4d} {100*wr:5.1f} {avg:6.1f} {pl:5.2f} {cur:6d} {mx:4d}")
mine = [r for r in rows if bots.get(r[1]) == ME]
if mine:
    wr, b, n, avg, pl, cur, mx = mine[0]
    print(f"{ME:24s} {n:4d} {100*wr:5.1f} {avg:6.1f} {pl:5.2f} {cur:6d} {mx:4d}  (rank {rows.index(mine[0]) + 1}/{len(rows)})")

# ---- profiles
V, HI, MID = set("AEIOU"), set("JKQXZ"), set("BCFHMPVWY")
cls = lambda L: "V" if L in V else "H" if L in HI else "M" if L in MID else "C"
want = [x for x in a.bots.split(",") if x] or [bots[r[1]] for r in rows[: a.top]]
if ME not in want:
    want.append(ME)
print()
for name in want:
    b = ids.get(name)
    if b is None:
        continue
    games = [m for m in mp if b in mp[m]]
    if not games:
        continue
    q4 = collections.defaultdict(int)
    bid = collections.defaultdict(list)
    tiles = paid = 0
    wl, wr, fin = [], [], []
    for m in games:
        closes = [x["closed_at"][0] for x in ar[m]]
        nA = len(ar[m])
        for i, x in enumerate(ar[m]):
            if x["winner_bot_id"] == [0, b]:
                tiles += 1
                paid += x["paid"]
                q4[i * 4 // max(nA, 1)] += 1
                bid[cls(x["letter"])].append(tb.get(x["auction_id"], 0))
        for w in wp[m]:
            if w["bot_id"] == b:
                wl.append(len(w["word"]))
                wr.append(sum(1 for c in closes if c <= w["played_at"][0]))
        fin.append(mp[m][b]["balance"])
    n = len(games)
    print(f"== {name}: n={n} tiles {tiles/n:.1f} (by quarter {[round(q4[k]/n,1) for k in range(4)]}) spent {paid/n:.0f} "
          f"end bal {st.mean(fin):.0f}")
    print(f"   winning bid C/V/M/H: " + " ".join(f"{k}{st.mean(v):.0f}" for k, v in sorted(bid.items())) +
          f" | words/m {len(wl)/n:.1f} len {st.mean(wl) if wl else 0:.1f} " +
          f"| play round p25/50/75 {sorted(wr)[len(wr)//4] if wr else '-'}/{st.median(wr) if wr else '-'}/{sorted(wr)[3*len(wr)//4] if wr else '-'}")
    if name != ME and ids.get(ME) is not None:
        sh = [m for m in games if ids[ME] in mp[m]]
        if sh:
            beat = sum(mp[m][b]["score"] > mp[m][ids[ME]]["score"] for m in sh)
            print(f"   vs {ME}: {len(sh)} shared, they beat us {beat}, avg {st.mean(mp[m][b]['score'] for m in sh):.0f} vs {st.mean(mp[m][ids[ME]]['score'] for m in sh):.0f}")

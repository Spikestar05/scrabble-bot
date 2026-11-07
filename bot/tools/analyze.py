#!/usr/bin/env python3
"""Summarise live match logs (logs/match-*.json): placement, score, tiles won,
prices, words and when they were played. Usage: tools/analyze.py [N_recent]"""
import json, glob, os, sys, collections, statistics as st
here = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(os.path.join(here, "..", "..", "logs", "match-*.json")), key=lambda f: int(f.split("-")[-1][:-5]))
n = int(sys.argv[1]) if len(sys.argv) > 1 else len(files)
rows = []
for f in files[-n:]:
    d = json.load(open(f))
    me = "Astronaut"
    a = d["auctions"]
    idx = {x["id"]: i for i, x in enumerate(a)}
    won = [x for x in a if x["winner"] == me]
    others = collections.Counter(x["winner"] for x in a if x["winner"] and x["winner"] != me)
    top = d["scores"][0]
    rows.append(d)
    print(f"{d['matchId']} place {d['placement']} score {d['myScore']:3d} (top {top['bot']} {top['score']}) won {len(won):2d} paid {sum(x['paid'] for x in won):3d} "
          f"mktPaid {st.mean(x['paid'] for x in a if x['winner']):.1f} words {[w['word'] for w in d['myWords']]} left {d['myLeftover']} maxms {d['maxDecisionMs']:.0f}")
if rows:
    print("N", len(rows), "mean place", round(st.mean(r["placement"] for r in rows), 2), "mean score", round(st.mean(r["myScore"] for r in rows), 1),
          "wins", sum(r["placement"] == 1 for r in rows))

#!/usr/bin/env python3
"""Joint random search over Brain params (sim field given). Prints configs sorted
by mean place. Usage: sim/search.py N_CONFIGS GAMES FIELD [seed]"""
import json, random, subprocess, sys
n, games, field = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
rnd = random.Random(int(sys.argv[4]) if len(sys.argv) > 4 else 7)
space = {
    "lambda0": lambda: round(rnd.uniform(0.45, 0.8), 2),
    "lambdaGamma": lambda: round(rnd.uniform(0.3, 0.8), 2),
    "horizon": lambda: rnd.choice([6, 8, 10]),
    "q": lambda: round(rnd.uniform(0.6, 1.0), 2),
    "residual": lambda: round(rnd.uniform(0.15, 0.45), 2),
    "floorFrac": lambda: round(rnd.uniform(0.85, 1.1), 2),
    "floorReserve": lambda: rnd.choice([10, 20, 30]),
    "endUsable": lambda: rnd.choice([10, 15, 20]),
    "playBonus": lambda: round(rnd.uniform(0, 0.4), 2),
    "priceScale": lambda: round(rnd.uniform(0.85, 1.15), 2),
    "hoardFront": lambda: rnd.choice([0, 0.7, 0.8]),
}
res = []
import os
base = json.loads(os.environ.get("SEARCH_BASE", "{}"))
if base:
    def jitter():
        c = dict(base)
        for k in rnd.sample(list(space), 3):  # perturb 3 params at a time
            c[k] = space[k]()
        return c
    cfgs = [{}] + [jitter() for _ in range(n)]
else:
    cfgs = [{}] + [{k: f() for k, f in space.items()} for _ in range(n)]
for i, cfg in enumerate(cfgs):
    out = subprocess.run(["npx", "tsx", "sim/par.ts", "--games", str(games), "--procs", "3", "--field", field, "--a", json.dumps(cfg)],
                         capture_output=True, text=True).stdout.strip().split("\n")[-1]
    d = json.loads(out)
    res.append((d["meanPlace"], -d["meanScore"], d["winRate"], cfg))
    print(f"{i:2d} place {d['meanPlace']:.2f} score {d['meanScore']:.1f} win {d['winRate']:.2f} {json.dumps(cfg)}", flush=True)
print("\n== best")
for p, s, w, cfg in sorted(res, key=lambda r: (r[0], r[1]))[:6]:
    print(f"place {p:.2f} score {-s:.1f} win {w:.2f} {json.dumps(cfg)}")

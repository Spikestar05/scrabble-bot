#!/bin/bash
# usage: sim/sweep.sh GAMES FIELD 'json1' 'json2' ...   (env B='{...}' sets the B-field params)
cd "$(dirname "$0")/.."
G=$1; F=$2; shift 2
for a in "$@"; do npx tsx sim/par.ts --games $G --procs ${P:-4} --field $F --a "$a" --b "${B:-{\}}" | CFG="$a" python3 -c "
import json,sys,os; d=json.load(sys.stdin)
print(f\"{d['meanScore']:6.1f} win={d['winRate']:.3f} place={d['meanPlace']:.2f} oppBest={d['oppBest']:.1f} won={d['aWon']} paid={d['aPaid']} leftBal={d['aLeftBal']} leftT={d['aLeftTiles']} words={d['aWords']} len={d['aAvgLen']} avgPaid={d['avgPaid']} {d['secs']}s \", os.environ['CFG'], d['byName'])"; done

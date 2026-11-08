# ScrabbleBot running notes

## Environment / connectivity (2026-11-07)

- `https://maincloud.spacetimedb.com` is reachable from this cloud container over HTTPS
  **and** websocket (anonymous SDK connect + subscribe works; HTTP SQL endpoint
  `POST /v1/database/scrabblebot/sql` works too).
- Token received 2026-11-07 23:29 UTC; bot is **Astronaut** (id 212). Running live via
  `BOT_NAME=astronaut bot/run-live.sh` (token cached in gitignored `bot/.token-astronaut`).

## What the live field looks like (from ~11.6k recent matches pulled via SQL)

- Lobbies fill with **real bots** almost always now (sims rarely). Top: Bron, LUCENT,
  GodOfThudner, maverick-bot, StickBot, exzell...
- Real-only matches: prices paid ~11-13 per tile (top bids ~15), J/Q/X/Z ~16-21.
  Strong bots win ~14-16 tiles/match, spend ~180 (recycle word income), score 90-110,
  play ~4 words of avg length ~6.5. Winning score is usually 95-125.
- The last auction often gets no bid (its tile can never be played).

## Architecture

- `bot/src/dict.ts` — word index (count vectors + masks), optimal rack partition (B&B).
- `bot/src/engine.ts` — exact port of the module rules for offline play (tests in
  `engine.test.ts`).
- `bot/src/brain.ts` — strategy. Monte Carlo rack valuation; bid = marginal value / lambda.
- `bot/src/index.ts` — live client: per-match narrow subscriptions, bids on auction
  insert, words before bids, re-bid after rewards land, JSON logs in `logs/`.
- `bot/sim/` — offline tournaments (`npx tsx sim/par.ts --games N --field market|mixed|self`).

## Experiment log

| date | change | field | result |
|---|---|---|---|
| 11-07 | v0 MC valuation, lambda0 .6 | market x5 | A 66.5 vs M 57.8, win 29%, place 2.92 |
| 11-07 | MC horizon=10-15 (sample only next H auctions) | market | 78, win 45% |
| 11-07 | playBonus 0 (don't value cash-now) + lambdaGamma .5 | market | 91.7, win 59% |
| 11-07 | minPlayLen 7, horizon 8 | market | 99.4, win 72%, place 1.41 |
| 11-07 | **first live results**: avg ~85, place 3.3 — sim market field too weak | live | — |
| 11-07 | price prior from real-only matches (~1.6x old); new `live` sim field (3 perturbed brains + 2 market bots, avgPaid 12.8 ≈ live) | live | 81.5, win 21%, place 3.07 |
| 11-07 | priceScale .65/.8/1.2, playBonus .5, minPlayLen 6 | live | all within noise (76-84) |
| 11-07 | standing floor bid 0.4 / 0.6 / **0.8** x market price | live | 81.7 / 81.2 / **87.3 (win 33%)** |
| 11-08 | floor **1.0** / 1.0+dup-guard / 1.2+dup-guard / 1.0+spendDown | live | **91.8 (win 38%, place 2.19, 13.3 tiles)** / 87.7 / 82.0 / 87.9 |

## Live match log

First 14 matches (version 5a5b7ad+horizon8, old price prior): 1 win (146), mean place 3.29,
mean score 85. Winners score 100-165 and win 20-23 tiles, many at 2-10 coins during mid-game
lulls; we win ~10 tiles because we bid ~1 on tiles we don't specifically need.
-> testing a standing "floor" bid (fraction of market price).

### Study of the consistent winners (240 live matches, ids > 42900)

LexForge-1107 59% wins (avg 102), RackMaw 51% (99), Karppa 43%, GodOfThudner 42% (101), gas 34%.
Astronaut v1: 10.5% (85).

| | tiles rounds 1-17 | rounds 18-34 | first 7+ word (median round) | end balance |
|---|---|---|---|---|
| winners | 2.4-3.0 | 3.4-4.2 | ~35 | 9-15 |
| Astronaut v1 | 1.2 | 1.4 | ~51 | 35 |

Winners buy steadily from round 1 (winning bids ~15 commons/vowels, ~21 BCFHMPVWY,
~35 JKQXZ), cash a 7-letter word around round 35, reinvest and spend down to ~10.
We hoarded money early, overpaid late (winning bids 23 vs 16-19) and ended with 35 unspent.
`sim/opponents.ts ForgeBot` imitates their bidding (field `forge` / `top`).

### Versions live

- **v1** (until match 43154): old price prior, no floor. 21 matches: 1 win, mean place ~3.3.
- **v2** (43161-43192): real-bot price prior + floor bid 0.8x market price. 6 matches: places 2,4,4,?,3,2.
- **v3** (43198-43274): floor bid 1.0x market price. 12 matches: 2 wins, places
  2,1,2,3,3,3,5,1,5,4,4,3 (mean 3.0), mean score ~84. Loss 43260 (42 pts): the floor bid
  bought a Q for 17 late with no U, balance hit ~1, sat out the last 20 auctions.
- **v4** (from 43281): no floor bid on JKQXZ; floor never takes balance below 20.
- New strong opponents: N1gel (winner-style, first 7+ word ~round 32), Abhi-AuctionLab;
  Pegasus is a hoarder (8 tiles/match, ends with 68 coins).

### Head-to-head vs LexForge-1107 and N1gel (shared live matches, ids > 43030)

| | tiles | spent | words/match | avg len | median play round |
|---|---|---|---|---|---|
| LexForge | 14.6 | 198 | 3.4 | 5.6 | 48 |
| N1gel | 16.0 | 183 | 3.8 | 5.2 | 56 |
| Astronaut v3/v4 | 11.0 | 140-153 | 2.4-2.6 | 5.8-6.2 | 65 |

Same winning-bid levels, so we don't overpay: they cash 5-6 letter words mid-game and turn
the income into 4-5 more tiles. LexForge beat us in 6/7 shared matches (+31 avg).
The sim field under-rewards recycling, so this is A/B tested live.

- **v5** (from the match after 43289, restart 00:21 UTC): minPlayLen 5, playBonus 0.5,
  forcePlay 7 (cash any 7+ word at once). Sim profile: 13.5 tiles, 3.3 words, len 5.5,
  leftover 12 coins (v4: 11.8 tiles, 2.5 words, leftover 30).

## Cycle log (5 live matches -> stop -> analyse -> fix -> deploy)

**Cycle 1 — v5 (43302-43329):** places 3,2,4,4,3 (mean 3.2), mean score 77, 0 wins.
Tiles up (11-16) and 3-4 words/match, but words got short: ZINCS (Z at 2x), NEWEL,
DEFOG, QUANT. Score fell vs v3/v4 (~84). Sim agrees: v5 settings 62-66 vs v4 86.
Fix -> **v6**: revert to v4 word play (minPlayLen 7, forcePlay off) + playBonus 0.2
(sim-neutral 86.0 vs 86.5, but spends down like the winners: 13 tiles, 19 left vs 12/32).
Also: clean stop via `logs/STOP` (bot finishes its match, does not requeue, supervisor exits).
Sim note: minPlayLen 6 / playBonus .2 / q .5 are all flat (86.0-86.5) in the live field.

**Cycle 2 — v6 (45089-45113):** places 1,5,2,2,1 (mean 2.2), mean score 105, 2 wins
(169 vs LUCENT 140; 114). Losses: in the opening rounds we were the price setter —
dozens of tiles went to bots paying exactly our bid (I 9/9, C 17/17, R 10/10...).
Lbender/GodOfThudner/Bron took 14-18 tiles; ours 12-15.
Tested: +2/+3 coins on the early standing bid -> sim 70-76 (worse; not deployed).
mc 48 samples -> 89.8 vs 86.0 (win 36% vs 26%). Two-word MC plans: no gain.
User idea — endgame mode (last N usable auctions: cash shorter words, plan only short
targets): sim 90.0-90.4 vs 90.3 (flat), win 40.1% vs 38.8%, place 2.19 vs 2.27,
less money wasted (14.9 vs 17.9). Kept.
Fix -> **v7**: mc 48 + endgame mode (endUsable 15, endMinPlay 4, endMaxTarget 7).

**Cycle 3 — v7 (45216-45244):** places 2,2,3,1,1 (mean **1.8**), mean score 105, 2 wins
(138, 110), never below 3rd. Losses to LexForge-Base-v1 (122, new, 57% win, 5-streak),
Lexicoin (124) and LexForge-1107 (102, 6-streak).
Every loss: 11-20 first-half auctions where the winner paid exactly our bid. Archive top
bids over the last 15 matches (290 such auctions): winner's bid = ours in 42 (lost the
random tie-break), +1 in 65, +2 in 43 -> ~10 tiles/match lost by <= 2 coins.
Sim opponents don't cluster around our bid, so sim says +2/+3 hurts; testing live instead.
Fix -> **v8**: floorAdd 1 (standing bid +1 coin while > 34 usable auctions remain).

**Cycle 4 — v8 (45266-45295):** places 3,2,5,3,4 (mean 3.4), mean score 76, 0 wins.
+1 coin did not buy more tiles (8-17) — it mostly raised what we paid; sim had predicted
floorAdd hurts. Clearly worse than v7 (1.8 / 105).
Fix -> **v9 = v7** (floorAdd 0). Lesson: the 'priced out by 1-2 coins' auctions are
mostly tiles we are better off not buying at that price.

**Cycle 5 — v9 (=v7) (45307-45336):** places 3,1,1,5,1 (mean 2.2), mean score 93, 3 wins
(132, 120, 3-way tie at 84). v7/v9 over 10 live matches: 5 wins, mean place 2.0.
Losses were expensive games (avg price 13.4-14 vs ~11 in wins, only 10 tiles).
Profile: we now match winners on tiles (14.4), spend, words, end balance — but buy
early (Q1-Q4: 4.2/4.8/3.6/1.8) while GodOfThudner buys 1.8/2.9/3.9/4.8.
Tested pacing reserve (floorPace 1/1.5/2.5 x usable): 88.9/87.6/87.3 vs 89.1 — worse.
-> **v9 unchanged** for cycle 6.

### LexForge-Base-v1 deep profile (31 matches; `tools/bot_profile.py`)

| | LexForge-Base-v1 | Astronaut |
|---|---|---|
| tiles/match | 14.3 | 14.1 |
| avg 7+ word reward | **49.0** | 38.9 |
| avg 5-6 word reward | 28.1 | 21.4 |
| JKQXZ tiles won / match | **1.3** | 0.4 |
| bid on tile that completes a word | 20.4 | 15.3 |
| bid on vowels / common consonants | 14.8 / 14.8 | 12.2 / 13.8 |
| bid by face value 1/2/3/4/5/8/10 | 15/17/19/22/27/34/40 | 13/16/20/23/22/37/43 |

Same tile count; LexForge's words are worth ~25% more because it buys high-value letters
(BRITZKA 66, QUALIFY 66, ENZYMIC 69) and pays up for completing tiles. 97% of its bought
tiles end up in words. Testing: floor back on JKQXZ (with reserve), highBoost 1.3/1.6.

**Cycle 6 — v9 (45369-45403):** places 5,2,2,2,2 (mean 2.6), mean score 76, 0 wins; four
close 2nds (by 3/6/7/26). Expensive games (avg price 12.5-13.8). Tied LexForge-Base-v1 (78).
Sim: floor back on JKQXZ 91.1 / highBoost 1.3 90.6 / 1.6 90.9 / both 91.4 vs v9 89.1
(win 40-42% vs 43% — neutral; sim opponents don't fight for rare letters).
Fix -> **v10**: highBoost 1.3 + standing bid on JKQXZ again (20-coin reserve kept).
Watch: JKQXZ tiles/match (was 0.4) and avg 7+ word reward (was 38.9; LexForge 49).

**Cycle 7 — v10 (45466-45498):** places 1,3,3,2,5 (mean 2.8), mean score 88, 1 win (127).
7+ word avg reward rose to **45** (v9 39, LexForge 49): FIXATIVE 63, HEXADIC 60, BEEZERS 54.
JKQXZ won in 3/5 matches. But vs LexForge-Base-v1 (60 vs 115) we paid **53 for a Q**
(QUANTAL 48) and got only 8 tiles — the boost had no ceiling.
Fix -> **v11**: v10 + bid cap 1.8x the letter's market price (until the last 3 auctions).

**Cycle 8 — v11 (45521-45553):** places 2,6,6,2,3 (mean **3.8**), mean score 75, 0 wins.
Bought Z40, X28, X33, K27 but spent them in short words (NAZIFY, BEAUX, KYLIX: no 3x),
so only 7-9 tiles. Chasing rare letters only pays if the 7-letter word follows; it doesn't
for us. Scoreboard: v7/v9 mean place 2.2 over 15 matches; v10 2.8; v11 3.8.
Fix -> **v12 = v9 letter policy** (highBoost 1, no standing bid on JKQXZ) + keep v11's
bid cap (1.8x market price) as a safety rail.

**Cycle 9 — v12 (45571-45605):** places 4,1,3,2,1 (mean 2.2), mean score 93, 2 wins (91, 135).
v7/v9/v12 family: 20 live matches, 7 wins, mean place 2.2. New: LexForge-Reveal-v1 (beat it 2/3).
Expensive-game analysis (45 matches): avg price 10-12.5 -> place 2.07, 16.3 tiles, 6/15 wins;
13.5-14.4 -> place 3.27, 11.5 tiles. End balance the same (~18), so not hoarding: fewer
tiles -> less income -> compounding. Tested lambdaPriceAdj 0.5/1 (bid up with market
level): 87.2/86.6 vs 89.6 — worse. mc 64/96: 87.3/87.2 — worse. v12 unchanged for cycle 10.

**Cycle 10 — v12 (45633-45676):** places 1,4,1,2,2 (mean 2.0), mean score 89, 2 wins —
beat LexForge-Cash-v1 (newest LexForge, field-leading 60% win). v12 family: 25 matches,
9 wins, mean place ~2.1. Rating 1345, mu 42.9 (from 33), sigma 3.6, 102 matches, 18 wins.
Pegasus v2 profile: hoards early (median bid 10-13 in rounds 18-51), buys 49 of its 90 tiles
in rounds 52-68 at ~23, 7+ words in rounds 48-63 (avg 45).
New sim field `live2` adds a Pegasus-like late buyer (lambda0 1.3, lambdaGamma 2, no floor):
it outscores us there (81 vs 83). Counters tested (floorPace 1, reserve 35, lambdaGamma 1,
endUsable 20): 82.7-84.3 vs 83.4 — all noise. Spending later cuts P by 5 but doesn't help us.
-> v12 unchanged for cycle 11.

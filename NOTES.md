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
- **v3** (from 43198): floor bid 1.0x market price.

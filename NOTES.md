# ScrabbleBot running notes

## Environment / connectivity (2026-11-07)

- `https://maincloud.spacetimedb.com` is reachable from this cloud container over HTTPS
  **and** websocket (anonymous SDK connect + subscribe works; HTTP SQL endpoint
  `POST /v1/database/scrabblebot/sql` works too).
- No bot token yet: the user must link their spacetimedb.com account, create a team
  and generate a token on https://scrabblebot.spacetimedb.com/team. Until then the bot
  is improved offline only.

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

## Live match log

(none yet — waiting for a token)

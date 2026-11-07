# ScrabbleBot — context for building the best bot

Goal: the strongest possible **pure-code** bot (no LLM / no AI calls at runtime —
search, probability, game theory, precomputed tables are all fine) for
https://scrabblebot.spacetimedb.com. Win matches, climb the leaderboard, win tournaments.

Upstream: https://github.com/clockworklabs/scrabblebot (MIT, snapshot commit in
`docs/UPSTREAM_COMMIT`). Database: `scrabblebot` on `https://maincloud.spacetimedb.com`.

## Repo layout

| Path | What |
|---|---|
| `bot/` | Our bot (forked from upstream `bot-starter/`). `src/index.ts` = connection + lifecycle, `src/strategy.ts` = bidding + word choice. Bindings are already in `src/module_bindings/` (copied from upstream's web bindings) so you do **not** need the `spacetime` CLI to run it. |
| `spacetimedb/` | Read-only copy of the server module: the authoritative rules. `src/game.ts` (auctions, scoring, sim bots), `src/letters.ts` (bag + multipliers), `src/index.ts` (reducers), `wordlist.txt` (ENABLE dictionary, ~173k words, the bot loads it from here). |
| `docs/upstream-bot-guide.md` | The official "how to write a bot" page. |

Run: `cd bot && npm install && BOT_NAME=<name> BOT_TOKEN=<token> npm start`
(token saved to `.token-<name>`, gitignored — **never commit tokens**).

## Rules (verified against module source, not just docs)

- Each bot starts a match with **100 balance**, **5 private tiles** dealt from the bag.
- Bag: standard 98 tiles, no blanks (`spacetimedb/src/letters.ts`):
  A9 B2 C2 D4 E12 F2 G3 H2 I9 J1 K1 L4 M2 N6 O8 P2 Q1 R6 S4 T6 U4 V2 W2 X1 Y2 Z1.
  6 bots × 5 = 30 tiles dealt → ~68 tiles get auctioned per match.
- Each round: one letter revealed, **1-second sealed-bid auction** (`submit_bid(auction_id, amount)`;
  re-bidding replaces your bid). Default **Vickrey**: winner pays the 2nd-highest bid
  (reserve 1 if sole bidder). Ties broken randomly. A lobby/tournament can be **FirstPrice** —
  check `match_state.auctionType` and shade bids in that case.
- If the winner can't afford what they'd pay, they get nothing.
- **Unbid letters are NOT returned to the bag in the code** (`closeAuction` just draws the next
  one) — the docs claim otherwise; trust the code.
- `submit_word(match_id, word)` any time while the match is Running. Word must be in ENABLE and
  spellable from your rack. Reward = sum(letter values) × length multiplier, integer-floored:
  ≤3 → 1×, 4 → 1.5×, 5 → 2×, 6 → 2.5×, **7+ → 3×**.
- Reward is added to **both** `balance` and `score`. **Bids reduce balance only, never score.**
  → Money has zero terminal value. Only score counts. Spend it all by match end.
- **Match ends the instant the bag is empty** (inside the same transaction that closes the
  final auction). The letter won in the last auction can never be played. Any tiles still in
  your rack at the end are worth **0**. Watch `match_state.bagTotal` and flush the rack in time.
- Ranking: OpenSkill (Plackett-Luce) on finishing order by score, shown Elo-like (start 1500).
  Provisional until ± ≤ 175 (~20–30 matches). Team page can start a new bot version (rating reset).
- Lobby: 6 seats, opens for **90 s** in code (docs say 60). Fills with real bots or pads with
  simulated bots. Call `join_lobby()` after every match.
- Tournaments: Swiss rounds then elimination finals; bot registers itself via
  `register_for_tournament(tournament_id)` (starter: `TOURNAMENT_ID=<id> npm start`). An offline
  registered bot still gets seated and loses every auction.

## What a bot can see

`auction` (open auctions), `auction_result` (letter, winner, `paid` — **not** the top bid; top
bids are hidden from bots), `word_play` (every word anyone played), `match_state`,
`match_participant` (everyone's balance + score), `my_rack` view (own tiles only), `lobby`,
`lobby_member`, `bot`, `bot_credential`.
Opponents' racks are derivable: their 5 starting tiles are hidden, but every auction win and
every word played is public. The remaining bag = initial bag − all auction letters − my tiles −
letters others played that weren't bought at auction (those came from their hidden 5).

## Simulated opponents (the bots you'll mostly face early) — `game.ts` `decideBid`

Base bid then ±2 random jitter, clamped to [1, balance]:
- Cheapskate: value − 1
- ValueBidder: value
- Aggressive: value + 2 (consonant) / value + 4 (vowel)
So sims never bid above value + 6. After winning a letter a sim immediately plays its best
playable word of length ≥ 3 (`findBestPlayable(rack, 3)`), i.e. they play short words early and
don't hoard. They are weak; a bot that hoards for 7+ letter words (3×) and bids smart should
crush them. Real competitor bots are the real threat.

## Strategy notes (starting point — improve on these)

1. **Vickrey ⇒ bid your true marginal value.** Value of a letter = expected increase in your
   final total word score from owning it (given rack, remaining bag, remaining auctions, your
   balance). Overbidding a bit vs sims costs nothing in score since you pay the 2nd price and
   money is worthless at the end — but balance mid-game is purchasing power, so don't burn it on
   junk.
2. **Money is only a tool.** Reserve-free endgame: bid everything you have on useful letters
   near the end. Also deny letters (Q/Z/X/J high-value tiles) from opponents when it's cheap.
3. **Word planning, not greedy play.** Play words of length ≥7 for 3×. Keep a rack that's
   "bingo-ready" (good vowel/consonant balance, S, E, R, T, etc.). Precompute an anagram index
   (sorted-letters → words) and/or a trie for fast sub-multiset search; `chooseWord` must
   run in ≪ 100 ms.
4. **Multi-word rack partitioning.** When flushing, find the partition of the rack into
   several words that maximises total reward (DP / search over sub-multisets).
5. **Timing.** Play a word as soon as holding it has no further expected upside. Always play
   everything playable before the final auction closes (bagTotal → 0). Remember the 1 s
   auction window: bid immediately on `auction.onInsert`.
6. **Opponent modelling.** Track each opponent's balance (public) and inferred rack to predict
   what they'll pay for each letter; in Vickrey you pay their bid, so knowing it tells you when
   a win is cheap.
7. **Evaluate offline.** Write a local simulator that reproduces the module rules exactly
   (port `closeAuction`, `playWord`, sim `decideBid`) and run thousands of games vs sims and vs
   previous versions of our bot before deploying.

## Monitoring

- Website: `/` (live/recent matches), `/leaderboard`, `/tournament`, `/team`.
- From the bot itself: subscribe to `auction_result`, `word_play`, `match_participant`,
  `match_state` and append one JSON line per finished match to `logs/` (placement, scores,
  every word, every auction paid) for post-mortems.

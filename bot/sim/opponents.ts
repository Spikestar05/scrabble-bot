// Opponent models for offline evaluation (the module's own sims live in
// engine.ts). MarketBot imitates the mid-tier live competitors: bids
// around the observed live price (with per-bot aggression + noise), plays
// any word of length >= minLen at once, flushes at the end.
import { A, Dictionary, VALUE } from "../src/dict.js";
import type { Observation, Policy } from "../src/engine.js";
import { PRICE_PRIOR } from "../src/brain.js";

export class MarketBot implements Policy {
  name = "market";
  constructor(
    private dict: Dictionary,
    private rng: () => number,
    private aggression = 1.0,
    private minLen = 6,
  ) {}
  act(obs: Observation) {
    const R = new Int8Array(obs.rack);
    const words: string[] = [];
    if (obs.bagTotal === 0) {
      return { words: this.dict.partition(R, 2, performance.now() + 100).words, bid: 0 };
    }
    // play best long word available
    for (let g = 0; g < 3; g++) {
      const p = this.dict.playable(R, this.minLen);
      if (!p.length) break;
      p.sort((a, b) => this.dict.rew[b]! - this.dict.rew[a]!);
      const w = this.dict.words[p[0]!]!;
      words.push(w);
      for (let i = 0; i < w.length; i++) R[w.charCodeAt(i) - A]!--;
    }
    const l = obs.letter.charCodeAt(0) - A;
    const bal = obs.balances[obs.seat]!;
    const late = obs.bagTotal < 4 ? 0.2 : 1;
    // more money later -> higher bids; noise
    const base = PRICE_PRIOR[l]! * 1.35 * this.aggression * (0.6 + 0.8 * this.rng());
    const have = R[l]!;
    const dup = have >= 2 ? 0.4 : have === 1 && VALUE[l]! >= 4 ? 0.3 : 1;
    let bid = Math.floor(base * dup * late);
    if (obs.bagTotal < 12) bid = Math.floor(bid + bal / (obs.bagTotal + 2));
    return { words, bid: Math.max(0, Math.min(bid, bal)) };
  }
}

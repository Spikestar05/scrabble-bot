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
    const base = PRICE_PRIOR[l]! * this.aggression * (0.55 + 0.7 * this.rng());
    const have = R[l]!;
    const dup = have >= 2 ? 0.4 : have === 1 && VALUE[l]! >= 4 ? 0.3 : 1;
    let bid = Math.floor(base * dup * late);
    if (obs.bagTotal < 12) bid = Math.floor(bid + bal / (obs.bagTotal + 2));
    return { words, bid: Math.max(0, Math.min(bid, bal)) };
  }
}

// ForgeBot: modelled on the consistent live winners (LexForge-1107, RackMaw,
// GodOfThudner, gas; see NOTES.md). Steady buyer from round 1: bids ~15 on
// commons/vowels, ~21 on mid letters, ~35 on JKQXZ, scaled down as the rack
// fills with duplicates and up when the tile completes a 7+ word; cashes any
// 7+ word at once, flushes at the end, spends its balance down.
const CLASS_BID: number[] = (() => {
  const v: number[] = [];
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    v.push("JKQXZ".includes(ch) ? 33 : "BCFHMPVWY".includes(ch) ? 20 : 13.5);
  }
  return v;
})();
export class ForgeBot implements Policy {
  name = "forge";
  constructor(private dict: Dictionary, private rng: () => number, private scale = 1.0) {}
  act(obs: Observation) {
    const R = new Int8Array(obs.rack);
    const words: string[] = [];
    if (obs.bagTotal === 0) return { words: this.dict.partition(R, 2, performance.now() + 100).words, bid: 0 };
    for (let g = 0; g < 3; g++) {
      const p = this.dict.playable(R, 7);
      if (!p.length) break;
      p.sort((a, b) => this.dict.rew[b]! - this.dict.rew[a]!);
      const w = this.dict.words[p[0]!]!;
      words.push(w);
      for (let i = 0; i < w.length; i++) R[w.charCodeAt(i) - A]!--;
    }
    const l = obs.letter.charCodeAt(0) - A;
    const bal = obs.balances[obs.seat]!;
    let bid = CLASS_BID[l]! * this.scale * (0.6 + 0.55 * this.rng());
    const have = R[l]!;
    if (have >= 2) bid *= 0.5;
    else if (have === 1 && "AEIOU".includes(obs.letter) === false) bid *= 0.8;
    R[l]!++;
    if (this.dict.playable(R, 7).length) bid *= 1.6;
    // spend down: never hoard more than needed for the rest of the game
    const usable = Math.max(1, obs.bagTotal - 1);
    if (bal > usable * 15) bid = Math.max(bid, bal / usable);
    if (obs.bagTotal <= 1) bid = 0;
    return { words, bid: Math.max(0, Math.min(Math.floor(bid), bal)) };
  }
}

// The bot's decision core (pure code, no I/O). Same class drives the live bot
// (src/index.ts adapts SpacetimeDB rows into an Observation) and the offline
// simulator.
//
// Model
// -----
// * Tracker: from the public log, the unseen pool U (bag + opponents' hidden
//   starting tiles), each opponent's known tiles, and market prices.
// * Plan value V(R): for rack R, look at target words W (len >= 4) that are
//   at most `maxMissing` tiles away. A target's worth is
//     P(complete) * reward(W) - lambda * E[cost of the missing tiles]
//   where P(complete) is a product of binomial tails over the expected
//   future copies of each missing letter. V(R) is the best pair of
//   tile-disjoint targets plus a small residual value for spare tiles.
// * lambda: shadow value of one unit of money in points. Money only buys
//   tiles, so lambda falls to 0 as the game ends.
// * Bid (Vickrey) = (V(R+L) - V(R)) / lambda, capped at balance. FirstPrice:
//   shade to the expected clearing price.
// * Words: play W when reward(W)*(1+lambda) + V(R-W) beats holding. Flush
//   the whole rack (optimal partition) before the final auction closes.

import {
  A,
  BAG,
  Dictionary,
  LETTERS,
  VALUE,
  countsToString,
} from "./dict.js";
import type { GameEvent, Observation, Policy } from "./engine.js";

export interface Params {
  lambda0: number; // money->points rate at game start
  lambdaGamma: number; // decay exponent over remaining usable auctions
  lambdaMin: number;
  q: number; // chance we win a given future copy at market price
  maxMissing: number;
  residual: number; // points per face-value of tiles not in the plan
  secondWeight: number; // weight of the second target word
  costFactor: number; // multiplier on expected purchase cost
  playBonus: number; // multiplier on lambda for money gained by playing now
  minPlayLen: number; // min word length to play before the flush
  topK: number;
  priceScale: number; // multiplier on market price prior
  bidCapFrac: number; // max fraction of balance on one tile (pre-endgame)
  denyWeight: number;
  mc: number; // Monte Carlo samples (0 = plan model)
  minTargetLen: number;
  maxTargetLen: number;
  budgetTiles: number; // cap on tiles we expect to buy (x balance/price)
  playEval: number; // playable words evaluated per decision
  oppCap: number; // 1 = cap sampled prices at the richest opponent's balance
  floorFrac: number; // standing bid as a fraction of the letter's market price
  floorMinBal: number; // only when balance is at least this
  floorMaxHave: number; // no floor bid if we already hold this many of the letter
  spendDown: number; // >0: if balance exceeds usable*spendDown, bid at least balance/usable
  horizon: number; // future auctions visible to one MC sample (0 = whole game)
  mcWords: number; // words per MC plan (1 or 2)
  reinvest: number; // fraction of word reward usable as budget for word 2
  priceSigma: number; // lognormal spread of sampled clearing prices
  lambdaBeta: number; // scarcity exponent: lambda grows as balance shrinks
  budgetRef: number; // money we expect to deploy per remaining-game fraction
}

export const DEFAULT_PARAMS: Params = {
  lambda0: 0.6,
  lambdaGamma: 0.5,
  lambdaMin: 0.03,
  q: 0.8,
  maxMissing: 3,
  residual: 0.3,
  secondWeight: 0.8,
  costFactor: 1.0,
  playBonus: 0,
  minPlayLen: 7,
  topK: 12,
  priceScale: 1.0,
  bidCapFrac: 1.0,
  denyWeight: 0,
  mc: 24,
  minTargetLen: 4,
  maxTargetLen: 9,
  budgetTiles: 1.0,
  playEval: 6,
  oppCap: 0,
  floorFrac: 0,
  floorMinBal: 40,
  floorMaxHave: 9,
  spendDown: 0,
  horizon: 8,
  mcWords: 1,
  reinvest: 0.5,
  priceSigma: 0.35,
  lambdaBeta: 0.5,
  budgetRef: 120,
};

// Mean price paid per letter in live real-bot-only matches (3135 matches,
// no sims seated), A..Z.
export const PRICE_PRIOR: number[] = [
  10.3, 15.9, 17.0, 13.8, 10.6, 18.7, 12.4, 19.9, 9.8, 27.5, 21.9, 10.4, 16.5,
  10.2, 9.5, 16.2, 27.2, 10.6, 11.6, 9.9, 9.7, 17.1, 17.9, 29.1, 19.8, 35.2,
];

// P(Binomial(n, p) >= m)
function binomTail(n: number, p: number, m: number): number {
  if (m <= 0) return 1;
  if (n < m) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // sum_{k<m} C(n,k) p^k (1-p)^(n-k)
  let term = Math.pow(1 - p, n);
  let cdf = term;
  for (let k = 1; k < m; k++) {
    term *= ((n - k + 1) / k) * (p / (1 - p));
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

export class Tracker {
  nSeats = 0;
  seat = 0;
  myStart: Int8Array | null = null;
  auctioned = new Int32Array(26);
  bought: Int32Array[] = [];
  played: Int32Array[] = [];
  processed = 0;
  priceRatioNum = 0;
  priceRatioDen = 0;
  paidLog: number[] = [];

  init(obs: Observation) {
    this.nSeats = obs.nSeats;
    this.seat = obs.seat;
    this.bought = Array.from({ length: obs.nSeats }, () => new Int32Array(26));
    this.played = Array.from({ length: obs.nSeats }, () => new Int32Array(26));
  }

  update(events: GameEvent[]) {
    for (; this.processed < events.length; this.processed++) {
      const e = events[this.processed]!;
      if (e.kind === "auction") {
        const l = e.letter.charCodeAt(0) - A;
        this.auctioned[l]!++;
        if (e.winner !== null && e.winner < this.nSeats) this.bought[e.winner]![l]!++;
        if (e.winner !== null && e.paid > 1) {
          // decayed running ratio of paid / prior
          this.priceRatioNum = this.priceRatioNum * 0.9 + e.paid / PRICE_PRIOR[l]!;
          this.priceRatioDen = this.priceRatioDen * 0.9 + 1;
        }
      } else {
        for (let i = 0; i < e.word.length; i++)
          this.played[e.seat]![e.word.charCodeAt(i) - A]!++;
      }
    }
  }

  priceRatio(): number {
    // shrink toward 1 with a pseudo-count
    return (this.priceRatioNum + 3) / (this.priceRatioDen + 3);
  }

  // Tiles of letter l an opponent still holds that we know about
  // (bought - played, floored at 0).
  oppKnown(s: number): Int32Array {
    const o = new Int32Array(26);
    for (let i = 0; i < 26; i++) o[i] = Math.max(0, this.bought[s]![i]! - this.played[s]![i]!);
    return o;
  }

  // Unseen pool: letters that are in the bag or in opponents' hidden tiles.
  // `current` = letter on auction now (already drawn, public).
  unseen(current: number): { U: Int32Array; hidden: number } {
    const U = new Int32Array(26);
    let hiddenRevealed = 0;
    for (let i = 0; i < 26; i++) {
      let revealed = 0;
      for (let s = 0; s < this.nSeats; s++) {
        if (s === this.seat) continue;
        revealed += Math.max(0, this.played[s]![i]! - this.bought[s]![i]!);
      }
      hiddenRevealed += revealed;
      U[i] = BAG[i]! - (this.myStart?.[i] ?? 0) - this.auctioned[i]! - revealed - (i === current ? 1 : 0);
      if (U[i]! < 0) U[i] = 0;
    }
    return { U, hidden: Math.max(0, 5 * (this.nSeats - 1) - hiddenRevealed) };
  }
}

interface Ctx {
  U: Int32Array;
  Utot: number;
  usable: number; // future auctions whose tile can still be played
  frac: number; // P(an unseen tile shows up in a usable future auction)
  price: number[]; // expected price per letter
  lambda: number;
}

// Word indices grouped by length, each group sorted by reward desc.
let BYLEN: Int32Array[] | null = null;
let BYLEN_DICT: Dictionary | null = null;
function getByLen(d: Dictionary): Int32Array[] {
  if (BYLEN && BYLEN_DICT === d) return BYLEN;
  const g: number[][] = Array.from({ length: 16 }, () => []);
  for (let i = 0; i < d.n; i++) if (d.len[i]! < 16) g[d.len[i]!]!.push(i);
  BYLEN = g.map((a) => Int32Array.from(a.sort((x, y) => d.rew[y]! - d.rew[x]!)));
  BYLEN_DICT = d;
  return BYLEN;
}

export class Brain implements Policy {
  name: string;
  p: Params;
  t = new Tracker();
  private started = false;
  // scratch
  private sc = new Int8Array(26);
  private cand: number[] = [];
  private lastObs: Observation | null = null;
  lastInfo: Record<string, unknown> = {};

  constructor(
    private dict: Dictionary,
    params: Partial<Params> = {},
    name = "brain",
  ) {
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.name = name;
    this.byLen = getByLen(dict);
  }
  private byLen: Int32Array[];

  // ---------- context ----------
  private ctx(obs: Observation, letter: number): Ctx {
    const { U } = this.t.unseen(letter);
    let Utot = 0;
    for (let i = 0; i < 26; i++) Utot += U[i]!;
    // Auctions after this one: obs.bagTotal. The very last can't be played.
    const usable = Math.max(0, obs.bagTotal - 1);
    const frac = Utot > 0 ? Math.min(1, usable / Utot) : 0;
    const ratio = this.t.priceRatio() * this.p.priceScale;
    let price = PRICE_PRIOR.map((x) => x * ratio);
    if (this.p.oppCap > 0) {
      let mx = 0;
      for (let s = 0; s < obs.nSeats; s++) if (s !== obs.seat) mx = Math.max(mx, obs.balances[s]!);
      price = price.map((x) => Math.max(1, Math.min(x, mx)));
    }
    const lambda = this.lambda(obs, usable);
    return { U, Utot, usable, frac, price, lambda };
  }

  lambda(obs: Observation, usable: number): number {
    const total = 98 - obs.nSeats * obs.startingRackSize - 1;
    const x = Math.max(0, Math.min(1, usable / Math.max(1, total)));
    const B = obs.balances[obs.seat]!;
    const scarcity = Math.pow((this.p.budgetRef * x + 20) / (B + 20), this.p.lambdaBeta);
    return Math.max(this.p.lambdaMin, this.p.lambda0 * Math.pow(x, this.p.lambdaGamma) * scarcity);
  }

  // Build candidate target list for superset rack S: words (len>=4) with at
  // most maxMissing missing tiles w.r.t. S, and missing tiles obtainable.
  private buildCand(S: Int8Array, c: Ctx) {
    const d = this.dict;
    const M = this.p.maxMissing;
    const out: number[] = [];
    const sc = this.sc;
    let tot = 0;
    for (let i = 0; i < 26; i++) tot += S[i]!;
    const maxLen = tot + Math.min(M, c.usable);
    for (let i = 0; i < d.n; i++) {
      const L = d.len[i]!;
      if (L < 4 || L > maxLen) continue;
      const s = d.off[i]!;
      const e = d.off[i + 1]!;
      let miss = 0;
      let j = s;
      for (; j < e; j++) {
        const l = d.letters[j]!;
        sc[l]!++;
        if (sc[l]! > S[l]!) {
          // needs an unseen copy too
          if (sc[l]! - S[l]! > c.U[l]!) {
            miss = 99;
            j++;
            break;
          }
          if (++miss > M) {
            j++;
            break;
          }
        }
      }
      for (let k = s; k < j; k++) sc[d.letters[k]!] = 0;
      if (miss <= M && miss <= c.usable) out.push(i);
    }
    this.cand = out;
  }

  // value of one target word for rack R; also returns used mask via sc
  private targetValue(i: number, R: Int8Array, c: Ctx): number {
    const d = this.dict;
    const s = d.off[i]!;
    const e = d.off[i + 1]!;
    const sc = this.sc;
    for (let j = s; j < e; j++) sc[d.letters[j]!]!++;
    let P = 1;
    let cost = 0;
    let miss = 0;
    for (let j = s; j < e; j++) {
      const l = d.letters[j]!;
      const need = sc[l]!;
      if (need === 0) continue; // already handled this letter
      sc[l] = 0;
      const m = need - R[l]!;
      if (m <= 0) continue;
      miss += m;
      P *= binomTail(c.U[l]!, c.frac * this.p.q, m);
      cost += m * c.price[l]!;
    }
    if (miss > this.p.maxMissing || miss > c.usable) return -1e9;
    if (miss === 0) return d.rew[i]!;
    return P * d.rew[i]! - c.lambda * this.p.costFactor * cost * (0.5 + 0.5 * P);
  }

  // V(R): best pair of disjoint targets + residual value for spare tiles.
  value(R: Int8Array, c: Ctx): number {
    if (this.p.mc > 0) return this.valueMC(R, c);
    const d = this.dict;
    const K = this.p.topK;
    // score all candidates for R
    const top: { i: number; v: number }[] = [];
    let worst = -1e9;
    for (const i of this.cand) {
      // quick skip: if word needs letters R lacks beyond budget, targetValue handles it
      const v = this.targetValue(i, R, c);
      if (v <= 0) continue;
      if (top.length < K) {
        top.push({ i, v });
        if (top.length === K) {
          top.sort((a, b) => b.v - a.v);
          worst = top[K - 1]!.v;
        }
      } else if (v > worst) {
        top[K - 1] = { i, v };
        top.sort((a, b) => b.v - a.v);
        worst = top[K - 1]!.v;
      }
    }
    top.sort((a, b) => b.v - a.v);
    let rv = 0;
    for (let l = 0; l < 26; l++) rv += R[l]! * VALUE[l]!;
    let best = this.p.residual * rv;
    if (top.length === 0) return best;
    const R2 = new Int8Array(26);
    const nFirst = Math.min(top.length, 4);
    for (let a = 0; a < nFirst; a++) {
      const { i, v } = top[a]!;
      // remove the tiles of W that R has
      R2.set(R);
      const s = d.off[i]!;
      const e = d.off[i + 1]!;
      for (let j = s; j < e; j++) {
        const l = d.letters[j]!;
        if (R2[l]! > 0) R2[l]!--;
      }
      let rv2 = 0;
      for (let l = 0; l < 26; l++) rv2 += R2[l]! * VALUE[l]!;
      // best second among top list
      let second = 0;
      for (let b = 0; b < top.length; b++) {
        if (b === a) continue;
        const v2 = this.targetValue(top[b]!.i, R2, c);
        if (v2 > second) second = v2;
      }
      const tot = v + this.p.secondWeight * second + this.p.residual * rv2 * 0.5;
      if (tot > best) best = tot;
    }
    return best;
  }

  // ---------- Monte Carlo valuation ----------
  // Samples of "tiles we might win later": each unseen tile is in a usable
  // future auction w.p. frac and we win it w.p. q. Same samples for every
  // rack evaluated in one decision (common random numbers).
  private samples: Int8Array[] = [];
  private sPrice: Float64Array[] = [];
  private budget = 100;
  private gauss(): number {
    const u = Math.max(1e-9, this.rand());
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  private seed = 12345;
  private rand(): number {
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private kMax = 7;
  private buildSamples(c: Ctx, balance: number) {
    const p = Math.min(1, c.frac * this.p.q);
    this.samples = [];
    this.sPrice = [];
    // flat list of unseen tiles for horizon sampling
    const flat: number[] = [];
    for (let l = 0; l < 26; l++) for (let j = 0; j < c.U[l]!; j++) flat.push(l);
    const H = this.p.horizon > 0 ? Math.min(this.p.horizon, c.usable) : 0;
    for (let k = 0; k < this.p.mc; k++) {
      const D = new Int8Array(26);
      if (H > 0) {
        // next H auctions: draw H of the unseen tiles (scaled by the chance
        // an unseen tile is in the bag), keep each with prob q
        const n = Math.min(flat.length, Math.round(H / Math.max(0.05, Math.min(1, c.frac * (c.Utot / Math.max(1, c.usable))))));
        for (let j = 0; j < n && j < flat.length; j++) {
          const r = j + Math.floor(this.rand() * (flat.length - j));
          const t = flat[r]!;
          flat[r] = flat[j]!;
          flat[j] = t;
          if (this.rand() < this.p.q * c.frac * (c.Utot / Math.max(1, c.usable))) D[t]!++;
        }
      } else {
        for (let l = 0; l < 26; l++) {
          const u = c.U[l]!;
          for (let j = 0; j < u; j++) if (this.rand() < p) D[l]!++;
        }
      }
      this.samples.push(D);
      const P = new Float64Array(26);
      for (let l = 0; l < 26; l++) P[l] = c.price[l]! * Math.exp(this.p.priceSigma * this.gauss() - 0.5 * this.p.priceSigma * this.p.priceSigma);
      this.sPrice.push(P);
    }
    this.budget = this.p.budgetTiles * balance + 5;
    let avgP = 0;
    for (let l = 0; l < 26; l++) avgP += c.price[l]!;
    avgP /= 26;
    this.kMax = Math.max(1, Math.min(c.usable, Math.floor(this.p.budgetTiles * (balance + 5) / Math.max(1, avgP))));
  }

  // Words eligible as MC targets, filtered against R + (union of samples).
  private mcCand: number[] = [];
  private keyT = 0;
  private buildMcCand(S: Int8Array) {
    const d = this.dict;
    const sup = new Int8Array(S);
    for (const D of this.samples) for (let l = 0; l < 26; l++) if (D[l]! + S[l]! > sup[l]!) sup[l] = D[l]! + S[l]!;
    let m = 0;
    for (let l = 0; l < 26; l++) if (sup[l]! > 0) m |= 1 << l;
    const out: number[] = [];
    const sc = this.sc;
    for (let i = 0; i < d.n; i++) {
      const L = d.len[i]!;
      if (L < this.p.minTargetLen || L > this.p.maxTargetLen) continue;
      if ((d.mask[i]! & ~m) !== 0) continue;
      if (d.fitsQuick(i, sup, sc)) out.push(i);
    }
    this.mcCand = out;
  }

  // Sort candidates by an upper bound on net value for racks of ~T tiles:
  // reward - lambda*minPrice*(len - T). valueMC breaks on this bound.
  private mcKey = new Float64Array(0);
  private sortMcCand(T: number, c: Ctx) {
    const d = this.dict;
    let pmin = Infinity;
    for (let l = 0; l < 26; l++) pmin = Math.min(pmin, c.price[l]!);
    const lam = c.lambda * this.p.costFactor * pmin;
    if (this.mcKey.length < d.n) this.mcKey = new Float64Array(d.n);
    const key = this.mcKey;
    for (const i of this.mcCand) key[i] = d.rew[i]! - lam * Math.max(0, d.len[i]! - T);
    this.mcCand.sort((a, b) => key[b]! - key[a]!);
    this.keyT = T;
  }

  private lenOrder: number[] = [];
  private lenPenalty = new Float64Array(16);
  private prepMC(T: number, c: Ctx) {
    let pmin = Infinity;
    for (let l = 0; l < 26; l++) pmin = Math.min(pmin, c.price[l]!);
    const a = c.lambda * this.p.costFactor * pmin;
    for (let L = 0; L < 16; L++) this.lenPenalty[L] = a * Math.max(0, L - T);
    const order: number[] = [];
    for (const L of [7, 8, 9, 10, 6, 5, 4, 11, 12])
      if (L >= this.p.minTargetLen && L <= this.p.maxTargetLen) order.push(L);
    this.lenOrder = order;
  }
  // Per-decision filtered copies of byLen (mask within R+samples superset).
  private fLen: Int32Array[] = [];
  private filterByLen(S: Int8Array) {
    const d = this.dict;
    const sup = new Int8Array(S);
    for (const D of this.samples) for (let l = 0; l < 26; l++) if (D[l]! + S[l]! > sup[l]!) sup[l] = D[l]! + S[l]!;
    let m = 0;
    for (let l = 0; l < 26; l++) if (sup[l]! > 0) m |= 1 << l;
    const sc = this.sc;
    this.fLen = this.byLen.map((list, L) => {
      if (L < this.p.minTargetLen || L > this.p.maxTargetLen) return new Int32Array(0);
      const out = new Int32Array(list.length);
      let k = 0;
      for (let x = 0; x < list.length; x++) {
        const i = list[x]!;
        if ((d.mask[i]! & ~m) !== 0) continue;
        if (!d.fitsQuick(i, sup, sc)) continue;
        out[k++] = i;
      }
      return out.subarray(0, k);
    });
  }

  // Best single target for rack R given sample D (tiles winnable at SP
  // prices) and money budget. Returns net value, face value of R tiles used,
  // word index and its purchase cost.
  private bw = { v: 0, used: 0, i: -1, cost: 0 };
  private bestWord(R: Int8Array, D: Int8Array, SP: Float64Array, budget: number, lam: number) {
    const d = this.dict;
    const sc = this.sc;
    let m = 0;
    for (let l = 0; l < 26; l++) if (R[l]! + D[l]! > 0) m |= 1 << l;
    let best = 0;
    let bestUsed = 0;
    let bestI = -1;
    let bestCost = 0;
    const kMax = this.kMax;
    for (const L of this.lenOrder) {
      const list = this.fLen[L]!;
      const pen = this.lenPenalty[L]!;
      for (let x = 0; x < list.length; x++) {
        const i = list[x]!;
        const rw = d.rew[i]!;
        if (rw - pen <= best) break;
        if ((d.mask[i]! & ~m) !== 0) continue;
        const s = d.off[i]!;
        const e = d.off[i + 1]!;
        let ok = true;
        let miss = 0;
        let cost = 0;
        let usedVal = 0;
        let j = s;
        for (; j < e; j++) {
          const l = d.letters[j]!;
          const k = ++sc[l]!;
          if (k > R[l]!) {
            cost += SP[l]!;
            if (k > R[l]! + D[l]! || ++miss > kMax || cost > budget) {
              ok = false;
              j++;
              break;
            }
          } else usedVal += VALUE[l]!;
        }
        for (let k = s; k < j; k++) sc[d.letters[k]!] = 0;
        if (!ok) continue;
        const v = rw - lam * cost;
        if (v > best) {
          best = v;
          bestUsed = usedVal;
          bestI = i;
          bestCost = cost;
        }
      }
    }
    this.bw.v = best;
    this.bw.used = bestUsed;
    this.bw.i = bestI;
    this.bw.cost = bestCost;
    return this.bw;
  }

  private R2 = new Int8Array(26);
  private D2 = new Int8Array(26);
  valueMC(R: Int8Array, c: Ctx): number {
    const d = this.dict;
    let rv = 0;
    for (let l = 0; l < 26; l++) rv += R[l]! * VALUE[l]!;
    let sum = 0;
    const lam = c.lambda * this.p.costFactor;
    for (let si = 0; si < this.samples.length; si++) {
      const D = this.samples[si]!;
      const SP = this.sPrice[si]!;
      const b1 = this.bestWord(R, D, SP, this.budget, lam);
      let v = b1.v;
      let used = b1.used;
      if (this.p.mcWords >= 2 && b1.i >= 0) {
        const R2 = this.R2;
        const D2 = this.D2;
        R2.set(R);
        D2.set(D);
        const s0 = d.off[b1.i]!;
        const e0 = d.off[b1.i + 1]!;
        for (let j = s0; j < e0; j++) {
          const l = d.letters[j]!;
          if (R2[l]! > 0) R2[l]!--;
          else D2[l]!--;
        }
        const budget2 = this.budget - b1.cost + this.p.reinvest * d.rew[b1.i]!;
        const v1 = b1.v;
        const u1 = b1.used;
        const b2 = this.bestWord(R2, D2, SP, budget2, lam);
        v = v1 + this.p.secondWeight * b2.v;
        used = u1 + b2.used;
      }
      sum += v + this.p.residual * (rv - used);
    }
    return sum / this.samples.length;
  }

  // Live client rebuilds the event list each call; start the tracker over.
  resetTracker() {
    this.t = new Tracker();
    this.started = false;
  }

  // ---------- Policy ----------
  act(obs: Observation): { words: string[]; bid: number } {
    if (!this.started) {
      this.t.init(obs);
      this.started = true;
    }
    this.t.update(obs.events);
    // Our starting tiles = rack now + what we played - what we bought.
    const st = new Int8Array(26);
    for (let i = 0; i < 26; i++)
      st[i] = Math.max(0, obs.rack[i]! + this.t.played[obs.seat]![i]! - this.t.bought[obs.seat]![i]!);
    this.t.myStart = st;
    this.lastObs = obs;
    const letter = obs.letter.charCodeAt(0) - A;
    const c = this.ctx(obs, letter);
    const R = new Int8Array(obs.rack);

    const words: string[] = [];
    // Final auction (bag empty): flush everything, bid nothing.
    if (obs.bagTotal === 0) {
      const part = this.dict.partition(R, 2, performance.now() + 250);
      return { words: part.words, bid: 0 };
    }

    // Candidates relative to superset R+L
    const S = new Int8Array(R);
    S[letter]!++;
    if (this.p.mc === 0) this.buildCand(S, c);
    if (this.p.mc > 0) {
      this.buildSamples(c, obs.balances[obs.seat]!);
      let T = 0;
      for (let l = 0; l < 26; l++) T += S[l]!;
      this.prepMC(T, c);
      this.filterByLen(S);
    }

    // ---- word plays ----
    for (let guard = 0; guard < 4; guard++) {
      const w = this.choosePlay(R, c);
      if (!w) break;
      words.push(w);
      for (let i = 0; i < w.length; i++) R[w.charCodeAt(i) - A]!--;
    }
    this.pendingR = R;
    const bid = this.bidFor(R, letter, c, obs.balances[obs.seat]!);
    this.pendingC = c;
    this.pendingLetter = letter;
    return { words, bid };
  }

  private pendingR: Int8Array | null = null;
  private pendingC: Ctx | null = null;
  private pendingLetter = 0;

  rebid(obs: Observation): number {
    if (!this.pendingR || !this.pendingC) return 0;
    const c = { ...this.pendingC, lambda: this.lambda(obs, this.pendingC.usable) };
    return this.bidFromDelta(this.lastDelta, this.pendingLetter, c, obs.balances[obs.seat]!);
  }
  private lastDelta = 0;

  bidFor(R: Int8Array, letter: number, c: Ctx, balance: number): number {
    if (c.usable < 0) return 0;
    const v0 = this.value(R, c);
    R[letter]!++;
    const v1 = this.value(R, c);
    R[letter]!--;
    const delta = v1 - v0;
    this.lastInfo = { v0, v1, delta, lambda: c.lambda };
    this.lastDelta = delta;
    return this.bidFromDelta(delta, letter, c, balance);
  }

  bidFromDelta(delta: number, letter: number, c: Ctx, balance: number): number {
    let bid = delta > 0 ? delta / c.lambda : 0;
    const have = this.pendingR ? this.pendingR[letter]! : 0;
    if (this.p.floorFrac > 0 && balance >= this.p.floorMinBal && c.usable > 2 && have < this.p.floorMaxHave)
      bid = Math.max(bid, this.p.floorFrac * c.price[letter]!);
    if (this.p.spendDown > 0 && c.usable > 0 && delta > 0 && balance > c.usable * this.p.spendDown)
      bid = Math.max(bid, balance / c.usable);
    if (bid <= 0) return 0;
    if (this.lastObs?.auctionType === "FirstPrice") {
      const exp = c.price[letter]! * 1.1 + 1;
      bid = Math.min(bid, exp);
    }
    const cap = c.usable > 6 ? balance * this.p.bidCapFrac : balance;
    return Math.max(0, Math.min(Math.floor(bid), Math.floor(cap)));
  }

  // Pick a word to play now, or null to hold.
  private choosePlay(R: Int8Array, c: Ctx): string | null {
    const d = this.dict;
    const playable = this.p.mc > 0 ? d.playable(R, this.p.minPlayLen) : d.playable(R, this.p.minPlayLen, this.cand);
    if (playable.length === 0) return null;
    playable.sort((a, b) => d.rew[b]! - d.rew[a]!);
    const hold = this.value(R, c);
    let bestGain = 0;
    let bestW: string | null = null;
    const R2 = new Int8Array(26);
    for (const i of playable.slice(0, this.p.playEval)) {
      R2.set(R);
      const s = d.off[i]!;
      const e = d.off[i + 1]!;
      for (let j = s; j < e; j++) R2[d.letters[j]!]!--;
      const g = d.rew[i]! * (1 + this.p.playBonus * c.lambda) + this.value(R2, c) - hold;
      if (g > bestGain) {
        bestGain = g;
        bestW = d.words[i]!;
      }
    }
    return bestW;
  }

  debugRack(R: Int8Array) {
    return countsToString(R);
  }
}

export { LETTERS };

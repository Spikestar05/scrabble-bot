// Exact offline port of the ScrabbleBot module's match rules
// (spacetimedb/src/game.ts): bag + draws, starting racks, sealed-bid
// auctions (Vickrey / FirstPrice, reserve, affordability, random ties),
// playWord scoring, match end the instant the bag empties, and the three
// simulated strategies (decideBid with +-2 jitter, findBestPlayable(rack, 3)
// right after a win).

import { BAG, Dictionary, LETTERS, VALUE, A, reward } from "./dict.js";

export type AuctionType = "Vickrey" | "FirstPrice";
export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";

// ---------- RNG (deterministic, seedable) ----------
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // inclusive range like ctx.random.integerInRange
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

// ---------- events visible to every bot ----------
export interface AuctionResultEv {
  kind: "auction";
  round: number;
  letter: string;
  winner: number | null; // seat
  paid: number;
  topBid: number; // hidden from bots in the real game; sim keeps it for analysis
}
export interface WordEv {
  kind: "word";
  seat: number;
  word: string;
  reward: number;
}
export type GameEvent = AuctionResultEv | WordEv;

// What a non-sim policy sees when an auction opens.
export interface Observation {
  seat: number;
  nSeats: number;
  auctionType: AuctionType;
  round: number; // 1-based
  letter: string; // up for auction now
  bagTotal: number; // tiles left in bag AFTER this letter was drawn (0 => last auction)
  rack: Int8Array; // my tiles (copy)
  balances: number[];
  scores: number[];
  events: GameEvent[]; // full public log so far
  startingRackSize: number;
}

export interface Policy {
  name: string;
  // Called when an auction opens. Return words to play now (in order) and a
  // bid for this auction. Words are applied first, then the bid is checked
  // against the new balance.
  act(obs: Observation): { words: string[]; bid: number };
  // Optional: called after the bot's words were applied, with the updated
  // observation, to revise the bid (the real bot re-bids once its reward
  // lands).
  rebid?(obs: Observation): number;
  onEnd?(obs: { scores: number[]; seat: number; events: GameEvent[] }): void;
}

export interface SeatSpec {
  sim?: SimStrategy;
  policy?: Policy;
  name: string;
}

export function simBid(
  strategy: SimStrategy,
  letter: string,
  balance: number,
  jitter: number,
): number {
  const c = letter.charCodeAt(0) - A;
  const value = VALUE[c]!;
  const isVowel = "AEIOU".includes(letter);
  let base: number;
  switch (strategy) {
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (isVowel ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

// Port of dictionary.ts findBestPlayable: longest playable word of length
// >= minLen; ties by lexicographic order.
export class SimWordFinder {
  private order: number[];
  constructor(private dict: Dictionary) {
    this.order = [...Array(dict.n).keys()].sort((a, b) => {
      const la = dict.len[a]!;
      const lb = dict.len[b]!;
      if (la !== lb) return lb - la;
      const wa = dict.words[a]!;
      const wb = dict.words[b]!;
      return wa < wb ? -1 : wa > wb ? 1 : 0;
    });
  }
  find(rack: Int8Array, minLen: number): string | undefined {
    let tot = 0;
    let rm = 0;
    for (let i = 0; i < 26; i++) {
      tot += rack[i]!;
      if (rack[i]! > 0) rm |= 1 << i;
    }
    if (tot < minLen) return undefined;
    const scratch = new Int8Array(26);
    const d = this.dict;
    for (const i of this.order) {
      const l = d.len[i]!;
      if (l < minLen) break;
      if (l > tot) continue;
      if ((d.mask[i]! & ~rm) !== 0) continue;
      if (d.fitsQuick(i, rack, scratch)) return d.words[i]!;
    }
    return undefined;
  }
}

export interface MatchResult {
  scores: number[];
  balances: number[];
  names: string[];
  events: GameEvent[];
  leftover: number[]; // tiles left in racks at the end
}

export class Match {
  bag = new Int32Array(26);
  bagTotal = 0;
  racks: Int8Array[];
  balances: number[];
  scores: number[];
  events: GameEvent[] = [];
  round = 0;

  constructor(
    private dict: Dictionary,
    private finder: SimWordFinder,
    private seats: SeatSpec[],
    private rng: Rng,
    private auctionType: AuctionType = "Vickrey",
    private startingRackSize = 5,
    private startingBalance = 100,
  ) {
    for (let i = 0; i < 26; i++) {
      this.bag[i] = BAG[i]!;
      this.bagTotal += BAG[i]!;
    }
    this.racks = seats.map(() => new Int8Array(26));
    this.balances = seats.map(() => startingBalance);
    this.scores = seats.map(() => 0);
  }

  // game.ts drawLetter: uniform index into letters sorted A..Z.
  draw(): number | undefined {
    if (this.bagTotal === 0) return undefined;
    let idx = this.rng.int(0, this.bagTotal - 1);
    for (let i = 0; i < 26; i++) {
      const rem = this.bag[i]!;
      if (rem <= 0) continue;
      if (idx < rem) {
        this.bag[i]!--;
        this.bagTotal--;
        return i;
      }
      idx -= rem;
    }
    return undefined;
  }

  // game.ts playWord (+ submitWord's dictionary/length checks).
  playWord(seat: number, word: string): boolean {
    if (word.length < 2 || !/^[A-Z]+$/.test(word) || !this.dict.has(word)) return false;
    const r = this.racks[seat]!;
    const need = new Int8Array(26);
    for (let i = 0; i < word.length; i++) need[word.charCodeAt(i) - A]!++;
    for (let i = 0; i < 26; i++) if (need[i]! > r[i]!) return false;
    let base = 0;
    for (let i = 0; i < 26; i++) {
      r[i]! -= need[i]!;
      base += need[i]! * VALUE[i]!;
    }
    const rw = reward(base, word.length);
    this.balances[seat]! += rw;
    this.scores[seat]! += rw;
    this.events.push({ kind: "word", seat, word, reward: rw });
    return true;
  }

  private obs(seat: number, letter: number): Observation {
    return {
      seat,
      nSeats: this.seats.length,
      auctionType: this.auctionType,
      round: this.round,
      letter: LETTERS[letter]!,
      bagTotal: this.bagTotal,
      rack: new Int8Array(this.racks[seat]!),
      balances: this.balances.slice(),
      scores: this.scores.slice(),
      events: this.events,
      startingRackSize: this.startingRackSize,
    };
  }

  run(): MatchResult {
    const n = this.seats.length;
    // startMatchWith: deal starting racks seat by seat.
    for (let s = 0; s < n; s++) {
      for (let k = 0; k < this.startingRackSize; k++) {
        const l = this.draw();
        if (l === undefined) break;
        this.racks[s]![l]!++;
      }
    }
    let letter = this.draw();
    while (letter !== undefined) {
      this.round++;
      const bids = new Array<number>(n).fill(0);
      // simulateBids at auction insert.
      for (let s = 0; s < n; s++) {
        const sim = this.seats[s]!.sim;
        if (!sim) continue;
        const jitter = this.rng.int(-2, 2);
        bids[s] = simBid(sim, LETTERS[letter]!, this.balances[s]!, jitter);
      }
      // Real bots act (play words, then bid).
      for (let s = 0; s < n; s++) {
        const pol = this.seats[s]!.policy;
        if (!pol) continue;
        const act = pol.act(this.obs(s, letter));
        let played = false;
        for (const w of act.words) played = this.playWord(s, w) || played;
        let bid = Math.floor(act.bid);
        if (played && pol.rebid) bid = Math.floor(pol.rebid(this.obs(s, letter)));
        // submitBid: non-negative, <= balance; else rejected (no bid).
        if (bid > 0 && bid <= this.balances[s]!) bids[s] = bid;
      }
      this.closeAuction(letter, bids);
      letter = this.draw();
    }
    const res: MatchResult = {
      scores: this.scores.slice(),
      balances: this.balances.slice(),
      names: this.seats.map((s) => s.name),
      events: this.events,
      leftover: this.racks.map((r) => r.reduce((a, b) => a + b, 0)),
    };
    for (let s = 0; s < n; s++)
      this.seats[s]!.policy?.onEnd?.({ scores: res.scores, seat: s, events: this.events });
    return res;
  }

  // game.ts closeAuction (minus drawing the next letter, done by run()).
  private closeAuction(letter: number, bids: number[]) {
    const sorted: { seat: number; amount: number }[] = [];
    for (let s = 0; s < bids.length; s++)
      if (bids[s]! > 0) sorted.push({ seat: s, amount: bids[s]! });
    // shuffle (Fisher-Yates) then stable sort desc
    for (let i = sorted.length - 1; i >= 1; i--) {
      const j = this.rng.int(0, i);
      [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
    }
    sorted.sort((a, b) => b.amount - a.amount);
    let winner: number | null = null;
    let paid = 0;
    let top = 0;
    const [first, second] = sorted;
    if (first) {
      winner = first.seat;
      top = first.amount;
      if (this.auctionType === "FirstPrice") paid = first.amount;
      else paid = second ? second.amount : Math.min(1, first.amount);
    }
    let gotIt = false;
    if (winner !== null && this.balances[winner]! >= paid) {
      this.balances[winner]! -= paid;
      this.racks[winner]![letter]!++;
      gotIt = true;
    }
    this.events.push({
      kind: "auction",
      round: this.round,
      letter: LETTERS[letter]!,
      winner,
      paid,
      topBid: top,
    });
    if (gotIt && winner !== null && this.seats[winner]!.sim) {
      const w = this.finder.find(this.racks[winner]!, 3);
      if (w) this.playWord(winner, w);
    }
  }
}

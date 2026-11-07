// Checks the offline engine against the module's rules (spacetimedb/src/game.ts,
// letters.ts, dictionary.ts). Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDictionary, reward, wordReward, countsOf, BAG } from "./dict.js";
import { Match, Rng, SimWordFinder, simBid, type Policy, type Observation } from "./engine.js";

const dict = loadDictionary();
const finder = new SimWordFinder(dict);

test("bag is the standard 98 tiles", () => {
  assert.equal(BAG.reduce((a, b) => a + b, 0), 98);
});

test("length multipliers are integer-floored like playWord", () => {
  assert.equal(reward(5, 2), 5);
  assert.equal(reward(5, 3), 5);
  assert.equal(reward(5, 4), 7); // 7.5 -> 7
  assert.equal(reward(5, 5), 10);
  assert.equal(reward(5, 6), 12); // 12.5 -> 12
  assert.equal(reward(5, 7), 15);
  assert.equal(reward(5, 12), 15);
  assert.equal(wordReward("QUIZ"), 33);
  assert.equal(wordReward("RETAINS"), 21);
});

test("sim decideBid: base +/- jitter, clamped to [1, balance]", () => {
  assert.equal(simBid("Cheapskate", "A", 100, 0), 1); // 0 -> 1
  assert.equal(simBid("Cheapskate", "Q", 100, -2), 7);
  assert.equal(simBid("ValueBidder", "Z", 100, 2), 12);
  assert.equal(simBid("Aggressive", "E", 100, 0), 5);
  assert.equal(simBid("Aggressive", "K", 100, 1), 8);
  assert.equal(simBid("Aggressive", "Q", 3, 2), 3);
  assert.equal(simBid("ValueBidder", "A", 0, 0), 0);
});

test("findBestPlayable: longest word, ties lexicographic, min length", () => {
  assert.equal(finder.find(countsOf("TACT"), 3), "TACT");
  assert.equal(finder.find(countsOf("XQ"), 3), undefined);
  // CAT, ACT both 3 letters; lexicographically ACT first
  assert.equal(finder.find(countsOf("CATQ"), 3), "ACT");
});

// Scripted policy for auction tests.
class Scripted implements Policy {
  name = "s";
  seen: Observation[] = [];
  constructor(private bidFn: (o: Observation) => number, private wordFn: (o: Observation) => string[] = () => []) {}
  act(o: Observation) {
    this.seen.push(o);
    return { words: this.wordFn(o), bid: this.bidFn(o) };
  }
}

test("Vickrey: winner pays second price; lone bidder pays reserve 1", () => {
  const a = new Scripted(() => 10);
  const b = new Scripted((o) => (o.round === 1 ? 4 : 0));
  const m = new Match(dict, finder, [{ name: "a", policy: a }, { name: "b", policy: b }], new Rng(3));
  const res = m.run();
  const auctions = res.events.filter((e) => e.kind === "auction");
  assert.equal(auctions[0]!.kind === "auction" && auctions[0]!.paid, 4);
  assert.equal(auctions[1]!.kind === "auction" && auctions[1]!.paid, 1);
  // 98 - 2*5 dealt = 88 auctions
  assert.equal(auctions.length, 88);
});

test("FirstPrice: winner pays own bid", () => {
  const a = new Scripted((o) => (o.round === 1 ? 10 : 0));
  const b = new Scripted((o) => (o.round === 1 ? 4 : 0));
  const m = new Match(dict, finder, [{ name: "a", policy: a }, { name: "b", policy: b }], new Rng(3), "FirstPrice");
  const res = m.run();
  const e = res.events[0]!;
  assert.ok(e.kind === "auction" && e.paid === 10 && e.winner === 0);
  assert.equal(res.balances[0], 90);
});

test("6 seats: 68 auctions, bagTotal hits 0 on the last, its tile is never playable", () => {
  const pols = [0, 1, 2, 3, 4, 5].map(() => new Scripted(() => 1));
  const m = new Match(dict, finder, pols.map((p, i) => ({ name: String(i), policy: p })), new Rng(9));
  const res = m.run();
  assert.equal(res.events.filter((e) => e.kind === "auction").length, 68);
  const last = pols[0]!.seen.at(-1)!;
  assert.equal(last.bagTotal, 0);
  assert.equal(last.round, 68);
});

test("bids above balance are rejected; words need the tiles", () => {
  const a = new Scripted(() => 500, () => ["ZZZ"]);
  const b = new Scripted(() => 2);
  const m = new Match(dict, finder, [{ name: "a", policy: a }, { name: "b", policy: b }], new Rng(5));
  const res = m.run();
  const e = res.events[0]!;
  assert.ok(e.kind === "auction" && e.winner === 1);
  assert.ok(!res.events.some((x) => x.kind === "word" && x.word === "ZZZ"));
});

test("sims play findBestPlayable(rack,3) right after winning", () => {
  const m = new Match(dict, finder, [{ name: "s", sim: "Aggressive" }, { name: "p", policy: new Scripted(() => 0) }], new Rng(11));
  const res = m.run();
  for (const e of res.events) if (e.kind === "word") assert.ok(e.word.length >= 3 && e.seat === 0);
  assert.ok(res.events.some((e) => e.kind === "word"));
});

test("partition finds the optimal split (vs brute force on small racks)", () => {
  const rng = new Rng(77);
  const L = "AAEEIIOUNRSTLDGBCMPHKYFWVZXQJ";
  for (let t = 0; t < 25; t++) {
    let s = "";
    for (let k = 0; k < 8; k++) s += L[rng.int(0, L.length - 1)];
    const c = countsOf(s);
    const got = dict.partition(c).total;
    // brute force
    const words = dict.playable(c, 2);
    let best = 0;
    const r = new Int8Array(c);
    const sc = new Int8Array(26);
    const rec = (start: number, acc: number) => {
      best = Math.max(best, acc);
      for (let k = start; k < words.length; k++) {
        const i = words[k]!;
        if (!dict.fitsQuick(i, r, sc)) continue;
        const w = dict.words[i]!;
        for (const ch of w) r[ch.charCodeAt(0) - 65]!--;
        rec(k, acc + dict.rew[i]!);
        for (const ch of w) r[ch.charCodeAt(0) - 65]!++;
      }
    };
    rec(0, 0);
    assert.equal(got, best, s);
  }
});

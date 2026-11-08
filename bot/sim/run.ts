// Offline tournament runner.
//   npx tsx sim/run.ts --games 200 --field mixed --a '{"lambda0":0.6}' --b '{}'
// Seats: our candidate "A" plays against a field. Reports A's mean score,
// win rate (shared top counts as win), mean placement.
import { loadDictionary } from "../src/dict.js";
import { Match, Rng, SimWordFinder, type SeatSpec, type AuctionType } from "../src/engine.js";
import { Brain, type Params } from "../src/brain.js";
import { MarketBot, ForgeBot } from "./opponents.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);
const games = Number(args.get("games") ?? 50);
const seed0 = Number(args.get("seed") ?? 1);
const field = args.get("field") ?? "mixed";
const pa: Partial<Params> = JSON.parse(args.get("a") ?? "{}");
const pb: Partial<Params> = JSON.parse(args.get("b") ?? "{}");
const at: AuctionType = (args.get("auction") as AuctionType) ?? "Vickrey";
const verbose = args.has("v");

const dict = loadDictionary();
const finder = new SimWordFinder(dict);

function makeField(rng: Rng): SeatSpec[] {
  const r = () => rng.next();
  const seats: SeatSpec[] = [{ name: "A", policy: new Brain(dict, pa, "A") }];
  const opp: SeatSpec[] = [];
  for (let k = 0; k < 5; k++) {
    const kind = field === "sims" ? ["sim"][0]
      : field === "market" ? "market"
      : field === "self" ? "B"
      : field === "mixed" ? (k < 2 ? "B" : "market")
      : field === "live" ? (k < 3 ? "V" : "market")
      : field === "live2" ? (k < 2 ? "V" : k < 3 ? "P" : "market")
      : field === "forge" ? "F"
      : field === "top" ? (k < 3 ? "F" : k < 4 ? "V" : "market")
      : "market";
    if (kind === "sim") opp.push({ name: "sim", sim: (["Cheapskate", "ValueBidder", "Aggressive"] as const)[rng.int(0, 2)] });
    else if (kind === "B") opp.push({ name: "B", policy: new Brain(dict, pb, "B") });
    else if (kind === "P") {
      // Pegasus-v2-like late buyer: stingy early (high lambda), spends hard in the last quarter
      opp.push({ name: "P", policy: new Brain(dict, { ...pb, lambda0: 1.3, lambdaGamma: 2.0, floorFrac: 0, mc: 16 }, "P") });
    }
    else if (kind === "F") opp.push({ name: "F", policy: new ForgeBot(dict, r, 0.9 + 0.25 * r()) });
    else if (kind === "V") {
      // perturbed brain variant: stands in for the diverse live field
      const v: Partial<Params> = {
        ...pb,
        lambda0: 0.4 + 0.5 * r(),
        horizon: [6, 8, 12, 16][rng.int(0, 3)]!,
        minPlayLen: [5, 6, 7, 7][rng.int(0, 3)]!,
        playBonus: r() < 0.5 ? 0 : 0.7,
        priceScale: 0.8 + 0.5 * r(),
        mc: 16,
      };
      opp.push({ name: "V", policy: new Brain(dict, v, "V") });
    }
    else opp.push({ name: "M", policy: new MarketBot(dict, r, 0.9 + 0.5 * r(), field === "live" ? 7 : rng.int(5, 7)) });
  }
  seats.push(...opp);
  // shuffle seat order
  for (let i = seats.length - 1; i >= 1; i--) { const j = rng.int(0, i); [seats[i], seats[j]] = [seats[j]!, seats[i]!]; }
  return seats;
}

let sumScore = 0, wins = 0, place = 0, sumBest = 0, paidAll = 0, nAuc = 0, aWon = 0, aPaid = 0, aLeftBal = 0, aLeftTiles = 0, aWords = 0, aLen = 0, aPreFlush = 0;
const byName = new Map<string, { n: number; s: number }>();
const t0 = performance.now();
for (let g = 0; g < games; g++) {
  const rng = new Rng(seed0 * 100003 + g * 7919);
  const seats = makeField(rng);
  const m = new Match(dict, finder, seats, rng, at);
  const res = m.run();
  const ai = seats.findIndex((s) => s.name === "A");
  const my = res.scores[ai]!;
  const better = res.scores.filter((s) => s > my).length;
  sumScore += my; place += better + 1; if (better === 0) wins++;
  for (const e of res.events) {
    if (e.kind === "auction") { if (e.winner !== null) { paidAll += e.paid; nAuc++; } if (e.winner === ai) { aWon++; aPaid += e.paid; } }
    else if (e.seat === ai) { aWords++; aLen += e.word.length; }
  }
  aLeftBal += res.balances[ai]!; aLeftTiles += res.leftover[ai]!;
  // money truly wasted: final balance minus income from words cashed in the final round
  { let k = res.events.length - 1; let flush = 0;
    while (k >= 0 && res.events[k]!.kind !== "auction") k--; // last auction
    for (let j = k - 1; j >= 0 && res.events[j]!.kind !== "auction"; j--) { const e = res.events[j]!; if (e.kind === "word" && e.seat === ai) flush += e.reward; }
    aPreFlush += res.balances[ai]! - flush; }
  sumBest += Math.max(...res.scores.filter((_, i) => i !== ai));
  res.names.forEach((n, i) => { const e = byName.get(n) ?? { n: 0, s: 0 }; e.n++; e.s += res.scores[i]!; byName.set(n, e); });
  if (verbose) console.log(g, res.names.map((n, i) => `${n}:${res.scores[i]}/${res.balances[i]}/${res.leftover[i]}`).join(" "));
}
const out = { games, field, meanScore: +(sumScore / games).toFixed(1), winRate: +(wins / games).toFixed(3), meanPlace: +(place / games).toFixed(2), oppBest: +(sumBest / games).toFixed(1),
  avgPaid: +(paidAll / nAuc).toFixed(2), aWon: +(aWon / games).toFixed(1), aPaid: +(aPaid / games).toFixed(1), aLeftBal: +(aLeftBal / games).toFixed(1), aWasted: +(aPreFlush / games).toFixed(1), aLeftTiles: +(aLeftTiles / games).toFixed(1), aWords: +(aWords / games).toFixed(1), aAvgLen: +(aLen / Math.max(1, aWords)).toFixed(1),
  byName: Object.fromEntries([...byName].map(([k, v]) => [k, +(v.s / v.n).toFixed(1)])), secs: +((performance.now() - t0) / 1000).toFixed(1) };
console.log(JSON.stringify(out));

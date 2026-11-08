// Parallel wrapper: splits --games across 4 processes (distinct seeds) and
// merges. Same args as run.ts.
import { spawn } from "node:child_process";
import * as os from "node:os";
const argv = process.argv.slice(2);
const get = (k: string, d: string) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1]! : d; };
const games = Number(get("games", "100"));
const seed = Number(get("seed", "1"));
const P = Number(get("procs", String(os.cpus().length)));
const rest: string[] = [];
for (let i = 0; i < argv.length; i += 2) if (!["--games", "--seed", "--procs"].includes(argv[i]!)) rest.push(argv[i]!, argv[i + 1]!);
const per = Math.ceil(games / P);
const runs = [...Array(P).keys()].map((k) => new Promise<any>((res, rej) => {
  const ch = spawn("npx", ["tsx", "sim/run.ts", "--games", String(per), "--seed", String(seed * 1000 + k), ...rest], { stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; ch.stdout.on("data", (d) => (out += d));
  ch.on("close", () => { try { res(JSON.parse(out.trim().split("\n").pop()!)); } catch (e) { rej(out); } });
}));
Promise.all(runs).then((rs) => {
  const n = rs.reduce((a, r) => a + r.games, 0);
  const w = (k: string) => +(rs.reduce((a, r) => a + r[k] * r.games, 0) / n).toFixed(3);
  const byName: Record<string, number> = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.byName)) byName[k] = (byName[k] ?? 0) + (v as number) * r.games / n;
  for (const k in byName) byName[k] = +byName[k]!.toFixed(1);
  console.log(JSON.stringify({ games: n, meanScore: w("meanScore"), winRate: w("winRate"), meanPlace: w("meanPlace"), oppBest: w("oppBest"), avgPaid: w("avgPaid"), aWon: w("aWon"), aPaid: w("aPaid"), aLeftBal: w("aLeftBal"), aWasted: w("aWasted"), aLeftTiles: w("aLeftTiles"), aWords: w("aWords"), aAvgLen: w("aAvgLen"), byName, secs: Math.max(...rs.map((r) => r.secs)), args: rest.join(" ") }));
});

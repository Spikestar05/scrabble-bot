// ScrabbleBot live client. Connects to maincloud, joins the lobby after
// every match, and drives the Brain (src/brain.ts) from subscribed rows.
//
// First run:   BOT_NAME=<name> BOT_TOKEN=<token> npm start
// Later runs:  BOT_NAME=<name> npm start   (token cached in .token-<name>)
// Tournament:  TOURNAMENT_ID=<id> as well.
//
// Every finished match is appended to ../logs/matches.jsonl (and written in
// full to ../logs/match-<id>.json) for post-mortems. The token is never
// printed or logged.

import { fileURLToPath } from "node:url";
import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadDictionary, A, countsToString } from "./dict.js";
import { Brain, type Params } from "./brain.js";
import type { GameEvent, Observation } from "./engine.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const NO_LOBBY = process.env.NO_LOBBY === "1";
const PARAMS: Partial<Params> = process.env.BRAIN_PARAMS ? JSON.parse(process.env.BRAIN_PARAMS) : {};
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok, { mode: 0o600 });
}

const dict = loadDictionary();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), `[${BOT_NAME}]`, ...a);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;

interface MatchMemo {
  brain: Brain;
  bids: Map<string, { letter: string; bid: number; round: number; ms: number; info: unknown }>;
  words: { word: string; at: number; ok?: boolean; err?: string }[];
  ended: boolean;
  timings: number[];
}
const memos = new Map<string, MatchMemo>();
function memo(matchId: bigint): MatchMemo {
  const k = String(matchId);
  let m = memos.get(k);
  if (!m) {
    m = { brain: new Brain(dict, PARAMS, BOT_NAME), bids: new Map(), words: [], ended: false, timings: [] };
    memos.set(k, m);
  }
  return m;
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function participants(conn: DbConnection, matchId: bigint) {
  return [...conn.db.matchParticipant.iter()]
    .filter((p) => p.matchId === matchId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function rackFor(conn: DbConnection, matchId: bigint): Int8Array {
  const r = new Int8Array(26);
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const c = h.letter.charCodeAt(0) - A;
    if (c >= 0 && c < 26) r[c]! += h.count;
  }
  return r;
}

function eventsFor(conn: DbConnection, matchId: bigint, seatOf: Map<bigint, number>): GameEvent[] {
  type T = { t: bigint; k: bigint; e: GameEvent };
  const out: T[] = [];
  for (const r of conn.db.auctionResult.iter()) {
    if (r.matchId !== matchId) continue;
    const w = r.winnerBotId === undefined || r.winnerBotId === null ? null : (seatOf.get(r.winnerBotId) ?? null);
    out.push({
      t: r.closedAt.microsSinceUnixEpoch,
      k: r.auctionId,
      e: { kind: "auction", round: 0, letter: r.letter, winner: w, paid: Number(r.paid), topBid: 0 },
    });
  }
  for (const w of conn.db.wordPlay.iter()) {
    if (w.matchId !== matchId) continue;
    const s = seatOf.get(w.botId);
    if (s === undefined) continue;
    out.push({ t: w.playedAt.microsSinceUnixEpoch, k: w.id, e: { kind: "word", seat: s, word: w.word, reward: Number(w.totalReward) } });
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return out.map((x) => x.e);
}

function buildObs(conn: DbConnection, matchId: bigint, letter: string): Observation | null {
  if (myBotId === null) return null;
  const ms = conn.db.matchState.id.find(matchId);
  if (!ms || ms.status.tag !== "Running") return null;
  const ps = participants(conn, matchId);
  const seat = ps.findIndex((p) => p.botId === myBotId);
  if (seat < 0) return null;
  const seatOf = new Map<bigint, number>(ps.map((p, i) => [p.botId, i]));
  return {
    seat,
    nSeats: ps.length,
    auctionType: ms.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    round: ms.currentRound,
    letter,
    bagTotal: ms.bagTotal,
    rack: rackFor(conn, matchId),
    balances: ps.map((p) => Number(p.balance)),
    scores: ps.map((p) => Number(p.score)),
    events: eventsFor(conn, matchId, seatOf),
    startingRackSize: ms.startingRackSize,
  };
}

function fail(what: string) {
  return (err: unknown) => log(`${what} failed: ${err instanceof Error ? err.message : err}`);
}

const handled = new Set<string>();

function onAuction(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  const key = String(auctionId);
  if (handled.has(key)) return;
  const t0 = performance.now();
  const obs = buildObs(conn, matchId, letter);
  if (!obs) return;
  handled.add(key);
  const mm = memo(matchId);
  mm.brain.resetTracker();
  let act: { words: string[]; bid: number };
  try {
    act = mm.brain.act(obs);
  } catch (e) {
    log("brain error", e);
    act = { words: [], bid: 0 };
  }
  const ms = performance.now() - t0;
  mm.timings.push(ms);
  // Words first (reducers from one client run in order), then the bid.
  const wordPromises = act.words.map((word) => {
    const rec = { word, at: Date.now() } as MatchMemo["words"][number];
    mm.words.push(rec);
    return conn.reducers
      .submitWord({ matchId, word })
      .then(() => {
        rec.ok = true;
      })
      .catch((err: unknown) => {
        rec.ok = false;
        rec.err = err instanceof Error ? err.message : String(err);
        log(`word '${word}' failed: ${rec.err}`);
      });
  });
  const bal = obs.balances[obs.seat]!;
  const bid = Math.min(act.bid, bal);
  mm.bids.set(key, { letter, bid, round: obs.round, ms: Math.round(ms), info: mm.brain.lastInfo });
  if (bid > 0) conn.reducers.submitBid({ auctionId, amount: BigInt(bid) }).catch(fail(`bid ${bid} on ${letter}`));
  log(
    `m${matchId} r${obs.round} bag${obs.bagTotal} '${letter}' rack=${countsToString(obs.rack)} bal=${bal} bid=${bid}` +
      (act.words.length ? ` play=${act.words.join(",")}` : "") +
      ` (${ms.toFixed(0)}ms)`,
  );
  // After our words land, the reward is in our balance: re-bid if useful.
  if (wordPromises.length && obs.bagTotal > 0) {
    Promise.all(wordPromises).then(() => {
      const a = conn.db.auction.id.find(auctionId);
      if (!a || a.status.tag !== "Open") return;
      const obs2 = buildObs(conn, matchId, letter);
      if (!obs2) return;
      const nb = Math.min(mm.brain.rebid(obs2), obs2.balances[obs2.seat]!);
      const prev = mm.bids.get(key)!;
      if (nb > prev.bid) {
        prev.bid = nb;
        conn.reducers.submitBid({ auctionId, amount: BigInt(nb) }).catch(fail(`rebid ${nb}`));
        log(`  rebid ${nb} on '${letter}'`);
      }
    });
  }
}

function writeMatchLog(conn: DbConnection, matchId: bigint) {
  const mm = memos.get(String(matchId));
  if (!mm || mm.ended) return;
  mm.ended = true;
  const ps = participants(conn, matchId);
  const ms = conn.db.matchState.id.find(matchId);
  const nameOf = (id: bigint) => conn.db.bot.id.find(id)?.name ?? String(id);
  const sorted = [...ps].sort((a, b) => Number(b.score - a.score));
  const me = ps.find((p) => p.botId === myBotId);
  const placement = me ? sorted.filter((p) => p.score > me.score).length + 1 : null;
  const auctions = [...conn.db.auctionResult.iter()]
    .filter((r) => r.matchId === matchId)
    .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
    .map((r) => {
      const b = mm.bids.get(String(r.auctionId));
      return {
        id: Number(r.auctionId),
        letter: r.letter,
        winner: r.winnerBotId !== undefined && r.winnerBotId !== null ? nameOf(r.winnerBotId) : null,
        paid: Number(r.paid),
        myBid: b?.bid ?? null,
        info: b?.info,
        ms: b?.ms,
      };
    });
  const words = [...conn.db.wordPlay.iter()]
    .filter((w) => w.matchId === matchId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((w) => ({ bot: nameOf(w.botId), word: w.word, reward: Number(w.totalReward) }));
  const rec = {
    matchId: Number(matchId),
    at: new Date().toISOString(),
    auctionType: ms?.auctionType.tag,
    placement,
    nPlayers: ps.length,
    scores: sorted.map((p) => ({ bot: nameOf(p.botId), score: Number(p.score), balance: Number(p.balance) })),
    myScore: me ? Number(me.score) : null,
    myLeftover: countsToString(rackFor(conn, matchId)),
    myWords: words.filter((w) => w.bot === nameOf(myBotId!)),
    myWordAttempts: mm.words,
    won: auctions.filter((a) => a.winner === nameOf(myBotId!)).map((a) => ({ l: a.letter, paid: a.paid, bid: a.myBid })),
    missed: auctions.filter((a) => a.myBid && a.winner !== nameOf(myBotId!)).map((a) => ({ l: a.letter, bid: a.myBid, paid: a.paid, winner: a.winner })),
    maxDecisionMs: Math.max(0, ...mm.timings),
    auctions,
    words,
  };
  fs.writeFileSync(path.join(LOG_DIR, `match-${matchId}.json`), JSON.stringify(rec, null, 1));
  const { auctions: _a, words: _w, myWordAttempts: _x, ...summary } = rec;
  fs.appendFileSync(path.join(LOG_DIR, "matches.jsonl"), JSON.stringify(summary) + "\n");
  log(`match ${matchId} ended: place ${placement}/${ps.length} ` + sorted.map((p) => `${nameOf(p.botId)}:${p.score}`).join(" "));
}

const watched = new Map<string, { unsubscribe: () => void }>();
function watchMatch(conn: DbConnection, matchId: bigint) {
  const k = String(matchId);
  if (watched.has(k)) return;
  const h = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const ms = conn.db.matchState.id.find(matchId);
      log(`watching match ${matchId} (${ms?.status.tag ?? "?"})`);
      if (ms && ms.status.tag !== "Running") {
        unwatch(matchId);
        joinLobby(conn);
        return;
      }
      for (const a of conn.db.auction.iter())
        if (a.matchId === matchId && a.status.tag === "Open") onAuction(conn, a.id, a.matchId, a.letter);
    })
    .onError((ctx) => log("match subscription error", (ctx as { event?: unknown }).event))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${matchId}`,
      `SELECT * FROM match_participant WHERE match_id = ${matchId}`,
      `SELECT * FROM auction WHERE match_id = ${matchId}`,
      `SELECT * FROM auction_result WHERE match_id = ${matchId}`,
      `SELECT * FROM word_play WHERE match_id = ${matchId}`,
    ]);
  watched.set(k, h);
}
function unwatch(matchId: bigint) {
  const k = String(matchId);
  const h = watched.get(k);
  watched.delete(k);
  setTimeout(() => {
    try {
      h?.unsubscribe();
    } catch {
      /* already gone */
    }
    memos.delete(k);
  }, 3000);
}

const STOP_FILE = path.join(LOG_DIR, "STOP");
function joinLobby(conn: DbConnection) {
  if (myBotId === null || NO_LOBBY) return;
  if (fs.existsSync(STOP_FILE)) {
    const running = [...conn.db.matchParticipant.iter()].some(
      (p) => p.botId === myBotId && conn.db.matchState.id.find(p.matchId)?.status.tag === "Running",
    );
    if (!running) {
      log("STOP file present: not rejoining the lobby; exiting");
      setTimeout(() => process.exit(0), 500);
    }
    return;
  }
  const inRunning = [...conn.db.matchParticipant.iter()].some((p) => {
    if (p.botId !== myBotId) return false;
    return conn.db.matchState.id.find(p.matchId)?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = [...conn.db.openLobbies.iter()][0];
  const alreadyIn =
    openLobby !== undefined &&
    [...conn.db.openLobbyMembers.iter()].some((lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId);
  if (alreadyIn) return;
  log("joining lobby");
  conn.reducers.joinLobby({}).catch(fail("joining the lobby"));
}

function bootstrap(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
      .catch(fail(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  log(`connected`);

  // Tables like auction / auction_result hold every match ever played, so
  // subscribe narrowly: our credential first, then our participations, then
  // one match at a time.
  const phase2 = () => {
    log(`acting as bot '${conn.db.bot.id.find(myBotId!)?.name ?? "?"}' (id ${myBotId})`);
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        log("participant subscription applied");
        // newest participation might be a running match (restart mid-match)
        const mine = [...conn.db.matchParticipant.iter()].filter((p) => p.botId === myBotId);
        mine.sort((x, y) => (x.matchId < y.matchId ? 1 : -1));
        if (mine[0]) watchMatch(conn, mine[0].matchId);
        bootstrap(conn);
      })
      .onError((ctx) => {
        log("subscription error", (ctx as { event?: unknown }).event);
        process.exit(1);
      })
      .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`, "SELECT * FROM my_rack"]);
  };
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      log("subscription applied");
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          conn.reducers.claimCredential({ code: BOT_NONCE }).catch(fail("claiming the credential"));
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              log("couldn't claim credential");
              process.exit(1);
            }
            phase2();
          }, 1500);
          return;
        }
        log("no BotCredential for this token; set BOT_TOKEN");
        process.exit(1);
      }
      phase2();
    })
    .onError((ctx) => {
      log("subscription error", (ctx as { event?: unknown }).event);
      process.exit(1);
    })
    .subscribe([
      "SELECT * FROM bot",
      `SELECT * FROM bot_credential WHERE identity = 0x${identity.toHexString()}`,
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
    ]);

  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (myBotId !== null && p.botId === myBotId) {
      log(`seated in match ${p.matchId}`);
      watchMatch(conn, p.matchId);
    }
  });
  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") onAuction(conn, a.id, a.matchId, a.letter);
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = [...conn.db.matchParticipant.iter()].some((p) => p.matchId === neu.id && p.botId === myBotId);
      if (wasIn) {
        try {
          writeMatchLog(conn, neu.id);
        } catch (e) {
          log("log error", e);
        }
        unwatch(neu.id);
        joinLobby(conn);
      }
    }
  });
  conn.db.matchState.onInsert((_ctx, m) => {
    if (myBotId === null) return;
    log(`match ${m.id} inserted (${m.auctionType.tag})`);
  });
  // A new lobby opened (previous resolved/cancelled) -> make sure we are queued.
  conn.db.openLobbies.onInsert(() => setTimeout(() => joinLobby(conn), 200));
  setInterval(() => joinLobby(conn), 15000);
}

function main() {
  log(`connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      log("connect error:", err.message);
      process.exit(1);
    })
    .onDisconnect(() => {
      log("disconnected");
      process.exit(2);
    })
    .build();
}

main();

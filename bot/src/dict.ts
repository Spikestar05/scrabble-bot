// Dictionary index: every ENABLE word as a 26-slot letter-count vector plus a
// presence bitmask, so "which words can this rack spell" is a fast linear
// filter, and rack partitioning (best set of disjoint words) is a memoised
// search. Pure code, no runtime dependencies beyond node:fs.

import * as fs from "node:fs";
import * as path from "node:path";

export const A = 65;
export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Scrabble values, identical to spacetimedb/src/letters.ts.
export const VALUE: number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

// Standard bag, no blanks (letters.ts DEFAULT_BAG).
export const BAG: number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];

// Module's lengthMultiplier + integer floor (playWord: base*num/denom).
export function reward(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export function wordReward(w: string): number {
  let b = 0;
  for (let i = 0; i < w.length; i++) b += VALUE[w.charCodeAt(i) - A]!;
  return reward(b, w.length);
}

export type Counts = Int8Array; // length 26

export function countsOf(s: string): Counts {
  const c = new Int8Array(26);
  for (let i = 0; i < s.length; i++) c[s.charCodeAt(i) - A]!++;
  return c;
}

export function countsToString(c: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) for (let k = 0; k < c[i]!; k++) s += LETTERS[i];
  return s;
}

export function maskOf(c: Counts): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (c[i]! > 0) m |= 1 << i;
  return m;
}

export function total(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i]!;
  return t;
}

export class Dictionary {
  readonly words: string[];
  readonly n: number;
  readonly len: Uint8Array;
  readonly mask: Int32Array;
  readonly base: Int16Array;
  readonly rew: Int16Array;
  // Letter indices per word, flattened (offsets in `off`).
  readonly letters: Uint8Array;
  readonly off: Int32Array;
  readonly set: Set<string>;

  constructor(words: string[]) {
    // Keep only A-Z words of length >= 2 (module rejects shorter).
    const ws = words.filter((w) => w.length >= 2 && /^[A-Z]+$/.test(w));
    this.words = ws;
    this.n = ws.length;
    this.set = new Set(ws);
    this.len = new Uint8Array(this.n);
    this.mask = new Int32Array(this.n);
    this.base = new Int16Array(this.n);
    this.rew = new Int16Array(this.n);
    this.off = new Int32Array(this.n + 1);
    let tot = 0;
    for (const w of ws) tot += w.length;
    this.letters = new Uint8Array(tot);
    let o = 0;
    for (let i = 0; i < this.n; i++) {
      const w = ws[i]!;
      this.off[i] = o;
      let m = 0;
      let b = 0;
      for (let j = 0; j < w.length; j++) {
        const c = w.charCodeAt(j) - A;
        this.letters[o++] = c;
        m |= 1 << c;
        b += VALUE[c]!;
      }
      this.len[i] = w.length;
      this.mask[i] = m;
      this.base[i] = b;
      this.rew[i] = reward(b, w.length);
    }
    this.off[this.n] = o;
  }

  has(w: string): boolean {
    return this.set.has(w);
  }

  // Can word i be spelled from rack counts c?
  fits(i: number, c: Counts, scratch: Int8Array): boolean {
    return this.fitsQuick(i, c, scratch);
  }

  // All word indices spellable from rack c with length >= minLen.
  playable(c: Counts, minLen = 2, among?: Int32Array | number[]): number[] {
    const rm = maskOf(c);
    const tot = total(c);
    const out: number[] = [];
    const scratch = new Int8Array(26);
    if (among) {
      for (let k = 0; k < among.length; k++) {
        const i = among[k]!;
        if (this.len[i]! < minLen || this.len[i]! > tot) continue;
        if ((this.mask[i]! & ~rm) !== 0) continue;
        if (this.fits(i, c, scratch)) out.push(i);
      }
      return out;
    }
    for (let i = 0; i < this.n; i++) {
      if (this.len[i]! < minLen || this.len[i]! > tot) continue;
      if ((this.mask[i]! & ~rm) !== 0) continue;
      if (this.fits(i, c, scratch)) out.push(i);
    }
    return out;
  }

  // Best set of disjoint words from rack c (max total reward), by
  // branch-and-bound DFS. At each node take the most valuable letter x still
  // in the rack: either some word containing x is played, or one x is left
  // unused. Bound: 3x the face value of what is left. `deadline`
  // (performance.now ms) caps the search; past it, the best found so far is
  // returned.
  partition(
    c: Counts,
    minLen = 2,
    deadline = Infinity,
  ): { words: string[]; total: number } {
    const cand = this.playable(c, minLen);
    cand.sort((a, b) => this.rew[b]! - this.rew[a]! || this.len[b]! - this.len[a]!);
    const r = new Int8Array(c);
    const scratch = new Int8Array(26);
    let best = -1;
    let bestWords: number[] = [];
    const stack: number[] = [];
    let nodes = 0;
    let stop = false;
    let rv = 0;
    for (let i = 0; i < 26; i++) rv += r[i]! * VALUE[i]!;

    const dfs = (cands: number[], acc: number) => {
      if (acc > best) {
        best = acc;
        bestWords = stack.slice();
      }
      if (stop || cands.length === 0) return;
      if (acc + 3 * rv <= best) return;
      if ((++nodes & 255) === 0 && performance.now() > deadline) {
        stop = true;
        return;
      }
      // pick the most valuable letter present that some candidate uses
      let x = -1;
      let candMask = 0;
      for (const i of cands) candMask |= this.mask[i]!;
      for (let i = 0; i < 26; i++) {
        if (r[i]! > 0 && (candMask & (1 << i)) !== 0) {
          if (x < 0 || VALUE[i]! > VALUE[x]!) x = i;
        }
      }
      if (x < 0) return;
      const bit = 1 << x;
      for (const i of cands) {
        if ((this.mask[i]! & bit) === 0) continue;
        const s = this.off[i]!;
        const e = this.off[i + 1]!;
        for (let j = s; j < e; j++) r[this.letters[j]!]!--;
        rv -= this.base[i]!;
        const sub: number[] = [];
        for (const k of cands) if (this.fitsQuick(k, r, scratch)) sub.push(k);
        stack.push(i);
        dfs(sub, acc + this.rew[i]!);
        stack.pop();
        rv += this.base[i]!;
        for (let j = s; j < e; j++) r[this.letters[j]!]!++;
        if (stop) return;
      }
      // leave one x unused
      r[x]!--;
      rv -= VALUE[x]!;
      const sub: number[] = [];
      for (const k of cands) if (this.fitsQuick(k, r, scratch)) sub.push(k);
      dfs(sub, acc);
      rv += VALUE[x]!;
      r[x]!++;
    };
    dfs(cand, 0);
    return { words: bestWords.map((i) => this.words[i]!), total: Math.max(best, 0) };
  }

  // fits without the length/mask prefilter wrapper
  fitsQuick(i: number, c: Int8Array, scratch: Int8Array): boolean {
    const s = this.off[i]!;
    const e = this.off[i + 1]!;
    let ok = true;
    let j = s;
    for (; j < e; j++) {
      const l = this.letters[j]!;
      scratch[l]!++;
      if (scratch[l]! > c[l]!) {
        ok = false;
        j++;
        break;
      }
    }
    for (let k = s; k < j; k++) scratch[this.letters[k]!] = 0;
    return ok;
  }
}

let SHARED: Dictionary | undefined;

export function wordlistPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.join(here, "..", "..", "spacetimedb", "wordlist.txt");
}

export function loadDictionary(): Dictionary {
  if (SHARED) return SHARED;
  const words = fs
    .readFileSync(wordlistPath(), "utf8")
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2);
  SHARED = new Dictionary(words);
  return SHARED;
}

/*
 * Copyright 2008-2026 Vassilios Karakoidas
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { CharSet } from './charset.ts';
import { type Ast, UNBOUNDED } from './ast.ts';
import { RegexCompilationError } from './errors.ts';

/**
 * {@link Ast} to a minimal DFA: Thompson construction, subset construction
 * and partition refinement, all over character *ranges*.
 *
 * Nothing here ever enumerates a character. An edge carries a {@link CharSet},
 * the determiniser splits the alphabet at the boundaries the automaton
 * actually uses, and a class of thousands of code units costs exactly what a
 * single character costs.
 */

/** A bound on states, so a pathological pattern fails rather than hangs. */
const MAX_STATES = 100_000;
/** A bound on the unrolling of `{n,m}`, for the same reason. */
const MAX_REPEAT = 10_000;
/** Beyond this many (state, symbol) pairs the dense table is not worth building. */
const MAX_TABLE = 32_000_000;

/**
 * A deterministic automaton over ranges. `trans[state]` holds
 * `[lo, hi, destination]` triples sorted by `lo`; state 0 is the initial one.
 */
export interface Det {
  readonly stateCount: number;
  readonly initial: number;
  readonly accept: boolean[];
  readonly trans: number[][][];
}

/** Build, determinise and minimise. */
export function compileDfa(ast: Ast): Det {
  const nfa = new Nfa();
  const frag = build(nfa, ast);
  return minimise(determinise(nfa, frag));
}

// --- the NFA ------------------------------------------------------------

/** An edge on a set of characters, or an epsilon edge when `set` is null. */
interface Edge {
  readonly set: CharSet | null;
  readonly to: number;
}

class Nfa {
  readonly out: Edge[][] = [];

  newState(): number {
    if (this.out.length >= MAX_STATES) {
      throw new RegexCompilationError(`Automaton too large: over ${MAX_STATES} NFA states`);
    }
    this.out.push([]);
    return this.out.length - 1;
  }

  edge(from: number, on: CharSet, to: number): void {
    this.out[from]!.push({ set: on, to });
  }

  epsilon(from: number, to: number): void {
    this.out[from]!.push({ set: null, to });
  }
}

/** A sub-automaton with one entry and one exit. */
interface Frag {
  readonly start: number;
  readonly end: number;
}

function build(n: Nfa, node: Ast): Frag {
  switch (node.kind) {
    case 'empty': {
      const s = n.newState();
      const e = n.newState();
      n.epsilon(s, e);
      return { start: s, end: e };
    }
    case 'chars': {
      const s = n.newState();
      const e = n.newState();
      if (!node.set.isEmpty()) {
        n.edge(s, node.set, e);
      }
      return { start: s, end: e };
    }
    case 'group':
      return build(n, node.node);
    case 'concat': {
      let first: Frag | null = null;
      let last = -1;
      for (const part of node.parts) {
        const f = build(n, part);
        if (first === null) {
          first = f;
        } else {
          n.epsilon(last, f.start);
        }
        last = f.end;
      }
      return first === null ? build(n, { kind: 'empty' }) : { start: first.start, end: last };
    }
    case 'alt': {
      const s = n.newState();
      const e = n.newState();
      for (const part of node.parts) {
        const f = build(n, part);
        n.epsilon(s, f.start);
        n.epsilon(f.end, e);
      }
      return { start: s, end: e };
    }
    case 'repeat':
      return buildRepeat(n, node.node, node.min, node.max);
  }
}

function buildRepeat(n: Nfa, node: Ast, min: number, max: number): Frag {
  // Both bounds are unrolled, so both must be checked: {n,} has no max but
  // still builds n copies, and a{30000,} would grind rather than fail.
  if (min > MAX_REPEAT || (max !== UNBOUNDED && max > MAX_REPEAT)) {
    throw new RegexCompilationError(
      `Repetition {${min},${max === UNBOUNDED ? '' : String(max)}} is too large to unroll`,
    );
  }
  const s = n.newState();
  const e = n.newState();
  let cursor = s;

  for (let i = 0; i < min; i++) {
    const f = build(n, node);
    n.epsilon(cursor, f.start);
    cursor = f.end;
  }
  if (max === UNBOUNDED) {
    const f = build(n, node);
    n.epsilon(cursor, f.start);
    n.epsilon(f.end, f.start); // the star
    n.epsilon(f.end, e);
    n.epsilon(cursor, e); // zero more
  } else {
    for (let i = min; i < max; i++) {
      const f = build(n, node);
      n.epsilon(cursor, f.start);
      n.epsilon(cursor, e); // stop here
      cursor = f.end;
    }
    n.epsilon(cursor, e);
  }
  return { start: s, end: e };
}

// --- determinisation ----------------------------------------------------

/** A set of NFA states. */
class BitSet {
  readonly words: Uint32Array;

  constructor(nbits: number) {
    this.words = new Uint32Array((nbits + 31) >>> 5);
  }

  get(i: number): boolean {
    return (this.words[i >>> 5]! & (1 << (i & 31))) !== 0;
  }

  set(i: number): void {
    this.words[i >>> 5]! |= 1 << (i & 31);
  }

  or(other: BitSet): void {
    const w = this.words;
    const o = other.words;
    for (let i = 0; i < w.length; i++) {
      w[i]! |= o[i]!;
    }
  }

  clone(): BitSet {
    const c = new BitSet(this.words.length << 5);
    c.words.set(this.words);
    return c;
  }

  /** The first set bit at or after `from`, or -1. */
  nextSetBit(from: number): number {
    const w = this.words;
    let wi = from >>> 5;
    if (wi >= w.length) {
      return -1;
    }
    let word = w[wi]! & (0xffffffff << (from & 31));
    for (;;) {
      if (word !== 0) {
        return (wi << 5) + ctz(word);
      }
      wi++;
      if (wi >= w.length) {
        return -1;
      }
      word = w[wi]!;
    }
  }

  /** A string that identifies this set, for use as a map key. */
  key(): string {
    const parts: number[] = [];
    for (let i = this.nextSetBit(0); i >= 0; i = this.nextSetBit(i + 1)) {
      parts.push(i);
    }
    return parts.join(',');
  }
}

/** Count of trailing zero bits of a non-zero 32-bit word. */
function ctz(x: number): number {
  return 31 - Math.clz32(x & -x);
}

/** The epsilon closure of one NFA state, memoised. */
function closureOf(n: Nfa, state: number, cache: (BitSet | null)[]): BitSet {
  const cached = cache[state];
  if (cached) {
    return cached;
  }
  const r = new BitSet(n.out.length);
  r.set(state);
  const stack: number[] = [state];
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const e of n.out[s]!) {
      if (e.set === null && !r.get(e.to)) {
        r.set(e.to);
        stack.push(e.to);
      }
    }
  }
  cache[state] = r;
  return r;
}

/** Close a set of states under epsilon, through the per-state cache. */
function close(n: Nfa, set: BitSet, cache: (BitSet | null)[]): void {
  const seed = set.clone();
  for (let i = seed.nextSetBit(0); i >= 0; i = seed.nextSetBit(i + 1)) {
    set.or(closureOf(n, i, cache));
  }
}

/**
 * The cut points of every set on an edge leaving this state group, as a sorted
 * array with no duplicates. Splitting the alphabet only where the automaton
 * distinguishes it keeps the transition count proportional to the pattern, not
 * to the character space.
 */
function cutsOf(edges: Edge[]): number[] {
  const raw: number[] = [];
  for (const e of edges) {
    const s = e.set!;
    for (let k = 0; k < s.rangeCount(); k++) {
      raw.push(s.lo(k));
      raw.push(s.hi(k) + 1 <= CharSet.MAX ? s.hi(k) + 1 : s.lo(k));
    }
  }
  return sortedUnique(raw);
}

function sortedUnique(raw: number[]): number[] {
  raw.sort((a, b) => a - b);
  const out: number[] = [];
  for (let k = 0; k < raw.length; k++) {
    if (k === 0 || raw[k] !== raw[k - 1]) {
      out.push(raw[k]!);
    }
  }
  return out;
}

/** The index of the first cut point that is not below `v`. */
function lowerBound(cut: number[], v: number): number {
  let lo = 0;
  let hi = cut.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cut[mid]! < v) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function determinise(n: Nfa, frag: Frag): Det {
  const ids = new Map<string, number>();
  const sets: BitSet[] = [];
  const trans: number[][][] = [];
  const work: number[] = [];
  const closures: (BitSet | null)[] = new Array<BitSet | null>(n.out.length).fill(null);

  const start = new BitSet(n.out.length);
  start.set(frag.start);
  close(n, start, closures);
  ids.set(start.key(), 0);
  sets.push(start);
  trans.push([]);
  work.push(0);

  let head = 0;
  while (head < work.length) {
    const id = work[head++]!;
    const from = sets[id]!;

    const edges: Edge[] = [];
    for (let s = from.nextSetBit(0); s >= 0; s = from.nextSetBit(s + 1)) {
      for (const e of n.out[s]!) {
        if (e.set !== null && !e.set.isEmpty()) {
          edges.push(e);
        }
      }
    }
    if (edges.length === 0) {
      continue;
    }
    const cut = cutsOf(edges);

    // Scatter each edge into the cut slots its ranges cover, rather than
    // asking every edge about every slot: linear in the slots actually
    // covered, which is the size of the answer.
    const slot: (BitSet | null)[] = new Array<BitSet | null>(cut.length).fill(null);
    for (const e of edges) {
      const cs = e.set!;
      for (let k = 0; k < cs.rangeCount(); k++) {
        const lo = cs.lo(k);
        const hi = cs.hi(k);
        for (let a = lowerBound(cut, lo); a < cut.length && cut[a]! <= hi; a++) {
          let bits = slot[a];
          if (bits === null) {
            bits = new BitSet(n.out.length);
            slot[a] = bits;
          }
          bits.set(e.to);
        }
      }
    }

    for (let a = 0; a < cut.length; a++) {
      const to = slot[a];
      if (to === null) {
        continue;
      }
      const lo = cut[a]!;
      const hi = (a + 1 < cut.length ? cut[a + 1]! : CharSet.MAX + 1) - 1;
      if (lo > hi) {
        continue;
      }
      close(n, to, closures);
      const key = to.key();
      let dest = ids.get(key);
      if (dest === undefined) {
        if (sets.length >= MAX_STATES) {
          throw new RegexCompilationError(`Automaton too large: over ${MAX_STATES} DFA states`);
        }
        dest = sets.length;
        ids.set(key, dest);
        sets.push(to);
        trans.push([]);
        work.push(dest);
      }
      trans[id]!.push([lo, hi, dest]);
    }
  }

  const accept: boolean[] = [];
  for (let i = 0; i < sets.length; i++) {
    accept.push(sets[i]!.get(frag.end));
  }
  for (const t of trans) {
    t.sort((a, b) => a[0]! - b[0]!);
  }
  return { stateCount: sets.length, initial: 0, accept, trans };
}

// --- minimisation -------------------------------------------------------

/**
 * The cut points of the whole transition relation: both endpoints of every
 * range, so that each interval between consecutive points is treated the same
 * way by every state. Symbol `a` stands for the interval starting at
 * `probes[a]`.
 */
function cutPoints(d: Det): number[] {
  const raw: number[] = [];
  for (const t of d.trans) {
    for (const e of t) {
      raw.push(e[0]!);
      raw.push(e[1]! + 1 <= CharSet.MAX ? e[1]! + 1 : e[0]!);
    }
  }
  return sortedUnique(raw);
}

/**
 * Hopcroft's partition refinement, `O(T log S)`: a worklist of (block, symbol)
 * splitters and, for each, only the states that actually reach that block on
 * that symbol, through an inverse transition index. A block is split at most
 * `log S` times, and the smaller half is always the one queued.
 */
function minimise(d: Det): Det {
  const s = d.stateCount;
  const probes = cutPoints(d);
  const p = probes.length;
  if (p === 0 || (s + 1) * p > MAX_TABLE) {
    // Nothing to distinguish states by, or too large to index densely. The
    // automaton is already correct, only not minimal.
    return d;
  }

  // A sink makes the automaton complete, which Hopcroft needs. It is dropped
  // again when the result is rebuilt, unless the initial state reaches it.
  const sink = s;
  const m = s + 1;
  const delta = new Int32Array(m * p).fill(sink);
  for (let st = 0; st < s; st++) {
    const ts = d.trans[st]!;
    let ti = 0;
    for (let a = 0; a < p; a++) {
      const lo = probes[a]!;
      while (ti < ts.length && ts[ti]![1]! < lo) {
        ti++;
      }
      if (ti < ts.length && ts[ti]![0]! <= lo) {
        delta[st * p + a] = ts[ti]![2]!;
      }
    }
  }

  // Inverse transitions, as one CSR array per symbol.
  const invStart: Int32Array[] = [];
  const invTo: Int32Array[] = [];
  for (let a = 0; a < p; a++) {
    const count = new Int32Array(m + 1);
    for (let st = 0; st < m; st++) {
      count[delta[st * p + a]! + 1]!++;
    }
    for (let k = 0; k < m; k++) {
      count[k + 1]! += count[k]!;
    }
    const to = new Int32Array(m);
    const cursor = count.slice();
    for (let st = 0; st < m; st++) {
      to[cursor[delta[st * p + a]!]!++] = st;
    }
    invStart.push(count);
    invTo.push(to);
  }

  // Partition: block 0 rejecting (the sink joins it), block 1 accepting.
  const blockOf = new Int32Array(m);
  for (let st = 0; st < s; st++) {
    blockOf[st] = d.accept[st] ? 1 : 0;
  }
  blockOf[sink] = 0;
  let members: number[][] = [[], []];
  for (let st = 0; st < m; st++) {
    members[blockOf[st]!]!.push(st);
  }
  if (members[1]!.length === 0 || members[0]!.length === 0) {
    // One block only; nothing can ever split it.
    const all = members[0]!.length === 0 ? members[1]! : members[0]!;
    members = [all];
    for (let st = 0; st < m; st++) {
      blockOf[st] = 0;
    }
  }

  // The worklist holds (block, symbol) splitters. Membership is tracked
  // because the "enqueue only the smaller half" rule -- the one that gives
  // Hopcroft its log factor -- is valid only when the block being split is
  // not already queued. When it is, the new half must be queued too.
  const workBlock: number[] = [];
  const workSymbol: number[] = [];
  let queued = new Uint8Array(Math.max(2, members.length) * p);
  for (let b = 0; b < members.length; b++) {
    for (let a = 0; a < p; a++) {
      workBlock.push(b);
      workSymbol.push(a);
      queued[b * p + a] = 1;
    }
  }

  let touchedCount: Int32Array = new Int32Array(members.length);
  const reaches = new Uint8Array(m);
  let head = 0;
  while (head < workBlock.length) {
    const splitter = workBlock[head]!;
    const symbol = workSymbol[head]!;
    head++;
    queued[splitter * p + symbol] = 0;

    // States that reach the splitter block on this symbol.
    const reaching: number[] = [];
    const invS = invStart[symbol]!;
    const invT = invTo[symbol]!;
    for (const t of members[splitter]!) {
      for (let k = invS[t]!; k < invS[t + 1]!; k++) {
        const from = invT[k]!;
        if (reaches[from] === 0) {
          reaches[from] = 1;
          reaching.push(from);
        }
      }
    }
    if (reaching.length === 0) {
      continue;
    }

    if (touchedCount.length < members.length) {
      touchedCount = grow(touchedCount, members.length);
    }
    const touchedBlocks: number[] = [];
    for (const st of reaching) {
      const b = blockOf[st]!;
      if (touchedCount[b] === 0) {
        touchedBlocks.push(b);
      }
      touchedCount[b]!++;
    }

    for (const b of touchedBlocks) {
      const inCount = touchedCount[b]!;
      touchedCount[b] = 0;
      const block = members[b]!;
      if (inCount === block.length) {
        continue; // the whole block reaches; no split
      }
      const keep: number[] = [];
      const move: number[] = [];
      for (const st of block) {
        if (reaches[st] !== 0) {
          move.push(st);
        } else {
          keep.push(st);
        }
      }
      const nb = members.length;
      members[b] = keep;
      members.push(move);
      for (const st of move) {
        blockOf[st] = nb;
      }
      if (touchedCount.length < members.length) {
        touchedCount = grow(touchedCount, members.length);
      }
      if (queued.length < members.length * p) {
        const bigger = new Uint8Array(Math.max(queued.length * 2, members.length * p));
        bigger.set(queued);
        queued = bigger;
      }
      const smaller = keep.length <= move.length ? b : nb;
      for (let a = 0; a < p; a++) {
        const target = queued[b * p + a] !== 0 ? nb : smaller;
        if (queued[target * p + a] === 0) {
          queued[target * p + a] = 1;
          workBlock.push(target);
          workSymbol.push(a);
        }
      }
    }
    for (const st of reaching) {
      reaches[st] = 0;
    }
  }

  return rebuild(d, blockOf, members.length, sink);
}

function grow(arr: Int32Array, size: number): Int32Array {
  const bigger = new Int32Array(size);
  bigger.set(arr);
  return bigger;
}

/** One state per block, numbered so the initial state stays 0. */
function rebuild(d: Det, blockOf: Int32Array, blocks: number, sink: number): Det {
  const s = d.stateCount;
  const sinkBlock = blockOf[sink]!;
  const remap = new Int32Array(blocks).fill(-1);
  let assigned = 0;
  remap[blockOf[d.initial]!] = assigned++;
  for (let st = 0; st < s; st++) {
    const b = blockOf[st]!;
    if (remap[b]! < 0 && b !== sinkBlock) {
      remap[b] = assigned++;
    }
  }

  const accept: boolean[] = new Array<boolean>(assigned).fill(false);
  const trans: number[][][] = [];
  for (let i = 0; i < assigned; i++) {
    trans.push([]);
  }
  const filled = new Uint8Array(assigned);
  for (let st = 0; st < s; st++) {
    const b = remap[blockOf[st]!]!;
    if (b < 0) {
      continue; // a dead state merged with the sink
    }
    accept[b] = accept[b]! || d.accept[st]!;
    if (filled[b] !== 0) {
      continue;
    }
    filled[b] = 1;
    for (const e of d.trans[st]!) {
      const dest = remap[blockOf[e[2]!]!]!;
      if (dest >= 0) {
        trans[b]!.push([e[0]!, e[1]!, dest]);
      }
    }
  }
  for (const t of trans) {
    t.sort((a, b) => a[0]! - b[0]!);
  }
  return { stateCount: assigned, initial: 0, accept, trans: mergeAll(trans) };
}

/** Ranges that touch and lead to the same state become one transition. */
function mergeAll(trans: number[][][]): number[][][] {
  const out: number[][][] = [];
  for (const t of trans) {
    const merged: number[][] = [];
    for (const e of t) {
      if (merged.length > 0) {
        const last = merged[merged.length - 1]!;
        if (last[2] === e[2] && last[1]! + 1 >= e[0]!) {
          last[1] = Math.max(last[1]!, e[1]!);
          continue;
        }
      }
      merged.push([e[0]!, e[1]!, e[2]!]);
    }
    out.push(merged);
  }
  return out;
}

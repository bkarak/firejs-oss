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
import { type Ast, EMPTY, UNBOUNDED } from './ast.ts';
import type { Parsed } from './parser.ts';

/**
 * Recovers capturing-group offsets from a match span. The DFA still decides
 * where the match is; this walks the pattern's own syntax tree over that
 * slice only, so the walk — generated or interpreted — never knows about
 * groups.
 *
 * The parse it recovers is the one in which every quantifier and every
 * alternation, left to right, takes as much of the span as still lets the
 * rest match: the POSIX rule. Where a backtracking engine's first parse is
 * also that one, the two agree; `(a|ab)(c|bcd)(d*)` on `abcd` gives `ab`,
 * `c`, `d` here where a backtracker gives `a`, `bcd` and the empty string. A
 * lazy quantifier is greedy here too. A repeated group keeps its last
 * non-empty iteration; an alternative that took no part stays unset.
 *
 * FIRE/J builds its plan by re-parsing the pattern through the dk.brics
 * dialect, which refuses a few patterns the engine itself accepts. This plan
 * is lowered from the same tree the automaton was built from, so every
 * pattern that compiles has its groups.
 *
 * A plan is immutable and shared by every matcher for the same pattern. The
 * per-matcher scratch state lives in a {@link CaptureEngine}.
 */
export class CapturePlan {
  /** The plan of a pattern without groups: nothing to recover. */
  static readonly NONE: CapturePlan = new CapturePlan(EMPTY, 0);

  readonly groupCount: number;
  readonly root: Ast;
  /** Every node of the tree numbered `0..n-1`. */
  readonly nodeIndex: ReadonlyMap<Ast, number>;
  /**
   * The nodes whose answers are worth remembering — concatenations,
   * alternations and repetitions — numbered `0..m-1` for the memo's rows. A
   * leaf answers in constant time and a group answers as its child does, so
   * neither gets a row; on real patterns that halves the memo.
   */
  readonly memoSlots: ReadonlyMap<Ast, number>;

  private constructor(root: Ast, groupCount: number) {
    this.root = root;
    this.groupCount = groupCount;
    const index = new Map<Ast, number>();
    const slots = new Map<Ast, number>();
    number(root, index, slots);
    this.nodeIndex = index;
    this.memoSlots = slots;
  }

  /** The plan for a parsed pattern; {@link NONE} when it has no groups. */
  static of(parsed: Parsed): CapturePlan {
    return parsed.groupCount === 0 ? CapturePlan.NONE : new CapturePlan(parsed.ast, parsed.groupCount);
  }

  get nodeCount(): number {
    return this.nodeIndex.size;
  }

  get memoCount(): number {
    return this.memoSlots.size;
  }

  newEngine(): CaptureEngine {
    return new CaptureEngine(this);
  }
}

function number(node: Ast, index: Map<Ast, number>, slots: Map<Ast, number>): void {
  if (!index.has(node)) {
    index.set(node, index.size);
  }
  switch (node.kind) {
    case 'concat':
    case 'alt':
      if (!slots.has(node)) {
        slots.set(node, slots.size);
      }
      for (const part of node.parts) {
        number(part, index, slots);
      }
      break;
    case 'repeat':
      if (!slots.has(node)) {
        slots.set(node, slots.size);
      }
      number(node.node, index, slots);
      break;
    case 'group':
      number(node.node, index, slots);
      break;
    default:
      break;
  }
}

const UNKNOWN = 0;
const NO = 1;
const YES = 2;

/**
 * Memoised exact-span matcher. The DFA already fixed `[from, to)`; this
 * recovers one greedy parse of that slice, so `.*` cannot explode.
 *
 * Every sub-span the engine asks about lies inside `[from, to]`, so the memo
 * is a flat byte array indexed by node, span start and span end (0 unknown,
 * 1 no, 2 yes) — no hashing, and the arrays are kept between runs. One per
 * matcher; not shareable.
 */
export class CaptureEngine {
  private readonly plan: CapturePlan;
  private readonly nodeIndex: ReadonlyMap<Ast, number>;
  private readonly memoSlots: ReadonlyMap<Ast, number>;
  private readonly memoCount: number;
  private input = '';
  private base = 0;
  private width = 0;
  private memo = new Uint8Array(0);
  private readonly concatMemo: (Uint8Array | null)[];
  private readonly repeatMemo = new Map<string, boolean>();
  private starts: Int32Array = new Int32Array(0);
  private ends: Int32Array = new Int32Array(0);

  constructor(plan: CapturePlan) {
    this.plan = plan;
    this.nodeIndex = plan.nodeIndex;
    this.memoSlots = plan.memoSlots;
    this.memoCount = plan.memoCount;
    this.concatMemo = new Array<Uint8Array | null>(this.memoCount).fill(null);
  }

  /**
   * Fills `starts[g]` and `ends[g]` for `g = 1..groupCount` from the match
   * `[from, to)` of `input`; a group that takes no part is left at -1.
   *
   * @throws Error if the tree does not match the span the automaton chose,
   *         which would mean the two disagree about the language
   */
  fill(input: string, from: number, to: number, starts: Int32Array, ends: Int32Array): void {
    if (this.plan.groupCount === 0 || to < from) {
      return;
    }
    this.reset(input, from, to);
    this.starts = starts;
    this.ends = ends;
    if (!this.exact(this.plan.root, from, to)) {
      throw new Error(`The capture plan does not match the span [${from}, ${to}) the automaton matched`);
    }
    this.reconstruct(this.plan.root, from, to);
  }

  private reset(input: string, from: number, to: number): void {
    this.input = input;
    this.base = from;
    this.width = to - from + 1;
    const need = this.memoCount * this.width * this.width;
    if (this.memo.length < need) {
      this.memo = new Uint8Array(need);
    } else {
      this.memo.fill(UNKNOWN, 0, need);
    }
    this.concatMemo.fill(null);
    this.repeatMemo.clear();
  }

  private cell(slot: number, from: number, to: number): number {
    return (slot * this.width + (from - this.base)) * this.width + (to - this.base);
  }

  /** Does `node` match exactly `[from, to)`? */
  private exact(node: Ast, from: number, to: number): boolean {
    if (from > to) {
      return false;
    }
    const slot = this.memoSlots.get(node);
    if (slot === undefined) {
      return this.exactUncached(node, from, to); // a leaf, or a group: nothing to remember
    }
    const cell = this.cell(slot, from, to);
    const cached = this.memo[cell]!;
    if (cached !== UNKNOWN) {
      return cached === YES;
    }
    const ok = this.exactUncached(node, from, to);
    this.memo[cell] = ok ? YES : NO;
    return ok;
  }

  private exactUncached(node: Ast, from: number, to: number): boolean {
    switch (node.kind) {
      case 'empty':
        return from === to;
      case 'chars':
        return to === from + 1 && node.set.contains(this.input.charCodeAt(from));
      case 'concat':
        return this.exactConcat(this.memoSlots.get(node)!, node.parts, 0, from, to);
      case 'alt':
        for (const part of node.parts) {
          if (this.exact(part, from, to)) {
            return true;
          }
        }
        return false;
      case 'repeat':
        return this.exactRepeat(node.node, node.min, node.max, from, to);
      case 'group':
        return this.exact(node.node, from, to);
    }
  }

  /** Does `parts[i..]` exactly cover `[from, to)`? Memoised per concat node (by its slot) and suffix. */
  private exactConcat(node: number, parts: readonly Ast[], i: number, from: number, to: number): boolean {
    let table = this.concatMemo[node];
    if (table === null || table === undefined) {
      table = new Uint8Array(parts.length * this.width * this.width);
      this.concatMemo[node] = table;
    }
    const cell = this.cell(i, from, to);
    const cached = table[cell]!;
    if (cached !== UNKNOWN) {
      return cached === YES;
    }
    const ok = this.exactConcatUncached(node, parts, i, from, to);
    table[cell] = ok ? YES : NO;
    return ok;
  }

  private exactConcatUncached(node: number, parts: readonly Ast[], i: number, from: number, to: number): boolean {
    if (i === parts.length) {
      return from === to;
    }
    if (i === parts.length - 1) {
      return this.exact(parts[i]!, from, to);
    }
    for (let mid = to; mid >= from; mid--) {
      if (this.exact(parts[i]!, from, mid) && this.exactConcat(node, parts, i + 1, mid, to)) {
        return true;
      }
    }
    return false;
  }

  private exactRepeat(child: Ast, min: number, max: number, from: number, to: number): boolean {
    const key = `${this.nodeIndex.get(child)},${min},${max},${from},${to}`;
    const cached = this.repeatMemo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const ok = this.exactRepeatUncached(child, min, max, from, to);
    this.repeatMemo.set(key, ok);
    return ok;
  }

  /**
   * Can `child`, iterated between `min` and `max` times, cover exactly
   * `[from, to)`? Round `k` computes the set of offsets reachable by `k`
   * iterations from `from`; the answer is whether `to` is reachable in some
   * round within the bounds. A round that repeats an earlier set starts a
   * cycle, and every later round is one of its members, so the search stops
   * there — this is what lets a nullable child under a large `min`, such as
   * `(a*){3}` on `a`, be answered without `min` rounds.
   */
  private exactRepeatUncached(child: Ast, min: number, max: number, from: number, to: number): boolean {
    const n = to - from;
    if (min === 0 && n === 0) {
      return true; // zero iterations cover the empty span
    }
    let reachable = new Uint8Array(n + 1);
    reachable[0] = 1;
    const history: Uint8Array[] = []; // history[k - 1] is the set after k rounds
    const seen = new Map<string, number>();
    for (let k = 1; max === UNBOUNDED || k <= max; k++) {
      const next = new Uint8Array(n + 1);
      let progressed = false;
      for (let i = 0; i <= n; i++) {
        if (reachable[i] === 0) {
          continue;
        }
        for (let j = i; j <= n; j++) {
          if (next[j] === 0 && this.exact(child, from + i, from + j)) {
            next[j] = 1;
            progressed = true;
          }
        }
      }
      if (!progressed) {
        return false; // nothing reachable: nor in any later round
      }
      if (k >= min && next[n] !== 0) {
        return true;
      }
      const key = next.join('');
      const k0 = seen.get(key);
      if (k0 !== undefined) {
        // Rounds k0, k0 + 1, ... repeat with period k - k0.
        const period = k - k0;
        if (max === UNBOUNDED) {
          for (let m = k0; m < k; m++) {
            if (history[m - 1]![n] !== 0) {
              return true; // every member recurs at rounds past min
            }
          }
          return false;
        }
        const first = Math.max(k + 1, min);
        const last = Math.min(max, first + period - 1);
        for (let r = first; r <= last; r++) {
          const m = k0 + ((r - k0) % period);
          if (history[m - 1]![n] !== 0) {
            return true;
          }
        }
        return false;
      }
      seen.set(key, k);
      history.push(next);
      reachable = next;
    }
    return false;
  }

  private reconstruct(node: Ast, from: number, to: number): void {
    switch (node.kind) {
      case 'group':
        if (node.index > 0) {
          this.starts[node.index] = from;
          this.ends[node.index] = to;
        }
        this.reconstruct(node.node, from, to);
        break;
      case 'concat':
        this.reconstructConcat(this.memoSlots.get(node)!, node.parts, 0, from, to);
        break;
      case 'alt':
        for (const part of node.parts) {
          if (this.exact(part, from, to)) {
            this.reconstruct(part, from, to);
            return;
          }
        }
        break;
      case 'repeat':
        this.reconstructRepeat(node.node, node.min, node.max, from, to);
        break;
      default:
        break;
    }
  }

  private reconstructConcat(node: number, parts: readonly Ast[], i: number, from: number, to: number): void {
    if (i === parts.length) {
      return;
    }
    if (i === parts.length - 1) {
      this.reconstruct(parts[i]!, from, to);
      return;
    }
    for (let mid = to; mid >= from; mid--) {
      if (this.exact(parts[i]!, from, mid) && this.exactConcat(node, parts, i + 1, mid, to)) {
        this.reconstruct(parts[i]!, from, mid);
        this.reconstructConcat(node, parts, i + 1, mid, to);
        return;
      }
    }
  }

  /**
   * Each iteration takes as much as still lets the remaining iterations cover
   * the rest. Iterations that would match the empty string are not taken, so
   * a group under a star keeps its last non-empty iteration.
   */
  private reconstructRepeat(child: Ast, min: number, max: number, from: number, to: number): void {
    let p = from;
    let taken = 0;
    while ((max === UNBOUNDED || taken < max) && p < to) {
      let found = false;
      for (let mid = to; mid > p; mid--) {
        const remainMin = Math.max(0, min - taken - 1);
        const remainMax = max === UNBOUNDED ? UNBOUNDED : max - taken - 1;
        if (this.exact(child, p, mid) && this.exactRepeat(child, remainMin, remainMax, mid, to)) {
          this.reconstruct(child, p, mid);
          p = mid;
          taken++;
          found = true;
          break;
        }
      }
      if (!found) {
        break;
      }
    }
  }
}

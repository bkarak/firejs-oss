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
import type { FlattenedDfa } from './flatten.ts';
import type { CodeGenerator } from './generator.ts';
import { TableRegex } from './interpreter.ts';
import type { Parsed } from './parser.ts';
import { Regex } from './regex.ts';

/**
 * The character space cut at every range boundary of an automaton. The class
 * of a code unit is the number of cut points at or below it, so there are
 * `cuts.length + 1` classes, and a code unit at or above the last cut point is
 * in the last one, which needs no table entry.
 *
 * This is the class map of FIRE/J's default code generator and of the Brics
 * `RunAutomaton`: a state with many ranges resolves a code unit with one
 * table load instead of a compare chain.
 */
export class Partition {
  /** The cut points, ascending, none of them 0. */
  readonly cuts: readonly number[];
  /** Code unit → class, for code units below the last cut point. */
  readonly map: Uint16Array;

  constructor(dfa: FlattenedDfa) {
    const set = new Set<number>();
    for (const edges of dfa.transitions) {
      for (const edge of edges) {
        if (edge.min > 0) {
          set.add(edge.min);
        }
        if (edge.max < CharSet.MAX) {
          set.add(edge.max + 1);
        }
      }
    }
    const cuts = [...set].sort((a, b) => a - b);
    this.cuts = cuts;
    const mapLength = cuts.length === 0 ? 0 : cuts[cuts.length - 1]!;
    const map = new Uint16Array(mapLength);
    let cls = 0;
    for (let c = 0; c < mapLength; c++) {
      while (cls < cuts.length && cuts[cls]! <= c) {
        cls++;
      }
      map[c] = cls;
    }
    this.map = map;
  }

  get classCount(): number {
    return this.cuts.length + 1;
  }

  /** The class of code units at or above the last cut point. */
  get lastClass(): number {
    return this.cuts.length;
  }

  /** The class of `c`: cut points at or below it. */
  classOf(c: number): number {
    let lo = 0;
    let hi = this.cuts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cuts[mid]! <= c) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}

/** Past this many table cells the dense form is not worth its memory. Increased from 8M to 12M to keep more patterns in the cache-friendly dense form. */
export const MAX_CELLS = 12_000_000;

/**
 * An automaton's transitions in a form a loop can step through: densely,
 * `table[state * classes + classOf(c)]`, when that fits {@link MAX_CELLS},
 * and otherwise the sorted ranges of each state. `step` is the one
 * operation; -1 is the dead state.
 */
export class Tables {
  readonly startState: number;
  readonly accept: Uint8Array;
  readonly dense: boolean;
  /** Dense form. */
  readonly map: Uint16Array;
  readonly mapLength: number;
  readonly lastClass: number;
  readonly classes: number;
  readonly table: Int32Array;
  /** Range form: the edges of state `s` are `edgeStart[s]..edgeStart[s + 1]`. */
  readonly edgeStart: Int32Array;
  readonly lo: Int32Array;
  readonly hi: Int32Array;
  readonly dest: Int32Array;

  constructor(dfa: FlattenedDfa) {
    const n = dfa.stateCount;
    this.startState = dfa.startState;
    this.accept = new Uint8Array(n);
    let edges = 0;
    for (let s = 0; s < n; s++) {
      this.accept[s] = dfa.accept[s] ? 1 : 0;
      edges += dfa.transitions[s]!.length;
    }
    const partition = new Partition(dfa);
    this.dense = n * partition.classCount <= MAX_CELLS;
    if (this.dense) {
      this.map = partition.map;
      this.mapLength = partition.map.length;
      this.lastClass = partition.lastClass;
      this.classes = partition.classCount;
      this.table = new Int32Array(n * this.classes).fill(-1);
      for (let s = 0; s < n; s++) {
        for (const r of dfa.transitions[s]!) {
          const from = partition.classOf(r.min);
          const to = partition.classOf(r.max);
          for (let cls = from; cls <= to; cls++) {
            this.table[s * this.classes + cls] = r.dest;
          }
        }
      }
      this.edgeStart = new Int32Array(0);
      this.lo = new Int32Array(0);
      this.hi = new Int32Array(0);
      this.dest = new Int32Array(0);
    } else {
      this.map = new Uint16Array(0);
      this.mapLength = 0;
      this.lastClass = 0;
      this.classes = 0;
      this.table = new Int32Array(0);
      this.edgeStart = new Int32Array(n + 1);
      this.lo = new Int32Array(edges);
      this.hi = new Int32Array(edges);
      this.dest = new Int32Array(edges);
      let e = 0;
      for (let s = 0; s < n; s++) {
        this.edgeStart[s] = e;
        for (const r of dfa.transitions[s]!) {
          this.lo[e] = r.min;
          this.hi[e] = r.max;
          this.dest[e] = r.dest;
          e++;
        }
      }
      this.edgeStart[n] = e;
    }
  }

  /** The state after reading `c` in `state`, or -1. */
  step(state: number, c: number): number {
    if (this.dense) {
      const cls = c < this.mapLength ? this.map[c]! : this.lastClass;
      return this.table[state * this.classes + cls]!;
    }
    let e = this.edgeStart[state]!;
    const end = this.edgeStart[state + 1]!;
    while (e < end && c > this.hi[e]!) {
      e++;
    }
    return e === end || c < this.lo[e]! ? -1 : this.dest[e]!;
  }
}

/**
 * Walks a dense transition table: `table[state * classes + classOf(c)]` is
 * the next state or -1. Two array loads per code unit and no branch on the
 * ranges — the Brics `RunAutomaton` design, the table-driven rung of the
 * ablation that generated code is measured against.
 */
export class DenseRegex extends Regex {
  private readonly startState: number;
  private readonly startAnchored: boolean;
  private readonly endAnchored: boolean;
  private readonly accept: Uint8Array;
  private readonly map: Uint16Array;
  private readonly mapLength: number;
  private readonly lastClass: number;
  private readonly classes: number;
  private readonly table: Int32Array;

  constructor(dfa: FlattenedDfa, parsed: Parsed, partition: Partition) {
    super(dfa, parsed);
    const n = dfa.stateCount;
    this.startState = dfa.startState;
    this.startAnchored = dfa.anchoredStart;
    this.endAnchored = dfa.anchoredEnd;
    this.map = partition.map;
    this.mapLength = partition.map.length;
    this.lastClass = partition.lastClass;
    this.classes = partition.classCount;
    this.accept = new Uint8Array(n);
    this.table = new Int32Array(n * this.classes).fill(-1);
    for (let s = 0; s < n; s++) {
      this.accept[s] = dfa.accept[s] ? 1 : 0;
      for (const r of dfa.transitions[s]!) {
        const from = partition.classOf(r.min);
        const to = partition.classOf(r.max);
        for (let cls = from; cls <= to; cls++) {
          this.table[s * this.classes + cls] = r.dest;
        }
      }
    }
  }

  override exec(input: string, start = 0): number {
    const len = input.length;
    this.checkStart(start, len);
    if (this.startAnchored && start !== 0) {
      return -1;
    }
    const accept = this.accept;
    const map = this.map;
    const mapLength = this.mapLength;
    const lastClass = this.lastClass;
    const classes = this.classes;
    const table = this.table;
    let state = this.startState;
    let returnValue = accept[state] !== 0 ? start : -1;

    for (let i = start; i < len; i++) {
      const c = input.charCodeAt(i);
      const cls = c < mapLength ? map[c]! : lastClass;
      state = table[state * classes + cls]!;
      if (state < 0) {
        break;
      }
      if (accept[state] !== 0) {
        returnValue = i + 1;
      }
    }
    return this.endAnchored && returnValue !== len ? -1 : returnValue;
  }
}

/**
 * The dense-table walker as a generator. An automaton too large to table
 * densely falls back to the range-scanning {@link TableRegex}.
 */
export const denseGenerator: CodeGenerator = {
  name: 'dense',
  compile(dfa: FlattenedDfa, parsed: Parsed): Regex {
    const partition = new Partition(dfa);
    if (dfa.stateCount * partition.classCount > MAX_CELLS) {
      return new TableRegex(dfa, parsed);
    }
    return new DenseRegex(dfa, parsed, partition);
  },
};

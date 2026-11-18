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
import type { FlattenedDfa } from './flatten.ts';
import type { Parsed } from './parser.ts';
import { Regex } from './regex.ts';
import type { CodeGenerator } from './generator.ts';

/**
 * Walks a flattened DFA over typed-array tables at match time: the back end
 * that needs no code generation, so it runs where `new Function` is refused,
 * and the oracle the generated walkers are tested against.
 *
 * The transitions of all states live in three parallel arrays indexed by
 * edge, with `edgeStart[s]..edgeStart[s + 1]` the edges of state `s`, sorted
 * by range; a state resolves a code unit by scanning them in order.
 */
export class TableRegex extends Regex {
  private readonly startState: number;
  private readonly startAnchored: boolean;
  private readonly endAnchored: boolean;
  private readonly accept: Uint8Array;
  private readonly edgeStart: Int32Array;
  private readonly lo: Int32Array;
  private readonly hi: Int32Array;
  private readonly dest: Int32Array;

  constructor(dfa: FlattenedDfa, parsed: Parsed) {
    super(dfa, parsed);
    const n = dfa.stateCount;
    this.startState = dfa.startState;
    this.startAnchored = dfa.anchoredStart;
    this.endAnchored = dfa.anchoredEnd;
    this.accept = new Uint8Array(n);
    this.edgeStart = new Int32Array(n + 1);
    let edges = 0;
    for (let s = 0; s < n; s++) {
      this.accept[s] = dfa.accept[s] ? 1 : 0;
      this.edgeStart[s] = edges;
      edges += dfa.transitions[s]!.length;
    }
    this.edgeStart[n] = edges;
    this.lo = new Int32Array(edges);
    this.hi = new Int32Array(edges);
    this.dest = new Int32Array(edges);
    let e = 0;
    for (let s = 0; s < n; s++) {
      for (const r of dfa.transitions[s]!) {
        this.lo[e] = r.min;
        this.hi[e] = r.max;
        this.dest[e] = r.dest;
        e++;
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
    const edgeStart = this.edgeStart;
    const lo = this.lo;
    const hi = this.hi;
    const dest = this.dest;
    let state = this.startState;
    let returnValue = accept[state] !== 0 ? start : -1;

    for (let i = start; i < len; i++) {
      const c = input.charCodeAt(i);
      let e = edgeStart[state]!;
      const end = edgeStart[state + 1]!;
      // Ranges are sorted and disjoint: stop at the first one past c.
      while (e < end && c > hi[e]!) {
        e++;
      }
      if (e === end || c < lo[e]!) {
        break;
      }
      state = dest[e]!;
      if (accept[state] !== 0) {
        returnValue = i + 1;
      }
    }
    return this.endAnchored && returnValue !== len ? -1 : returnValue;
  }
}

/** The table walker as a generator: every engine configuration can use it. */
export const tableGenerator: CodeGenerator = {
  name: 'table',
  compile(dfa: FlattenedDfa, parsed: Parsed): Regex {
    return new TableRegex(dfa, parsed);
  },
};

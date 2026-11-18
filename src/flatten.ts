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
import type { Det } from './dfa.ts';

/** An edge on the inclusive code-unit range `[min, max]`. */
export interface Range {
  readonly min: number;
  readonly max: number;
  readonly dest: number;
}

/**
 * Dense, generator-friendly snapshot of a DFA: states numbered `0..n-1`,
 * transitions sorted by range.
 *
 * States are numbered in depth-first preorder from the initial state,
 * following transitions in range order, so that consecutive numbers follow
 * the paths a walk takes: generated code lays its blocks out in that order
 * and the table walker's rows stay local. Unreachable states, if any, come
 * last. The numbering depends on the automaton's structure alone, so two
 * implementations that build the same minimal automaton number it the same
 * way — which is what {@link FlattenedDfa.encode} relies on.
 *
 * `anchoredStart` means the pattern began with `^`: a match may only start at
 * offset 0. `anchoredEnd` means it ended with `$`: the match must consume the
 * input to its end. The DFA is longest-match, so if the longest match stops
 * short of the end no accepted prefix reaches it, and the walk simply turns
 * such a result into -1.
 */
export class FlattenedDfa {
  readonly pattern: string;
  readonly startState: number;
  readonly accept: readonly boolean[];
  readonly transitions: readonly (readonly Range[])[];
  readonly anchoredStart: boolean;
  readonly anchoredEnd: boolean;

  constructor(
    pattern: string,
    startState: number,
    accept: readonly boolean[],
    transitions: readonly (readonly Range[])[],
    anchoredStart: boolean,
    anchoredEnd: boolean,
  ) {
    this.pattern = pattern;
    this.startState = startState;
    this.accept = accept;
    this.transitions = transitions;
    this.anchoredStart = anchoredStart;
    this.anchoredEnd = anchoredEnd;
  }

  get stateCount(): number {
    return this.accept.length;
  }

  /** From a determinised automaton, with its states renumbered along walk paths. */
  static from(pattern: string, det: Det, anchoredStart: boolean, anchoredEnd: boolean): FlattenedDfa {
    const n = det.stateCount;
    const accept = det.accept.slice();
    const transitions: Range[][] = [];
    for (let i = 0; i < n; i++) {
      const ranges: Range[] = det.trans[i]!.map((e) => ({ min: e[0]!, max: e[1]!, dest: e[2]! }));
      ranges.sort((a, b) => a.min - b.min || a.max - b.max);
      transitions.push(ranges);
    }
    return renumber(pattern, det.initial, accept, transitions, anchoredStart, anchoredEnd);
  }

  /**
   * A canonical text form of the automaton: one entry per state in order,
   * `A` or `-` for the accept flag, then every transition as `lo-hi>dest`.
   * Two implementations that build the same minimal automaton produce the
   * same string, which is how the port is checked against FIRE/J.
   */
  encode(): string {
    const parts: string[] = [];
    for (let s = 0; s < this.stateCount; s++) {
      let b = this.accept[s] ? 'A' : '-';
      for (const r of this.transitions[s]!) {
        b += `,${r.min}-${r.max}>${r.dest}`;
      }
      parts.push(b);
    }
    return parts.join(';');
  }

  /** This automaton in the Graphviz DOT language, for `dot -Tsvg` and friends. */
  toDot(): string {
    let out = 'digraph dfa {\n\trankdir=LR;\n';
    if (this.pattern.length > 0) {
      out += `\tlabel=${dotQuote(this.pattern)};\n\tlabelloc=t;\n`;
    }
    out += '\tnode [shape=circle];\n\tstart [shape=point];\n';
    out += `\tstart -> ${this.startState}${this.anchoredStart ? ' [label="^"]' : ''};\n`;
    for (let s = 0; s < this.stateCount; s++) {
      if (this.accept[s]) {
        out += `\t${s} [shape=doublecircle${this.anchoredEnd ? ',xlabel="$"' : ''}];\n`;
      }
    }
    for (let s = 0; s < this.stateCount; s++) {
      const byDest = new Map<number, string[]>();
      for (const r of this.transitions[s]!) {
        let labels = byDest.get(r.dest);
        if (labels === undefined) {
          labels = [];
          byDest.set(r.dest, labels);
        }
        labels.push(r.min === r.max ? dotChar(r.min) : `${dotChar(r.min)}-${dotChar(r.max)}`);
      }
      for (const [dest, labels] of byDest) {
        out += `\t${s} -> ${dest} [label=${dotQuote(labels.join(', '))}];\n`;
      }
    }
    return out + '}\n';
  }
}

/** Renumbers the states in depth-first preorder from `start`. */
function renumber(
  pattern: string,
  start: number,
  accept: boolean[],
  transitions: Range[][],
  anchoredStart: boolean,
  anchoredEnd: boolean,
): FlattenedDfa {
  const n = accept.length;
  const order = new Int32Array(n);
  const rank = new Int32Array(n).fill(-1);
  let count = 0;
  const stack: number[] = [start];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (rank[s]! >= 0) {
      continue;
    }
    rank[s] = count;
    order[count++] = s;
    const edges = transitions[s]!;
    for (let e = edges.length - 1; e >= 0; e--) {
      if (rank[edges[e]!.dest]! < 0) {
        stack.push(edges[e]!.dest);
      }
    }
  }
  for (let s = 0; s < n; s++) {
    if (rank[s]! < 0) {
      rank[s] = count;
      order[count++] = s;
    }
  }
  const newAccept: boolean[] = new Array<boolean>(n);
  const newTransitions: Range[][] = new Array<Range[]>(n);
  for (let i = 0; i < n; i++) {
    const old = order[i]!;
    newAccept[i] = accept[old]!;
    newTransitions[i] = transitions[old]!.map((r) => ({ min: r.min, max: r.max, dest: rank[r.dest]! }));
  }
  return new FlattenedDfa(pattern, rank[start]!, newAccept, newTransitions, anchoredStart, anchoredEnd);
}

function dotChar(c: number): string {
  return c > 0x20 && c < 0x7f ? String.fromCharCode(c) : `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** A DOT string literal: only `"` and `\` need escaping. */
function dotQuote(s: string): string {
  let b = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) {
      b += '\\';
    }
    b += c < 0x20 ? `U+${c.toString(16).toUpperCase().padStart(4, '0')}` : s.charAt(i);
  }
  return b + '"';
}

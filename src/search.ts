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
import { type Ast, UNBOUNDED, chars, concat, repeat, reverse } from './ast.ts';
import { CharSet } from './charset.ts';
import { Tables } from './dense.ts';
import { compileDfa } from './dfa.ts';
import { FlattenedDfa } from './flatten.ts';

/**
 * Where matches start, found backward.
 *
 * A DFA walked forward from an offset says how far a match from there
 * reaches, not where the leftmost match begins; finding that by trying every
 * offset costs the input's length times the match's. The automaton of the
 * *reversed* pattern preceded by anything — `.*` over every code unit, then
 * `reverse(p)` — read over the input from its end towards its start, is in an
 * accepting state exactly after consuming `input[s..]` for every `s` at which
 * some match of `p` begins: the reversed suffix then ends with a reversed
 * member of `L(p)`. One pass over the input marks every start.
 *
 * A pattern anchored at the end needs the match to reach the end, so its
 * starts are the offsets from which `input[s..]` is itself in `L(p)`: the
 * reversed pattern alone, no prefix. A pattern anchored at the start can only
 * match at 0 and never comes here.
 */
export class SearchAutomaton {
  private readonly tables: Tables;

  constructor(dfa: FlattenedDfa, ast: Ast) {
    const reversed = reverse(ast);
    const language = dfa.anchoredEnd ? reversed : concat([repeat(chars(CharSet.ANY), 0, UNBOUNDED), reversed]);
    this.tables = new Tables(FlattenedDfa.from(dfa.pattern, compileDfa(language), false, false));
  }

  /** A byte per offset `0..input.length`: 1 where a match starts. */
  starts(input: string): Uint8Array {
    const len = input.length;
    const out = new Uint8Array(len + 1);
    const tables = this.tables;
    const accept = tables.accept;
    let state = tables.startState;
    out[len] = accept[state]!;
    for (let i = len - 1; i >= 0; i--) {
      state = tables.step(state, input.charCodeAt(i));
      if (state < 0) {
        break; // the reversed language has no continuation: no earlier start
      }
      out[i] = accept[state]!;
    }
    return out;
  }
}

/**
 * A matcher fed its input in pieces. The automaton's state is kept between
 * chunks, so a stream is matched as it arrives, without being joined: what
 * `exec(whole, 0)` would answer for the chunks seen so far.
 */
export class StreamMatcher {
  private readonly tables: Tables;
  private readonly anchoredEnd: boolean;
  private state: number;
  /** Code units consumed so far. */
  private total = 0;
  /** The exclusive end of the longest match from offset 0 so far, or -1. */
  private longest: number;

  constructor(dfa: FlattenedDfa) {
    this.tables = new Tables(dfa);
    this.anchoredEnd = dfa.anchoredEnd;
    this.state = this.tables.startState;
    this.longest = this.tables.accept[this.state] !== 0 ? 0 : -1;
  }

  /** Whether more input could still extend or produce a match. */
  get alive(): boolean {
    return this.state >= 0;
  }

  /** Code units fed so far. */
  get consumed(): number {
    return this.total;
  }

  /** Reads a chunk; cheap once the automaton is dead. Returns this. */
  feed(chunk: string): this {
    const tables = this.tables;
    const accept = tables.accept;
    let state = this.state;
    const base = this.total;
    const len = chunk.length;
    this.total = base + len;
    if (state < 0) {
      return this;
    }
    for (let i = 0; i < len; i++) {
      state = tables.step(state, chunk.charCodeAt(i));
      if (state < 0) {
        break;
      }
      if (accept[state] !== 0) {
        this.longest = base + i + 1;
      }
    }
    this.state = state;
    return this;
  }

  /**
   * The exclusive end, in the whole stream, of the longest match from offset
   * 0 of everything fed so far, or -1 — with the `$` rule applied as if the
   * stream ended here.
   */
  end(): number {
    return this.anchoredEnd && this.longest !== this.total ? -1 : this.longest;
  }

  /** Whether everything fed so far is a match, as `matches` would say of the joined chunks. */
  matches(): boolean {
    return this.end() === this.total;
  }

  /** Starts over, for the next stream. */
  reset(): this {
    this.state = this.tables.startState;
    this.total = 0;
    this.longest = this.tables.accept[this.state] !== 0 ? 0 : -1;
    return this;
  }
}

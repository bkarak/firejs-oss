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
import type { CharSet } from './charset.ts';

/** `max` of a repetition with no upper limit. */
export const UNBOUNDED = -1;

/**
 * The syntax tree of a regular expression, over character *sets* rather than
 * characters.
 *
 * There is no node for a shorthand, a named class or a negated class: `\d`,
 * `[[:digit:]]` and `[^a-z]` all arrive as a `chars` node holding the set they
 * denote. The dialect is decided in the parser and does not survive into the
 * tree, so everything downstream — the automaton construction, the
 * determiniser, the minimiser, the capture plan — sees one shape.
 */
export type Ast =
  /** Matches the empty string. */
  | { readonly kind: 'empty' }
  /** Matches one code unit drawn from a set. */
  | { readonly kind: 'chars'; readonly set: CharSet }
  /** One after another. */
  | { readonly kind: 'concat'; readonly parts: readonly Ast[] }
  /** One of several. */
  | { readonly kind: 'alt'; readonly parts: readonly Ast[] }
  /**
   * `node` repeated between `min` and `max` times, where `max === UNBOUNDED`
   * means no upper limit. A lazy or possessive suffix in the source is dropped
   * by the parser: it selects which match a backtracking engine reports, and
   * this engine reports the longest one regardless, so it cannot change the
   * language a DFA accepts.
   */
  | { readonly kind: 'repeat'; readonly node: Ast; readonly min: number; readonly max: number }
  /**
   * A parenthesised group. `index` is its 1-based capturing-group number, or
   * 0 for a non-capturing `(?:...)`. The automaton has no notion of a group;
   * the index is what the capture plan recovers groups by, after the span is
   * fixed.
   */
  | { readonly kind: 'group'; readonly node: Ast; readonly index: number; readonly name: string | null };

export const EMPTY: Ast = { kind: 'empty' };

export function chars(set: CharSet): Ast {
  return { kind: 'chars', set };
}

export function concat(parts: readonly Ast[]): Ast {
  return { kind: 'concat', parts };
}

export function alt(parts: readonly Ast[]): Ast {
  return { kind: 'alt', parts };
}

export function repeat(node: Ast, min: number, max: number): Ast {
  return { kind: 'repeat', node, min, max };
}

export function group(node: Ast, index: number, name: string | null = null): Ast {
  return { kind: 'group', node, index, name };
}

/**
 * The tree of the reversed language: every concatenation read right to left.
 * `L(reverse(a)) = { reverse(w) : w in L(a) }`, which is what a search
 * automaton walks backward over the input to find where matches start.
 */
export function reverse(node: Ast): Ast {
  switch (node.kind) {
    case 'empty':
    case 'chars':
      return node;
    case 'concat':
      return concat(node.parts.map(reverse).reverse());
    case 'alt':
      return alt(node.parts.map(reverse));
    case 'repeat':
      return repeat(reverse(node.node), node.min, node.max);
    case 'group':
      return group(reverse(node.node), node.index, node.name);
  }
}

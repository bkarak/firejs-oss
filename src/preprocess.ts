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
import { RegexCompilationError } from './errors.ts';

/**
 * The expression to build an automaton from, and the anchors that were lifted
 * out of it.
 *
 * An automaton has no notion of position, so an anchor cannot be part of the
 * language it recognises; the walk enforces the two flags instead.
 */
export interface Lifted {
  readonly expression: string;
  /** The pattern began with `^` (or `\A`): a match may only start at offset 0. */
  readonly anchoredStart: boolean;
  /** The pattern ended with `$` (or `\z`, `\Z`): the match must consume the input to its end. */
  readonly anchoredEnd: boolean;
}

/**
 * The first stage of the pipeline: lift a leading `^` and a trailing `$` out
 * of the pattern, and hand the rest on exactly as written.
 *
 * The scan knows about escapes, `\Q...\E` regions and character classes,
 * because getting that wrong is how a pattern comes to mean something other
 * than what it says: the literal dollar in `\Qfoo$` must not become an anchor,
 * and `[]]` must not end its class one character early.
 *
 * Either anchor beside a top-level `|` binds to a single branch — in `a|b$`
 * the `$` applies to `b` alone — which a DFA cannot express, so that is refused.
 */
export function liftAnchors(regex: string): Lifted {
  const n = regex.length;
  let begin = 0;
  let start = false;
  if (regex.startsWith('^')) {
    start = true;
    begin = 1;
  } else if (regex.startsWith('\\A')) {
    start = true;
    begin = 2;
  }

  let topLevelAlternation = false;
  let depth = 0;
  let inClass = false;
  let dollarAtEnd = -1; // index of a '$' that is structurally last
  let trailingEscape = 0; // 2 when the pattern ends with \z or \Z

  for (let i = begin; i < n; i++) {
    const c = regex.charAt(i);

    if (c === '\\') {
      if (i + 1 >= n) {
        throw new RegexCompilationError(`Trailing backslash in: ${regex}`);
      }
      const d = regex.charAt(i + 1);
      if (d === 'Q') {
        const close = regex.indexOf('\\E', i + 2);
        i = close < 0 ? n - 1 : close + 1;
        continue;
      }
      if (!inClass && (d === 'z' || d === 'Z') && i + 2 === n) {
        trailingEscape = 2;
        break;
      }
      i++; // an escaped character is never structural
      continue;
    }

    if (inClass) {
      if (c === ']') {
        inClass = false;
      }
      continue;
    }

    switch (c) {
      case '[': {
        inClass = true;
        let j = i + 1;
        if (j < n && regex.charAt(j) === '^') {
          j++;
        }
        if (j < n && regex.charAt(j) === ']') {
          j++; // a ']' straight after '[' or '[^' is a literal, not the end
        }
        i = j - 1;
        break;
      }
      case '(':
        depth++;
        if (regex.startsWith('(?:', i)) {
          i += 2;
        } else if (
          regex.startsWith('(?P<', i) ||
          (regex.startsWith('(?<', i) &&
            i + 3 < n &&
            regex.charAt(i + 3) !== '=' &&
            regex.charAt(i + 3) !== '!')
        ) {
          const close = regex.indexOf('>', i);
          if (close < 0) {
            throw new RegexCompilationError(`Unterminated group name in: ${regex}`);
          }
          i = close;
        } else if (i + 1 < n && regex.charAt(i + 1) === '?') {
          // lookaround, inline flags, conditionals: the parser reports these
          depth--;
        }
        break;
      case ')':
        depth--;
        break;
      case '|':
        if (depth === 0) {
          topLevelAlternation = true;
        }
        break;
      case '$':
        dollarAtEnd = i === n - 1 ? i : -1;
        break;
      default:
        break;
    }
  }

  const end = trailingEscape > 0 || dollarAtEnd >= 0;
  const expression = regex.substring(begin, n - (trailingEscape > 0 ? 2 : dollarAtEnd >= 0 ? 1 : 0));

  if ((start || end) && topLevelAlternation) {
    throw new RegexCompilationError(
      `An anchor beside a top-level '|' binds to one branch only, which a DFA cannot express: ${regex}`,
    );
  }
  return { expression, anchoredStart: start, anchoredEnd: end };
}

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
import { type Ast, EMPTY, UNBOUNDED, alt, chars, concat, group, repeat } from './ast.ts';
import { RegexCompilationError } from './errors.ts';

/**
 * Which spelling of a regular expression the front end accepts.
 *
 * Both dialects compile to the same automaton and match with the same
 * leftmost-longest semantics; they differ only in what a programmer is
 * allowed to write.
 *
 * - `extended` (the default): POSIX ERE with a short list of conveniences —
 *   the shorthands `\d \w \s` and their negations, `\p{Name}`, the escapes
 *   that name a character (`\t \n \xHH` and the rest), `\Q...\E`, and
 *   non-capturing and named groups. It is deliberately *not* PCRE: there is
 *   no lookaround, there are no backreferences, no word boundaries and no
 *   inline flags, and adding them would need an NFA.
 * - `posix`: POSIX ERE and nothing else. `[[:digit:]]` is the way to say
 *   "a digit"; `\d` is rejected rather than quietly taken as the letter d.
 */
export type Dialect = 'extended' | 'posix';

export interface Parsed {
  readonly ast: Ast;
  /** The number of capturing groups, numbered left to right by their `(`. */
  readonly groupCount: number;
  /** Named groups, by name, to their 1-based index. */
  readonly groupNames: ReadonlyMap<string, number>;
}

const DIGIT = CharSet.range(0x30, 0x39);
const SPACE = CharSet.ranges(0x09, 0x0d, 0x20, 0x20);
const WORD = CharSet.ranges(0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a);

const SHORTHANDS: ReadonlyMap<string, CharSet> = new Map([
  ['d', DIGIT],
  ['D', DIGIT.complement()],
  ['s', SPACE],
  ['S', SPACE.complement()],
  ['w', WORD],
  ['W', WORD.complement()],
]);

const NAMED: ReadonlyMap<string, CharSet> = new Map([
  ['lower', CharSet.range(0x61, 0x7a)],
  ['upper', CharSet.range(0x41, 0x5a)],
  ['ascii', CharSet.range(0x00, 0x7f)],
  ['alpha', CharSet.ranges(0x41, 0x5a, 0x61, 0x7a)],
  ['digit', DIGIT],
  ['alnum', CharSet.ranges(0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a)],
  ['punct', CharSet.ranges(0x21, 0x2f, 0x3a, 0x40, 0x5b, 0x60, 0x7b, 0x7e)],
  ['graph', CharSet.range(0x21, 0x7e)],
  ['print', CharSet.range(0x20, 0x7e)],
  ['blank', CharSet.ranges(0x09, 0x09, 0x20, 0x20)],
  ['cntrl', CharSet.ranges(0x00, 0x1f, 0x7f, 0x7f)],
  ['xdigit', CharSet.ranges(0x30, 0x39, 0x41, 0x46, 0x61, 0x66)],
  ['space', SPACE],
  ['word', WORD],
]);

/** `.` is every code unit but a newline, as Perl, PCRE, Go and Rust read it. */
const DOT = CharSet.of(0x0a).complement();

const LETTER = /^\p{L}$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;
const MAX_INT = 0x7fffffff;

/**
 * Parses pattern text to an {@link Ast}, reading the dialect directly.
 *
 * Grammar, loosest binding first:
 *
 *     alternation := concat ('|' concat)*
 *     concat      := repeat*
 *     repeat      := atom ('*' | '+' | '?' | '{n,m}')* ('?' | '+')?
 *     atom        := '(' alternation ')' | '[' class ']' | '.' | escape | literal
 *
 * A character class is parsed into a {@link CharSet} here: `\d`,
 * `[[:digit:]]`, `[a-f0-9]` and `[^\s]` all become a set, and no rewriting of
 * the pattern text happens anywhere. Anchors are handled by the caller
 * (`liftAnchors`) and are rejected here if they appear where the caller could
 * not lift them.
 */
export function parse(src: string, dialect: Dialect = 'extended'): Parsed {
  return new Parser(src, dialect).parse();
}

class Parser {
  private readonly src: string;
  private readonly dialect: Dialect;
  private pos = 0;
  private groups = 0;
  private readonly names = new Map<string, number>();

  constructor(src: string, dialect: Dialect) {
    this.src = src;
    this.dialect = dialect;
  }

  parse(): Parsed {
    const a = this.alternation();
    if (this.pos < this.src.length) {
      throw this.err(`Unexpected '${this.src.charAt(this.pos)}' at offset ${this.pos}`);
    }
    return { ast: a, groupCount: this.groups, groupNames: this.names };
  }

  private err(msg: string): RegexCompilationError {
    return new RegexCompilationError(`${msg} in: ${this.src}`);
  }

  private notPosix(what: string, instead: string): RegexCompilationError {
    return new RegexCompilationError(
      `${what} is not POSIX ERE (use ${instead}) in: ${this.src}` +
        " -- compiled with the 'posix' dialect; 'extended' accepts it",
    );
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  /** The character at the cursor; callers check {@link eof} first. */
  private peek(): string {
    return this.src.charAt(this.pos);
  }

  // --- grammar ------------------------------------------------------------

  private alternation(): Ast {
    const parts: Ast[] = [this.concat()];
    while (!this.eof() && this.peek() === '|') {
      this.pos++;
      parts.push(this.concat());
    }
    return parts.length === 1 ? parts[0]! : alt(parts);
  }

  private concat(): Ast {
    const parts: Ast[] = [];
    while (!this.eof() && this.peek() !== '|' && this.peek() !== ')') {
      parts.push(this.repeat());
    }
    switch (parts.length) {
      case 0:
        return EMPTY;
      case 1:
        return parts[0]!;
      default:
        return concat(parts);
    }
  }

  private repeat(): Ast {
    let a = this.atom();
    while (!this.eof()) {
      const c = this.peek();
      let min: number;
      let max: number;
      if (c === '*') {
        min = 0;
        max = UNBOUNDED;
        this.pos++;
      } else if (c === '+') {
        min = 1;
        max = UNBOUNDED;
        this.pos++;
      } else if (c === '?') {
        min = 0;
        max = 1;
        this.pos++;
      } else if (c === '{' && this.boundedAhead()) {
        this.pos++;
        const lo = this.number();
        let hi: number;
        if (!this.eof() && this.peek() === ',') {
          this.pos++;
          hi = !this.eof() && this.peek() === '}' ? UNBOUNDED : this.number();
        } else {
          hi = lo;
        }
        if (this.eof() || this.peek() !== '}') {
          throw this.err('Unterminated {n,m}');
        }
        this.pos++;
        if (hi !== UNBOUNDED && hi < lo) {
          throw this.err(`Repetition {${lo},${hi}} counts down`);
        }
        min = lo;
        max = hi;
      } else {
        break;
      }
      // A lazy or possessive suffix picks which match a backtracker reports;
      // this engine reports the longest, so the suffix cannot change the
      // language and is dropped.
      if (!this.eof() && (this.peek() === '?' || this.peek() === '+')) {
        this.pos++;
      }
      a = repeat(a, min, max);
    }
    return a;
  }

  /** True when '{' really opens a bound, rather than being a literal brace. */
  private boundedAhead(): boolean {
    const src = this.src;
    let i = this.pos + 1;
    if (i >= src.length || !isDigit(src.charCodeAt(i))) {
      return false;
    }
    while (i < src.length && isDigit(src.charCodeAt(i))) {
      i++;
    }
    if (i < src.length && src.charAt(i) === ',') {
      i++;
      while (i < src.length && isDigit(src.charCodeAt(i))) {
        i++;
      }
    }
    return i < src.length && src.charAt(i) === '}';
  }

  private number(): number {
    const start = this.pos;
    while (!this.eof() && isDigit(this.src.charCodeAt(this.pos))) {
      this.pos++;
    }
    if (start === this.pos) {
      throw this.err('Expected a number in {n,m}');
    }
    const v = Number(this.src.substring(start, this.pos));
    if (v > MAX_INT) {
      throw this.err('Repetition count is too large');
    }
    return v;
  }

  private atom(): Ast {
    const c = this.peek();
    switch (c) {
      case '(': {
        this.pos++;
        if (!this.eof() && this.peek() === '?') {
          return this.groupExtension();
        }
        const index = ++this.groups;
        const inner = this.alternation();
        this.expect(')');
        return group(inner, index);
      }
      case '[':
        this.pos++;
        return chars(this.classBody());
      case '.':
        this.pos++;
        return chars(DOT);
      case '\\':
        return this.escapeAtom();
      case '^':
      case '$':
        throw this.err(`Anchor '${c}' is only supported at the ends of a pattern`);
      case '*':
      case '+':
      case '?':
        throw this.err(`Quantifier '${c}' with nothing to repeat`);
      case ')':
        throw this.err("Unbalanced ')'");
      default:
        this.pos++;
        return chars(CharSet.of(c.charCodeAt(0)));
    }
  }

  private groupExtension(): Ast {
    const src = this.src;
    if (this.dialect === 'posix') {
      throw this.notPosix('(?...', 'a plain group');
    }
    if (src.startsWith('?:', this.pos)) {
      this.pos += 2;
      const inner = this.alternation();
      this.expect(')');
      return group(inner, 0);
    }
    if (src.startsWith('?#', this.pos)) {
      const close = src.indexOf(')', this.pos);
      if (close < 0) {
        throw this.err('Unterminated (?# comment');
      }
      this.pos = close + 1;
      return EMPTY;
    }
    const python = src.startsWith('?P<', this.pos);
    const named =
      python ||
      (src.startsWith('?<', this.pos) &&
        this.pos + 2 < src.length &&
        src.charAt(this.pos + 2) !== '=' &&
        src.charAt(this.pos + 2) !== '!');
    if (named) {
      const open = this.pos + (python ? 3 : 2);
      const close = src.indexOf('>', this.pos);
      if (close < 0) {
        throw this.err('Unterminated group name');
      }
      const name = src.substring(open, close);
      this.pos = close + 1;
      const index = ++this.groups;
      if (!this.names.has(name)) {
        this.names.set(name, index);
      }
      const inner = this.alternation();
      this.expect(')');
      return group(inner, index, name);
    }
    throw this.err('Lookaround, inline flags and conditionals need an NFA');
  }

  private expect(c: string): void {
    if (this.eof() || this.peek() !== c) {
      throw this.err(`Expected '${c}'`);
    }
    this.pos++;
  }

  // --- character classes ---------------------------------------------------

  /** Everything between '[' and its ']', as a set. */
  private classBody(): CharSet {
    const src = this.src;
    let negated = false;
    if (!this.eof() && this.peek() === '^') {
      negated = true;
      this.pos++;
    }
    let set = CharSet.EMPTY;
    let first = true;
    for (;;) {
      if (this.eof()) {
        throw this.err('Unterminated character class');
      }
      const c = this.peek();
      if (c === ']' && !first) {
        this.pos++;
        break;
      }
      first = false;

      // A shorthand inside a class is a member of the union, not an endpoint:
      // [\s.-] is space or dot or dash. Only a range endpoint is forbidden,
      // which classChar() enforces.
      if (c === '\\' && this.pos + 1 < src.length && SHORTHANDS.has(src.charAt(this.pos + 1))) {
        const d = src.charAt(this.pos + 1);
        if (this.dialect === 'posix') {
          throw this.notPosix('\\' + d, '[[:digit:]] and the other named classes');
        }
        set = set.union(SHORTHANDS.get(d)!);
        this.pos += 2;
        continue;
      }
      if (
        c === '\\' &&
        this.pos + 1 < src.length &&
        (src.charAt(this.pos + 1) === 'p' || src.charAt(this.pos + 1) === 'P')
      ) {
        const inner = this.escapeAtom();
        set = set.union((inner as { set: CharSet }).set);
        continue;
      }
      if (c === '[' && this.pos + 1 < src.length && src.charAt(this.pos + 1) === ':') {
        const named = this.posixClass();
        if (named !== null) {
          set = set.union(named);
          continue;
        }
        // not a well-formed [:name:]; '[' is a literal here, as it is in
        // every other engine that is not Java
      }

      const lo = this.classChar();
      // A '-' is a range only between two characters and never before ']'.
      if (
        !this.eof() &&
        this.peek() === '-' &&
        this.pos + 1 < src.length &&
        src.charAt(this.pos + 1) !== ']'
      ) {
        this.pos++;
        const hi = this.classChar();
        if (lo > hi) {
          throw this.err('Inverted range in character class');
        }
        set = set.union(CharSet.range(lo, hi));
      } else {
        set = set.union(CharSet.range(lo, lo));
      }
    }
    return negated ? set.complement() : set;
  }

  /** `[:name:]` at the cursor, or null if it is not one. */
  private posixClass(): CharSet | null {
    const src = this.src;
    const close = src.indexOf(':]', this.pos + 2);
    if (close < 0) {
      return null;
    }
    const name = src.substring(this.pos + 2, close);
    if (name.length === 0 || !allLetters(name)) {
      return null;
    }
    const set = NAMED.get(name.toLowerCase());
    if (set === undefined) {
      throw this.err(`Unknown POSIX class [:${name}:]`);
    }
    this.pos = close + 2;
    return set;
  }

  /**
   * One code unit inside a class. A shorthand is not a single character, so it
   * is handled by the caller before this is reached; a shorthand met here is
   * an endpoint of a range, which no dialect allows.
   */
  private classChar(): number {
    const src = this.src;
    const c = this.peek();
    if (c !== '\\') {
      this.pos++;
      return c.charCodeAt(0);
    }
    if (this.pos + 1 >= src.length) {
      throw this.err('Trailing backslash');
    }
    const d = src.charAt(this.pos + 1);
    if (SHORTHANDS.has(d)) {
      throw this.err(`Shorthand \\${d} cannot be an endpoint of a range`);
    }
    // Inside a class \b is the backspace character, not a word boundary --
    // there are no positions inside a class. Java, PCRE and the Brics front
    // end all read it that way.
    if (d === 'b') {
      this.pos += 2;
      return 0x08;
    }
    return this.escapeChar();
  }

  /** An escape outside a class: a set (for a shorthand) or a single character. */
  private escapeAtom(): Ast {
    const src = this.src;
    if (this.pos + 1 >= src.length) {
      throw this.err('Trailing backslash');
    }
    const d = src.charAt(this.pos + 1);
    const shorthand = SHORTHANDS.get(d);
    if (shorthand !== undefined) {
      if (this.dialect === 'posix') {
        throw this.notPosix('\\' + d, '[[:digit:]] and the other named classes');
      }
      this.pos += 2;
      return chars(shorthand);
    }
    if (d === 'p' || d === 'P') {
      if (this.dialect === 'posix') {
        throw this.notPosix(`\\${d}{...}`, '[[:name:]]');
      }
      this.pos += 2;
      if (this.eof() || this.peek() !== '{') {
        throw this.err(`Expected '{' after \\${d}`);
      }
      const close = src.indexOf('}', this.pos);
      if (close < 0) {
        throw this.err(`Unterminated \\${d}{...}`);
      }
      const name = src.substring(this.pos + 1, close);
      const set = NAMED.get(name.toLowerCase());
      if (set === undefined) {
        throw this.err(`Unsupported character class \\${d}{${name}}`);
      }
      this.pos = close + 1;
      return chars(d === 'P' ? set.complement() : set);
    }
    if (d === 'Q') {
      if (this.dialect === 'posix') {
        throw this.notPosix('\\Q', 'a backslash before each character');
      }
      const end = src.indexOf('\\E', this.pos + 2);
      const quoted = end < 0 ? src.substring(this.pos + 2) : src.substring(this.pos + 2, end);
      this.pos = end < 0 ? src.length : end + 2;
      const parts: Ast[] = [];
      for (let i = 0; i < quoted.length; i++) {
        parts.push(chars(CharSet.of(quoted.charCodeAt(i))));
      }
      return parts.length === 0 ? EMPTY : concat(parts);
    }
    if (d === 'E') {
      this.pos += 2;
      return EMPTY;
    }
    return chars(CharSet.of(this.escapeChar()));
  }

  /**
   * A backslash escape that denotes one code unit, consuming it. Anything a
   * DFA cannot express throws here rather than being taken as a literal.
   */
  private escapeChar(): number {
    const src = this.src;
    const d = src.charAt(this.pos + 1);
    if ('bBGkhvRXKAzZ'.includes(d) || (d >= '1' && d <= '9')) {
      throw this.err(`\\${d}: word boundaries, backreferences, anchors and the like need an NFA`);
    }
    this.pos += 2;
    switch (d) {
      case 't':
        return this.posixRejectEscape(d, 0x09);
      case 'n':
        return this.posixRejectEscape(d, 0x0a);
      case 'r':
        return this.posixRejectEscape(d, 0x0d);
      case 'f':
        return this.posixRejectEscape(d, 0x0c);
      case 'a':
        return this.posixRejectEscape(d, 0x07);
      case 'e':
        return this.posixRejectEscape(d, 0x1b);
      case '0': {
        let v = 0;
        let digits = 0;
        while (!this.eof() && digits < 3 && this.peek() >= '0' && this.peek() <= '7') {
          v = v * 8 + (src.charCodeAt(this.pos++) - 0x30);
          digits++;
        }
        if (digits === 0) {
          throw this.err('Malformed \\0 escape');
        }
        return this.posixRejectEscape('0', v);
      }
      case 'x':
      case 'u':
        return this.posixRejectEscape(d, this.hex(d));
      case 'c': {
        if (this.eof()) {
          throw this.err('Malformed \\c escape');
        }
        const v = src.charAt(this.pos++).toUpperCase().charCodeAt(0) ^ 64;
        return this.posixRejectEscape('c', v);
      }
      default:
        if (this.dialect === 'posix' && LETTER_OR_DIGIT.test(d)) {
          throw this.notPosix(
            '\\' + d,
            'the character itself; POSIX leaves a backslash before an ordinary character undefined',
          );
        }
        return d.charCodeAt(0);
    }
  }

  private posixRejectEscape(kind: string, value: number): number {
    if (this.dialect === 'posix') {
      throw this.notPosix('\\' + kind, 'the character itself');
    }
    return value;
  }

  private hex(kind: string): number {
    const src = this.src;
    if (kind === 'x' && !this.eof() && this.peek() === '{') {
      const close = src.indexOf('}', this.pos);
      if (close < 0) {
        throw this.err('Unterminated \\x{...}');
      }
      const v = this.parseHex(src.substring(this.pos + 1, close));
      this.pos = close + 1;
      return v;
    }
    const want = kind === 'x' ? 2 : 4;
    if (this.pos + want > src.length) {
      throw this.err(`Malformed \\${kind} escape`);
    }
    const v = this.parseHex(src.substring(this.pos, this.pos + want));
    this.pos += want;
    return v;
  }

  private parseHex(s: string): number {
    if (!/^[0-9a-fA-F]{1,8}$/.test(s)) {
      throw this.err('Malformed hexadecimal escape');
    }
    const v = parseInt(s, 16);
    if (v > MAX_INT) {
      throw this.err('Malformed hexadecimal escape');
    }
    if (v > CharSet.MAX) {
      throw this.err('Code point above the Basic Multilingual Plane');
    }
    return v;
  }
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function allLetters(s: string): boolean {
  for (const ch of s) {
    if (!LETTER.test(ch)) {
      return false;
    }
  }
  return true;
}

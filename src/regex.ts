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
import { CapturePlan, type CaptureEngine } from './capture.ts';
import type { FlattenedDfa } from './flatten.ts';
import type { Parsed } from './parser.ts';
import { SearchAutomaton, StreamMatcher } from './search.ts';

/**
 * A compiled regular expression. Immutable and reusable: a `Regex` holds no
 * input, so one instance serves every call site. {@link exec} is the whole
 * engine — the exclusive end of the longest match from an offset, or -1 — and
 * everything else is built on it.
 *
 * A pattern that begins with `^` only matches at offset 0; one that ends with
 * `$` only matches if the match reaches the end of the input.
 *
 * Capturing groups are recovered after the span is fixed, by the pattern's
 * {@link CapturePlan}, into a {@link MatchResult}; `exec` never pays for them.
 */
export abstract class Regex {
  readonly pattern: string;
  /** The number of capturing `(...)` groups; group 0, the whole match, is not counted. */
  readonly groupCount: number;
  /** Named groups, by name, to their 1-based index. */
  readonly groupNames: ReadonlyMap<string, number>;
  /** How groups are recovered from a span; shared by every matcher of this pattern. */
  readonly plan: CapturePlan;
  /** The automaton the walk runs, as the generators saw it. */
  readonly dfa: FlattenedDfa;
  /** The parsed pattern: its tree, for the search automaton. */
  protected readonly parsed: Parsed;
  private search: SearchAutomaton | null = null;

  protected constructor(dfa: FlattenedDfa, parsed: Parsed) {
    this.pattern = dfa.pattern;
    this.groupCount = parsed.groupCount;
    this.groupNames = parsed.groupNames;
    this.plan = CapturePlan.of(parsed);
    this.dfa = dfa;
    this.parsed = parsed;
  }

  /** The pattern began with `^`: a match may only start at offset 0. */
  get anchoredStart(): boolean {
    return this.dfa.anchoredStart;
  }

  /** The pattern ended with `$`: a match must reach the end of the input. */
  get anchoredEnd(): boolean {
    return this.dfa.anchoredEnd;
  }

  /**
   * The exclusive end of the longest match of this pattern that starts at
   * `start`, or -1 if there is none. An empty match at an accepting start
   * state returns `start` itself.
   *
   * @throws RangeError if `start` is negative or past the end of the input
   */
  abstract exec(input: string, start?: number): number;

  /** `true` if the entire input is a match. */
  matches(input: string): boolean {
    return this.exec(input, 0) === input.length;
  }

  /** `true` if a match (possibly empty) exists at offset 0. */
  lookingAt(input: string): boolean {
    return this.exec(input, 0) >= 0;
  }

  /** A {@link Matcher} over `input`. */
  matcher(input: string): Matcher {
    return new Matcher(this, input);
  }

  /** The whole-input match with its groups, or `null` if the input does not match. */
  match(input: string): MatchResult | null {
    const result = new MatchResult(this);
    return this.run(input, 0, result) === input.length ? result : null;
  }

  /** The first match at or after `start` with its groups, or `null`; a `Matcher` walks them all. */
  find(input: string, start = 0): MatchResult | null {
    const m = this.matcher(input);
    return m.find(start) ? m.result : null;
  }

  /**
   * The offsets of `input` at which a match of this pattern starts, as a
   * byte per offset `0..input.length`, found by one backward pass of the
   * search automaton — the automaton of the reversed pattern preceded by
   * anything — so that `find` costs the input's length, not the input's
   * length times the match's.
   */
  starts(input: string): Uint8Array {
    this.search ??= new SearchAutomaton(this.dfa, this.parsed.ast);
    return this.search.starts(input);
  }

  /**
   * A matcher fed the input in pieces: the automaton's state survives chunk
   * boundaries, so a stream matches without being joined. It answers what
   * `exec(whole, 0)` would: the end of the longest match from offset 0.
   */
  stream(): StreamMatcher {
    return new StreamMatcher(this.dfa);
  }

  /**
   * {@link exec} plus group bookkeeping into `result`. Capturing groups are
   * recovered only when the pattern has some and the match succeeded;
   * otherwise this costs the same as `exec`. Group recovery runs after the
   * walk has fixed the span, and on short inputs it costs many times the
   * walk; call `exec` when only the span matters.
   */
  run(input: string, start: number, result: MatchResult): number {
    const end = this.exec(input, start);
    result.record(input, start, end);
    return end;
  }

  protected checkStart(start: number, length: number): void {
    if (start < 0 || start > length) {
      throw new RangeError(`Illegal start offset ${start} for an input of length ${length}`);
    }
  }
}

/**
 * The offsets of a match: group 0 is the whole match; groups `1..groupCount`
 * are the capturing groups, by number or by name. A group that did not take
 * part in the match has offsets -1 and text `null`.
 *
 * A result belongs to one matcher and is rewritten by every match; keep the
 * strings, not the result, if you need them later.
 */
export class MatchResult {
  private readonly regex: Regex;
  private readonly starts: Int32Array;
  private readonly ends: Int32Array;
  private readonly engine: CaptureEngine | null;
  private input = '';

  constructor(regex: Regex) {
    this.regex = regex;
    this.starts = new Int32Array(regex.groupCount + 1).fill(-1);
    this.ends = new Int32Array(regex.groupCount + 1).fill(-1);
    this.engine = regex.groupCount > 0 ? regex.plan.newEngine() : null;
  }

  /** @internal Records the span the walk found and recovers the groups over it. */
  record(input: string, start: number, end: number): void {
    this.input = input;
    this.starts[0] = start;
    this.ends[0] = end;
    this.starts.fill(-1, 1);
    this.ends.fill(-1, 1);
    if (end >= 0 && this.engine !== null) {
      this.engine.fill(input, start, end, this.starts, this.ends);
    }
  }

  get groupCount(): number {
    return this.starts.length - 1;
  }

  start(group: number | string = 0): number {
    return this.starts[this.index(group)]!;
  }

  end(group: number | string = 0): number {
    return this.ends[this.index(group)]!;
  }

  group(group: number | string = 0): string | null {
    const g = this.index(group);
    const s = this.starts[g]!;
    const e = this.ends[g]!;
    return s < 0 || e < 0 ? null : this.input.substring(s, e);
  }

  private index(group: number | string): number {
    if (this.ends[0]! < 0) {
      throw new Error('No match available');
    }
    if (typeof group === 'string') {
      const index = this.regex.groupNames.get(group);
      if (index === undefined) {
        throw new RangeError(`No group named ${group}`);
      }
      return index;
    }
    if (group < 0 || group >= this.starts.length) {
      throw new RangeError(`No group ${group}`);
    }
    return group;
  }
}

/**
 * A stateful matcher over one input, analogous to `java.util.regex.Matcher`.
 *
 * A successful {@link matches}, {@link lookingAt} or {@link find} leaves the
 * next `find()` starting after the match (one past it, if the match was
 * empty). {@link reset} starts over.
 */
export class Matcher {
  private readonly regex: Regex;
  private input: string;
  /** The last match's offsets and groups; valid after a successful `matches`, `lookingAt` or `find`. */
  readonly result: MatchResult;
  private starts: Uint8Array | null = null;
  private lastFind = 0;
  private matched = false;

  constructor(regex: Regex, input: string) {
    this.regex = regex;
    this.input = input;
    this.result = new MatchResult(regex);
  }

  reset(input?: string): this {
    if (input !== undefined) {
      this.input = input;
      this.starts = null;
    }
    this.lastFind = 0;
    this.matched = false;
    return this;
  }

  /** Whether the whole input matches. */
  matches(): boolean {
    const end = this.regex.run(this.input, 0, this.result);
    this.matched = end === this.input.length;
    if (this.matched) {
      this.advance(0, end);
    }
    return this.matched;
  }

  /** Whether a match starts at offset 0. */
  lookingAt(): boolean {
    const end = this.regex.run(this.input, 0, this.result);
    this.matched = end >= 0;
    if (this.matched) {
      this.advance(0, end);
    }
    return this.matched;
  }

  /**
   * The next match: the first offset at or after where the last one ended
   * (one past it, if it was empty) with a match, and the longest match there.
   *
   * @throws RangeError if `start` is given and is negative or past the end
   */
  find(start?: number): boolean {
    if (start === undefined) {
      return this.search(this.lastFind);
    }
    if (start < 0 || start > this.input.length) {
      throw new RangeError(`Illegal start offset ${start}`);
    }
    return this.search(start);
  }

  /**
   * The leftmost offset at or after `start` where a match begins, then the
   * longest match there. A start-anchored pattern can only match at 0; any
   * other pattern's starts come from one backward pass of the search
   * automaton over the input, made once per input.
   */
  private search(start: number): boolean {
    const len = this.input.length;
    if (this.regex.anchoredStart) {
      if (start === 0 && this.regex.run(this.input, 0, this.result) >= 0) {
        this.advance(0, this.result.end());
        this.matched = true;
        return true;
      }
      this.matched = false;
      return false;
    }
    this.starts ??= this.regex.starts(this.input);
    for (let i = start; i <= len; i++) {
      if (this.starts[i] !== 0) {
        const end = this.regex.run(this.input, i, this.result);
        if (end < i) {
          throw new Error(`The search automaton found a match starting at ${i} that the walk does not`);
        }
        this.advance(i, end);
        this.matched = true;
        return true;
      }
    }
    this.matched = false;
    return false;
  }

  private advance(from: number, end: number): void {
    this.lastFind = end === from ? from + 1 : end;
  }

  /** The text of a group of the last match, by number or name; `null` if it took no part. */
  group(group: number | string = 0): string | null {
    this.requireMatch();
    return this.result.group(group);
  }

  start(group: number | string = 0): number {
    this.requireMatch();
    return this.result.start(group);
  }

  end(group: number | string = 0): number {
    this.requireMatch();
    return this.result.end(group);
  }

  get groupCount(): number {
    return this.regex.groupCount;
  }

  private requireMatch(): void {
    if (!this.matched) {
      throw new Error('No match available');
    }
  }
}

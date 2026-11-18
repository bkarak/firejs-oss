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
 * A set of UTF-16 code units held as sorted, disjoint, inclusive ranges.
 *
 * A class is a value: `\d` is one CharSet, a class body is a union of them,
 * a negated class is a complement. Nothing is rewritten and nothing is
 * re-parsed. Immutable.
 *
 * The universe is `0..0xFFFF`, the code-unit range, which is what the walk
 * reads with `charCodeAt`. That is a ceiling on code units, not code points:
 * a character above the Basic Multilingual Plane is two of them, an escape
 * naming one is refused, and `.` matches either half of a surrogate pair.
 */
export class CharSet {
  /** The largest code unit the engine matches; above the BMP is rejected. */
  static readonly MAX = 0xffff;

  /** Pairs of inclusive bounds: `lo0, hi0, lo1, hi1, ...`, sorted and disjoint. */
  private readonly spans: readonly number[];

  private constructor(spans: readonly number[]) {
    this.spans = spans;
  }

  static readonly EMPTY: CharSet = new CharSet([]);
  static readonly ANY: CharSet = new CharSet([0, CharSet.MAX]);

  /** One code unit. */
  static of(c: number): CharSet {
    return new CharSet([c, c]);
  }

  /** One inclusive range; `lo` must not exceed `hi`. */
  static range(lo: number, hi: number): CharSet {
    if (lo > hi) {
      throw new RegexCompilationError(`Inverted character range: ${lo} > ${hi}`);
    }
    return new CharSet([clamp(lo), clamp(hi)]);
  }

  /** The union of a list of ranges, given as pairs. */
  static ranges(...pairs: number[]): CharSet {
    if (pairs.length % 2 !== 0) {
      throw new Error('ranges() takes pairs');
    }
    let s = CharSet.EMPTY;
    for (let i = 0; i < pairs.length; i += 2) {
      s = s.union(CharSet.range(pairs[i]!, pairs[i + 1]!));
    }
    return s;
  }

  isEmpty(): boolean {
    return this.spans.length === 0;
  }

  contains(c: number): boolean {
    const spans = this.spans;
    let lo = 0;
    let hi = spans.length / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (c < spans[2 * mid]!) {
        hi = mid - 1;
      } else if (c > spans[2 * mid + 1]!) {
        lo = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  }

  /** The number of disjoint ranges. */
  rangeCount(): number {
    return this.spans.length / 2;
  }

  lo(i: number): number {
    return this.spans[2 * i]!;
  }

  hi(i: number): number {
    return this.spans[2 * i + 1]!;
  }

  union(other: CharSet): CharSet {
    if (this.isEmpty()) {
      return other;
    }
    if (other.isEmpty()) {
      return this;
    }
    return CharSet.normalise([...this.spans, ...other.spans]);
  }

  complement(): CharSet {
    const out: number[] = [];
    let next = 0;
    const spans = this.spans;
    for (let i = 0; i < spans.length; i += 2) {
      if (spans[i]! > next) {
        out.push(next, spans[i]! - 1);
      }
      next = Math.max(next, spans[i + 1]! + 1);
    }
    if (next <= CharSet.MAX) {
      out.push(next, CharSet.MAX);
    }
    return new CharSet(out);
  }

  equals(other: CharSet): boolean {
    if (this.spans.length !== other.spans.length) {
      return false;
    }
    for (let i = 0; i < this.spans.length; i++) {
      if (this.spans[i] !== other.spans[i]) {
        return false;
      }
    }
    return true;
  }

  /** Sort the pairs and merge everything that touches or overlaps. */
  private static normalise(pairs: number[]): CharSet {
    const n = pairs.length / 2;
    const order: number[] = [];
    for (let i = 0; i < n; i++) {
      order.push(i);
    }
    order.sort((a, b) => pairs[2 * a]! - pairs[2 * b]!);
    const out: number[] = [];
    let curLo = -1;
    let curHi = -2;
    for (const idx of order) {
      const lo = pairs[2 * idx]!;
      const hi = pairs[2 * idx + 1]!;
      if (curHi < curLo) {
        curLo = lo;
        curHi = hi;
      } else if (lo <= curHi + 1) {
        curHi = Math.max(curHi, hi);
      } else {
        out.push(curLo, curHi);
        curLo = lo;
        curHi = hi;
      }
    }
    if (curHi >= curLo) {
      out.push(curLo, curHi);
    }
    return new CharSet(out);
  }

  toString(): string {
    let b = '[';
    for (let i = 0; i < this.spans.length; i += 2) {
      b += String.fromCharCode(this.spans[i]!);
      if (this.spans[i + 1]! > this.spans[i]!) {
        b += '-' + String.fromCharCode(this.spans[i + 1]!);
      }
    }
    return b + ']';
  }
}

function clamp(c: number): number {
  return c < 0 ? 0 : Math.min(c, CharSet.MAX);
}

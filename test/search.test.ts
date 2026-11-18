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
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type Regex, compile } from '../src/index.ts';
import { FIND, FULL } from './cases.ts';

/** The starts of matches the slow way: an offset where the walk finds one. */
function bruteStarts(regex: Regex, input: string): string {
  let s = '';
  for (let i = 0; i <= input.length; i++) {
    s += regex.exec(input, i) >= 0 ? '1' : '0';
  }
  return s;
}

/** Every leftmost-longest match the slow way, as `start:end`. */
function bruteFind(regex: Regex, input: string): string[] {
  const hits: string[] = [];
  let from = 0;
  while (from <= input.length) {
    let hit = -1;
    for (let i = from; i <= input.length; i++) {
      if (regex.exec(input, i) >= 0) {
        hit = i;
        break;
      }
    }
    if (hit < 0) {
      break;
    }
    const end = regex.exec(input, hit);
    hits.push(`${hit}:${end}`);
    from = end === hit ? hit + 1 : end;
  }
  return hits;
}

let seed = 0x2545f491;
function next(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}

function randomString(alphabet: string, maxLength: number): string {
  const n = Math.floor(next() * (maxLength + 1));
  let s = '';
  for (let i = 0; i < n; i++) {
    s += alphabet.charAt(Math.floor(next() * alphabet.length));
  }
  return s;
}

const PATTERNS = [
  ...new Set([...FULL.map((c) => c.pattern), ...FIND.map((c) => c.pattern)]),
  'a|ab', 'a*', 'x?', '(a|b)*abb', '[0-9]+\\.[0-9]+', 'ab$', '^ab', 'b+$', '(|a)b', '.*x', '[^a]+a$',
];
const ALPHABET = 'ab01.-x \n';

describe('the search automaton', () => {
  const engine = new Engine({ generator: 'table', cache: 'none' });

  test('marks exactly the offsets where the walk finds a match', () => {
    for (const pattern of PATTERNS) {
      const regex = engine.compile(pattern);
      for (let k = 0; k < 40; k++) {
        const input = randomString(ALPHABET, 12);
        if (regex.anchoredStart) {
          continue; // never consulted: a start-anchored pattern matches at 0 or nowhere
        }
        assert.equal(Array.from(regex.starts(input)).join(''), bruteStarts(regex, input), `/${pattern}/ on ${JSON.stringify(input)}`);
      }
    }
  });

  test('find walks the same matches as trying every offset', () => {
    for (const pattern of PATTERNS) {
      const regex = engine.compile(pattern);
      for (let k = 0; k < 40; k++) {
        const input = randomString(ALPHABET, 12);
        const m = regex.matcher(input);
        const hits: string[] = [];
        while (m.find()) {
          hits.push(`${m.start()}:${m.end()}`);
        }
        assert.deepEqual(hits, bruteFind(regex, input), `/${pattern}/ on ${JSON.stringify(input)}`);
      }
    }
  });

  test('find on a long input costs one pass, not one per offset', () => {
    const regex = compile('needle[0-9]+');
    const input = 'h'.repeat(200_000) + 'needle42' + 'h'.repeat(200_000);
    const before = performance.now();
    const m = regex.find(input);
    const elapsed = performance.now() - before;
    assert.ok(m);
    assert.equal(m.start(), 200_000);
    assert.equal(m.group(), 'needle42');
    assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms`);
  });

  test('Regex.find is the one-shot form', () => {
    assert.equal(compile('[0-9]+').find('ab12cd345')?.group(), '12');
    assert.equal(compile('[0-9]+').find('ab12cd345', 3)?.group(), '2', 'offset 3 is inside the first run of digits');
    assert.equal(compile('[0-9]+').find('ab12cd345', 4)?.group(), '345');
    assert.equal(compile('[0-9]+').find('abc'), null);
    assert.equal(compile('^a').find('ba'), null);
    assert.equal(compile('^a').find('ab')?.end(), 1);
    assert.equal(compile('b$').find('abab')?.start(), 3);
    assert.equal(compile('(\\d+)-(\\d+)').find('x 12-345 y')?.group(2), '345');
  });

  test('every back end finds the same matches', () => {
    for (const g of ['dense', 'js', 'js-ranges'] as const) {
      const other = new Engine({ generator: g, cache: 'none' });
      for (const pattern of PATTERNS.slice(0, 40)) {
        const a = engine.compile(pattern);
        const b = other.compile(pattern);
        for (let k = 0; k < 10; k++) {
          const input = randomString(ALPHABET, 10);
          assert.deepEqual(bruteFind(b, input), bruteFind(a, input), `${g} /${pattern}/ on ${JSON.stringify(input)}`);
        }
      }
    }
  });
});

describe('the streaming matcher', () => {
  const engine = new Engine({ generator: 'table', cache: 'none' });

  test('chunks match as the joined input would', () => {
    for (const pattern of PATTERNS) {
      const regex = engine.compile(pattern);
      for (let k = 0; k < 30; k++) {
        const input = randomString(ALPHABET, 16);
        const stream = regex.stream();
        let fed = 0;
        while (fed < input.length) {
          const n = 1 + Math.floor(next() * 4);
          stream.feed(input.substring(fed, fed + n));
          fed += n;
        }
        assert.equal(stream.consumed, input.length);
        assert.equal(stream.end(), regex.exec(input, 0), `/${pattern}/ on ${JSON.stringify(input)}`);
        assert.equal(stream.matches(), regex.matches(input), `/${pattern}/ on ${JSON.stringify(input)}`);
      }
    }
  });

  test('a stream answers as it goes', () => {
    const stream = compile('(\\d{4})-(\\d{2})$').stream();
    assert.equal(stream.feed('20').end(), -1, 'no match yet, and $ not reached');
    assert.equal(stream.alive, true);
    assert.equal(stream.feed('26-1').end(), -1);
    assert.equal(stream.feed('0').end(), 7);
    assert.equal(stream.matches(), true);
    assert.equal(stream.feed('x').alive, false, 'nothing can follow');
    assert.equal(stream.end(), -1, 'the $ rule: the match no longer reaches the end');
    assert.equal(stream.consumed, 8);

    const words = compile('[a-z]+').stream();
    assert.equal(words.feed('abc').end(), 3);
    assert.equal(words.feed('def').end(), 6);
    assert.equal(words.feed('1').end(), 6, 'the longest match so far stands');
    assert.equal(words.alive, false);
    assert.equal(words.feed('ghi').end(), 6, 'a dead stream stays dead');
    assert.equal(words.reset().feed('x').end(), 1);
  });

  test('an empty stream', () => {
    assert.equal(compile('a*').stream().end(), 0);
    assert.equal(compile('a*').stream().matches(), true);
    assert.equal(compile('a+').stream().end(), -1);
    assert.equal(compile('^$').stream().matches(), true);
  });
});

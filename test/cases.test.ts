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
import { Engine, RegexCompilationError, jsGenerator } from '../src/index.ts';
import { FIND, FULL, PREFIX, REJECTED } from './cases.ts';

/**
 * Every back end that ships, plus a split walk forced small enough to
 * exercise the hops on ordinary patterns; a behaviour of the library holds in
 * all of them.
 */
export const ENGINES: readonly Engine[] = [
  new Engine({ generator: 'table', cache: 'none' }),
  new Engine({ generator: 'dense', cache: 'none' }),
  new Engine({ generator: 'js', cache: 'none' }),
  new Engine({ generator: 'js-ranges', cache: 'none' }),
  new Engine({ generator: 'js-switch', cache: 'none' }),
  new Engine({ generator: jsGenerator({ split: 400 }, 'js-split'), cache: 'none' }),
];

for (const engine of ENGINES) {
  describe(`${engine}`, () => {
    describe('matches(): the whole input', () => {
      for (const c of FULL) {
        test(`/${c.pattern}/ ~ ${JSON.stringify(c.input.length > 40 ? c.input.slice(0, 40) + '…' : c.input)}`, () => {
          const regex = engine.compile(c.pattern);
          const m = regex.matcher(c.input);
          if (c.groups === null) {
            assert.equal(m.matches(), false, 'should not match');
            return;
          }
          assert.equal(m.matches(), true, 'should match');
          assert.equal(m.group(), c.input);
          assert.equal(m.start(), 0);
          assert.equal(m.end(), c.input.length);
          assert.equal(regex.groupCount, c.groups.length, 'group count');
          assert.equal(m.groupCount, c.groups.length, 'matcher group count');
          for (let g = 1; g <= c.groups.length; g++) {
            const expected: string | null = c.groups[g - 1]!;
            assert.equal(m.group(g), expected, `group ${g}`);
            if (expected === null) {
              assert.equal(m.start(g), -1, `start of unset group ${g}`);
              assert.equal(m.end(g), -1, `end of unset group ${g}`);
            } else {
              assert.equal(c.input.substring(m.start(g), m.end(g)), expected, `span of group ${g}`);
            }
          }
        });
      }
    });

    test('find refills the groups at every hit', () => {
      const m = engine.compile('([a-z]+)=(\\d+)?').matcher('a=1 bb= ccc=333');
      assert.equal(m.find(), true);
      assert.equal(m.group(1), 'a');
      assert.equal(m.group(2), '1');
      assert.equal(m.find(), true);
      assert.equal(m.group(1), 'bb');
      assert.equal(m.group(2), null, 'a group unset at this hit is not left over from the last one');
      assert.equal(m.find(), true);
      assert.equal(m.group(1), 'ccc');
      assert.equal(m.group(2), '333');
      assert.equal(m.start(2), 12);
      assert.equal(m.find(), false);
    });

    describe('lookingAt(): the longest prefix', () => {
      for (const c of PREFIX) {
        test(`/${c.pattern}/ at 0 of ${JSON.stringify(c.input.length > 40 ? c.input.slice(0, 40) + '…' : c.input)}`, () => {
          const m = engine.compile(c.pattern).matcher(c.input);
          if (c.prefix === null) {
            assert.equal(m.lookingAt(), false);
            return;
          }
          assert.equal(m.lookingAt(), true);
          assert.equal(m.group(), c.prefix);
          assert.equal(m.start(), 0);
        });
      }
    });

    describe('find(): every leftmost-longest match, left to right', () => {
      for (const c of FIND) {
        test(`/${c.pattern}/ in ${JSON.stringify(c.input.length > 40 ? c.input.slice(0, 40) + '…' : c.input)}`, () => {
          const m = engine.compile(c.pattern).matcher(c.input);
          const hits: string[] = [];
          while (m.find()) {
            hits.push(`${m.start()}:${m.group()}`);
            assert.equal(m.group(), c.input.substring(m.start(), m.end()));
          }
          assert.deepEqual(hits, c.hits);
          assert.equal(m.find(), false, 'an exhausted matcher stays exhausted');
        });
      }
    });

    describe('refused rather than misread', () => {
      for (const pattern of REJECTED) {
        test(`/${pattern}/`, () => {
          assert.throws(() => engine.compile(pattern), RegexCompilationError);
        });
      }
    });

    test('a dash after a range is a literal, and braces without a bound are text', () => {
      const p = engine.compile('[a-cA-Z-0-9]+');
      assert.equal(p.matches('a-Z-9'), true);
      assert.equal(p.matches('d'), false);
      assert.equal(engine.compile('[+*?]+').matches('*+?'), true, 'quantifier characters in a class are literals');
      assert.equal(engine.compile('\\*a\\+').matches('*a+'), true, 'escaped quantifiers are literals');
      assert.equal(engine.compile('a{2}{3}').matches('aaaaaa'), true, 'a repetition may repeat a repetition');
      assert.equal(engine.compile('{2}a').matches('{2}a'), true, 'with nothing to repeat, braces are text');
      assert.equal(engine.compile('x({2,3})').matches('x{2,3}'), true);
    });
  });
}

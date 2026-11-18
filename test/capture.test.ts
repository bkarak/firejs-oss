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
import { Engine, MatchResult, compile } from '../src/index.ts';
import { ENGINES } from './cases.test.ts';

/**
 * How groups are recovered, and where that differs from a backtracking engine.
 *
 * The DFA fixes the span first: the longest match. Groups are then filled by
 * one parse of exactly that span in which every quantifier and every
 * alternation, left to right, takes as much of the input as still lets the
 * rest match — the POSIX rule. A backtracker instead reports the first parse
 * it reaches: the left alternative before the right, and a lazy quantifier as
 * little as possible. Both agree whenever the first parse is also the longest
 * one, which is the common case; the tests below pin the cases where it is
 * not. The backtracker's answers quoted in comments are `java.util.regex`'s,
 * as FIRE/J's `CaptureSemanticsTest` records them.
 */
function groupsOf(engine: Engine, pattern: string, input: string): (string | null)[] {
  const m = engine.compile(pattern).matcher(input);
  assert.equal(m.matches(), true, `${engine} /${pattern}/ should match "${input}"`);
  const groups: (string | null)[] = [];
  for (let g = 1; g <= m.groupCount; g++) {
    groups.push(m.group(g));
  }
  return groups;
}

for (const engine of ENGINES) {
  describe(`${engine}: capture semantics`, () => {
    const assertGroups = (pattern: string, input: string, ...groups: (string | null)[]): void => {
      assert.deepEqual(groupsOf(engine, pattern, input), groups, `/${pattern}/ on "${input}"`);
    };

    test('an earlier alternative takes the longer branch', () => {
      assertGroups('(a|ab)(c|bcd)(d*)', 'abcd', 'ab', 'c', 'd'); // a backtracker: a, bcd, ""
      assertGroups('(a|ab)(bc|c)', 'abc', 'ab', 'c'); // a backtracker: a, bc
    });

    test('a lazy quantifier is greedy for groups too', () => {
      assertGroups('(.*?)(\\d+)', 'abc123', 'abc12', '3'); // a backtracker: abc, 123
      assertGroups('(a+?)(a*)', 'aaa', 'aaa', ''); // a backtracker: a, aa
    });

    test('a starred group does not end on an empty iteration', () => {
      assertGroups('(a*)+', 'aaa', 'aaa'); // java.util.regex: ""
      assertGroups('(a*)*', 'aa', 'aa');
    });

    test('a nullable group under a bound keeps its last non-empty iteration', () => {
      // FIRE/J (at 224f769) leaves these groups unset: its exactRepeat bounds
      // the rounds by the span's length and so cannot see that (a*){3} covers
      // "a" as a, "", "". Here the empty iterations are forced and not taken.
      assertGroups('(a*){3}', 'a', 'a');
      assertGroups('(a*){3}', 'aa', 'aa');
      assertGroups('(a*){2,}', 'a', 'a');
      assertGroups('(a*){3}', '', null); // no non-empty iteration at all
      assertGroups('(a|){2}b', 'ab', 'a');
    });

    test('where the first parse is the longest both agree', () => {
      // The expected groups are java.util.regex's.
      assertGroups('(a+)(a+)', 'aaaa', 'aaa', 'a');
      assertGroups('(\\w+)@(\\w+)\\.com', 'joe@example.com', 'joe', 'example');
      assertGroups('((a)|b)+', 'ab', 'b', 'a');
      assertGroups('((a)|b)+', 'ba', 'a', 'a');
      assertGroups('(ab|a)(bc|c)?', 'abc', 'ab', 'c');
      assertGroups('((a)(b))*', 'abab', 'ab', 'a', 'b');
      assertGroups('(x?)(x?)x', 'xx', 'x', '');
      assertGroups('(.*)/(.*)', 'a/b/c', 'a/b', 'c');
      assertGroups('([^.]*)\\.(.*)', 'archive.tar.gz', 'archive', 'tar.gz');
      assertGroups('(a)|b', 'b', null);
      assertGroups('(\\d+)(?:px|pt)', '12pt', '12');
    });

    test('groups are numbered by their opening parenthesis', () => {
      // Non-capturing, named and escaped parentheses, and parentheses in a
      // class or \Q...\E, all count or not as java.util.regex counts them.
      assertGroups('(?:x)(?<a>a)(\\()([(])(\\Q(\\E)((b)(?:c)(d))', 'xa(((bcd', 'a', '(', '(', '(', 'bcd', 'b', 'd');
    });

    test('many groups', () => {
      let pattern = '';
      let input = '';
      const expected: string[] = [];
      for (let i = 0; i < 26; i++) {
        const c = String.fromCharCode(0x61 + i);
        pattern += `(${c}+)`;
        input += c.repeat((i % 3) + 1);
        expected.push(c.repeat((i % 3) + 1));
      }
      assertGroups(pattern, input, ...expected);
    });

    test('groups on a long input', () => {
      const head = 'h'.repeat(63);
      const m = engine.compile('(h+)(-+)(t+)').matcher(head + '--' + 't'.repeat(40));
      assert.equal(m.matches(), true);
      assert.equal(m.group(1), head);
      assert.equal(m.start(2), 63);
      assert.equal(m.end(2), 65);
      assert.equal(m.group(3), 't'.repeat(40));
    });

    test('groups of a find are absolute offsets', () => {
      const m = engine.compile('<(\\w+)>').matcher('text <b> more <em>');
      assert.equal(m.find(), true);
      assert.equal(m.start(), 5);
      assert.equal(m.start(1), 6);
      assert.equal(m.group(1), 'b');
      assert.equal(m.find(), true);
      assert.equal(m.start(1), 15);
      assert.equal(m.group(1), 'em');
    });

    test('reset with new input clears the old match', () => {
      const m = engine.compile('([a-z]+)(\\d)?').matcher('abc1');
      assert.equal(m.matches(), true);
      assert.equal(m.group(2), '1');
      m.reset('xyz');
      assert.throws(() => m.group(), /No match/, 'no match yet on the new input');
      assert.equal(m.matches(), true);
      assert.equal(m.group(1), 'xyz');
      assert.equal(m.group(2), null);
      assert.equal(m.reset().find(), true);
      assert.equal(m.group(), 'xyz');
    });

    test('a failed match leaves no groups', () => {
      const m = engine.compile('(a)(b)').matcher('ab');
      assert.equal(m.matches(), true);
      m.reset('ax');
      assert.equal(m.matches(), false);
      assert.throws(() => m.group(1), /No match/);
      assert.throws(() => m.start(1), /No match/);
      assert.throws(() => m.end(), /No match/);
    });

    test('run fills a MatchResult, match returns one', () => {
      const r = engine.compile('(\\d+)-(\\d+)');
      assert.equal(r.groupCount, 2);
      const result = new MatchResult(r);
      assert.equal(r.run('x 12-345 y', 2, result), 8);
      assert.equal(result.start(), 2);
      assert.equal(result.end(), 8);
      assert.equal(result.group(1), '12');
      assert.equal(result.group(2), '345');
      assert.equal(r.run('x 12-345 y', 0, result), -1);
      assert.throws(() => result.group(), /No match/);
      assert.equal(r.run('1-2', 0, result), 3);
      assert.throws(() => result.group(3), RangeError);

      assert.equal(r.match('x 12-345 y'), null);
      const whole = r.match('12-345');
      assert.ok(whole);
      assert.deepEqual([whole.group(), whole.group(1), whole.group(2)], ['12-345', '12', '345']);
    });

    test('exec is the span-only call', () => {
      const r = engine.compile('(a+)(b+)');
      assert.equal(r.exec('aabbbc', 0), 5);
      assert.equal(r.exec('aabbbc', 1), 5);
      assert.equal(r.exec('aabbbc', 5), -1);
    });

    test('named groups are reached by name', () => {
      const m = engine.compile('(?<year>\\d{4})-(?P<month>\\d{2})(?:-(?<day>\\d{2}))?').matcher('2026-10');
      assert.equal(m.matches(), true);
      assert.equal(m.group('year'), '2026');
      assert.equal(m.group('month'), '10');
      assert.equal(m.group('day'), null);
      assert.equal(m.start('month'), 5);
      assert.equal(m.end('month'), 7);
      assert.throws(() => m.group('hour'), RangeError);
      assert.deepEqual([...engine.compile('(?<a>x)(?<b>y)').groupNames], [['a', 1], ['b', 2]]);
    });
  });

  describe(`${engine}: capturing groups`, () => {
    test('two groups', () => {
      const m = engine.compile('([0-9]+)-([0-9]+)').matcher('12-34');
      assert.equal(m.matches(), true);
      assert.equal(m.groupCount, 2);
      assert.equal(m.group(), '12-34');
      assert.equal(m.group(1), '12');
      assert.equal(m.group(2), '34');
      assert.equal(m.start(1), 0);
      assert.equal(m.end(1), 2);
      assert.equal(m.start(2), 3);
      assert.equal(m.end(2), 5);
    });

    test('nested', () => {
      const m = engine.compile('(([0-9]+)-([0-9]+))').matcher('12-34');
      assert.equal(m.matches(), true);
      assert.equal(m.groupCount, 3);
      assert.equal(m.group(1), '12-34');
      assert.equal(m.group(2), '12');
      assert.equal(m.group(3), '34');
    });

    test('an alternation picks the taken branch', () => {
      const m = engine.compile('(a|bb)c').matcher('bbc');
      assert.equal(m.matches(), true);
      assert.equal(m.group(1), 'bb');
    });

    test('an unused alternative stays unset', () => {
      const m = engine.compile('(a)|(b)').matcher('b');
      assert.equal(m.matches(), true);
      assert.equal(m.group(1), null);
      assert.equal(m.start(1), -1);
      assert.equal(m.group(2), 'b');
    });

    test('an optional group, unset and set', () => {
      let m = engine.compile('(a)?b').matcher('b');
      assert.equal(m.matches(), true);
      assert.equal(m.groupCount, 1);
      assert.equal(m.group(1), null);
      assert.equal(m.start(1), -1);
      assert.equal(m.end(1), -1);
      m = engine.compile('(a)?b').matcher('ab');
      assert.equal(m.matches(), true);
      assert.equal(m.group(1), 'a');
    });

    test('a repeated group keeps its last iteration', () => {
      const m = engine.compile('(a)+').matcher('aaa');
      assert.equal(m.matches(), true);
      assert.equal(m.group(1), 'a');
      assert.equal(m.start(1), 2);
      assert.equal(m.end(1), 3);
    });

    test('find fills groups at each hit', () => {
      const m = engine.compile('([0-9]+)').matcher('ab12cd34');
      assert.equal(m.find(), true);
      assert.equal(m.group(1), '12');
      assert.equal(m.start(1), 2);
      assert.equal(m.find(), true);
      assert.equal(m.group(1), '34');
      assert.equal(m.start(1), 6);
    });

    test('escaped parentheses are literal', () => {
      const m = engine.compile('\\(([0-9]+)\\)').matcher('(42)');
      assert.equal(m.matches(), true);
      assert.equal(m.groupCount, 1);
      assert.equal(m.group(1), '42');
    });

    test('an empty group', () => {
      const m = engine.compile('a()b').matcher('ab');
      assert.equal(m.matches(), true);
      assert.equal(m.group(1), '');
      assert.equal(m.start(1), 1);
      assert.equal(m.end(1), 1);
    });
  });
}

test('no captures means a group count of zero', () => {
  const r = compile('abc');
  assert.equal(r.groupCount, 0);
  assert.equal(r.matches('abc'), true);
  assert.equal(r.match('abc')?.group(), 'abc');
});

test('an out-of-range group throws', () => {
  const m = compile('(a)').matcher('a');
  assert.equal(m.matches(), true);
  assert.throws(() => m.group(2), RangeError);
  assert.throws(() => m.start(-1), RangeError);
});

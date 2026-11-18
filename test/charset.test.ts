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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharSet, RegexCompilationError, liftAnchors, parse } from '../src/index.ts';

test('a CharSet is sorted, disjoint ranges', () => {
  const s = CharSet.range(0x61, 0x63).union(CharSet.of(0x62)).union(CharSet.range(0x64, 0x66)).union(CharSet.of(0x30));
  assert.equal(s.rangeCount(), 2);
  assert.equal(s.toString(), '[0a-f]');
  assert.equal(s.contains(0x65), true);
  assert.equal(s.contains(0x67), false);
  assert.equal(s.contains(0x30), true);
  assert.equal(s.complement().contains(0x67), true);
  assert.equal(s.complement().contains(0x61), false);
  assert.equal(s.complement().complement().equals(s), true);
  assert.equal(CharSet.EMPTY.complement().equals(CharSet.ANY), true);
  assert.equal(CharSet.ANY.complement().isEmpty(), true);
  assert.throws(() => CharSet.range(0x62, 0x61), RegexCompilationError);
});

test('the anchor lifter knows about escapes, quotes and classes', () => {
  assert.deepEqual(liftAnchors('^ab$'), { expression: 'ab', anchoredStart: true, anchoredEnd: true });
  assert.deepEqual(liftAnchors('ab\\$'), { expression: 'ab\\$', anchoredStart: false, anchoredEnd: false });
  assert.deepEqual(liftAnchors('\\Qfoo$'), { expression: '\\Qfoo$', anchoredStart: false, anchoredEnd: false });
  assert.deepEqual(liftAnchors('[]]$'), { expression: '[]]', anchoredStart: false, anchoredEnd: true });
  assert.deepEqual(liftAnchors('[$^]'), { expression: '[$^]', anchoredStart: false, anchoredEnd: false });
  assert.deepEqual(liftAnchors('\\Aa\\z'), { expression: 'a', anchoredStart: true, anchoredEnd: true });
  assert.deepEqual(liftAnchors('(a|b)$'), { expression: '(a|b)', anchoredStart: false, anchoredEnd: true });
  assert.throws(() => liftAnchors('a|b$'), RegexCompilationError);
  assert.throws(() => liftAnchors('^a|b'), RegexCompilationError);
  assert.throws(() => liftAnchors('a\\'), RegexCompilationError);
});

test('the parser numbers groups by their opening parenthesis and keeps names', () => {
  const p = parse('(a)(?:b)(?<x>c)(?P<y>(d))');
  assert.equal(p.groupCount, 4);
  assert.deepEqual([...p.groupNames], [['x', 2], ['y', 3]]);
  assert.equal(p.ast.kind, 'concat');
});

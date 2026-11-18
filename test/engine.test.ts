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
import {
  type CodeGenerator,
  type Dialect,
  Engine,
  GeneratedRegex,
  RegexCompilationError,
  canCompileCode,
  compile,
  estimateBytecode,
  jsGenerator,
  tableGenerator,
} from '../src/index.ts';

const FIRE = new Engine({ cache: 'none' });

function end(engine: Engine, pattern: string, input: string): number {
  return engine.compile(pattern).exec(input, 0);
}

function matches(d: Dialect, pattern: string, input: string): boolean {
  return new Engine({ dialect: d, cache: 'none' }).compile(pattern).matches(input);
}

/** The longest prefix of `input` that the JavaScript `RegExp` for `pattern` matches whole, or -1. */
function jsLongestPrefix(pattern: string, input: string): number {
  const re = new RegExp(`^(?:${pattern})$`);
  for (let len = input.length; len >= 0; len--) {
    if (re.test(input.substring(0, len))) {
      return len;
    }
  }
  return -1;
}

describe('the native engine', () => {
  test('matches the longest prefix', () => {
    const cases: [string, string, number][] = [
      ['[0-9]+', '12345', 5],
      ['[0-9]+', '12a45', 2],
      ['a*b', 'aaab', 4],
      ['(ab|cd)+', 'abcd', 4],
      ['x{0,3}', 'xxxxx', 3],
      ['x{2,3}', 'x', -1],
      ['x{3}', 'xxx', 3],
      ['[^0-9]+', 'abc', 3],
      ['\\d{2,4}', '123456', 4],
      ['[a-f0-9]+', '9af', 3],
      ['\\w+', 'a_1', 3],
      ['[[:digit:]]+', '42', 2],
      ['[\\s.-]+', ' .-', 3],
      ['(a|b|c)*', 'abcabc', 6],
    ];
    for (const [pattern, input, expected] of cases) {
      assert.equal(end(FIRE, pattern, input), expected, `${pattern} on "${input}"`);
      // RegExp misreads [[:class:]], so it cannot be the oracle there
      if (!pattern.includes('[:')) {
        assert.equal(end(FIRE, pattern, input), jsLongestPrefix(pattern, input), `should agree with RegExp: ${pattern}`);
      }
    }
  });

  test('an alternation with an empty branch', () => {
    const cases: [string, string, number][] = [
      ['(|-?[0-9]+)', '1234', 4],
      ['(|a)b', 'b', 1],
      ['(| )x', 'x', 1],
    ];
    for (const [pattern, input, expected] of cases) {
      assert.equal(end(FIRE, pattern, input), expected, `${pattern} on ${input}`);
      assert.equal(end(FIRE, pattern, input), jsLongestPrefix(pattern, input), `RegExp is the oracle: ${pattern}`);
    }
  });

  test('the minimiser distinguishes states by the ends of their ranges', () => {
    const cases: [string, string, number][] = [
      ['x[a-c]|z[a-f]', 'zd', 2],
      ['v[0-5]|w[0-9]', 'w8', 2],
      ['a[1-3]|b[1-9]', 'b7', 2],
      ['p[a-c]|q[a-f]', 'pd', -1],
    ];
    for (const [pattern, input, expected] of cases) {
      assert.equal(end(FIRE, pattern, input), expected, `${pattern} on "${input}"`);
      assert.equal(end(FIRE, pattern, input), jsLongestPrefix(pattern, input), `RegExp is the oracle: ${pattern}`);
    }
  });

  test('both repetition bounds are checked', () => {
    assert.throws(() => FIRE.compile('a{1,999999}'), RegexCompilationError, 'max');
    assert.throws(() => FIRE.compile('a{999999,}'), RegexCompilationError, 'min of {n,}');
  });

  test('either anchor beside a top-level alternation is refused', () => {
    assert.throws(() => FIRE.compile('a|b$'), RegexCompilationError);
    assert.throws(() => FIRE.compile('^a|b'), RegexCompilationError);
    // Inside a group it is expressible and must still work.
    assert.equal(end(FIRE, '(a|b)$', 'b'), 1);
  });

  test('a pattern with groups FIRE/J cannot plan compiles here', () => {
    // An empty alternation branch: FIRE/J's capture plan still goes through
    // the dk.brics front end, which rejects it; this port plans from its own
    // tree. All four affected regexlib rows are of this shape.
    const r = FIRE.compile('([0-9]+)(px|pt|)');
    assert.equal(r.groupCount, 2);
    assert.equal(r.exec('12px', 0), 4);
    assert.equal(r.exec('12', 0), 2);
  });

  test('a class is a set, not a rewrite', () => {
    for (const input of ['7', 'a', '', '77']) {
      const viaShorthand = end(FIRE, '\\d+', input);
      const viaRange = end(FIRE, '[0-9]+', input);
      const viaPosix = end(FIRE, '[[:digit:]]+', input);
      assert.equal(viaShorthand, viaRange, `\\d+ vs [0-9]+ on "${input}"`);
      assert.equal(viaPosix, viaRange, `[[:digit:]]+ vs [0-9]+ on "${input}"`);
    }
    assert.equal(FIRE.automaton('\\d+').encode(), FIRE.automaton('[0-9]+').encode());
    assert.equal(FIRE.automaton('[[:digit:]]+').encode(), FIRE.automaton('[0-9]+').encode());
  });

  test('wide classes do not enumerate characters', () => {
    assert.equal(end(FIRE, '[\\x{0100}-\\x{FFFF}]+', 'Ā中￿'), 3);
    assert.equal(end(FIRE, '[^a]', '中'), 1);
    assert.equal(FIRE.automaton('[^a]').stateCount, 2);
  });

  test('astral characters are code units, not code points', () => {
    assert.throws(() => FIRE.compile('\\x{1F600}'), RegexCompilationError, 'an escape above the BMP is refused');
    const grin = '😀'; // one code point, two code units
    assert.equal(end(FIRE, grin, grin), 2, 'a literal astral character matches as its pair');
    assert.equal(end(FIRE, '.', grin), 1, "'.' is a code unit");
    assert.equal(end(FIRE, '..', grin), 2, 'two of them make the character');
  });

  test('what needs an NFA is refused, not taken as a literal', () => {
    for (const pattern of ['a\\bc', '(?=x)y', '(a)\\1', '\\Kx', 'a\\Bc']) {
      assert.throws(() => FIRE.compile(pattern), RegexCompilationError, pattern);
    }
  });

  test('a pathological pattern fails fast rather than hanging', () => {
    assert.throws(() => FIRE.compile('a{1,999999}'), RegexCompilationError);
  });

  test('exec checks its offset', () => {
    const r = FIRE.compile('a*');
    assert.equal(r.exec('aaa', 3), 3);
    assert.throws(() => r.exec('aaa', 4), RangeError);
    assert.throws(() => r.exec('aaa', -1), RangeError);
    assert.throws(() => FIRE.compile('ab').matcher('ab').find(3), RangeError);
  });

  test('the automaton is numbered along walk paths and renders as DOT', () => {
    const dfa = FIRE.automaton('^(a|b)*abb$');
    assert.equal(dfa.startState, 0);
    assert.equal(dfa.anchoredStart, true);
    assert.equal(dfa.anchoredEnd, true);
    const dot = dfa.toDot();
    assert.match(dot, /digraph dfa/);
    assert.match(dot, /start -> 0 \[label="\^"\]/);
    assert.match(dot, /doublecircle,xlabel="\$"/);
    assert.match(dot, /label="\^\(a\|b\)\*abb\$"/, 'the pattern as written, anchors included, labels the graph');
    assert.match(dot, /-> \d+ \[label="a"\]/);
  });
});

describe('dialects', () => {
  const both: Dialect[] = ['extended', 'posix'];

  test('POSIX named classes work in both dialects', () => {
    for (const d of both) {
      assert.equal(matches(d, '[[:digit:]]+', '123'), true, `${d} should match digits`);
      assert.equal(matches(d, '[[:alpha:]]+', 'abc'), true, `${d} should match letters`);
      assert.equal(matches(d, '[[:alnum:]]+', 'a1b2'), true, `${d} should match alphanumerics`);
      assert.equal(matches(d, '[[:upper:]][[:lower:]]+', 'Abc'), true, `${d} should match Upper then lower`);
      assert.equal(matches(d, '[[:xdigit:]]+', '1aF'), true, `${d} should match hex digits`);
      assert.equal(matches(d, '[[:digit:]]+', '12a'), false, `${d} must not match a letter as a digit`);
      assert.equal(matches(d, '[[:digit:]]+', 'ddd'), false, `${d} must not read [[:digit:]] as the letters d, i, g, t`);
    }
  });

  test('plain POSIX ERE works in both dialects', () => {
    for (const d of both) {
      assert.equal(matches(d, '[0-9]{3}', '123'), true, d);
      assert.equal(matches(d, '(ab|cd)+', 'abcd'), true, d);
      assert.equal(matches(d, 'a*b', 'aaab'), true, d);
      assert.equal(matches(d, '[^0-9]+', 'abc'), true, d);
      assert.equal(matches(d, 'x?y', 'y'), true, d);
    }
  });

  const conveniences = ['\\d+', '\\w+', '\\s+', '\\p{Alpha}+', '(?:ab)+', '\\Qa.b\\E', '\\x41+'];

  test('extended accepts the conveniences', () => {
    for (const pattern of conveniences) {
      new Engine({ dialect: 'extended', cache: 'none' }).compile(pattern);
    }
  });

  test('posix rejects the conveniences, and says why', () => {
    for (const pattern of conveniences) {
      assert.throws(
        () => new Engine({ dialect: 'posix', cache: 'none' }).compile(pattern),
        (e: unknown) => e instanceof RegexCompilationError && e.message.includes('not POSIX ERE'),
        pattern,
      );
    }
  });

  test('posix refuses undefined escapes', () => {
    assert.throws(() => new Engine({ dialect: 'posix', cache: 'none' }).compile('\\q'), RegexCompilationError);
  });

  test('punctuation escapes are legal in both', () => {
    for (const d of both) {
      assert.equal(matches(d, 'a\\.b', 'a.b'), true, d);
      assert.equal(matches(d, 'a\\.b', 'axb'), false, d);
    }
  });

  test('neither dialect is PCRE', () => {
    for (const d of both) {
      for (const pattern of ['a\\bc', '(?=x)y', '(?!x)y', '(a)\\1', '\\Kx']) {
        assert.throws(() => new Engine({ dialect: d, cache: 'none' }).compile(pattern), RegexCompilationError, `${d} should refuse ${pattern}`);
      }
    }
  });

  test('the two spellings agree', () => {
    const pairs: [string, string, string[], string[]][] = [
      ['\\d+', '[[:digit:]]+', ['1', '123'], ['', '12a', 'abc']],
      ['\\w+', '[[:alnum:]_]+', ['a_1', 'Z'], ['a b', '-']],
      ['\\d{2,4}', '[[:digit:]]{2,4}', ['12', '1234'], ['1', '12345']],
    ];
    for (const [extended, posix, yes, no] of pairs) {
      for (const input of yes) {
        assert.equal(matches('extended', extended, input), true, `${extended} on ${input}`);
        assert.equal(matches('posix', posix, input), true, `${posix} on ${input}`);
      }
      for (const input of no) {
        assert.equal(matches('extended', extended, input), false, `${extended} on ${input}`);
        assert.equal(matches('posix', posix, input), false, `${posix} on ${input}`);
      }
      assert.equal(
        new Engine({ dialect: 'extended' }).automaton(extended).encode(),
        new Engine({ dialect: 'posix' }).automaton(posix).encode(),
        'one automaton',
      );
    }
  });

  test('extended is the default', () => {
    assert.equal(Engine.standard().dialect, 'extended');
    compile('\\d+');
  });
});

describe('anchors', () => {
  test('both anchors', () => {
    const p = FIRE.compile('^ab$');
    assert.equal(p.matches('ab'), true);
    assert.equal(p.matches('abc'), false);
    assert.equal(p.matcher('abc').lookingAt(), false);
    assert.equal(p.matcher('xab').find(), false);
    assert.equal(p.matcher('ab').find(), true);
  });

  test('a start anchor only matches at offset zero', () => {
    const p = FIRE.compile('^ab');
    assert.equal(p.matcher('abc').lookingAt(), true);
    assert.equal(p.matcher('xab').find(), false);
    const m = p.matcher('abab');
    assert.equal(m.find(), true);
    assert.equal(m.start(), 0);
    assert.equal(m.find(), false);
  });

  test('an end anchor requires the match to reach the end', () => {
    const p = FIRE.compile('ab$');
    assert.equal(p.matches('ab'), true);
    assert.equal(p.matcher('abc').lookingAt(), false);
    const m = p.matcher('xab');
    assert.equal(m.find(), true);
    assert.equal(m.start(), 1);
    assert.equal(m.end(), 3);
  });

  test('an end anchor does not fall back to a shorter match', () => {
    // Longest match of a* on "aab" is "aa"; with $ that is a failure, not "a".
    const r = FIRE.compile('a*$');
    assert.equal(r.exec('aab', 0), -1);
    assert.equal(r.exec('aaa', 0), 3);
    assert.equal(r.exec('', 0), 0);
  });

  test('the empty anchored pattern', () => {
    const p = FIRE.compile('^$');
    assert.equal(p.matches(''), true);
    assert.equal(p.matches('a'), false);
  });

  test('escaped and classed anchors are literal', () => {
    assert.equal(compile('\\$').matches('$'), true);
    assert.equal(compile('\\^').matches('^'), true);
    assert.equal(compile('[$^]+').matches('$^'), true);
    assert.equal(compile('[^$]').matches('a'), true);
    assert.equal(compile('[^$]').matches('$'), false);
  });

  test('anchors elsewhere are rejected', () => {
    for (const pattern of ['a^b', 'a$b', '(^a)', '(a$)', '^a|b', 'a|b$', '^^a', 'a$$']) {
      assert.throws(() => compile(pattern), RegexCompilationError, pattern);
    }
  });

  test('\\A and \\z are the anchors spelled the other way', () => {
    assert.equal(FIRE.automaton('\\Aab\\z').encode(), FIRE.automaton('^ab$').encode());
    assert.equal(FIRE.compile('\\Aab\\Z').matches('ab'), true);
    assert.equal(FIRE.compile('\\Aab\\Z').matcher('xab').find(), false);
  });
});

describe('engines and caches', () => {
  test('the memory cache hands out the same matcher', () => {
    const e = new Engine({ cache: 'memory' });
    assert.equal(e.compile('a+'), e.compile('a+'));
    e.evict('a+');
    assert.notEqual(e.compile('a+'), e.compile('b+'));
  });

  test('no cache compiles every time', () => {
    const e = new Engine({ cache: 'none' });
    assert.notEqual(e.compile('a+'), e.compile('a+'));
  });

  test('the last-instance cache keeps one', () => {
    const e = new Engine({ cache: 'last' });
    const a = e.compile('a+');
    assert.equal(e.compile('a+'), a);
    e.compile('b+');
    assert.notEqual(e.compile('a+'), a);
    e.clearCache();
  });

  test('a custom generator and cache plug in', () => {
    let compiles = 0;
    const counting: CodeGenerator = {
      name: 'counting',
      compile(dfa, parsed) {
        compiles++;
        return tableGenerator.compile(dfa, parsed);
      },
    };
    const seen: string[] = [];
    const e = new Engine({
      generator: counting,
      cache: {
        name: 'recording',
        get: (p) => {
          seen.push(p);
          return undefined;
        },
        set() {},
        delete() {},
        clear() {},
      },
    });
    assert.equal(e.compile('(a)(b)').matches('ab'), true);
    assert.equal(compiles, 1);
    assert.deepEqual(seen, ['(a)(b)']);
    assert.equal(String(e), 'Engine[extended > counting, cache recording]');
    assert.equal(String(Engine.standard()), 'Engine[extended > js, cache memory]');
  });

  test('a pattern must be a string', () => {
    assert.throws(() => compile(undefined as unknown as string), TypeError);
  });

  test('auto is js where code can be compiled from text', () => {
    assert.equal(canCompileCode(), true);
    assert.equal(String(new Engine()), 'Engine[extended > js, cache memory]');
    assert.ok(compile('a+') instanceof GeneratedRegex);
  });
});

describe('the code generator', () => {
  test('the source reads as the automaton', () => {
    const plain = Engine.standard().toJavaScript('^[0-9]+[a-f]$', { threaded: false });
    assert.match(plain, /return function walk\(input, start\)/);
    assert.match(plain, /if \(start !== 0\) return -1;/, 'the start anchor');
    assert.match(plain, /return rv === len \? rv : -1;/, 'the end anchor');
    assert.match(plain, /if \(c >= 48 && c <= 57\) \{ state = 1; continue loop; \}/, 'every character goes through the switch');
    assert.match(plain, /rv = i \+ 1;/, 'an accepting destination records the position');
    assert.doesNotMatch(plain, /MAP\[/, 'two ranges keep the compare chain');
    assert.match(Engine.standard().toJavaScript('[a-zA-Z0-9_]+'), /switch \(c < \d+ \? MAP\[c\] : \d+\)/, 'more ranges use the class map');
    assert.doesNotMatch(Engine.standard().toJavaScript('[a-zA-Z0-9_]+', { classMap: false }), /MAP\[/);

    const threaded = Engine.standard().toJavaScript('[0-9]+\\.[a-f]');
    assert.match(threaded, /s1: for \(;;\) \{/, 'a self-loop is a loop of its own');
    assert.match(threaded, /c >= 48 && c <= 57\) \{ i\+\+; continue; \}/, 'staying in the state continues the inner loop');
    assert.match(threaded, /c === 46\) \{ i\+\+; break s1; \}/, 'the next state is reached by falling through');
    assert.match(threaded, /\{ i\+\+; rv = i; \}\n\s+else break loop;/, 'an accepting destination records the position');
    assert.doesNotMatch(threaded, /continue loop/, 'a chain needs no dispatch at all');
  });

  test('a walk over the budget is split into segments that agree with the single walk', () => {
    const pattern = '([a-z]+[0-9]{2}-)+x';
    const whole = new Engine({ generator: 'js', cache: 'none' }).compile(pattern) as GeneratedRegex;
    const split = new Engine({ generator: jsGenerator({ split: 300 }, 'js-split'), cache: 'none' }).compile(pattern) as GeneratedRegex;
    assert.equal(whole.segments, 1);
    assert.ok(split.segments > 1, `split into ${split.segments}`);
    assert.match(split.source, /function seg1\(input, len, state\)/);
    assert.match(split.source, /OUT\[0\] = i \+ 1; OUT\[1\] = /, 'a hop stores the position and the accept position');
    const table = new Engine({ generator: 'table', cache: 'none' }).compile(pattern);
    for (const input of ['ab12-x', 'ab12-cd34-x', 'ab12-cd3-x', 'x', 'zz99-zz99-zz99-zz99-x!', '']) {
      for (let i = 0; i <= input.length; i++) {
        assert.equal(split.exec(input, i), table.exec(input, i), `exec(${i}) on ${input}`);
        assert.equal(whole.exec(input, i), table.exec(input, i), `exec(${i}) on ${input}`);
      }
    }
  });

  test('the bytecode estimate is near the measured sizes', () => {
    // Measured with node --print-bytecode --print-bytecode-filter=walk on Node 26 (2026-10-18);
    // [pattern, class map, threaded, bytes]
    const measured: [string, boolean, boolean, number][] = [
      ['x'.repeat(1024), true, true, 54558],
      ['[0-9]{1024}', true, true, 64548],
      ['.{1024}', true, true, 98636],
      ['[a-zA-Z0-9_]{1024}', true, true, 109449],
      ['[a-zA-Z0-9_]{1024}', false, true, 147579],
      ['[aeiouAEIOU0-9]{1024}', true, true, 144684],
      ['[aeiouAEIOU0-9]{1024}', false, true, 274666],
      ['[a-zA-Z0-9_]{256}', true, true, 25731],
      ['x'.repeat(1024), true, false, 22661],
      ['[0-9]{1024}', true, false, 32647],
      ['[a-zA-Z0-9_]{1024}', true, false, 84281],
      ['[a-zA-Z0-9_]{1024}', false, false, 110551],
      ['[aeiouAEIOU0-9]{1024}', true, false, 111786],
      ['[a-zA-Z0-9_]{256}', true, false, 18995],
    ];
    const engine = new Engine({ generator: 'table', cache: 'none' });
    for (const [pattern, classMap, threaded, bytes] of measured) {
      const estimate = estimateBytecode(engine.automaton(pattern), classMap, threaded);
      assert.ok(
        estimate > bytes * 0.85 && estimate < bytes * 1.2,
        `${pattern.slice(0, 20)} classMap=${classMap} threaded=${threaded}: estimated ${estimate}, measured ${bytes}`,
      );
    }
    const big = new Engine({ generator: 'js', cache: 'none' }).compile('[a-zA-Z0-9_]{1024}') as GeneratedRegex;
    assert.ok(big.segments >= 2, 'a walk estimated past the budget is split');
    const small = new Engine({ generator: 'js', cache: 'none' }).compile('[a-zA-Z0-9_]{256}') as GeneratedRegex;
    assert.equal(small.segments, 1);
  });
});

/**
 * JavaScript's `RegExp` as an exact oracle for the *language*: the longest
 * match from `start` is the largest `end` for which the anchored pattern
 * matches `input.slice(start, end)`. From it every `exec` offset, `matches`
 * and the whole `find` walk are checked, on inputs drawn by a seeded
 * generator over a small alphabet so that the patterns actually fire.
 */
describe('RegExp as the language oracle', () => {
  const patterns = [
    'a', 'ab', 'a|b', 'a*', 'a+b*', '(ab)+', '(a|b)*abb', 'a?b?c?', '[ab]+c', '[^a]+',
    'a{2}', 'a{2,}', 'a{1,3}b', '(a|ab)(c|bcd)(d*)', '(ab|a)(bc|c)?', 'x*y*z*', '(a*)*b',
    '\\d+\\.\\d+', '[a-c]+-[a-c]+', '(a|b)(a|b)(a|b)', 'a(b|c)*d', '(ab)*(ba)*', '.a.', 'a.*b',
    '(aa|a)+b', '(a|)b', '(|a)+', '[abc]{2,4}', 'ab|abc|abcd', '(a|b)+(c|d)+',
  ];
  const alphabet = 'abcd12.-';
  let seed = 0x9e3779b9;
  const next = (): number => {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const randomInput = (): string => {
    const n = Math.floor(next() * 9);
    let s = '';
    for (let i = 0; i < n; i++) {
      s += alphabet.charAt(Math.floor(next() * alphabet.length));
    }
    return s;
  };

  const backEnds = ['table', 'dense', 'js', 'js-ranges', 'js-switch'].map((g) => new Engine({ generator: g as 'table', cache: 'none' }));
  backEnds.push(new Engine({ generator: jsGenerator({ split: 300 }, 'js-split'), cache: 'none' }));

  for (const pattern of patterns) {
    test(`/${pattern}/`, () => {
      const regexes = backEnds.map((e) => e.compile(pattern));
      const anchored = new RegExp(`^(?:${pattern})$`);
      for (let k = 0; k < 60; k++) {
        const input = randomInput();
        for (let start = 0; start <= input.length; start++) {
          let expected = -1;
          for (let e = input.length; e >= start; e--) {
            if (anchored.test(input.slice(start, e))) {
              expected = e;
              break;
            }
          }
          for (const regex of regexes) {
            assert.equal(regex.exec(input, start), expected, `exec(${start}) on ${JSON.stringify(input)}`);
          }
        }
        assert.equal(regexes[0]!.matches(input), anchored.test(input), `matches(${JSON.stringify(input)})`);
      }
    });
  }
});

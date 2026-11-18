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

/**
 * The library's behaviour as tables of cases, shared with FIRE/J's
 * `RegexCasesTest`: whole-input matches with their capturing groups, the
 * longest prefix `lookingAt` takes, and the sequence `find` walks.
 *
 * Every expectation here is the leftmost-longest answer. Where that differs
 * from a backtracking engine the row says so.
 */

/** `groups === null`: the input must not match. */
export interface Full {
  readonly pattern: string;
  readonly input: string;
  readonly groups: readonly (string | null)[] | null;
}

function yes(pattern: string, input: string, ...groups: (string | null)[]): Full {
  return { pattern, input, groups };
}

function no(pattern: string, input: string): Full {
  return { pattern, input, groups: null };
}

export const FULL: readonly Full[] = [
  // literals
  yes('abc', 'abc'),
  no('abc', 'abd'),
  no('abc', 'ab'),
  no('abc', 'abcd'),
  yes('', ''),
  no('', 'a'),
  yes('a b', 'a b'),
  yes('été', 'été'),
  yes('日本', '日本'),
  // character classes
  yes('[abc]', 'b'),
  no('[abc]', 'd'),
  yes('[a-z]+', 'hello'),
  no('[a-z]+', 'Hello'),
  yes('[^a-z]+', 'ABC123'),
  no('[^a-z]+', 'ABcD'),
  yes('[a-zA-Z0-9_]+', 'Az_09'),
  yes('[-a]+', 'a-a'),
  yes('[a-]+', '-a-'),
  yes('[]a]+', ']a]'),
  yes('[^]a]', 'b'),
  no('[^]a]', ']'),
  yes('[.]', '.'),
  no('[.]', 'x'),
  yes('[$^]+', '^$'),
  yes('[\\]]', ']'),
  yes('[\\\\]', '\\'),
  yes('[\\-x]+', '-x-'),
  // shorthands
  yes('\\d+', '0123456789'),
  no('\\d', 'a'),
  yes('\\D+', 'abc'),
  no('\\D', '5'),
  yes('\\w+', 'word_42'),
  no('\\w', '-'),
  yes('\\W+', ' -!'),
  yes('\\s+', ' \t\n\r\f\u000b'),
  no('\\s', 'x'),
  yes('\\S+', 'abc'),
  yes('[\\d\\s]+', '1 2\t3'),
  yes('[a\\D]+', 'abc'),
  yes('[^\\d]+', 'abc'),
  no('[^\\d]+', 'a1'),
  yes('\\p{Alpha}+', 'abcXYZ'),
  yes('\\p{Digit}+', '42'),
  yes('\\p{Upper}\\p{Lower}+', 'Hello'),
  yes('\\p{Punct}+', '!?.,'),
  yes('\\P{Digit}+', 'abc'),
  yes('\\p{XDigit}+', 'deadBEEF09'),
  no('\\p{XDigit}+', 'xyz'),
  // escapes that name a character
  yes('a\\tb', 'a\tb'),
  yes('a\\nb', 'a\nb'),
  yes('\\x41\\x{42}', 'AB'),
  yes('\\u0041', 'A'),
  yes('\\0101', 'A'),
  yes('\\cA', '\u0001'),
  yes('\\e', '\u001b'),
  yes('\\.', '.'),
  no('\\.', 'x'),
  yes('\\*\\+\\?', '*+?'),
  yes('\\(\\)\\[\\]\\{\\}', '()[]{}'),
  yes('\\|', '|'),
  yes('\\$', '$'),
  yes('\\^', '^'),
  yes('\\Q.*+?\\E', '.*+?'),
  no('\\Q.*\\E', 'ab'),
  yes('\\Qa(b)\\E(c)', 'a(b)c', 'c'),
  // characters that are operators in the dk.brics syntax
  yes('a@b', 'a@b'),
  yes('#1', '#1'),
  yes('<a>', '<a>'),
  yes('~x&y', '~x&y'),
  yes('"q"', '"q"'),
  // dot
  yes('.', 'x'),
  yes('...', 'a b'),
  no('.', '\n'),
  yes('a.c', 'a-c'),
  no('a.c', 'a\nc'),
  // quantifiers
  yes('a*', ''),
  yes('a*', 'aaaa'),
  no('a+', ''),
  yes('a+', 'aaa'),
  yes('a?', ''),
  yes('a?', 'a'),
  no('a?', 'aa'),
  yes('ab*c', 'ac'),
  yes('ab*c', 'abbbc'),
  yes('ab+c', 'abc'),
  no('ab+c', 'ac'),
  yes('a{3}', 'aaa'),
  no('a{3}', 'aa'),
  no('a{3}', 'aaaa'),
  yes('a{2,}', 'aaaaa'),
  no('a{2,}', 'a'),
  yes('a{2,4}', 'aa'),
  yes('a{2,4}', 'aaaa'),
  no('a{2,4}', 'aaaaa'),
  yes('a{0,2}', ''),
  yes('[0-9]{2,3}-[0-9]{2}', '123-45'),
  no('[0-9]{2,3}-[0-9]{2}', '1-45'),
  yes('(ab){2}', 'abab', 'ab'),
  yes('(?:ab){2,3}', 'ababab'),
  no('(?:ab){2,3}', 'abababab'),
  // lazy and possessive suffixes denote the same language
  yes('a+?', 'aaa'),
  yes('a*?b', 'aab'),
  yes('a{1,3}?', 'aaa'),
  yes('a++', 'aaa'),
  yes('a*+b', 'aab'),
  // alternation
  yes('cat|dog', 'cat'),
  yes('cat|dog', 'dog'),
  no('cat|dog', 'cow'),
  yes('a|ab|abc', 'ab'),
  yes('(red|green|blue) car', 'green car', 'green'),
  yes('x(a|b|c)+y', 'xabcabcy', 'c'),
  yes('(a|b)(c|d)', 'bd', 'b', 'd'),
  // groups
  yes('(a)', 'a', 'a'),
  yes('(a)(b)(c)', 'abc', 'a', 'b', 'c'),
  yes('((a)(b))', 'ab', 'ab', 'a', 'b'),
  yes('(((x)))', 'x', 'x', 'x', 'x'),
  yes('a()b', 'ab', ''),
  yes('(a*)b', 'b', ''),
  yes('(a*)b', 'aaab', 'aaa'),
  yes('(a)?b', 'b', null),
  yes('(a)?b', 'ab', 'a'),
  yes('(a)|(b)', 'a', 'a', null),
  yes('(a)|(b)', 'b', null, 'b'),
  yes('(a)+', 'aaa', 'a'),
  yes('(ab)+', 'ababab', 'ab'),
  yes('(a|b)*', 'abba', 'a'),
  yes('(a|b)*', '', null),
  yes('((a)|(b))+', 'ab', 'b', 'a', 'b'),
  yes('((a)|(b))+', 'ba', 'a', 'a', 'b'),
  yes('(?:a)(b)', 'ab', 'b'),
  yes('(?:(a)|b)(c)', 'bc', null, 'c'),
  yes('(?<first>[a-z]+) (?<last>[a-z]+)', 'ada lovelace', 'ada', 'lovelace'),
  yes('(?P<n>\\d+)', '42', '42'),
  yes('(?#a comment)abc', 'abc'),
  yes('(\\d+)\\.(\\d+)', '3.14', '3', '14'),
  yes('([a-z]+)([0-9]*)', 'abc123', 'abc', '123'),
  yes('([a-z]+)([0-9]*)', 'abc', 'abc', ''),
  yes('(x?)(x?)x', 'xx', 'x', ''),
  yes('(a+)(a+)', 'aaaa', 'aaa', 'a'),
  yes('(a*)(a*)', 'aaa', 'aaa', ''),
  yes('(.*)(\\d+)', 'abc123', 'abc12', '3'),
  yes('(a{2,3})(a*)', 'aaaaa', 'aaa', 'aa'),
  yes('(\\s*)(\\S+)(\\s*)', '  hi  ', '  ', 'hi', '  '),
  yes('([^,]*),([^,]*),([^,]*)', 'a,,c', 'a', '', 'c'),
  yes('((a)(b))*', 'abab', 'ab', 'a', 'b'),
  yes('(ab|a)(bc|c)?', 'abc', 'ab', 'c'),
  yes('(\\()([^)]*)(\\))', '(in)', '(', 'in', ')'),
  // anchors
  yes('^abc$', 'abc'),
  no('^abc$', 'abcd'),
  yes('^a*$', ''),
  yes('^(a+)$', 'aa', 'aa'),
  yes('^[0-9]+', '123'),
  yes('[0-9]+$', '123'),
  // real-world shapes
  yes('([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})', '192.168.0.1', '192', '168', '0', '1'),
  no('([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})', '192.168.0'),
  yes(
    '(([01]?[0-9][0-9]?|2[0-4][0-9]|25[0-5])\\.){3}([01]?[0-9][0-9]?|2[0-4][0-9]|25[0-5])',
    '255.0.10.199',
    '10.',
    '10',
    '199',
  ),
  no('(([01]?[0-9][0-9]?|2[0-4][0-9]|25[0-5])\\.){3}([01]?[0-9][0-9]?|2[0-4][0-9]|25[0-5])', '256.0.0.1'),
  yes('([\\w.+-]+)@([\\w-]+)\\.([a-z]{2,})', 'first.last+tag@example.org', 'first.last+tag', 'example', 'org'),
  no('([\\w.+-]+)@([\\w-]+)\\.([a-z]{2,})', 'no-at-sign.org'),
  yes('(\\d{4})-(\\d{2})-(\\d{2})', '2026-10-07', '2026', '10', '07'),
  no('(\\d{4})-(\\d{2})-(\\d{2})', '2026-1-07'),
  yes('(\\d{2}):(\\d{2})(?::(\\d{2}))?', '09:30', '09', '30', null),
  yes('(\\d{2}):(\\d{2})(?::(\\d{2}))?', '09:30:15', '09', '30', '15'),
  yes('#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})', '#FF8800', 'FF', '88', '00'),
  yes('(https?)://([^/:]+)(:\\d+)?(/.*)?', 'https://example.com:8080/a/b', 'https', 'example.com', ':8080', '/a/b'),
  yes('(https?)://([^/:]+)(:\\d+)?(/.*)?', 'http://example.com', 'http', 'example.com', null, null),
  no('(https?)://([^/:]+)(:\\d+)?(/.*)?', 'ftp://example.com'),
  yes('(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?', '1.12.0-rc.1', '1', '12', '0', 'rc.1'),
  yes('(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?', '2.0.0', '2', '0', '0', null),
  yes('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '123e4567-e89b-12d3-a456-426614174000'),
  yes('\\(?(\\d{3})\\)?[ -]?(\\d{3})-(\\d{4})', '(555) 123-4567', '555', '123', '4567'),
  yes('\\(?(\\d{3})\\)?[ -]?(\\d{3})-(\\d{4})', '555-123-4567', '555', '123', '4567'),
  yes('([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*("[^"]*"|\\d+)', 'name = "firej"', 'name', '"firej"'),
  yes('([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*("[^"]*"|\\d+)', 'count=42', 'count', '42'),
  yes(
    '(\\S+) (\\S+) (\\S+) \\[([^\\]]+)\\] "([A-Z]+) ([^ ]+) [^"]+" (\\d{3}) (\\d+)',
    '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /a.gif HTTP/1.0" 200 2326',
    '127.0.0.1',
    '-',
    'frank',
    '10/Oct/2000:13:55:36 -0700',
    'GET',
    '/a.gif',
    '200',
    '2326',
  ),
  // inputs longer than FIRE/J's 64-character copy window, kept for parity
  yes('(a+)(b+)', 'a'.repeat(100) + 'b'.repeat(50), 'a'.repeat(100), 'b'.repeat(50)),
  yes('([a-z]+)-(\\d+)', 'x'.repeat(70) + '-123', 'x'.repeat(70), '123'),
  no('[a-z]+', 'x'.repeat(80) + '1'),
];

/** `prefix === null`: nothing matches at offset 0. */
export interface Prefix {
  readonly pattern: string;
  readonly input: string;
  readonly prefix: string | null;
}

export const PREFIX: readonly Prefix[] = [
  { pattern: '[0-9]+', input: '123abc', prefix: '123' },
  { pattern: '[0-9]+', input: 'abc123', prefix: null },
  { pattern: '[0-9]*', input: 'abc', prefix: '' },
  { pattern: 'a|ab|abc', input: 'abcd', prefix: 'abc' }, // a backtracker takes "a"
  { pattern: 'ab|a', input: 'abc', prefix: 'ab' },
  { pattern: 'a*?', input: 'aaa', prefix: 'aaa' }, // lazy is ignored: longest wins
  { pattern: '(a|ab)(c|bcd)', input: 'abcd', prefix: 'abcd' },
  { pattern: '\\w+@\\w+', input: 'me@host and more', prefix: 'me@host' },
  { pattern: '.*', input: 'line one\nline two', prefix: 'line one' },
  { pattern: 'a{2,3}', input: 'aaaa', prefix: 'aaa' },
  { pattern: '^abc', input: 'abcdef', prefix: 'abc' },
  { pattern: 'abc$', input: 'abcdef', prefix: null },
  { pattern: 'abc$', input: 'abc', prefix: 'abc' },
  { pattern: '(ab)*a', input: 'ababab', prefix: 'ababa' },
  { pattern: 'x*', input: '', prefix: '' },
  { pattern: '[a-z]+', input: 'a'.repeat(200) + '!', prefix: 'a'.repeat(200) },
  { pattern: '[a-z]+$', input: 'a'.repeat(200), prefix: 'a'.repeat(200) },
  { pattern: '[a-z]+$', input: 'a'.repeat(200) + '!', prefix: null },
];

/** Each hit as `start:text`. */
export interface Find {
  readonly pattern: string;
  readonly input: string;
  readonly hits: readonly string[];
}

function find(pattern: string, input: string, ...hits: string[]): Find {
  return { pattern, input, hits };
}

export const FIND: readonly Find[] = [
  find('[0-9]+', 'ab12cd345e6', '2:12', '6:345', '10:6'),
  find('[0-9]+', 'no digits'),
  find('cat', 'concatenate a cat', '3:cat', '14:cat'),
  find('a|ab', 'abab', '0:ab', '2:ab'), // a backtracker finds "a" twice
  find('a*', 'baaac', '0:', '1:aaa', '4:', '5:'), // empty matches advance by one
  find('x?', '', '0:'),
  find('[a-z]+', 'one two  three', '0:one', '4:two', '9:three'),
  find('\\w+@\\w+\\.com', 'mail a@b.com or c@d.com.', '5:a@b.com', '16:c@d.com'),
  find('(\\d+)-(\\d+)', '1-2, 33-44', '0:1-2', '5:33-44'),
  find('aa', 'aaaaa', '0:aa', '2:aa'), // matches do not overlap
  find('^a', 'aaa', '0:a'),
  find('a$', 'aaa', '2:a'),
  find('^$', '', '0:'),
  find('[A-Z][a-z]+', 'Hello World From FIREJ', '0:Hello', '6:World', '12:From'),
  find('\\s+', 'a  b\tc', '1:  ', '4:\t'),
  find('.', 'a\nb', '0:a', '2:b'),
  find('[a-z]+', 'x'.repeat(70) + ' yz', '0:' + 'x'.repeat(70), '71:yz'),
];

/**
 * Patterns the engine must refuse rather than read some other way: what a
 * DFA cannot express, and what is malformed.
 */
export const REJECTED: readonly string[] = [
  '\\b', '\\B', 'a\\bc', '(?=a)', '(?!a)', '(?<=a)b', '(?<!a)b', '(a)\\1', '\\k<n>',
  '(?i)a', '(?(1)a|b)', '\\G', '\\R', '\\X', '\\h', '\\v', '\\x{1F600}', '\\p{Nope}',
  'a^b', 'a$b', '^a|b', 'a|b$',
  '[a', '(a', 'a)', '\\',
  '*a', '+', '?', '(*a)', 'a|*b', 'x(*SKIP)(*F)|y',
  'a{2,1}', '[z-a]', '[a-c9-0]',
];

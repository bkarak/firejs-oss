# FIRE/JS

DFA regular expressions for JavaScript. Each pattern is compiled to a minimal
deterministic automaton over character ranges, so matching is a straight walk
in linear time: no backtracking, no catastrophic cases, no ReDoS.

This is the JavaScript port of [FIRE/J](https://github.com/bkarak/firej-oss), the
engine described in:

> Vassilios Karakoidas and Diomidis Spinellis. FIRE/J — optimizing regular
> expression searches with generative programming. *Software: Practice and
> Experience*, 38(6):557–573, May 2008.
> [doi:10.1002/spe.841](https://doi.org/10.1002/spe.841)

The port is checked against FIRE/J row for row: over 4,200 real-world
patterns, both build the same minimal automaton and walk it to the same
result from every offset of the sample input (see [Testing](#testing)).

## Status

The port is complete: the dialect, the automaton pipeline
(Thompson, subset construction, Hopcroft minimisation over ranges), capturing
groups, the `Regex`/`Matcher` API, four back ends — a generated function per
pattern (the default), the same with compare chains, a dense transition
table, and a range-scanning table walker — a search automaton that finds
where matches start in one pass, and a streaming matcher. Not published to
npm yet.

## Requirements

Node 22.18 or later (the tests run TypeScript directly). No runtime
dependencies.

## Usage

```ts
import { compile } from '@bkarak/firejs';

compile('[0-9]{3}-[0-9]{2}-[0-9]{4}').matches('333-22-4444');   // true

const date = compile('(\\d{4})-(\\d{2})-(\\d{2})');
date.exec('on 2026-10-07', 3);          // 13: the exclusive end of the match from offset 3
date.exec('on 2026-10-07', 0);          // -1: nothing matches at offset 0
date.groupCount;                        // 3

const m = date.match('2026-10-07');     // the whole-input match with its groups, or null
m.group(1);                             // "2026"
m.start(2);                             // 5

const log = compile('(?<ip>\\S+) \\S+ (?<user>\\S+) \\[([^\\]]+)\\]');
log.match('127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700]')?.group('user');   // "frank"

const words = compile('[a-z]+').matcher('one two  three');
while (words.find()) {
  console.log(words.start(), words.group());   // 0 one, 4 two, 9 three
}
compile('needle[0-9]+').find(haystack)?.start();   // the first match, in one pass over the input

const stream = compile('[a-z]+@[a-z]+\\.com').stream();
stream.feed('joe@exa').feed('mple.com');          // chunks match without being joined
stream.matches();                                 // true
```

A `Regex` is immutable and holds no input, so one instance serves every call
site. `exec(input, start)` is the whole engine — the exclusive end of the
longest match from `start`, or -1 — and `matches`, `lookingAt`, `match` and
`Matcher` are built on it. `Matcher` follows `java.util.regex.Matcher`:
`matches()`, `lookingAt()`, `find()`, `start()`, `end()`, `group()`, by group
number or name. A group that took no part in the match is `null` with offsets
-1.

Groups are recovered *after* the automaton has fixed the span, by one parse
of exactly that span, so `exec` never pays for them. On short inputs that
recovery costs many times the walk: call `exec` when only the span matters.

`find` does not try every offset: the first time a `Matcher` searches an
input, one backward pass of the *search automaton* — the reversed pattern
preceded by anything — marks every offset where a match begins, and each
`find` then walks forward from the next marked offset. A `stream()` keeps
the automaton's state between chunks and answers what `exec` would on the
chunks so far; a `RegExp` cannot resume across a chunk boundary.

### Matching semantics

FIRE/JS is a DFA engine, so it reports the **leftmost-longest** match, not
the first match a backtracking engine finds. Both recognise the same
language, so `matches()` answers as `RegExp` does; `lookingAt()` and `find()`
can stop later:

| pattern | input | FIRE/JS | `RegExp` |
|---|---|---|---|
| `a\|ab\|abc` | `abcd`, `lookingAt` | `abc` | `a` |
| `a\|ab` | `abab`, `find` × 2 | `ab`, `ab` | `a`, `a` |

Groups follow the POSIX rule: left to right, every quantifier and alternative
takes as much of the matched span as still lets the rest match. Where a
backtracker's first parse is also that one, the two agree. They differ when
it is not:

| pattern | input | FIRE/JS groups | `RegExp` groups |
|---|---|---|---|
| `(a\|ab)(c\|bcd)(d*)` | `abcd` | `ab`, `c`, `d` | `a`, `bcd`, (empty) |
| `(.*?)(\d+)` | `abc123` | `abc12`, `3` | `abc`, `123` |
| `((a)\|(b))+` | `ab` | `b`, `a`, `b` | `b`, `undefined`, `b` |

A lazy or possessive quantifier denotes the same language as the greedy one,
so it is accepted and matches as if it were greedy. A repeated group keeps its
last non-empty iteration. Matching is over UTF-16 code units, as `RegExp`
without the `u` flag: a character above the Basic Multilingual Plane is two
of them.

### Dialect

The default dialect, `extended`, is the Perl/Java syntax as far as a DFA can
take it:

- classes, ranges, negation, and `\d \w \s` with their negations
- the ASCII `\p{...}` / `\P{...}` classes and POSIX `[[:alpha:]]` classes
- escapes that name a character: `\t \n \xHH \x{...} \uHHHH \0oo \cX`, and `\Q...\E`
- `(?:...)`, named groups `(?<n>...)` / `(?P<n>...)`, and comments `(?#...)`
- `.`, which excludes newline
- a leading `^` (or `\A`) and a trailing `$` (or `\z`)

Anything a DFA cannot express is **refused at compile time with
`RegexCompilationError`** instead of being misread: word boundaries,
backreferences, lookaround, inline flags, conditionals, code points above the
BMP, an anchor anywhere but the two ends or next to a top-level `|`, a
quantifier with nothing to repeat, and reversed ranges like `[z-a]` or `a{2,1}`.

`new Engine({ dialect: 'posix' })` restricts the syntax to POSIX ERE, where a
digit is `[[:digit:]]` and `\d` is an error.

### Configuring an engine

```ts
import { Engine } from '@bkarak/firejs';

const engine = new Engine({
  dialect: 'extended',   // or 'posix'
  generator: 'auto',     // how an automaton becomes a matcher
  cache: 'memory',       // 'memory' keeps every matcher, 'last' the last one, 'none' none
});
engine.toString();       // Engine[extended > js, cache memory]
const r = engine.compile('a+');
```

The generators:

- **`js`** (the default where code may be compiled from text) generates a
  function per pattern with `new Function`, threaded as far as JavaScript
  allows: a state that loops on itself consumes its run in a loop of its
  own, a transition to the next state in the layout falls through the
  `switch` into that state's block, and only the other transitions go back
  through the dispatch — JavaScript has no `goto` for the paper's threaded
  code, so this is as close as it gets. A state with more than two ranges
  resolves its character through a class map (one `Uint16Array` load and a
  second `switch`); a state with one or two keeps a compare chain. Large
  walks are emitted as a plain loop + `switch` (the threaded form compiles
  poorly past ~24 KB of bytecode) and, past 48 KB, split into segment
  functions that hand the state to each other, under V8's limit of 60 KB
  beyond which a function is never optimised.
- **`js-ranges`** is the same with a compare chain in every state, kept so
  the class map's share of the speed can be measured.
- **`js-switch`** is the plain loop + `switch` for every size — the paper's
  Algorithm 1 as written — kept so the threading's share can be measured.
- **`dense`** walks a dense transition table indexed by state and character
  class — the design of the Brics `RunAutomaton` — with no code generation,
  so it runs under a Content Security Policy that forbids `eval`.
- **`table`** scans each state's ranges in order; the smallest, and the
  oracle the others are tested against.
- **`auto`** is `js` if `new Function` works in the runtime, else `dense`.

`generator` and `cache` also take an object implementing `CodeGenerator` or
`RegexCache`, which is how a back end or a bounded cache plugs in.

### Inspecting what a pattern compiles to

```ts
const dfa = engine.automaton('^[0-9]+$');   // states, accept flags, ranges, anchors
dfa.encode();                               // a canonical text form: "-,48-57>1;A,48-57>1"
engine.toDot('(a|b)*abb');                  // Graphviz: dot -Tsvg
engine.toJavaScript('[0-9]+');              // the walker the js generator compiles
```

## Testing

```bash
npm test          # node --test, TypeScript run directly
npm run check     # tsc, types only
npm run build     # dist/ with declarations
```

The suite has three parts:

- **Case tables** (`test/cases.ts`, shared with FIRE/J's `RegexCasesTest`;
  `test/capture.test.ts`, from its `CaptureSemanticsTest` and
  `CapturingGroupTest`): whole-input matches with every group, longest
  prefixes, `find` sequences, patterns that must be refused, and where the
  POSIX group rule departs from a backtracker's.
- **FIRE/J as the oracle** (`test/oracle.test.ts`): `tools/oracle/regen.sh`
  compiles FIRE/J's native pipeline from its sources — javac alone, no Maven
  — and writes, for every row of the two corpora in `test/fixtures/` (917
  patterns from 2007 and 3,302 from regex101.com), the automaton in a
  canonical form, its anchors and state count, the end of the longest match
  from every offset of the sample input, and the groups of the match at
  offset 0. The port must reproduce every row. It does, and on six rows it
  finds groups FIRE/J leaves unset — an empty alternation branch its capture
  plan misreads; those are listed in the test as known upstream defects.
- **`RegExp` as the language oracle** (`test/engine.test.ts`): for patterns
  both engines read, the longest match from every offset of random inputs is
  the largest end the anchored `RegExp` accepts.

## License

Apache License 2.0. See [LICENSE](LICENSE).

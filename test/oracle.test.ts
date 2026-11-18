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
import { createHash } from 'node:crypto';
import {
  type CodeGenerator,
  Engine,
  MatchResult,
  RegexCompilationError,
  denseGenerator,
  jsGenerator,
  tableGenerator,
} from '../src/index.ts';
import { loadCorpus, loadOracle } from './corpus.ts';

/** Every back end walks every row: the automaton is built once, each walker from it. */
const GENERATORS: readonly CodeGenerator[] = [
  tableGenerator,
  denseGenerator,
  jsGenerator({ classMap: true }, 'js'),
  jsGenerator({ classMap: false }, 'js-ranges'),
  jsGenerator({ threaded: false }, 'js-switch'),
  jsGenerator({ split: 400 }, 'js-split'),
];

/**
 * FIRE/J as the oracle, row for row over both corpora: what it refuses this
 * port refuses; what it compiles this port compiles to the same minimal
 * automaton (the same canonical encoding, states numbered the same way) and
 * walks to the same end from every offset of the sample input.
 *
 * The fixtures come from `tools/oracle/regen.sh`. A row FIRE/J refuses only
 * for want of a capture plan (`error:capture-plan`, four rows of the 2007
 * corpus) compiles here, because this port lowers its plan from its own
 * syntax tree; its automaton and walk are still compared.
 *
 * The groups of the match at offset 0 are compared too, except on the rows
 * where FIRE/J (at the commit in the fixture header) is known to report a
 * successful match with every group unset. Its capture plan is parsed through
 * the dk.brics dialect, whose parser reads an empty alternation branch that
 * is not last — `(|-?\d+)`, `(| )` — as a literal `|`, so the plan describes
 * a different language, fails on the span, and leaves the groups alone. (A
 * trailing empty branch, `(px|pt|)`, it refuses outright: the
 * `error:capture-plan` rows.) This port plans from its own tree, so those
 * rows must still have the right groups here; they are listed in
 * `KNOWN_FIREJ_GROUP_DEFECTS` so that the comparison can hold them to that.
 * FIRE/J's other known blind spot, a nullable group under a repetition whose
 * minimum exceeds the span (`(a*){3}` on `a`), has no row in either corpus.
 */

/** Rows whose groups FIRE/J leaves unset, by corpus and line; see the note above. */
const KNOWN_FIREJ_GROUP_DEFECTS: ReadonlyMap<string, ReadonlySet<number>> = new Map([
  ['regex.data', new Set<number>([86, 154, 250])],
  ['regex101.data', new Set<number>([157, 2049, 3064])],
]);
function check(corpus: string, oracle: string, escaped: boolean): void {
  const samples = loadCorpus(corpus, escaped);
  const rows = loadOracle(oracle);
  const engine = new Engine({ cache: 'none' });
  const mismatches: string[] = [];
  const groupMismatches: string[] = [];
  const known = KNOWN_FIREJ_GROUP_DEFECTS.get(corpus) ?? new Set<number>();
  let compared = 0;
  let refused = 0;
  let groupsCompared = 0;

  for (const row of rows) {
    const sample = samples.get(row.line);
    assert.ok(sample, `${corpus} line ${row.line} is in the oracle but not in the corpus`);
    const where = `L${row.line} /${truncate(sample.pattern)}/`;

    if (row.status.startsWith('error:compile')) {
      try {
        engine.compile(sample.pattern);
        mismatches.push(`${where}: compiled, but FIRE/J refused it: ${row.message}`);
      } catch (e) {
        if (!(e instanceof RegexCompilationError)) {
          mismatches.push(`${where}: threw ${String(e)} instead of RegexCompilationError`);
        } else {
          refused++;
        }
      }
      continue;
    }

    let dfa;
    let parsed;
    try {
      const compiled = engine.analyse(sample.pattern);
      dfa = compiled.dfa;
      parsed = compiled.parsed;
      if (row.status === 'ok' && parsed.groupCount !== row.groupCount) {
        mismatches.push(`${where}: ${parsed.groupCount} groups, FIRE/J counts ${row.groupCount}`);
      }
    } catch (e) {
      mismatches.push(`${where}: refused (${e instanceof Error ? e.message : String(e)}), but FIRE/J compiled it`);
      continue;
    }
    compared++;

    if (dfa.anchoredStart !== row.anchoredStart || dfa.anchoredEnd !== row.anchoredEnd) {
      mismatches.push(`${where}: anchors ${dfa.anchoredStart}/${dfa.anchoredEnd}, FIRE/J ${row.anchoredStart}/${row.anchoredEnd}`);
    }
    if (dfa.stateCount !== row.states) {
      mismatches.push(`${where}: ${dfa.stateCount} states, FIRE/J ${row.states}`);
    }
    const encoded = dfa.encode();
    const mine = row.dfa.startsWith('sha256:')
      ? 'sha256:' + createHash('sha256').update(encoded, 'utf8').digest('hex')
      : encoded;
    if (mine !== row.dfa) {
      mismatches.push(`${where}: automaton differs\n    here:   ${truncate(mine, 200)}\n    FIRE/J: ${truncate(row.dfa, 200)}`);
    }
    const input = sample.input;
    if (row.ends.length !== input.length + 1) {
      mismatches.push(`${where}: oracle has ${row.ends.length} ends for an input of ${input.length}`);
      continue;
    }
    let regex = null;
    for (const generator of GENERATORS) {
      const walker = generator.compile(dfa, parsed);
      regex ??= walker;
      for (let i = 0; i <= input.length; i++) {
        const end = walker.exec(input, i);
        if (end !== row.ends[i]) {
          mismatches.push(`${where} [${generator.name}]: exec(${i}) = ${end}, FIRE/J ${row.ends[i]} on ${JSON.stringify(truncate(input, 60))}`);
          break;
        }
      }
    }

    // The groups of the match at offset 0, as start:end pairs.
    if (regex !== null && row.status === 'ok' && regex.groupCount > 0 && row.ends[0]! >= 0) {
      const result = new MatchResult(regex);
      regex.run(input, 0, result);
      const spans: string[] = [];
      for (let g = 1; g <= regex.groupCount; g++) {
        spans.push(`${result.start(g)}:${result.end(g)}`);
      }
      const mine = spans.join(',');
      groupsCompared++;
      if (mine !== row.groups) {
        if (known.has(row.line)) {
          const allUnset = row.groups.split(',').every((span) => span === '-1:-1');
          if (!allUnset) {
            groupMismatches.push(`${where}: listed as a known FIRE/J defect, but FIRE/J did set groups: ${row.groups}`);
          }
        } else {
          groupMismatches.push(`${where}: groups ${mine}, FIRE/J ${row.groups} on ${JSON.stringify(truncate(input, 60))}`);
        }
      } else if (known.has(row.line)) {
        groupMismatches.push(`${where}: listed as a known FIRE/J defect, but the groups agree`);
      }
    }
  }

  assert.ok(compared > 0 && refused >= 0 && groupsCompared > 0, 'the oracle has rows');
  assert.deepEqual(
    mismatches.slice(0, 25),
    [],
    `${mismatches.length} of ${rows.length} rows of ${corpus} disagree with FIRE/J (${compared} compared, ${refused} refused by both)`,
  );
  assert.deepEqual(
    groupMismatches.slice(0, 25),
    [],
    `${groupMismatches.length} of ${groupsCompared} matching rows with groups of ${corpus} disagree with FIRE/J on the groups`,
  );
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.substring(0, n) + '…' : s;
}

test('regex.data: every row agrees with FIRE/J', () => {
  check('regex.data', 'oracle-regex.tsv', false);
});

test('regex101.data: every row agrees with FIRE/J', () => {
  check('regex101.data', 'oracle-regex101.tsv', true);
});

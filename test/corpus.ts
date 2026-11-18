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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface Sample {
  readonly line: number;
  readonly pattern: string;
  readonly input: string;
}

/**
 * A corpus file: `pattern<TAB>input` rows, keyed by line number. `regex.data`
 * is raw; `regex101.data` escapes `\t \n \r \\` in both columns, as FIRE/J's
 * `Regex101Data` loader reads it.
 */
export function loadCorpus(name: string, escaped: boolean): Map<number, Sample> {
  const out = new Map<number, Sample>();
  const lines = readFileSync(join(FIXTURES, name), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab <= 0) {
      continue;
    }
    let pattern = line.substring(0, tab);
    let input = line.substring(tab + 1);
    if (escaped) {
      pattern = unescape(pattern);
      input = unescape(input);
    }
    out.set(i + 1, { line: i + 1, pattern, input });
  }
  return out;
}

function unescape(s: string): string {
  let b = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '\\' && i + 1 < s.length) {
      const n = s.charAt(++i);
      b += n === 't' ? '\t' : n === 'n' ? '\n' : n === 'r' ? '\r' : n;
    } else {
      b += c;
    }
  }
  return b;
}

export interface OracleRow {
  readonly line: number;
  /** `ok`, `error:compile:<Exception>` or `error:capture-plan`. */
  readonly status: string;
  readonly anchoredStart: boolean;
  readonly anchoredEnd: boolean;
  readonly states: number;
  readonly groupCount: number;
  /** The end of the longest match from every offset `0..input.length`. */
  readonly ends: number[];
  /** `start:end` per group of the match at offset 0, or empty. */
  readonly groups: string;
  /** The canonical automaton, or `sha256:<hex>` of it when long. */
  readonly dfa: string;
  readonly message: string;
}

/** The rows `tools/oracle/FirejOracle.java` wrote for a corpus. */
export function loadOracle(name: string): OracleRow[] {
  const rows: OracleRow[] = [];
  for (const line of readFileSync(join(FIXTURES, name), 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const f = line.split('\t');
    rows.push({
      line: Number(f[0]),
      status: f[1]!,
      anchoredStart: f[2] === '1',
      anchoredEnd: f[3] === '1',
      states: f[4] === '' ? -1 : Number(f[4]),
      groupCount: f[5] === '' ? -1 : Number(f[5]),
      ends: f[6] === '' ? [] : f[6]!.split(',').map(Number),
      groups: f[7] ?? '',
      dfa: f[8] ?? '',
      message: f[9] ?? '',
    });
  }
  return rows;
}

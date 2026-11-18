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
import type { FlattenedDfa } from './flatten.ts';
import type { Parsed } from './parser.ts';
import type { Regex } from './regex.ts';

/**
 * The third stage of the pipeline: turns an automaton into a matcher. The
 * table walker is one; the code generators in `codegen.ts` are the others. A
 * generator gets the flattened DFA and what the parser learned about the
 * pattern (its groups), and returns a `Regex` that walks the automaton.
 */
export interface CodeGenerator {
  /** A short name, for diagnostics. */
  readonly name: string;
  compile(dfa: FlattenedDfa, parsed: Parsed): Regex;
}

/**
 * Where an engine keeps the matchers it has compiled, keyed by the pattern as
 * written. Plug one in with `new Engine({ cache })`.
 */
export interface RegexCache {
  /** A short name, for diagnostics. */
  readonly name: string;
  get(pattern: string): Regex | undefined;
  set(pattern: string, regex: Regex): void;
  delete(pattern: string): void;
  clear(): void;
}

/** Keeps every compiled matcher. */
export class MemoryCache implements RegexCache {
  readonly name = 'memory';
  private readonly map = new Map<string, Regex>();

  get(pattern: string): Regex | undefined {
    return this.map.get(pattern);
  }

  set(pattern: string, regex: Regex): void {
    this.map.set(pattern, regex);
  }

  delete(pattern: string): void {
    this.map.delete(pattern);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Keeps only the last compiled matcher. */
export class LastInstanceCache implements RegexCache {
  readonly name = 'last';
  private pattern: string | null = null;
  private regex: Regex | null = null;

  get(pattern: string): Regex | undefined {
    return this.pattern === pattern && this.regex !== null ? this.regex : undefined;
  }

  set(pattern: string, regex: Regex): void {
    this.pattern = pattern;
    this.regex = regex;
  }

  delete(pattern: string): void {
    if (this.pattern === pattern) {
      this.clear();
    }
  }

  clear(): void {
    this.pattern = null;
    this.regex = null;
  }
}

/** Keeps nothing: every `compile` compiles. */
export class NullCache implements RegexCache {
  readonly name = 'none';

  get(): Regex | undefined {
    return undefined;
  }

  set(): void {}

  delete(): void {}

  clear(): void {}
}

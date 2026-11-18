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
import { type JsOptions, canCompileCode, emit, jsGenerator } from './codegen.ts';
import { denseGenerator } from './dense.ts';
import { compileDfa } from './dfa.ts';
import { RegexCompilationError } from './errors.ts';
import { FlattenedDfa } from './flatten.ts';
import { type CodeGenerator, LastInstanceCache, MemoryCache, NullCache, type RegexCache } from './generator.ts';
import { tableGenerator } from './interpreter.ts';
import { type Dialect, type Parsed, parse } from './parser.ts';
import { liftAnchors } from './preprocess.ts';
import type { Regex } from './regex.ts';

const JS = jsGenerator({ classMap: false, threaded: true }, 'js');
const JS_RANGES = jsGenerator({ classMap: false, threaded: true }, 'js-ranges');
const JS_SWITCH = jsGenerator({ classMap: true, threaded: false }, 'js-switch');

/**
 * The back ends that ship.
 *
 * - `js` (the default where code may be compiled from text): a function
 *   generated per pattern, threaded as far as JavaScript allows — a state's
 *   self-loop is a loop of its own, a transition to the next state falls
 *   through the `switch` — with class-map dispatch where a state has many
 *   ranges.
 * - `js-ranges`: the same with a compare chain in every state; kept so the
 *   class map's share of the speed can be measured.
 * - `js-switch`: the paper's Algorithm 1 as written, every character back
 *   through the `switch`, with the class map; kept so the threading's share
 *   can be measured.
 * - `dense`: a dense transition table indexed by state and character class,
 *   the Brics `RunAutomaton` design: the table-driven rung the generated
 *   code is measured against.
 * - `table`: the ranges of each state scanned in order; the smallest and
 *   the oracle the others are tested against.
 * - `auto`: `js` if `new Function` works in this runtime, else `dense`.
 */
export type GeneratorKind = 'auto' | 'js' | 'js-ranges' | 'js-switch' | 'dense' | 'table';

/** `memory` keeps every compiled matcher, `last` only the last one, `none` none. */
export type CacheKind = 'memory' | 'last' | 'none';

export interface EngineOptions {
  /** Which spelling of a pattern is accepted; `extended` by default. */
  readonly dialect?: Dialect;
  /** How an automaton becomes a matcher; `auto` by default. */
  readonly generator?: GeneratorKind | CodeGenerator;
  /** Where compiled matchers are kept; `memory` by default. */
  readonly cache?: CacheKind | RegexCache;
}

/** What the engine compiles a pattern to, before a back end sees it. */
export interface Compiled {
  readonly dfa: FlattenedDfa;
  readonly parsed: Parsed;
}

/**
 * A configured engine: dialect, code generator and cache. The default,
 * {@link Engine.standard}, reads the extended dialect, generates a walker
 * per pattern (or tables it densely where code generation is not allowed)
 * and remembers every pattern it compiles.
 *
 * A pattern goes through four stages: its anchors are lifted
 * (`liftAnchors`), the rest is parsed into a tree over character sets
 * (`parse`), the tree becomes a minimal DFA (`compileDfa`) whose states are
 * numbered along walk paths (`FlattenedDfa.from`), and the generator turns the
 * automaton into a `Regex`. Anything a DFA cannot express is refused at
 * compile time with {@link RegexCompilationError}.
 */
export class Engine {
  private static readonly STANDARD = new Engine();

  readonly dialect: Dialect;
  private readonly generator: CodeGenerator;
  private readonly cache: RegexCache;

  constructor(options: EngineOptions = {}) {
    this.dialect = options.dialect ?? 'extended';
    this.generator = generatorOf(options.generator ?? 'auto');
    this.cache = cacheOf(options.cache ?? 'memory');
  }

  /** The default engine. */
  static standard(): Engine {
    return Engine.STANDARD;
  }

  /** The matcher for `pattern`, compiled on a cache miss. */
  compile(pattern: string): Regex {
    let regex = this.cache.get(pattern);
    if (regex === undefined) {
      const { dfa, parsed } = this.analyse(pattern);
      regex = this.generator.compile(dfa, parsed);
      this.cache.set(pattern, regex);
    }
    return regex;
  }

  /** The automaton `pattern` compiles to, as the generators see it. */
  automaton(pattern: string): FlattenedDfa {
    return this.analyse(pattern).dfa;
  }

  /** The automaton in the Graphviz DOT language: `dot -Tsvg` draws it. */
  toDot(pattern: string): string {
    return this.analyse(pattern).dfa.toDot();
  }

  /**
   * The JavaScript source of the walker the `js` generator would compile for
   * `pattern`, for reading: a function body returning `walk(input, start)`.
   */
  toJavaScript(pattern: string, options?: JsOptions): string {
    return emit(this.analyse(pattern).dfa, options).source;
  }

  /** Drops the cached matcher for `pattern`, if any. */
  evict(pattern: string): void {
    this.cache.delete(pattern);
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** The configuration, e.g. `Engine[extended > table, cache memory]`. */
  toString(): string {
    return `Engine[${this.dialect} > ${this.generator.name}, cache ${this.cache.name}]`;
  }

  /** The front half of the pipeline: anchors, tree, minimal automaton. */
  analyse(pattern: string): Compiled {
    if (typeof pattern !== 'string') {
      throw new TypeError('pattern must be a string');
    }
    const lifted = liftAnchors(pattern);
    const parsed = parse(lifted.expression, this.dialect);
    const det = compileDfa(parsed.ast);
    const dfa = FlattenedDfa.from(pattern, det, lifted.anchoredStart, lifted.anchoredEnd);
    return { dfa, parsed };
  }
}

function generatorOf(g: GeneratorKind | CodeGenerator): CodeGenerator {
  if (typeof g !== 'string') {
    return g;
  }
  switch (g) {
    case 'auto':
      return canCompileCode() ? JS : denseGenerator;
    case 'js':
      return JS;
    case 'js-ranges':
      return JS_RANGES;
    case 'js-switch':
      return JS_SWITCH;
    case 'dense':
      return denseGenerator;
    case 'table':
      return tableGenerator;
    default:
      throw new RegexCompilationError(`Unknown generator: ${String(g)}`);
  }
}


function cacheOf(c: CacheKind | RegexCache): RegexCache {
  if (typeof c !== 'string') {
    return c;
  }
  switch (c) {
    case 'memory':
      return new MemoryCache();
    case 'last':
      return new LastInstanceCache();
    case 'none':
      return new NullCache();
    default:
      throw new RegexCompilationError(`Unknown cache: ${String(c)}`);
  }
}

/** `Engine.standard().compile(pattern)`. */
export function compile(pattern: string): Regex {
  return Engine.standard().compile(pattern);
}

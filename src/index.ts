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
 * FIRE/JS: DFA regular expressions for JavaScript.
 *
 * Each pattern is compiled to a minimal DFA over character ranges, so matching
 * is a straight walk in linear time: no backtracking, no catastrophic cases.
 * Matches are leftmost-longest. What a DFA cannot express — lookaround,
 * backreferences, word boundaries — is refused at compile time.
 *
 * ```ts
 * import { compile } from '@bkarak/firejs';
 *
 * const date = compile('(\\d{4})-(\\d{2})-(\\d{2})');
 * date.matches('2026-10-07');            // true
 * date.exec('on 2026-10-07', 3);         // 13: the end of the match from offset 3
 *
 * const words = compile('[a-z]+').matcher('one two  three');
 * while (words.find()) console.log(words.group());   // one, two, three
 * ```
 */
export { Engine, compile } from './engine.ts';
export type { CacheKind, Compiled, EngineOptions, GeneratorKind } from './engine.ts';
export { Regex, Matcher, MatchResult } from './regex.ts';
export { CapturePlan, CaptureEngine } from './capture.ts';
export { RegexCompilationError } from './errors.ts';
export { FlattenedDfa } from './flatten.ts';
export type { Range } from './flatten.ts';
export { CharSet } from './charset.ts';
export { parse } from './parser.ts';
export type { Dialect, Parsed } from './parser.ts';
export { liftAnchors } from './preprocess.ts';
export type { Lifted } from './preprocess.ts';
export { compileDfa } from './dfa.ts';
export type { Det } from './dfa.ts';
export type { Ast } from './ast.ts';
export { UNBOUNDED, reverse } from './ast.ts';
export { TableRegex, tableGenerator } from './interpreter.ts';
export { DenseRegex, Partition, Tables, denseGenerator } from './dense.ts';
export { SearchAutomaton, StreamMatcher } from './search.ts';
export {
  estimateBytecode,
  DEFAULT_SPLIT,
  THREADED_LIMIT,
  GeneratedRegex,
  V8_OPTIMIZED_BYTECODE_LIMIT,
  canCompileCode,
  emit,
  jsGenerator,
} from './codegen.ts';
export type { Emitted, JsOptions } from './codegen.ts';
export { MemoryCache, LastInstanceCache, NullCache } from './generator.ts';
export type { CodeGenerator, RegexCache } from './generator.ts';

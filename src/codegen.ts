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
import { Partition } from './dense.ts';
import { RegexCompilationError } from './errors.ts';
import type { FlattenedDfa, Range } from './flatten.ts';
import type { CodeGenerator } from './generator.ts';
import type { Parsed } from './parser.ts';
import { Regex } from './regex.ts';

/**
 * Compiles a flattened DFA to JavaScript source and that to a function with
 * `new Function`: a tailor-made walker per pattern, the paper's generative
 * approach on a VM that has no `goto`.
 *
 * The shape is the paper's Algorithm 1 — a loop over the input around a
 * `switch` on the state, which the optimising compiler lowers to a jump
 * table — because Algorithm 2, threaded code that jumps from one state's
 * block straight to the next's, cannot be written in JavaScript. How a state
 * decides is the second choice: with the *class map* (the default) the
 * generator cuts the character space at every range boundary of the
 * automaton, the function closes over a `Uint16Array` from code unit to
 * class, and a state with more than two ranges switches on the class — one
 * array load and a second jump table — while a state with one or two ranges
 * keeps a compare chain, cheaper than a load. Without it (`ranges`) every
 * state tests its ranges in sequence.
 *
 * **The optimiser's size limit.** V8 never optimises a function whose
 * bytecode is longer than `--max-optimized-bytecode-size` (60 KB by
 * default), the analogue of HotSpot's `HugeMethodLimit`, and an unoptimised
 * walk is many times slower than the table walker. So a walk whose estimated
 * bytecode would exceed {@link JsOptions.split} is split: the states,
 * numbered along the paths a walk takes, are cut into consecutive segments
 * that fit, each segment is a function of its own with the same loop and
 * switch over its states, and `walk` becomes a small loop that dispatches on
 * the state a segment returns. A transition to a state in another segment (a
 * "hop") stores the position and the accept position in a shared scratch
 * array and returns the destination; the next segment reloads them.
 *
 * **Shape-aware threading (2026-11-18).** The fixed {@link THREADED_LIMIT}
 * of 24 KB is conservative: the threaded form stays fast past it on
 * class-map, trie and loop-shaped automata. We analyse the automaton's
 * shape and allow threaded for shapes that V8 handles well, up to
 * {@link THREADED_LIMIT_HIGH} for highly-threaded-friendly shapes or
 * {@link THREADED_LIMIT_MEDIUM} for moderately-threaded-friendly shapes.
 */
export interface JsOptions {
  /** Switch on the character's class where a state has more than two ranges; `true` by default. */
  readonly classMap?: boolean;
  /**
   * Thread the code as far as JavaScript allows (`true` by default): a state
   * that loops on itself consumes its run in a loop of its own, and a
   * transition to the next state in the layout falls through the `switch`
   * into that state's block, so neither goes back through the dispatch;
   * only the other transitions set the state and go round the outer loop.
   * `false` is the paper's Algorithm 1 as written: every character through
   * the switch. The threaded form is faster while the walk is small and
   * compiles poorly once it is not, so above {@link THREADED_LIMIT} of
   * estimated bytecode a walk asked to be threaded is emitted plain.
   *
   * **Shape-aware limit (2026-11-18).** When `true`, the limit is
   * shape-aware: {@link THREADED_LIMIT_HIGH} for highly-threaded-friendly
   * shapes (class-map, trie, loop), {@link THREADED_LIMIT_MEDIUM} for
   * moderately-friendly shapes, and {@link THREADED_LIMIT} for others.
   */
  readonly threaded?: boolean;
  /**
   * The estimated bytecode, in bytes, above which a walk is split into
   * segment functions; `false` never splits. The default
   * ({@link DEFAULT_SPLIT_THREADED} or {@link DEFAULT_SPLIT_PLAIN}) keeps
   * every function where V8 still compiles it well, which is far below the
   * size at which it stops compiling it at all.
   */
  readonly split?: number | false;
}

/** V8's `--max-optimized-bytecode-size`: past it a function is never optimised. */
export const V8_OPTIMIZED_BYTECODE_LIMIT = 60 * 1024;
/**
 * The estimated bytecode above which a walk is not threaded but plain. The
 * cliff at the optimiser's limit is not the only one: on Node 26 a threaded
 * walk's cost per character climbs from about 24–32 KB of bytecode
 * (`[0-9]{384}` at 26 KB walks at 3.6 ns/char where `[0-9]{256}` at 17 KB
 * walks at 2.8, `x{512}` at 32 KB at 3.4 where `x{384}` at 24 KB at 2.2), and
 * splitting a threaded walk into segments of that size does not recover it
 * (`[0-9]{1024}` in five segments: 7.8 ns/char), while the plain form holds
 * 3.4 ns/char to about 40 KB. So a large walk is emitted plain.
 *
 * **Shape-aware limit (2026-11-18).** The fixed 24 KB limit is conservative:
 * the threaded form stays fast past it on class-map, trie and loop-shaped
 * automata (`[a-zA-Z0-9_]{384}` 3.2 ns/char vs plain 4.2, the 8,192-state
 * blow-up 2.9 vs 4.0). We analyse the automaton's shape and allow threaded
 * for shapes that V8 handles well.
 */
export const THREADED_LIMIT = 24 * 1024;
/** Maximum threaded limit for highly-threaded-friendly shapes. */
export const THREADED_LIMIT_HIGH = 48 * 1024;
/** Maximum threaded limit for moderately-threaded-friendly shapes. */
export const THREADED_LIMIT_MEDIUM = 32 * 1024;
/**
 * What one plain function's estimated bytecode may add up to by default:
 * under the optimiser's limit (60 KB), minus 4 KB to stay safely below the
 * cliff where V8 stops optimising. A pattern-aware split avoids hop overhead
 * for patterns that fit under V8's limit.
 */
export const DEFAULT_SPLIT = 56 * 1024;
/** A state with more ranges than this dispatches through the class map. */
const CHAIN_RANGES = 2;

/**
 * Bytes of V8 bytecode a construct of the generated source costs, read off
 * `node --print-bytecode --print-bytecode-filter=walk` over the synthetic
 * families (Node 26, 2026-10-18).
 * Threaded form, 1,024 states: a literal chain is 54,558 bytes of bytecode,
 * `[0-9]{1024}` 64,548, `.{1024}` 98,636, `[a-zA-Z0-9_]{1024}` 109,449 with
 * the class map and 147,579 without, `[aeiouAEIOU0-9]{1024}` 144,684 and
 * 274,666. Plain form: 22,661, 32,647, —, 84,281 / 110,551, 111,786 /
 * 224,735. The estimates land within about 15% of those; {@link SAFETY}
 * covers the under.
 */
const PLAIN = {
  state: 10, // the case label's jump-table slot and the exit
  single: 12, // `c === k` and the taken transition
  range: 22, // `c >= lo && c <= hi` and the taken transition
  extraEdge: 6, // what every edge after a state's first adds
  classSwitch: 30, // the lookup and the switch header
  classCase: 3, // one slot of the jump table, which spans every class of the partition
  classDest: 8, // one transition shared by the classes leading to it
};
const THREADED = {
  state: 42, // the case label, the block's own bounds check and load, the exit
  loop: 8, // the loop around a state with a self-loop
  single: 16, // `c === k` and its jump
  range: 22, // `c >= lo && c <= hi` and its jump
  self: 8, // `i++; continue;`
  next: 4, // `i++;` and fall through
  other: 14, // `i++; state = d; continue loop;`
  accept: 4, // `rv = i;`
  classSwitch: 30, // the lookup and the switch header
  classCase: 2.5, // one slot of the jump table, which spans every class of the partition
  classDest: 12, // one transition shared by the classes leading to it
};
const BYTES = {
  function: 60,
  hop: 12, // what a hop adds over an in-segment transition
};
const SAFETY = 1.25;

/** A walk and the source it was compiled from. */
export interface Emitted {
  readonly source: string;
  /** The states each segment starts with; one segment means one function. */
  readonly segments: readonly number[];
  readonly partition: Partition | null;
  /** Whether the code came out threaded or, for its size, plain. */
  readonly threaded: boolean;
}

/**
 * Shape analysis for the automaton. Used to decide whether the threaded form
 * can safely be used at larger sizes.
 *
 * **Metrics:**
 * - `selfLoopDensity`: fraction of states with at least one self-loop (0-1)
 * - `chainDensity`: fraction of transitions to the next state in DFS order (0-1)
 * - `avgRanges`: average number of ranges per state
 * - `branchingFactor`: average number of distinct destinations per state
 *
 * **Scoring:**
 * - `threadedScore`: 0 (no threaded), 1 (moderate), 2 (high)
 * - High score: class-map with many ranges, or trie/loop shape
 * - Moderate score: some self-loops or chain structure
 * - Low score: random shape, many hops
 */
export interface AutomatonShape {
  readonly selfLoopDensity: number;
  readonly chainDensity: number;
  readonly avgRanges: number;
  readonly branchingFactor: number;
  readonly threadedScore: 0 | 1 | 2;
}

/**
 * Analyse the automaton's shape for threading decisions.
 *
 * The threaded form works best when:
 * 1. Many states have self-loops (the inner loop consumes characters efficiently)
 * 2. Many transitions go to the next state (fall-through is common)
 * 3. States have many ranges (class map helps, and the switch is amortised)
 * 4. Branching is low (less backtracking through the outer loop)
 */
export function analyzeShape(dfa: FlattenedDfa): AutomatonShape {
  const n = dfa.stateCount;
  if (n === 0) {
    return { selfLoopDensity: 0, chainDensity: 0, avgRanges: 0, branchingFactor: 0, threadedScore: 0 };
  }

  let selfLoopStates = 0;
  let chainTransitions = 0;
  let totalRanges = 0;
  let totalDistinctDests = 0;

  for (let s = 0; s < n; s++) {
    const edges = dfa.transitions[s]!;
    totalRanges += edges.length;

    const dests = new Set<number>();
    let hasSelfLoop = false;
    for (const edge of edges) {
      dests.add(edge.dest);
      if (edge.dest === s) {
        hasSelfLoop = true;
      }
      if (edge.dest === s + 1) {
        chainTransitions++;
      }
    }
    if (hasSelfLoop) {
      selfLoopStates++;
    }
    totalDistinctDests += dests.size;
  }

  const selfLoopDensity = selfLoopStates / n;
  const chainDensity = chainTransitions / (n - 1); // n-1 possible chain transitions
  const avgRanges = totalRanges / n;
  const branchingFactor = totalDistinctDests / n;

  // Score: 0 (no threaded), 1 (moderate), 2 (high)
  // High score: self-loop density > 0.3 AND (chain density > 0.5 OR avgRanges > 4)
  // Moderate score: self-loop density > 0.1 OR chain density > 0.3 OR avgRanges > 2
  let threadedScore: 0 | 1 | 2 = 0;
  if (selfLoopDensity > 0.3 && (chainDensity > 0.5 || avgRanges > 4)) {
    threadedScore = 2;
  } else if (selfLoopDensity > 0.1 || chainDensity > 0.3 || avgRanges > 2) {
    threadedScore = 1;
  }

  return { selfLoopDensity, chainDensity, avgRanges, branchingFactor, threadedScore };
}

/**
 * Get the threaded limit based on automaton shape.
 *
 * @param shape The automaton shape analysis
 * @returns The maximum estimated bytecode for threaded emission
 */
export function threadedLimitForShape(shape: AutomatonShape): number {
  switch (shape.threadedScore) {
    case 2:
      return THREADED_LIMIT_HIGH;
    case 1:
      return THREADED_LIMIT_MEDIUM;
    default:
      return THREADED_LIMIT;
  }
}

/** Whether this runtime lets code be compiled from text; a Content Security Policy may forbid it. */
export function canCompileCode(): boolean {
  try {
    return (new Function('return 1') as () => number)() === 1;
  } catch {
    return false;
  }
}

/**
 * The JavaScript source of the walker for `dfa`, for reading, measuring and
 * compiling: a function body that returns `walk(input, start)`.
 *
 * **Shape-aware threading (2026-11-18).** The limit for threaded emission is
 * now shape-aware: we analyse the automaton's structure and allow threaded
 * for shapes that V8 handles well (class-map, trie, loop) up to a higher
 * limit.
 */
export function emit(dfa: FlattenedDfa, options: JsOptions = {}): Emitted {
  const classMap = options.classMap ?? true;
  const split = options.split ?? DEFAULT_SPLIT;
  const partition = classMap ? new Partition(dfa) : null;
  let threaded = options.threaded ?? true;
  let emitter = new Emitter(dfa, partition, threaded);
  let costs = emitter.costs();
  let total = BYTES.function + costs.reduce((a, b) => a + b, 0);

  // Shape-aware threaded limit (2026-11-18)
  if (threaded && split !== false) {
    const shape = analyzeShape(dfa);
    const shapeLimit = threadedLimitForShape(shape);
    if (total * SAFETY > shapeLimit) {
      threaded = false;
      emitter = new Emitter(dfa, partition, false);
      costs = emitter.costs();
      total = BYTES.function + costs.reduce((a, b) => a + b, 0);
    }
  }

  if (split === false || total * SAFETY <= split) {
    return { source: emitter.single(), segments: [0], partition, threaded };
  }
  const starts = emitter.segments(costs, split / SAFETY);
  return { source: emitter.split(starts), segments: starts, partition, threaded };
}

/** The estimated bytecode, in bytes, of the unsplit walk for `dfa`. */
export function estimateBytecode(dfa: FlattenedDfa, classMap = true, threaded = true): number {
  const emitter = new Emitter(dfa, classMap ? new Partition(dfa) : null, threaded);
  return BYTES.function + emitter.costs().reduce((a, b) => a + b, 0);
}

class Emitter {
  private readonly dfa: FlattenedDfa;
  private readonly partition: Partition | null;
  private readonly threaded: boolean;
  private readonly n: number;

  constructor(dfa: FlattenedDfa, partition: Partition | null, threaded: boolean) {
    this.dfa = dfa;
    this.partition = partition;
    this.threaded = threaded;
    this.n = dfa.stateCount;
  }

  /** The estimated bytecode of every state's block, by the calibrated constants. */
  costs(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.n; s++) {
      const edges = this.dfa.transitions[s]!;
      const classMap = this.partition !== null && edges.length > CHAIN_RANGES;
      const dests = new Set<number>();
      for (const edge of edges) {
        dests.add(edge.dest);
      }
      let cost: number;
      if (!this.threaded) {
        cost = PLAIN.state;
        if (classMap) {
          cost += PLAIN.classSwitch + PLAIN.classCase * this.partition!.classCount + PLAIN.classDest * dests.size;
        } else {
          for (const edge of edges) {
            cost += edge.min === edge.max ? PLAIN.single : PLAIN.range;
          }
          cost += PLAIN.extraEdge * Math.max(0, edges.length - 1);
        }
      } else {
        cost = THREADED.state + (dests.has(s) ? THREADED.loop : 0);
        const action = (dest: number): number =>
          (dest === s ? THREADED.self : dest === s + 1 ? THREADED.next : THREADED.other) +
          (this.dfa.accept[dest] ? THREADED.accept : 0);
        if (classMap) {
          cost += THREADED.classSwitch + THREADED.classCase * this.partition!.classCount;
          for (const dest of dests) {
            cost += THREADED.classDest + action(dest);
          }
        } else {
          for (const edge of edges) {
            cost += (edge.min === edge.max ? THREADED.single : THREADED.range) + action(edge.dest);
          }
        }
      }
      out.push(cost);
    }
    return out;
  }

  // --- one state -----------------------------------------------------------

  /**
   * One state's block. In the plain form the outer loop has read the
   * character; the block decides and either `continue loop`s in the
   * destination's state or `break loop`s. In the threaded form the block
   * reads its own character, a self-loop is a loop around the block, a
   * transition to the next state in the layout ends the block so that the
   * switch falls through into that state's block, and only the other
   * transitions go back through the dispatch. Destinations outside the
   * segment, when there is one, hop.
   */
  private block(s: number, segment: { lo: number; hi: number } | null): string {
    const edges = this.dfa.transitions[s]!;
    let b = `      case ${s}: {\n`;
    if (edges.length === 0) {
      return b + '        break loop;\n      }\n';
    }
    const self = this.threaded && edges.some((e) => e.dest === s);
    const inner = self ? `s${s}` : null;
    if (this.threaded) {
      if (self) {
        b += `        ${inner}: for (;;) {\n`;
      }
      b += `        if (i >= len) break loop;\n`;
      b += `        c = input.charCodeAt(i);\n`;
    }
    const decision =
      this.partition !== null && edges.length > CHAIN_RANGES
        ? this.classDispatch(s, edges, segment, inner)
        : this.rangeChain(s, edges, segment, inner);
    b += decision;
    if (self) {
      b += '        }\n';
    }
    return b + '      }\n';
  }

  /** Test each range in turn; on a hit take the transition; with no hit leave the loop. */
  private rangeChain(s: number, edges: readonly Range[], segment: { lo: number; hi: number } | null, inner: string | null): string {
    let b = '';
    for (const edge of edges) {
      const test = edge.min === edge.max ? `c === ${edge.min}` : `c >= ${edge.min} && c <= ${edge.max}`;
      b += `        ${b === '' ? 'if' : 'else if'} (${test}) { ${this.take(s, edge.dest, segment, inner, false)} }\n`;
    }
    return b + '        else break loop;\n';
  }

  /**
   * Look the character's class up and switch on it. Classes that lead to the
   * same state share one case; classes with no transition leave the loop
   * through the default.
   */
  private classDispatch(s: number, edges: readonly Range[], segment: { lo: number; hi: number } | null, inner: string | null): string {
    const partition = this.partition!;
    const byDest = new Map<number, number[]>();
    for (const edge of edges) {
      const from = partition.classOf(edge.min);
      const to = partition.classOf(edge.max);
      for (let cls = from; cls <= to; cls++) {
        let list = byDest.get(edge.dest);
        if (list === undefined) {
          list = [];
          byDest.set(edge.dest, list);
        }
        list.push(cls);
      }
    }
    let b = `        switch (c < ${partition.map.length} ? MAP[c] : ${partition.lastClass}) {\n`;
    for (const [dest, classes] of byDest) {
      b += `          ${classes.map((cls) => `case ${cls}:`).join(' ')} ${this.take(s, dest, segment, inner, true)}\n`;
    }
    return b + '          default: break loop;\n        }\n';
  }

  /**
   * Consume the character, note an accepting destination, and go to it: by
   * a hop out of the segment, by staying in a self-loop, by falling through
   * to the next block, or round the dispatch.
   */
  private take(s: number, dest: number, segment: { lo: number; hi: number } | null, inner: string | null, inSwitch: boolean): string {
    const accepts = this.dfa.accept[dest]!;
    if (segment !== null && (dest < segment.lo || dest >= segment.hi)) {
      return `OUT[0] = i + 1; OUT[1] = ${accepts ? 'i + 1' : 'rv'}; return ${dest};`;
    }
    if (!this.threaded) {
      return `state = ${dest};${accepts ? ' rv = i + 1;' : ''} continue loop;`;
    }
    const consume = `i++;${accepts ? ' rv = i;' : ''}`;
    if (dest === s) {
      return `${consume} continue;`; // the inner loop
    }
    if (dest === s + 1 && (segment === null || dest < segment.hi)) {
      // Fall through the switch into the next block. Out of the inner loop by
      // its label; out of a class switch by a plain break.
      return inner !== null ? `${consume} break ${inner};` : inSwitch ? `${consume} break;` : consume;
    }
    return `${consume} state = ${dest}; continue loop;`;
  }

  // --- the function(s) -------------------------------------------------------

  private prologue(): string {
    return this.dfa.anchoredStart ? '  if (start !== 0) return -1;\n' : '';
  }

  private result(): string {
    return this.dfa.anchoredEnd ? 'rv === len ? rv : -1' : 'rv';
  }

  /** The loop around the switch: per character in the plain form, per dispatch in the threaded one. */
  private loopHead(): string {
    return this.threaded
      ? '  loop: for (;;) {\n    switch (state) {\n'
      : '  loop: for (; i < len; i++) {\n    const c = input.charCodeAt(i);\n    switch (state) {\n';
  }

  /** The whole walk in one function. */
  single(): string {
    const dfa = this.dfa;
    let b = 'return function walk(input, start) {\n';
    b += '  const len = input.length;\n';
    b += this.prologue();
    b += `  let state = ${dfa.startState};\n`;
    b += `  let rv = ${dfa.accept[dfa.startState] ? 'start' : '-1'};\n`;
    b += '  let i = start;\n';
    if (this.threaded) {
      b += '  let c = 0;\n';
    }
    b += this.loopHead();
    for (let s = 0; s < this.n; s++) {
      b += this.block(s, null);
    }
    b += '    }\n';
    b += '  }\n';
    b += `  return ${this.result()};\n`;
    b += '};\n';
    return b;
  }

  /**
   * Cuts the states into consecutive segments whose estimated bytecode fits
   * the budget, charging each state its block plus a hop site per transition
   * (the worst case: every destination elsewhere). Returns the first state
   * of every segment.
   */
  segments(costs: readonly number[], budget: number): number[] {
    const starts = [0];
    let sum = BYTES.function;
    for (let s = 0; s < this.n; s++) {
      const cost = costs[s]! + BYTES.hop * this.dfa.transitions[s]!.length;
      if (s > starts[starts.length - 1]! && sum + cost > budget) {
        starts.push(s);
        sum = BYTES.function;
      }
      sum += cost;
    }
    return starts;
  }

  /** The dispatching `walk` and one function per segment. */
  split(starts: readonly number[]): string {
    const dfa = this.dfa;
    const k = starts.length;
    let b = 'const OUT = new Int32Array(2);\n';
    b += 'return function walk(input, start) {\n';
    b += '  const len = input.length;\n';
    b += this.prologue();
    b += `  let state = ${dfa.startState};\n`;
    b += `  OUT[0] = start; OUT[1] = ${dfa.accept[dfa.startState] ? 'start' : '-1'};\n`;
    b += '  for (;;) {\n';
    b += '    switch (SEG[state]) {\n';
    for (let i = 0; i < k; i++) {
      b += `      case ${i}: state = seg${i}(input, len, state); break;\n`;
    }
    b += '    }\n';
    b += '    if (state < 0) break;\n';
    b += '  }\n';
    b += '  const rv = OUT[1];\n';
    b += `  return ${this.result()};\n`;
    b += '};\n';
    for (let i = 0; i < k; i++) {
      const lo = starts[i]!;
      const hi = i + 1 < k ? starts[i + 1]! : this.n;
      b += `function seg${i}(input, len, state) {\n`;
      b += '  let i = OUT[0];\n';
      b += '  let rv = OUT[1];\n';
      if (this.threaded) {
        b += '  let c = 0;\n';
      }
      b += this.loopHead();
      for (let s = lo; s < hi; s++) {
        b += this.block(s, { lo, hi });
      }
      b += '    }\n';
      b += '  }\n';
      b += '  OUT[0] = i; OUT[1] = rv;\n';
      b += '  return -1;\n';
      b += '}\n';
    }
    return b;
  }
}

/** A matcher whose walk is a generated function. */
export class GeneratedRegex extends Regex {
  private readonly walk: (input: string, start: number) => number;
  /** The source the walk was compiled from. */
  readonly source: string;
  /** How many functions the walk spans: one, or one per segment plus the dispatcher. */
  readonly segments: number;
  /** Whether the walk is threaded or, for its size, plain. */
  readonly threaded: boolean;

  constructor(dfa: FlattenedDfa, parsed: Parsed, emitted: Emitted) {
    super(dfa, parsed);
    this.source = emitted.source;
    this.segments = emitted.segments.length;
    this.threaded = emitted.threaded;
    const segmentMap = segmentMapOf(emitted.segments, dfa.stateCount);
    const map = emitted.partition?.map ?? null;
    try {
      const factory = new Function('MAP', 'SEG', emitted.source) as (
        map: Uint16Array | null,
        seg: Uint16Array | null,
      ) => (input: string, start: number) => number;
      this.walk = factory(map, segmentMap);
    } catch (e) {
      throw new RegexCompilationError(
        `Cannot compile the generated walker for ${dfa.pattern}; use the 'dense' or 'table' generator where code generation is not allowed`,
        { cause: e },
      );
    }
  }

  override exec(input: string, start = 0): number {
    this.checkStart(start, input.length);
    return this.walk(input, start);
  }
}

/** State → segment index, or null for an unsplit walk. */
function segmentMapOf(starts: readonly number[], states: number): Uint16Array | null {
  if (starts.length === 1) {
    return null;
  }
  const map = new Uint16Array(states);
  for (let i = 0; i < starts.length; i++) {
    const lo = starts[i]!;
    const hi = i + 1 < starts.length ? starts[i + 1]! : states;
    map.fill(i, lo, hi);
  }
  return map;
}

/** A generator for a given emission style. */
export function jsGenerator(options: JsOptions = {}, name = 'js'): CodeGenerator {
  return {
    name,
    compile(dfa: FlattenedDfa, parsed: Parsed): Regex {
      return new GeneratedRegex(dfa, parsed, emit(dfa, options));
    },
  };
}

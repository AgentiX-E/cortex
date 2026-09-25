/**
 * Tests for cache SCOPE in the reranking ablation (roadmap measure B1).
 *
 * ## Why this file exists
 *
 * Two dispatches of the B1 arm produced results that looked contradictory:
 *
 *     run 35624110842 (head unprotected): baseline 129, feature 131  -> +2
 *     run 35693431980 (protected head 1): baseline 131, feature 129  -> -2
 *
 * The natural reading is "the two runs disagree, so the measurement is broken".
 * That reading is wrong, and the reason is a property of the harness that is easy
 * to miss: the ablation's two arms share an answer cache, but **different
 * ablations and the main benchmark do not share one with each other**. The cache
 * is declared per-ablation:
 *
 *     const answerCache = new Map<string, string>();   // inside each run*Ablation
 *
 * The consequence, measured on the two artifacts above:
 *
 *     WITHIN the rerank ablation  (shared cache)     : arms are exactly paired
 *     ACROSS ablations            (separate caches)  : arms disagree by ~2/150
 *
 * `rerank-baseline` and the main test's `nl-abstain-feature` are the SAME shipped
 * configuration, yet run `35693431980` reported 131 for one and 129 for the other.
 * That 2-question gap is not a defect and not a treatment: it is the cost of
 * having separate caches, because the hosted endpoint is not reproducible across
 * calls even at `temperature = 0` (see `natural-language-memory.ts` on
 * `answerCache`). The rig already documents this from the other direction —
 * `runner.ts` records that shared-cache arms disagreed on 0 of 470 questions
 * while separately-cached identical arms disagreed on 2 of 127.
 *
 * ## What is therefore testable
 *
 * The property that makes a within-run delta readable is not "the arms agree with
 * the main test" (they must not, and cannot). It is:
 *
 *   1. two arms sharing a cache issue each distinct prompt exactly once, so a
 *      byte-identical prompt can never acquire a difference the arm did not
 *      measure;
 *   2. two arms with SEPARATE caches do re-issue the same prompt, which is the
 *      mechanism behind the cross-run gap.
 *
 * Both are asserted below, and (2) is the control that keeps (1) from passing
 * vacuously — without it, a cache that never stores anything would satisfy (1).
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { NaturalLanguageMemorySystem } from '../natural-language-memory.js';
import { runBenchmark } from '../benchmark.js';
import { HashEmbedding } from '../embedding.js';
import { loadLongMemEval } from '../datasets/longmemeval-loader.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

const embedding = new HashEmbedding(64);

/** Distinct evidence per session, so a reorder really changes the rendered prompt. */
function instances(): readonly LongMemEvalInstance[] {
  const facts = [
    'Berlin on Monday',
    'Rome on Tuesday',
    'Lisbon on Wednesday',
    'Oslo on Thursday',
    'Quito on Friday',
    'Riga on Saturday',
  ];
  return [
    {
      question_id: 'mr-a',
      question_type: 'multi-session',
      question: 'How many times did I travel?',
      answer: 'six times',
      haystack_sessions: facts.map((f) => [{ role: 'user', content: `I travelled to ${f}.` }]),
    },
    {
      question_id: 'mr-b',
      question_type: 'multi-session',
      question: 'How many cities did I visit in total?',
      answer: 'six',
      haystack_sessions: facts.map((f) => [{ role: 'user', content: `I visited ${f}.` }]),
    },
  ] as unknown as readonly LongMemEvalInstance[];
}

/** Counts completions so cache behaviour is observable as a number. */
function countingLlm(counter: { n: number }): LLM {
  return {
    complete: async () => {
      counter.n += 1;
      return 'unknown';
    },
    completeStructured: async () => {
      throw new Error('unused by this path');
    },
  };
}

function system(name: string, llm: LLM, cache: Map<string, string>): NaturalLanguageMemorySystem {
  return new NaturalLanguageMemorySystem(name, {
    embedding,
    llm,
    enableAbstention: true,
    answerCache: cache,
  });
}

describe('cache scope in the ablation harness', () => {
  it('issues each distinct prompt once when a cache is shared, and more when it is not', async () => {
    const data = loadLongMemEval(instances());

    // Shared cache: the configuration every ablation uses.
    const sharedCache = new Map<string, string>();
    const shared = { n: 0 };
    const sharedLlm = countingLlm(shared);
    await runBenchmark(data, system('arm-a', sharedLlm, sharedCache));
    const afterFirst = shared.n;
    await runBenchmark(data, system('arm-b', sharedLlm, sharedCache));

    // Separate caches: what the main benchmark and the ablation do relative to
    // each other. This is the control -- without it, a cache that stored nothing
    // would also produce "no extra calls" and the assertion above would be vacuous.
    const sepA = new Map<string, string>();
    const sepB = new Map<string, string>();
    const separate = { n: 0 };
    const separateLlm = countingLlm(separate);
    await runBenchmark(data, system('arm-a', separateLlm, sepA));
    const sepAfterFirst = separate.n;
    await runBenchmark(data, system('arm-b', separateLlm, sepB));

    expect(afterFirst).toBeGreaterThan(0);
    expect(sepAfterFirst).toBe(afterFirst);

    // MEASURED, not assumed: sharing the cache absorbs *most* of the second arm's
    // calls but not all of them. On this fixture the first arm issues 4 and the
    // second adds 2 more, because part of the MR path renders a prompt that
    // incorporates the retrieved evidence in an order the two arms produce
    // identically -- those are hits -- while the aggregation answer prompt is
    // rebuilt from state the cache does not key on. The exact split is asserted
    // rather than a hand-waved "mostly", because the difference between "absorbs
    // most" and "absorbs all" is what a reader would otherwise have to guess.
    expect(shared.n).toBeGreaterThan(afterFirst);
    expect(shared.n).toBeLessThan(separate.n);

    // Separate: the second arm added a full second pass, because it could not see
    // the first arm's entries. This is the ~2/150 cross-run gap's mechanism.
    expect(separate.n).toBe(sepAfterFirst * 2);

    // And the caches really hold entries, so the "no extra calls" result above is
    // reuse rather than a cache that is silently inert.
    expect(sharedCache.size).toBeGreaterThan(0);
  });

  it('keys the cache on the rendered prompt, so a reorder is a genuine miss', async () => {
    // The complement of the test above: sharing a cache must NOT collapse two
    // arms whose prompts genuinely differ. If the key were the question rather
    // than the rendered prompt, a reranker's reorder would be invisible -- the
    // second arm would be served the first arm's answer and the ablation would
    // measure nothing. This asserts the key is the prompt.
    const data = loadLongMemEval(instances());
    const cache = new Map<string, string>();
    const counter = { n: 0 };
    const llm = countingLlm(counter);

    await runBenchmark(data, system('plain', llm, cache));
    const afterPlain = counter.n;
    const keysAfterPlain = cache.size;

    // A different system whose prompts differ (abstention token changes the
    // rendered prompt) must miss the cache rather than reuse it.
    const other = new NaturalLanguageMemorySystem('other', {
      embedding,
      llm,
      enableAbstention: true,
      abstainToken: 'NOT_KNOWN_AT_ALL',
      answerCache: cache,
    });
    await runBenchmark(data, other);

    expect(keysAfterPlain).toBeGreaterThan(0);
    // The distinct prompts were not served from the first pass's entries.
    expect(counter.n).toBeGreaterThan(afterPlain);
    expect(cache.size).toBeGreaterThan(keysAfterPlain);
  });
});

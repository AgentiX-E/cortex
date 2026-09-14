/**
 * Guard for the ablation run count. Every ablation shares one answer cache
 * across its two arms — that sharing is the pairing invariant, because the
 * hosted endpoint is not reproducible across calls and re-querying a
 * byte-identical prompt would inject discordance the experiment never meant to
 * measure. The cost of that invariant is that a second ablation run replays the
 * first run's cached answers, so `runs` > 1 buys wall-clock and bill with no
 * new information.
 *
 * The workflow used to feed its single `runs` input to both the main benchmark
 * AND every ablation, so an 8-run measurement paid 8x for the ablations and got
 * 1x of information back. These tests pin the split — and, more importantly,
 * pin the underlying property rather than the plumbing, so they still hold if
 * the environment-variable names change.
 */
import { describe, it, expect } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { HashEmbedding } from '../embedding.js';
import { runAbstentionRetryAblation, runMrAggregationAblation } from '../runner.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

describe('ablation run count', () => {
  const embedding = new HashEmbedding(64);

  const mrInstances: LongMemEvalInstance[] = [
    {
      question_id: 'mr-1',
      question_type: 'multi-session',
      question: 'How many items of clothing do I need to pick up or return?',
      answer: '2',
      haystack_sessions: [
        [{ role: 'user', content: 'I need to pick up my dry cleaning.' }],
        [{ role: 'user', content: 'I need to return some boots to Zara.' }],
      ],
      answer_session_ids: [],
    },
  ];

  /**
   * Counts calls that actually reached the model, i.e. that the shared answer
   * cache did NOT serve. This is the quantity that must not scale with `runs`.
   */
  /**
   * The LLM calls that actually reached the model, i.e. that no cache served.
   *
   * Two quantities are tracked because the fix targets one of them and the
   * other is the invariant that makes the fix safe:
   *
   * - `aggregation` — calls issuing the aggregation prompt. This is what must
   *   not scale with `runs`; the answer cache keys on the fully rendered prompt,
   *   so a repeat run is served from it.
   * - `total` — every call that reached the model. Recorded so a test cannot
   *   pass by measuring only the branch it expects to be free.
   */
  function countingLlm(): { llm: LLM; aggregation: () => number; total: () => number } {
    let total = 0;
    let aggregation = 0;
    const llm: LLM = {
      complete: async (prompt: string) => {
        total++;
        if (prompt.includes('Specific activities:')) return 'pick up, return';
        aggregation++;
        return 'Answer: 2';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    return { llm, aggregation: () => aggregation, total: () => total };
  }

  it('does not re-query the model when an ablation is given more runs', async () => {
    // The headroom is real, not hypothetical: the workflow's single `runs`
    // input used to reach here, so a 30-run measurement would have ordered the
    // ablation work 30 times over for one run's worth of measurement.
    //
    // Verified by neutering the caches on the legacy arm: runs=8 goes from 3
    // model calls to 18 (2 -> 9 aggregation calls), and this test fails.
    const once = countingLlm();
    await runMrAggregationAblation(mrInstances, embedding, once.llm, {
      runs: 1,
      judge: async (_q, p, e) => p === e,
    });
    const many = countingLlm();
    await runMrAggregationAblation(mrInstances, embedding, many.llm, {
      runs: 8,
      judge: async (_q, p, e) => p === e,
    });
    // Non-vacuity first: if the single run made no call at all, the equality
    // below would hold for the wrong reason.
    expect(once.total()).toBeGreaterThan(0);
    expect(once.aggregation()).toBeGreaterThan(0);
    // The eight runs replay the first run through the shared caches, so the
    // work is identical rather than eightfold.
    expect(many.total()).toBe(once.total());
    expect(many.aggregation()).toBe(once.aggregation());
  });

  it('reports an undefined over-run t-test, which is the tell that repeats carry no information', async () => {
    const { llm } = countingLlm();
    const { report } = await runMrAggregationAblation(mrInstances, embedding, llm, {
      runs: 8,
      judge: async (_q, p, e) => p === e,
    });
    // NaN is the honest reading of eight byte-identical repeats, and it is the
    // signal that motivated giving the ablations their own run count.
    expect(Number.isNaN(report.ablation.pValue)).toBe(true);
  });

  it('keeps the retry fire count stable across repeated runs', async () => {
    // The retry diagnostic must be a property of the configuration and the
    // dataset, not of how many times the ablation was invoked. If the fire
    // count grew with `runs`, a reader would infer the retry fires more often
    // than it does.
    let call = 0;
    const llm: LLM = {
      complete: async (prompt: string) => {
        if (prompt.includes('Specific activities:')) return 'pick up, return';
        call++;
        return call % 2 === 1 ? 'UNANSWERABLE' : 'Answer: 2';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const single = await runAbstentionRetryAblation(mrInstances, embedding, llm, { runs: 1 });
    let call2 = 0;
    const llm2: LLM = {
      complete: async (prompt: string) => {
        if (prompt.includes('Specific activities:')) return 'pick up, return';
        call2++;
        return call2 % 2 === 1 ? 'UNANSWERABLE' : 'Answer: 2';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const many = await runAbstentionRetryAblation(mrInstances, embedding, llm2, { runs: 8 });
    expect(single.retryFires.treatmentFires).toBeGreaterThan(0);
    expect(many.retryFires.treatmentFires).toBe(single.retryFires.treatmentFires);
    expect(many.retryFires.controlFires).toBe(0);
  });
});

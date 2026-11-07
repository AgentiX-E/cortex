/**
 * A quota that runs out on one question must not end the pass either.
 *
 * ## The run this pins
 *
 * `42381702081` was `P1`: the second-provider arm, `glm-4.6` through Zhipu, 500 questions, four
 * workers, a 340-minute budget. It ran for 5 h 42 min and ended `failure` with no report at all:
 *
 * ```text
 * LLM request failed: 429 Too Many Requests — {"error":{"code":1302,
 *   "message":"您的账户已达到速率限制，请您控制请求频率"}}
 *   — not retried (attempts-exhausted) after 9 attempt(s) and 160 s was left
 * ```
 *
 * The transport accounting on the same run says the provider throttled **28 of 1,613 requests**
 * (1.7%). Twenty-eight answers out of a thousand question-passes should cost twenty-eight entries,
 * and instead they cost the whole measurement: the arm's only artifact was a partial record that
 * cannot be graded, because grading needs the dataset and `delta` needs two aggregates over the
 * same index.
 *
 * ## Why this is the same defect as the deadline, seen from the other side
 *
 * `42381840503` lost a pass to a bound that lived in a module constant; the repair made the bound
 * declarable and made a reached bound an **entry loss** with a 2% ceiling. That repair classified
 * one shape -- every attempt reached the deadline -- and left every other exhaustion in `throw`.
 * A retry ladder that ends with every attempt answered `429` is the same fact about the same
 * layer: the provider's quota, not this system's behaviour, and not a per-question property.
 *
 * The two are kept apart in the record because their repairs differ. A deadline loss is answered
 * by `CORTEX_READER_TIMEOUT_MS`; a rate-limit loss by `CORTEX_LLM_MIN_INTERVAL_MS` or a larger
 * quota. One ceiling covers both, because the question the ceiling answers is "is this pass still
 * describing the system under test", and half of one kind plus half of the other is the same
 * answer as all of one kind.
 *
 * ## What is deliberately still fatal
 *
 * A mixed exhaustion -- one attempt answered `429`, another failing on the wire or on the clock --
 * still throws. Neither the quota nor the network alone explains it, so deciding it per question
 * would be guessing, and a guess in this layer is an accuracy number that describes the guess.
 */

import { describe, expect, it } from 'vitest';

import { OpenAICompatibleLLM, resetRetryStats } from '@agentix-e/cortex-ai';

import {
  deadlineLossCeiling,
  describeTransportLosses,
  lostToTransport,
  providerRefusals,
  runBenchmark,
} from '../benchmark.js';
import { judgeScorer } from '../metrics.js';
import type { AnswerJudge } from '../judge.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

/** A dataset whose first question is an abstention, so a `null` would score CORRECT. */
function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'rate-limit-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      expected: i === 0 ? null : `answer-${i}`,
      capability: i === 0 ? ('ABS' as const) : ('IE' as const),
      context: [`evidence ${i}`],
    })),
  };
}

/**
 * A `fetchFn` that answers `429` a fixed number of times, then behaves as told.
 *
 * A counter rather than a per-question predicate, because the thing under test is the ladder: what
 * the benchmark classifies is the *vector* of statuses one call collected, and a fetch keyed on
 * the question would produce one status per call by construction.
 */
function throttlingFetch(throttled: number, then: 'answer' | 'wire' = 'answer'): typeof fetch {
  let seen = 0;
  return async () => {
    seen += 1;
    if (seen <= throttled) {
      return new Response(
        JSON.stringify({ error: { code: '1302', message: 'rate limited, please slow down' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }
    if (then === 'wire') {
      throw new TypeError('terminated');
    }
    return new Response(
      JSON.stringify({
        id: 'x',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

/**
 * A system whose reader hits the given number of throttles on the indices `throttleAt` names.
 *
 * One client for the whole pass, as the real arm has. The base delay is a millisecond so the
 * ladder finishes inside the test; what is being classified is the status vector, and the waits
 * between attempts are deliberately not the subject.
 */
function throttlingSystem(
  throttleAt: readonly number[],
  options: {
    readonly attempts?: number;
    readonly throttled?: number;
    readonly then?: 'answer' | 'wire';
  } = {},
): MemorySystem {
  const attempts = options.attempts ?? 2;
  const throttled = options.throttled ?? attempts;
  // Each throttled question gets its own client, because one shared fetch counter would throttle
  // the first question's ladder and then answer the second question with a `200` it never earned.
  const clients = new Map<number, OpenAICompatibleLLM>();
  const clientFor = (index: number): OpenAICompatibleLLM => {
    const existing = clients.get(index);
    if (existing !== undefined) {
      return existing;
    }
    const built = new OpenAICompatibleLLM({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: attempts - 1,
      timeoutMs: 5_000,
      retryBudgetMs: 60_000,
      retryBaseDelayMs: 1,
      fetchFn: throttlingFetch(throttled, options.then),
    });
    clients.set(index, built);
    return built;
  };
  let cursor = 0;
  return {
    name: 'throttling-system',
    answer: async () => {
      const index = cursor++;
      if (throttleAt.includes(index)) {
        // The error's class and its `rateLimited` field are what the benchmark decides on, and
        // both are produced by the real adapter.
        await clientFor(index).complete('question');
      }
      return `answer-${index}`;
    },
  };
}

/** A judge that accepts any non-empty answer, so `''` has to fail on its own terms. */
const permissiveJudge: AnswerJudge = async (_question, predicted) => predicted.trim().length > 0;

describe('§13.309 a quota that runs out on one question is one question', () => {
  it('records an empty answer, counts the loss, and finishes the other questions', async () => {
    resetRetryStats();
    const before = lostToTransport('rate-limit').length;
    const answers = await runBenchmark(datasetOf(20), throttlingSystem([3]));

    expect(answers).toHaveLength(20);
    // No output, not a decline: the abstention column must not gain a free pass.
    expect(answers[3]).toBe('');
    expect(answers.filter((answer) => answer === null)).toHaveLength(0);
    expect(answers[0]).toBe('answer-0');
    expect(answers[19]).toBe('answer-19');

    const records = lostToTransport('rate-limit');
    expect(records.length - before).toBe(1);
    expect(records.at(-1)?.questionId).toBe('q3');
    expect(records.at(-1)?.kind).toBe('rate-limit');
    // The two numbers that separate this from a wire fault: every attempt was issued, and every
    // one of them was answered `429`.
    expect(records.at(-1)?.attempts).toBe(2);
  });

  it('does not record the loss as a deadline', async () => {
    resetRetryStats();
    const before = lostToTransport('deadline').length;
    await runBenchmark(datasetOf(10), throttlingSystem([2]));
    // The whole reason `kind` exists: the two repairs differ, so one counter for both would send a
    // reader to `CORTEX_READER_TIMEOUT_MS` for a quota problem.
    expect(lostToTransport('deadline').length).toBe(before);
  });

  it('does not record the loss as a provider refusal', async () => {
    resetRetryStats();
    const before = providerRefusals().length;
    await runBenchmark(datasetOf(10), throttlingSystem([2]));
    // `429` is not a moderation decision. Counting it as one would report a filter that never
    // fired, which is the defect the refusal branch's own `if`/`else` was written to prevent.
    expect(providerRefusals().length).toBe(before);
  });

  it('still throws when the attempts disagree about why they failed', async () => {
    resetRetryStats();
    // One attempt throttled, the second dead on the wire: neither the quota nor the network
    // explains it, so per-question classification would be a guess.
    await expect(
      runBenchmark(datasetOf(10), throttlingSystem([2], { throttled: 1, then: 'wire' })),
    ).rejects.toThrow(/terminated|429/);
  });

  it('ends the pass once the ceiling applies to both kinds together', async () => {
    resetRetryStats();
    // Sixteen of twenty questions: 80%, far past the 2% ceiling, so the pass stops describing the
    // system under test and the entry point writes the partial record the workflow reads.
    const throttled = Array.from({ length: 16 }, (_unused, i) => i);
    await expect(runBenchmark(datasetOf(20), throttlingSystem(throttled))).rejects.toThrow(
      /rate limit/i,
    );
  });

  it('names the pacing knob in the ceiling error, not the deadline knob', async () => {
    resetRetryStats();
    const throttled = Array.from({ length: 16 }, (_unused, i) => i);
    await expect(runBenchmark(datasetOf(20), throttlingSystem(throttled))).rejects.toThrow(
      /CORTEX_LLM_MIN_INTERVAL_MS/,
    );
  });

  it('counts the loss that ended the pass', async () => {
    resetRetryStats();
    const before = lostToTransport('rate-limit').length;
    const throttled = Array.from({ length: 16 }, (_unused, i) => i);
    await expect(runBenchmark(datasetOf(20), throttlingSystem(throttled))).rejects.toThrow();
    // The record names every loss **including** the one that ended the pass. Twenty questions
    // tolerate one loss, so the second ends it and the counter reads two; a pass that recorded only
    // the tolerated one would read one, and would be short by exactly one every time.
    expect(lostToTransport('rate-limit').length - before).toBe(2);
  });
});

describe('§13.309 the two kinds partition one list', () => {
  it('returns both when no kind is named, and the parts sum to the whole', async () => {
    resetRetryStats();
    await runBenchmark(datasetOf(10), throttlingSystem([2]));
    const all = lostToTransport();
    // The identity a reader relies on when it prints one line from the whole list and then explains
    // the kinds separately: if a third kind ever arrives without a name, this sum stops holding.
    expect(all.length).toBe(
      lostToTransport('deadline').length + lostToTransport('rate-limit').length,
    );
    expect(lostToTransport('rate-limit').length).toBeGreaterThan(0);
    expect(all.every((record) => record.kind === 'deadline' || record.kind === 'rate-limit')).toBe(
      true,
    );
  });
});

describe('§13.309 the loss renderer names both kinds', () => {
  /** A record shaped like the ones the catch pushes, so the renderer is tested on real input. */
  function record(kind: 'deadline' | 'rate-limit', capability: string) {
    return {
      questionId: 'q',
      capability,
      questionType: null,
      run: 0,
      kind,
      attempts: 2,
      timeoutMs: 600_000,
      elapsedMs: 1_000,
    } as const;
  }

  it('says nothing was lost when the records are empty', () => {
    const text = describeTransportLosses([], 500);
    expect(text).toContain('transport losses: 0');
    // The ceiling travels with the count even at zero: a reader has to be able to tell "the pass
    // tolerated nothing" from "the pass would have tolerated ten".
    expect(text).toContain(`${deadlineLossCeiling(500)}`);
  });

  it('reports the two kinds separately, each with its own capability spread', () => {
    const text = describeTransportLosses(
      [
        record('deadline', 'IE'),
        record('deadline', 'IE'),
        record('deadline', 'MR'),
        record('rate-limit', 'KU'),
        record('rate-limit', 'KU'),
      ],
      500,
    );
    expect(text).toContain('deadline 3 (IE 2, MR 1)');
    expect(text).toContain('rate limit 2 (KU 2)');
  });

  it('states the ceiling of the pass it was given', () => {
    const text = describeTransportLosses([record('deadline', 'IE')], 20);
    // 2% of twenty rounds to nothing, and the floor of one is what makes a smoke dispatch readable.
    expect(text).toContain(`${deadlineLossCeiling(20)}`);
  });

  it('omits a kind that did not occur, rather than printing a zero for it', () => {
    const text = describeTransportLosses([record('rate-limit', 'KU')], 500);
    expect(text).toContain('rate limit 1');
    expect(text).not.toContain('deadline');
  });

  it('names the knob each kind answers to', () => {
    const both = describeTransportLosses(
      [record('deadline', 'IE'), record('rate-limit', 'MR')],
      500,
    );
    // Two repairs, two variables. One sentence for both would send a reader to the wrong knob, and
    // the wrong knob is indistinguishable from no advice at all on the next dispatch.
    expect(both).toContain('CORTEX_READER_TIMEOUT_MS');
    expect(both).toContain('CORTEX_LLM_MIN_INTERVAL_MS');
  });
});

describe('§13.309 the ceiling is unchanged by the second kind', () => {
  it('is 2% of the pass, floored at one entry', () => {
    // Unchanged arithmetic, restated here because a shared ceiling is the claim being made: the
    // number of entries a pass tolerates is a property of the pass, not of which knob ran out.
    expect(deadlineLossCeiling(500)).toBe(10);
    expect(deadlineLossCeiling(20)).toBe(1);
    expect(deadlineLossCeiling(1)).toBe(1);
  });
});

describe('§13.309 a throttled answer still fails every channel on its own terms', () => {
  it('is scored wrong rather than dropped from the denominator', async () => {
    resetRetryStats();
    const dataset = datasetOf(6);
    const answers = await runBenchmark(dataset, throttlingSystem([4]));
    const scored = await judgeScorer(permissiveJudge)(dataset.questions[4]!, answers[4]!);
    expect(scored).toBe(false);
    // Kept in the denominator: dropping it would be the favourable half of a selection, because
    // the questions a quota eats are not a random sample of the pass.
    expect(answers).toHaveLength(6);
  });

  it('an abstention question lost to a throttle is not scored correct', async () => {
    resetRetryStats();
    const dataset = datasetOf(4);
    const answers = await runBenchmark(dataset, throttlingSystem([0]));
    // `q0` has `expected === null`, so a `null` answer would be CORRECT. `''` is not `null`.
    expect(answers[0]).toBe('');
    const scored = await judgeScorer(permissiveJudge)(dataset.questions[0]!, answers[0]!);
    expect(scored).toBe(false);
  });
});

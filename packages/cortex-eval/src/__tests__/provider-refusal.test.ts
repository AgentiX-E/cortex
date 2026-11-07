/**
 * A provider's moderation gate refuses one prompt, and that must cost one question.
 *
 * ## The loss this pins
 *
 * Run `42368550937` was the `P1` arm: 500 questions, two repetitions, `glm-4.6` against
 * `deepseek-chat`. At +1,003 s it had answered 83 questions when Zhipu answered `gpt4_2f8be40d`
 * with
 *
 * ```text
 * 400 Bad Request — {"contentFilter":[{"level":1,"role":"user"}],
 *                   "error":{"code":"1301","message":"... sensitive content ..."}}
 * ```
 *
 * The transport did the right thing -- a 400 is not retryable, so the ladder did not chase it --
 * and then rethrew, `runWorker`'s promise rejected, `Promise.all` rejected, `runBenchmark` threw,
 * and the pass ended. Two hours on four workers, no report, `failure`, `reached 83`. One question's
 * prompt contained text the provider refuses to read and 499 other questions lost their measurement
 * with it.
 *
 * ## Why the repair is a class rather than a rescued string
 *
 * Because the interesting half of the repair is what it must NOT catch. A malformed body, a bad
 * key, an exhausted retry ladder and a schema error all fail on every question, and a per-question
 * catch that swallowed them would convert a broken arm into a quiet accuracy number -- strictly
 * worse than the crash it replaced. So the marker is narrowed to a named class, and the tests below
 * pin the negative cases as carefully as the positive one.
 *
 * ## Why the refused answer is `''` and not `null`
 *
 * `null` is this repository's word for "the arm declined", and `judgeScorer` scores a decline
 * against an `expected === null` question as CORRECT -- rightly, because the abstention gold asks
 * for a decline. A moderation refusal is not a decline: nothing was produced. Recording it as one
 * would hand the `ABS` column a free pass on exactly the questions most likely to be filtered.
 */

import { describe, expect, it } from 'vitest';

import { ProviderContentRefusal, OpenAICompatibleLLM, resetRetryStats } from '@agentix-e/cortex-ai';

import { describeProviderRefusals, providerRefusals, runBenchmark } from '../benchmark.js';
import { judgeScorer } from '../metrics.js';
import type { AnswerJudge } from '../judge.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

/**
 * The body Zhipu actually returned, verbatim apart from the message text.
 *
 * A fixture that paraphrases its own failure is a fixture that stops testing the detector the
 * moment the provider rewords the message, which is why the literal is here rather than a
 * convenient `'filtered'`.
 */
const ZHIPU_REFUSAL_BODY = JSON.stringify({
  contentFilter: [{ level: 1, role: 'user' }],
  error: {
    code: '1301',
    message:
      '系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。',
  },
});

/** One LLM stub that answers every request with a fixed response. */
function llmReturning(status: number, body: string): OpenAICompatibleLLM {
  return new OpenAICompatibleLLM({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxRetries: 0,
    fetchFn: async () =>
      new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  });
}

/** A dataset of `count` questions, the first of which is an abstention. */
function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'refusal-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      // `q0` has no gold answer, so it is the question a `null` answer would score CORRECT on.
      expected: i === 0 ? null : `answer-${i}`,
      capability: i === 0 ? ('ABS' as const) : ('IE' as const),
      context: [`evidence ${i}`],
    })),
  };
}

/**
 * A system that raises a content refusal on the indices `refuseAt` names.
 *
 * Constructed as the real class rather than as a plain `Error` with the right `name`, so the test
 * exercises the identification the production path uses.
 */
function refusingSystem(refuseAt: readonly number[], refuseAll = false): MemorySystem {
  let cursor = 0;
  return {
    name: 'refusing-system',
    answer: async () => {
      const index = cursor++;
      if (refuseAll || refuseAt.includes(index)) {
        throw new ProviderContentRefusal('LLM request failed: 400 Bad Request', 400, '1301');
      }
      return `answer-${index}`;
    },
  };
}

/** A judge that accepts any non-empty answer, so `''` has to fail on its own. */
const permissiveJudge: AnswerJudge = async (_question, predicted) => predicted.trim().length > 0;

describe('ProviderContentRefusal: one question, not one pass', () => {
  it('is thrown for a 400 carrying the provider moderation marker', async () => {
    resetRetryStats();
    const llm = llmReturning(400, ZHIPU_REFUSAL_BODY);
    const error = await llm.complete('hello').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderContentRefusal);
    expect((error as ProviderContentRefusal).status).toBe(400);
    expect((error as ProviderContentRefusal).providerCode).toBe('1301');
  });

  it('is thrown for a 422, which is what a compatible gateway answers for the same condition', async () => {
    const llm = llmReturning(422, ZHIPU_REFUSAL_BODY);
    await expect(llm.complete('hello')).rejects.toBeInstanceOf(ProviderContentRefusal);
  });

  it('is NOT thrown for a plain 400, because that is a defect that fails every question', async () => {
    // The distinction is the whole safety of the per-question catch: a request body this adapter
    // built wrongly fails on all 500 questions, and deciding one of them would hide it.
    const llm = llmReturning(400, JSON.stringify({ error: { message: 'invalid schema' } }));
    const error = await llm.complete('hello').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderContentRefusal);
  });

  it('is NOT thrown for a 429 that happens to quote a marker, because that is throttling', async () => {
    // A throttling event is the one refusal the ladder is supposed to wait out. Reclassifying it as
    // a moderation decision would turn a wait into a lost measurement.
    resetRetryStats();
    const llm = llmReturning(429, ZHIPU_REFUSAL_BODY);
    const error = await llm.complete('hello').catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(ProviderContentRefusal);
  });

  it('is NOT thrown when the body merely contains the digits 1301 unquoted', async () => {
    // `1301` is a plausible byte offset or id. The marker list matches it as a quoted code, and this
    // asserts that the quoting is load-bearing rather than decorative.
    const llm = llmReturning(400, '{"error":{"message":"offset 1301 out of range"}}');
    const error = await llm.complete('hello').catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(ProviderContentRefusal);
  });
});

describe('the benchmark decides a refused question and finishes the pass', () => {
  it('records an empty answer, counts the refusal, and answers every other question', async () => {
    const before = providerRefusals().length;
    const answers = await runBenchmark(datasetOf(6), refusingSystem([2]));

    expect(answers).toHaveLength(6);
    // The refusal is `''`, not `null`: no output, as distinct from a decline.
    expect(answers[2]).toBe('');
    expect(answers.filter((a) => a === null)).toHaveLength(0);
    // Every other question was answered, which is the property the old behaviour destroyed.
    expect(answers[0]).toBe('answer-0');
    expect(answers[5]).toBe('answer-5');

    const records = providerRefusals();
    expect(records.length - before).toBe(1);
    expect(records.at(-1)?.questionId).toBe('q2');
    expect(records.at(-1)?.capability).toBe('IE');
    expect(records.at(-1)?.providerCode).toBe('1301');
  });

  it('keeps a refused abstention question OUT of the correct column', async () => {
    // The entire reason the answer is `''`. `q0` has `expected === null`, so a `null` answer scores
    // CORRECT under `judgeScorer` -- and the questions a moderation gate refuses are the personal
    // ones, which is what the abstention column is made of. This asserts that the free pass does not
    // exist.
    const dataset = datasetOf(3);
    const answers = await runBenchmark(dataset, refusingSystem([0]));
    expect(answers[0]).toBe('');

    const scorer = judgeScorer(permissiveJudge);
    expect(await scorer(dataset.questions[0]!, answers[0]!)).toBe(false);
    // The same `null` the old code would have written, scored by the same scorer, is TRUE:
    expect(await scorer(dataset.questions[0]!, null)).toBe(true);
  });

  it('still throws anything that is not a content refusal', async () => {
    // The negative case that matters most. A `TypeError: terminated` is what `37942775447` died of,
    // and it must keep ending the pass: it is a property of the transport and would recur on every
    // question, so deciding one of them would produce a number for a run that never happened.
    const dataset = datasetOf(4);
    let cursor = 0;
    const dying: MemorySystem = {
      name: 'dying',
      answer: async () => {
        cursor += 1;
        if (cursor === 2) throw new TypeError('terminated');
        return `answer-${cursor - 1}`;
      },
    };
    await expect(runBenchmark(dataset, dying)).rejects.toThrow(/terminated/);
  });

  it('survives a pass in which every question is refused, which is what a wrong endpoint looks like', async () => {
    // Not a hypothetical: pointing the arm at a model whose filter rejects the whole prompt shape
    // refuses all 500. The pass must end with 500 refusals and a readable line rather than a stack,
    // because the *reason* is what tells an operator to change the endpoint.
    const before = providerRefusals().length;
    const answers = await runBenchmark(datasetOf(5), refusingSystem([], true));
    expect(answers).toEqual(['', '', '', '', '']);
    expect(providerRefusals().length - before).toBe(5);
  });
});

describe('describeProviderRefusals', () => {
  it('prints 0 on every run, so a reader can tell "none" from "this log predates the counter"', () => {
    expect(describeProviderRefusals([])).toBe('provider refusals: 0');
  });

  it('names the capability spread, because the count alone cannot say whether it is concentrated', () => {
    // Three `ABS` refusals move the abstention column and leave the accuracy comparison alone; three
    // `MR` refusals move the column the gap is stated in. A bare count collapses that distinction.
    const line = describeProviderRefusals([
      { questionId: 'a', capability: 'ABS', questionType: null, providerCode: '1301' },
      { questionId: 'b', capability: 'MR', questionType: null, providerCode: '1301' },
      { questionId: 'c', capability: 'MR', questionType: null, providerCode: '1301' },
    ]);
    expect(line).toContain('provider refusals: 3');
    expect(line).toContain('MR 2, ABS 1');
    expect(line).toContain('kept in the denominator');
  });
});

describe('providerRefusals', () => {
  it('returns a copy, so a caller cannot mutate the record it was handed', () => {
    const records = providerRefusals();
    expect(records).not.toBe(providerRefusals());
    // Guarding the READ is what matters: `readonly` is erased at runtime, so a consumer that casts
    // could otherwise rewrite history that the report is derived from.
    if (records.length > 0) {
      expect(records[0]).not.toBe(providerRefusals()[0]);
    }
  });

  it('counts an answer of `as Answer`-typed empty string as no output, not as a decline', () => {
    // A type-level statement, asserted at the value level: `Answer` admits both, and the two mean
    // different things downstream.
    const noOutput: Answer = '';
    const declined: Answer = null;
    expect(noOutput).not.toBe(declined);
    expect(Boolean(noOutput)).toBe(false);
    expect(declined).toBeNull();
  });
});

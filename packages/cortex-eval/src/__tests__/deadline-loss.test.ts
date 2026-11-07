/**
 * A deadline that one question reaches, and the 499 it must not take with it.
 *
 * ## The run this pins
 *
 * `42381840503` was the `M1` arm B: `deepseek-v4-pro`, 500 questions, two repetitions, four workers.
 * It answered 291 and then died on
 *
 * ```text
 * {"url":"https://api.deepseek.com/v1/chat/completions","attempts":2,"retried":1,
 *  "elapsedMs":601000,"attemptsMs":[299999,300001],"timeoutMs":300000,"retryBudgetMs":420000,
 *  "cause":"The operation was aborted due to timeout"}
 * ```
 *
 * **Both** attempts reached the deadline. That is the whole taxonomy in one object: `attemptsMs[i]`
 * equal to `timeoutMs` means the bound fired, and a shorter number means the socket died on the
 * wire. Only the first is a fact about one question's latency; the second is a property of the
 * transport, and deciding it per question would let a dead endpoint produce 500 empty answers and a
 * quiet accuracy near zero.
 *
 * ## Why the empty string, again
 *
 * For the reason `provider-refusal.test.ts` states at length: `null` is "the arm declined" and
 * `judgeScorer` scores a decline CORRECT against an unanswerable gold. A stall produced no output,
 * which is `''`, and the distinction is worth a test in both files because it is worth four points
 * of one column.
 *
 * ## Why the tests build the error instead of describing it
 *
 * Because the classification reads `retryExhausted`, and an object literal with a `retryExhausted`
 * field would test the reader of that field rather than the producer of it. Every fixture below
 * drives the real `OpenAICompatibleLLM` retry ladder through a `fetchFn` that stands in for the
 * network, so the `attemptsMs` vector is measured by the loop that measures it in production.
 */

import { describe, expect, it } from 'vitest';

import { OpenAICompatibleLLM, resetRetryStats } from '@agentix-e/cortex-ai';

import {
  deadlineLossCeiling,
  describeDeadlineLosses,
  lostToDeadline,
  providerRefusals,
  runBenchmark,
} from '../benchmark.js';
import { judgeScorer } from '../metrics.js';
import type { AnswerJudge } from '../judge.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

/** A dataset of `count` questions whose first is an abstention, so a `null` would score CORRECT. */
function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'deadline-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      expected: i === 0 ? null : `answer-${i}`,
      capability: i === 0 ? ('ABS' as const) : ('IE' as const),
      context: [`evidence ${i}`],
    })),
  };
}

/** The deadline these fixtures give the reader, in milliseconds. Short, because the test is. */
const DEADLINE_MS = 30;

/**
 * A `fetchFn` that honours the abort signal and never answers.
 *
 * The listener is what makes this a deadline instead of a hang: `AbortSignal.timeout` fires, the
 * promise rejects with the error undici raises, and the retry loop records the attempt's duration
 * around it. A `fetchFn` that ignored the signal would leave the loop waiting forever and prove
 * nothing about the classification.
 */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      });
    });
}

/** A `fetchFn` that fails on the wire at once, the way `37942775447` died. */
function dyingFetch(): typeof fetch {
  return async () => {
    throw new TypeError('terminated');
  };
}

/**
 * A system whose reader hangs on the indices `stallAt` names and answers everywhere else.
 *
 * One client for the whole pass, as the real arm has: a per-question client would reset the retry
 * counters and hide the very vector the classification reads.
 */
function stallingSystem(stallAt: readonly number[], maxRetries = 1): MemorySystem {
  const llm = new OpenAICompatibleLLM({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxRetries,
    timeoutMs: DEADLINE_MS,
    // Above the deadline, so a retry is affordable: the ladder needs at least one to produce the
    // two-element `attemptsMs` vector the classification insists on.
    retryBudgetMs: DEADLINE_MS * 4,
    fetchFn: hangingFetch(),
  });
  let cursor = 0;
  return {
    name: 'stalling-system',
    answer: async () => {
      const index = cursor++;
      if (stallAt.includes(index)) {
        // The message is never read; the error's class and its `retryExhausted` field are what the
        // benchmark decides on, and both are produced by the real adapter.
        await llm.complete('question');
      }
      return `answer-${index}`;
    },
  };
}

/** A judge that accepts any non-empty answer, so `''` has to fail on its own. */
const permissiveJudge: AnswerJudge = async (_question, predicted) => predicted.trim().length > 0;

describe('a deadline loss is one question, not one pass', () => {
  it('records an empty answer, counts the loss, and finishes the other questions', async () => {
    resetRetryStats();
    const before = lostToDeadline().length;
    const answers = await runBenchmark(datasetOf(20), stallingSystem([3]));

    expect(answers).toHaveLength(20);
    // No output, not a decline -- and the difference is the abstention column.
    expect(answers[3]).toBe('');
    expect(answers.filter((answer) => answer === null)).toHaveLength(0);
    // Every other question was answered: the property the timeout destroyed before this repair.
    expect(answers[0]).toBe('answer-0');
    expect(answers[19]).toBe('answer-19');

    const records = lostToDeadline();
    expect(records.length - before).toBe(1);
    expect(records.at(-1)?.questionId).toBe('q3');
    expect(records.at(-1)?.capability).toBe('IE');
    // The vector that separates this loss from a wire fault, kept in the record rather than only in
    // the error object the pass threw away.
    expect(records.at(-1)?.timeoutMs).toBe(DEADLINE_MS);
    expect(records.at(-1)?.attempts).toBe(2);
  });

  it('keeps a stalled abstention question OUT of the correct column', async () => {
    resetRetryStats();
    const dataset = datasetOf(20);
    const answers = await runBenchmark(dataset, stallingSystem([0]));
    expect(answers[0]).toBe('');

    const scorer = judgeScorer(permissiveJudge);
    expect(await scorer(dataset.questions[0]!, answers[0]!)).toBe(false);
    // The same `null` a per-question catch could have written, and why it must not be:
    expect(await scorer(dataset.questions[0]!, null)).toBe(true);
  });

  it('does not count a deadline loss as a provider refusal', async () => {
    // The regression this exists for was found by mutating the write below into `record(null, ...)`
    // and watching nothing fail: the first version of the catch decided a loss and then fell through
    // into the refusal branch, which pushed a refusal record and wrote the answer a second time. One
    // timeout would have been reported as a loss *and* as a moderation refusal -- a filter that never
    // fired, on the line an operator reads to decide whether to change the endpoint.
    resetRetryStats();
    const before = providerRefusals().length;
    await runBenchmark(datasetOf(20), stallingSystem([3]));
    expect(providerRefusals().length - before).toBe(0);
  });

  it('still throws a wire fault, which reaches no deadline on any attempt', async () => {
    // The negative case that carries the whole decision. `TypeError: terminated` is a property of
    // the transport and recurs on every question, so deciding one of them would produce a number
    // for a run that never happened.
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: 1,
      timeoutMs: DEADLINE_MS,
      retryBudgetMs: DEADLINE_MS * 4,
      fetchFn: dyingFetch(),
    });
    const dying: MemorySystem = {
      name: 'dying',
      answer: async () => {
        await llm.complete('question');
        return 'never reached';
      },
    };
    await expect(runBenchmark(datasetOf(20), dying)).rejects.toThrow(/terminated/);
  });

  it('throws a call whose attempts disagree, because a mixed cause is not a deadline', async () => {
    // First attempt reaches the deadline, the retry dies on the wire. Classifying this as a loss
    // would let a half-broken network be reported as a slower reader.
    let calls = 0;
    const mixed = new OpenAICompatibleLLM({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: 1,
      timeoutMs: DEADLINE_MS,
      retryBudgetMs: DEADLINE_MS * 4,
      fetchFn: (_input, init) => {
        calls += 1;
        if (calls === 1) {
          return hangingFetch()(_input as RequestInfo | URL, init);
        }
        return dyingFetch()(_input as RequestInfo | URL, init);
      },
    });
    const system: MemorySystem = {
      name: 'mixed',
      answer: async () => {
        await mixed.complete('question');
        return 'never reached';
      },
    };
    await expect(runBenchmark(datasetOf(20), system)).rejects.toThrow(/terminated/);
  });

  it('ends the pass once the losses exceed the registered share', async () => {
    // 20 questions put the ceiling at one; the second loss is the point where the pass is measuring
    // an endpoint rather than a memory system, and the message says which number to raise.
    resetRetryStats();
    await expect(runBenchmark(datasetOf(20), stallingSystem([1, 2]))).rejects.toThrow(
      /deadline losses reached 2 of 20/,
    );
    await expect(runBenchmark(datasetOf(20), stallingSystem([1, 2]))).rejects.toThrow(
      /CORTEX_READER_TIMEOUT_MS/,
    );
  });

  it('registers the share it enforces, so the ceiling is a claim rather than a constant', () => {
    // 2% of 500 is ten, and the entry point prints the same function's answer. Written as an
    // assertion because a change to the number changes what a dispatch means, and the threshold the
    // documents quote has to move with it.
    expect(deadlineLossCeiling(500)).toBe(10);
    // A smoke run cannot be born dead: 2% of 20 is 0.4, and a ceiling of zero would fail the first
    // loss on a reader whose tail is exactly what the smoke is looking for.
    expect(deadlineLossCeiling(20)).toBe(1);
  });
});

describe('describeDeadlineLosses', () => {
  it('prints 0 on every run, so "none" is distinguishable from "this log predates the counter"', () => {
    expect(describeDeadlineLosses([])).toBe('deadline losses: 0');
  });

  it('names the capability spread and the bound, which are the two facts a reader needs', () => {
    const line = describeDeadlineLosses([
      {
        questionId: 'a',
        capability: 'MR',
        questionType: null,
        run: 0,
        attempts: 2,
        timeoutMs: 300_000,
        elapsedMs: 601_000,
      },
      {
        questionId: 'b',
        capability: 'IE',
        questionType: null,
        run: 0,
        attempts: 2,
        timeoutMs: 300_000,
        elapsedMs: 600_500,
      },
    ]);
    expect(line).toContain('deadline losses: 2');
    // Ties are ordered by capability name, not by arrival: the line has to be stable across runs so
    // two artifacts can be compared as text.
    expect(line).toContain('IE 1, MR 1');
    expect(line).toContain('300000 ms');
    expect(line).toContain('kept in the denominator');
  });

  it('lists two bounds in order when a pass ran under two of them', () => {
    // A run with a declared deadline on the thinking routes and the implied one elsewhere is the
    // shape §13.197.4 already produces, and two numbers in one line is what tells a reader that the
    // loss did not come from the room they were tuning.
    const record = (timeoutMs: number) => ({
      questionId: `q-${String(timeoutMs)}`,
      capability: 'TR',
      questionType: null,
      run: 0,
      attempts: 2,
      timeoutMs,
      elapsedMs: timeoutMs * 2,
    });
    const line = describeDeadlineLosses([record(600_000), record(60_000)]);
    expect(line).toContain('60000 ms, 600000 ms');
  });
});

describe('lostToDeadline', () => {
  it('returns a copy, so a caller cannot rewrite the record the report is derived from', () => {
    expect(lostToDeadline()).not.toBe(lostToDeadline());
  });
});

/**
 * Splitting a run's spend by the side that spent it.
 *
 * ## What the instrument has to survive
 *
 * The split is taken by snapshotting the process ledger around each `answer*` call, which means
 * three things can go wrong and each is a test below:
 *
 * 1. **The wrapper hides a route.** A class instance keeps its methods on the prototype, so a
 *    spread or an object literal would copy none of them and `isSessionAware` would see a
 *    flat-only system -- the defect `traceReviewMechanisms` records for run `40984213349`. The
 *    wrapper therefore delegates every member explicitly.
 * 2. **The numbers stop closing.** `residual = total - baseline - feature` must never be
 *    negative; if it is, the snapshots did not come from one ledger and the artifact must fail
 *    rather than print a side that looks free.
 * 3. **Attribution changes behaviour.** A wrapper that reorders, retries or reformats is a
 *    second variable. The only effect asserted here is that the accumulated numbers move.
 */
import { describe, expect, it } from 'vitest';
import { OpenAICompatibleLLM } from '@agentix-e/cortex-ai';
import type { LLM } from '@agentix-e/cortex-core';

import type { BenchmarkDataset, MemorySystem } from '../types.js';
import { cortextMemoryArmOptions, toMemoryArmConfig } from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';

import { bothSides, residualUsage, traceUsage, zeroUsage } from '../usage-by-side.js';

function usage(promptTokens: number, calls = 1) {
  return {
    calls,
    unpricedCalls: 0,
    promptTokens,
    completionTokens: calls,
    cacheHitPromptTokens: Math.floor(promptTokens / 2),
  };
}

describe('usage arithmetic', () => {
  it('sums field by field, not by total', () => {
    const a = { ...usage(100), calls: 2, completionTokens: 3, cacheHitPromptTokens: 50 };
    const b = { ...usage(1), calls: 1, completionTokens: 7, cacheHitPromptTokens: 0 };

    // `bothSides` is the module's own sum of the two sides, so the closure test below and this
    // one are reading the same arithmetic rather than two copies of it.
    expect(bothSides({ baseline: a, feature: b })).toEqual({
      calls: 3,
      unpricedCalls: 0,
      promptTokens: 101,
      completionTokens: 10,
      cacheHitPromptTokens: 50,
    });
  });

  it('subtracts to a residual that closes the run exactly', () => {
    const total = usage(1_000, 10);
    const bySide = { baseline: usage(200, 3), feature: usage(700, 6) };

    const residual = residualUsage(total, bySide);

    // The closure itself: nothing is left over and nothing is counted twice.
    expect(bothSides(bySide).promptTokens + residual.promptTokens).toBe(total.promptTokens);
    expect(bothSides(bySide).calls + residual.calls).toBe(total.calls);
    expect(residual.promptTokens).toBe(100);
  });

  it('refuses a part larger than the whole instead of clamping to zero', () => {
    // A clamped zero would read as "this side spent nothing", which is the opposite of what a
    // part larger than its whole means: the two snapshots were not taken from one ledger.
    expect(() =>
      residualUsage(usage(100, 4), { baseline: usage(60, 2), feature: usage(41, 2) }),
    ).toThrow(/not closable/);
    // Per field, so a part that made more calls than the whole still fails even when its token
    // totals are smaller -- comparing totals would let the larger field mask the smaller one.
    expect(() =>
      residualUsage(usage(100, 4), { baseline: usage(10, 3), feature: usage(10, 3) }),
    ).toThrow(/calls/);
  });

  it('refuses a residual that would go negative on any field', () => {
    expect(() =>
      residualUsage(usage(100, 2), { baseline: usage(60, 1), feature: usage(60, 1) }),
    ).toThrow(/not closable/);
  });

  it('starts from the identity, so a side with no questions is zero rather than absent', () => {
    expect(zeroUsage()).toEqual({
      calls: 0,
      unpricedCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitPromptTokens: 0,
    });
    expect(bothSides({ baseline: zeroUsage(), feature: usage(5, 1) }).promptTokens).toBe(5);
  });
});

/**
 * The wrapper, driven through the real adapter rather than a stand-in.
 *
 * `recordUsage` is deliberately not exported from `cortex-ai` -- a "record your own usage" door
 * would let a caller double-count a call the adapter already recorded -- so the only honest way to
 * move the ledger is to make a call through the adapter. Its `fetchFn` is injectable, so the
 * provider is stubbed at the HTTP boundary and everything above it is the real code path.
 */
describe('attributing a call to a side', () => {
  /** A provider that answers one completion and reports what it charged for it. */
  function provider(promptTokens: number): LLM {
    return new OpenAICompatibleLLM({
      baseUrl: 'http://stub.invalid/v1',
      apiKey: 'not-a-credential',
      model: 'stub',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Lisbon' } }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: 2,
              // The field name is the provider's, not OpenAI's: `parseUsage` reads
              // `prompt_cache_hit_tokens`, so a stub that reports
              // `prompt_tokens_details.cached_tokens` attributes no cache credit at all -- which
              // is how this test first failed, and the failure is the documentation.
              prompt_cache_hit_tokens: Math.floor(promptTokens / 2),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
  }

  it('records the spend of the system it wraps, and only that side', async () => {
    const ledger = { baseline: zeroUsage(), feature: zeroUsage() };
    const llm = provider(30);
    const system: MemorySystem = {
      name: 'probe',
      answer: async () => (await llm.complete('Where?')) as never,
    };

    const traced = traceUsage(system, 'feature', ledger);
    await traced.answer('Where?', ['user: I went to Lisbon.']);

    expect(ledger.feature.promptTokens).toBe(30);
    expect(ledger.feature.calls).toBe(1);
    expect(ledger.feature.cacheHitPromptTokens).toBe(15);
    expect(ledger.baseline.promptTokens).toBe(0);
    expect(ledger.baseline.calls).toBe(0);
  });

  it('returns the answer unchanged, because attribution is not a treatment', async () => {
    const ledger = { baseline: zeroUsage(), feature: zeroUsage() };
    const system: MemorySystem = {
      name: 'probe',
      answer: () => 'Lisbon',
    };

    const traced = traceUsage(system, 'baseline', ledger);

    expect(await traced.answer('Where?', [])).toBe('Lisbon');
    // A system that calls no model costs nothing and is attributed nothing: the wrapper must not
    // invent spend for a side that made none.
    expect(ledger.baseline.calls).toBe(0);
  });

  it('records a call that threw, because the request left the machine anyway', async () => {
    const ledger = { baseline: zeroUsage(), feature: zeroUsage() };
    const llm = provider(40);
    const system: MemorySystem = {
      name: 'probe',
      answer: async () => {
        await llm.complete('Where?');
        throw new Error('reader failed after the request');
      },
    };

    await expect(traceUsage(system, 'feature', ledger).answer('Where?', [])).rejects.toThrow(
      /failed after the request/,
    );
    expect(ledger.feature.promptTokens).toBe(40);
  });

  it('ignores an own member that only looks routable', async () => {
    // `answerCount` starts with the prefix and is not a function. Wrapping it would replace a
    // number with a function and the reader of that field would get `[Function]` in an artifact.
    const ledger = { baseline: zeroUsage(), feature: zeroUsage() };
    const system = {
      name: 'probe',
      answerCount: 3,
      answer: () => 'Lisbon',
    } as unknown as MemorySystem;

    const traced = traceUsage(system, 'feature', ledger) as unknown as { answerCount: number };

    expect(traced.answerCount).toBe(3);
  });

  it('keeps every route of the wrapped system reachable', async () => {
    // The prototype-chain defect: a wrapper built by spreading an instance copies no method, so a
    // session-aware system would arrive flat and MR would answer from one session.
    const ledger = { baseline: zeroUsage(), feature: zeroUsage() };
    const sessions: unknown[] = [];
    class System {
      readonly name = 'probe';
      answer(): string {
        return 'flat';
      }
      answerSessions(_question: string, value: unknown[]): string {
        sessions.push(value);
        return 'sessions';
      }
    }
    const traced = traceUsage(new System() as never, 'baseline', ledger);

    expect((traced as unknown as { answerSessions: unknown }).answerSessions).toBeTypeOf(
      'function',
    );
    expect((traced as unknown as { name: string }).name).toBe('probe');
    await (
      traced as unknown as { answerSessions: (q: string, s: unknown[][]) => Promise<string> }
    ).answerSessions('Where?', [['a']]);
    expect(sessions).toHaveLength(1);
  });
});

/**
 * The split as it reaches the artifact, through the arm's own run.
 *
 * The unit tests above prove the arithmetic and the wrapper; this proves the wiring, which is the
 * layer where an instrument goes missing without anything failing. The two sides are given
 * *different* spend on purpose: a stub that charged both the same amount would pass on an
 * implementation that attributed the total to one side twice.
 */
describe('the split in the artifact', () => {
  function provider(promptTokens: number): LLM {
    return new OpenAICompatibleLLM({
      baseUrl: 'http://stub.invalid/v1',
      apiKey: 'not-a-credential',
      model: 'stub',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Lisbon' } }],
            usage: { prompt_tokens: promptTokens, completion_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
  }

  const dataset = {
    name: 'fixture',
    questions: [
      {
        id: 'q1',
        capability: 'IE',
        questionType: 'single-session-user',
        question: 'Where?',
        expected: 'Lisbon',
        context: ['user: I went to Lisbon.'],
        sessions: [['user: I went to Lisbon.']],
      },
    ],
  } as unknown as BenchmarkDataset;

  it('splits the bill by side and closes against the total', async () => {
    const { runCortexMemoryArm } = await import('../bench-memory-arm.js');
    const expensive = provider(300);
    const cheap = provider(100);
    const spent = (llm: LLM): MemorySystem => ({
      name: 'probe',
      answer: async () => (await llm.complete('Where?')) as never,
    });

    const { report, markdown } = await runCortexMemoryArm(
      dataset,
      { ...spent(cheap), name: 'reference-pipeline' },
      { ...spent(expensive), name: 'cortex-memory' },
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
      },
    );

    expect(report.usageBySide?.feature.promptTokens).toBe(300);
    expect(report.usageBySide?.baseline.promptTokens).toBe(100);
    // The closure the reader is told to trust, asserted on the artifact rather than reasoned about.
    const bySide =
      (report.usageBySide?.feature.promptTokens ?? 0) +
      (report.usageBySide?.baseline.promptTokens ?? 0);
    expect(bySide + residualUsage(report.llmUsage!, report.usageBySide!).promptTokens).toBe(
      report.llmUsage?.promptTokens,
    );
    expect(markdown).toContain('Attribution closes: **yes**');
    expect(markdown).toContain('| Side | calls | prompt tokens |');
  });

  it('omits the split entirely when no side called a model', async () => {
    // The absence rule, one level up from `llmUsage`: a run with no instrumented call has no split
    // to report, and zeros would claim both arms were free.
    const { runCortexMemoryArm } = await import('../bench-memory-arm.js');
    const flat = (name: string): MemorySystem => ({ name, answer: () => 'Lisbon' });

    const { report, markdown } = await runCortexMemoryArm(
      dataset,
      flat('reference-pipeline'),
      flat('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
      },
    );

    expect(report.usageBySide).toBeUndefined();
    expect(markdown).not.toContain('Attribution closes');
  });
});

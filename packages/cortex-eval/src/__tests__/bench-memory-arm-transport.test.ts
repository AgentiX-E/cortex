/**
 * The arm's artifact must carry what the transport layer saw, and only what it saw.
 *
 * ## Two claims, and they fail in opposite directions
 *
 * The first is reach: `transportRetry` has to be in the report, because the reader of an
 * artifact cannot run the retry layer and the counters are the only record that a provider
 * throttled the run. The second is boundary: the counters live in a process-level aggregate,
 * so without a reset the number describes everything the process did before the first
 * question -- an embedding preflight, a probe, a warm-up -- and presents it as part of the
 * measurement. A count nobody can attribute is worse than no count, because it looks like
 * one.
 *
 * The test seeds the aggregate with a real retried call before the arm runs, which is the
 * only way to tell "the reset happened" from "nothing had happened yet". A fixture that
 * started from zero would pass against an implementation with no reset at all.
 */
import { describe, expect, it } from 'vitest';

import { resetRetryStats, retryStats, retryableFetch } from '@agentix-e/cortex-ai';

import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
} as const;

function dataset(): BenchmarkDataset {
  return {
    name: 'fixture',
    questions: [
      { id: 'q1', capability: 'IE', question: 'Question one?', expected: 'one', context: [] },
    ],
  };
}

function constantSystem(name: string, answer: Answer): MemorySystem {
  return { name, answer: () => answer };
}

/** One call that is rejected once and then served, so the aggregate is provably non-zero. */
async function seedOneRetry(): Promise<void> {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return calls === 1 ? new Response('{}', { status: 429 }) : new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  // `baseDelayMs: 0` keeps the fixture instant; the counter does not care how long it waited.
  await retryableFetch(fetchFn, 'http://seed.invalid', {}, { maxRetries: 1, baseDelayMs: 0 });
}

describe('the arm reports the transport counters', () => {
  it('carries the snapshot, labelled as the run rather than as one provider', async () => {
    resetRetryStats();
    const result = await runCortexMemoryArm(
      dataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );
    // Present, and present unconditionally: see `attachTransport`. A conclusion from a system
    // double that never calls a provider is `calls: 0`, which the section renders as NOT WIRED
    // rather than omitting the section -- so absence always means "written before the field".
    expect(result.report.transportRetry).toBeDefined();
    expect(result.report.transportRetry?.provider).toBe('run');
    expect(result.report.transportRetry?.scope).toBe('process');
  });

  it('describes this arm and not the traffic that preceded it', async () => {
    resetRetryStats();
    await seedOneRetry();
    // The seed is a fact about the aggregate before the arm starts: one call, one retry.
    expect(retryStats().retried).toBe(1);

    const result = await runCortexMemoryArm(
      dataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    // The doubles answer from a constant and never reach a provider, so the arm's own traffic
    // is zero -- and the seeded retry must not be visible in its artifact.
    expect(result.report.transportRetry?.calls).toBe(0);
    expect(result.report.transportRetry?.retried).toBe(0);
    expect(result.report.transportRetry?.attempts).toBe(0);
    // And the aggregate itself was reset, so the arm's counters describe the arm: the seed is
    // gone from the process total too, which is what makes the fields above a reading of the
    // same number rather than of a stale one.
    expect(retryStats().retried).toBe(0);
  });
});

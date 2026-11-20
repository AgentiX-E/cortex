/**
 * Two numbers the artifact published without saying which question they answered.
 *
 * Both defects are the same shape and both have already cost this campaign a wrong publication:
 *
 * 1. **`goldAccount`.** `S18`'s pair read `goldOverlap.carried < total` on sixteen of 121
 *    multi-session questions and every reader -- this one included -- took it for a retrieval
 *    finding. It is not one: the registered signal builds its ranking **inside the product**, so
 *    the artifact never held the pool, and "never surfaced" and "surfaced and cut by the room" are
 *    the same row. The two readings license opposite next increments.
 * 2. **`accuracyEstimator`.** Round 145 read `questions[].correct` (repetition 0) beside a criterion
 *    written for the mean over four repetitions, published `+4`, and retired it for `+1.75` in the
 *    same round. Nothing in the artifact said which population either number came from.
 *
 * Everything here is asserted through the two functions a run calls -- `toMemoryArmConfig` and
 * `runAblationReport` -- and never through the derivation helper. That is deliberate: a test that
 * calls `goldAccountOf` would pin a private function and leave the projection free to disagree with
 * it, which is the class of defect (a recorded configuration that never reached the decision it
 * names) this repository has paid for more than once.
 */
import { describe, it, expect } from 'vitest';
import { buildsProductIndex, cortextMemoryArmOptions, toMemoryArmConfig } from '../bench-memory-arm.js';
import { formatAblationReport, runAblationReport } from '../report.js';
import { FactMemorySystem } from '../fact-memory.js';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';

/** The six signals the arm accepts, in the spelling `CORTEX_MEMORY_RELEVANCE` takes. */
const SIGNALS = [
  'none',
  'retrieval',
  'retrieval-hybrid',
  'retrieval-anchored',
  'retrieval-session',
  'self-index',
] as const;

const goldAccountOf = (signal: string): string | undefined =>
  toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: signal }))
    .goldAccount;

describe('goldAccount, as the artifact records it', () => {
  it('names the product as the owner of the pool when the product builds it', () => {
    // The registered arm, and the state every published number of this campaign was produced under.
    // `product-unreported` rather than `ranked` because the artifact holds no pool to rank against:
    // the honest statement is that the account cannot answer the question.
    expect(goldAccountOf('self-index')).toBe('product-unreported');
  });

  it('names the harness when the harness builds the pool', () => {
    for (const signal of ['retrieval', 'retrieval-hybrid', 'retrieval-anchored', 'retrieval-session']) {
      expect(goldAccountOf(signal)).toBe('ranked');
    }
  });

  it('names the absence when no ranking was consulted', () => {
    expect(goldAccountOf('none')).toBe('none');
  });

  it('agrees with the wiring decision on every signal the arm accepts', () => {
    // The one pair that must never exist: an artifact claiming a readable pool on a run whose ranking
    // lived inside the product. Both are derived from `buildsProductIndex`, and this is the assertion
    // that keeps the derivation and the wiring in step across the whole list rather than at one value.
    for (const signal of SIGNALS) {
      const readable = goldAccountOf(signal) === 'ranked';
      const productOwned = buildsProductIndex(signal);
      expect(productOwned && readable).toBe(false);
      expect(readable || productOwned || signal === 'none').toBe(true);
    }
  });
});

describe('the rendered report', () => {
  const run = async () =>
    runAblationReport(
      createLongMemEvalMini(),
      new FactMemorySystem('naive', { fallback: 'unknown' }),
      new FactMemorySystem('abstain', { abstainThreshold: 0.3 }),
      {
        runs: 1,
        memoryArmConfig: toMemoryArmConfig(
          cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: 'self-index' }),
        ),
      },
    );

  it('names the estimator of the accuracy it prints', async () => {
    const report = await run();
    // Written unconditionally, because `metrics.accuracy` is one pass by construction: a field that
    // could be absent would let "not labelled" read as "the mean over runs".
    expect(report.accuracyEstimator).toBe('first-repetition');
    const rendered = formatAblationReport(report);
    expect(rendered).toContain('`accuracyEstimator: first-repetition`');
  });

  it('says the gold account is blind on the line a reader quotes', async () => {
    const rendered = formatAblationReport(await run());
    // On the configuration line, so two runs whose accounts can answer different questions are
    // distinguishable without opening the JSON...
    expect(rendered).toContain('`goldAccount=product-unreported`');
    // ...and as a sentence beside the numbers, because `carried < total` is read there.
    expect(rendered).toContain('The gold account is blind on this run');
  });
});

/**
 * What the artifact says about the ranking that produced its evidence -- and when it can say it.
 *
 * Three defects share one shape: a number the artifact published without saying which question it
 * answered, and each one has already cost this campaign a wrong publication.
 *
 * 1. **`goldAccount`.** `S18`'s pair read `goldOverlap.carried < total` on sixteen of 121
 *    multi-session questions and every reader -- this one included -- took it for a retrieval
 *    finding. It is not one: the registered signal builds its ranking **inside the product**, so
 *    the artifact never held the pool, and "never surfaced" and "surfaced and cut by the room" were
 *    the same row. The two readings license opposite next increments.
 * 2. **`accuracyEstimator`.** Round 145 read `questions[].correct` (repetition 0) beside a criterion
 *    written for the mean over four repetitions, published `+4`, and retired it for `+1.75` in the
 *    same round. Nothing in the artifact said which population either number came from.
 * 3. **The account itself, now readable.** `CortexMemory.rankingCensusOf` reports the order the
 *    product used, so a `self-index` run can hold `goldRanks` after all -- and the field that said
 *    "this artifact cannot answer that" has to change when the artifact can. That is why the value is
 *    counted from the records rather than derived from the signal: the same signal now produces both
 *    outcomes, and a pre-run derivation would state a capability the file may not hold.
 *
 * Everything here is asserted through the two functions a run calls -- `toMemoryArmConfig` and
 * `runCortexMemoryArm` -- and never through the derivation helper. That is deliberate: a test that
 * called `goldAccountOf` would pin a private function and leave the projection free to disagree with
 * it, which is the class of defect (a recorded configuration that never reached the decision it
 * names) this repository has paid for more than once.
 */
import { describe, it, expect } from 'vitest';
import {
  cortextMemoryArmOptions,
  runCortexMemoryArm,
  toMemoryArmConfig,
} from '../bench-memory-arm.js';
import { formatAblationReport, runAblationReport } from '../report.js';
import { exactMatchScorer } from '../metrics.js';
import { FactMemorySystem } from '../fact-memory.js';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

const GOLD_A = 'the bicycle was repaired on tuesday';
const GOLD_B = 'a parcel arrived for the neighbour';
const FILLER = 'rain cancelled the football match';

/** Two questions whose gold turn is a turn the system was shown, so `goldOverlap` has something to count. */
function goldDataset(): BenchmarkDataset {
  const context = [GOLD_A, GOLD_B, FILLER];
  return {
    name: 'ranking-account-fixture',
    questions: [
      {
        id: 'mr-a',
        capability: 'MR',
        question: 'when was the bicycle repaired?',
        expected: GOLD_A,
        context,
        goldTurns: [GOLD_A],
      },
      {
        id: 'mr-b',
        capability: 'MR',
        question: 'did the parcel arrive?',
        expected: GOLD_B,
        context,
        goldTurns: [GOLD_B],
      },
    ],
  };
}

/**
 * A system that carries one question's context and, optionally, reports a ranking for it.
 *
 * Structured like the product's own accessors -- one slot, written by `answer`, read afterwards -- because
 * the two are the same contract and a fixture with a different one would test the fixture.
 */
type ReportingSystem = MemorySystem & {
  readonly lastRetrievedContext?: () => readonly string[] | null;
  readonly rankingCensusOf?: (question: string) => readonly string[] | undefined;
};

function system(
  name: string,
  options: { readonly ranking?: (question: string) => readonly string[] | undefined } = {},
): ReportingSystem {
  let carried: string[] = [];
  let lastQuestion = '';
  const base: ReportingSystem = {
    name,
    answer: (question: string, context: string[]) => {
      lastQuestion = question;
      carried = [...context];
      // The gold text, so a question is answered correctly and the roster's `turns` are the gold turn.
      return Promise.resolve(carried[question.includes('bicycle') ? 0 : 1] ?? null);
    },
    lastRetrievedContext: () => carried,
  };
  // Spread rather than assigned unconditionally: a system without the accessor is a real configuration
  // (`product-unreported`), and a fixture that always had one could not produce that artifact.
  return options.ranking === undefined
    ? base
    : {
        ...base,
        rankingCensusOf: (question: string) =>
          question === lastQuestion ? options.ranking?.(question) : undefined,
      };
}

/** The arm's own config for a signal, so the fixture and a dispatch differ in nothing but the system. */
const configFor = (signal: string) =>
  toMemoryArmConfig(
    cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: signal }),
  );

async function arm(signal: string, feature: MemorySystem) {
  const { report } = await runCortexMemoryArm(goldDataset(), system('reference'), feature, {
    runs: 1,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: configFor(signal),
  });
  return report;
}

describe('goldAccount, as the arm records it', () => {
  it('is not written before the run, because it is a count of what happened', () => {
    // The field used to be derived from the signal alone, which was right only while the product had no
    // way to report its order. It is now written by the arm from the records -- so its absence here is the
    // statement that the configuration cannot know, and `runCortexMemoryArm` is the only writer.
    for (const signal of ['none', 'retrieval', 'self-index']) {
      expect('goldAccount' in configFor(signal)).toBe(false);
    }
  });

  it('names the product as the reporter when the product’s ranking reached the records', async () => {
    const report = await arm(
      'self-index',
      system('cortex-memory', { ranking: () => [GOLD_A, GOLD_B, FILLER] }),
    );
    expect(report.memoryArmConfig?.goldAccount).toBe('product-reported');
    // And the reading is real rather than a label: `goldRanks` exists, so `-1` means "never surfaced".
    const ranks = (report.questions ?? []).map((record) => record.goldOverlap?.goldRanks);
    expect(ranks).toEqual([[0], [1]]);
  });

  it('says the account is blind when the product reported no order', async () => {
    // The state every archived artifact of this campaign is in, and the one the field has to keep naming:
    // a `self-index` run whose product exposes nothing still cannot distinguish the two readings.
    const report = await arm('self-index', system('cortex-memory'));
    expect(report.memoryArmConfig?.goldAccount).toBe('product-unreported');
    expect((report.questions ?? [])[0]?.goldOverlap?.goldRanks).toBeUndefined();
  });

  it('names the harness when the harness built the pool, and nothing when nothing ranked', async () => {
    expect((await arm('retrieval', system('cortex-memory'))).memoryArmConfig?.goldAccount).toBe(
      'ranked',
    );
    expect((await arm('none', system('cortex-memory'))).memoryArmConfig?.goldAccount).toBe('none');
  });

  it('reads an accessor that answers nothing as no report, not as an empty ranking', async () => {
    // The product's accessor is bound to a question, so a mismatch is `undefined` -- and `undefined` has to
    // reach the record as `null` ("cannot say") rather than as `[]` ("ranked and offered nothing"), which is
    // the difference between an instrument limit and a retrieval finding.
    const report = await arm('self-index', system('cortex-memory', { ranking: () => undefined }));
    expect(report.memoryArmConfig?.goldAccount).toBe('product-unreported');
    expect((report.questions ?? [])[0]?.goldOverlap?.goldRanks).toBeUndefined();
  });

  it('is counted per run, so a product that reports on one question and not another still reads as reporting', async () => {
    // `reportedPools > 0` rather than `=== questions.length`: a partial report still makes `-1` readable on
    // the questions it covers, and a field that demanded perfection would delete the reading it exists for.
    let asked = 0;
    const feature = system('cortex-memory', {
      ranking: () => {
        asked += 1;
        return asked === 1 ? [GOLD_A, GOLD_B, FILLER] : [];
      },
    });
    const report = await arm('self-index', feature);
    expect(report.memoryArmConfig?.goldAccount).toBe('product-reported');
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
        memoryArmConfig: configFor('self-index'),
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

  it('says the gold account is blind when the record says so', async () => {
    // Built by hand here, because the renderer's job is to describe a record: the arm test above is what
    // proves which record the arm writes.
    const report = await run();
    const rendered = formatAblationReport({
      ...report,
      memoryArmConfig: { ...report.memoryArmConfig!, goldAccount: 'product-unreported' },
    });
    expect(rendered).toContain('`goldAccount=product-unreported`');
    expect(rendered).toContain('The gold account is blind on this run');
  });

  it('says what a rank means when the product reported one', async () => {
    // The opposite error, and just as wrong: applying the blindness caution to an artifact that can now
    // answer the question would hide the reading this whole round exists to expose.
    const report = await run();
    const rendered = formatAblationReport({
      ...report,
      memoryArmConfig: { ...report.memoryArmConfig!, goldAccount: 'product-reported' },
    });
    expect(rendered).toContain('`goldAccount=product-reported`');
    expect(rendered).toContain('The gold account is readable on this run');
  });
});

/**
 * The arm must record **why** the feature side abstained, not only that it did.
 *
 * ## The gap these tests close
 *
 * `CortexMemoryArmResult` carried a `delta` and nothing about its provenance. A
 * `-37.20pp` delta is consistent with at least three different mechanisms:
 *
 * 1. the write gate admitted nothing, so the arm answered from no evidence;
 * 2. the retrieval gate declined the evidence it had;
 * 3. the model was consulted and declined.
 *
 * `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.10 records the cost of that
 * ambiguity. Run `37313582403` armed `retrievalThreshold: 0.25`, abstention moved
 * `+46.40pp`, and the movement was written up as the retrieval gate closing on the
 * questions the baseline had answered. **The gate had never closed once.** At
 * `sourceTrust: 0.5` with `lastAccessedAt === createdAt` the value is the
 * constant `0.5`, so every threshold at or below it is always open; all `479`
 * abstentions were the model's. Nothing in the artifact or the log could
 * contradict the reading, so it stood until the gate was probed directly and the
 * mechanism was established by hand.
 *
 * The reference CLI's report already carries a census (`decisionReasons`). The
 * arm — the only place an arming change is ever *measured* — did not. These tests
 * require the arm to carry it.
 *
 * ## Why the assertions are about absence as well as presence
 *
 * The census is read as an optional capability of the feature system, because
 * `MemorySystem`'s conformant minimum is `{ name, answer }` and every test double
 * in this repo relies on that. So half of the contract is that a system without
 * the capability produces **no field at all** — not a zeroed one. A zeroed
 * default would be indistinguishable from a run that genuinely abstained nowhere,
 * which is precisely the shape that made §10.10's wrong reading possible.
 */
import { describe, expect, it, vi } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';

import type { MemoryArmConfig } from '../report.js';
import { exactMatchScorer } from '../metrics.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
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

/**
 * Run the arm with `feature` on the feature side, and hand back the result.
 *
 * `gate` is typed as `MemoryArmConfig` rather than `typeof GATE` on purpose:
 * `GATE` is `as const`, so its `retrievalThreshold` is the literal `0` and the
 * inert-warning test -- which needs an armed gate -- would be a type error. The
 * widening is the fix, not a cast, so no test can pass a value the config type
 * does not accept.
 */
function run(feature: MemorySystem, gate: MemoryArmConfig = GATE) {
  return runCortexMemoryArm(dataset(), constantSystem('reference-pipeline', 'one'), feature, {
    runs: 1,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: { ...gate },
  });
}

/**
 * The docstring that was on `systemWithCensus`, restored with the function below.
 *
 * `MemorySystem`'s conformant minimum is `{ name, answer }`, so a system that
 * cannot attribute its abstentions must still be gradable -- which is why the
 * census is read as an optional capability rather than a required member.
 */
function systemWithCensus(payload: unknown, impl?: () => unknown): MemorySystem {
  return {
    name: 'cortex-memory',
    answer: () => 'one',
    abstentionReasons: impl ?? (() => payload),
  } as unknown as MemorySystem;
}

describe('the arm records the feature side abstention census', () => {
  it('carries the census through when the system exposes one', async () => {
    const census = { empty: 1, threshold: 2, llm: 3, answered: 494 };
    const result = await run(systemWithCensus(census));

    expect(result.abstentionReasons).toEqual(census);
  });

  it('renders the census into the Markdown, not only into the field', async () => {
    // The property §48.11.4 left open, and the reason it matters: a census in a
    // JSON field nobody renders leaves the Markdown reader with a delta and no
    // attribution -- which is the situation §10.10 was reached from. `retryFires`
    // was lost this exact way, twice.
    const census = { empty: 0, threshold: 0, llm: 479, answered: 21 };
    // The gate must be ARMED for the inert warning to be the right output, so the
    // fixture passes `retrievalThreshold: 0.25` -- the exact arming §10.10 shows
    // was inert. The default `GATE` has the identity threshold (`0`), where a zero
    // count is expected and the warning must stay silent.
    const result = await run(systemWithCensus(census), {
      ...GATE,
      retrievalThreshold: 0.25,
    });

    expect(result.markdown).toContain('Abstention reasons');
    expect(result.markdown).toMatch(/\|\s*`?llm`?\s*\|\s*479\s*\|/);
    expect(result.markdown).toContain('INERT');
  });

  it('keeps the Markdown census and the returned census in agreement', async () => {
    // The two must not be able to disagree, which is why the census is put into
    // the report before rendering rather than returned beside it. A disagreement
    // would be worse than an omission: the document and the field are both
    // evidence, and a reader cannot tell which one is wrong.
    const census = { empty: 7, threshold: 11, llm: 200, answered: 282 };
    const result = await run(systemWithCensus(census));

    expect(result.report.abstentionReasons).toEqual(census);
    expect(result.abstentionReasons).toEqual(census);
    expect(result.markdown).toMatch(/\|\s*`?threshold`?\s*\|\s*11\s*\|/);
    expect(result.markdown).toMatch(/\|\s*`?empty`?\s*\|\s*7\s*\|/);
  });

  it('calls the census once, at read time, rather than caching it at construction', async () => {
    // The count only means anything if it is read *after* the questions ran. A
    // snapshot taken when the system was built would report the state before the
    // arm -- all zeros -- which is exactly the reading that cannot distinguish
    // "no abstentions" from "not measured".
    const impl = vi.fn(() => ({ empty: 0, threshold: 0, llm: 1, answered: 0 }));
    const result = await run(systemWithCensus(undefined, impl));

    expect(impl).toHaveBeenCalled();
    expect(result.abstentionReasons).toEqual({
      empty: 0,
      threshold: 0,
      llm: 1,
      answered: 0,
    });
  });

  it('omits the field when the feature system has no census capability', async () => {
    // The conformant-minimum control. `constantSystem` is `{ name, answer }`,
    // which every other arm in this package uses, so this is the shape a
    // census-less run actually has.
    const result = await run(constantSystem('cortex-memory', 'one'));

    expect(result.abstentionReasons).toBeUndefined();
    expect('abstentionReasons' in result).toBe(false);
  });

  it('omits the field rather than fabricating one when the payload is malformed', async () => {
    // Present-but-wrong is worse than absent. A malformed payload that reached
    // the artifact would be indistinguishable from a real reading, and a reader
    // would draw a conclusion from it -- the failure mode §10.10 documents.
    const malformed: unknown[] = [
      { empty: 0, threshold: 0, llm: 0 }, // missing key
      { empty: 0, threshold: 0, llm: 0, answered: '4' }, // wrong type
      { empty: 0, threshold: 0, llm: 0, answered: -1 }, // negative
      { empty: 0, threshold: 0, llm: 0, answered: 1.5 }, // non-integer
      { empty: 0, threshold: 0, llm: 0, answered: Number.NaN }, // NaN
      { empty: 0, threshold: 0, llm: 0, answered: Number.POSITIVE_INFINITY }, // not finite
      null,
      'not an object',
      42,
    ];

    for (const payload of malformed) {
      const result = await run(systemWithCensus(payload));
      expect(result.abstentionReasons).toBeUndefined();
    }
  });

  it('still returns the measured delta when the census read throws', async () => {
    // The endpoint is measured by the time the census is read, so a broken
    // optional capability must not discard the arm's actual result. Asserted
    // because the tempting implementation -- let the throw propagate -- would
    // turn a reporting bug into a lost run, and a run here costs about an hour.
    const result = await run(
      systemWithCensus(undefined, () => {
        throw new Error('census unavailable');
      }),
    );

    expect(result.abstentionReasons).toBeUndefined();
    expect(typeof result.delta).toBe('number');
    expect(result.report.feature.name).toBe('cortex-memory');
  });

  it('does not put the baseline side census in the feature field', async () => {
    // Both sides are `MemorySystem`s and either could expose the capability. The
    // field is about the feature, so reading it from the baseline would attribute
    // the feature's abstentions to the control's mechanism and invert the very
    // conclusion §10.10 had to retract.
    const baselineCensus = { empty: 99, threshold: 99, llm: 99, answered: 99 };
    const baseline = {
      name: 'reference-pipeline',
      answer: () => 'one',
      abstentionReasons: () => baselineCensus,
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(),
      baseline,
      systemWithCensus({ empty: 0, threshold: 0, llm: 1, answered: 0 }),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.abstentionReasons).toEqual({
      empty: 0,
      threshold: 0,
      llm: 1,
      answered: 0,
    });
  });
});

describe('the arm carries per-question records into the artifact', () => {
  /**
   * The field three downstream readers were blocked on, and it was never filled.
   *
   * `AblationReport.questions` is a declared, documented optional field whose own
   * docstring names its consumers -- `tools/read-b7-criterion.mjs` cannot apply the
   * pre-registered criterion without it, `compareQuestionVectors` needs two aligned
   * correctness vectors, and a reader asking WHICH questions moved needs the ids.
   * None of them could run, because `bench-memory-arm.ts` never supplied the field.
   *
   * The value was already computed and then dropped one layer down:
   * `evaluateWithScorerDetailed` returns `{ metrics, correct }` and discards the
   * `answers` array `runBenchmark` produced. So the model's actual output for every
   * question existed during the run and was thrown away before anything could record
   * it -- the same shape as the `runs` defect, one layer lower.
   *
   * This matters to the current investigation specifically. §55.4 named reading the
   * abstention outputs as the cheapest next step, and the §12.5 artifact has no
   * `questions` field at all: 30 ABS questions declined and not one of the 30 outputs
   * survives. The fix is what makes that step possible.
   */

  it('writes a per-question record for every graded question', async () => {
    const result = await run(constantSystem('cortex-memory', 'one'));
    expect(result.report.questions).toHaveLength(1);
    expect(result.report.questions?.[0]?.questionId).toBe('q1');
  });

  it('records the answer the model actually produced, not just whether it scored', async () => {
    // The distinction the whole field exists for. A `correct` boolean cannot be read
    // for language, and the current question -- why did 30 ABS questions decline --
    // is a question about the model's TEXT. A record without `answer` would leave the
    // investigation exactly where it was.
    const result = await run(constantSystem('cortex-memory', 'Lisbon'));
    expect(result.report.questions?.[0]?.answer).toBe('Lisbon');
  });

  it('records an abstention as null rather than as a missing answer', async () => {
    // `null` is "the system abstained"; `undefined` is "nobody recorded an answer".
    // Conflating them reports a recording gap as reader behaviour, which the record
    // type's own docstring singles out.
    const result = await run(constantSystem('cortex-memory', null));
    const record = result.report.questions?.[0];
    expect(record?.answer).toBeNull();
  });

  it('records the question text and its gold, so a record is readable alone', async () => {
    const result = await run(constantSystem('cortex-memory', 'one'));
    const record = result.report.questions?.[0];
    expect(record?.question).toBe('Question one?');
    expect(record?.groundTruth).toBe('one');
    expect(record?.capability).toBe('IE');
  });

  it('agrees with the correctness vector the paired tables were built from', async () => {
    // The record list and `featureCorrect` describe one run, so a reader must not be
    // able to find them disagreeing. This is the alignment failure `buildQuestionRecords`
    // throws on, asserted at the artifact level where a reader would meet it.
    const result = await run(constantSystem('cortex-memory', 'one'));
    const records = result.report.questions ?? [];
    expect(records.map((q) => q.correct)).toEqual(
      result.report.ablation.featureCorrect.slice(0, records.length),
    );
  });

  it('keeps an abstention a value, not a hole, in the record it writes', async () => {
    // `null` is "the system abstained"; a missing `answer` is "nobody recorded
    // one". The record type's docstring draws that line and the criterion has a
    // branch for the first and none for the second, so an arm that wrote
    // `undefined` for an abstention would report the model's behaviour as a
    // recording gap -- inverting the finding a reader is looking for.
    const result = await run(constantSystem('cortex-memory', null));
    const record = result.report.questions?.[0];
    expect('answer' in (record ?? {})).toBe(true);
    expect(record?.answer).toBeNull();
  });

  it('records the gold question text and capability, so a record reads alone', async () => {
    // A record has to be interpretable without the dataset: §20 recorded an A/B whose
    // two arms differed by two questions and whose artifacts could not name them, and a
    // roster that carried only ids would leave a reader exactly as stuck.
    const result = await run(constantSystem('cortex-memory', 'one'));
    const record = result.report.questions?.[0];
    expect(record?.question).toBe('Question one?');
    expect(record?.groundTruth).toBe('one');
    expect(record?.capability).toBe('IE');
  });

  it('reports the evidence it did not collect as absent rather than as grounded', async () => {
    // `grounded` is a property of the retrieval trace, and this arm collects none.
    // `false` is the honest value and it is load-bearing: B7 excludes an ungrounded
    // question before clustering, so a fabricated `true` would admit a question no
    // trace supports into the criterion's target set. `turns` is empty for the same
    // reason -- an empty split is a statement, and it is the true one here.
    const result = await run(constantSystem('cortex-memory', 'one'));
    const record = result.report.questions?.[0];
    expect(record?.grounded).toBe(false);
    expect(record?.turns).toEqual([]);
  });
});

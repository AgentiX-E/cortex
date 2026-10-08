/**
 * The abstention census must reach the artifact a reader actually opens.
 *
 * ## What was left open
 *
 * §48.11.4 of `docs/09-progress-and-delivery-report.md` added the census to the
 * arm: `CortexMemory.abstentionReasons()` is read by `runCortexMemoryArm` and
 * written into the arm's JSON, and the arm CLI prints it. What it did **not** do
 * is render it in the Markdown report.
 *
 * That is the defect this file closes, and it is the third instance of a pattern
 * this repository has already paid for twice -- `cohortCoverage` (`0e2c30e`) and
 * `retryFires` (`report-retry-fires.test.ts`). Both were computed correctly,
 * returned beside the report, and then lost on the path to the reader. The stated
 * fix both times was to carry the value **in the report** so no renderer can
 * produce the document without it.
 *
 * ## Why a census in JSON is not enough
 *
 * The Markdown is what a reader opens. §10.10's failure was exactly a reader
 * reaching a conclusion from the ablation tables alone -- `43.80%` against
 * `6.60%` -- that the census would have contradicted at a glance. Persisting the
 * census to a field nobody renders leaves the tables just as ambiguous as before:
 * a delta with no attribution.
 *
 * ## What the section has to say, and why each fact is load-bearing
 *
 * - **The counts themselves**, so `threshold` and `llm` can be told apart. That
 *   distinction is the whole point: `threshold` means the arming declined,
 *   `llm` means the model did, and only one of them is a statement about the gate.
 * - **A machine-derived share**, because §10.10's reading was wrong by
 *   *attribution*, not by arithmetic. A share makes the attribution explicit
 *   rather than inferable.
 * - **An INERT warning when `threshold` is zero while the gate is armed**, which
 *   is precisely the condition that produced the wrong write-up. When the gate is
 *   configured to close and its census says it never did, the report must say so
 *   rather than leaving the reader to notice it.
 */
import { describe, expect, it } from 'vitest';

import { formatAblationReport, type AblationReport, type AbstentionReasons } from '../report.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(): Metrics {
  return {
    total: 60,
    correct: 51,
    accuracy: 0.85,
    abstentionRate: 0.15,
    abstentionCorrectRate: 0.8888888888888888,
    abstentionAwareAccuracy: 0.85,
    perCapability: {
      IE: { total: 26, correct: 23, accuracy: 0.8846153846153846, abstained: 2 },
      MR: { total: 9, correct: 8, accuracy: 0.8888888888888888, abstained: 1 },
      KU: { total: 8, correct: 5, accuracy: 0.625, abstained: 2 },
      TR: { total: 8, correct: 6, accuracy: 0.75, abstained: 1 },
      ABS: { total: 9, correct: 9, accuracy: 1, abstained: 9 },
    },
  };
}

function paired(total: number): PerCapabilityPairedStats {
  return {
    total,
    baselineCorrect: total,
    featureCorrect: total,
    baselineCorrectFeatureIncorrect: 0,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
  };
}

/**
 * A cortex-memory-arm report with a census, spread in exactly as the arm writes
 * it. The gate is armed at `retrievalThreshold: 0.25`, which is the
 * configuration §10.10 showed was inert.
 */
function persistedCensusReport(
  census: AbstentionReasons,
  retrievalThreshold = 0.25,
  runs: number = FIXTURE_RUNS,
): AblationReport & { abstentionReasons: unknown } {
  const ablation: AblationResult = {
    feature: 'cortex-memory',
    baselineAggregate: { min: 0.44, max: 0.44, avg: 0.44, median: 0.44 },
    featureAggregate: { min: 0.07, max: 0.07, avg: 0.07, median: 0.07 },
    delta: -0.37,
    pValue: Number.NaN,
    significant: false,
    effectSize: Number.NEGATIVE_INFINITY,
    baselineConfidence: { lower: 0.4, upper: 0.48 },
    featureConfidence: { lower: 0.05, upper: 0.1 },
    mcnemarPValue: 2.039e-56,
    mcnemarSignificant: true,
    discordant: { baselineCorrectFeatureIncorrect: 186, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: [],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: metrics(),
    featureMetrics: metrics(),
    featureCorrect: Array.from({ length: 60 }, () => true),
    perCapability: Object.fromEntries(
      CAPABILITIES.map((c) => [c, paired(c === 'MR' ? 9 : 8)]),
    ) as Record<Capability, PerCapabilityPairedStats>,
  };
  return {
    dataset: 'longmemeval-s',
    questionCount: 500,
    baseline: { name: 'reference-pipeline', metrics: metrics() },
    feature: { name: 'cortex-memory', metrics: metrics() },
    ablation,
    generatedAt: '2026-10-05T13:00:00.000Z',
    memoryArmConfig: {
      threshold: 0,
      retrievalThreshold,
      sessionBudget: null,
      sourceTrust: 0.5,
      confidenceSignal: 'none',
      promptContract: 'abstention',
    },
    runs,
    abstentionReasons: census,
  };
}

/**
 * Runs the fixture was accumulated over.
 *
 * `4` is the arm's dispatched default and the value §12.5 ran with. It matters to
 * the census assertions because the tally counts CALLS: `30` questions x `4` runs
 * is the `120` the artifact published. A fixture that defaulted to `1` would make
 * every multi-run assertion vacuous.
 */
const FIXTURE_RUNS = 4;

describe('the abstention census survives into the rendered report', () => {
  it('renders the census table from the report object alone', () => {
    // The defect: `formatAblationReport` did not know about the census, so a
    // consumer holding the report -- or the report re-read from JSON -- got the
    // ablation tables with no attribution at all.
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 479, answered: 21 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md).toContain('Abstention reasons');
    expect(md).toContain('threshold');
    expect(md).toContain('llm');
  });

  it('separates a model decline from a gate decline', () => {
    // The distinction §10.10 turned on. Both render, with their own counts.
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 479, answered: 21 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md).toMatch(/\|\s*`?llm`?\s*\|\s*479\s*\|/);
    expect(md).toMatch(/\|\s*`?threshold`?\s*\|\s*0\s*\|/);
  });

  it('reports the machine-derived share separately from the model-side share', () => {
    // §10.10's reading was wrong by attribution while its arithmetic was correct,
    // so the renderer must make the attribution explicit. `empty` + `threshold`
    // are machine-derived; `llm` is the model's.
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 10, threshold: 90, llm: 400, answered: 0 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    // 100 of 500 machine-derived, 400 model-side.
    expect(md).toContain('20.00%');
    expect(md).toContain('80.00%');
  });

  it('warns when the gate is armed and never closed', () => {
    // The exact condition that produced the wrong write-up: an armed retrieval
    // gate whose census shows it declined nothing. The reader should not have to
    // cross-reference the config line against the census to notice it.
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 479, answered: 21 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md).toContain('INERT');
    expect(md).toMatch(/0\.25|0\.2500|25\.00%/);
  });

  it('does not warn when the gate was configured open by design', () => {
    // `retrievalThreshold: 0` means "answer whenever anything was admitted", which
    // is the identity configuration -- a zero `threshold` count there is expected,
    // not inert. Warning on it would train readers to ignore the warning.
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 479, answered: 21 }, 0)),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md).toContain('Abstention reasons');
    expect(md).not.toContain('INERT');
  });

  it('does not warn when the gate actually closed some questions', () => {
    // The control for the warning: an armed gate that did close is working, so the
    // inert warning must not fire. Without this, an unconditional warning would
    // satisfy the test above.
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 42, llm: 437, answered: 21 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md).toContain('Abstention reasons');
    expect(md).not.toContain('INERT');
  });

  it('omits the section entirely for arms with no census', () => {
    // The reference-pipeline arms and the rerank arms carry no census, and must
    // not grow an empty table. This is why the field is optional rather than
    // defaulted -- a zeroed census is indistinguishable from "not measured".
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 1, answered: 1 })),
    ) as Record<string, unknown>;
    delete report['abstentionReasons'];
    const md = formatAblationReport(report as unknown as AblationReport);

    expect(md).not.toContain('Abstention reasons');
  });

  it('renders an all-zero census without dividing by zero', () => {
    // A real case, not a defensive one: an arm whose feature system never entered
    // the abstention path reports four zeros, and every share must render as
    // `0.00%` rather than `NaN%`. `NaN` in the table would be the kind of
    // unreadable number this section exists to remove -- and it would appear
    // precisely when a reader is asking "did the path run at all".
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 0, answered: 0 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md).toContain('Abstention reasons');
    expect(md).toContain('0.00%');
    expect(md).not.toContain('NaN');
    expect(md).toContain('Total: **0** calls');
  });

  it('keeps the census below the ablation tables, since it explains them', () => {
    // Ordering is deliberate, and the precedent is `retryFires`: a section that
    // qualifies or explains the numbers goes below them, while one that changes
    // what they mean (the cohort banner) goes above. The census explains a
    // delta's attribution, so it is a footnote to the tables.
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 479, answered: 21 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md.indexOf('## Ablation')).toBeLessThan(md.indexOf('Abstention reasons'));
  });
});

describe('the census counts CALLS, and the report must not call them questions', () => {
  /**
   * The defect this block closes, found by reading the §12.5 artifact against the
   * code that produced it.
   *
   * `CortexMemory.#reasons` is an instance-level accumulator: it counts every call
   * to `answerAbstention`. The arm reuses ONE instance across `runs` repetitions,
   * so the tally is `questions x runs`, not `questions`. §12.5 dispatched with
   * `ablation_runs = 4` over a dataset whose `ABS` capability holds 30 questions
   * and the census reported **120** -- exactly `30 x 4`.
   *
   * The product-side semantics are correct and stay: a memory instance asked N
   * times should count N. What was wrong is the RENDERER, which labelled the total
   * "questions through the abstention path". In a multi-run arm that label is a
   * false statement about the artifact -- the same class as §10.10, where the
   * artifact could not contradict a wrong reading.
   *
   * The fix is not to divide. Dividing would need the renderer to know that every
   * question was asked exactly `runs` times, which the census cannot verify and
   * which stops being true the moment a run is interrupted. The fix is to name
   * what the number is and to publish the divisor beside it, so a reader can do
   * the division and can see which quantity each figure belongs to.
   */

  it('does not claim the census total is a question count', () => {
    const report = JSON.parse(
      JSON.stringify(persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 })),
    ) as AblationReport;
    const md = formatAblationReport(report);

    expect(md).not.toContain('questions through the abstention path');
  });

  it('says the total is a call count, and names the runs it was accumulated over', () => {
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    expect(md).toMatch(/call/i);
    expect(md).toMatch(/run/i);
  });

  it('reports the per-run figure so a reader can compare it against the capability table', () => {
    // 30 ABS questions x 4 runs = the 120 the §12.5 artifact published. Dividing
    // by the run count recovers the 30 that `perCapability.ABS.total` also says,
    // and THAT agreement is what makes the census checkable against the tables
    // rendered above it. Without the divisor a reader has two numbers (120 and 30)
    // describing one thing and no way to reconcile them.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    expect(md).toContain('30');
  });

  it('states no per-run breakdown when the run count is one', () => {
    // The control. With `runs = 1` the two quantities coincide, so a per-run block
    // would restate every row of the table above it -- noise dressed as a caveat.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 30, answered: 0 }, 0.25, 1);
    const md = formatAblationReport(report);

    expect(md).toContain('Abstention reasons');
    expect(md).toMatch(/\|\s*`?llm`?\s*\|\s*30\s*\|/);
    expect(md).not.toContain('Accumulated over');
  });
});

describe('the census must state the one route it measures', () => {
  /**
   * The table reads as a census of the run. It is a census of one route.
   *
   * `CortexMemory.#reasons` is written only inside `answerAbstention`, and
   * `runBenchmark` dispatches `answerAbstention` only for `capability === 'ABS'`.
   * A decline on the session, temporal, assistant, preference or knowledge-update
   * route never reaches these counters.
   *
   * §55 read §12.5's `llm = 120` as "the model declined 120 times" and §55.4 made
   * the next investigation "read the 30 ABS outputs for a common decline pattern".
   * Both are wrong: `30 ABS questions x 4 runs = 120` exactly, ABS gold IS
   * abstention, and ABS scored **30/30 correct**. The artifact's own capability
   * table said `ABS: total=30 base=30 feat=30 b+f-=0`, so the 120 were the
   * capability PASSING. The real loss -- 449 of 470 non-ABS questions abstained --
   * is invisible to this table, and nothing in the document said so.
   *
   * The scope line is what stops the next reader from repeating it. It is asserted
   * on the RENDERED output rather than on the source, because the reader meets the
   * rendering: a comment in the renderer would not have helped §55 either.
   */

  it('names the abstention route as the scope, and says it is not the arm', () => {
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    expect(md).toContain('Scope: the **abstention route only**');
    expect(md).toContain('`answerAbstention`');
    expect(md).toContain('`ABS`');
    // The load-bearing half: a reader must not take this table for the arm.
    expect(md).toContain('this table does not describe the arm');
    // And a decline elsewhere must be stated as uncounted, not merely absent.
    expect(md).toContain('**not** counted here');
  });

  it('puts the scope before the table, so it is read as a qualifier rather than a footnote', () => {
    // A caveat below the numbers is read after the reader has already formed the
    // wrong impression. The §55 misreading formed from the NUMBERS, so the
    // qualifier has to precede them.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    const scope = md.indexOf('Scope: the **abstention route only**');
    const header = md.indexOf('| Reason | Count | Share | Decided by |');
    expect(scope).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(header);
  });

  it('points the reader at the capability row the numbers can actually be checked against', () => {
    // The scope line is only useful if it says where to look instead. `ABS` is the
    // row this census is commensurate with, and `30 x runs` is what its total
    // should reproduce.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    expect(md).toContain('Read it against the `ABS` row of the capability table.');
  });
});

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
    expect(md).toContain('Total: **0** questions that reached a decision');
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

  it('prints an exact per-run figure when the total divides evenly', () => {
    // The census total is a CALL count accumulated across `runs`, and the per-run figure
    // is how a reader reconciles it with the capability table. When the division is exact
    // the number is stated plainly; when it is not, it is marked approximate with a `~`.
    // Both branches of that choice are asserted, with different fixtures, because a
    // renderer that always took one path would pass a test that only exercised the other.
    const report = persistedCensusReport(
      { empty: 0, threshold: 0, llm: 120, answered: 0 },
      0.25,
      4,
    );
    const md = formatAblationReport(report);

    expect(md).toContain('Accumulated over **4 runs** of 30 questions each');
    // No `~` on an exact division: the tilde means "the run count does not divide the
    // total", and printing it here would misreport a figure that is exact.
    expect(md).not.toContain('~30');
  });

  it('marks the per-run figure approximate when the total does not divide evenly', () => {
    // 121 calls over 4 runs is 30.25 per run. The `~` is the difference between a
    // derived figure and a measured one, and a reader comparing it against the
    // capability table needs to know which they have.
    const report = persistedCensusReport(
      { empty: 0, threshold: 0, llm: 121, answered: 0 },
      0.25,
      4,
    );
    const md = formatAblationReport(report);

    expect(md).toContain('~30.3');
  });
});

describe('the census must state the scope it measures, which is now the run', () => {
  /**
   * The table reads as a census of the run, and that is now true -- it was not.
   *
   * `CortexMemory.#reasons` used to be written only inside `answerAbstention`, and
   * `runBenchmark` dispatches `answerAbstention` only for `capability === 'ABS'`.
   * A decline on the session, temporal, assistant, preference or knowledge-update
   * route never reached the counters.
   *
   * §55 read §12.5's `llm = 120` as "the model declined 120 times" and §55.4 made
   * the next investigation "read the 30 ABS outputs for a common decline pattern".
   * Both are wrong: `30 ABS questions x 4 runs = 120` exactly, ABS gold IS
   * abstention, and ABS scored **30/30 correct**. The artifact's own capability
   * table said `ABS: total=30 base=30 feat=30 b+f-=0`, so the 120 were the
   * capability PASSING.
   *
   * §58 fixed the READING by naming the narrow scope here, and deliberately left
   * the counter alone. §13 is what made the narrow counter untenable: MR `13 -> 0`
   * and TR `16 -> 0` with `b-f+ = 0`, every decline on a route the census did not
   * cover, and no other field able to say which route declined. So the counter was
   * widened and this line was rewritten to match it.
   *
   * The one thing that is still not run-wide is `threshold`, and it is named
   * explicitly rather than left for the reader to infer from a `0` that means
   * "no gate exists here" on six of the seven routes.
   *
   * The scope line is what stops the next reader from repeating §55. It is
   * asserted on the RENDERED output rather than on the source, because the reader
   * meets the rendering: a comment in the renderer would not have helped §55.
   */

  it('names every route as the scope, and states the one key that is not run-wide', () => {
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    expect(md).toContain('Scope: **every route that can decline**');
    // The routes, named rather than summarised, so a reader can map the table onto
    // the capability table without guessing which ones were included.
    expect(md).toContain('session');
    expect(md).toContain('temporal');
    expect(md).toContain('knowledge-update');
    // The exception, which is the part a reader cannot infer. `threshold` is
    // reachable only where the gate is called, and this says so.
    expect(md).toContain('`threshold` is reachable only on the abstention route');
    expect(md).toContain('not because the gate stayed open');
    // And the history, because the line exists to stop that reading recurring.
    expect(md).toContain('`llm =');
  });

  it('puts the scope before the table, so it is read as a qualifier rather than a footnote', () => {
    // A caveat below the numbers is read after the reader has already formed the
    // wrong impression. The §55 misreading formed from the NUMBERS, so the
    // qualifier has to precede them. Rewriting the scope did not relax this.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    const scope = md.indexOf('Scope: **every route that can decline**');
    const header = md.indexOf('| Reason | Count | Share | Decided by |');
    expect(scope).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(header);
  });

  it('marks the one row whose count is not comparable across routes', () => {
    // The `threshold` row carries the exception at the point of reading, so a
    // reader comparing rows does not conclude the gate was open on six routes. The
    // scope line states the rule; this states it where the number is.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    expect(md).toContain('retrieval gate closed; abstention route only');
  });

  it('calls the total a count of questions rather than of one path', () => {
    // The unit used to read "calls through the abstention path", which named the
    // population this census no longer measures. A unit that names the wrong
    // population is the same defect one layer up from the count itself.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    expect(md).toContain('questions that reached a decision');
    expect(md).not.toContain('abstention path');
  });

  it('renders the widened scope as one line, so the section is still scannable', () => {
    // The scope line carries more now than it did, and the failure mode of a long
    // qualifier is that it stops being read at all. Pinned as a single quoted
    // blockquote line immediately above the table rather than as prose: the extra
    // content is the exception on `threshold`, and it has to stay legible enough
    // that a reader still reads it.
    const report = persistedCensusReport({ empty: 0, threshold: 0, llm: 120, answered: 0 });
    const md = formatAblationReport(report);

    const scopeLines = md.split('\n').filter((l) => l.startsWith('> Scope:'));
    expect(scopeLines).toHaveLength(1);
    expect(scopeLines[0]!.startsWith('> Scope: **every route that can decline**')).toBe(true);
  });
});

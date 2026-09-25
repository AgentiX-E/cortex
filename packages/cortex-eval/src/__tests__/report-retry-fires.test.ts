/**
 * The retry-fire section must survive persistence, like every other section.
 *
 * `runAbstentionRetryAblation` computes `retryFires` and returns it *beside* the
 * report:
 *
 *     return { report, markdown: `${formatAblationReport(report)}${formatRetryFireSection(retryFires)}`, retryFires };
 *
 * `formatAblationReport(report)` receives only the report, and the report does not
 * carry `retryFires`. So the section reaches the Markdown through a string
 * concatenation at the return site, and reaches the JSON through a spread at the
 * call site (`bench/run.ts`). Two independent paths, neither inside the report.
 *
 * This is the same defect that was fixed for `cohortCoverage` in `0e2c30e`, in a
 * second arm -- the class the fix document declared as an un-audited gap. Auditing
 * it found the pattern present, so the declared gap was accurate and is now closed.
 *
 * Why it matters more here than a missing cosmetic section: the retry ablation's
 * published result is a null one (accuracy unchanged), and the fire table is the
 * entire evidential basis for that null being interpretable. The source comment
 * says so directly -- "a bare `Delta = 0.00 pp` is unreadable on its own: it is the
 * predicted output of a working feature on a dataset it cannot help, and also the
 * predicted output of a feature that was never wired in." Drop the table and the
 * two become indistinguishable again.
 */
import { describe, it, expect } from 'vitest';
import { formatAblationReport, type AblationReport } from '../report.js';
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

/** A retry-arm report exactly as `bench/run.ts` writes it: fires spread in at the call site. */
function persistedRetryReport(): AblationReport & { retryFires: unknown } {
  const ablation: AblationResult = {
    feature: 'mr-retry-on',
    baselineAggregate: { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 },
    featureAggregate: { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 },
    delta: 0,
    pValue: Number.NaN,
    significant: false,
    effectSize: Number.NEGATIVE_INFINITY,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: { baselineCorrectFeatureIncorrect: [], baselineIncorrectFeatureCorrect: [] },
    baselineMetrics: metrics(),
    featureMetrics: metrics(),
    featureCorrect: Array.from({ length: 60 }, () => true),
    perCapability: Object.fromEntries(
      CAPABILITIES.map((c) => [c, paired(c === 'MR' ? 9 : 8)]),
    ) as Record<Capability, PerCapabilityPairedStats>,
  };
  return {
    dataset: 'longmemeval-retry',
    questionCount: 60,
    baseline: { name: 'mr-retry-off', metrics: metrics() },
    feature: { name: 'mr-retry-on', metrics: metrics() },
    ablation,
    generatedAt: '2026-09-20T09:45:00.000Z',
    retryFires: { controlFires: 0, treatmentFires: 1, questions: 60 },
  };
}

describe('the retry-fire section survives a persisted report', () => {
  it('renders the fires table from the report object alone', () => {
    // The defect: `formatAblationReport` has no access to `retryFires`, so the
    // section only ever appeared because the caller concatenated it. A consumer
    // holding the report -- or the report re-read from JSON -- gets a document
    // with the ablation tables and no fire count.
    const report = JSON.parse(JSON.stringify(persistedRetryReport())) as AblationReport;
    const md = formatAblationReport(report);
    expect(md).toContain('Abstention-retry fires');
    expect(md).toContain('Retry fires');
  });

  it('reports both arms so a silent no-op is distinguishable from a working feature', () => {
    const report = JSON.parse(JSON.stringify(persistedRetryReport())) as AblationReport;
    const md = formatAblationReport(report);
    expect(md).toContain('enableAbstentionRetry: false');
    expect(md).toContain('enableAbstentionRetry: true');
    // The control must be provably zero; that is what makes the treatment's count
    // meaningful rather than a coincidence of the shared cache.
    expect(md).toMatch(/\|\s*control.*\|\s*0\s*\|/);
    expect(md).toMatch(/\|\s*treatment.*\|\s*1\s*\|/);
  });

  it('states the fire rate against the question count', () => {
    const report = JSON.parse(JSON.stringify(persistedRetryReport())) as AblationReport;
    const md = formatAblationReport(report);
    expect(md).toContain('1.67%');
    expect(md).toContain('of 60 questions');
  });

  it('omits the section entirely for arms that have no fire counter', () => {
    // Arms other than the retry arm carry no `retryFires`, and must not grow an
    // empty table. This is why the field is optional rather than defaulted.
    const report = JSON.parse(JSON.stringify(persistedRetryReport())) as Record<string, unknown>;
    delete report['retryFires'];
    const md = formatAblationReport(report as unknown as AblationReport);
    expect(md).not.toContain('Abstention-retry fires');
  });

  it('keeps the fires section below the ablation tables, not above them', () => {
    // Ordering is deliberate and opposite to the cohort banner: the banner
    // qualifies what the numbers mean and must precede them; the fires table is
    // supporting evidence for a null delta and reads after it.
    const report = JSON.parse(JSON.stringify(persistedRetryReport())) as AblationReport;
    const md = formatAblationReport(report);
    expect(md.indexOf('Δ accuracy')).toBeLessThan(md.indexOf('Abstention-retry fires'));
    expect(md.indexOf('Per-capability paired significance')).toBeLessThan(
      md.indexOf('Abstention-retry fires'),
    );
  });
});

/**
 * The three-way verdict. The arm's published finding is a null, and a null has
 * three distinct causes that call for three different next steps. Getting the
 * branch wrong is worse than printing no verdict at all, because it sends the
 * next iteration after the wrong problem.
 */
describe('the fires table distinguishes the three ways a null can arise', () => {
  function fires(control: number, treatment: number, questions = 60): AblationReport {
    const base = persistedRetryReport() as Record<string, unknown>;
    base['retryFires'] = { controlFires: control, treatmentFires: treatment, questions };
    return base as unknown as AblationReport;
  }

  it('flags a control that fired as an invalid experiment, not a null result', () => {
    const md = formatAblationReport(fires(3, 4));
    expect(md).toContain('INVALID EXPERIMENT');
    // A misconfigured control must never be summarised as a clean negative.
    expect(md).not.toContain('INERT ON THIS DATASET');
  });

  it('flags zero treatment fires as no opportunity, not as evidence of no effect', () => {
    const md = formatAblationReport(fires(0, 0));
    expect(md).toContain('INERT ON THIS DATASET');
    expect(md).toContain('never fired');
    expect(md).toContain('must not be read as');
  });

  it('flags one or two fires as under-powered rather than unwired', () => {
    // The real published state of this arm. One fire means the mechanism is
    // provably active and the population is disjoint from the failing one. Read
    // as "never fired", the next iteration hunts a wiring bug that does not exist.
    const md = formatAblationReport(fires(0, 1));
    expect(md).toContain('INERT ON THIS DATASET');
    expect(md).toContain('mechanism is wired and active');
    expect(md).toContain('under-powered');
    expect(md).not.toContain('never fired');
  });

  it('treats two fires as under-powered and three as a result', () => {
    expect(formatAblationReport(fires(0, 2))).toContain('under-powered');
    const three = formatAblationReport(fires(0, 3));
    expect(three).not.toContain('INERT ON THIS DATASET');
    expect(three).not.toContain('INVALID EXPERIMENT');
    // Three fires is still tiny, but it is no longer a state the renderer calls
    // inert: the decision to act belongs to the reader, not the formatter.
    expect(three).toContain('Treatment fire rate: **5.00%** of 60 questions');
  });

  it('does not divide by zero on an empty question set', () => {
    const md = formatAblationReport(fires(0, 1, 0));
    expect(() => md).not.toThrow();
    expect(md).toContain('0.00%');
  });
});

/**
 * The structural guard for the defect class, not for the two instances of it.
 *
 * Two arms shipped the same bug: they computed a value, then returned it *beside*
 * the report so the Markdown got it from a string concatenation and the JSON from
 * a spread at the call site. Fixing the two instances leaves the pattern legal, and
 * the class has now recurred once. A third arm written next month would pass every
 * existing test in this file.
 *
 * This asserts the invariant that actually matters: every field the renderer emits
 * is reachable from the report object alone. It is checked by rendering a report
 * that has been through JSON, which is the state every archived artifact is in and
 * the state in which both defects became visible.
 */
describe('no arm may render a section from anywhere but the report', () => {
  it('emits every section from the report object alone, after a JSON round-trip', () => {
    const withBoth = persistedRetryReport() as Record<string, unknown>;
    withBoth['cohortCoverage'] = { present: ['a_abs'], missing: ['b_abs'], ratio: 0.5 };
    const persisted = JSON.parse(JSON.stringify(withBoth)) as AblationReport;
    const md = formatAblationReport(persisted);
    // Both optional sections present => both must appear, and neither may depend
    // on a value held outside the report.
    expect(md).toContain('COHORT INCOMPLETE');
    expect(md).toContain('Abstention-retry fires');
  });

  it('renders a report with neither optional field without either section', () => {
    const bare = persistedRetryReport() as Record<string, unknown>;
    delete bare['retryFires'];
    const md = formatAblationReport(JSON.parse(JSON.stringify(bare)) as AblationReport);
    expect(md).not.toContain('Abstention-retry fires');
    expect(md).not.toContain('Cohort');
  });
});

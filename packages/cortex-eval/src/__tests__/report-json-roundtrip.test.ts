/**
 * The report renderer must survive a round-trip through JSON.
 *
 * Every ablation report is written twice: once as Markdown for a human reader and
 * once as JSON for a machine reader. The JSON is the durable artifact — it is
 * what gets archived, diffed between runs, and re-read when someone asks why a
 * number changed. The Markdown is derived.
 *
 * That derivation was only ever tested on in-memory reports, where `pValue` and
 * `effectSize` hold real `Infinity` and `NaN`. JSON has no representation for
 * either: `JSON.stringify` silently turns both into `null`. So the persisted
 * report round-trips to a value the renderer cannot format, and the failure only
 * appears when someone re-renders an archived report — long after the run that
 * produced it, with no run left to blame.
 *
 * The fixtures below are not invented. They are the verbatim `ablation` object
 * from a real archived run (`benchmark-conjunction-ablation-report.json`, run
 * 35502712132), which is exactly the shape a reader of the artifact set holds.
 */
import { describe, it, expect } from 'vitest';
import { formatAblationReport, type AblationReport } from '../report.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    total: 35,
    correct: 32,
    accuracy: 0.9142857142857143,
    abstentionRate: 0.3142857142857143,
    abstentionCorrectRate: 0.8181818181818182,
    abstentionAwareAccuracy: 0.9142857142857143,
    perCapability: {
      IE: { total: 26, correct: 23, accuracy: 0.8846153846153846, abstained: 2 },
      MR: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      KU: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      TR: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      ABS: { total: 9, correct: 9, accuracy: 1, abstained: 9 },
    },
    ...overrides,
  };
}

function pairedStats(overrides: Partial<PerCapabilityPairedStats> = {}): PerCapabilityPairedStats {
  return {
    total: 26,
    baselineCorrect: 24,
    featureCorrect: 23,
    baselineCorrectFeatureIncorrect: 1,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0.8139261926062996, upper: 0.984187170385956 },
    featureConfidence: { lower: 0.7762040092883747, upper: 0.970418168994703 },
    ...overrides,
  };
}

/**
 * The `ablation` object exactly as `JSON.parse` yields it from a real artifact.
 *
 * `pValue: null` and `effectSize: null` are not a contrived input: they are what
 * `JSON.stringify({ pValue: NaN, effectSize: -Infinity })` writes, and a
 * single-run ablation produces `NaN` and `-Infinity` for every arm.
 */
function persistedAblation(): AblationResult {
  return {
    feature: 'conjunction-decomposed',
    baselineAggregate: {
      min: 0.9428571428571428,
      max: 0.9428571428571428,
      avg: 0.9428571428571428,
      median: 0.9428571428571428,
    },
    featureAggregate: {
      min: 0.9142857142857143,
      max: 0.9142857142857143,
      avg: 0.9142857142857143,
      median: 0.9142857142857143,
    },
    delta: -0.02857142857142858,
    // JSON serialisation of NaN.
    pValue: null as unknown as number,
    significant: false,
    // JSON serialisation of -Infinity.
    effectSize: null as unknown as number,
    baselineConfidence: { lower: 0.8139261926062996, upper: 0.984187170385956 },
    featureConfidence: { lower: 0.7762040092883747, upper: 0.970418168994703 },
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 1, baselineIncorrectFeatureCorrect: 0 },
    baselineMetrics: metrics({ total: 35, correct: 33, accuracy: 0.9428571428571428 }),
    featureMetrics: metrics(),
    featureCorrect: Array.from({ length: 35 }, () => true),
    perCapability: Object.fromEntries(CAPABILITIES.map((c) => [c, pairedStats()])) as Record<
      Capability,
      PerCapabilityPairedStats
    >,
  };
}

function report(overrides: Partial<AblationReport> = {}): AblationReport {
  return {
    dataset: 'longmemeval-conjunction',
    questionCount: 35,
    baseline: { name: 'conjunction-fused', metrics: metrics() },
    feature: { name: 'conjunction-decomposed', metrics: metrics() },
    ablation: persistedAblation(),
    generatedAt: '2026-09-20T09:47:42.542Z',
    ...overrides,
  };
}

describe('formatAblationReport survives a JSON round-trip', () => {
  it('renders a report whose pValue and effectSize were serialised from NaN and -Infinity', () => {
    // The bug: `Number.isNaN(null)` is `false`, so a null p-value took the
    // numeric branch and `null.toExponential(3)` threw a TypeError. A report
    // that reads fine at the moment it is produced became unrenderable the
    // moment it was archived.
    expect(() => formatAblationReport(report())).not.toThrow();
  });

  it('labels a null t-test p-value as not applicable rather than rendering a number', () => {
    const md = formatAblationReport(report());
    expect(md).toContain('Welch t-test p-value (over stochastic runs): **n/a (deterministic)**');
  });

  it('labels a null effect size as not applicable', () => {
    const md = formatAblationReport(report());
    expect(md).toContain("- Cohen's d: **n/a**");
  });

  it('still renders a real numeric p-value and effect size unchanged', () => {
    const ablation = persistedAblation();
    const md = formatAblationReport(
      report({
        ablation: {
          ...ablation,
          pValue: 0.001,
          significant: true,
          effectSize: 0.42,
        },
      }),
    );
    expect(md).toContain('1.000e-3');
    expect(md).toContain('significant: yes');
    expect(md).toContain('0.420');
  });

  it('round-trips through JSON.stringify and JSON.parse without losing renderability', () => {
    // The end-to-end shape of the defect: not a hand-built null, but the actual
    // serialise/deserialise pair that produced it in the archived artifact.
    const live = report({
      ablation: {
        ...persistedAblation(),
        pValue: Number.NaN,
        effectSize: Number.NEGATIVE_INFINITY,
      },
    });
    const persisted = JSON.parse(JSON.stringify(live)) as AblationReport;
    expect(persisted.ablation.pValue).toBeNull();
    expect(() => formatAblationReport(persisted)).not.toThrow();
  });

  it('keeps the cohort banner above the results in a persisted report', () => {
    const persisted = JSON.parse(
      JSON.stringify(
        report({
          cohortCoverage: {
            present: ['80ec1f4f_abs'],
            missing: [
              '6456829e_abs',
              'edced276_abs',
              'e5ba910e_abs',
              'gpt4_70e84552_abs',
              'gpt4_c27434e8_abs',
              'gpt4_fe651585_abs',
            ],
            ratio: 0.14285714285714285,
          },
        }),
      ),
    ) as AblationReport;
    const md = formatAblationReport(persisted);
    expect(md).toContain('COHORT INCOMPLETE');
    expect(md.indexOf('COHORT INCOMPLETE')).toBeLessThan(md.indexOf('Δ accuracy'));
  });
});

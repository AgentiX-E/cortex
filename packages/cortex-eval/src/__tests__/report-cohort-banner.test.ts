import { describe, expect, it } from 'vitest';
import { formatAblationReport, type AblationReport } from '../report.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(): Metrics {
  const perCapability = Object.fromEntries(
    CAPABILITIES.map((c) => [c, { total: 0, correct: 0, accuracy: 0, abstained: 0 }]),
  ) as Metrics['perCapability'];
  return {
    accuracy: 0.9,
    abstentionRate: 0,
    abstentionCorrectRate: 0,
    abstentionAwareAccuracy: 0.9,
    total: 10,
    correct: 9,
    perCapability,
  };
}

function pairedStats(): PerCapabilityPairedStats {
  return {
    total: 0,
    baselineCorrect: 0,
    featureCorrect: 0,
    baselineCorrectFeatureIncorrect: 0,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0, upper: 1 },
    featureConfidence: { lower: 0, upper: 1 },
  };
}

/**
 * A minimal report shaped like the conjunction arm's, so these tests assert on
 * the coverage banner rather than on the arithmetic. Built from the real types
 * instead of a cast: a cast would let a field rename in `AblationResult` pass
 * typecheck here and fail only when the banner is rendered in CI.
 */
function report(overrides: Partial<AblationReport> = {}): AblationReport {
  const m = metrics();
  const ablation: AblationResult = {
    feature: 'conjunction-decomposed',
    baselineAggregate: { min: 0.9, max: 0.9, avg: 0.9, median: 0.9 },
    featureAggregate: { min: 0.9, max: 0.9, avg: 0.9, median: 0.9 },
    delta: 0,
    pValue: Number.NaN,
    significant: false,
    effectSize: 0,
    baselineConfidence: { lower: 0.6, upper: 0.98 },
    featureConfidence: { lower: 0.6, upper: 0.98 },
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: [],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: m,
    featureMetrics: m,
    featureCorrect: [],
    perCapability: Object.fromEntries(
      CAPABILITIES.map((c) => [c, pairedStats()]),
    ) as AblationResult['perCapability'],
  };
  return {
    dataset: 'longmemeval-conjunction',
    questionCount: 35,
    baseline: { name: 'conjunction-fused', metrics: m },
    feature: { name: 'conjunction-decomposed', metrics: m },
    ablation,
    generatedAt: '2026-09-20T09:47:42.542Z',
    ...overrides,
  };
}

describe('formatAblationReport cohort coverage banner', () => {
  it('prints no banner when the report declares no cohort', () => {
    // The main benchmark and every non-cohort ablation must stay byte-identical
    // to their pre-banner form: adding an "incomplete" heading to a report that
    // has no cohort would make every ordinary run look degraded.
    const markdown = formatAblationReport(report());
    expect(markdown).not.toMatch(/[Cc]ohort/);
  });

  it('states the shortfall when the cohort is incomplete', () => {
    const markdown = formatAblationReport(
      report({
        cohortCoverage: {
          present: ['80ec1f4f_abs'],
          missing: ['6456829e_abs', 'edced276_abs'],
          ratio: 1 / 3,
        },
      }),
    );
    expect(markdown).toContain('INCOMPLETE');
    expect(markdown).toContain('1/3');
    expect(markdown).toContain('6456829e_abs');
  });

  it('places the banner before the results, not after them', () => {
    // A caveat below three tables of Wilson intervals is a caveat nobody reads.
    // The banner has to be the first thing after the title block.
    const markdown = formatAblationReport(
      report({
        cohortCoverage: { present: ['a'], missing: ['b'], ratio: 0.5 },
      }),
    );
    const bannerAt = markdown.indexOf('INCOMPLETE');
    const deltaAt = markdown.indexOf('Δ accuracy');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(deltaAt);
  });

  it('announces a complete cohort explicitly', () => {
    // "No banner" and "complete cohort" must not look the same, or a reader
    // cannot tell a satisfied precondition from an absent one.
    const markdown = formatAblationReport(
      report({ cohortCoverage: { present: ['a', 'b'], missing: [], ratio: 1 } }),
    );
    expect(markdown).toContain('100.00%');
    expect(markdown).toContain('complete');
    expect(markdown).not.toContain('INCOMPLETE');
  });

  it('formats the ratio to two decimals like every other rate in the report', () => {
    const markdown = formatAblationReport(
      report({
        cohortCoverage: { present: ['a'], missing: ['b', 'c', 'd', 'e', 'f', 'g'], ratio: 1 / 7 },
      }),
    );
    expect(markdown).toContain('14.29%');
  });
});

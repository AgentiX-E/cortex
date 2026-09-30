/**
 * The annotation version must be recorded where a reader can see it, or it is not
 * a version at all.
 *
 * `CANDIDATE_ANNOTATION_VERSION` was exported from `candidate-context.ts`, re-
 * exported from the package barrel, and read by nothing. Its own docstring states
 * the contract it exists to serve:
 *
 *     Bumped when the annotation's shape changes in a way a reader could observe.
 *     Two revisions that render the same context must be indistinguishable, so this
 *     is a schema version rather than a library version.
 *
 * No rendered context and no report carried the value, so the guarantee was
 * unverifiable by construction: two artifacts rendered by different revisions of
 * the annotation were indistinguishable in exactly the way the docstring forbids,
 * and nothing could tell.
 *
 * This is the `AUDIT-B7-DEAD-SWITCH.md` shape -- a contract that is described but
 * has no mechanism -- and the fix is the one `cohortCoverage`, `retryFires` and
 * `featureConfig` already share: put the value in the report, so a reader holding
 * only the artifact can see it.
 */
import { describe, it, expect } from 'vitest';
import { formatAblationReport, type AblationReport } from '../report.js';
import { CANDIDATE_ANNOTATION_VERSION } from '../candidate-context.js';
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
      IE: { total: 20, correct: 18, accuracy: 0.9, abstained: 3 },
      MR: { total: 10, correct: 8, accuracy: 0.8, abstained: 2 },
      KU: { total: 10, correct: 8, accuracy: 0.8, abstained: 2 },
      TR: { total: 15, correct: 13, accuracy: 0.8666666666666667, abstained: 1 },
      ABS: { total: 5, correct: 4, accuracy: 0.8, abstained: 5 },
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

function result(): AblationResult {
  return {
    feature: 'candidate-annotation',
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
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: [],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: metrics(),
    featureMetrics: metrics(),
    featureCorrect: Array.from({ length: 60 }, () => true),
    perCapability: Object.fromEntries(CAPABILITIES.map((c) => [c, paired(8)])) as Record<
      Capability,
      PerCapabilityPairedStats
    >,
  };
}

function report(overrides: Partial<AblationReport> = {}): AblationReport {
  return {
    dataset: 'synthetic',
    questionCount: 60,
    baseline: { name: 'baseline', metrics: metrics() },
    feature: { name: 'feature', metrics: metrics() },
    ablation: result(),
    generatedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('the annotation version is recorded in the report', () => {
  it('renders the annotation version when the report carries it', () => {
    const markdown = formatAblationReport(
      report({ candidateAnnotationVersion: CANDIDATE_ANNOTATION_VERSION }),
    );
    expect(markdown).toContain('Annotation version');
    expect(markdown).toContain(String(CANDIDATE_ANNOTATION_VERSION));
  });

  it('says so explicitly when the annotation was not applied', () => {
    // Absence and "version 1" are different claims. A report that silently omits
    // the line cannot distinguish "this arm ran without the annotation" from "this
    // arm predates the field", and only the first is a statement about the run.
    // The line is explicit about the off state rather than omitted, because the
    // reader's question is "was the annotation on, and at what revision" and an
    // absent line answers neither.
    const markdown = formatAblationReport(report({ candidateAnnotationVersion: 0 }));
    expect(markdown).toContain('Annotation version');
    expect(markdown).toContain('not applied');
  });

  it('omits the line entirely when the field is absent, for older artifacts', () => {
    // Same rule `cohortCoverage` and `retryFires` follow: a field added later is
    // absent on artifacts that predate it, and inventing a value for them would
    // make an old artifact claim something it does not say.
    const markdown = formatAblationReport(report());
    expect(markdown).not.toContain('Annotation version');
  });

  it('carries the version as a number so it survives the JSON round trip', () => {
    // The version is emitted into the JSON artifact and re-read by readers that
    // hold only the file, so it must be a JSON scalar rather than something a
    // renderer formats. `0` is the off sentinel and must not become `null` the way
    // NaN does (`docs/FIX-REPORT-JSON-ROUNDTRIP.md`).
    const withVersion = report({ candidateAnnotationVersion: 2 });
    const roundTripped = JSON.parse(JSON.stringify(withVersion)) as AblationReport;
    expect(roundTripped.candidateAnnotationVersion).toBe(2);
    const withOff = report({ candidateAnnotationVersion: 0 });
    const offRoundTripped = JSON.parse(JSON.stringify(withOff)) as AblationReport;
    expect(offRoundTripped.candidateAnnotationVersion).toBe(0);
  });
});

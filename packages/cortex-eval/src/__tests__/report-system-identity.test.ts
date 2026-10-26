/**
 * A score must carry the identity of the system that produced it.
 *
 * ## The defect this suite exists for, measured rather than imagined
 *
 * Two workflows in this repository write an ablation report with the same
 * headline, the same dataset line and the same metric name, and they measure
 * **two different systems**:
 *
 * | workflow | feature arm | reading |
 * | --- | --- | --- |
 * | `benchmark.yml` | `nl-abstain-feature` | 43.80% (`40378588466`) |
 * | `benchmark-cortex-memory.yml` | `cortex-memory` | 80.80% (`40088479628`) |
 *
 * Run `40088479628` contains both numbers measured **in one run, on one judge**:
 * its baseline is `reference-pipeline` at **43.40%** and its feature is
 * `cortex-memory` at **80.80%**. So the pair is not a regression. It is the same
 * baseline read twice, once under each report's headline.
 *
 * The repository then spent a round treating 81.0% -> 43.8% as an unexplained
 * end-to-end drift (see `docs/MEASURE-BASELINE-DRIFT.md`). Every artifact needed
 * to avoid that was present. What was missing was the identity of the system next
 * to the number, so the number could travel -- into a summary table, a commit
 * message, a plan -- without it.
 *
 * ## What this suite pins
 *
 * Every number a reader is likely to quote in isolation: the headline, the
 * overall accuracy, the abstention rates and the per-capability table. Each must
 * name its arm. The assertion is deliberately made on **rendered text**, not on
 * the object, because the object was never the problem -- the artifact was.
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
    baselineCorrect: total - 1,
    featureCorrect: total,
    baselineCorrectFeatureIncorrect: 1,
    baselineIncorrectFeatureCorrect: 2,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
  };
}

function report(feature: string, baseline: string, accuracy: number): AblationReport {
  const scored = metrics();
  scored.accuracy = accuracy;
  const ablation: AblationResult = {
    feature,
    baselineAggregate: { min: accuracy, max: accuracy, avg: accuracy, median: accuracy },
    featureAggregate: { min: accuracy, max: accuracy, avg: accuracy, median: accuracy },
    delta: 0,
    pValue: Number.NaN,
    significant: false,
    effectSize: Number.NEGATIVE_INFINITY,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
    mcnemarPValue: 0.5,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: [],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: scored,
    featureMetrics: scored,
    featureCorrect: Array.from({ length: 60 }, () => true),
    perCapability: Object.fromEntries(
      CAPABILITIES.map((capability) => [capability, paired(8)]),
    ) as Record<Capability, PerCapabilityPairedStats>,
  };
  return {
    dataset: 'longmemeval',
    questionCount: 60,
    baseline: { name: baseline, metrics: scored },
    feature: { name: feature, metrics: scored },
    ablation,
    generatedAt: '2026-10-27T00:00:00.000Z',
  };
}

/** The two arms of the incident, at their recorded scores. */
const NLP = report('nl-abstain-feature', 'nl-naive-baseline', 0.438);
const COGNITIVE = report('cortex-memory', 'reference-pipeline', 0.808);

describe('the headline names the system under test', () => {
  it('puts the feature arm in the title', () => {
    expect(formatAblationReport(NLP).split('\n')[0]).toBe(
      '# Cortex Benchmark Report — `nl-abstain-feature`',
    );
    expect(formatAblationReport(COGNITIVE).split('\n')[0]).toBe(
      '# Cortex Benchmark Report — `cortex-memory`',
    );
  });

  it('gives two different systems two different titles', () => {
    // The whole incident in one assertion: the titles used to be the same
    // string, so two artifacts describing different systems were
    // indistinguishable once the body was scrolled away.
    expect(formatAblationReport(NLP).split('\n')[0]).not.toBe(
      formatAblationReport(COGNITIVE).split('\n')[0],
    );
  });

  it('states both arms on their own line, above every number', () => {
    const md = formatAblationReport(COGNITIVE);
    const declared = md.indexOf(
      '- System under test: `cortex-memory` vs baseline `reference-pipeline`',
    );
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(md.indexOf('## Ablation'));
    expect(declared).toBeLessThan(md.indexOf('Overall accuracy'));
  });
});

describe('every quotable number carries its arm', () => {
  it('names the arm on the overall accuracy line', () => {
    expect(formatAblationReport(COGNITIVE)).toContain(
      '- Overall accuracy (`cortex-memory`): 80.80%',
    );
    expect(formatAblationReport(NLP)).toContain(
      '- Overall accuracy (`nl-abstain-feature`): 43.80%',
    );
  });

  it('names the arm on both abstention lines', () => {
    const md = formatAblationReport(COGNITIVE);
    expect(md).toContain('- Abstention rate (`cortex-memory`): 15.00%');
    expect(md).toContain('- Abstention correct rate (`cortex-memory`): 88.89%');
  });

  it('names the arm in the per-capability section heading', () => {
    expect(formatAblationReport(COGNITIVE)).toContain(
      '## Per-capability breakdown (`cortex-memory` arm)',
    );
  });

  it('leaves no bare overall-accuracy line behind', () => {
    // The negative half of the same property. A renderer that names the arm
    // somewhere in the document but not on this line still allows the
    // extraction this suite exists to prevent.
    for (const md of [formatAblationReport(NLP), formatAblationReport(COGNITIVE)]) {
      for (const line of md.split('\n')) {
        if (line.startsWith('- Overall accuracy') || line.startsWith('- Abstention')) {
          expect(line).toMatch(/`(nl-abstain-feature|cortex-memory)`/);
        }
      }
    }
  });
});

describe('the ablation table still separates the two systems by name', () => {
  it('lists the feature arm and the baseline arm as distinct rows', () => {
    const md = formatAblationReport(COGNITIVE);
    expect(md).toContain('| cortex-memory |');
    expect(md).toContain('| reference-pipeline |');
  });
});

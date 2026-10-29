/**
 * Per-capability counts across repetitions, so a movement can be declared in the unit it is read in.
 *
 * ## The defect this closes
 *
 * §13.87's replication changed nothing and moved MR from 90 to 83. The artifact already held the
 * explanation: `featureAggregate` is a spread over the **four repetitions** of one run, while every
 * per-capability count in the roster is **one repetition's**. Two numbers in different units sat on
 * the same page, and two consecutive sections read a capability's movement from the first while
 * quoting the second's significance.
 *
 * These tests pin the projection the artifact was missing: for each capability, the correct count
 * per repetition, aggregated to min / avg / max.
 *
 * ## Why the fixture makes the repetitions differ
 *
 * A deterministic system answers identically on every pass, so min = avg = max and any bug in the
 * aggregation is invisible. The scripted system below answers correctly on even passes and
 * incorrectly on odd ones, which makes the three numbers different from each other and from a
 * single repetition's count.
 */
import { describe, expect, it } from 'vitest';

import { exactMatchScorer } from '../metrics.js';
import { formatAblationReport, runAblationReport } from '../report.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

const dataset: BenchmarkDataset = {
  name: 'per-capability',
  questions: [
    { id: 'ie-1', capability: 'IE', question: 'Q1', expected: 'yes', context: ['yes'] },
    { id: 'ie-2', capability: 'IE', question: 'Q2', expected: 'yes', context: ['yes'] },
    { id: 'mr-1', capability: 'MR', question: 'Q3', expected: 'yes', context: ['yes'] },
    { id: 'mr-2', capability: 'MR', question: 'Q4', expected: 'yes', context: ['yes'] },
    { id: 'tr-1', capability: 'TR', question: 'Q5', expected: 'yes', context: ['yes'] },
  ],
};

/**
 * A system that is right on even passes and wrong on odd ones.
 *
 * The pass is inferred from how many answers it has given, which is the only thing a system is
 * shown: `runBenchmark` asks every question once per pass, in dataset order.
 */
function alternatingSystem(name: string, questions: number): MemorySystem {
  let given = 0;
  return {
    name,
    answer: async () => {
      const pass = Math.floor(given / questions);
      given += 1;
      return pass % 2 === 0 ? 'yes' : 'no';
    },
  };
}

describe('per-capability counts across repetitions', () => {
  it('reports min, mean and max per capability, in correct counts', async () => {
    const report = await runAblationReport(
      dataset,
      alternatingSystem('baseline', dataset.questions.length),
      alternatingSystem('feature', dataset.questions.length),
      { runs: 2, scorer: exactMatchScorer },
    );

    // Two repetitions, both sides alternating together: each capability is 2/2 on the first pass
    // and 0/2 on the second. A single-repetition count would say 2 and a reader would have no way
    // to know the other pass said 0.
    expect(report.ablation.featureByCapability).toEqual({
      IE: { min: 0, avg: 1, max: 2 },
      MR: { min: 0, avg: 1, max: 2 },
      // TR carries one question, so its counts are 1 and 0: the spread says so, and a test that
      // expected 2 here would be asserting a denominator the dataset does not have.
      TR: { min: 0, avg: 0.5, max: 1 },
    });
    expect(report.ablation.baselineByCapability).toEqual(report.ablation.featureByCapability);
    expect(report.ablation.questionsByCapability).toEqual({ IE: 2, MR: 2, TR: 1 });
  });

  it('omits the field entirely when there is one repetition', async () => {
    // Absent rather than degenerate: with one pass min, avg and max are one number, and a spread
    // of zero would read as perfect stability -- the strongest possible claim from no evidence.
    const report = await runAblationReport(
      dataset,
      alternatingSystem('baseline', dataset.questions.length),
      alternatingSystem('feature', dataset.questions.length),
      { runs: 1, scorer: exactMatchScorer },
    );

    expect(report.ablation.featureByCapability).toBeUndefined();
    expect(report.ablation.baselineByCapability).toBeUndefined();
    expect(report.ablation.questionsByCapability).toBeUndefined();
  });

  it('agrees with the first-repetition vector', async () => {
    // The new aggregate and the existing single-repetition vector must describe the same run. If
    // they disagree, one of them is counting a different pass and every comparison across the two
    // is void -- which is exactly the reading §13.87 had to withdraw.
    //
    // Read from `ablation.featureCorrect` rather than from `report.questions`: the fixture's systems
    // answer with a bare string, so no per-question record is captured and the roster is absent. A
    // loop over an absent roster would pass while comparing nothing, which is the failure mode
    // `test_ledger.py`'s `extra` parameter had.
    const report = await runAblationReport(
      dataset,
      alternatingSystem('baseline', dataset.questions.length),
      alternatingSystem('feature', dataset.questions.length),
      { runs: 2, scorer: exactMatchScorer },
    );

    expect(report.questions).toBeUndefined();
    const firstPass = new Map<string, number>();
    dataset.questions.forEach((question, index) => {
      const key = question.capability;
      firstPass.set(
        key,
        (firstPass.get(key) ?? 0) + (report.ablation.featureCorrect[index] ? 1 : 0),
      );
    });
    expect(firstPass.size).toBe(3);
    for (const [capability, count] of firstPass) {
      // The first repetition is the **correct** pass in this fixture, so the aggregate's max must
      // equal it -- and its min must be the other pass.
      expect(report.ablation.featureByCapability?.[capability]).toEqual({
        min: 0,
        avg: count / 2,
        max: count,
      });
    }
  });
});

describe('the Markdown summary states the unit of each count', () => {
  it('adds the spread columns when the artifact holds them', async () => {
    const report = await runAblationReport(
      dataset,
      alternatingSystem('baseline', dataset.questions.length),
      alternatingSystem('feature', dataset.questions.length),
      { runs: 2, scorer: exactMatchScorer, generatedAt: '1970-01-01T00:00:00.000Z' },
    );
    const markdown = formatAblationReport(report);

    // The header names the unit, because the defect was a column that did not say which repetition
    // it described while the section above it quoted a mean.
    expect(markdown).toContain('Accuracy (first repetition)');
    expect(markdown).toContain('| min | mean | max |');
    // And the row carries the three numbers the field holds.
    expect(markdown).toMatch(/\| MR \| 100\.00% \| 2 \| 0 \| 1\.0 \| 2 \|/);
  });

  it('keeps the old shape when there is one repetition', async () => {
    const report = await runAblationReport(
      dataset,
      alternatingSystem('baseline', dataset.questions.length),
      alternatingSystem('feature', dataset.questions.length),
      { runs: 1, scorer: exactMatchScorer, generatedAt: '1970-01-01T00:00:00.000Z' },
    );
    const markdown = formatAblationReport(report);

    expect(markdown).toContain('Accuracy (first repetition)');
    expect(markdown).not.toContain('| min | mean | max |');
  });
});

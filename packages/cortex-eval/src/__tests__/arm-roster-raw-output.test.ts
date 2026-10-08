/**
 * The arm's roster must carry the raw model output, per question.
 *
 * ## The artifact this is written against
 *
 * Dispatch `37792539133` was the first run whose artifact carried a
 * per-question roster, and it is the measurement that motivated this wiring.
 * `questions` held 120 records and `answer` was populated -- five of them with a
 * string, the longest a multi-line reply -- so the carrier worked. But 115 read
 * `null`, and `null` is `Answer`'s collapse of three distinct declines: the bare
 * `INSUFFICIENT_EVIDENCE`, a labelled `Answer: INSUFFICIENT_EVIDENCE`, and an
 * explanation followed by the token. The 29 baseline-correct questions the read
 * exists to explain (13 MR, 16 TR) could not be told apart.
 *
 * ## Why these assertions are on the roster and not on the hook
 *
 * `benchmark-raw-capture.test.ts` pins the capture inside the answer loop. That
 * is necessary and not sufficient: the value has to survive three transfers --
 * `ScoredEvaluation` -> `AblationResult` -> `QuestionRecord` -- and the §57 round
 * is the precedent for a value that existed and reached none of them. A test on
 * the hook alone would pass with the arm still discarding the vector.
 *
 * The last transfer is the one with a trap in it. `runCortexMemoryArm` builds
 * the roster *after* the ablation has finished, so reading
 * `CortexMemory.lastRawOutput()` at that point returns the final question's text
 * for every record. What is asserted below is therefore that **each record
 * carries its own question's output**, which is what that shortcut breaks.
 */

import { describe, expect, it } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';
import type { AblationResult, Answer, BenchmarkDataset, MemorySystem } from '../types.js';

/**
 * A feature system that exposes raw output, one entry per question.
 *
 * It answers from `answers` and reports from `raw`, both by the same cursor, so
 * an alignment defect in the arm surfaces as a mismatched record rather than as
 * a passing test.
 */
function rawFeatureSystem(answers: Answer[], raw: (string | null)[]): MemorySystem {
  let cursor = 0;
  let last: string | null = null;
  return {
    name: 'cortex-memory',
    answer: async () => {
      last = raw[cursor]!;
      return answers[cursor++]!;
    },
    lastRawOutput: () => last,
  } as unknown as MemorySystem;
}

/** A baseline that answers correctly, so a regression is attributable to the feature. */
function baselineSystem(answers: Answer[]): MemorySystem {
  let cursor = 0;
  return { name: 'reference-pipeline', answer: async () => answers[cursor++]! };
}

function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'roster-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      expected: `answer-${i}`,
      capability: 'IE' as const,
      context: [`evidence ${i}`],
    })),
  };
}

/**
 * Run the arm and hand back the report, whose `ablation` field is the raw result.
 *
 * The ablation is reached through `report.ablation` rather than as a sibling of
 * it: `runCortexMemoryArm` returns `{ report, markdown, delta, ... }` and the
 * result object is nested inside the report, which is what the earlier version of
 * this helper got wrong.
 */
async function runArm(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
): Promise<{
  report: {
    ablation: AblationResult;
    questions?: readonly { rawOutput?: string | null; questionId: string }[];
  };
}> {
  const result = await runCortexMemoryArm(dataset, baseline, feature, {
    runs: 1,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: {
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: null,
      sourceTrust: 0.5,
      confidenceSignal: 'none',
      promptContract: 'abstention',
    },
  });
  return result as unknown as {
    report: {
      ablation: AblationResult;
      questions?: readonly { rawOutput?: string | null; questionId: string }[];
    };
  };
}

describe('the arm roster carries each question’s own raw model output', () => {
  it('records the raw output on every question record', async () => {
    const dataset = datasetOf(3);
    const { report } = await runArm(
      dataset,
      baselineSystem(['answer-0', 'answer-1', 'answer-2']),
      rawFeatureSystem(['answer-0', 'answer-1', 'answer-2'], ['raw-0', 'raw-1', 'raw-2']),
    );
    expect(report.questions?.map((r) => r.rawOutput)).toEqual(['raw-0', 'raw-1', 'raw-2']);
  });

  it('attributes each raw output to its own question, not to the last one answered', async () => {
    // The trap: the roster is assembled after the pass, so an implementation
    // that read the single-slot accessor there would report 'raw-2' three times.
    const dataset = datasetOf(3);
    const { report } = await runArm(
      dataset,
      baselineSystem(['answer-0', 'answer-1', 'answer-2']),
      rawFeatureSystem(['answer-0', 'answer-1', 'answer-2'], ['raw-0', 'raw-1', 'raw-2']),
    );
    const raw = report.questions?.map((r) => r.rawOutput) ?? [];
    expect(new Set(raw).size).toBe(3);
    expect(raw[0]).toBe('raw-0');
  });

  it('keeps an abstention’s explanation, which is the text the read needs', async () => {
    const explained = ['The evidence does not name a city.', 'INSUFFICIENT_EVIDENCE'].join('\n');
    const dataset = datasetOf(1);
    const { report } = await runArm(
      dataset,
      baselineSystem(['Lisbon']),
      rawFeatureSystem([null], [explained]),
    );
    expect(report.questions?.[0]?.rawOutput).toBe(explained);
  });

  it('records null rather than the empty string when the model was not consulted', async () => {
    // `null` is a machine-derived abstention; `undefined` would be a recording
    // gap and `''` a blank answer. The field has to distinguish them.
    const dataset = datasetOf(1);
    const { report } = await runArm(
      dataset,
      baselineSystem(['Lisbon']),
      rawFeatureSystem([null], [null]),
    );
    expect(report.questions?.[0]).toHaveProperty('rawOutput');
    expect(report.questions?.[0]?.rawOutput).toBeNull();
  });

  it('carries the raw vector out of the ablation, aligned with the answers', async () => {
    // One transfer earlier than the roster, and the one §57's round showed can
    // be lost silently: the value exists in the evaluation and never reaches the
    // result that the arm reads.
    const dataset = datasetOf(2);
    const { report } = await runArm(
      dataset,
      baselineSystem(['answer-0', 'answer-1']),
      rawFeatureSystem(['answer-0', null], ['raw-0', 'INSUFFICIENT_EVIDENCE']),
    );
    expect(report.ablation.featureRawOutputs).toEqual(['raw-0', 'INSUFFICIENT_EVIDENCE']);
    expect(report.ablation.featureAnswers).toEqual(['answer-0', null]);
  });

  it('records null per question for a system that exposes no raw output at all', async () => {
    // A system with no such capability must not have text invented for it. The
    // capture runs, finds no accessor on the system, and reports `null` for each
    // question -- which is the same value a machine-derived abstention produces,
    // and correctly so: both mean "the model produced no text for this question".
    const dataset = datasetOf(1);
    const { report } = await runArm(dataset, baselineSystem(['Lisbon']), {
      name: 'cortex-memory',
      answer: async () => 'Lisbon',
    });
    expect(report.questions?.[0]).toHaveProperty('rawOutput');
    expect(report.questions?.[0]?.rawOutput).toBeNull();
  });
});

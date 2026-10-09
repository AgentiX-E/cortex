/**
 * The evidence a reader was shown must survive every transfer into the roster.
 *
 * ## The gap this closes
 *
 * §13 measured MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every capability.
 * The next hypothesis is retrieval quality, and it was untestable because
 * `QuestionRecord.turns` was `[]` on every record -- `buildArmRoster` supplied
 * `retrieved: ''` unconditionally, since the arm collected no retrieval text.
 *
 * Wiring the accessor on the product side and the hook on the benchmark side is
 * two thirds of the work. The third is this file's subject: the vector has to
 * reach the RECORD. Three transfers can each lose it independently:
 *
 * 1. `CortexMemory` records it, but `runBenchmark` never reads it -- the hook
 *    exists and is not passed.
 * 2. `runBenchmark` captures it, but `runAblation` does not request it, so
 *    `featureRetrievedContexts` is absent from the result.
 * 3. The vector is present, but `buildArmRoster` ignores it and writes `''` --
 *    which is exactly the defect that produced `turns: []` in the first place.
 *
 * ## Why the assertions are behavioural and per-record
 *
 * The trap is the same one the raw-output transfer has: the roster is built after
 * the ablation finishes, so reading `lastRetrievedContext()` at that point returns
 * the FINAL question's evidence for every record. What is asserted is therefore
 * that each record carries its own question's evidence, which that shortcut
 * breaks.
 *
 * The values are derived from the question index rather than held constant, so a
 * misalignment lands as the wrong index instead of as a test that cannot tell two
 * questions apart.
 */

import { describe, expect, it } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

/**
 * A feature system exposing both optional accessors, aligned by one cursor.
 *
 * Both are derived from the same index, so an arm that crossed the two vectors --
 * reading evidence where it meant to read model text, or the reverse -- produces
 * a record that fails rather than a record that happens to match.
 */
function evidenceFeatureSystem(
  answers: Answer[],
  evidence: (string | null)[],
  raw: (string | null)[],
): MemorySystem {
  let cursor = 0;
  let lastEvidence: string | null = null;
  let lastRaw: string | null = null;
  return {
    name: 'cortex-memory',
    answer: async () => {
      lastEvidence = evidence[cursor]!;
      lastRaw = raw[cursor]!;
      return answers[cursor++]!;
    },
    lastRetrievedContext: () => lastEvidence,
    lastRawOutput: () => lastRaw,
  } as unknown as MemorySystem;
}

/** A fixture dataset of `count` single-session questions. */
function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'roster-evidence-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      expected: `answer-${i}`,
      capability: 'IE' as const,
      context: [`evidence ${i}`],
      sessions: [[`evidence ${i}`]],
    })),
  };
}

/** A baseline that always answers the same way, so only the feature side varies. */
function constantSystem(name: string, answer: Answer): MemorySystem {
  return { name, answer: () => answer };
}

/** Run the arm over a fixture whose feature side reports per-question evidence. */
async function rosterFor(evidence: (string | null)[], raws: (string | null)[]) {
  const count = evidence.length;
  const answers = Array.from({ length: count }, (_unused, i) => `answer-${i}`);

  const { report } = await runCortexMemoryArm(
    datasetOf(count),
    constantSystem('reference-pipeline', 'answer-0'),
    evidenceFeatureSystem(answers, evidence, raws),
    {
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
    },
  );

  return report.questions!;
}

describe('the roster carries the evidence each reader was shown', () => {
  it('gives each record its own evidence, not the last question for all of them', async () => {
    // The load-bearing assertion. `runCortexMemoryArm` builds the roster after the
    // ablation, so a shortcut that read the accessor once would give every record
    // the final question's evidence -- and every value here is distinct, so that
    // shortcut cannot pass.
    const records = await rosterFor(
      ['first fact', 'second fact', 'third fact'],
      ['raw-0', 'raw-1', 'raw-2'],
    );

    expect(records.map((r) => r.turns.flatMap((t) => t.text))).toEqual([
      ['first fact'],
      ['second fact'],
      ['third fact'],
    ]);
  });

  it('splits multi-turn evidence into turns rather than one blob', async () => {
    // The record's `turns` is a list, and the reason is that retrieval order is
    // part of the claim: "the right turn was present but ranked below something
    // else" is only visible if the turns stayed separate.
    const records = await rosterFor(['user: Lisbon\nassistant: Noted'], ['raw-0']);

    expect(records[0]!.turns.map((t) => t.text)).toEqual(['user: Lisbon', 'assistant: Noted']);
  });

  it('reports an empty turn list when no reader was shown anything', async () => {
    // A machine-derived abstention. `turns: []` is the true statement here, and it
    // is distinguishable from the defect above because the records whose evidence
    // WAS captured carry their own turns -- a run where every record is empty is
    // the shape that means the capture failed.
    const records = await rosterFor([null, 'some evidence'], ['raw-0', 'raw-1']);

    expect(records[0]!.turns).toEqual([]);
    expect(records[1]!.turns.map((t) => t.text)).toEqual(['some evidence']);
  });

  it('keeps the evidence aligned with the raw output it explains', async () => {
    // The two vectors are captured on the same side and paired by index. A capture
    // that ran one question out of step would explain one question's decline with
    // another's evidence, which is worse than not capturing at all -- it would read
    // as a finding.
    const records = await rosterFor(
      ['evidence 0', 'evidence 1', 'evidence 2'],
      ['raw-0', 'raw-1', 'raw-2'],
    );

    for (const [i, record] of records.entries()) {
      expect(record.turns.map((t) => t.text)).toEqual([`evidence ${i}`]);
      expect(record.rawOutput).toBe(`raw-${i}`);
    }
  });

  it('reports no evidence for a fixture that never captured any', async () => {
    // A hand-built `AblationResult` omits the vector, and the honest reading of
    // that fixture is "nothing was retrieved", which is `turns: []` -- the same
    // value the pre-change arm reported for every record. The difference is that
    // it is now a measurement rather than a hardcoded constant.
    const records = await rosterFor([null, null], ['raw-0', 'raw-1']);

    expect(records.every((r) => r.turns.length === 0)).toBe(true);
    // And the raw vector is still present, so the records are not simply empty.
    expect(records.map((r) => r.rawOutput)).toEqual(['raw-0', 'raw-1']);
  });
});

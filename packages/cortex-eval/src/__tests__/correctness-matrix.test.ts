/**
 * Which question moved, not just how many.
 *
 * ## The defect this closes
 *
 * §13.88 taught the ablation to report a *spread* per capability: `{min, avg, max}` over the four
 * repetitions. That answered "did the passes disagree" and stopped there. Three numbers are a
 * summary of **counts**, so they cannot name a question, cannot be recomputed for a population
 * smaller than a capability, and cannot say whether one question flapped four times or four
 * questions flapped once each -- two states with the same spread and completely different readings.
 *
 * §13.144 recorded the consequence: the four repetitions have been carried as per-run **vectors**
 * (`featureCorrectPerRun`) and every artifact that ever left the runner has published only the
 * collapsed counts. The evidence existed for the length of one function body.
 *
 * ## What the field is
 *
 * One string per repetition, run-major, one character per dataset question (`'1'` correct, `'0'`
 * not). A character grid rather than a boolean matrix because the artifact is already 51 MB and
 * this has to be readable by `tools/*.mjs` without a decoder: the alternative -- a bitmask -- makes
 * every reader a bit-twiddler and every off-by-one invisible.
 *
 * ## Why the fixture makes exactly one question move, and why at the front
 *
 * A fixture where everything moves cannot tell an array that is aligned from one that is reversed;
 * a fixture where nothing moves cannot tell an aligned array from a constant. The system below flips
 * **one** question between passes, which pins the alignment to a single position.
 *
 * The flip is at the **first** question because an earlier version of this fixture flipped the
 * second of three and produced the strings `'111'` and `'101'` -- both palindromes. A mutation that
 * reversed the mask then passed every test, so the alignment was pinned by nothing. The pattern is
 * asymmetric now, and the reversal mutation fails.
 */
import { describe, expect, it } from 'vitest';

import { exactMatchScorer } from '../metrics.js';
import { correctnessMask } from '../question-record.js';
import { runAblationReport } from '../report.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

const dataset: BenchmarkDataset = {
  name: 'correctness-matrix',
  questions: [
    { id: 'q1', capability: 'MR', question: 'Q1', expected: 'yes', context: ['yes'] },
    { id: 'q2', capability: 'MR', question: 'Q2', expected: 'yes', context: ['yes'] },
    { id: 'q3', capability: 'IE', question: 'Q3', expected: 'yes', context: ['yes'] },
    { id: 'q4', capability: 'IE', question: 'Q4', expected: 'yes', context: ['yes'] },
  ],
};

/**
 * Right on every question, except `Q1` on odd passes.
 *
 * The pass is inferred from how many answers have been given, which is the only signal a system is
 * shown: `runBenchmark` asks the whole dataset once per pass, in dataset order.
 */
function oneFlipper(name: string): MemorySystem {
  let given = 0;
  return {
    name,
    // The question text is not read: the position is inferred from how many answers have been given, which
    // is enough here and keeps the fixture from depending on the prompt the harness builds.
    answer: async () => {
      const pass = Math.floor(given / dataset.questions.length);
      const index = given % dataset.questions.length;
      given += 1;
      if (index === 0 && pass % 2 === 1) return 'no';
      return 'yes';
    },
  };
}

describe('per-question correctness across repetitions', () => {
  it('carries one character per question per repetition, in dataset order', async () => {
    const report = await runAblationReport(dataset, oneFlipper('baseline'), oneFlipper('feature'), {
      runs: 2,
      scorer: exactMatchScorer,
    });

    // Four questions, two repetitions. The second pass is wrong on `q1` only, so the difference
    // between the two strings is one character at index 0 -- and if an implementation reversed the
    // array or ordered by capability the strings would still be the right length, which is why the
    // assertion is on the exact text rather than on the lengths. The asymmetry is what makes the
    // reversal checkable: `'1110'` is a different string from `'0111'`.
    expect(report.ablation.featureCorrectByRun).toEqual(['1111', '0111']);
    expect(report.ablation.baselineCorrectByRun).toEqual(['1111', '0111']);
  });

  it('agrees with the first-repetition vector', async () => {
    // `featureCorrect` is the first repetition and the mask's first row claims to be the same pass.
    // Two shapes describing one pass, so they must be the same text; a mask that started anywhere
    // else would be a second, silently different account of the same three questions.
    //
    // Anchored on `featureCorrect` rather than on the roster: this fixture's system answers with a
    // bare string, so no per-question record is captured and `report.questions` is absent here. A
    // comparison against an empty roster would pass while asserting nothing, which is the failure
    // mode `test_ledger.py`'s `extra` parameter had.
    const report = await runAblationReport(dataset, oneFlipper('baseline'), oneFlipper('feature'), {
      runs: 2,
      scorer: exactMatchScorer,
    });

    expect(report.questions).toBeUndefined();
    expect(report.ablation.featureCorrect).toHaveLength(dataset.questions.length);
    expect(report.ablation.featureCorrectByRun?.[0]).toBe(
      correctnessMask(report.ablation.featureCorrect),
    );
  });

  it('omits the field when there is one repetition', async () => {
    // One pass makes the mask a second copy of `featureCorrect`, and two arrays that must agree are
    // two arrays that can disagree -- the reason `correctnessVector` is derived rather than stored.
    // `featureCorrect` already answers everything a one-pass run can be asked.
    const report = await runAblationReport(dataset, oneFlipper('baseline'), oneFlipper('feature'), {
      runs: 1,
      scorer: exactMatchScorer,
    });

    expect(report.ablation.featureCorrectByRun).toBeUndefined();
    expect(report.ablation.baselineCorrectByRun).toBeUndefined();
  });
});

describe('correctnessMask', () => {
  it('writes one character per question', () => {
    expect(correctnessMask([true, false, true])).toBe('101');
    expect(correctnessMask([])).toBe('');
  });

  it('does not treat a trailing false as absent', () => {
    // `'10'.trim()` and `'10'.replace(/0+$/, '')` are both mistakes a join can hide. The length is
    // the check that a mask still addresses every question.
    expect(correctnessMask([true, false])).toHaveLength(2);
    expect(correctnessMask([false])).toBe('0');
  });
});

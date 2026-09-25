import { describe, expect, it } from 'vitest';
import {
  attributeRecallGap,
  rankingGapFailureCount,
  type CapabilityAccuracy,
} from '../retrieval-attribution.js';

/**
 * The attribution is arithmetic over two artifacts, so every test constructs
 * both sides explicitly. Nothing here mocks the retrieval or the reader: the
 * unit under test receives numbers that came from an artifact and returns a
 * decomposition of them.
 *
 * The fixture numbers below are the real ones from the A2 dispatch
 * (`/tmp/lm_report`), because a synthetic fixture chosen for convenience would
 * not catch the failure this instrument exists to prevent -- a decomposition
 * that is arithmetically consistent and semantically wrong.
 */

/** The A2 baseline (no abstention feature): 500 questions, 401 correct. */
function a2Baseline(): CapabilityAccuracy[] {
  return [
    { capability: 'IE', total: 150, correct: 145, abstained: 0 },
    { capability: 'MR', total: 121, correct: 106, abstained: 0 },
    { capability: 'KU', total: 72, correct: 59, abstained: 0 },
    { capability: 'TR', total: 127, correct: 91, abstained: 0 },
    { capability: 'ABS', total: 30, correct: 0, abstained: 0 },
  ];
}

/** The A2 feature (abstention feature on): 500 questions, 430 correct. */
function a2Feature(): CapabilityAccuracy[] {
  return [
    { capability: 'IE', total: 150, correct: 145, abstained: 4 },
    { capability: 'MR', total: 121, correct: 106, abstained: 3 },
    { capability: 'KU', total: 72, correct: 59, abstained: 1 },
    { capability: 'TR', total: 127, correct: 91, abstained: 9 },
    { capability: 'ABS', total: 30, correct: 29, abstained: 29 },
  ];
}

describe('attributeRecallGap', () => {
  it('reports the ranking gap as a count of questions, not a percentage', () => {
    const result = attributeRecallGap({
      curve: { considered: 428, ceiling: 0.9626168224299065, recallAtOne: 0.3317757009345794 },
      baseline: a2Baseline(),
      feature: a2Feature(),
    });

    // 428 * 0.9626168224299065 = 412.0 -> 412 covered, 16 uncovered.
    // 428 * 0.3317757009345794 = 142.0 -> 142 admitted, so 270 covered but
    // not admitted.
    expect(result.retrievalGapQuestions).toBe(16);
    expect(result.rankingGapQuestions).toBe(270);
    expect(result.absentFromDenominatorQuestions).toBe(72);
  });

  it('subtracts the questions whose answers the reader never had to retrieve', () => {
    const result = attributeRecallGap({
      curve: { considered: 428, ceiling: 0.9626168224299065, recallAtOne: 0.3317757009345794 },
      baseline: a2Baseline(),
      feature: a2Feature(),
    });

    // ABS is 30 questions whose correct answer is to refuse: there is no
    // evidence turn to rank, so no ranking mechanism can move them. The curve
    // reports `abstention` exclusions for exactly this reason, which is why its
    // denominator is 428 and not 500 -- the gap of 270 is measured over
    // non-abstention questions only.
    expect(result.abstentionQuestions).toBe(30);

    // So the 270 is already abstention-free and must not be reduced again.
    // Subtracting here would double-remove the same 30 questions, and the
    // resulting 240 would be a number no measurement supports.
    expect(result.rankingGapQuestions).toBe(270);

    // Every capability except ABS was answered identically by both arms, so
    // the entire +29 is the abstention capability finding answers it previously
    // refused -- not one question of it came from retrieval or ranking.
    expect(result.improvementFromAbstention).toBe(29);
    expect(result.improvementFromOtherCapabilities).toBe(0);
  });

  it('separates the two components of the gap so each names the mechanism that could move it', () => {
    const result = attributeRecallGap({
      curve: { considered: 428, ceiling: 0.9626168224299065, recallAtOne: 0.3317757009345794 },
      baseline: a2Baseline(),
      feature: a2Feature(),
    });

    // The pool splits into covered and not-covered, and the covered part splits
    // again into admitted and not-admitted. Every question is in exactly one
    // leaf, so the leaves must reconstruct the denominator:
    //
    //   admittedAtOne + rankingGapQuestions + retrievalGapQuestions === considered
    //
    // The non-obvious half: `retrievalGapQuestions` is measured against
    // `considered`, not against `covered`. Writing `retrievalGap + rankingGap
    // === covered` looks like an equivalent identity and is wrong -- it silently
    // drops both the admitted set and retrieval's own gap from the sum.
    expect(result.admittedAtOne + result.rankingGapQuestions + result.retrievalGapQuestions).toBe(
      result.curveDenominator,
    );
    expect(result.admittedAtOne).toBe(142);
    expect(result.coveredQuestions).toBe(result.admittedAtOne + result.rankingGapQuestions);

    // The instrument must state the population each gap was measured over,
    // because both are computed against `considered` and not against the run's
    // question count. A reader comparing a gap of 270 against 500 questions
    // would be comparing two different sets.
    expect(result.curveDenominator).toBe(428);
    expect(result.runQuestionCount).toBe(500);
  });

  it('reports the ranking gap as unreachable when the reader already answers the covered questions', () => {
    // The defect this instrument exists to catch: a reader that answers
    // everything it is given scores high while the ranking gap stays large, so
    // the gap is not recoverable accuracy on this system.
    const result = attributeRecallGap({
      curve: { considered: 100, ceiling: 0.9, recallAtOne: 0.2 },
      baseline: [{ capability: 'IE', total: 100, correct: 90, abstained: 0 }],
      feature: [{ capability: 'IE', total: 100, correct: 90, abstained: 0 }],
    });

    // 100 covered, 20 admitted, so 70 covered-but-not-admitted.
    expect(result.rankingGapQuestions).toBe(70);
    // The reader got 90 of 100 right with only 20 admitted, which means it
    // answered at least 70 questions correctly whose evidence was not in the
    // top-1. Those 70 cannot be recovered by ranking better.
    expect(result.gapAlreadyAbsorbedByReader).toBe(70);
    expect(result.recoverableFromRanking).toBe(0);
  });

  it('counts only the first-answer misses when the reader fails a question it was given', () => {
    // 70 covered-but-unadmitted AND the reader fails 40 of them. The ranking
    // gap can address at most those 40, because the other 30 it already
    // answers correctly from whatever context it did receive.
    const result = attributeRecallGap({
      curve: { considered: 100, ceiling: 0.9, recallAtOne: 0.2 },
      baseline: [{ capability: 'IE', total: 100, correct: 50, abstained: 0 }],
      feature: [{ capability: 'IE', total: 100, correct: 50, abstained: 0 }],
    });

    expect(result.rankingGapQuestions).toBe(70);
    expect(result.gapAlreadyAbsorbedByReader).toBe(30);
    expect(result.recoverableFromRanking).toBe(40);
  });

  it('does not let an abstention capability inflate the recoverable figure', () => {
    // The curve is computed over the 70 non-abstention questions here, which is
    // what makes this fixture consistent with the real artifact: A2's
    // `considered` of 428 excludes all 30 ABS questions, and its ceiling is
    // stated against that 428. A fixture whose ceiling is stated against a
    // population larger than the one the curve scored would be internally
    // incoherent, and would make every derived count meaningless.
    const result = attributeRecallGap({
      curve: { considered: 70, ceiling: 1, recallAtOne: 0 },
      baseline: [
        { capability: 'IE', total: 70, correct: 0, abstained: 0 },
        { capability: 'ABS', total: 30, correct: 0, abstained: 0 },
      ],
      feature: [
        { capability: 'IE', total: 70, correct: 0, abstained: 0 },
        { capability: 'ABS', total: 30, correct: 29, abstained: 29 },
      ],
    });

    expect(result.abstentionQuestions).toBe(30);
    // All 70 in-curve questions are covered and none is admitted, so the gap is
    // the whole curve population and none of it is abstention.
    expect(result.rankingGapQuestions).toBe(70);
    expect(result.runQuestionCount).toBe(100);
    expect(result.absentFromDenominatorQuestions).toBe(30);
    // 70 of 70 non-abstention questions failed, so all 70 are recoverable in
    // principle -- and the 30 abstentions are not counted among them.
    expect(result.recoverableFromRanking).toBe(70);
  });

  it('names the capabilities that did not move between the two arms', () => {
    const result = attributeRecallGap({
      curve: { considered: 428, ceiling: 0.9626168224299065, recallAtOne: 0.3317757009345794 },
      baseline: a2Baseline(),
      feature: a2Feature(),
    });

    expect(result.unchangedCapabilities).toEqual(['IE', 'MR', 'KU', 'TR']);
  });

  it('reports zero gap rather than a negative one when the ceiling is below the achieved recall', () => {
    // A pool narrower than a requested cutoff makes achieved recall exceed the
    // ceiling. The curve clamps its own `gain` for the same reason; a negative
    // count here would read as "ranking work would make things worse".
    const result = attributeRecallGap({
      curve: { considered: 100, ceiling: 0.5, recallAtOne: 0.8 },
      baseline: [{ capability: 'IE', total: 100, correct: 80, abstained: 0 }],
      feature: [{ capability: 'IE', total: 100, correct: 80, abstained: 0 }],
    });

    expect(result.rankingGapQuestions).toBe(0);
    expect(result.retrievalGapQuestions).toBe(50);
  });

  it('ignores a capability the baseline did not measure instead of scoring it as a gain', () => {
    // The two arms must be compared over the same capabilities. If the feature
    // arm reports one the baseline does not -- a capability added between the
    // runs, or two artifacts from different dispatches -- then its whole correct
    // count would land in the improvement with nothing to compare against. That
    // is how a mismatched pair of artifacts turns into a fabricated delta, so
    // the entry is skipped and it contributes to neither improvement figure.
    const result = attributeRecallGap({
      curve: { considered: 10, ceiling: 1, recallAtOne: 0.5 },
      baseline: [{ capability: 'IE', total: 10, correct: 5, abstained: 0 }],
      feature: [
        { capability: 'IE', total: 10, correct: 7, abstained: 0 },
        { capability: 'XX', total: 40, correct: 40, abstained: 0 },
      ],
    });

    expect(result.improvementFromOtherCapabilities).toBe(2);
    expect(result.improvementFromAbstention).toBe(0);
    // The unmatched capability is not reported as unchanged either: it was
    // never measured twice, which is a different statement from "it did not
    // move".
    expect(result.unchangedCapabilities).toEqual([]);
    // And it is not counted in the run's population, which is taken from the
    // baseline -- the arm the run's accuracy belongs to.
    expect(result.runQuestionCount).toBe(10);
  });

  it('handles an empty curve without dividing by zero', () => {
    const result = attributeRecallGap({
      curve: { considered: 0, ceiling: 0, recallAtOne: 0 },
      baseline: [{ capability: 'IE', total: 0, correct: 0, abstained: 0 }],
      feature: [{ capability: 'IE', total: 0, correct: 0, abstained: 0 }],
    });

    expect(result.coveredQuestions).toBe(0);
    expect(result.rankingGapQuestions).toBe(0);
    expect(result.recoverableFromRanking).toBe(0);
  });
});

describe('rankingGapFailureCount', () => {
  it('is zero when the reader answers every covered question it was given', () => {
    expect(
      rankingGapFailureCount({ coveredQuestions: 100, admittedAtOne: 20, readerCorrect: 100 }),
    ).toBe(0);
  });

  it('is the covered-but-unadmitted count minus the questions the reader absorbed anyway', () => {
    expect(
      rankingGapFailureCount({ coveredQuestions: 100, admittedAtOne: 20, readerCorrect: 60 }),
    ).toBe(40);
  });

  it('never returns a negative count when the reader outruns the admitted set', () => {
    // The reader answers 20 correctly from the admitted set plus 5 from outside
    // it -- the arithmetic must clamp rather than report -5 failures.
    expect(
      rankingGapFailureCount({ coveredQuestions: 100, admittedAtOne: 20, readerCorrect: 105 }),
    ).toBe(0);
  });
});

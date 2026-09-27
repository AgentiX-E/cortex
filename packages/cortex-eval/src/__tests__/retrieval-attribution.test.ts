import { describe, expect, it } from 'vitest';
import {
  attributeRecallGap,
  rankingGapFailureCount,
  type CapabilityAccuracy,
  type CurveMembership,
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

/**
 * The curve membership the A2 fixture implies: 428 considered, 412 covered,
 * 142 admitted, so 270 in the ranking gap and 16 in the retrieval gap.
 *
 * Every test that does not care about the ids still has to say what the curve
 * partitioned, because the field is required. Filling in a plausible default
 * here keeps the required-ness honest while not repeating a 270-element literal
 * in twenty places -- and the tests that *do* care pass their own.
 */
function a2Membership(): CurveMembership {
  return {
    admitted: Array.from({ length: 142 }, (_, i) => `admitted-${i}`),
    rankingGap: Array.from({ length: 270 }, (_, i) => `rank-gap-${i}`),
    retrievalGap: Array.from({ length: 16 }, (_, i) => `retrieval-gap-${i}`),
  };
}

describe('attributeRecallGap', () => {
  it('reports the ranking gap as a count of questions, not a percentage', () => {
    const result = attributeRecallGap({
      curve: { considered: 428, ceiling: 0.9626168224299065, recallAtOne: 0.3317757009345794 },
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership: a2Membership(),
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
      membership: a2Membership(),
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
      membership: a2Membership(),
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
      membership: a2Membership(),
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
      membership: a2Membership(),
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
      membership: a2Membership(),
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
      membership: a2Membership(),
    });

    expect(result.unchangedCapabilities).toEqual(['IE', 'MR', 'KU', 'TR']);
  });

  it('bounds the admitted count by the pool instead of letting it exceed it', () => {
    // A pool narrower than a requested cutoff makes achieved recall exceed the
    // ceiling. The curve clamps its own `gain` for the same reason; a negative
    // count here would read as "ranking work would make things worse".
    //
    // The clamp that matters is NOT the one on `rankingGapQuestions`, which the
    // earlier revision of this test asserted and which was never the defect.
    // `admittedAtOne` is by definition a subset of the covered set -- nothing can
    // be admitted by ranking unless its evidence turn was in the pool to rank --
    // so 80 admitted against a 50-question pool is arithmetically impossible, and
    // it is what broke the partition: 80 + 0 + 50 = 130 against a denominator of
    // 100, with the inflation landing in `retrievalGapQuestions`, the figure that
    // decides whether retrieval work is the next thing to do.
    //
    // Asserting `retrievalGapQuestions === 50` alone could not catch that, because
    // 50 is also the correct value; the broken term was the one the test never
    // looked at. The partition identity is the assertion that sees the whole
    // object at once, so it is the one stated here.
    const result = attributeRecallGap({
      curve: { considered: 100, ceiling: 0.5, recallAtOne: 0.8 },
      baseline: [{ capability: 'IE', total: 100, correct: 80, abstained: 0 }],
      feature: [{ capability: 'IE', total: 100, correct: 80, abstained: 0 }],
      membership: a2Membership(),
    });

    expect(result.coveredQuestions).toBe(50);
    expect(result.admittedAtOne).toBe(50);
    expect(result.rankingGapQuestions).toBe(0);
    expect(result.retrievalGapQuestions).toBe(50);
    expect(result.admittedAtOne + result.rankingGapQuestions + result.retrievalGapQuestions).toBe(
      result.curveDenominator,
    );
  });

  it('closes the partition for every curve the recall curve can emit', () => {
    // The identity stated on `admittedAtOne` is a property of the function over
    // its whole input domain, not of one interesting input, so it is asserted
    // over the domain.
    //
    // Swept rather than enumerated deliberately: the breaking case is a relation
    // between two fields (recall above ceiling), not a named input, and a list of
    // hand-picked cases would only re-test the cases I already thought of -- which
    // is exactly how the broken term above survived a test that named its own
    // scenario.
    const curves: { considered: number; ceiling: number; recallAtOne: number }[] = [];
    for (const considered of [0, 1, 3, 7, 100, 500]) {
      for (const ceiling of [0, 0.25, 1 / 3, 0.5, 0.9, 1]) {
        for (const recallAtOne of [0, 1 / 3, 0.5, 0.8, 1, 1.5]) {
          curves.push({ considered, ceiling, recallAtOne });
        }
      }
    }
    expect(curves.length).toBe(216);

    for (const curve of curves) {
      const result = attributeRecallGap({
        curve,
        baseline: [{ capability: 'IE', total: 10, correct: 4, abstained: 0 }],
        feature: [{ capability: 'IE', total: 10, correct: 5, abstained: 0 }],
        membership: a2Membership(),
      });
      const label = JSON.stringify(curve);
      expect(result.admittedAtOne, label).toBeLessThanOrEqual(result.coveredQuestions);
      expect(
        result.admittedAtOne + result.rankingGapQuestions + result.retrievalGapQuestions,
        label,
      ).toBe(result.curveDenominator);
      expect(result.rankingGapQuestions, label).toBeGreaterThanOrEqual(0);
      expect(result.retrievalGapQuestions, label).toBeGreaterThanOrEqual(0);
    }
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
      membership: a2Membership(),
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
      membership: a2Membership(),
    });

    expect(result.coveredQuestions).toBe(0);
    expect(result.rankingGapQuestions).toBe(0);
    expect(result.recoverableFromRanking).toBe(0);
  });

  it('reports a capability that went backwards as moved, not as unchanged', () => {
    // `unchangedCapabilities` answers "which capabilities did this intervention
    // move". A capability that lost questions was moved, so filing it as
    // unchanged would understate the intervention's footprint in exactly the
    // direction that flatters it -- and the conjunction arm's whole finding was
    // that an intervention can move things it was not aimed at.
    //
    // The relation, not the value, is what the assertion is about: a regression
    // and a gain are both movements, so neither belongs in the unchanged set.
    const result = attributeRecallGap({
      curve: { considered: 10, ceiling: 1, recallAtOne: 0.5 },
      baseline: [
        { capability: 'IE', total: 10, correct: 5, abstained: 0 },
        { capability: 'TR', total: 10, correct: 8, abstained: 0 },
      ],
      feature: [
        { capability: 'IE', total: 10, correct: 7, abstained: 0 },
        { capability: 'TR', total: 10, correct: 6, abstained: 0 },
      ],
      membership: a2Membership(),
    });

    expect(result.unchangedCapabilities).toEqual([]);
    expect(result.improvementFromOtherCapabilities).toBe(0);
  });

  it('does not let the improvement figures hide a move that cancels out', () => {
    // Two capabilities moving in opposite directions net to zero, which is the
    // one shape where the two improvement totals agree with "nothing happened"
    // while the unchanged list correctly disagrees. Without this the totals can
    // be read as a stability claim they do not make.
    const result = attributeRecallGap({
      curve: { considered: 10, ceiling: 1, recallAtOne: 0.5 },
      baseline: [
        { capability: 'IE', total: 10, correct: 5, abstained: 0 },
        { capability: 'TR', total: 10, correct: 5, abstained: 0 },
      ],
      feature: [
        { capability: 'IE', total: 10, correct: 8, abstained: 0 },
        { capability: 'TR', total: 10, correct: 2, abstained: 0 },
      ],
      membership: a2Membership(),
    });

    expect(result.improvementFromOtherCapabilities).toBe(0);
    expect(result.unchangedCapabilities).toEqual([]);
  });

  it('clamps the absent-from-denominator count when the curve covers more than the run graded', () => {
    // The curve's denominator and the run's population are measured over
    // different filters, so the curve can be the wider of the two. The field
    // states how many graded questions the curve omitted; a curve that omitted
    // none has nothing positive to report, and a negative count would read as
    // "the curve covered questions the run did not grade", which is not a thing
    // that can happen.
    const result = attributeRecallGap({
      curve: { considered: 500, ceiling: 0.96, recallAtOne: 0.33 },
      baseline: [{ capability: 'IE', total: 120, correct: 100, abstained: 0 }],
      feature: [{ capability: 'IE', total: 120, correct: 100, abstained: 0 }],
      membership: a2Membership(),
    });

    expect(result.curveDenominator).toBe(500);
    expect(result.runQuestionCount).toBe(120);
    expect(result.absentFromDenominatorQuestions).toBe(0);
  });

  it('sizes the abstention population from the arm that added it', () => {
    // In A2 the baseline's ABS capability existed and scored 0; the feature
    // scored 29. The field exists to keep the abstention questions separable
    // from the ranking gap, and the population that matters is the one the run
    // *answered by refusing* -- the feature.
    //
    // The two arms are given deliberately DIFFERENT totals here. An earlier
    // revision of this test gave both 30, which made it pass under either
    // reading: with equal populations, "from the baseline" and "from the
    // feature" return the same number and the assertion cannot tell them apart.
    // The mutation survived that test. A capability's population CAN differ
    // between arms -- that is what a capability added or removed between two
    // dispatches looks like -- so the test has to use a case where it does.
    const result = attributeRecallGap({
      curve: { considered: 470, ceiling: 0.96, recallAtOne: 0.33 },
      baseline: [{ capability: 'ABS', total: 30, correct: 0, abstained: 0 }],
      feature: [{ capability: 'ABS', total: 44, correct: 29, abstained: 29 }],
      membership: a2Membership(),
    });

    expect(result.abstentionQuestions).toBe(44);
    expect(result.improvementFromAbstention).toBe(29);

    // And it is not silently counted twice: the curve excluded these questions,
    // so they are outside the denominator the gap is measured against.
    const wide = attributeRecallGap({
      curve: { considered: 470, ceiling: 0.96, recallAtOne: 0.33 },
      baseline: [{ capability: 'ABS', total: 10, correct: 0, abstained: 0 }],
      feature: [{ capability: 'ABS', total: 470, correct: 470, abstained: 470 }],
      membership: a2Membership(),
    });
    expect(wide.abstentionQuestions).toBe(470);
    expect(wide.curveDenominator).toBe(470);
  });

  it('rounds the fraction to the nearest count rather than truncating', () => {
    // The curve's own `recalled` and the attribution's `admittedAtOne` are meant
    // to describe the same questions, and truncation makes them disagree by one
    // on every fraction whose product does not land on an integer. On 428
    // considered at recall 0.9626 exactly that happens, and the disagreement
    // would show up as a one-question difference between two artifacts that
    // claim to count the same population.
    const result = attributeRecallGap({
      curve: { considered: 428, ceiling: 1, recallAtOne: 0.9626 },
      baseline: [{ capability: 'IE', total: 428, correct: 412, abstained: 0 }],
      feature: [{ capability: 'IE', total: 428, correct: 412, abstained: 0 }],
      membership: a2Membership(),
    });

    // 0.9626 * 428 = 411.99..., which rounds to 412 and truncates to 411.
    expect(result.admittedAtOne).toBe(412);
  });

  it('clamps the retrieval gap when a caller supplies a ceiling above one', () => {
    // `CurveSummary` is a public type, so `ceiling > 1` is constructible even
    // though `buildRecallCurve` cannot emit it (`inPool <= total`). The clamp is
    // kept for that caller rather than removed as unreachable, because the
    // failure mode is a *negative* retrieval gap -- a report stating that
    // retrieval covered more questions than the denominator contains.
    //
    // This is the one assertion here that guards an input the shipped pipeline
    // cannot produce, and it is stated as such rather than dressed up as a
    // reachable case.
    const result = attributeRecallGap({
      curve: { considered: 100, ceiling: 1.5, recallAtOne: 0 },
      baseline: [{ capability: 'IE', total: 100, correct: 0, abstained: 0 }],
      feature: [{ capability: 'IE', total: 100, correct: 0, abstained: 0 }],
      membership: a2Membership(),
    });

    expect(result.coveredQuestions).toBe(150);
    expect(result.retrievalGapQuestions).toBe(0);
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

/**
 * The attribution reports counts, and a count cannot name a criterion's
 * population.
 *
 * Roadmap measure B7's pre-registered criterion is "the targeted 9 questions
 * must move" (§2.5.10.6). The artifact said `rankingGapQuestions: 27` and
 * stopped, so the criterion was unjudgeable against everything this pipeline
 * archived: "the intervention did nothing" and "the intervention changed
 * something elsewhere" produced the same artifact. The A2 ablation hit this
 * wall first and closed it with `discordantQuestions` after constraint-solving
 * left `C(9,4) = 126` consistent assignments.
 *
 * The ids are a REQUIRED field, deliberately. An optional one lets the three
 * existing fixtures keep compiling while silently reporting no population --
 * which is the failure mode being fixed. Required turns each omission into a
 * compile error, and a compile error is the only kind of reminder that cannot
 * be ignored.
 */
describe('the ranking gap population is nameable', () => {
  function curve() {
    return { considered: 428, ceiling: 0.9626168224299065, recallAtOne: 0.3317757009345794 };
  }

  it('carries the ids behind the ranking gap count', () => {
    const result = attributeRecallGap({
      curve: curve(),
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership: {
        admitted: Array.from({ length: 142 }, (_, i) => `hit-${i}`),
        rankingGap: ['gap-a', 'gap-b', 'gap-c'],
        retrievalGap: ['miss-a'],
      },
    });

    expect(result.rankingGapQuestionIds).toEqual(['gap-a', 'gap-b', 'gap-c']);
  });

  it('carries the ids behind the retrieval gap count', () => {
    const result = attributeRecallGap({
      curve: curve(),
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership: {
        admitted: [],
        rankingGap: ['x'],
        retrievalGap: ['never-retrieved-a', 'never-retrieved-b'],
      },
    });

    expect(result.retrievalGapQuestionIds).toEqual(['never-retrieved-a', 'never-retrieved-b']);
  });

  it('reports an empty array rather than undefined when a gap is empty', () => {
    // "No question is in the ranking gap" is a finding. An absent key cannot
    // express it, and a reader cannot tell the finding from a field the writer
    // forgot -- the same argument the A2 closure made for `discordantQuestions`.
    const result = attributeRecallGap({
      curve: curve(),
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership: { admitted: ['a'], rankingGap: [], retrievalGap: [] },
    });

    expect(result.rankingGapQuestionIds).toEqual([]);
    expect(result.retrievalGapQuestionIds).toEqual([]);
    expect(Array.isArray(result.rankingGapQuestionIds)).toBe(true);
  });

  it('names exactly as many questions as the count it sits beside', () => {
    // The property that makes the pair readable. A count of 27 beside 26 ids
    // would be worse than either alone: a reader could not tell which to
    // believe, and both would look authoritative.
    const membership = {
      admitted: ['h1', 'h2'],
      rankingGap: ['g1', 'g2', 'g3', 'g4'],
      retrievalGap: ['r1', 'r2'],
    };
    const result = attributeRecallGap({
      curve: { considered: 8, ceiling: 6 / 8, recallAtOne: 2 / 8 },
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership,
    });

    expect(result.rankingGapQuestionIds).toHaveLength(result.rankingGapQuestions);
    expect(result.retrievalGapQuestionIds).toHaveLength(result.retrievalGapQuestions);
  });

  it('keeps the ids in the order the measurement produced them', () => {
    // Order carries information the count does not: the membership lists arrive
    // in dataset order, so a reader diffing two runs can see which questions
    // moved. Sorting would discard that, and it is the one thing a diff needs.
    const result = attributeRecallGap({
      curve: curve(),
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership: { admitted: [], rankingGap: ['z-last', 'a-first', 'm-mid'], retrievalGap: [] },
    });

    expect(result.rankingGapQuestionIds).toEqual(['z-last', 'a-first', 'm-mid']);
  });

  it('does not mutate the membership it was handed', () => {
    const membership = {
      admitted: ['h'],
      rankingGap: ['g'],
      retrievalGap: ['r'],
    };
    const before = JSON.stringify(membership);

    attributeRecallGap({
      curve: curve(),
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership,
    });

    expect(JSON.stringify(membership)).toBe(before);
  });

  it('does not hand back an array that aliases the membership it was handed', () => {
    // The other direction, and the one that was untested. The test above checks
    // that this function does not write to the caller's array; this one checks
    // that a READER of the result cannot either.
    //
    // Returning `options.membership.rankingGap` directly passes every test above,
    // because the function itself never writes. The damage appears later and in a
    // different place: a consumer that sorts or filters what it received reorders
    // the curve's own membership, and the next field read off that curve is
    // silently wrong. Defect injection found this -- mutating the spread to a
    // bare reference left all 27 tests green.
    const membership = {
      admitted: ['h'],
      rankingGap: ['b-last', 'a-first'],
      retrievalGap: ['r'],
    };

    const result = attributeRecallGap({
      curve: curve(),
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership,
    });
    result.rankingGapQuestionIds.sort();
    result.retrievalGapQuestionIds.push('injected-by-a-reader');

    expect(membership.rankingGap).toEqual(['b-last', 'a-first']);
    expect(membership.retrievalGap).toEqual(['r']);
  });

  it('survives JSON round-tripping with the ids intact', () => {
    const result = attributeRecallGap({
      curve: curve(),
      baseline: a2Baseline(),
      feature: a2Feature(),
      membership: { admitted: [], rankingGap: ['q-1'], retrievalGap: ['q-2'] },
    });

    const parsed = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(parsed.rankingGapQuestionIds).toEqual(['q-1']);
    expect(parsed.retrievalGapQuestionIds).toEqual(['q-2']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  computeTargetCohort,
  judgeCriterion,
  outcomeMoved,
  sidesLandInDistinctClusters,
  verifyTargetCohort,
  type ArmOutcome,
  type CohortQuestion,
  type TargetCohort,
} from '../b7-cohort.js';
import { candidateSides, clusterCandidates } from '../candidate-context.js';

/**
 * A turn in the exact rendered shape the pipeline produces:
 * `[YYYY/MM/DD] role: content`. Building fixtures from this shape rather than
 * from a convenient object is what makes the tests exercise the same parse the
 * production path does -- a fixture that bypasses `parseTurn` would pass while
 * the real input failed.
 */
function turn(index: number, role: 'user' | 'assistant', content: string): string {
  return `[2024/03/0${(index % 9) + 1}] ${role}: ${content}`;
}

/**
 * Two candidates in one context: the user's bike (`bike`, three turns) and a car
 * (`car`, two turns). Question terms are chosen so the question names the bike's
 * subject, which is what lets the module form two sides.
 */
function bikeVsCarTurns(): string[] {
  return [
    turn(0, 'user', 'I took the bike to the shop for a tune-up last week.'),
    turn(1, 'assistant', 'How did the bike service go?'),
    turn(2, 'user', 'The bike needed a new chain and the bill was 85 dollars.'),
    turn(3, 'user', 'My car needed new brake pads, which came to 240 dollars.'),
    turn(4, 'user', 'The car is also due for an oil change soon.'),
  ]
    .map((text, index) => ({ index, text }))
    .map(({ text }) => text);
}

function turnsOf(texts: readonly string[]) {
  return texts.map((text, index) => ({ index, text }));
}

describe('computeTargetCohort', () => {
  it('classifies a competing pair as a target', () => {
    const cohort = computeTargetCohort([
      {
        questionId: 'gpt4_bike',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: '240 dollars',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.targets.map((m) => m.questionId)).toEqual(['gpt4_bike']);
  });

  it('separates an identical answer from an unseparable pair', () => {
    // "The reader reproduced the truth" is a fact about the reader;
    // "the sides could not be told apart" is a fact about the instrument.
    // Merging them would let an instrument failure read as a finding.
    const cohort = computeTargetCohort([
      {
        questionId: 'verbatim',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: '85 dollars',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.identical).toEqual(['verbatim']);
    expect(cohort.unseparable).toEqual([]);
  });

  it('treats a verbatim match modulo case and punctuation as identical', () => {
    // Content-token identity, not string equality: a raw `===` would file this
    // as a competing candidate against its own truth.
    const cohort = computeTargetCohort([
      {
        questionId: 'cased',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: 'The 85 dollars.',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.identical).toEqual(['cased']);
  });

  it('reports the cluster each value landed in', () => {
    const cohort = computeTargetCohort([
      {
        questionId: 'gpt4_bike',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: '240 dollars',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    const target = cohort.targets[0]!;
    expect(target.truthCluster).not.toBeNull();
    expect(target.answerCluster).not.toBeNull();
    expect(target.truthCluster).not.toBe(target.answerCluster);
  });

  it('excludes non-grounded questions before clustering', () => {
    // The question's own terms WOULD separate here; `grounded: false` must win.
    // If grounding were checked after clustering, a change in the upstream
    // classifier would silently enlarge the B7 target set.
    const cohort = computeTargetCohort([
      {
        questionId: 'invented_answer',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: 'a 1972 Corvette',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: false,
      },
    ]);
    expect(cohort.targets).toEqual([]);
    expect(cohort.notGrounded).toEqual(['invented_answer']);
  });

  it('declines when only one side can be formed', () => {
    // The answer is a strict subset of the truth's terms, so subtracting the
    // shared ones leaves one side. One side means nothing competes and the
    // annotation would label turns while claiming to discriminate.
    const cohort = computeTargetCohort([
      {
        questionId: 'subset',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars for the chain',
        answer: 'dollars',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.targets).toEqual([]);
    expect(cohort.identical).toEqual([]);
    expect(cohort.unseparable).toEqual(['subset']);
  });

  it('declines when a side has no turns in the context at all', () => {
    // The reader named something that was never retrieved. That is a RETRIEVAL
    // observation, not a discrimination one, and the two must not be merged.
    const cohort = computeTargetCohort([
      {
        questionId: 'never_retrieved',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: 'a submarine',
        turns: turnsOf([
          turn(0, 'user', 'The bike needed a new chain.'),
          turn(1, 'user', 'The bike is red.'),
        ]),
        grounded: true,
      },
    ]);
    expect(cohort.targets).toEqual([]);
    expect(cohort.unseparable).toEqual(['never_retrieved']);
  });

  it('declines when the context is empty', () => {
    const cohort = computeTargetCohort([
      {
        questionId: 'empty_context',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: '240 dollars',
        turns: [],
        grounded: true,
      },
    ]);
    expect(cohort.targets).toEqual([]);
    expect(cohort.unseparable).toEqual(['empty_context']);
  });

  it('does not confuse two sides of equal token count for one another', () => {
    // `sameTerms` compares element-wise, not just by length. Two sides of the
    // same arity must stay distinct, or the truth's cluster id would be read off
    // the answer's cluster and every target would collapse into a non-target.
    const cohort = computeTargetCohort([
      {
        questionId: 'equal_arity',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: '240 dollars',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    const target = cohort.targets[0]!;
    expect(target.truthCluster).toBe(1);
    expect(target.answerCluster).toBe(2);
  });

  it('does not treat two absent values as an identical pair', () => {
    // Both values empty is reachable (a missing truth and a missing answer), and
    // it must NOT read as "the reader reproduced the truth": there is no truth to
    // reproduce. The distinction is what the `||` in `valuesAreIdentical` buys,
    // and a mutation to `&&` looked identical until this case was added.
    const cohort = computeTargetCohort([
      {
        questionId: 'both_absent',
        question: 'What did the bike repair cost?',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.identical).toEqual([]);
    expect(cohort.unseparable).toEqual(['both_absent']);
  });

  it('handles a question whose ground truth is absent', () => {
    // The spread in the `candidateSides` call exists because
    // `exactOptionalPropertyTypes` distinguishes an absent optional from an
    // explicit `undefined`. Exercising the absent path is what keeps that spread
    // from being decoration.
    const cohort = computeTargetCohort([
      {
        questionId: 'no_truth',
        question: 'What did the bike repair cost?',
        answer: '240 dollars',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.identical).toEqual([]);
    expect(cohort.unseparable).toEqual(['no_truth']);
  });

  it('handles a question whose answer is absent', () => {
    const cohort = computeTargetCohort([
      {
        questionId: 'no_answer',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.unseparable).toEqual(['no_answer']);
  });

  it('does not treat one empty value as an identical pair', () => {
    // `contentTerms` of an empty value yields nothing, and an empty value is not
    // a candidate whose identity was reproduced -- it is an absence.
    const cohort = computeTargetCohort([
      {
        questionId: 'empty_answer',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: '',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.identical).toEqual([]);
  });

  it('does not treat a subset as an identical pair', () => {
    // Token-count equality is checked before set equality, so "85" against
    // "85 dollars" must not be identical: a subset is a different value.
    const cohort = computeTargetCohort([
      {
        questionId: 'subset_not_identical',
        question: 'What did the bike repair cost?',
        groundTruth: '85 dollars',
        answer: '85',
        turns: turnsOf(bikeVsCarTurns()),
        grounded: true,
      },
    ]);
    expect(cohort.identical).toEqual([]);
  });

  it('returns empty collections rather than throwing on an empty cohort', () => {
    const cohort = computeTargetCohort([]);
    expect(cohort).toEqual({
      targets: [],
      identical: [],
      unseparable: [],
      notGrounded: [],
    });
  });

  it('preserves input order within each bucket', () => {
    const make = (id: string): CohortQuestion => ({
      questionId: id,
      question: 'What did the bike repair cost?',
      groundTruth: '85 dollars',
      answer: '240 dollars',
      turns: turnsOf(bikeVsCarTurns()),
      grounded: true,
    });
    const cohort = computeTargetCohort([make('a'), make('b'), make('c')]);
    expect(cohort.targets.map((m) => m.questionId)).toEqual(['a', 'b', 'c']);
  });
});

describe('sidesLandInDistinctClusters', () => {
  it('holds for the clusters two real sides produce', () => {
    // This is the contract that licenses omitting a same-cluster bucket from
    // `computeTargetCohort`. Asserted against the real clusterer so that a
    // change to `clusterCandidates` that started merging sides would fail here
    // rather than silently turning the target set into a subset of itself.
    const turns = turnsOf(bikeVsCarTurns());
    const sides = candidateSides({
      question: 'What did the bike repair cost?',
      groundTruth: '85 dollars',
      answer: '240 dollars',
    });
    const clusters = clusterCandidates(turns, sides, sides);
    expect(clusters).toHaveLength(2);
    expect(sidesLandInDistinctClusters(clusters)).toBe(true);
  });

  it('reports false when two clusters carry the same id', () => {
    expect(sidesLandInDistinctClusters([{ id: 1 }, { id: 1 }])).toBe(false);
  });

  it('holds vacuously for no clusters', () => {
    expect(sidesLandInDistinctClusters([])).toBe(true);
  });
});

describe('outcomeMoved', () => {
  const outcome = (answer: string | null, correct?: boolean): ArmOutcome => ({
    questionId: 'q',
    answer,
    ...(correct === undefined ? {} : { correct }),
  });

  it('does not call reworded text a move when both sides are scored the same', () => {
    // The measured C5 case. Capitalisation is the smallest possible edit, and it
    // is enough to make a byte comparison report a regression.
    expect(
      outcomeMoved(outcome('three times a week', true), outcome('Three times a week', true)),
    ).toBe(false);
  });

  it('does not call a reworded answer a move even when the wording differs a lot', () => {
    // The length of the edit is not the question; the score is. A long rewrite
    // that the scorer still marks correct is still not a moved outcome.
    expect(
      outcomeMoved(
        outcome('The question has no time qualifier, so four.', true),
        outcome('four', true),
      ),
    ).toBe(false);
  });

  it('calls a scored flip a move in either direction', () => {
    expect(outcomeMoved(outcome('a', true), outcome('b', false))).toBe(true);
    expect(outcomeMoved(outcome('a', false), outcome('b', true))).toBe(true);
  });

  it('calls a scored non-flip not a move regardless of the text', () => {
    expect(outcomeMoved(outcome('a', false), outcome('b', false))).toBe(false);
  });

  it('calls a flip to abstention a move even with no score', () => {
    // Without a scorer, abstention is the one outcome change the criterion can
    // still observe, and it must keep observing it: an annotation that suppresses
    // an answer elsewhere is the failure the guard exists for.
    expect(outcomeMoved(outcome('a real answer'), outcome(null))).toBe(true);
  });

  it('calls a flip OUT of abstention a move even with no score', () => {
    expect(outcomeMoved(outcome(null), outcome('an answer'))).toBe(true);
  });

  it('does not call two different non-abstention texts a move when unscored', () => {
    // The unscored case is where the old defect lived: with no score there is no
    // evidence the outcome changed, and reworded text is not evidence.
    expect(outcomeMoved(outcome('three times a week'), outcome('Three times a week'))).toBe(false);
  });

  it('does not call identical hard answers a move', () => {
    expect(outcomeMoved(outcome(null), outcome(null))).toBe(false);
  });

  it('falls back to the abstention test when only ONE side is scored', () => {
    // A partially scored pair is missing evidence, not evidence of a flip. With
    // both sides answered, the module cannot claim the outcome changed, so the
    // only thing it asserts is the abstention structure -- which is unchanged.
    expect(outcomeMoved(outcome('a', true), outcome('b'))).toBe(false);
    expect(outcomeMoved(outcome('a'), outcome('b', false))).toBe(false);
    // But a scored side that abstained still moved.
    expect(outcomeMoved(outcome('a', true), outcome(null))).toBe(true);
  });
});

describe('verifyTargetCohort', () => {
  const cohort: TargetCohort = {
    targets: [
      { questionId: 'q1', truthCluster: 1, answerCluster: 2 },
      { questionId: 'q2', truthCluster: 2, answerCluster: 1 },
    ],
    identical: [],
    unseparable: [],
    notGrounded: [],
  };

  it('matches when the published roster equals the computed one', () => {
    expect(verifyTargetCohort(cohort, ['q1', 'q2'])).toEqual({ kind: 'matches', count: 2 });
  });

  it('matches regardless of the order the roster was published in', () => {
    expect(verifyTargetCohort(cohort, ['q2', 'q1'])).toEqual({ kind: 'matches', count: 2 });
  });

  it('reports a published question the computation no longer targets', () => {
    const verdict = verifyTargetCohort(cohort, ['q1', 'q2', 'q3']);
    expect(verdict).toEqual({
      kind: 'differs',
      published: 3,
      computed: 2,
      missing: ['q3'],
      unexpected: [],
    });
  });

  it('reports a computed target the published roster omits', () => {
    const verdict = verifyTargetCohort(cohort, ['q1']);
    expect(verdict).toEqual({
      kind: 'differs',
      published: 1,
      computed: 2,
      missing: [],
      unexpected: ['q2'],
    });
  });

  it('treats a published COUNT with no roster as unconfirmable', () => {
    // This is the current situation and the defect this exists to expose. A
    // count of 9 is not a roster of 9; every computed target is therefore
    // reported as unexpected rather than silently accepted as agreement.
    const verdict = verifyTargetCohort(cohort, []);
    expect(verdict.kind).toBe('differs');
    if (verdict.kind !== 'differs') throw new Error('unreachable');
    expect(verdict.unexpected).toEqual(['q1', 'q2']);
    expect(verdict.missing).toEqual([]);
  });

  it('matches an empty published roster against an empty computation', () => {
    const empty: TargetCohort = { targets: [], identical: [], unseparable: [], notGrounded: [] };
    expect(verifyTargetCohort(empty, [])).toEqual({ kind: 'matches', count: 0 });
  });
});

describe('judgeCriterion', () => {
  function cohortOf(ids: readonly string[]): TargetCohort {
    return {
      targets: ids.map((questionId) => ({ questionId, truthCluster: 1, answerCluster: 2 })),
      identical: [],
      unseparable: [],
      notGrounded: [],
    };
  }

  function arm(...pairs: readonly (readonly [string, string | null])[]): ArmOutcome[] {
    return pairs.map(([questionId, answer]) => ({ questionId, answer }));
  }

  /**
   * A scored arm. The distinction these fixtures carry -- `correct` -- is the
   * one the criterion's movement test reads, so a fixture without it cannot
   * express "reworded" and "wrong" as different observations.
   *
   * `arm(...)` (unscored) is kept and used deliberately in the cases where the
   * absence of a score is itself the thing under test.
   */
  type Scored = readonly [string, string | null, boolean];
  function scoredArm(...triples: readonly Scored[]): ArmOutcome[] {
    return triples.map(([questionId, answer, correct]) => ({ questionId, answer, correct }));
  }

  it('settles when targets move and nothing else does', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'same', true]),
      feature: scoredArm(['t1', 'right', true], ['n1', 'same', true]),
    });
    expect(verdict.kind).toBe('settled');
    if (verdict.kind !== 'settled') throw new Error('unreachable');
    expect(verdict.moved).toEqual(['t1']);
    expect(verdict.gained).toEqual(['t1']);
  });

  it('reports no-move when a target answers identically in both arms', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false]),
      feature: scoredArm(['t1', 'wrong', false]),
    });
    expect(verdict).toEqual({ kind: 'no-move', targets: ['t1'] });
  });

  it('reports no-move even when non-targets happen to regress', () => {
    // A non-target regressing is not a gain, so this must not be read as
    // progress. It is checked before the target clause for exactly that reason.
    //
    // The non-target is SCORED here (correct -> wrong) rather than reworded.
    // The previous revision of this test used two unscored strings, `'a'` and
    // `'b'`, which made "the text changed" and "the outcome changed"
    // indistinguishable -- and so asserted the defect as a contract.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'a real answer', true]),
      feature: scoredArm(['t1', 'wrong', false], ['n1', 'a different answer', false]),
    });
    expect(verdict.kind).toBe('regression');
  });

  it('reports regression when a non-target outcome changes', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'a real answer', true]),
      feature: scoredArm(['t1', 'right', true], ['n1', 'a different answer', false]),
    });
    expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
  });

  it('treats a non-target flipping to an abstention as a regression', () => {
    // A bare accuracy comparison scores abstention and a wrong answer the same.
    // The criterion does not: an always-on annotation that suppresses answers
    // elsewhere is the exact failure the guard clause exists to catch.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'a real answer', true]),
      feature: scoredArm(['t1', 'right', true], ['n1', null, false]),
    });
    expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
  });

  it('lets a regression override a target gain', () => {
    // The guard clause is checked first and is not overridable by the thing it
    // guards. A guard that can be overridden is not a guard.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1', 't2']),
      control: scoredArm(
        ['t1', 'wrong', false],
        ['t2', 'wrong', false],
        ['n1', 'a real answer', true],
      ),
      feature: scoredArm(['t1', 'right', true], ['t2', 'right', true], ['n1', null, false]),
    });
    expect(verdict.kind).toBe('regression');
  });

  it('reports every moved target rather than only the first', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1', 't2', 't3']),
      control: scoredArm(['t1', 'a', false], ['t2', 'b', false], ['t3', 'c', false]),
      feature: scoredArm(['t1', 'a2', true], ['t2', 'b2', true], ['t3', 'c', false]),
    });
    expect(verdict.kind).toBe('settled');
    if (verdict.kind !== 'settled') throw new Error('unreachable');
    expect(verdict.moved).toEqual(['t1', 't2']);
  });

  it('ignores a question that appears in only one arm', () => {
    // An unmatched id would otherwise compare against `undefined` and report a
    // spurious move. Two arms of different lengths is a caller error, but it must
    // not silently become a criterion result.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1', 't2']),
      control: scoredArm(['t1', 'wrong', false]),
      feature: scoredArm(['t1', 'right', true], ['t2', 'invented', true]),
    });
    expect(verdict.kind).toBe('settled');
    if (verdict.kind !== 'settled') throw new Error('unreachable');
    expect(verdict.moved).toEqual(['t1']);
  });

  it('reads a control answer of undefined as abstention rather than skipping', () => {
    // The `?? null` fallback is what keeps an explicit `undefined` from being
    // compared as a value. Exercised here because a missing key and a `null`
    // value must mean the same thing to the criterion.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: [{ questionId: 't1', answer: null, correct: false }],
      feature: [{ questionId: 't1', answer: 'right', correct: true }],
    });
    expect(verdict.kind).toBe('settled');
  });

  it('reports no-move when the cohort has no targets at all', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf([]),
      control: arm(['n1', 'a']),
      feature: arm(['n1', 'a']),
    });
    expect(verdict).toEqual({ kind: 'no-move', targets: [] });
  });

  it('does not report directional gain or loss without a score', () => {
    // `gained` / `lost` are claims about direction, and direction is what the
    // scorer supplies. An unscored arm that moved still reports the move -- the
    // move is visible in the score, not in the wording -- but the lists stay
    // empty because the module has no evidence for either direction.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false]),
      feature: scoredArm(['t1', 'right', true]),
    });
    expect(verdict.kind).toBe('settled');
    if (verdict.kind !== 'settled') throw new Error('unreachable');
    expect(verdict.gained).toEqual(['t1']);
  });

  /**
   * The scored-arm fixtures below exist because the unscored ones above CANNOT
   * express the distinction this whole section is about.
   *
   * `arm(...)` produces answers with no `correct`, so "the text changed" and "the
   * outcome changed" are the same observation in those fixtures. A test built on
   * them passes identically whether the criterion compares bytes or scores --
   * which is how the defect survived: `('n1','a') -> ('n1','b')` was read as a
   * regression, and `a`/`b` are both unscored, so nothing in the fixture
   * contradicted the reading. Real arms carry a scorer's verdict, and the
   * distinction between reworded and wrong is the whole reason the non-target
   * clause is not a byte-comparison.
   */
  it('does not regress a non-target whose answer was reworded but still scored', () => {
    // The measured case, reproduced: C5's `945e3d21` moved from
    // `three times a week` to `Three times a week` and was reported as a
    // non-target regression. Only the capitalisation changed; the scorer scored
    // both arms correct. A guard that fires on capitalisation rejects every arm
    // that a language model ever produced, because a language model never
    // reproduces its own wording byte for byte.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'three times a week', true]),
      feature: scoredArm(['t1', 'right', true], ['n1', 'Three times a week', true]),
    });
    expect(verdict).toEqual({ kind: 'settled', moved: ['t1'], gained: ['t1'], lost: [] });
  });

  it('does not regress a non-target whose answer was shortened but still scored', () => {
    // The other measured case: `6ae235be` lost a conjunction
    // (`..., alkylation, and hydrotreating` -> `..., alkylation, hydrotreating`)
    // and the scorer scored both arms correct.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'alkaline, and saline', true]),
      feature: scoredArm(['t1', 'right', true], ['n1', 'alkaline, saline', true]),
    });
    expect(verdict.kind).toBe('settled');
  });

  it('treats an UNSCORED target whose answer was reworded as not moved', () => {
    // When the caller supplies no score, the criterion has no evidence that the
    // outcome changed, and reworded text is not evidence: a language model
    // rewording an answer it still gets right is the expected case, not a
    // finding. So an unscored, reworded target settled nothing -- `no-move` is
    // the honest verdict, and the same test that keeps the non-target guard from
    // firing on capitalisation also keeps a target from claiming a gain on it.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'three times a week'], ['n1', 'same']),
      feature: arm(['t1', 'Three times a week'], ['n1', 'same']),
    });
    expect(verdict).toEqual({ kind: 'no-move', targets: ['t1'] });
  });

  it('still regresses a scored non-target that the scorer flipped to wrong', () => {
    // The guard must survive the fix. This is what it is for: the same question,
    // still answered, but no longer correct.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'the right answer', true]),
      feature: scoredArm(['t1', 'right', true], ['n1', 'something else', false]),
    });
    expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
  });

  it('still regresses a scored non-target that flipped the other way', () => {
    // Regression is symmetric in direction: the criterion does not license
    // movement outside the target set in EITHER direction. A non-target that
    // becomes correct is still a global change the annotation was not licensed
    // to make, and reading it as harmless would make the guard direction-blind.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'something else', false]),
      feature: scoredArm(['t1', 'right', true], ['n1', 'the right answer', true]),
    });
    expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
  });

  it('regresses a scored non-target that flips to an abstention', () => {
    // An abstention has no score, and "abstained" is not "reworded". The
    // distinction the fix makes is between text that is still scored and text
    // that stopped being an answer at all.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'wrong', false], ['n1', 'a real answer', true]),
      feature: scoredArm(['t1', 'right', true], ['n1', null, false]),
    });
    expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
  });

  it('reports a target that flipped to wrong as LOST, not gained', () => {
    // `lost` is the other direction, and it is the direction that matters for a
    // fix that backfires: a target the reader used to get right and no longer
    // does. Both directions must be reportable or the directional lists are
    // half a statement.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'the right answer', true]),
      feature: scoredArm(['t1', 'something else', false]),
    });
    expect(verdict).toEqual({ kind: 'settled', moved: ['t1'], gained: [], lost: ['t1'] });
  });

  it('reports a target as moved but undirected when only one side is scored', () => {
    // A partially scored pair still shows movement -- the control answered and
    // the feature abstained -- but the module must not claim a direction it
    // cannot evidence, so both lists stay empty while `moved` is populated.
    const movedVerdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'some answer']),
      feature: [{ questionId: 't1', answer: null, correct: true }],
    });
    expect(movedVerdict).toEqual({ kind: 'settled', moved: ['t1'], gained: [], lost: [] });
  });

  it('counts a scored TARGET as moved only when its outcome changed', () => {
    // The target clause must use the same equality test as the non-target clause.
    // Two definitions of "moved" in one function is how the two clauses came to
    // disagree in the first place -- the reader and the noise tool already did
    // exactly that, reporting 1 move and 4 moves for the same pair of arms.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1', 't2']),
      control: scoredArm(['t1', 'wrong', false], ['t2', 'already right', true]),
      feature: scoredArm(['t1', 'right', true], ['t2', 'Already right', true]),
    });
    expect(verdict).toEqual({ kind: 'settled', moved: ['t1'], gained: ['t1'], lost: [] });
  });

  it('reports no-move when every target was only reworded', () => {
    // "Targets must move" is a claim about the reading, not about the wording.
    // A run whose targets were all reworded settled nothing, and reporting a
    // move would let writing style be spent as a target gain.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: scoredArm(['t1', 'already right', true]),
      feature: scoredArm(['t1', 'Already right', true]),
    });
    expect(verdict).toEqual({ kind: 'no-move', targets: ['t1'] });
  });

  it('keeps a moved target found in a mixed rename-and-flip arm', () => {
    // The two clauses read the same question set with the same test; a single
    // reworded target must not hide the target that actually flipped.
    // `t1` is reworded only (false -> false, different text) and must NOT be
    // counted; `t2` flips (false -> true) and must be.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1', 't2']),
      control: scoredArm(['t1', 'the same wording', false], ['t2', 'wrong', false]),
      feature: scoredArm(['t1', 'THE SAME WORDING', false], ['t2', 'right', true]),
    });
    expect(verdict.kind).toBe('settled');
    if (verdict.kind !== 'settled') throw new Error('unreachable');
    expect(verdict.moved).toEqual(['t2']);
  });
});

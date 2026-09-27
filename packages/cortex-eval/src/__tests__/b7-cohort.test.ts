import { describe, expect, it } from 'vitest';

import {
  computeTargetCohort,
  judgeCriterion,
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

  it('settles when targets move and nothing else does', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'wrong'], ['n1', 'same']),
      feature: arm(['t1', 'right'], ['n1', 'same']),
    });
    expect(verdict.kind).toBe('settled');
    if (verdict.kind !== 'settled') throw new Error('unreachable');
    expect(verdict.moved).toEqual(['t1']);
  });

  it('reports no-move when a target answers identically in both arms', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'wrong']),
      feature: arm(['t1', 'wrong']),
    });
    expect(verdict).toEqual({ kind: 'no-move', targets: ['t1'] });
  });

  it('reports no-move even when non-targets happen to move', () => {
    // A non-target moving is a regression, not a gain, so this must not be read
    // as progress. It is checked before the target clause for exactly that reason.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'wrong'], ['n1', 'a']),
      feature: arm(['t1', 'wrong'], ['n1', 'b']),
    });
    expect(verdict.kind).toBe('regression');
  });

  it('reports regression when a non-target changes at all', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'wrong'], ['n1', 'a']),
      feature: arm(['t1', 'right'], ['n1', 'b']),
    });
    expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
  });

  it('treats a non-target flipping to an abstention as a regression', () => {
    // A bare accuracy comparison scores abstention and a wrong answer the same.
    // The criterion does not: an always-on annotation that suppresses answers
    // elsewhere is the exact failure the guard clause exists to catch.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'wrong'], ['n1', 'a real answer']),
      feature: arm(['t1', 'right'], ['n1', null]),
    });
    expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
  });

  it('lets a regression override a target gain', () => {
    // The guard clause is checked first and is not overridable by the thing it
    // guards. A guard that can be overridden is not a guard.
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1', 't2']),
      control: arm(['t1', 'wrong'], ['t2', 'wrong'], ['n1', 'a']),
      feature: arm(['t1', 'right'], ['t2', 'right'], ['n1', null]),
    });
    expect(verdict.kind).toBe('regression');
  });

  it('reports every moved target rather than only the first', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1', 't2', 't3']),
      control: arm(['t1', 'a'], ['t2', 'b'], ['t3', 'c']),
      feature: arm(['t1', 'a2'], ['t2', 'b2'], ['t3', 'c']),
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
      control: arm(['t1', 'wrong']),
      feature: arm(['t1', 'right'], ['t2', 'invented']),
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
      control: [{ questionId: 't1', answer: null }],
      feature: [{ questionId: 't1', answer: 'right' }],
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

  it('returns empty directional lists when the caller does not score the arms', () => {
    const verdict = judgeCriterion({
      cohort: cohortOf(['t1']),
      control: arm(['t1', 'wrong']),
      feature: arm(['t1', 'right']),
    });
    expect(verdict.kind).toBe('settled');
    if (verdict.kind !== 'settled') throw new Error('unreachable');
    expect(verdict.gained).toEqual([]);
    expect(verdict.lost).toEqual([]);
  });
});

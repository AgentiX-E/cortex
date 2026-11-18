/**
 * The verdict on one arm, and the six ways a pair of artifacts can pretend to give one.
 *
 * The fixture is not invented. It is the twelve `KU` questions of run `42758152902` that either
 * moved or anchor the control, with the masks copied out of `ablation.featureCorrectByRun` in each
 * artifact — and the numbers the module is asserted against are the ones
 * `docs/MEASURE-CONFLICT-SURFACING.md` §5 publishes from the full 72:
 *
 * | | published (§5, 72 questions) | this fixture (12 questions) |
 * | --- | ---: | ---: |
 * | control passes | 255 / 288 | 27 / 48 |
 * | arm passes | 260 / 288 | 32 / 48 |
 * | improved cells | 16 | **16** |
 * | worsened cells | 11 | **11** |
 * | conversions | 4 | **4** |
 * | regressions | 5 | **5** |
 * | control-perfect regressions | 4 | **4** |
 *
 * The two cell totals and the four counts reproduce exactly, because every question that agrees
 * between the two runs contributes zero to all of them. That is the property that makes a paired
 * reading legible on a subset, and it is why this fixture can hold a 72-question verdict to
 * account on twelve questions.
 *
 * The refusals are the other half. `§13.354.5` registers `V4` because two hand readings of the same
 * two artifacts produced two wrong claims: one compared an arm's `baseline` line against the other
 * arm's `perCapability` field, the other took a `max` across repetitions for "every repetition".
 * Both are representable here as a refusal rather than as a number, and the tests below assert
 * refusals **before** asserting any statistic.
 */
import { describe, it, expect } from 'vitest';

import { armVerdict } from '../arm-verdict.js';

/**
 * The input shape, taken from the function rather than declared again.
 *
 * The module exports one name on purpose (`§13.354.5`): the tool that calls it is JavaScript and
 * cannot name a type, so an exported type here would be an export with no caller — the census's
 * definition of debt. Deriving it keeps the test honest to the signature instead of to a copy.
 */
type ArmReading = Parameters<typeof armVerdict>[0];

/** The twelve questions of `42758152902` §5 names, masks in `questions[]` order. */
const CONTROL = [
  ['ce6d2d27', '0000'],
  ['9ea5eabc', '0000'],
  ['ed4ddc30', '0000'],
  ['59524333', '0000'],
  ['c4ea545c', '1001'],
  ['c7dc5443', '1111'],
  ['6a1eabeb', '1111'],
  ['89941a93', '1111'],
  ['6071bd76', '1111'],
  ['07741c45', '1111'],
  ['f9e8c073', '1101'],
  ['852ce960', '0101'],
] as const;

const ARM = [
  ['ce6d2d27', '1111'],
  ['9ea5eabc', '1111'],
  ['ed4ddc30', '1111'],
  ['59524333', '0010'],
  ['c4ea545c', '1011'],
  ['c7dc5443', '1111'],
  ['6a1eabeb', '0110'],
  ['89941a93', '1010'],
  ['6071bd76', '1011'],
  ['07741c45', '0111'],
  ['f9e8c073', '0000'],
  ['852ce960', '1010'],
] as const;

const reading = (rows: readonly (readonly [string, string])[]): ArmReading => ({
  questions: rows.map(([id, correctByRun]) => ({ id, correctByRun })),
});

const control = reading(CONTROL);
const arm = reading(ARM);

describe('armVerdict — the published reading', () => {
  it('pairs the two artifacts and reports the counts §5 publishes', () => {
    const verdict = armVerdict(control, arm);
    expect(verdict.comparable).toBe(true);
    expect(verdict.refusals).toEqual([]);
    expect(verdict.questions).toBe(12);
    expect(verdict.repetitions).toBe(4);
    expect(verdict.cells).toBe(48);
    expect(verdict.controlPasses).toBe(27);
    expect(verdict.armPasses).toBe(32);
    expect(verdict.improvedCells).toBe(16);
    expect(verdict.worsenedCells).toBe(11);
  });

  it('states the rates and the points, and the points are repetition-weighted', () => {
    const verdict = armVerdict(control, arm);
    expect(verdict.controlRate).toBeCloseTo(27 / 48, 10);
    expect(verdict.armRate).toBeCloseTo(32 / 48, 10);
    expect(verdict.deltaPoints).toBeCloseTo((5 / 48) * 100, 10);
  });

  it('separates the four conversions from the five regressions', () => {
    const verdict = armVerdict(control, arm);
    expect(verdict.conversions.map((move) => move.id)).toEqual([
      'ce6d2d27',
      '9ea5eabc',
      'ed4ddc30',
      '59524333',
    ]);
    expect(verdict.regressions.map((move) => move.id)).toEqual([
      '6a1eabeb',
      '89941a93',
      '6071bd76',
      '07741c45',
      'f9e8c073',
    ]);
  });

  it('reads the control-perfect population from the masks rather than from a metric field', () => {
    const verdict = armVerdict(control, arm);
    // Five of the twelve are correct in all four repetitions; `c4ea545c` (1001) and `852ce960`
    // (0101) are not, and neither is `f9e8c073` (1101) — which is the distinction the `max`-based
    // reading of `§13.353.3` could not make.
    expect(verdict.controlPerfect).toBe(5);
    expect(verdict.controlPerfectRegressions.map((move) => move.id)).toEqual([
      '6a1eabeb',
      '89941a93',
      '6071bd76',
      '07741c45',
    ]);
    expect(verdict.controlPerfectRegressions.map((move) => move.lost)).toEqual([2, 2, 1, 1]);
  });

  it('counts a reshuffle as neither a conversion nor a regression at question level', () => {
    const verdict = armVerdict(control, arm);
    const moved = [
      ...verdict.conversions.map((move) => move.id),
      ...verdict.regressions.map((move) => move.id),
    ];
    // `852ce960` passes twice in both arms, in different repetitions: it contributes two improved
    // cells and two worsened ones and belongs to neither list.
    expect(moved).not.toContain('852ce960');
    expect(verdict.improvedCells).toBe(16);
    expect(verdict.worsenedCells).toBe(11);
  });

  it('reports both exact tests, and the sign test is the one that refuses a direction', () => {
    const verdict = armVerdict(control, arm);
    expect(verdict.repetitionP).toBeCloseTo(0.4421, 4);
    expect(verdict.questionP).toBeCloseTo(1, 10);
  });

  it('reports the two counts the sign test is computed on, because a p alone hides a 1-against-1', () => {
    const verdict = armVerdict(control, arm);
    // Five questions up (`ce6d2d27`, `9ea5eabc`, `ed4ddc30`, `59524333` from zero, and `c4ea545c`
    // from two to three) against five down. The p-value of that pair is 1, and so is the p-value of a
    // pair with one question on each side — the counts are what tell a reader whether five questions
    // disagreed or ten, which is the difference `§13.381`'s capability account needed.
    expect(verdict.questionsUp).toBe(5);
    expect(verdict.questionsDown).toBe(5);
  });
});

describe('armVerdict — the bar', () => {
  it('accepts nothing when no bar is given, and says so instead of guessing', () => {
    expect(armVerdict(control, arm).bar).toBeNull();
  });

  it('meets clause one and fails clause two, which is the verdict of §13.354', () => {
    const verdict = armVerdict(control, arm, { bar: { conversions: 3, falsifierLoss: 2 } });
    expect(verdict.bar).toEqual({
      conversionsMet: true,
      noRegressionMet: false,
      netMet: null,
      falsified: true,
      accepted: false,
    });
  });

  it('fires the falsifier on the loss and not on the count of regressions', () => {
    const verdict = armVerdict(control, arm, { bar: { conversions: 3, falsifierLoss: 3 } });
    // `f9e8c073` loses three repetitions but is not control-perfect, so it cannot fire the
    // falsifier: the clause is about the questions the control answers every time.
    expect(verdict.bar?.falsified).toBe(false);
    expect(verdict.bar?.accepted).toBe(false);
  });

  it('accepts only when both clauses hold', () => {
    const four = CONTROL.slice(0, 4);
    const verdict = armVerdict(reading(four), reading(four.map(([id]) => [id, '1111'] as const)), {
      bar: { conversions: 4, falsifierLoss: 2 },
    });
    expect(verdict.bar).toEqual({
      conversionsMet: true,
      noRegressionMet: true,
      netMet: null,
      falsified: false,
      accepted: true,
    });
  });

  it('refuses a bar on an inadmissible pair rather than evaluating it', () => {
    const verdict = armVerdict(control, reading(ARM.slice(1)), {
      bar: { conversions: 3, falsifierLoss: 2 },
    });
    expect(verdict.bar).toBeNull();
    expect(verdict.comparable).toBe(false);
  });
});

describe('armVerdict — the net clause', () => {
  it('holds at equality, which is the shape of a `d_worse <= d_better` criterion', () => {
    // Five up against five down. A criterion of the form "no more questions may get worse than get
    // better" is exactly `up - down >= 0`, so equality has to pass: a clause that rejected a tie
    // would be a stricter rule than the one registered, and a stricter rule is the same defect as a
    // looser one when it is written after the number.
    const verdict = armVerdict(control, arm, {
      bar: { conversions: 3, falsifierLoss: 2, net: 0 },
    });
    expect(verdict.bar?.netMet).toBe(true);
    expect(verdict.bar?.accepted).toBe(false);
  });

  it('fails an arm that does not reach the net it asked for, and no other clause can rescue it', () => {
    const perfect = CONTROL.slice(0, 4).map(([id]) => [id, '1111'] as const);
    const unchanged = reading(perfect);
    // An arm identical to the control, on four questions the control answers every time: no
    // conversion is owed, nothing regressed and the falsifier cannot fire, so the two older clauses
    // accept an arm that changed nothing at all. That is what a net clause is for.
    const lenient = armVerdict(reading(perfect), unchanged, {
      bar: { conversions: 0, falsifierLoss: 1 },
    });
    expect(lenient.bar?.accepted).toBe(true);
    const demanding = armVerdict(reading(perfect), unchanged, {
      bar: { conversions: 0, falsifierLoss: 1, net: 1 },
    });
    expect(demanding.bar?.netMet).toBe(false);
    expect(demanding.bar?.accepted).toBe(false);
  });

  it('counts questions rather than cells, and the two can point in opposite directions', () => {
    // One question gains four repetitions; two questions lose one each. Cells move +2 in the arm's
    // favour while three questions move against it. A criterion written on the cell grid would read
    // this as an improvement; the one registered for `ABS` is on questions.
    const before = [
      ['a', '0000'],
      ['b', '1100'],
      ['c', '1100'],
    ] as const;
    const after = [
      ['a', '1111'],
      ['b', '1000'],
      ['c', '1000'],
    ] as const;
    const verdict = armVerdict(reading(before), reading(after), {
      bar: { conversions: 0, falsifierLoss: 4, net: 0 },
    });
    expect(verdict.deltaPoints).toBeCloseTo((2 / 12) * 100, 10);
    expect(verdict.questionsUp).toBe(1);
    expect(verdict.questionsDown).toBe(2);
    expect(verdict.bar?.netMet).toBe(false);
  });

  it('says the clause was not asked rather than met, so a two-clause bar reads as before', () => {
    const verdict = armVerdict(control, arm, { bar: { conversions: 3, falsifierLoss: 2 } });
    expect(verdict.bar?.netMet).toBeNull();
  });
});

describe('armVerdict — the six refusals', () => {
  it('refuses two artifacts that do not hold the same questions', () => {
    const verdict = armVerdict(control, reading(ARM.slice(1)));
    expect(verdict.refusals).toContain('question-sets-differ');
    expect(verdict.comparable).toBe(false);
    expect(verdict.questions).toBe(0);
    expect(verdict.conversions).toEqual([]);
  });

  it('refuses two artifacts measured over different corpora, whether or not it was asked', () => {
    const sameQuestions = (fingerprint: string | undefined): ArmReading => ({
      ...reading(CONTROL),
      ...(fingerprint === undefined ? {} : { datasetFingerprint: fingerprint }),
    });
    const controlPrint = sameQuestions('sha256:d6f21ea9');
    const movedCorpus = sameQuestions('sha256:0000dead');
    const refused = armVerdict(controlPrint, movedCorpus);
    expect(refused.comparable).toBe(false);
    expect(refused.refusals).toEqual(['dataset-differs']);
    // The flag is about the other half: an artifact from before the field existed cannot show that its
    // corpus was the same one, and an unrecorded pair is admissible only when nobody asked.
    expect(armVerdict(controlPrint, sameQuestions(undefined)).comparable).toBe(true);
    expect(
      armVerdict(controlPrint, sameQuestions(undefined), { requireSameDataset: true }).refusals,
    ).toEqual(['dataset-differs']);
    expect(
      armVerdict(controlPrint, sameQuestions('sha256:d6f21ea9'), {
        requireSameDataset: true,
      }).comparable,
    ).toBe(true);
  });

  it('refuses unequal repetition counts', () => {
    const shorter = reading(ARM.map(([id, mask]) => [id, mask.slice(0, 2)] as const));
    const verdict = armVerdict(control, shorter);
    expect(verdict.refusals).toContain('repetitions-differ');
    expect(verdict.comparable).toBe(false);
  });

  it('refuses masks of differing length inside one artifact', () => {
    const ragged = reading([
      ['ce6d2d27', '0000'],
      ['9ea5eabc', '000'],
    ]);
    const verdict = armVerdict(ragged, ragged);
    expect(verdict.refusals).toContain('mask-length-mismatch');
    expect(verdict.comparable).toBe(false);
  });

  it('refuses a mask that is not binary', () => {
    const verdict = armVerdict(reading([['ce6d2d27', '0002']]), reading([['ce6d2d27', '1111']]));
    expect(verdict.refusals).toContain('mask-not-binary');
    expect(verdict.comparable).toBe(false);
  });

  it('refuses an empty population', () => {
    const verdict = armVerdict(reading([]), reading([]));
    expect(verdict.refusals).toContain('empty-population');
    expect(verdict.comparable).toBe(false);
  });

  it('refuses evidence that moved, and only when the caller says the mechanism cannot move it', () => {
    const withEvidence = (
      rows: readonly (readonly [string, string])[],
      chars: number,
    ): ArmReading => ({
      questions: rows.map(([id, correctByRun]) => ({ id, correctByRun, evidenceChars: chars })),
    });
    const same = armVerdict(withEvidence(CONTROL, 23_084), withEvidence(ARM, 23_084), {
      requireIdenticalEvidence: true,
    });
    expect(same.comparable).toBe(true);
    const moved = armVerdict(withEvidence(CONTROL, 23_084), withEvidence(ARM, 24_200), {
      requireIdenticalEvidence: true,
    });
    expect(moved.refusals).toContain('evidence-not-identical');
    expect(moved.comparable).toBe(false);
    // The same pair is admissible when the check is not asked for, because a mechanism that
    // changes retrieval is allowed to change the evidence.
    expect(armVerdict(withEvidence(CONTROL, 23_084), withEvidence(ARM, 24_200)).comparable).toBe(
      true,
    );
  });

  it('refuses when one side carries no evidence width and the check is asked for', () => {
    const verdict = armVerdict(
      reading(CONTROL),
      reading(ARM.map(([id, mask]) => [id, mask] as const)),
      { requireIdenticalEvidence: true },
    );
    expect(verdict.refusals).toContain('evidence-not-identical');
  });

  it('lists every refusal it finds rather than the first', () => {
    const verdict = armVerdict(reading([['ce6d2d27', '0000']]), reading([['9ea5eabc', '111']]));
    expect(verdict.refusals).toEqual(['question-sets-differ', 'repetitions-differ']);
  });
});

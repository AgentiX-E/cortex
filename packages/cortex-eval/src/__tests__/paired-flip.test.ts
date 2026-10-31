/**
 * The paired reading's own tests, with no model, no key and no artifact.
 *
 * ## What this instrument exists to stop
 *
 * Every head-to-head in this campaign was quoted as a **difference of means**: `87.25` against
 * `103.75` is "16 questions behind". Both numbers are averages over four repetitions, and the
 * artifact has carried `featureCorrectByRun` / `baselineCorrectByRun` — one correctness mask per
 * repetition — since the field was added for exactly this purpose. Nobody ever read them.
 *
 * A difference of means cannot say which of four very different things produced it:
 *
 *   durable   the same question, decided the same way in every repetition. This is the only part an
 *             intervention can address, because it is the only part that is a property of the code.
 *   flapping  one question swinging between repetitions with a byte-identical prompt. Averaging it
 *             into a "gap" converts instrument noise into a treatment effect.
 *   agreed    both arms wrong in every repetition. Not a gap at all — a ceiling of the harness.
 *
 * So the predicate is not a convenience. `durable-miss` is what a fix can reach, `contested` is what
 * a repeat is needed to read, and `agreed-wrong` is what nothing in this repository can win by being
 * more like the reference arm.
 */
import { describe, it, expect } from 'vitest';

import { summarisePaired } from '../paired-flip.js';

// Derived from the function under test rather than exported by the module: a type exported for a
// test's convenience is the advertisement `tools/export-census.mjs` refuses.
type Case = Parameters<typeof summarisePaired>[0][number];

function q(overrides: Partial<Case> & Pick<Case, 'baseline' | 'feature'>): Case {
  return {
    index: 0,
    questionId: 'q1',
    capability: 'MR',
    gold: '3',
    answer: '3',
    ...overrides,
  } as Case;
}

/**
 * The verdict for one question, read through the summary.
 *
 * `classifyPaired` is deliberately not exported — it has one caller — so the verdicts are reached the way
 * the tool reaches them, which also means a verdict test fails if the summary stops routing through it.
 */
function verdictOf(baseline: boolean[], feature: boolean[]): string {
  return summarisePaired([q({ baseline, feature })]).rows[0]!.verdict;
}

describe('the five verdicts, each decided by the masks alone', () => {
  it('calls a question the feature never gets and the baseline always gets a durable miss', () => {
    expect(verdictOf([true, true, true, true], [false, false, false, false])).toBe('durable-miss');
  });

  it('calls the mirror image a durable win', () => {
    expect(verdictOf([false, false, false, false], [true, true, true, true])).toBe('durable-win');
  });

  it('calls a question both arms always get agreed-right, and never counts it as a win', () => {
    // The distinction matters arithmetically: 72 of MR's 121 questions are agreed-right, and a
    // summary that counted them as wins would report a 72-question advantage.
    expect(verdictOf([true, true, true, true], [true, true, true, true])).toBe('agreed-right');
  });

  it('calls a question both arms always get wrong agreed-wrong, which is not a gap', () => {
    // Eight MR questions are in this class against `reference-pipeline`. Being more like that arm
    // cannot win them, because that arm does not win them either.
    expect(verdictOf([false, false], [false, false])).toBe('agreed-wrong');
  });

  it('calls anything with a win on both sides contested', () => {
    expect(verdictOf([true, false, true, false], [false, true, false, true])).toBe('contested');
    // And one-sided flapping is contested too: the question was decided differently by the same code.
    expect(verdictOf([true, true, true, false], [false, false, false, false])).toBe('contested');
  });
});

describe('the masks have to describe the same measurement, and a mismatch is refused', () => {
  it('refuses two sides measured a different number of times', () => {
    // Averaging a 4-run side against a 2-run side is the arithmetic that produced the numbers this
    // instrument replaces. It must be impossible rather than discouraged.
    expect(() => verdictOf([true, true, true, true], [true, true])).toThrow(/measured/);
  });

  it('refuses an empty mask, because no repetition is not a repetition that agreed', () => {
    expect(() => verdictOf([], [])).toThrow(/repetition/);
  });

  it('refuses cases whose repetition counts disagree, and names the question', () => {
    expect(() =>
      summarisePaired([
        q({
          questionId: 'four',
          baseline: [true, true, true, true],
          feature: [true, true, true, true],
        }),
        q({ questionId: 'two', baseline: [true, true], feature: [true, true] }),
      ]),
    ).toThrow(/two/);
  });
});

describe('the summary separates flapping from durable, which a spread cannot', () => {
  // Six MR questions, chosen to make the four populations add to the total and to make one
  // question flap in one repetition — the shape the spread `{min: 4, avg: 4.5, max: 5}` cannot
  // distinguish from five questions each decided once.
  const cases: Case[] = [
    q({
      index: 0,
      questionId: 'both',
      baseline: [true, true, true, true],
      feature: [true, true, true, true],
    }),
    q({
      index: 1,
      questionId: 'miss',
      baseline: [true, true, true, true],
      feature: [false, false, false, false],
    }),
    q({
      index: 2,
      questionId: 'win',
      baseline: [false, false, false, false],
      feature: [true, true, true, true],
    }),
    q({
      index: 3,
      questionId: 'neither',
      baseline: [false, false, false, false],
      feature: [false, false, false, false],
    }),
    q({
      index: 4,
      questionId: 'flap-one',
      baseline: [true, true, true, true],
      feature: [false, true, true, true],
    }),
    q({
      index: 5,
      questionId: 'flap-two',
      baseline: [true, true, true, true],
      feature: [true, true, false, false],
    }),
  ];

  it('counts the four durable populations and keeps the contested ones out of them', () => {
    const reading = summarisePaired(cases);
    const mr = reading.capabilities[0]!;
    expect(mr.durableMiss).toEqual(['miss']);
    expect(mr.durableWin).toEqual(['win']);
    expect(mr.agreedWrong).toEqual(['neither']);
    expect(mr.contested).toBe(2);
    // The partition is total: every question lands in exactly one class.
    expect(
      mr.durableMiss.length + mr.durableWin.length + mr.agreedWrong.length + mr.contested + 1,
    ).toBe(mr.total);
  });

  it('reports one question flapping twice and another once, not "two flapping questions"', () => {
    // `featureByCapability` is `{min, avg, max}` of a count: it cannot tell one question swinging
    // twice from two swinging once, and both are the same spread.
    const reading = summarisePaired(cases);
    // Two questions flapping, and the runs each of them was right for is what separates one question
    // swinging twice from two swinging once — the same spread, opposite readings.
    expect(reading.capabilities[0]!.flapping.feature).toEqual([
      { questionId: 'flap-one', runs: 3 },
      { questionId: 'flap-two', runs: 2 },
    ]);
    expect(reading.rows.find((row) => row.questionId === 'flap-two')!.featureRuns).toBe(2);
    expect(reading.rows.find((row) => row.questionId === 'flap-one')!.featureRuns).toBe(3);
  });

  it('reports the per-repetition gap and the discordant counts behind it', () => {
    const reading = summarisePaired(cases);
    const mr = reading.capabilities[0]!;
    // Baseline: 4 of 6 in every repetition (`both`, `miss`, `flap-one`, `flap-two`).
    expect(mr.baselinePerRun).toEqual([4, 4, 4, 4]);
    // Feature: 3, 4, 3, 3 -- the flapping questions move the count and nothing else does.
    expect(mr.featurePerRun).toEqual([3, 4, 3, 3]);
    expect(mr.gapPerRun).toEqual([1, 0, 1, 1]);
    // Discordant: baseline right and feature wrong, per repetition. The difference of these two
    // vectors is `gapPerRun`, which is the identity that makes the table checkable by eye.
    expect(mr.baselineOnlyPerRun).toEqual([2, 1, 2, 2]);
    expect(mr.featureOnlyPerRun).toEqual([1, 1, 1, 1]);
  });

  it('keeps capabilities apart and orders them, so a table does not depend on row order', () => {
    const reading = summarisePaired([
      ...cases,
      q({
        index: 6,
        questionId: 'tr1',
        capability: 'TR',
        baseline: [true, true, true, true],
        feature: [true, true, true, true],
      }),
    ]);
    expect(reading.capabilities.map((entry) => entry.capability)).toEqual(['MR', 'TR']);
    expect(reading.capabilities[1]!.total).toBe(1);
    expect(reading.capabilities[0]!.total).toBe(6);
  });

  it('reports the repetition count once, so a reader knows what "always" means', () => {
    expect(summarisePaired(cases).runs).toBe(4);
  });
});

describe('the ceiling this makes computable, which is the point of the instrument', () => {
  it('says what closing the durable gap would be worth, and what it would not', () => {
    // With four durable misses, four durable wins and two agreed-wrong: closing every durable miss
    // adds four to the feature's *last* repetition and leaves the agreed-wrong two untouched, so the
    // best a transplant of the reference arm can reach is stated as arithmetic rather than as hope.
    const cases: Case[] = [
      ...Array.from({ length: 4 }, (_, i) =>
        q({ index: i, questionId: `miss-${i}`, baseline: [true, true], feature: [false, false] }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        q({
          index: 10 + i,
          questionId: `win-${i}`,
          baseline: [false, false],
          feature: [true, true],
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        q({
          index: 20 + i,
          questionId: `neither-${i}`,
          baseline: [false, false],
          feature: [false, false],
        }),
      ),
    ];
    const mr = summarisePaired(cases).capabilities[0]!;
    const reachable = mr.durableMiss.length - mr.durableWin.length;
    expect(reachable).toBe(0);
    // The ceiling is not "the reference arm's number": four questions it wins, four it loses, so
    // matching it is worth zero here — which is the reading a difference of means cannot give.
    expect(mr.agreedWrong.length).toBe(2);
  });
});

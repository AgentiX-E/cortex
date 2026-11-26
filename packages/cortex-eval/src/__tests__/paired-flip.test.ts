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
    // The population, not a count of it: `§203` could not name the twelve `MR` questions it had to
    // dispatch at because this field was `12`, and a count cannot be dispatched at.
    expect(mr.contested.map((row) => row.questionId)).toEqual(['flap-one', 'flap-two']);
    // The partition is total: every question lands in exactly one class.
    expect(
      mr.durableMiss.length +
        mr.durableWin.length +
        mr.agreedWrong.length +
        mr.contested.length +
        1,
    ).toBe(mr.total);
  });

  it('reports one question flapping twice and another once, not "two flapping questions"', () => {
    // `featureByCapability` is `{min, avg, max}` of a count: it cannot tell one question swinging
    // twice from two swinging once, and both are the same spread.
    const reading = summarisePaired(cases);
    // Two questions flapping, and the runs each of them was right for is what separates one question
    // swinging twice from two swinging once — the same spread, opposite readings. Both counts travel on
    // the one list now, so the reader who wants the side-wise view filters it and cannot get a second,
    // separately maintained answer to the same question.
    expect(reading.capabilities[0]!.contested).toEqual([
      { questionId: 'flap-one', baselineRuns: 4, featureRuns: 3 },
      { questionId: 'flap-two', baselineRuns: 4, featureRuns: 2 },
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

  it('orders capabilities that arrive in descending order, not only ascending ones', () => {
    // The comparator has three arms and a two-capability fixture reaches one of them: `Array.sort` on two
    // elements compares them once, in the order the rows arrived. A table whose row order came from the
    // artifact would then be sorted only when the artifact happened to be ascending -- which is the bug
    // this test exists to make impossible, and it is invisible until a dispatch reorders its questions.
    const one = (capability: string, questionId: string): Case =>
      q({
        questionId,
        capability,
        baseline: [true, true, true, true],
        feature: [true, true, true, true],
      });
    const reading = summarisePaired([one('TR', 'z1'), one('MR', 'z2'), one('IE', 'z3')]);
    expect(reading.capabilities.map((entry) => entry.capability)).toEqual(['IE', 'MR', 'TR']);
  });

  it('refuses an empty artifact rather than reporting a reading of nothing', () => {
    // Zero rows would otherwise produce `runs: undefined` and a table with no denominator, which reads
    // as "no gap" everywhere it is quoted.
    expect(() => summarisePaired([])).toThrow(/no questions to pair/);
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

/**
 * The test the reading was missing for fifteen rounds.
 *
 * The verdicts say *what* happened to a question and the counts say *how many* questions moved. Neither
 * says how surprising the asymmetry is, and the campaign read both as if they did: `20` against `9` is
 * `p = 0.043` and `9` against `2` is `p = 0.065`, so two rows a reader would order by eye are on
 * opposite sides of the bar. The p-value is not the gap and the gap is not the p-value, which is why
 * both are printed and both are asserted here.
 */
function block(
  count: number,
  prefix: string,
  baseline: boolean,
  feature: boolean,
  runs = 2,
): Case[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    questionId: `${prefix}-${i}`,
    capability: 'MR',
    gold: '3',
    answer: '3',
    baseline: Array.from({ length: runs }, () => baseline),
    feature: Array.from({ length: runs }, () => feature),
  }));
}

describe('the exact McNemar p-value of each repetition', () => {
  it('prices ten questions against none at 2/1024, and calls it significant in every repetition', () => {
    const reading = summarisePaired([
      ...block(10, 'featureOnly', true, false),
      ...block(4, 'both', true, true),
    ]).capabilities[0]!;
    expect(reading.baselineOnlyPerRun).toEqual([10, 10]);
    expect(reading.featureOnlyPerRun).toEqual([0, 0]);
    expect(reading.pValuePerRun[0]).toBeCloseTo(2 / 1024, 12);
    expect(reading.pValuePerRun[1]).toBeCloseTo(2 / 1024, 12);
    expect(reading.significantEveryRun).toBe(true);
  });

  it('does not call nine against two significant, though it is a seven-question gap', () => {
    const reading = summarisePaired([
      ...block(9, 'featureOnly', true, false),
      ...block(2, 'baselineOnly', false, true),
    ]).capabilities[0]!;
    expect(reading.baselineOnlyPerRun).toEqual([9, 9]);
    expect(reading.featureOnlyPerRun).toEqual([2, 2]);
    // 2 * (C(11,0) + C(11,1) + C(11,2)) / 2^11 = 134 / 2048.
    expect(reading.pValuePerRun[0]).toBeCloseTo(134 / 2048, 12);
    expect(reading.pValuePerRun[1]).toBeCloseTo(134 / 2048, 12);
    expect(reading.significantEveryRun).toBe(false);
  });

  it('requires every repetition rather than the best one', () => {
    const cases = [
      ...block(10, 'durable', true, false),
      // Three questions that move the other way in the second draw, which is what a coin flip looks
      // like beside a real effect: the first repetition clears the bar and the second does not.
      ...Array.from({ length: 3 }, (_, i) => ({
        index: 100 + i,
        questionId: `flip-${i}`,
        capability: 'MR',
        gold: '3',
        answer: '3',
        baseline: [false, true],
        feature: [true, false],
      })),
    ] as Case[];
    const reading = summarisePaired(cases).capabilities[0]!;
    // Repetition 0: ten against three, `2 * 378 / 8192`. Repetition 1: thirteen against none.
    expect(reading.pValuePerRun[0]).toBeGreaterThan(0.05);
    expect(reading.pValuePerRun[1]).toBeCloseTo(2 / 8192, 12);
    // A treatment that is real shows up in the repetition as well as the first draw.
    expect(reading.significantEveryRun).toBe(false);
  });

  it('is 1 when nothing moved, because an undefined statistic is not a small one', () => {
    const reading = summarisePaired([
      ...block(6, 'bothRight', true, true),
      ...block(6, 'bothWrong', false, false),
    ]).capabilities[0]!;
    expect(reading.pValuePerRun).toEqual([1, 1]);
    expect(reading.significantEveryRun).toBe(false);
  });

  it('orders two rows with the same gap the other way round', () => {
    const concentrated = summarisePaired([
      ...block(6, 'featureOnly', true, false),
      ...block(8, 'both', true, true),
    ]).capabilities[0]!;
    const spread = summarisePaired([
      ...block(12, 'featureOnly', true, false),
      ...block(6, 'baselineOnly', false, true),
    ]).capabilities[0]!;
    // Both gaps are six questions, and the second is not evidence of anything.
    expect(concentrated.gapPerRun[0]).toBe(6);
    // Same six-question gap, twelve questions moved the other way under it.
    expect(spread.gapPerRun[0]).toBe(6);
    expect(concentrated.pValuePerRun[0]).toBeCloseTo(2 / 64, 12);
    expect(spread.pValuePerRun[0]).toBeGreaterThan(0.2);
  });
});

/**
 * The population the score is short by, which is not the gap.
 *
 * Every mechanism this campaign dispatched before `§203` chose its target by the column that looked worst,
 * and the two readings are not the same reading. `durable-miss` needs the **other** arm to be right every
 * time; the score is absolute, so a question this arm never answers costs a point whether or not the control
 * answers it. `neverRight` is that second population, and its `control` tag is the only thing that separates
 * "a fix is demonstrated able to reach this" from "no pipeline in this repository gets it".
 */
describe('the questions answered wrongly in every repetition', () => {
  const never = () =>
    summarisePaired([
      // The control answers it every time: a fix is demonstrated possible.
      ...block(2, 'durableMiss', true, false),
      // The control answers it in one repetition of two: still demonstrated, at half the evidence.
      ...Array.from({ length: 1 }, (_, i) => ({
        index: 10 + i,
        questionId: `controlSome-${i}`,
        capability: 'MR',
        gold: '3',
        answer: '2',
        baseline: [true, false],
        feature: [false, false],
      })),
      // Neither arm ever answers it: a ceiling of the harness rather than a gap between the arms.
      ...block(3, 'agreedWrong', false, false),
      // And the two populations `neverRight` must NOT swallow: right in every repetition, and right in one.
      ...block(2, 'agreedRight', true, true),
      ...Array.from({ length: 1 }, (_, i) => ({
        index: 20 + i,
        questionId: `unstable-${i}`,
        capability: 'MR',
        gold: '3',
        answer: '3',
        baseline: [true, false],
        feature: [true, false],
      })),
    ]).capabilities[0]!;

  it('tags each one with what the control did, and keeps the reachable half separate', () => {
    const mr = never();
    expect(mr.neverRight).toEqual([
      { questionId: 'durableMiss-0', control: 'every' },
      { questionId: 'durableMiss-1', control: 'every' },
      { questionId: 'controlSome-0', control: 'some' },
      { questionId: 'agreedWrong-0', control: 'none' },
      { questionId: 'agreedWrong-1', control: 'none' },
      { questionId: 'agreedWrong-2', control: 'none' },
    ]);
    // Two `every`, one `some`, three `none`: the ceiling a fix could reach is 1 - 3/8, not 1 - 6/8.
    expect(mr.neverRight.filter((row) => row.control !== 'none')).toHaveLength(3);
  });

  it('does not count a question this arm gets right in some repetition', () => {
    // The predicate is `featureRuns === 0`, not "not durable-win": a contested question is unstable, and an
    // unstable question is not reachable by a mechanism -- it is reachable by a repeat.
    const mr = never();
    expect(mr.neverRight.map((row) => row.questionId)).not.toContain('unstable-0');
    expect(mr.contested.map((row) => row.questionId)).toContain('unstable-0');
  });

  it('partitions the population three ways with no question in two columns', () => {
    // The identity the printed headroom table is read against: answered + unstable + never == total. A table
    // whose columns do not add up is a table nobody counted, which is how the wrong population gets chosen.
    const mr = summarisePaired([
      ...block(4, 'a', true, true),
      ...block(2, 'b', true, false),
      ...block(3, 'c', false, false),
    ]).capabilities[0]!;
    const answered = mr.total - mr.contested.length - mr.neverRight.length;
    expect(answered).toBe(4);
    expect(answered + mr.contested.length + mr.neverRight.length).toBe(mr.total);
    expect(mr.neverRight).toHaveLength(5);
  });
});

/**
 * The one list, and the projections the two removed fields used to be.
 *
 * `flapping.baseline` was `contested` filtered to `0 < baselineRuns < runs` and `flapping.feature` was the
 * same predicate one field over. Three fields describing one population is three fields that can disagree,
 * and the disagreement would be invisible: nothing compared them. The identity is asserted here instead, on
 * a fixture that puts a question in each of the three shapes.
 */
describe('contested is one list, not a count and two lists', () => {
  it('holds exactly the questions with a side strictly between none and all', () => {
    const summary = summarisePaired([
      ...block(2, 'both', true, true),
      ...block(2, 'neither', false, false),
      ...block(2, 'durableMiss', true, false),
      ...block(2, 'durableWin', false, true),
      ...Array.from({ length: 1 }, (_, i) => ({
        index: 30 + i,
        questionId: `baselineFlaps-${i}`,
        capability: 'MR',
        gold: '3',
        answer: '3',
        baseline: [true, false],
        feature: [true, true],
      })),
      ...Array.from({ length: 1 }, (_, i) => ({
        index: 31 + i,
        questionId: `featureFlaps-${i}`,
        capability: 'MR',
        gold: '3',
        answer: '3',
        baseline: [true, true],
        feature: [true, false],
      })),
    ]);
    const reading = summary.capabilities[0]!;

    expect(reading.contested).toEqual([
      { questionId: 'baselineFlaps-0', baselineRuns: 1, featureRuns: 2 },
      { questionId: 'featureFlaps-0', baselineRuns: 2, featureRuns: 1 },
    ]);
    // Every contested question has at least one side strictly between 0 and `runs`, by construction. A row
    // that satisfied neither would belong to one of the four durable verdicts instead.
    for (const row of reading.contested) {
      const between = (count: number) => count > 0 && count < summary.runs;
      expect(between(row.baselineRuns) || between(row.featureRuns)).toBe(true);
    }
  });
});

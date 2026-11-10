/**
 * The partition, the null, and the six shapes that would fake either.
 *
 * Every fixture below is built from **run `42355323615`'s published four-repetition masks**, not
 * from invented data. The realisation the module exists to make is in one row of that artifact:
 *
 * | capability | one draw's failures | wrong in all four | correct at least once |
 * | ---------- | ------------------: | ----------------: | --------------------: |
 * | `MR`       |                  20 |            **13** |                **13** |
 * | `KU`       |                  10 |             **7** |                 **3** |
 *
 * So the distributions reproduced here are the real ones — `MR` as `95/5/3/5/13` over `121` by
 * repetitions-correct, `KU` as `62/1/2/0/7` over `72` — and the assertions on `recoverable` and
 * `meanAccuracy` are arithmetic the artifact itself confirms (`MR` 19.5 question-equivalents and
 * 83.88%, `KU` 8.25 and 88.54%).
 *
 * The two mechanism target sets are the real ones too, listed by the question ids
 * `MEASURE-MR-CEILING.md` §3 and §4 name:
 *
 * | mechanism | questions | repetitions correct | ceiling |
 * | --- | --- | --- | --- |
 * | deterministic summation (operation errors) | `37f165cf`, `9ee3ecd6`, `gpt4_2ba83207` | 0, 1, 2 | **2.25** |
 * | entity grouping (over-counts) | `88432d0a`, `gpt4_7fce9456`, `d851d5ba`, `gpt4_ab202e7f`, `gpt4_2f8be40d` | 0, 3, 1, 0, 0 | **4.00** |
 *
 * `MEASURE-MR-CEILING.md` §5.2 prices the first at "the two operation failures it would get" and
 * §13.340.6 registers the second at "≥ 3 of 121". Against the repetition data both figures are
 * ceilings rather than populations, and the tests below hold the module to reporting the difference.
 */
import { describe, it, expect } from 'vitest';

import {
  STABILITY_REFUSALS,
  conversionCeiling,
  renderCeilings,
  renderStability,
  repetitionNull,
  stabilityOf,
  type StabilityArtifactShape,
} from '../failure-stability.js';

/**
 * Build four masks from a `passed -> count` distribution and a per-question pass list.
 *
 * The questions are placed so that the first `count` questions of each band pass in the first
 * `passed` repetitions, which keeps the per-repetition totals a known function of the input: a
 * fixture that cannot state its own per-repetition accuracy cannot test the null.
 */
function masksFrom(perQuestion: readonly number[], repetitions: number): string[] {
  return Array.from({ length: repetitions }, (_, repetition) =>
    perQuestion.map((passed) => (passed > repetition ? '1' : '0')).join(''),
  );
}

/** `MR` of `42355323615`: 121 questions, 95 perfect, 13 never. */
const MR_PER_QUESTION = [
  ...Array.from({ length: 95 }, () => 4),
  ...Array.from({ length: 5 }, () => 3),
  ...Array.from({ length: 3 }, () => 2),
  ...Array.from({ length: 5 }, () => 1),
  ...Array.from({ length: 13 }, () => 0),
];

/** `KU` of the same run: 72 questions, 62 perfect, 7 never. */
const KU_PER_QUESTION = [
  ...Array.from({ length: 62 }, () => 4),
  ...Array.from({ length: 1 }, () => 3),
  ...Array.from({ length: 2 }, () => 2),
  ...Array.from({ length: 7 }, () => 0),
];

function report(perQuestion: readonly number[], repetitions = 4): StabilityArtifactShape {
  return {
    runs: repetitions,
    questions: perQuestion.map((_, index) => ({
      questionId: `q${String(index).padStart(3, '0')}`,
      capability: 'MR',
    })),
    ablation: { featureCorrectByRun: masksFrom(perQuestion, repetitions) },
  };
}

describe('stabilityOf: the partition', () => {
  it('splits 121 MR questions into 13 stable failures, 13 flaky and 95 stable passes', () => {
    const reading = stabilityOf(report(MR_PER_QUESTION));
    expect(reading.repetitions).toBe(4);
    expect(reading.population).toBe(121);
    expect(reading.stableFailures).toHaveLength(13);
    expect(reading.flaky).toHaveLength(13);
    expect(reading.stablePasses).toHaveLength(95);
  });

  it('reports 19.5 recoverable question-equivalents and 83.88% for MR', () => {
    const reading = stabilityOf(report(MR_PER_QUESTION));
    // 13 x 1 + 5 x 0.75 + 3 x 0.5 + 5 x 0.25
    expect(reading.recoverable).toBeCloseTo(19.5, 10);
    expect(reading.meanAccuracy).toBeCloseTo(406 / 484, 12);
    expect((reading.meanAccuracy * 100).toFixed(2)).toBe('83.88');
  });

  it('reports 8.25 and 88.54% for KU, which is the most stable row in the file', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION));
    expect(reading.population).toBe(72);
    expect(reading.stableFailures).toHaveLength(7);
    // KU has no question at 1 of 4 -- the flaky half is two questions at 2 and one at 3.
    expect(reading.flaky).toHaveLength(3);
    expect(reading.recoverable).toBeCloseTo(8.25, 10);
    expect((reading.meanAccuracy * 100).toFixed(2)).toBe('88.54');
  });

  it('carries each question id and capability through to the partition rows', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION));
    const rows = reading.questions;
    expect(rows[0]?.questionId).toBe('q000');
    expect(rows[0]?.capability).toBe('MR');
    expect(rows[0]?.passRate).toBe(1);
    const never = rows[rows.length - 1];
    expect(never?.passed).toBe(0);
    expect(never?.passRate).toBe(0);
    expect(never?.repetitions).toBe(4);
  });

  it('leaves the identity fields absent when the artifact carries no per-question records', () => {
    const reading = stabilityOf({ ablation: { featureCorrectByRun: masksFrom([4, 0], 4) } });
    expect(reading.questions.map((question) => question.questionId)).toEqual([
      undefined,
      undefined,
    ]);
    expect(reading.questions.map((question) => question.capability)).toEqual([
      undefined,
      undefined,
    ]);
    expect(reading.stableFailures).toHaveLength(1);
  });

  it('selects by question id, in the order the caller asked for', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION), { questionIds: ['q070', 'q000'] });
    expect(reading.questions.map((question) => question.questionId)).toEqual(['q070', 'q000']);
    expect(reading.stableFailures).toHaveLength(1);
    expect(reading.stablePasses).toHaveLength(1);
  });

  it('selects by capability, and refuses a capability the artifact does not carry', () => {
    const mixed: StabilityArtifactShape = {
      questions: [
        { questionId: 'a', capability: 'MR' },
        { questionId: 'b', capability: 'KU' },
        { questionId: 'c', capability: 'MR' },
      ],
      ablation: { featureCorrectByRun: masksFrom([0, 4, 0], 4) },
    };
    const mr = stabilityOf(mixed, { capability: 'MR' });
    expect(mr.population).toBe(2);
    expect(mr.stableFailures).toHaveLength(2);
    expect(() => stabilityOf(mixed, { capability: 'TR' })).toThrow(STABILITY_REFUSALS.empty);
  });

  it('keeps the first record when a question id repeats', () => {
    const duplicate: StabilityArtifactShape = {
      questions: [
        { questionId: 'same', capability: 'MR' },
        { questionId: 'same', capability: 'MR' },
      ],
      ablation: { featureCorrectByRun: masksFrom([0, 4], 4) },
    };
    const reading = stabilityOf(duplicate, { questionIds: ['same'] });
    expect(reading.questions).toHaveLength(1);
    expect(reading.questions[0]?.index).toBe(0);
  });
});

describe('stabilityOf: the six refusals', () => {
  it('refuses an artifact with no per-repetition mask', () => {
    expect(() => stabilityOf({ ablation: { featureCorrect: [true, false] } })).toThrow(
      STABILITY_REFUSALS.unstated,
    );
  });

  it('refuses an artifact with no ablation block at all', () => {
    expect(() => stabilityOf({ runs: 4 })).toThrow(STABILITY_REFUSALS.unstated);
  });

  it('refuses a single repetition rather than reading it as stability', () => {
    expect(() => stabilityOf(report([4, 0], 1))).toThrow(STABILITY_REFUSALS.single);
  });

  it('refuses a mask containing a character that is not `0` or `1`', () => {
    expect(() =>
      stabilityOf({ ablation: { featureCorrectByRun: ['11', '2'.padEnd(2, '0')] } }),
    ).toThrow(STABILITY_REFUSALS.alphabet);
  });

  it('refuses masks of different widths', () => {
    expect(() => stabilityOf({ ablation: { featureCorrectByRun: ['111', '11'] } })).toThrow(
      STABILITY_REFUSALS.width,
    );
  });

  it('refuses masks that disagree with the per-question records', () => {
    expect(() =>
      stabilityOf({
        questions: [{ questionId: 'a', capability: 'MR' }],
        ablation: { featureCorrectByRun: ['11', '11'] },
      }),
    ).toThrow(STABILITY_REFUSALS.width);
  });

  it('refuses a zero-width mask rather than reporting an empty partition', () => {
    expect(() => stabilityOf({ ablation: { featureCorrectByRun: ['', ''] } })).toThrow(
      STABILITY_REFUSALS.empty,
    );
  });

  it('refuses a question id the artifact does not carry, naming it', () => {
    expect(() => stabilityOf(report([4]), { questionIds: ['absent'] })).toThrow(/absent/);
  });
});

describe('repetitionNull', () => {
  it('reports the per-repetition counts and a sample standard deviation in questions', () => {
    const reading = repetitionNull(report(MR_PER_QUESTION));
    // Every band passes in its first `passed` repetitions, so the totals step down by the size of
    // the lowest band each time: 108, 103, 100, 95.
    expect(reading.perRepetition).toEqual([108, 103, 100, 95]);
    expect(reading.population).toBe(121);
    const mean = (108 + 103 + 100 + 95) / 4;
    const variance =
      ((108 - mean) ** 2 + (103 - mean) ** 2 + (100 - mean) ** 2 + (95 - mean) ** 2) / 3;
    expect(reading.sd).toBeCloseTo(Math.sqrt(variance), 12);
    expect(reading.twoSd).toBeCloseTo(2 * Math.sqrt(variance), 12);
  });

  it('is zero when every repetition agrees, and says so rather than inventing a spread', () => {
    const reading = repetitionNull({ ablation: { featureCorrectByRun: ['000', '000'] } });
    expect(reading.sd).toBe(0);
    expect(reading.twoSd).toBe(0);
  });

  it('honours the capability selection', () => {
    const mixed: StabilityArtifactShape = {
      questions: [
        { questionId: 'a', capability: 'KU' },
        { questionId: 'b', capability: 'KU' },
      ],
      ablation: { featureCorrectByRun: ['10', '01'] },
    };
    const reading = repetitionNull(mixed, { capability: 'KU' });
    expect(reading.perRepetition).toEqual([1, 1]);
    expect(reading.population).toBe(2);
  });
});

describe('conversionCeiling', () => {
  const perQuestion = [
    ...MR_PER_QUESTION.slice(0, 108),
    // The three operation failures of §4: 37f165cf never, 9ee3ecd6 once, gpt4_2ba83207 twice.
    2,
    1,
    0,
    // Then nine more never-correct questions, which is what makes the total 13.
    ...Array.from({ length: 10 }, () => 0),
  ];

  it('prices deterministic summation at 2.25 question-equivalents, not at three', () => {
    const reading = stabilityOf(report(perQuestion));
    const ceiling = conversionCeiling(reading, 'summation', [108, 109, 110], 5);
    expect(ceiling.questions).toBe(3);
    expect(ceiling.ceiling).toBeCloseTo(2.25, 10);
    expect(ceiling.stable).toBe(1);
    expect(ceiling.points).toBeCloseTo((2.25 / 121) * 100, 10);
  });

  it('prices entity grouping at 4.00 with 3 stable, against the ≥3 bar', () => {
    const grouping = [
      ...MR_PER_QUESTION.slice(0, 108),
      // 88432d0a never, gpt4_7fce9456 three of four, d851d5ba one of four, gpt4_ab202e7f never,
      // gpt4_2f8be40d never, then eight more never-correct for the thirteen of the artifact.
      0,
      3,
      1,
      0,
      0,
      ...Array.from({ length: 8 }, () => 0),
    ];
    const reading = stabilityOf(report(grouping));
    const ceiling = conversionCeiling(reading, 'entity-grouping', [108, 109, 110, 111, 112], 5);
    expect(ceiling.ceiling).toBeCloseTo(4, 10);
    expect(ceiling.stable).toBe(3);
    // 4.00 > 5 is false, and this is the assertion the queue rests on.
    expect(ceiling.resolvable).toBe(false);
  });

  it('resolves a ceiling that clears the null', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION));
    const ceiling = conversionCeiling(reading, 'ku-latest-value', [65, 66, 67, 68, 69, 70, 71], 2);
    expect(ceiling.ceiling).toBeCloseTo(7, 10);
    expect(ceiling.resolvable).toBe(true);
  });

  it('is not resolvable when the ceiling equals the noise exactly', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION));
    const ceiling = conversionCeiling(reading, 'tie', [65], 1);
    expect(ceiling.ceiling).toBe(1);
    expect(ceiling.resolvable).toBe(false);
  });

  it('refuses an empty target set', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION));
    expect(() => conversionCeiling(reading, 'nothing', [], 1)).toThrow(STABILITY_REFUSALS.empty);
  });

  it('refuses an index outside the reading, naming it', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION));
    expect(() => conversionCeiling(reading, 'outside', [999], 1)).toThrow(/999/);
  });
});

describe('rendering', () => {
  it('prints the partition as a table a document can carry', () => {
    const text = renderStability(stabilityOf(report(KU_PER_QUESTION)));
    expect(text).toContain('population 72 questions x 4 repetitions = 288 question-runs');
    expect(text).toContain('mean accuracy 88.54%');
    expect(text).toContain('recoverable 8.25 question-equivalents');
    expect(text).toContain('| 0 of 4 | 7 | 9.7% |');
    expect(text).toContain('| 4 of 4 | 62 | 86.1% |');
    expect(text).toContain('stable failures 7');
    expect(text).toContain('flaky 3');
    expect(text).toContain('stable passes 62');
  });

  it('prints one line per ceiling, with the resolvable column as a word', () => {
    const reading = stabilityOf(report(KU_PER_QUESTION));
    const text = renderCeilings([
      conversionCeiling(reading, 'ku', [65, 66], 1),
      conversionCeiling(reading, 'nothing', [67], 3),
    ]);
    expect(text).toContain('| mechanism | target set | stable | ceiling | points |');
    expect(text).toContain('| ku | 2 | 2 |');
    expect(text).toContain('| nothing | 1 | 1 |');
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toMatch(/\| yes \|/);
    expect(text).toMatch(/\| no \|/);
  });
});

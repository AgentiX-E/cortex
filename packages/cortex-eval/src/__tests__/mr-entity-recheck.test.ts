/**
 * The name screen's own tests, with no model and no artifact.
 *
 * ## What is being protected
 *
 * The screen's output is a **count of answers that must be subtracted from a published accuracy**, so
 * its two failure directions are not symmetric and both are costly:
 *
 *   too eager    a correct answer whose names happen to be disjoint — a rephrasing, a pronoun, a gold
 *                that names a place the answer calls something else — is subtracted from the arm and
 *                the arm looks worse than it is.
 *   too shy      a wrong answer that names nothing is counted as clean, and the count reads as a bound
 *                when it is an artefact of the predicate. That is why `unnamed-answer` is a relation of
 *                its own rather than a silent pass.
 *
 * The cases below are written from the artifacts this campaign has actually produced, including the
 * two that cost the audit a defect (`"3"` as a whole gold, and a number-only answer).
 */
import { describe, it, expect } from 'vitest';

import { nameScreen } from '../mr-entity-recheck.js';

// Derived from the function under test rather than exported by the module: the package barrel exports
// the predicate alone, and a type exported for a test's convenience is the advertisement the export
// census refuses.
type ScreenSource = Parameters<typeof nameScreen>[0][number];

function answer(overrides: Partial<ScreenSource> & { questionId: string }): ScreenSource {
  return {
    capability: 'MR',
    gold: 'Rachel',
    answer: 'Rachel',
    accepted: true,
    ...overrides,
  };
}

function relationOf(source: ScreenSource): string {
  return nameScreen([source]).rows[0]!.relation;
}

describe('the four relations', () => {
  it('is silent when the answer names something the gold names', () => {
    expect(
      relationOf(
        answer({
          questionId: 'q1',
          gold: 'I adopted a Golden Retriever named Max from the shelter in Denver.',
          answer: 'You adopted Max, a Golden Retriever, in Denver.',
        }),
      ),
    ).toBe('shared-name');
  });

  it('flags an answer whose names are disjoint from the gold, which is the audit’s 44.9% applied to one row', () => {
    expect(
      relationOf(
        answer({
          questionId: 'q2',
          gold: 'I adopted a Golden Retriever named Max from the shelter in Denver.',
          answer: 'You adopted Biscuit, a Labrador, in Boulder.',
        }),
      ),
    ).toBe('names-disjoint');
  });

  it('does not call a gold with no names screenable, because there is nothing to be disjoint from', () => {
    // `"3"` is a real gold in this corpus, and the audit's second defect came from it.
    expect(relationOf(answer({ questionId: 'q3', gold: '3', answer: '4' }))).toBe('unnamed-gold');
    expect(relationOf(answer({ questionId: 'q4', gold: '18 days', answer: 'in 18 days' }))).toBe(
      'unnamed-gold',
    );
  });

  it('separates a named gold answered with a number instead of counting it as clean', () => {
    // Both of these are `unnamed-answer`: the correct "2 people" and the wrong "3 people" are the same
    // row to this screen, which is exactly why the relation is published and never folded into a rate.
    expect(
      relationOf(answer({ questionId: 'q5', gold: 'Alice and Bob', answer: '2 people' })),
    ).toBe('unnamed-answer');
    expect(
      relationOf(answer({ questionId: 'q6', gold: 'Alice and Bob', answer: '3 people' })),
    ).toBe('unnamed-answer');
  });
});

describe('the predicate itself', () => {
  it('searches the answer for the gold’s names instead of intersecting two capitalised extractions', () => {
    // Both forms are real: an answer that writes the name in lower case, and one that shouts it. The
    // second is not `[A-Z][a-z]{2,}` at all, so an extraction-based intersection would have called the
    // answer "unnamed" and lost it from `shared-name` — the side of the control the screen is read on.
    for (const text of ['rachel.', 'you met RACHEL there.']) {
      const row = nameScreen([answer({ questionId: 'q7', gold: 'I met Rachel.', answer: text })])
        .rows[0]!;
      expect(row.relation).toBe('shared-name');
      expect(row.sharedNames).toEqual(['Rachel']);
    }
  });

  it('does not let a lower-case mention of a different name count as the answer naming somebody', () => {
    // The conservative direction, and it is deliberate: `entitiesIn` needs a capital, so a lower-case
    // wrong name is `unnamed-answer` rather than a candidate. The screen under-counts; it cannot invent.
    expect(
      relationOf(answer({ questionId: 'q7b', gold: 'I met Rachel.', answer: 'you met monica.' })),
    ).toBe('unnamed-answer');
  });

  it('does not treat a capitalised non-name as a name', () => {
    // A month is capitalised, is not a name, and the audit's stoplist excludes it. If it were a name,
    // every dated gold would be screenable and the candidate count would move for the wrong reason.
    const reading = nameScreen([
      answer({
        questionId: 'q8',
        gold: 'In March I flew to Lisbon.',
        answer: 'In May I flew to Porto.',
      }),
    ]);
    expect(reading.rows[0]!.goldNames).toEqual(['Lisbon']);
    expect(reading.rows[0]!.answerNames).toEqual(['Porto']);
    expect(reading.rows[0]!.relation).toBe('names-disjoint');
  });

  it('does not read a sentence-initial pronoun as the answer naming somebody', () => {
    // The defect this screen shipped for one run: `They adopted a Labrador` extracted `They`, so the
    // answer's name set was non-empty, it was disjoint from a gold naming Rachel, and a **correct**
    // answer would have been listed as a candidate. Pronouns are capitalised at the start of a sentence
    // in ordinary English, which is the same reason months had to be excluded from `entity-swap`.
    const row = nameScreen([
      answer({
        questionId: 'q11',
        gold: 'Rachel adopted a dog.',
        answer: 'They adopted a dog.',
      }),
    ]).rows[0]!;
    expect(row.answerNames).toEqual([]);
    expect(row.relation).toBe('unnamed-answer');
  });

  it('reports the names it compared, so the predicate can be audited from the reading alone', () => {
    const reading = nameScreen([
      answer({
        questionId: 'q9',
        gold: 'Rachel and Monica moved to Berlin.',
        answer: 'Rachel and Phoebe moved to Berlin.',
      }),
    ]);
    expect(reading.rows[0]).toMatchObject({
      goldNames: ['Rachel', 'Monica', 'Berlin'],
      answerNames: ['Rachel', 'Phoebe', 'Berlin'],
      sharedNames: ['Rachel', 'Berlin'],
      relation: 'shared-name',
    });
  });

  it('deduplicates a name stated twice in one text', () => {
    const reading = nameScreen([
      answer({ questionId: 'q10', gold: 'Berlin, then Berlin again.', answer: 'Berlin.' }),
    ]);
    expect(reading.rows[0]!.goldNames).toEqual(['Berlin']);
  });
});

describe('the reading', () => {
  const SOURCES: ScreenSource[] = [
    answer({ questionId: 'a1', gold: 'Rachel', answer: 'Rachel' }),
    answer({ questionId: 'a2', gold: 'Rachel', answer: 'Monica' }),
    answer({ questionId: 'a3', gold: '3', answer: '4' }),
    answer({ questionId: 'a4', gold: 'Alice and Bob', answer: '2 people' }),
    answer({ questionId: 'r1', gold: 'Rachel', answer: 'Phoebe', accepted: false }),
    answer({ questionId: 'r2', gold: '3', answer: '5', accepted: false }),
  ];

  it('tallies accepted and rejected separately, because only one of them can hold a false accept', () => {
    const reading = nameScreen(SOURCES);
    expect(reading.accepted).toEqual({
      total: 4,
      'shared-name': 1,
      'names-disjoint': 1,
      'unnamed-gold': 1,
      'unnamed-answer': 1,
    });
    expect(reading.rejected).toEqual({
      total: 2,
      'shared-name': 0,
      'names-disjoint': 1,
      'unnamed-gold': 1,
      'unnamed-answer': 0,
    });
  });

  it('lists candidates from the accepted population only', () => {
    // A rejected answer names the wrong thing too, and subtracting it would count the same failure twice:
    // the judge already called that one wrong, so it is not in any accuracy this screen corrects.
    const reading = nameScreen(SOURCES);
    expect(reading.candidates.map((row) => row.questionId)).toEqual(['a2']);
  });

  it('counts reach as the accepted rows whose gold names anything', () => {
    expect(nameScreen(SOURCES).reachable).toBe(3);
  });

  it('preserves input order so two artifacts can be diffed', () => {
    expect(nameScreen(SOURCES).rows.map((row) => row.questionId)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'r1',
      'r2',
    ]);
  });

  it('is empty rather than wrong on an empty input', () => {
    const reading = nameScreen([]);
    expect(reading.rows).toEqual([]);
    expect(reading.candidates).toEqual([]);
    expect(reading.reachable).toBe(0);
    expect(reading.accepted.total).toBe(0);
  });

  it('carries the capability through, so the same reading can be read per capability', () => {
    const reading = nameScreen([
      answer({ questionId: 'm1', capability: 'MR', gold: 'Rachel', answer: 'Monica' }),
      answer({ questionId: 't1', capability: 'TR', gold: 'Rachel', answer: 'Monica' }),
      // No `capability` at all, which is what an artifact from another producer looks like.
      { questionId: 'n1', gold: 'Rachel', answer: 'Monica', accepted: true },
    ]);
    expect(reading.rows.map((row) => row.capability)).toEqual(['MR', 'TR', '']);
  });
});

/**
 * The projection a paired reading depends on, pinned field by field.
 *
 * The value of this file is not that the function is hard. It is that the last time a report dropped
 * these fields, a pre-registered prediction was recorded as untested for a reason that was false, and
 * nothing failed -- the report was complete, plausible, and missing the rows. A test that asserts the
 * four fields the cohort needs is what makes that silence impossible.
 *
 * `41741547141` is the run: 500 questions, two arms, five aggregate numbers per repetition.
 * `§13.234`'s prediction 2 is the prediction: "at least 3 of 16 of the 41 questions whose gold sat
 * outside the pool convert". A cohort of that shape is computable only from per-question rows.
 */
import { describe, expect, it } from 'vitest';

import { pairedRows } from '../paired-readout.js';
import type { QuestionRecord } from '../question-record.js';

function record(overrides: Partial<QuestionRecord>): QuestionRecord {
  return {
    questionId: 'q1',
    capability: 'MR',
    correct: true,
    ...overrides,
  } as unknown as QuestionRecord;
}

describe('the rows a paired reading sees', () => {
  it('carries the four fields a cohort reading needs, and the two that attribute a room', () => {
    const rows = pairedRows([
      record({
        questionId: 'a',
        capability: 'MR',
        correct: false,
        goldOverlap: { carried: 2, total: 4, pool: 3, goldRanks: [0, 5, -1, 254] },
        windowComposition: { turns: 174, offered: 174, offeredChars: 37_410, unscoredChars: 0 },
        promptChars: 46_264,
      }),
    ]);
    expect(rows).toHaveLength(1);
    // `-1` survives the projection, which is the single fact the prediction needs: a gold turn the
    // ranking never surfaced is not the same as one at the deepest rank the pool holds.
    expect(rows[0]).toEqual({
      id: 'a',
      capability: 'MR',
      correct: false,
      goldRanks: [0, 5, -1, 254],
      goldPool: 3,
      deliveredTurns: 174,
      promptChars: 46_264,
    });
  });

  it('omits the ranking fields when the run consulted no ranking, rather than sending an empty list', () => {
    // "No ranking" and "the ranking surfaced nothing" are the two states a reader must not conflate:
    // the first is a configuration, the second is a retrieval collapse on that question.
    const rows = pairedRows([record({ goldOverlap: { carried: 1, total: 2 } })]);
    expect(rows[0]).not.toHaveProperty('goldRanks');
    expect(rows[0]).not.toHaveProperty('goldPool');
    expect(rows[0]).not.toHaveProperty('goldOverlap');
  });

  it('reports a missing window or prompt as null rather than as zero', () => {
    // `0` would read as "the prompt carried no turns", which is a measurement; `null` reads as "this
    // record predates the field", which is the truth.
    const rows = pairedRows([record({})]);
    expect(rows[0]?.deliveredTurns).toBeNull();
    expect(rows[0]?.promptChars).toBeNull();
  });

  it('preserves the report order, so a misalignment stays visible', () => {
    const rows = pairedRows([
      record({ questionId: 'z' }),
      record({ questionId: 'a' }),
      record({ questionId: 'm' }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['z', 'a', 'm']);
  });

  it('copies the ranks rather than aliasing the record', () => {
    const ranks = [1, -1];
    const rows = pairedRows([
      record({ goldOverlap: { carried: 1, total: 2, pool: 1, goldRanks: ranks } }),
    ]);
    expect(rows[0]?.goldRanks).toEqual([1, -1]);
    expect(rows[0]?.goldRanks).not.toBe(ranks);
  });
});

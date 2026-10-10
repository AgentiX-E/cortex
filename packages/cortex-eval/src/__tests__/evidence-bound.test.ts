/**
 * The evidence a record carries must be a bounded measurement, and a reduction
 * must never read as an absence.
 *
 * ## What went wrong, and why these tests exist
 *
 * Run `38003036421` completed all four runs of all five hundred questions and
 * then died writing the JSON:
 *
 *     RangeError: Invalid string length
 *         at JSON.stringify
 *
 * A complete measurement was destroyed by a serialization limit, and the run's
 * artifact could not distinguish "measured and could not be written" from
 * "never measured". The cause is that the memory arm carries the evidence
 * unbounded, and it carries it twice -- once in
 * `ablation.featureRetrievedContexts`, once as `questions[].turns[].text`.
 *
 * These tests pin the repair, not the incident: `evidenceTurns` and
 * `evidenceChars` are always present and never reduced, `turns` may be reduced
 * only with a marker that is distinguishable from genuine absence, and the
 * three states must not render identically.
 *
 * Zero mocks: every case builds real records from real evidence strings.
 */

import { describe, expect, it } from 'vitest';
import {
  boundRetrievedContexts,
  buildQuestionRecords,
  evidenceReductionOf,
  REDUCED_TURNS_MARKER,
  type QuestionRecordInput,
} from '../question-record.js';

/** An input with sane defaults, so each test states only what it is about. */
function input(overrides: Partial<QuestionRecordInput> = {}): QuestionRecordInput {
  return {
    questionId: 'q1',
    question: 'what did the user say?',
    capability: 'IE',
    groundTruth: 'a fact',
    answer: 'a fact',
    correct: true,
    grounded: false,
    retrieved: 'first turn\nsecond turn',
    ...overrides,
  };
}

describe('evidenceTurns and evidenceChars are unconditional', () => {
  it('reports the turn count and size for a record carried in full', () => {
    const [record] = buildQuestionRecords([input()]);

    expect(record!.evidenceTurns).toBe(2);
    // 'first turn' + '\n' + 'second turn'
    expect(record!.evidenceChars).toBe('first turn\nsecond turn'.length);
  });

  it('reports zero turns and zero chars when the reader was shown nothing', () => {
    const [record] = buildQuestionRecords([input({ retrieved: '' })]);

    expect(record!.turns).toEqual([]);
    expect(record!.evidenceTurns).toBe(0);
    expect(record!.evidenceChars).toBe(0);
  });

  it('counts turns rather than blank lines, matching what turns carries', () => {
    // `toTurns` drops blank lines, so a count taken from `split('\n')` would
    // disagree with the array beside it.
    const [record] = buildQuestionRecords([input({ retrieved: 'a\n\n\nb' })]);

    expect(record!.turns).toHaveLength(2);
    expect(record!.evidenceTurns).toBe(2);
    expect(record!.evidenceChars).toBe('a\n\n\nb'.length);
  });

  it('never reduces evidenceTurns, even when turns is truncated', () => {
    const retrieved = Array.from({ length: 50 }, (_, i) => `turn ${i}`).join('\n');
    const [record] = buildQuestionRecords([input({ retrieved })], undefined, undefined, {
      maxTurnsPerRecord: 3,
    });

    expect(record!.evidenceTurns).toBe(50);
    expect(record!.turns.length).toBeLessThan(50);
  });

  it('never reduces evidenceChars, even when turns is truncated', () => {
    const retrieved = Array.from({ length: 50 }, (_, i) => `turn ${i}`).join('\n');
    const [record] = buildQuestionRecords([input({ retrieved })], undefined, undefined, {
      maxTurnsPerRecord: 3,
    });

    expect(record!.evidenceChars).toBe(retrieved.length);
  });
});

describe('a reduction is marked and cannot read as absence', () => {
  it('appends a marker naming how many turns were dropped', () => {
    const retrieved = Array.from({ length: 10 }, (_, i) => `turn ${i}`).join('\n');
    const [record] = buildQuestionRecords([input({ retrieved })], undefined, undefined, {
      maxTurnsPerRecord: 2,
    });

    expect(record!.turns).toHaveLength(3);
    expect(record!.turns[2]!.text).toContain(REDUCED_TURNS_MARKER);
    // The marker states the true count, so a reader can tell how much is missing.
    expect(record!.turns[2]!.text).toContain('10');
    expect(record!.turns[2]!.text).toContain('8');
  });

  it('does not mark a record that fits inside the bound', () => {
    const retrieved = 'a\nb\nc';
    const [record] = buildQuestionRecords([input({ retrieved })], undefined, undefined, {
      maxTurnsPerRecord: 3,
    });

    expect(record!.turns).toHaveLength(3);
    expect(record!.turns.some((t) => t.text.includes(REDUCED_TURNS_MARKER))).toBe(false);
  });

  it('does not mark a record whose reader was shown nothing', () => {
    const [record] = buildQuestionRecords([input({ retrieved: '' })], undefined, undefined, {
      maxTurnsPerRecord: 3,
    });

    expect(record!.turns).toEqual([]);
  });

  it('does not mark a record when no bound is given', () => {
    const retrieved = Array.from({ length: 100 }, (_, i) => `turn ${i}`).join('\n');
    const [record] = buildQuestionRecords([input({ retrieved })]);

    expect(record!.turns).toHaveLength(100);
    expect(record!.turns.some((t) => t.text.includes(REDUCED_TURNS_MARKER))).toBe(false);
  });
});

describe('the three states are distinguishable', () => {
  const retrieved = Array.from({ length: 10 }, (_, i) => `turn ${i}`).join('\n');

  it('separates "shown nothing" from "shown and reduced"', () => {
    const [nothing] = buildQuestionRecords([input({ retrieved: '' })]);
    const [reduced] = buildQuestionRecords([input({ retrieved })], undefined, undefined, {
      maxTurnsPerRecord: 2,
    });

    expect(nothing!.evidenceTurns).toBe(0);
    expect(reduced!.evidenceTurns).toBe(10);
    expect(reduced!.turns.length).toBeGreaterThan(nothing!.turns.length);
  });

  it('separates "carried in full" from "shown and reduced"', () => {
    const [full] = buildQuestionRecords([
      input({ retrieved: Array.from({ length: 3 }, (_, i) => `turn ${i}`).join('\n') }),
    ]);
    const [reduced] = buildQuestionRecords([input({ retrieved })], undefined, undefined, {
      maxTurnsPerRecord: 2,
    });

    // `turns.length === evidenceTurns` exactly when nothing was dropped.
    expect(full!.turns.length).toBe(full!.evidenceTurns);
    expect(reduced!.turns.length).not.toBe(reduced!.evidenceTurns);
  });

  it('separates "shown nothing" from "carried in full"', () => {
    const [nothing] = buildQuestionRecords([input({ retrieved: '' })]);
    const [full] = buildQuestionRecords([input({ retrieved: 'a' })]);

    expect(nothing!.evidenceTurns).toBe(0);
    expect(full!.evidenceTurns).toBe(1);
    expect(nothing!.turns).toEqual([]);
    expect(full!.turns).toHaveLength(1);
  });
});

describe('evidenceReductionOf reports what the bound did', () => {
  it('is null when no record was reduced', () => {
    const records = buildQuestionRecords([input(), input({ questionId: 'q2' })]);

    expect(evidenceReductionOf(records)).toBeNull();
  });

  it('is null for an empty record list', () => {
    expect(evidenceReductionOf([])).toBeNull();
  });

  it('names the reduced records and the totals', () => {
    const retrieved = Array.from({ length: 10 }, (_, i) => `turn ${i}`).join('\n');
    const records = buildQuestionRecords(
      [input({ retrieved }), input({ questionId: 'q2', retrieved: 'a' })],
      undefined,
      undefined,
      { maxTurnsPerRecord: 2 },
    );

    const reduction = evidenceReductionOf(records);

    expect(reduction).not.toBeNull();
    expect(reduction!.reducedQuestionIds).toEqual(['q1']);
    // 2 real turns + the marker for q1, plus the single turn for q2.
    expect(reduction!.turnsCarried).toBe(4);
    expect(reduction!.turnsMeasured).toBe(11);
    expect(reduction!.maxTurnsPerRecord).toBe(2);
  });

  it('posts a marker count consistent with turnsMeasured', () => {
    // The marker states how many turns were dropped, so the two ends of the
    // manifest must agree: carried + dropped === measured.
    const retrieved = Array.from({ length: 10 }, (_, i) => `turn ${i}`).join('\n');
    const records = buildQuestionRecords([input({ retrieved })], undefined, undefined, {
      maxTurnsPerRecord: 2,
    });
    const reduction = evidenceReductionOf(records)!;

    const dropped = reduction.turnsMeasured - reduction.turnsCarried + 1; // +1: the marker is not a real turn
    expect(records[0]!.turns.at(-1)!.text).toContain(String(dropped));
  });
});

describe('the bound is a record-level bound, applied per record', () => {
  it('applies the bound independently to each record', () => {
    const long = Array.from({ length: 10 }, (_, i) => `turn ${i}`).join('\n');
    const records = buildQuestionRecords(
      [
        input({ retrieved: long }),
        input({ questionId: 'q2', retrieved: 'short' }),
        input({ questionId: 'q3', retrieved: long }),
      ],
      undefined,
      undefined,
      { maxTurnsPerRecord: 2 },
    );

    expect(records[0]!.turns).toHaveLength(3);
    expect(records[1]!.turns).toHaveLength(1);
    expect(records[2]!.turns).toHaveLength(3);
  });

  it('rejects a bound below one, which would carry no turn at all', () => {
    expect(() =>
      buildQuestionRecords([input()], undefined, undefined, { maxTurnsPerRecord: 0 }),
    ).toThrow(/maxTurnsPerRecord/);
  });
});

describe('boundRetrievedContexts keeps the second evidence copy in step', () => {
  /**
   * ## Why the evidence has to be bound twice
   *
   * The arm persists the same evidence in two places: `questions[].turns[].text`
   * and `ablation.featureRetrievedContexts`. §69 registered a bound for the first
   * and left the second alone, and run `38044858147` measured the consequence --
   * a **258 MB** artifact whose records were down to seventeen turns each while
   * 256 MB of it was the untruncated second copy. The artifact survived only
   * because 253 MB happens to sit below V8's 537 MB string limit; a larger
   * dataset puts it back over.
   *
   * A reduction that reaches one copy and not the other is therefore not a
   * cosmetic defect: it is a bound that does not bound, and the two copies
   * disagree about what the reader was shown.
   */
  it('returns the input array itself when no bound is given', () => {
    // Identity, not equality: unbounded is the pre-existing behaviour, and a
    // caller that passes no bound must get exactly its own data back rather
    // than a copy that merely compares equal.
    const contexts = ['a\nb', null, 'c'];
    expect(boundRetrievedContexts(contexts, undefined)).toBe(contexts);
  });

  it('bounds each context into exactly the turns the matching record carries', () => {
    // The invariant, stated as an equality between the two copies rather than as
    // a size assertion: whatever the reader is shown per the record must be what
    // the ablation vector says they were shown. Sizes would pass for a bound that
    // truncated the two copies differently.
    const contexts = ['t0\nt1\nt2\nt3\nt4', 'x0\nx1', 'only'];
    const bound = { maxTurnsPerRecord: 2 };
    const bounded = boundRetrievedContexts(contexts, bound);
    const records = buildQuestionRecords(
      contexts.map((retrieved, i) => input({ questionId: `q${i}`, retrieved })),
      undefined,
      undefined,
      bound,
    );

    for (let i = 0; i < contexts.length; i++) {
      expect(bounded[i]!.split('\n')).toEqual(records[i]!.turns.map((turn) => turn.text));
    }
  });

  it('preserves null as null, which is not the same fact as empty', () => {
    // `null` is "no reader was consulted"; `''` is "a reader was consulted and
    // shown nothing". The records keep the distinction (`retrievedContexts[i] ??
    // ''` collapses it only at the point of record construction, where the shape
    // forces it), so collapsing it in the persisted vector would erase it in the
    // one place it is still expressible.
    const bounded = boundRetrievedContexts([null, ''], { maxTurnsPerRecord: 2 });
    expect(bounded[0]).toBeNull();
    expect(bounded[1]).toBe('');
  });

  it('carries the marker so a bounded copy cannot read as a short one', () => {
    // The same disclosure the record's `turns` carries, for the same reason: a
    // reader holding only this vector must be able to tell "shown three turns"
    // from "shown one of three".
    const bounded = boundRetrievedContexts(['t0\nt1\nt2'], { maxTurnsPerRecord: 1 });
    expect(bounded[0]).toContain(REDUCED_TURNS_MARKER);
    expect(bounded[0]).toContain('2 of 3 turns not carried');
  });

  it('drops blank lines exactly as the record builder does', () => {
    // `toTurns` drops blanks before counting, so a bound applied to a different
    // splitting of the same text would keep a different prefix. Both copies go
    // through the one function that owns the rule.
    const bounded = boundRetrievedContexts(['a\n\nb\n\nc'], { maxTurnsPerRecord: 1 });
    expect(bounded[0]!.split('\n')).toEqual([
      'a',
      `${REDUCED_TURNS_MARKER} 2 of 3 turns not carried]`,
    ]);
  });

  it('rejects a bound below one for the same reason the builder does', () => {
    expect(() => boundRetrievedContexts(['a'], { maxTurnsPerRecord: 0 })).toThrow(
      /maxTurnsPerRecord/,
    );
  });
});

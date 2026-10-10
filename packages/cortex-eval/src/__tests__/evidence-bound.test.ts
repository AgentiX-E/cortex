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

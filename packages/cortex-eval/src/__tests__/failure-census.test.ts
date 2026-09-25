import { describe, expect, it } from 'vitest';
import { decomposeFailures, type DiagnosticRecord } from '../failure-census.js';

/**
 * The census is arithmetic over the per-question diagnostics the benchmark
 * writes, so every fixture states the fields it actually reads. Nothing is
 * mocked: the unit receives records shaped like the artifact and returns a
 * decomposition of them.
 *
 * The fixtures below are modelled on real A2 records, including the shape that
 * matters most -- `capability` is present on single-session records and absent
 * on multi-session ones, because those are all MR.
 */

function record(
  id: string,
  capability: string | undefined,
  correct: boolean,
  reason: string,
  abstained: boolean,
): DiagnosticRecord {
  return {
    question_id: id,
    ...(capability !== undefined ? { capability } : {}),
    question: `question ${id}`,
    correct,
    decision: { reason, abstained },
  };
}

describe('decomposeFailures', () => {
  it('counts a failure by the arm it was measured on rather than by the reader outcome', () => {
    const census = decomposeFailures({
      records: [
        record('a', 'IE', true, 'answered', false),
        record('b', 'IE', false, 'answered', false),
        record('c', 'ABS', false, 'answered', false),
      ],
    });

    expect(census.total).toBe(3);
    expect(census.correct).toBe(1);
    expect(census.failed).toBe(2);
  });

  it('separates the failures into refused and answered', () => {
    const census = decomposeFailures({
      records: [
        record('a', 'TR', false, 'llm', true),
        record('b', 'TR', false, 'llm', true),
        record('c', 'TR', false, 'answered', false),
      ],
    });

    // A refused failure and an answered failure are different defects: one is
    // the system declining a question it could answer, the other is the system
    // asserting something false. Collapsing them into "3 wrong" hides which
    // subsystem to look at.
    expect(census.failedAnswered).toBe(1);
    expect(census.failedRefused).toBe(2);
    expect(census.failedAnswered + census.failedRefused).toBe(census.failed);
  });

  it('reports the abstention decision and the failure mode as separate axes', () => {
    // `abstained` is what the system did; `correct` is whether it was right. An
    // abstention on an ABS question is a success, and the same behaviour on an
    // IE question is a failure. The census must not derive one from the other.
    const census = decomposeFailures({
      records: [
        record('abs-ok', 'ABS', true, 'llm', true),
        record('ie-bad', 'IE', false, 'llm', true),
        record('ie-ok', 'IE', true, 'answered', false),
      ],
    });

    expect(census.abstained).toBe(2);
    expect(census.failedRefused).toBe(1);
    expect(census.correct).toBe(2);
  });

  it('infers MR for a record whose capability is absent rather than reporting it unknown', () => {
    // The multi-session diagnostics are filtered to MR before being written, so
    // those records carry no `capability` field. Treating that as unknown would
    // drop 121 questions from a 500-question census and leave the per-capability
    // table summing to less than the total with nothing saying why.
    const census = decomposeFailures({
      records: [
        record('mr-1', undefined, false, 'answered', false),
        record('ie-1', 'IE', true, 'answered', false),
      ],
    });

    expect(census.byCapability['MR']).toEqual({
      total: 1,
      correct: 0,
      failed: 1,
      failedAnswered: 1,
      failedRefused: 0,
    });
    expect(census.byCapability['IE']?.failed).toBe(0);
  });

  it('leaves an unrecognised capability in the census instead of discarding it', () => {
    // A capability the analysis does not know about is still a failure someone
    // will have to fix. Dropping it would make the per-capability table's sum
    // disagree with the total, which is the class of defect this census exists
    // to make visible.
    const census = decomposeFailures({
      records: [
        record('x', 'ZZ', false, 'answered', false),
        record('y', 'IE', false, 'answered', false),
      ],
    });

    expect(census.failed).toBe(2);
    const summed = Object.values(census.byCapability).reduce((n, c) => n + c.failed, 0);
    expect(summed).toBe(census.failed);
    expect(census.byCapability['ZZ']?.failed).toBe(1);
  });

  it('per-capability counts always sum to the totals', () => {
    const census = decomposeFailures({
      records: [
        record('a', 'IE', true, 'answered', false),
        record('b', 'TR', false, 'llm', true),
        record('c', undefined, false, 'answered', false),
        record('d', 'KU', false, 'llm', true),
        record('e', 'ABS', true, 'llm', true),
      ],
    });

    const sum = (pick: (c: (typeof census.byCapability)[string]) => number): number =>
      Object.values(census.byCapability).reduce((n, c) => n + pick(c), 0);
    expect(sum((c) => c.total)).toBe(census.total);
    expect(sum((c) => c.correct)).toBe(census.correct);
    expect(sum((c) => c.failed)).toBe(census.failed);
    expect(sum((c) => c.failedAnswered)).toBe(census.failedAnswered);
    expect(sum((c) => c.failedRefused)).toBe(census.failedRefused);
  });

  it('names the failing question ids so the population is auditable', () => {
    const census = decomposeFailures({
      records: [
        record('q-fail-1', 'TR', false, 'answered', false),
        record('q-fail-2', 'TR', false, 'llm', true),
        record('q-ok', 'TR', true, 'answered', false),
      ],
    });

    expect(census.failedAnsweredIds).toEqual(['q-fail-1']);
    expect(census.failedRefusedIds).toEqual(['q-fail-2']);
  });

  it('reports the refusal rate among failures so a small denominator is visible', () => {
    const census = decomposeFailures({
      records: [
        record('a', 'TR', false, 'llm', true),
        record('b', 'TR', false, 'answered', false),
        record('c', 'TR', false, 'answered', false),
        record('d', 'TR', false, 'answered', false),
      ],
    });

    expect(census.failedRefusedRate).toBeCloseTo(0.25, 10);
  });

  it('reports zero rates rather than NaN for an empty census', () => {
    const census = decomposeFailures({ records: [] });

    expect(census.total).toBe(0);
    expect(census.failedRefusedRate).toBe(0);
    expect(census.byCapability).toEqual({});
    expect(census.failedAnsweredIds).toEqual([]);
  });

  it('counts a question the system answered correctly after refusing it first as answered', () => {
    // The retry path can flip a refusal into an answer. `decision.reason` is the
    // final reason, so the record's own fields must be read as final state and
    // not as the first decision.
    const census = decomposeFailures({
      records: [record('retried', 'MR', true, 'answered', false)],
    });

    expect(census.abstained).toBe(0);
    expect(census.correct).toBe(1);
  });
});

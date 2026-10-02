/**
 * Session boundaries are the input the flat path cannot receive.
 *
 * `runBenchmark` routes MR questions to `answerSessions(question, sessions)`
 * where each element of `sessions` is one session's ordered turns. This file
 * covers the pure step that turns per-question turn groups into that shape
 * while applying admission *per session*, so one uninformative session cannot
 * dilute another.
 */
import { describe, expect, it } from 'vitest';
import { admitSessions, selectSessionBudget, type AdmittedSession } from '../sessionize.js';

const NOW = 1_700_000_000_000;

function turn(label: string): string {
  return `the user said something about ${label} and it was recorded in full`;
}

const PERMISSIVE = { now: NOW, threshold: 0 };

describe('admitSessions', () => {
  it('returns one admitted session per input session, in order', () => {
    const sessions = [[turn('a1'), turn('a2')], [turn('b1')]];
    const admitted = admitSessions(sessions, PERMISSIVE);

    expect(admitted).toHaveLength(2);
    expect(admitted[0]?.turns.map((t) => t.content)).toEqual([turn('a1'), turn('a2')]);
    expect(admitted[1]?.turns.map((t) => t.content)).toEqual([turn('b1')]);
  });

  it('applies admission independently per session', () => {
    // Session 0 clears the threshold, session 1 does not. Independently means
    // the weak session's turns are judged on their own value, not on the
    // concatenation's, which would let the strong session lift them over the
    // line. The weak session is dropped entirely (see the next case).
    const sessions = [[turn('strong')], [turn('weak')]];
    const admitted = admitSessions(sessions, {
      now: NOW,
      threshold: 0.6,
      valueFunction: (memory) => (memory.content.includes('strong') ? 0.9 : 0.1),
    });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.turns.map((t) => t.content)).toEqual([turn('strong')]);
  });

  it('does not let a strong session lift a weak one over the threshold', () => {
    // The counterfactual for the previous case: admitting over the
    // concatenation and re-splitting would keep both turns, because the
    // session's best value would be 0.9 for each half. Session independence is
    // what makes the gate measure what it claims to measure.
    const sessions = [[turn('strong')], [turn('weak')]];
    const admitted = admitSessions(sessions, {
      now: NOW,
      threshold: 0.6,
      valueFunction: (memory) => (memory.content.includes('strong') ? 0.9 : 0.1),
    });

    const contents = admitted.flatMap((s) => s.turns.map((t) => t.content));
    expect(contents).not.toContain(turn('weak'));
  });

  it('keeps a session whose turns are all admitted, and reports its size', () => {
    const admitted = admitSessions([[turn('x'), turn('y')]], PERMISSIVE);

    expect(admitted[0]?.size).toBe(2);
  });

  it('retains the session index so a caller can point back at the source', () => {
    const admitted = admitSessions([[turn('x')], [turn('y')], [turn('z')]], PERMISSIVE);

    expect(admitted.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('drops sessions that admitted nothing', () => {
    // An empty session carries no evidence and costs prompt budget. Keeping it
    // would make a boundary look populated when it is not.
    const admitted = admitSessions([[turn('keep')], [turn('drop')]], {
      now: NOW,
      threshold: 0.6,
      valueFunction: (memory) => (memory.content.includes('keep') ? 0.9 : 0.1),
    });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.index).toBe(0);
  });

  it('returns an empty list for an empty input', () => {
    expect(admitSessions([], PERMISSIVE)).toEqual([]);
  });

  it('handles a session with a single turn', () => {
    const admitted = admitSessions([[turn('lonely')]], PERMISSIVE);

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.size).toBe(1);
  });
});

describe('selectSessionBudget', () => {
  function session(index: number, value: number, size: number): AdmittedSession {
    return {
      index,
      size,
      turns: Array.from({ length: size }, (_, i) => ({
        ...admittedStub(value),
        content: `s${index} turn ${i}`,
      })),
    };
  }

  it('keeps every session when the budget covers them all', () => {
    const sessions = [session(0, 0.9, 1), session(1, 0.8, 1)];
    const selected = selectSessionBudget(sessions, 10);

    expect(selected).toHaveLength(2);
  });

  it('prefers higher-value sessions when the budget binds', () => {
    // This is the whole point of a bounded admission: spend the turn budget on
    // the session retrieval already judged relevant, instead of on scattered
    // neighbours. The conformance docstring in cortex-eval cites the measured
    // 52.4% vs 40.0% evidence-session admission gap this encodes.
    const sessions = [session(0, 0.2, 2), session(1, 0.9, 1), session(2, 0.5, 1)];
    const selected = selectSessionBudget(sessions, 1);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.index).toBe(1);
  });

  it('breaks ties by original session order so the result is deterministic', () => {
    const sessions = [session(0, 0.5, 1), session(1, 0.5, 1)];
    const selected = selectSessionBudget(sessions, 1);

    expect(selected[0]?.index).toBe(0);
  });

  it('returns the selected sessions in ascending index order, not value order', () => {
    // Selection is by value; presentation must be chronological, because a
    // prompt that lists later sessions before earlier ones makes relative-time
    // and knowledge-update questions unanswerable.
    const sessions = [session(0, 0.1, 1), session(1, 0.9, 1), session(2, 0.4, 1)];
    const selected = selectSessionBudget(sessions, 2);

    expect(selected.map((s) => s.index)).toEqual([1, 2]);
  });

  it('treats a zero budget as admitting nothing', () => {
    expect(selectSessionBudget([session(0, 0.9, 1)], 0)).toEqual([]);
  });

  it('never exceeds the budget', () => {
    const sessions = [session(0, 0.9, 2), session(1, 0.8, 2)];
    const selected = selectSessionBudget(sessions, 2);
    const used = selected.reduce((sum, s) => sum + s.size, 0);

    expect(used).toBeLessThanOrEqual(2);
  });

  it('admits a session that would overflow rather than returning nothing', () => {
    // If every session is larger than the budget, admitting none is the wrong
    // answer: the system would answer every question from no evidence. The
    // single highest-value session is admitted even though it overflows.
    const sessions = [session(0, 0.9, 5)];
    const selected = selectSessionBudget(sessions, 2);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.index).toBe(0);
  });
});

/** A minimal admitted-turn stub; only the fields `selectSessionBudget` reads. */
function admittedStub(value: number) {
  return {
    id: 'stub',
    content: 'stub',
    value,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic' as const,
    tags: [] as string[],
    createdAt: NOW,
    lastAccessedAt: NOW,
    stability: 1,
    difficulty: 5,
    ordinal: 0,
  };
}

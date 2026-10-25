/**
 * Filling a budget with turns instead of sessions.
 *
 * The rule this file is about: a session that does not fit whole is **trimmed**, not dropped. That is the
 * difference LongMemEval's paper measures as `GRANULARITY: turn | session` (+9.4 recall@5), and the difference
 * between `all-gold 82.2%` and `6.6%` at an eight-turn budget on the real corpus.
 *
 * Every case below uses a session of more than one turn, because a one-turn session cannot tell the two
 * granularities apart — which is exactly why the synthetic corpus never surfaced the defect.
 */

import { describe, expect, it } from 'vitest';
import {
  selectSessionBudget,
  selectTurnsWithinBudget,
  type AdmittedSession,
} from '../sessionize.js';
import { lexicalRelevance } from '../relevance.js';

const NOW = 1_700_000_000_000;

/** One admitted turn, with only the fields the budget reads plus `content`. */
function turn(content: string, ordinal: number) {
  return {
    id: `t${ordinal}`,
    content,
    value: 0.5,
    confidence: 1,
    source: 'unknown' as const,
    sourceTrust: 0.5,
    type: 'episodic' as const,
    tags: [] as string[],
    createdAt: NOW,
    lastAccessedAt: NOW,
    stability: 1,
    difficulty: 5,
    ordinal,
  };
}

function session(index: number, contents: readonly string[]): AdmittedSession {
  return { index, size: contents.length, turns: contents.map((c, i) => turn(c, i)) };
}

const relevanceOf = (question: string) => (t: { readonly content: string }) =>
  lexicalRelevance(question, t.content);

describe('selectTurnsWithinBudget: trim instead of drop', () => {
  it('keeps a session whole when it fits', () => {
    const sessions = [session(0, ['alpha one', 'alpha two'])];
    const plan = selectTurnsWithinBudget(sessions, 2, { relevance: relevanceOf('alpha') });
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]!.turns).toHaveLength(2);
    expect(plan.trimmed).toBe(0);
  });

  it('trims a session that does not fit instead of dropping it', () => {
    // The whole point. Two sessions of three turns each against a budget of three: the whole-session rule takes
    // one and drops the other; this rule takes one whole and one turn of the other.
    const sessions = [
      session(0, ['alpha a', 'alpha b', 'alpha c']),
      session(1, ['beta d', 'beta e', 'beta f']),
    ];
    const plan = selectTurnsWithinBudget(sessions, 4, { relevance: relevanceOf('alpha beta') });
    expect(plan.sessions).toHaveLength(2);
    expect(plan.trimmed).toBe(1);
    expect(plan.spent).toBeLessThanOrEqual(4);
    // And the whole-session rule on the same input loses the second session entirely.
    const whole = selectSessionBudget(sessions, 4);
    expect(whole).toHaveLength(1);
  });

  it('takes the most relevant turn when trimming, not the first', () => {
    const sessions = [session(0, ['nothing here', 'nothing here either', 'the berlin answer'])];
    const question = 'berlin';
    const plan = selectTurnsWithinBudget(sessions, 1, { relevance: relevanceOf(question) });
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]!.turns.map((t) => t.content)).toEqual(['the berlin answer']);
  });

  it('presents a trimmed session in arrival order, not in relevance order', () => {
    // Selection is by relevance; presentation is chronological. A block that lists a later turn first makes
    // relative-time questions unanswerable, which is why the whole-session rule pays a second sort for the same
    // property.
    const sessions = [session(0, ['berlin earliest', 'filler', 'berlin latest'])];
    const plan = selectTurnsWithinBudget(sessions, 2, { relevance: relevanceOf('berlin') });
    const kept = plan.sessions[0]!.turns.map((t) => t.content);
    expect(kept).toEqual(['berlin earliest', 'berlin latest']);
    // Chronological despite both scoring identically above the filler.
    expect(plan.sessions[0]!.turns.map((t) => t.ordinal)).toEqual([0, 2]);
  });

  it('reports what it trimmed and what it dropped', () => {
    const sessions = [
      session(0, ['alpha a', 'alpha b', 'alpha c']),
      session(1, ['alpha d', 'alpha e', 'alpha f']),
      session(2, ['alpha g', 'alpha h', 'alpha i']),
    ];
    const plan = selectTurnsWithinBudget(sessions, 3, { relevance: relevanceOf('alpha') });
    // One whole, then no room for another whole; the rest are trimmed to whatever fits (nothing).
    expect(plan.trimmed + plan.dropped).toBeGreaterThan(0);
    expect(plan.spent).toBeLessThanOrEqual(3);
  });

  it('trims rather than falling back when one turn fits', () => {
    // The ordinary path: two turns of one against a budget of one is a trim, not a fallback.
    const sessions = [session(0, ['alpha a', 'alpha b'])];
    const plan = selectTurnsWithinBudget(sessions, 1, { relevance: relevanceOf('alpha') });
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]!.turns).toHaveLength(1);
    expect(plan.trimmed).toBe(1);
  });

  it('admits one turn rather than nothing when not even one fits', () => {
    // The fallback, and the only state that reaches it: every turn costs more than the whole budget. Answering
    // from no evidence is worse than exceeding the budget -- the same rule, for the same reason, as the
    // whole-session path.
    const sessions = [session(0, ['alpha a', 'alpha b'])];
    const plan = selectTurnsWithinBudget(sessions, 3, {
      cost: () => 10,
      relevance: relevanceOf('alpha'),
    });
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]!.turns).toHaveLength(1);
    expect(plan.spent).toBe(10);
    expect(plan.trimmed).toBe(1);
  });

  it('spends characters when a character cost is supplied', () => {
    // The unit the published systems report in. Two turns of ten characters each against a budget of ten:
    // exactly one fits.
    const sessions = [session(0, ['0123456789', 'abcdefghij'])];
    const plan = selectTurnsWithinBudget(sessions, 10, {
      cost: (t) => t.content.length,
      relevance: relevanceOf('0123456789'),
    });
    expect(plan.spent).toBeLessThanOrEqual(10);
    expect(plan.sessions[0]!.turns).toHaveLength(1);
  });

  it('returns nothing for a non-positive budget', () => {
    expect(selectTurnsWithinBudget([session(0, ['a'])], 0, { relevance: () => 1 })).toEqual({
      sessions: [],
      spent: 0,
      trimmed: 0,
      dropped: 0,
    });
  });

  it('returns nothing for an empty input', () => {
    expect(selectTurnsWithinBudget([], 5, { relevance: () => 1 }).sessions).toEqual([]);
  });

  it('rejects a NaN cost, which would spend a budget that is not a size', () => {
    expect(() =>
      selectTurnsWithinBudget([session(0, ['a'])], 5, {
        cost: () => Number.NaN,
        relevance: () => 1,
      }),
    ).toThrow(/TurnCost must return a finite, non-negative number/);
  });

  it('rejects a negative cost', () => {
    expect(() =>
      selectTurnsWithinBudget([session(0, ['a'])], 5, { cost: () => -1, relevance: () => 1 }),
    ).toThrow(/must return a finite, non-negative number, got -1/);
  });

  it('rejects a NaN relevance, which would trim in arrival order', () => {
    expect(() =>
      selectTurnsWithinBudget([session(0, ['a'])], 5, { relevance: () => Number.NaN }),
    ).toThrow(/TurnRelevance must return a finite number/);
  });

  it('agrees with whole-session admission when every session fits', () => {
    // The two arms are different rules, so this is the one state where they must coincide; if they ever
    // disagree here, one of them is spending a budget it does not have.
    const sessions = [session(0, ['alpha a', 'alpha b']), session(1, ['beta c'])];
    const whole = selectSessionBudget(sessions, 10, (s) => s.size);
    const trimmed = selectTurnsWithinBudget(sessions, 10, { relevance: relevanceOf('alpha beta') });
    expect(trimmed.sessions.map((s) => s.index)).toEqual(whole.map((s) => s.index));
    expect(trimmed.trimmed).toBe(0);
  });

  it('keeps the session index so a hit can be attributed to its conversation', () => {
    const sessions = [session(4, ['alpha a', 'alpha b'])];
    const plan = selectTurnsWithinBudget(sessions, 1, { relevance: relevanceOf('alpha') });
    expect(plan.sessions[0]!.index).toBe(4);
  });
});

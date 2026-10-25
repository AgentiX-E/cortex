/**
 * The ledger, and what later evidence does to it.
 *
 * The suite is built around the three questions a stored fact can be wrong about — *when*, *whether*,
 * *how many* — because those are the three assumptions that carry weight. The other three are checked
 * for the narrower reason they exist: to make sure the ledger does not read as complete when it is not.
 */

import { describe, expect, it } from 'vitest';
import {
  assumptionOf,
  assumptionPenalty,
  deriveAssumptions,
  describeAssumptions,
  isAnswerable,
  slotKey,
  type AssumptionKind,
} from '../assumption.js';
import type { KnowledgeFact, KnowledgeFrame } from '../frame.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const FRAME: KnowledgeFrame = {
  id: 'f1',
  text: 'I run a bakery in Leeds.',
  speaker: 'user',
  at: T0,
};

function factOf(overrides: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    id: 'a1',
    frameId: 'f1',
    text: 'I run a bakery in Leeds.',
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: 25 },
    references: [],
    ...overrides,
  };
}

/** A fact with its ledger filled, which is what a caller does before assembling a unit. */
function ledgered(
  overrides: Partial<KnowledgeFact> = {},
  frame: KnowledgeFrame = FRAME,
): KnowledgeFact {
  const fact = factOf({ frameId: frame.id, ...overrides });
  return { ...fact, assumptions: deriveAssumptions(fact, frame) };
}

function kindsOf(fact: KnowledgeFact): AssumptionKind[] {
  return (fact.assumptions ?? []).map((assumption) => assumption.kind);
}

describe('deriveAssumptions: what the ledger records, and what it refuses to invent', () => {
  it('always records persistence, because every fact is assumed to still hold', () => {
    expect(kindsOf(ledgered())).toContain('persistence');
  });

  it('records a time anchor only when the fact has no time and the frame does', () => {
    const anchored = ledgered();
    expect(assumptionOf(anchored, 'time-anchor')).toEqual({
      kind: 'time-anchor',
      origin: 'ingestion-time',
      value: String(T0),
      status: 'open',
      support: 0,
      contradict: 0,
      openedAt: T0,
    });

    // The fact states its own time, so there is nothing to assume about when it was.
    expect(assumptionOf(ledgered({ at: T0 - 90 * DAY }), 'time-anchor')).toBeUndefined();
    // Neither side has a time. Inventing the epoch would be worse than admitting the gap.
    expect(assumptionOf(ledgered({}, { id: 'f1', text: 'x' }), 'time-anchor')).toBeUndefined();
  });

  it('records uniqueness only when the fact names a slot', () => {
    expect(
      assumptionOf(ledgered({ subject: 'user', predicate: 'city' }), 'uniqueness')?.value,
    ).toBe(slotKey('user', 'city'));
    expect(assumptionOf(ledgered({ subject: 'user' }), 'uniqueness')).toBeUndefined();
  });

  it('records attribution from the frame, and nothing when the speaker is unknown', () => {
    expect(assumptionOf(ledgered(), 'attribution')?.value).toBe('user');
    expect(
      assumptionOf(ledgered({}, { id: 'f1', text: 'x', at: T0 }), 'attribution'),
    ).toBeUndefined();
  });

  it('records one entity binding per borrowed word, with the source it came from', () => {
    const borrowed = ledgered({
      references: [
        { token: 'Leeds', sourceId: 'earlier' },
        { token: 'bakery', sourceId: 'earlier' },
      ],
    });
    expect(
      (borrowed.assumptions ?? [])
        .filter((assumption) => assumption.kind === 'entity-binding')
        .map((assumption) => assumption.value),
    ).toEqual(['leeds@earlier', 'bakery@earlier']);
  });

  it('records completeness from a declared count, and never from a numeral in the text', () => {
    expect(assumptionOf(ledgered({ count: 2 }), 'completeness')?.value).toBe('2');
    // "I run 2 bakeries" carries a numeral but does not declare a set; guessing would be a second,
    // different claim about a different set of things.
    expect(
      assumptionOf(ledgered({ text: 'I run 2 bakeries in Leeds.' }), 'completeness'),
    ).toBeUndefined();
  });

  it('is deterministic: the same fact and frame give the same ledger in the same order', () => {
    expect(deriveAssumptions(factOf(), FRAME)).toEqual(deriveAssumptions(factOf(), FRAME));
  });

  it('starts every assumption open with zero evidence', () => {
    for (const assumption of deriveAssumptions(factOf(), FRAME)) {
      expect(assumption.status).toBe('open');
      expect(assumption.support).toBe(0);
      expect(assumption.contradict).toBe(0);
    }
  });
});

describe('slotKey: one slot, one spelling', () => {
  it('folds case and padding', () => {
    expect(slotKey(' User ', 'City')).toBe(slotKey('user', 'city'));
  });

  it('keeps subject and predicate apart, so a comma cannot merge two slots', () => {
    expect(slotKey('a', 'b,c')).not.toBe(slotKey('a,b', 'c'));
  });
});

describe('assumptionPenalty: three behaviours, not three multipliers', () => {
  const fresh = ledgered({ subject: 'user', predicate: 'city' });

  it('answers from a fact whose persistence is open and young', () => {
    expect(assumptionPenalty(fresh, T0 + DAY)).toEqual({ factor: 1, reason: 'answerable' });
  });

  it('discounts, but does not drop, a fact that has gone untested', () => {
    expect(assumptionPenalty(fresh, T0 + 400 * DAY)).toEqual({ factor: 0.5, reason: 'aged' });
  });

  it('drops a refuted fact from the default path', () => {
    const refuted: KnowledgeFact = {
      ...fresh,
      assumptions: (fresh.assumptions ?? []).map((assumption) =>
        assumption.kind === 'persistence'
          ? { ...assumption, status: 'refuted' as const }
          : assumption,
      ),
    };
    expect(assumptionPenalty(refuted, T0 + DAY)).toEqual({ factor: 0, reason: 'refuted' });
    expect(isAnswerable(refuted)).toBe(false);
  });

  it('drops a fact whose premise was refuted, without calling the fact itself false', () => {
    expect(assumptionPenalty({ ...fresh, stale: true }, T0 + DAY)).toEqual({
      factor: 0,
      reason: 'stale',
    });
  });

  it('accepts a caller-supplied ttl and discount, so an ablation can move them', () => {
    expect(assumptionPenalty(fresh, T0 + 10 * DAY, { ttlMs: 5 * DAY, discount: 0.25 })).toEqual({
      factor: 0.25,
      reason: 'aged',
    });
  });

  it('treats a fact with no ledger as answerable, because nothing has been assumed against it', () => {
    expect(assumptionPenalty(factOf(), T0 + 400 * DAY)).toEqual({
      factor: 1,
      reason: 'answerable',
    });
  });
});

describe('describeAssumptions: only what a reader would not otherwise know', () => {
  it('says nothing when the only assumption is an open persistence', () => {
    // A fact that states its own time and names no set rests on nothing a reader has to be warned about.
    const plain = ledgered({ at: T0 }, { id: 'f1', text: 'x', at: T0 });
    expect(describeAssumptions(plain)).toBe('');
  });

  it('names a refuted persistence, because that changes how the fact must be read', () => {
    const base = ledgered({ at: T0 }, { id: 'f1', text: 'x', at: T0 });
    const refuted: KnowledgeFact = {
      ...base,
      assumptions: (base.assumptions ?? []).map((assumption) =>
        assumption.kind === 'persistence'
          ? { ...assumption, status: 'refuted' as const }
          : assumption,
      ),
    };
    expect(describeAssumptions(refuted)).toBe('refuted');
  });

  it('shows a time anchor as a date, marked as assumed', () => {
    const anchored = ledgered();
    expect(describeAssumptions(anchored)).toContain('(assumed)');
    expect(describeAssumptions(anchored)).toContain('2026-01-01');
  });

  it('shows a declared count, because an incomplete set reads as complete', () => {
    expect(describeAssumptions(ledgered({ at: T0, count: 2 }))).toBe(
      'count = 2 (assumed complete)',
    );
  });

  it('stays silent about attribution and entity binding, which the export already carries', () => {
    const described = describeAssumptions(
      ledgered({ at: T0, references: [{ token: 'Leeds', sourceId: 's1' }] }),
    );
    expect(described).toBe('');
  });

  it('speaks up only when uniqueness was refuted, which means two values disagree', () => {
    const base = ledgered({ at: T0, subject: 'user', predicate: 'city' });
    const conflicted: KnowledgeFact = {
      ...base,
      assumptions: (base.assumptions ?? []).map((assumption) =>
        assumption.kind === 'uniqueness'
          ? { ...assumption, status: 'refuted' as const }
          : assumption,
      ),
    };
    expect(describeAssumptions(conflicted)).toBe('slot has conflicting values');
  });
});

/**
 * The controlled set, and the arms that read it.
 *
 * The suite checks two different things and keeps them apart:
 *
 * - **the fixture is well formed** — every case names a slot its facts actually occupy, and every expected
 *   answer is one of those facts or an explicit "unknown";
 * - **each arm behaves as specified** — including the degenerate paths (`none-in-window`, `all-retired`,
 *   `unplaceable`), because those are the paths a real corpus reaches far more often than the happy one.
 *
 * A test that only checked the happy path would pass on an arm that returns the first fact it is handed.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveAssumptions,
  reviseLedger,
  slotKey,
  type KnowledgeFact,
  type KnowledgeFrame,
} from '@agentix-e/cortex-core';
import {
  ablate,
  buildCases,
  resolve,
  scoreArm,
  TARGETS,
  type Ablation,
  type Arm,
  type Case,
} from '../assumption-ablation.js';

const FULL: Ablation = { persistence: true, uniqueness: true, timeAnchor: true, cascade: true };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function frameOf(id: string, at: number | undefined, text: string): KnowledgeFrame {
  return at === undefined ? { id, text, speaker: 'user' } : { id, text, speaker: 'user', at };
}

function factOf(
  id: string,
  frameId: string,
  text: string,
  spec: {
    at?: number;
    subject?: string;
    predicate?: string;
    references?: { token: string; sourceId: string }[];
  },
  frameAt: number | undefined = T0,
): KnowledgeFact {
  const base: KnowledgeFact = {
    id,
    frameId,
    text,
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: text.length },
    references: spec.references ?? [],
    ...(spec.subject === undefined ? {} : { subject: spec.subject }),
    ...(spec.predicate === undefined ? {} : { predicate: spec.predicate }),
    ...(spec.at === undefined ? {} : { at: spec.at }),
  };
  return { ...base, assumptions: deriveAssumptions(base, frameOf(frameId, frameAt, text)) };
}

describe('buildCases: the fixture is well formed', () => {
  const cases = buildCases(true);

  it('covers every family, so no mechanism is unmeasured', () => {
    const families = new Set(cases.map((entry) => entry.family));
    expect([...families].sort()).toEqual([
      'cascade',
      'conflict',
      'false-stale',
      'historical',
      'type-i',
      'type-ii',
    ]);
  });

  it('puts every fact on the slot the case names', () => {
    for (const entry of cases) {
      const key = slotKey(entry.slot.subject, entry.slot.predicate);
      const onSlot = entry.facts.filter(
        (item) =>
          item.subject !== undefined &&
          item.predicate !== undefined &&
          slotKey(item.subject, item.predicate) === key,
      );
      // `type-ii` and `cascade` carry the upstream fact that does the invalidating, which is deliberately
      // on another slot. Every other family is single-slot.
      const expected =
        entry.family === 'type-ii' || entry.family === 'cascade'
          ? entry.facts.length - 1
          : entry.facts.length;
      expect(onSlot.length, entry.id).toBeGreaterThanOrEqual(1);
      expect(onSlot.length, entry.id).toBeLessThanOrEqual(expected);
    }
  });

  it('names an expected answer that exists, or an explicit unknown', () => {
    for (const entry of cases) {
      if (entry.expect === null) continue;
      expect(
        entry.facts.some((item) => item.id === entry.expect),
        entry.id,
      ).toBe(true);
    }
  });

  it('is deterministic: two builds are equal', () => {
    expect(buildCases(true)).toEqual(buildCases(true));
  });
});

describe('resolve: the flat arm is the published baseline, retired facts and all', () => {
  const city: Case = {
    id: 'x',
    family: 'type-i',
    query: 'Where does the user live?',
    slot: { subject: 'user', predicate: 'city' },
    facts: [
      factOf('a', 'f1', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' }),
      factOf('b', 'f2', 'I live in Berlin.', { at: T0 + DAY, subject: 'user', predicate: 'city' }),
    ],
    expect: 'b',
  };
  const revised: Case = { ...city, facts: reviseLedger(city.facts).facts };

  it('answers with the older fact when the two are equally relevant, and counts that it served a retired one', () => {
    const resolution = resolve(revised, 'flat');
    expect(resolution.answer).toBe('a');
    expect(resolution.servedRetired).toBe(1);
  });

  it('behaves identically under the annotated arm, which is the point of having it', () => {
    expect(resolve(revised, 'annotated')).toEqual(resolve(revised, 'flat'));
  });

  it('reports unplaceable when the slot has no facts, rather than reaching for another slot', () => {
    const empty: Case = { ...city, facts: [] };
    expect(resolve(empty, 'flat')).toEqual({
      answer: null,
      reason: 'unplaceable',
      servedRetired: 0,
    });
  });
});

describe('resolve: the gated arm retires, windows and refuses', () => {
  const facts = [
    factOf('a', 'f1', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' }),
    factOf('b', 'f2', 'I live in Berlin.', {
      at: T0 + 90 * DAY,
      subject: 'user',
      predicate: 'city',
    }),
  ];
  const revised = reviseLedger(facts).facts;
  const base: Case = {
    id: 'x',
    family: 'type-i',
    query: 'Where does the user live?',
    slot: { subject: 'user', predicate: 'city' },
    facts: revised,
    expect: 'b',
  };

  it('answers with the fact that is still current', () => {
    expect(resolve(base, 'gated')).toEqual({ answer: 'b', reason: 'latest', servedRetired: 0 });
  });

  it('answers a dated question from the window, and does not treat retirement as falsehood', () => {
    const dated: Case = { ...base, family: 'historical', asOf: T0 + 5 * DAY, expect: 'a' };
    expect(resolve(dated, 'gated')).toEqual({ answer: 'a', reason: 'windowed', servedRetired: 0 });
  });

  it('refuses when two equally relevant values claim one instant', () => {
    const conflict: Case = {
      ...base,
      family: 'conflict',
      facts: reviseLedger([
        factOf('a', 'f1', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' }),
        factOf('b', 'f2', 'I live in Paris.', { at: T0, subject: 'user', predicate: 'city' }),
      ]).facts,
      expect: null,
    };
    expect(resolve(conflict, 'gated')).toMatchObject({ answer: null, reason: 'conflict' });
  });

  it('answers the conflict case under flat with one of the two, which is the whole difference', () => {
    const conflict: Case = {
      ...base,
      family: 'conflict',
      facts: reviseLedger([
        factOf('a', 'f1', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' }),
        factOf('b', 'f2', 'I live in Paris.', { at: T0, subject: 'user', predicate: 'city' }),
      ]).facts,
      expect: null,
    };
    expect(resolve(conflict, 'flat').answer).not.toBeNull();
  });

  it('reads as all-retired when every candidate has been retired', () => {
    // A supersession chain can never retire both ends, so this state is built directly. It is reachable in
    // production — an import that marks every fact on a slot as no longer current — and the arm must not
    // fall back to serving a retired fact when it is.
    const refute = (item: KnowledgeFact): KnowledgeFact => ({
      ...item,
      assumptions: (item.assumptions ?? []).map((assumption) =>
        assumption.kind === 'persistence'
          ? { ...assumption, status: 'refuted' as const }
          : assumption,
      ),
    });
    const allGone: Case = { ...base, facts: revised.map(refute) };
    const resolution = resolve(allGone, 'gated');
    expect(resolution.answer).toBeNull();
    expect(resolution.reason).toBe('all-retired');
    expect(resolution.servedRetired).toBe(2);
  });

  it('reads as none-in-window when the question predates every fact', () => {
    const early: Case = { ...base, family: 'historical', asOf: T0 - 30 * DAY, expect: null };
    // Facts with no `at` are kept in the window by design; these two have one, so both are excluded.
    expect(resolve(early, 'gated')).toMatchObject({ answer: null, reason: 'none-in-window' });
  });

  it('keeps an undated fact out of a dated answer when anchors are switched off', () => {
    const undated = factOf(
      'u',
      'f9',
      'I live in Lisbon.',
      { subject: 'user', predicate: 'city' },
      undefined,
    );
    const entry: Case = {
      ...base,
      facts: [...base.facts, undated],
      asOf: T0 + 5 * DAY,
    };
    // Without an anchor the fact cannot be placed, so it stays but does not win against one that can.
    expect(resolve(entry, 'gated', { ...FULL, timeAnchor: false }).answer).toBe('a');
  });
});

describe('resolve: declared invalidation and the cascade', () => {
  const commute = factOf('c', 'f1', 'I take the northern line.', {
    at: T0,
    subject: 'user',
    predicate: 'commute',
  });
  const remote = factOf('r', 'f2', 'I work fully remote.', {
    at: T0 + 90 * DAY,
    subject: 'user',
    predicate: 'workplace',
  });
  const base: Case = {
    id: 'ii',
    family: 'type-ii',
    query: 'How does the user get to the office?',
    slot: { subject: 'user', predicate: 'commute' },
    facts: reviseLedger([commute, remote]).facts,
    expect: null,
    invalidates: [['r', 'c']],
  };

  it('removes the invalidated fact, so the answer is unknown rather than the old value', () => {
    expect(resolve(base, 'gated').answer).toBeNull();
  });

  it('ignores a declaration that points backwards in time, because only a later fact can invalidate', () => {
    const backwards: Case = { ...base, invalidates: [['c', 'r']] };
    expect(resolve(backwards, 'gated').answer).toBe('c');
  });

  it('ignores a declaration naming a fact that is not in the case', () => {
    const ghost: Case = { ...base, invalidates: [['nope', 'c']] };
    expect(resolve(ghost, 'gated').answer).toBe('c');
  });

  const rent = factOf('r1', 'g1', 'The flat costs 900 a month.', {
    at: T0,
    subject: 'flat',
    predicate: 'rent',
  });
  const deposit = factOf('d1', 'g2', 'The deposit is two months of rent.', {
    at: T0,
    subject: 'flat',
    predicate: 'deposit',
    references: [{ token: 'flat', sourceId: 'g1' }],
  });
  const left = factOf('e1', 'g3', 'I moved out.', {
    at: T0 + 90 * DAY,
    subject: 'flat',
    predicate: 'occupancy',
  });
  const chain = reviseLedger([rent, deposit, left], { cascade: true }).facts;
  const cascadeCase: Case = {
    id: 'g',
    family: 'cascade',
    query: 'How much is the deposit on the flat?',
    slot: { subject: 'flat', predicate: 'deposit' },
    facts: chain,
    expect: null,
    invalidates: [['e1', 'r1']],
  };

  it('propagates through a borrowed word when the cascade is on', () => {
    expect(resolve(cascadeCase, 'gated').answer).toBeNull();
  });

  it('stops at the invalidated fact when the cascade is off', () => {
    expect(resolve(cascadeCase, 'gated', { ...FULL, cascade: false }).answer).toBe('d1');
  });
});

describe('scoreArm: counting, per family', () => {
  const cases = buildCases(true);
  const report = scoreArm(cases, 'gated');

  it('counts every outcome and buckets them by family', () => {
    expect(report.n).toBe(cases.length);
    expect(report.correct).toBe(report.outcomes.filter((outcome) => outcome.correct).length);
    const bucketed = Object.values(report.byFamily).reduce((total, bucket) => total + bucket.n, 0);
    expect(bucketed).toBe(cases.length);
  });

  it('serves no retired fact under the gated arm', () => {
    expect(report.retiredServed).toBe(0);
  });

  it('serves retired facts under the flat arm, which is what the mechanism prevents', () => {
    expect(scoreArm(cases, 'flat').retiredServed).toBeGreaterThan(0);
  });

  it('scores an empty set as zero rather than NaN', () => {
    expect(scoreArm([], 'gated')).toMatchObject({ n: 0, correct: 0, accuracy: 0 });
  });
});

describe('ablate: one mechanism at a time', () => {
  const rows = ablate();

  it('reports the full arm first and every mechanism after it', () => {
    expect(rows.map((row) => row.removed)).toEqual([
      'none',
      'persistence',
      'uniqueness',
      'time-anchor',
      'cascade',
    ]);
  });

  it('names the families each mechanism is supposed to serve', () => {
    expect(TARGETS.persistence).toEqual(['type-i', 'type-ii']);
    expect(TARGETS.uniqueness).toEqual(['conflict']);
    expect(TARGETS.cascade).toEqual(['cascade']);
    expect(TARGETS.none).toEqual([]);
  });

  it('moves accuracy only in the families the removed mechanism serves', () => {
    const full = rows[0]!;
    const withoutPersistence = rows.find((row) => row.removed === 'persistence')!;
    expect(withoutPersistence.byFamily['type-i'].correct).toBeLessThan(
      full.byFamily['type-i'].correct,
    );
    expect(withoutPersistence.byFamily.conflict.correct).toBe(full.byFamily.conflict.correct);

    const withoutUniqueness = rows.find((row) => row.removed === 'uniqueness')!;
    expect(withoutUniqueness.byFamily.conflict.correct).toBeLessThan(
      full.byFamily.conflict.correct,
    );
    expect(withoutUniqueness.byFamily['type-i'].correct).toBe(full.byFamily['type-i'].correct);
  });

  it('shows the cascade paying on exactly one family', () => {
    const full = rows[0]!;
    const withoutCascade = rows.find((row) => row.removed === 'cascade')!;
    expect(withoutCascade.byFamily.cascade.correct).toBeLessThan(full.byFamily.cascade.correct);
    expect(withoutCascade.byFamily['type-i'].correct).toBe(full.byFamily['type-i'].correct);
  });

  it('records the time anchor as inert on this set, which the pre-registration predicted', () => {
    const full = rows[0]!;
    const withoutAnchor = rows.find((row) => row.removed === 'time-anchor')!;
    expect(withoutAnchor.accuracy).toBe(full.accuracy);
  });

  it('is deterministic: two runs produce the same table', () => {
    expect(ablate()).toEqual(ablate());
  });

  it('accepts each arm name without throwing', () => {
    const cases = buildCases(true);
    for (const arm of ['flat', 'annotated', 'gated'] as Arm[]) {
      expect(scoreArm(cases, arm).n).toBe(cases.length);
    }
  });
});

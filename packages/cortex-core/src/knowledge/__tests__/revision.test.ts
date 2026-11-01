/**
 * Revision: what a later fact does to an earlier assumption.
 *
 * Every case here is a shape the published work names — an update that must retire a belief (Zep's edge
 * invalidation), a propagated conflict where the changed attribute is never mentioned (STALE Type II), and
 * a contradiction at one instant, which is *not* an update and must not be resolved by picking the last
 * one written.
 */

import { describe, expect, it } from 'vitest';
import { assumptionOf, deriveAssumptions } from '../assumption.js';
import type { KnowledgeFact, KnowledgeFrame } from '../frame.js';
import { reviseLedger } from '../revision.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function frameOf(id: string, at: number, text = 'x'): KnowledgeFrame {
  return { id, text, speaker: 'user', at };
}

function factOf(
  overrides: Partial<KnowledgeFact> & Pick<KnowledgeFact, 'id' | 'frameId'>,
): KnowledgeFact {
  const frame = frameOf(overrides.frameId, T0);
  const base: KnowledgeFact = {
    text: 'placeholder',
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: 1 },
    references: [],
    ...overrides,
  };
  return { ...base, assumptions: deriveAssumptions(base, frame) };
}

const LONDON = factOf({
  id: 'k1',
  frameId: 'f1',
  text: 'I live in London.',
  subject: 'user',
  predicate: 'city',
  at: T0,
});

const BERLIN = factOf({
  id: 'k2',
  frameId: 'f2',
  text: 'I live in Berlin.',
  subject: 'user',
  predicate: 'city',
  at: T0 + 90 * DAY,
});

describe('reviseLedger: an update retires a persistence, it does not delete a fact', () => {
  const result = reviseLedger([LONDON, BERLIN]);
  const byId = new Map(result.facts.map((fact) => [fact.id, fact]));

  it('refutes the earlier persistence and records what did it', () => {
    const older = byId.get('k1')!;
    const persistence = assumptionOf(older, 'persistence')!;
    expect(persistence.status).toBe('refuted');
    expect(persistence.contradict).toBe(1);

    const revision = result.revisions.find((entry) => entry.factId === 'k1');
    expect(revision).toMatchObject({ kind: 'persistence', verdict: 'refuted', byFactId: 'k2' });
  });

  it('confirms the newer persistence and its single-valued slot', () => {
    const newer = byId.get('k2')!;
    expect(newer.assumptions?.find((assumption) => assumption.kind === 'persistence')?.status).toBe(
      'confirmed',
    );
    expect(newer.assumptions?.find((assumption) => assumption.kind === 'uniqueness')?.status).toBe(
      'confirmed',
    );
  });

  it('keeps the retired fact in the ledger, because a historical question still needs it', () => {
    expect(byId.has('k1')).toBe(true);
    expect(byId.get('k1')!.text).toBe('I live in London.');
  });

  it('leaves an untouched fact alone', () => {
    const other = factOf({ id: 'k3', frameId: 'f3', text: 'I like tea.', at: T0 });
    const solo = reviseLedger([other]);
    expect(solo.revisions).toEqual([]);
    expect(solo.facts[0]).toEqual(other);
  });
});

describe('reviseLedger: agreement is evidence, and costs nothing', () => {
  it('confirms both persistences when a second fact says the same thing', () => {
    const repeat = factOf({
      id: 'k1b',
      frameId: 'f2',
      text: 'I live in London.',
      subject: 'user',
      predicate: 'city',
      at: T0 + 10 * DAY,
    });
    const result = reviseLedger([LONDON, repeat]);
    for (const fact of result.facts) {
      const persistence = assumptionOf(fact, 'persistence')!;
      expect(persistence.status).toBe('confirmed');
      expect(persistence.support).toBe(1);
    }
    expect(result.revisions.filter((entry) => entry.verdict === 'refuted')).toEqual([]);
  });
});

describe('reviseLedger: two values at one instant is a contradiction, not an update', () => {
  it('refutes uniqueness on both, because neither has a claim to be current', () => {
    const twin = factOf({
      id: 'k1c',
      frameId: 'f2',
      text: 'I live in Paris.',
      subject: 'user',
      predicate: 'city',
      at: T0,
    });
    const result = reviseLedger([LONDON, twin]);
    for (const fact of result.facts) {
      const uniqueness = assumptionOf(fact, 'uniqueness')!;
      expect(uniqueness.status).toBe('refuted');
    }
  });

  it('does not refute persistence in that case, because neither fact was replaced', () => {
    const twin = factOf({
      id: 'k1c',
      frameId: 'f2',
      text: 'I live in Paris.',
      subject: 'user',
      predicate: 'city',
      at: T0,
    });
    const result = reviseLedger([LONDON, twin]);
    for (const fact of result.facts) {
      expect(
        fact.assumptions?.find((assumption) => assumption.kind === 'persistence')?.status,
      ).not.toBe('refuted');
    }
  });
});

describe('reviseLedger: a time anchor gives way to an explicit time', () => {
  it('refutes the anchor once a later fact dates the same slot', () => {
    const undated = factOf({
      id: 'k1',
      frameId: 'f1',
      text: 'I live in London.',
      subject: 'user',
      predicate: 'city',
    });
    expect(undated.assumptions?.some((assumption) => assumption.kind === 'time-anchor')).toBe(true);

    const result = reviseLedger([undated, BERLIN]);
    const anchored = result.facts.find((fact) => fact.id === 'k1')!;
    expect(
      anchored.assumptions?.find((assumption) => assumption.kind === 'time-anchor')?.status,
    ).toBe('refuted');
  });
});

describe('reviseLedger: the cascade is a switch, and its off state is the default', () => {
  const dependent = factOf({
    id: 'd1',
    frameId: 'f3',
    text: 'The flat costs 900 a month.',
    references: [{ token: 'London', sourceId: 'f1' }],
    at: T0 + 5 * DAY,
  });
  const grandchild = factOf({
    id: 'd2',
    frameId: 'f4',
    text: 'The deposit is two months of rent.',
    references: [{ token: 'flat', sourceId: 'f3' }],
    at: T0 + 6 * DAY,
  });

  it('marks nothing stale when it is off', () => {
    const result = reviseLedger([LONDON, BERLIN, dependent, grandchild]);
    expect(result.stale).toEqual([]);
    expect(result.facts.every((fact) => fact.stale === undefined)).toBe(true);
  });

  it('propagates through a chain of borrowed words when it is on', () => {
    const result = reviseLedger([LONDON, BERLIN, dependent, grandchild], { cascade: true });
    // d1 borrowed from f1, whose fact was refuted. d1 is stale; f3 is now a refuted frame, so d2 follows.
    expect(result.stale).toEqual(['d1', 'd2']);
    expect(result.facts.find((fact) => fact.id === 'd1')!.stale).toBe(true);
    expect(result.facts.find((fact) => fact.id === 'd2')!.stale).toBe(true);
  });

  it('does not mark a fact whose source frame was never refuted', () => {
    const unrelated = factOf({
      id: 'd3',
      frameId: 'f5',
      text: 'The flat is near the station.',
      references: [{ token: 'flat', sourceId: 'f9' }],
      at: T0 + 7 * DAY,
    });
    const result = reviseLedger([LONDON, BERLIN, unrelated], { cascade: true });
    expect(result.stale).toEqual([]);
  });
});

describe('reviseLedger: determinism and the input order', () => {
  it('gives the same revisions in the same order whatever order the facts arrive in', () => {
    const forward = reviseLedger([LONDON, BERLIN]);
    const backward = reviseLedger([BERLIN, LONDON]);
    expect(
      forward.revisions.map((entry) => `${entry.factId}:${entry.kind}:${entry.verdict}`),
    ).toEqual(backward.revisions.map((entry) => `${entry.factId}:${entry.kind}:${entry.verdict}`));
  });

  it('accepts an edge list instead of deriving one, so a caller can hold the edges already', () => {
    const manual = reviseLedger([LONDON, BERLIN], {
      edges: [
        {
          id: 'supersedes:k2>k1',
          from: 'k2',
          to: 'k1',
          type: 'supersedes',
          origin: 'derived',
        },
      ],
    });
    expect(
      manual.facts
        .find((fact) => fact.id === 'k1')!
        .assumptions?.find((assumption) => assumption.kind === 'persistence')?.status,
    ).toBe('refuted');
  });

  it('ignores a non-supersedes edge rather than reading it as a replacement', () => {
    const manual = reviseLedger([LONDON, BERLIN], {
      edges: [
        {
          id: 'causes:k1>k2',
          from: 'k2',
          to: 'k1',
          type: 'causes',
          origin: 'extracted',
          marker: 'so',
          evidenceSpan: { start: 0, end: 1 },
        },
      ],
    });
    expect(manual.revisions).toEqual([]);
  });
});

describe('reviseLedger: a declared invalidation is bookkeeping, not inference', () => {
  // STALE's Type II: the upstream attribute changed and the downstream fact was never mentioned
  // again, so there is no same-slot disagreement for the derived pass to notice. These facts are
  // deliberately on different predicates, which means `deriveSupersedes` produces no edge at all --
  // every refutation below is one a caller declared, and the test would pass vacuously if it were
  // reading an edge instead.
  const RENT = factOf({
    id: 'r1',
    frameId: 'f1',
    text: 'The flat costs 900 a month.',
    subject: 'flat',
    predicate: 'rent',
    at: T0,
  });
  const CITY = factOf({
    id: 'c1',
    frameId: 'f2',
    text: 'I live in Berlin.',
    subject: 'user',
    predicate: 'city',
    at: T0 + 90 * DAY,
  });

  it('refutes the named fact and records which fact did it', () => {
    const result = reviseLedger([RENT, CITY], { invalidations: [['c1', 'r1']] });
    const retired = result.facts.find((fact) => fact.id === 'r1')!;
    expect(assumptionOf(retired, 'persistence')!.status).toBe('refuted');
    expect(assumptionOf(retired, 'persistence')!.contradict).toBe(1);

    const revision = result.revisions.find((entry) => entry.factId === 'r1')!;
    expect(revision).toMatchObject({ kind: 'persistence', verdict: 'refuted', byFactId: 'c1' });
    expect(revision.detail).toContain('declared meaningless by');
  });

  it('refutes the slot claim too, because the slot no longer holds what it described', () => {
    const result = reviseLedger([RENT, CITY], { invalidations: [['c1', 'r1']] });
    const retired = result.facts.find((fact) => fact.id === 'r1')!;
    expect(assumptionOf(retired, 'uniqueness')!.status).toBe('refuted');
    expect(result.revisions.filter((entry) => entry.factId === 'r1').map((e) => e.kind)).toEqual([
      'persistence',
      'uniqueness',
    ]);
  });

  it('leaves the declaring fact untouched, because invalidating is not being invalidated', () => {
    const result = reviseLedger([RENT, CITY], { invalidations: [['c1', 'r1']] });
    const declarer = result.facts.find((fact) => fact.id === 'c1')!;
    expect(assumptionOf(declarer, 'persistence')!.status).not.toBe('refuted');
    expect(result.revisions.every((entry) => entry.byFactId === 'c1')).toBe(true);
  });

  it('ignores a declaration that points backwards in time', () => {
    // Only a later fact can make an earlier one meaningless. Honouring the reverse would let a
    // fixture or an import decide the answer by asserting the impossible, so the pair is skipped
    // rather than applied with a warning.
    const result = reviseLedger([RENT, CITY], { invalidations: [['r1', 'c1']] });
    expect(result.revisions).toEqual([]);
    expect(
      assumptionOf(
        result.facts.find((f) => f.id === 'c1')!,
        'persistence',
      )!.status,
    ).not.toBe('refuted');
  });

  it('ignores a declaration between two facts at the same instant', () => {
    // `newerAt <= olderAt` is skipped, so an equal pair is a contradiction rather than an update --
    // the same rule the derived pass applies to two values at one instant.
    const sameInstant = factOf({
      id: 'c2',
      frameId: 'f3',
      text: 'I live in Paris.',
      subject: 'user',
      predicate: 'city',
      at: T0,
    });
    const result = reviseLedger([RENT, sameInstant], { invalidations: [['c2', 'r1']] });
    expect(result.revisions).toEqual([]);
  });

  it('skips a pair naming an id that is not in the ledger', () => {
    // A declaration is a caller's claim about ids, and a claim about an id that is not there is
    // dropped: the alternative is a non-null assertion over a map miss.
    const result = reviseLedger([RENT, CITY], {
      invalidations: [
        ['missing', 'r1'],
        ['c1', 'also-missing'],
      ],
    });
    expect(result.revisions).toEqual([]);
  });

  it('survives an agreement reached elsewhere in the same batch', () => {
    // The ordering is the point of the comment at the loop: the agreement pass runs after the
    // declared refutations, so two unrelated facts agreeing with each other cannot resurrect a fact
    // whose retirement was declared. The pair below is deliberately on a slot of its own -- a repeat
    // ON r1's slot is a real agreement and would legitimately confirm it, which is a different case
    // and not what this loop's ordering is for.
    const liking = factOf({
      id: 't1',
      frameId: 'f4',
      text: 'I like tea.',
      subject: 'user',
      predicate: 'drink',
      at: T0,
    });
    const likingAgain = factOf({
      id: 't2',
      frameId: 'f5',
      text: 'I like tea.',
      subject: 'user',
      predicate: 'drink',
      at: T0 + 120 * DAY,
    });
    const result = reviseLedger([RENT, CITY, liking, likingAgain], {
      invalidations: [['c1', 'r1']],
    });
    expect(
      assumptionOf(
        result.facts.find((f) => f.id === 'r1')!,
        'persistence',
      )!.status,
    ).toBe('refuted');
    expect(
      result.facts
        .filter((fact) => fact.id.startsWith('t'))
        .every((fact) => assumptionOf(fact, 'persistence')!.status === 'confirmed'),
    ).toBe(true);
  });
});

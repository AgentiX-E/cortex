/**
 * Settled facts, commitments and wishes — and the one transition made on absence.
 *
 * Three properties carry the design, and each has a cost when wrong:
 *
 * - a **settled event** must not be replaceable, or the system rewrites history to keep its answer tidy;
 * - a **plan** must reach `fulfilled` only on a declaration, or a topic coming up again marks work done;
 * - a plan must reach `lapsed` on **absence**, because that is the only signal there is — and `lapsed` must
 *   discount rather than delete, because absence is not evidence of failure.
 */

import { describe, expect, it } from 'vitest';
import { deriveSupersedes } from '../edge.js';
import type { KnowledgeFact } from '../frame.js';
import {
  describePlan,
  inferTemporality,
  isImmutable,
  isPlan,
  modalityOf,
  planFactor,
  reconcilePlans,
} from '../temporality.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function factOf(overrides: Partial<KnowledgeFact> & Pick<KnowledgeFact, 'id'>): KnowledgeFact {
  return {
    frameId: 'f',
    text: 'placeholder',
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: 1 },
    references: [],
    ...overrides,
  };
}

describe('inferTemporality: two axes, and the defaults are choices', () => {
  it('reads an unmarked sentence as present and factual', () => {
    expect(inferTemporality('I live in London.')).toEqual({
      futurity: 'present',
      certainty: 'factual',
    });
  });

  it('reads a past marker as past', () => {
    expect(inferTemporality('I visited Paris last year.').futurity).toBe('past');
    expect(inferTemporality('I moved here two years ago.').futurity).toBe('past');
  });

  it('reads an intention as future', () => {
    expect(inferTemporality('I will visit Paris next month.').futurity).toBe('future');
    expect(inferTemporality('I am planning to move.').futurity).toBe('future');
  });

  it('separates a commitment from a wish, which is the whole point of the second axis', () => {
    expect(inferTemporality('I will visit Paris next month.').certainty).toBe('factual');
    expect(inferTemporality('I might visit Paris next month.').certainty).toBe('possible');
    expect(inferTemporality('I will probably visit Paris.').certainty).toBe('probable');
  });

  it('lets future win when a sentence carries both, because the later clause is the plan', () => {
    expect(inferTemporality('I had planned to stay, but I will leave tomorrow.').futurity).toBe(
      'future',
    );
  });

  it('is case- and punctuation-insensitive', () => {
    expect(inferTemporality('WILL I? No.').futurity).toBe('future');
    expect(inferTemporality('I MIGHT go.').certainty).toBe('possible');
  });

  it('projects onto the coarse field without drifting from the axes', () => {
    expect(modalityOf('past', 'factual')).toBe('actual');
    expect(modalityOf('future', 'factual')).toBe('planned');
    expect(modalityOf('future', 'possible')).toBe('hypothetical');
    expect(modalityOf('past', 'possible')).toBe('hypothetical');
  });
});

describe('isImmutable: a settled event cannot be replaced', () => {
  it('protects a past event', () => {
    expect(
      isImmutable(factOf({ id: 'a', type: 'event', text: 'I visited Paris last year.' })),
    ).toBe(true);
  });

  it('does not protect a past state, because a state is exactly what "current" means', () => {
    expect(
      isImmutable(factOf({ id: 'a', type: 'state', text: 'I lived in London last year.' })),
    ).toBe(false);
  });

  it('does not protect a future event', () => {
    expect(isImmutable(factOf({ id: 'a', type: 'event', text: 'I will visit Paris.' }))).toBe(
      false,
    );
  });

  it('infers the axis when the caller left it unset, rather than losing the protection', () => {
    expect(
      isImmutable(factOf({ id: 'a', type: 'event', text: 'We shipped the release yesterday.' })),
    ).toBe(true);
  });
});

describe('deriveSupersedes: history is not rewritten', () => {
  const trip = factOf({
    id: 'e1',
    type: 'event',
    text: 'I visited Paris last year.',
    subject: 'user',
    predicate: 'trip',
    at: T0,
    futurity: 'past',
  });
  const later = factOf({
    id: 'e2',
    type: 'event',
    text: 'I visited Rome this spring.',
    subject: 'user',
    predicate: 'trip',
    at: T0 + 90 * DAY,
    futurity: 'past',
  });

  it('builds no edge between two settled events on one slot', () => {
    expect(deriveSupersedes([trip, later])).toEqual([]);
  });

  it('still supersedes a state, which is the case the edge exists for', () => {
    const old = factOf({
      id: 's1',
      text: 'I live in London.',
      subject: 'user',
      predicate: 'city',
      at: T0,
    });
    const next = factOf({
      id: 's2',
      text: 'I live in Berlin.',
      subject: 'user',
      predicate: 'city',
      at: T0 + DAY,
    });
    expect(deriveSupersedes([old, next])).toHaveLength(1);
  });
});

describe('isPlan', () => {
  it('recognises a plan from either axis', () => {
    expect(isPlan(factOf({ id: 'a', modality: 'planned' }))).toBe(true);
    expect(isPlan(factOf({ id: 'b', futurity: 'future' }))).toBe(true);
    expect(isPlan(factOf({ id: 'c', modality: 'actual', futurity: 'present' }))).toBe(false);
  });
});

describe('reconcilePlans: three transitions on evidence, one on absence', () => {
  const plan = factOf({
    id: 'p1',
    modality: 'planned',
    futurity: 'future',
    text: 'I will visit Paris next month.',
    at: T0 + 30 * DAY,
  });

  it('fulfils only on a declaration', () => {
    const result = reconcilePlans([plan], T0 + 60 * DAY, { fulfils: [['p1', 'e9']] });
    expect(result.facts[0]!.planState).toBe('fulfilled');
    expect(result.transitions[0]).toMatchObject({ to: 'fulfilled', reason: 'declared-fulfilled' });
  });

  it('abandons only on a declaration', () => {
    const result = reconcilePlans([plan], T0 + 5 * DAY, { abandons: [['p1', 'e9']] });
    expect(result.facts[0]!.planState).toBe('abandoned');
  });

  it('lapses on absence once the date has passed', () => {
    const result = reconcilePlans([plan], T0 + 60 * DAY);
    expect(result.facts[0]!.planState).toBe('lapsed');
    expect(result.transitions[0]).toMatchObject({ to: 'lapsed', reason: 'due-and-unmet' });
  });

  it('leaves a plan pending while it is not yet due', () => {
    const result = reconcilePlans([plan], T0 + DAY);
    expect(result.facts[0]!.planState).toBeUndefined();
    expect(result.transitions[0]).toMatchObject({ to: 'pending', reason: 'not-yet-due' });
  });

  it('never lapses an undated plan, because there is nothing to be late for', () => {
    const undated = factOf({
      id: 'p2',
      modality: 'planned',
      text: 'I want to visit Paris someday.',
    });
    const result = reconcilePlans([undated], T0 + 1000 * DAY);
    expect(result.facts[0]!.planState).toBeUndefined();
  });

  it('leaves a non-plan untouched and says nothing about it', () => {
    const settled = factOf({ id: 's1', text: 'I live in London.' });
    const result = reconcilePlans([settled], T0);
    expect(result.facts[0]).toEqual(settled);
    expect(result.transitions).toEqual([]);
  });

  it('does not re-transition a plan that already left pending', () => {
    const done = factOf({ id: 'p3', modality: 'planned', planState: 'fulfilled', at: T0 });
    const result = reconcilePlans([done], T0 + 100 * DAY);
    expect(result.facts[0]!.planState).toBe('fulfilled');
    expect(result.transitions).toEqual([]);
  });

  it('is deterministic', () => {
    expect(reconcilePlans([plan], T0 + 60 * DAY)).toEqual(reconcilePlans([plan], T0 + 60 * DAY));
  });
});

describe('planFactor: discount on absence, delete only on a decision', () => {
  const base = { id: 'p', modality: 'planned' as const, text: 'I will go.' };

  it('answers normally for a plan that was fulfilled', () => {
    expect(planFactor(factOf({ ...base, planState: 'fulfilled' }))).toBe(1);
  });

  it('discounts a lapsed plan without deleting it, because absence is not failure', () => {
    expect(planFactor(factOf({ ...base, planState: 'lapsed' }))).toBe(0.4);
  });

  it('drops an abandoned plan, because somebody said so', () => {
    expect(planFactor(factOf({ ...base, planState: 'abandoned' }))).toBe(0);
  });

  it('keeps a pending plan in play but behind a settled fact', () => {
    expect(planFactor(factOf({ ...base, planState: 'pending' }))).toBe(0.8);
  });

  it('leaves a non-plan at one', () => {
    expect(planFactor(factOf({ id: 's', text: 'I live here.' }))).toBe(1);
  });
});

describe('describePlan: only what a reader would otherwise get wrong', () => {
  it('says nothing about a fulfilled plan, which is now just a fact', () => {
    expect(describePlan(factOf({ id: 'p', modality: 'planned', planState: 'fulfilled' }))).toBe('');
  });

  it('says nothing about a settled fact', () => {
    expect(describePlan(factOf({ id: 's', text: 'I live here.', futurity: 'present' }))).toBe('');
  });

  it('names the state, the certainty and the date', () => {
    const line = describePlan(
      factOf({
        id: 'p',
        modality: 'planned',
        futurity: 'future',
        planState: 'lapsed',
        at: T0,
        certainty: 'factual',
      }),
    );
    expect(line).toBe('a plan, lapsed (due 2026-01-01)');
  });

  it('calls a possibility a possibility', () => {
    const line = describePlan(
      factOf({
        id: 'p',
        modality: 'hypothetical',
        futurity: 'future',
        certainty: 'possible',
        at: T0,
      }),
    );
    expect(line).toContain('a possibility');
  });

  it('admits when a plan has no date', () => {
    expect(describePlan(factOf({ id: 'p', modality: 'planned' }))).toContain('no date');
  });
});

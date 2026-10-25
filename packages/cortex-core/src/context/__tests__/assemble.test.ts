/**
 * The reader's context, and the four questions it asks.
 *
 * Each `describe` below corresponds to one question, because the failure modes are not interchangeable: a
 * window that discounts instead of excluding lets a later fact outrank a correct earlier one; a pool that
 * does not separate commitment from fact answers "did they go" with a plan; a budget that measures one form
 * and ships another is off by the lines it added last.
 *
 * Two tests are here because the implementation was wrong before they were written:
 *
 * - a historical question must not zero a retired fact's score, or the answer falls back to an id tie-break;
 * - `servedNotCurrent` must be counted even when the ledger is switched off, or the ablation that switches it
 *   off has nothing to report.
 */

import { describe, expect, it } from 'vitest';
import { assemble, effectiveAt, type AssembleInput, type AssemblePolicy } from '../assemble.js';
import { deriveAssumptions } from '../../knowledge/assumption.js';
import type { KnowledgeFact, KnowledgeFrame } from '../../knowledge/frame.js';
import { isPlan, planFactor } from '../../knowledge/temporality.js';
import type { KnowledgeUnit } from '../../knowledge/unit.js';
import type { KnowledgeEdge } from '../../knowledge/edge.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const FRAME: KnowledgeFrame = {
  id: 'frame-1',
  text: 'I live in London.',
  speaker: 'user',
  at: T0,
};

/** A fact with no stated time — absent, not `undefined`, which `exactOptionalPropertyTypes` distinguishes. */
function withoutAt(fact: KnowledgeFact): KnowledgeFact {
  const copy: Record<string, unknown> = { ...fact };
  delete copy['at'];
  return copy as unknown as KnowledgeFact;
}

type Spec = {
  readonly at?: number;
  readonly subject?: string;
  readonly predicate?: string;
  readonly type?: KnowledgeFact['type'];
  readonly modality?: KnowledgeFact['modality'];
  readonly futurity?: KnowledgeFact['futurity'];
  readonly certainty?: KnowledgeFact['certainty'];
  readonly planState?: KnowledgeFact['planState'];
  readonly stale?: boolean;
  readonly count?: number;
};

function factOf(id: string, text: string, spec: Spec = {}): KnowledgeFact {
  const base: KnowledgeFact = {
    id,
    frameId: FRAME.id,
    text,
    type: spec.type ?? 'state',
    polarity: 'positive',
    modality: spec.modality ?? (spec.futurity === 'future' ? 'planned' : 'actual'),
    sourceSpan: { start: 0, end: Math.min(text.length, FRAME.text.length) },
    references: [],
    ...(spec.at === undefined ? {} : { at: spec.at }),
    ...(spec.subject === undefined ? {} : { subject: spec.subject }),
    ...(spec.predicate === undefined ? {} : { predicate: spec.predicate }),
    ...(spec.futurity === undefined ? {} : { futurity: spec.futurity }),
    ...(spec.certainty === undefined ? {} : { certainty: spec.certainty }),
    ...(spec.planState === undefined ? {} : { planState: spec.planState }),
    ...(spec.stale === undefined ? {} : { stale: spec.stale }),
    ...(spec.count === undefined ? {} : { count: spec.count }),
  };
  return { ...base, assumptions: deriveAssumptions(base, FRAME) };
}

function retired(fact: KnowledgeFact): KnowledgeFact {
  return {
    ...fact,
    assumptions: (fact.assumptions ?? []).map((assumption) =>
      assumption.kind === 'persistence'
        ? { ...assumption, status: 'refuted' as const }
        : assumption,
    ),
  };
}

function unitOf(
  facts: readonly KnowledgeFact[],
  edges: readonly KnowledgeEdge[] = [],
): KnowledgeUnit {
  return { frame: FRAME, facts, edges, unresolved: [] };
}

function flat(facts: readonly KnowledgeFact[], score = 1): { factId: string; score: number }[] {
  return facts.map((fact) => ({ factId: fact.id, score }));
}

function run(
  facts: readonly KnowledgeFact[],
  options: Partial<Omit<AssembleInput, 'unit' | 'ranked'>> & {
    readonly scores?: readonly { factId: string; score: number }[];
    readonly edges?: readonly KnowledgeEdge[];
  } = {},
) {
  const { scores, edges, ...rest } = options;
  return assemble({
    unit: unitOf(facts, edges ?? []),
    ranked: scores ?? flat(facts),
    now: T0 + 10 * DAY,
    ...rest,
  });
}

describe('effectiveAt: one clock for the window and the conflict check', () => {
  it('prefers a stated time', () => {
    expect(effectiveAt(factOf('a', 'x', { at: T0 }))).toBe(T0);
  });

  it('falls back to the anchor the fact assumed', () => {
    expect(effectiveAt(factOf('a', 'x'))).toBe(T0);
  });

  it('says nothing when the frame carried no clock either', () => {
    const bare: KnowledgeFact = {
      id: 'a',
      frameId: 'f',
      text: 'x',
      type: 'state',
      polarity: 'positive',
      modality: 'actual',
      sourceSpan: { start: 0, end: 1 },
      references: [],
      assumptions: [],
    };
    expect(effectiveAt(bare)).toBeUndefined();
  });
});

describe('question 1: was this true when the question asks', () => {
  const old = factOf('old', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' });
  const next = factOf('new', 'I live in Berlin.', {
    at: T0 + 90 * DAY,
    subject: 'user',
    predicate: 'city',
  });

  it('excludes a fact that only became true later', () => {
    const result = run([old, next], { asOf: T0 + 5 * DAY });
    expect(result.excluded).toEqual([{ factId: 'new', reason: 'after-as-of' }]);
    expect(result.served.map((entry) => entry.factId)).toEqual(['old']);
  });

  it('serves the retired fact as the answer, because it was the answer then', () => {
    const result = run([retired(old), next], { asOf: T0 + 5 * DAY });
    expect(result.served.map((entry) => entry.factId)).toEqual(['old']);
    expect(result.census.servedHistorically).toBe(1);
    expect(result.census.servedNotCurrent).toBe(0);
  });

  it('does not zero a retired fact on a historical question, which would tie it with nothing', () => {
    // The regression this pins: with the penalty applied regardless of the question, both facts scored 0 and
    // the winner was decided by id. The correct answer here is the earlier one, and it must win on merit.
    const older = retired(
      factOf('a', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' }),
    );
    const newer = factOf('b', 'I live in Berlin.', {
      at: T0 + 90 * DAY,
      subject: 'user',
      predicate: 'city',
    });
    const result = run([older, newer], {
      asOf: T0 + 5 * DAY,
      scores: [
        { factId: 'b', score: 1 },
        { factId: 'a', score: 0.9 },
      ],
    });
    // `b` is outside the window and leaves; `a` answers on its own score rather than on a zero.
    expect(result.excluded).toContainEqual({ factId: 'b', reason: 'after-as-of' });
    expect(result.served.map((entry) => entry.factId)).toEqual(['a']);
    expect(result.served[0]!.effective).toBe(0.9);
  });

  it('keeps an unplaceable fact, because "cannot be dated" is not "is later"', () => {
    const undated = factOf('u', 'I like tea.');
    const result = run([undated], { asOf: T0 });
    expect(result.served.map((entry) => entry.factId)).toEqual(['u']);
  });

  it('ignores the window when the policy turns it off', () => {
    const result = run([old, next], { asOf: T0 + 5 * DAY, policy: { window: false } });
    expect(result.excluded.some((entry) => entry.reason === 'after-as-of')).toBe(false);
  });
});

describe('question 2: what happened, or what is planned', () => {
  const settled = factOf('s', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' });
  const pending = factOf('p', 'I will move to Berlin.', {
    at: T0 + 200 * DAY,
    subject: 'user',
    predicate: 'move',
    type: 'goal',
    futurity: 'future',
  });
  const leftover = factOf('l', 'I will visit Paris.', {
    at: T0 + 30 * DAY,
    type: 'goal',
    futurity: 'future',
    planState: 'lapsed',
  });
  const dropped = factOf('d', 'I will learn piano.', {
    at: T0 + 30 * DAY,
    type: 'goal',
    futurity: 'future',
    planState: 'abandoned',
  });
  const done = factOf('f', 'I will run a marathon.', {
    at: T0 + 30 * DAY,
    type: 'event',
    futurity: 'future',
    planState: 'fulfilled',
  });

  it('refuses a lapsed plan when the question asks what happened', () => {
    const result = run([leftover]);
    expect(result.excluded).toEqual([{ factId: 'l', reason: 'unfulfilled-plan' }]);
    expect(result.served).toEqual([]);
    expect(result.lines).toEqual([]);
  });

  it('distinguishes an abandoned plan from a lapsed one in the census', () => {
    const result = run([dropped]);
    expect(result.excluded).toEqual([{ factId: 'd', reason: 'abandoned' }]);
  });

  it('keeps a fulfilled plan, because it is now a fact', () => {
    const result = run([done]);
    expect(result.served.map((entry) => entry.factId)).toEqual(['f']);
  });

  it('serves only plans when the question asks for one', () => {
    const result = run([settled, pending], { intent: 'plan' });
    expect(result.excluded).toEqual([{ factId: 's', reason: 'not-a-plan' }]);
    expect(result.served.map((entry) => entry.factId)).toEqual(['p']);
  });

  it('drops an abandoned plan even when the question asks for a plan', () => {
    // Abandoning is a declaration, and a thing declared not-going-to-happen is not a thing planned.
    const result = run([dropped, pending], { intent: 'plan' });
    expect(result.excluded).toContainEqual({ factId: 'd', reason: 'abandoned' });
    expect(result.served.map((entry) => entry.factId)).toEqual(['p']);
  });

  it('cannot tell the two pools apart once the axis is switched off, which is the ablation', () => {
    const result = run([settled, leftover], { policy: { temporality: false } });
    expect(result.served.map((entry) => entry.factId).sort()).toEqual(['l', 's']);
  });

  it('ranks a pending plan behind an equally relevant fact rather than excluding it', () => {
    const asked: KnowledgeFact = { ...pending };
    expect(planFactor(asked)).toBe(0.8);
    expect(isPlan(asked)).toBe(true);
    const result = run([settled, asked], { intent: 'plan' });
    expect(result.served[0]!.effective).toBe(0.8);
  });
});

describe('question 3: is it still current', () => {
  const live = factOf('a', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' });
  const next = factOf('b', 'I live in Berlin.', {
    at: T0 + DAY,
    subject: 'user',
    predicate: 'city',
  });
  const old = retired(
    factOf('c', 'I live in Rome.', { at: T0, subject: 'user', predicate: 'town' }),
  );

  it('excludes a refuted fact and names the reason', () => {
    const result = run([live, next, old]);
    expect(result.excluded).toContainEqual({ factId: 'c', reason: 'refuted' });
  });

  it('excludes a stale fact, whose premise was refuted', () => {
    const stale = factOf('s', 'The deposit is two months of rent.', { at: T0, stale: true });
    expect(run([stale]).excluded).toEqual([{ factId: 's', reason: 'stale' }]);
  });

  it('counts what leaked when the ledger is switched off, or the ablation has nothing to report', () => {
    const result = run([live, next, old], { policy: { ledger: false } });
    expect(result.served.map((entry) => entry.factId)).toContain('c');
    expect(result.census.servedNotCurrent).toBe(1);
  });

  it('reports the penalty it applied, so a discount is explainable', () => {
    const result = run([live]);
    expect(result.served[0]!.penalty).toEqual({ factor: 1, reason: 'answerable' });
  });
});

describe('question 4: does it fit', () => {
  const facts = Array.from({ length: 6 }, (_, index) =>
    factOf(`f${index}`, `Fact number ${index} is a reasonably long sentence about something.`, {
      at: T0 + index,
    }),
  );

  it('serves nothing when the budget cannot hold one block', () => {
    const result = run(facts, { budgetTokens: 1 });
    expect(result.served).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(result.census.excluded['over-budget']).toBe(6);
  });

  it('skips a fact that does not fit and keeps looking, as the budget fill documents', () => {
    const cheap = factOf('cheap', 'Short.', { at: T0 });
    // Long enough that one block cannot fit in the budget the two of them are given, so the run has to skip
    // it and keep looking rather than stop at the first miss.
    const expensive = factOf('big', 'x'.repeat(2000), { at: T0 + 1 });
    const result = run([expensive, cheap], { budgetTokens: 60 });
    expect(result.served.map((entry) => entry.factId)).toContain('cheap');
    expect(result.excluded).toContainEqual({ factId: 'big', reason: 'over-budget' });
  });

  it('never exceeds the budget it reports', () => {
    for (const budget of [40, 80, 160, 320]) {
      const result = run(facts, { budgetTokens: budget });
      expect(result.census.tokens).toBeLessThanOrEqual(budget);
      expect(result.census.budget).toBe(budget);
    }
  });

  it('spends less for a group than the blocks would cost separately, because the frame is shared', () => {
    // The measured reason the block is grouped: the frame appears once. Two facts of one sentence therefore
    // cost roughly one sentence plus two lines, not two sentences.
    const two = [facts[0]!, facts[1]!];
    const together = run(two, { budgetTokens: 10_000 });
    expect(together.census.tokens).toBeGreaterThan(0);
    expect(together.lines.filter((line) => line.startsWith('frame:'))).toHaveLength(1);
  });

  it('serves everything when the budget is switched off', () => {
    const result = run(facts, { policy: { budget: false } });
    expect(result.served).toHaveLength(6);
    expect(result.census.budget).toBe(0);
  });
});

describe('the conflict the store keeps and the answer refuses to choose', () => {
  const left = factOf('a', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' });
  const right = factOf('b', 'I live in Paris.', { at: T0, subject: 'user', predicate: 'city' });

  it('serves both sides, so the reader can judge', () => {
    const result = run([left, right]);
    expect(result.served).toHaveLength(2);
    expect(result.census.conflicts).toBe(2);
  });

  it('marks them in the block rather than only in the census', () => {
    const result = run([left, right]);
    expect(result.lines.filter((line) => line.startsWith('conflict:'))).toHaveLength(2);
  });

  it('does not call it a conflict when the two values agree', () => {
    const same = factOf('c', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' });
    const result = run([left, same]);
    expect(result.census.conflicts).toBe(0);
  });

  it('does not call it a conflict when they claim different instants', () => {
    const later = factOf('d', 'I live in Paris.', {
      at: T0 + DAY,
      subject: 'user',
      predicate: 'city',
    });
    expect(run([left, later]).census.conflicts).toBe(0);
  });

  it('does not call it a conflict when the slot is unnamed', () => {
    const loose = factOf('e', 'I live in Paris.', { at: T0 });
    expect(run([left, loose]).census.conflicts).toBe(0);
  });

  it('ignores a disagreement that involves a fact the ledger already retired', () => {
    const result = run([left, retired(right)]);
    expect(result.served.map((entry) => entry.factId)).toEqual(['a']);
    expect(result.census.conflicts).toBe(0);
  });
});

describe('the census is the shape of what happened', () => {
  const facts = [
    factOf('a', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' }),
    factOf('b', 'I live in Paris.', { at: T0, subject: 'user', predicate: 'city' }),
    retired(factOf('c', 'I like tea.', { at: T0 })),
  ];

  it('accounts for every fact it was given', () => {
    const result = run(facts);
    const excluded = Object.values(result.census.excluded).reduce(
      (total, value) => total + value,
      0,
    );
    expect(result.census.considered).toBe(facts.length);
    expect(result.census.served + excluded).toBe(facts.length);
  });

  it('reports no conflicts and no leak on an empty unit', () => {
    const result = run([]);
    expect(result.census).toMatchObject({ considered: 0, served: 0, conflicts: 0, tokens: 0 });
    expect(result.lines).toEqual([]);
  });

  it('excludes a fact the ranker never scored, rather than serving it by default', () => {
    const result = run(facts, { scores: [{ factId: 'a', score: 1 }] });
    expect(result.excluded.filter((entry) => entry.reason === 'no-score')).toHaveLength(2);
  });
});

describe('determinism and ordering', () => {
  it('breaks a tie on effective score by id, so two runs cannot disagree', () => {
    const left = factOf('a', 'Alpha.', { at: T0 });
    const right = factOf('b', 'Beta.', { at: T0 });
    const result = run([right, left], {
      scores: [
        { factId: 'a', score: 1 },
        { factId: 'b', score: 1 },
      ],
    });
    expect(result.served.map((entry) => entry.factId)).toEqual(['a', 'b']);
  });

  it('orders by effective score, not by the score it was handed', () => {
    const strong = factOf('a', 'Alpha.', { at: T0 });
    const weak = factOf('b', 'Beta.', { at: T0 });
    const result = run([weak, strong], {
      scores: [
        { factId: 'a', score: 1 },
        { factId: 'b', score: 2 },
      ],
    });
    expect(result.served.map((entry) => entry.factId)).toEqual(['b', 'a']);
  });

  it('is a function of its inputs alone', () => {
    const facts = [factOf('a', 'Alpha.', { at: T0 }), factOf('b', 'Beta.', { at: T0 })];
    expect(run(facts)).toEqual(run(facts));
  });
});

describe('policy defaults to everything on', () => {
  it('treats an empty policy as all four questions asked', () => {
    const result = run([factOf('a', 'Alpha.', { at: T0 })]);
    expect(result.census.served).toBe(1);
  });

  it('accepts an explicit empty object as the same', () => {
    const policy: AssemblePolicy = {};
    expect(run([factOf('a', 'Alpha.', { at: T0 })], { policy }).census.served).toBe(1);
  });
});

describe('the degenerate facts a real store contains', () => {
  it('treats an anchor whose value is not a number as no anchor at all', () => {
    // An import can carry anything. A date that failed to parse must not become `NaN` and quietly fail every
    // window comparison, so it degrades to "cannot be placed".
    const broken: KnowledgeFact = {
      ...withoutAt(factOf('b', 'x')),
      assumptions: [
        {
          kind: 'time-anchor',
          origin: 'ingestion-time',
          status: 'open',
          value: 'not-a-date',
          openedAt: T0,
          support: 1,
          contradict: 0,
        },
      ],
    };
    expect(effectiveAt(broken)).toBeUndefined();
  });

  it('cannot place a fact that has no time and no anchor either', () => {
    // Neither a stated time nor an assumed one: the fact exists and answers, it just cannot be dated.
    // No stated time and no derived anchor: `deriveAssumptions` would have given one, so it is cleared here
    // to model a fact that arrived through an import rather than through the reader.
    const undated: KnowledgeFact = { ...withoutAt(factOf('u', 'Alpha.')), assumptions: [] };
    expect(undated.at).toBeUndefined();
    expect(effectiveAt(undated)).toBeUndefined();
  });

  it('answers a fact that carries no assumption list at all', () => {
    const bare: KnowledgeFact = {
      id: 'bare',
      frameId: FRAME.id,
      text: 'Alpha.',
      type: 'state',
      polarity: 'positive',
      modality: 'actual',
      sourceSpan: { start: 0, end: 6 },
      references: [],
      at: T0,
      assumptions: [],
    };
    const result = run([bare]);
    expect(result.served.map((entry) => entry.factId)).toEqual(['bare']);
    expect(result.served[0]!.penalty).toEqual({ factor: 1, reason: 'answerable' });
  });

  it('does not look for a conflict on a slot that holds one fact', () => {
    const only = factOf('one', 'I live in London.', { at: T0, subject: 'user', predicate: 'city' });
    expect(run([only]).census.conflicts).toBe(0);
  });
});

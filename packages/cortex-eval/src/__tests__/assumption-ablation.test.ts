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
  pollutionGap,
  resolve,
  scoreArm,
  TARGETS,
  type Ablation,
  type Arm,
  type Case,
} from '../assumption-ablation.js';

const FULL: Ablation = {
  persistence: true,
  uniqueness: true,
  timeAnchor: true,
  cascade: true,
  temporality: true,
  lapse: true,
  fulfil: true,
  immutability: true,
};
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
  const cases = buildCases({ cascade: true });

  it('covers every family, so no mechanism is unmeasured', () => {
    const families = new Set(cases.map((entry) => entry.family));
    expect([...families].sort()).toEqual([
      'cascade',
      'conflict',
      'false-stale',
      'historical',
      'immutable',
      'plan',
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
    expect(buildCases({ cascade: true })).toEqual(buildCases({ cascade: true }));
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
    expect(resolve(empty, 'flat')).toMatchObject({
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
    expect(resolve(base, 'gated')).toMatchObject({
      answer: 'b',
      reason: 'latest',
      servedRetired: 0,
    });
  });

  it('answers a dated question from the window, and does not treat retirement as falsehood', () => {
    const dated: Case = { ...base, family: 'historical', asOf: T0 + 5 * DAY, expect: 'a' };
    expect(resolve(dated, 'gated')).toMatchObject({
      answer: 'a',
      reason: 'windowed',
      servedRetired: 0,
    });
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
    // Nothing was served, so nothing was served *retired*: the counter is about leaks, and a refusal is not
    // one. The number of blocked facts is in the census, where a report can find it.
    expect(resolution.servedRetired).toBe(0);
    expect(resolution.census.excluded.refuted).toBe(2);
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
  // The invalidation is applied where it belongs — at ingest — so the arm sees a fact that has already been
  // retired. Declaring it inside the arm would be a second semantics for one word.
  const withInvalidation = (pairs: readonly (readonly [string, string])[]): Case => ({
    id: 'ii',
    family: 'type-ii',
    query: 'How does the user get to the office?',
    slot: { subject: 'user', predicate: 'commute' },
    facts: reviseLedger([commute, remote], { invalidations: pairs }).facts,
    expect: null,
  });

  it('removes the invalidated fact, so the answer is unknown rather than the old value', () => {
    expect(resolve(withInvalidation([['r', 'c']]), 'gated').answer).toBeNull();
  });

  it('ignores a declaration that points backwards in time, because only a later fact can invalidate', () => {
    expect(resolve(withInvalidation([['c', 'r']]), 'gated').answer).toBe('c');
  });

  it('ignores a declaration naming a fact that is not in the case', () => {
    expect(resolve(withInvalidation([['nope', 'c']]), 'gated').answer).toBe('c');
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
  const chainFor = (cascade: boolean): Case => ({
    id: 'g',
    family: 'cascade',
    query: 'How much is the deposit on the flat?',
    slot: { subject: 'flat', predicate: 'deposit' },
    facts: reviseLedger([rent, deposit, left], {
      cascade,
      invalidations: [['e1', 'r1']],
    }).facts,
    expect: null,
  });
  const cascadeCase = chainFor(true);

  it('propagates through a borrowed word when the cascade is on', () => {
    expect(resolve(cascadeCase, 'gated').answer).toBeNull();
  });

  it('stops at the invalidated fact when the cascade is off', () => {
    // The cascade acts at ingest, so removing it has to change what was **built** — passing the flag to the
    // read side would leave a fact already marked stale and merely stop re-marking it.
    expect(resolve(chainFor(false), 'gated', { ...FULL, cascade: false }).answer).toBe('d1');
  });
});

describe('scoreArm: counting, per family', () => {
  const cases = buildCases({ cascade: true });
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
      'temporality',
      'lapse',
      'fulfil',
      'immutability',
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
    const cases = buildCases({ cascade: true });
    for (const arm of ['no-memory', 'flat', 'annotated', 'gated'] as Arm[]) {
      expect(scoreArm(cases, arm).n).toBe(cases.length);
    }
  });
});

describe('resolve: a commitment is not a fact', () => {
  const plan = factOf('q1', 'f1', 'I will visit Paris next month.', {
    subject: 'user',
    predicate: 'trip',
    at: T0 + 30 * DAY,
  });
  const lapsed: KnowledgeFact = {
    ...plan,
    type: 'goal',
    modality: 'planned',
    futurity: 'future',
    planState: 'lapsed',
  };
  const pending: KnowledgeFact = { ...lapsed, planState: 'pending' };

  const base: Case = {
    id: 'pl',
    family: 'plan',
    query: 'Did the user visit Paris?',
    slot: { subject: 'user', predicate: 'trip' },
    facts: [lapsed],
    expect: null,
    intent: 'fact',
  };

  it('refuses to answer a question about what happened with a plan that never came due', () => {
    expect(resolve(base, 'gated')).toMatchObject({ answer: null, reason: 'all-retired' });
  });

  it('answers the same case under flat with the plan, which is the failure being measured', () => {
    expect(resolve(base, 'flat').answer).toBe('q1');
  });

  it('keeps a pending plan when the question asks what is planned', () => {
    const asking: Case = {
      ...base,
      facts: [pending],
      query: 'Where will the user go?',
      intent: 'plan',
    };
    expect(resolve(asking, 'gated').answer).toBe('q1');
  });

  it('cannot tell the two apart once the axis is switched off, which is what -temporality measures', () => {
    expect(resolve(base, 'gated', { ...FULL, temporality: false }).answer).toBe('q1');
  });

  it('lets a fulfilled plan stand as a fact, because it happened', () => {
    const fulfilled: KnowledgeFact = { ...lapsed, planState: 'fulfilled' };
    const asking: Case = { ...base, facts: [fulfilled], expect: 'q1' };
    expect(resolve(asking, 'gated').answer).toBe('q1');
  });
});

describe('resolve: a settled event is not replaced', () => {
  const paris = factOf('r1', 'f1', 'I visited Paris last year.', {
    subject: 'user',
    predicate: 'trip',
    at: T0,
  });
  const rome = factOf('r2', 'f2', 'I visited Rome last month.', {
    subject: 'user',
    predicate: 'trip',
    at: T0 + 300 * DAY,
  });
  const settled: Case = {
    id: 'im',
    family: 'immutable',
    query: 'Which city did the user visit last year?',
    slot: { subject: 'user', predicate: 'trip' },
    facts: [
      { ...paris, type: 'event', futurity: 'past' },
      { ...rome, type: 'event', futurity: 'past' },
    ],
    expect: 'r1',
  };

  it('still answers with the earlier visit, because nothing superseded it', () => {
    expect(resolve(settled, 'gated').answer).toBe('r1');
  });

  it('answers with the later one once the protection is removed, which is the cost being measured', () => {
    // With the protection off, `deriveSupersedes` builds the edge a system without it would build, and the
    // earlier trip retires. That is the failure the protection exists to prevent, reproduced at ingest.
    const unprotected: Case = {
      ...settled,
      facts: reviseLedger(settled.facts, { invalidations: [['r2', 'r1']] }).facts,
    };
    expect(resolve(unprotected, 'gated').answer).toBe('r2');
  });
});

describe('ablate: the two axes and the lifecycle', () => {
  const rows = ablate();
  const full = rows[0]!;

  it('loses accuracy when the axis is not read, on both plan families', () => {
    const withoutTemporality = rows.find((row) => row.removed === 'temporality')!;
    expect(withoutTemporality.byFamily.plan.correct).toBeLessThan(full.byFamily.plan.correct);
    expect(withoutTemporality.byFamily.immutable.correct).toBeLessThan(
      full.byFamily.immutable.correct,
    );
  });

  it('loses the protected case when immutability is removed', () => {
    const without = rows.find((row) => row.removed === 'immutability')!;
    expect(without.byFamily.immutable.correct).toBeLessThan(full.byFamily.immutable.correct);
    expect(without.byFamily['type-i'].correct).toBe(full.byFamily['type-i'].correct);
  });

  it('records lapse as inert here, and says why that null is structural', () => {
    // Two plans on one slot are separated by `supersedes` before `lapse` is consulted, and `supersedes` is the
    // stronger of the two. Written as a test so the null cannot later be read as a finding.
    expect(rows.find((row) => row.removed === 'lapse')!.accuracy).toBe(full.accuracy);
  });

  it('prices fulfil on the case whose only evidence is the declaration', () => {
    // `pl-fulfilled-on-declaration` is a plan and no separate record of the event: without the transition it
    // stays `pending`, the question about what happened excludes it, and the answer is "unknown".
    const without = rows.find((row) => row.removed === 'fulfil')!;
    expect(without.byFamily.plan.correct).toBeLessThan(full.byFamily.plan.correct);
  });
});

/**
 * The floor: what the product scores with nothing in the store.
 *
 * The arm exists because every comparison this fixture could make was between two kinds of memory, and the
 * question TEPA asks is about memory as such -- an append-only store scored `0.210` against `0.309` for no
 * memory at all during full reversal, so a persistent store can be worse than an amnesiac one. A set that
 * cannot express that comparison cannot report pollution, however many mechanisms it prices.
 */
describe('no-memory: the floor every arm is worth measuring against', () => {
  const cases = buildCases({ cascade: true });

  it('answers nothing, on every case, whatever the question', () => {
    const report = scoreArm(cases, 'no-memory');
    expect(report.n).toBe(cases.length);
    for (const outcome of report.outcomes) {
      expect(outcome.answer, outcome.caseId).toBeNull();
    }
  });

  it('is correct exactly on the cases whose gold is a decline', () => {
    // The floor is not a straw man with a zero on it: on this fixture "unknown" is the right answer five
    // times, so an empty store scores five of seventeen and any arm below that is worse than amnesia.
    const report = scoreArm(cases, 'no-memory');
    const declineCases = cases.filter((entry) => entry.expect === null).length;
    expect(report.correct).toBe(declineCases);
    expect(report.accuracy).toBeCloseTo(declineCases / cases.length, 10);
  });

  it('never serves a retired fact, because it serves nothing', () => {
    expect(scoreArm(cases, 'no-memory').retiredServed).toBe(0);
  });

  it('reports the reason as its own, not as an unplaceable fact', () => {
    // `unplaceable` is what `assemble` says when it was handed candidates and could not place any of them.
    // The floor never handed it one, and collapsing the two states would hide a mis-wired arm as a floor.
    const entry = cases.find((candidate) => candidate.expect !== null)!;
    expect(resolve(entry, 'no-memory').reason).toBe('no-memory');
  });

  it('shares the flat arm policy, so the difference between them is the candidate list', () => {
    // Stated as a behaviour rather than read off `ARM_POLICY`: if the two arms ever diverged in policy, the
    // floor would stop bounding the append-only store and the comparison would be between two designs.
    const asOfFree = cases.filter((entry) => entry.asOf === undefined);
    for (const entry of asOfFree) {
      const floor = resolve(entry, 'no-memory');
      const flat = resolve(entry, 'flat');
      expect(floor.census.served, entry.id).toBe(0);
      expect(floor.census.served).toBeLessThanOrEqual(flat.census.served);
    }
  });

  it('prices the append-only store at exactly zero on this fixture, which is the finding', () => {
    // Six cases gained against six lost. The number is asserted rather than bounded because it is the
    // headline of the comparison: an append-only store on a contradiction-bearing corpus is worth nothing,
    // and a fixture change that moves it is a change to the claim.
    expect(pollutionGap(cases)).toBeCloseTo(0, 10);
  });

  it('can go negative, which is why the criterion is falsifiable', () => {
    // The synthetic set below is a store that only ever loses: two conflicts and no update. If `pollutionGap`
    // could not move below zero there would be no criterion here worth gating on, only a constant.
    const CITY = { subject: 'user', predicate: 'city' };
    const conflicting = (id: string, text: string): KnowledgeFact => ({
      id,
      frameId: id,
      text,
      type: 'state',
      polarity: 'positive',
      modality: 'actual',
      futurity: 'present',
      certainty: 'factual',
      sourceSpan: { start: 0, end: text.length },
      references: [],
      ...CITY,
      at: T0,
      assumptions: deriveAssumptions(
        {
          id,
          frameId: id,
          text,
          type: 'state',
          polarity: 'positive',
          modality: 'actual',
          futurity: 'present',
          certainty: 'factual',
          sourceSpan: { start: 0, end: text.length },
          references: [],
          ...CITY,
          at: T0,
        },
        frameOf(id, T0, text),
      ),
    });
    const onlyConflicts: Case[] = [
      {
        id: 'synthetic-conflict',
        family: 'conflict',
        query: 'Where does the user live?',
        slot: CITY,
        facts: [conflicting('x1', 'I live in London.'), conflicting('x2', 'I live in Paris.')],
        expect: null,
      },
    ];
    const revised = reviseLedger(onlyConflicts[0]!.facts, { cascade: true }).facts;
    const set: Case[] = [{ ...onlyConflicts[0]!, facts: revised }];
    // The floor is right (it declines) and the append-only store is wrong (it serves one of two values that
    // claim the same instant), so the store is worth minus one case out of one.
    expect(pollutionGap(set)).toBeCloseTo(-1, 10);
  });

  it('is the baseline the ablation table is a delta from', () => {
    // `tools/assumption-ablation.mjs` printed `gated 94.1%` above a `none +5.9pp` row, because the headline
    // built its cases with `buildCases(true)` -- a boolean read as an options object, so `cascade` was
    // undefined and the two tables ran different fixtures. The regression is asserted here rather than left
    // to the tool: the headline arm of the registered configuration equals the ablation's own `none` row.
    const rows = ablate();
    const none = rows.find((row) => row.removed === 'none')!;
    expect(scoreArm(cases, 'gated').accuracy).toBeCloseTo(none.accuracy, 10);
  });
});

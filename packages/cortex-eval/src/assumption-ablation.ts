/**
 * The ablation that decides whether an assumption ledger is worth its cost.
 *
 * ## Why a synthetic set, and why this shape
 *
 * arXiv 2606.22030 measured the reason directly: belief-updating machinery shows "little benefit over
 * naive last-write-wins" on LoCoMo, because the corpus contains almost no contradictions. A benchmark
 * without conflicts cannot measure a mechanism whose only job is to survive them.
 *
 * The unit of measurement is therefore **one slot and one question**: given everything said about
 * `user.city`, what is the current value? That is the shape of a knowledge-update question, it is the
 * shape of the failure already on record (`25:50` beside `27:12`, the older one chosen), and it does not
 * need a retriever to be defensible — which matters, because a lexical ranker in a fixture would measure
 * the ranker.
 *
 * ## The three arms
 *
 * | Arm | How it answers | What it is for |
 * | --- | --- | --- |
 * | `flat` | last write wins: the fact with the latest time | the published baseline |
 * | `annotated` | the same, with assumption state attached to each fact | tests the cheapest hypothesis: is labelling enough? |
 * | `gated` | the ledger decides: retired facts leave, a dated question reads at its own instant, an unresolved conflict answers "unknown" | the mechanism |
 *
 * `annotated` is expected to equal `flat`. That expectation is the point of the arm: labelling that does
 * not change a decision is not a mechanism, it is decoration, and the number says which one this is.
 *
 * ## Why `invalidates` is declared rather than inferred
 *
 * A propagated conflict (STALE Type II) is one where the changed attribute is never mentioned in relation
 * to the fact it breaks. Detecting that from text is a hard research problem; **using** it once known is a
 * bookkeeping problem. PACMI draws exactly this line — it evaluates "read-path behaviour conditional on
 * derivation links being represented or supplied" and states that it does not solve the extraction.
 *
 * So each case declares which later fact invalidates which earlier one, and the ablation measures whether
 * the system propagates that correctly. Detecting it is a separate iteration and is not claimed here.
 */

import {
  assumptionOf,
  deriveAssumptions,
  reviseLedger,
  slotKey,
  type KnowledgeFact,
  type KnowledgeFrame,
} from '@agentix-e/cortex-core';

/** What a case isolates. One per published failure family, plus the control that must not move. */
export type CaseFamily =
  'type-i' | 'historical' | 'false-stale' | 'conflict' | 'type-ii' | 'cascade';

/** Which mechanism is allowed to participate. */
export type Arm = 'flat' | 'annotated' | 'gated';

/** Which assumption kinds the arm may read. */
export type Ablation = {
  readonly persistence: boolean;
  readonly uniqueness: boolean;
  readonly timeAnchor: boolean;
  readonly cascade: boolean;
};

const FULL: Ablation = { persistence: true, uniqueness: true, timeAnchor: true, cascade: true };

export type Case = {
  readonly id: string;
  readonly family: CaseFamily;
  /** What was asked. Matched lexically on purpose — the arm must be the only thing that moves. */
  readonly query: string;
  /** The slot under test. */
  readonly slot: { readonly subject: string; readonly predicate: string };
  /** Facts about the slot. Other facts in the store are noise and must not be chosen. */
  readonly facts: readonly KnowledgeFact[];
  /** The instant the question is about, when it is about one. */
  readonly asOf?: number;
  /** What a correct answer names, or `null` when the correct answer is "unknown". */
  readonly expect: string | null;
  /**
   * Declared invalidations: `[newer, older]` means the newer fact makes the older one meaningless.
   *
   * Supplied rather than inferred — see the module comment. This is the input PACMI assumes, and the
   * measurement is of the propagation, not of the discovery.
   */
  readonly invalidates?: readonly (readonly [string, string])[];
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

let sequence = 0;

function frameOf(id: string, at: number, text: string): KnowledgeFrame {
  return { id, text, speaker: 'user', at };
}

type SlotSpec = {
  readonly subject: string;
  readonly predicate: string;
  readonly at?: number;
  readonly count?: number;
  readonly references?: readonly { token: string; sourceId: string }[];
};

function fact(frameId: string, at: number, text: string, spec: SlotSpec): KnowledgeFact {
  sequence += 1;
  const frame = frameOf(frameId, at, text);
  const base: KnowledgeFact = {
    id: `f${sequence}`,
    frameId,
    text,
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: text.length },
    references: spec.references ?? [],
    subject: spec.subject,
    predicate: spec.predicate,
    ...(spec.at === undefined ? {} : { at: spec.at }),
    ...(spec.count === undefined ? {} : { count: spec.count }),
  };
  return { ...base, assumptions: deriveAssumptions(base, frame) };
}

const CITY = { subject: 'user', predicate: 'city' };

/**
 * The cases.
 *
 * Every one is two to four facts and one slot, because a case that needs a paragraph to explain is a case
 * whose failure cannot be attributed to one mechanism.
 */
export function buildCases(cascade = false): readonly Case[] {
  sequence = 0;
  const cases: Case[] = [];

  // ---- type-i: same slot, incompatible value, no explicit negation (STALE Type I) ----------------
  {
    const old = fact('a1', T0, 'I live in London.', { ...CITY, at: T0 });
    const next = fact('a2', T0 + 90 * DAY, 'I live in Berlin.', { ...CITY, at: T0 + 90 * DAY });
    cases.push({
      id: 'i-city-now',
      query: 'Where does the user live?',
      family: 'type-i',
      slot: CITY,
      facts: [old, next],
      expect: next.id,
    });
  }
  {
    const ROLE = { subject: 'user', predicate: 'role' };
    const old = fact('b1', T0, 'I work as a support engineer.', { ...ROLE, at: T0 });
    const next = fact('b2', T0 + 120 * DAY, 'I was promoted to team lead.', {
      ...ROLE,
      at: T0 + 120 * DAY,
    });
    cases.push({
      id: 'i-role-now',
      query: 'What is the user job?',
      family: 'type-i',
      slot: ROLE,
      facts: [old, next],
      expect: next.id,
    });
  }
  {
    const PETS = { subject: 'user', predicate: 'pets' };
    const old = fact('c1', T0, 'I have one cat.', { ...PETS, at: T0, count: 1 });
    const next = fact('c2', T0 + 60 * DAY, 'We adopted a second cat.', {
      ...PETS,
      at: T0 + 60 * DAY,
      count: 2,
    });
    cases.push({
      id: 'i-pets-now',
      query: 'How many cats does the user have?',
      family: 'type-i',
      slot: PETS,
      facts: [old, next],
      expect: next.id,
    });
  }

  // ---- historical: the superseded value is the right answer for its own instant ----------------
  {
    const old = fact('h1', T0, 'I live in London.', { ...CITY, at: T0 });
    const next = fact('h2', T0 + 90 * DAY, 'I live in Berlin.', { ...CITY, at: T0 + 90 * DAY });
    cases.push({
      id: 'h-city-as-of-january',
      query: 'Where did the user live in January 2026?',
      family: 'historical',
      slot: CITY,
      facts: [old, next],
      asOf: T0 + 5 * DAY,
      expect: old.id,
    });
  }
  {
    const ROLE = { subject: 'user', predicate: 'role' };
    const old = fact('h3', T0, 'I work as a support engineer.', { ...ROLE, at: T0 });
    const next = fact('h4', T0 + 120 * DAY, 'I was promoted to team lead.', {
      ...ROLE,
      at: T0 + 120 * DAY,
    });
    cases.push({
      id: 'h-role-as-of-february',
      query: 'What was the user job in February 2026?',
      family: 'historical',
      slot: ROLE,
      facts: [old, next],
      asOf: T0 + 30 * DAY,
      expect: old.id,
    });
  }

  // ---- false-stale control: an update exists, but outside the asked instant -------------------
  // Marking the older fact stale here is the error, and it is the error a naively gated arm makes.
  {
    const old = fact('s1', T0, 'I live in London.', { ...CITY, at: T0 });
    const next = fact('s2', T0 + 90 * DAY, 'I live in Berlin.', { ...CITY, at: T0 + 90 * DAY });
    cases.push({
      id: 'c-city-as-of-march',
      query: 'Where did the user live in March 2026?',
      family: 'false-stale',
      slot: CITY,
      facts: [old, next],
      asOf: T0 + 60 * DAY,
      expect: old.id,
    });
  }
  {
    const PETS = { subject: 'user', predicate: 'pets' };
    const old = fact('s3', T0, 'I have one cat.', { ...PETS, at: T0, count: 1 });
    const next = fact('s4', T0 + 60 * DAY, 'We adopted a second cat.', {
      ...PETS,
      at: T0 + 60 * DAY,
      count: 2,
    });
    cases.push({
      id: 'c-pets-as-of-february',
      query: 'How many cats did the user have in February 2026?',
      family: 'false-stale',
      slot: PETS,
      facts: [old, next],
      asOf: T0 + 40 * DAY,
      expect: old.id,
    });
  }

  // ---- conflict: two values claim one instant, so the correct answer is "unknown" -------------
  {
    const left = fact('k1', T0, 'I live in London.', { ...CITY, at: T0 });
    const right = fact('k2', T0, 'I live in Paris.', { ...CITY, at: T0 });
    cases.push({
      id: 'k-city-two-values-one-day',
      query: 'Where does the user live?',
      family: 'conflict',
      slot: CITY,
      facts: [left, right],
      expect: null,
    });
  }
  {
    const BIRTHDAY = { subject: 'user', predicate: 'birthday' };
    const left = fact('k3', T0, 'My birthday is in March.', { ...BIRTHDAY, at: T0 });
    const right = fact('k4', T0, 'My birthday is in April.', { ...BIRTHDAY, at: T0 });
    cases.push({
      id: 'k-birthday-two-values-one-day',
      query: 'When is the user birthday?',
      family: 'conflict',
      slot: BIRTHDAY,
      facts: [left, right],
      expect: null,
    });
  }

  // ---- type-ii: an upstream change makes a downstream slot meaningless --------------------------
  {
    const COMMUTE = { subject: 'user', predicate: 'commute' };
    const commute = fact('p1', T0, 'I take the northern line to the office.', {
      ...COMMUTE,
      at: T0,
    });
    const remote = fact('p2', T0 + 200 * DAY, 'I now work fully remote from home.', {
      subject: 'user',
      predicate: 'workplace',
      at: T0 + 200 * DAY,
    });
    cases.push({
      id: 'ii-commute-after-remote',
      query: 'How does the user get to the office?',
      family: 'type-ii',
      slot: COMMUTE,
      facts: [commute, remote],
      expect: null,
      invalidates: [[remote.id, commute.id]],
    });
  }
  {
    const CARD = { subject: 'user', predicate: 'travel-card' };
    const card = fact('p3', T0, 'My travel card is on the blue plan.', { ...CARD, at: T0 });
    const moved = fact('p4', T0 + 80 * DAY, 'I moved to a different country.', {
      subject: 'user',
      predicate: 'residence',
      at: T0 + 80 * DAY,
    });
    cases.push({
      id: 'ii-card-after-move',
      query: 'Which travel card plan is the user on?',
      family: 'type-ii',
      slot: CARD,
      facts: [card, moved],
      expect: null,
      invalidates: [[moved.id, card.id]],
    });
  }

  // ---- cascade: the invalidated fact is the premise of a third one -----------------------------
  {
    const RENT = { subject: 'flat', predicate: 'rent' };
    const DEPOSIT = { subject: 'flat', predicate: 'deposit' };
    const rent = fact('g1', T0, 'The flat costs 900 a month.', { ...RENT, at: T0 });
    const deposit = fact('g2', T0, 'The deposit is two months of rent.', {
      ...DEPOSIT,
      at: T0,
      references: [{ token: 'flat', sourceId: 'g1' }],
    });
    const left = fact('g3', T0 + 100 * DAY, 'I moved out of the flat.', {
      subject: 'flat',
      predicate: 'occupancy',
      at: T0 + 100 * DAY,
    });
    cases.push({
      id: 'g-deposit-after-moving-out',
      query: 'How much is the deposit on the flat?',
      family: 'cascade',
      slot: DEPOSIT,
      facts: [rent, deposit, left],
      // Fixed, not a function of the switch: the answer is "unknown" because the premise the deposit
      // figure rested on was invalidated. A truth value that moved with the ablation would make the
      // ablation measure itself.
      expect: null,
      invalidates: [[left.id, rent.id]],
    });
  }

  return cases.map((entry) => ({ ...entry, facts: reviseLedger(entry.facts, { cascade }).facts }));
}

/** Words of length >= 3, folded. Short words are connectives and pronouns and carry no topic. */
function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []).filter((word) => word.length >= 3),
  );
}

/** How much of the question a fact covers. Deliberately lexical: this is a control, not a retriever. */
function overlap(query: string, text: string): number {
  const asked = contentWords(query);
  if (asked.size === 0) return 0;
  const offered = contentWords(text);
  let hits = 0;
  for (const word of asked) if (offered.has(word)) hits += 1;
  return hits / asked.size;
}

/** When a fact claims to hold. `at` when stated; the anchor when it was assumed; `undefined` if neither. */
function effectiveAt(fact: KnowledgeFact, ablation: Ablation): number | undefined {
  if (fact.at !== undefined) return fact.at;
  if (!ablation.timeAnchor) return undefined;
  const anchor = assumptionOf(fact, 'time-anchor');
  return anchor === undefined ? undefined : Number(anchor.value);
}

export type Resolution = {
  readonly answer: string | null;
  readonly reason:
    'latest' | 'windowed' | 'none-in-window' | 'all-retired' | 'conflict' | 'unplaceable';
  /** Facts that were retired and still answered. The number that must be zero under `gated`. */
  readonly servedRetired: number;
};

function retired(fact: KnowledgeFact, ablation: Ablation): boolean {
  if (fact.stale === true && ablation.cascade) return true;
  if (!ablation.persistence) return false;
  return assumptionOf(fact, 'persistence')?.status === 'refuted';
}

/**
 * Answer one case under one arm.
 *
 * Last-write-wins is implemented as *the latest effective time*, not as "the last item in the array": a
 * baseline that depended on array order would be measuring the fixture. Where two facts share that latest
 * time, `flat` takes the smaller id — an arbitrary tie-break, which is exactly the honest description of
 * what a system without a ledger does.
 */
export function resolve(entry: Case, arm: Arm, ablation: Ablation = FULL): Resolution {
  const all = entry.facts;
  const key = slotKey(entry.slot.subject, entry.slot.predicate);
  const pool = all.filter(
    (item) =>
      item.subject !== undefined &&
      item.predicate !== undefined &&
      slotKey(item.subject, item.predicate) === key,
  );

  if (arm === 'flat' || arm === 'annotated') {
    // Last-write-wins over the *relevant* pool is the honest baseline only when relevance is given; here
    // relevance is a lexical overlap and the tie-break is the id, which is what a system without a ledger
    // actually does when two facts are equally similar.
    const scored = pool
      .map((item) => ({ fact: item, score: overlap(entry.query, item.text) }))
      .sort((left, right) =>
        right.score !== left.score
          ? right.score - left.score
          : left.fact.id < right.fact.id
            ? -1
            : 1,
      );
    const winner = scored[0]?.fact;
    if (winner === undefined) return { answer: null, reason: 'unplaceable', servedRetired: 0 };
    return {
      answer: winner.id,
      reason: 'latest',
      servedRetired: retired(winner, ablation) ? 1 : 0,
    };
  }

  // gated: declared invalidations first, because they remove facts before any time reasoning.
  const invalidated = new Set<string>();
  for (const [newerId, olderId] of entry.invalidates ?? []) {
    const newer = all.find((item) => item.id === newerId);
    const older = all.find((item) => item.id === olderId);
    if (newer === undefined || older === undefined) continue;
    const newerAt = effectiveAt(newer, ablation);
    const olderAt = effectiveAt(older, ablation);
    // Only a *later* fact can invalidate an earlier one. A declaration that points backwards is a fixture
    // bug, and honouring it would let the fixture decide the answer.
    if (newerAt === undefined || olderAt === undefined || newerAt <= olderAt) continue;
    invalidated.add(olderId);
  }

  if (ablation.cascade) {
    // A fact that borrowed a word from an invalidated fact's frame loses its premise. Iterated to a fixed
    // point: a stale fact can be the premise of another. Switchable because PACMI's own ablation of the
    // cascade did not reach significance (p = 0.0574), and a mechanism that size must be measurable off.
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of all) {
        if (invalidated.has(item.id)) continue;
        const bindings = (item.assumptions ?? []).filter(
          (assumption) => assumption.kind === 'entity-binding',
        );
        const restsOnInvalidated = bindings.some((assumption) => {
          const sourceId = assumption.value.split('@')[1];
          if (sourceId === undefined) return false;
          return all.some((other) => other.frameId === sourceId && invalidated.has(other.id));
        });
        if (!restsOnInvalidated) continue;
        invalidated.add(item.id);
        changed = true;
      }
    }
  }

  // A dated question reads the ledger at its own instant. `refuted` means "no longer current", never
  // "never true", so the retirement rule is suspended here and the window does the work instead —
  // collapsing the two is the failure PACMI measured as 1.00 → 0.36 on historical queries.
  const dated = entry.asOf !== undefined;
  const inWindow = dated
    ? pool.filter((item) => {
        const at = effectiveAt(item, ablation);
        return at === undefined || at <= entry.asOf!;
      })
    : pool;

  const candidates = inWindow.filter(
    (item) => !invalidated.has(item.id) && (dated || !retired(item, ablation)),
  );

  if (candidates.length === 0) {
    return {
      answer: null,
      reason: inWindow.length === 0 ? 'none-in-window' : 'all-retired',
      servedRetired: inWindow.filter((item) => retired(item, ablation)).length,
    };
  }

  const scored = candidates
    .map((item) => ({ fact: item, score: overlap(entry.query, item.text) }))
    .sort((left, right) =>
      right.score !== left.score ? right.score - left.score : left.fact.id < right.fact.id ? -1 : 1,
    );

  // Two values claiming one instant, equally relevant: a ledger must refuse rather than pick. This is the
  // only arm that can say "unknown", and the conflict family exists to check that it does.
  const tied = scored.filter((item) => item.score === scored[0]!.score).map((item) => item.fact);
  if (
    ablation.uniqueness &&
    tied.length > 1 &&
    new Set(tied.map((item) => item.text.trim().toLowerCase())).size > 1 &&
    tied.every((item) => assumptionOf(item, 'uniqueness')?.status === 'refuted')
  ) {
    return { answer: null, reason: 'conflict', servedRetired: 0 };
  }

  return { answer: scored[0]!.fact.id, reason: dated ? 'windowed' : 'latest', servedRetired: 0 };
}

export type CaseOutcome = {
  readonly caseId: string;
  readonly family: CaseFamily;
  readonly answer: string | null;
  readonly expected: string | null;
  readonly correct: boolean;
  readonly servedRetired: number;
};

export type ArmReport = {
  readonly arm: Arm;
  readonly n: number;
  readonly correct: number;
  readonly accuracy: number;
  /** Answers that named a retired fact. Zero is the only acceptable value for `gated`. */
  readonly retiredServed: number;
  readonly byFamily: Readonly<Record<CaseFamily, { n: number; correct: number }>>;
  readonly outcomes: readonly CaseOutcome[];
};

/** Run one arm over every case. */
export function scoreArm(cases: readonly Case[], arm: Arm, ablation: Ablation = FULL): ArmReport {
  const outcomes: CaseOutcome[] = [];
  const byFamily: Record<string, { n: number; correct: number }> = {};

  for (const entry of cases) {
    const resolution = resolve(entry, arm, ablation);
    const correct = resolution.answer === entry.expect;
    outcomes.push({
      caseId: entry.id,
      family: entry.family,
      answer: resolution.answer,
      expected: entry.expect,
      correct,
      servedRetired: resolution.servedRetired,
    });
    const bucket = byFamily[entry.family] ?? { n: 0, correct: 0 };
    bucket.n += 1;
    bucket.correct += correct ? 1 : 0;
    byFamily[entry.family] = bucket;
  }

  const correct = outcomes.filter((outcome) => outcome.correct).length;
  return {
    arm,
    n: outcomes.length,
    correct,
    accuracy: outcomes.length === 0 ? 0 : correct / outcomes.length,
    retiredServed: outcomes.reduce((total, outcome) => total + outcome.servedRetired, 0),
    byFamily: byFamily as ArmReport['byFamily'],
    outcomes,
  };
}

/** One ablation row: the gated arm with exactly one mechanism removed. */
export type AblationRow = {
  readonly removed: 'none' | 'persistence' | 'uniqueness' | 'time-anchor' | 'cascade';
  readonly accuracy: number;
  readonly byFamily: Readonly<Record<CaseFamily, { n: number; correct: number }>>;
};

/** The families each mechanism is aimed at, so a null result is visible as a null result. */
export const TARGETS: Readonly<Record<AblationRow['removed'], readonly CaseFamily[]>> = {
  none: [],
  persistence: ['type-i', 'type-ii'],
  uniqueness: ['conflict'],
  'time-anchor': ['historical', 'false-stale'],
  cascade: ['cascade'],
};

/**
 * The full ablation table, with the "nothing removed" row first.
 *
 * The cases are rebuilt per row: `cascade` acts at ingestion, so removing it changes the ledger rather than
 * only the score. Rebuilding is cheap here (a dozen cases) and keeps one definition of a case.
 */
export function ablate(): readonly AblationRow[] {
  const rows: AblationRow[] = [];
  for (const removed of ['none', 'persistence', 'uniqueness', 'time-anchor', 'cascade'] as const) {
    const cases = buildCases(removed !== 'cascade');
    let ablation = FULL;
    if (removed === 'persistence') ablation = { ...ablation, persistence: false };
    if (removed === 'uniqueness') ablation = { ...ablation, uniqueness: false };
    if (removed === 'time-anchor') ablation = { ...ablation, timeAnchor: false };
    if (removed === 'cascade') ablation = { ...ablation, cascade: false };
    const report = scoreArm(cases, 'gated', ablation);
    rows.push({ removed, accuracy: report.accuracy, byFamily: report.byFamily });
  }
  return rows;
}

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
  assemble,
  deriveAssumptions,
  inferTemporality,
  modalityOf,
  reconcilePlans,
  reviseLedger,
  slotKey,
  type AssembleCensus,
  type AssemblePolicy,
  type Certainty,
  type Futurity,
  type KnowledgeFact,
  type KnowledgeFrame,
} from '@agentix-e/cortex-core';

/** What a case isolates. One per published failure family, plus the control that must not move. */
export type CaseFamily =
  | 'type-i'
  | 'historical'
  | 'false-stale'
  | 'conflict'
  | 'type-ii'
  | 'cascade'
  | 'plan'
  | 'immutable';

/** Which mechanism is allowed to participate. */
export type Arm = 'flat' | 'annotated' | 'gated';

/** Which assumption kinds the arm may read. */
export type Ablation = {
  readonly persistence: boolean;
  readonly uniqueness: boolean;
  readonly timeAnchor: boolean;
  readonly cascade: boolean;
  /** Whether a statement is read as past / future at all. Off means everything is present-and-factual. */
  readonly temporality: boolean;
  /** Whether a plan whose date passed without word becomes `lapsed`. */
  readonly lapse: boolean;
  /** Whether a plan ever becomes `fulfilled`. */
  readonly fulfil: boolean;
  /** Whether a settled event is protected from being replaced. */
  readonly immutability: boolean;
};

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

/** The switches that change how a case is **built** rather than only how it is answered. */
export type BuildOptions = {
  readonly cascade?: boolean;
  readonly temporality?: boolean;
  readonly immutability?: boolean;
  /** Whether a declared fulfilment is applied. Off leaves the plan `pending` for ever. */
  readonly fulfil?: boolean;
  /**
   * Whether a plan whose date passed without word becomes `lapsed`. Off reads the store before it was due.
   *
   * This switch is expected to move **no answer** on this fixture, and that is a finding rather than a gap:
   * two plans on one slot are separated by `supersedes` before `lapse` is consulted, and `supersedes` is the
   * stronger of the two (it retires the fact; `lapse` only discounts it). What `lapse` changes here is the
   * *state* — `pending` against `lapsed` — which `describePlan` renders and which decides whether a plan is
   * offered again. Pricing that needs a corpus where a plan and a settled fact about a different attribute
   * compete for one question, and this fixture is single-slot by construction.
   */
  readonly lapse?: boolean;
};

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
  /** `[plannedId, fulfillingId]` pairs. Declared — whether a plan happened is an event somebody states. */
  readonly fulfils?: readonly (readonly [string, string])[];
  /**
   * What the question is asking for, which is the axis the fixture had been missing.
   *
   * A question about **what happened** must not be answered with a plan, and a question about **what is
   * planned** must not be answered with the last settled fact. A system with no notion of the difference
   * answers both from one pool and is wrong on one of them by construction.
   */
  readonly intent?: 'fact' | 'plan';
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
/** The clock the fixture runs at: late enough that every dated plan in it is either due or long past. */
const NOW = T0 + 400 * DAY;

let sequence = 0;

function frameOf(id: string, at: number, text: string): KnowledgeFrame {
  return { id, text, speaker: 'user', at };
}

type SlotSpec = {
  readonly subject: string;
  readonly predicate: string;
  readonly at?: number;
  readonly count?: number;
  readonly type?: 'event' | 'state' | 'goal' | 'decision';
  readonly references?: readonly { token: string; sourceId: string }[];
};

/** Whether the axis is read at all. `false` is the `-temporality` ablation: everything is present-factual. */
let readTemporality = true;

function fact(frameId: string, at: number, text: string, spec: SlotSpec): KnowledgeFact {
  sequence += 1;
  const frame = frameOf(frameId, at, text);
  const axes: { futurity: Futurity; certainty: Certainty } = readTemporality
    ? inferTemporality(text)
    : { futurity: 'present', certainty: 'factual' };
  const base: KnowledgeFact = {
    id: `f${sequence}`,
    frameId,
    text,
    type: spec.type ?? 'state',
    polarity: 'positive',
    modality: modalityOf(axes.futurity, axes.certainty),
    futurity: axes.futurity,
    certainty: axes.certainty,
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
export function buildCases(options: BuildOptions = {}): readonly Case[] {
  const cascade = options.cascade === true;
  readTemporality = options.temporality !== false;
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

  // ---- plan: a commitment is not a fact, and its date decides which one it is -------------------
  {
    const TRIP = { subject: 'user', predicate: 'trip' };
    const planned = fact('q1', T0, 'I will visit Paris next month.', {
      ...TRIP,
      at: T0 + 30 * DAY,
      type: 'goal',
    });
    cases.push({
      id: 'pl-lapsed-is-not-a-fact',
      family: 'plan',
      query: 'Did the user visit Paris?',
      slot: TRIP,
      facts: [planned],
      expect: null,
      intent: 'fact',
    });
  }
  {
    const MOVE = { subject: 'user', predicate: 'move' };
    const planned = fact('q2', T0, 'I will move to Berlin next year.', {
      ...MOVE,
      at: T0 + 500 * DAY,
      type: 'goal',
    });
    const settled = fact('q3', T0, 'I live in London.', { ...CITY, at: T0 });
    cases.push({
      id: 'pl-pending-stays-a-plan',
      family: 'plan',
      query: 'Where will the user move to?',
      slot: MOVE,
      facts: [planned, settled],
      expect: planned.id,
      intent: 'plan',
    });
  }
  {
    const RACE = { subject: 'user', predicate: 'race' };
    const planned = fact('q4', T0, 'I will run a marathon in spring.', {
      ...RACE,
      at: T0 + 90 * DAY,
      type: 'goal',
    });
    const ran = fact('q5', T0 + 100 * DAY, 'I ran the marathon in April.', {
      ...RACE,
      at: T0 + 100 * DAY,
      type: 'event',
    });
    cases.push({
      id: 'pl-fulfilled-becomes-a-fact',
      family: 'plan',
      query: 'Did the user run a marathon?',
      slot: RACE,
      facts: [planned, ran],
      expect: ran.id,
      intent: 'fact',
      fulfils: [[planned.id, ran.id]],
    });
  }

  {
    // A commitment and a declaration that it happened, with no separate record of the event. This is the only
    // shape that prices `fulfil`: the plan is the sole evidence, so if the declaration is not applied the
    // question about what happened has no answer at all.
    const COURSE = { subject: 'user', predicate: 'course' };
    const planned = fact('q8', T0, 'I will take a course on statistics.', {
      ...COURSE,
      at: T0 + 30 * DAY,
      type: 'goal',
    });
    cases.push({
      id: 'pl-fulfilled-on-declaration',
      query: 'Did the user take a course on statistics?',
      family: 'plan',
      slot: COURSE,
      facts: [planned],
      expect: planned.id,
      intent: 'fact',
      fulfils: [[planned.id, 'declared:completed']],
    });
  }

  // ---- immutable: a settled event is not undone by a later one ---------------------------------
  {
    const TRIP = { subject: 'user', predicate: 'trip' };
    const paris = fact('r1', T0, 'I visited Paris last year.', { ...TRIP, at: T0, type: 'event' });
    const rome = fact('r2', T0 + 300 * DAY, 'I visited Rome last month.', {
      ...TRIP,
      at: T0 + 300 * DAY,
      type: 'event',
    });
    cases.push({
      id: 'im-history-is-not-rewritten',
      family: 'immutable',
      query: 'Which city did the user visit last year?',
      slot: TRIP,
      facts: [paris, rome],
      expect: paris.id,
      // With the protection off, the fixture declares the replacement a system without it would build.
      ...(options.immutability === false ? { invalidates: [[rome.id, paris.id]] as const } : {}),
    });
  }

  // Ingest order, and the order is the argument: a plan's life is resolved first, because whether a plan was
  // fulfilled decides whether it is still a plan; then declared invalidations, because they remove facts;
  // then the derived revision (supersession, agreement, contradiction) over what is left.
  //
  // Everything here is **ingest**: it writes a verdict onto a fact. Nothing here decides how the fact is
  // read — that is `assemble`, and keeping the two apart is what lets the ablation switch one without the
  // other.
  const { fulfil = true, lapse = true } = options;
  return cases.map((entry) => {
    const plans = reconcilePlans(entry.facts, lapse ? NOW : Number.NEGATIVE_INFINITY, {
      ...(entry.fulfils === undefined || !fulfil ? {} : { fulfils: entry.fulfils }),
    });
    return {
      ...entry,
      facts: reviseLedger(plans.facts, {
        cascade,
        ...(entry.invalidates === undefined ? {} : { invalidations: entry.invalidates }),
      }).facts,
    };
  });
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

/**
 * The policy each arm runs under, expressed entirely in switches the product understands.
 *
 * This is the change that matters most in this file. The three arms used to be three implementations, so a
 * difference between them could always have been a difference in *code* rather than in capability — and the
 * one thing an ablation must not do is measure its own fixture. They are now one call to `assemble` with
 * different switches, so a gap between `flat` and `gated` is a gap the product would also show.
 *
 * `flat` and `annotated` deliberately run the same policy. The second arm's purpose is to make the point
 * explicitly: the ledger is still *rendered* into the block for both, and rendering it changes no decision,
 * so the two score identically. That equality is now a property of the design rather than a coincidence of
 * two code paths, which is a weaker claim than the one the earlier version appeared to make and the honest
 * one.
 */
const ARM_POLICY: Record<Arm, AssemblePolicy> = {
  flat: { ledger: false, temporality: false, window: false, budget: false, uniqueness: false },
  annotated: { ledger: false, temporality: false, window: false, budget: false, uniqueness: false },
  gated: {},
};

/** The `gated` policy with the switched-off mechanisms removed. */
function policyFor(arm: Arm, ablation: Ablation): AssemblePolicy {
  const base = ARM_POLICY[arm];
  if (arm !== 'gated') return base;
  return {
    ...base,
    ...(ablation.persistence ? {} : { ledger: false }),
    ...(ablation.uniqueness ? {} : { uniqueness: false }),
    ...(ablation.timeAnchor ? {} : { anchor: false }),
    ...(ablation.temporality ? {} : { temporality: false }),
  };
}

/**
 * The fixture's frame. It is the **question**, not the sentence, and that is deliberate: `assemble` renders
 * the frame line into the block, and a fixture that fed the original sentence there would let the rendered
 * size depend on prose nobody measured. Nothing in the decision path reads it.
 */
function caseFrame(entry: Case): KnowledgeFrame {
  return { id: `case:${entry.id}`, text: entry.query, speaker: 'user', at: NOW };
}

export type Resolution = {
  readonly answer: string | null;
  readonly reason:
    'latest' | 'windowed' | 'none-in-window' | 'all-retired' | 'conflict' | 'unplaceable';
  /**
   * `1` when the fact that answered had been retired.
   *
   * Read off the penalty `assemble` attached, not recomputed here: the point of the number is that it is the
   * product's own report of why the fact was discounted, and a second implementation of "is it retired"
   * would be free to disagree with the first.
   */
  readonly servedRetired: number;
  readonly census: AssembleCensus;
};

/** Say which filter took everything, in the order the filters act. */
function reasonOf(entry: Case, result: ReturnType<typeof assemble>): Resolution['reason'] {
  const top = result.served[0];
  if (top !== undefined)
    return top.conflict ? 'conflict' : entry.asOf === undefined ? 'latest' : 'windowed';
  const excluded = result.census.excluded;
  if ((excluded['after-as-of'] ?? 0) > 0) return 'none-in-window';
  const blocked =
    (excluded.refuted ?? 0) +
    (excluded.stale ?? 0) +
    (excluded['unfulfilled-plan'] ?? 0) +
    (excluded.abandoned ?? 0);
  if (blocked > 0) return 'all-retired';
  return 'unplaceable';
}

/**
 * Answer one case under one arm — by calling the code the product calls.
 *
 * The only thing this function adds to `assemble` is the two translations a measurement needs: a question
 * becomes a ranked list (lexical overlap, because a real retriever here would be measuring the retriever),
 * and a served fact becomes an answer (with `null` when the top of the list is a live contradiction, since
 * choosing between two values that claim one instant is the one thing the ledger refuses to do).
 */
export function resolve(entry: Case, arm: Arm, ablation: Ablation = FULL): Resolution {
  // The candidate set is the slot the fixture is about. Deciding *what is relevant* is the retriever's job
  // and is measured elsewhere; handing every fact to `assemble` here would make the arms differ by how good
  // a lexical overlap is at ignoring a fact about a different attribute, which is not the question.
  const key = slotKey(entry.slot.subject, entry.slot.predicate);
  const onSlot = entry.facts.filter(
    (fact) =>
      fact.subject !== undefined &&
      fact.predicate !== undefined &&
      slotKey(fact.subject, fact.predicate) === key,
  );

  const result = assemble({
    unit: { frame: caseFrame(entry), facts: entry.facts, edges: [], unresolved: [] },
    ranked: onSlot.map((fact) => ({ factId: fact.id, score: overlap(entry.query, fact.text) })),
    now: NOW,
    intent: entry.intent ?? 'fact',
    ...(entry.asOf === undefined ? {} : { asOf: entry.asOf }),
    policy: policyFor(arm, ablation),
  });

  const top = result.served[0];
  return {
    answer: top === undefined || top.conflict ? null : top.factId,
    reason: reasonOf(entry, result),
    // `factor === 0` is the whole definition: `aged` is a discount and a discount is still an answer.
    servedRetired:
      top !== undefined && entry.asOf === undefined && top.penalty.factor === 0 ? 1 : 0,
    census: result.census,
  };
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
  readonly removed:
    | 'none'
    | 'persistence'
    | 'uniqueness'
    | 'time-anchor'
    | 'cascade'
    | 'temporality'
    | 'lapse'
    | 'fulfil'
    | 'immutability';
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
  temporality: ['plan', 'immutable'],
  lapse: ['plan'],
  fulfil: ['plan'],
  immutability: ['immutable'],
};

/**
 * The full ablation table, with the "nothing removed" row first.
 *
 * The cases are rebuilt per row: `cascade` acts at ingestion, so removing it changes the ledger rather than
 * only the score. Rebuilding is cheap here (a dozen cases) and keeps one definition of a case.
 */
export function ablate(): readonly AblationRow[] {
  const rows: AblationRow[] = [];
  for (const removed of [
    'none',
    'persistence',
    'uniqueness',
    'time-anchor',
    'cascade',
    'temporality',
    'lapse',
    'fulfil',
    'immutability',
  ] as const) {
    const cases = buildCases({
      cascade: removed !== 'cascade',
      immutability: removed !== 'immutability',
      fulfil: removed !== 'fulfil',
      lapse: removed !== 'lapse',
      // Reading the axis is a property of ingestion, so removing it has to change what was built — not only
      // what the arm does with it. Otherwise the ablation measures a filter and not the capability.
      temporality: removed !== 'temporality',
    });
    let ablation = FULL;
    if (removed === 'persistence') ablation = { ...ablation, persistence: false };
    if (removed === 'uniqueness') ablation = { ...ablation, uniqueness: false };
    if (removed === 'time-anchor') ablation = { ...ablation, timeAnchor: false };
    if (removed === 'cascade') ablation = { ...ablation, cascade: false };
    if (removed === 'temporality') ablation = { ...ablation, temporality: false };
    if (removed === 'lapse') ablation = { ...ablation, lapse: false };
    if (removed === 'fulfil') ablation = { ...ablation, fulfil: false };
    if (removed === 'immutability') ablation = { ...ablation, immutability: false };
    const report = scoreArm(cases, 'gated', ablation);
    rows.push({ removed, accuracy: report.accuracy, byFamily: report.byFamily });
  }
  return rows;
}

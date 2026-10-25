/**
 * What a fact had to assume in order to be stored at all.
 *
 * ## The problem this is not solving
 *
 * A fact with no time is still stored — that has been true since `KnowledgeFact.at` became optional.
 * The question this module answers is the next one: *what was taken for granted* to store it that way,
 * and can that thing be revisited later. Today the answer is "the ingestion time, implicitly, and no".
 *
 * ## Why an assumption and not a confidence score
 *
 * A confidence score is a number nothing calibrates; this repository has refused one twice already
 * (`proposer.ts`, and the `withheld` count that replaced it). The nearest published evidence agrees for a
 * sharper reason: reliability estimated from the text is **manipulable**, and capping trust by provenance
 * rather than by self-reported confidence is what survived a poisoning experiment (arXiv 2606.22030).
 *
 * So an assumption has no probability. It has a **name**, an **origin that can be recomputed**, two
 * integer counts of observations, and a status. Anyone holding the frames can recount the integers; nobody
 * can recount a 0.82.
 *
 * ## Why these six, and which three matter
 *
 * Three are load-bearing, and each answers a different question a stored fact can be wrong about:
 *
 * | Assumption | The question it answers | What it costs when wrong |
 * | --- | --- | --- |
 * | `time-anchor` | *when* was this so | a fact dated to the day it was mentioned reads as current |
 * | `persistence` | *whether* it is still so | a superseded fact keeps answering |
 * | `uniqueness` | *how many* values the slot has | an update is stored as a contradiction |
 *
 * The other three exist because leaving them out would make the ledger a lie by omission: a fact whose
 * pronoun was bound to a guess is **more** assumption-carrying than one that was not, and a fact that
 * counts a set is asserting the set is complete.
 *
 * ## What is deliberately not here
 *
 * No `confidence`, no free-form `reason`, and no assumption whose origin cannot be recomputed from the
 * frame. The last rule is the same one that governs `evidenceSpan` in `edge.ts`: an unlocatable premise
 * is an invention wearing a citation.
 */

import type { KnowledgeFact, KnowledgeFrame } from './frame.js';

/** What kind of thing was taken for granted. Closed set; a seventh kind is a design change. */
export type AssumptionKind =
  /**
   * The fact names no time, so it is anchored to when the frame was said.
   *
   * This is ISO-TimeML's document-creation-time rule applied to a conversation: when a text gives no
   * temporal anchor, the time the text was produced is the default one, and the annotation says so
   * explicitly (`anchorTimeID`) rather than leaving the reader to infer it.
   */
  | 'time-anchor'
  /** The fact states no end, so it is assumed to still hold. The single most consequential assumption. */
  | 'persistence'
  /** The slot is assumed to hold one value, which is what makes a second value an update rather than a second fact. */
  | 'uniqueness'
  /** Who the fact belongs to. Absent, a fact asserted by one speaker can be read as another's. */
  | 'attribution'
  /** A word in the fact came from context, and was bound to that source. */
  | 'entity-binding'
  /** An enumeration was assumed complete. */
  | 'completeness';

/** Where an assumption came from. Every value is recomputable from the fact and its frame. */
export type AssumptionOrigin =
  | 'ingestion-time'
  | 'no-bounded-interval'
  | 'single-value-slot'
  | 'speaker'
  | 'borrowed-reference'
  | 'enumeration-count';

/**
 * Where an assumption is in its life.
 *
 * `expired` is not `refuted`, and the distinction is the difference between forgetting and lying: an
 * untested persistence assumption is not disproven by the passage of time, it is merely no longer
 * evidenced. Collapsing the two would delete true facts on a timer.
 */
export type AssumptionStatus = 'open' | 'confirmed' | 'refuted' | 'expired';

/** One thing a fact took for granted. */
export type Assumption = {
  readonly kind: AssumptionKind;
  readonly origin: AssumptionOrigin;
  /** A canonical string, so two assumptions about the same thing compare equal without a deep compare. */
  readonly value: string;
  readonly status: AssumptionStatus;
  /** How many observed frames have agreed with it. An integer, not a probability. */
  readonly support: number;
  /** How many have contradicted it. */
  readonly contradict: number;
  /** When the assumption was recorded, epoch ms. */
  readonly openedAt: number;
};

const ZERO = { support: 0, contradict: 0 } as const;

function make(
  kind: AssumptionKind,
  origin: AssumptionOrigin,
  value: string,
  at: number,
): Assumption {
  return { kind, origin, value, status: 'open', ...ZERO, openedAt: at };
}

/**
 * Every assumption this fact rests on, derived — never reported by a model.
 *
 * The function is total over its inputs and deterministic: the same fact and frame always produce the
 * same ledger in the same order, which is what makes a diff between two exports show only real change.
 *
 * Three cases produce **nothing**, and each is deliberate:
 *
 * - No `time-anchor` when neither the fact nor the frame carries a time. There is no anchor to assume,
 *   and inventing the epoch would be worse than admitting the gap.
 * - No `uniqueness` when the fact names no subject or predicate. A slot that was never identified cannot
 *   be assumed single-valued.
 * - No `completeness` unless the fact carries a count. Guessing a count from a numeral in the text would
 *   turn "I have 2 meetings and 3 calls" into two completeness claims about different sets.
 */
export function deriveAssumptions(
  fact: KnowledgeFact,
  frame: KnowledgeFrame,
): readonly Assumption[] {
  const openedAt = frame.at ?? 0;
  const derived: Assumption[] = [make('persistence', 'no-bounded-interval', 'true', openedAt)];

  if (fact.at === undefined && frame.at !== undefined) {
    derived.push(make('time-anchor', 'ingestion-time', String(frame.at), openedAt));
  }
  if (fact.subject !== undefined && fact.predicate !== undefined) {
    derived.push(
      make('uniqueness', 'single-value-slot', slotKey(fact.subject, fact.predicate), openedAt),
    );
  }
  if (frame.speaker !== undefined) {
    derived.push(make('attribution', 'speaker', frame.speaker, openedAt));
  }
  for (const reference of fact.references) {
    derived.push(
      make(
        'entity-binding',
        'borrowed-reference',
        `${reference.token.toLowerCase()}@${reference.sourceId}`,
        openedAt,
      ),
    );
  }
  if (fact.count !== undefined) {
    derived.push(make('completeness', 'enumeration-count', String(fact.count), openedAt));
  }

  return derived;
}

/** The canonical key of a slot. Folded, so two spellings of one slot are one slot. */
export function slotKey(subject: string, predicate: string): string {
  return `${subject.trim().toLowerCase()}\u0000${predicate.trim().toLowerCase()}`;
}

/** The assumption of one kind, or `undefined`. */
export function assumptionOf(fact: KnowledgeFact, kind: AssumptionKind): Assumption | undefined {
  return fact.assumptions?.find((assumption) => assumption.kind === kind);
}

/** Whether the fact still answers: no refuted `persistence`, and not marked stale. */
export function isAnswerable(fact: KnowledgeFact): boolean {
  if (fact.stale === true) return false;
  const persistence = assumptionOf(fact, 'persistence');
  return persistence === undefined || persistence.status !== 'refuted';
}

export type PenaltyOptions = {
  /** How long an `open` persistence assumption stays evidenced before it is discounted. */
  readonly ttlMs?: number;
  /**
   * What an over-age fact is multiplied by. Half is a product choice, not a measured value: the point is
   * that it is strictly less than one, so a stale fact loses to a current one on rank rather than being
   * silently dropped. Dropping is reserved for `refuted`, where the world has actually said otherwise.
   */
  readonly discount?: number;
};

/** A factor in `(0, 1]` for the ranking, and the reason, so a report can count the reasons. */
export type Penalty = {
  readonly factor: number;
  readonly reason: 'answerable' | 'refuted' | 'aged' | 'stale';
};

/** The same default the card queue uses for "is this still true", so two clocks do not disagree. */
const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * How much a fact's ranking should be discounted, and why.
 *
 * The three outcomes are deliberately different behaviours rather than three multipliers:
 *
 * - **`refuted`** is `0`. The world has contradicted the fact; it must not answer the default question.
 *   It stays in the store and still answers a **historical** question, which is the property PACMI
 *   measured as the difference between 1.00 and 0.36.
 * - **`aged`** is a discount, never a drop. An untested fact is not a false one.
 * - **`stale`** (cascaded from a refuted premise) is `0`, because the premise it rests on is gone.
 */
export function assumptionPenalty(
  fact: KnowledgeFact,
  now: number,
  options: PenaltyOptions = {},
): Penalty {
  if (fact.stale === true) return { factor: 0, reason: 'stale' };

  const persistence = assumptionOf(fact, 'persistence');
  if (persistence === undefined) return { factor: 1, reason: 'answerable' };
  if (persistence.status === 'refuted') return { factor: 0, reason: 'refuted' };

  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const discount = options.discount ?? 0.5;
  if (persistence.status === 'expired' || now - persistence.openedAt > ttl) {
    return { factor: discount, reason: 'aged' };
  }
  return { factor: 1, reason: 'answerable' };
}

/**
 * The one-line rendering of a fact's assumptions, for the block a reader receives.
 *
 * Empty when the fact rests on nothing but `persistence` and that assumption is open: printing
 * "assumed: it is still true" on every fact would make the line noise and train a reader to skip it.
 */
export function describeAssumptions(fact: KnowledgeFact): string {
  const shown: string[] = [];
  for (const assumption of fact.assumptions ?? []) {
    switch (assumption.kind) {
      case 'persistence':
        // Open is the unremarkable state and printing it on every fact would train a reader to skip the
        // line. `refuted` and `expired` both change how the fact must be read, so both are shown.
        if (assumption.status !== 'open') shown.push(assumption.status);
        break;
      case 'time-anchor':
        shown.push(
          `when = ${new Date(Number(assumption.value)).toISOString().slice(0, 10)} (assumed)`,
        );
        break;
      case 'uniqueness':
        // Only when the slot turned out *not* to be single-valued. An open uniqueness is the normal case
        // and says nothing a reader needs; a refuted one means two facts disagree and neither wins.
        if (assumption.status === 'refuted') shown.push('slot has conflicting values');
        break;
      case 'completeness':
        shown.push(`count = ${assumption.value} (assumed complete)`);
        break;
      // `attribution` and `entity-binding` are deliberately silent. Both are recoverable from the export
      // (`frame.speaker`, `fact.references`) and neither changes how the fact is read; printing them on
      // every line is the kind of detail that makes the two lines that matter invisible.
      default:
        break;
    }
  }
  return shown.join('; ');
}

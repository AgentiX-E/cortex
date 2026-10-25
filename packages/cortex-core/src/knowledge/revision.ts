/**
 * Revision: what later evidence does to an earlier assumption.
 *
 * ## Why this is separate from `edge.ts`
 *
 * `deriveSupersedes` answers "which fact replaced which" and emits an edge. This module answers a
 * different question — "which *assumption* did that replacement refute" — and writes it back onto the
 * fact. The two share one definition of a slot (`slotKey`) and one ordering rule, because a system where
 * an edge says "B replaced A" while A's persistence says "still open" contradicts itself in a way no
 * reader can resolve.
 *
 * ## The three verdicts, and the one that is not a verdict
 *
 * | Situation | Verdict | Effect |
 * | --- | --- | --- |
 * | a later fact on the same slot with a **different** value or polarity | `refuted` on the earlier `persistence` | the earlier fact stops answering the default question, and keeps answering a historical one |
 * | a later fact on the same slot with the **same** value | `confirmed` on both `persistence` | the assumption gains support without changing state |
 * | two facts on one slot **at the same time** with different values | `refuted` on `uniqueness` | this is not an update, it is a contradiction: the slot is not single-valued, or one of the two is wrong |
 *
 * The third row is the one worth stating twice. A system that treats every same-slot disagreement as an
 * update silently picks the last one and calls it truth; that is right for "I moved to Berlin" and wrong
 * for "my birthday is in March" against "my birthday is in April". `uniqueness` refutation is how the
 * ledger says "I do not know which of these is right" rather than inventing an answer.
 *
 * ## The cascade, and the published reason it is off by default
 *
 * A fact whose premise was refuted is `stale`. The premise link is the fact's own `references` — the same
 * receipt that `grounding.ts` requires for a borrowed word — so the chain exists because the system
 * recorded it, not because a benchmark supplied it. That is PACMI's gap (arXiv 2610.05732 states it does
 * "not solve open-ended provenance extraction" and evaluates "conditional on derivation links being
 * represented or supplied"), and closing it is the only claim this module makes about cascading.
 *
 * It ships **off**. PACMI's own ablation moved 3 errors to 11 when the cascade was removed and did not
 * reach significance (p = 0.0574), so a mechanism that size must be measurable in both states rather than
 * assumed to pay.
 */

import { deriveSupersedes, type KnowledgeEdge } from './edge.js';
import type { KnowledgeFact } from './frame.js';
import {
  assumptionOf,
  slotKey,
  type Assumption,
  type AssumptionKind,
  type AssumptionStatus,
} from './assumption.js';

/** What a revision did to one assumption. */
export type RevisionVerdict = 'confirmed' | 'refuted';

/** One change, recorded so an export can answer "why is this fact no longer answering?". */
export type Revision = {
  readonly factId: string;
  readonly kind: AssumptionKind;
  readonly verdict: RevisionVerdict;
  /** The fact whose arrival caused the verdict. */
  readonly byFactId: string;
  readonly detail: string;
};

export type RevisionOptions = {
  /** Edges to read. When absent, `deriveSupersedes` is called over the facts. */
  readonly edges?: readonly KnowledgeEdge[];
  /** Whether a refuted premise propagates. Off by default — see the module comment. */
  readonly cascade?: boolean;
  /**
   * `[newerId, olderId]` pairs declaring that the newer fact makes the older one meaningless.
   *
   * This is STALE's Type II conflict: the upstream attribute changed and the downstream fact was never
   * mentioned again, so no same-slot disagreement exists to be noticed. Detecting it from text is a
   * research problem; **recording** it, once somebody or something has said so, is bookkeeping — and PACMI
   * draws exactly this line, evaluating "conditional on derivation links being represented or supplied".
   *
   * Declared invalidations go through the same `record` call as derived ones, on purpose: two paths that
   * wrote `refuted` differently would be two semantics for one word.
   */
  readonly invalidations?: readonly (readonly [string, string])[];
};

export type RevisionResult = {
  readonly facts: readonly KnowledgeFact[];
  readonly revisions: readonly Revision[];
  /** Ids marked stale by a cascade. Empty when the cascade is off, always. */
  readonly stale: readonly string[];
};

function statusFor(verdict: RevisionVerdict): AssumptionStatus {
  return verdict === 'refuted' ? 'refuted' : 'confirmed';
}

/** Rewrite one assumption on a fact, counting the observation. A fact without that kind is untouched. */
function apply(fact: KnowledgeFact, kind: AssumptionKind, verdict: RevisionVerdict): KnowledgeFact {
  const list = fact.assumptions ?? [];
  if (!list.some((assumption) => assumption.kind === kind)) return fact;
  const next: Assumption[] = list.map((assumption) =>
    assumption.kind === kind
      ? {
          ...assumption,
          status: statusFor(verdict),
          support: assumption.support + (verdict === 'confirmed' ? 1 : 0),
          contradict: assumption.contradict + (verdict === 'refuted' ? 1 : 0),
        }
      : assumption,
  );
  return { ...fact, assumptions: next };
}

/**
 * Apply later evidence to the ledger.
 *
 * Deterministic: the input facts are sorted by `(slot, at, id)` before anything happens, so a caller's
 * order cannot change the result. That property is what makes two runs over one corpus comparable at all.
 */
export function reviseLedger(
  facts: readonly KnowledgeFact[],
  options: RevisionOptions = {},
): RevisionResult {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const revisions: Revision[] = [];

  const record = (
    factId: string,
    kind: AssumptionKind,
    verdict: RevisionVerdict,
    byFactId: string,
    detail: string,
  ): void => {
    const current = byId.get(factId);
    // Narrowed by the caller, which only names ids taken from this map.
    byId.set(factId, apply(current!, kind, verdict));
    revisions.push({ factId, kind, verdict, byFactId, detail });
  };

  const edges = options.edges ?? deriveSupersedes(facts);

  for (const edge of edges) {
    if (edge.type !== 'supersedes') continue;
    const newer = byId.get(edge.from);
    const older = byId.get(edge.to);
    if (newer === undefined || older === undefined) continue;

    record(
      older.id,
      'persistence',
      'refuted',
      newer.id,
      `superseded by ${JSON.stringify(newer.text)}`,
    );
    record(
      newer.id,
      'persistence',
      'confirmed',
      older.id,
      `replaces ${JSON.stringify(older.text)}`,
    );
    record(newer.id, 'uniqueness', 'confirmed', older.id, 'the slot holds a newer value');
    // An anchor that an explicit time has now overruled is no longer an anchor.
    if (assumptionOf(older, 'time-anchor') !== undefined && newer.at !== undefined) {
      record(
        older.id,
        'time-anchor',
        'refuted',
        newer.id,
        'a later fact states the time explicitly',
      );
    }
  }

  // Declared invalidations, before the derived agreement pass so a declared refutation is never overturned
  // by a later "these two agree" observation about unrelated facts.
  //
  // Only a fact that is *later* can invalidate an earlier one. A declaration pointing backwards is a caller
  // bug, and honouring it would let a fixture or an import decide the answer by asserting the impossible.
  for (const [newerId, olderId] of options.invalidations ?? []) {
    const newer = byId.get(newerId);
    const older = byId.get(olderId);
    if (newer === undefined || older === undefined) continue;
    const newerAt = newer.at;
    const olderAt = older.at;
    if (newerAt === undefined || olderAt === undefined || newerAt <= olderAt) continue;
    record(
      olderId,
      'persistence',
      'refuted',
      newerId,
      `declared meaningless by ${JSON.stringify(newer.text)}`,
    );
    if (assumptionOf(older, 'uniqueness') !== undefined) {
      record(olderId, 'uniqueness', 'refuted', newerId, 'the slot it described no longer holds');
    }
  }

  // Agreement: same slot, same value, no supersession between them. Support, not state change.
  const slots = groupBySlot([...byId.values()]);
  for (const group of slots.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const first = group[left]!;
        const second = group[right]!;
        if (!sameStatement(first, second)) continue;
        record(first.id, 'persistence', 'confirmed', second.id, 'a second observation agrees');
        record(second.id, 'persistence', 'confirmed', first.id, 'a second observation agrees');
      }
    }
  }

  // An anchor gives way to an explicit time on the same slot, even when no supersession edge exists: the
  // undated fact has no `at`, so `deriveSupersedes` never sees it, and yet the anchor is exactly what the
  // explicit time overrules. Without this pass the ledger would keep a guess that a later frame has
  // already replaced with a fact.
  for (const group of slots.values()) {
    const dated = group.filter((fact) => fact.at !== undefined);
    if (dated.length === 0) continue;
    for (const fact of group) {
      if (fact.at !== undefined) continue;
      if (assumptionOf(fact, 'time-anchor') === undefined) continue;
      const witness = dated[dated.length - 1]!;
      record(
        fact.id,
        'time-anchor',
        'refuted',
        witness.id,
        'a fact on the same slot states the time explicitly',
      );
    }
  }

  // Contradiction at one instant: same slot, different value, same time. Not an update.
  for (const group of slots.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const first = group[left]!;
        const second = group[right]!;
        if (first.at === undefined || second.at === undefined) continue;
        if (first.at !== second.at || sameStatement(first, second)) continue;
        record(first.id, 'uniqueness', 'refuted', second.id, 'two values claim the same instant');
        record(second.id, 'uniqueness', 'refuted', first.id, 'two values claim the same instant');
      }
    }
  }

  const revised = [...byId.values()];
  if (options.cascade !== true) {
    return { facts: revised, revisions, stale: [] };
  }

  const stale = cascade(revised);
  const flagged = revised.map((fact) => (stale.has(fact.id) ? { ...fact, stale: true } : fact));
  return { facts: flagged, revisions, stale: [...stale].sort() };
}

/** `subject\u0000predicate`, folded. A fact without both is in no slot and takes part in nothing. */
function groupBySlot(facts: readonly KnowledgeFact[]): Map<string, KnowledgeFact[]> {
  const groups = new Map<string, KnowledgeFact[]>();
  for (const fact of facts) {
    if (fact.subject === undefined || fact.predicate === undefined) continue;
    const key = slotKey(fact.subject, fact.predicate);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [fact]);
      continue;
    }
    group.push(fact);
    // Sorted at insertion-complete time rather than trusted from the caller: `at` first, then id, so a
    // missing time sorts before any time (the anchor case) without a special arm.
    group.sort((left, right) => {
      const leftAt = left.at ?? Number.NEGATIVE_INFINITY;
      const rightAt = right.at ?? Number.NEGATIVE_INFINITY;
      if (leftAt !== rightAt) return leftAt - rightAt;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }
  return groups;
}

/** Whether two facts assert the same thing, folded. Polarity is part of the statement. */
function sameStatement(first: KnowledgeFact, second: KnowledgeFact): boolean {
  return (
    first.text.trim().toLowerCase() === second.text.trim().toLowerCase() &&
    first.polarity === second.polarity
  );
}

/**
 * Everything downstream of a refuted premise, transitively.
 *
 * A fact is downstream when one of its `entity-binding` assumptions borrowed from the **frame** the
 * refuted fact belongs to: the receipt says which turn the word came from, so the dependency is a stored
 * fact rather than an inferred one. Iterated to a fixed point, because a stale fact can itself be the
 * premise of another — and bounded by the number of facts, since each pass can only add.
 */
function cascade(facts: readonly KnowledgeFact[]): Set<string> {
  const refutedFrames = new Set<string>();
  for (const fact of facts) {
    if (assumptionOf(fact, 'persistence')?.status === 'refuted') refutedFrames.add(fact.frameId);
  }

  const stale = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fact of facts) {
      if (stale.has(fact.id)) continue;
      const bindings = (fact.assumptions ?? []).filter(
        (assumption) => assumption.kind === 'entity-binding',
      );
      const restsOnRefuted = bindings.some((assumption) => {
        const sourceId = assumption.value.split('@')[1];
        return sourceId !== undefined && refutedFrames.has(sourceId);
      });
      if (!restsOnRefuted) continue;
      stale.add(fact.id);
      refutedFrames.add(fact.frameId);
      changed = true;
    }
  }
  return stale;
}

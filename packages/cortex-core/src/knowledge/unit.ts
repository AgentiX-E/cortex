/**
 * Assembly, and the four gates that decide whether a split was faithful.
 *
 * ## The one rule this file exists to enforce
 *
 * > A relation the sentence states must be **represented**, or the split is refused.
 *
 * "Represented" has exactly three accepted shapes, and the third is a fallback rather than a target:
 *
 * 1. An **extracted edge** whose marker is in the sentence and whose span covers it.
 * 2. A **relational fact**: the relation is the claim itself. `g04` — "Online communities **help me**
 *    learn new techniques" — is the reviewed example, and it is the shape the design wants more of.
 * 3. The marker stays inside the fact it scopes, and the fact it does *not* connect is absent. This is
 *    honest for `g18` ("I watch Brooklyn Nine-Nine **during** my lunch break" — one fact, one marker,
 *    nothing left dangling) and dishonest for `g06`, where `before` sits in one of two atoms and says
 *    nothing about the other.
 *
 * The gate distinguishes 3 from a dangling marker by asking a different question than the census did:
 * not "does the token survive anywhere" but "does every marker belong to a fact whose text contains
 * it". A marker inside a fact is scoped; a marker that survives in no fact and licenses no edge is
 * lost, and that is what `unresolved` lists.
 *
 * ## Why the gate can be strict without being useless
 *
 * Because it is aimed at the **proposer**, not at the person. `policy: 'record'` exists for the
 * migration path — the first v6 run will show how often a model produces an edge at all, and a gate
 * that refused every old proposal would make that reading impossible. The shipping path is `strict`,
 * and the strictness is affordable precisely because the failure is cheap: a refused split leaves the
 * person's own sentence on the card, which is what the card showed before proposals existed.
 *
 * ## Fail-closed, for the same reason `proposalFailure` is
 *
 * Every problem returns `{ok: false}` with nothing to attach. A unit that assembled "the facts that
 * passed" would publish a set whose missing member is exactly the relation the review complained
 * about, and nothing downstream would be able to tell that from a sentence that had no relation.
 */

import { contentGroundedIn, type BorrowedWord, type GroundingSource } from '../triage/grounding.js';
import { checkEdge, type EdgeProblem, type KnowledgeEdge } from './edge.js';
import { checkFact, type FactProblem, type KnowledgeFact, type KnowledgeFrame } from './frame.js';
import { relationMarkers, type RelationMarker } from './markers.js';
import { isEdgeType, type EdgeType, type FactType } from './taxonomy.js';

/** Whether an unresolved marker is refused (`strict`) or reported (`record`). */
export type MarkerPolicy = 'strict' | 'record';

/** A frame, the facts read off it, and the links between them. The unit of storage and of audit. */
export type KnowledgeUnit = {
  readonly frame: KnowledgeFrame;
  readonly facts: readonly KnowledgeFact[];
  readonly edges: readonly KnowledgeEdge[];
  /**
   * Markers the sentence states that no fact scoped and no edge licensed.
   *
   * Empty on any unit that passed `strict`. Non-empty under `record` is a **reading**, not a pass: it
   * is the count of relations this split destroyed, and it is the number the next prompt revision is
   * aimed at.
   */
  readonly unresolved: readonly RelationMarker[];
};

/** Why a unit was refused. */
export type UnitProblem =
  | { readonly problem: 'fact'; readonly detail: FactProblem }
  | { readonly problem: 'edge'; readonly detail: EdgeProblem }
  | { readonly problem: 'ungrounded'; readonly detail: string }
  | { readonly problem: 'unrecorded-borrowing'; readonly detail: string }
  | { readonly problem: 'unresolved-marker'; readonly detail: string }
  | { readonly problem: 'duplicate-id'; readonly detail: string };

export type UnitResult =
  | { readonly ok: true; readonly unit: KnowledgeUnit }
  | { readonly ok: false; readonly problem: UnitProblem };

export type BuildUnitInput = {
  readonly frame: KnowledgeFrame;
  readonly facts: readonly KnowledgeFact[];
  readonly edges: readonly KnowledgeEdge[];
  /**
   * The frames this one may refer to, oldest first.
   *
   * A fact may borrow a word from one of these and must record the borrowing. Nothing else may widen
   * the grounding set: a caller that passes the whole session as one source has removed the audit
   * property that makes borrowing acceptable, and the `references` check below is what notices.
   */
  readonly context?: readonly KnowledgeFrame[];
  readonly policy?: MarkerPolicy;
};

/** Compare a recorded borrowing against the one grounding actually performed. */
function sameBorrowing(recorded: readonly BorrowedWord[], found: readonly BorrowedWord[]): boolean {
  const shape = (words: readonly BorrowedWord[]): string =>
    [...words]
      .map((word) => `${word.token.toLowerCase()}\u0000${word.sourceId}`)
      .sort()
      .join('\u0001');
  return shape(recorded) === shape(found);
}

/** Whether some fact's own text carries the marker, which scopes it to that fact. */
function foldedInto(marker: RelationMarker, facts: readonly KnowledgeFact[]): boolean {
  const token = marker.token.toLowerCase();
  return facts.some((fact) => {
    const text = ` ${fact.text.toLowerCase().replace(/[^a-z0-9' ]/g, ' ')} `;
    return text.includes(` ${token} `);
  });
}

/**
 * Assemble a unit, or refuse it.
 *
 * Order matters: facts are checked before edges, because an edge's endpoints are facts and every
 * failure below is more informative than the one after it.
 */
export function buildKnowledgeUnit(input: BuildUnitInput): UnitResult {
  const { frame, facts, edges } = input;
  const policy = input.policy ?? 'strict';
  const context = input.context ?? [];

  const seen = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.id)) {
      return {
        ok: false,
        problem: {
          problem: 'duplicate-id',
          detail: `two facts share id ${JSON.stringify(fact.id)}`,
        },
      };
    }
    seen.add(fact.id);
  }

  const sources: GroundingSource[] = [
    { id: frame.id, text: frame.text },
    ...context.map((each) => ({ id: each.id, text: each.text })),
  ];

  for (const fact of facts) {
    const problem = checkFact(fact, frame);
    if (problem !== null) return { ok: false, problem: { problem: 'fact', detail: problem } };

    const grounding = contentGroundedIn(fact.text, sources);
    if (!grounding.ok) {
      return {
        ok: false,
        problem: {
          problem: 'ungrounded',
          detail: `fact ${JSON.stringify(fact.id)} is not grounded: ${grounding.problem} (${grounding.detail})`,
        },
      };
    }
    if (!sameBorrowing(fact.references, grounding.borrowed)) {
      return {
        ok: false,
        problem: {
          problem: 'unrecorded-borrowing',
          detail:
            `fact ${JSON.stringify(fact.id)} borrowed ${JSON.stringify(grounding.borrowed.map((word) => word.token))} ` +
            `but recorded ${JSON.stringify(fact.references.map((word) => word.token))}`,
        },
      };
    }
  }

  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      return {
        ok: false,
        problem: {
          problem: 'duplicate-id',
          detail: `two edges share id ${JSON.stringify(edge.id)}`,
        },
      };
    }
    edgeIds.add(edge.id);
    const problem = checkEdge(edge, { frame, facts: byId });
    if (problem !== null) return { ok: false, problem: { problem: 'edge', detail: problem } };
  }

  const licensed = new Set(
    edges
      .filter((edge): edge is KnowledgeEdge & { marker: string } => edge.marker !== undefined)
      .map((edge) => edge.marker.toLowerCase()),
  );
  const unclaimed = relationMarkers(frame.text).filter(
    (marker) => !licensed.has(marker.token.toLowerCase()) && !foldedInto(marker, facts),
  );

  // A relational fact expresses a relation **without** keeping the connective: `g04`'s "Online
  // communities help me learn" states the causal link in the claim itself, which is the better output
  // and must not be punished for lacking an edge it does not need. Each such fact discharges one
  // marker, and no more: a sentence with two connectives and one relational fact has still lost one.
  //
  // Which marker a given relational fact discharges is not knowable from the text -- the fact names
  // the relation, not the token -- so the earliest unclaimed marker is taken. The choice only affects
  // which token is reported as lost when there are more markers than facts, and in that case something
  // is lost whichever one is named.
  const relational = facts.filter((fact) => fact.type === 'relation').length;
  const unresolved = unclaimed.slice(relational);

  if (unresolved.length > 0 && policy === 'strict') {
    const first = unresolved[0]!;
    return {
      ok: false,
      problem: {
        problem: 'unresolved-marker',
        detail:
          `the sentence states ${JSON.stringify(first.token)} (${first.kind}) but no fact carries it and no ` +
          `edge licenses it; ${unresolved.length} marker(s) unresolved`,
      },
    };
  }

  return { ok: true, unit: { frame, facts, edges, unresolved } };
}

/** What a unit contains, counted. Used by reports; never by a gate. */
export type UnitCensus = {
  readonly facts: number;
  readonly edges: number;
  readonly factsByType: Readonly<Partial<Record<FactType, number>>>;
  readonly edgesByType: Readonly<Partial<Record<EdgeType, number>>>;
  readonly unresolved: number;
};

/**
 * Count a unit's contents.
 *
 * Types are counted through the closed sets rather than over the values present, so a report shows the
 * same rows for every unit and two units can be compared by eye. A type with no members is absent from
 * the object rather than present as zero: the caller decides how to render "none", and a zero that is
 * always there is a row nobody reads.
 */
export function censusOf(unit: KnowledgeUnit): UnitCensus {
  const factsByType: Partial<Record<FactType, number>> = {};
  for (const fact of unit.facts) {
    factsByType[fact.type] = (factsByType[fact.type] ?? 0) + 1;
  }
  const edgesByType: Partial<Record<EdgeType, number>> = {};
  for (const edge of unit.edges) {
    if (!isEdgeType(edge.type)) continue;
    edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1;
  }
  return {
    facts: unit.facts.length,
    edges: unit.edges.length,
    factsByType,
    edgesByType,
    unresolved: unit.unresolved.length,
  };
}

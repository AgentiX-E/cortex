/**
 * The link between two facts, and the three things that must be true before it may exist.
 *
 * ## The rules, and the failure each one stops
 *
 * 1. **A link is either read or computed, never suggested.** `origin: 'extracted'` means a connective
 *    in the sentence licensed it; `origin: 'derived'` means structured fields produced it. There is no
 *    third origin, and in particular there is no "the model thought these were related" — that is the
 *    similarity edge, which the only controlled comparison we have measures as **worse than a flat
 *    index** (arXiv 2601.01280: SimGraph below the flat baseline on both LongMemEval subsets).
 * 2. **An extracted link carries a marker that licenses its type.** `then` cannot produce `causes`.
 *    The licence table lives in `taxonomy.ts`; this file only enforces it. This is the causal
 *    hallucination gate.
 * 3. **An extracted link carries a span that covers its own marker.** A link whose evidence cannot be
 *    located is an assertion about the person's sentence that the sentence does not support — and the
 *    export would show it as though it did.
 *
 * ## Why the marker is stored as a string as well as located
 *
 * Because the two answer different questions. A span says *where* in the sentence the evidence is (for
 * the export and for a human check). The token says *what* was read there (for the A/B: "did `so`
 * carry this, or `because`?"). Storing only the span makes the second question require re-parsing the
 * sentence, which is exactly the work that changes when the table changes.
 *
 * ## `supersedes`, and why it is derived from slots rather than from prose
 *
 * The known knowledge-update failure on record (`SOTA-BASELINE.md` §5) is a reader holding both
 * `25:50` and `27:12` and choosing the older one. The fix is not a better reader: it is knowing which
 * of the two replaced the other, and saying so at answer time. Two facts can only stand in that
 * relation when they talk about the same slot — same subject, same predicate — and when both carry a
 * time. A system that infers it from similar wording gets it wrong on every paraphrase, and a wrong
 * `supersedes` deletes a true fact from the answer, which is the worst possible trade.
 */

import { envelope, type Span } from './frame.js';
import {
  DERIVED_EDGE_TYPES,
  EXTRACTED_EDGE_TYPES,
  isEdgeType,
  licenceClassOf,
  licensedEdgeTypes,
  type EdgeType,
} from './taxonomy.js';
import { isMarkerOf, relationMarkers } from './markers.js';
import { isImmutable } from './temporality.js';
import type { KnowledgeFact, KnowledgeFrame } from './frame.js';

/** Where a link came from. There is no other category, on purpose — see rule 1. */
export type EdgeOrigin = 'extracted' | 'derived';

/**
 * A directed link between two facts in the same store.
 *
 * `id` is derived from the endpoints and the type (`<type>:<from>><to`) rather than random, so the
 * same link derived twice is the same row and a diff between two exports shows only real changes.
 */
export type KnowledgeEdge = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
  readonly origin: EdgeOrigin;
  /** The connective that licensed an extracted link. Absent on a derived one. */
  readonly marker?: string;
  /** Where the evidence is: covers the marker and both endpoints' spans. Absent on a derived link. */
  readonly evidenceSpan?: Span;
};

/** Why a link was refused. */
export type EdgeProblem =
  | { readonly problem: 'unknown-type'; readonly detail: string }
  | { readonly problem: 'self-loop'; readonly detail: string }
  | { readonly problem: 'unknown-endpoint'; readonly detail: string }
  | { readonly problem: 'missing-marker'; readonly detail: string }
  | { readonly problem: 'unlicensed-type'; readonly detail: string }
  | { readonly problem: 'marker-not-in-frame'; readonly detail: string }
  | { readonly problem: 'missing-span'; readonly detail: string }
  | { readonly problem: 'span-outside-frame'; readonly detail: string }
  | { readonly problem: 'span-not-covering-marker'; readonly detail: string }
  | { readonly problem: 'derived-type-extracted'; readonly detail: string };

/** The canonical id of a link, so the same link twice is one row. */
export function edgeId(type: EdgeType, from: string, to: string): string {
  return `${type}:${from}>${to}`;
}

/**
 * Check a link against the frame and the facts it claims to join.
 *
 * Returns the first problem rather than a list: every branch below is independently fatal, and a
 * caller that wants the count of refusals gets it by asking about each link once.
 */
export function checkEdge(
  edge: KnowledgeEdge,
  context: {
    readonly frame: KnowledgeFrame;
    readonly facts: ReadonlyMap<string, KnowledgeFact>;
  },
): EdgeProblem | null {
  if (!isEdgeType(edge.type)) {
    return {
      problem: 'unknown-type',
      detail: `edge ${JSON.stringify(edge.id)} has type ${JSON.stringify(edge.type)}`,
    };
  }
  if (edge.from === edge.to) {
    return {
      problem: 'self-loop',
      detail: `edge ${JSON.stringify(edge.id)} joins a fact to itself`,
    };
  }
  for (const endpoint of [edge.from, edge.to]) {
    if (!context.facts.has(endpoint)) {
      return {
        problem: 'unknown-endpoint',
        detail: `edge ${JSON.stringify(edge.id)} names ${JSON.stringify(endpoint)}, which is not a fact of this frame`,
      };
    }
  }

  if (edge.origin === 'derived') {
    if (!DERIVED_EDGE_TYPES.includes(edge.type)) {
      return {
        problem: 'unlicensed-type',
        detail: `edge ${JSON.stringify(edge.id)} is derived but its type ${JSON.stringify(edge.type)} is only ever read off a sentence`,
      };
    }
    return null;
  }

  if (!EXTRACTED_EDGE_TYPES.includes(edge.type)) {
    return {
      problem: 'derived-type-extracted',
      detail: `edge ${JSON.stringify(edge.id)} is extracted but its type ${JSON.stringify(edge.type)} is derived, never read`,
    };
  }

  const marker = edge.marker;
  if (marker === undefined || marker.trim() === '') {
    return {
      problem: 'missing-marker',
      detail: `edge ${JSON.stringify(edge.id)} claims to be extracted but names no connective`,
    };
  }

  const licence = licenceClassOf(edge.type);
  // Narrowed by `EXTRACTED_EDGE_TYPES` above: every extracted type is licensed by some class.
  if (licence === null || !isMarkerOf(marker, licence)) {
    return {
      problem: 'unlicensed-type',
      detail:
        `edge ${JSON.stringify(edge.id)} is ${edge.type}, which ${JSON.stringify(marker)} cannot license; ` +
        `${JSON.stringify(marker)} licenses ${JSON.stringify(licensedEdgeTypes(licence))}`,
    };
  }

  const located = relationMarkers(context.frame.text).find(
    (candidate) =>
      candidate.token.toLowerCase() === marker.trim().toLowerCase() && candidate.kind === licence,
  );
  if (located === undefined) {
    return {
      problem: 'marker-not-in-frame',
      detail: `edge ${JSON.stringify(edge.id)} names ${JSON.stringify(marker)}, which no sentence of frame ${JSON.stringify(context.frame.id)} contains as a connective`,
    };
  }

  const span = edge.evidenceSpan;
  if (span === undefined) {
    return {
      problem: 'missing-span',
      detail: `edge ${JSON.stringify(edge.id)} is extracted and carries no evidence span`,
    };
  }
  if (span.start < 0 || span.end > context.frame.text.length || span.start >= span.end) {
    return {
      problem: 'span-outside-frame',
      detail: `edge ${JSON.stringify(edge.id)} points at [${span.start}, ${span.end}) in a frame of ${context.frame.text.length} characters`,
    };
  }
  if (span.start > located.start || located.end > span.end) {
    return {
      problem: 'span-not-covering-marker',
      detail: `edge ${JSON.stringify(edge.id)} points at [${span.start}, ${span.end}) but its marker is at [${located.start}, ${located.end})`,
    };
  }

  return null;
}

/**
 * The link a proposal should carry: the span that covers both facts and the marker between them.
 *
 * Exported so a caller does not re-derive it differently. The envelope is wide on purpose; a narrow
 * span around the connective alone would be more precise and would fail to show *what* it connects.
 */
export function extractedSpan(from: Span, to: Span, marker: Span): Span {
  return envelope([from, to, marker]);
}

/**
 * Every `supersedes` link the facts support, computed and never guessed.
 *
 * A group is `(subject, predicate)` folded to lower case. Within a group, facts are ordered by `at`
 * and each fact supersedes the immediately preceding one **when their text differs**. Consequences of
 * that definition, all intended:
 *
 * - A fact with no `at`, or no `subject`/`predicate`, is in no group and supersedes nothing. Silence
 *   is not evidence of replacement.
 * - Two facts with identical text are the same statement recorded twice; no link.
 * - Two facts at the **same** time are not ordered, so no link: a tie broken by id would silently pick a
 *   winner between two contradictory values. `revision.ts` reports that case as a refuted `uniqueness`.
 * - Ordering is total because `at` is compared first and `id` breaks ties, so a run twice on the same
 *   input produces the same edges in the same order.
 * - The link is pairwise (each fact supersedes its predecessor), not all-pairs, because `supersedes`
 *   is transitive for the purpose it serves: the last member of the chain is current, and every earlier
 *   one is labelled with the one that replaced it.
 */
export function deriveSupersedes(facts: readonly KnowledgeFact[]): KnowledgeEdge[] {
  const groups = new Map<string, KnowledgeFact[]>();
  for (const fact of facts) {
    if (fact.subject === undefined || fact.predicate === undefined || fact.at === undefined)
      continue;
    const key = `${fact.subject.trim().toLowerCase()}\u0000${fact.predicate.trim().toLowerCase()}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [fact]);
    } else {
      group.push(fact);
    }
  }

  const edges: KnowledgeEdge[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => {
      // Narrowed by the filter above: every member of a group has a time.
      const delta = left.at! - right.at!;
      if (delta !== 0) return delta;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    for (let index = 1; index < ordered.length; index += 1) {
      const older = ordered[index - 1]!;
      const newer = ordered[index]!;
      if (older.text.trim().toLowerCase() === newer.text.trim().toLowerCase()) continue;
      // A settled event is not replaceable. Somebody going to Paris in March is not undone by them going to
      // Rome in June; superseding the first with the second is the system rewriting history to keep its
      // current answer tidy, and it is the one thing an "established fact" must be protected from.
      if (isImmutable(older)) continue;
      // Two values claiming the *same instant* are not an update: there is no order for `supersedes` to
      // express, and inventing one from the id would let a tie-break decide which of two contradictory
      // facts is current. That case is a refuted `uniqueness` (`revision.ts`), not a replacement.
      if (older.at === newer.at) continue;
      edges.push({
        id: edgeId('supersedes', newer.id, older.id),
        from: newer.id,
        to: older.id,
        type: 'supersedes',
        origin: 'derived',
      });
    }
  }
  return edges;
}

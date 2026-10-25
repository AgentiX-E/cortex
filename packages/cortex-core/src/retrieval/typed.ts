/**
 * Typed expansion over the edge set, and the three-line block the reader actually receives.
 *
 * ## The expansion rule, and the one it refuses
 *
 * Expansion follows edges that **assert a relation between two things**: causation, ordering, overlap,
 * condition, contrast, co-reference. It does **not** follow similarity, because there are no similarity
 * edges to follow, and it does not follow `supersedes`, because that link points at a fact that is no
 * longer true — wandering into it while answering "what is the current value" is how a reader ends up
 * quoting the superseded number, which is the exact failure already on record
 * (`SOTA-BASELINE.md` §5: both `25:50` and `27:12` in context, the older one chosen).
 *
 * A superseded fact is not hidden. It is retrievable if the question asks for it, and it is **labelled**
 * when it is served. The distinction between "do not traverse into it" and "do not show it" is the whole
 * design: traversal decides what a question reaches by default; labelling decides what a reader believes
 * once it is there.
 *
 * ## Why the block keeps the frame
 *
 * The review complaint was that neither artefact was good: the atom loses the relation, the sentence is
 * too coarse to act on. The block is the answer to that, and it is deliberately three lines rather than
 * one:
 *
 * ```
 * fact:     I finished an online course on data analysis using Python.            [event]
 * relation: -> causes -> "I am interested in applying my new skills…"  (marker: "so")
 * frame:    "By the way, I just finished an online course … so I'm interested …"
 * ```
 *
 * The fact gives precision, the relation restores what the split destroyed, and the frame lets a reader
 * judge both without a second lookup. Cost: roughly three times the tokens of the bare atom. That is why
 * the budget is spent in `fuse.ts` rather than here — the block is the unit of value, and a budget that
 * counts atoms would under-count it by the factor that makes it useful.
 */

import { describeAssumptions } from '../knowledge/assumption.js';
import { EXTRACTED_EDGE_TYPES, type EdgeType } from '../knowledge/taxonomy.js';
import type { KnowledgeEdge } from '../knowledge/edge.js';
import type { KnowledgeFact, KnowledgeFrame } from '../knowledge/frame.js';
import type { KnowledgeUnit } from '../knowledge/unit.js';

/** An edge type a traversal may follow. */
const TRAVERSABLE: readonly EdgeType[] = [...EXTRACTED_EDGE_TYPES, 'same-entity'];

export type ExpansionOptions = {
  /** How many hops. One by default: depth two is a proposal, not a default, and must earn its keep. */
  readonly depth?: number;
  /** Overrides the traversable set. Exists for an ablation, not for a caller with an opinion. */
  readonly via?: readonly EdgeType[];
};

/** A fact reached by expanding from a seed. */
export type Reached = {
  readonly factId: string;
  readonly hops: number;
  /** The edge that first reached it, so the path is reportable rather than merely true. */
  readonly through: string;
  readonly type: EdgeType;
};

/**
 * Breadth-first expansion from `seeds`, returning everything reached except the seeds themselves.
 *
 * Deterministic without sorting by edge weight, because there are no weights: the edge set is typed and
 * unweighted on purpose (a weight invites tuning, and the only controlled comparison we have says a
 * similarity-weighted graph is worse than a flat index). Ties are broken by edge id.
 */
export function expandTyped(
  seeds: readonly string[],
  edges: readonly KnowledgeEdge[],
  options: ExpansionOptions = {},
): readonly Reached[] {
  const depth = options.depth ?? 1;
  const via = options.via ?? TRAVERSABLE;
  const usable = edges
    .filter((edge) => via.includes(edge.type))
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const visited = new Set<string>(seeds);
  let frontier = [...seeds];
  const reached: Reached[] = [];

  for (let hop = 1; hop <= depth; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of usable) {
        const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
        if (other === null || visited.has(other)) continue;
        visited.add(other);
        next.push(other);
        reached.push({ factId: other, hops: hop, through: edge.id, type: edge.type });
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return reached;
}

/** A rough token count, good enough to spend a budget and honest about being an estimate. */
export function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export type BlockOptions = {
  /** How many relation lines to render per fact. Defaults to all of them; a cap is for size, not truth. */
  readonly maxRelations?: number;
  /**
   * Facts that are themselves in the block, so a relation may name them by id instead of quoting them.
   *
   * Quoting is the right default -- a block read on its own has to be intelligible -- but when the
   * other end is two lines below, the quote is a copy: on `g00` it cost 40 of 139 tokens. Naming an id
   * is only safe because the id is in the same text, which is exactly the condition this set encodes.
   */
  readonly referenced?: ReadonlySet<string>;
};

/**
 * The three-line block for one fact.
 *
 * Relations are rendered in edge-id order so two exports of the same unit are byte-identical apart from
 * real changes. A `supersedes` edge renders as a `status:` line in both directions, because "this fact
 * replaced that one" and "this fact was replaced" are the same knowledge and a reader needs it stated
 * from whichever end it arrived.
 */
export function renderBlock(
  fact: KnowledgeFact,
  frame: KnowledgeFrame,
  edges: readonly KnowledgeEdge[],
  facts: ReadonlyMap<string, KnowledgeFact>,
  options: BlockOptions = {},
): readonly string[] {
  const relations = edges
    .filter((edge) => edge.from === fact.id || edge.to === fact.id)
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const rendered: string[] = [];
  for (const edge of relations) {
    if (edge.type === 'supersedes') {
      const direction = edge.from === fact.id ? 'replaces' : 'superseded by';
      const other = facts.get(edge.from === fact.id ? edge.to : edge.from);
      if (other === undefined) continue;
      rendered.push(`status:   ${direction} "${other.text}"`);
      continue;
    }
    const direction = edge.from === fact.id ? '->' : '<-';
    const other = facts.get(edge.from === fact.id ? edge.to : edge.from);
    if (other === undefined) continue;
    const marker = edge.marker === undefined ? '' : `  (marker: "${edge.marker}")`;
    const target = options.referenced?.has(other.id) === true ? other.id : `"${other.text}"`;
    rendered.push(`relation: ${direction} ${edge.type} ${direction} ${target}${marker}`);
  }

  const shown =
    options.maxRelations === undefined ? rendered : rendered.slice(0, options.maxRelations);
  const assumed = describeAssumptions(fact);
  return [
    `fact:     ${fact.text}  [${fact.type}]`,
    ...(fact.stale === true ? ['status:   stale (a premise it rests on was refuted)'] : []),
    ...shown,
    ...(assumed === '' ? [] : [`assumed:  ${assumed}`]),
    `frame:    "${frame.text}"`,
  ];
}

/**
 * The blocks for a set of facts, in the order given, with the frame stated **once**.
 *
 * The single-frame form was measured before it was written: rendering `g00` as two self-contained
 * blocks cost 90 tokens each and repeated the same sentence twice, so a budget of 200 spent 180 on one
 * card. Grouping halves that and reads better, because the relation between two facts is easier to see
 * when the sentence they both came from is above them rather than under each.
 *
 * Order is the caller's, because it came from the fusion and the budget; re-sorting here would silently
 * undo the ranking that decided what fit.
 */
export function renderBlocks(
  unit: KnowledgeUnit,
  factIds: readonly string[],
  options: BlockOptions = {},
): readonly string[] {
  const facts = new Map(unit.facts.map((fact) => [fact.id, fact]));
  const selected = factIds
    .map((id) => facts.get(id))
    .filter((fact): fact is KnowledgeFact => fact !== undefined);
  if (selected.length === 0) return [];

  // The frame line first, then every selected fact as `fact` + its relations. `renderBlock` is reused
  // for the relation lines by dropping the copy of the frame it appends, so the two renderers cannot
  // disagree about how a relation is written.
  const lines: string[] = [`frame:    "${unit.frame.text}"`];
  const referenced = new Set(selected.map((fact) => fact.id));
  for (const fact of selected) {
    const block = renderBlock(fact, unit.frame, unit.edges, facts, { ...options, referenced });
    lines.push(...block.slice(0, -1));
  }
  return lines;
}

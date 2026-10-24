/**
 * What kinds of thing a remembered statement can be, and what kinds of link can join two of them.
 *
 * ## Why a type is needed at all
 *
 * The card review said the atoms were "the sentence cut into segments", and the census in
 * `docs/MEASURE-ATOM-FIDELITY.md` shows the shape of the damage: 5 of the 9 relational frames in
 * the 20-pair artifact lose their relation entirely or in part, because a relation lives in a
 * conjunction that belongs to neither half of the split.
 *
 * A type is not decoration. It decides three things that are otherwise decided by prose:
 *
 * 1. **Which link is even possible.** `but` licenses a contrast and nothing else; `then` licenses
 *    ordering and **never** causation (the survey of event-causality identification calls the
 *    confusion "causal hallucination" and names it the dominant failure of both fine-tuned and
 *    prompted systems).
 * 2. **How a statement is read at answer time.** A `goal` ("I'm planning to…") must not be served
 *    as though it had happened; a `constraint` is a rule the reader has to obey, not a fact about
 *    the world; a `preference` outranks an `event` when the question is "what do they like".
 * 3. **What supersedes what.** A `state` can be invalidated by a later `state` on the same
 *    subject and predicate. An `event` cannot: two events can both be true.
 *
 * ## The one thing a type may not be
 *
 * A **verdict**. Nothing here gates publication, and no type is more publishable than another: a
 * `credential` is refused by the rule table before typing is reached, and a `preference` is not
 * safer to publish than an `event`. A model that could choose "this is only an attribute" to get a
 * sentence past a gate would be choosing a scope, which `proposer.ts` says it may not do.
 *
 * So the type is **content, recorded and exported**, in the same category as `ProposedFact.text`.
 * Its only enforcement is on edges, where a wrong type produces an unlicensed edge and the edge is
 * dropped — a link lost, never a claim published.
 */

/** What a fact asserts. Each member exists because a reviewed card needed it. */
export type FactType =
  /** Something that happened, or will happen, at a time. `g00`'s "I finished an online course". */
  | 'event'
  /**
   * A condition that holds over an interval rather than at a point: "I have a production facility
   * in Poland" (`g08`). Distinguished from `event` because only a state can be superseded by a
   * later state without either being false.
   */
  | 'state'
  /** Likes, dislikes and priorities: `g25`'s "personal interests and work-life balance". */
  | 'preference'
  /** A rule, deadline or prohibition the person is under. Read as an instruction, not a report. */
  | 'constraint'
  /** A chosen course, and by implication the alternatives it beat. `g05`'s favourite hotel. */
  | 'decision'
  /** An intended future action. Must not be served as though it had occurred. */
  | 'goal'
  /** A property of an entity: `g13`'s "the project connects 100 rural villages". */
  | 'attribute'
  /** A judgement the speaker made: `g10`'s "performing really well", which the split dropped. */
  | 'evaluation'
  /**
   * A fact *about* two facts. `g04`'s "Online communities help me learn new techniques" is the
   * existence proof that a model will write one unprompted — and the only shape in the reviewed
   * set that keeps a relation without needing an edge.
   */
  | 'relation';

/** The closed set, in the order a reader would scan it. Runtime-checkable on purpose. */
export const FACT_TYPES: readonly FactType[] = [
  'event',
  'state',
  'preference',
  'constraint',
  'decision',
  'goal',
  'attribute',
  'evaluation',
  'relation',
];

/**
 * Whether a claim is asserted or denied.
 *
 * Separate from the text because `grounding.ts` counts negations and a count is not a position:
 * "I don't dislike it" and "I dislike it" differ by one negation and by everything else.
 */
export type Polarity = 'positive' | 'negated';

/** Whether the claim already holds, is intended, or is contingent. */
export type Modality =
  /** Asserted as true of the world (or of the speaker) now or in the past. */
  | 'actual'
  /** Intended: "I'm planning to make a California roll" (`g30`). */
  | 'planned'
  /** Contingent on a condition: `g12`'s "I'll keep an eye on the weather **if** I plan a trip". */
  | 'hypothetical';

export const POLARITIES: readonly Polarity[] = ['positive', 'negated'];
export const MODALITIES: readonly Modality[] = ['actual', 'planned', 'hypothetical'];

/** The class of relation a marker expresses. Fixed by the marker, not by the model. */
export type RelationKind = 'causal' | 'temporal' | 'conditional' | 'contrast';

/** The class of link between two facts. */
export type EdgeType =
  /** `so`, `because`, `due to` — one fact brought the other about. */
  | 'causes'
  /** `thanks to`, `by` — one fact made the other possible without being sufficient. */
  | 'enables'
  /** `but` in its blocking sense: one fact stops another from happening. */
  | 'prevents'
  /** `before`, `then`, `once` — ordering, and **nothing more**. */
  | 'before'
  | 'after'
  /** `during`, `while` — overlap in time. */
  | 'during'
  /** `if`, `unless`, `otherwise` — the first holds only when the second does. */
  | 'condition'
  /** `but`, `although`, `instead` — the two facts pull in different directions. */
  | 'contrast'
  /** Same entity, added detail. Derived, never extracted: a model that may assert `elaborates` may assert anything. */
  | 'elaborates'
  /** The later fact replaced the earlier one. Derived from slots, never from prose. */
  | 'supersedes'
  /** Two mentions resolved to one entity. Derived from a declared alias, never from similarity. */
  | 'same-entity';

export const EDGE_TYPES: readonly EdgeType[] = [
  'causes',
  'enables',
  'prevents',
  'before',
  'after',
  'during',
  'condition',
  'contrast',
  'elaborates',
  'supersedes',
  'same-entity',
];

/**
 * Edges read off a sentence. These need a marker and a locatable span.
 *
 * The list is short on purpose. Every member is a relation an explicit English connective can
 * name, which is the only ground truth a gate can check without a parser.
 */
export const EXTRACTED_EDGE_TYPES: readonly EdgeType[] = [
  'causes',
  'enables',
  'prevents',
  'before',
  'after',
  'during',
  'condition',
  'contrast',
];

/**
 * Edges computed from structured fields. These are the only edges that may exist without a marker,
 * and they may exist only because the *inputs* are checkable: `supersedes` needs a subject, a
 * predicate and two times; `same-entity` needs a declared alias; `elaborates` needs one resolved
 * entity on both ends.
 */
export const DERIVED_EDGE_TYPES: readonly EdgeType[] = ['elaborates', 'supersedes', 'same-entity'];

/**
 * What each marker class is allowed to create.
 *
 * This table is the whole defence against causal hallucination, and it is a table rather than a
 * prompt sentence because the last prompt-only fix in this repository was disproven by its own
 * measurement (`proposer.ts`, v5: 45 → 48 proposals, verbatim 44.1% → 52.6%, reverted). A model
 * that reads "do not infer causation" and infers it anyway produces an edge whose marker cannot
 * license it, and the edge is dropped before anything is stored.
 *
 * Note what is **absent**: `temporal` does not license `causes`. "A then B" is the exact reading the
 * survey reports models over-attributing, and it is the reading a benchmark rewards by accident,
 * because causal questions and sequential questions share their evidence.
 */
const LICENCES: Readonly<Record<RelationKind, readonly EdgeType[]>> = {
  causal: ['causes', 'enables', 'prevents'],
  temporal: ['before', 'after', 'during'],
  conditional: ['condition'],
  contrast: ['contrast'],
};

/** Every marker class, for callers that iterate instead of look up. */
export const RELATION_KINDS: readonly RelationKind[] = [
  'causal',
  'temporal',
  'conditional',
  'contrast',
];

/** The edge types a marker class licenses, or none when there is no marker. */
export function licensedEdgeTypes(kind: RelationKind | null): readonly EdgeType[] {
  return kind === null ? [] : LICENCES[kind];
}

/** Which marker class licenses `type`, or `null` for a derived type. */
export function licenceClassOf(type: EdgeType): RelationKind | null {
  for (const kind of RELATION_KINDS) {
    if (LICENCES[kind].includes(type)) return kind;
  }
  return null;
}

export function isFactType(value: unknown): value is FactType {
  return typeof value === 'string' && (FACT_TYPES as readonly string[]).includes(value);
}

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === 'string' && (EDGE_TYPES as readonly string[]).includes(value);
}

export function isPolarity(value: unknown): value is Polarity {
  return typeof value === 'string' && (POLARITIES as readonly string[]).includes(value);
}

export function isModality(value: unknown): value is Modality {
  return typeof value === 'string' && (MODALITIES as readonly string[]).includes(value);
}

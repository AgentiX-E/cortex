/**
 * The product's fact source: a `KnowledgeFact` built out of an authorisation it has already paid for.
 *
 * ## Why this module is the semantic layer's precondition rather than one of its features
 *
 * `assemble`, `reviseLedger` and `resolveContradiction` all consume `KnowledgeFact[]`, and
 * `AUDIT-SEMANTIC-REACH.md` §2 counts the constructs of that type outside a test and one ablation: **zero**.
 * Wiring the consumers first was the external report's P0-1 and the audit refused it, because
 * `assemble([])` returns an empty block set, leaves every byte identical, keeps every test green and lets
 * the reach table claim a `P`. That is the failure `MEASURE-PLAN-SHAPE.md` priced at 43 mechanism flips for
 * 46 damages — a mechanism that reports it ran.
 *
 * So the order is fact source first, and this file is it.
 *
 * ## Why this source and not the two obvious alternatives
 *
 * | candidate | why not |
 * | --- | --- |
 * | extract atoms from the corpus at ingest (a model call per turn) | that is the corpus-ownership programme, not this one; it is deferred, not refused |
 * | infer supersession from corpus surface tokens | `MEASURE-SUPERSEDE-REACH.md` §2 closed it for the third and last time: the tightest rule deletes the gold from 36 of the 77 windows it touches and removes the stale value from none of the four questions it was registered for |
 * | **reuse the authorisation `supersede.ts` already computed** | **chosen** — it is already paid for, already called, and its three checks are stronger than any token heuristic |
 *
 * `adjudicateSupersession` reaches `replace` only after establishing that the quote is in the evidence
 * character for character, that the date sits on the same record as the quote, and that the record is later
 * than the one the previous answer rests on. A statement that passed all three is one the product has
 * **authorised**, and until this file existed it was thrown away one frame after being computed.
 *
 * ## Additive, and that is a constraint rather than a preference
 *
 * The campaign measured replacing original text with extracted atoms at **−19.62 points** and never
 * retracted it. So the sentence stays exactly where it was: this module adds a typed statement *beside* the
 * evidence, in its own block, and spends **zero** model calls — the only thing it does beyond what
 * `supersede.ts` already did is arithmetic over two strings it was handed.
 *
 * ## The two facts, and why there have to be two
 *
 * One fact would be `the answer is 1300`, which the evidence already says. The knowledge is the **relation**:
 * a value was replaced, and which of the two is current. That needs both ends and a date on each, which is
 * also exactly what `deriveSupersedes` requires — a fact with no `at`, or with a twin at the same instant,
 * supersedes nothing, and this module therefore returns `null` rather than a unit whose relation is absent.
 */

import {
  buildKnowledgeUnit,
  deriveSupersedes,
  locate,
  renderBlocks,
  type KnowledgeFact,
  type KnowledgeFrame,
  type KnowledgeUnit,
} from '@agentix-e/cortex-core';
import type { SupersessionVerdict } from './supersede.js';

/** What one authorised substitution contributes. */
type SemanticUpdateInput = {
  /** The rendered evidence the decision was read against. Every fact is grounded in it. */
  readonly evidence: string;
  /** A stable id for that frame. `checkFact` refuses a fact that names a different one. */
  readonly frameId: string;
  /** The question the two values answer. It is the slot the facts share. */
  readonly question: string;
  /** What the route answered before the pass was consulted. The older value. */
  readonly first: string;
  /** The adjudicated substitution, carrying the two records it was authorised by. */
  readonly verdict: Extract<SupersessionVerdict, { kind: 'replace' }>;
};

/** A unit, the two fact ids in the order a reader should meet them, and the anchor a window must contain. */
export type SemanticUpdate = {
  readonly unit: KnowledgeUnit;
  /** The newer fact first: it is the one a reader must prefer, and that order is the claim. */
  readonly factIds: readonly string[];
  /**
   * The text of the record the newer value was quoted from, with the `[date] speaker:` header removed.
   *
   * ## Why an anchor rather than a corpus identity
   *
   * The question this field answers is "is this update about *this* window". Two questions over one corpus
   * share evidence records, so the honest test is whether the window still carries the record the
   * authorisation was read from — not whether some caller remembered to pass the same id twice.
   *
   * The header is dropped because the renderer numbers and stamps turns at render time (position, and the
   * dataset's own dateline), so two renderings of one turn differ in exactly the parts that carry no
   * content. What is left is the sentence, which is the same bytes in both.
   */
  readonly anchor: string;
  /**
   * What makes two updates the same update, so a corpus seen twice does not render the line twice.
   *
   * The anchor alone would collide two different substitutions made against one record; the value alone
   * would collide two records that happen to carry the same new number. Folded case because the comparison
   * the adjudicator made was folded, and a key that is stricter than the decision would let the same
   * decision be absorbed twice.
   */
  readonly key: string;
};

/** The predicate both facts share. A question has one answer, and an update replaces it. */
const ANSWER_PREDICATE = 'answer';

/**
 * The body of one evidence record: everything after the `[date] speaker:` header, first line only.
 *
 * First line rather than the whole record for the reason the anchor exists: a continuation line is part of
 * the same turn but the renderer may reflow it, and an anchor that fails to match would silently make the
 * update unreachable — the inert-option failure this repository has caught twice.
 *
 * `null` when there is nothing left after the header, which is a record whose content is entirely a
 * dateline. There is no sentence to anchor on and therefore no update to report.
 */
function anchorOf(recordText: string): string | null {
  const match = /^[^\n]*?\]\s*[^\s:]+\s*:\s*([\s\S]*)$/.exec(recordText);
  if (match === null) return null;
  // The capture group is `[\s\S]*`, so it always matches — possibly with nothing in it — and `split` always
  // yields at least one element. Both assertions are facts about the two patterns rather than hopes, and the
  // `?? ''` that used to stand here was a branch no input could reach, which the per-file coverage gate reported
  // as the dead code it was.
  const line = (match[1] as string).split('\n', 1)[0] as string;
  const trimmed = line.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * One typed statement about one value, bound to the frame it was read from.
 *
 * `type: 'state'` is not decoration: `deriveSupersedes` refuses to supersede an immutable fact, and the
 * whole point of this unit is that the older value *is* superseded. A `state` holds over an interval and can
 * be replaced by a later `state` without either being false, which is exactly the relation being recorded.
 */
function factOf(args: {
  readonly id: string;
  readonly frameId: string;
  readonly evidence: string;
  readonly text: string;
  readonly subject: string;
  readonly at: number;
}): KnowledgeFact {
  return {
    id: args.id,
    frameId: args.frameId,
    text: args.text,
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    // Computed from the two strings by `locate`, never reported by a model — the same rule the frame layer
    // states for every other span in the kernel.
    sourceSpan: locate(args.text, args.evidence),
    references: [],
    subject: args.subject,
    predicate: ANSWER_PREDICATE,
    at: args.at,
  };
}

/**
 * The unit two authorised records support, or `null` when they support none.
 *
 * Every early return below is a case where the relation does not exist rather than a case where this module
 * failed: no date on either end, the same instant on both, an identical text, a record with no sentence in
 * it. A unit assembled without its relation would render two unrelated statements a reader cannot order,
 * which is worse than rendering nothing — it looks like knowledge.
 */
export function semanticUpdateFrom(input: SemanticUpdateInput): SemanticUpdate | null {
  const { later, earlier } = input.verdict.authorised;
  if (earlier === null || earlier.at === null || later.at === null) return null;
  // The newer record must be **strictly** later. `<` is refused here rather than left to the sort, because a
  // sort would silently swap the two ends and the unit would then claim the older value replaced the newer one —
  // a wrong claim that renders exactly like a right one. `==` is refused one line below: `deriveSupersedes` will
  // not order two facts on one instant, so the edge set comes back empty and this module reports no update,
  // which is the same verdict `revision.ts` reaches when it reports a refuted `uniqueness`.
  if (later.at < earlier.at) return null;

  const subject = input.question.trim();
  if (subject.length === 0) return null;

  const anchor = anchorOf(later.text);
  if (anchor === null) return null;

  const beforeId = `${input.frameId}:before`;
  const afterId = `${input.frameId}:after`;
  const facts: readonly KnowledgeFact[] = [
    factOf({
      id: beforeId,
      frameId: input.frameId,
      evidence: input.evidence,
      text: input.first,
      subject,
      at: earlier.at,
    }),
    factOf({
      id: afterId,
      frameId: input.frameId,
      evidence: input.evidence,
      text: input.verdict.value,
      subject,
      at: later.at,
    }),
  ];

  const edges = deriveSupersedes(facts);
  // `agrees` already refused a quote equal to the answer, so an empty edge set here means the two texts are
  // equal after folding. Reporting it as no update is the same call the adjudicator makes.
  if (edges.length === 0) return null;

  const frame: KnowledgeFrame = { id: input.frameId, text: input.evidence };
  // `record`, not `strict`: the frame is a whole rendered window, so the relation markers inside it
  // (`but`, `then`, `because`) are not this unit's to resolve. `strict` would refuse every real window and
  // this module would never produce a unit — the option would exist and reach nothing.
  const built = buildKnowledgeUnit({ frame, facts, edges, policy: 'record' });
  if (!built.ok) return null;

  return {
    unit: built.unit,
    factIds: [afterId, beforeId],
    anchor,
    key: `${anchor.toLowerCase()}\u0000${input.verdict.value.trim().toLowerCase()}`,
  };
}

/**
 * The lines a prompt carries, or none.
 *
 * `omitFrame: true` because the frame here is the entire rendered evidence — printing it would spend the
 * evidence's own budget a second time on a copy of what the prompt already contains above.
 */
export function renderSemanticUpdate(update: SemanticUpdate): readonly string[] {
  return renderBlocks(update.unit, update.factIds, { omitFrame: true });
}

/**
 * Whether a window still carries the record an update was authorised by.
 *
 * Substring, on the anchor, against each turn's own content. Not a similarity, not a token overlap: the turn
 * either still says the sentence or it does not, and a softer test would let an update about one corpus reach
 * a question about another — which on a benchmark is exactly a cross-question leak.
 */
export function updateAppliesTo(update: SemanticUpdate, contents: readonly string[]): boolean {
  return contents.some((content) => content.includes(update.anchor));
}

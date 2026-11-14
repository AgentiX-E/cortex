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
 *
 * ## The ledger has to be told, or the block serves the stale value as a fact
 *
 * `deriveSupersedes` produces an *edge*. It does not write anything onto either fact, and for one round that
 * was the whole story: the unit rendered both ends with a `status:` line each, so a reader was told
 * `30 dozen` replaced `20 dozen` **and** handed `20 dozen` on its own `fact:` line. Nothing marked it stale,
 * because `persistence` was `open` on a fact that had no assumptions at all.
 *
 * Writing the edge is not the same as recording the refutation, which is the distinction `revision.ts`
 * exists for and states in its own header: *a system where an edge says "B replaced A" while A's persistence
 * says "still open" contradicts itself in a way no reader can resolve.* So the facts this module builds carry
 * `deriveAssumptions`, and `reviseLedger` runs over them before the unit is stored. The older fact's
 * `persistence` becomes `refuted`, which is what `assemble` — the single exit — reads when it decides what
 * the block is allowed to say.
 *
 * ## Why `assemble` renders the block instead of `renderBlocks`
 *
 * Because the exit is where the ledger decision is applied, and a caller that took the served ids and
 * rendered them itself would be a second exit: it would drop the `flags` `assemble` computes for a conflict
 * and it would report neither `served` nor `excluded`. The block below is `assemble`'s own `lines`.
 *
 * The rank it is given is a **position**, not a similarity: `factIds` is the order this module asserts, and
 * numbering that order is the only honest score available here. Inventing a relevance number would be a
 * second retriever that nothing else can see, which `assemble`'s own contract refuses.
 */

import {
  assemble,
  buildKnowledgeUnit,
  createMemory,
  deriveAssumptions,
  deriveSupersedes,
  locate,
  reviseLedger,
  type KnowledgeFact,
  type KnowledgeFrame,
  type KnowledgeUnit,
  type MemoryValue,
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
   * The header the newer value was quoted from, `[date] speaker:`, with the sentence removed.
   *
   * It is the store entry's provenance. `MemoryValue.source` exists for "provenance and poisoning defense",
   * and the honest value for a statement the product authorised is the record it was authorised *from* rather
   * than the name of the code path that read it — `'supersede'` would tell a reader which mechanism fired and
   * nothing about where the claim came from, which is the direction that field points.
   */
  readonly source: string;
  /**
   * When this update became true: the later record's own instant.
   *
   * Two things read it, and they are the same thing from two sides. The frame carries it as `frame.at`, which
   * is the `openedAt` of every assumption the two facts derive — and that is not a metaphor: both facts
   * entered the ledger at the moment the substitution was authorised, which is the later record's instant.
   * The block then reads the ledger at that same instant rather than at wall-clock now, because the corpus is
   * historical and ageing a 2023 statement against a 2026 clock would report every unit this module can build
   * as `aged`. It would not be visible — `penalty.reason` is not rendered — and an invisible wrong number in
   * a structure an audit reads is exactly the kind of thing this repository has spent three rounds deleting.
   */
  readonly learnedAt: number;
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
 * A record split into its header and the sentence under it, or `null` when there is no sentence.
 *
 * One function rather than two regexes, because the header and the body have to come from the **same** match:
 * a separate `source` pass that failed where the anchor pass succeeded would stamp an entry with the provenance
 * of one record and the sentence of another, and nothing downstream could tell.
 *
 * ## The position prefix is stripped, for the reason the anchor drops the header
 *
 * `formatEvidence` labels each turn `${index + 1}. ` before its dateline, so the record a fact is read from
 * begins `2. [2023/03/12 …] user:`. That number is a **position in one window** — the same sentence is `5. `
 * in a window with three more turns in front of it — so a `source` that kept it would be provenance that
 * changes between two renderings of one record. The prefix pattern is the one `supersede.ts` uses to find record
 * boundaries, restated here rather than imported because that module's constant is about splitting a block and
 * this one is about reading a single record; a shared regex would tie two different jobs to one spelling.
 *
 * The body is the **first line** rather than the whole record for the reason the anchor exists: a continuation
 * line is part of the same turn but the renderer may reflow it, and an anchor that fails to match would
 * silently make the update unreachable — the inert-option failure this repository has caught twice.
 *
 * `null` when there is nothing left after the header, which is a record whose content is entirely a dateline.
 * There is no sentence to anchor on and therefore no update to report.
 */
function splitRecord(
  recordText: string,
): { readonly source: string; readonly body: string } | null {
  const match = /^\s*(?:#\d+\s|\d+\.\s)?([^\n]*?\]\s*[^\s:]+\s*:)\s*([\s\S]*)$/.exec(recordText);
  if (match === null) return null;
  // The second capture group is `[\s\S]*`, so it always matches — possibly with nothing in it — and `split`
  // always yields at least one element. Both assertions are facts about the two patterns rather than hopes, and
  // the `?? ''` that used to stand here was a branch no input could reach, which the per-file coverage gate
  // reported as the dead code it was.
  const line = (match[2] as string).split('\n', 1)[0] as string;
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  return { source: (match[1] as string).trim(), body: trimmed };
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
  readonly frame: KnowledgeFrame;
  readonly text: string;
  readonly subject: string;
  readonly at: number;
}): KnowledgeFact {
  const fact: KnowledgeFact = {
    id: args.id,
    frameId: args.frame.id,
    text: args.text,
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    // Computed from the two strings by `locate`, never reported by a model — the same rule the frame layer
    // states for every other span in the kernel.
    sourceSpan: locate(args.text, args.frame.text),
    references: [],
    subject: args.subject,
    predicate: ANSWER_PREDICATE,
    at: args.at,
  };
  // The ledger, derived rather than reported. `persistence` always, and `uniqueness` because both facts name
  // a subject and a predicate — without them `reviseLedger` has nothing to refute, and the refutation is the
  // whole point of running it.
  return { ...fact, assumptions: deriveAssumptions(fact, args.frame) };
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

  const split = splitRecord(later.text);
  if (split === null) return null;

  const beforeId = `${input.frameId}:before`;
  const afterId = `${input.frameId}:after`;
  // The frame carries `later.at`, and every assumption the two facts derive is opened by it: the two facts
  // entered the ledger at one moment, the one where this substitution was authorised.
  const frame: KnowledgeFrame = { id: input.frameId, text: input.evidence, at: later.at };
  const facts: readonly KnowledgeFact[] = [
    factOf({ id: beforeId, frame, text: input.first, subject, at: earlier.at }),
    factOf({ id: afterId, frame, text: input.verdict.value, subject, at: later.at }),
  ];

  const edges = deriveSupersedes(facts);
  // `agrees` already refused a quote equal to the answer, so an empty edge set here means the two texts are
  // equal after folding. Reporting it as no update is the same call the adjudicator makes.
  if (edges.length === 0) return null;

  // `record`, not `strict`: the frame is a whole rendered window, so the relation markers inside it
  // (`but`, `then`, `because`) are not this unit's to resolve. `strict` would refuse every real window and
  // this module would never produce a unit — the option would exist and reach nothing.
  const built = buildKnowledgeUnit({ frame, facts, edges, policy: 'record' });
  if (!built.ok) return null;

  // The build validates; the revision then *records*. Order matters and is not stylistic: a revision applied
  // before the build would write a `refuted` onto a fact whose span had not been checked yet, so a refused
  // unit would leave a modified fact set behind and a caller reading it would see a refutation from a unit
  // that does not exist.
  const revised = reviseLedger(built.unit.facts, { edges: built.unit.edges });

  return {
    unit: { ...built.unit, facts: revised.facts },
    factIds: [afterId, beforeId],
    anchor: split.body,
    source: split.source,
    learnedAt: later.at,
    key: `${split.body.toLowerCase()}\u0000${input.verdict.value.trim().toLowerCase()}`,
  };
}

/** What one block says, and what the ledger refused to let it say. */
type SemanticBlock = {
  readonly lines: readonly string[];
  /** Facts that reached the block. One per update while the ledger is doing its job. */
  readonly served: number;
  /** Facts the exit refused, by any reason. Non-zero is what makes the wiring load-bearing. */
  readonly withheld: number;
};

/**
 * The lines a prompt carries, or none — through `assemble`, which is the single exit.
 *
 * ### Two numbers, because one is not a measurement
 *
 * `served` alone cannot fail: a block that printed both ends would report `served: 2` and look healthier than
 * a correct one. `withheld` is the half that can be zero while everything else looks fine — it is zero when
 * the revision stopped writing `refuted`, which is the exact failure a unit with no assumptions had for one
 * round. Together they are a ratio a reader can check (`served === withheld` on every well-formed unit), and
 * separately neither is.
 *
 * ### The rank is a position
 *
 * `factIds` is `[newer, older]`, and numbering it is the only score this module can honestly supply. It
 * decides nothing while the ledger is on — the older fact never reaches the ranking — and it decides the
 * order of the trial renders the budget makes, which is why it is stated rather than left to a tie-break on
 * ids.
 */
export function assembleSemanticUpdate(update: SemanticUpdate): SemanticBlock {
  const ranked = update.factIds.map((factId, index) => ({
    factId,
    score: update.factIds.length - index,
  }));
  const result = assemble({
    unit: update.unit,
    ranked,
    now: update.learnedAt,
    intent: 'fact',
    // The frame here is the entire rendered evidence, which the prompt already carries verbatim above this
    // block. Printing it again would spend the evidence's budget on a copy of itself.
    omitFrame: true,
  });
  return {
    lines: result.lines,
    served: result.census.served,
    withheld: result.excluded.length,
  };
}

/**
 * The store entry an authorised update becomes, typed so the store can tell it from an observation.
 *
 * ## Why this function is E3 rather than a convenience wrapper
 *
 * Semantic-layer exit criterion E3 is **representability**: `MemoryType` writes and reads `'semantic'`, the
 * fake it refuses is *a settable label nobody reads*, and the check is *write → read back → behaviour changes*.
 * Until this function existed the product constructed every `MemoryValue` with a literal `'episodic'` in
 * `admission.ts` and no code path so much as compared the field, so the union's three members were a taxonomy
 * the type system asserted and the runtime did not have. This is the write side; `retention.ts` is the read.
 *
 * ## Why the entry is built through `createMemory`
 *
 * The same rule `admission.ts` states: FSRS defaults have exactly one owner, and the composition layer must not
 * become a second. Every field this function does not pass is `createMemory`'s default, which is also what an
 * admitted turn carries — so nothing here invents a number. `value`, `confidence` and `sourceTrust` are the
 * three that would be easiest to invent and are deliberately all absent: the store's eviction reads a count it
 * observes itself (`retention.ts`), not a utility estimate this module would have had to make up.
 *
 * ## What the fields that *are* passed are grounded in
 *
 * | field | value | where it comes from |
 * | --- | --- | --- |
 * | `id` | `update.key` | the dedup key, so one update is one entry and re-seeing a corpus cannot mint a second |
 * | `content` | the rendered block | the characters the prompt would actually carry, computed by `assemble` rather than described here |
 * | `type` | `'semantic'` | the claim: this is a statement about the world, not a reading of a window |
 * | `source` | the record header | the provenance the authorisation was read from |
 * | `createdAt` / `lastAccessedAt` | `now` | the store's injected clock — the moment the instance recorded it, not `learnedAt`, which is the corpus's own instant and may be years earlier |
 */
export function memoryForUpdate(args: {
  readonly update: SemanticUpdate;
  readonly lines: readonly string[];
  readonly now: number;
}): MemoryValue {
  return createMemory({
    id: args.update.key,
    content: args.lines.join('\n'),
    type: 'semantic',
    source: args.update.source,
    createdAt: args.now,
    lastAccessedAt: args.now,
  });
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

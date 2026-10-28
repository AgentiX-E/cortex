/**
 * A relevance signal for the prompt budget, taken from the arm's own retrieval.
 *
 * ## The defect this closes
 *
 * `CortexMemory` spent its prompt budget on the first turns that arrived, and on
 * this arm arrival order is the dataset's haystack order because nothing beneath it
 * ranked anything. Run `38142407062` measured the consequence: across the fourteen
 * gold sessions the arm had carried whole, the gold turn was inside the context the
 * model actually read for **11.6%** of questions (14 of 121), against a ceiling of
 * **92.1%** -- the share of questions whose answer turn is in the bundle at all
 * (`MEASURE-B2-RECALL-CURVE.md`).
 *
 * So the gap was never the size of the budget. `§13.13` established that too: the
 * budget carried 4.69% of a 506,338-character mean context, and enlarging it would
 * have been a run that bought a better chance of hitting the answer by luck. The
 * budget has to be spent on the right turns, and "right" is a *retrieval*
 * measurement -- which is why `CortexMemoryOptions.relevanceFor` takes a callback
 * rather than computing one: `cortex-memory` reads no embedding model, and the
 * ranking the reference pipeline already uses is the ranking this index reuses.
 *
 * ## Why an index rather than a callback that retrieves
 *
 * `relevanceFor` is synchronous and the retrieval behind it is not. An index built
 * before the ablation makes the callback a pure map lookup, which also makes the
 * signal **auditable**: `questions` and `scoredPairs` describe exactly how much of
 * the context carries a score, and they are read at build time rather than
 * accumulated during a run.
 *
 * ## The non-oracle boundary, and why it is a type
 *
 * The signal is built from a question's **text** and its **context**. The ground
 * truth is not a parameter of {@link RelevanceCase} and is not in scope anywhere in
 * this module, so "the index was sharpened with the answer" is not a mistake a
 * later edit can make quietly -- it would have to change the input type first.
 * `relevance-index.test.ts` measures that property: two cases differing only in an
 * unread field produce one index.
 *
 * The queries are the question alone by default. The reference pipeline also queries
 * with LLM-written expansion phrases, and this index takes them through
 * {@link RelevanceCase.queries} rather than writing them itself: an expansion pass
 * inside the construction of the signal would put a model call where a measurement is
 * supposed to be, so a run whose signal moved could no longer say whether the ranking
 * or the model changed. The phrases arrive as data, produced by `query-expansion.ts`
 * before the index is built, and a case that names none is retrieved exactly as before.
 */
import type { EmbeddingModel, RerankScoreFn } from '@agentix-e/cortex-core';
import { rerankHits } from '@agentix-e/cortex-core';
import { retrieveTopKByQueries, type RetrievalHit } from './retrieval.js';
import { temporalBoosts } from './temporal-relevance.js';
import { countedRerank, type CountedRerank, type RerankCensus } from './rerank-census.js';

/**
 * What a turn scores when the index holds no measurement for it.
 *
 * ## Why a number below every cosine rather than a sentinel
 *
 * `CortexMemory` orders turns by this value and offers the budget the largest
 * fitting prefix of that order, so the floor's only job is to sort last. It cannot
 * be `-Infinity`: `validateRelevance` rejects non-finite scores, on the ground that
 * they order nothing and a sort over them describes the sort rather than the
 * signal. It cannot be `0` either, and that is the subtle one -- `0` is a cosine
 * two orthogonal turns genuinely earn, so a floor of `0` would make "the index
 * never measured this turn" and "the index measured this turn as unrelated"
 * indistinguishable in the ordering, which is the collapse this package has
 * removed three times at other layers.
 *
 * `-2` is below the range of a cosine, which is `[-1, 1]`. The relation is asserted
 * rather than the literal -- `relevance-index.test.ts` compares it against a turn
 * the index scores at `-1` -- so raising it to `-1.5` would stay legal and lowering
 * it to `-0.5` would fail.
 *
 * Not exported: the only thing a caller can do with it is compare a score against
 * it, and the one caller that needs to (`relevanceFor` itself) is in this file. A
 * caller asking "was this turn scored" has `scoredPairs` for the run and the
 * ordering for the question, and an exported floor would invite a hand-written
 * comparison against a constant this module is free to move.
 */
const UNSCORED_RELEVANCE = -2;

/**
 * How many turns per question the index scores when the caller names no width.
 *
 * `MEASURE-B2-RECALL-CURVE.md` measured `recall = 0.921` at `k = 50` on this
 * dataset, with `gain = 0.000` -- the curve had already flattened, and `0.921` is
 * its ceiling rather than a point on the way up (six questions have no answer turn
 * in the bundle at all). So the interesting property of this constant is only that
 * it is **at or above** the knee of a measured curve, and 64 is that with a margin
 * for the six-question floor being an artifact of a different sample.
 *
 * It is deliberately not raised to the whole context. The prompt budget holds
 * roughly 167 turns at 24,000 characters, so every scored turn survives selection
 * as long as the scored set is smaller than the room -- and a scored set of 64 is
 * therefore the *entire* selection on a question where retrieval found something.
 * Widening past that would change which of the low-scoring turns are ordered rather
 * than which high-scoring turns are admitted, at a linear cost in cosine work.
 */
export const DEFAULT_RELEVANCE_TOP_K = 64;

/** One question, and the context it is asked against. Nothing else is read. */
export type RelevanceCase = {
  readonly question: string;
  /**
   * Extra queries this question is retrieved with, in addition to its own text.
   *
   * ## Why the phrases are a field rather than something this module writes
   *
   * The phrases come from a model call, and a model call belongs outside the
   * instrument: `query-expansion.ts` produces them once, before the index is built,
   * and this type carries them as data. That keeps the non-oracle property below
   * intact -- the phrases are derived from the question's **text**, never from the
   * answer -- and it keeps the index a function of what it was handed, so two runs
   * holding the same cases score identically.
   *
   * Absent and empty are the same state: the case is retrieved with its question
   * alone, which is what every archived artifact was produced with.
   */
  readonly queries?: readonly string[];
  readonly context: readonly string[];
  /**
   * The session boundaries `context` was flattened from, when the caller has them.
   *
   * Not read here, and deliberately carried anyway: `session-relevance.ts` scores a **session** as
   * one unit and needs the boundaries, and a second case type that differed only by this field
   * would let the two builders drift in what they consider a case. `loadLongMemEval` produces both
   * (`context: sessions.flat()`), so the field costs a reference and never a copy.
   *
   * Absent is a real state and not an error here — every archived run's cases had no boundaries,
   * and this module does not need them. It is `buildSessionRelevanceIndex` that refuses, because
   * there the absence would silently change which operation ran.
   */
  readonly sessions?: readonly (readonly string[])[];
  /**
   * When each turn in `context` happened, parallel to it, or absent.
   *
   * Read only when `RelevanceIndexOptions.temporalWeight` is above zero, and absent is the state every
   * archived run is in — so a case that names no dates is scored exactly as before. Carried on the same case
   * type rather than a parallel one for the reason `sessions` is: two case types that differ by one field
   * would let the builders drift in what they consider a case.
   *
   * `null` and `undefined` entries are the honest representation of a turn whose session carried no instant,
   * and they score zero contribution rather than a penalty — see `temporal-relevance.ts`.
   */
  readonly turnDates?: readonly (number | null | undefined)[] | undefined;
  /** When this question was asked, which is the anchor the turn instants are measured against. */
  readonly askedAt?: number | null | undefined;
};

/** How to build the index. */
export type RelevanceIndexOptions = {
  /**
   * How many turns per question carry a score. Defaults to
   * {@link DEFAULT_RELEVANCE_TOP_K}.
   *
   * Validated by the arm's option reader rather than here, for the reason
   * `bench-arm-options.ts` documents: a guard in this module would be a second
   * place to be wrong about the same value, and the arm is the caller whose
   * configuration reaches an artifact.
   */
  readonly topK?: number;
  /**
   * How a question's candidates are retrieved. Defaults to dense cosine alone.
   *
   * ## Why the retriever is a seam
   *
   * §13.62's partition measured where the gold goes: on MR, **1026 gold turns were never
   * surfaced and 903 were surfaced and cut**, so the pool's reach is the larger of the two
   * losses and the next variable is *how candidates are chosen*. A module that hardwired
   * `retrieveTopKByQueries` could only express that variable by being edited, and an edited
   * module cannot hold both arms of a comparison.
   *
   * The signature is the one the two provided retrievers already share --
   * `retrieveTopKByQueries` (dense) and `retrieveTopKByQueriesHybrid` (dense fused with a
   * rare-keyword channel by reciprocal rank) -- so a caller names a mechanism rather than
   * writing one. It is a callback here and a *name* one layer up (the arm's
   * `relevanceSignal`), because the artifact has to record which mechanism ran and the
   * config line can only hold a string.
   *
   * Defaulting to dense rather than requiring it keeps every archived artifact's signal
   * reproducible from the code: a required parameter would make the default a decision each
   * caller makes again, and one of them would eventually make a different one.
   */
  readonly retrieve?: Retrieval;
  /**
   * How much a turn's distance from the question's date contributes to its score. Defaults to **0**.
   *
   * ## Why zero is the default and why that is not timidity
   *
   * Every archived artifact was produced without this signal, so `0` has to mean "the ranking is what it
   * was", byte for byte. A default above zero would silently change the meaning of every earlier run's
   * configuration line, and an ablation could no longer hold this at "absent" because absent would not be
   * expressible.
   *
   * The contribution is an **addition to the cosine the turn already earned**, and only for turns the
   * retriever surfaced. Adding it to the floor would let a same-day turn the retriever never scored outrank
   * a measured one, which reads as the temporal signal working while it is really the floor leaking.
   *
   * `docs/PLAN-RETRIEVAL-SIGNALS.md` §3 registers the experiment this exists for: `+3` recall@10 on the
   * temporal questions of a 20-question column, at most `1` elsewhere, refuted below `+2`.
   */
  readonly temporalWeight?: number;
  /**
   * A cross-encoder that reorders each question's retrieved pool before the budget spends it.
   *
   * ## Why the stage lives here rather than in the prompt builder
   *
   * The budget buys a prefix of an order, and the order is this index's only product. A reranker
   * wired further down — in `cortex-memory`'s selection — would have to re-score turns the selection
   * had already admitted, which is the opposite of what a retrieval-stage reranker is for: RAW-RAG
   * reranks the *retrieved pool* and then hands the reader a prefix of it, and their ablation says
   * removing that stage costs **3.92** points, more than any mechanism they added
   * (`SOTA-LANDSCAPE.md` §4.9). Scoring after admission could only reorder what survived a ranking it
   * never saw.
   *
   * ## Why the pool is everything retrieved, and not a narrower slice
   *
   * There is no `pool` option on purpose. This arm retrieves `topK` turns and the reranker is shown
   * all of them, so **one scale covers every scored turn** and no turn can be ranked by a number
   * that came from a different model. A narrower pool would reintroduce exactly that: the turns
   * above the cut would carry cross-encoder scores, the turns below it the retriever's, and the two
   * are not comparable — RAW-RAG's own pipeline has the same property (K = 128 retrieved, all 128
   * rescored, top 15 read).
   *
   * ## What the score becomes, and why it is a ladder rather than the cross-encoder's output
   *
   * `relevanceFor` answers one question — which of these two turns is more relevant — and the only
   * thing that reads it is a sort and a max-aggregation. But the number it returns is also the
   * domain of {@link UNSCORED_RELEVANCE}: a turn is "in the index" iff its score is above the floor,
   * and `candidatesFor` is asserted against that equivalence.
   *
   * Providers do not share a score scale. `/rerank` endpoints answer with `relevance_score` in
   * `[0, 1]`; a local ms-marco cross-encoder answers with an unbounded logit, and small logits are
   * **negative**. Writing those through would put a scored turn below the floor and break the
   * equivalence at the one place the module's own type says it cannot break. So the *order* is the
   * reranker's and the *number* is a strictly decreasing ladder over that order, which is inside
   * `(0, 1]` for every provider and states position rather than pretending to state similarity.
   *
   * ## The composition this refuses
   *
   * `temporalWeight` above zero alongside a reranker throws at construction. Both rewrite the same
   * number by unrelated rules — an addition to a cosine versus a permutation of the pool — and the
   * order of those two operations is not a decision this project has registered or measured. §13.4
   * already requires the two increments to be dispatched serially because both change what the
   * reader sees; refusing the combination in code is that constraint moved to where it cannot be
   * forgotten.
   */
  readonly rerank?: RerankScoreFn;
  /**
   * The widest pool the scorer can score **in one call**, when the provider declares one.
   *
   * ## Why this is a refusal rather than a chunking strategy
   *
   * Zhipu's `/rerank` accepts at most **128** documents per request and answers `400` above that;
   * Cohere accepts 1,000. A pool wider than the provider's limit cannot be scored, and the two
   * obvious repairs are both wrong: dropping the excess back onto the retriever's scale is the mixed
   * -scale defect {@link RelevanceIndexOptions.rerank} refuses, and splitting the pool into batches
   * makes the scores incomparable across batches — `relevance_score` is normalised **per call**, so a
   * batch-local winner can outrank a true winner from another batch while every number looks
   * plausible.
   *
   * So a run that names a pool the provider cannot take is refused at construction, before it spends
   * a retrieval call. The alternative — running it and reading `fallbacks: 500` — costs a full
   * dispatch to learn a fact this project already knows.
   */
  readonly rerankMaxDocuments?: number;
  /**
   * The longest passage the scorer accepts, when the provider declares one.
   *
   * Zhipu's `/rerank` rejects the **whole call** when a single document exceeds 4,096 characters, and
   * this corpus carries turns up to 15,369 (§13.67). Without a clip, a handful of long turns would
   * turn entire questions into `fallbacks` — which §13.115 reads as an assembly failure — for a reason
   * that has nothing to do with the reranker's judgement. The clip is applied at the boundary and
   * counted, so the artifact says how often the scorer judged a prefix.
   */
  readonly rerankMaxDocumentChars?: number;
};

/** The shape both provided retrievers have: queries and a context in, ranked hits out. */
export type Retrieval = (
  queries: readonly string[],
  context: readonly string[],
  topK: number,
) => Promise<readonly RetrievalHit[]>;

/**
 * The built signal: a synchronous lookup, plus how much it measured.
 *
 * The two counts exist so a run can say what it built. They are facts about
 * construction and not about any question, so they are read once, before the
 * ablation, rather than accumulated during it -- a counter written by
 * `relevanceFor` would make the callback stateful, and a stateful callback is one
 * whose value depends on how many times the prompt builder happened to ask.
 */
export type RelevanceIndex = {
  /** Cases the index covers. */
  readonly questions: number;
  /** `(question, turn)` pairs carrying a score. */
  readonly scoredPairs: number;
  /** The width the index was built at. */
  readonly topK: number;
  /**
   * The score for `turn` under `question`, or {@link UNSCORED_RELEVANCE}.
   *
   * Total: an unknown question, a turn outside the top-k, and a turn from a
   * different question's context all answer with the floor rather than throwing.
   * That is what the selection needs -- it ranks every admitted turn, most of
   * which a top-k index does not hold -- and it is why the miss is a value rather
   * than an error.
   */
  relevanceFor(question: string, turn: string): number;
  /**
   * The turns this index holds a score for under `question`.
   *
   * ## Why the candidate set is exposed at all
   *
   * The selection spends a character budget on an order, so "the gold turn did not reach
   * the reader" has two causes that need opposite repairs -- the ranking never surfaced
   * it, or the ranking held it and the budget cut it -- and the artifact could not tell
   * them apart. §13.61.7 records what that cost: `k = 64` and `k = 256` were both
   * measured, and neither could say which of the two it had changed.
   *
   * ## Why a set of texts rather than a ranked list
   *
   * The consumer of this method asks one question -- is this gold turn a candidate -- and
   * a ranked list would answer it while inviting a second question the index cannot
   * honestly serve: what order the candidates were in. That order belongs to the
   * selection, which is `CortexMemory`'s, and this module deliberately discards the
   * ranking `retrieveTopKByQueries` returns for exactly that reason.
   *
   * Total, like `relevanceFor`: an unknown question is a question this index did not
   * score, and an empty set says so rather than throwing. The two answers agree by
   * construction -- a turn is in this set if and only if `relevanceFor` scores it above
   * {@link UNSCORED_RELEVANCE} -- and that equivalence is asserted rather than assumed.
   */
  candidatesFor(question: string): ReadonlySet<string>;
  /**
   * The same turns, **in the ranker's own order**, best first.
   *
   * ## Why both views, and why they are one structure
   *
   * `candidatesFor` answers "was this turn a candidate"; this answers "where was it", and the
   * second question is the one §13.64.7 could not ask: MR's 903 budget-cut gold turns are
   * either ranked just under the cut -- where the order is the lever -- or far under it,
   * where no order helps, and a set cannot distinguish them.
   *
   * The selection still does **not** consume this order: `CortexMemory` sorts the admitted
   * turns by `relevanceFor`, so a caller that wanted to rank by position would have to say
   * so. That separation is deliberate and unchanged -- what is new is that the ranking is
   * *reachable* for measurement instead of being discarded at the door.
   *
   * Backed by one ordered array that the set is built from, so "in the set" and "has a
   * position" cannot disagree; `relevance-index.test.ts` asserts the two agree.
   */
  rankedCandidatesFor(question: string): readonly string[];
  /**
   * How many distinct turn texts the temporal signal could place in time, and how many it looked at.
   *
   * Present only when `temporalWeight` was above zero. `scored: 0` with a non-zero population is the state
   * that says "configured, fired on nothing", which is a different finding from a missing field — the same
   * distinction `bareRetry` keeps for a retry pass, and it is the reason a census is not optional here.
   */
  readonly temporal?: { readonly scored: number; readonly total: number } | undefined;
  /**
   * What the rerank stage did, when one was configured.
   *
   * Absent for a run that carried no reranker, for the reason `temporal` is: `fallbacks: 0` and
   * "this artifact predates the field" must not be the same bytes. The registered reading of the
   * increment turns on it — `fallbacks > 0` is an **assembly failure**, not a null result, because
   * `rerankHits` degrades to the retrieved order and an arm in that state would report the
   * reranker's absence as the reranker's verdict.
   */
  readonly rerank?: RerankCensus | undefined;
};

/**
 * Build the index by retrieving each question's context against its own text.
 *
 * One retrieval per case, run before the ablation, against the same embedding
 * backend and the same process-wide vector cache the two sides grade with. That
 * sharing is not an optimisation: on this arm the reference pipeline embeds the
 * same haystack turns, so a signal built from a different backend would make the
 * selection and the baseline disagree about what "relevant" means while both are
 * reported as one run.
 *
 * The order the hits come back in is discarded. `retrieveTopKByQueries` fuses
 * several rankings by reciprocal rank and re-writes each score to the turn's
 * maximum cosine, so the *score* it returns is already order-independent; this
 * index keeps the score and drops the ranking, because the consumer's own selection
 * is the only thing that should be ordering turns.
 */
export async function buildRetrievalRelevanceIndex(
  embedding: EmbeddingModel,
  cases: readonly RelevanceCase[],
  options: RelevanceIndexOptions = {},
): Promise<RelevanceIndex> {
  const topK = options.topK ?? DEFAULT_RELEVANCE_TOP_K;
  // Resolved once, outside the loop, for the reason `retrieve` is: a run cannot mix two weights across
  // questions, and a weight of zero has to mean the shipped ranking rather than an approximate one.
  const temporalWeight = options.temporalWeight ?? 0;
  // Resolved once, outside the loop, so a run cannot mix two mechanisms across questions.
  const retrieve: Retrieval =
    options.retrieve ??
    ((queries, context, width) =>
      retrieveTopKByQueries(embedding, [...queries], [...context], width));
  // Resolved once, before the first retrieval, so a run that names both refuses before it spends
  // anything: the composition of a temporal addition and a pool permutation has no registered
  // definition, and discovering that halfway through a 500-question index build would be an
  // expensive way to learn it.
  if (options.rerank !== undefined && temporalWeight > 0) {
    throw new Error(
      'A reranker and a non-zero temporalWeight cannot be configured together: both rewrite the ' +
        'relevance score by unrelated rules (an addition to the cosine versus a permutation of the ' +
        'retrieved pool) and this project has registered no order for the two. Run them as separate ' +
        'arms -- §13.4 requires those dispatches to be serial anyway.',
    );
  }
  // The provider's declared pool width, checked before anything is retrieved. See
  // `RelevanceIndexOptions.rerankMaxDocuments` for why an over-wide pool is refused rather than
  // trimmed or batched.
  const rerankMaxDocuments = options.rerankMaxDocuments;
  if (
    options.rerank !== undefined &&
    rerankMaxDocuments !== undefined &&
    topK > rerankMaxDocuments
  ) {
    throw new Error(
      `relevanceTopK=${topK} is wider than the reranker accepts in one call ` +
        `(CORTEX_MEMORY_RERANK_MAX_DOCUMENTS=${rerankMaxDocuments}), so no question could be ` +
        'reranked and every one would fall back to the retrieved order. Lower the pool to the ' +
        "provider's limit, or leave the reranker off.",
    );
  }
  const reranking =
    options.rerank === undefined
      ? undefined
      : countedRerank(options.rerank, {
          ...(options.rerankMaxDocumentChars === undefined
            ? {}
            : { maxDocumentChars: options.rerankMaxDocumentChars }),
        });

  const scores = new Map<string, Map<string, number>>();
  // The ranker's own order, kept for measurement. `scores` stays because the lookup is by
  // turn and must remain O(1); this array is what gives a turn a position.
  const ranked = new Map<string, string[]>();
  let scoredPairs = 0;
  // The census that separates "the signal fired on nothing" from "the signal was never wired". Counted over
  // distinct turn texts, the same domain `affinityFor` answers in.
  const temporal = { scored: 0, total: 0 };

  for (const entry of cases) {
    // The question first, then the case's own phrases. Order matters to the fusion --
    // `retrieveTopKByQueries` gives every ranking the same weight, and the question is
    // the ranking a run must never lose -- but not to the score, which is the turn's
    // maximum cosine across the queries that surfaced it.
    const queries = [entry.question, ...(entry.queries ?? [])];
    const hits = await retrieve(queries, entry.context, topK);
    // Built once per case, before the hits are written: the affinity is a property of the case, and a
    // per-hit recomputation would be the stateful-callback shape this module already refuses.
    const boosts =
      temporalWeight === 0
        ? null
        : temporalBoosts({
            context: entry.context,
            turnDates: entry.turnDates,
            askedAt: entry.askedAt,
          });
    if (boosts !== null) {
      temporal.scored += boosts.scored;
      temporal.total += boosts.total;
    }
    const byTurn = new Map<string, number>();
    const order: string[] = [];
    for (const hit of hits) {
      if (!byTurn.has(hit.text)) order.push(hit.text);
      // Added only to a hit the retriever surfaced. The floor stays the floor: promoting an unscored turn
      // with an affinity would let a same-day turn outrank a measured one, which reads as the signal
      // working while it is really the floor leaking.
      byTurn.set(hit.text, hit.score + temporalWeight * (boosts?.affinityFor(hit.text) ?? 0));
    }
    // The reranker sees the whole retrieved pool and decides its order; the score written is a
    // ladder over that order rather than the cross-encoder's own number. See
    // `RelevanceIndexOptions.rerank` for why the two must not be mixed, and note that the ladder is
    // assigned only after `rerankHits` has degraded -- so a fallback leaves the retrieval order and
    // the retrieval scores exactly as they were, which is what makes `fallbacks` readable.
    const finalOrder =
      reranking === undefined
        ? order
        : await rerankedOrder(entry.question, order, byTurn, reranking);
    ranked.set(entry.question, finalOrder);
    scoredPairs += byTurn.size;
    // Last write wins for a repeated question. The arm asks each question once, so
    // the case is not one the run creates; what matters is that the lookup stays a
    // function of the question's text rather than of the case's position.
    scores.set(entry.question, byTurn);
  }

  return {
    questions: cases.length,
    scoredPairs,
    topK,
    // Only present when the signal was configured, so a run that did not ask for it cannot report it as a
    // zero -- the rule `bareRetry` follows for the same reason.
    ...(temporalWeight === 0
      ? {}
      : { temporal: { scored: temporal.scored, total: temporal.total } }),
    // Only present when the stage was configured, for the reason `temporal` is.
    ...(reranking === undefined ? {} : { rerank: reranking.snapshot() }),
    relevanceFor(question: string, turn: string): number {
      return scores.get(question)?.get(turn) ?? UNSCORED_RELEVANCE;
    },
    candidatesFor(question: string): ReadonlySet<string> {
      // The ordered array read as a set, so the two views cannot disagree: one structure,
      // two questions. A second structure would be the consolidation-clock defect this
      // package has removed at three other layers.
      return new Set(ranked.get(question) ?? []);
    },
    rankedCandidatesFor(question: string): readonly string[] {
      // Copied so a caller cannot mutate the index's own array -- the reason is the same as
      // `candidatesFor`'s defensive `new Set`.
      return [...(ranked.get(question) ?? [])];
    },
  };
}

/**
 * The pool's order after the cross-encoder, with the score map rewritten as a ladder over it.
 *
 * Module-private: the only caller is the build loop above, and an export would advertise a second
 * consumer that does not exist (`tools/export-census.mjs` reports exactly that).
 *
 * ## Why the ladder is skipped when the call degraded
 *
 * `rerankHits` returns the retrieved order on a failure, so the ladder would be a permutation of
 * the identity — but it would also **replace every cosine with a position**, for a question the
 * reranker never actually ranked. One run would then hold two incompatible meanings for the number
 * `relevanceFor` returns (a similarity on the questions that worked, a rank on the ones that did
 * not), and the budget would spend those two questions' evidence under different rules while the
 * artifact reported one configuration. Leaving the retrieval scores in place keeps a degraded
 * question exactly as it was before the stage existed, which is also what makes `fallbacks` the
 * only thing a reader has to check to know which of the two happened.
 *
 * A zero-length pool cannot reach here — `rerankHits` answers `[]` without calling the scorer, and
 * the loop body would have nothing to write — so the empty case is expressed by the caller's own
 * `order.length === 0` rather than by a branch here. It is not: the `forEach` below is a no-op on an
 * empty array, and returning early would be the unreachable-branch shape this repository's coverage
 * gate has removed before.
 */
async function rerankedOrder(
  question: string,
  order: readonly string[],
  byTurn: Map<string, number>,
  reranking: CountedRerank,
): Promise<string[]> {
  const candidates = order.map((text) => ({ id: text, text, score: byTurn.get(text) ?? 0 }));
  const fallbacksBefore = reranking.snapshot().fallbacks;
  const reranked = await rerankHits(candidates, question, reranking.score);
  const degraded = reranking.snapshot().fallbacks > fallbacksBefore;
  const finalOrder = reranked.map((candidate) => candidate.id);
  reranking.observeOrder(order, finalOrder);
  if (degraded) {
    return finalOrder;
  }
  // Strictly decreasing, inside `(0, 1]`: above `UNSCORED_RELEVANCE` for every provider's scale
  // (including the negative logits a local cross-encoder returns), and with no ties, so the sort
  // downstream cannot fall back to an arrival order the reranker meant to replace.
  const width = finalOrder.length;
  finalOrder.forEach((text, index) => byTurn.set(text, (width - index) / width));
  return finalOrder;
}

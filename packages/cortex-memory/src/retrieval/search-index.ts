/**
 * The product's retrieval stack: an index it builds, a fusion it chooses, a reranker it composes.
 *
 * ## The gap this closes
 *
 * `docs/AUDIT-SEMANTIC-REACH.md` §8 records the ownership of the four things an answering system needs.
 * `cortex-memory` owned one of them. The **reader** is here (`prompt.ts`, `parse.ts`, `#consult`); the
 * **judge** is correctly the instrument's (`cortex-eval`'s `question-record.ts`), because a ruler may not
 * live inside the thing it measures. **Retrieval and rerank were not here**: `relevanceFor` is a
 * synchronous `(question, turn) => number` that the *caller* supplies, so the product could rank turns only
 * if someone else had already scored them, and with no callback it fell back to arrival order
 * (`chooseEvidence` → `truncateCodePointSafe`). A product that answers only when the harness hands it a
 * ranking is a component of the harness, not a product.
 *
 * ## Why the model is injected and the algorithm is not
 *
 * `relevance.ts` criterion 3 is "I/O-free and model-free -- no embedding, no LLM", and that property is what
 * lets `cortex-memory` depend on `cortex-core` alone. The way to keep it while owning retrieval is the one
 * this repository already uses for the reader: `LLM` is an interface the class is handed, not a client it
 * constructs. `EmbedFn` is the same arrangement -- batched, because a per-turn call cannot be priced or
 * cached -- and an index with no `embed` is still a working lexical index rather than a broken one.
 *
 * ## The three decisions, and what each refuses
 *
 * 1. **The lexical channel is `lexicalRelevance`.** Not a second scorer with the same name: one definition
 *    of relevance, so a run with the index and a run with `relevanceFor = lexicalRelevance` differ only in
 *    the channels added. The postings list is used to *narrow* the candidates and never to score them —
 *    with the one exception `lexicalWeighting: 'idf'` states, where the postings' document frequencies price
 *    a query term. That is still the same definition of relevance; what a corpus adds is what each of its
 *    terms is worth, which no pair of strings can know.
 * 2. **Fusion is by rank (RRF), not by score.** Cosine lives in `[0, 1]`, the lexical score in `[0, 1]`,
 *    and a future BM25 channel in neither -- summing them needs a normaliser tuned per corpus, which is a
 *    free parameter the benchmark would then be measuring. Ranks are the one thing channels agree on.
 * 3. **A degraded stage is counted.** `rerankHits` returns the input order on every scorer failure, which
 *    is right for the prompt and wrong to read as agreement: an endpoint answering 401 five hundred times
 *    and a cross-encoder that agreed every time produce the same accuracy. `census()` reports `calls`
 *    beside `degraded` so those two runs cannot be confused.
 * 4. **A question may be several queries.** `queryPlan` hands this class a query set per question, and the
 *    per-query rankings are fused by the same RRF as the channels. The algorithm was the instrument's
 *    (`cortex-eval`'s `retrieveTopKByQueries`) and only the *phrases* remain its; §34 of the plan records
 *    why the fusion had to move before "the reader issues its own queries" could be a product capability
 *    rather than an instrument privilege. `channels` is the same argument for the other axis: dense-only
 *    and hybrid are two configurations `cortex-eval` measured, so a deployment has to be able to pick one.
 *
 * ## Why the score after fusion or rerank is a position
 *
 * The prompt spends its room by sorting on the number this module returns (`chooseEvidence` →
 * `selectByRelevance`), so a map that preserved the channel's raw score would silently undo the reranker:
 * the fused order would be recomputed from magnitudes the reranker never saw. Once more than one stage
 * decides the order, the only number that can carry the decision is the rank.
 *
 * ## The cost of a rebuilt index, and the one option that removes it
 *
 * `prime()` embeds the whole corpus. The corpus arrives per question, so an index is built per question, and
 * without a store each question pays for the haystack again — on LongMemEval-S that is roughly five hundred
 * texts per question. `store` is a `EmbeddingMemo`'s backing map supplied by the owner of the instance, so the
 * second question embeds one text instead of five hundred and one, and `SearchCensus.memoHits` says how many
 * it did not pay for. What the option refuses is the case where a rebuilt index is silently cheaper than a
 * changed one: the memo is keyed on the text, so a corpus that gained a turn pays for that turn only.
 */
import {
  EmbeddingMemo,
  rerankHits,
  type EmbedFn,
  type EmbeddingCacheStore,
  type EmbeddingVector,
  type RerankScoreFn,
  type VectorEraser,
} from '@agentix-e/cortex-core';

import { lexicalRelevance, contentTerms, type TermWeight } from '../relevance.js';

/** How many hits a search returns unless the caller says otherwise. */
const DEFAULT_K = 64;

/** The RRF constant. `60` is the value from the original literature and the one `fuse.ts` uses. */
const DEFAULT_RRF_K = 60;

/**
 * How the lexical channel values a query term.
 *
 * Two names, and they are the two configurations this repository has measured: `flat` counts every content
 * term as one, and `idf` weights it by how rare it is in the corpus being searched. `flat` is the default
 * because it is the definition every archived artifact was produced under -- `S14`, the vector arm, and the
 * `relevanceFor = lexicalRelevance` path -- and a default that changed a published number would make two
 * artifacts incomparable without saying so.
 *
 * Not exported: it is `SearchIndexOptions.lexicalWeighting`'s type and nothing names it on its own -- a caller
 * writing `lexicalWeighting: 'idf'` needs the option, not the name. `tools/export-census.mjs` reported it as an
 * orphan when it was exported, which is the gate doing its job (the same ruling `WidthPlanReason` is under).
 */
type LexicalWeighting = 'flat' | 'idf';

/**
 * A channel that ranks turns.
 *
 * Two names, because two is what this product ships: postings over content terms, and cosine over embedded
 * vectors. A reranker is not one -- it permutes a pool the channels produced, so it appears in
 * {@link SearchCensus.channels} as a stage and never in this list.
 */
export type SearchChannel = 'lexical' | 'vector';

/**
 * The query set for one question.
 *
 * A function rather than a list because the queries are a property of the *question*, and the question is
 * not known until it is asked. It may be asynchronous: producing phrases is a model call in the
 * configuration `cortex-eval` measured (`buildQueryExpansionPrompt`), and a synchronous signature would
 * have forced every such caller to precompute a table keyed by question before the index existed.
 *
 * What this type does **not** do is answer with a *plan* the product then interprets. There is no schema,
 * no width, and no ranking hint: the return value is a list of strings that become queries, and every
 * property that matters -- deduplication, blank removal, the batch that carries them to the embedder -- is
 * the index's job, stated in {@link SearchIndexOptions.queryPlan}.
 */
export type QueryPlan = (question: string) => readonly string[] | Promise<readonly string[]>;

/**
 * How many texts one embedding request may carry unless the caller says otherwise.
 *
 * `64` is Zhipu's documented per-request cap and the constant `cortex-eval`'s `retrieval.ts` already
 * batches at, so a measured run and the product cannot disagree about how many texts one request carried.
 * It is a default rather than a constant because the cap is a property of the deployment, not of this
 * algorithm: a provider that allows more should be allowed to pay fewer requests for the same corpus.
 */
const DEFAULT_BATCH = 64;

export type SearchIndexOptions = {
  /**
   * The vector channel: texts in, one vector per text out, same order.
   *
   * Batched rather than per-text because the cost of a retrieval stack is dominated by the number of calls,
   * and a per-text signature would hide a four-hundred-call index behind a loop. `readonly number[]` rather
   * than `Float64Array` so a fake in a test and a real client are both natural; the module reads nothing but
   * the values.
   *
   * The parameter is `string[]` rather than `readonly string[]` so that `EmbeddingModel.embed` is assignable
   * to it directly. A `readonly` parameter refuses a function that takes a mutable array, which is every
   * published client, and the friction that produced was one adapter lambda per call site — a real reason the
   * cache below went unused for a round.
   *
   * Absent means a lexical index, which is still a working one.
   */
  readonly embed?: EmbedFn | undefined;
  /**
   * Where vectors are remembered between indexes. Present means texts are embedded once **per store**, not
   * once per index.
   *
   * This is the field that makes an index over a stable corpus affordable. The corpus arrives per question
   * (`answerSessions`), so without it every question embeds the whole haystack again — the dominant term in
   * the cost axis, and the one an `import` away from disappearing.
   *
   * The store must be scoped to one `embed` function: a bare batch function states no space, so two functions
   * sharing a store would hand each other's vectors across. `CortexMemory` creates one store per instance for
   * exactly that reason.
   */
  readonly store?: EmbeddingCacheStore | undefined;
  /**
   * Whether to memoise through `store`. Defaults to `true`.
   *
   * An off switch rather than an on switch, because the safe configuration is the one where a text is paid for
   * once and the unsafe one is a **non-deterministic** embedder: a model whose vector for one text drifts
   * between calls would make two questions share a vector neither of them produced. A run that sets this to
   * `false` is claiming its embedder is not deterministic, and `SearchCensus.reuse` records which claim the
   * artifact was produced under — two runs that disagree here are not comparable and the census is how a
   * reader finds out.
   */
  readonly reuse?: boolean | undefined;
  /** The cross-encoder stage. Absent means the fused order is the final order. */
  readonly rerank?: RerankScoreFn;
  /** How many hits a search returns. */
  readonly k?: number;
  /**
   * How many texts one embedding request may carry. Defaults to 64.
   *
   * The cap is the deployment's, not the algorithm's: Zhipu refuses more than 64 inputs per request
   * (`code 1214`), OpenAI allows far more, and a local model may prefer 8. The default is the smallest cap
   * this repository measures against, which is the safe direction — a corpus is chunked into more requests
   * rather than into a request the provider rejects. The first dispatch of a run where the product ranked
   * for itself died on exactly that rejection in 90 ms, which is what this option and `prime()`'s loop are
   * for: nothing in a unit test with a fake embedder could see it.
   *
   * A value below 1 is refused rather than clamped, because a batch of zero asks for an unbounded number
   * of empty requests and the corpus would never be embedded.
   */
  readonly batch?: number;
  /** The RRF constant. Exposed because a second index in the same run must not silently use another one. */
  readonly rrfK?: number;
  /**
   * How the lexical channel values one query term. Defaults to `flat`.
   *
   * ## Why a corpus is allowed to say what a term is worth
   *
   * Because `flat` has a measured failure. Coverage divides by the number of distinct content terms, so three
   * matched generic words beat one matched noun: `"How many bikes do I own?"` ranked a turn containing
   * `how, many, own` at **0.637** above the gold turn containing `bikes` at **0.425**, and on the twenty-one
   * `S14` questions that delivered no gold turn, twenty were lost this way rather than to a missing term.
   * The term that decides the answer is the rare one, and rarity is only visible against a corpus.
   *
   * `idf` weights each query term by `ln(1 + (N - df + 0.5) / (df + 0.5))` over the turns this index holds:
   * a term in every turn is worth about `0.001`, a term in one turn of five hundred about `5.8`, and no term
   * is worth zero. This is the Robertson/Sparck-Jones form Lucene uses, and it is **corpus-derived rather
   * than corpus-fitted** -- there is no constant here chosen from an answer key, which is why it is a
   * weighting rather than a fit. The smoother `ln(1 + N / (1 + df))` was tried first and rejected on this
   * repository's own numbers: at a corpus of ten turns it separates a rare term from a common one by 2.4x,
   * which is not enough to overcome three matched common terms, while the form below separates them by 13x.
   *
   * ## Why the default is `flat`
   *
   * Because `flat` is what every number in this repository was measured under, and because the honest order
   * is measure-then-adopt: the instrument prices either weighting at zero, so a default can be changed on
   * evidence rather than on the argument above. A run that selects `idf` states it in
   * `memoryArmConfig.lexicalWeighting`, which is what keeps two artifacts from being compared as if they
   * ranked the same way.
   *
   * Ignored by the vector channel, which ranks by cosine and never consults a term.
   */
  readonly lexicalWeighting?: LexicalWeighting;
  /**
   * What to do when the embedder cannot produce a query vector.
   *
   * `'fail'` (default) rethrows. `'lexical'` degrades **this retrieval** to the lexical channel, counts it
   * in {@link SearchCensus.embedDegraded}, and keeps the provider's message in
   * {@link SearchCensus.embedFailure}.
   *
   * ## Why the default is the loud one
   *
   * `indexEmbedding: injected` in an artifact means the vector channel ranked. A deployment that silently
   * scored lexically instead would publish numbers under a configuration it did not run — and the numbers
   * would look entirely reasonable, because the lexical index is a working index (`S14`: 85.75%). The
   * failure mode of a quiet default is therefore a plausible wrong reading rather than a crash, which is
   * the one shape this repository refuses to leave in place.
   *
   * ## Why the opt-in exists at all
   *
   * Because the alternative is worse than degrading. Run `43866639154` configured the embedder, passed the
   * one-vector preflight, ran for two hours, and then met an exhausted provider balance at repetition 3 of
   * 8 — taking `432` graded answers with it. A long benchmark cannot buy insurance against a balance that
   * empties mid-run; what it can do is state in advance that a retrieval it cannot vectorise will be
   * scored the way the product scores when there is no embedder, and record how often that happened. The
   * cost of that choice is already measured, so a reader can price it rather than guess.
   */
  /**
   * What to do when the embedder cannot produce a query vector.
   *
   * `'fail'` (default) rethrows. `'lexical'` degrades **this retrieval** to the lexical channel, counts it
   * in {@link SearchCensus.embedDegraded}, and keeps the provider's message in
   * {@link SearchCensus.embedFailure}.
   *
   * ## Why the default is the loud one
   *
   * `indexEmbedding: injected` in an artifact means the vector channel ranked. A deployment that silently
   * scored lexically instead would publish numbers under a configuration it did not run — and the numbers
   * would look entirely reasonable, because the lexical index is a working index (`S14`: 85.75%). The
   * failure mode of a quiet default is therefore a plausible wrong reading rather than a crash, which is
   * the one shape this repository refuses to leave in place.
   *
   * ## Why the opt-in exists at all
   *
   * Because the alternative is worse than degrading. Run `43866639154` configured the embedder, passed the
   * one-vector preflight, ran for two hours, and then met an exhausted provider balance at repetition 3 of
   * 8 — taking `432` graded answers with it. A long benchmark cannot buy insurance against a balance that
   * empties mid-run; what it can do is state in advance that a retrieval it cannot vectorise will be
   * scored the way the product scores when there is no embedder, and record how often that happened. The
   * cost of that choice is already measured, so a reader can price it rather than guess.
   */
  readonly onEmbedFailure?: 'fail' | 'lexical';
  /**
   * The queries to rank for one question. Absent means the question alone.
   *
   * ## Why this is a product capability and not an instrument one
   *
   * `cortex-eval` has fused several rankings per question since `retrieveTopKByQueries` was written: a
   * question about "how many projects" is answered by turns that say "led a consumer-research project", and
   * no single query reaches both. The mechanism was measured on the instrument side and the product had no
   * way to express it, which is the exact gap the sixteenth constraint names -- a capability the ruler
   * proved and the customer cannot reach. The fusion moved here; the *phrases* stayed there, because
   * producing them is an LLM call and this package owns no provider.
   *
   * ## What the index does with the list
   *
   * Entries are trimmed, blanks are dropped, and duplicates are removed **keeping first appearance**, before
   * anything is embedded. A duplicate query would otherwise vote twice for one ranking and the census would
   * report a query set the run did not issue. A plan that ends up naming nothing -- `[]`, or a list of blank
   * strings -- falls back to the question: a plan that could not speak is not a treatment, and answering
   * from an empty query set would return no evidence at all while the prompt still looked assembled.
   *
   * One surviving query is the single-query path, byte for byte. That is not an optimisation: the
   * single-query path returns the lexical channel's own scores, and a one-element fusion would re-base them
   * on rank -- the same order, different numbers, and a prompt that differs on ties. A run whose expansion
   * produced nothing therefore costs what the unexpanded run costs, which is what makes an `llm` expansion
   * arm comparable with its control.
   *
   * ## What it costs
   *
   * The whole query set is embedded in **one** request, not one per query: the batch is the unit providers
   * bill and cap (`EmbeddingModel.embed` takes a list for that reason), so four phrases cost one call and
   * `census().embedTexts` grows by four. A provider that refuses the batch refuses the retrieval, and
   * `onEmbedFailure` decides what happens next.
   *
   * ## What it refuses to do
   *
   * It does not catch a plan's failure. A plan that throws -- an LLM endpoint answering 401, a table that
   * is not there -- propagates, because a retrieval that quietly answered from the bare question would
   * produce the control's ranking under the treatment's name, and the accuracy it reports would be a
   * measurement of the wrong arm. The alternative (`onEmbedFailure`'s `'lexical'`) exists for a *provider*
   * that runs out of balance mid-run; a plan is configuration, and a broken configuration is a message, not
   * a degradation.
   */
  readonly queryPlan?: QueryPlan | undefined;
  /**
   * Which channels rank. Defaults to `['lexical', 'vector']` -- the hybrid configuration, which is the one
   * every reading in this repository was taken with.
   *
   * ## Why the choice is on the product
   *
   * Because it is a measured variable on the instrument side and was not expressible here. `cortex-eval`
   * dispatches `retrieval` (dense) beside `retrieval-hybrid` (dense fused with keyword recall), so the
   * difference between the two is a number with a name; a deployment that wants dense-only had no way to ask
   * this class for it, and a deployment paying for an embedding quota had no way to stop paying for
   * postings. Both are real deployment decisions, and a product that answers only the hybrid question is a
   * product whose retrieval is not configurable.
   *
   * ## The two things it changes besides the ranking
   *
   * `['vector']` builds no postings, so `census().terms` is `0` and the memory a corpus costs is the vector
   * table alone. `['lexical']` never embeds: `prime()` returns without a request and a search makes none, so
   * a deployment that has decided against vectors is not billed for its corpus. Neither is a silent
   * degradation -- the census's `channels` names what ranked, which is why the field exists.
   *
   * ## The two configurations it refuses
   *
   * `[]` ranks on nothing and would answer every question with no evidence while reporting a healthy
   * census. `['vector']` without {@link SearchIndexOptions.embed} claims a channel that cannot run; the
   * refusal is on the *explicit* claim only, because the default naming `vector` with no embedder is not a
   * claim but the ordinary lexical index this product documents.
   */
  readonly channels?: readonly SearchChannel[] | undefined;
};

/**
 * One retrieved turn: its position in the corpus, and the score the prompt will sort on.
 *
 * Not exported, because nothing outside this file names it: `SearchIndex.search` is the only way to
 * obtain one, and every caller either uses it structurally or reads `.turn`/`.score` directly. It
 * was on the barrel while `@agentix-e/cortex-agent` imported it; that package now declares its own
 * structurally identical type so it can depend on `cortex-core` alone, and the export census
 * refused the barrel entry the moment the last caller left. The declaration still travels in
 * `dist` -- TypeScript emits it beside the class -- so consumers see the same shape.
 */
type SearchHit = {
  readonly turn: number;
  readonly score: number;
};

/**
 * What the index did, in the terms a report can print.
 *
 * `turns` and `terms` describe the corpus; `vectors`, `embedCalls`, `embedTexts`, `memoHits` and `reuse`
 * describe the vector channel; `rerankCalls` beside `rerankDegraded` is the pair that separates "the stage ran
 * and agreed" from "the stage ran and returned its input because it failed".
 *
 * `embedCalls` counts **batches that reached the model**, and `embedTexts` the texts in them. The pair exists
 * because a batch count alone cannot describe work: an index over five hundred turns makes two calls whether it
 * embedded five hundred texts or two, so a report that printed only `embedCalls` would price a cached second
 * question identically to an uncached first one. `memoHits` is the number that explains the difference, and
 * `reuse` says whether the run had a store at all — a question whose `embedTexts` equals its corpus size on a
 * corpus that has already been seen is a question that was asked twice, not a corpus that changed.
 */
export type SearchCensus = {
  readonly turns: number;
  readonly terms: number;
  readonly vectors: number;
  /** Batches that reached the model. Zero when every text was served from the store. */
  readonly embedCalls: number;
  /** Texts that reached the model. The only count on the bill. */
  readonly embedTexts: number;
  /** Texts served by the store instead of the model. */
  readonly memoHits: number;
  /** Whether a store was in front of the embedder at all. */
  readonly reuse: boolean;
  readonly rerankCalls: number;
  readonly rerankDegraded: number;
  /**
   * Retrievals whose vector channel failed and were scored lexically instead.
   *
   * Always present, so an artifact cannot say "no failures" and "the field predates this run" with the
   * same bytes. Zero on a run whose embedder worked. Non-zero means the census's `channels` describe what
   * this index **is** rather than what it managed to do on every question, and a reader comparing it with
   * a run at zero is comparing two products.
   */
  readonly embedDegraded: number;
  /** The provider's own message from the most recent failure, or `null` when none failed. */
  readonly embedFailure: string | null;
  /**
   * How many queries the **most recent** search issued; `0` before the first one.
   *
   * A per-call count and not a run total, for the reason {@link SearchCensus.embedTexts} is a total and this
   * is not: an index is built per question, so the per-search count *is* the question's query set, and
   * summing it across searches would describe a corpus. It is reported because the difference between "the
   * plan returned four phrases" and "the plan returned one and fell back" is invisible in the prompt when
   * both rank the same turns, and a reader deciding whether an expansion arm acted needs that difference.
   */
  readonly queries: number;
  readonly channels: readonly ('lexical' | 'vector' | 'rerank')[];
};

/**
 * What the product's own retrieval has cost this instance, across every index it built.
 *
 * `lastIndexCensus()` answers "what did the index for *this* question do". This answers "what has the
 * retrieval stack cost the run so far", and neither is derivable from the other: a per-question census is
 * overwritten by the next question, and a run whose corpus arrives per question pays for a corpus per
 * question. Reading the last one and multiplying by the question count would be an estimate of the bill,
 * which is the exact substitution this repository keeps finding -- so the sum is taken where the censuses
 * are produced and the artifact reports a counted number.
 *
 * `reuse` is `true` only when **every** index in the run had a store in front of its embedder. One index
 * without one is enough to make the total incomparable with a run that had one throughout, and an `and`
 * over the per-index flags is the only spelling that says so.
 */
export type IndexCost = {
  /** Indexes built, which for this product is one per ranked question. */
  readonly indexes: number;
  /** Corpus turns the indexes were built over, summed. */
  readonly turns: number;
  readonly embedCalls: number;
  readonly embedTexts: number;
  readonly memoHits: number;
  /** Whether every index ran behind a store. A mixed run reads `false` and is not comparable. */
  readonly reuse: boolean;
  readonly rerankCalls: number;
  readonly rerankDegraded: number;
  /** Retrievals across the run that fell back to lexical scoring. See `SearchCensus.embedDegraded`. */
  readonly embedDegraded: number;
  /**
   * Queries the run issued, summed over every retrieval.
   *
   * `queries > indexes` is the whole receipt of "this run retrieved with more than the question", and it is
   * a product count rather than a harness one: the number is written by the index that issued the queries.
   * That is what makes a dispatched query plan falsifiable from the artifact -- a run whose configuration
   * says the reader wrote phrases and whose bill shows one query per index is a control run wearing the
   * treatment's name, and `assertQueryExpansionReached` is the check that refuses to write it.
   */
  readonly queries: number;
};

/**
 * One more index's census added to the running total.
 *
 * A fold rather than a counter on the index, because the index lives for one question and the total has to
 * outlive it. Absent input is the first index, so a caller never seeds a zero record it would then have to
 * keep in step with this type -- a seed is a second copy of the field list, and the copy that drifts is
 * always the one nothing reads.
 */
export function foldIndexCost(previous: IndexCost | undefined, census: SearchCensus): IndexCost {
  return {
    indexes: (previous?.indexes ?? 0) + 1,
    turns: (previous?.turns ?? 0) + census.turns,
    embedCalls: (previous?.embedCalls ?? 0) + census.embedCalls,
    embedTexts: (previous?.embedTexts ?? 0) + census.embedTexts,
    memoHits: (previous?.memoHits ?? 0) + census.memoHits,
    reuse: (previous?.reuse ?? true) && census.reuse,
    rerankCalls: (previous?.rerankCalls ?? 0) + census.rerankCalls,
    rerankDegraded: (previous?.rerankDegraded ?? 0) + census.rerankDegraded,
    embedDegraded: (previous?.embedDegraded ?? 0) + census.embedDegraded,
    queries: (previous?.queries ?? 0) + census.queries,
  };
}

/**
 * Cosine similarity over two equal-length vectors, `0` when either is the zero vector.
 *
 * Equal length is a precondition rather than something this function repairs. A `min(a.length, b.length)`
 * with `?? 0` fallbacks would score a query of one width against a corpus of another by silently comparing
 * their first `n` components -- a number that looks like a similarity and is not -- so the caller validates
 * the widths once and this stays arithmetic.
 */
function cosine(a: EmbeddingVector, b: EmbeddingVector): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let axis = 0; axis < a.length; axis += 1) {
    const x = a[axis]!;
    const y = b[axis]!;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  if (left === 0 || right === 0) return 0;
  return dot / Math.sqrt(left * right);
}

/**
 * Which channels a call asked for, resolved once so a corpus cannot be indexed two ways.
 *
 * The refusals are the two configurations that would answer every question with no evidence:
 *
 * - an empty list, which names no channel at all;
 * - `['vector']` with no embedder, which names one that cannot run here.
 *
 * Note what is **not** refused: `['lexical', 'vector']` with no embedder. The vector channel is then inert
 * rather than absent, which is the state every lexical reading in this repository was taken in, and the
 * census's `channels` says which ones actually ranked. Refusing it would make spelling out the default an
 * error while omitting it is fine -- a rule a caller cannot predict from the option's documentation.
 */
function normalizeChannels(
  raw: readonly SearchChannel[] | undefined,
  hasEmbed: boolean,
): { lexical: boolean; vector: boolean } {
  if (raw === undefined) return { lexical: true, vector: true };
  const known: readonly string[] = ['lexical', 'vector'];
  for (const name of raw) {
    if (!known.includes(name)) {
      throw new Error(
        `SearchIndexOptions.channels may only name ${known.map((k) => JSON.stringify(k)).join(' or ')}, ` +
          `got ${JSON.stringify(String(name))}. A channel name the index does not administer would be a ` +
          'configuration line that reads as a treatment and ranks nothing.',
      );
    }
  }
  const lexical = raw.includes('lexical');
  const vector = raw.includes('vector');
  if (!lexical && !vector) {
    throw new Error(
      'SearchIndexOptions.channels must name at least one channel: an index that ranks on nothing ' +
        'answers every question with no evidence while reporting a healthy census, which is the one ' +
        'failure this product has no way to detect downstream.',
    );
  }
  if (vector && !lexical && !hasEmbed) {
    throw new Error(
      "SearchIndexOptions.channels names only 'vector' but no embedder was supplied, so there is " +
        'nothing to rank with and every search would return no evidence. Supply `embed`, or name ' +
        "'lexical' as well (the vector channel is then inert, as it is when `channels` is omitted).",
    );
  }
  return { lexical, vector };
}

/**
 * Refuse a weighting the product does not administer, naming the two it does.
 *
 * Refused rather than defaulted, for the reason `channels` refuses an unknown name: a misspelt weighting is a
 * line that reads as a treatment and ranks flat, so the run would publish a candidate comparison that compared
 * a configuration with itself.
 *
 * Exported because there are **two** moments a caller can get this wrong, and the index only sees the second.
 * `CortexMemory` builds an index per question, so a check that lived in this file alone would fire after the
 * first `remember()` -- on a store that may already hold the user's data -- while the typo is in the
 * `assembleMemory` call the caller can read. The message lives here so both moments give the same one.
 */
export function assertLexicalWeighting(weighting: string | undefined): void {
  if (weighting === undefined || weighting === 'flat' || weighting === 'idf') return;
  throw new Error(
    `SearchIndexOptions.lexicalWeighting may only be "flat" or "idf", got ` +
      `${JSON.stringify(String(weighting))}. "flat" counts every content term as one; "idf" weights it ` +
      'by ln(1 + (N - df + 0.5) / (df + 0.5)) over the turns this index holds.',
  );
}

export class SearchIndex implements VectorEraser {
  readonly #options: SearchIndexOptions;
  readonly #turns: string[] = [];
  /** Term to the positions of the turns containing it, one entry per turn. */
  readonly #postings = new Map<string, number[]>();
  /**
   * The embedder as this index sees it.
   *
   * Never the caller's function directly: the counters have to be incremented at the model boundary, and a
   * memo in between would hide the call entirely. Absent means a lexical index.
   */
  readonly #model: EmbedFn | undefined;
  /** The memo in front of `#model`, when a store was supplied and reuse was not refused. */
  readonly #memo: EmbeddingMemo | undefined;
  #vectors: readonly EmbeddingVector[] = [];
  #primed = false;
  #embedCalls = 0;
  #embedTexts = 0;
  #rerankCalls = 0;
  #rerankDegraded = 0;
  /** Retrievals scored lexically because the embedder failed. See `SearchIndexOptions.onEmbedFailure`. */
  #embedDegraded = 0;
  /** The most recent embedder failure message, or `null`. Kept because the repairs differ by cause. */
  #embedFailure: string | null = null;
  /** How many texts one request may carry. Resolved once, so a corpus cannot be chunked two ways. */
  readonly #batch: number;
  /** Whether the lexical channel ranks. See `SearchIndexOptions.channels`. */
  readonly #lexical: boolean;
  /** Whether the vector channel ranks. See `SearchIndexOptions.channels`. */
  readonly #vector: boolean;
  /**
   * What the lexical channel charges for a query term.
   *
   * A function rather than the name, because the two places that score a turn -- `#lexicalOrder`, which
   * ranks every candidate, and `#searchOne`, which reports the score beside the order it produced -- must
   * agree, and agreeing on a name would not prevent them from disagreeing on the arithmetic.
   */
  readonly #termWeight: TermWeight;
  /** How many queries the most recent search issued. See {@link SearchCensus.queries}. */
  #lastQueries = 0;

  constructor(options: SearchIndexOptions = {}) {
    this.#options = options;
    const batch = options.batch ?? DEFAULT_BATCH;
    // Refused rather than clamped: a batch of zero asks for an unbounded number of empty requests, and a
    // negative one asks for a loop that never advances. Both are configuration errors a message can fix.
    if (!Number.isInteger(batch) || batch < 1) {
      throw new Error(
        `SearchIndexOptions.batch must be a positive integer, got ${String(options.batch)}. One request ` +
          'carries at most this many texts; providers cap it (Zhipu refuses more than 64 per request, ' +
          'code 1214), and a value below 1 would never embed the corpus the index was built for.',
      );
    }
    this.#batch = batch;
    const channels = normalizeChannels(options.channels, options.embed !== undefined);
    this.#lexical = channels.lexical;
    this.#vector = channels.vector;
    assertLexicalWeighting(options.lexicalWeighting);
    const weighting = options.lexicalWeighting ?? 'flat';
    // Bound to the corpus this index holds, and read at search time rather than frozen at construction:
    // `add()` fills the postings and the turn count before `prime()`, so a weight captured in the
    // constructor would price every term against an empty corpus.
    this.#termWeight =
      weighting === 'flat'
        ? () => 1
        : (term: string): number => {
            const df = this.#postings.get(term)?.length ?? 0;
            const total = this.#turns.length;
            return Math.log(1 + (total - df + 0.5) / (df + 0.5));
          };
    const embed = options.embed;
    if (embed === undefined) return;

    // Counted here, at the boundary the bill is drawn on, rather than around the caller's function: with a
    // memo in front, "how many calls did the index make" and "how many did the model serve" are different
    // questions, and only the second one is a cost. Counting outside the memo would report a cached question
    // as if it had re-embedded the corpus.
    const counted: EmbedFn = async (texts) => {
      this.#embedCalls += 1;
      this.#embedTexts += texts.length;
      return embed(texts);
    };

    if (options.store === undefined || options.reuse === false) {
      this.#model = counted;
      return;
    }
    const memo = new EmbeddingMemo(counted, { store: options.store });
    this.#memo = memo;
    this.#model = (texts) => memo.embed(texts);
  }

  /**
   * Add turns to the corpus.
   *
   * Refused once `prime()` has run, because a vector table computed over two turns does not cover a third
   * and nothing downstream can detect the gap: the unembedded turn would rank only lexically, which reads
   * as "the vector channel disagreed" rather than "the vector channel never saw it".
   */
  add(turns: readonly string[]): void {
    if (this.#primed) {
      throw new Error(
        `cannot add ${turns.length} turn(s) to a primed index: the vector table was computed over ` +
          `${this.#turns.length} turn(s) and would not cover the corpus. Build a new index, or add before ` +
          'priming.',
      );
    }
    for (const turn of turns) {
      const position = this.#turns.length;
      this.#turns.push(turn);
      // The postings are what the lexical channel ranks on, and a call that withheld that channel pays for
      // them otherwise: one entry per (term, turn) over the whole corpus is the dominant memory term on a
      // large haystack. `census().terms` reads `0` for such a run and `channels` says why.
      if (!this.#lexical) continue;
      for (const term of new Set(contentTerms(turn))) {
        const posting = this.#postings.get(term);
        if (posting === undefined) this.#postings.set(term, [position]);
        else posting.push(position);
      }
    }
  }

  /**
   * Compute the vector channel, one request at a time.
   *
   * Called once per corpus, before any question. An index with no embedder primes to a lexical index; an
   * empty corpus primes to nothing and calls no model, because a batch of zero texts is a request whose
   * only possible answer is "there was nothing to embed".
   *
   * ## Why this is a loop and not one call
   *
   * It was one call, and the first real dispatch died on it in ninety milliseconds:
   *
   *     Embedding request failed: 400 Bad Request —
   *     {"error":{"code":"1214","message":"input数组最大不得超过64条"}}
   *
   * A LongMemEval haystack is ~500 turns, so "embed the corpus in one batch" is a request no capped
   * provider will serve. The property is not Zhipu's: a per-request input cap is the norm, and this
   * repository already batches at 64 in `cortex-eval`'s `retrieval.ts` for exactly that reason. So the
   * chunking belongs here, where the corpus size is known, rather than in every embedder a caller might
   * inject — an `embed` function that silently truncated or chunked would hide either the work or the
   * failure, and the census below counts what actually crossed the wire.
   *
   * The per-index counts change meaning with the loop and that is the point: `embedCalls` becomes the
   * number of requests the corpus cost (five for 300 turns at the default) while `embedTexts` stays the
   * number of texts. The pair was built to be read this way — a batch count alone cannot price a corpus.
   */
  async prime(): Promise<void> {
    this.#primed = true;
    const model = this.#model;
    // A call that withheld the vector channel does not pay for it. `#model` is still built -- the counters
    // and the memo are properties of the instance -- but nothing crosses the wire, which is what makes
    // `channels: ['lexical']` a cost decision and not only a ranking one.
    if (!this.#vector || model === undefined || this.#turns.length === 0) return;

    const vectors: EmbeddingVector[] = [];
    try {
      for (let at = 0; at < this.#turns.length; at += this.#batch) {
        const slice = this.#turns.slice(at, at + this.#batch);
        const part = await model(slice);
        if (part.length !== slice.length) {
          throw new Error(
            `the embedder was given ${slice.length} texts and returned ${part.length} vectors; a ` +
              'short reply would leave turns unscoreable and the index would report a ranking it did not ' +
              'compute',
          );
        }
        vectors.push(...part);
      }
    } catch (error) {
      // `CortexMemory` primes one index per question, so a refusal here costs the whole retrieval stack
      // for that question rather than one ranking -- and it is reached before any question is asked, which
      // is why the alternative to degrading is a run that dies on its first question after the balance
      // empties. The policy is the caller's for the reason `onEmbedFailure` gives.
      if (this.#options.onEmbedFailure !== 'lexical') throw error;
      this.#embedDegraded += 1;
      this.#embedFailure = error instanceof Error ? error.message : String(error);
      // `#vectors` stays empty. ``vectors`` above holds whatever batches arrived, and assigning a short
      // table would shift every entry: `#vectors[position]` must describe `#turns[position]`, so two
      // vectors for three turns would score each turn against its neighbour's vector -- a ranking that
      // reads as the channel disagreeing and is a table that moved. A lexical index is a configuration
      // this product ships; a shifted vector table is a wrong answer nothing can detect.
      return;
    }
    this.#vectors = vectors;
  }

  /**
   * The best `k` turns for `question`, best first.
   *
   * One question is one retrieval, and a retrieval may rank several queries. The resolution is here rather
   * than inside either branch because both branches have to agree on what `census().queries` reports, and a
   * count taken inside one of them would read `0` on the other.
   *
   * Lexical scores are the channel's own when it is the only channel; once fusion or rerank decides the
   * order, the score is the position, because two channels and one cross-encoder do not share a scale with
   * the lexical signal and the prompt sorts on the number it is given.
   */
  async search(question: string, k = this.#options.k ?? DEFAULT_K): Promise<readonly SearchHit[]> {
    const queries = await this.#queriesFor(question);
    this.#lastQueries = queries.length;
    // One query is the single-query path, byte for byte -- see `SearchIndexOptions.queryPlan` for why a
    // one-element fusion would be a different run and not a cheaper one.
    const hits =
      queries.length === 1
        ? await this.#searchOne(queries[0]!, k)
        : await this.#searchMany(question, queries, k);
    return hits;
  }

  /**
   * The registered path: one query, its own lexical scores, fusion only when a second channel exists.
   *
   * Kept as a separate method rather than folded into `#searchMany` so that the claim "a plan naming one
   * query is the same run" is a statement about *this* code being the same code, not about two branches
   * happening to agree.
   */
  async #searchOne(query: string, k: number): Promise<readonly SearchHit[]> {
    const lexical = this.#lexical ? this.#lexicalOrder(query).slice(0, k) : [];
    let vectors: number[] = [];
    if (this.#vector) {
      const embedded = await this.#embedQueries([query]);
      if (embedded !== undefined) vectors = this.#orderByVector(embedded[0]!, k);
    }

    // One channel and no reranker is not a fusion. The lexical order *is* the answer then, and its scores
    // are already the channel's -- re-basing them on rank would make a run with an index and a run with
    // `relevanceFor = lexicalRelevance` report different numbers for the same order.
    if (vectors.length === 0 && this.#options.rerank === undefined) {
      return lexical.map((turn) => ({
        turn,
        score: lexicalRelevance(query, this.#turns[turn]!, this.#termWeight),
      }));
    }

    const fused = this.#fuse([lexical, vectors], k);
    const graded = await this.#rerank(fused, query);
    return this.#byRank(graded ?? fused);
  }

  /**
   * Several queries for one question: each channel ranks every query, the channel's rankings are fused by
   * reciprocal rank, and the channels are fused with each other exactly as they are on the single-query
   * path.
   *
   * ## Why the per-query lists are fused twice, and why that is not the same as fusing once
   *
   * A turn that three phrasings all rank fourth is better evidence than a turn one phrasing ranks first and
   * the others do not reach; a flat pool over every (query, channel) pair would also let the lexical channel
   * outvote the dense one simply by producing more lists. Fusing within a channel first, then across
   * channels, is what keeps the two votes equal -- which is the property the single-query path already has,
   * and an expansion arm that changed it would move two things at once.
   *
   * ## Why the reranker sees the question and not the phrases
   *
   * Because the cross-encoder scores (question, turn) pairs, and a phrase is a retrieval key rather than an
   * ask. Handing it `queries[0]` would work for the common case where the question comes first and would
   * silently rerank a plan that listed its phrases in another order against a different question.
   */
  async #searchMany(
    question: string,
    queries: readonly string[],
    k: number,
  ): Promise<readonly SearchHit[]> {
    const lists: number[][] = [];
    if (this.#lexical)
      lists.push(
        this.#fuse(
          queries.map((query) => this.#lexicalOrder(query)),
          k,
        ),
      );
    if (this.#vector) {
      // One request for the whole set: four phrases are four texts in one batch, not four calls. The
      // provider's cap is on texts, and its bill is on texts, so the split that matters is the batch.
      const embedded = await this.#embedQueries(queries);
      if (embedded !== undefined) {
        lists.push(
          this.#fuse(
            embedded.map((vector) => this.#orderByVector(vector, k)),
            k,
          ),
        );
      }
    }
    const fused = this.#fuse(lists, k);
    const graded = await this.#rerank(fused, question);
    return this.#byRank(graded ?? fused);
  }

  /**
   * The queries this question is ranked on.
   *
   * Trimmed, blank entries dropped, duplicates removed keeping the first appearance. A plan that survives as
   * nothing falls back to the question: `[]` is a plan that spoke and said nothing, and returning no evidence
   * for it would make an expansion outage look like an abstention question.
   *
   * A plan's failure is **not** caught here. See `SearchIndexOptions.queryPlan`.
   */
  async #queriesFor(question: string): Promise<readonly string[]> {
    const plan = this.#options.queryPlan;
    if (plan === undefined) return [question];
    const queries: string[] = [];
    const seen = new Set<string>();
    for (const named of await plan(question)) {
      const query = named.trim();
      if (query === '' || seen.has(query)) continue;
      seen.add(query);
      queries.push(query);
    }
    return queries.length === 0 ? [question] : queries;
  }

  /**
   * Embed a batch of queries, or say that the vector channel does not run this retrieval.
   *
   * `undefined` covers the three states that are one state downstream -- no embedder, no corpus vectors, and
   * a provider that failed under `onEmbedFailure: 'lexical'` -- because all three mean "this retrieval ranks
   * lexically" and the counters already separate them (`embedCalls`, `vectors`, `embedDegraded`).
   *
   * An **empty** reply to a non-empty batch is that state too: a client answering `[]` has not returned a
   * short batch of queries, and the prompt's ranking is still a ranking. A *partial* reply is refused,
   * because a missing query vector would silently weight the fusion toward the queries that answered and the
   * order would describe a query set the run never issued.
   */
  async #embedQueries(queries: readonly string[]): Promise<readonly EmbeddingVector[] | undefined> {
    const model = this.#model;
    if (model === undefined || this.#vectors.length === 0) return undefined;
    let embedded: readonly EmbeddingVector[];
    try {
      embedded = await model([...queries]);
    } catch (error) {
      if (this.#options.onEmbedFailure !== 'lexical') throw error;
      this.#embedDegraded += 1;
      this.#embedFailure = error instanceof Error ? error.message : String(error);
      return undefined;
    }
    if (embedded.length === queries.length) return embedded;
    if (embedded.length === 0) return undefined;
    throw new Error(
      `the embedder was given ${queries.length} queries and returned ${embedded.length} vectors; a ` +
        'partial reply would rank some of the queries and weight the fusion toward those, so the order ' +
        'would describe a query set this run never issued',
    );
  }

  /**
   * A search, resolved into the synchronous scorer the prompt builder takes.
   *
   * ## The signature is the prompt's, and the first argument is ignored
   *
   * `PromptOptions.relevanceFor` is `(question, turn) => number`, and the question is already resolved by the
   * time this is called -- that is the whole reason a synchronous scorer can exist. An earlier version of
   * this method returned `(turn) => number`, which type-checked everywhere it was used and scored **every
   * turn at zero** once the prompt called it with two arguments: the map was queried with the question text,
   * missed, and the selection fell back to arrival order while the census reported a healthy index. It was
   * found by a wiring test that asserted a late topical turn reaches the prompt, not by any unit test of the
   * index, and it is the reason the parameters are named here rather than elided.
   *
   * A turn the search did not return scores `0`, which is what the lexical channel itself would say about a
   * turn sharing no term -- the two absences are one absence.
   */
  async lookup(question: string, k?: number): Promise<(question: string, turn: string) => number> {
    const hits = await this.search(question, k);
    const byText = new Map<string, number>();
    for (const hit of hits) {
      const text = this.#turns[hit.turn]!;
      // A corpus may repeat a turn verbatim and the map is keyed by text. `search` is best-first, so the
      // first occurrence of a text is its best score and the duplicates can only be equal or worse.
      if (!byText.has(text)) byText.set(text, hit.score);
    }
    return (_question: string, turn: string) => byText.get(turn) ?? 0;
  }

  /**
   * Erase the vectors this index's store holds for these texts.
   *
   * The retrieval side of `forget()`. It lives on the index because the index is the object a product
   * composition root already holds — the caller that erased a sentence has a `CortexMemory`, not the map
   * the memo writes into — and because the memo's key function is the only thing that can name the entry.
   *
   * Returns `0` on an index with no store, and that is a true statement rather than a silent no-op: no store
   * means no vector outlived the question that embedded it, so there is nothing to erase. A caller that
   * wanted an erasure to fail loudly on a missing store is asking for a configuration check, and the index
   * already answers that question in `census().reuse`.
   */
  forget(texts: readonly string[]): number {
    return this.#memo?.forget(texts) ?? 0;
  }

  /** How many of these texts the store holds. See {@link VectorEraser.held}. */
  held(texts: readonly string[]): number {
    return this.#memo?.held(texts) ?? 0;
  }

  /** What the corpus, the channels and the stages did. */
  census(): SearchCensus {
    const channels: ('lexical' | 'vector' | 'rerank')[] = [];
    if (this.#lexical) channels.push('lexical');
    if (this.#vectors.length > 0) channels.push('vector');
    if (this.#options.rerank !== undefined) channels.push('rerank');
    return {
      turns: this.#turns.length,
      terms: this.#postings.size,
      vectors: this.#vectors.length,
      embedCalls: this.#embedCalls,
      embedTexts: this.#embedTexts,
      memoHits: this.#memo?.stats().storeHits ?? 0,
      reuse: this.#memo !== undefined,
      rerankCalls: this.#rerankCalls,
      rerankDegraded: this.#rerankDegraded,
      embedDegraded: this.#embedDegraded,
      embedFailure: this.#embedFailure,
      queries: this.#lastQueries,
      channels,
    };
  }

  /** Positions of turns sharing at least one content term, best first, ties by position. */
  #lexicalOrder(question: string): number[] {
    const asked = contentTerms(question);
    if (asked.length === 0) return [];

    const candidates = new Set<number>();
    for (const term of new Set(asked)) {
      for (const position of this.#postings.get(term) ?? []) candidates.add(position);
    }

    return [...candidates]
      .map((position) => ({
        position,
        score: lexicalRelevance(question, this.#turns[position]!, this.#termWeight),
      }))
      .sort((a, b) => b.score - a.score || a.position - b.position)
      .map((entry) => entry.position);
  }

  /**
   * The vector channel's order for an already-embedded query, at most `k` entries, zero-similarity turns
   * excluded.
   *
   * Synchronous, and separated from the embedding call on purpose: the embedder is the only step that can
   * fail for a reason a caller may want to survive, so keeping the arithmetic out of that call's `try` is
   * what leaves the width check below unsuppressable.
   */
  #orderByVector(query: EmbeddingVector, k: number): number[] {
    // One width, checked once. A corpus embedded at 1,536 dimensions and a query at 1,024 is a client
    // defect, and the failure it produces without this check is a similarity computed over the first 1,024
    // components of each -- plausible numbers, wrong ranking, nothing in the artifact to say so.
    const ragged = this.#vectors.findIndex((vector) => vector.length !== query.length);
    if (ragged !== -1) {
      throw new Error(
        `the query embedded to ${query.length} dimensions and turn ${ragged} to ` +
          `${this.#vectors[ragged]!.length}; a partial comparison would report a similarity neither ` +
          'vector produced',
      );
    }

    return this.#vectors
      .map((vector, position) => ({ position, score: cosine(query, vector) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.position - b.position)
      .slice(0, k)
      .map((entry) => entry.position);
  }

  /**
   * Reciprocal rank fusion over the channel lists, capped at `k`.
   *
   * Ties keep first appearance, and that comes from the sort being **stable** rather than from a second
   * comparator term. The key list is built in first-appearance order and `Array.prototype.sort` has been
   * required to be stable since ES2019, so equal fused scores stay in the order the channels produced them.
   * A compound comparator (`|| firstAppearance`) would say the same thing and add a branch that no test can
   * enter except by constructing an exact rank permutation -- which is precisely the shape this file's
   * coverage floor refuses.
   */
  #fuse(lists: readonly number[][], k: number): number[] {
    const rrfK = this.#options.rrfK ?? DEFAULT_RRF_K;
    const scores = new Map<number, number>();
    for (const list of lists) {
      for (let rank = 0; rank < list.length; rank += 1) {
        const turn = list[rank]!;
        scores.set(turn, (scores.get(turn) ?? 0) + 1 / (rrfK + rank + 1));
      }
    }
    return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!).slice(0, k);
  }

  /**
   * The reranker's order, or `null` when no reranker is configured.
   *
   * The scorer is wrapped so a throw and a short reply are both counted before `rerankHits` swallows them:
   * the core function's contract is to degrade to the input order, and a degradation that is counted is a
   * reading while one that is not is a guess about which of two runs produced the delta.
   */
  async #rerank(order: readonly number[], question: string): Promise<number[] | null> {
    const rerank = this.#options.rerank;
    if (rerank === undefined || order.length === 0) return null;

    this.#rerankCalls += 1;
    const candidates = order.map((turn) => ({
      id: String(turn),
      text: this.#turns[turn]!,
      score: 0,
    }));
    let degraded = false;
    const counted: RerankScoreFn = async (pairs) => {
      try {
        const scores = await rerank(pairs);
        if (scores.length !== pairs.length) degraded = true;
        return scores;
      } catch (error) {
        degraded = true;
        throw error;
      }
    };

    const reordered = await rerankHits(candidates, question, counted);
    if (degraded) this.#rerankDegraded += 1;
    return reordered.map((candidate) => Number(candidate.id));
  }

  /** Score by position in a decided order: `1 / (rrfK + rank + 1)`, monotone and inside `(0, 1]`. */
  #byRank(order: readonly number[]): SearchHit[] {
    const rrfK = this.#options.rrfK ?? DEFAULT_RRF_K;
    return order.map((turn, rank) => ({ turn, score: 1 / (rrfK + rank + 1) }));
  }
}

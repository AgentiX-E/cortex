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
 *    the channels added. The postings list is used to *narrow* the candidates and never to score them.
 * 2. **Fusion is by rank (RRF), not by score.** Cosine lives in `[0, 1]`, the lexical score in `[0, 1]`,
 *    and a future BM25 channel in neither -- summing them needs a normaliser tuned per corpus, which is a
 *    free parameter the benchmark would then be measuring. Ranks are the one thing channels agree on.
 * 3. **A degraded stage is counted.** `rerankHits` returns the input order on every scorer failure, which
 *    is right for the prompt and wrong to read as agreement: an endpoint answering 401 five hundred times
 *    and a cross-encoder that agreed every time produce the same accuracy. `census()` reports `calls`
 *    beside `degraded` so those two runs cannot be confused.
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
} from '@agentix-e/cortex-core';

import { lexicalRelevance, contentTerms } from '../relevance.js';

/** How many hits a search returns unless the caller says otherwise. */
const DEFAULT_K = 64;

/** The RRF constant. `60` is the value from the original literature and the one `fuse.ts` uses. */
const DEFAULT_RRF_K = 60;

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
  /** The RRF constant. Exposed because a second index in the same run must not silently use another one. */
  readonly rrfK?: number;
};

/** One retrieved turn: its position in the corpus, and the score the prompt will sort on. */
export type SearchHit = {
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
  readonly channels: readonly ('lexical' | 'vector' | 'rerank')[];
};

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

export class SearchIndex {
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

  constructor(options: SearchIndexOptions = {}) {
    this.#options = options;
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
      for (const term of new Set(contentTerms(turn))) {
        const posting = this.#postings.get(term);
        if (posting === undefined) this.#postings.set(term, [position]);
        else posting.push(position);
      }
    }
  }

  /**
   * Compute the vector channel, in one batch.
   *
   * Called once per corpus, before any question. An index with no embedder primes to a lexical index; an
   * empty corpus primes to nothing and calls no model, because a batch of zero texts is a request whose
   * only possible answer is "there was nothing to embed".
   */
  async prime(): Promise<void> {
    this.#primed = true;
    const model = this.#model;
    if (model === undefined || this.#turns.length === 0) return;

    const vectors = await model(this.#turns);
    if (vectors.length !== this.#turns.length) {
      throw new Error(
        `the embedder was given ${this.#turns.length} texts and returned ${vectors.length} vector(s); a ` +
          'short batch would leave turns unscoreable and the index would report a ranking it did not ' +
          'compute',
      );
    }
    this.#vectors = vectors;
  }

  /**
   * The best `k` turns for `question`, best first.
   *
   * Lexical scores are the channel's own when it is the only channel; once fusion or rerank decides the
   * order, the score is the position, because two channels and one cross-encoder do not share a scale with
   * the lexical signal and the prompt sorts on the number it is given.
   */
  async search(question: string, k = this.#options.k ?? DEFAULT_K): Promise<readonly SearchHit[]> {
    const lexical = this.#lexicalOrder(question).slice(0, k);
    const model = this.#model;
    const vectors =
      model !== undefined && this.#vectors.length > 0
        ? await this.#vectorOrder(model, question, k)
        : [];

    // One channel and no reranker is not a fusion. The lexical order *is* the answer then, and its scores
    // are already the channel's -- re-basing them on rank would make a run with an index and a run with
    // `relevanceFor = lexicalRelevance` report different numbers for the same order.
    if (vectors.length === 0 && this.#options.rerank === undefined) {
      return lexical.map((turn) => ({
        turn,
        score: lexicalRelevance(question, this.#turns[turn]!),
      }));
    }

    const fused = this.#fuse([lexical, vectors], k);
    const graded = await this.#rerank(fused, question);
    return this.#byRank(graded ?? fused);
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

  /** What the corpus, the channels and the stages did. */
  census(): SearchCensus {
    const channels: ('lexical' | 'vector' | 'rerank')[] = ['lexical'];
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
      .map((position) => ({ position, score: lexicalRelevance(question, this.#turns[position]!) }))
      .sort((a, b) => b.score - a.score || a.position - b.position)
      .map((entry) => entry.position);
  }

  /** The vector channel's order, at most `k` entries, zero-similarity turns excluded. */
  async #vectorOrder(model: EmbedFn, question: string, k: number): Promise<number[]> {
    const [query] = await model([question]);
    if (query === undefined) return [];

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

/**
 * Reranker adapters (roadmap measure B1).
 *
 * Cortex had no reranking stage at all: a repository-wide search for `rerank`
 * returned no implementation before this module. Every published memory system
 * that reaches >=95% on LongMemEval runs a joint (question, passage) re-scoring
 * pass as the final retrieval stage, and Exabase M-1's third phase is explicitly
 * a coherence rerank.
 *
 * Two adapters, so that reranking is never a single point of lock-in — the same
 * discipline the LLM and embedding layers already follow:
 *
 *  - `OpenAICompatibleReranker` posts to the `/rerank` convention shared by
 *    Cohere, Jina, Voyage, and self-hosted bge-reranker proxies.
 *  - `CrossEncoderReranker` runs a local sequence-classification pipeline via
 *    transformers.js, which is the offline fallback: no provider, no key, no
 *    network.
 *
 * Both implement `RerankScoreFn` from cortex-core, so the pure ordering logic is
 * shared and neither adapter re-implements tie-breaking or degradation.
 */

import type { RerankPair, RerankScoreFn } from '@agentix-e/cortex-core';
import { retryableFetch } from '../retry.js';

export type OpenAICompatibleRerankerOptions = {
  /** Base URL including the API version segment, e.g. `https://api.cohere.com/v2`. */
  baseUrl: string;
  apiKey: string;
  /** Reranker model id, e.g. `rerank-v3.5` or `bge-reranker-v2-m3`. */
  model: string;
  /** Injectable fetch for testability and for hosts without a global fetch. */
  fetchFn?: typeof fetch;
  /** Retries on top of the first attempt; default `DEFAULT_MAX_RETRIES`. */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds; doubles on each retry. */
  retryBaseDelayMs?: number;
  /** Per-attempt deadline in milliseconds; default `DEFAULT_RETRY_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * Build the request body for the `/rerank` convention.
 *
 * `top_n` is set to the full document count rather than a smaller value: a
 * partial response is indistinguishable from a provider bug, and the adapter
 * treats a short response as an error so `rerankHits` can fall back. Asking for
 * every document removes that ambiguity at no cost.
 */
export function buildRerankBody(
  query: string,
  documents: readonly string[],
  model: string,
): Record<string, unknown> {
  return {
    model,
    query,
    documents: [...documents],
    top_n: documents.length,
  };
}

/**
 * Convert a `/rerank` response into scores aligned with the request's document
 * order.
 *
 * The API returns results best-first with an `index` back into the request, so
 * the results must be scattered rather than read in place. Any structural
 * problem — missing results, an out-of-range index, a non-finite score, or a
 * document left unscored — returns null so the caller can fall back instead of
 * ranking on a partially-zeroed vector.
 */
export function parseRerankResponse(payload: unknown, expected: number): number[] | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return null;
  }
  if (expected === 0) {
    return [];
  }

  const scores = new Array<number>(expected);
  let filled = 0;
  for (const entry of results) {
    if (entry === null || typeof entry !== 'object') {
      return null;
    }
    const index = (entry as { index?: unknown }).index;
    const score = (entry as { relevance_score?: unknown }).relevance_score;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expected) {
      return null;
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return null;
    }
    if (scores[index] !== undefined) {
      // A duplicate index would leave another document unscored.
      return null;
    }
    scores[index] = score;
    filled += 1;
  }
  return filled === expected ? scores : null;
}

export class OpenAICompatibleReranker {
  private readonly options: OpenAICompatibleRerankerOptions;

  constructor(options: OpenAICompatibleRerankerOptions) {
    this.options = options;
  }

  /** `RerankScoreFn`: score in the order the pairs were supplied. */
  readonly score: RerankScoreFn = async (pairs) => {
    if (pairs.length === 0) {
      return [];
    }

    // Every pair in a single call shares one question in the retrieval use, but
    // the interface does not require it. Score per distinct question and stitch,
    // so a caller that mixes questions still gets correct alignment.
    const byQuestion = new Map<string, { positions: number[]; pairs: RerankPair[] }>();
    pairs.forEach((pair, position) => {
      let bucket = byQuestion.get(pair.question);
      if (bucket === undefined) {
        bucket = { positions: [], pairs: [] };
        byQuestion.set(pair.question, bucket);
      }
      bucket.positions.push(position);
      bucket.pairs.push(pair);
    });

    const scores = new Array<number>(pairs.length);
    for (const [question, bucket] of byQuestion) {
      const documents = bucket.pairs.map((pair) => pair.text);
      const body = buildRerankBody(question, documents, this.options.model);
      const fetchFn = this.options.fetchFn ?? fetch;
      // Routed through `retryableFetch` so this adapter carries the same 429/5xx
      // backoff and per-attempt deadline as the LLM and embedding adapters. Without
      // it a single throttled response aborts the call, and a benchmark issuing
      // hundreds of rerank requests is exactly the workload that meets a 429 —
      // so the omission would surface as an A/B arm that produced no measurement.
      const response = await retryableFetch(
        fetchFn,
        `${this.options.baseUrl}/rerank`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        {
          maxRetries: this.options.maxRetries,
          baseDelayMs: this.options.retryBaseDelayMs,
          timeoutMs: this.options.timeoutMs,
        },
      );
      if (!response.ok) {
        throw new Error(`Rerank request failed: ${response.status} ${response.statusText}`);
      }
      const parsed = parseRerankResponse(await response.json(), documents.length);
      if (parsed === null) {
        throw new Error(
          'Rerank response incomplete or malformed; refusing to rank on partial scores',
        );
      }
      bucket.positions.forEach((position, i) => {
        scores[position] = parsed[i]!;
      });
    }
    return scores;
  };
}

/**
 * Re-exported so the move is invisible to callers and to the package's `exports` surface. `./local`
 * imports the class from `cross-encoder.js` directly, which is the point of the split.
 */
export {
  CrossEncoderReranker,
  type CrossEncoderPipeline,
  type CrossEncoderRerankerOptions,
} from './cross-encoder.js';

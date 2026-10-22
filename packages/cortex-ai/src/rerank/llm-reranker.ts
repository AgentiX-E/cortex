/**
 * LLM-as-reranker adapter (roadmap measure B1, provider-agnostic path).
 *
 * Why a third adapter, when `rerank.ts` already ships an OpenAI-compatible
 * `/rerank` client and a local cross-encoder:
 *
 *  - The `/rerank` convention is a *vendor surface*. Cohere, Jina and Voyage
 *    expose it; DeepSeek does not — it publishes no dedicated reranking model
 *    and no `/rerank` endpoint, only chat completions.
 *  - The cross-encoder is the offline escape hatch and needs no provider at all,
 *    but it needs a downloaded model, which CI runners do not have by default.
 *
 * Neither covers the case this adapter exists for: a provider whose chat endpoint
 * is already configured and whose credential is already present. Routing
 * reranking through the same `LLM` abstraction the judge and the answerer use
 * means that credential is reused rather than duplicated as a second secret, and
 * that reranking inherits the provider's retry/backoff and timeout policy for
 * free instead of reimplementing it.
 *
 * Granularity is listwise — one completion per distinct question, returning a
 * JSON array of scores. Per-pair scoring would cost `questions x candidates`
 * calls, and the widest candidate pool is precisely the configuration the B1
 * A/B must test, so per-pair is the one design that cannot afford its own
 * experiment.
 *
 * Failure semantics are strict by design. A bucket that cannot be parsed
 * contributes no scores at all, leaving the returned array short; `rerankHits`
 * in cortex-core reads a short array as a failure and returns the input order.
 * Padding a failed bucket with a middling constant would instead reorder the
 * candidates on invented data — turning a provider hiccup into an apparent
 * experimental result.
 */

import type { RerankPair, RerankScoreFn } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

export type LLMRerankerOptions = {
  /** The scoring model. Reusing the pipeline's `LLM` is the point of this adapter. */
  llm: LLM;
  /**
   * Prefix for each numbered candidate. Defaults to `Candidate`; overridable so a
   * caller can match a provider's preferred phrasing without forking the parser.
   */
  candidateLabel?: string;
};

/**
 * Build the listwise scoring prompt.
 *
 * Candidates are numbered explicitly rather than listed as a bullet sequence: the
 * reply is a positional array, so the model must be able to see which number each
 * score refers to. The JSON requirement is stated because the parser enforces it —
 * free-text scores are rejected rather than guessed at.
 */
export function buildListwiseRerankPrompt(
  question: string,
  candidates: readonly string[],
  candidateLabel = 'Candidate',
): string {
  const lines = candidates.map((text, index) => `${candidateLabel} ${index}: ${text}`);
  return [
    'You are scoring how well each passage answers the question.',
    'Score every passage independently from 0.0 (irrelevant) to 1.0 (directly answers it).',
    '',
    `Question: ${question}`,
    '',
    ...lines,
    '',
    `Reply with a JSON array of exactly ${candidates.length} numbers, in the order shown.`,
    'Output the array only — no prose, no keys, no code fence.',
  ].join('\n');
}

/**
 * Extract a numeric array of exactly `expected` entries from a model reply.
 *
 * The tolerant part is *locating* the array: models wrap JSON in prose or a code
 * fence often enough that rejecting those would waste calls for no benefit. The
 * intolerant part is *accepting* it: length and finiteness are enforced exactly,
 * because a padded or truncated score vector cannot be told apart from a real
 * ranking and would silently reorder the candidates.
 *
 * An object-wrapped array (`{"scores": [...]}`) is rejected even though it
 * contains a well-formed array of the right length. Slicing from `[` to `]` would
 * happily accept it, but a keyed payload carries no positional guarantee — the
 * model has grouped the scores under a name of its own choosing rather than
 * answering with the ordered vector the prompt specified, so the mapping from
 * array position to candidate is no longer something this adapter can rely on.
 */
export function parseListwiseScores(reply: string, expected: number): number[] | null {
  if (expected === 0) {
    return [];
  }
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return null;
  }
  // Text before the opening bracket may only be decoration (prose, a fence, a
  // label). A `{` in that prefix means the array is a value inside an object, and
  // its positional meaning is not the one the prompt asked for.
  if (reply.slice(0, start).includes('{')) {
    return null;
  }
  // Same argument for the closing side: trailing `}` after `]` means the array
  // was an object member, and the object may not have ended where the array did.
  if (reply.slice(end + 1).includes('}')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expected) {
    return null;
  }
  const scores: number[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return null;
    }
    scores.push(entry);
  }
  return scores;
}

export class LLMReranker {
  private readonly options: LLMRerankerOptions;

  /**
   * Buckets whose reply could not be parsed. Cumulative across invocations because
   * the retrieval pipeline calls `score` once per turn, so a per-call counter would
   * report only the last turn's health.
   */
  private fallbacks = 0;

  /** Buckets attempted. Paired with `fallbackCount` to give a ratio, not just a count. */
  private buckets = 0;

  constructor(options: LLMRerankerOptions) {
    this.options = options;
  }

  /**
   * Buckets abandoned because their reply did not parse as a positional score array.
   *
   * Exposed because a fallback is otherwise invisible: when every bucket fails,
   * `score` returns an empty array, `rerankHits` returns the input order, and the
   * A/B arm reports the same accuracy as its baseline — `0.00pp`, which reads as
   * "reranking does not help". The real cause is that reranking never ran, and
   * without this counter those two outcomes are the same output.
   */
  get fallbackCount(): number {
    return this.fallbacks;
  }

  /** Buckets attempted, so `fallbackCount / bucketCount` is the provider's failure rate. */
  get bucketCount(): number {
    return this.buckets;
  }

  /** `RerankScoreFn`: scores in the order the pairs were supplied. */
  readonly score: RerankScoreFn = async (pairs) => {
    if (pairs.length === 0) {
      return [];
    }

    // One call per distinct question. The retrieval use supplies a single question
    // per invocation, but the interface does not require that, so a caller mixing
    // questions still gets correct alignment.
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

    // Deliberately sparse: a failed bucket leaves holes rather than padding, and the
    // holes are compacted away with the positions that produced them, so the array
    // the caller receives is short and unambiguous.
    const scored: { position: number; score: number }[] = [];
    for (const [question, bucket] of byQuestion) {
      this.buckets += 1;
      const texts = bucket.pairs.map((pair) => pair.text);
      const prompt = buildListwiseRerankPrompt(
        question,
        texts,
        this.options.candidateLabel ?? 'Candidate',
      );
      const reply = await this.options.llm.complete(prompt, { temperature: 0 });
      const parsed = parseListwiseScores(reply, texts.length);
      if (parsed === null) {
        this.fallbacks += 1;
        continue;
      }
      bucket.positions.forEach((position, i) => {
        scored.push({ position, score: parsed[i]! });
      });
    }

    scored.sort((a, b) => a.position - b.position);
    return scored.map((entry) => entry.score);
  };
}

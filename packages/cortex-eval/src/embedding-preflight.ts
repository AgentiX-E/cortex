/**
 * One request, before the run, to learn whether the provider will serve it at all.
 *
 * ## Why this is not "check the account balance"
 *
 * There is no balance endpoint in the provider contract the arm speaks, and inventing one
 * per provider would put provider-specific knowledge in a layer that has none. The check
 * is therefore the same request the run would make, minus the run: **one** short text,
 * embedded, and the answer relayed.
 *
 * ## Why it lives in `cortex-eval` and not in the entry point
 *
 * `bench/**` is excluded from coverage as an entry point, so a decision written there is a
 * decision no test can reach. The verdict is a decision -- `ok` means the vectors are the
 * right shape, not merely that a response arrived -- and the relay of the provider's own
 * words is behaviour with cases worth pinning.
 *
 * ## Why the verdict is returned instead of thrown
 *
 * The preflight's failure IS its output. Throwing would route it into an entry point's
 * unexpected-failure handler beside genuine crashes, and the two want opposite readings:
 * a crash is a defect to fix, and a refusal is a condition to act on. A returned verdict
 * lets the caller say which it is, and lets it print the provider's words where a reader
 * will see them.
 *
 * ## What it deliberately does not do
 *
 * It does not retry, and it does not sleep. The retry policy belongs to the calls the run
 * will make; a check that retried would reintroduce the cost it exists to avoid.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';

/**
 * What the preflight observed.
 *
 * `dimension` is the length of the vector that came back and not the model's declared
 * dimension, because the value that matters is the one the provider produced: a client
 * configured for `1024` that is served `2` would corrupt every cosine downstream, and a
 * verdict reporting the configured number would hide exactly that.
 */
export type EmbeddingPreflight = {
  /** True when one vector came back, of the dimension the model declares. */
  readonly ok: boolean;
  /** Vectors returned: `1` on success, `0` on any failure. */
  readonly vectors: number;
  /** The returned vector's length, or `0` when nothing came back. */
  readonly dimension: number;
  /**
   * The provider's own words, verbatim, when it refused; `''` on success.
   *
   * Verbatim rather than summarised, and this is the field's whole point. A refusal
   * reaches the run as `429 Too Many Requests — {"error":{"code":"1113", ...}}`, where the
   * status alone reads as a rate limit -- a condition you wait out -- and the body says the
   * account has no credit, which is the opposite. Summarising to "the provider refused"
   * would keep the fact and lose the remedy.
   */
  readonly message: string;
};

/**
 * The text the preflight asks about.
 *
 * A constant rather than a dataset string, so the verdict is attributable: a check whose
 * input was the first question would make the answer a function of the dataset, and two
 * runs' preflights would not be comparable. It is also short, because the check's cost
 * should be the shape of a request and not the shape of a question.
 *
 * Not exported, and the signature is what makes that safe: `preflightEmbedding` takes an
 * embedding and no text, so there is no caller that *could* substitute a dataset string
 * for this one. An export nothing outside this module names would be an orphan on the
 * census, and the honest reading of an orphan is that the keyword was unnecessary rather
 * than that a consumer is missing -- which is the same call §13.15 made for
 * `EvidenceRendering`.
 */
const PREFLIGHT_TEXT = 'cortex preflight';

/** Ask the embedding backend for one vector, and report what came back. */
export async function preflightEmbedding(embedding: EmbeddingModel): Promise<EmbeddingPreflight> {
  const declared = embedding.dimension();
  let vectors: Float64Array[];
  try {
    vectors = await embedding.embed([PREFLIGHT_TEXT]);
  } catch (error) {
    return {
      ok: false,
      vectors: 0,
      dimension: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const first = vectors[0];
  if (first === undefined) {
    return {
      ok: false,
      vectors: 0,
      dimension: 0,
      message: 'the provider answered with no vectors',
    };
  }
  if (first.length !== declared) {
    return {
      ok: false,
      vectors: vectors.length,
      dimension: first.length,
      message:
        `the provider answered with a vector of ${first.length} dimensions, ` +
        `and the model declares ${declared}`,
    };
  }
  return { ok: true, vectors: vectors.length, dimension: first.length, message: '' };
}

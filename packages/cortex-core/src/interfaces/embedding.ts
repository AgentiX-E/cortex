/**
 * Embedding abstraction. Implementations return Float64Array so that downstream
 * math (ml-matrix, statistics) never suffers float32 truncation.
 */

/**
 * Which model produced a vector, in the four fields a comparison needs.
 *
 * A vector is not self-describing. Two models can agree on width, return unit-norm vectors of the
 * same sign, and be incomparable: the cosine between them is noise, not a distance. `dimension()`
 * is the only thing this interface used to expose, and it is the only thing a same-width substitution
 * leaves unchanged — which is exactly the case a store cannot detect on its own.
 *
 * The fields are the ones an operator can act on:
 *
 * - `provider` — the vendor or local backend (`'zhipu'`, `'openai'`, `'hash'`);
 * - `model` — the id that names the weights, `null` for a backend that has none (the offline hash);
 * - `endpoint` — the base URL that served it, or `null`. Included because a model id alone does not
 *   identify weights: the same id served by two gateways can be two different models, and a store
 *   built through one gateway and queried through the other fails the same way an upgrade does;
 * - `dimensions` — the width, which is the one field the surrounding code already checks and
 *   therefore the one field a mismatch is *already* caught on. It stays in the identity so that one
 *   comparison covers all four instead of two comparisons covering one each.
 */
export type EmbeddingIdentity = {
  readonly provider: string;
  readonly model: string | null;
  readonly endpoint: string | null;
  readonly dimensions: number;
};

export interface EmbeddingModel {
  /** Embed one or more texts; returns one vector per input, each of `dimension()`. */
  embed(texts: string[]): Promise<Float64Array[]>;
  /** Fixed output dimension. */
  dimension(): number;
  /**
   * Which model this is, or `undefined` when the implementation does not say.
   *
   * Optional on purpose. A caller that injects its own model keeps compiling and keeps running —
   * this interface is the extension point the product documents, and a new required member would
   * break every implementation outside this repository on a minor upgrade. What the optionality
   * costs is stated where it is paid: `EmbeddingSpace` refuses to query a **non-empty** index whose
   * space is unstated, so the absence of this method narrows what an unknown-space store can do
   * rather than silently widening what it may claim.
   */
  identity?(): EmbeddingIdentity;
}

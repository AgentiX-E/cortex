/* istanbul ignore file -- type-only declaration, no runtime code */
/**
 * Embedding abstraction. Implementations return Float64Array so that downstream
 * math (ml-matrix, statistics) never suffers float32 truncation.
 */
export interface EmbeddingModel {
  /** Embed one or more texts; returns one vector per input, each of `dimension()`. */
  embed(texts: string[]): Promise<Float64Array[]>;
  /** Fixed output dimension. */
  dimension(): number;
}

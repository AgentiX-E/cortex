/**
 * Local embedding adapter backed by transformers.js (@xenova/transformers).
 * Runs fully offline in Node and the browser; float32 model outputs are widened
 * to Float64Array for downstream Cortex math.
 *
 * The pipeline loader is injectable so the conversion/caching logic can be tested
 * without the optional peer dependency installed.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { makeDefaultPipelineFactory, type FeatureExtractor } from './transformers-pipeline.js';

export type { FeatureExtractor } from './transformers-pipeline.js';

export type TransformersEmbeddingOptions = {
  model: string;
  dimensions: number;
  /** Injectable pipeline factory; defaults to lazy-importing @xenova/transformers. */
  pipelineFactory?: () => Promise<FeatureExtractor>;
};

export class TransformersEmbedding implements EmbeddingModel {
  private readonly options: TransformersEmbeddingOptions;
  private extractor: FeatureExtractor | null = null;

  constructor(options: TransformersEmbeddingOptions) {
    this.options = options;
  }

  dimension(): number {
    return this.options.dimensions;
  }

  async embed(texts: string[]): Promise<Float64Array[]> {
    const extractor = await this.getExtractor();
    const outputs = await extractor(texts, { pooling: 'mean', normalize: true });
    return outputs.tolist().map((row) => new Float64Array(row));
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      const factory =
        this.options.pipelineFactory ?? makeDefaultPipelineFactory(this.options.model);
      this.extractor = await factory();
    }
    return this.extractor;
  }
}

/**
 * Local embedding adapter backed by transformers.js (@xenova/transformers).
 * Runs fully offline in Node and the browser; float32 model outputs are widened
 * to Float64Array for downstream Cortex math.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';

export type TransformersEmbeddingOptions = {
  model: string;
  dimensions: number;
};

export class TransformersEmbedding implements EmbeddingModel {
  private readonly options: TransformersEmbeddingOptions;
  private extractor: unknown = null;

  constructor(options: TransformersEmbeddingOptions) {
    this.options = options;
  }

  dimension(): number {
    return this.options.dimensions;
  }

  async embed(texts: string[]): Promise<Float64Array[]> {
    const extractor = await this.getExtractor();
    const pipelineFn = extractor as (
      inputs: string[],
      opts: unknown,
    ) => Promise<{
      tolist: () => number[][];
    }>;
    const outputs = await pipelineFn(texts, { pooling: 'mean', normalize: true });
    return outputs.tolist().map((row) => new Float64Array(row));
  }

  private async getExtractor(): Promise<unknown> {
    if (!this.extractor) {
      // Lazy-load the optional peer dependency so the core package installs
      // without pulling in heavy native modules (sharp) unless actually used.
      const { pipeline } = (await import('@xenova/transformers')) as {
        pipeline: (task: string, model: string) => Promise<unknown>;
      };
      this.extractor = await pipeline('feature-extraction', this.options.model);
    }
    return this.extractor;
  }
}

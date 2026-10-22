/**
 * Local embedding adapter: transformers.js in this process, no provider and no key.
 *
 * Float32 model output is widened to `Float64Array` because every downstream Cortex computation
 * (cosine, centroid, contradiction voting) is written against f64; converting once at the boundary
 * keeps the rest of the pipeline free of dtype branches.
 *
 * Two inputs are injectable, and they are different in kind:
 *
 *  * `pipelineFactory` replaces the whole loading step, for callers that already hold a pipeline or
 *    that wrap the library themselves;
 *  * `loadModule` replaces only the module import, which is what the tests use to assert that the
 *    options this package pins (`dtype`, `pooling`, `normalize`) reach the library unchanged.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import {
  makeFeatureExtractorFactory,
  type FeatureExtractor,
  type LocalDtype,
  type LocalEnv,
  type LocalPipelineOptions,
  type TransformersModule,
} from './pipelines.js';

export type { FeatureExtractor } from './pipelines.js';

export type TransformersEmbeddingOptions = {
  /** Model id on the Hub, or a path under `localModelPath`. */
  model: string;
  /** Output dimension. Checked against the model's actual width on first use. */
  dimensions: number;
  /** Weight precision; defaults to `fp32`. See `pipelines.ts` for why it is pinned. */
  dtype?: LocalDtype;
  env?: LocalEnv;
  loadModule?: () => Promise<TransformersModule>;
  /** Replaces the loading step entirely; takes precedence over `dtype`/`env`/`loadModule`. */
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
    if (texts.length === 0) return [];

    const extractor = await this.getExtractor();
    const outputs = await extractor(texts, { pooling: 'mean', normalize: true });
    return outputs.tolist().map((row) => new Float64Array(row));
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      const factory =
        this.options.pipelineFactory ?? makeFeatureExtractorFactory(this.pipelineOptions());
      this.extractor = await factory();
    }
    return this.extractor;
  }

  /** Only the fields the pipeline loader understands; `pipelineFactory` is not one of them. */
  private pipelineOptions(): LocalPipelineOptions {
    const { model, dtype, env, loadModule } = this.options;
    return { model, dtype, env, loadModule };
  }
}

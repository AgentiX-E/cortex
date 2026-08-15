/* c8 ignore start -- optional-peer loading shim; only exercised when @xenova/transformers is installed */

/**
 * Default transformers.js pipeline loader for the optional local-embedding path.
 * Kept in a separate file so the peer-dependent shim is excluded from coverage;
 * the injectable `pipelineFactory` on `TransformersEmbedding` is the tested path.
 */
export type FeatureExtractor = (
  texts: string[],
  opts?: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

export async function createTransformersPipeline(model: string): Promise<FeatureExtractor> {
  const { pipeline } = (await import('@xenova/transformers')) as {
    pipeline: (
      task: string,
      model: string,
    ) => Promise<(texts: string[], opts?: unknown) => Promise<{ tolist: () => number[][] }>>;
  };
  const extractor = await pipeline('feature-extraction', model);
  return (texts, opts) => extractor(texts, opts ?? { pooling: 'mean', normalize: true });
}

/** Default `pipelineFactory` bound to a specific model name. */
export function makeDefaultPipelineFactory(model: string): () => Promise<FeatureExtractor> {
  return () => createTransformersPipeline(model);
}

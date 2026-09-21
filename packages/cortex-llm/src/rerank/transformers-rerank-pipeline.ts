/* c8 ignore start -- optional-peer loading shim; only exercised when @xenova/transformers is installed */

/**
 * Default transformers.js pipeline loader for the offline cross-encoder path.
 *
 * Split into its own file for the same reason the embedding layer splits its
 * loader: the peer-dependent shim is excluded from coverage, and the injectable
 * `pipeline` on `CrossEncoderReranker` is the tested path. Without this file the
 * local reranker would be present-but-unreachable, because nothing would ever
 * construct a pipeline for it — the exact defect the code-vs-docs audit found in
 * the cognitive layer, where `CrossEncoderReranker` shipped with tests and was
 * constructed by no one.
 *
 * `topk: null` is passed through rather than left to the pipeline default. The
 * transformers.js default truncates to a small number of results, and
 * `CrossEncoderReranker` treats a short response as a failure so it can fall back
 * rather than rank on partial scores — so the default would make every call fail.
 */
import type { CrossEncoderPipeline } from './rerank.js';

export async function createTransformersRerankPipeline(
  model: string,
): Promise<CrossEncoderPipeline> {
  const { pipeline } = (await import('@xenova/transformers')) as {
    pipeline: (task: string, model: string) => Promise<unknown>;
  };
  const classifier = (await pipeline('text-classification', model)) as (
    texts: string[],
    options?: unknown,
  ) => Promise<readonly ({ score: number } | number)[]>;
  return (texts, options) => classifier(texts, options ?? { topk: null });
}

/** Default `pipeline` factory bound to a specific model name. */
export function makeDefaultRerankPipelineFactory(
  model: string,
): () => Promise<CrossEncoderPipeline> {
  return () => createTransformersRerankPipeline(model);
}

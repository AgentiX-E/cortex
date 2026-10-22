/**
 * The `./local` entry: everything that runs a model on this machine.
 *
 * Kept apart from the package root so that importing the remote providers does **not** pull
 * transformers.js and its ONNX runtime into the build. The split is enforced, not documented:
 * `tools/entry-guard.mjs` fails if the root's import closure reaches `@huggingface/transformers`,
 * and it treats this file as a positive control -- an entry that is *expected* to reach it, so a
 * green result on the root cannot be the walk being broken.
 */
export {
  createFeatureExtractor,
  createRerankClassifier,
  makeFeatureExtractorFactory,
  makeRerankPipelineFactory,
  resolveTransformersModule,
  applyLocalEnv,
  DEFAULT_DTYPE,
  EMBEDDING_CALL_OPTIONS,
  type FeatureExtractor,
  type LocalDtype,
  type LocalEnv,
  type LocalPipelineOptions,
  type TransformersModule,
} from './pipelines.js';
export { TransformersEmbedding, type TransformersEmbeddingOptions } from './embedding.js';

// Re-exported so that a local-only build needs one import: the class takes its pipeline by
// injection, so it lives in the root, but nothing about it depends on a provider or a network.
export { CrossEncoderReranker, type CrossEncoderRerankerOptions } from '../rerank/rerank.js';
export type { CrossEncoderPipeline } from '../rerank/rerank.js';

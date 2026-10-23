/**
 * The local reranker, in its own file so that importing it does not import an HTTP client.
 *
 * ## Why the split
 *
 * `CrossEncoderReranker` and `OpenAICompatibleReranker` were written in one module, which is a
 * reasonable place for two things that answer the same interface. The problem is that one of them
 * needs `fetch` and the other cannot use it: `./local` re-exported this class, so the offline entry
 * reached `../retry.js` -- and with it the whole retry/fetch client -- for a class that only ever
 * calls a pipeline in-process.
 *
 * `tools/entry-guard.mjs` could not say so before step 14, because it only matched bare specifiers.
 * Now it bans files, and this file exists so that `./local` passes: the first version of the ban
 * failed on `./local` and named `src/retry.ts`, which is how the second half of the same defect was
 * found -- the first half was `parseJson`, moved to `../json.js` minutes earlier.
 */
import type { RerankScoreFn } from '@agentix-e/cortex-core';

/** The shape of a transformers.js text-classification call, narrowed to what we use. */
export type CrossEncoderPipeline = (
  texts: string[],
  options?: { topk?: number | null },
) => Promise<readonly ({ score: number } | number)[]>;

export type CrossEncoderRerankerOptions = {
  /** A text-classification pipeline, e.g. from `@xenova/transformers`. */
  pipeline: CrossEncoderPipeline;
  /**
   * Separator between question and passage. The default matches the token most
   * bge/ms-marco cross-encoders were trained with.
   */
  separator?: string;
  /**
   * Apply a logistic squash to the raw output. Appropriate when the model emits
   * logits (bge-reranker does); leave off for models that already return a
   * calibrated probability.
   */
  applySigmoid?: boolean;
};

export class CrossEncoderReranker {
  private readonly options: CrossEncoderRerankerOptions;

  constructor(options: CrossEncoderRerankerOptions) {
    this.options = options;
  }

  /** `RerankScoreFn` backed by a local model, with no network access. */
  readonly score: RerankScoreFn = async (pairs) => {
    if (pairs.length === 0) {
      return [];
    }
    const separator = this.options.separator ?? '</s></s>';
    const inputs = pairs.map((pair) => `${pair.question}${separator}${pair.text}`);
    const raw = await this.options.pipeline(inputs, { topk: null });
    if (!Array.isArray(raw) || raw.length !== inputs.length) {
      throw new Error('Cross-encoder response incomplete; refusing to rank on partial scores');
    }
    return raw.map((entry) => {
      const value = typeof entry === 'number' ? entry : entry?.score;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Cross-encoder produced a non-finite score');
      }
      return this.options.applySigmoid === true ? 1 / (1 + Math.exp(-value)) : value;
    });
  };
}

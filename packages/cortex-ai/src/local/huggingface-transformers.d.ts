/**
 * The slice of `@huggingface/transformers` this package uses.
 *
 * Declared by hand rather than imported, for two reasons that both matter:
 *
 *  * the peer is **optional**, so typechecking must not depend on it being installed;
 *  * the library's own declarations are large and move between minor versions, and re-exporting
 *    them would make every consumer inherit that churn through this package's `.d.ts`.
 *
 * The trade-off is that a genuine API change on the other side does not fail the compiler. It fails
 * the parity harness instead (`test/parity/run.mjs`), which loads the real package and embeds real
 * text with real weights. That is a better place for the failure: it happens once, in a run that
 * names the reason, instead of in every consumer's build.
 */
declare module '@huggingface/transformers' {
  /**
   * Process-wide configuration.
   *
   * `remoteHost` is the only way to reach a mirror, which is not a corner case -- the public Hub is
   * blocked from some CI networks and from mainland China, and the measurements in docs/04 were
   * taken through `hf-mirror.com` for exactly that reason.
   */
  export const env: {
    remoteHost?: string;
    cacheDir?: string;
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
    localModelPath?: string;
  };

  export function pipeline(
    task: string,
    model: string,
    options?: { dtype?: string; device?: string },
  ): Promise<unknown>;

  /**
   * The two classes the cross-encoder path builds directly, instead of through `pipeline`.
   *
   * `pipeline('text-classification')` post-processes logits through a softmax over the model's
   * labels. A reranking cross-encoder has exactly one label, so that softmax returns 1.0 for every
   * input and every candidate ties -- measured, not inferred: the raw logits for three pairs were
   * 1.95 / -5.63 / -4.03 and the pipeline reported 1 / 1 / 1. Building the model directly keeps the
   * logit, which is the number a reranker needs.
   */
  export const AutoTokenizer: {
    from_pretrained(model: string, options?: { dtype?: string; device?: string }): Promise<unknown>;
  };
  export const AutoModelForSequenceClassification: {
    from_pretrained(model: string, options?: { dtype?: string; device?: string }): Promise<unknown>;
  };
}

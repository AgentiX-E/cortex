/**
 * The chat provider answered, and the answer is "this account cannot pay".
 *
 * ## Why the LLM needs its own class when the embedding side already has one
 *
 * They are different transports with different wrappers, and a caller's repair is chosen by which one is
 * empty: an embedding account that cannot pay degrades *retrieval* (and `SearchIndex.onEmbedFailure` has a
 * policy for that), while a chat account that cannot pay means no answer and no verdict at all. One class for
 * both would make those two repairs indistinguishable at the catch site, which is the argument
 * `EmbeddingQuotaExhaustedError`'s docblock already makes one package over.
 *
 * ## What it is for
 *
 * `retry.ts` already refuses to burn the ladder on this condition (`isQuotaExhausted` distinguishes a
 * balance from a throttle on the same `429`). What it cannot do is stop the **run**: each question's call is
 * independent, so a run whose account is empty pays for one refused call per question and discovers nothing
 * it did not know at the first one. Run `44354315890` is the embedding-side number for that failure --
 * 431 refusals after the first -- and `cortex-eval`'s `latchQuota` is the repair there. This type is the
 * chat-side equivalent: `latchLlmQuota` closes on it and refuses later calls without a request.
 */
export class LlmQuotaExhaustedError extends Error {
  /** The HTTP status the provider returned, which is `429` for every vendor seen so far. */
  readonly status: number;
  /** The provider's response body, truncated to what an error message can carry. */
  readonly detail: string;

  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = 'LlmQuotaExhaustedError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The provider answered, and the answer is "this account cannot pay".
 *
 * ## Why this is a class rather than a message
 *
 * A caller has three different repairs available and they are chosen by cause: a transport failure is
 * retried, a malformed request is fixed, and an exhausted balance is neither — it needs someone to top
 * up, and until then the caller's only useful options are to stop or to run without the thing the
 * provider was supplying. Telling them apart by matching the text of an `Error` is the kind of
 * classification that survives until a vendor changes its wording, so the distinction is a type.
 *
 * ## What it carries
 *
 * `status` and `detail` are the provider's own words, kept verbatim. The detail is what a person reads
 * to decide whether the account is empty or the key is wrong, and paraphrasing it would delete the one
 * piece of evidence that distinguishes the two.
 *
 * The class is exported from the package root because the decision it enables is the caller's, and an
 * earlier version of this paragraph named a reader that did not exist: it claimed a benchmark recorded
 * how many retrievals fell back to lexical scoring, and no such counter was ever written. The readers
 * are `SearchIndex`'s `onEmbedFailure` policy, which can degrade a deployment's retrieval to lexical
 * scoring and reports `embedDegraded`, and `cortex-eval`'s `latchQuota`, which closes on this type and
 * refuses later calls without a request so a run that cannot pay stops paying.
 */
export class EmbeddingQuotaExhaustedError extends Error {
  /** The HTTP status the provider returned, which is `429` for every vendor seen so far. */
  readonly status: number;
  /** The provider's response body, truncated to what an error message can carry. */
  readonly detail: string;

  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = 'EmbeddingQuotaExhaustedError';
    this.status = status;
    this.detail = detail;
  }
}

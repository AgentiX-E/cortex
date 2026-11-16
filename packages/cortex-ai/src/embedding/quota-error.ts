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
 * The class is exported from the package root because the decision it enables is the caller's: the
 * retriever that degrades to lexical scoring and the benchmark that has to record how many retrievals
 * were degraded both need to recognise it, and neither can do that from a message.
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

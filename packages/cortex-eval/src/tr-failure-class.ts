/**
 * TR failure classification: grounded or ungrounded, and why that is the only
 * distinction the record supports.
 *
 * ## The question this answers
 *
 * The failure census (`MEASURE-FAILURE-CENSUS.md`) located 36 TR failures and
 * split them into 27 answered-wrong and 9 refused-wrong. It did not say why any
 * of them failed, and TR is the largest population in the run at 51% of all
 * failures.
 *
 * For an answered-wrong question there are two mechanisms, and they need
 * opposite work:
 *
 *   - **Grounded** -- a retrieved turn carries the answer, and the reader
 *     produced something else anyway. The evidence was in hand and was
 *     misread. The work is in the reader or in how the context is arranged.
 *   - **Ungrounded** -- no retrieved turn carries the answer. The reader could
 *     not have been right. The work is in retrieval, in query expansion, or in
 *     whether the question is answerable at all.
 *
 * Ranking sits in neither: `MEASURE-GAP-ATTRIBUTION.md` measured its ceiling at
 * 11 questions, so a mechanism that reorders the same candidates is not the
 * answer to either population.
 *
 * ## Why the check is token containment and nothing more
 *
 * The verification available is: does the answer appear in the retrieved text?
 * That is weaker than "was the reasoning correct" and it is the strongest claim
 * the artifact supports. A classifier that inferred more -- by comparing the
 * reader's answer to the truth and narrating a cause -- would be generating
 * explanations rather than reading a record.
 *
 * ## Why matching is on word boundaries
 *
 * TR questions ask for counts, and the answers are single digits. A substring
 * test would satisfy an answer of `"1"` from the date `2023/01/21` inside the
 * question's own retrieved timestamp -- reporting the most common TR failure as
 * grounded and pointing the work at the reader when the evidence was never
 * there.
 *
 * ## Why short tokens are kept
 *
 * An earlier revision dropped every token shorter than two characters, on the
 * argument that a one-character match could land inside a date, a score, or an
 * unrelated word. Measured against the A2 artifact, that filter removed **10 of
 * 22 records** -- and 8 of those 10 had been answered *correctly*. The answers
 * it discarded were `2`, `3`, `4`, `5`.
 *
 * The premise was wrong: the word-boundary rule above already prevents a match
 * inside a date or a longer number, so the length filter was defending against
 * a threat that no longer existed. Keeping it would have reported nearly half
 * the corpus as ungrounded -- i.e. "the evidence was never retrieved, go fix
 * retrieval" -- for questions whose evidence was present and whose answers the
 * reader had already produced. That is the most expensive error available to
 * this classifier, and it would have arrived inside a census that looked
 * complete.
 *
 * The rule the measurement supports is the narrower one: a token is dropped
 * only when it carries no alphanumeric content at all. That case is real (a
 * symbol-only or punctuation-only answer), and unlike the length rule it is
 * reported through `answerTokens` so the verdict is auditable.
 */

/** The fields of a TR diagnostic record this classifier reads. */
export type TrFailureInput = {
  readonly question: string;
  /**
   * The expected answer.
   *
   * Typed loosely on purpose. The dataset stores a numeric answer as a JSON
   * number, so the A2 artifact carries `int` here for the single-digit counts
   * and a string for everything else. A `string | null` signature would have
   * been wrong in a way no unit test caught -- the fixtures were all strings,
   * and the first real run threw `toLowerCase is not a function`. The type now
   * states what the artifact actually holds.
   *
   * Null is not "no tokens": an empty token set is a subset of every string, so
   * treating it as grounded would report the hardest questions as the easiest.
   */
  readonly groundTruth: string | number | null;
  /** The answer the reader produced. */
  readonly answer: string | null;
  /** The retrieved context, as the diagnostic records it. */
  readonly retrieved: string;
  readonly questionDate: string;
};

export type TrFailureClass = 'grounded' | 'ungrounded';

export type TrFailureDetail = {
  readonly classification: TrFailureClass;
  /**
   * The answer tokens the classifier looked for. Empty only when the answer
   * carried no alphanumeric content, which is itself the reason such a question
   * is called ungrounded rather than vacuously grounded.
   */
  readonly answerTokens: readonly string[];
  /**
   * How many times the most frequent answer token occurs in the context.
   *
   * This is the confidence term the classification alone does not carry. The
   * retrieved contexts in the A2 artifact run 8k-14k characters, and TR answers
   * are single digits, so a token like `1` can occur dozens of times as a date
   * fragment, a list counter, or an unrelated number. A `grounded` verdict from
   * a token with one occurrence means the fact was retrieved; the same verdict
   * from a token with ninety-five occurrences means the digit happens to appear.
   *
   * Reported rather than folded into the classification, because the two
   * populations need differently calibrated confidence and merging them would
   * destroy the distinction. Zero for an ungrounded multi-token answer, where
   * at least one token was absent and the count of the present ones is not what
   * decided the verdict.
   */
  readonly maxTokenOccurrences: number;
};

/** Whether a token carries any alphanumeric content. See the module note. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Extract the tokens of an answer.
 *
 * Split on anything that is not a letter or digit, lowercased. A punctuation- or
 * symbol-only answer yields no tokens and cannot be matched; that limitation is
 * reported through `answerTokens` rather than hidden, so a reader can see that
 * the verdict rests on nothing.
 *
 * A numeric answer is stringified rather than rejected. The dataset stores
 * counts as JSON numbers, so refusing them would silently exclude the single
 * digit questions -- which are most of what TR asks -- while leaving the census
 * looking complete.
 */
export function answerTokens(groundTruth: string | number | null): string[] {
  if (groundTruth === null) {
    return [];
  }
  return String(groundTruth)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => ALPHANUMERIC.test(token));
}

/** Whether every token occurs in the haystack on a word boundary. */
function containsAllTokens(haystack: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => occurrences(haystack, token) > 0);
}

/**
 * Count the occurrences of a token on word boundaries.
 *
 * The scan uses `indexOf` in a loop rather than a global regex, so the count is
 * an explicit walk of the haystack and each hit is boundary-checked against the
 * characters on either side. The left boundary is read as `''` at position zero,
 * which `isAlphanumericChar` reports as non-alphanumeric -- so a token at the
 * very start of the context counts, which is the correct reading since there is
 * no preceding character to make it part of a longer word.
 */
function occurrences(haystack: string, token: string): number {
  const lower = haystack.toLowerCase();
  const needle = token.toLowerCase();
  let count = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? '' : lower.charAt(index - 1);
    const after = lower.charAt(index + needle.length);
    if (!isAlphanumericChar(before) && !isAlphanumericChar(after)) {
      count++;
    }
    index = lower.indexOf(needle, index + 1);
  }
  return count;
}

/** Whether a single character is a letter or digit, or absent (end of string). */
function isAlphanumericChar(character: string): boolean {
  return character !== '' && ALPHANUMERIC.test(character);
}

/**
 * Classify a single answered-wrong TR failure.
 *
 * Returns the class alone by default, or `{classification, answerTokens}` when
 * `detail` is set, so the caller that wants to audit the verdict does not have
 * to recompute the tokens.
 */
export function classifyTrFailure(input: TrFailureInput): TrFailureClass;
export function classifyTrFailure(
  input: TrFailureInput,
  options: { detail: true },
): TrFailureDetail;
export function classifyTrFailure(
  input: TrFailureInput,
  options?: { detail?: boolean },
): TrFailureClass | TrFailureDetail {
  const tokens = answerTokens(input.groundTruth);
  const classification: TrFailureClass = containsAllTokens(input.retrieved, tokens)
    ? 'grounded'
    : 'ungrounded';
  if (options?.detail === true) {
    // Reported only for a grounded verdict. For an ungrounded multi-token answer
    // it was the absent token, not the count of the present ones, that decided
    // the verdict, so a count there would suggest a strength the verdict does
    // not have.
    const maxTokenOccurrences =
      classification === 'grounded'
        ? tokens.reduce((best, token) => Math.max(best, occurrences(input.retrieved, token)), 0)
        : 0;
    return { classification, answerTokens: tokens, maxTokenOccurrences };
  }
  return classification;
}

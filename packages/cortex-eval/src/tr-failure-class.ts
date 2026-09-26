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
   * The highest occurrence count among the answer's **distinctive** tokens, and
   * the token that produced it.
   *
   * This is the confidence term the classification alone does not carry. The
   * retrieved contexts in the A2 artifact run 8k-14k characters, so a token that
   * occurs once means the fact was retrieved while a token that occurs ninety
   * times means it happens to appear.
   *
   * It is computed over distinctive tokens rather than all tokens because the
   * first version was not, and it misreported real records. `gpt4_59149c78` has
   * ground truth "The Metropolitan Museum of Art."; its tokens include `the`,
   * which occurs **95** times in the context, so the term read 95 and the
   * question was filed as weak evidence -- while `metropolitan`, the one token
   * that identifies the museum, occurs exactly **once**. The term was measuring
   * the English article and reporting it as a statement about the museum.
   *
   * The driver token is reported with the count because a bare number cannot be
   * audited: 95 means one thing when the token is `metropolitan` and the
   * opposite when the token is `the`.
   *
   * Zero for an ungrounded verdict, where it was an absent token rather than the
   * count of the present ones that decided the outcome.
   */
  readonly maxDistinctiveOccurrences: number;
  /** The token that produced `maxDistinctiveOccurrences`, or null when zero. */
  readonly maxOccurrenceToken: string | null;
};

/** Whether a token carries any alphanumeric content. See the module note. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Words that carry no weight about *which* answer is correct.
 *
 * Short and deliberately so: this is a statement of which tokens are answers and
 * which are grammar, not a linguistic stopword list. Everything here is a closed
 * class that cannot be a TR answer, so nothing that could distinguish two
 * candidate answers is filtered. `four` is not here; `the` is.
 *
 * A distinctive-token filter is load-bearing rather than cosmetic. The
 * measurement that forced it: of the A2 TR failures, `the` occurs 95 times in
 * one context, `of` 51 times in another, and both were being reported as the
 * confidence term.
 */
const GRAMMATICAL_TOKENS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'as',
  'from',
  'that',
  'this',
  'it',
  'is',
  'was',
  'were',
  'be',
  'been',
  'am',
  'are',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'my',
  'i',
]);

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
    // Reported only for a grounded verdict. For an ungrounded answer it was the
    // absent token, not the count of the present ones, that decided the verdict,
    // so a count there would suggest a strength the verdict does not have.
    //
    // Computed over distinctive tokens only. A token set that is entirely
    // grammatical (`"the of"`) yields no distinctive token and therefore reports
    // zero -- which is the honest reading, because no token in it can carry
    // evidence about which answer is correct.
    //
    // Ties are broken by first appearance in the token array rather than by
    // iteration accident, so the reported driver is a function of the answer and
    // the context and not of how the token list happened to be ordered. The
    // count is what the field is for; the driver is there so the count can be
    // audited, and an audit that names a different token on each run is not one.
    let maxDistinctiveOccurrences = 0;
    let maxOccurrenceToken: string | null = null;
    if (classification === 'grounded') {
      for (const token of tokens) {
        if (GRAMMATICAL_TOKENS.has(token)) {
          continue;
        }
        const count = occurrences(input.retrieved, token);
        if (count > maxDistinctiveOccurrences) {
          maxDistinctiveOccurrences = count;
          maxOccurrenceToken = token;
        }
      }
    }
    return {
      classification,
      answerTokens: tokens,
      maxDistinctiveOccurrences,
      maxOccurrenceToken,
    };
  }
  return classification;
}

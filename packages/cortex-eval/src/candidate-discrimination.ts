/**
 * Candidate discrimination: why a grounded TR failure happened.
 *
 * ## The question the containment classifier could not answer
 *
 * `tr-failure-class.ts` splits an answered-wrong TR failure into grounded (the
 * answer string is in the retrieved context) and ungrounded (it is not). For a
 * grounded verdict it also reports how often the answer's most distinctive token
 * occurs, because a token that appears dozens of times is weak evidence that the
 * fact was retrieved.
 *
 * That term was added to flag five A2 questions as weak. Reading them showed the
 * term was describing the symptom rather than the cause. Measured on the real
 * records:
 *
 * | question        | truth token    | reader's token |
 * | --------------- | -------------- | -------------- |
 * | `gpt4_76048e76` | `bike` x10     | `car` x8       |
 * | `gpt4_59149c78` | `metropolitan` x1 | `city` x2   |
 * | `gpt4_e414231f` | `road` x6      | `mountain` x3  |
 *
 * The token occurs many times because **the context discusses both the right
 * answer and a competing one**. `gpt4_59149c78` is the sharpest case: the truth
 * occurs exactly once, so the evidence is strong, and the reader's wrong answer
 * also occurs. The reader had both candidates in hand and chose the wrong one.
 *
 * That is a **discrimination** failure, and its fix is not the fix for either
 * bucket the containment classifier has. Retrieval delivered the answer; the
 * reader did not prefer it. Work on retrieval cannot help, and work on the
 * reader cannot help either until the context makes the right candidate
 * identifiable.
 *
 * ## Why token sets and nothing more
 *
 * The verification available is: do the tokens unique to the truth occur, and do
 * the tokens unique to the reader's answer occur? That is weaker than "the
 * reader reasoned incorrectly" and it is the strongest claim the record
 * supports. A classifier that inferred more -- by ranking the candidates or
 * narrating a confusion -- would be generating explanations rather than reading
 * a record.
 *
 * Tokens unique to each side are the right probe because a token the two share
 * cannot distinguish them. Comparing the full sets would report every shared
 * word as evidence and make every question look like a competing-candidate case.
 *
 * ## Why it declines rather than guesses
 *
 * Two inputs are not adjudicable from token sets, and both are reported as such
 * instead of being assigned to a bucket:
 *
 *   - **A list answer that the reader partially reproduced.** Its tokens are a
 *     subset of the truth's, so there is nothing unique to the reader's side and
 *     no competing candidate to detect. Deciding it needs an ordering or
 *     set-difference term this record does not carry. One A2 question is in this
 *     state: `gpt4_7abb270c`, whose truth is six museums.
 *   - **Either side empty of content words.** A truth made only of grammatical
 *     tokens has nothing to look for; a reader answer made only of them has
 *     nothing to check for.
 *
 * Declining is the honest outcome and it is what keeps this instrument's scope
 * stated rather than implied. A module that always returned one of two buckets
 * would have to guess on the list case, and a guess here is indistinguishable
 * from a measurement once it is in a report.
 */

import { GRAMMATICAL_TOKENS } from './tr-failure-class.js';

/** The three things the adjudication reads. */
export type CandidateInput = {
  /** The expected answer. */
  readonly groundTruth: string | number | null;
  /** What the reader produced. Null when it produced nothing. */
  readonly readerAnswer: string | null;
  /** The retrieved context, as the diagnostic records it. */
  readonly retrieved: string;
};

/**
 * What the record supports.
 *
 *   - `competing-candidates` -- the truth and the reader's answer were both
 *     retrieved and the reader picked the wrong one.
 *   - `evidence-only` -- the truth was retrieved and the reader's answer was
 *     not, so the reader produced something the context never offered.
 *   - `unadjudicable` -- the token sets cannot separate the two sides.
 */
export type CandidateVerdict = 'competing-candidates' | 'evidence-only' | 'unadjudicable';

/** The tokens unique to each side, de-duplicated and order-preserving. */
export type DistinguishingTokens = {
  readonly onlyInFirst: readonly string[];
  readonly onlyInSecond: readonly string[];
};

/**
 * Content-word tokens of a value, lowercased. Empty for null.
 *
 * Not de-duplicated here on purpose. `distinguishingTokens` de-duplicates both
 * sides before comparing them, so a repeat guard in this function could never
 * change a verdict -- it would be dead code that reads as a safeguard. Keeping
 * it out is what makes the de-duplication live in exactly one place, where a
 * test can see it.
 */
function contentTokens(value: string | number | null): string[] {
  if (value === null) {
    return [];
  }
  return String(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => /[\p{L}\p{N}]/u.test(token) && !GRAMMATICAL_TOKENS.has(token));
}

/**
 * The tokens unique to each side.
 *
 * Order-preserving and de-duplicated, so the output is a function of the inputs
 * and not of how often a word happened to repeat.
 */
export function distinguishingTokens(
  first: readonly string[],
  second: readonly string[],
): DistinguishingTokens {
  const secondSet = new Set(second);
  const firstSet = new Set(first);
  const onlyInFirst: string[] = [];
  const onlyInSecond: string[] = [];
  for (const token of new Set(first)) {
    if (!secondSet.has(token)) {
      onlyInFirst.push(token);
    }
  }
  for (const token of new Set(second)) {
    if (!firstSet.has(token)) {
      onlyInSecond.push(token);
    }
  }
  return { onlyInFirst, onlyInSecond };
}

/** Whether a token occurs in the haystack on a word boundary. */
function present(haystack: string, token: string): boolean {
  const lower = haystack.toLowerCase();
  const needle = token.toLowerCase();
  const alnum = (character: string) => character !== '' && /[\p{L}\p{N}]/u.test(character);
  let index = lower.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? '' : lower.charAt(index - 1);
    const after = lower.charAt(index + needle.length);
    if (!alnum(before) && !alnum(after)) {
      return true;
    }
    index = lower.indexOf(needle, index + 1);
  }
  return false;
}

/**
 * Adjudicate a grounded TR failure.
 *
 * Returns `unadjudicable` when either side has no unique content token, because
 * in that case the probe has nothing to look for and any bucket would be a
 * guess.
 */
export function adjudicateGroundedFailure(input: CandidateInput): CandidateVerdict {
  const truth = contentTokens(input.groundTruth);
  const answer = contentTokens(input.readerAnswer);
  const { onlyInFirst, onlyInSecond } = distinguishingTokens(truth, answer);

  if (onlyInFirst.length === 0 || onlyInSecond.length === 0) {
    return 'unadjudicable';
  }

  const truthFound = onlyInFirst.some((token) => present(input.retrieved, token));
  const answerFound = onlyInSecond.some((token) => present(input.retrieved, token));

  if (truthFound && answerFound) {
    return 'competing-candidates';
  }
  return 'evidence-only';
}

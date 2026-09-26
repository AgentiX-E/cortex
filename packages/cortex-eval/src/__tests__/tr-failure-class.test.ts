import { describe, expect, it } from 'vitest';
import { answerTokens, classifyTrFailure, type TrFailureInput } from '../tr-failure-class.js';

/**
 * The classifier reads a diagnostic record and returns which of two situations
 * produced a wrong answer. Every fixture states the retrieval text and the
 * answer literally, because the classification is a statement about those two
 * things and a fixture that abstracts them would test nothing.
 */

/** A context containing the question's answer, dated, with a plausible reader. */
function grounded(): TrFailureInput {
  return {
    question: 'Which degree did I graduate with?',
    groundTruth: 'Business Administration',
    answer: 'Computer Science',
    retrieved: '[2023/02/15 (Wed) 08:39] user: I graduated with a Business Administration degree.',
    questionDate: '2023/04/18 (Tue) 03:31',
  };
}

describe('classifyTrFailure', () => {
  it('reports grounded when a retrieved turn carries every answer token', () => {
    expect(classifyTrFailure(grounded())).toBe('grounded');
  });

  it('reports ungrounded when no retrieved turn carries the answer tokens', () => {
    expect(
      classifyTrFailure({
        ...grounded(),
        retrieved: '[2023/02/15 (Wed) 08:39] user: I graduated from college.',
      }),
    ).toBe('ungrounded');
  });

  it('matches tokens on word boundaries so a longer word does not satisfy a shorter one', () => {
    // The failure this guards: an answer of "17" being satisfied by the date
    // "2023/01/21". Substring matching would call a question grounded on the
    // strength of its own timestamp, which would report the most common TR
    // failure as a reader problem.
    expect(
      classifyTrFailure({
        ...grounded(),
        groundTruth: '17',
        retrieved: '[2023/01/21 (Sat) 14:48] user: I walked 117 miles this week.',
      }),
    ).toBe('ungrounded');
  });

  it('reports ungrounded for an empty context rather than a separate state', () => {
    // An empty context is the degenerate case of "the tokens are not there".
    // Giving it its own state would let a census report a third bucket whose
    // meaning is a subset of the second.
    expect(classifyTrFailure({ ...grounded(), retrieved: '' })).toBe('ungrounded');
  });

  it('reports ungrounded when the answer is null rather than treating it as no tokens', () => {
    // A null ground truth is an abstention question. Splitting it into buckets
    // by token matching would classify it as `grounded` vacuously -- an empty
    // token set is contained in every string -- and report the hardest
    // questions as the easiest.
    //
    // The retrieved text deliberately contains the word "null". Without it the
    // assertion would hold for a broken implementation too: null would stringify
    // to "null", fail to match an ordinary context, and land on `ungrounded` by
    // accident. Putting the word in the context is what makes the outcome depend
    // on the guard rather than on the fixture.
    expect(
      classifyTrFailure({
        ...grounded(),
        groundTruth: null,
        retrieved: '[2023/02/15 (Wed) 08:39] user: set the field to null and rerun.',
      }),
    ).toBe('ungrounded');
  });

  it('ignores punctuation and case when matching tokens', () => {
    expect(
      classifyTrFailure({
        ...grounded(),
        groundTruth: 'Business Administration',
        retrieved:
          '[2023/02/15 (Wed) 08:39] user: I graduated with a business administration degree.',
      }),
    ).toBe('grounded');
  });

  it('requires every token, not any token', () => {
    // A multi-token answer where only one token appears is the case that makes
    // the difference between "the evidence is in context" and "one word of it
    // is in context" visible.
    expect(
      classifyTrFailure({
        ...grounded(),
        groundTruth: 'Business Administration',
        retrieved: '[2023/02/15 (Wed) 08:39] user: I studied business.',
      }),
    ).toBe('ungrounded');
  });

  it('matches a numeric answer stored as a JSON number, not only as a string', () => {
    // The dataset stores counts as JSON numbers, so the A2 artifact carries an
    // `int` in `ground_truth` for the single-digit answers and a string for
    // everything else. The first implementation was typed `string | null`, every
    // fixture was a string, and the first real run threw `toLowerCase is not a
    // function`. Pinning the number shape here is what makes the type signature
    // honest rather than incidental.
    expect(
      classifyTrFailure({
        ...grounded(),
        groundTruth: 4,
        retrieved: '[2023/02/15 (Wed) 08:39] user: I visited 4 stores that week.',
      }),
    ).toBe('grounded');
  });

  it('does not match a numeric answer inside a longer number', () => {
    // The word-boundary rule matters most for the numeric answers, which is the
    // population TR is built from: an answer of 4 must not be satisfied by 40.
    expect(
      classifyTrFailure({
        ...grounded(),
        groundTruth: 4,
        retrieved: '[2023/02/15 (Wed) 08:39] user: I visited 40 stores that week.',
      }),
    ).toBe('ungrounded');
  });

  it('does not match a single-digit answer inside a retrieved date', () => {
    // The scenario the length filter in the first revision was written to
    // prevent. Word boundaries already prevent it, which is why the filter was
    // removed rather than kept: it removed no real false positive and cost the
    // corpus 10 of 22 records.
    expect(
      classifyTrFailure({
        ...grounded(),
        groundTruth: 4,
        retrieved: '[2023/04/21 (Fri) 14:48] user: I walked 117 miles this week.',
      }),
    ).toBe('ungrounded');
  });

  it('keeps a single-digit answer matchable rather than filtering it out', () => {
    // The measurement that decided the last revision: 10 of 22 A2 records had
    // an answer that the two-character filter discarded, and 8 of those 10 had
    // been answered correctly. Filtering them would have reported the evidence
    // as absent for questions whose evidence was present.
    expect(answerTokens(4)).toEqual(['4']);
    expect(answerTokens(3)).toEqual(['3']);
    expect(answerTokens('5')).toEqual(['5']);
  });

  it('extracts the same tokens from a numeric answer as from its string form', () => {
    // A number and its string form must not classify differently, or the census
    // would split on how the dataset happened to spell the answer.
    const asNumber = classifyTrFailure(
      { ...grounded(), groundTruth: 15, retrieved: 'I visited 15 stores.' },
      { detail: true },
    );
    const asString = classifyTrFailure(
      { ...grounded(), groundTruth: '15', retrieved: 'I visited 15 stores.' },
      { detail: true },
    );

    expect(asNumber.answerTokens).toEqual(asString.answerTokens);
    expect(asNumber.classification).toBe(asString.classification);
  });

  it('reports the answer tokens in its detail so the verdict is auditable', () => {
    const input = { ...grounded(), groundTruth: 'Business Administration' };
    const detail = classifyTrFailure(input, { detail: true });

    expect(detail.classification).toBe('grounded');
    expect(detail.answerTokens).toEqual(['business', 'administration']);
  });

  it('reports no tokens for an answer with no alphanumeric content', () => {
    // The one case the length filter was really protecting, kept explicitly: a
    // punctuation-only answer has nothing to match, and saying so through
    // `answerTokens` is what keeps the ungrounded verdict auditable rather than
    // looking like a failed search.
    const detail = classifyTrFailure(
      { ...grounded(), groundTruth: '--', retrieved: 'nothing relevant here' },
      { detail: true },
    );
    expect(detail.answerTokens).toEqual([]);
    expect(detail.classification).toBe('ungrounded');
  });

  it('reports every token of a multi-part answer, including the short ones', () => {
    // A caller that wants to know WHY a question was called ungrounded needs
    // the full token set. Short numeric components must appear in it: `50` is
    // as load-bearing as `seconds` for an answer of "25 minutes and 50 seconds".
    const detail = classifyTrFailure(
      {
        ...grounded(),
        groundTruth: '25 minutes and 50 seconds',
        retrieved: 'irrelevant',
      },
      { detail: true },
    );
    expect(detail.answerTokens).toEqual(['25', 'minutes', 'and', '50', 'seconds']);
    expect(detail.classification).toBe('ungrounded');
  });

  it('reports low occurrence counts for a grounded verdict whose evidence is a single appearance', () => {
    // The strong form of a grounded verdict: the answer appears once, in a turn
    // that states it. `maxTokenOccurrences` is what lets a reader tell this
    // apart from the weak form below without re-deriving it.
    //
    // The date is deliberately free of the answer digits. A first draft used
    // `2023/10/15` as the timestamp and asserted a count of 1; the counter
    // returned 2, because the timestamp itself contains `15`. The fixture was
    // wrong and the count was right -- which is the same phenomenon the weak
    // form below describes, caught here on the strong side.
    const detail = classifyTrFailure(
      {
        ...grounded(),
        groundTruth: '15',
        retrieved: '[2023/06/02 (Fri) 09:14] user: 15 weeks had passed since then.',
      },
      { detail: true },
    );
    expect(detail.classification).toBe('grounded');
    expect(detail.maxTokenOccurrences).toBe(1);
  });

  it('reports high occurrence counts when a short answer token is ubiquitous', () => {
    // The weak form, and the reason the field exists. A single-digit answer in
    // an 8k-14k character context can occur dozens of times as a date fragment
    // or a list counter. Containment alone would call this grounded with the
    // same confidence as the single-appearance case above; the count separates
    // them. `1` must count inside "1." and "day 1" but not inside "117".
    const detail = classifyTrFailure(
      {
        ...grounded(),
        groundTruth: '1',
        retrieved: [
          '[2023/01/15 (Sun) 12:51] user: day 1 of the plan.',
          '[2023/02/15 (Wed) 08:39] user: I walked 117 miles on day 1.',
          '[2023/03/19 (Sun) 03:00] user: 1 more week to go.',
        ].join('\n'),
      },
      { detail: true },
    );
    expect(detail.classification).toBe('grounded');
    expect(detail.maxTokenOccurrences).toBe(3);
  });

  it('counts a token at the very start of the context', () => {
    // Position zero has no preceding character, so the left boundary must read
    // as satisfied rather than as a failed lookup. If it did not, a context
    // beginning with the answer would report the answer as absent.
    const detail = classifyTrFailure(
      {
        ...grounded(),
        groundTruth: '15',
        retrieved: '15 weeks had passed since then.',
      },
      { detail: true },
    );
    expect(detail.classification).toBe('grounded');
    expect(detail.maxTokenOccurrences).toBe(1);
  });

  it('counts a token at the very end of the context', () => {
    // The mirror case: no following character.
    const detail = classifyTrFailure(
      {
        ...grounded(),
        groundTruth: '15',
        retrieved: 'the number of weeks was 15',
      },
      { detail: true },
    );
    expect(detail.classification).toBe('grounded');
    expect(detail.maxTokenOccurrences).toBe(1);
  });

  it('reports zero occurrences for an ungrounded verdict rather than a partial count', () => {
    // For an ungrounded multi-token answer it was the absent token that decided
    // the verdict. Reporting a count of the present ones would imply a strength
    // the verdict does not have.
    const detail = classifyTrFailure(
      {
        ...grounded(),
        groundTruth: 'Business Administration',
        retrieved: 'I studied business.',
      },
      { detail: true },
    );
    expect(detail.classification).toBe('ungrounded');
    expect(detail.maxTokenOccurrences).toBe(0);
  });
});

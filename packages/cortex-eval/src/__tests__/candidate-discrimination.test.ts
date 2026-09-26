import { describe, expect, it } from 'vitest';
import {
  adjudicateGroundedFailure,
  distinguishingTokens,
  type CandidateInput,
} from '../candidate-discrimination.js';

/**
 * The module answers the question the containment classifier cannot: when a
 * `grounded` verdict rests on a token that occurs many times, was the reader
 * choosing between retrieved candidates?
 *
 * Every fixture states the context and both answers literally, because the
 * adjudication is a statement about those three things.
 */

/** A context in which both the truth and a competing entity were retrieved. */
function bothCandidates(): CandidateInput {
  return {
    groundTruth: 'road bike',
    readerAnswer: 'mountain bike',
    retrieved: [
      '[2023/02/15 (Wed) 08:39] user: I serviced my road bike today.',
      '[2023/02/16 (Thu) 09:12] user: I also took the mountain bike out.',
    ].join('\n'),
  };
}

describe('distinguishingTokens', () => {
  it('returns the tokens unique to each side', () => {
    expect(distinguishingTokens(['road', 'bike'], ['mountain', 'bike'])).toEqual({
      onlyInFirst: ['road'],
      onlyInSecond: ['mountain'],
    });
  });

  it('returns nothing unique when the two share every token', () => {
    // The list-answer case: a reader that reproduces part of a list shares all
    // its tokens with the truth, so nothing distinguishes them from token sets
    // alone. Reported as empty rather than guessed at.
    expect(distinguishingTokens(['science', 'museum'], ['science', 'museum'])).toEqual({
      onlyInFirst: [],
      onlyInSecond: [],
    });
  });

  it('de-duplicates a token that appears twice on one side', () => {
    expect(distinguishingTokens(['bike', 'bike'], ['car'])).toEqual({
      onlyInFirst: ['bike'],
      onlyInSecond: ['car'],
    });
  });

  it('treats an empty side as having nothing unique', () => {
    expect(distinguishingTokens([], ['car'])).toEqual({
      onlyInFirst: [],
      onlyInSecond: ['car'],
    });
  });
});

describe('adjudicateGroundedFailure', () => {
  it('reports competing-candidates when both sides are present in the context', () => {
    // The case that motivated the module: the truth occurs once, the reader's
    // answer occurs too, and the reader picked the wrong one. That is a
    // discrimination failure, not a retrieval failure.
    expect(adjudicateGroundedFailure(bothCandidates())).toBe('competing-candidates');
  });

  it('reports evidence-only when the truth is present but the reader answer is not', () => {
    // The reader invented something that was never retrieved. That is a
    // different failure and a different fix from picking the wrong candidate.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'unicycle',
        retrieved: '[2023/02/15 (Wed) 08:39] user: I serviced my road bike today.',
      }),
    ).toBe('evidence-only');
  });

  it('reports unadjudicable when the two sides share every token', () => {
    // The list-answer case. Token sets cannot separate the truth from a reader
    // answer that reproduces part of it, so the module declines rather than
    // guessing -- which is the honest outcome and the one that keeps this
    // instrument's scope stated.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'Science Museum, Museum of Contemporary Art',
        readerAnswer: 'Science Museum, Museum of Contemporary Art',
        retrieved: 'I visited the Science Museum and the Museum of Contemporary Art.',
      }),
    ).toBe('unadjudicable');
  });

  it('reports unadjudicable when the truth has no distinguishing token', () => {
    // A truth made only of grammatical tokens has nothing to look for.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'the of',
        readerAnswer: 'something else',
        retrieved: 'the of the of',
      }),
    ).toBe('unadjudicable');
  });

  it('reports unadjudicable when the reader answer has no distinguishing token', () => {
    // Symmetric case: the reader produced no content word, so there is nothing
    // to check for as a competing candidate.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'the',
        retrieved: 'I serviced my road bike.',
      }),
    ).toBe('unadjudicable');
  });

  it('matches on word boundaries so a candidate inside a longer word does not count', () => {
    // `car` must not be found inside `cargo`, or every context mentioning cargo
    // would read as containing a competing candidate.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'car',
        retrieved:
          '[2023/02/15 (Wed) 08:39] user: I serviced my road bike and loaded the cargo bike.',
      }),
    ).toBe('evidence-only');
  });

  it('is case-insensitive', () => {
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'Road Bike',
        readerAnswer: 'Mountain Bike',
        retrieved: 'I serviced my road bike and also the MOUNTAIN BIKE.',
      }),
    ).toBe('competing-candidates');
  });

  it('treats a null reader answer as having nothing to check', () => {
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: null,
        retrieved: 'I serviced my road bike.',
      }),
    ).toBe('unadjudicable');
  });

  it('ignores grammatical tokens when looking for a competing candidate', () => {
    // `the` occurs everywhere, so counting it as a competing candidate would
    // mark every question as competing and destroy the distinction.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'the of',
        retrieved: 'I serviced my road bike and the of the of the of.',
      }),
    ).toBe('unadjudicable');
  });

  it('finds a candidate at the very start of the context', () => {
    // Position zero has no preceding character, so the left boundary must read
    // as satisfied. If it did not, a context beginning with the truth would
    // report the evidence as absent and the verdict would be `evidence-only`
    // for a question that retrieved its own answer first.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'mountain bike',
        retrieved: 'road bike serviced today, and later the mountain bike too.',
      }),
    ).toBe('competing-candidates');
  });

  it('finds a candidate at the very end of the context', () => {
    // The mirror case: no following character.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'mountain bike',
        retrieved: 'I took out the mountain bike and then the road bike',
      }),
    ).toBe('competing-candidates');
  });

  it('does not treat a shared token as a competing candidate', () => {
    // The case that separates "compare the unique tokens" from "compare the
    // whole token sets". Here the truth and the reader's answer share `bike`, and
    // `bike` occurs in the context while `road` (the truth's only unique token)
    // does not. Comparing full sets would find `bike` and report
    // `competing-candidates`; the correct reading is that the truth's own
    // distinguishing token was never retrieved.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'mountain bike',
        retrieved: 'I took the mountain bike out, and I love that bike.',
      }),
    ).toBe('evidence-only');
  });

  it('reports competing-candidates when only one of a multi-token side is present', () => {
    // The truth is a two-word entity with two unique tokens, `road` and `bike`,
    // and the context carries only `road` -- plus the reader's `car`. Requiring
    // every truth token would find `bike` absent and report `evidence-only`,
    // hiding a real missed discrimination.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'car',
        retrieved: 'I serviced the road last week, then drove the car.',
      }),
    ).toBe('competing-candidates');
  });

  it('is unaffected by a token that repeats on one side', () => {
    // A repeated word is the same candidate, so the token set must be
    // de-duplicated. If it were not, `bike` appearing twice in the reader's
    // answer would be treated as two candidates and change nothing -- which is
    // why this is asserted through the verdict rather than on the set alone.
    const once = adjudicateGroundedFailure({
      groundTruth: 'road bike',
      readerAnswer: 'car',
      retrieved: 'I serviced the road bike, and I kept the car.',
    });
    const repeated = adjudicateGroundedFailure({
      groundTruth: 'road bike',
      readerAnswer: 'car the car again car',
      retrieved: 'I serviced the road bike, and I kept the car.',
    });
    expect(once).toBe('competing-candidates');
    expect(repeated).toBe(once);
  });

  it('does not let a rejected position stop the scan', () => {
    // The reader's token occurs once inside a longer word and once on its own.
    // The first hit fails the boundary check and the scan must continue to the
    // second, or a real competing candidate would be reported absent because an
    // earlier substring match was rejected.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'car',
        retrieved: 'I serviced my road bike. The cargo rack was heavy, but I kept the car.',
      }),
    ).toBe('competing-candidates');
  });

  it('reports evidence-only when the truth is present and the reader answer is not', () => {
    // The mirror of the case above, stated on the truth's side: a rejected
    // substring must not be read as the truth being present. Here `road` occurs
    // only inside `roadmap`, so the truth is absent and only the reader's answer
    // was retrieved -- which no bucket other than `evidence-only` describes.
    expect(
      adjudicateGroundedFailure({
        groundTruth: 'road bike',
        readerAnswer: 'car',
        retrieved: 'I laid out the roadmap and then drove the car.',
      }),
    ).toBe('evidence-only');
  });
});

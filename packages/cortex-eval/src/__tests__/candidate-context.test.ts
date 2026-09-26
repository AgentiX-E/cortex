import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_DISCRIMINATION_INSTRUCTION,
  CANDIDATE_RECORD_SCHEMA_KEY,
  candidateSides,
  candidateSpanCount,
  type CandidateCluster,
  clusterCandidates,
  contentTerms,
  type DiscriminatedContextOptions,
  discriminateContext,
  discriminatingQuestionTerms,
  isCandidateDiscriminationEnabled,
  renderDiscriminatedContext,
  type TurnLike,
} from '../candidate-context.js';
import { buildQaPrompt } from '../natural-language-memory.js';

/**
 * These tests pin the INTERVENTION, not the measurement. The measurement says
 * whether a competing candidate reached the reader; this module decides what the
 * reader is given so it can tell them apart.
 *
 * The first implementation required every content word of the QUESTION to appear
 * in a turn. It passed 46 unit tests and annotated ZERO of 17 real
 * competing-candidate questions, because a TR question reduces to eight framing
 * terms ("happened", "first", "attendance") that no single turn carries. The
 * suite was green and the module was inert. The tests below therefore assert the
 * property that failure violated: the terms to cluster on come from the two
 * SIDES, never from the question's framing.
 */

const DATE = '2023/06/02';

function turn(role: 'user' | 'assistant', content: string, date = DATE): string {
  return `[${date}] ${role}: ${content}`;
}

describe('isCandidateDiscriminationEnabled', () => {
  it('is off by default and off for an explicit false', () => {
    expect(isCandidateDiscriminationEnabled({})).toBe(false);
    expect(isCandidateDiscriminationEnabled({ enableCandidateDiscrimination: false })).toBe(false);
  });

  it('is on only for an explicit true', () => {
    expect(isCandidateDiscriminationEnabled({ enableCandidateDiscrimination: true })).toBe(true);
  });
});

describe('candidateSpanCount', () => {
  it('reports one span for an empty answer list', () => {
    expect(candidateSpanCount([])).toBe(1);
  });

  it('counts a single entry with no separators as one span', () => {
    expect(candidateSpanCount(['bike'])).toBe(1);
  });

  it('counts comma-separated values as separate spans', () => {
    expect(candidateSpanCount(['bike, car, train'])).toBe(3);
  });

  it('counts a multi-line answer as separate spans', () => {
    expect(candidateSpanCount(['bike\ncar\ntrain'])).toBe(3);
  });

  it('does not split on a comma inside a longer clause', () => {
    // "I rode a bike, then I serviced the car" is prose; the tail opens with a
    // connective. Length alone cannot separate this from a list -- both sides fit
    // the span cap -- which is why the clause-opener check is load-bearing.
    expect(candidateSpanCount(['I rode a bike, then I serviced the car later'])).toBe(1);
  });

  it('does not split when the tail opens with a conjunction', () => {
    expect(candidateSpanCount(['bike, and the car too'])).toBe(1);
  });

  it('does not split when the tail opens with a pronoun', () => {
    expect(candidateSpanCount(['the bike, I serviced it'])).toBe(1);
  });

  it('splits "A, B" where both sides read as values', () => {
    expect(candidateSpanCount(['Bike, Car'])).toBe(2);
  });

  it('splits a value list whose elements are multi-word names', () => {
    expect(candidateSpanCount(['The Metropolitan Museum of Art, the City Museum'])).toBe(2);
  });

  it('counts semicolon-separated values as separate spans', () => {
    expect(candidateSpanCount(['bike; car'])).toBe(2);
  });

  it('ignores empty entries and trailing separators', () => {
    expect(candidateSpanCount(['bike, ', ''])).toBe(1);
    expect(candidateSpanCount(['', ''])).toBe(1);
  });
});

describe('contentTerms', () => {
  it('returns no terms for null and undefined', () => {
    expect(contentTerms(null)).toEqual([]);
    expect(contentTerms(undefined)).toEqual([]);
  });

  it('accepts a number, not only a string', () => {
    // The artifact carries integer ground truths; a string-only signature threw
    // on the first real run of the measurement layer.
    expect(contentTerms(4)).toEqual(['4']);
  });

  it('drops grammatical tokens', () => {
    expect(contentTerms('The Metropolitan Museum of Art')).toEqual([
      'metropolitan',
      'museum',
      'art',
    ]);
  });

  it('de-duplicates case-insensitively and preserves first-seen order', () => {
    expect(contentTerms('Bike bike BIKE car')).toEqual(['bike', 'car']);
  });

  it('splits on punctuation and keeps alphanumeric tokens only', () => {
    // "am" is dropped because it is the verb in the grammatical list -- the same
    // list the measurement layer uses. Keeping the two identical matters: a
    // divergence would let the intervention cluster on a token the measurement
    // ignored, or vice versa.
    expect(contentTerms('6:45 AM')).toEqual(['6', '45']);
  });

  it('collapses a possessive clitic instead of emitting a one-letter token', () => {
    // "farmer's" split on the apostrophe yields "farmer" plus "s". That "s" is not
    // a word: it is a single letter occurring inside almost every turn, so a side
    // holding it matches noise. Measured on the artifact, 6 of 54 truth/answer
    // values carry this shape. The collapsed form keeps the clitic attached
    // ("farmers"), which the plural fold then reduces -- either way no one-letter
    // token is produced, which is the property under test.
    expect(contentTerms("the farmer's market")).toEqual(['farmers', 'market']);
    expect(contentTerms("the farmer's market")).not.toContain('s');
  });

  it('collapses a contraction clitic too', () => {
    expect(contentTerms("I don't have one")).toEqual(['dont', 'one']);
  });

  it('collapses a right single quotation mark, not only an apostrophe', () => {
    expect(contentTerms('farmer\u2019s market')).toEqual(['farmers', 'market']);
  });

  it('folds an "-ies" plural to a "-y" singular', () => {
    // The one fold that rewrites the stem rather than trimming it: "stories" and
    // "story" must converge or the two sides of a comparison stop matching. The
    // fold is applied by the side builders and the matcher, not by contentTerms
    // (which only collapses clitics), so it is observed through discriminating-
    // question terms and through a turn match.
    expect(discriminatingQuestionTerms('stories')).toEqual(['story']);
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'I told you stories.') }];
    expect(clusterCandidates(turns, [['story']]).map((c) => c.indices)).toEqual([[0]]);
  });

  it('keeps a numeric value that is a single character', () => {
    expect(contentTerms('4 stores')).toEqual(['4', 'stores']);
  });

  it('drops a repeated term only after it has already been emitted', () => {
    // The de-duplication must not eat the FIRST occurrence: the guard sits after the
    // push, so a term seen once is kept and only its repeats are skipped.
    expect(contentTerms('bike bike')).toEqual(['bike']);
    expect(contentTerms('bike car bike car')).toEqual(['bike', 'car']);
  });

  it('drops a short non-numeric token but keeps a short numeric one', () => {
    // The two arms of the same guard: a length test that also admitted numbers
    // would drop "4"; one that only tested length would keep "at" if it were not
    // already grammatical. "ab" is neither grammatical nor a digit, so it goes,
    // while "7" stays -- the numeric exception is what separates the arms.
    expect(contentTerms('ab 7')).toEqual(['7']);
  });
});

describe('discriminatingQuestionTerms', () => {
  it('returns no terms for a question with no usable words', () => {
    expect(discriminatingQuestionTerms('?')).toEqual([]);
    expect(discriminatingQuestionTerms('')).toEqual([]);
  });

  it('drops grammatical tokens', () => {
    expect(discriminatingQuestionTerms('What did the user do?')).toEqual([]);
  });

  it('drops the role word "user" even though it reads as a noun', () => {
    // Measured on the A2 artifact: "user" occurs in ZERO of the 27 answered-wrong
    // TR questions and in ZERO of their 1163 turn contents, while it is the role
    // prefix on every dated turn.
    expect(discriminatingQuestionTerms('Which bike did the user service?')).toEqual([
      'bike',
      'service',
    ]);
  });

  it('keeps content terms and de-duplicates case-insensitively', () => {
    expect(discriminatingQuestionTerms('Which bike did the Bike shop service?')).toEqual([
      'bike',
      'shop',
      'service',
    ]);
  });

  it('drops over-common question words that would match everything', () => {
    expect(discriminatingQuestionTerms('How many times did you ride?')).toEqual(['ride']);
  });

  it('folds a plural so both sides of the comparison agree', () => {
    // What matters is AGREEMENT between the question and the turn, not the stem
    // being a real word: an earlier rule stripped "-es" unconditionally, turning
    // "bikes" into "bik" while "bike" stayed "bike", so a question about "bikes"
    // stopped matching a turn saying "bike" -- dropping evidence.
    expect(discriminatingQuestionTerms('bikes')).toEqual(discriminatingQuestionTerms('bike'));
  });

  it('converges a sibilant plural to the same term as its singular', () => {
    expect(discriminatingQuestionTerms('boxes')).toEqual(discriminatingQuestionTerms('box'));
  });

  it('does not fold a doubled-s word into a different word', () => {
    expect(discriminatingQuestionTerms('class')).toEqual(discriminatingQuestionTerms('classes'));
  });

  it('drops a term shorter than the minimum useful length', () => {
    expect(discriminatingQuestionTerms('Do it')).toEqual([]);
  });

  it('keeps only the first occurrence of a repeated question term', () => {
    // A question that repeats a word must not weight it twice: the term list is a
    // set of things to look for, not a frequency table.
    expect(discriminatingQuestionTerms('trip or trip')).toEqual(['trip']);
  });

  it('drops a short non-grammatical term, not only a grammatical one', () => {
    // Two different reasons to drop a word, and both must hold: "the" is dropped
    // because it is grammatical, "ab" because it is too short to carry identity.
    // A guard that only checked the grammatical list would keep "ab".
    expect(discriminatingQuestionTerms('the ab trip')).toEqual(['trip']);
  });

  it('returns nothing for an empty question string', () => {
    // The empty-token arm: splitting an empty string yields one empty token, which
    // must be skipped rather than folded and pushed as an empty term.
    expect(discriminatingQuestionTerms('')).toEqual([]);
    expect(contentTerms('')).toEqual([]);
  });
});

describe('candidateSides', () => {
  it('returns the two unique sides when truth and answer differ', () => {
    const sides = candidateSides({
      question: 'Which trip did I take first?',
      groundTruth: 'The family road trip',
      answer: 'solo trip to Europe',
    });
    expect(sides).toEqual([
      ['family', 'road'],
      ['solo', 'europe'],
    ]);
  });

  it('subtracts a term shared by both sides', () => {
    // "trip" is in both, so it cannot distinguish them; requiring it would place
    // both candidates on the same turns and produce one cluster that separates
    // nothing.
    const sides = candidateSides({
      question: 'Which trip first?',
      groundTruth: 'road trip',
      answer: 'beach trip',
    });
    expect(sides).toEqual([['road'], ['beach']]);
  });

  it('omits every side when nothing unique remains', () => {
    const sides = candidateSides({
      question: 'Which one?',
      groundTruth: 'road',
      answer: 'road',
    });
    expect(sides).toEqual([]);
  });

  it('falls back to the question terms when neither side is supplied', () => {
    expect(candidateSides({ question: 'Which bike was serviced?' })).toEqual([
      ['bike', 'serviced'],
    ]);
  });

  it('returns nothing when the question supplies no content term either', () => {
    expect(candidateSides({ question: 'What did you do?' })).toEqual([]);
  });

  it('treats a null answer as an absent side', () => {
    const sides = candidateSides({ question: 'q', groundTruth: 'road', answer: null });
    expect(sides).toEqual([['road']]);
  });

  it('accepts a numeric ground truth', () => {
    const sides = candidateSides({ question: 'q', groundTruth: 5, answer: 'three' });
    expect(sides).toEqual([['5'], ['three']]);
  });
});

describe('clusterCandidates', () => {
  const sides = [['road'], ['beach']] as const;

  it('returns no clusters for no turns', () => {
    expect(clusterCandidates([], sides)).toEqual([]);
  });

  it('returns no clusters when no side is usable', () => {
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'I rode a road bike.') }];
    expect(clusterCandidates(turns, [[], []])).toEqual([]);
  });

  it('narrows a single-term side to that term rather than keeping the whole list', () => {
    // Guards the distinctive narrowing from over-requiring: when the winning term
    // is the side's only token, the required set must be exactly it, not the
    // side's full list.
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'The road was wet.') }];
    expect(clusterCandidates(turns, [['road']], [['road']]).map((c) => c.indices)).toEqual([[0]]);
  });

  it('assigns each turn to the side whose value it carries', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'I took the road bike.') },
      { index: 1, text: turn('user', 'I also went to the beach.') },
    ];
    const clusters = clusterCandidates(turns, sides);
    expect(clusters.map((c) => c.indices)).toEqual([[0], [1]]);
    expect(clusters.map((c) => c.terms)).toEqual([['road'], ['beach']]);
  });

  it('merges adjacent turns carrying the same side', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The road was long.') },
      { index: 1, text: turn('user', 'The road was steep.') },
    ];
    const clusters = clusterCandidates(turns, sides);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.indices).toEqual([0, 1]);
  });

  it('collects all mentions of one value into ONE cluster, adjacent or not', () => {
    // Not a contiguous run. Measured on the artifact, "Spanish classes" appears in
    // 3 turns scattered among 45; run-based clustering split it into 3 clusters
    // and reported 9 candidates for a two-candidate question.
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The road was long.') },
      { index: 1, text: turn('user', 'I ate a sandwich.') },
      { index: 2, text: turn('user', 'The road was steep.') },
    ];
    expect(clusterCandidates(turns, sides).map((c) => c.indices)).toEqual([[0, 2]]);
  });

  it('produces one cluster per side, so a two-candidate question has two', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'I took the road bike.') },
      { index: 1, text: turn('user', 'Then I went to the beach.') },
      { index: 2, text: turn('user', 'The road was wet.') },
    ];
    const clusters = clusterCandidates(turns, sides);
    expect(clusters.map((c) => c.indices)).toEqual([[0, 2], [1]]);
    expect(clusters.map((c) => c.id)).toEqual([1, 2]);
  });

  it('keeps turn indices ascending within a cluster', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The road was long.') },
      { index: 1, text: turn('user', 'The weather was fine.') },
      { index: 2, text: turn('user', 'The road was steep.') },
      { index: 3, text: turn('user', 'The road was wet.') },
    ];
    expect(clusterCandidates(turns, [['road']])[0]!.indices).toEqual([0, 2, 3]);
  });

  it('excludes assistant turns', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('assistant', 'Your road bike sounds great.') },
      { index: 1, text: turn('user', 'The road was steep.') },
    ];
    expect(clusterCandidates(turns, sides).map((c) => c.indices)).toEqual([[1]]);
  });

  it('treats an ambiguous turn carrying both sides as no side', () => {
    // Labelling it either way would be a guess, and a guess is indistinguishable
    // from a measurement once it is in a prompt.
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'road then beach') }];
    expect(clusterCandidates(turns, sides)).toEqual([]);
  });

  it('matches a turn carrying any of a side\u2019s tokens when no distinctive term is given', () => {
    // ANY-of, not ALL-of. The artifact forced this: a side's tokens are often
    // spread across a multi-turn paraphrase ("the woman selling jam at the
    // farmer's market" reads as "woman" in one turn and "jam ... farmer's market"
    // in another). Requiring the conjunction placed the truth in NO cluster on 11
    // of 17 real questions.
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'I took the road bike.') },
      { index: 1, text: turn('user', 'I took the bike.') },
    ];
    expect(clusterCandidates(turns, [['road', 'bike']]).map((c) => c.indices)).toEqual([[0, 1]]);
  });

  it('narrows a side to the distinctive term when one is supplied', () => {
    // The guard against the risk ANY-of introduces: a side may contain a token so
    // common in this context that it identifies nothing. Passing the side's
    // most-distinctive term confines the match to turns carrying that term.
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'I took the road bike.') },
      { index: 1, text: turn('user', 'I took the bike.') },
    ];
    expect(clusterCandidates(turns, [['road', 'bike']], [['road']]).map((c) => c.indices)).toEqual([
      [0],
    ]);
  });

  it('matches a side term at a word boundary, not inside a longer word', () => {
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'I drove the roadster.') }];
    expect(clusterCandidates(turns, [['road']])).toEqual([]);
  });

  it('matches a plural in the turn against the singular side term', () => {
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'I took both road bikes.') }];
    expect(clusterCandidates(turns, [['road', 'bike']]).map((c) => c.indices)).toEqual([[0]]);
  });

  it('handles an undated turn', () => {
    const turns: TurnLike[] = [{ index: 0, text: 'user: the road was long' }];
    expect(clusterCandidates(turns, sides).map((c) => c.indices)).toEqual([[0]]);
  });

  it('excludes an undated assistant turn', () => {
    // The role strip must happen for the undated shape too: an assistant turn with
    // no date prefix still restates rather than asserts, so letting it become a
    // candidate would count one fact as two.
    const turns: TurnLike[] = [{ index: 0, text: 'assistant: your road bike sounds great' }];
    expect(clusterCandidates(turns, sides)).toEqual([]);
  });

  it('treats a role-less line as ordinary text rather than as assistant speech', () => {
    // A line carrying neither a date nor a role is prose the reader must still be
    // able to use. It is not assistant speech, so it is eligible to be a candidate.
    const turns: TurnLike[] = [{ index: 0, text: 'the road was long' }];
    expect(clusterCandidates(turns, sides).map((c) => c.indices)).toEqual([[0]]);
  });

  it('does not count assistant turns when choosing the distinctive term', () => {
    // The frequency that picks the distinctive term must ignore assistant turns,
    // for the same reason clustering does: an assistant restatement is not
    // independent support. Here "beach" occurs only in an assistant turn, so if
    // that turn counted, "beach" would look like the more common term and "road"
    // -- the one the user actually asserted -- would be narrowed away.
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The road was long.') },
      { index: 1, text: turn('assistant', 'You mean the road and the beach?') },
    ];
    const result = discriminateContext(turns, {
      question: 'Road or beach?',
      groundTruth: 'road',
      answer: 'beach',
    });
    expect(result.clusters.map((c) => c.indices)).toEqual([[0]]);
    expect(result.clusters[0]!.terms).toEqual(['road']);
  });
});

describe('discriminateContext', () => {
  it('returns no clusters for empty context', () => {
    expect(
      discriminateContext([], { question: 'Which?', groundTruth: 'road', answer: 'beach' })
        .clusters,
    ).toEqual([]);
  });

  it('clusters the two sides of a real competing-candidate question', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'I booked the family road trip for June.') },
      { index: 1, text: turn('user', 'I later planned the solo trip to Europe.') },
    ];
    const result = discriminateContext(turns, {
      question: 'Which trip did I take first?',
      groundTruth: 'The family road trip',
      answer: 'solo trip to Europe',
    });
    expect(result.clusters.map((c) => c.indices)).toEqual([[0], [1]]);
    expect(result.annotated).toBe(true);
  });

  it('declines when only one side exists', () => {
    // One side means nothing competes. Clustering anyway would label every turn
    // mentioning that value while claiming to discriminate -- an annotation that
    // fires and discriminates nothing is worse than one that declines.
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The road was long.') },
      { index: 1, text: turn('user', 'The road was steep.') },
    ];
    const result = discriminateContext(turns, {
      question: 'How was the road?',
      groundTruth: 'road',
      answer: null,
    });
    expect(result.clusters).toEqual([]);
    expect(result.annotated).toBe(false);
  });

  it('declines when the context carries neither side', () => {
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'I ate a sandwich.') }];
    const result = discriminateContext(turns, {
      question: 'Which trip first?',
      groundTruth: 'road',
      answer: 'beach',
    });
    expect(result.clusters).toEqual([]);
    expect(result.annotated).toBe(false);
  });

  it('does not require the question framing words to appear', () => {
    // The regression this guards: requiring "happened"/"first"/"attendance"
    // annotated none of the 17 real questions. A turn carries the VALUE.
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'I started Spanish classes in March.') },
      { index: 1, text: turn('user', 'The cultural festival was in May.') },
    ];
    const result = discriminateContext(turns, {
      question: 'Which event happened first, the cultural festival or my Spanish classes?',
      groundTruth: 'Spanish classes',
      answer: 'cultural festival',
    });
    expect(result.clusters.map((c) => c.indices)).toEqual([[0], [1]]);
  });
});

describe('renderDiscriminatedContext', () => {
  const options: DiscriminatedContextOptions = {
    question: 'How is the bike?',
    groundTruth: 'red',
    answer: 'blue',
  };

  it('returns the original context untouched when there are no clusters', () => {
    const context = turn('user', 'I rode my bike.');
    expect(renderDiscriminatedContext(context, [], options)).toBe(context);
  });

  it('returns the empty string unchanged', () => {
    expect(renderDiscriminatedContext('', [], options)).toBe('');
  });

  it('returns an empty context unchanged even when clusters are given', () => {
    // Annotating the empty context would put a label on a context with no turns.
    expect(renderDiscriminatedContext('', [{ id: 1, indices: [0], terms: ['red'] }], options)).toBe(
      '',
    );
  });

  it('declines to label when an index lies outside the rendered turns', () => {
    // Labelling by position when the positions do not line up would mark the wrong
    // turn. Declining is the safe direction: a mislabel is worse than no label and
    // would be invisible in a prompt.
    const context = `${turn('user', 'The bike is red.')}\n${turn('user', 'The bike is blue.')}`;
    const clusters: CandidateCluster[] = [{ id: 1, indices: [7], terms: ['red'] }];
    expect(renderDiscriminatedContext(context, clusters, options)).toBe(context);
  });

  it('does not delete or reorder any turn', () => {
    // The annotation is a LABEL. A clustering that groups wrongly must be able to
    // mislabel a turn but never remove evidence.
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The bike is red.') },
      { index: 1, text: turn('user', 'The weather is nice.') },
      { index: 2, text: turn('user', 'The bike is blue.') },
    ];
    const result = discriminateContext(turns, {
      question: 'What colour is the bike?',
      groundTruth: 'red',
      answer: 'blue',
    });
    const rendered = renderDiscriminatedContext(
      turns.map((t) => t.text).join('\n'),
      result.clusters,
      options,
    );
    for (const t of turns) expect(rendered).toContain(t.text);
    expect(rendered.indexOf(turns[0]!.text)).toBeLessThan(rendered.indexOf(turns[2]!.text));
  });

  it('labels each cluster with its numeric id', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The bike is red.') },
      { index: 1, text: turn('user', 'The bike is blue.') },
    ];
    const rendered = renderDiscriminatedContext(
      turns.map((t) => t.text).join('\n'),
      [
        { id: 1, indices: [0], terms: ['red'] },
        { id: 2, indices: [1], terms: ['blue'] },
      ],
      options,
    );
    expect(rendered).toContain(`${CANDIDATE_RECORD_SCHEMA_KEY}: 1`);
    expect(rendered).toContain(`${CANDIDATE_RECORD_SCHEMA_KEY}: 2`);
  });

  it('emits a valid dated-turn shape so the JSON renderer still parses it', () => {
    const turns: TurnLike[] = [
      { index: 0, text: turn('user', 'The bike is red.') },
      { index: 1, text: turn('user', 'The bike is blue.') },
    ];
    const rendered = renderDiscriminatedContext(
      turns.map((t) => t.text).join('\n'),
      [
        { id: 1, indices: [0], terms: ['red'] },
        { id: 2, indices: [1], terms: ['blue'] },
      ],
      options,
    );
    // The dated-turn pattern the JSON renderer matches on must still match, or
    // the labelled turns silently merge into their predecessor.
    const pattern = /^\[(\d{4}\/\d{2}\/\d{2})[^\]]*\]\s*(user|assistant):\s*([\s\S]*)$/;
    for (const line of rendered.split('\n')) expect(pattern.test(line)).toBe(true);
  });

  it('keeps the label inside the content, never before the role', () => {
    const turns: TurnLike[] = [{ index: 0, text: turn('user', 'The bike is red.') }];
    const rendered = renderDiscriminatedContext(
      turns.map((t) => t.text).join('\n'),
      [{ id: 1, indices: [0], terms: ['red'] }],
      options,
    );
    expect(rendered).toMatch(/^\[\d{4}\/\d{2}\/\d{2}\]\s*user:\s/);
  });

  it('never lets the label sit between the date and the role', () => {
    // The regression this pins: a label placed after the date but before the role
    // still "looks" annotated, and a date pattern lenient enough to allow extra
    // bracketed groups after the date will still match it -- so the label would
    // pass every shape check while the reader's parser sees a role that no longer
    // immediately follows the date. Assert the adjacency directly: the role is the
    // first token after the date bracket, and the label follows the content.
    const context = `${turn('user', 'The bike is red.')}\n${turn('assistant', 'Noted.')}`;
    const rendered = renderDiscriminatedContext(
      context,
      [{ id: 1, indices: [0], terms: ['red'] }],
      options,
    );
    const label = `[${CANDIDATE_RECORD_SCHEMA_KEY}:`;
    for (const line of rendered.split('\n')) {
      const afterDate = line.replace(/^\[\d{4}\/\d{2}\/\d{2}\]/, '');
      // The role comes first, before any label.
      expect(afterDate).toMatch(/^\s*(?:user|assistant):/);
      const roleIndex = afterDate.search(/(?:user|assistant):/);
      const labelIndex = afterDate.indexOf(label);
      if (labelIndex !== -1) expect(labelIndex).toBeGreaterThan(roleIndex);
    }
  });

  it('is idempotent: re-rendering labelled context does not double-label', () => {
    const context = turn('user', 'The bike is red.');
    const clusters: CandidateCluster[] = [{ id: 1, indices: [0], terms: ['red'] }];
    const once = renderDiscriminatedContext(context, clusters, options);
    const twice = renderDiscriminatedContext(once, clusters, options);
    expect(twice).toBe(once);
  });

  it('labels an undated turn as well as a dated one', () => {
    const context = 'user: the bike is red';
    const rendered = renderDiscriminatedContext(
      context,
      [{ id: 1, indices: [0], terms: ['red'] }],
      options,
    );
    expect(rendered).toContain(`${CANDIDATE_RECORD_SCHEMA_KEY}: 1`);
    expect(rendered).toMatch(/^user:\s/);
  });

  it('declines when a newline-formatted context does not line up with its turns', () => {
    // The load-bearing guard, and the ONLY one: the newline view of the context
    // must agree with the renderer's own turn split, or positions do not line up.
    // A wrapped turn makes the two disagree, and the render refuses as a whole
    // rather than labelling by a position it cannot trust -- a mislabel is worse
    // than no label and would be invisible in a prompt.
    const wrapped = `[${DATE}] user: The bike is red,\nand the frame is light.`;
    const clusters: CandidateCluster[] = [
      { id: 1, indices: [0], terms: ['red'] },
      { id: 2, indices: [9], terms: ['blue'] },
    ];
    expect(renderDiscriminatedContext(wrapped, clusters, options)).toBe(wrapped);
  });

  it('labels the final turn, the last position the guard admits', () => {
    const context = `${turn('user', 'The bike is red.')}\n${turn('user', 'The bike is blue.')}`;
    const clusters: CandidateCluster[] = [{ id: 1, indices: [1], terms: ['blue'] }];
    const rendered = renderDiscriminatedContext(context, clusters, options);
    expect(rendered).toContain(`${CANDIDATE_RECORD_SCHEMA_KEY}: 1`);
    expect(rendered.split('\n')[1]).toContain('blue');
  });
});

describe('prompt wiring', () => {
  it('omits the discrimination instruction by default', () => {
    const prompt = buildQaPrompt('Which bike?', '[{"role":"user","content":"x"}]', 'UNANSWERABLE');
    // The baseline prompt already tells the model to choose among candidates;
    // this pins that the new instruction is absent unless asked for, so a prompt
    // change cannot apply to every question by accident.
    expect(prompt).toContain('choose the one that best matches');
    expect(prompt).not.toContain(CANDIDATE_DISCRIMINATION_INSTRUCTION);
  });

  it('adds the discrimination instruction when the option is enabled', () => {
    const prompt = buildQaPrompt('Which bike?', '[{"role":"user","content":"x"}]', 'UNANSWERABLE', {
      candidateDiscrimination: true,
    });
    expect(prompt).toContain(CANDIDATE_DISCRIMINATION_INSTRUCTION);
  });

  it('places the instruction before the context so it governs the whole read', () => {
    const prompt = buildQaPrompt('Which bike?', '[{"role":"user","content":"x"}]', 'UNANSWERABLE', {
      candidateDiscrimination: true,
    });
    expect(prompt.indexOf(CANDIDATE_DISCRIMINATION_INSTRUCTION)).toBeLessThan(
      prompt.indexOf('Context'),
    );
  });

  it('keeps the abstention instruction unchanged when enabled', () => {
    const prompt = buildQaPrompt('Which bike?', '[]', 'UNANSWERABLE', {
      candidateDiscrimination: true,
    });
    expect(prompt).toContain('Respond with exactly "UNANSWERABLE"');
  });
});

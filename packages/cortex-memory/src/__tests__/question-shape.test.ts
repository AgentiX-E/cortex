/**
 * The two readings, held to the questions that produced them.
 *
 * Every derivation case below is a real question from run `40989420944`'s reference-only MR set, and
 * every enumeration case is a real question from the same set that the arm got wrong by one member.
 * That is the property this file exists to keep: the classifier's boundary is not a taste, it is the
 * line between the ten questions whose replies said *"the evidence does not state it"* and the ten
 * whose replies counted one item too few.
 *
 * The last group is the boundary itself. Four of the ten declines are derived values the pattern
 * **misses** -- a bedtime from an appointment date, elapsed days, weekly hours, a sum of view counts
 * -- and they are asserted as `enumeration` rather than quietly widened, because the mechanism being
 * dispatched is the reference pipeline's verbatim and a wider pattern would be a second variable.
 */

import { describe, expect, it } from 'vitest';

import { classifyQuestionShape } from '../question-shape.js';

describe('the questions whose replies declined because the answer was not stated', () => {
  const derived = [
    ['e6041065', 'What percentage of packed shoes did I wear on my last trip?'],
    ['d905b33f', 'What percentage discount did I get on the book from my favorite author?'],
    ['a1cc6108', 'How old was I when Alex was born?'],
    ['ba358f49', 'How many years will I be when my friend Rachel gets married?'],
    ['157a136e', 'How many years older is my grandma than me?'],
    ['c18a7dc8', 'How many years older am I than when I graduated from college?'],
  ] as const;

  for (const [id, question] of derived) {
    it(`reads ${id} as a derivation`, () => {
      expect(classifyQuestionShape(question)).toBe('derivation');
    });
  }

  it('reads the duration question as a derivation too', () => {
    // `92a0aa75` answers `3 years and 9 months` for a gold of `1 year and 5 months`: the arm picked
    // the company's tenure instead of the role's, which is an operand-selection error and therefore
    // the same mechanism's population.
    expect(classifyQuestionShape('How long have I been working in my current role?')).toBe(
      'derivation',
    );
  });
});

describe('the questions whose replies answered a count one member wrong', () => {
  const counted = [
    ['0a995998', 'How many items of clothing do I need to pick up or return from a store?'],
    ['gpt4_a56e767c', 'How many movie festivals that I attended?'],
    ['2e6d26dc', 'How many babies were born to friends and family members in the last few months?'],
    ['88432d0a', 'How many times did I bake something in the past two weeks?'],
    ['gpt4_7fce9456', 'How many properties did I view before making an offer on the townhouse?'],
    ['gpt4_31ff4165', 'How many health-related devices do I use in a day?'],
    ['2788b940', 'How many fitness classes do I attend in a typical week?'],
    ['bf659f65', 'How many music albums or EPs have I purchased or downloaded?'],
    [
      'gpt4_2f91af09',
      'How many total pieces of writing have I completed since I started writing again?',
    ],
    ['21d02d0d', 'How many fun runs did I miss in March due to work commitments?'],
  ] as const;

  for (const [id, question] of counted) {
    it(`reads ${id} as an enumeration`, () => {
      expect(classifyQuestionShape(question)).toBe('enumeration');
    });
  }
});

describe('the boundary, stated rather than widened', () => {
  it('leaves the four derived-but-unmatched declines on the enumeration contract', () => {
    // These are the remainder of the ten declines. Each answer is computed, and the pattern does not
    // say so: a date read from the context, an elapsed time, a fact stated as a rate, and a sum. The
    // registration (§13.166) names them as a later population rather than folding them in, because a
    // dispatcher that shipped a wider pattern in the same run could not attribute a conversion to the
    // prompt rather than to the pattern.
    expect(
      classifyQuestionShape(
        "What time did I go to bed on the day before I had a doctor's appointment?",
      ),
    ).toBe('enumeration');
    expect(
      classifyQuestionShape(
        'How many days did it take for my laptop backpack to arrive after I bought it?',
      ),
    ).toBe('enumeration');
    expect(
      classifyQuestionShape(
        'How many hours do I work in a typical week during peak campaign seasons?',
      ),
    ).toBe('enumeration');
    expect(
      classifyQuestionShape(
        'What is the total number of views on my most popular videos on YouTube and TikTok?',
      ),
    ).toBe('enumeration');
  });

  it('is total: every question is one of the two readings', () => {
    // A classifier with a third outcome would make the reach a count with a hidden remainder. The
    // signature cannot express one, and this asserts the behaviour on the degenerate inputs that
    // would otherwise be the way in.
    for (const question of ['', ' ', 'How many?', 'WHAT PERCENTAGE of shoes?']) {
      expect(['derivation', 'enumeration']).toContain(classifyQuestionShape(question));
    }
    expect(classifyQuestionShape('')).toBe('enumeration');
  });

  it('matches on the whole phrase, not on a fragment of a longer word', () => {
    // `percent` is in the pattern and `percentage` must not also match inside `percentile`; the
    // boundary markers are what stop a question about a percentile from being read as a ratio.
    expect(classifyQuestionShape('What was my percentile rank on the exam?')).toBe('enumeration');
  });
});

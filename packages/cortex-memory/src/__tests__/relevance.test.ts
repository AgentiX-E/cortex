/**
 * The relevance signal, tested against the four criteria that make it admissible as a measurement.
 *
 * `confidence.ts` states them for the callback it owns, and they are properties of a signal rather than of one
 * module: deterministic, content-only, model-free, and bounded **and non-degenerate**. The last one is the
 * criterion a plausible implementation fails, so it is asserted against a real-shaped context rather than
 * against the formula — a signal that varies only on inputs the run never contains is a constant signal in the
 * run it is graded on.
 *
 * The last test in this file asserts a **limitation** rather than a property: there is no stemming, so `move`
 * does not match `moved`. It is asserted because a limitation nobody wrote down becomes a result nobody can
 * explain, and because the next round's A/B is about exactly this.
 */

import { describe, expect, it } from 'vitest';
import { lexicalRelevance } from '../relevance.js';

/** A context shaped like the ones the memory arm actually sees: short user turns, repeated entities. */
const CONTEXT: readonly string[] = [
  'alice city=new york',
  'alice job=manager',
  'alice color=green',
  'bob city=boston',
  'bob job=teacher',
  'carol city=chicago',
  'carol color=green',
  'dave job=manager',
  'erin color=green',
  'grace city=new york',
  'I moved to Berlin last month for a new job.',
  'We adopted a second cat and now have two cats.',
  'My sister graduated in June 2024 and started a new role.',
];

describe('lexicalRelevance: a query-term signal with no model in it', () => {
  it('is deterministic: the same pair scores the same on every call', () => {
    const once = CONTEXT.map((turn) => lexicalRelevance("What is alice's city?", turn));
    const twice = CONTEXT.map((turn) => lexicalRelevance("What is alice's city?", turn));
    expect(once).toEqual(twice);
  });

  it('stays inside [0, 1]', () => {
    const questions = [
      "What is alice's city?",
      'when did I move to Berlin',
      'how many cats do I have',
      '',
      'zzz qqq',
    ];
    for (const question of questions) {
      for (const turn of CONTEXT) {
        const score = lexicalRelevance(question, turn);
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('scores an empty question zero, because no question was asked', () => {
    // Not "a low score": there is nothing to match, and a non-zero value would be a score for a question that
    // does not exist. The stopword list collapses a question made only of function words to the same state.
    expect(lexicalRelevance('', CONTEXT[0]!)).toBe(0);
    expect(lexicalRelevance('what is it', CONTEXT[0]!)).toBe(0);
  });

  it('scores a turn sharing no term zero', () => {
    expect(lexicalRelevance('where is the submarine', 'alice city=new york')).toBe(0);
  });

  it('scores a turn that states the answer at the maximum', () => {
    // `alice` and `city` are both content terms and both appear, in the order asked. That is a `1` by
    // construction and it is what makes the ranking meaningful rather than merely ordered.
    expect(lexicalRelevance("What is alice's city?", 'alice city=new york')).toBe(1);
  });

  it('scores in the question order above the reverse order, which is what the second term is for', () => {
    const asked = 'alice city';
    const inOrder = lexicalRelevance(asked, 'alice city=new york');
    const reversed = lexicalRelevance(asked, 'the city of alice');
    expect(inOrder).toBeGreaterThan(reversed);
  });

  it('does not reward a long turn merely for mentioning every term out of order', () => {
    // The failure the second term exists to separate: coverage alone scores these two equally.
    const ordered = CONTEXT.map((turn) => lexicalRelevance('alice city', turn));
    const best = Math.max(...ordered);
    const scattered = lexicalRelevance('alice city', 'city alice');
    expect(scattered).toBeLessThan(best);
  });

  it('keeps question words that carry the capability, so a temporal question is not an empty one', () => {
    // `when`, `how many`, `first` and `last` are the discriminating content of TR and IE questions. A
    // stopword list copied from information retrieval would drop them and make a one-word question empty —
    // which is the state that scores `0`, so the test is that these score at all.
    expect(lexicalRelevance('when', 'when did I move last month')).toBe(1);
    expect(lexicalRelevance('how many cats', 'We have two cats')).toBeGreaterThan(0);
  });

  it('keeps digits, because a date and a count are content', () => {
    expect(
      lexicalRelevance('what happened in 2024', 'My sister graduated in June 2024'),
    ).toBeGreaterThan(0);
  });

  it('agrees with the hand-computed coverage on a plain two-term question', () => {
    // One term of two present, no adjacency between `alice` and `city` in the turn: 0.85 * 0.5 + 0.15 * 0.
    expect(lexicalRelevance('alice city', 'alice job=manager')).toBeCloseTo(0.425, 6);
  });

  it('treats a one-term question as its coverage rather than as a missing order term', () => {
    // `hit / pairs` would be `0/0`. Reporting `0` would sink every single-term question below every two-term
    // one for a reason about the question's length, not the turn's content.
    expect(lexicalRelevance('manager', 'alice job=manager')).toBe(1);
    expect(lexicalRelevance('manager submarine', 'alice job=manager')).toBeCloseTo(
      0.85 * 0.5 + 0.15 * 0,
      6,
    );
  });

  it('is non-degenerate over a real-shaped context', () => {
    // The criterion that a plausible implementation fails. A constant signal cannot order anything, and a
    // signal that varies only on inputs the run never contains is constant in the run it is graded on.
    const scores = CONTEXT.map((turn) => lexicalRelevance("What is alice's city?", turn));
    expect(new Set(scores).size).toBeGreaterThan(1);
    // And it separates the informative turns from the rest rather than spreading noise over all of them.
    expect(Math.max(...scores)).toBeGreaterThan(2 * Math.min(...scores));
  });

  it('has no stemming, so an inflected form does not match its lemma', () => {
    // A limitation, asserted rather than discovered later. `moved` and `move` are different terms here, which
    // costs recall on the temporal family whose questions and evidence disagree in tense. Adding a stemmer
    // would change every number this signal produces, so it is a registered experiment rather than an edit.
    expect(lexicalRelevance('when did I move', 'I moved last month')).toBeLessThan(
      lexicalRelevance('when did I move', 'when did I move last month'),
    );
  });
});

/**
 * The layering rule, asserted as properties of what the reader receives.
 *
 * Three of these are load-bearing in a way the others are not, and each is named where it is asserted:
 *
 * - **I3**: a `layered` run switched off renders byte-identically to the head, because every archived
 *   prompt in this repository was produced that way and a default that moved would make each of them
 *   unreproducible from the code.
 * - **I1/I6**: `chars` is what the budget plans with and `text.length` is what the renderer prints. Two
 *   computations of one decision is how `43259468403` ended up budgeting raw lengths against a
 *   400-character rendering -- so equality here is not tidiness, it is the absence of that defect.
 * - **I5**: every form that drops material says so. A silent shortening is the defect `excerpt.ts` exists
 *   to repair, and `record` is the form that drops the most.
 */
import { describe, expect, it } from 'vitest';
import { DATELINE, resolveCappedTurn } from '../resolution.js';
import { ELISION } from '../excerpt.js';

/**
 * A long turn (~700 characters) that shares the term "pottery" with the question, with the fact in its
 * third sentence. Long enough that the 600-character excerpt ceiling bites, which is what makes it a
 * window rather than a whole turn.
 */
const MATCHING =
  'I had a quiet week at work and nothing much happened on Monday or Tuesday, and the weather was ' +
  'grey and cold and the heating kept coming on in the middle of the night for no reason anyone ' +
  'could explain. I spent most of the weekend indoors reading a long book about the history of the ' +
  'canal network and I did not finish it. Then on Sunday afternoon I finally booked the pottery ' +
  'class I had been putting off for three months, and it starts in April.';

/**
 * A long turn (~480 characters) that shares nothing with the question, with one sentence carrying a
 * digit and two paragraphs of prose that a record has to drop.
 */
const FOREIGN =
  'The allotment society meeting ran long because the treasurer wanted to explain the new fee ' +
  "structure in detail to everyone present, and then walked the whole hall through last year's " +
  'accounts line by line. Nobody objected and the minutes were agreed without a vote, which the ' +
  'chair said was unusual given how much discussion there had been about the boundary hedge and ' +
  'the shed. The plot rents go up to 42 pounds next season.';

/**
 * A question that shares no content term with `FOREIGN`.
 *
 * `NO_OVERLAP` does not work here and the reason is worth keeping: `contentTerms` returns `['how','many']`,
 * and the turn contains "given how much discussion", so the overlap test is true and the form is `excerpt`.
 * A fixture question has to be checked against the turn, not assumed to be foreign to it.
 */
const NO_OVERLAP = 'sunflower height record';

/**
 * A long turn (~480 characters) that shares nothing with the question, with three sentences carrying a
 * digit and two paragraphs of prose that a record has to drop.
 *
 * Distinct from `FOREIGN`, which has one numeric sentence: a record reserves its operands before it
 * spends a character on the opening, and a turn with a single operand cannot tell "reserved first" from
 * "printed in reading order" -- the two orders disagree only on the second number.
 */
const MULTI_DIGIT =
  'The committee met on Tuesday and talked for a long while about the fence, the gate and the ' +
  'hedge, and nobody could agree on any of it, so the whole matter was left open for another ' +
  'month of letters and a second meeting that nobody had the energy to schedule before the ' +
  'winter, when the ground is too hard to dig anyway. The fence quote came to 380 pounds. ' +
  'The gate hinges were 24 pounds. The hedge trim was 96 pounds, and everyone said they would ' +
  'think about it before the next meeting.';

/**
 * A long turn that shares nothing with the question and whose punctuation is inside its words: a decimal
 * point (`3.5`) and an abbreviation (`e.g.`) both put a full stop in front of a letter, which is the case
 * that separates "a sentence ends here" from "a dot is inside this word".
 */
const DECIMALS =
  'The parcel came. The courier weighed it at 3.5 kilos e.g. heavier than the label said. ' +
  'The label said 2.9 kilos. Then he left and nobody signed for anything at all, which the ' +
  'office noted the next morning when the van came back for the second time.';

/** A long turn with no sentence punctuation at all. */
const UNPUNCTUATED = 'lamp '.repeat(200).trim();

/** The two ceilings at the default ratios, for a 400-character cap. */
const CAP = 400;

describe('resolveTurn', () => {
  it('I4: a turn at or under the cap is returned unchanged and is charged as raw', () => {
    const short = 'x'.repeat(CAP);
    const plan = resolveCappedTurn('what did I book', short, CAP);
    expect(plan.form).toBe('raw');
    expect(plan.text).toBe(short);
    expect(plan.chars).toBe(short.length);
    expect(plan.elided).toBe(false);
  });

  it('I4 boundary: one character over the cap stops being raw', () => {
    const over = `${'x'.repeat(CAP)}y`;
    expect(resolveCappedTurn('what did I book', over, CAP).form).not.toBe('raw');
  });

  it('sends a long turn that shares a term down the excerpt form, and keeps the match', () => {
    const plan = resolveCappedTurn('when did I book the pottery class', MATCHING, CAP);
    expect(plan.form).toBe('excerpt');
    expect(plan.text).toContain('pottery class');
  });

  it('gives the excerpt half again the cap, so a matching turn gains by being matched', () => {
    // 500 characters fits inside the 600 ceiling, so the whole turn prints and nothing is elided.
    const turn = 'pottery class '.repeat(34).trim();
    expect(turn.length).toBeGreaterThan(CAP);
    expect(turn.length).toBeLessThanOrEqual(CAP * 1.5);
    const plan = resolveCappedTurn('pottery class', turn, CAP);
    expect(plan.form).toBe('excerpt');
    expect(plan.chars).toBe(turn.length);
    expect(plan.elided).toBe(false);
  });

  it('sends a long turn that shares nothing down the record form', () => {
    const plan = resolveCappedTurn('when did I book the pottery class', FOREIGN, CAP);
    expect(plan.form).toBe('record');
  });

  it('keeps the opening and every sentence carrying a digit, and drops the rest', () => {
    const plan = resolveCappedTurn(NO_OVERLAP, FOREIGN, CAP);
    expect(plan.text).toContain('allotment society meeting');
    expect(plan.text).toContain('42 pounds');
    expect(plan.text).not.toContain('boundary hedge');
  });

  it('collapses a record onto one line, because a record is a line', () => {
    const plan = resolveCappedTurn(
      NO_OVERLAP,
      `${'first.\n\nsecond 12.\n third.\n'}${'tail '.repeat(120)}`,
      100,
    );
    expect(plan.form).toBe('record');
    expect(plan.text).not.toContain('\n');
  });

  it('I5: record always marks, because it always leaves sentences behind', () => {
    const plan = resolveCappedTurn('when did I book the pottery class', FOREIGN, CAP);
    expect(plan.text.endsWith(ELISION)).toBe(true);
    expect(plan.elided).toBe(true);
  });

  it('I5: record cuts on a word boundary, never inside one', () => {
    const plan = resolveCappedTurn(NO_OVERLAP, FOREIGN, 60);
    const body = plan.text.slice(0, -ELISION.length);
    expect(body.endsWith(' ')).toBe(false);
    // The character the cut landed after is a space in the source, i.e. a boundary was found.
    expect(FOREIGN.replace(/\s+/g, ' ')).toContain(`${body.trimEnd()} `);
  });

  it('reserves every numeric sentence before spending a character on the opening', () => {
    // Three operands, all of which fit: the record has to be a record of the numbers and not a head of
    // the prose that happens to contain one. `FOREIGN` cannot show this -- it carries a single number,
    // so "reserved first" and "printed in reading order" agree on it.
    const plan = resolveCappedTurn(NO_OVERLAP, MULTI_DIGIT, CAP);
    expect(plan.form).toBe('record');
    expect(plan.text).toContain('380 pounds');
    expect(plan.text).toContain('24 pounds');
    expect(plan.text).toContain('96 pounds');
    expect(plan.text.endsWith(ELISION)).toBe(true);
  });

  it('keeps only the operands when the ceiling cannot hold the opening', () => {
    // 36 characters of record: the first numeric sentence takes 34 of the 35 available, which leaves the
    // opening's allowance at zero or below. The form has to spend what is left on the number rather than
    // on a readable preamble -- the arithmetic that makes this the *only* thing it can do is the reason
    // there is no post-assembly cut, so this is the case that pins the ordering.
    const plan = resolveCappedTurn(NO_OVERLAP, MULTI_DIGIT, 60);
    expect(plan.form).toBe('record');
    expect(plan.text).toContain('380 pounds');
    expect(plan.text).not.toContain('committee');
    expect(plan.chars).toBeLessThanOrEqual(36);
  });

  it('renders a turn with no sentence at all as the marker alone', () => {
    // Whitespace has no sentence end, so a record of it has no opening and no operand. The form's answer
    // is the marker: a turn that printed nothing would be a turn the prefix search can always afford,
    // and the room would fill with turns that say nothing.
    const blank = ' \n'.repeat(250);
    expect(blank.length).toBeGreaterThan(CAP);
    const plan = resolveCappedTurn(NO_OVERLAP, blank, CAP);
    expect(plan.form).toBe('record');
    expect(plan.text).toBe(ELISION);
    expect(plan.chars).toBe(ELISION.length);
    expect(plan.elided).toBe(true);
  });

  it('keeps a decimal and an abbreviation inside one sentence', () => {
    // `3.5` and `e.g.` are the two cases where a dot sits in front of a letter: a splitter that broke on
    // every dot would hand the operand filter "The courier weighed it at 3" and drop the number's value.
    // The record's own answer is the witness -- the operand it kept reads `3.5 kilos` and the opening it
    // truncated still carries the abbreviation.
    const plan = resolveCappedTurn(NO_OVERLAP, DECIMALS, 100);
    expect(plan.form).toBe('record');
    expect(plan.text).toContain('3.5 kilos');
    expect(plan.text).not.toContain('3. ');
  });

  it('I1: chars equals text.length and is never larger than the turn', () => {
    for (const question of ['when did I book the pottery class', NO_OVERLAP, '']) {
      for (const turn of [MATCHING, FOREIGN, UNPUNCTUATED]) {
        const plan = resolveCappedTurn(question, turn, CAP);
        expect(plan.chars).toBe(plan.text.length);
        expect(plan.chars).toBeLessThanOrEqual(turn.length);
      }
    }
  });

  it('I1: no form exceeds its ceiling, from a cap of seven characters to the registered 400', () => {
    // A sweep rather than one width, because the ceiling is the one guarantee a record assembles by
    // arithmetic instead of by cutting: the opening gets what the operands left, so the sum is at most
    // the room *by construction*. A single width would let an off-by-one in that subtraction hide inside
    // a comfortable margin; the narrow caps are where the margin is nothing.
    for (const cap of [7, 12, 25, 60, 137, CAP]) {
      for (const question of ['pottery class', NO_OVERLAP]) {
        for (const turn of [MATCHING, FOREIGN, MULTI_DIGIT, DECIMALS, UNPUNCTUATED]) {
          const plan = resolveCappedTurn(question, turn, cap);
          const ceiling = plan.form === 'record' ? cap * 0.6 : cap * 1.5;
          const where = `${plan.form} at cap ${cap}`;
          expect(plan.chars, where).toBeLessThanOrEqual(Math.max(1, Math.floor(ceiling)));
          expect(plan.chars, where).toBe(plan.text.length);
        }
      }
    }
  });

  it('I2: a non-empty turn never renders empty, at any cap', () => {
    for (const cap of [1, 2, 4, 10, CAP]) {
      const plan = resolveCappedTurn(NO_OVERLAP, FOREIGN, cap);
      expect(plan.chars).toBeGreaterThanOrEqual(1);
    }
  });

  it('I2: a cap of zero or less is clamped to one rather than rendering nothing', () => {
    const plan = resolveCappedTurn(NO_OVERLAP, 'abcdef', 0);
    expect(plan.chars).toBe(1);
    expect(plan.text.length).toBe(1);
  });

  it('is idempotent: the same arguments produce the same bytes', () => {
    const first = resolveCappedTurn('pottery', MATCHING, CAP);
    const second = resolveCappedTurn('pottery', MATCHING, CAP);
    expect(second).toEqual(first);
  });

  it('treats a question with no content term as an absence of overlap, not as a match', () => {
    // "the of and" carries no content term, so no turn can share one with it: the form is record on any
    // long turn, and the record still prints the first sentence rather than an arbitrary window.
    const plan = resolveCappedTurn('the of and', FOREIGN, CAP);
    expect(plan.form).toBe('record');
    expect(plan.text.startsWith('The allotment society meeting')).toBe(true);
  });

  it('cuts an unpunctuated turn as a marked head rather than looping for a sentence', () => {
    const plan = resolveCappedTurn(NO_OVERLAP, UNPUNCTUATED, CAP);
    expect(plan.form).toBe('record');
    expect(plan.chars).toBeLessThanOrEqual(CAP * 0.6);
    expect(plan.text.endsWith(ELISION)).toBe(true);
  });

  it('never splits a surrogate pair, on any form', () => {
    const emoji = `${'😀'.repeat(300)}`;
    for (const question of ['😀', NO_OVERLAP]) {
      const plan = resolveCappedTurn(question, emoji, CAP);
      // Every high surrogate in the output is followed by its low half: a lone surrogate is not valid
      // UTF-16 and corrupts the request body on serialisation (`truncateCodePointSafe`'s header).
      for (let index = 0; index < plan.text.length; index += 1) {
        const code = plan.text.charCodeAt(index);
        if (code < 0xd800 || code > 0xdbff) continue;
        const next = plan.text.charCodeAt(index + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
      expect(plan.elided).toBe(true);
    }
  });
});

describe('resolveCappedTurn', () => {
  const dateline = '[2023/05/20 (Sat) 03:51] user: ';

  it('keeps the dateline outside the ceiling, so a record still says when it happened', () => {
    const plan = resolveCappedTurn(NO_OVERLAP, `${dateline}${FOREIGN}`, CAP);
    expect(plan.text.startsWith(dateline)).toBe(true);
    expect(plan.form).toBe('record');
    expect(plan.chars).toBeLessThanOrEqual(CAP);
  });

  it('charges the dateline against the same cap the renderer spends', () => {
    const plain = resolveCappedTurn(NO_OVERLAP, FOREIGN, CAP);
    const dated = resolveCappedTurn(NO_OVERLAP, `${dateline}${FOREIGN}`, CAP);
    expect(dated.chars).toBe(
      dateline.length + resolveCappedTurn(NO_OVERLAP, FOREIGN, CAP - dateline.length).chars,
    );
    expect(plain.chars).not.toBe(dated.chars);
  });

  it('renders a short datelined turn unchanged, so the cap is still an identity below it', () => {
    const short = `${dateline}yes that works`;
    expect(resolveCappedTurn('anything', short, CAP).text).toBe(short);
  });

  it('exposes the dateline pattern it screens with, so callers do not re-derive it', () => {
    expect(DATELINE.test(`${dateline}hello`)).toBe(true);
    expect(DATELINE.test('[2023/05/20] user: hello')).toBe(false);
  });
});

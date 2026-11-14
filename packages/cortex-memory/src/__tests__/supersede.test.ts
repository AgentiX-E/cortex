/**
 * §13.366: the supersession adjudicator.
 *
 * ## What these tests are written against
 *
 * The pass replaces an answer, and this campaign has already paid twice for passes that replaced answers
 * without checking the replacement: `tally` lost 9.5 multi-session questions, and `spec` lost 39 with 43 of
 * its 46 flips damages. `MEASURE-PLAN-SHAPE.md` is the reading that turned that into a rule — an
 * authorization gate has to be a property of the **relation between the two answers**.
 *
 * So every test below is about a way the relation can fail to hold, and each one has a name in the census.
 * A refused claim is not an error path: it is the mechanism reporting that it was asked to substitute
 * something the evidence does not support, which is the only outcome that keeps the pass from becoming a
 * fourth substitution without an authorization.
 */

import { describe, expect, it } from 'vitest';

import {
  adjudicateSupersession,
  emptySupersessionCensus,
  parseSupersessionReport,
  type SupersessionReport,
} from '../supersede.js';

const EVIDENCE = [
  '[2023/01/10 (Tue) 03:14] user: My follower count is 1250 and I am happy with it.',
  '[2023/02/11 (Sat) 09:02] assistant: That is a good number of followers.',
  '[2023/03/12 (Sun) 11:40] user: Small update, I crossed 1300 followers last week.',
].join('\n');

function report(over: Partial<SupersessionReport> = {}): SupersessionReport {
  return {
    changed: true,
    later: '1300',
    when: '2023/03/12 (Sun) 11:40',
    shape: 'three-lines',
    ...over,
  };
}

describe('what counts as one evidence record', () => {
  it('groups a turn that spans lines, so a quote on its second line is still dated', () => {
    // The renderer keeps a turn's own text verbatim and a turn may contain newlines, so the line is not the
    // unit. A quote on a continuation line is dated by the record that opens above it, which is what makes the
    // "same line" requirement in the instruction expressible at all.
    const multiline = [
      '[2023/01/10 (Tue) 03:14] user: my follower count is 1250 and I',
      'have been tracking it for a while',
      '[2023/03/12 (Sun) 11:40] user: I crossed 1300',
      'followers last week',
    ].join('\n');
    const verdict = adjudicateSupersession(report(), '1250', multiline);

    expect(verdict).toMatchObject({ kind: 'replace', value: '1300', record: 1 });
  });

  it('fails closed on evidence that opens with no date at all', () => {
    // Evidence with no bracket has no record boundary to split on and no date to require, so a supersession
    // cannot be authorised against it. That is the correct direction: the alternative is authorising on a date
    // the evidence never wrote.
    const undated = 'my follower count is 1250\nI crossed 1300 followers';
    const verdict = adjudicateSupersession(report(), '1250', undated);

    expect(verdict).toEqual({ kind: 'keep', reason: 'date-not-on-line' });
  });
});

describe('how a span is compared to the evidence', () => {
  it('folds case, so a reader that upper-cases a value is still quoting it', () => {
    const evidence = '[2023/01/01 (Sun) 00:00] user: the class is on Friday now';
    const verdict = adjudicateSupersession(
      { changed: true, later: 'FRIDAY', when: '2023/01/01 (Sun) 00:00', shape: 'three-lines' },
      'Thursday',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: 'FRIDAY', record: 0 });
  });

  it('keeps the characters that are part of a value, so a stripped one is not authorised', () => {
    // `$3,750` and `3750` are different spans. A key that dropped the punctuation would authorise a
    // substitution the evidence does not contain, which is the whole failure mode the check exists to stop.
    const evidence = '[2023/01/01 (Sun) 00:00] user: I sold the bike for $3,750';
    const stripped = adjudicateSupersession(
      { changed: true, later: '3750', when: '2023/01/01 (Sun) 00:00', shape: 'three-lines' },
      '2,000',
      evidence,
    );
    const exact = adjudicateSupersession(
      { changed: true, later: '$3,750', when: '2023/01/01 (Sun) 00:00', shape: 'three-lines' },
      '2,000',
      evidence,
    );

    expect(stripped).toMatchObject({ kind: 'keep', reason: 'not-in-evidence' });
    expect(exact).toMatchObject({ kind: 'replace', value: '$3,750', record: 0 });
  });
});

describe('reading the three lines', () => {
  it('reads the contract shape', () => {
    const parsed = parseSupersessionReport(
      'CHANGED: yes\nLATER: 1300\nWHEN: 2023/03/12 (Sun) 11:40',
    );

    expect(parsed).toEqual({
      changed: true,
      later: '1300',
      when: '2023/03/12 (Sun) 11:40',
      shape: 'three-lines',
    });
  });

  it('treats NONE as the absence the contract means by it', () => {
    const parsed = parseSupersessionReport('CHANGED: yes\nLATER: NONE\nWHEN: NONE');

    expect(parsed.shape).toBe('three-lines');
    expect(parsed.later).toBeNull();
    expect(parsed.when).toBeNull();
  });

  it('is case-insensitive about the labels and tolerant about the spacing', () => {
    const parsed = parseSupersessionReport('changed:Yes\n later:  1300  \nWhen:2023/03/12');

    expect(parsed.changed).toBe(true);
    expect(parsed.later).toBe('1300');
    expect(parsed.when).toBe('2023/03/12');
  });

  it('does not read a CHANGED value it cannot parse as either answer', () => {
    // A third state is possible and has to stay out of both counts: a reply that did not say yes or no is a
    // reply whose author did not follow the contract, which is `unreadable` rather than `no-change`.
    expect(parseSupersessionReport('CHANGED: maybe\nLATER: 1300\nWHEN: x').changed).toBeNull();
  });

  it('separates an unreadable reply from one that said no', () => {
    // Prose is not `false`. `false` is a reader that read the evidence and found no later value, which is a
    // fact about the population; prose is a reply that did not follow the contract, which is a fact about the
    // call. Collapsing them would let a broken prompt read as a population with nothing to supersede.
    expect(parseSupersessionReport('The answer is Friday.').changed).toBeNull();
    expect(parseSupersessionReport('The answer is Friday.').shape).toBe('none');
    expect(parseSupersessionReport('CHANGED: no\nLATER: NONE\nWHEN: NONE').changed).toBe(false);
  });

  it('names a partial reply as partial rather than as a complete one', () => {
    expect(parseSupersessionReport('CHANGED: yes\nLATER: 1300').shape).toBe('partial');
    expect(parseSupersessionReport('').shape).toBe('none');
    expect(parseSupersessionReport(null).changed).toBeNull();
  });

  it('reads an empty value as an absent one, so a blank line is not a claim', () => {
    // `LATER:` with nothing after it is the state a model reaches when it decides there is no span but has
    // already committed to `CHANGED: yes`. It has to read as "no quote" rather than as the empty string,
    // which would otherwise be compared against the evidence and rejected as `not-in-evidence` -- the wrong
    // reason, kept forever in the census.
    const parsed = parseSupersessionReport('CHANGED: yes\nLATER:\nWHEN:');

    expect(parsed.shape).toBe('partial');
    expect(parsed.later).toBeNull();
    expect(parsed.when).toBeNull();
  });
});

describe('the adjudication', () => {
  it('replaces when the span is in the evidence and its date is on the same record', () => {
    const verdict = adjudicateSupersession(report(), '1250', EVIDENCE);

    expect(verdict).toMatchObject({ kind: 'replace', value: '1300', record: 2 });
  });

  it('refuses a claim that is not in the evidence, and says so by name', () => {
    const verdict = adjudicateSupersession(report({ later: '1400' }), '1250', EVIDENCE);

    expect(verdict).toEqual({ kind: 'keep', reason: 'not-in-evidence' });
  });

  it('refuses a real value promoted on a date that is not on its record', () => {
    // The value is there; the date the reader attached to it is not on the line it claims to have copied.
    // This is the check a substring test alone cannot make, and it is the reason the instruction asks for
    // both fields: an invention has to agree with the evidence twice to get through.
    const verdict = adjudicateSupersession(
      report({ when: '2023/04/01 (Sat) 00:00' }),
      '1250',
      EVIDENCE,
    );

    expect(verdict).toEqual({ kind: 'keep', reason: 'date-not-on-line' });
  });

  it('refuses a claim that names no date at all', () => {
    expect(adjudicateSupersession(report({ when: null }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'date-not-on-line',
    });
  });

  it('refuses a date that is nothing but punctuation', () => {
    // `WHEN: ""` normalises to the empty string, and an empty string is a substring of every record — so
    // without this check the date requirement would pass on any evidence at all. It is the one place where
    // "contains" is true of everything and therefore means nothing.
    expect(adjudicateSupersession(report({ when: '""' }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'date-not-on-line',
    });
  });

  it('refuses when the quote appears on a record that lacks the date, even if another has it', () => {
    // `1300` appears twice: once on the record the reader named and once on a line with no date. Requiring
    // the date on **every** record the quote appears on is the strict reading, and the strict reading is
    // correct here -- a later value that also appears earlier is exactly the ambiguity this pass exists to
    // get right, so it fails closed rather than choosing.
    const twice = [
      '[2023/01/10 (Tue) 03:14] user: I have 1300 followers.',
      '[2023/03/12 (Sun) 11:40] user: I crossed 1300 followers.',
    ].join('\n');
    const verdict = adjudicateSupersession(report(), '1250', twice);

    expect(verdict).toEqual({ kind: 'keep', reason: 'date-not-on-line' });
  });

  it('refuses a quote that is just the answer it would replace', () => {
    // Without this the pass reports a replacement on every question where the reader copies its own answer,
    // and `replaced` counts conversions that never happened.
    expect(adjudicateSupersession(report({ later: '1250' }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'agrees',
    });
  });

  it('takes the value out of a sentence, because a span is not the answer (§13.369)', () => {
    // `42976296380` refused 6 of the 10 correct identifications on length alone -- `ed4ddc30` by two
    // characters, `a2f3aa27` while quoting `I think I'm close to 1300 now` against a gold of `1300` -- and two
    // of the six were the gate's own targets. The span is how the reader demonstrates that it copied; the
    // numeral inside it is what the answer becomes.
    const sentence = 'Small update, I crossed 1300 followers last week.';
    expect(adjudicateSupersession(report({ later: sentence }), '1250', EVIDENCE)).toMatchObject({
      kind: 'replace',
      value: '1300 followers',
      record: 2,
    });
  });

  it('keeps the unit a value carries, so `30 dozen` does not become `30`', () => {
    const evidence = '[2023/03/12 (Sun) 11:40] user: I am at 30 dozen at the moment.';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '30 dozen at the moment',
        when: '2023/03/12 (Sun) 11:40',
        shape: 'three-lines',
      },
      '20 dozen',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '30 dozen', record: 0 });
  });

  it('drops a word that is not a unit, so an adverb is not part of the value', () => {
    const evidence = '[2023/05/01 (Mon) 10:00] user: I think I am close to 1300 now.';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: 'I think I am close to 1300 now',
        when: '2023/05/01 (Mon) 10:00',
        shape: 'three-lines',
      },
      '1250',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '1300', record: 0 });
  });

  it('takes the last new numeral in a span, because a span that states two states the second about the first', () => {
    const evidence = '[2023/05/01 (Mon) 10:00] user: It went from 1250 to 1300 followers.';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: 'It went from 1250 to 1300 followers',
        when: '2023/05/01 (Mon) 10:00',
        shape: 'three-lines',
      },
      '1250',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '1300 followers', record: 0 });
  });

  it('refuses a span whose numerals are all already in the answer, and names it a restatement', () => {
    // `dad224aa` answered `7:30 am` and its quote was a restatement of that value. Neither a fabrication nor a
    // length problem: substituting it would report a conversion that never happened, which is a fourth thing
    // the census has to be able to count (`42976296380` could not, because `too-long` was stated about length).
    const evidence = '[2023/05/01 (Mon) 10:00] user: Yes, 7:30 am, same as always.';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '7:30 am, same as always',
        when: '2023/05/01 (Mon) 10:00',
        shape: 'three-lines',
      },
      '7:30 am',
      evidence,
    );

    expect(verdict).toEqual({ kind: 'keep', reason: 'restates' });
  });

  it('takes a value-shaped span whole when it carries no numeral at all', () => {
    // `ce6d2d27` answers `Thursday` and its gold is a weekday; `9ea5eabc` is a place. A rule stated only over
    // numerals cannot represent either, and both are document-order targets -- refusing them would be the same
    // defect as the ceiling, in a new place. §13.370 registers the amendment before its dispatch.
    const evidence = '[2023/03/12 (Sun) 11:40] user: The class moved to Friday.';
    const verdict = adjudicateSupersession(
      { changed: true, later: 'Friday', when: '2023/03/12 (Sun) 11:40', shape: 'three-lines' },
      'Thursday',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: 'Friday', record: 0 });
  });

  it('refuses a clause that carries no numeral, because a clause is not a value', () => {
    const evidence = '[2023/03/12 (Sun) 11:40] user: I moved it, it is on Friday from now on.';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: 'I moved it, it is on Friday from now on',
        when: '2023/03/12 (Sun) 11:40',
        shape: 'three-lines',
      },
      'Thursday',
      evidence,
    );

    expect(verdict).toEqual({ kind: 'keep', reason: 'restates' });
  });

  it('does not read the numerals of a calendar date as values', () => {
    // A date on the copied line is what `WHEN` is for. Without this rule `moved to Friday on 2023/03/12` would
    // yield `2023/03/12` -- or, worse, `12` -- as the answer to a question about a weekday.
    const evidence = '[2023/03/12 (Sun) 11:40] user: the class moved to Friday on 2023/03/12';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: 'the class moved to Friday on 2023/03/12',
        when: '2023/03/12 (Sun) 11:40',
        shape: 'three-lines',
      },
      'Thursday',
      evidence,
    );

    expect(verdict).toEqual({ kind: 'keep', reason: 'restates' });
  });

  it('takes a numeral that ends the span, with no unit to carry', () => {
    const evidence = '[2023/03/12 (Sun) 11:40] user: small update, we reached 1300';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: 'small update, we reached 1300',
        when: '2023/03/12 (Sun) 11:40',
        shape: 'three-lines',
      },
      '1250',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '1300', record: 0 });
  });

  it('carries no unit when the next token is not a word', () => {
    // A symbol after the numeral is not a unit this rule can name -- `300 $` is the same value as `300` and a
    // token copied from a table cell must not be appended to an answer as if it were a word.
    const evidence = '[2023/03/12 (Sun) 11:40] user: the ticket now costs 300 $';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: 'the ticket now costs 300 $',
        when: '2023/03/12 (Sun) 11:40',
        shape: 'three-lines',
      },
      '250',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '300', record: 0 });
  });

  it('accepts a span that carries a line break, because the value is one token of it', () => {
    const wrapped = '1300 followers\nlast week';
    expect(adjudicateSupersession(report({ later: wrapped }), '1250', EVIDENCE)).toMatchObject({
      kind: 'replace',
      value: '1300 followers',
      record: 2,
    });
  });

  it('takes the reader at its word when it says nothing changed', () => {
    expect(adjudicateSupersession(report({ changed: false }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'no-change',
    });
  });

  it('refuses an unreadable reply rather than reading it as a no', () => {
    expect(adjudicateSupersession(report({ changed: null }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'unreadable',
    });
  });

  it('refuses a yes with no span, and a span that is empty once unquoted', () => {
    expect(adjudicateSupersession(report({ later: null }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'no-quote',
    });
    expect(adjudicateSupersession(report({ later: '""' }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'no-quote',
    });
  });

  it('accepts a quote the reader wrapped in quotation marks, and returns it trimmed', () => {
    const verdict = adjudicateSupersession(report({ later: '"1300"' }), '1250', EVIDENCE);

    expect(verdict).toMatchObject({ kind: 'replace', value: '"1300"', record: 2 });
  });
});

describe('the census', () => {
  it('starts with every reason present at zero, so absence is never inferred from a missing key', () => {
    const census = emptySupersessionCensus();

    expect(census.attempted).toBe(0);
    expect(census.replaced).toBe(0);
    expect(Object.values(census.refusals).every((count) => count === 0)).toBe(true);
    expect(Object.keys(census.refusals)).toHaveLength(8);
  });
});

describe('the ordering check, which the span and the date cannot supply', () => {
  const EGG_EARLY =
    '[2023/01/11 (Wed) 12:18] user: we have a lot in the fridge - 30 dozen at the moment!';
  const EGG_LATE =
    '[2023/03/15 (Wed) 10:52] user: we have got 20 dozen stocked up in the fridge right now.';
  const EGG_EVIDENCE = [EGG_EARLY, EGG_LATE].join('\n');

  it('refuses a span that is earlier than the statement the answer rests on', () => {
    // `ed4ddc30`, measured: gold `20`, the answer quotes the March turn, and the only span the reader offered
    // was the January `30 dozen at the moment`. Both checkable fields pass on that span -- it is in the evidence
    // and its date is on the same record -- so without this check the pass replaces a correct answer with the
    // value it supersedes. That is the direction the mechanism is named for, and nothing above tests it.
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '30 dozen at the moment',
        when: '2023/01/11 (Wed) 12:18',
        shape: 'three-lines',
      },
      '20 dozen',
      EGG_EVIDENCE,
    );

    expect(verdict).toEqual({ kind: 'keep', reason: 'not-later' });
  });

  it('replaces when the span is later than the statement the answer rests on', () => {
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up in the fridge right now',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      '30 dozen',
      EGG_EVIDENCE,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '20 dozen', record: 1 });
  });

  it('does not order two statements in one record, and takes the reader at its word', () => {
    // A single turn that states both values has an order no stamp records. Refusing there would make the guard's
    // reach depend on how the corpus happened to be segmented, which is the defect `a2f3aa27` already exhibits
    // in the other direction (`MEASURE-CONFLICT-SURFACING.md` section 2: the replacing sentence shares one term
    // with the question, where the statement it replaces shares two).
    const oneTurn =
      '[2023/05/25 (Thu) 09:00] user: I had 1250 followers but now I am close to 1300.';
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: 'close to 1300',
        when: '2023/05/25 (Thu) 09:00',
        shape: 'three-lines',
      },
      '1250',
      oneTurn,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '1300', record: 0 });
  });

  it('does not order against an answer whose own statement is not in the evidence', () => {
    // A composed answer has no turn to be later than. Skipping the check there is the choice that fails open,
    // and it is deliberate: the alternative would refuse every substitution on a question whose evidence never
    // restates the answer's phrasing, which is a property of the answer rather than of the evidence.
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up in the fridge right now',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      'about twenty egg cartons',
      EGG_EVIDENCE,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '20 dozen', record: 1 });
  });
});

describe('the stamps the ordering check can and cannot read', () => {
  it('orders records whose stamp carries no time', () => {
    // A corpus that dates a turn by day alone still has an order, and a rule that required minutes would skip the
    // check on every record of that corpus -- a guard silently off, which is the failure every census in this
    // repository is built to make visible.
    const dated = [
      '[2023/01/11] user: we have 30 dozen',
      '[2023/03/15] user: we have 20 dozen',
    ].join('\n');
    const verdict = adjudicateSupersession(
      { changed: true, later: '30 dozen', when: '2023/01/11', shape: 'three-lines' },
      '20 dozen',
      dated,
    );

    expect(verdict).toEqual({ kind: 'keep', reason: 'not-later' });
  });

  it('skips the ordering when a stamp is unreadable, rather than inventing one', () => {
    // `[undated]` is not a date, and an ordering computed against a guessed one is the fabricated-value defect
    // the rest of this file refuses. The substitution still has to pass the span and date checks, so skipping here
    // leaves the guard's other two conditions standing.
    const undated = [
      '[undated] user: we have 30 dozen',
      '[2023/03/15] user: we have 20 dozen',
    ].join('\n');
    const verdict = adjudicateSupersession(
      { changed: true, later: '30 dozen', when: 'undated', shape: 'three-lines' },
      '20 dozen',
      undated,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '30 dozen', record: 0 });
  });

  it('skips the ordering when the answer is empty, because there is nothing to locate', () => {
    const evidence = '[2023/03/15 (Wed) 10:52] user: we have 20 dozen stocked up.';
    const verdict = adjudicateSupersession(
      { changed: true, later: '20 dozen', when: '2023/03/15 (Wed) 10:52', shape: 'three-lines' },
      '',
      evidence,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '20 dozen', record: 0 });
  });
});

describe('two records that carry the same stamp', () => {
  it('does not call one later than the other, and does not refuse either', () => {
    // Equal stamps in two records happen when a corpus repeats a date for two turns of one sitting. The comparison
    // has no answer there, and the requirement is "later", so a zero must not be read as "not later" -- that would
    // refuse every substitution inside a single sitting, which is where most corrections live.
    const twice = [
      '[2023/03/15 (Wed) 10:52] user: we have 30 dozen stocked up',
      '[2023/03/15 (Wed) 10:52] user: sorry, we have 20 dozen stocked up',
    ].join('\n');
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      '30 dozen',
      twice,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '20 dozen', record: 1 });
  });
});

describe('an answer whose own record carries no date at all', () => {
  it('does not order against a record with no stamp', () => {
    // Evidence that opens with no bracket is one record with `date: null` -- the shape `evidenceRecords` produces
    // for a turn the renderer could not date. There is nothing to compare against, so the ordering is skipped and
    // the span and date checks still stand.
    const mixed = [
      'my follower count is 20 dozen',
      '[2023/03/15 (Wed) 10:52] user: we have 30 dozen stocked up',
    ].join('\n');
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '30 dozen stocked up',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      '20 dozen',
      mixed,
    );

    expect(verdict).toMatchObject({ kind: 'replace', value: '30 dozen', record: 1 });
  });
});

describe('evidence the renderer numbered, which is every prompt the product sends', () => {
  // `formatEvidence` labels each turn `${index + 1}. `, so a delivered record opens `1. [2023/…] user: …` and
  // **no line of a real window starts with a bracket**. The splitter used to require exactly that, which made
  // every real prompt one record — and the three consequences are what these tests pin, because each of them
  // was invisible while the fixtures were unnumbered strings.
  const NUMBERED = [
    '1. [2023/01/11 (Wed) 12:18] user: we have 30 dozen at the moment',
    '',
    '2. [2023/03/15 (Wed) 10:52] user: we have 20 dozen stocked up in the fridge right now',
  ].join('\n');

  it('splits a numbered window into one record per turn', () => {
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      '30 dozen',
      NUMBERED,
    );
    // `record: 1`, not `0`. On the old splitter this was always `0` because there was always one record, and a
    // census reading `record` was reading a constant.
    expect(verdict).toMatchObject({ kind: 'replace', value: '20 dozen', record: 1 });
  });

  it('runs the ordering check on a numbered window, which it never did before', () => {
    // `ed4ddc30`'s shape: the answer is the March value and the reader offers the January one. On the old
    // splitter `answerRecord === last.index === 0`, the guard skipped a comparison inside one record, and the
    // correct answer was replaced by the value it supersedes — the exact direction the mechanism is named for.
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '30 dozen at the moment',
        when: '2023/01/11 (Wed) 12:18',
        shape: 'three-lines',
      },
      '20 dozen stocked up',
      NUMBERED,
    );
    expect(verdict).toEqual({ kind: 'keep', reason: 'not-later' });
  });

  it('requires the date on the record the quote is on, not anywhere in the window', () => {
    // With one record this passed: `comparisonKey(record.text).includes(when)` searched the whole window, so a
    // date from the *other* turn satisfied the rule. That is not what the instruction says, and it is the
    // weaker of the two claims by a wide margin.
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '30 dozen at the moment',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      'nothing at all',
      NUMBERED,
    );
    expect(verdict).toEqual({ kind: 'keep', reason: 'date-not-on-line' });
  });

  it('reads a record position written as `#n ` too, so the other rendering is not a second splitter', () => {
    const itemIds = [
      '#3 [2023/01/11 (Wed) 12:18] user: we have 30 dozen at the moment',
      '#4 [2023/03/15 (Wed) 10:52] user: we have 20 dozen stocked up',
    ].join('\n\n');
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      '30 dozen',
      itemIds,
    );
    expect(verdict).toMatchObject({ kind: 'replace', value: '20 dozen', record: 1 });
  });
});

describe('the receipt the verdict carries', () => {
  const NUMBERED = [
    '1. [2023/01/11 (Wed) 12:18] user: we have 30 dozen at the moment',
    '',
    '2. [2023/03/15 (Wed) 10:52] user: we have 20 dozen stocked up in the fridge right now',
  ].join('\n');

  it('names both records, so a caller does not re-split the evidence to learn what it was told', () => {
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      '30 dozen',
      NUMBERED,
    );
    expect(verdict.kind).toBe('replace');
    if (verdict.kind !== 'replace') throw new Error('expected a replacement');
    // Verbatim, header included: a caller that wants the sentence has to be able to find it in the evidence by
    // the bytes it was given, and a normalised copy would not be findable.
    expect(verdict.authorised.later.text).toBe(
      '2. [2023/03/15 (Wed) 10:52] user: we have 20 dozen stocked up in the fridge right now',
    );
    expect(verdict.authorised.earlier!.text).toBe(
      '1. [2023/01/11 (Wed) 12:18] user: we have 30 dozen at the moment',
    );
  });

  it('converts each stamp to epoch milliseconds, so the two axes have numbers', () => {
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up',
        when: '2023/03/15 (Wed) 10:52',
        shape: 'three-lines',
      },
      '30 dozen',
      NUMBERED,
    );
    if (verdict.kind !== 'replace') throw new Error('expected a replacement');
    expect(verdict.authorised.later.at).toBe(Date.UTC(2023, 2, 15, 10, 52));
    expect(verdict.authorised.earlier!.at).toBe(Date.UTC(2023, 0, 11, 12, 18));
  });

  it('answers `null` for a stamp that is not a calendar date, rather than letting the clock correct it', () => {
    // `Date.UTC(2023, 12, 45)` normalises to 2024-02-14 instead of refusing. A fact dated with the corrected
    // instant would no longer match the record it quotes, and every downstream comparison — ordering,
    // `deriveSupersedes`, the window filter — would be reasoning about a date the corpus never said.
    const impossible = [
      '1. [2023/01/11 (Wed) 12:18] user: we have 30 dozen at the moment',
      '',
      '2. [2023/13/45 (Wed) 10:52] user: we have 20 dozen stocked up',
    ].join('\n');
    const verdict = adjudicateSupersession(
      {
        changed: true,
        later: '20 dozen stocked up',
        when: '2023/13/45 (Wed) 10:52',
        shape: 'three-lines',
      },
      '30 dozen',
      impossible,
    );

    expect(verdict.kind).toBe('replace');
    if (verdict.kind !== 'replace') throw new Error('expected a replacement');
    expect(verdict.authorised.later.at).toBeNull();
    expect(verdict.authorised.later.date).toBe('2023/13/45 (Wed) 10:52');
  });
});

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

    expect(verdict).toEqual({ kind: 'replace', value: '1300', record: 1 });
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

    expect(verdict).toEqual({ kind: 'replace', value: 'FRIDAY', record: 0 });
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

    expect(stripped).toEqual({ kind: 'keep', reason: 'not-in-evidence' });
    expect(exact).toEqual({ kind: 'replace', value: '$3,750', record: 0 });
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

    expect(verdict).toEqual({ kind: 'replace', value: '1300', record: 2 });
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

  it('refuses a sentence, even one that is in the evidence', () => {
    const sentence = 'Small update, I crossed 1300 followers last week.';
    expect(adjudicateSupersession(report({ later: sentence }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'too-long',
    });
  });

  it('refuses a quote that carries a line break', () => {
    const wrapped = '1300 followers\nlast week';
    expect(adjudicateSupersession(report({ later: wrapped }), '1250', EVIDENCE)).toEqual({
      kind: 'keep',
      reason: 'too-long',
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

    expect(verdict).toEqual({ kind: 'replace', value: '"1300"', record: 2 });
  });
});

describe('the census', () => {
  it('starts with every reason present at zero, so absence is never inferred from a missing key', () => {
    const census = emptySupersessionCensus();

    expect(census.attempted).toBe(0);
    expect(census.replaced).toBe(0);
    expect(Object.values(census.refusals).every((count) => count === 0)).toBe(true);
    expect(Object.keys(census.refusals)).toHaveLength(7);
  });
});

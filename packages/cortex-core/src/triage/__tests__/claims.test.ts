/**
 * The sentence-level gate between "stored" and "asked about".
 *
 * ## The defect these tests are written against
 *
 * `accept` publishes a card's text. Before this gate, the card's text was the whole turn the owner
 * said, and a deferral is what the rules do with **87.2%** of real user sentences (40,961 of 46,951,
 * measured on the LongMemEval-S run in `test/card-volume/result.json`). 73.6% of those turns contain
 * a question mark, so the queue's normal case was asking whether a colleague should be allowed to
 * read "Can you write the texts for the PowerPoint presentation ?" -- and answering yes published it.
 *
 * ## What is pinned here, and why each group exists
 *
 *  1. **The splitter does not cut inside a name, a date or a number.** A false split produces a
 *     fragment, and a fragment below three words is refused, so a bad split is how a claim becomes
 *     invisible. The abbreviation cases are therefore not cosmetic.
 *  2. **The gate refuses requests in the forms real users type them.** A question mark, a WH-word at
 *     the start, an imperative verb -- the corpus showed all three, and questions phrased without a
 *     question mark were the ones an earlier version missed.
 *  3. **The gate keeps the forty rows a person already judged.** `triage-labels.json` is the only set
 *     where "should this have been a question?" was answered before any rule existed; losing one of
 *     its deferrals would mean the change traded a real claim for tidier text.
 *  4. **The claims, not the turn, are what a card carries.** Order preserved, whitespace normalised,
 *     nothing added and nothing paraphrased -- the owner still has to be able to recognise their own
 *     sentence in the export.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { claimsIn, isClaim, splitSentences } from '../claims.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const labels = JSON.parse(readFileSync(join(HERE, 'fixtures', 'triage-labels.json'), 'utf8')) as {
  rows: { id: string; text: string; gold: 'private' | 'shared' | 'defer' }[];
};

describe('splitSentences', () => {
  it('returns nothing for text with no content', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n\t  ')).toEqual([]);
  });

  it('keeps a run with no terminal punctuation as one sentence', () => {
    expect(splitSentences('  half a thought  ')).toEqual(['half a thought']);
  });

  it('splits on a period, a bang and a question mark', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('normalises every run of whitespace, so a card has no layout from the transcript', () => {
    expect(splitSentences('One.\n\nTwo.\tThree.')).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('does not split after a title abbreviation', () => {
    expect(splitSentences('Hi Dr. Grove, thanks for the review.')).toEqual([
      'Hi Dr. Grove, thanks for the review.',
    ]);
  });

  it('does not split after a month, a Latin abbreviation or a corporate suffix', () => {
    expect(splitSentences('It shipped in Jan. 2024.')).toEqual(['It shipped in Jan. 2024.']);
    expect(splitSentences('Bring water, snacks, etc. and a hat.')).toEqual([
      'Bring water, snacks, etc. and a hat.',
    ]);
    expect(splitSentences('Acme Inc. is the vendor.')).toEqual(['Acme Inc. is the vendor.']);
  });

  it('does not split after a single initial', () => {
    expect(splitSentences('J. Smith runs the team.')).toEqual(['J. Smith runs the team.']);
  });

  it('does not split inside a number', () => {
    expect(splitSentences('It costs 3.5 million.')).toEqual(['It costs 3.5 million.']);
  });

  it('keeps a run of terminal punctuation with its sentence', () => {
    expect(splitSentences('Really?! Yes.')).toEqual(['Really?!', 'Yes.']);
  });

  it('keeps the tail when the text ends without punctuation', () => {
    expect(splitSentences('One. And then')).toEqual(['One.', 'And then']);
  });

  it('merges rather than cuts when an abbreviation is followed by a capitalised word', () => {
    // The permissive direction, asserted: `Inc.` protects the split, so the two sentences arrive as
    // one longer sentence. That can only add text to a card; the alternative is a fragment.
    expect(splitSentences('Works at Acme Inc. Then it closed.')).toEqual([
      'Works at Acme Inc. Then it closed.',
    ]);
  });
});

describe('isClaim', () => {
  it('refuses a sentence that asks', () => {
    expect(isClaim('Can you write the texts for the presentation ?')).toBe(false);
    expect(isClaim('Is the dress white and gold or black and blue?')).toBe(false);
  });

  it('refuses a question phrased without a question mark, which the corpus is full of', () => {
    expect(isClaim('what is settings')).toBe(false);
    expect(isClaim('How can the design be created from the diagram')).toBe(false);
    expect(isClaim('who did pocahontas marry')).toBe(false);
  });

  it('refuses an instruction', () => {
    expect(isClaim('please continue, provide 10 additional examples')).toBe(false);
    expect(isClaim('create the focal and sub-ordinate goals based on the interviews')).toBe(false);
    expect(isClaim('Give me the sprint backlog for the next two weeks')).toBe(false);
  });

  it('accepts a word that only begins with an imperative', () => {
    // `Write-ups` is not the verb `write`; an anchored-but-unbounded rule would drop a real claim.
    expect(isClaim('Write-ups are due on Friday for the whole team')).toBe(true);
    expect(isClaim('Formatting rules changed in the last release')).toBe(true);
  });

  it('refuses a fragment too short to carry anything', () => {
    expect(isClaim('Thank you')).toBe(false);
    expect(isClaim('sounds good')).toBe(false);
    expect(isClaim('ok')).toBe(false);
  });

  it('accepts a claim that opens with an acknowledgement', () => {
    // Two of the forty fixture deferrals look like this; a rule keyed on the opening word lost them.
    expect(isClaim('Yeah, I must have gotten the festival name mixed up.')).toBe(true);
  });

  it('accepts an assertion of exactly the word floor', () => {
    expect(isClaim('The build is green')).toBe(true);
  });
});

describe('claimsIn', () => {
  it('returns nothing for a turn that is only a request', () => {
    expect(claimsIn('Can you write the texts for the PowerPoint presentation ?')).toEqual([]);
    expect(claimsIn('Thank you!')).toEqual([]);
    expect(claimsIn('')).toEqual([]);
  });

  it('keeps the claims of a mixed turn and drops the question', () => {
    expect(claimsIn('I run a team of four. Can you draft an agenda? We ship on Fridays.')).toEqual([
      'I run a team of four.',
      'We ship on Fridays.',
    ]);
  });

  it('loses a claim fused into a question by a comma conjunction, and the loss is stated', () => {
    // The known blind spot, pinned so it cannot grow silently: one sentence, one destination.
    expect(
      claimsIn(
        'I like categorizing my coupons, but how do I decide which categories to prioritize?',
      ),
    ).toEqual([]);
  });

  it('preserves order and does not paraphrase', () => {
    const turn = 'The vendor is Acme. Their contract ends in March.';
    expect(claimsIn(turn)).toEqual(['The vendor is Acme.', 'Their contract ends in March.']);
  });
});

describe('the forty deferrals a person judged before any rule existed', () => {
  const deferrals = labels.rows.filter((row) => row.gold === 'defer');

  it('is the set these tests are calibrated on', () => {
    expect(deferrals).toHaveLength(40);
  });

  it('still produces a claim for every one of them', () => {
    const lost = deferrals.filter((row) => claimsIn(row.text).length === 0).map((row) => row.id);
    expect(lost).toEqual([]);
  });

  it('produces a claim that is a substring of what the person said, so the card is recognisable', () => {
    for (const row of deferrals) {
      const flat = row.text.replace(/\s+/g, ' ').trim();
      for (const claim of claimsIn(row.text)) expect(flat).toContain(claim);
    }
  });
});

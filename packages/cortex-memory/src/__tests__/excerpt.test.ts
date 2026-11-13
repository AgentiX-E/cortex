/**
 * The window rule.
 *
 * Every assertion here is a property of the prompt the reader receives, not of the string helper: an
 * excerpt that exceeds the cap overruns a room the artifact says was respected, and one that does not
 * mark its elision hands the reader a sentence that stops -- the `a4996e51` defect, one layer down.
 */
import { describe, expect, it } from 'vitest';
import { ELISION, excerptAround, truncateCodePointSafe } from '../excerpt.js';
import { contentTerms } from '../relevance.js';

/** A turn long enough to be cut at 120 characters, with the fact placed past the head. */
const LONG =
  'I spent the weekend with my sister in the Lakes and we walked up a hill in the rain and we ' +
  'talked about the house she wants to buy near Kendal, and then on Sunday afternoon I finally ' +
  'booked the pottery class I had been putting off for three months.';

describe('excerptAround', () => {
  it('returns a turn shorter than the cap unchanged, with no marker', () => {
    expect(excerptAround('short turn', 'anything at all', 200)).toBe('short turn');
  });

  it('returns the empty string for a cap of zero or less, rather than a marker with nothing in it', () => {
    expect(excerptAround(LONG, 'pottery', 0)).toBe('');
    expect(excerptAround(LONG, 'pottery', -5)).toBe('');
  });

  it('keeps the sentence the question is about instead of the first characters of the turn', () => {
    const excerpt = excerptAround(LONG, 'when did I book the pottery class', 120);
    expect(excerpt).toContain('pottery class');
    expect(excerpt).not.toContain('weekend with my sister');
  });

  it('keeps a quarter of the room before the match, so the clause that carries it arrives too', () => {
    // A window that opened exactly on the matched term would print the answer without its operand:
    // "pottery class" without "booked the". `LEAD_SHARE` is the decision that buys the operand, so the
    // assertion names the words before the match rather than the match itself.
    const excerpt = excerptAround(LONG, 'pottery class', 120);
    expect(excerpt).toContain('booked the pottery class');
  });

  it('marks the elision on both sides when the window is in the middle', () => {
    const text = `${'filler lead. '.repeat(40)}the pottery class was booked${' and filler tail.'.repeat(40)}`;
    const excerpt = excerptAround(text, 'pottery class', 120);
    expect(excerpt).toContain('pottery class');
    expect(excerpt.startsWith(ELISION)).toBe(true);
    expect(excerpt.endsWith(ELISION)).toBe(true);
  });

  it('does not mark a side the window reaches', () => {
    // The match sits in the last few characters, so the window runs to the end of the turn and the
    // trailing elision would be a claim about text that is not there.
    const text = `${'filler lead. '.repeat(40)}the pottery class`;
    const excerpt = excerptAround(text, 'pottery class', 120);
    expect(excerpt.endsWith(ELISION)).toBe(false);
    expect(excerpt.startsWith(ELISION)).toBe(true);
  });

  it('marks only the side it cut, and nothing when it cut nothing', () => {
    // A match in the first few characters: the window starts at 0, so there is nothing before it to mark.
    const leading = excerptAround(LONG, 'spent the weekend', 120);
    expect(leading.startsWith(ELISION)).toBe(false);
    expect(leading.endsWith(ELISION)).toBe(true);
  });

  it('never exceeds the cap, on any cap from four characters up', () => {
    for (let cap = 4; cap <= LONG.length + 4; cap += 1) {
      expect(excerptAround(LONG, 'pottery class', cap).length).toBeLessThanOrEqual(cap);
    }
  });

  it('never exceeds the cap where the question shares no term with the turn', () => {
    for (let cap = 4; cap <= 200; cap += 1) {
      expect(excerptAround(LONG, 'quantum chromodynamics', cap).length).toBeLessThanOrEqual(cap);
    }
  });

  it('falls back to a marked head when no term of the question occurs in the turn', () => {
    const excerpt = excerptAround(LONG, 'quantum chromodynamics', 120);
    expect(excerpt.endsWith(ELISION)).toBe(true);
    expect(excerpt.startsWith('I spent the weekend')).toBe(true);
    expect(excerpt).not.toContain('pottery');
  });

  it('falls back to a marked head when the question carries no content term', () => {
    // Two different reasons to have nothing to anchor on, and the code has two branches for them: a question
    // made only of stopwords has no term at all (`how many did I do` does not qualify -- `how` and `many` are
    // content terms, which is why the earlier version of this test was the same case as the one above).
    expect(contentTerms('do i')).toHaveLength(0);
    const excerpt = excerptAround(LONG, 'do i', 120);
    expect(excerpt.startsWith('I spent the weekend')).toBe(true);
    expect(excerpt.endsWith(ELISION)).toBe(true);
  });

  it('refuses to emit a marker it cannot pay for: under four characters it is a plain cut', () => {
    expect(excerptAround(LONG, 'pottery', 3)).toBe(truncateCodePointSafe(LONG, 3));
  });

  it('chooses the window that covers the most distinct question terms', () => {
    const text =
      'We discussed the budget in March. ' +
      'x'.repeat(200) +
      ' Then the offsite in Lisbon with the budget review and the catering contract was cancelled.';
    const excerpt = excerptAround(text, 'offsite lisbon catering contract', 150);
    expect(excerpt).toContain('offsite');
    expect(excerpt).toContain('catering');
    expect(excerpt).not.toContain('discussed the budget');
  });

  it('prefers the earliest window when two candidates cover the same terms', () => {
    // Both occurrences fall inside the first candidate, so the two windows score the same and the tie-break
    // decides. The sweep has to retire the first occurrence as its left edge passes it while the second is
    // still inside -- the count is what says how many are left, and a count that went to zero with a copy
    // still in the room would score the second window as empty.
    const text = `${'filler '.repeat(30)}pottery${' x'.repeat(15)} pottery${' y'.repeat(60)}`;
    const excerpt = excerptAround(text, 'pottery', 120);
    expect(excerpt.match(/pottery/g)).toHaveLength(2);
  });

  it('is deterministic and free of regex state between calls', () => {
    const first = excerptAround(LONG, 'pottery class', 120);
    for (let round = 0; round < 3; round += 1) {
      expect(excerptAround(LONG, 'pottery class', 120)).toBe(first);
    }
  });

  it('never splits a surrogate pair', () => {
    const emoji = '🏺';
    const text = `${emoji.repeat(60)} the pottery class was booked ${emoji.repeat(60)}`;
    const excerpt = excerptAround(text, 'pottery class', 41);
    expect(excerpt).toContain('pottery');
    for (const unit of excerpt) expect(unit).not.toBe('\uFFFD');
    expect(excerpt.length).toBeLessThanOrEqual(41);
  });

  it('keeps a match that sits in the last few characters of the turn', () => {
    const text = `${'filler sentence here. '.repeat(20)}the answer is pottery.`;
    const excerpt = excerptAround(text, 'pottery', 120);
    expect(excerpt).toContain('pottery');
    expect(excerpt.endsWith('pottery.')).toBe(true);
  });

  it('cuts at a word boundary on both sides, rather than mid-word', () => {
    // The filler is uniform words, so a cut placed at a character offset lands inside one with near
    // certainty -- which is what makes this an assertion about the boundary rather than about the offset.
    // Every cap from 24 to 200 is read, because a single cap can land on a space by luck: one that
    // does cannot tell a snapped cut from an unsnapped one, and the property is about all of them.
    const filler = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet ';
    const text = `${filler.repeat(6)}the pottery class ${filler.repeat(6)}`;
    let cuts = 0;

    for (let cap = 24; cap <= 200; cap += 1) {
      const excerpt = excerptAround(text, 'pottery', cap);
      expect(excerpt).toContain('pottery');

      const body = excerpt.replaceAll(ELISION, '');
      const at = text.indexOf(body);
      expect(at).toBeGreaterThanOrEqual(0);
      if (excerpt.startsWith(ELISION)) {
        // The character before the kept span is the boundary the window snapped back to: mid-word would
        // mean the reader sees the tail of a word with no beginning.
        expect(text[at - 1]).toMatch(/\s/);
        cuts += 1;
      }
      if (excerpt.endsWith(ELISION)) {
        // And the character after it, for the same reason in the other direction.
        expect(text[at + body.length]).toMatch(/\s/);
        cuts += 1;
      }
    }

    // A loop that stopped asserting would pass vacuously; this is the count of boundaries it read.
    expect(cuts).toBeGreaterThan(100);
  });
});

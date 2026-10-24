/**
 * The marker table, and the phrases that look like markers.
 *
 * The two readings this suite protects are the ones that decided the design:
 *
 * - a **temporal** token never buys a causal edge (`taxonomy.ts` asserts the licence table; this file
 *   asserts that the token is read as temporal in the first place);
 * - a phrase that contains a marker without being one produces **no marker at all**, which is how
 *   `g10`'s "for a while" and `g32`'s "wondering if" stopped inflating the fidelity census.
 */

import { describe, expect, it } from 'vitest';
import { MARKER_TOKENS, NOT_MARKERS, isMarkerOf, kindsIn, relationMarkers } from '../markers.js';
import { RELATION_KINDS } from '../taxonomy.js';

/** The tokens of every marker found, in order. */
function tokensIn(text: string): string[] {
  return relationMarkers(text).map((marker) => marker.token.toLowerCase());
}

describe('relationMarkers: the tokens that license a relation', () => {
  it('finds one marker per class with its position', () => {
    const text = 'I finished the course, so I want to apply it.';
    const found = relationMarkers(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ kind: 'causal', token: 'so', start: 23, end: 25 });
  });

  it('reads a sentence-initial connective, which is capitalised for grammar and not for meaning', () => {
    // The token is returned in its table form rather than its surface form: a marker is an identity
    // that a licence is looked up by, and two spellings of one identity is how a lookup starts
    // failing on the sentence that begins with a capital.
    expect(relationMarkers('Because it rained, we stayed in.')).toEqual([
      { kind: 'causal', token: 'because', start: 0, end: 7 },
    ]);
  });

  it('sorts by position so the sentence spine can be printed in order', () => {
    const found = relationMarkers('I moved before the lease ended, but then we stayed.');
    expect(found.map((marker) => marker.start)).toEqual(
      [...found.map((marker) => marker.start)].sort((a, b) => a - b),
    );
    expect(found.map((marker) => marker.kind)).toEqual(['temporal', 'contrast', 'temporal']);
  });

  it('never matches a token inside a longer word', () => {
    expect(tokensIn('I also finished it.')).toEqual([]);
    expect(tokensIn('The software update landed.')).toEqual([]);
  });

  it('prefers the longer connective when two overlap at the same position', () => {
    expect(tokensIn('I left early so that I could catch the train.')).toEqual(['so that']);
    expect(tokensIn('They stayed even though the weather turned.')).toEqual(['even though']);
  });

  it('treats a multi-word temporal marker as one, not as its parts', () => {
    expect(tokensIn('Now that the report is done, I can rest.')).toEqual(['now that']);
  });

  it('reports the same token twice when the sentence says it twice', () => {
    const found = relationMarkers('I called before lunch and before the meeting.');
    expect(found.filter((marker) => marker.token === 'before')).toHaveLength(2);
  });
});

describe('relationMarkers: phrases that contain a marker without being one', () => {
  // Both cases are real cards from the reviewed set, not hypotheticals: they were counted as
  // relations by the first census and produced a wrong reading.
  it('ignores "for a while", which is a duration (g10)', () => {
    expect(tokensIn("I've been tracking my analytics for a while now.")).toEqual([]);
  });

  it('ignores "wondering if", which is an embedded question (g32)', () => {
    expect(tokensIn('I was wondering if you could help me.')).toEqual([]);
  });

  it('ignores the other embedded-question forms', () => {
    for (const text of [
      'Let me know if that works.',
      'I will check if it is open.',
      'Ask if they deliver.',
    ]) {
      expect(tokensIn(text), text).toEqual([]);
    }
  });

  it('ignores "as if", which compares rather than conditions', () => {
    expect(tokensIn('It looks as if it will rain.')).toEqual([]);
  });

  it('still reads a real condition next to a blocked one', () => {
    // The block is a span, not a sentence-level veto: "wondering if" is removed and the second `if`
    // is a condition, so a sentence that does both must produce exactly one marker.
    expect(tokensIn('I was wondering if you could tell me if the shop opens early.')).toEqual([
      'if',
    ]);
  });

  it('keeps every exclusion longer than the token it hides', () => {
    // A shorter exclusion would hide a substring and leave the token exposed around it.
    for (const phrase of NOT_MARKERS) {
      const token = Object.values(MARKER_TOKENS)
        .flat()
        .find((candidate) => phrase.includes(candidate));
      expect(token, phrase).toBeDefined();
      expect(phrase.length).toBeGreaterThanOrEqual(token!.length);
    }
  });
});

describe('MARKER_TOKENS: the table is a partition, not a pile', () => {
  it('assigns each token to exactly one class', () => {
    const owner = new Map<string, string>();
    for (const kind of RELATION_KINDS) {
      for (const token of MARKER_TOKENS[kind]) {
        expect(owner.has(token), `${token} is in both ${owner.get(token)} and ${kind}`).toBe(false);
        owner.set(token, kind);
      }
    }
  });

  it('declares every relation class, so a new class cannot be added without its tokens', () => {
    expect(Object.keys(MARKER_TOKENS).sort()).toEqual([...RELATION_KINDS].sort());
  });

  it('keeps tokens lower case, because matching is case-insensitive and the id is stored', () => {
    for (const kind of RELATION_KINDS) {
      for (const token of MARKER_TOKENS[kind]) {
        expect(token, token).toBe(token.toLowerCase());
      }
    }
  });
});

describe('isMarkerOf and kindsIn', () => {
  it('accepts a token of the class, ignoring case and padding', () => {
    expect(isMarkerOf(' So ', 'causal')).toBe(true);
    expect(isMarkerOf('so', 'temporal')).toBe(false);
  });

  it('lists the classes present once each, in table order', () => {
    expect(kindsIn('I stayed because it rained, but I still left during the break.')).toEqual([
      'causal',
      'temporal',
      'contrast',
    ]);
  });

  it('reports nothing for a sentence with no connective', () => {
    expect(kindsIn('I moved to Berlin in March.')).toEqual([]);
  });
});

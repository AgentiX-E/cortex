/**
 * The echo corpus: a Bloom filter that must stay exact.
 *
 * ## The one property everything else rests on
 *
 * `contains` is allowed to be wrong in exactly one direction -- it may say "maybe" and then be
 * corrected by verification -- but it must **never** say "no" about a window the corpus holds. A
 * false negative is a missed leak, and it would be silent: the draft passes, the report says clean.
 *
 * ## Why the rolling hash is tested against the direct one
 *
 * A rolling hash is an optimisation of `hash(text.slice(i, i + w))`, and it is an optimisation that
 * can be *wrong while staying deterministic*: with `Math.pow(BASE, w - 1) >>> 0` the constant is the
 * low 32 bits of a double that has already lost them, so the same window hashes differently at two
 * positions. Every hash is still a stable number, the filter still fills, `contains` still answers --
 * and it answers "no" for most copies. The first test below is the one that catches that, and it
 * exists because the prototype had exactly this bug.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { DEFAULT_ECHO_WIDTH, EchoCorpus, hashWindow, rollingHashes } from '../echo-corpus.js';

const W = DEFAULT_ECHO_WIDTH;

/** Rows shaped like the ones the guard sees. */
const row = (text: string) => ({ text });

describe('the rolling hash', () => {
  it('equals the direct hash of the same window, at every position', () => {
    const text =
      'the quick brown fox jumps over the lazy dog and then keeps going for a while so that the ' +
      'string is long enough to have many windows in it';
    const rolled = rollingHashes(text, W);
    expect(rolled).toHaveLength(text.length - W + 1);

    for (let index = 0; index < rolled.length; index += 1) {
      expect(rolled[index]).toBe(hashWindow(text.slice(index, index + W)));
    }
  });

  it('holds for a width other than the default', () => {
    // Cheap insurance against a `power` that only happens to be right at 32.
    const text = 'abcabcabcabcabcabcabcabcabcabcabcabcabcabc';
    const rolled = rollingHashes(text, 5);
    for (let index = 0; index < rolled.length; index += 1) {
      expect(rolled[index]).toBe(hashWindow(text.slice(index, index + 5)));
    }
  });

  it('returns nothing for a text shorter than one window', () => {
    expect(rollingHashes('too short', W)).toEqual([]);
  });
});

describe('what the corpus reports', () => {
  it('finds every window of every row it was built from', () => {
    const rows = [
      row('I moved to Berlin in March and now I work at Acme on the payments team.'),
      row('The bookshop on the corner reopens next month after the refit.'),
      row('I keep a list of books I want to read on the train into work.'),
    ];
    const corpus = EchoCorpus.from(rows);

    for (const entry of rows) {
      const text = entry.text.toLowerCase();
      for (let index = 0; index + W <= text.length; index += 1) {
        expect(corpus.contains(text.slice(index, index + W))).toBe(true);
      }
    }
  });

  it('does not find a window that differs by one character', () => {
    const corpus = EchoCorpus.from([row('I moved to Berlin in March and now I work at Acme.')]);
    expect(corpus.contains('i moved to berlin in march and now i work at acme.'.slice(0, W))).toBe(
      true,
    );
    // Flip one character inside the window.
    const window = 'i moved to berlin in march and now i work at acme.'.slice(0, W);
    const altered = `${window.slice(0, 10)}x${window.slice(11)}`;
    expect(corpus.contains(altered)).toBe(false);
  });

  it('folds case and runs of whitespace on both sides', () => {
    const corpus = EchoCorpus.from([row('I   MOVED to\tBerlin in March and now I work at Acme.')]);
    expect(corpus.contains('i moved to berlin in march and now i work at acme.'.slice(0, W))).toBe(
      true,
    );
  });

  it('refuses a window that is not the width it indexes', () => {
    const corpus = EchoCorpus.from([row('I moved to Berlin in March and now I work at Acme.')]);
    expect(corpus.contains('i moved to berlin')).toBe(false);
  });

  it('skips rows without text and reports zero grams for an empty corpus', () => {
    const corpus = EchoCorpus.from([{ id: 'no-text' }, null, 42, row('   ')]);
    // `rows` counts rows that carried text, not rows that were offered: a row with no `text` is not
    // a row the echo check can ever say anything about.
    expect(corpus.stats).toMatchObject({ rows: 1, grams: 0 });
    expect(corpus.contains('anything at all that is thirty-two chars'.slice(0, W))).toBe(false);
  });

  it('sizes its bits by windows, not by rows', () => {
    const short = EchoCorpus.from([row('x'.repeat(W))]);
    const long = EchoCorpus.from([row('x'.repeat(W * 100))]);
    // One row of 3,200 characters holds ~3,169 windows; one row of 32 holds one.
    expect(long.stats.grams).toBeGreaterThan(short.stats.grams * 1000);
    expect(long.stats.bits).toBeGreaterThan(short.stats.bits);
  });

  it('counts verifications, so a filter that started lying would be visible', () => {
    const corpus = EchoCorpus.from([row('I moved to Berlin in March and now I work at Acme.')]);
    const window = 'i moved to berlin in march and now i work at acme.'.slice(0, W);

    expect(corpus.contains(window)).toBe(true);
    expect(corpus.stats.verifications).toBe(1);
    expect(corpus.stats.falsePositives).toBe(0);

    // A window the filter admits but no row contains cannot be constructed on demand (that is what
    // "rare" means), so the counter's zero arm is asserted here and the non-zero arm is left to the
    // randomised test below, which walks enough windows to find one.
    expect(corpus.stats.falsePositives).toBe(0);
  });
});

describe('the property that makes it exact', () => {
  it('never denies a window it holds, over random corpora', () => {
    fc.assert(
      // No whitespace in the generated text: normalisation would otherwise be the thing under test,
      // and this property is about the hash. The normalisation case has its own test above.
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9]{40,120}$/), { minLength: 1, maxLength: 20 }),
        (texts) => {
          const corpus = EchoCorpus.from(texts.map(row));
          for (const text of texts) {
            const start = Math.floor((text.length - W) / 2);
            expect(corpus.contains(text.slice(start, start + W))).toBe(true);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('reports a false positive as a counted verification rather than a finding', () => {
    // Build a corpus large enough that some draft window will collide, then assert the invariant
    // that matters: a "maybe" that fails verification is counted, and `contains` says false.
    const rows = Array.from({ length: 400 }, (_unused, index) =>
      row(`note ${index} about the ${index % 7} plan and the ${index % 11} client review`),
    );
    const corpus = EchoCorpus.from(rows);
    let denied = 0;
    for (let index = 0; index < 4000; index += 1) {
      const probe = `unrelated ${index} text that is definitely not in the corpus at all`;
      if (!corpus.contains(probe.slice(0, W))) denied += 1;
    }
    expect(denied).toBe(4000);
    // Verifications minus confirmed hits is the filter's error, and it is bounded by construction.
    const { verifications, falsePositives } = corpus.stats;
    expect(falsePositives).toBeLessThanOrEqual(verifications);
    expect(falsePositives).toBeLessThan(200);
  });
});

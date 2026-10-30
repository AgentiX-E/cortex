/**
 * A fingerprint of the prompt, for the one question the artifact could not answer.
 *
 * `§13.168.8` registers this field on every record. Its job is narrow and exact:
 * decide whether passes 2-4 of a dispatch sent the **same request** as pass 1. If
 * they did, the 11.16% cache credit is the provider's answer to `§13.147.3`'s 60-80%
 * prediction; if they did not, the arm has been calling four different prompts
 * repetitions, and the cheapest finding in this whole cost section is an arm defect
 * rather than a billing one.
 *
 * ## What these tests are for, given that the implementation is three lines
 *
 * Two properties are load-bearing and neither is visible by reading the call:
 *
 *   - **it is a real digest**, not a length or a prefix. A fingerprint that collided
 *     across two different prompts would report "byte-identical" for requests that
 *     were not, which is the failure mode this instrument exists to rule out. Known
 *     answers pin the algorithm, and a randomised cross-check against `node:crypto`
 *     over two hundred strings pins that the implementation and the oracle agree on
 *     inputs the fixture never names;
 *   - **`null` stays `null`**. A decline before a reader is reached has no prompt, and
 *     hashing the empty string there would make "no request" and "an empty request"
 *     the same value at the one layer that can still tell them apart.
 *
 * The truncation is part of the contract and is asserted, because a reader comparing
 * two artifacts has to know that equality means "equal in 64 bits".
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { promptDigest } from '../prompt-digest.js';

describe('promptDigest', () => {
  it('matches the published SHA-256 of "abc", truncated', () => {
    // FIPS 180-4's canonical vector. `ba7816bf8f01cfea414140de5dae2223...` cut to the
    // sixteen hex characters the artifact carries.
    expect(promptDigest('abc')).toBe('ba7816bf8f01cfea');
  });

  it('matches the published SHA-256 of the empty string, which is not the same as null', () => {
    expect(promptDigest('')).toBe('e3b0c44298fc1c14');
  });

  it('changes when one character changes', () => {
    // The acceptance row in `§13.168.5` is stated as "a fixture mutation changes it",
    // and this is that mutation: a single character, in the middle of a prompt-shaped
    // string, must move the digest.
    const before = promptDigest('Instructions\n\nQ: where?\n\nEVIDENCE:\n1. Lisbon');
    const after = promptDigest('Instructions\n\nQ: where?\n\nEVIDENCE:\n1. LisboN');

    expect(before).not.toBe(after);
  });

  it('is stable across calls, since equality is the whole reading', () => {
    const text = 'x'.repeat(24_000);

    expect(promptDigest(text)).toBe(promptDigest(text));
  });

  it('keeps the distinction between no prompt and an empty one', () => {
    expect(promptDigest(null)).toBeNull();
    expect(promptDigest('')).not.toBeNull();
    expect(promptDigest('')).not.toBe(promptDigest(null));
  });

  it('is sixteen lowercase hex characters, and the length is the contract', () => {
    // Truncated to 64 bits so five hundred records stay a few kilobytes, and stated as
    // an assertion so that a later widening is a change to what artifact equality
    // means rather than an implementation detail.
    const digest = promptDigest('anything')!;

    expect(digest).toHaveLength(16);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('agrees with node:crypto on inputs the fixture never names', () => {
    // The oracle test. Without it, the four vectors above would only prove the
    // implementation agrees with itself on strings someone chose while looking at it.
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 0x80000000;
      return seed;
    };
    for (let i = 0; i < 200; i += 1) {
      const length = next() % 400;
      let text = '';
      for (let j = 0; j < length; j += 1) text += String.fromCharCode(32 + (next() % 95));
      expect(promptDigest(text)).toBe(
        createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
      );
    }
  });
});

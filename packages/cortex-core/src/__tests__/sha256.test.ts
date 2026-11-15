/**
 * The digest this package implements, checked against the two authorities that could catch it lying.
 *
 * ## Why a hand-written SHA-256 needs this much test
 *
 * A borrowed hash is trusted because it is borrowed. This one is not borrowed — it is here because the two
 * alternatives fail on this module's contract (a `node:crypto` import would move the product entry behind a
 * Node builtin, and `crypto.subtle.digest` is async inside a synchronous key function). So the trust has to
 * be manufactured, and it is manufactured twice:
 *
 * 1. **The published vectors.** NIST's four, including the million-`a` case, which is the only one that
 *    exercises multi-block state chaining at a scale a padding bug cannot fake.
 * 2. **A differential test against `node:crypto`.** The vectors are fifteen strings; the corpus a cache
 *    actually sees is anything. Where the two implementations can disagree is the *encoder*, not the
 *    compression function, so the differential corpus is chosen to attack the encoder: astral planes, a
 *    lone high and a lone low surrogate, NUL, a BOM, a string that is exactly a padding boundary.
 *
 * The second is why a failure here is diagnosable rather than mysterious: `node:crypto` is the reference,
 * and it is the answer that wins.
 *
 * ## What is deliberately not asserted
 *
 * Timing. A cache key is not a secret comparison, and a constant-time claim nobody measures is worse than
 * no claim.
 */
import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../cache/sha256.js';

/** NIST FIPS 180-2 / the `sha256sum` vectors every implementation is checked against. */
const PUBLISHED: readonly (readonly [string, string])[] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
  ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

/** The strings that distinguish a correct UTF-8 encoder from an almost-correct one. */
const ENCODER_CORPUS: readonly (readonly [string, string])[] = [
  ['ascii only', 'the bicycle was repaired on tuesday'],
  ['latin-1 range', 'héllo wörld'],
  ['two-byte boundary', '\u07ff'],
  ['three-byte boundary', '\u0800'],
  ['BMP', '中文测试 and 日本語'],
  ['astral', '😀🎉🧪'],
  ['astral pair adjacent', '😀😀'],
  ['lone high surrogate', '\ud800'],
  ['lone low surrogate', '\udc00'],
  ['lone surrogate inside text', 'a\ud800b'],
  ['high surrogate at the end', 'abc\ud83d'],
  ['NUL', 'a\u0000b'],
  ['BOM', '\ufeffstart'],
  ['padding boundary 55', 'a'.repeat(55)],
  ['padding boundary 56', 'a'.repeat(56)],
  ['padding boundary 63', 'a'.repeat(63)],
  ['padding boundary 64', 'a'.repeat(64)],
  ['mixed', 'ẞ\u0000😀\ud800é'],
];

describe('sha256 over a string', () => {
  for (const [input, expected] of PUBLISHED) {
    it(`matches the published digest of ${JSON.stringify(input.slice(0, 16))}`, () => {
      expect(sha256Hex(input)).toBe(expected);
    });
  }

  for (const [name, text] of ENCODER_CORPUS) {
    it(`agrees with node:crypto on ${name}`, () => {
      // The reference is the platform's, encoder and all: `TextEncoder` decides what the bytes are and
      // `createHash` decides what the digest is, so a disagreement is this file's bug by construction.
      const reference = createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
      expect(sha256Hex(text)).toBe(reference);
    });
  }

  it('encodes a lone surrogate as the replacement character, which is what TextEncoder does', () => {
    // Stated as its own assertion because it is a decision rather than an accident: two different lone
    // surrogates then hash alike, and throwing instead would make a key function fail on a string the
    // caller had already accepted everywhere else.
    expect(sha256Hex('\ud800')).toBe(sha256Hex('\ufffd'));
    expect(sha256Hex('\udc00')).toBe(sha256Hex('\ufffd'));
    // And a pair is not the replacement character: the encoder must not flatten what it cannot see.
    expect(sha256Hex('😀')).not.toBe(sha256Hex('\ufffd\ufffd'));
  });

  it('is a 64-character lowercase hex string, always', () => {
    for (const [, text] of ENCODER_CORPUS) {
      expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is a function of the text: one changed code unit changes the digest', () => {
    // A cache key that collided on two texts would return a vector the endpoint never produced, and the
    // only thing standing between that and a retrieval bug is this property of the digest.
    const base = sha256Hex('the invoice was paid late');
    expect(sha256Hex('the invoice was paid late.')).not.toBe(base);
    expect(sha256Hex('The invoice was paid late')).not.toBe(base);
  });

  it('has no import of its own, which is what lets the browser entry reach it', async () => {
    // The module's whole reason for existing is that `node:crypto` cannot be in this entry. A future edit
    // that added the import "because it is already available in Node" would fail here rather than in a
    // consumer's bundle, which is one release later.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../cache/sha256.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

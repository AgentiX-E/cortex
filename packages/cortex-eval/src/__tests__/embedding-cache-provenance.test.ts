/**
 * A cache entry must be able to say **which model produced it**, or it must not be used.
 *
 * ## The defect this suite exists for
 *
 * `deserializeEmbeddingCache` documented itself as throwing "on a corrupt or incompatible
 * buffer so a stale cache is never silently trusted". It checked `magic` and `version` and
 * nothing else. Neither field carries the identity of the embedding backend, so two vectors
 * produced by two different models were byte-indistinguishable to this reader as long as both
 * were 1024-wide.
 *
 * That is not a hypothetical. `benchmark.yml` restores its Actions cache under the key
 * `longmemeval-embedding-<corpus sha256>-`: while the corpus does not change, a run inherits the
 * previous run's vectors. Query vectors are embedded fresh every run; haystack vectors come from
 * the cache. If the endpoint, the model id or the normalisation behind `embedding-3` changed
 * between two of those runs, the reader scored fresh query vectors against stale haystack
 * vectors, and **every counter in the artifact still read healthy** — `determinism max abs diff 0`
 * only ever proved that the same text embeds the same way twice, which stays true across a model
 * change.
 *
 * ## Why the fix removes the file's ability to lie rather than adding a check beside it
 *
 * A provenance header that is written but not compared would repeat the defect in a new place.
 * So `deserializeEmbeddingCache` takes the provenance the *calling run* is about to use and
 * refuses a buffer that was produced under any other one. Version 1 buffers are refused too, and
 * that is deliberate rather than incidental: they carry no identity, so there is no evidence
 * that would let them be trusted. Re-embedding is the recovery path.
 *
 * ## What each assertion is for
 *
 * The round-trip test is the one that would have passed on the broken code, so it is stated
 * first and marked as the control. Every other case is a way the identity can differ, one at a
 * time, because a comparison that only looked at `dimensions` would pass five of the six.
 */
import { describe, it, expect } from 'vitest';
import { serializeEmbeddingCache, deserializeEmbeddingCache } from '../retrieval.js';
import type { EmbeddingProvenance } from '../embedding-factory.js';

const ZHIPU: EmbeddingProvenance = {
  provider: 'openai-compatible',
  model: 'embedding-3',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  dimensions: 4,
};

/** The error a thunk raises, so a test can assert on `name` without importing the class. */
function caught(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw, and it returned');
}

function cache(): Map<string, Float64Array> {
  return new Map([
    ['hello world', Float64Array.from([0.1, 0.2, 0.3, 0.4])],
    ['a second turn', Float64Array.from([0.5, 0.25, 0.125, 0.0625])],
  ]);
}

describe('a cache written under one provenance cannot be read under another', () => {
  it('control: the same provenance round-trips, contents intact', () => {
    // The only case the previous code passed. Stated first because a fix that broke this
    // would be indistinguishable from a fix at all.
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(cache(), ZHIPU), ZHIPU);
    expect([...restored.keys()]).toEqual(['hello world', 'a second turn']);
    // Compared after `Math.fround` on both sides: the file stores float32 and the reader widens
    // back to float64, so the round trip is exact **in float32**, not in the decimal literals the
    // fixture was written with. Asserting the literals would pin a precision the format does not
    // claim.
    expect([...restored.get('hello world')!].map((v) => Math.fround(v))).toEqual([
      ...Float32Array.from([0.1, 0.2, 0.3, 0.4]),
    ]);
  });

  it('refuses a buffer produced by a different model id', () => {
    const other: EmbeddingProvenance = { ...ZHIPU, model: 'text-embedding-3-small' };
    const bytes = serializeEmbeddingCache(cache(), ZHIPU);
    expect(caught(() => deserializeEmbeddingCache(bytes, other)).name).toBe(
      'EmbeddingCacheProvenanceError',
    );
  });

  it('refuses a buffer produced by a different endpoint', () => {
    const other: EmbeddingProvenance = { ...ZHIPU, baseUrl: 'https://api.openai.com/v1' };
    const bytes = serializeEmbeddingCache(cache(), ZHIPU);
    expect(caught(() => deserializeEmbeddingCache(bytes, other)).name).toBe(
      'EmbeddingCacheProvenanceError',
    );
  });

  it('refuses a buffer produced by a different provider even at the same width', () => {
    // The case the width check cannot see: the offline hash fallback and an HTTP model can
    // both be configured to N dimensions, and their vectors are not in the same space.
    const hashed: EmbeddingProvenance = {
      provider: 'hash',
      model: null,
      baseUrl: null,
      dimensions: 4,
    };
    const bytes = serializeEmbeddingCache(cache(), ZHIPU);
    expect(caught(() => deserializeEmbeddingCache(bytes, hashed)).name).toBe(
      'EmbeddingCacheProvenanceError',
    );
  });

  it('refuses a buffer whose provenance declares a different width than its vectors', () => {
    // Two independent claims about the same property, so the header is checked against the
    // payload rather than only against the caller: a header edited to match the caller's
    // provenance must not make a 4-wide payload readable as an 8-wide one.
    const bytes = serializeEmbeddingCache(cache(), ZHIPU);
    const taller: EmbeddingProvenance = { ...ZHIPU, dimensions: 8 };
    expect(caught(() => deserializeEmbeddingCache(bytes, taller)).name).toBe(
      'EmbeddingCacheProvenanceError',
    );
  });

  it('names both identities in the error, so a log line is enough to diagnose it', () => {
    const other: EmbeddingProvenance = { ...ZHIPU, model: 'some-other-model' };
    const bytes = serializeEmbeddingCache(cache(), ZHIPU);
    let message = '';
    try {
      deserializeEmbeddingCache(bytes, other);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('embedding-3');
    expect(message).toContain('some-other-model');
  });
});

describe('a buffer with no identity cannot be trusted, so it is refused', () => {
  it('refuses a version-1 buffer, which carried only magic, version, count and dim', () => {
    // Hand-built in the old layout: magic "EMBC" big-endian, version 1, count 1, dim 4, one
    // entry. The previous reader accepted exactly this.
    const text = Buffer.from('hello world', 'utf8');
    const payload = 4 + text.length + 4 * 4;
    const buf = Buffer.alloc(13 + payload);
    let offset = 0;
    buf.writeUInt32BE(0x454d4243, offset); // magic
    offset += 4;
    buf.writeUInt8(1, offset); // the version that had no provenance
    offset += 1;
    buf.writeUInt32LE(1, offset); // count
    offset += 4;
    buf.writeUInt32LE(4, offset); // dim
    offset += 4;
    buf.writeUInt32LE(text.length, offset);
    offset += 4;
    text.copy(buf, offset);
    offset += text.length;
    for (const value of [0.1, 0.2, 0.3, 0.4]) {
      buf.writeFloatLE(value, offset);
      offset += 4;
    }

    expect(() => deserializeEmbeddingCache(new Uint8Array(buf), ZHIPU)).toThrow(
      /version|provenance/i,
    );
  });

  it('still rejects a foreign magic before it looks at anything else', () => {
    const bytes = serializeEmbeddingCache(cache(), ZHIPU);
    bytes[0] = 0xff;
    expect(() => deserializeEmbeddingCache(bytes, ZHIPU)).toThrow(/magic/);
  });
});

describe('the header is data, not a prefix that happens to parse', () => {
  it('round-trips a provenance carrying a null model and a null endpoint', () => {
    const offline: EmbeddingProvenance = {
      provider: 'hash',
      model: null,
      baseUrl: null,
      dimensions: 4,
    };
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(cache(), offline), offline);
    expect(restored.size).toBe(2);
  });

  it('round-trips an empty cache under the same provenance', () => {
    // The arm's writer treats a zero-length file as "this run embedded nothing" and refuses to
    // overwrite a populated one with it; that path only works if the empty form still carries a
    // readable header.
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(new Map(), ZHIPU), ZHIPU);
    expect(restored.size).toBe(0);
  });

  it('sizes the buffer from the provenance it actually wrote, not from a constant', () => {
    // A baseUrl long enough to push the header past any fixed offset the writer might have
    // assumed. The old layout had a fixed 13-byte header; this one does not.
    const longUrl = `https://example.invalid/${'x'.repeat(500)}`;
    const wide: EmbeddingProvenance = { ...ZHIPU, baseUrl: longUrl };
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(cache(), wide), wide);
    expect([...restored.get('a second turn')!]).toHaveLength(4);
  });
});

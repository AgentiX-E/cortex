/**
 * A benchmark report must say WHICH dataset file it graded.
 *
 * Every artifact this repository has published names its dataset by a string that
 * never changes: `longmemeval`, `longmemeval-s`, `longmemeval-mini`. The workflow
 * downloads that file from `resolve/main`, which is a moving reference -- the
 * contents can change under the name without any commit here, and nothing in the
 * artifact would record it. A score is a property of (pipeline, dataset file), and
 * this repository has only ever written down the first half.
 *
 * The comparison is not hypothetical. Haki validates the dataset's sha256 and
 * refuses to run on a mismatch; this harness downloads `resolve/main` and verifies
 * nothing. The recording half of that gap costs nothing and needs no prior
 * knowledge of the expected digest, which is why it is the half that ships first
 * (`cortex/docs/AUDIT-BENCHMARK-WALLCLOCK.md` §5).
 *
 * The vectors below are the standard ones for the two strings every implementation
 * has an opinion about, so a wrong-length or truncated digest cannot pass by
 * being merely stable.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintBytes } from '../dataset-fingerprint.js';

describe('fingerprintBytes', () => {
  it('matches the published SHA-256 of the empty string', () => {
    // e3b0c442... is in every SHA-256 test vector file and in the standard itself.
    expect(fingerprintBytes(new Uint8Array([]))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the published SHA-256 of "abc"', () => {
    const bytes = new TextEncoder().encode('abc');
    expect(fingerprintBytes(bytes)).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes bytes rather than a decoded string, so a non-UTF8 payload is not lossy', () => {
    // `0xff` does not survive a UTF-8 decode -- it becomes U+FFFD, and two different
    // invalid sequences decode to the same replacement character. A fingerprint that
    // went through `toString()` would call those two files identical.
    const a = fingerprintBytes(new Uint8Array([0xff, 0x00]));
    const b = fingerprintBytes(new Uint8Array([0xfe, 0x00]));
    expect(a).not.toBe(b);
  });

  it('is stable across calls, and separates inputs that differ by one byte', () => {
    const one = new TextEncoder().encode('[{"id":"q1"}]');
    const two = new TextEncoder().encode('[{"id":"q2"}]');
    expect(fingerprintBytes(one)).toBe(fingerprintBytes(one));
    expect(fingerprintBytes(one)).not.toBe(fingerprintBytes(two));
  });

  it('carries the algorithm in the value, so a future digest cannot be mistaken for this one', () => {
    // A bare 64-hex string is indistinguishable from an md5-of-something-else or from
    // a truncated sha512. The prefix is what lets a reader of an artifact check the
    // fingerprint with the tool that will verify it.
    expect(fingerprintBytes(new TextEncoder().encode('x'))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('the digest taken the way the entry point takes it', () => {
  /**
   * The composition under test is the caller's, not the library's: the entry point reads
   * the file ONCE, parses the same buffer, and hashes that buffer. There is no
   * `fingerprintDatasetFile(path)` because a second read of a 110 MB file is a way for
   * the digest and the questions to come from two different reads of one run.
   */
  function withTempDir(body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'dataset-fingerprint-'));
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('hashes the file on disk, byte for byte', () => {
    withTempDir((dir) => {
      const path = join(dir, 'dataset.json');
      const contents = '[{"question_id":"q1","question_type":"single-session-user"}]';
      writeFileSync(path, contents, 'utf8');
      expect(fingerprintBytes(readFileSync(path))).toBe(
        fingerprintBytes(new TextEncoder().encode(contents)),
      );
    });
  });

  it('separates two files whose JSON content is equal but whose bytes are not', () => {
    // This is the case the content hash exists for. Two re-serialisations of the same
    // 500 questions are the same EXPERIMENT and different FILES, and the artifact has
    // to be able to say which one it read.
    withTempDir((dir) => {
      const compact = join(dir, 'a.json');
      const pretty = join(dir, 'b.json');
      writeFileSync(compact, '[{"id":"q1"}]', 'utf8');
      writeFileSync(pretty, '[\n  {"id": "q1"}\n]', 'utf8');
      expect(JSON.parse(readFileSync(compact, 'utf8'))).toEqual(
        JSON.parse(readFileSync(pretty, 'utf8')),
      );
      expect(fingerprintBytes(readFileSync(compact))).not.toBe(
        fingerprintBytes(readFileSync(pretty)),
      );
    });
  });

  it('throws when the file is absent, rather than fingerprinting nothing', () => {
    // A digest of `''` in an artifact would be indistinguishable from one taken over an
    // empty dataset, and the run that produced it never read a file at all.
    expect(() => readFileSync(join(tmpdir(), 'definitely-absent-dataset-xyz.json'))).toThrow();
  });
});

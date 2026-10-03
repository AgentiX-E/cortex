/**
 * Tests for the arm entry point's embedding-cache discipline.
 *
 * ## The defect these tests were written against
 *
 * `cortex-memory/bench/run-ablation.ts` built its embedding with
 * `createEmbeddingWithProvenanceFromEnv` and then never touched
 * `EMBEDDING_CACHE_PATH`. Both halves of the cache contract were missing:
 *
 *   - **Read side.** The workflow runs `Run benchmark` and then `Run
 *     cortex-memory A/B` as two steps of one job, sharing
 *     `EMBEDDING_CACHE_PATH` and running as separate processes. `bench/run.ts`
 *     writes the cache at the end of step 1; step 2 starts with an empty
 *     in-process cache, so every one of the ~115k haystack-turn vectors is
 *     re-embedded against Zhipu.
 *   - **Write side.** Nothing this arm embedded was persisted, so a second
 *     dispatch could not reuse it either.
 *
 * The read side is the one that fails loudly, because Zhipu's free-tier quota is
 * already exhausted (`429`), and `AUDIT-CODE-VS-DOCS.md` §6.2 step 5 depends on
 * this arm producing numbers comparable to `SOTA-BASELINE.md`. But the write side
 * is the same defect with the opposite sign, so both are asserted.
 *
 * ## Why the decision is tested here and not in the CLI
 *
 * `bench-memory-arm.ts` opens with the lesson `bench-arm-options.ts` already paid
 * for: `bench/**` is excluded from coverage as an entry point, so a line that
 * lives there is, from the suite's point of view, unreachable. Defect injection
 * showed the cost directly — deleting the spread that carried one toggle into one
 * arm left every test green, because no test could import the file the line lived
 * in. A cache that is restored in the CLI is a cache no test can prove is
 * restored; the same deletion would be invisible again.
 *
 * ## Why these are behavioural assertions
 *
 * The tempting assertion is textual: grep the CLI for `mergeEmbeddingCache`. That
 * is the assertion §37 already caught passing on `void runBenchmark;` — a bare
 * import with no call site matches an import-name regex and does nothing. So the
 * tests below count provider requests through the real embedding path
 * (`embeddingSourceStats`), which moves only when vectors are actually reused.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearEmbeddingCache,
  deserializeEmbeddingCache,
  embedManyCached,
  embeddingSourceStats,
  mergeEmbeddingCache,
  resetEmbeddingSourceStats,
  serializeEmbeddingCache,
  snapshotEmbeddingCache,
} from '../retrieval.js';
import { HashEmbedding } from '../embedding.js';
import {
  cortexMemoryArmEmbeddingCachePath,
  persistArmEmbeddingCache,
  restoreArmEmbeddingCache,
} from '../bench-memory-arm.js';

const TURNS = ['a haystack turn', 'another haystack turn', 'a third haystack turn'];
const embedding = new HashEmbedding(32);

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arm-cache-'));
  cachePath = join(dir, 'embedding-cache.bin');
  clearEmbeddingCache();
  resetEmbeddingSourceStats();
});

afterEach(() => {
  clearEmbeddingCache();
  resetEmbeddingSourceStats();
  rmSync(dir, { recursive: true, force: true });
});

/** Embed `TURNS` and report how many texts had to reach the provider. */
async function embedTurns(): Promise<number> {
  resetEmbeddingSourceStats();
  await embedManyCached(embedding, TURNS);
  return embeddingSourceStats().liveTexts;
}

describe('cortexMemoryArmEmbeddingCachePath', () => {
  it('returns the configured path when one is set', () => {
    expect(cortexMemoryArmEmbeddingCachePath({ EMBEDDING_CACHE_PATH: '/tmp/x.bin' })).toBe(
      '/tmp/x.bin',
    );
  });

  it('returns undefined when the variable is absent', () => {
    expect(cortexMemoryArmEmbeddingCachePath({})).toBeUndefined();
  });

  it('treats an empty or blank value as absent', () => {
    // A workflow_dispatch input the operator did not fill arrives as `''`, not
    // undefined, and `''` as a path would be resolved relative to the working
    // directory and written on every run. The same absent/blank distinction
    // `firstNonEmpty` makes in `embedding-factory.ts`.
    expect(cortexMemoryArmEmbeddingCachePath({ EMBEDDING_CACHE_PATH: '' })).toBeUndefined();
    expect(cortexMemoryArmEmbeddingCachePath({ EMBEDDING_CACHE_PATH: '   ' })).toBeUndefined();
  });
});

describe('restoreArmEmbeddingCache', () => {
  it('absorbs the provider calls a previous process already paid for', async () => {
    // The measurement that the defect consisted of failing. Pass 1 is step 1 of
    // the job; pass 2 is this arm's process starting fresh.
    const firstPassLive = await embedTurns();
    expect(firstPassLive).toBe(TURNS.length);
    persistArmEmbeddingCache(cachePath);

    // A fresh process: the in-memory cache is gone, only the file remains.
    clearEmbeddingCache();
    const restored = restoreArmEmbeddingCache(cachePath);
    expect(restored).toBe(TURNS.length);

    // The control that keeps the assertion above from passing vacuously: without
    // the pre-pass, this count is `TURNS.length` (asserted as `firstPassLive`
    // above), so `0` here can only mean the vectors were reused.
    expect(await embedTurns()).toBe(0);
  });

  it('reports 0 and leaves the cache untouched when the file is absent', () => {
    const restored = restoreArmEmbeddingCache(join(dir, 'does-not-exist.bin'));
    expect(restored).toBe(0);
    expect(snapshotEmbeddingCache().size).toBe(0);
  });

  it('reports 0 rather than throwing on a corrupt file', () => {
    // A truncated or foreign file must not take the run down: the arm's entire
    // purpose is to produce a report, and re-embedding is the recovery, not a
    // failure. `deserializeEmbeddingCache` throws by design (a stale cache must
    // never be trusted silently); the decision to swallow that here, and to say
    // so with a `0`, is what this function exists to own.
    writeFileSync(cachePath, Buffer.from('not an embedding cache'));
    expect(restoreArmEmbeddingCache(cachePath)).toBe(0);
    expect(snapshotEmbeddingCache().size).toBe(0);
  });

  it('reports 0 when no path was configured', () => {
    expect(restoreArmEmbeddingCache(undefined)).toBe(0);
  });

  it('merges rather than replaces, so vectors computed in this process survive', async () => {
    // `mergeEmbeddingCache` keeps the in-memory copy as authoritative. Restoring
    // a stale file must not overwrite a vector this run already computed, or the
    // arm would grade against a different embedding than the reference pipeline
    // did within the same process.
    clearEmbeddingCache();
    await embedManyCached(embedding, ['in-process turn']);
    const inProcess = snapshotEmbeddingCache().get('in-process turn');
    expect(inProcess).toBeDefined();

    // A file holding only an unrelated entry.
    clearEmbeddingCache();
    await embedManyCached(embedding, ['from-the-file turn']);
    persistArmEmbeddingCache(cachePath);

    clearEmbeddingCache();
    await embedManyCached(embedding, ['in-process turn']);
    const restored = restoreArmEmbeddingCache(cachePath);

    expect(restored).toBe(1);
    expect(snapshotEmbeddingCache().has('in-process turn')).toBe(true);
    expect(snapshotEmbeddingCache().has('from-the-file turn')).toBe(true);
  });
});

describe('persistArmEmbeddingCache', () => {
  it('writes a file the next process can restore', () => {
    clearEmbeddingCache();
    return embedManyCached(embedding, TURNS).then(() => {
      persistArmEmbeddingCache(cachePath);
      expect(existsSync(cachePath)).toBe(true);
      const restored = deserializeEmbeddingCache(readFileSync(cachePath));
      expect(restored.size).toBe(TURNS.length);
      for (const turn of TURNS) {
        expect(restored.has(turn)).toBe(true);
      }
    });
  });

  it('is a no-op when no path was configured', () => {
    persistArmEmbeddingCache(undefined);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('is a no-op when the path is blank', () => {
    persistArmEmbeddingCache('');
    expect(existsSync(cachePath)).toBe(false);
  });

  it('round-trips through a real process boundary, not just within one', async () => {
    // The strongest form: the bytes on disk are the only channel. Snapshot,
    // wipe both the cache and the counters, re-embed, and require zero provider
    // calls. If `snapshotEmbeddingCache` were returning a live reference rather
    // than a copy, or `serialize` dropped vectors, this is where it shows.
    clearEmbeddingCache();
    await embedManyCached(embedding, TURNS);
    persistArmEmbeddingCache(cachePath);

    clearEmbeddingCache();
    resetEmbeddingSourceStats();
    const bytes = readFileSync(cachePath);
    mergeEmbeddingCache(deserializeEmbeddingCache(bytes));
    await embedManyCached(embedding, TURNS);

    expect(embeddingSourceStats().liveTexts).toBe(0);
    expect(embeddingSourceStats().cachedTexts).toBe(TURNS.length);
  });

  it('persists an empty cache as a valid file rather than skipping the write', () => {
    // A run that embedded nothing still produces the artifact. Skipping the
    // write would leave a PREVIOUS run's cache in place, which is worse than an
    // empty file: the next run would restore vectors that do not correspond to
    // the dataset it was handed.
    clearEmbeddingCache();
    persistArmEmbeddingCache(cachePath);
    expect(existsSync(cachePath)).toBe(true);
    expect(deserializeEmbeddingCache(readFileSync(cachePath)).size).toBe(0);
  });

  it('overwrites a previous cache rather than appending to it', async () => {
    clearEmbeddingCache();
    await embedManyCached(embedding, ['stale turn']);
    persistArmEmbeddingCache(cachePath);

    clearEmbeddingCache();
    await embedManyCached(embedding, ['fresh turn']);
    persistArmEmbeddingCache(cachePath);

    const restored = deserializeEmbeddingCache(readFileSync(cachePath));
    expect(restored.size).toBe(1);
    expect(restored.has('fresh turn')).toBe(true);
    expect(restored.has('stale turn')).toBe(false);
  });

  it('serializes the cache through the same format bench/run.ts writes', async () => {
    // The two steps of the job share one file, so the formats must be the same
    // format -- not merely two self-consistent ones. This asserts the bytes this
    // module writes are readable by `serializeEmbeddingCache`'s counterpart.
    clearEmbeddingCache();
    await embedManyCached(embedding, TURNS);
    const viaHelpers = serializeEmbeddingCache(snapshotEmbeddingCache());
    persistArmEmbeddingCache(cachePath);
    const onDisk = new Uint8Array(readFileSync(cachePath));
    expect(Buffer.from(onDisk).equals(Buffer.from(viaHelpers))).toBe(true);
  });
});

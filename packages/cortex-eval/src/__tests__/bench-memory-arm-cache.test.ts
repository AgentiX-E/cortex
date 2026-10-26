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
import type { EmbeddingProvenance } from '../embedding-factory.js';
import {
  cortexMemoryArmEmbeddingCachePath,
  describeEmbeddingCachePersist,
  persistEmbeddingCache,
  restoreArmEmbeddingCache,
} from '../bench-memory-arm.js';

const TURNS = ['a haystack turn', 'another haystack turn', 'a third haystack turn'];
const embedding = new HashEmbedding(32);

/**
 * The provenance every call in this file passes, standing in for the one
 * `createEmbeddingWithProvenanceFromEnv` resolves at the two entry points.
 *
 * It matches `HashEmbedding(32)` because that is what the fixture embeds with: the cache now
 * records the backend that produced its vectors and refuses a file that names another one, so a
 * fixture whose provenance disagreed with its own embedding model would be testing the refusal
 * path in every test rather than the restore path.
 */
const PROVENANCE: EmbeddingProvenance = {
  provider: 'hash',
  model: null,
  baseUrl: null,
  dimensions: 32,
};

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
    persistEmbeddingCache(cachePath, PROVENANCE);

    // A fresh process: the in-memory cache is gone, only the file remains.
    clearEmbeddingCache();
    const restored = restoreArmEmbeddingCache(cachePath, PROVENANCE);
    expect(restored).toBe(TURNS.length);

    // The control that keeps the assertion above from passing vacuously: without
    // the pre-pass, this count is `TURNS.length` (asserted as `firstPassLive`
    // above), so `0` here can only mean the vectors were reused.
    expect(await embedTurns()).toBe(0);
  });

  it('reports 0 and leaves the cache untouched when the file is absent', () => {
    const restored = restoreArmEmbeddingCache(join(dir, 'does-not-exist.bin'), PROVENANCE);
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
    expect(restoreArmEmbeddingCache(cachePath, PROVENANCE)).toBe(0);
    expect(snapshotEmbeddingCache().size).toBe(0);
  });

  it('reports 0 and absorbs nothing when the file was written by another backend', async () => {
    // The case the previous reader could not see. `benchmark.yml` keys its Actions cache on the
    // CORPUS hash, not on the model, so a run inherits the previous run's vectors whenever the
    // corpus has not changed -- and query vectors are always embedded fresh. A file written under
    // a different model id, endpoint, provider or width is therefore not "stale", it is
    // *foreign*, and merging it would score fresh queries against another space.
    await embedTurns();
    persistEmbeddingCache(cachePath, PROVENANCE);

    clearEmbeddingCache();
    resetEmbeddingSourceStats();
    const restored = restoreArmEmbeddingCache(cachePath, { ...PROVENANCE, model: 'some-other' });
    expect(restored).toBe(0);
    expect(snapshotEmbeddingCache().size).toBe(0);
    // And the recovery is the real one: every turn has to reach the provider again.
    expect(await embedTurns()).toBe(TURNS.length);
  });

  it('reports 0 when only the endpoint differs, at the same width and provider', async () => {
    // Width is the field a careless comparison would check, and it agrees here.
    await embedTurns();
    persistEmbeddingCache(cachePath, PROVENANCE);
    clearEmbeddingCache();
    const restored = restoreArmEmbeddingCache(cachePath, {
      ...PROVENANCE,
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(restored).toBe(0);
  });

  it('reports 0 when no path was configured', () => {
    expect(restoreArmEmbeddingCache(undefined, PROVENANCE)).toBe(0);
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
    persistEmbeddingCache(cachePath, PROVENANCE);

    clearEmbeddingCache();
    await embedManyCached(embedding, ['in-process turn']);
    const restored = restoreArmEmbeddingCache(cachePath, PROVENANCE);

    expect(restored).toBe(1);
    expect(snapshotEmbeddingCache().has('in-process turn')).toBe(true);
    expect(snapshotEmbeddingCache().has('from-the-file turn')).toBe(true);
  });
});

describe('persistArmEmbeddingCache', () => {
  it('writes a file the next process can restore', () => {
    clearEmbeddingCache();
    return embedManyCached(embedding, TURNS).then(() => {
      persistEmbeddingCache(cachePath, PROVENANCE);
      expect(existsSync(cachePath)).toBe(true);
      const restored = deserializeEmbeddingCache(readFileSync(cachePath), PROVENANCE);
      expect(restored.size).toBe(TURNS.length);
      for (const turn of TURNS) {
        expect(restored.has(turn)).toBe(true);
      }
    });
  });

  it('is a no-op when no path was configured', () => {
    expect(persistEmbeddingCache(undefined, PROVENANCE)).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('is a no-op when the path is blank', () => {
    expect(persistEmbeddingCache('', PROVENANCE)).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('reports how many vectors it wrote, so a skipped write is visible', async () => {
    // The count is the reason this function returns a number at all, and it is
    // the same argument `restoreArmEmbeddingCache` makes for its own return
    // value: a publish that did nothing and a publish that wrote the world look
    // identical in every downstream number, so the one place they differ has to
    // say which happened.
    clearEmbeddingCache();
    await embedManyCached(embedding, TURNS);
    expect(persistEmbeddingCache(cachePath, PROVENANCE)).toBe(TURNS.length);
  });

  it('round-trips through a real process boundary, not just within one', async () => {
    // The strongest form: the bytes on disk are the only channel. Snapshot,
    // wipe both the cache and the counters, re-embed, and require zero provider
    // calls. If `snapshotEmbeddingCache` were returning a live reference rather
    // than a copy, or `serialize` dropped vectors, this is where it shows.
    clearEmbeddingCache();
    await embedManyCached(embedding, TURNS);
    persistEmbeddingCache(cachePath, PROVENANCE);

    clearEmbeddingCache();
    resetEmbeddingSourceStats();
    const bytes = readFileSync(cachePath);
    mergeEmbeddingCache(deserializeEmbeddingCache(bytes, PROVENANCE));
    await embedManyCached(embedding, TURNS);

    expect(embeddingSourceStats().liveTexts).toBe(0);
    expect(embeddingSourceStats().cachedTexts).toBe(TURNS.length);
  });

  it('leaves a populated file alone when this process holds no vectors', async () => {
    // This test asserts the REVERSE of what it asserted before, and the reversal
    // was forced by measurement rather than by taste.
    //
    // The rule used to be "an empty cache is a true statement, so write it"; the
    // argument was that leaving the previous run's file in place would let the
    // next run grade against evidence it never embedded. What that argument
    // missed is that the file is not the only copy. The workflow publishes this
    // file to the Actions cache under a key that is fresher than every key before
    // it, so "a true statement" was in fact "the newest entry in the store", and
    // the next run's prefix restore prefers the newest.
    //
    // Measured cost, from the repository's own cache list:
    //
    //   cache 9050669935   216 bytes   run 38908223281
    //   cache 8943694690   212 bytes   run 38582212737
    //
    // 216 bytes is a tar.zst of the 13-byte header `serializeEmbeddingCache`
    // emits for an empty map, and both runs are ones that died BEFORE restoring:
    // `38908223281` threw in `cortextMemoryArmOptions` (run-ablation.ts:189) and
    // `38582212737` hung before its first embed. Each then ran the failure path,
    // which persists deliberately, and each wrote an empty file OVER the 691 MB
    // one the workflow had just restored into the same directory -- destroying
    // the copy in the workspace as well as publishing the empty one.
    //
    // Both of those were harmless while nothing read a run-keyed key. They stop
    // being harmless the moment the key coupling is repaired, which is this
    // iteration: the repair makes the newest entry the one every run reads, and
    // an empty newest entry would send the next run back to embedding ~270k
    // texts from an exhausted account. So the two are one change.
    clearEmbeddingCache();
    await embedManyCached(embedding, ['the previous run paid for this turn']);
    persistEmbeddingCache(cachePath, PROVENANCE);
    const before = readFileSync(cachePath);

    // A fresh process that dies before it restores: empty in memory, populated
    // on disk. Nothing has been learned and nothing may be destroyed.
    clearEmbeddingCache();
    expect(persistEmbeddingCache(cachePath, PROVENANCE)).toBe(0);

    expect(readFileSync(cachePath).equals(before)).toBe(true);
    expect(deserializeEmbeddingCache(readFileSync(cachePath), PROVENANCE).size).toBe(1);
  });

  it('does not create an empty file where none existed', () => {
    // The other half of the same rule. A file that does not exist cannot be
    // published as "the newest cache"; creating one is how a poison entry gets
    // into the store in the first place.
    clearEmbeddingCache();
    expect(persistEmbeddingCache(cachePath, PROVENANCE)).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('overwrites a previous cache rather than appending to it', async () => {
    clearEmbeddingCache();
    await embedManyCached(embedding, ['stale turn']);
    persistEmbeddingCache(cachePath, PROVENANCE);

    clearEmbeddingCache();
    await embedManyCached(embedding, ['fresh turn']);
    persistEmbeddingCache(cachePath, PROVENANCE);

    const restored = deserializeEmbeddingCache(readFileSync(cachePath), PROVENANCE);
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
    const viaHelpers = serializeEmbeddingCache(snapshotEmbeddingCache(), PROVENANCE);
    persistEmbeddingCache(cachePath, PROVENANCE);
    const onDisk = new Uint8Array(readFileSync(cachePath));
    expect(Buffer.from(onDisk).equals(Buffer.from(viaHelpers))).toBe(true);
  });
});

describe('describeEmbeddingCachePersist', () => {
  it('names the count when vectors were written', () => {
    // The count is what a reader compares against the `Restored N embedding
    // vectors` line to see whether the run added anything. Without it, a run
    // that re-embedded its whole haystack and a run that re-embedded nothing
    // print the same log.
    expect(describeEmbeddingCachePersist(3, '/tmp/cache.bin')).toBe(
      'Embedding cache: persisted 3 vectors to /tmp/cache.bin',
    );
  });

  it('says so when it published nothing', () => {
    // The line that did not exist when the defect was live. Run `38908223281`
    // published a 216-byte cache over a 691 MB one and its log said nothing
    // about the write at all.
    expect(describeEmbeddingCachePersist(0, '/tmp/cache.bin')).toBe(
      'Embedding cache: nothing to persist, /tmp/cache.bin left as restored',
    );
  });

  it('distinguishes an unconfigured path from an empty process', () => {
    expect(describeEmbeddingCachePersist(0, undefined)).toBe(
      'Embedding cache: not configured, nothing persisted',
    );
    expect(describeEmbeddingCachePersist(0, '  ')).toBe(
      'Embedding cache: not configured, nothing persisted',
    );
  });
});

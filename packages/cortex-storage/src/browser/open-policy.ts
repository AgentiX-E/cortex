/**
 * Which tier opens, in what order, and whether this context is allowed to open one at all.
 *
 * ## Why this is a module of its own
 *
 * `opfs.ts` is excluded from the Node coverage number, and the exclusion is correct: `Worker`, OPFS and
 * IndexedDB do not exist in Node and a shim would assert the shim. But the decision this module makes --
 * claim the origin, refuse or proceed, try tiers in order, release on failure -- is **control flow over
 * injected effects**, and it was living inside the excluded file. So the one part of the opener that could
 * be measured was the one part the measurement could not see, and tests written for it would have shipped
 * into an exclusion.
 *
 * The split is therefore by testability rather than by taste: everything that needs a platform is one
 * module down, everything that decides is here.
 *
 * ## The shape of the answer
 *
 * An outcome rather than an exception, because the three outcomes are not the same kind of thing. A busy
 * origin is a fact about the world that the caller has a policy for; an unavailable platform is a failure.
 * The module that owns the error classes -- `opfs.ts` -- is the one that gets to throw them, which is also
 * what keeps this module from importing its own public types back through a cycle.
 */
import type { Storage } from '@agentix-e/cortex-core';
import {
  claimWithGrace,
  releaseOnClose,
  type WriterLockManager,
  type WriterMechanism,
} from './writer-claim.js';

export type BrowserTier = 'opfs' | 'idb';

export type Refusal = { tier: BrowserTier; reason: string };

/**
 * The pool name the worker defaults to, and the name the origin-wide claim is taken under.
 *
 * ## Why it is stated here and again in `opfs-worker.ts` rather than imported
 *
 * The worker is a separate entry point with its own budget. Importing this module into it would pull the
 * storage stack -- `SqlStorage`, the IndexedDB tier, the error classes -- into a worker whose only job is to
 * create a VFS. So the literal exists twice, and `__tests__/pool-name.test.ts` reads both source files and
 * fails if the two disagree: two defaults that must be equal and nothing checking is how the claim would
 * end up guarding a different pool from the one the database is opened in.
 */
export const DEFAULT_POOL_NAME = 'cortex';

/**
 * What this context may do with the origin, and which facility said so.
 *
 * `acquired: false` only happens under `onSecondTab: 'allow'`, and it is a fact a caller should show: a
 * shared origin is a second database with its own writes, not a second view of the first one.
 */
export type WriterState = {
  readonly pool: string;
  readonly acquired: boolean;
  readonly mechanism: WriterMechanism;
};

/** The OPFS tier's inputs, restated here so this module does not import the platform module. */
export type OpfsTierOptions = {
  readonly sqliteModuleUrl: string;
  readonly workerUrl?: string | URL | undefined;
  readonly databasePath?: string | undefined;
  readonly poolName?: string | undefined;
  readonly startupTimeoutMs?: number | undefined;
};

/** The tier openers, injected so this module can run where the tiers do not exist. */
export type TierOpeners = {
  readonly opfs: (options: OpfsTierOptions) => Promise<{ storage: Storage; engine: string }>;
  readonly idb: (databaseName: string | undefined) => Promise<Storage>;
};

export type OpenOutcome =
  | {
      readonly kind: 'opened';
      readonly storage: Storage;
      readonly tier: BrowserTier;
      readonly engine: string;
      readonly refused: readonly Refusal[];
      readonly writer: WriterState;
    }
  | { readonly kind: 'busy'; readonly pool: string; readonly mechanism: WriterMechanism }
  | { readonly kind: 'unavailable'; readonly refused: readonly Refusal[] };

/**
 * Claim the origin, then open the first tier that answers.
 *
 * ## The claim comes first, and that ordering is the whole point
 *
 * A second tab's SAH-pool install fails with a message that belongs to sqlite-wasm, and that message used to
 * end up in `refused[0].reason` next to a fallback that had **already created a second database**. Asking the
 * platform before any tier is tried means the product never classifies an error, never spends the pool's
 * retry budget in a tab that cannot win it, and answers the only question that matters with two named
 * outcomes instead of a string.
 */
export async function openClaimedStorage(args: {
  readonly tiers: readonly BrowserTier[];
  readonly pool: string;
  readonly onSecondTab: 'refuse' | 'allow';
  readonly locks?: WriterLockManager | undefined;
  readonly idbDatabaseName?: string | undefined;
  /** Everything the OPFS tier needs except the tier itself. Its `poolName` comes from `pool`. */
  readonly opfs: Omit<OpfsTierOptions, 'poolName'>;
  readonly openers: TierOpeners;
}): Promise<OpenOutcome> {
  const refused: Refusal[] = [];
  // `claimWithGrace`, not `claimWriter`: a release performed by this page is observed by the platform one
  // beat later, so a re-open in the same task would otherwise be refused by its own predecessor. See that
  // function for the failure this fixes and for why the retry is bounded.
  const claim = await claimWithGrace({ pool: args.pool, locks: args.locks });
  if (!claim.acquired && args.onSecondTab === 'refuse') {
    // Nothing was opened, so there is nothing to release: a refused claim's `release` is a no-op by
    // construction, which is why no branch here calls it.
    return { kind: 'busy', pool: args.pool, mechanism: claim.mechanism };
  }
  const writer: WriterState = {
    pool: args.pool,
    acquired: claim.acquired,
    mechanism: claim.mechanism,
  };

  for (const tier of args.tiers) {
    try {
      const opened =
        tier === 'opfs'
          ? await args.openers.opfs({ ...args.opfs, poolName: args.pool })
          : { storage: await args.openers.idb(args.idbDatabaseName), engine: 'indexeddb' };
      return {
        kind: 'opened',
        storage: releaseOnClose(opened.storage, claim.release),
        tier,
        engine: opened.engine,
        refused,
        writer,
      };
    } catch (error) {
      refused.push({ tier, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // Every tier failed, so this caller is not a writer and must not keep the origin. Releasing before the
  // outcome is returned is what lets a retry -- the same tab, a moment later, after whatever was blocking it
  // is gone -- be a first attempt rather than a refusal by a tab that already gave up.
  claim.release();
  return { kind: 'unavailable', refused };
}

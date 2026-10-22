/**
 * The write side of the boundary: a fact arrives, a scope is decided, a row is stored.
 *
 * ## What this class is for
 *
 * `ReadSideAssembler` can only be as good as what the writer put in the stores. Before this file,
 * "which store does a fact go to" was a convention held by `[POC-5]`'s prototype and by whoever
 * wrote the next caller. It is now one function, and the boundary is a property of the pair
 * (`TriageWriter`, `ReadSideAssembler`) rather than of the discipline of each call site.
 *
 * ## Three decisions worth stating before the code
 *
 * 1. **`visibility` never holds `defer`.** The stored row carries `visibility: 'private'` and a
 *    separate `triage` record that says `defer`. Writing `'defer'` into the field the boundary is
 *    enforced on would mean every filter written as `visibility === 'private'` silently misses
 *    deferred rows -- and the read-side guard would report the wrong defect. `visibility` answers
 *    *where the row may live*; `triage` answers *what the rules said*, and it is immutable.
 * 2. **A triage failure is a private row, not an exception and not a shared row.** If the
 *    classifier throws, or returns a scope nobody recognises, the fact is stored privately with the
 *    failure recorded. Losing one fact to a bug is recoverable; publishing one is not.
 * 3. **Promotion writes first, then deletes.** The only way a row crosses the boundary is
 *    `promote()`, called after a user confirms a card. Both stores cannot be written atomically
 *    here (`FederatedStorage.transactionIn` refuses cross-scope work on purpose), so the ordering
 *    is chosen for its failure mode: if the delete fails, the row exists in both stores and the
 *    read side prefers the private copy -- the confirmation appears not to have taken, which is
 *    visible and retryable. The other order leaves a failed promotion with the row in neither
 *    store, which is silent data loss.
 */

import type { FederatedStorage } from '../federation/federated-storage.js';
import {
  classify as classifyWith,
  destinationOf,
  type TriageDecision,
  type TriageScope,
} from './rules.js';

/** Raised when the writer is asked for something it will not do. */
export class TriageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriageError';
  }
}

/**
 * The immutable account of what the rule layer said, carried on every stored row.
 *
 * `failure` is present only when the classifier itself failed. It is a string rather than an
 * `Error` because this record is serialised into `Storage`, and an `Error` does not survive
 * `JSON.stringify` -- which would turn a recorded failure into an empty object at exactly the moment
 * someone needed to read it.
 */
export type TriageRecord = {
  readonly scope: TriageScope;
  readonly rule: string | null;
  readonly policy: string | null;
  readonly failure?: string;
};

/** A fact as stored: where it may live, what the rules said, and who overrode them. */
export type AdmittedFact = {
  readonly id: string;
  readonly text: string;
  /** The boundary field. Always `private` or `shared`, never `defer`. */
  readonly visibility: 'private' | 'shared';
  readonly triage: TriageRecord;
  readonly admittedAt: number;
  /** Set when a user promoted this row across the boundary, by confirming a card. */
  readonly confirmedAt?: number;
};

export type TriageWriterOptions = {
  /**
   * Replaces the shipped table. Exists so a test can prove the failure paths -- unknown verdict,
   * throwing classifier -- without editing the product's rules to be wrong.
   */
  classify?: (text: string) => TriageDecision;
};

/** The scopes this writer will accept from a classifier. Anything else is a failure, not a vote. */
const KNOWN_SCOPES: readonly TriageScope[] = ['private', 'shared', 'defer'];

export class TriageWriter {
  private readonly federation: FederatedStorage;
  private readonly classifier: (text: string) => TriageDecision;

  constructor(federation: FederatedStorage, options: TriageWriterOptions = {}) {
    this.federation = federation;
    this.classifier = options.classify ?? ((text) => classifyWith(text));
  }

  /**
   * Classify and store one sentence.
   *
   * @param text What the user said. Rejected when blank: a blank fact is a caller defect, and
   *   storing it would put an unreadable row in the private store for every retry of that defect.
   * @throws {TypeError} when `text` is not a non-blank string.
   */
  async admit(
    text: string,
    options: { id?: string; table?: string; now?: number } = {},
  ): Promise<AdmittedFact> {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError(
        `admit() needs a non-blank sentence, got ${typeof text === 'string' ? JSON.stringify(text) : typeof text}`,
      );
    }

    const triage = this.decide(text);
    // `decide()` guarantees the scope is one of the three, and `destinationOf` sends `defer` home
    // privately -- so this single expression covers the failure path too. It was a ternary on
    // `triage.failure` first, which was dead: a failure is recorded *as* a deferral.
    const visibility = destinationOf(triage);
    const fact: AdmittedFact = {
      id: options.id ?? crypto.randomUUID(),
      text,
      visibility,
      triage,
      admittedAt: options.now ?? Date.now(),
    };

    await this.federation.put(`${visibility}/${options.table ?? 'facts'}`, fact.id, fact);
    return fact;
  }

  /**
   * Move a row across the boundary, after a user confirmed a card.
   *
   * Idempotent on purpose: a promotion whose delete failed leaves the row in both stores, and
   * retrying it must converge rather than throw. The `triage` record is **not** rewritten -- the
   * rule layer's verdict is history, and a promoted row that claimed a rule fired for it would be
   * a false audit trail. `confirmedAt` is the field that records the override.
   */
  async promote(id: string, options: { table?: string; now?: number } = {}): Promise<AdmittedFact> {
    const table = options.table ?? 'facts';
    const existing = await this.federation.get<AdmittedFact>(`private/${table}`, id);

    if (existing === undefined) {
      const already = await this.federation.get<AdmittedFact>(`shared/${table}`, id);
      if (already !== undefined) return already;
      throw new TriageError(
        `no fact with id ${JSON.stringify(id)} in either store: promotion can only move a row ` +
          `that was admitted first`,
      );
    }

    const promoted: AdmittedFact = {
      ...existing,
      visibility: 'shared',
      confirmedAt: options.now ?? Date.now(),
    };

    // Shared copy first. See the module comment: this ordering makes a partial failure visible
    // rather than destructive.
    await this.federation.put(`shared/${table}`, id, promoted);
    try {
      await this.federation.del(`private/${table}`, id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TriageError(
        `the shared copy of ${JSON.stringify(id)} was written but the private copy could not be ` +
          `removed (${detail}). The row now exists in both stores, and a private task will read ` +
          `the private copy, so the promotion looks like it did not happen. Retry promote() once ` +
          `the store is writable; it converges.`,
      );
    }

    return promoted;
  }

  /**
   * Run the classifier, converting any failure into a recorded deferral.
   *
   * Both arms are reachable from real causes: a throwing classifier is a bug in a pattern's
   * language features, and an unknown scope is what an injected or mis-merged table produces. The
   * alternative -- letting either escape -- would leave the caller to decide what to do with a
   * fact it cannot classify, and the safe answer would have to be written at every call site.
   */
  private decide(text: string): TriageRecord {
    let decision: TriageDecision;
    try {
      decision = this.classifier(text);
    } catch (error) {
      return { scope: 'defer', rule: null, policy: null, failure: describe(error) };
    }

    if (!KNOWN_SCOPES.includes(decision.scope)) {
      return {
        scope: 'defer',
        rule: null,
        policy: null,
        failure: `classifier returned unknown scope ${JSON.stringify(decision.scope)}`,
      };
    }
    return decision;
  }
}

/** One sentence, because an `Error` does not survive serialisation and a stack does not fit. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

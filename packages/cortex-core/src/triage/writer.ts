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
  digestOf,
  isIncomplete,
  releaseVerdict,
  releaseWarning,
  RELEASE_TOKEN,
  type ReleaseRecord,
} from './release.js';
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
  /**
   * Set when the row crossed the boundary by `release()` instead -- a rule was overridden, and there
   * was no card to confirm.
   *
   * Kept apart from `confirmedAt` because the two are different acts with different audit records:
   * a confirmation answers a question the rule layer asked, an override answers a question the rule
   * layer refused to ask. A reader that could not tell them apart would see every released row as
   * "the user confirmed this card" and look for a card that never existed.
   */
  readonly releasedAt?: number;
  /**
   * Withdrawn from retrieval, pending review.
   *
   * Written by `CardQueue.expire` when a confirmed fact outlives its `decayAt`, and cleared by
   * `refresh`. Absent means live: a row from before this field existed is not stale.
   */
  readonly stale?: boolean;
  /** When the row was marked stale. Kept next to the flag so the two cannot disagree. */
  readonly staleAt?: number;
};

/**
 * What `admit` did, as distinct from what it concluded.
 *
 * A fact is the rule layer's verdict; an admission says whether anything was kept. They come apart
 * in exactly one case, and it is the one that matters: a sentence the policy forbids retaining is
 * classified, reported, and **not written**. Returning only the fact would have made "we dropped
 * your password" indistinguishable from "we stored it".
 */
export type Admission =
  | (AdmittedFact & { readonly stored: true })
  | (AdmittedFact & {
      readonly stored: false;
      /** Present exactly when nothing was written, naming the rule that refused. */
      readonly withheld: { readonly rule: string; readonly policy: string };
    });

export type TriageWriterOptions = {
  /**
   * Replaces the shipped table. Exists so a test can prove the failure paths -- unknown verdict,
   * throwing classifier -- without editing the product's rules to be wrong.
   */
  classify?: (text: string) => TriageDecision;
};

/**
 * Where release records live, inside the private store.
 *
 * A table beside `facts`, not a column on it: the record outlives the row's scope, and a query for
 * facts must not start returning audit rows to a caller that expects sentences.
 */
const RELEASES = 'releases';

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
  ): Promise<Admission> {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError(
        `admit() needs a non-blank sentence, got ${typeof text === 'string' ? JSON.stringify(text) : typeof text}`,
      );
    }

    const { record: triage, retention } = this.decide(text);
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

    // The policy sentence on `credential` reads "never stored, not even as a card", and until this
    // branch existed the code stored it privately -- a password kept "so the assistant can help",
    // in a file the export would take with it. The table said one thing and the write path did the
    // other; the write path was the weaker of the two and the one being enforced.
    if (retention === 'never') {
      return { ...fact, stored: false, withheld: withheldFor(triage) };
    }

    await this.federation.put(`${visibility}/${options.table ?? 'facts'}`, fact.id, fact);
    return { ...fact, stored: true };
  }

  /**
   * Reclassify a fact's text, storing it **only if it may be published**.
   *
   * This exists for the card queue's edit path, and its asymmetry with `admit` is deliberate. An
   * edit arrives from someone who has already said "I want this shared", so a verdict of `private`
   * is not a fact to keep -- it is a refusal to publish, and the refusal has to leave no trace of
   * the new text. Writing it first and deciding afterwards would put a pasted account number in the
   * private store, where the export goes.
   *
   * The caller therefore reads `stored === false` and shows the rule that refused. Nothing else
   * happens: the existing row keeps its old text.
   */
  async revise(
    id: string,
    text: string,
    options: { table?: string; now?: number } = {},
  ): Promise<Admission> {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('revise() needs a non-blank sentence');
    }
    const table = options.table ?? 'facts';
    const existing = await this.federation.get<AdmittedFact>(`private/${table}`, id);
    if (existing === undefined) {
      throw new TriageError(
        `no private fact with id ${JSON.stringify(id)}: revise() only edits a row that has not ` +
          `been published yet, because rewriting a shared fact is a different operation with its ` +
          `own audit trail`,
      );
    }

    const { record, retention } = this.decide(text);
    if (retention === 'never' || record.scope === 'private') {
      return { ...existing, text, triage: record, stored: false, withheld: withheldFor(record) };
    }

    const revised: AdmittedFact = { ...existing, text, triage: record, visibility: 'private' };
    await this.federation.put(`private/${table}`, id, revised);
    return { ...revised, stored: true };
  }

  /**
   * Mark a stored fact as withdrawn from retrieval, or bring it back.
   *
   * Used by the card queue: a confirmed fact that outlives `decayAt` becomes a question again
   * rather than quietly staying in answers forever. The row is looked for in the shared store
   * first, because a card can only exist for a fact that was published.
   */
  async setStale(
    id: string,
    stale: boolean,
    options: { table?: string; now?: number } = {},
  ): Promise<AdmittedFact> {
    const table = options.table ?? 'facts';
    const found =
      (await this.federation.get<AdmittedFact>(`shared/${table}`, id)) ??
      (await this.federation.get<AdmittedFact>(`private/${table}`, id));

    if (found === undefined) {
      throw new TriageError(
        `no fact with id ${JSON.stringify(id)} in either store: only a stored fact can be ` +
          `withdrawn from retrieval`,
      );
    }

    const updated: AdmittedFact = {
      ...found,
      stale,
      staleAt: options.now ?? Date.now(),
    };
    await this.federation.put(`${found.visibility}/${table}`, id, updated);
    return updated;
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
    return this.cross(id, options.table ?? 'facts', { confirmedAt: options.now ?? Date.now() });
  }

  /**
   * Override a rule and move the row across the boundary, leaving a record of why it was allowed.
   *
   * This is the only door out for a row the rule table judged private, and it is deliberately
   * awkward: the caller has to type `RELEASE_TOKEN`, the record is written **before** the row moves,
   * and it lives in its own table so nobody reading the card table can mistake an override for an
   * acceptance. See `release.ts` for why each of those is a decision.
   *
   * Idempotent like `promote`: a second call for a completed release returns the same record rather
   * than reporting a second override, because a retry after a network error is not a second decision.
   *
   * @throws {TriageError} when the row does not exist, cannot be released, or the token is wrong.
   */
  async release(
    id: string,
    options: { acknowledge: string; table?: string; now?: number },
  ): Promise<{ record: ReleaseRecord; fact: AdmittedFact }> {
    const table = options.table ?? 'facts';
    const existing = await this.federation.get<AdmittedFact>(`private/${table}`, id);

    if (existing === undefined) {
      const previous = await this.federation.get<ReleaseRecord>(`private/${RELEASES}`, id);
      if (previous !== undefined && !isIncomplete(previous)) {
        const shared = await this.federation.get<AdmittedFact>(`shared/${table}`, id);
        if (shared !== undefined) return { record: previous, fact: shared };
      }
      throw new TriageError(
        `no private fact with id ${JSON.stringify(id)}: release() can only move a row that exists ` +
          'in the private store and has not already crossed.',
      );
    }

    const verdict = releaseVerdict(existing);
    if (!verdict.ok) throw new TriageError(verdict.refusal);

    // The token is checked after the refusals, so a caller who would be refused anyway learns that
    // first: "you typed the token wrong" would send them to fix the wrong thing.
    if (options.acknowledge !== RELEASE_TOKEN) {
      throw new TriageError(releaseWarning(existing, verdict));
    }

    const now = options.now ?? Date.now();
    const record: ReleaseRecord = {
      id,
      // Carried by the verdict, so there is no cast here and no way for the record and the warning
      // to disagree about which rule was overridden.
      rule: verdict.rule,
      policy: verdict.policy,
      text: existing.text,
      digestAlgorithm: 'sha-256',
      digest: await digestOf(existing.text),
      acknowledged: options.acknowledge,
      releasedAt: now,
      completedAt: null,
    };

    // Written before the row moves: a crash between the two leaves a record that says the release
    // did not complete, and the row still private. The other order is unaudited publication.
    await this.federation.put(`private/${RELEASES}`, id, record);
    const fact = await this.cross(id, table, { releasedAt: now });
    const completed: ReleaseRecord = { ...record, completedAt: now };
    await this.federation.put(`private/${RELEASES}`, id, completed);
    return { record: completed, fact };
  }

  /** Every release record, newest last. The audit trail of overrides, and nothing else. */
  async releases(): Promise<ReleaseRecord[]> {
    const rows = await this.federation.query<ReleaseRecord>(`private/${RELEASES}`, {});
    return rows.sort((left, right) => (left.releasedAt < right.releasedAt ? -1 : 1));
  }

  /**
   * Move a row across the boundary, with the caller's own mark on it.
   *
   * Shared by `promote` and `release`, which differ in one field and in nothing else -- the ordering
   * (write, then delete) is the part that must not be written twice, because two copies of a
   * carefully chosen order is how one of them eventually gets the order wrong.
   */
  private async cross(
    id: string,
    table: string,
    mark: { confirmedAt?: number; releasedAt?: number },
  ): Promise<AdmittedFact> {
    const existing = await this.federation.get<AdmittedFact>(`private/${table}`, id);

    if (existing === undefined) {
      const already = await this.federation.get<AdmittedFact>(`shared/${table}`, id);
      if (already !== undefined) return already;
      throw new TriageError(
        `no fact with id ${JSON.stringify(id)} in either store: promotion can only move a row ` +
          `that was admitted first`,
      );
    }

    const promoted: AdmittedFact = { ...existing, visibility: 'shared', ...mark };

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
  private decide(text: string): { record: TriageRecord; retention: 'never' | undefined } {
    let decision: TriageDecision;
    try {
      decision = this.classifier(text);
    } catch (error) {
      return {
        record: { scope: 'defer', rule: null, policy: null, failure: describe(error) },
        retention: undefined,
      };
    }

    if (!KNOWN_SCOPES.includes(decision.scope)) {
      return {
        record: {
          scope: 'defer',
          rule: null,
          policy: null,
          failure: `classifier returned unknown scope ${JSON.stringify(decision.scope)}`,
        },
        retention: undefined,
      };
    }
    const { scope, rule, policy, retention } = decision;
    return { record: { scope, rule, policy }, retention };
  }
}

/**
 * The refusal a withheld fact reports.
 *
 * `'unknown'` is not a placeholder for a case that cannot happen: a classifier is injectable, and
 * one that returns `retention: 'never'` with no rule id would otherwise produce a refusal with no
 * name attached -- a message that says "we did not keep this" and cannot say why.
 */
function withheldFor(record: TriageRecord): { rule: string; policy: string } {
  return { rule: record.rule ?? 'unknown', policy: record.policy ?? '' };
}

/** One sentence, because an `Error` does not survive serialisation and a stack does not fit. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

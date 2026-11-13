/**
 * Erasure: the one operation that has to be complete, and the record that proves it was.
 *
 * ## The failure this is built against
 *
 * Two benchmarks published within a week of each other measured the same thing, and neither of them
 * measured the row. AfterDeleteBench (`arXiv:2610.31366`) deletes an agent's source record, then asks
 * the agent for the secret: a single query recovered it in **68.0%** of in-distribution cases and
 * **64.0%** on held-out profiles, against **0 of 200** for a matched agent that was never exposed.
 * The row was gone; the *derived state* -- a summary built from it -- was not. MemCut
 * (`arXiv:2610.21405`) reaches the same conclusion from the other side: deleting the turn that states
 * a secret removes very little, because the surviving ordinary turns still imply it, and
 * LLM-guided deletion of ten additional turns from twenty candidates still leaves **39-76%** residual
 * recovery.
 *
 * Both papers define their measurement around what survives deletion rather than what the delete
 * statement touched. AfterDeleteBench's own summary of the only defence that worked is the design
 * directive for this file: **provenance-aware closure** -- retire the source *and everything derived
 * from it* -- eliminated the observed recovery in every cell they tested, while an exact-literal write
 * filter (the control most products actually ship) did nothing to what was already stored.
 *
 * ## Why this product can do closure exactly, and they can only approximate it
 *
 * AfterDeleteBench has to *infer* which summaries descend from a deleted record, because their
 * summaries are model output and the lineage is a judgement. In this codebase the lineage is
 * **recorded**: every copy of a stored sentence sits in a known field of a known table, because the
 * only code that writes those fields is the code in this directory. There are four such places, and
 * they are enumerated in `ERASURE_SURFACES` below rather than discovered at run time. That turns
 * "did we get everything" from a sampling question into an arithmetic one, which is what lets a build
 * gate it.
 *
 * The four, and how each one got there:
 *
 * | surface | why a copy exists |
 * | --- | --- |
 * | `facts` (private and shared) | the admitted row itself |
 * | `cards` | `KnowledgeCard.text`, `.sourceText`, `.proposal.facts[].text`, `.origin.turns[]` |
 * | `releases` | `ReleaseRecord.text` and `.digest`, kept so an override is readable |
 *
 * `origin.turns` is the one that would be missed by a tombstone that kept "metadata": the turns are
 * the user's surrounding sentences, so a card that kept its origin would keep the paragraph the erased
 * claim came out of. It is dropped with the rest.
 *
 * ## Three decisions about the record
 *
 * 1. **`reason` is a closed union, not a string.** The record is the one row that outlives an
 *    erasure, and a free-text field on it is a place where a caller can paste the sentence it was
 *    asked to forget -- with the best of intentions, in a `reason: "user asked to delete X"` line.
 *    A union of three values cannot carry a secret.
 * 2. **No digest.** `ReleaseRecord` keeps a SHA-256 of the released wording so the audit can prove
 *    *what* crossed the boundary; an erasure record must not, because a digest of a secret is an
 *    offline guessing oracle. A person's secrets are drawn from a small, guessable space ("my
 *    diagnosis is ...", a postcode, a date of birth), so a hash is not a redaction. The record proves
 *    *that* an id was erased, and the id is what an auditor already has.
 * 3. **Written before anything is deleted, completed after.** A crash in between leaves a record that
 *    says the erasure did not finish, and the rows still there -- a failure that is visible and
 *    retryable. The other order produces a record claiming a deletion that did not happen, which is
 *    the one outcome worse than not deleting: it is a false statement about a secret.
 *
 * ## What this deliberately does not claim
 *
 * It does not reach a model's weights, a provider's logs, or a transcript the user pasted somewhere
 * else. AfterDeleteBench separates reconstruction from **write-back** and **fresh-session recall**
 * for exactly this reason; the boundary of this operation is the store this process owns, and saying
 * so is part of the contract rather than a footnote to it.
 */

/**
 * What a caller must type to erase something.
 *
 * The same shape as `RELEASE_TOKEN`, for a different reason. A release is dangerous because it
 * publishes; an erasure is dangerous because it cannot be undone, and in an agent loop the caller is
 * often a model reading a tool schema. `true` is a value a form passes by accident; a string with the
 * consequence spelled out in it has to be written on purpose, and it is stored, so an auditor can see
 * what was acknowledged rather than inferring it.
 */
import type { FederatedStorage } from '../federation/federated-storage.js';

export const ERASURE_TOKEN = 'erase-permanently';

/**
 * Why a row was erased.
 *
 * Closed on purpose -- see the module comment. `retention-policy` is the scheduled case, `correction`
 * is "it was wrong and the correction is a different sentence", and `user-request` is the one a
 * regulation names.
 */
export type ErasureReason = 'user-request' | 'retention-policy' | 'correction';

/** The three reasons, so a caller can validate a value it read from a config file. */
export const ERASURE_REASONS: readonly ErasureReason[] = [
  'user-request',
  'retention-policy',
  'correction',
];

/**
 * The fixed tables a stored sentence can reach, in one place.
 *
 * `facts` is absent on purpose: its name is a parameter (`DisclosureSessionOptions.table`), so it is
 * supplied by the caller and cannot live in a constant. These three cannot be renamed, and putting
 * them here means the erasure surface list and the write paths cannot disagree about a name --
 * `erasure-surface.test.ts` fails if a fourth literal appears anywhere else in the disclosure code.
 */
export const FACET_TABLES = {
  cards: 'cards',
  releases: 'releases',
  erasures: 'erasures',
} as const;

/**
 * One surface, named for what it is rather than for where it is.
 *
 * `role` exists so that a reader -- a test, the census tool, a person reading this module -- can say
 * "the release record was redacted" without knowing that it lives in the private store under a table
 * called `releases`. Position in the returned array is an ordering, not an identity: the code that
 * consumes these looks them up by role, so reordering the list cannot silently change what a count
 * means.
 */
export type ErasureSurface = {
  readonly role: 'private-facts' | 'shared-facts' | 'cards' | 'releases';
  readonly scope: 'private' | 'shared';
  readonly name: string;
};

/**
 * Every place a sentence stored under `table` can still be read from.
 *
 * Ordered source-first, because the deletion runs in this order and a partial failure should leave
 * the *derived* copies gone before the source is: a card whose fact is already erased renders as a
 * card about nothing, which is a worse visible state than a fact whose card was not yet tombstoned.
 * (The record says the erasure is incomplete either way; the order decides what a person sees while
 * it is.)
 */
export function erasureSurfaces(table: string): readonly ErasureSurface[] {
  return [
    { role: 'private-facts', scope: 'private', name: table },
    { role: 'shared-facts', scope: 'shared', name: table },
    { role: 'cards', scope: 'private', name: FACET_TABLES.cards },
    { role: 'releases', scope: 'private', name: FACET_TABLES.releases },
  ];
}

/**
 * How many rows each surface lost, carried on the record.
 *
 * A named type would be nicer to read and would be a third name for a shape that has one owner
 * (`ErasureRecord.removed`); the fields are documented there. `ErasureLog.complete` takes the indexed
 * type, so the two cannot drift.
 */
type ErasureRemoved = ErasureRecord['removed'];

/**
 * The durable account of one erasure.
 *
 * Carries no content by construction -- see the three decisions in the module comment. A reader of
 * this record learns that id `x` was erased, when, why, and how many rows each surface lost; it
 * learns nothing that could reconstruct `x`.
 */
export type ErasureRecord = {
  readonly id: string;
  readonly reason: ErasureReason;
  /** The token the caller typed. Recorded like a release's, and equally content-free. */
  readonly acknowledged: string;
  readonly requestedAt: number;
  /** `null` means the erasure started and did not finish. Such a record is not a claim of erasure. */
  readonly completedAt: number | null;
  /**
   * What each surface lost. Zeroed until `completedAt` is set: a count written before the work would
   * be a prediction.
   *
   * `facts` is `2` when the sentence had crossed the boundary, because then it existed in both stores
   * and the shared copy is the one a colleague could still read. `releases` counts records **redacted
   * rather than deleted**: deleting one would erase the fact that an override happened, so the
   * wording and its digest go and the override stays.
   */
  readonly removed: {
    readonly facts: number;
    readonly cards: number;
    readonly releases: number;
  };
};

/** The message a caller is shown before anything is deleted, and the one an auditor reads after. */
export function erasureWarning(
  id: string,
  found: { facts: number; cards: number; releases: number },
): string {
  return [
    `erasing ${JSON.stringify(id)} is permanent, and it removes every copy this store holds:`,
    `  fact rows:        ${String(found.facts)}`,
    `  card rows:        ${String(found.cards)} (the sentence, the wording it came from, the turns around it)`,
    `  release records:  ${String(found.releases)} (the wording and its digest are redacted; the override stays)`,
    'nothing of the wording is kept -- not a copy, not a hash: a hash of a guessable sentence is an',
    'oracle, not a redaction. The id is burned, so a later admission cannot reuse it.',
    `to proceed, pass acknowledge: ${JSON.stringify(ERASURE_TOKEN)}`,
  ].join('\n');
}

/** Whether this record is a completed erasure, which is the only kind that may be reported as one. */
export function isErased(record: ErasureRecord): boolean {
  return record.completedAt !== null;
}

/**
 * The erasure table: the one row that outlives an erasure, and the only writer of it.
 *
 * Split from `TriageWriter` even though it sits beside `releases`, because the two records answer
 * different questions and are produced by different protocols: a release records *what* crossed the
 * boundary and is written before the row moves; an erasure records *that* something was destroyed and
 * is written before the destruction and completed after it. One class holding both would be a class
 * whose ordering argument has two halves that a future caller can swap.
 *
 * There is no constructor work: no I/O, no clock read, nothing that can fail before the first call. A
 * store handle in, a table name, done -- which is what lets `TriageWriter` hold one just to answer
 * "is this id burned".
 */
export class ErasureLog {
  private readonly federation: FederatedStorage;
  private readonly table: string;

  constructor(federation: FederatedStorage, table: string = FACET_TABLES.erasures) {
    this.federation = federation;
    this.table = table;
  }

  /**
   * Open a record that says an erasure started.
   *
   * `removed` is zeroed here rather than counted later into an existing object: a count written
   * before the work is a prediction, and a record that holds a prediction next to `completedAt: null`
   * reads as a promise that a reader cannot tell from a result.
   */
  async begin(record: {
    readonly id: string;
    readonly reason: ErasureReason;
    readonly acknowledged: string;
    readonly at: number;
  }): Promise<ErasureRecord> {
    const opened: ErasureRecord = {
      id: record.id,
      reason: record.reason,
      acknowledged: record.acknowledged,
      requestedAt: record.at,
      completedAt: null,
      removed: { facts: 0, cards: 0, releases: 0 },
    };
    await this.federation.put(`private/${this.table}`, opened.id, opened);
    return opened;
  }

  /**
   * Close the record `begin()` returned, with the counts the deletions actually produced.
   *
   * It takes the record rather than an id so there is no "no such record" branch here: this is the
   * second half of one protocol, and a version that could fail on a missing row would need an error
   * path no caller can reach, which is a branch the coverage gate would find and a reviewer would
   * have to argue about.
   */
  async complete(
    opened: ErasureRecord,
    removed: ErasureRemoved,
    at: number,
  ): Promise<ErasureRecord> {
    const closed: ErasureRecord = { ...opened, removed, completedAt: at };
    await this.federation.put(`private/${this.table}`, opened.id, closed);
    return closed;
  }

  /** One record, or `undefined`. This read is also the tombstone: the record *is* the ban on the id. */
  async read(id: string): Promise<ErasureRecord | undefined> {
    return this.federation.get<ErasureRecord>(`private/${this.table}`, id);
  }

  /** Every record, oldest first. Ties broken by id so two exports of one store are byte-identical. */
  async list(): Promise<ErasureRecord[]> {
    const rows = await this.federation.query<ErasureRecord>(`private/${this.table}`, {});
    return [...rows].sort((left, right) => {
      if (left.requestedAt !== right.requestedAt) return left.requestedAt - right.requestedAt;
      return left.id < right.id ? -1 : 1;
    });
  }
}

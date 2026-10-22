/**
 * The read side: which rows a task of a given scope is allowed to see.
 *
 * ## Why this is separate from the router
 *
 * `FederatedStorage` decides *where a table lives*. It says nothing about *who is asking*. A
 * shared task ("draft a note to the team") and a private task ("what did I decide about my own
 * finances") read the same tables and must not get the same rows. That decision belongs to
 * whoever assembles the evidence for the reader -- which is why it lives here and not in
 * `cortex-memory`: the memory layer receives evidence as a parameter, and giving it a notion of
 * "private" would put a policy word inside a component whose whole test surface is
 * single-variable prompts.
 *
 * ## The two rules
 *
 * 1. A shared window is built from the shared store **only**. The private store is not queried,
 *    so a private row cannot appear "by accident of a filter someone forgot".
 * 2. Every row in a shared window must **declare itself shared**. A row that declares otherwise is
 *    a *writer* defect, and this class throws rather than filtering it out: filtering would keep
 *    the boundary looking intact while the writer stayed broken, which is the failure mode this
 *    project's audit tooling exists to catch. Fail closed, loudly.
 *
 * Rule 2 cannot be earned by rule 1: rule 1 is about which store is read, rule 2 about what a row
 * says about itself. They fail independently, so both are tested independently -- including a
 * fault injection that proves the guard can fire at all. A check that cannot fail is not a check;
 * POC-3's first draft had `async () => true` and it was deleted, not commented out.
 */

import {
  FederationError,
  type FederatedStorage,
  type MemoryScope,
  type ScopedRow,
} from './federated-storage.js';

/** Which copy survives a merge, when the same id exists in both stores. */
const ORIGIN_RANK: Record<MemoryScope, number> = { private: 0, shared: 1 };

/** Raised when the assembler is asked for something it will not produce. */
export class ScopeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeViolation';
  }
}

/** What a task is allowed to see. Same two values as a store scope, deliberately. */
export type TaskScope = MemoryScope;

export type AssembleRequest = {
  task: TaskScope;
  /** Logical table inside each store; defaults to `facts`. */
  table?: string;
};

export type ReadSideOptions = {
  /**
   * Whether to enforce rule 2. `false` exists **only** for the ablation that prices the guard;
   * nothing in the product may construct it that way.
   */
  guard?: boolean;
  /**
   * How to read a row's declared visibility. The default reads a `visibility` string, which is
   * what the triage layer writes; a caller with a different row shape supplies its own reader
   * rather than making this class know about it.
   */
  visibilityOf?: (value: unknown) => string | undefined;
};

/**
 * The default visibility reader: `value.visibility` when it is a string.
 *
 * Returning `undefined` for everything else is deliberate -- an unrecognised row cannot prove it
 * is shareable, so the guard rejects it. Silently treating "unknown" as "shared" would invert the
 * entire boundary on a schema change.
 */
const defaultVisibility = (value: unknown): string | undefined => {
  if (typeof value === 'object' && value !== null && 'visibility' in value) {
    const visibility = (value as { visibility?: unknown }).visibility;
    if (typeof visibility === 'string') return visibility;
  }
  return undefined;
};

export class ReadSideAssembler {
  private readonly federation: FederatedStorage;
  private readonly guard: boolean;
  private readonly visibilityOf: (value: unknown) => string | undefined;

  constructor(federation: FederatedStorage, options: ReadSideOptions = {}) {
    this.federation = federation;
    this.guard = options.guard ?? true;
    this.visibilityOf = options.visibilityOf ?? defaultVisibility;
  }

  /**
   * Assemble the rows a task of the given scope may see.
   *
   * @throws {ScopeViolation} when the task scope is unknown, or when a shared window would carry
   * a row that does not declare itself shared.
   */
  async assemble(request: AssembleRequest): Promise<ScopedRow[]> {
    const { task, table = 'facts' } = request;
    if (task !== 'private' && task !== 'shared') {
      throw new ScopeViolation(
        `unknown task scope ${JSON.stringify(task)}: expected private or shared`,
      );
    }

    const rows = task === 'shared' ? await this.sharedOnly(table) : await this.bothStores(table);

    if (task === 'shared' && this.guard) {
      const offending = rows.filter((row) => this.visibilityOf(row.value) !== 'shared');
      if (offending.length > 0) {
        const keys = offending.map((row) => row.key ?? '<no id>').join(', ');
        throw new ScopeViolation(
          `shared window would carry ${offending.length} row(s) that do not declare themselves ` +
            `shared (${keys}). This is a write-side defect, not a read-side one: refusing to ` +
            `assemble is preferable to dropping the rows, because dropping them would hide the ` +
            `defect while making the boundary look intact.`,
        );
      }
    }

    return rows;
  }

  /** Shared tasks read one store. Nothing else is queried, so nothing else can leak. */
  private async sharedOnly(table: string): Promise<ScopedRow[]> {
    const rows = await this.federation.query<unknown>(`shared/${table}`, {});
    return rows.map((value) => this.tag('shared', value));
  }

  /**
   * Private tasks read both stores and dedupe by id, preferring the owner's copy.
   *
   * Rows without an id are kept rather than merged: two rows that cannot be proven identical must
   * not be collapsed, and a positional key would have collapsed unrelated facts silently.
   */
  private async bothStores(table: string): Promise<ScopedRow[]> {
    const across = await this.federation.queryAcross<unknown>(`private/${table}`, {});
    // The owner's copy wins, and that rule is stated once, as an ordering, instead of being
    // spread across a comparison that also has to reason about arrival order. The previous
    // version compared origins inside the merge loop, which left an arm that could only be taken
    // if `queryAcross` reversed its own output -- unreachable today, and silently wrong the day
    // it stopped being unreachable.
    const ordered = [...across].sort(
      (left, right) => ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin],
    );

    const keyed = new Map<string, ScopedRow>();
    const unkeyed: ScopedRow[] = [];

    for (const row of ordered) {
      if (row.key === undefined) {
        unkeyed.push(row);
        continue;
      }
      // First wins: `ordered` already put the preferred origin first.
      if (!keyed.has(row.key)) keyed.set(row.key, row);
    }

    return [...keyed.values(), ...unkeyed];
  }

  /** Report a row's origin, and its identity when the value carries one. */
  private tag(origin: MemoryScope, value: unknown): ScopedRow {
    if (typeof value === 'object' && value !== null && 'id' in value) {
      const id = (value as { id?: unknown }).id;
      if (typeof id === 'string') return { origin, key: id, value };
    }
    return { origin, value };
  }
}

/** Re-exported so callers catch one error family without importing two modules. */
export { FederationError };

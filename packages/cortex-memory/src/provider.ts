/**
 * Cortex's own retrieval, in the shape the competitor harness asks for.
 *
 * ## Why this exists, and what it is allowed to claim
 *
 * A harness that runs competitors through one loop while Cortex keeps its own is measuring pipelines. So
 * Cortex has to be one more adapter: same sessions in, same hits out. The cost is real — the product loses
 * every advantage its own plumbing gave it — and that is the point.
 *
 * ## What this adapter actually covers
 *
 * The product's session route is four steps: admit, drop the roles the route excludes, spend the session
 * budget, then build the prompt. The first three are pure functions exported from `sessionize.ts`, and this
 * adapter calls **those functions**, not a copy of them. The fourth is prompt construction and does not
 * belong here: a provider returns evidence, the reader writes the answer.
 *
 * Two consequences follow, and both are stated rather than buried:
 *
 * 1. **`threshold: 0` makes admission an identity.** The write gate is a different measurement — it decides
 *    what enters the store at all — and folding it into a retrieval number would make a low score ambiguous
 *    between "the gate dropped it" and "the budget dropped it". A caller that wants the gate measured passes
 *    a different threshold and says so.
 * 2. **The session budget's value function does not see the query.** `selectSessionBudget` ranks sessions by
 *    their best turn's value, which is a function of recency and length. That is a fact about the product,
 *    not a property of this adapter, and it is exactly the kind of thing a retrieval harness should surface:
 *    if Cortex loses recall here while a lexical index does not, the loss is in selection, not in reading.
 *
 * The types below are structurally identical to `cortex-eval`'s `MemoryProvider` and deliberately **not
 * imported** from it. `cortex-eval` may depend on `cortex-memory`; the reverse would make a measurement
 * package part of the product's dependency graph.
 */

import { admissionOptionsFrom, type AdmissionOptions } from './admission.js';
import { admitSessions, selectSessionBudget, type AdmittedSession } from './sessionize.js';

export type ProviderTurn = { readonly role: 'user' | 'assistant'; readonly content: string };

export type ProviderSession = {
  readonly id: string;
  readonly at: number;
  readonly turns: readonly ProviderTurn[];
};

export type ProviderHit = { readonly text: string; readonly score?: number; readonly at?: number };

export type ProviderIngestReport = {
  readonly sessions: number;
  readonly turns: number;
  readonly skipped: readonly string[];
};

export type ProviderSearchOptions = {
  readonly limit: number;
  readonly asOf?: number;
};

export type CortexSessionProviderOptions = {
  /**
   * The clock the budget's value function reads.
   *
   * Required rather than defaulted, because recency is part of the value function and a default of `now()`
   * would make two runs of one fixture disagree.
   */
  readonly now: number;
  /**
   * Sessions the budget may hold.
   *
   * The effective ceiling is `min(sessionBudget, limit)`, because the harness's `limit` **is** a top-k and a
   * provider that returned more would be running a different experiment. With the default `Infinity` the
   * limit alone decides; a smaller value models a product whose prompt budget bites before the harness's
   * top-k does.
   */
  readonly sessionBudget?: number;
  /** Admission threshold. Zero admits everything, which is what an identity gate means. */
  readonly threshold?: number;
};

/**
 * The product's session selection, exposed as a provider.
 *
 * `search` returns whole sessions rather than turns, because that is the unit the product budgets in and
 * because a session boundary is what makes multi-session reasoning possible at all — flattening here would
 * reproduce the flat route and make this adapter measure something the product does not do.
 */
export class CortexSessionProvider {
  readonly name = 'cortex-session';
  readonly build = 'embedding' as const;

  #sessions: ProviderSession[] = [];
  #now: number;
  #budget: number;
  #threshold: number;

  constructor(options: CortexSessionProviderOptions) {
    this.#now = options.now;
    this.#budget = options.sessionBudget ?? Number.POSITIVE_INFINITY;
    this.#threshold = options.threshold ?? 0;
  }

  async ingest(sessions: readonly ProviderSession[]): Promise<ProviderIngestReport> {
    this.#sessions.push(...sessions);
    return {
      sessions: this.#sessions.length,
      turns: this.#sessions.reduce((total, session) => total + session.turns.length, 0),
      skipped: [],
    };
  }

  async search(query: string, options: ProviderSearchOptions): Promise<readonly ProviderHit[]> {
    void query;
    if (this.#sessions.length === 0) return [];

    const pool =
      options.asOf === undefined
        ? this.#sessions
        : this.#sessions.filter((session) => session.at <= options.asOf!);

    // `retrievalThreshold` and `sessionBudget` are part of `GateOptions` but not of admission: the first
    // belongs to the abstention route, the second is spent below. Supplying them here keeps the call honest
    // about which of the three an adapter is exercising.
    const gate: AdmissionOptions = admissionOptionsFrom(this.#now, {
      threshold: this.#threshold,
      retrievalThreshold: this.#threshold,
      sessionBudget: Number.isFinite(this.#budget) ? this.#budget : Number.MAX_SAFE_INTEGER,
    });
    const admitted = admitSessions(
      pool.map((session) => session.turns.map((turn) => turn.content)),
      gate,
    );
    // The harness's `limit` is the top-k of the run, and the product's session budget is the same kind of
    // ceiling. Taking the smaller keeps one number in charge of how much evidence a question may carry, which
    // is what makes two providers comparable at all.
    const ceiling = Math.min(this.#budget, options.limit);
    const selected: readonly AdmittedSession[] = selectSessionBudget(admitted, ceiling);

    return selected.map((session) => {
      const source = pool[session.index];
      return {
        text: session.turns.map((turn) => turn.content).join('\n'),
        ...(source === undefined ? {} : { at: source.at }),
      };
    });
  }

  async reset(): Promise<void> {
    this.#sessions = [];
  }
}

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
 * 2. **The session budget's ranking is value-based, and the value is constant.** `selectSessionBudget` ranks
 *    sessions by their best turn's value, `confidence * sourceTrust * (0.5 + 0.5 * recency)`. Admission stamps
 *    `lastAccessedAt = createdAt = now`, so recency is `1` for every turn, and with `sourceTrust` at its
 *    default and no `confidenceFor` every admitted turn carries exactly `0.5`. The ranking therefore ties and
 *    falls through to arrival order — measured, not inferred: 24 turns, one distinct value. That is why this
 *    adapter passes a `relevance` ranker (`lexicalRelevance`, bound to the query), and why it declares
 *    `build: 'none'`: a term-overlap signal uses no model, and claiming `'embedding'` would have been a false
 *    statement about the cost side of the ledger.
 *
 *    This is the kind of thing a retrieval harness exists to surface. Cortex lost `all-gold` on the synthetic
 *    set precisely here — selection, not reading — and the adapter found the defect before the product did.
 *
 * 3. **Hits are returned in ranked order, not chronological order.** The product re-sorts selected sessions
 *    into arrival order before writing a prompt, because a prompt listing a later session first makes
 *    relative-time questions unanswerable. A *retrieval* interface is read for rank — the harness measures MRR
 *    from the position of the first hit — so presenting chronologically there would report a rank the
 *    selection never assigned. The two orders are different claims and this adapter states both.
 *
 * The types below are structurally identical to `cortex-eval`'s `MemoryProvider` and deliberately **not
 * imported** from it. `cortex-eval` may depend on `cortex-memory`; the reverse would make a measurement
 * package part of the product's dependency graph.
 */

import { admissionOptionsFrom, type AdmissionOptions } from './admission.js';
import { lexicalRelevance } from './relevance.js';
import {
  admitSessions,
  selectSessionBudget,
  selectTurnsWithinBudget,
  type AdmittedSession,
  type SessionRelevance,
  type TurnBudgetOptions,
  type TurnBudgetPlan,
  type TurnCost,
  type TurnRelevance,
} from './sessionize.js';

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
   * Turns the product's session budget may hold — the product's unit, not the harness's.
   *
   * A session is admitted whole or not at all, so this is a ceiling on the evidence a prompt could carry and
   * not a count of hits. The harness's top-k is applied to hits and is a different number in a different unit;
   * a smaller `sessionBudget` models a product whose prompt budget bites before the reader's top-k does.
   *
   * The default is `Infinity`, which spends nothing, so the top-k alone decides how much a reader sees.
   */
  readonly sessionBudget?: number;
  /**
   * What {@link sessionBudget} counts.
   *
   * `turns` (the default) is the product's unit: a turn is the thing admission judges and the thing
   * `selectSessionBudget` spends. `chars` is the reader's unit — a prompt is bounded in text, and the published
   * systems report that bound in tokens (Mem0 6,787, Zep 4,408, Contextier 2,807 mean). A budget expressed in
   * turns cannot be compared with any of those, because a turn is ten characters or two thousand.
   */
  readonly budgetUnit?: 'turns' | 'chars';
  /**
   * Spend the budget inside a session instead of only between sessions.
   *
   * Off by default, and the default is the measured baseline: `selectSessionBudget` admits a session whole or
   * not at all, which on LongMemEval-S costs `all-gold 82.2% -> 6.6%` at an eight-turn budget. On, a session that
   * does not fit is trimmed to its most relevant turns rather than dropped — the arm LongMemEval's paper calls
   * *session decomposition for value granularity* (+9.4 recall@5, +5.4 absolute accuracy upstream).
   *
   * It needs a finite budget to mean anything: with `Infinity` every session fits whole and the two arms are
   * the same run, which is why the competition table prints them as separate rows only at a bounded budget.
   */
  readonly trim?: boolean;
  /** Admission threshold. Zero admits everything, which is what an identity gate means. */
  readonly threshold?: number;
  /** Row label in a comparison table. Defaults to `cortex-session`. */
  readonly label?: string;
};

/**
 * The product's session selection, exposed as a provider.
 *
 * `search` returns whole sessions rather than turns, because that is the unit the product budgets in and
 * because a session boundary is what makes multi-session reasoning possible at all — flattening here would
 * reproduce the flat route and make this adapter measure something the product does not do.
 */
export class CortexSessionProvider {
  /**
   * The row label.
   *
   * Configurable because a table that prints four arms of one adapter under one name cannot be read: the whole
   * point of the granularity and budget arms is that they are different runs of the same code.
   */
  readonly name: string;
  /**
   * `none`, because the ranking signal is term overlap and uses no model.
   *
   * `BuildCost` is the cost side of the ledger, and declaring `'embedding'` while ranking lexically would
   * misreport what the run spent — the one field in the comparison a reader checks to know whether two rows
   * were produced by the same kind of machine.
   */
  readonly build = 'none' as const;

  #sessions: ProviderSession[] = [];
  #now: number;
  #budget: number;
  #threshold: number;
  #unit: 'turns' | 'chars';
  #trim: boolean;

  constructor(options: CortexSessionProviderOptions) {
    this.name = options.label ?? 'cortex-session';
    this.#now = options.now;
    this.#budget = options.sessionBudget ?? Number.POSITIVE_INFINITY;
    this.#threshold = options.threshold ?? 0;
    this.#unit = options.budgetUnit ?? 'turns';
    this.#trim = options.trim ?? false;
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

    // The signal, computed once per session so the selection and the ordering below cannot disagree about a
    // score. `lexicalRelevance` is pure and cheap, but computing it twice would be two chances to bind the
    // wrong query rather than one place that binds it.
    const scores = new Map<number, number>();
    const relevance: SessionRelevance = (session) => {
      const cached = scores.get(session.index);
      if (cached !== undefined) return cached;
      let best = Number.NEGATIVE_INFINITY;
      for (const turn of session.turns) {
        const score = lexicalRelevance(query, turn.content);
        if (score > best) best = score;
      }
      scores.set(session.index, best);
      return best;
    };

    // The harness's `limit` is a top-k on **hits**; the product's session budget is a ceiling on **turns**.
    // Folding one into the other was a defect, and it was invisible on the only corpus this tool used to have:
    // the synthetic generator writes one turn per session, so "ten turns" and "ten sessions" were the same
    // number. On LongMemEval-S a session carries about ten turns, so `min(budget, limit)` admitted **one**
    // session per question and the adapter read 25.4% recall against a lexical index's 93.6% — a measurement
    // of the adapter's unit error, not of the product.
    //
    // The two now stay in their own units: the budget is spent in whatever unit the caller named (unbounded
    // unless configured), and the top-k is applied to hits below.
    //
    // `trim` is a granularity arm, not a refinement of the same arm: whole-session admission and turn-level
    // trimming are the two settings LongMemEval's harness exposes as `GRANULARITY: session | turn`, and its
    // paper reports the turn setting as up to +9.4 recall@5. Keeping them as separate constructor options is
    // what lets one run print both rows against one corpus.
    const selected: readonly AdmittedSession[] = this.#trim
      ? this.#fillToBudget(admitted, query)
      : selectSessionBudget(admitted, this.#budget, relevance);

    // Ranked, not chronological. See point 3 in this file's header: the product's arrival-order re-sort is a
    // prompt-presentation rule, and the position of a hit here is read as its rank.
    return selected
      .map((session) => ({ session, score: relevance(session) }))
      .sort((a, b) => b.score - a.score || a.session.index - b.session.index)
      .slice(0, options.limit)
      .map(({ session, score }) => {
        // `session.index` is the position in the array `admitSessions` was given, and that array is
        // `pool.map(...)` -- same length, same order, no filter. So the lookup cannot miss, and a `=== undefined`
        // guard here would be a branch no input can enter. It was one until the coverage gate named it, which is
        // the check this project relies on to keep a defensive branch from standing in for a thought.
        const source = pool[session.index] as ProviderSession;
        return {
          text: session.turns.map((turn) => turn.content).join('\n'),
          score,
          at: source.at,
        };
      });
  }

  /**
   * The turn-granularity arm: spend the budget inside sessions, not only between them.
   *
   * Extracted so the two options (`budgetUnit`, `trim`) are read in one place. A caller reading only `search`
   * would otherwise have to hold four combinations in their head to know which rule ran.
   */
  #fillToBudget(admitted: readonly AdmittedSession[], query: string): readonly AdmittedSession[] {
    const cost: TurnCost | undefined =
      this.#unit === 'chars' ? (turn) => turn.content.length : undefined;
    const relevance: TurnRelevance = (turn) => lexicalRelevance(query, turn.content);
    const options: TurnBudgetOptions = {
      ...(cost === undefined ? {} : { cost }),
      relevance,
    };
    const plan: TurnBudgetPlan = selectTurnsWithinBudget(admitted, this.#budget, options);
    return plan.sessions;
  }

  async reset(): Promise<void> {
    this.#sessions = [];
  }
}

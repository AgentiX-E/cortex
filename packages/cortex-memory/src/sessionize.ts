/**
 * Session boundaries: the input the flat path structurally cannot receive.
 *
 * `runBenchmark` routes MR questions to `answerSessions(question, sessions)`,
 * where each element of `sessions` is one session's ordered turns. The measured
 * reason this matters is recorded in `cortex-eval`'s contract: correct answers
 * admit 52.4% of their evidence session against 40.0% for failures, because a
 * boundary is what lets a bounded turn budget be spent on a session retrieval
 * already judged relevant rather than on scattered neighbours.
 *
 * Pure. `now` is passed through to admission.
 */
import { admitTurns, type AdmissionOptions, type AdmittedTurn } from './admission.js';

/** One session's admitted turns, with the identity needed to sort and cite it. */
export type AdmittedSession = {
  /** Zero-based position of the session in the input list. */
  index: number;
  /** Number of admitted turns, cached so budgeting does not re-measure. */
  size: number;
  /** Admitted turns, in original order. */
  turns: AdmittedTurn[];
};

/**
 * Apply admission independently to each session.
 *
 * Independently is the operative word. Admitting over the concatenation and
 * then re-splitting would let a strong session pull a weak one's turns over the
 * line — the gate would be measuring the average of two things it was supposed
 * to judge separately.
 *
 * Sessions that admitted nothing are dropped: an empty session carries no
 * evidence, costs prompt budget, and makes a boundary look populated when it is
 * not.
 */
export function admitSessions(
  sessions: readonly string[][],
  gate: AdmissionOptions,
): AdmittedSession[] {
  const admissionOptions = gate;
  const admitted: AdmittedSession[] = [];

  for (let index = 0; index < sessions.length; index += 1) {
    const turns = sessions[index];
    if (turns === undefined) continue;

    const kept = admitTurns(turns, admissionOptions);
    if (kept.length === 0) continue;

    admitted.push({ index, size: kept.length, turns: kept });
  }

  return admitted;
}

/**
 * A session's relevance to the question being answered, in any finite range.
 *
 * The same freedom `PromptOptions.relevanceFor` documents, for the same reason:
 * this only **orders** sessions, and a log-likelihood, a centred cosine and a
 * reciprocal-rank penalty all order them. Rescaling would be the layer inventing
 * a calibration it has no basis for.
 *
 * A closure over one session rather than `(question, session)` because the
 * question is fixed for the whole selection: binding it once at the call site is
 * what keeps it out of the sort comparator, where it would be state written by
 * one call site and read by another.
 */
export type SessionRelevance = (session: AdmittedSession) => number;

/**
 * Choose which sessions fit a turn budget.
 *
 * Selection is by the **session's best admitted turn**, not by its size or its
 * mean. Best-of is what matches the decision the gate already made: a session
 * earned its place by containing something valuable, and averaging would let a
 * long dull session outrank a short decisive one.
 *
 * ## Why `bestValue` alone is not a ranking, and what `relevance` is for
 *
 * A turn's value is `confidence * sourceTrust * (0.5 + 0.5 * recency)`, and
 * admission stamps `lastAccessedAt = createdAt = now`, so `recency` is exactly
 * `1` for every turn of one admission. With `sourceTrust` at its default and no
 * `confidenceFor`, every admitted turn therefore carries the identical `0.5` —
 * measured on the synthetic set: 24 turns, one distinct value. `bestValue` then
 * ties across every session and this sort falls through to its tie-break,
 * `session.index`, which is arrival order.
 *
 * So "highest-value session first" was, in the configuration that was actually
 * run, "first session first". That is a real defect and it has a measured
 * signature: `all-gold 8.3%` against `recall@k 91.7%`, i.e. the budget reaches
 * material containing a gold turn for almost every question and spends the room
 * on the wrong sessions.
 *
 * `relevance` is the repair, and it is an **explicit parameter, not a widened
 * `confidenceFor`**. Widening the admission callback would make the write gate
 * depend on the question, which is a category error — a turn is worth retaining
 * whether or not anybody has asked about it yet. Ranking sessions, by contrast,
 * is already a question-relative decision, and the question is in scope at every
 * call site that can supply this.
 *
 * ## The ordering, and why it is three keys
 *
 * `relevance` descends first when supplied; `bestValue` descends second;
 * `session.index` ascends last. The three are distinct claims: what was asked,
 * what the gate valued, and what arrived first. Keeping `bestValue` as the second
 * key rather than folding it into a weighted sum means no coefficient is
 * invented — a weighted sum would need a tuning corpus, and a corpus is exactly
 * what this must not be fitted to.
 *
 * When `relevance` is absent the first key is `bestValue`, so the behaviour is
 * byte-for-byte the one every prior run was produced under. That is what keeps
 * the archived artifacts comparable.
 *
 * Two ordering rules, and they are different on purpose:
 *
 * - ties break by ascending session index, so the result is deterministic;
 * - the returned list is in ascending index order regardless of selection
 *   order, because presentation must be chronological. A prompt that lists a
 *   later session before an earlier one makes relative-time and
 *   knowledge-update questions unanswerable.
 *
 * A session that alone exceeds the budget is admitted rather than skipped. If
 * every session overflows, admitting none is the wrong answer — the system
 * would answer every question from no evidence — so the single highest-value
 * session is taken.
 */
export function selectSessionBudget(
  sessions: readonly AdmittedSession[],
  budget: number,
  relevance?: SessionRelevance,
): AdmittedSession[] {
  if (budget <= 0 || sessions.length === 0) return [];

  const ranked = sessions
    .map((session) => ({
      session,
      best: bestValue(session),
      // `0` rather than an absent field when no signal was supplied, so the
      // comparator has one shape and the fall-through to `best` is a value
      // rather than a branch inside the sort.
      asked: relevance === undefined ? 0 : validateRelevance(session, relevance(session)),
    }))
    .sort(
      (a, b) =>
        (relevance === undefined ? 0 : b.asked - a.asked) ||
        b.best - a.best ||
        a.session.index - b.session.index,
    );

  const chosen: AdmittedSession[] = [];
  let used = 0;

  for (const entry of ranked) {
    if (used + entry.session.size > budget) continue;
    chosen.push(entry.session);
    used += entry.session.size;
  }

  if (chosen.length === 0) {
    const [first] = ranked;
    if (first !== undefined) chosen.push(first.session);
  }

  return chosen.sort((a, b) => a.index - b.index);
}

/**
 * Reject a relevance score that cannot order sessions.
 *
 * `NaN` is the dangerous one and the reason this guard exists at all: every
 * comparison against it is false, so a comparator that receives one returns `0`
 * for every pair, the sort keeps its input order, and the selection silently
 * reverts to the arrival-order defect this parameter was added to repair — while
 * the artifact reports that a relevance signal was in use. That is the same
 * failure shape as an inert `retrievalThreshold`: a recorded configuration value
 * that does not reach the decision it names.
 *
 * The infinities are rejected for the same reason: they do not order
 * reproducibly once two of them appear.
 *
 * Thrown rather than clamped, following `validateSourceTrust`. A clamp would turn
 * `NaN` into a number and complete a run whose result describes the callback
 * rather than the system.
 *
 * The message carries the session index because the callback is evaluated per
 * session, and "somewhere in this corpus" is not a location.
 */
function validateRelevance(session: AdmittedSession, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `SessionRelevance must return a finite number, got ${String(value)} for session ` +
        `${session.index}. A NaN makes every comparison in the ranking false, so the sort ` +
        'keeps its input order and the selection silently falls back to arrival order while ' +
        'the run reports that a relevance signal was supplied.',
    );
  }
  return value;
}

/** The highest admitted-turn value in a session; `0` for an empty one. */
function bestValue(session: AdmittedSession): number {
  let best = 0;
  for (const turn of session.turns) {
    if (turn.value > best) best = turn.value;
  }
  return best;
}

/**
 * What one turn costs against the budget.
 *
 * Turns because `selectSessionBudget` spends turns; characters or tokens when the caller is spending a prompt.
 * The function is injected rather than fixed because `cortex-memory` counts no tokeniser — the same boundary
 * `PromptOptions.relevanceFor` and `confidenceFor` draw.
 */
export type TurnCost = (turn: AdmittedTurn) => number;

/** What one turn is worth when the budget has to choose between turns of one session. */
export type TurnRelevance = (turn: AdmittedTurn, session: AdmittedSession) => number;

export type TurnBudgetOptions = {
  /** Cost of one turn. Default `1`, i.e. the budget is counted in turns. */
  readonly cost?: TurnCost;
  /** Value of one turn. Required: a trim without a signal trims in arrival order. */
  readonly relevance: TurnRelevance;
};

export type TurnBudgetPlan = {
  /** Selected sessions, each in its original turn order and with `size` restated. */
  readonly sessions: readonly AdmittedSession[];
  /** Total cost spent. */
  readonly spent: number;
  /** Sessions that were admitted with fewer turns than they hold. */
  readonly trimmed: number;
  /** Sessions that contributed nothing. */
  readonly dropped: number;
};

/**
 * Fill a budget with turns, keeping session boundaries.
 *
 * ## Why this exists next to `selectSessionBudget` and not inside it
 *
 * `selectSessionBudget` is all-or-nothing per session: a session is admitted whole or not at all, which is a
 * correct rule for a **turn** budget and a broken one for a **prompt** budget. Measured on LongMemEval-S: at an
 * eight-turn budget a ten-turn session is skipped, and `all-gold` reads 6.6% against 82.2% unbounded. The rule
 * was not wrong; the unit was.
 *
 * LongMemEval's own paper names this as the first of its three optimisations — *"session decomposition for
 * value granularity"*, reported as up to +9.4 recall@5 and +5.4 absolute downstream accuracy. Its official
 * harness exposes `GRANULARITY: turn | session` for exactly this comparison. So the granularity is not a
 * preference; it is a variable with a published effect size, and this function is the arm that can express it
 * while keeping the boundary that makes multi-session reasoning possible.
 *
 * ## The four decisions, and why each is one
 *
 * 1. **Sessions are ranked by their best turn**, not by their total — the same rule `selectSessionBudget`
 *    uses, for the same reason: one decisive turn earns the session its place, and a long dull session must not
 *    outrank a short one.
 * 2. **A session that does not fit whole is trimmed, not dropped.** Its turns are taken in relevance order
 *    until the room is gone. Taking them in arrival order instead would make the trim a function of when
 *    something was said rather than of whether it answers.
 * 3. **A trimmed session keeps its turns in arrival order for presentation.** Selection is by relevance,
 *    presentation is chronological; a block that lists a later turn first makes relative-time questions
 *    unanswerable, which is the rule `selectSessionBudget` already pays a second sort for.
 * 4. **No session is admitted if nothing fits, but one turn is.** An empty context answers every question from
 *    nothing, so the highest-relevance turn is taken even when it overflows — the same fallback, for the same
 *    reason, as the whole-session path.
 *
 * ## What it costs
 *
 * A partial session is a real loss: the reader sees a fragment of a conversation and may misread it. That is
 * why the plan reports `trimmed` rather than hiding it, and why the competition table prints both arms — a
 * budget that fits whole sessions should not be compared with one that trims.
 */
export function selectTurnsWithinBudget(
  sessions: readonly AdmittedSession[],
  budget: number,
  options: TurnBudgetOptions,
): TurnBudgetPlan {
  const costOf = options.cost ?? ((): number => 1);
  if (budget <= 0 || sessions.length === 0) {
    return { sessions: [], spent: 0, trimmed: 0, dropped: 0 };
  }

  const scored = sessions.map((session) => {
    const turns = session.turns.map((turn) => ({
      turn,
      cost: validateCost(turn, session, costOf(turn)),
      relevance: validateTurnRelevance(turn, session, options.relevance(turn, session)),
    }));
    // Best-of, so one decisive turn carries the session.
    const best = turns.reduce(
      (top, entry) => Math.max(top, entry.relevance),
      Number.NEGATIVE_INFINITY,
    );
    return { session, turns, best };
  });

  scored.sort((a, b) => b.best - a.best || a.session.index - b.session.index);

  const chosen: AdmittedSession[] = [];
  let spent = 0;
  let trimmed = 0;
  let dropped = 0;

  for (const entry of scored) {
    const total = entry.turns.reduce((sum, item) => sum + item.cost, 0);
    if (spent + total <= budget) {
      chosen.push(entry.session);
      spent += total;
      continue;
    }

    // Partial: take the most relevant turns that still fit.
    const byRelevance = [...entry.turns].sort(
      (a, b) => b.relevance - a.relevance || a.turn.ordinal - b.turn.ordinal,
    );
    const keep = new Set<number>();
    let room = budget - spent;
    for (const item of byRelevance) {
      if (item.cost > room) continue;
      keep.add(item.turn.ordinal);
      room -= item.cost;
    }

    if (keep.size === 0) {
      dropped += 1;
      continue;
    }

    // Presentation order is arrival order, not relevance order.
    const kept = entry.turns.filter((item) => keep.has(item.turn.ordinal)).map((item) => item.turn);
    chosen.push({ index: entry.session.index, size: kept.length, turns: kept });
    spent += kept.reduce((sum, turn) => sum + costOf(turn), 0);
    trimmed += 1;
  }

  if (chosen.length === 0) {
    // Nothing fits. Answering from no evidence is worse than exceeding the budget, so the single most relevant
    // turn is taken -- a fragment of one session rather than an empty context.
    const [first] = scored;
    if (first !== undefined) {
      const best = [...first.turns].sort(
        (a, b) => b.relevance - a.relevance || a.turn.ordinal - b.turn.ordinal,
      )[0];
      if (best !== undefined) {
        chosen.push({ index: first.session.index, size: 1, turns: [best.turn] });
        spent = best.cost;
        trimmed += 1;
      }
    }
  }

  return {
    sessions: chosen.sort((a, b) => a.index - b.index),
    spent,
    trimmed,
    dropped,
  };
}

function validateCost(turn: AdmittedTurn, session: AdmittedSession, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `TurnCost must return a finite, non-negative number, got ${String(value)} for turn ` +
        `${turn.ordinal} of session ${session.index}. A negative or NaN cost makes the budget ` +
        'spend down to a number that is not a size, and the plan then reports a spend it did not make.',
    );
  }
  return value;
}

function validateTurnRelevance(
  turn: AdmittedTurn,
  session: AdmittedSession,
  value: number,
): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `TurnRelevance must return a finite number, got ${String(value)} for turn ${turn.ordinal} ` +
        `of session ${session.index}. A NaN trims in arrival order while the run reports that a ` +
        'signal was supplied.',
    );
  }
  return value;
}

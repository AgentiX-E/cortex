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

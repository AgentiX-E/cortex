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
 * Choose which sessions fit a turn budget.
 *
 * Selection is by the **session's best admitted turn**, not by its size or its
 * mean. Best-of is what matches the decision the gate already made: a session
 * earned its place by containing something valuable, and averaging would let a
 * long dull session outrank a short decisive one.
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
): AdmittedSession[] {
  if (budget <= 0 || sessions.length === 0) return [];

  const ranked = sessions
    .map((session) => ({ session, best: bestValue(session) }))
    .sort((a, b) => b.best - a.best || a.session.index - b.session.index);

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

/** The highest admitted-turn value in a session; `0` for an empty one. */
function bestValue(session: AdmittedSession): number {
  let best = 0;
  for (const turn of session.turns) {
    if (turn.value > best) best = turn.value;
  }
  return best;
}

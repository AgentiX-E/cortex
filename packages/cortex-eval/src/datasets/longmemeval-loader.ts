/**
 * Loader for the official LongMemEval dataset format into the Cortex
 * `BenchmarkDataset` contract. The full dataset is large (LFS-hosted), so in
 * production the JSON file is read locally at runtime; this module is tested
 * against a small representative sample.
 *
 * Official format (per instance):
 *   question_id, question_type, question, answer, question_date,
 *   haystack_session_ids, haystack_dates, haystack_sessions,
 *   answer_session_ids.
 *
 * An instance whose `question_id` ends with `_abs` is an abstention question;
 * its expected answer is mapped to `null`.
 */
import type { BenchmarkDataset, Capability, Question } from '../types.js';

export type LongMemEvalTurn = {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
};

export type LongMemEvalInstance = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_session_ids?: string[];
  haystack_dates?: string[];
  haystack_sessions?: LongMemEvalTurn[][];
  answer_session_ids?: string[];
};

const TYPE_TO_CAPABILITY: Record<string, Capability> = {
  'single-session-user': 'IE',
  'single-session-assistant': 'IE',
  'single-session-preference': 'IE',
  'temporal-reasoning': 'TR',
  'knowledge-update': 'KU',
  'multi-session': 'MR',
};

/** Map a LongMemEval `question_type` to a Cortex capability. */
export function toCapability(questionId: string, questionType: string): Capability {
  if (questionId.endsWith('_abs')) {
    return 'ABS';
  }
  return TYPE_TO_CAPABILITY[questionType] ?? 'IE';
}

/**
 * Capabilities that carry a per-question diagnostic record.
 *
 * `MR` has its own diagnostics file — it needs the retrieved sessions and
 * multi-hop evidence, which the single-session record has no room for — so it is
 * excluded from this set rather than from both.
 *
 * Every other capability, `ABS` included, must have a record. `ABS` was once
 * excluded on the grounds that it is not a "single-session" question type, and
 * the cost was that the capability with both the smallest sample and the largest
 * percentage spread was the only one invisible to a cross-run comparison. The
 * membership rule is therefore expressed as capabilities that *can* be recorded,
 * not as a list of names someone has to remember to extend.
 */
export const DIAGNOSED_CAPABILITIES: readonly Capability[] = ['IE', 'KU', 'TR', 'ABS'];

/** Whether an instance's capability carries a per-question diagnostic record. */
export function hasDiagnosticRecord(questionId: string, questionType: string): boolean {
  return DIAGNOSED_CAPABILITIES.includes(toCapability(questionId, questionType));
}

/** Render a turn as a context string, optionally prefixing its session date. */
export function turnText(turn: LongMemEvalTurn, date?: string): string {
  const prefix = date ? `[${date}] ` : '';
  return `${prefix}${turn.role}: ${turn.content}`;
}

/**
 * Flatten all session turns into a single ordered list of context strings.
 * When `dates` is provided (aligned with `sessions`), each turn carries its
 * session date so temporal reasoning can see chronological ordering.
 */
export function flattenSessions(sessions?: LongMemEvalTurn[][], dates?: string[]): string[] {
  const out: string[] = [];
  for (const session of sessionsToContext(sessions, dates)) {
    out.push(...session);
  }
  return out;
}

/**
 * Render sessions as grouped context strings, preserving session boundaries so
 * multi-session reasoning can aggregate evidence across sessions.
 */
export function sessionsToContext(sessions?: LongMemEvalTurn[][], dates?: string[]): string[][] {
  const list = sessions ?? [];
  const out: string[][] = [];
  for (let i = 0; i < list.length; i++) {
    const date = dates?.[i];
    out.push(list[i]!.map((turn) => turnText(turn, date)));
  }
  return out;
}

/**
 * The gold session's turns, rendered the way `context` renders them.
 *
 * ## Why the identifiers have to be intersected rather than trusted
 *
 * `answer_session_ids` names sessions by id and `haystack_sessions` is positional, so
 * the two are only related through `haystack_session_ids`. The loader used to discard
 * all three, which is why `§13.11.5`'s question -- was the gold turn inside what the
 * model saw -- had no direct answer and had to be approximated by a session-index rule
 * and then by an answer-text match. The first of those was a heuristic and the second
 * was refuted by its own artifact (`§13.18.2`).
 *
 * ## Why the rendered text and not an index
 *
 * Because `sessionsToContext` already renders every turn with `turnText`, and taking
 * that same output means the membership test downstream is an **equality test between
 * two applications of one function**. An index would be equal only if the flattening
 * order were agreed in two places; a string is equal or it is not.
 *
 * Returns `[]` when the instance carries no usable annotation -- no session ids, no
 * answer ids, or an empty answer list. The caller turns that into an absent field
 * rather than an empty one, so "the dataset named no evidence" never renders as "the
 * dataset's evidence was all missed".
 */
function goldTurnsOf(inst: LongMemEvalInstance, sessions: readonly string[][]): string[] {
  const ids = inst.haystack_session_ids;
  const answerIds = inst.answer_session_ids;
  if (ids === undefined || answerIds === undefined || answerIds.length === 0) return [];

  const wanted = new Set(answerIds);
  const out: string[] = [];
  // Iterated over `sessions` rather than over `ids` so the two stay index-aligned by
  // construction: both come from the same instance and both are the haystack.
  sessions.forEach((turns, index) => {
    if (wanted.has(ids[index]!)) out.push(...turns);
  });
  return out;
}

export function loadLongMemEval(instances: readonly LongMemEvalInstance[]): BenchmarkDataset {
  const questions: Question[] = instances.map((inst) => {
    const sessions = sessionsToContext(inst.haystack_sessions, inst.haystack_dates);
    const goldTurns = goldTurnsOf(inst, sessions);
    return {
      id: inst.question_id,
      capability: toCapability(inst.question_id, inst.question_type),
      questionType: inst.question_type,
      question: inst.question,
      // The raw dataset stores numeric answers as JSON numbers, not strings;
      // normalize them so `expected` always matches its `string | null` type and
      // downstream comparison never receives a non-string.
      expected: inst.question_id.endsWith('_abs') ? null : String(inst.answer),
      context: sessions.flat(),
      sessions,
      ...(inst.question_date !== undefined ? { questionDate: inst.question_date } : {}),
      // Absent rather than empty when the dataset names no evidence: see
      // `Question.goldTurns` for why the two are different claims.
      ...(goldTurns.length === 0 ? {} : { goldTurns }),
    };
  });
  return { name: 'longmemeval', questions };
}

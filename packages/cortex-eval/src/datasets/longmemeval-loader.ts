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

export function loadLongMemEval(instances: readonly LongMemEvalInstance[]): BenchmarkDataset {
  const questions: Question[] = instances.map((inst) => {
    const sessions = sessionsToContext(inst.haystack_sessions, inst.haystack_dates);
    return {
      id: inst.question_id,
      capability: toCapability(inst.question_id, inst.question_type),
      question: inst.question,
      expected: inst.question_id.endsWith('_abs') ? null : inst.answer,
      context: sessions.flat(),
      sessions,
      ...(inst.question_date !== undefined ? { questionDate: inst.question_date } : {}),
    };
  });
  return { name: 'longmemeval', questions };
}

/**
 * LLM-based answer-equivalence judge. Exact string matching fails for natural
 * language answers ("May 2023" vs "2023-05"), so LongMemEval-style benchmarks
 * grade with a judge LLM instead. The judge is deterministic (temperature 0) and
 * its verdicts are cached by prompt, since the same (question, predicted,
 * expected) triple recurs across ablation runs and systems.
 */
import type { LLM } from '@agentix-e/cortex-core';

export type AnswerJudge = (
  question: string,
  predicted: string,
  expected: string,
) => Promise<boolean>;

const judgeCache = new Map<string, boolean>();

/** Clear the shared judge-verdict cache (used by tests and long-running processes). */
export function clearJudgeCache(): void {
  judgeCache.clear();
}

/** Build the judge prompt for a single answer-equivalence decision. */
export function buildJudgePrompt(question: string, predicted: string, expected: string): string {
  return [
    'You are grading a reading-comprehension benchmark.',
    'Decide whether the predicted answer is semantically equivalent to the ground-truth answer.',
    '',
    `Question: ${question}`,
    `Ground-truth answer: ${expected}`,
    `Predicted answer: ${predicted}`,
    '',
    'Respond with exactly YES or NO.',
  ].join('\n');
}

/** Parse the judge response into a boolean; defaults to false on ambiguity. */
export function parseJudgeResponse(raw: string): boolean {
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.startsWith('YES')) {
    return true;
  }
  if (trimmed.startsWith('NO')) {
    return false;
  }
  // Tolerate numeric encodings used by some judge models.
  if (trimmed === '1' || trimmed === 'TRUE') {
    return true;
  }
  if (trimmed === '0' || trimmed === 'FALSE') {
    return false;
  }
  return false;
}

/** Create a deterministic, cached LLM judge. */
export function createLlmJudge(llm: LLM): AnswerJudge {
  return async (question, predicted, expected) => {
    const prompt = buildJudgePrompt(question, predicted, expected);
    const cached = judgeCache.get(prompt);
    if (cached !== undefined) {
      return cached;
    }
    const raw = await llm.complete(prompt, { temperature: 0 });
    const verdict = parseJudgeResponse(raw);
    judgeCache.set(prompt, verdict);
    return verdict;
  };
}

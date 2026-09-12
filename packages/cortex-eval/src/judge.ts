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
  /**
   * Optional judge template selector. Callers that omit it get the default
   * template, preserving the previous behaviour for any existing caller.
   */
  questionType?: JudgeQuestionType,
) => Promise<boolean>;

const judgeCache = new Map<string, boolean>();

/** Clear the shared judge-verdict cache (used by tests and long-running processes). */
export function clearJudgeCache(): void {
  judgeCache.clear();
}

/**
 * Which official grading template a question is judged under.
 *
 * The published LongMemEval protocol (`evaluate_qa.py`, Wu et al. 2025) does not
 * grade every question with one prompt: it dispatches by question type, and the
 * templates differ in ways that change individual verdicts. Grading everything
 * with a single "is the prediction semantically equivalent to the gold" question
 * is strictly harsher than the published protocol, so accuracy measured that way
 * is not comparable to published LongMemEval numbers.
 */
export type JudgeQuestionType =
  'default' | 'temporal-reasoning' | 'knowledge-update' | 'abstention';

/**
 * Map a dataset `question_type` onto the grading template the official protocol
 * uses for it.
 *
 * `single-session-assistant` shares the default template; `temporal-reasoning`
 * and `knowledge-update` get their own; everything multi-session or preference
 * falls back to the default. A question whose id marks it as abstention is
 * graded by the abstention template regardless of its nominal type, because the
 * dataset appends `_abs` to questions sampled from any category.
 */
export function toJudgeQuestionType(
  datasetQuestionType: string,
  isAbstention: boolean = false,
): JudgeQuestionType {
  if (isAbstention || datasetQuestionType.endsWith('_abs')) {
    return 'abstention';
  }
  if (datasetQuestionType === 'temporal-reasoning') {
    return 'temporal-reasoning';
  }
  if (datasetQuestionType === 'knowledge-update') {
    return 'knowledge-update';
  }
  return 'default';
}

/**
 * The official default template, used for single-session and multi-session
 * questions. It credits a response that CONTAINS the gold answer and one that
 * carries all the intermediate steps, while still rejecting a strict subset —
 * the tension is deliberate in the published prompt and is preserved here.
 */
function defaultTemplate(question: string, predicted: string, expected: string): string {
  return [
    'I will give you a question, a correct answer, and a response from a model.',
    'Please answer yes if the response contains the correct answer. Otherwise, answer no.',
    'If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes.',
    'If the response only contains a subset of the information required by the answer, answer no.',
    '',
    `Question: ${question}`,
    `Correct Answer: ${expected}`,
    `Model Response: ${predicted}`,
    '',
    'Is the model response correct? Answer yes or no only.',
  ].join('\n');
}

/**
 * The official temporal template: the default criteria plus an explicit
 * off-by-one tolerance for day/week/month counts. LongMemEval contains several
 * questions whose gold admits two adjacent day counts, so grading them for exact
 * equivalence rejects answers the dataset itself sanctions.
 */
function temporalTemplate(question: string, predicted: string, expected: string): string {
  return [
    'I will give you a question, a correct answer, and a response from a model.',
    'Please answer yes if the response contains the correct answer. Otherwise, answer no.',
    'If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes.',
    'If the response only contains a subset of the information required by the answer, answer no.',
    'In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model response is still correct.',
    '',
    `Question: ${question}`,
    `Correct Answer: ${expected}`,
    `Model Response: ${predicted}`,
    '',
    'Is the model response correct? Answer yes or no only.',
  ].join('\n');
}

/**
 * The official knowledge-update template: the default criteria with the subset
 * clause replaced, so a response that states the updated answer alongside
 * superseded information is still correct. Within a long conversation a user
 * revises facts, and the older value is legitimately in the retrieved context.
 */
function knowledgeUpdateTemplate(question: string, predicted: string, expected: string): string {
  return [
    'I will give you a question, a correct answer, and a response from a model.',
    'Please answer yes if the response contains the correct answer. Otherwise, answer no.',
    'If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.',
    '',
    `Question: ${question}`,
    `Correct Answer: ${expected}`,
    `Model Response: ${predicted}`,
    '',
    'Is the model response correct? Answer yes or no only.',
  ].join('\n');
}

/**
 * The official abstention template: grade whether the model recognised that the
 * question cannot be answered, against an explanation of why, rather than
 * against a gold answer. The expected value holds that explanation, so it is
 * presented as one; asking whether a null answer is "semantically equivalent" to
 * a sentence answers a different question and happens to agree only because the
 * parser reads a bare abstention token.
 */
function abstentionTemplate(question: string, predicted: string, expected: string): string {
  return [
    'I will give you an unanswerable question, an explanation, and a response from a model.',
    'Please answer yes if the model correctly identifies the question as unanswerable.',
    'The model could say that the information is incomplete, or some other information is given but the asked information is not.',
    '',
    `Question: ${question}`,
    `Explanation: ${expected}`,
    `Model Response: ${predicted}`,
    '',
    'Does the model correctly identify the question as unanswerable? Answer yes or no only.',
  ].join('\n');
}

/**
 * Build the judge prompt for a single answer-equivalence decision under the
 * official LongMemEval protocol for the given question type.
 */
export function buildJudgePrompt(
  question: string,
  predicted: string,
  expected: string,
  type: JudgeQuestionType = 'default',
): string {
  switch (type) {
    case 'temporal-reasoning':
      return temporalTemplate(question, predicted, expected);
    case 'knowledge-update':
      return knowledgeUpdateTemplate(question, predicted, expected);
    case 'abstention':
      return abstentionTemplate(question, predicted, expected);
    case 'default':
      return defaultTemplate(question, predicted, expected);
  }
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
  return async (question, predicted, expected, type = 'default') => {
    const prompt = buildJudgePrompt(question, predicted, expected, type);
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

/**
 * The reading stage: one prompt, one reader, every provider.
 *
 * ## Why the harness needs its own reader rather than the arm's
 *
 * `natural-language-memory.ts` owns the production reader — the prompt the memory arm answers through, with its
 * abstention tokens, its candidate-discrimination clause and its per-route variants. That prompt is a **product
 * asset**, tuned against one route, and using it to read a competitor's hits would measure the tuning as much as
 * the retrieval.
 *
 * So this is a separate, deliberately plain prompt: the official Chain-of-Note shape (extract silently, reason,
 * answer with the phrase only), the same abstention phrase list the judge's abstention template accepts, and no
 * route-specific instructions. Every provider on the table is read through this one function, which is what makes
 * two `accuracy` cells subtractable — the reader is a constant, so a difference is retrieval.
 *
 * ## Why it is a function of the hits and not of the provider
 *
 * The contract in `competitor.ts` says a provider returns text and the harness answers. That boundary is what
 * keeps the reader from becoming a per-system variable, and it is why nothing here knows whether the text came
 * from Cortex, a lexical index or a vector store.
 *
 * ## What it is not
 *
 * ## Why only the factory is exported
 *
 * `buildReaderPrompt`, `renderHits` and the refusal phrase are module-internal. A caller reaching for them would
 * be assembling a second reader, which is the one thing this module exists to prevent, and the tests reach them
 * the way a real caller does — through the factory and a recording model — rather than by widening the surface
 * for a test's convenience.
 *
 * It is not the published `con-separate` reading method, which asks for the notes in a first request and the
 * answer in a second. One request costs half as much and is the shape the official repository calls `con`. A run
 * that needs the two-request variant has to add it here and say so in its configuration, because the two produce
 * different answers on the same context.
 */

import type { LLM } from '@agentix-e/cortex-core';
import type { SearchHit } from './competitor.js';
import type { Question } from './types.js';

/** The phrase the reader emits when the context holds no answer. */
const READER_ABSTAIN = "I don't know";

/**
 * Render retrieved hits as numbered blocks, oldest first.
 *
 * Numbered because the chain-of-note step refers to turns by index in its reasoning, and dated because temporal
 * and knowledge-update questions cannot be answered without knowing which block is later. `at` is optional on a
 * hit, so a provider that carries no timestamp produces blocks without one — that difference is the provider's,
 * and printing it is how a reader notices.
 */
function renderHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return '(no memory retrieved)';
  return hits
    .map((hit, index) => {
      const when = hit.at === undefined ? '' : ` (${new Date(hit.at).toISOString().slice(0, 10)})`;
      return `[${index + 1}]${when} ${hit.text}`;
    })
    .join('\n\n');
}

/**
 * The reading prompt.
 *
 * Three steps, and the first one is explicitly silent: a model that writes its notes into the answer channel
 * fails the judge's "answer phrase only" expectation, which the production prompt in
 * `natural-language-memory.ts` documents as a measured failure ("the model writing out its Step 1 notes and never
 * reaching the answer").
 *
 * The recency rule is stated because LongMemEval's knowledge-update family is built on it: the same attribute has
 * an old value and a new one, both are in the context, and the question asks for the current one.
 */
function buildReaderPrompt(
  question: string,
  hits: readonly SearchHit[],
  questionDate?: string,
): string {
  return [
    'You are answering a question from retrieved conversation memory.',
    '',
    'Step 1 — Silently identify the memory blocks that bear on the question. Do not write them out.',
    'Step 2 — Reason over them silently. When two blocks give different values for the same attribute, the later',
    'one is the current value.',
    'Step 3 — Output ONLY the answer phrase (a word, a name, a number, or a short phrase), with no explanation.',
    `If the memory contains no answer at all, output exactly "${READER_ABSTAIN}".`,
    ...(questionDate === undefined ? [] : ['', `The question is asked on ${questionDate}.`]),
    '',
    'RETRIEVED MEMORY:',
    renderHits(hits),
    '',
    `QUESTION: ${question}`,
    '',
    'Step 3:',
  ].join('\n');
}

/** The reader the harness calls. One per run, not one per provider. */
type ProviderReader = (question: Question, hits: readonly SearchHit[]) => Promise<string>;

/**
 * Wrap a model as the reading stage.
 *
 * Temperature is the caller's, and `llm-factory` already pins it from the environment; this function does not
 * override it, because a run that says temperature 0 in its configuration and samples at 0.7 would be an
 * artifact describing a run that did not happen.
 *
 * The reply is trimmed and its `Step 3:` echo removed: a model that repeats the label would otherwise be graded
 * on a string that begins with "Step 3:" and could be matched against a gold answer that happens to contain it.
 */
export function createProviderReader(llm: LLM): ProviderReader {
  return async (question, hits) => {
    const raw = await llm.complete(
      buildReaderPrompt(question.question, hits, question.questionDate),
    );
    return stripStepLabel(raw).trim();
  };
}

/** Remove a leading `Step 3:` label, which some models echo even when told not to. */
function stripStepLabel(reply: string): string {
  return reply.replace(/^\s*step\s*3\s*[:：-]\s*/i, '');
}

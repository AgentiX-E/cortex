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
import type { Capability, Question } from './types.js';

/**
 * Which prompt the reading stage uses.
 *
 * Two arms, and the difference is one thing: `dispatch` adds a per-capability clause and states the order the
 * blocks are in. Everything else — the three steps, the refusal phrase, the memory, the question — is identical,
 * so a difference between the two is the clause and not the prompt.
 *
 * `con` is the control. It is what the first accuracy reading was taken with, and keeping it as a mode is what
 * lets a later run say "the clause is worth N points" instead of comparing two prompts that differ in four ways.
 */
type ReaderMode = 'con' | 'dispatch';

/**
 * The per-capability clause, and why each one is there.
 *
 * The first accuracy reading answered 11 of 20 temporal questions whose evidence had been retrieved 20 of 20
 * times. Three published lines of work say why, and all three point at the same omission: the prompt said nothing
 * about dates, nothing about arithmetic, and nothing about the order the blocks arrived in.
 *
 * - **TReMu** (temporal reasoning for memory agents) reports GPT-4o moving from 29.8% to 77.7% on a 600-question
 *   temporal set when date arithmetic is executed rather than narrated, against 61.7% for plain chain-of-thought.
 *   We cannot call a tool from here, so the clause asks for the two dates and the subtraction to be written down —
 *   the part of that result which is a prompt rather than an executor.
 * - **MemFlow** uses the same shape as a three-step protocol: name both dates with a quote from the context, then
 *   compute, then answer. Its conflict-resolution prompt carries a second rule: when values conflict, the
 *   chronologically latest one wins.
 * - **Test of Time** reports that telling the model the order of its evidence, and ordering it chronologically, is
 *   worth double-digit accuracy points at zero cost. Our blocks arrive in *relevance* order, so the honest version
 *   is to say so and let the model rebuild the timeline from the dates — reordering them would trade the ranking
 *   retrieval produced for a guess about which order the reader prefers.
 */
function capabilityClause(capability: Capability | undefined): readonly string[] {
  const order =
    'The memory blocks are ordered by relevance to the question, NOT chronologically. Use their dates to establish the order of events.';
  switch (capability) {
    case 'TR':
      return [
        order,
        'For every block that mentions an event the question refers to, write its date in YYYY-MM-DD form and quote the phrase you took it from.',
        'Then do the arithmetic the question asks for (a difference in days, weeks or months, or an ordering) one step at a time, and answer with the result. Do not estimate an interval you can read off two dates.',
      ];
    case 'KU':
      return [
        order,
        'The same attribute may appear with more than one value. Write each distinct value with the date it was stated, then answer with the value from the latest date.',
      ];
    case 'MR':
      return [
        order,
        'The answer may need evidence from more than one conversation. Collect every block that bears on the question before answering, and do not stop at the first one that looks relevant.',
      ];
    case 'ABS':
      return [
        'Answering "I don\'t know" is correct when the memory holds nothing that answers the question. Do not invent a plausible value to avoid refusing.',
      ];
    default:
      return [order];
  }
}

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
  mode: ReaderMode = 'con',
  capability?: Capability,
): string {
  // The `dispatch` clause is inserted between the shared steps and the memory, so both arms send the identical
  // three steps, refusal phrase, date line, memory and question. One variable, in one place.
  const clause = mode === 'dispatch' ? capabilityClause(capability) : [];
  return [
    'You are answering a question from retrieved conversation memory.',
    '',
    'Step 1 — Silently identify the memory blocks that bear on the question. Do not write them out.',
    'Step 2 — Reason over them silently. When two blocks give different values for the same attribute, the later',
    'one is the current value.',
    'Step 3 — Output ONLY the answer phrase (a word, a name, a number, or a short phrase), with no explanation.',
    `If the memory contains no answer at all, output exactly "${READER_ABSTAIN}".`,
    ...(clause.length === 0 ? [] : ['', ...clause]),
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
export function createProviderReader(llm: LLM, mode: ReaderMode = 'con'): ProviderReader {
  return async (question, hits) => {
    const raw = await llm.complete(
      buildReaderPrompt(question.question, hits, question.questionDate, mode, question.capability),
    );
    return stripStepLabel(raw).trim();
  };
}

/** Remove a leading `Step 3:` label, which some models echo even when told not to. */
function stripStepLabel(reply: string): string {
  return reply.replace(/^\s*step\s*3\s*[:：-]\s*/i, '');
}

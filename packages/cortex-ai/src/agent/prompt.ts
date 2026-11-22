/**
 * The one prompt the reader answers between retrievals.
 *
 * ## What it deliberately does not contain
 *
 * The evidence. The reader is shown a **digest** -- one id and a prefix of each of the turns held
 * so far -- because the whole cost argument for a second step is that the deciding call is cheap
 * and the answering call is the expensive one. Handing the deciding call the full evidence would
 * bill the corpus twice to decide whether to read it, and the second read is the one that matters.
 *
 * The digest is also why the mechanism is testable at all: `promptChars` in the trace is a fact
 * about this function's output, so "a two-step run cost 1.4 times a one-step run" is arithmetic
 * over the artifact rather than an estimate.
 *
 * ## Why the instruction is one JSON object and not a tool-call schema
 *
 * Because the contract has to hold for a model that does not support tool calling. A weak model
 * with `response_format: json_object` and three literal shapes is the widest compatibility this
 * repository can promise, and §14.98.5's acceptance is stated on the same arm for both. A
 * reasoning model is held to the same three shapes, which is what makes the two comparable.
 */
import type { JsonSchema } from '@agentix-e/cortex-core';

import type { Retrieval } from './types.js';

/** Whitespace normalised and cut to `chars`, with an ellipsis when anything was dropped. */
function prefix(text: string, chars: number): string {
  // Newlines are the one character that would break the one-line-per-turn shape a reader parses
  // positionally; every other whitespace run collapses to a single space.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= chars) return flat;
  return `${flat.slice(0, chars).trimEnd()}…`;
}

export type DecisionPromptInput = {
  readonly question: string;
  /** Header text for the evidence, so a caller can name what the corpus is. */
  readonly held: readonly number[];
  readonly retrieval: Pick<Retrieval, 'read' | 'turns'>;
  readonly digestChars: number;
  readonly digestTurns: number;
  /** Decisions this reader may still make, this one included. */
  readonly remaining: number;
};

/**
 * The three actions, spelled once so the prompt and the parser cannot drift apart.
 *
 * Typed as `JsonSchema` rather than declared with `as const`, because the provider adapter forwards
 * it as `response_format: json_object` and a `readonly` tuple in `required` would not satisfy the
 * interface the adapter accepts. The schema never reaches the model as text -- `complete` puts it in
 * the request body only -- so it costs no prompt tokens.
 */
export const DECISION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'one of: search, session, answer' },
    query: { type: 'string', description: 'words to look for, required when action is search' },
    turn: {
      type: 'number',
      description: 'a turn id from the evidence, required when action is session',
    },
  },
  required: ['action'],
};

export function buildDecisionPrompt(input: DecisionPromptInput): string {
  const { held, retrieval } = input;
  // The most recently added turns, because they are what the next decision is about: a reader that
  // has just opened a session needs to see it, and the seed is still summarised by whatever of it
  // falls in the window. Truncating the tail instead would hide the newest evidence on exactly the
  // step that produced it.
  const shown = held.slice(Math.max(0, held.length - input.digestTurns));
  const lines = shown.flatMap((id) => {
    const text = retrieval.read(id);
    return text === undefined ? [] : [`[${String(id)}] ${prefix(text, input.digestChars)}`];
  });
  const omitted = held.length - shown.length;
  const block =
    lines.length === 0
      ? 'EVIDENCE IN HAND: nothing yet.'
      : [
          `EVIDENCE IN HAND (${String(held.length)} of ${String(retrieval.turns)} turns` +
            `${omitted > 0 ? `, the ${String(shown.length)} most recent shown` : ''}):`,
          ...lines,
        ].join('\n');

  return [
    'You are gathering evidence for one question before it is answered.',
    '',
    'QUESTION:',
    input.question,
    '',
    block,
    '',
    'Reply with exactly one JSON object and nothing else:',
    '  {"action":"search","query":"<words the conversation would contain>"}  look for more turns',
    '  {"action":"session","turn":<id>}                                     read the conversation around one turn above',
    '  {"action":"answer"}                                                  the evidence above is enough',
    '',
    'The query is matched word by word against the corpus, so put in it the names, amounts and',
    'dates the answer would be written next to, not a sentence. Do not repeat a query you have',
    'already used. If the question is about one event, one search is usually enough.',
    `You may take ${String(input.remaining)} more action(s), this one included.`,
  ].join('\n');
}

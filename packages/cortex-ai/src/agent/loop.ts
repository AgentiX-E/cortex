/**
 * The loop: retrieve, ask the reader what to look for next, retrieve again, stop.
 *
 * ## The mechanism, in one sentence
 *
 * §14.97.8 measured that the reference pipeline's contract works in the reference pipeline and
 * costs 3.75 questions here, and concluded that the contract and the selection that feeds it are
 * one mechanism: a reader enumerating a list it did not build enumerates it worse. This file makes
 * the reader build the list. Its queries are the selection, its `answer` verdict is the stop, and
 * the evidence it chose goes to the same renderer the registered arm uses (`compose.ts`).
 *
 * ## Why the seed is free and the loop is the experiment
 *
 * `maxSteps: 0` performs the seed retrieval and no model call: `selected` is what
 * `SearchIndex.search(question, k)` returned, in its order. That is not a degenerate case to be
 * tolerated, it is the control -- §14.98.5 makes "turns the mechanism off and reproduces the
 * registered arm question for question" a precondition of dispatching the mechanism on, and the
 * only way to state that as a property is for the off state to be this same code path.
 *
 * ## Termination
 *
 * Every iteration adds at least one character to `promptChars`, `promptChars` is compared against a
 * finite budget, and `calls` is compared against `maxSteps`. Either bound ends the loop even if the
 * reader keeps asking for searches and every search keeps returning new turns. `no-new-evidence`
 * and `corpus-exhausted` end it earlier in the cases they describe. There is no path in which a
 * misbehaving reader can hold the loop open, which matters because the loop is billed per call.
 *
 * ## What it does not do
 *
 * It does not answer. The reader here decides *what to read*; the answer prompt is composed
 * afterwards by `composeAgentPrompt`, through `cortex-memory`'s builder, with the contract and
 * rendering the caller named. A loop that wrote its own answer prompt would be a second rendering
 * path and every number taken through it would be incomparable with every number already taken.
 */
import type { AgentResult, AgentStep, Decision, StepwiseOptions, StopReason } from './types.js';

import { parseDecision } from './parse.js';
import { DECISION_SCHEMA, buildDecisionPrompt, type DecisionPromptInput } from './prompt.js';
import { decideStop, type StopInput } from './stop.js';
import { selectedOrder } from './trace.js';

/**
 * A positive integer, refused with a message rather than clamped into silence.
 *
 * Refused because every one of these numbers is a bound on a bill: a `k` of zero ranks nothing and
 * reports a working mechanism that found no evidence, and a NaN budget compares false against every
 * total and therefore never stops. A wrongly configured loop has to fail where it was configured.
 */
function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}.`);
  }
  return value;
}

export async function retrieveStepwise(
  question: string,
  options: StepwiseOptions,
): Promise<AgentResult> {
  const retrieval = options.retrieval;
  // Zero is legal here and is the control arm; a negative or fractional one is not a budget.
  const maxSteps = options.maxSteps ?? 2;
  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new Error(
      `StepwiseOptions.maxSteps must be a non-negative integer, got ${String(maxSteps)}.`,
    );
  }
  const k = positiveInteger('StepwiseOptions.k', options.k ?? 16);
  const digestChars = positiveInteger('StepwiseOptions.digestChars', options.digestChars ?? 200);
  const digestTurns = positiveInteger('StepwiseOptions.digestTurns', options.digestTurns ?? 32);
  const budgetChars = positiveInteger('StepwiseOptions.budgetChars', options.budgetChars ?? 40_000);
  const decisionTokens = positiveInteger(
    'StepwiseOptions.decisionTokens',
    options.decisionTokens ?? 512,
  );

  const held = new Set<number>();
  const steps: AgentStep[] = [];
  let promptChars = 0;
  let calls = 0;
  let queries = 0;

  /**
   * Take the ids a tool returned, reporting which of them were new.
   *
   * The two lists are reported rather than a count, because "the second search found nothing" and
   * "the second search found only what the first one did" are the same number and different facts,
   * and only the second one says the reader is repeating itself.
   */
  const absorb = (hits: readonly number[]): { added: number[]; repeated: number[] } => {
    const added: number[] = [];
    const repeated: number[] = [];
    for (const id of hits) {
      if (held.has(id)) {
        repeated.push(id);
        continue;
      }
      held.add(id);
      added.push(id);
    }
    return { added, repeated };
  };

  const seedHits = (await retrieval.search(question, k)).map((hit) => hit.turn);
  const seed = absorb(seedHits);
  const seedStep: AgentStep = {
    step: 0,
    action: 'seed',
    // The seed query is the question itself, recorded so a trace can be replayed without the
    // caller's code: `queries` below counts only the searches a reader wrote, which is the number
    // that says whether the mechanism was exercised at all.
    query: question,
    hits: seedHits,
    added: seed.added,
    repeated: seed.repeated,
    promptChars: 0,
    note: null,
  };
  steps.push(seedStep);

  const stopInput = (last: AgentStep): StopInput => ({
    calls,
    maxSteps,
    action: last.action,
    query: last.query,
    added: last.added.length,
    held: held.size,
    corpusTurns: retrieval.turns,
    promptChars,
    budgetChars,
    note: last.note,
  });

  let stop: StopReason | null = decideStop(stopInput(seedStep));

  while (stop === null) {
    const promptInput: DecisionPromptInput = {
      question,
      held: [...held],
      retrieval,
      digestChars,
      digestTurns,
      remaining: maxSteps - calls,
    };
    const prompt = buildDecisionPrompt(promptInput);
    // Counted before the call, because a call that throws was still a request the provider can
    // bill, and a budget that only counted successful calls would under-report the bill by exactly
    // the calls that failed.
    promptChars += prompt.length;

    let decision: Decision;
    try {
      const raw = await options.llm.complete(prompt, {
        // Zero temperature: the loop's output is a decision, and two dispatches of the same
        // mechanism should differ because the questions differ, not because the sampler moved.
        temperature: 0,
        maxTokens: decisionTokens,
        schema: DECISION_SCHEMA,
      });
      decision = parseDecision(raw);
    } catch (error) {
      decision = {
        action: 'unparsed',
        reason: `llm: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    calls += 1;

    let step: AgentStep;
    if (decision.action === 'search' && decision.query !== '') {
      // A search for the empty string is not sent: most indexes would return the head of the
      // corpus, which is evidence no reader asked for, and the stop rule reports `empty-query`.
      queries += 1;
      const hits = (await retrieval.search(decision.query, k)).map((hit) => hit.turn);
      const { added, repeated } = absorb(hits);
      step = {
        step: steps.length,
        action: 'search',
        query: decision.query,
        hits,
        added,
        repeated,
        promptChars: 0,
        note: null,
      };
    } else if (decision.action === 'session') {
      const hits = retrieval.session(decision.turn);
      const { added, repeated } = absorb(hits);
      step = {
        step: steps.length,
        action: 'session',
        query: null,
        hits,
        added,
        repeated,
        promptChars: 0,
        note: null,
      };
    } else if (decision.action === 'search') {
      step = {
        step: steps.length,
        action: 'search',
        query: decision.query,
        hits: [],
        added: [],
        repeated: [],
        promptChars: 0,
        note: null,
      };
    } else if (decision.action === 'answer') {
      step = {
        step: steps.length,
        action: 'answer',
        query: null,
        hits: [],
        added: [],
        repeated: [],
        promptChars: 0,
        note: null,
      };
    } else {
      step = {
        step: steps.length,
        action: 'unparsed',
        query: null,
        hits: [],
        added: [],
        repeated: [],
        promptChars: 0,
        note: decision.reason,
      };
    }
    // The prompt that produced this step is charged to this step, so a reader can attribute the
    // bill to the decision it bought rather than to the loop as a whole.
    step = { ...step, promptChars: prompt.length };
    steps.push(step);
    stop = decideStop(stopInput(step));
  }

  const selected = selectedOrder(steps);
  return {
    trace: {
      steps,
      stop,
      calls,
      queries,
      promptChars,
      selected,
      corpusTurns: retrieval.turns,
    },
    selected,
  };
}

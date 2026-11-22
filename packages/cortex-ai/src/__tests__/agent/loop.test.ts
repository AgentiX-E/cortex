/**
 * The loop.
 *
 * ## What these assert, and what they deliberately do not
 *
 * They assert the **mechanism's accounting**: how many calls a configuration costs, what each step
 * bought, what the selected order is a function of, and which stop reason a given reader behaviour
 * produces. They do not assert that the mechanism improves accuracy -- that is a dispatch, and the
 * pre-registration in §14.98.5 names the criterion it will be read against. A unit test that
 * claimed an accuracy effect would be the exact failure the campaign has been paying for: a number
 * from a harness nobody can reproduce.
 *
 * The one thing these do assert about quality is the same thing §14.98.5 makes a precondition:
 * `maxSteps: 0` performs no model call, returns the seed retrieval unchanged, and therefore cannot
 * differ from the registered arm. That is the condition under which turning the mechanism on is a
 * comparison rather than a new system.
 */
import { describe, expect, it } from 'vitest';

import { retrieveStepwise } from '../../agent/loop.js';

import { FailingLlm, ScriptedLlm, scriptedRetrieval } from './fixtures.js';

const QUESTION = 'How much did the charity run raise?';

const TURNS = [
  'I adopted a dog named Biscuit in March.',
  'Biscuit needs a dental cleaning next month.',
  'My sister moved to Lisbon last spring.',
  'I ran the charity ten kilometre race in fifty two minutes.',
  'The race raised money for the animal shelter.',
  'I am training for a half marathon in October.',
];

const SEED = [3, 4];

describe('retrieveStepwise', () => {
  it('is a single retrieval when maxSteps is zero, and costs nothing', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED });
    const llm = new ScriptedLlm([]);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm, maxSteps: 0 });

    expect(llm.prompts).toEqual([]);
    expect(result.trace.calls).toBe(0);
    expect(result.trace.promptChars).toBe(0);
    expect(result.trace.steps).toHaveLength(1);
    expect(result.trace.steps[0]?.action).toBe('seed');
    expect(result.trace.stop).toBe('step-limit');
    // The seed is the question, so the registered arm's retrieval is what this reproduces.
    expect(retrieval.searches).toEqual([QUESTION]);
    expect(result.selected).toEqual(SEED);
  });

  it('lets the reader search once and then stop', async () => {
    const retrieval = scriptedRetrieval(TURNS, {
      [QUESTION]: SEED,
      Biscuit: [0, 1],
    });
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}', '{"action":"answer"}']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    expect(result.trace.calls).toBe(2);
    expect(result.trace.queries).toBe(1);
    expect(result.trace.stop).toBe('answered');
    expect(result.trace.steps.map((step) => step.action)).toEqual(['seed', 'search', 'answer']);
    // The order is the order the evidence was put in front of the reader: the seed's, then the
    // search's, in the tool's own order.
    expect(result.selected).toEqual([3, 4, 0, 1]);
    expect(result.trace.selected).toEqual(result.selected);
  });

  it('bounds each search by k, so a step cannot buy the corpus', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: [], Biscuit: [0, 1, 2] });
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}', '{"action":"answer"}']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm, k: 1 });

    expect(result.trace.steps[1]?.hits).toEqual([0]);
    expect(result.trace.steps[1]?.added).toEqual([0]);
  });

  it('stops when a search only reaches evidence it already holds', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED, race: SEED });
    const llm = new ScriptedLlm(['{"action":"search","query":"race"}']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    expect(result.trace.stop).toBe('no-new-evidence');
    expect(result.trace.steps[1]?.repeated).toEqual(SEED);
    expect(result.trace.steps[1]?.added).toEqual([]);
    // One call: the second was refused by the stop rule rather than spent.
    expect(result.trace.calls).toBe(1);
  });

  it('opens the conversation around a turn when the reader asks for one', async () => {
    const retrieval = scriptedRetrieval(
      TURNS,
      { [QUESTION]: [3] },
      { sessionOf: [0, 0, 1, 1, 2, 2] },
    );
    const llm = new ScriptedLlm(['{"action":"session","turn":3}', '{"action":"answer"}']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    expect(result.trace.steps[1]?.action).toBe('session');
    expect(result.trace.steps[1]?.hits).toEqual([2, 3]);
    expect(result.trace.steps[1]?.added).toEqual([2]);
    expect(result.selected).toEqual([3, 2]);
    expect(result.trace.stop).toBe('answered');
  });

  it('stops on a blank query without spending a search', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED });
    const llm = new ScriptedLlm(['{"action":"search","query":"   "}']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    expect(result.trace.stop).toBe('empty-query');
    // Only the seed reached the index: an empty query would have returned the corpus head.
    expect(retrieval.searches).toEqual([QUESTION]);
    expect(result.trace.queries).toBe(0);
  });

  it('keeps the evidence and reports the provider failure when a call throws', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED });
    const llm = new ScriptedLlm([new Error('boom')]);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    expect(result.trace.stop).toBe('llm-error');
    expect(result.trace.steps[1]?.note).toBe('llm: boom');
    // The failing call was still issued, so it is still charged: a budget that counted only
    // successful calls would under-report the bill by exactly the failed ones.
    expect(result.trace.promptChars).toBeGreaterThan(0);
    expect(result.trace.calls).toBe(1);
    expect(result.selected).toEqual(SEED);
  });

  it('names a failure that arrived as something other than an Error', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED });
    const result = await retrieveStepwise(QUESTION, {
      retrieval,
      llm: new FailingLlm('socket hang up'),
    });

    expect(result.trace.stop).toBe('llm-error');
    // Without the non-Error arm this reads `llm: undefined`, which is the one thing an artifact must
    // never do: name a failure without saying what it was.
    expect(result.trace.steps[1]?.note).toBe('llm: socket hang up');
  });

  it('reports a reply it cannot read as such, and keeps what it has', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED });
    const llm = new ScriptedLlm(['I would look for the charity race.']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    expect(result.trace.stop).toBe('unparsed');
    expect(result.trace.steps[1]?.note).toBe('not-json');
    expect(result.selected).toEqual(SEED);
  });

  it('stops on the prompt budget before issuing a third call', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED, Biscuit: [0] });
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}', '{"action":"answer"}']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm, budgetChars: 1 });

    expect(result.trace.stop).toBe('budget');
    expect(result.trace.calls).toBe(1);
    expect(llm.prompts).toHaveLength(1);
  });

  it('stops when the seed already holds the whole corpus', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: [0, 1, 2, 3, 4, 5] });
    const llm = new ScriptedLlm([]);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    expect(result.trace.stop).toBe('corpus-exhausted');
    expect(result.trace.calls).toBe(0);
  });

  it('sends the cost controls with every deciding call', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED });
    const llm = new ScriptedLlm(['{"action":"answer"}']);
    await retrieveStepwise(QUESTION, { retrieval, llm, decisionTokens: 64 });

    const opts = llm.options[0];
    // Zero temperature because the loop's output is a decision, and two dispatches should differ
    // because the questions differ.
    expect(opts?.temperature).toBe(0);
    expect(opts?.maxTokens).toBe(64);
    // The schema rides in the request body as `response_format` and is never echoed into the
    // prompt, which is why `promptChars` is the size of what the provider received.
    expect(opts?.schema).toBeDefined();
    expect(llm.prompts[0]).not.toContain('json_schema');
  });

  it('tells the reader how many actions remain, and that number falls', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED, Biscuit: [0] });
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}', '{"action":"answer"}']);
    await retrieveStepwise(QUESTION, { retrieval, llm, maxSteps: 2 });

    expect(llm.prompts[0]).toContain('You may take 2 more action(s)');
    expect(llm.prompts[1]).toContain('You may take 1 more action(s)');
  });

  it('charges the loop exactly the characters it issued', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED, Biscuit: [0] });
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}', '{"action":"answer"}']);
    const result = await retrieveStepwise(QUESTION, { retrieval, llm });

    const issued = llm.prompts.reduce((sum, prompt) => sum + prompt.length, 0);
    expect(result.trace.promptChars).toBe(issued);
    expect(result.trace.steps.reduce((sum, step) => sum + step.promptChars, 0)).toBe(issued);
    expect(result.trace.steps[0]?.promptChars).toBe(0);
  });

  it('refuses a configuration it cannot honour, instead of clamping it', async () => {
    const retrieval = scriptedRetrieval(TURNS, { [QUESTION]: SEED });
    const llm = new ScriptedLlm([]);
    const cases: Parameters<typeof retrieveStepwise>[1][] = [
      { retrieval, llm, maxSteps: -1 },
      { retrieval, llm, maxSteps: 1.5 },
      { retrieval, llm, k: 0 },
      { retrieval, llm, digestChars: 0 },
      { retrieval, llm, digestTurns: 0 },
      { retrieval, llm, budgetChars: 0 },
      { retrieval, llm, decisionTokens: 0 },
    ];
    for (const options of cases) {
      await expect(retrieveStepwise(QUESTION, options)).rejects.toThrow(
        /positive integer|non-negative/,
      );
    }
  });
});

/**
 * The model's own words must survive `parseAnswer`, because `Answer` cannot
 * carry them.
 *
 * ## The defect these tests are written against
 *
 * Dispatch `37792539133` was the first real artifact to carry the per-question
 * roster §57 built. Reading it answered the question §57 unblocked -- and the
 * read came back empty for the one field it was dispatched to read.
 *
 * The roster is populated. `questions` has 120 records, one per sampled
 * question, and `answer` is filled rather than uniformly absent: five records
 * carry a string, the longest of which is a multi-line reply. So the carrier
 * works. What it carries is `Answer`, and `Answer` is `string | null`, so 115
 * of 120 records read `null`.
 *
 * `null` is the right value and it is also all the information there is. It is
 * produced by `parseAnswer`, which recognises a decline **only** from the last
 * non-empty line, after stripping a label like `Answer:` and comparing
 * case-insensitively. Three different model behaviours therefore collapse into
 * the same value:
 *
 *   - the bare token, `INSUFFICIENT_EVIDENCE`
 *   - a labelled token, `Answer: INSUFFICIENT_EVIDENCE`
 *   - an explanation followed by the token, which `parseAnswer` accepts because
 *     only the final line decides
 *
 * The MR route lost 13 baseline-correct questions and the TR route 16 in that
 * run, and every one of them is a `null`. Which of the three shapes produced
 * them cannot be recovered from the artifact, because the text that would say
 * so is a local variable in `#prompt` and is discarded the moment `parseAnswer`
 * returns.
 *
 * ## Why this is the §57 defect one layer down, again
 *
 * §56: the value was computed and never reached the field that needed it.
 * §57: the value was computed and discarded before the report layer saw it.
 * This: the value is computed, **and then irreversibly replaced by its own
 * summary**. `parseAnswer` is a correct function; the defect is that its output
 * was treated as a replacement for its input.
 *
 * ## Why the assertions are on the retained text and not on a new metric
 *
 * The claim under test is narrow and checkable: given an LLM that says a
 * specific thing, that thing can be read back after the call. A test that
 * asserted a *count* of retained outputs would pass on a system that retained
 * the wrong ones, and a test that asserted the presence of a field name would
 * pass on a system that filled it with the parsed value -- which is precisely
 * the state the artifact was in.
 */

import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';

const NOW = 1_759_470_000_000;

/** An LLM that always returns exactly `raw`, recording the prompts it saw. */
function fixedLlm(raw: string, seen: string[] = []): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return raw;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

/**
 * A system whose gates are open, so the model is reached on every route.
 *
 * Both thresholds are stated rather than left to their defaults. The write
 * threshold admits every turn and the retrieval threshold is below the value
 * the function returns, so neither gate can be what answers a question here --
 * the point of these tests is the text after a model call, and a gate that
 * declined first would make every one of them pass or fail for the wrong
 * reason. `abstention-decision.test.ts` records the same discipline: it
 * separates the two thresholds because the `turns.length === 0` guard returns
 * before the retrieval decision is reached, which made an earlier version of
 * its assertion a false pass.
 */
function openSystem(llm: LLM): CortexMemory {
  return new CortexMemory({
    llm,
    now: NOW,
    gate: {
      threshold: 0,
      retrievalThreshold: 0.1,
      sessionBudget: Number.POSITIVE_INFINITY,
      valueFunction: constantValue(0.9),
    },
  });
}

const CONTEXT = ['The user moved to Lisbon in March.'];

describe('the model output is retained, not replaced by its parse', () => {
  it('keeps the bare abstention token readable after the call', async () => {
    const system = openSystem(fixedLlm(ABSTAIN_TOKEN));
    expect(await system.answerAbstention('Where does the user live?', CONTEXT)).toBeNull();
    expect(system.lastRawOutput()).toBe(ABSTAIN_TOKEN);
  });

  it('keeps a labelled decline distinguishable from a bare one', async () => {
    const labelled = `Answer: ${ABSTAIN_TOKEN}`;
    const system = openSystem(fixedLlm(labelled));
    expect(await system.answerAbstention('Where does the user live?', CONTEXT)).toBeNull();
    // Both are `null` to the scorer, and that is correct. The retained text is
    // the only place the two shapes differ, so a reader asking "how did the
    // model decline?" has an answer.
    expect(system.lastRawOutput()).toBe(labelled);
    expect(system.lastRawOutput()).not.toBe(ABSTAIN_TOKEN);
  });

  it('keeps the explanation that precedes a decline, which the parse discards', async () => {
    const explained = ['The evidence does not name a city.', ABSTAIN_TOKEN].join('\n');
    const system = openSystem(fixedLlm(explained));
    expect(await system.answerAbstention('Where does the user live?', CONTEXT)).toBeNull();
    expect(system.lastRawOutput()).toBe(explained);
    expect(system.lastRawOutput()).toContain('does not name a city');
  });

  it('keeps the text of an answer as well, so the field is about the model and not about declines', async () => {
    const system = openSystem(fixedLlm('Lisbon'));
    expect(await system.answerAbstention('Where does the user live?', CONTEXT)).toBe('Lisbon');
    expect(system.lastRawOutput()).toBe('Lisbon');
  });

  it('records nothing when the gate declines, because the model was never asked', async () => {
    // The counterpart to the four above: retention must describe a model call
    // that happened. A machine-derived abstention has no model output, and a
    // field that kept the previous call's text would attribute one question's
    // wording to another's decision.
    const system = openSystem(fixedLlm('Lisbon'));
    await system.answerAbstention('Where does the user live?', CONTEXT);
    const closed = new CortexMemory({
      llm: fixedLlm('unused'),
      now: NOW,
      gate: {
        threshold: 0,
        retrievalThreshold: 0.9,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(0.1),
      },
    });
    expect(await closed.answerAbstention('Where does the user live?', CONTEXT)).toBeNull();
    expect(closed.lastRawOutput()).toBeNull();
  });

  it('records nothing before any call, rather than an empty string that reads as a blank answer', async () => {
    // `''` is an answer in this package's model -- a blank, wrong one -- and not
    // an abstention. A default of `''` would therefore report "no call has
    // happened" in the same shape as "the model answered with nothing".
    const system = openSystem(fixedLlm('Lisbon'));
    expect(system.lastRawOutput()).toBeNull();
  });

  it('retains the output of every route, not only the abstention one', async () => {
    // The loss is measured on MR and TR, which do not go through
    // `answerAbstention` at all. A field written only on the abstention route
    // would record nothing about the questions this work exists to explain.
    const system = openSystem(fixedLlm('Lisbon'));
    await system.answerSessions('Where did the user move?', [['The user moved to Lisbon.']]);
    expect(system.lastRawOutput()).toBe('Lisbon');

    const temporal = openSystem(fixedLlm('March'));
    await temporal.answerTemporal('When did the user move?', CONTEXT, '2024-04-01');
    expect(temporal.lastRawOutput()).toBe('March');
  });
});

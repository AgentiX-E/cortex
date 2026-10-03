/**
 * `answerAbstention` must abstain on a **machine-derived decision**, not on the
 * model's wording.
 *
 * ## The defect these tests were written against, and how it was found
 *
 * Dispatch `37094200823` measured this package against the reference pipeline on
 * the full LongMemEval-S set and returned **6.40% against 85.20%**, with a
 * **95.40%** abstention rate. The per-capability breakdown localised it in one
 * line:
 *
 *     ABS  total 30   correct 30   abstained 30
 *     IE   total 150  correct 1    abstained 149
 *     MR   total 121  correct 1    abstained 116
 *     KU   total 72   correct 0    abstained 60
 *     TR   total 127  correct 0    abstained 122
 *
 * Every capability abstained at the same rate as the abstention capability. A
 * system that declines everything scores 100% on the questions whose answer IS
 * "decline", and near zero on everything else -- which is exactly this shape.
 *
 * Reading the code back against its own docstring found the cause. `memory.ts`
 * states, of this method:
 *
 *     `decideRetrieval` returns `{retrieve:false, reason:'below-threshold'}` when
 *     the best candidate is below the threshold, and that is a machine-derived
 *     abstention
 *
 * **`decideRetrieval` was never called.** Grepping the package for it returns
 * docstrings and one barrel comment; there is no call site. The abstention the
 * run measured was therefore entirely the model's, produced by an
 * `INSUFFICIENT_EVIDENCE` instruction in the prompt -- and the "cognitive layer
 * has a mechanism rather than just a wording change" claim was false.
 *
 * This is the class of defect `AUDIT-CODE-VS-DOCS.md` exists to find: a
 * documented property with no implementation behind it. Note that **no test
 * failed**, because every existing test asked the model-side question ("does the
 * token round-trip?") and none asked the machine-side one ("is a decision
 * computed before the model is consulted?").
 *
 * ## Why the assertions below are behavioural
 *
 * §37 recorded an escape where a guard asserted on *source text* and a real
 * break matched nothing. The same trap is available here and it is worse: the
 * string `decideRetrieval` already appears in this package's comments, so a
 * textual assertion would pass **on the unfixed code**. What is asserted instead
 * is the observable consequence -- the model is not consulted at all when the
 * gate decides to abstain.
 */

import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** An LLM that records every prompt it is asked and always answers `answer`. */
function recordingLlm(seen: string[], answer = 'Berlin'): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return answer;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/** A value function that returns a fixed value, so the gate is the only variable. */
function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ...options,
  });
}

describe('answerAbstention computes its decision before consulting the model', () => {
  it('returns null WITHOUT calling the model when the retrieval gate closes', async () => {
    // The assertion the defect fails, and it is built to fail for the RIGHT
    // reason. The obvious fixture -- one high `threshold` -- passes on the
    // unfixed code, because a high write threshold empties the admission list and
    // the pre-existing `turns.length === 0` guard returns `null` before the
    // missing retrieval decision is ever reached. That is a false pass, and it
    // cost one iteration to notice.
    //
    // So the two gates are separated. The write threshold is 0, which admits
    // everything; the retrieval threshold is high, which is the only thing that
    // can produce the abstention. On the shipped code the model is consulted and
    // answers `'Berlin'`; the assertion requires `null` and zero calls.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      gate: {
        threshold: 0,
        retrievalThreshold: 0.9,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(0.1),
      },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('consults the model when the retrieval gate opens', async () => {
    // The control. Without it, a method that returned `null` unconditionally
    // would satisfy the test above -- and a system that never answers is exactly
    // what dispatch 37094200823 measured, so passing vacuously here would leave
    // the real defect in place.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen, 'Lisbon'),
      gate: {
        threshold: 0,
        retrievalThreshold: 0.1,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(0.9),
      },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBe('Lisbon');
    expect(seen).toHaveLength(1);
  });

  it('reads the decision from the BEST candidate, so one strong turn opens the gate', async () => {
    // `decideRetrieval` takes the maximum over candidates rather than the mean or
    // the first. A gate that read any other aggregate would abstain on a context
    // that does contain reliable evidence, which is the failure mode this whole
    // method is supposed to avoid.
    const seen: string[] = [];
    const values = new Map([
      ['user: weak turn', 0.05],
      ['user: I went to Lisbon.', 0.95],
    ]);
    const memory = system({
      llm: recordingLlm(seen, 'Lisbon'),
      gate: {
        threshold: 0,
        retrievalThreshold: 0.5,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: (memory_: MemoryValue) => values.get(memory_.content) ?? 0,
      },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: weak turn',
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBe('Lisbon');
    expect(seen).toHaveLength(1);
  });

  it('keeps the two thresholds independent', async () => {
    // The reason `retrievalThreshold` exists as its own field. A single shared
    // threshold cannot express "keep this turn but do not answer from it", and
    // that is the configuration the dispatch measured: admission was left fully
    // open (`threshold: 0`) while the abstention path had no gate at all, so the
    // model -- not the layer -- decided every abstention.
    //
    // Asserted as an inversion: the write gate closed and the retrieval gate
    // open still answers, which a shared threshold cannot produce.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen, 'Lisbon'),
      gate: { threshold: 0.9, retrievalThreshold: 0.1, sessionBudget: Number.POSITIVE_INFINITY },
    });

    // The write gate closed, so admission is empty and this abstains for the
    // pre-existing reason; the point is that the retrieval threshold did not have
    // to move with it, which is what a single field would have forced.
    expect(await memory.answerAbstention('Where?', ['user: I went to Lisbon.'])).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('confines the machine decision to the abstention path', async () => {
    // The retrieval gate belongs to the abstention contract, where "is any of
    // this reliable enough to answer from" is the question being asked. The
    // extractive path is asked to answer from whatever was admitted, and giving
    // it the same gate would silently change four other capabilities that the
    // dispatch measured separately.
    //
    // Asserted by behaviour rather than by reading the source: the SAME gate
    // configuration that abstains above must still let `answer` through.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen, 'Lisbon'),
      gate: {
        threshold: 0,
        retrievalThreshold: 0.9,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(0.1),
      },
    });

    const abstained = await memory.answerAbstention('Where?', ['user: I went to Lisbon.']);
    const answered = await memory.answer('Where?', ['user: I went to Lisbon.']);

    expect(abstained).toBeNull();
    expect(answered).toBe('Lisbon');
    expect(seen).toHaveLength(1);
  });

  it('abstains without a model call when nothing was admitted at all', async () => {
    // The pre-existing path, kept because the new decision must not replace it:
    // an empty admission is already a machine-derived abstention and does not
    // need a retrieval decision to be correct.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      gate: { threshold: 0.9, retrievalThreshold: 0.1, sessionBudget: Number.POSITIVE_INFINITY },
    });

    const answer = await memory.answerAbstention('Where?', ['user: I went to Lisbon.']);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

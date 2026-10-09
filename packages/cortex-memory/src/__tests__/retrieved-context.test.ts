/**
 * The system must be able to say **what evidence it was shown**, not only what it
 * answered.
 *
 * ## The gap these tests close
 *
 * §13 measured MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every capability,
 * and the artifact could not say whether the retrieval returned the wrong
 * evidence or returned none. That distinction is the whole of the next
 * hypothesis: "the reader was shown the wrong turn" and "the reader was shown
 * nothing" are repaired in different places, and a run that cannot tell them
 * apart cannot test either.
 *
 * Nothing in the artifact carried it. `QuestionRecord.turns` is `[]` on every
 * record because `buildArmRoster` passes `retrieved: ''`, and that is deliberate
 * -- the arm collects no retrieval text, so it refuses to guess rather than
 * fabricating turns. The refusal is correct and the absence is the problem.
 *
 * `#lastRawOutput` is the worked example of the remedy: the model's text was
 * computed inside a private method and died at `parseAnswer`, so a one-slot
 * accessor was added and the benchmark reads it through a structural check. The
 * evidence has the same shape of problem and gets the same shape of answer.
 *
 * ## Why one slot, and why `null` rather than `''`
 *
 * The benchmark asks one question at a time and reads the accessor immediately
 * after the call, so a slot is the whole requirement; an accumulating list would
 * grow without bound on a 500-question run for a reader that never looks
 * backwards. The scope is stated in the name: this describes the **most recent**
 * call.
 *
 * `''` would be indistinguishable from "the reader was shown an empty context",
 * and an empty context is a real, diagnosable outcome -- it is what `empty` in
 * the abstention census counts. `null` is "no call has happened, or the machine
 * declined before a reader was shown anything", which is a different statement.
 *
 * ## Why the assertions are behavioural
 *
 * §37 recorded an escape where a guard asserted on source text and a real break
 * matched nothing. The property asserted here is the observable one: after a call
 * whose gate admitted turns, the accessor returns text containing those turns,
 * and after a call that was declined before the model, it returns `null` while
 * the model was never consulted.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
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

/** The gate configuration every test here shares, so the only variable is the route. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

describe('the system reports the evidence it was shown', () => {
  it('starts at null, because no call has happened yet', () => {
    // `null` and not `''`. A blank string would read as "the reader was shown an
    // empty context", which is a real outcome this accessor exists to distinguish
    // itself from.
    const memory = system({ llm: recordingLlm([]), gate: OPEN_GATE });
    expect(memory.lastRetrievedContext()).toBeNull();
  });

  it('returns the flat context it admitted, on the flat route', async () => {
    const memory = system({ llm: recordingLlm([]), gate: OPEN_GATE });

    await memory.answer('Where did I go?', ['user: I went to Lisbon.']);

    const retrieved = memory.lastRetrievedContext();
    expect(retrieved).toContain('I went to Lisbon.');
  });

  it('returns the admitted turns in admission order, so a wrong turn is attributable', async () => {
    // Order is part of the claim. The arm's reader is shown turns in the order the
    // admission layer produced them, and "the right evidence was present but
    // ranked below something else" is only visible if the order survives.
    const memory = system({ llm: recordingLlm([]), gate: OPEN_GATE });

    await memory.answer('What did I do?', [
      'user: I moved to Lisbon.',
      'assistant: Noted your move.',
      'user: Then I visited Porto.',
    ]);

    const retrieved = memory.lastRetrievedContext()!;
    expect(retrieved.indexOf('Lisbon')).toBeLessThan(retrieved.indexOf('Porto'));
  });

  it('returns the evidence on the session route, which carries the arm largest loss', async () => {
    // MR is half of the §13 loss and its evidence arrives as sessions with
    // boundaries, not as a flat list. The accessor has to describe that route
    // too, or the next measurement still cannot see it.
    const memory = system({ llm: recordingLlm([]), gate: OPEN_GATE });

    await memory.answerSessions('How many trips did I take?', [
      ['user: I went to Lisbon.', 'assistant: Noted.'],
      ['user: I went to Porto.'],
    ]);

    const retrieved = memory.lastRetrievedContext();
    expect(retrieved).toContain('Lisbon');
    expect(retrieved).toContain('Porto');
  });

  it('returns the evidence on the temporal route, which is the other half of the loss', async () => {
    const memory = system({ llm: recordingLlm([]), gate: OPEN_GATE });

    await memory.answerTemporal(
      'When did I go to Lisbon?',
      ['user: I went to Lisbon in June.'],
      '2024-07-01',
      [['user: I went to Lisbon in June.']],
    );

    expect(memory.lastRetrievedContext()).toContain('I went to Lisbon in June.');
  });

  it('overwrites the slot on each call, so it describes the most recent question', async () => {
    // A slot rather than a list, and the scope is stated in the method name. The
    // failure this guards against is the one `#lastRawOutput` documents: a reader
    // that assembles the roster after the loop and reads the accessor once would
    // attribute the LAST question's evidence to every record.
    const memory = system({ llm: recordingLlm([]), gate: OPEN_GATE });

    await memory.answer('First?', ['user: The first fact.']);
    await memory.answer('Second?', ['user: The second fact.']);

    const retrieved = memory.lastRetrievedContext()!;
    expect(retrieved).toContain('The second fact.');
    expect(retrieved).not.toContain('The first fact.');
  });

  it('reports null when nothing was admitted, rather than an empty context', async () => {
    // The distinction the accessor exists for. `empty` in the abstention census
    // counts exactly this outcome; the accessor has to agree with it rather than
    // reporting a blank string that reads as "a context was shown, and it was
    // empty".
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen), gate: OPEN_GATE });

    await memory.answerTemporal('Where?', [], '2024-01-01', []);

    expect(memory.lastRetrievedContext()).toBeNull();
    expect(memory.abstentionReasons().empty).toBe(1);
    // And the model was never consulted, which is what makes this a machine
    // outcome rather than an empty prompt.
    expect(seen).toHaveLength(0);
  });

  it('reports the evidence even when the model then declined it', async () => {
    // The §13 shape exactly: evidence was admitted and shown, and the model
    // answered `INSUFFICIENT_EVIDENCE` anyway. The accessor existing is what makes
    // "the reader saw it and declined" separable from "the reader saw nothing".
    const memory = system({ llm: recordingLlm([], ABSTAIN_TOKEN), gate: OPEN_GATE });

    const answer = await memory.answerSessions('How many trips?', [['user: I took three trips.']]);

    expect(answer).toBeNull();
    expect(memory.lastRetrievedContext()).toContain('I took three trips.');
  });

  it('does not report a context for a question the retrieval gate declined', async () => {
    // The abstention route's gate is the one place evidence can be admitted and
    // then withheld from the reader. Reporting it as shown would claim the reader
    // saw evidence the gate never released.
    const memory = system({
      llm: recordingLlm([]),
      gate: { ...OPEN_GATE, retrievalThreshold: 0.99, valueFunction: constantValue(0) },
    });

    const answer = await memory.answerAbstention('Where did I travel?', ['user: Lisbon.']);

    expect(answer).toBeNull();
    expect(memory.abstentionReasons().threshold).toBe(1);
    expect(memory.lastRetrievedContext()).toBeNull();
  });
});

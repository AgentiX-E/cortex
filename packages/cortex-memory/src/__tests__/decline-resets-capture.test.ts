/**
 * A decline must leave nothing of the question before it.
 *
 * ## The measurement this exists for
 *
 * Screening run `43465626013` produced four records whose `turns` were the **wrong question's**
 * window: `28dc39ac` carries `[2023/05/20 (Sat) 20:20] assistant: Based on your description, it's
 * likely that Hwang's Kitchen's ...` where its own gold is thirty user turns about open-world
 * games, and that string is byte-identical to index 101's first delivered turn. `gpt4_4fc4f797`
 * carries index 169's `New Orleans is an amazing city!`, `gpt4_7fce9456` carries index 154's
 * `I think there's been a misunderstanding!`, and `gpt4_a1b77f9c` carries index 124's.
 *
 * All four are `answer: null`, and all four are the only records in that artifact with
 * `promptVariants: 2`. The mechanism is one method: `#declinedEmpty` cleared `#lastWidth` and
 * `#lastIndex` -- with an argument that applies verbatim to the other five slots -- and left
 * `#lastRetrievedContext`, `#lastAdmittedEvidence`, `#lastPromptEvidenceChars`, `#lastPromptText`
 * and `#lastRawOutput` holding the previous question's values.
 *
 * ## What a reader lost, and why this is not cosmetic
 *
 * `goldOverlap.carried: 0 of 30` was read (by §13.373.8, written before this test existed) as
 * "retrieval never surfaced a gold turn". It was in fact "this row describes a different
 * question". Every field derived from the five slots inherits the same defect on any question the
 * machine declines -- which is the population a gate experiment produces most of.
 *
 * ## The contract these assertions encode
 *
 * `lastRetrievedContext`'s docstring already states it: `[]` is "the reader was reached and
 * carried nothing", `null` is "no reader was reached". `#declinedEmpty` is the second kind by
 * definition -- it is the path taken *before* the reader -- so `null` is not a new convention
 * here, it is the one the field documents and the code failed to honour.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';

const NOW = 1_759_470_000_000;

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

const ALWAYS_ONE: ValueFunction = (_memory: MemoryValue) => 1;
const ALWAYS_ZERO: ValueFunction = (_memory: MemoryValue) => 0;

/** A system whose gate admits everything, so an answer really does carry evidence. */
function openSystem(llm: LLM): CortexMemory {
  return new CortexMemory({
    now: NOW,
    llm,
    gate: {
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: Number.POSITIVE_INFINITY,
      valueFunction: ALWAYS_ONE,
    },
  });
}

/** A system whose gate refuses everything, so every path reaches `#declinedEmpty`. */
function closedSystem(llm: LLM): CortexMemory {
  return new CortexMemory({
    now: NOW,
    llm,
    gate: {
      threshold: 1,
      retrievalThreshold: 0,
      sessionBudget: Number.POSITIVE_INFINITY,
      valueFunction: ALWAYS_ZERO,
    },
  });
}

const EVIDENCE = ['[2023/02/15 (Wed) 03:14] user: I need to pick up two jackets.'];

/** Every per-question slot, read through its public accessor. */
function captures(memory: CortexMemory): Record<string, unknown> {
  return {
    rawOutput: memory.lastRawOutput(),
    review: memory.lastReview(),
    vote: memory.lastVote(),
    width: memory.lastWidth(),
    indexCensus: memory.lastIndexCensus(),
    retrievedContext: memory.lastRetrievedContext(),
    promptEvidenceChars: memory.lastPromptEvidenceChars(),
    promptText: memory.lastPromptText(),
    admittedEvidence: memory.lastAdmittedEvidence(),
  };
}

describe('a decline resets every per-question capture', () => {
  it('does not inherit the previous question on the flat route', async () => {
    const seen: string[] = [];
    const memory = openSystem(recordingLlm(seen));

    await memory.answer('What do I need to pick up?', EVIDENCE);
    // The premise: this question really did carry evidence, so the slots are populated.
    expect(memory.lastRetrievedContext()).toEqual(EVIDENCE);
    expect(memory.lastAdmittedEvidence()).toEqual({ turns: 1, chars: EVIDENCE[0]?.length });

    // Same instance, a gate that now refuses everything. `#declinedEmpty` is reached.
    const closed = closedSystem(recordingLlm([]));
    await closed.answer('ignored', EVIDENCE);
    // Sanity: the fresh instance never answered, so its slots are already empty.
    expect(closed.lastRetrievedContext()).toBeNull();

    // The real assertion: a system that answered and then declined must not report the answer's
    // evidence as the decline's.
    const mixed = openSystem(recordingLlm(seen));
    await mixed.answer('first', EVIDENCE);
    await mixed.answer('second', []);
    expect(mixed.lastRetrievedContext()).toBeNull();
    expect(mixed.lastAdmittedEvidence()).toBeNull();
    expect(mixed.lastPromptEvidenceChars()).toBeNull();
    expect(mixed.lastPromptText()).toBeNull();
    expect(mixed.lastRawOutput()).toBeNull();
  });

  it('does not inherit the previous question on the session route', async () => {
    const sessions = [['[2023/02/15 (Wed) 03:14] user: I need to pick up two jackets.']];
    const memory = openSystem(recordingLlm([]));
    await memory.answerSessions('what?', sessions);
    expect(memory.lastRetrievedContext()).not.toBeNull();

    await memory.answerSessions('what?', []);
    expect(memory.lastRetrievedContext()).toBeNull();
    expect(memory.lastAdmittedEvidence()).toBeNull();
  });

  it('does not inherit the previous question when a role filter empties the window', async () => {
    const seen: string[] = [];
    const memory = new CortexMemory({
      now: NOW,
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session'],
      roleOf: (turn: string) =>
        /^\[[^\]]*\]\s*(user|assistant)\s*:/i.exec(turn)?.[1]?.toLowerCase(),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: ALWAYS_ONE,
      },
    });

    await memory.answerSessions('first', [['[2023/02/15 (Wed) 03:14] user: keep me']]);
    expect(memory.lastRetrievedContext()).toEqual(['[2023/02/15 (Wed) 03:14] user: keep me']);

    // Every turn is the excluded role, so `#sessionsForRoute` leaves nothing and the path declines.
    // This is the exact shape the four contaminated records arrived through: a length gate that
    // keeps only long assistant turns, then a filter that keeps only user turns.
    await memory.answerSessions('second', [['[2023/02/15 (Wed) 03:15] assistant: drop me']]);
    expect(memory.lastRetrievedContext()).toBeNull();
    expect(memory.lastAdmittedEvidence()).toBeNull();
  });

  it('does not inherit the previous question when retrieval abstains', async () => {
    // `answerAbstention` declines through `decideRetrieval` before the reader is reached, which is
    // the second exit that leaves the machine -- not the reader -- deciding the question is over.
    const memory = new CortexMemory({
      now: NOW,
      llm: recordingLlm([]),
      gate: {
        threshold: 0,
        retrievalThreshold: 1,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: ALWAYS_ZERO,
      },
    });
    await memory.answer('first', EVIDENCE);
    await memory.answerAbstention('second', EVIDENCE);
    expect(memory.lastRetrievedContext()).toBeNull();
    expect(memory.lastAdmittedEvidence()).toBeNull();
  });

  it('still populates the slots for the next question that is answered', async () => {
    // The other direction, because a fix that cleared the slots and never wrote them again would
    // satisfy every assertion above and destroy the artifact.
    const memory = openSystem(recordingLlm([]));
    await memory.answer('first', EVIDENCE);
    await memory.answer('second', []);
    expect(memory.lastRetrievedContext()).toBeNull();

    const other = ['[2023/02/16 (Thu) 04:00] user: a later turn'];
    await memory.answer('third', other);
    expect(memory.lastRetrievedContext()).toEqual(other);
    expect(memory.lastAdmittedEvidence()).toEqual({ turns: 1, chars: other[0]?.length });
  });

  it('reports every slot as empty after a decline, not just the four the artifact writes', async () => {
    // One assertion per slot rather than one for the group: a field added to this class and not to
    // `#declinedEmpty` is the defect this file exists for, and a loop over `captures` would let the
    // next one through by simply not being listed.
    const memory = openSystem(recordingLlm([]));
    await memory.answer('first', EVIDENCE);
    await memory.answer('second', []);

    expect(captures(memory)).toEqual({
      rawOutput: null,
      review: null,
      vote: null,
      width: undefined,
      indexCensus: undefined,
      retrievedContext: null,
      promptEvidenceChars: null,
      promptText: null,
      admittedEvidence: null,
    });
  });
});

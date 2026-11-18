/**
 * The instrument's fixed reply must not be able to move the evidence it is used to measure.
 *
 * ## Why this is a test of the product rather than of the instrument
 *
 * `CORTEX_ARM_OFFLINE` replaces the reader with a constant so that a change to lexical scoring can
 * be priced without paying for five hundred answers. The whole reading rests on one claim: that the
 * delivered evidence is decided **before** the reply and does not depend on it. That claim is not
 * obvious -- `reviewBareDecline` re-asks a question whose reply is a bare refusal, `reviewPass`
 * re-asks one whose decline contradicts its own list, and either would rebuild the window under a
 * reply that happened to look like one of those shapes.
 *
 * So the claim is measured twice, from the reply's two directions: a reply that is not the
 * instrument's must produce byte-identical evidence (the reply is inert), and the instrument's own
 * reply must not be a shape any of those mechanisms acts on (the instrument cannot trip them). A
 * reading taken under a reply that failed either half would be a reading of that reply's effect on
 * retrieval, in a run whose only stated variable is the scoring.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { OFFLINE_INSTRUMENT_REPLY } from '@agentix-e/cortex-eval';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const OPEN_GATE = { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY };

/** A model that always answers the same thing and counts how many times it was asked. */
function always(reply: string): { llm: LLM; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    llm: {
      complete: async () => {
        calls += 1;
        return reply;
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    },
  };
}

/**
 * The registered index configuration, minus the paid channel: the product ranks, nothing is embedded.
 *
 * `k` is `S14`'s `relevanceTopK`, so the candidate list this test ranks is the one the instrument
 * ranks in a dispatched run.
 */
const INDEX = { channels: ['lexical'] as const, k: 256 };

function system(llm: LLM, options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, index: INDEX, ...options });
}

/** Four sessions with one distinctive fact each, so lexical ranking has an order to produce. */
function sessions(): string[][] {
  return [
    ['[2023/05/20 (Sat) 20:05] user: I got a peace lily from the nursery two weeks ago.'],
    ['[2023/05/23 (Tue) 09:12] user: The dentist moved my appointment to June.'],
    ['[2023/05/25 (Thu) 16:59] user: I got a snake plant from my sister last month.'],
    ['[2023/05/28 (Sun) 11:40] user: I replaced the brake pads on the bicycle myself.'],
  ];
}

const QUESTION = 'How many plants did I acquire in the last month?';

describe('the fixed reply is inert', () => {
  it('delivers the same evidence whatever the model says', async () => {
    // Two replies of different shapes -- the instrument's phrase and a prose paragraph that shares
    // no vocabulary with the question -- because a mechanism that reacted to *content* would react
    // to one of them and not the other.
    const one = system(always(OFFLINE_INSTRUMENT_REPLY).llm);
    const two = system(
      always(
        'You acquired two plants: a peace lily in mid-May and a snake plant from your sister. ' +
          'Neither acquisition was recorded twice.',
      ).llm,
    );

    await one.answerSessions(QUESTION, sessions());
    await two.answerSessions(QUESTION, sessions());

    expect(one.lastRetrievedContext()).not.toBeNull();
    expect(one.lastRetrievedContext()).toEqual(two.lastRetrievedContext());
  });

  it('delivers the same evidence with and without the one-char budget that would rebuild a window', async () => {
    // The room is where a rebuild would show: a retry re-renders "the evidence the first pass
    // carried", which is the delivered set, so a mechanism that fired would report a smaller window
    // on one side. Both sides here are the same configuration, differing only in the reply.
    const option = { maxTurnChars: 400, turnCutMarker: 'none' as const };
    const one = system(always(OFFLINE_INSTRUMENT_REPLY).llm, option);
    const two = system(always('A completely different answer.').llm, option);

    await one.answerSessions(QUESTION, sessions());
    await two.answerSessions(QUESTION, sessions());

    expect(one.lastRetrievedContext()).toEqual(two.lastRetrievedContext());
  });
});

describe('the instrument cannot trip a second consultation', () => {
  it('is not an abstention, so the reply is not classified as a decline', async () => {
    const answer = await system(always(OFFLINE_INSTRUMENT_REPLY).llm).answerSessions(
      QUESTION,
      sessions(),
    );
    // `null` is how this package reports "the model declined". A constant that parsed as a decline
    // would make every question in an instrument run abstain, and `reviewBareDecline` below would
    // then spend a second call on all five hundred.
    expect(answer).not.toBeNull();
  });

  it('asks exactly once under the registered `reviewBareDecline` setting', async () => {
    const { llm, calls } = always(OFFLINE_INSTRUMENT_REPLY);
    const memory = system(llm, { reviewBareDecline: true });
    await memory.answerSessions(QUESTION, sessions());

    expect(calls()).toBe(1);
    // The census beside the call count, so a mechanism that fired and was not counted cannot hide
    // behind a call count that a different mechanism produced.
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('asks exactly once with the recovery pass on as well', async () => {
    const { llm, calls } = always(OFFLINE_INSTRUMENT_REPLY);
    const memory = system(llm, { reviewPass: 'recover' });
    await memory.answerSessions(QUESTION, sessions());

    expect(calls()).toBe(1);
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('searches once per question, which is the count the dispatched run asserts', async () => {
    // `memoryArmConfig.selfIndex.indexes` is the artifact field `assertOfflineInstrumentReached`
    // reads, and it is `indexCost()`'s count on this instance. Pinned here so the assertion's
    // expectation -- one per question -- is a property of the product rather than of the arm.
    const memory = system(always(OFFLINE_INSTRUMENT_REPLY).llm);
    await memory.answerSessions(QUESTION, sessions());
    await memory.answerSessions('When did I replace the brake pads?', sessions());

    expect(memory.indexCost()?.indexes).toBe(2);
  });
});

/**
 * `answer(question, context, sessions)` stays on the flat route, and this file is why.
 *
 * ## The change this file replaced, and what it would have cost
 *
 * `answer`'s third parameter was `_sessions`: declared, documented in the contract, and never read.
 * That reads as a contract violation, and the obvious repair -- forward a non-empty list to
 * `answerSessions` -- is wrong by measurement rather than by taste:
 *
 *  * `longmemeval-loader.ts:158` builds `sessions` for **every** instance, with
 *    `context: sessions.flat()`. There is no question in the dataset that lacks a session view.
 *  * `benchmark.ts:1031` is `workerSystem.answer(q.question, q.context, q.sessions)` -- the fallback
 *    branch, reached by every shape without a dedicated path, which is `IE` and the non-preference
 *    single-session types: 150 of the 467 graded questions.
 *  * `answerSessions` builds the multi-session aggregation prompt, so the forward replaces the
 *    extractive prompt on those 150 questions. The published 91.05% was taken with the extractive
 *    one.
 *
 * A unit test could not have caught it: no test regenerates the artifact, and the whole suite stayed
 * green through the change. What caught it was asking which caller passes three arguments to a route
 * that ignores the third.
 *
 * ## What the contract actually asks for
 *
 * "Optional and additive: a system that wants only the flat list is unaffected." That is a promise
 * about implementations -- a two-argument system keeps working -- not a promise that every
 * implementation exploits the third argument. This one exploits it on the paths where the benchmark
 * routes session-grouped shapes explicitly (`answerSessions`, `answerTemporal`, `answerAbstention`,
 * `answerKnowledgeUpdate`) and stays flat here, which is what makes this method the fallback.
 *
 * Making the flat route session-aware is therefore an accuracy experiment rather than a defect
 * repair: it changes the evidence one capability is shown, so it needs a dispatch, a pairing and a
 * reading like any other mechanism. These tests hold the current behaviour still until that reading
 * exists -- not because the behaviour is obviously right, but because it is the behaviour every
 * published number was produced under, and a change to it must be visible in a table rather than in
 * a diff.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

function recordingLlm(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Berlin';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

const BERLIN_TURN = '[2023/05/20 (Sat) 10:00] user: I moved to Berlin in March.';

function memory(seen: string[]): CortexMemory {
  return new CortexMemory({
    llm: recordingLlm(seen),
    now: NOW,
    gate: OPEN_GATE,
  } as CortexMemoryOptions);
}

describe('answer() and the session view it is given', () => {
  it('stays on the flat route even when the caller passes sessions', async () => {
    // The exact call `benchmark.ts` makes for every question without a dedicated path.
    const system = memory([]);
    await system.answer('Where did I move?', [BERLIN_TURN], [[BERLIN_TURN]]);
    expect(system.lastRoute()).toBe('flat');
  });

  it('asks the same prompt it asks without the third argument', async () => {
    // The byte-identity claim, at the only place it can be asserted cheaply: the prompt. A forward
    // would have made these two arrays differ, and the difference is the whole mechanism.
    const withSessions: string[] = [];
    const withoutSessions: string[] = [];
    await memory(withSessions).answer('Where did I move?', [BERLIN_TURN], [[BERLIN_TURN]]);
    await memory(withoutSessions).answer('Where did I move?', [BERLIN_TURN]);
    expect(withSessions).toEqual(withoutSessions);
    expect(withSessions).toHaveLength(1);
  });

  it('is not the multi-session route, which is reached by calling it by name', async () => {
    // The distinction the benchmark makes for `MR`: it does not rely on `answer` noticing the session
    // view, it calls `answerSessions`. Pinning both routes here means a later change to either one has
    // to confront the difference.
    const forwarded: string[] = [];
    const direct: string[] = [];
    await memory(forwarded).answer('Where did I move?', [BERLIN_TURN], [[BERLIN_TURN]]);
    await memory(direct).answerSessions('Where did I move?', [[BERLIN_TURN]]);
    expect(forwarded).not.toEqual(direct);
  });
});

/**
 * The relevance budget must be spendable in **sessions**, not only in turns.
 *
 * ## Why this exists, and what §13.26 measured
 *
 * Run `38595325261` carries `goldOverlap` per question, and grouping by outcome shows the
 * mechanism rather than merely correlating with it:
 *
 * | capability | correct | wrong | abstained |
 * | --- | --- | --- | --- |
 * | MR | 0.587 | 0.470 | 0.451 |
 * | TR | 0.579 | 0.407 | 0.342 |
 *
 * and for MR, bucketed by coverage, accuracy runs 14.3% -> 33.3% -> 41.5% -> 66.7%
 * across the first four bands. **Accuracy tracks how much of the answer session the
 * reader was shown**, and the level is low: MR's carried count has a median of 14
 * against a median `total` of 24.
 *
 * The cause is the unit. `relevanceFor` scores a **turn**, so the budget buys the
 * highest-scoring turns wherever they live, and a multi-session question's answer -- which
 * is spread across a whole session of statements -- is scattered across the budget instead
 * of completed. `expandContextWindowBySession` in the reference pipeline does the opposite
 * and scores 86.78% on MR.
 *
 * ## What is NOT asserted here
 *
 * The signal itself does not change: turns are still scored one at a time by the same
 * callback, and the session is a **grouping of the same scores**. A test asserting a new
 * scoring function would be testing a different change.
 *
 * ## Why the assertions are set membership rather than exact lists
 *
 * The room left for evidence depends on the instruction block's length, which this suite
 * does not pin and should not. The properties that matter hold for a wide band of room --
 * between four and six turns' worth -- and are stated as membership:
 *
 *   - **turn unit**: the highest-scoring turn is carried, a session-mate with a LOWER score
 *     is not, and a foreign session's turn IS -- i.e. the budget crossed a boundary.
 *   - **session unit**: every turn of the top session is carried and no turn of the other
 *     is -- i.e. the budget respected the boundary.
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
      return 'answer';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

/** A gate that admits everything, so the only variable is the selection. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

/** A turn of a fixed size, so "how many fitted" is the only thing the budget decides. */
function turn(tag: string): string {
  return `${tag}-${'x'.repeat(2000)}`;
}

/** Session A's second turn scores highest; all of B's are middling; A's rest are zero. */
function relevanceFor(_question: string, text: string): number {
  if (text.startsWith('a1-')) return 1;
  if (text.startsWith('b')) return 0.5;
  return 0;
}

function twoSessions(): string[][] {
  return [
    [turn('a0'), turn('a1'), turn('a2'), turn('a3')],
    [turn('b0'), turn('b1'), turn('b2'), turn('b3')],
  ];
}

function system(options: Partial<CortexMemoryOptions>): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: OPEN_GATE,
    llm: recordingLlm([]),
    relevanceFor,
    // Room for four to five turns of 2000 characters, with the instruction block,
    // the question and the session note taking the rest. Both properties below hold
    // anywhere in that band.
    maxPromptChars: 10_000,
    ...options,
  });
}

async function carriedContents(options: Partial<CortexMemoryOptions>): Promise<string[]> {
  const memory = system(options);
  await memory.answerSessions('How many?', twoSessions());
  const carried = memory.lastRetrievedContext()!;
  return carried.map((text) => text.split('-')[0]!.trim());
}

describe('the relevance budget can be spent in sessions', () => {
  it('admits the top session whole, and nothing from another, on the session unit', async () => {
    const carried = await carriedContents({ relevanceUnits: 'session' });

    // Every turn of the session the signal ranked highest...
    expect(carried).toContain('a0');
    expect(carried).toContain('a1');
    expect(carried).toContain('a2');
    expect(carried).toContain('a3');
    // ...and no turn of any other, because the session was taken whole and the
    // budget was spent inside it rather than across the boundary.
    expect(carried.filter((tag) => tag.startsWith('b'))).toEqual([]);
  });

  it('crosses the boundary on the turn unit, which is what the session unit fixes', async () => {
    // The control, and it is the whole point: with the same signal and the same
    // budget, the turn unit buys the highest scorer plus whatever else fits by
    // score -- and that includes B's turns while excluding A's own lower-scoring
    // ones. A session left three quarters unread while a foreign session is read.
    const carried = await carriedContents({ relevanceUnits: 'turn' });

    expect(carried).toContain('a1');
    expect(carried.filter((tag) => tag.startsWith('b')).length).toBeGreaterThan(0);
    expect(carried).not.toContain('a0');
  });

  it('changes nothing when no unit is named, so every archived run stays reproducible', async () => {
    // Absent means the previous behaviour character for character. The four runs
    // §13.20-§13.26 rest on were dispatched without this option, so a default that
    // differed would make every one of them unreproducible from the code.
    const omitted = await carriedContents({});
    const explicit = await carriedContents({ relevanceUnits: 'turn' });

    expect(omitted).toEqual(explicit);
  });

  it('keeps the rendered order chronological, not relevance order', async () => {
    // The order is a separate decision from the selection and the answer depends on
    // it: a log printed in relevance order makes relative-time questions unanswerable.
    // `selectSessionBudget` already refuses to reorder sessions for presentation, and
    // this is the same rule one layer in.
    const carried = await carriedContents({ relevanceUnits: 'session' });

    expect(carried).toEqual(['a0', 'a1', 'a2', 'a3']);
  });

  it('orders two sessions the signal cannot separate by the earlier arrival', async () => {
    // The tie rule, and it is the same one §13.17's turn unit uses: two candidates the
    // signal cannot separate are ordered the way the context ordered them, so the outcome
    // does not depend on the sort being stable. Asserted on the session unit because that
    // is where a tie is decided -- the turn unit's own tie is covered by
    // `evidence-relevance.test.ts`.
    const memory = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm: recordingLlm([]),
      // Every turn scores the same, so every session does, and only arrival decides.
      relevanceFor: () => 0.5,
      maxPromptChars: 10_000,
      relevanceUnits: 'session',
    });

    await memory.answerSessions('How many?', twoSessions());

    expect(memory.lastRetrievedContext()!.map((text) => text.split('-')[0])).toEqual([
      'a0',
      'a1',
      'a2',
      'a3',
    ]);
  });

  it('refuses a session it cannot fit whole, rather than carrying part of it', async () => {
    // The other half of "whole sessions": when even the top session is larger than the
    // room, the selection carries nothing. Carrying a prefix of it would be the turn unit
    // wearing the session unit's name, and a reader comparing the two runs would be
    // comparing an option that did not do what its configuration line said.
    const memory = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm: recordingLlm([]),
      relevanceFor,
      // Two turns' worth of room against sessions of four: the first session cannot fit,
      // and skipping it for the second is exactly what the prefix rule forbids.
      maxPromptChars: 4_500,
      relevanceUnits: 'session',
    });

    await memory.answerSessions('How many?', twoSessions());

    expect(memory.lastRetrievedContext()).toEqual([]);
  });

  it('is inert on a route that has no session boundary to spend it in', async () => {
    // `buildPrompt` is handed no session boundary, so a selection in sessions cannot be
    // expressed on flat, temporal, knowledge-update, abstention or assistant. That is
    // what makes §13.27 a single-variable dispatch: MR moves and no other capability can.
    //
    // Asserted over turns long enough that the budget actually selects, because with
    // short ones everything fits and the two units would agree for a reason that has
    // nothing to do with the option -- a passing test that proves nothing.
    const flat = ['a0', 'a1', 'a2', 'a3', 'b0', 'b1'].map(turn);
    const withUnit = system({ relevanceUnits: 'session' });
    await withUnit.answer('How many?', flat);
    const withTurn = system({ relevanceUnits: 'turn' });
    await withTurn.answer('How many?', flat);

    const carried = withUnit.lastRetrievedContext()!;
    expect(carried.length).toBeLessThan(flat.length);
    expect(carried).toEqual(withTurn.lastRetrievedContext());
  });
});

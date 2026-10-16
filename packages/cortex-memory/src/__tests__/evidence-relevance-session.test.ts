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

async function carriedContents(
  options: Partial<CortexMemoryOptions>,
  sessions: string[][] = twoSessions(),
): Promise<string[]> {
  const memory = system(options);
  await memory.answerSessions('How many?', sessions);
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

/**
 * The prefix rule stranded the room, and that is what run `38753835652` measured.
 *
 * ## What the archive says
 *
 * The session unit was dispatched against §13.26's turn unit with nothing else moved, and
 * it lost: `+25.75pp` became `+17.80pp`, MR fell 42.15% to 12.40% (92 questions the
 * baseline had right and this arm now had wrong, against **zero** it gained), and MR's
 * abstentions rose from 24 to 63. Coverage did not rise with it -- 0.500 to 0.455 -- which
 * is the falsifier §13.27 wrote before the number existed: if the unit were the cause,
 * showing a whole session would raise coverage, and it did not.
 *
 * ## What the mechanism was
 *
 * `session` orders sessions by their best-scoring turn and then carries a **prefix** of
 * that order, stopping at the first session that does not fit. A session is much larger
 * than a turn, so the first one over the line ends the pass and the rest of the room goes
 * unused. The archived run had a median of 12 carried turns against a room that holds
 * about 23, and the same write-up that described the search called the stopping rule a
 * virtue: "the largest prefix, without skipping". It was the defect.
 *
 * A discarded alternative is worth naming so it is not re-proposed as new: carry the
 * session's leading turns instead of all of it. That trades the ordering rule for a second
 * one and cannot be compared against a run that only moved the unit.
 */
describe('the session unit fills the room it is given', () => {
  /**
   * A session too large for the room, ranked first, and a small one behind it.
   *
   * Six turns of two thousand characters is about 12k, more than the room holds at any
   * budget this suite uses, and two turns is about 4k, less than it holds at all of them.
   * The gap is wide enough that the assertions do not depend on the instruction block's
   * exact length -- which is what keeps this a test of the rule and not of a character
   * count that a wording change would move.
   */
  function oversizedThenSmall(): string[][] {
    return [Array.from({ length: 6 }, (_, i) => turn(`a${i}`)), [turn('b0'), turn('b1')]];
  }

  it('strands the room on the prefix rule, which is what was measured', async () => {
    const carried = await carriedContents({ relevanceUnits: 'session' }, oversizedThenSmall());

    // Nothing at all: the ranked-first session does not fit, and the rule stops there
    // rather than reaching a session that does.
    expect(carried).toEqual([]);
  });

  it('skips the session that does not fit and carries the one that does', async () => {
    const carried = await carriedContents({ relevanceUnits: 'session-fill' }, oversizedThenSmall());

    expect(carried).toEqual(['b0', 'b1']);
  });

  it('keeps the prompt inside the room while filling', async () => {
    // A greedy fill that measured the room with an additive estimate would overrun it,
    // because the session route renders a header per session and a separator per turn.
    // The rule measures with the renderer itself, and this is the assertion that says so.
    const seen: string[] = [];
    const memory = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm: recordingLlm(seen),
      relevanceFor,
      maxPromptChars: 10_000,
      relevanceUnits: 'session-fill',
    });

    await memory.answerSessions('How many?', oversizedThenSmall());

    expect(memory.lastRetrievedContext()).not.toEqual([]);
    expect(seen[0]!.length).toBeLessThanOrEqual(10_000);
  });

  it('agrees with the prefix rule whenever every session fits', async () => {
    // The two rules are one change, not two: they differ only in what happens when a
    // session is rejected. Asserted rather than assumed, because a filling rule that also
    // reordered sessions would move the winner's reading for a reason §13.31 did not
    // measure -- and §13.26's turn unit is the comparison, so the shared part has to be
    // shared.
    const small = [[turn('a0'), turn('a1')], [turn('b0')]];
    const filled = await carriedContents({ relevanceUnits: 'session-fill' }, small);
    const prefixed = await carriedContents({ relevanceUnits: 'session' }, small);

    expect(filled).toEqual(['a0', 'a1', 'b0']);
    expect(filled).toEqual(prefixed);
  });

  it('is inert on a route that has no session boundary to spend it in', async () => {
    // Same guard as the prefix rule, for the same reason: `buildPrompt` is handed no
    // session boundary, so a selection in sessions cannot be expressed on flat, temporal,
    // knowledge-update, abstention or assistant.
    const flat = ['a0', 'a1', 'a2', 'a3', 'b0', 'b1'].map(turn);
    const withFill = system({ relevanceUnits: 'session-fill' });
    await withFill.answer('How many?', flat);
    const withTurn = system({ relevanceUnits: 'turn' });
    await withTurn.answer('How many?', flat);

    expect(withFill.lastRetrievedContext()).toEqual(withTurn.lastRetrievedContext());
  });

  it('carries nothing when no session fits, which is the one outcome filling cannot fix', async () => {
    // Skipping recovers the room a single oversized session stranded; it does not make a
    // session fit that does not. With every session larger than the room the outcome is the
    // same empty roster as the prefix rule -- and the artifact says so rather than the
    // reader being handed a truncated session, which would be the turn unit under the
    // session unit's name.
    const carried = await carriedContents({ relevanceUnits: 'session-fill' }, [
      Array.from({ length: 6 }, (_, i) => turn(`a${i}`)),
    ]);

    expect(carried).toEqual([]);
  });
});

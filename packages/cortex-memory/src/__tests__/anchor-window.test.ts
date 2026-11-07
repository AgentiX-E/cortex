/**
 * The evidence room must be spendable on an **anchor plus its session-local
 * neighbourhood**, not only on single turns or whole sessions.
 *
 * ## Where this comes from, and why it is not a guess
 *
 * §13.283 published this arm's gold-turn recall for the first time: 6,520 of 7,516
 * annotated turns are delivered (86.75%), MR reaches 97.11%, and the 53 turns that
 * MR is still missing across 34 questions all carry `goldRanks = -1` -- the ranking
 * never scored them at all. They are **neighbours** of anchors that scored, sitting
 * below the character cut. A prefix cannot recover them at any width: widening the
 * prefix buys more ranked turns, not the unranked neighbour of one that already
 * scored.
 *
 * The reference implementation we are measured against solves exactly this, and its
 * source says so (`cod/sde.py`, `cod/expand.py`): rank a **bounded anchor set**, then
 * restore each anchor's same-session neighbourhood of `±window` turns, and only then
 * spend the budget. It never extends a prefix and never takes a whole session.
 *
 * ## Why three units were not enough
 *
 * `'session'` and `'session-fill'` both buy **every** turn of a chosen session, which
 * overpays when a session is long: one gold turn costs forty turns of room.
 * `'turn'` pays exactly one turn and therefore pays nothing for the neighbour that
 * makes the anchor interpretable. The unit this file pins is between them, and the
 * radius is the dial: at `0` it must reproduce the turn unit **character for
 * character**, which is the control that makes the radius the only variable.
 *
 * ## The two properties a naive version gets wrong
 *
 * **Order.** Anchors are chosen by relevance and the neighbourhood is *found* by
 * relevance; what is delivered is still chronological. Printing relevance order makes
 * relative-time and knowledge-update questions unanswerable, which is the defect
 * `selectSession` already documents for sessions.
 *
 * **Starvation.** A neighbourhood is larger than a turn, so the first anchor whose
 * window does not fit would end a strict prefix pass and leave the prompt with **no
 * evidence at all**. The ladder therefore shrinks the window, never the anchor: try
 * `radius`, then `radius - 1`, ... then the anchor alone, and stop only when the
 * anchor itself does not fit. `'turn'` is the last rung, so this unit can never carry
 * less than the turn unit would under a tight budget.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { RelevanceUnits } from '../prompt.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;
const QUESTION = 'What did we settle on?';

/** Each turn is one unit of room, so "how many fitted" is all the budget decides. */
const TURN_WIDTH = 1_000;

/**
 * A budget that leaves room for roughly five to six turns.
 *
 * The band is asserted rather than assumed: `the turn unit band` below fails if a
 * future change to the instruction block moves the room out of the range the
 * contrasts in this file are drawn in, so a breakage names the budget instead of
 * masquerading as a selection bug.
 */
const MAX_PROMPT_CHARS = 7_000;

function body(tag: string, width = TURN_WIDTH): string {
  return `${tag}-${'x'.repeat(width)}`;
}

/** Seven turns, of which only `a3` scores. Its neighbours score nothing. */
function sessionA(): string[] {
  return ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((tag) => body(tag));
}

/** Four middling turns in a foreign session, all ranked above A's silent ones. */
function sessionB(): string[] {
  return ['b0', 'b1', 'b2', 'b3'].map((tag) => body(tag));
}

/** Only `a3` scores highly; B is uniformly middling; A's remaining turns score 0. */
function relevanceFor(_question: string, text: string): number {
  if (text.startsWith('a3-')) return 1;
  if (text.startsWith('b')) return 0.4;
  return 0;
}

function recordingLlm(): LLM {
  return {
    complete: async () => 'answer',
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function system(
  overrides: Partial<CortexMemoryOptions> = {},
  relevance: (question: string, text: string) => number = relevanceFor,
): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: {
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: Number.POSITIVE_INFINITY,
      valueFunction: () => 1,
    },
    llm: recordingLlm(),
    relevanceFor: relevance,
    maxPromptChars: MAX_PROMPT_CHARS,
    ...overrides,
  });
}

type Run = { readonly carried: string[]; readonly promptChars: number };

/**
 * Which turns arrive at the model, as their tags.
 *
 * Read back from the assembled prompt rather than from a private accessor: the
 * question is what the reader was shown, and a test that asked the selection what it
 * selected would agree with it by construction.
 */
async function run(
  overrides: Partial<CortexMemoryOptions>,
  sessions: string[][] = [sessionA(), sessionB()],
  relevance?: (question: string, text: string) => number,
): Promise<Run> {
  const memory = system(overrides, relevance);
  await memory.answerSessions(QUESTION, sessions);
  const carried = (memory.lastRetrievedContext() ?? []).map((text) => text.split('-')[0]!.trim());
  return { carried, promptChars: memory.lastPromptText()?.length ?? 0 };
}

describe('the turn unit under this fixture', () => {
  it('leaves the top anchor’s neighbours behind, which is the defect', async () => {
    // The control, and the reason the unit exists. `a3` scores and is read; `a2` and
    // `a4` are the turns that make it interpretable and they score nothing, so the
    // turn unit spends what room is left on B's middling turns instead.
    const control = await run({ relevanceUnits: 'turn' });

    expect(control.carried).toContain('a3');
    expect(control.carried).not.toContain('a2');
    expect(control.carried).not.toContain('a4');
  });

  it('carries between four and seven turns, which is the band the contrasts need', async () => {
    // Stated so that a change to the instruction block's size breaks here, naming the
    // budget, rather than 200 lines later as a selection failure. Below four turns the
    // neighbourhood cannot be shown to be complete; above seven the turn unit would
    // reach `a4` by itself and there would be nothing to contrast.
    const control = await run({ relevanceUnits: 'turn' });

    expect(control.carried.length).toBeGreaterThanOrEqual(4);
    expect(control.carried.length).toBeLessThanOrEqual(7);
  });
});

describe('the room can be spent on an anchor and its neighbourhood', () => {
  it('at radius zero reproduces the turn unit character for character', async () => {
    // The degenerate case, and the only comparison in this file that is an equality
    // rather than a membership: with a window of zero the neighbourhood of every
    // anchor is the anchor, so the walk visits exactly the anchors the prefix rule
    // keeps, in the same order, and the delivered set is the same set. Without this
    // the radius would be confounded with every other difference in the unit.
    const control = await run({ relevanceUnits: 'turn' });
    const degenerate = await run({ relevanceUnits: 'anchor-window', windowRadius: 0 });

    expect(degenerate.carried).toEqual(control.carried);
  });

  it('completes the top anchor’s neighbourhood on a window of two', async () => {
    // `a3` is at position 3 of seven, so a window of two reaches positions 1..5.
    const treated = await run({ relevanceUnits: 'anchor-window', windowRadius: 2 });

    expect(treated.carried).toContain('a3');
    expect(treated.carried).toContain('a2');
    expect(treated.carried).toContain('a4');
    expect(treated.carried).toContain('a1');
    expect(treated.carried).toContain('a5');
  });

  it('stops at the radius, so the unit is a window and not the whole session', async () => {
    // The difference from `'session'`: positions 0 and 6 are one step beyond the
    // window and are not bought. Without this assertion a bug that ignored the radius
    // and took the session would pass every test above.
    const treated = await run({ relevanceUnits: 'anchor-window', windowRadius: 2 });

    expect(treated.carried).not.toContain('a0');
    expect(treated.carried).not.toContain('a6');
  });

  it('defaults the radius to two when the unit is named without one', async () => {
    // The reference implementation's frozen value (`expand window ±2`). Asserted as an
    // equality against the explicit setting so the default cannot drift silently.
    const omitted = await run({ relevanceUnits: 'anchor-window' });
    const explicit = await run({ relevanceUnits: 'anchor-window', windowRadius: 2 });

    expect(omitted.carried).toEqual(explicit.carried);
  });
});

describe('the neighbourhood is local to its session', () => {
  it('never reaches into the next session from a session’s last turn', async () => {
    // An anchor at the end of session A has no neighbours at the start of session B.
    // A window that spanned the concatenated list would pull `b0` and `b1` in here, which
    // is the one boundary the session routes exist to respect -- and it is exactly what a
    // naive `arrival ± radius` would do, because the flat list is the concatenation. B's
    // turns score nothing in this fixture so they can only arrive as someone's neighbour,
    // which is what makes their absence evidence of the clamp rather than of the ranking.
    const lastTurnScores = (_question: string, text: string): number =>
      text.startsWith('a6-') ? 1 : 0;
    const treated = await run(
      { relevanceUnits: 'anchor-window', windowRadius: 2 },
      [sessionA(), sessionB()],
      lastTurnScores,
    );

    expect(treated.carried).toContain('a6');
    expect(treated.carried).toContain('a5');
    expect(treated.carried).toContain('a4');
    // Positions 5 and 6 of A; the window is cut by the session's end, not wrapped.
    expect(treated.carried).not.toContain('b0');
    expect(treated.carried).not.toContain('b1');
  });

  it('clamps a window at the session’s first turn instead of underflowing', async () => {
    // Symmetric case, and the one an off-by-one in the slice bounds would crash on or
    // silently resolve to the previous session's tail.
    const firstTurnScores = (_question: string, text: string): number =>
      text.startsWith('b0-') ? 1 : text.startsWith('a') ? 0.4 : 0;
    const treated = await run(
      { relevanceUnits: 'anchor-window', windowRadius: 3 },
      [sessionA(), sessionB()],
      firstTurnScores,
    );

    expect(treated.carried).toContain('b0');
    expect(treated.carried).toContain('b1');
    expect(treated.carried).not.toContain('a6');
  });
});

describe('a neighbourhood that does not fit shrinks rather than starving', () => {
  it('still carries the top anchor whenever the turn unit carries anything', async () => {
    // The safety property, and it is a for-all rather than an example: at every budget
    // in the sweep, a window of three that cannot fit must fall back to smaller windows
    // and finally to the anchor alone, so the prompt is never emptier than the turn
    // unit's would be at the same budget. A strict prefix pass over whole windows fails
    // this at every budget where the first window overflows -- which is most of them.
    let sawBoth = 0;
    for (let maxPromptChars = 1_100; maxPromptChars <= 4_000; maxPromptChars += 100) {
      const control = await run({ relevanceUnits: 'turn', maxPromptChars });
      const treated = await run({
        relevanceUnits: 'anchor-window',
        windowRadius: 3,
        maxPromptChars,
      });

      if (control.carried.length === 0) continue;
      sawBoth += 1;
      expect(treated.carried.length).toBeGreaterThan(0);
      expect(treated.carried).toContain('a3');
    }

    // The sweep has to contain the case it claims to test.
    expect(sawBoth).toBeGreaterThan(5);
  });

  it('never exceeds the budget, at any radius', async () => {
    // A window spends room in blocks, which is where an off-by-one in the fit test would
    // show up as a prompt one turn over budget.
    for (const windowRadius of [0, 1, 2, 3, 5, 50]) {
      const treated = await run({ relevanceUnits: 'anchor-window', windowRadius });
      expect(treated.promptChars).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    }
  });

  it('rejects a radius that is not a non-negative integer', async () => {
    // A fractional or negative radius has no neighbourhood to name. Rejected rather than
    // clamped, because a clamped value would make a dispatched configuration describe a
    // window the run did not use -- the §7.3 side-channel defect.
    for (const windowRadius of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(run({ relevanceUnits: 'anchor-window', windowRadius })).rejects.toThrow(
        /windowRadius/,
      );
    }
  });
});

describe('the radius is inert on the units it does not belong to', () => {
  it('changes nothing on the turn, session and session-fill units', async () => {
    // `windowRadius` is a property of one unit. Left global without this test, a value
    // passed alongside `'session'` would either be silently ignored -- shipping an
    // artifact that claims a window it never used -- or, worse, be applied. Both are
    // excluded by requiring the four rendering units to be identical under it.
    for (const relevanceUnits of ['turn', 'session', 'session-fill'] as RelevanceUnits[]) {
      const without = await run({ relevanceUnits });
      const withRadius = await run({ relevanceUnits, windowRadius: 3 });
      expect(withRadius.carried).toEqual(without.carried);
    }
  });
});

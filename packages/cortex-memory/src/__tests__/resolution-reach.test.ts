/**
 * Whether the layered rendering actually reaches the prompt, and what it does to the room.
 *
 * `resolution.test.ts` proves the rule; this file proves the *wiring* — that the option reaches both
 * builders, that it is inert when absent, and that it buys turns rather than merely shortening them. The
 * two claims that matter are quantified in `DESIGN-C7-RESOLUTION-LAYERING.md` §14.133.2:
 *
 * 1. **The width is comparable by construction**: both arms fill the same room with the same prefix rule,
 *    so a prompt difference here is a difference in what one turn costs, not in which turns were wanted.
 *    The test asserts it as a property — the layered prompt is not *shorter* than the control by more than
 *    the turns it gained can explain; it is a reallocation.
 * 2. **Density, not compression**: `carried` rises or holds, `evidenceChars` falls or holds. A rendering
 *    that shortened every turn and delivered the same number of them would fail the second half.
 */
import { describe, expect, it } from 'vitest';

import type { AdmittedTurn } from '../admission.js';
import { CortexMemory } from '../memory.js';
import { buildPrompt, buildSessionPrompt } from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';
import type { CortexMemoryOptions } from '../types.js';

const CAP = 200;

/**
 * A question whose content terms do not occur in `FOREIGN_TURN`.
 *
 * This is the fixture that has to be checked rather than assumed, and it took two attempts. The first asked
 * "what did the treasurer say", and the turn contains "treasurer"; the second asked "how tall was the
 * sunflower", and the turn contains "how much discussion" -- `contentTerms` keeps "how", so the overlap test
 * was true again. Both times every turn rendered as an `excerpt`, which is longer than the cap by design, so
 * the density assertion read the opposite of the mechanism. A foreign question is what puts a turn into the
 * `record` form, and `record` is where the density comes from.
 */
const QUESTION = 'sunflower height record';

/** A turn long enough to be cut at the cap, with no term the question shares. */
const FOREIGN_TURN =
  'The allotment society meeting ran long because the treasurer wanted to explain the new fee ' +
  'structure in detail to everyone present, and then walked the whole whole hall through last ' +
  "year's accounts line by line. Nobody objected and the minutes were agreed without a vote, which " +
  'the chair said was unusual given how much discussion there had been about the boundary hedge. ' +
  'The plot rents go up to 42 pounds next season and the shed needs a new roof before winter.';

/** The same shape, but with the question's term in it. */
const MATCHING_TURN =
  'The allotment society meeting ran long because the treasurer wanted to explain the fee ' +
  'structure in detail. The plot rents go up to 42 pounds next season. Then we discussed the ' +
  'sunflower height competition at length and nobody could agree on how it should be measured, ' +
  'which took the rest of the evening and most of the biscuits.';

function turn(content: string, index = 0): AdmittedTurn {
  return { index, content, id: `t${index}` } as unknown as AdmittedTurn;
}

function session(index: number, turns: readonly AdmittedTurn[]): AdmittedSession {
  return { index, turns: [...turns], size: turns.length } as unknown as AdmittedSession;
}

/** The eleven foreign turns a flat prompt of this room can choose between. */
function foreignTurns(count = 11): AdmittedTurn[] {
  return Array.from({ length: count }, (_unused, index) => turn(FOREIGN_TURN, index));
}

describe('the layered rendering reaches the prompt', () => {
  it('absent is byte-identical to the head cut, so every archived prompt stays reproducible', () => {
    const turns = foreignTurns(3);
    const control = buildPrompt(QUESTION, turns, 'extractive', {
      maxTurnChars: CAP,
    });
    const explicitRaw = buildPrompt(QUESTION, turns, 'extractive', {
      maxTurnChars: CAP,
      resolution: 'raw',
    });
    expect(explicitRaw.prompt).toBe(control.prompt);
  });

  it('changes the bytes of a capped prompt, and only through the turn text', () => {
    const turns = [turn(FOREIGN_TURN, 0)];
    const control = buildPrompt(QUESTION, turns, 'extractive', {
      maxTurnChars: CAP,
    });
    const layered = buildPrompt(QUESTION, turns, 'extractive', {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    expect(layered.prompt).not.toBe(control.prompt);
    // The question and the contract are not the mechanism's to move.
    expect(layered.prompt).toContain(`QUESTION: ${QUESTION}`);
  });

  it('delivers at least as many turns in the same room, and charges fewer characters', () => {
    const turns = foreignTurns(11);
    const room = 1_400;
    const control = buildPrompt(QUESTION, turns, 'extractive', {
      maxTurnChars: CAP,
      maxChars: room,
    });
    const layered = buildPrompt(QUESTION, turns, 'extractive', {
      maxTurnChars: CAP,
      maxChars: room,
      resolution: 'layered',
    });
    expect(layered.carried.length).toBeGreaterThan(control.carried.length);
    expect(layered.evidenceChars).toBeLessThanOrEqual(control.evidenceChars);
    // Records rather than head cuts: the room did not grow, the turns got cheaper, and the prefix the
    // selector reaches is at least twice as long. Ten against five on this fixture.
    expect(layered.carried.length).toBeGreaterThanOrEqual(control.carried.length * 2);
    // The room is the room: a mechanism that overran it would be a bill the artifact does not report.
    expect(layered.prompt.length).toBeLessThanOrEqual(room);
  });

  it('gives a matching turn more than the cap, which is what makes matching worth having', () => {
    const matching = turn(MATCHING_TURN, 0);
    const control = buildPrompt('how tall was the sunflower', [matching], 'extractive', {
      maxTurnChars: CAP,
    });
    const layered = buildPrompt('how tall was the sunflower', [matching], 'extractive', {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    // `evidenceChars` includes the `N. ` numbering, so the bound carries its width rather than pretending
    // the rendered turn is the whole of what the room pays for.
    const numbering = 8;
    expect(control.evidenceChars).toBeLessThanOrEqual(CAP + numbering);
    expect(layered.evidenceChars).toBeGreaterThan(control.evidenceChars);
    expect(layered.evidenceChars).toBeLessThanOrEqual(CAP * 1.5 + numbering);
    expect(layered.prompt).toContain('sunflower height competition');
  });

  it('reaches the multi-session builder too, where the dateline is kept outside the ceiling', () => {
    const dated = `[2023/05/20 (Sat) 03:51] user: ${FOREIGN_TURN}`;
    const sessions = [session(0, [turn(dated, 0)])];
    const control = buildSessionPrompt(QUESTION, sessions, {
      maxTurnChars: CAP,
    });
    const layered = buildSessionPrompt(QUESTION, sessions, {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    expect(layered.prompt).not.toBe(control.prompt);
    expect(layered.prompt).toContain('[2023/05/20 (Sat) 03:51] user:');
  });

  it('leaves an uncapped route alone, because the resolution is a way of spending a cap', () => {
    const turns = foreignTurns(2);
    const control = buildPrompt(QUESTION, turns, 'extractive', {});
    const layered = buildPrompt(QUESTION, turns, 'extractive', {
      resolution: 'layered',
    });
    expect(layered.prompt).toBe(control.prompt);
  });
});

describe('the product refuses the configurations that could not act', () => {
  const base = { llm: { complete: async () => 'Answer: x' } } as unknown as CortexMemoryOptions;

  it("refuses resolution: 'layered' without a width, rather than rendering nothing differently", () => {
    expect(() => new CortexMemory({ ...base, resolution: 'layered' })).toThrow(
      /needs maxTurnChars/,
    );
  });

  it('refuses layered beside the window, because both decide which characters survive', () => {
    expect(
      () =>
        new CortexMemory({
          ...base,
          maxTurnChars: CAP,
          resolution: 'layered',
          turnWindow: 'match',
        }),
    ).toThrow(/cannot both be on/);
  });

  it('accepts layered beside a width, and the width alone', () => {
    expect(
      () => new CortexMemory({ ...base, maxTurnChars: CAP, resolution: 'layered' }),
    ).not.toThrow();
    expect(() => new CortexMemory({ ...base, maxTurnChars: CAP })).not.toThrow();
  });
});

/**
 * The answered instance, which is where the budget and the renderer meet.
 *
 * ## Why the three describes above are not enough
 *
 * They call `buildPrompt` and `buildSessionPrompt` directly, so they prove the *renderer* and leave
 * `#renderedChars` -- the estimate the width plan is handed -- untouched. That estimate is the defect
 * `43259468403` died of: a plan that budgeted raw lengths against a 400-character rendering, so
 * `fitToBudget` read the cap as non-binding and the mechanism did nothing on the two routes it existed for.
 * A second estimate here would be the same defect with a new cause, which is why the class calls the same
 * function; the only way to see that is to answer a question through the class and read the plan it reported.
 */
describe('the answered instance spends its budget through the same function', () => {
  /** A gate that admits everything, so the budget is the only thing the selection can be short of. */
  const OPEN_GATE = {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: Number.POSITIVE_INFINITY,
    valueFunction: () => 1,
  } as const;

  /** The plan that binds on twelve turns: half the relevance mass, no floor, no render margin. */
  const CUTTING = { coverage: 0.5, floorChars: 0, renderMargin: 1 } as const;

  const QUESTION = 'how many shoes were packed?';

  /**
   * Twelve turns that share the question's term, each well past the 300-character excerpt ceiling.
   *
   * Real prose rather than a filler token, and that is not cosmetic: a single 400-character word makes the
   * window's span end at the word that cannot fit, so `excerptAround` returns 15 characters and the two arms
   * are compared on a fixture where the form did something other than what the test is about. The first
   * version of this fixture did exactly that and the plan read 90 characters against the control's 1,200.
   */
  function topicalTurns(): string[] {
    return Array.from(
      { length: 12 },
      (_unused, index) =>
        `shoes packed ${index}: ${'the hall was full of boxes and coats. '.repeat(11)}`,
    );
  }

  function system(options: Partial<CortexMemoryOptions>): { memory: CortexMemory; seen: string[] } {
    const seen: string[] = [];
    const llm = {
      complete: async (prompt: string) => {
        seen.push(prompt);
        return 'answer';
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
    return {
      memory: new CortexMemory({
        now: 1_759_470_000_000,
        gate: OPEN_GATE as never,
        llm,
        ...options,
      }),
      seen,
    };
  }

  it('plans the room on the layered rendering, so the budget and the prompt agree', async () => {
    const raw = system({ maxTurnChars: CAP, widthPlan: CUTTING });
    await raw.memory.answer(QUESTION, topicalTurns());
    const layered = system({ maxTurnChars: CAP, widthPlan: CUTTING, resolution: 'layered' });
    await layered.memory.answer(QUESTION, topicalTurns());

    const rawWidth = raw.memory.lastWidth();
    const layeredWidth = layered.memory.lastWidth();
    expect(rawWidth?.reason).toBe('capped');
    expect(layeredWidth?.reason).toBe('capped');

    // The selector did not move: the ranking reads the turn's own content, and the form reads only its
    // length. Same funded prefix, so a different character count is a different *estimate* and not a
    // different set of turns -- which is what makes this test about the budget rather than about ranking.
    expect(layeredWidth!.plan!.turnsKept).toBe(rawWidth!.plan!.turnsKept);

    // Every funded turn is an `excerpt` at 1.5 x the cap here, because they all share the question's term.
    // The estimate has to be larger for exactly that reason; an unchanged number would mean
    // `#renderedChars` was still measuring `min(length, cap)` while the renderer printed a window.
    expect(layeredWidth!.plan!.evidenceChars).toBeGreaterThan(rawWidth!.plan!.evidenceChars);
    // And the prompt carries the window rather than the head: the marker is what a shortened turn says.
    expect(layered.seen.join('\n')).toContain('…');
  });

  it('forwards the window on the instance, so a matching turn keeps its match', async () => {
    // The window is the one rendering field whose forwarding has no other witness: `prompt.ts` renders a
    // head cut for `turnWindow: 'head'` and for an absent field alike, so a class that dropped the option
    // would produce a prompt that still looks like a prompt -- with the answer-bearing tail removed.
    const tail = 'the sunflower height was recorded in the shed notebook on the last page of it.';
    const turns = [
      `${'filler prose about the weather and the walk. '.repeat(8)}${tail}`,
    ] as string[];
    const question = 'where was the sunflower height recorded?';

    const head = system({ maxTurnChars: CAP });
    await head.memory.answer(question, turns);
    const match = system({ maxTurnChars: CAP, turnWindow: 'match' });
    await match.memory.answer(question, turns);

    expect(head.seen.join('\n')).not.toContain('shed notebook');
    expect(match.seen.join('\n')).toContain('shed notebook');
  });
});

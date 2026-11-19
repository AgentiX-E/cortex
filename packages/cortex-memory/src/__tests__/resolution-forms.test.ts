/**
 * Whether the artifact says which form each delivered turn took.
 *
 * `DESIGN-C7-RESOLUTION-LAYERING.md` §6 asks the artifact for three things — `resolution`, `evidenceForms`,
 * `formChars`, `eventsFitted` — because `F3` (density) is only decidable if the rendering that produced a
 * prompt is published beside it. `eventsFitted` already existed (`roleCensus.total`); the per-form split did
 * not, and §11.3 registered its absence as an ordering decision rather than an omission.
 *
 * This file closes that gap by asserting the projection at the only place that can produce it: the census
 * the renderer charges its turns to. Three properties are what make it a measurement rather than a label:
 *
 * 1. **One form per delivered turn.** The three counts sum to `cut + whole`, the census's own delivered
 *    count. A mechanism that counted a form twice, or charged a turn it did not deliver, is caught here.
 * 2. **Characters are the ones delivered.** Each form's `chars` is what the reader pays for that turn, so a
 *    form is charged exactly what `evidenceChars` charged for it.
 * 3. **Absent when no form chose.** A head cut is not a form, and `{ raw: 0, excerpt: 0, record: 0 }` beside
 *    a run that never had a choice would read as "the forms chose nothing" instead of "there was no form".
 */
import { describe, expect, it } from 'vitest';

import type { AdmittedTurn } from '../admission.js';
import type { AdmittedSession } from '../sessionize.js';
import {
  buildPrompt,
  buildSessionPrompt,
  buildTallyPrompt,
  type TurnWindowCensus,
} from '../prompt.js';
import { resolveCappedTurn } from '../resolution.js';

const CAP = 200;

/**
 * A question sharing no content term with either turn below.
 *
 * Checked rather than assumed, for the reason `resolution-reach.test.ts` records: `contentTerms` keeps
 * "how", so an innocent-looking question can put every turn into the `excerpt` form and make a density
 * assertion read the opposite of the mechanism.
 */
const FOREIGN_QUESTION = 'sunflower height record';

/** A question that shares a term with {@link MATCHING_TURN} and with nothing else. */
const MATCHING_QUESTION = 'how tall was the sunflower';

/** A turn long enough to be rendered by a form, sharing no term with {@link FOREIGN_QUESTION}. */
const FOREIGN_TURN =
  'The allotment society meeting ran long because the treasurer wanted to explain the new fee ' +
  'structure in detail to everyone present, and then walked the whole hall through last ' +
  "year's accounts line by line. Nobody objected and the minutes were agreed without a vote, which " +
  'the chair said was unusual given how much discussion there had been about the boundary hedge. ' +
  'The plot rents go up to 42 pounds next season and the shed needs a new roof before winter.';

/** The same shape, with the question's term inside it. */
const MATCHING_TURN =
  'The allotment society meeting ran long because the treasurer wanted to explain the fee ' +
  'structure in detail. The plot rents go up to 42 pounds next season. Then we discussed the ' +
  'sunflower height competition at length and nobody could agree on how it should be measured, ' +
  'which took the rest of the evening and most of the biscuits.';

/** A turn already inside the cap, which is the only way the `raw` form is reached. */
const SHORT_TURN = 'The shed roof was replaced in April and the rent is unchanged.';

function turn(content: string, index = 0): AdmittedTurn {
  return { index, content, id: `t${index}` } as unknown as AdmittedTurn;
}

function session(index: number, turns: readonly AdmittedTurn[]): AdmittedSession {
  return { index, turns: [...turns], size: turns.length } as unknown as AdmittedSession;
}

function foreignTurns(count: number): AdmittedTurn[] {
  return Array.from({ length: count }, (_unused, index) => turn(FOREIGN_TURN, index));
}

/** The projected split, or `undefined`, in one call. */
function formsOf(census: TurnWindowCensus | undefined): TurnWindowCensus['forms'] {
  return census?.forms;
}

describe('the census projects which form rendered each delivered turn', () => {
  it('is absent with no cap, because nothing chose a form', () => {
    const { turnWindow } = buildPrompt(FOREIGN_QUESTION, foreignTurns(2), 'extractive', {});
    expect(turnWindow).toBeDefined();
    expect(formsOf(turnWindow)).toBeUndefined();
  });

  it('is absent under the head cut, because a cut is a width and not a form', () => {
    const { turnWindow } = buildPrompt(FOREIGN_QUESTION, foreignTurns(2), 'extractive', {
      maxTurnChars: CAP,
    });
    expect(turnWindow).toBeDefined();
    expect(formsOf(turnWindow)).toBeUndefined();
  });

  it('counts a foreign long turn as a record, and no other form', () => {
    const { turnWindow } = buildPrompt(FOREIGN_QUESTION, [turn(FOREIGN_TURN)], 'extractive', {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    const forms = formsOf(turnWindow);
    expect(forms).toBeDefined();
    expect(forms?.record.turns).toBe(1);
    expect(forms?.excerpt.turns).toBe(0);
    expect(forms?.raw.turns).toBe(0);
  });

  it('counts a long turn sharing the question as an excerpt', () => {
    const { turnWindow } = buildPrompt(MATCHING_QUESTION, [turn(MATCHING_TURN)], 'extractive', {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    const forms = formsOf(turnWindow);
    expect(forms?.excerpt.turns).toBe(1);
    expect(forms?.record.turns).toBe(0);
  });

  it('counts a turn already inside the cap as raw, and charges its own length', () => {
    const { turnWindow } = buildPrompt(FOREIGN_QUESTION, [turn(SHORT_TURN)], 'extractive', {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    const forms = formsOf(turnWindow);
    expect(forms?.raw.turns).toBe(1);
    expect(forms?.raw.chars).toBe(SHORT_TURN.length);
    expect(forms?.excerpt.turns).toBe(0);
    expect(forms?.record.turns).toBe(0);
  });

  it('charges each form the characters the renderer charged, not the ones it started from', () => {
    // The expected value comes from the same function the renderer calls, which is the property being
    // asserted: the census reports the rendering that was delivered rather than a second opinion about it.
    const plan = resolveCappedTurn(FOREIGN_QUESTION, FOREIGN_TURN, CAP);
    const { turnWindow } = buildPrompt(FOREIGN_QUESTION, [turn(FOREIGN_TURN)], 'extractive', {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    expect(formsOf(turnWindow)?.record.chars).toBe(plan.chars);
    // And the plan is genuinely shorter than the cap here, so a census reporting the raw length would
    // pass a weaker assertion than this one.
    expect(plan.chars).toBeLessThan(CAP);
  });

  it('charges a dateline to the form that rendered the remainder, and counts the head in the cost', () => {
    const dated = `[2023/05/20 (Sat) 03:51] user: ${FOREIGN_TURN}`;
    const sessions = [session(0, [turn(dated, 0)])];
    const plan = resolveCappedTurn(FOREIGN_QUESTION, dated, CAP);
    const { turnWindow } = buildSessionPrompt(FOREIGN_QUESTION, sessions, {
      maxTurnChars: CAP,
      resolution: 'layered',
    });
    const forms = formsOf(turnWindow);
    expect(forms?.record.turns).toBe(1);
    expect(forms?.record.chars).toBe(plan.chars);
    // The head is not the ceiling's to spend, so the charged length exceeds the record's own ceiling
    // minus nothing: the assertion is that the head is *inside* the cost, not beside it.
    expect(forms?.record.chars).toBeGreaterThan(CAP * 0.6);
  });

  it('sums the three forms to the delivered turns, so no turn is counted twice or dropped', () => {
    const { turnWindow, carried } = buildPrompt(FOREIGN_QUESTION, foreignTurns(11), 'extractive', {
      maxTurnChars: CAP,
      maxChars: 1_400,
      resolution: 'layered',
    });
    const forms = formsOf(turnWindow);
    const census = turnWindow as TurnWindowCensus;
    expect(forms).toBeDefined();
    expect((forms?.raw.turns ?? 0) + (forms?.excerpt.turns ?? 0) + (forms?.record.turns ?? 0)).toBe(
      census.cut + census.whole,
    );
    expect(census.cut + census.whole).toBe(carried.length);
  });

  it('does not charge a collapsed turn to any form, because no form chose it', () => {
    const collapsed = turn(FOREIGN_TURN, 0);
    const { turnWindow } = buildPrompt(FOREIGN_QUESTION, [collapsed], 'extractive', {
      maxTurnChars: CAP,
      resolution: 'layered',
      superseded: {
        rendering: 'collapse',
        turns: new Map([[collapsed.id, 'The rent was replaced by 51 pounds.']]),
      },
    });
    const census = turnWindow as TurnWindowCensus;
    // The collapse is charged as a cut for its own reason, and the form census stays empty rather than
    // attributing a rendering no form produced.
    expect(census.cut + census.whole).toBe(1);
    expect(formsOf(turnWindow)).toBeUndefined();
  });

  it('does not double count when the budget re-renders, so the sum tracks the delivered set', () => {
    const turns = foreignTurns(11);
    for (const maxChars of [600, 900, 1_400, 4_000]) {
      const { turnWindow, carried } = buildPrompt(FOREIGN_QUESTION, turns, 'extractive', {
        maxTurnChars: CAP,
        maxChars,
        resolution: 'layered',
      });
      const census = turnWindow as TurnWindowCensus;
      const forms = formsOf(turnWindow);
      expect(
        (forms?.raw.turns ?? 0) + (forms?.excerpt.turns ?? 0) + (forms?.record.turns ?? 0),
      ).toBe(carried.length);
      expect(census.cut + census.whole).toBe(carried.length);
    }
  });
});

describe('the projected split is a function of the rendering alone', () => {
  it('is identical for two prompts built from the same turns and options', () => {
    const build = () =>
      buildPrompt(FOREIGN_QUESTION, foreignTurns(6), 'extractive', {
        maxTurnChars: CAP,
        maxChars: 1_200,
        resolution: 'layered',
      }).turnWindow;
    expect(formsOf(build())).toEqual(formsOf(build()));
  });

  it('publishes no census for an empty window, because there is nothing to count', () => {
    // The second-pass builder reaches its fits path with an empty session list, and a census of three zeros
    // there would read as "the window cut nothing" instead of "no window ran" -- the distinction
    // `TurnWindowCensus` states on its own docstring.
    const { turnWindow, carried } = buildTallyPrompt('what changed?', [], 'Step 1: nothing.');
    expect(carried).toEqual([]);
    expect(turnWindow).toBeUndefined();
  });

  it('moves when the cap moves, because the form boundaries are ratios of it', () => {
    const at = (cap: number) =>
      buildPrompt(FOREIGN_QUESTION, foreignTurns(6), 'extractive', {
        maxTurnChars: cap,
        maxChars: 2_000,
        resolution: 'layered',
      });
    // A cap below the fixture's length makes every turn a form; a cap above it makes every turn raw.
    // Counted against the delivered set rather than the admitted one: the room, not the cap, decides how
    // many turns are carried, and asserting six here was the fixture's mistake rather than the code's.
    const layered = at(200);
    const whole = at(4_000);
    expect(formsOf(layered.turnWindow)?.raw.turns).toBe(0);
    expect(formsOf(whole.turnWindow)?.raw.turns).toBe(whole.carried.length);
    expect(formsOf(whole.turnWindow)?.record.turns).toBe(0);
    expect(whole.carried.length).toBeLessThan(6);
  });
});

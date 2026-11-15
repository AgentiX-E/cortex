/**
 * The window's own census: how many delivered turns the cap cut, how many of those said so, and how
 * many arrived whole.
 *
 * ## The defect this is written against
 *
 * `MEASURE-TURN-WINDOW.md` §9.3 records `P1` -- *at least 90% of the items the control cut carry an
 * elision* -- as **unread**, not failed: the only source was the prompt text, and both parsers
 * available were wrong (blank-line splitting undercounts a cut prefix containing a blank line;
 * `^N. ` overcounts an assistant's own numbered list). Fifty-three of 200 prompts split differently
 * between the two sides for that reason alone. The document's §9.4 then makes the counter the first
 * item of the next increment, before the 500 x 4 dispatch: *computed where the cut happens, so that
 * `P1` is a field and not a parse*.
 *
 * ## What is counted, and at which line
 *
 * `contentFor` is the one place that decides whether a turn is printed whole or shortened, so the
 * tallies are incremented there rather than reconstructed from output. `cut + whole` must equal the
 * number of carried turns: a total that does not add up is a counter that missed a branch, which is
 * the failure mode this file exists to make impossible.
 *
 * `marked` is a subset of `cut`, not a sibling of it. A window always marks its elisions
 * (`MEASURE-TURN-WINDOW.md` §2: an excerpt that does not say it is an excerpt is the defect being
 * repaired), and the head cut marks only under `turnCutMarker: 'ellipsis'`. Counting them as
 * siblings would let a run report `cut 644, marked 0` and look consistent.
 */
import { describe, expect, it } from 'vitest';

import type { AdmittedTurn } from '../admission.js';
import { buildPrompt, formatEvidence } from '../prompt.js';

const CAP = 160;
const LONG =
  'The user talked about the weather, the traffic and a film they had seen. '.repeat(6) +
  'On the last Tuesday of the month they booked the pottery class in Kendal.';
const SHORT = 'The user booked the pottery class in Kendal on Tuesday.';
const QUESTION = 'When did they book the pottery class?';

function turn(content: string, index = 0): AdmittedTurn {
  return { index, content, id: `t${index}` } as unknown as AdmittedTurn;
}

describe('the turn window census', () => {
  it('counts every turn whole when no cap is configured', () => {
    const assembled = buildPrompt(QUESTION, [turn(LONG), turn(SHORT, 1)], 'abstention');

    expect(assembled.turnWindow).toEqual({ cut: 0, marked: 0, whole: 2 });
  });

  it('counts a truncated turn as cut and unmarked under the head cut', () => {
    const assembled = buildPrompt(QUESTION, [turn(LONG), turn(SHORT, 1)], 'abstention', {
      maxTurnChars: CAP,
    });

    expect(assembled.turnWindow).toEqual({ cut: 1, marked: 0, whole: 1 });
  });

  it('counts the same cut as marked when the marker is named', () => {
    const assembled = buildPrompt(QUESTION, [turn(LONG), turn(SHORT, 1)], 'abstention', {
      maxTurnChars: CAP,
      turnCutMarker: 'ellipsis',
    });

    expect(assembled.turnWindow).toEqual({ cut: 1, marked: 1, whole: 1 });
  });

  it('counts a windowed turn as cut and marked, because a window always marks', () => {
    const assembled = buildPrompt(QUESTION, [turn(LONG), turn(SHORT, 1)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    });

    expect(assembled.turnWindow).toEqual({ cut: 1, marked: 1, whole: 1 });
  });

  it('does not count a turn that fits the cap, even under the window', () => {
    const assembled = buildPrompt(QUESTION, [turn(SHORT)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    });

    expect(assembled.turnWindow).toEqual({ cut: 0, marked: 0, whole: 1 });
  });

  it('adds up: cut and whole are the carried turns, and marked is a subset of cut', () => {
    const turns = [turn(LONG, 0), turn(SHORT, 1), turn(LONG, 2), turn(SHORT, 3)];
    const assembled = buildPrompt(QUESTION, turns, 'abstention', {
      maxTurnChars: CAP,
      turnCutMarker: 'ellipsis',
    });

    const census = assembled.turnWindow;
    expect(census).toBeDefined();
    expect(census!.cut + census!.whole).toBe(assembled.carried.length);
    expect(census!.marked).toBeLessThanOrEqual(census!.cut);
  });

  it('reports nothing when the prompt carries no evidence', () => {
    // `undefined`, not `{cut: 0, marked: 0, whole: 0}`: an empty census and an absent one are the
    // same three zeros, and a reader could not tell "the window cut nothing" from "no window ran".
    expect(
      buildPrompt(QUESTION, [], 'abstention', { maxTurnChars: CAP }).turnWindow,
    ).toBeUndefined();
  });

  it('does not move the prompt by one byte', () => {
    // The census is a reading, not an input. `formatEvidence` called directly takes no tally and is
    // what every archived prompt was built from, so the builder's evidence block has to equal it --
    // a counter that changed what the reader saw would make this code unable to rebuild its own past.
    const assembled = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    });
    const direct = formatEvidence([turn(LONG)], {
      maxTurnChars: CAP,
      turnWindow: 'match',
      focusQuery: QUESTION,
    });

    expect(assembled.prompt).toContain(`EVIDENCE:\n${direct}`);
  });
});

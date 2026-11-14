/**
 * `#N`: one identifier per delivered turn, running across session boundaries.
 *
 * ## The defect this rendering is written against
 *
 * `buildSessionPrompt` renders one block per session, and each block numbers its turns **from one**.
 * That is right for a block read on its own and wrong for the question this route is worst at: the
 * counting question. `MR`'s eleven remaining failures whose gold is delivered are counting failures
 * (§13.342), and "how many bikes do I own" over three sessions of numbered-from-one blocks can only
 * be answered by counting each block and adding, with nothing in the prompt that says how many items
 * the reader has already passed.
 *
 * A global identifier makes the count readable off the prompt instead of off the reader's attention:
 * the last id is the number of items. It is the same evidence, the same order and the same
 * instruction -- the numbering scheme is the whole treatment, which is what lets a movement be
 * attributed to it.
 *
 * ## Why the control is asserted here rather than trusted
 *
 * The per-session restart is not an accident, it is `renderSessionBlocks` calling `formatEvidence`
 * once per session, and a rendering change that also renumbered the control would move two variables
 * at once. Two tests below hold the control byte for byte, and the last one strips the numbering
 * tokens from both renderings and asserts the bodies are identical -- so "one variable" is a property
 * the test measures rather than a claim the comment makes.
 */
import { describe, expect, it } from 'vitest';

import type { AdmittedTurn } from '../admission.js';
import type { AdmittedSession } from '../sessionize.js';
import { buildSessionPrompt, formatEvidence } from '../prompt.js';

let nextOrdinal = 0;

function turn(content: string): AdmittedTurn {
  return {
    id: content,
    content,
    value: 0.5,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic',
    tags: [],
    createdAt: 0,
    lastAccessedAt: 0,
    stability: 1,
    difficulty: 5,
    reads: 0,
    ordinal: nextOrdinal++,
  };
}

function session(index: number, contents: readonly string[]): AdmittedSession {
  return { index, size: contents.length, turns: contents.map(turn) };
}

const QUESTION = 'How many bikes do I currently own?';

/** The evidence text of a rendered prompt, i.e. everything before the question's own block. */
function evidenceOf(prompt: string): string[] {
  return prompt
    .split('\n\n')
    .map((segment) => segment.trim())
    .filter((segment) => /^(Session \d+|\d+\. |#\d+ )/.test(segment));
}

const TWO_SESSIONS = [
  session(0, ['I bought a red bike in March.', 'I sold the red bike in June.']),
  session(2, ['I bought a blue bike in July.']),
];

describe('the numbered control, held byte for byte', () => {
  it('restarts at one in every session block', () => {
    const { prompt } = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'numbered' });

    expect(prompt).toContain(
      'Session 1\n1. I bought a red bike in March.\n\n2. I sold the red bike in June.',
    );
    expect(prompt).toContain('Session 3\n1. I bought a blue bike in July.');
  });

  it('is what the builder does when no rendering is named', () => {
    const named = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'numbered' });
    const absent = buildSessionPrompt(QUESTION, TWO_SESSIONS, {});

    expect(absent.prompt).toBe(named.prompt);
  });
});

describe('the item-id rendering', () => {
  it('numbers across the session boundary instead of restarting', () => {
    const { prompt } = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'item-ids' });

    expect(prompt).toContain('#1 I bought a red bike in March.');
    expect(prompt).toContain('#2 I sold the red bike in June.');
    // The one line that distinguishes this rendering from the control: the third item is 3, not 1.
    expect(prompt).toContain('#3 I bought a blue bike in July.');
    expect(prompt).not.toContain('#1 I bought a blue bike in July.');
  });

  it('leaves no position-numbered line behind', () => {
    const { prompt } = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'item-ids' });
    const numbered = evidenceOf(prompt).filter((segment) => /^\d+\. /.test(segment));

    expect(numbered).toEqual([]);
  });

  it('keeps the session headers, because the boundary is not what moved', () => {
    const { prompt } = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'item-ids' });

    expect(prompt).toContain('Session 1');
    // The third session keeps its own number: a dropped session is not renumbered (§13 records why).
    expect(prompt).toContain('Session 3');
  });

  it('starts at the number it is given, so a block can continue the prompt', () => {
    const block = formatEvidence([turn('alpha'), turn('beta')], {
      rendering: 'item-ids',
      itemNumberStart: 5,
    });

    expect(block).toBe('#5 alpha\n\n#6 beta');
  });

  it('ignores the start when the rendering does not number by item', () => {
    // The option is only meaningful for this rendering, and applying it elsewhere would be a second
    // variable inside an arm registered on one.
    const numbered = formatEvidence([turn('alpha')], { rendering: 'numbered', itemNumberStart: 9 });
    const sourced = formatEvidence([turn('alpha')], { rendering: 'sourced', itemNumberStart: 9 });

    expect(numbered).toBe('1. alpha');
    expect(sourced).toBe('1. [alpha] alpha');
  });
});

describe('one variable, measured', () => {
  it('differs from the control only in the numbering tokens', () => {
    const strip = (prompt: string): string[] =>
      evidenceOf(prompt).map((segment) =>
        segment
          .split('\n')
          .map((line) => line.replace(/^([\d#]+\.?\s)/, ''))
          .join('\n'),
      );

    const control = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'numbered' });
    const treated = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'item-ids' });

    expect(strip(treated.prompt)).toEqual(strip(control.prompt));
  });

  it('adds and removes nothing, character for character', () => {
    // The token is `#N ` against `N. `, so the two prompts are the **same length**. That is the
    // property the spelling was chosen for: at `MR`'s 243-item prompts a five-character marker
    // would add 1,215 characters and push 8 of 121 questions past the route's cap, so the delivered
    // set would shrink and the reading would carry a coverage difference as well as a numbering one.
    const control = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'numbered' });
    const treated = buildSessionPrompt(QUESTION, TWO_SESSIONS, { rendering: 'item-ids' });

    expect(treated.prompt.length).toBe(control.prompt.length);
    expect(treated.carried.length).toBe(control.carried.length);
    expect(treated.evidenceChars).toBe(control.evidenceChars);
  });
});

/**
 * Composition, and the one property the whole design rests on.
 *
 * ## The property
 *
 * With `maxSteps: 0` the agent selects what the registered retrieval selects, and composing that
 * selection must produce the prompt the registered assembly produces -- **byte for byte**. If it
 * does not, the multi-step arm and the registered arm differ in two ways at once (evidence and
 * rendering) and no dispatch could attribute a difference to either. §14.98.5 makes this a
 * precondition of spending anything, so it is asserted here rather than discovered in an artifact.
 *
 * ## What the rest of the file asserts
 *
 * That the reader's order survives into print, that the room still cuts, and that the cut is taken
 * from the **front** of the reader's order rather than from the index's. Those three are the entire
 * content of "the selection is the reader's"; everything else is `cortex-memory`'s renderer, which
 * is tested where it lives.
 */
import { describe, expect, it } from 'vitest';

import { admitTurns, buildPrompt } from '@agentix-e/cortex-memory';

import { carriedIds, composeAgentPrompt } from '../compose.js';

const QUESTION = 'What did the charity race raise money for?';

const TURNS = [
  'I adopted a dog named Biscuit in March and named him after a biscuit tin.',
  'Biscuit the dog needed a dental cleaning, which the vet scheduled for next month.',
  'My sister moved to Lisbon last spring and says she will not come back.',
  'I ran the charity ten kilometre race in fifty two minutes on a cold morning.',
  'The race raised four hundred pounds for the animal shelter near the park.',
  'I am training for a half marathon in October, which is six months away.',
];

const ALL = [0, 1, 2, 3, 4, 5];

describe('composeAgentPrompt', () => {
  it('produces the registered prompt byte for byte when the selection is the retrieval', () => {
    const registered = buildPrompt(
      QUESTION,
      admitTurns(TURNS, { now: 0, threshold: 0 }),
      'abstention',
    );
    const composed = composeAgentPrompt(QUESTION, TURNS, ALL, { contract: 'abstention' });
    expect(composed.prompt).toBe(registered.prompt);
    expect(composed.evidenceChars).toBe(registered.evidenceChars);
    expect(carriedIds(composed)).toEqual(ALL);
  });

  it('prints the reader order, not the corpus order', () => {
    const composed = composeAgentPrompt(QUESTION, TURNS, [4, 3, 0], { contract: 'abstention' });
    expect(carriedIds(composed)).toEqual([4, 3, 0]);
    // And the numbering follows the printed order, which is what a reader cites.
    expect(composed.prompt).toContain('1. The race raised four hundred pounds');
    expect(composed.prompt).toContain('2. I ran the charity ten kilometre race');
    expect(composed.prompt).toContain('3. I adopted a dog named Biscuit');
  });

  it('cuts from the front of the reader order when the room binds', () => {
    // A room wide enough for a few turns. The cut must take the reader's first choices, which is the
    // only arrangement in which a selection can be said to have happened at all.
    const composed = composeAgentPrompt(QUESTION, TURNS, [4, 3, 2, 1, 0], {
      contract: 'abstention',
      maxChars: 620,
    });
    const carried = carriedIds(composed);
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.length).toBeLessThan(5);
    expect(carried).toEqual([4, 3, 2, 1, 0].slice(0, carried.length));
  });

  it('ignores a repeated id rather than carrying the turn twice', () => {
    const composed = composeAgentPrompt(QUESTION, TURNS, [3, 3, 4], { contract: 'abstention' });
    expect(carriedIds(composed)).toEqual([3, 4]);
  });

  it('scores identical text once, at its best rank', () => {
    // Two turns with the same words are the same evidence in a prompt, so the second must not lower
    // the score the first was given -- a `Map` built from entries would keep the last one and rank
    // the pair by their worse position.
    const repeated = ['the same words twice', 'a different turn', 'the same words twice'];
    const composed = composeAgentPrompt(QUESTION, repeated, [0, 1, 2], { contract: 'abstention' });
    expect(carriedIds(composed)).toEqual([0, 1, 2]);
    expect(composed.prompt).toContain('1. the same words twice');
  });

  it('ignores an id the corpus does not hold', () => {
    const composed = composeAgentPrompt(QUESTION, TURNS, [4, 99], { contract: 'abstention' });
    expect(carriedIds(composed)).toEqual([4]);
  });

  it('threads the temporal date, which is the one option a route cannot infer', () => {
    const composed = composeAgentPrompt(QUESTION, TURNS, [4], {
      contract: 'temporal',
      questionDate: '2024-03-15',
    });
    expect(composed.prompt).toContain('2024-03-15');
  });

  it('threads the ask, so a route can price a different instruction on the same evidence', () => {
    const plain = composeAgentPrompt(QUESTION, TURNS, [4], { contract: 'abstention' });
    const extractive = composeAgentPrompt(QUESTION, TURNS, [4], {
      contract: 'abstention',
      ask: 'extractive',
    });
    expect(extractive.prompt).not.toBe(plain.prompt);
    // The evidence itself is untouched: the ask changes what the reader is told, not what it reads.
    expect(extractive.evidenceChars).toBe(plain.evidenceChars);
  });
});

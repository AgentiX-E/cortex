/**
 * Rendering a caller's order through the shipped builder.
 *
 * ## What this file owns now
 *
 * These cases used to live beside the loop, because the loop imported the renderer. They moved with
 * the code: numbering, the room's cut, one score per distinct text and the treatment of ids the
 * corpus does not hold are all statements about **printed order**, which is this package's subject
 * and not the selector's.
 *
 * ## The property the first case states
 *
 * `renderInOrder` must be a strict superset of `buildPrompt(admitTurns(turns), ...)` when the order
 * is the corpus order. That is what makes it usable as "the registered renderer": an arm that passes
 * it prints what the arm would have printed with no selection at all, which is the only baseline a
 * multi-step reading can be differenced against.
 */
import { describe, expect, it } from 'vitest';

import { admitTurns } from '../admission.js';
import { buildPrompt } from '../prompt.js';
import { renderInOrder } from '../render-in-order.js';

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

/** The ids a prompt carries, in printed order. */
const ordinals = (prompt: { carried: readonly { ordinal: number }[] }): number[] =>
  prompt.carried.map((turn) => turn.ordinal);

describe('renderInOrder', () => {
  it('matches admission plus the builder when the order is the corpus order', () => {
    const rendered = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: ALL,
      config: { contract: 'abstention' },
    });
    const direct = buildPrompt(QUESTION, admitTurns(TURNS, { now: 0, threshold: 0 }), 'abstention');
    expect(rendered.prompt).toBe(direct.prompt);
    expect(rendered.evidenceChars).toBe(direct.evidenceChars);
    expect(ordinals(rendered)).toEqual(ALL);
  });

  it('prints the given order rather than the corpus order', () => {
    const rendered = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [4, 3, 0],
      config: { contract: 'abstention' },
    });
    expect(ordinals(rendered)).toEqual([4, 3, 0]);
    expect(rendered.prompt).toContain('1. The race raised four hundred pounds');
    expect(rendered.prompt).toContain('2. I ran the charity ten kilometre race');
    expect(rendered.prompt).toContain('3. I adopted a dog named Biscuit');
  });

  it('cuts from the front of the order when the room binds', () => {
    const rendered = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [4, 3, 2, 1, 0],
      config: { contract: 'abstention', maxChars: 620 },
    });
    const carried = ordinals(rendered);
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.length).toBeLessThan(5);
    expect(carried).toEqual([4, 3, 2, 1, 0].slice(0, carried.length));
  });

  it('skips a repeated id rather than spending the room on it twice', () => {
    const rendered = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [3, 3, 4],
      config: { contract: 'abstention' },
    });
    expect(ordinals(rendered)).toEqual([3, 4]);
  });

  it('drops an id the corpus does not hold', () => {
    const rendered = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [4, 99],
      config: { contract: 'abstention' },
    });
    expect(ordinals(rendered)).toEqual([4]);
  });

  it('scores identical text once, at its best rank', () => {
    // Two turns with the same words are the same evidence in a prompt, so the second must not lower
    // the score the first was given -- a map built from entries would keep the last one and rank the
    // pair by their worse position.
    const repeated = ['the same words twice', 'a different turn', 'the same words twice'];
    const rendered = renderInOrder({
      question: QUESTION,
      turns: repeated,
      ordered: [0, 1, 2],
      config: { contract: 'abstention' },
    });
    expect(ordinals(rendered)).toEqual([0, 1, 2]);
    expect(rendered.prompt).toContain('1. the same words twice');
  });

  it('threads the temporal date, which is the one option a route cannot infer', () => {
    const rendered = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [4],
      config: { contract: 'temporal', questionDate: '2024-03-15' },
    });
    expect(rendered.prompt).toContain('2024-03-15');
  });

  it('threads the ask without changing the evidence it is told about', () => {
    const plain = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [4],
      config: { contract: 'abstention' },
    });
    const extractive = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [4],
      config: { contract: 'abstention', ask: 'extractive' },
    });
    expect(extractive.prompt).not.toBe(plain.prompt);
    expect(extractive.evidenceChars).toBe(plain.evidenceChars);
  });

  it('names no date on a temporal route that supplies none, and still renders', () => {
    // The alternative -- refusing -- would make a caller's missing field a crash on the route whose
    // contract is about time, which is the route most likely to be driven from a partial artifact.
    const rendered = renderInOrder({
      question: QUESTION,
      turns: TURNS,
      ordered: [4],
      config: { contract: 'temporal' },
    });
    expect(rendered.prompt).toContain(TURNS[4] ?? '');
    expect(rendered.carried).toHaveLength(1);
  });
});

/**
 * The order the room was spent from, reported by the builder that spent it.
 *
 * ## The contradiction in an artifact that made this field necessary
 *
 * Round 147 made the product report its ranking (`rankingCensusOf`) so that `goldOverlap.carried < total`
 * could be read as "the ranking never surfaced it" or "the room cut it". The pool it reported came from
 * `SearchIndex.lastPool()`, i.e. from the order `search` returned -- and the window is **not** that order,
 * for two reasons that are both in `selectByRelevance` on purpose:
 *
 * 1. **The comparator quantises.** `orderableRelevance` rounds scores to a `1e-4` grid and breaks the
 *    resulting ties by arrival, which `R1` needed because two near-tied candidates were swapping a budget
 *    boundary between dispatches on provider noise. A quantised order is not the exact order.
 * 2. **The index deduplicates by text** (`lookup`'s `byText`), while the selection scores every turn it
 *    was given. A corpus that repeats a turn has one pool entry and two candidates.
 *
 * `a1cc6108` is the artifact's own witness: a gold turn at pool rank **199** on a question whose window
 * delivered **204** turns. Under "delivery is a prefix of the recorded order" that is impossible, so the
 * two numbers were positions in two different orders and the rank was a proxy rather than a measurement.
 *
 * ## What the field is, and what it is not
 *
 * `AssembledPrompt.ranking` is the selection's own order -- every candidate the selection considered,
 * best first, exactly as `selectByRelevance` sorted it. It is not a second scoring pass: the array is the
 * sorted candidate list the builder already had, so it cannot disagree with the window that was cut from
 * it. The invariant the tests below pin is that: **the first `carried.length` entries of `ranking` are the
 * carried set**, which is what makes a rank a position in the delivery rather than an adjacent fact.
 *
 * It is absent when no ranking ran, which is the same state `evidenceChars: 0` and `carried: []` report
 * for their own quantities: a clip has no order, and `[]` would read as "ranked and offered nothing".
 */
import { describe, expect, it } from 'vitest';

import { buildPrompt, formatEvidence } from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

const QUESTION = 'Q?';

function turn(content: string, ordinal: number): AdmittedTurn {
  return { id: `t${ordinal}`, content, ordinal } as unknown as AdmittedTurn;
}

/** A budget that leaves exactly `room` characters for the evidence section, from the measured prompt. */
function budgetForRoom(turns: readonly AdmittedTurn[], room: number): number {
  const full = buildPrompt(QUESTION, turns, 'extractive').prompt;
  const evidence = formatEvidence(turns);
  return full.length - (evidence.length - room);
}

describe('the order the selection spent', () => {
  it('is the selector’s order, so a near-tie is resolved the way the window resolved it', () => {
    // Two candidates a hair apart in the signal and one quantum apart in nothing: `0.49999` and `0.50001`
    // both round to `5000` at the comparator's `1e-4` grid, so the arrival order decides. The exact score
    // order is the *opposite* of the recorded order here, which is the only arrangement that
    // distinguishes a field reporting the selection from a field reporting the index.
    const turns = [turn('alpha', 0), turn('beta', 1), turn('gamma', 2)];
    const scores = new Map([
      ['alpha', 0.49999],
      ['beta', 0.50001],
      ['gamma', 0.1],
    ]);
    // The room is set below the whole evidence so a selection runs: a window that fits its corpus is not
    // cut from an order at all, and reports none (asserted in the last case below).
    const assembled = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, formatEvidence([turns[0]!]).length),
      relevanceFor: (_question, candidate) => scores.get(candidate) ?? 0,
    });

    expect(assembled.carried).toEqual([turns[0]]);
    expect(assembled.ranking).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('holds the turns the index deduplicates, because the selection scored both copies', () => {
    // `lookup` keeps one entry per text -- the first occurrence, which is its best score -- while the
    // selection scores every turn it was handed. A pool-shaped field would therefore be shorter than the
    // candidate list on exactly the corpora where a gold turn is repeated, and the rank of the *second*
    // copy would be the rank of the first.
    const turns = [turn('alpha', 0), turn('beta', 1), turn('alpha', 2)];
    const assembled = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, formatEvidence([turns[0]!]).length),
      relevanceFor: (_question, candidate) => (candidate === 'alpha' ? 1 : 0),
    });

    expect(assembled.ranking).toEqual(['alpha', 'alpha', 'beta']);
  });

  it('is the prefix the window bought, not a longer list beside it', () => {
    // The invariant that makes a rank readable: the first `carried.length` entries of the order are the
    // turns the prompt carries. Without it a rank inside the delivery is not evidence that the turn was
    // delivered, which is exactly the reading `a1cc6108` broke.
    const turns = Array.from({ length: 6 }, (_, index) =>
      turn(`turn ${index}`.padEnd(40, '.'), index),
    );
    const scores = new Map([
      [turns[0]!.content, 0.1],
      [turns[1]!.content, 0.9],
      [turns[2]!.content, 0.2],
      [turns[3]!.content, 0.05],
      [turns[4]!.content, 0.3],
      [turns[5]!.content, 0.15],
    ]);
    const room = formatEvidence([turns[1]!, turns[4]!, turns[2]!]).length;
    const assembled = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, room),
      relevanceFor: (_question, candidate) => scores.get(candidate) ?? 0,
    });

    expect(assembled.carried).toHaveLength(3);
    expect(new Set(assembled.ranking!.slice(0, assembled.carried.length))).toEqual(
      new Set(assembled.carried.map((entry) => entry.content)),
    );
    // And the order is the selection's, not arrival's: `beta`, `epsilon`, `gamma` by score.
    expect(assembled.ranking!.slice(0, 3)).toEqual([
      turns[1]!.content,
      turns[4]!.content,
      turns[2]!.content,
    ]);
  });

  it('is absent when the window was not cut from an order', () => {
    // Two states, one value, and both are "no order": a clip never consulted a signal, and a window that fits
    // its whole corpus consulted one but spent nothing on its order -- reporting it there would make the
    // builder pay a ranking to answer a question about a cut that did not happen (`evidence-relevance.test.ts`
    // pins the zero score calls). `[]` would say "ranked and offered nothing", a finding about the corpus.
    const turns = [turn('alpha', 0), turn('beta', 1)];
    expect(buildPrompt(QUESTION, turns, 'extractive').ranking).toBeUndefined();
    expect(
      buildPrompt(QUESTION, turns, 'extractive', {
        relevanceFor: (_question, candidate) => (candidate === 'beta' ? 1 : 0),
      }).ranking,
    ).toBeUndefined();
  });
});

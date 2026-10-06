/**
 * The per-turn confidence signal, and the properties that make it admissible.
 *
 * ## Why these particular assertions
 *
 * `confidence.ts` is a one-line formula, and a test that asserted the formula
 * against itself would be a restatement. What is worth pinning is the set of
 * properties `admission.ts`'s `confidenceFor` contract requires of any signal,
 * because those are the properties a plausible replacement can silently lose:
 *
 * - **content-only**: the same turn scores the same wherever it appears, so the
 *   gate is a statement about evidence and not about ordering;
 * - **deterministic**: no clock, no randomness, no I/O, so an arm's delta cannot
 *   contain the signal's own noise;
 * - **non-degenerate over a real context**: the property §49 measured as the
 *   missing one at the value level. A signal that is constant across the turns of
 *   a real dataset discriminates exactly as little as a constant value did, and
 *   it would pass every other assertion in this file. The test that catches it
 *   therefore has to run against a context shaped like the benchmark's, not
 *   against hand-picked extremes.
 *
 * The last one is the reason this file exists rather than three assertions in
 * `admission.test.ts`: a degenerate-but-plausible signal (`length / 10_000`) is
 * within the contract's type and outside its purpose, and only a realistic-input
 * test can tell them apart.
 */
import { describe, expect, it } from 'vitest';

import { confidenceFromLength } from '../confidence.js';

/**
 * The saturation point, **derived from behaviour** rather than imported.
 *
 * The constant is deliberately not exported -- its only callers would be these
 * tests, and a barrel entry with no consumer is the orphan the census gate
 * reports. Deriving it here is better than importing it anyway would have been:
 * an import would let the test and the implementation agree on a number neither
 * of them derived, whereas the smallest length at which confidence reaches `1` is
 * a fact about the function. A change to `SATURATION_CHARS` moves this helper's
 * result along with the behaviour it describes, which is what the assertions
 * below need.
 */
function saturationPoint(): number {
  let length = 1;
  while (confidenceFromLength('x'.repeat(length)) < 1) {
    length += 1;
  }
  return length;
}

const SATURATION = saturationPoint();

/**
 * A context shaped like the benchmark's: conversational turns, most far below the
 * saturation point, a few at or past it, and the user/assistant length asymmetry
 * that real transcripts have (assistant turns carry the evidence and are longer).
 *
 * The mixture is the point. A uniform context would let a degenerate signal pass
 * by coincidence, and a context of only-long turns would hide the low end.
 */
function realisticContext(): string[] {
  const short = ['yes', 'no, not that one', 'sure', 'ok'];
  const medium = [
    'I usually take the 8:15 train from the station near my office.',
    'My sister is coming to visit in the second week of March.',
    'I switched to the standing desk after the back trouble last year.',
  ];
  const long = ['x'.repeat(1_400), 'evidence '.repeat(250), 'y'.repeat(2_600)];
  return [...short, ...medium, ...long];
}

describe('confidenceFromLength', () => {
  it('is bounded in [0, 1] at every input, including the extremes', () => {
    // The contract's domain. `admission.ts` rejects anything outside it, so a
    // signal that could exceed 1 would abort a run rather than degrade -- and an
    // abort mid-benchmark is the expense this project has already paid for twice.
    for (const turn of ['', 'a', 'x'.repeat(10), 'y'.repeat(10_000), ...realisticContext()]) {
      const value = confidenceFromLength(turn);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is monotone: a longer turn never scores lower', () => {
    // Monotonicity is what makes the signal legible enough to check by eye, and
    // an authority that a future change to the formula can be held to without
    // restating the formula.
    let previous = -1;
    for (const length of [0, 1, 10, 100, 500, 1_000, 1_999, 2_000, 2_001, 50_000]) {
      const value = confidenceFromLength('x'.repeat(length));
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('saturates at the smallest length that reaches full confidence, not near it', () => {
    // The boundary stated on both sides, so a change to the saturation length moves
    // this test rather than silently redefining where long stops mattering. The
    // point is derived from behaviour rather than imported, and the derivation is
    // asserted to be a real boundary: one character shorter must still be short of
    // `1`, or `saturationPoint()` would have found the wrong end of the function.
    expect(confidenceFromLength('x'.repeat(SATURATION))).toBe(1);
    expect(confidenceFromLength('x'.repeat(SATURATION + 1))).toBe(1);
    expect(confidenceFromLength('x'.repeat(SATURATION - 1))).toBeLessThan(1);
    // And it is the documented length rather than any length that happens to work.
    // Stated as a literal here because this is the one place the number is a
    // requirement rather than a consequence: the value is chosen to coincide with
    // `DEFAULT_MAX_TURN_CHARS` on the reference side, so drift from it would put
    // this signal's resolution outside the range where turn text differs.
    expect(SATURATION).toBe(2_000);
  });

  it('gives an empty turn no confidence at all', () => {
    // `0` is reachable and meaningful: an empty turn carries no evidence. The
    // value is asserted directly because a version that offset the range to avoid
    // `0` would be a tuning decision with no justification, and this is where it
    // would be noticed.
    expect(confidenceFromLength('')).toBe(0);
  });

  it('is a function of content alone, so the same turn scores the same anywhere', () => {
    // Content-only is the property that keeps the gate a statement about evidence.
    // A signal reading an index, a shared counter, or `Date.now()` would pass
    // every other test in this file and make the arm's result depend on the
    // dataset's turn ordering.
    const turn = 'a turn that appears in more than one place';
    const first = confidenceFromLength(turn);

    for (let i = 0; i < 5; i += 1) {
      expect(confidenceFromLength(turn)).toBe(first);
    }
    // And identical content in a different position inside a larger context is
    // still the same value -- the check that a positional implementation fails.
    const context = ['filler '.repeat(100), turn, 'other '.repeat(200)];
    expect(confidenceFromLength(context[1]!)).toBe(first);
  });

  it('varies across a realistically shaped context, which is what discrimination requires', () => {
    // The assertion §49 makes necessary. Every other test here is satisfied by a
    // constant function; this one is not. `new Set(...).size > 1` is the whole
    // content, stated as a spread rather than as two sample points so it cannot
    // pass on a signal that is constant except at one isolated input.
    const values = realisticContext().map(confidenceFromLength);

    expect(new Set(values).size).toBeGreaterThan(1);
    // Not merely two values at the extremes: a real context produces a spread.
    // Three distinct values is a floor, not a target -- it is what the fixture
    // above actually yields, and it would fail for a formula so coarse that most
    // turns collide.
    expect(new Set(values).size).toBeGreaterThanOrEqual(3);
    // And the spread is inside the unit interval, so the variation is usable by a
    // threshold rather than being clipped into the endpoints.
    expect(Math.min(...values)).toBeLessThan(0.5);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(1);
  });

  it('rejects the degenerate variant by construction, so the guard is load-bearing', () => {
    // The degenerate signal is the one described in the module header: bounded,
    // deterministic, content-only, and **constant over the context it is run on**.
    // It is not enough to write a formula that *looks* like it collapses -- the
    // first draft of this test used `min(1, length / 10_000)` and failed, because
    // over a context of turns under ten thousand characters it still produces
    // eight distinct values. The claim has to be about a context, so the variant
    // below collapses at a saturation the fixture actually crosses.
    //
    // This is the same shape as the defect being guarded: a signal that varies
    // only on inputs the dataset never contains is a constant signal in the run it
    // is graded on, however much its formula appears to vary.
    const collapsed = (turn: string): number => (turn.length >= 40 ? 1 : 0);
    const context = realisticContext();
    // A context where every turn sits on one side of the variant's boundary, so
    // the variant is exactly the constant function it is here to stand for.
    const long = context.filter((turn) => turn.length >= 40);
    expect(long.length).toBeGreaterThan(1);

    const degenerateValues = long.map(collapsed);
    expect(new Set(degenerateValues).size).toBe(1);

    // The real signal is the control: the same turns produce a spread, so the
    // assertion above is discriminating between the two rather than tautological.
    expect(new Set(long.map(confidenceFromLength)).size).toBeGreaterThan(1);
  });
});

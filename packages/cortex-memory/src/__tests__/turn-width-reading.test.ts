/**
 * The reading `test/turn-width/result.json` records: a sweep of the per-turn cap over one archived
 * report, and the identities that have to hold inside it.
 *
 * ## Why this reading exists at all
 *
 * `MEASURE-GOLD-BAND.md` established that 487 of the 7,516 annotated gold turns arrive and are then
 * cut at `maxTurnChars = 400`, and that 18 of `MR`'s 19 failures carry at least one. The next
 * question is "how wide", and the tempting answer -- wide enough for the longest gold turn, 1,058
 * characters, so 1,200 -- is wrong, because the room is spent to within one turn (median 117
 * characters of 48,460 unspent). A wider turn does not arrive in extra room; it takes the room of
 * the turn behind it. The sweep is the measurement that prices that trade, and this file pins it so
 * that the registration which quotes it cannot quote it wrongly.
 *
 * ## What it asserts, and what it cannot
 *
 * It asserts internal consistency -- that the coverage column is `whole / total`, that the peak is
 * where the file says, that widening past it loses gold rather than gaining it, and that the
 * uncapped capabilities did not move at any width. It does **not** assert that the projection is
 * right: the projection transports conditional rates measured on one run, and only a dispatch can
 * say whether they travel. `MEASURE-TURN-WIDTH.md` states that limit in prose and the registration
 * prices it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const READING_PATH = new URL('../../test/turn-width/result.json', import.meta.url);

interface Cell {
  readonly total: number;
  readonly whole: number;
  readonly cut: number;
  readonly absent: number;
  readonly allWhole: number;
  readonly asked: number;
  readonly projection: {
    readonly value: number | null;
    readonly why?: string;
    readonly gap?: number;
    readonly cells?: Record<string, string>;
  };
}

interface Row {
  readonly width: number;
  readonly byCapability: Record<string, Cell>;
  readonly all: {
    readonly total: number;
    readonly whole: number;
    readonly cut: number;
    readonly absent: number;
  };
}

interface Reading {
  readonly cap: number;
  readonly routes: string[];
  readonly questions: number;
  readonly fidelity: {
    readonly replayed: number;
    readonly total: number;
    readonly failures: string[];
  };
  readonly rows: Row[];
}

const reading: Reading = JSON.parse(readFileSync(READING_PATH, 'utf8'));
const at = (width: number): Row => {
  const row = reading.rows.find((candidate) => candidate.width === width);
  if (row === undefined) throw new Error(`the sweep does not contain width ${width}`);
  return row;
};
const cell = (width: number, capability: string): Cell => {
  const found = at(width).byCapability[capability];
  if (found === undefined) throw new Error(`width ${width} has no row for ${capability}`);
  return found;
};

describe('the turn-width sweep', () => {
  it('sweeps the shipped cap and says which arm it swept', () => {
    // The artifact is the shipped arm: 400 characters on the two routes that carry a cap. A sweep
    // taken from a different arm would still be a sweep, and would price a different product.
    expect(reading.cap).toBe(400);
    expect(reading.routes).toEqual(['multi-session', 'temporal']);
    expect(reading.rows[0]?.width).toBe(400);
    expect(reading.rows.length).toBeGreaterThan(8);
  });

  it('replays the allocator rather than modelling it', () => {
    // The counterfactual is only worth what the replayer is worth, so the replayer is checked at the
    // shipped width against the set the artifact says was delivered. One question misses -- the
    // `temporal` question recorded with no room left -- and naming it is the difference between a
    // measured fidelity and a claimed one.
    expect(reading.fidelity.total).toBe(248);
    expect(reading.fidelity.replayed).toBe(247);
    expect(reading.fidelity.failures).toEqual(['bcbe585f']);
  });

  it('reproduces the two bands MEASURE-GOLD-BAND counted at the shipped width', () => {
    // 1,557 whole and 245 cut out of 1,832 annotated `MR` gold turns is section 178.2's row. If this
    // drifts, one of the two documents is reading a different artifact.
    const mr = cell(400, 'MR');
    expect(mr.total).toBe(1832);
    expect(mr.whole).toBe(1557);
    expect(mr.cut).toBe(245);
    expect(mr.absent).toBe(30);
  });

  it('puts the coverage peak at 600 and nowhere else', () => {
    // Coverage is `whole / total`, the quantity section 13.26 measured accuracy against. The peak is
    // unique in the ladder: every other width is lower, which is what makes 600 a solution rather
    // than a preference.
    const coverage = (width: number): number => {
      const mr = cell(width, 'MR');
      return mr.whole / mr.total;
    };
    const peak = reading.rows.reduce(
      (best, row) => (coverage(row.width) > coverage(best) ? row.width : best),
      400,
    );
    expect(peak).toBe(600);
    expect(coverage(600)).toBeCloseTo(0.941594, 6);
    for (const row of reading.rows) {
      if (row.width === 600) continue;
      expect(coverage(row.width)).toBeLessThan(coverage(600));
    }
  });

  it('pays for the width in absent gold rather than in a longer prompt', () => {
    // The trade the sweep prices: 245 cut gold turns fall to 28, and 30 absent gold turns rise to 79.
    // Both numbers are in the registration's prediction, so both are pinned here.
    expect(cell(600, 'MR').cut).toBe(28);
    expect(cell(600, 'MR').absent).toBe(79);
    // The trade starts immediately: the first step already buys whole turns with absent ones.
    expect(cell(450, 'MR').whole).toBeGreaterThan(cell(400, 'MR').whole);
    expect(cell(450, 'MR').absent).toBeGreaterThan(cell(400, 'MR').absent);
  });

  it('loses wholesale past the peak, which is why 1,200 is not the answer', () => {
    // 1,058 is the longest gold turn among `MR`'s failures, so 1,200 "covers the population" -- and
    // still carries 142 fewer whole gold turns than 600 does. A width chosen from the tail of a
    // length distribution is not a width chosen from the allocator's behaviour.
    expect(cell(1_200, 'MR').whole).toBe(1667);
    expect(cell(1_200, 'MR').whole).toBeLessThan(cell(600, 'MR').whole);
    expect(cell(1_200, 'MR').absent).toBe(164);
  });

  it('leaves the uncapped capabilities byte-identical at every width', () => {
    // `IE`, `KU` and `ABS` carry no cap, so the sweep is not a treatment on them. If any of their
    // three bands moved, the sweep would be changing something other than the width.
    for (const capability of ['IE', 'KU', 'ABS']) {
      const first = cell(400, capability);
      for (const row of reading.rows) {
        const other = cell(row.width, capability);
        expect(other.whole).toBe(first.whole);
        expect(other.cut).toBe(first.cut);
        expect(other.absent).toBe(first.absent);
      }
    }
  });

  it('prints a projection only where every cell holds a rate', () => {
    // One rate per cell over a partition of the same questions is saturated: it reproduces the run
    // by construction, so the column is printed with the gap it transports rather than as a
    // prediction. `IE`, `KU` and `ABS` have complete rows of 0 to 26 questions, and a rate over four
    // questions is not a rate -- those cells are refused by name instead of being filled in.
    expect(cell(400, 'MR').projection.value).toBeCloseTo(102, 6);
    expect(cell(600, 'MR').projection.value).toBeCloseTo(107.922, 3);
    for (const capability of ['IE', 'KU', 'ABS']) {
      expect(cell(600, capability).projection.value).toBeNull();
      expect(cell(600, capability).projection.why).toContain('under');
    }
  });

  it('carries a 14.6-point gap on MR and a zero gap on TR', () => {
    // The whole content of the projection, and the reason the same treatment is registered for one
    // capability and only guarded for the other: on `MR` a complete-and-uncut question reads 14.6
    // points better than a complete-and-cut one, so converting a cut into an uncut is predicted to
    // pay. On `TR` the two read the same, so a width that converts one into the other is predicted
    // to do nothing -- which is consistent with `TR` gaining 10 points of covered gold and losing
    // half a question, and is why its covered-gold column must never be read alone.
    expect(cell(600, 'MR').projection.gap).toBeCloseTo(0.1461, 4);
    expect(cell(600, 'TR').projection.gap).toBeCloseTo(0, 6);
    // `TR`'s covered gold rises 70.22% -> 80.19% at the same width, against a projection that ends
    // where it started.
    expect(cell(600, 'TR').whole).toBe(1295);
    expect(cell(400, 'TR').whole).toBe(1134);
    const at600 = cell(600, 'TR').projection.value ?? Number.NaN;
    const at400 = cell(400, 'TR').projection.value ?? Number.NaN;
    expect(at600).toBeLessThan(at400);
    expect(at400).toBeCloseTo(120, 6);
  });

  it('does not let the projection decide the width on its own', () => {
    // The transported curve is a plateau: 550 through 1,200 all land within 0.9 questions of each
    // other, so it can veto a width but cannot pick one. Registering 600 on the strength of its
    // projection would be registering noise; it is registered on coverage, and the projection is
    // only allowed to say the effect should be positive at all.
    const values = reading.rows
      .filter((row) => row.width >= 550 && row.width <= 1_200)
      .map((row) => cell(row.width, 'MR').projection.value ?? Number.NaN);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
  });
});

/**
 * The admission census: what the write gate computed, and what it did with it.
 *
 * ## The defect these tests exist for
 *
 * The gate's two variables were made reachable in §49 — `sourceTrust` raises the ceiling,
 * `confidenceFor` supplies the variation — and the artifact could then state the
 * configuration. It could not state whether the configuration **did anything**, and run
 * `37110579101` is the recorded case of a repaired program scoring what the unrepaired one
 * did: `retrievalThreshold: 0` could not close a gate whose maximum observable value was
 * `0.5`.
 *
 * The first draft of this instrument counted the turns that were **admitted**, and that
 * draft is the reason the first test below is written the way it is: every admitted turn is
 * above the threshold by construction, so a census of admitted turns reports
 * `rejected: 0` for every configuration that has ever run. It was arithmetically incapable
 * of answering its own question. The counts are over candidates, and the criterion is
 * `rejected > 0` — the exact statement "the gate cut something".
 */
import { describe, expect, it } from 'vitest';
import {
  AdmissionCensusBuilder,
  admitTurns,
  type AdmissionCensus,
  type AdmissionOptions,
} from '../admission.js';

/**
 * The census of one admission.
 *
 * `cortex-memory` has no separate `evaluateTurns` entry point: the sink travels inside
 * `AdmissionOptions`, so `admitTurns` already returns the turns and writes the counts. A second
 * function that returned both would be a second definition of "what an admission is", and the
 * export census rejected it on the day it was written for having no caller outside this file.
 */
function evaluate(turns: readonly string[], config: AdmissionOptions) {
  const tally = new AdmissionCensusBuilder();
  const admitted = admitTurns(turns, { ...config, tally });
  return { admitted, census: tally.census(config.threshold) };
}

/** The census the builder saturates at, asserted at its documented value. */
const DISTINCT_CAP = 64;

const NOW = 1_700_000_000_000;

function turn(label: string): string {
  return `the user said something about ${label} and it was recorded in full`;
}

function options(overrides: Partial<AdmissionOptions> = {}): AdmissionOptions {
  return { now: NOW, threshold: 0.3, ...overrides };
}

describe('the census of one admission', () => {
  it('reports a pass-through gate as a pass-through, not as a success', () => {
    // The identity configuration: threshold 0 admits everything, so `value >= 0` holds for
    // every turn and the gate cannot have decided anything. An instrument that reported
    // "3 admitted" would describe a mechanism that never operated.
    const { admitted, census } = evaluate(
      [turn('alpha'), turn('beta'), turn('gamma')],
      options({ threshold: 0 }),
    );

    expect(admitted).toHaveLength(3);
    expect(census.candidates).toBe(3);
    expect(census.admitted).toBe(3);
    expect(census.rejected).toBe(0);
    expect(census.threshold).toBe(0);
  });

  it('counts the turns the gate refused, which is the field the criterion reads', () => {
    // Two turns at confidence 1, one at confidence 0. With `sourceTrust: 1` the value is
    // `confidence * 1 * (0.5 + 0.5 * 1)` = confidence, so a 0.3 threshold keeps two and
    // refuses one.
    const turns = [turn('alpha'), turn('beta'), turn('gamma')];
    const { admitted, census } = evaluate(
      turns,
      options({
        threshold: 0.3,
        sourceTrust: 1,
        // One weak turn among two strong ones, so the cut has something to cut and the
        // admitted list is still readable by eye.
        confidenceFor: (content) => (content.includes('gamma') ? 0 : 1),
      }),
    );

    expect(admitted.map((a) => a.content)).toEqual([turn('alpha'), turn('beta')]);
    expect(census.candidates).toBe(3);
    expect(census.admitted).toBe(2);
    expect(census.rejected).toBe(1);
    expect(census.distinct).toBe(2);
  });

  it('reports the arithmetic over every candidate, not over the survivors', () => {
    // Hand-computed. `sourceTrust: 1` and `recency` exactly 1 (admission sets
    // `lastAccessedAt === createdAt === now`), so `value = confidence`; the three
    // confidences are 1, 0 and 0.5, and a 0.4 threshold keeps two of them.
    const byLabel = new Map([
      [turn('a'), 1],
      [turn('b'), 0],
      [turn('c'), 0.5],
    ]);
    const { census } = evaluate(
      [turn('a'), turn('b'), turn('c')],
      options({
        threshold: 0.4,
        sourceTrust: 1,
        confidenceFor: (content) => byLabel.get(content) ?? 0,
      }),
    );

    expect(census.min).toBe(0);
    expect(census.max).toBe(1);
    expect(census.mean).toBeCloseTo(0.5, 12);
    expect(census.distinct).toBe(3);
    expect(census.rejected).toBe(1);
  });

  it('reconciles with the turns it returned, because there is one loop and not two', () => {
    // A separate counting pass would be a second place for "what counts as a candidate" to
    // be decided, and the two would drift in the direction that flatters the run. The
    // reconciliation is asserted against `admitTurns` called without a sink, which is the
    // same loop reached through the only entry point there is.
    const turns = [turn('alpha'), turn('beta'), turn('gamma'), turn('delta')];
    const config = options({ threshold: 0.25, sourceTrust: 1, confidenceFor: () => 0.5 });

    const observed = evaluate(turns, config);
    expect(observed.admitted).toEqual(admitTurns(turns, config));
    expect(observed.census.admitted).toBe(observed.admitted.length);
    expect(observed.census.candidates).toBe(turns.length);
  });

  it('cannot produce a value outside [0, 1], because `decideWrite` clamps at the source', () => {
    // `confidenceFor` is validated by this layer (`validateConfidence` throws on 7), so the
    // escape has to arrive through a custom `valueFunction`, which is a documented
    // extension point with no range contract. Asserting the bound here is what makes the
    // arithmetic above interpretable: `mean` and `threshold` share a unit only if every
    // value is in it.
    const { census } = evaluate([turn('alpha')], options({ threshold: 0, valueFunction: () => 7 }));

    expect(census.max).toBe(1);
    expect(census.min).toBe(1);

    const negative = evaluate(
      [turn('alpha')],
      options({ threshold: 0, valueFunction: () => -3 }),
    ).census;
    expect(negative.min).toBe(0);
    expect(negative.rejected).toBe(0);
  });

  it('reports an empty admission as empty rather than as a minimum of zero', () => {
    // `candidates: 0` is the field that distinguishes "nothing was offered" from
    // "everything was refused". Without it, a route that declined before admitting and a
    // route whose threshold refused all of its turns would look identical.
    const { admitted, census } = evaluate([], options());

    expect(admitted).toEqual([]);
    expect(census).toEqual({
      threshold: 0.3,
      candidates: 0,
      admitted: 0,
      rejected: 0,
      min: 0,
      max: 0,
      mean: 0,
      distinct: 0,
      distinctSaturated: false,
    } satisfies AdmissionCensus);
  });

  it('serialises without loss, which rules out the two values JSON turns into null', () => {
    // An empty admission is the case that produces `Infinity` from a naive `min`/`max`
    // fold, and `JSON.stringify(Infinity)` is `null`. An artifact naming a minimum of
    // `null` is an artifact that describes a typo instead of a system.
    const empty = evaluate([], options()).census;
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty);

    const populated = evaluate(
      [turn('alpha'), turn('beta')],
      options({ sourceTrust: 1, confidenceFor: () => 0.75 }),
    ).census;
    expect(JSON.parse(JSON.stringify(populated))).toEqual(populated);
  });
});

describe('AdmissionCensusBuilder', () => {
  it('saturates the distinct count instead of growing the artifact with the run', () => {
    // Five hundred questions admit a few hundred thousand turns, and a length-based
    // confidence takes a distinct value on nearly all of them. The cap is what keeps the
    // census a field rather than a set, and `distinctSaturated` is what keeps the floor
    // from being read as a count.
    const builder = new AdmissionCensusBuilder();
    for (let i = 0; i < DISTINCT_CAP + 10; i += 1) builder.record(i / 1000, true);

    const census = builder.census(0);
    expect(census.distinct).toBe(DISTINCT_CAP);
    expect(census.distinctSaturated).toBe(true);
  });

  it('does not claim saturation at exactly the cap minus one', () => {
    // The boundary is asserted on both sides because an off-by-one here reads as
    // "saturated" on a run that happened to have exactly sixty-four values, which is a
    // different fact and would be reported as a floor.
    const builder = new AdmissionCensusBuilder();
    for (let i = 0; i < DISTINCT_CAP - 1; i += 1) builder.record(i / 1000, true);

    expect(builder.census(0).distinct).toBe(DISTINCT_CAP - 1);
    expect(builder.census(0).distinctSaturated).toBe(false);
  });

  it('accumulates across calls, which is the property a run needs', () => {
    // A per-question census is overwritten by the next question. The run-level question —
    // "did this configuration cut anything over five hundred questions" — needs the sum,
    // which is the defect `#indexCost` was added to fix one layer down.
    const builder = new AdmissionCensusBuilder();
    builder.record(0.1, false);
    builder.record(0.9, true);
    builder.record(0.2, false);

    const census = builder.census(0.5);
    expect(census.candidates).toBe(3);
    expect(census.admitted).toBe(1);
    expect(census.rejected).toBe(2);
    expect(census.min).toBe(0.1);
    expect(census.max).toBe(0.9);
  });

  it('reads the threshold at read time, so a reading cannot name a value nobody chose', () => {
    // The threshold is a parameter of `census`, not a constructor field. A builder that
    // captured it could be constructed before the gate was resolved, and `NaN` serialises
    // to `null`.
    const builder = new AdmissionCensusBuilder();
    builder.record(0.4, true);

    expect(builder.census(0.25).threshold).toBe(0.25);
    expect(builder.census(0.75).threshold).toBe(0.75);
    expect(builder.census(0.25).admitted).toBe(builder.census(0.75).admitted);
  });

  it('reports rejected as candidates minus admitted, not as a second count', () => {
    // A separately incremented `rejected` could disagree with the other two after any
    // future edit to `record`, and the disagreement would surface as a census that
    // describes a gate nobody ran.
    const builder = new AdmissionCensusBuilder();
    for (let i = 0; i < 7; i += 1) builder.record(0.5, i % 2 === 0);

    const census = builder.census(0.5);
    expect(census.rejected).toBe(census.candidates - census.admitted);
    expect(census.admitted).toBe(4);
  });
});

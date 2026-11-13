/**
 * The write gate's census reaches the artifact, summed over the workers that produced it.
 *
 * ## The question these assertions answer, and the one they cannot
 *
 * Every gate field on `memoryArmConfig` was, until this instrument, a statement about
 * **configuration**: `threshold: 0`, `sourceTrust: 0.5`, `confidenceSignal: 'none'`. Those
 * describe a pass-through by arithmetic — `value >= 0` holds for every turn — and run
 * `37110579101` is the recorded case of a repaired program scoring what the unrepaired one did
 * while the artifact described a mechanism that had not been reached. `admission.rejected` is
 * the first field that can say **the gate cut nothing**; `admission.candidates` is what keeps
 * that statement distinguishable from "the gate saw nothing".
 *
 * What it cannot say is whether the cut was a good idea. That is an accuracy question, which is
 * why this file tests the instrument and not the hypothesis.
 *
 * ## What is asserted, and why each one can fail
 *
 * 1. **The sum is a sum.** Counts add, `min`/`max` widen, `mean` is re-weighted by each part's
 *    candidate count. A plain average over parts would let a worker that drew five questions
 *    weigh as much as one that drew two hundred.
 * 2. **An idle worker contributes nothing rather than poisoning the total.** Its census is
 *    `candidates: 0, min: 0`; folding that `min` in would report a run whose values start at zero
 *    when none did — the truncated-denominator defect arriving through a guard that looks like
 *    it protects the reader.
 * 3. **Four absences stay four.** No accessor, a throwing accessor, counters that do not
 *    reconcile, and `candidates: 0` in total each produce no field, and none of them is a zero.
 * 4. **`distinct` across parts is a floor and says so.**
 */
import { describe, expect, it } from 'vitest';

import { createAblationPool } from '../ablation.js';
import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';
import { formatAblationReport } from '../report.js';

import type { MemoryArmConfig } from '../report.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

const GATE: MemoryArmConfig = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
};

/** A census as `CortexMemory.admissionCensus()` returns one. */
type Census = NonNullable<MemoryArmConfig['admission']>;

function census(overrides: Partial<Census> = {}): Census {
  const merged: Census = {
    threshold: 0.25,
    candidates: 10,
    admitted: 6,
    min: 0.1,
    max: 0.9,
    mean: 0.5,
    distinct: 3,
    distinctSaturated: false,
    ...overrides,
    rejected: 0,
  };
  // `rejected` is derived, so an override that moves `candidates` or `admitted` has to move it
  // too. Deriving it once here is what lets every test below state only the field it is about.
  return { ...merged, rejected: merged.candidates - merged.admitted };
}

/**
 * A system that answers and reports a census, in the shape the product reports one.
 *
 * Every instance owns its own payload: a shared object would pass under the defect these tests
 * are about — a total that is really one worker's — and prove nothing.
 */
class CensusSystem implements MemorySystem {
  readonly name: string;
  readonly #payload: unknown;

  constructor(name: string, payload: unknown) {
    this.name = name;
    this.#payload = payload;
  }

  async answer(): Promise<Answer> {
    return 'one';
  }

  admissionCensus(): unknown {
    return this.#payload;
  }
}

function bareSystem(name: string): MemorySystem {
  return { name, answer: () => 'one' };
}

function dataset(questions: number): BenchmarkDataset {
  return {
    name: 'fixture',
    questions: Array.from({ length: questions }, (_, index) => ({
      id: `q${index}`,
      capability: 'IE',
      question: `Question ${index}?`,
      expected: 'one',
      context: [],
    })),
  };
}

function armRun(
  questions: number,
  runs: number,
  feature: MemorySystem,
  pool?: ReturnType<typeof createAblationPool>,
) {
  return runCortexMemoryArm(dataset(questions), bareSystem('reference-pipeline'), feature, {
    runs,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: { ...GATE },
    ...(pool === undefined ? {} : { pool }),
  });
}

/** A pool whose workers report the censuses they are given, in order. */
function poolOver(payloads: readonly unknown[]) {
  return createAblationPool({
    workers: payloads.length,
    first: {
      baseline: bareSystem('reference-pipeline'),
      feature: new CensusSystem('f0', payloads[0]),
    },
    baselineFor: () => bareSystem('reference-pipeline'),
    featureFor: (worker) => new CensusSystem(`f${worker}`, payloads[worker]),
  });
}

describe('the write gate census reaches the artifact', () => {
  it('carries the counts and reconciles them', async () => {
    const result = await armRun(4, 1, new CensusSystem('cortex', census()));
    expect(result.report.memoryArmConfig?.admission).toEqual(census());
  });

  it('sums across workers, re-weighting the mean by candidate count', async () => {
    // 200 candidates at mean 0.6 and 5 at mean 0.1: a plain average over parts would report 0.35
    // and let the small worker weigh as much as the large one. The weighted answer is
    // (0.6*200 + 0.1*5) / 205 = 0.5878.
    const pool = poolOver([
      census({ candidates: 200, admitted: 120, min: 0.2, max: 0.9, mean: 0.6 }),
      census({ candidates: 5, admitted: 1, min: 0.05, max: 0.3, mean: 0.1 }),
    ]);

    const result = await armRun(9, 2, pool.featureInstances()[0]!, pool);
    const admission = result.report.memoryArmConfig?.admission;

    expect(admission?.candidates).toBe(205);
    expect(admission?.admitted).toBe(121);
    expect(admission?.rejected).toBe(84);
    // `min` widens downward and `max` upward: the run's range is the union's extremes.
    expect(admission?.min).toBe(0.05);
    expect(admission?.max).toBe(0.9);
    expect(admission?.mean).toBeCloseTo(0.5878, 4);
  });

  it('lets an idle worker contribute nothing instead of widening the minimum to zero', async () => {
    // A worker that drew no question reports `candidates: 0, min: 0`. Folding that `min` in would
    // report a run whose values start at zero when none did.
    const pool = poolOver([
      census(),
      census({ candidates: 0, admitted: 0, min: 0, max: 0, mean: 0, distinct: 0 }),
    ]);

    const result = await armRun(6, 1, pool.featureInstances()[0]!, pool);
    const admission = result.report.memoryArmConfig?.admission;

    expect(admission?.candidates).toBe(10);
    expect(admission?.min).toBe(0.1);
  });

  it('reports no field for a system with no census capability', async () => {
    const result = await armRun(4, 1, bareSystem('cortex'));
    expect(result.report.memoryArmConfig?.admission).toBeUndefined();
  });

  it('reports no field when one worker in the pool has no capability', async () => {
    // All-or-nothing on the capability: a partial sum is a quarter of a run published as the run,
    // which is §13.244's defect.
    const pool = createAblationPool({
      workers: 2,
      first: {
        baseline: bareSystem('reference-pipeline'),
        feature: new CensusSystem('f0', census()),
      },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: () => bareSystem('bare'),
    });

    const result = await armRun(6, 1, pool.featureInstances()[0]!, pool);
    expect(result.report.memoryArmConfig?.admission).toBeUndefined();
  });

  it('reports no field when the accessor answers something that is not a record', async () => {
    // A capability that returns `null` or a string is present but broken. Coercing either would
    // put zeros on the page that no gate produced.
    for (const payload of [null, 'census', 7]) {
      const result = await armRun(4, 1, new CensusSystem('cortex', payload));
      expect(result.report.memoryArmConfig?.admission).toBeUndefined();
    }
  });

  it('refuses a counter that is not a non-negative integer', async () => {
    // The counts are turn counts. A fractional or negative one cannot have come from a loop over
    // turns, so it is a broken instrument rather than a small number.
    for (const broken of [
      { ...census(), candidates: -1 },
      { ...census(), candidates: 1.5 },
      { ...census(), admitted: 'six' },
    ]) {
      const result = await armRun(4, 1, new CensusSystem('cortex', broken));
      expect(result.report.memoryArmConfig?.admission).toBeUndefined();
    }
  });

  it('refuses a record whose saturation flag is not a boolean', async () => {
    const result = await armRun(
      4,
      1,
      new CensusSystem('cortex', { ...census(), distinctSaturated: 'no' }),
    );
    expect(result.report.memoryArmConfig?.admission).toBeUndefined();
  });

  it('refuses a record whose threshold is not a fraction', async () => {
    // The threshold is the number the counts are read against; a `NaN` there serialises to `null`
    // and would leave the artifact naming a configuration nobody chose.
    for (const broken of [Number.NaN, 2, -1]) {
      const result = await armRun(
        4,
        1,
        new CensusSystem('cortex', { ...census(), threshold: broken }),
      );
      expect(result.report.memoryArmConfig?.admission).toBeUndefined();
    }
  });

  it('reports no field when the accessor throws, rather than failing the run', async () => {
    const broken = {
      name: 'cortex',
      answer: () => 'one',
      admissionCensus: () => {
        throw new Error('no census here');
      },
    } as unknown as MemorySystem;

    const result = await armRun(4, 1, broken);
    expect(result.report.memoryArmConfig?.admission).toBeUndefined();
  });

  it('refuses counters that do not reconcile, because a wrong field is worse than an absent one', async () => {
    // The admission test is one comparison, so a turn is admitted or it is not. Three counters
    // that disagree describe a gate nobody ran.
    const lying = { ...census(), rejected: 99 };
    const result = await armRun(4, 1, new CensusSystem('cortex', lying));
    expect(result.report.memoryArmConfig?.admission).toBeUndefined();
  });

  it('refuses a fraction outside [0, 1], which `decideWrite` cannot produce', async () => {
    // `decideWrite` clamps to `[0, 1]`, so a mean above one cannot have come from this gate.
    // Accepting it would put a number on the page that no instrument produced.
    const result = await armRun(4, 1, new CensusSystem('cortex', { ...census(), mean: 1.4 }));
    expect(result.report.memoryArmConfig?.admission).toBeUndefined();
  });

  it('refuses a pool whose parts disagree about the threshold', async () => {
    // One gate ran. An artifact naming one number would be wrong about the other part.
    const pool = poolOver([census({ threshold: 0.25 }), census({ threshold: 0.5 })]);

    const result = await armRun(6, 1, pool.featureInstances()[0]!, pool);
    expect(result.report.memoryArmConfig?.admission).toBeUndefined();
  });

  it('reports a saturated distinct count as a floor rather than as a count', async () => {
    const result = await armRun(
      4,
      1,
      new CensusSystem('cortex', census({ distinct: 64, distinctSaturated: true })),
    );
    expect(result.report.memoryArmConfig?.admission?.distinct).toBe(64);
    expect(result.report.memoryArmConfig?.admission?.distinctSaturated).toBe(true);
  });

  it('takes the widest distinct count across parts, since the union is unknowable', async () => {
    const pool = poolOver([
      census({ distinct: 3 }),
      census({ distinct: 9, distinctSaturated: false }),
    ]);

    const result = await armRun(6, 1, pool.featureInstances()[0]!, pool);
    // A floor, and the field says so by staying below the cap rather than by claiming a union.
    expect(result.report.memoryArmConfig?.admission?.distinct).toBe(9);
  });

  it('states a gate that refused everything differently from a gate that saw nothing', async () => {
    // `candidates > 0, admitted: 0` is a measurement: the threshold was above every value.
    // `candidates: 0` is an absence. The two must not produce the same artifact.
    const refusedAll = await armRun(
      4,
      1,
      new CensusSystem('cortex', census({ candidates: 8, admitted: 0, min: 0, max: 0, mean: 0 })),
    );
    expect(refusedAll.report.memoryArmConfig?.admission?.rejected).toBe(8);
    expect(refusedAll.report.memoryArmConfig?.admission?.admitted).toBe(0);

    const sawNothing = await armRun(
      4,
      1,
      new CensusSystem(
        'cortex',
        census({ candidates: 0, admitted: 0, min: 0, max: 0, mean: 0, distinct: 0 }),
      ),
    );
    expect(sawNothing.report.memoryArmConfig?.admission).toBeUndefined();
  });
});

describe('the census is on the configuration line, not only in the JSON', () => {
  it('renders the counts beside the gate they describe', async () => {
    // The numbers above the line are conditioned on this gate, and the configuration block can only
    // say what it was set to. A reader with the rendered report alone must be able to see that the
    // gate was a pass-through, which is the whole reason `rejected` exists.
    const result = await armRun(4, 1, new CensusSystem('cortex', census()));
    expect(formatAblationReport(result.report)).toContain(
      'admission=candidates:10+admitted:6+rejected:4+min:0.100+max:0.900+mean:0.500+distinct:3',
    );
  });

  it('marks a saturated distinct count so the number is read as a floor', async () => {
    const result = await armRun(
      4,
      1,
      new CensusSystem('cortex', census({ distinct: 64, distinctSaturated: true })),
    );
    // A trailing `+` after the count is the mark: `distinct:64+` cannot be read as "exactly
    // sixty-four" by anyone skimming the line, which is the failure mode a bare `64` has.
    expect(formatAblationReport(result.report)).toContain('+distinct:64+`');
  });

  it('omits the field entirely when the run has no census', async () => {
    // Absence rather than zeros, so "this build has no instrument" and "the gate saw nothing" are
    // different bytes on the page.
    const result = await armRun(4, 1, bareSystem('cortex'));
    expect(formatAblationReport(result.report)).not.toContain('admission=');
  });
});

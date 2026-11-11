/**
 * §13.366: the supersession census has to reach the artifact, on every path the arm can take.
 *
 * ## Why these tests exist before the dispatch
 *
 * The campaign's own history is the argument. The audit pass shipped with a `lastReview()` that nothing read,
 * and the artifact could not say whether the mechanism had run (that defect is written up at length in
 * `audit-census.test.ts`). The specification pass shipped with a `support` array that was computed on every
 * call and dropped at `memory.ts`, and the reading that followed — `MEASURE-PLAN-SHAPE.md` — could not price
 * the one guard the mechanism needed. Both were found after the money was spent.
 *
 * So the pass being measured now writes its numbers into the artifact **before** it is dispatched, and these
 * tests are the reader's contract: a run that carries the pass publishes a tally, a per-question pair that
 * sums to it, and the refusal reasons by name; a run that does not carry it publishes nothing at all.
 *
 * ## Why the disagreement case is tested
 *
 * `attempted = replaced + refused` is true by construction inside one instance, so a test that only ever
 * builds a consistent census would pass on a fold that added the three numbers independently. The fold is
 * what can break — it crosses workers — so the failing fixture is the one that makes the identity false.
 */
import { describe, expect, it } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { createAblationPool } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';

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

type Refusals = Record<string, number>;

function refusalsOf(entries: Refusals): Refusals {
  return {
    unreadable: 0,
    'no-change': 0,
    'no-quote': 0,
    agrees: 0,
    restates: 0,
    'not-in-evidence': 0,
    'date-not-on-line': 0,
    ...entries,
  };
}

/**
 * A system that carries the pass, counts per **instance**, and replaces every answer.
 *
 * Per instance rather than shared, because that is what the product's counters are, and a shared object would
 * pass under the pool defect by accident.
 */
class SupersedingSystem implements MemorySystem {
  readonly name: string;
  #census = { attempted: 0, replaced: 0, refusals: refusalsOf({}) };

  constructor(name: string) {
    this.name = name;
  }

  async answer(): Promise<Answer> {
    this.#census.attempted += 1;
    this.#census.replaced += 1;
    return 'one';
  }

  supersessionCensus(): {
    attempted: number;
    replaced: number;
    refused: number;
    refusals: Refusals;
  } {
    const refused = Object.values(this.#census.refusals).reduce((sum, count) => sum + count, 0);
    return {
      attempted: this.#census.attempted,
      replaced: this.#census.replaced,
      refused,
      refusals: { ...this.#census.refusals },
    };
  }
}

/** A build with no accessor at all -- not the product's shape, but the shape a third-party one would have. */
function bareSystem(name: string): MemorySystem {
  return { name, answer: () => 'one' };
}

function dataset(questions: number): BenchmarkDataset {
  return {
    name: 'fixture',
    questions: Array.from({ length: questions }, (_, index) => ({
      id: `q${index}`,
      capability: 'KU',
      question: `Question ${index}?`,
      expected: 'one',
      context: [],
    })),
  };
}

describe('the supersession census reaches the artifact', () => {
  it('publishes the tally on the serial path', async () => {
    const result = await runCortexMemoryArm(
      dataset(3),
      bareSystem('reference-pipeline'),
      new SupersedingSystem('cortex-memory'),
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.supersession).toMatchObject({ attempted: 6, replaced: 6, refused: 0 });
    // The reason record is published with every name present, so a reader never infers "this reason did not
    // occur" from a missing key.
    expect(Object.keys(result.report.supersession?.refusals ?? {})).toHaveLength(7);
  });

  it('writes the per-question pair, so a reader can join the pass to the gold', async () => {
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      new SupersedingSystem('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions!.map((record) => record.supersessionConsultations)).toEqual([
      1, 1,
    ]);
    expect(result.report.questions!.map((record) => record.supersessionReplacements)).toEqual([
      1, 1,
    ]);
  });

  it('sums the roster to the tally at more than one repetition', async () => {
    const result = await runCortexMemoryArm(
      dataset(3),
      bareSystem('reference-pipeline'),
      new SupersedingSystem('cortex-memory'),
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    const roster = result.report.questions!;
    const consultations = roster.reduce(
      (sum, record) => sum + (record.supersessionConsultations ?? 0),
      0,
    );
    expect(result.report.supersession?.attempted).toBe(6);
    expect(consultations).toBe(6);
  });

  it('sums the tally over every worker rather than reading worker 0', async () => {
    // Nine questions, two passes, three workers: eighteen. Under §13.244's defect this reads six, which is a
    // quarter of the run stated with the same confidence as the whole of it.
    const pool = createAblationPool({
      workers: 3,
      first: { baseline: bareSystem('reference-pipeline'), feature: new SupersedingSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new SupersedingSystem(`f${worker}`),
    });

    const result = await runCortexMemoryArm(
      dataset(9),
      bareSystem('reference-pipeline'),
      pool.featureInstances()[0]!,
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
        pool,
      },
    );

    expect(result.report.supersession).toMatchObject({ attempted: 18, replaced: 18 });
  });

  it('traces the pool’s questions, which is where the positional wrapper is never called', async () => {
    // §13.259. If the wrapper stays on the positional `feature`, this column is empty on every pooled run and
    // the mechanism reports having reached no question while having consulted on all of them.
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new SupersedingSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new SupersedingSystem(`f${worker}`),
    });

    const result = await runCortexMemoryArm(
      dataset(4),
      bareSystem('reference-pipeline'),
      pool.featureInstances()[0]!,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
        pool,
      },
    );

    expect(result.report.questions!.every((record) => record.supersessionConsultations === 1)).toBe(
      true,
    );
  });

  it('omits the field entirely when the system carries no accessor', async () => {
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      bareSystem('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect('supersession' in result.report).toBe(false);
    expect(result.report.questions![0]!.supersessionConsultations).toBeUndefined();
  });

  it('reads a null census as absence, which is what the product reports without the pass', async () => {
    // The product's shape is an accessor that answers `null`, not a system with no accessor — the distinction
    // `42161343457` paid for on the audit.
    // Cast for the reason the sibling `auditCensus` fixture casts: `MemorySystem` declares the answering
    // surface and the arm reads the censuses structurally, so a fixture that carries one is a system whose
    // optional instrument is present rather than a system this type describes.
    const absent = {
      name: 'cortex-memory',
      answer: () => 'one',
      supersessionCensus: () => null,
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(2), bareSystem('reference-pipeline'), absent, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE },
    });

    expect('supersession' in result.report).toBe(false);
  });

  it('drops a census whose identity does not hold rather than publishing a number nobody can check', async () => {
    // `attempted` six and `replaced` two with no refusals is not a state the product can produce, so a fold
    // that produced it has added three counters that do not belong to the same population. The rule is the one
    // `summedOver` applies to a partial sum: an artifact that cannot state the population should not state a
    // number.
    const inconsistent = {
      name: 'cortex-memory',
      answer: () => 'one',
      supersessionCensus: () => ({
        attempted: 6,
        replaced: 2,
        refused: 0,
        refusals: refusalsOf({}),
      }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      inconsistent,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect('supersession' in result.report).toBe(false);
  });

  it('rejects a malformed payload instead of clamping it', async () => {
    // The only producer is a counter incremented by one, so a non-integer can only mean the field is not the
    // counter it claims to be -- `auditOf`'s rule, applied here for the same reason.
    for (const refusals of [
      { agreed: 1.5 },
      { agreed: -1 },
      { agreed: 'one' as unknown as number },
    ]) {
      const malformed = {
        name: 'cortex-memory',
        answer: () => 'one',
        supersessionCensus: () => ({
          attempted: 1,
          replaced: 0,
          refused: 1,
          refusals: refusals as Refusals,
        }),
      } as unknown as MemorySystem;

      const result = await runCortexMemoryArm(
        dataset(1),
        bareSystem('reference-pipeline'),
        malformed,
        {
          runs: 1,
          scorer: exactMatchScorer,
          generatedAt: '1970-01-01T00:00:00.000Z',
          memoryArmConfig: { ...GATE },
        },
      );

      expect('supersession' in result.report).toBe(false);
    }
  });

  it('treats a throwing accessor as an instrument that is not there', async () => {
    const throwing = {
      name: 'cortex-memory',
      answer: () => 'one',
      supersessionCensus: () => {
        throw new Error('broken');
      },
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      throwing,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect('supersession' in result.report).toBe(false);
  });
});

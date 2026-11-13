/**
 * `self-index`: the product ranks its own turns, and the run prices it.
 *
 * ## The gap these assertions close
 *
 * Every ranking signal before this one was built by `cortex-eval` and handed to the product as a
 * synchronous callback. `CortexMemory` has had its **own** retrieval stack — `SearchIndex`: postings, a
 * vector channel, RRF fusion, an optional cross-encoder — with unit tests and two acceptance rows
 * (`C5`/`C6`) and no measured run, because no dispatch could reach it. A capability measured only on a
 * synthetic four-turn corpus has no reading on 500 real questions, and the artifact of every run so far
 * could not say whether it would have helped or what it would have cost.
 *
 * ## What is asserted, and why each one can fail
 *
 * 1. **The switch is reachable and exclusive.** `self-index` parses; a typo does not. And the predicate
 *    that decides who builds the index is true for exactly one value — the arm wires either an
 *    `index` or a `relevanceFor`, and a run that wired both would have the product rank with the
 *    override while the artifact named the signal that did not run (`#relevanceFor` returns the
 *    override first).
 * 2. **A reranker is not refused.** `self-index` builds a pool inside the product, and the assertion
 *    that refuses a stage with nothing to reorder must know that. Refusing it would make the one signal
 *    that can carry a cross-encoder inside the product the one signal that cannot be dispatched with one.
 * 3. **The cost reaches the artifact, summed over workers.** The per-question census is overwritten by
 *    the next question, so the total can only be taken after the run and only by enumerating the
 *    instances — the `§14.22` defect one census further on, where a truncated sum looks like a
 *    measurement. The four shapes below are the ones that decide whether a number on the page is one:
 *    a sum, a part that contributed nothing, a capability that is absent, and a payload that is malformed.
 * 4. **`reuse` is a conjunction over the parts that built something.** An idle worker embedded nothing and
 *    must not turn a stored run into an unstored one; one real index without a store must.
 */
import { describe, expect, it } from 'vitest';

import {
  assertRerankReachesRanking,
  buildsProductIndex,
  cortextMemoryArmOptions,
  runCortexMemoryArm,
} from '../bench-memory-arm.js';
import { createAblationPool } from '../ablation.js';
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

/** A cost record as `CortexMemory.indexCost()` returns one. */
type Cost = NonNullable<MemoryArmConfig['selfIndex']>;

function cost(overrides: Partial<Cost> = {}): Cost {
  return {
    indexes: 50,
    turns: 200,
    embedCalls: 100,
    embedTexts: 250,
    memoHits: 200,
    reuse: true,
    rerankCalls: 0,
    rerankDegraded: 0,
    ...overrides,
  };
}

/**
 * A system that answers and reports a cost, in the shape the product reports one.
 *
 * `payload` is `undefined` for an instance that built no index, which under a pool is the normal state of
 * a worker that drew no questions from a ranked route. Every instance owns its own counters — a shared
 * object would pass under the defect this file is about and prove nothing.
 */
class CostSystem implements MemorySystem {
  readonly name: string;
  #payload: unknown;

  constructor(name: string, payload: unknown) {
    this.name = name;
    this.#payload = payload;
  }

  async answer(): Promise<Answer> {
    return 'one';
  }

  indexCost(): unknown {
    return this.#payload;
  }
}

/** A system with no cost capability at all. */
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

describe('self-index is a signal a dispatch can name', () => {
  it('parses from the environment', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_RELEVANCE: 'self-index',
    });
    expect(options.relevanceSignal).toBe('self-index');
  });

  it('is the only signal the product builds', () => {
    // The exclusivity is what makes the artifact readable: `relevanceSignal` says who ranked, and a run
    // that passed both an index and a callback ranked with the callback.
    for (const signal of [
      'none',
      'retrieval',
      'retrieval-hybrid',
      'retrieval-anchored',
      'retrieval-session',
    ]) {
      expect(buildsProductIndex(signal)).toBe(false);
    }
    expect(buildsProductIndex('self-index')).toBe(true);
  });

  it('refuses an unrecognised value rather than defaulting it', () => {
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: 'selfindex' }),
    ).toThrow(/CORTEX_MEMORY_RELEVANCE/);
  });

  it('accepts a reranker, because the pool it builds is inside the product', () => {
    expect(() =>
      assertRerankReachesRanking('self-index', {
        provider: 'openai-compatible',
        model: 'bge-reranker-v2',
      }),
    ).not.toThrow();
    // And the assertion still refuses the signal that builds no pool, so the acceptance above is not a
    // widening of the guard to everything.
    expect(() =>
      assertRerankReachesRanking('none', {
        provider: 'openai-compatible',
        model: 'bge-reranker-v2',
      }),
    ).toThrow(/builds no ranked pool/);
  });
});

describe('the product index cost reaches the artifact', () => {
  it('sums one record across workers', async () => {
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new CostSystem('f0', cost()) },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) =>
        new CostSystem(`f${worker}`, cost({ indexes: 10, turns: 20, embedTexts: 30, memoHits: 5 })),
    });

    const result = await armRun(9, 2, pool.featureInstances()[0]!, pool);

    // Worker 0's record plus worker 1's: the total covers every instance that answered, which is the
    // denominator this census has to share with the run.
    expect(result.report.memoryArmConfig?.selfIndex).toEqual({
      indexes: 60,
      turns: 220,
      embedCalls: 200,
      embedTexts: 280,
      memoHits: 205,
      reuse: true,
      rerankCalls: 0,
      rerankDegraded: 0,
    });
  });

  it('counts a worker that built no index as a zero rather than as an absence', async () => {
    // Under a pool a worker can legitimately answer no ranked question. Treating `undefined` as "this
    // system has no census" would discard the whole total on one idle worker -- the truncated-denominator
    // defect through a guard that looks like it protects the reader.
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new CostSystem('f0', cost()) },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: () => new CostSystem('idle', undefined),
    });

    const result = await armRun(6, 1, pool.featureInstances()[0]!, pool);

    expect(result.report.memoryArmConfig?.selfIndex).toEqual(cost());
  });

  it('omits the record when no index was built, rather than publishing zeros', async () => {
    const result = await armRun(4, 1, new CostSystem('cortex-memory', undefined), undefined);

    expect(result.report.memoryArmConfig?.selfIndex).toBeUndefined();
    expect('selfIndex' in (result.report.memoryArmConfig ?? {})).toBe(false);
    expect(formatAblationReport(result.report)).not.toContain('selfIndex=');
  });

  it('omits the record when the system cannot report one', async () => {
    // A capability that is not there is not a zero, for the reason `pool-census` gives: absence says
    // "not measured" and a partial sum says a lie in the shape of a measurement.
    const result = await armRun(4, 1, bareSystem('cortex-memory'), undefined);
    expect(result.report.memoryArmConfig?.selfIndex).toBeUndefined();
  });

  it('discards a malformed record instead of coercing it', async () => {
    for (const payload of [
      null,
      'cost',
      cost({ embedTexts: -1 }),
      cost({ turns: 1.5 }),
      { ...cost(), reuse: 'yes' },
    ]) {
      const result = await armRun(4, 1, new CostSystem('cortex-memory', payload), undefined);
      expect(result.report.memoryArmConfig?.selfIndex).toBeUndefined();
    }
  });

  it('treats a throwing accessor as a broken capability rather than a failed run', async () => {
    const broken: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      indexCost: () => {
        throw new Error('no');
      },
    } as unknown as MemorySystem;

    const result = await armRun(3, 1, broken, undefined);
    expect(result.report.memoryArmConfig?.selfIndex).toBeUndefined();
    expect(result.report.feature.metrics.total).toBe(3);
  });

  it('reports reuse only when every index that embedded had a store', async () => {
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new CostSystem('f0', cost()) },
      baselineFor: () => bareSystem('reference-pipeline'),
      // The idle worker's `reuse: true` is not a claim about anything: it embedded nothing.
      featureFor: () => new CostSystem('cold', cost({ indexes: 5, reuse: false, memoHits: 0 })),
    });

    const result = await armRun(6, 1, pool.featureInstances()[0]!, pool);

    expect(result.report.memoryArmConfig?.selfIndex).toMatchObject({ reuse: false });
  });

  it('renders the cost beside the signal, and only when the record exists', async () => {
    const withCost = await armRun(4, 1, new CostSystem('cortex-memory', cost()), undefined);
    const markdown = formatAblationReport(withCost.report);

    // Joined with `+` for the reason `anchorParams` is: the line already separates fields with commas.
    expect(markdown).toContain(
      'selfIndex=indexes:50+turns:200+texts:250+hits:200+reuse:true+rerank:0/0',
    );
    // A run without the record still renders the signal's own field, so the absence is a missing reading
    // rather than a missing configuration.
    const withoutCost = await armRun(4, 1, bareSystem('cortex-memory'), undefined);
    const plain = formatAblationReport(withoutCost.report);
    expect(plain).not.toContain('selfIndex=');
    expect(plain).toContain('relevanceSignal=none');
  });
});

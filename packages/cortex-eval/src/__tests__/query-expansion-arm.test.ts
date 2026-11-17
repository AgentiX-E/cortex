import { describe, expect, it } from 'vitest';
import { assertExpansionReachesRanking, runCortexMemoryArm } from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';
import type { MemoryArmConfig } from '../report.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

/**
 * A configuration carrying only what the receipt guard reads.
 *
 * Cast rather than built through `toMemoryArmConfig`, and the cast is the point: the guards' contract is
 * `MemoryArmConfig` in, refusal or silence out, and a test that spelled a full configuration would be
 * asserting that `toMemoryArmConfig` produces the fields as much as that the guard reads them. The fields
 * that are present are the ones the guards name, and a guard that started reading a third field would fail
 * here rather than pass on a fixture that happened to carry it.
 */
function config(overrides: Partial<MemoryArmConfig> = {}): MemoryArmConfig {
  return {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: null,
    sourceTrust: 0.5,
    confidenceSignal: 'none',
    promptContract: 'abstention',
    relevanceSignal: 'self-index',
    relevanceTopK: 64,
    ...overrides,
  };
}

/** A product-index bill, in the shape `CortexMemory.indexCost()` returns one. */
type Bill = NonNullable<MemoryArmConfig['selfIndex']>;

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    indexes: 121,
    turns: 5_000,
    embedCalls: 300,
    embedTexts: 6_000,
    memoHits: 4_000,
    reuse: true,
    rerankCalls: 0,
    rerankDegraded: 0,
    embedDegraded: 0,
    queries: 121,
    ...overrides,
  };
}

describe('assertExpansionReachesRanking', () => {
  it('refuses an expansion beside a signal that compares no query against a turn', () => {
    // `relevanceSignal=none` means the budget buys the turns that arrived: no query is ever scored, so the
    // phrases would be written, counted in `queryExpansionCounts`, and read by nothing. That is §10.10's
    // shape -- a recorded configuration that never reaches the decision it names -- and the artifact would
    // be internally consistent, which is what makes it worth refusing rather than documenting.
    expect(() => assertExpansionReachesRanking('none', 'llm')).toThrow(/compares no query/);
  });

  it('allows both routes that can receive the phrases', () => {
    // The two routes are different implementations of one idea: `retrieval*` builds its index in the
    // harness and reads `RelevanceCase.queries`, `self-index` builds it in the product and reads
    // `SearchIndexOptions.queryPlan`. A guard that allowed one and refused the other would be a
    // restriction on the experiment rather than a check on it.
    for (const signal of [
      'retrieval',
      'retrieval-hybrid',
      'retrieval-anchored',
      'retrieval-session',
    ]) {
      expect(() => assertExpansionReachesRanking(signal, 'llm')).not.toThrow();
    }
    expect(() => assertExpansionReachesRanking('self-index', 'llm')).not.toThrow();
    // The shipped arm of every archived run, which writes no phrases at all.
    expect(() => assertExpansionReachesRanking('none', undefined)).not.toThrow();
    expect(() => assertExpansionReachesRanking('none', '')).not.toThrow();
    expect(() => assertExpansionReachesRanking('none', 'none')).not.toThrow();
    // `window` reorders the delivered set inside the renderer, so it needs no ranked pool and is not
    // this guard's business -- a run may dispatch it with `relevanceSignal=none`.
    expect(() => assertExpansionReachesRanking('none', 'window')).not.toThrow();
  });
});

describe('the expansion receipt is refused at the writer', () => {
  // The assertion itself is not exported: it is called once, from inside `runCortexMemoryArm`, and the
  // export census is right that a name used only by its own module is not a public symbol. The tests
  // therefore drive the **public path**, which is also the stronger statement -- they assert that a run
  // whose bill contradicts its configuration throws before an artifact exists, not that a function does.
  const expanded = { questions: 121, phrases: 480, refused: 2 };

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

  /** A system that answers and reports a product-index bill, in the shape `CortexMemory` reports one. */
  class CostSystem implements MemorySystem {
    readonly name = 'cost';
    readonly #payload: Bill | undefined;

    constructor(payload: Bill | undefined) {
      this.#payload = payload;
    }

    async answer(): Promise<Answer> {
      return 'one';
    }

    indexCost(): unknown {
      return this.#payload;
    }
  }

  const BASELINE: MemorySystem = { name: 'reference-pipeline', answer: () => 'one' };

  function run(overrides: Partial<MemoryArmConfig>, feature: MemorySystem) {
    return runCortexMemoryArm(dataset(3), BASELINE, feature, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...config(), ...overrides },
    });
  }

  function runWithBill(overrides: Partial<MemoryArmConfig>, payload: Bill | undefined) {
    return run(overrides, new CostSystem(payload));
  }

  it('accepts a run whose index issued more queries than retrievals', async () => {
    // The one receipt: the product's own bill. `queries > indexes` is the plan having acted on at least
    // one question, and it is a count the index wrote rather than a count the harness predicted.
    await expect(
      runWithBill({ queryExpansionCounts: expanded }, bill({ queries: 400 })),
    ).resolves.toBeDefined();
  });

  it('refuses a run that produced phrases and issued one query per retrieval', async () => {
    // This is the defect the round closes: `self-index` reads the plan, not the cases, so before the plan
    // existed every `queryExpansion=llm` dispatch of the registered arm was a control. The run must fail
    // rather than write an artifact whose accuracy is the bare question's under a treatment's name.
    await expect(
      runWithBill({ queryExpansionCounts: expanded }, bill({ queries: 121 })),
    ).rejects.toThrow(/reached no ranking/);
  });

  it('says nothing when the configuration names no expansion', async () => {
    // A control run has no counts, and `undefined` is that state rather than a zeroed object -- the same
    // rule `toMemoryArmConfig` follows, and the reason "ran the control" and "predates the field" are not
    // the same bytes.
    await expect(runWithBill({}, bill({ queries: 121 }))).resolves.toBeDefined();
  });

  it('says nothing when the model produced nothing to reach', async () => {
    // Every phrase refused is a legitimate run: the question keeps its bare query, the accuracy is the
    // control's, and the field that says so is `refused`. Failing here would blame the wiring for the
    // model's answer, which is the mistake §13.97's parser was written to keep separable.
    await expect(
      runWithBill(
        { queryExpansionCounts: { questions: 121, phrases: 0, refused: 121 } },
        bill({ queries: 121 }),
      ),
    ).resolves.toBeDefined();
  });

  it('says nothing when the product reports no bill at all', async () => {
    // Two shapes reach this, and they are one shape in the artifact: a system with no `indexCost()`
    // capability, which is every non-product system, and a product run whose index never existed -- a
    // corpus that admitted no turns. `indexCostAcross` publishes `selfIndex` only when something was
    // built, so a bill of zeros cannot arrive as zeros, and there is deliberately no branch for it: a
    // guard for a state no caller can produce is a branch no test can reach either.
    //
    // A refusal here would fail a legitimate run on a fact about the admission gate rather than about the
    // arm, which is the mistake this receipt exists to avoid making.
    await expect(
      run({ queryExpansionCounts: expanded }, { name: 'no-cost', answer: () => 'one' }),
    ).resolves.toBeDefined();
    await expect(
      runWithBill({ queryExpansionCounts: expanded }, bill({ indexes: 0, queries: 0, turns: 0 })),
    ).resolves.toBeDefined();
  });

  it('names one query in the singular, because the message is read rather than parsed', async () => {
    // The refusal's sentence is the whole record of what went wrong, since the artifact is the thing that
    // was not written. A reader deciding whether the plan failed or the dispatch was misspelled is
    // reading exactly this line, and `1 queries` would be a small wrongness in the one place with no
    // other evidence.
    await expect(
      runWithBill({ queryExpansionCounts: expanded }, bill({ queries: 1 })),
    ).rejects.toThrow(/1 query for/);
  });
});

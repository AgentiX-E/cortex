/**
 * The vector channel had a product, a manual entry and no arm.
 *
 * ## The question this row exists to answer
 *
 * `SearchIndexOptions.embed` is optional: "absent means a lexical index, which is still a working one".
 * That sentence is a claim about a deployment -- a user who has no embedding provider, or will not pay
 * one, still gets a ranking. Every published number for this product was taken with the embedder
 * injected, so the claim has never had a reading. `docs/USER-MANUAL.md` priced the ranking at 91.40%
 * (with an embedder) and 39.55% (with no ranking at all), and the middle case -- lexical ranking, no
 * vector channel -- was the one a reader could only guess at.
 *
 * `S12` is that middle case, and the channel below is what makes it dispatchable. The same three
 * questions as every other arm channel apply, and each has a test here:
 *
 * 1. Does the variable reach the option? (`readIndexEmbedding`, strict.)
 * 2. Does the option reach the artifact on **every** run, controls included?
 * 3. Can the artifact lie? A run that says `none` while the product embedded anyway would publish the
 *    registered arm's accuracy under the control's name -- so the bill is compared against the claim.
 *
 * ## Why the guard is a thrown error and not a warning
 *
 * The bill (`indexCost.embedTexts`) is taken after the questions are answered, which is late. But late
 * is still before the artifact is written, and the alternative is the failure this repository has paid
 * for three times: a number that is real, filed under a configuration that did not produce it. The run
 * costs about two hours; a rejected artifact costs the two hours and teaches nothing.
 */
import { describe, expect, it } from 'vitest';

import { exactMatchScorer } from '../metrics.js';
import {
  cortextMemoryArmOptions,
  runCortexMemoryArm,
  toMemoryArmConfig,
} from '../bench-memory-arm.js';
import { formatAblationReport } from '../report.js';

import type { CortexMemoryArmOptions } from '../bench-memory-arm.js';
import type { MemoryArmConfig } from '../report.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

/** The arm switched on, which is the state every dispatch to `benchmark-cortex-memory.yml` is in. */
const ARM_ON = { CORTEX_MEMORY: '1' } as const;

/** The identity configuration, so a report can be built without naming a single mechanism. */
const GATE: MemoryArmConfig = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: 64,
};

function embeddingOf(options: CortexMemoryArmOptions): string | undefined {
  return toMemoryArmConfig(options).indexEmbedding;
}

/** A cost record in the shape `CortexMemory.indexCost()` returns one. */
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
    embedDegraded: 0,
    queries: 50,
    ...overrides,
  };
}

/** A system that answers and reports the product's own index bill. */
class CostSystem implements MemorySystem {
  readonly name = 'cortex-memory';
  readonly #payload: unknown;

  constructor(payload: unknown) {
    this.#payload = payload;
  }

  async answer(): Promise<Answer> {
    return 'one';
  }

  indexCost(): unknown {
    return this.#payload;
  }
}

const DATASET: BenchmarkDataset = {
  name: 'fixture',
  questions: [
    { id: 'q0', capability: 'KU', question: 'Where does she work?', expected: 'one', context: [] },
    { id: 'q1', capability: 'KU', question: 'Where did she work?', expected: 'one', context: [] },
  ],
};

function system(name: string): MemorySystem {
  return { name, answer: () => 'one' };
}

/** One A/B over the fixture, with the feature side reporting `bill`. */
async function runWith(embedding: string, bill: unknown = cost({ embedTexts: 0, embedCalls: 0 })) {
  return runCortexMemoryArm(DATASET, system('reference-pipeline'), new CostSystem(bill), {
    runs: 1,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: { ...GATE, indexEmbedding: embedding },
  });
}

describe('the arm can be dispatched to withhold the vector channel', () => {
  it('reads its own variable, and an unset variable is the registered configuration', () => {
    // The default is load-bearing: every published number for this product was produced with the
    // embedder injected, so a default of `none` would retroactively relabel every archived artifact.
    expect(cortextMemoryArmOptions({ ...ARM_ON }).indexEmbedding).toBe('injected');
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_INDEX_EMBEDDING: 'injected' })
        .indexEmbedding,
    ).toBe('injected');
    // A blank variable is the same state, which is what GitHub substitutes for an unset repository
    // variable -- so the workflow's literal fallback and this reader agree on one value rather than two.
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_INDEX_EMBEDDING: '   ' }).indexEmbedding,
    ).toBe('injected');
  });

  it('accepts the lexical-only arm by name', () => {
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_INDEX_EMBEDDING: 'none' }).indexEmbedding,
    ).toBe('none');
    // Whitespace around a legal name is a shell artefact rather than a different configuration, so it
    // is read as the name: a variable written by hand with a trailing newline is not a typo.
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_INDEX_EMBEDDING: ' none\n' })
        .indexEmbedding,
    ).toBe('none');
  });

  it('rejects a name the arm cannot administer instead of defaulting to the control', () => {
    // A silent default here would be the most expensive kind of quiet: the run would publish the
    // registered arm's accuracy (91.40%) under the control's name, and the conclusion would be
    // "an embedder is worth nothing" -- the opposite of what the dispatch was bought to find out.
    for (const bad of ['lexical', 'off', 'INJECTED', 'true', '0', 'vector', 'yes']) {
      expect(() =>
        cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_INDEX_EMBEDDING: bad }),
      ).toThrow(/CORTEX_MEMORY_INDEX_EMBEDDING must be one of/);
    }
  });

  it('records the registered value on a disabled arm, not the variable', () => {
    // A disabled arm builds no index, so it embedded nothing and the variable reached nothing. Reading
    // it here would put a treatment on the record of a run that never consulted a model -- the
    // claim-nobody-can-check defect the `featureConfig` block exists to close. The value written is the
    // default, which is what a reader compares a control against.
    const disabled = cortextMemoryArmOptions({ CORTEX_MEMORY_INDEX_EMBEDDING: 'none' });
    expect(disabled.enabled).toBe(false);
    expect(disabled.indexEmbedding).toBe('injected');
    expect(embeddingOf(disabled)).toBe('injected');
  });
});

describe('the artifact says which channel the product index had, on every run', () => {
  it('projects the value, so "ran the control" and "predates the field" are different bytes', () => {
    expect(embeddingOf(cortextMemoryArmOptions({ ...ARM_ON }))).toBe('injected');
    expect(
      embeddingOf(cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_INDEX_EMBEDDING: 'none' })),
    ).toBe('none');
  });

  it('defaults an option object built by hand to the registered value', () => {
    const handBuilt: CortexMemoryArmOptions = { ...cortextMemoryArmOptions({ ...ARM_ON }) };
    delete handBuilt.indexEmbedding;
    expect(embeddingOf(handBuilt)).toBe('injected');
    expect('indexEmbedding' in toMemoryArmConfig(handBuilt)).toBe(true);
  });

  it('prints the value on the line a human reads, both arms included', async () => {
    expect(formatAblationReport((await runWith('injected')).report)).toContain(
      'indexEmbedding=injected',
    );
    expect(formatAblationReport((await runWith('none')).report)).toContain('indexEmbedding=none');
  });
});

describe('the artifact cannot claim a channel it did not have', () => {
  it('refuses a run that says `none` and embedded anyway', async () => {
    // The wiring bug this catches is one line: `selfIndexOptions` keeping its `embed` while the arm
    // says `none`. Nothing else in the artifact would disagree -- the accuracy would be the registered
    // arm's, the config would be the control's, and the reading would say the vector channel is free.
    await expect(runWith('none', cost({ embedTexts: 250, embedCalls: 100 }))).rejects.toThrow(
      /indexEmbedding=none[\s\S]*250 text/,
    );
  });

  it('accepts the same bill when the arm says the embedder was injected', async () => {
    // The control in every sense: the identical fixture, the identical bill, one field different. Without
    // it the throw above could be the fixture failing rather than the guard firing.
    const result = await runWith('injected', cost({ embedTexts: 250, embedCalls: 100 }));
    expect(result.report.memoryArmConfig?.indexEmbedding).toBe('injected');
    expect(result.report.memoryArmConfig?.selfIndex?.embedTexts).toBe(250);
  });

  it('refuses a bill that states texts and no calls, which no index can produce', async () => {
    // A partial bill is malformed rather than cheap: `embedTexts > 0` with `embedCalls === 0` describes
    // embeddings nobody requested. `indexCostOf` accepts the shape (eight non-negative integers), so the
    // refusal has to be here -- and the test exists because a guard that only asked for `calls === 0`
    // would pass every other case in this file while letting that artefact through under `none`.
    await expect(runWith('none', cost({ embedCalls: 0, embedTexts: 5 }))).rejects.toThrow(
      /indexEmbedding=none[\s\S]*5 text/,
    );
  });

  it('accepts a `none` run whose bill is zero, which is what a lexical index costs', async () => {
    const result = await runWith('none', cost({ embedTexts: 0, embedCalls: 0, memoHits: 0 }));
    expect(result.report.memoryArmConfig?.indexEmbedding).toBe('none');
    expect(result.report.memoryArmConfig?.selfIndex?.embedTexts).toBe(0);
    // The index still ran: `indexes` and `turns` are the lexical channel's own work, so a zero bill is
    // distinguishable from an arm that built no index at all.
    expect(result.report.memoryArmConfig?.selfIndex?.indexes).toBe(50);
  });
});

/**
 * The configuration block is not a function of the answers, and the artifact says which of its own
 * fields are not.
 *
 * ## The dispatch that paid for this file
 *
 * Run `45543010618` answered 500 questions across 8 shards for the third `resolution` replication.
 * Every job succeeded. `merge the shards` exited 1 with `shard 1 differs from shard 0 in
 * memoryArmConfig`, and the eight artifacts -- about twelve yuan of answers -- were unreadable, because
 * the block that is supposed to mean *what this run was configured with* also carried `selfIndex`: the
 * product's own embedding bill, written after the questions were answered, and therefore different in
 * every job by construction.
 *
 * The merge tool already had a list of such fields (`admission`, from run `43622841638`). It could not
 * have the new one, because the list lives in `tools/merge-ablation.mjs` and the field is folded in by
 * `bench-memory-arm.ts`. **A list in one file cannot track a writer in another.** So the arm now
 * declares its censuses on the artifact (`memoryArmConfig.censusKeys`, written by the same object that
 * folds them in), and the tests below pin the property rather than the list:
 *
 *   1. the declaration names exactly the fields that were folded in, so it cannot drift from them;
 *   2. two runs of one configuration over different populations produce **one** configuration block
 *      once the declared censuses are removed -- which is the property the merge compares;
 *   3. no declared census is a registered configuration field, so the declaration cannot be used to
 *      smuggle a real departure past the comparison.
 *
 * The third is the one that keeps the escape hatch honest. Everything else here could be satisfied by
 * declaring the whole block a census and comparing nothing.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';

import type { MemoryArmConfig } from '../report.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

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

type Cost = NonNullable<MemoryArmConfig['selfIndex']>;

function cost(overrides: Partial<Cost> = {}): Cost {
  return {
    indexes: 1,
    turns: 4,
    embedCalls: 2,
    embedTexts: 6,
    memoHits: 0,
    reuse: true,
    rerankCalls: 0,
    rerankDegraded: 0,
    embedDegraded: 0,
    queries: 1,
    ...overrides,
  };
}

/** A system that answers and reports a bill the test chose, standing in for the product's index. */
class BilledSystem implements MemorySystem {
  readonly name = 'cortex-memory';
  readonly #bill: unknown;

  constructor(bill: unknown) {
    this.#bill = bill;
  }

  async answer(): Promise<string> {
    return 'one';
  }

  indexCost(): unknown {
    return this.#bill;
  }
}

function dataset(ids: readonly string[]): BenchmarkDataset {
  return {
    name: 'fixture',
    questions: ids.map((id) => ({
      id,
      capability: 'KU' as const,
      question: `question ${id}`,
      expected: 'one',
      context: [],
    })),
  };
}

const BASELINE: MemorySystem = { name: 'reference-pipeline', answer: () => 'one' };

/** The configuration every run below is dispatched with, so "folded in" can be computed against it. */
const INPUT: MemoryArmConfig = { ...GATE, indexEmbedding: 'injected' };

async function run(ids: readonly string[], bill: Cost | undefined) {
  const feature: MemorySystem =
    bill === undefined ? { name: 'cortex-memory', answer: () => 'one' } : new BilledSystem(bill);
  return runCortexMemoryArm(dataset(ids), BASELINE, feature, {
    runs: 1,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: { ...INPUT },
  });
}

/** The block with every field it declared as a reading removed -- what the merge compares. */
function configurationOnly(config: MemoryArmConfig | undefined): Record<string, unknown> {
  const declared = new Set(config?.censusKeys ?? []);
  return Object.fromEntries(
    Object.entries(config ?? {}).filter(([key]) => key !== 'censusKeys' && !declared.has(key)),
  );
}

describe('the arm declares which of its configuration fields are readings', () => {
  it('names the bill when the product indexed, and does not when it did not', async () => {
    const billed = await run(['q0'], cost());
    expect(billed.report.memoryArmConfig?.censusKeys).toContain('selfIndex');
    // `goldAccount` is unconditional: it is a verdict about the pools the run produced, and it is
    // written on every arm, so a run that omitted it from the declaration would be hiding a field the
    // merge would then compare.
    expect(billed.report.memoryArmConfig?.censusKeys).toContain('goldAccount');

    const unbilled = await run(['q0'], undefined);
    expect(unbilled.report.memoryArmConfig?.selfIndex).toBeUndefined();
    expect(unbilled.report.memoryArmConfig?.censusKeys).not.toContain('selfIndex');
  });

  it('declares every field it folded in, and nothing it did not', async () => {
    // Derived rather than restated: whatever the arm wrote into the block that the option object did
    // not contain is a reading, and it has to be named. A new census added a round from now fails
    // here rather than in a merge job eight shards later.
    const result = await run(['q0'], cost());
    const written: MemoryArmConfig = result.report.memoryArmConfig ?? GATE;
    const foldedIn = Object.keys(written).filter((key) => !(key in INPUT) && key !== 'censusKeys');
    expect(foldedIn.length).toBeGreaterThan(1);
    expect([...(written.censusKeys ?? [])].sort()).toEqual(foldedIn.sort());
  });

  it('produces one configuration block for two populations of one dispatch', async () => {
    // The property the merge is built on. Two runs whose answers and bills differ are one
    // configuration, and the block says so once its readings are removed -- this is the assertion the
    // eight shards of `45543010618` would have passed, and the merge refused them for.
    const first = await run(['q0', 'q1'], cost({ indexes: 2, embedTexts: 6 }));
    const second = await run(['q2', 'q3', 'q4'], cost({ indexes: 5, embedTexts: 30 }));

    expect(first.report.questions?.length).not.toBe(second.report.questions?.length);
    expect(first.report.memoryArmConfig?.selfIndex?.embedTexts).not.toBe(
      second.report.memoryArmConfig?.selfIndex?.embedTexts,
    );
    expect(configurationOnly(first.report.memoryArmConfig)).toEqual(
      configurationOnly(second.report.memoryArmConfig),
    );
  });

  it('cannot declare a field the classification table does not call a reading', async () => {
    // The hole a self-declaration opens, closed from the other side. The declaration is only read by
    // the merge, and the merge stops comparing whatever it names -- so a field the registration
    // projects could be talked out of the comparison by naming it here.
    //
    // `tools/arm-config-record.py` already classifies every field of this block (`PROJECTED`,
    // `derived`, `constant`, `identity`, `census`) and its own test asserts the partition is total.
    // That table is the source of truth; a census declared here has to be a field it calls a reading.
    // Read as text rather than imported, because the table is Python and this arm is not: the guard
    // asserts the extraction found a table at all, so a rewritten file fails loudly instead of
    // passing over an empty set.
    const table = readFileSync(
      new URL('../../../../tools/arm-config-record.py', import.meta.url),
      'utf8',
    );
    const readings = new Set(
      [...table.matchAll(/"([A-Za-z][A-Za-z0-9]*)": \(\s*\n\s*"(census|derived)"/g)].map(
        (match) => match[1] as string,
      ),
    );
    expect(readings.size).toBeGreaterThan(5);
    expect(readings.has('selfIndex')).toBe(true);
    // The control: `reader` is `PROJECTED` in that table, so an extraction that matched every entry
    // in the file would let a dispatch input be declared a reading and dropped from the comparison.
    expect(readings.has('reader')).toBe(false);

    const result = await run(['q0'], cost());
    for (const key of result.report.memoryArmConfig?.censusKeys ?? []) {
      expect(
        readings.has(key),
        `${key} is not classified as a reading by arm-config-record.py`,
      ).toBe(true);
    }
  });
});

/**
 * E6 had no arm.
 *
 * ## What was wrong, and why every previous round wrote it as a scheduling problem
 *
 * Semantic-layer exit criterion E6 is *"a paired readout with `deltaQuestions >= -5`"*, and every round since
 * §12 has closed with the sentence "E6 is `unrun`". Read as a note about budget or about an API key, it invites
 * the obvious next step: dispatch. This file exists because that step was not available, and nothing said so.
 *
 * Three things were missing, and they are three different objects:
 *
 * 1. **The treatment could not be administered.** `run-ablation.ts` forwards twenty-five product options
 *    conditionally, each with a paragraph explaining why absence is the shipped configuration -- and
 *    `semanticCarry` was not one of them. There was no environment variable, no field on the arm's option type,
 *    and no line in the constructor. A run could not turn the mechanism on at all.
 * 2. **The artifact could not say whether it fired.** `CortexMemory.semanticCarryCensus()` exists and is
 *    tested, and no census reader in `cortex-eval` names it. So a dispatch -- had one been possible -- would
 *    have produced a delta of `0` with nothing on the record to distinguish "the layer carried nothing" from
 *    "the layer never ran", which is the ambiguity `bareRetry` was introduced to remove and `CortexMemory`'s
 *    own `semanticCarry` docblock calls the reason the switch is off.
 * 3. **Zero is the pass value.** `deltaQuestions >= -5` is satisfied by `0`, and `0` is also what a mechanism
 *    that never ran produces. A criterion that cannot fail is not a criterion -- `acceptance.ts`'s own header
 *    says so -- so the reading needs the reach beside it, on the same record, before it means anything.
 *
 * This round builds (1) and (2). (3) is a row, and a row over a number nobody can produce is the decoration
 * this campaign charged itself with in §4.3.
 *
 * ## Why the reach is asserted as a pair rather than as a count
 *
 * `semanticCarry: true` with `matched: 0` is a **complete** reading: the treatment was administered and reached
 * no window. That is a fact about the population -- the registered 500 questions each bring their own corpus, so
 * no question's window carries another's record, and the reach is zero by construction rather than by effect.
 * The tests below require that both numbers are on the record together, because either one alone is a reading
 * that cannot be argued with.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  cortextMemoryArmOptions,
  runCortexMemoryArm,
  toMemoryArmConfig,
} from '../bench-memory-arm.js';
import { createAblationPool } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';

import type { CortexMemoryArmOptions } from '../bench-memory-arm.js';
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

/** The arm switched on, which is the state every dispatch to `benchmark-cortex-memory.yml` is in. */
const ARM_ON = { CORTEX_MEMORY: '1' } as const;

describe('the arm can be dispatched to administer the treatment', () => {
  it('reads its own variable, and an unset variable is the control rather than the treatment', () => {
    // The default matters more here than for any other switch in this file. `semanticCarry` is absent from every
    // archived artifact because the option did not exist, so an unset variable that enabled it would retroactively
    // change the meaning of every published number rather than merely adding a field.
    expect(cortextMemoryArmOptions({ ...ARM_ON }).semanticCarry).toBe(false);
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SEMANTIC_CARRY: '0' }).semanticCarry,
    ).toBe(false);
  });

  it('turns it on for the strict string `1`, the same grammar as every other toggle in the arm', () => {
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SEMANTIC_CARRY: '1' }).semanticCarry,
    ).toBe(true);
  });

  it('records the switch in the artifact, because "ran the control" and "predates the field" are not the same', () => {
    // The property `conflicts` and `reviewPass` both state: a field that is written only when true leaves a
    // reader holding two byte-identical records for two different experiments. Every run from here on carries a
    // value; a run before it carries no field at all.
    expect(toMemoryArmConfig({ ...cortextMemoryArmOptions({ ...ARM_ON }) }).semanticCarry).toBe(
      false,
    );
    expect(
      toMemoryArmConfig({
        ...cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SEMANTIC_CARRY: '1' }),
      }).semanticCarry,
    ).toBe(true);
    // The absent case, which is the one a loose comparison gets wrong. `semanticCarry` is optional on the options
    // type, so a caller that builds the object by hand -- several tests do, and so does any future entry point --
    // leaves the field `undefined`. A projection written as `!== false` would read that as the treatment, which is
    // a claim of a treatment nobody administered on a run that has no trace of one.
    const handBuilt: CortexMemoryArmOptions = { ...cortextMemoryArmOptions({ ...ARM_ON }) };
    delete handBuilt.semanticCarry;
    expect(toMemoryArmConfig(handBuilt).semanticCarry).toBe(false);
  });

  it('projects the control on a disabled arm even when the variable names the treatment', () => {
    // A disabled arm answers nothing, so no window carried anything. Projecting `true` here would put a treatment
    // on the record of a run that never consulted a model -- the claim-nobody-can-check defect the `featureConfig`
    // block exists to close.
    const disabled = cortextMemoryArmOptions({ CORTEX_MEMORY_SEMANTIC_CARRY: '1' });
    expect(disabled.enabled).toBe(false);
    expect(disabled.semanticCarry).toBe(false);
  });
});

/**
 * A system whose carry census is per-instance, which is what the product's is.
 *
 * `#semantic` in `CortexMemory` is an instance field incremented by the answering path, so a double that returned
 * a **shared** object would pass under the truncated-sum defect: the shared object would accumulate across workers
 * and the total would be right by accident. Each instance here owns its counters.
 */
class CarryingSystem implements MemorySystem {
  readonly name: string;
  readonly #absorbed: number;
  readonly #matched: number;

  constructor(name: string, absorbed: number, matched: number) {
    this.name = name;
    this.#absorbed = absorbed;
    this.#matched = matched;
  }

  async answer(): Promise<Answer> {
    return 'one';
  }

  semanticCarryCensus(): {
    absorbed: number;
    dropped: number;
    matched: number;
    served: number;
    withheld: number;
    stored: { episodic: number; procedural: number; semantic: number };
  } {
    return {
      absorbed: this.#absorbed,
      dropped: 0,
      matched: this.#matched,
      served: this.#matched,
      withheld: this.#matched,
      stored: { episodic: 0, procedural: 0, semantic: this.#absorbed },
    };
  }
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

function bareSystem(name: string): MemorySystem {
  return { name, answer: () => 'one' };
}

describe('the artifact says whether the mechanism fired', () => {
  it('carries the census, so a zero delta can be attributed rather than guessed at', async () => {
    const result = await runCortexMemoryArm(
      dataset(3),
      bareSystem('reference-pipeline'),
      new CarryingSystem('cortex-memory', 2, 0),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE, semanticCarry: true },
      },
    );

    // Two absorbed, none reached: the treatment was administered on a population that cannot carry it. That is
    // the registered 500 questions' shape, and it is now sayable from the artifact alone.
    expect(result.report.semanticCarry).toEqual({
      absorbed: 2,
      dropped: 0,
      matched: 0,
      served: 0,
      withheld: 0,
      stored: { episodic: 0, procedural: 0, semantic: 2 },
    });
    // The pair the reading needs. Either half alone is a number a reader would believe.
    expect(result.report.memoryArmConfig?.semanticCarry).toBe(true);
  });

  it('sums over every instance the run answered through, and does not publish a quarter of the run', async () => {
    // The rule §13.244 established for every other census in this arm, applied to this one before it can repeat
    // `41773546221`: the counts are per-instance, and a sum over worker 0 is a plausible lie.
    const pool = createAblationPool({
      workers: 3,
      first: {
        baseline: bareSystem('reference-pipeline'),
        feature: new CarryingSystem('f0', 1, 1),
      },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new CarryingSystem(`f${worker}`, 1, 1),
    });

    const result = await runCortexMemoryArm(
      dataset(6),
      bareSystem('reference-pipeline'),
      pool.featureInstances()[0]!,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE, semanticCarry: true },
        pool,
      },
    );

    expect(result.report.semanticCarry?.absorbed).toBe(3);
    expect(result.report.semanticCarry?.matched).toBe(3);
    // Both halves of the ledger, summed: `served` and `withheld` are the two counts that can look healthy while the
    // mechanism is dead (§E2), and either alone can be zero on a run whose other numbers are perfect.
    expect(result.report.semanticCarry?.served).toBe(3);
    expect(result.report.semanticCarry?.withheld).toBe(3);
    expect(result.report.semanticCarry?.stored).toEqual({
      episodic: 0,
      procedural: 0,
      semantic: 3,
    });
  });

  it('omits the field on a system with no census, rather than publishing zeros', async () => {
    // The rule every conditional census in this artifact follows. A zeroed record is indistinguishable from a run
    // whose window carried nothing, and the whole point of carrying the reach is that those two states are
    // different.
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

    expect(result.report.semanticCarry).toBeUndefined();
    expect('semanticCarry' in result.report).toBe(false);
  });

  it('omits the field when the accessor throws, because a broken instrument is not a reading', async () => {
    const broken = {
      name: 'cortex-memory',
      answer: async () => 'one',
      semanticCarryCensus: () => {
        throw new Error('no census in this build');
      },
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(2), bareSystem('reference-pipeline'), broken, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE },
    });

    expect('semanticCarry' in result.report).toBe(false);
  });

  it('omits a census that contradicts itself, because `absorbed - dropped` is the entries in hand', async () => {
    // The store's own arithmetic, stated in `semanticCarryCensus`'s docblock: `stored` counts the entries in
    // hand, so the difference between what was absorbed and what was evicted equals the sum of its three fields.
    // A record that breaks it is describing a store that cannot exist, and publishing its numbers would put the
    // instrument's error in the artifact as the run's finding. `supersessionAcross` states the same rule one
    // mechanism over (`attempted === replaced + refused`).
    const inconsistent = {
      name: 'cortex-memory',
      answer: async () => 'one',
      semanticCarryCensus: () => ({
        absorbed: 3,
        dropped: 0,
        matched: 0,
        served: 0,
        withheld: 0,
        stored: { episodic: 0, procedural: 0, semantic: 2 },
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

    expect('semanticCarry' in result.report).toBe(false);
  });

  it('refuses a `stored` census over more or fewer names than `MemoryType` has', async () => {
    // `stored` is the one field that is a census **over the product's taxonomy** rather than over events, so it is
    // the one field whose key set is a contract. A fourth name means this build's `MemoryType` and the reading
    // disagree; a missing one means the record describes fewer entry kinds than the store can hold. Both are
    // projected away by a reader that fills gaps with zeros, and a zero is indistinguishable from a count.
    for (const stored of [
      { episodic: 0, procedural: 0, semantic: 0, proceduralish: 0 },
      { episodic: 0, semantic: 0 },
    ]) {
      const system = {
        name: 'cortex-memory',
        answer: async () => 'one',
        semanticCarryCensus: () => ({
          absorbed: 0,
          dropped: 0,
          matched: 0,
          served: 0,
          withheld: 0,
          stored,
        }),
      } as unknown as MemorySystem;

      const result = await runCortexMemoryArm(
        dataset(1),
        bareSystem('reference-pipeline'),
        system,
        {
          runs: 1,
          scorer: exactMatchScorer,
          generatedAt: '1970-01-01T00:00:00.000Z',
          memoryArmConfig: { ...GATE },
        },
      );

      expect('semanticCarry' in result.report).toBe(false);
    }
  });

  it('omits the field when a count is not an integer, rather than publishing `NaN`', async () => {
    const fractional = {
      name: 'cortex-memory',
      answer: async () => 'one',
      semanticCarryCensus: () => ({
        absorbed: 1.5,
        dropped: 0,
        matched: 0,
        served: 0,
        withheld: 0,
        stored: { episodic: 0, procedural: 0, semantic: 1 },
      }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      fractional,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect('semanticCarry' in result.report).toBe(false);
  });

  it('omits the field when the census answers `null`, which is how the product states an absence', async () => {
    // §13.268: the product encodes a deliberate absence as a `null` rather than as a throw --
    // `CortexMemory.auditCensus` answers `null` under a pass that has no audit -- and the distinction between "no
    // mechanism" and "a mechanism that measured zero" is the reason. A reader that let the `null` through would
    // take the `TypeError` path by accident and report "broken instrument" for a state the store chose.
    const absent = {
      name: 'cortex-memory',
      answer: async () => 'one',
      semanticCarryCensus: () => null,
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(1), bareSystem('reference-pipeline'), absent, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE },
    });

    expect('semanticCarry' in result.report).toBe(false);
  });

  it('omits the field when `stored` is not a census at all', async () => {
    const noStored = {
      name: 'cortex-memory',
      answer: async () => 'one',
      semanticCarryCensus: () => ({
        absorbed: 0,
        dropped: 0,
        matched: 0,
        served: 0,
        withheld: 0,
        stored: null,
      }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      noStored,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect('semanticCarry' in result.report).toBe(false);
  });

  it('omits the field when a count is negative, which no store can report', async () => {
    // Distinct from the fractional case above and worth its own test for the same reason `recoveryOf` gives one:
    // a negative count is arithmetically impossible rather than imprecise, so accepting it would mean the reader
    // is coercing rather than validating, and every number after it is taken on trust.
    const negative = {
      name: 'cortex-memory',
      answer: async () => 'one',
      semanticCarryCensus: () => ({
        absorbed: 1,
        dropped: 0,
        matched: -1,
        served: 0,
        withheld: 0,
        stored: { episodic: 0, procedural: 0, semantic: 1 },
      }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      negative,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect('semanticCarry' in result.report).toBe(false);
  });
});

/**
 * The forward, which no test reaches.
 *
 * `bench/**` is excluded from coverage as an entry point, and the one line that carries the treatment from this
 * package's parsed options into the product's constructor lives there. Every other treatment in this arm has the
 * same gap and the same compensation -- §13.67's `maxTurnChars` records it in the constructor's own comment:
 * "which is why the same value is echoed in the log line below and projected into the artifact's own config: a
 * spread deleted here would leave the run's own log and its own config claiming a treatment the prompt never
 * received."
 *
 * A text assertion is weaker than a behavioural one: it proves the line exists, not that it runs. It is used here
 * for the reason `bench-arm-options.test.ts` uses it for `retrievalSides` -- there is no seam to execute, and the
 * alternative is an untested line that decides whether E6's treatment is administered at all.
 */
describe('the forward from the arm options into the product constructor', () => {
  const ARM = readFileSync(
    new URL('../../../cortex-memory/bench/run-ablation.ts', import.meta.url),
    'utf8',
  );

  it('spreads the switch into the constructor, so the treatment has an on-switch at all', () => {
    // The spread reads the construction's own argument rather than the parsed option, because under
    // `CORTEX_MEMORY_AB=carry` the same construction is asked for twice with one flag between them --
    // the feature side carrying, the baseline side not. Reading `armOptions` here would build the
    // treatment on both sides and publish a null result for a comparison that never happened.
    expect(ARM).toContain('...(treatment.carry ? { semanticCarry: true } : {})');
    expect(ARM).toContain('const buildFeature = (): CortexMemory => buildCortex(armTreatment);');
  });

  it('builds the control from the same construction, differing in one key alone', () => {
    // The pair is one treatment literal and one key. A second literal for the control would be a second
    // definition of the arm's twenty-six options, and the two would agree until one of them was edited.
    //
    // Each branch rewrites exactly ONE key and spreads the rest through, which is now a property of the
    // SYNTAX rather than of a comment: under the old positional form a branch had to name every argument,
    // so "flip one, pass the other" was asserted by string-equality against two whole lines and a third
    // flag made that assertion unreadable. `{ ...armTreatment, carry: false }` cannot flip two keys
    // without spelling the second one, and a pairing added to `ArmPairing` is a compile error here.
    for (const [pairing, flip] of [
      ['carry', 'carry: false'],
      ['clock', 'clock: false'],
      ['resolution', "resolution: 'raw'"],
    ] as const) {
      expect(ARM).toContain(
        `case '${pairing}':\n        return buildCortex({ ...armTreatment, ${flip} });`,
      );
    }
  });

  it('refuses a resolution pair whose treatment side renders the registered form', () => {
    // `C7`'s `F1` requires the mechanism to be shown running (≥90/500 digests change) before any
    // accuracy number is read. A pair with `raw` on both sides reads `F1` as zero, and the consequence
    // table's first row is "the run is void, fix the implementation" -- which is the wrong diagnosis for
    // what is actually a dispatch error. Refused before the first call, like the other two.
    expect(ARM).toContain("pairing === 'resolution' && armOptions.resolution !== 'layered'");
  });

  it('spreads the resolution from the treatment rather than from the parsed option', () => {
    // The same defect one key over: `CORTEX_MEMORY_RESOLUTION=layered` is `layered` for the whole
    // process, so reading `armOptions` inside the literal would render both sides layered and the pair
    // would compare the mechanism against itself.
    expect(ARM).toContain(
      "...(treatment.resolution === 'raw' ? {} : { resolution: treatment.resolution })",
    );
    expect(ARM).not.toContain(
      '...(forwardedResolution === undefined ? {} : { resolution: forwardedResolution })',
    );
  });

  it('refuses a carry pair whose treatment side was left off', () => {
    // Two sides of one system with the carry off on both is the one run this round exists to make
    // impossible: `delta = 0` with a census of `0`, read as "the layer carried nothing" when the truth
    // is "the layer was never asked". Refused before the first call, so it costs nothing.
    expect(ARM).toContain("pairing === 'carry' && armOptions.semanticCarry !== true");
  });

  it('refuses a clock pair whose treatment side was left off, for the same reason one flag over', () => {
    // The clock's criterion (`C1`) is a PAIRED movement on `MR`, and a pair with the clock off on both
    // sides lands on `C1`'s null branch -- which the pre-registration reads as "the effect is below the
    // floor or points the other way". A run that never administered the treatment must not be able to
    // occupy that branch.
    expect(ARM).toContain("pairing === 'clock' && armOptions.sessionClock !== 'on'");
  });

  it('spreads the clock from the construction’s argument rather than from the parsed option', () => {
    // The same defect the carry's spread avoids, and the reason the two arguments exist at all: under
    // `AB=clock` the parsed option is `on` for the whole process, so a read of it here would put the
    // treatment on both sides of the pair that is measuring it.
    expect(ARM).toContain('...(treatment.clock ? { sessionClock: true } : {})');
    expect(ARM).not.toContain(
      "...(armOptions.sessionClock === 'on' ? { sessionClock: true } : {})",
    );
  });

  it('records which flag the pair split, because the delta’s meaning is not in the switch alone', () => {
    // `sessionClock=on` says the treatment was administered; `clockPair` says what it was administered
    // against. Without the second, a `clock` dispatch and a registered-population dispatch that both set
    // the clock would be the same bytes with two different meanings.
    expect(ARM).toContain("clockPair: pairing === 'clock'");
    expect(ARM).toContain("carryPair: pairing === 'carry'");
    // And the third: `resolution=layered` is the treatment, `resolutionPair` says the baseline rendered
    // `raw` in the same job. Without it a `resolution` dispatch at one window is indistinguishable in the
    // artifact from a headline run that happened to set the form.
    expect(ARM).toContain("resolutionPair: pairing === 'resolution'");
  });

  it('names the same identifier that the product option type declares', () => {
    // The two halves of one wire. A rename on either side would leave both files compiling -- the product's option
    // is optional, and the arm's cast is at the boundary -- while the spread passed a property the constructor
    // ignores, which is the failure `bench-arm-options.ts` exists to prevent.
    const product = readFileSync(
      new URL('../../../cortex-memory/src/types.ts', import.meta.url),
      'utf8',
    );
    expect(product).toMatch(/semanticCarry\?: boolean;/);
    expect(ARM).toContain('semanticCarry');
  });

  it('echoes the value on the line the run prints, so a scrollback can answer whether it was on', () => {
    expect(ARM).toContain('semanticCarry=${armOptions.semanticCarry === true}');
  });

  it('records it in the feature config, beside the flag that says the arm ran at all', () => {
    expect(ARM).toContain('semanticCarry: armOptions.semanticCarry === true');
  });
});

/**
 * The split, wired where it has to be and in the order it has to be in.
 *
 * Same weakness as the block above and the same reason: the harness is a script, there is no seam to
 * call, and every one of these lines decides whether a sixteen-shard dispatch answers the population
 * or sixteen overlapping slices of it.
 */
describe('the split, and where it sits among the selectors', () => {
  const ARM = readFileSync(
    new URL('../../../cortex-memory/bench/run-ablation.ts', import.meta.url),
    'utf8',
  );

  it('reads both variables through the reader that refuses one without the other', () => {
    // Two `process.env` reads at the call site would leave the mutual refusal in `shard.ts` unused
    // and the dispatch free to set one of them.
    expect(ARM).toContain(
      "readShardPartition(\n    process.env['CORTEX_SHARD'],\n    process.env['CORTEX_SHARDS'],",
    );
  });

  it('cuts the corpus population before the multiplication', () => {
    // A split taken after `withWindows` puts the two windows of a corpus in two jobs, and the carry
    // is then written on one machine and read on another -- a reach of zero that has nothing to do
    // with the semantic layer.
    const cut = ARM.indexOf('shardDataset(restricted, shardPartition)');
    const multiplied = ARM.indexOf('withWindows(oracle === undefined ? sharded');
    expect(cut).toBeGreaterThan(-1);
    expect(multiplied).toBeGreaterThan(-1);
    expect(cut).toBeLessThan(multiplied);
  });

  it('annotates the oracle after the cut, so it describes the questions this job grades', () => {
    const cut = ARM.indexOf('shardDataset(restricted, shardPartition)');
    const oracle = ARM.indexOf('oracleEvidenceDataset(sharded)');
    expect(oracle).toBeGreaterThan(cut);
  });

  it('records the population for a shard even at one window', () => {
    // The condition is the pair, not the multiplication: a sharded single-window run has no windows
    // to record and still has to say that it is a part, or its `corpora` reads as a whole one.
    expect(ARM).toContain('windows === 1 && shardPartition === undefined');
    expect(ARM).toContain('shard: { index: shardPartition.shard, shards: shardPartition.shards }');
  });
});

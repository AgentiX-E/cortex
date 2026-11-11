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
    'not-later': 0,
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
  /**
   * The substitutions this instance performed, cumulative.
   *
   * The values come from the counter so two questions' pairs are distinguishable, which is what makes an
   * ordering assertion possible: with a constant pair, a fold that reversed the repetitions would pass.
   */
  #rewrites: { first: string; final: string }[] = [];

  constructor(name: string) {
    this.name = name;
  }

  async answer(): Promise<Answer> {
    this.#census.attempted += 1;
    this.#census.replaced += 1;
    this.#rewrites.push({
      first: `${this.#census.attempted}`,
      final: `late-${this.#census.attempted}`,
    });
    return 'one';
  }

  supersessionCensus(): {
    attempted: number;
    replaced: number;
    refused: number;
    refusals: Refusals;
    rewrites: readonly { first: string; final: string }[];
  } {
    const refused = Object.values(this.#census.refusals).reduce((sum, count) => sum + count, 0);
    return {
      attempted: this.#census.attempted,
      replaced: this.#census.replaced,
      refused,
      refusals: { ...this.#census.refusals },
      rewrites: [...this.#rewrites],
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
    expect(Object.keys(result.report.supersession?.refusals ?? {})).toHaveLength(8);
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

/**
 * A system that consults on every question and refuses every claim, naming the reason.
 *
 * §13.370's `P3` is a claim about eight named questions -- *no gate target may be refused as a restatement* --
 * and the run-level census cannot support it: it counts reasons across the run without saying whose they were.
 * This fixture is the one that makes the attribution fail if the per-question field is dropped, because the
 * aggregate alone cannot distinguish "one question refused four times" from "four questions refused once".
 */
class RestatingSystem implements MemorySystem {
  readonly name: string;
  #restates = 0;

  constructor(name: string) {
    this.name = name;
  }

  // Takes the question because one test below narrows the population by it; the base behaviour ignores it.
  async answer(_question?: string): Promise<Answer> {
    this.#restates += 1;
    return 'one';
  }

  supersessionCensus(): {
    attempted: number;
    replaced: number;
    refused: number;
    refusals: Refusals;
  } {
    return {
      attempted: this.#restates,
      replaced: 0,
      refused: this.#restates,
      refusals: refusalsOf({ restates: this.#restates }),
    };
  }
}

describe('the refusal reason reaches the question it belongs to', () => {
  it('writes the reasons per question, and the run census still sums them', async () => {
    // Without the per-question field the run-level tally is the only record, and `P3` would be unscorable:
    // 288 consultations and 8 restatements could be one gate target refused four times or eight ordinary
    // questions refused once, and the two readings license opposite conclusions about the value rule.
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      new RestatingSystem('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions!.map((record) => record.supersessionRefusals)).toEqual([
      { restates: 1 },
      { restates: 1 },
    ]);
    expect(result.report.supersession).toMatchObject({
      attempted: 2,
      replaced: 0,
      refused: 2,
    });
  });

  it('omits the field on a question the pass did not consult', async () => {
    // The same rule the coalesced fields follow everywhere else in this artifact: an absent measurement is
    // omitted, not written as an empty record, so a reader can tell "not consulted" from "consulted and
    // refused nothing".
    const selective = new (class extends RestatingSystem {
      override async answer(question?: string): Promise<Answer> {
        return (question ?? '').includes('1') ? super.answer(question) : 'one';
      }
    })('cortex-memory');

    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      selective,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    const records = result.report.questions!;
    expect(records[0]!.supersessionRefusals).toBeUndefined();
    expect(records[1]!.supersessionRefusals).toEqual({ restates: 1 });
  });
});

describe('the refusal delta, on the three shapes a census can arrive in', () => {
  it('sums a reason across repetitions rather than overwriting it', async () => {
    // The map is keyed by question and a run asks each question `runs` times, so a merge that let the last write
    // win would report one repetition's refusals as the question's total (§13.262's defect, one census over).
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      new RestatingSystem('cortex-memory'),
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions!.map((record) => record.supersessionRefusals)).toEqual([
      { restates: 2 },
      { restates: 2 },
    ]);
    expect(result.report.supersession?.refusals.restates).toBe(4);
  });

  it('records nothing for a question on which no reason moved', async () => {
    // A consultation that replaced its answer moves `replaced` and no reason at all, so the delta is empty. It
    // must read as an empty record rather than as every reason at zero, or `P3`'s bar would be satisfied by
    // arithmetic instead of by a reading.
    let consulted = 0;
    const replacementOnly = {
      name: 'cortex-memory',
      answer: () => {
        consulted += 1;
        return 'one';
      },
      supersessionCensus: () => ({
        attempted: consulted,
        replaced: consulted,
        refused: 0,
        refusals: refusalsOf({}),
      }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      replacementOnly,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions![0]!.supersessionRefusals).toBeUndefined();
    expect(result.report.questions![0]!.supersessionReplacements).toBe(1);
  });

  it('writes no reasons at all when the census does not carry them', async () => {
    // The absent-payload branch, which is the build a third-party `MemorySystem` produces: an accessor with the
    // three counts and no reason record. A delta over absent readings is not a delta over zeros.
    let asked = 0;
    const withoutReasons = {
      name: 'cortex-memory',
      answer: () => {
        asked += 1;
        return 'one';
      },
      supersessionCensus: () => ({ attempted: asked, replaced: 0, refused: asked }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      withoutReasons,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions![0]!.supersessionConsultations).toBe(1);
    expect(result.report.questions![0]!.supersessionRefusals).toBeUndefined();
  });
});

describe('merging reasons that do not repeat', () => {
  it('keeps a reason the earlier repetition did not have', async () => {
    // The merge is by reason, not by position: a question refused as a restatement on one repetition and as
    // `no-change` on the next contributes one of each, and a merge that read a missing reason as "no key" rather
    // than as zero would drop whichever came first.
    let asked = 0;
    const alternating = {
      name: 'cortex-memory',
      answer: () => {
        asked += 1;
        return 'one';
      },
      supersessionCensus: () => ({
        attempted: asked,
        replaced: 0,
        refused: asked,
        // Cumulative, like the product: a reason once counted stays counted, and the next repetition adds one.
        refusals: refusalsOf(
          asked === 0 ? {} : asked === 1 ? { restates: 1 } : { restates: 1, 'no-change': 1 },
        ),
      }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      alternating,
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions![0]!.supersessionRefusals).toEqual({
      restates: 1,
      'no-change': 1,
    });
  });
});

/**
 * §14.110.1's gap, closed by measurement rather than by another dispatch.
 *
 * `43001135439` published `replaced 18` and the eighteen were unreadable: the record's `answer` is what the
 * pass shipped, so a wrong answer beside a positive count reads the same whether the pass destroyed a correct
 * answer or replaced one wrong answer with another. Reading the direction cost a second dispatch of the same
 * population against an **earlier** run's control arm. The pair is what makes it a property of one record.
 */
describe('the substitution itself reaches the question it belongs to', () => {
  it('writes the first and final strings per question, so a replacement has a direction', async () => {
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

    // `first` is the counterfactual the mechanism owes: the string the route would have returned with the pass
    // switched off. A record without it cannot separate a conversion from a damage, which is the state the
    // previous artifact was in and the reason this field exists.
    expect(result.report.questions!.map((record) => record.supersessionRewrites)).toEqual([
      [{ first: '1', final: 'late-1' }],
      [{ first: '2', final: 'late-2' }],
    ]);
  });

  it('concatenates the repetitions rather than deduplicating them', async () => {
    // Four repetitions of one question that substituted twice each are eight substitutions, and a set would
    // report four -- hiding exactly the instability `K1` is about, where one question converts on some
    // repetitions and damages on others.
    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      new SupersedingSystem('cortex-memory'),
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions![0]!.supersessionRewrites).toEqual([
      { first: '1', final: 'late-1' },
      { first: '2', final: 'late-2' },
    ]);
  });

  it('omits the field on a run whose pass consulted and substituted nothing', async () => {
    // The rule the coalesced fields follow everywhere else: an absent measurement is omitted rather than
    // written as an empty list, and `supersessionReplacements` already names the population.
    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      new RestatingSystem('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions![0]!.supersessionRewrites).toBeUndefined();
  });

  it('writes no pair for a build that carries the pass without the field', async () => {
    // A third-party system implementing the accessor as it was specified before this field existed. The record
    // must omit the pair rather than invent one, and the run must still publish its counts.
    const legacy = new (class {
      readonly name = 'cortex-memory';
      #asked = 0;
      async answer(): Promise<Answer> {
        this.#asked += 1;
        return 'one';
      }
      supersessionCensus() {
        return {
          attempted: this.#asked,
          replaced: this.#asked,
          refused: 0,
          refusals: refusalsOf({}),
        };
      }
    })();

    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      legacy as unknown as MemorySystem,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions![0]!.supersessionRewrites).toBeUndefined();
    expect(result.report.questions![0]!.supersessionReplacements).toBe(1);
  });
});

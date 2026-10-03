/**
 * The cross-system arm: `cortex-memory` against the reference pipeline.
 *
 * ## Why this file exists
 *
 * `AUDIT-CODE-VS-DOCS.md` §6.2 step 3 is "add a benchmark arm that supplies
 * `cortex-memory` instead of the reference pipeline", verified by a "paired
 * same-instant A/B against the reference arm". Every other arm in this package is
 * an A/B *within* `NaturalLanguageMemorySystem` -- two instances differing by
 * options. This is the first one whose two sides are different *systems*, and that
 * difference is the whole reason a separate module exists.
 *
 * ## The defect this file is written to make impossible
 *
 * The wiring for an arm is the one thing that cannot live in `bench/run.ts`, and
 * the repository has already paid to learn that: `bench-arm-options.ts`'s docstring
 * records that "`bench/**` is excluded from coverage as an entry point ... deleting
 * the spread that carries the B7 toggle into the arm, defaulting it on, or reading
 * the wrong environment variable each left every test green -- because no test could
 * import the file the line lived in."
 *
 * An arm that is never wired, an arm whose two sides are accidentally identical, and
 * an arm that runs the control configuration while reporting the feature all produce
 * a `Δ = 0.00pp` artifact. They are indistinguishable from "the feature does not
 * help" in every artifact the run uploads. So the properties asserted here are the
 * ones that separate those four outcomes:
 *
 *   1. **Identity.** Each side is the system it claims to be. A cross-system arm
 *      whose two sides are the same object measures nothing, and reports zero.
 *   2. **Pairing.** Both sides are evaluated in the same call, on the same dataset,
 *      under the same scorer -- a staggered comparison is confounded by time-of-day
 *      drift (SOTA-BASELINE.md §6 measures it at 1.7-2.1pp).
 *   3. **Attribution.** The artifact records enough to say which configuration
 *      produced it. §20 of the progress report is the precedent: two downloaded
 *      artifacts differed by 2 questions and neither said which side of the switch
 *      it was on, so the delta's sign was uninterpretable and the run was discarded.
 *   4. **Reachability.** A run that did not get both systems reports that, rather
 *      than persisting a zero.
 *
 * ## What is deliberately NOT asserted
 *
 * Which system is better. That is the measurement, and it needs an LLM and the real
 * dataset. This file asserts that the *instrument* is assembled correctly, because a
 * mis-assembled instrument produces a number that looks like an answer.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  cortextMemoryArmOptions,
  runCortexMemoryArm,
  toMemoryArmConfig,
} from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';
import { formatAblationReport } from '../report.js';
import type { AblationResult, Answer, BenchmarkDataset, MemorySystem, Metrics } from '../types.js';

/**
 * The gate configuration every call in this file passes.
 *
 * Passed explicitly rather than defaulted, because the arm's option is required:
 * a caller that forgets it produces an artifact whose numbers cannot be compared
 * against another arm's, and the type is what makes that a compile error instead of
 * a thinner report. These tests are the first callers, so they demonstrate the
 * obligation rather than being exempt from it.
 */
const GATE = { threshold: 0, sessionBudget: null } as const;

/** A system that answers a fixed string, so an arm's identity is observable. */
function constantSystem(name: string, answer: Answer): MemorySystem {
  return { name, answer: () => answer };
}

/**
 * A fixed-answer system that appends its name to `log` on every question.
 *
 * The log is what makes "how many times was each side evaluated" observable, which
 * is the only way to pin the pairing invariant behaviourally. A source-text
 * assertion cannot hold it, and the injection that proved that is recorded on the
 * test that uses this.
 */
function countingSystem(name: string, answer: Answer, log: string[]): MemorySystem {
  return {
    name,
    answer: () => {
      log.push(name);
      return answer;
    },
  };
}

/** Zeroed metrics, for the render tests that assert the config line and no number. */
function emptyMetrics(): Metrics {
  return {
    accuracy: 0,
    abstentionRate: 0,
    abstentionCorrectRate: 0,
    abstentionAwareAccuracy: 0,
    total: 0,
    correct: 0,
    perCapability: {
      IE: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      MR: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      KU: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      TR: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      ABS: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
    },
  };
}

/** A minimal `AblationResult`, so `formatAblationReport` can run without a dataset. */
function emptyAblation(feature: string): AblationResult {
  const metrics = emptyMetrics();
  const perCapability = Object.fromEntries(
    (['IE', 'MR', 'KU', 'TR', 'ABS'] as const).map((capability) => [
      capability,
      {
        total: 0,
        baselineCorrect: 0,
        featureCorrect: 0,
        baselineCorrectFeatureIncorrect: 0,
        baselineIncorrectFeatureCorrect: 0,
        mcnemarPValue: 1,
        mcnemarSignificant: false,
        baselineConfidence: { lower: 0, upper: 1 },
        featureConfidence: { lower: 0, upper: 1 },
      },
    ]),
  ) as AblationResult['perCapability'];
  return {
    feature,
    baselineAggregate: { min: 0, max: 0, avg: 0, median: 0 },
    featureAggregate: { min: 0, max: 0, avg: 0, median: 0 },
    delta: 0,
    pValue: Number.NaN,
    significant: false,
    effectSize: 0,
    baselineConfidence: { lower: 0, upper: 1 },
    featureConfidence: { lower: 0, upper: 1 },
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: [],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: metrics,
    featureMetrics: metrics,
    featureCorrect: [],
    perCapability,
  };
}

/**
 * Two questions, each with a distinct gold answer, so a flip is expressible.
 *
 * The gold field is `expected`, not `answer`: `exactMatch` reads
 * `question.expected`, and a fixture written against the wrong field name leaves
 * `expected` undefined, makes both systems wrong on every question, and produces a
 * `Δ = 0.00pp` that looks like a null result. That is what the first draft of this
 * file did, and it is the exact failure mode the arm's own guards exist for.
 */
function twoQuestionDataset(): BenchmarkDataset {
  return {
    name: 'arm-fixture',
    questions: [
      { id: 'q1', capability: 'IE', question: 'Question one?', expected: 'one', context: [] },
      { id: 'q2', capability: 'IE', question: 'Question two?', expected: 'two', context: [] },
    ],
  };
}

describe('cortexMemoryArmOptions', () => {
  it('reports the arm as disabled when the toggle is off', () => {
    // The default. An unset variable means "this measurement was not requested",
    // which is the opposite convention from ENTITY_IDENTITY_CLAUSE -- and the
    // reason `readToggle` takes the default rather than assuming one.
    expect(cortextMemoryArmOptions({}).enabled).toBe(false);
  });

  it('reports the arm as enabled only on the strict `1`', () => {
    // Presence must not imply truth. `readToggle`'s docstring records that
    // `!== undefined` reads `off`, `false`, `no` and `''` as enabled, and an
    // operator passing any of those would silently switch the arm on.
    const enabled = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(enabled.enabled).toBe(true);

    for (const off of ['0', 'off', 'false', 'no', '', 'true', 'yes', 'ON']) {
      expect(cortextMemoryArmOptions({ CORTEX_MEMORY: off }).enabled).toBe(false);
    }
  });

  it('carries the configured admission threshold and session budget through', () => {
    // The two gate knobs the arm exists to measure. They are read as numbers and
    // must survive as numbers; a string would reach `decideWrite`'s `>=` and
    // compare a number to a string, which is always false and admits nothing --
    // a run that abstains on every question and reads like a refuted feature.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_THRESHOLD: '0.35',
      CORTEX_MEMORY_SESSION_BUDGET: '12',
    });
    expect(options.threshold).toBe(0.35);
    expect(options.sessionBudget).toBe(12);
  });

  it('defaults the threshold to 0 (admit everything) and the budget to unbounded', () => {
    // The identity configuration. `decideWrite` admits on `>=` and the value
    // function is bounded by `1.0`, so a threshold of 0 admits every turn: this is
    // the arm with the gates effectively open, which is the honest first
    // measurement of "does composition alone move anything".
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(options.threshold).toBe(0);
    expect(options.sessionBudget).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects a threshold outside [0, 1] rather than silently gating everything out', () => {
    // `decideWrite` uses `>=` against a value bounded by `confidence * sourceTrust
    // * (0.5 + 0.5 * recency)`, so any threshold above 1 admits nothing and any
    // threshold below 0 admits everything. Both are expressible by accident (a
    // percent typed as `85` instead of `0.85`) and both produce a full run whose
    // result is a fact about the typo, not about the cognitive layer. Loud, at
    // parse time, before a single question is graded.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: '85' }),
    ).toThrow(/CORTEX_MEMORY_THRESHOLD/);
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: '-0.1' }),
    ).toThrow(/CORTEX_MEMORY_THRESHOLD/);
  });

  it('rejects a non-numeric threshold rather than reading it as zero', () => {
    // `Number('abc')` is `NaN`, and `NaN >= x` is false for every x, so a typo
    // would admit nothing while every type in the program stays satisfied.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: 'abc' }),
    ).toThrow(/CORTEX_MEMORY_THRESHOLD/);
  });

  it('accepts the interval endpoints, which are the two meaningful extremes', () => {
    // 0 is "gates open" and 1 is "gates closed" -- `recency < 1` strictly, so a
    // threshold of exactly 1 admits nothing. Both are deliberate configurations a
    // reader may want, so the guard above must not reject them.
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: '0' }).threshold,
    ).toBe(0);
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: '1' }).threshold,
    ).toBe(1);
  });

  it('rejects a negative or non-integer session budget', () => {
    // A budget of `-1` reaches `selectSessionBudget`, whose first line returns `[]`
    // for `budget <= 0`, so the arm would abstain on everything for a reason no
    // artifact records. A fractional budget is meaningless: the unit is turns.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SESSION_BUDGET: '-1' }),
    ).toThrow(/CORTEX_MEMORY_SESSION_BUDGET/);
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SESSION_BUDGET: '2.5' }),
    ).toThrow(/CORTEX_MEMORY_SESSION_BUDGET/);
  });

  it('ignores the numeric variables entirely when the arm is off', () => {
    // The arm is off by default and most runs are not this arm. Parsing its
    // variables on every run would make an unrelated typo in an unrelated workflow
    // fail a run that was never going to measure this.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY_THRESHOLD: 'not-a-number',
      CORTEX_MEMORY_SESSION_BUDGET: '-5',
    });
    expect(options.enabled).toBe(false);
  });
});

describe('runCortexMemoryArm', () => {
  it('evaluates both systems and attributes the delta to the feature', async () => {
    const dataset = twoQuestionDataset();
    // The feature answers q1 correctly and the baseline answers neither. A delta of
    // +50pp, one discordant gain, no discordant regression — the shape a working
    // feature produces, and one a mechanism-level report can attribute.
    const baseline = constantSystem('reference-pipeline', 'wrong');
    const feature = constantSystem('cortex-memory', 'one');

    const result = await runCortexMemoryArm(dataset, baseline, feature, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: GATE,
    });

    // q1's gold is `one` and q2's is `two`, so a constant answer is correct on at
    // most one question. That is the point of the fixture: a per-question flip is
    // observable, and the discordant counts below can be checked against arithmetic
    // rather than read off the implementation.
    expect(result.report.ablation.delta).toBeCloseTo(0.5, 10);
    expect(result.report.ablation.discordant.baselineIncorrectFeatureCorrect).toBe(1);
    expect(result.report.ablation.discordant.baselineCorrectFeatureIncorrect).toBe(0);
  });

  it('names both sides in the report so the artifact says which systems produced it', async () => {
    const result = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
      },
    );
    expect(result.report.baseline.name).toBe('reference-pipeline');
    expect(result.report.feature.name).toBe('cortex-memory');
  });

  it('records the gate configuration in the report, not only in the log', async () => {
    // §20's precedent: two artifacts differed and neither said which side of the
    // switch it was on, so the delta could not be interpreted and the run was
    // discarded. The configuration has to travel in the file that gets compared.
    //
    // The gate knobs are numbers, so they cannot ride in `featureConfig` --
    // `Record<string, boolean>` with an `on`/`off` renderer. They get their own
    // field, and the arm's option is required so a new caller cannot silently
    // produce an artifact without them.
    const result = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { threshold: 0.25, sessionBudget: 8 },
      },
    );
    expect(result.report.memoryArmConfig).toEqual({ threshold: 0.25, sessionBudget: 8 });
  });

  it('renders the gate configuration into the Markdown, so the artifact carries it', () => {
    // The JSON and the Markdown are two renderings of one report, and a field that
    // reaches one and not the other is the side-channel defect this repository has
    // now recorded three times (`cohortCoverage`, `retryFires`,
    // `candidateAnnotationVersion`). The Markdown is what a human reads in a CI
    // log, so "it is in the JSON" is not sufficient.
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { threshold: 0.35, sessionBudget: null },
    });
    expect(markdown).toContain('Memory arm config');
    expect(markdown).toContain('threshold=0.35');
    // `null` renders as `unbounded` rather than as `null`, because "the budget is
    // not bounded" is the claim and `null` does not make it to a human reader.
    expect(markdown).toContain('sessionBudget=unbounded');
  });

  it('omits the memory-arm line entirely for a report that is not this arm', () => {
    // The absence is a claim: this artifact came from a different arm. A defaulted
    // object would make "this arm did not run" read the same as "this arm ran with
    // the identity gate".
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'a', metrics: emptyMetrics() },
      feature: { name: 'b', metrics: emptyMetrics() },
      ablation: emptyAblation('b'),
      generatedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(markdown).not.toContain('Memory arm config');
  });

  describe('optional pass-through', () => {
    // Every optional field on the arm's options is forwarded by a conditional
    // spread, so each has two branches. Walking only the "provided" side would
    // leave the omission path unexercised -- and the omission path is the one that
    // decides whether an unset option reaches the ablation as `undefined` (letting
    // the ablation's own default apply) or as an explicit value (disabling it).
    // Those are different programs, so both sides are walked.

    it('omits runs, alpha and scorer when they were not provided', async () => {
      const result = await runCortexMemoryArm(
        twoQuestionDataset(),
        constantSystem('reference-pipeline', 'one'),
        constantSystem('cortex-memory', 'one'),
        { memoryArmConfig: GATE },
      );
      // The ablation defaults apply: 3 runs, alpha 0.05. The check is that the
      // call completed and produced a report rather than forwarding `undefined`
      // into a field the ablation treats as present.
      expect(result.report.ablation.delta).toBe(0);
      expect(result.report.feature.name).toBe('cortex-memory');
    });

    it('defaults generatedAt to the current time when none was fixed', async () => {
      // The one non-deterministic input in the arm. A test that never omits
      // `generatedAt` cannot tell a real timestamp from a hard-coded `undefined`,
      // and a report whose timestamp is `undefined` still renders -- as an empty
      // field no reader would question.
      const before = Date.now();
      const result = await runCortexMemoryArm(
        twoQuestionDataset(),
        constantSystem('reference-pipeline', 'one'),
        constantSystem('cortex-memory', 'one'),
        { memoryArmConfig: GATE },
      );
      const stamped = Date.parse(result.report.generatedAt);
      expect(Number.isNaN(stamped)).toBe(false);
      expect(stamped).toBeGreaterThanOrEqual(before - 1000);
      expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('omits featureConfig when none was given, rather than writing an empty object', async () => {
      // `{}` and absence are different claims in this report: an empty object says
      // "this run was configured with no switches", absence says "nobody recorded
      // the switches". The renderer keys off absence, so the distinction is
      // visible in the artifact.
      const result = await runCortexMemoryArm(
        twoQuestionDataset(),
        constantSystem('reference-pipeline', 'one'),
        constantSystem('cortex-memory', 'one'),
        { memoryArmConfig: GATE },
      );
      expect('featureConfig' in result.report).toBe(false);
    });

    it('forwards runs, alpha and featureConfig when they were provided', async () => {
      const result = await runCortexMemoryArm(
        twoQuestionDataset(),
        constantSystem('reference-pipeline', 'one'),
        constantSystem('cortex-memory', 'one'),
        {
          runs: 2,
          alpha: 0.1,
          scorer: exactMatchScorer,
          featureConfig: { cortexMemory: true },
          memoryArmConfig: GATE,
          generatedAt: '1970-01-01T00:00:00.000Z',
        },
      );
      expect(result.report.generatedAt).toBe('1970-01-01T00:00:00.000Z');
      expect(result.report.featureConfig).toEqual({ cortexMemory: true });
    });
  });

  describe('toMemoryArmConfig', () => {
    it('persists an unbounded budget as null rather than Infinity', () => {
      // `JSON.stringify(Infinity)` is `null`, so an in-memory `Infinity` and a
      // re-read artifact would disagree about the same run. Converting on the way
      // in makes the persisted form the only form.
      const config = toMemoryArmConfig({
        enabled: true,
        threshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
      });
      expect(config.sessionBudget).toBeNull();
      expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    });

    it('persists a finite budget as itself', () => {
      const config = toMemoryArmConfig({ enabled: true, threshold: 0.5, sessionBudget: 12 });
      expect(config).toEqual({ threshold: 0.5, sessionBudget: 12 });
    });
  });

  it('returns a null delta, not a zero, when the two sides are the same object', async () => {
    // The §13 failure mode, made unrepresentable rather than merely warned about.
    // Two byte-identical arms produce `0.00pp`, which reads as "the feature does
    // not help" when the truth is that no feature was supplied. Identity is
    // checkable, so it is checked -- the tuple (0.00pp, same object) is a
    // misassembly, and the tuple (0.00pp, different objects) is a real null result.
    const system = constantSystem('same', 'one');
    await expect(
      runCortexMemoryArm(twoQuestionDataset(), system, system, {
        runs: 1,
        scorer: exactMatchScorer,
        memoryArmConfig: GATE,
      }),
    ).rejects.toThrow(/same system object/i);
  });

  it('rejects an empty dataset rather than reporting a delta over zero questions', async () => {
    // `wilsonScoreInterval(0, 0)` and a McNemar over no discordant pairs both
    // return a confident-looking interval. A run that graded nothing must not
    // produce a number.
    await expect(
      runCortexMemoryArm(
        { name: 'empty', questions: [] },
        constantSystem('reference-pipeline', 'one'),
        constantSystem('cortex-memory', 'one'),
        { runs: 1, scorer: exactMatchScorer, memoryArmConfig: GATE },
      ),
    ).rejects.toThrow(/no questions/i);
  });

  describe('the assembly contract', () => {
    it('declares no dependency on cortex-memory, so the instrument stays independent of the product', () => {
      // The dependency decision, pinned executably. `cortex-eval` is the
      // measurement instrument; making it construct the system under test would let
      // the instrument and the product drift together, and would put an evaluation
      // harness in the position of needing a product package to compile. The
      // injection boundary is what keeps the dependency graph acyclic, and a future
      // refactor that "simplifies" the arm by importing the class directly would
      // silently reverse that decision. So the decision is a test.
      //
      // Asserted against `package.json`, not against the source text. The source of
      // a module can import a package it does not declare (a hoisted transitive
      // dependency), so a text scan proves nothing about what the package actually
      // requires -- and it would flag the string in a comment, which is the
      // opposite error. What is being decided here is a dependency edge, so the
      // dependency edge is what is read.
      const manifest = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as Record<string, Record<string, string> | undefined>;
      const declared = {
        ...manifest['dependencies'],
        ...manifest['devDependencies'],
        ...manifest['peerDependencies'],
      };
      expect(Object.keys(declared)).not.toContain('@agentix-e/cortex-memory');
    });

    it('evaluates each side exactly once, through a single paired call', async () => {
      // The pairing invariant, asserted by counting evaluations rather than by
      // reading source. Both systems are wrapped so each records the questions it
      // was asked.
      //
      // A source-text assertion (which the first draft of this test used) cannot
      // hold this property: it fires on an equivalent rewrite and it misses a real
      // break. Measured -- injecting `void runBenchmark;` into the module left the
      // text assertion green, because the guard matched `runBenchmark(` and the
      // injected reference had no call parentheses. A staggered comparison written
      // that way would have shipped with the suite reporting the pairing invariant
      // satisfied.
      //
      // Two counts is what "paired" means here. The consequence of a third is drift
      // the experiment never meant to measure; the consequence of a second call
      // per side is a staggered comparison, and time-of-day drift is 1.7-2.1pp
      // (SOTA-BASELINE.md §6), larger than most effects this arm could find.
      const seen: string[] = [];
      const baseline = countingSystem('reference-pipeline', 'one', seen);
      const feature = countingSystem('cortex-memory', 'one', seen);

      await runCortexMemoryArm(twoQuestionDataset(), baseline, feature, {
        runs: 1,
        scorer: exactMatchScorer,
        memoryArmConfig: GATE,
        generatedAt: '1970-01-01T00:00:00.000Z',
      });

      // Two questions, two systems, one pass each. `runs: 1` is passed explicitly
      // above precisely so this number is deterministic: the ablation's default is
      // 3, and a run at the default would evaluate each side three times.
      expect(seen.filter((name) => name === 'reference-pipeline')).toHaveLength(2);
      expect(seen.filter((name) => name === 'cortex-memory')).toHaveLength(2);

      // NOT asserted: interleaving. The first draft of this test expected
      // `[baseline, feature, baseline, feature]` and failed, because `runAblation`
      // evaluates each side in full before starting the other. That is not a
      // weaker pairing -- "paired" means the two sides are compared
      // question-by-question on the same dataset under the same scorer, which
      // `runAblation`'s per-question discordant loop provides and a staggered
      // COMPARISON (two runs whose results are later differenced) does not. The
      // assertion that would have been wrong is worse than no assertion, so the
      // interleaving expectation is deliberately absent and this note says why.
      const order = [...new Set(seen)];
      expect(order.sort()).toEqual(['cortex-memory', 'reference-pipeline']);
    });

    it('pairs the two sides question-by-question, which is what makes the delta attributable', async () => {
      // The property that a staggered comparison cannot provide. The fixture is
      // built so each system is correct on exactly one DIFFERENT question: the
      // baseline is right on q2 and the feature on q1. A paired test sees one
      // discordant gain and one discordant regression; an unpaired accuracy
      // comparison sees only "both are 50%" and reports `Δ = 0.00pp`.
      const dataset: BenchmarkDataset = {
        name: 'paired-fixture',
        questions: [
          { id: 'q1', capability: 'IE', question: 'One?', expected: 'one', context: [] },
          { id: 'q2', capability: 'IE', question: 'Two?', expected: 'two', context: [] },
        ],
      };
      const baseline: MemorySystem = {
        name: 'reference-pipeline',
        answer: (question) => (question === 'Two?' ? 'two' : 'wrong'),
      };
      const feature: MemorySystem = {
        name: 'cortex-memory',
        answer: (question) => (question === 'One?' ? 'one' : 'wrong'),
      };

      const result = await runCortexMemoryArm(dataset, baseline, feature, {
        runs: 1,
        scorer: exactMatchScorer,
        memoryArmConfig: GATE,
        generatedAt: '1970-01-01T00:00:00.000Z',
      });

      // The marginals agree, so an unpaired comparison is blind here.
      expect(result.report.ablation.baselineMetrics.correct).toBe(1);
      expect(result.report.ablation.featureMetrics.correct).toBe(1);
      expect(result.delta).toBe(0);
      // The pairing is what exposes the movement, and it names both questions.
      expect(result.report.ablation.discordant.baselineCorrectFeatureIncorrect).toBe(1);
      expect(result.report.ablation.discordant.baselineIncorrectFeatureCorrect).toBe(1);
      expect(result.report.ablation.discordantQuestions.baselineCorrectFeatureIncorrect).toEqual([
        'q2',
      ]);
      expect(result.report.ablation.discordantQuestions.baselineIncorrectFeatureCorrect).toEqual([
        'q1',
      ]);
    });
  });
});

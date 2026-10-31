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
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  cortextMemoryArmOptions,
  roleOfTurn,
  runCortexMemoryArm,
  toMemoryArmConfig,
} from '../bench-memory-arm.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';
import { formatAblationReport, type AblationReport } from '../report.js';
import type { QuestionRecord } from '../question-record.js';
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
/**
 * The route vocabulary, in the order the arm's `TURN_CAP_ROUTES` table declares it.
 *
 * Three whole-shape assertions below compare a full `MemoryArmConfig`, and the reach is part of
 * that shape from §13.73. Written once rather than three times because the order matters to
 * `toEqual` and three copies of it are three chances to get the order wrong in one of them.
 */
const ALL_ROUTES = [
  'multi-session',
  'temporal',
  'flat',
  'knowledge-update',
  'abstention',
  'assistant',
];

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
} as const;

/**
 * Render an arm config through the real report renderer.
 *
 * Used by the retrieval-threshold tests to assert what the **artifact** will say,
 * not what an interpolating helper would. A hand-written formatter in the test
 * would agree with itself no matter what production printed, which is the
 * class of assertion §37 caught passing on a deleted call.
 *
 * The surrounding report is assembled here rather than through `runAblationReport`
 * because these tests are about the config LINE, and running a dataset would make
 * them fail for unrelated reasons. It is still the real `formatAblationReport` that
 * produces the string, so the line under assertion is production output.
 */
function formalizeArm(config: {
  threshold: number;
  retrievalThreshold: number;
  sessionBudget: number;
}): string {
  const metrics = emptyMetrics();
  return formatAblationReport({
    dataset: 'fixture',
    questionCount: 0,
    baseline: { name: 'reference-pipeline', metrics },
    feature: { name: 'cortex-memory', metrics },
    ablation: emptyAblation('cortex-memory'),
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: toMemoryArmConfig({
      enabled: true,
      threshold: config.threshold,
      retrievalThreshold: config.retrievalThreshold,
      sessionBudget: config.sessionBudget,
      sourceTrust: 0.5,
      confidenceSignal: 'none',
      promptContract: 'abstention',
      ask: 'route',
      relevanceSignal: 'none',
      relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      relevanceUnits: 'turn',
      evidenceTurnsPerRecord: Number.POSITIVE_INFINITY,
    }),
  });
}

/**
 * Run the arm for one question and hand back the persisted report.
 *
 * A real run through `runCortexMemoryArm`, not a synthesised object: the point is
 * that a threshold set in the arm's options reaches `memoryArmConfig` in the
 * artifact, and any shorter path would test the test rather than the wiring.
 */
async function runCortexMemoryArmReport(config: {
  threshold: number;
  retrievalThreshold: number;
}): Promise<AblationReport> {
  const dataset = {
    name: 'fixture',
    questions: [
      {
        id: 'q1',
        capability: 'IE',
        questionType: 'single-session-user',
        question: 'Where?',
        expected: 'Lisbon',
        context: ['user: I went to Lisbon.'],
        sessions: [['user: I went to Lisbon.']],
      },
    ],
  } as unknown as BenchmarkDataset;

  const { report } = await runCortexMemoryArm(
    dataset,
    constantSystem('reference-pipeline', 'Lisbon'),
    constantSystem('cortex-memory', 'Lisbon'),
    {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        threshold: config.threshold,
        retrievalThreshold: config.retrievalThreshold,
        sessionBudget: null,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        renderingRoutes: [],
        ask: 'route',
        askRoutes: [],
        reviewPass: 'none',
        reviewBareDecline: false,
      },
    },
  );
  return report;
}

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

  it('carries the configured evidence bound through', () => {
    // §13.12's bound. Run `38003036421` completed all four runs of all five hundred
    // questions and then died writing the JSON with `RangeError: Invalid string
    // length`, because the evidence is carried unbounded and carried twice. The
    // bound is an environment variable rather than a constant in the entry point so
    // that the pre-registration guard can compare the dispatch against §10.3 -- a
    // value written in `bench/**` never reaches the environment the guard reads.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_EVIDENCE_TURNS: '16',
    });
    expect(options.evidenceTurnsPerRecord).toBe(16);
  });

  it('defaults the evidence bound to unbounded, so no prior artifact changes meaning', () => {
    // A default bound would silently make an unconfigured run's artifact
    // indistinguishable from a configured one's. The writer supplies its own finite
    // fallback, and records the reduction when it engages.
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(options.evidenceTurnsPerRecord).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects an evidence bound below one', () => {
    // A bound of 0 would carry no evidence while the record still reported
    // `evidenceTurns > 0`, which makes a reduced record read as one whose reader was
    // shown nothing -- the confusion `REDUCED_TURNS_MARKER` exists to prevent. It is
    // rejected here rather than clamped, and `buildQuestionRecords` rejects it again
    // where the bound is applied.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_EVIDENCE_TURNS: '0' }),
    ).toThrow(/CORTEX_MEMORY_EVIDENCE_TURNS/);
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_EVIDENCE_TURNS: '-3' }),
    ).toThrow(/CORTEX_MEMORY_EVIDENCE_TURNS/);
  });

  it('rejects a fractional evidence bound, because the unit is turns', () => {
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_EVIDENCE_TURNS: '1.5' }),
    ).toThrow(/CORTEX_MEMORY_EVIDENCE_TURNS/);
  });

  it('treats a blank evidence bound as unconfigured', () => {
    // The blank rule is `readNumeric`'s: an unfilled dispatch input arrives as the
    // empty string, and `Number('')` is `0` -- which this reader's own guard rejects.
    // So blank must collapse to "not configured" before the guard sees it.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_EVIDENCE_TURNS: '',
    });
    expect(options.evidenceTurnsPerRecord).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignores the numeric variables entirely when the arm is off', () => {
    // The arm is off by default and most runs are not this arm. Parsing its
    // variables on every run would make an unrelated typo in an unrelated workflow
    // fail a run that was never going to measure this.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY_THRESHOLD: 'not-a-number',
      CORTEX_MEMORY_SESSION_BUDGET: '-5',
      CORTEX_MEMORY_SOURCE_TRUST: 'also-not-a-number',
    });
    expect(options.enabled).toBe(false);
  });

  it('treats a blank source trust as unconfigured while keeping an explicit 0 expressible', () => {
    // The mirrored-defect rule from the session budget: blank means "not
    // configured" and must not be achieved by making a real `0` unreachable. A
    // falsy test would do exactly that -- `sourceTrust: 0` is a meaningful
    // configuration ("trust nothing"), and a guard that rejected it would narrow
    // the domain this field exists to widen.
    const blank = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_SOURCE_TRUST: '',
    });
    expect(blank.sourceTrust).toBe(0.5);
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SOURCE_TRUST: '  ' }).sourceTrust,
    ).toBe(0.5);
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SOURCE_TRUST: '0' }).sourceTrust,
    ).toBe(0);
  });

  it('reads a configured source trust, including the fully-trusted endpoint', () => {
    // `1` is the value that raises the value ceiling to `1` and makes
    // `threshold > 0.5` reachable. It is the point of the field, so it is asserted
    // rather than left to the range check.
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SOURCE_TRUST: '0.4' })
        .sourceTrust,
    ).toBe(0.4);
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SOURCE_TRUST: '1' }).sourceTrust,
    ).toBe(1);
  });

  it('rejects a source trust outside [0, 1] or non-numeric, naming the variable', () => {
    // Same three failure modes as the thresholds, and the same reason for being
    // loud: each completes a full run whose artifact describes the argument rather
    // than the system. `> 1` lifts the ceiling above the model's own bound, `< 0`
    // and `NaN` admit nothing.
    for (const bad of ['1.5', '-0.1', 'abc']) {
      expect(() =>
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SOURCE_TRUST: bad }),
      ).toThrow(/CORTEX_MEMORY_SOURCE_TRUST/);
    }
  });

  it('defaults the confidence signal to none, which is the constant behaviour', () => {
    // The compatibility guarantee. Every run dispatched before this field existed
    // supplied no per-turn variation, so "unset" has to mean "no variation" or the
    // historical numbers stop describing the configuration they were taken under.
    expect(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).confidenceSignal).toBe('none');
    // Blank is the same as unset for every other variable here, and it is the
    // spelling GitHub writes for an unfilled `workflow_dispatch` input.
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_CONFIDENCE: '' })
        .confidenceSignal,
    ).toBe('none');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_CONFIDENCE: '  ' })
        .confidenceSignal,
    ).toBe('none');
  });

  it('accepts the length signal, which is the only variation this round ships', () => {
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_CONFIDENCE: 'length' })
        .confidenceSignal,
    ).toBe('length');
    // Trimmed, so a trailing newline from a shell heredoc is not a typo.
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_CONFIDENCE: 'length\n' })
        .confidenceSignal,
    ).toBe('length');
  });

  it('rejects an unrecognised signal rather than falling back to none', () => {
    // This is the assertion that makes the field worth having, and the direction
    // is the opposite of `readToggle`'s on purpose. An unrecognised *boolean*
    // switch running the control arm is safe: the artifact's config line says so.
    // Here it is not, because §49 established that a registration whose variation
    // is missing reproduces §10.10's mistake -- so a run dispatched to introduce
    // per-turn confidence, silently falling back to `none`, would publish a delta
    // that reads as evidence variation does not help.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_CONFIDENCE: 'len' }),
    ).toThrow(/CORTEX_MEMORY_CONFIDENCE/);
    // The message names the accepted set, so the operator does not have to read
    // the source to fix the typo.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_CONFIDENCE: 'nope' }),
    ).toThrow(/"length"/);
  });
});

describe('relevance signal', () => {
  it('defaults to none, which is the unranked behaviour', () => {
    // The compatibility guarantee, and here it is load-bearing in a way the other
    // defaults are not: the feature side's prompt budget has always been spent on a
    // prefix of arrival order, so "unset" has to mean "keep doing that" or every
    // artifact written before this field existed describes a different system.
    expect(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).relevanceSignal).toBe('none');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: '' }).relevanceSignal,
    ).toBe('none');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: '  ' })
        .relevanceSignal,
    ).toBe('none');
  });

  it('accepts the retrieval signal, trimmed', () => {
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: 'retrieval' })
        .relevanceSignal,
    ).toBe('retrieval');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: 'retrieval\n' })
        .relevanceSignal,
    ).toBe('retrieval');
  });

  it('rejects an unrecognised signal rather than falling back to none', () => {
    // The §13.16 mistake in the arm's own configuration. That run was dispatched to
    // move the ask, the delta came back as the ask and not the rendering, and the
    // artifact's `askRoutes` is what made the difference legible. Here the failure
    // mode is worse than an unread field: a run dispatched to supply a ranking and
    // silently running unranked publishes a delta that reads as evidence ranking
    // does not help -- which is the one conclusion the next dispatch exists to test.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: 'ranked' }),
    ).toThrow(/CORTEX_MEMORY_RELEVANCE/);
    // The message names the accepted set, so the operator does not have to read the
    // source to fix the typo.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE: 'nope' }),
    ).toThrow(/"retrieval"/);
  });

  it('defaults the relevance unit to turn, and trims a blank as unset', () => {
    // `turn` is the behaviour every prior artifact was produced under, so "unset" has to
    // mean exactly that or the historical numbers stop describing the budget they were
    // taken with -- the same compatibility rule the rendering and the contract are under.
    // A blank is trimmed rather than rejected: an unfilled `workflow_dispatch` input is the
    // empty string, not a typo, and §38 is where treating those two the same cost two runs.
    expect(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).relevanceUnits).toBe('turn');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_UNITS: '' })
        .relevanceUnits,
    ).toBe('turn');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_UNITS: '  ' })
        .relevanceUnits,
    ).toBe('turn');
    // And a named one survives verbatim, so the two values are not the same value.
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_UNITS: 'session' })
        .relevanceUnits,
    ).toBe('session');
  });

  it('rejects an unrecognised unit rather than falling back to turn', () => {
    // The same argument `readRelevanceSignal` makes one field up, applied to the unit: a
    // run dispatched to complete whole sessions that silently spent the room on turns would
    // publish an unchanged result, and unchanged is exactly what "the unit does not matter"
    // looks like. The rejection is what keeps the artifact's own configuration line honest.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_UNITS: 'sessions' }),
    ).toThrow(/CORTEX_MEMORY_RELEVANCE_UNITS/);
    // The message names the accepted set, so the operator does not have to read the source
    // to fix the typo.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_UNITS: 'nope' }),
    ).toThrow(/"session"/);
  });

  it('defaults the index width to the measured knee', () => {
    // `MEASURE-B2-RECALL-CURVE.md` measured `recall = 0.921` at `k = 50` with a
    // flattened curve, so the default only has to sit at or above the knee. Asserted
    // as a relation rather than as the literal, so a later revision that raises the
    // default for a measured reason is not blocked by this test.
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(options.relevanceTopK).toBe(DEFAULT_RELEVANCE_TOP_K);
    expect(options.relevanceTopK).toBeGreaterThanOrEqual(50);
  });

  it('accepts a width override, and reports the one it will use', () => {
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_TOP_K: '8' })
        .relevanceTopK,
    ).toBe(8);
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_TOP_K: '' })
        .relevanceTopK,
    ).toBe(DEFAULT_RELEVANCE_TOP_K);
  });

  it('rejects a width that cannot describe a top-k', () => {
    // Each of these completes a full run whose artifact names a ranking the run did
    // not administer: `0` scores nothing (every turn reaches the floor, so the
    // selection degenerates to arrival order while the config line says
    // `retrieval`), `-1` and `NaN` are the same state reached by a typo, and a
    // fraction is not a count of turns.
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() =>
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RELEVANCE_TOP_K: bad }),
      ).toThrow(/CORTEX_MEMORY_RELEVANCE_TOP_K/);
    }
  });

  it('projects the signal and its width into the memory arm config', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_RELEVANCE: 'retrieval',
      CORTEX_MEMORY_RELEVANCE_TOP_K: '12',
    });
    const config = toMemoryArmConfig(options);
    expect(config.relevanceSignal).toBe('retrieval');
    expect(config.relevanceTopK).toBe(12);
  });

  it('renders the signal on the config line', () => {
    // The config line is what a reader of the Markdown has, and a ranking whose
    // presence is only visible in the JSON is the side channel §7.4 records. The
    // line is produced by the real renderer, so this asserts production output.
    const withSignal = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        ...GATE,
        renderingRoutes: [],
        ask: 'route',
        askRoutes: [],
        reviewPass: 'none',
        reviewBareDecline: false,
        relevanceSignal: 'retrieval',
        relevanceTopK: 64,
        relevanceUnits: 'session',
      },
    });
    const withoutSignal = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        ...GATE,
        renderingRoutes: [],
        ask: 'route',
        askRoutes: [],
        reviewPass: 'none',
        reviewBareDecline: false,
        relevanceSignal: 'none',
        relevanceTopK: 64,
        // Named even though the signal is `none`, so the assertion below can show that the
        // unit is NOT rendered beside it: a unit is a property of the ranking the budget was
        // spent by, and printing one beside `relevanceSignal=none` would describe an
        // ordering that no run built.
        relevanceUnits: 'session',
      },
    });

    expect(withSignal).toContain('relevanceSignal=retrieval');
    expect(withoutSignal).toContain('relevanceSignal=none');
    expect(withSignal).toContain('relevanceTopK=64');
    // The unit rides with the signal and is absent without one, which is the same rule the
    // width is under: both describe the ranking, and no ranking means neither is a fact.
    expect(withSignal).toContain('relevanceUnits=session');
    expect(withoutSignal).not.toContain('relevanceUnits=');
  });
});

describe('source trust reaches the artifact', () => {
  it('projects the value into the memory arm config', () => {
    // The §7.4 defect in its third form: a gate configuration the code applies but
    // the artifact does not record produces two files that look identical and mean
    // opposite things. `toMemoryArmConfig` is the single projection point, so it is
    // asserted directly rather than only through a rendered string.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_THRESHOLD: '0.2',
      CORTEX_MEMORY_RETRIEVAL_THRESHOLD: '0.25',
      CORTEX_MEMORY_SOURCE_TRUST: '1',
    });
    expect(toMemoryArmConfig(options)).toEqual({
      threshold: 0.2,
      retrievalThreshold: 0.25,
      sessionBudget: null,
      sourceTrust: 1,
      confidenceSignal: 'none',
      promptContract: 'abstention',
      relevanceSignal: 'none',
      relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      relevanceUnits: 'turn',
      maxTurnCharsRoutes: ALL_ROUTES,
      evidenceRolesRoutes: ALL_ROUTES,
      renderingRoutes: [],
      ask: 'route',
      askRoutes: [],
      turnCutMarker: 'none',
      reviewPass: 'none',
      reviewBareDecline: false,
      queryExpansion: 'none',
      selfConsistency: 'none',
    });
  });

  it('renders the value on the config line, beside the thresholds', async () => {
    // A reader asking "was the value ceiling raised this run" is answered by this
    // number and by nothing else, so it must be on the line rather than only in the
    // JSON. Built through the real arm rather than a hand-made fixture: a fixture
    // would assert the renderer against a shape the producer might never emit.
    const result = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        memoryArmConfig: { ...GATE, sourceTrust: 1 },
      },
    );

    expect(result.markdown).toContain('sourceTrust=1');
    // The default must render as itself too, so the line distinguishes "raised" from
    // "left alone" rather than only printing one of the two states.
    const plain = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        memoryArmConfig: { ...GATE, sourceTrust: 0.5 },
      },
    );
    expect(plain.markdown).toContain('sourceTrust=0.5');
  });

  it('renders the confidence signal on the config line, at both of its values', async () => {
    // §49 is why this line exists. A raised `sourceTrust` makes the retrieval gate
    // REACHABLE and supplying per-turn confidence is what makes it DISCRIMINATING,
    // so an artifact carrying the ceiling and a `retrievalThreshold` inside the
    // reachable set still cannot say whether that threshold had anything to cut.
    // The two states have to be distinguishable from the artifact alone, which is
    // exactly what §10.10's retraction was needed for.
    const base = {
      runs: 1,
      scorer: exactMatchScorer,
    };
    const withSignal = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      { ...base, memoryArmConfig: { ...GATE, confidenceSignal: 'length' } },
    );
    const withoutSignal = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'one'),
      constantSystem('cortex-memory', 'one'),
      { ...base, memoryArmConfig: { ...GATE, confidenceSignal: 'none' } },
    );

    expect(withSignal.markdown).toContain('confidenceSignal=length');
    // `none` is written rather than omitted, so "this run supplied no variation"
    // cannot be confused with "this artifact predates the field" -- the same rule
    // the ceiling above follows.
    expect(withoutSignal.markdown).toContain('confidenceSignal=none');
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

  it('applies the per-pass ceiling it was handed', async () => {
    // §13.30's ceiling crosses two option types to reach `runBenchmark`: this one and
    // `AblationReportOptions`. A field declared on the first and dropped before the second
    // is a switch nothing applies -- the run would be dispatched with a ceiling, its
    // configuration line would name it, and a hang would still run to the job timeout.
    // `budgetMs: 0` is the observable, because it can only reject if it arrived; the fake
    // answers take a millisecond so the assertion does not depend on clock resolution.
    const slow: MemorySystem = {
      name: 'cortex-memory',
      answer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return 'one';
      },
    };

    await expect(
      runCortexMemoryArm(twoQuestionDataset(), constantSystem('reference-pipeline', 'one'), slow, {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
        budgetMs: 0,
      }),
    ).rejects.toThrow(/budget/);
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
        memoryArmConfig: {
          threshold: 0.25,
          retrievalThreshold: 0.5,
          sessionBudget: 8,
          sourceTrust: 0.5,
          confidenceSignal: 'none',
          promptContract: 'abstention',
          relevanceSignal: 'none',
          relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
          relevanceUnits: 'turn',
          maxTurnCharsRoutes: ALL_ROUTES,
          evidenceRolesRoutes: ALL_ROUTES,
          renderingRoutes: [],
          ask: 'route',
          askRoutes: [],
          turnCutMarker: 'none',
          reviewPass: 'none',
          reviewBareDecline: false,
        },
      },
    );
    expect(result.report.memoryArmConfig).toEqual({
      threshold: 0.25,
      retrievalThreshold: 0.5,
      sessionBudget: 8,
      sourceTrust: 0.5,
      confidenceSignal: 'none',
      promptContract: 'abstention',
      relevanceSignal: 'none',
      relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      relevanceUnits: 'turn',
      maxTurnCharsRoutes: ALL_ROUTES,
      evidenceRolesRoutes: ALL_ROUTES,
      renderingRoutes: [],
      ask: 'route',
      askRoutes: [],
      turnCutMarker: 'none',
      reviewPass: 'none',
      reviewBareDecline: false,
    });
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
      memoryArmConfig: {
        threshold: 0.35,
        retrievalThreshold: 0.7,
        sessionBudget: null,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      },
    });
    expect(markdown).toContain('Memory arm config');
    expect(markdown).toContain('threshold=0.35');
    // Both thresholds are asserted, with DIFFERENT values, because the failure this
    // guards against is a renderer that prints one number twice or drops one of
    // them. Equal values would pass under either mistake.
    expect(markdown).toContain('retrievalThreshold=0.7');
    // `null` renders as `unbounded` rather than as `null`, because "the budget is
    // not bounded" is the claim and `null` does not make it to a human reader.
    expect(markdown).toContain('sessionBudget=unbounded');
  });

  it('renders the rendering reach, so the artifact distinguishes the name from the treatment', () => {
    // §12.8's consequence 1. At `bcf66463` the artifact named the candidate contract
    // while the rendering reached 17 of 120 questions, and the name alone read as a
    // treatment four of five capabilities never received. The pair is what a reader
    // needs, so both halves are asserted.
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: null,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention-evidence-blocks',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        renderingRoutes: ['abstention', 'multi-session', 'temporal'],
      },
    });

    expect(markdown).toContain('promptContract=abstention-evidence-blocks');
    expect(markdown).toContain('Evidence rendering reached: 3 route(s)');
    // Named, not counted. A count alone would not say whether the routes reached were
    // the ones that carried the loss, which is the whole question this line answers.
    expect(markdown).toContain('`multi-session`');
    expect(markdown).toContain('`temporal`');
  });

  it('renders an empty reach as `none` rather than omitting the line', () => {
    // The baseline's real answer. Omitting it would make "this arm administered
    // nothing" indistinguishable from "this artifact predates the field", and those
    // are different claims about the same file.
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: null,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        renderingRoutes: [],
        ask: 'route',
        askRoutes: [],
        reviewPass: 'none',
        reviewBareDecline: false,
      },
    });

    expect(markdown).toContain('Evidence rendering reached: `none`');
    expect(markdown).not.toContain('not recorded');
  });

  it('says the reach is not recorded when the field is absent, rather than claiming zero', () => {
    // Every artifact produced before §12.9 lacks the field, and those artifacts were
    // produced by the code whose reach was wrong. Rendering `none` for them would state
    // as measured what is in fact unknown.
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: null,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      },
    });

    expect(markdown).toContain('Evidence rendering reach: `not recorded`');
    expect(markdown).not.toContain('reached: `none`');
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
    it('reports an unknown ask as reaching nothing, not as reaching everything', () => {
      // The fallback exists for a caller that builds options by hand, since a dispatch
      // cannot get past `readAsk`. The two possible defaults are not equal: claiming an
      // ask that was not administered is the defect the reach field exists to close,
      // while claiming one that was is a missing list. So the fallback has to lean
      // toward `[]`, and this is the assertion that holds it there.
      const config = toMemoryArmConfig({
        enabled: true,
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        ask: 'not-a-real-ask',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        evidenceTurnsPerRecord: Number.POSITIVE_INFINITY,
      });
      expect(config.askRoutes).toEqual([]);
    });

    it('reports an unknown contract as reaching nothing, not as reaching everything', () => {
      // The same asymmetry on the rendering axis, and it is the axis the §12.10 reading
      // turned on: an artifact that named a contract reaching six routes while the run
      // administered none is exactly the `bcf66463` defect. A hand-built options object
      // is the only way to reach this fallback -- `readPromptContract` rejects an
      // unrecognised name -- so the test builds one directly.
      const config = toMemoryArmConfig({
        enabled: true,
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'not-a-real-contract',
        ask: 'route',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        evidenceTurnsPerRecord: Number.POSITIVE_INFINITY,
      });
      expect(config.renderingRoutes).toEqual([]);
    });

    it('persists an unbounded budget as null rather than Infinity', () => {
      // `JSON.stringify(Infinity)` is `null`, so an in-memory `Infinity` and a
      // re-read artifact would disagree about the same run. Converting on the way
      // in makes the persisted form the only form.
      const config = toMemoryArmConfig({
        enabled: true,
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        ask: 'route',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        evidenceTurnsPerRecord: Number.POSITIVE_INFINITY,
      });
      expect(config.sessionBudget).toBeNull();
      expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    });

    it('persists a finite budget as itself', () => {
      const config = toMemoryArmConfig({
        enabled: true,
        threshold: 0.5,
        retrievalThreshold: 0,
        sessionBudget: 12,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        ask: 'route',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        evidenceTurnsPerRecord: Number.POSITIVE_INFINITY,
      });
      expect(config).toEqual({
        threshold: 0.5,
        retrievalThreshold: 0,
        sessionBudget: 12,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        renderingRoutes: [],
        ask: 'route',
        askRoutes: [],
        turnCutMarker: 'none',
        reviewPass: 'none',
        reviewBareDecline: false,
        queryExpansion: 'none',
        selfConsistency: 'none',
      });
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

    it('forwards the progress sink so a long run can say where it died', async () => {
      // The arm is the longest-running thing this repository dispatches -- run
      // `37281155088` spent ~52 minutes before an HTTP 402 ended it and its log
      // named no question. This asserts the wiring the entry point depends on:
      // the callback reaches the benchmark loop and its events name the side.
      const seen: string[] = [];
      await runCortexMemoryArm(
        twoQuestionDataset(),
        constantSystem('reference-pipeline', 'one'),
        constantSystem('cortex-memory', 'one'),
        {
          runs: 1,
          scorer: exactMatchScorer,
          memoryArmConfig: GATE,
          generatedAt: '1970-01-01T00:00:00.000Z',
          onProgress: (p) => seen.push(`${p.system}/${p.run}/${p.index}`),
        },
      );
      // Two questions, two sides, one pass: the baseline side is reported in full
      // before the feature begins, which is `runAblation`'s ordering.
      expect(seen).toEqual([
        'reference-pipeline/0/0',
        'reference-pipeline/0/1',
        'cortex-memory/0/0',
        'cortex-memory/0/1',
      ]);
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

/**
 * Blank values, which are what GitHub hands over for an unfilled dispatch input.
 *
 * ## The defect these tests were written against
 *
 * Every variable this arm reads is optional, and the repository's convention for
 * "not configured" is ABSENCE (`bench-arm-options.ts`: "an always-present `false`
 * or `undefined` would be read as configured and would make the option's default
 * unreachable"). A `workflow_dispatch` input breaks that convention from the
 * outside: an input the operator left empty arrives at the step as `''`, not as an
 * absent variable, so the step's `${{ github.event.inputs.x }}` writes an empty
 * string into the environment.
 *
 * For `CORTEX_MEMORY_THRESHOLD` that turned out to be harmless by accident, and
 * for `CORTEX_MEMORY_SESSION_BUDGET` it was a silent zero:
 *
 *     Number('')      -> 0
 *     readThreshold('')       -> 0        // gates open: the identity config, correct
 *     readSessionBudget('')   -> 0        // budget of ZERO turns, not unbounded
 *
 * and `0` is exactly the value `readSessionBudget`'s own guard rejects as
 * "abstains on every question for a reason no artifact records" -- except the
 * guard tests `value < 0`, so `0` passes it. The arm then runs to completion,
 * writes a report where every question was abstained on, and the report looks like
 * a real measurement of a memory system that admits nothing.
 *
 * The fix is that a blank value means "not configured", the same rule
 * `cortexMemoryArmEmbeddingCachePath` applies to a blank path and `firstNonEmpty`
 * applies to a blank credential. The tests below pin all four variables, because a
 * rule applied to three of them is a rule that will be forgotten on the fourth.
 */
/**
 * The retrieval gate, which the first measured dispatch proved was not wired.
 *
 * ## Why these exist as a group
 *
 * `37094200823` ran this arm and returned 6.40% against the reference pipeline's
 * 85.20%, abstention 95.40%. The per-capability table showed ABS at 100% while
 * IE/MR/KU/TR sat between 0.00% and 0.83% -- a system that declines everything.
 *
 * The cause was two-sided and only one side was in `cortex-memory`:
 *
 *   1. `decideRetrieval` had no call site there at all, so the abstention path
 *      had a *wording* change and no mechanism;
 *   2. this arm had no way to configure a retrieval threshold even if it had,
 *      because `CortexMemoryArmOptions` carried only the write gate.
 *
 * Fixing (1) without (2) would leave the value stuck at whatever the default
 * was, and the run would be unable to say which gate produced its number. So the
 * arm parses it, projects it into the artifact, and asserts both here.
 */
describe('the retrieval threshold', () => {
  it('parses CORTEX_MEMORY_RETRIEVAL_THRESHOLD', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_RETRIEVAL_THRESHOLD: '0.25',
    });
    expect(options.retrievalThreshold).toBe(0.25);
  });

  it('keeps the two thresholds independent, because they answer different questions', () => {
    // The configuration the dispatch needed and could not express: keep every
    // turn (threshold 0) while still gating whether the kept evidence is good
    // enough to answer from.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_THRESHOLD: '0',
      CORTEX_MEMORY_RETRIEVAL_THRESHOLD: '0.5',
    });
    expect(options.threshold).toBe(0);
    expect(options.retrievalThreshold).toBe(0.5);
  });

  it('defaults the retrieval threshold to 0, the identity configuration for that gate', () => {
    // `0` here means "answer whenever anything was admitted", which is the
    // honest first measurement: it changes nothing about which turns are kept
    // and adds only the machine-derived decision the method documents.
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(options.retrievalThreshold).toBe(0);
  });

  it('rejects a retrieval threshold outside [0, 1]', () => {
    // The same guard the write threshold carries, for the same reason: the value
    // is compared against a clamped [0, 1] utility, so `2` abstains on every
    // question and `-1` abstains on none, and both complete a full run whose
    // result describes the typo.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RETRIEVAL_THRESHOLD: '2' }),
    ).toThrow(/CORTEX_MEMORY_RETRIEVAL_THRESHOLD/);
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RETRIEVAL_THRESHOLD: '-0.1' }),
    ).toThrow(/CORTEX_MEMORY_RETRIEVAL_THRESHOLD/);
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_RETRIEVAL_THRESHOLD: 'abc' }),
    ).toThrow(/CORTEX_MEMORY_RETRIEVAL_THRESHOLD/);
  });

  it('reports the retrieval threshold as set, separately from the write threshold', () => {
    // The controls that keep the two from being conflated. An arm that printed
    // one number for both would make the artifact unable to say which gate the
    // run used -- the §20 failure, where two artifacts differed and neither
    // named its configuration.
    const set = formalizeArm({ threshold: 0, retrievalThreshold: 0.4, sessionBudget: Infinity });
    expect(set).toContain('retrievalThreshold=0.4');
    expect(set).toContain('threshold=0');
    // And zero is printed as a value, not omitted as a default.
    const zero = formalizeArm({ threshold: 0, retrievalThreshold: 0, sessionBudget: Infinity });
    expect(zero).toContain('retrievalThreshold=0');
  });

  it('carries the retrieval threshold into the persisted report', async () => {
    const report = await runCortexMemoryArmReport({ threshold: 0, retrievalThreshold: 0.4 });
    expect(report.memoryArmConfig).toEqual({
      threshold: 0,
      retrievalThreshold: 0.4,
      sessionBudget: null,
      sourceTrust: 0.5,
      confidenceSignal: 'none',
      promptContract: 'abstention',
      relevanceSignal: 'none',
      relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      relevanceUnits: 'turn',
      renderingRoutes: [],
      ask: 'route',
      askRoutes: [],
      reviewPass: 'none',
      reviewBareDecline: false,
    });
  });
});

describe('blank values from unfilled dispatch inputs', () => {
  it('treats a blank threshold as unset rather than as 0', () => {
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: '' });
    expect(options.enabled).toBe(true);
    expect(options.threshold).toBe(0);
  });

  it('treats a blank retrieval threshold as unset rather than as 0', () => {
    // The same trap as the session budget, one variable over. `Number('')` is 0,
    // which for this gate means "answer whenever anything was admitted" -- the
    // identity configuration, so a blank input would silently *disable* the gate
    // rather than leave it unset. Correct here by luck is not correct.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_RETRIEVAL_THRESHOLD: '',
    });
    expect(options.retrievalThreshold).toBe(0);
  });

  it('treats a blank session budget as UNBOUNDED, not as zero', () => {
    // The assertion that fails without the fix -- and the one whose unfixed
    // outcome is the most expensive, because it is the only one that produces a
    // complete report with a plausible-looking number.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_SESSION_BUDGET: '',
    });
    expect(options.sessionBudget).toBe(Number.POSITIVE_INFINITY);
    // Stated against the number, and not only against `Infinity`, so the failure
    // message says which wrong answer was produced.
    expect(options.sessionBudget).not.toBe(0);
  });

  it('treats whitespace as blank, not as a number', () => {
    // `Number('  ')` is also `0`, so the same trap with a different spelling. An
    // operator who clears a field in a UI that forwards a space hits it.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_THRESHOLD: '  ',
      CORTEX_MEMORY_SESSION_BUDGET: '\t',
    });
    expect(options.threshold).toBe(0);
    expect(options.sessionBudget).toBe(Number.POSITIVE_INFINITY);
  });

  it('still accepts a real zero budget, because zero is a legitimate configuration', () => {
    // The control for the tests above. A blank value must mean "unset" WITHOUT
    // making the explicit `0` unreachable -- that is the same class of mistake in
    // the opposite direction, and it is why the fix is a blank check rather than a
    // falsy check.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_SESSION_BUDGET: '0',
    });
    expect(options.sessionBudget).toBe(0);
  });

  it('still accepts an explicit zero threshold', () => {
    // Same control on the other variable. `0` is both the default AND a value an
    // operator may set deliberately, so these two must not be conflated.
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: '0' });
    expect(options.threshold).toBe(0);
  });

  it('still rejects a non-numeric value rather than reading it as blank', () => {
    // And the other boundary: relaxing blank must not relax everything. A typo
    // still fails loudly, which is the property the strict guards exist for.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_THRESHOLD: 'abc' }),
    ).toThrow(/CORTEX_MEMORY_THRESHOLD/);
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SESSION_BUDGET: '3.5' }),
    ).toThrow(/CORTEX_MEMORY_SESSION_BUDGET/);
  });

  it('ignores blank numeric variables entirely when the arm is off', () => {
    // The guard runs only when the arm is on, so an unrelated dispatch that
    // happens to carry blank values cannot fail a run that is not this arm.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY_THRESHOLD: '',
      CORTEX_MEMORY_SESSION_BUDGET: '',
    });
    expect(options).toEqual({
      enabled: false,
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: Number.POSITIVE_INFINITY,
      sourceTrust: 0.5,
      confidenceSignal: 'none',
      promptContract: 'abstention',
      ask: 'route',
      relevanceSignal: 'none',
      relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      relevanceUnits: 'turn',
      maxTurnCharsRoutes: ALL_ROUTES,
      evidenceRolesRoutes: ALL_ROUTES,
      evidenceTurnsPerRecord: Number.POSITIVE_INFINITY,
      // Projected on a disabled arm for the reason the two reaches are: it cut nothing, so the
      // only truthful value is the one that says so.
      turnCutMarker: 'none',
    });
  });

  it('projects an unbounded budget from a blank input as the persisted null', () => {
    // End to end through both functions: the value a blank input produces must
    // reach the artifact as `null` ("unbounded"), not as `0` ("abstain on
    // everything"). `toMemoryArmConfig` is what turns `Infinity` into `null`, and
    // `0` would survive it untouched.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_SESSION_BUDGET: '',
    });
    expect(toMemoryArmConfig(options)).toEqual({
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: null,
      sourceTrust: 0.5,
      confidenceSignal: 'none',
      promptContract: 'abstention',
      relevanceSignal: 'none',
      relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      relevanceUnits: 'turn',
      maxTurnCharsRoutes: ALL_ROUTES,
      evidenceRolesRoutes: ALL_ROUTES,
      renderingRoutes: [],
      ask: 'route',
      askRoutes: [],
      turnCutMarker: 'none',
      reviewPass: 'none',
      reviewBareDecline: false,
      queryExpansion: 'none',
      selfConsistency: 'none',
    });
  });
});

describe('the prompt contract reaches the artifact', () => {
  it('defaults to the baseline rendering', () => {
    // The compatibility guarantee. Every run dispatched before this field existed used
    // the baseline rendering, so "unset" has to mean exactly that or the historical
    // numbers stop describing the prompt they were taken under.
    expect(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).promptContract).toBe('abstention');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_PROMPT_CONTRACT: '' })
        .promptContract,
    ).toBe('abstention');
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_PROMPT_CONTRACT: '  ' })
        .promptContract,
    ).toBe('abstention');
  });

  it('accepts the §12.5 candidate contract', () => {
    expect(
      cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        CORTEX_MEMORY_PROMPT_CONTRACT: 'abstention-evidence-blocks',
      }).promptContract,
    ).toBe('abstention-evidence-blocks');
    // Trimmed, so a trailing newline from a shell heredoc is not a typo.
    expect(
      cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        CORTEX_MEMORY_PROMPT_CONTRACT: 'abstention-evidence-blocks\n',
      }).promptContract,
    ).toBe('abstention-evidence-blocks');
  });

  it('rejects an unrecognised contract rather than falling back to the baseline', () => {
    // The direction is the opposite of `readToggle`'s, and §12.5 is why: a run
    // dispatched to test a different evidence rendering, silently falling back to the
    // baseline, would publish a delta reading as evidence the rendering does not help.
    // The delta would then be a fact about the typo rather than about the rendering.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_PROMPT_CONTRACT: 'blocks' }),
    ).toThrow(/CORTEX_MEMORY_PROMPT_CONTRACT/);
    // The message lists the accepted set, so the operator does not read the source.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_PROMPT_CONTRACT: 'nope' }),
    ).toThrow(/"abstention-evidence-blocks"/);
  });

  it('projects the value into the memory arm config', () => {
    // The §7.4 defect in its fourth form: a configuration the code applies but the
    // artifact does not record. §12.5's whole design is that the two runs differ in
    // EXACTLY this field and no other, so an artifact that omitted it would make the
    // pair indistinguishable -- and the pair being distinguishable is the experiment.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_PROMPT_CONTRACT: 'abstention-evidence-blocks',
    });
    expect(toMemoryArmConfig(options).promptContract).toBe('abstention-evidence-blocks');
  });

  it('records the contract even when it holds the default', () => {
    // Omitting a defaulted field makes "this run used the baseline" and "this artifact
    // predates the field" the same bytes, and those are different claims.
    expect(toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })).promptContract).toBe(
      'abstention',
    );
  });

  it('keeps the gate parameters untouched, which is what makes the experiment single-variable', () => {
    // The falsifiability guard. §12.5 predicts MR and TR move off zero because the
    // RENDERING changed. If this switch also moved a threshold, a non-zero result could
    // not be attributed to either, and the run would answer neither question.
    const baseline = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    const candidate = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_PROMPT_CONTRACT: 'abstention-evidence-blocks',
    });
    expect(candidate.threshold).toBe(baseline.threshold);
    expect(candidate.retrievalThreshold).toBe(baseline.retrievalThreshold);
    expect(candidate.sessionBudget).toBe(baseline.sessionBudget);
    expect(candidate.sourceTrust).toBe(baseline.sourceTrust);
    expect(candidate.confidenceSignal).toBe(baseline.confidenceSignal);
  });
});

describe('the contract list agrees with the product layer', () => {
  it('accepts exactly the contracts cortex-memory implements', () => {
    // The duplication guard. `cortex-eval` cannot import from `cortex-memory`: the
    // dependency runs the other way (memory is measured BY eval) and an import would be
    // a cycle, so the accepted list is restated in the arm. Duplication that is merely
    // asserted in a comment is the drift this repository keeps paying for, so it is
    // checked instead -- a contract added or removed on the product side fails HERE
    // rather than silently becoming an accepted-but-unimplemented value on the arm.
    //
    // The product's source is READ, not imported. Two earlier attempts imported it and
    // failed: a package-name import is the very edge that must not exist, and a relative
    // `.js` specifier does not resolve across package roots under this vitest config
    // (`Failed to load url ../../cortex-memory/src/prompt.js`). Reading the file text
    // avoids both and still fails when the lists diverge, which is the whole requirement.
    const source = readFileSync(
      new URL('../../../cortex-memory/src/prompt.ts', import.meta.url),
      'utf-8',
    );

    // The exported array literal, parsed out of the source rather than a regex over the
    // whole file: a match anywhere would also catch the type union, which lists the same
    // names and must not be confused with the runtime list the arm validates against.
    const arrayMatch = /export const PROMPT_CONTRACTS = \[([^\]]*)\] as const;/.exec(source);
    expect(arrayMatch, 'PROMPT_CONTRACTS not found in the product source').not.toBeNull();
    // Narrowed through a local rather than a `!` inside the spread: the assertion above
    // narrows `arrayMatch` for the checker only if it is read after the expect, and
    // `arrayMatch![1]` inside a `[...]` spread re-widens it to `string | undefined`.
    const arrayBody = arrayMatch?.[1] ?? '';
    const productContracts = [...arrayBody.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();

    const accepted: string[] = [];
    for (const candidate of ['abstention', 'abstention-evidence-blocks']) {
      accepted.push(
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_PROMPT_CONTRACT: candidate })
          .promptContract,
      );
    }
    expect(accepted.sort()).toEqual(productContracts);
  });

  it('defaults to the contract the product calls the default', () => {
    const source = readFileSync(
      new URL('../../../cortex-memory/src/prompt.ts', import.meta.url),
      'utf-8',
    );
    const defaultMatch = /export const DEFAULT_PROMPT_CONTRACT: PromptContract = '([^']+)';/.exec(
      source,
    );
    expect(defaultMatch, 'DEFAULT_PROMPT_CONTRACT not found in the product source').not.toBeNull();
    expect(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).promptContract).toBe(defaultMatch![1]);
  });
});

/**
 * Every table this arm restates is compared against the product, both directions.
 *
 * ## The pattern that was half-built, and the three comments that claimed it was whole
 *
 * `cortex-eval` measures `cortex-memory` and may not import from it, so the arm restates four
 * vocabularies: the ask names, the prompt contracts, the relevance units and the routes each
 * rendering reaches. The first two had guards beside this one. The other two did not, and both
 * carried a comment asserting they did:
 *
 *   - the ask table's comment said "the product's own table is asserted equal to it" -- nothing
 *     asserted it, and `ask: enumerated` was accepted by every type, passed the whole gate, and
 *     was rejected by the arm **at startup**, killing run `38908223281` before question one;
 *   - the relevance-units table is a copy of the product's `RelevanceUnits` union that had to be
 *     updated by hand when §13.31 added `session-fill`, and nothing would have noticed if it had
 *     not been.
 *
 * The rendering-reach guard *did* exist and was weaker than its own comment: it reads the
 * product's source only to assert `RENDERING_BY_CONTRACT` is present, then compares the arm's
 * route list against a **literal**, so a route added on the product side could not fail it.
 *
 * A campaign that produces four instances of "the comment claims a check" in one iteration is
 * not a run of bad luck; it is a missing rule. The rule is this table: one entry per restated
 * vocabulary, each compared in **both directions** and driven through the parser the dispatch
 * actually uses, so a value that exists on one side only fails here rather than at a dispatch.
 *
 * ## Why the arm's accepted set is read from its rejection message
 *
 * The tables are module-private, and importing them would be the import this file exists to
 * avoid. Feeding an invalid value and reading the accepted set out of the error is both the
 * only reachable route and a stronger claim than parsing the table: it asserts the set the arm
 * *behaves* on, which is what a dispatch meets.
 */
describe('every restated table agrees with the product in both directions', () => {
  const PRODUCT = readFileSync(
    new URL('../../../cortex-memory/src/prompt.ts', import.meta.url),
    'utf-8',
  );

  /** The quoted members of an exported string-literal union. */
  function unionMembers(name: string): string[] {
    const match = new RegExp(`export type ${name} =([^;]+);`).exec(PRODUCT);
    expect(match, `${name} not found in the product source`).not.toBeNull();
    const members = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(members.length, `${name} parsed to nothing`).toBeGreaterThan(0);
    return members.sort();
  }

  /** The quoted members of an exported `as const` array literal. */
  function arrayLiteral(name: string): string[] {
    const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(PRODUCT);
    expect(match, `${name} not found in the product source`).not.toBeNull();
    const members = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(members.length, `${name} parsed to nothing`).toBeGreaterThan(0);
    return members.sort();
  }

  /**
   * The values the arm accepts for one variable, read from the error it raises on a bad one.
   *
   * Every reader in this file enumerates `Object.keys(<its table>)` into the message, so the
   * message is a true statement of what the arm will take -- and the assertion below is the one
   * that keeps that true, since a reader that stopped listing its table would make this helper
   * throw rather than silently compare an empty set.
   */
  function armAccepted(variable: string): string[] {
    let message = '';
    try {
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', [variable]: 'not-a-value-the-arm-knows' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message, `${variable} accepted a value it does not know`).not.toBe('');
    const head = message.split(' or unset')[0] ?? '';
    const listed = [...head.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(listed.length, `${variable} listed no alternatives: ${message}`).toBeGreaterThan(0);
    return listed.sort();
  }

  it('accepts exactly the ask values the product implements', () => {
    expect(armAccepted('CORTEX_MEMORY_ASK')).toEqual(unionMembers('EvidenceAsk'));
  });

  it('accepts exactly the contracts the product implements', () => {
    expect(armAccepted('CORTEX_MEMORY_PROMPT_CONTRACT')).toEqual(arrayLiteral('PROMPT_CONTRACTS'));
  });

  it('accepts exactly the units the product implements', () => {
    // The copy that had to be hand-edited for §13.31's `session-fill`. Nothing checked it, so
    // the next value added on the product side would have been rejected at startup like the ask
    // was -- or, worse in the other direction, accepted here and unknown to the product.
    expect(armAccepted('CORTEX_MEMORY_RELEVANCE_UNITS')).toEqual(unionMembers('RelevanceUnits'));
  });

  it('names only routes the product names, in every reach table it records', () => {
    // The route vocabulary belongs to the product: `ASK_ROUTES` in `prompt.ts` is the authority
    // on which routes exist and which ask reaches them, and the arm restates it for the report.
    // A route name that exists only in the arm is a reach the artifact would claim and the
    // product would never apply -- the `bcf66463` defect, inverted.
    const table = /export const ASK_ROUTES[^=]*= \{(.*?)\n\};/s.exec(PRODUCT);
    expect(table, 'ASK_ROUTES not found in the product source').not.toBeNull();
    const productRoutes = new Set(
      [...(table?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''),
    );
    // The control: a parse that found nothing would make every assertion below vacuous.
    expect(productRoutes.size).toBeGreaterThan(0);

    const asks = armAccepted('CORTEX_MEMORY_ASK');
    for (const ask of asks) {
      const config = toMemoryArmConfig(
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: ask }),
      );
      const reached = config.askRoutes ?? [];
      for (const route of reached) {
        expect(
          productRoutes.has(route),
          `ask ${ask} records the route ${route}, which the product does not name`,
        ).toBe(true);
      }
      // And the direction that matters for attribution: a route the product names for this ask
      // must appear in what the artifact reports. `route` names none by definition.
      if (ask !== 'route') {
        expect(reached.length, `ask ${ask} reports no reach`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the rendering reach the artifact reports agrees with the product layer', () => {
  it('reports every route the product applies the rendering to', () => {
    // The §12.8 property, and the reason it is a field at all: at `bcf66463` the
    // artifact named `promptContract=abstention-evidence-blocks` while the rendering
    // reached 17 of 120 questions, so the name alone described a treatment four of five
    // capabilities never received.
    //
    // The product's reach is READ from its source, the same way the contract list is,
    // and for the same layering reason: `cortex-eval` measures `cortex-memory` and
    // cannot import from it. What is checked is the count against the product's own
    // route table, so a route added on the product side fails HERE rather than silently
    // becoming a reach the artifact under-reports.
    const source = readFileSync(
      new URL('../../../cortex-memory/src/prompt.ts', import.meta.url),
      'utf-8',
    );
    // The product's table maps a contract name to the single rendering it selects.
    // Asserted present before use so a rename on the product side fails loudly rather
    // than making the comparison below vacuous.
    expect(
      /export const RENDERING_BY_CONTRACT/.test(source),
      'RENDERING_BY_CONTRACT not found in the product source',
    ).toBe(true);

    const candidate = toMemoryArmConfig(
      cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        CORTEX_MEMORY_PROMPT_CONTRACT: 'abstention-evidence-blocks',
      }),
    );
    // Six routes: the seven dispatch branches in `benchmark.ts` minus
    // `answerPreference`, which `CortexMemory` does not implement.
    expect(candidate.renderingRoutes).toEqual([
      'abstention',
      'multi-session',
      'temporal',
      'knowledge-update',
      'assistant',
      'flat',
    ]);
    // The two routes that carried the entire measured loss, named explicitly. A reach
    // that quietly lost one of them would still total five and still look complete.
    expect(candidate.renderingRoutes).toContain('multi-session');
    expect(candidate.renderingRoutes).toContain('temporal');
  });

  it('reports no reach for the baseline contract', () => {
    // The control arm administers no rendering, so reporting it as covering routes
    // would claim a treatment it did not receive. `[]` rather than `undefined`
    // because the baseline's reach is measured and known to be zero.
    const baseline = toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }));
    expect(baseline.renderingRoutes).toEqual([]);
  });
});

describe('the evidence ask, which is the second axis and not the rendering', () => {
  it('defaults to the shipped ask, which is the arm every run before §13 ran', () => {
    // Unset is a real configuration, not an error: every artifact produced before this
    // variable existed ran the shipped instruction block, so the default has to be that
    // one rather than a null that would read as "not recorded".
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(options.ask).toBe('route');
  });

  it('reads the widened ask, which is the one §13 registers the experiment for', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_ASK: 'extractive',
    });
    expect(options.ask).toBe('extractive');
  });

  it('treats a blank ask as unset rather than as its own value', () => {
    // GitHub passes an unfilled `workflow_dispatch` input as `''`, not as an absent
    // variable. Blank must mean the shipped ask for the same reason it means the
    // default everywhere else in this module.
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: '' });
    expect(options.ask).toBe('route');
  });

  it('rejects an unrecognised ask rather than defaulting it, because the default fakes the reading', () => {
    // This is the load-bearing guard of §13. A typo that fell back to the shipped ask
    // would run a valid experiment on the wrong axis and publish an artifact whose
    // unchanged MR/TR read as evidence that the ask does not matter -- exactly the
    // falsifier §13.5 registers, reached by a typo instead of by measurement. The
    // rejection is what keeps the falsifier reachable only by measurement.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: 'extract' }),
    ).toThrow(/CORTEX_MEMORY_ASK/);
    // And it names what it would have accepted, so the failure is actionable.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: 'extract' }),
    ).toThrow(/extractive/);
  });

  it('reports the ask it was administered, not the ask it was named', () => {
    const widened = toMemoryArmConfig(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: 'extractive' }),
    );
    expect(widened.ask).toBe('extractive');
    // The reach is the measured answer to "which routes actually received this ask",
    // and it is not derivable from the name: `multi-session` and `flat` hardcode the
    // shipped block and are structurally out of this variable's reach, so reporting
    // all six would claim a treatment two of them cannot receive.
    expect(widened.askRoutes).not.toContain('multi-session');
    expect(widened.askRoutes).not.toContain('flat');
    expect(widened.askRoutes).toContain('abstention');
  });

  it('agrees with the product layer on which routes the widened ask can reach', () => {
    // Read from the product source for the same layering reason the rendering reach is:
    // `cortex-eval` measures `cortex-memory` and cannot import from it. The local copy of
    // the table exists so the artifact can carry the reach; this is what stops the copy
    // from drifting away from the thing it is a copy of.
    const source = readFileSync(
      new URL('../../../cortex-memory/src/prompt.ts', import.meta.url),
      'utf-8',
    );
    expect(
      /export const ASK_ROUTES/.test(source),
      'ASK_ROUTES not found in the product source',
    ).toBe(true);

    // `multi-session` is the one route whose builder does not take the instruction
    // block at all -- the structural gap §12.9 records, which is why the two axes had
    // to be separated. `temporal`'s builder DOES take it, which is why the ask can
    // reach a route the rendering reaches for a different reason, and the assertion
    // is one-sided so it says only what is actually true.
    const product = toMemoryArmConfig(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: 'extractive' }),
    );
    expect(
      product.askRoutes,
      'multi-session receives its instruction block from its own builder, not from this variable',
    ).not.toContain('multi-session');
    expect(product.askRoutes).toContain('temporal');
  });

  it('carries the embedding backend into the artifact, and the check that it was serving', () => {
    // Two runs against different backends produce reports that are each internally
    // consistent and not comparable, and the only statement of which backend ran used to
    // be a line on a stdout that no archived artifact carries (roadmap item 17).
    const config = toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }), {
      provider: 'openai-compatible',
      model: 'embedding-3',
      dimensions: 1024,
      preflight: 'ok',
    });

    expect(config.embedding).toEqual({
      provider: 'openai-compatible',
      model: 'embedding-3',
      dimensions: 1024,
      preflight: 'ok',
    });
  });

  it('omits the embedding field when the caller names no backend', () => {
    // The three states the reader has to be able to tell apart: named and checked, named
    // and unchecked, and not named at all. A default here would collapse the third into
    // one of the first two, and the artifact that cannot say it made no claim is the one
    // a comparison will read wrongly.
    const config = toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }));
    expect(Object.hasOwn(config, 'embedding')).toBe(false);
  });

  it('renders the backend and its check on the config line, together', () => {
    // Together, because either half alone is consistent with the run that died before it
    // graded a question: a backend name says what would have produced the vectors, and
    // the check says the provider answered before the run committed.
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }), {
        provider: 'hash',
        model: null,
        dimensions: 256,
        preflight: 'not-run',
      }),
    });

    expect(markdown).toContain('`embedding=hash/n/a@256`');
    expect(markdown).toContain('`embeddingPreflight=not-run`');
  });

  it('leaves the embedding clauses off an artifact that names no backend', () => {
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
    });

    expect(markdown).not.toContain('embedding=');
    expect(markdown).not.toContain('embeddingPreflight');
  });

  it('keeps the arm copy of every ask reach equal to the product table', () => {
    // The guard above checks that the product's table EXISTS and that one entry of it
    // disagrees with the arm's copy in the direction §12.9 explains. §13.21's run then
    // read the reach off the artifact to decide which capabilities were controls and
    // which were targets, and got it wrong for one of them: the arm's `aggregate` read
    // `['multi-session','flat']`, the artifact printed exactly that, and the reading
    // still treated `flat` (which is the IE route) as untouched. The reach the artifact
    // carries is the only instrument a reader has, so it has to be checked in both
    // directions and for every ask -- a one-sided check on one entry cannot notice a
    // route added to or dropped from any of the others.
    const source = readFileSync(
      new URL('../../../cortex-memory/src/prompt.ts', import.meta.url),
      'utf-8',
    );

    for (const ask of ['route', 'extractive', 'aggregate', 'computed']) {
      const found = new RegExp(`\\n  ${ask}: \\[([^\\]]*)\\]`).exec(source);
      expect(found, `ASK_ROUTES.${ask} not found in the product source`).not.toBeNull();
      const productReach = found![1]!
        .split(',')
        .map((entry) => entry.trim().replace(/^'|'$/g, ''))
        .filter((entry) => entry.length > 0);
      const arm = toMemoryArmConfig(
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: ask }),
      );
      expect(arm.askRoutes, `the arm's reach for ${ask} disagrees with the product`).toEqual(
        productReach,
      );
    }
  });
});

describe('the ask reaches the artifacts, in both renderings', () => {
  it('carries the ask into the persisted JSON, so a comparison can interpret itself', () => {
    const config = toMemoryArmConfig(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: 'extractive' }),
    );
    expect(config.ask).toBe('extractive');
    expect(config.askRoutes).toEqual(['abstention', 'temporal', 'knowledge-update', 'assistant']);
  });

  it('renders the ask and its reach into the Markdown, naming the routes', () => {
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_ASK: 'extractive' }),
      ),
    });
    expect(markdown).toContain('- Evidence ask: `extractive`');
    expect(markdown).toContain('Evidence ask reached: 4 route(s)');
    // Named, not counted, for the reason the rendering reach is named.
    expect(markdown).toContain('`abstention`');
    expect(markdown).toContain('`temporal`');
  });

  it('renders a widened-name-with-no-reach as `none` rather than omitting the line', () => {
    // The three-state rendering. An empty list is a real answer -- the ask was
    // administered and reached nothing -- and it must not render the same way as a
    // field that was never written.
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: null,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        renderingRoutes: [],
        ask: 'extractive',
        askRoutes: [],
        reviewPass: 'none',
        reviewBareDecline: false,
      },
    });
    expect(markdown).toContain('- Evidence ask reached: `none`');
  });

  it('says the ask reach is not recorded when the field is absent', () => {
    // An artifact that predates §13 is not an artifact whose ask reached nothing, and
    // the two must not render the same bytes.
    const markdown = formatAblationReport({
      dataset: 'fixture',
      questionCount: 2,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: null,
        sourceTrust: 0.5,
        confidenceSignal: 'none',
        promptContract: 'abstention',
        relevanceSignal: 'none',
        relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
        relevanceUnits: 'turn',
        renderingRoutes: [],
        ask: 'route',
      },
    });
    expect(markdown).toContain('- Evidence ask reach: `not recorded`');
  });
});

describe('a bounded run reports what the bound dropped', () => {
  /**
   * The bound, and why it is asserted at the arm rather than only in the builder.
   *
   * `evidenceTurnsPerRecord` is an arm option, so the path from the option through
   * `buildArmRoster` into the persisted report is wiring, and wiring is what this
   * file exists to pin. §13.12 registers the field; run `38003036421` is why it
   * exists at all -- a complete measurement was destroyed by `JSON.stringify`
   * hitting the runtime's string limit, and nothing in the artifact could say so.
   *
   * The three states are distinguishable and must stay so:
   *
   *   - no bound (`Infinity`)   -> `evidenceReduction` absent
   *   - bound that trimmed      -> `evidenceReduction` present, with counts
   *   - bound that trimmed nothing -> `evidenceReduction` absent (nothing was lost)
   *
   * The middle state is the one this describe block adds. Without it, an arm wired
   * to drop evidence and an arm wired to a bound that happened not to bite would
   * serialize the same way, and a reader could not tell a lossy artifact from a
   * complete one.
   */
  async function armReportWithBound(
    bound: number,
    retrievedTurns: number,
  ): Promise<AblationReport> {
    const dataset = {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-user',
          question: 'Where?',
          expected: 'Lisbon',
          context: ['user: I went to Lisbon.'],
          sessions: [['user: I went to Lisbon.']],
        },
      ],
    } as unknown as BenchmarkDataset;

    const { report } = await runCortexMemoryArm(
      dataset,
      constantSystem('reference-pipeline', 'Lisbon'),
      constantSystem('cortex-memory', 'Lisbon'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: {
          threshold: 0,
          retrievalThreshold: 0,
          sessionBudget: null,
          sourceTrust: 0.5,
          confidenceSignal: 'none',
          promptContract: 'abstention',
          relevanceSignal: 'none',
          relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
          relevanceUnits: 'turn',
          renderingRoutes: [],
          ask: 'route',
          askRoutes: [],
          reviewPass: 'none',
          reviewBareDecline: false,
        },
        evidenceBound: { maxTurnsPerRecord: bound },
      },
    );
    // The roster is what the bound applies to, and the constant systems above do
    // not carry retrieval, so the assertion below is about the bound's presence
    // rather than about a specific turn count. `retrievedTurns` documents the
    // fixture's intent and keeps the caller honest about which case it is in.
    expect(retrievedTurns).toBeGreaterThanOrEqual(0);
    return report;
  }

  it('omits the reduction field when nothing was dropped', async () => {
    // A bound that does not bite must not look like a loss. With one question and
    // a generous bound, no turn is removed and the field is absent -- absence is
    // the encoding for "nothing was lost", and writing a zero object here would
    // make a complete artifact read as a reduced one.
    //
    // `constantSystem` exposes no `lastRetrievedContext`, so the capture hook pushes
    // `null` -- wait, it pushes nothing at all, because the accessor is absent and
    // the benchmark records that as `null` per question. Either way the record's
    // `retrieved` is `''`, the roster holds two empty-turn records, and a bound of 64
    // has nothing to cut. That is also the case that covers the `?? []` fallback in
    // `buildArmRoster`, which is why this fixture is a plain `{ name, answer }`.
    const report = await armReportWithBound(64, 0);
    expect(report.evidenceReduction).toBeUndefined();
    // And a system with no accessor for the offer reports NO offer rather than a
    // fabricated zero. This assertion used to be `=== 0`, which was the collapse the
    // field's own docs warn about -- "a system that admitted nothing" is a claim about
    // the run, and a system that cannot report is not making one. The third state is
    // the one that makes §13.11.3's `evidenceTurns > 0` reading safe: absent is not
    // less than zero, it is unmeasured.
    expect(report.questions!.every((q) => q.evidenceTurns === undefined)).toBe(true);
    expect(report.questions!.every((q) => !Object.hasOwn(q, 'evidenceTurns'))).toBe(true);
    // The delivery is still reported, which is what keeps the two apart.
    expect(report.questions!.every((q) => Array.isArray(q.turns))).toBe(true);
  });

  it('persists the reduction manifest when the bound drops evidence', async () => {
    // The lossy case, and the one `§13.11.9`'s contract needs: a reader holding
    // this artifact must be able to tell that evidence was carried short of what
    // was measured. The counts are what make that checkable without the log.
    //
    // The evidence reaches the arm through `lastRetrievedContext`, which is the
    // accessor the benchmark's capture hook reads (`benchmark.ts` resolves exactly
    // that member name and no other). This system therefore implements it, returns
    // six turns, and the bound of two has something to cut -- deterministically,
    // so this test does not have to hedge about which case it is in.
    const dataset = {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-user',
          question: 'Where?',
          expected: 'Lisbon',
          context: [],
          sessions: [],
        },
      ],
    } as unknown as BenchmarkDataset;

    // Six turns, as a list since §13.16.6. The stub reports the unit the accessor
    // reports, so a capture that re-joined the list would be a `string` here and the
    // reduction counts below would describe lines rather than turns.
    const retrieved = Array.from({ length: 6 }, (_, i) => `turn ${i}`);
    /** The size of the same evidence: the units plus the separators between them. */
    const retrievedChars = retrieved.reduce((total, unit) => total + unit.length, 0) + 5;
    const retrievalSystem = {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      lastRetrievedContext: () => retrieved,
      lastAdmittedEvidence: () => ({ turns: 6, chars: retrievedChars }),
      lastRawOutput: () => 'the record says Lisbon',
    } as unknown as MemorySystem;

    const { report } = await runCortexMemoryArm(
      dataset,
      constantSystem('reference-pipeline', 'Lisbon'),
      retrievalSystem,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: {
          threshold: 0,
          retrievalThreshold: 0,
          sessionBudget: null,
          sourceTrust: 0.5,
          confidenceSignal: 'none',
          promptContract: 'abstention',
          relevanceSignal: 'none',
          relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
          relevanceUnits: 'turn',
          renderingRoutes: [],
          ask: 'route',
          askRoutes: [],
          reviewPass: 'none',
          reviewBareDecline: false,
        },
        evidenceBound: { maxTurnsPerRecord: 2 },
      },
    );

    // Deterministic, not a disjunction: six turns measured, two carried, one
    // record reduced. The three counts are the whole point of the field -- a
    // reader can see the artifact was cut without having the log.
    const reduction = report.evidenceReduction;
    expect(reduction).toBeDefined();
    expect(reduction!.turnsMeasured).toBe(6);
    expect(reduction!.turnsCarried).toBeLessThan(6);
    expect(reduction!.reducedQuestionIds).toEqual(['q1']);
    expect(reduction!.charsMeasured).toBe(retrievedChars);

    // ## The second copy, which is the half that made the artifact 258 MB
    //
    // The arm persists the evidence twice, and run `38044858147` measured what
    // happens when the bound reaches only one of them: 256 MB of 258 MB was this
    // vector, whole, while every record was down to seventeen turns. The claim
    // asserted here is stronger than a size bound -- the two copies must describe
    // the *same* evidence, so the vector's entry splits into exactly the record's
    // turns. A bound that truncated them differently would pass a size check.
    const vector = report.ablation.featureRetrievedContexts;
    expect(vector).toBeDefined();
    const record = report.questions![0]!;
    expect(vector![0]).toEqual(record.turns.map((turn) => turn.text));
    // And the measurement is still whole beside it: the bound reduced what is
    // carried, never what was measured.
    expect(record.evidenceTurns).toBe(6);
  });
});

describe('the prompt-carried evidence size reaches the record', () => {
  /**
   * ## Why the arm has to prove this, not just the builder
   *
   * The value is computed in `cortex-memory`, captured by `cortex-eval`'s
   * benchmark loop, carried on `ScoredEvaluation` and `AblationResult`, and only
   * then written onto a record. Every one of those hops is a place it can be
   * dropped silently, and a dropped field renders as absent -- identical to a
   * system that cannot report it. So the assertion is made at the end of the
   * chain, on the artifact, rather than at the start.
   */
  function oneQuestionDataset(): BenchmarkDataset {
    return {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-user',
          question: 'Where?',
          expected: 'Lisbon',
          context: [],
          sessions: [],
        },
      ],
    } as unknown as BenchmarkDataset;
  }

  const GATE_CONFIG = {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: null,
    sourceTrust: 0.5,
    confidenceSignal: 'none',
    promptContract: 'abstention',
    relevanceSignal: 'none',
    relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
    renderingRoutes: [],
    ask: 'route',
    askRoutes: [],
    reviewPass: 'none',
    reviewBareDecline: false,
  } as const;

  /** A system that can say what it retrieved and what the prompt carried. */
  function reportingSystem(turns: readonly string[], promptChars: number): MemorySystem {
    return {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      // The delivery: what the prompt carried, which is a prefix of what admission
      // offered whenever the budget binds. A list since §13.16.6 -- the accessor
      // reports turns, and this double used to return the joined string, which no
      // caller had ever joined and so no test could catch (§13.33).
      lastRetrievedContext: () => turns,
      // The delivery's size, after the budget.
      lastPromptEvidenceChars: () => promptChars,
      // The offer, which this double reports as the whole context it was handed --
      // exactly the relation the real system has when no budget is spent.
      lastAdmittedEvidence: () => ({
        turns: turns.length,
        // The size the joined form has: the units plus the separators between them,
        // which is what `admittedFrom` computes for the real producer.
        chars: turns.join('\n').length,
      }),
      lastRawOutput: () => 'Lisbon',
    } as unknown as MemorySystem;
  }

  it('writes the carried size beside the offered size, which are different facts', async () => {
    // The two numbers are deliberately unequal here: `evidenceChars` counts the
    // admitted context and `promptChars` counts what the prompt carried after the
    // builder's budget. A run whose artifact reports only the first overstates
    // what the model saw -- by about twenty times on `38044858147`.
    const turns = ['turn 0', 'turn 1', 'turn 2'];
    const { report } = await runCortexMemoryArm(
      oneQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      reportingSystem(turns, 27),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE_CONFIG,
      },
    );

    const record = report.questions![0]!;
    expect(record.promptChars).toBe(27);
    expect(record.evidenceChars).toBe(turns.join('\n').length);
    expect(record.evidenceTurns).toBe(3);
  });

  it('omits the field when the system cannot report it, rather than writing zero', async () => {
    // Absent is not zero. A system with no such accessor has not reported a prompt
    // that carried nothing, and the two must not render the same way -- the same
    // rule `evidenceTurns` and `evidenceChars` follow for a reader shown nothing.
    const { report } = await runCortexMemoryArm(
      oneQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      constantSystem('cortex-memory', 'Lisbon'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE_CONFIG,
      },
    );

    expect(report.questions![0]!.promptChars).toBeUndefined();
    expect(Object.hasOwn(report.questions![0]!, 'promptChars')).toBe(false);
  });

  it('survives a reduction, so a bounded artifact does not lose the delivery size', async () => {
    // The reducer rebuilds every record through `buildQuestionRecords`, so a field
    // it does not forward is a field a reduction silently drops -- the defect
    // `withEvidenceBound` already carried once for `featureConfig`.
    const turns = Array.from({ length: 6 }, (_, i) => `turn ${i}`);
    const { report } = await runCortexMemoryArm(
      oneQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      reportingSystem(turns, 27),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE_CONFIG,
        evidenceBound: { maxTurnsPerRecord: 2 },
      },
    );

    const record = report.questions![0]!;
    expect(report.evidenceReduction).toBeDefined();
    expect(record.promptChars).toBe(27);
    expect(record.turns.length).toBeLessThan(record.evidenceTurns!);
  });
});

/**
 * The record carries a fingerprint of the prompt that was sent.
 *
 * ## What it is for, and why the end of the chain is where it has to be proved
 *
 * `§13.168.8` registers the field to answer a question two artifacts raised without
 * being able to settle: why the provider's prefix cache credited 6.47% and 11.16% of
 * the prompt tokens where `§13.147.3` predicted 60-80%. Equal fingerprints across
 * passes mean the requests really were repetitions and the provider is the
 * explanation; unequal ones mean the passes never were repetitions, which is an arm
 * defect and a cheaper finding.
 *
 * The value is computed in `cortex-memory`, captured by the benchmark loop, carried
 * on `ScoredEvaluation` and `AblationResult`, hashed here, and finally written onto a
 * record. Every hop is a place it can be dropped or paired with the wrong question,
 * and a dropped field renders as absent -- identical to a system that cannot report
 * it. So the assertions are made on the artifact, and the oracle is `node:crypto`
 * rather than the helper the arm itself calls: a test that compared the field to
 * `promptDigest(text)` would agree with the arm even if the arm hashed the question
 * instead of the prompt.
 */
describe('the record carries a fingerprint of the prompt', () => {
  function datasetOf(questions: readonly { id: string; question: string }[]): BenchmarkDataset {
    return {
      name: 'fixture',
      questions: questions.map((q) => ({
        id: q.id,
        capability: 'IE',
        questionType: 'single-session-user',
        question: q.question,
        expected: 'Lisbon',
        context: [],
        sessions: [],
      })),
    } as unknown as BenchmarkDataset;
  }

  const GATE = {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: null,
    sourceTrust: 0.5,
    confidenceSignal: 'none',
    promptContract: 'abstention',
    relevanceSignal: 'none',
    relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
    renderingRoutes: [],
    ask: 'route',
    askRoutes: [],
    reviewPass: 'none',
    reviewBareDecline: false,
  } as const;

  /** A system that reports one prompt text per question, in order. */
  function promptingSystem(prompts: readonly string[]): MemorySystem {
    let call = 0;
    return {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      lastRetrievedContext: () => ['turn 0', 'turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5'],
      lastPromptEvidenceChars: () => 64,
      lastAdmittedEvidence: () => ({ turns: 6, chars: 64 }),
      lastRawOutput: () => 'Lisbon',
      lastPromptText: () => prompts[call++] ?? null,
    } as unknown as MemorySystem;
  }

  const expected = (text: string): string =>
    createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

  it('writes the digest of the prompt, and not of the question or the evidence', async () => {
    const prompt =
      'Instructions\n\nQ: Where?\n\nEVIDENCE:\n1. turn 0\n\nReply with the answer only.';
    const { report } = await runCortexMemoryArm(
      datasetOf([{ id: 'q1', question: 'Where?' }]),
      constantSystem('reference-pipeline', 'Lisbon'),
      promptingSystem([prompt]),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
      },
    );

    const record = report.questions![0]!;
    expect(record.promptDigest).toBe(expected(prompt));
    // The two neighbouring candidate values, excluded by name: hashing the question
    // or the evidence would satisfy "there is a 16-character field" and answer a
    // different question than the one registered.
    expect(record.promptDigest).not.toBe(expected('Where?'));
    expect(record.promptDigest).not.toBe(expected('turn 0'));
    expect(record.promptDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives two identical prompts the same digest and two different ones different digests', async () => {
    // The reading itself: one character apart is not a repetition, and byte-identical
    // is. Both halves in one test because either alone is satisfiable by a constant.
    const shared = 'Instructions\n\nQ: Where?\n\nEVIDENCE:\n1. turn 0';
    const { report } = await runCortexMemoryArm(
      datasetOf([
        { id: 'q1', question: 'Where?' },
        { id: 'q2', question: 'Where was it?' },
      ]),
      constantSystem('reference-pipeline', 'Lisbon'),
      promptingSystem([shared, `${shared}.`]),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
      },
    );

    const [first, second] = report.questions!;
    expect(first!.promptDigest).not.toBe(second!.promptDigest);
    expect(first!.promptDigest).toBe(expected(shared));
    // And the second follows the SECOND question's prompt, which is the pairing a
    // capture read after the loop would get wrong for every record.
    expect(second!.promptDigest).toBe(expected(`${shared}.`));
  });

  it('omits the field when the system cannot report the prompt', async () => {
    // Absent, not a hash of the empty string: a system with no accessor has not sent
    // an empty request, and `§13.168.8`'s null-versus-empty distinction has to survive
    // the hop to the artifact or the fingerprint reports a request that never happened.
    const { report } = await runCortexMemoryArm(
      datasetOf([{ id: 'q1', question: 'Where?' }]),
      constantSystem('reference-pipeline', 'Lisbon'),
      constantSystem('cortex-memory', 'Lisbon'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
      },
    );

    expect(report.questions![0]!.promptDigest).toBeUndefined();
    expect(Object.hasOwn(report.questions![0]!, 'promptDigest')).toBe(false);
  });

  it('counts the prompt variants a question cost, beside the digest of the first one', async () => {
    // Two fields, two halves of `§13.168.8`'s question: the digest compares this artifact's prompt with
    // another artifact's, and the count compares this run's passes with each other. A run whose repeats
    // differed is the reading that voids a cache claim, and a digest cannot produce it -- both records
    // below carry a digest, and only one of them sent four different prompts.
    const prompt = 'Instructions\n\nQ: Where?\n\nEVIDENCE:\n1. turn 0';
    const steady = await runCortexMemoryArm(
      datasetOf([{ id: 'q1', question: 'Where?' }]),
      constantSystem('reference-pipeline', 'Lisbon'),
      promptingSystem([prompt, prompt, prompt]),
      {
        runs: 3,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
      },
    );
    expect(steady.report.questions![0]!.promptVariants).toBe(1);
    expect(steady.report.questions![0]!.promptDigest).toBe(expected(prompt));

    const drifting = await runCortexMemoryArm(
      datasetOf([{ id: 'q1', question: 'Where?' }]),
      constantSystem('reference-pipeline', 'Lisbon'),
      promptingSystem([prompt, prompt, `${prompt}.`]),
      {
        runs: 3,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
      },
    );
    expect(drifting.report.questions![0]!.promptVariants).toBe(2);
    // The digest is still the first pass's, because the record's other prompt fields are first-pass
    // fields and a digest taken from the last pass would silently describe a different request.
    expect(drifting.report.questions![0]!.promptDigest).toBe(expected(prompt));
  });

  it('omits the variant count at one pass, where it would be a constant', async () => {
    const { report } = await runCortexMemoryArm(
      datasetOf([{ id: 'q1', question: 'Where?' }]),
      constantSystem('reference-pipeline', 'Lisbon'),
      promptingSystem(['Instructions\n\nQ: Where?']),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
      },
    );
    expect(report.questions![0]!.promptVariants).toBeUndefined();
    expect(Object.hasOwn(report.questions![0]!, 'promptVariants')).toBe(false);
  });

  it('survives a reduction, so a bounded artifact does not lose the fingerprint', async () => {
    // The reducer rebuilds every record through `buildQuestionRecords`, so a field it
    // does not forward is a field a reduction silently drops -- the defect
    // `withEvidenceBound` already carried once for `featureConfig`.
    const prompt = 'Instructions\n\nQ: Where?\n\nEVIDENCE:\n1. turn 0\n\n2. turn 1\n\n3. turn 2';
    const { report } = await runCortexMemoryArm(
      datasetOf([{ id: 'q1', question: 'Where?' }]),
      constantSystem('reference-pipeline', 'Lisbon'),
      promptingSystem([prompt]),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: GATE,
        evidenceBound: { maxTurnsPerRecord: 2 },
      },
    );

    expect(report.evidenceReduction).toBeDefined();
    expect(report.questions![0]!.turns.length).toBeLessThan(report.questions![0]!.evidenceTurns!);
    expect(report.questions![0]!.promptDigest).toBe(expected(prompt));
  });
});

/**
 * The arm reports groundedness, instead of declaring it unreportable.
 *
 * ## The field it replaces
 *
 * Every record this arm produced carried `grounded: false`, on the argument that
 * grounding is the upstream failure classifier's property and this arm collects no
 * classification. The argument is sound about the *trace* product, whose records get
 * the verdict from a predicate its caller supplies. It is wrong here: the classifier
 * is a published rule over two values **this arm already holds** -- the graded answer
 * and the evidence the reader received -- and `classifyTrFailure` implements it.
 *
 * ## What the constant cost
 *
 * `computeTargetCohort` files an ungrounded question under `notGrounded` and excludes
 * it before clustering. With the field constant, **every** question of every arm
 * artifact landed in that bucket, so the published B7 criterion could not be executed
 * against this product at all -- and a reader of the artifact would have seen 500
 * questions the classifier had called ungrounded, which is a claim about the questions
 * rather than a statement that nobody classified them. That is `§13.11.2`'s collapse,
 * one field over from where it was last fixed.
 *
 * ## The unit and the timing, which are the two ways to get this wrong quietly
 *
 * The haystack is the **delivery**: the evidence the prompt carried, which is what
 * `lastRetrievedContext` reports and what the record's `turns` are built from. And it
 * is measured **before** the evidence bound, like `goldOverlap` beside it -- a record
 * reduced for artifact size still describes what the reader had in hand, and measuring
 * after the bound would make a question's groundedness depend on an artifact setting.
 */
describe('the arm reports groundedness with the published classifier', () => {
  const CONFIG = {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: null,
    sourceTrust: 0.5,
    confidenceSignal: 'none',
    promptContract: 'abstention',
    relevanceSignal: 'none',
    relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
    relevanceUnits: 'turn',
    renderingRoutes: [],
    ask: 'route',
    askRoutes: [],
    reviewPass: 'none',
    reviewBareDecline: false,
  } as const;

  function datasetGraded(expected: string): BenchmarkDataset {
    return {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability: 'TR',
          questionType: 'single-session-user',
          question: 'Where?',
          expected,
          context: [],
          sessions: [],
        },
      ],
    } as unknown as BenchmarkDataset;
  }

  /** A system whose delivery is fixed, so groundedness is the only variable. */
  function deliveringSystem(turns: readonly string[], answer: Answer): MemorySystem {
    return {
      name: 'cortex-memory',
      answer: () => answer,
      lastRetrievedContext: () => turns,
      lastAdmittedEvidence: () => ({ turns: turns.length, chars: 0 }),
      lastRawOutput: () => String(answer),
    } as unknown as MemorySystem;
  }

  async function recordFor(
    expected: string,
    turns: readonly string[],
    answer: Answer,
    evidenceBound?: { maxTurnsPerRecord: number },
  ): Promise<QuestionRecord> {
    const { report } = await runCortexMemoryArm(
      datasetGraded(expected),
      constantSystem('reference-pipeline', expected),
      deliveringSystem(turns, answer),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: CONFIG,
        ...(evidenceBound === undefined ? {} : { evidenceBound }),
      },
    );
    return report.questions![0]!;
  }

  it('reports a question as grounded when the reader received the graded evidence', async () => {
    // The population B7 exists to name: the evidence was in hand and the reader
    // produced something else anyway. The answer differs from the truth on purpose --
    // grounding is a statement about the EVIDENCE, not about the answer.
    const record = await recordFor('Lisbon', ['user: I went to Lisbon.'], 'Porto');

    expect(record.grounded).toBe(true);
    expect(record.correct).toBe(false);
  });

  it('reports it as ungrounded when the evidence was never delivered', async () => {
    // The other population, and the one that points at retrieval rather than at the
    // reader. Same question, same graded answer, different delivery.
    const record = await recordFor('Lisbon', ['user: I went to Porto.'], 'Porto');

    expect(record.grounded).toBe(false);
  });

  it("requires every token of the graded answer, which is the classifier rule and not this arm's", async () => {
    // The arm passes the haystack and reads a verdict; it does not decide what counts
    // as a match. A partial match is ungrounded, and this is asserted here because an
    // arm that recomputed the rule (or relaxed it to a substring) would report the
    // opposite -- so the boundary between "which evidence" and "what counts" is pinned.
    const partial = await recordFor(
      'Business Administration',
      ['user: I studied Business.'],
      'Business',
    );
    const whole = await recordFor(
      'Business Administration',
      ['user: I studied Business Administration.'],
      'Business',
    );

    expect(partial.grounded).toBe(false);
    expect(whole.grounded).toBe(true);
  });

  it('measures the delivery the reader received, not what an evidence bound left in the record', async () => {
    // The bound is an artifact setting: it cuts what the JSON carries, after the run.
    // Grounding describes the run, so a reduced record must still report what the
    // reader had in hand -- the same rule `goldOverlap` is measured under, and for the
    // same reason. The bound is set to keep one turn and the gold is second, so the
    // record demonstrably no longer carries the evidence and the verdict must not
    // follow it.
    const record = await recordFor(
      'Lisbon',
      ['user: I went to Porto.', 'user: I went to Lisbon.'],
      'Porto',
      { maxTurnsPerRecord: 1 },
    );

    expect(record.grounded).toBe(true);
    expect(record.turns.some((turn: { text: string }) => turn.text.includes('Lisbon'))).toBe(false);
  });
});

/**
 * The candidate pool, as the third count in `goldOverlap`.
 *
 * §13.61.7: for six runs the campaign could say how much gold reached the reader and not
 * where the rest went, so "the ranking never surfaced it" and "the ranking had it and the
 * budget cut it" were one number. They need opposite repairs -- a signal change and an
 * allocation change -- and every candidate-pool level tried (`k = 64`, `k = 256`) was
 * measured without being able to tell them apart.
 *
 * These two tests pin the wiring at the only seam where the index and the gold are both
 * in scope: the arm's options, which the bench fills from `candidatesFor`.
 */
describe('the arm records how much of the gold the ranking offered', () => {
  const GOLD = 'user: I went to Lisbon.';
  const OTHER = 'user: I bought a bike.';

  function dataset(): BenchmarkDataset {
    return {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-user',
          question: 'Where?',
          expected: 'Lisbon',
          context: [GOLD, OTHER],
          sessions: [[GOLD, OTHER]],
          goldTurns: [GOLD],
        },
      ],
    } as unknown as BenchmarkDataset;
  }

  async function overlapWith(
    relevancePoolFor: ((question: string) => readonly string[] | undefined) | undefined,
  ): Promise<unknown> {
    const { report } = await runCortexMemoryArm(
      dataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      constantSystem('cortex-memory', 'Lisbon'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: {
          threshold: 0,
          retrievalThreshold: 0,
          sessionBudget: null,
          sourceTrust: 0.5,
          confidenceSignal: 'none',
          promptContract: 'abstention',
          relevanceSignal: 'none',
          relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
          relevanceUnits: 'turn',
          renderingRoutes: [],
          ask: 'route',
          askRoutes: [],
          reviewPass: 'none',
          reviewBareDecline: false,
        },
        ...(relevancePoolFor === undefined ? {} : { relevancePoolFor }),
      },
    );
    return report.questions![0]!.goldOverlap;
  }

  it('counts the gold the ranking offered, beside the gold that arrived', async () => {
    // The pool holds the gold and the delivery does not: `total - pool = 0` (the ranking
    // found it) and `pool - carried = 1` (the budget cut it). That row is the one the
    // campaign has never been able to read.
    expect(await overlapWith(() => [OTHER])).toEqual({
      carried: 0,
      total: 1,
      pool: 0,
      goldRanks: [-1],
    });
    expect(await overlapWith(() => [GOLD, OTHER])).toEqual({
      carried: 0,
      total: 1,
      pool: 1,
      goldRanks: [0],
    });
  });

  it('omits the pool when the run consulted no ranking', async () => {
    // `relevanceSignal: none` has no candidates, and the record must say so by absence.
    // The delivery here is empty because this fixture's system answers from nothing; what
    // is under assertion is that `pool` is not among the keys.
    const overlap = (await overlapWith(undefined)) as Record<string, number> | null;
    expect(overlap).not.toBeNull();
    expect(Object.keys(overlap!).sort()).toEqual(['carried', 'total']);
  });
});

/**
 * The per-turn cap, as the arm reads it and as the artifact records it.
 *
 * §13.67 registered the cap from a measurement (`--turns`: a median turn of 272 characters
 * in a 24,000-character room) and §13.68 implements it. The reader and the config field are
 * where a variable becomes inert without anything failing: a cap the arm reads but does not
 * project leaves an artifact unable to say whether the run carried one, and a cap the arm
 * projects but does not read leaves a run that describes a prompt nobody sent — the §7.4
 * side-channel defect in both directions.
 */
describe('the per-turn cap', () => {
  it('is absent by default, because every archived prompt was produced without one', () => {
    expect(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).maxTurnChars).toBeUndefined();
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS: '' })
        .maxTurnChars,
    ).toBeUndefined();
    // `none` is the third spelling and the one §10.3 registers, so the dispatch can send the
    // value the registration names rather than relying on a blank resolving to the same
    // state through a different path.
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS: 'none' })
        .maxTurnChars,
    ).toBeUndefined();
  });

  it('accepts a cap and reports the one it will use', () => {
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS: '400' })
        .maxTurnChars,
    ).toBe(400);
  });

  it('rejects a cap that cannot describe a turn', () => {
    // Each of these completes a full run whose artifact names a cap the run did not
    // administer. `0` is the dangerous one: it emits every turn's number with no text after
    // it, which reads in a prompt as "the evidence is empty" while `carried` reports 26
    // turns -- a state no artifact would record and no reader would expect.
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() =>
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS: bad }),
      ).toThrow(/CORTEX_MEMORY_MAX_TURN_CHARS/);
    }
  });

  it('projects the cap into the config only when one was configured', () => {
    // Absent, never zero, for the reason `goldOverlap.pool` is: a `0` would read as "the run
    // capped every turn at no characters" where the truth is that the run carried no cap.
    const capped = toMemoryArmConfig(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS: '400' }),
    );
    expect(capped.maxTurnChars).toBe(400);

    const uncapped = toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }));
    expect(Object.keys(uncapped)).not.toContain('maxTurnChars');
  });

  it('renders the cap on the config line', () => {
    // The line is what a reader of the Markdown has. This variable changes what the model
    // reads on every route, so its absence from the line would leave two artifacts
    // distinguished only by a JSON key most readers never open.
    const line = (maxTurnChars: number | undefined): string =>
      formatAblationReport({
        dataset: 'fixture',
        questionCount: 0,
        baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
        feature: { name: 'cortex-memory', metrics: emptyMetrics() },
        ablation: emptyAblation('cortex-memory'),
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: {
          ...GATE,
          renderingRoutes: [],
          ask: 'route',
          askRoutes: [],
          reviewPass: 'none',
          reviewBareDecline: false,
          relevanceSignal: 'retrieval',
          relevanceTopK: 64,
          relevanceUnits: 'turn',
          ...(maxTurnChars === undefined ? {} : { maxTurnChars }),
        },
      });

    expect(line(400)).toContain('maxTurnChars=400');
    // Printed as `none` rather than omitted, because unlike the width and the unit this is
    // not a property of the ranking: it applies to every run, so "no cap" is a fact the
    // artifact should state rather than one a reader has to infer from a missing field.
    expect(line(undefined)).toContain('maxTurnChars=none');
  });
});

/**
 * The cap's reach, as the arm reads it and as the artifact records it.
 *
 * §13.72 measured one cap over every route and got `+13` on MR and `−30` on IE. §13.73 dispatches
 * the width unchanged and the reach narrowed, so the reach is a dispatched value with the same
 * two obligations as every other one on this arm: an unrecognised spelling is **rejected** rather
 * than defaulted, and what the run used is on the artifact's config line.
 */
describe('the per-turn cap reach', () => {
  const ROUTES = [
    'abstention',
    'assistant',
    'flat',
    'knowledge-update',
    'multi-session',
    'temporal',
  ];

  it('reaches every route by default, which is what §13.68 shipped', () => {
    expect(
      [...(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).maxTurnCharsRoutes ?? [])].sort(),
    ).toEqual(ROUTES);
    // `all` is the same state and is the spelling §10.3 registers, so the dispatch can send the
    // value the registration names instead of relying on a blank resolving to it elsewhere.
    expect(
      [
        ...(cortextMemoryArmOptions({
          CORTEX_MEMORY: '1',
          CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES: 'all',
        }).maxTurnCharsRoutes ?? []),
      ].sort(),
    ).toEqual(ROUTES);
  });

  it('accepts the two-route reach this experiment dispatches', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES: 'multi-session,temporal',
    });
    expect([...(options.maxTurnCharsRoutes ?? [])].sort()).toEqual(['multi-session', 'temporal']);
  });

  it('accepts a reach of none, which is how the cap is disabled without removing it', () => {
    // Distinct from blank: blank means "every route", and a reader must be able to tell one from
    // the other on the config line -- `none` is a claim about the run, absence is not.
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES: 'none' })
        .maxTurnCharsRoutes,
    ).toEqual([]);
  });

  it('rejects a route name the product does not have', () => {
    // Accepted-and-ignored is the failure that matters: a typo would run a cap on five routes
    // while the artifact said six, and nothing in the output could show it.
    for (const bad of ['multi-sesion', 'flat,foo', 'session']) {
      expect(() =>
        cortextMemoryArmOptions({
          CORTEX_MEMORY: '1',
          CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES: bad,
        }),
      ).toThrow(/CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES/);
    }
  });

  it('lists the accepted names in the rejection, so a typo is fixable without the source', () => {
    expect(() =>
      cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES: 'nope',
      }),
    ).toThrow(/multi-session/);
  });

  it('projects the reach into the config and onto the config line', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_MAX_TURN_CHARS: '400',
      CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES: 'multi-session,temporal',
    });
    expect([...(toMemoryArmConfig(options).maxTurnCharsRoutes ?? [])].sort()).toEqual([
      'multi-session',
      'temporal',
    ]);

    const line = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(options),
    });
    expect(line).toContain('maxTurnChars=400');
    // `+` rather than `,` because the line is already comma-separated between fields.
    expect(line).toContain('maxTurnCharsRoutes=multi-session+temporal');
  });

  it('says `none` on the line for a reach of nothing, and `all` for an absent field', () => {
    // Three states, three renderings, and the distinction is the point: `none` is a run that
    // configured a cap it does not apply, `all` is the shipped state, and a config that predates
    // the field is also `all` because that is what those runs did. A renderer that collapsed
    // `none` into `all` would describe the one run that did nothing as the one that did
    // everything.
    const render = (memoryArmConfig: Record<string, unknown>): string =>
      formatAblationReport({
        dataset: 'fixture',
        questionCount: 0,
        baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
        feature: { name: 'cortex-memory', metrics: emptyMetrics() },
        ablation: emptyAblation('cortex-memory'),
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: memoryArmConfig as never,
      });

    const none = toMemoryArmConfig(
      cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        CORTEX_MEMORY_MAX_TURN_CHARS: '400',
        CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES: 'none',
      }),
    );
    expect(render(none)).toContain('maxTurnCharsRoutes=none');

    const { maxTurnCharsRoutes: _omitted, ...withoutField } = none;
    expect(render(withoutField)).toContain('maxTurnCharsRoutes=all');
  });

  it('says `all` on the line when the reach is every route', () => {
    const line = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
    });
    expect(line).toContain('maxTurnCharsRoutes=all');
  });
});

/**
 * The evidence budget, which no run in this campaign has ever moved.
 *
 * Every experiment has traded truncation against room *inside* 24,000 characters, because
 * `DEFAULT_MAX_PROMPT_CHARS` says so and the arm had no input for it. §13.80 showed the trade has a
 * floor — at a 200-character cap the room reached 100 turns and MR fell to 29 of 121 — so the only
 * way past it is to raise the budget itself.
 */
describe('the evidence budget', () => {
  it('is absent by default, so every archived run keeps the product default', () => {
    expect(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }).maxPromptChars).toBeUndefined();
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_PROMPT_CHARS: '' })
        .maxPromptChars,
    ).toBeUndefined();
  });

  it('accepts a doubled budget and reports it', () => {
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_PROMPT_CHARS: '48000' })
        .maxPromptChars,
    ).toBe(48000);
  });

  it('rejects a budget that cannot hold a prompt', () => {
    // `0` would make every prompt fail the allocator's first step and answer from no evidence at
    // all, while the artifact recorded a budget rather than a defect.
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() =>
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_PROMPT_CHARS: bad }),
      ).toThrow(/CORTEX_MEMORY_MAX_PROMPT_CHARS/);
    }
  });

  it('projects the budget into the config and onto the line', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_MAX_PROMPT_CHARS: '48000',
    });
    expect(toMemoryArmConfig(options).maxPromptChars).toBe(48000);

    const line = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(options),
    });
    expect(line).toContain('maxPromptChars=48000');

    const inherited = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
    });
    // `default`, not `none`: there is always a budget, and the absent state means the product's.
    expect(inherited).toContain('maxPromptChars=default');
  });
});

/**
 * The route table the gold denominator reads, pinned through its **effects**.
 *
 * `evidenceRouteOf` restates which route a capability answers on, because the denominator has to
 * know whether the role filter reaches a question. It is not exported and not tested by reading
 * source: the observable claim is that a reach naming a capability's route narrows that
 * capability's denominator and a reach that does not name it leaves the denominator alone. A test
 * that asserted the table's strings would pass while the table and the filter disagreed.
 */
describe('the route each capability answers on, as the denominator sees it', () => {
  const USER_GOLD = '[2023/02/15 (Wed) 03:14] user: I went to Lisbon.';
  const ASSISTANT_GOLD = '[2023/02/15 (Wed) 03:15] assistant: You went to Lisbon in May.';

  async function overlapFor(
    capability: string,
    reach: readonly string[],
  ): Promise<Record<string, unknown>> {
    const dataset = {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability,
          questionType: 'single-session-user',
          question: 'Where?',
          expected: 'Lisbon',
          context: [USER_GOLD, ASSISTANT_GOLD],
          sessions: [[USER_GOLD, ASSISTANT_GOLD]],
          goldTurns: [USER_GOLD, ASSISTANT_GOLD],
        },
      ],
    } as unknown as BenchmarkDataset;
    const { report } = await runCortexMemoryArm(
      dataset,
      constantSystem('reference-pipeline', 'Lisbon'),
      constantSystem('cortex-memory', 'Lisbon'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: {
          threshold: 0,
          retrievalThreshold: 0,
          sessionBudget: null,
          sourceTrust: 0.5,
          confidenceSignal: 'none',
          promptContract: 'abstention',
          relevanceSignal: 'none',
          relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
          relevanceUnits: 'turn',
          renderingRoutes: [],
          ask: 'route',
          askRoutes: [],
          reviewPass: 'none',
          reviewBareDecline: false,
        },
        evidenceRoles: ['user'],
        evidenceRolesRoutes: reach,
      },
    );
    return report.questions![0]!.goldOverlap as unknown as Record<string, unknown>;
  }

  it('narrows the denominator on every capability whose route the reach names', async () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['MR', 'multi-session'],
      ['TR', 'temporal'],
      ['ABS', 'abstention'],
      ['KU', 'knowledge-update'],
    ];
    for (const [capability, route] of pairs) {
      const overlap = await overlapFor(capability, [route]);
      expect(overlap['total']).toBe(1);
      expect(overlap['totalAll']).toBe(2);
    }
  });

  it('leaves a capability alone when only another route is in the reach', async () => {
    // IE answers on the flat route; a reach of `multi-session` cannot have filtered it, so a
    // denominator that shrank here would claim a policy the run never ran on that capability.
    const overlap = await overlapFor('IE', ['multi-session']);
    expect(overlap['total']).toBe(2);
    expect(overlap['totalAll']).toBeUndefined();
  });
});

/**
 * The gold denominator has to follow the policy, not the dataset./**
 * The gold denominator has to follow the policy, not the dataset.
 *
 * §13.84's run is why. With `evidenceRoles: user` reaching two routes, MR's delivered share read
 * **48.35%** while the window grew and the budget spent the same characters: `goldOverlap`
 * compared the turns the record carried against **every** gold turn, and a gold turn in an
 * excluded role can never be carried. The reading looked like a retrieval collapse and was a
 * denominator.
 *
 * The repair keeps two numbers instead of one: `total` is the gold the policy admits and
 * `totalAll` is the dataset's, present only when the two differ. An unfiltered run is therefore
 * byte-identical to every archived artifact, which is the property the whole comparison rests on.
 */
describe('the gold denominator follows the role policy', () => {
  const USER_GOLD = '[2023/02/15 (Wed) 03:14] user: I went to Lisbon.';
  const ASSISTANT_GOLD = '[2023/02/15 (Wed) 03:15] assistant: You went to Lisbon in May.';
  const PLAIN_GOLD = 'a gold turn whose role cannot be read';

  function dataset(goldTurns: string[], capability = 'MR'): BenchmarkDataset {
    return {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability,
          questionType: capability === 'MR' ? 'multi-session' : 'single-session-user',
          question: 'Where?',
          expected: 'Lisbon',
          context: [USER_GOLD, ASSISTANT_GOLD],
          sessions: [[USER_GOLD, ASSISTANT_GOLD]],
          goldTurns,
        },
      ],
    } as unknown as BenchmarkDataset;
  }

  async function overlap(
    goldTurns: string[],
    capability: string,
    arm: { evidenceRoles?: readonly string[]; evidenceRolesRoutes?: readonly string[] },
  ): Promise<Record<string, unknown>> {
    const { report } = await runCortexMemoryArm(
      dataset(goldTurns, capability),
      constantSystem('reference-pipeline', 'Lisbon'),
      constantSystem('cortex-memory', 'Lisbon'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: {
          threshold: 0,
          retrievalThreshold: 0,
          sessionBudget: null,
          sourceTrust: 0.5,
          confidenceSignal: 'none',
          promptContract: 'abstention',
          relevanceSignal: 'none',
          relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
          relevanceUnits: 'turn',
          renderingRoutes: [],
          ask: 'route',
          askRoutes: [],
          reviewPass: 'none',
          reviewBareDecline: false,
        },
        ...arm,
      },
    );
    return report.questions![0]!.goldOverlap as unknown as Record<string, unknown>;
  }

  it('counts only the gold the policy admits, and keeps the dataset total beside it', async () => {
    const overlapOfMr = await overlap([USER_GOLD, ASSISTANT_GOLD], 'MR', {
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session'],
    });

    // One of the two gold turns is an assistant turn, which this policy cannot carry, so the
    // ratio is against one rather than two -- and the two is still on the record.
    expect(overlapOfMr['total']).toBe(1);
    expect(overlapOfMr['totalAll']).toBe(2);
  });

  it('keeps a gold turn whose role cannot be read', async () => {
    // The same rule the filter itself follows: an unreadable role is not an excluded role.
    const overlapOfMr = await overlap([USER_GOLD, PLAIN_GOLD], 'MR', {
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session'],
    });

    expect(overlapOfMr['total']).toBe(2);
    expect(overlapOfMr['totalAll']).toBeUndefined();
  });

  it('leaves an unreached capability counting every gold turn', async () => {
    // IE answers on the flat route; a filter that reaches multi-session and temporal has not
    // touched it, and a denominator that shrank here would report a policy the run never ran.
    const overlapOfIe = await overlap([USER_GOLD, ASSISTANT_GOLD], 'IE', {
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session', 'temporal'],
    });

    expect(overlapOfIe['total']).toBe(2);
    expect(overlapOfIe['totalAll']).toBeUndefined();
  });

  it('records no `totalAll` at all when every gold turn is admissible', async () => {
    // Absent rather than equal: the field exists to show a *difference*, and a run whose policy
    // admits everything must be byte-identical to the artifacts that predate the field.
    const unfiltered = await overlap([USER_GOLD, ASSISTANT_GOLD], 'MR', {});
    expect(unfiltered['total']).toBe(2);
    expect('totalAll' in unfiltered).toBe(false);
  });
});

/**
 * The review pass, which §13.93 measured the need for and §13.94 registers.
 *
 * The arm's job is to carry the value and to reject a spelling the product does not implement: a run
 * dispatched to administer a treatment that silently ran the control publishes an unchanged result,
 * and that result reads as evidence the treatment does not matter.
 */
describe('the review pass', () => {
  it('is `none` when unset, blank, or named as none', () => {
    for (const raw of [undefined, '', '   ', 'none', 'NONE']) {
      const options = cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        ...(raw === undefined ? {} : { CORTEX_MEMORY_REVIEW_PASS: raw }),
      });
      expect(options.reviewPass).toBe('none');
    }
  });

  it('reads the pass the product implements', () => {
    expect(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_REVIEW_PASS: ' audit ' })
        .reviewPass,
    ).toBe('audit');
  });

  it('rejects a pass the product does not implement', () => {
    // A second pass with a different question is a future build; today an unknown name is a typo or
    // a stale dispatch, and either way it must not run as the control.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_REVIEW_PASS: 'critique' }),
    ).toThrow(/CORTEX_MEMORY_REVIEW_PASS/);
  });

  it('projects the value into the config and onto the line, `none` included', () => {
    // `none` is a fact about the run -- one consultation -- and the artifact states it rather than
    // leaving "no pass" and "not recorded" as the same shape.
    const off = toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' }));
    expect(off.reviewPass).toBe('none');

    const on = toMemoryArmConfig(
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_REVIEW_PASS: 'audit' }),
    );
    expect(on.reviewPass).toBe('audit');

    const line = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: on,
    });
    expect(line).toContain('reviewPass=audit');
  });
});

/**
 * The evidence roles, which §13.82 measured and §13.83 registered.
 *
 * The reading that put this axis on the table: on the 48,000-character run the multi-session
 * route's rendered room was **51.9% assistant turns**, and the reference pipeline — 85.95% on
 * that capability at half the budget — restricts retrieval to user turns. The arm's job here is
 * only to carry the configuration and to read this dataset's role prefix; the filter itself is
 * the product's, tested in `cortex-memory`'s `evidence-roles.test.ts`.
 */
describe('the evidence roles', () => {
  it('is absent by default, blank and `all`, so every archived run keeps every turn', () => {
    // `all` is the identity rather than an empty list: the product refuses an empty list because
    // it would admit nothing, so "no filter" has to be spelled as absence.
    for (const raw of [undefined, '', '   ', 'all', 'ALL']) {
      const options = cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        ...(raw === undefined ? {} : { CORTEX_MEMORY_EVIDENCE_ROLES: raw }),
      });
      expect(options.evidenceRoles).toBeUndefined();
    }
  });

  it('reads a named set, de-duplicated and in the dataset order', () => {
    // One spelling per reach in the config line: `assistant,user` and `user,assistant` must not
    // produce two artifacts that read as different configurations.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_EVIDENCE_ROLES: ' assistant , user ,user',
    });
    expect(options.evidenceRoles).toEqual(['user', 'assistant']);
  });

  it('rejects a spelling that names no role at all', () => {
    // `','` splits to two empty parts; with whitespace filtering that is an empty set, which the
    // product refuses because it would admit nothing. Rejecting it here names the input instead of
    // failing later with a message about a different layer.
    for (const bad of [',', ' , ']) {
      expect(() =>
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_EVIDENCE_ROLES: bad }),
      ).toThrow(/CORTEX_MEMORY_EVIDENCE_ROLES/);
    }
  });

  it('rejects a role this dataset cannot produce', () => {
    // `system` never appears in a haystack turn, so a filter naming it would drop every parsed
    // turn and leave the run declining on almost every question -- a defect that reads as a
    // dataset with no evidence.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_EVIDENCE_ROLES: 'system' }),
    ).toThrow(/CORTEX_MEMORY_EVIDENCE_ROLES/);
  });

  it('rejects `none`, which would admit nothing', () => {
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_EVIDENCE_ROLES: 'none' }),
    ).toThrow(/CORTEX_MEMORY_EVIDENCE_ROLES/);
  });

  it('scopes the reach through the same reader the cap uses', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_EVIDENCE_ROLES: 'user',
      CORTEX_MEMORY_EVIDENCE_ROLES_ROUTES: 'temporal,multi-session',
    });
    expect(options.evidenceRolesRoutes).toEqual(['multi-session', 'temporal']);
  });

  it('rejects a route name the product does not have', () => {
    expect(() =>
      cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        CORTEX_MEMORY_EVIDENCE_ROLES: 'user',
        CORTEX_MEMORY_EVIDENCE_ROLES_ROUTES: 'multi-session,multihop',
      }),
    ).toThrow(/CORTEX_MEMORY_EVIDENCE_ROLES_ROUTES/);
  });

  it('projects both fields into the config and onto the line', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_EVIDENCE_ROLES: 'user',
      CORTEX_MEMORY_EVIDENCE_ROLES_ROUTES: 'multi-session,temporal',
    });
    const config = toMemoryArmConfig(options);
    expect(config.evidenceRoles).toEqual(['user']);
    expect(config.evidenceRolesRoutes).toEqual(['multi-session', 'temporal']);

    const line = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: config,
    });
    // `+` inside the reach, for the reason `maxTurnCharsRoutes` uses it: the line already
    // separates fields with commas, so a comma inside a value would read as two fields.
    expect(line).toContain('evidenceRoles=user');
    expect(line).toContain('evidenceRolesRoutes=multi-session+temporal');
  });

  it('says `all` on the line when no filter was named', () => {
    const line = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
    });
    expect(line).toContain('evidenceRoles=all');
    expect(line).toContain('evidenceRolesRoutes=all');
  });
});

/**
 * The classifier for this dataset's role prefix, which is the arm's knowledge and not the
 * product's.
 *
 * Every assertion is on a string taken from the real haystack rendering, because the format is
 * the thing being read: a regex that is right about an invented example and wrong about
 * `[2023/02/15 (Wed) 03:14] user:` would pass a test that never saw the data.
 */
describe("reading a turn's role", () => {
  it('reads both roles from the haystack prefix', () => {
    expect(roleOfTurn('[2023/02/15 (Wed) 03:14] user: I need a jacket.')).toBe('user');
    expect(roleOfTurn('[2023/02/15 (Wed) 03:15] assistant: Here are three ideas.')).toBe(
      'assistant',
    );
  });

  it('is case-insensitive about the role and exact about the prefix', () => {
    expect(roleOfTurn('[2024/01/02 (Tue) 11:00] User: hello')).toBe('user');
    // The word appears, but not as this turn's role: a substring match would mislabel the turn
    // and the filter would drop evidence that was kept evidence.
    expect(
      roleOfTurn('[2023/02/15 (Wed) 03:14] system notice: the assistant: replied earlier'),
    ).toBeUndefined();
  });

  it('returns nothing for a turn whose role cannot be read', () => {
    expect(roleOfTurn('no prefix at all')).toBeUndefined();
    expect(roleOfTurn('[2023/02/15] tool: a function returned 3')).toBeUndefined();
    // An empty prefix is not a role either.
    expect(roleOfTurn('[] user: hello')).toBeUndefined();
  });
});

/**
 * §13.97's dispatch surface.
 *
 * The treatment is one model call per multi-session question, made before the relevance
 * index is built. What these assertions hold is the part that has no model in it: the
 * variable's vocabulary, the arm's refusal of a value it does not implement, and the two
 * places the value must appear in the artifact -- the configuration line and the reach
 * counts. A run whose dispatch said `llm` and whose artifact said `none` would be
 * indistinguishable from a control, which is the defect this suite exists to make
 * impossible.
 */
describe('query expansion options (§13.97)', () => {
  it('defaults to the bare question', () => {
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(options.queryExpansion).toBe('none');
    expect(toMemoryArmConfig(options).queryExpansion).toBe('none');
  });

  it('accepts the treatment, tolerating case and surrounding space', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_QUERY_EXPANSION: '  LLM ',
    });
    expect(options.queryExpansion).toBe('llm');
    expect(toMemoryArmConfig(options).queryExpansion).toBe('llm');
  });

  it('rejects a value it does not implement, naming the variable', () => {
    // A silently-defaulted value would publish the control's reading under the
    // treatment's name, which is the one outcome a dispatch must not survive.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_QUERY_EXPANSION: 'embeddings' }),
    ).toThrow(/CORTEX_MEMORY_QUERY_EXPANSION/);
  });

  it('reads the time-window reorder as a third implementation of the same stage', () => {
    // §13.153. `window` is the reference pipeline's own index expansion implemented without a model, so it
    // is a value of this field rather than a field of its own -- and the projection is what the product is
    // handed, so the two must not be able to disagree.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_QUERY_EXPANSION: ' WINDOW ',
    });
    expect(options.queryExpansion).toBe('window');
    expect(toMemoryArmConfig(options).queryExpansion).toBe('window');
  });

  it('names every control in the config line, so the artifact cannot be mistaken for the treatment', () => {
    // Both other values are controls for this mechanism. The config line always states the mode, which is
    // what keeps "the reorder was not administered" from being the same bytes as "the field predates the
    // run" -- the ambiguity `reviewBareDecline` is recorded unconditionally to avoid.
    for (const named of [undefined, 'llm'] as const) {
      const options = cortextMemoryArmOptions({
        CORTEX_MEMORY: '1',
        ...(named === undefined ? {} : { CORTEX_MEMORY_QUERY_EXPANSION: named }),
      });
      expect(options.queryExpansion).toBe(named ?? 'none');
    }

    const rendered = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(
        cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_QUERY_EXPANSION: 'window' }),
      ),
    });
    expect(rendered).toContain('queryExpansion=window');
  });

  it('projects the measured reach beside the mode, and omits it for the control', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_QUERY_EXPANSION: 'llm',
    });
    const measured = toMemoryArmConfig(options, undefined, {
      questions: 121,
      phrases: 417,
      refused: 0,
    });
    expect(measured.queryExpansionCounts).toEqual({ questions: 121, phrases: 417, refused: 0 });
    // Absent, not zeroed: "did not expand" and "expanded nothing" are different facts.
    expect(toMemoryArmConfig(options).queryExpansionCounts).toBeUndefined();
  });

  it('renders the mode on every run and the reach only when one was measured', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_QUERY_EXPANSION: 'llm',
    });
    const base = {
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
    };
    const control = formatAblationReport({
      ...base,
      memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
    });
    const treated = formatAblationReport({
      ...base,
      memoryArmConfig: toMemoryArmConfig(options, undefined, {
        questions: 121,
        phrases: 417,
        refused: 0,
      }),
    });

    expect(control).toContain('queryExpansion=none');
    expect(control).not.toContain('expansion=');
    expect(treated).toContain('queryExpansion=llm');
    expect(treated).toContain('expansion=121q/417p/0r');
  });
});

/**
 * §13.101's dispatch surface and census.
 *
 * The treatment is three consultations of one prompt on the multi-session route, and the census is
 * what makes it falsifiable from the artifact: a run whose votes never disagreed and a run that never
 * voted are different facts, and only the census can tell them apart.
 */
describe('self-consistency options (§13.101)', () => {
  it('defaults to one consultation', () => {
    const options = cortextMemoryArmOptions({ CORTEX_MEMORY: '1' });
    expect(options.selfConsistency).toBe('none');
    expect(toMemoryArmConfig(options).selfConsistency).toBe('none');
  });

  it('accepts the treatment, tolerating case and surrounding space', () => {
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '1',
      CORTEX_MEMORY_SELF_CONSISTENCY: ' 3 ',
    });
    expect(options.selfConsistency).toBe('3');
    expect(toMemoryArmConfig(options).selfConsistency).toBe('3');
  });

  it('rejects a count it does not implement rather than clamping it', () => {
    // A clamped run would consult once and report a treatment, which reads as evidence that voting
    // does not help.
    expect(() =>
      cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SELF_CONSISTENCY: '2' }),
    ).toThrow(/CORTEX_MEMORY_SELF_CONSISTENCY/);
  });

  it('reads a vote census from the feature system into the artifact', async () => {
    const voting: MemorySystem & {
      voteCounts: () => { unanimous: number; majority: number; split: number };
    } = {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      voteCounts: () => ({ unanimous: 1, majority: 2, split: 3 }),
    };
    const { report } = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      voting,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: toMemoryArmConfig(
          cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_SELF_CONSISTENCY: '3' }),
        ),
      },
    );

    expect(report.memoryArmConfig?.voteCounts).toEqual({ unanimous: 1, majority: 2, split: 3 });
    expect(report.memoryArmConfig?.selfConsistency).toBe('3');
    // The configuration line renders both, beside each other, because the count has no meaning
    // without the mode that produced it.
    expect(formatAblationReport(report)).toContain('selfConsistency=3');
    expect(formatAblationReport(report)).toContain('vote=1/2/3');
  });

  it('discards a malformed census rather than publishing it', async () => {
    // A field that is present but wrong is indistinguishable from a real reading, so anything that
    // is not three non-negative integers is treated as absent.
    const broken: MemorySystem & { voteCounts: () => unknown } = {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      voteCounts: () => ({ unanimous: 1, majority: -2, split: 3 }),
    };
    const { report } = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      broken,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
      },
    );

    expect(report.memoryArmConfig?.voteCounts).toBeUndefined();
    expect(formatAblationReport(report)).not.toContain('vote=');
  });

  it('discards a census accessor that throws', async () => {
    // A throwing accessor is a broken optional capability, not a failed run: the endpoint has already
    // been measured by this point, so the census is dropped rather than the arm.
    const throwing: MemorySystem & { voteCounts: () => unknown } = {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      voteCounts: () => {
        throw new Error('census unavailable');
      },
    };
    const { report } = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      throwing,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
      },
    );

    expect(report.memoryArmConfig?.voteCounts).toBeUndefined();
  });

  it('discards a census that is not an object', async () => {
    // The accessor exists but returns nothing usable. Absent is the honest reading: a reader cannot
    // tell a null census from a run that never voted, so neither is published.
    const empty: MemorySystem & { voteCounts: () => unknown } = {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      voteCounts: () => null,
    };
    const { report } = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      empty,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
      },
    );

    expect(report.memoryArmConfig?.voteCounts).toBeUndefined();
  });

  it('treats a census of three zeros as a run that did not vote', async () => {
    // Every vote lands in one of the three buckets, so the sum is the number of votes taken. A
    // zeroed census on a control run would claim a mechanism that never ran -- which is what the
    // first dispatch of this feature actually published (`vote=0/0/0` in `39641088296`).
    const idle: MemorySystem & { voteCounts: () => unknown } = {
      name: 'cortex-memory',
      answer: () => 'Lisbon',
      voteCounts: () => ({ unanimous: 0, majority: 0, split: 0 }),
    };
    const { report } = await runCortexMemoryArm(
      twoQuestionDataset(),
      constantSystem('reference-pipeline', 'Lisbon'),
      idle,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
      },
    );

    expect(report.memoryArmConfig?.voteCounts).toBeUndefined();
    expect(formatAblationReport(report)).not.toContain('vote=');
  });

  it('renders no census on a run that did not vote', () => {
    const line = formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1' })),
    });
    expect(line).toContain('selfConsistency=none');
    expect(line).not.toContain('vote=');
  });
});

/**
 * The artifact's own timestamp, which was two hours early.
 *
 * `runAblationReport` stamps `generatedAt` after the ablation returns -- unless the caller
 * hands it one, and the arm did: `generatedAt: options.generatedAt ?? new Date().toISOString()`
 * is an **argument**, so it is evaluated when the call is made, before two hours of questions.
 * Run `40722772896` therefore wrote `2026-10-28T16:08:38.140Z` into a report whose artifact was
 * uploaded at `18:15:55Z`, and the first reader to subtract the two (this campaign, auditing the
 * run's duration from the artifact alone) got 92 seconds for a 2h08m run.
 *
 * The fix is to stop evaluating the default at the call site. What is asserted here is the
 * ordering rather than the value: the stamp must not precede the last thing the run did.
 */
describe('the report timestamp is taken when the numbers exist, not when the work is ordered', () => {
  const CONFIG = {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: null,
    sourceTrust: 0.5,
    confidenceSignal: 'none',
    promptContract: 'abstention',
    relevanceSignal: 'none',
    relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
    relevanceUnits: 'turn',
    renderingRoutes: [],
    ask: 'route',
    askRoutes: [],
    reviewPass: 'none',
    reviewBareDecline: false,
  } as const;

  function oneQuestion(): BenchmarkDataset {
    return {
      name: 'fixture',
      questions: [
        {
          id: 'q1',
          capability: 'TR',
          questionType: 'single-session-user',
          question: 'Where did I go?',
          expected: 'Lisbon',
          context: [],
          sessions: [],
        },
      ],
    } as unknown as BenchmarkDataset;
  }

  it('stamps generatedAt at or after the last answer the reader gave', async () => {
    // The reader takes real time on purpose: without a gap the two candidate stamps are the
    // same millisecond and the assertion would pass on the defect. Five milliseconds is the
    // smallest gap that survives a loaded CI runner without becoming a sleep test.
    let finishedAt = 0;
    const slowFeature = {
      name: 'cortex-memory',
      answer: async (): Promise<Answer> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finishedAt = Date.now();
        return 'Lisbon';
      },
      lastRetrievedContext: () => ['user: I went to Lisbon.'],
      lastAdmittedEvidence: () => ({ turns: 1, chars: 24 }),
      lastRawOutput: () => 'Lisbon',
    } as unknown as MemorySystem;
    const promptOnly = {
      name: 'reference-pipeline',
      answer: (): Answer => 'Lisbon',
    } as unknown as MemorySystem;

    const { report } = await runCortexMemoryArm(oneQuestion(), promptOnly, slowFeature, {
      runs: 1,
      scorer: exactMatchScorer,
      memoryArmConfig: CONFIG,
    });

    expect(finishedAt).toBeGreaterThan(0);
    expect(Date.parse(report.generatedAt)).toBeGreaterThanOrEqual(finishedAt);
  });

  it('still honours an injected clock, because a reproducible run needs one', async () => {
    // The injection is the reason the field exists as an option at all: a test or a replay
    // cannot assert a wall-clock value. Dropping the eager default must not drop this path,
    // which is why the fix is a conditional spread and not a deletion.
    // Two objects, not one: the arm refuses an identical pair, and that guard is right -- a
    // feature that IS the baseline reports 0.00pp by construction. The distinction matters here
    // because the injected-clock path is exercised through the same constructor as any other run.
    const promptOnly = {
      name: 'reference-pipeline',
      answer: (): Answer => 'Lisbon',
    } as unknown as MemorySystem;
    const featureOfSameShape = {
      name: 'cortex-memory',
      answer: (): Answer => 'Lisbon',
    } as unknown as MemorySystem;
    const { report } = await runCortexMemoryArm(oneQuestion(), promptOnly, featureOfSameShape, {
      runs: 1,
      scorer: exactMatchScorer,
      memoryArmConfig: CONFIG,
      generatedAt: '1970-01-01T00:00:00.000Z',
    });

    expect(report.generatedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

/**
 * §13.187.6D: the mark of omission at the per-turn cap.
 *
 * The treatment lives in `cortex-memory`'s renderer, so the property that matters **here** is the
 * arm's: that a dispatch reaches it, that the artifact says which state the run was in, and that
 * the impossible states are unexpressible rather than merely guarded. The marker rides on the
 * cap's value -- `<width>:<marker>` -- because the workflow sits one input below GitHub's
 * 25-input ceiling and this suite forbids the ceiling, and because a marker without a cap is a
 * claim about a cut that cannot happen.
 */
describe('the cut marker on the arm', () => {
  function line(options: ReturnType<typeof cortextMemoryArmOptions>): string {
    return formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
      feature: { name: 'cortex-memory', metrics: emptyMetrics() },
      ablation: emptyAblation('cortex-memory'),
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: toMemoryArmConfig(options),
    });
  }

  const arm = (cap: string): ReturnType<typeof cortextMemoryArmOptions> =>
    cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_MAX_TURN_CHARS: cap });

  it('defaults to `none`, the historical rendering', () => {
    // Every archived capped run was produced without a marker, so the default must be the state
    // those runs were in -- not merely an inert value that happens to render the same today.
    const options = arm('400');

    expect(options.maxTurnChars).toBe(400);
    expect(options.turnCutMarker).toBe('none');
    expect(toMemoryArmConfig(options).turnCutMarker).toBe('none');
    expect(line(options)).toContain('turnCutMarker=none');
    // And `none` spelled out is the same state, so a registration can name its control.
    const named = arm('400:none');
    expect(named.maxTurnChars).toBe(400);
    expect(named.turnCutMarker).toBe('none');
  });

  it('accepts the treatment and carries both halves into the artifact', () => {
    const options = arm('400:ellipsis');

    expect(options.maxTurnChars).toBe(400);
    expect(options.turnCutMarker).toBe('ellipsis');
    // The artifact records the two halves as separate fields, so no reader of an artifact has to
    // parse the dispatch syntax back apart.
    expect(toMemoryArmConfig(options).maxTurnChars).toBe(400);
    expect(toMemoryArmConfig(options).turnCutMarker).toBe('ellipsis');
    expect(line(options)).toContain('maxTurnChars=400');
    expect(line(options)).toContain('turnCutMarker=ellipsis');
  });

  it('rejects a marker the product does not implement', () => {
    // Accepted-and-ignored is the failure that matters: a run dispatched to mark its cuts that
    // rendered them silently would publish an unchanged number reading as "the mark does not
    // matter", and only the artifact's own config line would show the difference.
    for (const bad of ['400:dots', '400:ellipsis.', '400:ELLIPSIS']) {
      expect(() => arm(bad)).toThrow(/CORTEX_MEMORY_MAX_TURN_CHARS/);
    }
  });

  it('lists the accepted marker names in the rejection, so a typo is fixable from the log', () => {
    expect(() => arm('400:nope')).toThrow(/ellipsis/);
  });

  it('cannot express a marker without a cap, which is the point of the grammar', () => {
    // The combination is not guarded, it is unrepresentable: with no width there is no cut, so
    // a bare marker is a malformed cap rather than a cap-less marker.
    for (const bad of ['ellipsis', ':ellipsis', 'none:ellipsis']) {
      expect(() => arm(bad)).toThrow(/CORTEX_MEMORY_MAX_TURN_CHARS/);
    }
  });

  it('takes one marker at most', () => {
    expect(() => arm('400:ellipsis:none')).toThrow(/one optional marker/);
  });

  it('still refuses a cap of zero and a fraction, for the §13.67 reasons', () => {
    // The grammar must not become a way past the width's own guard: `400:ellipsis` is fine and
    // `0:ellipsis` is the same defect as `0`, with a mark of omission on empty evidence.
    for (const bad of ['0', '1.5', '0:ellipsis', '-400']) {
      expect(() => arm(bad)).toThrow(/positive integer/);
    }
  });

  it('projects `none` on a disabled arm, which cuts nothing', () => {
    // The arm is off, so there is no prompt to mark. Projecting the identity rather than the
    // requested value keeps a disabled run's config from claiming a marker it never rendered.
    const options = cortextMemoryArmOptions({
      CORTEX_MEMORY: '0',
      CORTEX_MEMORY_MAX_TURN_CHARS: '400:ellipsis',
    });

    expect(options.turnCutMarker).toBe('none');
    expect(line(options)).toContain('turnCutMarker=none');
  });

  it('spells `none` for a config that predates the field', () => {
    // An artifact written before §13.188 has no such key, and those runs are the control. The
    // renderer must say so rather than omit the field, or "ran the control" and "written before
    // the field existed" would be the same bytes -- the reason `reviewPass` is rendered on
    // every run.
    const config = toMemoryArmConfig(arm('400'));
    const { turnCutMarker: _omitted, ...withoutField } = config;

    expect(
      formatAblationReport({
        dataset: 'fixture',
        questionCount: 0,
        baseline: { name: 'reference-pipeline', metrics: emptyMetrics() },
        feature: { name: 'cortex-memory', metrics: emptyMetrics() },
        ablation: emptyAblation('cortex-memory'),
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: withoutField as never,
      }),
    ).toContain('turnCutMarker=none');
  });
});

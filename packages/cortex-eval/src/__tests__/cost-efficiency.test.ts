/**
 * §13.308 — the cost of a correct answer is written by the run, not re-derived by each reader.
 *
 * ## The defect this file is written against
 *
 * `tools/cost-ledger.py` prices a correct answer as `perQuestionPerRun / accuracy`, and on the day
 * it was written every artifact it could read had exactly one accuracy to offer:
 * `feature.metrics.accuracy`, which `report.ts` renders as *"accuracy (first repetition)"* for the
 * reason §13.122 records at length. The numerator of that ratio is not a first-repetition number.
 * `usageBySide.feature.promptTokens` is the **sum over every repetition**, and `perQuestionPerRun`
 * divides it by `questionCount × runs` — an all-repetitions mean. So the shipped reading divided an
 * all-run numerator by a one-run denominator.
 *
 * The two arms of the same-day pair (§13.305) put a number on it:
 *
 * | run | first repetition | all repetitions | difference |
 * | --- | --- | --- | --- |
 * | `42355323615` (baseline) | 91.40% | 91.95% | **−0.55 pp** |
 * | `42387911305` (control)  | 90.80% | 90.75% | +0.05 pp |
 *
 * Both divisions are arithmetically defensible and only one of them answers the question the field
 * is named after. The shipped one charges the baseline 0.60% more than it spent and the control
 * 0.06% less, which turns a 1.20 pp accuracy gap into a **0.57%** cost gap where the honest figure
 * is **1.23%** — the arm that answered fewer questions correctly looked 54% cheaper than it was.
 *
 * ## Why the fix is a field and not a better division in the tool
 *
 * A reading that every consumer recomputes is a reading every consumer can get differently right.
 * The run already knows both inputs at the moment it writes its artifact, so it writes the ratio
 * with **the population its denominator came from attached beside it**. `accuracySource` is not
 * decoration: `all-runs` and `first-repetition` are the same number on a one-repetition run and
 * different numbers on a four-repetition one, and a reader comparing two artifacts is entitled to
 * know which one it is holding.
 *
 * ## The invariant, which is the part a review cannot check
 *
 * Repetition order is arbitrary. Reordering four repetitions changes `feature.metrics.accuracy`
 * and changes nothing else in the artifact — the token total, the question count and the run count
 * are all permutation-invariant. So a correct implementation returns the **same** cost per correct
 * answer for both orderings, and the shipped one moves. That is what
 * `keeps the reading invariant to which repetition came first` asserts, and it is the test that
 * would have caught this before an arm was ever dispatched.
 */
import { describe, it, expect } from 'vitest';

import {
  attachCostEfficiency,
  attachUsageBySide,
  formatAblationReport,
  type AblationReport,
} from '../report.js';
import { costEfficiencyFrom, type UsageBySide } from '../usage-by-side.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';
import type { UsageSnapshot } from '@agentix-e/cortex-ai';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(accuracy: number): Metrics {
  return {
    total: 500,
    correct: Math.round(accuracy * 500),
    accuracy,
    abstentionRate: 0.068,
    abstentionCorrectRate: 0.8824,
    abstentionAwareAccuracy: accuracy,
    perCapability: {
      IE: { total: 150, correct: 144, accuracy: 0.96, abstained: 0 },
      MR: { total: 121, correct: 94, accuracy: 0.7769, abstained: 0 },
      KU: { total: 72, correct: 63, accuracy: 0.875, abstained: 0 },
      TR: { total: 127, correct: 122, accuracy: 0.9606, abstained: 0 },
      ABS: { total: 30, correct: 30, accuracy: 1, abstained: 30 },
    },
  };
}

function paired(total: number): PerCapabilityPairedStats {
  return {
    total,
    baselineCorrect: total,
    featureCorrect: total,
    baselineCorrectFeatureIncorrect: 0,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
  };
}

function snapshot(promptTokens: number): UsageSnapshot {
  return {
    calls: 2_074,
    unpricedCalls: 0,
    promptTokens,
    completionTokens: 2_141_529,
    cacheHitPromptTokens: 23_847_819,
  };
}

type ArmOptions = {
  /** `feature.metrics.accuracy` — ONE repetition, whichever the harness ran first. */
  readonly firstRepetition: number;
  /**
   * `ablation.featureAggregate` — the spread over every repetition, or `null` for an artifact
   * written before the field existed (which is what the reader shipped against has to survive).
   */
  readonly aggregate: { min: number; avg: number; max: number; median?: number } | null;
  readonly promptTokens?: number;
  /** `null` omits the field, which is what an artifact from before it existed looks like. */
  readonly questions?: number | null;
  readonly runs?: number | null;
  readonly withSide?: boolean;
};

/**
 * The shape of the §13.305 pair, with the two accuracies allowed to disagree.
 *
 * The token figure is the control run's own: 24,252,638 prompt tokens over 500 questions and four
 * repetitions is 12,126 prompt tokens per question per repetition, which is what the ledger tool
 * has been quoting as `perQuestionPerRun`.
 */
function arm(options: ArmOptions): AblationReport {
  const {
    firstRepetition,
    aggregate,
    promptTokens = 24_252_638,
    questions = 500,
    runs = 4,
    withSide = true,
  } = options;
  const spread = aggregate === null ? null : { median: aggregate.avg, ...aggregate };
  const fallbackSpread = { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 };
  const ablation: AblationResult = {
    feature: 'cortex-memory',
    baselineAggregate: spread ?? fallbackSpread,
    featureAggregate: spread ?? fallbackSpread,
    delta: 0,
    pValue: Number.NaN,
    significant: false,
    effectSize: 0,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: [],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: metrics(0.004),
    featureMetrics: metrics(firstRepetition),
    featureCorrect: Array.from({ length: 500 }, () => true),
    perCapability: Object.fromEntries(
      CAPABILITIES.map((c) => [c, paired(c === 'MR' ? 121 : 100)]),
    ) as Record<Capability, PerCapabilityPairedStats>,
  };
  if (aggregate === null) {
    // An artifact from before the spread existed still has to be readable: the field is required
    // by the type and absent in the file, which is exactly the case a runtime guard is for.
    delete (ablation as Partial<AblationResult>).featureAggregate;
  }
  const base = {
    dataset: 'longmemeval-s',
    ...(questions === null ? {} : { questionCount: questions }),
    ...(runs === null ? {} : { runs }),
    baseline: { name: 'reference-pipeline', metrics: metrics(0.004) },
    feature: { name: 'cortex-memory', metrics: metrics(firstRepetition) },
    ablation,
    generatedAt: '2026-11-07T17:12:35.000Z',
    // The cast is the fixture's whole point: two of these tests hand the reader an artifact whose
    // required fields are missing, because a required field is a claim about what this build
    // writes and not about what a file on disk contains.
  } as unknown as AblationReport;
  if (!withSide) return base;
  const bySide: UsageBySide = {
    baseline: snapshot(2_701_881),
    feature: snapshot(promptTokens),
  };
  // The order the pipeline uses: usage first, then the reading that divides it.
  return attachCostEfficiency(attachUsageBySide(base, bySide));
}

describe('§13.308 the cost of one correct answer', () => {
  it('prices from the mean over every repetition, not from the first one', () => {
    // The baseline of the same-day pair: the first repetition is its worst, and dividing an
    // all-repetition numerator by it charges the arm for a run that is not the one that was summed.
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    expect(priced.costEfficiency).toBeDefined();
    expect(priced.costEfficiency?.accuracySource).toBe('all-runs');
    expect(priced.costEfficiency?.accuracy).toBe(0.9195);
  });

  it('keeps the reading invariant to which repetition came first', () => {
    // Repetition order is arbitrary and only `feature.metrics.accuracy` depends on it. An
    // implementation that reads that field produces two prices for one run.
    const worstFirst = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    const bestFirst = arm({
      firstRepetition: 0.932,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    expect(worstFirst.costEfficiency?.perCorrectAnswerPromptTokens).toBe(
      bestFirst.costEfficiency?.perCorrectAnswerPromptTokens,
    );
  });

  it('divides the all-repetition numerator by the all-repetition denominator', () => {
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    const perQuestion = 24_252_638 / (500 * 4);
    expect(priced.costEfficiency?.promptTokensPerQuestion).toBeCloseTo(perQuestion, 6);
    expect(priced.costEfficiency?.perCorrectAnswerPromptTokens).toBeCloseTo(
      perQuestion / 0.9195,
      6,
    );
  });

  it('falls back to the single repetition when the arm has no spread', () => {
    // A one-repetition run has no `featureAggregate`, and there the two populations coincide --
    // so the field is still written, and it says which population it used.
    const priced = arm({ firstRepetition: 0.906, aggregate: null, runs: 1 });
    expect(priced.costEfficiency?.accuracySource).toBe('first-repetition');
    expect(priced.costEfficiency?.accuracy).toBe(0.906);
  });

  it('refuses to price an arm that answered nothing right', () => {
    // Infinity is not a price. The run happened and the artifact says so by omitting the ratio,
    // which is a different statement from writing a large number.
    const priced = arm({ firstRepetition: 0, aggregate: { min: 0, avg: 0, max: 0 } });
    expect(priced.costEfficiency).toBeUndefined();
  });

  it('refuses when the artifact has no side split to divide', () => {
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
      withSide: false,
    });
    expect(priced.costEfficiency).toBeUndefined();
  });

  it('refuses when the repetition count is unknown', () => {
    // `perQuestionPerRun` is undefined without it, and a per-question figure taken over the wrong
    // number of repetitions is the same defect §13.140 found one layer down.
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
      runs: null,
    });
    expect(priced.costEfficiency).toBeUndefined();
  });

  it('refuses when the question count is unknown', () => {
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
      questions: null,
    });
    expect(priced.costEfficiency).toBeUndefined();
  });

  it('refuses an arm that spent nothing, because a free run is an unmeasured one', () => {
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
      promptTokens: 0,
    });
    expect(priced.costEfficiency).toBeUndefined();
  });

  it('carries the accuracy beside the ratio, because the ratio is a function of it', () => {
    // Two arms can be compared on this field only if both denominators travel with it. A price
    // quoted alone is a product of two numbers with one of them hidden.
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    expect(priced.costEfficiency?.accuracy).toBeCloseTo(0.9195, 10);
    expect(priced.costEfficiency?.perCorrectAnswerPromptTokens).toBeCloseTo(
      (priced.costEfficiency?.promptTokensPerQuestion ?? 0) / 0.9195,
      6,
    );
  });

  it('separates the two arms of the same-day pair by the honest figure, not by 0.57%', () => {
    // The reason this file exists: the shipped division read the pair as 0.57% apart on cost when
    // the denominator that belongs with the numerator puts them 1.23% apart. The pair's real
    // numbers, recomputed here so a regression names a value rather than a direction.
    const baseline = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
      promptTokens: 24_273_758,
    });
    const control = arm({
      firstRepetition: 0.908,
      aggregate: { min: 0.902, avg: 0.9075, max: 0.91 },
    });
    const basePrice = baseline.costEfficiency?.perCorrectAnswerPromptTokens ?? Number.NaN;
    const ctrlPrice = control.costEfficiency?.perCorrectAnswerPromptTokens ?? Number.NaN;
    expect(basePrice).toBeCloseTo(13_199.43, 1);
    expect(ctrlPrice).toBeCloseTo(13_362.34, 1);
    const gap = (ctrlPrice - basePrice) / basePrice;
    expect(gap).toBeCloseTo(0.01234, 4);
  });

  it('names the size of the overstatement the first-repetition denominator makes', () => {
    // The baseline is the arm whose first repetition is its worst, so the shipped division charged
    // it 0.60% more than it spent. Quoted as a ratio of two prices for one run, because that is the
    // form in which the error survives being copied into a table.
    const perQuestion = 24_273_758 / (500 * 4);
    const shipped = perQuestion / 0.914;
    const honest = perQuestion / 0.9195;
    expect(1 - shipped / honest).toBeLessThan(0);
    expect(shipped / honest - 1).toBeCloseTo(0.006018, 5);
  });

  it('attaches only once, and the second attach cannot change the first answer', () => {
    // `attachCostEfficiency` is called on the assembled report. Re-running it must be idempotent,
    // because the pipeline attaches usage before transport and any future reordering would double
    // the call rather than fail.
    const once = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    const twice = attachCostEfficiency(once);
    expect(twice.costEfficiency).toEqual(once.costEfficiency);
  });

  it('renders the reading and the denominator it was divided by', () => {
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    const md = formatAblationReport(priced);
    expect(md).toContain('per correct answer');
    expect(md).toContain('91.95%');
    expect(md).toContain('all-runs');
  });

  it('says "first-repetition" out loud when that is the population it used', () => {
    // The label is the whole value of the field: `all-runs` and `first-repetition` are the same
    // number on a one-run arm and a different number on a four-run one.
    const priced = arm({ firstRepetition: 0.906, aggregate: null, runs: 1 });
    const md = formatAblationReport(priced);
    expect(md).toContain('first-repetition');
  });
});

/**
 * The four refusals, tested at the function that makes them.
 *
 * `attachCostEfficiency` returns before reaching any of them when the side split or the repetition
 * count is absent, so a test that only went through `attach` would leave every guard in
 * `costEfficiencyFrom` unexecuted — which is how a guard becomes decorative.
 */
describe('§13.308 the four divisions that are not prices', () => {
  const sound = {
    promptTokens: 24_273_758,
    questionCount: 500,
    runs: 4,
    accuracy: 0.9195,
    accuracySource: 'all-runs' as const,
  };

  it('prices the sound input', () => {
    expect(costEfficiencyFrom(sound)?.perCorrectAnswerPromptTokens).toBeCloseTo(13_199.43, 1);
  });

  it.each([
    ['a run that spent nothing', { promptTokens: 0 }],
    ['a spend that is not a number', { promptTokens: Number.NaN }],
    ['no questions graded', { questionCount: 0 }],
    ['a question count that is not a number', { questionCount: Number.NaN }],
    ['no repetitions', { runs: 0 }],
    ['a repetition count that is not a number', { runs: Number.NaN }],
    ['an arm that answered nothing right', { accuracy: 0 }],
    ['an accuracy above one, i.e. a percentage', { accuracy: 92 }],
    ['an accuracy that is not a number', { accuracy: Number.NaN }],
  ])('refuses %s', (_why: string, broken: Record<string, number>) => {
    expect(costEfficiencyFrom({ ...sound, ...broken })).toBeNull();
  });
});

/**
 * A split that does not close is not a split, and a price derived from one is not a price.
 *
 * `usageBySide` carries two independently accumulated tallies. `residualUsage` refuses when they
 * claim more than the run reported, because that means the two snapshots did not come from one
 * ledger — and the renderer already declines to print a per-arm column in that case. The price of a
 * correct answer is computed from the same column, so it has to decline for the same reason: a
 * ratio whose numerator is known to be wrong is worse than an absent ratio, because absence reads
 * as "not measured" while a number reads as a measurement.
 */
describe('§13.308 a split that does not close cannot price an answer', () => {
  function unbalanced(): AblationReport {
    const base = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    // The reading is stripped first so the test measures `attachCostEfficiency` rather than the
    // fixture: a report that already carried a price would pass the refusal test by construction.
    const { costEfficiency: _stripped, ...rest } = base;
    return {
      ...rest,
      // Less than either side alone: the two tallies cannot both have come from this run.
      llmUsage: { ...snapshot(1_000_000) },
    };
  }

  it('refuses the reading rather than dividing an inconsistent column', () => {
    const priced = attachCostEfficiency(unbalanced());
    expect(priced.costEfficiency).toBeUndefined();
  });

  it('still prices a report that carries no total, because the split is all it needs', () => {
    // The guard is conditional on the total existing, for the reason the renderer's is: `llmUsage`
    // and `usageBySide` are independent, and requiring one to check the other would make a
    // report that has only the split unpriceable for no reason.
    const priced = arm({
      firstRepetition: 0.914,
      aggregate: { min: 0.914, avg: 0.9195, max: 0.932 },
    });
    expect(priced.llmUsage).toBeUndefined();
    expect(priced.costEfficiency).toBeDefined();
  });

  it('says the split is unavailable instead of printing one that does not add up', () => {
    const md = formatAblationReport(unbalanced());
    expect(md).toContain('SPLIT UNAVAILABLE');
    expect(md).not.toContain('per correct answer');
  });
});

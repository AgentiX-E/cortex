/**
 * Every archived ablation report must render.
 *
 * Three defects in this repository shared one mechanism: a value that is a real
 * number in memory becomes `null` on disk, because `JSON.stringify` has no
 * representation for `NaN` or `±Infinity`. The renderer then throws, or -- worse
 * -- prints a plausible wrong number. Each was found late, by someone noticing a
 * missing or absurd table in a document nobody re-read after it was produced.
 *
 * The permanent lesson is that a renderer's input is not the in-memory object. It
 * is the persisted object, and `bench/run.ts` renders before serialising, so the
 * only state the renderer is ever exercised on in production is the one it never
 * sees in the type system. This suite closes that gap by constructing the inputs
 * the way production does: parsed from JSON, with `null` where the live run held
 * `NaN` or an infinity.
 *
 * The fixtures are the shapes of every ablation arm in `runner.ts`, taken from
 * the arms' real field sets rather than invented, so a new arm that introduces a
 * numeric field the renderer cannot handle fails here instead of in an artifact.
 */
import { describe, it, expect } from 'vitest';
import { formatAblationReport, type AblationReport } from '../report.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(): Metrics {
  return {
    total: 60,
    correct: 51,
    accuracy: 0.85,
    abstentionRate: 0.15,
    abstentionCorrectRate: 0.8888888888888888,
    abstentionAwareAccuracy: 0.85,
    perCapability: {
      IE: { total: 26, correct: 23, accuracy: 0.8846153846153846, abstained: 2 },
      MR: { total: 9, correct: 8, accuracy: 0.8888888888888888, abstained: 1 },
      KU: { total: 8, correct: 5, accuracy: 0.625, abstained: 2 },
      TR: { total: 8, correct: 6, accuracy: 0.75, abstained: 1 },
      ABS: { total: 9, correct: 9, accuracy: 1, abstained: 9 },
    },
  };
}

function paired(total: number): PerCapabilityPairedStats {
  return {
    total,
    baselineCorrect: total - 1,
    featureCorrect: total,
    baselineCorrectFeatureIncorrect: 1,
    baselineIncorrectFeatureCorrect: 2,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
  };
}

/**
 * A live report for one arm. `pValue` and `effectSize` take the values a real
 * single-run ablation produces: `NaN` and an infinity, because the over-run
 * t-test needs `runs >= 2` and Cohen's d is unbounded when the arms never agree.
 * `runs >= 2` is the exception, not the rule, so this is the common case.
 */
function liveReport(overrides: Partial<AblationReport> = {}): AblationReport {
  const ablation: AblationResult = {
    feature: 'feature',
    baselineAggregate: { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 },
    featureAggregate: { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 },
    delta: 0,
    pValue: Number.NaN,
    significant: false,
    effectSize: Number.NEGATIVE_INFINITY,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
    mcnemarPValue: 0.0039062500000000095,
    mcnemarSignificant: true,
    discordant: { baselineCorrectFeatureIncorrect: 1, baselineIncorrectFeatureCorrect: 2 },
    baselineMetrics: metrics(),
    featureMetrics: metrics(),
    featureCorrect: Array.from({ length: 60 }, (_, i) => i % 4 !== 0),
    perCapability: Object.fromEntries(
      CAPABILITIES.map((c) => [c, paired(c === 'MR' ? 9 : 8)]),
    ) as Record<Capability, PerCapabilityPairedStats>,
  };
  return {
    dataset: 'longmemeval',
    questionCount: 60,
    baseline: { name: 'baseline', metrics: metrics() },
    feature: { name: 'feature', metrics: metrics() },
    ablation,
    generatedAt: '2026-09-20T09:45:00.000Z',
    ...overrides,
  };
}

/**
 * The arms, by the optional field each one carries. Enumerated rather than
 * sampled so a new arm is a visible omission from this list.
 */
const ARM_SHAPES: { name: string; build: () => AblationReport }[] = [
  { name: 'plain arm (no optional fields)', build: () => liveReport() },
  {
    name: 'cohort arm, complete',
    build: () =>
      liveReport({
        cohortCoverage: { present: ['a_abs', 'b_abs'], missing: [], ratio: 1 },
      }),
  },
  {
    name: 'cohort arm, incomplete',
    build: () =>
      liveReport({
        cohortCoverage: { present: ['a_abs'], missing: ['b_abs'], ratio: 0.5 },
      }),
  },
  {
    name: 'retry arm with a working control',
    build: () =>
      liveReport({ retryFires: { controlFires: 0, treatmentFires: 3, questions: 60 } }),
  },
  {
    name: 'retry arm with a misconfigured control',
    build: () =>
      liveReport({ retryFires: { controlFires: 2, treatmentFires: 3, questions: 60 } }),
  },
  {
    name: 'retry arm that never fired',
    build: () =>
      liveReport({ retryFires: { controlFires: 0, treatmentFires: 0, questions: 60 } }),
  },
  {
    name: 'retry arm that fired once',
    build: () =>
      liveReport({ retryFires: { controlFires: 0, treatmentFires: 1, questions: 60 } }),
  },
];

/**
 * A report whose BOTH optional fields are present. Two optional fields means
 * four combinations, and the two-of-two case is the one a careless formatter
 * breaks -- an early `return` after the first section drops the second.
 */
function bothFields(): AblationReport {
  return liveReport({
    cohortCoverage: { present: ['a_abs'], missing: ['b_abs'], ratio: 0.5 },
    retryFires: { controlFires: 0, treatmentFires: 3, questions: 60 },
  });
}

describe('every arm shape renders after a JSON round-trip', () => {
  for (const arm of ARM_SHAPES) {
    it(`${arm.name}`, () => {
      const live = arm.build();
      // The production input: what `bench/run.ts` writes and what a reader
      // re-reads. `NaN` and `-Infinity` have already become `null` here.
      const persisted = JSON.parse(JSON.stringify(live)) as AblationReport;
      const md = formatAblationReport(persisted);
      expect(md).toContain('# Cortex Benchmark Report');
      expect(md).toContain('## Ablation (abstention-aware accuracy)');
      expect(md).toContain('## Per-capability breakdown (feature system)');
      expect(md).toContain('## Per-capability paired significance');
    });
  }

  it('renders an arm carrying both optional sections, without dropping the second', () => {
    const persisted = JSON.parse(JSON.stringify(bothFields())) as AblationReport;
    const md = formatAblationReport(persisted);
    // Ordering: the cohort banner qualifies the numbers, so it precedes them;
    // the fires table is evidence about a delta, so it follows.
    expect(md.indexOf('COHORT INCOMPLETE')).toBeLessThan(md.indexOf('Δ accuracy'));
    expect(md.indexOf('Abstention-retry fires')).toBeGreaterThan(md.indexOf('Δ accuracy'));
  });

  it('is idempotent: re-rendering the rendered report is unchanged', () => {
    // The persisted form is a fixed point. If it were not, a re-render of an
    // archived artifact could differ from the artifact's own Markdown -- and the
    // two are supposed to be the same document.
    const persisted = JSON.parse(JSON.stringify(bothFields())) as AblationReport;
    const once = formatAblationReport(persisted);
    const twice = formatAblationReport(persisted);
    expect(twice).toBe(once);
  });
});

describe('the JSON round-trip changes exactly the fields that cannot survive it', () => {
  it('turns NaN and infinities into null, and nothing else', () => {
    const live = liveReport();
    const persisted = JSON.parse(JSON.stringify(live)) as AblationReport;
    expect(live.ablation.pValue).toBeNaN();
    expect(persisted.ablation.pValue).toBeNull();
    expect(live.ablation.effectSize).toBe(Number.NEGATIVE_INFINITY);
    expect(persisted.ablation.effectSize).toBeNull();
    // A finite value is untouched -- the transformation is specific, not a
    // blanket nulling, which is what makes a targeted fix correct.
    expect(persisted.ablation.mcnemarPValue).toBe(live.ablation.mcnemarPValue);
    expect(persisted.ablation.delta).toBe(live.ablation.delta);
    expect(persisted.questionCount).toBe(live.questionCount);
  });

  it('renders a null p-value as a label, never as a number', () => {
    const persisted = JSON.parse(JSON.stringify(liveReport())) as AblationReport;
    const md = formatAblationReport(persisted);
    // The fallback is the label, and a fabricated `0.000e+0` must not appear:
    // a p-value of 0 would read as overwhelming evidence, which inverts the
    // finding -- the run produced NO evidence.
    expect(md).toContain('n/a (deterministic)');
    expect(md).not.toMatch(/t-test p-value: \*\*0\.000e\+0/);
  });

  it('renders a null effect size as n/a, not as zero', () => {
    const persisted = JSON.parse(JSON.stringify(liveReport())) as AblationReport;
    const md = formatAblationReport(persisted);
    expect(md).toContain("Cohen's d: **n/a**");
    // `d = 0.000` reads as "no effect"; the truth is an unbounded effect. The
    // substitution would silently reverse the conclusion.
    expect(md).not.toContain("Cohen's d: **0.000**");
  });

  it('still labels a surviving infinity', () => {
    // A live (unpersisted) report holds the real infinities, so both the
    // persisted and the live path have to render. Covering only the persisted
    // one would leave the in-memory path unexercised and vice versa.
    const md = formatAblationReport(liveReport());
    expect(md).toContain("Cohen's d: **-∞**");
  });
});

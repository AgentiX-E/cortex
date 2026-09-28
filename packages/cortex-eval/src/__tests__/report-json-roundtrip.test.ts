/**
 * The report renderer must survive a round-trip through JSON.
 *
 * Every ablation report is written twice: once as Markdown for a human reader and
 * once as JSON for a machine reader. The JSON is the durable artifact — it is
 * what gets archived, diffed between runs, and re-read when someone asks why a
 * number changed. The Markdown is derived.
 *
 * That derivation was only ever tested on in-memory reports, where `pValue` and
 * `effectSize` hold real `Infinity` and `NaN`. JSON has no representation for
 * either: `JSON.stringify` silently turns both into `null`. So the persisted
 * report round-trips to a value the renderer cannot format, and the failure only
 * appears when someone re-renders an archived report — long after the run that
 * produced it, with no run left to blame.
 *
 * The fixtures below are not invented. They are the verbatim `ablation` object
 * from a real archived run (`benchmark-conjunction-ablation-report.json`, run
 * 35502712132), which is exactly the shape a reader of the artifact set holds.
 */
import { describe, it, expect } from 'vitest';
import { formatAblationReport, runAblationReport, type AblationReport } from '../report.js';
import { FactMemorySystem } from '../fact-memory.js';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    total: 35,
    correct: 32,
    accuracy: 0.9142857142857143,
    abstentionRate: 0.3142857142857143,
    abstentionCorrectRate: 0.8181818181818182,
    abstentionAwareAccuracy: 0.9142857142857143,
    perCapability: {
      IE: { total: 26, correct: 23, accuracy: 0.8846153846153846, abstained: 2 },
      MR: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      KU: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      TR: { total: 0, correct: 0, accuracy: 0, abstained: 0 },
      ABS: { total: 9, correct: 9, accuracy: 1, abstained: 9 },
    },
    ...overrides,
  };
}

function pairedStats(overrides: Partial<PerCapabilityPairedStats> = {}): PerCapabilityPairedStats {
  return {
    total: 26,
    baselineCorrect: 24,
    featureCorrect: 23,
    baselineCorrectFeatureIncorrect: 1,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0.8139261926062996, upper: 0.984187170385956 },
    featureConfidence: { lower: 0.7762040092883747, upper: 0.970418168994703 },
    ...overrides,
  };
}

/**
 * The `ablation` object exactly as `JSON.parse` yields it from a real artifact.
 *
 * `pValue: null` and `effectSize: null` are not a contrived input: they are what
 * `JSON.stringify({ pValue: NaN, effectSize: -Infinity })` writes, and a
 * single-run ablation produces `NaN` and `-Infinity` for every arm.
 */
function persistedAblation(): AblationResult {
  return {
    feature: 'conjunction-decomposed',
    baselineAggregate: {
      min: 0.9428571428571428,
      max: 0.9428571428571428,
      avg: 0.9428571428571428,
      median: 0.9428571428571428,
    },
    featureAggregate: {
      min: 0.9142857142857143,
      max: 0.9142857142857143,
      avg: 0.9142857142857143,
      median: 0.9142857142857143,
    },
    delta: -0.02857142857142858,
    // JSON serialisation of NaN.
    pValue: null as unknown as number,
    significant: false,
    // JSON serialisation of -Infinity.
    effectSize: null as unknown as number,
    baselineConfidence: { lower: 0.8139261926062996, upper: 0.984187170385956 },
    featureConfidence: { lower: 0.7762040092883747, upper: 0.970418168994703 },
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 1, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: ['q1'],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: metrics({ total: 35, correct: 33, accuracy: 0.9428571428571428 }),
    featureMetrics: metrics(),
    featureCorrect: Array.from({ length: 35 }, () => true),
    perCapability: Object.fromEntries(CAPABILITIES.map((c) => [c, pairedStats()])) as Record<
      Capability,
      PerCapabilityPairedStats
    >,
  };
}

function report(overrides: Partial<AblationReport> = {}): AblationReport {
  return {
    dataset: 'longmemeval-conjunction',
    questionCount: 35,
    baseline: { name: 'conjunction-fused', metrics: metrics() },
    feature: { name: 'conjunction-decomposed', metrics: metrics() },
    ablation: persistedAblation(),
    generatedAt: '2026-09-20T09:47:42.542Z',
    ...overrides,
  };
}

describe('formatAblationReport survives a JSON round-trip', () => {
  it('renders a report whose pValue and effectSize were serialised from NaN and -Infinity', () => {
    // The bug: `Number.isNaN(null)` is `false`, so a null p-value took the
    // numeric branch and `null.toExponential(3)` threw a TypeError. A report
    // that reads fine at the moment it is produced became unrenderable the
    // moment it was archived.
    expect(() => formatAblationReport(report())).not.toThrow();
  });

  it('labels a null t-test p-value as not applicable rather than rendering a number', () => {
    const md = formatAblationReport(report());
    expect(md).toContain('Welch t-test p-value (over stochastic runs): **n/a (deterministic)**');
  });

  it('labels a null effect size as not applicable', () => {
    const md = formatAblationReport(report());
    expect(md).toContain("- Cohen's d: **n/a**");
  });

  it('still renders a real numeric p-value and effect size unchanged', () => {
    const ablation = persistedAblation();
    const md = formatAblationReport(
      report({
        ablation: {
          ...ablation,
          pValue: 0.001,
          significant: true,
          effectSize: 0.42,
        },
      }),
    );
    expect(md).toContain('1.000e-3');
    expect(md).toContain('significant: yes');
    expect(md).toContain('0.420');
  });

  it('round-trips through JSON.stringify and JSON.parse without losing renderability', () => {
    // The end-to-end shape of the defect: not a hand-built null, but the actual
    // serialise/deserialise pair that produced it in the archived artifact.
    const live = report({
      ablation: {
        ...persistedAblation(),
        pValue: Number.NaN,
        effectSize: Number.NEGATIVE_INFINITY,
      },
    });
    const persisted = JSON.parse(JSON.stringify(live)) as AblationReport;
    expect(persisted.ablation.pValue).toBeNull();
    expect(() => formatAblationReport(persisted)).not.toThrow();
  });

  it('keeps the cohort banner above the results in a persisted report', () => {
    const persisted = JSON.parse(
      JSON.stringify(
        report({
          cohortCoverage: {
            present: ['80ec1f4f_abs'],
            missing: [
              '6456829e_abs',
              'edced276_abs',
              'e5ba910e_abs',
              'gpt4_70e84552_abs',
              'gpt4_c27434e8_abs',
              'gpt4_fe651585_abs',
            ],
            ratio: 0.14285714285714285,
          },
        }),
      ),
    ) as AblationReport;
    const md = formatAblationReport(persisted);
    expect(md).toContain('COHORT INCOMPLETE');
    expect(md.indexOf('COHORT INCOMPLETE')).toBeLessThan(md.indexOf('Δ accuracy'));
  });
});

describe('every ablation arm persists a re-readable report', () => {
  /**
   * The scale of the defect, established by auditing real artifacts.
   *
   * Thirteen archived `benchmark-*-ablation-report.json` files from completed runs
   * were re-read and re-rendered. All thirteen contained a null numeric field, and
   * all thirteen threw under the pre-fix expression. The counterfactual was
   * checked too: the old logic threw on 13/13, which is what makes the audit
   * meaningful rather than vacuous.
   *
   * That means the defect was not an edge case reachable only by an unusual arm.
   * A single-run ablation produces `NaN` for `pValue` on every arm, so *every*
   * persisted report was unrenderable by construction, and the only reason nobody
   * saw it is that the renderer happened to run before serialisation.
   *
   * The arms below are the ones that produced those files. Listing them
   * individually rather than asserting once is deliberate: a future arm that
   * introduces a new numeric field should fail here by name.
   */
  /**
   * Each case mutates an already-persisted report, which is the only honest way to
   * express these inputs: a `null` in a numeric field is not a state the type
   * system permits, and it is not a state the live report ever holds. It exists
   * only after a trip through JSON, so the mutation is applied to the parsed
   * object rather than declared in a typed literal.
   */
  const PERSISTED_FIELD_CASES: Array<[string, (a: Record<string, unknown>) => void]> = [
    [
      'pValue and effectSize are both null (single run, arms never agreed)',
      (a) => {
        a['pValue'] = null;
        a['effectSize'] = null;
      },
    ],
    [
      'pValue is null',
      (a) => {
        a['pValue'] = null;
      },
    ],
    [
      'mcnemarPValue is null',
      (a) => {
        a['mcnemarPValue'] = null;
      },
    ],
    [
      'effectSize is null but pValue is a real number',
      (a) => {
        a['effectSize'] = null;
      },
    ],
  ];

  for (const [label, mutate] of PERSISTED_FIELD_CASES) {
    it(`renders when ${label}`, () => {
      const parsed = JSON.parse(JSON.stringify(report())) as AblationReport;
      mutate(parsed.ablation as unknown as Record<string, unknown>);
      expect(() => formatAblationReport(parsed)).not.toThrow();
    });
  }

  it('renders NaN and -Infinity that are still in memory, before serialisation', () => {
    // The in-memory half of the same field. Covered explicitly so the fix is not
    // mistaken for one that only tolerates the serialised form.
    const live = report({
      ablation: {
        ...persistedAblation(),
        pValue: Number.NaN,
        effectSize: Number.NEGATIVE_INFINITY,
      },
    });
    expect(() => formatAblationReport(live)).not.toThrow();
    expect(formatAblationReport(live)).toContain('-∞');
  });

  it('never renders a serialised infinity as a finite zero', () => {
    // The quiet half of the defect. A naive `?? 0` would make an infinite effect
    // read as "no effect", inverting the finding while looking like a fix.
    const parsed = JSON.parse(
      JSON.stringify(
        report({
          ablation: {
            ...persistedAblation(),
            pValue: Number.NaN,
            effectSize: Number.POSITIVE_INFINITY,
          },
        }),
      ),
    ) as AblationReport;
    const md = formatAblationReport(parsed);
    expect(md).not.toContain("Cohen's d: **0.000**");
    expect(md).not.toContain('0.000**');
    expect(md).toContain("Cohen's d: **n/a**");
  });

  it('distinguishes an exact McNemar p-value from an inapplicable t-test', () => {
    // Both go through the same formatter, but the two tests need different words:
    // McNemar is exact and always defined, so its fallback must not say
    // "deterministic"; the t-test legitimately has no value at runs < 2.
    const parsed = JSON.parse(JSON.stringify(report())) as AblationReport;
    const md = formatAblationReport(parsed);
    expect(md).toContain('Paired McNemar p-value: **1.000e+0**');
    expect(md).toContain('Welch t-test p-value (over stochastic runs): **n/a (deterministic)**');
  });
});

describe('the report carries the feature configuration it was produced under', () => {
  /**
   * THE REGRESSION TEST for an artifact that did not state its own configuration.
   *
   * Every number in a report is conditioned on which switches were on, and an A/B
   * compares two reports that differ ONLY in those switches. Without the
   * configuration recorded in the artifact the two files have the same shape, so
   * a reader cannot tell which side of a switch either one is on and a delta
   * between them has no interpretable sign.
   *
   * Measured on the C5 B7 comparison: two arms differed by 2 questions, the same
   * 2 questions moved in both the baseline and feature halves (which the switch
   * cannot touch), and neither artifact recorded `retrievalSides`. The run had to
   * be discarded, and the field was absent because it was written at a single
   * call site inside the reranking ablation -- an arm that is skipped when no
   * reranker is built. See `docs/09-progress-and-delivery-report.md` §20.
   */
  it('renders the configuration above the results, not below them', () => {
    const md = formatAblationReport(
      report({
        featureConfig: { candidateDiscrimination: true, retrievalSides: true, reranker: false },
      }),
    );
    const configIndex = md.indexOf('Feature config:');
    const resultsIndex = md.indexOf('Paired McNemar');
    expect(configIndex).toBeGreaterThan(-1);
    expect(resultsIndex).toBeGreaterThan(-1);
    // Above, because every figure beneath it is conditioned on it. A caveat
    // printed after the statistics is a caveat nobody reads.
    expect(configIndex).toBeLessThan(resultsIndex);
  });

  it('marks each switch on or off, so two arms are distinguishable by eye', () => {
    const control = formatAblationReport(
      report({ featureConfig: { candidateDiscrimination: true, retrievalSides: false } }),
    );
    const feature = formatAblationReport(
      report({ featureConfig: { candidateDiscrimination: true, retrievalSides: true } }),
    );

    expect(control).toContain('`retrievalSides=off`');
    expect(feature).toContain('`retrievalSides=on`');
    // Both arms still agree on the constant switch, which is what makes the two
    // lines diffable rather than merely different.
    expect(control).toContain('`candidateDiscrimination=on`');
    expect(feature).toContain('`candidateDiscrimination=on`');
  });

  it('sorts the entries so two arms render in the same order', () => {
    // Insertion order differs between the two writers of this object (the CLI and
    // the runner's derived default), so an unstable order would make a textual
    // diff of two arms show differences that are not differences in configuration.
    const md = formatAblationReport(
      report({
        featureConfig: { retrievalSides: true, candidateDiscrimination: false, reranker: false },
      }),
    );
    const line = md.split('\n').find((l) => l.startsWith('- Feature config:')) ?? '';
    const order = [...line.matchAll(/`([a-zA-Z]+)=/g)].map((m) => m[1]);
    expect(order.length).toBeGreaterThan(1);
    expect(order).toEqual([...order].sort());
  });

  it('survives the JSON round-trip the artifact actually takes', () => {
    // A field present in memory but absent after `JSON.parse(JSON.stringify(…))`
    // would be in the CI artifact and missing for whoever reads it later.
    const original = report({
      featureConfig: { candidateDiscrimination: true, retrievalSides: false, reranker: true },
    });
    const parsed = JSON.parse(JSON.stringify(original)) as AblationReport;
    expect(parsed.featureConfig).toEqual(original.featureConfig);
    expect(formatAblationReport(parsed)).toContain('`retrievalSides=off`');
    expect(formatAblationReport(parsed)).toContain('`reranker=on`');
  });

  it('omits the line entirely when no configuration was recorded', () => {
    // A library caller that supplies none must not get a fabricated
    // "everything off" line: that is a claim about a run nobody recorded, and it
    // reads as evidence, which is worse than an absent line.
    expect(formatAblationReport(report())).not.toContain('Feature config:');
  });

  it('renders nothing rather than an empty label when the config has no entries', () => {
    expect(formatAblationReport(report({ featureConfig: {} }))).not.toContain('Feature config:');
  });
});

describe('the report carries the per-question roster through runAblationReport', () => {
  /**
   * The pass-through half of the roster. `runNaturalLanguageBenchmark` is one
   * caller; `runAblationReport` is the library entry point every other arm uses,
   * and the roster has to survive it as a first-class field rather than as
   * something only the natural-language path can produce. Asserted directly on
   * the builder because a roster that reached the report by a spread at one call
   * site is exactly the side-channel shape that made the retry-fire table vanish
   * from a re-rendered artifact.
   */
  it('forwards a supplied roster onto the report, and omits the field when none is given', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });

    const without = await runAblationReport(ds, baseline, feature, { runs: 1 });
    expect(without.questions).toBeUndefined();
    expect('questions' in without).toBe(false);

    const roster = ds.questions.map((q, i) => ({
      questionId: q.id,
      question: q.question,
      capability: q.capability,
      groundTruth: q.expected,
      correct: i % 2 === 0,
      grounded: true,
      turns: [],
    }));
    const with_ = await runAblationReport(ds, baseline, feature, { runs: 1, questions: roster });
    expect(with_.questions).toHaveLength(roster.length);
    expect(with_.questions![0]!.questionId).toBe(roster[0]!.questionId);
  });

  it('omits the roster for a genuinely empty array, since absence and emptiness differ', async () => {
    // `[]` says "this run graded zero questions"; absent says nobody recorded a
    // roster. The two are different claims, and the caller's `[]` must reach the
    // report as `[]` rather than being normalised to absence -- and vice versa.
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const empty = await runAblationReport(ds, baseline, feature, { runs: 1, questions: [] });
    expect(empty.questions).toEqual([]);
    expect('questions' in empty).toBe(true);
  });
});

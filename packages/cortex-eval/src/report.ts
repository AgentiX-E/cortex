/**
 * Scientific benchmark report: runs a baseline-vs-feature ablation and produces
 * a structured report plus a Markdown rendering for CI artifacts.
 */
import type { AblationResult, BenchmarkDataset, MemorySystem, Metrics } from './types.js';
import type { CohortCoverage } from './datasets/sampling.js';
import { runAblation, type AblationOptions } from './ablation.js';
import { exactMatchScorer, type AnswerScorer } from './metrics.js';

export type AblationReport = {
  dataset: string;
  questionCount: number;
  baseline: { name: string; metrics: Metrics };
  feature: { name: string; metrics: Metrics };
  ablation: AblationResult;
  generatedAt: string;
  /**
   * Coverage of the pre-registered cohort, when the arm declares one.
   *
   * Part of the report rather than a side-channel return value because a
   * coverage shortfall changes what the numbers below it MEAN. Returning it
   * beside the report let `bench/run.ts` write the coverage to JSON while the
   * Markdown rendered a 1-of-7 cohort as an ordinary 35-question ablation, with
   * no caveat anywhere a human reader would look — the exact "same name,
   * different experiment" outcome the guard exists to prevent. Carrying it in
   * the report makes it impossible to render the results without having the
   * coverage in hand.
   *
   * Absent for arms with no cohort, which is why the banner is conditional.
   */
  cohortCoverage?: CohortCoverage | undefined;
  /**
   * Retry-fire counts for the abstention-retry arm, when the arm runs a counter.
   *
   * Carried in the report for the same reason `cohortCoverage` is: the fire count
   * is not metadata about the result, it is what makes the result interpretable.
   * This arm's published finding is a null one (accuracy unchanged), and the
   * source comment on `formatRetryFireSection` states why the counter is
   * load-bearing -- `Δ = 0.00 pp` is equally predicted by a working feature on a
   * dataset it cannot help and by a feature that was never wired in. Only the fire
   * count separates those two.
   *
   * Returning it beside the report was the same defect class as the cohort
   * coverage side channel (`docs/FIX-COHORT-COVERAGE-SIDE-CHANNEL.md`): the
   * Markdown received the section through a string concatenation at the return
   * site and the JSON through a spread at the call site, so neither the renderer
   * nor a consumer holding the report could produce the section. Re-rendering the
   * persisted artifact dropped it silently.
   */
  retryFires?: RetryFireCounts | undefined;
};

/**
 * Distinct questions on which each arm's retry actually re-queried.
 *
 * Declared here rather than imported from `runner.ts` so the report type does not
 * depend on the module that produces it -- `runner.ts` already imports from this
 * one, and closing the cycle would make the type unavailable while `report.ts` is
 * still initialising.
 */
export type RetryFireCounts = {
  controlFires: number;
  treatmentFires: number;
  questions: number;
};

export type AblationReportOptions = {
  runs?: number;
  alpha?: number;
  abstentionAware?: boolean;
  generatedAt?: string;
  scorer?: AnswerScorer;
};

export async function runAblationReport(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
  options: AblationReportOptions = {},
): Promise<AblationReport> {
  const scorer = options.scorer ?? exactMatchScorer;
  const ablationOptions: AblationOptions = { scorer };
  if (options.runs !== undefined) {
    ablationOptions.runs = options.runs;
  }
  if (options.alpha !== undefined) {
    ablationOptions.alpha = options.alpha;
  }
  if (options.abstentionAware !== undefined) {
    ablationOptions.abstentionAware = options.abstentionAware;
  }
  // The ablation already evaluates both systems once; reuse those metrics so the
  // report never re-evaluates them (which would double LLM cost and introduce
  // non-determinism between the ablation table and the per-capability section).
  const ablation = await runAblation(dataset, baseline, feature, ablationOptions);
  return {
    dataset: dataset.name,
    questionCount: dataset.questions.length,
    baseline: { name: baseline.name, metrics: ablation.baselineMetrics },
    feature: { name: feature.name, metrics: ablation.featureMetrics },
    ablation,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

export function formatAblationReport(report: AblationReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
  const ab = report.ablation;
  const lines: string[] = [
    `# Cortex Benchmark Report`,
    '',
    `- Dataset: \`${report.dataset}\` (${report.questionCount} questions)`,
    `- Generated at: ${report.generatedAt}`,
    `- Feature: \`${report.feature.name}\` vs baseline \`${report.baseline.name}\``,
  ];

  // Cohort coverage goes ABOVE the results. A caveat printed below three tables
  // of Wilson intervals is a caveat nobody reads, and the point of printing it is
  // that a short cohort changes what every number beneath it means.
  const coverage = report.cohortCoverage;
  if (coverage !== undefined) {
    const required = coverage.present.length + coverage.missing.length;
    lines.push('');
    if (coverage.missing.length > 0) {
      lines.push(
        `> **COHORT INCOMPLETE — read these numbers with care.**`,
        `>`,
        `> This arm's pre-registered predictions name ${required} specific questions. ` +
          `**${coverage.present.length}/${required} (${pct(coverage.ratio)}) are present**; ` +
          `the results below were scored on that subset and are therefore a ` +
          `**different experiment** from the pre-registered one, not a weaker version of it.`,
        `>`,
        `> Missing: ${coverage.missing.join(', ')}`,
      );
    } else {
      lines.push(
        `> **Cohort complete** — all ${required} pre-registered questions present ` +
          `(${pct(coverage.ratio)}).`,
      );
    }
  }

  lines.push(
    '',
    '## Ablation (abstention-aware accuracy)',
    '',
    '| System | min | avg | max | median |',
    '|---|---|---|---|---|',
    `| ${report.baseline.name} | ${pct(ab.baselineAggregate.min)} | ${pct(ab.baselineAggregate.avg)} | ${pct(ab.baselineAggregate.max)} | ${pct(ab.baselineAggregate.median)} |`,
    `| ${report.feature.name} | ${pct(ab.featureAggregate.min)} | ${pct(ab.featureAggregate.avg)} | ${pct(ab.featureAggregate.max)} | ${pct(ab.featureAggregate.median)} |`,
    '',
    `- Δ accuracy (feature − baseline): **${(ab.delta >= 0 ? '+' : '') + pct(ab.delta)}**`,
    `- Baseline 95% Wilson CI: **[${pct(ab.baselineConfidence.lower)}–${pct(ab.baselineConfidence.upper)}]**`,
    `- Feature 95% Wilson CI: **[${pct(ab.featureConfidence.lower)}–${pct(ab.featureConfidence.upper)}]**`,
    `- Paired McNemar p-value: **${formatPValue(ab.mcnemarPValue, 'exact')}** (significant: ${ab.mcnemarSignificant ? 'yes' : 'no'})`,
    `- Discordant pairs: baseline-correct/feature-wrong = ${ab.discordant.baselineCorrectFeatureIncorrect}, baseline-wrong/feature-correct = ${ab.discordant.baselineIncorrectFeatureCorrect}`,
    `- Welch t-test p-value (over stochastic runs): **${formatPValue(ab.pValue, 'n/a (deterministic)')}** (significant: ${ab.significant ? 'yes' : 'no'})`,
    `- Cohen's d: **${formatEffectSize(ab.effectSize)}**`,
    '',
    '## Per-capability breakdown (feature system)',
    '',
    '| Capability | Accuracy | Total |',
    '|---|---|---|',
  );
  for (const [capability, result] of Object.entries(report.feature.metrics.perCapability)) {
    lines.push(`| ${capability} | ${pct(result.accuracy)} | ${result.total} |`);
  }
  lines.push('', `- Overall accuracy: ${pct(report.feature.metrics.accuracy)}`);
  lines.push(`- Abstention rate: ${pct(report.feature.metrics.abstentionRate)}`);
  lines.push(`- Abstention correct rate: ${pct(report.feature.metrics.abstentionCorrectRate)}`);
  lines.push('', '## Per-capability paired significance (McNemar + Wilson CI)', '');
  lines.push(
    '| Capability | Total | Baseline acc | Feature acc | b✓f✗ | b✗f✓ | McNemar p | Significant |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [capability, stats] of Object.entries(ab.perCapability)) {
    if (stats.total === 0) {
      continue;
    }
    lines.push(
      `| ${capability} | ${stats.total} | ${pct(stats.baselineCorrect / stats.total)} | ${pct(stats.featureCorrect / stats.total)} | ${stats.baselineCorrectFeatureIncorrect} | ${stats.baselineIncorrectFeatureCorrect} | ${stats.mcnemarPValue.toExponential(3)} | ${stats.mcnemarSignificant ? 'yes' : 'no'} |`,
    );
  }
  // The retry-fire table goes BELOW the results, unlike the cohort banner. The
  // ordering is deliberate and the two are opposite for a reason: the banner
  // qualifies what the numbers below it mean, so it must come first; the fire
  // table is supporting evidence for a null delta, and reads as a footnote to it.
  if (report.retryFires !== undefined) {
    lines.push(...retryFireLines(report.retryFires));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The retry-fire section, as lines.
 *
 * Exported so that `formatRetryFireSection` in `runner.ts` and
 * `formatAblationReport` above render it from ONE implementation. Two renderers
 * for the same table is the defect this refactor removes: before it, the section
 * reached the Markdown by string concatenation at the call site and the JSON by a
 * spread at a different call site, so the two could disagree and a re-rendered
 * report lost the section entirely.
 *
 * The two warning branches are the reason the section exists at all. A retry
 * ablation publishes a null result by design, and a null is produced both by a
 * feature that works on a dataset it cannot help and by a feature that was never
 * wired in. The counters are what separate those readings, so an arm with a
 * misconfigured control must not be allowed to look like a clean negative finding.
 */
export function retryFireLines(fires: RetryFireCounts): string[] {
  const rate = fires.questions === 0 ? 0 : fires.treatmentFires / fires.questions;
  const lines = [
    '',
    '## Abstention-retry fires',
    '',
    '| Arm | Retry fires |',
    '|---|---|',
    `| control (\`enableAbstentionRetry: false\`) | ${fires.controlFires} |`,
    `| treatment (\`enableAbstentionRetry: true\`) | ${fires.treatmentFires} |`,
    '',
    `- Treatment fire rate: **${(rate * 100).toFixed(2)}%** of ${fires.questions} questions`,
  ];
  if (fires.controlFires !== 0) {
    lines.push(
      '',
      `- **INVALID EXPERIMENT**: the control arm fired ${fires.controlFires} times despite ` +
        '`enableAbstentionRetry: false`. The flag is not reaching the retry, so the two arms ' +
        'are not the comparison this ablation claims to make.',
    );
  } else if (fires.treatmentFires === 0) {
    lines.push(
      '',
      '- **INERT ON THIS DATASET**: the treatment arm never fired. The retry had zero ' +
        'opportunities, so the Δ accuracy above measures nothing and must not be read as ' +
        'evidence the feature does not work.',
    );
  } else if (fires.treatmentFires <= 2) {
    // The third branch exists because the middle branch was read too broadly.
    //
    // "The treatment never fired" and "the treatment fired once or twice" are not
    // the same finding, and the published result for this arm is the LATTER: a
    // single fire across the whole dataset. A fire rate this low is still an INERT
    // result -- with one opportunity the Δ accuracy can move by at most 1/N -- but
    // it is inert for a different reason, and the remedy differs.
    //
    // Zero fires means the mechanism had no opportunity and the correct next step
    // is to look for a population that produces bare abstentions. One or two fires
    // means the mechanism works and is active, but that the retry-armed population
    // is essentially disjoint from the one that fails. Collapsing the second case
    // into the first would send the next iteration hunting for a wiring bug that
    // does not exist -- which is exactly the misreading the counters are here to
    // prevent, so the renderer must not commit it itself.
    lines.push(
      '',
      `- **INERT ON THIS DATASET**: the treatment arm fired only ${fires.treatmentFires} ` +
        `time${fires.treatmentFires === 1 ? '' : 's'} across ${fires.questions} questions ` +
        `(${(rate * 100).toFixed(2)}%). The mechanism is wired and active — the control's 0 ` +
        'confirms the flag reaches the retry — but it found almost no opportunities, so the ' +
        'Δ accuracy above is bounded by ' +
        `${((fires.treatmentFires / (fires.questions === 0 ? 1 : fires.questions)) * 100).toFixed(2)} pp ` +
        'and carries no information about whether the feature helps. Do not read it as a ' +
        'negative result; read it as an under-powered one.',
    );
  }
  return lines;
}

/**
 * Render a p-value that may have been through JSON.
 *
 * `runAblation` produces `NaN` for the over-run t-test when `runs < 2`, and
 * `-Infinity`/`Infinity` for Cohen's d when the two arms never disagree. JSON has
 * no representation for either, so `JSON.stringify` writes `null` — and the
 * archived artifact, which is the durable record of a run, holds `null` where the
 * live report held a number.
 *
 * `Number.isNaN(null)` is `false`, so the original `Number.isNaN(p) ? … :
 * p.toExponential(3)` guard routed `null` into the numeric branch and threw. The
 * report rendered correctly at the moment it was produced and became unrenderable
 * once archived, which is the worst possible ordering: the failure surfaces long
 * after the run, when the only remaining copy is the one that cannot be read.
 *
 * `null` is checked explicitly rather than with `p == null` matching both, because
 * `undefined` means a malformed object and `null` means "JSON had no number here";
 * both are unrenderable, so both take the fallback, but the reason is the same and
 * the check reads as one condition.
 */
function formatPValue(p: number | null, fallback: string): string {
  if (p === null || Number.isNaN(p)) {
    return fallback;
  }
  return p.toExponential(3);
}

/**
 * Format Cohen's d, including the infinities JSON cannot carry.
 *
 * A `null` here is a serialised infinity, which is a *real, meaningful* result —
 * it means the two arms differed on every question — so it must render as `n/a`
 * and never as `0.000`, which would read as "no effect" and invert the finding.
 */
function formatEffectSize(d: number | null): string {
  if (d === null) {
    return 'n/a';
  }
  if (d === Infinity) {
    return '+∞';
  }
  if (d === -Infinity) {
    return '-∞';
  }
  return d.toFixed(3);
}

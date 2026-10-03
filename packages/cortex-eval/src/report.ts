/**
 * Scientific benchmark report: runs a baseline-vs-feature ablation and produces
 * a structured report plus a Markdown rendering for CI artifacts.
 */
import type { AblationResult, BenchmarkDataset, MemorySystem, Metrics } from './types.js';
import type { CohortCoverage } from './datasets/sampling.js';
import type { QuestionRecord } from './question-record.js';
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
  /**
   * The switches this run was configured with, recorded in the report itself.
   *
   * Every number in the report is conditioned on this object, and without it the
   * same artifact is produced by both arms of an A/B -- so a reader holding only
   * the file cannot tell whether the feature was on, off, or inert. That was not
   * hypothetical: the C5 B7 comparison downloaded two artifacts that differed by
   * 2 questions, and neither one said which side of `retrievalSides` it was on.
   * The delta's sign was therefore uninterpretable, and the run had to be
   * discarded (`docs/09-progress-and-delivery-report.md` §20).
   *
   * It was previously written at a single call site, inside the reranking
   * ablation. That arm is guarded on the reranker existing, so a run without a
   * reranker lost the record of its configuration entirely -- and the ablation
   * itself was silently skipped when the enable flag was given a provider name
   * (`rerank=local`), which is how the C5 artifacts came to have no such field.
   * Carrying it in the report type makes the record a property of the report
   * rather than of one branch that happens to run.
   */
  featureConfig?: FeatureConfig | undefined;
  /**
   * The per-question records this report was computed from, one per graded
   * question, in dataset order.
   *
   * This is the field three separate readers were blocked on, and the reason it
   * belongs in the report rather than beside it is the same reason
   * `cohortCoverage` does -- except stronger, because unlike a coverage caveat
   * this array is the only copy of the evidence:
   *
   * 1. `tools/read-b7-criterion.mjs` needs it to recompute the target roster and
   *    apply the three clauses. Absent, the reader fails with "no per-question
   *    array found" and the pre-registered criterion cannot be executed at all.
   * 2. `compareQuestionVectors` needs two aligned correctness vectors to measure
   *    how far the endpoint moves on its own. `variance.ts` was written for
   *    exactly this and had no real caller, because the artifacts carried counts
   *    and discordant ids but never a roster.
   * 3. A reader asking *which* questions moved needs the ids. A count is not a
   *    roster: §20 records an A/B whose two arms differed by two questions and
   *    whose artifacts could not name them.
   *
   * Absent rather than empty when a caller does not supply it. `[]` would say
   * "this run graded zero questions", which is a claim; absence says nobody
   * recorded a roster, which is the truth for an arm that predates this field.
   * The distinction is the same one the retry-fire counters draw between `null`
   * and `0`.
   */
  questions?: readonly QuestionRecord[] | undefined;
  /**
   * The candidate-annotation schema version this run rendered with, or `0` when
   * the annotation was not applied.
   *
   * `CANDIDATE_ANNOTATION_VERSION` states its own contract: "two revisions that
   * render the same context must be indistinguishable, so this is a schema version
   * rather than a library version." The constant was exported and read by nothing,
   * so no rendered context and no report carried the value, and the guarantee was
   * unverifiable by construction — two artifacts produced by different annotation
   * revisions were indistinguishable in exactly the way the docstring forbids.
   *
   * Carried in the report for the same reason `cohortCoverage` and `retryFires`
   * are: it is not metadata about the result, it is what makes the result
   * interpretable. An arm that ran with the annotation and an arm that did not can
   * produce the same accuracy, and only this field separates them.
   *
   * `0` rather than absent when the annotation was off, because "off" is a
   * statement about this run and absence is a statement about this artifact's age.
   * Absent means the run predates the field.
   */
  candidateAnnotationVersion?: number | undefined;
  /**
   * The `cortex-memory` arm's gate configuration, when that arm produced this
   * report.
   *
   * Present exactly when the cross-system arm ran, so its absence is itself the
   * statement "this artifact was produced by a different arm" — which is what a
   * reader comparing the reference pipeline's report against the cognitive layer's
   * needs in order to know the comparison is valid.
   */
  memoryArmConfig?: MemoryArmConfig | undefined;
};

/**
 * The feature switches a benchmark run was configured with.
 *
 * Open-ended by key so a new switch is recorded by adding to the object rather
 * than to a type and a renderer. The values are booleans because every switch
 * here is one: a flag that is only meaningful in combination (as
 * `retrievalSides` is without `candidateDiscrimination`) needs both entries
 * present, which the object shape gives naturally.
 *
 * `false` must be recorded, not omitted: a report that lists only the enabled
 * features cannot distinguish "this switch was off" from "this run predates the
 * switch", and those are different claims about the same file.
 */
export type FeatureConfig = Readonly<Record<string, boolean>>;

/**
 * The `cortex-memory` arm's numeric gate configuration.
 *
 * A separate field rather than more entries in `FeatureConfig`, because that type
 * is `Record<string, boolean>` and its renderer writes `` k=on ``/`` k=off ``.
 * `threshold` and `sessionBudget` are numbers, and a boolean projection of them
 * would destroy the value the reader needs: "the threshold was on" is true of every
 * threshold, including the one that admits nothing.
 *
 * Widening `FeatureConfig` to `boolean | number` was the alternative. It was
 * rejected because its renderer would have to start formatting mixed types, which
 * changes the feature-config line of **every** existing artifact, and because a
 * union type would make the boolean arms' `=== true` reads no longer exhaustive.
 * The narrower change is this field, which only the arm that needs it emits.
 *
 * Carried in the report rather than returned beside it for the reason
 * `cohortCoverage` (this file, above) and `retryFires` record at length: a value
 * that reaches the JSON through a spread at the call site and the Markdown through
 * a string concatenation is a value whose renderer can drop it silently. Here it
 * would be worse than a dropped caveat — the numbers ARE the configuration, so an
 * artifact without them cannot be compared against another artifact at all.
 *
 * Absent rather than defaulted for a run that is not this arm. `threshold: 0` is a
 * real configuration ("gates open"), so a defaulted object would make "this arm did
 * not run" indistinguishable from "this arm ran with the identity gate".
 */
export type MemoryArmConfig = {
  /** Admission threshold handed to `decideWrite`. In `[0, 1]`. */
  readonly threshold: number;
  /**
   * Turn budget across all presented sessions.
   *
   * `null` rather than `Infinity` when unbounded, because `Infinity` is not
   * representable in JSON: `JSON.stringify` writes it as `null` anyway, so the
   * round-tripped artifact would carry `null` while the in-memory report carried
   * `Infinity`, and a comparison between a live report and a re-read one would
   * disagree. Stating `null` up front makes the persisted form the only form.
   */
  readonly sessionBudget: number | null;
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
  featureConfig?: FeatureConfig;
  /**
   * Per-question records for the graded set, in dataset order.
   *
   * Passed in rather than built here because building them needs the retrieval
   * context the systems saw and the scorer's per-question verdicts, and this
   * module's only view of a run is the aggregate `AblationResult`. The runner
   * holds both, so it assembles the records and this function carries them.
   */
  questions?: readonly QuestionRecord[];
  /** The `cortex-memory` arm's gate configuration, when it produced this report. */
  memoryArmConfig?: MemoryArmConfig;
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
    ...(options.featureConfig === undefined ? {} : { featureConfig: options.featureConfig }),
    ...(options.questions === undefined ? {} : { questions: options.questions }),
    ...(options.memoryArmConfig === undefined ? {} : { memoryArmConfig: options.memoryArmConfig }),
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

  // The configuration goes above the results, with the cohort banner and for the
  // same reason: it is what the numbers below are conditioned on. Rendered as a
  // single line so a reader comparing two arms can diff it visually, and written
  // sorted so the two arms' lines differ only where the switch does.
  const config = report.featureConfig;
  if (config !== undefined) {
    const entries = Object.entries(config).sort(([a], [b]) => (a < b ? -1 : 1));
    if (entries.length > 0) {
      lines.push(
        `- Feature config: ${entries.map(([k, v]) => `\`${k}=${v ? 'on' : 'off'}\``).join(', ')}`,
      );
    }
  }

  // The cross-system arm's numeric configuration. Rendered next to the boolean
  // switches and for the same reason, but separately because it carries values
  // rather than flags: `threshold=0.35` is not expressible as `on`/`off`, and the
  // reader's question -- "how much evidence did the gate demand before admitting a
  // turn" -- is answered by the number and by nothing else. An arm whose artifact
  // omits it produces a delta that cannot be compared against another arm's.
  const memoryArm = report.memoryArmConfig;
  if (memoryArm !== undefined) {
    lines.push(
      `- Memory arm config: \`threshold=${memoryArm.threshold}\`` +
        `, \`sessionBudget=${memoryArm.sessionBudget === null ? 'unbounded' : memoryArm.sessionBudget}\``,
    );
  }

  // The annotation version goes with the configuration, for the same reason: it
  // is a property of how the run was set up, not of its outcome, and it changes
  // what a comparison between two artifacts means.
  //
  // Rendered explicitly as "not applied" when zero rather than omitted. The
  // reader's question is "was the candidate annotation on, and at which revision",
  // and an absent line answers neither half. The line is only omitted when the
  // field itself is absent, which marks an artifact older than the field.
  const annotationVersion = report.candidateAnnotationVersion;
  if (annotationVersion !== undefined) {
    lines.push(
      `- Annotation version: ` +
        (annotationVersion === 0
          ? '`not applied`'
          : `\`${annotationVersion}\` (candidate labels were rendered this run)`),
    );
  }

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
  // The identity of the discordant pairs is printed directly beneath the table
  // whose counts it explains. A count tells a reader how many questions moved; it
  // does not tell them whether the arm's *target* population was among them, and
  // that is the question the conjunction arm needed answered -- four flips, all
  // in IE, while ABS never moved. A reader who wants to check a per-capability
  // count against the underlying questions should not have to open the JSON.
  //
  // `(none)` rather than `0`: an empty list is a measured absence, and writing
  // `0` alongside a count of `0` would make "nothing moved" and "nothing was
  // recorded" render identically -- the same distinction the fallback counters
  // draw between `null` and `0`.
  lines.push('', '### Discordant questions (identity)', '');
  const regression = ab.discordantQuestions.baselineCorrectFeatureIncorrect;
  const gain = ab.discordantQuestions.baselineIncorrectFeatureCorrect;
  lines.push(
    `- Baseline-correct/feature-wrong (${regression.length}): ${regression.length > 0 ? regression.join(', ') : '(none)'}`,
    `- Baseline-wrong/feature-correct (${gain.length}): ${gain.length > 0 ? gain.join(', ') : '(none)'}`,
  );
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

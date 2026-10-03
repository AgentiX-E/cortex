/**
 * The cross-system arm: `cortex-memory` against the reference pipeline.
 *
 * ## What this module is, and what it deliberately is not
 *
 * `AUDIT-CODE-VS-DOCS.md` §6.2 step 3 asks for "a benchmark arm that supplies
 * `cortex-memory` instead of the reference pipeline", verified by a "paired
 * same-instant A/B against the reference arm". This module is the assembly half of
 * that arm. It is **not** the construction half.
 *
 * Every other arm in this package builds both of its own systems from options
 * (`runRerankAblation` is the template: two `NaturalLanguageMemorySystem`
 * instances, one carrying the feature flags). This arm cannot, because its two
 * sides live in different packages: the baseline is `cortex-eval`'s own reference
 * pipeline and the feature is `cortex-memory`'s `CortexMemory`. So the arm takes
 * **both systems already constructed** and owns only what happens next.
 *
 * ## Why the injection boundary is load-bearing rather than stylistic
 *
 * `cortex-eval` is the measurement instrument. Its `package.json` depends on
 * `cortex-core` and `cortex-llm` and on nothing in the product layer, and
 * `AUDIT-EVAL-CONTRACTS.md` §2 relies on that when it records the edge to
 * `cortex-memory` as "type-only ... and acyclic". Importing `CortexMemory` here to
 * build it inline would reverse that: the harness would depend on the thing it
 * measures, and a change to the product could not be evaluated without rebuilding
 * the instrument. The last test in the arm's suite asserts this boundary rather
 * than trusting it.
 *
 * The alternative considered was a new `cortex-bench` package depending on both,
 * which is architecturally cleaner and costs moving a 1051-line CLI plus a full
 * toolchain. Recorded in `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §4.
 *
 * ## Why the wiring cannot live in `bench/run.ts`
 *
 * `bench-arm-options.ts` already paid for this lesson and wrote it down: the CLI is
 * excluded from coverage as an entry point, so the spread carrying the B7 toggle
 * into the arm was, from the suite's point of view, unreachable code -- "deleting
 * it, defaulting it on, or reading the wrong environment variable each left every
 * test green -- because no test could import the file the line lived in."
 *
 * The wiring therefore lives here, in `src/**`, which is inside
 * `coverage.include`. What stays in the CLI is the part that has no decision in
 * it: construct two systems, hand them over, write the file.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { readToggle } from './env-toggle.js';
import type { AblationReport, MemoryArmConfig } from './report.js';
import { formatAblationReport, runAblationReport, type FeatureConfig } from './report.js';
import type { AnswerScorer } from './metrics.js';
import {
  deserializeEmbeddingCache,
  mergeEmbeddingCache,
  serializeEmbeddingCache,
  snapshotEmbeddingCache,
} from './retrieval.js';
import type { BenchmarkDataset, MemorySystem } from './types.js';

/** The environment variables this arm reads. A subset of `process.env`. */
export type CortexMemoryArmEnv = Readonly<Record<string, string | undefined>>;

/**
 * The arm's parsed configuration.
 *
 * `enabled` is separate from the numeric knobs on purpose. An unset environment
 * means "this measurement was not requested", and a run that is not this arm must
 * not fail because an unrelated variable holds a typo. So the numeric guards run
 * only when the arm is on, and `enabled: false` carries defaults that are never
 * used.
 */
export type CortexMemoryArmOptions = {
  /** True only when `CORTEX_MEMORY` is the strict string `'1'`. */
  enabled: boolean;
  /** Admission threshold handed to `decideWrite`. In `[0, 1]`. */
  threshold: number;
  /** Turn budget across all presented sessions. A positive integer, or unbounded. */
  sessionBudget: number;
};

const THRESHOLD_VARIABLE = 'CORTEX_MEMORY_THRESHOLD';
const BUDGET_VARIABLE = 'CORTEX_MEMORY_SESSION_BUDGET';

/**
 * Parses the arm's configuration out of the environment.
 *
 * The numeric guards are strict because both variables have a failure mode that
 * a satisfied type system cannot see:
 *
 *  - `decideWrite` admits on `>=` against a value bounded by
 *    `confidence * sourceTrust * (0.5 + 0.5 * recency)` with `recency < 1`
 *    strictly. So a threshold above `1` admits nothing and a threshold below `0`
 *    admits everything, and both are what a percent typed as `85` instead of
 *    `0.85` produces. Either way the run completes and the number is a fact about
 *    the typo.
 *  - `Number('abc')` is `NaN`, and `NaN >= x` is false for every `x`, so a
 *    non-numeric threshold admits nothing while every type in the program holds.
 *  - `selectSessionBudget` returns `[]` for `budget <= 0`, so a negative budget
 *    abstains on every question for a reason no artifact records. A fractional
 *    budget is meaningless because the unit is turns.
 *
 * The defaults are the **identity configuration**: threshold `0` opens the gates
 * (every turn is admitted), and an unbounded budget presents every session. That
 * is the honest first measurement -- "does composing the cognitive layer move
 * anything at all" -- with the gate knobs left out of it.
 */
export function cortextMemoryArmOptions(env: CortexMemoryArmEnv): CortexMemoryArmOptions {
  const enabled = readToggle(env, 'CORTEX_MEMORY');
  if (!enabled) {
    return { enabled: false, threshold: 0, sessionBudget: Number.POSITIVE_INFINITY };
  }
  return {
    enabled: true,
    threshold: readThreshold(env[THRESHOLD_VARIABLE]),
    sessionBudget: readSessionBudget(env[BUDGET_VARIABLE]),
  };
}

/**
 * The number a variable holds, or `undefined` when it holds no configuration.
 *
 * `''` and whitespace both collapse to `undefined` because that is what an
 * unfilled `workflow_dispatch` input actually is. GitHub writes the empty string
 * into the environment rather than omitting the variable, and `Number('')` is `0`
 * -- so the "not configured" case would arrive as a perfectly valid zero.
 *
 * For the threshold that accident lands on the intended default, which is the more
 * dangerous kind of bug: it passes review because the number is right. For the
 * session budget it lands on `0` turns, which is the exact value the guard below
 * was written to reject, and it is not rejected because the guard tests `< 0`.
 *
 * The blank check is `trim() === ''` rather than a falsy test, so an explicit `'0'`
 * stays reachable. Turning "unset" into "the default" by making a real zero
 * unexpressible would be the same defect mirrored.
 */
function readNumeric(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return Number(raw);
}

function readThreshold(raw: string | undefined): number {
  const value = readNumeric(raw);
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `${THRESHOLD_VARIABLE} must be a number in [0, 1], got ${JSON.stringify(raw)}. ` +
        'DecideWrite admits on >= against a value bounded by 1, so a threshold above 1 ' +
        'admits nothing, a threshold below 0 admits everything, and NaN admits nothing — ' +
        'each of which completes a full run whose result describes the typo.',
    );
  }
  return value;
}

function readSessionBudget(raw: string | undefined): number {
  const value = readNumeric(raw);
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${BUDGET_VARIABLE} must be a non-negative integer or unset, got ${JSON.stringify(raw)}. ` +
        'The unit is turns, and selectSessionBudget returns [] for a budget <= 0 — which ' +
        'abstains on every question for a reason no artifact records.',
    );
  }
  return value;
}

/**
 * Projects the parsed options onto the persisted report field.
 *
 * `Infinity` becomes `null`, and the conversion happens here rather than at
 * `JSON.stringify` time. `JSON.stringify(Infinity)` is `null`, so an artifact that
 * carried `Infinity` in memory would be re-read as `null` while a comparison made
 * in the same process still saw `Infinity` — the persisted form and the live form
 * would disagree, and only one of them is what a reader downloads. Stating `null`
 * on the way in makes the persisted form the only form.
 */
export function toMemoryArmConfig(options: CortexMemoryArmOptions): MemoryArmConfig {
  return {
    threshold: options.threshold,
    sessionBudget: Number.isFinite(options.sessionBudget) ? options.sessionBudget : null,
  };
}

/**
 * Resolve the embedding-cache path the arm should use, treating blank as absent.
 *
 * `undefined` and `''` are collapsed into one answer deliberately. GitHub passes
 * an unfilled `workflow_dispatch` input as the empty string rather than as an
 * absent variable, and for a PATH the difference is not cosmetic: `''` resolves
 * to the working directory, so a write to `''` is a failed stat on a directory
 * and a write to `''` under a different cwd is a stray file nobody looks for. The
 * read side has the mirror problem — `existsSync('')` is false, so a blank value
 * silently disables the restore, which is the defect this module was written to
 * close. Collapsing both spellings of "not configured" into `undefined` makes the
 * behaviour independent of which one the caller happened to hand over.
 *
 * `firstNonEmpty` in `embedding-factory.ts` draws the same line for credentials
 * and `readToggle` draws it for switches; this is the same rule applied to a path.
 */
export function cortexMemoryArmEmbeddingCachePath(env: CortexMemoryArmEnv): string | undefined {
  const raw = env['EMBEDDING_CACHE_PATH'];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw;
}

/**
 * Restore a persisted embedding cache into the process-wide cache the retrieval
 * functions read, and report how many vectors were absorbed.
 *
 * Returns a COUNT rather than nothing, and returns `0` rather than throwing, for
 * a reason specific to what this arm is: it exists to produce a report, and a
 * cache it cannot read is not a reason to fail — re-embedding is the recovery
 * path, not a failure mode. `deserializeEmbeddingCache` throws on a corrupt or
 * incompatible buffer on purpose (a stale cache must never be silently trusted),
 * so the decision to swallow that here has to live somewhere, and `cortex-eval`
 * rather than the excluded CLI is where a decision can be tested.
 *
 * The count is what makes the restore observable. A silent restore that in fact
 * did nothing is indistinguishable from a working one in every downstream number:
 * both produce a valid report, and the difference between them is a few cents of
 * embedding quota and a `429`. Recording the number lets the entry point say
 * `Restored N embedding vectors` — the same line `bench/run.ts` logs — so a run
 * whose cache did not load says `0` in its own log.
 *
 * `mergeEmbeddingCache` is what does the work, and its direction is load-bearing:
 * entries already present win, so a stale file can never override a vector this
 * process computed. Without that, an arm that restored at the wrong moment would
 * grade its two sides against inconsistent evidence.
 */
export function restoreArmEmbeddingCache(path: string | undefined): number {
  // The blank check is repeated here rather than left to the caller. These two
  // functions accept a `string | undefined`, not a parsed environment, so a
  // caller may hand over the raw variable. Every other "not configured" spelling
  // was already collapsed by `cortexMemoryArmEmbeddingCachePath`, and `''` is not
  // a path on any filesystem -- `readFileSync('')` throws ENOENT, which would
  // make this return the right number for the wrong reason.
  if (path === undefined || path.trim() === '') {
    return 0;
  }
  try {
    const persisted = deserializeEmbeddingCache(readFileSync(path));
    mergeEmbeddingCache(persisted);
    return persisted.size;
  } catch {
    // Deliberately both catch and read: `readFileSync` throws ENOENT for an
    // absent file and `deserializeEmbeddingCache` throws for a foreign one, and
    // both mean the same thing to this arm -- "start from an empty cache".
    return 0;
  }
}

/**
 * Persist the process-wide embedding cache so a later run can skip the provider.
 *
 * Writing even when the cache is EMPTY is the intended behaviour, not an
 * oversight. Skipping the write would leave the previous run's file in place, and
 * the next run would restore vectors for haystack turns this run never saw —
 * silently grading against another dataset's evidence. An empty file is a true
 * statement ("this run embedded nothing"); a stale file is a false one.
 *
 * Symmetric with `restoreArmEmbeddingCache`, including the blank-path rule: an
 * unconfigured path is a no-op rather than a write to `''`.
 */
export function persistArmEmbeddingCache(path: string | undefined): void {
  if (path === undefined || path.trim() === '') {
    return;
  }
  writeFileSync(path, serializeEmbeddingCache(snapshotEmbeddingCache()));
}

/** Options for {@link runCortexMemoryArm}. */
export type CortexMemoryArmRunOptions = {
  /** Independent runs handed to the ablation. Defaults to the ablation's own default. */
  runs?: number;
  /** Significance threshold. Defaults to the ablation's own default. */
  alpha?: number;
  /** Answer scorer. Required in practice: the arm is meaningless without one. */
  scorer?: AnswerScorer;
  /** Fixed timestamp, so a report is reproducible. */
  generatedAt?: string;
  /**
   * The switches this run was configured with.
   *
   * Recorded in the report rather than only logged, for §20's reason: two
   * downloaded artifacts differed by 2 questions and neither said which side of the
   * switch it was on, so the delta's sign was uninterpretable and the run was
   * discarded.
   */
  featureConfig?: FeatureConfig;
  /**
   * The arm's own gate configuration.
   *
   * Required, and required rather than optional on purpose: this arm's entire
   * result is conditioned on it, and a caller that forgets it produces an artifact
   * whose numbers cannot be compared against another arm's. Making it required
   * means the omission is a type error at the call site rather than a silently
   * thinner report. The `rerankArmOptions` precedent (`bench-arm-options.ts`) is
   * the same judgement: its B7 field is required so "adding a new caller cannot
   * silently omit it and run the control configuration while believing it enabled
   * the feature."
   */
  memoryArmConfig: MemoryArmConfig;
};

/** What the arm returns: the report, its Markdown, and the delta it measured. */
export type CortexMemoryArmResult = {
  report: AblationReport;
  markdown: string;
  /** Feature accuracy minus baseline accuracy, abstention-aware. */
  delta: number;
};

/**
 * Runs the paired same-instant A/B and returns an attributable artifact.
 *
 * ## The pairing invariant
 *
 * Both sides go through **one** `runAblationReport` call, which evaluates them once
 * each and reuses those metrics for the report tables. That is what makes the pair
 * simultaneous. Two separate `runBenchmark` calls would be a staggered comparison,
 * and `SOTA-BASELINE.md` §6 measures time-of-day drift at 1.7-2.1pp -- larger than
 * most effects this arm could plausibly find. The arm's suite asserts the call
 * shape, because the violation is a property of the call graph and no value in the
 * result exposes it.
 *
 * ## The two guards, and why they reject rather than warn
 *
 * A mis-assembled arm does not fail; it produces a plausible number. Two
 * misassemblies are checkable from the arguments, so they are checked:
 *
 *  - **Identical sides.** Passing the same system twice yields `Δ = 0.00pp`, which
 *    is the same artifact a genuinely-null result produces. §13 recorded exactly
 *    this: two byte-identical arms and a verdict that described the dispatch rather
 *    than the feature. Identity is cheap to test, so the tuple is rejected.
 *  - **Empty dataset.** `wilsonScoreInterval(0, 0)` and a McNemar over no
 *    discordant pairs both return confident-looking values, so a run that graded
 *    nothing would publish an interval over nothing.
 */
export async function runCortexMemoryArm(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
  options: CortexMemoryArmRunOptions,
): Promise<CortexMemoryArmResult> {
  if (baseline === feature) {
    throw new Error(
      'the arm was handed the same system object for both sides, so the delta would be ' +
        '0.00pp by construction — the artifact would read "the feature does not help" when ' +
        'no feature was supplied. See docs/09-progress-and-delivery-report.md §13.',
    );
  }
  if (dataset.questions.length === 0) {
    throw new Error(
      'the arm was handed a dataset with no questions, so every interval below would be ' +
        'computed over an empty denominator',
    );
  }

  const report = await runAblationReport(dataset, baseline, feature, {
    ...(options.runs === undefined ? {} : { runs: options.runs }),
    ...(options.alpha === undefined ? {} : { alpha: options.alpha }),
    ...(options.scorer === undefined ? {} : { scorer: options.scorer }),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    ...(options.featureConfig === undefined ? {} : { featureConfig: options.featureConfig }),
    memoryArmConfig: options.memoryArmConfig,
  });

  return {
    report,
    markdown: formatAblationReport(report),
    // Read from the ablation's own aggregate rather than recomputed here, so the
    // returned value cannot disagree with the tables rendered beside it.
    delta: report.ablation.delta,
  };
}

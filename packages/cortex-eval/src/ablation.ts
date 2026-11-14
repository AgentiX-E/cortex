/**
 * Ablation framework: run a baseline system and a feature system, aggregate their
 * accuracies, and compare them with scientifically valid tests.
 *
 * - Wilson 95% intervals quantify finite-sample accuracy uncertainty.
 * - The exact paired McNemar test compares the two systems on the SAME questions,
 *   which is valid even for a single deterministic evaluation.
 * - A Welch t-test + Cohen's d is reported only when repeated runs actually
 *   introduce sampling variance (stochastic temperature), because a t-test over
 *   identical deterministic repeats is undefined.
 */
import { retryStats } from '@agentix-e/cortex-ai';
import { stddev, wilsonScoreInterval } from '@agentix-e/cortex-core';
import type {
  AblationResult,
  Answer,
  CompletedPass,
  BenchmarkDataset,
  Capability,
  CountSpread,
  MemorySystem,
  PartialAblation,
  PerCapabilityPairedStats,
} from './types.js';
import { classifyTransitions } from './answer-transition.js';
import {
  evaluateWithScorerDetailed,
  type BenchmarkWorkerPool,
  type RetrievalCaptureVectors,
} from './benchmark.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import { correctnessMask } from './question-record.js';
import { transportRetryReport } from './retrieval-diagnostics.js';
import {
  aggregate,
  cohensD,
  exactMatchScorer,
  mcnemarPValue,
  tTestPValue,
  type AnswerScorer,
  type ScoredEvaluation,
} from './metrics.js';

const ALL_CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/**
 * Attach what was measured to the error that ended the run, and rethrow it.
 *
 * ## Why the measurement is attached rather than returned
 *
 * An ablation that did not finish must not RESOLVE. A caller cannot tell a
 * returned partial from a complete result by looking at it, and the number that
 * would be fabricated is `delta` -- which is `featureAggregate.avg -
 * baselineAggregate.avg` over the same index vector, so with one side short it is
 * meaningful arithmetic over data that was never paired. `variance.ts` throws to
 * prevent exactly that one layer down.
 *
 * ## Why it is attached rather than logged
 *
 * Run `37942775447` graded for ~40 minutes and left nothing: the answers lived in
 * `runBenchmark`'s local array, which the stack unwound. A log line would have the
 * same problem in a different medium -- it survives only if someone reads it, and
 * the artifact is what a later run reads. Attaching the vectors to the error puts
 * them in the caller's hands at the only moment they exist.
 *
 * ## Why the original error is preserved
 *
 * The cause that brought us here is a transport error, and its stack is the only
 * evidence in the record that the loss was infrastructure rather than a defect in
 * the arm (§13.11.7). Wrapping it in a new `Error` would replace that stack with
 * one that says "the ablation failed", which is already known. So the field is set
 * on the original and the original is rethrown -- a mutation, deliberately, since
 * the alternative is losing the thing the diagnostic exists for.
 *
 * ## The no-measurement case
 *
 * Only when nothing at all was measured is nothing attached, and `run` is part of that
 * question rather than a detail of the record. The repetitions are sequential, so a
 * repetition ordinal above zero means every earlier repetition completed on both sides:
 * a partial at `run: 1` with two empty vectors states that repetition 1 died before it
 * measured anything, which is a real measurement record. At `run: 0` there is nothing
 * before it, and a partial of two empty vectors is then the same bytes as a broken
 * capture -- the `null` vs `''` distinction the evidence capture keeps one layer up --
 * so that is the case that attaches nothing.
 *
 * The predicate is not `reached === 0` either, and for the same reason one repetition in:
 * `reached` counts the side that was RUNNING when the error surfaced, so a feature-side
 * death at question 0 leaves `reached: 0` and a COMPLETE baseline, and discarding the
 * baseline then would throw away the half of the measurement that finished.
 *
 * ## Why the transport counters are read HERE rather than by each caller
 *
 * A partial is written on a failure, and the failure that matters to a five-hour dispatch is
 * the one this campaign finally measured: a `429` that outlived the retry ladder
 * (`13.216`, run `41346610318`). What the counters say at that moment -- how many attempts the
 * provider rejected, how many calls retried -- is the number that decides whether the next
 * dispatch is affordable, and it is only available while the process is alive. Reading it in
 * this one funnel means no call site can forget it, which is the same argument that put
 * `attachPartial` here rather than in `bench/run-ablation.ts`.
 *
 * This makes the function impure, and that is the trade: it is called exactly once per run, at
 * the moment of failure, and "what the transport saw by then" is a property of that moment
 * rather than of the arguments. A pure signature would require every caller to snapshot the
 * aggregate before the throw, which cannot be done -- the throw is the event.
 */
function attachPartial(error: unknown, partial: PartialAblation): unknown {
  const measuredNothing =
    partial.run === 0 &&
    partial.reached === 0 &&
    partial.baselineAnswers.length === 0 &&
    partial.completed.length === 0;
  if (measuredNothing) return error;
  if (error !== null && typeof error === 'object') {
    (error as { partial?: PartialAblation }).partial = {
      ...partial,
      transportRetry: transportRetryReport(retryStats(), { provider: 'run' }),
    };
  }
  return error;
}

function emptyPairedStats(): PerCapabilityPairedStats {
  return {
    total: 0,
    baselineCorrect: 0,
    featureCorrect: 0,
    baselineCorrectFeatureIncorrect: 0,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0, upper: 1 },
    featureConfidence: { lower: 0, upper: 1 },
  };
}

export type AblationOptions = {
  /** Number of independent runs per system (default 3). */
  runs?: number;
  /** Significance threshold (default 0.05). */
  alpha?: number;
  /** Use abstention-aware accuracy as the comparison metric (default true). */
  abstentionAware?: boolean;
  /** Answer scorer; defaults to exact match. */
  scorer?: AnswerScorer;
  /**
   * Optional per-question progress sink, forwarded to every evaluation.
   *
   * Each event carries the side (`system`) and the repetition (`run`), because an
   * ablation runs the baseline in full, then the feature in full, then both again
   * for each additional run -- so a record without either is ambiguous. The
   * failure this exists to localise is a mid-run one: run `37281155088`'s arm died
   * on the feature side after ~52 minutes and its log named no question and no
   * side. See `BenchmarkProgress`.
   */
  onProgress?: BenchmarkProgressCallback;
  /**
   * Wall-clock ceiling for the **whole ablation**, in milliseconds. Absent means no ceiling.
   *
   * ## Why the unit is the run and not a pass
   *
   * It used to be a pass, and the argument was that a pass is where a hang happens (run
   * `38725510400` spent over five hours inside one question and never ended). That argument is
   * right about hangs and wrong about budgets, because a ceiling on one pass is multiplied by the
   * number of passes: one dispatch is `2 arms x 4 repetitions = 8` passes, so the workflow's
   * `CORTEX_MEMORY_BUDGET_MINUTES: 90` permitted **721 minutes** of run inside a job killed at
   * **350**. Run `41259622431` finished at 334.8 minutes with 15 to spare, and no artifact recorded
   * that margin — a run that exceeds it next time dies with no `benchmark-error.log` and no report,
   * which is precisely the failure this option was added to prevent.
   *
   * `tools/job-budget.py` computes the two ceilings from a workflow file and reports whether the
   * inner one can fire at all; for this repository's shape it cannot (`8 x 90 + 1 = 721`, 2.06x the
   * job), so the protection was decorative.
   *
   * ## What still bounds a hang
   *
   * The per-attempt timeout in `cortex-ai`, which is the layer that can see a single request. A
   * per-run deadline does not replace it: it bounds the total, and a hang inside one call is
   * still that layer's to interrupt. What the deadline adds is that **the run ends with a record**
   * — the last pass to start gets what is left, `evaluateWithScorerDetailed` throws
   * `BenchmarkBudgetExceeded` from between two questions, and the existing `catch` writes the
   * partial artifact.
   *
   * ## Why the dispatch value is still generous
   *
   * A healthy eight-pass run measured 122.6 minutes with the reader's thinking disabled and 305.9
   * with it enabled on three routes, so a ceiling that fires on a *slow but working* run destroys
   * the measurement it was meant to protect (§13.28). The value has to sit above the upper end of
   * the observed distribution and below the job's own timeout, and the gap between those two is
   * thinner than it looks: see `AUDIT-MODEL-PORTABILITY.md` §9.5 and `tools/job-budget.py`.
   */
  budgetMs?: number | undefined;
  /**
   * Workers in flight, and the per-worker instances that answer their questions.
   *
   * ## Why factories rather than instances
   *
   * A `MemorySystem` carries per-question state in single slots -- `lastRawOutput`,
   * `lastRetrievedContext`, `lastPromptText`, and the arm's own census delta -- which
   * `runBenchmark` reads after the call that wrote them. Two calls in flight against one
   * instance therefore attribute one question's prompt to another, silently. The pool hands
   * each worker its own instance, so per-worker state is correct by construction.
   *
   * Absent means one worker and the serial pass every archived artifact was produced by.
   * `§14.22` of the execution plan prices the second provider at 5.1x the run budget at one
   * request in flight, so this is requirement 12's enabler rather than a speed-up.
   */
  pool?: AblationPool | undefined;
};

/**
 * One factory per arm, and the number of questions to keep in flight.
 *
 * `baselineFor` and `featureFor` must return **distinct** instances per worker: two workers
 * sharing one reintroduces the single-slot defect, and `benchmark-concurrency.test.ts`
 * falsifies the claim by building exactly that pair and watching the answers diverge.
 *
 * ## Why the pool also has to say **which** instances it built
 *
 * Every census in the arm -- `abstentionReasons`, `recoveryCensus`, `bareRetryCensus`,
 * `voteCounts` -- is per-**instance** state, and §14.22's pool gives each worker its own
 * instance on purpose. Reading the census off `feature` therefore reads worker 0's quarter:
 * `41773546221` published `llm=28, answered=460` against 2,000 question-answers, and 488 is
 * 122 per pass, which is exactly worker 0's share of 500 at four workers.
 *
 * A denominator that is a quarter of the run is not a slightly low rate, it is a rate that is
 * comparable with nothing else in the campaign. The fix is not a bigger multiplier -- the
 * service count is not knowable from the number -- so the pool enumerates what it built and
 * `runCortexMemoryArm` folds the census across the list. {@link createAblationPool} is the
 * implementation that cannot forget to: it memoises one instance per worker, which is also
 * what `BenchmarkWorkerPool.systemFor` already documents ("called at most `min(workers,
 * questions)` times").
 */
export type AblationPool = {
  readonly workers: number;
  baselineFor(worker: number): MemorySystem;
  featureFor(worker: number): MemorySystem;
  /**
   * Every feature instance this pool has handed to a worker, in build order, worker 0 first.
   *
   * The feature side only. The arm's censuses are the feature system's, and an enumerator for
   * the baseline side would have no caller -- which this repository removes rather than keeps
   * "for symmetry".
   */
  featureInstances(): readonly MemorySystem[];
};

/**
 * The pool implementation the arm's CLI uses, so the enumeration cannot drift from the factories.
 *
 * ## Why `first` is an argument rather than `worker === 0 ? build() : build()`
 *
 * The CLI has already built the serial pair by the time it knows the worker count -- `buildFeature()`
 * runs before `readWorkers(process.env)` -- and the serial instance is the one the arm would measure
 * with no pool at all. Taking it here makes worker 0 that exact object, so a run at `workers: 1`
 * and a run at `workers: 4` differ in how many questions are open and in nothing else. The old
 * inline form (`(worker) => (worker === 0 ? feature0 : buildFeature())`) got worker 0 right and
 * gave every other worker a **fresh instance per pass**, which is the second half of the same
 * defect: instance identity was a function of (worker, pass), so no reader could have enumerated
 * the set even if it had known to try.
 *
 * ## Why the memo is a `Map`
 *
 * Worker indexes arrive in claim order, so an array would work today and would silently grow a hole
 * the first time a caller resolved an index out of order -- and `filter` skips holes, which is the
 * trap `filled()` documents one function above. A map has no such hole to skip.
 */
export function createAblationPool(spec: {
  readonly workers: number;
  /** The pair a serial pass would have used; worker 0 gets these two instances. */
  readonly first: { readonly baseline: MemorySystem; readonly feature: MemorySystem };
  baselineFor(worker: number): MemorySystem;
  featureFor(worker: number): MemorySystem;
}): AblationPool {
  if (!Number.isInteger(spec.workers) || spec.workers < 1) {
    throw new Error(
      `createAblationPool received workers=${spec.workers}, which is not a positive integer -- ` +
        'a fractional count would silently serialise the pass and a zero would open no worker ' +
        'and answer nothing. See BenchmarkWorkerPool.',
    );
  }
  const baseline = new Map<number, MemorySystem>([[0, spec.first.baseline]]);
  const feature = new Map<number, MemorySystem>([[0, spec.first.feature]]);
  const resolve = (
    worker: number,
    built: Map<number, MemorySystem>,
    factory: (worker: number) => MemorySystem,
    side: string,
  ): MemorySystem => {
    if (!Number.isInteger(worker) || worker < 0) {
      throw new Error(
        `${side}For received worker=${worker}, which is not a non-negative integer -- the pool ` +
          'claims indexes from zero and a pool that accepted anything else would build instances ' +
          'no census could ever enumerate.',
      );
    }
    const existing = built.get(worker);
    if (existing !== undefined) return existing;
    const instance = factory(worker);
    built.set(worker, instance);
    return instance;
  };
  return {
    workers: spec.workers,
    baselineFor: (worker) => resolve(worker, baseline, spec.baselineFor, 'baseline'),
    featureFor: (worker) => resolve(worker, feature, spec.featureFor, 'feature'),
    // Insertion order, and worker 0 was inserted at construction, so this is worker order rather
    // than build order -- which is the order a reader comparing a census against a worker count
    // expects.
    featureInstances: () => [...feature.values()],
  };
}

/**
 * The count of answers a sparse vector actually holds.
 *
 * ## Why `.length` is wrong once the pool exists
 *
 * `answers[index] = answer` leaves a hole for every question not yet answered, and
 * `Array.prototype.length` is *highest index plus one*: after question 499 alone, a
 * 500-question pass reads `length === 500`. `PartialAblation.reached` would then say the run
 * got to the end when it answered one question -- and that number is what a reader uses to
 * decide whether to re-run. `filter` skips holes, so it counts what is there.
 */
function filled(answers: readonly Answer[]): number {
  return answers.filter((answer) => answer !== undefined).length;
}

/** Run a baseline vs feature ablation and report statistical significance. */
/**
 * Correct counts per capability, aggregated across repetitions.
 *
 * ## Why the unit is a count and not a rate
 *
 * A capability's questions are fixed, so a rate hides the denominator a reader needs to compare two
 * runs of different sample sizes; the count is what the roster shows and what a reader has been
 * comparing. `questionsByCapability` carries the denominator beside it.
 *
 * ## Why min / mean / max rather than a standard deviation
 *
 * Four repetitions do not support a variance estimate worth quoting, and the campaign's decisions
 * have always been made against a range. Recording the three numbers states the range without
 * implying a distribution nobody measured.
 *
 * A capability absent from every repetition's dataset cannot arise -- the vectors are aligned with
 * the dataset by construction -- so there is no empty-object branch here.
 */
function spreadByCapability(
  dataset: BenchmarkDataset,
  correctPerRun: readonly (readonly boolean[])[],
): Record<string, CountSpread> {
  const capabilities = questionsByCapability(dataset);
  const totals: Record<string, number[]> = {};
  for (const capability of Object.keys(capabilities)) totals[capability] = [];
  for (const correct of correctPerRun) {
    const counts: Record<string, number> = {};
    for (const capability of Object.keys(capabilities)) counts[capability] = 0;
    dataset.questions.forEach((question, index) => {
      // `!` because `counts` was seeded with every capability above: the fallback a `?? 0` would
      // provide is unreachable, and an unreachable branch in a counter is exactly the shape that
      // hides a real one (`§57.6`).
      if (correct[index] === true) counts[question.capability]! += 1;
    });
    for (const [capability, count] of Object.entries(counts)) totals[capability]!.push(count);
  }
  return Object.fromEntries(
    Object.entries(totals).map(([capability, counts]) => [
      capability,
      {
        min: Math.min(...counts),
        avg: counts.reduce((sum, count) => sum + count, 0) / counts.length,
        max: Math.max(...counts),
      },
    ]),
  );
}

/** How many questions each capability carries, so a count can be read as a rate. */
function questionsByCapability(dataset: BenchmarkDataset): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const question of dataset.questions) {
    counts[question.capability] = (counts[question.capability] ?? 0) + 1;
  }
  return counts;
}

/**
 * How many leading bytes each pass shares with the first one.
 *
 * `null` at position `0` because a pass agrees with itself everywhere and the length written there would be
 * read as a measurement; `null` wherever either text is `null`, because a pass that reported no prompt has
 * not been shown to match. Plain string comparison rather than a hash: the answer is an offset, and a
 * digest would destroy exactly the quantity this field exists to report.
 */
function commonPrefixByPass(texts: readonly (string | null)[]): (number | null)[] {
  const first = texts[0] ?? null;
  return texts.map((text, i) => {
    if (i === 0 || text === null || first === null) return null;
    const limit = Math.min(text.length, first.length);
    let offset = 0;
    while (offset < limit && text.charCodeAt(offset) === first.charCodeAt(offset)) offset++;
    return offset;
  });
}

export async function runAblation(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
  options: AblationOptions = {},
): Promise<AblationResult> {
  const runs = options.runs ?? 3;
  const alpha = options.alpha ?? 0.05;
  const pool = options.pool;
  // Built once rather than at each of the four call sites: two of them are the baseline and two
  // the feature, and a site that forwarded the wrong factory would make one side concurrent and
  // the other serial -- a difference the artifact would show as a delta.
  const baselinePool: BenchmarkWorkerPool | undefined =
    pool === undefined ? undefined : { workers: pool.workers, systemFor: pool.baselineFor };
  const featurePool: BenchmarkWorkerPool | undefined =
    pool === undefined ? undefined : { workers: pool.workers, systemFor: pool.featureFor };
  // The run's ceiling is an **instant**, not a duration, because the passes share it: whichever one
  // runs longest is the one that finds nothing left, and it is the one that reports. Converted once
  // here rather than per pass so a pass cannot extend the run by starting later.
  const deadline =
    options.budgetMs === undefined ? undefined : performance.now() + options.budgetMs;
  /**
   * What is left of the run's ceiling when the next pass starts.
   *
   * Clamped at zero rather than allowed to go negative: `evaluateWithScorerDetailed` compares
   * `elapsed > budgetMs`, and a negative ceiling would make that true before the first question —
   * which reports the failure against a question that was never attempted. Zero still fires on the
   * second call, so an exhausted run still ends with a record, and the first question still runs,
   * which is what lets the partial artifact name the pass it died in.
   */
  const remaining = (): number | undefined =>
    deadline === undefined ? undefined : Math.max(0, deadline - performance.now());
  const abstentionAware = options.abstentionAware ?? true;
  const scorer = options.scorer ?? exactMatchScorer;
  if (runs < 1) {
    throw new Error(`ablation requires at least 1 run, got ${runs}`);
  }

  // The first evaluation captures per-question correctness so the paired McNemar
  // test and the Wilson intervals can be computed. These are question-level
  // statistics that a run-level t-test cannot provide for a deterministic system.
  //
  // Both sides carry `run: 0`. The baseline is evaluated to completion before the
  // feature starts, so the progress stream reads as one side's questions, then the
  // other's -- which is the same ordering the pairing argument depends on, and is
  // asserted by `ablation-progress.test.ts` rather than assumed here.
  //
  // Both sides accumulate their answers through a sink, so a throw leaves the
  // measurement reachable rather than only inside a local array the stack is about
  // to unwind. See `attachPartial` below for what is done with them and why a
  // partial result must not report a delta.
  const baselineAnswers: Answer[] = [];
  const featureAnswers: Answer[] = [];
  // Every repetition that finished, so a failure in a later one does not discard it.
  // Declared HERE rather than inside the loop below because the first repetition is
  // not run by that loop -- it is the pair of calls immediately after this line --
  // and a `completed` that only ever held the loop's repetitions would report `[]`
  // for the failure the runs above actually had.
  const completed: CompletedPass[] = [];
  let baseFirst: ScoredEvaluation;
  try {
    baseFirst = await evaluateWithScorerDetailed(
      dataset,
      baseline,
      scorer,
      options.onProgress,
      0,
      false,
      false,
      (answer, index) => {
        baselineAnswers[index] = answer;
      },
      remaining(),
      baselinePool,
    );
  } catch (error) {
    throw attachPartial(error, {
      system: baseline.name,
      reached: filled(baselineAnswers),
      total: dataset.questions.length,
      run: 0,
      baselineAnswers,
      featureAnswers,
      completed,
    });
  }
  let featFirst: ScoredEvaluation & RetrievalCaptureVectors;
  try {
    featFirst = await evaluateWithScorerDetailed(
      dataset,
      feature,
      scorer,
      options.onProgress,
      0,
      // The feature side is the one whose model output explains a loss, and the
      // baseline is the reference pipeline whose abstention path is a different
      // design. Capturing only this side keeps the artifact's raw-output vector
      // aligned with `featureAnswers` and `featureCorrect`, which are the vectors
      // the roster pairs it with.
      true,
      // The evidence, on the same side and for the same reason: §13's loss is the
      // feature's, and the question it left open -- wrong evidence or no evidence --
      // can only be asked of the side that lost.
      true,
      (answer, index) => {
        featureAnswers[index] = answer;
      },
      remaining(),
      featurePool,
    );
  } catch (error) {
    throw attachPartial(error, {
      system: feature.name,
      reached: filled(featureAnswers),
      total: dataset.questions.length,
      run: 0,
      baselineAnswers,
      featureAnswers,
      completed,
    });
  }

  // Repetition 0 is the only one whose completion is not visible where the others'
  // is: it ends here rather than at the bottom of the loop below. Recorded before
  // the pairing arithmetic, because the arithmetic can throw on a length mismatch
  // (`buildQuestionRecords` throws for the same reason) and the answers would then
  // be lost by a failure that is not about them.
  completed.push({ run: 0, baselineAnswers, featureAnswers });

  let baselineCorrectFeatureIncorrect = 0;
  let baselineIncorrectFeatureCorrect = 0;
  // Collected alongside the counts, in the same pass. A flip count alone cannot
  // distinguish a mechanism from a coincidence: the conjunction arm's four flips
  // were all in IE while its target population never moved, and nothing in the
  // artifact could name them.
  const discordantRegression: string[] = [];
  const discordantGain: string[] = [];
  const perCapability = Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, emptyPairedStats()]),
  ) as Record<Capability, PerCapabilityPairedStats>;
  for (let i = 0; i < baseFirst.correct.length; i++) {
    const baseCorrect = baseFirst.correct[i]!;
    const featCorrect = featFirst.correct[i]!;
    const capability = dataset.questions[i]!.capability;
    const bucket = perCapability[capability]!;
    bucket.total++;
    if (baseCorrect) {
      bucket.baselineCorrect++;
    }
    if (featCorrect) {
      bucket.featureCorrect++;
    }
    if (baseCorrect && !featCorrect) {
      baselineCorrectFeatureIncorrect++;
      bucket.baselineCorrectFeatureIncorrect++;
      discordantRegression.push(dataset.questions[i]!.id);
    } else if (!baseCorrect && featCorrect) {
      baselineIncorrectFeatureCorrect++;
      bucket.baselineIncorrectFeatureCorrect++;
      discordantGain.push(dataset.questions[i]!.id);
    }
  }

  // The two flip counts split by the abstention line, from the same two vectors the loop above walked.
  //
  // Computed here rather than in `report.ts` because the answers are in hand exactly once -- on the two
  // `ScoredEvaluation`s this function owns -- and a reporter that recomputed them from the roster would be a
  // second definition of the same classification, reading a field (`correct`) that cannot see a decline at
  // all. `classifyTransitions` throws on a length mismatch, which is the one way this call can fail and the
  // one way a wrong pairing would otherwise reach the artifact.
  const transitions = classifyTransitions({
    baselineAnswers: baseFirst.answers,
    featureAnswers: featFirst.answers,
    baselineCorrect: baseFirst.correct,
    featureCorrect: featFirst.correct,
  });

  for (const capability of ALL_CAPABILITIES) {
    const bucket = perCapability[capability]!;
    bucket.mcnemarPValue = mcnemarPValue(
      bucket.baselineCorrectFeatureIncorrect,
      bucket.baselineIncorrectFeatureCorrect,
    );
    bucket.mcnemarSignificant = bucket.mcnemarPValue < alpha;
    bucket.baselineConfidence = wilsonScoreInterval(bucket.baselineCorrect, bucket.total);
    bucket.featureConfidence = wilsonScoreInterval(bucket.featureCorrect, bucket.total);
  }

  const baselineConfidence = wilsonScoreInterval(
    baseFirst.metrics.correct,
    baseFirst.metrics.total,
  );
  const featureConfidence = wilsonScoreInterval(featFirst.metrics.correct, featFirst.metrics.total);
  const mcnemar = mcnemarPValue(baselineCorrectFeatureIncorrect, baselineIncorrectFeatureCorrect);
  const mcnemarSignificant = mcnemar < alpha;

  const toScore = (m: typeof baseFirst.metrics): number =>
    abstentionAware ? m.abstentionAwareAccuracy : m.accuracy;

  const baselineScores = [toScore(baseFirst.metrics)];
  const featureScores = [toScore(featFirst.metrics)];
  // Seeded with the first repetition, which is the one the roster records.
  const baselineCorrect: boolean[][] = [baseFirst.correct];
  const featureCorrectPerRun: boolean[][] = [featFirst.correct];
  // §13.174. The distinct prompts each question cost, accumulated from the repetitions below.
  //
  // `null` for the whole vector at one repetition, because a distinct count over a single sample is not a
  // measurement of repetition -- it is the number one, and a reader would have to know that to avoid
  // reading four `1`s as four matched repetitions. That is the rule `featureCorrectByRun` follows one field
  // over, applied to a quantity whose trivial value is more misleading.
  //
  // Per question, the **distinct texts** are held rather than all of them: at `runs` repetitions the set is
  // at most `runs` long, and the count is its size. A question whose prompt is unknowable on any pass
  // becomes `null` and stays there -- a system that answered "no prompt" on pass 3 has not shown that pass 3
  // matched pass 1.
  const promptVariants: (number | null)[] | null =
    runs > 1 && featFirst.promptTexts !== undefined
      ? featFirst.promptTexts.map((text) => (text === null ? null : 1))
      : null;
  const distinctPrompts: (string[] | null)[] | null =
    promptVariants === null
      ? null
      : featFirst.promptTexts!.map((text) => (text === null ? null : [text]));
  // §13.176. One question's prompt kept **textually** for every repetition, so the next reading can say
  // which bytes moved instead of only that some did.
  //
  // `featurePromptVariants` answered the first question and stopped there: run `41090564131` reported `4` on
  // all 500 questions, while the same configuration dispatched twice delivered identical evidence (same
  // turns, same order, same character count) with `0/500` equal digests. A count cannot name the part of the
  // prompt that is not the evidence, and that is the only part left once the evidence is equal.
  //
  // The witness is the first dataset position whose first pass reported a prompt, because a witness is read
  // by diffing passes against each other and any answered question serves -- the first is the only choice
  // that needs no seed. Bounded by the prompt budget, not the roster.
  const witnessIndex =
    runs > 1 && featFirst.promptTexts !== undefined
      ? featFirst.promptTexts.findIndex((text) => text !== null)
      : -1;
  const witnessTexts: (string | null)[] =
    witnessIndex < 0 ? [] : [featFirst.promptTexts![witnessIndex] ?? null];
  for (let i = 1; i < runs; i++) {
    // `run: i` rather than the default, so a repeated pass is distinguishable in
    // the progress stream from the first one. Both sides take the same ordinal:
    // they are two systems measured in one repetition, not two repetitions.
    //
    // ## Why this loop has sinks and a wrap, and it is the same reason the loop above does
    //
    // It did not, and run `38520676669` is the cost. That run dispatched §13.22's
    // measurement, completed repetitions 0 and 1 on both sides -- two thousand graded
    // answers -- and died on `TypeError: terminated` at the start of repetition 2. Because
    // this loop passed no sink and had no catch, the error left `runAblation` unwrapped,
    // `error.partial` was `undefined`, and the failure path in `bench/run-ablation.ts`
    // wrote an error log and nothing else. Three hours and eight minutes produced no
    // durable record of anything.
    //
    // The durability rule is stated at the top of `partial-ablation.test.ts` and it does
    // not distinguish repetitions: a repetition is a measurement, and losing one silently
    // is the defect that file exists to prevent. What differs is only which vectors the
    // partial carries -- the dying repetition's, in both cases -- because
    // `PartialAblation.run` records how many repetitions completed before it.
    const baselineThisRun: Answer[] = [];
    const featureThisRun: Answer[] = [];
    let b: ScoredEvaluation;
    try {
      b = await evaluateWithScorerDetailed(
        dataset,
        baseline,
        scorer,
        options.onProgress,
        i,
        // No capture on a repeat: the artifact records the first repetition's raw output and
        // evidence, and capturing every repetition would multiply the artifact by `runs` for
        // vectors no reader pairs with a record. The feature side below is the one exception and
        // it does not reach the artifact -- see the comment on its capture flag.
        false,
        false,
        (answer, index) => {
          baselineThisRun[index] = answer;
        },
        remaining(),
        baselinePool,
      );
    } catch (error) {
      throw attachPartial(error, {
        system: baseline.name,
        reached: filled(baselineThisRun),
        total: dataset.questions.length,
        run: i,
        baselineAnswers: baselineThisRun,
        featureAnswers: featureThisRun,
        completed,
      });
    }
    let f: ScoredEvaluation;
    try {
      f = await evaluateWithScorerDetailed(
        dataset,
        feature,
        scorer,
        options.onProgress,
        i,
        false,
        // The one capture a repetition does take, and the reason is `§13.168.8`: a cache prediction is a
        // statement about **bytes**, so "were the repetitions repetitions" is answerable only by looking at
        // what each of them sent. The vectors this pulls in are dropped in the loop below, before anything
        // is returned, and the only thing that survives is a count per question -- so the artifact does not
        // grow by `runs`, which is what the baseline's flag above is protecting.
        true,
        (answer, index) => {
          featureThisRun[index] = answer;
        },
        remaining(),
        featurePool,
      );
    } catch (error) {
      throw attachPartial(error, {
        system: feature.name,
        reached: filled(featureThisRun),
        total: dataset.questions.length,
        run: i,
        baselineAnswers: baselineThisRun,
        featureAnswers: featureThisRun,
        completed,
      });
    }
    baselineScores.push(toScore(b.metrics));
    featureScores.push(toScore(f.metrics));
    // §13.88. The correctness vectors are held per repetition, because a per-capability count that
    // only ever existed for one pass is the unit defect §13.87 measured: the same configuration
    // moved MR by seven questions between two runs and the artifact could not say so.
    baselineCorrect.push(b.correct);
    featureCorrectPerRun.push(f.correct);
    // §13.174. Fold this repetition's prompts into the distinct sets, then drop them: the vectors `f`
    // carries are one repetition's worth of text and evidence, and nothing downstream asks for them.
    if (distinctPrompts !== null && promptVariants !== null) {
      for (let q = 0; q < distinctPrompts.length; q++) {
        const seen = distinctPrompts[q];
        if (seen === null || seen === undefined) continue;
        const text = f.promptTexts?.[q];
        if (text === null || text === undefined) {
          // Unknowable from here on, and `null` rather than the count so far: the number of distinct
          // prompts is not the number of distinct prompts we happened to see.
          distinctPrompts[q] = null;
          promptVariants[q] = null;
          continue;
        }
        if (!seen.includes(text)) seen.push(text);
        promptVariants[q] = seen.length;
      }
    }
    if (witnessIndex >= 0) witnessTexts.push(f.promptTexts?.[witnessIndex] ?? null);
    completed.push({
      run: i,
      baselineAnswers: baselineThisRun,
      featureAnswers: featureThisRun,
    });
  }

  const baselineAggregate = aggregate(baselineScores);
  const featureAggregate = aggregate(featureScores);
  const delta = featureAggregate.avg - baselineAggregate.avg;

  // A t-test over runs is only meaningful when the repeats carry real variance
  // (stochastic temperature > 0). Identical deterministic repeats have zero
  // variance, so the t-test is undefined and reported as NaN.
  const hasVariance =
    baselineScores.length >= 2 && (stddev(baselineScores) > 0 || stddev(featureScores) > 0);
  const pValue = hasVariance ? tTestPValue(baselineScores, featureScores) : Number.NaN;
  const effectSize = hasVariance
    ? cohensD(baselineScores, featureScores)
    : delta === 0
      ? 0
      : delta > 0
        ? Infinity
        : -Infinity;

  // §13.88's projection. Absent for one repetition, because a spread of zero would read as
  // perfect stability rather than as no measurement. The masks ride the same condition: at one
  // repetition they would be a second copy of `featureCorrect`/`baselineCorrect`, and two arrays that
  // must agree are two arrays that can disagree.
  const capabilitySpreads =
    runs > 1
      ? {
          featureByCapability: spreadByCapability(dataset, featureCorrectPerRun),
          baselineByCapability: spreadByCapability(dataset, baselineCorrect),
          questionsByCapability: questionsByCapability(dataset),
          featureCorrectByRun: featureCorrectPerRun.map(correctnessMask),
          baselineCorrectByRun: baselineCorrect.map(correctnessMask),
        }
      : {};

  return {
    ...capabilitySpreads,
    feature: feature.name,
    baselineAggregate,
    featureAggregate,
    delta,
    pValue,
    significant: hasVariance && pValue < alpha,
    effectSize,
    baselineConfidence,
    featureConfidence,
    mcnemarPValue: mcnemar,
    mcnemarSignificant,
    discordant: {
      baselineCorrectFeatureIncorrect,
      baselineIncorrectFeatureCorrect,
    },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: discordantRegression,
      baselineIncorrectFeatureCorrect: discordantGain,
    },
    transitions,
    // Both sides, from the evaluations that produced them, written unconditionally: this
    // function is the only producer of an `AblationResult`, so a run that never reached the
    // scorer still records that it judged nothing rather than leaving the field to mean
    // "predates the census". §13.236 is the run that made the difference cost 158 minutes.
    unjudged: { feature: featFirst.unjudged, baseline: baseFirst.unjudged },
    baselineMetrics: baseFirst.metrics,
    featureMetrics: featFirst.metrics,
    featureCorrect: featFirst.correct,
    featureAnswers: featFirst.answers,
    // An assertion, not a fallback. This function is the only producer of an
    // `AblationResult` and it requests the capture unconditionally on the line
    // that evaluates the feature, so `rawOutputs` is present on every path that
    // reaches here. A `=== undefined` branch would be unreachable code that reads
    // as a safety net, which is what §57.6 removed one field over, and it would
    // also make the raw vector silently absent for a run that asked for it --
    // the artifact would then describe the capture as unavailable rather than as
    // failed. The field stays optional on the type because `AblationResult` is a
    // report shape that tests build by hand, which is the reason
    // `featureAnswers` above is optional too.
    featureRawOutputs: featFirst.rawOutputs!,
    // Requested on the same call as the raw-output capture, and present for the
    // same reason: this function is the only producer of an `AblationResult` and
    // it asks for both unconditionally, so a `=== undefined` branch here would be
    // the unreachable-code-reads-as-a-safety-net shape §57.6 removed one field
    // over.
    //
    // It is declared optional on the type because `AblationResult` is a report
    // shape tests build by hand -- and unlike `featureAnswers`, whose absence
    // would silently unbuild the roster, a hand-built fixture that omits this
    // vector produces records with `turns: []`, which is the honest reading of a
    // fixture that never retrieved anything.
    featureRetrievedContexts: featFirst.retrievedContexts!,
    // Beside the context vector and from the same capture, because the two are one
    // fact: the context is what the reader was shown, this is how much of it
    // reached the prompt. Carrying only the first is what let `38044858147`'s
    // artifact report 3,016-4,528 turns of evidence for a model that received
    // roughly 150-160.
    featurePromptEvidenceChars: featFirst.promptEvidenceChars!,
    featureAdmittedEvidence: featFirst.admittedEvidence!,
    // The prompt each question's reader was sent, carried under the same flag on the same
    // call. Text rather than a digest here because `cortex-memory` -- which owns the prompt
    // -- imports no host API, and because this vector's consumer (`bench-memory-arm.ts`)
    // is the hop that already has `node:crypto`. `§13.168.8` reads the fingerprint built
    // from it to decide whether four passes were four repetitions or four prompts.
    featurePromptTexts: featFirst.promptTexts!,
    // The two facts about each request the four captures above cannot answer: which path the question took,
    // and which roles the window it was shown actually contained. Asserted present for the reason the four
    // above are: `runAblation` requests the retrieval capture unconditionally on the call that evaluates the
    // feature, so a `=== undefined` branch here would be unreachable code reading as a safety net -- and it
    // would file a capture that failed as a system that reports no route.
    featureRoutes: featFirst.routes!,
    featureRoleCensuses: featFirst.roleCensuses!,
    // `§13.174`. How many different prompts each question cost across the repetitions, which is the number
    // the cache prediction is a claim about: `1` everywhere means the repeats were repeats, and a larger
    // number means this arm sent that many requests and called them repetitions. Absent at one repetition;
    // `null` for a question whose prompt the system did not always expose.
    ...(promptVariants === null ? {} : { featurePromptVariants: promptVariants }),
    ...(witnessIndex < 0
      ? {}
      : {
          featurePromptRepeatWitness: {
            index: witnessIndex,
            questionId: dataset.questions[witnessIndex]!.id,
            texts: witnessTexts,
            commonPrefix: commonPrefixByPass(witnessTexts),
          },
        }),
    perCapability,
  };
}

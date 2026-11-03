/**
 * Benchmark runner: run a memory system over a dataset and evaluate its answers.
 */
import type {
  AdmittedEvidence,
  Answer,
  BenchmarkDataset,
  MemorySystem,
  RetrievedTurns,
  SessionAwareMemorySystem,
} from './types.js';
import { scoreEvaluation, type AnswerScorer, type ScoredEvaluation } from './metrics.js';

/** True when the system opts into session-boundary-aware answering. */
function isSessionAware(system: MemorySystem): system is SessionAwareMemorySystem {
  return 'answerSessions' in system;
}

/**
 * One per-question progress event, emitted BEFORE that question is answered.
 *
 * ## Why before, and not after
 *
 * The failure this exists to localise happens *inside* the answer call -- run
 * `37281155088`'s arm spent ~52 minutes in the LLM and then died on an HTTP 402
 * when the account's balance ran out. A callback that fired on completion would
 * leave the one question that died unrecorded, which is precisely the shape of
 * the defect: that run's `benchmark-error.log` carried a stack trace and no
 * question at all, so a 52-minute spend could not be localised and the next
 * attempt would repeat it up to an unknown point.
 *
 * ## The fields
 *
 * - `system` — `MemorySystem.name` of the side about to run. An ablation has two
 *   (`reference-pipeline` / `cortex-memory`), and which one died is not
 *   inferable from a question index.
 * - `index` — 0-based position in `dataset.questions`. 0-based so it is the same
 *   number as the `correct[]` index the paired tests use; a reader adds one.
 * - `total` — the dataset size, so `index` is readable as `index + 1 / total`
 *   without the log having to carry the dataset too.
 * - `run` — 0-based repetition ordinal. `runAblation` evaluates the SAME dataset
 *   `runs` times, so `(system, run, index)` is the key of one attempt and a
 *   record without `run` is ambiguous on any arm with `runs > 1`.
 * - `questionId` — the question's stable id, so the record names the question
 *   rather than only its position in a dataset that may be resampled.
 */
export type BenchmarkProgress = {
  readonly system: string;
  readonly index: number;
  readonly total: number;
  readonly run: number;
  readonly questionId: string;
  /**
   * Milliseconds since this pass began, on a monotonic clock.
   *
   * ## Why the callback carries it
   *
   * Run `38659495034` spent **1h49m inside one question** -- the reference pipeline's
   * first -- and then died, and its `benchmark-error.log` said only
   * `progress: died on reference-pipeline run=0 q=1/500 id=e47becba`. That line cannot
   * distinguish a hung endpoint from a slow one, and the two want opposite repairs: a
   * hang is retried or circuited, a slow pass is given a longer budget or a smaller
   * sample.
   *
   * A question's cost is the gap between the events that bracket it, so the *pass* is the
   * right place to measure it rather than each question: this fires BEFORE its question is
   * answered, and `events[i + 1].elapsedMs - events[i].elapsedMs` is therefore exactly the
   * cost of question `i`.
   *
   * ## Why `performance.now()` and not an injected clock
   *
   * This package injects its clocks everywhere a value participates in a **measurement**
   * -- `now` on the memory systems, `generatedAt` on reports -- because a measurement taken
   * against the wall clock is not reproducible. This one participates in none: it is
   * reporting, it is never written to an artifact, and nothing reads it to decide anything.
   * A monotonic source is the correct one for a duration for the separate reason that it
   * cannot go backwards when the system clock is adjusted mid-pass, which would render as
   * a negative cost.
   */
  readonly elapsedMs: number;
};

/**
 * Optional per-question progress sink.
 *
 * A callback rather than a `console.log` for the reason this package holds
 * throughout: `cortex-eval/src` emits nothing to a stream. Printing is the entry
 * point's job (the `bench` directories of the packages that run one), and an
 * instrument that wrote to stdout would put output policy inside the measurement.
 */
export type BenchmarkProgressCallback = (progress: BenchmarkProgress) => void;

/**
 * A pass that ran out of its wall-clock budget, carrying where it stopped.
 *
 * ## Why this is not exported
 *
 * Nothing outside this module needs to identify it: the entry point's `catch` handles every
 * failure the same way, and `describeFailure` prints the progress from the last emitted
 * event. An export nothing calls is the `1 NEW orphan(s)` this repository's census gate
 * reports, and it would have been reported the moment this class was added -- which is the
 * gate working rather than obstructing.
 *
 * ## Why it is a class at all, rather than a bare `Error`
 *
 * So the message is constructed in one place from the progress record, and so the throw site
 * reads as a decision rather than as string building. The `name` also reaches the stack the
 * entry point logs, which is what tells a reader this was the ceiling and not a provider
 * fault.
 *
 * ## Why it carries the progress rather than only a count
 *
 * It is thrown from inside the loop, where the record exists, and the entry point's `catch`
 * has the last emitted event as well -- but the error being self-sufficient means a future
 * caller that wraps this pass in its own loop does not have to reconstruct it.
 */
class BenchmarkBudgetExceeded extends Error {
  constructor(
    readonly progress: BenchmarkProgress,
    readonly budgetMs: number,
  ) {
    super(
      `the pass spent its ${budgetMs}ms budget and was abandoned before question ` +
        `${progress.index + 1}/${progress.total} (${progress.system}, run ${progress.run})`,
    );
    this.name = 'BenchmarkBudgetExceeded';
  }
}

/**
 * Optional per-question sink for the system's raw model output.
 *
 * ## Why this exists, and why it is a hook rather than a return field
 *
 * `parseAnswer` maps three distinct declines onto one value, because `Answer` is
 * `string | null` and a decline is recognised from the last non-empty line only.
 * Dispatch `37792539133` carried the first real roster and 115 of its 120
 * records read `null`, so the text that names *which* decline happened was
 * unrecoverable. `CortexMemory.lastRawOutput()` retains that text, one slot.
 *
 * A slot cannot build a roster: the roster is assembled after every question has
 * been answered, and by then the slot holds only the last question's reply,
 * which would attribute one question's wording to all of them. The capture has
 * to happen where the answer is produced, so it happens here.
 *
 * ## Why not a member of `MemorySystem`
 *
 * `MemorySystem` is the injection contract, and `memory-system-conformance.test.ts`
 * requires that a bare `{ name, answer }` object receive every question. A raw
 * output is a capability only a value-gated system can offer, so it is read as
 * an optional member -- the same treatment `answerSessions` and the abstention
 * census get -- rather than added to the contract every system must satisfy.
 *
 * ## Why the hook is optional and its absence is not a degraded mode
 *
 * `runBenchmark` returns `Answer[]` and many call sites depend on that, so the
 * hook is a trailing optional parameter rather than a return-type change. A run
 * that omits it behaves exactly as before; nothing about the answers or the
 * routing consults the hook.
 *
 * A system that does not expose `lastRawOutput` reports `null` for every
 * question. That is the honest value: a machine-derived abstention never reaches
 * the model, so there is no text, and `''` would claim a blank answer instead.
 *
 * A **throwing** accessor is deliberately not caught, which is the opposite of
 * how `abstentionReasonsOf` treats one. There the endpoint is already measured
 * and discarding a census beats discarding the arm; here the capture *is* the
 * measurement, so a silent failure would be filed as "this system has no raw
 * output" and be indistinguishable from a normal machine-derived abstention.
 *
 * Not exported. The only caller is this module's own loop, and
 * `evaluateWithScorerDetailed` exposes the capture as a boolean rather than as a
 * sink, so a public type would be an export nothing outside could use -- the
 * `1 NEW orphan(s)` the census gate reports. `BenchmarkProgressCallback` above is
 * exported because two other modules name it in their option types; this one has
 * no such caller.
 */
type BenchmarkRawOutputCallback = (raw: string | null, index: number) => void;

/**
 * Optional per-question sink for the evidence the reader was shown.
 *
 * ## Why this exists beside the raw-output hook rather than inside it
 *
 * §13 produced MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every capability,
 * and the artifact could not say whether retrieval returned the wrong evidence or
 * none. `QuestionRecord.turns` is `[]` on every record because the arm supplies
 * `retrieved: ''` -- honest, and also the blocker, because those two outcomes are
 * repaired in different places and the artifact collapses them.
 *
 * The model text had the same shape of problem: computed during the call, lost at
 * `parseAnswer`, and recoverable only from a slot that holds one question. The
 * remedy is the same shape too, which is why this is a separate trailing hook and
 * not a field on a merged sink object. The two have distinct consumers and
 * distinct failure modes -- the raw output explains *a decline*, the evidence
 * explains *whether one was warranted* -- and a merged sink would make an arm
 * that wants one pay for the other.
 *
 * ## Why a callback and not reading the system afterwards
 *
 * Reading `lastRetrievedContext()` after a 500-question run returns the
 * five-hundredth question's evidence. Attributing it to all five hundred is the
 * defect `raw-output-retention.test.ts` pins one layer down, and the roster pairs
 * this vector against `featureAnswers` by index, so a misordered vector
 * misattributes every explanation.
 *
 * ## Why the absence of the accessor is not a degraded mode
 *
 * A system that does not expose `lastRetrievedContext` reports `null` for every
 * question, the same treatment `lastRawOutput` gets. `null` is the honest value:
 * a system that cannot say what it retrieved has not retrieved nothing.
 *
 * ## Why two values and one callback
 *
 * `promptChars` is the second one, and it is not optional company. The context is
 * what the reader was **shown**; the characters are how much of it reached the
 * **prompt**, after the prompt builder's character budget was spent. Run
 * `38044858147` met that budget on every question -- 506,338 characters of
 * evidence against 24,000 -- so a capture carrying only the first would report
 * 3,016-4,528 turns of evidence for a model that received roughly 150-160. The two
 * are always wanted together because neither is interpretable alone: a reader
 * cannot tell a retrieval failure from a truncation without both.
 *
 * `null` for the characters means the system does not expose the second accessor,
 * which is a different statement from "the prompt carried nothing" and must not
 * be collapsed into a zero.
 *
 * Not exported, for the reason `BenchmarkRawOutputCallback` is not: the only
 * caller is this module's own loop, and an export nothing outside could use is
 * the `1 NEW orphan(s)` the census gate reports.
 */
type BenchmarkRetrievedCallback = (
  retrieved: RetrievedTurns | null,
  promptChars: number | null,
  admitted: AdmittedEvidence | null,
  promptText: string | null,
  index: number,
) => void;

/**
 * A sink for each answer as it is produced, so a throw does not erase the pass.
 *
 * ## Why the answer needs a sink when it is already accumulated
 *
 * `runBenchmark` builds its `answers` array locally and returns it, so a caller
 * only sees the vector when the loop finishes. When the loop throws, that array
 * -- and every answer in it -- is unreachable. Run `37942775447` is the cost: ~40
 * minutes of grading, and the failure path could write nothing but a stack trace.
 *
 * The sink fires at the same point the answer is appended, so the caller holds
 * the answers independently of whether the pass completed. `reached` is then the
 * sink's own length rather than a value the loop has to remember to maintain.
 *
 * Not exported, for the reason `BenchmarkRetrievedCallback` is not: the only
 * caller is this module's own loop, and an export nothing outside could use is
 * the `1 NEW orphan(s)` the census gate reports.
 */
type BenchmarkAnswerCallback = (answer: Answer, index: number) => void;

/**
 * How many questions may be in flight at once, and which system instance answers each.
 *
 * ## Why this exists, and why it is not a lock
 *
 * `§14.22` of the execution plan prices the second provider: `zhipu:glm-4.6` needs **5.1x**
 * the run budget at one request in flight, so requirement 12's "the strong model must
 * measurably do better" is blocked by arithmetic rather than by implementation. Four
 * thousand calls at five seconds each is 336 minutes serially and 42 minutes at eight.
 *
 * The obvious way to get concurrency -- one system, several calls in flight -- is wrong here
 * for a reason this package can state exactly. `MemorySystem` exposes **per-question state
 * through optional accessors** (`lastRawOutput`, `lastRetrievedContext`,
 * `lastPromptEvidenceChars`, `lastAdmittedEvidence`, `lastPromptText`), and `runBenchmark`
 * reads each one **after** the call that wrote it. That is a single-slot contract. With two
 * calls in flight against one instance, question A's record carries question B's prompt and
 * nothing throws: the artifact stays complete, self-consistent, and wrong, which is the
 * failure mode this repository has paid for four times (§13.216, §13.220).
 *
 * So the pool hands each worker its **own instance** of the same configuration, sharing only
 * the things that are stateless by design (an HTTP client, an embedding cache keyed by
 * text). Per-worker state is then correct by construction rather than protected by a lock,
 * and the acceptance criterion is falsifiable offline: **the same configuration at one
 * worker and at `c` workers must produce byte-identical answers and byte-identical prompts,
 * placed by question index**. If it does not, the difference names a piece of state that is
 * not per-question -- which is a finding about the mechanism, not a failure of the
 * instrument.
 *
 * ## Why the pool is a parameter rather than a field on `system`
 *
 * The same argument `budgetMs` carries: how many requests a run has in flight is a property
 * of **the run**, not of the system under test. Two configurations of one system must not
 * look like two systems to a reader of the artifact, and `workers` is recorded in the
 * artifact's configuration block precisely because it can move the wall clock.
 */
export type BenchmarkWorkerPool = {
  /** How many questions may be in flight. A positive integer; 1 is the serial pass. */
  readonly workers: number;
  /**
   * The instance that answers the questions this worker claims.
   *
   * Called at most `min(workers, questions)` times, so a pool never builds an instance the
   * pass cannot use. Implementations must return a **distinct** instance per worker; two
   * workers sharing one reintroduce the single-slot defect the pool exists to avoid, and
   * the byte-identity test in `benchmark-concurrency.test.ts` is what detects it.
   */
  systemFor(worker: number): MemorySystem;
};

/** Run a system over every question, preserving question order. */
export async function runBenchmark(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  progress?: BenchmarkProgressCallback,
  run = 0,
  onRawOutput?: BenchmarkRawOutputCallback,
  onRetrieved?: BenchmarkRetrievedCallback,
  onAnswer?: BenchmarkAnswerCallback,
  /**
   * Wall-clock ceiling for this pass, in milliseconds. Absent means no ceiling, which is
   * what every archived artifact was produced under.
   *
   * ## Why the last parameter and not a field on `system`
   *
   * It is a property of the **run**, not of the system under test: the same system measured
   * with a budget is measuring the same thing, and putting it on `system` would make two
   * configurations of one system look like two systems to every reader of the artifact.
   *
   * ## What it is for
   *
   * A pass that hangs must end and must say where it ended. The workflow's own
   * `timeout-minutes` did not fire on run `38725510400`, so a five-hour hang left no record
   * at all; a ceiling enforced here throws `BenchmarkBudgetExceeded` from inside the loop,
   * which the entry point's existing `catch` turns into the same `benchmark-error.log` a
   * thrown failure produces. Enforced between questions: it cannot interrupt a call in
   * flight, and the per-attempt timeout in `cortex-ai` is what bounds that one.
   */
  budgetMs?: number,
  /**
   * Workers to run in flight. Absent means one, and one is exactly the serial pass every
   * archived artifact was produced by -- the branch below does not run at all.
   *
   * With a pool of `c`, a question's **index** is claimed atomically before it is answered,
   * every write lands at that index, and the returned vector is in question order regardless
   * of completion order. That last clause is the whole measurement: the roster, the paired
   * tests and the gold-overlap vectors all pair by index, so a completion-ordered vector
   * would misattribute every explanation while looking well-formed.
   */
  pool?: BenchmarkWorkerPool,
): Promise<Answer[]> {
  const total = dataset.questions.length;
  // Pre-sized and filled by index, never appended. `answers.push` would make the vector's
  // order the completion order under concurrency -- see `pool`'s doc.
  const answers: Answer[] = new Array<Answer>(total);
  // Monotonic and taken once per pass, so `BenchmarkProgress.elapsedMs` is a duration
  // rather than a wall-clock reading. See that field for why this one is not injected.
  const startedAt = performance.now();
  // Resolved per worker rather than once, because the accessors are per-instance state and
  // a pool has one instance per worker. A system that does not expose an accessor reports
  // `null` for every question it answered -- absence is not a fabricated zero.
  const accessorsFor = (worker: MemorySystem) => ({
    rawOutput:
      onRawOutput === undefined
        ? undefined
        : 'lastRawOutput' in worker
          ? (worker as { lastRawOutput: () => string | null }).lastRawOutput.bind(worker)
          : undefined,
    // Resolved from the same kind of structural check, and for the same reason: both of
    // these are optional capabilities rather than members of the injection contract.
    retrievedContext:
      onRetrieved === undefined
        ? undefined
        : 'lastRetrievedContext' in worker
          ? (
              worker as { lastRetrievedContext: () => RetrievedTurns | null }
            ).lastRetrievedContext.bind(worker)
          : undefined,
    // The carried-evidence size, resolved alongside it because the two are captured
    // together: `retrievedContext` is what the reader was shown and this is how much
    // of it survived the prompt builder's character budget. Resolved only when the
    // capture is wanted, so a system that does not expose the accessor costs nothing.
    promptEvidence:
      onRetrieved === undefined
        ? undefined
        : 'lastPromptEvidenceChars' in worker
          ? (
              worker as { lastPromptEvidenceChars: () => number | null }
            ).lastPromptEvidenceChars.bind(worker)
          : undefined,
    // The offer, resolved alongside them for the reason §13.15's run had to teach: the
    // other two describe the delivery, and a reader with only the delivery cannot tell a
    // budget that cut the context from a retrieval that found almost nothing.
    admittedEvidence:
      onRetrieved === undefined
        ? undefined
        : 'lastAdmittedEvidence' in worker
          ? (
              worker as { lastAdmittedEvidence: () => AdmittedEvidence | null }
            ).lastAdmittedEvidence.bind(worker)
          : undefined,
    // The prompt itself, resolved under the same rule and for a reason the three above
    // cannot serve: `§13.168.8` asks whether two passes sent the same bytes, and every
    // other accessor here reports a size or a subset. It travels as text rather than as a
    // digest because this module is host-free -- the consumer that writes the artifact
    // hashes it -- and because hashing here would put `node:crypto` in the entry point's
    // import graph.
    promptText:
      onRetrieved === undefined
        ? undefined
        : 'lastPromptText' in worker
          ? (worker as { lastPromptText: () => string | null }).lastPromptText.bind(worker)
          : undefined,
  });
  // Every branch below routes through this, rather than calling the vector itself. Seven
  // branches are seven chances to forget the sink, and the routing is not what the sink
  // measures -- it fires for every answer on every path by construction. The write happens
  // first so that a sink which throws cannot produce an answer that is reported but not
  // accumulated.
  const record = (answer: Answer, index: number): Answer => {
    answers[index] = answer;
    onAnswer?.(answer, index);
    return answer;
  };
  const workers = resolveWorkers(pool, total);
  // The claim is a single synchronous statement, so two workers cannot read the same value:
  // JavaScript runs it to completion before the other loop resumes. That is the only reason
  // a shared counter is safe here, and it is why the pool is not built from `Promise.all`
  // over a pre-sliced array -- slicing by worker would make a slow worker's slice the whole
  // pass's critical path and would make the index/worker binding invisible in the artifact.
  let next = 0;
  const claim = (): number => next++;

  const runWorker = async (worker: number): Promise<void> => {
    const workerSystem = pool === undefined ? system : pool.systemFor(worker);
    const accessors = accessorsFor(workerSystem);
    for (;;) {
      const index = claim();
      if (index >= total) {
        return;
      }
      const q = dataset.questions[index]!;
      // The budget is checked HERE, between questions, and that placement is the whole design.
      //
      // It cannot interrupt a request already in flight, and it does not pretend to: a hang
      // inside one call is the transport's problem and the retry layer's per-attempt timeout
      // is what bounds that. What this guarantees is that the **pass ends**. Run `38725510400`
      // hung for over five hours and never ended -- the workflow's `timeout-minutes: 240` did
      // not fire, so no `benchmark-error.log` was written at all, which is strictly worse than
      // the thin record the run before it left: a `TimeoutError` reaches `catch`, a hang
      // reaches nothing.
      //
      // Checked before the progress event so the event count is the number of questions this
      // pass STARTED, and the error carries the question it stopped before.
      const elapsed = performance.now() - startedAt;
      if (budgetMs !== undefined && elapsed > budgetMs) {
        throw new BenchmarkBudgetExceeded(
          {
            system: workerSystem.name,
            index,
            total,
            run,
            questionId: q.id,
            elapsedMs: elapsed,
          },
          budgetMs,
        );
      }
      // Before the answer call, so a throw inside it cannot skip the question it threw on.
      // See `BenchmarkProgress`. `run` is a parameter rather than something read here,
      // because a single pass over the dataset has no way to know which repetition it is
      // serving.
      //
      // Under a pool these events arrive in claim order, not in index order: they are start
      // events keyed by `index`, and a consumer that reads them as a sequence is reading a
      // coincidence. `elapsedMs` is taken here rather than inside the callback so every
      // consumer sees the same number for the same event.
      progress?.({
        system: workerSystem.name,
        index,
        total,
        run,
        questionId: q.id,
        elapsedMs: performance.now() - startedAt,
      });
      if (
        isSessionAware(workerSystem) &&
        q.capability === 'MR' &&
        q.sessions &&
        q.sessions.length > 0
      ) {
        // Multi-session questions aggregate evidence across sessions.
        record(await workerSystem.answerSessions(q.question, q.sessions), index);
      } else if (
        isSessionAware(workerSystem) &&
        q.capability === 'TR' &&
        workerSystem.answerTemporal
      ) {
        // Temporal questions need the question date as the reference point for
        // "how long ago" reasoning, plus a dedicated date-reading prompt.
        record(
          await workerSystem.answerTemporal(q.question, q.context, q.questionDate, q.sessions),
          index,
        );
      } else if (
        isSessionAware(workerSystem) &&
        q.capability === 'ABS' &&
        workerSystem.answerAbstention
      ) {
        // Abstention questions are answered with a conservative prompt so the model
        // recognizes the absence of an answer instead of being pushed to choose a
        // candidate. Routed before the assistant check because an ABS question may
        // carry a single-session-assistant type.
        record(await workerSystem.answerAbstention(q.question, q.context, q.sessions), index);
      } else if (
        isSessionAware(workerSystem) &&
        q.questionType === 'single-session-assistant' &&
        workerSystem.answerAssistant
      ) {
        // The evidence for single-session-assistant questions lives in an assistant
        // turn, so route to a path that includes assistant turns.
        record(await workerSystem.answerAssistant(q.question, q.context, q.sessions), index);
      } else if (
        isSessionAware(workerSystem) &&
        q.questionType === 'single-session-preference' &&
        workerSystem.answerPreference
      ) {
        // Preference/recommendation questions ask for a suggestion that reflects the
        // user's stated preferences, not a single extracted fact. The extractive answer
        // path would abstain on them, so route to a generative path instead.
        record(await workerSystem.answerPreference(q.question, q.context, q.sessions), index);
      } else if (
        isSessionAware(workerSystem) &&
        q.questionType === 'knowledge-update' &&
        workerSystem.answerKnowledgeUpdate
      ) {
        // Knowledge-update questions ask which value a time qualifier selects
        // (previous vs currently), which the generic extractive prompt does not
        // make explicit. Route to the time-qualifier-aware prompt instead.
        record(await workerSystem.answerKnowledgeUpdate(q.question, q.context, q.sessions), index);
      } else {
        record(await workerSystem.answer(q.question, q.context, q.sessions), index);
      }
      // Captured HERE, at the end of the iteration that produced the answer, and not after
      // the loop. Reading the accessor once at the end would report the last question's text
      // for every question, which is the defect the capture exists to prevent -- and under a
      // pool the same reasoning is what forces the accessors to be per-worker. The `index`
      // travels with each capture so a consumer can place it; the completion order is not a
      // usable key.
      if (onRawOutput !== undefined) {
        onRawOutput(accessors.rawOutput === undefined ? null : accessors.rawOutput(), index);
      }
      // Captured here for the same reason and at the same point: the slot describes the
      // question just answered. Kept as its own statement rather than folded into the block
      // above so that a run wanting only one of the two captures does not pay for the other.
      if (onRetrieved !== undefined) {
        onRetrieved(
          accessors.retrievedContext === undefined ? null : accessors.retrievedContext(),
          accessors.promptEvidence === undefined ? null : accessors.promptEvidence(),
          accessors.admittedEvidence === undefined ? null : accessors.admittedEvidence(),
          accessors.promptText === undefined ? null : accessors.promptText(),
          index,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, (_, worker) => runWorker(worker)));
  return answers;
}

/**
 * The pool's worker count, refusing a value that would silently serialize the pass.
 *
 * Three shapes are refused rather than coerced: a non-integer (a value like `2.5` would run
 * two workers and quietly drop the half), a value below one (a pass that opens no worker
 * never ends), and a non-finite one. Coercion is the wrong repair for all three because each
 * would produce a run whose configuration line says something the pass did not do.
 *
 * Capped at the number of questions so a pool never builds an instance it cannot use -- a
 * 60-question smoke run at `workers: 8` builds eight, and one at `workers: 500` builds 500
 * rather than 500 plus nothing.
 */
function resolveWorkers(pool: BenchmarkWorkerPool | undefined, total: number): number {
  if (pool === undefined) {
    return 1;
  }
  if (!Number.isInteger(pool.workers) || pool.workers < 1) {
    throw new Error(
      `workers must be a positive integer, received ${pool.workers} -- a fractional or zero ` +
        'worker count would run a pass whose configuration line describes something else',
    );
  }
  return Math.max(1, Math.min(pool.workers, total));
}

/**
 * Run a system and evaluate with an arbitrary scorer, returning per-question
 * correctness alongside the aggregate metrics. The correctness vector enables
 * paired tests (McNemar) that compare two systems on the SAME questions.
 *
 * `captureRawOutput` turns on the raw-output hook. It is off by default because
 * the capture is opt-in: a caller that does not ask for it gets a
 * `ScoredEvaluation` with no `rawOutputs` field rather than with an empty one,
 * so "not requested" stays distinguishable from "no model was consulted".
 *
 * `captureRetrievedContext` turns on the evidence hook, under the same rule. The
 * two are separate flags rather than one, because a run measuring what the model
 * was shown does not necessarily need what it said about it, and the reverse.
 *
 * That one hook yields **two** vectors, and they are not two flags because they
 * are never wanted apart: the captured context is what the reader was shown and
 * `promptEvidenceChars` is how much of it reached the prompt. See
 * `BenchmarkRetrievedCallback` for why neither is interpretable alone.
 *
 * A third vector comes from the same hook since `§13.168.8` -- the prompt text itself,
 * so the artifact can carry a fingerprint per question. It is taken under the same flag
 * because it is the same capture, and it is a fourth argument rather than a second hook
 * for the reason the first three travel together: a question's prompt, evidence and the
 * size of that evidence describe one request.
 */
export async function evaluateWithScorerDetailed(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  scorer: AnswerScorer,
  progress?: BenchmarkProgressCallback,
  run = 0,
  captureRawOutput = false,
  captureRetrievedContext = false,
  onAnswer?: BenchmarkAnswerCallback,
  /** Wall-clock ceiling for this pass. See {@link runBenchmark}'s second-to-last parameter. */
  budgetMs?: number,
  /** Workers in flight. See {@link BenchmarkWorkerPool}; absent means the serial pass. */
  pool?: BenchmarkWorkerPool,
): Promise<ScoredEvaluation> {
  const rawOutputs: (string | null)[] = [];
  const retrievedContexts: (RetrievedTurns | null)[] = [];
  const promptEvidenceChars: (number | null)[] = [];
  const admittedEvidence: (AdmittedEvidence | null)[] = [];
  const promptTexts: (string | null)[] = [];
  // Placed by index, not appended. Four vectors are captured from the same call and all four
  // are paired with `featureAnswers`/`correct[]` by question index downstream, so under a pool
  // a push would silently rotate every explanation one question out of phase -- a defect that
  // leaves every number in the artifact well-formed.
  const answers = await runBenchmark(
    dataset,
    system,
    progress,
    run,
    captureRawOutput
      ? (raw, index) => {
          rawOutputs[index] = raw;
        }
      : undefined,
    captureRetrievedContext
      ? (retrieved, chars, admitted, prompt, index) => {
          retrievedContexts[index] = retrieved;
          promptEvidenceChars[index] = chars;
          admittedEvidence[index] = admitted;
          promptTexts[index] = prompt;
        }
      : undefined,
    onAnswer,
    budgetMs,
    pool,
  );
  return scoreEvaluation(
    dataset,
    answers,
    scorer,
    captureRawOutput ? rawOutputs : undefined,
    captureRetrievedContext ? retrievedContexts : undefined,
    captureRetrievedContext ? promptEvidenceChars : undefined,
    captureRetrievedContext ? admittedEvidence : undefined,
    captureRetrievedContext ? promptTexts : undefined,
  );
}

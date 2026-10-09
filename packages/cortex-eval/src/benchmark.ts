/**
 * Benchmark runner: run a memory system over a dataset and evaluate its answers.
 */
import type {
  Answer,
  BenchmarkDataset,
  MemorySystem,
  Metrics,
  SessionAwareMemorySystem,
} from './types.js';
import {
  computeMetricsAsync,
  scoreEvaluation,
  type AnswerScorer,
  type ScoredEvaluation,
} from './metrics.js';

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
type BenchmarkRawOutputCallback = (raw: string | null) => void;

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
 * Not exported, for the reason `BenchmarkRawOutputCallback` is not: the only
 * caller is this module's own loop, and an export nothing outside could use is
 * the `1 NEW orphan(s)` the census gate reports.
 */
type BenchmarkRetrievedCallback = (retrieved: string | null) => void;

/** Run a system over every question, preserving question order. */
export async function runBenchmark(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  progress?: BenchmarkProgressCallback,
  run = 0,
  onRawOutput?: BenchmarkRawOutputCallback,
  onRetrieved?: BenchmarkRetrievedCallback,
): Promise<Answer[]> {
  const answers: Answer[] = [];
  const total = dataset.questions.length;
  // Resolved once rather than per question: the member either exists or it does
  // not, and a lookup per question would call `in` 500 times to learn the same
  // fact. The `bind` is what keeps `this` intact for the accessor.
  const rawOutput =
    onRawOutput === undefined
      ? undefined
      : 'lastRawOutput' in system
        ? (system as { lastRawOutput: () => string | null }).lastRawOutput.bind(system)
        : undefined;
  // Resolved once for the same reason, and from the same kind of structural check:
  // both accessors are optional capabilities rather than members of the injection
  // contract. `undefined` when the sink is absent, so the branch below is the only
  // place that has to know whether the capture is wanted.
  const retrievedContext =
    onRetrieved === undefined
      ? undefined
      : 'lastRetrievedContext' in system
        ? (system as { lastRetrievedContext: () => string | null }).lastRetrievedContext.bind(
            system,
          )
        : undefined;
  for (let index = 0; index < dataset.questions.length; index++) {
    const q = dataset.questions[index]!;
    // Before the answer call, so a throw inside it cannot skip the question it
    // threw on. See `BenchmarkProgress`. `run` is a parameter rather than
    // something read here, because a single pass over the dataset has no way to
    // know which repetition it is serving.
    progress?.({ system: system.name, index, total, run, questionId: q.id });
    if (isSessionAware(system) && q.capability === 'MR' && q.sessions && q.sessions.length > 0) {
      // Multi-session questions aggregate evidence across sessions.
      answers.push(await system.answerSessions(q.question, q.sessions));
    } else if (isSessionAware(system) && q.capability === 'TR' && system.answerTemporal) {
      // Temporal questions need the question date as the reference point for
      // "how long ago" reasoning, plus a dedicated date-reading prompt.
      answers.push(await system.answerTemporal(q.question, q.context, q.questionDate, q.sessions));
    } else if (isSessionAware(system) && q.capability === 'ABS' && system.answerAbstention) {
      // Abstention questions are answered with a conservative prompt so the
      // model recognizes the absence of an answer instead of being pushed to
      // choose a candidate. Routed before the assistant check because an ABS
      // question may carry a single-session-assistant type.
      answers.push(await system.answerAbstention(q.question, q.context, q.sessions));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'single-session-assistant' &&
      system.answerAssistant
    ) {
      // The evidence for single-session-assistant questions lives in an
      // assistant turn, so route to a path that includes assistant turns.
      answers.push(await system.answerAssistant(q.question, q.context, q.sessions));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'single-session-preference' &&
      system.answerPreference
    ) {
      // Preference/recommendation questions ask for a suggestion that reflects
      // the user's stated preferences, not a single extracted fact. The
      // extractive answer path would abstain on them, so route to a generative
      // path instead.
      answers.push(await system.answerPreference(q.question, q.context, q.sessions));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'knowledge-update' &&
      system.answerKnowledgeUpdate
    ) {
      // Knowledge-update questions ask which value a time qualifier selects
      // (previous vs currently), which the generic extractive prompt does not
      // make explicit. Route to the time-qualifier-aware prompt instead.
      answers.push(await system.answerKnowledgeUpdate(q.question, q.context, q.sessions));
    } else {
      answers.push(await system.answer(q.question, q.context, q.sessions));
    }
    // Captured HERE, at the end of the iteration that produced the answer, and
    // not after the loop. Reading the accessor once at the end would report the
    // last question's text for every question, which is the defect the capture
    // exists to prevent. It is also after the `push` rather than inside each
    // branch: seven branches is seven chances to forget one, and the routing
    // above is not what this hook measures.
    if (onRawOutput !== undefined) {
      onRawOutput(rawOutput === undefined ? null : rawOutput());
    }
    // Captured here for the same reason and at the same point: the slot describes
    // the question just answered, and reading it after the loop would report the
    // last question's evidence for every record. Kept as its own statement rather
    // than folded into the block above so that a run wanting only one of the two
    // captures does not pay for the other.
    if (onRetrieved !== undefined) {
      onRetrieved(retrievedContext === undefined ? null : retrievedContext());
    }
  }
  return answers;
}

/** Run a system and evaluate with an arbitrary (possibly async) scorer. */
export async function evaluateWithScorer(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  scorer: AnswerScorer,
  progress?: BenchmarkProgressCallback,
  run = 0,
): Promise<Metrics> {
  const answers = await runBenchmark(dataset, system, progress, run);
  return computeMetricsAsync(dataset, answers, scorer);
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
 */
export async function evaluateWithScorerDetailed(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  scorer: AnswerScorer,
  progress?: BenchmarkProgressCallback,
  run = 0,
  captureRawOutput = false,
  captureRetrievedContext = false,
): Promise<ScoredEvaluation> {
  const rawOutputs: (string | null)[] = [];
  const retrievedContexts: (string | null)[] = [];
  const answers = await runBenchmark(
    dataset,
    system,
    progress,
    run,
    captureRawOutput ? (raw) => rawOutputs.push(raw) : undefined,
    captureRetrievedContext ? (retrieved) => retrievedContexts.push(retrieved) : undefined,
  );
  return scoreEvaluation(
    dataset,
    answers,
    scorer,
    captureRawOutput ? rawOutputs : undefined,
    captureRetrievedContext ? retrievedContexts : undefined,
  );
}

/**
 * Benchmark runner: run a memory system over a dataset and evaluate its answers.
 */
import type {
  AdmittedEvidence,
  Answer,
  BenchmarkDataset,
  DeliveredRoleCensus,
  MemorySystem,
  RetrievedTurns,
  SessionAwareMemorySystem,
} from './types.js';
import { ProviderContentRefusal, type RetryExhaustion } from '@agentix-e/cortex-ai';
import { scoreEvaluation, type AnswerScorer, type ScoredEvaluation } from './metrics.js';

/**
 * One question a provider's moderation gate refused to read.
 *
 * Carries the capability and question type because the count alone cannot say whether the loss is
 * spread or concentrated: a filter that refuses three `ABS` questions has moved the abstention
 * column by three and left the accuracy comparison alone, while three `MR` refusals move the column
 * the gap is stated in. `providerCode` is the provider's own word for the refusal, kept so a later
 * reader can tell a Zhipu `1301` from a gateway's `content_policy_violation` without the log.
 */
type ProviderRefusalRecord = {
  readonly questionId: string;
  readonly capability: string;
  readonly questionType: string | null;
  readonly providerCode: string | null;
};

/**
 * Every refusal this process has decided, in arrival order.
 *
 * Process-wide and cumulative, mirroring `scorerChannelStats` and for the same reason: the arm that
 * observes the count is three frames above the worker that produces it, and one process serves one
 * run. Tests assert the CHANGE between two reads rather than a zeroed counter, which is the stronger
 * assertion -- a counter that could be cleared could satisfy the weaker one.
 */
const refusals: ProviderRefusalRecord[] = [];

/** A copy, so a caller cannot mutate the record it was handed. */
export function providerRefusals(): readonly ProviderRefusalRecord[] {
  return refusals.map((record) => ({ ...record }));
}

/**
 * Narrowing predicate for the one error class a per-question catch may decide.
 *
 * `instanceof` alone is not enough across a workspace where a package can be resolved twice, so the
 * name is checked as a fallback -- the same shape `cortex-ai`'s retry layer uses for its own refusal
 * object, and the reason `ProviderContentRefusal` sets `name` in its constructor.
 */
function isProviderContentRefusal(err: unknown): err is ProviderContentRefusal {
  return (
    err instanceof ProviderContentRefusal ||
    (err instanceof Error && err.name === 'ProviderContentRefusal')
  );
}

/**
 * One line naming how many questions the provider refused, and where.
 *
 * Printed on every run rather than only when non-zero: `0` is the statement that every question
 * reached the model, and a line that appears only on failure leaves a reader unable to tell "no
 * refusals" from "this log predates the counter".
 */
export function describeProviderRefusals(records: readonly ProviderRefusalRecord[]): string {
  if (records.length === 0) {
    return 'provider refusals: 0';
  }
  const byCapability = new Map<string, number>();
  for (const record of records) {
    byCapability.set(record.capability, (byCapability.get(record.capability) ?? 0) + 1);
  }
  const spread = [...byCapability.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([capability, count]) => `${capability} ${count}`)
    .join(', ');
  return `provider refusals: ${records.length} (${spread}) — counted as unanswered, kept in the denominator`;
}

/**
 * One question lost because every attempt reached the per-attempt deadline.
 *
 * ## The run this exists for
 *
 * `42381840503` read 291 of 500 questions on a reasoning reader and then died on
 * `{"attempts":2,"retried":1,"elapsedMs":601000,"attemptsMs":[299999,300001],"timeoutMs":300000}`.
 * Both attempts reached the bound; the throw unwound `Promise.all`; the pass produced an
 * `INCOMPLETE` partial with no delta. **One question's latency destroyed 209 other questions'
 * measurements and the comparison they were for** -- the same shape as `42368550937`'s moderation
 * refusal one round earlier, and the same repair: a fact about one question is decided per question.
 *
 * ## Why the record carries the deadline and the attempt durations
 *
 * Because the only other place they appear is the `retryExhausted` object attached to an error that
 * is thrown away once the question is decided. `timeoutMs` beside `attemptsMs` is what separates
 * "the deadline fired on a slow answer" from "the socket died twice at 3 s" -- two losses that look
 * identical in a count and call for opposite responses (raise the bound vs. re-dispatch the run).
 */
type TransportLossRecord = {
  readonly questionId: string;
  readonly capability: string;
  readonly questionType: string | null;
  readonly run: number;
  /**
   * Which exhaustion the provider produced.
   *
   * The two kinds are one family -- the quota ran out, on the clock or on the rate -- and they are
   * kept apart because their **repairs differ**: a deadline loss is answered by
   * `CORTEX_READER_TIMEOUT_MS`, a rate-limit loss by `CORTEX_LLM_MIN_INTERVAL_MS` or a larger
   * quota. A single counter would send a reader to the wrong knob, and the wrong knob is
   * indistinguishable from no advice at all.
   */
  readonly kind: 'deadline' | 'rate-limit';
  /** Requests issued before the loss, including the first attempt. */
  readonly attempts: number;
  /** The per-attempt deadline those attempts were given. */
  readonly timeoutMs: number;
  /** Wall-clock milliseconds from the first attempt to the last deadline. */
  readonly elapsedMs: number;
};

/**
 * Every transport loss this process has decided, in arrival order.
 *
 * Process-wide like `refusals`, and for the same reason: the arm that prints the line is several
 * frames above the worker that produces it. The ceiling below is per pass, not per process, because
 * one process serves several runs and a shared counter would refuse a fourth run for the first
 * three's losses.
 */
const transportLosses: TransportLossRecord[] = [];

/**
 * A copy of the losses, optionally of one kind.
 *
 * ## Why one accessor with a filter instead of three functions
 *
 * The two kinds share one list, because they share one ceiling, so `lostToDeadline` and
 * `lostToRateLimit` were filters over this function rather than arrays of their own -- and a filter
 * only a test calls is an export with no caller, which is what `tools/export-census.mjs` refuses.
 * It was right to refuse: three names for one list invites a fourth kind to arrive as a fourth
 * function. The parameter says the shape of the question instead.
 *
 * A copy, so a caller cannot mutate the record the report is derived from.
 */
export function lostToTransport(
  kind?: TransportLossRecord['kind'],
): readonly TransportLossRecord[] {
  const all = transportLosses.map((record) => ({ ...record }));
  return kind === undefined ? all : all.filter((record) => record.kind === kind);
}

/**
 * The share of a pass that may be lost to deadlines before the pass stops being a measurement.
 *
 * ## Why a ceiling exists at all, when a loss is recorded as a wrong answer
 *
 * Recording a loss as `''` is conservative -- it fails every channel of the scorer -- so a single
 * loss cannot flatter an arm. A **hundred** losses are a different claim: an endpoint that stopped
 * answering, or a deadline smaller than any of this reader's real answers, produces 500 empty
 * strings and an accuracy near zero that is arithmetically indistinguishable from a memory system
 * that forgot everything. The pass has to stop being a number at the point where it stops describing
 * the system, and 2% is where this campaign has put that line: ten questions of five hundred, which
 * is larger than any single-question stall observed (`42381840503` lost one in 291) and smaller than
 * any outage (a stalled endpoint loses four per deadline period, one per worker).
 */
const MAX_DEADLINE_LOSS_FRACTION = 0.02;

/**
 * How many questions a pass of `total` may lose to deadlines before it stops being a measurement.
 *
 * Exported rather than left inside the catch because the entry point prints it on the gate line: a
 * ceiling a run enforces and a reader cannot see is the same defect as a bound that only appears in
 * the error object of the question that reached it (§13.306). At 500 questions it is ten, and the
 * arithmetic is here rather than in a `console.log` so the printed number and the enforced one are
 * one expression.
 *
 * The floor of one is what makes a smoke dispatch readable: 2% of 20 questions rounds to nothing,
 * and a pass that can tolerate zero losses would die on the first one -- which for a 20-question
 * smoke of a reader with a heavy tail is a dispatch that never produces a number.
 */
export function deadlineLossCeiling(total: number): number {
  return Math.max(1, Math.ceil(total * MAX_DEADLINE_LOSS_FRACTION));
}

/**
 * The exhaustion object, when every attempt of a call reached the per-attempt deadline.
 *
 * ## Why "every" and not "any"
 *
 * A call whose first attempt hit the deadline and whose retry died on a reset socket has a mixed
 * cause, and classifying it as a deadline loss would let a broken network be reported as a slower
 * model. The all-attempts condition is the narrow reading, and the wide one buys nothing: a genuine
 * deadline loss on this reader reached the bound on both attempts (299,999 and 300,001 ms).
 *
 * The tolerance exists because `AbortSignal` fires on a timer and the recorded duration is measured
 * around it -- the second attempt above is *one millisecond over* its own deadline, and an exact
 * comparison would classify the clearest loss in the campaign as a wire fault.
 *
 * ## Why the tolerance has a floor as well as a fraction
 *
 * One per cent of 300,000 ms is three seconds, which is the slack the campaign's own reading needed.
 * One per cent of **500 ms** is five milliseconds, which is less than the event-loop delay of a loaded
 * machine -- and the failure that exposed it was exactly that: the suite's deadline tests run with a
 * 500 ms budget, and under a full `pnpm check` (five packages, every worker busy) an attempt was
 * aborted *late* by the timer, recorded a duration a few milliseconds under the deadline, failed the
 * classification and was **re-thrown** by the caller's `exhaustion === null` branch, which is by design
 * for a malformed body and fatal for a deadline. The pass died on a question it should have counted as
 * lost.
 *
 * So the slack is `max(25 ms, 1% of the deadline)`: 25 ms is above the scheduling jitter of a loaded
 * event loop and below any real deadline this arm dispatches, and at 300 s the fraction still governs.
 * Written as `deadlineReached` rather than inline so the two regimes can be tested without a clock.
 */
export function deadlineReached(attemptMs: number, timeoutMs: number): boolean {
  return attemptMs >= timeoutMs - Math.max(25, timeoutMs * 0.01);
}

function deadlineExhaustion(err: unknown): RetryExhaustion | null {
  if (!(err instanceof Error)) return null;
  const exhaustion = (err as { readonly retryExhausted?: RetryExhaustion }).retryExhausted;
  if (exhaustion === undefined || exhaustion.attemptsMs.length === 0) return null;
  const reached = exhaustion.attemptsMs.every((attemptMs) =>
    deadlineReached(attemptMs, exhaustion.timeoutMs),
  );
  return reached ? exhaustion : null;
}

/**
 * The exhaustion object, when every attempt of a call was answered `429`.
 *
 * ## Why this is the deadline rule's twin
 *
 * `deadlineExhaustion` reads the same `retryExhausted` object and asks a structurally identical
 * question: **did every attempt fail for the same external reason?** There it is "the clock reached
 * the bound on all of them"; here it is "the provider refused on all of them". Both are facts about
 * the endpoint's allowance rather than about the system under test, and both are therefore one
 * question's loss rather than the pass's.
 *
 * ## Why mixed causes are still fatal
 *
 * `rateLimited === attempts` is the narrow reading, deliberately. A call whose first attempt was
 * answered `429` and whose retry died on a reset socket has two causes and neither explains it;
 * classifying that as a quota loss would let a broken network be reported as a busy provider, which
 * is the same class of error `deadlineExhaustion` refuses by requiring `every`.
 *
 * ## Why the run that prompted this had to be re-read to find it
 *
 * `42381702081` reports `attempts: 1613, rateLimited: 28` at the process level and then dies of
 * `attempts-exhausted` on one call. The process totals are not the discriminator and never were: 28
 * throttled requests out of 1,613 is a healthy arm, and the loss is that **one call** collected nine
 * of them in a row. A rule written on the process share would have called this a defect; the rule
 * written on one call's vector calls it what it is.
 */
function rateLimitExhaustion(err: unknown): RetryExhaustion | null {
  if (!(err instanceof Error)) return null;
  const exhaustion = (err as { readonly retryExhausted?: RetryExhaustion }).retryExhausted;
  if (exhaustion === undefined || exhaustion.attempts === 0) return null;
  return exhaustion.rateLimited === exhaustion.attempts ? exhaustion : null;
}

/**
 * One line naming how many questions the transport took, split by kind, with the ceiling in it.
 *
 * Printed on every run, for the reason `describeProviderRefusals` is: `0` is a statement, and a
 * line that appears only on failure leaves "no losses" and "this log predates the counter"
 * indistinguishable.
 *
 * ## Why the ceiling is a parameter and not a recomputation
 *
 * A renderer that called `deadlineLossCeiling(total)` itself would be a second implementation of
 * the number the catch enforces, and the two could disagree — visibly only on a failed run, which
 * is the run nobody re-reads. The caller passes the value it enforced.
 *
 * ## Why each kind names its own knob
 *
 * The whole reason `kind` exists in the record. A single sentence ("raise the bound") would be
 * wrong for half the losses it described, and advice that is wrong half the time is worse than no
 * advice: it is a dispatch someone makes twice.
 */
export function describeTransportLosses(
  records: readonly TransportLossRecord[],
  total: number,
): string {
  const ceiling = deadlineLossCeiling(total);
  if (records.length === 0) {
    return `transport losses: 0 (ceiling ${ceiling} of ${total}) — every question was answered`;
  }
  const spreadOf = (kind: TransportLossRecord['kind']): string | null => {
    const ofKind = records.filter((record) => record.kind === kind);
    if (ofKind.length === 0) return null;
    const byCapability = new Map<string, number>();
    for (const record of ofKind) {
      byCapability.set(record.capability, (byCapability.get(record.capability) ?? 0) + 1);
    }
    const spread = [...byCapability.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([capability, count]) => `${capability} ${count}`)
      .join(', ');
    const label = kind === 'deadline' ? 'deadline' : 'rate limit';
    // The bound is rendered for deadlines only, and it is not decoration: `300000 ms` is the
    // thinking default and `600000 ms` is a declared `CORTEX_READER_TIMEOUT_MS`, so the number tells
    // a reader whether the loss came from the knob they were tuning or from one they never set. A
    // rate-limit loss has no bound to name -- `timeoutMs` on that record is the per-attempt deadline
    // the request was given, which is not what ran out.
    if (kind === 'rate-limit') {
      return `${label} ${ofKind.length} (${spread})`;
    }
    const bounds = [...new Set(ofKind.map((record) => record.timeoutMs))]
      .sort((a, b) => a - b)
      .map((ms) => `${ms} ms`)
      .join(', ');
    return `${label} ${ofKind.length} (${spread}) at ${bounds}`;
  };
  const parts = [spreadOf('deadline'), spreadOf('rate-limit')].filter(
    (part): part is string => part !== null,
  );
  const knobs = [
    records.some((record) => record.kind === 'deadline') ? 'CORTEX_READER_TIMEOUT_MS' : null,
    records.some((record) => record.kind === 'rate-limit') ? 'CORTEX_LLM_MIN_INTERVAL_MS' : null,
  ].filter((knob): knob is string => knob !== null);
  return (
    `transport losses: ${records.length} of ${total} (ceiling ${ceiling}) — ${parts.join('; ')} — ` +
    `recorded as no output, kept in the denominator; the knobs are ${knobs.join(' and ')}`
  );
}

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
type BenchmarkRetrievedCallback = (capture: RetrievalCapture, index: number) => void;

/**
 * Everything one capture yields about the question it was taken for.
 *
 * ## Why this became an object
 *
 * It was six positional parameters, and the sixth was the reason to stop: the route and the role census
 * are the fifth and sixth facts about **one request**, and a callback that took them in order would have
 * made a caller that wanted only the last one spell four `null`s. The four that were already here are one
 * fact each, and each of them was added one at a time by a round that needed it.
 *
 * The two new ones are added together because they answer the two halves of one question an audit could
 * not settle from the artifact: **which path did this question take**, and **which roles did the window it
 * was shown actually contain**. Screening run `43465626013` failed its own audit with
 * `FAIL roles evidenceRoles=['user'] on ['multi-session','temporal']`, and the artifact held neither field —
 * so the reading required reconstructing four records by hand, which found a third answer neither the
 * audit nor its reader had.
 *
 * `route` is a plain `string` rather than the product's `TurnCapRoute` for the reason every type in this
 * package is: the dependency runs the other way. `null` means the system does not report one, which is a
 * different statement from "it took the flat path" and is kept different.
 */
type RetrievalCapture = {
  /** The turns the reader was shown. See {@link RetrievedTurns}. */
  readonly context: RetrievedTurns | null;
  /** The prompt characters the evidence took, after the builder's budget. */
  readonly promptEvidenceChars: number | null;
  /** The offer, before any budget. See {@link AdmittedEvidence}. */
  readonly admittedEvidence: AdmittedEvidence | null;
  /** The prompt itself, for the fingerprint. */
  readonly promptText: string | null;
  /**
   * The path the product says this question took; `null` when it does not report one.
   *
   * Read instead of inferring it from a dataset's `capability`, because those are two vocabularies: a `TR`
   * question falls through to the flat path when the system does not declare `answerTemporal`, and `ABS`
   * can carry `single-session-assistant`. An audit that checks a role filter against a capability is
   * checking it against a path the question may never have taken.
   */
  readonly route: string | null;
  /** The roles the delivered window carried, by the product's own classifier. */
  readonly roleCensus: DeliveredRoleCensus | null;
};

/**
 * The two vectors a retrieval capture produces beyond the four it already produced.
 *
 * Declared as a separate shape and intersected into the evaluation rather than threaded through
 * `scoreEvaluation`'s argument list, which already carries five optional vectors. The distinction that
 * matters is where they are **produced**: `scoreEvaluation` computes metrics from answers and attaches the
 * captures it is handed, while these two are collected by the loop that ran the questions. Keeping them a
 * separate intersection says that, where adding two more optional parameters would have said the
 * scorer is where a route comes from.
 */
export type RetrievalCaptureVectors = {
  /** Per question: the route the product reported, or `null`. */
  readonly routes?: readonly (string | null)[];
  /** Per question: the delivered window's role census, or `null`. */
  readonly roleCensuses?: readonly (DeliveredRoleCensus | null)[];
};

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
    // The two facts about the request that the four above do not carry: which path the question took, and
    // which roles the window it was shown actually contained. Resolved under the same rule and at the same
    // point as the four, because a run that captures one of them and not the others has no use for any of
    // them -- the whole capture is one request.
    //
    // Optional capabilities rather than members of the injection contract, so a system that does not report
    // them costs nothing and reaches the record as **absent**. That is what keeps a `null` here meaning "this
    // system cannot say" rather than "this question had no route".
    route:
      onRetrieved === undefined
        ? undefined
        : 'lastRoute' in worker
          ? (worker as { lastRoute: () => string | null }).lastRoute.bind(worker)
          : undefined,
    roleCensus:
      onRetrieved === undefined
        ? undefined
        : 'lastRoleCensus' in worker
          ? (worker as { lastRoleCensus: () => DeliveredRoleCensus | null }).lastRoleCensus.bind(
              worker,
            )
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
  // Per pass, not per process: one process answers several runs, and a process-wide counter would
  // refuse a fourth run for the first three's losses. Incremented under the same single-threaded
  // claim rule as `next`. One counter for both kinds of transport loss, because the ceiling they
  // share is a statement about the pass rather than about which knob ran out.
  let transportLossCount = 0;

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
      // One question's prompt is not one question's measurement.
      //
      // Run `42368550937` answered 83 of 500 in 1,003 seconds, then Zhipu refused
      // `gpt4_2f8be40d`'s prompt with `400 ... "contentFilter"` and the throw unwound the pass:
      // two hours of a four-worker run discarded, no report written, `failure` with `reached 83`.
      // The transport was right (a 400 is not retryable) and the arm was right; what was missing
      // is that a provider's moderation decision is a fact about **that question**, not about the
      // pass. So exactly that one class is decided here and everything else still crashes: a
      // malformed body, a bad key, a schema error and an exhausted retry ladder are defects that
      // fail identically on all 500 questions, and catching them would turn a broken arm into a
      // quiet accuracy number.
      //
      // A second class is decided here, for a reason the first one's round did not have to state:
      // `42381840503` answered 291 questions and then lost the pass to
      // `attemptsMs=[299999,300001], timeoutMs=300000` -- **both** attempts reached the deadline, so
      // the loss was the deadline's, not the network's, and the arm's third of a suite was thrown
      // away on a bound that lived in a module constant. A deadline that one question reaches and
      // the other 499 do not is a fact about that question's latency; the transport is fine and the
      // arm is fine.
      //
      // Both classes record `''` -- the arm produced no answer -- and both stay in the denominator.
      // Dropping either would be the favourable half of a selection: the questions a filter refuses
      // or a deadline eats are not a random sample, so removing them would raise the score of an arm
      // that answered fewer questions. `''` and not `null` for both: `null` is this repository's word
      // for "the arm declined", which `judgeScorer` scores CORRECT against an unanswerable gold, so
      // a refusal or a stall recorded as a decline would hand the abstention column a free pass on
      // exactly the questions that fail hardest.
      try {
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
          record(
            await workerSystem.answerKnowledgeUpdate(q.question, q.context, q.sessions),
            index,
          );
        } else {
          record(await workerSystem.answer(q.question, q.context, q.sessions), index);
        }
      } catch (err) {
        // Two classes are decided here and the shapes are deliberately disjoint: a `if`/`else` rather
        // than a guard clause, because the first version of this block let a deadline loss fall
        // through into the refusal branch -- so one timeout was counted twice, as a loss and as a
        // provider refusal, and `providerRefusals()` would have reported a filter that never fired.
        // The mutation that caught it was `record('', index)` -> `record(null, index)`: nothing
        // failed, because the second write overwrote the first.
        if (isProviderContentRefusal(err)) {
          // Not retried, by design: the same prompt against the same filter is the same decision, so
          // an attempt is certain waste.
          //
          // `record('')` and not `record(null)`, and the difference is worth a paragraph because it
          // is four points of a column. `null` is this repository's word for **the arm declined**,
          // and `judgeScorer` scores a declined answer against an `expected === null` question as
          // CORRECT -- correct, because declining an unanswerable question is what the abstention
          // gold asks for. A moderation refusal is not a decline: the arm never produced anything.
          // Recording it as a decline would hand the `ABS` column a free pass on exactly the
          // questions most likely to be filtered, which are the personal ones, which is the column
          // `ABS` is made of. The empty string is the honest third state -- no output -- and it
          // fails every channel of `judgeScorer` on its own terms rather than by a special case
          // bolted onto the scorer.
          //
          // The artifact keeps the distinction visible: `null` and `''` are different values in the
          // answers vector, so a later reader can tell a refusal from a decline without the log.
          refusals.push({
            questionId: q.id,
            capability: q.capability,
            questionType: q.questionType ?? null,
            // `err` is narrowed by the guard above, so `instanceof` here was a second test of a
            // fact already established -- and its `: null` arm was unreachable by construction: a
            // value the guard rejects never reaches this line. The branch showed up as the last
            // two uncovered branches in this file, which is what an unreachable arm looks like.
            providerCode: err.providerCode,
          });
          record('', index);
        } else {
          // Three classes are decided in this function and these two are the same family: the
          // provider's allowance ran out, on the clock or on the rate. Both are facts about the
          // endpoint rather than about the system under test, so both are one question's loss.
          //
          // `deadline` is tested first and `rateLimit` only when it is null, which is not an
          // optimisation: an object that satisfies both is one whose attempts each reached the
          // deadline AND were answered `429`, and the deadline reading is the narrower claim --
          // a request that was aborted on the clock never saw the provider's answer at all.
          const deadline = deadlineExhaustion(err);
          const rateLimit = deadline === null ? rateLimitExhaustion(err) : null;
          const exhaustion = deadline ?? rateLimit;
          if (exhaustion === null) {
            // Everything else still crashes, by design: a malformed body, a bad key and a schema
            // error fail identically on all 500 questions, and catching them would turn a broken
            // arm into a quiet accuracy number. A **mixed** exhaustion is here too -- one attempt
            // throttled and one dead on the wire has two causes and neither explains it.
            throw err;
          }
          const kind: TransportLossRecord['kind'] = deadline === null ? 'rate-limit' : 'deadline';
          // Recorded before the ceiling is checked, so the record names every loss including the one
          // that ended the pass.
          transportLosses.push({
            questionId: q.id,
            capability: q.capability,
            questionType: q.questionType ?? null,
            run,
            kind,
            attempts: exhaustion.attempts,
            timeoutMs: exhaustion.timeoutMs,
            elapsedMs: exhaustion.elapsedMs,
          });
          transportLossCount += 1;
          // `''` for the reason the refusal above records `''`, and it is the same reason twice: a
          // stall produced no output, and `null` would be read as a decline.
          record('', index);
          // ## Why the pass ends at a share rather than at one loss
          //
          // One loss is conservative: it is scored as a wrong answer. Ten are a different claim --
          // an endpoint that stopped answering, or a bound smaller than every answer this reader
          // gives, produces 500 empty strings and an accuracy near zero that is arithmetically
          // indistinguishable from a memory system that forgot everything. Past the share the pass
          // is no longer describing the system under test, so it throws and the entry point writes
          // the partial record the workflow reads.
          //
          // `>` rather than `>=`: the ceiling is the number of losses tolerated, not the first one
          // that is fatal. At 500 questions that is ten, and a pass that dies on the eleventh is
          // telling the truth about the endpoint; a pass that died on the first would be a smoke
          // run killed by the tail its own reader has.
          //
          // **One ceiling for both kinds.** The question the ceiling answers is "is this pass still
          // describing the system under test", and half the entries lost to the clock plus half to
          // the quota is the same answer as all of them lost to one. Two ceilings would also create
          // a pass that could lose 4% of its entries while each counter stayed under its own bound.
          const ceiling = deadlineLossCeiling(total);
          if (transportLossCount > ceiling) {
            // The advice is per kind, because the repairs differ and advice that is wrong half the
            // time is worse than none: a reader who raised `CORTEX_READER_TIMEOUT_MS` against a
            // quota problem would re-dispatch and lose the next pass the same way.
            const guidance =
              kind === 'rate-limit'
                ? `The last loss was a rate limit: every one of its ${exhaustion.attempts} attempts ` +
                  'was answered 429. Raise CORTEX_LLM_MIN_INTERVAL_MS, or use an account with a ' +
                  'larger quota, and re-dispatch rather than reading the number this pass would produce.'
                : `The last loss was a deadline at ${exhaustion.timeoutMs} ms — raise ` +
                  'CORTEX_READER_TIMEOUT_MS if the reader needs longer, and re-dispatch rather than ' +
                  'reading the number this pass would produce.';
            throw new Error(
              `transport losses reached ${transportLossCount} of ${total} (ceiling ${ceiling}, ` +
                `${Math.round(MAX_DEADLINE_LOSS_FRACTION * 100)}%): at this share the pass measures ` +
                `the endpoint rather than the system under test. ${guidance}`,
            );
          }
          // No `continue` and no skip: the prompt for this question **was** built and sent, and the
          // capture below is what proves the two arms sent the same bytes on it. Skipping it would
          // leave the prompt-digest vector short by exactly the questions a slow reader lost, which
          // is the comparison `R0` exists to make.
        }
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
          {
            context: accessors.retrievedContext === undefined ? null : accessors.retrievedContext(),
            promptEvidenceChars:
              accessors.promptEvidence === undefined ? null : accessors.promptEvidence(),
            admittedEvidence:
              accessors.admittedEvidence === undefined ? null : accessors.admittedEvidence(),
            promptText: accessors.promptText === undefined ? null : accessors.promptText(),
            route: accessors.route === undefined ? null : accessors.route(),
            roleCensus: accessors.roleCensus === undefined ? null : accessors.roleCensus(),
          },
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
): Promise<ScoredEvaluation & RetrievalCaptureVectors> {
  const rawOutputs: (string | null)[] = [];
  const retrievedContexts: (RetrievedTurns | null)[] = [];
  const promptEvidenceChars: (number | null)[] = [];
  const admittedEvidence: (AdmittedEvidence | null)[] = [];
  const promptTexts: (string | null)[] = [];
  const routes: (string | null)[] = [];
  const roleCensuses: (DeliveredRoleCensus | null)[] = [];
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
      ? (capture, index) => {
          retrievedContexts[index] = capture.context;
          promptEvidenceChars[index] = capture.promptEvidenceChars;
          admittedEvidence[index] = capture.admittedEvidence;
          promptTexts[index] = capture.promptText;
          routes[index] = capture.route;
          roleCensuses[index] = capture.roleCensus;
        }
      : undefined,
    onAnswer,
    budgetMs,
    pool,
  );
  const scored = await scoreEvaluation(
    dataset,
    answers,
    scorer,
    captureRawOutput ? rawOutputs : undefined,
    captureRetrievedContext ? retrievedContexts : undefined,
    captureRetrievedContext ? promptEvidenceChars : undefined,
    captureRetrievedContext ? admittedEvidence : undefined,
    captureRetrievedContext ? promptTexts : undefined,
  );
  // Intersected rather than handed to `scoreEvaluation`, and conditional on the same flag as the four above:
  // a run that did not ask for the capture gets an evaluation with **no** such field rather than with an
  // all-`null` vector, so "not requested" stays distinguishable from "every system declined to report" --
  // the rule `captureRawOutput` states for its own vector.
  return captureRetrievedContext ? { ...scored, routes, roleCensuses } : scored;
}

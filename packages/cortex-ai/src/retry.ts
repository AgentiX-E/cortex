/**
 * Retry/backoff helpers shared by the LLM and embedding adapters. Remote
 * providers rate-limit (429) and occasionally fail transiently (5xx), so a
 * large benchmark can exhaust a per-minute quota unless requests are retried
 * with exponential backoff.
 *
 * ## Why the retry budget is a duration, not an attempt count
 *
 * The budget used to be `maxRetries`, and the total sleep it implied was
 * `base * (2 ** retries - 1) = 31 s` at the defaults. That is shorter than a
 * minute-scale throttle window, so every retry landed inside the window that had
 * just rejected the request and the run exhausted its budget without the
 * provider ever being given a chance to recover. Raising the count would have
 * appeared to fix it, but only by accident: what has to be exceeded is a
 * duration, and an attempt count implies a different duration for every
 * `baseDelayMs`. `retryBudgetMs` states the requirement directly.
 *
 * ## Why `Retry-After` is read
 *
 * The header is the provider naming its own window. Discarding it and sleeping a
 * computed backoff is the client guessing at a quantity the server already
 * published, and it guesses wrong in both directions: too short and the retry is
 * rejected again, too long and a recoverable run wastes wall-clock time. It is
 * read for every retryable status, not only 429, because 503 carries it too.
 */

import type { RequestPacer } from './pacing.js';

/** Whether an HTTP status should be retried (rate limit or transient server error). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default number of attempts (1 initial + `maxRetries` retries).
 *
 * ## Why eight, and why this constant is derived from the budget rather than chosen
 *
 * The budget below is 120 s and says why it exists: a throttle window measured in minutes
 * has to be reachable. At the previous value of 5 the waits were `1+2+4+8+16 = 31 s` and
 * the sixth attempt was already the last one, so the budget was 3.9x the ladder and could
 * never be consulted. The protection was unimplemented in practice while reading as
 * implemented, which is the same shape as a guard whose firing condition cannot occur.
 *
 * What that cost is run `41346610318`: a 20-question probe answered `429` at question 13,
 * dead inside the 31 s ladder, twelve graded answers left in a partial artifact. The
 * provider's window is per minute; two minutes of permitted waiting would have outlasted
 * it.
 *
 * Eight is the smallest count whose geometric sum exceeds the default budget
 * (`1+2+4+…+128 = 255 s`), so the budget binds and the count does not. A caller that names
 * a count still gets exactly that count — the defect was the default, not the parameter,
 * and `retry.test.ts` pins both halves.
 */
export const DEFAULT_MAX_RETRIES = 8;
/** Initial backoff delay in milliseconds; doubles on each retry. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
/**
 * Default wall-clock ceiling on retries, in milliseconds.
 *
 * Larger than 60 s on purpose: a throttle window measured in minutes has to be
 * reachable, and a budget at or below one minute would reproduce the original
 * defect with the code nominally fixed.
 *
 * ## A ceiling is only a ceiling if the ladder can reach it
 *
 * This number was 120 s from the day it was written, and for the same period the ladder
 * topped out at **31 s** — the ceiling was never once consulted, because the attempt count
 * bound first. The requirement has two halves and the second is easy to forget: the counts
 * in {@link DEFAULT_MAX_RETRIES} must let the geometric backoff sum past this value, and
 * the last wait must be truncated to whatever remains so the final attempt lands on the
 * deadline instead of half a ceiling short. Both are asserted in `retry.test.ts`, together
 * with the identity `last attempt time === DEFAULT_RETRY_BUDGET_MS`.
 *
 * ## The third half: the per-attempt deadline has to leave the ladder something
 *
 * The budget is measured from the first attempt, so an attempt that runs long spends it. That
 * is right for a client whose attempts are seconds long and wrong for one whose attempts are
 * minutes: run `41393748964` ran thinking mode with a 300 s per-attempt deadline against this
 * 120 s ceiling, so **a single stalled attempt consumed the whole budget and no retry was ever
 * possible** -- the same shape as the count defect above, one parameter over. The composer of
 * the pair has to keep `retryBudgetMs > timeoutMs`; `llm-factory` states and tests that
 * inequality for the one caller with a five-minute deadline.
 */
export const DEFAULT_RETRY_BUDGET_MS = 120_000;
/**
 * Default per-attempt deadline in milliseconds.
 *
 * Retrying only helps when an attempt actually SETTLES. A request that is
 * accepted and then stalls — a reset or half-open connection — leaves the loop
 * awaiting a promise that never settles, so `maxRetries` never gets to run and
 * the caller hangs forever. A full benchmark run was lost that way to
 * `TypeError: terminated`.
 */
export const DEFAULT_RETRY_TIMEOUT_MS = 60_000;

/**
 * Parse a `Retry-After` header value into a delay in milliseconds.
 *
 * Returns `null` when the header is absent or unparseable, which is a different
 * answer from `0`: "the server named no delay" means fall back to the computed
 * backoff, while "the server named zero delay" means retry immediately. Folding
 * the two together would make an unparseable header indistinguishable from an
 * explicit instruction to retry at once.
 *
 * Accepts both forms the RFC allows — a delta-seconds integer and an HTTP-date —
 * plus a fractional-seconds value, which some providers emit. A parser handling
 * only the integer form would silently fall back to the computed backoff against
 * a date-emitting provider, a failure indistinguishable from an absent header.
 *
 * A date in the past yields `0` rather than a negative number. Clock skew
 * between client and server can produce one, and a negative delay would let a
 * caller that subtracts it from a budget compute a larger budget than it had.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  // delta-seconds, integer or fractional. Anchored so that `1.5.5`, `-5` and
  // `30 seconds` are rejected rather than partially matched: a partial match
  // would read `30 seconds` as 30 and hide a malformed header behind a
  // plausible number.
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    // Rounded up at millisecond precision: waiting slightly too long costs a
    // little wall-clock, waiting too little costs another rejected request.
    return Math.ceil(Number(trimmed) * 1000);
  }
  // The date branch is gated on the value LOOKING like an HTTP-date before
  // `Date.parse` is consulted, and that gate is not defensive coding.
  // `Date.parse` is far more permissive than the header syntax: it accepts
  // `-5` (read as a year), `1.5.5` (read as 2005) and every other numeric
  // fragment the delta-seconds branch already rejected, turning each into a
  // date decades in the past and therefore into `0` — "retry immediately",
  // which is the opposite of what a malformed throttle hint should mean.
  //
  // The three forms the RFC allows: `Sun, 06 Nov 1994 08:49:37 GMT`,
  // `Sunday, 06-Nov-94 08:49:37 GMT` and `Sun Nov  6 08:49:37 1994`. Requiring
  // a weekday prefix plus a 4-digit year covers all three and excludes every
  // bare-numeric fragment.
  if (!/^[A-Za-z]{3},\s|^[A-Za-z]{3,9},?\s/.test(trimmed)) {
    return null;
  }
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) {
    return null;
  }
  return Math.max(0, asDate - Date.now());
}

/**
 * Read the delay a retryable response asks for, or `null` when it names none.
 *
 * `undefined` is accepted and means the previous attempt produced no response at
 * all — a transport failure or a timeout, both of which are retried. That case
 * has no header to read, so it must yield `null` and fall back to the computed
 * backoff; the parameter is typed for it rather than the call site guarding,
 * because every retry after a transport failure reaches this function.
 *
 * Only consulted for statuses that will actually be retried. A non-retryable
 * response is returned to the caller as-is, so its header is irrelevant — but
 * reading it anyway would mean a 404 carrying `Retry-After` could contribute a
 * sleep to a loop that is about to return.
 */
function retryAfterMs(res: Response | undefined): number | null {
  if (res === undefined || !isRetryableStatus(res.status)) {
    return null;
  }
  return parseRetryAfterMs(res.headers.get('Retry-After'));
}

/**
 * Retry tuning. Grouped in one object because these are same-typed knobs:
 * passing them positionally produced call sites that read
 * `retryableFetch(fn, url, init, 5, 1000, 60000)`.
 */
export type RetryOptions = {
  // `| undefined` is required by `exactOptionalPropertyTypes`: the adapters
  // forward their own optional options straight through, and without it an
  // explicitly-undefined `maxRetries` is not assignable.
  /** Retries on top of the first attempt; default `DEFAULT_MAX_RETRIES`. */
  maxRetries?: number | undefined;
  /** Initial backoff delay in milliseconds; doubles on each retry. */
  baseDelayMs?: number | undefined;
  /** Per-attempt deadline in milliseconds. `0` installs no deadline. */
  timeoutMs?: number | undefined;
  /**
   * Wall-clock ceiling on the retry sequence, measured from the first attempt.
   *
   * A retry whose wait would land beyond it is not made; the last response is
   * returned instead. Defaults to `DEFAULT_RETRY_BUDGET_MS`.
   *
   * `0` is a legitimate value meaning "no retries", and it does not suppress the
   * first attempt: the budget bounds retries, not the initial request. Pass a
   * negative number to disable the ceiling entirely.
   */
  retryBudgetMs?: number | undefined;
  /**
   * A schedule the attempt must wait for before it is issued.
   *
   * Absent by default, and absent is load-bearing: every archived artifact was taken without
   * pacing, so a default that paced would make old and new readings differ by a variable no
   * registration names. {@link RequestPacer} and `sharedRequestGate` are a structural type and a
   * process-wide registry rather than a number, because the sharing has to be the default: the
   * arms of an A/B are built by different factories and the workers by another, and a per-caller
   * schedule sends N times the configured rate while every artifact still says it was paced.
   *
   * The pacer's wait is **not** charged to `retryBudgetMs`. See the note at the pacing site in
   * {@link retryableFetchWithStats}.
   */
  pacer?: RequestPacer | undefined;
};

/**
 * What one `retryableFetch` call observed.
 *
 * ## Why this exists
 *
 * The retry, and the counters behind it, had to be checked against its consumers,
 * not only against its own tests. An A/B was dispatched to measure the effect of
 * client-side pacing on the provider's 429 rate, and both arms completed with
 * artifacts that contained **no** record of a retry, a 429 or a throttle. The
 * comparison the experiment existed to make was not merely absent — it was
 * **unmakeable**, because the layer that absorbs a rejection returns only the
 * final response and a request rejected twice was therefore indistinguishable, in
 * every artifact, from one served first time.
 *
 * Two conclusions follow, and both are encoded here rather than written down:
 * a retried request is a fact about the run and belongs in the run's artifact,
 * and a counter is only useful if the thing it counts is separable. `rateLimited`
 * and `retried` are distinct fields for that reason: a 503 is retried but is not
 * a rate limit, and a transport failure is retried but had no status to read.
 * Folding them into one number would report a rate limit that never happened.
 */
export type RetryStats = {
  /**
   * Requests actually issued, including the first.
   *
   * Counted at the point the request is made rather than inferred from the
   * retry count, because the two diverge whenever the budget refuses a retry:
   * an unaffordable retry sleeps nothing and issues nothing, so a reader
   * deriving attempts from retries would report traffic the provider never saw.
   */
  attempts: number;
  /** Retries actually made, i.e. `attempts` minus the calls that never retried. */
  retried: number;
  /** Attempts answered with `429`, counted per attempt, not per call. */
  rateLimited: number;
  /**
   * Retries whose delay came from the response's `Retry-After` rather than from
   * the computed backoff.
   *
   * Separate from `retried` because it measures a different thing: whether the
   * provider's own hint was consulted at all. A run that retried 40 times could
   * have a `retryAfterHonoured` of 0, and that is a finding.
   */
  retryAfterHonoured: number;
};

/**
 * Why the ladder declined to make a retry.
 *
 * ## Why the reason travels rather than only a boolean
 *
 * The three reasons call for different work and are indistinguishable in a status code:
 * `attempts-exhausted` means the count is too small, `budget-exhausted` means the last attempt
 * outlasted the allowance, and `retry-after-beyond-budget` means the provider named a window
 * longer than this client is willing to wait. A caller that saw only "429" would treat all three
 * as throttling, which is exactly the misreading run `41393748964` produced: a transport failure
 * after 133 s was reported as a rate limit the provider never sent.
 */
export type RetryRefusal = {
  reason: 'attempts-exhausted' | 'budget-exhausted' | 'retry-after-beyond-budget';
  /** Requests issued before the ladder gave up. */
  attempts: number;
  /** Retries performed before the ladder gave up. */
  retried: number;
  /** The `Retry-After` the response named, or `null` when it named none. */
  retryAfterMs: number | null;
  /** What was left of the budget when the retry was declined, or `null` when unbudgeted. */
  remainingMs: number | null;
};

/** One call's stats plus the response it finally returned. */
export type RetryOutcome = RetryStats & {
  response: Response;
  /**
   * Present only when the call ended on a retryable status that was **not** retried.
   *
   * Absent on every other outcome, so a caller that never inspects it is unaffected and a caller
   * that does cannot mistake a served call for a refused one.
   */
  refusal?: RetryRefusal;
  /**
   * The full exhaustion object, when the attempt count ran out and the caller needs to classify it.
   *
   * ## Why this is here and not reconstructed one layer up
   *
   * A call that ends on `attempts-exhausted` is a **returned** outcome, not a thrown error, so the
   * adapter that turns a `!res.ok` into an `Error` has only `RetryStats` -- attempts, retries,
   * rate-limited -- and no `attemptsMs`, `timeoutMs` or `elapsedMs`. The benchmark layer classifies
   * transport losses by reading `retryExhausted`, and before this field existed the only losses that
   * carried one were the ones a **thrown** transport error produced. Run `42381702081` is the cost:
   * every attempt answered `429`, nine attempts spent, a returned 429, a bare `Error` from the
   * adapter, and 500 questions discarded because the classification could not see what the ladder
   * had already measured.
   *
   * Reconstructing it in the adapter was the alternative and it is refused: the three fields above
   * live only in this loop, and filling them with a placeholder to satisfy a shape is fabricating the
   * numbers a reader would then reason from.
   */
  exhausted?: RetryExhaustion;
};

/**
 * What a call that failed on every attempt reports, attached to the error it throws.
 *
 * ## Why the url and the attempt count travel on the error
 *
 * Run `38520676669` spent three hours and eight minutes over four thousand questions and
 * ended on `TypeError: terminated`. The record it left named neither the endpoint, nor the
 * provider, nor whether the fault had survived six attempts or aborted on the first -- so
 * the one question an infrastructure failure has to answer had no answer in the record,
 * and the next dispatch could not be chosen on evidence.
 *
 * ## Why it is attached rather than wrapped in a new Error
 *
 * The stack of the transport error is the only evidence that the loss was infrastructure
 * rather than a defect in the arm (§13.11.7), which is the same argument
 * `attachPartial` makes one layer up: a diagnostic must not replace the thing it
 * describes. The original error is rethrown untouched, with this field added.
 *
 * ## Why it carries counts rather than a verdict
 *
 * "Was it transient" is a judgement about the provider, and this layer has no basis for
 * one. `attempts` is what it does know: a call that reached the network six times and
 * failed six times is a different fact from a call that issued one request and was cut
 * off, and a reader can draw the conclusion from the number without the number claiming
 * it.
 */
export type RetryExhaustion = {
  /** The url the failed call was addressed to. */
  readonly url: string;
  /** Requests actually issued, including the first attempt. */
  readonly attempts: number;
  /** Retries actually performed before giving up. */
  readonly retried: number;
  /** Attempts answered with `429`, out of the ones that were issued. */
  readonly rateLimited: number;
  /** Wall-clock milliseconds from the first attempt to the last failure. */
  readonly elapsedMs: number;
  /**
   * How long each attempt ran, in order, excluding the waits between them.
   *
   * ## The reading this exists to settle
   *
   * `41585013786` exhausted one call and printed `attempts=4, retried=3, elapsedMs=134163`. The
   * four attempts averaged 27 s each, and nothing in the record said whether that was one 60 s
   * deadline reached once or four 25 s aborts, whether the pacer had charged the sequence, or
   * whether the budget had truncated an attempt. Those are three different repairs and the
   * numbers to choose between them were not written down. §13.236 is one paragraph of
   * arithmetic over a value that does not exist.
   *
   * `elapsedMs` alone cannot answer it because it also contains every backoff and every pacer
   * wait -- the two quantities that are deliberately *not* the attempt's own cost. Recorded per
   * attempt, the sum of this vector subtracted from `elapsedMs` is the waiting, and the shape of
   * the vector says which of the three shapes the failure had.
   */
  readonly attemptsMs: readonly number[];
  /**
   * The per-attempt deadline this call was given, so the vector above can be judged against it.
   *
   * `attemptsMs[i] === timeoutMs` means the deadline fired; anything shorter means the attempt
   * died on the wire (`ECONNRESET`, a body abort) and the shape is a different one. Without the
   * deadline in the record a reader has to know which arm was running to interpret an attempt
   * duration, which is the "check whose input is a memory" defect §13.220 named.
   */
  readonly timeoutMs: number;
  /**
   * The ceiling this call's retries were measured against, or `null` when none was enforced.
   *
   * `null` is a statement (no ceiling) and is not the same as a large number: a call that
   * reported `elapsedMs=134163` against a `120000` ceiling and one against no ceiling describe
   * different behaviour under the same error message.
   */
  readonly retryBudgetMs: number | null;
  /** The transport error's own message, or `''` when no attempt produced one. */
  readonly cause: string;
};

/** Cross-call view of {@link RetryStats}, with the sample size attached. */
export type RetryStatsSnapshot = RetryStats & {
  /** Calls recorded, i.e. the sample the rate below is computed over. */
  calls: number;
  /** Calls that made at least one retry. */
  retriedCalls: number;
  /**
   * Calls that **completed** without a single retry.
   *
   * "Completed" is load-bearing and is why `exhaustedCalls` is a separate field rather
   * than an absence: a call that issued one request and failed does not complete, so it
   * is not clean -- and counting it as clean would let a run whose traffic was failing
   * outright report a higher share of untroubled calls than a healthy one.
   *
   * `refusedCalls` completes that reasoning one step further. A call answered `429` that
   * then *declined a retry* has not completed either, and it used to land here: run
   * `41393748964` reported 2,892 clean calls and zero rate-limited ones, then died of a
   * `429` the provider never sent.
   */
  cleanCalls: number;
  /**
   * Calls that failed on every attempt and never produced a response.
   *
   * ## Why this is a counter and not just a field on the last error
   *
   * The exhaustion path threw without passing through `withResponse`, so a call that
   * died on every attempt was **absent** from these counters entirely. The aggregate
   * described the calls that recovered and not the one that did not, which is exactly
   * backwards for a failure investigation: an artifact could report a 2% retry rate over
   * 4000 calls and be describing a run whose last call was the end of it.
   *
   * The four call classes partition the sample -- `cleanCalls + retriedCalls +
   * exhaustedCalls + refusedCalls === calls` -- and that identity is asserted rather than
   * intended.
   */
  exhaustedCalls: number;
  /**
   * Calls that ended on a retryable status and were **not** retried.
   *
   * ## Why this is not folded into `exhaustedCalls`
   *
   * Exhaustion means the network never answered. A refusal means it answered "not now" and
   * this client decided not to ask again -- a policy outcome rather than an infrastructure
   * one. Folding them together would make a run that declined one retry indistinguishable
   * from one whose traffic never arrived, and the two call for opposite work: the first is
   * a tuning question, the second is an outage.
   *
   * Only calls whose `retried` is zero can land here, which is what keeps the partition
   * disjoint: a call that retried at least once counts in `retriedCalls` whatever status it
   * ended on.
   */
  refusedCalls: number;
  /**
   * `retriedCalls / calls` — the share of calls that had to retry.
   *
   * Per **call**, not per retry: a `retried / calls` ratio would let one call
   * that retried 40 times report a rate of 40, which is not a rate. The retry
   * volume is already carried by `retried`, and keeping the two separate is what
   * lets a reader tell "many calls each retrying once" from "one call retrying
   * many times".
   *
   * An exhausted call does **not** count here even when it retried: `exhaustedCalls` takes
   * that call, because "never answered" is a different event from "answered and refused" and
   * the partition has to put it somewhere. Its retries are still in `retried`, which is the
   * volume; this rate is the share of calls that were answered after at least one retry.
   *
   * `0` for an empty aggregate rather than `NaN`: `NaN` serializes to `null`,
   * which would read beside a genuine `0` as missing data. The sample size is
   * `calls`, so a reader has what they need to tell "no retries" from "no data".
   */
  retryRate: number;
};

/**
 * Accumulate {@link RetryStats} across calls.
 *
 * A class rather than a module-level variable so a caller can hold an isolated
 * one — a test asserting on accounting must not have its numbers moved by
 * another test's traffic, and the process-level aggregate below is exactly that
 * hazard.
 */
export class RetryStatsAggregate {
  #attempts = 0;
  #retried = 0;
  #rateLimited = 0;
  #retryAfterHonoured = 0;
  #calls = 0;
  #retriedCalls = 0;
  #cleanCalls = 0;
  #exhaustedCalls = 0;
  #refusedCalls = 0;

  /** A call that finished, whichever way it finished. */
  record(stats: RetryStats): void {
    this.#accumulate(stats, 'completed');
  }

  /**
   * A call that failed on every attempt and produced no response.
   *
   * A second method rather than a flag on `record`, because the two are different
   * events rather than two shapes of one: `record` is called from `withResponse`, which
   * only exists on a path that HAS a response, and a caller that reached here has none.
   * Folding them together would make "completed" a parameter a reader could pass wrongly,
   * which is the kind of thing a signature can prevent and a comment cannot.
   */
  recordExhausted(stats: RetryStats): void {
    this.#accumulate(stats, 'exhausted');
  }

  /**
   * A call that ended on a retryable status and was deliberately not retried.
   *
   * The third kind, and the one whose absence made run `41393748964` unreadable: the call was
   * counted as clean, so the artifact said every request had been served on its first attempt
   * while the process was dying of a status the ladder had declined to chase.
   */
  recordRefused(stats: RetryStats): void {
    this.#accumulate(stats, 'refused');
  }

  #accumulate(stats: RetryStats, outcome: 'completed' | 'exhausted' | 'refused'): void {
    this.#attempts += stats.attempts;
    this.#retried += stats.retried;
    this.#rateLimited += stats.rateLimited;
    this.#retryAfterHonoured += stats.retryAfterHonoured;
    this.#calls += 1;
    if (outcome === 'exhausted') {
      this.#exhaustedCalls += 1;
      return;
    }
    if (stats.retried === 0) {
      // No retry was made, so what the call did is fully described by how it ended: served
      // (clean) or answered with a status this client declined to chase (refused). These are
      // the two classes a run can be wrong about, and putting the second here rather than in
      // `cleanCalls` is the repair: run `41393748964` reported 2,892 clean calls and died of a
      // declined `429`.
      if (outcome === 'refused') {
        this.#refusedCalls += 1;
      } else {
        this.#cleanCalls += 1;
      }
      return;
    }
    // It retried, so it is counted by the retry rate whatever the ending. `exhaustedCalls`
    // still takes precedence above, because a call with no response at all is a different
    // event from one that was answered and refused.
    this.#retriedCalls += 1;
  }

  /** A copy, so a caller holding it cannot mutate numbers already read. */
  snapshot(): RetryStatsSnapshot {
    return {
      attempts: this.#attempts,
      retried: this.#retried,
      rateLimited: this.#rateLimited,
      retryAfterHonoured: this.#retryAfterHonoured,
      calls: this.#calls,
      retriedCalls: this.#retriedCalls,
      cleanCalls: this.#cleanCalls,
      exhaustedCalls: this.#exhaustedCalls,
      refusedCalls: this.#refusedCalls,
      retryRate: this.#calls === 0 ? 0 : this.#retriedCalls / this.#calls,
    };
  }

  /** Zero every counter, so the aggregate can be reused across runs. */
  reset(): void {
    this.#attempts = 0;
    this.#retried = 0;
    this.#rateLimited = 0;
    this.#retryAfterHonoured = 0;
    this.#calls = 0;
    this.#retriedCalls = 0;
    this.#cleanCalls = 0;
    this.#exhaustedCalls = 0;
    this.#refusedCalls = 0;
  }
}

/** Create an empty aggregate. */
export function createRetryStatsAggregate(): RetryStatsAggregate {
  return new RetryStatsAggregate();
}

/**
 * Process-level aggregate, for the benchmark's artifact writer.
 *
 * Process-wide for the same reason `setEmbeddingBatchIntervalMs` is: the
 * functions that actually issue provider requests take no options object, so a
 * per-call aggregate would be unreachable from the run that needs to report it.
 */
const processRetryStats = new RetryStatsAggregate();

/** Read the process-level aggregate. */
export function retryStats(): RetryStatsSnapshot {
  return processRetryStats.snapshot();
}

/** Zero the process-level aggregate (tests, and a process reuse boundary). */
export function resetRetryStats(): void {
  processRetryStats.reset();
}

/**
 * Build the abort signal for ONE attempt.
 *
 * The deadline has to be created per attempt rather than once before the loop.
 * An `AbortSignal` is single-use: one shared instance would already be aborted
 * by the time a retry ran, so every retry would fail instantly and the retry
 * budget would be spent without a single request reaching the server.
 *
 * A caller-supplied signal is preserved and combined with the deadline, so an
 * outer cancellation still wins and the shorter of the two applies.
 */
function attemptSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) {
    return callerSignal ?? undefined;
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) {
    return deadline;
  }
  return AbortSignal.any([callerSignal, deadline]);
}

/**
 * Fetch with retry/backoff for transient failures. Returns the response as-is
 * once it is successful or non-retryable, or after the final attempt still
 * returns a retryable status (the caller inspects `res.ok` and throws a
 * descriptive error). Network errors and per-attempt timeouts are retried and
 * re-thrown if they persist.
 *
 * The wait before each retry is, in order of precedence:
 *
 *   1. the response's own `Retry-After`, when it names one;
 *   2. the exponential backoff, `baseDelayMs * 2 ** (attempt - 1)`.
 *
 * A retry whose wait would land beyond `retryBudgetMs` (measured from the first
 * attempt's start) is not attempted at all; the last response is returned. The
 * budget is checked before sleeping rather than after, so an unaffordable retry
 * costs no wall-clock time.
 *
 * The accounting is recorded into the process-level aggregate as well as
 * returned, because the callers that issue provider requests in bulk have no way
 * to thread an aggregate down to this layer and the run's artifact still has to
 * carry it.
 */
export async function retryableFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const outcome = await retryableFetchWithStats(fetchFn, url, init, options);
  return outcome.response;
}

/**
 * {@link retryableFetch}, reporting what the call observed.
 *
 * Kept as a separate export rather than a fifth parameter on `RetryOptions` so
 * that the many existing call sites stay unchanged and cannot forget to read a
 * result they do not want.
 */
export async function retryableFetchWithStats(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<RetryOutcome> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  // The default is the fix, not a convenience. See `DEFAULT_RETRY_BUDGET_MS`: the
  // defect was an implied budget shorter than the window it had to outlast, so a
  // default that reproduced it would leave every caller unfixed while the code
  // read as repaired.
  const retryBudgetMs = options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  // A negative budget disables the ceiling, which is how a caller opts out
  // without a second boolean whose interaction with the number would need its
  // own rules.
  const budgetEnforced = retryBudgetMs >= 0;
  // The schedule, when the deployment has one. Consulted before every attempt including the
  // first: a gate on the retry path only would police the aftermath of a burst and not the
  // burst, which is the traffic that gets throttled.
  const pacer = options.pacer;
  // Milliseconds spent waiting for a slot. Held separately from the budget because the two
  // waits are different decisions with different owners: the backoff is the ladder's own
  // estimate of when to try again, and the pace is the deployment's statement about how
  // fast this client may emit. Charging the second to the first would report
  // `budget-exhausted` for a ladder the pacer never let run.
  let pacedMs = 0;
  // How long each attempt took, in order, excluding the waits between them. Declared beside
  // `pacedMs` because the two are the halves of `elapsedMs` a reader has to separate to name a
  // cause: see `RetryExhaustion.attemptsMs` for the run whose cause could not be named without it.
  const attemptsMs: number[] = [];
  // Captured before the first attempt so the budget is measured from the start
  // of the sequence. Measuring from the first retry would let a slow initial
  // attempt (up to `timeoutMs`) be spent outside the budget entirely.
  const sequenceStart = Date.now();
  let lastError: Error | undefined;
  // The most recent retryable response, held so it can be returned when a retry
  // is unaffordable or the budget runs out. Without it the budget path would
  // have nothing to return and would have to fabricate a status.
  let resFromLastAttempt: Response | undefined;
  const stats: RetryStats = {
    attempts: 0,
    retried: 0,
    rateLimited: 0,
    retryAfterHonoured: 0,
  };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const fromHeader = retryAfterMs(resFromLastAttempt);
      const computed = baseDelayMs * 2 ** (attempt - 1);
      // What is left of the budget, read fresh at every retry: the ceiling is measured
      // from the first attempt, and every attempt before this one has spent some of it.
      const remaining = budgetEnforced
        ? retryBudgetMs + pacedMs - (Date.now() - sequenceStart)
        : Number.POSITIVE_INFINITY;
      let waitMs = fromHeader ?? computed;
      if (waitMs > remaining) {
        // Two refusals live here, and they are different decisions.
        //
        // The server's own window (`Retry-After`) is an instruction: either it is honoured
        // in full or it is declined. Sleeping part of it and retrying inside the window
        // the server just said is still closed is not a retry, it is a request we already
        // know will be rejected -- so a header beyond the remaining budget returns at once.
        //
        // The computed backoff is this client's estimate, and the budget is its ceiling.
        // Truncating the last wait to the remainder spends the budget that was allocated
        // and lands the final attempt ON the deadline, rather than abandoning the room:
        // at 40 ms then 80 ms against a 100 ms budget, refusing the overshoot stops at
        // 40 ms with 60% of the window unused.
        if (fromHeader !== null || remaining <= 0) {
          const refusal: RetryRefusal = {
            reason: fromHeader !== null ? 'retry-after-beyond-budget' : 'budget-exhausted',
            attempts: stats.attempts,
            retried: stats.retried,
            retryAfterMs: fromHeader,
            remainingMs: budgetEnforced ? Math.max(0, remaining) : null,
          };
          if (resFromLastAttempt === undefined) {
            // ## Never invent a status
            //
            // This path used to `return new Response(null, { status: 429 })`, and run
            // `41393748964` is what that costs. A thinking-mode attempt stalled for 133 s,
            // which is longer than the whole 120 s budget, so the next attempt was declined
            // -- and the caller was handed a fabricated `429`. The artifact then said
            // `LLM request failed: 429` about a provider that never sent one, and the
            // counters, which were correct, said `rateLimited: 0`; the two readings
            // together looked like a contradiction and were in fact the same misattribution
            // seen from both ends.
            //
            // With no response there is no status to report. The truth is the transport
            // error, and it is the only thing this layer can substantiate -- so it is
            // rethrown with the counts attached, on the same contract the exhaustion path
            // uses one branch below.
            processRetryStats.recordExhausted(stats);
            throw withExhaustion(
              lastError ?? new Error(`fetch failed after ${stats.attempts} attempts`),
              {
                url,
                attempts: stats.attempts,
                retried: stats.retried,
                rateLimited: stats.rateLimited,
                elapsedMs: Date.now() - sequenceStart,
                attemptsMs,
                timeoutMs,
                retryBudgetMs: budgetEnforced ? retryBudgetMs : null,
                cause: lastError === undefined ? '' : lastError.message,
              },
            );
          }
          // Unaffordable. Returning the real response rather than sleeping past the
          // deadline: the caller inspects `res.ok` and raises the provider's own status,
          // which is strictly more informative than a timeout raised after the run has
          // already been delayed.
          //
          // No retry counter is incremented here, and that is the point: this retry was
          // never made, so recording it would report a request the provider never
          // received. `refusedCalls` is what says the call was declined rather than served,
          // and the refusal travels with the outcome so the caller can name the reason.
          return withRefusal(resFromLastAttempt, stats, refusal);
        }
        waitMs = remaining;
      }
      // Counted at the retry itself, after the budget has agreed to it, so
      // `retried` is a count of retries performed rather than of retries wanted.
      stats.retried += 1;
      if (fromHeader !== null) {
        stats.retryAfterHonoured += 1;
      }
      await sleep(waitMs);
    }
    // ## The pacer holds for every attempt, and its wait is not the ladder's spend
    //
    // Placed here rather than wrapped around the whole call so that a retry is paced too: the
    // provider's window closes on the RATE of requests, and a retry is a request. Placed after
    // the backoff decision so the two waits add rather than compete -- a client that paced
    // instead of backing off would retry inside the window the refusal just named.
    //
    // `pacedMs` is added back into `remaining` above for a reason with a run behind it:
    // `41553176719` ended on `not retried (budget-exhausted) after 8 attempt(s) and 0 s was left`
    // against a provider that publishes no `Retry-After`, at 1.41 questions per minute. A gate
    // installed without this line would have spent the 120 s budget on the pacer and reported the
    // same reason code for a ladder that had not been tried -- the fix would have looked
    // installed and measured as a regression.
    if (pacer !== undefined) {
      const pacedWaitMs = pacer.reserve();
      if (pacedWaitMs > 0) {
        await sleep(pacedWaitMs);
        pacedMs += pacedWaitMs;
      }
    }
    const signal = attemptSignal(init.signal, timeoutMs);
    let res: Response;
    // Started before the attempt is counted, so an attempt that never returns still has a
    // duration to report in the catch below.
    const attemptStart = Date.now();
    try {
      stats.attempts += 1;
      res = await fetchFn(url, signal ? { ...init, signal } : init);
      // The body is read HERE, inside the deadline and inside the retry, because
      // otherwise an attempt ends when the HEADERS arrive and the deadline stays
      // armed across a body read this function has already returned from.
      //
      // The measured cost of not doing it: run `38941095220` died at
      // `reference-pipeline run=1 q=391` on `TimeoutError: The operation was aborted
      // due to timeout` with `{"attempts":6702,"retried":0,"calls":6702,
      // "cleanCalls":6702,"exhaustedCalls":0}` -- a raw abort, no retry, no counter,
      // and 79 minutes of graded answers already in memory. The abort happened in
      // the client at `res.json()`, one stack frame above this loop, where nothing
      // can classify it. §13.31 named this exact possibility ("a single abort from
      // somewhere the retry loop does not wrap") and left it open; this closes it.
      res = await withBufferedBody(res);
      attemptsMs.push(Date.now() - attemptStart);
    } catch (err) {
      attemptsMs.push(Date.now() - attemptStart);
      lastError = err instanceof Error ? err : new Error(String(err));
      // A transport failure carries no response, so there is no header to read
      // on the next iteration and the computed backoff applies.
      //
      // Deliberately not counted as `rateLimited`: no status was received, so a
      // 429 count incremented here would attribute a network fault to the
      // provider's rate limiter.
      resFromLastAttempt = undefined;
      continue;
    }
    if (res.status === 429) {
      stats.rateLimited += 1;
    }
    if (res.ok || !isRetryableStatus(res.status)) {
      return withResponse(res, stats);
    }
    if (attempt === maxRetries) {
      // The count ran out on a status we would have retried. That is a refusal like any
      // other -- the call was answered and not served -- so it is counted and reported the
      // same way rather than as a clean completion.
      //
      // The exhaustion object travels with it for the reason `RetryOutcome.exhausted` gives: this
      // is a returned outcome, and without it the only caller that can classify the loss is the one
      // that received a thrown transport error.
      return withRefusal(
        res,
        stats,
        {
          reason: 'attempts-exhausted',
          attempts: stats.attempts,
          retried: stats.retried,
          retryAfterMs: retryAfterMs(res),
          remainingMs: budgetEnforced
            ? Math.max(0, retryBudgetMs + pacedMs - (Date.now() - sequenceStart))
            : null,
        },
        {
          url,
          attempts: stats.attempts,
          retried: stats.retried,
          rateLimited: stats.rateLimited,
          elapsedMs: Date.now() - sequenceStart,
          attemptsMs,
          timeoutMs,
          retryBudgetMs: budgetEnforced ? retryBudgetMs : null,
          cause: `${String(res.status)} ${res.statusText}`.trim(),
        },
      );
    }
    resFromLastAttempt = res;
  }
  // Every attempt failed on transport. The accounting is recorded HERE rather than only
  // on the returning paths, and that is a repair rather than symmetry: a call that died
  // on every attempt used to leave no trace in the aggregate at all, so the counters
  // described the calls that recovered and not the one that did not.
  processRetryStats.recordExhausted(stats);
  throw withExhaustion(lastError ?? new Error(`fetch failed after ${stats.attempts} attempts`), {
    url,
    attempts: stats.attempts,
    retried: stats.retried,
    rateLimited: stats.rateLimited,
    elapsedMs: Date.now() - sequenceStart,
    attemptsMs,
    timeoutMs,
    retryBudgetMs: budgetEnforced ? retryBudgetMs : null,
    cause: lastError === undefined ? '' : lastError.message,
  });
}

/**
 * Attach what the retry loop observed to the error it is about to throw.
 *
 * The error is returned unchanged apart from the added field, so its class and its stack
 * survive -- a caller that catches on `TypeError` still catches one, and the stack that
 * names `Fetch.onAborted` is the only evidence in the record that a loss was
 * infrastructure.
 *
 * The parameter is an `Error` rather than `unknown`, and that is not a narrowing for
 * convenience: the loop above converts a non-Error throw into an `Error` at the point it
 * is caught, so `lastError` is always one. A `typeof error === 'object'` guard here would
 * be an arm no input can reach, which is the shape §57.6 removed elsewhere -- and the
 * branch-coverage gate would be the thing that found it.
 */
export function withExhaustion(error: Error, exhaustion: RetryExhaustion): Error {
  (error as { retryExhausted?: RetryExhaustion }).retryExhausted = exhaustion;
  return error;
}

/** Attach the final response, record the call, and return the outcome. */
/**
 * Read a response's body to completion and hand back a response holding those bytes.
 *
 * ## Why the wrapper reads it rather than the caller
 *
 * `AbortSignal.timeout` is armed on the REQUEST and `fetch` resolves on the HEADERS,
 * so a `fetch` that returns a live stream leaves the deadline running past the end of
 * this module's scope. A body that is still arriving when it fires rejects at the
 * caller's `res.json()` -- outside the `try` below, so the ladder sees nothing: the
 * call is counted clean and the process dies. Measured once, in `38941095220`, after
 * 79 minutes.
 *
 * Reading it here makes one attempt mean one COMPLETE exchange, which is what the
 * retry semantics, the accounting and the `timeoutMs` docstring all already assumed.
 *
 * ## What it costs
 *
 * One buffer per response. Every caller in this repository consumes JSON bodies that
 * are a few kilobytes, and the ones that only inspect a status still paid for a
 * connection that would otherwise have been abandoned mid-body -- so the buffer is
 * smaller than the socket it replaces.
 *
 * `null` bodies (204, 304, HEAD) are passed through untouched: `new Response` refuses
 * a body on a null-body status, and there is nothing to read.
 */
async function withBufferedBody(res: Response): Promise<Response> {
  if (res.body === null) {
    return res;
  }
  const bytes = await res.arrayBuffer();
  return new Response(bytes, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function withResponse(response: Response, stats: RetryStats): RetryOutcome {
  const outcome: RetryOutcome = { ...stats, response };
  processRetryStats.record(outcome);
  return outcome;
}

/**
 * Record a call that ended on a retryable status without being retried, and say why.
 *
 * Separate from {@link withResponse} rather than a flag on it, because the two are different
 * events and the aggregate counts them in different classes: a refusal is not a completion, and
 * a reader of the artifact has to be able to tell "every request was served" from "one request
 * was answered 'not now' and we stopped asking".
 */
function withRefusal(
  response: Response,
  stats: RetryStats,
  refusal: RetryRefusal,
  exhausted?: RetryExhaustion,
): RetryOutcome {
  const outcome: RetryOutcome =
    exhausted === undefined
      ? { ...stats, response, refusal }
      : { ...stats, response, refusal, exhausted };
  processRetryStats.recordRefused(outcome);
  return outcome;
}

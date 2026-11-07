/**
 * The reader's transport settings: how fast requests leave, and how long a call may keep trying.
 *
 * ## Why these two variables live in their own module
 *
 * Neither is part of the reader's identity. `DEEPSEEK_MODEL` and `DEEPSEEK_THINKING` describe what
 * the arm IS, and the artifact records them so two readings can be compared; the interval and the
 * budget describe how the client behaves on the wire, and a run that changed them is the same arm
 * with a different pipe. Keeping them apart is what lets §13.227 change the pipe without declaring
 * a departure from the registration -- and what stops the identity block from growing a field that
 * no comparison reads.
 *
 * ## The run behind both
 *
 * `41553176719` and `41552258320` are the second provider's smoke, twice, both dead at 55 of 60
 * questions on `429 {"code":"1302"}` with `retryAfterHonoured: 0`. The provider publishes no
 * `Retry-After`, so the ladder had nothing to aim at; what it did publish, through 140 refusals of
 * 279 requests, was a rate. The first variable is the answer to a rate, and the second exists
 * because a client that paces will still meet the window when an attempt is slow: 1.41 questions
 * per minute is a request every 42 s, which is longer than the 120 s default budget is designed to
 * cover when a retry is also needed.
 *
 * ## Module-private declarations
 *
 * `THINKING_TIMEOUT_MS` carries no `export`: it is read by the two functions below and by nothing
 * outside this file, so the keyword would advertise a consumer that does not exist -- the same
 * `referenced-locally` finding `export-census` reports elsewhere. It moved here with the two
 * functions that read it rather than staying in `llm-factory`, because a constant and its readers
 * in two modules is how two deadlines start to differ.
 */
import {
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_TIMEOUT_MS,
  type ThinkingMode,
} from '@agentix-e/cortex-ai';
import type { LlmEnv } from './reader-provider.js';

/** Per-attempt deadline for thinking-mode calls; reasoning takes far longer. */
const THINKING_TIMEOUT_MS = 300_000;

/**
 * Per-attempt deadline for a judge call.
 *
 * The judge's prompt is one question, one gold answer and one reply, and its completion is the
 * word `yes` or `no`; 30 s is a generous reading of that workload and it is deliberately not the
 * reader's 60 s. The two are different questions -- §13.236 measured the cost of lending the
 * reader's transport to an instrument -- so they get two numbers.
 */
const JUDGE_TIMEOUT_MS = 30_000;

/**
 * Ceiling for the judge's retry ladder.
 *
 * The reader's 120 s default buys two attempts at a 60 s deadline, and the ladder it nominally
 * has (nine rungs) can never be walked. A judge attempt costs one short request, so the ceiling
 * that makes the ladder reachable is cheap: 300 s covers the same nine attempts even if every one
 * of them has to wait out the deployment's pace.
 */
const JUDGE_RETRY_BUDGET_MS = 300_000;

/** The variable the minimum interval between reader requests arrives in. */
const MIN_INTERVAL_VARIABLE = 'CORTEX_LLM_MIN_INTERVAL_MS';

/** The variable the per-call retry allowance arrives in. */
const RETRY_BUDGET_VARIABLE = 'CORTEX_LLM_RETRY_BUDGET_MS';

/**
 * The variable the reader's per-attempt deadline arrives in.
 *
 * ## The run this exists for
 *
 * `42381840503` answered 291 of 500 questions and then died on
 * `{"attempts":2,"retried":1,"elapsedMs":601000,"attemptsMs":[299999,300001],"timeoutMs":300000}`:
 * **both** attempts reached the 300 s deadline the thinking path is built with. The deadline is a
 * module constant chosen for a chat model on a large context, and a reasoning reader on the same
 * prompt has a heavier tail than that constant describes -- so "dispatch a stronger reader" failed
 * at 58% of the suite on a transport bound rather than on an answer.
 *
 * ## Why the repair is a declared variable rather than a bigger constant
 *
 * A constant sized for the slowest model in the family would make every fast model wait out a
 * deadline it never approaches, and one sized for the fastest is what killed that run. The number
 * that is right depends on the reader and on the prompt budget, both of which a dispatch knows and
 * neither of which this module can infer. So the deadline becomes something a run **declares**, and
 * `readReaderIdentity` carries the declaration into the artifact: a bound that is only in a job log
 * is the §13.110 defect on a new field.
 */
const READER_TIMEOUT_VARIABLE = 'CORTEX_READER_TIMEOUT_MS';

/** What the environment said about the reader's transport. All absent means "the defaults". */
export type ReaderPacing = {
  /** Minimum gap between request starts in milliseconds; `0` when the deployment paced nothing. */
  readonly minIntervalMs: number | undefined;
  /** Wall-clock ceiling on one call's retry sequence, replacing the adapter's default. */
  readonly retryBudgetMs: number | undefined;
  /**
   * The per-attempt deadline this run declared, or absent to keep the one the thinking mode implies.
   *
   * Separate from `retryBudgetMs` because the two are different questions: the deadline says how
   * long one request may take, the ceiling says how long a call may keep trying. A deployment that
   * raises the first without the second builds a ladder that cannot make its first retry, which is
   * why `resolveReaderTransport` refuses that pair instead of accepting it.
   */
  readonly timeoutMs: number | undefined;
};

/**
 * Read one of these variables as a whole number of milliseconds.
 *
 * ## Why the grammar is this strict
 *
 * `Number(raw)` would accept `''` as `0` (silently "off"), `1.5` as a fractional delay, `6e5` as a
 * scientific-notation quantity nobody typed on purpose, and `abc` as `NaN` -- and `NaN` reaches the
 * gate as a rejected interval, so the operator would read a `RangeError` from `pacing.ts` about a
 * number that is not in the file they edited. Run `41431790794` is the ancestor of this rule: a
 * workflow that interpolates an unset variable passes the empty string, and a parser that reads it
 * as zero turns "unset" into "disabled" without a word.
 *
 * Blank is therefore unset rather than zero, and anything that is not a run of digits is refused
 * with the variable's name and the offending text in the message. Negative values are refused by
 * the same rule rather than by a second one.
 */
function readMilliseconds(env: LlmEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `${name}=${JSON.stringify(text)} is not a whole number of milliseconds. Give a run of ` +
        'digits, or leave the variable unset to keep the default.',
    );
  }
  return Number(text);
}

/** Read both transport variables. Absent is absent; `0` is a decision and is passed through. */
export function readReaderPacing(env: LlmEnv): ReaderPacing {
  return {
    minIntervalMs: readMilliseconds(env, MIN_INTERVAL_VARIABLE),
    retryBudgetMs: readMilliseconds(env, RETRY_BUDGET_VARIABLE),
    timeoutMs: readDeadline(env),
  };
}

/**
 * Read the declared deadline, refusing the one value that cannot mean what it looks like.
 *
 * `0` is accepted for the interval (it is "do not pace") and for the retry ceiling (it is "do not
 * retry"), because both are decisions with a coherent meaning. For a deadline it is neither: an
 * `AbortSignal.timeout(0)` fires before the request leaves, so a run that set it would lose every
 * question to a bound it declared itself, and would report that as a provider failure. The refusal
 * says which variable and which quantity, because the operator's next action is to type a larger
 * number and the message is the only place that tells them how large is plausible.
 */
function readDeadline(env: LlmEnv): number | undefined {
  const declared = readMilliseconds(env, READER_TIMEOUT_VARIABLE);
  if (declared === 0) {
    throw new Error(
      `${READER_TIMEOUT_VARIABLE}=0 aborts every request before it is sent: a per-attempt ` +
        'deadline of zero milliseconds is not "no deadline". Give a number of milliseconds, or ' +
        'leave the variable unset to keep the deadline the thinking mode implies.',
    );
  }
  return declared;
}

/**
 * Per-attempt request deadline for the given thinking mode. Thinking mode
 * reasons before answering, so a single call over a large retrieved context can
 * take 30-120s and blows past the adapter's 60s non-thinking default; give it a
 * 5-minute deadline instead. Non-thinking keeps the adapter default (undefined).
 */
export function resolveTimeoutMs(thinking: ThinkingMode): number | undefined {
  return thinking.type === 'enabled' ? THINKING_TIMEOUT_MS : undefined;
}

/**
 * Retry allowance for the given thinking mode, or `undefined` to keep the adapter's default.
 *
 * ## Why thinking mode cannot use the default budget
 *
 * The retry budget is measured from the first attempt, so a per-attempt deadline longer than
 * the budget means **the ladder can never make its first retry**: a single full-length attempt
 * spends the whole allowance. Thinking mode's deadline is 300 s and the adapter's default
 * budget is 120 s, so that is not a hypothetical -- run `41393748964` ran this exact pair and
 * the consequence was recorded as `LLM request failed: 429` on a stalled attempt, because the
 * pre-fix code invented a status when it declined to retry.
 *
 * The allowance is therefore stated as *one full-length attempt plus the standard budget*: the
 * attempt itself may consume its own deadline, and what remains is exactly the window the
 * non-thinking path gets. Because the budget only gates retries and never interrupts one, this
 * bounds the sequence at two attempts -- 300 s then up to 300 s -- rather than at nine.
 *
 * Non-thinking keeps `undefined` rather than repeating 120 s here: the adapter's default is the
 * single place that number lives, and a second copy is a second thing to keep in step.
 */
export function resolveRetryBudgetMs(thinking: ThinkingMode): number | undefined {
  return thinking.type === 'enabled' ? THINKING_TIMEOUT_MS + DEFAULT_RETRY_BUDGET_MS : undefined;
}

/**
 * What the adapter is given about its transport, with every absent field absent.
 *
 * Declared as a type with optional members rather than as three `number | undefined` fields so the
 * caller can spread it: `OpenAICompatibleLLM`'s options distinguish "not stated" from "stated as
 * undefined" for the deadline and the budget, and an object that always carried all three keys
 * would send `timeoutMs: undefined` where the archived readings sent nothing.
 *
 * Module-private: its only reader is the function below, which returns it. The shape is documented
 * because a caller spreading it needs to know what it may contain, not because anyone will name it.
 */
type ReaderTransport = {
  readonly timeoutMs?: number;
  readonly retryBudgetMs?: number;
  readonly minIntervalMs?: number;
};

/**
 * Compose the pacing the environment stated with the pair the thinking mode already implied.
 *
 * ## Why the two numbers are checked against each other here
 *
 * The retry budget is measured from the first attempt, so a budget at or below the per-attempt
 * deadline is spent by one slow request and the ladder can never make its first retry. That is not
 * hypothetical: run `41393748964` paired a 300 s thinking deadline with the 120 s default and then
 * reported `LLM request failed: 429` about a provider that never sent one. `resolveRetryBudgetMs`
 * fixed the pair the code chooses; this refuses the pair a deployment can now choose.
 *
 * `0` is exempt because it is not an unreachable ladder -- it is no ladder, which is a decision
 * (one request per call) and an honest one to record.
 *
 * ## Why the floor names a number
 *
 * The operator's next action is to pick a value, and "invalid budget" leaves them guessing whether
 * the problem is the scale or the relationship. `greater than the 60000 ms` says which number is
 * too small and which quantity it has to exceed.
 */
export function resolveReaderTransport(
  thinking: ThinkingMode,
  pacing: ReaderPacing,
): ReaderTransport {
  // A declared deadline beats the one the thinking mode implies, because the thinking mode is a
  // request field we send and the deadline a claim about how long the endpoint may take -- and the
  // run that made this a variable (`42381840503`) had the flag set correctly and still died on the
  // bound the flag implied.
  const timeoutMs = pacing.timeoutMs ?? resolveTimeoutMs(thinking);
  // The adapter's own default, read from the package that owns it: a second copy of 60 000 here
  // would be a second thing to keep in step with `DEFAULT_RETRY_TIMEOUT_MS`.
  const deadlineMs = timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  const budgetMs = pacing.retryBudgetMs ?? defaultRetryBudgetMs(deadlineMs, thinking);
  if (
    pacing.retryBudgetMs !== undefined &&
    pacing.retryBudgetMs > 0 &&
    pacing.retryBudgetMs <= deadlineMs
  ) {
    throw new Error(
      `CORTEX_LLM_RETRY_BUDGET_MS=${pacing.retryBudgetMs} must be greater than the ${deadlineMs} ms ` +
        'per-attempt deadline, or the first slow attempt spends the whole allowance and no retry ' +
        'is possible. Raise it, leave it unset to keep the default, or set it to 0 to ask for no ' +
        'retries at all.',
    );
  }
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(budgetMs !== undefined ? { retryBudgetMs: budgetMs } : {}),
    ...(pacing.minIntervalMs !== undefined ? { minIntervalMs: pacing.minIntervalMs } : {}),
  };
}

/**
 * The allowance the ladder gets when the deployment stated a deadline and no ceiling.
 *
 * ## Why the ceiling follows the deadline
 *
 * Because it is measured from the first attempt: a ceiling at or below one attempt is spent by that
 * attempt, so the ladder can never make its first retry. `resolveRetryBudgetMs` states that rule for
 * the pair the code chooses (300 s of thinking plus the standard 120 s); this states it for the pair
 * a dispatch chooses, which is why it takes the effective deadline rather than a mode. Without it a
 * declared 600 s deadline would inherit a 420 s ceiling and every attempt on the slow reader would
 * be single-shot -- the same `41393748964` failure on a number nobody had looked at yet.
 *
 * Below the standard window the adapter's own default is already larger than the deadline, so the
 * mode-derived answer stands and no second number is invented here.
 */
function defaultRetryBudgetMs(deadlineMs: number, thinking: ThinkingMode): number | undefined {
  return deadlineMs >= DEFAULT_RETRY_BUDGET_MS
    ? deadlineMs + DEFAULT_RETRY_BUDGET_MS
    : resolveRetryBudgetMs(thinking);
}

/**
 * The reader's transport as one log line, beside the judge's.
 *
 * ## Why this is printed at all
 *
 * `describeJudgeTransport` exists because a run died on an instrument whose bounds nobody had
 * written down. The reader has the same failure and a worse consequence: `42381840503` lost a
 * 500-question pass to a 300 s deadline that was in a module constant, and the only place it
 * appeared in the record was the exhaustion object attached to the error -- after the loss. A line
 * printed before the first question is the difference between a bound a reader can see and one they
 * can only reconstruct from a failure.
 *
 * The budget is printed as the adapter would apply it: `default` means "no ceiling from us", which
 * is the non-thinking reader's state and is a different fact from a number equal to the default.
 */
export function describeReaderTransport(thinking: ThinkingMode, pacing: ReaderPacing): string {
  const transport = resolveReaderTransport(thinking, pacing);
  const derived = resolveTimeoutMs(thinking);
  return (
    `reader transport: deadlineMs=${transport.timeoutMs ?? `${DEFAULT_RETRY_TIMEOUT_MS} (adapter)`}` +
    ` retryBudgetMs=${transport.retryBudgetMs ?? 'default'}` +
    ` minIntervalMs=${transport.minIntervalMs ?? 'none'}` +
    ` deadlineSource=${pacing.timeoutMs === undefined ? (derived === undefined ? 'adapter' : 'thinking') : READER_TIMEOUT_VARIABLE}` +
    ` thinking=${thinking.type}`
  );
}

/**
 * The transport a judge call gets.
 *
 * ## Why the judge is not given the reader's pair
 *
 * `41585013786` spent 26 minutes judging after its 500 answers were already in memory. One judge
 * call exhausted its ladder (`attempts=4, retried=3, elapsedMs=134163`) and the rejection left
 * `scoreEvaluation`, so the pass was lost. Two things were wrong and only one of them was the
 * missing `catch`: the pair the judge inherited describes the reader's workload.
 *
 * A judge call is short in both directions, so it can afford many attempts and a small deadline.
 * It inherits `minIntervalMs` -- the pace is the provider's window, not the workload's -- and it
 * takes its own two numbers, which are printed beside the reader's so a run's log names the pair
 * each side of the measurement ran under.
 */
export function resolveJudgeTransport(pacing: ReaderPacing): ReaderTransport {
  return {
    timeoutMs: JUDGE_TIMEOUT_MS,
    retryBudgetMs: JUDGE_RETRY_BUDGET_MS,
    ...(pacing.minIntervalMs === undefined ? {} : { minIntervalMs: pacing.minIntervalMs }),
  };
}

/**
 * The judge's pair as one log line.
 *
 * Exported rather than typed at the entry point because a second copy of `30000` in a `console.log`
 * is a second thing to keep in step with the number the client was actually built with -- the
 * defect §13.227 avoided for the pacer with a single read. `reader-transport.test.ts` asserts this
 * line against `resolveJudgeTransport`, so a change to either without the other is a failing test
 * rather than a log that misdescribes the run.
 */
export function describeJudgeTransport(): string {
  return (
    `judge transport: deadlineMs=${JUDGE_TIMEOUT_MS} retryBudgetMs=${JUDGE_RETRY_BUDGET_MS} ` +
    'thinking=disabled'
  );
}

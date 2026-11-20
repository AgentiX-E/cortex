/**
 * A run-level latch over a **chat** account that has said it cannot pay.
 *
 * ## The run this exists for
 *
 * `R2` was dispatched to read the reader-family rung and died with thirty-three rate-limited calls behind it
 * and **666 seconds** of wall clock spent discovering a fact the first refusal had already established. The
 * embedding side of this repository has had the repair since `44354315890` (`embedding-latch.ts`: 431
 * avoidable refusals, one latch). The chat side did not, and the reason it went unnoticed is structural: the
 * retry ladder in `cortex-ai` *does* refuse to burn attempts on a balance (`isQuotaExhausted` separates an
 * empty account from a throttle on the same `429`), so every individual call looked correct. What no layer
 * owned was the **run**.
 *
 * ## Why the counters are process-wide rather than per-wrapper
 *
 * The embedding latch is per-client with a single published slot, and the note on that slot says a second
 * client replaces the handle. That is right there because one process builds one embedding model. Here one
 * process builds **two**: the reader and the judge, possibly on different providers (`DEEPSEEK_*` for the
 * reader, `ZHIPU_*` for a pinned judge). A per-client latch would let the judge close while the reader keeps
 * spending, and the published reading would name whichever client happened to be built last.
 *
 * So the closure is one fact about the process, and the cross-provider case is the reason it is safe rather
 * than a hole in it: a run whose **verdicts** cannot be produced is not a measurement, so a judge that cannot
 * pay stops the reader too. The alternative -- keep answering questions nobody can grade -- buys tokens at the
 * price of the only thing the run was for. The closure carries the first refusal's own words, so the operator
 * still learns *which* account to top up.
 *
 * ## Why a latch and not a policy
 *
 * Same argument as the embedding side, stated once here because it is the same decision: the product has a
 * per-call policy for the embedding case and deliberately none for this one, and a harness that degraded
 * mid-run would change the arm it is measuring without changing its name. What the harness needs is the
 * question "can this account pay" asked **once**, and then answered from memory with the same typed error, so
 * every caller above behaves exactly as it did and only the bill changes.
 *
 * ## What it does not do
 *
 * It does not retry, sleep, or classify. `cortex-ai`'s ladder owns all three, and a second opinion here is how
 * the two would come to disagree about the same response. It closes on one type and refuses with that type.
 */
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';
import { LlmQuotaExhaustedError } from '@agentix-e/cortex-ai';

/**
 * What the latch has seen, as a failure record reads it.
 *
 * The three counts answer three questions and only one of them is about money: `refusedByProvider` is calls
 * the provider answered (round trips that cost wall clock), `refusedAfterLatch` is calls that never left the
 * process (what the latch bought), and `calls` is the denominator the other two are read against -- a run with
 * four thousand calls and one refusal is a different story from a run with two.
 */
export type LlmQuotaLatchReading = {
  /** Calls that reached the provider, including the one that was refused. */
  readonly calls: number;
  /** Calls the provider answered with the balance refusal. */
  readonly refusedByProvider: number;
  /** Calls refused inside this process, after the latch closed, without a request. */
  readonly refusedAfterLatch: number;
  /**
   * The closure, or `null` while the latch is open.
   *
   * One object rather than three nullable fields beside a boolean: the three facts are written together or not
   * at all, and a type that can express a closure with no ordinal would make every consumer write a fallback
   * for a state the mechanism cannot produce. `embedding-latch.ts` records that lesson from the other side --
   * its first draft grew three unreachable `??` arms that coverage found.
   */
  readonly closure: {
    /** The ordinal of the call that closed the latch. */
    readonly atCall: number;
    /** The first refusal's status, which every later local refusal repeats. */
    readonly status: number;
    /** The provider's own words from the first refusal, kept verbatim. */
    readonly detail: string;
  } | null;
};

let calls = 0;
let refusedByProvider = 0;
let refusedAfterLatch = 0;
let closed: LlmQuotaLatchReading['closure'] = null;

/** The latch's counters as they stand, for a failure record or a log line. */
export function llmQuotaLatchReading(): LlmQuotaLatchReading {
  return { calls, refusedByProvider, refusedAfterLatch, closure: closed };
}

/**
 * Narrowing predicate for the one error class the latch closes on.
 *
 * `instanceof` alone is not enough across a workspace where a package can be resolved twice, so the name is
 * checked as a fallback -- the same shape `embedding-latch.ts` uses, and the reason the error sets `name` in
 * its constructor.
 */
function isQuotaRefusal(error: unknown): error is LlmQuotaExhaustedError {
  return (
    error instanceof LlmQuotaExhaustedError ||
    (error instanceof Error && error.name === 'LlmQuotaExhaustedError')
  );
}

/**
 * Wrap a chat client so the first balance refusal closes the process for the rest of its life.
 *
 * Both methods are wrapped, because both spend: `completeStructured` is how the aggregated routes ask, and a
 * latch that only guarded `complete` would leave a whole family of prompts paying into an empty account.
 */
export function latchLlmQuota(inner: LLM): LLM {
  /** Count the call, or refuse it locally, returning the ordinal this call holds. */
  function enter(): number {
    if (closed !== null) {
      refusedAfterLatch += 1;
      // The same type, so every classifier above this layer keeps working, and the same status, so a reader
      // that branches on `429` is not asked to learn a second code for the same condition.
      throw new LlmQuotaExhaustedError(
        `LLM provider has no quota left: call ${closed.atCall} closed the latch, and ` +
          `${refusedAfterLatch} call(s) have been refused without a request since. ${closed.detail}`.trimEnd(),
        closed.status,
        closed.detail,
      );
    }
    calls += 1;
    return calls;
  }

  /**
   * Record a refusal, or rethrow a failure that is not one.
   *
   * The ordinal is passed in rather than read off `calls` at the throw site: two calls in flight increment the
   * shared counter in the order they enter, so reading it here would stamp the *latest* caller's ordinal onto
   * the *first* refusal. `embedding-latch.ts` captures it for the same reason.
   */
  function fail(error: unknown, ordinal: number): never {
    if (!isQuotaRefusal(error)) throw error;
    refusedByProvider += 1;
    // First refusal wins. A second one already in flight when the latch closed is counted as a provider
    // refusal -- it did cost a request -- but it does not move the boundary, which is the ordinal a reader
    // uses to place it.
    closed ??= { atCall: ordinal, status: error.status, detail: error.detail };
    throw error;
  }

  return {
    async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
      const ordinal = enter();
      try {
        return await inner.complete(prompt, opts);
      } catch (error) {
        fail(error, ordinal);
      }
    },
    async completeStructured<T>(
      prompt: string,
      schema: JsonSchema,
      opts?: CompleteOptions,
    ): Promise<T> {
      const ordinal = enter();
      try {
        return await inner.completeStructured<T>(prompt, schema, opts);
      } catch (error) {
        fail(error, ordinal);
      }
    },
  };
}

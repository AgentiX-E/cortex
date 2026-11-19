/**
 * A run-level latch over an embedding account that has said it cannot pay.
 *
 * ## The run this exists for
 *
 * `44354315890` dispatched `turnWindow=match` and died 28 minutes in, four criteria unread, on
 * `EmbeddingQuotaExhaustedError` (`429`, provider code `1113`, "余额不足或无可用资源包,请充值。"). The
 * failure itself is not a defect -- an empty account cannot be argued with. What the artifact recorded
 * is: `attempts 3129 / calls 3129 / cleanCalls 2698 / refusedCalls 431 / retriedCalls 0`. **Four hundred
 * and thirty of those refusals were avoidable.** The first one established the fact; every one after it
 * asked the same provider the same question and received the same answer.
 *
 * ## Why a latch and not a policy
 *
 * The product already has a policy for this -- `SearchIndex`'s `onEmbedFailure`, which can degrade to
 * lexical scoring -- and the harness deliberately does **not** use it. Degrading the reference pipeline
 * mid-run would change the arm being measured without changing its name, and an accuracy computed over a
 * window of mixed provenance is worse than a run that stopped: the number would look like a result. What
 * the harness needs is the opposite of a degraded answer. It needs the question "can this account pay" to
 * be asked **once**, and then answered from memory.
 *
 * So the latch does not choose what to do. It refuses to spend, and it keeps refusing with the same
 * typed error, so every caller above behaves exactly as it did -- `runWorker` rethrows it, `main().catch`
 * writes the failure record, the process exits non-zero. The only thing that changes is the bill.
 *
 * ## Why the harness and not the product
 *
 * A benchmark run lasts hours and its account cannot be topped up from inside it, so "this will not get
 * better" is true for its whole remaining life. A product process is the other case: its operator can top
 * the account up while it is running, and a latch there would turn a ten-minute outage into a permanent
 * one for that process. The product's per-retrieval `onEmbedFailure` decision is the right shape for a
 * deployment, and this is the right shape for a measurement.
 *
 * ## Why the reading is published rather than returned
 *
 * The failure record is written in `main().catch(...)`, outside the scope where the run was built, which
 * is the same reason `resolveEmbeddingProvenance` exists. The provenance is a pure function of the
 * environment and so can be re-derived there; a latch's counters are **state** and cannot. Publishing the
 * handle when the client is built is the smallest thing that closes that gap, and it mirrors the
 * provenance exactly: the factory writes, the failure path reads.
 */

import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { EmbeddingQuotaExhaustedError } from '@agentix-e/cortex-ai';

/**
 * What the latch has seen, as the failure record reads it.
 *
 * The three counts are separate because they answer three different questions and only one of them is
 * about money. `refusedByProvider` is round trips the provider answered, which cost wall clock and (at
 * some vendors) quota accounting. `refusedAfterLatch` is calls that never left the process, which is what
 * the latch bought. `calls` is the total that did leave, and it is the denominator the other two are
 * read against -- a run with 4000 calls and one refusal is a different story from a run with two.
 *
 * `closure.atCall` is the ordinal of the call that closed the latch. It is not a question number: the
 * transport layer does not know which question it is serving, and inventing one here would put a number
 * in the record that no instrument measured. The question is carried by the progress line beside it, and
 * the two together are what bound the damage.
 */
export type EmbeddingLatchReading = {
  /** Calls that reached the provider, including the one that was refused. */
  readonly calls: number;
  /** Calls the provider answered with the quota error. */
  readonly refusedByProvider: number;
  /** Calls refused inside this process, after the latch closed, without a request. */
  readonly refusedAfterLatch: number;
  /**
   * The closure, or `null` while the latch is open.
   *
   * One object rather than three nullable fields beside a `latched` boolean, because the three facts
   * are written together or not at all: a reading with a status and no call ordinal is a state the
   * mechanism cannot produce, and a type that can express it makes every consumer write a fallback for
   * a state that never arrives. Those fallbacks are where the first draft of this file grew three
   * unreachable `??` arms, which coverage found.
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

/**
 * The latch published by the most recent call to {@link latchQuota}, if any.
 *
 * A single slot rather than a registry, because one process runs one benchmark and builds one embedding
 * client for it -- the same assumption `embeddingSourceCounters` and `retryStats()` are written under, and
 * the reason a test asserts the change between two reads rather than a zeroed counter. A second client
 * replaces the handle; in the one-embedding case that is the same thing, and in a test file it is the
 * isolation a reset function would otherwise have to provide.
 */
let published: (() => EmbeddingLatchReading) | null = null;

/**
 * Narrowing predicate for the one error class the latch closes on.
 *
 * `instanceof` alone is not enough across a workspace where a package can be resolved twice, so the name
 * is checked as a fallback -- the same shape `benchmark.ts` uses for `ProviderContentRefusal`, and the
 * reason the error sets `name` in its constructor.
 */
function isQuotaRefusal(error: unknown): error is EmbeddingQuotaExhaustedError {
  return (
    error instanceof EmbeddingQuotaExhaustedError ||
    (error instanceof Error && error.name === 'EmbeddingQuotaExhaustedError')
  );
}

/**
 * Wrap an embedding client so the first quota refusal closes it for the rest of the process.
 *
 * The wrapper forwards `dimension` and `identity` unchanged, and that forwarding is load-bearing rather
 * than tidy: `EmbeddingSpace` refuses to query a **non-empty** index whose space is unstated, so a
 * decorator that dropped the optional `identity` would turn every vector index in the process into one
 * that cannot be searched. `identity` is therefore attached only when the inner model has one, so the
 * wrapper's absence matches the model's absence instead of inventing a method that returns `undefined`
 * through a type that forbids it.
 *
 * A non-quota failure is rethrown without closing the latch: a malformed request, a dead socket and a
 * schema error all fail the same way on every question, and the callers above already decide those. Only
 * "this account cannot pay" is the fact that will not change.
 */
export function latchQuota(inner: EmbeddingModel): EmbeddingModel {
  let calls = 0;
  let refusedByProvider = 0;
  let refusedAfterLatch = 0;
  /**
   * The closure, as one value rather than three variables.
   *
   * The first draft kept `latchedAtCall`, `latchedStatus` and `detail` apart and then wrote
   * `latchedAtCall ?? 429` and `detail ?? ''` at the throw site. Neither fallback could ever run --
   * a non-null `latchedAtCall` is written in the same block that writes the other two -- so the
   * `??` arms were unreachable, and unreachable fallbacks are not free: they absorb a future
   * overrun silently instead of failing where it happens. One object makes the implication a
   * property of the type, and the branches disappear.
   */
  let closed: { atCall: number; status: number; detail: string } | null = null;

  const reading = (): EmbeddingLatchReading => ({
    calls,
    refusedByProvider,
    refusedAfterLatch,
    closure: closed,
  });
  published = reading;

  const identity = inner.identity?.bind(inner);
  return {
    async embed(texts: string[]): Promise<Float64Array[]> {
      if (closed !== null) {
        refusedAfterLatch += 1;
        // The same type, so every classifier above this layer keeps working, and the same status, so a
        // reader that branches on `429` is not asked to learn a second code for the same condition.
        throw new EmbeddingQuotaExhaustedError(
          `Embedding provider has no quota left: call ${closed.atCall} closed the latch, and ` +
            `${refusedAfterLatch} call(s) have been refused without a request since. ${closed.detail}`.trimEnd(),
          closed.status,
          closed.detail,
        );
      }
      calls += 1;
      const ordinal = calls;
      try {
        return await inner.embed(texts);
      } catch (error) {
        if (!isQuotaRefusal(error)) throw error;
        refusedByProvider += 1;
        // First refusal wins. A second one that was already in flight when the latch closed is counted
        // as a provider refusal -- it did cost a request -- but it does not move the boundary, which is
        // the ordinal a reader uses to place it.
        // `error.detail` without a fallback to `error.message`: `isQuotaExhausted` requires a non-empty
        // body before it will name a refusal, so the production constructor cannot build one with an
        // empty detail. A `detail === '' ? message : detail` here was the third unreachable fallback of
        // this round -- the same shape as the two `??` arms above and the `truncateCodePointSafe` call
        // deleted from `resolution.ts` yesterday: a repair for a state the producer forbids, which
        // silently absorbs the first real overrun instead of failing where it happens.
        closed ??= { atCall: ordinal, status: error.status, detail: error.detail };
        throw error;
      }
    },
    dimension: () => inner.dimension(),
    ...(identity === undefined ? {} : { identity }),
  };
}

/**
 * The latch's counters, or `null` when no latching client was built in this process.
 *
 * `null` and an unlatched reading are different facts and the failure record prints them differently: a
 * run that never built a client (it died parsing its dataset) has no latch to report, while a run that
 * graded 500 questions and then failed on the LLM has one and it is open.
 */
export function quotaLatchReading(): EmbeddingLatchReading | null {
  return published === null ? null : published();
}

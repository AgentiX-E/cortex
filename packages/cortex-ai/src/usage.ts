/**
 * Provider spend: what a call reported it charged, accumulated process-wide.
 *
 * ## Why this module exists at all
 *
 * `OpenAICompatibleLLM.complete` read a response body for `choices` and discarded
 * `usage`. Every provider on the OpenAI-compatible wire returns that block on every
 * call, so the campaign that produced every number in `PREREGISTRATION` had a
 * complete record of its own spend available on every request and kept none of it.
 * The consequence is not cosmetic: for two weeks the only evidence of what a run
 * cost was a monthly invoice, and no experiment could state whether a change to the
 * prompt, the window or the retry policy moved the bill. §13.140 registers the
 * instrument; this file is it.
 *
 * The shape of the omission is the one this repository has now found five times --
 * a value that is produced, carried, and then dropped at the one hop where it would
 * have been compared -- and the reason it survived so long here is that nothing ever
 * read it. `tools/ledger.mjs --across` is the same failure on the answer side.
 *
 * ## Why an absence is `undefined` and not `0`
 *
 * Because the two mean opposite things. A response with no `usage` block is a call
 * whose cost is UNKNOWN -- a proxy that strips the field, a provider that does not
 * implement it -- and a ledger that recorded `0` for it would report a run that spent
 * nothing while spending everything. `unpricedCalls` is the counter that keeps that
 * case visible, and it is counted on the same `record` call so a future caller cannot
 * forget it.
 *
 * This is the same distinction `LlmProfile`'s `temperature: null` draws against a
 * number, and `dispatch-cortex-memory-ab.py`'s `None` draws against "stale".
 *
 * ## Why the aggregate is process-wide
 *
 * For the reason `retryStats()` is: the functions that issue provider requests take no
 * options object, so an aggregate threaded from the entry point would be unreachable
 * from the layer that sees the response. A run that wants per-arm totals takes a
 * snapshot before and after and subtracts (`usageDelta`); nothing in this module has
 * to know what an arm is.
 *
 * ## What is deliberately NOT here
 *
 * No prices. A currency figure in this package would be a vendor's rate card checked
 * into git, aging silently, and the artifact would then state a cost it cannot
 * defend. Token counts are facts the provider published; a price is a fact about a
 * contract, and a reader holding the counts can re-derive the bill from the rate card
 * of the day. The one thing a stale price does that a stale count cannot is survive a
 * review, because it is denominated in money and therefore looks authoritative.
 */

/** One response's reported spend. */
export type LlmUsage = {
  /** Tokens in the request, cache hits included. */
  readonly promptTokens: number;
  /** Tokens generated, which is what a truncated answer inflates. */
  readonly completionTokens: number;
  /**
   * The part of `promptTokens` the provider served from its prefix cache.
   *
   * A SUBSET, never an addition. It exists as its own field because it is the only
   * measurement that can price a prompt-ordering change: a prefix the provider can
   * reuse is billed at a fraction of a miss, so the share of a run's prompt that hits
   * is the quantity that decides whether moving a stable instruction block to the
   * front of a 47,000-character prompt is worth a run.
   */
  readonly cacheHitPromptTokens: number;
};

/** Spend accumulated over a set of calls. */
export type UsageSnapshot = {
  /**
   * Calls that produced a response, priced or not.
   *
   * Counted rather than derived so that `unpricedCalls > 0` is expressible: the
   * difference between "the run made no call" and "the run made 1,000 calls and the
   * provider told us nothing about any of them" is the whole point of the counter.
   */
  readonly calls: number;
  /** Responses that carried no `usage` block, so their cost is unknown. */
  readonly unpricedCalls: number;
  /** Sum over the priced calls. */
  readonly promptTokens: number;
  /** Sum over the priced calls. */
  readonly completionTokens: number;
  /** Sum over the priced calls; a subset of `promptTokens`, for the reason above. */
  readonly cacheHitPromptTokens: number;
};

/**
 * Read the `usage` block of a response body.
 *
 * ## Why every rejection returns `undefined` rather than a partial object
 *
 * A half-read usage block is worse than none: `{promptTokens: 0, completionTokens: 40}`
 * from a body that named only the completion count would enter the sum as a real
 * measurement of a prompt that cost nothing. The block is taken whole or reported
 * absent, and `unpricedCalls` then carries the fact.
 *
 * ## Why `prompt_cache_miss_tokens` is not summed
 *
 * Because it is `prompt_tokens - prompt_cache_hit_tokens`, a second expression of one
 * fact. This repository has been bitten by two expressions of one fact more than once
 * (`resolveReaderIdentity` exists to stop exactly that), and the rule here is that
 * `prompt_tokens` is authoritative. A provider whose two expressions disagree is a
 * provider worth noticing, but silently preferring one of them is not the way to
 * notice it -- the hit counter is dropped instead, which understates the credit rather
 * than overstating the bill.
 */
export function parseUsage(raw: unknown): LlmUsage | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const body = raw as Record<string, unknown>;
  const promptTokens = body['prompt_tokens'];
  const completionTokens = body['completion_tokens'];
  if (!isCount(promptTokens) || !isCount(completionTokens)) {
    return undefined;
  }
  // The cache hit is read only when it can be true of the prompt it describes. A value
  // larger than the prompt is impossible from a correct provider, and reading it would
  // make `cacheHitPromptTokens`'s subset claim false; a non-numeric value is a proxy
  // rewriting the block. Both fall to `0`, so the run understates its own cache credit
  // by at most that request instead of claiming a discount it did not get.
  const rawHit = body['prompt_cache_hit_tokens'];
  const cacheHitPromptTokens = isCount(rawHit) && rawHit <= promptTokens ? rawHit : 0;
  return { promptTokens, completionTokens, cacheHitPromptTokens };
}

/** A non-negative integer, which is what a token count is. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Accumulate {@link LlmUsage} across calls.
 *
 * **Not exported.** Its only instance is the process ledger below, and the two functions
 * that read that ledger are the whole surface a caller needs. It is a class rather than
 * module-level variables for the reason `RetryStatsAggregate` is one -- one instance per
 * ledger, so a second ledger is a construction away -- but unlike `RetryStatsAggregate`
 * nothing outside this file builds one today, and an export with no caller is a claim
 * about a consumer that does not exist.
 */
class UsageAggregate {
  #calls = 0;
  #unpricedCalls = 0;
  #promptTokens = 0;
  #completionTokens = 0;
  #cacheHitPromptTokens = 0;

  /**
   * Record one call's spend, or one call's silence.
   *
   * `undefined` is a legal argument and is the case that matters: it is what
   * `parseUsage` returns for a response carrying no block, and recording it as a call
   * rather than skipping it is what keeps a proxy that strips `usage` from producing an
   * artifact that reads like a free run.
   */
  record(usage: LlmUsage | undefined): void {
    this.#calls += 1;
    if (usage === undefined) {
      this.#unpricedCalls += 1;
      return;
    }
    this.#promptTokens += usage.promptTokens;
    this.#completionTokens += usage.completionTokens;
    this.#cacheHitPromptTokens += usage.cacheHitPromptTokens;
  }

  /** A copy, so a caller holding it cannot mutate numbers already read. */
  snapshot(): UsageSnapshot {
    return {
      calls: this.#calls,
      unpricedCalls: this.#unpricedCalls,
      promptTokens: this.#promptTokens,
      completionTokens: this.#completionTokens,
      cacheHitPromptTokens: this.#cacheHitPromptTokens,
    };
  }
}

/**
 * Process-level aggregate, recorded by `OpenAICompatibleLLM.complete`.
 *
 * Process-wide for the same reason `retryStats()` is: the adapter is constructed deep
 * inside the run and the artifact writer is at the top, and every alternative -- an
 * options field, a constructor argument, an event bus -- either changes the `LLM`
 * contract in `cortex-core` or makes every caller responsible for forwarding a value
 * it does not want.
 */
const processUsage = new UsageAggregate();

/** Read the process-level aggregate. */
export function llmUsage(): UsageSnapshot {
  return processUsage.snapshot();
}

/** Record into the process-level aggregate. Called by the adapter, not by callers. */
export function recordUsage(usage: LlmUsage | undefined): void {
  processUsage.record(usage);
}

/**
 * What happened between two snapshots.
 *
 * ## Why a delta and not a reset
 *
 * A run that reported the process total would report every earlier run's spend as
 * well, so two artifacts from one process -- the memory A/B writes one per arm -- would
 * each claim the whole bill and their sum would double it. Subtracting two snapshots
 * gives each run its own number without this module having to know where a run begins,
 * and without a `reset()` that would be a side effect on a global from a library
 * function.
 *
 * A negative field cannot arise: nothing in this module decreases a counter, and the
 * ledger is monotone by construction rather than by a clamp. The arithmetic is written
 * plainly rather than defensively for that reason -- a `Math.max(0, ...)` here would be
 * an arm no input can reach, and the branch-coverage gate would be the thing that found
 * it.
 */
export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): UsageSnapshot {
  return {
    calls: after.calls - before.calls,
    unpricedCalls: after.unpricedCalls - before.unpricedCalls,
    promptTokens: after.promptTokens - before.promptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    cacheHitPromptTokens: after.cacheHitPromptTokens - before.cacheHitPromptTokens,
  };
}

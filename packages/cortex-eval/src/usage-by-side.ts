/**
 * Splitting one run's provider spend by the thing that spent it.
 *
 * ## The reading this exists for
 *
 * `AblationReport.llmUsage` is the whole bill: one process-wide ledger, taken as a delta across
 * the ablation. On run `41159983913` that is **50,736,848 prompt tokens over 5,670 calls**, of
 * which 38,402,551 (75.7%) came from the provider's prefix cache. What it cannot say is *which
 * side* spent them, and that is the question any token-reduction work has to start from: an arm
 * whose budget is a 96,000-character window and an arm that answers from a window a quarter that
 * size differ by an order of magnitude in cost, and until the split exists a saving on one is
 * indistinguishable from a saving on the other -- and from a saving on the judge.
 *
 * ## Why the arithmetic is a subtraction with a guard
 *
 * `minusUsage` refuses to go negative rather than clamping. The ledger is monotone by
 * construction, so a part larger than its whole means the two snapshots came from different
 * ledgers, or a counter was reset between them -- a defect in the instrument, not a number worth
 * printing. Clamping would hide it behind a zero that reads like "nothing was spent there".
 *
 * ## What "residual" is, and why it is not "other"
 *
 * The judge runs inside the ablation, outside both systems, and so does the phrasing stage that
 * builds a retrieval index before the first question. Those calls are real spend and belong to
 * neither arm. `residual = total - baseline - feature` names them by construction rather than by
 * a tag the judge would have to remember to apply, and the closure it creates -- the three parts
 * summing to the total exactly -- is what lets a reader trust the split instead of adding it up
 * themselves.
 */
import { llmUsage, usageDelta, type UsageSnapshot } from '@agentix-e/cortex-ai';

import type { MemorySystem } from './types.js';
import { mirrorMembers } from './system-mirror.js';

/** The two sides of an A/B, in the order an artifact should read them. */
export type UsageSide = 'baseline' | 'feature';

/** One snapshot per side. */
export type UsageBySide = {
  readonly baseline: UsageSnapshot;
  readonly feature: UsageSnapshot;
};

/** The identity element, for a side that was never asked a question. */
export function zeroUsage(): UsageSnapshot {
  return {
    calls: 0,
    unpricedCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitPromptTokens: 0,
  };
}

/** Field-wise sum, so a per-question split can be accumulated without a second ledger. */
function plusUsage(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  return {
    calls: a.calls + b.calls,
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitPromptTokens: a.cacheHitPromptTokens + b.cacheHitPromptTokens,
  };
}

/**
 * `whole` minus `part`, refusing to report a negative.
 *
 * The check is per field rather than on a total, because `calls` and `promptTokens` can fail
 * independently: a part that made more calls but spent fewer tokens is a real possibility (cache
 * hits, shorter prompts), and comparing totals would let the larger one mask the smaller.
 */
function minusUsage(whole: UsageSnapshot, part: UsageSnapshot): UsageSnapshot {
  const fields = [
    'calls',
    'unpricedCalls',
    'promptTokens',
    'completionTokens',
    'cacheHitPromptTokens',
  ] as const;
  for (const field of fields) {
    if (part[field] > whole[field]) {
      throw new Error(
        `usage attribution is not closable: the part claims ${part[field]} ${field} against a ` +
          `whole of ${whole[field]}. The ledger is monotone, so this means the two snapshots ` +
          'were not taken from one ledger -- and a negative here would print as a side that ' +
          'spent nothing, which is the opposite of what happened.',
      );
    }
  }
  return {
    calls: whole.calls - part.calls,
    unpricedCalls: whole.unpricedCalls - part.unpricedCalls,
    promptTokens: whole.promptTokens - part.promptTokens,
    completionTokens: whole.completionTokens - part.completionTokens,
    cacheHitPromptTokens: whole.cacheHitPromptTokens - part.cacheHitPromptTokens,
  };
}

/**
 * The spend neither arm made: the judge, the phrasing stage, and anything else the run did
 * between the first snapshot and the last.
 */
export function residualUsage(total: UsageSnapshot, bySide: UsageBySide): UsageSnapshot {
  return minusUsage(total, plusUsage(bySide.baseline, bySide.feature));
}

/** Both sides summed, which is what a "was the feature cheaper to run" question actually asks. */
export function bothSides(bySide: UsageBySide): UsageSnapshot {
  return plusUsage(bySide.baseline, bySide.feature);
}

/**
 * Wrap a system so every answer it produces is attributed to its side of the A/B.
 *
 * ## Why the ledger is process-wide and the split is a delta
 *
 * `llmUsage()` is one monotone counter for the whole process, and both arms, the judge and the
 * phrasing stage issue their requests through the same adapter. Replacing it would mean changing
 * the `LLM` contract or making every caller forward a number it does not want -- the same argument
 * `cortex-ai/src/usage.ts` makes for the ledger being global. So the split is taken **around each
 * answer**: snapshot, call, snapshot, add the difference to this side's accumulator.
 *
 * The `finally` is deliberate. A call that throws has still been billed (the request left the
 * machine), and skipping the delta would make a failing arm look cheap exactly when it is not.
 *
 * ## Why the wrapper is `mirrorMembers`, not a spread
 *
 * A class instance keeps its methods on the prototype, so a spread copies none of them and a
 * session-aware system would arrive flat -- the defect `traceReviewMechanisms` records for run
 * `40984213349`, which produced an artifact whose MR numbers described a system the run never
 * used. Mirroring delegates every member, and only the `answer*` members are then wrapped.
 *
 * ## What it does not do
 *
 * It does not route, retry, reorder or rewrite an answer. The return value passes through
 * unchanged, and the only observable effect is that the side's snapshot grows.
 */
export function traceUsage(
  system: MemorySystem,
  side: UsageSide,
  ledger: Record<UsageSide, UsageSnapshot>,
): MemorySystem {
  const traced = mirrorMembers(system);
  const target = traced as unknown as Record<string, unknown>;
  const names = new Set<string>([
    ...Object.getOwnPropertyNames(system),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(system) as object),
  ]);
  for (const name of names) {
    // Every routable member starts with `answer`; a member added later is covered by the prefix
    // rather than by a list that would have to be edited in step with it.
    if (!name.startsWith('answer')) continue;
    const original = (system as unknown as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    target[name] = async (question: string, ...rest: unknown[]) => {
      const before = llmUsage();
      try {
        return await (original as (...args: unknown[]) => unknown).call(system, question, ...rest);
      } finally {
        ledger[side] = plusUsage(ledger[side], usageDelta(before, llmUsage()));
      }
    };
  }
  return traced;
}

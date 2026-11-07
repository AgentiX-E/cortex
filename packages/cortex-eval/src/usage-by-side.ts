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
 * ## Why the sides are tallies and the residual is a subtraction with a guard
 *
 * A side's total is accumulated where each response is parsed (`withUsageAttribution`), because
 * subtracting two readings of one process-wide counter is only exact while a single answer is in
 * flight and the dispatches run four. The **residual** stays a subtraction, and it is the one place
 * a subtraction is still right: it is taken once, at the end, between two readings of a ledger that
 * only grows. `minusUsage` refuses to go negative rather than clamping. The ledger is monotone by
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
import { AsyncLocalStorage } from 'node:async_hooks';

import { observeUsage, type UsageSnapshot, type UsageTally } from '@agentix-e/cortex-ai';

import type { MemorySystem } from './types.js';
import { mirrorMembers } from './system-mirror.js';

/** The two sides of an A/B, in the order an artifact should read them. */
export type UsageSide = 'baseline' | 'feature';

/** One snapshot per side. */
export type UsageBySide = {
  readonly baseline: UsageSnapshot;
  readonly feature: UsageSnapshot;
};

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
 * ## Why the ledger is a tally and the attribution happens at the writer
 *
 * `llmUsage()` is one monotone counter for the whole process and every arm, the judge and the
 * phrasing stage issue their requests through the same adapter, which is why there is a split at
 * all. The first version of this wrapper took that counter around each `answer` -- snapshot, call,
 * snapshot, add the difference -- and that arithmetic is exact only while one answer is in flight.
 * Under the four-worker pool every dispatch uses, four answers overlap, each interval contains the
 * others' calls, and each side counts work the other side did: run `42054107910` reported `20,458`
 * calls on the two sides against a `5,966`-call run, a factor of 3.43, and the number that was
 * supposed to answer "what does a query cost" could not be divided by anything.
 *
 * `withUsageAttribution` credits a tally where the response is parsed, so the count is a count of
 * calls that happened rather than of calls that happened to fall between two timestamps. What the
 * tally is shared across is then a choice the caller makes: `runCortexMemoryArm` builds one per
 * side and hands the same pair to every worker, which is what makes four concurrent workers
 * summable at all.
 *
 * The rest of the contract is unchanged. A call that throws still bills the side -- the adapter
 * records before the throw -- and the wrapper still only observes: `mirrorMembers` delegates every
 * member and only the `answer*` ones are intercepted, because a spread would arrive flat and
 * `isSessionAware` would then describe a system the run never used (`40984213349`).
 */
/**
 * The async context a side's calls are credited in, and the one observer that reads it.
 *
 * `node:async_hooks` lives here rather than in `cortex-ai` because that package is **portable** -- its
 * entry is one of the ones `tools/entry-guard.mjs` reserves, and a builtin would make the browser build
 * unloadable to answer a question only this instrument asks. The product therefore exposes a hook
 * (`observeUsage`) and this module supplies the scope.
 *
 * One observer for the process, installed on first use. Re-installing would be harmless (the hook
 * replaces rather than accumulates) but it would also mean the wiring could differ between two runs of
 * one process, and an instrument whose wiring depends on call order is the thing §13.145.5 is about.
 */
const attribution = new AsyncLocalStorage<readonly UsageTally[]>();
let scoped = false;

function scopeAttribution(): void {
  if (scoped) return;
  observeUsage((usage) => {
    for (const tally of attribution.getStore() ?? []) tally.record(usage);
  });
  scoped = true;
}

/**
 * Credit every call `fn` makes to `tally`.
 *
 * Nested scopes chain rather than replace: an inner measurement sees a subtree of an outer one, and
 * dropping the outer would make a caller's total depend on whether the callee happened to wrap
 * something. Nothing here nests today; the rule is stated so the first caller who does gets the
 * arithmetic it expects.
 */
function withUsageAttribution<T>(tally: UsageTally, fn: () => Promise<T>): Promise<T> {
  scopeAttribution();
  const inherited = attribution.getStore() ?? [];
  return attribution.run([...inherited, tally], fn);
}

export function traceUsage(
  system: MemorySystem,
  side: UsageSide,
  ledger: Record<UsageSide, UsageTally>,
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
    target[name] = async (question: string, ...rest: unknown[]) =>
      withUsageAttribution(ledger[side], async () =>
        (original as (...args: unknown[]) => unknown).call(system, question, ...rest),
      );
  }
  return traced;
}

/**
 * §13.308 — what one correct answer cost, with the population its denominator came from.
 *
 * ## Why this is written by the run and not recomputed by a reader
 *
 * The ratio is one division, so every consumer that needs it can perform it — and that is the
 * problem. `tools/cost-ledger.py` performed it as `perQuestionPerRun / accuracy`, where the
 * numerator is the token total **over every repetition** divided by `questions × runs`, and the
 * only accuracy any artifact offered was `feature.metrics.accuracy`, which the Markdown renderer
 * labels *"first repetition"* for the reason §13.122 records. An all-repetitions numerator over a
 * one-repetition denominator is not a price; it is a price of a run that did not happen.
 *
 * On the §13.305 pair the two candidates are far enough apart to see: the baseline's first
 * repetition was its worst (91.40% against a 91.95% mean) and the control's was its best (90.80%
 * against 90.75%), so the shipped division charged the baseline 0.60% too much and the control
 * 0.06% too little and turned a 1.20 pp accuracy gap into a **0.57%** cost gap where the honest
 * figure is **1.23%**. Repetition order is arbitrary, so the error's sign is arbitrary too — which
 * is why the fix cannot be "divide by the better number in the tool".
 *
 * ## `accuracySource` is the field, and the ratio is its shadow
 *
 * `all-runs` and `first-repetition` are the same number on a one-repetition arm and different
 * numbers on a four-repetition one. A reader comparing two artifacts is entitled to know which
 * population it is holding, and an artifact that quietly picked one has answered a question nobody
 * can check. So the population travels with the ratio, and a run with no `featureAggregate` (one
 * written before the spread existed, or one that never had more than a single repetition) says so
 * rather than presenting the coincidence as a measurement.
 */
export type CostEfficiency = {
  /** This field's reason to exist: prompt tokens spent per question answered correctly. */
  readonly perCorrectAnswerPromptTokens: number;
  /** The numerator before the division, so the ratio can be rechecked without the artifact. */
  readonly promptTokensPerQuestion: number;
  /** The denominator, carried beside the ratio because the ratio is a function of it. */
  readonly accuracy: number;
  /** Which population `accuracy` came from. Never inferred by a reader from the value alone. */
  readonly accuracySource: 'all-runs' | 'first-repetition';
};

/**
 * `null` rather than `Infinity`, `0`, or a thrown error, for four different absences.
 *
 * Each one is a state the artifact can really be in, and each would be misreported by a number:
 * a run that answered nothing right has an **infinite** cost per correct answer rather than a large
 * one; a run that spent nothing is an **unmeasured** run rather than a free one (the rule
 * `attachLlmUsage` states one layer up); and a run whose question count or repetition count is
 * unknown cannot produce a per-question figure at all — dividing by a guessed repetition count is
 * the same defect `perQuestionPerRun` was introduced to avoid.
 *
 * The four inputs are inlined rather than named as an exported parameter type: the export census
 * reads a type whose only occurrence is a signature as an orphan, and a name that nothing calls is
 * a name a reader has to look up to learn it means "the four values the ratio needs".
 */
export function costEfficiencyFrom(input: {
  readonly promptTokens: number;
  readonly questionCount: number;
  readonly runs: number;
  readonly accuracy: number;
  readonly accuracySource: 'all-runs' | 'first-repetition';
}): CostEfficiency | null {
  const { promptTokens, questionCount, runs, accuracy, accuracySource } = input;
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  if (!Number.isFinite(questionCount) || questionCount <= 0) return null;
  if (!Number.isFinite(runs) || runs <= 0) return null;
  // A boolean or a percentage is not a fraction in (0, 1]. `92` would price a correct answer at
  // 1/92nd of its cost and read like a triumph; `NaN` would poison the ratio silently.
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 1) return null;
  const promptTokensPerQuestion = promptTokens / (questionCount * runs);
  return {
    perCorrectAnswerPromptTokens: promptTokensPerQuestion / accuracy,
    promptTokensPerQuestion,
    accuracy,
    accuracySource,
  };
}

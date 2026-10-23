/**
 * A3: does showing the person the model's atoms change what they decide?
 *
 * ## Why this file exists before any data does
 *
 * A3 has been pre-registered since the plan was written -- "acceptance rate difference >= 10pp,
 * n >= 20, paired" -- and until now the criterion could not be **computed** by anything in this
 * repository. That is a specific kind of debt: a criterion nobody can evaluate is a sentence, not a
 * test. The clicks still need a person; the arithmetic does not, and this file is the arithmetic.
 *
 * ## What is paired, and why it has to be
 *
 * The same card is shown twice: once as the sentence the person said, once as the atoms the model
 * proposed. Comparing two *different* sets of cards would measure the cards; comparing the same card
 * under two presentations measures the presentation, which is what A3 claims. So the unit is the
 * pair, and the test is McNemar's, on the cards where the two arms disagreed.
 *
 * ## Why the exact test and not the chi-square approximation
 *
 * The discordant count is small by construction (n = 20), and the approximation is bad exactly
 * there. The exact two-sided McNemar p-value is `2 * P(X <= min(b, c))` for `X ~ Binomial(b + c,
 * 0.5)`, capped at 1. `binomialCdf` already exists in `cortex-core` and is property-tested there,
 * so this file does not re-derive it.
 *
 * ## The verdict is deliberately blunt
 *
 * Four outcomes, fixed before the data: `underpowered` (fewer than the pre-registered pairs),
 * `atoms-better`, `source-better`, `no-difference`. A `no-difference` result is a **result** -- the
 * design note that asked for A3 said the null was the expectation, and this file will not turn a
 * null into a trend by reporting a point estimate without the verdict.
 */

import { binomialCdf, wilsonScoreInterval, type ConfidenceInterval } from '@agentix-e/cortex-core';

/** The two presentations. `source` is the sentence alone; `atoms` is the model's split of it. */
export type A3Arm = 'source' | 'atoms';

export type A3Decision = 'accept' | 'dismiss' | 'edit';

/** One judgement: which card, which presentation, what the person did. */
export type A3Trial = {
  readonly cardId: string;
  readonly arm: A3Arm;
  readonly decision: A3Decision;
  /** Where the person stopped editing, when they edited. Absent otherwise. */
  readonly editedTo?: string;
  /** How long the decision took. Recorded because a faster "yes" is a different "yes". */
  readonly elapsedMs?: number;
};

export type A3ArmSummary = {
  readonly arm: A3Arm;
  readonly trials: number;
  /** An edit is an accept with changes: the person published, having altered the wording. */
  readonly accepted: number;
  readonly edited: number;
  readonly rate: number;
  readonly interval: ConfidenceInterval;
  readonly medianMs: number | null;
};

export type A3Pairs = {
  /** Cards the person accepted under both presentations. */
  readonly both: number;
  /** Accepted with the sentence, dismissed with the atoms -- the atoms lost this card. */
  readonly onlySource: number;
  /** Accepted with the atoms, dismissed with the sentence -- the atoms won this card. */
  readonly onlyAtoms: number;
  readonly neither: number;
};

export type A3Verdict =
  'atoms-better' | 'source-better' | 'no-difference' | 'underpowered' | 'unpaired';

export type A3Result = {
  readonly arms: readonly [A3ArmSummary, A3ArmSummary];
  readonly pairs: A3Pairs;
  /** How many cards were judged under both presentations: the denominator of `deltaPp`. */
  readonly pairCount: number;
  /** Pairs where one arm accepted and the other did not. The only pairs McNemar uses. */
  readonly discordant: number;
  /** Exact two-sided McNemar p-value; `1` when there is nothing to test. */
  readonly mcnemarP: number;
  /** Acceptance-rate difference in percentage points, on paired cards only. */
  readonly deltaPp: number;
  readonly verdict: A3Verdict;
  /** One sentence a reader can quote without re-deriving the arithmetic. */
  readonly reason: string;
};

export type A3Options = {
  /** Pairs required before any verdict other than `underpowered` is allowed. Pre-registered at 20. */
  readonly minPairs?: number;
  /** The effect the criterion asks for, in percentage points. Pre-registered at 10. */
  readonly minDeltaPp?: number;
  /** Two-sided alpha. Pre-registered at 0.05. */
  readonly alpha?: number;
};

const DEFAULTS = { minPairs: 20, minDeltaPp: 10, alpha: 0.05 } as const;

/**
 * Score a set of trials.
 *
 * Cards that appear under only one arm are dropped from the paired test and counted, because a
 * half-pair says nothing about the difference between presentations -- and silently treating it as
 * a pair would let an interrupted session manufacture a result.
 */
export function scoreA3(trials: readonly A3Trial[], options: A3Options = {}): A3Result {
  const { minPairs, minDeltaPp, alpha } = { ...DEFAULTS, ...options };
  const byCard = new Map<string, Partial<Record<A3Arm, A3Trial>>>();
  for (const trial of trials) {
    const entry = byCard.get(trial.cardId) ?? {};
    // One judgement per (card, arm). A repeated decision is a resumed session, and the last one is
    // what the person meant; keeping both would double-count the card in the paired test.
    entry[trial.arm] = trial;
    byCard.set(trial.cardId, entry);
  }

  const arms = armSummaries(byCard);
  const [source, atoms] = arms;

  let both = 0;
  let onlySource = 0;
  let onlyAtoms = 0;
  let neither = 0;
  let pairs = 0;

  for (const entry of byCard.values()) {
    const under = entry.source;
    const withAtoms = entry.atoms;
    if (under === undefined || withAtoms === undefined) continue;
    pairs += 1;
    const sourceAccepted = isAccept(under);
    const atomsAccepted = isAccept(withAtoms);
    if (sourceAccepted && atomsAccepted) both += 1;
    else if (sourceAccepted) onlySource += 1;
    else if (atomsAccepted) onlyAtoms += 1;
    else neither += 1;
  }

  const discordant = onlySource + onlyAtoms;
  const mcnemarP = exactMcNemar(onlySource, onlyAtoms);
  // The rate difference is computed on the pairs, not on the raw arm totals: an arm with more
  // trials would otherwise look better for no reason that has anything to do with the presentation.
  const deltaPp = pairs === 0 ? 0 : round(((onlyAtoms - onlySource) / pairs) * 100);

  const { verdict, reason } = verdictOf({
    pairs,
    mcnemarP,
    deltaPp,
    alpha,
    minPairs,
    minDeltaPp,
    onlyAtoms,
    onlySource,
    source,
    atoms,
  });

  return {
    arms: [source, atoms],
    pairs: { both, onlySource, onlyAtoms, neither },
    pairCount: pairs,
    discordant,
    mcnemarP,
    deltaPp,
    verdict,
    reason,
  };
}

/**
 * The exact two-sided McNemar p-value.
 *
 * `2 * P(X <= min(b, c))` under `Binomial(b + c, 0.5)`, capped at 1. With no discordant pairs there
 * is nothing to test and the answer is 1, not 0 -- an undefined statistic reported as a small number
 * is how a null result becomes a finding.
 */
export function exactMcNemar(onlySource: number, onlyAtoms: number): number {
  const n = onlySource + onlyAtoms;
  if (n === 0) return 1;
  const tail = Math.min(onlySource, onlyAtoms);
  // `binomialCdf` is P(X <= k) for Binomial(n, p), computed in log space in cortex-core.
  return Math.min(1, 2 * binomialCdf(tail, n, 0.5));
}

function isAccept(trial: A3Trial): boolean {
  return trial.decision === 'accept' || trial.decision === 'edit';
}

function armSummaries(
  byCard: ReadonlyMap<string, Partial<Record<A3Arm, A3Trial>>>,
): [A3ArmSummary, A3ArmSummary] {
  const build = (arm: A3Arm): A3ArmSummary => {
    const rows: A3Trial[] = [];
    for (const entry of byCard.values()) {
      const trial = entry[arm];
      if (trial !== undefined) rows.push(trial);
    }
    const accepted = rows.filter(isAccept).length;
    const edited = rows.filter((trial) => trial.decision === 'edit').length;
    const times = rows
      .map((trial) => trial.elapsedMs)
      .filter((ms): ms is number => typeof ms === 'number')
      .sort((left, right) => left - right);

    return {
      arm,
      trials: rows.length,
      accepted,
      edited,
      rate: rows.length === 0 ? 0 : accepted / rows.length,
      // A zero denominator comes back as [0, 1] from core, which is the honest interval for "no
      // trials" -- and it is why `underpowered` exists rather than a wide interval being read as a
      // cautious finding.
      interval: wilsonScoreInterval(accepted, rows.length),
      medianMs: times.length === 0 ? null : (times[Math.floor((times.length - 1) / 2)] as number),
    };
  };
  return [build('source'), build('atoms')];
}

function verdictOf(input: {
  pairs: number;
  mcnemarP: number;
  deltaPp: number;
  alpha: number;
  minPairs: number;
  minDeltaPp: number;
  onlyAtoms: number;
  onlySource: number;
  source: A3ArmSummary;
  atoms: A3ArmSummary;
}): { verdict: A3Verdict; reason: string } {
  const { pairs, mcnemarP, deltaPp, alpha, minPairs, minDeltaPp } = input;

  if (pairs === 0) {
    return {
      verdict: 'unpaired',
      reason: 'no card was judged under both presentations, so there is no pair to compare',
    };
  }
  if (pairs < minPairs) {
    return {
      verdict: 'underpowered',
      reason: `${pairs} pair(s), and the criterion asks for ${minPairs}: any difference here is a description of these cards, not an effect`,
    };
  }
  if (mcnemarP < alpha && deltaPp >= minDeltaPp) {
    return {
      verdict: 'atoms-better',
      reason: `atoms won ${input.onlyAtoms} card(s) and lost ${input.onlySource}, +${deltaPp.toFixed(1)}pp, exact McNemar p=${mcnemarP.toFixed(4)}`,
    };
  }
  if (mcnemarP < alpha && deltaPp <= -minDeltaPp) {
    return {
      verdict: 'source-better',
      reason: `the sentence won ${input.onlySource} card(s) and lost ${input.onlyAtoms}, ${deltaPp.toFixed(1)}pp, exact McNemar p=${mcnemarP.toFixed(4)}`,
    };
  }
  return {
    verdict: 'no-difference',
    reason: `atoms won ${input.onlyAtoms} and lost ${input.onlySource} of ${pairs} pair(s), ${deltaPp.toFixed(1)}pp, p=${mcnemarP.toFixed(4)}; the criterion wants both p<${alpha} and |delta| >= ${minDeltaPp}pp`,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

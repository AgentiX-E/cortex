/**
 * Is the difference real? A paired test over two runs of the same questions.
 *
 * ## The problem this solves
 *
 * Two accuracy figures four points apart are compatible with a real effect and with a coin. The test that
 * separates them is **paired**: the same questions under two conditions, counting how many changed in each
 * direction. That count cannot be recovered from two percentages — it needs to know *which* question moved, which
 * is why `ProviderScore.records` exists.
 *
 * The specific situation this repository kept hitting: an ablation read `11/20 -> 15/20` on a twenty-question
 * subset and the honest question was whether to believe it. Four questions on twenty is a binomial draw with a
 * paired p well above 0.05, and there was no code to say so — the number was argued about in prose instead.
 *
 * ## Why McNemar and not a two-proportion test
 *
 * Because the two runs are the same questions. An unpaired test compares 20% of one sample against 27% of
 * another and throws away the fact that question 7 was answered by both. McNemar conditions on the **discordant**
 * pairs — the questions where the two arms disagree — and that is exactly the quantity a prompt change moves.
 *
 * ## Why exact rather than chi-squared
 *
 * The discordant count here is small: ten to thirty questions. The chi-squared approximation is poor below about
 * twenty-five and badly wrong below ten, and those are the sizes every ablation in this repository has. The exact
 * binomial tail costs a loop and is right at every size.
 */

import type { ProviderScore, QuestionRecord } from './harness.js';

/** The outcome of comparing one provider under two conditions, question by question. */
export type PairedResult = {
  readonly provider: string;
  /** Questions present in **both** runs. A question in one run only is excluded and counted in `unmatched`. */
  readonly n: number;
  readonly unmatched: number;
  /** Wrong under the baseline, right under the treatment. */
  readonly improved: number;
  /** Right under the baseline, wrong under the treatment. */
  readonly regressed: number;
  /** Right under both. */
  readonly bothCorrect: number;
  /** Wrong under both. */
  readonly bothWrong: number;
  /** `(improved - regressed) / n`: the change in accuracy, in the same units as the score. */
  readonly delta: number;
  /** Two-tailed exact McNemar p-value. `1` when nothing changed. */
  readonly p: number;
};

/**
 * Two-tailed exact McNemar p-value for `improved` against `regressed`.
 *
 * The null hypothesis is that a question which changed direction was equally likely to change either way, so the
 * discordant count is `Binomial(improved + regressed, 0.5)` and the p-value is twice the lower tail. Doubling is
 * what makes it two-tailed, and it is why the result is capped at `1`: doubling a tail above 0.5 is not a
 * probability.
 *
 * `improved + regressed === 0` returns `1`, not `0`. No discordant pair is no evidence of a difference, and a
 * zero there would report the absence of any change as maximal significance — the exact inversion of what
 * happened.
 */
export function mcnemarExact(improved: number, regressed: number): number {
  const discordant = improved + regressed;
  if (discordant === 0) return 1;
  const smaller = Math.min(improved, regressed);
  // sum_{i=0..smaller} C(discordant, i) / 2^discordant, accumulated in the ratio form so no term overflows.
  let term = Math.pow(2, -discordant);
  let tail = term;
  for (let i = 1; i <= smaller; i += 1) {
    term = (term * (discordant - i + 1)) / i;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

/**
 * Compare one provider across two runs, keyed by question id.
 *
 * Provider names must match: the comparison is "the same arm under two conditions", and pairing
 * `cortex-session` against `cortex/trim-2.8k` would silently compare two systems whose question sets also differ.
 * An id present in one run and not the other is excluded from `n` and reported, because a subset that shrank
 * between runs is a fact about the runs and not something to average away.
 */
export function compareRecords(
  baseline: { readonly provider: string; readonly records: readonly QuestionRecord[] },
  treatment: { readonly provider: string; readonly records: readonly QuestionRecord[] },
): PairedResult {
  if (baseline.provider !== treatment.provider) {
    throw new Error(
      `paired comparison needs one provider on both sides, got '${baseline.provider}' and ` +
        `'${treatment.provider}'. Two different arms also differ in their question set, so a per-question ` +
        'pairing would be comparing two experiments rather than two conditions.',
    );
  }

  const after = new Map(treatment.records.map((record) => [record.id, record]));
  let improved = 0;
  let regressed = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  let n = 0;
  let unmatched = 0;

  for (const before of baseline.records) {
    const now = after.get(before.id);
    if (now === undefined) {
      unmatched += 1;
      continue;
    }
    n += 1;
    if (!before.correct && now.correct) improved += 1;
    else if (before.correct && !now.correct) regressed += 1;
    else if (before.correct) bothCorrect += 1;
    else bothWrong += 1;
  }

  return {
    provider: baseline.provider,
    n,
    unmatched,
    improved,
    regressed,
    bothCorrect,
    bothWrong,
    delta: n === 0 ? 0 : (improved - regressed) / n,
    p: mcnemarExact(improved, regressed),
  };
}

/** Pair every provider present in both runs, in the baseline's order. */
export function compareRuns(
  baseline: readonly ProviderScore[],
  treatment: readonly ProviderScore[],
): readonly PairedResult[] {
  const byName = new Map(treatment.map((score) => [score.provider, score]));
  const out: PairedResult[] = [];
  for (const score of baseline) {
    const other = byName.get(score.provider);
    if (other === undefined) continue;
    // A provider that was not read in either run has nothing to pair: `correct` is `false` throughout, and a
    // comparison of two columns of `false` would report perfect stability as if it had been measured.
    if (!score.records.some((record) => record.read)) continue;
    out.push(compareRecords(score, other));
  }
  return out;
}

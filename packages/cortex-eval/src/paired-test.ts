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
  // Validated rather than assumed. A negative or fractional count does not have a p-value, and the
  // arithmetic below returns `1` for it — a wrong answer wearing the look of "no evidence", which is the
  // one outcome a significance test must never produce by accident.
  if (
    !Number.isInteger(improved) ||
    !Number.isInteger(regressed) ||
    improved < 0 ||
    regressed < 0
  ) {
    throw new Error(
      `discordant counts must be non-negative integers, got ${improved} and ${regressed}`,
    );
  }
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
 * Two-sided exact sign-flip p-value over per-question **integer** differences.
 *
 * ## Why this exists beside `mcnemarExact`
 *
 * McNemar needs each question to be a binary pair: right or wrong. That is what one repetition gives. When
 * an arm runs four repetitions a question stops being `0` or `1` and becomes "three of four", and collapsing
 * it back to one bit discards the only thing the repetitions bought. The frontier reader did exactly that on
 * its first pass — it paired on repetition 0 and read `MR` as **2 won to 9 lost, p = 0.0654**, i.e. "no
 * usable signal" — while the four-repetition means read **16 won to 5 lost, p = 0.0039** on the same 121
 * questions. Same arms, same artifact, opposite verdict; the difference was which repetition the pairing
 * read.
 *
 * ## The null and the statistic
 *
 * Under H0 the two arms are exchangeable on each question, so each difference `dᵢ` is equally likely to be
 * `+dᵢ` or `−dᵢ`. The statistic is `Σ dᵢ` and the p-value is `P(|Σ sᵢdᵢ| ≥ |Σ dᵢ|)` over all `2ⁿ` sign
 * assignments. Enumeration is folded over **reachable sums** rather than over assignments, so 34 non-zero
 * pairs carrying six distinct magnitudes cost 273 states instead of 1.7×10¹⁰.
 *
 * ## Why ties are dropped and not counted as agreement
 *
 * A question the arms answered identically in every repetition contributes `dᵢ = 0`, and zero is invariant
 * under sign flip, so it cannot move the statistic. Counting it would inflate `n` without adding evidence:
 * the 466 ties on this dataset would turn a 34-pair test into a 500-pair one and manufacture significance out
 * of pure agreement. Dropping them is also the conservative direction — the pairs that can license a claim
 * are then exactly the pairs that disagreed.
 *
 * ## Why the input is an integer count and not a mean
 *
 * `dᵢ = (correctA − correctB) / runs` carries the same information as `correctA − correctB` for this test,
 * because a common scale factor cancels out of the sign-flip distribution — and the integer form keeps the
 * folded weights exactly representable. A `1/3` mean would put a rounding error into every state of the
 * table and make "exact" a claim about the code rather than about the arithmetic.
 *
 * ## Why exact below forty pairs and normal above
 *
 * Folded enumeration keeps weights as integers out of `2ⁿ`, so it is exact while `2ⁿ` stays below
 * `Number.MAX_SAFE_INTEGER` — 40 pairs is 1.1×10¹², and 53 would be the last safe size. Above the limit the
 * normal approximation to the sign-flip distribution is used, which errs on the **conservative** side at
 * these pair counts (0.0177 against 0.0211 exact on the 34-pair case) and is reported through the same
 * number so a caller cannot silently get a different test than the one documented.
 */
export function signFlipExact(differences: readonly number[]): number {
  for (const difference of differences) {
    if (!Number.isInteger(difference)) {
      throw new Error(
        `sign-flip needs integer per-question differences, got ${difference}; ` +
          'pass the repetition count difference, not the mean',
      );
    }
  }
  const nonZero = differences.filter((difference) => difference !== 0);
  if (nonZero.length === 0) return 1;

  const observed = nonZero.reduce((total, difference) => total + difference, 0);

  if (nonZero.length > SIGN_FLIP_EXACT_LIMIT) {
    // Normal approximation: under H0 each dᵢ is ±dᵢ with equal probability, so the sum has mean 0 and
    // variance Σdᵢ². This is exact in the second moment and needs no distributional assumption beyond the
    // one the exact test already makes.
    const variance = nonZero.reduce((total, difference) => total + difference * difference, 0);
    return Math.min(1, normalTwoSidedTail(Math.abs(observed) / Math.sqrt(variance)));
  }

  // Weights are integers out of 2ⁿ rather than probabilities, so the fold is exact.
  let distribution = new Map<number, number>([[0, 1]]);
  for (const difference of nonZero) {
    const next = new Map<number, number>();
    for (const [sum, weight] of distribution) {
      next.set(sum + difference, (next.get(sum + difference) ?? 0) + weight);
      next.set(sum - difference, (next.get(sum - difference) ?? 0) + weight);
    }
    distribution = next;
  }
  const limit = Math.abs(observed);
  let tail = 0;
  for (const [sum, weight] of distribution) {
    if (Math.abs(sum) >= limit) tail += weight;
  }
  return Math.min(1, tail / Math.pow(2, nonZero.length));
}

/**
 * How many pairs the folded enumeration may carry before exactness stops being representable.
 *
 * `2^40` is 1.1×10¹² against `Number.MAX_SAFE_INTEGER` at 9.0×10¹⁵, so every weight in the table is an
 * integer the arithmetic can hold. Forty is not a resolution choice: above it the answer is still a
 * p-value, computed the other way, and the constant exists so the switch is one number a reader can find.
 *
 * **Not exported**, and the export census is why the first version was wrong: a constant that only
 * `signFlipExact` reads is not part of this package's API, and an `export` on it is an orphan export by the
 * project's own rule — "an export nothing calls". The check caught it on the first CI run.
 */
const SIGN_FLIP_EXACT_LIMIT = 40;

/**
 * The two-sided normal tail `2·(1 − Φ(z))`, for a **non-negative** `z`.
 *
 * `2·(1 − Φ(z)) = erfc(z/√2)`, so this is Abramowitz and Stegun 7.1.26 for `erfc` and nothing else. The form
 * matters for a reason that is not aesthetic: the general `normalCdf` needs a sign branch, this call site only
 * ever passes `|z|`, and a branch that cannot be reached is a branch no test can cover — which is how a dead
 * `x < 0` arm showed up in this package's branch coverage as a single uncovered line. Removing the branch is
 * the repair; suppressing the warning would have left the dead code in place.
 *
 * Accuracy is 1.5×10⁻⁷ absolute on `erf`, four orders of magnitude finer than the difference between this
 * approximation and the exact test it stands in for (0.0177 against 0.0211 on the 34-pair case). Written here
 * rather than pulled from a dependency because the whole use is six lines and a statistics package would be a
 * second thing to keep in step with the two exact tests.
 */
function normalTwoSidedTail(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  return (
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t *
    Math.exp(-x * x)
  );
}

/**
 * Compare one provider across two runs, keyed by question id.
 *
 * Provider names must match: the comparison is "the same arm under two conditions", and pairing a run's
 * `cortex-session` with another run's `mem0` would compare two experiments whose question sets also differ. When
 * both arms come from the **same** run the samples are shared by construction, and that is `compareArmsInRun`.
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
        `'${treatment.provider}'. Two runs also differ in their question set, so a per-question ` +
        'pairing would be comparing two experiments rather than two conditions.',
    );
  }

  return pairCorrectness(baseline.records, treatment.records, baseline.provider);
}

/**
 * The four cells of the 2×2 table, from two per-question record lists.
 *
 * One implementation, because the statistic must not move when the envelope does. `compareRecords` (one arm,
 * two runs) and `compareArmsInRun` (two arms, one run) differ only in where the records come from and in what
 * they refuse; the arithmetic below is the same arithmetic, and a second copy of it would be a second answer to
 * the same question.
 */
function pairCorrectness(
  before: readonly QuestionRecord[],
  after: readonly QuestionRecord[],
  label: string,
): PairedResult {
  const index = new Map(after.map((record) => [record.id, record]));
  let improved = 0;
  let regressed = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  let n = 0;
  let unmatched = 0;

  for (const earlier of before) {
    const later = index.get(earlier.id);
    if (later === undefined) {
      unmatched += 1;
      continue;
    }
    n += 1;
    if (!earlier.correct && later.correct) improved += 1;
    else if (earlier.correct && !later.correct) regressed += 1;
    else if (earlier.correct) bothCorrect += 1;
    else bothWrong += 1;
  }

  return {
    provider: label,
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

/**
 * Compare two arms that answered the same questions **in one harness run**, keyed by question id.
 *
 * ## Why this is not the comparison `compareRecords` refuses
 *
 * `compareRecords` refuses two different provider names because two *runs* also differ in their samples: pairing
 * `cortex-session` from run A with `mem0` from run B would compare two experiments and call the result one
 * condition against another. That reason does not survive into a single run. One harness invocation samples the
 * question list once and gives every arm the same one — `scores[]` carries one `records[]` per arm over the same
 * ids — so the pairing is established by the file, not by matching names. The refusal belongs to the caller,
 * which is the only place that knows whether the two sides came from one run or two.
 *
 * ## What it refuses, and why each refusal is a different mistake
 *
 * - **The same arm twice.** `delta` 0 and `p` 1 by construction; printed, that reads as "measured, no
 *   difference" — a claim about the system that is really a claim about the call.
 * - **A name that is not in the run.** A missing arm is a dispatch that did not select it, and a silent empty
 *   table would be read as "no difference" by anyone who did not know what was asked for.
 * - **An arm that was not read.** Its `correct` is `false` for every question, so it would score as a perfectly
 *   stable floor rather than as an absent measurement.
 * - **Two arms over different question lists.** Within one run that is a harness fault — a record went missing —
 *   and reporting it through `unmatched` would file a defect as a property of the systems being compared. Across
 *   runs the same asymmetry is a fact about the two runs, which is why `compareRecords` reports it there instead.
 */
export function compareArmsInRun(
  scores: readonly ProviderScore[],
  baselineName: string,
  treatmentName: string,
): PairedResult {
  if (baselineName === treatmentName) {
    throw new Error(
      `paired comparison needs two different arms, got '${baselineName}' on both sides. A self-pair is ` +
        'zero by construction, and printing it would report the call as a measurement of no difference.',
    );
  }
  const find = (name: string): ProviderScore => {
    const found = scores.find((score) => score.provider === name);
    if (found === undefined) {
      const known = scores.map((score) => `'${score.provider}'`).join(', ');
      throw new Error(`'${name}' is not in this run. The run measured ${known || 'nothing'}.`);
    }
    return found;
  };
  const baseline = find(baselineName);
  const treatment = find(treatmentName);
  const unread = [baseline, treatment].filter(
    (score) => !score.records.some((record) => record.read),
  );
  if (unread.length > 0) {
    throw new Error(
      `'${unread.map((score) => score.provider).join("' and '")}' was not read in this run, so every ` +
        'question scores as wrong and the pair would read as a stable floor rather than as a measurement.',
    );
  }
  if (baseline.records.length !== treatment.records.length) {
    throw new Error(
      `the two arms answered ${baseline.records.length} and ${treatment.records.length} questions. ` +
        'Every arm in one run answers the same list, so a different count is a lost record, not a property of ' +
        'the two systems.',
    );
  }

  return pairCorrectness(baseline.records, treatment.records, `${baselineName}->${treatmentName}`);
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

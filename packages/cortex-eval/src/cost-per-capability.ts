/**
 * What each capability costs, and what each of them returns for it.
 *
 * ## The question no artifact answers today
 *
 * Every artifact carries the run's accuracy (`feature.metrics`) and the run's tokens
 * (`usageBySide.feature`). Both are for the file. A capability-level accuracy exists too
 * (`featureByCapability`). What does not exist anywhere is the join: **the same capability's
 * share of the prompt and its share of the correct answers, in one row**.
 *
 * That gap matters because the capabilities are not the same size and the arm does not spend on
 * them evenly. On `42533236864` the six-route allocation gives the two reasoning routes 48,460 and
 * 48,000 characters where the other four get 24,000, so `MR` and `TR` fill a window twice as large
 * as `IE`'s — and they are 121 and 127 questions of 500. Those two are **67.3% of the prompt
 * characters in the file**, and the remaining three share the other third. A per-run token figure
 * divides that bill by 500 and reports it as if every question cost the same, which is the
 * average-price fallacy applied to a service whose whole design is route-dependent pricing.
 *
 * ## What is measured and what is apportioned
 *
 * The dividing line is stated here rather than left to the reader, because one column of a table
 * that mixes the two is a table a reader will over-trust.
 *
 * **Measured.** Each capability's question count, its mean prompt characters (from
 * `featurePromptTexts`, which is the delivered prompt and not the assembled one), and its mean
 * correct count (from `featureCorrectByRun`, averaged over repetitions when present). The run's
 * total prompt and completion tokens come from the feature side of `usageBySide`.
 *
 * **Apportioned.** The prompt tokens are split **by each capability's share of the measured
 * characters**, which is the only per-capability quantity the artifact records and the one that is
 * proportional to the thing being split: the same reader receives the same prompt, and a prompt of
 * `n` characters contributes `n` characters' worth of tokens whichever capability asked it. The
 * completion tokens are split **by question-runs**, and that is a weaker claim: the artifact does
 * not record completion per question, so the split assumes a correct answer costs the same
 * reasoning everywhere. It is a null model, it is named as one in the returned reading
 * (`completionApportionment`), and a capability whose completion is systematically longer will read
 * cheaper here than it is.
 *
 * ## Why the density is derived and never assumed
 *
 * An earlier reading of this campaign divided characters by **4.06**, the figure a vendor's English
 * prose lands on. The artifact itself says what the density was: `promptTokens / Σcharacters x runs`.
 * On `42533236864` that is **3.853**, and pricing at 4.06 would have reported a bill 5.1% low for
 * every row while looking like arithmetic rather than like an assumption. So `charsPerToken` is a
 * measured output of this module, printed beside the table, and it is what the token columns are
 * divided by — never a constant.
 *
 * ## Refusals
 *
 * Six, each by name, because every one of them has a default that would produce a confident number:
 * a missing ledger (arms priced at zero), a partially unpriced ledger (a bill that is partly
 * missing), a missing prompt text (a share that cannot be computed), a `null` prompt (a system that
 * exposes no prompt is not one that sent an empty one), missing correctness (a capability whose
 * accuracy is invented), and a length mismatch (two vectors that describe different populations).
 */

/** Per-million-token prices, in the currency the caller's dispatch is billed in. */
export interface TokenPrices {
  /** Cached input tokens. */
  readonly cacheHitCnyPerMillion: number;
  /** Uncached input tokens. */
  readonly cacheMissCnyPerMillion: number;
  /** Output tokens. */
  readonly outputCnyPerMillion: number;
}

/** One capability's row. */
export interface CapabilityCostRow {
  /** The capability's name, as the dataset spells it. */
  readonly capability: string;
  /** Questions in this capability. */
  readonly questions: number;
  /** Mean prompt characters per question, measured from the delivered prompts. */
  readonly meanPromptChars: number;
  /** This capability's share of the run's prompt characters, in `[0, 1]`. */
  readonly promptShare: number;
  /** Prompt tokens apportioned to this capability, over every repetition. */
  readonly promptTokens: number;
  /** Prompt tokens per question-run. */
  readonly promptTokensPerQuestionRun: number;
  /** Mean correct questions per repetition. */
  readonly correctPerRun: number;
  /** Accuracy over repetitions. */
  readonly accuracy: number;
  /**
   * Prompt tokens spent per correct answer, over every repetition.
   *
   * `null` when the capability got nothing right: a ratio with a zero denominator is not a price,
   * it is a division that happened.
   */
  readonly promptTokensPerCorrect: number | null;
  /** Money spent on this capability's prompts. `null` when no prices were supplied. */
  readonly promptCost: number | null;
  /** Money spent on this capability's completions. `null` when no prices were supplied. */
  readonly completionCost: number | null;
  /** `promptCost + completionCost`. `null` when no prices were supplied. */
  readonly cost: number | null;
  /** Money per correct answer. `null` without prices, and `null` when nothing was correct. */
  readonly costPerCorrect: number | null;
  /**
   * This row's **prompt** tokens per correct answer as a multiple of the cheapest row's.
   *
   * This is the ratio the policy grades, and it is the measured one: prompt tokens are apportioned
   * by a quantity the artifact records per question (its delivered characters), so a row's figure is
   * a division of two measurements. {@link CapabilityCostRow.ratioToCheapest} divides money, whose
   * completion half is apportioned by a null model, and the two disagree in a way worth printing
   * side by side -- on `42533236864` `MR` reads **2.05x** on prompts and **1.59x** on money, because
   * completion is 60% of that run's bill and nothing in the artifact says where it went.
   */
  readonly promptRatioToCheapest: number | null;
  /**
   * This row's **total** cost per correct answer as a multiple of the cheapest row's.
   *
   * `null` without prices, or when any row has no cost per correct answer — a ratio against a
   * capability that got nothing right is undefined for the same reason its own price is. Read it
   * beside {@link CapabilityCostRow.promptRatioToCheapest}: the difference between the two is the
   * completion apportionment, which is a null model.
   */
  readonly ratioToCheapest: number | null;
}

/** The whole reading. */
export interface CostByCapability {
  /** Repetitions the artifact ran. */
  readonly runs: number;
  /** Whether the artifact recorded a correctness mask per repetition. */
  readonly repetitionsMeasured: boolean;
  /**
   * What the token columns were divided by: measured prompt tokens per measured character.
   */
  readonly charsPerToken: number;
  /** Share of the run's prompt tokens that arrived as cache hits. */
  readonly cacheHitShare: number;
  /** The apportionment base the completion tokens use. Named so a reader can discount it. */
  readonly completionApportionment: 'question-runs';
  /** The rows, ordered by the artifact's `CAPABILITIES` order. */
  readonly rows: readonly CapabilityCostRow[];
  /** The capability with the highest cost per correct answer. `null` without prices. */
  readonly mostExpensivePerCorrect: string | null;
  /** The rows whose cost per correct answer is at least `expensiveRatio` times the cheapest. */
  readonly expensive: readonly string[];
  /**
   * The capability with the highest prompt tokens per correct answer.
   *
   * Always present, unlike {@link CostByCapability.mostExpensivePerCorrect}: this axis needs no
   * prices, so it is a reading every artifact can be held to.
   */
  readonly mostExpensivePerCorrectOnPrompts: string;
  /** The multiple above which a row is called expensive. */
  readonly expensiveRatio: number;
}

/** The policy the reading grades against. */
export const COST_BY_CAPABILITY_POLICY = Object.freeze({
  /**
   * The multiple at which a row is called expensive, graded on the **measured** axis.
   *
   * Prompt tokens per correct answer, not money: a policy that fired on apportioned completion
   * would be a threshold over an assumption. Two is the point at which a capability buys a correct
   * answer for twice what the cheapest one does, which is the point at which spending on it needs a
   * reason beyond "it is in the file".
   */
  expensiveRatio: 2,
});

/** Refusal text, one per condition. Exported so a test can assert the exact reason. */
export const COST_REFUSALS = Object.freeze({
  noLedger: 'the artifact carries no feature-side token ledger',
  unpriced: 'the artifact carries unpriced calls, so no capability can be priced',
  noPrompts: 'the artifact carries no delivered prompt texts, so no share can be apportioned',
  nullPrompt: 'a delivered prompt is null, which is a system that exposed none',
  noCorrectness:
    'the artifact carries neither a correctness mask nor a per-question correctness list',
  lengthMismatch: 'the prompt texts and the question list describe different populations',
});

/** The structural subset of an ablation report this module reads. */
export interface CostArtifactShape {
  readonly runs?: number | undefined;
  readonly usageBySide?:
    | {
        readonly feature?:
          | {
              readonly calls?: number | undefined;
              readonly unpricedCalls?: number | undefined;
              readonly promptTokens?: number | undefined;
              readonly completionTokens?: number | undefined;
              readonly cacheHitPromptTokens?: number | undefined;
            }
          | undefined;
      }
    | undefined;
  readonly questions?: readonly { readonly capability?: string | undefined }[] | undefined;
  readonly ablation?:
    | {
        readonly runs?: number | undefined;
        readonly questionsByCapability?: Record<string, number> | undefined;
        readonly featureCorrect?: readonly boolean[] | undefined;
        readonly featureCorrectByRun?: readonly string[] | undefined;
        readonly featurePromptTexts?: readonly (string | null)[] | undefined;
      }
    | undefined;
}

/** The order every table in this repository prints capabilities in. */
const CAPABILITY_ORDER = ['IE', 'MR', 'KU', 'TR', 'ABS'] as const;

/**
 * Read one artifact into the join described in this file's header.
 *
 * Throws on each of `COST_REFUSALS`, prefixed with `cost-per-capability: ` so a CLI can print the
 * reason without inventing one.
 */
export function costPerCapability(
  report: CostArtifactShape,
  options: { readonly prices?: TokenPrices | undefined } = {},
): CostByCapability {
  const feature = report.usageBySide?.feature;
  if (feature === undefined) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.noLedger}`);
  }
  const unpricedCalls = feature.unpricedCalls ?? 0;
  if (unpricedCalls > 0) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.unpriced}`);
  }
  const promptTokens = feature.promptTokens ?? 0;
  const completionTokens = feature.completionTokens ?? 0;
  const cacheHitPromptTokens = feature.cacheHitPromptTokens ?? 0;
  if (promptTokens <= 0) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.noLedger}`);
  }

  const ablation = report.ablation;
  const prompts = ablation?.featurePromptTexts;
  if (prompts === undefined || prompts.length === 0) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.noPrompts}`);
  }
  const questions = report.questions;
  if (questions === undefined || questions.length === 0) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.lengthMismatch}`);
  }
  if (questions.length !== prompts.length) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.lengthMismatch}`);
  }
  if (prompts.some((text) => text === null)) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.nullPrompt}`);
  }

  const runs = report.ablation?.runs ?? report.runs ?? 1;
  const mask = ablation?.featureCorrectByRun;
  const flat = ablation?.featureCorrect;
  if (mask === undefined && flat === undefined) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.noCorrectness}`);
  }

  // Per-question character counts and per-question correctness, in dataset order. Both are kept as
  // arrays rather than folded into per-capability sums because the correctness is per repetition and
  // the characters are not: folding early would divide a four-repetition numerator by a one-
  // repetition denominator.
  // Every `null` prompt has already been refused above, so this is a list of strings; the cast
  // states that once rather than leaving a `?? ''` branch in the arithmetic that no artifact can
  // reach and no test can therefore cover.
  const texts = prompts as readonly string[];
  const chars = texts.map((text) => text.length);
  const totalChars = chars.reduce((sum, value) => sum + value, 0);
  if (totalChars <= 0) {
    throw new Error(`cost-per-capability: ${COST_REFUSALS.noPrompts}`);
  }

  const byCapability = new Map<
    string,
    { questions: number; chars: number; correct: number; correctRuns: number }
  >();
  for (let index = 0; index < questions.length; index += 1) {
    const capability = questions[index]?.capability ?? 'UNKNOWN';
    const entry = byCapability.get(capability) ?? {
      questions: 0,
      chars: 0,
      correct: 0,
      correctRuns: 0,
    };
    entry.questions += 1;
    entry.chars += chars[index] as number;
    if (mask !== undefined) {
      // Run-major, one character per dataset question: a question's correct count is the number of
      // repetitions whose character at this index is `'1'`. `correctRuns` is the repetition count
      // itself and is set once, not accumulated per question -- summing it here is the bug that
      // reads a 150-question capability as `0.94` instead of `141`.
      let hits = 0;
      for (const repetition of mask) {
        if (repetition[index] === '1') hits += 1;
      }
      entry.correct += hits;
      entry.correctRuns = mask.length;
    } else {
      // One of the two was required above, and the mask branch above took the other case, so this
      // is the flat list. Stated as a cast rather than as `else if (flat !== undefined)`: that guard
      // is unreachable, and an unreachable branch is a branch no test can cover.
      const verdicts = flat as readonly boolean[];
      entry.correct += verdicts[index] === true ? 1 : 0;
      entry.correctRuns = 1;
    }
    byCapability.set(capability, entry);
  }

  const cacheHitShare = cacheHitPromptTokens / promptTokens;
  const repeats = mask !== undefined ? mask.length : 1;
  const charsPerToken = (totalChars * repeats) / promptTokens;
  const prices = options.prices;
  const totalQuestionRuns = questions.length * runs;

  const rows: CapabilityCostRow[] = [];
  for (const capability of orderedCapabilities(byCapability.keys())) {
    // Every name here came out of this map a few lines above, so the lookup cannot miss and the
    // count cannot be zero. The cast replaces two guards that no artifact can pass through.
    const entry = byCapability.get(capability) as typeof byCapability extends Map<string, infer V>
      ? V
      : never;
    const promptShare = entry.chars / totalChars;
    const apportionedPromptTokens = promptTokens * promptShare;
    const questionRuns = entry.questions * runs;
    const apportionedCompletionTokens = completionTokens * (questionRuns / totalQuestionRuns);
    const correctPerRun = entry.correct / Math.max(1, entry.correctRuns);
    const accuracy = correctPerRun / entry.questions;
    const correctAnswers = correctPerRun * runs;
    const promptTokensPerCorrect =
      correctAnswers > 0 ? apportionedPromptTokens / correctAnswers : null;

    let promptCost: number | null = null;
    let completionCost: number | null = null;
    if (prices !== undefined) {
      promptCost =
        (apportionedPromptTokens *
          (cacheHitShare * prices.cacheHitCnyPerMillion +
            (1 - cacheHitShare) * prices.cacheMissCnyPerMillion)) /
        1_000_000;
      completionCost = (apportionedCompletionTokens * prices.outputCnyPerMillion) / 1_000_000;
    }
    const cost =
      promptCost === null || completionCost === null ? null : promptCost + completionCost;

    rows.push({
      capability,
      questions: entry.questions,
      meanPromptChars: entry.chars / entry.questions,
      promptShare,
      promptTokens: apportionedPromptTokens,
      promptTokensPerQuestionRun: apportionedPromptTokens / questionRuns,
      correctPerRun,
      accuracy,
      promptTokensPerCorrect,
      promptCost,
      completionCost,
      cost,
      costPerCorrect: cost === null || correctAnswers <= 0 ? null : cost / correctAnswers,
      promptRatioToCheapest: null,
      ratioToCheapest: null,
    });
  }

  // Two ratios over two denominators, and they are not interchangeable. The prompt axis divides two
  // measurements (delivered characters and the ledger's token total) and is what the policy grades;
  // the money axis divides a number whose completion half is a null model. A table that printed only
  // the second would turn an assumption into a verdict.
  const promptCheapest = Math.min(
    ...rows.map((row) => row.promptTokensPerCorrect ?? Number.POSITIVE_INFINITY),
  );
  const priced = rows.filter((row) => row.costPerCorrect !== null);
  const cheapest =
    priced.length === rows.length && rows.length > 0
      ? Math.min(...priced.map((row) => row.costPerCorrect as number))
      : null;

  const withRatios = rows.map((row) => {
    const promptRatio =
      Number.isFinite(promptCheapest) && row.promptTokensPerCorrect !== null
        ? row.promptTokensPerCorrect / promptCheapest
        : null;
    const moneyRatio =
      cheapest === null || row.costPerCorrect === null ? null : row.costPerCorrect / cheapest;
    return { ...row, promptRatioToCheapest: promptRatio, ratioToCheapest: moneyRatio };
  });

  const mostExpensivePerCorrect =
    cheapest === null
      ? null
      : ([...withRatios].sort(
          (a, b) => (b.costPerCorrect as number) - (a.costPerCorrect as number),
        )[0]?.capability ?? null);
  const mostExpensivePerCorrectOnPrompts =
    [...withRatios].sort(
      (a, b) => (b.promptTokensPerCorrect as number) - (a.promptTokensPerCorrect as number),
    )[0]?.capability ?? '';

  return {
    runs,
    repetitionsMeasured: mask !== undefined,
    charsPerToken,
    cacheHitShare,
    completionApportionment: 'question-runs',
    rows: withRatios,
    mostExpensivePerCorrect,
    mostExpensivePerCorrectOnPrompts,
    expensive: withRatios
      .filter(
        (row) =>
          row.promptRatioToCheapest !== null &&
          row.promptRatioToCheapest >= COST_BY_CAPABILITY_POLICY.expensiveRatio,
      )
      .map((row) => row.capability),
    expensiveRatio: COST_BY_CAPABILITY_POLICY.expensiveRatio,
  };
}

/**
 * The capabilities present, in the repository's order, with anything unrecognised after them.
 *
 * Unknown names are kept rather than dropped: a dataset that adds a seventh capability would
 * otherwise vanish from the table and take its tokens with it, and a total that silently excludes a
 * row is the defect the whole file exists to remove. They sort alphabetically so two runs of the
 * same artifact print the same table.
 */
function orderedCapabilities(present: Iterable<string>): string[] {
  const names = [...present];
  const known = CAPABILITY_ORDER.filter((capability) => names.includes(capability));
  const unknown = names.filter((name) => !CAPABILITY_ORDER.includes(name as never)).sort();
  return [...known, ...unknown];
}

/**
 * Render the reading as the table this repository's documents quote.
 *
 * Money is printed to three decimals because the smallest row in a 500-question run is a few
 * hundredths of a CNY and rounding it to two would print `0.00` for a capability that is not free.
 */
export function renderCostByCapability(reading: CostByCapability): string {
  const lines: string[] = [];
  lines.push(
    `cost per capability, ${reading.runs} repetition(s), ${reading.charsPerToken.toFixed(3)} chars/token ` +
      `(measured), cache hit ${(reading.cacheHitShare * 100).toFixed(1)}%`,
  );
  lines.push('');
  const priced = reading.rows.some((row) => row.cost !== null);
  const header = [
    'capability'.padEnd(10),
    'n'.padStart(4),
    'chars/q'.padStart(8),
    'share'.padStart(7),
    'tok/q-run'.padStart(10),
    'acc'.padStart(8),
  ];
  if (priced) {
    header.push(
      'CNY'.padStart(8),
      'CNY/correct'.padStart(12),
      'x money'.padStart(9),
      'tok/correct'.padStart(12),
      'x prompt'.padStart(9),
    );
  } else {
    header.push('tok/correct'.padStart(13), 'x prompt'.padStart(9));
  }
  lines.push(header.join(' '));
  for (const row of reading.rows) {
    const cells = [
      row.capability.padEnd(10),
      String(row.questions).padStart(4),
      row.meanPromptChars.toFixed(0).padStart(8),
      `${(row.promptShare * 100).toFixed(1)}%`.padStart(7),
      row.promptTokensPerQuestionRun.toFixed(0).padStart(10),
      `${(row.accuracy * 100).toFixed(2)}%`.padStart(8),
    ];
    if (priced) {
      cells.push(
        (row.cost as number).toFixed(3).padStart(8),
        (row.costPerCorrect === null ? '-' : row.costPerCorrect.toFixed(4)).padStart(12),
        (row.ratioToCheapest === null ? '-' : `${row.ratioToCheapest.toFixed(2)}x`).padStart(9),
      );
    }
    cells.push(
      (row.promptTokensPerCorrect === null ? '-' : row.promptTokensPerCorrect.toFixed(0)).padStart(
        priced ? 12 : 13,
      ),
      (row.promptRatioToCheapest === null
        ? '-'
        : `${row.promptRatioToCheapest.toFixed(2)}x`
      ).padStart(9),
    );
    lines.push(cells.join(' '));
  }
  lines.push('');
  lines.push(
    `most expensive per correct answer, on prompts: ${reading.mostExpensivePerCorrectOnPrompts}` +
      (reading.expensive.length > 0
        ? `; at or above ${reading.expensiveRatio}x the cheapest: ${reading.expensive.join(', ')}`
        : `; none at or above ${reading.expensiveRatio}x the cheapest`),
  );
  if (reading.mostExpensivePerCorrect !== null) {
    lines.push(
      `the same reading in money: ${reading.mostExpensivePerCorrect} (completion apportioned by ` +
        `${reading.completionApportionment}, so the money ratios are flatter than the prompt ones)`,
    );
  }
  return lines.join('\n');
}

/**
 * Scientific metric computation: exact match, Top-1 accuracy, abstention-aware
 * accuracy, per-capability breakdown, and run aggregation. All statistics reuse
 * the high-precision primitives from @agentix-e/cortex-core.
 */
import { binomialCdf, mean, variance, welchTTest } from '@agentix-e/cortex-core';
import type {
  AdmittedEvidence,
  AggregateStats,
  Answer,
  BenchmarkDataset,
  Capability,
  Metrics,
  PerCapabilityResult,
  Question,
  RetrievedTurns,
} from './types.js';
import { toJudgeQuestionType, type AnswerJudge } from './judge.js';

const ALL_CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/** Normalize an answer for exact-match comparison. */
export function normalizeAnswer(a: unknown): string {
  // A dataset may store a numeric answer as a JSON number rather than a string,
  // so coerce it before the string operations (which would otherwise throw).
  return String(a).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function exactMatch(actual: Answer, expected: string | null): boolean {
  if (expected === null) {
    return actual === null;
  }
  if (actual === null) {
    return false;
  }
  return normalizeAnswer(actual) === normalizeAnswer(expected);
}

function emptyCapability(): PerCapabilityResult {
  return { total: 0, correct: 0, accuracy: 0, abstained: 0 };
}

/** Compute metrics from a dataset and the system's answers. */
export function computeMetrics(dataset: BenchmarkDataset, answers: Answer[]): Metrics {
  if (dataset.questions.length !== answers.length) {
    throw new Error(
      `answer count mismatch: ${answers.length} answers for ${dataset.questions.length} questions`,
    );
  }
  const perCapability = Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, emptyCapability()]),
  ) as Record<Capability, PerCapabilityResult>;

  let correct = 0;
  let abstained = 0;
  let abstentionCorrect = 0;

  for (let i = 0; i < dataset.questions.length; i++) {
    const q = dataset.questions[i]!;
    const answer = answers[i]!;
    const isExact = exactMatch(answer, q.expected);
    const isAbstain = answer === null;

    if (isExact) {
      correct++;
    }
    if (isAbstain) {
      abstained++;
      if (q.expected === null) {
        abstentionCorrect++;
      }
    }

    const bucket = perCapability[q.capability];
    bucket.total++;
    if (isExact) {
      bucket.correct++;
    }
    if (isAbstain) {
      bucket.abstained++;
    }
  }

  for (const c of ALL_CAPABILITIES) {
    const bucket = perCapability[c];
    bucket.accuracy = bucket.total === 0 ? 0 : bucket.correct / bucket.total;
  }

  const total = dataset.questions.length;
  const accuracy = total === 0 ? 0 : correct / total;
  return {
    accuracy,
    abstentionRate: total === 0 ? 0 : abstained / total,
    abstentionCorrectRate: abstained === 0 ? 0 : abstentionCorrect / abstained,
    // Exact-match accuracy already treats a correct abstention (null==null) as
    // correct, so abstention-aware accuracy equals accuracy.
    abstentionAwareAccuracy: accuracy,
    total,
    correct,
    perCapability,
  };
}

/** A scorer decides whether an answer is correct for a question. */
export type AnswerScorer = (question: Question, answer: Answer) => Promise<boolean> | boolean;

/** Evaluation output including per-question correctness for paired tests. */
export type ScoredEvaluation = {
  metrics: Metrics;
  /** Correctness of each answer, aligned with `dataset.questions`. */
  correct: boolean[];
  /**
   * The answers themselves, aligned with `dataset.questions`.
   *
   * ## Why these are returned and not discarded
   *
   * They were discarded, and the cost was measured. `AblationReport.questions` -- the
   * per-question record field three downstream readers were blocked on -- was never
   * populated by the cortex-memory arm, and the reason traced back here: this function
   * scored the answers and returned only the booleans, so the model's actual output for
   * every question existed during the run and was dropped before any caller could
   * record it.
   *
   * A `correct` boolean cannot be read for language, and the question §55.4 left open
   * is precisely a question about the model's text: 30 abstention questions declined,
   * and not one of the 30 outputs survived into any artifact. A record of what a system
   * said is the only thing that can answer it.
   *
   * Kept as a third field rather than folded into `correct` so the existing vector
   * callers keep the exact shape they were written against.
   */
  answers: Answer[];
  /**
   * The system's raw model output per question, aligned with `dataset.questions`.
   *
   * `null` means the model was not consulted for that question (a machine-derived
   * abstention) or the system exposes no raw output at all. Either way there is no
   * text; `''` would claim the model replied with nothing, which is a different
   * statement and one this field must not make.
   *
   * ## Why the parsed `answers` above are not enough
   *
   * `Answer` is `string | null` and `parseAnswer` recognises a decline from the
   * last non-empty line only, after stripping a label like `Answer:` and comparing
   * case-insensitively. The bare token, a labelled token, and an explanation
   * followed by the token therefore all arrive as `null`, and dispatch
   * `37792539133` is the measurement: 115 of its 120 roster records read `null`,
   * so which of the three shapes produced the 29 baseline-correct losses was
   * unrecoverable. A boolean cannot be read for language and neither can the
   * summary of the text it was derived from.
   *
   * Optional because a caller that does not ask for a capture has nothing to put
   * here, and manufacturing an empty vector would make "not requested" and "no
   * model was consulted" the same reading.
   */
  rawOutputs?: (string | null)[];
  /**
   * The evidence each question's reader was shown, per question.
   *
   * §13 measured MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every
   * capability, and the artifact could not say whether retrieval returned the
   * wrong evidence or none. Those are repaired in different places, and the
   * roster carried `turns: []` for every record because this arm collected no
   * retrieval text.
   *
   * Optional for the reason `rawOutputs` is: a caller that did not ask for the
   * capture has nothing to put here, and an empty vector would make "not
   * requested" and "the reader was shown nothing" the same reading.
   */
  retrievedContexts?: (RetrievedTurns | null)[];
  /**
   * The evidence characters each question's prompt actually carried, per question.
   *
   * Captured with `retrievedContexts` and never without it, because the two answer
   * one question between them: the context is what the reader was shown and this
   * is how much of it survived the prompt builder's character budget.
   *
   * Run `38044858147` met that budget on every question -- 506,338 characters of
   * evidence against 24,000 -- so the context vector alone overstated what the
   * model received by about twenty times, and `§13.11.5`'s ranking question cannot
   * be asked of an artifact that stops at the truncation boundary.
   *
   * `null` per question means the system exposes no such accessor, which is a
   * different statement from a prompt that carried nothing.
   */
  promptEvidenceChars?: (number | null)[];
  /**
   * What admission produced, per question, in the same order.
   *
   * The offer rather than the delivery: see `types.ts`'s `AdmittedEvidence`. It is
   * optional like the other captures, and omitted rather than defaulted, because a
   * fabricated zero would read as a system that admitted nothing.
   */
  admittedEvidence?: (AdmittedEvidence | null)[];
};

/**
 * Exact paired McNemar test. Given two systems evaluated on the SAME questions,
 * `b` counts questions the baseline answered correctly but the feature answered
 * incorrectly, and `c` counts the reverse. Under the null hypothesis the
 * discordant pairs split evenly, so the two-tailed p-value is the exact binomial
 * tail of Bin(b + c, 0.5) at min(b, c). Unlike a Welch t-test over repeated
 * runs, this is meaningful for a single deterministic evaluation.
 */
export function mcnemarPValue(b: number, c: number): number {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
    throw new Error(`discordant counts must be non-negative integers, got b=${b}, c=${c}`);
  }
  const n = b + c;
  if (n === 0) {
    // No discordant pairs: the systems agree on every question.
    return 1;
  }
  const tail = binomialCdf(Math.min(b, c), n, 0.5);
  return Math.min(1, 2 * tail);
}

/** Exact-match scorer (normalized string equality). */
export function exactMatchScorer(question: Question, answer: Answer): boolean {
  return exactMatch(answer, question.expected);
}

/**
 * Extract the number that LEADS an answer value. Accepts strings and numbers
 * because a dataset may store a numeric answer as a JSON number rather than a
 * string. The match is anchored to the start (after an optional currency sign)
 * so a verbose answer that happens to embed a digit later — e.g. "I viewed four
 * properties ... a 1-bedroom condo" — is not mistaken for a numeric answer.
 * Comma grouping ("$2,500") is tolerated. Returns `undefined` when there is no
 * leading number, signalling the caller to fall back to the LLM judge.
 */
export function extractLeadingNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = value.trim().match(/^\$?\s*(-?\d[\d,]*(?:\.\d+)?)/);
  return match ? Number(match[1]!.replace(/,/g, '')) : undefined;
}

/** True when the question asks for a count or quantity. */
export function isCountingQuestion(question: string): boolean {
  return /\b(how many|how much|number of|count|total)\b/i.test(question);
}

/**
 * Deterministic numeric equivalence for counting questions. An LLM judge is
 * unreliable for numeric answers ("5 distinct projects" vs "2") because it
 * focuses on semantics rather than the leading number, so counting questions
 * with numeric answers are compared arithmetically before delegating to the
 * judge. Returns `undefined` when the question is not a counting question or
 * either answer lacks a leading number, signalling the caller to fall back to
 * the LLM judge.
 *
 * ## Which number the answer is compared by, and why it is not only the first
 *
 * The gate used to compare the LEADING number of each side. That is correct for a
 * bare answer -- "3" against "3 days" -- and wrong for a ledger. Run `38985220145`
 * is the first run whose answers are the model's answer rather than its transcript
 * (§13.40.5), and its multi-session answers became ledgers, so the leading number is
 * an OPERAND:
 *
 *     gold "17 days"    answer "10 days + 7 days = 17 days / 17"
 *     gold "$2,500"     answer "$800 + $1,200 + $500 = $2,500 / $2,500"
 *     gold "$495"       answer "$225 + (20 x $7.5) + $120 = ... = $495."
 *
 * Read as a leading number, each of those is 10, 800 and 225, none of which is the
 * gold -- and the run marked all three wrong while the arithmetic in them is right.
 * The rule is therefore: **the gold matches when it is any number the answer
 * states**, which for a bare answer is exactly the old comparison (its leading
 * number is one of the numbers it states) and for a ledger is the total.
 *
 * ## Why this is a widening and not a trade
 *
 * It only ever accepts more. It cannot reject an answer the old rule accepted,
 * because `leading number of the answer == gold` implies `the answer states the
 * gold`. And the deferral is untouched: an answer that does not LEAD with a number
 * still returns `undefined` and still reaches the judge, which is what keeps the
 * three archived runs byte-identical -- re-graded offline against this rule, runs
 * `38595325261`, `38828538851` and `38953157688` change **0 verdicts**, and only
 * `38985220145` changes, by 28 records, all false -> true, all with correct
 * arithmetic.
 */
export function numericAnswerVerdict(
  question: string,
  predicted: unknown,
  expected: unknown,
): boolean | undefined {
  if (!isCountingQuestion(question)) {
    return undefined;
  }
  // A gold that states more than one acceptable value cannot be graded by
  // comparing a single extracted number. LongMemEval contains golds such as
  // "11 days (or 12 days, ...)" where the dataset itself sanctions the
  // alternative, and the leading-number gate would reject it outright without
  // ever consulting the judge. Defer those to the LLM.
  if (countDistinctEvaluableNumbers(expected) > 1) {
    return undefined;
  }
  // Narrowing rather than a second rule: these are exactly the types
  // `extractLeadingNumber` can read, so nothing here can decline a question the gate
  // would otherwise grade. It exists so `statedNumbers` can take `string | number`
  // and have no branch that a caller cannot reach -- the alternative was a total
  // function with a dead arm, which is a coverage hole pretending to be safety.
  if (!isReadableValue(predicted) || !isReadableValue(expected)) {
    return undefined;
  }
  const p = extractLeadingNumber(predicted);
  const e = extractLeadingNumber(expected);
  if (p === undefined || e === undefined) {
    return undefined;
  }
  // `p` is read for the deferral only, and deliberately: the answer's leading number
  // is what tells this gate the answer is numeric at all. Which number it is compared
  // BY is the set below.
  return statedNumbers(predicted).includes(e);
}

/** True when `extractLeadingNumber` can read the value at all. */
function isReadableValue(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * Every number an answer states, in order, with thousands separators removed.
 *
 * A narrower reader than the one the gold uses on purpose: the gold's reader only
 * needs to know whether the dataset sanctioned an alternative, while this one
 * decides a verdict, so it takes the same shape `extractLeadingNumber` accepts --
 * digits with optional grouping and an optional decimal part -- and nothing else.
 * A number word is not a number here; that is measured rather than careless, because
 * the archived runs' word answers reach the judge and must keep reaching it.
 */
function statedNumbers(value: string | number): number[] {
  if (typeof value === 'number') {
    return [value];
  }
  // `matchAll` rather than `match`, so there is no `?? []` arm: the caller has already
  // established that this string leads with a number, which makes a null result
  // impossible and an `?? []` branch unreachable. A dead arm is a coverage hole that
  // reads like safety.
  return [...value.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(([token]) =>
    Number(token.replace(/,/g, '')),
  );
}

/**
 * Count the numbers a gold answer states, treating a decimal point as part of a
 * value rather than a separator, and ignoring the digits of an embedded
 * thousands separator. Used only to detect golds that offer alternatives, so it
 * deliberately errs toward reporting more values: reporting one too many merely
 * defers the question to the judge, while reporting one too few would let the
 * numeric gate reject a sanctioned answer.
 */
function countDistinctEvaluableNumbers(value: unknown): number {
  if (typeof value === 'number') {
    return 1;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const matches = value.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return new Set(matches.map((m) => m.replace(/,/g, ''))).size;
}

/**
 * The four ways a verdict leaves `judgeScorer`.
 *
 * A union rather than a runtime list, because nothing iterates it: the partition is
 * enforced by `counted`'s parameter type, so a fifth door cannot be added without
 * naming a channel, and `ScorerChannelStats` then requires a counter for it. An
 * array that nothing reads was flagged by lint as a value used only as a type, which
 * is the same observation made mechanically.
 */
type ScorerChannel = 'structural' | 'exact' | 'numeric' | 'judge';

/**
 * Process-wide per-channel verdict counts.
 *
 * Cumulative, with no reset: one arm's process serves one run, so what a run prints
 * describes that run and nothing needs zeroing. A reset exported for a test's
 * convenience would be an export with no production caller, which is what the census
 * in `tools/export-census.mjs` exists to refuse -- so the tests assert the CHANGE
 * between two reads instead, which is stronger, because a counter that had been
 * cleared could satisfy the weaker form.
 *
 * ## Why the run has to report this itself
 *
 * Run `38953157688` (`ask: enumerated`) raised MR's accuracy by 4.95pp and the rise
 * was entirely judge-decided: the mechanical channels decided 86 of MR's 121
 * verdicts under `computed` and 33 under `enumerated`, **none** of the latter true,
 * while the median answer length went from 3 characters to 349. Every number that
 * ask produced was therefore a joint statement about the answer contract and about
 * the judge's tolerance of a long enumerated list -- and nothing in the run said so.
 * The split had to be reconstructed offline from the artifact with a stubbed judge.
 *
 * A counter here is the smallest thing that makes the next run say it, and it is
 * observation only: no verdict changes and no artifact field is added.
 *
 * Mirrors `retryStats()` in `cortex-llm` down to the reset, and for the same reason:
 * a process-wide aggregate is what the layers above can read without being threaded
 * a parameter they do not otherwise want.
 */
const scorerChannels: ReturnType<typeof scorerChannelStats> = {
  structural: 0,
  exact: 0,
  numeric: 0,
  judge: 0,
  verdicts: 0,
};

/** A copy, so a caller holding it cannot mutate numbers already read. */
export function scorerChannelStats(): {
  structural: number;
  exact: number;
  numeric: number;
  judge: number;
  verdicts: number;
} {
  return { ...scorerChannels };
}

/** One line naming each channel's share, for an entry point to print. */
export function describeScorerChannels(stats: ReturnType<typeof scorerChannelStats>): string {
  const share =
    stats.verdicts === 0 ? 'n/a' : `${((stats.judge / stats.verdicts) * 100).toFixed(1)}%`;
  return (
    `scorer channels: structural ${stats.structural}, exact ${stats.exact}, ` +
    `numeric ${stats.numeric}, judge ${stats.judge}/${stats.verdicts} = ${share}`
  );
}

/**
 * Record which door a verdict left by, and return it.
 *
 * A helper rather than four `scorerChannels[...] += 1` statements, so that a return
 * path added later without a channel is a type error rather than a silent fifth
 * door -- which is what makes the four exhaustive by construction.
 */
function counted(channel: ScorerChannel, verdict: boolean): boolean {
  scorerChannels[channel] += 1;
  scorerChannels.verdicts += 1;
  return verdict;
}

/** LLM-judge scorer: abstentions are graded structurally, others via the judge. */
export function judgeScorer(judge: AnswerJudge): AnswerScorer {
  return async (question, answer) => {
    if (question.expected === null) {
      return counted('structural', answer === null);
    }
    if (answer === null) {
      // Structural too: the absence of an answer decided it, and neither a
      // comparison nor the judge was consulted. Counting it as `exact` would
      // overstate the channel that proves a match, and this one can never prove one.
      return counted('structural', false);
    }
    // Normalized string equality is the strongest equivalence signal and needs
    // no LLM: an exact answer is always correct. This short-circuit also cuts
    // the dominant LLM cost of the benchmark, since exact matches are frequent.
    if (normalizeAnswer(answer) === normalizeAnswer(question.expected)) {
      return counted('exact', true);
    }
    // Counting questions are graded numerically first, so a verbose answer
    // cannot trick the LLM judge into accepting "5" for "2". The gate refuses to
    // answer when the gold states more than one acceptable value, because
    // `extractLeadingNumber` would read only the first and reject a prediction
    // that matches one of the sanctioned alternatives.
    const numeric = numericAnswerVerdict(question.question, answer, question.expected);
    if (numeric !== undefined) {
      return counted('numeric', numeric);
    }
    return counted(
      'judge',
      await judge(
        question.question,
        answer,
        question.expected,
        toJudgeQuestionType(question.questionType ?? '', question.expected === null),
      ),
    );
  };
}

/** Compute metrics using an arbitrary (possibly async) answer scorer. */
/** Compute metrics plus per-question correctness using an arbitrary scorer. */
export async function scoreEvaluation(
  dataset: BenchmarkDataset,
  answers: Answer[],
  scorer: AnswerScorer,
  rawOutputs?: (string | null)[],
  retrievedContexts?: (RetrievedTurns | null)[],
  promptEvidenceChars?: (number | null)[],
  admittedEvidence?: (AdmittedEvidence | null)[],
): Promise<ScoredEvaluation> {
  if (dataset.questions.length !== answers.length) {
    throw new Error(
      `answer count mismatch: ${answers.length} answers for ${dataset.questions.length} questions`,
    );
  }
  const perCapability = Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, emptyCapability()]),
  ) as Record<Capability, PerCapabilityResult>;

  let correct = 0;
  let abstained = 0;
  let abstentionCorrect = 0;
  const correctPerQuestion: boolean[] = [];

  for (let i = 0; i < dataset.questions.length; i++) {
    const q = dataset.questions[i]!;
    const answer = answers[i]!;
    const isCorrect = await scorer(q, answer);
    const isAbstain = answer === null;
    correctPerQuestion.push(isCorrect);

    if (isCorrect) {
      correct++;
    }
    if (isAbstain) {
      abstained++;
      if (q.expected === null) {
        abstentionCorrect++;
      }
    }

    const bucket = perCapability[q.capability];
    bucket.total++;
    if (isCorrect) {
      bucket.correct++;
    }
    if (isAbstain) {
      bucket.abstained++;
    }
  }

  for (const c of ALL_CAPABILITIES) {
    const bucket = perCapability[c];
    bucket.accuracy = bucket.total === 0 ? 0 : bucket.correct / bucket.total;
  }

  const total = dataset.questions.length;
  const accuracy = total === 0 ? 0 : correct / total;
  return {
    metrics: {
      accuracy,
      abstentionRate: total === 0 ? 0 : abstained / total,
      abstentionCorrectRate: abstained === 0 ? 0 : abstentionCorrect / abstained,
      // A correct abstention (null==null) is graded as correct by the scorer, so
      // abstention-aware accuracy equals accuracy.
      abstentionAwareAccuracy: accuracy,
      total,
      correct,
      perCapability,
    },
    correct: correctPerQuestion,
    answers,
    ...(rawOutputs === undefined ? {} : { rawOutputs }),
    ...(retrievedContexts === undefined ? {} : { retrievedContexts }),
    ...(promptEvidenceChars === undefined ? {} : { promptEvidenceChars }),
    ...(admittedEvidence === undefined ? {} : { admittedEvidence }),
  };
}

/** Aggregate a list of per-run scores into min/max/avg/median. */
export function aggregate(scores: readonly number[]): AggregateStats {
  if (scores.length === 0) {
    throw new Error('aggregate of empty list');
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: mean(sorted),
    median,
  };
}

/** Cohen's d effect size from two samples. */
export function cohensD(a: readonly number[], b: readonly number[]): number {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) {
    return 0;
  }
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  if (pooled === 0) {
    // Zero variance with identical means → no effect; differing means → infinite effect.
    return ma === mb ? 0 : mb > ma ? Infinity : -Infinity;
  }
  return (mb - ma) / pooled;
}

/** Two-tailed Welch t-test p-value between two score samples. */
export function tTestPValue(a: readonly number[], b: readonly number[]): number {
  return welchTTest(a, b);
}

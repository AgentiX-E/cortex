import type { ConfidenceInterval } from '@agentix-e/cortex-core';

/**
 * Core types for the Cortex scientific evaluation harness.
 *
 * Declaration-only: every export below is a `type` or an `interface`, and all of
 * this module's import sites use `import type`. Nothing here produces a runtime
 * value, which is why `vitest.config.ts` lists this exact path as excluded from
 * coverage — an instrumented module with no executable code reports 0/0/0/0, and
 * that number would describe the instrument rather than the code. Adding a
 * runtime export to this file would silently void that exclusion, so a value
 * belongs in its own module instead.
 */

/** LongMemEval-style capability tags. */
export type Capability = 'IE' | 'MR' | 'KU' | 'TR' | 'ABS';

export type Question = {
  id: string;
  capability: Capability;
  /** The raw LongMemEval `question_type` (e.g. `single-session-assistant`). */
  questionType?: string;
  question: string;
  /** Expected answer; `null` means the correct response is to abstain. */
  expected: string | null;
  /** Session facts available to the memory system before answering. */
  context: string[];
  /**
   * Session-grouped context (each element is one session's ordered turns). It
   * preserves session boundaries for multi-session reasoning. When present, a
   * session-aware system receives this instead of the flattened `context`.
   */
  sessions?: string[][];
  /** The date the question was asked; needed for relative-time (TR) answers. */
  questionDate?: string;
};

export type BenchmarkDataset = {
  name: string;
  questions: Question[];
};

/** A single answer: a string, or `null` to abstain. */
export type Answer = string | null;

/**
 * A memory system under evaluation.
 *
 * **The contract is wider than this type.** `runBenchmark` routes on the presence
 * of the optional members declared by `SessionAwareMemorySystem` below, so a system
 * must be conformant not only in shape but in behaviour: every optional path it
 * declares will be called, with a particular argument shape, and must return
 * `Answer`. `{ name, answer }` alone is fully conformant and receives every
 * question.
 *
 * [`memory-system-conformance.test.ts`](./__tests__/memory-system-conformance.test.ts)
 * asserts that routing contract executably — which member each question shape is
 * routed to, in what order, and what happens when a member is absent. It is the
 * suite an implementation of this type is verified against; see
 * [`docs/AUDIT-EVAL-CONTRACTS.md`](../../../docs/AUDIT-EVAL-CONTRACTS.md) for why it
 * did not exist until it was needed.
 */
export type MemorySystem = {
  name: string;
  /**
   * `sessions` is the session-grouped view of `context` when the caller has it.
   * Optional and additive: a system that wants only the flat list is unaffected,
   * and the benchmark already carries it on every question that has one.
   */
  answer: (question: string, context: string[], sessions?: string[][]) => Answer | Promise<Answer>;
};

/**
 * A memory system that can exploit session boundaries. The benchmark routes
 * session-grouped questions to `answerSessions` and falls back to `answer` with
 * the flattened context otherwise.
 */
export type SessionAwareMemorySystem = MemorySystem & {
  answerSessions: (question: string, sessions: string[][]) => Answer | Promise<Answer>;
  /**
   * Temporal-reasoning answering with the question date; optional for simpler
   * systems. Falls back to `answer` when absent.
   *
   * `sessions` is the session-grouped form of the same turns as `context`, when
   * the caller has it. It is OPTIONAL and additive: a system that wants only the
   * flat list keeps receiving exactly that. It exists because admission is
   * bounded by a turn budget, and a session boundary is what lets a system spend
   * that budget on a session retrieval already judged relevant instead of on
   * scattered neighbours. Measured on run 34915402976, correct answers admit
   * 52.4% of their evidence session against 40.0% for failures.
   */
  answerTemporal?: (
    question: string,
    context: string[],
    questionDate?: string,
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering that includes assistant turns. The evidence for a
   * `single-session-assistant` question lives in an assistant turn, so the
   * user-turn-only `answer` path would drop it. Falls back to `answer` when
   * absent.
   */
  answerAssistant?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for abstention questions (the correct answer is to
   * abstain because no answer exists). Uses a conservative abstention wording
   * that does not push the model to choose among candidates. Falls back to
   * `answer` when absent.
   */
  answerAbstention?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for preference/recommendation questions. Unlike the
   * extractive `answer` path, which asks for a single fact and abstains when
   * none is present, these questions ask for a suggestion that reflects the
   * user's stated preferences. Falls back to `answer` when absent.
   */
  answerPreference?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for knowledge-update questions. These questions ask
   * which value a time qualifier selects ("previous" → the earlier value,
   * "currently/most recent" → the later value), which the generic extractive
   * prompt does not make explicit. Falls back to `answer` when absent.
   */
  answerKnowledgeUpdate?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
};

export type PerCapabilityResult = {
  total: number;
  correct: number;
  accuracy: number;
  abstained: number;
};

export type Metrics = {
  /** Exact-match (Top-1) accuracy over all questions. */
  accuracy: number;
  /** Fraction of questions answered with `null`. */
  abstentionRate: number;
  /** Fraction of abstentions that were the correct response. */
  abstentionCorrectRate: number;
  /** Accuracy computed treating `null` as a first-class answer. */
  abstentionAwareAccuracy: number;
  total: number;
  correct: number;
  perCapability: Record<Capability, PerCapabilityResult>;
};

export type AggregateStats = {
  min: number;
  max: number;
  avg: number;
  median: number;
};

/** Paired significance statistics for a single capability. */
export type PerCapabilityPairedStats = {
  total: number;
  baselineCorrect: number;
  featureCorrect: number;
  /** Questions the baseline got right and the feature got wrong. */
  baselineCorrectFeatureIncorrect: number;
  /** Questions the baseline got wrong and the feature got right. */
  baselineIncorrectFeatureCorrect: number;
  /** Exact paired McNemar two-tailed p-value within this capability. */
  mcnemarPValue: number;
  /** True when the per-capability McNemar test is significant at alpha. */
  mcnemarSignificant: boolean;
  /** Wilson 95% confidence interval for baseline accuracy within this capability. */
  baselineConfidence: ConfidenceInterval;
  /** Wilson 95% confidence interval for feature accuracy within this capability. */
  featureConfidence: ConfidenceInterval;
};

export type AblationResult = {
  feature: string;
  baselineAggregate: AggregateStats;
  featureAggregate: AggregateStats;
  /** Mean accuracy difference (feature − baseline). */
  delta: number;
  /** Welch two-tailed p-value over stochastic runs; NaN when runs < 2. */
  pValue: number;
  /** True when the over-run t-test is significant at alpha. */
  significant: boolean;
  /** Cohen's d effect size over stochastic runs. */
  effectSize: number;
  /** Wilson 95% confidence interval for baseline accuracy. */
  baselineConfidence: ConfidenceInterval;
  /** Wilson 95% confidence interval for feature accuracy. */
  featureConfidence: ConfidenceInterval;
  /** Exact paired McNemar two-tailed p-value (paired over questions). */
  mcnemarPValue: number;
  /** True when the paired McNemar test is significant at alpha. */
  mcnemarSignificant: boolean;
  /** Discordant pairs feeding the McNemar test. */
  discordant: {
    /** Questions the baseline got right and the feature got wrong. */
    baselineCorrectFeatureIncorrect: number;
    /** Questions the baseline got wrong and the feature got right. */
    baselineIncorrectFeatureCorrect: number;
  };
  /**
   * Identity of every discordant pair, so a flip COUNT can be audited.
   *
   * The counts answer "how many" and leave "which" unanswerable, and "which" is
   * what separates a mechanism from a coincidence. The conjunction arm reported
   * four flips against one, all inside IE, while its target population (ABS)
   * never moved — zero flips across six runs and 143 ABS questions. That is the
   * difference between "the intervention did nothing" and "the intervention did
   * something somewhere else", and the earlier report could not show it: it
   * carried the flip count and the feature's per-question vector, but neither the
   * question ids nor the baseline's vector, so no archived artifact could name
   * the questions that moved.
   *
   * Ids rather than indices, because an index is meaningful only relative to a
   * dataset order that is not itself recorded. Ids survive reordering, and they
   * let a reader confirm a per-capability count instead of trusting it.
   */
  discordantQuestions: {
    /** Ids of questions the baseline got right and the feature got wrong. */
    readonly baselineCorrectFeatureIncorrect: readonly string[];
    /** Ids of questions the baseline got wrong and the feature got right. */
    readonly baselineIncorrectFeatureCorrect: readonly string[];
  };
  /** Metrics from the first evaluation of the baseline system. */
  baselineMetrics: Metrics;
  /** Metrics from the first evaluation of the feature system. */
  featureMetrics: Metrics;
  /** Per-question correctness of the feature system, in dataset question order. */
  featureCorrect: boolean[];
  /**
   * The feature system's answers, in dataset question order, when the run recorded them.
   *
   * `featureCorrect` says whether each answer was graded right; it does not say
   * what the answer was. Every investigation that needs to read the model's
   * actual output -- §55.4's "what do the 30 abstentions have in common?" above
   * all -- was blocked on that gap: the vector recorded the verdict and the
   * output itself was dropped in `scoreEvaluation` one layer below this result.
   * An abstention appears here as `null`, which is a value and not a hole.
   *
   * Optional because `AblationResult` is a report shape that a dozen tests
   * construct by hand from a correctness vector alone, and a required field would
   * force every one of them to invent an answer list to satisfy the type --
   * putting fabricated data into fixtures to satisfy a compiler. The guarantee
   * that belongs to the measurement is asserted where it can be: the arm's suite
   * requires the records it is built from to carry the answer each system
   * actually produced, and requires them to agree with this vector.
   */
  featureAnswers?: Answer[];
  /**
   * The feature system's raw model output per question, in dataset question order.
   *
   * ## Why `featureAnswers` above is not enough to read
   *
   * `Answer` is `string | null`, and a decline is recognised from the last
   * non-empty line only after a label like `Answer:` is stripped. So the bare
   * token, a labelled token, and an explanation followed by the token all arrive
   * as `null`. Dispatch `37792539133` is the measurement of what that costs: 115
   * of its 120 roster records read `null`, and the 29 questions it exists to
   * explain -- 13 baseline-correct MR and 16 TR -- cannot be told apart. The
   * text that would tell them apart existed in the process and died at
   * `parseAnswer`'s return.
   *
   * `null` here means the model was not consulted (a machine-derived abstention)
   * or the feature exposes no raw output. Both are "no text", and neither is the
   * empty string, which would claim the model replied with nothing.
   *
   * Optional for the same reason `featureAnswers` is: `AblationResult` is a
   * report shape that tests build by hand from a correctness vector, and a
   * required field would make every such fixture invent raw text to satisfy the
   * type. The measurement's guarantee is asserted where it can be -- the arm's
   * suite requires the records to be aligned with the answers they explain.
   */
  featureRawOutputs?: (string | null)[];
  /** Paired significance statistics broken down per capability. */
  perCapability: Record<Capability, PerCapabilityPairedStats>;
};

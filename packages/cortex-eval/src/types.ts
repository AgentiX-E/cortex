/* istanbul ignore file -- type-only declarations, no runtime code */

import type { ConfidenceInterval } from '@agentix-e/cortex-core';

/** Core types for the Cortex scientific evaluation harness. */

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

/** A memory system under evaluation. */
export type MemorySystem = {
  name: string;
  answer: (question: string, context: string[]) => Answer | Promise<Answer>;
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
   */
  answerTemporal?: (
    question: string,
    context: string[],
    questionDate?: string,
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering that includes assistant turns. The evidence for a
   * `single-session-assistant` question lives in an assistant turn, so the
   * user-turn-only `answer` path would drop it. Falls back to `answer` when
   * absent.
   */
  answerAssistant?: (question: string, context: string[]) => Answer | Promise<Answer>;
  /**
   * Single-session answering for abstention questions (the correct answer is to
   * abstain because no answer exists). Uses a conservative abstention wording
   * that does not push the model to choose among candidates. Falls back to
   * `answer` when absent.
   */
  answerAbstention?: (question: string, context: string[]) => Answer | Promise<Answer>;
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
  /** Metrics from the first evaluation of the baseline system. */
  baselineMetrics: Metrics;
  /** Metrics from the first evaluation of the feature system. */
  featureMetrics: Metrics;
  /** Paired significance statistics broken down per capability. */
  perCapability: Record<Capability, PerCapabilityPairedStats>;
};

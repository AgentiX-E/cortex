/* istanbul ignore file -- type-only declarations, no runtime code */

/** Core types for the Cortex scientific evaluation harness. */

/** LongMemEval-style capability tags. */
export type Capability = 'IE' | 'MR' | 'KU' | 'TR' | 'ABS';

export type Question = {
  id: string;
  capability: Capability;
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

export type AblationResult = {
  feature: string;
  baselineAggregate: AggregateStats;
  featureAggregate: AggregateStats;
  /** Mean accuracy difference (feature − baseline). */
  delta: number;
  /** Welch two-tailed p-value. */
  pValue: number;
  /** True when p < 0.05. */
  significant: boolean;
  /** Cohen's d effect size. */
  effectSize: number;
};

/**
 * End-to-end embedding benchmark runner: loads LongMemEval instances, builds a
 * naive baseline and an abstaining feature system over the same embedding, runs
 * a scientific ablation, and renders a Markdown report.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import { loadLongMemEval, type LongMemEvalInstance } from './datasets/longmemeval-loader.js';
import { EmbeddingMemorySystem } from './embedding-memory.js';
import {
  buildAggregationQaPrompt,
  buildLegacyAggregationQaPrompt,
  NaturalLanguageMemorySystem,
} from './natural-language-memory.js';
import { createLlmJudge, type AnswerJudge } from './judge.js';
import { judgeScorer } from './metrics.js';
import type { DecisionTrace } from './natural-language-memory.js';
import { classifyKnowledgeUpdateQualifier } from './fact-store.js';
import { EXTENDED_ENGINE_OPTIONS } from './temporal-engine.js';
import { formatAblationReport, runAblationReport, type AblationReport } from './report.js';

export type BenchmarkRunnerOptions = {
  /** Abstention threshold for the feature system (default 0.5). */
  abstainThreshold?: number;
  /** Number of independent ablation runs (default 3). */
  runs?: number;
  /**
   * LLM sampling temperature for both systems. Defaults to the system default
   * (0, deterministic). Set > 0 together with runs > 1 to measure sampling
   * variance; at 0 repeated runs are identical and the over-run t-test is NaN.
   */
  temperature?: number;
  /** Optional answer judge; defaults to an LLM judge over the same LLM. */
  judge?: AnswerJudge;
  /** Optional callback for per-question decision tracing (diagnostic). */
  onDecision?: (trace: DecisionTrace) => void;
};

export async function runEmbeddingBenchmark(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const threshold = options.abstainThreshold ?? 0.5;
  const baseline = new EmbeddingMemorySystem('naive-baseline', {
    embedding,
    fallback: 'unknown',
  });
  const feature = new EmbeddingMemorySystem('abstain-feature', {
    embedding,
    abstainThreshold: threshold,
  });
  const report = await runAblationReport(dataset, baseline, feature, {
    runs: options.runs ?? 3,
  });
  return { report, markdown: formatAblationReport(report) };
}

/** Natural-language QA benchmark: baseline never abstains; feature abstains. */
export async function runNaturalLanguageBenchmark(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const threshold = options.abstainThreshold ?? 0.5;
  // Query expansion is deterministic at temperature 0, so the baseline and the
  // feature systems can share one cache instead of re-calling the LLM for the
  // same question + expansion builder.
  const expansionCache = new Map<string, string[]>();
  // The baseline and feature systems share one answer cache as well: abstention
  // does not change the QA prompt, so every question the feature system answers
  // reuses the baseline's byte-identical, temperature-0 LLM call instead of
  // re-billing it (≈447 of the 500 feature calls per run).
  const answerCache = new Map<string, string>();
  // Structured calls (temporal-event extraction, KU fact extraction) are a
  // separate LLM entry point from `complete`, so they need a separate cache to
  // be shared across the arms. Without it the KU and TR capabilities still
  // carried a re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const baseline = new NaturalLanguageMemorySystem('nl-naive-baseline', {
    embedding,
    llm,
    enableAbstention: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const feature = new NaturalLanguageMemorySystem('nl-abstain-feature', {
    embedding,
    llm,
    abstainThreshold: threshold,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.onDecision ? { onDecision: options.onDecision } : {}),
  });
  // Natural-language answers need semantic equivalence grading, not exact match.
  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(dataset, baseline, feature, {
    runs: options.runs ?? 3,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

/**
 * Multi-session aggregation ablation. The main natural-language ablation varies
 * abstention, so it cannot attribute an MR accuracy change to the aggregation
 * prompt (both systems share it). This isolates the prompt: both systems disable
 * abstention and differ ONLY in the aggregation prompt — legacy inline-counting
 * vs the CoT enumerate-then-count prompt — so the paired McNemar test on MR
 * questions measures the prompt's contribution directly.
 */
export async function runMrAggregationAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const mrQuestions = dataset.questions.filter((q) => q.capability === 'MR');
  const mrDataset = { name: 'longmemeval-mr', questions: mrQuestions };

  const expansionCache = new Map<string, string[]>();
  // Both arms share one answer cache. The cache is keyed by the fully rendered
  // prompt, so arms whose prompts differ cannot collide — sharing is safe by
  // construction, not by convention. Where the prompts are byte-identical, the
  // second arm reuses the first arm's raw LLM output instead of re-querying.
  //
  // This is not only a cost saving. The hosted endpoint is not reproducible
  // across calls even at `temperature=0`, so re-querying a byte-identical prompt
  // injects a difference between two arms that have no configuration difference.
  // Measured in `34389565513`: arms sharing a cache disagreed on 0 of 470
  // questions, while two identically-configured arms with separate caches
  // disagreed on 2 of 127 (see `analysis/verdicts/p5-pairing-verdict.md`).
  const answerCache = new Map<string, string>();
  // Structured calls (temporal-event extraction, KU fact extraction) are a
  // separate LLM entry point from `complete`, so they need a separate cache to
  // be shared across the arms. Without it the KU and TR capabilities still
  // carried a re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const legacy = new NaturalLanguageMemorySystem('mr-legacy-aggregation', {
    embedding,
    llm,
    enableAbstention: false,
    aggregationPrompt: buildLegacyAggregationQaPrompt,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const cot = new NaturalLanguageMemorySystem('mr-cot-aggregation', {
    embedding,
    llm,
    enableAbstention: false,
    aggregationPrompt: buildAggregationQaPrompt,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(mrDataset, legacy, cot, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

/**
 * Deterministic temporal-engine ablation. The main natural-language ablation
 * enables the deterministic engine in both systems, so it cannot attribute a TR
 * accuracy change to the engine (both systems share it). This isolates the
 * engine: both systems disable abstention and differ ONLY in
 * `enableDeterministicTemporal` — LLM date-reading vs deterministic date
 * arithmetic — so the paired McNemar test on TR questions measures the engine's
 * contribution directly.
 */
export async function runTemporalEngineAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const trQuestions = dataset.questions.filter((q) => q.capability === 'TR');
  const trDataset = { name: 'longmemeval-tr', questions: trQuestions };

  const expansionCache = new Map<string, string[]>();
  // Shared across both arms: keyed by the fully rendered prompt, so arms with
  // different prompts cannot collide, and a byte-identical prompt is never
  // re-queried (the endpoint is not reproducible across calls at temperature 0).
  const answerCache = new Map<string, string>();
  // Structured calls (temporal-event extraction, KU fact extraction) are a
  // separate LLM entry point from `complete`, so they need a separate cache to
  // be shared across the arms. Without it the KU and TR capabilities still
  // carried a re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const llmTemporal = new NaturalLanguageMemorySystem('tr-llm-temporal', {
    embedding,
    llm,
    enableAbstention: false,
    enableDeterministicTemporal: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const deterministicTemporal = new NaturalLanguageMemorySystem('tr-deterministic-temporal', {
    embedding,
    llm,
    enableAbstention: false,
    enableDeterministicTemporal: true,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(trDataset, llmTemporal, deterministicTemporal, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

/**
 * Deterministic-coverage ablation. Isolates the two temporal-engine refinements
 * from the retrieval stack: both systems disable abstention and keep the
 * deterministic engine path on, and they differ ONLY in
 * `temporalEngineOptions` — weekday/named-day window resolution plus
 * unit-scaled margins, and the `before/after <event>` second-event predicate.
 *
 * The two refinements are ablated together rather than separately because they
 * share a single causal claim: the deterministic engine can answer a question it
 * currently falls back on the LLM for. Splitting them would produce two
 * sub-noise arms measuring halves of one mechanism, which the P3a iteration
 * already showed is worse than one arm measuring the mechanism.
 */
export async function runDeterministicCoverageAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const trQuestions = dataset.questions.filter((q) => q.capability === 'TR' && q.questionDate);
  const trDataset = { name: 'longmemeval-tr-deterministic', questions: trQuestions };

  const expansionCache = new Map<string, string[]>();
  // Shared across both arms: keyed by the fully rendered prompt, so arms with
  // different prompts cannot collide, and a byte-identical prompt is never
  // re-queried (the endpoint is not reproducible across calls at temperature 0).
  const answerCache = new Map<string, string>();
  // Structured calls (temporal-event extraction, KU fact extraction) are a
  // separate LLM entry point from `complete`, so they need a separate cache to
  // be shared across the arms. Without it the KU and TR capabilities still
  // carried a re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const baseEngine = new NaturalLanguageMemorySystem('tr-base-engine', {
    embedding,
    llm,
    enableAbstention: false,
    enableTimeWindowAnnotation: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const extendedEngine = new NaturalLanguageMemorySystem('tr-extended-engine', {
    embedding,
    llm,
    enableAbstention: false,
    enableTimeWindowAnnotation: false,
    temporalEngineOptions: EXTENDED_ENGINE_OPTIONS,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(trDataset, baseEngine, extendedEngine, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

/**
 * Time-window annotation ablation. Isolates the labeling feature from the
 * retrieval stack: both systems disable abstention, both keep the deterministic
 * engine on, and they differ ONLY in `enableTimeWindowAnnotation`. The turn list
 * is identical in both arms — the feature relabels turns in place rather than
 * adding or dropping any — so a positive delta is attributable to the reader
 * being able to tell an in-window anchor from a near miss, not to a change in
 * what the reader was shown.
 *
 * This is deliberately a within-context experiment. The three preceding TR arms
 * (date-range, occurrence-date, entity-graph) all widened recall and all lost,
 * which established that TR's bottleneck is discrimination rather than recall
 * depth; an arm that widens context again would re-test a settled question.
 */
export async function runTimeWindowAnnotationAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const trQuestions = dataset.questions.filter((q) => q.capability === 'TR' && q.questionDate);
  const trDataset = { name: 'longmemeval-tr-annotated', questions: trQuestions };

  const expansionCache = new Map<string, string[]>();
  // Shared across both arms: keyed by the fully rendered prompt, so arms with
  // different prompts cannot collide, and a byte-identical prompt is never
  // re-queried (the endpoint is not reproducible across calls at temperature 0).
  const answerCache = new Map<string, string>();
  // Structured calls (temporal-event extraction, KU fact extraction) are a
  // separate LLM entry point from `complete`, so they need a separate cache to
  // be shared across the arms. Without it the KU and TR capabilities still
  // carried a re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  // Both arms run the EXTENDED engine. The annotation is inert without a
  // resolvable window — with the default engine a weekday-anchored question
  // yields no window at all, so an "annotation off vs on" pair would compare two
  // identical prompts and measure nothing. Holding the engine constant across
  // the arms is what makes the delta attributable to the label rather than to
  // the window resolution that feeds it (that resolution is measured separately
  // by `runDeterministicCoverageAblation`).
  const unannotated = new NaturalLanguageMemorySystem('tr-no-time-window', {
    embedding,
    llm,
    enableAbstention: false,
    enableTimeWindowAnnotation: false,
    temporalEngineOptions: EXTENDED_ENGINE_OPTIONS,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const annotated = new NaturalLanguageMemorySystem('tr-time-window', {
    embedding,
    llm,
    enableAbstention: false,
    enableTimeWindowAnnotation: true,
    temporalEngineOptions: EXTENDED_ENGINE_OPTIONS,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(trDataset, unannotated, annotated, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

/**
 * Bitemporal knowledge-update ablation. The main natural-language ablation
 * enables the bitemporal path in both systems, so it cannot attribute a KU
 * accuracy change to it (both systems share it). This isolates the path: both
 * systems disable abstention and differ ONLY in
 * `enableBitemporalKnowledgeUpdate` — CoT time-qualifier mapping vs LLM
 * fact-extraction + exact date-order selection — so the paired McNemar test on
 * KU previous/current questions measures the bitemporal selection's contribution.
 */
export async function runBitemporalKnowledgeUpdateAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const kuTemporalQuestions = dataset.questions.filter(
    (q) => q.capability === 'KU' && classifyKnowledgeUpdateQualifier(q.question) !== 'other',
  );
  const kuTemporalDataset = { name: 'longmemeval-ku-temporal', questions: kuTemporalQuestions };

  const expansionCache = new Map<string, string[]>();
  // Shared across both arms: keyed by the fully rendered prompt, so arms with
  // different prompts cannot collide, and a byte-identical prompt is never
  // re-queried (the endpoint is not reproducible across calls at temperature 0).
  const answerCache = new Map<string, string>();
  // Structured calls (temporal-event extraction, KU fact extraction) are a
  // separate LLM entry point from `complete`, so they need a separate cache to
  // be shared across the arms. Without it the KU and TR capabilities still
  // carried a re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const cot = new NaturalLanguageMemorySystem('ku-cot-knowledge-update', {
    embedding,
    llm,
    enableAbstention: false,
    enableBitemporalKnowledgeUpdate: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const bitemporal = new NaturalLanguageMemorySystem('ku-bitemporal-knowledge-update', {
    embedding,
    llm,
    enableAbstention: false,
    enableBitemporalKnowledgeUpdate: true,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(kuTemporalDataset, cot, bitemporal, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

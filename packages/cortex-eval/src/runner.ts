/**
 * End-to-end embedding benchmark runner: loads LongMemEval instances, builds a
 * naive baseline and an abstaining feature system over the same embedding, runs
 * a scientific ablation, and renders a Markdown report.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import type { RerankScoreFn } from '@agentix-e/cortex-core';
import {
  loadLongMemEval,
  toCapability,
  type LongMemEvalInstance,
} from './datasets/longmemeval-loader.js';
import { cohortCoverage, type CohortCoverage } from './datasets/sampling.js';
import type { Capability } from './types.js';
import { EmbeddingMemorySystem } from './embedding-memory.js';
import {
  buildAggregationQaPrompt,
  buildLegacyAggregationQaPrompt,
  buildQueryExpansionPromptWith,
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
  /**
   * Cross-encoder reranking stage for the feature system (roadmap measure B1).
   * Left undefined, the feature system runs exactly as before the stage existed,
   * which is what makes the ablation arms comparable.
   *
   * The BASELINE deliberately never reranks. The baseline exists to be the
   * untouched reference, so giving it the candidate stage would destroy the
   * comparison it is there to provide.
   */
  reranker?: RerankScoreFn | undefined;
  /**
   * Candidate pool width handed to the reranker (default: the system's `topK`).
   * See `NaturalLanguageMemorySystemOptions.rerankCandidatePool`: a pool equal
   * to `topK` leaves the reranker unable to rescue anything the bi-encoder
   * ranked below the cut, so a meaningful reranking arm needs this set wider.
   */
  rerankCandidatePool?: number | undefined;
  /**
   * Include the entity-identity sentence in the abstention prompt (default true).
   *
   * Exposed only to separate that sentence from the admission cap, which shipped
   * in the same commit and is otherwise perfectly confounded with it. Flip it and
   * run the benchmark to attribute the abstention recovery to one or the other;
   * see `buildConservativeQaPrompt`.
   */
  entityIdentityClause?: boolean;
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
  /**
   * Restrict the retry ablation to these capabilities (default: none, i.e. the
   * whole dataset).
   *
   * The default is the whole dataset because that is the population the retry
   * serves — it is armed inside `respondWith`, which every QA path routes
   * through. The option exists so a scoped re-measurement (e.g. `['MR']` to
   * reproduce the historical number) is possible without reverting the default.
   */
  retryAblationCapabilities?: readonly Capability[] | undefined;
  /**
   * Restrict an ablation to these capabilities (default per-ablation; see
   * `runQueryExpansionDecompositionAblation`, which defaults to `['ABS','IE']`).
   * A mechanism that affects a handful of questions is invisible in a 500-question
   * average, so scoping is what makes its effect distinguishable from model noise.
   */
  capabilities?: readonly Capability[] | undefined;
  /**
   * Whether a cohort-coverage shortfall is a hard error (default true).
   *
   * Set false only to deliberately run an under-covered cohort — a smoke test,
   * or a re-measurement of questions that are present. When false the shortfall
   * is still reported, never hidden.
   */
  requireCohortCoverage?: boolean | undefined;
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
  // be shared across the arms. Without it the KU capability still carried a
  // re-query term after the answer cache was shared.
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
    ...(options.entityIdentityClause !== undefined
      ? { entityIdentityClause: options.entityIdentityClause }
      : {}),
    ...(options.reranker !== undefined ? { reranker: options.reranker } : {}),
    ...(options.rerankCandidatePool !== undefined
      ? { rerankCandidatePool: options.rerankCandidatePool }
      : {}),
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
 * prompt (both systems share it). This isolates the prompt: both systems hold
 * abstention at the graded path's setting and differ ONLY in the aggregation
 * prompt — legacy inline-counting vs the CoT enumerate-then-count prompt — so
 * the paired McNemar test on MR questions measures the prompt's contribution
 * directly.
 *
 * Abstention is held ON rather than off on purpose. Holding it constant is what
 * makes the swap attributable; the VALUE it is held at is a separate decision,
 * and `false` is the wrong one. With it off a model that declines is coerced to
 * the literal string `'unknown'` and recorded as `abstained: false`
 * (`respondWith`), so `abstentionRate` is 0 by construction and the run cannot
 * distinguish "this arm answered" from "this arm gave up quietly". The graded
 * feature system abstains, so an arm that cannot is not the system being graded.
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
  // be shared across the arms. Without it the KU capability still carried a
  // re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const legacy = new NaturalLanguageMemorySystem('mr-legacy-aggregation', {
    embedding,
    llm,
    enableAbstention: true,
    aggregationPrompt: buildLegacyAggregationQaPrompt,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const cot = new NaturalLanguageMemorySystem('mr-cot-aggregation', {
    embedding,
    llm,
    enableAbstention: true,
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
 * engine: both systems hold abstention at the graded path's setting (see
 * `runMrAggregationAblation` for why the constant is ON, not off) and differ
 * ONLY in `enableDeterministicTemporal` — LLM date-reading vs deterministic date
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
  // be shared across the arms. Without it the KU capability still carried a
  // re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const llmTemporal = new NaturalLanguageMemorySystem('tr-llm-temporal', {
    embedding,
    llm,
    enableAbstention: true,
    enableDeterministicTemporal: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const deterministicTemporal = new NaturalLanguageMemorySystem('tr-deterministic-temporal', {
    embedding,
    llm,
    enableAbstention: true,
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
 * from the retrieval stack: both systems hold abstention at the graded path's
 * setting and keep the deterministic engine path on, and they differ ONLY in
 * `temporalEngineOptions` — weekday/named-day window resolution plus
 * unit-scaled margins, and the `before/after <event>` second-event predicate.
 *
 * Holding abstention ON is a reporting fix, not a re-measurement, and the
 * distinction is worth stating exactly. With it off a declined answer is coerced
 * to the literal string `'unknown'`, which scores exactly like an abstention, so
 * the +0.00pp and the 0 discordant pairs from run 35162802298 still stand: a
 * recovery would have moved them. What the setting destroyed is everything the
 * ablation could SAY about the mechanism. P29 established that this population's
 * failure mode is abstention: the temporal kinds the engine will not serve
 * abstain at 19.4% against 2.2% for the kinds it does serve, and the two
 * questions that `extendedTimeRange` provably moves — the weekday anchors "last
 * Saturday" and "last Friday" — both abstained. Yet both arms reported an
 * abstention rate of 0.00%, a figure pinned there by construction. The run
 * therefore could not separate "the option changed nothing" from "the option
 * changed abstentions into different wrong answers", and it measured a system
 * that is not the one being graded: the graded feature system abstains.
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
  // be shared across the arms. Without it the KU capability still carried a
  // re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const baseEngine = new NaturalLanguageMemorySystem('tr-base-engine', {
    embedding,
    llm,
    enableAbstention: true,
    enableTimeWindowAnnotation: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const extendedEngine = new NaturalLanguageMemorySystem('tr-extended-engine', {
    embedding,
    llm,
    enableAbstention: true,
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
 * retrieval stack: both systems hold abstention at the graded path's setting,
 * both keep the deterministic engine on, and they differ ONLY in
 * `enableTimeWindowAnnotation`. The turn list is identical in both arms — the
 * feature relabels turns in place rather than adding or dropping any — so a
 * positive delta is attributable to the reader being able to tell an in-window
 * anchor from a near miss, not to a change in what the reader was shown.
 *
 * The annotation's entire job is a discrimination the model makes at the moment
 * it decides whether it has enough to answer, so abstention is the natural unit
 * of its effect and must be observable in both arms. With it off, both arms
 * reported an abstention rate of 0.00% by construction, which is
 * indistinguishable from "the feature was never wired in" — see
 * `analysis/verdicts/p29-retry-population-causes.md`. The accuracy null from
 * that run is unaffected either way: a declined answer was coerced to
 * `'unknown'`, which scores exactly like an abstention, so a recovery would
 * still have moved accuracy and the discordant count.
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
  // be shared across the arms. Without it the KU capability still carried a
  // re-query term after the answer cache was shared.
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
    enableAbstention: true,
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
    enableAbstention: true,
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
 * systems hold abstention at the graded path's setting (see
 * `runMrAggregationAblation` for why the constant is ON, not off) and differ
 * ONLY in `enableBitemporalKnowledgeUpdate` — CoT time-qualifier mapping vs LLM
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
  // be shared across the arms. Without it the KU capability still carried a
  // re-query term after the answer cache was shared.
  const structuredCache = new Map<string, unknown>();
  const cot = new NaturalLanguageMemorySystem('ku-cot-knowledge-update', {
    embedding,
    llm,
    enableAbstention: true,
    enableBitemporalKnowledgeUpdate: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const bitemporal = new NaturalLanguageMemorySystem('ku-bitemporal-knowledge-update', {
    embedding,
    llm,
    enableAbstention: true,
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

export type RetryAblationReport = {
  ablation: AblationReport;
  /**
   * Times the abstention retry actually re-queried a bare abstention, per arm.
   *
   * A paired McNemar Δaccuracy is a *risky* readout for this feature: the retry
   * is one-directional by construction (it fires only on a bare abstention and
   * is accepted only when the re-ask parses to a real answer), so the expected
   * loss count is exactly zero and the test's power is driven entirely by the
   * gain count. At R = 1 that gain expectation is ~0.5 events, far below what
   * any pair test can resolve — measured power is 0.4 % at 1 run, 28.5 % at 3,
   * and 97.7 % at 8 (`analysis/verdicts/p17-abstention-retry-yield.md` §5).
   *
   * The fire count is therefore the honest small-R diagnostic. `controlFires`
   * MUST be 0: the control arm disables the flag, so any non-zero count means
   * the flag is not reaching the code path and the whole comparison is void.
   * `treatmentFires` being 0 means the feature is inert on this dataset slice —
   * that is a finding about the data, not a failure, but it must be visible,
   * because "0.00 pp with 0 fires" and "0.00 pp with 40 fires" are entirely
   * different claims and the ablation table renders them identically.
   */
  retryFires: { controlFires: number; treatmentFires: number; questions: number };
};

/**
 * Isolate the bare-abstention retry. Every other MR ablation holds the
 * aggregation prompt or the retrieval stack constant and varies something else;
 * this is the only arm that measures the retry, and it is the only arm whose
 * two systems are configurationally IDENTICAL apart from one flag.
 *
 * Both arms enable abstention (the retry only exists on the abstaining path)
 * and both use the default aggregation prompt. They differ ONLY in
 * `enableAbstentionRetry` — control `false`, treatment `true` — so the paired
 * McNemar test attributes any delta to the retry itself and to nothing else.
 *
 * SCOPE: the whole dataset, not the multi-session slice.
 *
 * The retry is armed inside `respondWith`, which every QA path routes through,
 * so the population it can serve is every question — not the multi-session ones
 * this ablation used to filter to. That filter was not a cost saving, it was a
 * mis-scoped instrument, and it made the null result uninterpretable: on run
 * `35097952715` the retry fired 12 times, all on IE/TR/KU, and the MR-only
 * ablation saw 1 fire over 121 questions. 92% of the mechanism's real traffic
 * sat outside the experiment, so `Δ = 0.00 pp` was a measurement of a
 * population the retry barely touches rather than evidence about the retry.
 *
 * The arms SHARE all three caches, exactly as the other MR-adjacent ablations
 * do, and this is load-bearing rather than a cost optimisation. The hosted
 * endpoint is not reproducible across calls even at `temperature = 0`, so two
 * arms that re-query a byte-identical prompt acquire a difference they were not
 * built to measure: measured in run `34389565513`, arms sharing a cache
 * disagreed on 0 of 470 questions, while two identically-configured arms with
 * SEPARATE caches disagreed on 2 of 127 (see
 * `analysis/verdicts/p5-pairing-verdict.md`). With separate caches this
 * ablation would report a non-zero delta on a null treatment.
 *
 * Sharing is sound under EITHER retry design, but for a reason that changed
 * when the retry was put back to a byte-identical re-ask, so the argument is
 * restated rather than carried over:
 *
 *   - Under the rewritten-instruction design (f39e7f9) the retry had its own
 *     cache key, so it made a genuine second request. Sharing the cache still
 *     held the FIRST attempt constant across arms — which is the property this
 *     doc comment is about — and the treatment's extra request was the
 *     treatment. Sound.
 *   - Under the byte-identical design (current) the retry's key IS the first
 *     attempt's key, so the re-ask resolves from the shared cache. The
 *     treatment and the control then differ in nothing observable, the ablation
 *     reports a clean `Δ = 0.00 pp`, and that is the true answer: there is no
 *     version of "re-ask the same bytes" that changes the outcome at
 *     temperature 0. A cache-first retry does not silently do nothing; it does
 *     exactly what a byte-identical re-ask can do, which is nothing.
 *
 * What must NOT be reintroduced is a retry that reads a DIFFERENT key yet still
 * cannot differ — that is the shape the old comment warned about, and it is the
 * shape that made eight unit tests blind: they all omitted `answerCache`, so
 * none of them exercised the configuration production actually runs.
 */
export async function runAbstentionRetryAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{
  report: AblationReport;
  markdown: string;
  retryFires: RetryAblationReport['retryFires'];
}> {
  const dataset = loadLongMemEval(instances);
  const questions = options.retryAblationCapabilities
    ? dataset.questions.filter((q) => options.retryAblationCapabilities!.includes(q.capability))
    : dataset.questions;
  const scoped = { name: 'longmemeval-retry', questions };

  const expansionCache = new Map<string, string[]>();
  // Shared across both arms: keyed by the fully rendered prompt, so arms with
  // different prompts cannot collide, and a byte-identical prompt is never
  // re-queried. Without this the arms acquire spurious discordance from the
  // endpoint's non-reproducibility — see the doc comment above.
  const answerCache = new Map<string, string>();
  // Structured calls (temporal-event extraction, KU fact extraction) are a
  // separate LLM entry point from `complete`, so they need a separate cache to
  // be shared across the arms.
  const structuredCache = new Map<string, unknown>();

  // Every decision each arm makes, so the retry can be counted. The counters are
  // per-arm rather than global because the control's count must be provably 0.
  const controlTraces: DecisionTrace[] = [];
  const treatmentTraces: DecisionTrace[] = [];

  const control = new NaturalLanguageMemorySystem('mr-retry-off', {
    embedding,
    llm,
    enableAbstention: true,
    enableAbstentionRetry: false,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    onDecision: (trace) => controlTraces.push(trace),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const treatment = new NaturalLanguageMemorySystem('mr-retry-on', {
    embedding,
    llm,
    enableAbstention: true,
    enableAbstentionRetry: true,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    onDecision: (trace) => treatmentTraces.push(trace),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(scoped, control, treatment, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  const retryFires = {
    controlFires: countRetryFires(controlTraces),
    treatmentFires: countRetryFires(treatmentTraces),
    questions: questions.length,
  };
  return {
    report,
    markdown: `${formatAblationReport(report)}${formatRetryFireSection(retryFires)}`,
    retryFires,
  };
}

/**
 * Distinct QUESTIONS on which the retry actually re-queried.
 *
 * Deduplicated by question, because the same question is evaluated once per
 * ablation run: a raw trace count would grow with `runs` and report that the
 * retry fires eight times more often under `runs: 8` than under `runs: 1`. The
 * fire count is a property of the configuration and the dataset, so it must not
 * be a function of how many times the experiment was repeated. The rate is
 * reported against `questions`, and both sides have to be in the same unit.
 */
function countRetryFires(traces: readonly DecisionTrace[]): number {
  const fired = new Set<string>();
  for (const trace of traces) {
    if (trace.retryFired === true) {
      fired.add(trace.question);
    }
  }
  return fired.size;
}

/**
 * Render the retry fire count as its own section, because it is the diagnostic
 * that makes a null result interpretable and `formatAblationReport` has no slot
 * for a counter. A bare `Δ = 0.00 pp` is unreadable on its own: it is the
 * predicted output of a working feature on a dataset it cannot help, and also
 * the predicted output of a feature that was never wired in.
 */
export function formatRetryFireSection(fires: RetryAblationReport['retryFires']): string {
  const rate = fires.questions === 0 ? 0 : fires.treatmentFires / fires.questions;
  const lines = [
    '',
    '## Abstention-retry fires',
    '',
    '| Arm | Retry fires |',
    '|---|---|',
    `| control (\`enableAbstentionRetry: false\`) | ${fires.controlFires} |`,
    `| treatment (\`enableAbstentionRetry: true\`) | ${fires.treatmentFires} |`,
    '',
    `- Treatment fire rate: **${(rate * 100).toFixed(2)}%** of ${fires.questions} questions`,
  ];
  if (fires.controlFires !== 0) {
    lines.push(
      '',
      `- **INVALID EXPERIMENT**: the control arm fired ${fires.controlFires} times despite ` +
        '`enableAbstentionRetry: false`. The flag is not reaching the retry, so the two arms ' +
        'are not the comparison this ablation claims to make.',
    );
  } else if (fires.treatmentFires === 0) {
    lines.push(
      '',
      '- **INERT ON THIS DATASET**: the treatment arm never fired. The retry had zero ' +
        'opportunities, so the Δ accuracy below measures nothing and must not be read as ' +
        'evidence the feature does not work.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The conjunctive ABS cohort that R4's pre-registered predictions name.
 *
 * `p27-r4-prereg.md` §3 fixes P2 against the target and P3 against all six
 * controls, so both predictions are statements about SPECIFIC questions. That
 * makes cohort completeness a precondition of the experiment, not a property of
 * it: a prediction scored on a cohort that lost five of its six members is not a
 * weaker test, it is a different test that happens to share a name.
 *
 * Every id here is listed with its role so a coverage shortfall names what is at
 * stake rather than just a count.
 */
export const CONJUNCTION_ABS_TARGET = '6456829e_abs' as const;

export const CONJUNCTION_ABS_CONTROLS: readonly string[] = [
  'edced276_abs',
  'e5ba910e_abs',
  'gpt4_70e84552_abs',
  'gpt4_c27434e8_abs',
  'gpt4_fe651585_abs',
  '80ec1f4f_abs',
];

/** The full cohort R4's P2 and P3 are defined over: target plus controls. */
export const CONJUNCTION_ABS_COHORT: readonly string[] = [
  CONJUNCTION_ABS_TARGET,
  ...CONJUNCTION_ABS_CONTROLS,
];

/**
 * Query-expansion conjunction-decomposition ablation (R4). Isolates the
 * expansion instruction from the retrieval stack: both systems hold abstention
 * and the deterministic engine at the graded path's setting and differ ONLY in
 * `queryExpansionPrompt` — fused phrasing vs one phrase per operand.
 *
 * Scoped to the capabilities that exercise conjunction, and to ABS in
 * particular, because that is where the mechanism was observed: `6456829e_abs`
 * asks whether the user used chili or tomatoes, the retrieved context contains
 * the tomatoes and not the chili, and the model answers the answerable half
 * instead of abstaining. A run over all 500 questions would dilute a mechanism
 * that affects a handful of questions by 30x and make a real effect
 * indistinguishable from model noise.
 *
 * `capabilities` therefore defaults to `['ABS', 'IE']`: ABS is the target
 * population and IE is the largest set of single-operand questions, which is
 * where decomposition must do no harm. Both arms share one expansion cache per
 * question, and the two builders produce different prompts for a conjoined
 * question by construction, so the cache cannot mask the treatment.
 *
 * ## Cohort coverage is asserted, not assumed
 *
 * The scoped instances come from the caller's sample, and the round-robin
 * sampler is proportional rather than guarantee-preserving. Measured on
 * LongMemEval-S, the seven-question conjunctive cohort arrives at these sizes:
 *
 * | `LIMIT` | conjunctive ABS present | P2 target present | P3 controls present |
 * |---|---|---|---|
 * | 60 | 1 | no | 1/6 |
 * | 100 | 3 | yes | 3/6 |
 * | 200 | 7 | yes | 6/6 |
 *
 * So at `LIMIT=60` P2 has no target to score and P3 reduces to a single
 * control — a 0-of-1 bound whose one-sided 95% upper bound on the per-question
 * collateral-damage rate is 95%, i.e. it cannot fail for any reason the
 * experiment could detect. That is a vacuous pass that reads as a pass, which is
 * the exact failure mode this guard exists to make impossible.
 *
 * The guard therefore throws when the cohort is incomplete, unless the caller
 * sets `requireCohortCoverage: false`, and the coverage is reported in both
 * cases so an under-covered run is visible in its own artifact.
 */
export async function runQueryExpansionDecompositionAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string; coverage: CohortCoverage }> {
  const dataset = loadLongMemEval(instances);
  const scoped = options.capabilities ?? ['ABS', 'IE'];
  const questions = dataset.questions.filter((q) => scoped.includes(q.capability));
  const scopedDataset = { name: 'longmemeval-conjunction', questions };

  // Measure coverage against the instances the caller supplied, but only count a
  // cohort member the ablation will actually RUN: an ABS question outside the
  // scoped capability set is present in the sample and absent from the
  // experiment, and conflating the two would let a mis-scoped arm pass its own
  // guard.
  const inScope = instances.filter((inst) =>
    scoped.includes(toCapability(inst.question_id, inst.question_type)),
  );
  const coverage = cohortCoverage(inScope, CONJUNCTION_ABS_COHORT);
  if (options.requireCohortCoverage !== false && coverage.missing.length > 0) {
    throw new Error(
      `conjunction ablation cohort is incomplete: ${coverage.present.length}/${CONJUNCTION_ABS_COHORT.length} present, ` +
        `missing ${coverage.missing.join(', ')}. P2/P3 are pre-registered against these exact questions, so scoring the ` +
        `present subset would report a different experiment under the same name. Raise LIMIT until the cohort is ` +
        `covered (200 covers all 7 on LongMemEval-S), or pass requireCohortCoverage: false to run deliberately ` +
        `under-covered with the shortfall recorded.`,
    );
  }

  const expansionCache = new Map<string, string[]>();
  // Shared across both arms. Keyed by the builder NAME plus the question, so the
  // two expansion variants can never collide, and a question whose expansion is
  // identical in both arms (any question the instruction does not fire on) is
  // never re-sent to the provider.
  const answerCache = new Map<string, string>();
  const structuredCache = new Map<string, unknown>();

  const fused = new NaturalLanguageMemorySystem('conjunction-fused', {
    embedding,
    llm,
    enableAbstention: true,
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const decomposed = new NaturalLanguageMemorySystem('conjunction-decomposed', {
    embedding,
    llm,
    enableAbstention: true,
    queryExpansionPrompt: (question: string) =>
      buildQueryExpansionPromptWith(question, { decomposeConjunctions: true }),
    queryExpansionCache: expansionCache,
    answerCache,
    structuredCache,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(scopedDataset, fused, decomposed, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report), coverage };
}

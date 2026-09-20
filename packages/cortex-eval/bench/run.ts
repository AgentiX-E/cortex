/**
 * Benchmark entry point. Reads the LongMemEval JSON from LONGMEMEVAL_PATH, builds
 * a DeepSeek LLM and a Zhipu embedding from environment variables, runs the
 * natural-language QA ablation, and writes Markdown + JSON reports.
 *
 * On failure the script writes `benchmark-error.log` with the full message and
 * stack before exiting non-zero. The workflow uploads this file as an artifact
 * so failures can be diagnosed even when the runner log stream is unavailable.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  checkEmbeddingDeterminism,
  computeRetrievalDiagnostics,
  computeSessionRetrievalDiagnostics,
  createEmbeddingFromEnv,
  createLlmFromEnv,
  computeRecallCurve,
  createRerankerFromEnv,
  deserializeEmbeddingCache,
  hasDiagnosticRecord,
  mergeEmbeddingCache,
  runMrAggregationAblation,
  runNaturalLanguageBenchmark,
  runTemporalEngineAblation,
  runTimeWindowAnnotationAblation,
  runDeterministicCoverageAblation,
  runBitemporalKnowledgeUpdateAblation,
  runAbstentionRetryAblation,
  runQueryExpansionDecompositionAblation,
  CONJUNCTION_ABS_COHORT,
  ABLATION_SKIP_FILENAME,
  buildAblationSkipRecord,
  serializeAblationSkips,
  sampleInstances,
  serializeEmbeddingCache,
  snapshotEmbeddingCache,
  toCapability,
  turnText,
  type AblationSkipRecord,
  type DecisionTrace,
  type LongMemEvalInstance,
} from '@agentix-e/cortex-eval';

/** Resolve an instance's answer session ids to their full session text. */
function answerSessionsContent(inst: LongMemEvalInstance): string[] {
  const sessionIds = inst.haystack_session_ids ?? [];
  const sessions = inst.haystack_sessions ?? [];
  const dates = inst.haystack_dates ?? [];
  const out: string[] = [];
  for (const answerId of inst.answer_session_ids ?? []) {
    const idx = sessionIds.indexOf(answerId);
    if (idx >= 0 && idx < sessions.length) {
      out.push(sessions[idx]!.map((turn) => turnText(turn, dates[idx])).join('\n'));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dataPath = process.env['LONGMEMEVAL_PATH'];
  if (!dataPath) {
    throw new Error('LONGMEMEVAL_PATH is required');
  }
  const parsed = JSON.parse(readFileSync(dataPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`LONGMEMEVAL_PATH must contain a JSON array, got ${typeof parsed}`);
  }
  const instances = parsed as never[];

  // A small LIMIT keeps first-run smoke tests cheap and fast; omit for the full set.
  // Stratified sampling keeps every capability (including abstention) represented.
  const limit = Number(process.env['LIMIT'] ?? 0);
  const sampled = sampleInstances(instances as never, limit);

  const embedding = createEmbeddingFromEnv(process.env);
  const llm = createLlmFromEnv(process.env);
  const threshold = Number(process.env['ABSTAIN_THRESHOLD'] ?? 0.5);
  // The cross-encoder reranking stage (roadmap measure B1). Off unless
  // CORTEX_RERANK is set, so an unset environment reproduces the pre-reranker
  // pipeline exactly and the two configurations form a clean A/B.
  const reranker = createRerankerFromEnv(process.env);
  // Candidate pool width. Defaults to the system's own topK, but reranking can
  // only promote what it is shown, so a real arm wants 3-10x the context width
  // here -- see `rerankCandidatePool`.
  const rerankPoolRaw = process.env['RERANK_CANDIDATE_POOL'];
  const rerankCandidatePool = rerankPoolRaw === undefined ? undefined : Number(rerankPoolRaw);

  // Restore a persisted embedding cache when present. The haystack turns are the
  // SAME across repeated full runs and embedding is deterministic, so reusing a
  // previous run's vectors avoids re-embedding (and re-billing) ~115k turns per
  // run. The workflow supplies this file via GitHub Actions cache.
  const embeddingCachePath = process.env['EMBEDDING_CACHE_PATH'];
  if (embeddingCachePath && existsSync(embeddingCachePath)) {
    try {
      const persisted = deserializeEmbeddingCache(readFileSync(embeddingCachePath));
      mergeEmbeddingCache(persisted);
      console.log(`Restored ${persisted.size} embedding vectors from ${embeddingCachePath}`);
    } catch (err) {
      console.warn(
        `Could not restore embedding cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Default to a single deterministic run: with temperature 0 the systems are
  // deterministic, so repeated runs add cost without variance. Set RUNS>1 only
  // when sampling variance is deliberately introduced via TEMPERATURE>0.
  const runs = Number(process.env['RUNS'] ?? 1);
  // Sampling temperature for both systems (default 0, deterministic). A positive
  // value introduces real sampling variance so the over-run t-test is defined.
  const temperature = Number(process.env['TEMPERATURE'] ?? 0);
  // Runs for the ABLATIONS, which is deliberately independent of `runs` above.
  //
  // Every ablation shares one answer cache across its two arms (the pairing
  // invariant: the endpoint is not reproducible across calls, so re-querying a
  // byte-identical prompt injects discordance the experiment never meant to
  // measure). The consequence is that a second ablation run replays the FIRST
  // run's cached answers, so `runs` > 1 multiplies the wall-clock and the bill
  // while producing a byte-identical report: measured on a one-question MR arm,
  // `runs: 8` issues the same 3 model calls (2 of them aggregation) as
  // `runs: 1`, and the over-run Welch t-test is NaN because all eight repeats
  // carry no independent information.
  //
  // Only the main benchmark benefits from `runs` > 1 — its over-run aggregate
  // statistics are genuinely defined — so the ablations get their own knob and
  // default to the cheapest correct value. Raise `ABLATION_RUNS` only when an
  // ablation's arms are given SEPARATE caches, which no current ablation does.
  const ablationRuns = Number(process.env['ABLATION_RUNS'] ?? 1);

  console.log(
    `Running benchmark on ${sampled.length} instance(s) ` +
      `(limit=${limit === 0 ? 'all' : limit}, runs=${runs}, ablationRuns=${ablationRuns}, ` +
      `temperature=${temperature}, abstainThreshold=${threshold})...`,
  );

  // Verify the embedding provider is deterministic before trusting retrieval
  // scores; a large drift would confound the threshold comparison.
  const determinism = await checkEmbeddingDeterminism(embedding, [
    'determinism probe alpha',
    'determinism probe beta',
  ]);
  console.log(`Embedding determinism (max abs diff): ${determinism}`);

  // Measure the retrieval signal before grading so the abstention threshold can
  // be set from data instead of guessed. Turn-level recall is complemented by
  // session-level recall, which is the signal multi-session aggregation uses.
  //
  // Recall is a statistical estimate, so it is measured on a bounded stratified
  // sample rather than embedding every question's haystack. A full run already
  // embeds ~115k turns for QA retrieval; running the diagnostics over the whole
  // dataset would double that upfront cost and exhaust the embedding quota
  // before the actual benchmark starts. DIAGNOSTICS_LIMIT=0 disables the cap.
  const diagnosticsLimit = Number(process.env['DIAGNOSTICS_LIMIT'] ?? 100);
  const diagnosticsSample =
    diagnosticsLimit > 0 && diagnosticsLimit < sampled.length
      ? sampleInstances(sampled as never, diagnosticsLimit)
      : sampled;
  const turnDiagnostics = await computeRetrievalDiagnostics(
    diagnosticsSample as never,
    embedding,
    5,
    { llm },
  );
  const sessionDiagnostics = await computeSessionRetrievalDiagnostics(
    diagnosticsSample as never,
    embedding,
    5,
    { llm },
  );
  const diagnosticsWithDeterminism = {
    ...turnDiagnostics,
    session: sessionDiagnostics,
    embeddingMaxAbsDiff: determinism,
  };
  writeFileSync('benchmark-diagnostics.json', JSON.stringify(diagnosticsWithDeterminism, null, 2));
  console.log('=== Retrieval diagnostics ===');
  console.log(JSON.stringify(diagnosticsWithDeterminism, null, 2));

  // Recall curve (roadmap measure B2). recall@1 and recall@5 cannot say how much
  // recall is still on the table at 10/20/50, so they cannot justify a candidate
  // pool width. The curve separates breadth from ordering: `ceiling` is what a
  // perfect reranker could reach from a pool of that width, `recall` is what the
  // bi-encoder's own ordering already reaches, and `gain` is the difference --
  // the recall a reranker could add with no new retrieval.
  //
  // Measured at the same query set as the graded path (expansion included), so
  // the ceiling describes the pipeline that actually runs.
  const recallCurve = await computeRecallCurve(diagnosticsSample as never, embedding, { llm });
  writeFileSync('benchmark-recall-curve.json', JSON.stringify(recallCurve, null, 2));
  console.log('=== Recall curve ===');
  console.log(
    `  k      recall   ceiling  gain     (n=${diagnosticsSample.length} sampled questions)`,
  );
  for (const point of recallCurve) {
    console.log(
      `  ${String(point.k).padEnd(6)} ${(point.recall * 100).toFixed(1).padStart(6)}%  ` +
        `${(point.ceiling * 100).toFixed(1).padStart(6)}%  ${(point.gain * 100).toFixed(1).padStart(5)}%`,
    );
  }

  // Trace per-question decisions so threshold- and LLM-driven abstentions can be
  // separated instead of being conflated into a single abstention rate. The
  // trace also carries the retrieved evidence and raw LLM output for MR
  // failure analysis.
  const decisions: DecisionTrace[] = [];
  // The entity-identity sentence and the admission cap shipped in the same
  // commit, so the run that recovered the abstention block cannot attribute the
  // movement to either. `ENTITY_IDENTITY_CLAUSE=0` removes the sentence while
  // leaving the cap in place, which is what separates them. Unset means the
  // shipped configuration (sentence present).
  const entityIdentityClause = process.env['ENTITY_IDENTITY_CLAUSE'] !== '0';
  const { report, markdown } = await runNaturalLanguageBenchmark(sampled as never, embedding, llm, {
    abstainThreshold: threshold,
    entityIdentityClause,
    runs,
    temperature,
    onDecision: (trace) => decisions.push(trace),
    ...(reranker !== undefined ? { reranker } : {}),
    ...(rerankCandidatePool !== undefined ? { rerankCandidatePool } : {}),
  });
  const reasonCounts: Record<string, number> = { empty: 0, threshold: 0, llm: 0, answered: 0 };
  for (const d of decisions) {
    reasonCounts[d.reason] = (reasonCounts[d.reason] ?? 0) + 1;
  }
  console.log('=== Decision reasons (feature system) ===');
  console.log(JSON.stringify(reasonCounts));

  // Per-question correctness of the feature system, keyed by question text so the
  // diagnostics below can annotate each failure with its verdict instead of
  // leaving it to be inferred from aggregate scores. `featureCorrect` is aligned
  // with `sampled` because `loadLongMemEval` maps instances in order.
  const correctByQuestion = new Map<string, boolean>(
    (sampled as LongMemEvalInstance[]).map((inst, i) => [
      inst.question,
      report.ablation.featureCorrect[i] ?? false,
    ]),
  );

  // Dump per-question diagnostics for multi-session (MR) questions so the exact
  // LLM failure mode (missing evidence / wrong format / multi-hop) is visible in
  // the uploaded artifact rather than guessed from aggregate scores.
  const mrDiagnostics = (sampled as LongMemEvalInstance[])
    .filter((inst) => toCapability(inst.question_id, inst.question_type) === 'MR')
    .map((inst) => {
      const trace = [...decisions].reverse().find((d) => d.question === inst.question);
      return {
        question_id: inst.question_id,
        question: inst.question,
        ground_truth: inst.answer,
        correct: correctByQuestion.get(inst.question) ?? false,
        answer_session_ids: inst.answer_session_ids ?? [],
        haystack_dates: inst.haystack_dates ?? [],
        answer_sessions_content: answerSessionsContent(inst),
        decision: trace ?? null,
      };
    });
  writeFileSync('benchmark-mr-diagnostics.json', JSON.stringify(mrDiagnostics, null, 2));
  console.log('=== MR diagnostics ===');
  console.log(JSON.stringify(mrDiagnostics, null, 2));

  // Dump per-question diagnostics for every capability that carries one (IE/KU/TR
  // and ABS) so the exact failure mode — retrieval miss vs LLM over-abstention —
  // is visible in the uploaded artifact instead of guessed from aggregate scores.
  //
  // ABS is included. It was previously excluded on the grounds that it is not a
  // single-session question type, and the cost was that ABS — the capability with
  // both the smallest sample (30) and the largest percentage spread — was the only
  // one with no per-question record, so no cross-run flip analysis could cover it
  // and a re-sampled ABS block would have been invisible. The file name is kept
  // for artifact compatibility; the covered set is now the graded sample minus MR,
  // which has its own file above.
  const singleSessionDiagnostics = (sampled as LongMemEvalInstance[])
    .filter((inst) => hasDiagnosticRecord(inst.question_id, inst.question_type))
    .map((inst) => {
      const trace = [...decisions].reverse().find((d) => d.question === inst.question);
      return {
        question_id: inst.question_id,
        capability: toCapability(inst.question_id, inst.question_type),
        question: inst.question,
        question_date: inst.question_date ?? null,
        ground_truth: inst.answer,
        correct: correctByQuestion.get(inst.question) ?? false,
        decision: trace ?? null,
      };
    });
  writeFileSync(
    'benchmark-single-session-diagnostics.json',
    JSON.stringify(singleSessionDiagnostics, null, 2),
  );
  console.log('=== Single-session diagnostics ===');
  console.log(JSON.stringify(singleSessionDiagnostics, null, 2));

  writeFileSync('benchmark-report.md', markdown);
  writeFileSync(
    'benchmark-report.json',
    JSON.stringify({ ...report, decisionReasons: reasonCounts }, null, 2),
  );
  console.log(markdown);

  // Isolate the MR aggregation prompt contribution: legacy inline-counting vs
  // CoT enumerate-then-count, with abstention held constant so the paired McNemar
  // test measures the prompt effect on MR questions directly.
  const mrAblation = await runMrAggregationAblation(sampled as never, embedding, llm, {
    runs: ablationRuns,
    temperature,
  });
  writeFileSync('benchmark-mr-ablation-report.md', mrAblation.markdown);
  writeFileSync('benchmark-mr-ablation-report.json', JSON.stringify(mrAblation.report, null, 2));
  console.log('=== MR aggregation ablation ===');
  console.log(mrAblation.markdown);

  // Isolate the deterministic temporal engine contribution: LLM date-reading vs
  // deterministic date arithmetic, with abstention held constant so the paired
  // McNemar test measures the engine effect on TR questions directly.
  const trAblation = await runTemporalEngineAblation(sampled as never, embedding, llm, {
    runs: ablationRuns,
    temperature,
  });
  writeFileSync('benchmark-tr-ablation-report.md', trAblation.markdown);
  writeFileSync('benchmark-tr-ablation-report.json', JSON.stringify(trAblation.report, null, 2));
  console.log('=== TR temporal-engine ablation ===');
  console.log(trAblation.markdown);

  // Isolate the time-window annotation: retrieval is identical in both arms and
  // the feature only relabels turns with their distance to the resolved window,
  // so a positive delta is attributable to the reader discriminating an anchor
  // turn from a near miss rather than to any change in what it was shown.
  const trWindowAblation = await runTimeWindowAnnotationAblation(sampled as never, embedding, llm, {
    runs: ablationRuns,
    temperature,
  });
  writeFileSync('benchmark-tr-window-ablation-report.md', trWindowAblation.markdown);
  writeFileSync(
    'benchmark-tr-window-ablation-report.json',
    JSON.stringify(trWindowAblation.report, null, 2),
  );
  console.log('=== TR time-window annotation ablation ===');
  console.log(trWindowAblation.markdown);

  // Isolate the deterministic-engine refinements: weekday/named-day window
  // resolution with unit-scaled margins, and the "before/after <event>"
  // second-event predicate. Both arms run the deterministic path and differ only
  // in whether the refinements are enabled.
  const trCoverageAblation = await runDeterministicCoverageAblation(
    sampled as never,
    embedding,
    llm,
    { runs: ablationRuns, temperature },
  );
  writeFileSync('benchmark-tr-coverage-ablation-report.md', trCoverageAblation.markdown);
  writeFileSync(
    'benchmark-tr-coverage-ablation-report.json',
    JSON.stringify(trCoverageAblation.report, null, 2),
  );
  console.log('=== TR deterministic-coverage ablation ===');
  console.log(trCoverageAblation.markdown);

  // Isolate the bitemporal knowledge-update contribution: CoT time-qualifier
  // mapping vs LLM fact-extraction + exact date-order selection, with abstention
  // held constant so the paired McNemar test measures the bitemporal path on KU
  // previous/current questions directly.
  const kuBitemporalAblation = await runBitemporalKnowledgeUpdateAblation(
    sampled as never,
    embedding,
    llm,
    { runs: ablationRuns, temperature },
  );
  writeFileSync('benchmark-ku-bitemporal-ablation-report.md', kuBitemporalAblation.markdown);
  writeFileSync(
    'benchmark-ku-bitemporal-ablation-report.json',
    JSON.stringify(kuBitemporalAblation.report, null, 2),
  );
  console.log('=== KU bitemporal ablation ===');
  console.log(kuBitemporalAblation.markdown);

  // Isolate the bare-abstention retry. The only arm whose two systems are
  // configurationally identical apart from one flag, so its delta is attributable
  // to the retry itself. Reported alongside the retry fire count, because at
  // realistic run counts the accuracy signal is dominated by model-side noise and
  // the fire count is what separates "inert on this data" from "never wired in".
  const retryAblation = await runAbstentionRetryAblation(sampled as never, embedding, llm, {
    runs: ablationRuns,
    temperature,
  });
  writeFileSync('benchmark-mr-retry-ablation-report.md', retryAblation.markdown);
  writeFileSync(
    'benchmark-mr-retry-ablation-report.json',
    JSON.stringify({ ...retryAblation.report, retryFires: retryAblation.retryFires }, null, 2),
  );
  console.log('=== MR abstention-retry ablation ===');
  console.log(retryAblation.markdown);

  // Isolate the query-expansion conjunction decomposition (R4). Scoped to ABS+IE
  // inside the arm: the mechanism affects a handful of conjunctive questions, and
  // a 500-question average would drown a real effect in model noise.
  //
  // The cohort guard runs inside the arm and throws when the sample lost part of
  // the seven-question conjunctive cohort, because P2/P3 are pre-registered
  // against those exact questions. `LIMIT=60` keeps only 1 of the 6 controls, so
  // the guard is what turns "the run silently scored a smaller cohort" into a
  // visible failure. Coverage is written to the artifact either way.
  //
  // The guard is deliberately NOT softened here. A partial cohort is a different
  // experiment, so downgrading it to a warning would relabel exactly the run the
  // guard exists to reject. What the catcher below fixes is the ORDER: every
  // other report is written before this arm runs, so an unrecovered throw
  // discarded all of them (run 35498421148 lost its main report, its markdown
  // and the embedding-cache persistence to this one line). Catching it keeps the
  // skip loud on stderr while letting the completed reports survive, which is
  // the difference between "refused to score a short cohort" and "scored
  // nothing at all".
  const ablationSkips: AblationSkipRecord[] = [];
  try {
    const conjunctionAblation = await runQueryExpansionDecompositionAblation(
      sampled as never,
      embedding,
      llm,
      {
        runs: ablationRuns,
        temperature,
        // Default 0: keep the guard loud, keep the reports. Set to 1 to restore
        // the strict behaviour where a short cohort fails the entire run.
        requireCohortCoverage: process.env['REQUIRE_CONJUNCTION_COHORT'] === '1',
      },
    );
    writeFileSync('benchmark-conjunction-ablation-report.md', conjunctionAblation.markdown);
    writeFileSync(
      'benchmark-conjunction-ablation-report.json',
      JSON.stringify(
        { ...conjunctionAblation.report, cohortCoverage: conjunctionAblation.coverage },
        null,
        2,
      ),
    );
    console.log('=== query-expansion conjunction ablation ===');
    console.log(
      `Cohort coverage: ${conjunctionAblation.coverage.present.length}/${CONJUNCTION_ABS_COHORT.length} ` +
        `(${(conjunctionAblation.coverage.ratio * 100).toFixed(0)}%)` +
        (conjunctionAblation.coverage.missing.length > 0
          ? `; missing ${conjunctionAblation.coverage.missing.join(', ')}`
          : ''),
    );
    console.log(conjunctionAblation.markdown);
  } catch (err) {
    // Name the shortfall on stderr so the workflow log still carries it, and
    // record it in the artifact set so a reader who finds no conjunction report
    // learns why rather than guessing between "crashed", "never wired" and
    // "silently dropped".
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`conjunction ablation skipped: ${reason}`);
    ablationSkips.push(buildAblationSkipRecord('conjunction', err, CONJUNCTION_ABS_COHORT.length));
  }

  // Written unconditionally, including as `[]`, so the artifact set has the same
  // shape on every run and "nothing was skipped" is not indistinguishable from
  // "this run predates skip recording".
  writeFileSync(ABLATION_SKIP_FILENAME, serializeAblationSkips(ablationSkips));

  // Persist the embedding cache so a later run (which uses the same haystack
  // turns) can restore it and skip the embedding provider. Done after every
  // report so a partial run still saves whatever it has already embedded.
  if (embeddingCachePath) {
    const snapshot = snapshotEmbeddingCache();
    writeFileSync(embeddingCachePath, serializeEmbeddingCache(snapshot));
    console.log(`Persisted ${snapshot.size} embedding vectors to ${embeddingCachePath}`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const full = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : message;
  // Emit a GitHub Actions error annotation (single line) so the failure reason
  // is visible through the check-runs API even when the raw log stream is
  // unavailable. Workflow-command special characters are percent-escaped.
  const annotation = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`::error::${annotation}`);
  console.error(full);
  try {
    writeFileSync('benchmark-error.log', full);
  } catch {
    // Ignore write errors; the console output is the primary diagnostic.
  }
  // Preserve whatever embeddings were computed before the failure so the next
  // run can resume without re-billing for them.
  try {
    const cachePath = process.env['EMBEDDING_CACHE_PATH'];
    if (cachePath) {
      writeFileSync(cachePath, serializeEmbeddingCache(snapshotEmbeddingCache()));
    }
  } catch {
    // Persisting the cache is best-effort; never mask the original error.
  }
  process.exit(1);
});

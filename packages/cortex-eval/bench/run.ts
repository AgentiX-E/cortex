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
  runRerankAblation,
  CONJUNCTION_ABS_COHORT,
  ABLATION_SKIP_FILENAME,
  buildAblationSkipRecord,
  serializeAblationSkips,
  sampleInstances,
  serializeEmbeddingCache,
  snapshotEmbeddingCache,
  toCapability,
  turnText,
  attributeRecallGap,
  decomposeFailures,
  classifyTrFailure,
  adjudicateGroundedFailure,
  type Metrics,
  type DiagnosticRecord,
  type AblationSkipRecord,
  type DecisionTrace,
  type LongMemEvalInstance,
} from '@agentix-e/cortex-eval';

/**
 * A diagnostic record plus the fields the TR classifier reads.
 *
 * `DiagnosticRecord` in the eval package narrows `decision` to the two fields the
 * census needs. The classifier also reads `retrieved` and `answer`, and the
 * record carries `ground_truth` and `question_date`, so the wider shape is
 * stated here rather than widening the census type to fields it does not use.
 */
type TrClassifiableRecord = DiagnosticRecord & {
  readonly question_date?: string;
  readonly ground_truth?: string | number | null;
  readonly decision: DiagnosticRecord['decision'] & {
    readonly retrieved?: string;
    readonly answer?: string | null;
  };
};

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

/**
 * Flatten a `Metrics` figure into the per-capability array the attribution takes.
 *
 * Iterates the record rather than a hard-coded capability list, so a capability
 * added to the dataset is attributed without a second edit here -- and a
 * capability present in one arm but not the other is caught by the attribution's
 * own comparison rather than silently dropped by this function.
 */
function toCapabilityAccuracy(
  metrics: Metrics,
): { capability: string; total: number; correct: number; abstained: number }[] {
  return Object.entries(metrics.perCapability).map(([capability, value]) => ({
    capability,
    total: value.total,
    correct: value.correct,
    abstained: value.abstained,
  }));
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
  // How many leading hits the reranker is not allowed to move. Left unset the
  // reranker reorders the whole list. It exists because the abstention decision is
  // read from `hits[0].score`: pinning the first hit keeps a reordering stage from
  // silently relocating the abstention boundary, which is how RRF v1 turned a
  // ranking change into an IE drop from 95.0% to 87.5%. Set it to the admitted head
  // width to A/B "reorder everything" against "reorder below a protected head"
  // without touching code.
  const rerankProtectedHeadRaw = process.env['RERANK_PROTECTED_HEAD'];
  const rerankProtectedHead =
    rerankProtectedHeadRaw === undefined ? undefined : Number(rerankProtectedHeadRaw);

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
  //
  // The curve reports its own denominator and the questions it left out. That
  // matters because the graded accuracy is measured over `sampled.length` while
  // the curve can only cover questions with a retrievable answer turn; on the
  // first full run those were 500 and 428, and the artifact named neither. Any
  // reader comparing `ceiling` to accuracy is now comparing two populations
  // that are both stated.
  const recallCurve = await computeRecallCurve(diagnosticsSample as never, embedding, { llm });
  writeFileSync('benchmark-recall-curve.json', JSON.stringify(recallCurve, null, 2));
  console.log('=== Recall curve ===');
  console.log(
    `  k      recall   ceiling  gain     (n=${recallCurve.considered} of ` +
      `${diagnosticsSample.length} sampled questions)`,
  );
  for (const point of recallCurve.points) {
    console.log(
      `  ${String(point.k).padEnd(6)} ${(point.recall * 100).toFixed(1).padStart(6)}%  ` +
        `${(point.ceiling * 100).toFixed(1).padStart(6)}%  ${(point.gain * 100).toFixed(1).padStart(5)}%`,
    );
  }
  if (recallCurve.excluded.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const e of recallCurve.excluded) {
      byReason.set(e.reason, [...(byReason.get(e.reason) ?? []), e.questionId]);
    }
    console.log(`  excluded from the curve, by reason (${recallCurve.excluded.length} total):`);
    for (const [reason, ids] of [...byReason].sort()) {
      console.log(
        `    ${reason.padEnd(11)} ${String(ids.length).padStart(4)}  e.g. ${ids[0] ?? '-'}`,
      );
    }
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
    ...(rerankProtectedHead !== undefined ? { rerankProtectedHead } : {}),
  });
  const reasonCounts: Record<string, number> = { empty: 0, threshold: 0, llm: 0, answered: 0 };
  for (const d of decisions) {
    reasonCounts[d.reason] = (reasonCounts[d.reason] ?? 0) + 1;
  }
  console.log('=== Decision reasons (feature system) ===');
  console.log(JSON.stringify(reasonCounts));

  // Attribute the recall curve's k=1 gap to the mechanism that could close it.
  //
  // The curve reports a gap and the roadmap read it as "ranking is the
  // bottleneck". The rerank arms then measured no effect, which refuted the
  // inference without explaining the gap. The missing step is that a gap
  // measures what retrieval DELIVERED, not what the reader could have USED: a
  // question whose evidence sat at rank 30 but which the reader answered anyway
  // from the rest of its context is not recoverable by ranking better.
  //
  // Writing the attribution into the artifact rather than leaving it to a probe
  // is the point. The last three defects in this area were all a number that
  // existed only in a console line or in an operator's notebook (see
  // AUDIT-SILENT-DENOMINATOR.md and AUDIT-DISCORDANT-IDENTITY.md); a figure that
  // decides which subsystem gets worked on next has to be in the artifact the
  // decision is reviewed against.
  const k1Point = recallCurve.points.find((point) => point.k === 1);
  if (k1Point !== undefined) {
    const attribution = attributeRecallGap({
      curve: {
        considered: recallCurve.considered,
        ceiling: k1Point.ceiling,
        recallAtOne: k1Point.recall,
      },
      baseline: toCapabilityAccuracy(report.ablation.baselineMetrics),
      feature: toCapabilityAccuracy(report.ablation.featureMetrics),
    });
    writeFileSync('benchmark-gap-attribution.json', JSON.stringify(attribution, null, 2));
    console.log('=== k=1 gap attribution ===');
    console.log(
      `  denominator ${attribution.curveDenominator} (run graded ` +
        `${attribution.runQuestionCount}; ${attribution.absentFromDenominatorQuestions} ` +
        `absent, all abstention)`,
    );
    console.log(
      `  admitted ${attribution.admittedAtOne} + ranking gap ` +
        `${attribution.rankingGapQuestions} + retrieval gap ` +
        `${attribution.retrievalGapQuestions} = ${attribution.curveDenominator}`,
    );
    console.log(
      `  of the ranking gap, ${attribution.gapAlreadyAbsorbedByReader} are already ` +
        `absorbed by the reader; recoverable ${attribution.recoverableFromRanking}`,
    );
    console.log(
      `  improvement: abstention ${attribution.improvementFromAbstention}, ` +
        `everything else ${attribution.improvementFromOtherCapabilities}`,
    );
  }

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

  // Census where the failures actually are.
  //
  // The report states the accuracy as one figure and the roadmap spends it on
  // capability ranking, but nothing had ever said WHICH questions are missing --
  // even though the diagnostics above carry the capability, the verdict and the
  // decision for every one of them. The information was in the artifact and
  // absent from the reading of it.
  //
  // The census is written to its own file for the same reason the gap
  // attribution is: a figure that decides which subsystem gets worked on next
  // belongs in the artifact the decision is reviewed against, not in a console
  // line. See `failure-census.ts` for why the refused/answered split is two axes
  // rather than one, and why the capability is inferred for MR records.
  //
  // Both diagnostic files are read here because they partition the run: the
  // single-session file holds everything except MR, and the MR file holds MR.
  const census = decomposeFailures({
    records: [
      ...(mrDiagnostics as DiagnosticRecord[]),
      ...(singleSessionDiagnostics as DiagnosticRecord[]),
    ],
  });
  writeFileSync('benchmark-failure-census.json', JSON.stringify(census, null, 2));
  console.log('=== Failure census ===');
  console.log(
    `  ${census.failed} failed of ${census.total} (${census.correct} correct); ` +
      `${census.failedAnswered} answered wrong, ${census.failedRefused} refused wrong`,
  );
  console.log(`  abstained overall: ${census.abstained}`);
  for (const [capability, slice] of Object.entries(census.byCapability).sort(
    (a, b) => b[1].failed - a[1].failed,
  )) {
    console.log(
      `    ${capability.padEnd(5)} ${String(slice.failed).padStart(3)} failed of ` +
        `${String(slice.total).padStart(3)}  ` +
        `(answered ${slice.failedAnswered}, refused ${slice.failedRefused})`,
    );
  }

  // Why the TR failures happened, which neither the census nor the report says.
  //
  // The census locates 36 TR failures and splits them into answered-wrong and
  // refused-wrong. It does not say why any of them failed, and the two possible
  // mechanisms need opposite work: an answer that was in the context and was
  // misread sends the work to the reader, while an answer that was never
  // retrieved sends it to retrieval. At 51% of all failures, TR is the
  // population where that distinction decides the next subsystem.
  //
  // The classification is emitted with its own confidence term. The retrieved
  // contexts run 8k-14k characters and the TR answers are single digits, so a
  // grounded verdict from a token that occurs once is a different claim from one
  // where the digit occurs ninety-five times as a date fragment. Reporting the
  // count rather than folding it into the verdict is what keeps the two
  // separable: the strong population is the one that justifies work on the
  // reader, and the weak one does not.
  //
  // Only answered-wrong questions are classified. A refusal cannot be grounded or
  // ungrounded -- the reader produced no assertion to check -- and putting the
  // refused population in either bucket would invent a finding.
  const trFailures = [
    ...(mrDiagnostics as TrClassifiableRecord[]),
    ...(singleSessionDiagnostics as TrClassifiableRecord[]),
  ]
    .filter((record) => record.capability === 'TR' && !record.correct && !record.decision.abstained)
    .map((record) => {
      const detail = classifyTrFailure(
        {
          question: record.question,
          groundTruth: record.ground_truth ?? null,
          answer: record.decision.answer ?? null,
          retrieved: record.decision.retrieved ?? '',
          questionDate: record.question_date ?? '',
        },
        { detail: true },
      );
      return {
        questionId: record.question_id,
        groundTruth: record.ground_truth ?? null,
        answer: record.decision.answer ?? null,
        classification: detail.classification,
        maxDistinctiveOccurrences: detail.maxDistinctiveOccurrences,
        maxOccurrenceToken: detail.maxOccurrenceToken,
        answerTokens: detail.answerTokens,
        // Only a grounded verdict has candidates to adjudicate. An ungrounded
        // question never retrieved the answer, so asking whether the reader
        // chose between retrieved candidates is not a question that applies.
        adjudication:
          detail.classification === 'grounded'
            ? adjudicateGroundedFailure({
                groundTruth: record.ground_truth ?? null,
                readerAnswer: record.decision.answer ?? null,
                retrieved: record.decision.retrieved ?? '',
              })
            : null,
      };
    });

  const trGrounded = trFailures.filter((f) => f.classification === 'grounded').length;
  const trUngrounded = trFailures.length - trGrounded;
  // Bucketed on the distinctive-token count, not the raw one. The raw count read
  // the English article in several real records: `gpt4_59149c78` was filed as
  // weak evidence because `the` occurs 95 times in its context, while
  // `metropolitan` -- the token that identifies the museum -- occurs once.
  const trStrong = trFailures.filter(
    (f) => f.classification === 'grounded' && f.maxDistinctiveOccurrences <= 2,
  ).length;
  const trWeak = trFailures.filter(
    (f) => f.classification === 'grounded' && f.maxDistinctiveOccurrences >= 10,
  ).length;
  const trCompeting = trFailures.filter((f) => f.adjudication === 'competing-candidates').length;
  const trEvidenceOnly = trFailures.filter((f) => f.adjudication === 'evidence-only').length;
  const trUnadjudicable = trFailures.filter((f) => f.adjudication === 'unadjudicable').length;

  writeFileSync(
    'benchmark-tr-failure-classes.json',
    JSON.stringify(
      {
        total: trFailures.length,
        grounded: trGrounded,
        ungrounded: trUngrounded,
        groundedStrongEvidence: trStrong,
        groundedWeakEvidence: trWeak,
        adjudication: {
          competingCandidates: trCompeting,
          evidenceOnly: trEvidenceOnly,
          unadjudicable: trUnadjudicable,
        },
        questions: trFailures,
      },
      null,
      2,
    ),
  );
  console.log('=== TR failure classification ===');
  console.log(
    `  ${trFailures.length} answered-wrong TR failures: ` +
      `${trGrounded} grounded, ${trUngrounded} ungrounded`,
  );
  console.log(
    `    of the grounded, ${trStrong} rest on 1-2 occurrences (reader-attributable), ` +
      `${trWeak} on >=10 (token is ubiquitous, verdict is weak)`,
  );
  console.log(
    `    adjudication: ${trCompeting} competing-candidates, ` +
      `${trEvidenceOnly} evidence-only, ${trUnadjudicable} unadjudicable`,
  );

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
  // The report carries `retryFires` itself (see `AblationReport`), so it is
  // serialised as-is. Spreading the side-channel field back in here would
  // reintroduce exactly the two-paths-can-disagree shape that made the fire table
  // vanish from a re-rendered report: the Markdown got it from a concatenation at
  // the runner's return site, the JSON from this spread, and the renderer knew
  // about neither.
  writeFileSync(
    'benchmark-mr-retry-ablation-report.json',
    JSON.stringify(retryAblation.report, null, 2),
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
    // The report already carries `cohortCoverage` (see `AblationReport`), so it
    // is serialised rather than re-attached here. Spreading the side-channel
    // field back in would leave two paths that can disagree about coverage,
    // which is how the Markdown came to describe a 1-of-7 cohort as an ordinary
    // ablation in the first place.
    writeFileSync(
      'benchmark-conjunction-ablation-report.json',
      JSON.stringify(conjunctionAblation.report, null, 2),
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

  // Reranking A/B (roadmap measure B1). Distinct from every arm above because those
  // each isolate a different feature; this one isolates the reranker. Skipped rather
  // than run when CORTEX_RERANK is unset, because an arm whose two sides are
  // configured identically measures nothing and would persist a 0.00 pp delta that
  // reads like a negative result.
  if (reranker === undefined) {
    console.log('=== reranking ablation skipped: CORTEX_RERANK is not enabled ===');
  } else {
    try {
      // No judge is passed: like every other arm here, the ablations construct
      // their own from `llm`, and the benchmark entry point holds no judge binding.
      const rerankAblation = await runRerankAblation(sampled as never, embedding, llm, {
        runs: ablationRuns,
        temperature,
        entityIdentityClause,
        reranker,
        ...(rerankCandidatePool !== undefined ? { rerankCandidatePool } : {}),
        ...(rerankProtectedHead !== undefined ? { rerankProtectedHead } : {}),
      });
      writeFileSync('benchmark-rerank-ablation-report.md', rerankAblation.markdown);
      writeFileSync(
        'benchmark-rerank-ablation-report.json',
        JSON.stringify(
          {
            ...rerankAblation.report,
            abstentionShift: rerankAblation.abstentionShift,
            fallbacks: rerankAblation.fallbacks,
          },
          null,
          2,
        ),
      );
      console.log('=== reranking ablation ===');
      // Printed beside the accuracy delta on purpose: reranking changes the ordering
      // and the abstention decision is read from hits[0].score, so a shifted
      // abstention rate means the delta below it is confounded rather than earned.
      console.log(`Abstention shift: ${(rerankAblation.abstentionShift * 100).toFixed(2)} pp`);
      // Also printed beside the delta, and for a sharper reason. When every bucket
      // fails to parse, `LLMReranker` returns an empty array, `rerankHits` answers
      // with the input order, and the two arms become behaviourally identical — a
      // `0.00 pp` delta that reads as "reranking does not help" when the truth is
      // that reranking never ran. Without this line those two outcomes are the same
      // output, so a negative B1 verdict would be unfalsifiable.
      const { fallbacks } = rerankAblation;
      if (fallbacks === null) {
        console.log('Reranker fallbacks: not reported (reranker exposes no counters)');
      } else {
        const rate =
          fallbacks.bucketCount === 0 ? 0 : fallbacks.fallbackCount / fallbacks.bucketCount;
        console.log(
          `Reranker fallbacks: ${fallbacks.fallbackCount}/${fallbacks.bucketCount} buckets` +
            ` (${(rate * 100).toFixed(1)}%)`,
        );
        if (fallbacks.fallbackCount > 0) {
          console.log(
            'WARNING: fallbacks mean the reranker abstained on its own scoring, so the delta above' +
              ' understates the feature rather than measuring it.',
          );
        }
      }
      const mr = rerankAblation.report.ablation.perCapability['MR'];
      const tr = rerankAblation.report.ablation.perCapability['TR'];
      console.log(
        `MR: baseline ${mr.baselineCorrect}/${mr.total} vs feature ${mr.featureCorrect}/${mr.total}` +
          ` (McNemar p=${mr.mcnemarPValue.toExponential(3)})`,
      );
      console.log(
        `TR: baseline ${tr.baselineCorrect}/${tr.total} vs feature ${tr.featureCorrect}/${tr.total}` +
          ` (McNemar p=${tr.mcnemarPValue.toExponential(3)})`,
      );
      console.log(rerankAblation.markdown);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`reranking ablation skipped: ${reason}`);
      ablationSkips.push(buildAblationSkipRecord('rerank', err, sampled.length));
    }
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

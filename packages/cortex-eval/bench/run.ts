/**
 * Benchmark entry point. Reads the LongMemEval JSON from LONGMEMEVAL_PATH, builds
 * a DeepSeek LLM and a Zhipu embedding from environment variables, runs the
 * natural-language QA ablation, and writes Markdown + JSON reports.
 *
 * On failure the script writes `benchmark-error.log` with the full message and
 * stack before exiting non-zero. The workflow uploads this file as an artifact
 * so failures can be diagnosed even when the runner log stream is unavailable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  checkEmbeddingDeterminism,
  computeRetrievalDiagnostics,
  computeSessionRetrievalDiagnostics,
  createEmbeddingFromEnv,
  createLlmFromEnv,
  runMrAggregationAblation,
  runNaturalLanguageBenchmark,
  runTemporalEngineAblation,
  sampleInstances,
  toCapability,
  turnText,
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
  // Default to a single deterministic run: with temperature 0 the systems are
  // deterministic, so repeated runs add cost without variance. Set RUNS>1 only
  // when sampling variance is deliberately introduced via TEMPERATURE>0.
  const runs = Number(process.env['RUNS'] ?? 1);
  // Sampling temperature for both systems (default 0, deterministic). A positive
  // value introduces real sampling variance so the over-run t-test is defined.
  const temperature = Number(process.env['TEMPERATURE'] ?? 0);

  console.log(
    `Running benchmark on ${sampled.length} instance(s) ` +
      `(limit=${limit === 0 ? 'all' : limit}, runs=${runs}, temperature=${temperature}, abstainThreshold=${threshold})...`,
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
  const turnDiagnostics = await computeRetrievalDiagnostics(sampled as never, embedding, 5);
  const sessionDiagnostics = await computeSessionRetrievalDiagnostics(
    sampled as never,
    embedding,
    5,
  );
  const diagnosticsWithDeterminism = {
    ...turnDiagnostics,
    session: sessionDiagnostics,
    embeddingMaxAbsDiff: determinism,
  };
  writeFileSync('benchmark-diagnostics.json', JSON.stringify(diagnosticsWithDeterminism, null, 2));
  console.log('=== Retrieval diagnostics ===');
  console.log(JSON.stringify(diagnosticsWithDeterminism, null, 2));

  // Trace per-question decisions so threshold- and LLM-driven abstentions can be
  // separated instead of being conflated into a single abstention rate. The
  // trace also carries the retrieved evidence and raw LLM output for MR
  // failure analysis.
  const decisions: DecisionTrace[] = [];
  const { report, markdown } = await runNaturalLanguageBenchmark(sampled as never, embedding, llm, {
    abstainThreshold: threshold,
    runs,
    temperature,
    onDecision: (trace) => decisions.push(trace),
  });
  const reasonCounts: Record<string, number> = { empty: 0, threshold: 0, llm: 0, answered: 0 };
  for (const d of decisions) {
    reasonCounts[d.reason] = (reasonCounts[d.reason] ?? 0) + 1;
  }
  console.log('=== Decision reasons (feature system) ===');
  console.log(JSON.stringify(reasonCounts));

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
        answer_session_ids: inst.answer_session_ids ?? [],
        haystack_dates: inst.haystack_dates ?? [],
        answer_sessions_content: answerSessionsContent(inst),
        decision: trace ?? null,
      };
    });
  writeFileSync('benchmark-mr-diagnostics.json', JSON.stringify(mrDiagnostics, null, 2));
  console.log('=== MR diagnostics ===');
  console.log(JSON.stringify(mrDiagnostics, null, 2));

  // Dump per-question diagnostics for the single-session capabilities (IE/KU/TR)
  // so the exact failure mode — retrieval miss vs LLM over-abstention — is
  // visible in the uploaded artifact instead of guessed from aggregate scores.
  const singleSessionDiagnostics = (sampled as LongMemEvalInstance[])
    .filter((inst) => {
      const cap = toCapability(inst.question_id, inst.question_type);
      return cap === 'IE' || cap === 'KU' || cap === 'TR';
    })
    .map((inst) => {
      const trace = [...decisions].reverse().find((d) => d.question === inst.question);
      return {
        question_id: inst.question_id,
        capability: toCapability(inst.question_id, inst.question_type),
        question: inst.question,
        question_date: inst.question_date ?? null,
        ground_truth: inst.answer,
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
    runs,
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
    runs,
    temperature,
  });
  writeFileSync('benchmark-tr-ablation-report.md', trAblation.markdown);
  writeFileSync('benchmark-tr-ablation-report.json', JSON.stringify(trAblation.report, null, 2));
  console.log('=== TR temporal-engine ablation ===');
  console.log(trAblation.markdown);
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
  process.exit(1);
});

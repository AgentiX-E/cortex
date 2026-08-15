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
  createEmbeddingFromEnv,
  createLlmFromEnv,
  runNaturalLanguageBenchmark,
  sampleInstances,
} from '@agentix-e/cortex-eval';

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
  // when sampling variance is deliberately introduced.
  const runs = Number(process.env['RUNS'] ?? 1);

  console.log(
    `Running benchmark on ${sampled.length} instance(s) ` +
      `(limit=${limit === 0 ? 'all' : limit}, runs=${runs}, abstainThreshold=${threshold})...`,
  );

  // Verify the embedding provider is deterministic before trusting retrieval
  // scores; a large drift would confound the threshold comparison.
  const determinism = await checkEmbeddingDeterminism(embedding, [
    'determinism probe alpha',
    'determinism probe beta',
  ]);
  console.log(`Embedding determinism (max abs diff): ${determinism}`);

  // Measure the retrieval signal before grading so the abstention threshold can
  // be set from data instead of guessed.
  const diagnostics = await computeRetrievalDiagnostics(sampled as never, embedding, 5);
  const diagnosticsWithDeterminism = { ...diagnostics, embeddingMaxAbsDiff: determinism };
  writeFileSync('benchmark-diagnostics.json', JSON.stringify(diagnosticsWithDeterminism, null, 2));
  console.log('=== Retrieval diagnostics ===');
  console.log(JSON.stringify(diagnosticsWithDeterminism, null, 2));

  const { report, markdown } = await runNaturalLanguageBenchmark(sampled as never, embedding, llm, {
    abstainThreshold: threshold,
    runs,
  });
  writeFileSync('benchmark-report.md', markdown);
  writeFileSync('benchmark-report.json', JSON.stringify(report, null, 2));
  console.log(markdown);
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

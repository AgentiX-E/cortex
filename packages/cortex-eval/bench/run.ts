/**
 * Benchmark entry point. Reads the LongMemEval JSON from LONGMEMEVAL_PATH, builds
 * a DeepSeek LLM and a Zhipu embedding from environment variables, runs the
 * natural-language QA ablation, and writes Markdown + JSON reports.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createEmbeddingFromEnv,
  createLlmFromEnv,
  runNaturalLanguageBenchmark,
} from '@agentix-e/cortex-eval';

async function main(): Promise<void> {
  const dataPath = process.env['LONGMEMEVAL_PATH'];
  if (!dataPath) {
    console.error('LONGMEMEVAL_PATH is required');
    process.exit(1);
  }
  const instances = JSON.parse(readFileSync(dataPath, 'utf8')) as unknown;
  const embedding = createEmbeddingFromEnv(process.env);
  const llm = createLlmFromEnv(process.env);
  const threshold = Number(process.env['ABSTAIN_THRESHOLD'] ?? 0.5);
  const { report, markdown } = await runNaturalLanguageBenchmark(
    instances as never,
    embedding,
    llm,
    { abstainThreshold: threshold, runs: 3 },
  );
  writeFileSync('benchmark-report.md', markdown);
  writeFileSync('benchmark-report.json', JSON.stringify(report, null, 2));
  console.log(markdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

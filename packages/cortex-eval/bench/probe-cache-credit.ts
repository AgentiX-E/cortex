/**
 * Send the five cache-credit prompts and print what the provider says each one cost.
 *
 *     DEEPSEEK_API_KEY=... node --import tsx bench/probe-cache-credit.ts \
 *       --out "$GITHUB_WORKSPACE/cache-credit.json"
 *
 * ## Why this is a workflow and not a local command
 *
 * The credential is an organisation secret that exists on a runner, and the question is about the
 * provider's own accounting -- a local run through a different endpoint, a different model id or a
 * different account would answer a question about that deployment. `probe-cache-credit.yml` is
 * dispatch-only for the reason every measurement in this repository is: a number nobody asked for is
 * a number nobody reads, and this one costs money.
 *
 * ## Why the calls are sequential
 *
 * `usageDelta` reads one global ledger between two snapshots, and its own docblock records what that
 * arithmetic does under a concurrent pool: run `42054107910` counted 3.43x the calls the run made.
 * Five calls, one at a time, is the only shape in which the delta is exact -- and exactness here is
 * the whole point, because the probe exists to check a counter, not to finish quickly.
 *
 * ## Why it prints the prompts' own expectations
 *
 * A table of five credits is not a reading until it is put beside what each model says the credit
 * should have been. The models live in `src/cache-credit.ts` where they are tested; this file only
 * buys the numbers and hands them over.
 */
import { writeFileSync } from 'node:fs';
import { llmUsage, usageDelta } from '@agentix-e/cortex-ai';
import {
  buildCacheCreditPrompts,
  createLlmFromEnv,
  fitCacheCreditModels,
  renderCacheCreditReport,
  type CacheCreditSample,
} from '@agentix-e/cortex-eval';

/** `--name value`, with the name required to be one this file reads. */
function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const out = arg('out', 'cache-credit.json');
  const prompts = buildCacheCreditPrompts();
  const llm = createLlmFromEnv(process.env);

  const samples: CacheCreditSample[] = [];
  for (const prompt of prompts) {
    const before = llmUsage();
    // One word out, and the temperature a benchmark uses: the probe is about the prompt, so the
    // completion must be the cheapest thing the provider will produce and the same on both dispatches.
    const reply = await llm.complete(prompt.text, { temperature: 0, maxTokens: 8 });
    const delta = usageDelta(before, llmUsage());
    samples.push({
      variant: prompt.variant,
      promptTokens: delta.promptTokens,
      cacheHitPromptTokens: delta.cacheHitPromptTokens,
    });
    console.log(
      `${prompt.variant.padEnd(20)} ${prompt.text.length} chars  ` +
        `${delta.promptTokens} prompt  ${delta.cacheHitPromptTokens} credited  ` +
        `reply=${JSON.stringify(reply.slice(0, 24))}`,
    );
  }

  const fit = fitCacheCreditModels(samples, prompts);
  const reading = {
    kind: 'cache-credit-probe',
    prompts: prompts.map((prompt) => ({ variant: prompt.variant, chars: prompt.text.length })),
    samples,
    position: fit.position,
    content: fit.content,
    verdict: fit.verdict,
    closest: fit.closest,
  };
  writeFileSync(out, `${JSON.stringify(reading, null, 2)}\n`);
  console.log(`\n${renderCacheCreditReport(fit)}\n`);
  console.log(`wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

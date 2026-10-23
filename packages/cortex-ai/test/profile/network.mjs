#!/usr/bin/env node
/**
 * Does a local proposal make any network request? Counted, not asserted in prose.
 *
 * ## Why this script exists
 *
 * "Runs on the device, no API call" is the product's first sentence and, until this file, it was a
 * claim with no check behind it. The entry guard proves that `./local` does not *import* an HTTP
 * client, which is a different statement: `@huggingface/transformers` ships with `fetch` built in
 * because it downloads weights, so the dependency can reach the network and the entry guard is
 * right to pass it.
 *
 * The distinction that actually matters is **which phase**:
 *
 *  * a cold start fetches weights and tokenizer from `CORTEX_HF_ENDPOINT` (or wherever they are
 *    cached) -- this is a one-time setup step, and on a deployment with a baked image it is zero;
 *  * inference, once the weights are on disk, must make **no request at all**. That is what makes
 *    `local` different from `remote` in a way a user can rely on: the sentence they type cannot
 *    leave the machine.
 *
 * So the script spies on `globalThis.fetch` before anything is imported, attributes every call to
 * `load` or `infer`, and reports both. A non-zero `infer` count is a failure of the claim, not a
 * warning.
 *
 * ## Usage
 *
 *     node packages/cortex-ai/test/profile/network.mjs [--model <id>] [--dtype q4]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function valueOf(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const MODEL = valueOf('--model', 'onnx-community/Qwen2.5-0.5B-Instruct');
const DTYPE = valueOf('--dtype', 'q4');

/** The phase the clock is in. Attribution is the whole point: a total would hide the split. */
let phase = 'load';
const calls = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  calls.push({ phase, url, at: Date.now() });
  return realFetch(input, init);
};

const SENTENCE =
  'I moved to Berlin in March and now I work at Acme on the payments team, and I keep my notes on paper.';

async function main() {
  const started = Date.now();
  const { createLocalLLM } = await import('../../dist/local/index.js');
  const { TriageProposer } = await import('../../../cortex-core/dist/index.js');

  const llm = await createLocalLLM({
    model: MODEL,
    dtype: DTYPE,
    env: { remoteHost: process.env['CORTEX_HF_ENDPOINT'] ?? 'https://hf-mirror.com' },
  });
  const loadMs = Date.now() - started;
  const loadCalls = calls.length;

  phase = 'infer';
  const inferStart = Date.now();
  const proposer = new TriageProposer({ llm, model: MODEL, provider: 'local' });
  const result = await proposer.propose(SENTENCE);
  const inferMs = Date.now() - inferStart;
  const inferCalls = calls.length - loadCalls;

  const text = result.ok ? result.proposal.facts.map((fact) => fact.text) : [];
  const summary = {
    model: MODEL,
    dtype: DTYPE,
    sentence: SENTENCE,
    digest: createHash('sha256').update(SENTENCE).digest('hex').slice(0, 16),
    loadMs,
    inferMs,
    loadCalls,
    inferCalls,
    calls,
    ok: result.ok,
    atoms: text,
    ...(result.ok ? {} : { failure: result.failure }),
    verdict: inferCalls === 0 ? 'no request during inference' : `${inferCalls} request(s) during inference`,
  };

  mkdirSync(HERE, { recursive: true });
  writeFileSync(join(HERE, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, calls: undefined, atoms: text.length }, null, 2));
  if (inferCalls !== 0) process.exitCode = 1;
}

await main();

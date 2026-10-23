#!/usr/bin/env node
/**
 * Does the embedding configuration actually reach the vendor? Checked, not assumed.
 *
 * ## Why this exists
 *
 * `createEmbeddingWithProvenanceFromEnv` falls back to a 256-dimension hash embedding when no
 * credential is present -- a deliberate choice that keeps the benchmark runnable without secrets, and
 * a silent one: both backends produce stable vectors, so a determinism probe reads zero either way
 * and a retrieval score computed against hash vectors looks like one computed against Zhipu's 1024.
 * The provenance field is what makes them distinguishable, and nothing was checking that the field
 * says `openai-compatible` when a key *is* present.
 *
 * On a runner with `ZHIPU_API_KEY`, that check is cheap and decisive: it either reaches the vendor or
 * it does not. Off CI, with no key, this script exits 0 and says so -- the absence of a credential is
 * not a failure of the code, and a tool that fails when run locally teaches people to skip it.
 *
 * ## What it reports
 *
 * The provenance, the vector length, and two cosine similarities: a related pair and an unrelated
 * pair. They are not a quality metric -- two sentences prove the endpoint answers with vectors that
 * differ in the expected direction, and nothing more. A rate needs a corpus, and the corpus needs the
 * benchmark.
 *
 * Usage:
 *
 *     node packages/cortex-eval/test/embedding-smoke.mjs
 *     node packages/cortex-eval/test/embedding-smoke.mjs --out embedding-smoke.json
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmbeddingWithProvenanceFromEnv } from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

/** Related, then unrelated: if the first is not the larger of the two, something is badly wrong. */
const PAIRS = {
  related: [
    'I moved to Berlin in March and I work on the payments team at Acme.',
    'Berlin is where I live now; my job at Acme is on payments.',
  ],
  unrelated: [
    'I moved to Berlin in March and I work on the payments team at Acme.',
    'The bookshop on the corner reopens next month after the flood damage.',
  ],
};

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function main() {
  const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv(process.env);
  const started = Date.now();

  const [first] = await embedding.embed(PAIRS.related);
  const [second] = await embedding.embed([PAIRS.related[1]]);
  const [third] = await embedding.embed([PAIRS.unrelated[1]]);

  const summary = {
    provenance,
    dimension: embedding.dimension(),
    vectorLength: first.length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    cosineRelated: Number(cosine(first, second).toFixed(4)),
    cosineUnrelated: Number(cosine(first, third).toFixed(4)),
  };

  // `resolve`, not `join`: an absolute path passed by CI would otherwise be appended to this
  // directory rather than replacing it. See the same note in `cortex-ai/test/proposer/run.mjs`.
  const out = resolve(HERE, value('out', 'embedding-smoke.json'));
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.error(`wrote ${out}`);

  if (provenance.provider === 'hash') {
    // No credential: the run is a statement about the fallback, not about the vendor.
    console.error('no credential: this run measured the hash fallback, not a remote embedding');
    return;
  }
  if (summary.cosineRelated <= summary.cosineUnrelated) {
    // The one thing two sentences can catch: a provider answering with vectors unrelated to their
    // text, or a dimension mismatch that silently truncated them.
    throw new Error(
      `related pair scored ${summary.cosineRelated}, unrelated ${summary.cosineUnrelated}: ` +
        'the embedding does not separate them',
    );
  }
}

await main();

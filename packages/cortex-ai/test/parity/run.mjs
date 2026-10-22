/**
 * Embedding parity across the transformers.js upgrade: does the shipped adapter still produce the
 * vectors the old one did?
 *
 * ## The question, precisely
 *
 * Implementation step 4 moves the local embedding from `@xenova/transformers` 2.17 to
 * `@huggingface/transformers` 4.x. If the upgrade changes the vectors, every embedding already
 * stored by a deployment becomes incomparable to every new one -- and the failure is invisible:
 * both sides are unit-length, both have 384 dimensions, and cosine similarity still returns a
 * number between 0 and 1. The only way to know is to embed the same text twice and compare.
 *
 * ## Why this is a script and not a vitest case
 *
 * It needs the network (model weights), an old library that cannot be installed in the workspace
 * (its `sharp` dependency fetches a native build from a host this network blocks, so the harness
 * installs it in a temporary project with an override), and about a minute of CPU. Putting that in
 * `pnpm check` would make the gate depend on a mirror being up.
 *
 * ## What it measures
 *
 * | arm | library | dtype | why this arm exists |
 * |---|---|---|---|
 * | `product` | 4.x, through this package's adapter | `fp32` (pinned here) | what ships |
 * | `v2-fp32` | 2.17, `quantized: false` | fp32 | the like-for-like comparison |
 * | `v2-default` | 2.17, defaults | quantized | what every existing vector was actually made with |
 *
 * `product` vs `v2-fp32` answers "did the upgrade change the maths". `product` vs `v2-default`
 * answers "do the vectors we already have need re-embedding", and the answer to that one is about
 * the *default*, not about the library -- which is the finding, not a footnote.
 *
 * Usage:
 *   node test/parity/run.mjs                 # uses https://hf-mirror.com
 *   CORTEX_HF_HOST=https://huggingface.co node test/parity/run.mjs
 *   CORTEX_PARITY_THRESHOLD=0.999 node test/parity/run.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
const RESULTS = join(HERE, 'last-run.json');

const MODEL = process.env.CORTEX_PARITY_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
const RERANK_MODEL = process.env.CORTEX_PARITY_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
const HOST = process.env.CORTEX_HF_HOST ?? 'https://hf-mirror.com';
const THRESHOLD = Number(process.env.CORTEX_PARITY_THRESHOLD ?? 0.999);
const WORK = process.env.CORTEX_PARITY_DIR ?? join(tmpdir(), 'cortex-ai-parity');

/** Fifteen texts: short, long, numeric, non-ASCII. Ids are not scored separately. */
const TEXTS = [
  'The user prefers dark mode in every editor.',
  'My sister is allergic to peanuts.',
  'We deployed the service to eu-west-1 on Tuesday.',
  'I run five kilometres every morning before work.',
  'The invoice number is INV-2024-0917.',
  'He said the meeting moved to 3pm.',
  'Our team uses trunk-based development.',
  'Remember to renew the passport in March.',
  'The model checkpoint is stored in /mnt/ckpt.',
  'She speaks Mandarin and some Japanese.',
  'The API key expires in thirty days.',
  'A short one.',
  'A much longer passage that rambles on about retrieval augmented generation, the trade-offs ' +
    'between exact and approximate nearest neighbour search, and why hybrid ranking tends to beat ' +
    'either method alone on heterogeneous corpora.',
  'naïve café — unicode 测试',
  '12345',
];

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

/** Install the old library beside the new one, in a project that is allowed to override `sharp`. */
function installLegacy() {
  const manifest = join(WORK, 'package.json');
  if (!existsSync(manifest)) {
    mkdirSync(WORK, { recursive: true });
    writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          name: 'cortex-ai-parity',
          private: true,
          type: 'module',
          // `@xenova/transformers@2.17` depends on sharp 0.32, whose install script downloads a
          // libvips build from GitHub releases -- a host this network blocks. sharp is only used
          // for image inputs, which this harness never produces, so a newer sharp from the npm
          // registry is substituted. `--ignore-scripts` then keeps onnxruntime-node's own
          // postinstall from reaching for the same blocked host; its native binaries ship inside
          // the tarball, and they load.
          overrides: { sharp: '0.34.4' },
          dependencies: {
            '@huggingface/transformers': '4.3.1',
            '@xenova/transformers': '2.17.2',
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  const installed = join(WORK, 'node_modules', '@xenova', 'transformers');
  if (existsSync(installed)) {
    console.log(`using the packages already installed in ${WORK}`);
    return;
  }

  console.log(
    `installing @xenova/transformers@2.17.2 and @huggingface/transformers@4.3.1 in ${WORK}`,
  );
  const result = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: WORK,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`npm install failed with status ${result.status}`);
  }
}

/** The child that runs inside the temporary project, where both libraries are resolvable. */
function writeLegacyRunner() {
  const file = join(WORK, 'embed.mjs');
  writeFileSync(
    file,
    `const TEXTS = ${JSON.stringify(TEXTS)};
const HOST = ${JSON.stringify(HOST)};
const MODEL = ${JSON.stringify(MODEL)};
const legacy = await import('@xenova/transformers');
legacy.env.remoteHost = HOST;
legacy.env.cacheDir = ${JSON.stringify(join(WORK, 'cache-v2'))};

const rows = (out) => {
  const dim = out.dims[1];
  if (dim === undefined) throw new Error('unexpected output shape: ' + JSON.stringify(out.dims));
  return Array.from({ length: TEXTS.length }, (_, i) =>
    Array.from(out.data.slice(i * dim, (i + 1) * dim)));
};

const opts = { pooling: 'mean', normalize: true };
const asDefault = await legacy.pipeline('feature-extraction', MODEL);
const asFp32 = await legacy.pipeline('feature-extraction', MODEL, { quantized: false });
const payload = {
  default: rows(await asDefault(TEXTS, opts)),
  fp32: rows(await asFp32(TEXTS, opts)),
};
process.stdout.write(JSON.stringify(payload));
`,
  );
  return file;
}

function runLegacy(file) {
  const result = spawnSync(process.execPath, [file], {
    cwd: WORK,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`legacy embedding failed: ${result.stderr.slice(-2000)}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  installLegacy();
  const legacy = runLegacy(writeLegacyRunner());

  // The shipped adapter, from the built package. `dist` is required on purpose: measuring the
  // source through a transform hook would test a different artefact from the one that ships.
  const entry = pathToFileURL(join(PACKAGE, 'dist', 'local', 'index.js')).href;
  const { TransformersEmbedding } = await import(entry);
  const adapter = new TransformersEmbedding({
    model: MODEL,
    dimensions: 384,
    env: { remoteHost: HOST, cacheDir: join(WORK, 'cache-v4') },
  });
  const product = (await adapter.embed(TEXTS)).map((vector) => Array.from(vector));

  const compare = (label, against) => {
    const cosines = product.map((vector, index) => cosine(vector, against[index]));
    const sorted = [...cosines].sort((a, b) => a - b);
    return {
      label,
      min: Number(sorted[0].toFixed(8)),
      median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(8)),
      max: Number(sorted[sorted.length - 1].toFixed(8)),
      belowThreshold: cosines.filter((value) => value < THRESHOLD).length,
      samples: TEXTS.length,
    };
  };

  const arms = [
    compare('product(fp32) vs v2 fp32', legacy.fp32),
    compare('product(fp32) vs v2 default (quantized)', legacy.default),
  ];

  // ---- the rerank path, through the classes a caller actually uses -------------------------------
  //
  // This is here because the embedding comparison cannot see it. `pipeline('text-classification')`
  // softmaxes over the model's single label, so every candidate comes back as exactly 1.0 and every
  // tie is invisible: the reranker reports success while changing nothing. The check is therefore
  // "are the scores distinct, and in the right order", not "does it run".
  const rerankEntry = pathToFileURL(join(PACKAGE, 'dist', 'index.js')).href;
  const localEntry = pathToFileURL(join(PACKAGE, 'dist', 'local', 'index.js')).href;
  const { CrossEncoderReranker } = await import(rerankEntry);
  const { makeRerankPipelineFactory } = await import(localEntry);
  const question = 'what is the capital of France';
  const pairs = [
    { question, text: 'Paris is the capital of France.' },
    { question, text: 'The weather is nice today.' },
    { question, text: 'Berlin is in Germany.' },
  ];
  const pipeline = await makeRerankPipelineFactory({
    model: RERANK_MODEL,
    env: { remoteHost: HOST, cacheDir: join(WORK, 'cache-v4') },
  })();
  const rerankScores = await new CrossEncoderReranker({ pipeline }).score(pairs);
  const distinct = new Set(rerankScores.map((value) => value.toFixed(6))).size;
  const rerank = {
    model: RERANK_MODEL,
    scores: rerankScores,
    distinct,
    // A relevant passage must outrank an unrelated one, and a same-topic distractor must sit
    // between them. Anything else means the scores are noise that happens to vary.
    ordered: rerankScores[0] > rerankScores[2] && rerankScores[2] > rerankScores[1],
    allFinite: rerankScores.every((value) => Number.isFinite(value)),
  };
  rerank.accepted = rerank.distinct === pairs.length && rerank.ordered && rerank.allFinite;

  const report = {
    model: MODEL,
    host: HOST,
    threshold: THRESHOLD,
    samples: TEXTS.length,
    dimensions: product[0]?.length ?? 0,
    arms,
    // The acceptance criterion for implementation step 4, stated as a boolean so a reader does not
    // have to compare two numbers themselves.
    accepted: arms[0].min >= THRESHOLD && rerank.accepted === true,
    rerank,
    note:
      'Both arms compare the shipped adapter against @xenova/transformers 2.17.2 on the same weights ' +
      'and the same 15 texts. The second arm exists because v2 defaulted to quantized weights and v4 ' +
      'defaults to fp32: it is the difference a caller who upgrades without pinning dtype would see. ' +
      'The rerank block is a different claim: distinct, correctly ordered scores from the local ' +
      'cross-encoder, which the text-classification pipeline cannot produce because it softmaxes ' +
      'over a single label.',
  };

  writeFileSync(RESULTS, `${JSON.stringify(report, null, 2)}\n`);

  for (const arm of arms) {
    console.log(
      `${arm.label.padEnd(38)} min ${arm.min}  median ${arm.median}  ` +
        `below ${THRESHOLD}: ${arm.belowThreshold}/${arm.samples}`,
    );
  }
  console.log(
    `rerank ${RERANK_MODEL}: ${rerank.scores.map((value) => value.toFixed(3)).join(', ')} ` +
      `(distinct ${rerank.distinct}/${pairs.length}, ordered ${rerank.ordered})`,
  );
  console.log(`\ndimensions ${report.dimensions}, model ${MODEL}, host ${HOST}`);
  console.log(`accepted (product vs v2 at equal dtype): ${report.accepted} -> ${RESULTS}`);

  if (!report.accepted) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

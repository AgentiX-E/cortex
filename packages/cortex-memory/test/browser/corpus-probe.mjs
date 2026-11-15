/**
 * The corpus, assembled by the product itself, in a real Chromium over real OPFS.
 *
 * ## What this run adds to the two suites beside it
 *
 * `page.html` measures the **tier**: OPFS opens, rows move, a restart keeps them. `bundle-probe.mjs`
 * measures the **deployment**: an esbuild output of the same package still reaches the worker. Neither
 * has ever handed a transcript to `assembleMemory`, so "a customer can run this product in a browser"
 * rested on an import-closure check (`tools/entry-guard.mjs`) plus an engine check, and an import
 * closure is a property of sources while an engine is a property of a tier. The composition is neither.
 *
 * This probe closes that gap with the one assertion that can fail for the right reason: it runs the
 * scenario **twice in two runtimes** -- once here under `node:sqlite`, once in the page under OPFS on
 * sqlite-wasm -- and requires the *prompt bytes* to be equal. A prompt is the whole product's output at
 * the boundary where its cost is counted, so byte equality is a claim about the assembly, the ordering,
 * the retrieval, the renderer and the store at once, and it is checkable without a model.
 *
 * ## Why the scenario is built here and passed in
 *
 * Because the comparison is between two processes, and two copies of a constant are two scenarios. The
 * page receives `now`, the turns, the question and the expected digest inside the `__run` argument, so
 * there is one copy of the facts and a missing field fails on an assertion rather than producing two
 * runs that agree with themselves.
 *
 * ## Why two launches
 *
 * Durability is a claim about a process that is gone. The first launch writes and asks; the browser is
 * then closed -- not the page reloaded -- and the second launch opens a fresh assembly over the same
 * origin and profile, which is the only shape in which "the transcript is still there" means anything.
 * The erasure runs in the second phase so that the turn it removes is one that survived a restart
 * before it was withdrawn.
 *
 * ## Usage
 *
 *   node test/browser/corpus-probe.mjs
 *   CORTEX_CHROME=/path/to/chrome node test/browser/corpus-probe.mjs
 *   CORTEX_RESULTS_CORPUS=/tmp/fresh-corpus-run.json node test/browser/corpus-probe.mjs
 */
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The browser harness is one copy: a second copy of the launcher is how two suites end up disagreeing
// about the origin, and an origin disagreement hands OPFS a different storage area that looks exactly
// like a persistence bug. It lives in the package that owns the browser tier.
import { findChrome, launch, waitReady } from '../../../cortex-storage/test/browser/cdp.mjs';
import { serveDist } from '../../../cortex-storage/test/browser/server.mjs';

// The control arm lives in `src/__tests__` rather than beside this file, and the module's docblock says
// why: it is a reference to `cortex-storage/sqlite` from a path the caller census reads as a product
// package, which would reclassify the adapter as product-called. One import site, one classification.
import { SCENARIO, nodeBaseline } from '../../src/__tests__/browser-baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
// A third variable beside the other two suites' overrides: a shared one would have three readings
// overwrite each other and the CI comparison would report one suite's checks against another's.
const RESULTS = process.env.CORTEX_RESULTS_CORPUS ?? join(HERE, 'corpus-run.json');

/**
 * The consumer's entry, bundled by esbuild exactly as a consumer's build would.
 *
 * `resolveDir` points at this package so the bare specifiers resolve the way they do for an installer:
 * `@agentix-e/cortex-memory` for the product, `@agentix-e/cortex-storage/opfs` for the browser tier, and
 * the worker as a second entry because esbuild does not emit worker assets (the measurement is in
 * `bundle-probe.mjs`, and the recipe it produced is the one used here).
 */
const CONSUMER_ENTRY = [
  "export { assembleMemory } from '@agentix-e/cortex-memory';",
  "export { openOpfsStorage } from '@agentix-e/cortex-storage/opfs';",
  "export { ERASURE_TOKEN } from '@agentix-e/cortex-core';",
  '',
].join('\n');

const WORKER_ENTRY = "import '@agentix-e/cortex-storage/opfs/worker';\n";

async function buildEntries(outdir) {
  const shared = {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    sourcemap: false,
    splitting: false,
    metafile: true,
    logLevel: 'silent',
  };
  const consumer = await build({
    ...shared,
    stdin: { contents: CONSUMER_ENTRY, resolveDir: PACKAGE, loader: 'js' },
    outfile: join(outdir, 'main.js'),
  });
  const worker = await build({
    ...shared,
    stdin: { contents: WORKER_ENTRY, resolveDir: PACKAGE, loader: 'js' },
    outfile: join(outdir, 'worker.js'),
  });
  const bytesOf = (result) => Object.values(result.metafile.outputs)[0].bytes;
  return {
    mainInputs: Object.keys(consumer.metafile.inputs).length,
    workerInputs: Object.keys(worker.metafile.inputs).length,
    mainBytes: bytesOf(consumer),
    workerBytes: bytesOf(worker),
  };
}

async function main() {
  const chrome = findChrome();
  if (chrome === undefined) {
    // Not a silent skip: without a browser this suite has measured nothing, and saying so is the only
    // honest outcome. The exit status is what a CI job reads.
    console.error('no Chromium found: set CORTEX_CHROME to one, or install playwright browsers');
    process.exitCode = 2;
    return;
  }

  const baseline = await nodeBaseline(SCENARIO);
  /**
   * A fault arm for the comparison itself.
   *
   * The equality between two runtimes is the claim of the round, and a check that cannot fail is not a
   * check: with this set, the digest this page is asked to reproduce is off by one, so the two digest
   * checks -- before and after the restart -- must both go red while the other nine stay green. That
   * separates "the runtimes agree" from "the harness compares a number with itself".
   */
  if (process.env.CORTEX_CORPUS_PROBE_FAULT === 'stale-baseline') baseline.promptDigest += 1;
  const scenario = { ...SCENARIO, baseline };

  const outdir = mkdtempSync(join(tmpdir(), 'cortex-corpus-bundle-'));
  const built = await buildEntries(outdir);
  // The page is served from its own directory and the generated bundles from a temporary one, so nothing
  // this run produces lands in the repository except the reading it writes deliberately.
  const { server, origin } = await serveDist(0, [
    { prefix: '/bundle/', dir: outdir },
    { prefix: '/corpus/', dir: HERE },
  ]);
  const profile = mkdtempSync(join(tmpdir(), 'cortex-corpus-profile-'));
  const debugPort = 9300 + Math.floor(Math.random() * 400);

  /** Launch on the shared profile, navigate to the suite, wait for its modules. */
  const open = async () => {
    const launched = await launch({ chrome, profile, port: debugPort });
    try {
      await launched.connection.send('Page.navigate', { url: `${origin}/corpus/corpus-page.html` });
      await waitReady(launched.connection);
    } catch (error) {
      await launched.close();
      throw error;
    }
    return {
      evaluate: (expression) => launched.connection.evaluate(expression),
      close: () => launched.close(),
    };
  };

  const phases = {};
  try {
    const first = await open();
    try {
      phases.write = await first.evaluate(`__run(${JSON.stringify({ mode: 'write', scenario })})`);
    } finally {
      await first.close();
    }

    const second = await open();
    try {
      phases.read = await second.evaluate(
        `__run(${JSON.stringify({
          mode: 'read',
          scenario,
          written: {
            corpusSize: phases.write.facts?.census?.corpusSize,
            sessionOrder: phases.write.facts?.census?.sessionOrder,
            promptDigest: phases.write.facts?.census?.promptDigest,
          },
        })})`,
      );
    } finally {
      await second.close();
    }
  } finally {
    server.close();
    rmSync(outdir, { recursive: true, force: true });
    // Best effort, and explicitly so: a temporary directory that outlives the run is harmless, while a
    // cleanup error here would replace the suite's actual result with a filesystem error from `/tmp`.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.error(
        `note: could not remove the temporary profile ${profile}: ${error.code ?? error}`,
      );
    }
  }

  // Hoisted to the shape `tools/browser-reading-check.mjs` reads, because the tier is a criterion for
  // this reading for the same reason it is one for the restart reading: a run that fell back to
  // IndexedDB would still print eleven passes, all about a different engine than the file claims.
  phases.write.tier = phases.write.facts?.tier;

  const checks = [...(phases.write.checks ?? []), ...(phases.read.checks ?? [])];
  const failures = checks.filter((check) => !check.ok);
  const report = {
    chrome,
    origin,
    built,
    baseline,
    scenario: {
      now: SCENARIO.now,
      question: SCENARIO.question,
      turns: SCENARIO.turns,
    },
    phases,
    checks,
    failures,
    summary: {
      checks: checks.length,
      passed: checks.length - failures.length,
      failed: failures.length,
      // The claim of the round, as one boolean, in the field name the reading check already compares.
      // Both readings assert "the digest read back equals the digest written"; what differs is which
      // digest, so the claim is spelled out beside the number rather than left to the field's name.
      digestMatches:
        phases.write.facts?.census?.promptDigest === baseline.promptDigest &&
        phases.read.facts?.afterAsk?.promptDigest === baseline.promptDigest,
      digestClaim:
        'the prompt digest a browser reproduces equals the one node:sqlite produced for the same ' +
        'transcript, before and after a restart',
      survivesRestart:
        phases.read.facts?.beforeAsk?.corpusSize === phases.write.facts?.census?.corpusSize,
    },
    note:
      'One run, two Chromium launches on one profile and one origin. `node:sqlite` is the same process; ' +
      'OPFS is sqlite-wasm in a worker. The equality asserted is between the prompt bytes those two ' +
      'produce for one transcript, which is why it can fail without a model.',
  };

  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(report, null, 2)}\n`);

  for (const check of checks) {
    console.log(
      `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` -- ${check.detail}` : ''}`,
    );
  }
  const write = phases.write.facts ?? {};
  const read = phases.read.facts ?? {};
  console.log(
    `\n${report.summary.passed}/${report.summary.checks} checks passed -> ${RESULTS}\n` +
      `prompt ${baseline.promptChars} chars, digest ${baseline.promptDigest}: ` +
      `node:sqlite ${baseline.promptDigest}, opfs before restart ` +
      `${write.census?.promptDigest}, after ${read.afterAsk?.promptDigest}\n` +
      `transcript ${baseline.corpusSize} turns: append ${(write.appendMs ?? 0).toFixed(1)} ms, ` +
      `ask ${(write.askMs ?? 0).toFixed(1)} ms; after erasure ${read.sizeAfter} turns ` +
      `(${read.removed?.turns} turn(s) removed)`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

await main();

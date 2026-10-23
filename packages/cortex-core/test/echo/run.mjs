#!/usr/bin/env node
/**
 * The echo check, priced before and after.
 *
 * ## What this measures, and what it deliberately does not
 *
 * It measures the **corpus primitives** -- build a corpus of N private rows, then query it with the
 * windows of one draft -- for two implementations: the one this repository shipped before the Bloom
 * filter (`Set<string>` of 32-character slices) and the one it ships now (`EchoCorpus`). The old
 * implementation is reproduced **here**, in the script, because the package no longer contains it;
 * that copy is the whole of the "before" column and it is deliberately naive, exactly as the shipped
 * code was.
 *
 * It also runs the shipped `OutputGuard.scan` at each size, because that is the number a user feels.
 *
 * It does not measure a real user's corpus. The rows are synthetic, from a thirty-word vocabulary,
 * which makes 32-character windows repeat far more than they do in prose. That inflates the Bloom
 * filter's false-positive count and therefore its verification cost, so the query numbers here are
 * pessimistic; the build numbers, which dominate, are not affected by the vocabulary at all.
 *
 * Usage: `node test/echo/run.mjs [--json]`, from `packages/cortex-core`, after `pnpm build`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EchoCorpus, OutputGuard, rollingHashes } from '../../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDTH = 32;
const SIZES = [100, 1_000, 5_000, 10_000];
const RUNS = 5;

let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const WORDS =
  'the a plan team project client roadmap sprint budget meeting note review design record device memory store window answer draft card queue private shared policy sentence word'.split(
    ' ',
  );
const sentence = (n) =>
  Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ text: `${sentence(28)} ${i}` }));

const DRAFT = 'Here is what I remember: I moved to Berlin in March and now I work at Acme.';

/** What the repository shipped before this change: one string per window, per scan. */
function legacyCorpus(values) {
  const set = new Set();
  for (const value of values) {
    const text = typeof value?.text === 'string' ? value.text : undefined;
    if (text === undefined) continue;
    const normal = text.replace(/\s+/g, ' ').trim().toLowerCase();
    for (let i = 0; i + WIDTH <= normal.length; i += 1) set.add(normal.slice(i, i + WIDTH));
  }
  return set;
}

function legacyQuery(set, windows) {
  let hits = 0;
  for (const window of windows) if (set.has(window)) hits += 1;
  return hits;
}

function windowsOf(draft) {
  const normal = draft.replace(/\s+/g, ' ').trim().toLowerCase();
  const out = [];
  for (let i = 0; i + WIDTH <= normal.length; i += 1) out.push(normal.slice(i, i + WIDTH));
  return out;
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    p50: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    p95: Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(2)),
  };
}

const windows = windowsOf(DRAFT);
const guard = new OutputGuard();
const table = [];

for (const size of SIZES) {
  const rows = makeRows(size);
  const chars = rows.reduce((sum, row) => sum + row.text.length, 0);

  const legacyBuild = [];
  const legacyFind = [];
  const bloomBuild = [];
  const bloomFind = [];
  const scan = [];

  for (let run = 0; run < RUNS; run += 1) {
    let started = performance.now();
    const set = legacyCorpus(rows);
    legacyBuild.push(performance.now() - started);
    started = performance.now();
    legacyQuery(set, windows);
    legacyFind.push(performance.now() - started);

    started = performance.now();
    const corpus = EchoCorpus.from(rows, { width: WIDTH });
    bloomBuild.push(performance.now() - started);
    started = performance.now();
    for (const window of windows) corpus.contains(window);
    bloomFind.push(performance.now() - started);

    started = performance.now();
    guard.scan(DRAFT, { task: 'shared', privateValues: rows, window: [] });
    scan.push(performance.now() - started);
  }

  const corpus = EchoCorpus.from(rows, { width: WIDTH });
  table.push({
    rows: size,
    chars,
    grams: corpus.stats.grams,
    legacyBuildMs: stats(legacyBuild),
    legacyQueryMs: stats(legacyFind),
    bloomBuildMs: stats(bloomBuild),
    bloomQueryMs: stats(bloomFind),
    guardScanMs: stats(scan),
    bloomBytes: Math.round((corpus.stats.bits / 8) * 1) /* bits/8 */,
    speedup: Number((stats(legacyBuild).p50 / stats(bloomBuild).p50).toFixed(1)),
  });
}

const json = { width: WIDTH, runs: RUNS, windows: windows.length, table };
writeFileSync(join(HERE, 'result.json'), `${JSON.stringify(json, null, 2)}\n`);

for (const row of table) {
  console.log(
    `rows=${String(row.rows).padEnd(6)} windows=${String(row.grams).padEnd(8)}` +
      ` before build ${String(row.legacyBuildMs.p50).padStart(7)}ms p95 ${String(row.legacyBuildMs.p95).padStart(7)}ms` +
      ` | after build ${String(row.bloomBuildMs.p50).padStart(6)}ms p95 ${String(row.bloomBuildMs.p95).padStart(6)}ms` +
      ` (${row.speedup}x)` +
      ` | query after ${row.bloomQueryMs.p50}ms | filter ${(row.bloomBytes / 1048576).toFixed(1)}MB` +
      ` | guard.scan ${row.guardScanMs.p50}ms`,
  );
}

// The reading that matters more than any of the timings: the findings are unchanged.
const rows = makeRows(5_000);
const set = legacyCorpus(rows);
const copied = rows[3].text;
const legacyHits = windowsOf(copied).filter((window) => set.has(window)).length;
const corpus = EchoCorpus.from(rows, { width: WIDTH });
const bloomHits = windowsOf(copied).filter((window) => corpus.contains(window)).length;
console.log(`\na 5,000-row corpus, one copied row: ${legacyHits} matching windows before, ${bloomHits} after`);
console.log(`rolling hashes over that row: ${rollingHashes(copied.toLowerCase(), WIDTH).length}`);

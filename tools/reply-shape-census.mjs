#!/usr/bin/env node
/**
 * How many replies broke the contract, and how many of those were wrong.
 *
 * ## Why a treatment needs this and not only a test
 *
 * §13.334 registers a pass that re-asks a reply which broke the contract it was rendered with, and the
 * registration is only as honest as its population. `MEASURE-ORACLE-CEILING.md` §7.4 hand-classified
 * **fourteen** of the 35 questions the reader loses; this tool measures the same claim over an artifact's own
 * `rawOutput` field, through the product's own classifier rather than a copy of it.
 *
 * The second column is what makes the population a *decision*: a kind whose targets are already correct cannot
 * gain, and re-asking them can only lose. That measurement is the reason the `shape` kind is registered and
 * refused -- 42 to 47 targets of which only 7 to 13 are wrong -- and the reason `commitment` is dispatched: 3 to
 * 5 targets, every one of them wrong, in all three archived artifacts.
 *
 * ## Why `correct` is read from the record and not recomputed
 *
 * The record's own `correct` is the judge's verdict on the answer the run produced, which is the same verdict the
 * report's accuracy is built from. Recomputing it here would make this tool a second scorer and the two could
 * disagree -- the defect `tools/efficiency-frontier.mjs` states for every instrument in this directory.
 *
 * Usage: `node tools/reply-shape-census.mjs <report.json> [...more]`
 */

import { readFileSync } from 'node:fs';
import { classifyReply, planReplyRepair } from '../packages/cortex-memory/dist/reply-repair.js';

/** The four states, in the order the table prints them. */
const KINDS = ['committed', 'bare-decline', 'prose-decline', 'shape-failed'];

/** The repairs each mode would administer, so a run's own configuration can be looked up. */
const MODES = ['off', 'commitment', 'shape', 'both'];

function pad(value, width) {
  return String(value).padStart(width);
}

function censusOf(report) {
  const records = Array.isArray(report.questions) ? report.questions : [];
  const rows = new Map(KINDS.map((kind) => [kind, { total: 0, wrong: 0, byCapability: new Map() }]));
  const planned = new Map(MODES.map((mode) => [mode, []]));

  for (const record of records) {
    const raw = record.rawOutput ?? null;
    const kind = classifyReply(raw);
    const row = rows.get(kind);
    row.total += 1;
    if (record.correct !== true) row.wrong += 1;
    const capability = record.capability ?? '?';
    const seen = row.byCapability.get(capability) ?? 0;
    row.byCapability.set(capability, seen + 1);
    for (const mode of MODES) {
      const plan = planReplyRepair(raw, mode);
      if (plan.kind !== 'none') planned.get(mode).push({ kind: plan.kind, correct: record.correct === true });
    }
  }
  return { records, rows, planned };
}

function main(argv) {
  const paths = argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: node tools/reply-shape-census.mjs <report.json> [...more]');
    return 2;
  }
  for (const path of paths) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const { records, rows, planned } = censusOf(report);
    const config = report.memoryArmConfig ?? {};
    console.log(`\n${path}`);
    console.log(
      `  records ${records.length}  ask=${config.ask ?? '?'}  evidenceSource=${config.evidenceSource ?? '?'}` +
        `  relevanceTopK=${config.relevanceTopK ?? '?'}  replyRepair=${config.replyRepair ?? 'off'}`,
    );
    console.log('  kind            replies   wrong   wrong%   where');
    for (const kind of KINDS) {
      const row = rows.get(kind);
      const share = row.total === 0 ? 'n/a' : `${((100 * row.wrong) / row.total).toFixed(1)}%`;
      const where =
        row.byCapability.size === 0
          ? '-'
          : [...row.byCapability.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([capability, count]) => `${capability} ${count}`)
              .join(', ');
      console.log(
        `  ${kind.padEnd(14)} ${pad(row.total, 7)} ${pad(row.wrong, 7)}   ${pad(share, 7)}   ${where}`,
      );
    }
    // The decision line: a mode is worth dispatching only when its targets are wrong almost always, because a
    // re-ask of a correct answer can only lose. `n/a` prints for a mode that plans nothing.
    console.log('  mode          planned   wrong   worth dispatching');
    for (const mode of MODES) {
      const targets = planned.get(mode);
      if (targets.length === 0) {
        console.log(`  ${mode.padEnd(12)} ${pad(0, 7)}   ${pad(0, 5)}   no`);
        continue;
      }
      const wrong = targets.filter((target) => !target.correct).length;
      const worth = wrong === targets.length ? 'yes' : 'measured, refused';
      console.log(`  ${mode.padEnd(12)} ${pad(targets.length, 7)}   ${pad(wrong, 5)}   ${worth}`);
    }
  }
  return 0;
}

process.exitCode = main(process.argv);

#!/usr/bin/env node
/**
 * Compare the `promptDigest` of two runs, question by question, before anyone reads their accuracy.
 *
 * ## What this exists for
 *
 * `M1` is the reader axis (`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.303): the two arms differ in one field,
 * `model`, and the claim is about the reader — so the packet must be identical. Every per-question record carries
 * `promptDigest`, and `R0` registers that **500 of 500 digests must match** before the accuracy comparison is
 * allowed to mean anything. A mismatch means an arm moved something it did not declare, and the difference
 * between the two arms is then a difference between two packets, which is not a weaker version of this
 * measurement — it is a different one that nobody registered.
 *
 * ## Why it is a tool and not a paragraph of shell
 *
 * Two reasons, and the second is the one that cost a session.
 *
 * **It is a gate, so it has to be runnable by someone who is not convinced.** A comparison written inline is a
 * comparison nobody re-runs, and `§13.302`'s rule — check the cheap thing before the expensive one — only works if
 * the cheap thing is one command.
 *
 * **The artifacts are 25 MB each and the development sandbox moves them at ~4 KB/s.** A pair of 25 MB zips is
 * therefore two hours of transfer to read 12 KB of digests. This tool reads reports, so the comparison can run
 * *on a runner*, where both artifacts are a `download-artifact` step away, and what comes back is a few hundred
 * bytes. The instrument was the bottleneck, not the measurement.
 *
 * ## What it deliberately does not decide
 *
 * It does not say which arm is better and it does not read accuracy at all. It reports identical, differing,
 * missing and unmeasured counts and exits non-zero unless every question on both sides carries a digest and the
 * two agree. A tool that also summarised the answer would be run *after* someone had already looked, which
 * inverts the order `R0` registers.
 *
 * ## Usage
 *
 *     node tools/prompt-digest-pair.mjs --a report-a.json --b report-b.json [--json]
 *
 * Exit codes: `0` every question matched on both sides, `1` R0 fails, `2` usage or unreadable input.
 */

import { readFileSync } from 'node:fs';

const USAGE =
  'usage: node tools/prompt-digest-pair.mjs --a <report.json> --b <report.json> [--json]';

/** The per-question roster, under either key a report uses. */
function roster(report) {
  for (const key of ['questions', 'records']) {
    const value = report[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return null;
}

/** Question id → digest, plus the ids whose record carries no digest at all. */
function index(records) {
  const digests = new Map();
  const unmeasured = [];
  const duplicated = [];
  for (const record of records) {
    const id = record?.questionId;
    if (typeof id !== 'string' || id === '') {
      unmeasured.push(String(id));
      continue;
    }
    if (digests.has(id)) {
      duplicated.push(id);
      continue;
    }
    const digest = record?.promptDigest;
    if (typeof digest !== 'string' || digest === '') unmeasured.push(id);
    else digests.set(id, digest);
  }
  return { digests, unmeasured, duplicated };
}

/**
 * The reader each side declared, so the pair describes itself.
 *
 * Read rather than required: a report from before the field existed has none, and refusing to compare two packets
 * because neither says who read them would be a stricter rule than the registration.
 */
function reader(report) {
  const config = report?.memoryArmConfig ?? {};
  return typeof config.reader === 'string' && config.reader !== '' ? config.reader : null;
}

function capabilities(records) {
  const byId = new Map();
  for (const record of records) {
    if (typeof record?.questionId === 'string')
      byId.set(record.questionId, String(record.capability ?? 'unknown'));
  }
  return byId;
}

function compare(aReport, bReport) {
  const aRoster = roster(aReport);
  const bRoster = roster(bReport);
  if (aRoster === null || bRoster === null) {
    throw new Error(
      'one side has no per-question roster (a reduced report drops it), so no question can be compared',
    );
  }
  const a = index(aRoster);
  const b = index(bRoster);
  const aCaps = capabilities(aRoster);

  const onlyInA = [...a.digests.keys()].filter((id) => !b.digests.has(id));
  const onlyInB = [...b.digests.keys()].filter((id) => !a.digests.has(id));
  const differing = [];
  for (const [id, digest] of a.digests) {
    const other = b.digests.get(id);
    if (other !== undefined && other !== digest) {
      differing.push({ questionId: id, capability: aCaps.get(id) ?? 'unknown' });
    }
  }
  const differingByCapability = {};
  for (const { capability } of differing) {
    differingByCapability[capability] = (differingByCapability[capability] ?? 0) + 1;
  }

  const compared = a.digests.size - onlyInA.length - differing.length;
  return {
    a: {
      roster: aRoster.length,
      measured: a.digests.size,
      unmeasured: a.unmeasured,
      duplicated: a.duplicated,
      reader: reader(aReport),
    },
    b: {
      roster: bRoster.length,
      measured: b.digests.size,
      unmeasured: b.unmeasured,
      duplicated: b.duplicated,
      reader: reader(bReport),
    },
    compared,
    identical: compared,
    differing: differing.length,
    differingByCapability,
    onlyInA: onlyInA.length,
    onlyInB: onlyInB.length,
    // `R0` is "500 of 500", so anything short of every question matching on both sides fails it -- including a
    // record that carries no digest, because an absent digest is not an identical one.
    holds:
      differing.length === 0 &&
      onlyInA.length === 0 &&
      onlyInB.length === 0 &&
      a.unmeasured.length === 0 &&
      b.unmeasured.length === 0 &&
      a.duplicated.length === 0 &&
      b.duplicated.length === 0 &&
      a.digests.size > 0,
  };
}

function render(result) {
  const lines = [];
  lines.push('## Prompt digest pair (R0 of the reader axis)');
  lines.push('');
  lines.push('| | side A | side B |');
  lines.push('| --- | --- | --- |');
  lines.push(`| roster | ${result.a.roster} | ${result.b.roster} |`);
  lines.push(`| with a digest | ${result.a.measured} | ${result.b.measured} |`);
  lines.push(
    `| without a digest | ${result.a.unmeasured.length} | ${result.b.unmeasured.length} |`,
  );
  lines.push(`| duplicated id | ${result.a.duplicated.length} | ${result.b.duplicated.length} |`);
  lines.push(
    `| reader | ${result.a.reader ?? '(unrecorded)'} | ${result.b.reader ?? '(unrecorded)'} |`,
  );
  lines.push('');
  lines.push(`- compared on both sides: **${result.compared}**`);
  lines.push(`- identical: **${result.identical}**`);
  lines.push(`- differing: **${result.differing}**`);
  lines.push(`- only in A: ${result.onlyInA}, only in B: ${result.onlyInB}`);
  const caps = Object.entries(result.differingByCapability).sort(([x], [y]) => x.localeCompare(y));
  if (caps.length > 0) {
    lines.push(
      `- differing by capability: ${caps.map(([name, count]) => `${name} ${count}`).join(', ')}`,
    );
  }
  lines.push('');
  lines.push(
    result.holds
      ? '**R0 holds.** Every question on both sides carries a digest and the two agree, so the accuracy ' +
          'comparison is between two readers on one packet.'
      : '**R0 FAILS.** The two runs did not send the same bytes, so their accuracies are not a comparison ' +
          'between readers. Read the differing and missing counts above before anything else.',
  );
  return lines.join('\n');
}

function main(argv) {
  let a = null;
  let b = null;
  let asJson = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--a') a = argv[(index += 1)];
    else if (flag === '--b') b = argv[(index += 1)];
    else if (flag === '--json') asJson = true;
    else if (flag === '--help' || flag === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`unrecognised argument ${flag}\n${USAGE}\n`);
      return 2;
    }
  }
  if (a === null || b === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = compare(JSON.parse(readFileSync(a, 'utf8')), JSON.parse(readFileSync(b, 'utf8')));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stdout.write(`${asJson ? JSON.stringify(result, null, 2) : render(result)}\n`);
  return result.holds ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}

export { compare, index, render, roster };

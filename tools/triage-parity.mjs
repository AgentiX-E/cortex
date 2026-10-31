#!/usr/bin/env node
/**
 * The shipped rule table, held against the frozen snapshot and against the second implementation.
 *
 *     node tools/triage-parity.mjs [--write] [--mirror <path>] [--json]
 *
 * ## The failure this exists for
 *
 * The numbers in `docs/04` for the disclosure layer (false-share 0/12, coverage 31.7% on 60 rows,
 * 29.2% on 1,467 persona facts, leak 1/3,000 on an identifier corpus) were not computed by this
 * package. They were computed by `cortex-docs/poc/p04-triage-rules/rules.mjs`, a second
 * implementation of the same table written for the probes, because a probe has to run without a
 * build step.
 *
 * That is a reasonable reason to have two tables and no reason to leave them unwatched. Checked on
 * the day this tool was written, they had drifted in **eight** places, and every one of them was
 * material:
 *
 * | field              | what the probe table said                    | what ships                                    |
 * | ------------------ | -------------------------------------------- | --------------------------------------------- |
 * | `credential`       | no `retention` field                         | `retention: 'never'` — not stored anywhere     |
 * | `strong-pii`       | no IBAN clause, policy without "account"     | `iban`, the IBAN shape, "account" in the policy |
 * | `money`            | no named-loan clause                         | `home/auto/personal/… loan` is debt           |
 * | `health`           | `\bALT\b`, `\bAST\b`, `\bBMI\b`              | `alt`/`ast`/`bmi` behind a value guard         |
 * | `third-party`      | `doctor` in the role list                    | no `doctor`                                    |
 * | policy prose       | "appointments", no "account"                 | "measurements", "account"                      |
 *
 * The direction of the drift is the point. The probe table's `\bALT\b` was *narrower* than the
 * shipped `alt`, so the probe could not see that the shipped table called "the alt attribute on the
 * logo" a health fact; and the probe's missing `retention` meant every number it produced described
 * a layer that stored credentials privately. Neither is a number that is wrong by a little. Both are
 * numbers about a different program.
 *
 * ## Three comparisons, one file
 *
 * 1. **Shipped vs snapshot** — `tools/triage-table.json`, committed. Catches a rule change that was
 *    not accompanied by a decision about the published numbers. Runs everywhere, including CI,
 *    because it needs no second checkout.
 * 2. **Mirror vs snapshot** — when the sibling repository is present. Catches the drift above at the
 *    moment it appears rather than the day someone re-runs a probe.
 * 3. **Snapshot vs shipped == 0 and mirror absent** is reported as **not checked**, never as a pass:
 *    a green run that silently skipped half its assertions is the defect this repository keeps
 *    finding in other people's gates.
 *
 * `--write` updates the snapshot. It is deliberately manual: the snapshot is the sentence "these
 * are the rules the published numbers describe", and re-measuring is a decision, not a side effect.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SHIPPED = path.join(REPO, 'packages', 'cortex-core', 'dist', 'triage', 'rules.js');
const SNAPSHOT = path.join(HERE, 'triage-table.json');
const DEFAULT_MIRROR = path.resolve(
  REPO,
  '..',
  'cortex-docs',
  'poc',
  'p04-triage-rules',
  'rules.mjs',
);

/** Fields that change what the layer does, or what it says it does. Order is one of them. */
const FIELDS = ['id', 'scope', 'policy', 'source', 'flags', 'retention'];

function normalise(table) {
  return table.map((rule) => ({
    id: rule.id,
    scope: rule.scope,
    policy: rule.policy,
    source: rule.pattern.source,
    flags: rule.pattern.flags,
    retention: rule.retention ?? null,
  }));
}

function compare(label, left, right, problems) {
  if (left.length !== right.length) {
    problems.push(`${label}: ${left.length} rules on the left, ${right.length} on the right`);
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      problems.push(`${label}: rule ${index + 1} exists only on the ${a ? 'left' : 'right'}`);
      continue;
    }
    if (a.id !== b.id) {
      problems.push(
        `${label}: rule ${index + 1} is ${JSON.stringify(a.id)} vs ${JSON.stringify(b.id)}`,
      );
      continue;
    }
    for (const field of FIELDS) {
      if (a[field] !== b[field]) {
        problems.push(
          `${label}: ${a.id}.${field}\n    left : ${JSON.stringify(a[field])}\n    right: ${JSON.stringify(b[field])}`,
        );
      }
    }
  }
}

async function loadTable(file) {
  const module = await import(pathToFileURL(file).href);
  const table = module.RULE_TABLE;
  if (!Array.isArray(table)) throw new Error(`${file} does not export RULE_TABLE`);
  return normalise(table);
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const json = argv.includes('--json');
  const mirrorIndex = argv.indexOf('--mirror');
  const mirrorPath = mirrorIndex === -1 ? DEFAULT_MIRROR : argv[mirrorIndex + 1];
  // Overridable so the tests can mutate a copy. Pointing the check at a different file is also how
  // a reviewer answers "what would this have said before the change".
  const snapshotIndex = argv.indexOf('--snapshot');
  const snapshotPath = snapshotIndex === -1 ? SNAPSHOT : argv[snapshotIndex + 1];

  const shipped = await loadTable(SHIPPED);

  if (write) {
    const payload = {
      about:
        'The disclosure rule table as shipped, frozen. The POC numbers quoted in docs/04 were ' +
        'computed from this table; changing it invalidates them until they are re-measured.',
      generatedFrom: 'packages/cortex-core/dist/triage/rules.js',
      rules: shipped,
    };
    writeFileSync(SNAPSHOT, `${JSON.stringify(payload, null, 2)}\n`);
    if (!json) console.log(`wrote ${path.relative(REPO, SNAPSHOT)} (${shipped.length} rules)`);
    return 0;
  }

  const problems = [];
  const checked = [];

  if (!existsSync(snapshotPath)) {
    problems.push(
      `${path.relative(REPO, snapshotPath)} is missing; run --write and review the diff`,
    );
  } else {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')).rules;
    compare('shipped vs snapshot', shipped, snapshot, problems);
    checked.push('shipped vs snapshot');
  }

  const mirrorPresent = existsSync(mirrorPath);
  if (mirrorPresent) {
    const mirror = await loadTable(mirrorPath);
    compare('mirror vs shipped', shipped, mirror, problems);
    checked.push('mirror vs shipped');
  }

  const report = {
    ok: problems.length === 0,
    checked,
    skipped: mirrorPresent ? [] : [`mirror at ${path.relative(REPO, mirrorPath)} was not present`],
    problems,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`rules compared: ${shipped.length}`);
    for (const line of checked) console.log(`  checked  ${line}`);
    for (const line of report.skipped) console.log(`  SKIPPED  ${line}`);
    for (const line of problems) console.log(`  FAILED   ${line}`);
    if (problems.length > 0) console.log(`\n${problems.length} difference(s)`);
    else if (report.skipped.length > 0)
      console.log('\nthe checks that ran agree; see SKIPPED above');
    else console.log('\ntables agree');
  }

  return problems.length === 0 ? 0 : 1;
}

process.exitCode = await main();

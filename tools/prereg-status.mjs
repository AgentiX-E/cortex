#!/usr/bin/env node
/**
 * Whether a pre-registration still is one.
 *
 *     node tools/prereg-status.mjs [--check|--self-test] [--json]
 *
 * ## The failure this prevents, which has now happened three times
 *
 * `MEASURE-PAIRED-FLIP.md` §6 and `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.187.5 both record the same
 * mistake: a plan closed by naming `PREREG-MR-SESSION-CHANNEL` as the next experiment, in the same
 * repository where that file already had a `§6. Result` reading — run `40498191604`, MR 83/121 against the
 * control's 84. A registration with a result is not a registration, and the arithmetic was right about the
 * wrong thing.
 *
 * The third instance is the round this tool was written in. An offline census read a negative result
 * (`MEASURE-MR-UNITS.md`, −28 questions) as a verdict on session units, built an argument that the verdict
 * belonged to maximum pooling instead, and drafted a pre-registration for the estimator the verdict did not
 * cover. The estimator had been dispatched four weeks earlier under a different name — `retrieval-session` —
 * and had lost by one question. Nothing in either file said so in a place a reader would look, so the
 * argument was reconstructed from the two documents that quoted the negative result rather than from the one
 * that produced it.
 *
 * So the fix is not another paragraph saying "check first". It is a status that has to be written down, and a
 * checker that reads it.
 *
 * ## The three states
 *
 * | status | means | required | forbidden |
 * | --- | --- | --- | --- |
 * | `pending` | registered before its dispatch | a `**Status:**` line | a Result section |
 * | `decided` | dispatched, and the reading is in the file | a Result section **and** a run id | — |
 * | `live` | a standing registration that accumulates increments | a `**Status:**` line | — |
 *
 * `live` exists for `PREREGISTRATION-CORTEX-MEMORY-ARM.md`, which is not one experiment but a ledger of them
 * and carries a Result section per increment. A two-state model would have forced it to `decided` the first
 * time anything was measured, and a file that cannot describe its own state is a file whose state nobody
 * reads.
 *
 * ## The fourth check, which is the one about this repository rather than about one file
 *
 * A `decided` registration may still be **cited** — a later document has to be able to say "that axis
 * closed, here is why". What it may not do is cite it as the plan: the paragraph that names a decided file
 * must contain `result`, `decided`, or the run id. Three words, because the alternative is a prose analyser;
 * the false-negative is a citation that happens to use none of them, and the false-positive is a paragraph
 * that says "result" for an unrelated reason. Both are rarer than the defect, and the check is cheap enough
 * to keep at that accuracy.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '..', 'docs');

const STATUSES = new Set(['pending', 'decided', 'live']);
const STATUS_LINE = /^\*\*Status:\*\*\s*(\S[^\n]*)$/m;
const RESULT_SECTION = /^#{2,}\s.*\bResult\b/m;
const RUN_ID = /\brun\s+`?(\d{8,})`?/gi;
/** The words that make a citation about a result rather than a plan. */
const ACKNOWLEDGES = /\b(result|decided|reading|refut|falsif|closed)\b|`?\d{8,}`?/i;
/**
 * The phrases that make a citation a **plan**, which is the defect this rule is about.
 *
 * Without them the rule fires on every historical mention: a results file that says "`PREREG-X` §5
 * registered a target above the ceiling" is describing a closed registration correctly and would fail.
 * The defect has a shape — naming a decided registration as the thing to do next — and the shape is
 * these phrases. The cost is a plan written in words none of them match; the alternative was five false
 * findings on this repository's own first run, and a gate that cries wolf is a gate people switch off.
 */
const PLAN_PHRASE =
  /\b(next step|next experiment|next round|next dispatch|the plan is|should be dispatched|will be dispatched|is dispatched|to be dispatched|dispatched next|registered now|move on to|now dispatch)\b/i;

/** The stem a citation uses: `PREREG-X.md` and `PREREG-X` both name it. */
function stem(file) {
  return file.replace(/\.md$/, '');
}

/**
 * Every registration in a set of `{ file, text }`, with what its own words say about it.
 *
 * Pure, and given its inputs rather than reading the disk, because `--self-test` has to be able to build a
 * file that violates each rule without a temporary directory and without the rules being able to see the
 * repository they are normally pointed at.
 */
export function census(files) {
  return files
    .filter((entry) => entry.file.startsWith('PREREG'))
    .map(({ file, text }) => {
      const declared = STATUS_LINE.exec(text)?.[1]?.trim().toLowerCase();
      // The word, not the sentence: `pending.` and `decided — run \`…\`` both name a state in their first
      // token, and trailing punctuation is part of the sentence rather than of the value.
      const status =
        declared === undefined ? undefined : declared.split(/[\s(:]/)[0].replace(/[.,;:]+$/, '');
      const runs = [...text.matchAll(RUN_ID)].map((match) => match[1]);
      return {
        file: stem(file),
        status,
        declared,
        hasResult: RESULT_SECTION.test(text),
        runs,
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file));
}

/** The rules, applied to a census. Returns one finding per violation, with the file that caused it. */
export function findingsFor(entries) {
  const findings = [];
  for (const entry of entries) {
    if (entry.status === undefined) {
      findings.push({ file: entry.file, rule: 'status-missing', detail: 'no **Status:** line' });
      continue;
    }
    if (!STATUSES.has(entry.status)) {
      findings.push({
        file: entry.file,
        rule: 'status-unknown',
        detail: `"${entry.declared}" is not one of ${[...STATUSES].join(' / ')}`,
      });
      continue;
    }
    if (entry.status === 'pending' && entry.hasResult) {
      findings.push({
        file: entry.file,
        rule: 'pending-with-result',
        detail: 'declares pending and carries a Result section: the registration already happened',
      });
    }
    if (entry.status === 'decided') {
      if (!entry.hasResult) {
        findings.push({
          file: entry.file,
          rule: 'decided-without-result',
          detail: 'declares decided with no Result section to read',
        });
      }
      if (entry.runs.length === 0) {
        findings.push({
          file: entry.file,
          rule: 'decided-without-run',
          detail: 'declares decided and names no run id, so the reading cannot be found',
        });
      }
    }
  }
  return findings;
}

/**
 * Paragraphs that cite a decided registration without acknowledging that it is decided.
 *
 * The unit is the paragraph rather than the line because a citation and its acknowledgement are often in
 * different lines of the same sentence, and because a one-line window would fire on markdown that wrapped.
 */
export function citationFindings(entries, documents, options = {}) {
  const strict = options.strict !== false;
  const decided = entries.filter((entry) => entry.status === 'decided');
  const findings = [];
  for (const doc of documents) {
    for (const paragraph of doc.text.split(/\n\s*\n/)) {
      // A block quote is somebody's words, not this document's plan. The instance that motivated this rule
      // quoted the old plan verbatim -- `> **"The next step is PREREG-MR-SESSION-CHANNEL"**` -- and a
      // quotation is the record of the mistake rather than a repeat of it.
      const quoted = paragraph
        .split('\n')
        .filter((line) => line.trim() !== '')
        .every((line) => line.trimStart().startsWith('>'));
      if (quoted) continue;
      if (strict && !PLAN_PHRASE.test(paragraph)) continue;
      for (const entry of decided) {
        if (!paragraph.includes(entry.file)) continue;
        // The file's own name is removed before the acknowledgement is looked for, because a registration
        // called `PREREG-CLOSED` would otherwise acknowledge itself: the hyphen is a word boundary, so
        // `\bclosed\b` matches the name and every citation of it would pass.
        const surrounding = paragraph.split(entry.file).join(' ');
        if (ACKNOWLEDGES.test(surrounding)) continue;
        findings.push({
          file: doc.file,
          rule: 'cites-decided-as-plan',
          detail: `${entry.file} is decided but this paragraph does not say so`,
        });
      }
    }
  }
  return findings;
}

function readDocs() {
  return readdirSync(DOCS)
    .filter((name) => name.endsWith('.md'))
    .map((file) => ({ file, text: readFileSync(path.join(DOCS, file), 'utf8') }));
}

function render(entries, findings) {
  const lines = ['registration                      status     result  runs', '---'];
  for (const entry of entries) {
    lines.push(
      [
        entry.file.padEnd(35),
        String(entry.status ?? '(none)').padEnd(10),
        (entry.hasResult ? 'yes' : 'no').padEnd(7),
        entry.runs.join(',') || '-',
      ].join(' '),
    );
  }
  lines.push('');
  const pending = entries.filter((entry) => entry.status === 'pending');
  lines.push(
    `${entries.length} registration(s): ${entries.length - pending.length} closed, ${pending.length} open`,
  );
  if (findings.length === 0) {
    lines.push('GATE PASS: every registration states its own status, and every citation admits it');
    return lines.join('\n');
  }
  lines.push(`GATE FAIL: ${findings.length} finding(s)`);
  for (const finding of findings)
    lines.push(`  ${finding.file}: ${finding.rule} — ${finding.detail}`);
  return lines.join('\n');
}

function selfTest() {
  let checks = 0;
  const assert = (condition, message) => {
    checks += 1;
    if (!condition) throw new Error(`self-test failed: ${message}`);
  };

  const base = (extra) => `# Pre-registration\n\n${extra}\n`;

  // 1. A pending registration without a Result section is the normal, healthy state.
  const healthy = census([{ file: 'PREREG-OK.md', text: base('**Status:** pending') }]);
  assert(healthy[0].status === 'pending', 'the status word is read');
  assert(healthy[0].hasResult === false, 'no Result section is read as none');
  assert(findingsFor(healthy).length === 0, 'a pending registration with no result passes');

  // 2. The defect this file exists for: a registration that already happened and still says pending.
  const dead = census([
    {
      file: 'PREREG-DEAD.md',
      text: base('**Status:** pending\n\n## 6. Result\n\nrun `40498191604`'),
    },
  ]);
  assert(dead[0].hasResult, 'the Result section is seen');
  const deadFindings = findingsFor(dead);
  assert(
    deadFindings.length === 1 && deadFindings[0].rule === 'pending-with-result',
    'pending plus a result is one finding, named',
  );

  // 3. Decided has to be able to point at its reading: a status without a run is a claim, not a record.
  const noRun = census([
    { file: 'PREREG-NORUN.md', text: base('**Status:** decided\n\n## 6. Result') },
  ]);
  assert(
    findingsFor(noRun).some((finding) => finding.rule === 'decided-without-run'),
    'decided without a run id fails',
  );
  const noResult = census([{ file: 'PREREG-NORES.md', text: base('**Status:** decided') }]);
  assert(
    findingsFor(noResult).some((finding) => finding.rule === 'decided-without-result'),
    'decided without a Result section fails',
  );

  // 4. Missing and unknown statuses are separate findings, because the fixes are different.
  assert(
    findingsFor(census([{ file: 'PREREG-NONE.md', text: base('nothing here') }]))[0].rule ===
      'status-missing',
    'a file with no Status line is a finding',
  );
  assert(
    findingsFor(census([{ file: 'PREREG-ODD.md', text: base('**Status:** maybe') }]))[0].rule ===
      'status-unknown',
    'an unrecognised status is a finding rather than a default',
  );

  // 5. `live` is a third state and is not read as either of the other two.
  const live = census([
    {
      file: 'PREREGISTRATION-LEDGER.md',
      text: base('**Status:** live\n\n## 6. Result\n\nrun `41159983913`'),
    },
  ]);
  assert(live[0].status === 'live', 'live is parsed');
  assert(findingsFor(live).length === 0, 'a live ledger may carry results');

  // 6. The citation rule: naming a decided registration as the plan fails, naming it as closed passes.
  const decided = census([
    {
      file: 'PREREG-AXIS.md',
      text: base('**Status:** decided\n\n## 6. Result\n\nrun `40498191604`, MR 83/121'),
    },
  ]);
  const asPlan = citationFindings(decided, [
    { file: 'PLAN.md', text: 'The next experiment is PREREG-AXIS, which should move MR by six.' },
  ]);
  assert(
    asPlan.length === 1 && asPlan[0].rule === 'cites-decided-as-plan',
    'a plan citing a dead registration fails',
  );
  const asClosed = citationFindings(decided, [
    {
      file: 'PLAN.md',
      text: 'PREREG-AXIS is decided: run `40498191604` read 83/121 against 84, so the axis closed.',
    },
  ]);
  assert(asClosed.length === 0, 'a citation that admits the result passes');
  const history = citationFindings(decided, [
    {
      file: 'RESULTS.md',
      text: 'PREREG-AXIS registered a target the control could not reach, which is why the ceiling mattered.',
    },
  ]);
  // Not a plan: no plan phrase, so the strict rule stays silent on a historical mention. Asserted because
  // the first run of this tool on this repository produced five findings and all five were this shape.
  assert(history.length === 0, 'a historical mention is not a plan');
  const unphrased = citationFindings(
    decided,
    [{ file: 'PLAN.md', text: 'PREREG-AXIS is where the work should continue.' }],
    { strict: false },
  );
  assert(
    unphrased.length === 1,
    'the non-strict pass reports every citation, so a human can read them',
  );
  const quoted = citationFindings(decided, [
    { file: 'PLAN.md', text: '> **"The next step is PREREG-AXIS."**' },
  ]);
  assert(quoted.length === 0, 'a block quote is the record of a mistake, not a repeat of it');

  // 7. A pending registration can be cited freely: that is what a plan is for.
  const pending = census([{ file: 'PREREG-OPEN.md', text: base('**Status:** pending') }]);
  assert(
    citationFindings(pending, [{ file: 'PLAN.md', text: 'The next experiment is PREREG-OPEN.' }])
      .length === 0,
    'a pending registration may be the plan',
  );

  // 8. The render states the verdict and the count, so a reader does not have to derive them.
  const passed = render(healthy, []);
  assert(passed.includes('GATE PASS'), 'the render states a pass');
  assert(passed.includes('1 registration(s)'), 'the render counts');
  const failed = render(dead, deadFindings);
  assert(failed.includes('GATE FAIL'), 'the render states a failure');
  assert(failed.includes('pending-with-result'), 'the render names the rule');

  process.stdout.write(`prereg-status: ${checks} assertion(s) passed\n`);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const documents = readDocs();
  const entries = census(documents);
  const findings = [
    ...findingsFor(entries),
    ...citationFindings(
      entries,
      documents.filter((doc) => !doc.file.startsWith('PREREG')),
    ),
  ];
  const text = render(entries, findings);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ entries, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
  if (process.argv.includes('--check') && findings.length > 0) process.exit(1);
}

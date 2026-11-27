#!/usr/bin/env node
/**
 * Whether a registration that has not run can be run.
 *
 *     node tools/prereg-knobs.mjs [--check|--self-test] [--json]
 *
 * ## The defect, which this campaign has now shipped three times
 *
 * A pre-registration is a promise about a comparison: *"run the same arm with `X=1` and read the
 * difference"*. The promise is only a promise if `X` is a thing the harness can receive. Three rounds
 * have now written a registration whose treatment does not exist:
 *
 * | round | what the document said | what was in the tree |
 * | --- | --- | --- |
 * | §208.10 | a verification command that reports its own verdict | a command that could not fail |
 * | §209.1 | "both sides run in the same job" | five pairings, none of which holds two evidence units |
 * | §211 | `PREREGISTRATION-MULTI-STEP.md` §3 names `readerSearch` as the treatment | **the string does not occur in the repository** |
 *
 * The first two were found by reading. This one survived a full round of dispatch planning, a pricing
 * table and a queue row, because nothing reads a registration against the code. `prereg-status.mjs`
 * reads a *state* (`pending` / `decided` / `live`) and refuses a decided file cited as a plan; it does
 * not read whether the plan is buildable. That is the gap this file closes.
 *
 * ## The rule, and why it is phrased on assignments rather than on backticks
 *
 * A treatment is written as an **assignment**: `` `name=value` ``. Prose backticks name capabilities,
 * question ids (`gpt4_7f6b06db`), artifact fields (`carried`, `evidenceSpan`) and field names a
 * document proposes (`anchorTimeID`) -- all of which are legitimately absent from the dispatch path,
 * and a rule phrased on "every backticked identifier must exist" reports nine of those on this
 * repository's own pending registrations. A rule that cries wolf nine times in six files is a rule
 * people switch off.
 *
 * The assignment form is narrow and it is the one the promise is written in: on this repository's six
 * pending registrations it extracts thirteen names, twelve of which are `maxSteps`, `thinking`,
 * `promptVariants`, `embedDegraded`, `capability` and `carried` -- all in the tree -- and one of which
 * is `readerSearch`.
 *
 * ## Two ways to be green, and the difference matters
 *
 * A missing knob is either a defect or a **declared block**. A registration that cannot run yet says so
 * on a `**Blocked on:**` line, and that line has to name the same knob the gate could not find:
 *
 * | state | line | verdict |
 * | --- | --- | --- |
 * | knob in the dispatch path | — | `buildable` |
 * | knob absent, no `**Blocked on:**` line | — | **`missing`**, and the run goes red |
 * | knob absent, `**Blocked on:**` names it | `**Blocked on:** \`readerSearch\` -- no arm reads it` | `blocked`, printed and green |
 * | knob absent, `**Blocked on:**` names something else | — | **`missing`**: the declaration does not cover the defect |
 *
 * The third row is the one that keeps this gate usable. A gate with no way to record a known,
 * deliberate block is a gate that gets an allowlist, and an allowlist is a place defects go to be
 * forgotten. A declared block is printed in every run, so it stays visible without being red.
 *
 * ## What it does not check
 *
 * Whether the knob *works*. `readerSearch=1` implemented as a no-op would pass here and fail in the
 * artifact -- that is `guard:arm-config`'s question, and it is asked of a run rather than of a plan.
 * This gate answers the cheaper question that has to be answered first: is there anything to dispatch.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOCS = path.join(ROOT, 'docs');

/** Where a dispatched knob can be received. Relative to the repository root. */
const DISPATCH_PATHS = [
  '.github/workflows',
  'tools',
  'packages/cortex-ai/src',
  'packages/cortex-core/src',
  'packages/cortex-eval/src',
  'packages/cortex-memory/src',
  'packages/cortex-memory/bench',
];

/** Files under those paths that are not the dispatch path: tests, and the gates that read documents. */
const NOT_DISPATCH = [/(^|\/)__tests__\//, /(^|\/)test\//, /(^|\/)dist\//];

/** The dispatch path's own readers, excluded so a registration cannot be satisfied by a test's fixture. */
const NOT_DISPATCH_FILES = new Set([
  // This tool, its siblings that read documents, and their tests. A knob "found" here is found in the
  // gate rather than in the harness -- the §209 shape one level up.
  'tools/prereg-knobs.mjs',
  'tools/prereg-status.mjs',
  'tools/docs-crosscheck.mjs',
]);

const STATUS_LINE = /^\*\*Status:\*\*\s*(\S[^\n]*)$/m;
const BLOCKED_LINE = /^\*\*Blocked on:\*\*\s*([^\n]*)$/m;
/** A treatment is an assignment in backticks: `name=value`. */
const ASSIGNMENT = /`([a-z][A-Za-z0-9_]*)\s*=\s*[^`]{1,40}`/g;
/** Anything the document says it is blocked on, however it is spelled inside backticks. */
const BACKTICKED = /`([^`]+)`/g;
/** A registration stops being a plan at its result section. */
const RESULT_SECTION = /^#{2,}\s.*\bResult\b/m;

/**
 * The names a pending document registers a treatment under.
 *
 * Only the part of the document above its first `Result` section: a result section quotes the
 * treatment it measured, and a registration that has already run is `decided` -- its knob may have
 * been renamed or removed since, and demanding that it still exist would make deleting dead
 * configuration a red build.
 */
export function assignmentKnobs(text) {
  const head = text.split(RESULT_SECTION)[0] ?? '';
  const names = new Set();
  for (const match of head.matchAll(ASSIGNMENT)) names.add(match[1]);
  return [...names].sort();
}

/** Whether the document declares a block, and what it names. */
export function blockedOn(text) {
  const match = BLOCKED_LINE.exec(text);
  if (match === null) return { declared: false, names: [] };
  const names = new Set();
  for (const token of match[1].matchAll(BACKTICKED)) {
    // `readerSearch` and `readerSearch=1` are the same claim about the same knob.
    names.add(token[1].split('=')[0].trim());
  }
  return { declared: true, names: [...names] };
}

/** Every pending registration under `docs`, paired with the knobs it names. */
export function pendingRegistrations(docsDir) {
  return readdirSync(docsDir)
    .filter((name) => name.startsWith('PREREG') && name.endsWith('.md'))
    .sort()
    .map((name) => path.join(docsDir, name))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => {
      const status = STATUS_LINE.exec(text);
      return status !== null && status[1].startsWith('pending');
    })
    .map(({ file, text }) => ({
      file: path.basename(file),
      knobs: assignmentKnobs(text),
      blocked: blockedOn(text),
    }));
}

/** The dispatch path, as one haystack. Text, because a knob is a name and not a symbol table. */
export function dispatchHaystack(root) {
  const chunks = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    let entries;
    try {
      entries = readdirSync(absolute);
    } catch {
      // A path this checkout does not have is not a finding: the list names a layout rather than a
      // promise, and a missing directory would otherwise fail as "every knob is missing".
      return;
    }
    for (const entry of entries) {
      const child = path.join(relative, entry);
      if (NOT_DISPATCH.some((pattern) => pattern.test(child))) continue;
      const info = statSync(path.join(root, child));
      if (info.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(mjs|ts|py|ya?ml)$/.test(entry)) continue;
      if (NOT_DISPATCH_FILES.has(child)) continue;
      chunks.push(readFileSync(path.join(root, child), 'utf8'));
    }
  };
  for (const relative of DISPATCH_PATHS) walk(relative);
  return chunks.join('\n');
}

/**
 * One row per (registration, knob), in the three states the header describes.
 *
 * Returned rather than printed so a test can assert the states without parsing a table, and so
 * `--json` and the table cannot describe different things.
 */
export function audit({ docsDir = DOCS, root = ROOT } = {}) {
  const haystack = dispatchHaystack(root);
  const rows = [];
  for (const registration of pendingRegistrations(docsDir)) {
    for (const knob of registration.knobs) {
      const present = new RegExp(`\\b${knob}\\b`).test(haystack);
      const declared = registration.blocked.names.includes(knob);
      rows.push({
        file: registration.file,
        knob,
        // `declared` alone is not enough: a knob that is both present and declared is a stale
        // declaration, and reporting it as `blocked` would let a built knob stay off the queue.
        state: present ? 'buildable' : declared ? 'blocked' : 'missing',
      });
    }
  }
  return rows;
}

function table(rows) {
  const lines = [
    'registration                       knob                  state',
    '---------------------------------  --------------------  ---------',
  ];
  for (const row of rows) {
    lines.push(`${row.file.padEnd(34)} ${row.knob.padEnd(20)}  ${row.state}`);
  }
  return lines.join('\n');
}

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prereg-knobs-'));
  const docs = path.join(dir, 'docs');
  mkdirSync(path.join(docs, 'nested'), { recursive: true });
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  mkdirSync(path.join(dir, 'packages', 'cortex-memory', 'src'), { recursive: true });
  // The dispatch path holds one knob and the word "present" everywhere.
  writeFileSync(path.join(dir, 'tools', 'dispatch.py'), 'SHIPPED = "shippedKnob"\n');
  writeFileSync(
    path.join(dir, 'packages', 'cortex-memory', 'src', 'memory.ts'),
    'export const shippedKnob = 1;\n',
  );

  const eq = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`self-test: ${label}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(actual)}`);
    }
  };

  // 1. A pending registration naming a knob the dispatch path has.
  writeFileSync(
    path.join(docs, 'PREREG-OK.md'),
    '# ok\n\n**Status:** pending -- not dispatched\n\nRun it with `shippedKnob=1`.\n',
  );
  // 2. A pending registration naming a knob nothing has. This is §211's live defect.
  writeFileSync(
    path.join(docs, 'PREREG-MISSING.md'),
    '# missing\n\n**Status:** pending -- not dispatched\n\n| treatment | `absentKnob=1` |\n',
  );
  // 3. The same, declared. Green, and printed as blocked rather than buildable.
  writeFileSync(
    path.join(docs, 'PREREG-BLOCKED.md'),
    '# blocked\n\n**Status:** pending -- blocked on `absentKnob`, which no arm reads\n' +
      '**Blocked on:** `absentKnob` -- the arm has no such field.\n\nRun `absentKnob=1`.\n',
  );
  // 4. A declaration that names something else does not cover the defect.
  writeFileSync(
    path.join(docs, 'PREREG-WRONG-BLOCK.md'),
    '# wrong\n\n**Status:** pending\n**Blocked on:** `otherKnob` -- unrelated.\n\nRun `absentKnob=1`.\n',
  );
  // 5. A decided registration whose knob was deleted since. Not a plan, so not this gate's question.
  writeFileSync(
    path.join(docs, 'PREREG-DONE.md'),
    '# done\n\n**Status:** decided -- run `41234567890`\n\nRan `absentKnob=1`.\n\n## 6. Result\n\nIt read 1.\n',
  );
  // 6. A knob named only inside the result section is history rather than a promise.
  writeFileSync(
    path.join(docs, 'PREREG-HISTORY.md'),
    '# history\n\n**Status:** pending\n\n## 3. Comparison\n\n`shippedKnob=1`.\n\n## 4. Result\n\n`goneKnob=1` was retired.\n',
  );

  const rows = audit({ docsDir: docs, root: dir });
  const state = (file, knob) => rows.find((row) => row.file === file && row.knob === knob)?.state;

  eq('a shipped knob is buildable', state('PREREG-OK.md', 'shippedKnob'), 'buildable');
  eq('an absent knob is missing', state('PREREG-MISSING.md', 'absentKnob'), 'missing');
  eq('a declared block is blocked', state('PREREG-BLOCKED.md', 'absentKnob'), 'blocked');
  eq('a wrong declaration does not cover it', state('PREREG-WRONG-BLOCK.md', 'absentKnob'), 'missing');
  eq('a decided file is not read', state('PREREG-DONE.md', 'absentKnob'), undefined);
  eq('a knob below the result section is history', state('PREREG-HISTORY.md', 'goneKnob'), undefined);
  eq('only the pending files appear', [...new Set(rows.map((row) => row.file))].sort(), [
    'PREREG-BLOCKED.md',
    'PREREG-HISTORY.md',
    'PREREG-MISSING.md',
    'PREREG-OK.md',
    'PREREG-WRONG-BLOCK.md',
  ]);

  // The parser, on the two forms a document writes: with a value and with a range.
  eq('assignments are names', assignmentKnobs('`alpha=1`, `beta=0.5`, `gamma`'), ['alpha', 'beta']);

  process.stdout.write(
    `self-test: 1 buildable, 1 missing, 1 declared block, 1 wrong declaration, 1 decided file ignored, ` +
      `1 knob below the result section ignored\n`,
  );
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const rows = audit();
  const missing = rows.filter((row) => row.state === 'missing');
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ rows, missing }, null, 2)}\n`);
  } else {
    process.stdout.write(`${table(rows)}\n`);
    const blocked = rows.filter((row) => row.state === 'blocked');
    for (const row of blocked) {
      process.stdout.write(
        `\nblocked: ${row.file} names \`${row.knob}\`, which the dispatch path does not have, and the ` +
          'document says so. Nothing to dispatch until the knob exists.\n',
      );
    }
    if (missing.length > 0) {
      for (const row of missing) {
        process.stderr.write(
          `missing: ${row.file} registers \`${row.knob}\` as its treatment and the dispatch path does ` +
            'not contain it. A registration whose treatment cannot be received is not a plan: build ' +
            'the knob, or declare `**Blocked on:**` and name it.\n',
        );
      }
    }
  }
  return missing.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}

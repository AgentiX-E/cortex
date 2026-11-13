#!/usr/bin/env node
/**
 * Fail unless the PostgreSQL integration suite actually ran, and ran green.
 *
 * ## The failure this is built to prevent
 *
 * `packages/cortex-storage/test/pg/integration.test.ts` is conditional: it skips when
 * `CORTEX_PG_URL` is unset, because most machines do not have a database. A skipped suite and a
 * passing suite are indistinguishable in a summary line, and vitest exits 0 for both. So the deep
 * problem with a conditional suite is not that it might skip -- it is that a skip looks like a
 * result.
 *
 * This script removes the ambiguity by reading the reporter's JSON and refusing three states that
 * would otherwise pass:
 *
 *   1. Anything skipped, pending or todo. A conditional `describe` that took the skip branch
 *      produces exactly that, so this catches "CI is green and nothing connected to a database".
 *   2. Fewer executed assertions than the floor. A suite where half the `it` blocks were silently
 *      deleted still reports `success: true`.
 *   3. A non-zero failure count, which vitest already exits on -- checked anyway, because this file
 *      is what `verify.yml` reads and it should not depend on two independent exit codes agreeing.
 *
 * ## Why the floor is a constant in this file
 *
 * It is the number of assertions the suite currently makes. Lowering it is a deliberate edit to a
 * tracked file with the count visible in the diff, rather than a threshold that drifts with
 * whatever the suite happens to contain. When the suite grows, this number goes up in the same
 * commit -- which is the only way the check keeps meaning anything.
 */
import { readFileSync } from 'node:fs';

/** The number of assertions `test/pg/integration.test.ts` makes. Raise it when the suite grows. */
const FLOOR = 31;

const path = process.argv[2] ?? '/tmp/cortex-pg-report.json';

let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  fail(`cannot read the vitest JSON report at ${path}: ${error.message}`);
}

const numTotalTests = report.numTotalTests ?? 0;
const numPassed = report.numPassedTests ?? 0;
const numFailed = report.numFailedTests ?? 0;
const numPending = report.numPendingTests ?? 0;
const numTodo = report.numTodoTests ?? 0;

const problems = [];

if (numTotalTests === 0) {
  problems.push(
    'the report contains no tests at all. `CORTEX_PG_URL` is presumably unset, so the suite took ' +
      'its skip branch -- which is the exact state this check exists to make impossible in CI',
  );
}
if (numPending > 0 || numTodo > 0) {
  problems.push(
    `${numPending} pending and ${numTodo} todo. A conditional suite that skipped one assertion is ` +
      'not evidence about the assertions beside it',
  );
}
if (numPassed < FLOOR) {
  problems.push(
    `${numPassed} assertions ran, the floor is ${FLOOR}. A suite where assertions were deleted ` +
      'still reports success',
  );
}
if (numFailed > 0) {
  problems.push(`${numFailed} assertions failed`);
}
if (report.success !== true && problems.length === 0) {
  problems.push('the reporter did not report success, with no failing assertion to explain it');
}

if (problems.length > 0) {
  fail(problems.join('\n  - '));
}

console.log(
  `PostgreSQL integration suite: ${numPassed}/${numTotalTests} assertions passed, ` +
    `0 skipped, floor ${FLOOR}.`,
);

function fail(message) {
  console.error(`pg-integration-count: FAILED\n  - ${message}`);
  process.exit(1);
}

/**
 * The restart suite every engine runs: matrix, write, restart, read, digest.
 *
 * ## Why this is one module and not two copies
 *
 * `§10.2` gate 2 asks a question about **the product**, not about a browser: is the data still there
 * after the browser closes. The answer has to be comparable across engines, and two probes that each
 * wrote their own two-phase flow would eventually disagree about something that is not the engine --
 * the row count, the digest function, whether the second launch reuses the origin. The only part that
 * genuinely differs between Chromium and Firefox is the launch and the protocol, so that is the only
 * part a caller supplies.
 *
 * ## What a caller must provide
 *
 * `open(origin)` launches the browser on the given profile, navigates to the suite page, waits for its
 * modules, and returns `{ evaluate, close }`. Everything else -- which checks run, which mode is asked
 * for, how the two phases are compared -- is here, so a second engine cannot quietly skip a phase.
 */

/**
 * Run the suite across one browser restart.
 *
 * The two phases must share an **origin**: OPFS is per-origin storage, so a second launch on a new port
 * would read an empty database and pass. `origin` is therefore produced once by the caller's server and
 * passed to both `open` calls, and the caller is expected to have started that server before the first.
 */
export async function runRestartSuite({ engine, rows, origin, open, note }) {
  const phases = {};

  const first = await open(origin);
  try {
    phases.matrix = await first.evaluate('__run({ mode: "matrix" })');
    phases.write = await first.evaluate(`__run({ mode: "write", rows: ${rows} })`);
  } finally {
    await first.close();
  }

  const second = await open(origin);
  try {
    const expected = phases.write.digest.hash;
    phases.read = await second.evaluate(
      `__run({ mode: "read", rows: ${rows}, expected: ${expected} })`,
    );
  } finally {
    await second.close();
  }

  const checks = [...(phases.matrix?.checks ?? [])];
  const digestMatches = phases.read?.matches === true;
  checks.push({
    name: 'rows survive a browser restart with an identical digest',
    ok: digestMatches,
    detail: `wrote ${phases.write?.digest.hash}, read ${phases.read?.digest.hash} (${phases.read?.digest.count} rows)`,
  });

  const failures = checks.filter((check) => !check.ok);
  return {
    engine,
    origin,
    rows,
    phases,
    note,
    summary: {
      checks: checks.length,
      passed: checks.length - failures.length,
      failed: failures.length,
      digestMatches,
    },
    checks,
    failures,
  };
}

/** Print the per-check lines and the throughput sentence, in the shape both engines report. */
export function printRestartSuite(report, resultsPath) {
  for (const check of report.checks) {
    console.log(
      `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` -- ${check.detail}` : ''}`,
    );
  }
  const write = report.phases.write;
  const read = report.phases.read;
  if (write !== undefined && read !== undefined) {
    console.log(
      `\n${write.rows} rows on ${write.tier} (${write.engine}): ` +
        `one commit per row ${write.writeMs.toFixed(0)} ms (${Math.round(write.rowsPerSecond)} rows/s), ` +
        `one transaction ${write.transactionWriteMs.toFixed(0)} ms ` +
        `(${Math.round(write.transactionRowsPerSecond)} rows/s), ` +
        `read ${read.readMs.toFixed(1)} ms, digest ${write.digest.hash} == ${read.digest.hash}`,
    );
  }
  console.log(
    `${report.engine}: ${report.summary.passed}/${report.summary.checks} checks passed -> ${resultsPath}`,
  );
}

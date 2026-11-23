/**
 * A full origin, in a real Chromium: what the product does when the quota is gone.
 *
 * ## What only this run can answer
 *
 * The Node suite proves the translation arithmetic against a wrapped engine. It cannot prove that the
 * *browser* refuses SQLite's writes when the origin is full, nor that a row written before the
 * exhaustion is still readable afterwards. The last of those is what a user cares about: running out
 * of room must not cost them the memory they already had.
 *
 * ## The reading that changed the product
 *
 * The first version of this probe was written to *diagnose* a full origin: a one-byte write into the
 * origin's directory would either succeed (device failure) or raise `QuotaExceededError` (quota), and
 * the library would then name the cause. Run against a real Chromium with the quota overridden to
 * zero, that premise is false -- three checks below record it:
 *
 *   * `navigator.storage.estimate()` still reports the default 10 GiB (check 3);
 *   * a raw OPFS write of **eight megabytes** still succeeds (check 4);
 *   * a fresh IndexedDB write still lands (check 5).
 *
 * Only SQLite's own writes through the access-handle pool fail. So the library cannot tell the two
 * causes apart, the class it raises is `StorageUnavailableError` rather than `StorageFullError`, and
 * its message states the ambiguity instead of guessing. That is what this file is for.
 *
 * ## Why the quota is set from the driver and not from the page
 *
 * There is no JS API to lower an origin's quota -- `navigator.storage.estimate()` only reports. The
 * condition is created over the DevTools protocol (`Storage.overrideQuotaForOrigin`, the only one of
 * the two candidate methods this Chromium answers), which is exactly why the page is asked to do one
 * step at a time: `prepare` writes while there is room, the driver takes the room away, `attempt`
 * writes and reads.
 *
 * ## Why opening is a check of its own
 *
 * Check 6 records that opening still succeeds under a zero quota. Without it, a refusal in check 7
 * could be an open failure wearing a write failure's name.
 *
 * ## Usage
 *
 *   node test/browser/quota-probe.mjs
 *   node test/browser/quota-probe.mjs --check --committed packages/cortex-storage/test/browser/quota-run.json
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch, sleep, waitReady } from './cdp.mjs';
import { serveDist } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root, so `--committed` resolves the same from any working directory. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PACKAGE = resolve(HERE, '..', '..');
// Its own variable: `CORTEX_RESULTS` belongs to `probe.mjs` and `CORTEX_RESULTS_TWO_TAB` to the
// two-tab probe, and a shared name would have one reading overwrite another.
const RESULTS = process.env.CORTEX_RESULTS_QUOTA ?? join(PACKAGE, 'test', 'browser', 'quota-run.json');

/** How much room the origin is given back after the refusal. */
const RESTORED_QUOTA = 1_073_741_824;

async function main() {
  const chrome = findChrome();
  if (chrome === undefined) {
    // A suite that skipped measured nothing, and the exit status is the only signal CI can read.
    // 2 rather than 1: a missing browser is not a failing product.
    console.error('no Chromium found: set CORTEX_CHROME to one, or install playwright browsers');
    process.exitCode = 2;
    return;
  }

  const { server, origin } = await serveDist();
  const profile = mkdtempSync(join(tmpdir(), 'cortex-quota-'));
  const debugPort = 9950 + Math.floor(Math.random() * 40);
  const launched = await launch({ chrome, profile, port: debugPort });
  const checks = [];
  try {
    await launched.connection.send('Page.navigate', { url: `${origin}/` });
    await waitReady(launched.connection);
  } catch (error) {
    await launched.close();
    server.close();
    throw error;
  }

  const check = (name, ok, detail) => {
    checks.push({ name, ok: ok === true, detail });
    console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${ok === true ? '' : ` -- ${JSON.stringify(detail)}`}`);
  };
  const send = (method, params) => launched.connection.send(method, params);
  const run = (request) => launched.connection.evaluate(`window.__run(${JSON.stringify(request)})`);

  try {
    // A row written while there is room. Everything after this is about not losing it.
    const prepared = await run({ mode: 'quota', step: 'prepare' });
    check('the origin opens on a tier and accepts a row while there is room', prepared.ok === true && prepared.wrote === true, prepared);

    await send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 0 });
    await sleep(300);
    const enforced = await send('Storage.getUsageAndQuota', { origin });
    check(
      'the browser enforces a zero quota for this origin',
      enforced.quota === 0 && enforced.overrideActive === true,
      enforced,
    );

    // The three platform facts that make a page-side diagnosis impossible. They are checks rather
    // than prose because each one is a premise the product's error message depends on.
    const platform = await run({ mode: 'quota', step: 'platform' });
    check(
      'the page cannot see the override: the estimate still reports gigabytes',
      typeof platform.estimateQuota === 'number' && platform.estimateQuota > 1_000_000_000,
      { estimateQuota: platform.estimateQuota, enforced: enforced.quota },
    );
    check(
      'a raw OPFS write of eight megabytes still succeeds at a zero quota',
      platform.rawOpfs === 'wrote-8MiB',
      { rawOpfs: platform.rawOpfs },
    );
    check(
      'a fresh IndexedDB write still lands at a zero quota',
      platform.indexedDb === 'wrote',
      { indexedDb: platform.indexedDb },
    );

    const underZero = await run({ mode: 'quota', step: 'attempt' });
    check(
      'opening under a zero quota still answers, on OPFS',
      underZero.ok === true && underZero.tier === 'opfs',
      underZero,
    );
    check(
      'the write under a zero quota is refused by name',
      underZero.wrote === false && underZero.name === 'StorageUnavailableError',
      underZero,
    );
    check(
      'the refusal keeps the SQLite cause it came from',
      typeof underZero.cause === 'string' && underZero.cause.includes('SQLITE_IOERR'),
      { cause: underZero.cause },
    );
    check(
      'the row written before the exhaustion is still readable',
      underZero.read?.v === 42 && underZero.blocked === null,
      { read: underZero.read, blocked: underZero.blocked },
    );

    await send('Storage.overrideQuotaForOrigin', { origin, quotaSize: RESTORED_QUOTA });
    await sleep(300);
    const restored = await send('Storage.getUsageAndQuota', { origin });
    const recovered = await run({ mode: 'quota', step: 'attempt' });
    check(
      'the refusal is not permanent: with room back, the same write lands',
      restored.quota === RESTORED_QUOTA && recovered.wrote === true && recovered.blocked?.v === 1,
      { quota: restored.quota, wrote: recovered.wrote, blocked: recovered.blocked },
    );
    check('the earlier row survived the whole episode', recovered.read?.v === 42, { read: recovered.read });
  } finally {
    await launched.close();
    server.close();
  }

  const passed = checks.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${checks.length} quota checks passed`);
  writeFileSync(
    RESULTS,
    `${JSON.stringify(
      {
        engine: 'chromium',
        checks,
        passed,
        total: checks.length,
        note:
          'One run, one origin. The quota is created with the DevTools protocol ' +
          '(Storage.overrideQuotaForOrigin), which is the only method this Chromium answers; the page ' +
          'cannot do it. Timings are not recorded because nothing here depends on them.',
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${RESULTS}`);
  if (passed !== checks.length) process.exitCode = 1;
  if (process.argv.includes('--check')) {
    if (!compareWithCommitted(checks, passed)) process.exitCode = 1;
  }
}

/**
 * Whether a fresh run agrees with the committed reading, check by check and in order.
 *
 * The same rule the two-tab probe follows: a committed reading is evidence only if something
 * re-derives it and says so, and a reordering is a change to the flow even when every verdict stays
 * green.
 */
function compareWithCommitted(fresh, passedCount) {
  const flag = process.argv.indexOf('--committed');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  const committedPath = named === undefined ? join(HERE, 'quota-run.json') : resolve(REPO_ROOT, named);
  if (!existsSync(committedPath)) {
    console.error(`FAIL no committed reading at ${committedPath}`);
    return false;
  }
  const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
  const before = committed.checks ?? [];
  const differences = [];
  if (before.length !== fresh.length) differences.push(`${before.length} checks against ${fresh.length}`);
  for (let index = 0; index < Math.min(before.length, fresh.length); index += 1) {
    const one = before[index];
    const two = fresh[index];
    if (one.name !== two.name) differences.push(`#${index + 1} is named "${one.name}", fresh "${two.name}"`);
    if (one.ok !== two.ok) differences.push(`#${index + 1} "${one.name}" was ${one.ok}, fresh ${two.ok}`);
  }
  if (differences.length > 0) {
    console.error(`FAIL ${RESULTS} disagrees with ${committedPath}:`);
    for (const difference of differences) console.error(`  ${difference}`);
    return false;
  }
  console.log(
    `ok ${RESULTS} agrees with ${committedPath}: ${fresh.length} checks, identical in order and verdict` +
      ` (${passedCount}/${fresh.length} green in both)`,
  );
  return true;
}

await main();

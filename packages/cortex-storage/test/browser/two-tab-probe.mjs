/**
 * Two tabs, one origin: the claim, measured in a real Chromium.
 *
 * ## What only this run can answer
 *
 * The Node suites prove the policy against a fake lock manager; they cannot prove the platform answers
 * the way the fake does. This probe opens two targets on **one** user-data-dir and one origin -- which is
 * what a user does by middle-clicking a link -- and asks the second tab to open the same database.
 *
 * ## The four things it asserts, and why each needs the other three
 *
 * 1. The first tab claims the origin, on OPFS, with `web-locks` as the mechanism. Without this, a refusal
 *    in the second tab would be indistinguishable from a browser that has no lock manager at all.
 * 2. The second tab is refused **by name** and never reaches a tier. That is the product decision.
 * 3. A second tab that asks for `allow` gets a storage and reports `acquired: false` -- and, the part that
 *    matters, **cannot read the first tab's row**. That is the divergence this round makes visible instead
 *    of silent, stated as a measurement rather than as a warning.
 * 4. When the first tab closes, a retry in the second tab opens OPFS and **does** read the first tab's row.
 *    This is the one check that proves the release happened and that there is exactly one database --
 *    without it, "refused" and "released" would both look like success.
 *
 * ## Chromium only, and why that is a stated boundary rather than an omission
 *
 * Firefox's BiDi cannot create a second browsing context on the build this suite has (132): the command
 * is answered with nothing at all (`docs/MEASURE-BROWSER-PERSISTENCE.md` records the hang). Two tabs on
 * Firefox therefore cannot be driven by this harness, so the second-tab claim is measured on one engine.
 *
 * ## Usage
 *
 *   node test/browser/two-tab-probe.mjs
 *   CORTEX_CHROME=/path/to/chrome node test/browser/two-tab-probe.mjs
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, findChrome, launch, sleep, waitReady } from './cdp.mjs';
import { serveDist } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root, so a `--committed` path from the workflow resolves the same from any directory. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PACKAGE = resolve(HERE, '..', '..');
// A variable of its own, not `CORTEX_RESULTS`: `probe.mjs` already owns that name for `last-run.json`,
// and the two would overwrite each other -- the failure `verify.yml` spent a round fixing for the bundle
// reading, where the fix was a fourth variable rather than a shared one.
const RESULTS =
  process.env.CORTEX_RESULTS_TWO_TAB ?? join(PACKAGE, 'test', 'browser', 'two-tab-run.json');

/** A second target on the browser that is already running, on the same profile and origin. */
async function openTab(port, origin) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${origin}/`)}`,
      { method: 'PUT' },
    );
    if (response.ok) {
      const target = await response.json();
      const connection = await Connection.open(target.webSocketDebuggerUrl);
      await connection.send('Page.enable');
      await connection.send('Runtime.enable');
      await waitReady(connection);
      return connection;
    }
    await sleep(200);
  }
  throw new Error(`could not open a second tab on port ${port}`);
}

async function main() {
  const chrome = findChrome();
  if (chrome === undefined) {
    // A suite that skipped is a suite that measured nothing, and the exit status is the only honest
    // signal a CI job can read. Exit 2 rather than 1: a missing browser is not a failing product.
    console.error('no Chromium found: set CORTEX_CHROME to one, or install playwright browsers');
    process.exitCode = 2;
    return;
  }

  const { server, origin } = await serveDist();
  const profile = mkdtempSync(join(tmpdir(), 'cortex-two-tab-'));
  const debugPort = 9900 + Math.floor(Math.random() * 90);
  const launched = await launch({ chrome, profile, port: debugPort });
  const checks = [];
  try {
    // `launch` hands back a target on `about:blank`; the origin is what makes two tabs share storage, so
    // the first tab is navigated before anything is measured.
    await launched.connection.send('Page.navigate', { url: `${origin}/` });
    await waitReady(launched.connection);
  } catch (error) {
    await launched.close();
    server.close();
    throw error;
  }

  const check = (name, ok, detail) => {
    checks.push({ name, ok: ok === true, detail });
    console.log(
      `${ok === true ? 'ok  ' : 'FAIL'} ${name}${ok === true ? '' : ` -- ${JSON.stringify(detail)}`}`,
    );
  };

  try {
    const run = (connection, request) =>
      connection.evaluate(`window.__run(${JSON.stringify(request)})`);

    // 1. The first tab takes the origin.
    const first = await run(launched.connection, {
      mode: 'two-tab',
      onSecondTab: 'refuse',
      keep: true,
      slot: 'first',
      write: { key: 'marker', value: 42 },
    });
    check(
      'tab 1 opens OPFS and claims the origin',
      first.ok === true &&
        first.tier === 'opfs' &&
        first.writer?.acquired === true &&
        first.writer?.mechanism === 'web-locks',
      first,
    );
    check('tab 1 wrote the row a later tab must find', first.wrote === 'marker', first);

    // 2. A second tab, same profile, same origin, is refused.
    const second = await openTab(debugPort, origin);
    const refused = await run(second, { mode: 'two-tab', onSecondTab: 'refuse' });
    check(
      'tab 2 is refused by name, on the claim',
      refused.ok === false &&
        refused.name === 'BrowserStorageBusy' &&
        refused.pool === 'cortex' &&
        refused.mechanism === 'web-locks',
      refused,
    );
    check(
      'the refusal names the pool and the option that changes it',
      typeof refused.message === 'string' &&
        refused.message.includes('"cortex"') &&
        refused.message.includes('onSecondTab'),
      refused.message,
    );

    // 3. A second tab that is allowed to open gets a second database, and says so.
    const shared = await run(second, { mode: 'two-tab', onSecondTab: 'allow', read: 'marker' });
    check(
      'tab 2 with `allow` proceeds and reports a shared origin',
      shared.ok === true && shared.writer?.acquired === false,
      shared,
    );
    // The measurement, not a warning: whether the allowed tab sees the first tab's row. A product that
    // let a second tab through without this being false would have no reason for the refusal at all.
    check(
      'the allowed tab does not see the first tab row, which is the divergence',
      shared.read === null,
      { read: shared.read, tier: shared.tier },
    );

    // 4. Close the first tab, then retry in the second. One database, again.
    const closed = await run(launched.connection, { mode: 'close-held', slot: 'first' });
    check('tab 1 releases the origin on close', closed.closed === true, closed);
    // The SAH pool releases its access handles asynchronously, which is what the worker's retry exists
    // for; a few hundred milliseconds is the same budget the restart suite grants.
    await sleep(300);
    const reopened = await run(second, { mode: 'two-tab', onSecondTab: 'refuse', read: 'marker' });
    check(
      'tab 2 then opens OPFS and reads tab 1 row',
      reopened.ok === true &&
        reopened.tier === 'opfs' &&
        reopened.writer?.acquired === true &&
        reopened.read?.v === 42,
      reopened,
    );

    second.close();
  } finally {
    await launched.close();
    server.close();
  }

  const passed = checks.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${checks.length} two-tab checks passed`);
  writeFileSync(
    RESULTS,
    `${JSON.stringify(
      {
        engine: 'chromium',
        checks,
        passed,
        total: checks.length,
        note:
          'One run. `tier` and `read` are the facts; timings are not recorded because nothing here ' +
          'depends on them. The second-tab claim cannot be measured on Firefox: its BiDi build cannot ' +
          'create a second browsing context.',
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${RESULTS}`);
  if (passed !== checks.length) process.exitCode = 1;
  if (process.argv.includes('--check')) {
    const agreed = compareWithCommitted(checks, passed);
    if (!agreed) process.exitCode = 1;
  }
}

/**
 * Whether a fresh run agrees with the committed reading, check by check.
 *
 * ## Why the comparator lives in the probe
 *
 * `tools/browser-reading-check.mjs` compares the three *arm* readings by their tier and digest. This
 * artefact is a list of named checks with a verdict, which is a different shape, and a comparator that
 * handled both would be a comparator with a switch in it. What the two share is the rule: a committed
 * reading is only evidence if something re-derives it and says so, so a run that disagrees must fail.
 *
 * Order is compared too. These checks are a sequence -- the refusal, the allowed open, the release, the
 * retry -- and a reordering would mean the flow changed while every verdict stayed green.
 */
function compareWithCommitted(fresh, passedCount) {
  // Named on the command line by the workflow that re-derives it, so the step and the reading are tied
  // together in the one place a reader looks -- the same rule the other three readings follow through
  // `tools/browser-reading-check.mjs --committed`.
  // Relative to the repository root rather than the working directory: `pnpm --filter` runs a package
  // script with the package as its cwd, so a path a workflow writes from the root would otherwise resolve
  // twice -- which it did, and the failure was "no committed reading at packages/packages/...".
  const flag = process.argv.indexOf('--committed');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  const committedPath =
    named === undefined ? join(HERE, 'two-tab-run.json') : resolve(REPO_ROOT, named);
  if (!existsSync(committedPath)) {
    console.error(`FAIL no committed reading at ${committedPath}`);
    return false;
  }
  const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
  const before = committed.checks ?? [];
  const differences = [];
  if (before.length !== fresh.length)
    differences.push(`${before.length} checks against ${fresh.length}`);
  for (let index = 0; index < Math.min(before.length, fresh.length); index += 1) {
    const one = before[index];
    const two = fresh[index];
    if (one.name !== two.name)
      differences.push(`#${index + 1} is named "${one.name}", fresh "${two.name}"`);
    if (one.ok !== two.ok)
      differences.push(`#${index + 1} "${one.name}" was ${one.ok}, fresh ${two.ok}`);
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

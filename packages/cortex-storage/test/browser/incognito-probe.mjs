/**
 * A private window, in a real Chromium: what the product does where the browser promises to forget.
 *
 * ## What only this run can answer
 *
 * Every other browser reading this repository holds is taken in the **default** browser context. A private
 * window is a different storage partition -- the browser's own promise is that it is empty when it opens
 * and gone when it closes -- and the two things a caller depends on there are not the same two things that
 * matter elsewhere:
 *
 *   1. **The product must open.** A private window is not a degraded platform, so a second-tier fallback
 *      here would mean users in a private window silently get a different database. The reading names the
 *      tier instead of assuming it.
 *   2. **The claim must still be a claim.** The single-writer claim (`writer-claim.ts`) is what stops two
 *      tabs from creating two databases. If `navigator.locks` were absent in a private window, the claim
 *      would fall to its unnamed mechanism or to nothing, and the protection would be missing exactly where
 *      a user is most likely to open a second tab by accident. A mechanism that exists in one context and
 *      silently does not in another is the shape this repository keeps finding: present, and unread.
 *
 * ## The checks, registered before the code
 *
 * The order is the scenario, and every check is a reading rather than a restatement of the product's
 * intent:
 *
 *   1. default context: opens on OPFS, holds the claim via Web Locks, writes `privacy = 1`;
 *   2. private context: `navigator.locks.request` and `navigator.storage.getDirectory` both exist;
 *   3. private context: opens on OPFS and **acquires** the claim -- two partitions do not see each other's
 *      locks, so a private window is not refused because a normal window is open;
 *   4. private context: reads `null` where the default context wrote `1` -- the partition is separate;
 *   5. private context: writes `privacy = 2` and reads its own row back;
 *   6. default context: still reads `1` -- the private write did not land in it;
 *   7. a second target **inside the same private context**: refused by name, `BrowserStorageBusy`;
 *   8. the private context is disposed and a new one opened: `privacy` is `null` again -- the browser
 *      forgot, which is the promise that makes a private window a private window;
 *   9. default context: still reads `1` after all of the above;
 *  10. the default context's writer closes and a fresh target opens: still reads `1`, which is where the
 *      claim's release is observed -- without it, "released" and "still held forever" look the same.
 *
 * ## Why the third reading is the one worth the dispatch
 *
 * Checks 1 and 3 together say the claim is *partition-scoped*: the same origin, the same pool name, two
 * contexts, both acquired. That is not a detail -- it is the reason a private window cannot be used to
 * steal a database the normal window is writing, and the reason a normal window cannot be used to keep a
 * private one out. Neither is documented by the platform in a form a test can assert; both are measurable.
 *
 * ## Usage
 *
 *   node test/browser/incognito-probe.mjs
 *   node test/browser/incognito-probe.mjs --check --committed packages/cortex-storage/test/browser/incognito-run.json
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchBrowser, waitReady } from './cdp.mjs';
import { agreeWithCommitted, collector } from './committed.mjs';
import { serveDist } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
// Its own variable, like the other three: a shared `CORTEX_RESULTS` would make one probe overwrite
// another's reading, and the overwrite would look like agreement.
const RESULTS =
  process.env.CORTEX_RESULTS_INCOGNITO ?? join(PACKAGE, 'test', 'browser', 'incognito-run.json');

/** The table the two-tab page writes under; the held-connection mode takes it as an argument. */
const TABLE = 'two-tabs';

async function main() {
  const chrome = findChrome();
  if (chrome === undefined) {
    // 2 rather than 1: a missing browser is not a failing product, and the exit status is the only signal
    // CI can read. A suite that skipped measured nothing.
    console.error('no Chromium found: set CORTEX_CHROME to one, or install playwright browsers');
    process.exitCode = 2;
    return;
  }

  const { server, origin } = await serveDist();
  const profile = mkdtempSync(join(tmpdir(), 'cortex-incognito-'));
  const debugPort = 9980 + Math.floor(Math.random() * 15);
  const browser = await launchBrowser({ chrome, profile, port: debugPort });
  const probe = collector();
  const { check } = probe;

  const open = async (contextId) => {
    const page = await browser.openPage(`${origin}/`, contextId);
    await waitReady(page);
    return page;
  };
  const run = (page, request) => page.evaluate(`window.__run(${JSON.stringify(request)})`);
  // The slot is the connection to work on: `held` is per page, so a read that forgot it would answer
  // "nothing-held" and look like a missing row.
  const held = (page, slot, request) => run(page, { mode: 'held', table: TABLE, slot, ...request });

  try {
    // 1. The default context takes the origin and writes the row the private window must not see.
    const normal = await open(undefined);
    const first = await run(normal, {
      mode: 'two-tab',
      slot: 'normal',
      keep: true,
      write: { key: 'privacy', value: 1 },
    });
    check(
      'the default context opens on OPFS and holds the claim',
      first.ok === true &&
        first.tier === 'opfs' &&
        first.writer?.acquired === true &&
        first.writer?.mechanism === 'web-locks',
      first,
    );

    const contextId = await browser.createContext();
    const privatePage = await open(contextId);

    // 2. The two facilities the product depends on, present in the partition the browser forgets.
    const facilities = await privatePage.evaluate(
      `({ locks: typeof navigator.locks?.request === 'function', opfs: typeof navigator.storage?.getDirectory === 'function' })`,
    );
    check(
      'a private window has Web Locks and an origin directory',
      facilities.locks === true && facilities.opfs === true,
      facilities,
    );

    // 3. Both contexts claim the same pool name and both acquire it: the claim is partition-scoped.
    const opened = await run(privatePage, {
      mode: 'two-tab',
      slot: 'private',
      keep: true,
    });
    check(
      'the private window opens on OPFS and acquires the same pool name the other context holds',
      opened.ok === true &&
        opened.tier === 'opfs' &&
        opened.writer?.acquired === true &&
        opened.writer?.pool === first.writer?.pool,
      opened,
    );

    // 4. The row the default context wrote is not there.
    const unseen = await held(privatePage, 'private', { read: 'privacy' });
    check(
      'the private window cannot see the row the default context wrote',
      unseen.read === null,
      unseen,
    );

    // 5. Its own row lands and comes back.
    const own = await held(privatePage, 'private', {
      write: { key: 'privacy', value: 2 },
      read: 'privacy',
    });
    check(
      'the private window writes and reads back its own row',
      own.wrote === 'privacy' && own.read?.v === 2,
      own,
    );

    // 6. Nothing leaked the other way.
    const normalAfter = await held(normal, 'normal', { read: 'privacy' });
    check(
      'the default context still reads its own row, untouched',
      normalAfter.read?.v === 1,
      normalAfter,
    );

    // 7. A second tab inside the private context is refused -- the claim is not merely present, it acts.
    const secondTab = await open(contextId);
    const refused = await run(secondTab, { mode: 'two-tab', slot: 'private-second' });
    check(
      'a second tab in the same private window is refused by name',
      refused.ok === false && refused.name === 'BrowserStorageBusy' && refused.mechanism === 'web-locks',
      refused,
    );

    // 8. The browser forgets: a new private context starts empty.
    await browser.disposeContext(contextId);
    const nextContext = await browser.createContext();
    const afterDispose = await open(nextContext);
    const forgotten = await run(afterDispose, { mode: 'two-tab', slot: 'private-again', read: 'privacy' });
    check(
      'a new private window starts empty: the previous one took its row with it',
      forgotten.ok === true && forgotten.read === null,
      forgotten,
    );

    // 9. The default context survived the whole episode.
    const survived = await held(normal, 'normal', { read: 'privacy' });
    check('the default context still holds its row at the end', survived.read?.v === 1, survived);

    // 10. Its writer closes and a fresh target reopens: the claim was released, and the row persisted.
    const closed = await run(normal, { mode: 'close-held', slot: 'normal' });
    const reopened = await run(await open(undefined), {
      mode: 'two-tab',
      slot: 'normal-again',
      read: 'privacy',
    });
    check(
      'after the writer closes, a fresh tab opens and still reads the row',
      closed.closed === true && reopened.ok === true && reopened.read?.v === 1,
      { closed, reopened },
    );
  } finally {
    await browser.close();
    server.close();
  }

  const { checks, passed } = probe;
  console.log(`\n${passed}/${checks.length} private-window checks passed`);
  writeFileSync(
    RESULTS,
    `${JSON.stringify(
      {
        engine: 'chromium',
        checks,
        passed,
        total: checks.length,
        note:
          'One profile, one origin, two browser contexts: the default one and one created with ' +
          'Target.createBrowserContext (which a page-level session is refused: "Not allowed", measured ' +
          'before this file was written). Timings are not recorded because nothing here depends on them. ' +
          'The private context is disposed before check 8, so "forgotten" is a reading about the browser ' +
          'and not about the product: the product stores what the platform gives it.',
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${RESULTS}`);
  if (passed !== checks.length) process.exitCode = 1;
  if (process.argv.includes('--check')) {
    if (!agreeWithCommitted({ checks, passed, resultsPath: RESULTS, fallback: 'incognito-run.json' })) {
      process.exitCode = 1;
    }
  }
}

await main();

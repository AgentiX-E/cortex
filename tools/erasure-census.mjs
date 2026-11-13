#!/usr/bin/env node
/**
 * Erasure, measured at the layer that decides whether it is true: what is still in the store.
 *
 * ## Why this is a tool and not only a test
 *
 * The unit tests assert the protocol; the acceptance matrix can only read a number in a file. The
 * number here is not "the delete returned" -- that is the reading every product has, and
 * AfterDeleteBench (`arXiv:2610.31366`) exists to show it means nothing: they recover a deleted
 * secret in 68% of cases because a derived copy survived the row. So the measurement is taken over
 * **every row of every table in both stores**, serialised and searched, before and after.
 *
 * The `before` reading is not decoration. `after === 0` passes when the search is broken -- an empty
 * table list, a mistyped store, a serialiser that skips the field that matters -- so a run whose
 * `before` is zero is reported as a failure rather than as a clean erasure. That is the control arm
 * AfterDeleteBench pairs with every exposed agent, applied to the instrument instead of to the model.
 *
 * ## What is measured, exactly
 *
 * Two sentences, each with a different lineage:
 *
 * | id | how it moved | copies after acceptance |
 * | --- | --- | --- |
 * | `s1` | deferred, then accepted | shared fact, card (text + the turn around it) |
 * | `h1` | rule-claimed private, then released | shared fact, release record (wording + digest) |
 *
 * Both are then erased with one call each. The readings are: occurrences of each sentence per
 * surface, the number of read paths that still return a sentence, and the rows each erasure removed.
 *
 * ## What it does not measure
 *
 * Bytes on disk are `sqlite`'s business and are asserted in `disclosure-erasure.test.ts` (the
 * `secure_delete` pragma). A model's weights, a provider's request log and a transcript pasted
 * somewhere else are outside this store, and AfterDeleteBench separates exactly those from
 * reconstruction. This counts what the product owns.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, '../cortex-docs/evidence/erasure/census.json');

const { ERASURE_TOKEN, RELEASE_TOKEN } = await import(join(REPO, 'packages/cortex-core/dist/index.js'));
const { DisclosureSession } = await import(
  join(REPO, 'packages/cortex-memory/dist/disclosure/session.js')
);
const { SqliteStorage } = await import(join(REPO, 'packages/cortex-storage/dist/storage/sqlite.js'));

const NOW = 1_759_470_000_000;

/** The two sentences. Distinctive enough that a substring hit is the sentence and not a word. */
const SECRET = 'Falcon is the code name for the Helix Bio acquisition.';
const HEALTH = 'I have been diagnosed with a condition I have not told anyone at work about.';

/** The four surfaces the product can write a sentence to, plus the record that must hold none. */
const SURFACES = [
  { role: 'private-facts', scope: 'private', table: 'facts' },
  { role: 'shared-facts', scope: 'shared', table: 'facts' },
  { role: 'cards', scope: 'private', table: 'cards' },
  { role: 'releases', scope: 'private', table: 'releases' },
  { role: 'erasures', scope: 'private', table: 'erasures' },
];

function occurrences(haystack, needle) {
  const hay = haystack.toLowerCase();
  const pin = needle.toLowerCase();
  let hits = 0;
  let at = hay.indexOf(pin);
  while (at !== -1) {
    hits += 1;
    at = hay.indexOf(pin, at + pin.length);
  }
  return hits;
}

/** Every row of every surface, serialised. Generic on purpose: an unknown field still counts. */
async function residue(stores) {
  const readings = [];
  for (const surface of SURFACES) {
    const store = surface.scope === 'private' ? stores.private : stores.shared;
    const rows = await store.query(surface.table);
    const text = JSON.stringify(rows);
    readings.push({
      role: surface.role,
      rows: rows.length,
      secret: occurrences(text, 'Falcon'),
      health: occurrences(text, 'diagnosed'),
    });
  }
  return readings;
}

const dir = mkdtempSync(join(tmpdir(), 'cortex-erasure-census-'));
const privateStore = new SqliteStorage({ filename: join(dir, 'private.db') });
const sharedStore = new SqliteStorage({ filename: join(dir, 'shared.db') });
const stores = { private: privateStore, shared: sharedStore };
const session = new DisclosureSession({ private: privateStore, shared: sharedStore, now: () => NOW });

await session.say(SECRET, { id: 's1' });
await session.accept('s1');
await session.say(HEALTH, { id: 'h1' });
await session.release('h1', { acknowledge: RELEASE_TOKEN });

const before = await residue(stores);
const beforePaths = {
  privateEvidence: (await session.evidence('private')).some((row) =>
    JSON.stringify(row.value).includes('Falcon'),
  ),
  sharedEvidence: (await session.evidence('shared')).some((row) =>
    JSON.stringify(row.value).includes('Falcon'),
  ),
  export: (await session.export()).includes('Falcon'),
  releaseWording: (await session.releases()).some((record) => record.text?.includes('diagnosed')),
};

// A deliberate fault, so the guards below can be shown to fire rather than assumed to. `test_erasure_census.py`
// runs this tool twice: once clean, once with this set, and asserts one exit code each. A gate nobody has
// seen fail is a gate that may be evaluating nothing.
const FAULT = process.env['CORTEX_ERASURE_CENSUS_FAULT'];
const erasedSecret =
  FAULT === 'no-forget'
    ? { record: { removed: { facts: 0, cards: 0, releases: 0 } } }
    : await session.forget('s1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });
const erasedHealth = await session.forget('h1', {
  acknowledge: ERASURE_TOKEN,
  reason: 'retention-policy',
});

const after = await residue(stores);
const afterPaths = {
  privateEvidence: (await session.evidence('private')).some((row) =>
    JSON.stringify(row.value).includes('Falcon'),
  ),
  sharedEvidence: (await session.evidence('shared')).some((row) =>
    JSON.stringify(row.value).includes('Falcon'),
  ),
  export: (await session.export()).includes('Falcon'),
  releaseWording: (await session.releases()).some((record) => record.text?.includes('diagnosed')),
};

await privateStore.close();
await sharedStore.close();
rmSync(dir, { recursive: true, force: true });

const sum = (readings, key) => readings.reduce((total, reading) => total + reading[key], 0);
const leaking = (paths) => Object.values(paths).filter(Boolean).length;

const census = {
  $comment:
    'Written by tools/erasure-census.mjs. One DisclosureSession over two SQLite files, two sentences ' +
    'with different lineage (a deferred card, a released rule-claimed row), erased with one call ' +
    'each. `residue` reads every row of every surface and counts occurrences of the sentence, so a ' +
    'field nobody thought of fails the criterion rather than escaping it. `before` is the control: a ' +
    'run whose control finds nothing is reported as a failure, not as a clean erasure.',
  dataset: 'synthetic: 2 sentences, 2 erasure calls, 5 surfaces, 2 stores',
  sentences: { deferred: 's1', released: 'h1' },
  before: { surfaces: before, occurrences: sum(before, 'secret') + sum(before, 'health'), readPaths: beforePaths },
  after: { surfaces: after, occurrences: sum(after, 'secret') + sum(after, 'health'), readPaths: afterPaths },
  removed: {
    deferred: erasedSecret.record.removed,
    released: erasedHealth.record.removed,
    total:
      erasedSecret.record.removed.facts +
      erasedSecret.record.removed.cards +
      erasedSecret.record.removed.releases +
      erasedHealth.record.removed.facts +
      erasedHealth.record.removed.cards +
      erasedHealth.record.removed.releases,
  },
  // The two readings the matrix gates on. Numbers, because "identical" is a 1 or a defect.
  residualOccurrences: sum(after, 'secret') + sum(after, 'health'),
  leakingReadPaths: leaking(afterPaths),
  controlOccurrences: sum(before, 'secret') + sum(before, 'health'),
  controlReadPaths: leaking(beforePaths),
  tombstones: after.find((reading) => reading.role === 'cards').rows,
  records: after.find((reading) => reading.role === 'erasures').rows,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(census, null, 2)}\n`);

// Two vacuity guards, in the tool rather than in the reader. A control that found nothing means the
// instrument is broken; a non-zero residual means the erasure is. Both make the run a failure rather
// than a number somebody has to interpret.
if (census.controlOccurrences === 0 || census.controlReadPaths === 0) {
  console.error(
    'FAILED: the control found nothing before the erasure, so "nothing after" is a statement about ' +
      'the search rather than about the deletion',
  );
  process.exitCode = 1;
} else if (census.residualOccurrences !== 0 || census.leakingReadPaths !== 0) {
  console.error(
    `FAILED: ${String(census.residualOccurrences)} occurrence(s) survived and ${String(
      census.leakingReadPaths,
    )} read path(s) still return it -- see ${OUT}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `erasure census ok -- ${String(census.controlOccurrences)} occurrence(s) and ` +
      `${String(census.controlReadPaths)} read path(s) before, ${String(census.residualOccurrences)} ` +
      `and ${String(census.leakingReadPaths)} after; ${String(census.removed.total)} row(s) removed by ` +
      `${String(census.tombstones)} tombstone and ${String(census.records)} record(s)`,
  );
}

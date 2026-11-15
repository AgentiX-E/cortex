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
 * ## Why there are eight surfaces and not four
 *
 * Four tables were the enumeration this repository shipped, and it was right about the tables. It was
 * wrong about the **cache**: an embedding store addressed by text is a seventh copy, and until this
 * round it had no `delete` at all, so `forget()` emptied the four tables and left a vector that
 * answered `get(keyOf(text)) !== undefined` for the erased sentence. Two surfaces were missing, and
 * they are different in kind from the four:
 *
 * | surface | what a leak looks like | how it is read |
 * | --- | --- | --- |
 * | `embedding-keys` | the key **is** the sentence | occurrences of the wording in the key strings |
 * | `embedding-vectors` | the store still answers "was this stored?" | entries addressing a sentence |
 *
 * The key surface reads zero **before** the erasure as well, which is the design rather than a broken
 * instrument: a key is `sha256(text)`, so it never held the wording to begin with. What makes that
 * reading non-vacuous is its own guard -- entries must exist before the erasure, or nothing was ever
 * cached and "no wording in the keys" is a statement about an empty list.
 *
 * ## And the eighth, which the product created for itself
 *
 * A memory that stores what it was told keeps the sentence again, in a `Corpus` row addressed by
 * `(sessionId, ordinal)`. That copy is invisible to the boundary unless the boundary is handed the
 * corpus, and a session constructed over two stores and a cache with no corpus erases everything it can
 * name and leaves the transcript readable -- which is why `no-turn-forget` exists as a fault and why it
 * is the shape of the last two rounds rather than a contrivance.
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

const { ERASURE_TOKEN, RELEASE_TOKEN, EmbeddingMemo } = await import(
  join(REPO, 'packages/cortex-core/dist/index.js')
);
const { DisclosureSession } = await import(
  join(REPO, 'packages/cortex-memory/dist/disclosure/session.js')
);
const { Corpus } = await import(join(REPO, 'packages/cortex-memory/dist/corpus.js'));
const { SqliteStorage } = await import(
  join(REPO, 'packages/cortex-storage/dist/storage/sqlite.js')
);

const NOW = 1_759_470_000_000;

/** The two sentences. Distinctive enough that a substring hit is the sentence and not a word. */
const SECRET = 'Falcon is the code name for the Helix Bio acquisition.';
const HEALTH = 'I have been diagnosed with a condition I have not told anyone at work about.';

/** A third sentence, never erased. The control on the cache: an erasure that cleared it would pass. */
const UNRELATED = 'The invoice for the bicycle repair was paid late again.';

/**
 * Every surface a sentence can survive on, seven of them.
 *
 * `kind` is what decides how a surface is read, and it is a property of the surface rather than of the
 * reading code: a table is searched as text, a key list is searched as text *and* expected to hold none
 * of it, and a vector store is asked whether it addresses the sentence at all.
 */
const SURFACES = [
  { role: 'private-facts', kind: 'row', scope: 'private', table: 'facts' },
  { role: 'shared-facts', kind: 'row', scope: 'shared', table: 'facts' },
  { role: 'cards', kind: 'row', scope: 'private', table: 'cards' },
  { role: 'releases', kind: 'row', scope: 'private', table: 'releases' },
  { role: 'erasures', kind: 'row', scope: 'private', table: 'erasures' },
  // The transcript. Two tables, read together: `corpus.turn` holds the wording and `corpus.session` holds
  // the ordinals that place it, and a leak in either one is a leak about the sentence.
  { role: 'corpus-turns', kind: 'corpus', tables: ['corpus.turn', 'corpus.session'] },
  { role: 'embedding-keys', kind: 'keys' },
  { role: 'embedding-vectors', kind: 'vectors' },
];

/**
 * A vector store the census can enumerate.
 *
 * The product's interface refuses iteration on purpose -- a store that could be listed would invite an
 * eviction policy, and a policy is a behavioural difference between two runs of one configuration. The
 * instrument is allowed to enumerate because the instrument is not a product: "which keys does this
 * store hold" *is* the measurement, and a store that could not answer it would leave the key surface
 * unmeasurable while still being a surface.
 */
class RecordingStore {
  #vectors = new Map();

  get(key) {
    return this.#vectors.get(key);
  }

  set(key, vector) {
    this.#vectors.set(key, vector);
  }

  delete(key) {
    return this.#vectors.delete(key);
  }

  size() {
    return this.#vectors.size;
  }

  keys() {
    return [...this.#vectors.keys()];
  }
}

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

const dir = mkdtempSync(join(tmpdir(), 'cortex-erasure-census-'));
const privateStore = new SqliteStorage({ filename: join(dir, 'private.db') });
const sharedStore = new SqliteStorage({ filename: join(dir, 'shared.db') });
const stores = { private: privateStore, shared: sharedStore };

/** The cache under test. A stub embedder: this file measures erasure, not vector quality. */
const vectorStore = new RecordingStore();
const vectors = new EmbeddingMemo((texts) => Promise.resolve(texts.map(() => [0, 0, 0])), {
  store: vectorStore,
  fingerprint: 'census/stub/3',
});

/**
 * A deliberate fault, so the guards below can be shown to fire rather than assumed to.
 * `test_erasure_census.py` runs this tool once per fault and asserts one exit code each. A gate nobody
 * has seen fail is a gate that may be evaluating nothing.
 *
 * `no-vector-forget` is the fault that matters most here: it is not a contrivance, it is **the
 * configuration this product shipped until this round** -- a session over two stores and no eraser.
 */
const FAULT = process.env['CORTEX_ERASURE_CENSUS_FAULT'];
const corpusStore = new SqliteStorage({ filename: join(dir, 'corpus.db') });
const corpus = new Corpus({ store: corpusStore, now: NOW });
const session = new DisclosureSession({
  private: privateStore,
  shared: sharedStore,
  now: () => NOW,
  ...(FAULT === 'no-vector-forget' ? {} : { vectors }),
  // `no-turn-forget` is the fault that models a composition mistake rather than a missing method: the
  // corpus exists, the session is built over the same deployment, and nobody passes the object across. That
  // is what `full` looked like before this round, and every count would have said the erasure was complete.
  ...(FAULT === 'no-turn-forget' ? {} : { turns: corpus }),
});

await session.say(SECRET, { id: 's1' });
await session.accept('s1');
await session.say(HEALTH, { id: 'h1' });
await session.release('h1', { acknowledge: RELEASE_TOKEN });

// What a retrieval index would have embedded: the two sentences and one that must survive. The store is
// primed *after* the rows exist and *before* the control is read, because the control has to see the
// copy it is meant to detect.
await vectors.embed([SECRET, HEALTH, UNRELATED]);
// The transcript, holding the same two sentences plus the survivor. Written through `append` rather than
// through the session, because a corpus is what the caller brought: the erasure's job is to reach it, not to
// have produced it.
await corpus.append([
  { sessionId: 's1', ordinal: 0, text: SECRET },
  { sessionId: 'h1', ordinal: 0, text: HEALTH },
  { sessionId: 'u1', ordinal: 0, text: UNRELATED },
]);

/** Every surface, read as its kind requires. */
async function residue() {
  const readings = [];
  for (const surface of SURFACES) {
    if (surface.kind === 'keys') {
      const keys = vectorStore.keys().join('\n');
      readings.push({
        role: surface.role,
        rows: vectorStore.size(),
        secret: occurrences(keys, 'Falcon'),
        health: occurrences(keys, 'diagnosed'),
      });
      continue;
    }
    if (surface.kind === 'vectors') {
      readings.push({
        role: surface.role,
        rows: vectors.held([SECRET, HEALTH]),
        secret: vectors.held([SECRET]),
        health: vectors.held([HEALTH]),
      });
      continue;
    }
    if (surface.kind === 'corpus') {
      const rows = [];
      for (const table of surface.tables) rows.push(...(await corpusStore.query(table)));
      const text = JSON.stringify(rows);
      readings.push({
        role: surface.role,
        rows: rows.length,
        secret: occurrences(text, 'Falcon'),
        health: occurrences(text, 'diagnosed'),
      });
      continue;
    }
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

const before = await residue();
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

const erasedSecret =
  FAULT === 'no-forget'
    ? { record: { removed: { facts: 0, cards: 0, releases: 0, vectors: 0 } } }
    : await session.forget('s1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });
const erasedHealth = await session.forget('h1', {
  acknowledge: ERASURE_TOKEN,
  reason: 'retention-policy',
});

const after = await residue();
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

// Read before the stores close: a control taken afterwards would be a control taken of a closed file, and
// the error would name the store rather than the erasure.
const survivorTurns = await corpus.held([UNRELATED]);
await privateStore.close();
await sharedStore.close();
await corpusStore.close();
rmSync(dir, { recursive: true, force: true });

const sum = (readings, key) => readings.reduce((total, reading) => total + reading[key], 0);
const leaking = (paths) => Object.values(paths).filter(Boolean).length;
const surfaceOf = (readings, role) => readings.find((reading) => reading.role === role);

const census = {
  $comment:
    'Written by tools/erasure-census.mjs. One DisclosureSession over two SQLite files and one vector ' +
    'store, two sentences with different lineage (a deferred card, a released rule-claimed row), erased ' +
    'with one call each. `residue` reads all seven surfaces -- five tables, the cache key list and the ' +
    'cache entries -- and counts what still answers about each sentence, so a field nobody thought of ' +
    'fails the criterion rather than escaping it. `before` is the control: a run whose control finds ' +
    'nothing is reported as a failure, not as a clean erasure.',
  dataset: 'synthetic: 2 sentences + 1 survivor, 2 erasure calls, 7 surfaces, 2 stores, 1 cache',
  sentences: { deferred: 's1', released: 'h1', survivor: 'unrelated' },
  surfaces: SURFACES.length,
  before: {
    surfaces: before,
    occurrences: sum(before, 'secret') + sum(before, 'health'),
    readPaths: beforePaths,
  },
  after: {
    surfaces: after,
    occurrences: sum(after, 'secret') + sum(after, 'health'),
    readPaths: afterPaths,
  },
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
    vectors: erasedSecret.record.removed.vectors + erasedHealth.record.removed.vectors,
    turns: (erasedSecret.record.removed.turns ?? 0) + (erasedHealth.record.removed.turns ?? 0),
  },
  // The two readings the matrix gates on. Numbers, because "identical" is a 1 or a defect.
  residualOccurrences: sum(after, 'secret') + sum(after, 'health'),
  leakingReadPaths: leaking(afterPaths),
  controlOccurrences: sum(before, 'secret') + sum(before, 'health'),
  controlReadPaths: leaking(beforePaths),
  // The key surface is read as a design property rather than as a before/after count: it must hold no
  // wording in either arm, and the guard below refuses a run where it held nothing at all.
  keySurface: {
    rowsBefore: surfaceOf(before, 'embedding-keys').rows,
    wordingBefore:
      surfaceOf(before, 'embedding-keys').secret + surfaceOf(before, 'embedding-keys').health,
    wordingAfter:
      surfaceOf(after, 'embedding-keys').secret + surfaceOf(after, 'embedding-keys').health,
  },
  survivor: {
    cached: vectors.held([UNRELATED]),
    // The corpus control, taken through the corpus rather than by counting rows: an erasure that emptied the
    // transcript would satisfy every zero above.
    turns: survivorTurns,
  },
  tombstones: surfaceOf(after, 'cards').rows,
  records: surfaceOf(after, 'erasures').rows,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(census, null, 2)}\n`);

// Three vacuity guards, in the tool rather than in the reader. A control that found nothing means the
// instrument is broken; a non-zero residual means the erasure is; a key list holding wording means the key
// composition regressed. Each makes the run a failure rather than a number somebody has to interpret.
if (census.controlOccurrences === 0 || census.controlReadPaths === 0) {
  console.error(
    'FAILED: the control found nothing before the erasure, so "nothing after" is a statement about ' +
      'the search rather than about the deletion',
  );
  process.exitCode = 1;
} else if (census.keySurface.rowsBefore === 0) {
  console.error(
    'FAILED: the cache held no entries before the erasure, so "no wording in the keys" is a statement ' +
      'about an empty list rather than about the key composition',
  );
  process.exitCode = 1;
} else if (census.keySurface.wordingBefore !== 0 || census.keySurface.wordingAfter !== 0) {
  console.error(
    `FAILED: ${String(census.keySurface.wordingBefore)} key(s) carried the wording before the erasure ` +
      `and ${String(census.keySurface.wordingAfter)} after -- a cache key must be a digest of the text`,
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
    `erasure census ok -- ${String(census.surfaces)} surfaces; ${String(census.controlOccurrences)} ` +
      `occurrence(s) and ${String(census.controlReadPaths)} read path(s) before, ` +
      `${String(census.residualOccurrences)} and ${String(census.leakingReadPaths)} after; ` +
      `${String(census.removed.total)} row(s), ${String(census.removed.vectors)} vector(s) and ` +
      `${String(census.removed.turns)} turn(s) removed by ${String(census.tombstones)} tombstone and ` +
      `${String(census.records)} record(s); ${String(census.survivor.cached)} unrelated vector(s) and ` +
      `${String(census.survivor.turns)} unrelated turn(s) survived`,
  );
}

/**
 * Erasure through the session, against two real files, across a restart.
 *
 * ## Why this file exists separately from the core test
 *
 * `erasure.test.ts` proves the protocol against an in-memory store: the record's shape, the counts,
 * the tombstone, the token. What a map cannot show is that the answer is still true tomorrow. The
 * five things asserted here need a schema, a `del` that really removes a row, and a reopen:
 *
 * 1. every read path a person or a colleague has returns nothing afterwards,
 * 2. the tombstone and the record survive a close and reopen,
 * 3. the burned id is still burned after the restart -- the ban is a stored row, not a set in memory,
 * 4. the shared copy is gone, which is the one that matters, because it is the one somebody read,
 * 5. nothing in either file contains the wording, checked generically over every table.
 *
 * The last one is the acceptance criterion, and it is checked by serialising every row of every
 * surface rather than by asserting the fields this test happens to know about. See the core test's
 * module comment for why that distinction is the whole design.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ERASURE_TOKEN, RELEASE_TOKEN } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';
import { DisclosureSession } from '../disclosure/session.js';

const START = 1_700_000_000_000;

/** A deferral: no rule claims it, so it becomes a card and the card is a copy of the sentence. */
const SECRET = 'Falcon is the code name for the Helix Bio acquisition.';

/** Rule-claimed and private, so the only door out is `release`, which leaves a second copy. */
const HEALTH = 'I have been diagnosed with a condition I have not told anyone at work about.';

const open: { storage: SqliteStorage; dir: string }[] = [];

function stores(): {
  private: SqliteStorage;
  shared: SqliteStorage;
  dir: string;
  paths: [string, string];
} {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-erasure-'));
  const priv = new SqliteStorage({ filename: join(dir, 'private.db') });
  const shrd = new SqliteStorage({ filename: join(dir, 'shared.db') });
  open.push({ storage: priv, dir }, { storage: shrd, dir });
  return {
    private: priv,
    shared: shrd,
    dir,
    paths: [join(dir, 'private.db'), join(dir, 'shared.db')],
  };
}

function session(parts: { private: SqliteStorage; shared: SqliteStorage }) {
  return new DisclosureSession({
    private: parts.private,
    shared: parts.shared,
    now: () => START,
  });
}

/** Every row of every table the disclosure layer can write, as one string per store. */
async function everyRow(store: SqliteStorage, tables: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const table of tables) parts.push(JSON.stringify(await store.query(table)));
  return parts.join('\n');
}

const PRIVATE_TABLES = ['facts', 'cards', 'releases', 'erasures'] as const;
const SHARED_TABLES = ['facts'] as const;

function occurrences(haystack: string, needle: string): number {
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

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.storage.close().catch(() => undefined);
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe('erasing through the session', () => {
  it('closes every read path in both scopes, and keeps them closed after a restart', async () => {
    const parts = stores();
    const first = session(parts);

    await first.say(SECRET, { id: 's1' });
    await first.accept('s1');
    const health = await first.say(HEALTH, { id: 'h1' });
    expect(health.card).toBe(null);
    await first.release('h1', { acknowledge: RELEASE_TOKEN });

    // Positive control, taken before the erasure with the same function that reads afterwards: the
    // sentence is in the private store twice (card and fact) and in the shared store once, and the
    // health sentence is in the release record. A control that found nothing would make every
    // assertion below meaningless.
    expect(occurrences(await everyRow(parts.private, PRIVATE_TABLES), 'Falcon')).toBeGreaterThan(1);
    expect(occurrences(await everyRow(parts.shared, SHARED_TABLES), 'Falcon')).toBe(1);
    expect(occurrences(await everyRow(parts.private, PRIVATE_TABLES), 'diagnosed')).toBeGreaterThan(
      0,
    );

    const erasedCard = await first.forget('s1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });
    const erasedHealth = await first.forget('h1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'retention-policy',
    });
    expect(erasedCard.card?.state).toBe('forgotten');
    expect(erasedCard.record.removed).toEqual({ facts: 1, cards: 1, releases: 0 });
    expect(erasedHealth.record.removed).toEqual({ facts: 1, cards: 0, releases: 1 });

    // 1. The four read paths a person and a colleague actually use.
    expect(await first.evidence('shared')).toEqual([]);
    expect(await first.evidence('private')).toEqual([]);
    const exported = await first.export();
    expect(exported).toContain('1 forgotten');
    expect(exported).not.toContain('Falcon');
    const [releaseRecord] = await first.releases();
    expect(releaseRecord?.text).toBe(null);
    expect(releaseRecord?.rule).toBe('health');

    // 5. Every row of every table, which is the reading the matrix gates on.
    expect(await everyRow(parts.private, PRIVATE_TABLES)).not.toContain('Falcon');
    expect(await everyRow(parts.shared, SHARED_TABLES)).not.toContain('Falcon');
    expect(await everyRow(parts.private, PRIVATE_TABLES)).not.toContain('diagnosed');

    await parts.private.close();
    await parts.shared.close();

    // 2-4. A new session over the same two files.
    const reopened = {
      private: new SqliteStorage({ filename: parts.paths[0] }),
      shared: new SqliteStorage({ filename: parts.paths[1] }),
    };
    open.push(
      { storage: reopened.private, dir: parts.dir },
      { storage: reopened.shared, dir: parts.dir },
    );
    const second = session(reopened);

    expect((await second.cards()).map((card) => card.state)).toEqual(['forgotten']);
    // The clock is frozen at `START`, so both records tie on `requestedAt` and the id breaks it --
    // which is the point of the tie-break: two exports of one store have to be byte-identical.
    expect((await second.erasures()).map((record) => record.id)).toEqual(['h1', 's1']);
    expect((await second.erasures()).map((record) => record.reason)).toEqual([
      'retention-policy',
      'user-request',
    ]);
    expect(await second.evidence('shared')).toEqual([]);
    expect(await second.evidence('private')).toEqual([]);
    expect(await everyRow(reopened.private, PRIVATE_TABLES)).not.toContain('Falcon');
    expect(await everyRow(reopened.shared, SHARED_TABLES)).not.toContain('Falcon');

    // The ban is a row, not a set in memory: a reopened process refuses the same id.
    await expect(second.say(SECRET, { id: 's1' })).rejects.toThrow(/burned/);
    expect(await second.erasure('s1')).not.toBeUndefined();
  });

  it('leaves the file smaller than the row it removed, because nothing of it is kept', async () => {
    const parts = stores();
    const first = session(parts);
    // A long, unique sentence: if any copy of it survived -- in a tombstone, a record, an index --
    // the file would still have to hold it.
    const long = `Falcon is the code name for the Helix Bio acquisition, ${'and the data room is open. '.repeat(40)}`;
    await first.say(long, { id: 'big' });
    await first.forget('big', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });
    await parts.private.close();
    await parts.shared.close();

    // Read the bytes, not the rows: a store that kept the wording in a freelist page or a journal
    // would still be holding it, and no `query` would ever say so. SQLite's own `secure_delete` is
    // off by default, so this asserts what the *product* removed, not what the engine scrubs.
    const bytes = readFileSync(parts.paths[0]).toString('latin1');
    expect(bytes.includes('Helix Bio acquisition')).toBe(false);
  });
});

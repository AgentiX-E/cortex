/**
 * Erasure: one call, every copy, and a record that contains none of it.
 *
 * ## What this file is written against
 *
 * AfterDeleteBench (`arXiv:2610.31366`) measured the failure this is built to avoid: delete the source
 * record, ask the agent, recover the secret in **68%** of cases, because a *derived* copy survived.
 * Their result for the one defence that worked -- retiring the source and every descendant traced to
 * it -- is the shape of `CardQueue.forget`. So the tests here are not "does `del` delete": they are
 * "does anything that descends from this sentence still exist", and the assertion that answers it is
 * deliberately **generic**: every row of every surface is serialised and searched, so a field nobody
 * thought of fails the test instead of escaping it.
 *
 * That genericity is the point. A test that assert `card.text` is empty and `card.sourceText` is
 * undefined would pass against a tombstone that kept `card.origin.turns` -- which holds the sentences
 * around the erased one, and is exactly the reconstruction channel both papers describe. The dump
 * cannot be fooled that way, and it is the same dump the census artifact and the acceptance matrix
 * read.
 *
 * ## Why the positive control is not optional
 *
 * `expect(dump).not.toContain(secret)` passes trivially when the dump is broken -- an empty table, a
 * mistyped table name, a serialiser that drops the one field that matters. Every dump assertion below
 * is therefore paired with a `before` reading taken from the same function on the same state, which
 * must find the sentence at least once. A control that recovers nothing is not evidence of erasure;
 * it is evidence of a working control.
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../../__tests__/support/memory-storage.js';
import { FederatedStorage } from '../../federation/federated-storage.js';
import { ReadSideAssembler } from '../../federation/read-side.js';
import { CardQueue, type KnowledgeCard } from '../card.js';
import { ERASURE_TOKEN, ErasureLog, erasureSurfaces } from '../erasure.js';
import { RELEASE_TOKEN } from '../release.js';
import type {
  PutOptions,
  QueryPredicate,
  Storage,
  StorageTransaction,
} from '../../interfaces/storage.js';
import { TriageWriter } from '../writer.js';

const START = 1_700_000_000_000;

/** A sentence no rule claims, so it becomes a card: the case where a derived copy exists. */
const SECRET = 'Falcon is the code name for the Helix Bio acquisition.';

/** A rule claims this one as private, which is the only scope `release()` can override. */
const HEALTH = 'I have been diagnosed with a condition I have not told anyone at work about.';

function world() {
  let now = START;
  const local = new MemoryStorage();
  const shared = new MemoryStorage();
  const federation = new FederatedStorage({ private: local, shared });
  const writer = new TriageWriter(federation);
  const queue = new CardQueue(federation, writer, { now: () => now });
  return {
    local,
    shared,
    federation,
    writer,
    queue,
    log: new ErasureLog(federation),
    assembler: new ReadSideAssembler(federation),
    advance(ms: number) {
      now += ms;
    },
  };
}

/** How many times `needle` appears in `haystack`, case-insensitively. */
function countOf(haystack: string, needle: string): number {
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

/**
 * Every row of every surface, serialised, searched for one sentence.
 *
 * `erasures` is included even though it holds no content by construction: the record is the one row
 * that outlives an erasure, so if a future field on it ever carried the wording, this would be the
 * reading that says so. It is the fifth surface precisely because it is the one nobody would audit.
 */
async function residue(
  w: ReturnType<typeof world>,
  needle: string,
): Promise<{ role: string; rows: number; hits: number }[]> {
  const readings: { role: string; rows: number; hits: number }[] = [];
  for (const surface of erasureSurfaces('facts')) {
    const store = surface.scope === 'private' ? w.local : w.shared;
    const rows = await store.query(surface.name);
    readings.push({
      role: surface.role,
      rows: rows.length,
      hits: countOf(JSON.stringify(rows), needle),
    });
  }
  const records = await w.local.query('erasures');
  readings.push({
    role: 'erasures',
    rows: records.length,
    hits: countOf(JSON.stringify(records), needle),
  });
  return readings;
}

function totalHits(readings: { hits: number }[]): number {
  return readings.reduce((sum, reading) => sum + reading.hits, 0);
}

/** Admit a sentence, return the id. */
async function say(
  w: ReturnType<typeof world>,
  text: string,
  id: string,
  origin?: { sessionId: string; turns: readonly string[] },
): Promise<KnowledgeCard | null> {
  const admission = await w.writer.admit(text, { id, now: START });
  if (!admission.stored) return null;
  return w.queue.open(admission, origin === undefined ? {} : { origin });
}

describe('the token, and the refusal that shows the size of the act', () => {
  it('refuses without the token and names every row the erasure would take', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    await w.queue.accept('f1');

    // The card was accepted, so the fact crossed into the shared store: one row there, one card here.
    await expect(
      w.queue.forget('f1', { acknowledge: 'yes', reason: 'user-request' }),
    ).rejects.toThrow(/fact rows:\s+1/);
    await expect(
      w.queue.forget('f1', { acknowledge: 'yes', reason: 'user-request' }),
    ).rejects.toThrow(/card rows:\s+1/);
    await expect(
      w.queue.forget('f1', { acknowledge: 'yes', reason: 'user-request' }),
    ).rejects.toThrow(ERASURE_TOKEN);

    // Nothing was touched by a refusal: the sentence is still there, and no record exists.
    expect(totalHits(await residue(w, 'Falcon'))).toBeGreaterThan(0);
    expect(await w.queue.erasures()).toHaveLength(0);
  });

  it('refuses a reason that is not one of the three, even with the right token', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    // The field is a union in TypeScript and a string at run time, which is the only place a caller
    // can put a sentence: `reason: 'user asked about Falcon'` would carry the wording into the one
    // record that outlives the erasure.
    await expect(
      w.queue.forget('f1', {
        acknowledge: ERASURE_TOKEN,
        reason: 'user asked about Falcon' as never,
      }),
    ).rejects.toThrow(/not one of the three/);
    expect(await w.queue.erasures()).toHaveLength(0);
  });

  it('refuses an id that holds nothing, naming the record it will not write', async () => {
    const w = world();
    // A credential is classified and never stored, so this id exists only as a refusal -- erasing it
    // would produce a record claiming a deletion that never happened.
    const withheld = await w.writer.admit('my password is hunter2', { id: 'never', now: START });
    expect(withheld.stored).toBe(false);
    await expect(
      w.queue.forget('never', { acknowledge: ERASURE_TOKEN, reason: 'user-request' }),
    ).rejects.toThrow(/nothing is stored under "never"/);
    expect(await w.queue.erasures()).toHaveLength(0);
  });
});

describe('what one erasure removes, surface by surface', () => {
  it('erases the card with its wording, its source and the turns around it', async () => {
    const w = world();
    const card = await say(w, SECRET, 'f1', {
      sessionId: 's-1',
      turns: [
        'We should talk about Falcon tomorrow.',
        'Falcon is the code name for the Helix Bio acquisition.',
      ],
    });
    expect(card?.state).toBe('proposed');

    const before = await residue(w, 'Falcon');
    expect(before.find((reading) => reading.role === 'cards')?.hits).toBeGreaterThan(1);
    expect(before.find((reading) => reading.role === 'private-facts')?.hits).toBe(1);

    const { record, card: erased } = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });

    expect(record.reason).toBe('user-request');
    expect(record.completedAt).toBe(START);
    expect(record.removed).toEqual({ facts: 1, cards: 1, releases: 0 });

    // The tombstone: identity and timeline survive, every copy of the wording does not.
    expect(erased?.state).toBe('forgotten');
    expect(erased?.text).toBe('');
    expect(erased?.sourceText).toBeUndefined();
    expect(erased?.proposal).toBeUndefined();
    expect(erased?.origin).toBeUndefined();
    expect(erased?.createdAt).toBe(START);
    // The rule id survives: it says what kind of thing was erased without saying what it said.
    expect(erased?.rule).toBe(null);

    for (const reading of await residue(w, 'Falcon')) expect(reading.hits).toBe(0);
  });

  it('erases the shared copy when the sentence had crossed the boundary', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    await w.queue.accept('f1');
    expect(await w.shared.get('facts', 'f1')).toBeDefined();

    const { record } = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });

    expect(await w.shared.get('facts', 'f1')).toBeUndefined();
    expect(await w.local.get('facts', 'f1')).toBeUndefined();
    expect(record.removed.facts).toBe(1);
    for (const reading of await residue(w, 'Falcon')) expect(reading.hits).toBe(0);
  });

  it('deletes both copies when a failed promotion left the row in both stores', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    // The documented partial-failure state of `promote()`: the shared copy was written and the private
    // delete did not run. One erasure has to take both, and the prompt has to say two.
    await w.federation.put('shared/facts', 'f1', { id: 'f1', text: SECRET, visibility: 'shared' });
    await expect(
      w.queue.forget('f1', { acknowledge: 'no', reason: 'user-request' }),
    ).rejects.toThrow(/fact rows:\s+2/);

    const { record } = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });
    expect(record.removed.facts).toBe(2);
    expect(await w.local.get('facts', 'f1')).toBeUndefined();
    expect(await w.shared.get('facts', 'f1')).toBeUndefined();
  });

  it('redacts the release record instead of deleting it, and drops the digest with the wording', async () => {
    const w = world();
    const admission = await w.writer.admit(HEALTH, { id: 'h1', now: START });
    expect(admission.stored).toBe(true);
    // A health sentence is `private`, not `never`, and no card is opened for a rule that already
    // decided -- so the release path is the only door, and it leaves the only other copy.
    expect(await say(w, HEALTH, 'h1')).toBe(null);
    const released = await w.writer.release('h1', { acknowledge: RELEASE_TOKEN, now: START });
    expect(released.record.text).toBe(HEALTH);
    expect(released.record.digest).toHaveLength(64);

    const { record } = await w.queue.forget('h1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });
    expect(record.removed).toEqual({ facts: 1, cards: 0, releases: 1 });

    const [kept] = await w.writer.releases();
    expect(kept?.text).toBe(null);
    expect(kept?.digest).toBe(null);
    expect(kept?.digestAlgorithm).toBe(null);
    expect(kept?.redactedAt).toBe(START);
    // The override itself survives: rule, policy, when, and the token that was typed.
    expect(kept?.rule).toBe('health');
    expect(kept?.releasedAt).toBe(START);
    expect(kept?.acknowledged).toBe(RELEASE_TOKEN);
    for (const reading of await residue(w, 'diagnosed')) expect(reading.hits).toBe(0);
  });
});

describe('eraseRows on its own', () => {
  it('defaults to the facts table and the wall clock, and refuses to redact twice', async () => {
    const w = world();
    await w.writer.admit(HEALTH, { id: 'h1', now: START });
    await w.writer.release('h1', { acknowledge: RELEASE_TOKEN, now: START });

    // No options at all: the defaults are the ones a direct caller gets, and a default that no test
    // exercises is a default nobody has run.
    const first = await w.writer.eraseRows('h1');
    expect(first).toEqual({ facts: 1, releases: 1 });
    const [record] = await w.writer.releases();
    expect(record?.redactedAt).toBeGreaterThan(START);

    // The retry a crash would produce. `releases: 0` is the assertion: the count reaches an audit
    // export, and a second redaction of one record counted twice is a number nobody can reconcile.
    expect(await w.writer.eraseRows('h1')).toEqual({ facts: 0, releases: 0 });
    const [again] = await w.writer.releases();
    expect(again?.redactedAt).toBe(record?.redactedAt);
  });

  it('reports zero for an id it has never seen', async () => {
    const w = world();
    expect(await w.writer.eraseRows('absent')).toEqual({ facts: 0, releases: 0 });
  });
});

describe('the record', () => {
  it('holds no wording, no digest and nothing reversible', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    const { record } = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });

    const serialised = JSON.stringify(record).toLowerCase();
    for (const word of ['falcon', 'helix', 'acquisition', 'codes']) {
      expect(serialised).not.toContain(word);
    }
    // A digest of a guessable sentence is an oracle, not a redaction -- unlike `ReleaseRecord`, which
    // keeps one because its job is to prove *what* crossed the boundary.
    expect(serialised).not.toMatch(/[0-9a-f]{32}/);
    expect(record).toEqual({
      id: 'f1',
      reason: 'user-request',
      acknowledged: ERASURE_TOKEN,
      requestedAt: START,
      completedAt: START,
      removed: { facts: 1, cards: 1, releases: 0 },
    });
  });

  it('lists oldest first, and breaks a tie by id so two exports are byte-identical', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    await say(w, 'The bookshop on the corner reopens next month.', 'f2');
    await say(w, 'The tram timetable changed in April.', 'f3');

    await w.queue.forget('f1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });
    w.advance(1_000);
    // f2 and f3 are erased in the same millisecond on purpose: with a frozen clock the tie-break is
    // the only thing that decides, and a list whose order depended on insertion would differ between
    // two stores holding the same rows.
    await w.queue.forget('f3', { acknowledge: ERASURE_TOKEN, reason: 'correction' });
    await w.queue.forget('f2', { acknowledge: ERASURE_TOKEN, reason: 'retention-policy' });

    expect((await w.queue.erasures()).map((record) => record.id)).toEqual(['f1', 'f2', 'f3']);
    expect(await w.queue.erasure('absent')).toBeUndefined();
    expect((await w.queue.erasure('f2'))?.reason).toBe('retention-policy');

    // The card row says **which** erasure, in that erasure's own words. It used to say "at the
    // owner's request" for all three, so a correction and a retention sweep each printed a sentence
    // claiming the owner had asked to be forgotten -- the record and the row disagreeing about one
    // act, with the row being the line a person actually reads in the export. Listed in `list()`
    // order (createdAt, then id), which is not the erase order on purpose: the two must not be
    // confusable.
    expect((await w.queue.list()).map((card) => [card.id, card.reason])).toEqual([
      ['f1', "Erased at the owner's request. No wording is kept, and the id is burned."],
      ['f2', 'Erased under the retention policy. No wording is kept, and the id is burned.'],
      ['f3', 'Erased as a correction. No wording is kept, and the id is burned.'],
    ]);
  });

  it('keeps the reason the erasure was opened with, not the one a retry names', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    // The state a crash between "record opened" and "rows deleted" leaves behind: a record with one
    // reason, and a card that still has its wording.
    await w.log.begin({ id: 'f1', reason: 'correction', acknowledged: ERASURE_TOKEN, at: START });

    const { record, card } = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'retention-policy',
    });

    // The record keeps the first reason because the erasure began then; the row has to agree with
    // it, or the export answers "why is this gone" twice with two different sentences.
    expect(record.reason).toBe('correction');
    expect(card?.reason).toMatch(/as a correction/);
    expect((await w.queue.get('f1'))?.reason).toBe(card?.reason);
    expect(await w.queue.erasure('f1')).toEqual(record);
  });

  it('lists in id order when the store hands ties back in the other order', async () => {
    // `MemoryStorage.query` sorts by key, so a list that relied on insertion order would pass every
    // test above and produce two different exports of the same store. This wrapper reverses what the
    // store returns, which is the shape a real engine is free to have.
    const w = world();
    const reversed = new FederatedStorage({
      private: new Reversing(w.local),
      shared: new Reversing(w.shared),
    });
    const writer = new TriageWriter(reversed);
    const queue = new CardQueue(reversed, writer, { now: () => START });

    for (const id of ['a', 'b', 'c']) {
      await writer.admit(`${SECRET} (${id})`, { id, now: START });
      await queue.forget(id, { acknowledge: ERASURE_TOKEN, reason: 'user-request' });
    }
    expect((await queue.erasures()).map((record) => record.id)).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent: a second call returns the first record and rewrites nothing', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    const first = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });

    w.advance(60_000);
    const second = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });

    expect(second.record).toEqual(first.record);
    expect(second.card?.state).toBe('forgotten');
    expect(await w.queue.erasures()).toHaveLength(1);
  });

  it('finishes an interrupted erasure, keeping the time the erasure was asked for', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    // The state a crash between "record opened" and "rows deleted" leaves behind.
    await w.log.begin({
      id: 'f1',
      reason: 'retention-policy',
      acknowledged: ERASURE_TOKEN,
      at: START - 5,
    });

    w.advance(1_000);
    const { record } = await w.queue.forget('f1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });

    // `requestedAt` is the first attempt's, `completedAt` is this one's: an audit that reset the
    // clock on every retry could not tell a retry from a fresh request.
    expect(record.requestedAt).toBe(START - 5);
    expect(record.completedAt).toBe(START + 1_000);
    expect(record.reason).toBe('retention-policy');
    expect(record.removed).toEqual({ facts: 1, cards: 1, releases: 0 });
    for (const reading of await residue(w, 'Falcon')) expect(reading.hits).toBe(0);
  });
});

describe('the release door after an erasure', () => {
  it('cannot be used: the record is redacted and the row it described is gone', async () => {
    const w = world();
    await w.writer.admit(HEALTH, { id: 'h1', now: START });
    await w.writer.release('h1', { acknowledge: RELEASE_TOKEN, now: START });
    await w.queue.forget('h1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });

    // A completed release record still exists -- it is the audit -- so `release()` finds its own
    // record and then finds nothing to hand back. The refusal names the row rather than silently
    // returning a redacted record, which would tell a caller the release succeeded.
    await expect(w.writer.release('h1', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
      /no private fact with id "h1"/,
    );
  });
});

describe('terminal means terminal', () => {
  it('refuses every operation that would write to an erased card', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    await w.queue.forget('f1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });

    const attempts: [string, () => Promise<unknown>][] = [
      ['accept', () => w.queue.accept('f1')],
      ['edit', () => w.queue.edit('f1', 'a replacement sentence')],
      ['dismiss', () => w.queue.dismiss('f1')],
      ['refresh', () => w.queue.refresh('f1')],
      [
        'attach',
        () => w.queue.attach('f1', { facts: [{ text: 'anything' }], withheld: [] } as never),
      ],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toThrow(/was erased/);
    }

    // And the tombstone is still the one the erasure wrote: no attempt above created a card.
    expect((await w.queue.get('f1'))?.state).toBe('forgotten');
  });

  it('burns the id: a later admission cannot put a row back under it', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    await w.queue.forget('f1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });

    await expect(w.writer.admit(SECRET, { id: 'f1', now: START })).rejects.toThrow(/burned/);
    // Without an explicit id the store mints one, which is the supported way to say it again.
    const fresh = await w.writer.admit(SECRET, { now: START });
    expect(fresh.id).not.toBe('f1');
    expect(fresh.stored).toBe(true);
  });
});

describe('what the export shows afterwards', () => {
  it('counts the erased card and shows a mark instead of a blank cell', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    await say(w, 'The bookshop on the corner reopens next month.', 'f2');
    await w.queue.forget('f1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });

    const markdown = await w.queue.toMarkdown();
    expect(markdown).toContain('1 forgotten');
    expect(markdown).toContain('1 proposed');
    expect(markdown).toContain('| forgotten |');
    expect(markdown).toContain('| — |');
    expect(markdown).not.toContain('Falcon');
  });

  it('keeps the deleted sentence out of the evidence a task reads, in both scopes', async () => {
    const w = world();
    await say(w, SECRET, 'f1');
    await w.queue.accept('f1');
    expect(await w.assembler.assemble({ task: 'shared', table: 'facts' })).toHaveLength(1);

    await w.queue.forget('f1', { acknowledge: ERASURE_TOKEN, reason: 'user-request' });

    expect(await w.assembler.assemble({ task: 'shared', table: 'facts' })).toHaveLength(0);
    expect(await w.assembler.assemble({ task: 'private', table: 'facts' })).toHaveLength(0);
  });
});

describe('the surface list cannot fall behind the code', () => {
  it('names every surface, in an order the code looks up by role rather than by position', async () => {
    expect(erasureSurfaces('facts')).toEqual([
      { role: 'private-facts', scope: 'private', name: 'facts' },
      { role: 'shared-facts', scope: 'shared', name: 'facts' },
      { role: 'cards', scope: 'private', name: 'cards' },
      { role: 'releases', scope: 'private', name: 'releases' },
    ]);
    // The fact table is a parameter, so a session that renames it must carry the rename into every
    // surface -- a list that kept `facts` here would erase the wrong table for such a caller.
    expect(erasureSurfaces('notes').map((surface) => surface.name)).toEqual([
      'notes',
      'notes',
      'cards',
      'releases',
    ]);
  });

  it('leaves no hand-written table path anywhere in the disclosure layer', async () => {
    // The residual assertions above are only as complete as this list. A module that addressed a
    // table by spelling `private/cards` itself could add a fifth copy of a sentence, and every
    // erasure test would still pass -- because it would never look at that table. The paths are
    // therefore checked in the source: `FACET_TABLES` is the only place a fixed table is named.
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const triage = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const file of ['card.ts', 'writer.ts', 'erasure.ts', 'release.ts']) {
      const source = readFileSync(join(triage, file), 'utf8')
        .split('\n')
        // The module comments quote the paths on purpose, and a comment cannot be read by the
        // store. Only code lines count.
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n');
      for (const table of ['cards', 'releases', 'erasures']) {
        expect(
          source,
          `${file} spells private/${table} instead of using FACET_TABLES`,
        ).not.toContain(`private/${table}`);
      }
    }
  });
});

/**
 * A `Storage` that hands rows back in the opposite order to the one it stored them in.
 *
 * Exists for one reason: `MemoryStorage.query` sorts by key, so the *ordering* of an exported list is
 * never exercised by it, and a comparator with an unreachable arm would look covered.
 */
class Reversing implements Storage {
  constructor(private readonly inner: Storage) {}
  async put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    await this.inner.put(table, key, value, opts);
  }
  async get<T>(table: string, key: string): Promise<T | undefined> {
    return this.inner.get<T>(table, key);
  }
  async del(table: string, key: string): Promise<void> {
    await this.inner.del(table, key);
  }
  async query<T>(table: string, predicate?: QueryPredicate): Promise<T[]> {
    return (await this.inner.query<T>(table, predicate)).reverse();
  }
  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
}

/**
 * The session: one object that carries a sentence from "they said it" to "a colleague can read it".
 *
 * ## What is actually being tested here
 *
 * Every piece of this chain has its own test suite. What none of them can show is that the pieces
 * compose: that a deferred sentence becomes a card, that a card accepts a proposal without
 * publishing anything, that a click publishes the atom rather than the paragraph, and that all of it
 * survives the process exiting. Those are the claims a person makes when they say the feature works,
 * and each one is asserted below.
 *
 * ## Why the store is real SQLite and not a map
 *
 * Because the wiring is the subject. `MemoryStorage` would test the session against an object whose
 * behaviour I wrote, and the properties a real engine brings -- a file, a reopen, a schema created
 * on first use -- are exactly what a user gets. Two of the tests below close the storage and reopen
 * the same file; a map cannot fail that and a file can.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';
import { TriageError, TriageProposer } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';
import { DisclosureSession } from '../disclosure/session.js';

const START = 1_700_000_000_000;

/** A sentence no rule claims, so it becomes a card. */
const DEFERRED = 'I moved to Berlin in March and now I work at Acme on the payments team.';

/** Two clean atoms, in source order. */
const ATOMS = ['I moved to Berlin in March', 'now I work at Acme on the payments team'];

type Reply = { facts: { text: string }[] } | Error;

class ScriptedLLM implements LLM {
  constructor(private readonly reply: Reply) {}
  async complete(): Promise<string> {
    return JSON.stringify(this.reply);
  }
  async completeStructured<T>(
    _prompt: string,
    _schema: JsonSchema,
    _opts?: CompleteOptions,
  ): Promise<T> {
    if (this.reply instanceof Error) throw this.reply;
    return this.reply as T;
  }
}

const open: { storage: SqliteStorage; dir: string }[] = [];

/** Two files in one temp directory: the shape a real deployment has, and the shape the session needs. */
function tempStores(): {
  private: SqliteStorage;
  shared: SqliteStorage;
  dir: string;
  paths: [string, string];
} {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-session-'));
  const privatePath = join(dir, 'private.db');
  const sharedPath = join(dir, 'shared.db');
  const priv = new SqliteStorage({ filename: privatePath });
  const shrd = new SqliteStorage({ filename: sharedPath });
  open.push({ storage: priv, dir }, { storage: shrd, dir });
  return { private: priv, shared: shrd, dir, paths: [privatePath, sharedPath] };
}

function session(
  options: { proposer?: TriageProposer; now?: () => number; decayMs?: number; table?: string } = {},
) {
  const stores = tempStores();
  const disclosure = new DisclosureSession({
    private: stores.private,
    shared: stores.shared,
    now: options.now ?? (() => START),
    ...(options.proposer === undefined ? {} : { proposer: options.proposer }),
    ...(options.decayMs === undefined ? {} : { decayMs: options.decayMs }),
    ...(options.table === undefined ? {} : { table: options.table }),
  });
  return { disclosure, storage: stores.private, sharedStore: stores.shared, stores };
}

function proposer(reply: Reply): TriageProposer {
  return new TriageProposer({ llm: new ScriptedLLM(reply), model: 'scripted/v1' });
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.storage.close().catch(() => undefined);
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe('saying something', () => {
  it('defers a sentence, stores it privately, and asks', async () => {
    const { disclosure, storage, sharedStore } = session();
    const { admission, card } = await disclosure.say(DEFERRED, { id: 'f1' });

    expect(admission.stored).toBe(true);
    expect(admission.visibility).toBe('private');
    expect(card?.state).toBe('proposed');
    expect(card?.id).toBe('f1');

    expect(await storage.query('facts')).toHaveLength(1);
    expect(await sharedStore.query('facts')).toHaveLength(0);
  });

  it('stores a sentence a shared rule claims without asking, and it reaches a shared task', async () => {
    const { disclosure } = session();
    const { admission, card } = await disclosure.say('The project plan moves to Thursday.');
    expect(admission.visibility).toBe('shared');
    // No card: nothing is in question, and a queue that asks about settled facts trains people to
    // click through it.
    expect(card).toBeNull();
    expect(await disclosure.evidence('shared')).toHaveLength(1);
  });

  it('withholds a credential and says which rule did it', async () => {
    const { disclosure, storage, sharedStore } = session();
    const { admission, card } = await disclosure.say('My password is hunter2.', { id: 'c1' });
    expect(admission.stored).toBe(false);
    if (admission.stored) return;
    expect(admission.withheld.rule).toBe('credential');
    expect(card).toBeNull();
    // Nothing anywhere, in either engine: not the fact, not a card.
    expect(await storage.query('facts')).toHaveLength(0);
    expect(await storage.query('cards')).toHaveLength(0);
    expect(await sharedStore.query('facts')).toHaveLength(0);
  });

  it('stamps the real clock when none is injected, because the product does not pass one', async () => {
    const stores = tempStores();
    const live = new DisclosureSession({ private: stores.private, shared: stores.shared });
    const before = Date.now();
    const { card } = await live.say(DEFERRED, { id: 'f1' });
    expect(card?.createdAt).toBeGreaterThanOrEqual(before);
    expect(card?.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('gives every sentence its own id, and honours one it is given', async () => {
    const { disclosure } = session();
    const first = await disclosure.say(DEFERRED);
    const second = await disclosure.say('The bookshop on the corner reopens next month.');
    expect(first.admission.id).not.toBe(second.admission.id);
    expect((await disclosure.say('I read on the train.', { id: 'named' })).admission.id).toBe(
      'named',
    );
  });
});

describe('asking a model for atoms', () => {
  it('refuses to propose when no proposer was configured, and names the remedy', async () => {
    const { disclosure } = session();
    await disclosure.say(DEFERRED, { id: 'f1' });
    await expect(disclosure.propose('f1')).rejects.toThrow(/no proposer/i);
  });

  it('attaches a proposal without publishing anything', async () => {
    const { disclosure, sharedStore } = session({
      proposer: proposer({ facts: ATOMS.map((text) => ({ text })) }),
    });
    await disclosure.say(DEFERRED, { id: 'f1' });
    const result = await disclosure.propose('f1');

    expect(result.ok).toBe(true);
    const card = (await disclosure.cards())[0];
    expect(card?.proposal?.facts.map((fact) => fact.text)).toEqual(ATOMS);
    // The card still carries the sentence the person said, not the model's split of it.
    expect(card?.text).toBe(DEFERRED);
    expect(card?.state).toBe('proposed');
    expect(await sharedStore.query('facts')).toHaveLength(0);
  });

  it('returns the failure and leaves the card alone when the model cannot answer', async () => {
    const { disclosure } = session({ proposer: proposer(new Error('connection refused')) });
    await disclosure.say(DEFERRED, { id: 'f1' });
    const result = await disclosure.propose('f1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('provider-error');

    const card = (await disclosure.cards())[0];
    expect(card?.proposal).toBeUndefined();
    expect(card?.text).toBe(DEFERRED);
    expect(card?.state).toBe('proposed');
  });
});

describe('publishing', () => {
  it('publishes the whole sentence when no atom is chosen', async () => {
    const { disclosure, storage, sharedStore } = session();
    await disclosure.say(DEFERRED, { id: 'f1' });
    const card = await disclosure.accept('f1');
    expect(card.state).toBe('accepted');
    // Promotion writes the shared copy and deletes the private one; the engines show both halves.
    expect(await storage.query('facts')).toHaveLength(0);
    expect(await sharedStore.query('facts')).toHaveLength(1);
  });

  it('publishes the chosen atom, and only that one', async () => {
    const { disclosure, sharedStore } = session({
      proposer: proposer({ facts: ATOMS.map((text) => ({ text })) }),
    });
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.propose('f1');

    const card = await disclosure.accept('f1', { atom: 0 });
    expect(card.state).toBe('edited');
    expect(card.text).toBe(ATOMS[0]);

    const shared = await sharedStore.query<{ text: string }>('facts');
    expect(shared.map((row) => row.text)).toEqual([ATOMS[0]]);
    // The paragraph itself never crossed.
    expect(await sharedStore.query<{ text: string }>('facts')).not.toContainEqual(
      expect.objectContaining({ text: DEFERRED }),
    );
  });

  it('keeps the paragraph the atom came from, so the export can be audited afterwards', async () => {
    // Without this the demo published an atom and the sentence it came from existed nowhere: the
    // card had been rewritten and the private row deleted. The export is the audit surface, and
    // "did they really say that?" has to be answerable from it.
    const { disclosure } = session({
      proposer: proposer({ facts: ATOMS.map((text) => ({ text })) }),
    });
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.propose('f1');
    await disclosure.accept('f1', { atom: 0 });

    const card = (await disclosure.cards())[0];
    expect(card?.text).toBe(ATOMS[0]);
    expect(card?.sourceText).toBe(DEFERRED);

    const markdown = await disclosure.export();
    expect(markdown.split('\n')).toContain('| id | state | reason | text | source | proposed |');
    expect(markdown).toContain(DEFERRED);
  });

  it('refuses an atom index that does not exist, and names the range', async () => {
    const { disclosure } = session({ proposer: proposer({ facts: [{ text: ATOMS[0]! }] }) });
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.propose('f1');
    await expect(disclosure.accept('f1', { atom: 3 })).rejects.toThrow(/0\.\.0|out of range/);
  });

  it('says which id was missing rather than reporting a store error', async () => {
    const { disclosure } = session({ proposer: proposer({ facts: [{ text: ATOMS[0]! }] }) });
    await expect(disclosure.accept('nope', { atom: 0 })).rejects.toThrow(/no card with id "nope"/);
  });

  it('refuses an atom when the proposal failed', async () => {
    const { disclosure } = session({ proposer: proposer(new Error('429')) });
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.propose('f1');
    await expect(disclosure.accept('f1', { atom: 0 })).rejects.toThrow(/no proposal/i);
  });

  it('does not swallow a dismissal: accepting afterwards is still refused', async () => {
    const { disclosure } = session();
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.dismiss('f1');
    await expect(disclosure.accept('f1')).rejects.toThrow(TriageError);
  });

  it('publishes nothing when the chosen atom is reclassified as private', async () => {
    // A model that proposes an atom about money is caught at propose time; this is the other half:
    // an atom that reached the card and only trips a rule when it is classified again at publish.
    const { disclosure, sharedStore } = session({
      proposer: proposer({ facts: [{ text: 'I moved to Berlin in March' }] }),
    });
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.propose('f1');
    const card = await disclosure.edit('f1', 'I spent 300 dollars on a bike');
    expect(card.refused?.rule).toBe('money');
    expect(await sharedStore.query('facts')).toHaveLength(0);
  });
});

describe('a confirmation that outlives its interval', () => {
  it('withdraws the fact from answers and takes it back when the person re-confirms', async () => {
    let clock = START;
    const { disclosure } = session({ now: () => clock, decayMs: 1_000 });
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.accept('f1');
    expect(await disclosure.evidence('shared')).toHaveLength(1);

    clock += 2_000;
    const expired = await disclosure.expire();
    expect(expired.map((card) => card.state)).toEqual(['stale']);
    // The card queue says "stale"; the read side is what makes that a control rather than a label.
    expect(await disclosure.evidence('shared')).toHaveLength(0);

    const refreshed = await disclosure.refresh('f1');
    expect(refreshed.state).toBe('accepted');
    expect(await disclosure.evidence('shared')).toHaveLength(1);
  });

  it('writes to the table it was configured with, not to a hard-coded one', async () => {
    const { disclosure, storage } = session({ table: 'notes' });
    await disclosure.say(DEFERRED, { id: 'f1' });
    expect(await storage.query('notes')).toHaveLength(1);
    expect(await storage.query('facts')).toHaveLength(0);
    expect(await disclosure.evidence('private')).toHaveLength(1);
  });
});

describe('the boundary, as a task sees it', () => {
  it('never shows a private row to a shared task, and shows both to a private one', async () => {
    const { disclosure } = session();
    await disclosure.say(DEFERRED, { id: 'a' });
    await disclosure.say('The project plan moves to Thursday.', { id: 'b' });
    expect(await disclosure.evidence('shared')).toHaveLength(1);
    expect(await disclosure.evidence('private')).toHaveLength(2);

    await disclosure.accept('a');
    expect(await disclosure.evidence('shared')).toHaveLength(2);
    // A promoted row is deleted from the private store, so the private task sees the shared copy.
    expect(await disclosure.evidence('private')).toHaveLength(2);
  });
});

describe('surviving the process', () => {
  it('fails closed when both halves point at one engine, instead of quietly merging them', async () => {
    // The first draft of the session took a single `Storage` and relied on the table prefix to keep
    // the halves apart. It does not: `FederatedStorage` strips the prefix and both write to `facts`
    // in the same file, so a shared query reads the private rows too. What happens next is the
    // point of this test -- `ReadSideAssembler` refuses and names the offending key, rather than
    // filtering it out and leaving the boundary looking intact.
    const stores = tempStores();
    const one = new DisclosureSession({
      private: stores.private,
      shared: stores.private,
      now: () => START,
    });
    await one.say('The project plan moves to Thursday.', { id: 'b' });
    await one.say(DEFERRED, { id: 'a' });
    // 'b' declares itself shared and is a legitimate row; 'a' is the one that must never appear, and
    // it is in the same table because the two halves are one engine.
    await expect(one.evidence('shared')).rejects.toThrow(/do not declare themselves shared/);
  });

  it('keeps the queue in files, so a second process can answer the question', async () => {
    const stores = tempStores();
    const first = new DisclosureSession({
      private: stores.private,
      shared: stores.shared,
      now: () => START,
    });
    await first.say(DEFERRED, { id: 'f1' });
    await stores.private.close();
    await stores.shared.close();

    const reopenedPrivate = new SqliteStorage({ filename: stores.paths[0] });
    const reopenedShared = new SqliteStorage({ filename: stores.paths[1] });
    open.push(
      { storage: reopenedPrivate, dir: stores.dir },
      { storage: reopenedShared, dir: stores.dir },
    );
    const second = new DisclosureSession({
      private: reopenedPrivate,
      shared: reopenedShared,
      now: () => START,
    });
    const cards = await second.cards();
    expect(cards.map((card) => card.id)).toEqual(['f1']);

    const published = await second.accept('f1');
    expect(published.state).toBe('accepted');
    expect(await second.evidence('shared')).toHaveLength(1);
  });

  it('exports the queue as markdown, including what the model offered', async () => {
    const { disclosure } = session({ proposer: proposer({ facts: [{ text: ATOMS[0]! }] }) });
    await disclosure.say(DEFERRED, { id: 'f1' });
    await disclosure.propose('f1');
    const markdown = await disclosure.export();
    expect(markdown).toContain('1 card(s): 1 proposed.');
    expect(markdown).toContain('| id | state | reason | text | proposed |');
    expect(markdown).toContain(ATOMS[0]!);
  });
});

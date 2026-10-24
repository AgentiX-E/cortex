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
import { RELEASE_TOKEN, TriageError, TriageProposer } from '@agentix-e/cortex-core';
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

describe('checking a draft before anyone reads it', () => {
  it('blocks a shared draft that copies a private row no rule recognises', async () => {
    const { disclosure } = session();
    await disclosure.say(DEFERRED, { id: 'f1' });

    const scan = await disclosure.check(`Here is what I remember: ${DEFERRED}`, { task: 'shared' });
    expect(scan.verdict).toBe('blocked');
    // O1 has no opinion about this sentence -- that is why O3 exists -- so the finding is an echo.
    expect(scan.findings.map((finding) => finding.kind)).toContain('echo');
  });

  it('lets a private task repeat the owner\u2019s own sentence, because that is the product working', async () => {
    // The guard's own comment says a private answer repeating the user's facts is not a violation,
    // and O1 implements it. O3 did not, so wiring the two together blocked every private answer
    // that quoted the user's memory -- the whole private path, unusable, with a passing test suite.
    const { disclosure } = session();
    await disclosure.say(DEFERRED, { id: 'f1' });

    const scan = await disclosure.check(`You told me: ${DEFERRED}`, { task: 'private' });
    expect(scan.verdict).toBe('clear');
    expect(scan.findings).toHaveLength(0);
  });

  it('clears a shared draft that cites a published fact and quotes it', async () => {
    const { disclosure } = session();
    await disclosure.say('The project plan moves to Thursday.', { id: 'p1' });
    const scan = await disclosure.check('The project plan moves to Thursday [[p1]].', {
      task: 'shared',
    });
    expect(scan.verdict).toBe('clear');
  });

  it('blocks a shared draft with no citation at all', async () => {
    const { disclosure } = session();
    await disclosure.say('The project plan moves to Thursday.', { id: 'p1' });
    const scan = await disclosure.check('The project plan moves to Thursday.', { task: 'shared' });
    expect(scan.verdict).toBe('blocked');
    expect(scan.findings.map((finding) => finding.kind)).toContain('unattributed');
  });

  it('blocks a citation that resolves to nothing in the window', async () => {
    const { disclosure } = session();
    const scan = await disclosure.check('The plan moved [[ghost]].', { task: 'shared' });
    expect(scan.findings.map((finding) => finding.kind)).toContain('unknown-citation');
  });

  it('stops blocking a private row once it has been published', async () => {
    const { disclosure } = session();
    await disclosure.say(DEFERRED, { id: 'f1' });
    expect((await disclosure.check(DEFERRED, { task: 'shared' })).verdict).toBe('blocked');

    await disclosure.accept('f1');
    const scan = await disclosure.check(`${DEFERRED} [[f1]]`, { task: 'shared' });
    expect(scan.verdict).toBe('clear');
  });

  it('forwards the two knobs a caller may set: citations and echo width', async () => {
    const { disclosure } = session();
    await disclosure.say(DEFERRED, { id: 'f1' });

    // No citation required: the same draft that is blocked by default is clear when the caller says
    // this task does not need one -- except for the echo, which is a leak either way.
    const noCitation = await disclosure.check(DEFERRED, { task: 'shared', requireCitation: false });
    expect(noCitation.findings.map((finding) => finding.kind)).toEqual(['echo']);

    // A shorter window: sixteen characters is inside a sentence the default thirty-two would miss.
    const wide = await disclosure.check('I moved to Berlin', { task: 'shared', minEchoChars: 16 });
    expect(wide.findings.map((finding) => finding.kind)).toContain('echo');
    const narrow = await disclosure.check('I moved to Berlin', { task: 'shared' });
    expect(narrow.findings.map((finding) => finding.kind)).not.toContain('echo');
  });

  it('keeps a credential finding even for the owner, because the draft is stored and pasted', async () => {
    const { disclosure } = session();
    const scan = await disclosure.check('Your password is hunter2, as you told me.', {
      task: 'private',
    });
    expect(scan.verdict).toBe('blocked');
    expect(scan.findings.map((finding) => finding.kind)).toContain('never-retained');
  });
});

describe('sharing something the rules kept private', () => {
  const HEALTH = 'My therapist moved me to a new medication last week.';

  it('requires the token, and refuses with the rule and its policy rather than a scold', async () => {
    const { disclosure } = session();
    const { admission } = await disclosure.say(HEALTH, { id: 'h1' });
    expect(admission.stored).toBe(true);
    expect(admission.visibility).toBe('private');

    await expect(disclosure.release('h1', { acknowledge: '' })).rejects.toThrow(/rule "health"/);
    await expect(disclosure.release('h1', { acknowledge: '' })).rejects.toThrow(/policy:/);
    // Nothing moved, and nothing was recorded.
    expect(await disclosure.evidence('shared')).toHaveLength(0);
    expect(await disclosure.releases()).toHaveLength(0);
  });

  it('moves the row and leaves an audit record the owner can read', async () => {
    const { disclosure } = session();
    await disclosure.say(HEALTH, { id: 'h1' });
    const { record } = await disclosure.release('h1', { acknowledge: RELEASE_TOKEN });

    expect(record).toMatchObject({
      id: 'h1',
      rule: 'health',
      text: HEALTH,
      completedAt: expect.any(Number),
    });
    expect((await disclosure.evidence('shared')).map((row) => row.key)).toEqual(['h1']);
    // The audit trail is the owner's: a shared task's window does not include it.
    expect((await disclosure.releases()).map((entry) => entry.id)).toEqual(['h1']);
  });

  it('never offers to release a credential, because there is no row to release', async () => {
    // `retention: 'never'` is enforced at admission. A release path that could resurrect a
    // credential would undo the one policy that is absolute.
    const { disclosure } = session();
    await disclosure.say('My password is hunter2.', { id: 'c1' });
    await expect(disclosure.release('c1', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
      /no private fact with id "c1"/,
    );
  });

  it('survives a restart, because the record is in the store and not in memory', async () => {
    const stores = tempStores();
    const first = new DisclosureSession({ private: stores.private, shared: stores.shared });
    await first.say(HEALTH, { id: 'h1' });
    await first.release('h1', { acknowledge: RELEASE_TOKEN });
    await stores.private.close();
    await stores.shared.close();

    const reopened = new DisclosureSession({
      private: new SqliteStorage({ filename: stores.paths[0] }),
      shared: new SqliteStorage({ filename: stores.paths[1] }),
    });
    const records = await reopened.releases();
    expect(records).toHaveLength(1);
    expect(records[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
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

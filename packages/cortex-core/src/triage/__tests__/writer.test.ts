/**
 * The write side, and the boundary as a property of the pair (writer, assembler).
 *
 * ## What the previous step left untested
 *
 * `read-side.test.ts` proves the assembler refuses to build a shared window out of a private row.
 * Every one of those tests writes its rows by hand, so what they establish is "the reader is
 * careful", not "the system is safe". A boundary is only as good as what the writer put in the
 * stores, and until this file existed that was a convention held by a prototype.
 *
 * ## The number this file exists to reproduce
 *
 * Sixty labelled utterances, admitted through `TriageWriter`, read back through
 * `ReadSideAssembler`: 0 of 12 gold-private rows are visible to a shared task, and 4 of 8
 * gold-shared rows are. That pair is `[POC-5]` measured on product code rather than on the model of
 * it -- and the gap between 4 and 8 is the arithmetic of why the card queue exists.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../../__tests__/support/memory-storage.js';
import { FederatedStorage } from '../../federation/federated-storage.js';
import { ReadSideAssembler } from '../../federation/read-side.js';
import type { TriageDecision } from '../rules.js';
import { TriageError, TriageWriter, type AdmittedFact } from '../writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type LabelledRow = { id: string; text: string; gold: 'private' | 'shared' | 'defer' };

function labels(): LabelledRow[] {
  const file = JSON.parse(readFileSync(join(HERE, 'fixtures', 'triage-labels.json'), 'utf8')) as {
    rows: LabelledRow[];
  };
  return file.rows;
}

function world(): {
  federation: FederatedStorage;
  local: MemoryStorage;
  shared: MemoryStorage;
  writer: TriageWriter;
  assembler: ReadSideAssembler;
} {
  const local = new MemoryStorage();
  const shared = new MemoryStorage();
  const federation = new FederatedStorage({ private: local, shared });
  return {
    federation,
    local,
    shared,
    writer: new TriageWriter(federation),
    assembler: new ReadSideAssembler(federation),
  };
}

/**
 * A store whose deletes fail, to reach the partial-failure arm of `promote`.
 *
 * The reason is a parameter because a store can throw something that is not an `Error` -- a native
 * binding, a proxy, a driver written in C -- and the message that reaches the operator has to carry
 * it either way. Both arms are exercised; one arm alone would leave the other uncovered and
 * therefore unread.
 */
class RefusingDeleteStorage extends MemoryStorage {
  constructor(private readonly reason: unknown) {
    super();
  }

  override async del(_table: string, _key: string): Promise<void> {
    throw this.reason;
  }
}

describe('admit', () => {
  it('stores a shared fact in the shared store and a private one at home', async () => {
    const { writer, local, shared } = world();

    const publishable = await writer.admit('We decided the roadmap moves to Q3 at the review.');
    const kept = await writer.admit('My daughter has an appointment with the dentist on Friday.');

    expect(publishable.visibility).toBe('shared');
    expect(kept.visibility).toBe('private');
    expect(await local.get('facts', publishable.id)).toBeUndefined();
    expect(await shared.get('facts', publishable.id)).toBeDefined();
    expect(await local.get('facts', kept.id)).toBeDefined();
  });

  it('never writes the word "defer" into the field the boundary is enforced on', async () => {
    // The tempting shortcut is `visibility: triage.scope`, which would store 'defer' and make every
    // filter written as `visibility === 'private'` miss these rows -- silently, and in the direction
    // that looks safe while the boundary's own error messages become wrong.
    const { writer, local } = world();
    const fact = await writer.admit('I have been reading more about sourdough starters lately.');

    expect(fact.triage.scope).toBe('defer');
    expect(fact.visibility).toBe('private');

    const stored = await local.query<AdmittedFact>('facts');
    expect(stored.map((row) => row.visibility)).toEqual(['private']);
    expect(stored.filter((row) => row.visibility === 'private')).toHaveLength(1);
  });

  it('records the rule that fired, so a disputed decision has a citation', async () => {
    const { writer } = world();
    const fact = await writer.admit('My mortgage payment went up by 200 dollars this month.');
    expect(fact.triage).toMatchObject({ scope: 'private', rule: 'money' });
    expect(fact.triage.policy).toMatch(/amounts, income, budget, debt/);
  });

  it('rejects a blank sentence as a caller defect rather than storing it', async () => {
    const { writer, local } = world();
    await expect(writer.admit('   ')).rejects.toBeInstanceOf(TypeError);
    await expect(writer.admit('')).rejects.toBeInstanceOf(TypeError);
    await expect(writer.admit(42 as unknown as string)).rejects.toBeInstanceOf(TypeError);
    expect(await local.query('facts')).toEqual([]);
  });

  it('honours an id and a clock supplied by the caller', async () => {
    // Named ids exist so the fixture can be read back by label, and the injected clock so a test
    // can assert ordering without sleeping.
    const { writer, local } = world();
    const fact = await writer.admit('The bookshop on the corner reopens next month.', {
      id: 'fact-1',
      now: 1_700_000_000_000,
    });
    expect(fact.id).toBe('fact-1');
    expect(fact.admittedAt).toBe(1_700_000_000_000);
    expect(await local.get('facts', 'fact-1')).toEqual(fact);
  });
});

describe('a triage failure lands privately', () => {
  // Three ways the classifier can fail, all reachable in a real deployment: a pattern the engine
  // rejects, a merged or injected table that returns a scope nobody recognises, and a classifier a
  // caller replaced with something that does not answer. In every case the fact must still be
  // stored, and it must be stored privately with the reason attached.
  const failing: {
    name: string;
    broken: (text: string) => TriageDecision;
    message: RegExp;
  }[] = [
    {
      name: 'a classifier that throws an Error',
      broken: () => {
        throw new Error('invalid regular expression: nothing to repeat');
      },
      message: /nothing to repeat/,
    },
    {
      name: 'a classifier that throws a string',
      broken: () => {
        throw 'compiled table is corrupt';
      },
      message: /compiled table is corrupt/,
    },
    {
      name: 'a classifier that returns a scope nobody recognises',
      broken: () => ({ scope: 'public' as TriageDecision['scope'], rule: 'x', policy: 'y' }),
      message: /unknown scope/,
    },
  ];

  it.each(failing)('$name still stores the fact, privately', async ({ broken, message }) => {
    const { federation, shared } = world();
    const writer = new TriageWriter(federation, { classify: broken });
    const assembler = new ReadSideAssembler(federation);

    const fact = await writer.admit('We decided the client demo is on Monday.');
    expect(fact.visibility).toBe('private');
    expect(fact.triage.scope).toBe('defer');
    expect(fact.triage.rule).toBeNull();
    expect(fact.triage.failure).toMatch(message);

    // And the window a shared task builds from this state is empty rather than wrong.
    expect(await shared.query('facts')).toEqual([]);
    expect(await assembler.assemble({ task: 'shared' })).toEqual([]);
  });
});

describe('the sixty labelled utterances, through the pair', () => {
  async function admitAll() {
    const w = world();
    for (const row of labels()) {
      await w.writer.admit(row.text, { id: row.id });
    }
    return w;
  }

  it('shows a shared task nothing that was labelled private, and half of what it could see', async () => {
    const { assembler } = await admitAll();
    const window = await assembler.assemble({ task: 'shared' });
    const byId = new Map(labels().map((row) => [row.id, row]));

    const leaked = window.filter((row) => byId.get(row.key ?? '')?.gold === 'private');
    const reachable = window.filter((row) => byId.get(row.key ?? '')?.gold === 'shared');

    expect(window).toHaveLength(4);
    expect(leaked).toHaveLength(0);
    expect(reachable).toHaveLength(4);
    // 4 of 8: the ceiling `[POC-5]` prices with a perfect card queue is 8 of 8 at zero leakage.
    expect(labels().filter((row) => row.gold === 'shared')).toHaveLength(8);
  });

  it('shows a private task everything admitted, from both stores, once each', async () => {
    const { assembler } = await admitAll();
    const window = await assembler.assemble({ task: 'private' });

    // 56 rows at home (12 private + 44 deferred) plus 4 in the shared store.
    expect(window).toHaveLength(60);
    expect(new Set(window.map((row) => row.key)).size).toBe(60);
    expect(window.filter((row) => row.origin === 'shared')).toHaveLength(4);
  });

  it('keeps every deferred fact out of the shared store entirely', async () => {
    const { shared } = await admitAll();
    const stored = await shared.query<AdmittedFact>('facts');
    expect(stored).toHaveLength(4);
    expect(stored.every((row) => row.visibility === 'shared')).toBe(true);
    expect(stored.some((row) => row.triage.scope === 'defer')).toBe(false);
  });

  it('preserves the text it was given, which is what a card will quote back', async () => {
    const { assembler } = await admitAll();
    const window = await assembler.assemble({ task: 'private' });
    const texts = new Set(window.map((row) => (row.value as AdmittedFact).text));
    expect(texts.size).toBe(60);
    expect(texts.has('')).toBe(false);
  });
});

describe('promote', () => {
  it('moves a deferred fact across the boundary and leaves the rule verdict alone', async () => {
    const { writer, assembler, local, shared } = world();
    const fact = await writer.admit('I usually review pull requests on Tuesday mornings.', {
      id: 'deferred',
    });
    expect(fact.triage.scope).toBe('defer');

    const promoted = await writer.promote('deferred', { now: 1_700_000_000_000 });
    expect(promoted.visibility).toBe('shared');
    expect(promoted.confirmedAt).toBe(1_700_000_000_000);
    // The triage record is history. A promoted row that claimed a rule fired for it would be a
    // false audit trail, and the audit trail is the reason the rule layer is defensible at all.
    expect(promoted.triage).toEqual(fact.triage);

    expect(await local.get('facts', 'deferred')).toBeUndefined();
    expect(await shared.get('facts', 'deferred')).toBeDefined();

    const window = await assembler.assemble({ task: 'shared' });
    expect(window.map((row) => row.key)).toEqual(['deferred']);
  });

  it('converges when the delete failed the first time', async () => {
    // The failure mode the write-then-delete ordering is chosen for. A retry must not throw
    // "already shared" and must not leave two copies behind.
    const local = new MemoryStorage();
    const shared = new MemoryStorage();
    const writer = new TriageWriter(new FederatedStorage({ private: local, shared }));

    const fact = await writer.admit('The team wiki has a page on incident reviews.', {
      id: 'twice',
    });
    expect(fact.visibility).toBe('private');

    // Simulate the partial failure exactly: the shared copy landed, the private one did not go away.
    await shared.put('facts', 'twice', { ...fact, visibility: 'shared' });
    expect(await local.get('facts', 'twice')).toBeDefined();

    const settled = await writer.promote('twice');
    expect(settled.id).toBe('twice');
    expect(await local.get('facts', 'twice')).toBeUndefined();
    expect((await shared.get<AdmittedFact>('facts', 'twice'))?.confirmedAt).toBeDefined();
  });

  it('is idempotent on a row that is already shared', async () => {
    const { writer } = world();
    await writer.admit('I keep a list of books I want to read on the train.', { id: 'already' });
    const first = await writer.promote('already');
    const second = await writer.promote('already');
    expect(second).toEqual(first);
    expect(second.confirmedAt).toBe(first.confirmedAt);
  });

  it('refuses an id that was never admitted, and says which operation can create one', async () => {
    const { writer } = world();
    await expect(writer.promote('ghost')).rejects.toBeInstanceOf(TriageError);
    await expect(writer.promote('ghost')).rejects.toThrow(/admitted first/);
  });

  const stuckCases: { name: string; reason: unknown; message: RegExp }[] = [
    { name: 'an Error', reason: new Error('database is locked'), message: /database is locked/ },
    { name: 'a primitive', reason: 'disk full', message: /disk full/ },
  ];

  it.each(stuckCases)(
    'says the row ended up in both stores when the delete fails with $name',
    async ({ reason, message }) => {
      // The store that cannot delete is the one the row lives in -- a second instance would be a
      // different, empty store, and the test would then be asserting the "no such fact" arm instead.
      const local = new RefusingDeleteStorage(reason);
      const shared = new MemoryStorage();
      const writer = new TriageWriter(new FederatedStorage({ private: local, shared }));
      await writer.admit('I moved my notes into a new folder on Tuesday.', { id: 'stuck' });

      await expect(writer.promote('stuck')).rejects.toThrow(/both stores/);
      await expect(writer.promote('stuck')).rejects.toThrow(message);
      // And the failure is the safe direction: a private task still reads the private copy, so the
      // promotion looks like it did not happen rather than the row disappearing.
      expect(await shared.get('facts', 'stuck')).toBeDefined();
      expect(await local.get('facts', 'stuck')).toBeDefined();
    },
  );
});

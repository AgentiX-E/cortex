/**
 * The card queue: five rules from the design, each tested where it can actually fail.
 *
 * ## What this file is defending
 *
 * `[POC-7]` measured the thing the queue exists for: on the turns a real run showed the reader,
 * 0.52% are shareable, so a shared fact has to be produced by a person saying yes. The danger in a
 * queue is not that it fails to publish; it is that it publishes something the user did not mean,
 * or that it keeps something they asked it to forget. Every test below is written against one of
 * those two.
 *
 * ## Why the clock is injected
 *
 * `decayMs` is 1,000 here. A test that waited six months for a real decay would not be run, and a
 * test that asserts `decayAt > Date.now()` would pass whatever the code did.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../../__tests__/support/memory-storage.js';
import { FederatedStorage } from '../../federation/federated-storage.js';
import { ReadSideAssembler } from '../../federation/read-side.js';
import { CardQueue } from '../card.js';
import { TriageError, TriageWriter, type AdmittedFact } from '../writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const START = 1_700_000_000_000;
const DECAY = 1_000;

/** Sentences that defer, chosen so that no rule matches them. */
const DEFERRED = 'I keep a list of books I want to read on the train.';
const ALSO_DEFERRED = 'The bookshop on the corner reopens next month.';

function world(start = START) {
  let now = start;
  const local = new MemoryStorage();
  const shared = new MemoryStorage();
  const federation = new FederatedStorage({ private: local, shared });
  const writer = new TriageWriter(federation);
  const queue = new CardQueue(federation, writer, { now: () => now, decayMs: DECAY });
  return {
    local,
    shared,
    writer,
    queue,
    assembler: new ReadSideAssembler(federation),
    advance(ms: number) {
      now += ms;
    },
  };
}

/**
 * A store that hands rows back in the opposite order to the one it was given.
 *
 * Needed because `MemoryStorage.query` sorts by key, which means the queue's own ordering is never
 * exercised by it: a test written against that double would pass with the sort deleted, because the
 * store had already done the work. This double makes the store's order *wrong* on purpose.
 */
class ReversedStorage extends MemoryStorage {
  override async query<T>(table: string, predicate?: Parameters<MemoryStorage['query']>[1]) {
    const rows = await super.query<T>(table, predicate);
    return rows.reverse();
  }
}

/** Every row in every table of both stores, serialised -- used to prove a string is nowhere. */
async function everything(w: ReturnType<typeof world>): Promise<string> {
  return JSON.stringify([
    await w.local.query('facts'),
    await w.local.query('cards'),
    await w.shared.query('facts'),
    await w.shared.query('cards'),
  ]);
}

async function openDeferral(w: ReturnType<typeof world>, id = 'c1', text = DEFERRED) {
  const admission = await w.writer.admit(text, { id });
  const card = await w.queue.open(admission);
  if (card === null) throw new Error('expected a card');
  return { admission, card };
}

describe('open', () => {
  it('turns a deferral into one question, with a sentence a person can read', async () => {
    const w = world();
    const { card } = await openDeferral(w);

    expect(card.state).toBe('proposed');
    expect(card.rule).toBeNull();
    expect(card.text).toBe(DEFERRED);
    expect(card.reason).toMatch(/Publishing it is your decision/);
    expect(card.createdAt).toBe(START);
  });

  it('opens nothing for a fact a rule already decided', async () => {
    // A rule answering the question is the same as no question. If decided rows also became cards,
    // the queue would hold 56 of 60 utterances and nobody would read it.
    const w = world();
    const privateAdmission = await w.writer.admit('My daughter has an appointment on Friday.', {
      id: 'p',
    });
    const sharedAdmission = await w.writer.admit('We decided the roadmap moves to Q3.', {
      id: 's',
    });

    expect(await w.queue.open(privateAdmission)).toBeNull();
    expect(await w.queue.open(sharedAdmission)).toBeNull();
    expect(await w.queue.list()).toEqual([]);
  });

  it('opens nothing for a credential, because nothing was stored to ask about', async () => {
    const w = world();
    const admission = await w.writer.admit('The password is correct-horse-battery-staple.', {
      id: 'secret',
    });

    expect(admission.stored).toBe(false);
    if (admission.stored) throw new Error('a credential must not be stored');
    expect(admission.withheld.rule).toBe('credential');
    expect(await w.queue.open(admission)).toBeNull();
    // The policy sentence is "never stored, not even as a card", and this is what enforcing it
    // looks like: the string is in neither store, in neither table.
    expect(await everything(w)).not.toContain('correct-horse-battery-staple');
  });

  it('says so when the rules could not run, instead of calling the sentence unremarkable', async () => {
    const federation = new FederatedStorage({
      private: new MemoryStorage(),
      shared: new MemoryStorage(),
    });
    const broken = new TriageWriter(federation, {
      classify: () => {
        throw new Error('compiled table is corrupt');
      },
    });
    const admission = await broken.admit(DEFERRED, { id: 'broken' });
    const card = await new CardQueue(federation, broken).open(admission);

    expect(card?.reason).toMatch(/could not classify/);
    expect(card?.reason).toMatch(/compiled table is corrupt/);
  });

  it('is idempotent, so re-opening does not un-decide a card', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await w.queue.accept(card.id);
    w.advance(5_000);

    const admission = await w.writer.admit(DEFERRED, { id: card.id });
    const again = await w.queue.open(admission);

    expect(again?.state).toBe('accepted');
    expect(again?.createdAt).toBe(START);
    expect(again?.decidedAt).toBe(START);
  });

  it('keeps the origin when the caller knows it', async () => {
    const w = world();
    const admission = await w.writer.admit(DEFERRED, { id: 'c1' });
    const card = await w.queue.open(admission, {
      origin: { sessionId: 's-9', turns: ['t-3', 't-4'] },
    });
    expect(card?.origin).toEqual({ sessionId: 's-9', turns: ['t-3', 't-4'] });
  });
});

describe('accept', () => {
  it('publishes the fact and closes the card', async () => {
    const w = world();
    const { card } = await openDeferral(w);

    const accepted = await w.queue.accept(card.id);
    expect(accepted.state).toBe('accepted');
    expect(accepted.decayAt).toBe(START + DECAY);

    const window = await w.assembler.assemble({ task: 'shared' });
    expect(window.map((row) => row.key)).toEqual([card.id]);
    // The rule layer's verdict is untouched: it said `defer`, and a person decided. A card that
    // rewrote `triage` to claim a rule fired would destroy the audit trail this whole layer rests on.
    const published = window[0]?.value as AdmittedFact;
    expect(published.triage.scope).toBe('defer');
    expect(published.confirmedAt).toBe(START);
    expect(await w.local.get('facts', card.id)).toBeUndefined();
  });

  it('is idempotent', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    const first = await w.queue.accept(card.id);
    w.advance(10);
    const second = await w.queue.accept(card.id);
    expect(second).toEqual(first);
  });

  it('refuses a dismissed card, and says that the refusal is the point', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await w.queue.dismiss(card.id);

    await expect(w.queue.accept(card.id)).rejects.toBeInstanceOf(TriageError);
    await expect(w.queue.accept(card.id)).rejects.toThrow(/terminal/);
  });

  it('refuses a stale card until it is refreshed', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await w.queue.accept(card.id);
    w.advance(DECAY + 1);
    await w.queue.expire();

    await expect(w.queue.accept(card.id)).rejects.toThrow(/refresh it first/);
  });
});

describe('edit', () => {
  it('publishes the edited sentence, and the fact carries the edited text', async () => {
    const w = world();
    const { card } = await openDeferral(w);

    const edited = await w.queue.edit(card.id, 'I review pull requests on Tuesday mornings.');
    expect(edited.state).toBe('edited');
    expect(edited.text).toBe('I review pull requests on Tuesday mornings.');

    const window = await w.assembler.assemble({ task: 'shared' });
    const published = window[0]?.value as AdmittedFact;
    expect(published.text).toBe('I review pull requests on Tuesday mornings.');
    expect(published.confirmedAt).toBe(START);
  });

  it('publishes an edit a rule now agrees with, and records the rule', async () => {
    // The opposite direction from a refusal: the user typed something organisational, so the rule
    // layer catches up with them. The promotion is the same call either way.
    const w = world();
    const { card } = await openDeferral(w);
    const edited = await w.queue.edit(card.id, 'We decided the sprint ends on Thursday.');

    expect(edited.state).toBe('edited');
    const published = (await w.assembler.assemble({ task: 'shared' }))[0]?.value as AdmittedFact;
    expect(published.triage.rule).toBe('org-knowledge');
  });

  it('refuses an edit that introduces a credential, and keeps the string nowhere', async () => {
    const w = world();
    const { card } = await openDeferral(w);

    const refused = await w.queue.edit(card.id, 'My api key is sk-live-9f2b41c7d0e8.');
    expect(refused.refused?.rule).toBe('credential');
    expect(refused.state).toBe('proposed');
    // The card keeps the sentence it had: the export includes cards, and a password typed into a
    // rejected edit is still a password.
    expect(refused.text).toBe(DEFERRED);

    expect(await w.shared.query('facts')).toEqual([]);
    expect(await everything(w)).not.toContain('sk-live-9f2b41c7d0e8');
  });

  it('refuses an edit that introduces a protected identifier, and keeps the old text', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    const refused = await w.queue.edit(card.id, 'Send the deck to dana.reyes@example.com.');

    expect(refused.refused?.rule).toBe('strong-pii');
    expect(refused.refused?.policy).toMatch(/regulated by form/);
    expect((await w.local.get<AdmittedFact>('facts', card.id))?.text).toBe(DEFERRED);
    expect(await w.shared.query('facts')).toEqual([]);
  });

  it('rejects a blank edit and one on a card that is already closed', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await expect(w.queue.edit(card.id, '   ')).rejects.toBeInstanceOf(TypeError);

    await w.queue.accept(card.id);
    await expect(w.queue.edit(card.id, ALSO_DEFERRED)).rejects.toThrow(/only a proposed card/);
  });

  it('cannot be used to edit a card that was dismissed', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await w.queue.dismiss(card.id);
    await expect(w.queue.edit(card.id, ALSO_DEFERRED)).rejects.toThrow(/dismissed/);
  });
});

describe('dismiss', () => {
  it('is terminal, and is idempotent', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    const first = await w.queue.dismiss(card.id);
    const second = await w.queue.dismiss(card.id);

    expect(first.state).toBe('dismissed');
    expect(second).toEqual(first);
    expect(await w.shared.query('facts')).toEqual([]);
    // Still on the record: the export is the audit surface, and an export that hides the refusals
    // is a brochure.
    expect((await w.queue.list()).map((entry) => entry.state)).toEqual(['dismissed']);
  });

  it('cannot withdraw a published fact, and says which operation that would be', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await w.queue.accept(card.id);
    await expect(w.queue.dismiss(card.id)).rejects.toThrow(/different operation/);
  });
});

describe('expire and refresh', () => {
  it('does nothing before the interval has passed', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await w.queue.accept(card.id);
    w.advance(DECAY - 1);

    expect(await w.queue.expire()).toEqual([]);
    expect(await w.assembler.assemble({ task: 'shared' })).toHaveLength(1);
  });

  it('withdraws the fact from retrieval, in both windows, until it is refreshed', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await w.queue.accept(card.id);
    w.advance(DECAY + 1);

    const expired = await w.queue.expire();
    expect(expired.map((entry) => entry.state)).toEqual(['stale']);
    // The read side is where the rule is enforced. A card that is not filtered out of the window
    // is a checkbox, not a control.
    expect(await w.assembler.assemble({ task: 'shared' })).toEqual([]);
    expect(await w.assembler.assemble({ task: 'private' })).toEqual([]);

    const refreshed = await w.queue.refresh(card.id);
    expect(refreshed.state).toBe('accepted');
    expect(refreshed.decayAt).toBe(START + DECAY + 1 + DECAY);
    expect(await w.assembler.assemble({ task: 'shared' })).toHaveLength(1);
  });

  it('leaves cards that are still questions alone', async () => {
    // Only a confirmed fact can expire. Sweeping a proposed card would close a question the user
    // has not answered, which is the queue deciding on their behalf.
    const w = world();
    const { card } = await openDeferral(w, 'open-one');
    await openDeferral(w, 'accepted-one', ALSO_DEFERRED);
    await w.queue.accept('accepted-one');
    w.advance(DECAY + 1);

    const expired = await w.queue.expire();
    expect(expired.map((entry) => entry.id)).toEqual(['accepted-one']);
    expect((await w.queue.get(card.id))?.state).toBe('proposed');
  });

  it('leaves a card written before deadlines existed alone', async () => {
    // A row from an earlier release has `state: 'accepted'` and no `decayAt`. Sweeping it on sight
    // would withdraw every previously confirmed fact on the upgrade -- the same mistake as reading
    // a missing `stale` flag as stale.
    const w = world();
    await w.local.put('cards', 'legacy', {
      id: 'legacy',
      text: 'confirmed before deadlines existed',
      state: 'accepted',
      reason: 'r',
      rule: null,
      createdAt: START,
      updatedAt: START,
    });

    expect(await w.queue.expire()).toEqual([]);
    expect((await w.queue.get('legacy'))?.state).toBe('accepted');
  });

  it('refuses to refresh a card that is not stale', async () => {
    const w = world();
    const { card } = await openDeferral(w);
    await expect(w.queue.refresh(card.id)).rejects.toThrow(/only a stale card/);
  });

  it('keeps a row without the flag live, so an upgrade does not empty a store', async () => {
    // Rows written before `stale` existed have no field. A reader that treated "unknown" as stale
    // would silently stop answering from every existing memory on the day this shipped.
    const w = world();
    await w.shared.put('facts', 'old', { id: 'old', text: 'from before', visibility: 'shared' });
    expect(await w.assembler.assemble({ task: 'shared' })).toHaveLength(1);
  });
});

describe('export', () => {
  it('lists every card, including the dismissed ones, and escapes the table', async () => {
    const w = world();
    await openDeferral(w, 'keep', DEFERRED);
    await openDeferral(w, 'drop', ALSO_DEFERRED);
    await w.queue.dismiss('drop');

    const markdown = await w.queue.toMarkdown();
    expect(markdown).toContain('2 card(s): 1 proposed, 1 dismissed.');
    expect(markdown).toContain('`keep`');
    expect(markdown).toContain('`drop`');
  });

  it('escapes a pipe in the text rather than breaking the table', async () => {
    const w = world();
    await openDeferral(w, 'piped', 'I like tea | coffee, depending on the hour.');
    const markdown = await w.queue.toMarkdown();
    expect(markdown).toContain('tea \\| coffee');
    expect(markdown.split('\n').filter((line) => line.startsWith('| `piped`'))).toHaveLength(1);
  });

  it('imposes its own order on a store that returns rows in another one', async () => {
    // The queue's contract is that `list()` is ordered, not that the store happens to be. This is
    // also the only test that drives both arms of the tie-break: a store that sorts has already
    // answered "less than" for us.
    const local = new ReversedStorage();
    const shared = new MemoryStorage();
    const federation = new FederatedStorage({ private: local, shared });
    let now = START;
    const writer = new TriageWriter(federation);
    const queue = new CardQueue(federation, writer, { now: () => now, decayMs: DECAY });

    await queue.open(await writer.admit(DEFERRED, { id: 'y' }));
    await queue.open(await writer.admit(ALSO_DEFERRED, { id: 'x' }));
    now = START + 1;
    await queue.open(
      await writer.admit('The bookshop on the corner reopens next month.', { id: 'b' }),
    );
    await queue.open(
      await writer.admit('I usually review pull requests on Tuesday mornings.', { id: 'a' }),
    );

    expect((await queue.list()).map((card) => card.id)).toEqual(['x', 'y', 'a', 'b']);
  });

  it('orders by when a card was raised, not by its id', async () => {
    const w = world();
    await openDeferral(w, 'z-first', DEFERRED);
    w.advance(10);
    await openDeferral(w, 'a-second', ALSO_DEFERRED);

    expect((await w.queue.list()).map((card) => card.id)).toEqual(['z-first', 'a-second']);
  });

  it('exports the same order twice, and the same content as data', async () => {
    const w = world();
    // Three cards in the same millisecond: without the id tie-break the order would be whatever the
    // store happened to return, and every export would be a diff. Three rather than two so that the
    // comparator is exercised in both directions -- a sort of two elements can get away with one.
    // Inserted in ascending order and then descending, so the comparator is driven in both
    // directions: a sort given already-sorted input only ever answers "greater".
    for (const id of ['a', 'b', 'c', 'y', 'x']) await openDeferral(w, id, DEFERRED);

    const first = await w.queue.toMarkdown();
    const second = await w.queue.toMarkdown();
    expect(first).toBe(second);
    expect((await w.queue.toJSON()).map((card) => card.id)).toEqual(['a', 'b', 'c', 'x', 'y']);
  });
});

describe('a user who accepts every card', () => {
  it('reaches seven of the eight shareable facts and publishes none that was private', async () => {
    // `[POC-5]` priced the ceiling at 8/8 with zero leakage using an **oracle**. This is an ordinary
    // user who accepts everything, and it gets to 7/8: the eighth ("a 5 km walk with my colleagues")
    // is held private by `health`, so it never becomes a question and no card can publish it.
    //
    // The first run of this test published three gold-private facts, because private recall was
    // 9/12 and all three misses were exercise or diet phrasing. That is what the widening in
    // `rules.ts` was for; recall is 12/12 now and nothing private is published. The number this
    // test can no longer show is the one worth remembering: accept-all used to leak 3 of 12.
    const w = world();
    const rows = JSON.parse(readFileSync(join(HERE, 'fixtures', 'triage-labels.json'), 'utf8')) as {
      rows: { id: string; text: string; gold: 'private' | 'shared' | 'defer' }[];
    };

    for (const row of rows.rows) {
      const admission = await w.writer.admit(row.text, { id: row.id });
      const card = await w.queue.open(admission);
      if (card !== null) await w.queue.accept(card.id);
    }

    const window = await w.assembler.assemble({ task: 'shared' });
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const leaked = window.filter((row) => byId.get(row.key ?? '')?.gold === 'private');
    const reachable = window.filter((row) => byId.get(row.key ?? '')?.gold === 'shared');

    expect(reachable).toHaveLength(7);
    expect(leaked).toHaveLength(0);
    // 45 published: the 4 the shared rule caught, plus all 41 deferrals -- of which 40 are labelled
    // `defer`, meaning "no opinion" rather than "private". That the count is 45 and not 7 is the
    // honest shape of a queue this size: the queue is not a filter, it is the product.
    expect(window).toHaveLength(45);
  });

  it('catches every private fact the rules used to miss, and names the rule', async () => {
    // A regression test for the widening. These three were gold-private with no rule matching, so
    // accepting every card published them. A count without the rows would not have told anyone
    // which rule to widen.
    const w = world();
    const rows = JSON.parse(readFileSync(join(HERE, 'fixtures', 'triage-labels.json'), 'utf8')) as {
      rows: { id: string; text: string; gold: 'private' | 'shared' | 'defer' }[];
    };

    const caught: [string, string][] = [];
    for (const row of rows.rows) {
      if (row.gold !== 'private') continue;
      const admission = await w.writer.admit(row.text, { id: row.id });
      caught.push([row.id, admission.triage.rule ?? 'defer']);
    }

    expect(caught.filter(([, rule]) => rule === 'defer')).toEqual([]);
    expect(caught.filter(([id]) => ['g16', 'g49', 'g59'].includes(id))).toEqual([
      ['g16', 'health'],
      ['g49', 'health'],
      ['g59', 'health'],
    ]);
  });
});

describe('the queue and the writer agree on what exists', () => {
  it('refuses a card id that was never opened', async () => {
    const w = world();
    await expect(w.queue.accept('ghost')).rejects.toThrow(/no card/);
    await expect(w.queue.dismiss('ghost')).rejects.toThrow(/no card/);
    await expect(w.queue.get('ghost')).resolves.toBeUndefined();
  });
});

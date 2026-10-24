/**
 * The door out of the private store, and the three things that make it a door and not a hole.
 *
 * ## What this file is written against
 *
 * Step 6 found that a sentence the rules judge private never becomes a card, so the owner has no way
 * to change their mind about it: `g42` -- a health sentence -- sat in the private store forever.
 * Every other boundary in this product has a path across it; that one had none.
 *
 * A path is safe here only if it is *recorded*, *deliberate* and *separate*, and those three words
 * are the three groups of tests below:
 *
 *  1. **deliberate**: `release()` refuses without the token, and refuses the *right* thing first --
 *     a deferral is a question (use a card), a ruleless row has no policy to override, and only then
 *     does the token matter. A caller should never be told "wrong token" about a row that could not
 *     have been released at all.
 *  2. **recorded**: the release writes its record *before* the row moves, so a crash leaves an
 *     incomplete record and a private row rather than a published one with no trace. This is the
 *     one arm that cannot be exercised through the happy path, so the store is made to fail.
 *  3. **separate**: the record is in its own table, the row keeps the rule that fired, and
 *     `confirmedAt` is not set -- an override is not an acceptance, and a reader that could not tell
 *     them apart would look for a card that never existed.
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../../__tests__/support/memory-storage.js';
import { FederatedStorage } from '../../federation/federated-storage.js';
import { ReadSideAssembler } from '../../federation/read-side.js';
import { RELEASE_TOKEN, digestOf, type ReleaseRecord } from '../release.js';
import { TriageError, TriageWriter } from '../writer.js';

const HEALTH = 'My therapist moved me to a new medication last week.';
const CREDENTIAL = 'My password is hunter2.';
const DEFERRED = 'I moved to Berlin in March and now I work at Acme on the payments team.';

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

/** A shared store whose writes fail, to reach the crash arm between the record and the move. */
class RefusingWriteStorage extends MemoryStorage {
  override async put(): Promise<void> {
    throw new Error('the shared store is read-only');
  }
}

describe('the refusal comes before the token', () => {
  it('will not release a deferral, and says what to use instead', async () => {
    const { writer } = world();
    await writer.admit(DEFERRED, { id: 'd1' });
    await expect(writer.release('d1', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
      /was deferred, not judged private.*card queue is how it is answered/s,
    );
  });

  it('will not release a row whose verdict is private but carries no policy', async () => {
    // A rule id with no policy sentence is the shape an injected table produces. There is nothing to
    // show the person, and a warning with a blank policy is a warning that says nothing.
    const federation = new FederatedStorage({
      private: new MemoryStorage(),
      shared: new MemoryStorage(),
    });
    const odd = new TriageWriter(federation, {
      classify: () => ({ scope: 'private', rule: 'health', policy: null }),
    });
    await odd.admit(HEALTH, { id: 'h3' });
    await expect(odd.release('h3', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
      /no rule id or no policy sentence/,
    );
  });

  it('will not release a row whose private verdict carries no rule', async () => {
    const { writer } = world();
    await writer.admit(HEALTH, { id: 'h1', now: 1 });
    // An injected table can return `private` with no rule id; that row has no policy to override and
    // no warning to show, which makes it a classifier defect rather than a decision.
    const federation = new FederatedStorage({
      private: new MemoryStorage(),
      shared: new MemoryStorage(),
    });
    const odd = new TriageWriter(federation, {
      classify: () => ({ scope: 'private', rule: null, policy: null }),
    });
    await odd.admit(HEALTH, { id: 'h2' });
    await expect(odd.release('h2', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
      /carries no rule id or no policy sentence/,
    );
  });

  it('will not release a row that was never stored, which is every credential', async () => {
    // `retention: 'never'` means there is no row to override -- the policy is enforced at admission,
    // and a release path that could resurrect it would undo that.
    const { writer } = world();
    const admission = await writer.admit(CREDENTIAL, { id: 'c1' });
    expect(admission.stored).toBe(false);
    await expect(writer.release('c1', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
      /no private fact with id "c1"/,
    );
  });
});

describe('the token', () => {
  it('refuses an empty acknowledgement with the warning, not with a scold', async () => {
    const { writer, local } = world();
    await writer.admit(HEALTH, { id: 'h1' });
    const failure = writer.release('h1', { acknowledge: '' });
    await expect(failure).rejects.toThrow(TriageError);
    const message = await failure.catch((error: Error) => error.message);
    // The message is the warning: the rule, its policy sentence, the wording, and the token.
    expect(message).toContain('rule');
    expect(message).toContain('policy:');
    expect(message).toContain(HEALTH);
    expect(message).toContain(RELEASE_TOKEN);
    // And nothing moved.
    expect(await local.query('facts')).toHaveLength(1);
  });

  it('refuses a token that is merely close', async () => {
    const { writer } = world();
    await writer.admit(HEALTH, { id: 'h1' });
    for (const wrong of ['rule_override', 'Rule-Override', 'yes', 'true']) {
      await expect(writer.release('h1', { acknowledge: wrong })).rejects.toThrow(TriageError);
    }
  });
});

describe('a completed release', () => {
  it('moves the row, keeps the rule, and records why it was allowed', async () => {
    const { writer, local, shared, assembler } = world();
    await writer.admit(HEALTH, { id: 'h1', now: 100 });

    const { record, fact } = await writer.release('h1', { acknowledge: RELEASE_TOKEN, now: 200 });

    // The row crossed, and it says so with its own field -- not with `confirmedAt`.
    expect(fact.visibility).toBe('shared');
    expect(fact.releasedAt).toBe(200);
    expect(fact.confirmedAt).toBeUndefined();
    // The rule layer's verdict is history and is not rewritten: an auditor must still see what
    // fired, even though the owner overrode it.
    expect(fact.triage.rule).toBe('health');
    expect(fact.triage.scope).toBe('private');

    expect(await local.query('facts')).toHaveLength(0);
    expect(await shared.query('facts')).toHaveLength(1);
    // A shared task now reads it, which is the whole point of the door.
    const window = await assembler.assemble({ task: 'shared' });
    expect(window.map((row) => `${row.origin}:${row.key}`)).toEqual(['shared:h1']);

    expect(record).toMatchObject({
      id: 'h1',
      rule: 'health',
      text: HEALTH,
      digestAlgorithm: 'sha-256',
      acknowledged: RELEASE_TOKEN,
      releasedAt: 200,
      completedAt: 200,
    });
    expect(record.digest).toBe(await digestOf(HEALTH));
    expect(record.digest).toHaveLength(64);
  });

  it('keeps the record in the private store, where a shared task cannot read it', async () => {
    const { writer, local, shared } = world();
    await writer.admit(HEALTH, { id: 'h1' });
    await writer.release('h1', { acknowledge: RELEASE_TOKEN });

    // The audit trail is the owner's, not a colleague's: what was overridden is not part of what a
    // shared task gets to know about the person.
    expect(await local.query('releases')).toHaveLength(1);
    expect(await shared.query('releases')).toHaveLength(0);
  });

  it('is idempotent, because a retry is not a second decision', async () => {
    const { writer } = world();
    await writer.admit(HEALTH, { id: 'h1', now: 100 });
    const first = await writer.release('h1', { acknowledge: RELEASE_TOKEN, now: 200 });
    const second = await writer.release('h1', { acknowledge: RELEASE_TOKEN, now: 300 });

    expect(second.record).toEqual(first.record);
    expect(await writer.releases()).toHaveLength(1);
  });

  it('returns them newest last, whatever order the store hands them back in', async () => {
    // The store returns rows in key order, and a key is not a clock. `b` released before `a` must
    // come out as [b, a] -- which is the case that makes the comparator take its `1` arm, the one a
    // release-in-insertion-order test can never reach.
    const { writer } = world();
    await writer.admit(HEALTH, { id: 'a' });
    await writer.admit('I spent 300 dollars on a bike.', { id: 'b' });
    await writer.release('a', { acknowledge: RELEASE_TOKEN, now: 20 });
    await writer.release('b', { acknowledge: RELEASE_TOKEN, now: 10 });
    expect((await writer.releases()).map((record) => record.id)).toEqual(['b', 'a']);
  });

  it('and the other way round, when the keys and the clock agree', async () => {
    const { writer } = world();
    await writer.admit(HEALTH, { id: 'a' });
    await writer.admit('I spent 300 dollars on a bike.', { id: 'b' });
    await writer.release('a', { acknowledge: RELEASE_TOKEN, now: 10 });
    await writer.release('b', { acknowledge: RELEASE_TOKEN, now: 20 });
    expect((await writer.releases()).map((record) => record.id)).toEqual(['a', 'b']);
  });
});

describe('a release that does not complete', () => {
  it('leaves an incomplete record and a private row, never a silent publication', async () => {
    // The shared store refuses the write. What must not happen: a record that says "released" with
    // no row to show for it, or a shared row with no record saying why.
    const local = new MemoryStorage();
    const federation = new FederatedStorage({ private: local, shared: new RefusingWriteStorage() });
    const writer = new TriageWriter(federation);
    await writer.admit(HEALTH, { id: 'h1' });

    await expect(writer.release('h1', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
      /shared store is read-only/,
    );

    const record = (await local.query<ReleaseRecord>('releases'))[0];
    expect(record).toMatchObject({ id: 'h1', completedAt: null });
    // Still private, so the next attempt is a release rather than an idempotent no-op.
    expect(await local.query('facts')).toHaveLength(1);
    await expect(writer.release('h1', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(/read-only/);
  });

  it('names the runtime when SHA-256 is missing instead of writing a weaker digest', async () => {
    // A record that claims `sha-256` while holding something else is worse than no record: the
    // label is the part an auditor trusts.
    const { writer } = world();
    await writer.admit(HEALTH, { id: 'h1' });
    const subtle = globalThis.crypto.subtle;
    try {
      Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
      await expect(writer.release('h1', { acknowledge: RELEASE_TOKEN })).rejects.toThrow(
        /SHA-256 is unavailable in this runtime/,
      );
    } finally {
      Object.defineProperty(globalThis.crypto, 'subtle', { value: subtle, configurable: true });
    }
  });
});

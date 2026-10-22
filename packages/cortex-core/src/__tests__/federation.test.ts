/**
 * The federated router: nine assertions carried over from `POC-3`.
 *
 * ## Why these nine
 *
 * They are the assertions that were written before this code existed, against a prototype in the
 * design repository, and each one corresponds to a way the boundary can fail rather than to a
 * line of implementation. Two of them assert that an operation is **refused** -- a cross-store
 * transaction and an unknown scope -- because a router that quietly approximated either would be
 * worse than one that does not offer them.
 *
 * The prototype also found two of its own defects, and the tests below keep them fixed:
 *
 *   * the first draft had an `async () => true` assertion, which cannot fail. It was deleted, and
 *     every assertion here is written so that a plausible defect makes it red;
 *   * the first draft passed prefixed table names straight through to the stores, so
 *     `queryAcross` read `private/facts` inside a store that held `facts` and returned nothing.
 *     The prefix is a routing marker, and the second test pins that.
 */

import { describe, expect, it } from 'vitest';

import { FederatedStorage, FederationError, scopeOf } from '../federation/federated-storage.js';
import { MemoryStorage } from './support/memory-storage.js';

function newFederation(): {
  federation: FederatedStorage;
  local: MemoryStorage;
  shared: MemoryStorage;
} {
  const local = new MemoryStorage();
  const shared = new MemoryStorage();
  return { federation: new FederatedStorage({ private: local, shared }), local, shared };
}

describe('federated storage', () => {
  it('routes by prefix, and treats an unprefixed table as private', async () => {
    const { federation, local, shared } = newFederation();

    await federation.put('facts', 'plain', { id: 'plain' });
    await federation.put('private/facts', 'mine', { id: 'mine' });
    await federation.put('shared/facts', 'ours', { id: 'ours' });

    // The prefix is a routing marker, not part of the name inside the store: the shared store
    // must hold `facts`, not `shared/facts`. The prototype's first draft got this wrong and every
    // cross-store read came back empty.
    expect(await local.get('facts', 'plain')).toEqual({ id: 'plain' });
    expect(await local.get('facts', 'mine')).toEqual({ id: 'mine' });
    expect(await shared.get('facts', 'ours')).toEqual({ id: 'ours' });
    expect(scopeOf('facts')).toBe('private');
    expect(scopeOf('shared/facts')).toBe('shared');
  });

  it('keeps a private write invisible to a shared query', async () => {
    const { federation } = newFederation();
    await federation.put('private/facts', 'secret', { id: 'secret' });

    expect(await federation.query('shared/facts')).toEqual([]);
    expect(await federation.query('private/facts')).toEqual([{ id: 'secret' }]);
  });

  it('labels every row with the store it came from', async () => {
    const { federation } = newFederation();
    await federation.put('private/facts', 'a', { id: 'a' });
    await federation.put('shared/facts', 'b', { id: 'b' });

    const rows = await federation.queryAcross('facts');
    expect(rows.map((row) => [row.origin, row.key])).toEqual([
      ['private', 'a'],
      ['shared', 'b'],
    ]);
  });

  it('leaves a row without an id unkeyed rather than inventing one', async () => {
    // The positional fallback (`#0`) was the obvious shortcut and is wrong: position 0 in two
    // stores is two different rows. An unkeyed row is honest; a wrong key is not.
    const { federation } = newFederation();
    await federation.put('private/facts', 'x', { text: 'no id here' });

    const rows = await federation.queryAcross('facts');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBeUndefined();
  });

  it('deletes from one scope only', async () => {
    const { federation } = newFederation();
    await federation.put('shared/facts', 'gone', { id: 'gone' });
    await federation.put('private/facts', 'kept', { id: 'kept' });

    await federation.del('shared/facts', 'gone');

    const rows = await federation.queryAcross('facts');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe('private');
  });

  it('expires a ttl per store, so one clock cannot expire the other side', async () => {
    const { federation } = newFederation();
    await federation.put('shared/facts', 'temp', { id: 'temp' }, { ttlMs: 5 });
    await federation.put('private/facts', 'perm', { id: 'perm' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = await federation.queryAcross('facts');
    expect(rows.map((row) => row.key)).toEqual(['perm']);
  });

  it('refuses a federated transaction instead of faking one', async () => {
    const { federation } = newFederation();

    await expect(federation.transaction(async () => 1)).rejects.toBeInstanceOf(FederationError);
    // The message has to name the alternative, or the caller is left to guess.
    await expect(federation.transaction(async () => 1)).rejects.toThrow(/transactionIn/);
  });

  it('refuses an unknown scope', async () => {
    const { federation } = newFederation();
    await expect(federation.transactionIn('both' as never, async () => 1)).rejects.toBeInstanceOf(
      FederationError,
    );
  });

  it('runs a scoped transaction for real, including its rollback', async () => {
    const { federation } = newFederation();

    await federation
      .transactionIn('private', async (tx) => {
        await tx.put('private/facts', 'rolled', { id: 'rolled' });
        throw new Error('abort');
      })
      .catch(() => undefined);

    expect(await federation.get('private/facts', 'rolled')).toBeUndefined();

    await federation.transactionIn('private', async (tx) => {
      await tx.put('private/facts', 'kept', { id: 'kept' });
    });
    expect(await federation.get('private/facts', 'kept')).toEqual({ id: 'kept' });
  });

  it('refuses a table that routes to the other side, inside a scoped transaction', async () => {
    // Writing to the shared store from inside a private transaction means the caller believes
    // something about the boundary that is not true. Refusing here is cheaper than discovering it
    // as a leak, and the refusal must not leave a half-write behind.
    const { federation } = newFederation();

    await expect(
      federation.transactionIn('private', async (tx) => {
        await tx.put('shared/facts', 'wrong', { id: 'wrong' });
      }),
    ).rejects.toBeInstanceOf(FederationError);

    expect(await federation.get('shared/facts', 'wrong')).toBeUndefined();
    expect(await federation.get('private/facts', 'wrong')).toBeUndefined();
  });

  it('reads and deletes inside a scoped transaction', async () => {
    const { federation } = newFederation();
    await federation.put('private/facts', 'before', { id: 'before' });

    const seen = await federation.transactionIn('private', async (tx) => {
      const value = await tx.get<{ id: string }>('private/facts', 'before');
      await tx.del('private/facts', 'before');
      return value;
    });

    expect(seen).toEqual({ id: 'before' });
    expect(await federation.get('private/facts', 'before')).toBeUndefined();
  });

  it('reports which store a table routes to', async () => {
    const { federation, local, shared } = newFederation();
    expect(federation.storeFor('shared/facts')).toBe(shared);
    expect(federation.storeFor('private/facts')).toBe(local);
    expect(federation.storeFor('facts')).toBe(local);
  });

  it('treats a non-string id as no identity at all', async () => {
    // `{ id: 42 }` is not an identity this router can match on, and guessing one would merge
    // unrelated rows the moment two facts happened to share a number.
    const { federation } = newFederation();
    await federation.put('private/facts', 'numbered', { id: 42 });

    const rows = await federation.queryAcross('facts');
    expect(rows[0]?.key).toBeUndefined();
  });

  it('closes both halves', async () => {
    const { federation, local, shared } = newFederation();
    await federation.close();
    expect(local.isClosed).toBe(true);
    expect(shared.isClosed).toBe(true);
  });
});

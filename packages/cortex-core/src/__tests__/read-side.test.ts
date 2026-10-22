/**
 * The read side, carried over from `POC-5` and translated into the terms the product uses.
 *
 * ## The property, one sentence
 *
 * A shared task must not be able to read a private row, **and** it must refuse to assemble a
 * window that contains one anyway -- because the second failure is a write-side defect and
 * filtering it would hide the defect while making the boundary look intact.
 *
 * ## Why the guard is tested by injection
 *
 * While the writer is correct, rule 1 ("shared tasks read one store") already prevents leakage,
 * so a clean run says nothing about rule 2. The only way to show that the guard is load-bearing
 * is to break the writer on purpose -- put a private row into the shared store, bypassing the
 * router -- and then check both directions: with the guard on it throws, with the guard off the
 * same row reaches the window. The prototype's first draft for this had an `async () => true`
 * assertion; this file is what replaced that habit.
 */

import { describe, expect, it } from 'vitest';

import { FederatedStorage } from '../federation/federated-storage.js';
import { ReadSideAssembler, ScopeViolation } from '../federation/read-side.js';
import { MemoryStorage } from './support/memory-storage.js';

type Fact = { id: string; text: string; visibility?: 'private' | 'shared' };

function newWorld(): {
  federation: FederatedStorage;
  local: MemoryStorage;
  shared: MemoryStorage;
} {
  const local = new MemoryStorage();
  const shared = new MemoryStorage();
  return { federation: new FederatedStorage({ private: local, shared }), local, shared };
}

const fact = (id: string, visibility: 'private' | 'shared'): Fact => ({
  id,
  text: `fact ${id}`,
  visibility,
});

describe('read-side assembler', () => {
  it('builds a shared window from the shared store only', async () => {
    const { federation } = newWorld();
    await federation.put('private/facts', 'p1', fact('p1', 'private'));
    await federation.put('shared/facts', 's1', fact('s1', 'shared'));

    const rows = await new ReadSideAssembler(federation).assemble({ task: 'shared' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('s1');
    expect(rows[0]?.origin).toBe('shared');
  });

  it('gives a private task both stores, deduped, with the owner copy winning', async () => {
    const { federation } = newWorld();
    // The same fact exists in both stores: the owner's copy is authoritative, so the private
    // origin must survive the merge rather than depending on iteration order.
    await federation.put('private/facts', 'both', fact('both', 'private'));
    await federation.put('shared/facts', 'both', fact('both', 'shared'));
    await federation.put('private/facts', 'only-mine', fact('only-mine', 'private'));

    const rows = await new ReadSideAssembler(federation).assemble({ task: 'private' });
    const byKey = new Map(rows.map((row) => [row.key, row.origin]));

    expect(rows).toHaveLength(2);
    expect(byKey.get('both')).toBe('private');
    expect(byKey.get('only-mine')).toBe('private');
  });

  it('keeps a row without an id instead of collapsing it', async () => {
    // Two rows that cannot be proven identical must not be merged. A positional key would have
    // merged them and nobody would have noticed until a fact vanished.
    const { federation } = newWorld();
    await federation.put('private/facts', 'a', { text: 'no id' });
    await federation.put('shared/facts', 'b', { text: 'no id either', visibility: 'shared' });

    const rows = await new ReadSideAssembler(federation).assemble({ task: 'private' });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.key === undefined)).toBe(true);
  });

  it('labels every assembled row with its origin', async () => {
    const { federation } = newWorld();
    await federation.put('shared/facts', 's1', fact('s1', 'shared'));
    await federation.put('private/facts', 'p1', fact('p1', 'private'));

    const assembler = new ReadSideAssembler(federation);
    const rows = [
      ...(await assembler.assemble({ task: 'shared' })),
      ...(await assembler.assemble({ task: 'private' })),
    ];

    expect(rows.every((row) => row.origin === 'private' || row.origin === 'shared')).toBe(true);
  });

  it('refuses to assemble a shared window containing a row that is not shared', async () => {
    const { federation, shared } = newWorld();
    await federation.put('shared/facts', 'leak', fact('leak', 'private'));

    await expect(new ReadSideAssembler(federation).assemble({ task: 'shared' })).rejects.toThrow(
      ScopeViolation,
    );
    // The refusal names the offending row, because "some row is wrong" is not actionable.
    await expect(new ReadSideAssembler(federation).assemble({ task: 'shared' })).rejects.toThrow(
      /leak/,
    );
    // And the row is still there: refusing is not the same as deleting evidence of the defect.
    expect(await shared.get('facts', 'leak')).toBeDefined();
  });

  it('without the guard the same injection reaches the window', async () => {
    // This is the ablation, and it is the reason the guard's clean-run pass is not evidence.
    const { federation } = newWorld();
    await federation.put('shared/facts', 'leak', fact('leak', 'private'));

    const rows = await new ReadSideAssembler(federation, { guard: false }).assemble({
      task: 'shared',
    });
    expect(rows.map((row) => row.key)).toEqual(['leak']);
  });

  it('treats a row with no declared visibility as not shareable', async () => {
    // The failure this prevents: a schema change dropping `visibility` and every row silently
    // becoming shareable. Unknown must fail closed.
    const { federation } = newWorld();
    await federation.put('shared/facts', 'unknown', { id: 'unknown', text: 'no visibility field' });

    await expect(new ReadSideAssembler(federation).assemble({ task: 'shared' })).rejects.toThrow(
      ScopeViolation,
    );
  });

  it('accepts a caller-supplied visibility reader instead of knowing the row shape', async () => {
    // The product does not parse any dataset's format; a caller whose rows say `scope` rather
    // than `visibility` supplies the reader rather than teaching this class a second schema.
    const { federation } = newWorld();
    await federation.put('shared/facts', 's1', { id: 's1', scope: 'shared' });

    const rows = await new ReadSideAssembler(federation, {
      visibilityOf: (value) => (value as { scope?: string }).scope,
    }).assemble({ task: 'shared' });

    expect(rows).toHaveLength(1);
  });

  it('passes a shared row without an id through with no key', async () => {
    // The shared path tags rows too, and it has the same fallback: a row that cannot be
    // identified is still a row, and dropping its key is better than inventing one.
    const { federation } = newWorld();
    await federation.put('shared/facts', 'anonymous', { text: 'no id', visibility: 'shared' });

    const rows = await new ReadSideAssembler(federation).assemble({ task: 'shared' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBeUndefined();
    expect(rows[0]?.origin).toBe('shared');
  });

  it('names an unidentifiable offender in the refusal', async () => {
    // The message has to be actionable even when the row has no id -- "<no id>" is worse than a
    // key but better than a refusal that says nothing about which row to look at.
    const { federation } = newWorld();
    await federation.put('shared/facts', 'a', { text: 'private, no id', visibility: 'private' });

    await expect(new ReadSideAssembler(federation).assemble({ task: 'shared' })).rejects.toThrow(
      /<no id>/,
    );
  });

  it('refuses an unknown task scope', async () => {
    const { federation } = newWorld();
    await expect(
      new ReadSideAssembler(federation).assemble({ task: 'both' as never }),
    ).rejects.toThrow(ScopeViolation);
  });

  it('assembles deterministically across two passes', async () => {
    const { federation } = newWorld();
    await federation.put('private/facts', 'p1', fact('p1', 'private'));
    await federation.put('shared/facts', 's1', fact('s1', 'shared'));
    await federation.put('private/facts', 'p2', fact('p2', 'private'));

    const assembler = new ReadSideAssembler(federation);
    const first = (await assembler.assemble({ task: 'private' })).map((row) => row.key);
    const second = (await assembler.assemble({ task: 'private' })).map((row) => row.key);

    expect(first).toEqual(second);
  });
});

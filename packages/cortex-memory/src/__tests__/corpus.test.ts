/**
 * The corpus, against a real store.
 *
 * ## What this file is defending
 *
 * Three properties, and each one fails in a way that produces a plausible-looking corpus rather than an
 * error:
 *
 * 1. **A replay does not double the transcript.** Restarting a process appends the same turns again, and a
 *    corpus that grew on every restart would answer questions from a transcript nobody had.
 * 2. **A rewrite is refused.** Same position, different wording is not a correction — it is a corpus whose
 *    published readings can no longer be reproduced, and the failure is silent: every later read simply
 *    returns the new text.
 * 3. **Order is data, not engine behaviour.** `Storage.query` has no `ORDER BY` (`sql.ts`), so an
 *    implementation that trusted row order would be relying on the current query plan of one backend. The
 *    tests below append out of order on purpose.
 *
 * ## Why `SqliteStorage` and not a fake
 *
 * Because two of the three properties are properties of a *transaction* — the index row and the turn row are
 * written together or not at all — and a fake store would be asserting its own implementation of that. The
 * store here is the one the product ships (`@agentix-e/cortex-storage/sqlite`), in memory.
 */
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';
import type { Storage } from '@agentix-e/cortex-core';

import { CORPUS_SCHEMA, Corpus, CorpusError, turnId, type StoredTurn } from '../corpus.js';

const AT = 1_759_470_000_000;

/** A corpus over a fresh in-memory store, with the clock pinned. */
function corpus(options: { store?: Storage; table?: string; now?: number } = {}): Corpus {
  return new Corpus({
    store: options.store ?? new SqliteStorage(),
    now: options.now ?? AT,
    ...(options.table === undefined ? {} : { table: options.table }),
  });
}

/** Three turns in two sessions, in the order a person had them. */
const conversation = [
  { sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' },
  { sessionId: 's1', ordinal: 1, text: 'My landlord is called Anke.' },
  { sessionId: 's2', ordinal: 0, text: 'The invoice was paid late again.' },
] as const;

describe('append', () => {
  it('reports what was new, and a replay reports all of it as duplicates', async () => {
    const store = new SqliteStorage();
    const first = corpus({ store });

    expect(await first.append(conversation)).toEqual({ appended: 3, duplicates: 0 });
    // The replay is what a restart does. It must not double the transcript, and it must say so rather than
    // reporting a quiet no-op -- `{appended: 3, duplicates: 0}` a second time would be the same statement
    // about a corpus twice the size.
    expect(await first.append(conversation)).toEqual({ appended: 0, duplicates: 3 });
    expect(await first.size()).toBe(3);
    expect(await first.context()).toHaveLength(3);
  });

  it('appends a mixed batch: some new turns, some replays, in one call', async () => {
    const store = new SqliteStorage();
    const first = corpus({ store });
    await first.append(conversation);
    const report = await first.append([
      conversation[0],
      { sessionId: 's1', ordinal: 2, text: 'She raised the rent in June.' },
      { sessionId: 's3', ordinal: 0, text: 'A new conversation.' },
    ]);
    expect(report).toEqual({ appended: 2, duplicates: 1 });
    expect(await first.size()).toBe(5);
  });

  it('refuses to rewrite a turn, across batches and inside one batch', async () => {
    const first = corpus();
    await first.append(conversation);

    // Same position, different wording. The message names the identity, because the caller's mistake is
    // about *which turn* they meant, not about the text.
    await expect(
      first.append([{ sessionId: 's1', ordinal: 0, text: 'I moved to Lisbon in March.' }]),
    ).rejects.toThrow(/turn s1\/000000 already holds different text/);
    await expect(
      first.append([{ sessionId: 's1', ordinal: 0, text: 'I moved to Lisbon in March.' }]),
    ).rejects.toMatchObject({ code: 'rewrite' });

    // And refused before anything is written: a batch that carries its own contradiction leaves no trace.
    const before = await first.size();
    await expect(
      first.append([
        { sessionId: 's4', ordinal: 0, text: 'one' },
        { sessionId: 's4', ordinal: 0, text: 'two' },
      ]),
    ).rejects.toMatchObject({ code: 'rewrite' });
    expect(await first.size()).toBe(before);
  });

  it('refuses an unnamed session and a position that is not a non-negative integer', async () => {
    const first = corpus();
    await expect(first.append([{ sessionId: '', ordinal: 0, text: 'x' }])).rejects.toMatchObject({
      code: 'input',
    });
    await expect(first.append([{ sessionId: 's', ordinal: 1.5, text: 'x' }])).rejects.toMatchObject(
      {
        code: 'input',
      },
    );
    await expect(first.append([{ sessionId: 's', ordinal: -1, text: 'x' }])).rejects.toMatchObject({
      code: 'input',
    });
  });

  it('is a no-op for an empty batch, which is what a caller with nothing new should send', async () => {
    const first = corpus();
    expect(await first.append([])).toEqual({ appended: 0, duplicates: 0 });
  });
});

describe('order', () => {
  it('orders by session arrival and then by ordinal, not by append order or by session id', async () => {
    const first = corpus();
    // Appended deliberately out of order, and interleaved across sessions. The order the corpus must report is
    // the order the conversations happened in, which is the order each session *first* appeared -- so `s2`
    // comes first even though `s1` sorts before it lexicographically, and `s1`'s own turns are still in
    // ordinal order although its second turn was appended before its first.
    await first.append([{ sessionId: 's2', ordinal: 0, text: 'second session, first turn' }]);
    await first.append([{ sessionId: 's1', ordinal: 1, text: 'first session, second turn' }]);
    await first.append([
      { sessionId: 's1', ordinal: 0, text: 'first session, first turn' },
      { sessionId: 's2', ordinal: 1, text: 'second session, second turn' },
    ]);

    expect(await first.sessions()).toEqual([
      ['second session, first turn', 'second session, second turn'],
      ['first session, first turn', 'first session, second turn'],
    ]);
    // The flat view is the grouped view flattened, in the same order: the two arguments the answer path takes
    // must not disagree about what came first.
    expect(await first.context()).toEqual([
      'second session, first turn',
      'second session, second turn',
      'first session, first turn',
      'first session, second turn',
    ]);
  });

  it('keeps a session contiguous when its turns arrive between another session’s', async () => {
    const first = corpus();
    await first.append([
      { sessionId: 'a', ordinal: 0, text: 'a0' },
      { sessionId: 'b', ordinal: 0, text: 'b0' },
      { sessionId: 'a', ordinal: 1, text: 'a1' },
      { sessionId: 'b', ordinal: 1, text: 'b1' },
    ]);
    expect(await first.sessions()).toEqual([
      ['a0', 'a1'],
      ['b0', 'b1'],
    ]);
  });

  it('reads one session in ordinal order without reading the rest', async () => {
    const first = corpus();
    await first.append(conversation);
    await first.append([{ sessionId: 's1', ordinal: 2, text: 'She raised the rent in June.' }]);
    expect(await first.session('s1')).toEqual([
      'I moved to Berlin in March.',
      'My landlord is called Anke.',
      'She raised the rent in June.',
    ]);
    expect(await first.session('nobody')).toBeUndefined();
  });

  it('reads one turn by identity, with its clock', async () => {
    const first = corpus();
    await first.append(conversation);
    expect(await first.turn(turnId('s2', 0))).toEqual({
      v: CORPUS_SCHEMA,
      id: 's2/000000',
      sessionId: 's2',
      ordinal: 0,
      text: 'The invoice was paid late again.',
      at: AT,
    });
    expect(await first.turn(turnId('s2', 9))).toBeUndefined();
  });
});

describe('the clock', () => {
  it('stamps a turn from the injected clock, and lets a turn carry its own instant', async () => {
    const store = new SqliteStorage();
    const fixed = corpus({ store, now: AT });
    await fixed.append([{ sessionId: 's', ordinal: 0, text: 'no stamp' }]);
    await fixed.append([{ sessionId: 's', ordinal: 1, text: 'own stamp', at: AT + 1_000 }]);
    expect((await fixed.turn(turnId('s', 0)))?.at).toBe(AT);
    expect((await fixed.turn(turnId('s', 1)))?.at).toBe(AT + 1_000);
  });

  it('accepts a clock function, so a long-lived process stamps each append with the time it ran', async () => {
    let now = AT;
    const live = new Corpus({ store: new SqliteStorage(), now: () => now });
    await live.append([{ sessionId: 's', ordinal: 0, text: 'first' }]);
    now = AT + 60_000;
    await live.append([{ sessionId: 's', ordinal: 1, text: 'second' }]);
    expect((await live.turn(turnId('s', 0)))?.at).toBe(AT);
    expect((await live.turn(turnId('s', 1)))?.at).toBe(AT + 60_000);
  });

  it('defaults to the wall clock rather than to zero, because zero is a timestamp that lies', async () => {
    const live = new Corpus({ store: new SqliteStorage() });
    const before = Date.now();
    await live.append([{ sessionId: 's', ordinal: 0, text: 'now' }]);
    const at = (await live.turn(turnId('s', 0)))?.at ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe('a store this build cannot read', () => {
  /** Write a row the schema check must refuse. */
  async function plant(store: Storage, turn: StoredTurn): Promise<void> {
    await store.put('corpus.turn', turn.id, turn);
    await store.put('corpus.session', turn.sessionId, {
      sessionId: turn.sessionId,
      seq: 0,
      ordinals: [turn.ordinal],
    });
  }

  it('refuses a newer schema version by version number, on every read path', async () => {
    const store = new SqliteStorage();
    // `v: 2` may place meaning on a field this build ignores. Reading it as if it were version 1 would drop
    // that meaning silently; the version is in the message because that is what a reader has to act on.
    await plant(store, {
      v: 2 as unknown as typeof CORPUS_SCHEMA,
      id: 's/000000',
      sessionId: 's',
      ordinal: 0,
      text: 'from the future',
      at: AT,
    });
    const first = corpus({ store });
    await expect(first.turns()).rejects.toThrow(/schema version 2/);
    await expect(first.turn('s/000000')).rejects.toMatchObject({ code: 'schema' });
    await expect(first.session('s')).rejects.toThrow(/schema version 2/);
    // A replay over a row this build cannot read is also a refusal, not a duplicate: the two rows may differ
    // in a field this build does not have a name for.
    await expect(
      first.append([{ sessionId: 's', ordinal: 0, text: 'from the future' }]),
    ).rejects.toThrow(/schema version 2/);
  });

  it('refuses a turn whose session has no index row, instead of guessing an order', async () => {
    const store = new SqliteStorage();
    await store.put('corpus.turn', 'ghost/000000', {
      v: CORPUS_SCHEMA,
      id: 'ghost/000000',
      sessionId: 'ghost',
      ordinal: 0,
      text: 'orphaned',
      at: AT,
    });
    await expect(corpus({ store }).turns()).rejects.toThrow(/has no index row/);
  });

  it('refuses an index row whose turn is missing, instead of returning a short session', async () => {
    const store = new SqliteStorage();
    await store.put('corpus.session', 's', { sessionId: 's', seq: 0, ordinals: [0, 1] });
    await store.put('corpus.turn', 's/000000', {
      v: CORPUS_SCHEMA,
      id: 's/000000',
      sessionId: 's',
      ordinal: 0,
      text: 'present',
      at: AT,
    });
    // Returning ['present'] would move ordinal 1's text into position 0 and answer from the wrong turn.
    await expect(corpus({ store }).session('s')).rejects.toThrow(
      /indexes ordinal 1 but s\/000001 is absent/,
    );
  });
});

describe('erasure', () => {
  it('erases every copy of a wording, keeps the neighbours, and reports the count', async () => {
    const first = corpus();
    await first.append(conversation);
    // The same sentence in two sessions is one wording with two rows: a fact the person repeated is still one
    // fact, and an erasure that removed one copy would leave the other readable. One of the two sessions also
    // holds a second copy, so the per-session ordinal list has to lose more than its first entry.
    await first.append([
      { sessionId: 's3', ordinal: 0, text: 'The invoice was paid late again.' },
      { sessionId: 's3', ordinal: 1, text: 'The invoice was paid late again.' },
      { sessionId: 's3', ordinal: 2, text: 'Anke sent a reminder.' },
    ]);

    expect(await first.forget(['The invoice was paid late again.'])).toBe(3);
    expect(await first.context()).toEqual([
      'I moved to Berlin in March.',
      'My landlord is called Anke.',
      'Anke sent a reminder.',
    ]);
    // The emptied session loses its index row: a session nobody can read is not a session, and an auditor
    // counting them would count a conversation that has no turns.
    expect(await first.session('s2')).toBeUndefined();
    expect(await first.session('s3')).toEqual(['Anke sent a reminder.']);
    expect(await first.session('s1')).toHaveLength(2);
  });

  it('reports zero for a wording the corpus does not hold, and for an empty offer', async () => {
    const first = corpus();
    await first.append(conversation);
    expect(await first.forget([])).toBe(0);
    expect(await first.forget(['never said'])).toBe(0);
    expect(await first.size()).toBe(3);
  });

  it('does not reuse a sequence number, so a session appended after an erasure sorts after the survivors', async () => {
    const first = corpus();
    await first.append(conversation);
    await first.forget(['The invoice was paid late again.']);
    await first.append([{ sessionId: 's4', ordinal: 0, text: 'later conversation' }]);
    // s4 arrived after s2 was erased. It must sort last: the rewind of the counter would put it where s2 was,
    // which is a statement about a conversation that did not happen.
    expect(await first.sessions()).toEqual([
      ['I moved to Berlin in March.', 'My landlord is called Anke.'],
      ['later conversation'],
    ]);
  });

  it('erases through the structural contract the boundary is given', async () => {
    // `TurnEraser` is what `DisclosureSession` holds. Assignability is the whole of the contract, so it is
    // asserted here rather than discovered at the composition root.
    const eraser: { forget(texts: readonly string[]): number | Promise<number> } = corpus();
    expect(typeof eraser.forget).toBe('function');
  });
});

describe('two corpora in one store', () => {
  it('keeps them apart by table prefix', async () => {
    const store = new SqliteStorage();
    const left = corpus({ store, table: 'left' });
    const right = corpus({ store, table: 'right' });
    await left.append([{ sessionId: 's', ordinal: 0, text: 'left one' }]);
    await right.append([{ sessionId: 's', ordinal: 0, text: 'right one' }]);
    expect(await left.context()).toEqual(['left one']);
    expect(await right.context()).toEqual(['right one']);
    // And the same (session, ordinal) in both, which is what proves the prefixes are separate keyspaces
    // rather than one keyspace read twice.
    expect(await left.size()).toBe(1);
  });
});

describe('the error carries a code', () => {
  it('is a CorpusError with a name a caller can branch on', () => {
    const error = new CorpusError('input', 'message');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CorpusError');
    expect(error.code).toBe('input');
    expect(error.message).toBe('message');
  });
});

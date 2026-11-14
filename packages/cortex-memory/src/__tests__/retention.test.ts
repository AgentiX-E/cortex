/**
 * `MemoryType` is read, and reading it changes which memory the store drops.
 *
 * ## Why this file exists at all
 *
 * `MemoryType` has carried a `'semantic'` member since the domain types were written, and for the whole life of
 * the package nothing wrote it and nothing read it: every `MemoryValue` the product constructed came from
 * `admitInto` with a literal `type: 'episodic'`, and no code path so much as compared the field. A label that is
 * settable and never read is the exact shape semantic-layer exit criterion E3 names as *not done*
 * (`DECISION-SEMANTIC-LAYER-ROUTE.md` §3 row 3), and the reason it is named rather than waved through is that
 * such a field makes the type system *look* like it models a taxonomy.
 *
 * The criterion's test is "write → read back → behaviour changes". `leastRetained` is the read, and
 * {@link ../semantic-memory-type.test.ts} is the write plus the end-to-end behaviour. This file is the pair of
 * assertions that isolate the read: **the same read counts over two types produce two different victims**.
 *
 * ## Why a table rather than an `if`
 *
 * `Record<MemoryType, …>` forces every member of the union to state its own retention semantics, so adding a
 * fourth memory type is a compile error at the table rather than a silent fall-through to whatever an `else`
 * branch happened to do. An `if (type === 'semantic')` would have made the other two members a comment.
 *
 * ## Why the second element of the rank is a read count
 *
 * The product's clock is **injected and fixed** (`CortexMemoryOptions.now`), and the store stamps one instant on
 * every entry, so within an instance every memory carries the same `lastAccessedAt` whether or not it was ever
 * read. A rank of `[lastAccessedAt]` alone would therefore order nothing, and a test asserting it would pass on
 * a store where the read-back never happened — the inert-mechanism failure this repository has priced twice.
 *
 * So the tie-break is the number of windows that actually carried the entry, which is a quantity the store
 * genuinely observes. Knowledge is kept by *being used*, and that sentence has to be arithmetic rather than a
 * comment for the eviction to demonstrate it.
 */

import { describe, expect, it } from 'vitest';
import { createMemory, type MemoryType, type MemoryValue } from '@agentix-e/cortex-core';

import { leastRetained } from '../retention.js';

const NOW = 1_759_470_000_000;
const LATER = NOW + 60_000;

function memory(
  type: MemoryType,
  stamps: { createdAt?: number; lastAccessedAt?: number } = {},
): MemoryValue {
  return createMemory({
    content: `${type} memory`,
    type,
    createdAt: stamps.createdAt ?? NOW,
    lastAccessedAt: stamps.lastAccessedAt ?? NOW,
  });
}

describe('the victim is chosen by type', () => {
  it('gives up the unread entry when the entries are semantic', () => {
    // Two entries indistinguishable by every field a `MemoryValue` has — same instant, same defaults, same
    // content shape — and one of them was carried by two windows. Under `semantic` semantics that count is part
    // of the rank, so the unread one loses.
    const entries = [
      { memory: memory('semantic'), reads: 2 },
      { memory: memory('semantic'), reads: 0 },
    ];
    expect(leastRetained(entries)).toBe(1);
  });

  it('gives up the first entry when the entries are episodic, on the same counts', () => {
    // The control, and the pair is the whole criterion: **the same read counts, the same instants, the same
    // everything except the type**. An observation is kept by when it was recorded, so how often a later window
    // happened to quote it says nothing — and the rank ties, which sends the tie to the earlier index.
    const entries = [
      { memory: memory('episodic'), reads: 2 },
      { memory: memory('episodic'), reads: 0 },
    ];
    expect(leastRetained(entries)).toBe(0);
  });

  it('treats procedural as episodic, and states it, so the table has no silent member', () => {
    const entries = [
      { memory: memory('procedural'), reads: 2 },
      { memory: memory('procedural'), reads: 0 },
    ];
    expect(leastRetained(entries)).toBe(0);
  });

  it('keeps the most-read entry when three of them tie on the stamp', () => {
    // Eight entries all absorbed at one instant is the production case, so the ordering among them is decided
    // entirely by the count. The most-read survives, and the two others are ordered by the same rule.
    const entries = [
      { memory: memory('semantic'), reads: 1 },
      { memory: memory('semantic'), reads: 3 },
      { memory: memory('semantic'), reads: 0 },
    ];
    expect(leastRetained(entries)).toBe(2);
  });

  it('does not let a read count outrank a later stamp', () => {
    // Recency dominates use. An entry read forty times an hour ago loses to one read once a second ago —
    // otherwise a corpus quoted in a burst once would be immortal, and the bound would stop bounding.
    const entries = [
      { memory: memory('semantic', { lastAccessedAt: NOW }), reads: 40 },
      { memory: memory('semantic', { lastAccessedAt: LATER }), reads: 1 },
    ];
    expect(leastRetained(entries)).toBe(0);
  });

  it('orders by stamp before it compares either count, whichever slot the older entry sits in', () => {
    // Position independence: a rule that happened to return the first index would pass the previous test and
    // fail this one.
    const older = { memory: memory('semantic', { lastAccessedAt: NOW }), reads: 99 };
    const newer = { memory: memory('semantic', { lastAccessedAt: LATER }), reads: 0 };
    expect(leastRetained([newer, older])).toBe(1);
    expect(leastRetained([older, newer])).toBe(0);
  });
});

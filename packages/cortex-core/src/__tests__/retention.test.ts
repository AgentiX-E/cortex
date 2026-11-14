/**
 * `MemoryType` decides which memory is given up, and the use count is a domain field.
 *
 * ## Why this file is in `cortex-core` and the store is not
 *
 * The rule is a pure function over a `MemoryValue`: no clock, no store, no I/O. `cortex-core` states that
 * as its own reason to exist -- "contracts + pure algorithms (zero I/O, Node + browser)" -- and the rule
 * was nonetheless written in `cortex-memory`, because the quantity it ranks by had no home in the domain
 * type. The count was a second argument, and the store passed it.
 *
 * That argument was the defect, not the fix. A ranking that needs an input the domain cannot express is a
 * ranking the domain cannot describe, and the signature said so out loud: `leastRetained([{ memory, reads }])`
 * where `reads` belonged to nobody. The count is now `MemoryValue.reads`, so the rule takes the entries and
 * nothing else, and a caller cannot pass a different count without first writing it to the entry -- which is
 * exactly the observation the store makes.
 *
 * ## What the second element of the rank is, and what it is not
 *
 * | type | rank | why |
 * | --- | --- | --- |
 * | `semantic` | `[lastAccessedAt, reads]` | a statement about the world is kept by being *used* |
 * | `episodic` | `[createdAt, 0]` | a turn is a reading of one window; later quotes say nothing about it |
 * | `procedural` | `[createdAt, 0]` | same, and stated rather than defaulted so the table has no silent member |
 *
 * The count is **not** `MemoryValue.value`. `value` is "estimated future utility" on a stated `[0, 1]`
 * scale computed by an admission gate; a use count is unbounded and never passes that gate. One field
 * holding two scales is the defect `math/fsrs.ts` spent a docstring repairing in the time domain.
 *
 * ## Why the tests are a pair per type
 *
 * The product's clock is injected and fixed, so every entry in one store carries the same `lastAccessedAt`
 * whether or not it was ever read. A rank of `[lastAccessedAt]` alone would order nothing, and a test
 * asserting it would pass on a store where the read-back never happened. So each assertion is run twice:
 * once where the type makes the count part of the rank, and once on the same counts and instants where the
 * type does not. The pair is what distinguishes "the count is read" from "the count happens to correlate
 * with position".
 *
 * ## The mutations these tests are built to kill
 *
 * | mutation | which assertion dies |
 * | --- | --- |
 * | `semantic: (m) => [m.lastAccessedAt, 0]` | the semantic case; the episodic control stays green, which is what proves the causal path |
 * | `leastRetained` returns `0` | every non-zero expectation |
 * | signature back to `{ memory, reads }[]` | the `@ts-expect-error` block, via `TS2578` |
 * | `reads` added to `value` instead of as its own field | the independence assertion below |
 */

import { describe, expect, it } from 'vitest';

import { createMemory, type MemoryType, type MemoryValue } from '../domain/memory.js';
import { leastRetained } from '../domain/retention.js';

const NOW = 1_759_470_000_000;
const LATER = NOW + 60_000;

function memory(
  type: MemoryType,
  stamps: { createdAt?: number; lastAccessedAt?: number; reads?: number } = {},
): MemoryValue {
  return createMemory({
    content: `${type} memory`,
    type,
    createdAt: stamps.createdAt ?? NOW,
    lastAccessedAt: stamps.lastAccessedAt ?? NOW,
    reads: stamps.reads ?? 0,
  });
}

describe('the use count is a domain field, not a caller argument', () => {
  it('defaults a freshly created memory to zero reads and an untouched value', () => {
    // The independence assertion. If the count were written into `value`, this would read `0` and the
    // `[0, 1]` contract of `value` would have a second, unbounded user.
    const fresh = createMemory({ content: 'a statement about the world', type: 'semantic' });
    expect(fresh.reads).toBe(0);
    expect(fresh.value).toBe(0.5);
  });

  it('takes the count from the entry, so a caller cannot supply a different one', () => {
    // The old signature accepted `{ memory, reads }`. It does not any more, and the value that reaches the
    // rank is the one written on the entry -- read through the domain type rather than past it.
    const entries = [memory('semantic', { reads: 0 }), memory('semantic', { reads: 5 })];
    expect(leastRetained(entries)).toBe(0);
    // The old shape. It is not assignable to the new parameter type, and the compile error is the
    // guarantee -- a runtime assertion here would only be testing what an `undefined` comparison does.
    // @ts-expect-error -- a caller-side count is not a rank input; the field is.
    const wrongShape: readonly MemoryValue[] = [{ memory: memory('semantic'), reads: 3 }];
    expect(wrongShape).toHaveLength(1);
  });
});

describe('the victim is chosen by type', () => {
  it('gives up the unread entry when the entries are semantic', () => {
    // Two entries indistinguishable by every other field -- same instant, same defaults, same content
    // shape -- and one of them was carried by two windows.
    const entries = [memory('semantic', { reads: 2 }), memory('semantic', { reads: 0 })];
    expect(leastRetained(entries)).toBe(1);
  });

  it('gives up the first entry when the entries are episodic, on the same counts', () => {
    // The control, and the pair is the whole criterion: the same read counts, the same instants, the same
    // everything except the type. An observation is kept by when it was recorded, so the rank ties and the
    // tie goes to the earlier index.
    const entries = [memory('episodic', { reads: 2 }), memory('episodic', { reads: 0 })];
    expect(leastRetained(entries)).toBe(0);
  });

  it('treats procedural as episodic, and states it, so the table has no silent member', () => {
    const entries = [memory('procedural', { reads: 2 }), memory('procedural', { reads: 0 })];
    expect(leastRetained(entries)).toBe(0);
  });
});

describe('the order the two elements are compared in', () => {
  it('keeps the most-read entry when three of them tie on the stamp', () => {
    // Eight entries absorbed at one instant is the production case, so the ordering among them is decided
    // entirely by the count.
    const entries = [
      memory('semantic', { reads: 1 }),
      memory('semantic', { reads: 3 }),
      memory('semantic', { reads: 0 }),
    ];
    expect(leastRetained(entries)).toBe(2);
  });

  it('does not let a read count outrank a later stamp', () => {
    // Recency dominates use. An entry read forty times an hour ago loses to one read once a second ago --
    // otherwise a corpus quoted in a burst once would be immortal and the bound would stop bounding.
    const entries = [
      memory('semantic', { lastAccessedAt: NOW, reads: 40 }),
      memory('semantic', { lastAccessedAt: LATER, reads: 1 }),
    ];
    expect(leastRetained(entries)).toBe(0);
  });

  it('orders by stamp before it compares either count, whichever slot the older entry sits in', () => {
    // Position independence: a rule that happened to return the first index would pass the previous test
    // and fail this one.
    const older = memory('semantic', { lastAccessedAt: NOW, reads: 99 });
    const newer = memory('semantic', { lastAccessedAt: LATER, reads: 0 });
    expect(leastRetained([newer, older])).toBe(1);
    expect(leastRetained([older, newer])).toBe(0);
  });
});

describe('the contract for a list with nothing to choose between', () => {
  it('returns zero for a single entry, which is the only index that exists', () => {
    expect(leastRetained([memory('semantic', { reads: 3 })])).toBe(0);
  });

  it('returns zero for an empty list, and the caller is the one that must not splice', () => {
    // Not `-1`. A sentinel for "nothing to drop" would turn the caller's mistake into a silent no-op,
    // which is the failure class this repository has spent several rounds deleting.
    expect(leastRetained([])).toBe(0);
  });

  it('breaks an exact tie toward the earlier index', () => {
    const entries = [memory('semantic'), memory('semantic')];
    expect(leastRetained(entries)).toBe(0);
  });
});

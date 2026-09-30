/**
 * Consolidation forgets on the wrong clock, and the default configuration is
 * write-then-immediately-forget.
 *
 * ## The defect
 *
 * `retrievability(deltaMs, stabilityMs)` computes `exp(-Δt / S)` and documents
 * both arguments as **milliseconds**. `initialFsrsState()` and
 * `MemoryValue.stability`'s default are both `1`. So a memory created with the
 * defaults has `S = 1 ms`:
 *
 *     retrievability(1000, 1) = exp(-1000) = 0      // one second after creation
 *     retrievability(5, 1)    = exp(-5)    = 0.0067 // five milliseconds
 *
 * `consolidate`'s forgetting threshold defaults to `0.01` and deletes everything
 * below it. `exp(-5) < 0.01`, so **every memory older than five milliseconds is
 * deleted**, including ones never accessed:
 *
 *     const memories = new Map();       // 10 freshly created memories
 *     consolidate(memories, graph, []); // zero accesses
 *     memories.size  // 0
 *
 * Measured on `dist/` before this test was written. This is not a tuning problem:
 * the unit is wrong. FSRS stability is conventionally a duration of the same order
 * as the review interval — days for a memory system — and `1` is not a plausible
 * value for "one millisecond of durability" in any system that stores memories.
 *
 * ## Why the suite was green
 *
 * Two reasons, both worth pinning so they cannot recur:
 *
 * 1. `consolidate` has **no production caller** (`AUDIT-CODE-VS-DOCS.md` §6: the
 *    `cortex-memory` composition layer that would call it does not exist). Nothing
 *    ever consolidated a real store, so nothing ever observed the deletion.
 * 2. The four existing tests drive the *mechanism* while avoiding the *defaults*:
 *    the forgetting test passes `forgettingThreshold: 0.9` with `lastAccessedAt: 0`,
 *    and the decay test passes `{ decay: false }` and asserts only
 *    `stats.decayedEdges === 0` — its two fixture memories are silently emptied
 *    out from under it, and nothing checks the count.
 *
 * A test that proves "a high threshold forgets" says nothing about whether the
 * shipped threshold forgets everything.
 *
 * ## What is asserted
 *
 * The behaviour, in milliseconds, at the boundary the default actually lives on:
 * a fresh memory survives consolidation, an old one does not, and a successful
 * access extends its life. Plus the two properties whose absence hid this:
 * `stability` is a real duration, and consolidation is not a function of wall-clock
 * jitter.
 */
import { describe, it, expect } from 'vitest';
import { createMemory } from '../domain/memory.js';
import { MemoryGraph } from '../graph/memory-graph.js';
import { consolidate } from '../consolidation/consolidate.js';
import { retrievability, initialFsrsState, review } from '../math/fsrs.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function store(...memories: ReturnType<typeof createMemory>[]) {
  const map = new Map(memories.map((m) => [m.id, m]));
  return map;
}

describe('a fresh memory survives the default consolidation', () => {
  it('does not forget a memory created moments ago', () => {
    // THE regression. Measured before the fix: 10 in, 0 out.
    const memories = store(
      ...Array.from({ length: 10 }, (_, i) => createMemory({ id: `m${i}`, content: `fact ${i}` })),
    );
    const stats = consolidate(memories, new MemoryGraph(), []);

    expect(stats.forgotten, 'default consolidation forgot a freshly created memory').toBe(0);
    expect(memories.size, 'default consolidation emptied the store').toBe(10);
  });

  it('does not forget a memory that has existed for an hour', () => {
    // Not a jitter artefact: an hour is three orders of magnitude past the wall
    // the old defaults put up (5 ms), and a memory system that drops an hour-old
    // unaccessed memory is not a memory system.
    const m = createMemory({ content: 'a', lastAccessedAt: Date.now() - HOUR });
    const memories = store(m);
    const stats = consolidate(memories, new MemoryGraph(), []);

    expect(stats.forgotten, 'an hour-old memory was forgotten').toBe(0);
    expect(memories.has(m.id)).toBe(true);
  });

  it('still forgets a memory that is genuinely stale', () => {
    // The counter-assertion: the fix must not disable forgetting, only correct its
    // clock. A year untouched is past any plausible durability.
    const m = createMemory({ content: 'a', lastAccessedAt: Date.now() - 365 * DAY });
    const memories = store(m);
    const stats = consolidate(memories, new MemoryGraph(), []);

    expect(stats.forgotten, 'a year-old memory should be forgotten').toBe(1);
    expect(memories.has(m.id)).toBe(false);
  });

  it('honours an explicit threshold over the default', () => {
    // The existing test's mechanism must keep working; only the default was broken.
    const m = createMemory({ content: 'a', lastAccessedAt: Date.now() });
    const memories = store(m);
    const stats = consolidate(memories, new MemoryGraph(), [], { forgettingThreshold: 2 });
    expect(stats.forgotten).toBe(1);
  });
});

describe('stability is a duration of the same order as a memory lifetime', () => {
  it('gives a fresh memory a stability that keeps it retrievable for a day', () => {
    // Pins the unit rather than the number. `1` fails this; so does `1e3`.
    const { stability } = initialFsrsState();
    expect(
      retreivabilityIsSane(stability),
      `initialFsrsState().stability is ${stability}; a memory must be retrievable a day later`,
    ).toBe(true);
  });

  it('keeps the default stability of createMemory in the same regime', () => {
    const m = createMemory({ content: 'a' });
    expect(
      retreivabilityIsSane(m.stability),
      `createMemory().stability is ${m.stability}, which cannot express a day of durability`,
    ).toBe(true);
  });

  it('does not treat the initial state as expiring within the same millisecond', () => {
    const { stability } = initialFsrsState();
    // `exp(-1/1)` is already 0.37, and anything the size of a millisecond fails
    // the strictly stronger condition above. Kept separate so the failure message
    // names the specific absurdity when it regresses.
    expect(retrievability(1, stability), 'a fresh memory is gone after 1 ms').toBeGreaterThan(0.01);
  });

  it('recovers a fresh memory to full retrievability via initialFsrsState', () => {
    // The pairing that makes the unit coherent: a state built by
    // `initialFsrsState` fed to `retrievability` must describe a live memory.
    const state = initialFsrsState();
    expect(retrievability(0, state.stability)).toBeCloseTo(1, 12);
  });
});

describe('a successful access extends a memory lifetime', () => {
  it('leaves a reviewed memory more retrievable an hour later than an unreviewed one', () => {
    const now = Date.now();
    const reviewed = createMemory({ id: 'r', content: 'a', lastAccessedAt: now });
    const state = { stability: reviewed.stability, difficulty: reviewed.difficulty };
    const after = review(state, 'success', retrievability(0, state.stability));
    reviewed.stability = after.stability;

    const ignored = createMemory({ id: 'i', content: 'b', lastAccessedAt: now });

    const rReviewed = retrievability(HOUR, reviewed.stability);
    const rIgnored = retrievability(HOUR, ignored.stability);
    expect(
      rReviewed,
      `reviewed=${rReviewed} should exceed unreviewed=${rIgnored} after an hour`,
    ).toBeGreaterThan(rIgnored);
  });

  it('keeps both kinds of memory alive through a default consolidation', () => {
    // End to end: reviewed and ignored memories alike survive when they are recent,
    // which is what "consolidation is not a cull of everything" means.
    const now = Date.now();
    const memories = store(
      createMemory({ id: 'a', content: 'a', lastAccessedAt: now - MINUTE }),
      createMemory({ id: 'b', content: 'b', lastAccessedAt: now - HOUR }),
    );
    const stats = consolidate(memories, new MemoryGraph(), [
      { memoryId: 'a', outcome: 'success', at: now - MINUTE },
    ]);
    expect(stats.forgotten, 'a recent reviewed memory was forgotten').toBe(0);
    expect(memories.size).toBe(2);
  });
});

describe('the access clock is the access record, not the batch', () => {
  it('credits an access with the retrievability it actually had', () => {
    // The build cost used to be measured as `now - lastAccessedAt` instead of
    // `access.at - lastAccessedAt`. With the default state both give `exp(0)`, so
    // the two clocks agree on every fixture the suite had, and the test below is the
    // only thing that separates them.
    //
    // Same memory, same access timestamp, two different "now"s. A build consumes the
    // record; the boost must be a property of the record and nothing else.
    const accessAt = Date.now() - HOUR;
    const build = () => {
      const mem = createMemory({ id: 'm', content: 'a', lastAccessedAt: accessAt - DAY });
      consolidate(store(mem), new MemoryGraph(), [
        { memoryId: 'm', outcome: 'success', at: accessAt },
      ]);
      return mem.stability;
    };

    const a = build();
    const b = build();
    expect(a, 'the same record must produce the same state').toBe(b);

    // And the value itself must be the one the record implies: a memory with one day
    // of stability, retrieved a day after its last access, is at `1/e`, so the boost
    // is `1 + (1 - 1/e) * 2` and not the no-spacing floor.
    const expected = initialFsrsState().stability * (1 + (1 - Math.exp(-1)) * 2);
    expect(a, 'a day-old access must not be charged the no-spacing floor').toBeCloseTo(
      expected,
      12,
    );
  });

  it('does not credit a decayed access with a fresh one', () => {
    // The consequence in the direction that matters: a memory accessed long ago gains
    // more stability than one accessed just now, because it had more to gain back.
    const now = Date.now();
    const stale = createMemory({ id: 's', content: 'a', lastAccessedAt: now - 30 * DAY });
    const fresh = createMemory({ id: 'f', content: 'b', lastAccessedAt: now - MINUTE });
    const staleGain = (() => {
      const before = stale.stability;
      consolidate(store(stale), new MemoryGraph(), [
        { memoryId: 's', outcome: 'success', at: now - DAY },
      ]);
      return stale.stability / before;
    })();
    const freshGain = (() => {
      const before = fresh.stability;
      consolidate(store(fresh), new MemoryGraph(), [
        { memoryId: 'f', outcome: 'success', at: now - MINUTE },
      ]);
      return fresh.stability / before;
    })();

    expect(
      staleGain,
      `a 29-day-old access (${staleGain}x) must outweigh a no-spacing one (${freshGain}x)`,
    ).toBeGreaterThan(freshGain);
  });
});

/** True when `stability` (ms) keeps a memory above the default forgetting floor a day on. */
function retreivabilityIsSane(stabilityMs: number): boolean {
  return retrievability(DAY, stabilityMs) > 0.01;
}

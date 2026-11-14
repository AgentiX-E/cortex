/**
 * E3: the store writes `type: 'semantic'`, reads it back, and the read changes which entry it drops.
 *
 * ## The criterion, in its own words
 *
 * `DECISION-SEMANTIC-LAYER-ROUTE.md` §3 row 3 states E3 as **representability**: *`MemoryType` writes and reads
 * `'semantic'`*, the shape that would make it fake is *a settable label nobody reads*, and the check that
 * refuses the fake is *one test: write → read back → behaviour changes*.
 *
 * This file is that test, and it is written as a **pair** of conditions rather than as a single assertion,
 * because the criterion has three words and only a pair can separate them:
 *
 * | condition | what the store saw | expects |
 * | --- | --- | --- |
 * | A — the control | eight updates, none ever read | the **oldest** is evicted |
 * | B — the mechanism | eight updates, the oldest read by one window | the **oldest survives**, and the second-oldest is evicted |
 *
 * A and B differ in one event: a window carried one entry. If the label were unread — the defect E3 names —
 * A and B would reach the same store, because the only thing distinguishing the entry is a fact nobody looks
 * at. So B's assertion *is* the assertion that the read happened: the value E3 asked the product to write is
 * the value the eviction compared.
 *
 * ## Why the two conditions are two tests and not one test with two stores
 *
 * They are separate `CortexMemory` instances on purpose. A store carried through both would be the store under
 * test *and* the store under control, and the second reading would inherit the first one's evictions.
 *
 * ## Why the corpus is nine two-turn batches
 *
 * `SEMANTIC_UPDATES_MAX` is 8, so the ninth absorption is the only event in the package that reads the
 * retention rule. A test that never crosses the bound would pass on a store whose eviction was
 * `shift()` — which is exactly what it was before this round.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const UPDATING = 'How many dozen of stock am I at?';
const REVISIT = 'What is my current stock position?';

/** A corpus per record number, so each batch has its own anchor and two batches cannot collide in the store. */
function batch(index: number): string[] {
  return [
    `[2023/01/10 (Tue) 03:14] user: we now have 20 dozen of stock record number ${index}.`,
    `[2023/03/1${index} (Fri) 10:52] user: we now have 30 dozen of stock record number ${index}.`,
  ];
}

/**
 * A reader that answers from the record number the prompt carries.
 *
 * Keyed on the prompt's own text rather than on a call index: the number of calls is one of the things these
 * tests would stop noticing if it were the key, because a phase that vanished would leave a call counter that
 * still looked right.
 */
function batchReader(): LLM {
  return {
    complete: async (prompt: string) => {
      const number = /stock record number (\d+)/.exec(prompt)?.[1] ?? '0';
      if (prompt.includes('Do not answer the question again')) {
        return `CHANGED: yes\nLATER: 30 dozen of stock record number ${number}\nWHEN: 2023/03/1${number} (Fri) 10:52`;
      }
      return `20 dozen of stock record number ${number}`;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function system(options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: {
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: Number.POSITIVE_INFINITY,
      valueFunction: () => 1,
    },
    reviewPass: 'supersede',
    semanticCarry: true,
    ...options,
    llm: batchReader(),
  });
}

/** Fill the store to its bound of eight, one authorised substitution each. */
async function fillToBound(memory: CortexMemory): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    // The adjudicator reduces a span to its last new numeral plus the unit that follows it
    // (`substitutedValue`), so every batch converts to `30 dozen`. The batch is identified by its anchor,
    // not by its answer, and asserting a longer string here would be asserting a behaviour the pass does
    // not have.
    expect(await memory.answerKnowledgeUpdate(UPDATING, batch(index))).toBe('30 dozen');
  }
  expect(memory.semanticCarryCensus().absorbed).toBe(8);
  expect(memory.semanticCarryCensus().stored).toEqual({
    episodic: 0,
    semantic: 8,
    procedural: 0,
  });
}

/** Whether a window over this batch is served the update line the store holds for it. */
async function served(memory: CortexMemory, index: number): Promise<boolean> {
  await memory.answer(REVISIT, batch(index));
  return memory.lastPromptText()!.includes('UPDATES:');
}

describe('the store holds semantic memories, and the type is what the eviction reads', () => {
  it("writes `type: 'semantic'`, and the census is a reading over the type and not a count of units", async () => {
    // The write half of the criterion. `stored` is a census over `MemoryType`, so a store whose entries were
    // constructed with the default type would report eight `episodic` here while `absorbed` stayed at eight —
    // the two numbers disagreeing is the only way this assertion can fail, which is what makes it a reading.
    const memory = system();
    await fillToBound(memory);
    expect(memory.semanticCarryCensus().stored.semantic).toBe(8);
    expect(memory.semanticCarryCensus().stored.episodic).toBe(0);
  });

  it('keeps the entry a window carried and drops the one after it, at one instant', async () => {
    // Condition B. Every entry carries the same `lastAccessedAt`, because the clock is injected and fixed and
    // the store stamps one instant — so the only thing that can separate the first entry from the second is
    // the count of windows that carried it. That is the quantity `retentionRank` reads, and the quantity does
    // not exist for an `episodic` entry.
    const memory = system();
    await fillToBound(memory);

    expect(await served(memory, 0)).toBe(true);
    expect(memory.semanticCarryCensus().matched).toBe(1);

    // The ninth absorption crosses the bound and drops exactly one entry.
    await memory.answerKnowledgeUpdate(UPDATING, batch(8));
    expect(memory.semanticCarryCensus().dropped).toBe(1);
    expect(memory.semanticCarryCensus().stored.semantic).toBe(8);

    // The read entry is still served …
    expect(await served(memory, 0)).toBe(true);
    // … and the one that was never read and was recorded just after it is not. This pair is the assertion: a
    // store that dropped by insertion order would invert it, and the inverted answer is what a store that never
    // read `type` produces.
    expect(await served(memory, 1)).toBe(false);
  });

  it('drops the oldest when nothing was ever read — the control that makes the previous test causal', async () => {
    // Condition A. The same eight absorptions, the same ninth, and no window in between. Under the retention
    // rule an unread entry ranks by its stamp and then by a count of zero, so the oldest loses; under a store
    // that ignored `type` the same entry would also lose, and *that* is why the previous test has to exist:
    // only the pair separates "the rule read the type" from "the rule happened to agree with insertion order".
    const memory = system();
    await fillToBound(memory);

    await memory.answerKnowledgeUpdate(UPDATING, batch(8));
    expect(memory.semanticCarryCensus().dropped).toBe(1);

    expect(await served(memory, 0)).toBe(false);
    expect(await served(memory, 1)).toBe(true);
  });

  it('counts a read once per window, not once per entry in the block', async () => {
    // A window that carries one anchor but two entries from the same corpus is one read of each, and a window
    // that carries none is a read of nothing. Counting per entry rather than per window would let a corpus that
    // appears twice in one prompt outrank a corpus that was genuinely revisited — a difference no published
    // number would show and every eviction after it would inherit.
    const memory = system();
    await fillToBound(memory);

    // Two windows over the same corpus: the count is `matched`, and it is per window.
    expect(await served(memory, 3)).toBe(true);
    expect(await served(memory, 3)).toBe(true);
    expect(memory.semanticCarryCensus().matched).toBe(2);

    // Two different corpora, one read each: the counts are equal, so the older loses on its stamp.
    expect(await served(memory, 4)).toBe(true);
    expect(await served(memory, 5)).toBe(true);
    expect(await served(memory, 6)).toBe(true);

    await memory.answerKnowledgeUpdate(UPDATING, batch(8));
    expect(await served(memory, 0)).toBe(false);
  });
});

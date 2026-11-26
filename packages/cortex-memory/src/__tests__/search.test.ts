/**
 * `CortexMemory.search()` — the product's own ranking, asked for by a caller.
 *
 * ## Why this file exists
 *
 * `docs/DESIGN-MULTI-STEP-RETRIEVAL.md` builds a reader that looks twice, and
 * `docs/PREREGISTRATION-MULTI-STEP.md` §2 named `search()` as the one method that did not exist. It did not
 * exist for a long time, so every probe over the loop built its own `SearchIndex` over the same turns and
 * measured **that** index rather than the registered one. A method whose absence was silent is a method
 * whose behaviour has to be pinned from the outside, which is what this file does.
 *
 * ## What is asserted, in order of importance
 *
 * 1. **The order is the prompt's order.** The same comparator `selectByRelevance` spends the room on decides
 *    the ranking here, so the first id this method returns is the first evidence turn the prompt would carry.
 *    A second comparator would make the two disagree only on the questions worth measuring.
 * 2. **The id is a `context` position, not a filtered-array position.** The write gate drops turns; a method
 *    that returned positions in the surviving array would hand a caller an id that indexes the wrong string.
 * 3. **It does not steal the answer's census.** `rankingCensusOf(question)` still describes the answer after a
 *    search, and the search's own cost still lands in `indexCost()` — "did not own the slots" is not "was free".
 * 4. **The states it refuses, and the state in which it has nothing to say.** No ranking configured means
 *    arrival order with score `0`; a non-positive `k` and a `session-text` unit are refused rather than
 *    degraded.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** A gate that admits everything: this file is about ranking, not about admission. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: ((_memory: MemoryValue) => 1) as ValueFunction,
} as const;

/** Four turns, one per topic, so a query has exactly one right answer and three wrong ones. */
const CORPUS = [
  'the bicycle was repaired on tuesday',
  'a parcel arrived for the neighbour',
  'the invoice was paid late again',
  'rain cancelled the football match',
];

/**
 * A bag-of-words embedder over a fixed vocabulary.
 *
 * Vector instead of lexical because `relevanceSignal: self-index` is what the product ships, and a test of
 * the shipped ranking that used the lexical channel would be a test of the other one. The vocabulary is
 * closed so two calls produce the same numbers and an ordering assertion is an assertion about the comparator
 * rather than about a model.
 */
const VOCABULARY = [
  'bicycle',
  'repaired',
  'tuesday',
  'parcel',
  'neighbour',
  'invoice',
  'paid',
  'late',
  'rain',
  'football',
];

async function embed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => {
    const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
    return VOCABULARY.map((term) => (words.has(term) ? 1 : 0));
  });
}

/** An `LLM` that answers with a number and records the prompts, so a prompt can be inspected. */
function recorder(): { prompts: string[]; llm: LLM } {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      complete: (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve('42');
      },
      completeStructured: () => Promise.reject(new Error('unused by this package')),
    },
  };
}

function memoryWith(options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, llm: recorder().llm, ...options });
}

describe('search returns the order the prompt would have been built in', () => {
  it('puts the turn the query is about first, and identifies it by its context position', async () => {
    const memory = memoryWith({ index: { embed } });
    const hits = await memory.search('when was the bicycle repaired?', CORPUS);

    expect(hits).toHaveLength(CORPUS.length);
    expect(hits[0]?.turn).toBe(0);
    // The score is the signal's raw value, so it has to be strictly above the turns that share no term.
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    expect(hits.map((hit) => hit.turn).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('agrees with the prompt: the first hit is the first evidence turn the answer carries', async () => {
    const memory = memoryWith({ index: { embed } });
    const question = 'was the invoice paid late?';
    const hits = await memory.search(question, CORPUS);
    await memory.answer(question, [...CORPUS]);

    const prompt = memory.lastPromptText() ?? '';
    // The prompt presents evidence in arrival order, so the assertion is about *membership of the prefix the
    // room bought* rather than about print order: the top hit has to be inside the delivered window, and a
    // turn the signal rated below everything else has to be the one most likely to be outside it.
    expect(prompt).toContain(CORPUS[hits[0]?.turn ?? -1] ?? 'impossible');
    expect(hits[0]?.turn).toBe(2);
  });

  it('truncates at k without reordering, and returning everything is the default', async () => {
    const memory = memoryWith({ index: { embed } });
    const all = await memory.search('parcel for the neighbour', CORPUS);
    const two = await memory.search('parcel for the neighbour', CORPUS, { k: 2 });

    expect(two).toHaveLength(2);
    expect(two).toEqual(all.slice(0, 2));
  });

  it('breaks a tie by arrival, which is the comparator the prompt uses', async () => {
    const memory = memoryWith({ index: { embed } });
    // A query that shares a term with nothing: every score is zero and the order is the only one left.
    const hits = await memory.search('zzz', CORPUS);
    expect(hits.map((hit) => hit.turn)).toEqual([0, 1, 2, 3]);
  });
});

describe('the id survives the write gate', () => {
  it('reports a context position even when the gate dropped turns before it', async () => {
    // The gate keeps only the invoice turn. Every other turn is refused with a value below the threshold, so
    // the surviving array is length one and its only member sits at position 2 of the corpus.
    const memory = memoryWith({
      index: { embed },
      gate: {
        threshold: 0.5,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        sourceTrust: 1,
        valueFunction: ((value: MemoryValue) =>
          value.content.includes('invoice') ? 1 : 0) as ValueFunction,
      },
    });
    const hits = await memory.search('when was the bicycle repaired?', CORPUS);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.turn).toBe(2);
    // And the id names the turn the gate kept, not the turn the query asked about.
    expect(CORPUS[hits[0]?.turn ?? -1]).toContain('invoice');
  });
});

describe('search does not steal the answer it followed', () => {
  it('leaves the per-question index census describing the answer, and still bills the build', async () => {
    const memory = memoryWith({ index: { embed } });
    const question = 'who repaired the bicycle?';
    await memory.answer(question, [...CORPUS]);

    // `lastIndexCensus` is the per-question slot an artifact reads for "what did *this* question cost and
    // over what", and it is the slot a search must not overwrite: an artifact whose per-question row
    // described the caller's last search rather than the question it answered would be unreadable in exactly
    // the place the slot exists for.
    const before = memory.lastIndexCensus();
    expect(before).toBeDefined();
    expect(before?.turns).toBe(CORPUS.length);
    expect(memory.indexCost()?.turns).toBe(CORPUS.length);

    await memory.search('parcel', CORPUS);

    expect(memory.lastIndexCensus()).toEqual(before);
    // The build happened and was paid for, so the run's cost grew even though the per-question slot did not.
    expect(memory.indexCost()?.turns).toBe(CORPUS.length * 2);
  });
});

describe('the states search refuses, and the one where it has nothing to say', () => {
  it('returns arrival order with a score of zero when no ranking is configured', async () => {
    const memory = memoryWith();
    const hits = await memory.search('bicycle', CORPUS);

    expect(hits.map((hit) => hit.turn)).toEqual([0, 1, 2, 3]);
    // Zero is the absence of a signal rather than a low score, and the type carries no other way to say it.
    expect(hits.every((hit) => hit.score === 0)).toBe(true);
  });

  it('honours k in that same unsignalled state, so the two truncations are one rule', async () => {
    // The two returns are separate statements because the values differ in kind (a scored ordering and an
    // arrival list), and a rule applied to one of them only is the shape of defect this file exists to catch.
    const memory = memoryWith();
    const hits = await memory.search('bicycle', CORPUS, { k: 2 });

    expect(hits).toEqual([
      { turn: 0, score: 0 },
      { turn: 1, score: 0 },
    ]);
  });

  it('returns an empty list for an empty corpus rather than throwing', async () => {
    const memory = memoryWith({ index: { embed } });
    await expect(memory.search('anything', [])).resolves.toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses k = %s by name', async (k) => {
    const memory = memoryWith({ index: { embed } });
    await expect(memory.search('bicycle', CORPUS, { k })).rejects.toThrow(/positive integer/u);
  });

  it('refuses a session-text unit, which scores a document where this method returns turn ids', async () => {
    const memory = memoryWith({ index: { embed }, relevanceUnits: 'session-text' });
    await expect(memory.search('bicycle', CORPUS)).rejects.toThrow(/session boundaries/u);
  });
});

describe('the comparator is one definition, checked in the source rather than promised', () => {
  /**
   * A second comparator would be invisible in every test above.
   *
   * The tests in this file assert an **order**, and an order can be reproduced by any function that happens
   * to agree on four turns. The claim this method makes is stronger -- that a second look is ranked by the
   * function the prompt spends its room on -- and the only place that claim can be checked is the import.
   * It is the same shape as the `isAbstention` gate in `cortex-eval`'s repo gates: the direction that has to
   * be forbidden is the copy, because a copy passes every behavioural assertion until the two are edited
   * apart.
   */
  it('imports rankedCandidates and names no comparator of its own', () => {
    const source = readFileSync(new URL('../memory.ts', import.meta.url), 'utf8');

    expect(source).toContain('rankedCandidates');
    expect(source).toMatch(/from '\.\/prompt\.js'/u);
    // The grid belongs to `relevance-order.ts` and reaches this file only through the comparator. A mention
    // here means an ordering was rebuilt rather than delegated.
    expect(source).not.toContain('orderableRelevance');
    // And it is not re-implemented under another name: the sort that decides this ranking lives in exactly
    // one place, so `memory.ts` carries no sort comparator over relevance at all.
    expect(source).not.toMatch(/\.sort\(\s*\(a, b\)\s*=>\s*[^)]*relevance/u);
  });
});

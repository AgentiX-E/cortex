/**
 * The second look: one query written after a first pass has ranked.
 *
 * ## What each test is for
 *
 * Four claims, and no test asserts two of them at once:
 *
 * 1. **Off is byte-identical.** Every archived artifact was produced without this stage, and a stage that
 *    changed the prompt when it was off would make every number on record incomparable. The test compares
 *    the prompt strings, not the answers, because that is the thing the archive contains.
 * 2. **The query is written from the first pass.** The decision prompt has to carry a line from each turn
 *    the reader is about to read. `S17` (`queryExpansion: llm`) already writes phrases from the question
 *    alone and read +1.75 against a bar of +5, so a stage whose prompt contains only the question *is*
 *    that stage under a new name -- and the assertion that separates them is textual.
 * 3. **The union is ordered, not appended.** A session the second query promotes has to enter the budget
 *    and displace the first pass's choice, which is a claim about which turns the answer prompt carries.
 * 4. **A refusal costs one call and no search.** `NONE` is the out the prompt offers, and the census has to
 *    show it as a refusal rather than as a mechanism that fired on every question.
 *
 * ## Why the signal is an override here
 *
 * `relevanceFor` is the product's legal way to receive a signal from outside, and it is *query-sensitive* by
 * signature. A test that needed a real index would be a test of the embedder; this file is about what the
 * stage does with a signal, so the signal is a function of the two strings and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { CompleteOptions, LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import {
  DEFAULT_READER_SEARCH,
  buildSecondLookPrompt,
  digestOf,
  parseSecondLookQuery,
  readerSearchOptions,
} from '../reader-search.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;
const OPEN_GATE = { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY };

type Call = { readonly prompt: string; readonly opts: CompleteOptions | undefined };

/** An LLM that returns the scripted replies in order and records every prompt with its options. */
function scripted(replies: readonly string[]): { llm: LLM; calls: Call[] } {
  const calls: Call[] = [];
  let at = 0;
  return {
    calls,
    llm: {
      complete: async (prompt: string, opts?: CompleteOptions) => {
        calls.push({ prompt, opts });
        const reply = replies[Math.min(at, replies.length - 1)] as string;
        at += 1;
        return reply;
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    },
  };
}

function system(llm: LLM, options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
}

const PLANT_SESSION = [
  '[2023/05/20 (Sat) 20:05] user: I bought a plant, a peace lily, from the nursery two weeks ago.',
  '[2023/05/21 (Sun) 09:00] user: I moved the plant to the kitchen window.',
];
const DOG_SESSION = [
  '[2023/05/22 (Mon) 11:00] user: I took the dog to the vet for his annual shots.',
  '[2023/05/22 (Mon) 11:05] user: I took the dog to the vet for his annual shots.',
];
const QUESTION = 'How many plants did I buy in the last month?';

/** The question asks about plants; the second query asks about the dog, and the dog still loses. */
const querySensitive = (query: string, turn: string): number => {
  const asksDog = query.toLowerCase().includes('dog');
  if (asksDog) return turn.includes('dog') ? 0.9 : 0.1;
  return turn.includes('plant') ? 0.8 : 0.2;
};

/**
 * The same shape with the second query's best turn **below** the first pass's winner.
 *
 * The state this covers is the one a mechanism that only ever appends cannot produce: the second look
 * fired, spent its call and its index pass, and changed nothing. `promoted: 0` with `queries: 1` is the
 * reading, and it has to be distinguishable from `queries: 0`.
 */
const querySensitiveWeaker = (query: string, turn: string): number => {
  const asksDog = query.toLowerCase().includes('dog');
  if (asksDog) return turn.includes('dog') ? 0.5 : 0.1;
  return turn.includes('plant') ? 0.8 : 0.2;
};

const ANSWER = 'You bought one plant: a peace lily.';

describe('digestOf', () => {
  it('keeps the highest-scored turns and cuts on the same count the stage registered', () => {
    const rows = [
      { text: 'third', score: 0.1 },
      { text: 'first', score: 0.9 },
      { text: 'second', score: 0.5 },
    ];
    expect(digestOf(rows, { ...DEFAULT_READER_SEARCH, digestTurns: 2 })).toEqual([
      'first',
      'second',
    ]);
  });

  it('collapses whitespace and spends the width on the mark rather than after it', () => {
    const text = `a  b\tc ${'x'.repeat(40)}`;
    const digest = digestOf([{ text, score: 1 }], { ...DEFAULT_READER_SEARCH, digestChars: 12 });
    expect(digest).toHaveLength(1);
    expect(digest[0]).toHaveLength(12);
    expect(digest[0]?.endsWith('\u2026')).toBe(true);
    expect(digest[0]?.startsWith('a b c ')).toBe(true);
  });

  it('leaves arrival order alone when the scores are equal', () => {
    const rows = [
      { text: 'first', score: 0.5 },
      { text: 'second', score: 0.5 },
      { text: 'third', score: 0.5 },
    ];
    expect(digestOf(rows, DEFAULT_READER_SEARCH)).toEqual(['first', 'second', 'third']);
  });
});

describe('parseSecondLookQuery', () => {
  const options = DEFAULT_READER_SEARCH;

  it('reads a plain line as the query', () => {
    expect(parseSecondLookQuery('boots at Zara\n', QUESTION, options)).toEqual({
      kind: 'query',
      query: 'boots at Zara',
    });
  });

  it('strips a label, a bullet and the quotes around it', () => {
    expect(parseSecondLookQuery('- Query: "boots at Zara"', QUESTION, options)).toEqual({
      kind: 'query',
      query: 'boots at Zara',
    });
    expect(parseSecondLookQuery('1. `boots at Zara`', QUESTION, options)).toEqual({
      kind: 'query',
      query: 'boots at Zara',
    });
  });

  it('takes the first non-empty line when the model explains itself above the answer', () => {
    expect(
      parseSecondLookQuery(
        '\n\nboots at Zara\nbecause the list has no footwear',
        QUESTION,
        options,
      ),
    ).toEqual({ kind: 'query', query: 'boots at Zara' });
  });

  it('refuses NONE, which is the out the prompt offers', () => {
    expect(parseSecondLookQuery('NONE', QUESTION, options)).toEqual({
      kind: 'refused',
      reason: 'instruction',
    });
    expect(parseSecondLookQuery('none.', QUESTION, options)).toEqual({
      kind: 'refused',
      reason: 'instruction',
    });
  });

  it('refuses an apology as an instruction rather than searching for it', () => {
    expect(parseSecondLookQuery("I can't find a better query.", QUESTION, options)).toEqual({
      kind: 'refused',
      reason: 'instruction',
    });
  });

  it('refuses the question handed back, which would buy the first pass twice', () => {
    expect(parseSecondLookQuery(`${QUESTION}?`, QUESTION, options)).toEqual({
      kind: 'refused',
      reason: 'echo',
    });
    expect(parseSecondLookQuery(QUESTION.toUpperCase(), QUESTION, options)).toEqual({
      kind: 'refused',
      reason: 'echo',
    });
  });

  it('refuses a reply longer than the width rather than truncating it', () => {
    const verdict = parseSecondLookQuery('x'.repeat(options.maxQueryChars + 1), QUESTION, options);
    expect(verdict).toEqual({ kind: 'refused', reason: 'too-long' });
  });

  it('reports an empty reply and a stub too short to embed as empty, not as a refusal', () => {
    // The verdict run `45974552492` split. 242 of 242 decision calls were cut by a 32-token budget and every
    // one of them arrived here with no usable line; counted as refusals, the artifact said the model declined
    // on every question, which is a finding about the reader rather than about the bound. The two verdicts
    // are different findings about the same bill, so they are different values.
    expect(parseSecondLookQuery('   \n\n', QUESTION, options)).toEqual({ kind: 'empty' });
    expect(parseSecondLookQuery('ab', QUESTION, options)).toEqual({ kind: 'empty' });
  });

  it('keeps a query that starts with a refusal word but is about something', () => {
    expect(parseSecondLookQuery('none of the boots at Zara arrived', QUESTION, options)).toEqual({
      kind: 'query',
      query: 'none of the boots at Zara arrived',
    });
  });
});

describe('readerSearchOptions', () => {
  it('fills the registered defaults', () => {
    expect(readerSearchOptions()).toEqual(DEFAULT_READER_SEARCH);
    expect(readerSearchOptions({ k: 8 }).k).toBe(8);
  });

  it('refuses a bound it cannot honour rather than clamping it', () => {
    expect(() => readerSearchOptions({ k: 0 })).toThrow(/must be a positive integer/u);
    expect(() => readerSearchOptions({ digestChars: 1.5 })).toThrow(/digestChars/u);
    expect(() => readerSearchOptions({ maxTokens: Number.NaN })).toThrow(/maxTokens/u);
  });

  it('keeps a budget a thinking reader can answer inside, not a truncation-scale one', () => {
    // `32` is the value run `45974552492` measured: 242 decision calls, 242 of them cut before their first
    // content token, because the `multi-session` route asks its reader for `thinking` (§13.197) and the bound
    // was spent on reasoning. The floor below is not the chosen value -- it is the point under which the
    // bound becomes the answer -- so a later edit is free to move anywhere above it, and an edit back to a
    // truncation-scale number fails here rather than in a ¥5.87 dispatch.
    expect(DEFAULT_READER_SEARCH.maxTokens).toBeGreaterThan(256);
  });
});

describe('buildSecondLookPrompt', () => {
  it('carries the question, the first pass and the out', () => {
    const prompt = buildSecondLookPrompt(
      QUESTION,
      ['a peace lily', 'a snake plant'],
      DEFAULT_READER_SEARCH,
    );
    expect(prompt).toContain(QUESTION);
    expect(prompt).toContain('- a peace lily');
    expect(prompt).toContain('- a snake plant');
    expect(prompt).toContain('answer exactly NONE');
    expect(prompt.trimEnd().endsWith('Query:')).toBe(true);
  });

  it('says so in words when the first pass carried nothing', () => {
    expect(buildSecondLookPrompt(QUESTION, [], DEFAULT_READER_SEARCH)).toContain(
      '(the first pass selected nothing)',
    );
  });
});

describe('the second look on the multi-session route', () => {
  it('changes nothing when the option is absent, and reports no census', async () => {
    const { llm, calls } = scripted([ANSWER]);
    const off = await system(llm).answerSessions(QUESTION, [PLANT_SESSION, DOG_SESSION]);
    expect(calls).toHaveLength(1);
    expect(off).toBe(ANSWER);
    expect(system(llm).readerSearchCensus()).toBeNull();
  });

  it('writes one query from a digest of the first pass and searches with it', async () => {
    const { llm, calls } = scripted(['dog at the vet', ANSWER]);
    const memory = system(llm, {
      relevanceFor: querySensitive,
      gate: { ...OPEN_GATE, sessionBudget: 2 },
      // `k: 2` rather than a wide pool, so the second ranking **misses** the plant turns: a turn the boost
      // never saw has to keep its first-pass score, and a test with `k` at the corpus size could not tell
      // "not boosted" from "boosted to the same number".
      readerSearch: readerSearchOptions({ k: 2 }),
    });
    const answer = await memory.answerSessions(QUESTION, [PLANT_SESSION, DOG_SESSION]);

    expect(answer).toBe(ANSWER);
    expect(calls).toHaveLength(2);
    const [decision] = calls;
    // The decision prompt is the digest, not the question alone: `S17` already measures the question-only
    // version of this stage, and it is the thing this test has to be able to tell apart.
    expect(decision?.prompt).toContain('look twice');
    expect(decision?.prompt).toContain('peace lily');
    expect(decision?.prompt).toContain(QUESTION);
    expect(decision?.opts).toEqual({ maxTokens: DEFAULT_READER_SEARCH.maxTokens, temperature: 0 });

    // The promoted session is the one the second query found, and it displaced the first pass's choice
    // inside a budget of one: the claim is that the union is **ordered**, not appended.
    const [answerCall] = calls.slice(1);
    expect(answerCall?.prompt).toContain('dog to the vet');
    expect(answerCall?.prompt).not.toContain('peace lily');
    expect(memory.readerSearchCensus()).toEqual({
      attempted: 1,
      queries: 1,
      refused: 0,
      empty: 0,
      unranked: 0,
      promoted: 1,
    });
  });

  it('changes nothing when the second query scores below the first pass, and still reports that it fired', async () => {
    const { llm, calls } = scripted(['dog at the vet', ANSWER]);
    const memory = system(llm, {
      relevanceFor: querySensitiveWeaker,
      gate: { ...OPEN_GATE, sessionBudget: 2 },
      readerSearch: readerSearchOptions(),
    });
    await memory.answerSessions(QUESTION, [PLANT_SESSION, DOG_SESSION]);
    const [answerCall] = calls.slice(1);
    expect(answerCall?.prompt).toContain('peace lily');
    expect(answerCall?.prompt).not.toContain('dog to the vet');
    // `queries: 1` with `promoted: 0` is the reading that says "the stage fired and the union did not
    // change the room" -- which a single counter cannot distinguish from "the stage never fired".
    expect(memory.readerSearchCensus()).toEqual({
      attempted: 1,
      queries: 1,
      refused: 0,
      empty: 0,
      unranked: 0,
      promoted: 0,
    });
  });

  it('costs one call and no search when the model answers NONE', async () => {
    const { llm, calls } = scripted(['NONE']);
    const memory = system(llm, {
      relevanceFor: querySensitive,
      gate: { ...OPEN_GATE, sessionBudget: 2 },
      readerSearch: readerSearchOptions(),
    });
    await memory.answerSessions(QUESTION, [PLANT_SESSION, DOG_SESSION]);
    // The scripted model answers `NONE` to the decision call and to the answer call after it, so two calls
    // is the control's single call plus the refusal -- and no third, because a refused query is never
    // searched with.
    expect(calls).toHaveLength(2);
    expect(memory.readerSearchCensus()).toEqual({
      attempted: 1,
      queries: 0,
      refused: 1,
      empty: 0,
      unranked: 0,
      promoted: 0,
    });
  });

  it('counts a reply that came back with no usable line as empty, not as a refusal', async () => {
    // The state run `45974552492` bought. All 242 of its decision calls were cut by a 32-token bound while the
    // `multi-session` route reader thought before answering, so every reply arrived with no content token at
    // all -- and the census reported 242 refusals, which reads as a model declining on every question. The
    // verdict is now `empty`, and the reason it has to be a different counter is that the repair is
    // different: this one is a bound in this stage's own configuration, and that one is the reader's answer.
    const { llm, calls } = scripted(['   \n\n', ANSWER]);
    const memory = system(llm, {
      relevanceFor: querySensitive,
      gate: { ...OPEN_GATE, sessionBudget: 2 },
      readerSearch: readerSearchOptions(),
    });
    await memory.answerSessions(QUESTION, [PLANT_SESSION, DOG_SESSION]);
    // Same two calls as `NONE`: the stage fired, got nothing usable, and did not search -- so the answer is
    // the control's, byte for byte.
    expect(calls).toHaveLength(2);
    expect(memory.readerSearchCensus()).toEqual({
      attempted: 1,
      queries: 0,
      refused: 0,
      empty: 1,
      unranked: 0,
      promoted: 0,
    });
  });

  it('reports no promotion under an unbounded session budget, because nothing can be displaced', async () => {
    // The invariant run `45989342121` measured the hard way. `promoted` counts sessions in the final budget
    // whose entry the second query is the only reason for -- so it can only be non-zero when the budget
    // **bites**. `sessionBudget: null` is unbounded (`provider.ts`), the registered gate has it null, and
    // the first pass therefore already carries every eligible session: `selected \ firstPass` is empty by
    // construction, not by the mechanism failing.
    //
    // This test exists because that run's artifact reported `queries: 185, promoted: 0`, and the census's
    // own docstring calls `promoted` "the one number that separates 'looked twice' from 'got a longer
    // prompt'". On the only configuration that administers this stage, that number cannot move. The
    // assertion is the invariant, not the run: a finite budget below is what makes it move.
    const { llm } = scripted(['dog at the vet', ANSWER]);
    const memory = system(llm, {
      relevanceFor: querySensitive,
      readerSearch: readerSearchOptions({ k: 2 }),
    });
    await memory.answerSessions(QUESTION, [PLANT_SESSION, DOG_SESSION]);
    expect(memory.readerSearchCensus()).toEqual({
      attempted: 1,
      queries: 1,
      refused: 0,
      empty: 0,
      unranked: 0,
      // Not "the query found nothing": the prompt the reader receives is the same set either way, and only
      // its order can differ. A finite budget is what turns a promotion into a countable event.
      promoted: 0,
    });
  });

  it('is byte-identical to the control when the model refuses', async () => {
    const withStage = scripted(['NONE', ANSWER]);
    const control = scripted([ANSWER]);
    const sessions = [PLANT_SESSION, DOG_SESSION];
    const options = { relevanceFor: querySensitive, gate: { ...OPEN_GATE, sessionBudget: 2 } };
    await system(withStage.llm, { ...options, readerSearch: readerSearchOptions() }).answerSessions(
      QUESTION,
      sessions,
    );
    await system(control.llm, options).answerSessions(QUESTION, sessions);
    // The answer prompt is the last call on each side, and it must be the same string: a stage that fired,
    // declined, and still reordered or re-budgeted would be a treatment nobody registered.
    expect(withStage.calls.at(-1)?.prompt).toBe(control.calls.at(-1)?.prompt);
  });

  it('counts a question with no signal as unreached and consults no model', async () => {
    const { llm, calls } = scripted([ANSWER]);
    const memory = system(llm, { readerSearch: readerSearchOptions() });
    const answer = await memory.answerSessions(QUESTION, [PLANT_SESSION]);
    expect(answer).toBe(ANSWER);
    expect(calls).toHaveLength(1);
    expect(memory.readerSearchCensus()).toEqual({
      attempted: 1,
      queries: 0,
      refused: 0,
      empty: 0,
      unranked: 1,
      promoted: 0,
    });
  });

  it('reaches only the multi-session route', async () => {
    const { llm, calls } = scripted([ANSWER]);
    const memory = system(llm, {
      relevanceFor: querySensitive,
      readerSearch: readerSearchOptions(),
    });
    await memory.answer(QUESTION, [...PLANT_SESSION, ...DOG_SESSION]);
    expect(calls).toHaveLength(1);
    expect(memory.readerSearchCensus()).toEqual({
      attempted: 0,
      queries: 0,
      refused: 0,
      empty: 0,
      unranked: 0,
      promoted: 0,
    });
  });
});

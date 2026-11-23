/**
 * The second adapter, tested through the entry point a user calls.
 *
 * The first test is the one that matters most: the arm this class assembles has to be the arm
 * `assembleMemory` gives a customer, or the row it prints in a competitor table describes a system nobody
 * ships. Every other test here is about a decision the adapter makes *around* that assembly — what `search`
 * means for a system with no retrieval endpoint, how a refusal reaches a judge, and what `reset` is allowed
 * to throw away.
 */

import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';
import { describe, expect, it } from 'vitest';

import { assembleMemory } from '../assemble.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import { CortexProductProvider } from '../product-provider.js';
import type { ProviderSession } from '../provider.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const SESSIONS: readonly ProviderSession[] = [
  {
    id: 's1',
    at: T0,
    turns: [
      { role: 'user', content: '[2023/02/15 (Wed) 03:14] user: I moved to Porto in January.' },
      { role: 'assistant', content: '[2023/02/15 (Wed) 03:15] assistant: Noted, Porto.' },
    ],
  },
  {
    id: 's2',
    at: T0 + 10 * DAY,
    turns: [{ role: 'user', content: '[2023/02/25 (Sat) 09:00] user: I have two cats.' }],
  },
];

/**
 * An LLM that answers every prompt with the same line and counts its calls.
 *
 * The count is load-bearing: `search` must not call it, and the embedding cache test needs to prove the
 * *embedder* was not called, which is a different counter.
 */
function countingLlm(reply = 'Answer: Porto'): LLM & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    complete: () => {
      calls += 1;
      return Promise.resolve(reply);
    },
    completeStructured: <T>() => {
      calls += 1;
      return Promise.resolve({} as T);
    },
  };
}

/** A deterministic embedder with a call counter, so "cached" is measurable rather than assumed. */
function countingEmbed(dimensions = 8) {
  let calls = 0;
  let texts = 0;
  const embed = (batch: string[]): Promise<readonly Float64Array[]> => {
    calls += 1;
    texts += batch.length;
    return Promise.resolve(
      batch.map((text) => {
        // Content-dependent so two different texts cannot accidentally share a cache entry.
        const vector = new Float64Array(dimensions);
        for (let at = 0; at < dimensions; at += 1) {
          vector[at] = ((text.length + at * 7) % 13) / 13;
        }
        return vector;
      }),
    );
  };
  return {
    embed,
    get calls() {
      return calls;
    },
    get texts() {
      return texts;
    },
  };
}

function providerOf(
  overrides: {
    readonly llm?: LLM;
    readonly embed?: (batch: string[]) => Promise<readonly Float64Array[]>;
    readonly store?: () => SqliteStorage;
    readonly usage?: () => {
      readonly calls: number;
      readonly promptTokens: number;
      readonly completionTokens: number;
    };
  } = {},
): CortexProductProvider {
  const embed = overrides.embed ?? countingEmbed().embed;
  return new CortexProductProvider({
    llm: overrides.llm ?? countingLlm(),
    now: T0 + 30 * DAY,
    embed,
    storage: overrides.store ?? (() => new SqliteStorage()),
    ...(overrides.usage === undefined ? {} : { usage: overrides.usage }),
  });
}

describe('CortexProductProvider: the assembled product as a provider', () => {
  it('assembles the arm a bare `assembleMemory` gives a user, not a second configuration', async () => {
    // Bytes, not fields: a field that never reached the reader is exactly the defect `registered-arm.test.ts`
    // exists for, and this adapter is the independent witness because it reaches the product through the
    // published entry point rather than through `CortexMemory`'s constructor.
    const llm = countingLlm();
    const embed = countingEmbed();
    const provider = new CortexProductProvider({
      llm,
      now: T0 + 30 * DAY,
      embed: embed.embed,
      storage: () => new SqliteStorage(),
    });
    await provider.ingest(SESSIONS);
    // `MR` is the route `askStored` takes, so this is the one capability under which the two assemblies must be
    // byte-identical: the adapter resolving a different route from the same question is a different comparison,
    // and `product-provider-route.test.ts` is where the six routes are asserted.
    await provider.answer('Where did I move?', { limit: 10, capability: 'MR' });
    const throughAdapter = provider.lastPromptText();

    const direct = assembleMemory({
      llm,
      now: T0 + 30 * DAY,
      storage: new SqliteStorage(),
      embed: embed.embed,
    });
    await direct.memory.remember([
      { sessionId: 's1', ordinal: 0, text: SESSIONS[0]!.turns[0]!.content, at: T0 },
      { sessionId: 's1', ordinal: 1, text: SESSIONS[0]!.turns[1]!.content, at: T0 },
      { sessionId: 's2', ordinal: 0, text: SESSIONS[1]!.turns[0]!.content, at: T0 + 10 * DAY },
    ]);
    await direct.memory.askStored('Where did I move?');

    // One text, two assemblies. If the adapter ever grows an argument the manual does not document, this
    // fails at the byte where the two arms diverge rather than at a field nobody compared.
    expect(throughAdapter).not.toBeNull();
    expect(throughAdapter).toBe(direct.memory.lastPromptText());
  });

  it('reports what the store holds, not what the call offered', async () => {
    const provider = providerOf();
    const first = await provider.ingest(SESSIONS);
    expect(first.sessions).toBe(2);
    expect(first.turns).toBe(3);
    expect(first.duplicates).toBe(0);

    // A harness in `global` mode replays an overlapping haystack once per question. The held count must not
    // move, or the corpus column describes the call count; what does move is `duplicates`, which is the
    // report saying this call added nothing. Asserting both keeps a silent double-append from passing as a
    // replay: the first number alone would be satisfied by a store that grew and reported the old size.
    const replay = await provider.ingest(SESSIONS);
    expect(replay.sessions).toBe(first.sessions);
    expect(replay.turns).toBe(first.turns);
    expect(replay.duplicates).toBe(3);
  });

  it('answers through the product, not through a copy of its routing', async () => {
    const llm = countingLlm('Answer: Porto');
    const provider = providerOf({ llm });
    await provider.ingest(SESSIONS);
    expect(await provider.answer('Where did I move?')).toBe('Porto');
    expect(llm.calls).toBeGreaterThan(0);
  });

  it('returns nothing from `search` and does not consult the model to do it', async () => {
    // The product has no retrieval endpoint a shared reader could consume. Returning [] is the claim; the
    // counter is what makes the claim checkable, because a `search` that ran the assembly's selection and
    // then discarded it would also return [].
    const llm = countingLlm();
    const provider = providerOf({ llm });
    await provider.ingest(SESSIONS);
    expect(await provider.search('Where did I move?', { limit: 10 })).toEqual([]);
    expect(llm.calls).toBe(0);
  });

  it('renders a refusal as the product’s own abstention token, not as silence', async () => {
    // No corpus, so the product declines before calling the model — the first line of `memory.ts`'s header.
    // An empty string would be ambiguous to the judge's abstention template between "declined" and "returned
    // nothing", and the product already has a token that means the former.
    const llm = countingLlm();
    const provider = providerOf({ llm });
    expect(await provider.answer('Where did I move?')).toBe(ABSTAIN_TOKEN);
    expect(llm.calls).toBe(0);
  });

  it('forgets the corpus on reset and keeps the embedder', async () => {
    const embed = countingEmbed();
    const provider = providerOf({ embed: embed.embed });
    await provider.ingest(SESSIONS);
    // The index embeds a text when a question needs it, not when the turn is stored, so the first question
    // is what makes the embedding cost visible at all. A test that read the counter after `ingest` would be
    // asserting against zero and would pass for a product that never embedded.
    await provider.answer('Where did I move?');
    const afterFirst = embed.texts;
    expect(afterFirst).toBeGreaterThan(0);

    await provider.reset();
    const second = await provider.ingest(SESSIONS);
    await provider.answer('Where did I move?');
    // The corpus is the question's; the embedding cache is the run's. A fresh cache per question would
    // multiply the embedding bill by the question count and would be a different arm than the registered one.
    expect(second.sessions).toBe(2);
    expect(embed.texts).toBe(afterFirst);
  });

  it('starts a reset question with no evidence, so one question cannot answer from another', async () => {
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    await provider.reset();
    expect(await provider.answer('Where did I move?')).toBe(ABSTAIN_TOKEN);
  });
  it('reports the spend its caller metered, and leaves it unreported when nobody did', async () => {
    // `usage` absent is the artifact's "not measured", which is a different statement from a cost of zero: a
    // row whose bill is unknown and a row that cost nothing must not print the same thing. The product package
    // owns no provider, so the counter can only come from the caller -- here, a test that pretends to be the
    // metering proxy.
    expect(providerOf().usage).toBeUndefined();

    const meter = { calls: 0, promptTokens: 0, completionTokens: 0 };
    const measured = providerOf({ usage: () => ({ ...meter }) });
    meter.calls = 3;
    meter.promptTokens = 1_204;
    meter.completionTokens = 51;
    // Read at the end, not captured at construction: a snapshot would report the corpus build and none of the
    // answers, which is the direction that makes an arm look cheap.
    expect(measured.usage).toEqual({ calls: 3, promptTokens: 1_204, completionTokens: 51 });
  });
});

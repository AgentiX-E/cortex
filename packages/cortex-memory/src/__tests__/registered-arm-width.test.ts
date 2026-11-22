/**
 * The width the registration measured, reached from the published entry.
 *
 * ## The field this file exists for
 *
 * `registered-arm.ts` was written because the product could publish a number for one configuration and ship
 * another. It fixed `promptContract` and `ask` — two of the thirty-seven fields in the artifact — by giving
 * `assembleMemory` a default for each. The third, `relevanceTopK = 256`, got a constant and no reader: the
 * composition root passes `options.index` through untouched, so a bare `assembleMemory({ llm, storage })`
 * built a `SearchIndex` whose width resolved to `search-index.ts`'s own `DEFAULT_K = 64`.
 *
 * That is the same defect one field over, and it is the one that costs accuracy rather than typography:
 * `docs/USER-MANUAL.md` §6.6 tells a reader that the `reader` profile is **91.25% at 7,448 prompt tokens per
 * question**, and that reading was taken at 256. At 64 the ranking scores a quarter of the candidates, the
 * turns beyond the sixtieth position receive the unscored floor, and the selection falls back to arrival order
 * for exactly the questions a ranking exists to answer.
 *
 * ## Why the assertion is on a census field rather than on a private option
 *
 * A test that read `assembleMemory`'s own default would agree with a caller that never reached the index. The
 * width has to be observed **after a retrieval**, from the object that did the ranking, or the claim is about
 * the wiring instead of about what ran. `SearchCensus.k` is therefore added in the same change: the index
 * already reports how many turns, terms and vectors it saw, and the width is the one number that decides how
 * many of those turns could receive a score at all.
 *
 * ## What this file does not assert
 *
 * That 256 is better than 64 on LongMemEval. That is an accuracy claim, it needs a model and a dispatch, and
 * `arm-config-baseline.json` records the run that took it. What is checkable here, without a model, is the
 * narrower and prior claim: the product's own assembly produces the arm the artifact describes.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory, type AssembleOptions } from '../assemble.js';
import { REGISTERED_ARM } from '../registered-arm.js';
import { SearchIndex } from '../retrieval/search-index.js';

const NOW = 1_759_470_000_000;

function quietLlm(): LLM {
  return {
    complete: async () => 'Berlin',
    completeStructured: async () => {
      throw new Error('unused by this file');
    },
  };
}

/** Three sessions, the smallest transcript that reaches the multi-session route. */
const CONVERSATION = [
  { sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' },
  { sessionId: 's1', ordinal: 1, text: 'My landlord is called Anke.' },
  { sessionId: 's2', ordinal: 0, text: 'The invoice was paid late again.' },
  { sessionId: 's3', ordinal: 0, text: 'Anke raised the rent in June.' },
];

/** Assemble, remember, ask — the three steps a user takes, so the census describes a retrieval that ran. */
async function widthAfterOneQuestion(
  options: Omit<AssembleOptions, 'storage'> = { llm: quietLlm(), now: NOW },
): Promise<number | undefined> {
  const install = assembleMemory({ ...options, storage: new SqliteStorage() });
  await install.memory.remember(CONVERSATION);
  await install.memory.askStored('Where did I move?');
  return install.memory.lastIndexCensus()?.k;
}

describe('the reader profile scores at the width the registration measured', () => {
  it('a bare assembly reaches the registered width, not the index module default', async () => {
    // The value itself is pinned against the artifact by `registered-arm.test.ts`, which fails when
    // `arm-config-baseline.json` and the constant disagree in either direction. What is asserted here is the
    // prior claim that gate cannot make: that a retrieval built by the published entry reaches it.
    expect(await widthAfterOneQuestion()).toBe(REGISTERED_ARM.relevanceTopK);
  });

  it("a caller's width wins over the registered one", async () => {
    expect(await widthAfterOneQuestion({ llm: quietLlm(), now: NOW, index: { k: 12 } })).toBe(12);
  });

  it('minimal builds no index, so there is no width to report', async () => {
    // The census is asserted whole rather than through `.k`: `undefined` from a field lookup and `undefined`
    // from "no index exists" are the same value, and only the second is the statement `minimal` makes.
    const install = assembleMemory({
      llm: quietLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'minimal',
    });
    await install.memory.remember(CONVERSATION);
    await install.memory.askStored('Where did I move?');
    expect(install.memory.lastIndexCensus()).toBeUndefined();
  });
});

describe('the census answers "how wide would a search be" before one runs', () => {
  // The three states of `SearchCensus.k` are "a search resolved a width", "the configuration names one" and "the
  // module default". The assembly tests above reach the first; these reach the other two, because a field whose
  // fallbacks are never exercised is a field that reports whatever the last branch happened to return.
  it('a configured width is reported before the first search', () => {
    expect(new SearchIndex({ k: 7 }).census().k).toBe(7);
  });

  it('no configuration and no search is the module default, not zero', () => {
    // Zero would sort below every real width and would read as "nothing was scored", which is the one statement an
    // un-run index cannot make.
    expect(new SearchIndex().census().k).toBeGreaterThan(0);
  });
});

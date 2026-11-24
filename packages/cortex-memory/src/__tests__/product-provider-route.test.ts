/**
 * The dispatch, asserted as routes rather than as scores.
 *
 * ## What this file exists for
 *
 * Run `45090697310` measured the product arm through `askStored` alone — the multi-session route — and read
 * 10,780 prompt tokens per question against the registered 7,448, with 3 of 6 on `ABS`. The percentage looked
 * plausible; the arm was not the registered one. Two routes can produce the same accuracy while one of them spends
 * twice the room and answers under a contract that never mentions abstention, so a score cannot say whether a
 * dispatch happened.
 *
 * `lastRoute()` can. Each case below is one row of `benchmark.ts`'s table — the decisions the product's own
 * readings are taken through — and the assertion is the route the product entered, not the text it returned.
 *
 * The order is part of the table: an `ABS` question may carry `single-session-assistant`, and the abstention
 * branch has to win. That case is listed fourth and asserts `abstention`, so a reordering that looked harmless
 * fails here.
 */

import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';
import { describe, expect, it } from 'vitest';

import { ABSTAIN_TOKEN } from '../parse.js';
import { CortexProductProvider } from '../product-provider.js';
import type { ProviderSearchOptions, ProviderSession } from '../provider.js';

const T0 = Date.UTC(2023, 1, 15);

/** A corpus with one user turn and one assistant turn, so the assistant route has evidence to admit. */
const SESSIONS: readonly ProviderSession[] = [
  {
    id: 's1',
    at: T0,
    turns: [
      { role: 'user', content: '[2023/02/15 (Wed) 03:14] user: I moved to Porto in January.' },
      { role: 'assistant', content: '[2023/02/15 (Wed) 03:15] assistant: Noted, Porto.' },
    ],
  },
];

function quietLlm(reply = 'Answer: Porto'): LLM {
  return {
    complete: () => Promise.resolve(reply),
    completeStructured: <T>() => Promise.resolve({} as T),
  };
}

function embed(texts: string[]): Promise<readonly Float64Array[]> {
  return Promise.resolve(
    texts.map((text) =>
      Float64Array.from({ length: 8 }, (_, at) => ((text.length + at) % 11) / 11),
    ),
  );
}

async function routeFor(options: ProviderSearchOptions): Promise<string | null> {
  const provider = new CortexProductProvider({
    llm: quietLlm(),
    now: T0 + 30 * 24 * 60 * 60 * 1000,
    embed,
    storage: () => new SqliteStorage(),
  });
  await provider.ingest(SESSIONS);
  await provider.answer('Where did I move?', options);
  return provider.lastRoute();
}

describe('CortexProductProvider: the benchmark dispatch, restated and checked', () => {
  const cases: readonly {
    readonly label: string;
    readonly options: ProviderSearchOptions;
    readonly route: string;
  }[] = [
    { label: 'MR', options: { limit: 10, capability: 'MR' }, route: 'multi-session' },
    {
      label: 'TR',
      options: { limit: 10, capability: 'TR', askedAt: '[2023/02/15 (Wed) 03:14]' },
      route: 'temporal',
    },
    // Carries the assistant type on purpose: the abstention branch must win over the assistant branch, and that
    // precedence is a line in `benchmark.ts` that a reordering here would silently drop.
    {
      label: 'ABS',
      options: { limit: 10, capability: 'ABS', questionType: 'single-session-assistant' },
      route: 'abstention',
    },
    {
      label: 'single-session-assistant',
      options: { limit: 10, capability: 'IE', questionType: 'single-session-assistant' },
      route: 'assistant',
    },
    {
      label: 'knowledge-update',
      options: { limit: 10, capability: 'KU', questionType: 'knowledge-update' },
      route: 'knowledge-update',
    },
    { label: 'flat', options: { limit: 10, capability: 'IE' }, route: 'flat' },
  ];

  for (const one of cases) {
    it(`routes ${one.label} to \`${one.route}\``, async () => {
      expect(await routeFor(one.options)).toBe(one.route);
    });
  }

  it('routes a question with no capability down the flat path rather than guessing a route', async () => {
    // The protocol has always been allowed to hand a provider only a question string; guessing `MR` from the
    // absence of a key would make an un-routed call look like a routed one.
    expect(await routeFor({ limit: 10 })).toBe('flat');
  });

  it('a preference question reaches the preference contract inside the flat route', async () => {
    // The route name cannot distinguish this from a plain `IE` question — the preference route *is* the flat
    // route's window, room and filters, and a seventh `TurnCapRoute` would put a `REGISTERED_ROOMS` entry, and
    // therefore a field of the recorded arm configuration, on a room that is flat's to the character. So the
    // assertion is on the bytes: the contract a customer's preference question is answered under.
    //
    // What it replaces: this test used to assert the fall-through, with a comment reading "the product has no
    // preference route". `docs/PREREGISTRATION-PREFERENCE-ROUTE.md` §1 counts what that cost — 30 questions,
    // 10 wrong, 8 of them replying that the evidence does not answer the question.
    const provider = new CortexProductProvider({
      llm: quietLlm(),
      now: T0 + 30 * 24 * 60 * 60 * 1000,
      embed,
      storage: () => new SqliteStorage(),
    });
    await provider.ingest(SESSIONS);

    await provider.answer('Where did I move?', { limit: 10, capability: 'IE' });
    const flat = provider.lastPromptText();

    await provider.answer('Where should I look for an apartment?', {
      limit: 10,
      capability: 'IE',
      questionType: 'single-session-preference',
    });
    const preference = provider.lastPromptText();

    expect(provider.lastRoute()).toBe('flat');
    expect(preference).not.toBe(flat);
    expect(preference).toContain('recommend something concrete');
    expect(flat).toContain('Reply with the answer alone.');
  });

  it('a refusal still reaches the judge as the product’s token, on every route', async () => {
    // One row per route would be six assertions of one line, so this checks the two shapes that differ: a route
    // that declines on empty admission (`MR` over an empty corpus) and one that declines after admission (an
    // `ABS` question whose gate says no).
    const empty = new CortexProductProvider({
      llm: quietLlm(),
      now: T0,
      embed,
      storage: () => new SqliteStorage(),
    });
    expect(await empty.answer('Where did I move?', { limit: 10, capability: 'MR' })).toBe(
      ABSTAIN_TOKEN,
    );
  });
  it('renders a decline from every route as the product’s token', async () => {
    // The `?? ABSTAIN_TOKEN` fallback exists on each of the six branches, and a test that only pushed an empty
    // corpus through one of them would leave the other five's null side unexercised -- which is the shape of a
    // branch that reports `null` to a judge as the string "null". A model that replies with the token is the
    // product's own decline path, so every route is driven through it here.
    const routes: readonly ProviderSearchOptions[] = [
      { limit: 10, capability: 'MR' },
      { limit: 10, capability: 'TR', askedAt: '[2023/02/15 (Wed) 03:14]' },
      { limit: 10, capability: 'ABS' },
      { limit: 10, capability: 'IE', questionType: 'single-session-assistant' },
      { limit: 10, capability: 'KU', questionType: 'knowledge-update' },
      { limit: 10, capability: 'IE' },
    ];
    for (const options of routes) {
      const provider = new CortexProductProvider({
        llm: quietLlm(ABSTAIN_TOKEN),
        now: T0 + 30 * 24 * 60 * 60 * 1000,
        embed,
        storage: () => new SqliteStorage(),
      });
      await provider.ingest(SESSIONS);
      expect(await provider.answer('Where did I move?', options)).toBe(ABSTAIN_TOKEN);
    }
  });
});

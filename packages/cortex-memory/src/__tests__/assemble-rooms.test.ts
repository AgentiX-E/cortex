/**
 * The room a call that names nothing gets: the table the registration recorded.
 *
 * ## The gap this closes
 *
 * `assembleMemory` passed `maxPromptChars` only when a caller stated one, so a bare call fell through to
 * `CortexMemory`'s global 48,000 on **every** route. That is not the registered arm and it is not one of
 * the three cells `S15`/`S16` priced: the shipping configuration gives `multi-session` 48,460 characters
 * and the other five 24,000, which is **91.25% at 7,448 prompt tokens per question**, and a deployment that
 * wrote nothing got a fourth, unmeasured table at a higher bill.
 *
 * The module comment in `assemble.ts` used to defend the omission with "a second default would be a second
 * arm". The argument is sound and its conclusion was inverted: the registered table is the **first** arm,
 * so a composition root that declines to name it does not decline to have one -- it takes the class's
 * global instead. §32.6 of the plan records the correction.
 *
 * ## Why the assertions are prompts rather than fields
 *
 * `#promptCharsFor` is private and stays private: `roomFor(route)` would be a public method that exists for
 * a test. What a deployment actually receives is the assembled prompt, and prompts are deterministic on a
 * fixed corpus (`prompt-determinism.test.ts` holds that), so byte equality between two assemblies is a
 * stronger statement than reading a constant -- it says the table reached the prompt through the route the
 * customer calls, not that a field was set.
 *
 * The two routes that make the table observable are `temporal` (24,000 under the registration, 48,000
 * under the global) and `multi-session` (48,460 under both). A test that only asked `askStored` could not
 * tell the table from the global, because `askStored` routes to `multi-session`; that is why both are here.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import { REGISTERED_ROOMS } from '../rooms.js';
import { TURN_CAP_ROUTES } from '../types.js';

const NOW = 1_759_470_000_000;

function recordingLlm(seen: string[] = []): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Berlin';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/**
 * A transcript larger than the widest room, so every route's prompt is actually cut by it.
 *
 * Sixty short paragraphs of 900 characters over three sessions: 54,000 characters, which is above 48,460
 * and far above 24,000. A corpus smaller than a room would render identically under both tables and the
 * assertion would hold for the wrong reason.
 */
function longConversation(): { sessionId: string; ordinal: number; text: string }[] {
  // The sentence is repeated as a whole. The first draft repeated only its tail, which produced 360-character
  // turns and a 21,650-character corpus -- below every room in the table, so all six routes rendered
  // identically and every assertion below held for the wrong reason. The corpus size is asserted first for
  // that reason.
  const SENTENCE =
    'We walked along the canal and talked about the roof repair, the invoice from the builder, and the plan ' +
    'for the winter. ';
  const paragraph = (index: number): string => `Entry ${index}. ${SENTENCE.repeat(8)}`;
  const turns: { sessionId: string; ordinal: number; text: string }[] = [];
  for (let index = 0; index < 60; index += 1) {
    turns.push({
      sessionId: `s${Math.floor(index / 20) + 1}`,
      ordinal: index % 20,
      text: paragraph(index),
    });
  }
  return turns;
}

const QUESTION = 'When did we talk about the roof repair?';

/** A corpus that is larger than the widest room, so none of the assertions below can pass on a small one. */
function corpusChars(): number {
  return longConversation().reduce((total, turn) => total + turn.text.length, 0);
}

function harness(rooms: { global?: number; table?: Record<string, number> } = {}): {
  flat: () => Promise<string>;
  multiSession: () => Promise<string>;
} {
  const seen: string[] = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: NOW,
    storage: new SqliteStorage(),
    ...(rooms.global === undefined ? {} : { maxPromptChars: rooms.global }),
    ...(rooms.table === undefined ? {} : { maxPromptCharsByRoute: rooms.table }),
  });
  let remembered: Promise<unknown> | undefined;
  const context = (): string[] => longConversation().map((turn) => turn.text);
  return {
    flat: async () => {
      remembered ??= install.memory.remember(longConversation());
      await remembered;
      seen.length = 0;
      await install.memory.answer(QUESTION, context());
      return seen[0] ?? '';
    },
    multiSession: async () => {
      remembered ??= install.memory.remember(longConversation());
      await remembered;
      seen.length = 0;
      await install.memory.askStored(QUESTION);
      return seen[0] ?? '';
    },
  };
}

describe('the room a bare call gets is the one the registration measured', () => {
  it('is the table `tools/arm-config-baseline.json` records, route for route', () => {
    // The gate that keeps this constant from drifting: the artefact the benchmark dispatches is described
    // by that file, and a default that disagreed with it would make "what ships is what was measured" false
    // in the one way no run would reveal -- the arm would be measured at one table and assembled at another.
    const baseline = JSON.parse(
      readFileSync(new URL('../../../../tools/arm-config-baseline.json', import.meta.url), 'utf8'),
    ) as { memoryArmConfig: { maxPromptCharsByRoute: Record<string, number> } };
    expect(REGISTERED_ROOMS).toEqual(baseline.memoryArmConfig.maxPromptCharsByRoute);
  });

  it('builds a corpus larger than the widest room', () => {
    expect(corpusChars()).toBeGreaterThan(REGISTERED_ROOMS['multi-session']);
  });

  it('covers the six routes and nothing else', () => {
    // `Partial<Record<TurnCapRoute, number>>` would accept a table missing a route and the fallback to the
    // global 48,000 would be silent. Key equality against `TURN_CAP_ROUTES` is what makes the table total.
    expect(Object.keys(REGISTERED_ROOMS).sort()).toEqual([...TURN_CAP_ROUTES].sort());
  });

  it('sends `flat` 24,000 characters when the caller names no room at all', async () => {
    const bare = await harness().flat();
    const table = await harness({ table: { ...REGISTERED_ROOMS } }).flat();
    const global = await harness({ global: 48_000 }).flat();

    // Byte equality with the explicit table: the default is not merely "a room", it is that table.
    expect(bare).toBe(table);
    // And it is not the class's global room, which is the configuration this round removes. The corpus is
    // 54,000 characters, so both rooms bind and the difference is the room rather than the corpus.
    expect(bare.length).toBeLessThan(global.length);
    expect(bare.length).toBeLessThanOrEqual(24_000 + 2_000);
    expect(global.length).toBeGreaterThan(24_000);
  });

  it('keeps `multi-session` wide under the same bare call, so the table is per route', async () => {
    const bare = await harness().multiSession();
    const narrow = await harness().flat();
    // 48,460 against 24,000 on one assembly: a single global room cannot produce both, which is what makes
    // this a statement about the table rather than about a number.
    expect(bare.length).toBeGreaterThan(narrow.length);
    expect(bare.length).toBeGreaterThan(24_000);
    expect(bare.length).toBeLessThanOrEqual(48_460 + 2_000);
    expect(bare).toBe(await harness({ table: { ...REGISTERED_ROOMS } }).multiSession());
  });

  it('lets one number still mean one room on every route', async () => {
    // A caller who states a global room is stating a different shape, and the table must not be merged into
    // it: `maxPromptChars: 48_000` means forty-eight thousand on all six routes, `flat` included.
    const bare = await harness().flat();
    const stated = await harness({ global: 48_000 }).flat();
    expect(stated).not.toBe(bare);
    expect(stated.length).toBeGreaterThan(bare.length);
  });

  it('reads a map beside a global room as an override on that room', async () => {
    // Both fields at once: the map names `flat`, and every route it does not name keeps the stated global.
    // The table is not merged in, because a caller who wrote 30,000 has already said what the unlisted
    // routes get, and honouring the table there would be the second answer to one question.
    const both = harness({ global: 30_000, table: { flat: 3_000 } });
    expect((await both.flat()).length).toBeLessThan(3_000 + 2_000);
    const wide = await both.multiSession();
    expect(wide.length).toBeGreaterThan(24_000);
    expect(wide.length).toBeLessThanOrEqual(30_000 + 2_000);
  });

  it('does not reach `minimal`, whose reading is quoted at the wide table', async () => {
    // `minimal` renders the transcript in arrival order and its published number (39.55%) was measured at
    // 48,000 characters. Handing it the registered table would move bytes under a reading nobody re-took,
    // and the profile exists for conformance rather than for a score.
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'minimal',
    });
    await install.memory.answer(
      QUESTION,
      longConversation().map((turn) => turn.text),
    );
    expect(seen[0]!.length).toBe(48_000);

    const narrow: string[] = [];
    const clipped = assembleMemory({
      llm: recordingLlm(narrow),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'minimal',
      maxPromptChars: 24_000,
    });
    await clipped.memory.answer(
      QUESTION,
      longConversation().map((turn) => turn.text),
    );
    expect(narrow[0]!.length).toBe(24_000);
  });

  it("lets a caller's map override one route and leave the rest registered", async () => {
    // The partial map is an **override on the table**, not a second table. Without the merge, naming one
    // route would hand the other five 48,000 -- the unmeasured configuration this file exists to remove,
    // reintroduced by the field a caller reaches for when they want to be careful.
    const overridden = harness({ table: { flat: 3_000 } });
    const bare = harness();
    expect((await overridden.flat()).length).toBeLessThan(3_000 + 2_000);
    expect(await overridden.multiSession()).toBe(await bare.multiSession());
  });
});

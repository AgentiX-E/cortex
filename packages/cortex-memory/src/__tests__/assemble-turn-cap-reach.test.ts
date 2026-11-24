/**
 * The width's reach, from the composition root: the registered cap stops at two routes, and until this
 * field existed the published entry could only run it over all six.
 *
 * ## The defect, stated as the two ways a caller could be wrong
 *
 * `assemble.ts` forwards `maxTurnChars` and had no `maxTurnCharsRoutes`, so the reach was whatever
 * `CortexMemory` defaults to — every route. The arm every published number was taken with is `400` on
 * `multi-session` and `temporal` and **no cap** on the other four, and §13.72 is the run that says why the
 * difference is not a matter of degree: the global cap bought **+13 on `MR` and cost −30 on `IE`**, and the
 * thirty were questions that `correct → abstention` at a median coverage of 100%. So a caller reading the
 * manual had two configurations available and one of them was the rejected one:
 *
 * | what the caller wrote | what they got |
 * | --- | --- |
 * | nothing | every turn whole — not the cell `S16` priced |
 * | `maxTurnChars: 400` | the cap on `IE`, which the campaign measured and did not adopt |
 *
 * `maxTurnCharsRoutes` has been a `CortexMemoryOptions` field, and a row in `docs/USER-MANUAL.md`, since
 * §13.72. What was missing was the field one layer up, which is requirement ⑯'s asymmetry arriving through
 * a composition root: the capability shipped, and the one function an installer calls could not name it.
 *
 * ## Why the assertions are prompt bytes
 *
 * The same argument `assemble-rooms.test.ts` makes for the room table: a test that read the option back
 * would pass on an `assembleMemory` that stored it and never forwarded it. Prompts are deterministic on a
 * fixed corpus, so byte equality between two assemblies says the reach arrived at the renderer through the
 * route a customer calls, and inequality says it arrived somewhere it should not have.
 *
 * Two routes make the reach observable and they are not interchangeable: `answer` is the `flat` route
 * (`#answerFlat`), which the registered list does **not** name, and `askStored` is `multi-session`, which it
 * does. One function of each is the smallest harness in which "reaches this route" and "reaches every route"
 * are different predictions.
 *
 * ## Why the corpus is small enough that the room never binds
 *
 * Every turn below is longer than the width and the whole transcript is under the narrower room, so the only
 * thing that can shorten a prompt here is the cap. A corpus above the room would make a capped prompt and a
 * truncated one indistinguishable, and the first draft of `assemble-rooms.test.ts` is the record of what that
 * costs: its assertions held for the wrong reason until the corpus was asserted first.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import type { TurnCapRoute } from '../types.js';

const NOW = 1_759_470_000_000;

/**
 * The width under test. Small enough that every marker below is cut, large enough to hold a whole one.
 *
 * `40` is not the registered `400` and deliberately so: the assertion is about which routes the width
 * reaches, and a width that cut nothing would make every prompt identical and every equality below true for
 * the wrong reason. The registered value is `registered-arm.test.ts`'s subject, which reads it from the
 * artefact.
 */
const WIDTH = 40;

function recordingLlm(seen: string[] = []): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'the canal';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/**
 * Twelve long turns over two sessions, each with a marker at its head and one past the width.
 *
 * The two markers are the mechanism of the test: `HEAD-n` is inside the width, `DEEP-n` is not. A prompt
 * carrying `DEEP-n` was not cut, and a prompt carrying `HEAD-n` followed by exactly `WIDTH` characters was.
 */
function longTurns(): { sessionId: string; ordinal: number; text: string }[] {
  const turns: { sessionId: string; ordinal: number; text: string }[] = [];
  for (let index = 0; index < 12; index += 1) {
    // 600 characters: above the width by an order of magnitude, and small enough that twelve of them are
    // 7,200 -- under the narrowest room in the table, so nothing here is truncated by a room.
    const head = `HEAD-${index} `;
    const deep = ` DEEP-${index} `;
    const filler = 'the canal and the roof repair were discussed again and again. ';
    turns.push({
      sessionId: `s${Math.floor(index / 6) + 1}`,
      ordinal: index % 6,
      text: `${head}${filler}${deep}${filler}${filler}${filler}`,
    });
  }
  return turns;
}

const QUESTION = 'When did we discuss the roof repair?';

type Harness = {
  readonly flat: () => Promise<string>;
  readonly multiSession: () => Promise<string>;
};

function harness(
  options: {
    maxTurnChars?: number;
    routes?: readonly TurnCapRoute[];
  } = {},
): Harness {
  const seen: string[] = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: NOW,
    storage: new SqliteStorage(),
    ...(options.maxTurnChars === undefined ? {} : { maxTurnChars: options.maxTurnChars }),
    ...(options.routes === undefined ? {} : { maxTurnCharsRoutes: options.routes }),
  });
  let remembered: Promise<unknown> | undefined;
  const context = (): string[] => longTurns().map((turn) => turn.text);
  return {
    flat: async () => {
      remembered ??= install.memory.remember(longTurns());
      await remembered;
      seen.length = 0;
      await install.memory.answer(QUESTION, context());
      return seen[0] ?? '';
    },
    multiSession: async () => {
      remembered ??= install.memory.remember(longTurns());
      await remembered;
      seen.length = 0;
      await install.memory.askStored(QUESTION);
      return seen[0] ?? '';
    },
  };
}

/** The part of a turn the width keeps, and the part it removes. */
const HEAD = 'HEAD-4 ';
const PAST_WIDTH = ' DEEP-4 ';

describe('the width’s reach is nameable from the published entry', () => {
  it('builds a corpus no room in the table can truncate', () => {
    // The precondition every assertion below depends on. 7,200 characters against the narrowest registered
    // room, so a shorter prompt is the cap and never the room.
    const total = longTurns().reduce((sum, turn) => sum + turn.text.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(24_000);
    expect(Math.min(...longTurns().map((turn) => turn.text.length))).toBeGreaterThan(WIDTH);
  });

  it('cuts `multi-session` at the width and leaves `flat` byte-identical', async () => {
    // The assertion the field exists for. One assembly, two routes, two different renderings -- which a
    // single global reach cannot produce.
    const bare = harness();
    const reached = harness({ maxTurnChars: WIDTH, routes: ['multi-session', 'temporal'] });

    const capped = await reached.multiSession();
    const uncapped = await bare.multiSession();
    expect(capped).not.toBe(uncapped);
    expect(capped.length).toBeLessThan(uncapped.length);

    // The cut is at the width, not merely "shorter": the head survives entire and the character past it does
    // not. `slice(0, WIDTH)` is unique in the prompt because `HEAD-4` is unique in the corpus.
    const turn = longTurns()[4]!.text;
    const kept = turn.slice(0, WIDTH);
    expect(uncapped).toContain(turn);
    expect(capped).toContain(kept);
    expect(capped).not.toContain(turn.slice(0, WIDTH + 1));

    // And the route the registered list does not name is untouched, byte for byte. This is the half a test
    // that only asserted "the cap applied somewhere" would miss, and it is the half §13.72 paid thirty `IE`
    // questions for.
    expect(await reached.flat()).toBe(await bare.flat());
  });

  it('reaches every route when the width is named without a reach, which is the rejected arm', async () => {
    // The defect, kept as a test rather than as a paragraph: `CortexMemory`'s absent list means all routes, so
    // this call is the global cap. It is reachable, documented, and not what the registration measured -- the
    // reason the field above exists is to make this a choice rather than the only option.
    const bare = harness();
    const global = harness({ maxTurnChars: WIDTH });

    const cappedFlat = await global.flat();
    expect(cappedFlat).not.toBe(await bare.flat());
    expect(cappedFlat).not.toContain(PAST_WIDTH);
    expect(cappedFlat).toContain(HEAD);
    expect(await global.multiSession()).not.toContain(PAST_WIDTH);
  });

  it('treats an empty list as a width that reaches nowhere', async () => {
    // `[]` is how a sweep disables the axis without editing the configuration it compares against, and it has
    // to be distinguishable from `undefined` in both directions: same bytes as a bare call here, different
    // bytes from the global cap above.
    const bare = harness();
    const inert = harness({ maxTurnChars: WIDTH, routes: [] });
    expect(await inert.flat()).toBe(await bare.flat());
    expect(await inert.multiSession()).toBe(await bare.multiSession());
    expect(await harness({ maxTurnChars: WIDTH }).flat()).not.toBe(await bare.flat());
  });

  it('reaches `temporal` and `multi-session` by different spellings of one list', async () => {
    // The list is a set, not an order. A registration that recorded the routes in the other order has to
    // describe the same arm, so the comparison is between prompts rather than between arrays.
    const ordered = harness({ maxTurnChars: WIDTH, routes: ['multi-session', 'temporal'] });
    const reversed = harness({ maxTurnChars: WIDTH, routes: ['temporal', 'multi-session'] });
    expect(await ordered.multiSession()).toBe(await reversed.multiSession());
    expect(await ordered.flat()).toBe(await reversed.flat());
  });
});

/**
 * The width's reach, from the composition root: which routes the cap stops at, and what a bare call gets.
 *
 * ## The defect this file was written for, and the second one it now also covers
 *
 * `assemble.ts` forwarded `maxTurnChars` and had no `maxTurnCharsRoutes`, so the reach was whatever
 * `CortexMemory` defaults to — every route. The arm every published number was taken with is `400` on
 * `multi-session` and `temporal` and **no cap** on the other four, and §13.72 is the run that says why the
 * difference is not a matter of degree: the global cap bought **+13 on `MR` and cost −30 on `IE`**, and the
 * thirty were questions that `correct → abstention` at a median coverage of 100%. So a caller reading the
 * manual had two configurations available and one of them was the rejected one:
 *
 * | what the caller wrote | what they got, before this round | what they get now |
 * | --- | --- | --- |
 * | nothing | every turn whole — not the cell `S16` priced | the registered rendering: `400` on two routes |
 * | `maxTurnChars: 400` | the cap on `IE`, which the campaign measured and did not adopt | the same `400`, still on two routes |
 * | `maxTurnCharsRoutes: []` | nothing to reach with — the field did not exist | a width that reaches nowhere |
 *
 * The third row is what keeps the second honest: a default that cannot be stepped away from is not a
 * default, and `[]` is the documented spelling of "no cap" because the reach is a list rather than a boolean.
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
 * Every turn below is longer than every width under test, and the whole transcript is under the narrower
 * room, so the only thing that can shorten a prompt here is the cap. A corpus above the room would make a
 * capped prompt and a truncated one indistinguishable, and the first draft of `assemble-rooms.test.ts` is
 * the record of what that costs: its assertions held for the wrong reason until the corpus was asserted
 * first.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import { REGISTERED_ARM } from '../registered-arm.js';
import type { TurnCapRoute } from '../types.js';

const NOW = 1_759_470_000_000;

/**
 * The width under test, small enough that every marker below is cut.
 *
 * `40` is not the registered `400` and deliberately so: the assertions are about which routes the width
 * reaches, and a width that cut nothing would make every prompt identical and every equality below true for
 * the wrong reason. The registered value is exercised by the bare-call group at the end, which reads it out
 * of `REGISTERED_ARM` rather than repeating it.
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
 * Twelve long turns over two sessions, each with a marker at its head and one past every width under test.
 *
 * The two markers are the mechanism: `HEAD-n` is inside the width, `DEEP-n` is not. A prompt carrying
 * `DEEP-n` was not cut, and a prompt carrying `HEAD-n` followed by exactly the width was.
 *
 * 900 characters per turn: more than twice the registered width, so the bare-call group below can tell the
 * registered rendering from the uncapped one as well, and twelve of them are 10,800 — under the narrowest
 * room in the table, so nothing here is truncated by a room.
 */
function longTurns(): { sessionId: string; ordinal: number; text: string }[] {
  const filler = 'the canal and the roof repair were discussed again and again. ';
  const turns: { sessionId: string; ordinal: number; text: string }[] = [];
  for (let index = 0; index < 12; index += 1) {
    turns.push({
      sessionId: `s${Math.floor(index / 6) + 1}`,
      ordinal: index % 6,
      text: `HEAD-${index} ${filler} DEEP-${index} ${filler.repeat(11)}`,
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
    // The rendering is **held**, because this file measures reach and not rendering: every assertion below
    // is about which routes the width stops at, and the strings it compares are the head cut's. Since
    // `45543010618` the default is the form list, so a harness that named nothing would render the excerpt
    // and record here and the width's reach would be unobservable from these prompts. The default's own
    // reach is `resolution-default.test.ts`'s subject, where the form is the variable.
    resolution: 'raw' as const,
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

/** The pre-cap rendering: the registered width named, reaching nowhere. The opt-out the default needs. */
const uncapped = (): Harness => harness({ maxTurnChars: REGISTERED_ARM.maxTurnChars, routes: [] });

/** The part of a turn the width keeps, and the part it removes. */
const HEAD = 'HEAD-4 ';
const PAST_WIDTH = ' DEEP-4 ';

describe('the width’s reach is nameable from the published entry', () => {
  it('builds a corpus no room in the table can truncate', () => {
    // The precondition every assertion below depends on: under 24,000 characters against the narrowest
    // registered room, and every turn longer than the registered width so the bare-call group can tell the
    // two renderings apart.
    const turns = longTurns();
    const total = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(24_000);
    expect(Math.min(...turns.map((turn) => turn.text.length))).toBeGreaterThan(
      REGISTERED_ARM.maxTurnChars,
    );
  });

  it('cuts `multi-session` at the width and leaves `flat` byte-identical', async () => {
    // The assertion the field exists for. One assembly, two routes, two different renderings -- which a
    // single global reach cannot produce.
    const base = uncapped();
    const reached = harness({ maxTurnChars: WIDTH, routes: ['multi-session', 'temporal'] });

    const capped = await reached.multiSession();
    const uncut = await base.multiSession();
    expect(capped).not.toBe(uncut);
    expect(capped.length).toBeLessThan(uncut.length);

    // The cut is at the width, not merely "shorter": the head survives entire and the character past it does
    // not. `slice(0, WIDTH)` is unique in the prompt because `HEAD-4` is unique in the corpus.
    const turn = longTurns()[4]!.text;
    const kept = turn.slice(0, WIDTH);
    expect(uncut).toContain(turn);
    expect(capped).toContain(kept);
    expect(capped).not.toContain(turn.slice(0, WIDTH + 1));

    // And the route the registered list does not name is untouched, byte for byte. This is the half a test
    // that only asserted "the cap applied somewhere" would miss, and it is the half §13.72 paid thirty `IE`
    // questions for.
    expect(await reached.flat()).toBe(await base.flat());
  });

  it('reaches every route when the width is named without a reach, which is the rejected arm', async () => {
    // `CortexMemory`'s absent list means all routes, and naming only the width keeps that: a caller who
    // states a width has stated this decision, and deriving a reach for them would be a second answer. The
    // configuration is reachable, documented, and not what the registration measured — which is why the
    // default above it exists.
    const base = uncapped();
    const global = harness({ maxTurnChars: WIDTH });

    const cappedFlat = await global.flat();
    expect(cappedFlat).not.toBe(await base.flat());
    expect(cappedFlat).not.toContain(PAST_WIDTH);
    expect(cappedFlat).toContain(HEAD);
    expect(await global.multiSession()).not.toContain(PAST_WIDTH);
  });

  it('treats an empty list as a width that reaches nowhere', async () => {
    // `[]` is how a sweep disables the axis without editing the configuration it compares against, and how a
    // caller asks for the pre-cap rendering now that the reach defaults. It has to be distinguishable from
    // `undefined` in both directions.
    const inert = harness({ maxTurnChars: WIDTH, routes: [] });
    expect(await inert.flat()).toBe(await uncapped().flat());
    expect(await inert.multiSession()).toBe(await uncapped().multiSession());
    // The global cap differs on this route; the registered reach does not, which is the next group's subject.
    expect(await harness({ maxTurnChars: WIDTH }).flat()).not.toBe(await uncapped().flat());
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

describe('a call that names no width gets the one the registration measured', () => {
  it('is the registered width on the registered routes, not the class’s uncapped rendering', async () => {
    // The default, asserted as behaviour rather than as a constant: the bare call and the registered pair
    // named explicitly assemble the same prompt, and both differ from the uncapped one. The width is read
    // out of `REGISTERED_ARM` rather than repeated, so a re-recorded arm moves this test with it instead of
    // leaving a second copy of the number behind.
    const bare = await harness().multiSession();
    const registered = await harness({
      maxTurnChars: REGISTERED_ARM.maxTurnChars,
      routes: REGISTERED_ARM.maxTurnCharsRoutes,
    }).multiSession();
    const uncut = await uncapped().multiSession();

    expect(bare).toBe(registered);
    expect(bare).not.toBe(uncut);
    const turn = longTurns()[4]!.text;
    expect(uncut).toContain(turn);
    expect(bare).toContain(turn.slice(0, REGISTERED_ARM.maxTurnChars));
    expect(bare).not.toContain(turn.slice(0, REGISTERED_ARM.maxTurnChars + 1));
  });

  it('leaves the four routes the reach does not name whole', async () => {
    // The same halves as §13.72's reading, one default higher up: `flat` under a bare call is byte-identical
    // to `flat` under the opt-out, so the default did not spread to the routes the registration excludes.
    expect(await harness().flat()).toBe(await uncapped().flat());
  });

  it('withholds the default from `minimal`, whose number was taken at another rendering', async () => {
    // `minimal` is the profile whose 39.55% was measured at a table and a contract nobody re-ran; handing it
    // the registered width would move bytes under that reading. Same branch, same reason as the room table.
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'minimal',
    });
    await install.memory.remember(longTurns());
    seen.length = 0;
    await install.memory.askStored(QUESTION);
    const prompt = seen[0] ?? '';
    const turn = longTurns()[4]!.text;
    // Whatever `minimal` delivers, nothing it prints is cut at the registered width: the character past that
    // width is present whenever that turn reached the prompt at all.
    if (prompt.includes(HEAD)) {
      expect(prompt).toContain(turn.slice(0, REGISTERED_ARM.maxTurnChars + 1));
    }
  });
});

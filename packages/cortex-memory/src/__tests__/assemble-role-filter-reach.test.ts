/**
 * The role filter's reach, from the composition root: which routes it stops at, and what a bare call gets.
 *
 * ## The defect this file covers
 *
 * `evidenceRoles` and `evidenceRolesRoutes` were the last two rows of the table `registered-arm.ts` kept beside
 * the gate. `CortexMemory` has had both since §13.84, `cortex-eval` has dispatched them in every run since, and
 * `assembleMemory` had no field for either — so the one call the published package documents assembled a window
 * holding every assistant turn the arm excludes. Three configurations were therefore available to a customer
 * and the default was the one no dispatch priced:
 *
 * | what the caller wrote | what they got, before this round | what they get now |
 * | --- | --- | --- |
 * | `roleOf` only | the field did not exist; every turn printed | `['user']` on `multi-session` and `temporal` |
 * | nothing | every turn printed, and no census to say why | the same, plus `lastRoleCensus() === null` |
 * | `evidenceRolesRoutes: []` | nothing to reach with | the census runs and no turn is dropped |
 *
 * The middle row is the part that is easy to get wrong: a filter needs a reader for the corpus's role format, and
 * a product that guessed one would be wrong on the second dataset. Absence is therefore *stated* rather than
 * silently equivalent.
 *
 * ## Why the assertions are prompt bytes
 *
 * `assemble-turn-cap-reach.test.ts`'s argument, unchanged: a test that read the option back would pass on a
 * composition root that stored it and never forwarded it. Prompts are deterministic on a fixed corpus, so byte
 * equality between two assemblies says the reach arrived at the renderer through the route a customer calls.
 *
 * Two routes again, and they are the two halves of this mechanism rather than two examples of it: `askStored` is
 * `multi-session`, which the registered list names, and `answer` is `flat`, which it does not. One function of
 * each is the smallest harness in which "reaches this route" and "reaches every route" are different predictions
 * — and the fourth group below runs the reach the other way round, which is the only way to tell a per-route
 * filter from a global one that happens to be pointed at these two.
 *
 * ## Why the corpus is small enough that neither a room nor the ranking can confuse the reading
 *
 * Six short turns over two sessions, ~800 characters: far under the narrowest room in the table and far under
 * `relevanceTopK`, so no turn is cut and none is ranked out. Every difference below is therefore the filter.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import { REGISTERED_ARM } from '../registered-arm.js';
import type { RoleCensus, TurnCapRoute } from '../types.js';

const NOW = 1_759_470_000_000;

function recordingLlm(seen: string[] = []): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'the boiler, in March';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/**
 * Six turns, alternating, two per role and two sessions, each carrying a marker that is unique in the corpus.
 *
 * The prefixes are the campaign's haystack format, and they are **content** rather than a field: the product
 * stores text, so a role reaches it only through the classifier the caller supplies. `USER-n` and `CLAIM-n` are
 * what the assertions look for — a prompt carrying a `CLAIM-n` was not filtered.
 */
function turns(): { sessionId: string; ordinal: number; text: string }[] {
  const body = 'we talked about the boiler, the guarantee and the invoice for a while. ';
  const out: { sessionId: string; ordinal: number; text: string }[] = [];
  for (let index = 0; index < 6; index += 1) {
    const user = index % 2 === 0;
    out.push({
      sessionId: `s${Math.floor(index / 3) + 1}`,
      ordinal: index % 3,
      text: `[2023/02/${String(10 + index).padStart(2, '0')} (Fri) 10:0${index}] ${
        user ? 'user' : 'assistant'
      }: ${user ? 'USER' : 'CLAIM'}-${index} ${body}`,
    });
  }
  return out;
}

/** The classifier this corpus needs, written here because the product deliberately owns none. */
function roleOf(text: string): string | undefined {
  return /^\[[^\]]+\]\s*(user|assistant)\s*:/i.exec(text)?.[1]?.toLowerCase();
}

const QUESTION = 'When was the boiler replaced?';

type Reading = {
  readonly prompt: string;
  readonly census: RoleCensus | null;
};

type Harness = {
  readonly flat: () => Promise<Reading>;
  readonly multiSession: () => Promise<Reading>;
};

function harness(
  options: {
    roleOf?: (turn: string) => string | undefined;
    evidenceRoles?: readonly string[];
    routes?: readonly TurnCapRoute[];
    profile?: 'minimal' | 'reader' | 'full';
  } = {},
): Harness {
  const seen: string[] = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: NOW,
    storage: new SqliteStorage(),
    ...(options.roleOf === undefined ? {} : { roleOf: options.roleOf }),
    ...(options.evidenceRoles === undefined ? {} : { evidenceRoles: options.evidenceRoles }),
    ...(options.routes === undefined ? {} : { evidenceRolesRoutes: options.routes }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  });
  let remembered: Promise<unknown> | undefined;
  const context = (): string[] => turns().map((turn) => turn.text);
  const read = (): Reading => ({ prompt: seen[0] ?? '', census: install.memory.lastRoleCensus() });
  return {
    flat: async () => {
      remembered ??= install.memory.remember(turns());
      await remembered;
      seen.length = 0;
      await install.memory.answer(QUESTION, context());
      return read();
    },
    multiSession: async () => {
      remembered ??= install.memory.remember(turns());
      await remembered;
      seen.length = 0;
      await install.memory.askStored(QUESTION);
      return read();
    },
  };
}

/** The pre-filter rendering: a classifier with nothing to reach. The opt-out the default needs. */
const unfiltered = (): Harness => harness({ roleOf, routes: [] });

describe('the role filter’s reach is nameable from the published entry', () => {
  it('builds a corpus no room in the table can truncate', () => {
    // The precondition every assertion below depends on. A truncated corpus would make a filtered prompt and a
    // short one indistinguishable, which is the mistake `assemble-rooms.test.ts` records once already.
    const all = turns();
    const total = all.reduce((sum, turn) => sum + turn.text.length, 0);
    expect(total).toBeGreaterThan(600);
    expect(total).toBeLessThan(24_000);
    // Two sessions, so the multi-session route builds rather than falling through to the flat one.
    expect(new Set(all.map((turn) => turn.sessionId)).size).toBe(2);
  });

  it('drops assistant turns on `multi-session` and leaves `flat` byte-identical', async () => {
    // The assertion the two fields exist for: one assembly, two routes, two different evidence sets — which a
    // global filter cannot produce, and which §13.72 measured as the difference between +13 `MR` and −30 `IE`.
    const base = unfiltered();
    const filtered = harness({ roleOf, evidenceRoles: ['user'], routes: ['multi-session'] });

    const kept = await filtered.multiSession();
    const whole = await base.multiSession();
    expect(kept.prompt).not.toBe(whole.prompt);
    expect(whole.prompt).toContain('CLAIM-1');
    expect(kept.prompt).toContain('USER-0');
    expect(kept.prompt).not.toContain('CLAIM-1');

    // And the route the registration does not name is untouched, byte for byte — the half a test that only
    // asserted "the filter applied somewhere" would miss.
    expect((await filtered.flat()).prompt).toBe((await base.flat()).prompt);
  });

  it('reaches every route when the roles are named without a reach, which is the rejected arm', async () => {
    // `CortexMemory`'s absent list means all routes, and naming only the roles keeps that: a caller who states
    // which roles are evidence has stated this decision, and deriving a reach for them would be a second
    // answer. The configuration is reachable, documented, and not what §13.84 adopted — which is why the
    // default above exists.
    const global = harness({ roleOf, evidenceRoles: ['user'] });
    const flat = await global.flat();
    expect(flat.prompt).not.toContain('CLAIM-1');
    expect(flat.prompt).toContain('USER-0');
  });

  it('reads the reach per route, which is why it can be pointed the other way', async () => {
    // The reach is a set of route names, not a boolean: named for `flat` alone, the filter has to apply there
    // and nowhere else. This is the assertion that distinguishes a per-route filter from a global one that
    // happens to be aimed at `multi-session`, and no reading in the campaign needed it because no arm was ever
    // dispatched this way — which is exactly why it belongs in a test rather than in a paragraph.
    const reversed = harness({ roleOf, evidenceRoles: ['user'], routes: ['flat'] });
    const base = unfiltered();

    expect((await reversed.flat()).prompt).not.toContain('CLAIM-1');
    expect((await reversed.flat()).prompt).toContain('USER-0');
    expect((await reversed.multiSession()).prompt).toBe((await base.multiSession()).prompt);
  });

  it('keeps the turns whose role the classifier cannot read', async () => {
    // The escape hatch, and the reason it is a rule rather than a courtesy: a classifier that fails on one turn
    // must not empty the window, because an empty window reads as a corpus with no evidence. `unclassified`
    // counts them, so the artifact can tell a filter defect from a corpus that never had a role.
    const mixed = harness({
      roleOf: (text) => (text.includes('CLAIM-3') ? undefined : roleOf(text)),
      evidenceRoles: ['user'],
      routes: ['multi-session'],
    });
    const reading = await mixed.multiSession();
    expect(reading.prompt).toContain('CLAIM-3');
    expect(reading.prompt).not.toContain('CLAIM-1');
    expect(reading.census).toEqual({ counts: { user: 3 }, unclassified: 1, total: 4 });
  });

  it('treats an empty reach as a filter that reaches nowhere', async () => {
    // `[]` is how a sweep disables the axis without editing the configuration it compares against, and how a
    // caller asks for the census without the filter. It has to be distinguishable from `undefined` in both
    // directions: the prompt equals the unfiltered one, and the census still runs.
    const inert = await harness({ roleOf, evidenceRoles: ['user'], routes: [] }).multiSession();
    expect(inert.prompt).toBe((await unfiltered().multiSession()).prompt);
    expect(inert.census?.counts).toEqual({ user: 3, assistant: 3 });
    // Whereas the global arm differs on this route, so the two configurations are not the same cell.
    expect((await harness({ roleOf, evidenceRoles: ['user'] }).multiSession()).prompt).not.toBe(
      inert.prompt,
    );
  });

  it('reaches `temporal` and `multi-session` by different spellings of one list', async () => {
    // The list is a set, not an order, and a registration that recorded the routes the other way round has to
    // describe the same arm — so the comparison is between prompts rather than between arrays.
    const ordered = harness({
      roleOf,
      evidenceRoles: ['user'],
      routes: ['multi-session', 'temporal'],
    });
    const reversed = harness({
      roleOf,
      evidenceRoles: ['user'],
      routes: ['temporal', 'multi-session'],
    });
    expect((await ordered.multiSession()).prompt).toBe((await reversed.multiSession()).prompt);
  });
});

describe('a call that names no filter gets the one the registration measured', () => {
  it('is the registered roles on the registered routes, not the reference window', async () => {
    // The default, asserted as behaviour rather than as a constant: the bare call and the registered pair named
    // explicitly assemble the same prompt, and both differ from the unfiltered one. The roles and the reach are
    // read out of `REGISTERED_ARM` rather than repeated, so a re-recorded arm moves this test with it instead of
    // leaving a second copy behind.
    const bare = await harness({ roleOf }).multiSession();
    const registered = await harness({
      roleOf,
      evidenceRoles: REGISTERED_ARM.evidenceRoles,
      routes: REGISTERED_ARM.evidenceRolesRoutes,
    }).multiSession();
    const whole = await unfiltered().multiSession();

    expect(bare.prompt).toBe(registered.prompt);
    expect(bare.prompt).not.toBe(whole.prompt);
    expect(bare.prompt).toContain('USER-0');
    expect(whole.prompt).toContain('CLAIM-1');
    expect(bare.prompt).not.toContain('CLAIM-1');
  });

  it('leaves the four routes the reach does not name whole', async () => {
    // The same halves as §13.84's reading, one default higher up: `flat` under a bare call is byte-identical to
    // `flat` under the opt-out, so the default did not spread to the routes the registration excludes.
    expect((await harness({ roleOf }).flat()).prompt).toBe((await unfiltered().flat()).prompt);
  });

  it('does not filter for a caller who brought no classifier, and the census says which reason', async () => {
    // The conditional part of the default, which is the one difference from the width: a role is a property of
    // the caller's corpus format, so the product cannot supply a reader. Absence is recorded rather than
    // imitated — `null` is "this run could not read a role", not "every turn was a user turn".
    const blind = await harness({}).multiSession();
    expect(blind.prompt).toContain('CLAIM-1');
    expect(blind.census).toBeNull();
  });

  it('withholds the filter from `minimal`, whose number was taken on the unfiltered transcript', async () => {
    // `minimal`'s 39.55% was measured in arrival order over every turn. Handing it the filter would move bytes
    // under a reading nobody re-took — the same branch, and the same reason, as the room table and the width.
    const minimal = await harness({ roleOf, profile: 'minimal' }).multiSession();
    expect(minimal.prompt).toContain('CLAIM-1');
    // The classifier still reaches the instance, because the census is not the filter: `minimal` can be watched
    // even though it cannot be filtered.
    expect(minimal.census?.counts).toEqual({ user: 3, assistant: 3 });
  });
});

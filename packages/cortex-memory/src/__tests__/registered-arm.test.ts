/**
 * The arm a bare `assembleMemory` builds is the arm `tools/arm-config-baseline.json` records.
 *
 * ## The gap this closes, and why it was invisible
 *
 * `assemble-rooms.test.ts` pinned the room table, and only the room table. Every other field of the
 * registered arm had no product-side counterpart: `AssembleOptions` did not even take
 * `promptContract` or `ask`, so calling the published composition root the documented way produced
 * `abstention` + each route's reference block. Neither of those is a cell `S15`/`S16` priced, and
 * neither of the campaign's two adopted levers (§12.5's contract, §13.291's ask) could be reached
 * without dropping to `CortexMemory` and re-deriving the whole arm by hand.
 *
 * The reason nothing failed is the reason this repository keeps recording: a number was published for
 * one arm and an entry point defaulted to another, and no file held both claims at once. This test
 * holds them at once, in both directions, and it is written against **prompts** rather than fields for
 * `assemble-rooms.test.ts`'s reason: what a deployment receives is the assembled prompt, and prompt
 * bytes are the only artefact that cannot be true of a field that never reached the reader.
 *
 * ## The three properties
 *
 * 1. **Total partition.** Every field of `memoryArmConfig` is either in `REGISTERED_ARM` or in
 *    `REGISTERED_ARM_ELSEWHERE` with a class. A field in neither is a field nobody decided about, and
 *    the assertion is what makes adding one a red build rather than a silently uncompared row.
 * 2. **Equality, in both directions.** The values agree, with the two spellings the projection map
 *    names. `Object.keys` equality too, so a field cannot be dropped from the product copy.
 * 3. **Reachability.** A bare call's prompt contains the `verbatim-acts` act rule and the unsourced
 *    rendering, and differs from the reference arm's prompt — so the assertion is about which arm
 *    reached the reader, not about which constant was read.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import type { EvidenceAsk, PromptContract } from '../prompt.js';
import { REGISTERED_ARM } from '../registered-arm.js';
import { REGISTERED_ROOMS } from '../rooms.js';
import type { RoleCensus, TurnCapRoute } from '../types.js';

const NOW = 1_759_470_000_000;

interface Baseline {
  readonly memoryArmConfig: Record<string, unknown>;
}

function baseline(): Baseline {
  return JSON.parse(
    readFileSync(new URL('../../../../tools/arm-config-baseline.json', import.meta.url), 'utf8'),
  ) as Baseline;
}

/**
 * The fields the product does **not** decide, each with the class that says why.
 *
 * This table lives beside the gate rather than in `registered-arm.ts`, and the reason is the export
 * census: a constant nothing in the product calls is API surface nobody asked for, and `census:check`
 * refuses it. The rule it enforces is right here — the partition is a claim about an *artifact*, and the
 * only thing that reads an artifact is this file.
 *
 * A field absent from both this table and `REGISTERED_ARM` is a field nobody decided about, and
 * `registered-arm.test.ts` fails on it. Without the reverse direction a new option would land in the
 * artifact, be unclassified on both sides, and the projection would keep passing over a row nobody
 * had considered — which is how `ask` stayed two values for nine rounds.
 */

const REGISTERED_ARM_ELSEWHERE: Readonly<
  Record<
    string,
    { readonly class: 'derived' | 'census' | 'identity' | 'constant'; readonly why: string }
  >
> = {
  askRoutes: {
    class: 'derived',
    why: 'the reach table of `ask`; comparing it would report a second violation for one defect',
  },
  assemblyRoutes: {
    class: 'derived',
    why: 'follows `promptContract`: only `abstention` assembles session blocks',
  },
  effectivePromptChars: {
    class: 'derived',
    why: '`maxPromptCharsByRoute` after the parse, so it is the same number twice',
  },
  renderingRoutes: {
    class: 'derived',
    why: 'follows `promptContract`, one entry per route the asking block reaches',
  },
  relevanceSignal: {
    class: 'derived',
    why:
      'names **who** ranks: `assembleMemory` decides it by whether it built an index, so `self-index` ' +
      'is a property of the profile rather than an option a caller sets',
  },
  admission: {
    class: 'census',
    why: 'counted while the run admitted turns; two runs of one configuration differ there by design',
  },
  selfIndex: {
    class: 'census',
    why: 'the index cost census: `embedCalls` and `memoHits` are measurements, not settings',
  },
  embedding: {
    class: 'identity',
    why: 'resolved from the endpoint the run reached, which the artifact cannot see and the product does not choose',
  },
  indexEmbedding: {
    class: 'identity',
    why: 'whether the index embedded or was handed vectors — a run-time wiring fact',
  },
  judge: {
    class: 'identity',
    why: 'the reader the dispatch injected; the product is given an `LLM` and does not pick it',
  },
  reader: {
    class: 'identity',
    why: 'endpoint, deadline and thinking mode of the injected reader',
  },
  evidenceSource: {
    class: 'constant',
    why: 'fixed by the bench: evidence comes from the corpus the run was given',
  },
  promptAssembly: {
    class: 'constant',
    why: 'fixed by the prompt builder: instruction-first on every contract',
  },
  sessionBudget: {
    class: 'constant',
    why:
      'unbounded, and the two sides spell it differently — the artifact writes `null` and the product ' +
      'writes `Number.POSITIVE_INFINITY`; `assembleMemory` sets it unconditionally, so there is no ' +
      'second copy to disagree with',
  },
};

/**
 * The fields whose artifact spelling is not the product's, and the projection that reconciles them.
 *
 * Two shapes differ and only two: `rerank` is an object in the artifact (`{ provider }`) and a name in
 * the product, and `maxPromptCharsByRoute` is the room table. Everything else is compared as written,
 * which is what makes a difference between the two files a difference in a value rather than in a
 * serializer.
 */
const PROJECTED_ARM_FIELDS: Readonly<Record<string, (raw: unknown) => unknown>> = {
  rerank: (raw) => (raw as { provider?: unknown } | null)?.provider ?? raw,
};

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
 * Two sessions carrying one countable act, so the `verbatim-acts` rule has something to act on.
 *
 * `bought` is the verb `ACT_RULE_LINES` names first, and the question asks for the purchase with a
 * different one — which is the shape the ask exists for: the reference's substitution ban refuses the
 * match, and `verbatim-acts` admits it. Two sessions rather than one because the act rule is reached
 * through the **multi-session** builder: it rewrites a line of that route's aggregation contract, and
 * the flat route delegates instead of reading it. A one-session corpus would assert nothing.
 */
const TURNS: readonly { sessionId: string; ordinal: number; text: string }[] = [
  { sessionId: 's1', ordinal: 0, text: 'I bought a bicycle from the shop on the corner in April.' },
  {
    sessionId: 's2',
    ordinal: 0,
    text: 'We walked along the canal and talked about the roof repair and the invoice from the builder.',
  },
  { sessionId: 's2', ordinal: 1, text: 'The plumber came on the ninth and replaced the valve.' },
];
const QUESTION = 'When did I purchase the bicycle?';

/** The prompt a bare assembly builds: no room, no contract, no ask — the documented call. */
async function barePrompt(): Promise<string> {
  return promptWith({});
}

/**
 * The prompt an assembly naming part of the arm builds.
 *
 * `askStored` rather than `answer`: the act rule is reached through the multi-session builder, and the
 * assertion is about which arm reached the reader.
 */
async function promptWith(arm: {
  promptContract?: PromptContract;
  ask?: EvidenceAsk;
  profile?: 'minimal' | 'reader' | 'full';
}): Promise<string> {
  const seen: string[] = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: NOW,
    storage: new SqliteStorage(),
    ...(arm.profile === undefined ? {} : { profile: arm.profile }),
    ...(arm.promptContract === undefined ? {} : { promptContract: arm.promptContract }),
    ...(arm.ask === undefined ? {} : { ask: arm.ask }),
  });
  await install.memory.remember([...TURNS]);
  seen.length = 0;
  await install.memory.askStored(QUESTION);
  return seen[0] ?? '';
}

describe('the arm the registration measured is the arm the product ships', () => {
  it('classifies every field of `memoryArmConfig`, in both directions', () => {
    const artifact = baseline().memoryArmConfig;
    const decided = new Set<string>([
      ...Object.keys(REGISTERED_ARM),
      ...Object.keys(REGISTERED_ARM_ELSEWHERE),
    ]);

    // A field in the artifact and in neither table: nobody decided. This is the assertion that would
    // have caught `ask` — it was projected into the arm the bench dispatches and never into the arm the
    // product assembles, and the tables that could have said so did not exist. The second table is gone
    // now: the last four fields it held (`maxTurnChars`, `maxTurnCharsRoutes`, `evidenceRoles`,
    // `evidenceRolesRoutes`) are decided by the product, so a row that needs it again would be a row
    // added to a table this file no longer has — which is the point rather than an inconvenience.
    expect([...Object.keys(artifact)].filter((key) => !decided.has(key))).toEqual([]);
    // And the reverse: a field this file decided about that the artifact does not carry is a stale
    // classification, which is how a removed option keeps a reason nobody re-read.
    expect([...decided].filter((key) => !(key in artifact))).toEqual([]);
    // The two tables must not overlap, or one field has two answers and the equality below reads
    // whichever table the iteration happened to reach first.
    expect(Object.keys(REGISTERED_ARM).filter((key) => key in REGISTERED_ARM_ELSEWHERE)).toEqual(
      [],
    );
  });

  it('agrees with `tools/arm-config-baseline.json` on every field it decides', () => {
    const artifact = baseline().memoryArmConfig;
    const disagreements: { key: string; product: unknown; artifact: unknown }[] = [];
    for (const [key, product] of Object.entries(REGISTERED_ARM)) {
      const projection = PROJECTED_ARM_FIELDS[key];
      const raw = projection === undefined ? artifact[key] : projection(artifact[key]);
      // `JSON.stringify` rather than `toBe`: half the fields are arrays and one is a table, so reference
      // equality would fail on two equal tables and say nothing about the values.
      if (JSON.stringify(raw) !== JSON.stringify(product)) {
        disagreements.push({ key, product, artifact: raw });
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('applies the registered width and reach on a bare call', async () => {
    // The tripwire, in the direction it now points. It used to assert that a bare call printed this
    // 900-character turn **whole**, which was the gap the unshipped table recorded; it failed when the
    // default landed, and the fix it prescribed was to move the row up rather than to relax the assertion.
    // What it asserts now is the other half of the same claim: the arm the benchmark dispatches and the arm
    // this function assembles cut in the same place, at the width the artifact records.
    const LONG = `${'The plumber came on the ninth and replaced the valve. '.repeat(20)}END-OF-LONG-TURN`;
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
    });
    await install.memory.remember([
      { sessionId: 's1', ordinal: 0, text: LONG },
      { sessionId: 's2', ordinal: 0, text: 'I bought a bicycle in April.' },
    ]);
    seen.length = 0;
    await install.memory.askStored(QUESTION);
    const prompt = seen[0] ?? '';
    expect(LONG.length).toBeGreaterThan(REGISTERED_ARM.maxTurnChars);
    expect(prompt).not.toContain('END-OF-LONG-TURN');
    expect(prompt).toContain(LONG.slice(0, REGISTERED_ARM.maxTurnChars));
  });

  it('lets a caller step away from the default with the empty reach', async () => {
    // A default that cannot be stepped away from is not a default. `[]` is the documented spelling of "no
    // cap", and the assertion is that the turn prints whole again rather than that a field changed.
    const LONG = `${'The plumber came on the ninth and replaced the valve. '.repeat(20)}END-OF-LONG-TURN`;
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      maxTurnCharsRoutes: [],
    });
    await install.memory.remember([
      { sessionId: 's1', ordinal: 0, text: LONG },
      { sessionId: 's2', ordinal: 0, text: 'I bought a bicycle in April.' },
    ]);
    seen.length = 0;
    await install.memory.askStored(QUESTION);
    expect(seen[0] ?? '').toContain('END-OF-LONG-TURN');
  });

  it('carries the room table `rooms.ts` already pinned, unchanged', () => {
    // The one field that had a pin before this file. Asserted here so the wider table cannot drift away
    // from the narrow one: two copies of one number that disagree is the defect this file is named for.
    expect(REGISTERED_ARM.maxPromptCharsByRoute).toEqual(REGISTERED_ROOMS);
  });

  it('builds the registered arm on a bare call, not the reference arm', async () => {
    const bare = await barePrompt();
    const registered = await promptWith({
      promptContract: REGISTERED_ARM.promptContract,
      ask: REGISTERED_ARM.ask,
    });
    const reference = await promptWith({ promptContract: 'abstention', ask: 'route' });

    expect(bare).toBe(registered);
    expect(bare).not.toBe(reference);
  });

  it('reaches the reader with the `verbatim-acts` rule §13.291 adopted', async () => {
    // The rule's first line, as `ACT_RULE_LINES` spells it. A prompt assertion rather than a field read
    // because the option existed for nine rounds while a bare assembly never passed it: the question is
    // whether the block reached the reader, and only the prompt answers that.
    const bare = await barePrompt();
    expect(bare).toContain(
      'A mention counts when the evidence describes the same ACT under a different',
    );
    // And the line it replaces is gone, which is the whole claim `verbatim-acts` makes: the ban on
    // substituting a verb is what refused the `bought`/`purchased` match this corpus carries.
    expect(bare).not.toContain('Do NOT substitute or infer a different verb');
  });

  it('lets a caller name the reference arm and get the reference arm', async () => {
    // The default moved, and a default that cannot be stepped away from is not a default. `abstention`
    // is the pre-§12.5 contract and `route` is the ask that means "each route's own block" — the pair is
    // the arm this repository published its 91.20%-era numbers under, and both halves stay reachable.
    const reference = await promptWith({ promptContract: 'abstention', ask: 'route' });
    expect(reference).not.toBe(await barePrompt());
    expect(reference).not.toContain('A mention counts when the evidence describes the same ACT');
    // The abstention contract's own token, so the assertion says which block the caller got rather than
    // only that it is different.
    expect(reference).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('keeps `minimal` on the rendering its published number was taken at', async () => {
    // `minimal` renders the transcript in arrival order and its 39.55% was measured at the pre-§12.5
    // rendering. Handing it the registered contract would move bytes under a reading nobody re-took —
    // the same reason `assemble.ts` withholds the room table from it.
    const minimal = await promptWith({ profile: 'minimal' });
    expect(minimal).not.toContain('A mention counts when the evidence describes the same ACT');
    expect(minimal).not.toBe(await barePrompt());
  });

  /**
   * Two turns a role filter can tell apart, both long enough that the room never binds them.
   *
   * `USER-FACT` and `ASSISTANT-CLAIM` sit **inside** the turns rather than beside them because the assertion is
   * on prompt bytes: a prompt carrying `ASSISTANT-CLAIM` was not filtered, whatever a field said.
   */
  const ROLE_TURNS = [
    {
      sessionId: 's1',
      ordinal: 0,
      text: '[2023/02/15 (Wed) 03:14] user: USER-FACT the boiler was replaced in March.',
    },
    {
      sessionId: 's1',
      ordinal: 1,
      text: '[2023/02/15 (Wed) 03:15] assistant: ASSISTANT-CLAIM I would check the guarantee first.',
    },
    {
      sessionId: 's2',
      ordinal: 0,
      text: '[2023/02/25 (Sat) 09:00] user: USER-FACT I have two cats.',
    },
  ] as const;

  /**
   * The classifier the campaign's haystack needs, written here so the product can be asserted without one.
   *
   * `cortex-eval` owns the real one (`roleOfTurn`), and it is not importable from this package for the reason
   * the dependency runs the other way. This is the same shape on a smaller format: the point of the test is
   * that the **product** takes a reader rather than knowing one.
   */
  function roleOf(text: string): string | undefined {
    return /^\[[^\]]+\]\s*(user|assistant)\s*:/i.exec(text)?.[1]?.toLowerCase();
  }

  /** One assembly, the prompt `MR` renders, and the census that describes the same window. */
  async function rolePrompt(arm: {
    roleOf?: (turn: string) => string | undefined;
    evidenceRoles?: readonly string[];
    evidenceRolesRoutes?: readonly TurnCapRoute[];
  }): Promise<{ prompt: string; census: RoleCensus | null }> {
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      ...(arm.roleOf === undefined ? {} : { roleOf: arm.roleOf }),
      ...(arm.evidenceRoles === undefined ? {} : { evidenceRoles: arm.evidenceRoles }),
      ...(arm.evidenceRolesRoutes === undefined
        ? {}
        : { evidenceRolesRoutes: arm.evidenceRolesRoutes }),
    });
    await install.memory.remember([...ROLE_TURNS]);
    seen.length = 0;
    await install.memory.askStored(QUESTION);
    return { prompt: seen[0] ?? '', census: install.memory.lastRoleCensus() };
  }

  it('applies the registered role filter on a call that supplies a classifier', async () => {
    // The tripwire for the last two rows the unshipped table held. A caller who can read a role now gets the
    // arm §13.84 adopted -- user turns only, on `multi-session` and `temporal` -- instead of the reference
    // window that printed every assistant turn four screening runs paid to exclude.
    const bare = await rolePrompt({ roleOf });
    expect(bare.prompt).toContain('USER-FACT');
    expect(bare.prompt).not.toContain('ASSISTANT-CLAIM');
    // And the census is the effect rather than the configuration: the window carried user turns and no
    // assistant turn, which is what `43465626013` could not read from its own artifact.
    expect(bare.census).not.toBeNull();
    expect(bare.census?.counts).toEqual({ user: 2 });
    expect(bare.census?.unclassified).toBe(0);
    expect(bare.census?.total).toBe(2);
  });

  it('filters nothing when the call brings no classifier, and says so in the census', async () => {
    // The other half of the conditional default, and the reason it is conditional: without a reader the product
    // cannot see a role, so the honest result is every turn plus a `null` census rather than a filter that
    // silently kept everything while reporting that it kept `user` -- the inert-configuration class §10.10
    // recorded for the retrieval gate.
    const withoutReader = await rolePrompt({});
    expect(withoutReader.prompt).toContain('ASSISTANT-CLAIM');
    expect(withoutReader.census).toBeNull();
  });

  it('lets a caller keep the classifier and drop the filter with the empty reach', async () => {
    // A default that cannot be stepped away from is not a default, and the step is the same spelling the width
    // uses: a filter that reaches nowhere. The prompt then equals the unfiltered one byte for byte, and the
    // census still runs -- which is the configuration an audit wants and could not get before either.
    const watched = await rolePrompt({ roleOf, evidenceRolesRoutes: [] });
    const withoutReader = await rolePrompt({});
    expect(watched.prompt).toBe(withoutReader.prompt);
    expect(watched.census?.counts).toEqual({ user: 2, assistant: 1 });
    expect(watched.census?.total).toBe(3);
  });

  it('refuses the filter through this entry point when no classifier came with it', async () => {
    // The constructor's guard, forwarded rather than re-implemented: a composition root that swallowed it would
    // be a way around a rule the class states, and the failure has to name the missing field.
    expect(() =>
      assembleMemory({
        llm: recordingLlm(),
        now: NOW,
        storage: new SqliteStorage(),
        evidenceRoles: REGISTERED_ARM.evidenceRoles,
      }),
    ).toThrow(/roleOf/);
  });
});

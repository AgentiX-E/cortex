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
 * These two tables live beside the gate rather than in `registered-arm.ts`, and the reason is the export
 * census: a constant nothing in the product calls is API surface nobody asked for, and `census:check`
 * refuses it. The rule it enforces is right here — the partition is a claim about an *artifact*, and the
 * only thing that reads an artifact is this file.
 *
 * A field absent from both this table and {@link REGISTERED_ARM} is a field nobody decided about, and
 * `registered-arm.test.ts` fails on it. Without the reverse direction a new option would land in the
 * artifact, be unclassified on both sides, and the projection would keep passing over a row nobody
 * had considered — which is how `ask` stayed two values for nine rounds.
 */

/**
 * The registered values the product cannot yet be given, and what each one is missing.
 *
 * ## Why this table exists rather than four more fields on `AssembleOptions`
 *
 * Because the honest state is not "the product decides this". Four fields of the measured arm reach the
 * reader through the benchmark's arm and through nothing else:
 *
 * | field | registered | what the published entry has |
 * | --- | --- | --- |
 * | `maxTurnChars` | `400` | the option exists and is forwarded, but nothing defaults it |
 * | `maxTurnCharsRoutes` | `multi-session,temporal` | no option at all |
 * | `evidenceRoles` | `['user']` | no option at all |
 * | `evidenceRolesRoutes` | `multi-session,temporal` | no option at all |
 *
 * A call that names none of them assembles a prompt where every turn prints whole and both speakers print,
 * which is not the cell `S16` priced. Writing them into {@link REGISTERED_ARM} would have claimed an
 * application that does not happen — the exact defect this file exists to remove, restated one layer down.
 *
 * ## The assertion that keeps this table honest
 *
 * `registered-arm.test.ts` checks both directions. Every value here still has to equal the artifact, so the
 * table cannot drift; and a bare assembly has to still **not** apply it, so shipping one is a red test that
 * says "move this row up" rather than a silent improvement nobody recorded. A row that can be quietly
 * satisfied is a row that will be.
 *
 * ## Closing them is an adoption, in this order
 *
 * `maxTurnChars` first: the option exists, so defaulting it is one line and a byte test. The other three need
 * an option each, a manual row each (the manual gate fails an undocumented option), and a byte test proving
 * the field reached the prompt. None of the three can be done "while we are here": each moves the bytes of
 * every prompt whose corpus holds a turn over 400 characters or a non-user turn, which is a re-reading of
 * every published number rather than an edit.
 */
const REGISTERED_ARM_UNSHIPPED: Readonly<
  Record<string, { readonly value: unknown; readonly missing: string }>
> = {
  maxTurnChars: {
    value: 400,
    missing:
      '`AssembleOptions.maxTurnChars` exists and is forwarded; nothing defaults it, so a bare call prints ' +
      'every turn whole where the registered arm cuts at 400 on two routes',
  },
  maxTurnCharsRoutes: {
    value: ['multi-session', 'temporal'],
    missing: 'no `AssembleOptions` field: the two routes the cap reaches are named only by the arm',
  },
  evidenceRoles: {
    value: ['user'],
    missing: 'no `AssembleOptions` field: a bare call prints the assistant turns the arm excludes',
  },
  evidenceRolesRoutes: {
    value: ['multi-session', 'temporal'],
    missing: "no `AssembleOptions` field, for `evidenceRoles`'s reason",
  },
};

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
      ...Object.keys(REGISTERED_ARM_UNSHIPPED),
      ...Object.keys(REGISTERED_ARM_ELSEWHERE),
    ]);

    // A field in the artifact and in neither table: nobody decided. This is the assertion that would
    // have caught `ask` — it was projected into the arm the bench dispatches and never into the arm the
    // product assembles, and the two tables that could have said so did not exist.
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

  it('agrees with the artifact on the fields it records but cannot ship, and says what each needs', () => {
    const artifact = baseline().memoryArmConfig;
    for (const [key, entry] of Object.entries(REGISTERED_ARM_UNSHIPPED)) {
      expect({ key, value: entry.value }).toEqual({ key, value: artifact[key] });
      // A row without a reason is a row nobody has to close. The reason is prose, so the assertion is that
      // it exists and names something -- an empty string would satisfy a truthiness check on the record.
      expect(entry.missing.length).toBeGreaterThan(30);
    }
  });

  it('does not apply the unshipped fields on a bare call, so shipping one moves the row', async () => {
    // The tripwire. `maxTurnChars: 400` on two routes is the registered rendering, and a bare call still
    // prints this 900-character turn whole -- which is the gap `REGISTERED_ARM_UNSHIPPED` records. When
    // somebody defaults the cap, this assertion fails and the fix is to move `maxTurnChars` into
    // `REGISTERED_ARM`; a test that only checked the table could never say so.
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
    expect(LONG.length).toBeGreaterThan(REGISTERED_ARM_UNSHIPPED.maxTurnChars!.value as number);
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
});

/**
 * The character room is per route, because a room is not a depth.
 *
 * ## What `41546569106` measured, which is what these tests are about
 *
 * One global room of 48,000 characters becomes five different depths, because each route's turns
 * are a different length: 61 turns on `flat` (723 characters each) against 179 on `temporal` (205).
 * The quantity that decides how much of the answer's evidence arrives is the **count**, so "48,000
 * characters" is not a comparable setting across routes.
 *
 * These tests pin the mechanism that lets a run say 55,900 for one route and 29,000 for another.
 * They cannot pin the effect -- that needs a dispatch -- so what is asserted here is exactly the
 * part that is a property of the code:
 *
 * 1. **Absence is the identity.** No map, an empty map, and a map that names every route at the
 *    global value must produce byte-identical prompts. Every archived artifact was produced under
 *    the first, and a mechanism that cannot reproduce it makes the campaign's readings incomparable.
 * 2. **A named route is the only route that moves.** The other five are byte-comparable, which is
 *    what makes a two-route dispatch a single-variable experiment.
 * 3. **Growth is as expressible as shrinkage.** The registered experiment raises `multi-session`
 *    above the global room; a mechanism that only clamped downward would pass every shrink test and
 *    silently fail the dispatch it was built for.
 * 4. **The room is an upper bound on every route**, at every width, so a map cannot produce a prompt
 *    longer than the number the artifact records.
 * 5. **`0` is a value, not an absence.** `??` rather than `||` -- a zero room produces the degenerate
 *    prompt `fitToBudget` already handles, and substituting the global room for it would make the
 *    artifact describe a prompt that was never assembled.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { TURN_CAP_ROUTES, type CortexMemoryOptions, type TurnCapRoute } from '../types.js';

const NOW = 1_759_470_000_000;

/** Twelve turns of 400 characters, so a small room holds a countable number of them. */
function turns(): string[] {
  return Array.from({ length: 12 }, (_, index) => `t${index}-${'x'.repeat(400)}`);
}

function sessions(): string[][] {
  const all = turns();
  return [all.slice(0, 6), all.slice(6)];
}

function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

/** A gate that admits everything, so the room is the only thing the selection can be short of. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

/**
 * One system per route, each with its own recording reader.
 *
 * Per route rather than one system answering six questions, because a shared reader would let a
 * prompt from one route be attributed to another -- which is the attribution defect these tests
 * exist to detect, arriving through the harness.
 */
function promptsFor(options: Partial<CortexMemoryOptions>): Promise<Record<TurnCapRoute, string>> {
  const build = (): { system: CortexMemory; seen: string[] } => {
    const seen: string[] = [];
    const llm: LLM = {
      complete: async (prompt: string) => {
        seen.push(prompt);
        return 'answer';
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
    return { system: new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options }), seen };
  };

  const asks: Record<TurnCapRoute, (system: CortexMemory) => Promise<unknown>> = {
    flat: (system) => system.answer('how many?', turns()),
    'multi-session': (system) => system.answerSessions('how many?', sessions()),
    temporal: (system) => system.answerTemporal('how many?', turns(), '2024/01/01'),
    abstention: (system) => system.answerAbstention('how many?', turns()),
    assistant: (system) => system.answerAssistant('how many?', turns()),
    'knowledge-update': (system) => system.answerKnowledgeUpdate('how many?', turns()),
  };

  return (async () => {
    const out = {} as Record<TurnCapRoute, string>;
    for (const route of TURN_CAP_ROUTES) {
      const { system, seen } = build();
      await asks[route](system);
      expect(seen.length, `${route} produced no prompt`).toBeGreaterThan(0);
      out[route] = seen.join('\n');
    }
    return out;
  })();
}

describe('a per-route prompt room', () => {
  it('is the identity when the map is absent, empty, or names every route at the global value', async () => {
    const global = await promptsFor({ maxPromptChars: 2_400 });
    const empty = await promptsFor({ maxPromptChars: 2_400, maxPromptCharsByRoute: {} });
    const every = await promptsFor({
      maxPromptChars: 2_400,
      maxPromptCharsByRoute: Object.fromEntries(
        TURN_CAP_ROUTES.map((route) => [route, 2_400]),
      ) as Record<TurnCapRoute, number>,
    });

    expect(empty).toEqual(global);
    expect(every).toEqual(global);
    // The control is not trivially short: if every prompt were empty the equality above would hold
    // for a mechanism that ignored the room entirely.
    expect(global.flat.length).toBeGreaterThan(400);
  });

  it('moves only the route it names', async () => {
    const global = await promptsFor({ maxPromptChars: 2_400 });
    const narrowed = await promptsFor({
      maxPromptChars: 2_400,
      maxPromptCharsByRoute: { flat: 900 },
    });

    expect(narrowed.flat.length).toBeLessThan(global.flat.length);
    expect(narrowed.flat.length).toBeLessThanOrEqual(900);
    for (const route of TURN_CAP_ROUTES) {
      if (route === 'flat') continue;
      expect(narrowed[route], `${route} moved without being named`).toBe(global[route]);
    }
  });

  it('grows a route past the global room, which is the direction the experiment needs', async () => {
    const global = await promptsFor({ maxPromptChars: 2_400 });
    const deepened = await promptsFor({
      maxPromptChars: 2_400,
      maxPromptCharsByRoute: { 'multi-session': 8_000 },
    });

    expect(deepened['multi-session'].length).toBeGreaterThan(global['multi-session'].length);
    // More turns, not merely more characters: the depth is what the coverage curve responds to.
    const count = (prompt: string): number => prompt.match(/t\d+-/gu)?.length ?? 0;
    expect(count(deepened['multi-session'])).toBeGreaterThan(count(global['multi-session']));
    expect(global['multi-session'].length).toBeLessThanOrEqual(2_400);
    expect(deepened['multi-session'].length).toBeLessThanOrEqual(8_000);
    for (const route of TURN_CAP_ROUTES) {
      if (route === 'multi-session') continue;
      expect(deepened[route], `${route} moved without being named`).toBe(global[route]);
    }
  });

  it('bounds every route at the width its own map names', async () => {
    const rooms: Record<TurnCapRoute, number> = {
      flat: 900,
      'multi-session': 5_000,
      temporal: 1_200,
      abstention: 700,
      assistant: 1_500,
      'knowledge-update': 2_000,
    };
    const prompts = await promptsFor({ maxPromptChars: 48_000, maxPromptCharsByRoute: rooms });
    for (const route of TURN_CAP_ROUTES) {
      expect(prompts[route].length, `${route} exceeded its room`).toBeLessThanOrEqual(rooms[route]);
    }
    // And the widths are not all being clamped to one value, which is what a fallback defect looks
    // like from the outside.
    expect(new Set(TURN_CAP_ROUTES.map((route) => prompts[route].length)).size).toBeGreaterThan(3);
  });

  it('treats a zero room as a value rather than as an absence', async () => {
    const global = await promptsFor({ maxPromptChars: 2_400 });
    const zeroed = await promptsFor({ maxPromptChars: 2_400, maxPromptCharsByRoute: { flat: 0 } });

    // `fitToBudget` with no room left produces the empty prompt, and the reader is called with it.
    expect(zeroed.flat).toBe('');
    expect(zeroed.flat).not.toBe(global.flat);
    expect(zeroed.temporal).toBe(global.temporal);
  });

  it('falls back to the global room for a route the map does not name', async () => {
    const global = await promptsFor({ maxPromptChars: 2_400 });
    const one = await promptsFor({
      maxPromptChars: 2_400,
      maxPromptCharsByRoute: { temporal: 800 },
    });

    expect(one.temporal.length).toBeLessThan(global.temporal.length);
    expect(one['knowledge-update']).toBe(global['knowledge-update']);
    expect(one.assistant).toBe(global.assistant);
  });

  it('uses the product default when neither the map nor the global room is given', async () => {
    // `cortex-memory`'s own default is a 24,000-character room; the point of the assertion is that an
    // absent map does not become a zero room, which would leave every prompt empty.
    const prompts = await promptsFor({});
    for (const route of TURN_CAP_ROUTES) {
      expect(prompts[route].length, `${route} was assembled under no room`).toBeGreaterThan(1_000);
    }
  });
});

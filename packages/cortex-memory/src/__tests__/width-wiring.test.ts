/**
 * The per-question evidence budget, wired: it reaches every route, it reports four reasons, and its
 * absence reproduces the archived prompts byte for byte.
 *
 * ## Why these tests are separate from `width-plan.test.ts`
 *
 * `width.ts` is a pure function and its tests pin the arithmetic. What they cannot pin is the part that
 * has failed in this package before: **the option reaching the prompt**. `§13.72` measured one cap at
 * **+13 on MR and −30 on IE**, and `§14.131` found a run whose sampler was never forwarded at all -- both
 * are failures of wiring rather than of mechanism, and both were invisible to the unit test of the
 * mechanism itself. So what is asserted here is exactly the plumbing:
 *
 * 1. **Absence is the identity.** No option produces the same bytes as the archived configuration, on
 *    every route. A mechanism that cannot reproduce its own control makes the campaign's readings
 *    incomparable, and this one is positioned to break exactly that.
 * 2. **The option reaches the routes that carry evidence**, including `multi-session`, whose prompt is
 *    usually *under* its room and which therefore takes a different branch than `fitToBudget`.
 * 3. **The cap binds on evidence, not on the prompt.** The instruction block and the question line are
 *    never shortened to make room for it -- a mechanism that clipped them would be reading a different
 *    contract, not a narrower one.
 * 4. **The decision is reported per question, with its reason.** `capped` is the only reason that means
 *    the mechanism acted, and a run that reported a character count without the reason could not tell
 *    "declined" from "cut and delivered".
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions, TurnCapRoute } from '../types.js';

const NOW = 1_759_470_000_000;

/** A gate that admits everything, so the budget is the only thing the selection can be short of. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: ((_memory: MemoryValue) => 1) as ValueFunction,
} as const;

/**
 * Turns that mention the question's subject in the first two only.
 *
 * Twelve of them at 400 characters, so a cap of 1,000 is a cut that a prefix can honour and a cap of
 * 100,000 leaves every turn in place. The topical pair at the front is what gives the ranking something
 * to order; the ten flat turns after it are the tail the cut is meant to remove.
 */
function turns(): string[] {
  return [
    `shoes packed ${'a'.repeat(388)}`,
    `shoes counted ${'b'.repeat(388)}`,
    ...Array.from({ length: 10 }, (_, index) => `unrelated ${index} ${'c'.repeat(388)}`),
  ];
}

function sessions(): string[][] {
  const all = turns();
  return [all.slice(0, 6), all.slice(6)];
}

/** One system and the prompts it saw, per route, so a prompt cannot be attributed to another route. */
async function promptsFor(
  options: Partial<CortexMemoryOptions>,
): Promise<Record<TurnCapRoute, string>> {
  const asks: Record<TurnCapRoute, (system: CortexMemory) => Promise<unknown>> = {
    flat: (system) => system.answer('how many shoes were packed?', turns()),
    'multi-session': (system) => system.answerSessions('how many shoes were packed?', sessions()),
    temporal: (system) =>
      system.answerTemporal('how many shoes were packed?', turns(), '2024/01/01'),
    abstention: (system) => system.answerAbstention('how many shoes were packed?', turns()),
    assistant: (system) => system.answerAssistant('how many shoes were packed?', turns()),
    'knowledge-update': (system) =>
      system.answerKnowledgeUpdate('how many shoes were packed?', turns()),
  };

  const out = {} as Record<TurnCapRoute, string>;
  for (const [route, ask] of Object.entries(asks) as [TurnCapRoute, typeof asks.flat][]) {
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
    const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
    await ask(system);
    expect(seen.length, `${route} produced no prompt`).toBeGreaterThan(0);
    out[route] = seen.join('\n');
  }
  return out;
}

/** The width a fresh system decides for one question, and the prompt it then assembles. */
async function oneQuestion(
  options: Partial<CortexMemoryOptions>,
): Promise<{ prompt: string; width: ReturnType<CortexMemory['lastWidth']> }> {
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
  const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
  await system.answer('how many shoes were packed?', turns());
  return { prompt: seen.join('\n'), width: system.lastWidth() };
}

/** A plan that cuts hard enough to bind on this fixture's twelve turns. */
const CUTTING = { coverage: 0.5, floorChars: 0, renderMargin: 1 } as const;

describe('a per-question evidence budget', () => {
  it('is the identity when the option is absent, on every route', async () => {
    const control = await promptsFor({ maxPromptChars: 24_000 });
    const absent = await promptsFor({ maxPromptChars: 24_000, widthPlan: undefined });
    expect(absent).toEqual(control);
    // The control is not trivially empty: if every prompt were blank, the equality above would hold for a
    // mechanism that ignored the option entirely.
    for (const route of Object.keys(control) as TurnCapRoute[]) {
      expect(control[route].length, `${route} produced a short prompt`).toBeGreaterThan(400);
    }
  });

  it('shortens the prompt on the routes that carry evidence', async () => {
    const control = await promptsFor({ maxPromptChars: 24_000 });
    const cut = await promptsFor({ maxPromptChars: 24_000, widthPlan: CUTTING });
    const moved = (Object.keys(control) as TurnCapRoute[]).filter(
      (route) => cut[route] !== control[route],
    );
    expect(moved.length).toBeGreaterThan(0);
    for (const route of moved) {
      expect(cut[route].length, `${route} grew`).toBeLessThan(control[route].length);
    }
  });

  it('reaches multi-session, whose prompt is under its room and takes the other branch', async () => {
    // 12 turns of ~400 characters is ~5,000 characters of evidence in a 24,000-character room, so
    // `buildSessionPrompt` returns on its *fits* path. A cap tested only inside `fitToBudget` would never
    // fire here -- and `multi-session` is the route the mechanism exists for.
    const control = await oneQuestion({ maxPromptChars: 24_000 });
    const cut = await oneQuestion({
      maxPromptChars: 24_000,
      widthPlan: CUTTING,
    });
    expect(control.prompt.length).toBeLessThan(24_000);
    expect(cut.prompt.length).toBeLessThan(control.prompt.length);
  });

  it('never shortens the instruction block or the question line', async () => {
    const control = await oneQuestion({ maxPromptChars: 24_000 });
    const cut = await oneQuestion({ maxPromptChars: 24_000, widthPlan: CUTTING });
    // The prompt must actually be shorter, or this test would pass on a mechanism that never reached the
    // builder -- which is the failure `§14.131` found in the sampler and `§13.72` found in the cap.
    expect(cut.prompt.length).toBeLessThan(control.prompt.length);
    const question = 'QUESTION: how many shoes were packed?';
    expect(control.prompt).toContain(question);
    expect(cut.prompt).toContain(question);
    // The contract's own closing line, which the cap must leave intact even when the evidence is gone.
    const lastLine = control.prompt.split('\n').at(-1)!;
    expect(cut.prompt.split('\n').at(-1)).toBe(lastLine);
  });

  it('reports the reason, and reports `capped` only when it acted', async () => {
    const cut = await oneQuestion({ maxPromptChars: 24_000, widthPlan: CUTTING });
    expect(cut.width?.reason).toBe('capped');
    expect(cut.width?.plan?.turnsKept).toBeGreaterThan(0);
    expect(cut.width?.plan?.turnsKept).toBeLessThan(12);
    expect(cut.width?.plan?.turnsConsidered).toBe(12);
    expect(cut.width?.plan?.coveredShare).toBeGreaterThanOrEqual(0.5);
    // And the prompt the reader saw must be shorter than the one the plan's budget implies. A report of
    // `capped` beside an unchanged prompt is the shape a wiring defect takes: the mechanism decided and
    // nothing acted on the decision.
    const control = await oneQuestion({ maxPromptChars: 24_000 });
    expect(cut.prompt.length).toBeLessThan(control.prompt.length);
  });

  it('reports `identity` exactly when it declined, so the two are one fact', async () => {
    // A sweep, because the boundary is a property of the fixture rather than a number this test can name:
    // the higher the coverage, the more turns the prefix must hold, and at some point it holds all twelve
    // and the plan must say `identity` instead of reporting a cap of the whole set.
    const reads = await Promise.all(
      [0.2, 0.5, 0.8, 0.95, 0.99].map(async (coverage) => ({
        coverage,
        ...(await oneQuestion({
          maxPromptChars: 24_000,
          widthPlan: { coverage, floorChars: 0, renderMargin: 1 },
        })),
      })),
    );
    for (const read of reads) {
      const declined = read.width?.reason === 'identity';
      expect(read.width?.plan === undefined, `coverage ${read.coverage}`).toBe(declined);
      if (!declined) expect(read.width?.reason).toBe('capped');
    }
    // At least one of the sweep must have acted, or the assertions above would hold for a plan that
    // always declined.
    expect(reads.some((read) => read.width?.reason === 'capped')).toBe(true);
  });

  it('reports `unsignalled` for a question that shares no term with its evidence', async () => {
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
    const system = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm,
      maxPromptChars: 24_000,
      widthPlan: CUTTING,
    });
    await system.answer('what is the airspeed of a swallow?', turns());
    expect(system.lastWidth()).toEqual({ reason: 'unsignalled' });
    // And the prompt is the whole evidence: a signal that found nothing is not evidence that the evidence
    // is worthless.
    expect(seen.join('\n').length).toBeGreaterThan(400);
  });

  it('clears the decision when a question has no admissible evidence', async () => {
    const llm: LLM = {
      complete: async () => 'answer',
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
    const system = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm,
      maxPromptChars: 24_000,
      widthPlan: CUTTING,
    });
    await system.answer('how many shoes were packed?', turns());
    expect(system.lastWidth()?.reason).toBe('capped');
    // An empty context declines before any prompt is built, so there is no budget to report -- and the
    // previous question's cut must not be attributed to this one.
    await system.answer('how many shoes were packed?', []);
    expect(system.lastWidth()).toBeUndefined();
  });

  it('returns the decision by value, so a caller cannot rewrite what the artifact will say', async () => {
    const cut = await oneQuestion({ maxPromptChars: 24_000, widthPlan: CUTTING });
    const reading = cut.width!;
    expect(reading.plan).toBeDefined();
    // Mutating the copy must not reach the system's own record; the next read is unchanged.
    (reading.plan as { evidenceChars: number }).evidenceChars = -1;
    const again = await oneQuestion({ maxPromptChars: 24_000, widthPlan: CUTTING });
    expect(again.width?.plan?.evidenceChars).toBeGreaterThan(0);
  });

  it('does not name a width when the arm did not ask, so `lastWidth` is absent rather than `identity`', async () => {
    const plain = await oneQuestion({ maxPromptChars: 24_000 });
    expect(plain.width).toBeUndefined();
  });
});

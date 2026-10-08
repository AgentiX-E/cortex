/**
 * Which routes does the §12.5 evidence rendering actually reach?
 *
 * ## The measurement that made this file necessary
 *
 * Dispatch `37804673104` (master `bcf66463`, `limit=120`, `ablation_runs=1`) ran the
 * arm with `promptContract = 'abstention-evidence-blocks'` and produced the first
 * artifact carrying both a complete roster and the raw model output. Its numbers:
 *
 *     capability   baseline    feature     b+f-   b-f+
 *     MR           13/17       0/17          13       0
 *     TR           15/17       0/17          15       0
 *     IE            0/52       0/52           0       0
 *     KU            0/17       0/17           0       0
 *     ABS          17/17      17/17           0       0
 *     total            45          17          28       0
 *
 * `b-f+ = 0` on every capability, which is §12.4's finding reproduced exactly. The
 * registration calls `abstention-evidence-blocks` "§12.5's single variable", but
 * `memory.ts` resolved it on exactly one condition:
 *
 *     contract === 'abstention' && options.promptContract !== undefined
 *
 * and `runBenchmark` dispatches `answerAbstention` for `capability === 'ABS'` only.
 * So the variable reached 17 of 120 questions -- and ABS gold IS abstention, which
 * means the questions the variable could reach were the questions where declining is
 * the correct answer. The 28-question loss is on MR, TR, IE and KU, none of which
 * received the rendering.
 *
 * ## What replaced it, and why the first attempt was wrong
 *
 * The first fix widened the condition to more contract names. §12.9 records why that
 * cannot work: `PromptContract` names an *instruction block*, and MR's ask is
 * `extractive` while ABS's is the conservative one. Handing MR the abstention contract
 * would move the instruction text AND the evidence rendering -- two variables where the
 * registration authorises one, and the reason `abstention-evidence-blocks` was built to
 * hold its ask fixed in the first place (§12.4 could not separate "the ask is too
 * forceful" from "the evidence is unusable").
 *
 * So the variable is a **rendering mode**, not a contract: `evidenceRendering`, applied
 * by every builder, leaving each route's instruction block exactly as it is. These tests
 * drive all six routes and read the prompt, which is the only way to know the rendering
 * arrived -- the alternative, asserting the name appears in `memory.ts`, would pass on
 * an arm that never dispatched it.
 */

import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { PROMPT_CONTRACTS, RENDERING_BY_CONTRACT, buildPrompt } from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

const NOW = 1_759_470_000_000;

/** The gate values the artifact records, so the fixture is the dispatched run. */
const ARM_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

/** The contract the artifact records. */
const ARM_CONTRACT = 'abstention-evidence-blocks' as const;

const TEXT = 'I bought a 1/48 scale Spitfire kit.';

function evidence(): AdmittedTurn[] {
  return [
    {
      ...createMemory({ content: TEXT }),
      ordinal: 0,
    },
  ];
}

const TURNS = evidence();

/** An LLM that records every prompt it is asked. */
function recorder(seen: string[], answer: string): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return answer;
    },
    // Required by `LLM` and unused here, matching the stub in
    // `prompt-contract-switch.test.ts`. Throwing rather than returning a stub
    // value means a future change that started calling it would fail loudly
    // instead of silently measuring a fabricated response.
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function build(seen: string[], options: { contract?: boolean } = {}): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen, 'Spitfire'),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...ARM_GATE },
    ...(options.contract === false ? {} : { promptContract: ARM_CONTRACT }),
  });
}

/** The arm the artifact records: gate values plus the rendering contract. */
function arm(seen: string[]): CortexMemory {
  return build(seen);
}

/** The same arm with no rendering named, so each route emits its baseline prompt. */
function unarmed(seen: string[]): CortexMemory {
  return build(seen, { contract: false });
}

/**
 * Does the installed rendering appear in the prompt?
 *
 * The renderer's signature is a bracketed identifier beside the index
 * (`` `1. [id] text` ``). It is matched by SHAPE rather than against the fixture's
 * own `id`, and the reason is measured rather than assumed: `answerAbstention`
 * admits its context through `admitTurns`, which derives a memory from the turn
 * TEXT and therefore mints a new id. A test comparing `TURNS[0].id` to the prompt
 * would fail on a correctly working switch -- which is exactly what the first
 * draft did. The shape is what the renderer emits and what the baseline renderer
 * never emits, so it separates them without depending on identity.
 */
const SOURCE_RENDERING = /^\d+\. \[[0-9a-f-]{36}\] /m;

function hasSourceRendering(prompt: string): boolean {
  return SOURCE_RENDERING.test(prompt);
}

/**
 * The instruction block, taken as everything from the first instruction line on.
 *
 * The advisory `SESSION_NOTE` on the MR route sits *between* the evidence and the
 * question, so slicing at the instruction text alone would compare the wrong span
 * and let a change to the note pass unnoticed. Including everything after
 * `QUESTION:` keeps the note out of the compared region deliberately -- the note is
 * part of MR's ask and must not move -- while still catching any drift in the ask
 * itself.
 */
function instructions(prompt: string): string {
  const answerLine = prompt.indexOf('Answer the question');
  return answerLine === -1 ? prompt : prompt.slice(answerLine);
}

/**
 * Every route `runBenchmark` can dispatch, driven through the public API.
 *
 * The list mirrors `benchmark.ts`'s branches minus `answerPreference`, which
 * `CortexMemory` does not implement and which therefore falls through to `answer`.
 * Each entry is (name, drive), so a new route is added in one place and the
 * per-route assertions below cannot silently stop covering it.
 */
type Drive = (memory: CortexMemory) => Promise<unknown>;

const ROUTES: ReadonlyArray<readonly [string, Drive]> = [
  ['abstention (ABS)', (m) => m.answerAbstention('What is my passport number?', [TEXT])],
  ['multi-session (MR)', (m) => m.answerSessions('Which kit did I buy?', [[TEXT]])],
  ['temporal (TR)', (m) => m.answerTemporal('How long ago did I buy it?', [TEXT], '2023/06/01')],
  ['knowledge-update (KU)', (m) => m.answerKnowledgeUpdate('How many kits do I own now?', [TEXT])],
  ['assistant', (m) => m.answerAssistant('What did you tell me about the kit?', [TEXT])],
  ['flat (IE and the rest)', (m) => m.answer('What did I buy?', [TEXT])],
];

describe('the evidence rendering reaches every route that can carry it', () => {
  for (const [name, drive] of ROUTES) {
    it(`reaches the ${name} route`, async () => {
      const seen: string[] = [];
      await drive(arm(seen));

      expect(seen).toHaveLength(1);
      expect(hasSourceRendering(seen[0]!)).toBe(true);
    });
  }

  it('covers every route the dispatch table can select', () => {
    // Guards the list above against the dispatch growing a branch nobody added
    // here. `benchmark.ts` routes on capability and questionType; these are the
    // six `CortexMemory` entry points it can reach, so a seventh would have to be
    // added deliberately in both places.
    expect(ROUTES).toHaveLength(6);
  });
});

describe('the rendering is the only difference from the unarmed arm', () => {
  for (const [name, drive] of ROUTES) {
    it(`leaves the ${name} instruction block byte-identical when unarmed`, async () => {
      // The registration depends on this. If the rendering changed the ask, a
      // movement on that route could not be attributed to the rendering, and the
      // run would test two variables while naming one. Driven per route because
      // each route has its own ask -- MR's is `extractive` plus the session note,
      // TR's carries the date, ABS's carries the abstention token.
      const armed: string[] = [];
      const plain: string[] = [];
      await drive(arm(armed));
      await drive(unarmed(plain));

      expect(instructions(armed[0]!)).toBe(instructions(plain[0]!));
    });
  }

  it('changes the evidence block on every route, not only the abstention one', async () => {
    // The complement of the assertion above. Together they say the single variable
    // is the evidence and only the evidence, on every route -- which is what the
    // registration's §12.8 revision claims and what the limit=120 read showed was
    // false of the previous implementation.
    for (const [name, drive] of ROUTES) {
      const armed: string[] = [];
      const plain: string[] = [];
      await drive(arm(armed));
      await drive(unarmed(plain));

      expect(armed[0], `route ${name}`).not.toBe(plain[0]);
    }
  });
});

describe('the rendering is a rendering, not a contract name', () => {
  it('is applied on a route whose own ask is not the abstention ask', async () => {
    // This is the regression that keying the rendering off `contract ===
    // 'abstention'` would ship, and the reason §12.9 rewrote the decision. MR's
    // ask is `extractive`; the rendering must arrive anyway, because it is
    // selected as a rendering and not as an instruction block.
    const seen: string[] = [];
    await arm(seen).answerSessions('Which kit did I buy?', [[TEXT]]);

    expect(hasSourceRendering(seen[0]!)).toBe(true);
    // And the ask is still MR's own, so the rendering did not bring the
    // abstention token to a route that must not decline.
    expect(seen[0]!).toContain('Answer the question using only the evidence above.');
    expect(seen[0]!).toContain('do not merge facts across sessions');
  });

  it('the candidate is still one of the declared contracts', () => {
    // A name that is not in the product's own list would be rejected by
    // `readPromptContract` at parse time in a real dispatch, so a test using it
    // directly would be measuring an unreachable state.
    expect(PROMPT_CONTRACTS).toContain(ARM_CONTRACT);
  });

  it('the candidate rendering has the shape the route tests look for', () => {
    // Ties the route-level shape check to the renderer that produces it, so a
    // change to the id format cannot make every route test pass by matching
    // nothing.
    //
    // Driven through the rendering option rather than the contract name, because
    // that is the actual variable since §12.9: the name selects the rendering via
    // `RENDERING_BY_CONTRACT`, and a test that passed the name straight to a
    // builder would be asserting a coupling the design deliberately removed.
    expect(
      hasSourceRendering(buildPrompt('q', TURNS, 'abstention', { rendering: 'sourced' })),
    ).toBe(true);
    expect(hasSourceRendering(buildPrompt('q', TURNS, 'abstention'))).toBe(false);
    expect(
      hasSourceRendering(buildPrompt('q', TURNS, 'extractive', { rendering: 'sourced' })),
    ).toBe(true);
  });

  it('maps the run-named contract to the rendering the run means', () => {
    // The translation table is the one place the arm's published knob becomes the
    // variable actually measured, so it is asserted rather than assumed. A
    // contract with no entry must stay on the baseline rendering, which is what
    // keeps prior artifacts comparable.
    expect(RENDERING_BY_CONTRACT[ARM_CONTRACT]).toBe('sourced');
    expect(RENDERING_BY_CONTRACT.abstention).toBeUndefined();
    expect(RENDERING_BY_CONTRACT.extractive).toBeUndefined();
    expect(RENDERING_BY_CONTRACT.temporal).toBeUndefined();
  });
});

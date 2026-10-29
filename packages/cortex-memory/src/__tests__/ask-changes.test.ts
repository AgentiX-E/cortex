/**
 * Every ask changes exactly the routes it declares, and no others.
 *
 * ## The defect this file exists to make impossible
 *
 * An ask's **fallthrough** is the other half of its single-variable claim: where the ask does not
 * apply, the route must read what the *control* read. Getting that wrong has now happened four
 * times, always in the same direction, always while the block itself was correct:
 *
 * | run | ask | what the fallthrough did | cost |
 * | --- | --- | --- | --- |
 * | `39641088296` | `aggregation` | shipped block instead of the control's | TR −21.4, IE −9 |
 * | `40722772896` | `silent` | same shape, caught in review before dispatch | — |
 * | `40807829150` | `answer-line` | shipped block instead of the control's | MR −48, TR −12 |
 *
 * Each time the prose said "the other routes are byte-identical to the control" and each time a test
 * asserted the bytes the *implementation* produced, so the claim was never checked. The
 * `answer-line` version states the mistake as an intention — *"the control here is the SHIPPED block
 * rather than `enumerated`"* — which is a test pinning a defect and reading as coverage.
 *
 * ## What is asserted instead
 *
 * `ASK_CONTROLS` names the arm each ask is registered against and `ASK_CHANGES` names the routes it
 * may differ on. This file renders all six routes twice — once under the ask, once under its
 * control — and requires the set of routes whose instruction block differs to equal `ASK_CHANGES`
 * **exactly**. A route that moves without being declared fails; a route that is declared but does
 * not move fails too, because an ask that claims a treatment it does not administer publishes a
 * delta about nothing.
 *
 * The oracle is therefore the registration, not the implementation, which is the only arrangement in
 * which a wrong fallthrough is a failure rather than a fixture.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ASK_CHANGES, ASK_CONTROLS, ASK_ROUTES, type EvidenceAsk } from '../prompt.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const TEXT = 'I bought a 1/48 scale Spitfire kit.';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Spitfire';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function build(seen: string[], ask: EvidenceAsk): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ask,
  });
}

/** The instruction block: from the first instruction line to the end of the prompt. */
function instructionsOf(prompt: string): string {
  const at = prompt.indexOf('Answer the question');
  return at === -1 ? prompt : prompt.slice(at);
}

/**
 * One driver per route, named the way `ASK_ROUTES` and `ASK_CHANGES` name them.
 *
 * All six, because "the routes the ask does not name" is only checkable if every route can be
 * rendered. A missing driver would silently shrink the check to the routes somebody remembered,
 * which is the same class of omission this file is about.
 */
const ROUTES: ReadonlyArray<readonly [string, (m: CortexMemory) => Promise<unknown>]> = [
  ['abstention', (m) => m.answerAbstention('What is my passport number?', [TEXT])],
  ['multi-session', (m) => m.answerSessions('How many kits do I own?', [[TEXT]])],
  ['temporal', (m) => m.answerTemporal('How long ago?', [TEXT], '2023/06/01')],
  ['knowledge-update', (m) => m.answerKnowledgeUpdate('How many kits now?', [TEXT])],
  ['assistant', (m) => m.answerAssistant('What did you say about the kit?', [TEXT])],
  ['flat', (m) => m.answer('What kit did I buy?', [TEXT])],
];

/** The instruction block one route reads under one ask. */
async function blockUnder(
  ask: EvidenceAsk,
  route: (m: CortexMemory) => Promise<unknown>,
): Promise<string> {
  const seen: string[] = [];
  await route(build(seen, ask));
  expect(seen).toHaveLength(1);
  return instructionsOf(seen[0]!);
}

describe('every ask changes exactly the routes it declares', () => {
  const asks = Object.keys(ASK_CONTROLS) as EvidenceAsk[];

  for (const ask of asks) {
    it(`${ask} changes exactly ${JSON.stringify(ASK_CHANGES[ask])}`, async () => {
      const control = ASK_CONTROLS[ask];
      const moved: string[] = [];
      for (const [name, drive] of ROUTES) {
        const under = await blockUnder(ask, drive);
        const against = await blockUnder(control, drive);
        if (under !== against) moved.push(name);
      }
      expect(moved.sort()).toEqual([...ASK_CHANGES[ask]].sort());
    });
  }

  it('names a control for every ask, and every control is itself an ask', () => {
    // A table is only an oracle if it is total: a value added to the union without a control would
    // leave the loop above silently short by one ask.
    expect(asks.length).toBe(new Set(asks).size);
    for (const ask of asks) expect(asks).toContain(ASK_CONTROLS[ask]);
  });

  it('leaves the shipped ask changing nothing, which is what makes it a control', () => {
    expect(ASK_CHANGES.route).toEqual([]);
    expect(ASK_CONTROLS.route).toBe('route');
  });

  it("keeps every change inside the ask's declared reach", () => {
    // A route cannot change without being reached, so the change set is a subset of the reach. The
    // converse is not true -- `enumerated` reaches three routes and changes one -- and that gap is
    // the content of the single-variable claim, which is why two tables exist instead of one.
    for (const ask of asks) {
      for (const route of ASK_CHANGES[ask]) {
        expect(ASK_ROUTES[ask] ?? []).toContain(route);
      }
    }
  });
});

describe('the two flat-route asks are separated by the ask value, not by their reach', () => {
  it('agrees on every route but flat, so the pair is one variable apart', async () => {
    // `answer-line` and `recommend` both change the flat block and neither may move anything else.
    // A reader of two artifacts sees the same `askRoutes` and must be able to separate them by
    // `ask` alone -- the argument `enumerated` and `computed` already make.
    for (const [name, drive] of ROUTES) {
      const answerLine = await blockUnder('answer-line', drive);
      const recommend = await blockUnder('recommend', drive);
      if (name === 'flat') expect(answerLine).not.toBe(recommend);
      else expect(answerLine).toBe(recommend);
    }
  });
});

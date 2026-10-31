/**
 * Two asks in one run, because the run that measured one of them removed the other.
 *
 * ## The measurement this exists for
 *
 * Run `41188431321` replaced `ask: operands` with `ask: operand-gap` and moved the abstention route
 * exactly as registered: `ABS` 29/29/29 → **30/30/30**, `6456829e_abs` `0000` → `1111`, and no second
 * ABS question stopped declining. It also removed 62 questions from the roster, and the reason is not
 * the new rule: **`ask` is a single value**, so naming `operand-gap` left `ASK_ROUTES` with one route
 * and the three routes that read `operands` fell through to the shipped block. `MR` −48.75, `TR`
 * −11.75, `IE` −3.0, `operands` measured at **63 questions** for the first time (§13.193.3).
 *
 * So the configuration the arm needs is not "one ask or the other". It is both, and the two are
 * disjoint in contract space: `operands` changes the `extractive` and `temporal` blocks, `operand-gap`
 * changes the `abstention` block, and no contract is reachable by both. The composition is therefore
 * well defined on every route, and this file asserts it is the composition **by delegation** — the
 * composite's block on each contract must be byte-identical to the block that half renders, so the
 * claim cannot drift into a third copy of either text.
 *
 * ## Why the control is `operands` and not `enumerated`
 *
 * `ASK_CONTROLS` names the arm each value is read against, and the arm this run will be read against
 * is `41185512391`, which ran `ask: operands`. Choosing that control also makes the shape-dependence
 * cancel: `operands` is the only ask whose block reads the question, and it is on the control side of
 * every route the composite does not touch, so `ASK_CHANGES_WHEN_DERIVATION` needs no entry and the
 * change set is one route on both shapes. Registration is §13.193.5.
 *
 * ## What is deliberately not asserted
 *
 * The wording of either block. Both halves are measured constants with their own files, and pinning
 * prose here would make the next edit to either a rewrite of this test.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import {
  ASK_CHANGES,
  ASK_CHANGES_WHEN_DERIVATION,
  ASK_CONTROLS,
  ASK_ROUTES,
  type EvidenceAsk,
} from '../prompt.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const TEXT = 'I bought a 1/48 scale Spitfire kit.';
const TOMATO = 'I planted 5 tomato plants initially.';

/** The composed configuration, named after the two values it composes. */
const COMPOSITE = 'operands+operand-gap' as EvidenceAsk;

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

function build(seen: string[], ask?: EvidenceAsk): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    // A default run is `undefined` rather than `'route'`, and `exactOptionalPropertyTypes` means the
    // two are not interchangeable at the call site. §13.188's arrangement, copied from the test that
    // asserts the same property for `operand-gap`.
    ...(ask === undefined ? {} : { ask }),
  });
}

function instructionsOf(prompt: string): string {
  const at = prompt.indexOf('Answer the question');
  return at === -1 ? prompt : prompt.slice(at);
}

/**
 * The six routes, and the two question shapes.
 *
 * Both shapes are driven on every route because `operands` — the control — is the one ask whose block
 * depends on the question. A single shape would leave the composite's delegation untested on exactly
 * the branch that made a second table necessary.
 */
const ROUTES: ReadonlyArray<
  readonly [string, (m: CortexMemory, question: string) => Promise<unknown>]
> = [
  ['abstention', (m, question) => m.answerAbstention(question, [TOMATO])],
  ['multi-session', (m, question) => m.answerSessions(question, [[TOMATO, TEXT]])],
  ['temporal', (m, question) => m.answerTemporal(question, [TEXT], '2023/06/01')],
  ['knowledge-update', (m, question) => m.answerKnowledgeUpdate(question, [TEXT])],
  ['assistant', (m, question) => m.answerAssistant(question, [TEXT])],
  ['flat', (m, question) => m.answer(question, [TEXT])],
];

const QUESTIONS = {
  enumeration: 'How many kits do I own?',
  derivation: 'How many years older is my grandma than me?',
} as const;

async function blockUnder(
  ask: EvidenceAsk | undefined,
  drive: (m: CortexMemory, question: string) => Promise<unknown>,
  question: string,
): Promise<string> {
  const seen: string[] = [];
  await drive(build(seen, ask), question);
  expect(seen).toHaveLength(1);
  return instructionsOf(seen[0]!);
}

/** The half a route must read under the composite, decided by the route, not by the ask's name. */
function halfFor(route: string): EvidenceAsk {
  return route === 'abstention' ? 'operand-gap' : 'operands';
}

describe('the composite is the two asks, delegated route by route', () => {
  for (const [shape, question] of Object.entries(QUESTIONS)) {
    it(`renders every route exactly as its half does on a ${shape} question`, async () => {
      // Equality with the half, per route, is the whole union claim: a composite that re-worded
      // either block would pass a "contains the rule" test and fail this one.
      for (const [route, drive] of ROUTES) {
        expect([route, await blockUnder(COMPOSITE, drive, question)]).toEqual([
          route,
          await blockUnder(halfFor(route), drive, question),
        ]);
      }
    });
  }

  it('changes exactly one route relative to the control it will be read against', async () => {
    // `41185512391` ran `ask: operands`. The difference between these two configurations is the
    // abstention route and nothing else, which is what makes the next dispatch one variable.
    const moved: string[] = [];
    for (const [route, drive] of ROUTES) {
      for (const question of Object.values(QUESTIONS)) {
        const under = await blockUnder(COMPOSITE, drive, question);
        const against = await blockUnder('operands', drive, question);
        if (under !== against && !moved.includes(route)) moved.push(route);
      }
    }
    expect(moved).toEqual(['abstention']);
  });

  it('is not what a default run runs, so every archived artifact keeps its prompt', async () => {
    for (const [route, drive] of ROUTES) {
      expect([route, await blockUnder(undefined, drive, QUESTIONS.enumeration)]).toEqual([
        route,
        await blockUnder('route', drive, QUESTIONS.enumeration),
      ]);
    }
  });
});

describe('the tables say what the composite covers and what it moves', () => {
  it('reaches the union of the two reaches', () => {
    const union = new Set([...(ASK_ROUTES.operands ?? []), ...(ASK_ROUTES['operand-gap'] ?? [])]);
    expect([...(ASK_ROUTES[COMPOSITE] ?? [])].sort()).toEqual([...union].sort());
    // Four of the six routes: the two the halves cannot address -- `knowledge-update` and
    // `assistant` -- are the internal control of the next dispatch.
    expect(ASK_ROUTES[COMPOSITE]).toEqual(['multi-session', 'flat', 'temporal', 'abstention']);
  });

  it('changes one route relative to its control, which is the run it will be read against', () => {
    expect(ASK_CHANGES[COMPOSITE]).toEqual(['abstention']);
    expect(ASK_CONTROLS[COMPOSITE]).toBe('operands');
  });

  it('needs no shape-specific change set, because the shape-dependent half is the control', () => {
    // `operands` is the only ask whose block reads the question, and every route it can reach is on
    // the control side of this composite. An entry here would be a claim with no render behind it,
    // and the oracle in `ask-changes.test.ts` would then require the composite to move a route it
    // cannot move.
    expect(ASK_CHANGES_WHEN_DERIVATION[COMPOSITE]).toBeUndefined();
  });
});

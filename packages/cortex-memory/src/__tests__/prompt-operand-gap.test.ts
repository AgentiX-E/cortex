/**
 * The abstention route reads a closing rule that can only see the question as a whole, and
 * `operand-gap` is the ask that makes the rule see each operand.
 *
 * ## The failure this is written against
 *
 * `6456829e_abs` asks *"How many plants did I initially plant for tomatoes and chili peppers"*, and its
 * gold is a decline: the evidence states five tomato plants and says nothing about chili peppers. The
 * arm answered `5` — a correct count of half the question — in every repetition of every archived run,
 * while the reference pipeline declined, and while the six structurally identical conjunction questions
 * in the same thirty (`edced276`, `e5ba910e`, `gpt4_70e84552`, `gpt4_c27434e8`, `gpt4_fe651585`,
 * `80ec1f4f`) all declined correctly. `docs/MEASURE-…`'s census of that cohort is the registration;
 * this file states what the block has to say for it to be reachable at all.
 *
 * The chain, from that census: the query expansion fuses the two operands into one phrase, the fused
 * phrase can only be satisfied by the operand that exists, the window fills with single-operand evidence
 * dense enough to look complete, and then the block as shipped says *"if no evidence supports an answer"*
 * — a predicate over the question, which the half-answer satisfies. So the prompt half of the fix is not
 * a sentence near the rule. It is the rule.
 *
 * ## Why the closing line rather than another line above it
 *
 * `withReplacedClose` exists because this was measured: §13.55 inserted its rule above the closing line
 * and run `39035438120` returned the same delta and the same declines, twelve of them with a non-empty
 * list in hand. A rule that has to decide cannot be a second statement placed near the first. Here the
 * line that decides is the block's last one, `Otherwise reply with the answer alone.`, and it is also the
 * line that licenses answering, so `operand-gap` replaces it with a rule that carries both halves.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The line count, the equality of every earlier line, and the three things the new close must contain —
 * the token, the answer instruction, and the per-part condition. Not the exact wording: a test that pins
 * prose makes the next edit a rewrite of the test, and the campaign's record is that wording changes are
 * cheap and are measured, not frozen.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import { ASK_CHANGES, ASK_CONTROLS, ASK_ROUTES, type EvidenceAsk } from '../prompt.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

/** The tomato session and the generic turn, because the abstention route admits flat text. */
const TOMATO = 'I planted 5 tomato plants initially.';

const GAP_QUESTION = 'How many plants did I initially plant for tomatoes and chili peppers?';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return ABSTAIN_TOKEN;
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
    ...(ask === undefined ? {} : { ask }),
  });
}

/** The instruction block: from the first instruction line to the end of the prompt. */
function instructionsOf(prompt: string): string {
  const at = prompt.indexOf('Answer the question');
  return at === -1 ? prompt : prompt.slice(at);
}

async function blockUnder(ask: EvidenceAsk | undefined, question = GAP_QUESTION): Promise<string> {
  const seen: string[] = [];
  await build(seen, ask).answerAbstention(question, [TOMATO]);
  expect(seen).toHaveLength(1);
  return instructionsOf(seen[0]!);
}

/** The other five routes, each named the way the reach tables name it. */
const OTHER_ROUTES: ReadonlyArray<
  readonly [string, (m: CortexMemory, question: string) => Promise<unknown>]
> = [
  ['multi-session', (m, question) => m.answerSessions(question, [[TOMATO]])],
  ['temporal', (m, question) => m.answerTemporal(question, [TOMATO], '2023/06/01')],
  ['knowledge-update', (m, question) => m.answerKnowledgeUpdate(question, [TOMATO])],
  ['assistant', (m, question) => m.answerAssistant(question, [TOMATO])],
  ['flat', (m, question) => m.answer(question, [TOMATO])],
];

async function armedBlock(
  ask: EvidenceAsk,
  route: (typeof OTHER_ROUTES)[number][1],
): Promise<string> {
  const seen: string[] = [];
  await route(build(seen, ask), GAP_QUESTION);
  expect(seen).toHaveLength(1);
  return instructionsOf(seen[0]!);
}

describe('the closing rule the abstention route is graded on', () => {
  it('licenses answering unconditionally, which is what a half-answer satisfies', async () => {
    // The precondition of the replacement, stated so an edit to the shipped line fails here rather than
    // making the ask a silent no-op: `withReplacedClose` replaces a position, so it cannot notice that
    // the position no longer says what the registration is written against.
    const lines = (await blockUnder(undefined)).split('\n');
    const close = lines.at(-1)!;
    expect(close).toBe('Otherwise reply with the answer alone.');
    // And the token rule above it is a predicate over the QUESTION: evidence supporting "an answer",
    // singular, which half of a conjunction supplies.
    expect(lines.at(-2)).toContain(
      `If no evidence supports an answer, reply exactly ${ABSTAIN_TOKEN}.`,
    );
  });

  it('is the only line `operand-gap` moves, and it moves the last one', async () => {
    const shipped = (await blockUnder(undefined)).split('\n');
    const armed = (await blockUnder('operand-gap')).split('\n');

    // Same shape, every earlier line unchanged: the treatment is one rule, and a second edited line
    // would be a second variable in a run whose value is that it has one.
    expect(armed).toHaveLength(shipped.length);
    expect(armed.slice(0, -1)).toEqual(shipped.slice(0, -1));
    expect(armed.at(-1)).not.toBe(shipped.at(-1));
  });

  it('names the token, the answer instruction and the per-part condition in one rule', async () => {
    const close = (await blockUnder('operand-gap')).split('\n').at(-1)!;

    // The three halves are what make the rule decidable: a decline needs a token to decline with, an
    // answer instruction has to survive or the route stops being able to answer at all, and the
    // condition has to be about the PARTS rather than about the question -- the shipped rule's
    // "no evidence supports an answer" is exactly the reading that a half-answer satisfies.
    expect(close).toContain(ABSTAIN_TOKEN);
    expect(close.toLowerCase()).toContain('reply with the answer alone');
    expect(close.toLowerCase()).toContain('every part');
    // Singular decliners are the failure mode this must not reintroduce: `or` keeps the shipped
    // condition as well, so a question with one absent operand is still declined for the old reason.
    expect(close.toLowerCase()).toContain('or');
  });

  it('leaves the other five routes on the shipped block, byte for byte', async () => {
    for (const [name, drive] of OTHER_ROUTES) {
      expect([name, await armedBlock('operand-gap', drive)]).toEqual([
        name,
        await armedBlock('route', drive),
      ]);
    }
  });

  it('is not what a default run runs, so every archived artifact keeps its prompt', async () => {
    // §13.188's arrangement, for the same reason: the repair is selectable first and shipped later, or
    // the four thousand archived prompts stop being comparable to the next run in one commit.
    expect(await blockUnder(undefined)).toBe(await blockUnder('route'));
  });
});

describe('the tables say where it lands', () => {
  it('reaches one route and changes one route, which is the whole single-variable claim', () => {
    expect(ASK_ROUTES['operand-gap']).toEqual(['abstention']);
    expect(ASK_CHANGES['operand-gap']).toEqual(['abstention']);
    // The shipped block, not `enumerated`'s: the abstention route reads the same bytes under both, so
    // the control for this ask is `route` and nothing else can be.
    expect(ASK_CONTROLS['operand-gap']).toBe('route');
  });

  it('is the complement of `operands`, which reaches the multi-session route and not this one', async () => {
    // Two asks about operands, disjoint by construction: `operands` asks the reading route to FIND them
    // (MR's derivation declines), `operand-gap` asks the abstention route to notice one is MISSING. A
    // single run cannot therefore carry both, and neither can be the other's control.
    expect(ASK_CHANGES.operands).not.toContain('abstention');
    expect(await blockUnder('operands')).toBe(await blockUnder('route'));
    expect(ASK_CHANGES['operand-gap']).not.toContain('multi-session');
  });
});

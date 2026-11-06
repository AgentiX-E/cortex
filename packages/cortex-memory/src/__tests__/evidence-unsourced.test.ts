/**
 * TDD for the §13.283 rendering variable: the per-turn source id is withheld.
 *
 * ## What the artifact says before any code changed
 *
 * On `42237543941` a multi-session prompt is **13.83% source id** by character count -- 38
 * characters per turn, 6,650 in a 48,000-character room -- and the reader reproduces an id in
 * **4 of 500** answers, none of them on `MR` (0/121) or `TR` (0/127), the two routes that pay the
 * most for it. The boundary the id exists to draw is already drawn by the `Session N` header
 * `buildSessionPrompt` writes unconditionally, and 31 of 500 answers name one of those.
 *
 * ## Why the claim is a containment and not an average
 *
 * At a fixed budget, a cheaper per-item rendering admits a weakly longer prefix of the same order.
 * So the delivered set under the unsourced rendering **contains** the delivered set under the
 * sourced one, question by question, and no gold turn can be lost by the change. That is an
 * equality-shaped claim about a change that is not an equality, and it is what lets §13.283's
 * seventh gate read "coverage never falls" as a property rather than as a hope.
 *
 * ## What must not move
 *
 * The instruction block and the assembly order. Both are asserted byte-wise here, because a
 * treatment that also edited the wording would make a movement unattributable -- the confound
 * §13.104, §13.124 and §13.279 each cost a dispatch to learn.
 */

import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import {
  ASSEMBLY_BY_CONTRACT,
  PROMPT_CONTRACTS,
  RENDERING_BY_CONTRACT,
  buildSessionPrompt,
} from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';

const NOW = 1_759_470_000_000;

/** §13.283's contract: the §13.279 instruction and order, with the per-turn id withheld. */
const TREATED = 'evidence-blocks-unsourced' as const;

/** The run it is read against: `42237543941`'s configuration, byte for byte. */
const CONTROL = 'evidence-blocks-instruction-first' as const;

const QUESTION = 'How many items of clothing do I need to pick up or return from a store?';

/** The 38-character marker `sourced` puts in front of every turn. */
const SOURCE_MARKER = /\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\] /;

/** The budget the containment is asserted at: small enough that the prefix cut binds. */
const BUDGET = 6_000;

/**
 * Three sessions of twelve turns, each turn long enough that the marker is a real fraction of it.
 *
 * Built through `createMemory` for the reason `prompt-assembly.test.ts` records: a hand-written
 * literal drifts from `AdmittedTurn` the moment a field is renamed, and the renderer emits whatever
 * it is given. The turns are distinguished by an ordinal in their text so a failure names the turn.
 */
function buildSessions(): AdmittedSession[] {
  return [0, 1, 2].map((session) => ({
    index: session,
    size: 12,
    turns: Array.from({ length: 12 }, (_, turn) => ({
      ...createMemory({
        content:
          `session ${session} turn ${turn}: ` +
          'I sorted the wardrobe out and set aside the pieces that no longer fit, ' +
          'then drove them to the shop on the high street before it closed for the day.',
      }),
      ordinal: turn,
    })),
  }));
}

/** One fixture for the whole file: `createMemory` mints a fresh id per call. */
const SESSIONS: AdmittedSession[] = buildSessions();

function render(
  rendering: 'numbered' | 'sourced',
  maxChars = BUDGET,
): ReturnType<typeof buildSessionPrompt> {
  return buildSessionPrompt(QUESTION, SESSIONS, {
    ask: 'verbatim',
    rendering,
    maxTurnChars: 400,
    maxChars,
    assembly: 'instruction-first',
  });
}

/** An LLM that records every prompt it is asked. */
function recorder(seen: string[], answer = '2'): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return answer;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function memory(seen: string[], promptContract: string): CortexMemory {
  return new CortexMemory({
    now: NOW,
    name: 'cortex-memory',
    llm: recorder(seen),
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ask: 'verbatim',
    promptContract: promptContract as (typeof PROMPT_CONTRACTS)[number],
  });
}

describe('the per-turn source id', () => {
  it('is named by a contract, so the artifact can prove the treatment arrived', () => {
    expect(PROMPT_CONTRACTS).toContain(TREATED);
    expect(RENDERING_BY_CONTRACT[TREATED]).toBeUndefined();
  });

  it('holds the order and the instruction, so its single variable is the rendering', () => {
    // Order: the control's own value, restated rather than omitted, because a contract that also
    // moved the order would make §13.283's delta a statement about two changes.
    expect(ASSEMBLY_BY_CONTRACT[TREATED]).toBe(ASSEMBLY_BY_CONTRACT[CONTROL]);
    // Instruction: the first `\n\n`-separated segment under both renderings. Equal, because the
    // contract delegates to the control's function rather than carrying a second copy of the text.
    const treated = render('numbered').prompt.split('\n\n')[0];
    const control = render('sourced').prompt.split('\n\n')[0];
    expect(treated).toBe(control);
  });

  it('is what the aggregation prompt stops drawing', () => {
    expect(SOURCE_MARKER.test(render('sourced').prompt)).toBe(true);
    expect(SOURCE_MARKER.test(render('numbered').prompt)).toBe(false);
  });

  it('returns the room it occupied to the evidence, and both regimes are asserted', () => {
    // Tight budget: the room is spent, not saved. The prompt still fits, the evidence content is
    // unchanged character for character, and more of it arrives -- 23 turns against 19 on this
    // fixture, because the same per-turn content costs 38 characters less.
    const treated = render('numbered');
    const control = render('sourced');
    expect(treated.prompt.length).toBeLessThanOrEqual(BUDGET);
    expect(treated.evidenceChars).toBeGreaterThanOrEqual(control.evidenceChars);
    expect(treated.carried.length).toBeGreaterThan(control.carried.length);

    // Generous budget: every turn fits under both, so the difference is the tax itself and nothing
    // else -- the same 36 turns, and the unsourced prompt is 1,404 characters shorter. That figure
    // is the marker's cost at this corpus size, which is what the artifact measures as 13.83%.
    const roomyTreated = render('numbered', 12_000);
    const roomyControl = render('sourced', 12_000);
    expect(roomyTreated.carried.length).toBe(roomyControl.carried.length);
    expect(roomyControl.prompt.length - roomyTreated.prompt.length).toBe(1_404);
  });

  it('cannot remove a turn the control delivered', () => {
    // The containment: a cheaper per-item rendering admits a weakly longer prefix of one order, so
    // every turn the control carries is carried here. §13.283's seventh gate reads this as "no
    // question can lose a gold turn", which is why the change needs no per-question exception.
    // By identity rather than by text: a corpus can repeat a sentence, and a text comparison would
    // call two different turns equal.
    const treated = render('numbered').carried.map((turn) => turn.id);
    const control = render('sourced').carried.map((turn) => turn.id);
    for (const id of control) expect(treated).toContain(id);
  });

  it('keeps the boundary the id was drawn for', () => {
    // The header is the route's ask, not the rendering: dropping it would leave the session note
    // referring to boundaries that are no longer drawn.
    const prompt = render('numbered').prompt;
    expect(prompt).toContain('Session 1');
    expect(prompt).toContain('Some evidence is grouped into sessions.');
    // And the dates the reader uses for `item | verb | session date` survive, because they are part
    // of the turn's own text rather than of the marker.
    expect(prompt).toContain('session 0 turn 0:');
  });

  it('withholds the marker on every route, not only the aggregation one', async () => {
    // The reach is all six, and it is measured by driving the product rather than by reading the
    // table: five of the six routes build outside `buildSessionPrompt`, and a contract that only
    // reached the session builder would leave 13.8% of the room unclaimed on `TR` -- the route with
    // the largest marker share after `MR`.
    const text = 'I bought a 1/48 scale Spitfire kit for £34.99 on 2023/06/01.';
    const drivers: ReadonlyArray<readonly [string, (built: CortexMemory) => Promise<unknown>]> = [
      ['multi-session', (m) => m.answerSessions(QUESTION, [[text], [text]])],
      ['abstention', (m) => m.answerAbstention('What is my passport number?', [text])],
      ['temporal', (m) => m.answerTemporal('How long ago did I buy it?', [text], '2023/06/01')],
      ['knowledge-update', (m) => m.answerKnowledgeUpdate('How many kits do I own now?', [text])],
      ['assistant', (m) => m.answerAssistant('What did you tell me about the kit?', [text])],
      ['flat', (m) => m.answer('What did I buy?', [text])],
    ];
    for (const [route, drive] of drivers) {
      const treated: string[] = [];
      await drive(memory(treated, TREATED));
      expect(treated, `${route} still draws a source id`).toHaveLength(1);
      expect(SOURCE_MARKER.test(treated[0]!), `${route} still draws a source id`).toBe(false);
      // The control side, so a route that never drew one cannot pass this test by being inert.
      const control: string[] = [];
      await drive(memory(control, CONTROL));
      expect(SOURCE_MARKER.test(control[0]!), `${route} no longer draws one`).toBe(true);
    }
  });
});

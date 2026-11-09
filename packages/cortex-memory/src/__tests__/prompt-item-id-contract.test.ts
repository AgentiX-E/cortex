/**
 * TDD for §13.346: the contract that carries the global item identifier.
 *
 * ## What this contract is, and what it is not
 *
 * `I1`'s treatment is the numbering scheme and nothing else. The instruction block, the assembly
 * order, the evidence set, the order inside it and the character budget are all the control's --
 * `evidence-blocks-unsourced`, the configuration every published `MR` reading was taken under --
 * and the one difference is that each delivered turn is labelled `[item N]` with `N` running
 * across the session blocks instead of restarting in each.
 *
 * That is why the contract delegates its instruction to the control's function rather than
 * restating it: "the text is identical" becomes a property of the object graph, and a later edit
 * to the control moves both arms. §13.104, §13.124 and §13.279 each cost a dispatch to learn what
 * a second copy of a block does to an attribution.
 *
 * ## Why the contract exists at all
 *
 * `I1` is registered on the `MR` route alone, and the route is the population: `capability=MR`
 * selects its 121 questions for 1.73 CNY (§13.345.3). A new workflow input would have cost the
 * last slot on a dispatch table that `test_no_workflow_sits_at_the_input_ceiling` forbids filling,
 * and the contract is already the axis that carries "how this run renders" (§13.279, §13.283).
 */
import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import {
  ASSEMBLY_BY_CONTRACT,
  PROMPT_CONTRACTS,
  RENDERING_BY_CONTRACT,
  buildPrompt,
  buildSessionPrompt,
} from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';

const NOW = 1_759_470_000_000;

/** `I1`'s contract. */
const TREATED = 'evidence-blocks-item-ids' as const;

/** The run it is read against: the shipped configuration, byte for byte. */
const CONTROL = 'evidence-blocks-unsourced' as const;

const QUESTION = 'How many bikes do I currently own?';

const BUDGET = 12_000;

function buildSessions(): AdmittedSession[] {
  return [0, 2].map((session) => ({
    index: session,
    size: 3,
    turns: [0, 1, 2].map((turn) => ({
      ...createMemory({
        content: `s${session}t${turn}: I keep a bike in the shed and ride it to work.`,
      }),
      ordinal: turn,
    })),
  }));
}

const SESSIONS: AdmittedSession[] = buildSessions();

function render(rendering: 'numbered' | 'item-ids'): string {
  return buildSessionPrompt(QUESTION, SESSIONS, {
    ask: 'verbatim-acts',
    rendering,
    maxTurnChars: 400,
    maxChars: BUDGET,
    assembly: 'instruction-first',
  }).prompt;
}

function recorder(seen: string[], answer = '3'): LLM {
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
    ask: 'verbatim-acts',
    promptContract: promptContract as (typeof PROMPT_CONTRACTS)[number],
  });
}

describe('the item-id contract', () => {
  it('is named by a contract, so the artifact can prove the treatment arrived', () => {
    expect(PROMPT_CONTRACTS).toContain(TREATED);
    expect(RENDERING_BY_CONTRACT[TREATED]).toBe('item-ids');
  });

  it('holds the order and the instruction, so its single variable is the numbering', () => {
    expect(ASSEMBLY_BY_CONTRACT[TREATED]).toBe(ASSEMBLY_BY_CONTRACT[CONTROL]);

    const strip = (prompt: string): string =>
      prompt.replace(/^(\d+\. |#\d+ )/gm, '').replace(/^(Session \d+)$/gm, '$1');
    expect(strip(render('item-ids'))).toBe(strip(render('numbered')));
  });

  it('numbers the item the reader is on, across the block boundary', () => {
    const treated = render('item-ids');
    // Six turns over two blocks: the fourth is `[item 4]`, not `[item 1]`. That one line is the
    // entire treatment, and the count is readable off it.
    expect(treated).toContain('#4 s2t0:');
    expect(treated).not.toContain('#1 s2t0:');
    expect(treated).toContain('#6 s2t2:');
  });

  it('reaches the product, not only the builder', async () => {
    const seen: string[] = [];
    const arm = memory(seen, TREATED);
    await arm.answerSessions(QUESTION, [
      ['I keep a bike in the shed and ride it to work.'],
      ['I keep a bike in the shed and ride it to work.'],
    ]);
    const prompt = seen[0] ?? '';

    expect(prompt).toContain('#1 ');
    // Two blocks of one turn each, so the second block's turn is the second item: the property the
    // route is being measured on, read from a real request rather than from the builder's options.
    expect(prompt).toContain('#2 ');
  });

  it('serves the instruction block of the contract it delegates to, byte for byte', () => {
    // The delegation, measured at the one builder whose contract actually selects the block: the
    // session builder hardcodes `extractive` for `MR`, so a contract's own instruction text reaches
    // the five flat routes and this assertion is where "the wording is the control's" can be read.
    const turns = [{ ...createMemory({ content: 'I keep a bike in the shed.' }), ordinal: 0 }];
    const at = (contract: typeof TREATED | typeof CONTROL): string =>
      buildPrompt(QUESTION, turns, contract, { ask: 'route' }).prompt;

    expect(at(TREATED)).toBe(at(CONTROL));
    // And the block is the control's *text*, not an empty string that would make the two equal for
    // the wrong reason.
    expect(at(TREATED)).toContain('Answer the question using only the evidence above.');
  });

  it('is distinguishable from the control at the product level', async () => {
    const treatedSeen: string[] = [];
    const controlSeen: string[] = [];
    await memory(treatedSeen, TREATED).answerSessions(QUESTION, [
      ['I keep a bike in the shed and ride it to work.'],
      ['I keep a bike in the shed and ride it to work.'],
    ]);
    await memory(controlSeen, CONTROL).answerSessions(QUESTION, [
      ['I keep a bike in the shed and ride it to work.'],
      ['I keep a bike in the shed and ride it to work.'],
    ]);

    expect(treatedSeen[0]).not.toBe(controlSeen[0]);
    expect(controlSeen[0]).not.toContain('[item 1]');
  });
});

/**
 * `operands` asks a derivation question for numbers and an enumeration question for nothing new.
 *
 * ## The two claims, and why both are needed
 *
 * The ask is a **conditional** treatment: it changes the block for questions whose answer is computed
 * and leaves every other render byte-identical to its control. A test that only checked the operand
 * block would pass on an implementation that also changed the enumeration block, and that defect has
 * now cost this campaign four dispatches ($13.104, §13.123, §13.124, §13.132) — each time the block
 * was right and the fallthrough was wrong.
 *
 * So the assertions are paired: the derivation question reads the operand contract, and the
 * enumeration question reads `enumerated`'s block **as a string equality against a separately built
 * prompt**, not as "does not contain the word operands".
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { parseAnswer } from '../parse.js';
import type { EvidenceAsk } from '../prompt.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const TEXT = 'I am 32 and my grandma just turned 75.';

const DERIVATION = 'How many years older is my grandma than me?';
const ENUMERATION = 'How many mentions of a birthday are in the evidence?';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '43';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

async function promptUnder(ask: EvidenceAsk, question: string): Promise<string> {
  const seen: string[] = [];
  const memory = new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ask,
  });
  await memory.answerSessions(question, [[TEXT]]);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe('a derivation question reads the operand contract', () => {
  it('asks for the numbers the question needs instead of the items that match it', async () => {
    const prompt = await promptUnder('operands', DERIVATION);
    expect(prompt).toContain('identify the numbers this question needs, one per line');
    expect(prompt).toContain('a difference, a sum, an average, a percentage, an elapsed time');
    // The line the mechanism exists to replace. A reader looking for items on this question finds
    // none, and §13.166's census is six replies that then declined because the answer was not stated.
    expect(prompt).not.toContain('list every item in the evidence that matches the question');
  });

  it('licenses the computation rather than qualifying a prohibition', async () => {
    // §13.132 measured what happens when the licence sits above a nearer prohibition: the model quotes
    // the prohibition back. Here the prohibition is absent -- there is nothing to quote -- and the
    // licence says the answer is *expected* not to appear as a stated value.
    const prompt = await promptUnder('operands', DERIVATION);
    expect(prompt).toContain('it is not expected to appear in the evidence as a stated value');
    expect(prompt).not.toContain('do not merge two items into one');
  });

  it('keeps a closing rule the parser can read', async () => {
    // `parseAnswer` reads the text after the last step heading and strips quotes, so the block's last
    // line has to say what to write rather than merely what not to. The assertion is on the prompt
    // *and* on a reply that echoes the block, because either half alone can be satisfied by an
    // implementation the other half rejects.
    const prompt = await promptUnder('operands', DERIVATION);
    expect(prompt.trimEnd().endsWith('reply exactly INSUFFICIENT_EVIDENCE.')).toBe(true);
    const reply = [
      'Step 1 — the numbers:',
      '- the user’s age | 32',
      '- the grandma’s age | 75',
      '',
      'Step 2 — 75 − 32 = 43',
      '',
      '43',
    ].join('\n');
    expect(parseAnswer(reply)).toBe('43');
  });
});

describe('an enumeration question reads exactly what `enumerated` reads', () => {
  it('leaves the block byte-identical, so the ask is one variable on one population', async () => {
    const under = await promptUnder('operands', ENUMERATION);
    const control = await promptUnder('enumerated', ENUMERATION);
    expect(under).toBe(control);
    expect(under).toContain('list every item in the evidence that matches the question');
    expect(under).not.toContain('identify the numbers this question needs');
  });

  it('leaves the evidence and the question untouched on both shapes', async () => {
    // The treatment changes the instruction and nothing else, which is the claim every ask in this
    // package has to keep: a prompt whose evidence block also moved would make the accuracy delta a
    // statement about two things.
    const derivation = await promptUnder('operands', DERIVATION);
    const control = await promptUnder('enumerated', DERIVATION);
    const evidenceOf = (prompt: string): string =>
      prompt.slice(0, prompt.indexOf('Answer the question using only the evidence above.'));
    expect(evidenceOf(derivation)).toBe(evidenceOf(control));
    expect(derivation).toContain(`QUESTION: ${DERIVATION}`);
  });
});

describe('the route table holds the shape decision', () => {
  it('reaches the multi-session route and leaves the flat path on its control block', async () => {
    // `buildSessionPrompt` and the flat path both build with `extractive`, so a branch keyed on the
    // contract alone would move the flat route under an ask registered against multi-session. That is
    // §13.124's defect, and this asserts the scope guard from the flat side.
    const seenOperands: string[] = [];
    const seenControl: string[] = [];
    const build = (seen: string[], ask: EvidenceAsk): CortexMemory =>
      new CortexMemory({
        llm: recorder(seen),
        now: NOW,
        name: 'cortex-memory',
        gate: { ...GATE },
        ask,
      });
    await build(seenOperands, 'operands').answer(DERIVATION, [TEXT]);
    await build(seenControl, 'enumerated').answer(DERIVATION, [TEXT]);
    expect(seenOperands[0]).toBe(seenControl[0]);
  });
});

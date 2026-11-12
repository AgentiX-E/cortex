/**
 * Where the echo gate can reach, and the population it could not — read off `43121298653`.
 *
 * ## What the run showed
 *
 * The gate was registered on a census of **final** replies: 15 dumps in `42533236864`, wrong 8 times. The arm
 * dispatched to catch them (`43121298653`, `replyRepair: echo`) recorded `echo.attempted: 0` on all 500
 * questions, and its own recorded replies still contain **14 dumps, 7 of them wrong**. Its accuracy moved
 * 456 -> 457, which is one question and inside the noise floor.
 *
 * The product is not the explanation: the first test below is the same evidence, one call deep, and the gate
 * fires. The difference is **which call produced the dump**. `planReplyRepair` reads `#lastRawOutput`
 * immediately after the first consultation on each route, and a question whose first reply is a bare decline
 * takes the retry before that point is reached again — so the reply the retry writes is never classified by
 * this pass. A census taken from the artifact's `rawOutput` is a census of whatever call came last, and 75
 * questions in that run had a retry.
 *
 * ## Why that is recorded here rather than fixed quietly
 *
 * A gate with no reach and a gate with no effect produce the same zero, and this campaign has now paid for that
 * lesson twice (`MEASURE-SUPERSEDE.md` §14.113.8's correction, and the three unwired ablation flags). The second
 * test states the limitation so that a later change which widens the reach has to change this file — and so that
 * no future reading can price the gate on a population it cannot see.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;
const OPEN_GATE = { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY };

/** The reply `5d3d2817` ended on in both runs: the evidence block, stamped, written back instead of an answer. */
const EVIDENCE_ECHO = [
  "1. [2023/05/25 (Thu) 03:32] The user's profile (Emeka) shows extensive experience in the pharmaceutical and",
  "2. [2023/05/25 (Thu) 03:32] Amy Scott is a Women's Health Specialist at Exact Sciences.",
].join('\n');

const QUESTION = 'What was my previous occupation?';
const CONTEXT = [
  '[2023/05/25 (Thu) 03:32] user: I work in pharma and biotech.',
  '[2023/05/25 (Thu) 03:32] user: My last role was a marketing specialist at a small startup.',
];

/** An LLM that answers the scripted replies in order and records what it was asked. */
function scripted(replies: readonly string[]): { llm: LLM; calls: string[] } {
  const calls: string[] = [];
  let at = 0;
  return {
    calls,
    llm: {
      complete: async (prompt: string) => {
        calls.push(prompt);
        const reply = replies[Math.min(at, replies.length - 1)] as string;
        at += 1;
        return reply;
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    } as unknown as LLM,
  };
}

function system(llm: LLM, options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
}

describe('the echo gate, one call deep', () => {
  it('re-asks a dump the first consultation wrote', async () => {
    const { llm, calls } = scripted([EVIDENCE_ECHO, 'Marketing specialist at a small startup']);
    const instance = system(llm, { replyRepair: 'echo' });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe(
      'Marketing specialist at a small startup',
    );
    expect(calls).toHaveLength(2);
    // The second prompt names what the reply did, which is the whole mechanism: the reader already has the
    // evidence, in the call it just answered.
    expect(calls[1]).toContain('copied the evidence above back');
    expect(instance.replyRepairCensus()?.echo).toEqual({
      attempted: 1,
      answered: 1,
      questions: [QUESTION],
    });
  });

  it('with `reviewBareDecline` on as well, a dump a retry wrote is out of reach', async () => {
    // The registered configuration. The first reply is the token, so the bare retry runs; the retry's reply is
    // the dump. `43121298653` is this shape at 14 questions, and its census read zero because the gate had
    // already been passed by the time the dump existed.
    const { llm, calls } = scripted([ABSTAIN_TOKEN, EVIDENCE_ECHO]);
    const instance = system(llm, { replyRepair: 'echo', reviewBareDecline: true });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe(EVIDENCE_ECHO);
    expect(calls).toHaveLength(2);
    expect(instance.replyRepairCensus()?.echo).toEqual({
      attempted: 0,
      answered: 0,
      questions: [],
    });
  });
});

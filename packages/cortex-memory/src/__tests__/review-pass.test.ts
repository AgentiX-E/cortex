/**
 * §13.94: the review pass — a second consultation that audits the list rather than the arithmetic.
 *
 * ## The measurement this file is written against
 *
 * §13.93's sweep is the evidence. An instruction that made the reader walk **all forty-four sessions**
 * (median 44 session lines, every record scanning) still produced a median of **two item-bearing
 * lines**, and the record `0a995998` shows what that looks like: the question asks about items to
 * *pick up or return from a store*, the window holds a blazer at the dry cleaner and two mentions of
 * boots, the response lists the two boots mentions, merges them, and answers `1`.
 *
 * So the deficit is not coverage and not arithmetic: it is **which items enter the list**. The
 * reference pipeline names the same thing and gives it a pass of its own — a critique that is shown
 * the first pass's ledger and the evidence, and is asked only about membership, never shown the first
 * pass's number.
 *
 * ## What this file pins
 *
 * The two calls, the text of the second one, the states where it must **not** run (no review
 * configured, a first pass that declined, an empty ledger), the answer that is returned, and the
 * report `lastReview()` gives so the mechanism is legible in a test rather than only in a document.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const USER_ONE = '[2023/02/15 (Wed) 03:14] user: I need to pick up a blazer from the dry cleaner.';
const USER_TWO = '[2023/02/15 (Wed) 04:00] user: I also have boots to pick up from Zara.';
const ASSISTANT = '[2023/02/15 (Wed) 03:15] assistant: Noted, two errands.';

/** Answers in order, and records every prompt it was given. */
function queueLlm(seen: string[], ...answers: string[]): LLM {
  let call = 0;
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      const answer = answers[Math.min(call, answers.length - 1)] ?? '';
      call += 1;
      return answer;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function system(options: Partial<CortexMemoryOptions>, llm: LLM): CortexMemory {
  return new CortexMemory({
    llm,
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ask: 'enumerated',
    ...options,
  });
}

const SESSIONS = [[USER_ONE, ASSISTANT], [USER_TWO]];

const FIRST = 'Step 1 —\n- boots from Zara (2023/02/15)\n\nStep 2 — 1';
const SECOND = 'Step 2 — 2';

describe('the review pass asks a second time, about membership', () => {
  it('consults the model twice and returns the second answer', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(2);
    expect(answer).toBe('2');
  });

  it('shows the second pass the first pass verbatim, and the evidence again', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const audit = seen[1]!;
    // The ledger is the subject of the review, so it has to be in front of the reviewer...
    expect(audit).toContain(FIRST);
    // ...and the evidence has to be there for the review to be about anything.
    expect(audit).toContain('dry cleaner');
    expect(audit).toContain('Zara');
    // Membership, stated as the three decisions a list can get wrong.
    expect(audit).toContain('missing from the first pass');
    expect(audit).toContain('same event');
    expect(audit).toContain('does not support');
  });

  it('asks for the number under the heading the parser reads', async () => {
    // §13.93.5: an ask that wants a list and then a number must make the second heading
    // compulsory, because the parser slices after the LAST `Step <n> —` heading and a bare
    // number under no heading leaves the whole list as the answer.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen[1]).toContain('`Step 2 —');
  });

  it('does not show the reviewer the first pass’s number as something to agree with', async () => {
    // The first pass's text contains `Step 2 — 1`, and it must be present as the ledger. What must
    // not happen is the review asking the model to "confirm" it: the instruction names membership
    // checks and says the count may change, which is the difference between a check and a rubber
    // stamp.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const audit = seen[1]!;
    expect(audit.toLowerCase()).not.toContain('confirm the count');
    expect(audit).toContain('corrected count');
  });
});

describe('the states in which the review must not run', () => {
  it('makes one call when no review was configured', async () => {
    const seen: string[] = [];
    const memory = system({}, queueLlm(seen, FIRST, SECOND));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(1);
    expect(answer).toBe('1');
  });

  it('makes one call when the review is named as `none`', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'none' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(1);
  });

  it('does not re-ask a first pass that declined', async () => {
    // An abstention is a decision, and re-asking it is a different experiment with its own
    // measured history. This pass audits a list; there is no list.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, 'INSUFFICIENT_EVIDENCE', SECOND));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(1);
    expect(answer).toBeNull();
  });

  it('is inert on every other route, byte for byte', async () => {
    // The pass belongs to the multi-session route because the failure does: a flat question answers
    // from one turn and there is no list to audit.
    const withReview: string[] = [];
    const without: string[] = [];
    await system({ reviewPass: 'audit' }, queueLlm(withReview, 'x', 'y')).answer('How many kits?', [
      USER_ONE,
    ]);
    await system({}, queueLlm(without, 'x')).answer('How many kits?', [USER_ONE]);

    expect(withReview).toHaveLength(1);
    expect(withReview[0]).toBe(without[0]);
  });
});

describe('what the run can say about the review afterwards', () => {
  it('reports the first answer, the final answer and whether they differ', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.lastReview()).toEqual({ first: '1', final: '2', changed: true });
  });

  it('reports no change when the audit agrees', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, 'Step 2 — 1'));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.lastReview()).toEqual({ first: '1', final: '1', changed: false });
  });

  it('reports nothing when the pass did not run', async () => {
    const seen: string[] = [];
    const memory = system({}, queueLlm(seen, FIRST));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.lastReview()).toBeNull();
  });

  it('records the offer from the prompt the answer came from', async () => {
    // `lastRetrievedContext` is what the reader was shown for the answer it gave. With two calls
    // that is the second prompt, and recording the first would describe a consultation whose
    // answer was discarded.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const carried = memory.lastRetrievedContext();
    expect(carried).not.toBeNull();
    expect(carried!.join('\n')).toContain('Zara');
  });
});

describe('the audit selects evidence the same way the first pass did', () => {
  it('spends the room by relevance when the run named a signal', async () => {
    // The audit rebuilds its prompt rather than appending, so its evidence has to be selected by the
    // same rule: a pass that re-selected by arrival order would review a different document from the
    // one the first answer came from, and the artifact could not show it.
    const seen: string[] = [];
    const memory = system(
      {
        reviewPass: 'audit',
        maxPromptChars: 900,
        relevanceFor: (_question: string, turn: string) => (turn.includes('blazer') ? 1 : 0.1),
        relevanceUnits: 'turn' as const,
      },
      queueLlm(seen, FIRST, SECOND),
    );

    await memory.answerSessions('How many errands do I have?', [[USER_ONE, ASSISTANT, USER_TWO]]);

    expect(seen[1]!.length).toBeLessThanOrEqual(900);
    // The evidence section is what the selection decided; the first pass quoted below it mentions the
    // turn that lost, so the assertion is on the section rather than on the whole prompt.
    const evidence = seen[1]!.slice(0, seen[1]!.indexOf('QUESTION:'));
    expect(evidence).toContain('blazer');
    // The lower-scoring turn loses its room to the higher-scoring one, which is the signal working
    // rather than the budget being ignored.
    expect(evidence).not.toContain('Zara');
  });
});

describe('the audit prompt stays inside the budget', () => {
  it('bounds the first pass it quotes', async () => {
    // The first pass is model output, so its length is not the product's to assume. A ledger of
    // forty-four session lines would otherwise eat the evidence room the audit needs.
    const longFirst =
      'Step 1 —\n' + Array.from({ length: 400 }, (_, i) => `- item ${i} (2023/02/15)`).join('\n');
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'audit', maxPromptChars: 4_000 },
      queueLlm(seen, longFirst, SECOND),
    );

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen[1]!.length).toBeLessThanOrEqual(4_000);
    // Truncated, not dropped: the review is useless without the ledger it is reviewing.
    expect(seen[1]).toContain('Step 1');
  });
});

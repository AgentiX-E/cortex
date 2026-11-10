/**
 * §13.363: the specification pass — a ledger built before the question, and a plan instead of a list.
 *
 * ## What the tests are written against
 *
 * The tally pass's own dispatch (`42855433242`) is the population's evidence: ten multi-session
 * losses, none of them arithmetic. So these tests pin the four properties that make the new pass a
 * different mechanism rather than a reworded one:
 *
 * 1. **One extra call, on a count-or-total question only.** The reach is `isTallyQuestion`'s
 *    intersection, unchanged, because a wider population would make the reading measure the route
 *    rather than the mechanism.
 * 2. **The prompt carries a table, not the window.** A pass that re-read the evidence would repeat
 *    the +98.4% completion-token cost that made the last one expensive.
 * 3. **A plan that cannot be executed leaves the first answer standing**, and is counted as a
 *    refusal rather than as a mechanism that agreed.
 * 4. **The census has an identity**: `specified = attempted - refused`, so a reader can derive the
 *    third number instead of trusting a fourth counter.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { questionKeywords } from '../aggregation/keywords.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const USER_ONE = '[2023/01/10 (Tue) 03:14] user: I sold the bike for $3,750 in January.';
const USER_TWO = '[2023/03/02 (Thu) 04:00] user: I sold a helmet for $120 in March.';
const ASSISTANT = '[2023/01/10 (Tue) 03:15] assistant: Two sales, then.';

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
const QUESTION = 'How much money did I make from sales in total?';
const FIRST = 'I sold the bike for $3,750 and a helmet for $120.';

const COUNT_PLAN = JSON.stringify({
  scope: [0, 2],
  predicates: [{ field: 'text', op: 'contains', value: 'sold' }],
  operation: 'count',
});

describe('the specification pass', () => {
  it('asks for a plan on a count-or-total question and answers from the plan', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, COUNT_PLAN));

    const answer = await memory.answerSessions(QUESTION, SESSIONS);

    expect(seen).toHaveLength(2);
    // Two turns say `sold`, and the product counted them -- the reader never stated a number.
    expect(answer).toBe('2');
  });

  it('carries a keyword table and no evidence, which is the cost difference from the tally pass', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, COUNT_PLAN));
    await memory.answerSessions(QUESTION, SESSIONS);

    const planPrompt = seen[1] as string;
    expect(planPrompt).toContain('| keyword | turns | with a number | sums |');
    // The turn's own words are not in the plan prompt: a table row replaces them.
    expect(planPrompt).not.toContain('I sold the bike for $3,750 in January.');
    // The table is a function of the question's words and the ledger, and it names the history it
    // summarises -- three turns in two sessions, from the first date to the last.
    expect(planPrompt).toContain('3 turns in 2 sessions, 2023/01/10 to 2023/03/02');
    for (const keyword of questionKeywords(QUESTION)) {
      expect(planPrompt).toContain(`| ${keyword} |`);
    }
    // The whole point of the pass is that it is smaller than the window it replaces.
    expect(planPrompt.length).toBeLessThan(seen[0]!.length + 2_000);
  });

  it('sums one unit when the plan names it', async () => {
    const seen: string[] = [];
    const plan = JSON.stringify({
      scope: [0, 2],
      predicates: [
        { field: 'text', op: 'contains', value: 'sold' },
        { field: 'number', op: 'unit-is', value: '$' },
      ],
      operation: 'sum',
    });
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, plan));
    const answer = await memory.answerSessions(QUESTION, SESSIONS);
    expect(answer).toBe('$3870');
  });

  it('keeps the first answer when the plan is prose', async () => {
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'spec' },
      queueLlm(seen, FIRST, 'I could not work out what to count.'),
    );
    const answer = await memory.answerSessions(QUESTION, SESSIONS);
    expect(answer).toBe(FIRST);
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0, refused: 1 });
  });

  it('keeps the first answer when the plan selects nothing', async () => {
    const seen: string[] = [];
    const plan = JSON.stringify({
      scope: [0, 2],
      predicates: [{ field: 'text', op: 'contains', value: 'no turn says this' }],
      operation: 'count',
    });
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, plan));
    expect(await memory.answerSessions(QUESTION, SESSIONS)).toBe(FIRST);
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0, refused: 1 });
  });

  it('keeps the first answer when the plan sums two different units', async () => {
    const seen: string[] = [];
    const plan = JSON.stringify({
      scope: [0, 2],
      predicates: [{ field: 'text', op: 'contains', value: 'sold' }],
      operation: 'sum',
    });
    // Two dollars and no other unit is a clean sum; add a turn that is selected by the same predicate
    // and states a different unit, and the plan has to be refused rather than rendered as one number.
    const sessions = [
      [
        USER_ONE,
        '[2023/01/11 (Wed) 03:14] user: I sold the manual, 440 pages, for the same price.',
      ],
      [USER_TWO],
    ];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, plan));
    const answer = await memory.answerSessions(QUESTION, sessions);
    expect(answer).toBe(FIRST);
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0, refused: 1 });
  });

  it('does not consult on a question whose answer is not a count', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, COUNT_PLAN));
    await memory.answerSessions('Which store did I spend the most money at?', SESSIONS);
    expect(seen).toHaveLength(1);
    expect(memory.auditCensus()).toEqual({ attempted: 0, changed: 0, refused: 0 });
  });

  it('does not consult after a decline', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, 'INSUFFICIENT_EVIDENCE'));
    const answer = await memory.answerSessions(QUESTION, SESSIONS);
    // Other passes may consult on a decline -- `reviewBareDecline` has its own reach -- so the claim is
    // that *this* pass did not, which is what its census counts.
    expect(seen.filter((prompt) => prompt.includes('ANSWER BY PLAN'))).toHaveLength(0);
    // A decline is `null` at this boundary, and the pass does not consult on one: there is no answer
    // to compute over, which is the audit pass's own rule.
    expect(answer).toBeNull();
    expect(memory.auditCensus()).toEqual({ attempted: 0, changed: 0, refused: 0 });
  });

  it('counts a change only when the computed answer differs from the first pass', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, '2', COUNT_PLAN));
    expect(await memory.answerSessions(QUESTION, SESSIONS)).toBe('2');
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0, refused: 0 });
  });

  it('reports no census at all for a pass that is not a specification', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'none' }, queueLlm(seen, FIRST));
    await memory.answerSessions(QUESTION, SESSIONS);
    expect(memory.auditCensus()).toBeNull();
  });

  it('agrees with itself over repeated identical runs', async () => {
    const run = async () => {
      const seen: string[] = [];
      const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, COUNT_PLAN));
      const answer = await memory.answerSessions(QUESTION, SESSIONS);
      return [answer, seen[1], JSON.stringify(memory.auditCensus())];
    };
    const first = await run();
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await run()).toEqual(first);
  });
});

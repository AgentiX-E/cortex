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

/**
 * The census with its authorization block, which every `spec` run now carries.
 *
 * Kept as one builder rather than pasted into six expectations because the six differ only in the three
 * numbers that predate the veto; a block of six identical literals is the shape that lets one of them drift
 * when a field is added, which is exactly how the `refused` field arrived.
 */
const NO_AUTHORIZATION = {
  evaluated: 0,
  authorized: 0,
  selected: 0,
  supportHits: 0,
  ledgerRows: 0,
  tokens: 0,
} as const;

const specCensus = (
  attempted: number,
  changed: number,
  refused: number,
  authorization: typeof NO_AUTHORIZATION | Record<string, number> = NO_AUTHORIZATION,
) => ({ attempted, changed, refused, authorization });

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
    expect(memory.auditCensus()).toEqual(specCensus(1, 0, 1));
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
    expect(memory.auditCensus()).toEqual(specCensus(1, 0, 1));
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
    expect(memory.auditCensus()).toEqual(specCensus(1, 0, 1));
  });

  it('does not consult on a question whose answer is not a count', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, COUNT_PLAN));
    await memory.answerSessions('Which store did I spend the most money at?', SESSIONS);
    expect(seen).toHaveLength(1);
    expect(memory.auditCensus()).toEqual(specCensus(0, 0, 0));
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
    expect(memory.auditCensus()).toEqual(specCensus(0, 0, 0));
  });

  it('counts a change only when the computed answer differs from the first pass', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, '2', COUNT_PLAN));
    expect(await memory.answerSessions(QUESTION, SESSIONS)).toBe('2');
    expect(memory.auditCensus()).toEqual(
      specCensus(1, 0, 0, {
        evaluated: 1,
        authorized: 0,
        selected: 2,
        supportHits: 0,
        ledgerRows: 3,
        tokens: 1,
      }),
    );
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

/**
 * §13.365: the authorization the veto will act on, recorded before the veto exists.
 *
 * The relation is *the first answer's own token is among the rows the plan selected*. What these tests pin
 * is not the veto's effect — nothing acts on the verdict yet — but the three properties that make the
 * recorded numbers worth reading later:
 *
 * 1. **The population is substitutions offered**, not consultations: a plan that refused is outside
 *    `evaluated`, so `evaluated + refused = attempted` keeps the identity the census already publishes.
 * 2. **A refusal is a decision, not a default.** An answer with no numeral is never authorized, because a
 *    word answer cannot be authorized by comparing numbers.
 * 3. **A free refusal.** Where the plan's value equals the first answer, refusing changes nothing — so the
 *    veto's damage is bounded by the substitutions that actually differ, which is the one bound `V2` needs.
 */
describe('the specification pass authorization', () => {
  it('authorizes a substitution whose selected rows carry the answer’s own numeral', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, COUNT_PLAN));

    await memory.answerSessions(QUESTION, SESSIONS);

    // `FIRST` names $3,750 and $120; the plan selected both rows that say `sold`, and each carries one of
    // those numbers, so the substitution is authorized twice over.
    expect(memory.auditCensus()).toEqual(
      specCensus(1, 1, 0, {
        evaluated: 1,
        authorized: 1,
        selected: 2,
        supportHits: 2,
        ledgerRows: 3,
        tokens: 2,
      }),
    );
  });

  it('refuses an answer whose numeral no selected row carries', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, 'about 500 dollars', COUNT_PLAN));

    await memory.answerSessions(QUESTION, SESSIONS);

    const census = memory.auditCensus();
    expect(census?.authorization).toMatchObject({
      evaluated: 1,
      authorized: 0,
      supportHits: 0,
      tokens: 1,
    });
  });

  it('never authorizes an answer with no numeral', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, 'a few of them', COUNT_PLAN));

    await memory.answerSessions(QUESTION, SESSIONS);

    // `tokens: 0` is the fact that explains a zero hit count: the veto could not run, which is a fact about
    // the answers rather than about the plans, and authorizing by default there would make the veto silent
    // exactly where it is least understood.
    expect(memory.auditCensus()?.authorization).toMatchObject({
      evaluated: 1,
      tokens: 0,
      supportHits: 0,
      authorized: 0,
    });
  });

  it('counts an unreadable plan as a refusal and not as an evaluated substitution', async () => {
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'spec' },
      queueLlm(seen, FIRST, 'I cannot write that plan.'),
    );

    await memory.answerSessions(QUESTION, SESSIONS);

    expect(memory.auditCensus()).toEqual(specCensus(1, 0, 1));
  });

  it('records nothing where the value it would refuse is the answer it was given', async () => {
    // The plan's count equals the first answer, so `changed` is zero and a refusal here would have been
    // free. That is the bound `V2` needs: the veto can only cost where a substitution actually differs.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, '2', COUNT_PLAN));

    await memory.answerSessions(QUESTION, SESSIONS);

    const census = memory.auditCensus();
    expect(census?.changed).toBe(0);
    expect(census?.authorization).toMatchObject({ evaluated: 1, authorized: 0 });
  });

  it('keeps supportHits <= selected <= ledgerRows on the recorded totals', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'spec' }, queueLlm(seen, FIRST, COUNT_PLAN));

    await memory.answerSessions(QUESTION, SESSIONS);

    const authorization = memory.auditCensus()?.authorization;
    if (authorization === undefined)
      throw new Error('the specification pass recorded no authorization');
    expect(authorization.supportHits).toBeLessThanOrEqual(authorization.selected);
    expect(authorization.selected).toBeLessThanOrEqual(authorization.ledgerRows);
  });

  it('does not report an authorization under the passes that have no plan', async () => {
    // The field is present or absent by pass rather than zeroed, for the reason §13.268 gives `auditCensus`:
    // a zero from a mechanism that cannot run reads exactly like a mechanism that ran and authorized none.
    const seen: string[] = [];
    const audit = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST));
    await audit.answerSessions(QUESTION, SESSIONS);
    expect(audit.auditCensus()).not.toHaveProperty('authorization');
  });
});

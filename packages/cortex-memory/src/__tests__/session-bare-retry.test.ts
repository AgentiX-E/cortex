/**
 * The bare-decline retry reaches the route it was written for, one increment late.
 *
 * ## The measurement this exists for
 *
 * `41188431321` (`ask: operand-gap`) ends **58 `MR` questions** on the bare token, and its census reads
 * `{attempted: 271, answered: 271}` — every attempt converted. Both numbers are true and they are about different
 * populations: `#answerWithBareRetry` is called from `#prompt` and `#promptWithDate` only, so the retry has never
 * run on the `multi-session` route, which is where `MR` is served. The 271 attempts are `flat`, `knowledge-update`,
 * `assistant` and `temporal`; the 58 bare finals are nobody's attempt.
 *
 * That was invisible for the whole campaign because the registered configuration's `MR` declines are **prose**
 * (7 of them on `41185512391`) and `isBareDecline` is false for prose. A vague instruction block changed the shape
 * of the decline rather than only its rate, and the mechanism built for that exact shape was not on that route.
 *
 * ## Why this is a fallback rather than a second ladder
 *
 * The session route already runs `reviewPass: 'recover'` in one mode — the pass that quotes the reader's own Step 1
 * list back to it. `types.ts` records why a second retry there was declined: two passes on one route make any
 * movement two variables. That reasoning holds and is kept: the bare retry fires **only when the recovery pass did
 * not**, which is the case it cannot help — no list, or the pass is off. In the registered `reviewPass: bare`
 * configuration the recovery pass is off entirely, which is why `MR` had neither.
 *
 * ## What is asserted
 *
 * The census, the number of consultations, the answer the caller receives, and that the retry prompt withholds the
 * token — the same four things `bare-decline-retry.test.ts` asserts for the two routes that always had it.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const SESSION = [
  ['I planted five tomato plants in May.', 'And three chili plants in June.'],
  ['I watered them every morning.'],
];

const QUESTION = 'How many plants did I plant in total?';

/** An LLM that returns the scripted replies in order, and records every prompt. */
function scripted(replies: readonly string[]): { llm: LLM; seen: string[] } {
  const seen: string[] = [];
  let at = 0;
  return {
    seen,
    llm: {
      complete: async (prompt: string) => {
        seen.push(prompt);
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

function memory(options: Partial<CortexMemoryOptions>, llm: LLM): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
}

describe('the bare retry on the multi-session route', () => {
  it('asks once more when the first reply was the token and nothing else', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, '8 plants']);
    const arm = memory({ reviewBareDecline: true }, llm);

    const answer = await arm.answerSessions(QUESTION, SESSION);

    expect(answer).toBe('8 plants');
    expect(seen).toHaveLength(2);
    expect(arm.bareRetryCensus()).toEqual({ attempted: 1, answered: 1 });
  });

  it('withholds the token from the retry, which is the mechanism and not a rhetorical preference', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, '8 plants']);
    const arm = memory({ reviewBareDecline: true }, llm);

    await arm.answerSessions(QUESTION, SESSION);

    // The first prompt offers the token (the route's own block names it) and the retry does not: a second copy of
    // the same instruction is advice, and `MEASURE-SOTA-FAILURES` §2 measured what advice is worth here.
    expect(seen[0]).toContain(ABSTAIN_TOKEN);
    expect(seen[1]).not.toContain(ABSTAIN_TOKEN);
    // The retry re-reads the same evidence, which is what makes it a correction rather than a second sample.
    expect(seen[1]).toContain('five tomato plants');
  });

  it('counts an attempt that declined again as an attempt and not as an answer', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, ABSTAIN_TOKEN]);
    const arm = memory({ reviewBareDecline: true }, llm);

    const answer = await arm.answerSessions(QUESTION, SESSION);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(2);
    expect(arm.bareRetryCensus()).toEqual({ attempted: 1, answered: 0 });
  });

  it('does nothing at all when the option is off, which is the shipped behaviour', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, '8 plants']);
    const arm = memory({}, llm);

    const answer = await arm.answerSessions(QUESTION, SESSION);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(arm.bareRetryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('leaves a prose decline alone, because that reply engaged with the question', async () => {
    const prose =
      'The evidence names tomatoes and chilies but never states a total, so I cannot add them up.';
    const { llm, seen } = scripted([prose, '8 plants']);
    const arm = memory({ reviewBareDecline: true }, llm);

    const answer = await arm.answerSessions(QUESTION, SESSION);

    // The prose stands as the answer: `parseAnswer` keeps a reply that says something, so this is not a decline at
    // all -- which is exactly why `isBareDecline` and not "parsed to null" is the retry's predicate. Both the call
    // count and the answer are asserted, because a retry that fired here would have replaced a reply with a
    // different one and the census would still read `{0, 0}` if only the census were checked.
    expect(answer).toBe(prose);
    expect(seen).toHaveLength(1);
    expect(arm.bareRetryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('does not retry a question that was answered', async () => {
    const { llm, seen } = scripted(['8 plants', '8 plants']);
    const arm = memory({ reviewBareDecline: true }, llm);

    const answer = await arm.answerSessions(QUESTION, SESSION);

    expect(answer).toBe('8 plants');
    expect(seen).toHaveLength(1);
    expect(arm.bareRetryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('is the fallback the recovery pass cannot be: a bare decline with no list to quote', async () => {
    // `reviewPass: 'recover'` quotes the reader's own Step 1 list back. A bare token carries no list, so that pass
    // returns `no-list` and does nothing — and the run whose block stops asking for a list is exactly the run that
    // produces this shape. Both modes are measured together here so the two mechanisms cannot silently overlap.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, '8 plants']);
    const arm = memory({ reviewBareDecline: true, reviewPass: 'recover' }, llm);

    const answer = await arm.answerSessions(QUESTION, SESSION);

    expect(answer).toBe('8 plants');
    expect(seen).toHaveLength(2);
    expect(arm.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
    expect(arm.bareRetryCensus()).toEqual({ attempted: 1, answered: 1 });
  });
});

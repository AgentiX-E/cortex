/**
 * The decline that named nothing gets one question back, and the token is not offered the second time.
 *
 * ## The measurement this exists for
 *
 * `docs/MEASURE-SOTA-FAILURES.md` §2 measures the 45 wrong declines on the shipped arm: **30 of them are a bare
 * `INSUFFICIENT_EVIDENCE`** with nothing around it, on routes whose ask already says *"a bare
 * `INSUFFICIENT_EVIDENCE` with no list is not a valid response"*. The instruction was stated 21 times and violated
 * 21 times, which makes it advice: the parser accepts the shape, so nothing happens when it is produced.
 *
 * The same document measures the control: `ABS` is the only capability whose gold is a decline, it reads 30/30, and
 * **29 of its 30 answers are that identical bare token**. So the shape is optimal exactly where it is graded.
 *
 * ## Why the retry withholds the token rather than asking harder
 *
 * A second copy of the same instruction is what `planAbstentionRecovery` already does, and it converts 1 of 10.
 * The difference here is not emphasis but affordance: the retry prompt **does not contain the abstention token at
 * all**, so "decline" stops being an available answer. That is the mechanical difference between advice and a
 * constraint, and it is the one thing this file asserts about the prompt's text.
 *
 * ## What is deliberately out of scope
 *
 * `multi-session` is untouched. It already runs `reviewPass: recover`, and adding a second retry to the same route
 * would make any movement there two variables rather than one. The 21 first-attempt bare declines are on `flat`
 * and `temporal`, so those two routes are the population this treatment is aimed at.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import { isBareDecline } from '../abstention-recovery.js';
import { buildRetryPrompt } from '../prompt.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const OPEN_GATE = { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY };

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

describe('isBareDecline', () => {
  it('is true for the token alone and for the token with nothing but whitespace', () => {
    expect(isBareDecline(ABSTAIN_TOKEN)).toBe(true);
    expect(isBareDecline(`  ${ABSTAIN_TOKEN}\n`)).toBe(true);
    expect(isBareDecline(`**${ABSTAIN_TOKEN}**`)).toBe(true);
  });

  it('is false when the reply reasoned first, even if it ended in the token', () => {
    // The distinction the treatment turns on. A reader that listed three things and then declined has produced
    // work the retry can build on; a reader that emitted the token has produced nothing, and asking it again is
    // the only move available.
    expect(
      isBareDecline(`- one event on 2023/05/20\n- another on 2023/05/21\n\n${ABSTAIN_TOKEN}`),
    ).toBe(false);
  });

  it('is false for an answer, and false for an empty reply', () => {
    expect(isBareDecline('Business Administration')).toBe(false);
    // Empty is not a bare decline: nothing was said, which is a different state and is handled by the empty path.
    expect(isBareDecline('')).toBe(false);
    expect(isBareDecline(null)).toBe(false);
  });
});

describe('the bare decline gets one question back, and only when the option is on', () => {
  const question = 'What degree did I graduate with?';
  const context = ['[2023/05/20] user: I graduated with a degree in Business Administration.'];

  it('changes nothing when the option is off, which is the shipped behaviour', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'Business Administration']);
    const answer = await memory({}, llm).answer(question, context);
    expect(answer).toBeNull();
    // One call. Every archived artifact was produced under this setting, so a second call here would make the
    // control incomparable with them.
    expect(seen).toHaveLength(1);
  });

  it('re-asks once and takes the answer when the option is on', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'Business Administration']);
    const system = memory({ reviewBareDecline: true }, llm);
    const answer = await system.answer(question, context);
    expect(answer).toBe('Business Administration');
    expect(seen).toHaveLength(2);
    expect(system.bareRetries()).toEqual({ attempted: 1, answered: 1 });
  });

  it('does not offer the abstention token in the second prompt', async () => {
    // The property that makes this a constraint rather than a stronger plea. If the token is still in the retry's
    // text, the retry is a second sample of the same question and the measurement is of patience, not of shape.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'Business Administration']);
    await memory({ reviewBareDecline: true }, llm).answer(question, context);
    const retry = seen[1] as string;
    expect(retry).not.toContain(ABSTAIN_TOKEN);
    // And it still carries the evidence and the question, because a retry that re-asked from nothing would be a
    // different question.
    expect(retry).toContain('Business Administration');
    expect(retry).toContain(question);
  });

  it('re-asks only when the first reply was bare, so a reasoned decline is left alone', async () => {
    const reasoned = `- one thing on 2023/05/20\n- another on 2023/05/21\n\n${ABSTAIN_TOKEN}`;
    const { llm, seen } = scripted([reasoned, 'Business Administration']);
    const system = memory({ reviewBareDecline: true }, llm);
    expect(await system.answer(question, context)).toBeNull();
    expect(seen).toHaveLength(1);
    expect(system.bareRetries()).toEqual({ attempted: 0, answered: 0 });
  });

  it('re-asks only when the first reply was a decline, so an answer is never re-asked', async () => {
    const { llm, seen } = scripted(['Business Administration', 'something else']);
    const system = memory({ reviewBareDecline: true }, llm);
    expect(await system.answer(question, context)).toBe('Business Administration');
    expect(seen).toHaveLength(1);
  });

  it('counts a retry that declined again, and keeps the decline', async () => {
    // The honest outcome for an evidence set that genuinely holds nothing. The counter is what separates "the
    // retry did not fire" from "the retry fired and changed nothing", which is the distinction §13.105's null
    // result lacked.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, ABSTAIN_TOKEN]);
    const system = memory({ reviewBareDecline: true }, llm);
    expect(await system.answer(question, context)).toBeNull();
    expect(seen).toHaveLength(2);
    expect(system.bareRetries()).toEqual({ attempted: 1, answered: 0 });
  });

  it('leaves the abstention route alone, where a bare decline is the right answer', async () => {
    // `ABS`'s gold *is* a decline and its 29-of-30 bare tokens are the capability passing. A treatment that
    // reached this route would spend a call to convert a correct answer into a wrong one.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'Business Administration']);
    const system = memory({ reviewBareDecline: true }, llm);
    expect(await system.answerAbstention(question, context)).toBeNull();
    expect(seen).toHaveLength(1);
    expect(system.bareRetries()).toEqual({ attempted: 0, answered: 0 });
  });
});

describe('buildRetryPrompt, which the retry sends', () => {
  const turn = {
    id: 't1',
    content: '[2023/05/20] user: I graduated with a degree in Business Administration.',
    value: 0.5,
    confidence: 1,
    source: 'unknown' as const,
    sourceTrust: 0.5,
    type: 'episodic' as const,
    tags: [],
    createdAt: NOW,
    lastAccessedAt: NOW,
    stability: 1,
    difficulty: 5,
    ordinal: 0,
  };

  it('honours the sourced rendering, so a run that asks for sources gets them on the retry too', () => {
    // The rendering is a property of the run, not of the first call. A retry that silently fell back to the plain
    // rendering would change two things at once — the instruction and the evidence presentation — and the run would
    // be measuring the pair rather than the treatment.
    const prompt = buildRetryPrompt('What degree did I graduate with?', [turn], {
      rendering: 'sourced',
    });
    expect(prompt).toContain('[t1]');
    expect(prompt).toContain('Business Administration');
  });

  it('says so explicitly when it has no evidence, rather than emitting an empty block', () => {
    // Unreachable from `#answerWithBareRetry` (which declines before spending a call on an empty window) and
    // reachable by any caller that builds the prompt directly, which is what the export is for.
    const prompt = buildRetryPrompt('What degree did I graduate with?', []);
    expect(prompt).toContain('EVIDENCE:');
    expect(prompt).not.toMatch(/EVIDENCE:\s*\n\s*\n\s*QUESTION/);
    expect(prompt).toContain('What degree did I graduate with?');
  });
});

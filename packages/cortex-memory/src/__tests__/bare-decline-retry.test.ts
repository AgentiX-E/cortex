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
    expect(system.bareRetryCensus()).toEqual({ attempted: 1, answered: 1 });
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
    expect(system.bareRetryCensus()).toEqual({ attempted: 0, answered: 0 });
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
    expect(system.bareRetryCensus()).toEqual({ attempted: 1, answered: 0 });
  });

  it('leaves the abstention route alone, where a bare decline is the right answer', async () => {
    // `ABS`'s gold *is* a decline and its 29-of-30 bare tokens are the capability passing. A treatment that
    // reached this route would spend a call to convert a correct answer into a wrong one.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'Business Administration']);
    const system = memory({ reviewBareDecline: true }, llm);
    expect(await system.answerAbstention(question, context)).toBeNull();
    expect(seen).toHaveLength(1);
    expect(system.bareRetryCensus()).toEqual({ attempted: 0, answered: 0 });
  });
});

describe('the retry re-sends the window the first pass carried, and nothing it dropped', () => {
  /**
   * The retry's own contract, taken literally: *"The evidence and the question are rendered exactly as the first
   * pass rendered them, so the only difference between the two calls is the instruction."*
   *
   * The route admits a window and `buildPrompt` spends a budget on it, so "the evidence the first pass rendered"
   * is `AssembledPrompt.carried` -- the turns that reached the reader -- and not the window the route admitted.
   * The two are the same object whenever the prompt fits, which is why the difference was invisible: the defect
   * only exists on the questions where the budget binds, and those are the expensive ones.
   *
   * Two consequences, and both are measured here rather than argued:
   *
   *  - **The retry can be larger than the first pass.** `fitToBudget` cuts the window to the ceiling; a retry
   *    built from the uncut window is not "the same evidence", it is more evidence than the first call was
   *    allowed, and it is the one call in the pipeline with no ceiling on it at all.
   *  - **It shares no prefix with the first prompt**, so a provider's prefix cache -- which keys on the leading
   *    bytes of the request -- cannot serve any of it. Re-sending the carried set makes the retry prompt a
   *    prefix-extension of the first, which is the difference between paying for the window twice and paying
   *    for the instruction twice.
   */
  const question = 'What did I do on the two days I was in Lisbon?';
  const lines = [
    '[2023/05/20] user: I flew to Lisbon on Saturday and stayed near the river.',
    '[2023/05/20] assistant: That neighbourhood is walkable to most of the old town.',
    '[2023/05/21] user: On Sunday I walked to the castle and then took a tram to Belem.',
    '[2023/05/21] assistant: The tram is the fastest way to get out there.',
    '[2023/05/22] user: I came back on Monday morning and went straight to the office.',
    '[2023/05/22] assistant: That is a short flight at least.',
    '[2023/05/23] user: I still have the pastries I bought at the airport.',
    '[2023/05/23] assistant: They keep for a couple of days.',
  ];
  /** Small enough that `fitToBudget` keeps only a prefix of eight lines, and it is asserted, not assumed. */
  const BUDGET = 520;

  it('drops from the retry exactly what the first prompt dropped, and keeps what it kept', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'I walked to the castle.']);
    await memory({ reviewBareDecline: true, maxPromptChars: BUDGET }, llm).answer(question, lines);
    const [first, retry] = seen as [string, string];

    const carried = lines.filter((line) => first.includes(line));
    const dropped = lines.filter((line) => !first.includes(line));
    // The fixture has to bind, or this test measures a prompt that fits and proves nothing.
    expect(dropped.length).toBeGreaterThan(0);
    expect(carried.length).toBeGreaterThan(0);

    for (const line of dropped) {
      expect(retry).not.toContain(line);
    }
    for (const line of carried) {
      expect(retry).toContain(line);
    }
  });

  it('re-sends an evidence block that is a byte prefix of the first prompt', async () => {
    // The cost property, stated as the text a provider sees. The profile is chosen because `fitToBudget`
    // clips the window at a character boundary, so the first prompt can end mid-turn: what the retry
    // re-sends is the head of that string and nothing else, which is the largest share of the first pass
    // any retry could reuse. Built from the admitted window instead, this block would be *longer* than the
    // first prompt's and no provider could serve a byte of it.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'I walked to the castle.']);
    await memory({ reviewBareDecline: true, maxPromptChars: BUDGET }, llm).answer(question, lines);
    const [first, retry] = seen as [string, string];
    const boundary = retry.indexOf('\n\nQUESTION: ');
    expect(boundary).toBeGreaterThan(0);
    const retryEvidence = retry.slice(0, boundary);
    expect(first.startsWith(retryEvidence)).toBe(true);
  });

  it('does not exceed the evidence the first pass printed, even though its instruction is longer', async () => {
    // The retry's instruction block is longer than the contract's and it is not the evidence's budget to
    // spend, so the comparison that means anything is on the evidence: the retry must never carry more of
    // the window than the call it corrects. Built from `kept` it carried the whole window -- a 1,024
    // character prompt against a 520-character first pass on this fixture -- and the excess was all
    // evidence. The second assertion pins the reason a total-length comparison would be the wrong test.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'I walked to the castle.']);
    await memory({ reviewBareDecline: true, maxPromptChars: BUDGET }, llm).answer(question, lines);
    const [first, retry] = seen as [string, string];
    const evidenceOf = (prompt: string): string =>
      prompt.slice(0, prompt.indexOf('\n\nQUESTION: '));
    const instructionOf = (prompt: string): string =>
      prompt.slice(prompt.indexOf('\n\nQUESTION: '));
    expect(evidenceOf(retry).length).toBeLessThan(evidenceOf(first).length);
    expect(instructionOf(retry).length).toBeGreaterThan(instructionOf(first).length);
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

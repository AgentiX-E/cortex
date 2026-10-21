/**
 * §13.101: three consultations of one prompt, and a strict majority.
 *
 * ## The measurement this file is written against
 *
 * §13.100.2 ran the adopting configuration twice. Twenty-four of 121 multi-session answers changed,
 * fifty-nine of five hundred states changed dataset-wide, and every prompt window reproduced to the
 * character. The reader's judgement is the unstable part, so this mechanism samples that judgement
 * instead of trying to talk it out of being unstable -- which three prompt-side attempts already
 * failed to do.
 *
 * ## What this file pins
 *
 * The vote's arithmetic on its own (including the abstention-as-candidate rule and the refusal of a
 * plurality), the three-consultation route with the prompt held byte-identical, the retained text
 * coming from the sample that was answered from rather than the last one, the counts the artifact
 * reads, and the three constructor refusals that keep an unmeasurable configuration unrepresentable.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { voteAnswers } from '../parse.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const USER_ONE = '[2023/02/15 (Wed) 03:14] user: I need to pick up a blazer from the dry cleaner.';
const ASSISTANT = '[2023/02/15 (Wed) 03:15] assistant: Noted.';
const USER_TWO = '[2023/02/15 (Wed) 04:00] user: I also have boots to pick up from Zara.';

const SESSIONS = [[USER_ONE, ASSISTANT], [USER_TWO]];

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

describe('voteAnswers', () => {
  it('reports three identical samples as unanimous', () => {
    const vote = voteAnswers(['2', '2', '2']);
    expect(vote.chosen).toBe('2');
    expect(vote.agreement).toBe(1);
    expect(vote.unanimous).toBe(true);
    expect(vote.split).toBe(false);
  });

  it('takes the strict majority of three', () => {
    const vote = voteAnswers(['2', '3', '2']);
    expect(vote.chosen).toBe('2');
    expect(vote.agreement).toBeCloseTo(2 / 3, 10);
    expect(vote.unanimous).toBe(false);
    expect(vote.split).toBe(false);
  });

  it('treats an abstention as a candidate, not as a missing vote', () => {
    // Two declines against one wrong answer: the evidence cannot answer the question, and the
    // mechanism has to be able to say so. Excluding null would turn this into the wrong answer.
    const vote = voteAnswers([null, null, '5']);
    expect(vote.chosen).toBeNull();
    expect(vote.unanimous).toBe(false);
    expect(vote.split).toBe(false);
  });

  it('falls back to the first pass when all three differ', () => {
    const vote = voteAnswers(['2', '3', '4']);
    expect(vote.chosen).toBe('2');
    expect(vote.agreement).toBeCloseTo(1 / 3, 10);
    expect(vote.split).toBe(true);
    expect(vote.unanimous).toBe(false);
  });

  it('refuses a plurality that is not a majority', () => {
    // 2 of 5 is the most any answer holds, and it is not a majority. The rule is fixed at strict
    // majority rather than "most votes" so the mechanism does not change shape with the sample
    // count -- a reading across counts would not be comparable otherwise.
    const vote = voteAnswers(['2', '2', '3', '4', '5']);
    expect(vote.chosen).toBe('2');
    expect(vote.split).toBe(true);
  });

  it('does not let a later answer win a tie', () => {
    // Three samples never tie for the majority, but the fallback must be the FIRST pass rather
    // than whichever answer happened to be counted last.
    expect(voteAnswers(['4', '2', '3']).chosen).toBe('4');
  });
});

describe('the multi-session route votes', () => {
  it('consults three times with a byte-identical prompt and returns the majority', async () => {
    const seen: string[] = [];
    const memory = system(
      { selfConsistency: 3 },
      queueLlm(seen, 'Step 2 — 2', 'Step 2 — 2', 'Step 2 — 3'),
    );

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(3);
    // The design is that the prompt does not move between samples; a prompt that differed would
    // confound the sample count with the wording.
    expect(new Set(seen).size).toBe(1);
    expect(answer).toBe('2');
  });

  it('retains the text of the sample it answered from', async () => {
    const seen: string[] = [];
    const memory = system(
      { selfConsistency: 3 },
      queueLlm(seen, 'Step 2 — 3', 'Step 2 — 2', 'Step 2 — 2'),
    );

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(answer).toBe('2');
    // The answer came from the second sample, so the retained text must be the second sample's:
    // a reader comparing `answer` against `rawOutput` has to be reading one response.
    expect(memory.lastRawOutput()).toBe('Step 2 — 2');
  });

  it('reports how the vote resolved, per question and in aggregate', async () => {
    const seen: string[] = [];
    const memory = system(
      { selfConsistency: 3 },
      queueLlm(seen, 'Step 2 — 2', 'Step 2 — 2', 'Step 2 — 3'),
    );

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const vote = memory.lastVote();
    expect(vote).toEqual({ chosen: '2', agreement: 2 / 3, unanimous: false, split: false });
    expect(memory.voteCounts()).toEqual({ unanimous: 0, majority: 1, split: 0 });
  });

  it('counts a unanimous vote separately from a majority', async () => {
    // The endpoint is not deterministic (§13.100.2), so a unanimous vote is a fact about the
    // question rather than about the mechanism -- and a run of nothing but unanimous votes would
    // mean the treatment never fired.
    const seen: string[] = [];
    const memory = system({ selfConsistency: 3 }, queueLlm(seen, 'Step 2 — 2'));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.voteCounts()).toEqual({ unanimous: 1, majority: 0, split: 0 });
  });

  it('counts a split separately from a majority', async () => {
    const seen: string[] = [];
    const memory = system(
      { selfConsistency: 3 },
      queueLlm(seen, 'Step 2 — 2', 'Step 2 — 3', 'Step 2 — 4'),
    );

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.lastVote()).toEqual({
      chosen: '2',
      agreement: 1 / 3,
      unanimous: false,
      split: true,
    });
    expect(memory.voteCounts()).toEqual({ unanimous: 0, majority: 0, split: 1 });
  });

  it('consults once when the option is absent, and reports no vote', async () => {
    const seen: string[] = [];
    const memory = system({}, queueLlm(seen, 'Step 2 — 2'));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(1);
    expect(answer).toBe('2');
    expect(memory.lastVote()).toBeNull();
    expect(memory.voteCounts()).toEqual({ unanimous: 0, majority: 0, split: 0 });
  });

  it('does not reach the flat route', async () => {
    // The treatment lives in the multi-session path, so a flat question consults once whatever the
    // count says. That is what makes the four untouched capabilities an internal control.
    const seen: string[] = [];
    const memory = system({ selfConsistency: 3 }, queueLlm(seen, 'Lisbon'));

    await memory.answer('Where did I go?', [USER_ONE]);

    expect(seen).toHaveLength(1);
    expect(memory.voteCounts()).toEqual({ unanimous: 0, majority: 0, split: 0 });
  });
});

describe('the option is refused rather than clamped', () => {
  it('rejects a count below one', () => {
    expect(() => system({ selfConsistency: 0 }, queueLlm([], ''))).toThrow(/positive integer/);
  });

  it('rejects a fractional count', () => {
    expect(() => system({ selfConsistency: 2.5 }, queueLlm([], ''))).toThrow(/positive integer/);
  });

  it('rejects the audit pass beside it', () => {
    // Six consultations per question is a configuration nobody has measured, and a run of it could
    // not attribute its reading to either pass.
    expect(() => system({ selfConsistency: 3, reviewPass: 'audit' }, queueLlm([], ''))).toThrow(
      /cannot both be on/,
    );
  });
});

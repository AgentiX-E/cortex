/**
 * The anchored window: which characters of a long turn the cap keeps.
 *
 * The claim is one sentence -- *at the same cap, choose the window around the question instead of the head*
 * -- and every test here is a way it could be false while the prompt still assembles: the field could be
 * inert (the head comes back), it could act without the question (an arbitrary window), it could exceed the
 * cap (overrunning a room the artifact says was respected), or it could reach one builder and not the other
 * (a route answering at a width the configuration line says it bounded).
 *
 * The byte-equality test is the important one, and it is written the way `prompt-turn-cap.test.ts` writes
 * the same claim: the absent field must reproduce every archived prompt exactly, because the artefact of a
 * prior dispatch is only readable if today's code can rebuild it.
 */
import { describe, expect, it } from 'vitest';

import type { LLM } from '@agentix-e/cortex-core';

import type { AdmittedTurn } from '../admission.js';
import { ELISION } from '../excerpt.js';
import { CortexMemory } from '../memory.js';
import { buildPrompt, buildSessionPrompt } from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';
import type { CortexMemoryOptions } from '../types.js';

const CAP = 160;

/** A turn whose head is filler and whose fact sits well past the cap. */
const HEAD_FILLER =
  'The user talked about the weather, the traffic and a film they had seen. '.repeat(6);
const FACT = 'On the last Tuesday of the month they booked the pottery class in Kendal.';
const TAIL_FILLER =
  ' Afterwards they went home and made dinner and read for a while before bed. '.repeat(4);
const LONG = `${HEAD_FILLER}${FACT}${TAIL_FILLER}`;
const QUESTION = 'When did they book the pottery class?';

/** The first evidence block of a prompt, without its index. */
function blockOf(prompt: string): string {
  const evidence = prompt.slice(prompt.indexOf('EVIDENCE:') + 'EVIDENCE:\n'.length);
  return (evidence.split('\n\n')[0] as string).replace(/^1\. /, '');
}

function turn(content: string, index = 0): AdmittedTurn {
  return { index, content, id: `t${index}` } as unknown as AdmittedTurn;
}

function session(index: number, turns: readonly AdmittedTurn[]): AdmittedSession {
  return { index, turns: [...turns], size: turns.length } as unknown as AdmittedSession;
}

describe('the anchored turn window', () => {
  it('is inert when absent: the prompt is byte-identical to the head cut', () => {
    const absent = buildPrompt(QUESTION, [turn(LONG)], 'abstention', { maxTurnChars: CAP }).prompt;
    const head = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'head',
    }).prompt;
    expect(head).toBe(absent);
  });

  it('keeps the fact and drops the filler, where the head cut keeps the filler', () => {
    const headPrompt = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
    }).prompt;
    const matched = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    }).prompt;

    // The block, not the whole prompt: the question is printed below the evidence and it names the
    // fact, so a `not.toContain` over the prompt would fail on the question rather than on the head.
    expect(blockOf(headPrompt)).not.toContain('pottery');
    expect(blockOf(matched)).toContain('pottery class');
    expect(blockOf(matched)).toContain(ELISION);
  });

  it('spends the same number of characters, so the room arithmetic does not move', () => {
    const headPrompt = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
    }).prompt;
    const matched = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    }).prompt;

    const headBlock = blockOf(headPrompt);
    const matchedBlock = blockOf(matched);
    expect(headBlock.length).toBe(CAP);
    expect(matchedBlock.length).toBeLessThanOrEqual(CAP);
    // At least nine tenths of the cap: the window is not a budget cut wearing a window's name, which is
    // what a much shorter block would mean. It is not exactly the cap because both edges snap inward to
    // a word boundary, and that snap is worth a few characters -- a window that began mid-word would read
    // as a typo rather than as an excerpt.
    expect(matchedBlock.length).toBeGreaterThanOrEqual(Math.floor(CAP * 0.9));
  });

  it('leaves a turn under the cap byte-identical', () => {
    const short = turn(FACT);
    const matched = buildPrompt(QUESTION, [short], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    }).prompt;
    const plain = buildPrompt(QUESTION, [short], 'abstention').prompt;
    expect(matched).toBe(plain);
  });

  it('is inert without a cap, because the window is a way of spending one', () => {
    const plain = buildPrompt(QUESTION, [turn(LONG)], 'abstention').prompt;
    const windowed = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      turnWindow: 'match',
    }).prompt;
    expect(windowed).toBe(plain);
  });

  it('reaches the multi-session builder, which is where the cap costs the most', () => {
    const sessions = [
      session(0, [turn(LONG, 0)]),
      session(1, [turn(`${HEAD_FILLER}They also mentioned a trip to Lisbon.`, 1)]),
    ];
    const matched = buildSessionPrompt(QUESTION, sessions, {
      maxTurnChars: CAP,
      turnWindow: 'match',
    }).prompt;
    expect(matched).toContain('pottery class');
    expect(matched).toContain('Session 2');
  });

  it('reaches the sourced rendering, which is the other way a block is printed', () => {
    const matched = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
      rendering: 'sourced',
    }).prompt;
    expect(matched).toContain('pottery class');
    expect(matched).toContain('[t0]');
  });

  it('is deterministic: the same question and the same turn render the same prompt', () => {
    const once = buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    }).prompt;
    for (let round = 0; round < 3; round += 1) {
      expect(
        buildPrompt(QUESTION, [turn(LONG)], 'abstention', {
          maxTurnChars: CAP,
          turnWindow: 'match',
        }).prompt,
      ).toBe(once);
    }
  });

  it('falls back to a marked head when the question shares nothing with the turn', () => {
    const matched = buildPrompt('How many marathons did they run?', [turn(LONG)], 'abstention', {
      maxTurnChars: CAP,
      turnWindow: 'match',
    }).prompt;
    expect(matched).toContain(ELISION);
    expect(matched).toContain('The user talked about the weather');
    expect(matched).not.toContain('pottery');
  });
});

/**
 * The window without the cap, which is the one configuration the constructor refuses.
 *
 * `match` is a rule about *how a cap is spent*. With no cap there is nothing to spend, every turn renders
 * whole, and the window is a field the run reports and the prompt never consults -- the inert-option defect
 * this campaign has now caught four times, in the one place it can be refused rather than measured.
 */
describe('the window needs the cap it spends', () => {
  function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
    return new CortexMemory({
      now: 1_759_470_000_000,
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: () => 1,
      },
      ...options,
    });
  }

  const unusedLlm: LLM = {
    complete: async () => 'unused',
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };

  it('is refused without a cap, because it would name a treatment the run never administered', () => {
    expect(() => system({ llm: unusedLlm, turnWindow: 'match' })).toThrow(
      /turnWindow: 'match' needs maxTurnChars/,
    );
  });

  it('accepts the head without a cap, because that is what an absent field renders anyway', () => {
    expect(() => system({ llm: unusedLlm, turnWindow: 'head' })).not.toThrow();
  });

  it('accepts the match window beside a cap, which is the pair it describes', () => {
    expect(() => system({ llm: unusedLlm, turnWindow: 'match', maxTurnChars: CAP })).not.toThrow();
  });

  it('reaches the model through the system, so the field is not inert on the answering path', async () => {
    // The §7.4 side-channel defect the marker test documents for `turnCutMarker`: a field the arm can set,
    // the constructor accepts, the artifact records, and `#promptOptions` never forwards. The check is on
    // the prompt the reader actually received, not on the options object.
    const seen: string[] = [];
    const memory = system({
      llm: {
        complete: async (prompt: string) => {
          seen.push(prompt);
          return 'Kendal';
        },
        completeStructured: async () => {
          throw new Error('unused by this package');
        },
      },
      maxTurnChars: CAP,
      turnWindow: 'match',
    });

    await memory.answer(QUESTION, [LONG]);

    const block = blockOf(seen[0] as string);
    expect(block).toContain('pottery class');
    expect(block).toContain(ELISION);
    expect(block).not.toContain('the weather');
    // The record is still the turn as it arrived: the window is presentation.
    expect(memory.lastRetrievedContext()?.[0]).toBe(LONG);
  });
});

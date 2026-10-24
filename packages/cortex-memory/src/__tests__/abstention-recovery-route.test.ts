/**
 * The decline that contradicts its own list gets one corrective consultation.
 *
 * ## What is asserted, and why it is the call log rather than the return value
 *
 * The treatment is "one more model call, of a population that is currently always wrong". A test
 * that only read the returned answer would pass for a system that re-asked every question, and a
 * test that only read the census would pass for one that recorded a retry it never made. So each
 * test pins the return value, the prompt log and the census against each other: the number of calls
 * says whether the pass fired, the prompt says what it asked, and the census has to agree with both.
 *
 * The control matters as much as the treatment. `off` is the shipped behaviour, and every archived
 * artifact was produced under it, so the first test is that turning the pass off changes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
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
    },
  };
}

function system(llm: LLM, options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
}

/** Two sessions, enough text to survive admission. */
function sessions(): string[][] {
  return [
    ['[2023/05/20 (Sat) 20:05] user: I got a peace lily from the nursery two weeks ago.'],
    ['[2023/05/25 (Thu) 16:59] user: I got a snake plant from my sister last month.'],
  ];
}

/** What a model writes when it lists items and then declines: the state the pass exists for. */
const LISTED_DECLINE = [
  'Step 1:',
  '- [2023/05/20] A peace lily from the nursery, two weeks before the statement',
  '- [2023/05/25] A snake plant from my sister, stated as last month',
  '',
  'Step 2:',
  'The list is incomplete because the acquisition dates do not line up, so a count cannot be given.',
  '',
  ABSTAIN_TOKEN,
].join('\n');

/** What a model writes when the evidence genuinely answers nothing. */
const HONEST_DECLINE = [
  'Step 1 — items matching the question:',
  '- No item in the evidence states how many plants were acquired in the last month.',
  '',
  'Step 2:',
  'The list is empty.',
  '',
  ABSTAIN_TOKEN,
].join('\n');

const QUESTION = 'How many plants did I acquire in the last month?';

describe('abstention recovery', () => {
  it('does nothing when the pass is off, which is the shipped configuration', async () => {
    const { llm, seen } = scripted([LISTED_DECLINE, '2']);
    const memory = system(llm);
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('re-asks once with the list when the decline contradicts it, and uses the answer', async () => {
    const { llm, seen } = scripted([LISTED_DECLINE, '2']);
    const memory = system(llm, { reviewPass: 'recover' });
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBe('2');
    expect(seen).toHaveLength(2);
    // The prompt is the list and the question, and it carries no evidence block: re-sending the
    // window would make this a second sample rather than a correction of the first.
    expect(seen[1]).toContain('ITEMS YOU LISTED:');
    expect(seen[1]).toContain('A peace lily from the nursery');
    expect(seen[1]).not.toContain('EVIDENCE:');
    expect(memory.recoveryCensus()).toEqual({ attempted: 1, answered: 1 });
  });

  it('leaves an honest decline alone, because an empty list is the licensed state', async () => {
    const { llm, seen } = scripted([HONEST_DECLINE, 'Answer: 2']);
    const memory = system(llm, { reviewPass: 'recover' });
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('does not re-ask an answer that happens to carry a list', async () => {
    // The guard that `answered` exists for, and the only fixture that can express it: a model that
    // writes the list *and* answers. Hardcoding the flag to `false` left the previous test green,
    // because a bare answer has no bullets to find -- so the test above pins the cheap half and
    // this one pins the half that protects a correct answer from being re-asked.
    const listedAnswer = [
      'Step 1:',
      '- [2023/05/20] A peace lily from the nursery',
      '- [2023/05/25] A snake plant from my sister',
      '',
      'Step 2:',
      '2',
    ].join('\n');
    const { llm, seen } = scripted([listedAnswer, 'wrong']);
    const memory = system(llm, { reviewPass: 'recover' });
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBe('2');
    expect(seen).toHaveLength(1);
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('never consults a question that answered, so no answer can move', async () => {
    const { llm, seen } = scripted(['3']);
    const memory = system(llm, { reviewPass: 'recover' });
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBe('3');
    expect(seen).toHaveLength(1);
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('counts an attempt that declined again, and returns the decline', async () => {
    // The second decline is honest -- one item about a book with no discount in it -- so the pass
    // must not force a number. It is counted as attempted and not answered, which is the reading
    // that says the pass fired and converted nothing.
    const { llm, seen } = scripted([LISTED_DECLINE, HONEST_DECLINE]);
    const memory = system(llm, { reviewPass: 'recover' });
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBeNull();
    expect(seen).toHaveLength(2);
    expect(memory.recoveryCensus()).toEqual({ attempted: 1, answered: 0 });
  });

  it('records the evidence the list came from, so the question is not one answered from nothing', async () => {
    const { llm } = scripted([LISTED_DECLINE, '2']);
    const memory = system(llm, { reviewPass: 'recover' });
    await memory.answerSessions(QUESTION, sessions());

    // Without this the record would show an answered question carrying no context, which is the
    // defect `lastRetrievedContext` exists to make impossible (run 38142407062).
    expect(memory.lastRetrievedContext()?.length ?? 0).toBeGreaterThan(0);
  });

  it('leaves the abstention census counting one outcome for the question, not two', async () => {
    // `abstentionReasons` counts questions (a retry that recorded twice made the denominator
    // disagree with `questionCount x runs` once already). A recovered question answered, so it is
    // one `answered` and no `llm`.
    const { llm } = scripted([LISTED_DECLINE, '2']);
    const memory = system(llm, { reviewPass: 'recover' });
    await memory.answerSessions(QUESTION, sessions());

    expect(memory.abstentionReasons()).toEqual({ empty: 0, threshold: 0, llm: 0, answered: 1 });
  });
});

/** Kept so the value function import is used the way the sibling tests use it. */
const _unused: ValueFunction = () => 0;
void _unused;

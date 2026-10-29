/**
 * Two retries, two populations, one configuration — and the counters that keep them apart.
 *
 * ## Why this file exists next to `abstention-recovery-route.test.ts`
 *
 * That file asserts each pass in isolation. This one asserts the thing the **arm** now relies on when
 * it maps one dispatch field to both options: that the two ladders can be on at once without a
 * question ever receiving two consultations for one decline, and that a run carrying both can say
 * which one fired.
 *
 * The mapping it pins is `review_pass=recover` ⇒ `{reviewPass: 'recover', reviewBareDecline: true}`
 * (`bench-memory-arm.ts`'s `carriesBareLadder`). Before that mapping existed, `recover` turned the
 * bare ladder **off** — so the dispatch §13.128 registers would have measured a withdrawal on
 * `flat`/`temporal`/`assistant`/`knowledge-update` alongside the addition on `multi-session`, and the
 * artifact would have shown one field changing.
 *
 * ## What is measured rather than argued
 *
 * Each case asserts the call log and both censuses together. A call-count assertion alone would pass
 * for a system that fired the wrong pass; a census assertion alone would pass for one that recorded a
 * retry it never made. The pair is what makes "exactly one consultation, of the right kind" a
 * statement a test can hold.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

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

/** The configuration `review_pass=recover` now produces, spelled the way the arm spells it. */
const RECOVER_AND_BARE: Partial<CortexMemoryOptions> = {
  reviewPass: 'recover',
  reviewBareDecline: true,
};

function sessions(): string[][] {
  return [
    ['[2023/05/20 (Sat) 20:05] user: I got a peace lily from the nursery two weeks ago.'],
    ['[2023/05/25 (Thu) 16:59] user: I got a snake plant from my sister last month.'],
  ];
}

/** A flat context: one session's turns, offered without boundaries. */
function flatContext(): string[] {
  return ['[2023/05/20 (Sat) 20:05] user: I got a peace lily from the nursery two weeks ago.'];
}

const QUESTION = 'How many plants did I acquire in the last month?';

/** What a model writes when it lists items and then declines: the state `recover` exists for. */
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

describe('the two retry ladders under one configuration', () => {
  it('re-asks a flat bare decline, counted as a bare retry and not as a recovery', async () => {
    const { llm, seen } = scripted([ABSTAIN_TOKEN, '2']);
    const memory = system(llm, RECOVER_AND_BARE);
    const answer = await memory.answer(QUESTION, flatContext());

    expect(answer).toBe('2');
    expect(seen).toHaveLength(2);
    expect(memory.bareRetryCensus()).toEqual({ attempted: 1, answered: 1 });
    // The half that would have been lost under the old mapping. A recovery count here would mean
    // the multi-session pass had reached a route it is not wired into.
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('re-asks a listed multi-session decline, counted as a recovery and not as a bare retry', async () => {
    const { llm, seen } = scripted([LISTED_DECLINE, '2']);
    const memory = system(llm, RECOVER_AND_BARE);
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBe('2');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('ITEMS YOU LISTED:');
    expect(memory.recoveryCensus()).toEqual({ attempted: 1, answered: 1 });
    expect(memory.bareRetryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('administers exactly one consultation per decline, on either route', async () => {
    // Disjointness, measured rather than asserted from the call graph: two declines on two routes,
    // in one system instance, produce exactly two consultations -- not three and not four.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, '2', LISTED_DECLINE, '3']);
    const memory = system(llm, RECOVER_AND_BARE);
    await memory.answer(QUESTION, flatContext());
    await memory.answerSessions(QUESTION, sessions());

    expect(seen).toHaveLength(4);
    expect(memory.bareRetryCensus()).toEqual({ attempted: 1, answered: 1 });
    expect(memory.recoveryCensus()).toEqual({ attempted: 1, answered: 1 });
  });

  it('leaves the multi-session decline unrecovered when only the bare ladder is on', async () => {
    // The configuration every archived artifact was produced under (`review_pass=bare`), kept as a
    // test because it is the state §13.128 assumed was already covered. It is not: the recovery pass
    // is off, and `recover` is the only name that carries it.
    // `bare` is an arm-level name rather than a member of the product's `ReviewPass`: the arm maps it
    // to "no review pass" plus the bare ladder, which is what `run-ablation.ts` forwards.
    const { llm, seen } = scripted([LISTED_DECLINE, '2']);
    const memory = system(llm, { reviewBareDecline: true });
    const answer = await memory.answerSessions(QUESTION, sessions());

    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(memory.recoveryCensus()).toEqual({ attempted: 0, answered: 0 });
  });

  it('leaves a flat bare decline unanswered when only the recovery pass is on', async () => {
    // The mirror case, and the reason the arm-level union is not cosmetic: with `reviewPass` naming
    // the pass and the bare ladder derived from it, this is exactly what a dispatch of `recover` used
    // to produce -- a `flat` decline that is never re-asked.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, '2']);
    const memory = system(llm, { reviewPass: 'recover', reviewBareDecline: false });
    const answer = await memory.answer(QUESTION, flatContext());

    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(memory.bareRetryCensus()).toEqual({ attempted: 0, answered: 0 });
  });
});

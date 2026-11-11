/**
 * §13.366: the supersession pass, through the product.
 *
 * ## What is being pinned
 *
 * The adjudicator's own tests say what a report means. These say what the **pass** does, and there are four
 * properties the campaign has learned to require of a second consultation before it is worth dispatching:
 *
 * 1. **Reach is one route.** `knowledge-update` and nothing else, so the other four capabilities answer from
 *    byte-identical prompts. Both of the last two passes had to add a reach audit after the fact because
 *    their prompt changed on questions they did not claim to treat.
 * 2. **The second call re-reads the same evidence.** The first prompt's evidence block has to be a byte
 *    prefix of the second's, or the reading is of a different window and not of a different instruction.
 * 3. **A claim the evidence does not support leaves the first answer standing**, and is counted by name.
 * 4. **The census has an identity**: `attempted = replaced + refused`, recomputable from the artifact.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { buildSupersedePrompt } from '../prompt.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const EARLY = '[2023/01/10 (Tue) 03:14] user: My follower count is 1250 and I am happy with it.';
const MENTION = '[2023/02/11 (Sat) 09:02] assistant: That is a good number of followers.';
const LATE = '[2023/03/12 (Sun) 11:40] user: Small update, I crossed 1300 followers last week.';

const SESSIONS = [[EARLY, MENTION, LATE]];
const QUESTION = 'How many followers do I have now?';

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

const AUTHORIZED = 'CHANGED: yes\nLATER: 1300\nWHEN: 2023/03/12 (Sun) 11:40';
const FABRICATED = 'CHANGED: yes\nLATER: 1400\nWHEN: 2023/03/12 (Sun) 11:40';
const UNDATED = 'CHANGED: yes\nLATER: 1300\nWHEN: 2023/04/01 (Sat) 00:00';
const NOTHING = 'CHANGED: no\nLATER: NONE\nWHEN: NONE';

describe('the supersession pass', () => {
  it('substitutes a later value the evidence supports', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, '1250', AUTHORIZED));

    const answer = await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    expect(seen).toHaveLength(2);
    expect(answer).toBe('1300');
    expect(memory.supersessionCensus()).toMatchObject({ attempted: 1, replaced: 1, refused: 0 });
  });

  it('re-reads the evidence the first pass read, so the two calls differ only in instruction', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, '1250', AUTHORIZED));

    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    const [first, second] = seen as [string, string];
    const firstEvidence = first.slice(0, first.indexOf('\n\nQUESTION:'));
    expect(second.startsWith(firstEvidence)).toBe(true);
  });

  it('does not offer the abstention token on the second call', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, '1250', AUTHORIZED));

    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    // Declining is not among the answers a comparison can give, and a prompt that offered it would spend the
    // call on a reply the adjudicator has to classify as unreadable.
    expect(seen[1]).not.toContain('INSUFFICIENT_EVIDENCE');
  });

  it('refuses a value the evidence does not contain, and keeps the first answer', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, '1250', FABRICATED));

    const answer = await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    expect(answer).toBe('1250');
    expect(memory.supersessionCensus()).toMatchObject({
      attempted: 1,
      replaced: 0,
      refused: 1,
      refusals: { 'not-in-evidence': 1 },
    });
  });

  it('refuses a real value carrying a date its record does not have', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, '1250', UNDATED));

    const answer = await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    expect(answer).toBe('1250');
    expect(memory.supersessionCensus()).toMatchObject({
      refused: 1,
      refusals: { 'date-not-on-line': 1 },
    });
  });

  it('takes a reader that found nothing at its word', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, '1250', NOTHING));

    const answer = await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    expect(answer).toBe('1250');
    expect(memory.supersessionCensus()).toMatchObject({
      refused: 1,
      refusals: { 'no-change': 1 },
    });
  });

  it('counts an unreadable reply separately, rather than as a no', async () => {
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'supersede' },
      queueLlm(seen, '1250', 'I think it is Friday.'),
    );

    const answer = await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    expect(answer).toBe('1250');
    expect(memory.supersessionCensus()).toMatchObject({ refusals: { unreadable: 1 } });
  });

  it('reads a second pass that declines as unreadable, not as a no', async () => {
    // The prompt does not offer the abstention token, but a reader that was told to abstain by a stronger
    // instruction can still produce it. The parsed answer is then `null` and the raw text is the token; the
    // report is read off the raw text, so the reply lands in `unreadable` rather than becoming a silent
    // agreement with the first pass.
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'supersede' },
      queueLlm(seen, '1250', 'INSUFFICIENT_EVIDENCE'),
    );

    const answer = await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    expect(answer).toBe('1250');
    expect(memory.supersessionCensus()).toMatchObject({ refusals: { unreadable: 1 } });
  });

  it('does not fire when the first pass declined, because there is no value to supersede', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, 'INSUFFICIENT_EVIDENCE'));

    const answer = await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    // This is the population's seventh stable failure (`0977f2af`) — "absent, not superseded". It is out of
    // reach by construction and the census says so by not counting it at all.
    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(memory.supersessionCensus()).toMatchObject({ attempted: 0, replaced: 0, refused: 0 });
  });

  it('does not reach a route that is not the knowledge-update route', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'supersede' }, queueLlm(seen, '1250', AUTHORIZED));

    await memory.answerTemporal(QUESTION, SESSIONS.flat());

    expect(seen).toHaveLength(1);
    expect(memory.supersessionCensus()).toMatchObject({ attempted: 0 });
  });

  it('reports no census at all when the build does not carry the pass', async () => {
    const memory = system({}, queueLlm([], '1250', AUTHORIZED));

    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    // `null` rather than zeros, for the reason `auditCensus` answers `null`: a build that never carried the
    // mechanism must not be readable as one that carried it and superseded nothing.
    expect(memory.supersessionCensus()).toBeNull();
  });

  it('records the pair it compared, so "the pass disagreed" is legible', async () => {
    const memory = system({ reviewPass: 'supersede' }, queueLlm([], '1250', AUTHORIZED));

    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    expect(memory.lastReview()).toEqual({ first: '1250', final: '1300', changed: true });
  });

  it('holds the census identity across a mixed run', async () => {
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'supersede' },
      queueLlm(seen, '1250', AUTHORIZED, '1250', FABRICATED, '1250', NOTHING),
    );

    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);
    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);
    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);

    const census = memory.supersessionCensus();
    expect(census).not.toBeNull();
    const observed = census as NonNullable<typeof census>;
    // The identity the artifact is checked against, recomputed rather than trusted.
    expect(observed.attempted).toBe(observed.replaced + observed.refused);
    expect(observed.refused).toBe(
      Object.values(observed.refusals).reduce((sum, count) => sum + count, 0),
    );
    expect(observed.replaced).toBe(1);
  });

  it('hands out a copy, so a caller cannot move the numbers a later reader sees', async () => {
    const memory = system({ reviewPass: 'supersede' }, queueLlm([], '1250', AUTHORIZED));

    await memory.answerKnowledgeUpdate(QUESTION, SESSIONS.flat(), SESSIONS);
    const first = memory.supersessionCensus() as { refusals: Record<string, number> };
    first.refusals['agrees'] = 99;

    expect(memory.supersessionCensus()).toMatchObject({ refusals: { agrees: 0 } });
  });
});

describe('the prompt builder', () => {
  it('names the no-evidence placeholder rather than printing an empty block', async () => {
    // The block is never empty through the product -- `#admit` declines first -- but the builder is a public
    // function and an empty `EVIDENCE:` followed by nothing is the shape a model reads as "no evidence" only
    // by inference. The placeholder says it.
    const { prompt, evidence } = buildSupersedePrompt('How many?', '1250', []);

    // Asserted on the shape rather than on an exported constant: the placeholder is `prompt.ts`'s own string
    // and every other corrective builder spells it the same way, so a test that pinned the literal would have
    // to be edited in two places for a wording change that is not a behaviour change.
    expect(evidence).toMatch(/no evidence was admitted for this question/);
    expect(prompt).toContain(`EVIDENCE:\n${evidence}`);
  });

  it('carries the first answer verbatim, which is the only reason the comparison is possible', async () => {
    const turns = [EARLY, LATE].map((text) => ({
      content: text,
      session: 0,
      role: 'user' as const,
    }));
    const { prompt } = buildSupersedePrompt('How many followers?', '1250 followers', turns);

    expect(prompt).toContain('1250 followers');
    expect(prompt).toContain('CHANGED: yes');
    expect(prompt).toContain('LATER:');
    expect(prompt).toContain('WHEN:');
  });
});

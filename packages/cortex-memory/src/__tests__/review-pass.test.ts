/**
 * §13.94: the review pass — a second consultation that audits the list rather than the arithmetic.
 *
 * ## The measurement this file is written against
 *
 * §13.93's sweep is the evidence. An instruction that made the reader walk **all forty-four sessions**
 * (median 44 session lines, every record scanning) still produced a median of **two item-bearing
 * lines**, and the record `0a995998` shows what that looks like: the question asks about items to
 * *pick up or return from a store*, the window holds a blazer at the dry cleaner and two mentions of
 * boots, the response lists the two boots mentions, merges them, and answers `1`.
 *
 * So the deficit is not coverage and not arithmetic: it is **which items enter the list**. The
 * reference pipeline names the same thing and gives it a pass of its own — a critique that is shown
 * the first pass's ledger and the evidence, and is asked only about membership, never shown the first
 * pass's number.
 *
 * ## What this file pins
 *
 * The two calls, the text of the second one, the states where it must **not** run (no review
 * configured, a first pass that declined, an empty ledger), the answer that is returned, and the
 * report `lastReview()` gives so the mechanism is legible in a test rather than only in a document.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const USER_ONE = '[2023/02/15 (Wed) 03:14] user: I need to pick up a blazer from the dry cleaner.';
const USER_TWO = '[2023/02/15 (Wed) 04:00] user: I also have boots to pick up from Zara.';
const ASSISTANT = '[2023/02/15 (Wed) 03:15] assistant: Noted, two errands.';

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

const FIRST = 'Step 1 —\n- boots from Zara (2023/02/15)\n\nStep 2 — 1';
const SECOND = 'Step 2 — 2';

describe('the review pass asks a second time, about membership', () => {
  it('consults the model twice and returns the second answer', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(2);
    expect(answer).toBe('2');
  });

  it('shows the second pass the first pass verbatim, and the evidence again', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const audit = seen[1]!;
    // The ledger is the subject of the review, so it has to be in front of the reviewer...
    expect(audit).toContain(FIRST);
    // ...and the evidence has to be there for the review to be about anything.
    expect(audit).toContain('dry cleaner');
    expect(audit).toContain('Zara');
    // Membership, stated as the three decisions a list can get wrong.
    expect(audit).toContain('missing from the first pass');
    expect(audit).toContain('same event');
    expect(audit).toContain('does not support');
  });

  it('asks for the number under the heading the parser reads', async () => {
    // §13.93.5: an ask that wants a list and then a number must make the second heading
    // compulsory, because the parser slices after the LAST `Step <n> —` heading and a bare
    // number under no heading leaves the whole list as the answer.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen[1]).toContain('`Step 2 —');
  });

  it('does not show the reviewer the first pass’s number as something to agree with', async () => {
    // The first pass's text contains `Step 2 — 1`, and it must be present as the ledger. What must
    // not happen is the review asking the model to "confirm" it: the instruction names membership
    // checks and says the count may change, which is the difference between a check and a rubber
    // stamp.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const audit = seen[1]!;
    expect(audit.toLowerCase()).not.toContain('confirm the count');
    // The answer may change, and it may also stay: the clause that lets a reviewer agree is the one that
    // stops "a review happened" from becoming "a review disagreed" (§13.262).
    expect(audit).toContain('corrected answer');
    expect(audit).toContain('word for word');
  });
});

describe('the states in which the review must not run', () => {
  it('makes one call when no review was configured', async () => {
    const seen: string[] = [];
    const memory = system({}, queueLlm(seen, FIRST, SECOND));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(1);
    expect(answer).toBe('1');
  });

  it('makes one call when the review is named as `none`', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'none' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(1);
  });

  it('does not re-ask a first pass that declined', async () => {
    // An abstention is a decision, and re-asking it is a different experiment with its own
    // measured history. This pass audits a list; there is no list.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, 'INSUFFICIENT_EVIDENCE', SECOND));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen).toHaveLength(1);
    expect(answer).toBeNull();
  });

  it('is inert on every other route, byte for byte', async () => {
    // The pass belongs to the multi-session route because the failure does: a flat question answers
    // from one turn and there is no list to audit.
    const withReview: string[] = [];
    const without: string[] = [];
    await system({ reviewPass: 'audit' }, queueLlm(withReview, 'x', 'y')).answer('How many kits?', [
      USER_ONE,
    ]);
    await system({}, queueLlm(without, 'x')).answer('How many kits?', [USER_ONE]);

    expect(withReview).toHaveLength(1);
    expect(withReview[0]).toBe(without[0]);
  });
});

describe('what the run can say about the review afterwards', () => {
  it('reports the first answer, the final answer and whether they differ', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.lastReview()).toEqual({ first: '1', final: '2', changed: true });
  });

  it('reports no change when the audit agrees', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, 'Step 2 — 1'));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.lastReview()).toEqual({ first: '1', final: '1', changed: false });
  });

  it('reports nothing when the pass did not run', async () => {
    const seen: string[] = [];
    const memory = system({}, queueLlm(seen, FIRST));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.lastReview()).toBeNull();
  });

  it('records the offer from the prompt the answer came from', async () => {
    // `lastRetrievedContext` is what the reader was shown for the answer it gave. With two calls
    // that is the second prompt, and recording the first would describe a consultation whose
    // answer was discarded.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const carried = memory.lastRetrievedContext();
    expect(carried).not.toBeNull();
    expect(carried!.join('\n')).toContain('Zara');
  });
});

describe('the audit selects evidence the same way the first pass did', () => {
  it('spends the room by relevance when the run named a signal', async () => {
    // The audit rebuilds its prompt rather than appending, so its evidence has to be selected by the
    // same rule: a pass that re-selected by arrival order would review a different document from the
    // one the first answer came from, and the artifact could not show it.
    const seen: string[] = [];
    const memory = system(
      {
        reviewPass: 'audit',
        // §13.262: the audit's instruction grew by the form clause, and the instruction and the evidence
        // compete for the same room -- which is the property this test is about, not the number 900. The
        // budget is raised so that the higher-scoring turn still fits; the assertion below is the order the
        // selection settled on, and it is unchanged.
        maxPromptChars: 1_300,
        relevanceFor: (_question: string, turn: string) => (turn.includes('blazer') ? 1 : 0.1),
        relevanceUnits: 'turn' as const,
      },
      queueLlm(seen, FIRST, SECOND),
    );

    await memory.answerSessions('How many errands do I have?', [[USER_ONE, ASSISTANT, USER_TWO]]);

    expect(seen[1]!.length).toBeLessThanOrEqual(1_300);
    // The evidence section is what the selection decided; the first pass quoted below it mentions the
    // turn that lost, so the assertion is on the section rather than on the whole prompt.
    const evidence = seen[1]!.slice(0, seen[1]!.indexOf('QUESTION:'));
    expect(evidence).toContain('blazer');
    // The lower-scoring turn loses its room to the higher-scoring one, which is the signal working
    // rather than the budget being ignored.
    expect(evidence).not.toContain('Zara');
  });
});

describe('the audit prompt stays inside the budget', () => {
  it('bounds the first pass it quotes', async () => {
    // The first pass is model output, so its length is not the product's to assume. A ledger of
    // forty-four session lines would otherwise eat the evidence room the audit needs.
    const longFirst =
      'Step 1 —\n' + Array.from({ length: 400 }, (_, i) => `- item ${i} (2023/02/15)`).join('\n');
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'audit', maxPromptChars: 4_000 },
      queueLlm(seen, longFirst, SECOND),
    );

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(seen[1]!.length).toBeLessThanOrEqual(4_000);
    // Truncated, not dropped: the review is useless without the ledger it is reviewing.
    expect(seen[1]).toContain('Step 1');
  });
});

describe('the census the artifact reads', () => {
  it('counts a consultation and the answer it moved', async () => {
    // §13.260. Without this the pass could run on five hundred questions and the artifact would have
    // nothing to say about it, which is the shape `lastReview()` already had: a producer field with no
    // reader anywhere in the harness.
    const memory = system({ reviewPass: 'audit' }, queueLlm([], FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 1 });
  });

  it('counts a consultation that agreed, which is the state a single tally would hide', async () => {
    const memory = system({ reviewPass: 'audit' }, queueLlm([], FIRST, FIRST));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    // The answer is unchanged, so an "answered" counter would have reported 1 here and said nothing
    // about whether the review disagreed with anything.
    expect(answer).toBe('1');
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0 });
  });

  it('stays at zero when the run carries no audit, so absence is a fact about the build', async () => {
    const memory = system({}, queueLlm([], FIRST));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    // Zeroed rather than absent on the product side, because the product always carries the accessor;
    // the artifact omits the field, and that omission is what says "this build has no audit".
    expect(memory.auditCensus()).toEqual({ attempted: 0, changed: 0 });
  });

  it('does not count a decline, because there is no list to audit', async () => {
    const memory = system({ reviewPass: 'audit' }, queueLlm([], 'INSUFFICIENT_EVIDENCE'));

    const answer = await memory.answerSessions('How many errands do I have?', SESSIONS);

    expect(answer).toBeNull();
    expect(memory.auditCensus()).toEqual({ attempted: 0, changed: 0 });
  });

  it('accumulates across questions rather than reporting the last one', async () => {
    const memory = system({ reviewPass: 'audit' }, queueLlm([], FIRST, SECOND, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);
    await memory.answerSessions('How many stops on the way home?', SESSIONS);

    expect(memory.auditCensus()).toEqual({ attempted: 2, changed: 2 });
  });
});

describe('what the audit does not change', () => {
  it('leaves the delivery prompt describing retrieval, not the review', async () => {
    // §13.262. `42054107910` published `promptChars` +530 and a changed `promptDigest` on 117 of the 118
    // questions the audit touched, while the whole prompt moved by a median of two characters -- so the
    // artifact said "the delivered bytes changed" for a mechanism that changed no delivered byte. The
    // digest is the instrument every attribution in this campaign keys on, so a consultation overwriting
    // it is not a cosmetic defect: it makes a mechanism look like a retrieval change.
    const memory = system({ reviewPass: 'audit' }, queueLlm([], FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const prompt = memory.lastPromptText() ?? '';
    expect(prompt).not.toBe('');
    // The audit's own instruction, and the thing that would be in a prompt the review built.
    expect(prompt).not.toContain('FIRST PASS:');
    expect(prompt).not.toContain('Review that response for MEMBERSHIP only');
  });

  it('still takes the coverage numbers from the call the answer came from', async () => {
    // The other half of the same split: `carried` and `admittedEvidence` answer "what was the reader shown
    // when it produced this answer", and with an audit that is the second consultation. Both fields are read
    // by the arm's coverage counts and by `goldOverlap`, which would be about discarded evidence if they came
    // from the first pass.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    // The second consultation is the one that produced the answer, so it is the one whose context is kept.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('FIRST PASS:');
    expect(memory.lastRetrievedContext()?.length).toBeGreaterThan(0);
  });
});

describe('the audit instruction and the form of the answer', () => {
  it('asks for the answer back in the form the first pass used, not for a count', async () => {
    // §13.262. The instruction said "write one line, exactly `Step 2 — <the corrected count>`", and the
    // multi-session route is not only counting questions: 40 of `MR`'s 121 golds are counts, and the pass
    // runs on all of them. `42054107910` is the measurement -- 22 correct answers destroyed and **every one
    // of them** came back as a bare integer, 17 of them on questions whose gold was a name, a price, a date
    // or a list (`TikTok` → `2`, `$6` → `2`, `photography and cooking` → `2`). The instruction did that,
    // not the reader.
    const seen: string[] = [];
    const memory = system({ reviewPass: 'audit' }, queueLlm(seen, FIRST, SECOND));

    await memory.answerSessions('How many errands do I have?', SESSIONS);

    const audit = seen[1] ?? '';
    expect(audit).not.toContain('the corrected count');
    expect(audit).toContain("in the first pass's form");
    expect(audit).toContain('a count stays a count');
    // The clause that makes a review able to say "nothing changed" instead of inventing a difference:
    // 178 of 469 consultations moved the answer, and a reviewer with no way to agree has to disagree.
    expect(audit).toContain('word for word');
  });

  it('round-trips a non-count answer the review restated in the same form', async () => {
    // The contract the instruction now states, exercised end to end: a first pass that named a shop and a
    // review that found the membership right must return the shop, not the number of things in it.
    const memory = system(
      { reviewPass: 'audit' },
      queueLlm([], 'Thrive Market', 'Step 2 — Thrive Market'),
    );

    const answer = await memory.answerSessions('Which store did I buy the oats from?', SESSIONS);

    expect(answer).toBe('Thrive Market');
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0 });
  });
});

/**
 * §13.362: the tally pass — the arithmetic the audit is instructed not to perform.
 *
 * ## The measurement these tests are written against
 *
 * On run `42533236864`, **102 of the 121 multi-session questions ask for a count or a total and 18 of
 * the capability's 20 failures are inside that 102** — 82.4% there against 19 of 19 on the questions
 * that ask for something else. Every failure carries its gold turns (`goldOverlap` 0.966 against
 * 0.988 on the correct ones), so nothing here is retrieval. The misses are off-by-one counts
 * (`2` for 3, `5` for 4, `22` for 23), wrong sums (`$8,750` for `$3,750`), and `37f165cf`, which lists
 * "440 pages" and "416 pages" and answers **"440 pages and 416 pages"** against a gold of 856.
 *
 * So the file pins two different things: the reader of a tagged ledger (which must refuse rather than
 * sum a partial one), and the route (second call on a count question, no second call anywhere else,
 * and the first pass's answer kept when the ledger cannot be read).
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';
import {
  classifyAnswerRequest,
  isTallyQuestion,
  parseTallyLedger,
  renderTally,
  tallyTotal,
} from '../tally.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const USER_ONE = '[2023/01/10 (Tue) 03:14] user: I finished the novel at 440 pages in January.';
const USER_TWO = '[2023/03/02 (Thu) 04:00] user: I finished the other one at 416 pages in March.';
const ASSISTANT = '[2023/01/10 (Tue) 03:15] assistant: Two books, then.';

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

const FIRST = [
  'Step 1 — items that match:',
  '- The Nightingale, 440 pages, 2023/01/10',
  '- the 416-page novel, 2023/03/02',
  '',
  'Step 2 — 440 pages and 416 pages',
].join('\n');

describe('classifyAnswerRequest', () => {
  it('reads a count and a total apart from everything else', () => {
    expect(classifyAnswerRequest('How many projects have I led?')).toBe('count');
    expect(classifyAnswerRequest('What is the total amount I earned?')).toBe('total');
    expect(classifyAnswerRequest('Which grocery store did I spend the most money at?')).toBe(
      'other',
    );
  });

  it('reads a money question as a total even when it says how much', () => {
    // The multi-session population is full of "how much money" questions whose gold is a sum; a
    // classifier keyed on `how many` alone would send them all to the audit pass's old behaviour,
    // which is no arithmetic at all.
    expect(classifyAnswerRequest('How much money did I raise for charity in total?')).toBe('total');
    expect(classifyAnswerRequest('How much did I spend on workshops?')).toBe('total');
    // A count stated as a noun, which is how `37f165cf` asks it: "what was the **page count**".
    expect(classifyAnswerRequest('What was the page count of the two novels?')).toBe('total');
  });

  it('does not read how many as a count when the question is a derivation', () => {
    // The request and the shape are two questions, and this is why both are asked: "how many years
    // older am I" is a `count` request and a `derivation` shape, and summing its operands answers an
    // age. `isTallyQuestion` is the intersection.
    expect(classifyAnswerRequest('How many years older am I than when I graduated?')).toBe('count');
    expect(isTallyQuestion('How many years older am I than when I graduated?')).toBe(false);
  });
});

describe('isTallyQuestion', () => {
  it('admits an enumeration that asks for a count', () => {
    expect(isTallyQuestion('How many times did I bake something in the past two weeks?')).toBe(
      true,
    );
  });

  it('refuses a maximum, which has nothing to sum', () => {
    expect(isTallyQuestion('Which store did I spend the most money at?')).toBe(false);
  });

  it('refuses a question whose answer is a name', () => {
    expect(isTallyQuestion('What is the name of the bakery I liked?')).toBe(false);
  });
});

describe('parseTallyLedger', () => {
  it('reads a bullet ledger and keeps each contribution', () => {
    const ledger = parseTallyLedger('- The Nightingale — 440\n- the 416-page novel — 416');
    expect(ledger).toEqual({
      kind: 'ledger',
      entries: [
        { text: 'The Nightingale', contribution: 440 },
        { text: 'the 416-page novel', contribution: 416 },
      ],
    });
  });

  it('reads an ordinal list and a bare trailing tag with no separator', () => {
    const ledger = parseTallyLedger('1. first run 1\n2. second run 1');
    expect(ledger.kind).toBe('ledger');
    expect(ledger.kind === 'ledger' && tallyTotal(ledger.entries)).toBe(2);
  });

  it('reads a thousands separator as one number', () => {
    const ledger = parseTallyLedger('- the video — 1,998');
    expect(ledger.kind === 'ledger' && tallyTotal(ledger.entries)).toBe(1998);
  });

  it('does not read a date inside the item as a contribution', () => {
    // The trap this rule exists for: `2023/05/22` and `Session 3` are numbers in the item's own text,
    // and a parser that took the last number wherever it appeared would sum them.
    const ledger = parseTallyLedger('- boots from Zara (2023/02/15, Session 3) — 1');
    expect(ledger.kind === 'ledger' && tallyTotal(ledger.entries)).toBe(1);
  });

  it('refuses the whole ledger when one line carries no tag', () => {
    // A partial sum is not a partial answer: on `37f165cf` the two operands are 440 and 416, and
    // dropping the line that failed to parse would answer 440 against a gold of 856.
    const ledger = parseTallyLedger('- The Nightingale — 440\n- the 416-page novel');
    expect(ledger).toEqual({ kind: 'refused', reason: 'untagged-entry' });
  });

  it('refuses a response that wrote prose instead of lines', () => {
    expect(parseTallyLedger('The two novels total 856 pages.')).toEqual({
      kind: 'refused',
      reason: 'no-entries',
    });
  });

  it('refuses an empty response', () => {
    expect(parseTallyLedger('')).toEqual({ kind: 'refused', reason: 'no-entries' });
  });

  it('keeps a zero, because the line count is part of the answer', () => {
    const ledger = parseTallyLedger('- a boot I did not pick up — 0\n- a blazer — 1');
    expect(ledger.kind === 'ledger' && ledger.entries).toHaveLength(2);
    expect(ledger.kind === 'ledger' && tallyTotal(ledger.entries)).toBe(1);
  });
});

describe('tallyTotal and renderTally', () => {
  it('sums the contributions', () => {
    expect(
      tallyTotal([
        { text: 'a', contribution: 440 },
        { text: 'b', contribution: 416 },
      ]),
    ).toBe(856);
  });

  it('rounds the representation error out of a decimal sum', () => {
    expect(
      tallyTotal([
        { text: 'a', contribution: 0.1 },
        { text: 'b', contribution: 0.2 },
      ]),
    ).toBe(0.3);
  });

  it('writes the answer as a bare number, without a separator', () => {
    // `1,998` and `1998` are the same number to a judge, and the second is what a machine states.
    expect(renderTally(1998)).toBe('1998');
  });
});

describe('the tally pass on the route', () => {
  it('consults twice and answers with the sum of the tags, not with the first pass', async () => {
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'tally' },
      queueLlm(seen, FIRST, '- The Nightingale — 440\n- the 416-page novel — 416'),
    );

    const answer = await memory.answerSessions(
      'What was the page count of the two novels I finished in January and March?',
      SESSIONS,
    );

    expect(seen).toHaveLength(2);
    expect(answer).toBe('856');
  });

  it('shows the second pass the first response verbatim and asks for tags, not for a total', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'tally' }, queueLlm(seen, FIRST, '- a — 1'));

    await memory.answerSessions('How many novels did I finish?', SESSIONS);

    const tally = seen[1]!;
    expect(tally).toContain(FIRST);
    expect(tally).toContain('January');
    expect(tally).toContain('do not compute anything');
    // The tag shape has to be stated, because `parseTallyLedger` refuses a line without one.
    expect(tally).toContain('end the line with the single bare');
  });

  it('keeps the first pass answer when the ledger cannot be read, and counts the refusal', async () => {
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'tally' },
      queueLlm(seen, FIRST, '- The Nightingale — 440\n- no tag here'),
    );

    const answer = await memory.answerSessions('How many novels did I finish?', SESSIONS);

    expect(answer).toBe('440 pages and 416 pages');
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0, refused: 1 });
  });

  it('counts a total that differs from the first pass as a moved answer', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'tally' }, queueLlm(seen, FIRST, '- a — 1\n- b — 1'));

    await memory.answerSessions('How many novels did I finish?', SESSIONS);

    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 1, refused: 0 });
  });

  it('counts an agreement as a consultation and not as a move', async () => {
    // The audit's own distinction, inherited: a review that agreed everywhere has still measured
    // something, and `changed: 0` beside `attempted: 1` is that statement rather than a pass that
    // never ran.
    const seen: string[] = [];
    const agreeing = 'Step 1 —\n- a\n- b\n\nStep 2 — 2';
    const memory = system({ reviewPass: 'tally' }, queueLlm(seen, agreeing, '- a — 1\n- b — 1'));

    const answer = await memory.answerSessions('How many novels did I finish?', SESSIONS);

    expect(answer).toBe('2');
    expect(memory.auditCensus()).toEqual({ attempted: 1, changed: 0, refused: 0 });
  });

  it('does not consult a second time on a question with nothing to sum', async () => {
    const seen: string[] = [];
    const memory = system({ reviewPass: 'tally' }, queueLlm(seen, FIRST, '- a — 1'));

    const answer = await memory.answerSessions(
      'Which store did I spend the most money at?',
      SESSIONS,
    );

    expect(seen).toHaveLength(1);
    expect(answer).toBe('440 pages and 416 pages');
    expect(memory.auditCensus()).toEqual({ attempted: 0, changed: 0, refused: 0 });
  });

  it('does not consult a second time when the first pass declined', async () => {
    // The audit pass's own rule, inherited: a decline has no list, and the recovery pass owns that
    // population rather than this one.
    const seen: string[] = [];
    const memory = system(
      { reviewPass: 'tally' },
      queueLlm(seen, 'INSUFFICIENT_EVIDENCE', '- a — 1'),
    );

    const answer = await memory.answerSessions('How many novels did I finish?', SESSIONS);

    expect(seen).toHaveLength(1);
    expect(answer).toBeNull();
    expect(memory.auditCensus()).toEqual({ attempted: 0, changed: 0, refused: 0 });
  });

  it('reports no census at all when the pass is not configured', async () => {
    const memory = system({}, queueLlm([], FIRST));
    await memory.answerSessions('How many novels did I finish?', SESSIONS);
    expect(memory.auditCensus()).toBeNull();
  });
});

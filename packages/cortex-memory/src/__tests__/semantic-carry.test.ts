/**
 * The semantic layer changes a prompt's bytes, and this is the test that says which bytes and why.
 *
 * ## What has to be shown, and why a capability claim would not be enough
 *
 * Semantic-layer exit criterion E1 is not "the product can build a `KnowledgeFact`". It is
 * *"same corpus, different prompt bytes, because of that fact"*. The distinction is the whole audit's charge:
 * `AUDIT-SEMANTIC-REACH.md` §4.3 refuses a wiring that compiles, returns an empty block set, keeps every test
 * green and lets the reach table claim a `P`, and prices that failure at 43 mechanism flips for 46 damages.
 *
 * So the test isolates three conditions and asserts the bytes at each:
 *
 * | condition | store | `semanticCarry` | expects |
 * | --- | --- | --- | --- |
 * | A — control | empty | on | no `UPDATES:` |
 * | B — switch off | one unit | off | no `UPDATES:` |
 * | C — both | one unit | on | `UPDATES:` with the current fact, the relation, and no superseded value |
 *
 * A vs C is the causal claim: **the same corpus, the same question, the same reader** — only the store's
 * content differs. B vs C is the second control, and it is the one that keeps the mechanism from being
 * attributed to something else in the same commit: with the unit present and the switch off, the bytes are the
 * archived bytes.
 *
 * ## The third thing C asserts, and it is a negative
 *
 * Since exit criterion E2 the block carries **one** fact, not two. The superseded value still appears — quoted
 * by the relation line — but not as a `fact:` line of its own, because the ledger refuted it and `assemble` is
 * what refuses a refuted fact. Before that wiring, nothing in the path ever wrote `refuted` and the block
 * printed the stale value as though it were current. The assertion is `not.toContain` for that reason: a
 * positive assertion about the newer fact passes in both worlds.
 *
 * ## Why the corpus is two turns and not a window
 *
 * The update is only about a window that still **carries the record** the authorisation was read from. A
 * two-turn corpus makes "carries" and "does not carry" trivially separable, and the third test uses a
 * different corpus to assert the case that matters on a benchmark: **an update from one question does not
 * reach another question's window**. That reach is zero by construction, and it is asserted rather than
 * assumed because a benchmark's 500 questions share one `CortexMemory` instance per worker — a leak here would
 * change every published number.
 */

import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const EARLY = '[2023/01/15 (Sun) 09:10] user: I am at 20 dozen at the moment.';
const LATE = '[2023/03/12 (Sun) 11:40] user: I am at 30 dozen at the moment.';
const ELSEWHERE = '[2023/04/01 (Sat) 08:00] user: I bought a bicycle last week.';

const SUPERSEDE_ANSWER =
  'CHANGED: yes\nLATER: 30 dozen at the moment\nWHEN: 2023/03/12 (Sun) 11:40';

/** The question whose answer the two turns change, and a second question over the same corpus. */
const UPDATING = 'How many dozen of stock am I at?';
const REVISIT = 'What is my current stock position?';

/**
 * A reader that plays the four parts this test needs.
 *
 * Routed by the prompt's own text rather than by call index, because the number of calls is one of the things
 * being asserted: a stub that keyed on position would keep working if a phase silently disappeared.
 */
function reader(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      if (prompt.includes('Do not answer the question again')) return SUPERSEDE_ANSWER;
      if (prompt.includes(UPDATING)) return '20 dozen';
      return '30 dozen';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: (_memory: MemoryValue) => 1,
} as const;

function system(llm: LLM, options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: OPEN_GATE,
    reviewPass: 'supersede',
    ...options,
    llm,
  });
}

/**
 * Run the question that authorises a substitution, and return the instance it happened on.
 *
 * One helper rather than four lines repeated in every test, because the sequence **is** the fixture: the
 * store only has a unit if a `knowledge-update` question reached a reader, produced an answer, and had that
 * answer replaced by a later dated span. A test that built the unit by hand would be testing the store's
 * arithmetic instead of the product's path.
 */
async function afterAuthorisation(
  options: Partial<CortexMemoryOptions> = {},
): Promise<{ memory: CortexMemory; seen: string[] }> {
  const seen: string[] = [];
  const memory = system(reader(seen), options);
  const answer = await memory.answerKnowledgeUpdate(UPDATING, [EARLY, LATE]);
  expect(answer).toBe('30 dozen');
  return { memory, seen };
}

describe('an authorised update reaches a prompt, and the controls say it is the reason', () => {
  it('serves the current value and withholds the superseded one, and the block says both', async () => {
    const { memory } = await afterAuthorisation({ semanticCarry: true });
    const seen: string[] = [];
    const revisiting = system(reader(seen), { semanticCarry: true });

    // Same instance: `afterAuthorisation` returns the memory that absorbed the unit.
    const answer = await memory.answer(REVISIT, [EARLY, LATE]);
    expect(answer).toBe('30 dozen');

    const prompt = memory.lastPromptText()!;
    expect(prompt).toContain('UPDATES:');
    expect(prompt).toContain('fact:     30 dozen  [state]');
    expect(prompt).toContain('status:   replaces "20 dozen"');
    // **The superseded value is not served as a fact.** For one round it was: the unit carried a `supersedes`
    // edge and both ends, so a reader was told `30 dozen` replaced `20 dozen` *and* handed `20 dozen` on its own
    // `fact:` line with nothing marking it stale — because neither fact carried an assumption, `reviseLedger`
    // had nothing to refute, and `assemble` therefore excluded nothing. The assertion is negative on purpose: a
    // positive one about the newer fact passes whether or not the ledger ran.
    expect(prompt).not.toContain('fact:     20 dozen');
    expect(prompt).not.toContain('superseded by "30 dozen"');
    // What the reader loses by that exclusion is nothing: the relation line still names the value it replaced.
    expect(prompt).toContain('"20 dozen"');
    // And the ledger is visible in the one place a reader can use it: the surviving fact says its persistence
    // was confirmed by the replacement rather than leaving it open.
    expect(prompt).toContain('assumed:  confirmed');
    // The two counts are the ledger's halves, and they are equal here by construction — one fact served, one
    // withheld. Either alone can look healthy while the mechanism is dead.
    expect(memory.semanticCarryCensus().served).toBe(1);
    expect(memory.semanticCarryCensus().withheld).toBe(1);
    // The block sits between the evidence and the question: a reader told which value is current before it has
    // seen either value would be reading an answer, not evidence.
    expect(prompt.indexOf('UPDATES:')).toBeLessThan(prompt.indexOf(`QUESTION: ${REVISIT}`));
    expect(prompt.indexOf('EVIDENCE:')).toBeLessThan(prompt.indexOf('UPDATES:'));
    // The block does not restate the frame: the evidence is already above it, and printing the frame a second
    // time would spend the evidence budget on a copy.
    expect(prompt.indexOf('frame:    "')).toBe(-1);
    expect(revisiting.lastPromptText()).toBeNull();
  });

  it('is the same corpus and the same question with an empty store — and then there is no block', async () => {
    // Condition A. This is the causal half: nothing about the corpus, the question or the reader changed, so a
    // difference in bytes can only be the store's content.
    const memory = system(reader([]), { semanticCarry: true });
    await memory.answer(REVISIT, [EARLY, LATE]);
    expect(memory.lastPromptText()!).not.toContain('UPDATES:');
  });

  it('is the same store with the switch off — and then the bytes are the archived bytes', async () => {
    // Condition B. The unit exists, so a difference between this and the previous test would be the unit and
    // not the switch.
    const { memory } = await afterAuthorisation({ semanticCarry: false });
    expect(memory.semanticCarryCensus().absorbed).toBe(1);
    await memory.answer(REVISIT, [EARLY, LATE]);
    expect(memory.lastPromptText()!).not.toContain('UPDATES:');

    const control = system(reader([]), { semanticCarry: false });
    await control.answer(REVISIT, [EARLY, LATE]);
    expect(memory.lastPromptText()).toBe(control.lastPromptText());
  });

  it('does not reach a question whose window does not carry the record', async () => {
    // The benchmark case. One instance per worker means a leak here would move every published figure, so the
    // reach is asserted as zero rather than argued to be zero.
    const { memory } = await afterAuthorisation({ semanticCarry: true });
    await memory.answer(REVISIT, [ELSEWHERE]);
    expect(memory.lastPromptText()!).not.toContain('UPDATES:');
    expect(memory.semanticCarryCensus().matched).toBe(0);
  });

  it('spends no model call to build or to carry the unit', async () => {
    // "Zero new model calls" is E1's third clause, and the way to assert it is to compare the two configurations
    // call for call: the mechanism may change bytes, and may not change the bill.
    const on = await afterAuthorisation({ semanticCarry: true });
    await on.memory.answer(REVISIT, [EARLY, LATE]);
    const off = await afterAuthorisation({ semanticCarry: false });
    await off.memory.answer(REVISIT, [EARLY, LATE]);
    expect(on.seen).toHaveLength(3);
    expect(off.seen).toHaveLength(3);
  });
});

describe('the store reports what it did', () => {
  it('counts an absorbed unit and a matched window, and no evictions', async () => {
    const { memory } = await afterAuthorisation({ semanticCarry: true });
    expect(memory.semanticCarryCensus()).toEqual({
      absorbed: 1,
      dropped: 0,
      matched: 0,
      served: 0,
      withheld: 0,
    });
    await memory.answer(REVISIT, [EARLY, LATE]);
    expect(memory.semanticCarryCensus()).toEqual({
      absorbed: 1,
      dropped: 0,
      matched: 1,
      served: 1,
      withheld: 1,
    });
  });

  it('does not count a match when the switch is off, because no window spent a line', async () => {
    const { memory } = await afterAuthorisation({ semanticCarry: false });
    await memory.answer(REVISIT, [EARLY, LATE]);
    expect(memory.semanticCarryCensus()).toEqual({
      absorbed: 1,
      dropped: 0,
      matched: 0,
      served: 0,
      withheld: 0,
    });
  });

  it('absorbs nothing when the substitution is refused, so the store cannot hold a claim nobody authorised', async () => {
    const seen: string[] = [];
    const memory = system(
      {
        complete: async (prompt: string) => {
          seen.push(prompt);
          // The reader says "no change", which is a measurement rather than a failure.
          return 'CHANGED: no\nLATER: NONE\nWHEN: NONE';
        },
        completeStructured: async () => {
          throw new Error('unused by this package');
        },
      },
      { semanticCarry: true },
    );
    expect(await memory.answerKnowledgeUpdate(UPDATING, [EARLY, LATE])).toBe(
      'CHANGED: no\nLATER: NONE\nWHEN: NONE',
    );
    expect(memory.semanticCarryCensus().absorbed).toBe(0);
  });
});

describe('the bound, and the re-entry it has to allow', () => {
  /** A corpus whose every sentence is unique, so nine of them give nine distinct anchors. */
  function batch(i: number): string[] {
    return [
      `[2023/01/10 (Tue) 03:14] user: we now have 20 dozen of stock record number ${i}.`,
      `[2023/03/1${i} (Fri) 10:52] user: we now have 30 dozen of stock record number ${i}.`,
    ];
  }

  /**
   * A reader that takes its answer from the corpus it was shown.
   *
   * It reads the record number out of the prompt rather than counting calls, because the number of calls is one
   * of the things these tests would otherwise stop noticing: a phase that vanished would leave the counter
   * looking fine.
   */
  function batchReader(): LLM {
    return {
      complete: async (prompt: string) => {
        const number = /stock record number (\d+)/.exec(prompt)?.[1] ?? '0';
        if (prompt.includes('Do not answer the question again')) {
          return `CHANGED: yes\nLATER: 30 dozen of stock record number ${number}\nWHEN: 2023/03/1${number} (Fri) 10:52`;
        }
        return `20 dozen of stock record number ${number}`;
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
  }

  it('evicts the oldest past eight, counts the drop, and lets an evicted update come back', async () => {
    const memory = system(batchReader(), { semanticCarry: true });
    for (let i = 0; i < 8; i += 1) await memory.answerKnowledgeUpdate(UPDATING, batch(i));
    expect(memory.semanticCarryCensus()).toEqual({
      absorbed: 8,
      dropped: 0,
      matched: 0,
      served: 0,
      withheld: 0,
    });

    // The ninth runs the bound: `SEMANTIC_UPDATES_MAX` is 8, so one leaves and the count says so. A store whose
    // growth is bounded by a silent `shift()` and nothing else would report the same `absorbed` on a run of nine
    // and a run of ninety.
    await memory.answerKnowledgeUpdate(UPDATING, batch(8));
    expect(memory.semanticCarryCensus()).toEqual({
      absorbed: 9,
      dropped: 1,
      matched: 0,
      served: 0,
      withheld: 0,
    });

    // Batch 0 was evicted, so its anchor is no longer held — and asking about it again must be able to re-admit
    // it. A dedup set that kept the key would refuse, turning the bound into a permanent ban on the first eight
    // corpora a worker happened to see.
    await memory.answerKnowledgeUpdate(UPDATING, batch(0));
    expect(memory.semanticCarryCensus()).toEqual({
      absorbed: 10,
      dropped: 2,
      matched: 0,
      served: 0,
      withheld: 0,
    });

    // The re-admitted unit is now in hand, which is the half of the claim the counts cannot show on their own.
    await memory.answer(REVISIT, batch(0));
    expect(memory.lastPromptText()!).toContain('UPDATES:');
    expect(memory.lastPromptText()!).toContain('stock record number 0');
  });
});

describe('what the store refuses to hold', () => {
  it('holds nothing when one of the two records carries no date', async () => {
    // The older record here is the shape a turn takes when the corpus does not date it. The substitution is
    // still authorised — the quote is in the evidence and its own record is dated — but there is nothing to
    // order it against, and a unit without an order states two facts and no relation. That is the case this
    // module reports as "no update" rather than as "an update with a missing end".
    const UNDATED = 'we have 20 dozen at the moment';
    const DATED = '[2023/03/15 (Wed) 10:52] user: we have 30 dozen stocked up';
    const memory = system(
      {
        complete: async (prompt: string) =>
          prompt.includes('Do not answer the question again')
            ? 'CHANGED: yes\nLATER: 30 dozen stocked up\nWHEN: 2023/03/15 (Wed) 10:52'
            : UNDATED,
        completeStructured: async () => {
          throw new Error('unused by this package');
        },
      },
      { semanticCarry: true },
    );

    expect(await memory.answerKnowledgeUpdate(UPDATING, [UNDATED, DATED])).toBe('30 dozen');
    expect(memory.semanticCarryCensus()).toEqual({
      absorbed: 0,
      dropped: 0,
      matched: 0,
      served: 0,
      withheld: 0,
    });
    await memory.answer(REVISIT, [UNDATED, DATED]);
    expect(memory.lastPromptText()!).not.toContain('UPDATES:');
  });
});

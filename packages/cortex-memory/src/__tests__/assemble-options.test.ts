/**
 * The four options that existed on `CortexMemory` and not on the function an installer calls.
 *
 * ## What this file is for, and why it was written late
 *
 * `assemble.ts` forwards `promptContract`, `ask`, `sessionClock`, `maxTurnChars`, `turnCutMarker`,
 * `turnWindow`, `resolution` and `embeddingStore`, each with the same sentence: *a capability that exists in
 * `CortexMemory` and not in the one function an installer calls is a capability the published package does
 * not have*. Four options were outside that sentence -- `reviewPass`, `replyRepair`, `semanticCarry`,
 * `factTimeline` -- and the module comment was read as covering them:
 *
 * > Three rather than a matrix because a matrix of thirty options is what the class already is. … a caller
 * > who needs a fourth composes `CortexMemory` directly, which is what the fields are for.
 *
 * That sentence is about a fourth **profile**, not about the thirty fields. Read against the field-level
 * argument twelve lines above it, it says the opposite of what it was taken to say, and the cost was the
 * asymmetry requirement ⑯ names: `docs/PRODUCT-CAPABILITY-LEDGER.md` calls rows 6, 7, 9 and 19 *"a customer
 * can reach it"* while the documented construction path could not name any of them. A customer who wanted
 * `tally` had to rebuild the whole composition by hand, and in doing so had every opportunity to drift from
 * the registration `registered-arm.test.ts` pins.
 *
 * ## Why the assertions are behaviour rather than field reads
 *
 * A test that read the option back would pass on an `assembleMemory` that stored it and never passed it on --
 * which is the exact defect `sessionClock` had for a round. Each group below therefore drives a corpus through
 * the composed product and reads something only the mechanism can produce: a computed sum, a repair
 * consultation's own prompt, an interval line.
 *
 * The four are tested together where they are inseparable. `factTimeline` dates the facts `semanticCarry`
 * carries, and `semanticCarry` carries the substitution `reviewPass: 'supersede'` authorised, so one prompt
 * proves three forwards at once -- and the control beside it (drop one of the three) proves each forward is
 * load-bearing rather than incidental.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';

const NOW = 1_759_470_000_000;

/** The value gate every reading in this repository was taken under: admit everything, decline nothing. */
const IDENTITY_VALUE = { valueFunction: (_memory: MemoryValue) => 1 } as const;

function scripted(replies: readonly string[], seen: string[] = []): LLM {
  let index = 0;
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply === undefined) throw new Error('the script has no reply for this call');
      return reply;
    },
  } as unknown as LLM;
}

const SESSIONS = [
  [
    '[2023/05/21] user: I bought a blazer at the dry cleaner.',
    '[2023/05/21] user: Two boots at Zara.',
  ],
  ['[2023/06/02] user: I still have the boots.'],
];

describe('`reviewPass` reaches the composed product', () => {
  it('computes the total the reader was asked for, instead of returning its own count', async () => {
    // The mechanism in one assertion. The first pass answers `2` for a list of three items, which is the
    // off-by-one `tally.ts` was built for; the tally pass tags the operands and the product adds them, so the
    // only way to reach `3` is for the option to have arrived at the route that consults.
    const seen: string[] = [];
    const install = assembleMemory({
      llm: scripted(['2', '- blazer \u2014 1\n- boots \u2014 2'], seen),
      now: NOW,
      storage: new SqliteStorage(),
      reviewPass: 'tally',
    });
    expect(await install.memory.answerSessions('How many items am I collecting?', SESSIONS)).toBe(
      '3',
    );
    expect(seen).toHaveLength(2);
  });

  it('does not consult twice when the option is absent', async () => {
    // The control. Same corpus, same script: without the option the first reply is the answer, and the run
    // spends one call. A forwarding that defaulted the pass on would fail here rather than in a reading.
    const seen: string[] = [];
    const install = assembleMemory({
      llm: scripted(['2', '- blazer \u2014 1\n- boots \u2014 2'], seen),
      now: NOW,
      storage: new SqliteStorage(),
    });
    expect(await install.memory.answerSessions('How many items am I collecting?', SESSIONS)).toBe(
      '2',
    );
    expect(seen).toHaveLength(1);
  });
});

describe('`replyRepair` reaches the composed product', () => {
  const REFUSAL = 'Not specified in the evidence.';
  const COMMIT_PROMPT =
    'Your previous reply reported that the evidence above does not answer this question.';

  it('re-asks a prose refusal with the commitment rule, and reports the repair', async () => {
    const seen: string[] = [];
    const install = assembleMemory({
      llm: scripted([REFUSAL, 'Answer: blazer'], seen),
      now: NOW,
      storage: new SqliteStorage(),
      replyRepair: 'commitment',
    });
    expect(
      await install.memory.answerSessions('What did I take to the dry cleaner?', SESSIONS),
    ).toBe('blazer');
    // The second prompt is the repair, not a retry of the same bytes: the builder that answers a *prose*
    // refusal says what the reply did, and a re-ask that reused `buildRetryPrompt`'s sentence would be a false
    // statement about the reply the model actually wrote.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain(COMMIT_PROMPT);
    // The census is the product's own record of the pass, and it is `null` on an arm that never had one.
    expect(install.memory.replyRepairCensus()?.commitment.attempted).toBe(1);
  });

  it('leaves the census null on a call that names nothing', async () => {
    // The absence has to stay absent. `replyRepairCensus` returns `null` for both `undefined` and `'off'`, so
    // this is the assertion that no default crept in with the forward.
    const install = assembleMemory({
      llm: scripted([REFUSAL]),
      now: NOW,
      storage: new SqliteStorage(),
    });
    expect(install.memory.replyRepairCensus()).toBeNull();
  });

  it('keeps the mutual exclusion the constructor states, through the public entry', async () => {
    // Two second consultations on one route is the configuration `memory.ts` refuses. Forwarding both fields
    // must not become a way around that guard: a composition root that could build what the class refuses to
    // build by hand would make the refusal a property of one export.
    expect(() =>
      assembleMemory({
        llm: scripted(['2']),
        now: NOW,
        storage: new SqliteStorage(),
        reviewPass: 'tally',
        replyRepair: 'commitment',
      }),
    ).toThrow(/replyRepair and reviewPass cannot both be on/u);
  });
});

describe('`semanticCarry` and `factTimeline` reach the composed product', () => {
  const EARLY = '[2023/01/15 (Sun) 09:10] user: I am at 20 dozen at the moment.';
  const LATE = '[2023/03/12 (Sun) 11:40] user: I am at 30 dozen at the moment.';
  const UPDATING = 'How many dozen of stock am I at?';
  const REVISIT = 'What is my current stock position?';
  const SUPERSEDE_ANSWER =
    'CHANGED: yes\nLATER: 30 dozen at the moment\nWHEN: 2023/03/12 (Sun) 11:40';

  /** One authorised substitution, then the question whose prompt would carry it. */
  async function promptAfterAuthorisation(options: {
    semanticCarry?: boolean;
    factTimeline?: boolean;
  }): Promise<string> {
    const llm = {
      complete: async (prompt: string) => {
        if (prompt.includes('Do not answer the question again')) return SUPERSEDE_ANSWER;
        if (prompt.includes(UPDATING)) return '20 dozen';
        return '30 dozen';
      },
    } as unknown as LLM;
    const install = assembleMemory({
      llm,
      now: NOW,
      storage: new SqliteStorage(),
      gate: IDENTITY_VALUE,
      reviewPass: 'supersede',
      ...options,
    });
    expect(await install.memory.answerKnowledgeUpdate(UPDATING, [EARLY, LATE])).toBe('30 dozen');
    await install.memory.answer(REVISIT, [EARLY, LATE]);
    const prompt = install.memory.lastPromptText();
    if (prompt === null) throw new Error('the product must have rendered a prompt');
    return prompt;
  }

  it('dates the carried fact, which needs all three options to have arrived', async () => {
    // `reviewPass: 'supersede'` authorises the substitution, `semanticCarry` puts the fact in the prompt, and
    // `factTimeline` appends the interval. Any one of the three missing and this line is absent -- which is why
    // one assertion covers four forwards and why the two controls below are the real test.
    const prompt = await promptAfterAuthorisation({ semanticCarry: true, factTimeline: true });
    expect(prompt).toContain('timeline: 30 dozen [2023/03/12 -> now]');
    // The date is the record's own digits rather than a local-time rendering of the same instant, which in a
    // UTC+8 process would shift every record stamped before 08:00 to the previous day.
    expect(prompt).toContain('2023/03/12');
    // And the interval is the served fact's, not the withheld one's.
    expect(prompt).not.toContain('timeline: 20 dozen');
  });

  it('carries the fact without the interval when only the first is named', async () => {
    // The control that makes `factTimeline`'s forward load-bearing: with `semanticCarry` alone the fact is in
    // the prompt and the interval is not, so the line above cannot be produced by `semanticCarry`'s forward.
    const prompt = await promptAfterAuthorisation({ semanticCarry: true });
    expect(prompt).toContain('fact:');
    expect(prompt).not.toContain('timeline:');
  });

  it('renders no interval for a fact the prompt does not carry', async () => {
    // The other direction, and the reason the two options are separate: an interval describes a fact, so
    // `factTimeline` alone is inert rather than half-on. A forward that made it act on its own would have this
    // prompt carrying an interval for a fact nothing rendered.
    const prompt = await promptAfterAuthorisation({ factTimeline: true });
    expect(prompt).not.toContain('timeline:');
  });

  it('leaves a bare call on the arm every archived artifact was produced under', async () => {
    // The forwards must not default anything on. `semanticCarryCensus` reports the absorbed store, which is
    // empty on a call that named neither option -- and the prompt carries no fact line at all.
    const install = assembleMemory({
      llm: scripted(['30 dozen']),
      now: NOW,
      storage: new SqliteStorage(),
    });
    const census = install.memory.semanticCarryCensus();
    // Field by field rather than `toEqual` on the object: the census gains counters as the mechanism is
    // measured, and an equality on the whole shape would fail on a field this test is not about.
    expect({ absorbed: census.absorbed, served: census.served, withheld: census.withheld }).toEqual(
      {
        absorbed: 0,
        served: 0,
        withheld: 0,
      },
    );
    await install.memory.answer(REVISIT, [EARLY, LATE]);
    expect(install.memory.lastPromptText() ?? '').not.toContain('timeline:');
  });
});

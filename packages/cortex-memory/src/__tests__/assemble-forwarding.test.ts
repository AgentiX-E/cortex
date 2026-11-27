/**
 * The six remaining options reach the product through the composition root, and each one is asserted by a
 * behaviour that cannot happen if the field stops at `AssembleOptions`.
 *
 * ## Why this file is written as behaviour rather than as an equality
 *
 * Comparing `assembleMemory({ x })`'s prompt with `new CortexMemory({ x })`'s would prove the forwarding
 * mechanically and prove nothing else -- both paths could ignore the field together. So every case here names
 * a **consequence**: three consultations instead of one, a second call on a bare decline, a shorter prompt, a
 * reordered window, a refusal that only the named unit can produce, a radius the validator rejects. Each
 * assertion is false if the field is dropped, which is the property the guard in `assemble-coverage.mjs`
 * cannot have (it reads text, not behaviour) and the component tests cannot have (they construct the class
 * directly, which is exactly how the last two gaps went unseen).
 *
 * ## What is deliberately not asserted here
 *
 * The mechanisms' own readings. `widthPlan`'s cut is measured in `width-plan.test.ts`, `windowOrdering`'s
 * reorder in the reference-parity suite, the units in `session-text-unit.test.ts` and `anchor-window.test.ts`.
 * Repeating them at this level would double the runtime to re-prove a property that is not in doubt; what is in
 * doubt is whether the composition root can name them at all.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';

const NOW = 1_759_470_000_000;

/** Five turns of one topic that the question below matches, long enough for a budget to be visible. */
const EVIDENCE = [
  'I have got 1250 followers on Instagram now, so insights would help me plan the next campaign.',
  'My sister has 900 followers and she posts twice a week about the same subject as me.',
  'I moved to Lisbon in March and the account is still growing there, which surprised me.',
  'The recycling is collected on Tuesdays, which has nothing to do with any of this.',
  'I think I am close to 1300 followers on Instagram now, honestly, after the last post.',
];
const QUESTION = 'How many followers do I have on Instagram now?';

function stub(answer: string | (string | ((call: number) => string))[]): LLM & { calls: number } {
  const queue = Array.isArray(answer) ? [...answer] : [answer];
  const llm = {
    calls: 0,
    complete: async () => {
      llm.calls += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next(llm.calls) : (next as string);
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
  return llm;
}

function build(llm: LLM, extra: Record<string, unknown> = {}) {
  return assembleMemory({ llm, now: NOW, storage: new SqliteStorage(), ...extra }).memory;
}

describe('the composition root forwards every remaining option', () => {
  it('`selfConsistency` buys three consultations on the route it reaches, and absence buys one', async () => {
    // The multi-session route, because that is where `§13.101` put the sample count: a `flat` run with the
    // field set consults once, which is a property of the mechanism and not of this forwarding.
    const sessions = [EVIDENCE.slice(0, 2), EVIDENCE.slice(2, 4)];
    const three = stub('1300');
    await build(three, { selfConsistency: 3 }).answerSessions(QUESTION, sessions);
    expect(three.calls).toBe(3);

    const one = stub('1300');
    await build(one).answerSessions(QUESTION, sessions);
    expect(one.calls).toBe(1);
  });

  it('`reviewBareDecline` re-asks a decline that named nothing, and absence does not', async () => {
    const reasked = stub(['INSUFFICIENT_EVIDENCE', '1300']);
    const answered = await build(reasked, { reviewBareDecline: true }).answer(QUESTION, EVIDENCE);
    expect(reasked.calls).toBe(2);
    expect(JSON.stringify(answered)).toContain('1300');

    const single = stub(['INSUFFICIENT_EVIDENCE', '1300']);
    await build(single).answer(QUESTION, EVIDENCE);
    expect(single.calls).toBe(1);
  });

  it('`widthPlan` cuts the prompt, and absence leaves the room as the only bound', async () => {
    const wide = build(stub('1300'));
    await wide.answer(QUESTION, EVIDENCE);
    const narrow = build(stub('1300'), {
      widthPlan: { coverage: 0.5, floorChars: 0, renderMargin: 1 },
    });
    await narrow.answer(QUESTION, EVIDENCE);
    // The assertion is on the **prompt**, not on the decision: a plan that reached the class and not the
    // prompt would be the same defect one level down, and a decision object is not what a customer pays for.
    const full = wide.lastPromptText() ?? '';
    const cut = narrow.lastPromptText() ?? '';
    expect(full.length).toBeGreaterThan(0);
    expect(cut.length).toBeLessThan(full.length);
  });

  it('`readerSearch` reaches the class: the stage runs, and its census is readable', async () => {
    // The consequence is the **census**, not the prompt: an assembly that dropped the field would answer
    // identically on this fixture (the stub's reply becomes a query the product may not be able to rank), and
    // the only difference a caller could observe is that `readerSearchCensus()` answered `null`. That is the
    // exact shape requirement ⑯ names -- a capability the arm can dispatch and the published entry point
    // cannot reach -- and it has shipped here twice (`readerByRoute`, and the three options before this one).
    const sessions = [EVIDENCE.slice(0, 2), EVIDENCE.slice(2, 4)];
    const carrying = build(stub('1300'), { readerSearch: { k: 4 } });
    await carrying.answerSessions(QUESTION, sessions);
    const census = carrying.readerSearchCensus();
    expect(census).not.toBeNull();
    expect(census?.attempted).toBe(1);

    const control = build(stub('1300'));
    await control.answerSessions(QUESTION, sessions);
    expect(control.readerSearchCensus()).toBeNull();
  });

  it('`relevanceUnits` reaches the guard: `session-text` refuses a route with no boundaries', async () => {
    const llm = stub('1300');
    const memory = build(llm, { relevanceUnits: 'session-text' });
    await expect(memory.answer(QUESTION, EVIDENCE)).rejects.toThrow(
      /session .*boundaries|needs the session/i,
    );
  });

  it('`relevanceUnits` reaches the route that has them: `session-text` answers when sessions arrive', async () => {
    const llm = stub('1300');
    const memory = build(llm, { relevanceUnits: 'session-text' });
    const answer = await memory.answerSessions(QUESTION, [
      EVIDENCE.slice(0, 2),
      EVIDENCE.slice(2, 4),
    ]);
    expect(JSON.stringify(answer)).toContain('1300');
    expect(llm.calls).toBe(1);
  });

  it('`windowRadius` reaches the validator, which rejects rather than clamps', async () => {
    // The validator lives where the unit is spent, so the arrival needs four things at once: the unit, an
    // index that produces scores to spend, a route that carries session boundaries, and a room the evidence
    // does **not** fit -- because a prompt that fits whole never reaches the selector, and a test written
    // against one would pass whatever the radius said. The 2,600-character room is the binding one for this
    // fixture; at 3,000 the same call succeeds and proves nothing.
    const embed = async (texts: string[]) => texts.map(() => [1, 0]);
    const memory = build(stub('1300'), {
      relevanceUnits: 'anchor-window',
      windowRadius: 1.5,
      embed,
      index: {},
      maxPromptChars: 2_600,
    });
    await expect(
      memory.answerSessions(QUESTION, [EVIDENCE.slice(0, 2), EVIDENCE.slice(2, 4)]),
    ).rejects.toThrow(/windowRadius must be a non-negative integer/i);
  });

  it('`relevanceUnits` changes the delivered evidence, and `turn` is the control', async () => {
    // The strongest statement available without an accuracy reading: in a room the evidence does not fit, the
    // unit decides **which** turns arrive. A field that stopped at `AssembleOptions` would produce the same
    // prompt for both values, which is exactly what this pair rules out.
    const embed = async (texts: string[]) => texts.map(() => [1, 0]);
    const room = { embed, index: {}, maxPromptChars: 2_600 } as const;
    const sessions = [EVIDENCE.slice(0, 2), EVIDENCE.slice(2, 4)];
    const turn = build(stub('1300'), { ...room, relevanceUnits: 'turn' });
    const unit = build(stub('1300'), { ...room, relevanceUnits: 'session' });
    await turn.answerSessions(QUESTION, sessions);
    await unit.answerSessions(QUESTION, sessions);
    expect(unit.lastPromptText()).not.toBe(turn.lastPromptText());
  });

  it('`windowOrdering` reaches the prompt: a resolving window reorders, an absent one reproduces the bytes', async () => {
    const dateOf = (content: string) => (/Instagram/.test(content) ? '2023/06/01' : '2023/06/20');
    const plain = build(stub('1300'));
    await plain.answer(QUESTION, EVIDENCE);
    const named = build(stub('1300'), {
      windowOrdering: { dateOf, windowOf: () => ({ start: '2023/05/01', end: '2023/06/10' }) },
    });
    await named.answer(QUESTION, EVIDENCE);
    const silent = build(stub('1300'), { windowOrdering: { dateOf, windowOf: () => undefined } });
    await silent.answer(QUESTION, EVIDENCE);

    // Two readings make one claim: a resolver that names a window changes the prompt, and a resolver that
    // names none reproduces the unordered one **byte for byte** -- the option's own contract, and the reason
    // the pair is here rather than a single "it changed" assertion.
    expect(named.lastPromptText()).not.toBe(plain.lastPromptText());
    expect(silent.lastPromptText()).toBe(plain.lastPromptText());
  });
});

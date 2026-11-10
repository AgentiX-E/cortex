/**
 * The related-statements block reaches exactly four routes, and changes nothing but the insertion.
 *
 * ## Why this file exists
 *
 * The block is a text insertion, which is the easiest kind of change to get subtly wrong: an
 * implementation that re-ran the budget with the block's characters already spent would carry fewer
 * turns than its control, and the resulting delta would be a reading of the window rather than of the
 * block. So the test does not check that a block appears. It checks the two properties the
 * registration claims:
 *
 *   - **reach**: the set of routes whose prompt differs between `conflicts: false` and
 *     `conflicts: true` is exactly the four declared, so a route that moves without being declared
 *     fails and a route that is declared but does not move fails too;
 *   - **single variable**: on every route that moves, deleting the block from the treatment's prompt
 *     reproduces the control's prompt **byte for byte** — the evidence, the question and the
 *     instruction are untouched, which is what makes the delta attributable.
 *
 * The abstention and multi-session routes are the two that must not move, and they must not move for
 * different reasons: abstention's gold is a decline and it reads 30/30, and the session route renders
 * boundaries a flattened block would undo. Both are asserted rather than described.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

/**
 * Two statements of one detail, ten days apart, which is the shape the mechanism exists to surface.
 *
 * The wording is the artifact's, not an invention: `a2f3aa27` is a `KU` question that fails in all
 * four repetitions with `1250` against a gold of `1300`, and these are its two statements.
 */
const FIRST = 'I have got 1250 followers on Instagram now, so insights would help.';
const SECOND = 'I think I am close to 1300 followers on Instagram now, honestly.';

/** A question that shares terms with both statements. */
const QUESTION = 'How many followers do I have on Instagram now?';

/** A question that shares terms with neither, so the block cannot fire. */
const UNRELATED = 'What day of the week is the recycling collected?';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '1300';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function build(seen: string[], conflicts: boolean): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    conflicts,
  });
}

/** All six routes, named the way the registration names them. */
const ROUTES: ReadonlyArray<
  readonly [string, (m: CortexMemory, question: string) => Promise<unknown>]
> = [
  ['abstention', (m, question) => m.answerAbstention(question, [FIRST, SECOND])],
  ['multi-session', (m, question) => m.answerSessions(question, [[FIRST], [SECOND]])],
  ['temporal', (m, question) => m.answerTemporal(question, [FIRST, SECOND], '2023/06/01')],
  ['knowledge-update', (m, question) => m.answerKnowledgeUpdate(question, [FIRST, SECOND])],
  ['assistant', (m, question) => m.answerAssistant(question, [FIRST, SECOND])],
  ['flat', (m, question) => m.answer(question, [FIRST, SECOND])],
];

/** The prompt one route builds, under one value of the option. */
async function promptUnder(
  drive: (m: CortexMemory, question: string) => Promise<unknown>,
  conflicts: boolean,
  question: string,
): Promise<string> {
  const seen: string[] = [];
  await drive(build(seen, conflicts), question);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

/** The block, as it appears in a treatment prompt: from the header to the question marker. */
function blockOf(prompt: string): string {
  const start = prompt.indexOf('RELATED STATEMENTS');
  if (start === -1) return '';
  const end = prompt.indexOf('QUESTION: ', start);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end).replace(/\n+$/, '');
}

const DECLARED = ['assistant', 'flat', 'knowledge-update', 'temporal'];

describe('the related-statements block reaches exactly the four declared routes', () => {
  it('moves the four flat routes and neither of the two excluded ones', async () => {
    const moved: string[] = [];
    for (const [name, drive] of ROUTES) {
      const off = await promptUnder(drive, false, QUESTION);
      const on = await promptUnder(drive, true, QUESTION);
      if (off !== on) moved.push(name);
    }
    expect(moved.sort()).toEqual(DECLARED);
  });

  it('leaves the abstention route and the session route byte-identical', async () => {
    for (const name of ['abstention', 'multi-session']) {
      const drive = ROUTES.find(([routeName]) => routeName === name)![1];
      expect(await promptUnder(drive, true, QUESTION)).toBe(
        await promptUnder(drive, false, QUESTION),
      );
    }
  });

  for (const name of DECLARED) {
    it(`${name}: deleting the block reproduces the control prompt exactly`, async () => {
      const drive = ROUTES.find(([routeName]) => routeName === name)![1];
      const off = await promptUnder(drive, false, QUESTION);
      const on = await promptUnder(drive, true, QUESTION);
      const block = blockOf(on);
      expect(block).toContain('1250');
      expect(block).toContain('1300');
      expect(on.replace(`\n\n${block}`, '')).toBe(off);
    });
  }
});

describe('the block does not fire when the window has no pair', () => {
  it('is absent on a question that shares no term with the evidence', async () => {
    for (const [name, drive] of ROUTES) {
      const off = await promptUnder(drive, false, UNRELATED);
      const on = await promptUnder(drive, true, UNRELATED);
      expect(on).toBe(off);
      expect(on).not.toContain('RELATED STATEMENTS');
      void name;
    }
  });

  it('is absent when the option is off even though the window has a pair', async () => {
    const off = await promptUnder(ROUTES[5]![1], false, QUESTION);
    expect(off).not.toContain('RELATED STATEMENTS');
  });
});

describe('the block sits between the evidence and the question', () => {
  it('prints after the last evidence turn and before the question line', async () => {
    const prompt = await promptUnder(ROUTES[5]![1], true, QUESTION);
    const block = blockOf(prompt);
    expect(prompt.indexOf(block)).toBeGreaterThan(prompt.indexOf('EVIDENCE:'));
    expect(prompt.indexOf(block)).toBeLessThan(prompt.indexOf(`QUESTION: ${QUESTION}`));
  });

  it('is followed by the question and the instruction block that the control also has', async () => {
    const off = await promptUnder(ROUTES[3]![1], false, QUESTION);
    const on = await promptUnder(ROUTES[3]![1], true, QUESTION);
    expect(on.slice(on.indexOf(`QUESTION: ${QUESTION}`))).toBe(
      off.slice(off.indexOf(`QUESTION: ${QUESTION}`)),
    );
  });
});

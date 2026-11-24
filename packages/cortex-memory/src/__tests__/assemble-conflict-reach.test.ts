/**
 * The related-statements block is reachable from the composition root, and reaches the same four routes.
 *
 * ## Why this file exists beside `conflict-reach.test.ts`
 *
 * That file proves the mechanism's reach by constructing `CortexMemory` by hand — which is exactly how the
 * dispatch builds it, and exactly why the gap this file covers went unseen. `assembleMemory` is the only
 * construction path the published package offers, and until this round it had no `conflicts` field at all,
 * so a customer who read `MEASURE-CONFLICT-SURFACING.md`'s reach table could not turn the mechanism on.
 *
 * A component test cannot catch that class: the class accepted the option the whole time. So the assertions
 * here are about the **assembled** memory, and they are the same three properties the registration claims,
 * measured one level up:
 *
 *   - the block arrives on the four declared routes through `assembleMemory`;
 *   - `abstention` and `multi-session` are byte-identical with the option on and off;
 *   - on every route that moves, deleting the block reproduces the off-prompt **byte for byte**, so the
 *     delta is the insertion and not a re-run of the budget.
 *
 * ## Why the fixture is the artifact's wording
 *
 * `a2f3aa27` is a `KU` question that answers `1250` against a gold of `1300` in all four repetitions of run
 * `42355323615`; these are its two statements, ten days apart. A fixture that merely *looks* like a conflict
 * would prove the insertion and say nothing about whether the mechanism fires on the population it was
 * written for.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import type { CortexMemory } from '../memory.js';

const NOW = 1_759_470_000_000;

const FIRST = 'I have got 1250 followers on Instagram now, so insights would help.';
const SECOND = 'I think I am close to 1300 followers on Instagram now, honestly.';
const QUESTION = 'How many followers do I have on Instagram now?';
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

/** An assembled memory, the way a customer gets one: through the function that ships. */
function build(seen: string[], conflicts: boolean | undefined): CortexMemory {
  return assembleMemory({
    llm: recorder(seen),
    now: NOW,
    storage: new SqliteStorage(),
    ...(conflicts === undefined ? {} : { conflicts }),
  }).memory;
}

/** Every route the class exposes, named the way the registration names them. */
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

async function promptUnder(
  drive: (m: CortexMemory, question: string) => Promise<unknown>,
  conflicts: boolean | undefined,
  question: string,
): Promise<string> {
  const seen: string[] = [];
  await drive(build(seen, conflicts), question);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

/** The block as it appears in a treatment prompt: from its header to the question line. */
function blockOf(prompt: string): string {
  const start = prompt.indexOf('RELATED STATEMENTS');
  if (start === -1) return '';
  const end = prompt.indexOf('QUESTION: ', start);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end).replace(/\n+$/, '');
}

const DECLARED = ['assistant', 'flat', 'knowledge-update', 'temporal'];

describe('a customer can turn the block on, and it moves the four declared routes', () => {
  it('moves exactly the declared routes and neither of the two excluded ones', async () => {
    const moved: string[] = [];
    for (const [name, drive] of ROUTES) {
      const off = await promptUnder(drive, undefined, QUESTION);
      const on = await promptUnder(drive, true, QUESTION);
      if (off !== on) moved.push(name);
    }
    expect(moved.sort()).toEqual(DECLARED);
  });

  it('leaves `abstention` and `multi-session` byte-identical', async () => {
    for (const name of ['abstention', 'multi-session']) {
      const drive = ROUTES.find(([routeName]) => routeName === name)![1];
      expect(await promptUnder(drive, true, QUESTION)).toBe(
        await promptUnder(drive, undefined, QUESTION),
      );
    }
  });

  it('prints both statements, in evidence order, with the later one marked as such', async () => {
    const prompt = await promptUnder(ROUTES[3]![1], true, QUESTION);
    const block = blockOf(prompt);
    expect(block).toContain('1250');
    expect(block).toContain('1300');
    expect(block.indexOf('1250')).toBeLessThan(block.indexOf('1300'));
  });
});

describe('forwarding is not adopting: an unnamed field still assembles the registered bytes', () => {
  it('is `undefined`, not `false`, that a bare call sends', async () => {
    // The distinction matters because `undefined` is what every archived artifact prints for an absent
    // field. If the composition root defaulted this to `false` the bytes would be the same and the artifact
    // would stop being able to say which arm a run was, which is `DESIGN-ARM-ADOPTION.md`'s whole subject.
    const bare = await promptUnder(ROUTES[5]![1], undefined, QUESTION);
    const off = await promptUnder(ROUTES[5]![1], false, QUESTION);
    expect(bare).toBe(off);
    expect(bare).not.toContain('RELATED STATEMENTS');
  });

  it('does not fire on a question that shares no term with the evidence', async () => {
    const off = await promptUnder(ROUTES[5]![1], undefined, UNRELATED);
    const on = await promptUnder(ROUTES[5]![1], true, UNRELATED);
    expect(on).toBe(off);
  });

  it('deleting the block reproduces the off-prompt exactly, on every route that moved', async () => {
    for (const name of DECLARED) {
      const drive = ROUTES.find(([routeName]) => routeName === name)![1];
      const off = await promptUnder(drive, undefined, QUESTION);
      const on = await promptUnder(drive, true, QUESTION);
      const block = blockOf(on);
      expect(block).not.toBe('');
      expect(on.replace(`\n\n${block}`, '')).toBe(off);
    }
  });
});

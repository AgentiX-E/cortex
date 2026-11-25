/**
 * The act rule's other clock: a turn's date is not the event's date — §13.292.
 *
 * ## Why this ask exists, and why it is the inverse of the one before it
 *
 * `verbatim-scope` (§13.291) added a bound — *the act must fall inside the period the question names* —
 * and `S17` (`44642788342`) read **98 of 121 against the control's 102**: two conversions, six
 * regressions, exact McNemar p = 0.070. The axis therefore has a price at one end. This ask buys the
 * other end, and the reason it is worth buying is the arm's own artifact rather than the symmetry of
 * the argument.
 *
 * `45543010618` merged (500 of 500 questions, two repetitions, 93.50%) reads `MR` **108 of 121**, and
 * **nine of the thirteen failures carry every gold turn** — `goldOverlap.carried` equals `total` on
 * `gpt4_15e38248`, `gpt4_a56e767c`, `bf659f65`, `9ee3ecd6`, `gpt4_731e37d7`, `37f165cf`,
 * `gpt4_2f8be40d`, `gpt4_31ff4165` and `d851d5ba` — and the four that do not are short by 1, 1, 2 and 5
 * turns. Nothing a ranking change does can reach the nine, so the route's remaining error is a decision.
 *
 * ## What these tests hold
 *
 * The change is a **diff**, so the diff is the assertion: nothing removed, exactly one line added,
 * everything else byte-identical and in order — the same three properties `ask-verbatim-scope.test.ts`
 * holds for the same reason. A line is added rather than substituted because the licence to count a
 * mention and the clock it is counted against are different claims, and a substitution would put two
 * variables between this arm and its control.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import { ASK_CHANGES, ASK_CHANGES_WHEN_DERIVATION, ASK_CONTROLS, ASK_ROUTES } from '../prompt.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

/** A corpus whose dates and acts are both unambiguous, so a line about either can name what it tests. */
const TEXT =
  'I got a snake plant from my sister last month and paid $200 for a writing workshop in November.';

const ENUMERATION_QUESTION = 'How many plants did I acquire in the last month?';
const DERIVATION_QUESTION = 'How many years older is my grandma than me?';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '1';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

async function promptUnder(ask: string, question: string): Promise<string> {
  const seen: string[] = [];
  const memory = new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ask: ask as never,
  });
  await memory.answerSessions(question, [[TEXT]]);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

/** The instruction block: everything the assembly appends after the question line. */
function instructionsOf(prompt: string): string {
  const marker = '\n\nQUESTION: ';
  const at = prompt.lastIndexOf(marker);
  if (at === -1) return prompt;
  return prompt.slice(prompt.indexOf('\n\n', at + marker.length) + 2);
}

async function blocks(): Promise<{ acts: string; clock: string }> {
  return {
    acts: instructionsOf(await promptUnder('verbatim-acts', ENUMERATION_QUESTION)),
    clock: instructionsOf(await promptUnder('verbatim-clock', ENUMERATION_QUESTION)),
  };
}

describe('the diff, which is the treatment', () => {
  it('adds exactly one line and removes nothing', async () => {
    const { acts, clock } = await blocks();
    const before = acts.split('\n');
    const after = clock.split('\n');

    const removed = before.filter((line) => !after.includes(line));
    const added = after.filter((line) => !before.includes(line));

    // Nothing removed is the load-bearing half: the act rule is what `verbatim-acts` was adopted for,
    // and an arm that rewrote it while adding a clock claim would be two variables in one field.
    expect(removed).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]!.split('\n')).toHaveLength(1);
  });

  it('keeps every surviving line in its position', async () => {
    const { acts, clock } = await blocks();
    const before = acts.split('\n');
    const after = clock.split('\n');
    const added = after.filter((line) => !before.includes(line));
    // A line-multiset comparison cannot see a reordering, and "the clock sits beside the exclusion it
    // bounds" is a statement about position.
    expect(after.filter((line) => !added.includes(line))).toEqual(before);
  });

  it('places the clock directly after the exclusion bound it corrects', async () => {
    const { clock } = await blocks();
    const lines = clock.split('\n');
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
    const licence = at('A mention counts when the evidence describes the same ACT');
    const bound = at('Exclude a mention only when the act itself is missing');
    const line = at('A turn is dated by when it was said');
    expect(licence).toBeGreaterThan(-1);
    expect(bound).toBe(licence + 1);
    // Immediately after the bound, because a rule six lines from the sentence it corrects is the
    // positional failure §13.56 measured and §13.132 repaired by moving a licence.
    expect(line).toBe(bound + 1);
  });
});

describe('what the line says', () => {
  it('separates the turn date from the event date', async () => {
    const { clock } = await blocks();
    expect(clock).toContain('A turn is dated by when it was said, not by when the thing happened');
    // The prohibition and its scope, in the reply's own terms: the failure it corrects is a reply
    // writing "outside the window" about a turn date, so the line names that move.
    expect(clock).toContain('that date is never a reason to exclude');
    expect(clock).toContain('not because the turn that reports it is dated outside that period');
  });

  it('keeps the exclusion the evidence does license, so it is not a licence to count everything', async () => {
    const { clock } = await blocks();
    // The act rule's own bound survives byte for byte: the four over-counting failures §13.290's table
    // records are wrong for act, duplicate and actor reasons, and none of them invokes a turn date.
    expect(clock).toContain('does not describe the speaker doing what the question names');
    // And the mention's own words remain a bound, which is what keeps a genuinely out-of-period event
    // out of a period question.
    expect(clock).toContain("the mention's own words place it outside the period");
  });

  it('says what a period is for, rather than deleting it', async () => {
    const { clock } = await blocks();
    expect(clock).toContain('A period says what to look for');
    // The question's period is still read: the line is about which clock settles it, and the answer is
    // the mention's rather than the corpus's synthetic session date.
    expect(clock).toContain(
      'a mention that describes the act counts even when the arithmetic of dates',
    );
  });

  it('still ends at the same cue and still offers the sentinel', async () => {
    const { clock } = await blocks();
    expect(clock).toContain(ABSTAIN_TOKEN);
    expect(clock.trimEnd().endsWith('Answer:')).toBe(true);
  });
});

describe('the reach, stated where the reach is read', () => {
  it('claims the control reach and the multi-session change set', () => {
    expect(ASK_ROUTES['verbatim-clock']).toEqual(ASK_ROUTES['verbatim-acts']);
    expect(ASK_CHANGES['verbatim-clock']).toEqual(['multi-session']);
    expect(ASK_CHANGES_WHEN_DERIVATION['verbatim-clock']).toEqual([]);
  });

  it('is measured against verbatim-acts rather than against the rejected bound', () => {
    // `verbatim-scope` would put an addition and a subtraction in one field: that arm carries a bound
    // this one removes, and the pair would price neither.
    expect(ASK_CONTROLS['verbatim-clock']).toBe('verbatim-acts');
    expect(ASK_CONTROLS['verbatim-scope']).toBe('verbatim-acts');
  });

  it('leaves a derivation question on the control, byte for byte', async () => {
    const clock = instructionsOf(await promptUnder('verbatim-clock', DERIVATION_QUESTION));
    const acts = instructionsOf(await promptUnder('verbatim-acts', DERIVATION_QUESTION));
    expect(clock).toBe(acts);
    // The derivation population reads the adopted `operands` block, where the act rule is not present.
    expect(clock).not.toContain('A turn is dated by when it was said');
  });

  it('leaves the question line and the evidence where they were', async () => {
    const acts = await promptUnder('verbatim-acts', ENUMERATION_QUESTION);
    const clock = await promptUnder('verbatim-clock', ENUMERATION_QUESTION);
    // The only difference in the whole prompt is the instruction block: an arm that also moved the
    // evidence would be pricing two mechanisms, and the added line's length is inside the block the
    // budget does not spend on turns.
    expect(clock.split('\n\nQUESTION: ')[0]).toBe(acts.split('\n\nQUESTION: ')[0]);
  });
});

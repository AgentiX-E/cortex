/**
 * The act rule's third claim: the period and the actor — §13.291.
 *
 * ## Why a second line-level ask
 *
 * §13.289 read `MR`'s twenty-seven failures on `42310779222` and found eighteen **below** the gold
 * against four above, eight of the eighteen explained in the reply's own words by a verb-identity
 * exclusion. `verbatim-acts` replaced that line and removed the bias. The same decomposition, run on
 * the shipped arm's own artifact (`S16`, `44017278305`, four repetitions), now counts the route's
 * nineteen failures **nine below and five above** -- the omission much reduced, and five clean
 * over-counts that no earlier ask was written for.
 *
 * A symmetric error is a different defect from a one-sided one, and the replies say which: the seven
 * above-gold enumerations admit mentions the question's *scope* excludes. `gpt4_2f8be40d` answers `5`
 * for a year's weddings and its Step 1 lists a college roommate's, a sister's, and a cousin's whose own
 * line reads *"same event as 'cousin's wedding last month'"*. `d851d5ba` answers `$8,750` for a total
 * whose gold is `$3,750`, and the extra `$5,000` is *"event raised over $5,000"* — the event raised it.
 * `88432d0a` answers `5` and writes *"also mentioned 2023/05/24; counted once"* about a mention it then
 * counted twice.
 *
 * ## Measured on `S17` (`44642788342`) and rejected
 *
 * 98 of 121 against the control's 102: two converted, six regressed, exact McNemar p = 0.070. The
 * tests below still hold what they always held -- the render is one line -- and that is the point of
 * keeping them: the variable was clean and the direction was wrong, which is a fact about the
 * benchmark's annotation rather than about this file. `SCOPE_BOUND_LINE`'s docblock carries the pair
 * of gold totals that cannot both come from one rule.
 *
 * ## What these tests hold
 *
 * The change is a **diff**, so the diff is the assertion: nothing removed, exactly one line added,
 * everything else byte-identical and in order. The line is added rather than substituted because the
 * licence and its bound are different claims — the same argument `ACT_RULE_LINES` states for its own
 * two lines — and because a substitution would put two variables between this arm and its control.
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

/** A corpus whose period is unambiguous, so a period test can name what it is testing. */
const TEXT = 'I raised $250 at a bake sale on 2023/03/20 and planned another for next month.';

const ENUMERATION_QUESTION = 'How much money did I raise for charity in total?';
const DERIVATION_QUESTION = 'How many years older is my grandma than me?';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '250';
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

async function blocks(): Promise<{ acts: string; scope: string }> {
  return {
    acts: instructionsOf(await promptUnder('verbatim-acts', ENUMERATION_QUESTION)),
    scope: instructionsOf(await promptUnder('verbatim-scope', ENUMERATION_QUESTION)),
  };
}

describe('the diff, which is the treatment', () => {
  it('adds exactly one line and removes nothing', async () => {
    const { acts, scope } = await blocks();
    const before = acts.split('\n');
    const after = scope.split('\n');

    const removed = before.filter((line) => !after.includes(line));
    const added = after.filter((line) => !before.includes(line));

    // Nothing removed is the load-bearing half: substituting a line would re-open the one-sided-error
    // reading §13.289 closed, and no artifact could say which of the two changes earned a delta.
    expect(removed).toEqual([]);
    expect(added).toHaveLength(1);
    // And one line means one line: a prompt whose block grew by a paragraph would be a second variable
    // the change set cannot name.
    expect(added[0]!.split('\n')).toHaveLength(1);
  });

  it('keeps every surviving line in its position', async () => {
    const { acts, scope } = await blocks();
    const before = acts.split('\n');
    const after = scope.split('\n');
    const added = after.filter((line) => !before.includes(line));
    // A line-multiset comparison cannot see a reordering, and the assembly's ordering is what makes
    // "the licence sits nearest the close" true.
    expect(after.filter((line) => !added.includes(line))).toEqual(before);
  });

  it('places the bound beside the rule it bounds', async () => {
    const { scope } = await blocks();
    const lines = scope.split('\n');
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
    const licence = at('A mention counts when the evidence describes the same ACT');
    const bound = at('Two bounds apply to a mention that otherwise matches');
    expect(licence).toBeGreaterThan(-1);
    // Immediately after the exclusion bound rather than anywhere in the block: a rule six lines from
    // its own bound is the positional failure §13.56 measured and §13.132 repaired by moving a licence.
    expect(bound).toBe(licence + 2);
  });
});

describe('what the bound says', () => {
  it('names the period and defers its resolution to the question', async () => {
    const { scope } = await blocks();
    expect(scope).toContain('The act must fall inside the period the question names');
    expect(scope).toContain('"this year"');
    expect(scope).toContain('"the past two weeks"');
    // The clock is the reader's: this arm has no calendar the reader does not also have, and inventing
    // one here would be a second clock beside `annotateSessionBoundaries`.
    expect(scope).toContain('read from the question');
  });

  it('bounds the actor without demanding sole agency', async () => {
    const { scope } = await blocks();
    // The gold's own arithmetic decides this: $1,000 + $250 + $500 + $2,000 = $3,750 counts a
    // fundraiser the speaker "helped raise" and excludes one the *event* raised. A stricter rule would
    // re-open the under-count `verbatim-acts` was adopted to close.
    expect(scope).toContain('an amount an event raised is not an amount the speaker raised');
    expect(scope).toContain('though one the speaker helped raise is');
  });

  it('gives a question with no period the whole conversation', async () => {
    const { scope } = await blocks();
    // Without this clause the bound would be an exclusion licence on every question that names no
    // window, which is most of them — the one-sided under-count returning through a new door.
    expect(scope).toContain('a question that names no period covers the whole conversation');
  });

  it('still ends at the same cue and still offers the sentinel', async () => {
    const { scope } = await blocks();
    expect(scope).toContain(ABSTAIN_TOKEN);
    expect(scope.trimEnd().endsWith('Answer:')).toBe(true);
  });
});

describe('the reach, stated where the reach is read', () => {
  it('claims the control reach and the multi-session change set', () => {
    expect(ASK_ROUTES['verbatim-scope']).toEqual(ASK_ROUTES['verbatim-acts']);
    expect(ASK_CHANGES['verbatim-scope']).toEqual(['multi-session']);
    expect(ASK_CHANGES_WHEN_DERIVATION['verbatim-scope']).toEqual([]);
  });

  it('is measured against verbatim-acts rather than against the block it derives from', () => {
    // `verbatim` would make the control the grandparent of the render: two variables — the
    // substitution line and the bound — in a run whose entire value is that it has one.
    expect(ASK_CONTROLS['verbatim-scope']).toBe('verbatim-acts');
  });

  it('leaves a derivation question on the control, byte for byte', async () => {
    const scope = instructionsOf(await promptUnder('verbatim-scope', DERIVATION_QUESTION));
    const acts = instructionsOf(await promptUnder('verbatim-acts', DERIVATION_QUESTION));
    expect(scope).toBe(acts);
    // The derivation population reads the adopted `operands` block, so neither this line nor the
    // substitution line is in its prompt.
    expect(scope).not.toContain('same ACT under a different verb');
  });

  it('leaves the question line and the evidence where they were', async () => {
    const acts = await promptUnder('verbatim-acts', ENUMERATION_QUESTION);
    const scope = await promptUnder('verbatim-scope', ENUMERATION_QUESTION);
    // The only difference in the whole prompt is the instruction block: an arm that also moved the
    // evidence would be pricing two mechanisms.
    expect(scope.split('\n\nQUESTION: ')[0]).toBe(acts.split('\n\nQUESTION: ')[0]);
  });
});

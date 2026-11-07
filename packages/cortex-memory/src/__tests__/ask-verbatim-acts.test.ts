/**
 * One line of the reference's aggregation contract, replaced — §13.290.
 *
 * ## Why an ask whose whole content is one line
 *
 * §13.289 read `42310779222`'s twenty-seven `MR` failures and found eighteen of them **below** the
 * gold and four above. A one-sided error is the signature of a missing item. Eight of the eighteen are
 * explained by the reply's own stated exclusion, and every one of those exclusions is licensed by a
 * single line of the block this arm adopted in §13.246: *"Do NOT substitute or infer a different verb"*.
 * `bc149d6b` excluded a 20-pound bag because the question said "purchased" and the evidence said
 * "bought"; 50 + 20 = 70 is the gold, exactly. `129d1232` excluded a $600 event because the evidence
 * said "helped organize"; $5,250 + $600 = $5,850 is the gold, exactly.
 *
 * So the experiment is that line. Not the block, not the ask's shape, not the window.
 *
 * ## What these tests hold
 *
 * The change is a **diff**, so the diff is the assertion: one line removed, two added, everything else
 * byte-identical and in order. A test that only checked the new sentence exists would pass on a block
 * that had also drifted somewhere else, and the drift is what the verbatim migration exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { buildAggregationQaPrompt } from '@agentix-e/cortex-eval';

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

const TEXT = 'I bought a 1/48 scale Spitfire kit and finished it in two weeks.';

const ENUMERATION_QUESTION = 'How many kits do I own?';
const DERIVATION_QUESTION = 'How many years older is my grandma than me?';

/** The line the ask replaces, and the two it puts in its place. */
const VERB_RULE = '  - Do NOT substitute or infer a different verb:';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '2';
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

async function blocks(): Promise<{ verbatim: string; acts: string }> {
  return {
    verbatim: instructionsOf(await promptUnder('verbatim', ENUMERATION_QUESTION)),
    acts: instructionsOf(await promptUnder('verbatim-acts', ENUMERATION_QUESTION)),
  };
}

describe('the diff, which is the treatment', () => {
  it('removes exactly the verb rule and adds exactly two lines', async () => {
    const { verbatim, acts } = await blocks();
    const before = verbatim.split('\n');
    const after = acts.split('\n');

    const removed = before.filter((line) => !after.includes(line));
    const added = after.filter((line) => !before.includes(line));

    expect(removed).toEqual([before.find((line) => line.startsWith(VERB_RULE))]);
    expect(added).toHaveLength(2);
    // And every surviving line keeps its position: a reordering would be a second variable that the
    // line-multiset comparison cannot see.
    expect(after.filter((line) => !added.includes(line))).toEqual(
      before.filter((line) => !removed.includes(line)),
    );
  });

  it('anchors on a line the reference block actually has, exactly once', async () => {
    const { verbatim } = await blocks();
    const matching = verbatim.split('\n').filter((line) => line.startsWith(VERB_RULE));
    expect(matching).toHaveLength(1);
    // The ask is a no-op if the anchor ever disappears, and a silent no-op is a dispatched treatment
    // the artifact would report and the prompt would not carry.
    expect(verbatim).toContain(VERB_RULE);
  });

  it("leaves the reference pipeline's own text untouched", () => {
    // The migrated block is held to line equality with the reference. Editing it in place would have
    // been the same experiment with the migration check quietly weakened, so the rewrite is derived
    // and the reference keeps its sentence.
    expect(buildAggregationQaPrompt('<q>', '<c>', ABSTAIN_TOKEN)).toContain(
      'Do NOT substitute or infer a different verb',
    );
  });
});

describe('what the replacement says', () => {
  it('names the verbs the measured failures were excluded on', async () => {
    const { acts } = await blocks();
    // Each pair is one row of §13.289.4's table, and the pairing is the argument: these are the same
    // act under two words, not two acts.
    for (const pair of [
      '"bought" is "purchased"',
      '"made" is "baked"',
      '"attended"',
      '"participated"',
    ]) {
      expect(acts).toContain(pair);
    }
    expect(acts).toContain('"went on" or "volunteered at" is "attended"');
    expect(acts).toContain('"helped organise" is "participated"');
  });

  it('keeps a bound, so "same act" cannot become "any act"', async () => {
    const { acts } = await blocks();
    expect(acts).toContain('Exclude a mention only when the act itself is missing');
    // The four above-gold failures are the direction an unbounded licence moves in, so the
    // anti-invention half has to survive the swap.
    expect(acts).toContain('do not add one the evidence does not describe');
    // And the clock, because `7024f17c` excluded a session for tense rather than for act.
    expect(acts).toContain('hoped for but not done is not done');
  });

  it('still ends at the same cue and still offers the sentinel', async () => {
    const { acts } = await blocks();
    expect(acts).toContain(ABSTAIN_TOKEN);
    expect(acts.trimEnd().endsWith('Answer:')).toBe(true);
  });
});

describe('the reach, stated where the reach is read', () => {
  it("claims verbatim's reach and the multi-session change set", () => {
    expect(ASK_ROUTES['verbatim-acts']).toEqual(ASK_ROUTES.verbatim);
    expect(ASK_CHANGES['verbatim-acts']).toEqual(['multi-session']);
    expect(ASK_CHANGES_WHEN_DERIVATION['verbatim-acts']).toEqual([]);
  });

  it('is measured against verbatim rather than against the shipped block', () => {
    // The control is the arm's adopted value, so the comparison is one line rather than one line plus
    // the whole migration.
    expect(ASK_CONTROLS['verbatim-acts']).toBe('verbatim');
  });

  it('leaves a derivation question on the control, byte for byte', async () => {
    const acts = instructionsOf(await promptUnder('verbatim-acts', DERIVATION_QUESTION));
    const verbatim = instructionsOf(await promptUnder('verbatim', DERIVATION_QUESTION));
    expect(acts).toBe(verbatim);
    // The reference's derivation builder is a different prompt and moving it would be a second
    // experiment; §13.290 registers one.
    expect(acts).not.toContain('same ACT under a different verb');
  });
});

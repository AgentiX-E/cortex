/**
 * `derive` moves one sentence and changes nothing else, and that is checkable in bytes.
 *
 * ## Why the claim needs its own file
 *
 * §13.132 registers a run whose single variable is the **position** of the licence to combine
 * evidence across turns: `derive` and `enumerated` contain the same sentences, and in `derive` the
 * licence is the last thing read. A registration like that is only attributable if the two blocks
 * differ *nowhere else*, and "nowhere else" is not something a docblock can promise. So the
 * assertion here is not that the licence appears -- it appears in both -- but that the two blocks
 * are **permutations of one another**: same lines, same counts, different order.
 *
 * A reworded licence fails this file. A duplicated one fails it. A strengthening clause fails it. An
 * ask that quietly also moved Step 2 fails it. Those are exactly the edits that would turn a
 * one-variable run into a bundled one, and §13.104 is the campaign's own record of a bundled prompt
 * edit whose every part was reasonable and whose result was unreadable.
 *
 * ## The reading it is written against
 *
 * Twelve MR declines on the control `40751394094`, none correct, ten of them questions the reference
 * pipeline answers, every one carrying its gold turns. The refusal is the same in eleven of them:
 * the model found the pieces and would not join them, and two quote the enumeration contract's own
 * "do not merge two items into one" back as their reason. `MERGING_SENTENCE` is the sentence that
 * licenses joining, and `enumerated` puts it six lines above the closing rule -- behind the contract
 * that says "do not merge". §13.56 measured the shape of that failure once already.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import { ASK_CHANGES, ASK_CONTROLS, ASK_ROUTES, type EvidenceAsk } from '../prompt.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const TEXT = 'I bought a 1/48 scale Spitfire kit.';

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Spitfire';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function build(seen: string[], ask: EvidenceAsk): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ask,
  });
}

/** The instruction block: from the first instruction line to the end of the prompt. */
function instructionsOf(prompt: string): string {
  const at = prompt.indexOf('Answer the question');
  return at === -1 ? prompt : prompt.slice(at);
}

async function sessionBlock(ask: EvidenceAsk): Promise<string> {
  const seen: string[] = [];
  await build(seen, ask).answerSessions('How many kits do I own?', [[TEXT]]);
  expect(seen).toHaveLength(1);
  return instructionsOf(seen[0]!);
}

/** Flatten a prompt to an instruction block, one line per line, blank lines dropped. */
function lines(block: string): string[] {
  return block.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * The licence to combine, copied here rather than imported.
 *
 * Deliberately a literal: importing `MERGING_SENTENCE` would make the test agree with the
 * implementation by construction, and the whole point is that a *reworded* licence must fail. The
 * price is that editing the sentence requires editing this string, which is the correct price --
 * the sentence is the variable.
 */
const LICENCE = `The answer may require combining evidence from more than one turn or session: gather every relevant piece first, then compute the answer. Do not reply ${ABSTAIN_TOKEN} merely because no single piece states the answer outright.`;

/** The abstention rule `enumerated` states and `derive` must not weaken. */
const LIST_EMPTY_RULE = `Reply ${ABSTAIN_TOKEN} only when the Step 1 list is empty.`;

describe('derive is enumerated with one line moved', () => {
  it('renders the same lines as enumerated, in a different order', async () => {
    const derive = lines(await sessionBlock('derive'));
    const enumerated = lines(await sessionBlock('enumerated'));

    // Same multiset: no sentence added, none dropped, none reworded, none duplicated.
    expect([...derive].sort()).toEqual([...enumerated].sort());
    // Different sequence: the order is the treatment, so the blocks must not be equal.
    expect(derive).not.toEqual(enumerated);
  });

  it('puts the licence immediately above the closing line, where enumerated does not', async () => {
    const derive = lines(await sessionBlock('derive'));
    const enumerated = lines(await sessionBlock('enumerated'));

    // Adjacency to the close is the whole hypothesis: a rule placed above the closing rule loses to
    // it, which is §13.56's measurement and the reason `withReplacedClose` exists at all.
    expect(derive.at(-2)).toBe(LICENCE);
    expect(enumerated.at(-2)).not.toBe(LICENCE);
  });

  it('keeps the licence exactly once in both, so nothing was duplicated to make room', async () => {
    expect(lines(await sessionBlock('derive')).filter((line) => line === LICENCE)).toHaveLength(1);
    expect(lines(await sessionBlock('enumerated')).filter((line) => line === LICENCE)).toHaveLength(
      1,
    );
  });

  it('leaves the abstention condition as tight as the control states it', async () => {
    // The licence must not be bought by loosening the decline rule. §13.103 bought it that way --
    // "reply INSUFFICIENT_EVIDENCE only when the evidence says nothing about the question" -- and
    // run `39641088296` measured abstentions *rising* from 10 to 16 under it.
    const derive = lines(await sessionBlock('derive'));
    expect(derive.some((line) => line.startsWith(LIST_EMPTY_RULE))).toBe(true);
    expect(derive.at(-1)).toContain(ABSTAIN_TOKEN);
    expect(derive.at(-1)).toContain('Step 1 list is empty');
  });

  it('still tells the reader not to merge two items, because that rule is not the variable', async () => {
    const derive = lines(await sessionBlock('derive'));
    expect(derive.some((line) => line.includes('do not merge two items into one'))).toBe(true);
  });

  it('is registered against enumerated and changes the multi-session route alone', () => {
    expect(ASK_CONTROLS.derive).toBe('enumerated');
    expect(ASK_CHANGES.derive).toEqual(['multi-session']);
    expect(ASK_ROUTES.derive).toEqual(ASK_ROUTES.enumerated);
  });
});

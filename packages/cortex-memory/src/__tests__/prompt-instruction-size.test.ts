/**
 * The instruction block is a constant, and the constant is small.
 *
 * ## What this pins, and the claim it corrects
 *
 * `PREREGISTRATION` §13.225 read `promptChars - windowComposition.offeredChars` on the anchor
 * artifact and concluded that the instruction block was eating 8.8k characters on MR and 10.3k on
 * TR -- "≈ 41 turns of evidence". That reading was used to order the next round's work: a prompt
 * diet, ranked above `maxTurnChars` and above the pool width.
 *
 * The subtraction does not mean that. `offeredChars` is the scored part of the delivery, not the
 * whole delivery, so the difference is evidence the record does not attribute to a scored turn --
 * and it scales with the number of turns, which a fixed instruction block cannot. Measured against
 * the code that writes the block, the constant is **339 characters** on the abstention contract and
 * **595** on temporal (the date frame and its instruction). Two orders of magnitude below the
 * attributed figure, and it does not grow.
 *
 * ## Why a size ceiling is a test rather than a comment
 *
 * The ceiling is the falsifiable form of the sentence §13.230 now states: while the block stays
 * under it, the character budget is spent on evidence and no instruction diet can matter. If
 * someone adds a paragraph to the contract, this fails and the arithmetic in §13.230 has to be
 * redone rather than silently invalidated -- which is exactly what happened to §13.225, where a
 * number nobody re-derived outlived the code it described.
 */
import { describe, expect, it } from 'vitest';

import type { AdmittedTurn } from '../admission.js';
import { buildPrompt } from '../prompt.js';

/** `count` turns of `length` content characters, alternating between two sessions. */
function turns(count: number, length: number): AdmittedTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${String(index)}`,
    content: `user: ${'x'.repeat(length)}`,
    value: 0.8,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic',
    tags: [],
    createdAt: 0,
    lastAccessedAt: 0,
    stability: 1,
    difficulty: 5,
    reads: 0,
    sessionId: `s${String(index % 2)}`,
    ordinal: index,
  })) as unknown as AdmittedTurn[];
}

const QUESTION = 'Q'.repeat(40);

/**
 * Everything in the prompt that is not the question and not the evidence.
 *
 * Both terms are exact: `evidenceChars` is what the renderer produced for the delivered turns, and
 * the question is the string that was asked. What is left is the instruction block plus the labels
 * (`EVIDENCE:`, `QUESTION: `) and the four separating newlines.
 */
function overhead(contract: string, count: number, ask: string): number {
  const prompt = buildPrompt(
    QUESTION,
    turns(count, 100),
    contract as never,
    {
      ask: ask as never,
    } as never,
  );
  return prompt.prompt.length - prompt.evidenceChars - QUESTION.length;
}

describe('the instruction block is a constant, not a share of the budget', () => {
  it('does not grow when the delivery grows', () => {
    // The claim the artifact's residual cannot support: a component that adds characters per turn
    // would fail this, and a fixed block cannot. `41393748964`'s lesson one layer over -- the
    // number that was quoted had never been measured against the code that produces it.
    expect(overhead('abstention-evidence-blocks', 40, 'operands+operand-gap')).toBe(
      overhead('abstention-evidence-blocks', 2, 'operands+operand-gap'),
    );
  });

  it('stays under 400 characters on the abstention contract', () => {
    // 339 today. The ceiling is a claim rather than a copy of the value: 400 is one MR turn of
    // median length (`§13.34.3`: 272 characters, p90 2,305), which is the size at which an
    // instruction diet would become worth discussing at all.
    expect(overhead('abstention-evidence-blocks', 10, 'operands+operand-gap')).toBeLessThan(400);
  });

  it('stays under 700 characters on the temporal contract', () => {
    // 595 today, and the 256 extra are the date frame: `questionDate` is rendered into the prompt
    // so the reader can resolve "last week" -- an instruction that buys an answer rather than one
    // that eats a turn.
    const prompt = buildPrompt(
      QUESTION,
      turns(10, 100),
      'temporal' as never,
      {
        ask: 'operands+operand-gap' as never,
        questionDate: '2023/05/20' as never,
      } as never,
    );
    expect(prompt.prompt.length - prompt.evidenceChars - QUESTION.length).toBeLessThan(700);
  });

  it('costs fewer characters than two median MR turns', () => {
    // The comparison §13.225 made in the other direction. Two turns at the median is 544
    // characters; the whole instruction block on the contract the MR route runs is well under it,
    // so "trim the instructions" cannot be a lever worth a dispatch.
    const perTurn = 272;
    expect(overhead('abstention-evidence-blocks', 10, 'operands+operand-gap')).toBeLessThan(
      2 * perTurn,
    );
  });
});

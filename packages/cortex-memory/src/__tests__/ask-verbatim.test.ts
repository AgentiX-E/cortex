/**
 * The reference pipeline's aggregation contract, migrated whole — §13.246.
 *
 * ## Why this file is an audit with a diff in it
 *
 * §13.123.3 read the reference pipeline's multi-session ask off `conInstruction` — *"Work in two
 * steps, but write ONLY the final answer"* — and built `silent` to copy it. `conInstruction` is the
 * **single-session** skeleton (`buildQaPrompt` and its siblings call it). The multi-session path
 * calls `buildAggregationQaPrompt`, which opens with *"Step 1 — Enumerate every item matching the
 * question's EXACT action, one per line"*. So `silent` removed the behaviour the reference has, its
 * −26 questions measured the removal, and §13.240.4 read the same sentence a second time to nominate
 * "the reference's ask" as the last MR experiment — an ask the reference does not use.
 *
 * The first two tests below are that correction stated as an executable fact about the reference's
 * own source. Without them the misreading is a paragraph, and a paragraph is what got repeated. The
 * third is the migration itself: line equality against the builder, so the block cannot drift into a
 * paraphrase while still calling itself verbatim.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import {
  buildAggregationQaPrompt,
  buildDerivationQaPrompt,
  buildQaPrompt,
  classifyAggregationKind,
} from '@agentix-e/cortex-eval';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import { ASK_CHANGES, ASK_CHANGES_WHEN_DERIVATION, ASK_ROUTES } from '../prompt.js';

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

describe('what the reference pipeline actually asks on the multi-session route', () => {
  it('enumerates in writing, which is the opposite of what §13.123.3 recorded', () => {
    // Rendered with this package's own token, so the comparison below needs no substitution.
    const reference = buildAggregationQaPrompt('<question>', '<context>', ABSTAIN_TOKEN);

    expect(reference).toContain(
      "Step 1 — Enumerate every item matching the question's EXACT action",
    );
    expect(reference).toContain('Work in two steps.');
    expect(reference).not.toContain('write ONLY the final answer');
    // The terminal contract, which is the half `enumerated` never had.
    expect(reference).toContain('  Answer: <final answer>');
  });

  it('keeps the silent Step 1 for the single-session prompts, which is where the quote came from', () => {
    const singleSession = buildQaPrompt('<question>', '<context>', ABSTAIN_TOKEN);

    expect(singleSession).toContain('Work in two steps, but write ONLY the final answer.');
    expect(singleSession).toContain('Keep those notes to yourself; do NOT write them out.');
    // And the routing decision that separates them, stated on the data rather than on the prose.
    expect(classifyAggregationKind(ENUMERATION_QUESTION)).toBe('enumeration');
    expect(classifyAggregationKind(DERIVATION_QUESTION)).toBe('derivation');
  });
});

describe('ask=verbatim is the reference aggregation builder, line for line', () => {
  it('renders the reference block unchanged, with the question left for the assembly', async () => {
    const prompt = await promptUnder('verbatim', ENUMERATION_QUESTION);
    const block = instructionsOf(prompt);

    // The reference emits its instructions, then `Context:`, then `Question:`, then a bare `Answer:`
    // cue. Taking everything before `Context:` and appending that cue is the whole of the reference's
    // instruction text; the two alignment lines are this assembly's job.
    const reference = buildAggregationQaPrompt('<question>', '<context>', ABSTAIN_TOKEN);
    const lines = reference.split('\n');
    const at = lines.indexOf('Context:');
    expect(at).toBeGreaterThan(0);
    const expected = [...lines.slice(0, at), 'Answer:'].join('\n');

    expect(block).toBe(expected);
    // The cue is the last thing the reader sees, which is what makes the reference's reply shape a
    // property of the prompt rather than of a parser convention.
    expect(prompt.endsWith('\nAnswer:')).toBe(true);
  });

  it('leaves a derivation question on the control block, because that is a different builder', async () => {
    const verbatim = instructionsOf(await promptUnder('verbatim', DERIVATION_QUESTION));
    const control = instructionsOf(await promptUnder('operands+operand-gap', DERIVATION_QUESTION));

    expect(verbatim).toBe(control);
    // And the reference's *other* builder is the one that would have been migrated if the ask had
    // claimed the derivation half, which is the comparison this ask declines to confound.
    expect(buildDerivationQaPrompt('<q>', '<c>', ABSTAIN_TOKEN)).toContain(
      'Step 1 — Identify the specific numbers the question needs',
    );
  });

  it('is a different ask from `silent`, which is the one that was measured against nothing', async () => {
    const verbatim = instructionsOf(await promptUnder('verbatim', ENUMERATION_QUESTION));
    const silent = instructionsOf(await promptUnder('silent', ENUMERATION_QUESTION));
    const enumerated = instructionsOf(await promptUnder('enumerated', ENUMERATION_QUESTION));

    expect(verbatim).not.toBe(silent);
    expect(verbatim).not.toBe(enumerated);
    // The two properties §13.34 shrank and §13.123 removed altogether: the list is written, and the
    // reply has a named shape. `silent` has neither, which is why its −26 says nothing about this.
    expect(verbatim).toContain('one per line');
    expect(silent).not.toContain('one per line');
    expect(verbatim).toContain('Answer: <final answer>');
    expect(enumerated).not.toContain('Answer: <final answer>');
  });
});

describe('the registration of ask=verbatim', () => {
  it('declares the registered arm reach, and one route as its change set', () => {
    // Reach is measured against the shipped block, so the three routes the registered arm moved stay
    // moved under this value; the change set is measured against that arm and is one route.
    expect(ASK_ROUTES.verbatim).toEqual(['multi-session', 'flat', 'temporal', 'abstention']);
    expect(ASK_CHANGES.verbatim).toEqual(['multi-session']);
  });

  it('declares an empty change set on a derivation question, which is a claim and not an omission', () => {
    expect(ASK_CHANGES_WHEN_DERIVATION.verbatim).toEqual([]);
  });
});

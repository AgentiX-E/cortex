/**
 * Which routes does the §12.5 prompt contract actually reach?
 *
 * ## The measurement this file pins
 *
 * Dispatch `37804673104` (master `bcf66463`, `limit=120`, `ablation_runs=1`) ran the
 * arm with `promptContract = 'abstention-evidence-blocks'` and produced the first
 * artifact carrying both a complete roster and the raw model output. Its numbers:
 *
 *     capability   baseline    feature     b+f-   b-f+
 *     MR           13/17       0/17          13       0
 *     TR           15/17       0/17          15       0
 *     IE            0/52       0/52           0       0
 *     KU            0/17       0/17           0       0
 *     ABS          17/17      17/17           0       0
 *     total            45          17          28       0
 *
 * `b-f+ = 0` on every capability, which is §12.4's finding reproduced exactly, and
 * now with the raw output attached: 116 of the 120 records carry a bare
 * `INSUFFICIENT_EVIDENCE` and 116 answers are `null`. The parse is faithful, the
 * model really declined, and the gate really admitted -- all three were measured
 * separately.
 *
 * ## What that leaves, and why this file exists
 *
 * The registration calls `abstention-evidence-blocks` "§12.5's single variable". A
 * variable is only independent if the arm it is supposed to move is the arm that
 * receives it, and `memory.ts` substitutes the contract on exactly one condition:
 *
 *     contract === 'abstention' && options.promptContract !== undefined
 *
 * `runBenchmark` dispatches `answerAbstention` for `capability === 'ABS'` only. So
 * the substitution reaches 17 of the 120 questions -- and ABS gold IS abstention,
 * which means the questions the variable can reach are the questions where
 * declining is the correct answer.
 *
 * That is the reason `b-f+ = 0` above is not evidence about the variable. The
 * 28-question loss is on MR, TR, IE and KU, none of which contains the rendering
 * the experiment installed. These tests pin the reach so the next dispatch is
 * designed against it rather than discovering it after the fact.
 *
 * ## Why this is asserted as behaviour and not as a comment
 *
 * The reach is a property of two files in different packages -- the substitution in
 * `memory.ts` and the dispatch in `benchmark.ts` -- and neither mentions the other.
 * A test that pinned the string `abstention-evidence-blocks` would pass on a broken
 * arm, because the name is in the source either way. These tests drive the paths and
 * read the prompt.
 */

import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { PROMPT_CONTRACTS, buildPrompt } from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

const NOW = 1_759_470_000_000;

/** The gate values the artifact records, so the fixture is the dispatched run. */
const ARM_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

/** The contract the artifact records. */
const ARM_CONTRACT = 'abstention-evidence-blocks' as const;

function evidence(): AdmittedTurn[] {
  return [
    {
      ...createMemory({ content: 'I bought a 1/48 scale Spitfire kit.' }),
      ordinal: 0,
    },
  ];
}

const TURNS = evidence();

/** An LLM that records every prompt it is asked. */
function recorder(seen: string[], answer: string): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return answer;
    },
    // Required by `LLM` and unused here, matching the stub in
    // `prompt-contract-switch.test.ts`. Throwing rather than returning a stub
    // value means a future change that started calling it would fail loudly
    // instead of silently measuring a fabricated response.
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function arm(seen: string[], answer = 'Spitfire'): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen, answer),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...ARM_GATE },
    promptContract: ARM_CONTRACT,
  });
}

/**
 * Does the installed rendering appear in the prompt?
 *
 * The renderer's signature is a bracketed identifier beside the index
 * (`` `1. [id] text` ``). It is matched by SHAPE rather than against the fixture's
 * own `id`, and the reason is measured rather than assumed: `answerAbstention`
 * admits its context through `admitTurns`, which derives a memory from the turn
 * TEXT and therefore mints a new id. A test comparing `TURNS[0].id` to the prompt
 * would fail on a correctly working switch -- which is exactly what the first
 * draft did. The shape is what the renderer emits and what the baseline renderer
 * never emits, so it separates them without depending on identity.
 *
 * The instruction block is byte-identical between the two abstention contracts by
 * design (`prompt.ts`, "Why the ask is identical and only the evidence changes"),
 * so the evidence rendering is the only thing that can mark the substitution.
 */
const SOURCE_RENDERING = /^\d+\. \[[0-9a-f-]{36}\] /m;

function hasSourceRendering(prompt: string): boolean {
  return SOURCE_RENDERING.test(prompt);
}

describe('the prompt-contract switch reaches exactly one route', () => {
  it('reaches the abstention route', async () => {
    const seen: string[] = [];
    await arm(seen).answerAbstention('What is my passport number?', [
      'I bought a 1/48 scale Spitfire kit.',
    ]);

    expect(seen).toHaveLength(1);
    expect(hasSourceRendering(seen[0]!)).toBe(true);
  });

  it('does NOT reach the knowledge-update route', async () => {
    // The route runs through the same `#prompt` private method the substitution
    // lives in, and is still not substituted, because the condition also names
    // `contract === 'abstention'`. This is the assertion that separates "the
    // switch works" from "the switch works everywhere".
    const seen: string[] = [];
    await arm(seen).answerKnowledgeUpdate('How many kits do I own now?', [
      'I bought a 1/48 scale Spitfire kit.',
    ]);

    expect(seen).toHaveLength(1);
    expect(hasSourceRendering(seen[0]!)).toBe(false);
  });

  it('does NOT reach the temporal route', async () => {
    const seen: string[] = [];
    await arm(seen).answerTemporal(
      'How long ago did I buy it?',
      ['I bought a 1/48 scale Spitfire kit.'],
      '2023/06/01',
    );

    expect(seen).toHaveLength(1);
    expect(hasSourceRendering(seen[0]!)).toBe(false);
  });

  it('does NOT reach the multi-session route', async () => {
    // MR is the largest single-capability loss in the artifact (13 of the 28),
    // so whether the rendering reaches this route is not academic.
    const seen: string[] = [];
    await arm(seen).answerSessions('Which kit did I buy?', [
      ['I bought a 1/48 scale Spitfire kit.'],
    ]);

    expect(seen).toHaveLength(1);
    expect(hasSourceRendering(seen[0]!)).toBe(false);
  });

  it('does NOT reach the assistant route', async () => {
    const seen: string[] = [];
    await arm(seen).answerAssistant('What did you tell me about the kit?', [
      'I bought a 1/48 scale Spitfire kit.',
    ]);

    expect(seen).toHaveLength(1);
    expect(hasSourceRendering(seen[0]!)).toBe(false);
  });

  it('does NOT reach the flat path', async () => {
    const seen: string[] = [];
    await arm(seen).answer('What did I buy?', ['I bought a 1/48 scale Spitfire kit.']);

    expect(seen).toHaveLength(1);
    expect(hasSourceRendering(seen[0]!)).toBe(false);
  });
});

describe('the rendering is the only difference between the two abstention contracts', () => {
  it('the instruction blocks are byte-identical', () => {
    // The registration depends on this. If the instruction text changed with the
    // rendering, a movement in MR could not be attributed to the rendering, and
    // the run would test two variables while naming one.
    const withBaseline = buildPrompt('q', TURNS, 'abstention');
    const withCandidate = buildPrompt('q', TURNS, ARM_CONTRACT);

    const instructions = (prompt: string) => prompt.slice(prompt.indexOf('Answer the question'));
    expect(instructions(withCandidate)).toBe(instructions(withBaseline));
  });

  it('the evidence blocks differ, and by the source id only', () => {
    // These two call `buildPrompt` directly with the FIXTURE, so the fixture's
    // own id is the right thing to look for here -- unlike the route tests above,
    // where `admitTurns` mints a fresh id from the turn text.
    const withBaseline = buildPrompt('q', TURNS, 'abstention');
    const withCandidate = buildPrompt('q', TURNS, ARM_CONTRACT);

    expect(withCandidate).not.toBe(withBaseline);
    expect(withCandidate).toContain(`[${TURNS[0]!.id}]`);
    expect(withBaseline).not.toContain(`[${TURNS[0]!.id}]`);
    // The turn text is present in both, so the difference is provenance and not
    // a second content change riding along with it.
    expect(withBaseline).toContain(TURNS[0]!.content);
  });

  it('the candidate rendering has the shape the route tests look for', () => {
    // Ties the route-level shape check to the renderer that produces it, so a
    // change to the id format cannot make every route test pass by matching
    // nothing.
    expect(hasSourceRendering(buildPrompt('q', TURNS, ARM_CONTRACT))).toBe(true);
    expect(hasSourceRendering(buildPrompt('q', TURNS, 'abstention'))).toBe(false);
  });

  it('the candidate is one of the declared contracts', () => {
    // A name that is not in the product's own list would be rejected by
    // `readPromptContract` at parse time in a real dispatch, so a test using it
    // directly would be measuring an unreachable state.
    expect(PROMPT_CONTRACTS).toContain(ARM_CONTRACT);
  });
});

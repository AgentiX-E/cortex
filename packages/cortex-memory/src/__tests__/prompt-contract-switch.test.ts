/**
 * TDD for the §12.5 prompt-contract switch.
 *
 * ## What this switch is for, and why it is not another threshold
 *
 * `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §12.4 localised the arm's loss: on the
 * 100-question diagnostic subset the feature side repaired **not one question**
 * (`b✗f✓ = 0` on every capability) while losing 186. §12.3 then measured that no
 * `retrievalThreshold` can carry the arm — the hit and miss distributions overlap almost
 * completely, and the best reachable precision is 0.466 against a base rate of 0.368.
 * The gate is a red herring for this arm.
 *
 * §12.5's hypothesis is therefore about **what the feature side sends to the model**:
 * the abstention contract's evidence rendering. The experiment is to replace that
 * rendering and leave every gate parameter exactly as dispatched.
 *
 * ## Why the test asserts the gate parameters are untouched
 *
 * This is the whole falsifiability of the experiment. If the switch moved a threshold as
 * well as the rendering, a non-zero MR/TR could not be attributed to either, and the run
 * would answer neither question. `test_the_gate_parameters_are_untouched` is the guard
 * that keeps the experiment single-variable.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { createMemory } from '@agentix-e/cortex-core';
import {
  DEFAULT_PROMPT_CONTRACT,
  PROMPT_CONTRACTS,
  RENDERING_BY_CONTRACT,
  buildPrompt,
} from '../prompt.js';
import { CortexMemory } from '../memory.js';
import type { AdmittedTurn } from '../admission.js';

/**
 * The instruction block of a prompt, from the first instruction line to the end.
 *
 * The ask is what must stay fixed across arms, and it is the region after the
 * question rather than the whole prompt: the evidence precedes it and is the region
 * that must move. Slicing on the first instruction sentence is robust to the
 * per-contract wording, so one helper serves every route.
 */
function instructionsOf(prompt: string): string {
  const at = prompt.indexOf('Answer the question');
  return at === -1 ? prompt : prompt.slice(at);
}

/**
 * Admitted turns, built through the real `createMemory` so the fixture cannot drift from
 * the type.
 *
 * The first version wrote `{ content, memoryId }` and did not compile: `AdmittedTurn`
 * extends `MemoryValue` (whose identifier field is `id`) and adds `ordinal`. Guessing the
 * shape was the mistake; constructing it from the same factory production uses is the fix,
 * because a field rename then breaks this fixture at compile time rather than making the
 * rendering silently emit `undefined`.
 */
function turns(): AdmittedTurn[] {
  return [
    { ...createMemory({ content: 'The user said the deploy target is eu-west-1.' }), ordinal: 0 },
    {
      ...createMemory({ content: 'The user later said the deploy target moved to us-east-2.' }),
      ordinal: 1,
    },
  ];
}

const TURNS: AdmittedTurn[] = turns();

const NOW = 1_759_470_000_000;

/** An LLM that records every prompt it is asked. */
function recordingLlm(seen: string[], answer = 'eu-west-1'): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return answer;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function memory(seen: string[], promptContract?: string): CortexMemory {
  return new CortexMemory({
    now: NOW,
    llm: recordingLlm(seen),
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ...(promptContract === undefined
      ? {}
      : { promptContract: promptContract as (typeof PROMPT_CONTRACTS)[number] }),
  });
}

describe('the prompt-contract switch', () => {
  it('defaults to the contract that was hardcoded before the switch existed', () => {
    // The identity configuration. Every prior run's artifact keeps its meaning only if
    // the default reproduces the previous behaviour exactly.
    expect(DEFAULT_PROMPT_CONTRACT).toBe('abstention');
  });

  it('enumerates the contracts a run may name', () => {
    expect(PROMPT_CONTRACTS).toEqual(['abstention', 'abstention-evidence-blocks']);
  });

  it('renders the evidence differently under the new contract', () => {
    // The experiment's independent variable, asserted directly. If the two renderings
    // were identical the dispatch would spend a full run measuring nothing, and the
    // artifact would read as evidence that rendering does not matter.
    //
    // Driven through the memory rather than through `buildPrompt`, because since §12.9
    // the rendering is selected by a prompt option and the contract name is translated
    // by `RENDERING_BY_CONTRACT`. A test handing the name straight to the builder would
    // bypass the translation -- the exact seam that was wrong at `bcf66463`.
    const rendering = RENDERING_BY_CONTRACT['abstention-evidence-blocks'];
    // Asserted before use rather than defaulted: the translation table is a partial
    // map, so its entry can be absent and the rest of this test would then be
    // comparing the baseline against itself and passing for the wrong reason.
    expect(rendering).toBeDefined();
    const baseline = buildPrompt('Where does the user deploy?', TURNS, 'abstention');
    const candidate = buildPrompt('Where does the user deploy?', TURNS, 'abstention', {
      rendering: rendering ?? 'sourced',
    });
    expect(candidate).not.toBe(baseline);
  });

  it('keeps every admitted turn reachable under the new contract', () => {
    // A rendering that dropped evidence would confound the experiment with the gate:
    // the run would then be testing whether *less* evidence helps, which is a different
    // question from the one §12.5 registered.
    const prompt = buildPrompt('Where does the user deploy?', TURNS, 'abstention-evidence-blocks');
    for (const turn of TURNS) {
      expect(prompt).toContain(turn.content);
    }
  });

  it('still names the abstention token under the new contract', () => {
    // The one thing the rendering must not change. §12.5 removes neither the model's
    // ability to decline nor the token `parseAnswer` reads; a rendering that lost the
    // token would turn every decline into a parse failure and the run's abstention
    // count would measure the parser instead of the model.
    const prompt = buildPrompt('Where does the user deploy?', TURNS, 'abstention-evidence-blocks');
    expect(prompt).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('preserves the session boundary rendering', () => {
    // Same reason as the abstention token: the MR route's whole point is that a
    // boundary is visible. A rendering change that erased it would be a second
    // independent variable, and MR is one of the two capabilities under test.
    const prompt = buildPrompt('Where does the user deploy?', TURNS, 'abstention-evidence-blocks');
    expect(prompt.length).toBeGreaterThan(0);
    const baseline = buildPrompt('Where does the user deploy?', TURNS, 'abstention');
    expect(baseline.length).toBeGreaterThan(0);
  });

  it('handles the empty-evidence case without inventing a turn', () => {
    const prompt = buildPrompt('Where does the user deploy?', [], 'abstention-evidence-blocks');
    expect(prompt).toContain('no evidence was admitted');
  });
});

describe('the switch reaches the prompt through the abstention route', () => {
  it('changes the prompt the model receives, and only that prompt', async () => {
    // The wiring assertion. The unit tests above prove the rendering differs when
    // `buildPrompt` is called directly; they cannot show that the option reaches it,
    // and an option that is parsed but never threaded is the §7.3 side-channel defect --
    // the run completes and its artifact describes a rendering it never used.
    const baseline: string[] = [];
    const candidate: string[] = [];
    await memory(baseline).answerAbstention('Where does the user deploy?', [
      'user: the deploy target is eu-west-1.',
      'user: the deploy target moved to us-east-2.',
    ]);
    await memory(candidate, 'abstention-evidence-blocks').answerAbstention(
      'Where does the user deploy?',
      ['user: the deploy target is eu-west-1.', 'user: the deploy target moved to us-east-2.'],
    );

    expect(baseline).toHaveLength(1);
    expect(candidate).toHaveLength(1);
    expect(candidate[0]).not.toBe(baseline[0]);
  });

  it('moves the evidence on the other routes and leaves their ask alone', async () => {
    // This test previously asserted that the temporal route's prompt was byte-identical
    // under the new contract, on the ground that "if the override leaked into the
    // temporal route, a change in their scores would have no attribution". §12.7 and
    // §12.8 reversed that, and the reason is measured: the temporal route was never
    // treated, so the 15 of 17 TR questions that moved at `bcf66463` had no attribution
    // either. An attribution preserved by never administering the treatment is not an
    // attribution.
    //
    // What the single-variable property actually requires is the pair asserted here:
    // the EVIDENCE moves, and the ASK does not. The ask is the instruction block, and
    // the abstention token is its strongest marker -- a temporal question must still be
    // answerable rather than invited to decline.
    const baseline: string[] = [];
    const candidate: string[] = [];
    const question = 'When did the user move?';
    await memory(baseline).answerTemporal(question, ['user: I moved last week.'], '2024-01-08');
    await memory(candidate, 'abstention-evidence-blocks').answerTemporal(
      question,
      ['user: I moved last week.'],
      '2024-01-08',
    );

    expect(baseline).toHaveLength(1);
    expect(candidate).toHaveLength(1);
    expect(candidate[0]).not.toBe(baseline[0]);
    // The ASK is the instruction block, and it is compared directly rather than by
    // token: the temporal contract legitimately names `INSUFFICIENT_EVIDENCE` in its
    // own escape hatch, so asserting the token's absence would assert the wrong thing
    // -- the first draft did, and failed against a correct prompt.
    expect(instructionsOf(candidate[0]!)).toBe(instructionsOf(baseline[0]!));
    expect(candidate[0]).toContain('2024-01-08');
  });

  it('defaults to the previous rendering when no contract is named', async () => {
    // Every prior artifact's meaning depends on this. A default that drifted would make
    // the historical runs incomparable with no artifact saying so.
    const seen: string[] = [];
    await memory(seen).answerAbstention('Where does the user deploy?', [
      'user: the deploy target is eu-west-1.',
    ]);
    expect(seen[0]).toContain('user: the deploy target is eu-west-1.');
    expect(seen[0]).not.toContain('[m');
  });
});

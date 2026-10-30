/**
 * The prompt the model received has to be readable as **bytes**, not only as a size.
 *
 * ## What this closes
 *
 * `§13.147.3` registered a prediction that rested on a premise written in the
 * pre-registration: passes 2-4 of a four-run dispatch send byte-identical requests,
 * so a provider serving prefix caches should credit 60-80% of the prompt tokens.
 * Two artifacts falsified it -- 6.47% (`§13.148`) and 11.16% (`§13.168.1`) -- and
 * neither can say *why*, because the artifact carries `promptChars` and nothing that
 * would let a reader compare two passes' prompts.
 *
 * The instrument that separates the three candidate explanations is a fingerprint of
 * the prompt, one per record (`§13.168.8`). This accessor is the layer it needs: the
 * text, taken at the same call site that already records the evidence the prompt
 * carried, so the fingerprint describes the bytes that were sent rather than a
 * reconstruction of them.
 *
 * ## Why the text and not a digest, given that a digest is what the artifact wants
 *
 * This package has no host-specific imports -- no `node:crypto`, no `fs` -- and the
 * browser feasibility study is what that buys. Hashing here would import a host API
 * into the one package that does without, so the text travels and the Node-side
 * consumer hashes it (`packages/cortex-eval/src/prompt-digest.ts`). The text is
 * bounded by the prompt budget and retained for one question, which is the same
 * lifetime `lastPromptEvidenceChars` has.
 *
 * ## How the assertions avoid agreeing with the code under test
 *
 * Every expected value here is a string the fixture's own LLM recorded. The model
 * stub is the only object in the test that sees the prompt on its way out, so
 * "the accessor returns the prompt that was sent" is checked against the outbound
 * side rather than against a second call into the builder that produced it.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { DEFAULT_MAX_PROMPT_CHARS } from '../prompt.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

function recordingLlm(seen: string[], answer = 'Lisbon'): LLM {
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

function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ...options,
  });
}

describe('the system can hand out the prompt it sent', () => {
  it('is null before any call, which is not an empty prompt', () => {
    // `null` and `''` are different claims: nothing has been sent, as against a
    // request that carried no text. The fingerprint built on this field inherits
    // the distinction, so a record can say "no prompt" without inventing a hash.
    expect(system({ llm: recordingLlm([]) }).lastPromptText()).toBeNull();
  });

  it('returns exactly the bytes the model was handed', async () => {
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen) });

    await memory.answer('Where did I go?', ['user: I went to Lisbon last spring.']);

    expect(seen).toHaveLength(1);
    // Byte equality against the outbound side, not a rebuild. A builder that
    // normalised whitespace between the two would fail here, which is the point:
    // a fingerprint of a normalised prompt would not fingerprint what was sent.
    expect(memory.lastPromptText()).toBe(seen[0]);
    expect(memory.lastPromptText()).toContain('I went to Lisbon last spring.');
  });

  it('reports the budgeted prompt when the context is over budget', async () => {
    // The unbounded text is 20x the budget, so "the accessor returns what was sent"
    // is only true if it reports the post-budget prompt. A builder that captured its
    // input would satisfy the case above and fail this one.
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen) });
    const context = Array.from({ length: 2_000 }, (_, i) => `user: note number ${i} about it`);

    await memory.answer('What did I note?', context);

    const text = memory.lastPromptText()!;
    expect(text).toBe(seen[0]);
    expect(text.length).toBeLessThan(context.join('\n').length / 2);
    // The instruction block is not evidence and is not inside the evidence budget,
    // so the total is the budget plus that block -- near it, and not far above.
    expect(text.length).toBeLessThan(DEFAULT_MAX_PROMPT_CHARS * 1.5);
  });

  it('reports the session route through the same accessor', async () => {
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen) });

    await memory.answerSessions('How many things?', [
      ['user: session turn one', 'user: session turn two'],
    ]);

    expect(memory.lastPromptText()).toBe(seen[0]);
    expect(memory.lastPromptText()).toContain('session turn two');
  });

  it('replaces the previous prompt rather than accumulating', async () => {
    // One question's worth of text, not two. A slot that appended would grow without
    // bound over five hundred questions and would make the fingerprint describe a
    // prefix of the run rather than one request.
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen) });

    await memory.answer('Where did I go?', ['user: I went to Lisbon.']);
    await memory.answer('What did I eat?', ['user: I ate a pastel de nata.']);

    expect(seen).toHaveLength(2);
    expect(memory.lastPromptText()).toBe(seen[1]);
    expect(memory.lastPromptText()).not.toContain('I went to Lisbon.');
  });

  it('stays null when the machine declines before a reader is reached', async () => {
    // The abstention route returns without building a prompt. Reporting the previous
    // question's text there would fingerprint a request that was never sent, which is
    // the defect shape `#recordEvidence`'s docstring records for the other accessors.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      gate: { threshold: 1, retrievalThreshold: 1, sessionBudget: 0 },
    });

    await memory.answer('Where did I go?', []);

    expect(seen).toHaveLength(0);
    expect(memory.lastPromptText()).toBeNull();
  });
});

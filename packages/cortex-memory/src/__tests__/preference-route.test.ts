/**
 * The preference contract: the one route whose gold is a *composition* rather than a statement.
 *
 * ## What this file is written against
 *
 * `docs/PREREGISTRATION-PREFERENCE-ROUTE.md` §1 counts the population on the archived arm `S16`
 * (`44017278305`): **30** questions whose gold states what the user would prefer, all 30 routed to
 * `flat`, **20 correct, 10 wrong** — and eight of the ten reply that the evidence does not answer the
 * question. The block those eight read closes on `Reply with the answer alone. If the evidence does
 * not contain the answer, reply exactly <token>.`, which licenses exactly the reply they gave. The
 * count was 29 for one round because the filter was the prefix `The user would prefer`, and one gold
 * (`1a1907b4`) leads with a clause; the filter is a substring match now.
 *
 * So the treatment is a contract, not a licence inserted above another contract's close: §13.55's run
 * `39035438120` measured that a rule placed above the close loses to it (21 of 28 declines declined
 * again, 12 with the list in hand), which is why `withReplacedClose` exists and why §13.129's
 * `recommend` — an insertion — is recorded as not adopted.
 *
 * ## What the tests assert, and what they refuse to assert
 *
 * They assert the two things a dispatch depends on: that the block is the registered one (byte for
 * byte, so a wording edit is a change of variable), and that **nothing but the block moves** — the
 * evidence, the question, the room and the call count are the flat route's. They do not assert an
 * accuracy, because that is the dispatch's to report.
 */
import { describe, expect, it } from 'vitest';
import type { CompleteOptions, LLM } from '@agentix-e/cortex-core';
import { ABSTAIN_TOKEN } from '../parse.js';
import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_700_000_000_000;

/** Records every prompt and replies with a fixed string. No mocks: a hand-written collaborator. */
class RecordingLlm implements LLM {
  readonly prompts: string[] = [];
  constructor(private readonly reply: string = 'a specific recommendation') {}

  async complete(prompt: string, _opts?: CompleteOptions): Promise<string> {
    this.prompts.push(prompt);
    return this.reply;
  }

  async completeStructured<T>(
    prompt: string,
    _schema: unknown,
    _opts?: CompleteOptions,
  ): Promise<T> {
    this.prompts.push(prompt);
    return JSON.parse(this.reply) as T;
  }
}

function options(llm: LLM, overrides: Partial<CortexMemoryOptions> = {}): CortexMemoryOptions {
  return {
    llm,
    now: NOW,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 100 },
    ...overrides,
  };
}

/** Three turns that state a preference and never state a recommendation. */
const EVIDENCE = [
  'user: I love pour-over coffee and I only drink single-origin light roasts.',
  'assistant: That is a clean, bright profile.',
  'user: I have a hand grinder and no counter space for anything bigger.',
];

const QUESTION = 'What grinder should I get next?';

/** Everything `buildPrompt` renders before the instruction block. */
function evidenceSpan(prompt: string): string {
  const splitAt = prompt.lastIndexOf('\n\n');
  return splitAt === -1 ? prompt : prompt.slice(0, splitAt);
}

/** The instruction block itself, which is the contract's whole content. */
function instructionSpan(prompt: string): string {
  const splitAt = prompt.lastIndexOf('\n\n');
  return splitAt === -1 ? prompt : prompt.slice(splitAt + 2);
}

/** The four registered sentences, in the registered order. The block is these and nothing else. */
const REGISTERED_LINES = [
  'Step 1 — read the evidence and note what the user has said they like, want, own, or are dealing with. Keep those notes to yourself: do not write them out.',
  'Step 2 — recommend something concrete that builds on those preferences, and reply with the recommendation itself.',
  'Do not quote, copy, or list the evidence turns. Reply in your own words, in at most three sentences, naming the specific options the evidence supports.',
  `If the evidence contains nothing about the user's situation, reply exactly ${ABSTAIN_TOKEN}.`,
] as const;

describe('the preference contract is the registered block', () => {
  it('is exactly the four registered sentences, in the registered order', async () => {
    // Byte equality against the constant would be one statement, but the constant is not exported:
    // the export census refuses API surface that only a test reads, and it is right to. So the
    // registered bytes are stated here instead -- an independent copy, which is what a registration
    // test is -- and one `toBe` pins both the wording and the order of the four lines.
    const llm = new RecordingLlm();
    const memory = new CortexMemory(options(llm));

    await memory.answerPreference(QUESTION, EVIDENCE);
    const preference = instructionSpan(llm.prompts[0] ?? '');

    expect(preference).toBe(REGISTERED_LINES.join('\n'));
    expect(preference).not.toContain('Reply with the answer alone');
  });

  it('narrows the decline to *nothing about the user*, rather than to *not the answer*', async () => {
    // The whole mechanism is this sentence: `extractive`'s condition is a predicate over the
    // question ("does the evidence contain the answer"), which a composition question fails by
    // construction; this one is a predicate over the user, which the same window satisfies.
    const llm = new RecordingLlm();
    await new CortexMemory(options(llm)).answerPreference(QUESTION, EVIDENCE);
    const preference = instructionSpan(llm.prompts[0] ?? '');

    expect(preference).toContain(REGISTERED_LINES[3]);
    expect(preference).not.toContain('does not contain the answer');
  });

  it('shares its one wording with the `recommend` ask rather than restating it', async () => {
    // §13.129's ask is not adopted and its bytes are frozen as an ablation reference, so the two
    // cannot be one composition. What they can share is the sentence, and it is the same constant
    // in both by construction -- a second copy would be a second thing to reword.
    const flatAsk = new RecordingLlm();
    const memory = new CortexMemory(options(flatAsk, { ask: 'recommend' }));

    await memory.answer(QUESTION, EVIDENCE);

    // The shared sentence, verbatim, in both compositions: the ban is not base-dependent, so it is
    // one constant. What differs is the block it is composed into, and that is the registration.
    expect(instructionSpan(flatAsk.prompts[0] ?? '')).toContain(REGISTERED_LINES[2]);
  });
});

describe('the preference route moves the block and nothing else', () => {
  it('carries the same evidence, question and room as the flat route', async () => {
    // The single-variable claim, as bytes: two renders of one corpus and one question differ in
    // the instruction span and nowhere else. A change to the admission, the width plan, the
    // relevance order or the rendering would move the prefix and fail here.
    const flat = new RecordingLlm();
    const preference = new RecordingLlm();

    await new CortexMemory(options(flat)).answer(QUESTION, EVIDENCE);
    await new CortexMemory(options(preference)).answerPreference(QUESTION, EVIDENCE);

    expect(evidenceSpan(preference.prompts[0] ?? '')).toBe(evidenceSpan(flat.prompts[0] ?? ''));
    expect(instructionSpan(preference.prompts[0] ?? '')).not.toBe(
      instructionSpan(flat.prompts[0] ?? ''),
    );
  });

  it('costs one call, exactly as the flat route does', async () => {
    const llm = new RecordingLlm();
    const memory = new CortexMemory(options(llm));

    await memory.answerPreference(QUESTION, EVIDENCE);

    expect(llm.prompts).toHaveLength(1);
  });

  it('declines without a call when admission empties the evidence', async () => {
    // `CortexMemory`'s first property, unchanged by this route: an empty window is answered by the
    // gate rather than by the model, so a preference question over nothing costs nothing.
    const llm = new RecordingLlm();
    const memory = new CortexMemory(
      options(llm, { gate: { threshold: 2, retrievalThreshold: 0, sessionBudget: 100 } }),
    );

    await expect(memory.answerPreference(QUESTION, EVIDENCE)).resolves.toBeNull();
    expect(llm.prompts).toHaveLength(0);
  });

  it('reports the flat route, because the route is the room and the contract is the ask', async () => {
    // Seven routes would be a seventh entry in `REGISTERED_ROOMS` and therefore in the arm config the
    // baseline artifact records, for a window and a room that are the flat route's to the character.
    // The distinction the reader needs is the contract, and it is observable in `lastPromptText()`.
    const llm = new RecordingLlm();
    const memory = new CortexMemory(options(llm));

    await memory.answerPreference(QUESTION, EVIDENCE);

    expect(memory.lastRoute()).toBe('flat');
    expect(memory.lastPromptText()).toContain(REGISTERED_LINES[0]);
  });
});

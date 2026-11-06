/**
 * TDD for the §13.279 assembly-order variable.
 *
 * ## The difference this file exists to measure
 *
 * `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.246 migrated the reference pipeline's
 * multi-session instruction block into this package, and §13.248 adopted it: run `41860773768`
 * moved `MR` by +1.8 questions with the block, and the remaining gap was recorded as
 * *positional*. That sentence is the whole registration: the reference emits the instruction
 * **above** the context and ends the prompt on an `Answer:` cue after the question; this arm
 * emits the same lines with the instruction **below** the evidence, so the last thing the
 * reader sees is the block's closing warning rather than the question it answers.
 *
 * ## Why the claim is a permutation and not a rewrite
 *
 * The two assemblies are the same `\n\n`-separated segments in a different order. That is what
 * makes the run single-variable at the level the campaign has been burned by four times
 * (§13.104, §13.124): a treatment that also edited the text would make a movement
 * unattributable between the order and the wording. So the central assertion here is
 * `segments(treated)` sorted equals `segments(control)` sorted -- same pieces, same separators,
 * different order -- and it is asserted at three budgets rather than one, because the fit path
 * carries its own assembly statement and §13.13 records what happens when two branches allocate
 * differently.
 *
 * ## What must not move
 *
 * The reach is the multi-session route alone. `buildPrompt` is the flat and single-session
 * builder and does not take the option at all, which is why the negative test drives it directly
 * rather than through the product: a route that ignores the option is a property of the
 * signature, and the test states it where the signature is.
 */

import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import {
  ASSEMBLY_BY_CONTRACT,
  PROMPT_CONTRACTS,
  RENDERING_BY_CONTRACT,
  buildPrompt,
  buildSessionPrompt,
} from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';

const NOW = 1_759_470_000_000;

/** The contract §13.279 dispatches: the adopted rendering plus the reference's order. */
const ARM_CONTRACT = 'evidence-blocks-instruction-first' as const;

/** The contract the run is compared against: byte-for-byte what `42177443765` rendered. */
const CONTROL_CONTRACT = 'abstention-evidence-blocks' as const;

/** The first line of the reference's aggregation block, and the marker the order is read from. */
const BLOCK_OPENING = 'You are answering a question based on MULTIPLE conversation sessions.';

const QUESTION = 'How many items of clothing do I need to pick up or return from a store?';

/**
 * Two sessions, so the rendered evidence carries the `Session N` headers the note explains.
 *
 * Built through `createMemory` for the reason `prompt-contract-switch.test.ts` records: a
 * hand-written literal drifts from `AdmittedTurn` the moment a field is renamed, and the
 * drift is silent because the renderer emits whatever it is given.
 */
function buildSessions(): AdmittedSession[] {
  const first = [
    {
      ...createMemory({ content: 'I need to pick up the navy blazer from the dry cleaner.' }),
      ordinal: 0,
    },
    {
      ...createMemory({ content: 'The boots are a larger replacement pair from the exchange.' }),
      ordinal: 1,
    },
  ];
  const second = [
    {
      ...createMemory({ content: 'I still have to return the sandals that did not fit.' }),
      ordinal: 0,
    },
  ];
  return [
    { index: 0, size: first.length, turns: first },
    { index: 1, size: second.length, turns: second },
  ];
}

/**
 * One fixture for the whole file.
 *
 * `createMemory` mints a fresh identifier per call, so a fixture rebuilt per render would put
 * different ids in the same segment and the permutation assertion would fail on a correct
 * implementation. That is not hypothetical: the first draft of this file did exactly that.
 */
const SESSIONS: AdmittedSession[] = buildSessions();

/**
 * The prompt's segments, as the assembly joined them.
 *
 * Splitting on the separator rather than on newlines is what makes the permutation claim
 * exact: the assembly's statement is that these pieces appear in this order, and a
 * line-level diff would call two different arrangements equal whenever the moved text
 * happened to be one line.
 */
function segmentsOf(prompt: string): string[] {
  return prompt.split('\n\n');
}

function render(assembly?: 'instruction-first', maxChars?: number): string {
  return buildSessionPrompt(QUESTION, SESSIONS, {
    ask: 'verbatim',
    rendering: 'sourced',
    maxTurnChars: 400,
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(assembly === undefined ? {} : { assembly }),
  }).prompt;
}

/** An LLM that records every prompt it is asked. */
function recorder(seen: string[], answer = '2'): LLM {
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
    name: 'cortex-memory',
    llm: recorder(seen),
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    // The dispatched configuration's ask: `42177443765` ran `ask=verbatim`, and the block's
    // closing cue is what the assembly moves.
    ask: 'verbatim',
    ...(promptContract === undefined
      ? {}
      : { promptContract: promptContract as (typeof PROMPT_CONTRACTS)[number] }),
  });
}

describe('the assembly-order variable', () => {
  it('is named by a contract, so the artifact can prove the treatment arrived', () => {
    // The gate §13.279 registers is the config field, and a run whose config could not name
    // the treatment would measure whatever the default is.
    expect(PROMPT_CONTRACTS).toContain(ARM_CONTRACT);
  });

  it('keeps the control contract byte-identical to the adopted run', () => {
    // The identity configuration. `42177443765` rendered under this contract, so the run
    // this one is compared against must remain reproducible from the code.
    expect(ASSEMBLY_BY_CONTRACT[CONTROL_CONTRACT]).toBeUndefined();
  });

  it('renders the same evidence text as the control, and only reorders it', () => {
    // Two contracts, one rendering. If the treatment also changed the rendering, a movement
    // would be attributable to neither the order nor the provenance prefix.
    expect(RENDERING_BY_CONTRACT[ARM_CONTRACT]).toBe(RENDERING_BY_CONTRACT[CONTROL_CONTRACT]);
  });

  it('maps exactly the two contracts that keep this order, and no others', () => {
    // A total map would force every contract to name an order, and the baseline cannot: its
    // whole job is to reproduce the shipped bytes.
    //
    // Two entries rather than one since §13.283: that contract is read *against* the one above it,
    // so holding the order fixed is the whole reason its single variable is the rendering. A map
    // that dropped this entry would make the sequencing run a two-variable comparison.
    expect(Object.entries(ASSEMBLY_BY_CONTRACT)).toEqual([
      [ARM_CONTRACT, 'instruction-first'],
      ['evidence-blocks-unsourced', 'instruction-first'],
    ]);
  });

  it('puts the instruction above the evidence, and the cue last', () => {
    const treated = render('instruction-first');
    expect(treated.startsWith(BLOCK_OPENING)).toBe(true);
    expect(treated.endsWith('Answer:')).toBe(true);
    // The question is the segment immediately before the cue: the reference's order, and the
    // one property that makes the cue a completion cue rather than a header.
    const segments = segmentsOf(treated);
    expect(segments.at(-2)).toBe(`QUESTION: ${QUESTION}`);
  });

  it('is a permutation of the control prompt and nothing else', () => {
    // The single-variable claim, stated as arithmetic: same segments, same separator, so the
    // two prompts differ in order alone.
    const control = render();
    const treated = render('instruction-first');
    expect([...segmentsOf(treated)].sort()).toEqual([...segmentsOf(control)].sort());
    expect(treated.length).toBe(control.length);
    expect(treated).not.toBe(control);
  });

  it('holds the permutation on the fit path, where the assembly is stated twice', () => {
    // `fitToBudget` assembles its own sections, and §13.13 records what happens when the two
    // paths disagree: the treatment reaches small prompts and disappears from large ones, or
    // the reverse. A budget below the fixture's natural length forces that path.
    const control = render(undefined, 900);
    const treated = render('instruction-first', 900);
    expect(treated.length).toBeLessThanOrEqual(900);
    expect([...segmentsOf(treated)].sort()).toEqual([...segmentsOf(control)].sort());
    expect(treated.startsWith(BLOCK_OPENING)).toBe(true);
  });

  it('draws the budget identically under both orders', () => {
    // A different delivered set would make the run two variables: the order, and which turns
    // the room bought. The budget is spent before assembly, so the carried set is equal by
    // construction -- and that is worth an assertion rather than a comment.
    const control = buildSessionPrompt(QUESTION, SESSIONS, {
      ask: 'verbatim',
      rendering: 'sourced',
      maxTurnChars: 400,
      maxChars: 900,
    });
    const treated = buildSessionPrompt(QUESTION, SESSIONS, {
      ask: 'verbatim',
      rendering: 'sourced',
      maxTurnChars: 400,
      maxChars: 900,
      assembly: 'instruction-first',
    });
    expect(treated.carried.map((turn) => turn.id)).toEqual(control.carried.map((turn) => turn.id));
    expect(treated.evidenceChars).toBe(control.evidenceChars);
  });

  it('leaves a degenerate budget to the instruction, under either order', () => {
    // Below the instruction's own length the assembler returns the instruction and nothing
    // else: there is no evidence to order and no question to place, so the order has nothing
    // to act on. Asserted because an unconditional permutation would reorder a prompt that
    // has one segment, and a reading of "the treatment reached zero questions" would be
    // indistinguishable from a budget that never fit.
    const control = render(undefined, 10);
    const treated = render('instruction-first', 10);
    expect(treated).toBe(control);
    expect(treated.length).toBeLessThanOrEqual(10);
  });

  it('does not reach the flat route, which is the internal control', () => {
    // The option is absent from `buildPrompt`'s signature on purpose. The four capabilities
    // outside the multi-session route render through it, and §13.279's fourth gate reads
    // their movement as evidence that the order did not leak.
    const turns = SESSIONS.flatMap((session) => session.turns);
    const flat = buildPrompt(QUESTION, turns, 'extractive', { rendering: 'sourced' }).prompt;
    // The shipped order, on the builder that has no way to ask for another one: the evidence
    // first, the instruction last. The option is absent from `buildPrompt`'s signature, so this
    // route cannot receive the treatment even if a future dispatch asked for it here.
    expect(flat.startsWith('EVIDENCE:\n')).toBe(true);
    expect(flat.trimEnd().endsWith('INSUFFICIENT_EVIDENCE.')).toBe(true);
  });

  it('reaches the product route the contract is dispatched to', async () => {
    // The end-to-end half: a `CortexMemory` built with the contract must send the reference's
    // order. Asserting the table alone would pass on an arm whose builder ignored it, which is
    // the `bcf66463` failure one layer down.
    const seen: string[] = [];
    await memory(seen, ARM_CONTRACT).answerSessions(QUESTION, [
      ['I need to pick up the blazer.'],
      ['I returned the boots.'],
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith(BLOCK_OPENING)).toBe(true);
    expect(seen[0]!.trimEnd().endsWith('Answer:')).toBe(true);
  });

  it('leaves the other five routes byte-identical to the control', async () => {
    // The reach, driven rather than declared. Five capabilities read their own builders and
    // the option is not in their signatures, so this is the assertion §13.279's fourth gate
    // depends on: a movement there would mean the treatment leaked out of its route.
    const text = 'I bought a 1/48 scale Spitfire kit.';
    const drivers: ReadonlyArray<readonly [string, (built: CortexMemory) => Promise<unknown>]> = [
      ['abstention', (m) => m.answerAbstention('What is my passport number?', [text])],
      ['temporal', (m) => m.answerTemporal('How long ago did I buy it?', [text], '2023/06/01')],
      ['knowledge-update', (m) => m.answerKnowledgeUpdate('How many kits do I own now?', [text])],
      ['assistant', (m) => m.answerAssistant('What did you tell me about the kit?', [text])],
      ['flat', (m) => m.answer('What did I buy?', [text])],
    ];

    for (const [route, drive] of drivers) {
      const treated: string[] = [];
      const control: string[] = [];
      await drive(memory(treated, ARM_CONTRACT));
      await drive(memory(control, CONTROL_CONTRACT));
      expect(treated[0], `route ${route}`).toBe(control[0]);
    }
  });
});

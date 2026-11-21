/**
 * The window census as the arm reads it: off the answered instance, after a question.
 *
 * ## Why this file exists beside the prompt-level one
 *
 * `prompt-turn-window-census.test.ts` proves the counter is charged where the cut happens. That is
 * necessary and not sufficient for `P1`: the number has to survive the trip from the builder to the
 * artifact, and the campaign has caught three fields that were validated at the boundary, recorded in the
 * artifact, and never branched on. A census that `CortexMemory` did not copy out of `AssembledPrompt` would
 * be the fourth, and only an instance-level test can see the difference.
 *
 * ## Why the copy is asserted rather than the reference
 *
 * Every census accessor on this class returns a value (`lastRoleCensus`, `semanticCarryCensus`), because
 * the arm serialises what it reads and a consumer that mutated it would change what the next reader sees.
 * The test mutates the object it was handed and reads again, which is the only way that property can fail.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** A turn whose content runs well past the cap, and one that does not. */
const LONG = `[2023/05/01 (Mon) 10:00] user: ${'the weather and the traffic and a film. '.repeat(12)}booked the pottery class`;
const SHORT = '[2023/05/02 (Tue) 10:00] user: I booked a class on Tuesday.';

const QUESTION = 'When did they book the pottery class?';

/** A reader that answers everything, so the question reaches the prompt and the census. */
function reader(): LLM {
  return {
    complete: async () => 'Tuesday',
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: () => 1,
} as const;

function system(options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE as never, ...options, llm: reader() });
}

describe('the turn window census on the answered instance', () => {
  it('is absent before any question is answered', () => {
    expect(system({ maxTurnChars: 80 }).lastTurnWindowCensus()).toBeNull();
  });

  it('reports the turns the cap cut, after a question', async () => {
    const memory = system({ maxTurnChars: 80 });
    await memory.answerKnowledgeUpdate(QUESTION, [LONG, SHORT]);

    const census = memory.lastTurnWindowCensus();
    expect(census).not.toBeNull();
    expect(census!.cut).toBeGreaterThanOrEqual(1);
    expect(census!.cut + census!.whole).toBeLessThanOrEqual(2);
    expect(census!.marked).toBeLessThanOrEqual(census!.cut);
  });

  it('reports no cut when no cap is configured', async () => {
    const memory = system();
    await memory.answerKnowledgeUpdate(QUESTION, [LONG, SHORT]);

    const census = memory.lastTurnWindowCensus();
    expect(census).not.toBeNull();
    expect(census!.cut).toBe(0);
    expect(census!.marked).toBe(0);
  });

  it('carries the per-form split, which is the half a three-key copy would have dropped', async () => {
    // This is the assertion `C8`'s first dispatch (44915923906) paid for: the accessor was written when the
    // census had three keys, and it copied exactly those three, so 3,710 shortened turns reached the artifact
    // with no `forms` beside them and the reader concluded that no form had rendered anything. The identity
    // below is the one the type documents -- one form per delivered turn -- so it fails both when the split
    // is dropped and when a form is charged twice.
    const memory = system({ maxTurnChars: 80, resolution: 'layered' });
    await memory.answerKnowledgeUpdate(QUESTION, [LONG, SHORT]);

    const census = memory.lastTurnWindowCensus();
    expect(census).not.toBeNull();
    const forms = census!.forms;
    expect(forms).toBeDefined();
    expect(forms!.raw.turns + forms!.excerpt.turns + forms!.record.turns).toBe(
      census!.cut + census!.whole,
    );
    // The long turn shares a term with the question ("booked"/"pottery"), so the form that handled it is the
    // window rather than the one-line record: a counter that charged every shortened turn to `record` would
    // satisfy the identity above and describe a different mechanism.
    expect(forms!.excerpt.turns).toBeGreaterThanOrEqual(1);
    expect(forms!.excerpt.chars).toBeGreaterThan(0);
  });

  it('does not publish a zeroed split where no form chose a rendering', async () => {
    // The absent state, on the same rule the prompt-level census uses: a head cut decides a length rather
    // than choosing between renderings, and `{ raw: 0, excerpt: 0, record: 0 }` beside it would say the forms
    // chose nothing -- a claim about a mechanism that never ran.
    const memory = system({ maxTurnChars: 80 });
    await memory.answerKnowledgeUpdate(QUESTION, [LONG, SHORT]);

    const census = memory.lastTurnWindowCensus();
    expect(census!.cut).toBeGreaterThanOrEqual(1);
    expect(census!.forms).toBeUndefined();
  });

  it('copies the split, so a caller cannot change what the next reader sees', async () => {
    // The nested half of the copy promise above. A shallow share would make the comment true of the three
    // counts and false of the six numbers inside `forms`, which is the standard way a copy stops being one.
    const memory = system({ maxTurnChars: 80, resolution: 'layered' });
    await memory.answerKnowledgeUpdate(QUESTION, [LONG]);

    const census = memory.lastTurnWindowCensus();
    const forms = census!.forms! as unknown as {
      record: { turns: number };
      excerpt: { chars: number };
    };
    forms.record.turns = 999;
    forms.excerpt.chars = 999;
    const again = memory.lastTurnWindowCensus()!.forms!;
    expect(again.record.turns).not.toBe(999);
    expect(again.excerpt.chars).not.toBe(999);
  });

  it('hands back a copy, so a caller cannot change what the next reader sees', async () => {
    const memory = system({ maxTurnChars: 80 });
    await memory.answerKnowledgeUpdate(QUESTION, [LONG]);

    const first = memory.lastTurnWindowCensus();
    expect(first).not.toBeNull();
    (first as { cut: number }).cut = 999;
    expect(memory.lastTurnWindowCensus()!.cut).not.toBe(999);
  });
});

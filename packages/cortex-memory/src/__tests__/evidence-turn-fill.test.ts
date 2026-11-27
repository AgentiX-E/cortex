/**
 * The turn unit's prefix rule leaves room unspent, and the same rule was already refuted once.
 *
 * ## The defect, in one paragraph
 *
 * `selectByRelevance` takes the **largest prefix** of the relevance order whose rendering fits the
 * room. A turn that does not fit therefore ends the pass: every turn ranked below it is dropped, no
 * matter how small, and the room it could not fill is returned to nobody. On the published artifact
 * that is up to **13,817 characters on a single question** and a mean of **1,356** on the four routes
 * that carry no per-turn cap, because a long turn early in the ranking strands whatever room is left.
 *
 * ## Why this is a repair and not a preference
 *
 * Because the project already ran the experiment on the sibling unit. `38753835652` dispatched the
 * session unit on the prefix rule against §13.26's turn unit with nothing else moved, and it lost:
 * **+25.75pp became +17.80pp**, MR fell **42.15% to 12.40%**, and the mechanism was not grouping but
 * the rule -- "the first session over the line ends the pass and the rest of the room is never
 * spent". `session-fill` was written to skip-and-continue and adopted. The turn unit kept the rule
 * that was refuted for sessions, and nothing has measured it there since.
 *
 * ## The property that makes the fill safe to state
 *
 * **Every turn the prefix carries, the fill carries.** The prefix carried `0..k-1` because their
 * rendering fits; the fill walks the same order from zero, so it accepts each of those for the same
 * reason before it ever reaches `k`. The fill's carried set is therefore a **superset** of the
 * prefix's on every question -- gold delivered can go up and cannot go down -- and the assertions
 * below are that containment rather than a list, because it is the whole safety argument.
 *
 * ## What it is not
 *
 * Not a cost lever and not a claim about accuracy. The room was already paid for; this spends it.
 * Whether the extra turns help or distract is a dispatch's question, which is why `turn` stays the
 * registered unit and this is a sixth value beside it rather than an edit to it -- a value whose
 * meaning changed between two archived runs makes both artifacts ambiguous (`§13.31`).
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

function recordingLlm(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'answer';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

/** A gate that admits everything, so the only variable is the selection. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

/** A turn of a named size. The tag survives `lastRetrievedContext`, the padding does not matter. */
function turn(tag: string, size: number): string {
  return `${tag}-${'x'.repeat(size)}`;
}

/**
 * One tall turn, one that cannot follow it, and three small ones behind both.
 *
 * Sized so that the prefix ends on the second candidate and the fill does not: the tall turn fits
 * alone, the fat one pushes the total past the room, and each small one is far below what the tall
 * turn left behind. The exact boundary is not pinned -- the instruction block's length is not this
 * suite's to fix -- and every assertion below holds across a wide band of room.
 */
function corpus(): string[] {
  return [
    turn('tall', 4_000),
    turn('fat', 6_000),
    turn('small1', 200),
    turn('small2', 200),
    turn('small3', 200),
  ];
}

/** Tall first, fat second, the three small ones last -- the order the ranking puts them in. */
function relevanceFor(_question: string, text: string): number {
  if (text.startsWith('tall')) return 1;
  if (text.startsWith('fat')) return 0.9;
  if (text.startsWith('small1')) return 0.8;
  if (text.startsWith('small2')) return 0.7;
  if (text.startsWith('small3')) return 0.6;
  return 0;
}

function system(options: Partial<CortexMemoryOptions>): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: OPEN_GATE,
    llm: recordingLlm([]),
    relevanceFor,
    // Around ten thousand characters of prompt, of which the instruction block, the question and the
    // evidence header take the first thousand or so. The properties hold anywhere in that band.
    maxPromptChars: 10_000,
    ...options,
  });
}

async function carried(
  options: Partial<CortexMemoryOptions>,
  context = corpus(),
): Promise<string[]> {
  const memory = system(options);
  await memory.answer('How many?', context);
  return (memory.lastRetrievedContext() ?? []).map((text) => text.split('-')[0]!.trim());
}

/** A system with no relevance signal at all, which is the configuration the unsignalled path owns. */
async function carriedWithoutSignal(units: 'turn' | 'turn-fill'): Promise<string[]> {
  const memory = new CortexMemory({
    now: NOW,
    gate: OPEN_GATE,
    llm: recordingLlm([]),
    maxPromptChars: 10_000,
    relevanceUnits: units,
  });
  await memory.answer('How many?', corpus());
  return (memory.lastRetrievedContext() ?? []).map((text) => text.split('-')[0]!.trim());
}

describe('the turn budget can fill the room it was given', () => {
  it('strands the room behind a turn that does not fit, on the prefix rule', async () => {
    // The control, and the whole reason this file exists. `tall` fits and `fat` does not, so the pass
    // ends -- and the three small turns behind them, which need 600 characters between them, are
    // dropped while thousands of characters of paid-for room go unspent.
    const prefix = await carried({ relevanceUnits: 'turn' });

    expect(prefix).toEqual(['tall']);
  });

  it('skips the turn that does not fit and carries the ones that do', async () => {
    const filled = await carried({ relevanceUnits: 'turn-fill' });

    expect(filled).toEqual(['tall', 'small1', 'small2', 'small3']);
  });

  it('carries every turn the prefix carried, on every corpus', async () => {
    // The safety property, asserted as containment rather than as a list: the fill can only add to
    // what the prefix delivered, so no gold the prefix reached can be lost by turning this on.
    for (const context of [corpus(), corpus().slice(0, 3), corpus().slice(0, 1), []]) {
      const prefix = new Set(await carried({ relevanceUnits: 'turn' }, context));
      const filled = await carried({ relevanceUnits: 'turn-fill' }, context);

      for (const tag of prefix) expect(filled).toContain(tag);
    }
  });

  it('keeps the prompt inside the room while filling', async () => {
    // A greedy fill that measured the room with an additive per-turn estimate would overrun it,
    // because every block carries a separator and its index can widen. The rule measures with the
    // renderer itself, and this is the assertion that says so.
    const seen: string[] = [];
    const memory = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm: recordingLlm(seen),
      relevanceFor,
      maxPromptChars: 10_000,
      relevanceUnits: 'turn-fill',
    });

    await memory.answer('How many?', corpus());

    expect(memory.lastRetrievedContext()).not.toEqual([]);
    expect(seen[0]!.length).toBeLessThanOrEqual(10_000);
  });

  it('presents what it filled in arrival order, not in the order it bought them', async () => {
    // Selection is by relevance; presentation is always arrival. A fill that appended in rank order
    // would print the evidence out of sequence and make relative-time questions unanswerable -- the
    // defect `selectByRelevance` documents. The small turns arrive last here, so a fill that appended
    // as it bought would print `tall, small1, small2, small3` and this would pass by coincidence:
    // the corpus below puts `small1` **before** `tall` so the two orders differ.
    const reordered = [turn('small1', 200), turn('tall', 4_000), turn('fat', 6_000)];
    const filled = await carried({ relevanceUnits: 'turn-fill' }, reordered);

    expect(filled).toEqual(['small1', 'tall']);
  });

  it('agrees with the prefix rule whenever every turn fits', async () => {
    // One change, not two: the rules differ only in what happens to a turn that does not fit.
    // Asserted rather than assumed, because a filling rule that also reordered would move the
    // reading for a reason nobody measured.
    const small = [turn('tall', 200), turn('fat', 200), turn('small1', 200)];
    const filled = await carried({ relevanceUnits: 'turn-fill' }, small);
    const prefixed = await carried({ relevanceUnits: 'turn' }, small);

    expect(filled).toEqual(['tall', 'fat', 'small1']);
    expect(filled).toEqual(prefixed);
  });

  it('is inert when no relevance signal was supplied', async () => {
    // Same guard as the other units, for the same reason: with no `relevanceFor` there is no order
    // to fill, and the unsignalled path clips the arrival-ordered text character for character.
    //
    // The option is **omitted** rather than set to `undefined`, and `exactOptionalPropertyTypes` is
    // why: `relevanceFor: undefined` is not a configured absence in this codebase, it is a type
    // error, and a test that spelled it that way would be testing a state the constructor refuses.
    const filled = await carriedWithoutSignal('turn-fill');
    const plain = await carriedWithoutSignal('turn');

    expect(filled).toEqual(plain);
  });

  it('buys the best turn clipped when not one whole turn fits, on both rules', async () => {
    // The branch below the search: a room smaller than every candidate still buys part of the best
    // one, because "too long to read" is not "no evidence". The fill must reach the same branch
    // rather than returning an empty window with the room unspent.
    const huge = [turn('tall', 20_000)];
    const filled = await carried({ relevanceUnits: 'turn-fill' }, huge);
    const prefixed = await carried({ relevanceUnits: 'turn' }, huge);

    expect(filled).toEqual(prefixed);
  });

  it('carries every turn the prefix carried, at every room in the boundary band', async () => {
    // The safety property, swept across the whole band rather than asserted at one budget. The fill
    // walks the same ranking from zero, so it accepts each turn the prefix accepted for the same
    // reason before it reaches the one the prefix stopped on -- and that has to hold at every room,
    // not at the one this suite happens to configure.
    //
    // The sweep is also what reaches the render-time rejection instead of the length pre-filter: a
    // turn whose content fits the remaining room by a character or two is measured too large once its
    // separator and index are counted, and both rules have to agree about that.
    const context = [turn('tall', 600), turn('fat', 900), turn('small1', 400), turn('small3', 250)];
    for (let room = 900; room <= 2_400; room += 20) {
      const prefixed = new Set(
        await carried({ maxPromptChars: room, relevanceUnits: 'turn' }, context),
      );
      const filled = await carried({ maxPromptChars: room, relevanceUnits: 'turn-fill' }, context);
      for (const tag of prefixed) expect(filled, `room ${room}`).toContain(tag);
    }
  });

  it('can carry fewer turns at a larger room, which is the cost of filling and is recorded here', async () => {
    // Not a defect being preserved: a property of the rule, asserted so that a future maintainer meets
    // it as a fact rather than as a surprise. A greedy fill spends the room in rank order, so a room
    // large enough for a big turn buys it and can then have nothing left for two small ones the
    // smaller room bought instead. The **prefix** rule cannot do this -- it carries `0..k-1` and `k`
    // only grows -- and that, not the number of turns, is what the prefix was buying.
    //
    // The characters delivered do not fall, which is the property that matters for the room: at a
    // larger budget the arm reads more text, in a different shape. `room = 1700` and `room = 1720` are
    // the two points that show it on this corpus, found by the sweep above rather than constructed.
    const context = [turn('tall', 600), turn('fat', 900), turn('small1', 400), turn('small3', 250)];
    const narrow = await carried({ maxPromptChars: 1_700, relevanceUnits: 'turn-fill' }, context);
    const wide = await carried({ maxPromptChars: 1_720, relevanceUnits: 'turn-fill' }, context);

    expect(wide.length).toBeLessThan(narrow.length);
    expect(wide).toContain('fat');
    expect(narrow).not.toContain('fat');
  });

  it('never overruns the room when many small blocks accumulate', async () => {
    // Where an additive estimate would fail. Every block costs its own text plus a separator plus
    // whatever index the renderer prefixes, and the index widens at 10 and again at 100 -- so a fill
    // that spent `content.length` per turn and trusted the total would cross the room on the two
    // boundaries and on nothing else. The rule measures with the renderer, and this is the corpus
    // that reaches the render-time rejection rather than the length pre-filter: two hundred turns of
    // sixty characters each are all short enough to pass the pre-filter and none is large enough to
    // end the pass on its own.
    const many = Array.from({ length: 200 }, (_, index) => turn(`small${index}`, 60));
    const seen: string[] = [];
    const memory = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm: recordingLlm(seen),
      relevanceFor: (_question, text) => (text.startsWith('small') ? 1 : 0),
      maxPromptChars: 4_000,
      relevanceUnits: 'turn-fill',
    });

    await memory.answer('How many?', many);

    expect(seen[0]!.length).toBeLessThanOrEqual(4_000);
    expect((memory.lastRetrievedContext() ?? []).length).toBeGreaterThan(1);
  });
});

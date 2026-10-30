/**
 * The window reorder, on the route that carries a reference date.
 *
 * `cortex-memory` owns the **operation** and not the corpus: it takes two readers
 * (`WindowOrdering`) and applies a stable partition to the delivered set. What this suite holds is the
 * half the builder's own tests cannot see -- that the option reaches the prompt at all, that it is
 * resolved per question rather than once at construction, that a question naming no period leaves the
 * delivery untouched, and that the date a window is resolved against is the **question's** date rather
 * than a substituted one.
 *
 * The last of those is the one worth a test rather than a comment. A qualifier resolves against the
 * date the question was asked -- "last Friday" is a different day for a question asked on a Tuesday than
 * for one asked on a Sunday -- and a product that substituted a clock would produce a plausible window
 * for every question, which is the direction that silently promotes the wrong turns (§13.152.2).
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions, WindowOrdering } from '../types.js';

const NOW = 1_759_470_000_000;

/** An LLM that answers a fixed string; the prompt is read off `lastRetrievedContext` instead. */
function silentLlm(): LLM {
  return {
    complete: async () => 'Berlin',
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

function system(options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ llm: silentLlm(), now: NOW, gate: OPEN_GATE, ...options });
}

/** The stamp the corpus renders, read the way the arm reads it. */
function dateOf(content: string): string | undefined {
  const match = /^\[(\d{4}\/\d{2}\/\d{2})/.exec(content);
  return match?.[1];
}

/** A resolver that admits one window and records the date it was asked to resolve against. */
function resolver(
  window: { start: string; end: string } | undefined,
  seen: (string | undefined)[] = [],
): WindowOrdering {
  return {
    dateOf,
    windowOf: (_question, questionDate) => {
      seen.push(questionDate);
      return questionDate === undefined ? undefined : window;
    },
  };
}

const TURNS = [
  '[2023/02/01 (Wed) 09:00] user: I moved to Lisbon.',
  '[2023/02/10 (Fri) 09:00] user: I visited the tile museum.',
  '[2023/02/03 (Fri) 09:00] user: My sister called.',
];

describe('the window reorder on the answering route', () => {
  it('moves the turns the window admits to the front of the delivery', async () => {
    const memory = system({ windowOrdering: resolver({ start: '2023/02/10', end: '2023/02/10' }) });

    await memory.answerTemporal('What did I do last Friday?', TURNS, '2023/02/15');

    // The delivery is the assertion, not the prompt text: `lastRetrievedContext` is what the arm records
    // into the artifact's `turns`, which is the field the pair of artifacts is compared on.
    expect(memory.lastRetrievedContext()).toEqual([TURNS[1], TURNS[0], TURNS[2]]);
  });

  it('leaves the delivery untouched when the question names no period', async () => {
    const memory = system({ windowOrdering: resolver(undefined) });
    const control = system();

    await memory.answerTemporal('What did I do?', TURNS, '2023/02/15');
    await control.answerTemporal('What did I do?', TURNS, '2023/02/15');

    expect(memory.lastRetrievedContext()).toEqual(control.lastRetrievedContext());
  });

  it('is absent unless the run supplies the readers', async () => {
    // The option is what turns the mechanism on, so a run that does not name it must deliver exactly what
    // every archived run delivered -- there is no default window and no default date reader.
    const control = system();
    await control.answerTemporal('What did I do last Friday?', TURNS, '2023/02/15');

    expect(control.lastRetrievedContext()).toEqual(TURNS);
  });

  it('resolves against the question date, and against nothing on a route without one', async () => {
    const seen: (string | undefined)[] = [];
    const memory = system({
      windowOrdering: resolver({ start: '2023/02/10', end: '2023/02/10' }, seen),
    });

    await memory.answerTemporal('What did I do last Friday?', TURNS, '2023/02/15');
    // The flat route is not given a date, so the reader sees `undefined` and answers `undefined` -- the
    // product does not substitute a clock, which is the defect a defaulted reference date would be.
    await memory.answer('What did I do?', TURNS);

    expect(seen).toEqual(['2023/02/15', undefined]);
  });

  it('does not promote a turn it cannot date', async () => {
    // `leadWhen` answering `false` leaves the turn where the admission layer ranked it. Promoting it
    // would be a claim the reader never made; dropping it would change the delivered set.
    const undated = 'user: I did something with no stamp';
    const memory = system({ windowOrdering: resolver({ start: '2023/02/10', end: '2023/02/10' }) });

    await memory.answerTemporal('What did I do?', [undated, TURNS[1] as string], '2023/02/15');

    expect(memory.lastRetrievedContext()).toEqual([TURNS[1], undated]);
  });

  it('delivers the same set as the control when the budget binds', async () => {
    // The half of the permutation claim that a prompt-level test cannot make, because only here does the
    // budget run with the product's real selection: a promotion applied before the cut would change
    // **which** turns survive it, and the artifact's multiset would then differ from the control's.
    const many = Array.from({ length: 40 }, (_, index) => {
      const day = String((index % 28) + 1).padStart(2, '0');
      return `[2023/02/${day} (Wed) 09:00] user: turn-${index}-${'z'.repeat(120)}`;
    });
    const window = { start: '2023/02/05', end: '2023/02/09' };
    const treated = system({ windowOrdering: resolver(window), maxPromptChars: 5_000 });
    const control = system({ maxPromptChars: 5_000 });

    await treated.answerTemporal('What did I do?', many, '2023/02/15');
    await control.answerTemporal('What did I do?', many, '2023/02/15');

    const delivered = treated.lastRetrievedContext()!;
    const reference = control.lastRetrievedContext()!;
    // Preconditions: the budget bound (fewer turns than offered) and the window has a target inside it.
    expect(reference.length).toBeLessThan(many.length);
    expect(reference.some((turn) => dateOf(turn) === '2023/02/05')).toBe(true);

    expect([...delivered].sort()).toEqual([...reference].sort());
    // And it is a different order, so the equality above is not the trivial one.
    expect(delivered).not.toEqual(reference);
    expect(dateOf(delivered[0] as string)).toBe('2023/02/05');
  });
});

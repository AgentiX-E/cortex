/**
 * The captured context must be a list of **turns**, not a list of the lines those
 * turns happen to contain.
 *
 * ## The defect these tests close
 *
 * §13.16.6 measured it on run `38142407062`: of 17,341 roster entries across the
 * MR questions, **14,724 (84.9%)** were continuation lines of a turn whose content
 * spans newlines. The capture joined the carried turns with `'\n'` and the reader
 * split that string back with `'\n'`, so every count downstream -- `turns`,
 * `evidenceTurns`, `evidenceChars`, and every ratio derived from them -- was a
 * count of **lines**. On this data that is about **6.6 lines per turn**, so the
 * budget's "~143 turns" was ~143 lines and roughly 22 turns.
 *
 * ## Why the unit is repaired in the capture rather than in the reader
 *
 * A join/split round trip is lossy in exactly one direction: the split cannot tell
 * a turn that contains a newline from two turns. No reader can recover the
 * boundary, and any fix that re-encodes it -- a sentinel separator, a quoted form,
 * a sentinel character -- substitutes one implicit encoding for another on data
 * whose content is model-generated free text. The only representation that keeps
 * the boundary is the one that never destroyed it: the `AssembledPrompt.carried`
 * list, which is in hand at the moment of capture.
 *
 * So `lastRetrievedContext` returns the list. This is a contract change and the
 * tests below pin it as one: the assertions are on the shape (`toEqual` against a
 * list of turn contents) and not on a count, because a count is the same on either
 * unit and would pass against the defect.
 *
 * ## Why the assertions are behavioural
 *
 * §37 recorded an escape where a guard asserted on source text and a real break
 * matched nothing. Every property below is read from a call's observable result:
 * what the accessor returns after a prompt was assembled, and what it returns when
 * no reader was reached at all.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** An LLM that records every prompt it is asked and always answers `answer`. */
function recordingLlm(seen: string[], answer = 'Berlin'): LLM {
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

/** A value function that returns a fixed value, so the gate is the only variable. */
function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

/** The gate configuration every test here shares, so the only variable is the route. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, ...options });
}

describe('the captured context is a list of turns, not a list of lines', () => {
  it('returns a list of turn contents rather than one joined string', async () => {
    // The unit at its smallest scale. `toEqual` against a one-element list and not a
    // length check: a joined string and a one-turn list agree on `length` only by
    // accident, and a count-based assertion would be satisfied by both.
    const memory = system({ llm: recordingLlm([]) });

    await memory.answer('Where did I go?', ['user: I went to Lisbon.']);

    expect(memory.lastRetrievedContext()).toEqual(['user: I went to Lisbon.']);
  });

  it('keeps a turn whose content spans newlines as ONE element', async () => {
    // This is the defect itself, at the smallest scale that exhibits it: a
    // two-line turn and a one-line turn are **two** carried turns, and the joined
    // form split them into three. Nothing downstream can undo that, which is why
    // the assertion is on the list rather than on the reader.
    const memory = system({ llm: recordingLlm([]) });

    await memory.answer('What happened?', [
      'user: I went to Lisbon.\nassistant: Noted.',
      'user: Then I visited Porto.',
    ]);

    expect(memory.lastRetrievedContext()).toEqual([
      'user: I went to Lisbon.\nassistant: Noted.',
      'user: Then I visited Porto.',
    ]);
  });

  it('reports one element per admitted turn, whatever the turns contain', async () => {
    // The property the roster's `turns` needs: its length is the number of turns the
    // reader was shown. Constructed so line count and turn count disagree maximally --
    // one turn of five lines against four one-line turns, so a line-unit reader
    // reports nine and a turn-unit reader reports five.
    const turns = [
      'user: one\ntwo\nthree\nfour\nfive',
      'user: six',
      'user: seven',
      'user: eight',
      'user: nine',
    ];
    const memory = system({ llm: recordingLlm([]) });

    await memory.answer('What did I say?', turns);

    const retrieved = memory.lastRetrievedContext()!;
    expect(retrieved).toHaveLength(turns.length);
    expect(retrieved).toEqual(turns);
  });

  it('reports an empty list when the reader was reached and shown nothing', async () => {
    // The third state, and the one the joined form could not express without
    // ambiguity. `''` meant "the reader was reached and carried nothing"; `null`
    // means "no reader was reached". A list keeps them apart with `[]` and `null`,
    // and neither is a number a reader could mistake for a measurement.
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen), maxPromptChars: 1 });

    await memory.answer('What did I note?', ['user: note number one']);

    expect(memory.lastRetrievedContext()).toEqual([]);
    // And the reader WAS reached, which is what makes this the empty state rather
    // than the declined one.
    expect(seen).toHaveLength(1);
  });

  it('still reports null when the machine declined before a reader was reached', async () => {
    // `null` is not `[]`, and collapsing them would erase the distinction the whole
    // accessor exists for -- the one `abstentionReasons().empty` counts.
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen) });

    await memory.answerTemporal('Where?', [], '2024-01-01', []);

    expect(memory.lastRetrievedContext()).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('preserves admission order, because order is part of the claim', async () => {
    // "The right turn was present but ranked below something else" is only visible
    // if the order survives the capture, and a list makes the order the list's own.
    const memory = system({ llm: recordingLlm([]) });

    await memory.answer('What did I do?', [
      'user: I moved to Lisbon.',
      'assistant: Noted your move.',
      'user: Then I visited Porto.',
    ]);

    expect(memory.lastRetrievedContext()).toEqual([
      'user: I moved to Lisbon.',
      'assistant: Noted your move.',
      'user: Then I visited Porto.',
    ]);
  });

  it('is a list on the session route, which carries the arm largest loss', async () => {
    // MR arrives as sessions with boundaries rather than as a flat list. The route
    // that carries half the measured loss must describe its evidence in the same
    // unit as the flat route, or a reader comparing them compares two units.
    const memory = system({ llm: recordingLlm([]) });

    await memory.answerSessions('How many trips did I take?', [
      ['user: I went to Lisbon.', 'assistant: Noted.'],
      ['user: I went to Porto.'],
    ]);

    const retrieved = memory.lastRetrievedContext()!;
    expect(Array.isArray(retrieved)).toBe(true);
    expect(retrieved).toContain('user: I went to Lisbon.');
    expect(retrieved).toContain('user: I went to Porto.');
  });

  it('is a list on the temporal route, which is the other half of the loss', async () => {
    const memory = system({ llm: recordingLlm([]) });

    await memory.answerTemporal(
      'When did I go to Lisbon?',
      ['user: I went to Lisbon in June.'],
      '2024-07-01',
      [['user: I went to Lisbon in June.']],
    );

    expect(memory.lastRetrievedContext()).toEqual(['user: I went to Lisbon in June.']);
  });

  it('overwrites the slot on each call, so it describes the most recent question', async () => {
    const memory = system({ llm: recordingLlm([]) });

    await memory.answer('First?', ['user: The first fact.']);
    await memory.answer('Second?', ['user: The second fact.']);

    expect(memory.lastRetrievedContext()).toEqual(['user: The second fact.']);
  });
});

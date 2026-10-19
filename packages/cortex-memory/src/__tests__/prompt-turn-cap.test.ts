/**
 * A per-turn character cap: how much one turn may contribute to the prompt.
 *
 * ## The measurement this exists for
 *
 * §13.34.3 concluded the evidence room is not the constraint, on **counts**: the window
 * holds a median of 26 turns against a median gold set of 24, so a perfect selector would
 * reach 0.917 coverage. `--turns` on the adopted run's artifact shows the other half of the
 * same room's arithmetic: the delivered turns have a **median of 272 characters**, with a
 * p90 of 2,305 and a max of 15,369. Twenty-six turns of median size are 7,072 characters in
 * a 24,000-character room.
 *
 * So the room is not spent on turns. It is spent on a **tail**, and the cut that decides
 * coverage falls at rank 26 (§13.66: the pool holds 73.2% of the gold and the delivery
 * 54.2%) because 26 long turns exhaust the characters before the ranked list is exhausted.
 *
 * ## What this option is, and what it deliberately is not
 *
 * It caps what a turn **contributes to the rendering**, not what the memory **admits** and
 * not what the artifact **records**. A cap on admission would move the gate, and the gate is
 * a different experiment (`threshold`, `retrievalThreshold`); a cap on the record would make
 * the artifact describe a prompt the model never read, which is the §13.11 defect in the
 * other direction. Presentation is the layer where the character budget is actually spent,
 * so it is the layer that gets the cap.
 *
 * ## How these tests avoid agreeing with the code under test
 *
 * The assertions name the exact string a capped turn must render as, computed from
 * `truncateCodePointSafe` -- the function the prompt budget already uses for its final clip
 * -- rather than from the cap's own arithmetic. And the "inert" case compares two prompts
 * for **byte equality** rather than checking that the option was present, because the claim
 * is about archived artifacts: every prior run must stay reproducible from the code.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import type { AdmittedTurn } from '../admission.js';
import { CortexMemory } from '../memory.js';
import { buildPrompt, buildSessionPrompt, truncateCodePointSafe } from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';
import type { CortexMemoryOptions } from '../types.js';

const CAP = 400;

/** A turn of a known length, numbered so the rendering's index is checkable. */
function turn(content: string, index = 0): AdmittedTurn {
  return { index, content, id: `t${index}` } as unknown as AdmittedTurn;
}

function longTurn(index = 0, length = 1_000): AdmittedTurn {
  // Words rather than one repeated character, so a cut landing mid-token is visible in the
  // rendered text rather than being hidden by the input's own uniformity.
  const words = 'the user said they visited Lisbon in May and stayed for two weeks ';
  return turn(words.repeat(Math.ceil(length / words.length)).slice(0, length), index);
}

function session(index: number, turns: readonly AdmittedTurn[]): AdmittedSession {
  return { index, turns: [...turns], size: turns.length } as unknown as AdmittedSession;
}

describe('a per-turn character cap', () => {
  it('renders each turn at the cap, and nothing more', () => {
    const long = longTurn();
    const { prompt } = buildPrompt('Where did they go?', [long], 'abstention', {
      maxTurnChars: CAP,
    });

    // The exact string the cap must produce, taken from the function the prompt budget
    // already uses for its own clip -- not from a second implementation of the arithmetic.
    expect(prompt).toContain(truncateCodePointSafe(long.content, CAP));
    // And the whole of it must be absent: a cap that emitted the truncated text and then the
    // original would satisfy the assertion above while spending the room the cap exists to
    // save.
    expect(prompt).not.toContain(long.content);
    expect(prompt.length).toBeLessThan(
      buildPrompt('Where did they go?', [long], 'abstention').prompt.length,
    );
  });

  it('reports the roster it was given, because the cap is presentation and not admission', () => {
    const long = longTurn();
    const assembled = buildPrompt('Where did they go?', [long], 'abstention', {
      maxTurnChars: CAP,
    });

    // The same object, not a copy: the roster is what the artifact records and what
    // `renderSessionBlocks` matches on by identity, so a cap that rebuilt the turns would
    // break the session grouping's membership test while looking correct in a prompt.
    expect(assembled.carried).toHaveLength(1);
    expect(assembled.carried[0]).toBe(long);
    expect(assembled.carried[0]!.content).toHaveLength(1_000);
  });

  it('leaves a turn at or under the cap byte-identical', () => {
    const short = turn('user: I went to Lisbon in May.');
    const exact = turn('y'.repeat(CAP));

    const without = buildPrompt('Where?', [short, exact], 'abstention').prompt;
    const with_ = buildPrompt('Where?', [short, exact], 'abstention', { maxTurnChars: CAP }).prompt;

    // At the boundary the two must agree exactly: `truncateCodePointSafe` returns the input
    // when it is not longer than the limit, and a cap that clipped one code unit short would
    // make every archived prompt with a long turn unreproducible for no stated reason.
    expect(with_).toBe(without);
  });

  it('is absent by default, so every archived prompt stays reproducible', () => {
    const long = longTurn();
    const absent = buildPrompt('Where?', [long], 'abstention').prompt;
    const explicitUndefined = buildPrompt('Where?', [long], 'abstention', {
      maxTurnChars: undefined,
    }).prompt;

    expect(explicitUndefined).toBe(absent);
    expect(absent).toContain(long.content);
  });

  it('fits more turns in the same room', () => {
    // The whole point: 40 turns of 600 characters do not fit 4,000 characters of room
    // uncapped, and do fit it capped at 200. This is the §13.67 arithmetic in miniature.
    const turns = Array.from({ length: 40 }, (_, index) => longTurn(index, 600));
    const cap = 200;
    const room = 4_000;

    const uncapped = buildPrompt('Where?', turns, 'abstention', { maxChars: room });
    const capped = buildPrompt('Where?', turns, 'abstention', {
      maxChars: room,
      maxTurnChars: cap,
    });

    expect(capped.carried.length).toBeGreaterThan(uncapped.carried.length);
    // Within budget in both cases -- the cap must not become a way to overflow the room.
    expect(capped.prompt.length).toBeLessThanOrEqual(room);
    expect(uncapped.prompt.length).toBeLessThanOrEqual(room);
    // And the capped prompt must hold the last turn it reports having carried, so the count
    // and the text cannot disagree.
    const last = capped.carried[capped.carried.length - 1]!;
    expect(capped.prompt).toContain(truncateCodePointSafe(last.content, cap).slice(0, 40));
  });

  it('applies on the session route, which is the route MR uses', () => {
    // A cap implemented only in `buildPrompt`'s renderer would be inert on the multi-session
    // route, which is exactly where the §13.67 measurement was taken.
    const long = longTurn();
    const sessions = [session(0, [long])];

    const { prompt } = buildSessionPrompt('Where?', sessions, { maxTurnChars: CAP });
    expect(prompt).toContain(truncateCodePointSafe(long.content, CAP));
    expect(prompt).not.toContain(long.content);
  });

  it('caps the content and not the numbering or the source id', () => {
    // The cap is a claim about a turn's *content*. Applying it to the rendered block would
    // eat into the index and, under the `sourced` rendering, into the memory id -- and an id
    // that arrives truncated is a provenance claim that is false rather than missing.
    const long = longTurn(3);
    const { prompt } = buildPrompt('Where?', [long], 'abstention', {
      maxTurnChars: CAP,
      rendering: 'sourced',
    });

    expect(prompt).toContain('1. [t3] ');
    expect(prompt).toContain(truncateCodePointSafe(long.content, CAP));
  });

  it('does not split a surrogate pair at the cut', () => {
    // The last code unit before the cap is a high surrogate here, so a naive slice would
    // emit a lone surrogate, which is not valid UTF-16 and corrupts the request body on
    // serialisation. The safeguard already exists (`truncateCodePointSafe`); this asserts
    // the cap goes through it rather than through `slice`.
    const content = 'a'.repeat(CAP - 1) + '\u{1F600}' + 'tail';
    const { prompt } = buildPrompt('Where?', [turn(content)], 'abstention', {
      maxTurnChars: CAP,
    });

    expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(prompt).toContain('a'.repeat(CAP - 1));
  });

  it('keeps the question and the instruction block intact when the cap binds', () => {
    // The cap spends one section's room, and `fitToBudget`'s allocation order is what keeps
    // the other two whole. A cap that shrank the instruction would delete the sentence the
    // abstention token is conditioned on -- the §13.13 defect, in a new place.
    const turns = Array.from({ length: 40 }, (_, index) => longTurn(index, 900));
    const { prompt } = buildPrompt('How many trips did they take?', turns, 'abstention', {
      maxChars: 3_000,
      maxTurnChars: 300,
    });

    expect(prompt).toContain('QUESTION: How many trips did they take?');
    expect(prompt).toContain('INSUFFICIENT_EVIDENCE');
  });
});

/**
 * The forwarding, which is where a variable becomes inert without anything failing.
 *
 * `#promptOptions` is the one place that turns a `CortexMemoryOptions` field into a
 * `PromptOptions` field, and a field it does not forward is a field the arm can set, the
 * config line can record, and the prompt can ignore -- the §7.4 side-channel defect. So the
 * assertions below are end-to-end: a `CortexMemory` configured with a cap is asked a
 * question, and the prompt the model actually received is what gets measured.
 */
describe('the cap reaches the model through the system', () => {
  function recordingLlm(seen: string[]): LLM {
    return {
      complete: async (prompt: string) => {
        seen.push(prompt);
        return 'Lisbon';
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
  }

  function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
    return new CortexMemory({
      now: 1_759_470_000_000,
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: () => 1,
      },
      ...options,
    });
  }

  it('caps the prompt the model reads and leaves the reported roster alone', async () => {
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen), maxTurnChars: CAP });
    const long = longTurn();

    await memory.answer('Where did they go?', [long.content]);

    const prompt = seen[0]!;
    expect(prompt).toContain(truncateCodePointSafe(long.content, CAP));
    expect(prompt).not.toContain(long.content);
    // The roster is the record, and the record is not a claim about what the model read:
    // capping it would make every artifact's `turns` describe a prompt nobody sent.
    expect(memory.lastRetrievedContext()?.[0]).toHaveLength(1_000);
  });

  it('is inert when the option is absent, character for character', async () => {
    const capped: string[] = [];
    const uncapped: string[] = [];
    const long = longTurn();

    await system({ llm: recordingLlm(uncapped) }).answer('Where?', [long.content]);
    await system({ llm: recordingLlm(capped), maxTurnChars: undefined }).answer('Where?', [
      long.content,
    ]);

    expect(capped[0]).toBe(uncapped[0]);
  });
});

/**
 * The cap's **reach**: which of the six routes it applies to.
 *
 * §13.72 measured the same cap on every route at once and got `+13` on MR and `−30` on IE in a
 * single run. MR's declines halved as their coverage rose; IE's thirty lost questions went
 * `correct → abstention` at a **median coverage of 100%** — complete evidence, and the model
 * withdrew forty-two times instead of fifteen. One switch cannot express both, so §13.73
 * dispatches the width unchanged and the reach narrowed.
 *
 * ## What these tests have to prove, and why byte equality is the assertion
 *
 * "The cap does not reach this route" is not "the cap is inert here" — it is that the prompt is
 * the **same string** a run without the option would have sent. Anything weaker (a shorter prompt,
 * a prompt without the truncated text) would pass on a route where the cap had been applied and
 * then compensated somewhere else, which is not the claim.
 */
describe('the cap reaches the routes it names and no others', () => {
  const ROUTES = [
    'multi-session',
    'temporal',
    'flat',
    'knowledge-update',
    'abstention',
    'assistant',
  ] as const;

  function recordingLlm(seen: string[]): LLM {
    return {
      complete: async (prompt: string) => {
        seen.push(prompt);
        return 'Lisbon';
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
  }

  function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
    return new CortexMemory({
      now: 1_759_470_000_000,
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: () => 1,
      },
      ...options,
    });
  }

  /** Drive one route with one long turn, and return the prompt the model was given. */
  async function promptOn(
    route: (typeof ROUTES)[number],
    options: Partial<CortexMemoryOptions> = {},
  ): Promise<string> {
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen), ...options });
    const content = longTurn().content;

    switch (route) {
      case 'multi-session':
        await memory.answerSessions('Where?', [[content]]);
        break;
      case 'temporal':
        await memory.answerTemporal('When?', [content], '2023-05-20');
        break;
      case 'flat':
        await memory.answer('Where?', [content]);
        break;
      case 'knowledge-update':
        await memory.answerKnowledgeUpdate('Where now?', [content]);
        break;
      case 'abstention':
        await memory.answerAbstention('Where?', [content]);
        break;
      case 'assistant':
        await memory.answerAssistant('Where?', [content]);
        break;
    }

    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  it('caps every route when no reach is named, which is what §13.68 shipped', async () => {
    for (const route of ROUTES) {
      const capped = await promptOn(route, { maxTurnChars: CAP });
      expect(capped, route).toContain(truncateCodePointSafe(longTurn().content, CAP));
      expect(capped, route).not.toContain(longTurn().content);
    }
  });

  it('leaves a route byte-identical when the reach does not name it', async () => {
    // The assertion the registration rests on: an unreached route must be comparable to its own
    // control run, not merely "similar".
    for (const route of ROUTES) {
      if (route === 'multi-session') continue;
      const reached = await promptOn(route, {
        maxTurnChars: CAP,
        maxTurnCharsRoutes: ['multi-session'],
      });
      expect(reached, route).toBe(await promptOn(route));
      expect(reached, route).toContain(longTurn().content);
    }
  });

  it('caps exactly the named route', async () => {
    const options = {
      maxTurnChars: CAP,
      maxTurnCharsRoutes: ['multi-session', 'temporal'],
    } as const;

    for (const route of ['multi-session', 'temporal'] as const) {
      const prompt = await promptOn(route, options);
      expect(prompt, route).toContain(truncateCodePointSafe(longTurn().content, CAP));
      expect(prompt, route).not.toContain(longTurn().content);
    }
    for (const route of ['flat', 'knowledge-update', 'abstention', 'assistant'] as const) {
      expect(await promptOn(route, options), route).toBe(await promptOn(route));
    }
  });

  it('reaches nothing when the reach is empty, which is how the option is disabled', async () => {
    for (const route of ROUTES) {
      expect(await promptOn(route, { maxTurnChars: CAP, maxTurnCharsRoutes: [] }), route).toBe(
        await promptOn(route),
      );
    }
  });

  it('keeps the reported roster uncapped on reached routes', async () => {
    // The reach changes where the *presentation* is capped, and nothing about what is recorded:
    // `goldOverlap` matches by text, so a capped roster would fail to match gold it delivered.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      maxTurnChars: CAP,
      maxTurnCharsRoutes: ['multi-session'],
    });
    const content = longTurn().content;

    await memory.answerSessions('Where?', [[content]]);

    expect(seen[0]).not.toContain(content);
    expect(memory.lastRetrievedContext()?.[0]).toHaveLength(1_000);
  });
});

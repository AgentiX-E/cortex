/**
 * The rendering the product ships, and the three calls that must not receive it.
 *
 * ## What changed, and why it is a test rather than a line in a report
 *
 * `45543010618` paired the cognitive system against itself on the 500-question register with `resolution`
 * as the only difference: **91.70% → 93.50%**, `R1`/`R2`/`R3` pass and `R4` -- "adopt if and only if `R2`
 * and `R3`" -- fired. Adoption means the *default* moved, and a default is exactly the kind of change that
 * can be announced in a document and never reach a reader: the option existed, the mechanism was reachable,
 * and a bare `assembleMemory` call still rendered every turn whole. So every assertion here is about the
 * prompt, because the prompt is the only artefact that cannot be true of a constant that never arrived.
 *
 * ## The four calls this file pins
 *
 * | call | what it must get | why |
 * | --- | --- | --- |
 * | names nothing, names a width | the form list | the adopted arm |
 * | `resolution: 'raw'` | the head cut, byte for byte | the opt-out, and the arm every reading before `45543010618` was taken on |
 * | names no width | the whole turn | the ceilings are ratios of the width; there is nothing to take a ratio of |
 * | names `turnWindow: 'match'` | the window, not a throw | two renderings of one cap, and the default must not collide with a named one |
 *
 * `minimal` is the fifth and it is not a rendering decision: that profile withholds every registered
 * default because its 39.55% was measured at the reference rendering, and a default that moved its bytes
 * would move a reading nobody re-took. It has its own assertion here rather than in `assemble.test.ts`,
 * because it is the same day's change and the same reason.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import type { AssembleOptions } from '../assemble.js';
import { REGISTERED_ARM } from '../registered-arm.js';

const NOW = 1_759_470_000_000;

function recordingLlm(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Berlin';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/** The prompt a call builds, through the multi-session route: the only route with a registered width. */
async function promptFor(
  turns: readonly { sessionId: string; ordinal: number; text: string }[],
  question: string,
  options: Omit<AssembleOptions, 'llm' | 'now' | 'storage'> = {},
): Promise<string> {
  const seen: string[] = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: NOW,
    storage: new SqliteStorage(),
    ...options,
  });
  await install.memory.remember([...turns]);
  await install.memory.askStored(question);
  return seen[0] ?? '';
}

const WIDTH = 400;
const QUESTION = 'when did the plumber replace the valve?';

/**
 * A turn whose only shared term is in its **last** sentence.
 *
 * That placement is the discriminator: a head cut of any width loses the match, and the excerpt exists to
 * keep it. A turn that opened with the match would make the two renderings agree about what survives, and
 * the test would pass on a product that never layered anything.
 */
const MATCHING = `The invoice was left on the hall table and the kettle was still warm. ${'The van was parked outside and the gate was open all morning. '.repeat(14)}The plumber came on the ninth.`;

/** A turn that shares nothing with the question: the record's population. */
const UNRELATED = `The committee met about the allotment. ${'There was a long discussion about the fence and the gate and the path. '.repeat(8)}`;

describe('the adopted rendering reaches a call that names nothing', () => {
  it('is the registered arm, read from the table rather than restated', () => {
    // A copy of the value here would pass while the table said something else.
    expect(REGISTERED_ARM.resolution).toBe('layered');
  });

  it('keeps a window around the match instead of the head', async () => {
    const prompt = await promptFor([{ sessionId: 's1', ordinal: 0, text: MATCHING }], QUESTION, {
      maxTurnChars: WIDTH,
      maxTurnCharsRoutes: ['multi-session'],
    });
    // The witness is the match: the question's own term sits past the cap, so a head cut of any width loses
    // it and the window keeps it -- and the opening, which the head cut would have kept, is the text the
    // window spends to reach it. Both halves are asserted because either one alone is satisfied by a
    // rendering that merely printed more.
    expect(prompt).toContain('The plumber came on the ninth.');
    expect(prompt).not.toContain('The invoice was left on the hall table');
    expect(prompt).not.toContain(MATCHING);
  });

  it('reduces a turn that shares nothing to its opening line', async () => {
    const prompt = await promptFor([{ sessionId: 's1', ordinal: 0, text: UNRELATED }], QUESTION, {
      maxTurnChars: WIDTH,
      maxTurnCharsRoutes: ['multi-session'],
    });
    expect(prompt).toContain('The committee met about the allotment.');
    // The record is 0.6 x the cap and one line, so the second sentence -- which carries no digit -- is gone.
    expect(prompt).not.toContain('There was a long discussion about the fence');
    expect(prompt).toContain('…');
  });

  it('fits more of a long corpus into the same room than the head cut does', async () => {
    // The mechanism's claim in one measurement: the selector takes the largest prefix of the ranking that
    // fits the room *after* rendering, so a shorter rendering reaches further down the same ranking. Each
    // turn carries a unique marker so the count is of turns delivered rather than of characters spent.
    const turns = Array.from({ length: 14 }, (_, index) => ({
      sessionId: `s${index}`,
      ordinal: 0,
      text: `TURN-${index} ${`the garden was quiet and the shed door was open. `.repeat(9)}`,
    }));
    const room = { maxTurnChars: WIDTH, maxTurnCharsRoutes: ['multi-session'] as const };
    const whole = await promptFor(turns, QUESTION, {
      ...room,
      maxPromptChars: 3_000,
      resolution: 'raw',
    });
    const formed = await promptFor(turns, QUESTION, { ...room, maxPromptChars: 3_000 });
    const delivered = (prompt: string): number =>
      turns.filter((_, index) => prompt.includes(`TURN-${index} `)).length;
    expect(delivered(whole)).toBeGreaterThan(0);
    expect(delivered(formed)).toBeGreaterThan(delivered(whole));
    // And the room is the same room: the shorter renderings were spent on more turns, not on a longer
    // prompt. Without this the assertion above would also pass for a mechanism that simply printed less.
    expect(formed.length).toBeLessThanOrEqual(whole.length + WIDTH);
  });
});

describe('the calls the adopted default must not reach', () => {
  it('leaves `resolution: raw` cutting by head, byte for byte', async () => {
    // The opt-out, and the arm every reading before `45543010618` was taken on. The character past the width
    // must be absent and the width's own last character present: that is a head cut, not a form.
    const prompt = await promptFor([{ sessionId: 's1', ordinal: 0, text: MATCHING }], QUESTION, {
      maxTurnChars: WIDTH,
      maxTurnCharsRoutes: ['multi-session'],
      resolution: 'raw',
    });
    expect(prompt).toContain(MATCHING.slice(0, WIDTH));
    expect(prompt).not.toContain(MATCHING.slice(0, WIDTH + 1));
    expect(prompt).not.toContain('…');
  });

  it('renders whole when the width reaches nowhere, because a ratio needs a base', async () => {
    // There is no "no width" state at this entry point: a call that names neither field takes the registered
    // width, which is what `assemble-turn-cap-reach.test.ts` pins. The only way to have no cap is the reach
    // opt-out, and there the rendering is whole -- the ceilings are ratios of a width that is not there, so
    // `layered` would be a name for a treatment with no scale. The class refuses that pairing when it is
    // spelled; the default must not produce it, and this is the call that would produce it.
    const prompt = await promptFor([{ sessionId: 's1', ordinal: 0, text: MATCHING }], QUESTION, {
      maxTurnChars: WIDTH,
      maxTurnCharsRoutes: [],
    });
    expect(prompt).toContain(MATCHING);
  });

  it('lets a named window withdraw the default rather than throwing on a legal call', async () => {
    // The class refuses `resolution: 'layered'` beside `turnWindow: 'match'`: two renderings of one cap, and
    // a reading could not say which one moved a question. A default that did not step aside would turn a
    // measured configuration (`C6`) into a construction throw, so `assemble.ts` resolves the rendering only
    // where the caller named no window.
    const tail = 'the sunflower height was written on the last page of the shed notebook.';
    const turns = [
      {
        sessionId: 's1',
        ordinal: 0,
        text: `${'we talked about the weather and the walk for a while. '.repeat(8)}${tail}`,
      },
    ];
    const prompt = await promptFor(turns, 'where was the sunflower height written?', {
      maxTurnChars: 200,
      maxTurnCharsRoutes: ['multi-session'],
      turnWindow: 'match',
    });
    // The window reaches the tail a head cut at 200 cannot, and the turn is still shortened: the window
    // marks its own elision, which is why the mark is not the discriminator between forms -- the surviving
    // text is.
    expect(prompt).toContain('shed notebook');
    expect(prompt).not.toContain(turns[0]!.text);
  });

  it('withholds the default from `minimal`, whose number was taken at another rendering', async () => {
    const prompt = await promptFor([{ sessionId: 's1', ordinal: 0, text: UNRELATED }], QUESTION, {
      profile: 'minimal',
    });
    expect(prompt).toContain(UNRELATED);
  });

  it('still gives `minimal` a rendering a caller names, because naming is not accepting', async () => {
    // `minimal` withholds defaults; it does not overrule a caller. `raw` is the only form reachable without a
    // width, and asserting it here is what keeps the branch above from being "minimal ignores the field".
    const prompt = await promptFor([{ sessionId: 's1', ordinal: 0, text: UNRELATED }], QUESTION, {
      profile: 'minimal',
      resolution: 'raw',
    });
    expect(prompt).toContain(UNRELATED);
  });
});

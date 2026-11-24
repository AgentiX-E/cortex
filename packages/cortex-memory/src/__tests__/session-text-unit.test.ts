/**
 * A session scored as a **document**, which is the one estimator the four existing units cannot express.
 *
 * ## The gap this file is the guard for
 *
 * `PREREG-MR-SESSION-CHANNEL.md` §2 compared this arm with the `reference-pipeline` and found one asymmetry
 * it named exactly: the reference ranks *"a session — its concatenated text, one embedding"*, and this arm
 * scores per turn and regroups. `'session'` and `'session-fill'` therefore rank a session by the **maximum**
 * of its turns' scores, which is a different estimator rather than a spelling of the same one — a maximum is
 * decided by the single best-matching sentence, so a session holding one incidental match outranks a session
 * that is about the question, and a session's later turns contribute nothing.
 *
 * `'session-text'` embeds one document per session, projects that score onto every turn the session owns,
 * and hands the result to the **same** selector `'session'` uses. The projection is what makes the
 * comparison single-variable: with every turn of a session carrying the session's score, "the best turn of a
 * session" *is* the session score, so the budget code is untouched and the only thing that moved is the
 * estimator.
 *
 * ## The fixture, and why it is ordered the way it is
 *
 * Two sessions, three turns each, and a three-dimensional space written by hand rather than produced by a
 * bag of words — the assertion is about which unit was indexed, and a real embedder would make the vectors a
 * second explanation for any disagreement.
 *
 * | text | vector | cosine to the question |
 * | --- | --- | --- |
 * | `b0` | (0.9, 0.44, 0) | **0.90** — the best single turn in the corpus |
 * | `join(B)` | (0.30, 0.95, 0) | **0.30** — diluted by its two unrelated turns |
 * | `a0` | (0.50, 0.87, 0) | 0.50 |
 * | `join(A)` | (0.95, 0.31, 0) | **0.95** — about the question as a whole |
 *
 * So the two estimators disagree by construction: maximum picks **B**, document picks **A**. And `B` is
 * listed first, which is what gives the projection a second witness — a version that indexed session
 * documents without projecting their scores would score every turn `0`, fall back to arrival order, and pick
 * **B** as well. The unit test and the projection bug therefore land on different answers.
 */
import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;
const QUESTION = 'how many pages did the novel have';

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: ((_memory: MemoryValue) => 1) as ValueFunction,
} as const;

/**
 * Three turns each, at a width the room can size a session with.
 *
 * The width is load-bearing rather than arbitrary: the contrast needs a room that buys **one session and
 * part of another**, because that is the only band in which the document unit (whole sessions) and the turn
 * unit (mixed) can disagree. `maxPromptChars` below is set to land inside it, and
 * `the room binds between one session and two` asserts that the band was hit rather than assumed.
 */
function body(tag: string): string {
  return `${tag}-${'x'.repeat(600)}`;
}

/** The turns `'session-text'` joins, spelled exactly as `CortexMemory` joins them. */
function joined(tags: readonly string[]): string {
  return tags.map(body).join('\n');
}

/**
 * The space, written by hand: the turn vectors and the session vectors are both inputs.
 *
 * A test that derived a session's vector from its turns would be asserting its own arithmetic about
 * embedding, and the question here is which text the index was asked to embed — not how a provider pools.
 */
const SPACE = new Map<string, readonly number[]>([
  // The question has to be in the space. Without it the query embeds to the zero vector, every cosine is
  // zero, and the ranking degenerates to arrival order — a fixture in which the two estimators cannot
  // disagree and every assertion below would pass for the wrong reason.
  [QUESTION, [1, 0, 0]],
  [body('b0'), [0.9, 0.44, 0]],
  [body('b1'), [0.05, 0.99, 0]],
  [body('b2'), [0, 0.2, 0.98]],
  [joined(['b0', 'b1', 'b2']), [0.3, 0.95, 0]],
  [body('a0'), [0.5, 0.87, 0]],
  [body('a1'), [0, 0.1, 0.99]],
  [body('a2'), [0.1, 0, 0.99]],
  [joined(['a0', 'a1', 'a2']), [0.95, 0.31, 0]],
]);

/** B first, so arrival order and the treatment disagree. */
const SESSIONS: string[][] = [['b0', 'b1', 'b2'].map(body), ['a0', 'a1', 'a2'].map(body)];

/**
 * An embedder that answers from {@link SPACE} and records every text it was asked for.
 *
 * Recording the texts rather than counting the calls is deliberate: the count would be equal for a batched
 * index over six turns and a batched index over two documents if `batch` were two, and the question is
 * which **texts** entered the index.
 */
function fixedEmbed(): {
  seen: string[];
  embed: (texts: string[]) => Promise<number[][]>;
} {
  const seen: string[] = [];
  return {
    seen,
    embed: (texts) => {
      seen.push(...texts);
      return Promise.resolve(
        texts.map((text) => {
          const vector = SPACE.get(text);
          if (vector === undefined) {
            // A text the fixture does not place: `0` rather than a guess, and the assertions below read a
            // zero as "this was not scored", which is the exact symptom a missing projection produces.
            return [0, 0, 0];
          }
          return [...vector];
        }),
      );
    },
  };
}

function recordingLlm(): LLM {
  return {
    complete: async () => 'answer',
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function system(
  embed: (texts: string[]) => Promise<number[][]>,
  overrides: Partial<CortexMemoryOptions> = {},
): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: OPEN_GATE,
    llm: recordingLlm(),
    // Room for one session of three and not for two: the selector is a prefix rule, so the room has to
    // bind between the first session's size and the two sessions' size or the contrast has nothing to read.
    maxPromptChars: 3_200,
    // Vector-only, so the unit is the only variable: the lexical channel would score a whole session
    // document by which words it contains, which is a second ranking rule inside the contrast.
    index: { embed, channels: ['vector'], k: 64 },
    ...overrides,
  });
}

type Run = {
  /** The tags of the turns the reader was shown, in the order the window printed them. */
  readonly carried: string[];
  /** Every text the index was asked to embed, the query excluded. */
  readonly embedded: string[];
};

async function run(overrides: Partial<CortexMemoryOptions>): Promise<Run> {
  const embedder = fixedEmbed();
  const memory = system(embedder.embed, overrides);
  await memory.answerSessions(QUESTION, SESSIONS);
  const carried = (memory.lastRetrievedContext() ?? []).map((text) => text.split('-')[0]!.trim());
  // The query is embedded too, by `lookup`, and counting it would make every expectation one too high --
  // the shape of a test that measures the provider's call count instead of the index's corpus.
  return { carried, embedded: embedder.seen.filter((text) => text !== QUESTION) };
}

describe('the two estimators disagree on this fixture, which is what makes the contrast readable', () => {
  it('the turn maximum picks B: one strong sentence beats a session that is about the question', async () => {
    // The control. `b0` is the single best turn in the corpus at 0.90, `a0` is 0.50, so a maximum over
    // turns ranks B first — and B is also the arrival-first session, so this assertion alone cannot
    // separate "maximum" from "arrival". The next one does.
    const control = await run({ relevanceUnits: 'session' });

    expect(control.carried).toContain('b0');
    expect(control.carried).not.toContain('a0');
  });

  it('the session document picks A: the whole conversation outranks the best sentence in another', async () => {
    // 0.95 for A's joined text against 0.30 for B's, and B arrives first, so arrival order is not an
    // available explanation. This is the reading the reference pipeline's session route is built on.
    const treated = await run({ relevanceUnits: 'session-text' });

    expect(treated.carried).toContain('a0');
    expect(treated.carried).not.toContain('b0');
  });

  it('carries every turn of the chosen session, because the unit of the room is a session', async () => {
    // The projection's consequence rather than its definition: `selectBySession` takes whole sessions, so
    // A's three turns arrive together. A version that projected the score but kept the turn unit would
    // deliver `a0` alone and pass the assertion above.
    const treated = await run({ relevanceUnits: 'session-text' });

    expect(treated.carried).toEqual(['a0', 'a1', 'a2']);
  });
});

describe('the room, which the contrast is drawn in', () => {
  it('binds between one session and two, so the two units have something to disagree about', async () => {
    // Stated rather than assumed. The document unit buys whole sessions and the turn unit mixes them, and
    // that difference is only observable when the room fits one session plus part of another: a room that
    // fits both makes every unit deliver the same six turns, and one that fits neither delivers none. A
    // future change to the instruction block moves this number, and this assertion is where it says so.
    const treated = await run({ relevanceUnits: 'session-text' });
    const control = await run({ relevanceUnits: 'session' });

    expect(treated.carried).toHaveLength(3);
    expect(control.carried).toHaveLength(3);
    // The turn unit under the same fixture and the same projected scores reaches into the other session,
    // which is the disagreement itself.
    const mixed = await run({ relevanceUnits: 'turn' });
    expect(mixed.carried.length).toBeGreaterThan(3);
  });
});

describe('what the index was asked to embed', () => {
  it('embeds two documents, not six turns', async () => {
    // The unit, observed at the boundary where the bill is drawn. Six texts means the index was built over
    // turns and the document scores came from somewhere else — the shape that would make
    // `relevanceUnits: 'session-text'` a label on the turn unit.
    const treated = await run({ relevanceUnits: 'session-text' });
    const turns = SESSIONS.flat();
    const documents = SESSIONS.map((session) => joined(session.map((text) => text.split('-')[0]!)));

    expect(treated.embedded).toHaveLength(2);
    expect(treated.embedded).not.toEqual(expect.arrayContaining(turns));
    expect(treated.embedded.sort()).toEqual([...documents].sort());
  });

  it('embeds six turns on the maximum-based unit, so the two arms are one configuration apart', async () => {
    // The control for the count above. Without it, an index that embedded documents under **every** unit
    // would pass the treatment assertion and silently change the estimator of three other units.
    const control = await run({ relevanceUnits: 'session' });

    expect(control.embedded).toHaveLength(6);
  });
});

describe('a text that arrives twice', () => {
  it('is scored once and still delivered twice, because the projection is a lookup and not a filter', async () => {
    // A session can repeat a sentence — a reminder, a restatement — and the projection keys on the text, so
    // the second occurrence must not be dropped, re-scored, or attributed to whatever session it was seen in
    // first. The first-occurrence rule is `SearchIndex.lookup`'s own, and this asserts that adopting it did
    // not turn a scoring rule into a de-duplication of the delivered evidence.
    const embedder = fixedEmbed();
    const memory = system(embedder.embed, { relevanceUnits: 'session-text' });
    await memory.answerSessions(QUESTION, [['a0', 'a0', 'a1'].map(body)]);

    const carried = (memory.lastRetrievedContext() ?? []).map((text) => text.split('-')[0]!.trim());
    expect(carried).toEqual(['a0', 'a0', 'a1']);
  });
});

describe('the unit refuses a route that has no boundaries', () => {
  it('throws on a flat route, naming the field rather than degrading to the turn unit', async () => {
    // The inert-configuration class `§10.10` recorded: a run whose artifact says `'session-text'` while
    // nothing about it differs from the turn unit is a run that priced an experiment it did not perform.
    // The flat routes flatten the corpus before ranking, so there is no document to score and the honest
    // answer is a refusal.
    const memory = system(fixedEmbed().embed, { relevanceUnits: 'session-text' });

    // No third argument: `answer` takes a flat `context` and **discards** a `sessions` argument, which is
    // the flattening this refusal is about. Passing the boundaries would have made the test describe a call
    // the route does not have.
    await expect(memory.answer(QUESTION, SESSIONS.flat())).rejects.toThrow(/session-text/);
  });

  it('answers the flat route on the turn unit with the same corpus', async () => {
    // The other half: the refusal is about the unit and not about the call, so removing the unit has to
    // make the same call succeed. A guard that rejected flat answering outright would pass the assertion
    // above and break every other route.
    const memory = system(fixedEmbed().embed, { relevanceUnits: 'turn' });

    await expect(memory.answer(QUESTION, SESSIONS.flat())).resolves.toBeTruthy();
  });
});

describe('the unit is not a second implementation of the selector', () => {
  it('delivers the same turns as the maximum-based unit when both estimators agree', async () => {
    // A corpus where the document and its best turn point the same way: one session per question, so the
    // two units cannot disagree about which session to buy and must produce a byte-identical prompt. This
    // is the assertion that keeps `'session-text'` a change of estimator rather than a change of rule.
    const single = [['a0', 'a1', 'a2'].map(body)];
    const embedder = fixedEmbed();
    const memory = system(embedder.embed, { relevanceUnits: 'session-text' });
    await memory.answerSessions(QUESTION, single);
    const treated = memory.lastPromptText();

    const controlEmbedder = fixedEmbed();
    const control = system(controlEmbedder.embed, { relevanceUnits: 'session' });
    await control.answerSessions(QUESTION, single);

    expect(treated).toBe(control.lastPromptText());
  });
});

/**
 * The product `createMemory` path is not asserted here on purpose.
 *
 * `createMemory` is `cortex-core`'s factory, and the unit is a `cortex-memory` option — a test here would
 * need the whole composition root to prove a selection rule, which is what `assemble.test.ts` is for. This
 * file's subject is the estimator, and the arm reaches it through `CortexMemory` exactly as written above.
 */
void createMemory;

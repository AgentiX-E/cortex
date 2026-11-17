/**
 * The plan reaches the prompt: the multi-query a user configures is the multi-query the model reads.
 *
 * ## The gap this closes
 *
 * `SearchIndex.queryPlan` is a capability, and a capability that stops at the index is a configuration line
 * rather than a product. The instrument has fused several queries per question since
 * `retrieveTopKByQueries` was written; the product had one. §33.4 of the plan names the round that moved the
 * fusion, and the two things that had to be proven with it:
 *
 * 1. **off is off** -- a plan naming one query produces the prompt the unplanned run produces, byte for
 *    byte, so an expansion arm whose model returned nothing costs what its control costs;
 * 2. **on is on** -- a plan naming a phrase the question cannot reach changes the order of the evidence the
 *    model reads, not merely the census.
 *
 * ## Why the assertions are prompts
 *
 * `#relevanceFor` and the index it builds are private, and `assemble-rooms.test.ts` records the argument for
 * keeping them so: a public accessor would exist for the test rather than for the caller. What a deployment
 * receives is the assembled prompt, and prompts are deterministic on a fixed corpus, so byte equality
 * between two assemblies is a stronger statement than reading a field -- it says the plan travelled through
 * `answer()` into the block the model reads.
 *
 * The second assertion is a **replacement at a fixed room**, and it took a failed first draft to find the
 * right shape for it. `selectByRelevance` selects by the signal and presents **chronologically** -- the
 * arrangement `prompt.ts` argues for, because a prompt printed in relevance order makes relative-time
 * questions unanswerable. A plan therefore cannot reorder the evidence block; what it changes is *which*
 * turns survive the room, and the room is the registered configuration rather than a contrived one. At 320
 * characters the question alone carries three turns and the plan carries three different ones, with the
 * railway turn displacing the train fare.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';

const NOW = 1_759_470_000_000;

/**
 * A deterministic stand-in for an embedding model: four concept axes, synonyms collapsed.
 *
 * The same shape `search-index.test.ts` uses, and for the same reason -- the mechanism under test is the
 * ranking, not the encoder, and a fixture whose vectors came from a provider could not be re-run.
 */
const CONCEPTS: readonly (readonly string[])[] = [
  ['car', 'automobile', 'vehicle'],
  ['train', 'railway', 'rail'],
  ['price', 'cost', 'fare'],
  ['when', 'date', 'year'],
];

function embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  return Promise.resolve(
    texts.map((text) => {
      const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
      const vector = new Array<number>(CONCEPTS.length).fill(0);
      for (let axis = 0; axis < CONCEPTS.length; axis += 1) {
        for (const word of CONCEPTS[axis]!) if (words.has(word)) vector[axis]! += 1;
      }
      return vector;
    }),
  );
}

/**
 * Two sessions of prose, one of which the question cannot reach.
 *
 * `railway repairs were expensive` shares no content term with the question and sits on the train axis while
 * the question sits on the car and price axes, so the single-query run cannot recall it by either channel.
 * The trailing weather turn keeps the corpus from being only evidence -- a prompt with three candidates
 * cannot show a reordering.
 */
const TURNS: readonly { sessionId: string; ordinal: number; text: string }[] = [
  { sessionId: 's1', ordinal: 0, text: 'the automobile cost twelve thousand' },
  { sessionId: 's1', ordinal: 1, text: 'railway repairs were expensive' },
  { sessionId: 's1', ordinal: 2, text: 'the automobile was red' },
  { sessionId: 's2', ordinal: 0, text: 'the train fare was nine thousand' },
  { sessionId: 's2', ordinal: 1, text: 'we talked about the weather for a while' },
];

const QUESTION = 'what did the automobile cost';

/**
 * The flat route's room for these tests: 320 characters.
 *
 * Binding on purpose. At 320 the question alone carries three of the five turns and a two-query plan carries
 * three different ones, so both the byte-equality below and the replacement are statements about a prompt that
 * is actually being cut. A room wide enough for the corpus would make every assertion here hold for the wrong
 * reason -- the defect `assemble-rooms.test.ts` records for its own first draft.
 */
const ROOM = 320;

/** The phrase the question cannot reach. It names an activity, which is what an expansion is for. */
const PHRASE = 'railway repairs';

function recordingLlm(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Twelve thousand.';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/** The prompt `answer()` hands the model, for one index configuration. */
async function promptFor(plan?: (question: string) => readonly string[]): Promise<string> {
  const seen: string[] = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: NOW,
    storage: new SqliteStorage(),
    embed,
    maxPromptChars: ROOM,
    index: { k: 5, ...(plan === undefined ? {} : { queryPlan: plan }) },
  });
  await install.memory.remember(TURNS);
  seen.length = 0;
  await install.memory.answer(
    QUESTION,
    TURNS.map((turn) => turn.text),
  );
  return seen[0] ?? '';
}

describe('a query plan reaches the prompt', () => {
  it('produces the unplanned prompt byte for byte when it names one query', async () => {
    // The property an expansion arm depends on. `cortex-eval`'s expansion returns a list that is empty when
    // the model refuses, and the arm then falls back to the bare question -- which must be the control's
    // prompt, not a re-basing of the same order onto rank scores. On a corpus where two turns tie, a
    // re-basing would reorder them, and the arm would report the fallback as the treatment.
    const unplanned = await promptFor();
    const degenerate = await promptFor((question) => [question]);
    expect(unplanned).toContain('the automobile cost twelve thousand');
    // The room is binding, so the equality below is not the equality of two uncut prompts.
    expect(unplanned).not.toContain('we talked about the weather for a while');
    expect(degenerate).toBe(unplanned);
  });

  it('changes which evidence survives the room, at a room it did not choose', async () => {
    // `railway repairs were expensive` shares no content term with the question and sits on the train axis
    // while the question sits on car and price, so neither channel reaches it and it ranks last. With the
    // phrase it is recalled **and** ranked second, which at 320 characters means it takes the third slot from
    // `the train fare was nine thousand` -- a turn the question alone reached through the price axis.
    //
    // This is the mechanism's product-level effect and not a side effect: the room is the registered
    // configuration's shape, every reading in this repository was taken with a binding one, and a turn that
    // never fits is a turn the model never reads.
    const unplanned = await promptFor();
    const planned = await promptFor(() => [QUESTION, PHRASE]);
    expect(unplanned).not.toContain('railway repairs were expensive');
    expect(unplanned).toContain('the train fare was nine thousand');
    expect(planned).toContain('railway repairs were expensive');
    expect(planned).not.toContain('the train fare was nine thousand');
    // Same room, same corpus, same question: the difference is the query set alone.
    expect(planned.length).toBeLessThanOrEqual(ROOM);
    expect(unplanned.length).toBeLessThanOrEqual(ROOM);
  });

  it('reports the query count the answer actually used', async () => {
    // The census is the only place a reader can tell "the plan returned two phrases" from "the plan returned
    // one and fell back", and the two produce different prompts only when the phrase happens to recall
    // something. Reading it through the composition root rather than through a hand-built index is what makes
    // it a statement about `answer()`.
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      embed,
      maxPromptChars: ROOM,
      index: { k: 5, queryPlan: () => [QUESTION, PHRASE] },
    });
    await install.memory.remember(TURNS);
    await install.memory.answer(
      QUESTION,
      TURNS.map((turn) => turn.text),
    );
    expect(install.memory.lastIndexCensus()?.queries).toBe(2);
    expect(install.memory.indexCost()?.indexes).toBe(1);
  });
});

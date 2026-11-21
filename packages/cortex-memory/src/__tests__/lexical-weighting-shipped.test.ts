/**
 * Does the documented snippet actually rank by term specificity?
 *
 * ## The gap these tests close
 *
 * `lexical-weighting.test.ts` proves `SearchIndex` ranks with the corpus it holds, and that is the component
 * the measurement priced. It is not the thing a user installs. `docs/USER-MANUAL.md` §6.10 documents:
 *
 * ```ts
 * assembleMemory({ llm, now, storage, index: { lexicalWeighting: 'idf' } });
 * ```
 *
 * and between that call and `SearchIndex`'s constructor there are four hops -- the public option type, the
 * factory, `CortexMemory`'s own field, and the per-question construction in `#relevanceFor`. Any of them
 * dropping the field would leave every unit test there green and the documented feature inert: the eval side
 * would price a capability the product does not deliver, which is the failure mode requirement ⑯ names.
 *
 * ## Why the assertion is about which turn reaches the prompt
 *
 * The first draft of this file asserted the **order** of two turns inside the prompt, and it failed for a
 * reason worth writing down: the assembled evidence is rendered in **session/ordinal order**, not in rank
 * order. Rendering is chronological because the reader is told "each session is a separate conversation";
 * the ranking has already done its work by choosing *which* turns are in the block. So a prompt-order
 * assertion reads the arrival order of the corpus and would pass on an implementation that never sorted.
 *
 * What makes a ranking observable is a room that cannot hold every turn. Both runs below assemble the same
 * ten-turn corpus into a 700-character room: under `flat` the delivered block is echo turns that repeat the
 * question's generic vocabulary, and under `idf` the one turn that names the thing asked about is bought
 * first. Nothing here constructs a `SearchIndex` -- if one of the four hops loses the option, both prompts
 * are the same prompt and the pair fails.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';

const NOW = 1_759_470_000_000;

/**
 * The corpus `lexical-weighting.test.ts` uses, kept identical on purpose.
 *
 * Its weight ratio is what the ranking reads: `bikes` occurs once and `how`/`many`/`own` occur in nine of the
 * ten turns, so a flat count makes the echo turns win and a corpus-priced count makes the one turn naming the
 * thing asked about win. Copying the corpus rather than inventing a second one keeps the two files from
 * disagreeing about what the defect looks like.
 */
const CORPUS: readonly string[] = [
  "I've been reading about carbon fiber wheels for my bikes and I think I'll make the switch.",
  'How many of these should I plan for, and do I own the tools already?',
  'How many steps does it count, and can I own the data it collects?',
  'That depends how many rides you plan and what you already own.',
  'How many sessions you can own is a setting, not a limit.',
  'It depends how many you own and how many you plan to buy.',
  'You can own as many as you like; how many is up to you.',
  'How many you own today is the only number that counts.',
  'Whatever you own, the question is how many you actually use.',
  'The forecast says rain on Saturday, so bring a jacket.',
];

const QUESTION = 'How many bikes do I own?';

/**
 * A fragment of the gold turn.
 *
 * Not `bikes`: the question is in the prompt and it contains that word, so a marker taken from the question
 * reads `true` on every run -- including the one that delivered no gold turn at all.
 */
const GOLD_MARKER = 'carbon fiber wheels';

/**
 * A room that holds roughly five of the ten turns, measured rather than guessed.
 *
 * Large enough that the delivered block is a real selection and not a single clipped turn, small enough that
 * the selection has to choose. At 48,000 every turn fits and the two runs are byte-identical, which is how the
 * first draft of this file managed to assert an ordering that no ranking produced.
 */
const ROOM = 2400;

function recordingLlm(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Unknown';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/**
 * The prompt a caller's own `assembleMemory` call produces, with every turn offered and every turn admitted.
 *
 * `channels: ['lexical']` because this test prices the lexical channel and nothing else: a vector channel with
 * no embedder is refused by the index, and supplying one would make the assertion a statement about a model
 * rather than about the option under test.
 */
async function promptFor(weighting: 'flat' | 'idf'): Promise<string> {
  const seen: string[] = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: NOW,
    storage: new SqliteStorage(),
    maxPromptChars: ROOM,
    index: { channels: ['lexical'], lexicalWeighting: weighting },
  });
  await install.memory.remember(
    CORPUS.map((text, ordinal) => ({ sessionId: 's1', ordinal, text })),
  );
  seen.length = 0;
  await install.memory.askStored(QUESTION);
  return seen[0] ?? '';
}

describe('the documented `index: { lexicalWeighting }` reaches the ranking', () => {
  it('delivers the turn naming the thing asked about when the weighting is idf', async () => {
    const prompt = await promptFor('idf');
    expect(prompt).toContain(QUESTION);
    expect(prompt).toContain(GOLD_MARKER);
  });

  it('loses that turn to the echo turns under flat, which is the defect', async () => {
    // The pair is the assertion. Either half alone passes on a product that ignores the option: `idf` alone
    // against a full room passes trivially, and `flat` alone passes on a corpus where the gold turn is the
    // longest. Together they say the option decides which turn reaches the reader.
    const prompt = await promptFor('flat');
    expect(prompt).toContain(QUESTION);
    expect(prompt).not.toContain(GOLD_MARKER);
    // And the block is not empty: a run that delivered nothing would also "not contain" the gold marker.
    expect(prompt).toContain('How many of these should I plan for');
  });

  it('refuses a weighting it does not administer, at the call the caller can read', async () => {
    // The index is built per question, so a validation that lives only in its constructor surfaces after the
    // first `remember()` -- on a store that may already hold the user's data. The refusal belongs at assembly,
    // where the typo is: `SearchIndexOptions.lexicalWeighting` is a string union from TypeScript's point of
    // view and nothing at all from JavaScript's, which is how a documented option reaches production as
    // `"tf-idf"` and ranks flat while looking configured.
    expect(() =>
      assembleMemory({
        llm: recordingLlm([]),
        now: NOW,
        storage: new SqliteStorage(),
        // @ts-expect-error -- the value is the thing under test: a caller can reach this from JavaScript.
        index: { channels: ['lexical'], lexicalWeighting: 'tf-idf' },
      }),
    ).toThrow(/tf-idf/);
  });
});

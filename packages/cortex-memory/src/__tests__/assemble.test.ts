/**
 * The three profiles, end to end, through the two methods a user has.
 *
 * ## Why a smoke test per profile is the acceptance and not a formality
 *
 * The defect this file answers is not "a function is missing" — it is that `CortexMemory` had no non-test
 * construction in the published package: thirty optional fields and the only working combination living in
 * `bench/`, which ships nowhere. A profile that compiles but cannot get from "I told it something" to "it
 * answered" is that defect with a nicer name, so each one is driven through the same three steps:
 * **three sessions in → `remember` → `askStored` → a non-empty answer**.
 *
 * ## What is asserted beyond "it answered"
 *
 * - `minimal` has no ranking: `indexCost()` stays `undefined`, which is the difference between the three
 *   profiles and not an implementation detail — `reader` exists for the index and nothing else.
 * - `full` refuses to be constructed without a second store, and names the option. A boundary whose two
 *   sides are one file is not a boundary, and the failure has to happen at assembly rather than at the first
 *   publication.
 * - `full` erases: the transcript is the eighth surface, and a profile that wires the boundary to a corpus
 *   but not the corpus to the boundary would report a complete erasure over a surviving turn.
 */
import { describe, expect, it } from 'vitest';
import type { EmbedFn, LLM } from '@agentix-e/cortex-core';
import { ERASURE_TOKEN, MemoryEmbeddingCacheStore } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory, type AssemblyProfile } from '../assemble.js';
import { SUPERSEDED_MARKER } from '../superseded.js';

const NOW = 1_759_470_000_000;

/** A deferral: no rule claims it, so it becomes a card, and the card is a copy of the sentence. */
const SECRET = 'Falcon is the code name for the Helix Bio acquisition.';
const UNRELATED = 'The invoice for the bicycle repair was paid late again.';

function recordingLlm(seen: string[] = []): LLM {
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

/** Three sessions, as a transcript: what a person would have told a memory over a week. */
const CONVERSATION = [
  { sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' },
  { sessionId: 's1', ordinal: 1, text: 'My landlord is called Anke.' },
  { sessionId: 's2', ordinal: 0, text: 'The invoice was paid late again.' },
  { sessionId: 's3', ordinal: 0, text: 'Anke raised the rent in June.' },
];

describe('each profile gets from a transcript to an answer', () => {
  const profiles: readonly AssemblyProfile[] = ['minimal', 'reader', 'full'];

  it.each(profiles)('%s: three sessions in, one answer out', async (profile) => {
    const install = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      shared: new SqliteStorage(),
      profile,
    });

    expect(await install.memory.remember(CONVERSATION)).toEqual({ appended: 4, duplicates: 0 });
    expect(await install.memory.askStored('Where did I move?')).toBe('Berlin');
    expect(install.memory.lastRoute()).toBe('multi-session');
    expect(await install.corpus.size()).toBe(4);
  });

  it('is `minimal` when no profile is named, because that is the cheapest conformant assembly', () => {
    const install = assembleMemory({ llm: recordingLlm(), now: NOW, storage: new SqliteStorage() });
    expect(install.profile).toBe('minimal');
    expect(install.disclosure).toBeUndefined();
    // The default attribution is the class's own, so an artifact from an unnamed assembly is still nameable.
    expect(install.memory.name).toBe('cortex-memory');
  });

  it('carries the name it is given through to the memory, so a run can be attributed', () => {
    const install = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      name: 'support-desk',
    });
    expect(install.memory.name).toBe('support-desk');
  });

  it('has no ranking on `minimal` and a ranking on the other two', async () => {
    const minimal = assembleMemory({ llm: recordingLlm(), now: NOW, storage: new SqliteStorage() });
    await minimal.memory.remember(CONVERSATION);
    await minimal.memory.askStored('Where did I move?');
    // `undefined` rather than zeros: the profile built no index, and a census of zeroes would read as an
    // index that ran and found nothing.
    expect(minimal.memory.indexCost()).toBeUndefined();

    const reader = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'reader',
    });
    await reader.memory.remember(CONVERSATION);
    await reader.memory.askStored('Where did I move?');
    expect(reader.memory.indexCost()).toBeDefined();
  });

  it('gives the vector channel to `reader` when an embedder is supplied, and only then', async () => {
    const calls: string[][] = [];
    const embed: EmbedFn = (texts) => {
      calls.push([...texts]);
      return Promise.resolve(texts.map(() => [1, 0, 0]));
    };
    const lexical = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'reader',
    });
    await lexical.memory.remember(CONVERSATION);
    await lexical.memory.askStored('Where did I move?');
    expect(lexical.memory.indexCost()?.embedTexts ?? 0).toBe(0);

    const vector = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'reader',
      embed,
    });
    await vector.memory.remember(CONVERSATION);
    await vector.memory.askStored('Where did I move?');
    expect(calls.length).toBeGreaterThan(0);
    expect(vector.memory.indexCost()?.embedTexts ?? 0).toBeGreaterThan(0);
  });
});

describe('the superseded mark is reachable from the composition root', () => {
  /**
   * Two statements of one detail in two sessions, which is what a transcript actually looks like.
   *
   * The wording is `a2f3aa27`'s, the `KU` question that answers 1250 against a gold of 1300 in all four
   * repetitions of its run.
   */
  const CHANGED = [
    {
      sessionId: 's1',
      ordinal: 0,
      text: 'I have got 1250 followers on Instagram now, so insights would help.',
    },
    {
      sessionId: 's2',
      ordinal: 0,
      text: 'I think I am close to 1300 followers on Instagram now, honestly.',
    },
  ];
  const ASK = 'How many followers do I have on Instagram now?';

  /** One assembly, one question, the prompt the model was handed. */
  async function promptThrough(
    rendering: 'mark' | undefined,
    profile: AssemblyProfile = 'reader',
  ): Promise<string> {
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      profile,
      ...(profile === 'full' ? { shared: new SqliteStorage() } : {}),
      ...(rendering === undefined ? {} : { supersededRendering: rendering }),
    });
    await install.memory.remember(CHANGED);
    await install.memory.askStored(ASK);
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  /**
   * This is the assertion §16 of the plan exists for: the capability is *composed*, not merely present.
   *
   * `askStored` is the only method `assembleMemory` gives a customer for asking a transcript a question,
   * and it routes to **multi-session** — the route `conflicts` excludes. A reach copied from `conflicts`
   * would have passed every unit test in `superseded-inline.test.ts` and delivered a mark no customer
   * could ever see. So the assertion is made here, through the product's own entry point, and it would
   * fail on the earlier wiring.
   */
  it('marks the replaced statement through `remember` → `askStored`', async () => {
    const off = await promptThrough(undefined);
    const on = await promptThrough('mark');
    expect(off).not.toContain(SUPERSEDED_MARKER);
    expect(on).toContain(`${CHANGED[0]!.text}${SUPERSEDED_MARKER}`);
    expect(on.replace(SUPERSEDED_MARKER, '')).toBe(off);
    expect(on.length - off.length).toBe(SUPERSEDED_MARKER.length);
  });

  it('is off by default, and `full` reaches the same mechanism', async () => {
    expect(await promptThrough(undefined, 'full')).not.toContain(SUPERSEDED_MARKER);
    expect(await promptThrough('mark', 'full')).toContain(SUPERSEDED_MARKER);
  });
});

describe('the vector store a deployment hands in', () => {
  /** An embedder that records every text it is asked for. The bill is the only thing that changes. */
  function recordingEmbed(): { embed: EmbedFn; texts: string[] } {
    const texts: string[] = [];
    return {
      texts,
      embed: (batch) => {
        texts.push(...batch);
        return Promise.resolve(batch.map(() => [1, 0, 0]));
      },
    };
  }

  const TURNS = CONVERSATION.map((turn) => turn.text);

  it('does not pay again for a corpus a previous assembly embedded', async () => {
    // The claim, in the units a bill can subtract. Two assemblies over one store, the same transcript: the
    // second one must send no corpus text upstream. A store this function replaced rather than kept would make
    // both runs pay and every assertion in the profile smoke tests would still pass.
    const store = new MemoryEmbeddingCacheStore();

    const first = recordingEmbed();
    const firstInstall = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'reader',
      embed: first.embed,
      embeddingStore: store,
    });
    await firstInstall.memory.remember(CONVERSATION);
    await firstInstall.memory.askStored('Where did I move?');
    expect(first.texts).toEqual(expect.arrayContaining(TURNS));

    const second = recordingEmbed();
    const secondInstall = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'reader',
      embed: second.embed,
      embeddingStore: store,
    });
    await secondInstall.memory.remember(CONVERSATION);
    await secondInstall.memory.askStored('Where did I move?');

    expect(second.texts.filter((text) => TURNS.includes(text))).toEqual([]);
    // Stronger than the corpus-only claim, and it is what the run actually shows: the question was embedded
    // by the first assembly too, so the second one sends *nothing* upstream.
    expect(second.texts).toEqual([]);
    // The control, and the reason this is not a test of a dead embedder: the first assembly did call it, for
    // both the turns and the question.
    expect(first.texts).toEqual(expect.arrayContaining([...TURNS, 'Where did I move?']));
    expect(store.size()).toBeGreaterThan(0);
  });

  it('points the erasure at the store it was handed', async () => {
    // `full`, because that is the profile with a boundary. The subtle failure this pins is the one `memory.ts`
    // records for `index.store`: a store replaced here, plus a boundary wired to the original, is an erasure
    // that reports a count over a vector the store still answers.
    const store = new MemoryEmbeddingCacheStore();
    const install = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      shared: new SqliteStorage(),
      profile: 'full',
      embed: (batch) => Promise.resolve(batch.map(() => [1, 0, 0])),
      embeddingStore: store,
    });
    const disclosure = install.disclosure;
    if (disclosure === undefined) throw new Error('the full profile must have a boundary');

    await install.memory.remember([
      { sessionId: 's1', ordinal: 0, text: SECRET },
      { sessionId: 's2', ordinal: 0, text: UNRELATED },
    ]);
    await disclosure.say(SECRET, { id: 's1' });
    await disclosure.accept('s1');
    await install.memory.askStored('What is the code name?');
    const before = store.size();
    expect(before).toBeGreaterThan(0);

    const erased = await disclosure.forget('s1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });
    expect(erased.record.removed.vectors).toBeGreaterThanOrEqual(1);
    // The store the caller can inspect is the one the erasure reached: this is the assertion a boundary given
    // its own memo would fail while the record above still counted a removal.
    expect(store.size()).toBeLessThan(before);
  });

  it('refuses a store no embedder would fill, and names the option', () => {
    expect(() =>
      assembleMemory({
        llm: recordingLlm(),
        now: NOW,
        storage: new SqliteStorage(),
        profile: 'reader',
        embeddingStore: new MemoryEmbeddingCacheStore(),
      }),
    ).toThrow(/embeddingStore needs options\.embed/);
  });

  it('refuses a store on the profile that builds no index', () => {
    expect(() =>
      assembleMemory({
        llm: recordingLlm(),
        now: NOW,
        storage: new SqliteStorage(),
        embeddingStore: new MemoryEmbeddingCacheStore(),
        embed: (batch) => Promise.resolve(batch.map(() => [1, 0, 0])),
      }),
    ).toThrow(/not reachable on profile: 'minimal'/);
  });
});

describe('the disclosure boundary', () => {
  it('is absent on the first two profiles and present on the third', () => {
    for (const profile of ['minimal', 'reader'] as const) {
      const install = assembleMemory({
        llm: recordingLlm(),
        now: NOW,
        storage: new SqliteStorage(),
        shared: new SqliteStorage(),
        profile,
      });
      expect(install.disclosure).toBeUndefined();
    }
    const full = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      shared: new SqliteStorage(),
      profile: 'full',
    });
    expect(full.disclosure).toBeDefined();
  });

  it('refuses `full` without a second store, and says which option is missing', () => {
    expect(() =>
      assembleMemory({
        llm: recordingLlm(),
        now: NOW,
        storage: new SqliteStorage(),
        profile: 'full',
      }),
    ).toThrow(/profile: full needs options\.shared/);
  });

  it('erases a sentence from the corpus as well as from the cards', async () => {
    const install = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      shared: new SqliteStorage(),
      profile: 'full',
      embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0])),
    });
    const disclosure = install.disclosure;
    if (disclosure === undefined) throw new Error('the full profile must have a boundary');

    // The transcript holds the sentence, the boundary holds a card cut from it, and the index holds a vector
    // of it. Three copies, one act.
    await install.memory.remember([
      { sessionId: 's1', ordinal: 0, text: SECRET },
      { sessionId: 's2', ordinal: 0, text: UNRELATED },
    ]);
    await disclosure.say(SECRET, { id: 's1' });
    await disclosure.accept('s1');
    const [card] = await disclosure.cards();
    if (card === undefined) throw new Error('the deferral must produce a card');
    // The index embeds the turns it ranks, so this is what puts a vector in the store the erasure reaches.
    await install.memory.askStored('What is the code name?');
    expect(await install.corpus.context()).toContain(card.text);

    const erased = await disclosure.forget('s1', {
      acknowledge: ERASURE_TOKEN,
      reason: 'user-request',
    });

    // One turn, and the count is the store's answer rather than this test's expectation.
    expect(erased.record.removed.turns).toBeGreaterThanOrEqual(1);
    // And the vector the index wrote, which pins a convention nothing types: the index's memo and this
    // assembly's memo have to compose the same key, and they agree because both use the default fingerprint.
    // A `SearchIndex` that started naming its own space would make this zero and would otherwise be invisible
    // until an erasure reported success over a vector that still answered.
    expect(erased.record.removed.vectors).toBeGreaterThanOrEqual(1);
    expect(await install.corpus.context()).not.toContain(card.text);
    // The control: the sentence nobody erased is still there, so an erasure that emptied the corpus would fail
    // here rather than pass every assertion above.
    expect(await install.corpus.context()).toEqual([UNRELATED]);
  });
});

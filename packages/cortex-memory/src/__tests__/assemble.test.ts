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

  it('is `reader` when no profile is named, which is the profile a reading was taken under', () => {
    const install = assembleMemory({ llm: recordingLlm(), now: NOW, storage: new SqliteStorage() });
    // Not the cheapest profile. `minimal` was the default for one release and it is the `relevanceSignal=none`
    // arm, measured at 39.55% against `self-index`'s 91.40% on the same instrument; the reason lives in
    // `assemble.ts`'s table and the property is asserted in the last block of this file.
    expect(install.profile).toBe('reader');
    // A boundary is still not defaulted, because it needs a second store to exist at all.
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
    const minimal = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      // Named, because the default is `reader` now: a test about the profile that ranks nothing has to be
      // the test that asks for it, or a change to the default would silently move which arm this asserts.
      profile: 'minimal',
    });
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
        profile: 'minimal',
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

/**
 * The default profile, and the two claims the module docblock makes about it.
 *
 * ## Why this is asserted here rather than in the manual
 *
 * The registered instrument prices two configurations of this product and nothing else: with a ranking
 * (`relevanceSignal=self-index`, 500 questions x 4 passes, **91.40%**) and without one (`none`, same
 * instrument, **39.55%**). The difference is **51.85 points** and the paired split is 66 questions against
 * 38 (McNemar p = 7.8e-3), because an unsignalled prompt clips the arrival-ordered list from the tail --
 * `chooseEvidence`'s first branch -- so the newest turn is the first one lost.
 *
 * A default that names `minimal` therefore ships the second of those two numbers. The tests below assert the
 * property rather than the name: an assembly that names no profile must rank, and a turn that arrival order
 * would clip must still reach the reader. A docblock cannot hold that, and this file has already paid once
 * for a comment that described behaviour the code did not have.
 *
 * ## The control in every case
 *
 * `minimal` is assembled beside the default in each test and must fail the same assertion. Without it, a
 * corpus whose answer happened to sit in the head would make the ranking test pass with no ranking at all.
 */
describe('the default profile carries the ranking a reading was taken under', () => {
  /** Ten turns that share no content word with the question, so lexical ranking has exactly one candidate. */
  const FILLER = [
    'The bicycle repair invoice was paid late again.',
    'A parcel from the courier arrived on Tuesday morning.',
    'The landlord repainted the hallway in a pale grey.',
    'My neighbour keeps a greyhound called Otto.',
    'The coffee grinder needs a new burr every two years.',
    'We planted tomatoes along the south wall in April.',
    'The train to the coast leaves at a quarter past seven.',
    'A wasp built a nest under the kitchen window.',
    'The library extended its opening hours until eight.',
    'The radiators were serviced before the cold spell.',
  ];
  /** The answer, last in arrival order, and the only turn that shares a word with the question. */
  const ANSWER = 'I now live in Lisbon, and the flat is two streets from the river.';
  const QUESTION = 'Which city do I live in now?';

  function transcript(): { sessionId: string; ordinal: number; text: string }[] {
    return [
      ...FILLER.map((text, ordinal) => ({ sessionId: 's1', ordinal, text })),
      { sessionId: 's1', ordinal: FILLER.length, text: ANSWER },
    ];
  }

  /**
   * How many characters this route's instruction spends before the evidence begins.
   *
   * Read off a prompt assembled at a room nothing can bind, because the alternative is a constant that has
   * to be re-tuned every time an adopted instruction changes size — which is what happened here: the room
   * stayed at 600 while the block behind it grew from 460 to 1,620 characters, and the test kept passing
   * its shape while measuring nothing. `EVIDENCE:` is the boundary the builder always writes.
   */
  async function instructionChars(): Promise<number> {
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      maxPromptChars: 1_000_000,
    });
    await install.memory.remember(transcript());
    seen.length = 0;
    await install.memory.askStored(QUESTION);
    const at = (seen[0] ?? '').indexOf('EVIDENCE:');
    expect(at).toBeGreaterThan(0);
    return at;
  }

  it('names the profile that builds an index, so the ranking exists without being asked for', async () => {
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
    });
    await install.memory.remember(transcript());
    await install.memory.askStored(QUESTION);

    expect(install.profile).toBe('reader');
    // The mechanism, not the label: `indexCost()` is written only by the product's own index, and the
    // assembly that has none leaves it absent. This is the same field `minimal`'s test asserts is `undefined`.
    expect(install.memory.indexCost()).toBeDefined();
  });

  it('reaches a turn that arrival order would clip, and minimal does not', async () => {
    const ranked: string[] = [];
    const clipped: string[] = [];
    // A room that holds the head of the transcript and not its tail: with no signal the evidence is
    // `truncateCodePointSafe(render(turns), room)`, which is exactly what loses the newest turn.
    //
    // Measured from the instruction rather than fixed, because the instruction is the half of this prompt
    // the arm decides and it has moved twice: this test used 600 while the route read the 460-character
    // `abstention` block, and 600 is now *inside* the registered multi-session contract — a room that
    // small returns the instruction and no evidence at all, so the ranking it means to test is not
    // consulted. The device is the room; the subject is the ranking; `220` is the evidence budget the old
    // constant left, kept because the assertions below are calibrated to it.
    const room = (await instructionChars()) + 520;
    const reader = assembleMemory({
      llm: recordingLlm(ranked),
      now: NOW,
      storage: new SqliteStorage(),
      maxPromptChars: room,
    });
    // `minimal`'s room is its own, not the default profile's. Its instruction is a fraction of the
    // registered multi-session block, so handing it the same absolute room leaves it ~2,700 characters for
    // a 600-character corpus — every turn fits and the truncation this test exists to demonstrate cannot
    // happen. 300 is the same evidence budget the default profile now gets once its instruction is
    // subtracted, stated directly: arrival order spends it on the head and loses the newest turn.
    const smallest = assembleMemory({
      llm: recordingLlm(clipped),
      now: NOW,
      storage: new SqliteStorage(),
      profile: 'minimal',
      maxPromptChars: 300,
    });

    await reader.memory.remember(transcript());
    await smallest.memory.remember(transcript());
    await reader.memory.askStored(QUESTION);
    await smallest.memory.askStored(QUESTION);

    expect(ranked[0]).toContain('Lisbon');
    // The control, and the reason the default moved: the same corpus, the same room, the same question.
    expect(clipped[0]).not.toContain('Lisbon');
    // And the bound is a bound: both prompts are the room's, not the corpus's.
    expect(ranked[0]!.length).toBeLessThan(room + 200);
    expect(clipped[0]!.length).toBeLessThan(400);
  });

  it('takes maxPromptChars, because the docblock that refuses to default it says a caller states it', async () => {
    // The omission is deliberate -- a second default here would be a second arm -- but an omission is only
    // defensible if the caller can state the value. Before this field the two sentences could not both be
    // true, and the sentence that survived was the one a reader trusted.
    const install = assembleMemory({
      llm: recordingLlm(),
      now: NOW,
      storage: new SqliteStorage(),
      maxPromptChars: 1_500,
    });
    expect(install.profile).toBe('reader');
  });
});

/**
 * The vector channel, through the composition root, on a turn the lexical channel cannot see.
 *
 * ## Why this is a product test and not a second index test
 *
 * `search-index.test.ts` proves the channel works on the class. What it cannot prove is that a user of the
 * **published** package can reach it: `embed` is an `AssembleOptions` field, and a field the composition
 * root dropped would leave every index test green and every deployment lexical. The registered arm
 * (`CORTEX_MEMORY_INDEX_EMBEDDING`) is about to withhold exactly this option and publish a number for the
 * withholding, so the two sides have to be checkable against each other: the reading says what the channel
 * is worth end to end, and this says the channel in the reading is the one a user supplies.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The paraphrase shares no content term with the question, so the lexical channel cannot reach it at any
 * room -- measured across 400, 430, 470, 520 and 600 characters, where the lexical arm never contains the
 * answer and the vector arm does from 400 up. That is the assertion, and it is the one the option is for.
 *
 * Not asserted: that the answer is *first*. Reciprocal-rank fusion rewards a turn that **both** channels
 * found, so a decoy with lexical rank 1 and vector rank 2 outranks a paraphrase with vector rank 1 and no
 * lexical rank. That is `fuse.ts`'s documented rule rather than a defect, and asserting an order here
 * would pin this test to a fusion constant instead of to the option's reach.
 */
describe('the vector channel is reachable from the composition root', () => {
  const QUESTION = 'Which city do I live in now?';
  /** Shares `live` with the question, so the lexical channel always finds it. */
  const DECOY = 'I live near the station, and the flat is above a bakery.';
  /** Shares no content term with the question: only a vector channel can reach it. */
  const ANSWER = 'These days I am based in Lisbon, two streets from the river.';
  const FILLER = [
    'The bakery closes on Mondays and reopens on Wednesday.',
    'My landlord repainted the hallway in a pale grey.',
    'A parcel from the courier arrived on Tuesday morning.',
  ];

  /**
   * A two-dimensional space with the question and the paraphrase in one direction and every other turn in
   * the other, so the channel's verdict is unambiguous rather than a matter of degree.
   *
   * A table rather than similarity the test computes: this is a fake, and a fake that derived its answers
   * from the same words the lexical channel sees would be measuring that channel.
   */
  const ABOUT_LISBON = [QUESTION, ANSWER];
  const embed: EmbedFn = (texts) =>
    Promise.resolve(texts.map((text) => (ABOUT_LISBON.includes(text) ? [1, 0] : [0, 1])));

  function transcript(): { sessionId: string; ordinal: number; text: string }[] {
    return [DECOY, ...FILLER, ANSWER].map((text, ordinal) => ({ sessionId: 's1', ordinal, text }));
  }

  /** The instruction's own width on this corpus. See the copy in the block above for why it is measured. */
  async function instructionChars(): Promise<number> {
    const seen: string[] = [];
    const install = assembleMemory({
      llm: recordingLlm(seen),
      now: NOW,
      storage: new SqliteStorage(),
      maxPromptChars: 1_000_000,
    });
    await install.memory.remember(transcript());
    seen.length = 0;
    await install.memory.askStored(QUESTION);
    return (seen[0] ?? '').indexOf('EVIDENCE:');
  }

  it('reaches a paraphrase the lexical channel cannot, when a caller supplies an embedder', async () => {
    const lexical: string[] = [];
    const vector: string[] = [];
    // Enough for the note and two turns, not for the five-turn corpus: the arms have to choose. Measured
    // from the instruction for the reason the test above records, with a narrower budget than that one
    // because this corpus is four turns and both channels have to be able to reach the answer.
    const room = (await instructionChars()) + 460;

    const withoutEmbedder = assembleMemory({
      llm: recordingLlm(lexical),
      now: NOW,
      storage: new SqliteStorage(),
      maxPromptChars: room,
    });
    const withEmbedder = assembleMemory({
      llm: recordingLlm(vector),
      now: NOW,
      storage: new SqliteStorage(),
      maxPromptChars: room,
      embed,
    });
    await withoutEmbedder.memory.remember(transcript());
    await withEmbedder.memory.remember(transcript());
    await withoutEmbedder.memory.askStored(QUESTION);
    await withEmbedder.memory.askStored(QUESTION);

    // The control ranks, and it ranks: the decoy shares a term, so an arm that delivered nothing would
    // be failing for a reason other than the channel.
    expect(lexical[0]).toContain('station');
    expect(lexical[0]).not.toContain('Lisbon');
    // The treatment, with one option more and every other input identical.
    expect(vector[0]).toContain('Lisbon');
    expect(vector[0]).toContain('station');
  });
});

/**
 * The four rendering fields on the published entry point.
 *
 * ## The gap this closes
 *
 * `maxTurnChars`, `turnCutMarker`, `turnWindow` and `resolution` existed on `CortexMemory` and on the
 * benchmark arm, and **none of them was on `assembleMemory`** -- so every rendering this repository has ever
 * published a number for was reachable from `bench/**` and from nowhere a customer could call. A requirement
 * that an evaluated capability be shippable does not survive a composition root that cannot set it, and the
 * four are the same failure `sessionClock` had before `turn-clock.test.ts` walked it end to end.
 *
 * ## Why the assertion is the prompt
 *
 * Because forwarding is invisible in the fields: `CortexMemory` reads `undefined` as off, so a root that
 * dropped the option would build an instance whose bytes are the historical ones and whose behaviour is a
 * head cut. What a deployment receives is the prompt, and the reader is the only observer that sees it.
 */
describe('the rendering fields reach the published entry point', () => {
  const QUESTION = 'how many shoes were packed?';
  const LONG = `shoes packed: ${'the hall was full of boxes and coats. '.repeat(11)}`;

  it('renders by form when the resolution is named', async () => {
    const control: string[] = [];
    const layered: string[] = [];
    const bare = assembleMemory({
      llm: recordingLlm(control),
      now: NOW,
      storage: new SqliteStorage(),
      maxTurnChars: 200,
    });
    const rendered = assembleMemory({
      llm: recordingLlm(layered),
      now: NOW,
      storage: new SqliteStorage(),
      maxTurnChars: 200,
      turnCutMarker: 'ellipsis',
      resolution: 'layered',
    });
    for (const install of [bare, rendered]) {
      await install.memory.remember([{ sessionId: 's1', ordinal: 0, text: LONG }]);
      await install.memory.askStored(QUESTION);
    }
    // The witness is how much of the turn arrived. A head cut at 200 prints five repetitions of the filler;
    // the excerpt keeps a window of 1.5 x the cap around the match, so it prints more than the cap could --
    // which is the one thing a cap alone can never do, whatever its width.
    const repeats = (prompt: string): number => prompt.split('boxes and coats').length - 1;
    expect(layered[0]).toContain('…');
    expect(repeats(layered[0]!)).toBeGreaterThan(repeats(control[0]!));
    expect(layered[0]!.length).toBeGreaterThan(control[0]!.length);
  });

  it('forwards the window, so a caller can ask for the match rather than the head', async () => {
    const control: string[] = [];
    const windowed: string[] = [];
    const tail = 'the sunflower height was written on the last page of the shed notebook.';
    const text = `${'we talked about the weather and the walk for a while. '.repeat(8)}${tail}`;
    const ask = 'where was the sunflower height written?';
    const bare = assembleMemory({
      llm: recordingLlm(control),
      now: NOW,
      storage: new SqliteStorage(),
      maxTurnChars: 200,
    });
    const withWindow = assembleMemory({
      llm: recordingLlm(windowed),
      now: NOW,
      storage: new SqliteStorage(),
      maxTurnChars: 200,
      turnWindow: 'match',
    });
    for (const install of [bare, withWindow]) {
      await install.memory.remember([{ sessionId: 's1', ordinal: 0, text }]);
      await install.memory.askStored(ask);
    }
    expect(control[0]).not.toContain('shed notebook');
    expect(windowed[0]).toContain('shed notebook');
  });
});

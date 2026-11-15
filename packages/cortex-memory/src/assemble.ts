/**
 * The known-good assembly: the one thing an installer is supposed to call.
 *
 * ## The gap this closes
 *
 * `CortexMemory` had **no non-test construction** outside `bench/run-ablation.ts`, and this package ships
 * `files: ["dist"]` with a single `.` export. So an integrator received a class with thirty optional fields
 * and no worked example of which combination runs: the only assembly that was known to work lived in the
 * measurement arm, which is not in the published package. Every published reading was produced by an
 * assembly a customer could not see, which is the same asymmetry `docs/PRODUCT-CAPABILITY-LEDGER.md` names
 * for capabilities.
 *
 * ## Three profiles, and why the list is closed
 *
 * | profile | what it adds over the one before | what it is for |
 * | --- | --- | --- |
 * | `minimal` | nothing — an identity gate and no index | the smallest conformant memory; answers from the turns it is given, in the order it is given them |
 * | `reader` | the retrieval index (lexical, plus a vector channel when an embedder is supplied) | the ranking this repository has priced at several points of accuracy |
 * | `full` | the disclosure boundary: cards, releases, and erasure over all eight surfaces | a deployment where a person says something and can later withdraw it |
 *
 * Three rather than a matrix because a matrix of thirty options is what the class already is. Each profile
 * is a **worked** configuration — smoke-tested end to end through `remember` → `askStored` — and a caller who
 * needs a fourth composes `CortexMemory` directly, which is what the fields are for.
 *
 * ## The one deliberate omission
 *
 * `maxPromptChars` has **no default here**. The per-route room table is the registered arm's configuration,
 * and a second default would be a second arm: a run that changed only this file's constant would move every
 * published number while claiming to have changed nothing. A caller who wants a bound states it.
 *
 * ## Why `assembleMemory` and not the `createMemory` the design sketch names
 *
 * `cortex-core` already exports `createMemory`, which builds the domain's `Memory` value. Two functions with
 * one name, one import apart, is how a reader ends up calling the wrong one and getting a type error that
 * says nothing about which. This function is named for what it does to the parts it is given.
 */
import type { EmbedFn, LLM, Storage } from '@agentix-e/cortex-core';
import { EmbeddingMemo, MemoryEmbeddingCacheStore } from '@agentix-e/cortex-core';

import { Corpus } from './corpus.js';
import { DisclosureSession } from './disclosure/session.js';
import { CortexMemory } from './memory.js';
import type { SearchIndexOptions } from './retrieval/search-index.js';
import type { GateOptions } from './types.js';

/** How much of the product one call wires up. See the table in the module comment. */
export type AssemblyProfile = 'minimal' | 'reader' | 'full';

export type AssembleOptions = {
  /** The text generator. Injected, because this package owns no provider and no credential. */
  readonly llm: LLM;
  /** Epoch milliseconds for every time-stamped decision. A constant pins a run; nothing here reads the clock. */
  readonly now: number;
  /**
   * Where the transcript goes — and, for `full`, the private side of the disclosure boundary as well.
   *
   * Any `Storage`: `@agentix-e/cortex-storage/sqlite` or `/pg` in Node, `/opfs` or `/idb` in a browser. The
   * corpus reads and writes nothing else, which is what makes the same assembly run on all four.
   */
  readonly storage: Storage;
  /** Defaults to `minimal`, so a caller who names nothing gets the cheapest configuration that conforms. */
  readonly profile?: AssemblyProfile | undefined;
  /**
   * The vector channel, as a batch function over texts.
   *
   * Supplying it changes two things and both are visible in the census: `reader`/`full` gain a dense channel
   * beside the lexical one, and `full` gains a vector store the erasure can reach. Omitting it is not a
   * degradation — lexical retrieval is the registered configuration's ranking signal, and the vector channel
   * has its own readings.
   */
  readonly embed?: EmbedFn | undefined;
  /**
   * The public side of the disclosure boundary. Required by `full` and refused by the other two.
   *
   * A second store rather than a second table in the first one, because the boundary *is* the separation: a
   * card that reached the shared store is what a colleague can read, and storing both sides in one file would
   * leave the rule to a table name.
   */
  readonly shared?: Storage | undefined;
  /** Attribution label for the memory. Defaults to the class's own. */
  readonly name?: string | undefined;
  /** Gate overrides. The defaults are the identity configuration: admit everything, decline nothing early. */
  readonly gate?: Partial<GateOptions> | undefined;
  /** Retrieval knobs other than the embedder and the store, which this function owns. */
  readonly index?: Omit<SearchIndexOptions, 'embed' | 'store'> | undefined;
  /** An existing corpus, when the caller already has one — a second assembly over a live transcript. */
  readonly corpus?: Corpus | undefined;
};

/** What a profile wires up, as the objects themselves rather than as a bag of booleans. */
export type Installation = {
  readonly profile: AssemblyProfile;
  /** The memory. `remember` and `askStored` are reachable here, and so is every route the contract declares. */
  readonly memory: CortexMemory;
  /** The transcript. Reachable because a caller may want to read or count it without asking a question. */
  readonly corpus: Corpus;
  /**
   * The disclosure boundary, on `full` only.
   *
   * Present rather than hidden behind a method because erasure is an act with its own preconditions — a
   * token, a reason, a warning that names what will be destroyed — and wrapping it would either hide those
   * or restate them. A caller that has it can `cards()`, `release()`, `forget()`; a caller that does not
   * asked for a profile without a boundary.
   */
  readonly disclosure: DisclosureSession | undefined;
};

/**
 * Wire up the product.
 *
 * The identity gate — `threshold: 0`, `retrievalThreshold: 0`, unbounded session budget — is what every
 * profile starts from, and it is the configuration most of this repository's readings were taken under:
 * admission keeps everything and declines nothing on its own, so a difference between two runs is a
 * difference in the mechanisms above it rather than in a gate nobody named.
 */
export function assembleMemory(options: AssembleOptions): Installation {
  const profile = options.profile ?? 'minimal';
  const gate: GateOptions = {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: Number.POSITIVE_INFINITY,
    ...options.gate,
  };
  const corpus = options.corpus ?? new Corpus({ store: options.storage, now: options.now });

  // One store for the vectors, created here rather than inside the index, because two objects have to share
  // it: the index memoises every text it embeds, and the erasure has to reach the same entries. A store
  // created per question would make an erasure able to name a key nobody wrote.
  const embed = options.embed;
  const vectors = embed === undefined ? undefined : new MemoryEmbeddingCacheStore();

  const index =
    profile === 'minimal'
      ? undefined
      : {
          ...options.index,
          ...(embed === undefined || vectors === undefined ? {} : { embed, store: vectors }),
        };

  const disclosure = profile === 'full' ? boundary(options, corpus, embed, vectors) : undefined;

  const memory = new CortexMemory({
    llm: options.llm,
    now: options.now,
    gate,
    corpus,
    ...(index === undefined ? {} : { index }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });

  return { profile, memory, corpus, disclosure };
}

/**
 * The `full` profile's boundary.
 *
 * Split out because it is the only branch in this file with a precondition, and a precondition buried in a
 * ternary is one a reader discovers by running.
 */
function boundary(
  options: AssembleOptions,
  corpus: Corpus,
  embed: EmbedFn | undefined,
  vectors: MemoryEmbeddingCacheStore | undefined,
): DisclosureSession {
  const shared = options.shared;
  if (shared === undefined) {
    throw new Error(
      'profile: full needs options.shared: the disclosure boundary is the separation between what a person ' +
        'said privately and what a colleague may read, so it is constructed over two stores. Supplying one ' +
        'and using it for both sides would leave the rule to a table name. Pass a second Storage, or use ' +
        'profile: reader for retrieval without the boundary.',
    );
  }
  const store = vectors;
  return new DisclosureSession({
    private: options.storage,
    shared,
    now: () => options.now,
    // The same entries the index writes: one store, and a memo whose only job here is to compute the keys the
    // index already used. `embedding-cache.ts` records why an eraser must be the owner of the key function.
    ...(embed === undefined || store === undefined
      ? {}
      : { vectors: new EmbeddingMemo(embed, { store }) }),
    // The eighth surface. Without it `forget()` empties five tables and a cache and leaves the same sentence
    // in the transcript, which is the defect class this repository has already shipped once.
    turns: corpus,
  });
}

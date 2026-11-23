/**
 * The shipped product, in the shape the competitor harness asks for.
 *
 * ## Why this exists
 *
 * A comparison between "cortex" and three competitors was being read against the wrong cortex: the arm in
 * that table was `CortexSessionProvider`, a bare session-budget adapter, while the product publishes
 * 91.25% at 7,448 prompt tokens per question from the *assembled* arm — six routes, an embedding index two
 * hundred and fifty-six turns wide, the registered prompt contract. Scoring `trim-2.8k` against Mastra says
 * nothing about the thing this repository ships, and a table that omits the shipped row invites the
 * conclusion "copy Mastra's compressor" from a comparison that never measured what would benefit from it.
 *
 * So the product gets one more adapter, on the same loop as everybody else: same sessions in, one answer
 * out. The cost is real and is the point — through this class the product is measured by a harness that
 * knows nothing about its internals.
 *
 * ## The three decisions an adapter has to make, and what each costs
 *
 * 1. **There is no `search` that can be read by a shared reader.** The product's retrieval and its answer
 *    are one act: `askStored` chooses a route, spends a per-route character budget, renders a contract and
 *    calls the model once. Handing a "context" to a foreign reader would either (a) run the product's
 *    retrieval without its rendering — a system nobody ships — or (b) call the model twice and bill the
 *    product for a reader it does not use. Mastra and MemCog make the same choice in this harness and their
 *    rows say `answerer: self`; this one says it for the same reason. `search` therefore returns nothing and
 *    says so in the artifact rather than pretending a ranked list exists.
 *
 * 2. **The assembly is the published one, by not naming anything.** `assembleMemory({ llm, now, storage,
 *    embed })` — no `promptContract`, no `ask`, no `index`. Those four arguments are all a user is told to
 *    supply, and every other field arrives from `REGISTERED_ARM`. A test that passed the registered values
 *    explicitly would agree with a composition root that had stopped applying them, which is the defect
 *    `registered-arm.test.ts` exists for; this adapter is the second, independent witness because it reaches
 *    the product through the entry point a customer uses.
 *
 * 3. **The embedding cache outlives `reset`, and the store does not.** Reset means "this question's corpus is
 *    gone", not "forget how to embed". A fresh cache per question would multiply the embedding bill by the
 *    number of questions and would be a different system: the registered run reports `memoHits: 212,020`
 *    against `embedCalls: 10,325`, so cross-question reuse is part of the arm that was measured. The store is
 *    a factory because the corpus has to be emptied without the package depending on a particular backend —
 *    `cortex-storage` is not a dependency of `cortex-memory`, and a test double is a legitimate caller.
 *
 * ## What it refuses to claim
 *
 * `build` is `'embedding'`: the registered arm is `relevanceSignal: self-index` with `indexEmbedding:
 * injected`, so every question embeds its corpus. That is the honest cost line, and it is why this adapter
 * cannot be compared with a lexical one on tokens alone without also reading the index census.
 */

import type { EmbeddingCacheStore, EmbedFn, LLM, Storage } from '@agentix-e/cortex-core';
import { MemoryEmbeddingCacheStore } from '@agentix-e/cortex-core';

import { assembleMemory, type Installation } from './assemble.js';
import type { CorpusTurn } from './corpus.js';
import { ABSTAIN_TOKEN } from './parse.js';
import type {
  ProviderHit,
  ProviderIngestReport,
  ProviderSearchOptions,
  ProviderSession,
} from './provider.js';

/**
 * How the adapter is wired, and the four things only the caller can know.
 *
 * No defaults, because every one of them is a decision about what is being measured: the reader is the
 * model under test, the clock pins the recency arithmetic, the embedder is the cost line, and the storage
 * factory is the only thing that can empty the corpus on the next `reset`.
 */
export type CortexProductProviderOptions = {
  readonly llm: LLM;
  /** Epoch milliseconds for every time-stamped decision. A constant pins a run. */
  readonly now: number;
  /**
   * The embedder the index calls.
   *
   * Required, because the registered arm has one. An assembly without an embedder is `lexical-only`, a
   * different system that would still print under this row's name.
   */
  readonly embed: EmbedFn;
  /**
   * A fresh, empty store per `reset`.
   *
   * A factory rather than an instance: the corpus is per-question state and the only portable way to empty
   * it is to build a new one. A caller that reuses one store across resets would carry the previous
   * question's turns into the next and would be measuring retrieval over a growing corpus.
   */
  readonly storage: () => Storage;
  /** Kept across resets. See point 3 in the module comment. */
  readonly embeddingStore?: EmbeddingCacheStore;
  /**
   * This arm's own model spend, read when a comparison table asks.
   *
   * Optional, and its absence means **not measured** rather than zero: the product package owns no provider
   * and therefore no counter, so the only honest source is the caller's — the metering proxy the chat calls go
   * through, which reports what the provider charged rather than what a request count implies.
   *
   * A function rather than a value because the number moves while the run is in progress: the harness reads
   * `usage` after the last question, and a snapshot taken at construction would report the corpus build and
   * nothing else.
   */
  readonly usage?: () => {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
  /** Row label in a comparison table. Defaults to `cortex-product`. */
  readonly label?: string;
};

/**
 * The product, assembled the way `docs/USER-MANUAL.md` tells a user to assemble it.
 *
 * Structurally identical to `cortex-eval`'s `MemoryProvider` and deliberately not imported from it — the same
 * dependency rule `provider.ts` states, and the reason both adapters live here: a measurement package must be
 * able to depend on the product, never the other way round.
 */
export class CortexProductProvider {
  readonly name: string;

  /**
   * `embedding`, not `llm`.
   *
   * The registered arm calls no model to build its memory: it embeds, and the answer is written by the
   * reader afterwards. Declaring `llm` would report a write-side model bill this arm does not have, and the
   * whole "copy the extraction or do not" argument rests on that column being true.
   */
  readonly build = 'embedding' as const;

  readonly #options: CortexProductProviderOptions;
  readonly #embeddingStore: EmbeddingCacheStore;
  #installation: Installation;

  constructor(options: CortexProductProviderOptions) {
    this.name = options.label ?? 'cortex-product';
    this.#options = options;
    this.#embeddingStore = options.embeddingStore ?? new MemoryEmbeddingCacheStore();
    this.#installation = this.#assemble();
  }

  /**
   * Store a question's sessions, and report what the store **holds** rather than what it was offered.
   *
   * The distinction is the one `CortexSessionProvider.ingest` documents at length: a corpus that replayed a
   * session reports the same held count as one that received it once, and a caller reading the offered count
   * would see a corpus grow on every replay. `held` comes from the corpus for the same reason — the append
   * report says what this call did, not what the question can be answered from.
   */
  async ingest(sessions: readonly ProviderSession[]): Promise<ProviderIngestReport> {
    const turns: CorpusTurn[] = [];
    for (const session of sessions) {
      session.turns.forEach((turn, ordinal) => {
        // `at` is the benchmark's timestamp, not the wall clock: the product's recency arithmetic reads it,
        // and the difference between "when the conversation happened" and "when this run replayed it" is a
        // whole finding this repository has already recorded once.
        turns.push({ sessionId: session.id, ordinal, text: turn.content, at: session.at });
      });
    }
    const report = await this.#installation.memory.remember(turns);
    const held = await this.#installation.corpus.sessions();
    return {
      sessions: held.length,
      turns: held.reduce((total, session) => total + session.length, 0),
      // Every session is stored whole. A session with no turns contributes nothing to the manifest above,
      // and the corpus refuses rather than silently dropping it, so there is nothing to report here.
      skipped: [],
      // What this call added, and what it found already there. The corpus answers a repeated position with an
      // error rather than an upsert, so a session whose id arrived with different content is a failed run and
      // not a replacement — which is why this counter is reported as the append's own.
      duplicates: report.duplicates,
      replaced: 0,
    };
  }

  /**
   * Nothing, and this is a statement rather than a stub.
   *
   * The product answers in one act (`answer` below); it has no retrieval endpoint a foreign reader could
   * consume. Returning the assembled evidence here would mean running the product's selection without its
   * rendering and calling the model twice — see point 1 in the module comment. `answerer: self` in the
   * artifact is the row that records this choice, and it is what keeps this arm comparable to Mastra's and
   * MemCog's rather than to a `shared` reader.
   */
  async search(_query: string, _options: ProviderSearchOptions): Promise<readonly ProviderHit[]> {
    return [];
  }

  /**
   * The product's own answer, through the route the benchmark would have chosen for this question.
   *
   * ## Why the route is not always `askStored`
   *
   * `askStored` delegates to `answerSessions` — the multi-session route — and that is right for a stored corpus
   * asked a generic question. It is not right for a *benchmark*: the registered arm's readings are taken through
   * `benchmark.ts`'s dispatch, which sends `MR` to `answerSessions`, `TR` to `answerTemporal`, `ABS` to
   * `answerAbstention`, `single-session-assistant` to `answerAssistant`, `knowledge-update` to
   * `answerKnowledgeUpdate` and everything else down the flat path. Each route has its own contract, its own room
   * and its own reach.
   *
   * Run `45090697310` is what happens without this: an arm that answered all thirty questions through
   * `answerSessions` read **10,780 prompt tokens per question** against the registered 7,448 (the multi-session
   * room is 48,460 characters, the widest of the six, and every question spent it) and scored **3 of 6 on `ABS`**,
   * because the abstention contract is not the multi-session one. Two thirds of the row was a different system
   * wearing the registered arm's name.
   *
   * ## Why the table is here and not imported
   *
   * `benchmark.ts` lives in `cortex-eval`, which depends on this package and not the other way round, so the
   * dispatch cannot be shared by import. It is therefore restated — in the same order, because the order is
   * load-bearing: an `ABS` question can carry `single-session-assistant`, and the abstention branch has to win.
   * `product-provider-route.test.ts` asserts the six rows through `lastRoute()`, so a divergence from the
   * benchmark's table is a red test rather than a quiet difference in a published row.
   */
  async answer(question: string, options: ProviderSearchOptions = { limit: 10 }): Promise<string> {
    const memory = this.#installation.memory;
    const sessions = await this.#installation.corpus.sessions();
    const context = sessions.flat();
    const capability = options.capability;
    const questionType = options.questionType;

    if (capability === 'MR')
      return (await memory.answerSessions(question, sessions)) ?? ABSTAIN_TOKEN;
    if (capability === 'TR') {
      return (
        (await memory.answerTemporal(question, context, options.askedAt, sessions)) ?? ABSTAIN_TOKEN
      );
    }
    if (capability === 'ABS')
      return (await memory.answerAbstention(question, context, sessions)) ?? ABSTAIN_TOKEN;
    if (questionType === 'single-session-assistant') {
      return (await memory.answerAssistant(question, context, sessions)) ?? ABSTAIN_TOKEN;
    }
    if (questionType === 'knowledge-update') {
      return (await memory.answerKnowledgeUpdate(question, context, sessions)) ?? ABSTAIN_TOKEN;
    }
    // The flat path, which is also where a `single-session-preference` question lands: `CortexMemory` has no
    // `answerPreference` (the header states why), and inventing one here would be a route the product does not
    // ship.
    return (await memory.answer(question, context, sessions)) ?? ABSTAIN_TOKEN;
  }

  /**
   * This arm's own spend, when the caller gave it a counter.
   *
   * A getter rather than a field, because a field would be the number at construction — which is the corpus
   * build and none of the answers. `undefined` is the report's "not measured", which is not zero: a row whose
   * cost is unknown and a row that cost nothing are different statements and the artifact keeps them apart.
   */
  get usage():
    | { readonly calls: number; readonly promptTokens: number; readonly completionTokens: number }
    | undefined {
    return this.#options.usage?.();
  }

  /**
   * Which route the most recent answer took, forwarded so a caller can check the dispatch rather than the score.
   *
   * The benchmark's row and this row are the same arm only if they chose the same route for the same question, and
   * a score cannot say that: two routes can produce the same percentage while one of them spends twice the room.
   * Null before any answer.
   */
  lastRoute(): string | null {
    return this.#installation.memory.lastRoute();
  }

  /**
   * The prompt the most recent answer rendered, forwarded so a caller can compare **bytes**.
   *
   * A competitor table reports an accuracy and a token count, and neither can say whether the arm that
   * produced them is the arm the product ships. This can: two assemblies of the registered arm render the
   * same prompt for the same question, and `product-provider.test.ts` asserts exactly that against a direct
   * `assembleMemory` call. Null before any answer, which is an absence rather than an empty prompt.
   */
  lastPromptText(): string | null {
    return this.#installation.memory.lastPromptText();
  }

  /**
   * Forget this question's corpus, keep the embedder's cache.
   *
   * The embedding store is passed to every assembly rather than rebuilt with it: see point 3 in the module
   * comment. Nothing else survives — the corpus, the index and the per-question accessors all belong to the
   * question that just finished.
   */
  async reset(): Promise<void> {
    this.#installation = this.#assemble();
  }

  /**
   * The installation, built from the published entry point and nothing else.
   *
   * Extracted so `reset` cannot assemble a different arm than the constructor did. Two literals would be two
   * chances for one of them to grow a field, which is this package's most repeated defect.
   */
  #assemble(): Installation {
    return assembleMemory({
      llm: this.#options.llm,
      now: this.#options.now,
      storage: this.#options.storage(),
      embed: this.#options.embed,
      embeddingStore: this.#embeddingStore,
    });
  }
}

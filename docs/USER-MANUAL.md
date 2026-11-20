# Cortex User Manual

This is the manual for people who build on Cortex: how to install it, how to plug in a model you
already pay for, how to choose a store, what every option does, and what the library refuses to do.

Every TypeScript block in this page is compiled by `pnpm manual:check` against the built type
declarations, and the two option tables are compared against the option types themselves. A block
that stops compiling, or an option that is renamed in code but not here, fails the build. That is the
whole reason the page can be trusted: it is not a description of the API, it is an executable
specimen of it.

If you want the reasoning behind a design, that lives elsewhere: [`ARCHITECTURE.md`](../ARCHITECTURE.md)
for the layer map, and the design records under [`docs/`](README.md).

---

## 1. What you are installing

Cortex is a memory layer, not a vector database. It decides **which turns are worth keeping**, **which
of the kept turns are worth answering from**, **when to decline**, and **which prompt shape each kind
of question gets** — and it delegates the storage and the model call to anything that implements two
small interfaces.

| Package | What it gives you | Runtime dependencies |
| --- | --- | --- |
| `@agentix-e/cortex-core` | The contracts (`LLM`, `EmbeddingModel`, `Storage`) and the pure algorithms behind the value gates, consolidation and contradiction resolution. Zero I/O. | none |
| `@agentix-e/cortex-storage` | Storage backends, one subpath each: `./sqlite`, `./pg`, `./opfs`, `./opfs/worker`, `./idb`. **The package root exports nothing** — §6.2. | optional peers |
| `@agentix-e/cortex-ai` | Model adapters: OpenAI-compatible HTTP (`.`) , local transformers.js (`./local`), the browser's built-in model (`./web`). | `fetch` for `.` |
| `@agentix-e/cortex-memory` | `CortexMemory` — the composition that turns a model plus the value gates into something that answers questions. | none |
| `@agentix-e/cortex-eval` | The measurement harness: dataset types, the memory-system contract, scoring, statistics. | none |

Code and comments are English throughout. The packages are ESM-only and target Node 22 or any
browser with `fetch`.

## 2. Install

```bash
pnpm add @agentix-e/cortex-core @agentix-e/cortex-memory @agentix-e/cortex-ai
# a store — install exactly one peer, the one you import
pnpm add @agentix-e/cortex-storage better-sqlite3      # Node, embedded
pnpm add @agentix-e/cortex-storage pg                  # Node, shared PostgreSQL
```

`better-sqlite3` and `pg` are **optional peer dependencies**: they are not installed for you, and
nothing in the package root reaches them. A build only links the backend it imports.

## 3. The smallest thing that works

The contract is deliberately tiny. If you already have a memory implementation, you do not need
`cortex-memory` at all — this is the entire surface the harness calls:

```ts
import type { MemorySystem } from '@agentix-e/cortex-eval';

const echo: MemorySystem = {
  name: 'echo',
  answer: (question, context) => (context.length === 0 ? null : question.slice(0, 40)),
};
```

`answer` may return a string (the answer), `null` (a decline), or a promise of either. Everything
else is optional: a system that declares `answerSessions`, `answerTemporal`, `answerAbstention`,
`answerAssistant`, `answerPreference` or `answerKnowledgeUpdate` is routed those question shapes
instead of the flat path, and a system that declares none receives every question through `answer`.

## 4. Plugging in a model

`LLM` is two methods. If your provider has a TypeScript SDK you like, wrap it and stop here — Cortex
will never ask for more:

```ts
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

class ScriptedLLM implements LLM {
  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    return `answer for ${prompt.length} chars at temperature ${opts?.temperature ?? 0}`;
  }

  async completeStructured<T>(prompt: string, schema: JsonSchema): Promise<T> {
    throw new Error(`no structured output in this example (${prompt.length}, ${schema.type})`);
  }
}
```

Two rules the library relies on and cannot check for you:

- `complete` must return the model's **raw text**, not a parsed answer. Cortex decides what an
  abstention looks like (`INSUFFICIENT_EVIDENCE`, §10), and a wrapper that strips or normalises it
  changes the measurement without changing the configuration.
- `completeStructured` should throw rather than return a guessed object. A silently coerced answer
  is indistinguishable from a model that produced one, which is the failure mode the harness spends
  most of its statistics on.

### 4.1 An HTTP provider you already have

`OpenAICompatibleLLM` speaks the `/chat/completions` dialect that DeepSeek, Zhipu, Moonshot, Groq,
OpenRouter, vLLM, Ollama and most gateways expose. No SDK, no key in the package:

```ts
import { OpenAICompatibleLLM } from '@agentix-e/cortex-ai';

const llm = new OpenAICompatibleLLM({
  baseUrl: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  model: 'deepseek-chat',
  maxRetries: 4,
  retryBudgetMs: 180_000,
  timeoutMs: 60_000,
});
```

| option | type | default | effect |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — (required) | Origin of the OpenAI-compatible API. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer`. **Never store it in a repository.** |
| `model` | `string` | — (required) | Model id, passed through unchanged. |
| `fetchFn` | `typeof fetch` | `globalThis.fetch` | Injectable transport, for tests and for runtimes without a global. |
| `maxRetries` | `number` | `8` | Attempts after the first, for `429` and `5xx` only. |
| `retryBaseDelayMs` | `number` | adapter default | Initial backoff; doubles per attempt. |
| `retryBudgetMs` | `number` | `120_000` | Wall-clock ceiling for the whole ladder, measured from the first attempt. |
| `timeoutMs` | `number` | `60_000` | Per-attempt deadline. Must be **below** `retryBudgetMs` or the ladder is unreachable. |
| `minIntervalMs` | `number` | absent (off) | Minimum gap between request starts, shared process-wide. `0` also means off. |
| `thinking` | `'off' \| 'low' \| 'medium' \| 'high'` | provider default | Reasoning budget, for providers that expose one. |

`retryBudgetMs` and `timeoutMs` are the pair people get wrong. The budget is measured from the first
attempt, so a per-attempt deadline longer than the budget makes every retry unreachable — the run
fails on the first `429` after waiting out one deadline. Thinking mode needs a 300 s deadline, and
therefore a budget above 300 s.

Environment-driven configuration is a first-class path, with the variables documented as constants:

```ts
import { describeProfile, readApiKey, resolveLlmProfile } from '@agentix-e/cortex-ai';

const profile = resolveLlmProfile({ backend: 'remote' }, process.env);
const key = readApiKey(process.env);
console.log(describeProfile(profile)); // remote deepseek-chat base=https://api.deepseek.com ...
void key; // passed to a client, never into the profile
```

| variable | meaning |
| --- | --- |
| `CORTEX_LLM_BACKEND` | `remote` or `local`. |
| `CORTEX_LLM_MODEL` | Remote model id. There is deliberately no default. |
| `CORTEX_LLM_BASE_URL` | Must be `https`, or `http` on loopback for a local sidecar. |
| `CORTEX_LLM_API_KEY` | The secret. Read separately from the profile, so it never lands in a record. |
| `CORTEX_LOCAL_MODEL` | Local checkpoint id, when the caller does not pass one. |
| `CORTEX_HF_ENDPOINT` | Where transformers.js fetches weights on a cold start. |
| `CORTEX_LOCAL_DTYPE` | Quantisation of the local weights (`fp32` unless named). |

`resolveLlmProfile` reports **every** missing variable in one message and a `ProfileError` carries
them as `.missing`. A plain `http://` base URL outside loopback is refused rather than downgraded:
an API key over cleartext is the one mistake worth failing a startup for.

Three entry points, three dependency profiles — importing the wrong one is what puts 90 MB of ONNX
weights in a server image:

| entry | needs | typical caller |
| --- | --- | --- |
| `@agentix-e/cortex-ai` | `fetch` | server, edge function |
| `@agentix-e/cortex-ai/local` | `@huggingface/transformers` (optional peer) | offline Node, browser with weights |
| `@agentix-e/cortex-ai/web` | `globalThis.LanguageModel` | browser with a built-in model |

### 4.2 Embeddings and reranking

```ts
import { OpenAIEmbedding, OpenAICompatibleReranker } from '@agentix-e/cortex-ai';

const embedding = new OpenAIEmbedding({
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY ?? '',
  model: 'embedding-3',
  dimensions: 512,
});

const reranker = new OpenAICompatibleReranker({
  baseUrl: 'https://api.example.com/v1',
  apiKey: process.env.RERANK_API_KEY ?? '',
  model: 'rerank-1',
});
```

`dimensions` is required rather than inferred, because variable-dimension models (Zhipu
`embedding-3` among them) answer `400` when it is omitted, and because the store has to be created
with the same width. Changing the width later means re-embedding everything — an index built at 1536
does not accept 512.

#### Switching embedding models without silently poisoning the store

Width is the *only* difference a vector index can see for itself. Two models with the same width
produce vectors that compare as numbers and mean nothing, so a store that mixes them returns a ranking
that looks like an answer. `EmbeddingSpace` binds the model to the index and refuses the combinations
that would mix:

```ts
import { BruteForceVectorIndex, EmbeddingSpace, type EmbeddingIdentity } from '@agentix-e/cortex-core';
import { OpenAIEmbedding } from '@agentix-e/cortex-ai';

const embedding = new OpenAIEmbedding({
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY ?? '',
  model: 'embedding-3',
  dimensions: 512,
});

// What a previous process persisted beside its index; `null` for a store being built now.
declare const loaded: EmbeddingIdentity | null;

const index = new BruteForceVectorIndex();
const space = await EmbeddingSpace.open(
  loaded === null ? { model: embedding, index } : { model: embedding, index, stored: loaded },
);

await space.add('turn-1', 'I moved to Berlin in March.');
const hits = await space.search('Where do I live?', 5);

// Persist this next to the index. It is `null` only when the index is empty and the model does not
// name itself, and it is what a later process passes back in as `stored`.
const provenance = space.identity;
```

Four things are refused, by name and with the fields that differ:

| you pass | it refuses because |
| --- | --- |
| a non-empty index and no `stored` | the space of those vectors is unknown, and assuming it is the current model is the substitution itself |
| `stored` and a model that does not report `identity()` | a statement nothing can check |
| `stored` from a different model, endpoint, provider or width | every field is compared, and all the differing ones are named |
| a model whose `identity().dimensions` disagrees with `dimension()` | every later width check trusts the identity |

Two backends ship in this repository and both name themselves: `OpenAIEmbedding` reports
`openai-compatible` with the endpoint it was configured with, and the offline `HashEmbedding` reports
`hash` with no model and no endpoint — naming a vendor the process never contacted would make a
credential-less run read as a remote one. A model of your own opts in by implementing `identity()`;
without it you can still build an index, but a store that a later process reopens must name its space,
and that is a statement only a model with an identity can satisfy.

#### Not paying twice for the same text

`CachingEmbedding` wraps any model and embeds each text once. It is a decorator rather than an option
because an option is something a constructor can forget: wrap the model you already have and every call
site inherits it.

```ts
import { CachingEmbedding, MemoryEmbeddingCacheStore, OpenAIEmbedding } from '@agentix-e/cortex-ai';

const cache = new MemoryEmbeddingCacheStore();
const embedding = new CachingEmbedding(
  new OpenAIEmbedding({
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: process.env.ZHIPU_API_KEY ?? '',
    model: 'embedding-3',
    dimensions: 512,
  }),
  { store: cache },
);
// ... ingest, index, query as before ...
console.log(embedding.stats());
// { textsAsked: 1942, storeHits: 1310, batchRepeats: 88, embedderCalls: 544,
//   saved: 1398, reuseRate: 0.7198, stored: 544 }
```

Three facts make this safe to put in front of a measurement:

- **A hit is the vector that was produced.** The cache stores what the endpoint returned and hands back a
  copy, so a caller cannot mutate it into something the endpoint never said.
- **`identity()` is forwarded verbatim.** A cache does not move the vector space, and a wrapper that
  reported a different identity would make your store refuse an index it had written itself.
- **Order is preserved.** The result has the input's length and the input's order, including when a batch
  is partly warm.

The counters partition the request, because the three parts mean different things: a **store hit** is text
you paid for in an earlier call, a **batch repeat** is the same text twice inside one call, and an
**embedder call** is text that cost money. The first two numbers are the saving; the third is the bill.
`reuseRate` is `null` before anything has been asked, which is a different fact from a rate of zero.

`EmbeddingCacheStore` is the extension point — four methods, `get` / `set` / `delete` / `size`. The default
lives as long as the process; a deployment that wants reuse across restarts implements the four over
whatever it already runs, and this package never learns where the vectors went. `delete` is not bookkeeping:
it is the erasure path (§6.5), and a store without it is a copy of the text with no way to withdraw it.

The key is `identity + "\0" + sha256(text)`, so two gateways serving the same model id do not share vectors —
the same model name behind two endpoints can be two sets of weights — and the store holds no wording, only a
digest it cannot read back. `EmbeddingMemo.forget(texts)` erases through the same key function that wrote, so
an erasure never has to reconstruct how a text became a key.

#### The product pays once without you wrapping anything

`CortexMemory` applies the same memo to its own retrieval stack. Pass `index.embed` and the class creates
one store for its lifetime; every question after the first embeds its query and any turn the corpus gained:

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import { OpenAIEmbedding } from '@agentix-e/cortex-ai';
import type { LLM } from '@agentix-e/cortex-core';

const llm: LLM = {
  complete: async () => '42',
  completeStructured: async <T>(): Promise<T> => {
    throw new Error('unused by this package');
  },
};
const corpus = ['the bicycle was repaired on tuesday', 'a parcel arrived for the neighbour'];
const embedding = new OpenAIEmbedding({
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY ?? '',
  model: 'embedding-3',
  dimensions: 512,
});

const memory = new CortexMemory({
  llm,
  now: Date.UTC(2026, 0, 1),
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  index: { embed: embedding.embed },
});

await memory.answer('when was the bicycle repaired?', corpus); // corpus + question
console.log(memory.lastIndexCensus()?.embedTexts); // 3
await memory.answer('did the parcel arrive?', corpus); // the question only
console.log(memory.lastIndexCensus()?.embedTexts); // 1
console.log(memory.lastIndexCensus()?.memoHits); // 2
```

Three things about that option are decisions rather than defaults:

- **`reuse` is `true` and turning it off is the exceptional case.** A memo is only sound in front of a
  *deterministic* embedder: a model whose vector for one text drifts between calls would make two
  questions share a vector neither produced. Setting `reuse: false` is a claim about your embedder, and
  `SearchCensus.reuse` records which claim the run was produced under, so two runs that disagree there
  are not comparable and a reader can see it.
- **`embedTexts` is a text count, `embedCalls` is a batch count.** They are printed side by side because
  a batch count alone cannot price work: an index over five hundred turns makes two calls whether it
  embedded five hundred texts or two. `memoHits` is the difference, and reading `embedCalls: 2` as "this
  question was expensive" was a real mistake in an earlier round of this repository's own documents.
- **The store is per instance, never shared.** A bare batch function states no vector space, so one store
  spanning two of them would hand one model's vectors to the other and the only symptom would be a
  retrieval difference between two runs. If you want the memo across instances, wrap your model in
  `CachingEmbedding` yourself — that surface *does* carry an identity, and that is the difference.

Where the two live is worth knowing when you read the source: the algorithm is `EmbeddingMemo` in
`@agentix-e/cortex-core`, `CachingEmbedding` is its `EmbeddingModel`-shaped adapter, and `cortex-ai`
re-exports both. The memo takes a bare batched function, which is what `index.embed` is; the decorator
takes a model, which is what you have when you want `dimension()` and `identity()` to travel with it.

### 4.3 What a call cost

```ts
import { createUsageTally, llmUsage, observeUsage, usageDelta } from '@agentix-e/cortex-ai';

const before = llmUsage();
const tally = createUsageTally();
const restore = observeUsage((usage) => tally.record(usage));

// ... the calls you want attributed to this side ...

restore();
console.log(tally.snapshot()); // what this side spent
console.log(usageDelta(before, llmUsage())); // what the whole process spent
```

The adapters record usage themselves. `observeUsage` is the hook that says *which* calls belong to
the current measurement — needed because a concurrent pool makes the naive "snapshot before, snapshot
after, subtract" reading overcount by a measured 3.43×.

## 5. Choosing a store

```ts
import type { Storage } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

const storage: Storage = new SqliteStorage({ filename: './cortex.db' });
await storage.put('turns', 'session-1/turn-3', { text: 'I moved to Berlin' }, { tags: ['place'] });
const rows = await storage.query<{ text: string }>('turns', { tags: ['place'], limit: 10 });
await storage.close();
```

| backend | import | notes |
| --- | --- | --- |
| SQLite | `@agentix-e/cortex-storage/sqlite` | `{ filename }`, default `:memory:`. WAL is set on the file at construction. |
| PostgreSQL | `@agentix-e/cortex-storage/pg` | `{ pool }` where `pool` is a `pg.Pool`. JSONB values, GIN-indexed tags. |
| OPFS | `@agentix-e/cortex-storage/opfs` | `openOpfsStorage({ sqliteModuleUrl })` — SQLite compiled to wasm, file in the origin-private filesystem, statements on a worker. |
| IndexedDB | `@agentix-e/cortex-storage/idb` | `openIdbStorage({ databaseName })` — the fallback tier when OPFS cannot open. |

All four implement `Storage`: `put`, `get`, `del`, `query`, `transaction`, `close`. If you have none
of them, an in-memory object with those six methods is a valid backend, and the packages will use it.

### 5.1 The empty root rule

`import { SqliteStorage } from '@agentix-e/cortex-storage'` does not exist, on purpose. A package root
that re-exported both backends would link `better-sqlite3` into every consumer, including browser
builds; the failure would surface in *your* bundler as an unresolvable module rather than here as a
design mistake. Subpaths are the surface, and `tools/entry-guard.mjs` fails the build if a native
module ever becomes reachable from the root.

### 5.2 Browser storage, and the one deployment that needs a build step

```ts
import { openBrowserStorage } from '@agentix-e/cortex-storage/opfs';

const storage = await openBrowserStorage({
  sqliteModuleUrl: new URL('sqlite-wasm/dist/index.mjs', import.meta.url).href,
});
```

`openBrowserStorage` tries OPFS and falls back to IndexedDB, reporting every tier it refused in a
`BrowserStorageUnavailable` rather than guessing. Two deployments are supported and only one is
unbundled:

- **Unbundled**: serve the package as published. The worker resolves next to the module.
- **Bundled**: add `@agentix-e/cortex-storage/opfs/worker` as a second entry point of your build and
  pass its emitted URL as `workerUrl`. esbuild has no `new URL(..., import.meta.url)` worker rewrite,
  so the worker is otherwise requested at a path your bundle never wrote and 404s. Vite and webpack 5
  emit it themselves.

### 5.3 What the store is now: the corpus the memory keeps

Until this release the two chapters above read as if the memory might touch a `Storage`, and it never
did: `answer(question, context[], sessions?)` took the corpus as an **argument on every call**, so a
harness could hand the baseline and the candidate the same evidence and the product kept nothing. That
is the right shape for a system being measured and an impossible one for a deployment, and it made
three capabilities unreachable rather than merely unused — the disclosure boundary had a store and no
reader, the memory had a reader and no store, and the two had no composition.

`Corpus` is the answer, and it is deliberately small: it turns stored rows into the two arguments the
memory already accepts, and it does not enter prompt assembly. That constraint is what makes the
equivalence checkable — because the stored path only produces arguments, "it answers the same way" is
byte equality of two prompts rather than a claim about similarity.

```ts
import { Corpus } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

const corpus = new Corpus({ store: new SqliteStorage({ filename: './corpus.db' }), now: Date.UTC(2026, 0, 1) });

// A transcript arrives one conversation at a time. `{appended, duplicates}` is the report, not `void`:
// a restart replays, and a caller that cannot tell a replay from an insert cannot tell whether its
// transcript doubled.
const report = await corpus.append([
  { sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' },
  { sessionId: 's1', ordinal: 1, text: 'My landlord is called Anke.' },
]);
// { appended: 2, duplicates: 0 }

await corpus.context();   // string[]      -- what answer(question, context) takes
await corpus.sessions();  // string[][]    -- what answerSessions(question, sessions) takes
```

| what you might expect | what is true |
| --- | --- |
| a new `Storage` option on `CortexMemory` | no. A corpus is a data model with an order, an identity and a dedupe rule; a store is a key/value port. `Corpus` takes **any** `Storage` — SQLite or PostgreSQL in Node, OPFS or IndexedDB in a browser — and the order stays in one place |
| the memory remembers what you `say` to the disclosure session | not automatically. `remember`/`askStored` are the memory's transcript; `DisclosureSession` is the boundary for what a person said *and may withdraw*. `assembleMemory` wires both, which is why it exists |
| turns survive a restart | they do now, if you gave the memory a corpus. That is the difference this release buys |
| the index is built once per corpus | the **index** is still built once per **question**; the **vectors** are not. With `index.embed` set, the second question over an unchanged corpus embeds one text and `SearchCensus.memoHits` reports the turns it did not pay for. Postings, fusion and the reranker still run per question, and that cost is CPU rather than model calls |
| `CachingEmbedding` is how you get reuse | you get it without wrapping anything: pass `index.embed` and the product memoises into the store you gave it. `CachingEmbedding` is for the case where the model is yours and you want the memo *outside* one `CortexMemory` — across instances, or in front of an ingest path that is not this class |

**A replay is a duplicate; a rewrite is an error.** The identity of a turn is `(sessionId, ordinal)`.
Appending the same ordinal with the same text is what a restart does, and it reports `duplicates`.
Appending it with *different* text is refused, because every number in `docs/MEASURE-*` was taken from a
corpus and a corpus that can be edited in place makes those numbers unreproducible in a way no artifact
records.

Five things to know before you turn `index.embed` on in earnest:

1. **`askStored` reads the whole transcript per question.** That is O(corpus), and it is not a new
   ceiling: `answerSessions` already admits every turn it is given. Measured at 10⁵ turns the read is
   **0.13×** the assembly it feeds (`tools/corpus-read-census.mjs`, `evidence/corpus/read-cost.json`).
2. **Reuse one `CortexMemory` instance.** Not for the corpus — for the vector store, which lives as long
   as the instance does. A new instance per question re-embeds everything, and the census will say so
   (`memoHits: 0`, `embedTexts` equal to the corpus size).
3. **Read `embedTexts`, not `embedCalls`, when you want to know what a question cost.** `embedCalls` is a
   batch count: an index over five hundred turns makes two calls whether it embedded five hundred texts
   or one. `embedTexts` is the number on the bill and `memoHits` is the number that explains it.
4. **Do not set `reuse: false` unless your embedder is non-deterministic.** The option exists for that
   case and for reproducing a pre-store run; it is not a safety switch, and the census records which
   claim a run was produced under.
5. **A lexical-only index costs no model calls — and 5.6 points.** `index` with no `embed` calls no
   embedding model at all: 2,000 indexes over 742,080 turns with `embedCalls: 0`, which is the
   configuration to reach for when there is no key, no budget, or no network. What it does not give you
   is the accuracy. Measured on the same 500 questions, four repetitions, same reader and judge, the
   lexical index scores **85.75%** against **91.40%** with a vector channel — paired, **−28 questions**,
   exact McNemar **p = 2.5e-5**. The loss is not spread evenly and that is what makes it a design
   decision rather than a caveat:

   | capability | questions | lexical | with vectors | delta |
   | --- | --- | --- | --- | --- |
   | integration of evidence (`IE`) | 150 | 81.33% | 92.00% | **−10.67** |
   | knowledge update (`KU`) | 72 | 81.94% | 93.06% | **−11.11** |
   | temporal reasoning (`TR`) | 127 | 89.76% | 94.49% | −4.72 |
   | multi-session reasoning (`MR`) | 121 | 84.30% | 82.64% | **+1.65** |
   | abstention (`ABS`) | 30 | 100.00% | 100.00% | 0.00 |

   The two populations that lose are the ones where the question's wording does not appear in the
   evidence — the vector channel buys **recall**, not reasoning. `MR`, which reasons over turns the
   window already holds, does not move. So: if your corpus is searched by wording you expect to recur,
   the lexical index is a real deployment; if it is a hundred thousand turns of someone's life and the
   question asks about it in different words, the embedder is what makes the memory worth having.
   (`S14` in `docs/ACCEPTANCE-MATRIX.md`; evidence in `cortex-docs/evidence/longmemeval/lexical-index.json`.)

## 6. The composition: `CortexMemory`

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

const llm: LLM = {
  complete: async (_prompt: string, _opts?: CompleteOptions) => 'INSUFFICIENT_EVIDENCE',
  completeStructured: async <T>(_prompt: string, _schema: JsonSchema): Promise<T> => {
    throw new Error('unused');
  },
};

const memory = new CortexMemory({
  llm,
  now: Date.UTC(2026, 0, 1),
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
});

const answer = await memory.answerSessions('How many cities did I live in?', [
  ['I moved to Berlin in 2024.', 'Then Lisbon in 2025.'],
]);
console.log(answer); // string, or null for a decline
```

Three fields are required and each is required for a reason:

- **`llm`** is injected, never constructed here: this package owns no key and makes no network call of
  its own, so a caller can supply a mock, a local model, or a router over several providers.
- **`now`** is injected because admission value depends on age. A default of `Date.now()` would make
  two runs of one fixture disagree.
- **`gate`** is explicit because a memory layer with an implicit threshold is a layer whose behaviour
  cannot be reproduced from its configuration.

### 6.1 `CortexMemoryOptions`

<!-- contract-table: CortexMemoryOptions -->
| option | type | default | effect |
| --- | --- | --- | --- |
| `llm` | `LLM` | — (required) | The reader. Used for every route that `readerByRoute` does not name. |
| `now` | `number` | — (required) | Epoch milliseconds for every time-stamped decision. |
| `gate` | `GateOptions` | — (required) | The admission and retrieval gates, §6.2. |
| `name` | `string` | `'cortex-memory'` | Label written into the report. |
| `readerByRoute` | `Partial<Record<TurnCapRoute, LLM>>` | absent | A different reader per route; absent routes fall back to `llm`. |
| `maxPromptChars` | `number` | `48000` | Upper bound on the assembled prompt, in UTF-16 code units. |
| `maxPromptCharsByRoute` | `Partial<Record<TurnCapRoute, number>>` | absent | The same bound per route; unnamed routes keep `maxPromptChars`. |
| `widthPlan` | `WidthPlanOptions` | absent | A per-**question** evidence budget: rank the candidates by relevance and fund the shortest prefix that explains `coverage` of the mass. `fitToBudget` spends the smaller of this and the room. |
| `maxTurnChars` | `number` | absent (no cap) | Upper bound on what one turn may contribute. |
| `turnCutMarker` | `'none' \| 'ellipsis'` | absent | Whether a turn the cap cut says so. Only forwarded on routes the cap reaches. |
| `turnWindow` | `'head' \| 'match'` | absent (`'head'`) | Which slice of a long turn the cap keeps. `'match'` spends the same characters on the window around the question's densest lexical match and marks every elision; needs `maxTurnChars` and is refused without it. |
| `resolution` | `'raw' \| 'layered'` | absent (`'raw'`) | Whether a capped turn prints whole or by one of three forms: a long turn sharing a term with the question keeps a window around its densest match (1.5× the cap), a long turn sharing none becomes one line of its opening plus its sentence-carrying sentences (0.6×), and everything short prints whole. The selector is unchanged, so a denser rendering reaches further down the same ranking. Needs `maxTurnChars`; refused with `turnWindow: 'match'`. §6.12. |
| `maxTurnCharsRoutes` | `readonly TurnCapRoute[]` | absent (all routes) | Which routes the per-turn cap reaches. `[]` reaches none. |
| `relevanceFor` | `(question, turn) => number` | absent | Ranks which turns the budget is spent on. Wins over `index` when both are given. |
| `index` | `SearchIndexOptions` | absent | The product's **own** retrieval: postings over the turns of this question, an optional vector channel through `embed`, rank fusion, and an optional `rerank`. Absent keeps the previous behaviour byte for byte. |
| `relevanceUnits` | `'turn' \| 'session' \| 'session-fill' \| 'anchor-window'` | `'turn'` | The unit the budget is spent in. |
| `windowRadius` | `number` | absent | Same-session turns bought on each side of an anchor, for `'anchor-window'`. |
| `promptContract` | `'abstention' \| 'abstention-evidence-blocks' \| 'evidence-blocks-instruction-first' \| 'evidence-blocks-unsourced'` | baseline rendering | The instruction block and evidence layout. |
| `ask` | `EvidenceAsk` | `'route'` | The instruction every route asks with; `'route'` keeps each route's own block. |
| `evidenceRoles` | `readonly string[]` | absent (no filter) | Which turn roles the evidence may be built from. Requires `roleOf`; must be non-empty. |
| `evidenceRolesRoutes` | `readonly TurnCapRoute[]` | absent (all routes) | Which routes the role filter reaches. |
| `roleOf` | `(turn) => string \| undefined` | absent | How to read a turn's role. Required when `evidenceRoles` is set. |
| `reviewPass` | `'none' \| 'audit' \| 'recover'` | `'none'` | A second consultation on the multi-session route: audit the first answer's list, or retry a bare decline. |
| `reviewBareDecline` | `boolean` | absent | Give a decline that named nothing one question back, without offering the abstention token. |
| `replyRepair` | `'off' \| 'commitment' \| 'shape' \| 'both'` | `'off'` | Re-ask once when the reply broke the contract it was given: a refusal in prose, or a list of quotations instead of an answer. Excludes `reviewPass`. |
| `selfConsistency` | `number` | absent (1) | Consultations per question and majority reduction. Must be a positive integer; refused with `reviewPass: 'audit'`. |
| `windowOrdering` | `{ dateOf, windowOf }` | absent | The reference pipeline's time-window reorder, as two injections. |
| `conflicts` | `boolean` | absent (off) | Prints the statements that state one detail twice, in evidence order, between the evidence and the question. Reaches flat, temporal, knowledge-update and assistant; abstention and multi-session are excluded. §6.4. |
| `supersededRendering` | `'off' \| 'mark' \| 'collapse'` | absent (off) | Marks the turn whose own words state a value the evidence later replaces, **inside** that turn's rendering. `'mark'` appends one bracketed clause; `'collapse'` keeps only the sentence at issue. Reaches multi-session and the four flat routes; abstention is excluded. §6.7. |
| `sessionClock` | `boolean` | absent (off) | Writes each session boundary's own date into the boundary line — `Session 3 (2023-05-21)`, or a range when the block spans days. Reaches multi-session, the only route that draws boundaries. Off by default: absent reproduces every archived prompt byte for byte. §6.11. |
| `corpus` | `Corpus` | absent | The transcript this instance holds. Present, `remember()` and `askStored()` work and the memory stops being a function of its arguments; absent, every route is byte-identical to before this option existed. §5.3. |
| `semanticCarry` | `boolean` | absent (off) | Whether a prompt may carry a value change the store has already authorised. When a `knowledge-update` answer is replaced by a later dated span, the pair becomes a typed fact with a `supersedes` edge, and a later question whose window still carries the record the change was read from is told which value is current. Off by default: absent reproduces every archived prompt byte for byte. §6.5. |
| `factTimeline` | `boolean` | absent (off) | Appends the interval each served fact held — `timeline: 30 dozen [2023/03/12 -> now]` — built from the two record instants the authorisation already returned. No model call. Renders only for facts the exit served, and only when `semanticCarry` is on. Off by default: absent reproduces every archived prompt byte for byte. §6.1.2. |
<!-- /contract-table -->

### 6.1.1 Turning on the semantic carry, and what it cannot do

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;

const memory = new CortexMemory({
  llm,
  now: Date.UTC(2026, 0, 1),
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  // Off by default. `true` lets a later question over the same corpus be told which of two
  // values is current, when this instance already had one of them replaced.
  semanticCarry: true,
  // A second switch beside the first: appends the interval each *served* fact held. It renders
  // nothing without `semanticCarry`, because an interval describes a fact the prompt lacks.
  factTimeline: true,
  reviewPass: 'supersede',
});

// The store absorbs an authorised substitution whether or not the switch is on, so these three
// counts distinguish "nothing was ever authorised" from "one was, and no window asked for it".
const { absorbed, dropped, matched } = memory.semanticCarryCensus();
console.log(absorbed, dropped, matched);

// And these two are the ledger's own reading: `withheld` is what the exit refused to serve. On a
// well-formed unit it equals `served`, and it going to zero while a line still renders is the
// signature of a revision that stopped writing.
const { served, withheld } = memory.semanticCarryCensus();
console.log(served, withheld);
```

A substitution is authorised only when the value the reader quotes appears in the evidence character for
character, the date it names sits on the same evidence record, and that record is later than the one the
previous answer rested on. The pair is stored as two facts on one slot — the question is the slot, `answer` is
the predicate — and the `supersedes` edge comes from the two dates rather than from a guess. The sentence is
never replaced: the facts are added beside the evidence, in their own block.

The block carries **one** fact, not two. Both facts carry a derived assumption ledger, the revision refutes the
one that was replaced, and the answer-side exit refuses a refuted fact — so a stale value never appears on a
`fact:` line of its own. It is still named, by the relation line: `status:   replaces "20 dozen"`. What is
withheld is not the knowledge that a value changed, it is the claim that the old value still answers.

The reach is bounded by the window, not by a configuration: an update reaches a prompt only when that prompt's
window still carries the record the change was read from. A workload whose every question brings a fresh corpus
— a benchmark, for instance — therefore never sees a line, which is the property that makes this switch safe to
run beside a measurement.

### 6.1.2 Turning on the timeline, and the one thing it will not do

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;

const memory = new CortexMemory({
  llm,
  now: Date.UTC(2026, 0, 1),
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  semanticCarry: true, // required: the timeline dates the facts this serves
  factTimeline: true, // one extra line per served fact, no model call
  reviewPass: 'supersede',
});

// The prompt then carries, under the fact block:
//
//   fact:     30 dozen  [state]
//   timeline: 30 dozen [2023/03/12 -> now]
//
// The left date is the instant of the record the value was quoted from — not the day it became true in
// the world, which no record in the corpus states. The right end is the instant of the record that
// replaced it, or `now` while it is the newest one known.
```

The line is arithmetic over two dates the authorisation already carried, so it costs no inference and cannot
disagree with the fact block: both are built from the same `assemble` call, in the same order.

It will not date a fact the ledger withheld. On a default question the superseded value is refused, so its
interval is refused with it — the value is still named by the relation line (`status: replaces "20 dozen"`),
which is the sentence a reader needs, and the range it held is not published on its own. The filter reads
`assemble`'s own served list rather than the rendered lines, so "the timeline cannot publish what the exit
refused" is a property of the call graph and not of the wording.

There is **no accuracy claim** beside this switch yet. The instrument's arm read +4.55% on 22 questions, which
is under the resolution floor for a population that size; the capability is reachable, tested, and off until a
registered run measures it. `docs/PRODUCT-CAPABILITY-LEDGER.md` row 19 counts reachability and says nothing
about effect.

### 6.2 `GateOptions`

<!-- contract-table: GateOptions -->
| option | type | default | effect |
| --- | --- | --- | --- |
| `threshold` | `number` | — (required) | Admit a turn when its value is at or above this. `0` admits everything; `1` admits nothing. |
| `retrievalThreshold` | `number` | — (required) | Answer when the best candidate's value is at or above this. `0` means "answer from anything admitted". |
| `sessionBudget` | `number` | — (required) | How many admitted turns may reach the prompt, counted across all sessions. |
| `sourceTrust` | `number` | `0.5` | Trust stamped on every admitted turn, in `[0, 1]`. Raises the reachable ceiling, not the shipped value. |
| `valueFunction` | `ValueFunction` | core default | Replaces the value estimate entirely. |
| `confidenceFor` | `(turn) => number` | absent (constant `1`) | Per-turn confidence for admission. The only factor with per-turn variation. |
<!-- /contract-table -->

`threshold` and `retrievalThreshold` are separate fields on purpose: *is this turn worth keeping* and
*is the kept evidence good enough to answer from* are different questions, and collapsing them turned
a run into a system that declined 95.4% of every benchmark. `sourceTrust` and `confidenceFor` exist
because the gate used to be a two-state switch: with a constant `0.5` the maximum observable value was
`0.5`, so no threshold above it could ever admit anything.

### 6.3 What the constructor refuses

These are configuration errors, not runtime ones, and they fail at `new CortexMemory(...)` — a run
that would have spent a benchmark measuring a configuration it did not administer cannot start:

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const base = { llm, now: 0, gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 8 } };

try {
  // A role filter with no classifier would keep every turn while the config said it kept some.
  new CortexMemory({ ...base, evidenceRoles: ['user'] });
} catch (error) {
  console.log((error as Error).message); // evidenceRoles was named without roleOf: ...
}

try {
  // Two second passes on one question is six consultations nobody has measured.
  new CortexMemory({ ...base, selfConsistency: 3, reviewPass: 'audit' });
} catch (error) {
  console.log((error as Error).message); // selfConsistency and reviewPass: audit cannot both be on: ...
}
```

### 6.4 The other half: `DisclosureSession`

`CortexMemory` answers questions and stores nothing. `DisclosureSession` stores sentences and answers
nothing. It is the package's only surface that touches a `Storage`, and it is the one that decides
**where a sentence may live** — because "a colleague can read this" and "this stays with you" are
different rows, and the difference has to be enforced by something that knows both.

```ts
import { DisclosureSession } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

const session = new DisclosureSession({
  private: new SqliteStorage({ filename: './private.db' }),
  shared: new SqliteStorage({ filename: './shared.db' }),
});

const { admission, card } = await session.say('My landlord is Ana Ruiz; she prefers email.');
console.log(admission.stored, card?.state); // true, 'proposed' | 'withheld' | ...

await session.accept(card!.id);                       // publish the sentence as-is
console.log(await session.export());                  // the markdown a person reads
```

Three properties the object exists to hold, in the order they matter:

- **Two stores, not two tables.** `FederatedStorage` treats the table prefix as a routing marker and
  strips it, so a single engine would put both halves in one `facts` table and the first shared query
  would return the private rows. The isolation on offer is "the data did not go there".
- **A proposal is content, not consent.** `propose()` asks a model to split the sentence into atoms and
  attaches the result; publishing is `accept()`, and accepting an atom goes through `edit()` so the
  rule table classifies it again at the moment of the click.
- **A failure is returned, not swallowed.** `propose()` hands back the failure union when no model
  could be reached, so a UI can render "here is your sentence" instead of an empty card.

A fourth property is an operation rather than a shape: **`forget()` erases the sentence and the id**,
and §6.5 is about what it has to reach before it may say so.

What it does **not** have, stated here rather than discovered later: no `close()` (call
`Storage.close()` yourself), no transaction across `release()`'s two writes, and no reader — it will
not answer a question from what it stored. The gaps and their criteria are in
[`docs/AUDIT-PRODUCT-SURFACE.md`](AUDIT-PRODUCT-SURFACE.md) §3 and §6.

### 6.5 Erasing a sentence, and the eight surfaces it has to reach

Deleting a fact is the easy half and the wrong half. Measured by AfterDeleteBench
([arXiv:2610.31366](https://arxiv.org/abs/2610.31366)): delete the record an agent was told about and
ask it anyway, and a single query recovers the secret in **68%** of cases — because a *derived* copy
survived. This store derives four: a card keeps the wording, the turn it was cut from and the turns
around it; a release record keeps the wording and its SHA-256; a **vector cache** keeps an embedding
addressed by the text; and the **transcript** keeps the sentence again under an identity — `(sessionId,
ordinal)` — that this boundary never sees. `forget()` reaches all of them, or it does not claim to have
erased anything.

The cache is the one that was missing, and it was missing in the way that matters: the store had no
`delete` at all, so an erasure emptied five tables and left a vector that answered
`get(keyOf(text)) !== undefined` for the erased sentence. Two changes close it, and they are different
kinds of defence:

- **The entries are erasable.** `EmbeddingCacheStore.delete(key)` is part of the interface now, so a
  store that cannot erase is a store that does not implement it — and `forget()` reports the number it
  removed in `record.removed.vectors`.
- **The keys hold no wording.** A key is `<fingerprint>\0sha256(text)`, so the store never held a copy
  of the sentence to begin with, even in the window before an erasure reaches it. That is a reversal of
  this repository's earlier judgement, and `packages/cortex-core/src/cache/sha256.ts` records why the
  trade flipped: the plaintext key was a copy in a table the disclosure boundary does not know about,
  and the digest's oracle problem only exists for entries that are still there.

The transcript is the eighth, and it is the one this release created for itself: a memory that stores
what it was told keeps a second copy of every sentence, and a `Corpus` built over the same deployment is
**not** automatically erasable — `forget()` reaches what it is handed. `Corpus` implements the same
contract the cache does (`TextEraser`), so the composition root passes the object it already
constructed:

Pass both in when you build the session, or nothing will tell them about the erasure:

```ts
import { EmbeddingMemo, ERASURE_TOKEN } from '@agentix-e/cortex-core';
import type { EmbedFn } from '@agentix-e/cortex-core';
import { Corpus, DisclosureSession } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

declare const embed: EmbedFn;

const session = new DisclosureSession({
  private: new SqliteStorage({ filename: './private.db' }),
  shared: new SqliteStorage({ filename: './shared.db' }),
  // The same object the retrieval path embeds through, or nothing tells the cache about the erasure:
  // `SearchIndex` implements this interface, so a product that has an index passes that index.
  vectors: new EmbeddingMemo((texts) => embed(texts), { fingerprint: 'zhipu/embedding-3/v1/2048' }),
  // And the transcript, if this deployment keeps one. Erasure is by wording rather than by row: the
  // boundary never learns which corpus turn a card was cut from, and the sentence is the same sentence.
  turns: new Corpus({ store: new SqliteStorage({ filename: './corpus.db' }) }),
});

await session.say('Falcon is the code name for the Helix Bio acquisition.', { id: 'f1' });
await session.accept('f1'); // it crossed into the shared store: two copies now, plus a card

const { record, card } = await session.forget('f1', {
  acknowledge: ERASURE_TOKEN, // 'erase-permanently'; a refusal prints what it would destroy
  reason: 'user-request',
});
console.log(record.removed); // { facts: 1, cards: 1, releases: 0, vectors: 0, turns: 1 }
console.log(card?.text); // '' -- the tombstone keeps the timeline and nothing else
console.log(await session.export()); // one card, state 'forgotten', no wording
```

Seven things are true afterwards, and each one is asserted in
`packages/cortex-memory/src/__tests__/disclosure-erasure.test.ts` and `assemble.test.ts` against real
files:

| | |
| --- | --- |
| Four read paths see nothing | the private evidence, the shared evidence, the export, the release log |
| The record holds no content | `reason` is one of three values, so the field cannot carry a sentence; there is no digest, because a hash of a guessable sentence is an oracle |
| The row says **which** erasure | the tombstone's `reason` is one of three fixed sentences chosen by the record's own `reason` — `user-request`, `correction` or `retention-policy` — so a correction no longer prints a sentence claiming the owner asked to be forgotten |
| The id is burned | a later `say(..., { id })` under that id throws; without an id the store mints one |
| It survives a restart | the record and the tombstone are rows, not state in memory |
| It is not undoable | `accept`, `edit`, `dismiss`, `refresh` and `attach` all refuse an erased card |
| The cache no longer answers for it | `record.removed.vectors` counts the entries removed, and the vectors of a sentence nobody erased are still there |
| The transcript no longer holds it | `record.removed.turns` counts the turns removed, and a sentence nobody erased is still there — `tools/erasure-census.mjs` reads the corpus as its eighth surface |

What the tombstone **cannot** say, and this is deliberate: what the card was about. Beyond the rule id
that claimed it (`rule`, and `null` for a sentence no rule recognised), every candidate field — the
topic, a summary, even the length of the sentence — is a reconstruction channel, which is exactly what
AfterDeleteBench's control product kept. So two erased cards claimed by the same rule read the same in
the export, and comparing two exports will not tell them apart. The erasure log beside the cards is
what distinguishes them: it carries one record per erased id, with the reason, the time, and what each
surface lost — and no wording.

What it does **not** reach, because the boundary is the store this process owns: a model that already
read the sentence in a prompt, a provider's request log, and any transcript pasted somewhere else.
AfterDeleteBench separates reconstruction from write-back and fresh-session recall for exactly this
reason. On disk, the SQLite backend sets `secure_delete = ON` — with it off, an erased 1.6 kB sentence
was still findable verbatim in the file after the row was gone, which is the difference between "the
store forgot it" and "the file no longer holds it".

### 6.6 `assembleMemory`: the three profiles

The class has thirty-five options, and until this release the only assembly known to work lived in
`bench/run-ablation.ts` — which the package does not ship (`files: ["dist"]`). An integrator got a class
and no worked example of which combination runs. `assembleMemory` is that example, in three sizes:

| profile | what it adds over the one before | what it is for | measured (LongMemEval-S, 500 × 4) |
| --- | --- | --- | --- |
| `minimal` | nothing: an identity gate and no index | the smallest conformant memory. Answers from the turns it is given, in the order it is given them | **39.55%** — the `relevanceSignal=none` arm |
| `reader` | the retrieval index — lexical, plus a vector channel when you supply an embedder | the ranking a knowledge-update or count-bearing question needs | **91.25%** with a vector channel at the registered room (7,448 prompt tokens per question); **89.40%** when every route's room is cut to 24,000 characters (`S15`); **85.75%** lexical-only (`S14`, paired −28 questions, p = 2.5e-5). Paired against the harness's own index at −1.5 questions (p = 1.0) |
| `full` | the disclosure boundary: cards, releases, and erasure over all eight surfaces | a deployment where a person says something and can later withdraw it | the same ranking; the boundary is not an accuracy mechanism |

`reader` is the default. It was `minimal` until the ranking was priced, and the two numbers in the last column
are one measurement of one difference: without a relevance signal the prompt keeps the head of the transcript
and drops the newest turn, which is the turn a knowledge-update question asks about. The gap is **51.85
points**, so "the cheapest configuration that conforms" was a true sentence with a price nobody had read out
loud. `minimal` still exists — a conformance check wants a memory that ranks nothing — but you have to name it.

The default is the strongest profile that needs **no** extra input. `full` is stronger and is not the default
because it needs a second store: a default that throws when you name nothing is not a default.

The vector channel is the one input the default cannot supply, and it now has a price rather than a
description: `reader` with `embed` scores **91.40%**, `reader` without it **85.75%** (`S14`). Both are real
deployments and the manual says which is which — a caller with no provider gets lexical ranking and no model
calls, and is told the 5.6 points before writing the integration rather than after.

**The room is part of the configuration, so every accuracy here carries its bill.** `maxPromptCharsByRoute`
is how many characters of evidence a route may spend, and it is the single largest term in what a question
costs. Three points have been measured or registered on the same 500 questions, same reader, same judge:

| room per route | accuracy | reader prompt tokens per question | taken from |
| --- | --- | --- | --- |
| `multi-session` 48,460, the other five 24,000 | **91.25%** | **7,448** | **the registered arm** (`S16`, paired −1 question against `S9`, exact McNemar p = 1.0) |
| `multi-session` 48,460, `temporal` 48,000, the other four 24,000 | 91.40% | 9,074 | `S9`, the table `S16` replaced |
| 24,000 on all six | 89.40% | 5,861 | `S15`, paired −13 questions, exact McNemar p = 0.0024 |
| `multi-session` 36,000, the other five 18,000 | 89.40% | **5,559** | `44482224999`, paired **−11 questions (p = 0.027)** against the registered arm |

The first row and the second are the same instrument reading the same 500 questions, and the difference
between them is **one entry of the room table**: `temporal` was holding 48,000 characters and delivered
47,852 of them to answer questions that 23,877 characters answer just as well. Two dispatches measured that
cut — `S15` lost 2 questions on it (p = 0.63) and `S16` lost 1 (p = 1.0) — and the second one also gave
`multi-session` its room back, which *gained* a question. So the cheaper table is the one the measurement
cannot tell apart from the dearer one, which is what the shipping default now is: **91.25% at 7,448 prompt
tokens per question, 19.1% less bill than the table it replaces.**

Two of the six rooms are cut in the bottom row and **one of them pays**: `multi-session` lost 9 of the 13
questions (p = 0.012) while `temporal` lost 2 (p = 0.63), and the four routes nobody touched lost 2 between
them across 252 questions. That is not noise with a story attached — it is what an aggregation question is.
`How many festivals did I attend?` is a **count over turns**, so halving the packet truncates the count: the
artifacts answer 3 against a gold of four. A temporal question needs its anchor and its neighbours and
Survives the cut, twice measured. If you are trading accuracy for money, cut `temporal` before you cut
`multi-session`, and read the per-route table in `docs/PROMPT-ROOM-IS-LOAD-BEARING.md` §7 before you cut
either.

**The last two rows are the same question asked twice, and they agree: the total is the lever, the shape is
not.** Moving 12,000 characters off four routes and onto `multi-session` changes the bill by 5.2% and the
score by 3 questions — inside the spread of a single run's four repetitions — so a per-route table is a way
to *spend* your budget where it pays, not a way to spend less. What the total charges is now measured on two
segments: the cut from 9,074 to 7,448 cost **1.15 points**, and the cut from 7,448 to 5,559 cost **1.85**.
The second segment is 1.5× dearer per token, so the cost of another thousand tokens saved rises as the room
shrinks — budget for roughly **one point per thousand tokens**, and more than that below 7,448. Every route
delivers its room to within 0.3% (`tools/readout-arm-run.py --audit` prints the fill on every run), which is
why there is no slack to recover from a room once it is set.

The middle row is kept on this page because it is the table every number published before this release was
taken under, and because it is 1,626 tokens per question of context that bought no question. It is not
reachable as a default any more; state it per route if you want to reproduce an older reading.

<!-- contract-table: AssembleOptions -->
| option | type | default | effect |
| --- | --- | --- | --- |
| `llm` | `LLM` | — (required) | The reader. Injected, because this package owns no provider and no credential. |
| `now` | `number` | — (required) | Epoch milliseconds for every time-stamped decision. |
| `storage` | `Storage` | — (required) | Where the transcript goes, and for `full` the private side of the boundary. Any backend: SQLite, PostgreSQL, OPFS, IndexedDB. |
| `profile` | `'minimal' \| 'reader' \| 'full'` | `'reader'` | How much of the product to wire up. See the table above for what each one scores. |
| `embed` | `EmbedFn` | absent | The vector channel, as a batch function over texts. Absent leaves lexical retrieval: the same index, the same ranking, **5.6 points** less accuracy (`S14`, paired −28 of 500 questions, p = 2.5e-5), concentrated in the two populations whose questions are worded differently from their evidence — see §3.5 item 5. Costs no model calls either way when absent. |
| `embeddingStore` | `EmbeddingCacheStore` | absent (a process-lifetime map) | Where the vectors live between assemblies. Supply `await StorageEmbeddingCache.open(storage)` to keep them across a restart, and flush it after the work. Refused on `minimal` and refused without `embed`, because neither would read or write it. |
| `maxPromptChars` | `number` | the registered table, per route | One room, in characters, for every route that names none of its own. Stating a number replaces the table on all six routes — you are choosing a shape, not filling a gap. No default here for one release, on the argument that a constant in this file would be a second arm; the argument was sound and its conclusion was inverted, because a call that declined to name the registered arm inherited the class's flat 48,000 instead, which is no cell the campaign priced. |
| `maxPromptCharsByRoute` | `Partial<Record<TurnCapRoute, number>>` | the registered table | Per-route rooms, merged **over** the table: `{ temporal: 8_000 }` moves one route and leaves the other five at their registered widths. A route named here wins over `maxPromptChars` too, because the more specific field is your answer. |
| `shared` | `Storage` | absent | The public side of the disclosure boundary. Required by `full`, ignored by the other two. |
| `name` | `string` | `'cortex-memory'` | Attribution label, carried through to the memory. |
| `gate` | `Partial<GateOptions>` | identity (`0` / `0` / unbounded) | Overrides for the admission and retrieval gates, §6.2. |
| `index` | `Omit<SearchIndexOptions, 'embed' \| 'store'>` | absent | Retrieval knobs other than the embedder and the store, which this function owns: `k`, `reuse`, the reranker. |
| `corpus` | `Corpus` | a new one over `storage` | An existing transcript, when you already have one — a second assembly over a live corpus. |
| `supersededRendering` | `'off' \| 'mark' \| 'collapse'` | absent (off) | What the rendering does to a turn whose value the evidence later replaces. On the assembly rather than per call, because it is a product decision about how a transcript is shown. §6.7. |
| `sessionClock` | `boolean` | absent (off) | Whether each session boundary carries the date its block states. On the assembly rather than per call, for the same reason `supersededRendering` is: it is a decision about how a transcript is shown, not about one question. §6.11. |
| `maxTurnChars` | `number` | absent (no cap) | Upper bound on what one turn may contribute, in UTF-16 code units. The cap is what makes a long narrative's tail stop competing with the turns that answer the question. Absent reproduces every archived prompt byte for byte. |
| `turnCutMarker` | `'none' \| 'ellipsis'` | absent | Whether a turn the width cut says so, with one character at the cut. Refused without `maxTurnChars`: a mark on a turn nothing cut is a claim about a prompt that never happened. |
| `turnWindow` | `'head' \| 'match'` | absent (`'head'`) | Which slice of a long turn the width keeps. `'match'` spends the same characters on the window around the question's densest lexical match and marks every elision. Needs `maxTurnChars`. Cannot be combined with `resolution: 'layered'`, which decides the same thing. |
| `resolution` | `'raw' \| 'layered'` | absent (`'raw'`) | Whether a capped turn prints whole or by form. The only path measured to a smaller bill that does not remove evidence, because the instruction block is 0.76% of a prompt and every other saving came out of the turns. §6.12. |
<!-- /contract-table -->

```ts
import { assembleMemory } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';
import { StorageEmbeddingCache } from '@agentix-e/cortex-core';
import type { EmbedFn, LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
declare const embed: EmbedFn;
const storage = new SqliteStorage({ filename: './private.db' });
const shared = new SqliteStorage({ filename: './shared.db' });
const now = Date.UTC(2026, 0, 1);

// The smallest thing: no index, no boundary, no ranking. Named on purpose -- it is the configuration the
// instrument priced at 39.55%, so a call that omits `profile` does not get this one.
const smallest = assembleMemory({ llm, now, storage, profile: 'minimal' });

// A call that names no room gets the registered table: 48,460 characters on `multi-session`, 24,000 on the
// other five, which is 91.25% at 7,448 prompt tokens per question. Say one number to replace it everywhere,
// or name the routes you want to move and leave the rest as measured.
const registered = assembleMemory({ llm, now, storage });
void registered;
const bounded = assembleMemory({ llm, now, storage, maxPromptChars: 6_000 });
void bounded;
const quietTemporal = assembleMemory({ llm, now, storage, maxPromptCharsByRoute: { temporal: 8_000 } });
void quietTemporal;

// The same corpus, ranked. `embed` is optional; without it the index is lexical and costs no model call.
const reader = assembleMemory({ llm, now, storage, profile: 'reader', embed, index: { k: 40 } });

// A deployment. `shared` is what makes the boundary a boundary, and `name` is what makes the report
// attributable when two of these run in one process.
const install = assembleMemory({
  llm,
  now,
  storage,
  shared,
  profile: 'full',
  embed,
  name: 'support-desk',
  gate: { sessionBudget: 64 },
});

await install.memory.remember([
  { sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' },
  { sessionId: 's1', ordinal: 1, text: 'My landlord is called Anke.' },
]);
console.log(await install.memory.askStored('Where did I move?')); // routed to answerSessions

// A second assembly over the transcript the first one is writing. `corpus` is shared, the gate is not.
const second = assembleMemory({ llm, now, storage, corpus: install.corpus, profile: 'reader' });
void second;

// The same transcript, with the statement a later turn replaces marked where the reader meets it.
const marked = assembleMemory({ llm, now, storage, profile: 'full', shared, supersededRendering: 'mark' });
void marked;
void smallest;
void reader;

// A vector cache that survives the process. `open` hydrates from the store you already have, and the
// assembly uses it instead of a map that dies with the process; `flush` is what makes the entries
// durable, so it goes after the work rather than after the assembly.
async function durableAssembly(): Promise<void> {
  const cache = await StorageEmbeddingCache.open(storage, { dimension: 2048 });
  const durable = assembleMemory({
    llm,
    now,
    storage,
    profile: 'reader',
    embed,
    embeddingStore: cache,
  });
  await durable.memory.remember([
    { sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' },
  ]);
  await durable.memory.askStored('Where did I move?');
  console.log(await cache.flush()); // { written: 2, removed: 0 } -- the rows are on disk now
}
void durableAssembly;
```

One thing is deliberately **not** defaulted:

- **`shared`.** A `full` profile without a second store throws at assembly rather than at the first
  publication. Two sides of a boundary in one file is not a boundary.

**`maxPromptChars` is defaulted, and it took a round to see why.** The argument for omitting it was that the
per-route table is the registered arm's configuration, so a constant in this file would be a second arm. The
premise is right and the inference was backwards: the registered table is the **first** arm, so a composition
root that declined to name it did not decline to have one — it inherited the class's flat 48,000 on all six
routes, a configuration nobody dispatched, at a bill above the one that was measured. The default is now
`REGISTERED_ROOMS` (`multi-session` 48,460, the other five 24,000), `assemble-rooms.test.ts` pins it to
`tools/arm-config-baseline.json` so the two cannot drift apart, and `profile: 'minimal'` is the one exception
because its 39.55% was measured at the wide table and it ranks nothing.

The function is named `assembleMemory` rather than `createMemory` because `cortex-core` already exports
`createMemory` for the domain's `Memory` value, and two functions with one name an import apart is how a
reader calls the wrong one.

### 6.7 Marking the statement a later turn replaces

A transcript that updates a value — a follower count, a class day, a price — states the old value first.
The failure that costs the most on `knowledge-update` questions is not retrieval: the later statement is
delivered, the instruction block already says to prefer the later date, and the reply answers with the
earlier one anyway. The comparison is one the reader has to **find** inside 23,084 characters of
conversation before it can perform.

`supersededRendering` puts one bracketed clause next to the statement itself:

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 8 },
  supersededRendering: 'mark',
});
```

| value | the reader sees | what it costs |
| --- | --- | --- |
| `'off'` (absent) | the turn, unchanged | nothing; the prompt is byte-identical to the one before this option existed |
| `'mark'` | the turn, then `[this states a value a later turn replaces]` | the marker's length per marked turn |
| `'collapse'` | `[replaced value] ` and the one sentence at issue | the sentence instead of the turn |

Three properties are worth stating because they are the ones an integrator would otherwise discover:

- **It is not `conflicts`.** `conflicts` adds a section *after* the evidence; this appends to a turn
  *inside* it. The section was priced on the `KU` twin questions at **-4.75** over four repetitions (all
  four negative, monotone deepening), and the reading is that a block read after the answer is formed
  asks the reader to re-decide. The mark names no value and asks no question, so it is a different
  treatment with a different hypothesis — it is off by default and its own dispatch decides.
- **It reaches multi-session**, which `conflicts` does not. A mark inside a turn does not flatten session
  boundaries, and `askStored` — the only asking method `assembleMemory` gives you — routes there. A reach
  copied from `conflicts` would have shipped a mechanism no customer could reach; `assemble.test.ts`
  asserts the composition rather than the route method.
- **It is charged to the evidence budget.** The mark lives inside the evidence, so it is counted when the
  room is spent; a prompt within one marker of its budget delivers one turn fewer with the mark on than
  with it off. That is the price of putting it inside rather than beside, and it is arithmetic — the
  delta on any prompt whose delivered set does not move is the marker's length times the number of
  marked turns.

### 6.8 The browser deployment, end to end

The chapters above are Node-shaped because every reading this project has published was taken there.
Nothing in the assembly is: `storage` is a port, and §5.2's two browser tiers implement it. This is the
whole product in an origin-private filesystem, with no server:

```ts
import { assembleMemory } from '@agentix-e/cortex-memory';
import { openOpfsStorage } from '@agentix-e/cortex-storage/opfs';
import type { EmbedFn, LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
declare const embed: EmbedFn;

const SQLITE = new URL('sqlite-wasm/dist/index.mjs', import.meta.url).href;
// The worker as a second build entry, per §5.2: esbuild does not emit worker assets.
const WORKER = new URL('./storage-worker.js', import.meta.url).href;

// Two stores, because `full` needs two: the transcript, and the public side of the boundary. Two pool
// names rather than one, because a pool name is a directory in OPFS and two workers on one directory is
// two database handles on one file.
const transcript = await openOpfsStorage({
  sqliteModuleUrl: SQLITE,
  workerUrl: WORKER,
  databasePath: '/transcript.sqlite3',
  poolName: 'transcript',
});
const published = await openOpfsStorage({
  sqliteModuleUrl: SQLITE,
  workerUrl: WORKER,
  databasePath: '/published.sqlite3',
  poolName: 'published',
});

const install = assembleMemory({
  llm,
  now: Date.UTC(2026, 0, 1),
  storage: transcript.storage,
  shared: published.storage,
  profile: 'full',
  embed,
});

await install.memory.remember([
  { sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' },
  { sessionId: 's1', ordinal: 1, text: 'My landlord is called Anke.' },
]);
console.log(await install.memory.askStored('Where did I move?'));
```

Four things about that deployment are worth knowing before you ship it, and each is measured rather than
asserted:

- **The prompt is the same bytes as on the server.** The suite in `packages/cortex-memory/test/browser`
  runs this scenario twice — once under `node:sqlite` in the probe's own process, once here — and requires
  the prompt digests to be equal, before and after a browser restart. That equality is the claim, not "it
  did not throw": a prompt is the product's output at the point where its cost is counted, so equality
  covers the assembly, the ordering, the retrieval and the renderer at once. The committed reading is
  `packages/cortex-memory/test/browser/corpus-run.json`, and criterion `B3` reads it.
- **Durability is the browser's, not yours.** The transcript survives the tab closing — the suite closes
  Chromium and reopens it — because OPFS is on disk, per **origin**. A second origin is a different memory,
  and "clear site data" is a delete with no warning. If your deployment needs a copy the user cannot lose,
  export it; the memory is not the backup.
- **Ordering is data, not engine behaviour.** `Storage.query` has no `ORDER BY`, so the corpus stores the
  order the sessions arrived in and sorts by it. The suite's third check reads the transcript on a second
  engine and requires that order, which is why the invariant is not a property of SQLite's row order.
- **Erasure reaches the transcript here too.** `forget` on the boundary erases the turn as well as the
  card, and the suite sweeps every table on both stores for the sentence afterwards rather than checking
  the one field the product already fixed. That is the eighth surface of §6.5, on wasm, across a restart.

### 6.9 Ranking on more than the question, and choosing the channels

Retrieval answers one question with the turns it can reach, and a question is not always the wording its
evidence uses: "how many projects did I lead" is answered by a turn that says "led a consumer-research
project", and neither phrase reaches the other. `index.queryPlan` lets you hand the index **a set of
queries** for each question, and it fuses their rankings the same way it fuses its channels — by
reciprocal rank, so a turn two phrasings both rank highly outranks either one's best.

```ts
import type { EmbedFn, JsonSchema, LLM } from '@agentix-e/cortex-core';
import { assembleMemory, type QueryPlan } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

declare const llm: LLM;
declare const embed: EmbedFn;

const PHRASES: JsonSchema = {
  type: 'object',
  properties: {
    phrases: { type: 'array', items: { type: 'string' }, description: 'activity phrases, at most four' },
  },
  required: ['phrases'],
};

// The plan is a plain function, so the model that writes the phrases is yours: any `LLM` will do, and a
// table of hand-written phrasings is a plan too.
const queryPlan: QueryPlan = async (question) => {
  const { phrases } = await llm.completeStructured<{ phrases: string[] }>(
    `Name up to four short phrases an entry in a personal log would use for this activity: ${question}`,
    PHRASES,
    { temperature: 0 },
  );
  return [question, ...phrases];
};

const { memory } = assembleMemory({
  llm,
  now: Date.now(),
  storage: new SqliteStorage(),
  embed,
  index: { k: 32, queryPlan },
});
```

Four properties are worth knowing before you turn it on, and each is a decision rather than a default:

- **The question is not added for you.** A plan that forgets it ranks without it, which is why the example
  returns `[question, ...phrases]`. A plan that returns nothing — an empty list, or only blanks — falls back
  to the question, so an expansion that refused costs what the unexpanded run costs.
- **Duplicates and blanks are removed, keeping first appearance.** A repeated phrase would vote twice, and
  `lastIndexCensus().queries` reports what survived so you can see whether the plan acted at all.
- **The whole set is embedded in one request.** Four phrases are four texts in one call, not four calls;
  `embedTexts` grows by four and `embedCalls` by one. With no `embed` the plan still widens the lexical
  channel, at no cost.
- **A plan that throws is an error, not a fallback.** An expansion endpoint answering 401 would otherwise
  produce the unexpanded ranking under the expanded arm's name, and no artifact field would disagree. If you
  want a long batch job to survive a provider outage, catch it in the plan and return `[question]`.

Ranking costs money in two places, and `index.channels` is how you say which ones this deployment pays for:

```ts
import type { EmbedFn, LLM } from '@agentix-e/cortex-core';
import { assembleMemory } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

declare const llm: LLM;
declare const embed: EmbedFn;

// Dense only: no postings are built, so the memory a corpus costs is its vector table, and `census().terms`
// reads 0.
assembleMemory({
  llm, now: Date.now(), storage: new SqliteStorage(), embed,
  index: { channels: ['vector'] },
});

// Lexical only: the embedder is never called -- not for the corpus, and not for a query.
assembleMemory({
  llm, now: Date.now(), storage: new SqliteStorage(), embed,
  index: { channels: ['lexical'] },
});
```

`['lexical', 'vector']` is the default and the configuration every published reading was taken in. The two
refusals are `[]`, which ranks on nothing, and `['vector']` without an `embed`, which names a channel that
cannot run — naming `['lexical', 'vector']` without an embedder stays legal, because that is the ordinary
lexical index and the census says the vector channel did not run.

### 6.10 What a query term is worth

`channels` decides which rankings pay; `lexicalWeighting` decides what the lexical one charges for a word.
The default, `flat`, counts every content term as one, so coverage is the share of the question's words a
turn contains. That is a defensible reading of "this turn mentions what was asked", and it has a measured
failure: three matched *generic* words outrank one matched *noun*. On a five-hundred-question corpus, of the
twenty-one questions whose evidence contained no gold turn at all, twenty had a gold turn that scored above
zero and lost to a turn repeating the question's common words:

```
Q: "How many bikes do I own?"             gold 0.425  matched bikes, how
                                          winner 0.637  matched how, many, own
Q: "Suggest some activities ... commute"  gold 0.386  matched commute, during, some
                                          winner 0.693  matched activities, can, suggest, some, during
```

Rarity is a property of a corpus, not of a pair of strings, so this option only exists on an index:

```ts
import type { EmbedFn, LLM } from '@agentix-e/cortex-core';
import { assembleMemory } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

declare const llm: LLM;
declare const embed: EmbedFn;

// Terms are priced by ln(1 + (N - df + 0.5) / (df + 0.5)) over the turns this index holds: a word in every
// turn is worth almost nothing, a word in one turn of five hundred about 5.8, and no word is worth zero.
assembleMemory({
  llm, now: Date.now(), storage: new SqliteStorage(), embed,
  index: { lexicalWeighting: 'idf' },
});

// The default, stated: what every reading in this repository was measured under.
assembleMemory({
  llm, now: Date.now(), storage: new SqliteStorage(), embed,
  index: { lexicalWeighting: 'flat' },
});
```

Three properties, and the first two are why this is a weighting rather than a model:

- **It costs nothing.** The document frequencies come from the postings the index already builds, so
  `embedCalls` and `terms` do not move, and a lexical-only deployment still calls no provider.
- **It is corpus-derived, not corpus-fitted.** The formula is Robertson/Sparck-Jones — the one Lucene uses
  — and there is no constant here chosen from an answer key. A weight fitted to a benchmark's term
  distribution would be the benchmark, encoded.
- **It is refused when it is not a name this index administers, at the call you can read.**
  `lexicalWeighting: 'bm25'` throws instead of falling back to `flat`, because a run that meant to price
  term specificity, ranked flat, and reported "no difference" is a result about the wrong experiment — and
  every other field of its artifact would be truthful. The refusal belongs to `assembleMemory` as well as to
  the index: the index is built per question, so a check that lived only there would fire after the first
  `remember()`, on a store that may already hold your data, while the typo is in the call in front of you.

The order after fusion is still a rank, not a score: with a reranker or a second channel the fused number
is a position, and `lexicalWeighting` therefore changes *which* turns arrive, not how they are sorted.

### 6.11 Telling the reader when each conversation happened

A long multi-session window is hard to read for a reason that has nothing to do with how much evidence it
carries: every turn states its own date, and by the time a reader has skimmed two hundred of them to the
candidate it wants, the date is attached to nothing. The observable consequence, measured on the arm's own
artifact (`44017278305`, 121 multi-session questions × 4 repetitions): a reply that prints three or more
dated items, of which three or more carry the same date, appears in **17 of the 57** questions that are ever
wrong (29.8%) and in **39 of the 443** that never are (8.8%) — 3.39 times the rate. The dates are not
missing — none of that artifact's 41,822 delivered turns lacks a `[YYYY/MM/DD …]` stamp — so the repair is to
say the date **once per conversation**, where the reader is already deciding which conversation a candidate
came from.

```ts
import type { LLM } from '@agentix-e/cortex-core';
import { assembleMemory } from '@agentix-e/cortex-memory';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

declare const llm: LLM;
declare const sessions: string[][];

const install = assembleMemory({
  llm, now: Date.now(), storage: new SqliteStorage(),
  // Every boundary now reads `Session 3 (2023-05-21)` instead of `Session 3`.
  sessionClock: true,
});
```

The prompt then draws its boundaries as `Session 3 (2023-05-21)`, or as a range
(`Session 3 (2023-05-21..2023-05-27)`) when the block's turns disagree. Three properties are worth knowing
before you turn it on:

- **It reads the block, not the transcript.** The label is computed from the text the reader is actually
  given, so a turn the budget dropped cannot put its date on the boundary. That is not a detail: the first
  implementation computed the label from the selected turns and printed `2023-05-21..2023-12-31` on a block
  whose December turn had been clipped away.
- **It never invents a date.** A block whose turns state none keeps the plain `Session 3`, and a stamp that
  names no day (`[2023/02/30]`) is ignored rather than printed.
- **It costs about 22 characters per session** — roughly 450 on a twenty-session window, 1% of a 45,000
  character prompt — and it changes nothing else. With the option off, the prompt is byte-identical to the
  one every published number was produced under.

**Off by default, and turning it on is a measurement rather than a preference.** The mechanism has a reach
figure and a cost figure and no accuracy reading yet: changing the default would move the scored path without
one, which is the rule §13 states for every option in this manual. `RETRACTIONS.md` and the measurement
records behind it show what happens to mechanisms shipped on the strength of a plausible story.

## 7. Reading a decision back

A memory layer that cannot explain itself is a black box with extra steps. Every route records what
it did, and the accessors describe the **most recent question**, not the run:

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({ llm, now: 0, gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 8 } });

void memory.lastRawOutput();        // the model's text before parsing; null if no call yet
void memory.lastPromptText();       // the assembled prompt, byte for byte
void memory.lastAdmittedEvidence(); // { turns, chars } that reached it
void memory.lastPromptEvidenceChars();
void memory.abstentionReasons();    // { empty, threshold, llm, answered } -- four distinct outcomes
void memory.voteCounts();           // { unanimous, majority, split }
void memory.recoveryCensus();       // { attempted, answered }
void memory.auditCensus();          // { attempted, changed }, or null when no audit ran
void memory.lastIndexCensus();      // the last question's index: turns, embedTexts, memoHits, rerank*
void memory.indexCost();            // the run so far, summed: indexes, turns, embedTexts, memoHits, reuse
void memory.rankingCensusOf('How many cities did I live in?'); // the pool it ranked, best first
```

`abstentionReasons` is the one to read first when a run looks wrong. Four outcomes that used to be one
number: nothing was admitted (`empty`), the gate closed (`threshold`), the model declined (`llm`), or
the model declined and a retry answered (`answered`). Two of those are machine decisions and cost no
request; two are the model's.

`lastRawOutput()` exists because `null` from `parseAnswer` covers three different model behaviours —
the bare token, a labelled token, and an explanation followed by the token. The parsed answer cannot
tell them apart; the raw text can.

`lastIndexCensus()` and `indexCost()` are the pair that prices §6.1's `index`. The first describes the
question just answered; the second is the total, and it is the one a bill is read from — a per-question
census is overwritten by the next question, so `indexCost()` is the only accessor here that is not
about "the most recent question":

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 8 },
  // The embedder is injected, so the product never owns a key. Its vectors are memoised in one store
  // per instance, which is why the second question over a corpus it has already seen is nearly free.
  index: { embed: async (texts: string[]) => texts.map(() => [1, 0, 0]), k: 64 },
});

await memory.answerSessions('How many cities did I live in?', [
  ['I moved to Berlin in 2024.', 'Then Lisbon in 2025.'],
]);

console.log(memory.indexCost());
// { indexes: 1, turns: 2, embedCalls: 2, embedTexts: 3, memoHits: 0, reuse: true, rerankCalls: 0, rerankDegraded: 0 }
// `indexes` is 1 per ranked question, `texts` is one per corpus turn plus one query, and `hits` is what
// the store answered instead of the model. A run whose `embedTexts` equals `turns + indexes` had no reuse
// to speak of -- which is the real reading on a corpus that changes every question.
```

## 8. Cost control

Prompt length is the whole bill. Four knobs, in decreasing order of leverage:

| knob | unit | what it buys |
| --- | --- | --- |
| `maxPromptChars` / `maxPromptCharsByRoute` | characters | The evidence room. One number for all routes, or one per route. |
| `sessionBudget` | turns | How many admitted turns compete for that room. |
| `maxTurnChars` + `maxTurnCharsRoutes` | characters per turn | A per-turn cap, so one long turn cannot eat the room. |
| `relevanceFor` + `relevanceUnits` | score over turns | Which turns the room is spent on. |

The trap is that **a character room is not a depth**. At a 48,000-character budget the same room
becomes five different depths, because routes differ in how long their turns are:

| route | characters per delivered turn | delivered turns in 48,000 |
| --- | ---: | ---: |
| `flat` | 723 | 61 |
| `knowledge-update` | 717 | 62 |
| `abstention` | 596 | 72 |
| `multi-session` | 215 | 174 |
| `temporal` | 205 | 179 |

So `multi-session` and `temporal` are not short of room, they are short of *relevance* — they already
read 174 turns for 46,264 characters. Raising those two costs nothing in depth and everything in
tokens; lowering `maxPromptCharsByRoute['multi-session']` is the cheap direction, and it is why the
option is per route rather than global.

For a published comparison, be careful about which quantity is being compared, because the field does
not agree on one. Some published figures count the **retrieved evidence** only -- Mem0 6,787, Zep
4,408 (a median), Contextier 2,807 -- and some count **everything the model is handed**. Those are
not the same number, and dividing one by the other produces a ratio that means nothing.

Cortex records both so you can pick: `promptTokensPerQuestion` is the whole prompt, and the evidence
share is about 97% of it, so `promptChars` (delivered evidence) is the like-for-like quantity against
a field figure. `docs/MEASURE-TOKEN-BASIS.md` has the table and `tools/token-basis.py` computes it
from the ledger. If your cost target is a competitor's evidence budget, `maxPromptChars: 24_000` is
the setting to measure, and `sessionBudget` expressed in `chars` (via `CortexSessionProvider`'s
`budgetUnit`) is the unit that is comparable at all.

`selfConsistency: n` multiplies the model calls by `n` on the routes it reaches and buys stability,
not accuracy: read `voteCounts()` before and after, because a vote that is unanimous every time is
not a vote.

### 8.1 Where the room was spent, when the claim is about retrieval

`rankingCensusOf(question)` answers a question the delivery cannot: **the order the product ranked, not
just the part of it the room bought.** `lastRetrievedContext()` is the delivery — what the reader read.
The pool is what the room was shopping from, and the difference between the two is the difference
between two repairs that look identical in an accuracy number:

| observation | what it means | what to change |
| --- | --- | --- |
| a gold turn's rank is `-1` | the product's ranking never surfaced it | the index: channels, `k`, `lexicalWeighting` |
| its rank is at or beyond the number of delivered turns | surfaced, and the room cut it | `maxPromptChars` on that route |
| its rank is inside the delivery | the room bought it and the answer is about the reading | neither |

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
declare const sessions: string[][];
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 8 },
  index: { embed: async (texts: string[]) => texts.map(() => [1, 0, 0]), k: 64 },
});

const question = 'How many cities did I live in?';
await memory.answerSessions(question, sessions);
const pool = memory.rankingCensusOf(question); // readonly string[] | undefined
const delivered = memory.lastRetrievedContext()?.length ?? 0;
// `pool === undefined` means the product built no ranking -- no `index` configured, or the ranking came
// from your own `relevanceFor`. It is not an empty ranking, which is `[]` and is a finding about the corpus.
console.log(pool?.length, delivered);
```

Two properties are worth knowing before you wire it:

- **It is bound to a question.** The accessor holds one slot, so it takes the question as an argument and
  returns `undefined` when the slot describes a different one. Reading "the last ranking" after a
  500-question pass is how an artifact comes to explain every question with one question's evidence.
- **It is only as wide as `k`.** A turn the index did not return has no rank, and no rank is the correct
  answer for it: the prompt never held a score for that turn, so the room could not have spent anything on
  it.

## 9. Recipes

**Two statements of one detail, side by side.** A memory that says "class on Thursday" in June and
"class on Fridays" a fortnight later answers *"what day is my class"* with whichever of the two the
reader happened to anchor on. Measured on five questions that fail this way in every repetition, the
later statement is in the window every time and the reader answers with the earlier one -- the
comparison is one it has to find inside 23k characters before it can perform it.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
declare const turns: string[];

const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  // The prompt names the statements that share terms with the question and state a value, earliest
  // first, with their dates, and says that when two of them differ the later one is the value now.
  conflicts: true,
});

const answer = await memory.answer('What day of the week do I take a cocktail-making class?', turns);
```

The block is inserted after the budget decided which turns are carried, so it costs the evidence
nothing: mean 1,104 characters, 2.3% of a 48k prompt, and zero model calls. What it cannot do is
reach a value that is only named by its relation to another one, or one the corpus increments rather
than replaces -- `docs/MEASURE-CONFLICT-SURFACING.md` sections 2 and 4 price both, and section 4 is
the reading of the first run that administered it.

**A stronger reader for two routes only.** Measured: thinking mode gained four `TR` and two `KU`
questions while losing sixteen `IE` — one reader for six routes cannot express that.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const fast: LLM;
declare const thinking: LLM;

const memory = new CortexMemory({
  llm: fast,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 96 },
  readerByRoute: { temporal: thinking, 'multi-session': thinking },
});
void memory;
```

**A room per route, so a short-turn route is not starved of depth.** Two routes named, four
byte-identical to the single-number configuration.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 200 },
  maxPromptChars: 48_000,
  maxPromptCharsByRoute: { 'multi-session': 24_000, temporal: 24_000 },
});
void memory;
```

**A per-question evidence budget, when a fixed room is paying for a tail.**

`maxPromptChars` is one number per route, so every question on that route is answered at that
width. `widthPlan` decides the budget from the question instead: rank its candidates by
`lexicalRelevance`, take the shortest prefix explaining `coverage` of the relevance mass, and
spend the smaller of that and the room. `lastWidth()` reports which of the four reasons the
plan gave -- `capped` is the only one that means it acted.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 200 },
  maxPromptCharsByRoute: { 'multi-session': 48_460 },
  widthPlan: { coverage: 0.9, floorChars: 4_000, renderMargin: 1.15 },
});
void memory;
```

Three numbers, and each one changes what the cut means. `coverage` is the share of the
question's relevance mass the delivered evidence must explain -- `1` is the identity, where the
plan looks and declines on every question. `floorChars` is the smallest budget it will fund,
which exists so a reading measures *less evidence* rather than *a prompt too small to work*.
`renderMargin` inflates a raw prefix length to the rendered one; below `1` the selector is
handed less room than the plan reports and the turns the plan counted as delivered are dropped.

The cut is funded over the characters each turn **contributes**, not the characters it holds,
so a `maxTurnChars` cap is accounted for: a 5,000-character turn that the cap reduces to 400
counts as 400. A plan measured on raw lengths would fund twelve times the prompt it budgets
and silently do nothing on exactly the routes the cap reaches.

**Ranking turns without a caller-supplied signal.**

`relevanceFor` is a function the caller has to write, so a deployment that omits it spends its
evidence room in arrival order. `index` is the product's own retrieval: it builds postings over
the turns of the question, optionally adds a vector channel through an injected batch embedder,
fuses the channels by rank, and optionally reranks the head. `relevanceFor` still wins when both
are set, so a measured run can keep its declared signal.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
// Batched, because a per-turn call cannot be priced; the product never constructs a client.
declare const embed: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;

const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 200 },
  index: { embed, k: 64 },
});
void memory;
```

Omitting `index` reproduces the previous behaviour byte for byte, which is what keeps the runs
already on record comparable. The index is built per question, because the session-aware contract
hands the corpus in per question; a caller with a stable corpus builds one `SearchIndex` itself and
passes `relevanceFor`. `lastIndexCensus()` reports what the stage did — `rerankCalls` beside
`rerankDegraded`, because a reranker that failed and one that agreed produce the same accuracy.

**Only user turns, on the two routes where assistant turns are noise.**

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  evidenceRoles: ['user'],
  evidenceRolesRoutes: ['multi-session', 'temporal'],
  roleOf: (turn) => (turn.startsWith('Assistant:') ? 'assistant' : 'user'),
});
void memory;
```

**Cap one long turn, say so, and name the contract — on the two routes where turns are short.**

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  name: 'capped-rooms',
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  maxTurnChars: 400,
  turnCutMarker: 'ellipsis',
  // The same 400 characters, chosen around the question rather than from the start of the turn.
  turnWindow: 'match',
  maxTurnCharsRoutes: ['temporal', 'multi-session'],
  promptContract: 'abstention-evidence-blocks',
  ask: 'extractive',
  reviewPass: 'recover',
  reviewBareDecline: true,
});
void memory;
```

**Repair the reply, not the evidence.** `replyRepair` answers the two reply shapes that no retry can reach — a
refusal written in prose, which parses as an answer, and a list of quotations with no answer line. It re-asks once
with the same evidence and a different instruction, so the movement it produces is attributable to the sentence
rather than to a different window. It is refused beside `reviewPass`, because that field already puts a second
consultation on the same route.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  replyRepair: 'both',
});
void memory;
```

**Spend the room around an anchor, with a relevance signal and a window.** `windowOrdering` is two
injections rather than one behaviour because the reference pipeline's date format is its own: a caller
whose turns are dated differently supplies its own reader, and a turn with no date answers `undefined`
rather than a default of the epoch — which would put every undated turn inside every window.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 174 },
  relevanceFor: (question, turn) => (turn.includes(question.split(' ')[0] ?? '') ? 1 : 0),
  relevanceUnits: 'anchor-window',
  windowRadius: 2,
  windowOrdering: {
    dateOf: (content) => /^\[(\d{4}\/\d{2}\/\d{2})\]/.exec(content)?.[1],
    windowOf: (_question, questionDate) => ({
      start: questionDate ?? '2026/01/01',
      end: questionDate ?? '2026/12/31',
    }),
  },
});
void memory;
```

**Open the gate properly.** The value function is `confidence * sourceTrust * (0.5 + 0.5 * recency)`.
With `sourceTrust` fixed at `0.5` and confidence constant, the maximum reachable value was `0.5`, so no
threshold above `0.5` could ever admit anything: the gate was a two-state switch wearing a continuous
field. Supplying a real per-turn signal is what makes a threshold mean what it says.

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { LLM, MemoryValue } from '@agentix-e/cortex-core';

declare const llm: LLM;
const memory = new CortexMemory({
  llm,
  now: 0,
  gate: {
    threshold: 0.35,
    retrievalThreshold: 0.2,
    sessionBudget: 64,
    sourceTrust: 1,
    confidenceFor: (turn) => (turn.length > 40 ? 0.9 : 0.4),
    valueFunction: (memory: MemoryValue) => memory.confidence * memory.sourceTrust,
  },
});
void memory;
```

## 10. Abstention

A decline is `null` from an answer method, and on the wire it is the literal token:

| name | value | where |
| --- | --- | --- |
| `ABSTAIN_TOKEN` | `INSUFFICIENT_EVIDENCE` | the prompt asks for it; `parseAnswer` recognises it |
| `DECLINE_TOKEN` | `INSUFFICIENT_EVIDENCE` | the recovery prompt's decline |

```ts
import { ABSTAIN_TOKEN, isAbstention, parseAnswer } from '@agentix-e/cortex-memory';

console.log(parseAnswer(`Some reasoning.\nAnswer: ${ABSTAIN_TOKEN}`)); // null
console.log(isAbstention('  insufficient_evidence '));                // true
console.log(parseAnswer('Answer: Lisbon'));                           // 'Lisbon'
```

`parseAnswer` reads the **last non-empty line**, strips an `Answer:`-style label, and compares with
the token case-insensitively. It never searches the body: a model that reasons "the evidence is
insufficient for the second city, but the first is Lisbon" is answering *Lisbon*, and a substring
match would turn that into a decline.

### 6.12 When one turn is too long to print whole

A per-turn width is the cheapest way to keep one long narrative from spending a whole window, and it has a
cost that is easy to miss: the characters it keeps are **the first ones**, which are the ones that happen to
be first. `turnWindow: 'match'` fixes the *position* of that cut and keeps the width. `resolution: 'layered'`
fixes the *width* instead, and it is what to reach for when the bill is the constraint:

```ts
import type { LLM } from '@agentix-e/cortex-core';
import { CortexMemory } from '@agentix-e/cortex-memory';

declare const llm: LLM;

const memory = new CortexMemory({
  llm, now: Date.now(),
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  // The width stops bounding a turn and becomes the base the three form ceilings are ratios of:
  // 400 for a short turn, 600 for the excerpt of a turn that shares a term with the question,
  // 240 for the one-line record of a turn that shares none.
  maxTurnChars: 400,
  resolution: 'layered',
});
```

Three things to know before turning it on:

- **The selector does not change.** The budget takes the largest prefix of the ranking that fits the room
  *after rendering*, so cheaper turns mean a longer prefix — density, not a different selection. A build
  that also re-ordered or skipped turns would make the two indistinguishable.
- **It replaces the width rather than stacking on it.** The cap still sets the scale, but no turn is bounded
  by it: the excerpt ceiling is half again as large, which is what makes a matching turn *gain* by being
  matched. With the option absent every turn prints whole and the prompt is byte-identical to the one every
  published number was produced under.
- **Every shortened turn says so.** Both forms mark their elisions, so a reader is never looking at a turn
  that was silently cut. That is also why layering and `turnWindow: 'match'` are refused together: they
  decide the same characters, and a prompt carrying both could not be attributed to either.

The same four fields — `maxTurnChars`, `turnCutMarker`, `turnWindow`, `resolution` — are accepted by
`assembleMemory`, which forwards them unchanged, so a deployment can reproduce the rendering a measurement
was taken under without constructing the class.

### 6.13 The same corpus and the same question produce the same prompt

A prompt is a function of the corpus, the question and the options. That sounds like a property you get for
free, and it is not: it is a property of the *ordering*, because the last turn the room can afford is chosen
by comparing scores, and the scores arrive from an embedding provider as floating-point numbers.

Two candidates whose similarity differs by less than the provider can resolve are, to the room, the same
candidate — but a comparison that looks at the last bit will pick a different one on a different day, and
then two runs of one configuration carry prompts that differ by a turn. The evidence is not wrong in either
run; it is *not reproducible*, which is enough to make an A/B measurement say something the experiment did
not.

So the ordering compares scores rounded to `1e-4` and breaks ties by arrival — the order the context had
them in. The grid is four orders of magnitude above the arithmetic error of a 1,024-dimension dot product and
two orders below the difference at which a cosine similarity separates two turns about which the signal has
anything to say. If you inject your own `relevanceFor`, this is what it means for you:

- a score whose *difference* from a neighbour is smaller than `1e-4` will not reorder them; arrival decides;
- the ranking never gets worse — rounding is monotone, so a score that beats another by more than `1e-4`
  still wins;
- a provider whose own noise is larger than `1e-4` can still move a boundary, and no client-side rule can
  prevent that: the information is gone before it arrives. If you are chasing reproducibility across
  providers, quantise the signal at the source and the ordering will follow it.

## 11. Choosing routes deliberately

Six routes exist because six question shapes need different prompts, and the names are exported as a
value so you never restate them:

```ts
import { ASK_ROUTES, PROMPT_CONTRACTS, TURN_CAP_ROUTES } from '@agentix-e/cortex-memory';

console.log(TURN_CAP_ROUTES);        // multi-session, temporal, flat, knowledge-update, abstention, assistant
console.log(PROMPT_CONTRACTS);       // abstention, abstention-evidence-blocks, evidence-blocks-instruction-first, evidence-blocks-unsourced
console.log(Object.keys(ASK_ROUTES)); // every ask name, which is the vocabulary `ask` accepts
```

`ASK_ROUTES` is a map from ask to **the routes it reaches**, not to text. `ask: 'aggregate'` reaches
only `multi-session` and `flat` — the two routes whose own contract is extractive — which is what
makes it a targeted instruction rather than a second global one. The other four routes are the
internal control: if they move when you change `ask`, the change reached further than its name says.

### 11.1 Choosing among the asks that matter

`ask` is a closed vocabulary and most of its values are history: an experiment that measured one
instruction block against another. Two of them are worth knowing as a user, because they are the ones
this project still reads:

| `ask` | what it tells the reader | when it wins |
| --- | --- | --- |
| `'route'` (default) | nothing beyond the route's own contract | the safe default; it is what every published number before the aggregation campaign was measured under |
| `'verbatim-acts'` | the reader counts an act described under a different verb, and pairs one event mentioned twice | counting questions, which is most of what `multi-session` is for; it is the value every published number since §13.290 was measured under |

There is a third value you will find in the table, `'verbatim-scope'`, and it is **measured and
rejected** rather than recommended: it adds a bound on the period and the actor, and on the same 121
counting questions it loses **−4** — two questions gained, six lost. Do not reach for it. Its record
is kept because the reason it fails is worth knowing: two gold totals inside the same capability
cannot both be produced by one actor rule, so the annotation the score is computed against does not
have a consistent one either. A prompt line cannot repair that, and this one cost questions proving it.

The difference between the two live values is one line of instruction, and that is deliberate: an
`ask` value is a single variable, so a pair of arms built from two of these differs in exactly the
text you can read in `prompt.ts` and nothing else. Their instruction blocks differ in length, so a run
that switches between them should expect the delivered evidence to differ slightly: the room is a
budget the evidence is fitted into, and the packing is greedy — adding 575 characters of instruction
moved the cut boundary on 106 of 121 questions even when the room was raised by the same 575.

Every ask outside this table is kept because a published artifact was measured under it. They are
reachable, they are tested, and switching to one reproduces that artifact's rendered prompt; none of
them is a recommendation.

## 12. Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| `Cannot find module 'better-sqlite3'` | imported the `./sqlite` subpath without the peer | `pnpm add better-sqlite3`, or import `./pg` instead |
| `the storage worker failed to start` | bundled build without a worker entry (§5.2) | add `.../opfs/worker` as a build entry and pass `workerUrl` |
| `no storage tier could be opened: opfs: ...` | OPFS unavailable (private mode, quota) | catch `BrowserStorageUnavailable` and use `openIdbStorage` |
| every question declines | `retrievalThreshold` above the reachable ceiling | check `abstentionReasons()`: `threshold` means the gate, `llm` means the model |
| `400` from an embeddings call | `dimensions` omitted on a variable-dimension model | pass the width you built the index with |
| `the remote backend needs CORTEX_LLM_MODEL, ...` | missing environment | the message lists every missing name at once |
| a run is slow with no errors | `minIntervalMs` pacing, or thinking mode on a 48k prompt | lower `thinking`, or raise `retryBudgetMs` above `timeoutMs` |
| answers are right but the score is not | the judge, not the reader | see the harness's judge audit; a 0-false-accept record is reported separately |
| `429` with `insufficient_quota` or `余额不足` in the body | the account cannot pay, which no retry can fix | top up, or pass no `embed` and run the lexical index (§12.1) |
| the vector channel stopped ranking halfway through a run | the embedder started failing | see §12.1: the default is to throw, and `onEmbedFailure: 'lexical'` is the documented alternative |

### 12.1 When the embedder stops answering

A retrieval stack has one input it cannot supply itself, and it is the only one that can fail for a
reason the caller cannot fix by adjusting a parameter. Two events arrive as the same `429`:

| the body says | what it means | what this product does |
| --- | --- | --- |
| `rate_limit_exceeded`, `rate_limit_error` | you are asking too fast | retries with backoff, honouring `Retry-After` |
| `insufficient_quota`, `quota_exhausted`, `billing_hard_limit_reached`, `余额不足`, `code 1113` | the account cannot pay | stops at once — a wait cannot make this true |

The second row is not a tuning problem, so it is not retried: `EmbeddingQuotaExhaustedError` carries the
provider's own words and the status, and a caller can tell it from a rejected request with `instanceof`.
Wrapping it in a retry ladder spends the whole allowance and then fails anyway.

What happens to the *retrieval* is your decision, and it is stated once:

| `onEmbedFailure` | behaviour |
| --- | --- |
| `'fail'` (default) | the error propagates. A deployment that asked for a vector channel and silently got lexical scoring would believe the channel was working. |
| `'lexical'` | this retrieval is scored lexically, `lastIndexCensus().embedDegraded` counts it, and `embedFailure` keeps the provider's message |

The fallback is a real configuration rather than a broken one — it is the same index the product runs
when you pass no `embed` at all — and its cost is measured: **85.75% against 91.40%** on
LongMemEval-S, paired at −28 of 500 questions (exact McNemar p = 2.5e-5). Prefer `'fail'` in a service,
where a wrong answer is worse than an error. Prefer `'lexical'` for a long batch job, where losing the
whole run is worse than a quarter of it being scored the cheaper way — and read `embedDegraded` before
quoting the number, because a run with any degradations is neither arm.

`lastIndexCensus()` answers for the most recent index and `indexCost()` for the whole instance; the second
is the one to read after a run, because a per-question census is overwritten by the next question and a
degradation in question 3 is invisible by question 4.

The policy is passed the same way every other index option is:

```ts
import { CortexMemory } from '@agentix-e/cortex-memory';
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

const llm: LLM = {
  complete: async (_prompt: string, _opts?: CompleteOptions) => 'INSUFFICIENT_EVIDENCE',
  completeStructured: async <T>(_prompt: string, _schema: JsonSchema): Promise<T> => {
    throw new Error('unused');
  },
};

const memory = new CortexMemory({
  llm,
  now: Date.UTC(2026, 0, 1),
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 64 },
  index: {
    k: 64,
    onEmbedFailure: 'lexical',
    embed: async (texts: string[]) => texts.map(() => new Float64Array(1024).fill(0)),
  },
});

// After a batch: how much of the run was scored the cheaper way.
const degraded = memory.indexCost()?.embedDegraded ?? 0;
console.log(degraded); // 0 means every retrieval had its vector channel
```

## 13. Stability

The packages are `0.x`. What that means concretely:

- **Stable**: the three contracts (`LLM`, `EmbeddingModel`, `Storage`), the package names, the
  subpath layout, and the option names in §6.1 and §6.2. An option is never renamed silently; a
  renamed option fails `pnpm manual:check` in this repository before it reaches you.
- **Not yet stable**: which optional `answer*` method a question shape routes to, and the shape of the
  statistics helpers in `cortex-eval`. Both are still moving with the measurement campaign.
- **Never**: a default that changes the behaviour of a configuration that named nothing. Every option
  in this manual has the default the first published measurement used, and a change of default is
  treated as a new configuration with its own number.

## 14. Where to read more

| document | what it answers |
| --- | --- |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | The layer map, the dependency rules, and what is wired to what. |
| [`SOTA-BASELINE.md`](../SOTA-BASELINE.md) | The published numbers this repository compares itself against, with the settings. |
| [`docs/DESIGN-CORTEX-MEMORY.md`](DESIGN-CORTEX-MEMORY.md) | Why the gates are shaped the way they are. |
| [`docs/ACCEPTANCE-MATRIX.md`](ACCEPTANCE-MATRIX.md) | The acceptance criteria each capability is held to. |
| [`RETRACTIONS.md`](../RETRACTIONS.md) | Every published number that was later corrected, and why. |
| [`docs/README.md`](README.md) | Index of the design and audit records. |

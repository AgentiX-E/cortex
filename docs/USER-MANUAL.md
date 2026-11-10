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
| `maxTurnChars` | `number` | absent (no cap) | Upper bound on what one turn may contribute. |
| `turnCutMarker` | `'none' \| 'ellipsis'` | absent | Whether a turn the cap cut says so. Only forwarded on routes the cap reaches. |
| `maxTurnCharsRoutes` | `readonly TurnCapRoute[]` | absent (all routes) | Which routes the per-turn cap reaches. `[]` reaches none. |
| `relevanceFor` | `(question, turn) => number` | absent | Ranks which turns the budget is spent on. |
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
<!-- /contract-table -->

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
```

`abstentionReasons` is the one to read first when a run looks wrong. Four outcomes that used to be one
number: nothing was admitted (`empty`), the gate closed (`threshold`), the model declined (`llm`), or
the model declined and a retry answered (`answered`). Two of those are machine decisions and cost no
request; two are the model's.

`lastRawOutput()` exists because `null` from `parseAnswer` covers three different model behaviours —
the bare token, a labelled token, and an explanation followed by the token. The parsed answer cannot
tell them apart; the raw text can.

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

For a published comparison, the field reports its prompt budget in tokens and other systems report
theirs: Mem0 6,787, Zep 4,408, Contextier 2,807 mean. A 48,000-character room is roughly 12,000
tokens, so a Cortex arm is spending about twice Mem0's budget per question. If your cost target is
theirs, `maxPromptChars: 24_000` is the setting to measure, and `sessionBudget` expressed in `chars`
(via `CortexSessionProvider`'s `budgetUnit`) is the unit that is comparable at all.

`selfConsistency: n` multiplies the model calls by `n` on the routes it reaches and buys stability,
not accuracy: read `voteCounts()` before and after, because a vote that is unanimous every time is
not a vote.

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
  // The prompt names the statements that share terms with the question, earliest first, with their
  // dates, and says that when two of them differ the later one is the later value. It decides
  // nothing: "what did I buy before the Air Fryer" asks for the *earlier* of two values, so the
  // direction stays in the question.
  conflicts: true,
});

const answer = await memory.answer('What day of the week do I take a cocktail-making class?', turns);
```

The block is inserted after the budget decided which turns are carried, so it costs the evidence
nothing: mean 1,104 characters, 2.3% of a 48k prompt, and zero model calls. What it cannot do is
reach a value that is only named by its relation to another one, or one the corpus increments rather
than replaces -- `docs/MEASURE-CONFLICT-SURFACING.md` section 2 prices both.

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

## 11. Choosing routes deliberately

Six routes exist because six question shapes need different prompts, and the names are exported as a
value so you never restate them:

```ts
import { ASK_ROUTES, PROMPT_CONTRACTS, TURN_CAP_ROUTES } from '@agentix-e/cortex-memory';

console.log(TURN_CAP_ROUTES);        // multi-session, temporal, flat, knowledge-update, abstention, assistant
console.log(PROMPT_CONTRACTS);       // abstention, abstention-evidence-blocks, evidence-blocks-instruction-first, evidence-blocks-unsourced
console.log(Object.keys(ASK_ROUTES)); // route, extractive, aggregate, computed, enumerated, sweep, aggregation, silent, answer-line, recommend
```

`ASK_ROUTES` is a map from ask to **the routes it reaches**, not to text. `ask: 'aggregate'` reaches
only `multi-session` and `flat` — the two routes whose own contract is extractive — which is what
makes it a targeted instruction rather than a second global one. The other four routes are the
internal control: if they move when you change `ask`, the change reached further than its name says.

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

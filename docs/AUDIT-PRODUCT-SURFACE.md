# AUDIT — The Product Surface, and the Corpus It Does Not Own

**Status:** audit complete at `dd216c5`. No code changed in this pass: this document is the evidence
table and the ordered plan, and each row names the file and line that makes it true.

**Audits this one does not repeat.** [`AUDIT-SEMANTIC-REACH.md`](AUDIT-SEMANTIC-REACH.md) counts which
capabilities the shipping path reaches. [`AUDIT-CODE-VS-DOCS.md`](AUDIT-CODE-VS-DOCS.md) reconciles
what the code does against what the documents said. [`AUDIT-UNREFERENCED-EXPORTS.md`](AUDIT-UNREFERENCED-EXPORTS.md)
lists exports with no caller. This one asks a question none of them ask:

> **Can a person install this product, put their history into it, and ask it a question afterwards —
> without writing the memory themselves?**

The answer is no, and the reason is not a missing algorithm. It is that **the product has no corpus**.
Most findings below are downstream of that sentence; two are not, and they are marked where they occur.

---

## 1. Method, and what a keyword search would have got wrong

The reach question in this repository has been answered wrongly three times by searching for names.
`AUDIT-SEMANTIC-REACH.md` §3 records the first: a search for `parser|AST|symbol` did not match
`frame`/`fact`/`assumption`/`supersede`, so modules read as absent that were present. The inverse also
happens — `decideRetrieval` appeared in a docstring and in a barrel comment while having no call site
at all, and the abstention route spent a measured period with a wording change instead of a mechanism
(`memory.ts`'s own `answerAbstention` docstring records it).

So each claim below is one of five kinds, and the kind is always printed:

| kind | what it means | how it was established |
| --- | --- | --- |
| **absent** | no implementation anywhere | the shape searched, not the name: `storage`, `persist`, `ingest`, `close`, `transaction`, `del`, `erase`, `forget` |
| **unreachable** | implemented, and no shipping path calls it | call chain traced from every constructor of the public classes outward |
| **misreported** | the mechanism runs, and the published number does not describe the work | the counting site read, then compared against the unit the field name promises |
| **divergent** | two backends implement one documented contract differently | both read side by side, then the parity suite's coverage checked |
| **correct, and it still costs** | nothing is broken; the arrangement is expensive | measured or counted, with the count shown |

Constructors were the anchor. A class nothing constructs is unreachable however often its name appears
in prose, so §2 begins there.

**One correction to the census's own wording, because it is easy to over-read.** `tools/export-census.mjs`
excludes `src/__tests__` (`line 110`), so "referenced nowhere at all" means **no non-test reference in
the workspace** — not "not even in its own tests". Every count here uses the first meaning. That
distinction matters immediately: `CachingEmbedding` is on that list and has 23 assertions.

---

## 2. The finding, in one table

`cortex-memory` ships four public classes. Three hold state, one answers questions, and **they are not
connected**. The only assembly of the answering one is in a file the package does not publish.

| public class | what it owns | what it does not own | constructed outside its own tests? |
| --- | --- | --- | --- |
| `CortexMemory` | a prompt, six routes, a reader, a parser, 16 telemetry accessors | **any store** | yes — and only at `bench/run-ablation.ts:744` |
| `DisclosureSession` | a private store, a shared store, a card queue, a rule layer | any reader, any retrieval, any LLM | **no** |
| `CortexSessionProvider` | an in-memory `ProviderSession[]` | durability, dedupe, eviction, a cap | **no** |
| `SearchIndex` | postings, optional vectors, fusion, optional rerank | a lifetime longer than one question | built inside `#relevanceFor`, per question |

Three consequences, each mechanical:

1. **`CortexMemoryOptions` has 26 fields and not one of them is a store**
   (`packages/cortex-memory/src/types.ts`): `llm`, `readerByRoute`, `now`, `gate`, `name`,
   `maxPromptChars`, `maxPromptCharsByRoute`, `widthPlan`, `maxTurnChars`, `turnCutMarker`,
   `maxTurnCharsRoutes`, `relevanceFor`, `index`, `relevanceUnits`, `windowRadius`, `promptContract`,
   `ask`, `conflicts`, `evidenceRoles`, `evidenceRolesRoutes`, `roleOf`, `reviewPass`,
   `reviewBareDecline`, `replyRepair`, `selfConsistency`, `windowOrdering`. Every one tunes *how* a
   question is answered. Not one says *from what*.
2. **`@agentix-e/cortex-storage` is a `devDependency` of `cortex-memory`**, and the only `src` file
   that imports it is `__tests__/disclosure-session.test.ts`. A consumer who installs the product does
   not install a store, and the product never asks for one.
3. **The protocol is why.** `MemorySystem.answer(question, context[], sessions?)` receives the corpus on
   every call (`packages/cortex-core/src/protocol/memory-system.ts`). That is the right contract for a
   *measured* system — the harness must hand both arms the same evidence — and it means the product and
   the caller both hold the corpus, and the product holds the copy it cannot persist.

The manual states the consequence without naming it: §5 teaches the reader to write
`storage.put('turns', 'session-1/turn-3', { text: 'I moved to Berlin' })`, and nothing in the product
ever reads that table.

---

## 3. Persistence, item by item

"Persistence" is not one capability. It is nine, and the repository has four. The half is
`DisclosureSession`, which is careful in a way that deserves saying before the gaps are listed.

### 3.1 What is right, stated first

`TriageWriter.cross` (`packages/cortex-core/src/triage/writer.ts:349`) moves a row across the
private/shared boundary by **writing the shared copy first and deleting the private one second**, and
the failure branch does not pretend to have rolled back:

> `the shared copy of "…" was written but the private copy could not be removed (…). The row now
> exists in both stores, and a private task will read the private copy, so the promotion looks like it
> did not happen. Retry promote() once the store is writable; it converges.`

That is the only place in the repository that reasons about a partial failure of two writes, and the
reasoning is right: it picks the direction whose intermediate state is *visible* rather than
destructive, it names the compensating action, and it is idempotent because `get` finds the shared copy
on the retry. It is also not a transaction, and §3.3 says what that costs.

`Storage` itself is well designed: `put`/`get`/`del`/`query`/`transaction`/`close`, TTL, tags, prefix,
pagination, four backends. The defect is not the abstraction. It is that the product never addresses it.

### 3.2 The nine capabilities

| # | capability | status | evidence |
| --- | --- | --- | --- |
| P1 | a store the answering path can read | **absent** | `CortexMemoryOptions`, 26 fields, none a store; `cortex-storage` is a `devDependency` |
| P2 | turn ingestion with identity | **repaired in round 87** | `ingest` now holds one session per id and reports `duplicates` / `replaced` beside `sessions`; a replay no longer doubles the corpus. What is still absent is the *store* — the provider's array is its corpus, and a restart begins empty |
| P3 | a refusal report on ingest | **repaired in round 87** | `skipped` now carries `empty:<id>` for a session with no turns, and `duplicates` / `replaced` are counts rather than an empty list. The old field was the literal `[]`, which read as "all accepted" while meaning "we did not look" |
| P4 | a corpus lifetime longer than one question | **vectors: repaired in round 87. Postings: absent by design** | `#relevanceFor` still constructs a `SearchIndex` per call, but `CortexMemory` owns one `EmbeddingCacheStore` and passes it as `SearchIndexOptions.store`, so the second question embeds one text. `add` still throws after `prime`, deliberately: a vector table computed over two turns does not cover a third, and the remaining cost is CPU that nobody has measured |
| P5 | durable index state | **absent** | `SearchIndex` has no serialisation, no `restore`, no `storage` option |
| P6 | bounding memory | **absent** | `#sessions` has no cap, no TTL, no eviction; `reset()` is the only removal (`provider.ts:268`) |
| P7 | atomic multi-write | **unreachable** | `Storage.transaction` has **zero** callers outside `FederatedStorage`'s own delegation (`federated-storage.ts:188`) |
| P8 | closing what you opened | **absent** | `DisclosureSession` has no `close()`; `Storage.close` is reached only through `FederatedStorage.close`, which no product path calls |
| P9 | erasure | **absent** | `TriageWriter` calls `del` in exactly one place — the private half of a *move*. `CardQueue.dismiss` changes the card and leaves the sentence in the private table. Nothing in the product can delete a fact |

`dismiss` names the hole from the inside (`card.ts:365`):

> `card "…" is …: withdrawing a published fact is a different operation, and this one would leave the
> shared copy in place`

The different operation does not exist. A person who confirms a card onto the shared side has no way
back: `expire` sets `stale` (a retrieval filter, reversible by `refresh`), which is a *soft* withdraw and
does not remove the row from either store. For a product whose proposition is "the data did not go
there", the absence of "and it can come back" is not a roadmap omission; it is the other half of the
claim.

### 3.3 Three costs of the missing transaction

Ordering plus idempotency covers the *common* failure. It does not cover these, and each is reachable
from a public method with no test that enters it:

1. **`release()` writes the audit record before the row moves** (`writer.ts`; the `release` docstring in
   `disclosure/session.ts:236` says so deliberately — "a default here would be a door that opens
   itself"). A failed move therefore leaves a `ReleaseRecord` for an override that did not happen. The
   `fact` in the return value disambiguates, and `releases()` alone over-reports. Failing on the side of
   "the record is never lost" is right for an audit trail — but a reader of `releases()` has to know it
   is a log of *attempts*.
2. **The card state machine is read-then-write.** `accept` reads `card.state`, decides, then `put`s. Two
   concurrent `accept`s on one card both pass the guard. On SQLite that is a lost update rather than
   corruption; on PostgreSQL it is neither, and there is no test for either because there is no
   concurrent caller.
3. **`check()` and `evidence()` each scan the whole table.** See §3.4.

### 3.4 The read path does not use the storage contract

`Storage.query` offers `tags`, `keyPrefix`, `limit`, `offset`. Non-test callers in `cortex-core` +
`cortex-memory` that pass any of the four: **zero**. There is one `query(` call site in the product and
it passes `{}`:

```ts
// packages/cortex-memory/src/disclosure/session.ts:223
const privateValues = await this.federation.query(`private/${this.table}`, {});
```

`ReadSideAssembler.assemble` does the same twice (`read-side.ts:174,185`), so one `check(draft)` loads
the shared table, the private table, and then the private table again.

Worse than unreachable: **`limit` cannot bound the work even when it is passed.** `kvQuery` emits
`SELECT value, tags FROM kv WHERE table_name = ?` with no `LIMIT`, and `selectPage` slices in JavaScript
*after* the row set is materialised (`sql.ts:180`). Tags are a JSON array in one column, so SQL cannot
filter them without a join table, and the module comment argues that ordering correctly. The consequence
is not argued: `limit: 10` over a million rows reads a million rows. A caller reading the
`QueryPredicate` type would infer a bound that does not exist.

### 3.5 The PostgreSQL backend is not true

`pg.ts` is the scale-out path the architecture document names as a design principle. It is:

- **orphaned** — `PgStorage` and `ensurePgSchema` are in the census's "referenced nowhere" list, as is
  `openBrowserStorage`;
- **untested against a server** — and the original wording of this bullet, "in no suite at all", was
  **wrong**: `storage.test.ts` has a `PgStorage (pg-mem)` block with six tests over an in-memory emulator.
  What is true, and is the part that matters, is that `pg-mem` is not PostgreSQL: it implements neither
  `ROLLBACK` (a row written inside a transaction that throws survives) nor `substr(text, int, int)`, so
  the two SQL constructs this adapter would need to be *correct* cannot be exercised in this repository
  at all. A test that runs against an emulator of the engine is a test of the adapter's syntax, not of
  its semantics;
- **divergent** — `kvQuery` in `sql.ts` builds `substr(key, 1, ?) = ?`, and the module comment explains
  at length why `LIKE` is wrong (wildcards in the prefix, ASCII case folding). `idb.ts` uses
  `String.prototype.startsWith` and agrees. `pg.ts:55` uses `` key LIKE $${i} `` with `` `${prefix}%` ``
  — the exact construct the SQLite file documents as a fixed defect;
- **unreclaiming** — `pg.ts` filters `expires_at > now()` inline and never purges, where both SQLite and
  IndexedDB call `#purge` before every read.

Three backends, three prefix semantics, one documented contract. The parity suite is the thing that
would have caught it, and the parity suite does not include the backend.

**Round 87 update.** Two of the four defects are fixed and one is reclassified:

| defect | what happened |
| --- | --- |
| `LIKE` with an unescaped pattern | **fixed by removing the SQL.** `query` filters `key.startsWith(prefix)` in JavaScript, which makes `startsWith` the single definition of "prefix" across all three backends. The `substr` repair this document originally proposed is *not* what shipped: `pg-mem` cannot execute `substr`, `LIKE ... ESCAPE` does not parse there either, and PostgreSQL's `LIKE` is case-sensitive where SQLite's is not — so the escaping fix would have been correct on a server and untestable here. Filtering in JS is exact on every engine, and costs nothing the query was not already paying, because the rows are materialised for the tag filter either way |
| no purge | **fixed.** `#purge` runs the same statement the SQLite backends run before every read |
| a second tag predicate | **fixed.** `pg.ts` had its own `matchesAllTags`; it now imports `sql.ts`'s |
| orphaned | **unchanged**, and still true: no non-test consumer |

The parity gap is closed by `predicate-parity.test.ts`, which runs thirteen predicate shapes through
SQLite, the SQL tier and PostgreSQL over `pg-mem` and asserts one answer per shape. It compares key sets
for predicates without `limit`/`offset` and **row counts** for those with them, because a page of an
unordered result set is a number and not a set — a distinction the first draft of that test got wrong and
the failure message named.

### 3.6 Nothing on disk is versioned

A stored row is `JSON.stringify(value)` in one column plus a JSON tag array (`kvPutParams`,
`sql.ts:118`). There is no `schemaVersion` on the row, no version on the table, no migration hook, and
no `Storage` member that could carry one. `parseTags` throws on a malformed tag column — deliberately
and correctly, because a silently-skipped row is worse than an exception — and that decision means **one
corrupt row fails the whole table read**, since purge and select are table-wide.

`AdmittedFact` gained `stale`, `staleAt` and `releasedAt` over three rounds. Each was tolerated because
`undefined` reads as "the old behaviour": a convention, not a mechanism. The first field whose absence
cannot be read as a default will be the first schema break, and nothing in place would detect it.

---

## 4. The retrieval stack is affordable only if the deployment discovers an unwired cache

> **Round 87 update.** The cache is no longer unwired: it moved to `cortex-core` as `EmbeddingMemo`,
> `CachingEmbedding` became its adapter, and `CortexMemory` applies it to `index.embed` by default
> (`index.reuse`, `SearchCensus.embedTexts` / `memoHits` / `reuse`). The section below is the audit as
> written, kept because the *shape* of the defect — "the mechanism exists, is tested, and nothing calls
> it" — is the one that recurred three times in this repository and will recur again. The three facts
> below were each true on 2026-11-12 and each is false now.

This is the finding that corrects the obvious reading of the code, so it is stated in full.

`prime()` embeds the whole corpus in one batch, and `#relevanceFor` builds a fresh index per question,
so a deployment with `index.embed` set embeds `turns + 1` texts **per question** — on LongMemEval-S
roughly 500, or about 250,000 across a 500-question dispatch. That much is arithmetic on two lines.

The correction: **the mechanism that removes this cost already exists, is exported, is tested, and has
no caller.**

| fact | evidence |
| --- | --- |
| `CachingEmbedding` is a text-keyed decorator over `EmbeddingModel`, designed for exactly this | `packages/cortex-ai/src/embedding/cache.ts`, 283 lines; its design argument is `cortex-docs` §22.92 |
| it is exported from the package root, with an extension point for a durable store | `cortex-ai/src/index.ts:78`; `EmbeddingCacheStore` has `get`/`set`/`size` and is deliberately not enumerable |
| it is 100% covered with 23 assertions | `cortex-ai/src/__tests__/embedding-cache.test.ts` |
| **no product path uses it** | the census lists `CachingEmbedding` under "no non-test reference in the workspace" |
| **the product cannot use it** | `cortex-memory` depends on `cortex-core` only at runtime; `cortex-ai` is a devDependency, and `ARCHITECTURE.md`'s Design Principles say the composition depends on no concrete engine |
| **the manual never mentions it** | §4.2 shows `new OpenAIEmbedding({...})` and hands it to the reader un-wrapped; §4.3 then teaches cost observation |

There is one more step between the two, and it is a signature rather than a decision:
`EmbeddingModel.embed` takes `texts: string[]` (`core/interfaces/embedding.ts`), while
`SearchIndexOptions.embed` takes `texts: readonly string[]`. A `readonly` array is not assignable to a
mutable parameter, so `index: { embed: model.embed }` does **not** typecheck and every caller has to
write an adapter lambda. Small, mechanical, and exactly the kind of friction that ends with the cache
being left off.

So the defect is not "the product has no cache". It is that **"a text is embedded once" is a property of
the deployment's diligence rather than of the product**, and the one field that would show the difference
cannot show it: `embedCalls` counts batches, so a run that embedded 501 texts and a run that embedded 2
both report `2` per question.

That is the same disease `rerankCalls`/`rerankDegraded` was created to cure — a count that cannot
separate "ran and agreed" from "ran and failed" is not a reading — arriving with a different cause and
needing the same shape of fix: a text count beside the call count.

Two things follow for the pending `cortex/self-index` dispatch, and they are the reason it must not run
before §6's P0:

1. A dispatch taken now prices the rebuild, and the rebuild's dominant term is a cache that is one
   `import` away. The reading would be a verdict on the deployment, not on the retrieval stack.
2. Accuracy and cost would move together in the artifact with nothing recording which of the two
   produced the movement.

---

## 5. The knowledge model has no writer

Four fact types exist and exactly one is produced by a shipping path. This is the deepest finding, and
it explains the capability profile rather than merely describing it.

| type | file | time axes | slot (subject/predicate) | rendered text | producers |
| --- | --- | --- | --- | --- | --- |
| `Fact` | `domain/fact.ts` | **two** (`validFrom/Until`, `systemFrom/Until`) | yes | **no** | **0** |
| `AdmittedFact` | `triage/writer.ts:70` | **none** | **no** | `text` | `TriageWriter.admit` |
| `KnowledgeFact` | `knowledge/frame.ts:65` | optional `at`, `futurity`, `planState` | optional | `text` | **0** |
| `ServedFact` | `context/assemble.ts:126` | inherited | inherited | yes | `assemble` (eval arm only) |

The row that is actually written, lifecycle-managed and read back is `AdmittedFact`: `id`, `text`,
`visibility`, `triage`, `admittedAt`, and three lifecycle marks. **No time axis and no slot.** It is a
sentence with a privacy verdict.

Two consequences, and neither is an opinion:

1. **A temporal or knowledge-update question cannot be answered structurally.** The persisted memory
   records neither *when* a sentence was true nor *what slot* it fills, so the only instrument left is
   prompt wording — which is exactly what `answerKnowledgeUpdate` is: a contract that, in its own
   docstring's words, "makes explicit" which value a time qualifier selects. The capability is delivered
   by instructions over undifferentiated text, and that is why the per-capability table keeps showing
   `KU`/`TR` as the weak rows.
2. **The nine modules that model it are a library over a type nothing constructs.** `frame`, `edge`,
   `unit`, `taxonomy`, `assumption`, `temporality`, `markers`, `revision` are imported **type-only** by
   `retrieval/typed.ts` and `context/assemble.ts`, and `assemble`'s only caller is the eval arm's
   `assumption-ablation.ts:680`. `consolidate`, `resolveContradiction`, `currentFacts`, `currentValue`,
   `findContradictions`, `covers`, `isAnswerable` and `defaultValueFunction` have **no non-test reference
   anywhere in the workspace** — and for `resolveContradiction` and `consolidate` the reason is
   structural rather than a scheduling failure: their input type has no producer, so wiring them would
   require first deciding what a stored fact *is*.

`cortex-memory`'s barrel says the package "exists because `decideWrite`, `decideRetrieval`,
`consolidate` and `resolveContradiction` had zero production callers". Two of the four now have callers:
`decideWrite` at `admission.ts:294`, `decideRetrieval` in `answerAbstention`. The other two still have
none.

---

## 6. The ordered plan

Ordered by what unblocks what. Each item states the criterion that would let a reviewer reject the work.

**Delivery state, round 87.** Read the rest of this section as the plan it was; this table is what the
plan became. Two items moved for reasons that are in §10.

| item | state | where it is checked |
| --- | --- | --- |
| P0-1 embedding reuse reachable | **done** | `Acceptance C5`, `C6`; `tools/embedding-reuse-census.mjs`; `index-reuse.test.ts` (6 assertions, 3 of which fail when the store is disconnected) |
| P1-1 erasure (`forget`) | **not started**, and now the largest product gap | §3.2 P9 — the missing operation `card.ts` names from the inside |
| P1-2 ingest identity + a true refusal report | **done** | `provider.test.ts` (5 new assertions); `CortexSessionProvider.ingest` |
| P1-3 PostgreSQL true or absent | **partly done** | prefix semantics and purging fixed and covered by `predicate-parity.test.ts`; "absent" was rejected, and the server-verification half cannot be closed in this repository |
| P2-1 → P3 | untouched | — |

### P0 — one item, because every other item is priced against it

**P0-1 · "A text is embedded once" becomes a property of the product.**

Three candidate shapes, and the trade-off is the whole decision:

| shape | what it costs | verdict |
| --- | --- | --- |
| **A.** document the wrapper; leave the decision to the deployment | nothing now | rejected for the repo's own reason: a rule that is only written down has already been broken once, and the artifact would not record whether the rule was followed |
| **B.** `cortex-memory` depends on `cortex-ai` and constructs `CachingEmbedding` | one dependency edge | rejected: it makes the composition depend on a concrete engine, which `ARCHITECTURE.md`'s Design Principles state as a principle, and it drags an HTTP client into every browser build of the memory layer |
| **C.** the decorator moves to `cortex-core`, `cortex-ai` re-exports it, `CortexMemory` wraps `index.embed` by default | a move, a re-export, one option | **recommended** — the precedent is `3bc00f5`, where the protocol types moved to the base because both sides needed them. Here both sides need one implementation of "embed once", and two implementations would drift into two arms that differ by a cache |

Shape C's details, each of which is a decision rather than a mechanic:

- `core/cache/embedding-cache.ts` keeps the three safety properties `§22.92.2` already argues — copy on
  store and copy on read, `identity()` forwarded by construction, order preserved — **moved, not
  rewritten**.
- `CortexMemoryOptions.index.reuse?: boolean`, **default `true`**. A cache is only safe against a
  deterministic embedder; a model that jitters per call would have two questions share a vector they
  would not otherwise share. So the option exists, and `SearchCensus` gains `reuse: boolean` and
  `memoHits: number` so a run **states** which configuration produced it. An arm that omits the field
  cannot be compared with one that set it.
- `SearchCensus.embedCalls` gains a sibling `embedTexts`. Without it the acceptance below is
  unverifiable: the artifact cannot tell 501 from 2.
- `SearchIndexOptions.embed` accepts a signature `EmbeddingModel` satisfies, so the cache can be passed
  as `embed: model.embed` rather than through an adapter lambda at every call site. The change is one
  parameter modifier; the reason it belongs in P0 is that the friction above is one of the two ways a
  cache does not get used.

Acceptance:

| # | criterion | check |
| --- | --- | --- |
| 1 | byte-identical prompt and answer with `reuse` on and off, on every fixture in `__tests__/prompt.test.ts` | each fixture run twice, comparing `lastPromptText()` |
| 2 | `embedTexts` is `turns + 1` on the first question of a corpus and **1** on the second | `lastIndexCensus()` after two questions over one corpus |
| 3 | a memo hit returns the **same values**, not equal ones | a test that mutates the returned vector and asserts the cache is unaffected |
| 4 | `reuse: false` reproduces today's counts exactly | census equality against a recorded fixture |
| 5 | 100% line/branch on the moved file and on the new branch | `tools/coverage-per-file.mjs`; no `v8 ignore` |

### P1 — three that a user can hit in a week

**P1-1 · erasure.** `DisclosureSession.forget(id, { acknowledge })`: delete from both stores, write an
`ErasureRecord` to the private store, return it. `CardQueue` gains a `forgotten` terminal state.
Criterion: after `forget`, `cards()`, `evidence()` and `check()` see nothing; a second `forget` is a
no-op returning the record; the record survives a reopen; `dismiss` on a forgotten card throws.

**P1-2 · `ProviderIngestReport.skipped` becomes true or disappears.** Three refusals are worth reporting
and each is already representable: a session with no turns, a session whose `id` repeats an ingested one
(dedupe — today it silently doubles the corpus), and a turn over the admission width. Criterion:
ingesting the same fixture twice reports `sessions: n`, never `2n`.

**P1-3 · PostgreSQL: true, or gone.** Three small changes: `substr` in place of `LIKE`; a purge on read;
and membership in `parity.test.ts` against a real server. If a server cannot join the check, then the
architecture document's "PostgreSQL is the scale-out path" sentence is the thing that must change, not
the test. Deleting the backend is the third option and the worst: it is the only published claim about
scale.

### P2 — the composition, which is the actual product question

**P2-1 · bridge `AdmittedFact` to `KnowledgeFact`.** This is what would make `KU` and `TR` structural
rather than rhetorical. It is P2 rather than P0 for an honest reason: it needs an extraction step (a
model, or a rule table over `markers.ts`) and nothing has priced what that costs per turn. Prerequisites
in order:

1. a frame for a sentence — `knowledge/frame.ts` already has `checkFact` and `covers`;
2. a producer for `span`/`references` — `locate` exists with no caller;
3. a decision on write-time versus read-time extraction (cost per turn, always, versus cost per
   question, sometimes);
4. the ablation that says whether any of it moves `KU`, with the endpoint floor of 17 questions as the
   bar (`tools/quantify-endpoint-noise.mjs`).

**P2-2 · `close()` on `DisclosureSession`, and `transaction()` on the two paths that need it.** `cross`
is correct without one and should keep its ordering; `release` is not, and the difference is that
`release` writes a record *then* moves a row where `cross` writes a row then deletes one.

**P2-3 · a schema version on the stored row.** One field, read and refused rather than guessed. Cheap
now, and it is the difference between a migration and a data loss later.

### P3 — three that get cheaper the later they land

| item | why not earlier |
| --- | --- |
| index lifetime across questions (postings reuse, persisted vectors) | after P0 the remaining cost is CPU, not model calls, and nobody has measured whether that CPU is a problem. `SearchIndex.add` throwing after `prime` deliberately forbids extension, so changing it is a redesign, not a fix |
| read-side pushdown (`tags`/`keyPrefix`, and a `LIMIT` that bounds the work) | needs a measured table size before a predicate is worth designing; nothing in the repository has ever read more than a fixture |
| an aggregate telemetry type | the 16 accessors are single-slot and correct for one call; a run-level reading is currently re-derived in `cortex-eval`, which is the right place until a second consumer exists |

---

## 7. What is *not* a gap

Listed because the next reader will otherwise re-open them:

- **The product does not own the judge.** Correct: a system that grades itself is not being measured
  (`AUDIT-SEMANTIC-REACH.md` §9).
- **The product does not own rerank, but the mechanism is in `cortex-core`.** `rerankHits` is a pure
  function with a pluggable score function, and the product calls it through `SearchIndexOptions.rerank`.
  A product that shipped a cross-encoder would be choosing a model, which this package does nowhere.
- **`assemble` is not on the shipping path.** It is on the *measured* path through the arm, and its
  absence from `CortexMemory` is the same boundary as the two above: it needs a `KnowledgeFact`, and §5
  is why there is none.
- **`threshold: 0` in the published arm.** Not a disabled gate: `provider.ts`'s comment records that
  folding the write gate into a retrieval number makes a low score ambiguous between "the gate dropped
  it" and "the budget dropped it". Measuring one at a time is the point.
- **`#sessions.push` is safe under concurrency** — but only because `search` contains no `await` between
  reading the array and mapping over it. That is luck with a comment rather than a mechanism, and it is
  the reason P1-2's dedupe must not introduce an `await` into that path without re-checking.

---

## 8. Documentation drift found in the same pass

Four claims in the published surface were false at `dd216c5`, corrected in the same commit as this
document so the repairs are traceable:

| claim | where | why it was false |
| --- | --- | --- |
| "the product may import `cortex-eval` for _types only_" | `ARCHITECTURE.md` §2 | `cortex-memory` imports `cortex-eval` **nowhere** in `src`; the edge was removed in `3bc00f5` |
| `MemorySystem` is owned by `cortex-eval` | `ARCHITECTURE.md` §3 | moved to `cortex-core/src/protocol/memory-system.ts`; `cortex-eval` re-exports it |
| `cortex-eval` "cannot import the product" | `ARCHITECTURE.md` §2 | true, and stronger than stated: it does not declare even a `devDependency` on it |
| "Three ordering facts are load-bearing" | `ARCHITECTURE.md` §4.2 | four bullets follow |

And one absence worth calling a defect rather than drift: **`DisclosureSession` appeared in
`USER-MANUAL.md` zero times.** The only part of this product that persists anything was undocumented on
the page that claims to document every option. It now has §6.4.

---

## 9. What is left unverified, and what would verify it

An audit that lists only what it established is a list pretending to be a proof.

| thing | why it is unresolved | what would settle it |
| --- | --- | --- |
| the CPU cost of rebuilding postings per question | no dispatch has run with `index` set at all | one `cortex/self-index` dispatch with `reuse` both ways, reading wall-clock beside accuracy |
| whether `reuse: true` changes accuracy on a real embedder | it should not by construction, and "should not" is the class of claim this repository has been wrong about three times | P0 acceptance criterion 1, on a real model, with the delta recorded even when it is zero |
| the volume at which `limit` needs to bound work | nothing has stored more than a few thousand rows; §3.4's concern is analytic | a fixture at 10^5 rows, timed |
| whether `KnowledgeFact` extraction is affordable | unmeasured | a ceiling harness at the write side, in the shape `bench/measure-spec-ceiling.ts` already uses for the plan layer |
| whether `PgStorage` is worth a service container in CI | a policy question, not a measurement | the decision recorded in §6 P1-3, whichever direction it goes |

The pattern the last twelve rounds established holds here too: **the absence of a capability is a fact
about the code; the size of the absence is not knowable until something is dispatched.**

---

## 10. Round 87: what landed, and the two claims this audit got wrong

The audit was written from the code on 2026-11-12 and the repairs were made on the 13th. Two of its own
claims did not survive contact with the tests, and both are recorded here rather than quietly edited,
because an audit that only revises itself upward is a press release.

### 10.1 Two corrections to this document

**`PgStorage` was not untested.** `storage.test.ts` has six tests over `pg-mem`, including pagination
and a transaction that throws. The accurate statement — now in §3.5 — is that no suite exercises it
against a *server*, that `pg-mem` implements neither `ROLLBACK` nor `substr`, and that the parity suite
it was missing is the thing that would have caught the prefix divergence. The distinction matters
because "untested" is a claim somebody can refute in thirty seconds with `grep`, and one wrong line in a
document makes the reader discount the other forty.

**The proposed `substr` repair was not implementable.** §3.5 said "`substr` replaces `LIKE`". Measured:
`pg-mem` raises `function substr(text,integer,integer) does not exist`; `LIKE ... ESCAPE '\'` fails to
parse; `left`, `starts_with`, `position` and `chr` are all absent; and `pg-mem`'s `LIKE` does not honour
backslash as a default escape, so an escaped pattern would match *nothing* there while working on a
server. Three candidate repairs, none of which could be verified in this repository. The one that
shipped moves the filter into JavaScript, where the definition is `startsWith` — the same word `idb.ts`
already used — and where it is exact on every engine.

### 10.2 What shipped, and the assertion that makes each one a mechanism

| change | the assertion that would fail if it were reverted |
| --- | --- |
| `EmbeddingMemo` in `cortex-core`; `CachingEmbedding` is its adapter; `cortex-ai` re-exports | `embedding-cache.test.ts` (28 assertions, moved with the implementation and extended with five for the bare-function surface) |
| `index.store` + `index.reuse` (default `true`) + a per-instance store | `index-reuse.test.ts` — and its first assertion is the one that decides whether the change is allowed at all: **prompts and answers byte-identical with the store and without it** |
| `SearchCensus.embedTexts` / `memoHits` / `reuse` | the same file asserts `5 / 0` on question one and `1 / 4` on question two; `embedCalls` now counts batches **that reached the model**, so a fully cached question reports `1` rather than `2` |
| `index.embed` widened to `string[]`, vectors typed `ArrayLike<number>` | `EmbeddingModel.embed` is assignable without an adapter lambda; the memo test asserts a `number[]` and a `Float64Array` reply are both accepted |
| `CortexSessionProvider.ingest` de-duplicates by id | `provider.test.ts` — a replayed corpus reports `sessions: 3, duplicates: 3`, never `6` |
| `PgStorage` prefix in JS, `#purge`, shared `matchesAllTags` | `predicate-parity.test.ts` — 13 predicate shapes × 3 backends, plus a "removes expired rows" case asserted through a prefix query rather than through `get` |

Three mutations were run against the new tests rather than trusting them to be sincere:

1. Disconnect the store in `CortexMemory`: **3 of 6** reuse assertions fail. The byte-identity test
   still passes — which is the point, since it is the test that must *not* depend on the mechanism
   being present.
2. Change `startsWith(prefix)` to `startsWith(prefix.replace('%','x'))`: `predicate-parity` fails with
   `prefix that is a LIKE pattern diverged at postgres(pg-mem): expected ['axb'] to deeply equal ['a%b']`.
3. Revert `ingest` to `push(...sessions)`: the duplicate test reports `6` sessions against `3`.

What is *not* established by any of this is a score. The product table did not move, because none of
these changes touches a reader, a prompt's content, or a ranking — they touch what the run pays and
what the store says about itself. A round whose deltas are all zero is exactly the round a cost fix
should produce, and the acceptance criteria `C5`/`C6` are where that zero is enforced instead of
asserted.

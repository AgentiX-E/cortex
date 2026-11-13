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

**Round 88 correction, and it is the more serious of the two.** The paragraph above ends with a sentence
that is false: *"the escaping fix would have been correct on a server and untestable here."* It is
correct on a server, and it is testable here — `apt-get install postgresql` takes 25 seconds and the
server starts in two. What was true is narrower: `pg-mem` does not implement `LIKE ... ESCAPE`. The
difference between those two sentences is the difference between a limitation of a test double and a
property of PostgreSQL, and the first was written in the voice of the second. See §11.

The parity suite's *name* is also larger than its coverage, which is how three defects survived a file
called `predicate-parity`: it compares `query` and nothing else. `get`, `transaction` and `close` had no
cross-backend assertion anywhere, and all three of the defects found in round 88 were in those methods.

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
| whether `PgStorage` is worth a service container in CI | **answered in round 88: yes.** It is not a policy question once the suite exists — installing PostgreSQL took 25 seconds, and the first run found three defects that no emulator could have | §11 |

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

---

## 11. Round 88: the suite that was named but did not exist

This round did not add a capability. It removed a false statement, and the removal is worth more than
the three defects it uncovered — because the statement is what kept them uncovered.

### 11.1 Three sentences, and what each one actually said

| where | what it said | what was true |
| --- | --- | --- |
| `src/storage/pg.ts`, `query` | "the escaping that would fix both (`LIKE ... ESCAPE`) is implemented by neither `pg-mem` nor any engine this repository can run in a test" | PostgreSQL 16 implements `LIKE ... ESCAPE`; so does SQLite. Only `pg-mem` does not. `apt-get install postgresql` took **25 seconds** on the machine this audit was written on, and the server answered `select version()` two seconds later |
| `src/__tests__/storage.test.ts:218` | "the rollback's effect on stored data is asserted against a real PostgreSQL instance in the integration suite" | `grep -rn 'integration suite' .` returned that line and nothing else. There was no suite |
| `predicate-parity.test.ts` (the name) | parity across three backends | parity of `query` across three backends. `get`, `transaction` and `close` had no cross-backend assertion, and all three round-88 defects were in those methods |

The first sentence is the one that matters, because of what it was used for. It is not a note beside a
decision; it *was* the decision. Having established that no runnable engine supported `ESCAPE`, the file
moved the prefix filter into JavaScript, wrote "the cost, stated: no index range scan", and moved on. The
cost is real — a predicate query on `cortex_kv` is a sequential scan of its own table on every backend —
and it was paid to keep a filter correct on an engine that is not the one the code ships against.

The third is subtler and is the reason this audit exists at all: a file named after a property is read as
asserting that property. Nobody re-derives a test file's coverage from its name, so "parity" in the
filename did the work that the missing assertions would have had to do.

### 11.2 What the first real run found

The suite was written before the adapter was touched, and run against PostgreSQL 16.15 through a real
`pg.Pool`. **26 of 30 passed.** The four failures, in the order they matter:

1. **`transaction.get` read an expired row.** `SqlStorage.#get` calls `#purge(table)` before reading;
   `PgStorage.makeTx`'s `get` issued a bare `SELECT value ... WHERE table_name = $1 AND key = $2` with no
   `expires_at` condition and no purge. Every expiry-bearing read the memory layer performs inside
   `transaction()` returned a row the same store hides outside one.
2. **`put` left its table's dead rows.** `SqlStorage.#put` purges after writing; `PgStorage.put` did not.
   A table written to and never queried accumulated expired rows indefinitely — a leak no assertion about
   returned values can observe.
3. **`close()` raised the driver's message.** `Cannot use a pool after calling end on the pool` instead
   of `StorageClosedError`. A caller that caught the documented type worked on SQLite and crashed on
   PostgreSQL, with the same interface in both hands.
4. **This suite's own assumption was wrong.** It asserted `JSONB` preserves insertion order. It sorts
   object keys. Recorded rather than asserted now, because it is a property of the column type: a caller
   that hashes a serialised payload gets one digest on SQLite and another on PostgreSQL.

Items 1–3 are fixed. Item 4 is documented at the test and in `pg.ts`.

### 11.3 What shipped

| # | change | the assertion that fails if it is reverted |
| --- | --- | --- |
| D1 | `test/pg/integration.test.ts` — 31 assertions against a real server, skipping when `CORTEX_PG_URL` is unset | `pnpm test:pg` |
| D2 | `vitest.pg.config.ts` + `test:pg`, and `test/pg/**` excluded from the unit config | `pnpm test` reports 8 files, never a skipped ninth |
| D3 | `verify.yml` `postgres` job: `postgres:16` service with `--health-cmd`, `CORTEX_PG_URL`, build, suite, count check | `tools/ci-gate-audit.py` (8 requirements, below) |
| D4 | `tools/pg-integration-count.mjs` — refuses 0 tests, any skip, any count below the floor | `test_pg_integration_count.py` (10 assertions), including "the floor equals the number of `it(` blocks in the suite" |
| D5 | `tools/ci-gate-audit.py` — parses the workflow and fails when a gate loses its attachment | `test_ci_gate_audit.py` (15 assertions), one per requirement, each asserted to fail on its own removal |
| D6 | `src/storage/errors.ts` — `StorageClosedError` and `TransactionOpenError` leave `sql-storage.ts` so both backends raise the same class; `./pg` re-exports it | the parity case that closes and then reads |
| D7 | `tx.get` and both `put` paths purge; `close()` is idempotent and refuses use | three mutations, below |
| D8 | `tsconfig.test.json`, and `typecheck` now covers the integration suite | it caught `minWorkers` in `vitest.pg.config.ts` on its first run — a config key vitest 5 had removed, printed as a deprecation that nothing was reading |

### 11.4 The mutations, including the one that did not take

Four edits, each applied to `pg.ts` by text and occurrence, then reverted:

| mutation | line | result |
| --- | --- | --- |
| `put` stops purging its table | 97 | **red**, 1 failed |
| the write inside a transaction stops purging | 223 | **red**, 1 failed |
| `transaction.get` stops purging | 230 | **red**, 1 failed |
| `close()` stops refusing use | 212 | **red**, 1 failed |

The third row is green the first time it was run, and that is the finding. The original test wrote a row
with `ttlMs: -1` through `put` and then read it inside a transaction — but `put` had just been repaired
to purge, so the row was already gone and the assertion held whether or not `tx.get` purged. **One
commit, two repairs, one test, and the test was watching the other repair.** The fix is in the test: the
row is now inserted directly with `now() - interval '1 second'`, which is the only way to produce a row
that is expired *and present* when the assertion starts. The same change was made to the `put` case, and
a fourth assertion was added for the transactional write, whose `INSERT` is a separate statement with its
own missing purge.

A mutation that does not turn the suite red is indistinguishable from a suite that is passing on merit.
That is why each one is applied by locating its text and printing the line number it landed on.

### 11.5 One defect found, priced, and not fixed

`PgStorage.transaction` does not handle a `ROLLBACK` that itself fails: the body's error is replaced by
the rollback's, and the connection goes back into the pool in a state the adapter cannot describe
(`SqlStorage` raises an `AggregateError` here and `pg` destroys a client released with an error).

The repair is four lines. It is not in the code, and the reason is the round's own subject: **no engine
this repository runs will produce the failure.** `pg-mem` implements `BEGIN`/`COMMIT`/`ROLLBACK` as
no-ops that never fail, and measured directly: after `pool.end()` mid-transaction, `client.query('ROLLBACK')`
still resolves. Writing the branch anyway put six unreachable statements into a file the coverage gate
holds at 95%, and `pg.ts` fell to **93.3 / 92.3 / 94.7**. The first instinct was to exempt the file, widen
the floor, or annotate the lines — which is what an audit that has spent twelve rounds deleting `v8
ignore` comments should recognise as the reflex it is. The branch was deleted instead.

What would make it assertable: run the integration suite **with coverage** and merge its report with the
unit report before the coverage gate reads it. That is a tool (`tools/coverage-merge.mjs`), a second
`coverage-final.json` and a merge rule for two instruments over one file — priced, not started, and
listed as P1-3 below.

### 11.6 What is actually left, ordered by what it would change

The list is shorter than the round before it, and every item now has an instrument rather than an
argument.

| # | item | why it is next | how it is verified |
| --- | --- | --- | --- |
| P0-1 | **Verifiable erasure** | **shipped in round 89** — see §12. The row is kept here rather than deleted because the paragraph beside it is the reason it took two rounds: it was the only row with a product claim, external evidence and no code | §12: `C7` / `C8`, `tools/erasure-census.mjs`, 21 unit assertions, 5 mutations |
| P0-2 | **`index` dispatch** (`cortex/self-index`) | the only way to price the per-question postings rebuild; the census now counts `embedTexts`/`memoHits` so the readback exists | one dispatch, three readings: paired accuracy delta, total `embedTexts`, `memoHits` |
| P1-1 | **`trim-2.8k` into registration** | `C1` is 11.7K tokens/question; the arm already measured 5,183 | `C1` recomputed at ≤ 5.2K with the same accuracy, and a `docs-crosscheck` that fails if the registered number drifts |
| P1-2 | **`predicate-parity` grows into `backend-parity`** | the name over-promised and three defects lived in the gap. `get`, `del`, `close`, `transaction` and TTL are still uncompared across backends | one file, every `Storage` method, three backends, one answer per method |
| P1-3 | **Coverage merge for the integration suite** | the priced path to asserting the `ROLLBACK`-failure case, and the only way a database-backed branch can ever count | `coverage:gate` reads a merged report; a mutation removes the `AggregateError` branch and the gate goes red |
| P2-1 | **Prefix filter back into SQL on PostgreSQL** | the JS filter is a sequential scan per predicate query, chosen for a test double that no longer decides anything. `LIKE ... ESCAPE '\'` against `(table_name, key text_pattern_ops)` is the indexable form | `EXPLAIN` shows an index range scan on the real server; `backend-parity` still returns one answer per shape |
| P2-2 | **`JSONB` versus `TEXT` for `kv.value`** | `JSONB` re-renders numbers, sorts keys and drops duplicate keys, so a payload hash differs by backend | a parity assertion on the serialised form, or a type change with a migration |
| P2-3 | **Row-level `Storage` contract** | the interface still does not say whether `get` hides expired rows, whether `query` orders, or what `close()` does to a later call. Three of the four round-88 defects are consequences of that silence | the interface documents each method's observable behaviour, and `backend-parity` asserts it |
| P3-1 | **`pg-mem` removal** | with a real server in CI the emulator's only remaining job is speed in the unit loop. Keeping it is defensible; keeping it *instead of* the server is what produced this round | the unit suite's `pg-mem` block is either justified in one sentence per test or deleted |

Two of these are the same defect seen twice. P1-2 and P2-3 are both consequences of a `Storage` interface
with no stated semantics: an interface that says nothing about expiry or ordering cannot be implemented
consistently by four backends, and cannot be tested for consistency either, because there is nothing to
compare against. That is the structural item under the three that were found.

---

## 12. Round 89: erasure, and the four copies a delete does not reach

Round 87 and round 88 both ended with the same row at the top of the list: erasure was the one
capability with a product claim, published external evidence, and no code. It is implemented now, and
the interesting part is not the deletion. It is the count of things that had to be deleted.

### 12.1 The measurement that turned a `del` into a protocol

Two papers published three weeks apart settled the design before a line was written.

| paper | reading | what it forces |
| --- | --- | --- |
| AfterDeleteBench, `arXiv:2610.31366` | delete the source record, then ask the agent: a single query recovers the secret in **0.680** of in-distribution cases and **0.640** held-out, against **0 of 200** for a matched never-exposed control. Remove the complete literal from every model-visible state and exact reconstruction still succeeds in **0.615–0.990** of cases, because the parts survive | the unit of deletion is not the row. It is every object traced to the row |
| the same paper, on defences | **provenance-aware closure** — retire the source *and its recorded descendants* — eliminated recovery in every tested cell. An exact-literal write filter, "the control most products actually ship", blocks reinsertion and does nothing to what is already stored | closure has to be a property of the schema, not a filter on writes |
| MemCut, `arXiv:2610.21405` | 456 annotated secrets; LLM-guided deletion of ten extra turns from twenty candidates still leaves **39–76%** residual recovery, and the bottleneck is *candidate coverage* | a deletion path that has to *find* the copies will miss some. The copies have to be known |

That last line is where this codebase has an advantage worth naming precisely: AfterDeleteBench has to
**infer** which summaries descend from a deleted record, because their summaries are model output. Here
the descendants are **recorded**, because the only code that writes them is five files. So closure is
arithmetic — enumerate the fields, clear them, and then prove it by reading every row.

### 12.2 The four copies, and the fifth table that must stay empty

`grep` for the sentence is what answered this, not a design document:

| # | surface | what holds the sentence | how it got there |
| --- | --- | --- | --- |
| 1 | `private/facts`, `shared/facts` | `AdmittedFact.text` | `admit()` |
| 2 | `private/cards` | `text`, `sourceText`, `proposal.facts[].text`, **`origin.turns[]`** | `open()`, `attach()` |
| 3 | `private/releases` | `text` **and `digest`** | `release()` |
| 4 | `private/erasures` | nothing, by construction | this round |
| 5 | every SQLite page the row ever touched | the bytes | the engine, not the store |

`origin.turns[]` is the one a "keep the metadata" tombstone would keep: those are the user's
surrounding sentences, which is exactly the reconstruction channel AfterDeleteBench measures. A card
that dropped `text` and kept `origin` would pass every field-by-field assertion and fail the question.

Row 3 is a genuine conflict rather than an oversight. `ReleaseRecord` keeps the wording *on purpose* —
"kept so the record is readable, not just verifiable" — so an erasure that respects the audit trail
leaves a copy, and one that deletes the record erases the fact that a rule was overridden. The
resolution is a union: the record keeps `id`, `rule`, `policy`, `releasedAt`, `completedAt` and the
token, and its wording arm becomes `{ text: null, digestAlgorithm: null, digest: null, redactedAt }`.
A release is audited by *what* crossed; an erasure must not keep it. Both are true, and the type now
says so — three nullable fields would have been three ways for the record to disagree with itself.

**No digest on the erasure record.** `ReleaseRecord.digest` exists to prove what was released; an
erasure record must not keep one, because a SHA-256 of a secret drawn from a small, guessable space is
an offline oracle rather than a redaction. `reason` is a three-value union for the same reason at the
type level: `reason: "user asked about Falcon"` is a sentence a caller writes in good faith.

### 12.3 What the first run found

Four things, and the fourth is the round's methodological finding.

1. **`evidence()`'s argument is a scope, not a request object.** My first session test called
   `evidence({ task: 'shared' })` and got `ScopeViolation: unknown task scope {"task":"shared"}`. The
   assembler was right; the test was reading its own signature. Recorded because the error message is
   the only reason this took ten seconds instead of an hour.
2. **SQLite's default keeps deleted content in the file.** With `secure_delete` off — the default in
   both journal modes, measured — a 1.6 kB sentence erased through the product was still findable
   verbatim in `private.db` after the row was gone. Every row-level assertion passed. `SqliteStorage`
   now sets `secure_delete = ON`, and `disclosure-erasure.test.ts` reads the **file**, not the rows.
3. **The release door does not close by itself.** After an erasure, a completed `ReleaseRecord` still
   exists (that is the audit), so `release()` on the same id found its own record and then found no
   row: it threw `no private fact with id` — correct, and only because `cross()` looks for the shared
   copy before throwing. Now asserted rather than assumed.
4. **A mutation that edits a compiled dependency is not a mutation.** Removing `secure_delete = ON`
   from `sqlite.ts` and re-running `vitest` was **green**: `cortex-memory` imports
   `@agentix-e/cortex-storage/sqlite` from `dist`, so the test measured the previous build. The
   mutation script now builds the package before each run, and the mutation goes red. This is round
   88's lesson one level down: last round the mutation silently did not apply to the *text*; this
   round it applied to the text and not to the *artifact*.

### 12.4 What shipped

| # | change | the assertion that fails if it is reverted |
| --- | --- | --- |
| D1 | `CardQueue.forget(id, { acknowledge, reason })` — plan, token, record-open, delete, tombstone, redact, record-close | 21 assertions in `erasure.test.ts`; 5 mutations below |
| D2 | `CardState` gains `forgotten`; the tombstone drops `text`, `sourceText`, `proposal`, `origin`, `refused`, `decayAt` and keeps `id`, `state`, `reason`, `rule`, `createdAt`, `decidedAt`, `updatedAt` | `card.ts`'s `Record<CardState, number>` was a compile error until the export counted the new state — the type found the export |
| D3 | `TriageWriter.eraseRows` deletes both stores and redacts the release record; counts, never throws, so a retry converges | `removed: { facts: 2 }` case, built from the documented partial-promotion state |
| D4 | `ErasureLog` owns `private/erasures`: `begin` / `complete` / `read` / `list`. `admit()` refuses a burned id, for an explicit id only | the id-reuse test; the retry test preserves `requestedAt` from the first attempt |
| D5 | `ERASURE_TOKEN = 'erase-permanently'`, `ERASURE_REASONS` (3), `erasureSurfaces(table)` with roles, `erasureWarning(id, found)` built from the plan | the refusal message asserts `fact rows: 2` for the both-stores case |
| D6 | `SqliteStorage` sets `secure_delete = ON` | the file-bytes test, which reads `private.db` rather than `query()` |
| D7 | `tools/erasure-census.mjs` + `C7` / `C8`, with a fault injector the test drives | `test_erasure_census.py` (5 assertions), one of which runs the tool with one erasure skipped and requires exit 1 |
| D8 | `tools/triage-demo.mjs` gains `forget` and `erasures`, and prints `(erased: ...)` instead of an empty `text:` | the demo run in §12.6 |

`erasure-surface.test.ts` — inside `erasure.test.ts` — reads the disclosure layer's own sources and
fails if any of them spells a `private/<table>` path by hand. The residual assertions are only as
complete as the surface list, and a hand-spelled fifth table would be invisible to every one of them.

### 12.5 Five mutations, all red

| mutation | line | result |
| --- | --- | --- |
| the tombstone stops being written | `card.ts:519` | **red**, 6 failed |
| the release record keeps its wording | `writer.ts:398` | **red**, 2 failed |
| the burned id can be reused | `writer.ts:183` | **red**, 1 failed |
| sqlite goes back to leaving freed pages intact | `sqlite.ts:44` | **red**, 1 failed |
| the erasure forgets the shared copy | `writer.ts:389` | **red**, 6 failed |

The fourth was green until the script started rebuilding the storage package first. That is the whole
reason a mutation is applied by locating its text, printing the line it landed on, and rebuilding:
**an unapplied mutation and a suite passing on merit are indistinguishable from the outside.**

### 12.6 The reading

`node tools/erasure-census.mjs`:

```
erasure census ok -- 5 occurrence(s) and 4 read path(s) before, 0 and 0 after;
4 row(s) removed by 1 tombstone and 2 record(s)
```

`5` before is the control, taken with the same function that reads afterwards: two occurrences in the
card (the claim and the turn it came from), one in each store's facts table, one in the release
record. `0` after, across all five surfaces including the erasure record itself.

The CLI, end to end:

```
$ node tools/triage-demo.mjs say "Falcon is the code name for the Helix Bio acquisition." --home /tmp/h --id f1
f1  stored private  (rule: none, deferred)
f1  proposed  No rule recognised this sentence, so it is stored privately. ...
$ node tools/triage-demo.mjs forget f1 --home /tmp/h
erasing "f1" is permanent, and it removes every copy this store holds:
  fact rows:        1
  card rows:        1 (the sentence, the wording it came from, the turns around it)
  release records:  0 (the wording and its digest are redacted; the override stays)
...
$ node tools/triage-demo.mjs forget f1 --home /tmp/h --acknowledge erase-permanently --reason user-request
erased f1: user-request, requested 2026-11-13T06:16:59.447Z
  removed 1 fact row(s), 1 card(s), 0 release record(s) redacted
f1  forgotten  Erased at the owner's request. No wording is kept, and the id is burned.
```

### 12.7 What is left, ordered by what it would change

Erasure moves off the list; what it exposes takes its place.

| # | item | why it is next | how it is verified |
| --- | --- | --- | --- |
| P0-1 | **`CortexMemory` has no delete** | erasure now covers `DisclosureSession`'s two stores and stops at the package boundary. `CortexMemory` keeps a per-question index and a corpus the caller supplies, so the exposure is smaller, but a product that sells "your memory" and cannot delete from its answering half has a hole shaped like a footnote | `CortexMemory` gains no store until P2-1; if it does, `forget` reaches it. Until then the boundary is stated in the manual, which it now is |
| P0-2 | **`cortex/self-index` dispatch** | unchanged, still the only way to price the per-question postings rebuild | one dispatch, three readings: paired accuracy delta, total `embedTexts`, `memoHits` |
| P1-1 | **`trim-2.8k` into registration** | `C1` is 9201 tokens/question against a 6,000 aim; the arm already measured 5,183 | `C1` recomputed at ≤ 5.2K with the same accuracy |
| P1-2 | **`backend-parity`** | unchanged from round 88: `get`, `del`, `close`, `transaction` and TTL are still uncompared across backends | one file, every `Storage` method, three backends |
| P1-3 | **Coverage merge for the integration suite** | unchanged: the priced path to asserting a `ROLLBACK` that itself fails | `coverage:gate` reads a merged report |
| P1-4 | **The tombstone's `reason` is not the rule's** | **shipped in round 90** — see §13.7. It was worse than "lossy": `forget` accepts three reasons and the tombstone printed one fixed sentence for all three, so a `correction` produced a row claiming the owner had asked to be forgotten, while the record beside it kept the truth | the row now carries one of three fixed sentences chosen by the record's own reason (`Record<ErasureReason, string>`, so a fourth reason is a compile error); what the card was *about* is documented in the manual §6.5 as deliberately unrecoverable beyond `rule` |
| P2-1 | **Retention policy as a schedule** | `ErasureReason` has `retention-policy` and nothing produces it: there is no TTL on a fact, so erasure is only ever manual. GDPR-style policy needs the reason to be reachable without a human | a sweep that erases by age, one record per sentence, `retention-policy`, and a test that it does not touch a re-confirmed row |
| P3-1 | **`secure_delete` is SQLite-only** | the browser backend (`idb`) has no such switch, and `pg` has no equivalent either. The row-level guarantee travels; the byte-level one does not | the claim in `ARCHITECTURE.md` names the backend it holds for — it does |

Two of these are the same shape as round 88's finding: **a guarantee that is true in the layer that was
measured and assumed in the layers that were not.** Erasure is now verified at the row, at the read
path, and at the file — for SQLite. The other two backends have the row guarantee and nothing else,
and saying that out loud is cheaper than discovering it in an audit.

---

## 13. Round 90: the product ranks its own turns, and the first dispatch died in ninety milliseconds

The row at the top of round 89's list was `P0-2`: dispatch the run in which the product builds its own
index. It read like a scheduling item. It was not. It was the only way to find out that the capability had
never run outside a fixture — and the first real run found that it could not.

### 13.1 The gap was a measurement gap, and it had a direction

Every ranking signal on this arm before `self-index` is built by **`cortex-eval`**, before the run, and
handed to the product as a synchronous callback. `relevance-index.ts`, `session-relevance.ts`,
`anchor-recall.ts` — all of them. So every published number on the arm says *this is what the harness can
rank*, and none of them says *this is what the product can rank*.

`SearchIndex` — postings over `contentTerms`, a vector channel through an injected embedder, reciprocal-rank
fusion, an optional cross-encoder — shipped in round 87 with unit tests and two acceptance rows (`C5`/`C6`).
Both rows are measured on a **synthetic four-turn corpus**. That is a fixture, and a capability whose only
evidence is a fixture is a capability nobody has measured. The audit could have carried that sentence for
another three rounds; one dispatch replaced it with a reading.

### 13.2 What had to be added, and why three things rather than one

| # | addition | where | what it makes possible |
| --- | --- | --- | --- |
| 1 | `CORTEX_MEMORY_RELEVANCE=self-index` | `cortex-eval`'s `RELEVANCE_SIGNALS` | the arm hands the product an embedder and a width instead of a table lookup |
| 2 | `CortexMemory.indexCost()` | `cortex-memory` | the **run's** cost, summed; `lastIndexCensus()` is overwritten by the next question, so the bill was not recoverable after the fact |
| 3 | `memoryArmConfig.selfIndex` | `cortex-eval`'s report | the three readings land in the artifact beside the signal, not in a job log that expires |

The signal rides the existing enum rather than taking a dispatch input of its own. That is forced rather
than preferred: the memory workflow sits at **24 of GitHub's 25** `workflow_dispatch` inputs and
`tools/__tests__/test_dispatch_inputs.py` refuses a workflow that reaches the limit. The ceiling produced
this shape twice before (§13.17's split, `CORTEX_MEMORY_CONFLICTS`), and a mechanism that fits inside an
existing value is a mechanism that cannot be crowded out by the next one.

### 13.3 Four decisions the code now records

1. **Who builds the index is one predicate.** `buildsProductIndex(signal)` is in `cortex-eval`, not in the
   CLI, because `bench/**` is outside the coverage boundary — and because the two call sites have to agree:
   the run wires either `index` or `relevanceFor`, and `#relevanceFor` returns the override first, so a file
   that wired both would rank with the callback while its artifact named `self-index`.
2. **The fold is the arm's, over every instance.** `indexCostAcross` reads each feature instance the pool
   built, for the reason `voteCountsAcross` does: a per-instance counter read off worker 0 is the
   quarter-denominator defect §13.244 already paid for, at one more census.
3. **An idle worker is a zero, not an absence.** `CortexMemory.indexCost()` returns `undefined` when an
   instance never built an index — the normal state of a worker that drew no ranked questions. Treating that
   as "this system has no census" would discard the total on one idle worker, which is a truncated sum
   wearing the shape of a guard.
4. **`reuse` is a conjunction over the parts that embedded.** One index without a store makes the total
   incomparable with a run that had one throughout; a worker that embedded nothing must not turn a stored
   run into an unstored one.

### 13.4 The ninety milliseconds

The screening dispatch (200 questions × 2 repetitions, 2.85 CNY) died at question 4:

```
Embedding request failed: 400 Bad Request —
{"error":{"code":"1214","message":"input数组最大不得超过64条"}}
    at OpenAIEmbedding.embed (packages/cortex-ai/src/embedding/openai.ts:84:13)
    at async EmbeddingMemo.embed (packages/cortex-core/src/cache/embedding-cache.ts:238:23)
    at async SearchIndex.prime (packages/cortex-memory/src/retrieval/search-index.ts:310:21)
    at async CortexMemory.#relevanceFor (packages/cortex-memory/src/memory.ts:2375:5)
```

`prime()` embedded the **whole corpus in one request**. A LongMemEval haystack is ~500 turns; Zhipu refuses
more than 64 inputs per request. So the product's own retrieval could not run against a capped provider at
all, and no unit test could see it: a fake embedder accepts any batch size. The instrument agreed with the
code, and both were wrong about the world.

This is the same class as round 87's `secure_delete` finding and round 88's four storage defects — a
property that is true of the code as tested and false of the thing it runs against — and it is the third
time a real dispatch has been cheaper than an argument. Ninety milliseconds of a run that had already paid
for its setup found what twelve rounds of review had not.

### 13.5 The repair, and the counter it made meaningful

`prime()` now walks the corpus in slices of `SearchIndexOptions.batch`, default **64** — Zhipu's documented
cap, and the constant `cortex-eval`'s `retrieval.ts` already batches at, so a measured run and the product
cannot disagree about how many texts one request carried. The default is the smallest cap this repository
measures against, because chunking more finely costs requests and chunking less finely costs a failed run.

The interesting consequence is on the census. `embedCalls` and `embedTexts` were introduced as a pair
because "a batch count alone cannot price a corpus". Chunking makes them **separately** meaningful for the
first time: a 130-turn corpus at the default is three requests and 130 texts, plus one request for the
query. The counters were right before the defect and only became informative after it — which is what a
census is for.

`batch` is refused below 1 rather than clamped: zero asks for an unbounded number of empty requests, and a
fraction asks for a loop that cannot advance.

### 13.6 Mutations, and the one that was a no-op

Eight mutations, each applied by locating its text and printing the line it landed on:

| mutation | line | result |
| --- | --- | --- |
| `foldIndexCost` stops adding `memoHits` | `search-index.ts:197` | **red**, 1 failed |
| the census is folded from nothing each time | `memory.ts:2387` | **red**, 1 failed |
| a record with zero indexes is published | `bench-memory-arm.ts:4739` | **red**, 1 failed |
| an idle worker's `undefined` reads as an absent capability | `bench-memory-arm.ts:4689` | **red**, 1 failed |
| `reuse` becomes a disjunction | `bench-memory-arm.ts:4737` | **red**, 1 failed |
| every signal builds the product's index | `bench-memory-arm.ts:2607` | **red**, 1 failed |
| the cost stops rendering | `report.ts:1747` | **red**, 1 failed |
| `prime()` goes back to one request | `search-index.ts:314` | **red**, 1 failed |

The last one is the round's own subject. A mutation that restores the defect must fail the test that was
written for it, or the test was written for the repair's *shape* rather than its *behaviour*.

### 13.7 `P1-4`: the row disagreed with the record about the same act

Round 89 wrote the tombstone's sentence as a constant:

```ts
const FORGOTTEN_REASON = "Erased at the owner's request. No wording is kept, and the id is burned.";
```

and `forget()` accepts three reasons. The erasure *record* kept the true one the whole time —
`ErasureReason` is a closed union and `eraseLog.begin({ reason })` stores it — so the store held two
accounts of one act, and the one a person reads (the card row, printed in `export`) was the wrong one.
A `correction` erased a card and then said the owner had asked to be forgotten; a retention sweep
would have said the same. Repro through the shipped CLI, before the repair:

```
$ node tools/triage-demo.mjs forget f1 --home /tmp/h --acknowledge erase-permanently --reason correction
f1  forgotten  Erased at the owner's request. No wording is kept, and the id is burned.
```

The repair is a total map rather than a branch:

```ts
const TOMBSTONE_REASONS: Readonly<Record<ErasureReason, string>> = {
  'user-request': "Erased at the owner's request. No wording is kept, and the id is burned.",
  correction: 'Erased as a correction. No wording is kept, and the id is burned.',
  'retention-policy': 'Erased under the retention policy. No wording is kept, and the id is burned.',
};
```

Three properties, each one chosen over an alternative:

1. **`Record<ErasureReason, string>`, not a lookup with a fallback.** A fourth reason is a compile
   error here, the same device that made `forgotten` announce itself when the state union grew.
2. **The reason comes from `opened.reason`, not from `options.reason`.** An interrupted erasure keeps
   the reason it was opened with, so a retry naming a different one would move the row away from the
   record beside it — the same defect one layer down, and the reason it is now computed once and used
   twice instead of being recomputed at the call site.
3. **The sentences name the act, never the content.** No wording, no topic, no count; the reason is
   the one fact about an erasure an auditor needs and the one that cannot be reconstructed into a
   secret.

After the repair, from the same binary:

```
$ node tools/triage-demo.mjs forget f1 --home /tmp/h --acknowledge erase-permanently --reason correction
f1  forgotten  Erased as a correction. No wording is kept, and the id is burned.
$ node tools/triage-demo.mjs export --home /tmp/h
| `f1` | forgotten | Erased as a correction. No wording is kept, and the id is burned. | — |
```

`P1-4`'s other half — *why the card existed* — is answered by refusing to answer it. Beyond `rule`
(`null` when no rule claimed the sentence), every candidate field is a reconstruction channel, and
AfterDeleteBench's control product is exactly the one that kept them. That loss is now stated in the
manual's §6.5 rather than left for a reader to infer from two exports, which is what the item's
acceptance allowed for and what makes it a decision instead of an omission.

What the two tests pin, and both were checked by putting the defect back:

| mutation | result |
| --- | --- |
| `reason: TOMBSTONE_REASONS['user-request']` — the map exists but the row ignores the reason | **red**, 2 failed (`erasure.test.ts`) |
| `tombstoneOf(plan.card, at, options.reason)` — the row takes the call's reason, not the record's | **red**, 1 failed |

The first mutation is the defect itself with a better-looking shape, which is why it is the one that
had to be tried: a total map that nothing indexes by is a constant with extra steps.

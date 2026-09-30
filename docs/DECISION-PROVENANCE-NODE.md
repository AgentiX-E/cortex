# DECISION-PROVENANCE-NODE

**Decision owed since:** §28 (`AUDIT-UNREFERENCED-EXPORTS.md` §3.1) — the last of that
document's three remediation items still open.
**Question:** is `cortex-core: ProvenanceNode` the seed of a roadmap item, or a
speculative type that should be deleted with the decision recorded?
**Verdict:** **delete the symbol, keep the question, and record the replacement
mechanism.** `ProvenanceNode` is not an unimplemented feature — it is a
**second, weaker answer to a question the codebase already answers** with the
bitemporal `Fact` layer. It is superseded, not pending.
**Measured at revision** `770d0ac`.

---

## 1. The evidence, before the argument

Every claim below is a command result, not a reading of intent.

### 1.1 The symbol is isolated on all four axes

| Axis | Finding | How |
| --- | --- | --- |
| No caller | Nothing in `packages/*/src` outside its own file mentions it | census `unreferenced` class |
| No test | No test file imports or asserts on it | name search across `__tests__` |
| No local use | Its own module does not consume it | module is the type declaration and nothing else |
| No live sibling | No function, constant, or type in the repository operates on it | see §1.2 |

### 1.2 The DAG edge has exactly one occurrence in the repository

The type's load-bearing field — the one that makes it a *node* in a DAG rather
than a record — is `parents`:

```ts
/** Optional parent provenance node ids (forming a DAG). */
parents: string[];
```

Searching the entire source tree for `parents` returns this declaration plus
four unrelated hits: three are the English word in test fixtures about family
relations (`'How many parents do I have?'`), and one is a lexer regex for the
same word. **There is no traversal, no topological order, no ancestor lookup, no
cycle check.** A DAG type whose edge field no code ever reads is a shape without
a graph.

### 1.3 The file is exactly one declaration

`packages/cortex-core/src/domain/provenance.ts` is 13 lines: a docstring, and the
type. It compiles to **zero statements**, which is why
`AUDIT-COVERAGE-ANNOTATION-BLIND-SPOT.md` found the `istanbul ignore file`
annotation on it was inert twice over. Two of this repository's audits have
already had to touch this file to correct a claim made *about* it; neither
corrected a claim made *by* it.

---

## 2. Why "seed" fails

The roadmap reading has to answer: **what would be built on top of this, and is
that thing already built?**

Provenance tracking means, concretely, four capabilities:

1. **Where did this memory come from?** — an origin label per memory.
2. **How was it derived?** — a record of which ancestor produced it.
3. **When, on two clocks?** — when it became true, and when the system learned it.
4. **Can I reconstruct the past state?** — as-of query over the record.

Capabilities 1, 3, and 4 are **implemented, tested, and running** in
`cortex-core`'s bitemporal layer. Capability 2 is the only gap, and
`ProvenanceNode` does not close it either — §1.2 shows it declares the edge and
reads it nowhere.

### 2.1 The overlap, field by field

| `ProvenanceNode` field | What already carries it |
| --- | --- |
| `id` | `Fact.id`, `MemoryValue.id` |
| `memoryId` | `Fact.subject` + `Fact.predicate` (the fact *is* about a memory) |
| `kind: string` — `"user-message"`, `"llm-extraction"`, `"consolidation"` | `MemoryValue.source` / `Fact.source`, documented as *"Origin of the memory, used for provenance and poisoning defense"* |
| `timestamp: number` — one clock | `Fact.validFrom` + `Fact.systemFrom` — **two** clocks |
| `parents: string[]` — a DAG | **nothing** (the actual gap, §1.2) |
| `metadata?: Record<string, unknown>` — untyped escape hatch | `Fact.confidence` + `Fact.sourceTrust` — **typed** [0,1] scales |

The comparison is not close. Where `ProvenanceNode` is more general, it is more
general by being **less typed**: an unconstrained `kind` string against a
documented `source`; an untyped metadata bag against two calibrated numeric
scales. And it is *strictly worse* on time, offering one timestamp where `Fact`
offers the pair that makes as-of reconstruction possible at all.

### 2.2 The mechanism it would need already exists

`packages/cortex-core/src/temporal/bitemporal.ts` implements exactly the
queries provenance tracking requires, against `Fact`:

```ts
currentFacts(facts, worldTime?, systemTime?)   // what is true, and as-of when
currentValue(facts, subject, predicate, ...)   // best current fact, trust-weighted
findContradictions(facts)                      // conflicts on (subject, predicate)
```

`isFactCurrentAt` uses `systemUntil` to mark supersession — the field whose
docstring reads *"the system learned (or superseded) the fact"*. **That is an
immutable audit log with an as-of query.** `AUDIT-CODE-VS-DOCS.md` lists
"Provenance-DAG / immutable audit log" as *advertised-but-absent* and cites
`provenance.ts` as the evidence — but the evidence it should cite is that the
**log half already shipped** under a different name, and only the DAG edge is
missing.

---

## 3. What is genuinely owed

Deleting `ProvenanceNode` must not delete the finding. Two things survive it.

### 3.1 The derivation gap is real and is now recorded

`Fact` records **what** was concluded and **how confidently**, but not **from
which prior facts**. A fact derived from three retrieved memories is
indistinguishable from one asserted directly, except by its `source` string.
That is a genuine limitation of the running system.

The fix, when the roadmap wants it, is **not** a parallel `ProvenanceNode` table.
It is a field on `Fact` — `derivedFrom?: string[]` — because a derivation edge
between facts belongs in the same row as the fact, or the two records can
disagree and nothing arbitrates. `ProvenanceNode`'s error was structural: it
made provenance a **sibling** of the domain types instead of a property of
them, which is why it has no consumer. Nothing can consume a node that no
other type points at.

### 3.2 The documentation claim needs correcting

`ARCHITECTURE.md` line 12 lists `ProvenanceNode` in the `domain/` layer of a
diagram that otherwise describes what ships. `README.md` line 30 advertises
*"Provenance & trust — every memory records its source, trust, and derivation"*.
The **source and trust** halves are true (`MemoryValue.source`,
`MemoryValue.sourceTrust`). The **derivation** half is the gap in §3.1.

Both are corrected in the same change as this decision, so the diagram stops
naming a symbol that does not exist and the README stops implying derivation is
recorded.

---

## 4. The change

| # | Change | File |
| --- | --- | --- |
| 1 | Delete `packages/cortex-core/src/domain/provenance.ts` | domain/ |
| 2 | Remove `export type { ProvenanceNode } from './domain/provenance.js';` from the barrel | `cortex-core/src/index.ts` |
| 3 | Replace the `domain/` line so it names what ships | `ARCHITECTURE.md` |
| 4 | Retarget the derivation claim at the recorded gap | `README.md` |
| 5 | Record the gap in the status table, as the other inert capabilities are | `ARCHITECTURE.md` |

Item 5 matters most: `ARCHITECTURE.md`'s *Implementation status* table already
states plainly that TD(λ) is not implemented and that `sinkhorn` is implemented
but inert. Fact derivation belongs in that table, in the same voice — not
implied by a type that nothing reads.

---

## 5. Verification

Four checks, all negative, all run before the deletion:

1. **No value import.** No file imports `provenance.js` for a runtime binding —
   the module exports only a type, so a value import is not even expressible.
2. **No type-only import.** Search for `from './domain/provenance.js'` and
   `from '../domain/provenance.js'` across `packages/`: **1 hit, the barrel**.
   `ProvenanceNode` itself: **1 hit, the barrel**.
3. **No barrel re-export chain.** `cortex-node`, `cortex-llm`, `cortex-eval`
   barrels do not re-export it; only `cortex-core`'s does.
4. **No bench or tool consumer.** `packages/cortex-eval/bench/` and `tools/` do
   not mention it.

Each is a command whose expected result is **empty**, and each was empty.

Then the census must move by exactly one, and only in two directions:

```
exports          431 -> 430
orphaned         215 -> 214
unreferenced      28 ->  27
referencedLocally 187 -> 187   (unchanged — it was never in this class)
withCaller       216 -> 216   (unchanged)
```

`unreferenced 28 -> 27` is the movement this document predicts, and it closes the
class that §28 opened at 31. A movement in `referencedLocally` would mean the
census disagreed with §1.1 and the deletion was misclassified.

### 5.1 A regression test that outlives the symbol

Deleting a type leaves nothing for a test to assert on, so the durable assertion
is about **the files**, not the symbol:

- `domain/provenance.ts` does not exist;
- no barrel in any package names `ProvenanceNode`;
- no source file outside `node_modules` contains the identifier;
- `ARCHITECTURE.md`'s `domain/` line does not name it;
- `ARCHITECTURE.md`'s status table **does** record derivation as not implemented.

The last one is the point: the test fails if someone deletes the symbol and also
deletes the record of why the gap exists. That is the failure mode this whole
document is guarding against, so it is the one the test checks.

---

## 6. What this document does not claim

- **It does not claim provenance tracking is unwanted.** §3.1 records it as a
  real gap with a named remedy. It claims only that `ProvenanceNode` is not that
  remedy, and that keeping a shape nothing reads is not the same as keeping the
  intent.
- **It does not claim the bitemporal layer is complete provenance.** It covers
  origin, dual-clock timing, and as-of reconstruction. Derivation edges are
  absent, stated as absent.
- **It does not generalise to the other 27.** Those remain `unreferenced` and are
  mostly public surface (the grouping evidence is in
  `AUDIT-UNREFERENCED-CLASSES.md`). One symbol's disposition is one symbol's
  evidence.
- **It does not claim deletion was the only defensible call.** Wiring it would
  also be defensible — if the roadmap had a consumer. It does not, and building a
  parallel provenance table beside a working bitemporal store is the more
  expensive way to close the same gap.

---

## 6a. A build fragility this change surfaced, and did not cause

The deletion was verified by running `pnpm check`, which passed. It was then
re-verified by a **clean** build — `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo`
— and that clean build **also** passed. But an *intermediate* state failed, and the
failure is worth recording because it is reachable from a plausible command:

```
rm -rf packages/cortex-core/dist          # then, without clearing cortex-node's state:
pnpm build
→ packages/cortex-node build: src/storage/sqlite.ts(86,16): error TS7006:
  Parameter 'k' implicitly has an 'any' type.   (and five more)
```

**Cause.** `cortex-node` resolves `StorageTransaction` through the project
reference to `cortex-core`'s *emitted* `dist/*.d.ts`. When `cortex-core/dist` is
absent but `cortex-node/tsconfig.tsbuildinfo` survives, `tsc` trusts the stale
buildinfo, the import fails to resolve, and `StorageTransaction` degrades to
`any`. The annotation `const tx: StorageTransaction = { ... }` then types nothing,
and `strict`'s `noImplicitAny` reports the six arrow parameters.

**Why it is latent rather than visible.** `tsconfig.base.json` sets both
`composite: true` and `incremental: true`, and each package's build is
`tsc -p tsconfig.json` — not `tsc -b --force`. Incremental state caches the
resolution. In CI, `dist/` and `.tsbuildinfo` arrive and leave together, so the
inconsistent state never arises. The cost is that **any partial clean is a
build-order-sensitive operation**, and the symptom (six `TS7006`s in an unrelated
file) points at the wrong code.

**What this document does about it.** Nothing to `sqlite.ts` — there is no defect
there, and the code is correct as written; the parameters are contextually typed
by the annotation, which is exactly the right idiom. The finding is recorded here
so that the next person who sees those six errors after a partial clean recognises
a stale-buildinfo state rather than an `any`-leak in the storage layer. A
permanent guard would be `tsc -b --force` in the build script or a `clean` that
removes both, and that is a build-configuration change with its own blast radius —
out of scope for a deletion whose evidence is a census movement.

---

## 7. Generalisable conclusion

**"Unreferenced" and "unimplemented" are different findings, and only one of them
is a work item.**

`ProvenanceNode` sat in the census as the single zero-referenced export, which
made it look like the one symbol whose remedy was mechanical. It was the
opposite: it was the symbol that most needed a design call, because the reason it
is unreferenced is that **the capability it names was already delivered by a
better-typed mechanism elsewhere**. The productive question was never "who should
call this?" but "what does this say that `Fact` does not?" — and the answer is
one field, `derivedFrom`, which belongs on `Fact`.

The rule: when a type is unreferenced, check whether it is **pending** or
**superseded**. Pending types have consumers waiting for them. Superseded types
have a live implementation of the same idea that the census does not connect them
to, and no amount of searching for callers will reveal that — it requires asking
what the symbol *means* and searching for the meaning, not the name.

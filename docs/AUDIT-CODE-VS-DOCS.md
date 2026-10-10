# Cortex — Code vs. Documented State Audit

**Audit date:** 2026-09-20
**Audited revision:** `master` @ `31a3371` (`fix(eval): assert R4's cohort coverage instead of assuming it`)
**Auditor method:** source read + local `pnpm check` reproduction, not document trust.
**Scope:** `README.md`, `ARCHITECTURE.md`, `SOTA-BASELINE.md`, `CONTRIBUTING.md` vs. the shipped
code in `packages/*`.

This document records what the repository actually does, so that every downstream internal
document can be aligned to measurement rather than to intent.

---

## 0. Verdict summary

The engineering hygiene is genuinely excellent and the documented quality claims **hold up under
reproduction**. The problem is not discipline — it is that **three of the four root documents
describe a different system from the one on `master`**.

| Claim source | Claim | Reproduced? | Verdict |
| --- | --- | --- | --- |
| `CONTRIBUTING.md` | ≥95% coverage on all four dimensions | ✅ 98.29 / 97.32 / 100 / 98.29 (core) | **ACCURATE** |
| `CONTRIBUTING.md` | No mocks, real SQLite / real HTTP | ✅ Verified in test sources | **ACCURATE** |
| `CONTRIBUTING.md` | `pnpm check` green | ✅ lint + typecheck + test + format all pass | **ACCURATE** |
| `README.md` | Six cognitive capabilities are the product | ⚠️ Implemented, but **unreachable from the benchmark** | **PARTIALLY MISLEADING** |
| `ARCHITECTURE.md` | Layering, Float64, pluggable backends | ✅ Matches | **ACCURATE** |
| `SOTA-BASELINE.md` | 83.55% on `master` | ❌ Measured at `a52628f`, **55 commits behind** | **STALE** |
| `ARCHITECTURE.md` | Retrieval-as-consolidation = Hebbian + FSRS + TD(λ) | ❌ **No TD(λ) exists in the codebase** | **INACCURATE** |
| `ARCHITECTURE.md` | Cross-layer distillation via optimal transport | ❌ `sinkhorn` is exported but **never called** | **INACCURATE** |

Reproduced at `31a3371`:

```
packages/cortex-core  Test Files 9 passed  Tests  87 passed  98.29 | 97.32 | 100 | 98.29
packages/cortex-node  Test Files 1 passed  Tests  16 passed   100 | 98.61 | 100 |  100
packages/cortex-llm   Test Files 2 passed  Tests  43 passed   100 | 97.26 | 100 |  100
packages/cortex-eval  Test Files 20 passed Tests 836 passed  99.84 | 98.68 | 100 | 99.84
                                         total 982 tests, 0 failures
```

### 0.1 Coverage re-measured later: four of five packages are now 100 on all four dimensions

The block above is kept as the audit's own snapshot at `31a3371`, not updated in place, so
that the verdict table below stays tied to the revision it was formed at. Current readings,
reproduced at `e6ea892`:

```
packages/cortex-core   Test Files 17 passed Tests  252 passed  100 | 100    | 100 | 100
packages/cortex-llm    Test Files  4 passed Tests  138 passed  100 | 100    | 100 | 100
packages/cortex-eval   Test Files 56 passed Tests 1604 passed  100 | 100    | 100 | 100
packages/cortex-memory Test Files  8 passed Tests  135 passed  100 | 100    | 100 | 100
packages/cortex-node   Test Files  1 passed Tests   17 passed  100 |  98.61 | 100 | 100
                                        total 2146 tests, 0 failures
```

The one row that is not 100 is `cortex-node`'s branch column, and its 1.39 points sit entirely
at `pg.ts:82:4` — the `} finally {` of `PgStorage.transaction`. It is a measured instrument
defect, not a test gap: raw `NODE_V8_COVERAGE` shows that line carrying one sub-range with
`count = 0` while the statement on the same line counts 5, and the same function without
`try/finally` emits zero ranges there. A branch record with one location has no second arm, so
no test can satisfy it. The rationale, with both control cases, is in
`packages/cortex-node/vitest.config.ts`.

**The gate itself did not move.** 95% on all four dimensions in all five packages, as
`CONTRIBUTING.md` claims — and the `AUDIT-COVERAGE-ANNOTATION-BLIND-SPOT.md` addendum §9
records why attributing a single `[0]` requires reading the provider's raw ranges rather than
its aggregate.

---

## 1. The central finding — the cognitive layer is not on the benchmark path

`cortex-eval` declares a dependency on `cortex-core`, but only ever imports **statistics helpers
and one vector index** from it. Every non-type symbol the benchmark actually consumes is:

```
binomialCdf · BruteForceVectorIndex · mean · stddev · variance · welchTTest · wilsonScoreInterval
```

Counted across all of `packages/`, the signature cognitive entry points have **zero call sites
outside their own module, their own tests, and the barrel export**:

| Exported capability | External call sites |
| --- | --- |
| `decideWrite` (value-driven write) | **0** |
| `decideRetrieval` (abstention) | **0** |
| `defaultValueFunction` | **0** |
| `resolveContradiction` | **0** |
| `currentFacts` (bitemporal query) | **0** |
| `consolidate` (Hebbian + FSRS) | **0** |
| `MemoryGraph` | **0** |
| `sinkhorn` (optimal transport) | **0** |
| `retrievability` / `review` (FSRS) | **0** |

**Interpretation.** The 83.55% LongMemEval-S score is produced by
`packages/cortex-eval/src/natural-language-memory.ts` (2,817 lines) plus `retrieval.ts`
(1,136 lines) — a substantially different implementation that does its own
retrieval, its own abstention decision, and its own prompt assembly. The
"value-driven cognitive memory layer" described by `README.md` is a **well-tested library that
nothing in the product actually runs.**

This is not covert: the docs partially own it. `memory-benchmark-sota-landscape.md` §6 lists
"图扩散激活 ⚠️（在 core 中，未接入 MR/TR）". But that single warning understates the scope —
it is not one capability that is unwired, it is **essentially the entire `cortex-core` surface.**

### 1.1 Why this matters more than a naming quibble

A reader of `README.md` reasonably concludes that installing `cortex-core` and running the
documented Quick Start gives them the system that scores 83.55%. It does not. The Quick Start
wiring (`decideWrite` → `decideRetrieval`) is a different, much simpler pipeline than the one
under measurement.

### 1.2 Two caveats that strengthen rather than weaken the finding

Stated up front, because they are the first objections a careful reader should raise:

1. **The evaluation belongs in the evaluation package.** A measurement harness that imports the
   system under test from a single source is *correct* — it keeps the instrument independent of
   the thing it measures. The defect is not the import graph; it is that no **product** path
   exists that composes `cortex-core`'s cognitive layer into a runnable system. `cortex-eval`
   therefore cannot measure it even in principle.
2. **`cortex-core` is pure by design.** Its algorithms are contracts plus pure functions, so a
   harness *could* drive them directly. It does not, which is precisely why "validated library"
   and "measured system" are different claims.

Neither caveat rescues the documentation: both leave the gap between what `README.md` sells and
what the benchmark exercises exactly as wide as described.

---

## 2. `SOTA-BASELINE.md` is materially stale

The document states:

> **Measured on:** `master` @ `a52628f` (revert of the DCG experiment)

`a52628f` is a real commit, but it is **not** current `master`:

```
commits between a52628f and master:  55
eval src churn (all 30 changed files): +8,326 / −227 lines
```

Fifty-two of those commits touch `packages/cortex-eval/src`, including:
- `feat(eval): add a date-range arm to TR recall`
- `feat(eval): recall TR turns by occurrence date, not mention date`
- `feat(eval): add zero-LLM entity-graph recall arm for TR questions` → **later reverted**
- `feat(eval): add time-window annotation and deterministic-coverage arms for TR`
- `feat(eval): measure the abstention retry with a paired arm and a fire count`
- `feat(eval): add the conjunction-decomposition expansion arm (R4) with its own ablation`

A frozen baseline whose measuring instrumentation has since been rewritten by 8,326 inserted
lines cannot be quoted as "the current position of Cortex". The number `83.55%` should be
re-measured at `31a3371` before appearing in any external-facing or decision document.

---

## 3. Two capabilities are documented but do not exist

### 3.1 TD(λ) credit assignment — absent

`ARCHITECTURE.md` and `README.md` both advertise retrieval-as-consolidation as
"Hebbian + FSRS + **TD(λ)**", and the whitepaper builds an entire innovation pillar on it
("TD(λ) 资格迹沿记忆 DAG 信用分配").

```
grep -ri "td(λ)"        packages/ → 0 files
grep -ri "eligibility"  packages/ → 0 files
grep -ri "资格迹"        packages/ → 0 files
```

There is no temporal-difference machinery, no eligibility traces, and no credit assignment.
`consolidate()` performs exactly three things: FSRS state update, graph edge strengthening on
co-access, and threshold-based forgetting.

### 3.2 Optimal-transport distillation — exported, never invoked

`ARCHITECTURE.md` lists "Cross-layer distillation | entropy-regularized optimal transport |
Sinkhorn-Knopp". `sinkhorn()` and `squaredEuclideanCostMatrix()` do exist in
`cortex-core/src/math/ot.ts` and are correct (covered by TSPL tests), but the **only** file
that references `math/ot` is the barrel `index.ts`:

```
grep -rn "math/ot" packages/ → index.ts only (plus tests)
```

`consolidation/consolidate.ts` — the module whose header comment claims "cross-layer
distillation" — does not import it. The phrase in that file's docstring:
> *"plus cross-layer distillation"*

describes an intention, not the code beneath it.

### 3.3 Other advertised-but-absent items

| Advertised (`ARCHITECTURE.md` / whitepaper) | Reality |
| --- | --- |
| Platt / temperature calibration for abstention confidence | No `platt`, no `temperature scaling` anywhere |
| IVF / HNSW vector indexes | Only `BruteForceVectorIndex`; `pgvector` appears once, in a type comment |
| Browser backend (sql.js / IndexedDB) | No matches |
| Multimodal memory | No matches |
| `pgvector` scale-out path | Only `PgStorage` (JSONB) in `cortex-node` |
| CRDT multi-agent merge | No matches |
| Provenance-DAG / immutable audit log | Split, and the halves are not in the same state. The **log half is real** — `Fact` carries `source`, `sourceTrust` and both time axes, and `temporal/bitemporal.ts` implements `currentFacts` / `currentValue` / `findContradictions`, so origin and as-of reconstruction ship. The **DAG half is absent**: `ProvenanceNode` declared a `parents` edge that no code read, and has been deleted. See `DECISION-PROVENANCE-NODE.md` |
| Memory-poisoning defence | `poison` appears only in a doc comment and an unrelated test |

---

## 4. What is genuinely true (and should be stated with confidence)

These are real and verified — they are the project's actual assets:

1. **Layering is exactly as documented.** `cortex-core` has zero I/O imports; concrete engines
   live in `cortex-node` / `cortex-llm`. Dependency inversion is clean.
2. **Float64 numerical discipline is real.** `Kahan` summation, Welford variance, and
   `ml-matrix` Float64 linear algebra are present and tested.
3. **The statistical toolkit is excellent** and is what the benchmark actually stands on:
   `welchTTest`, `studentTCdf`, `logGamma`, `binomialCdf`, `wilsonScoreInterval` — this is
   better statistics infrastructure than most of the systems it competes with.
4. **Coverage and test integrity are as advertised** (see table in §0), with **no mocks**:
   real `better-sqlite3`, real `pg-mem`, real local HTTP servers.
5. **The 87 tests in `cortex-core` are genuinely meaningful** — they exercise the algorithms,
   not the exports.

---

## 5. Documentation gaps to close

| # | Gap | Severity |
| --- | --- | --- |
| D1 | No document states what the benchmark path **is** (`natural-language-memory` + `retrieval`), nor how it relates to `cortex-core` | **P0** |
| D2 | `SOTA-BASELINE.md` quotes a baseline 55 commits stale; no current-revision measurement exists | **P0** |
| D3 | `ARCHITECTURE.md` / `README.md` advertise TD(λ) and OT distillation that are not wired | **P0** |
| D4 | No coverage thresholds are enforced in any `vitest.config.ts` — the ≥95% rule is convention, not a gate | **P1** |
| D5 | `longmemeval-sota-research.md` reports 83.50% / IE 94.83% / MR 76.65% / ABS 99.17%, contradicting `SOTA-BASELINE.md`'s 83.55% / 94.50% / 77.07% / 100% | **P1** |
| D6 | `memory-benchmark-sota-landscape.md` still recommends wiring graph activation into MR/TR as P0/P1, though it was measured and **reverted** (`7780071`) | **P0** |

---

## 6. Closing the gap: where the cognitive layer should be wired

The fix is **not** to force `cortex-core` into `cortex-eval`. That would collapse the instrument
into the system under test. The system that the benchmark *should* exercise belongs in the
product layer.

### 6.1 Required seam: `cortex-memory`

`cortex-node` today owns only `Storage` (`SqliteStorage`, `PgStorage`) — correctly so, but there
is no package that composes the cognitive layer into a runnable memory system. That package is
missing, and its absence is the root cause of §1.

| Layer | Package | Responsibility | Status |
| --- | --- | --- | --- |
| Contracts + pure algorithms | `cortex-core` | `decideWrite`, `decideRetrieval`, `resolveContradiction`, `consolidate`, `MemoryGraph`, `sinkhorn`, FSRS, bitemporal | ✅ exists, ✅ tested, ❌ unused |
| **Composition** | **`cortex-memory` (new)** | **Wire the above into one `MemorySystem` that satisfies `cortex-core`'s own contracts** | ❌ **missing** |
| Backends | `cortex-node` | `SqliteStorage`, `PgStorage` | ✅ exists (storage only) |
| Providers | `cortex-llm` | LLM + embedding adapters | ✅ exists |
| Instrument | `cortex-eval` | Measure whatever satisfies `MemorySystem` | ✅ exists |

Dependency direction stays acyclic:

```
cortex-core  ←  cortex-memory  →  cortex-node
                     ↑                (injected Storage)
                     └── cortex-llm   (injected LLM/Embedding)
                              ↑
                        cortex-eval     (depends on cortex-memory, measures it)
```

`cortex-eval` keeps its own `natural-language-memory.ts` **as a control arm**, so the benchmark
can report both the reference pipeline and the cognitive composition side by side.

### 6.2 Ordered work

| # | Task | Why it is first | Verification |
| --- | --- | --- | --- |
| 1 | ~~Extract the reference pipeline's contracts into `S`-compatible form~~ | **Closed as already satisfied** — nothing was entangled and there was no `S` to bend into (`AUDIT-EVAL-CONTRACTS.md` §2, §4) | ~~`cortex-memory` passes the existing `MemorySystem` conformance tests~~ → **the suite did not exist; it does now** (`memory-system-conformance.test.ts`, 11 assertions over `runBenchmark`'s routing) |
| 2 | ~~Implement `cortex-memory` composing `decideWrite` → storage → `decideRetrieval`~~ | **Done** — the cognitive layer is reachable; whether it *helps* is step 3 | ✅ **Delivered: 129 tests, 100/100/100/100 coverage, `memory-system-conformance.test.ts` passes unmodified.** See [`docs/DESIGN-CORTEX-MEMORY.md`](docs/DESIGN-CORTEX-MEMORY.md) |
| 3 | ~~Add a benchmark arm that supplies `cortex-memory` instead of the reference pipeline~~ | Produces the first honest number for the cognitive layer | **Arm assembled, pre-registered, and wired for dispatch.** Three defects in the dispatch path — a missing embedding-cache restore, a blank input read as a zero budget, and a hardcoded enable toggle — were found by reading the wiring back and closed with tests; see §7.3 of [`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`](docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md). Running `python3 tools/dispatch-cortex-memory-ab.py` is the remaining step |
| 4 | Enforce the ≥95% ceiling in `vitest.config.ts` (`thresholds`) | **Premise needs re-checking** — all five packages already carry `thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 }`, so the rule is *not* convention only. **Measured, and the gate is weaker than it reads**: vitest thresholds are checked against the **package average**, not per file, so an injected unreached export dropped `cortex-memory/src/prompt.ts` to 94.36/90.9 while the package averaged 97.88/97.43 and `vitest run --coverage` still exited 0. A `--coverage.thresholds.perFile=true` audit of the clean tree names four more files below the floor: `cortex-core/src/contradiction/resolve.ts` (branches 91.30%), `cortex-core/src/math/stats.ts` (lines/statements 93.29%), `cortex-llm/src/embedding/transformers.ts` (branches 87.50%) and `cortex-llm/src/rerank/llm-reranker.ts` (branches 94.87%). The gates are real but average-scoped, so **a single under-covered file cannot fail CI** — which is the exact question this row asked. `stats.ts` is a separate finding again: its 6 guard bodies carry `c8 ignore`, and the repo measures with v8 coverage | A deliberately under-covered commit must fail CI — **✅ answered: it does not, for a per-file regression. `perFile: true` closes it and is verified to catch the injected case**
| 5 | Re-measure LongMemEval-S at current `master` | D2 — replaces a 55-commit-stale number. **Folded into step 3**: the arm's baseline side is this measurement, taken in the same dispatch under the same instrument, which is both cheaper and less confounded than a separate run | Full N=500, 4 runs, Wilson intervals published — from `benchmark-cortex-memory-ablation-report.json` |

> **Step 3 required more than the row implied, and it changed step 5.** The row reads
> like one arm added to a package that already has nine. It is the first arm whose two
> sides are **different systems**, and `cortex-eval` has no path to `CortexMemory` — the
> type-only devDependency that made `cortex-memory` conformant in step 2 is the same
> edge that makes the arm impossible to build from the harness side. The assembly
> therefore lives in `cortex-eval/src/bench-memory-arm.ts` (inside the coverage
> boundary, tests injected rather than the class imported), the entry point that can
> see both sides lives in `cortex-memory/bench/`, and the dependency graph is unchanged.
>
> The consequence for step 5 is that it **merges into step 3**. Step 5 wants a
> re-measurement at current `master` with full N=500, 4 runs and Wilson intervals; the
> arm's baseline side *is* that measurement, taken in the same dispatch under the same
> instrument. A separate dispatch for step 5 would spend the same guarded quota to
> answer the same question with a staler revision. Step 5's row is therefore re-pointed
> at the arm's baseline artifact rather than at a run of its own.
>
> **Pre-registration was written before the dispatch**, per §6.3:
> [`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`](docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md)
> fixes the point estimate (the baseline side of the same dispatch, **not** the
> 55-commit-stale 83.55%), the effect size (two-sided exact McNemar, `p < 0.05`,
> abstention-aware accuracy, overall), and the stopping rule (one dispatch, no peeking,
> no re-running for a better draw). It also pre-commits to the expected **null** result
> on IE/KU/TR, so a null cannot be reinterpreted afterwards as a surprise.

> **Step 1 closed, and it was not the work the row described.** It presumed an
> entangled contract and an existing conformance suite; the contract was already
> uncoupled (one required field, one required method, five in-repo callers, zero
> orphans) and **`grep -rn conformance packages/` returned nothing**. So the row's
> verification named a test nobody had written, and step 2 was one line away from
> being built against it. The suite now exists, and step 2's verification cites it
> directly. One export was deleted along the way (`evaluate`, a `runBenchmark` +
> `computeMetrics` wrapper whose docstring was its implementation), which is why
> `computeMetrics` is now `unreferenced`: it is an interface, kept. See
> [`docs/AUDIT-EVAL-CONTRACTS.md`](docs/AUDIT-EVAL-CONTRACTS.md).

> **Ordering is deliberate.** Steps 1–3 establish whether the cognitive layer *helps or hurts*
> before any further capability is built on top of it. Building more cognition onto an unmeasured
> base would repeat the error this audit documents.
>
> **Amendment (step 2's precondition).** Scoping step 2 surfaced a defect that step 2 would have
> hit on its first day: `consolidate`'s forgetting clock was in the wrong unit, so its shipped
> defaults deleted **every** memory in the store, including ones created milliseconds earlier and
> never accessed. Ten in, zero out. It survived because `consolidate` has no production caller —
> which is precisely the absence step 2 removes — and because its tests drove the forgetting
> mechanism while overriding both defaults. Fixed in `AUDIT-CONSOLIDATION-CLOCK.md`; `consolidate`
> now leaves a fresh memory alive and still drops a year-old one. **Step 2 can be attempted now.
> Nothing else in the ordered work changes.**

### 6.3 Pre-registration requirement

Every arm in step 3 onward must be registered **before** dispatch with:

1. the point estimate it must beat,
2. the effect size that counts as success, and
3. the stopping rule.

This is not ceremony. `p3b-graph-verdict.md` records a TR recall-expansion arm that looked
promising and measured **77.95% → 70.87%** (Δ −7.09pp, one-sided exact McNemar p = 0.039,
15 broken / 6 repaired). It was the third consecutive rejection of that line, and the commit
(`7780071`) closes it. Pre-registration is what prevented that arm from being rationalised
into the roadmap after the fact.

### 6.3.1 The artifact contract: every arm declares what a failure leaves behind

An arm that dies produces **less** than an arm that completes, and the difference is where a
result goes missing. Run `37942775447` is the worked example: ~40 minutes of grading across
two sides, ended by `TypeError: terminated`, and the artifact held a stack trace and nothing
else — `benchmark-cortex-memory-ablation-report.{md,json}` were both absent, because
`runCortexMemoryArm` **only returns on success** and the writer sits after the `await`.

What makes that a contract rather than an accident is the asymmetry inside the same `catch`:
the **embedding cache** was already being persisted on the failure path, while the **answers**
were not. The cache is the cheapest thing in the run — fully deterministic, and already paid
for — and the answers are the only thing being measured. A failure path that keeps the former
and drops the latter has the priority backwards.

So an arm registered under §6.3 declares three artifact sets, and the third is not optional:

| Set | Named | Written when |
| --- | --- | --- |
| Complete | `benchmark-cortex-memory-ablation-report.{md,json}` | the arm returns |
| Diagnostic | `benchmark-error.log` | any throw, after the stack |
| **Partial** | `benchmark-cortex-memory-partial.json` | any throw, **if the run measured anything** |

**The partial set carries no `delta`, no aggregate and no per-capability table**, and that
omission is the contract rather than a gap. Every one of those is a function of *both* sides
over the *same* index vector; with one side short they are arithmetic over data that was never
paired, and `0/0` renders in a table exactly like `0/121`. What the partial set carries is the
answer vectors and their extent — `system`, `reached`, `total`, `run` — which is what a reader
needs to decide whether the next attempt is a re-dispatch or a design change.

Two consequences worth stating, because both were live defects until fixed:

- **The predicate for "measured anything" is not `reached === 0`.** `reached` counts only the
  side that was running, so a feature side dying at question 0 reports `reached: 0` while the
  baseline vector is *complete* — and the first version of that predicate discarded it. The
  condition is `reached === 0 && baselineAnswers.length === 0`.
- **The partial file must match the upload glob.** The workflow's `path:` captures
  `packages/cortex-memory/benchmark-*.{md,json}` by pattern rather than by an explicit filename
  list, which is why adding a third artifact name needed no workflow change. An explicit list
  here would have produced a run whose fix worked and whose artifact was absent anyway.

`tools/export-census-baseline.json` has a related rule for the code side: the callback type
that feeds the partial set is deliberately **not exported**, because it has no consumer outside
its own module and the census rejects unreferenced top-level exports.

### 6.4 Registration drift: the fourth side-channel, and the one a key-level check cannot see

`tools/__tests__/test_dispatch_inputs.py` guards two directions — every key a dispatch
script sends is a declared `workflow_dispatch` input, and every declared input has an
`env:` forward. Both passed on 2026-10-05 while `tools/dispatch-cortex-memory-ab.py`
sent `cortex_memory_retrieval_threshold: '0'` and
`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.3 registered `retrievalThreshold: 0.25`.
It also passed while that script sent **no** `cortex_memory_threshold` key at all,
relying on the workflow default to land on the registered `threshold: 0`.

Those are one defect in two shapes, and they extend §7.3's enumeration of the
side-channel by one form:

| Form | Wrong where | Caught by |
| --- | --- | --- |
| 1 | input not declared in the workflow | `test_dispatch_inputs.py` |
| 2 | declared but not forwarded into `env` | `test_dispatch_inputs.py` |
| 3 | forwarded but never read by the arm | `bench-memory-arm.test.ts` |
| 4 | **read correctly, but the dispatch never sends the registered value** | `test_preregistration_config.py` |

Form 4 is the one that survives every layer working. The run succeeds, the log line
prints, the artifact records a configuration — a *plausible* one, and not the
registered one. Form 2's symptom is an absent value; form 4's symptom is a wrong
value, and a wrong value is harder to notice because it is not missing.

**Why an earlier section cannot be relied on here.** §10.6's precondition names
`sourceTrust=0.5` alone, so a run whose `retrievalThreshold` disagreed would satisfy
it. A precondition phrased as "the log line names X" is only as strong as the set of
things X covers, and the set was chosen before the second gate existed.

**The guard is a comparison against the document, not a second copy of the number.**
`tools/__tests__/test_preregistration_config.py` reads §10.3 out of the
pre-registration, maps its concepts to `workflow_dispatch` input names through one
explicit table, and asserts the dispatch sends exactly those values — in both
directions. Amending the registration without the dispatch fails; amending the
dispatch without the registration fails. A test that restated `0.25` in Python would
be a third copy of the number and would be updated in whichever file the person
happened to open first, which is the defect repeated. Three injections confirm the
guard is not vacuous: reverting the value, deleting the key, and amending §10.3 alone
are each caught.

The generalisable statement: **a gate on a key's plumbing is not a gate on its
value**, and for a pre-registered experiment the value is the part that carries the
claim. The number of a registration has to be checked against the registration.

### 6.5 Reachability and discrimination are different repairs, and only one was made

§6.4 closed with the general form of its own finding — "the value range is part of the
interface, it is just not written in the signature" — and the repair it drove widened the
range from the point `{0.5}` to the set `[0, 1]`. The natural reading of that, and the one
that was written into the roadmap as the next step, is that the gate was now usable.

It was not, and the distinction that was missing is worth naming because two rounds were
spent on one half of it:

| Property | Question | Was it true after §6.4's fix |
| --- | --- | --- |
| **reachable** | can some threshold close the gate? | yes — `0.9` closes at `0.5` and opens at `1` |
| **discriminating** | can the gate separate a strong turn from a weak one? | **no** — every turn still carried exactly `1` |

The failure is not that the fix was wrong; it is that "the range is no longer a point" was
read as "the gate now works". A gate whose *input* is constant is all-or-nothing at every
armament, so the whole reachable range can be a set and every cut inside it can still be
useless. Widening a range and introducing a distribution are two different operations, and
only the first was performed. See `DESIGN-CORTEX-MEMORY.md` §6.5 and
`09-progress-and-delivery-report.md` §49 for the measurement.

**Why the earlier test could not see it.** `retrieval-reachable-range.test.ts` asserted the
boundary, the constant at the boundary, and the widening — all four of its assertions were
about the *range*. §49 added `retrieval-discrimination.test.ts`, whose assertions are about
the *spread*, and that file is only a guard because it also asserts the property that was
false. A suite that pins a range can be entirely green while the thing the range is for is
absent.

**The class of defect, stated so it is checkable.** §7.3's table enumerates side-channels
where a value does not reach a decision. This one is adjacent and different:

| Class | Shape | Detected by |
| --- | --- | --- |
| side-channel (four forms, §7.3 / §6.4) | a configured value never reaches the decision | comparing configuration against behaviour |
| **under-specified remedy** (this section) | the configured value reaches the decision, and the decision still cannot use it | asking what the decision can *separate*, not what it can *reach* |

The second is harder to notice because every intervening layer is working. The value is
parsed, forwarded, applied, recorded in the artifact and printed in the log; the only thing
wrong is that the quantity being compared is the same for every input. That is why §49's
guard is written as an assertion about two different turns receiving two different values,
rather than as another assertion about the threshold.

### 6.6 The weakest defensible signal, and why the arm gets one at all

§6.5 leaves an obvious question: if the composition layer owns only the mechanism and the
signal is the caller's, what does the benchmark arm pass?

An inline closure inside `bench/` would have been the smallest change and the wrong one.
`bench/**` is excluded from coverage as an entry point, for the reason `bench-arm-options.ts`
records — a decision written there is a decision no test can reach — so a variation supplied
from there would be variation whose *correctness* nothing checks. The arm would then be
comparing the baseline against a mechanism whose only evidence is that the run completed.

So the signal is a module in `src/**`: `confidence.ts`, one function, `min(1, length / 2000)`.
It is chosen for being the **weakest defensible** signal rather than the best one available,
and the reasoning is worth recording because "weakest" is not the usual direction of a
selection:

- it needs no model, no vocabulary and no tuning corpus, so it cannot encode any knowledge
  of the benchmark's answers;
- it is deterministic and content-only, so an arm's delta cannot contain its noise and the
  gate stays a statement about evidence rather than about turn ordering;
- it is legible — a reader can verify by eye that a longer turn scores higher, which is not
  true of a learned score.

The better proxy considered was word overlap with the question. It was rejected here for a
specific and temporary reason: admission's callback signature is `(turn) => number` with no
question in scope, so overlap needs either a wider signature or a closed-over question, and
neither belongs in the round that establishes the mechanism. A mechanism verified through a
signal that has to reach outside its own interface is not yet verified.

**The property that separates a real signal from a plausible one.** `min(1, length / 10_000)`
is bounded, deterministic, content-only, and constant over every turn in LongMemEval — it
satisfies every stated criterion and discriminates nothing. The general form:

> A signal that varies only on inputs the run never contains is a constant signal in the
> run it is graded on.

This cannot be checked from a formula, only from a context. `confidence.test.ts` therefore
asserts the spread against a context shaped like the benchmark's — short conversational
turns, medium statements, long evidence — and asserts the degenerate variant against a
filtered context where it *is* the constant it stands for. The first draft of that test used
`min(1, length / 10_000)` against the unfiltered context, produced eight distinct values, and
failed; the correction was to make the variant's claim about a context rather than about its
own formula.

---

## 7. Method note

Every number above was produced locally at `31a3371`. The native `better-sqlite3` binding was
built from source against local Node headers; `pnpm install --ignore-scripts` followed by
`node-gyp rebuild --nodedir` was required because the environment could not fetch prebuilt
binaries. After `pnpm build`, the full suite reproduces green.

Reproduce with:

```bash
pnpm install && pnpm build && pnpm check
```

To re-confirm §1 independently, count external call sites for the cognitive surface:

```bash
grep -rn "decideWrite\|decideRetrieval\|resolveContradiction\|currentFacts\|sinkhorn" \
  packages --include='*.ts' | grep -v 'cortex-core/' | grep -v '\.test\.ts'
# expected: no matches
```

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
| Provenance-DAG / immutable audit log | `provenance.ts` is a 552-byte type file |
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
| 1 | Extract the reference pipeline's contracts into `S`-compatible form | The instrument must be able to receive the product system | `cortex-memory` passes the existing `MemorySystem` conformance tests |
| 2 | Implement `cortex-memory` composing `decideWrite` → storage → `decideRetrieval` | Makes the cognitive layer *reachable* | ≥95% coverage per dimension, TDD, no mocks |
| 3 | Add a benchmark arm that supplies `cortex-memory` instead of the reference pipeline | Produces the first honest number for the cognitive layer | Paired same-instant A/B against the reference arm |
| 4 | Enforce the ≥95% ceiling in `vitest.config.ts` (`thresholds`) | D4 — the rule is currently convention only | A deliberately under-covered commit must fail CI |
| 5 | Re-measure LongMemEval-S at current `master` | D2 — replaces a 55-commit-stale number | Full N=500, 4 runs, Wilson intervals published |

> **Ordering is deliberate.** Steps 1–3 establish whether the cognitive layer *helps or hurts*
> before any further capability is built on top of it. Building more cognition onto an unmeasured
> base would repeat the error this audit documents.

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

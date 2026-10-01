# AUDIT-EVAL-CONTRACTS

**Scope:** `AUDIT-CODE-VS-DOCS.md` §6.2 step 1 — *"Extract the reference pipeline's
contracts into `S`-compatible form"* — whose stated verification is *"`cortex-memory`
passes the existing `MemorySystem` conformance tests"*.
**Verdict:** the step is **nearly done and the verification it names is already
satisfied by construction**. The contract types were never entangling. What step 1
actually still owes is not an extraction but a **conformance test and a second
implementation**, because the repository has **no `MemorySystem` conformance suite
at all** — the word appears only as a type annotation. Of the four functions step 1
touches, **two are genuinely unreached** by the benchmark, and only one of them is
what §6.2 assumed.
**Measured at revision** `79d74f7`.
**Outcome:** step 1 closed as **already satisfied, with two named deliverables
instead** (§6), plus one dead export found and deleted (§5).

---

## 1. The clause being audited, and what it presumes

§6.2's first row reads:

| # | Task | Why it is first | Verification |
| --- | --- | --- | --- |
| 1 | Extract the reference pipeline's contracts into `S`-compatible form | The instrument must be able to receive the product system | `cortex-memory` passes the existing `MemorySystem` conformance tests |

Three presumptions are packed into that row, and each is checkable:

1. **The contracts are entangled** with the reference pipeline, so extracting them
   is work.
2. **An `S`-compatible form exists** as a target — some shape the contract must be
   bent into.
3. **A `MemorySystem` conformance test suite already exists**, since the
   verification says "the *existing*" tests and asks that a not-yet-written package
   *pass* them.

The audit checks all three. Two are false, and the third is false in a way that
changes what the step should be.

## 2. Presumption 1 is false: nothing was entangled

`MemorySystem` is declared in `packages/cortex-eval/src/types.ts:37` and is
**already** exactly what §6.1 says `cortex-memory` must satisfy:

```ts
export type MemorySystem = {
  name: string;
  answer: (question: string, context: string[], sessions?: string[][]) => Answer | Promise<Answer>;
};
```

One required field, one required method, both already optional-tolerant
(`sessions` is optional and additive). There is no dependency on a class, no
abstract base, no runner handle, no dataset coupling. A package in a different
workspace project that has never heard of `cortex-eval` can satisfy it by declaring
`name` and `answer`.

The extension is a **separate** type, not a fatter one
(`SessionAwareMemorySystem`, `types.ts:52`), and the split is what makes
`cortex-memory` cheap: `MemorySystem & { answerSessions, answerTemporal?, … }`.
Everything beyond `answerSessions` is optional, so a minimal system implements two
things.

`cortex-eval`'s dependency edge already points the right way for this — it depends
on `cortex-core` and `cortex-llm`, and on nothing that would have to depend on it.
`cortex-memory` would depend on `cortex-core`, `cortex-node`, `cortex-llm`, and on
`cortex-eval` **only as a devDependency**, for the conformance types. That is a
type-only edge and it is acyclic.

**Independent recount** (not a census re-read) of every non-test, non-barrel,
non-declaring mention of the eleven contract names re-exported from `types.js`:

| Symbol | Non-test, non-barrel callers |
| --- | --- |
| `Capability` | 7 |
| `Question` | 10 |
| `BenchmarkDataset` | 6 |
| `Answer` | 6 |
| `MemorySystem` | **5** |
| `SessionAwareMemorySystem` | 1 |
| `PerCapabilityResult` | 1 |
| `Metrics` | 3 |
| `AggregateStats` | 1 |
| `AblationResult` | 2 |
| `PerCapabilityPairedStats` | 1 |

Every one has at least one caller, so the census classifies all eleven as
non-orphans and nothing here is dead. `MemorySystem` has five. The bottleneck in
§6.1 was never the *shape* of the contract — it was that **no implementation of it
exists in the product layer**, which is step 2's job, not step 1's.

## 3. Presumption 3 is false: there is no conformance suite

This is the finding that matters.

```
grep -rn "conformance" packages/          → 0 hits
```

The word does not occur in the repository. `MemorySystem` appears only as a type
annotation on parameters (`memory: MemorySystem`) and as an `implements` clause.
**Nothing anywhere asserts that an object satisfying `MemorySystem` behaves in any
particular way.**

That is a larger hole than it looks. `runBenchmark` routes on
`'answerSessions' in system` (`benchmark.ts:20-22`) and then on seven more optional
members. The contract is therefore not "implement `answer`" — it is "implement
`answer`, and every optional path you choose to declare will be called, with these
argument shapes, and must return `Answer`". A system can satisfy the *type* and be
wrong about all of it:

- declare `answerSessions` but return `undefined` for an empty session list;
- declare `answerTemporal` with the parameters in the wrong order — TypeScript
  catches this one, but **not** if the parameter types are compatible
  (`context: string[]` and `sessions?: string[][]` are not, but
  `questionDate?: string` vs `sessions?: string[][]` would be);
- declare `answerAbstention` and have it return a *non-null* answer, which silently
  converts the abstention block into a wrong-answer block;
- declare nothing optional and still be routed correctly (the fallback path).

The last is the subtle one. **A system that implements only `name` + `answer` is
fully conformant**, and that is the configuration `cortex-memory` will most likely
start from. The suite that should exist has to assert **the routing contract**: for
each of the seven optional members, *is the system called on it, and with what?* —
because that is what decides whether declaring a member helps or hurts.

**This is the actual content of step 1.** "Extract the contracts" presumed a
mechanical refactor; the real debt is that §6.2's verification names a test that
does not exist, and `cortex-memory` cannot be verified against a suite nobody
wrote.

## 4. Presumption 2 is false, or rather: there is nothing to bend

"An `S`-compatible form" implies an `S` the contract must be reshaped into. Since
`MemorySystem` has one required method and no coupling, the transformation is the
identity on the type and a **separate** question for the runtime: `cortex-memory`
does not need an adapter, it needs a *decision* about which optional paths it
declares.

That decision is a real one, and it is not step 1's:

| Optional member | Declaring it means | Cost for `cortex-memory` |
| --- | --- | --- |
| `answerSessions` | MR routes to it | Required to be session-aware at all; the CPU-side composition must group by session |
| `answerTemporal?` | TR routes to it with `questionDate` | Without it, TR questions get the plain extractive path — measurably worse for relative time |
| `answerAssistant?` | `single-session-assistant` includes assistant turns | Without it, the evidence turn for those questions is filtered out |
| `answerAbstention?` | ABS routes to a conservative prompt | Without it, an abstention question is answered by choosing among candidates |
| `answerPreference?` | preference/recommendation routes to a generative prompt | Without it, the extractive path abstains on a question that has an answer |
| `answerKnowledgeUpdate?` | `knowledge-update` routes to a qualifier-aware prompt | Without it, "previous" vs "currently" is not made explicit |

Six decisions, each with a measured cost attached elsewhere in the repository. None
of them is a contract extraction.

## 5. What the recount did find: one dead export

Independent trace of which `benchmark.js` exports the benchmark actually reaches:

```
runner.ts  → runAblationReport          (ablation.ts:233, 359, 494, 553, 631, 713, 774, 915, 10+ sites)
ablation.ts → evaluateWithScorerDetailed  (lines 75, 76)
ablation.ts → evaluateWithScorer          (lines 137, 138 — the runs>1 loop)
```

`runBenchmark` and `evaluate` are in the barrel (`index.ts:34-35`) and are **not
reached from the bench at all**. `evaluate` is also not used inside `benchmark.ts`
beyond being defined — it is a one-line convenience wrapper over `runBenchmark`:

```ts
export async function evaluate(dataset: BenchmarkDataset, system: MemorySystem): Promise<Metrics> {
  const answers = await runBenchmark(dataset, system);
  return computeMetrics(dataset, answers);
}
```

Both have callers only in tests (`benchmark.test.ts` drives `runBenchmark` 15
times; `synthetic-benchmark.test.ts` drives `evaluate` twice). Under §33's
criterion — *is this symbol a description of a capability, or a gate on one?* —
these are **descriptions**: they are the harness's public entry points, and a test
suite is a legitimate consumer of a public entry point in a repository whose only
consumer *is* the test suite.

**But `evaluate` is a different case from `runBenchmark`.** `runBenchmark` is the
routing implementation — it holds §3's seven-branch dispatch and is the thing a
conformance suite must drive. `evaluate` is `runBenchmark` plus one call to a
function (`computeMetrics`) that every caller of `evaluate` could call itself, and
which `evaluateWithScorer`'s sibling already calls on a different scoring path.
It adds no routing, no policy, and no state.

**Adjudication: keep `runBenchmark`, delete `evaluate`.** `runBenchmark` is the
routing surface and the subject of the suite §3 says must exist. `evaluate` is
`runBenchmark` + `computeMetrics` with two test callers and no production path —
and the two callers can express the same thing in two lines. Its docstring already
describes exactly that composition ("Run a system and immediately evaluate against
ground truth"), which is the tell: **a function whose documentation is its
implementation is a call site, not an abstraction.**

## 6. A side effect worth recording: `computeMetrics` became an orphan

Deleting `evaluate` (§5) moved the census in a way that is itself a finding:

| Total | Before | After | Cause |
| --- | --- | --- | --- |
| `exports` | 431 | **430** | `evaluate` deleted |
| `withCaller` | 218 | **217** | `evaluate` had none in the counted set |
| `orphaned` | 213 | 213 | unchanged |
| `referencedLocally` | 189 | **188** | `evaluate` was one |
| `unreferenced` | 24 | **25** | **`computeMetrics` entered the class** |

`computeMetrics` was not unreferenced before, and it is not dead now. It was
**counted** before because `evaluate` — the function this audit deleted — called it.
The only remaining callers are four test files:

```
PROD  packages/cortex-eval/src/metrics.ts          (its own declaration)
TEST  packages/cortex-eval/src/__tests__/benchmark-ablation.test.ts
TEST  packages/cortex-eval/src/__tests__/dataset.test.ts
TEST  packages/cortex-eval/src/__tests__/metrics.test.ts
TEST  packages/cortex-eval/src/__tests__/synthetic-benchmark.test.ts
```

Two things follow, and the second is the interesting one.

**`computeMetrics` is a legitimate `unreferenced` member, on §33's criterion.**
It is a *description*: "score this answer vector against ground truth", the exact
computation the whole harness exists to perform, exported from a public barrel. A
library whose only consumer is its own test suite is the normal condition of this
repository — `AUDIT-UNREFERENCED-GROUPS.md` found 26 of 27 members of this class are
interfaces for that reason. It stays.

**But the gate cannot tell "exempt interface" from "deleted last caller".** These
are the same census row. Before this change, `computeMetrics` was proofed by an
accident: a convenience wrapper nobody used happened to mention it. That is not a
reason to keep the wrapper — it is a reason to notice that **`unreferenced` is a
class whose membership can move for reasons unrelated to the symbol's own merit**,
and §33's criterion (description vs. gate) is the thing that adjudicates it, not the
census.

The `bench/` directory is worth stating explicitly here, because it is the natural
objection: `packages/cortex-eval/bench/run.ts` *is* counted by the census — it
imports thirteen symbols from the barrel, and `tools/export-census.mjs`'s own
docstring names it "the benchmark's actual entry point". `computeMetrics` is simply
not one of the thirteen. The benchmark reaches scoring through
`runAblationReport` → `ablation.ts`, never through `computeMetrics` directly. So
this is not a census blind spot; the bench genuinely does not call it.

## 7. Repository-wide acceptance

`pnpm check` — `test:tools && build && lint && typecheck && census:check && test && format` —
exits 0.

```
packages/cortex-core  Tests  216 passed  98.75 | 98.67 | 100 | 98.75
packages/cortex-node  Tests   16 passed   100 | 98.61 | 100 |  100
packages/cortex-llm   Tests  131 passed  99.27 | 98.11 | 100 | 99.27
packages/cortex-eval  Tests 1527 passed  99.88 | 99.05 | 100 | 99.88
                             1890 tests, 0 failures
```

All four dimensions of all four packages clear the 95% gate. The suite grew
1879 → 1890: +11 for `memory-system-conformance.test.ts`.

Two `tsc` errors were caught that `vitest` did not, both from the deletion:

- `Metrics` became an unused import in `benchmark.ts` — **except it did not**, because
  `evaluateWithScorer` still returns it. Removing it was wrong and `tsc` said so. This
  is the `vitest`-does-not-typecheck gap again (`AUDIT-UNREFERENCED-GROUPS.md` §6.3
  recorded the same shape).
- The conformance suite's `Seen` type needed `sessions: string[][] | undefined` rather
  than `sessions?: string[][]`, because `exactOptionalPropertyTypes` is on and the
  harness passes the argument positionally.

## 8. A second side effect, this one caused by the audit's own prose

Writing a `MemorySystem` docstring that pointed at the conformance suite made
`runBenchmark` **disappear from the census**:

```
in baseline not in census: ['cortex-eval: runBenchmark']
```

The docstring names the function in prose — *"`runBenchmark` routes on the presence of
the optional members"* — and the census counts a whole-word occurrence in a comment or
a string as a reference, deliberately and with a measured rationale:

> This deliberately does not parse imports. A symbol referenced only in a comment or a
> string would be counted as called. That over-counts in the safe direction: the tool's
> job is to find definitely-unused symbols, and a false negative (missing a real orphan)
> is far less costly here than a false positive.

So the gate was working as designed, and the new prose is a **real** reference: a
reader of `types.ts` can now find `runBenchmark` from it. Net ledger movement across
this change:

| Total | Before | After | Cause |
| --- | --- | --- | --- |
| `exports` | 431 | **430** | `evaluate` deleted |
| `withCaller` | 218 | **218** | −1 for `evaluate`, +1 for `runBenchmark` |
| `orphaned` | 213 | **212** | — |
| `referencedLocally` | 189 | **187** | −1 `evaluate`, −1 `runBenchmark` |
| `unreferenced` | 24 | **25** | +1 `computeMetrics` |

`runBenchmark` was `referenced-locally` (called inside `benchmark.ts`; the barrel and
tests do not count). It is now non-orphaned, on the strength of documentation. **A
prose mention moving a ledger entry is the documented behaviour of this instrument, not
a defect in it — but it is worth knowing when reading the ledger**, because it means a
`referencedLocally` count can be reduced by writing about a symbol rather than by
wiring it.

## 9. Step 1's closure, restated

| §6.2's original wording | What the audit found | Replacement deliverable |
| --- | --- | --- |
| "Extract the reference pipeline's contracts into `S`-compatible form" | Nothing to extract; `MemorySystem` is already the target and already uncoupled (§2, §4) | **None.** Closed as already satisfied |
| "`cortex-memory` passes the existing `MemorySystem` conformance tests" | **No such suite exists** (§3) | **Write the conformance suite**, in `cortex-eval`, driving `runBenchmark`'s routing over a minimal and a full implementation |
| (not in the original row) | `evaluate` is an unabstracted wrapper reached only from tests (§5) | **Delete `evaluate`**; keep `runBenchmark` |

The ordering of §6.2 is unaffected: the conformance suite belongs before step 2,
because it is the thing step 2 is verified against. It is also strictly more
valuable than the extraction the row asked for — the extraction would have moved
code between files, while the suite defines what "a memory system" means
executably.

Nothing in §6.2 steps 2–5 changes. Step 3's arm will supply a `SessionAwareMemorySystem`,
which is `MemorySystem` plus `answerSessions`; whether it also declares the five
optional paths is §4's table, decided by measurement, not by the contract.

## 10. What this audit did not establish

- **Whether the routing is correct.** The suite §6 specifies does not exist yet,
  so this document can say only what the routing *does*, not that it is right. The
  seven branches come from the LongMemEval question types and the comments cite
  measurements for each; none of that is re-derived here.
- **Whether `cortex-memory` should declare each optional path.** §4 lists the
  decisions; it does not make them. Each needs an arm.
- **Whether `cortex-eval` as a devDependency of `cortex-memory` is acceptable.**
  It is type-only and acyclic (§2), but it does mean the product package's tests
  import the instrument's types. The alternative — moving `MemorySystem` into
  `cortex-core` — is a larger change with its own migration cost, and §6.1's
  layering table deliberately puts contracts in `cortex-core` while putting the
  *benchmark* contract in `cortex-eval`. That tension is unresolved and is recorded
  here rather than silently resolved.
- **The five `formatStructuredContext` / `buildQaPrompt` / `parseQaAnswer`-class
  exports.** They are `referenced-locally` orphans, i.e. used inside
  `natural-language-memory.ts` and exported unnecessarily. That is the 189-strong
  class §32 declined to converge, and this audit does not reopen it.

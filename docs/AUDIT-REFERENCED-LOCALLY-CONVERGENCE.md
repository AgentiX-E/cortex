# AUDIT-REFERENCED-LOCALLY-CONVERGENCE

**Scope:** the 206 exports classified `referenced-locally` — exported, used inside their own
file, and named by nothing outside it.
**Verdict:** the classification is correct and **is not a worklist**. 182 of the 206 are
package-barrel entries, so their `export` is public API; 5 more are imported by tests, so
removing it breaks the suite. **19 are genuine**, and their `export` keyword is removed here.
The barrel is deliberately untouched.

Measured at revision `0f231f4`, so the counts in §1 and §2 are the **starting** state: 206
`referenced-locally` and 28 `unreferenced`. §5 records where they land.

---

## 1. What `referenced-locally` means, and what it was read as

`AUDIT-ORPHAN-CLASS-CONFLATION.md` split the orphan count into two classes so that "used only
inside its own file" and "nothing refers to it anywhere" stop reading as one number:

| Class | Count | Meaning |
| --- | --- | --- |
| `referenced-locally` | 206 | `export` present; every reference is inside the declaring file |
| `unreferenced` | 28 | no reference anywhere |

The name of the first class invites one reading — *"an unnecessary `export` keyword"* — and §6
of that document committed to acting on it: *"It is now mechanical: `listReferencedLocally`
produces the worklist."*

**That sentence was wrong, and this document corrects it.** `referenced-locally` says where the
references are. It does not say whether the `export` is load-bearing, and for 187 of the 206 it
is.

---

## 2. The 206 decompose into three groups

Two questions separate them, both answered by a command rather than by reading.

**Question A — is the symbol re-exported from its package barrel?**

```python
barrels = {p: open(f'packages/{p}/src/index.ts').read() for p in PACKAGES}
in_barrel = re.search(r'(?<![A-Za-z0-9_$])' + re.escape(name) + r'(?![A-Za-z0-9_$])', barrels[pkg])
```

**Question B — does a test import the name from its declaring module?**

```python
pat = re.compile(r'import\s*(?:type\s*)?\{[^}]*\b' + re.escape(name) + r'\b[^}]*\}'
                 r'\s*from\s*[\'"][^\'"]*' + re.escape(basename) + r'\.js[\'"]')
```

| Group | Count | Why the `export` is there | Action |
| --- | --- | --- | --- |
| Re-exported from a barrel | **182** | It **is** the package's published interface | **None.** Removing it shrinks the API. |
| Test imports it by name | **5** | A test needs it reachable | **None.** Removing it breaks the suite. |
| Neither | **19** | `export` advertises a consumer that does not exist | **Remove the keyword.** |

The grouping itself is the finding: **the worklist is 19 items, not 206.**

### 2.1 The 182 are a product decision, not a cleanup

A barrel entry is a promise to a consumer outside the repository. `packages/*/src/index.ts`
declares roughly this much surface:

| Package | Barrel lines | `export` statements |
| --- | --- | --- |
| `cortex-core` | 105 | 21 |
| `cortex-eval` | 325 | 35 |
| `cortex-llm` | 54 | 8 |
| `cortex-node` | 3 | 2 |

Converging these would change what the four packages publish. That is a decision about the
product with a compatibility cost, and it belongs to a roadmap call in the shape of
`ProvenanceNode` — not to a census-driven sweep. **Recorded here so the boundary of this change
is explicit**: the barrels are unchanged, and a test asserts that (§5).

### 2.2 The 5 are pinned because a mechanical sweep would break them

```
cortex-eval: classifyCurveMembership     ← recall-curve.test.ts
cortex-eval: detectBareAbstention        ← natural-language-memory.test.ts
cortex-eval: formatStructuredContext     ← natural-language-memory.test.ts
cortex-eval: overlapScore                ← fact-memory.test.ts
cortex-eval: resolveTimeoutMs            ← report-runner.test.ts
```

Each is in the barrel-absent group, so a sweep applying the rule "not in a barrel and not used
elsewhere ⇒ de-export" would remove all five. The code compiles either way; the failure appears
as an import error in a suite with no apparent connection to the change. They are listed
explicitly in the test so that failure arrives with the reason attached.

---

## 3. The 19, and why each is safe

Every one has at least one reference inside its own module — that is what placed it in
`referencedLocally` rather than `unreferenced` — so none is a deletion candidate,
only a de-export candidate.

| Module | Symbols | Kind |
| --- | --- | --- |
| `cortex-core/src/graph/memory-graph.ts` | `EdgeKind`, `EdgeAttributes` | Types used by the class in the same file |
| `cortex-eval/src/rerank-factory.ts` | `DEFAULT_LOCAL_RERANK_MODEL`, `DEFAULT_LLM_RERANK_BASE_URL`, `DEFAULT_LLM_RERANK_MODEL`, `RERANK_PROVIDERS`, `RerankProvider` | Config defaults and their derived union |
| `cortex-eval/src/llm-factory.ts` | `THINKING_TIMEOUT_MS` | Per-attempt deadline |
| `cortex-eval/src/judge.ts` | `JudgeQuestionType` | Template selector union |
| `cortex-eval/src/variance.ts` | `PairwiseMovement` | Between-run analysis record |
| `cortex-eval/src/retrieval-diagnostics.ts` | `RetrievalDiagnosticOptions` | Options bag |
| `cortex-eval/src/natural-language-memory.ts` | `QaPromptOptions`, `ConservativeQaPromptOptions`, `buildAggregationCritiquePrompt`, `buildRevisedAggregationPrompt`, `extractAggregationLedger`, `AggregationKind`, `projectSessions`, `QueryExpansionOptions` | Options bags and internal prompt/parse helpers |

### 3.1 Verification performed before the edit

Three checks, all by command, all negative for every one of the 19:

1. **No named import** of the symbol from its declaring module, anywhere.
2. **No namespace import** (`import * as ns`) of its declaring module, combined with a bare
   mention — the case a named-import check alone would miss.
3. **No bare mention at all** outside its own declaration file, including `bench/` and
   `tools/`, and **no barrel entry**.

A fourth check confirmed the opposite direction: each symbol **is** used inside its own module,
so the declaration cannot be removed along with the keyword.

> One latent hazard was checked specifically. `RerankProvider` is derived from
> `RERANK_PROVIDERS` as `(typeof RERANK_PROVIDERS)[number]`. Removing `export` from a `const`
> while a derived type in the same file consumes it is safe — the type still resolves locally —
> but it would not be safe if the derived type were the only consumer and lived in another
> module. It is not, and `rerank-factory.ts` supplies four other local uses.

---

## 4. The change

The `export` keyword is removed from 19 declarations across 7 modules. Nothing else moves:
declarations stay, signatures stay, behaviour stays.

Each touched module gains a short note in its docstring:

```
 * ## Module-private exports
 *
 * Some declarations below are deliberately not exported. They are used only inside
 * this file, appear in no package barrel, and are referenced by no test or tool —
 * so `export` would advertise a consumer that does not exist.
```

The note has a specific job: a reader who lands in `rerank-factory.ts` and sees five unexported
constants cannot tell whether they were a decision or a leftover. Absent an explanation, the
cheapest repair for the next person is to add `export` back — which is how the state being
fixed here accumulated.

---

## 5. Verification

Test file: `packages/cortex-eval/src/__tests__/export-surface.test.ts` (6 assertions).

It pins **both sides**, which is the point:

| Assertion | Direction |
| --- | --- |
| the 19 carry no `export` | forward |
| the 19 still declare their symbol | de-export ≠ deletion |
| the 5 test-imported keep `export` | reverse |
| the four barrels still re-export | scope boundary |
| no barrel names a de-exported symbol | the two above cannot be gamed together |
| every touched module carries the note | discoverability |

**Three defect injections, no assertion accepted on its passing alone:**

| Injection | Result |
| --- | --- |
| Re-export `RERANK_PROVIDERS` in `rerank-factory.ts` | `1 failed \| 5 passed` — names the file, the symbol and the line |
| De-export `overlapScore` (test-imported) in `fact-memory.ts` | `1 failed \| 5 passed` — the reverse direction fires |
| (build) unused imports in the test file | `tsc` caught two, `vitest` had passed — see §6 |

### 5.1 Measured result

| | Before | After | Δ |
| --- | --- | --- | --- |
| Exports (`totalSymbols`) | 450 | **431** | **−19** |
| Orphans | 234 | **215** | −19 |
| `referencedLocally` | 206 | **187** | **−19** |
| `unreferenced` | 28 | 28 | **0** ← must not move |

All three of the first rows fall by exactly 19 and `unreferenced` does not move. The last row is
the load-bearing one: de-exporting an internal symbol does not make it unreferenced, because its
in-module uses remain. Had `unreferenced` risen, the edit would have removed references rather
than reachability — a different and much worse change.

The measurement was taken by stashing and re-running, not by arithmetic on the previous
document's figures: the `452` quoted in §2.1 belongs to an earlier revision and is stale,
which is why this table was produced by measuring both sides.

Ledger invariants hold: `215 = 187 + 28`, and `knownOrphans` = `locations` = `sum(groups)` =
`orphanClass` = `215`.

`pnpm check` exits 0. 1854 tests. Coverage **unchanged on every dimension**:

| Package | Stmts | Branch | Funcs | Lines |
| --- | --- | --- | --- | --- |
| `cortex-core` | 98.74 | 98.67 | 100 | 98.74 |
| `cortex-node` | 100 | 98.61 | 100 | 100 |
| `cortex-llm` | 99.27 | 98.11 | 100 | 99.27 |
| `cortex-eval` | 99.88 | 99.05 | 100 | 99.88 |

---

## 6. One process finding, from this change's own build

The first version of the test file imported `readdirSync` and `relative` and used neither.
**`vitest` ran it green; `tsc` failed.** The gate that caught it was `pnpm check`'s build step,
not the test run.

This is worth one paragraph because it is the same shape as
`AUDIT-COVERAGE-ANNOTATION-BLIND-SPOT.md` §4.4: the test runner and the compiler answer
different questions, and a suite that only runs one of them reports on the wrong one. It is
also a reminder that **`pnpm check` is the unit of verification here, not `vitest`** — the
partial gate was green for a change that did not build.

---

## 7. What this document does not claim

**It does not claim the 182 barrel entries should stay.** It claims converging them is a
product decision about four packages' published interfaces, with a compatibility cost, and
therefore not part of a census-driven cleanup. If the roadmap decides the surface is too wide,
that is a separate change with its own evidence — and the census will produce the worklist for
it exactly as it did here.

**It does not claim the 19 were defects.** They were correct code carrying an imprecise
declaration. Nothing behaved differently before or after, and the unchanged coverage figures
are the measurement of that.

**It does not claim `referenced-locally` should be abolished as a class.** It is a correct
measurement. What was wrong was reading it as a worklist in `AUDIT-ORPHAN-CLASS-CONFLATION.md`
§6, and that sentence is now annotated rather than deleted.

**It does not claim the 19 are permanently private.** The note in each module says the opposite:
restoring an `export` is the right change when a real caller appears. What is removed is the
practice of declaring the caller in advance of one existing.

---

## 8. The generalisable finding

> **A classification of where references are cannot be turned into a worklist without asking
> what each reference is for.** `referenced-locally` answers "who reads this name?" — 206. The
> actionable question is "is the `export` load-bearing?" — 19.

The two questions differ by a barrel lookup and an import scan, both one command each. The cost
of not asking them was a committed plan to change 206 declarations, 187 of which are either a
package's published API or a test's dependency.

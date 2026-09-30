# AUDIT-UNREFERENCED-GROUPS

**Scope:** the 27 exports in the census's `unreferenced` class, grouped by **why**
they are unreferenced rather than by whether they are.
**Verdict:** the class is **26 public surface and 1 defect** — and the defect is not
the kind the class name suggests. It is not "unused code". It is a **switch reader
that names a switch nothing sets**, exported from a package barrel, so that reading
it teaches the wrong name for a live feature.
**Measured at revision** `ef6a04c`. Closure committed as this change.

---

## 1. What `unreferenced` means, exactly

The census defines the class precisely (`packages/cortex-core/src/export-census.ts`):
a symbol is *unreferenced* when it has zero mentions from

- any file other than the one that declares it,
- test files,
- barrel files.

All three exclusions are load-bearing, and the third is why this class is mostly
public surface: **every exported symbol is in a barrel by definition**, so counting
barrels would make the class empty.

Re-derived for this audit, independently of the census, on the 27:

| Check | Result |
| --- | --- |
| Non-test, non-barrel source files mentioning it | **0 for all 27** |
| `tools/` consumers | **0 for all 27** |
| `bench/` consumers | **0 for all 27** |
| Days in a package barrel | **27 of 27** |
| Test files importing it by name | **27 of 27** |

The last two rows are the finding. Every member of the class is *simultaneously*
published API and exercised by a named test import. That is a specific situation,
and it is the opposite of the one the class name suggests.

> **The class answers "does production code mention this?" It does not answer "is
> this a problem?"** A symbol can be zero-referenced because no *code* needs it and a
> *consumer outside the repository* does — which is what a library's public surface
> is. That is not a defect; the absence of an internal caller is the definition of
> an interface.

---

## 2. Three discriminators that do NOT work, and why that matters

Each was tried and rejected. Recording them is more useful than recording the one
that survived, because each looked decisive and was not.

### 2.1 "Count the production references" — measures the wrong thing

The first pass counted non-test, non-barrel files mentioning each symbol and got
**exactly 2 for all 27**. That uniformity was the tell: it was the barrel plus the
declaring file, i.e. the two exclusions the census already applies. The column
carried no information at all. A measurement whose every value is identical is not
discriminating; it is echoing its own frame.

### 2.2 "Is the test asserting the output?" — a proximity heuristic, and wrong

The second pass looked for `expect(` within four lines of a call site, to separate
"a test drives this" from "a test calls this to move the counter". It flagged three
symbols as never asserted. All three were false positives:

| Symbol | What the heuristic missed |
| --- | --- |
| `squaredEuclideanCostMatrix` | Assertions at `math.test.ts:84-85`, six lines below the call, on the returned matrix |
| `clearJudgeCache` | It **is** the behaviour under test — clear, then assert `calls === 1` |
| `defaultValueFunction` | Passed as an argument to `decideWrite`; asserted through the decision it produces |

The third one is the instructive failure: it is never called by name at all, only
passed, so no call-site heuristic can ever see it. **Assertion is not a property of
a line; it is a property of a trace**, and this audit did not measure traces.

### 2.3 "Is the docstring promising something?" — true of everything

Every one of the 27 has a docstring, because the repository's standard requires one.
A discriminator that fires for 27 of 27 is measuring the standard, not the symbol.

---

## 3. The one that survives: does the symbol name a mechanism, or gate one?

The question that separates the 27 is not about references. It is:

> **Does this symbol describe a capability, or does it decide whether a capability
> runs?**

A capability with zero internal callers is a library surface. A **gate** with zero
internal callers is a defect, because a gate exists only to be consulted — nothing
else gives it meaning.

Applying it leaves exactly one:

```ts
export function isCandidateDiscriminationEnabled(options: {
  readonly enableCandidateDiscrimination?: boolean;
}): boolean {
  return options.enableCandidateDiscrimination === true;
}
```

### 3.1 What it is

`candidate-context.ts:192`, exported from the barrel at `index.ts:148`. It reads
`options.enableCandidateDiscrimination` — and **that field's only other occurrence in
the repository is its own declaration**. Nothing sets it. Nothing else reads it.

The function is driven only by `candidate-context.test.ts:40-49`, two tests that
assert what it returns for `{}`, `{false}` and `{true}`. Those tests pass, and they
are the reason the defect is invisible: a pure boolean reader with three cases is
fully covered, so every conventional signal reads green.

### 3.2 The feature it appears to gate is real, wired, and named something else

The candidate-discrimination feature **is** delivered end to end:

| Link | Site |
| --- | --- |
| Environment | `CANDIDATE_DISCRIMINATION` |
| Read at the entry point | `bench/run.ts:433` — `readToggle(process.env, 'CANDIDATE_DISCRIMINATION')` |
| Runner option | `runner.ts:144` — `candidateDiscrimination?: boolean` |
| Feature-config derivation | `runner.ts:260`, `351`, `1228` |
| Prompt builders | `natural-language-memory.ts:1818`, `1899` — the instruction is appended |
| Workflow input | `.github/workflows/benchmark.yml:188` |

Two names for one concept. One is live and measurable; the other is inert and
exported. **That is worse than dead code**, which is the whole of §3.3.

### 3.3 Why "just leave it, it is harmless" is wrong

Dead code costs nothing but space. This costs a reader's conclusion.

A reader who wants to know how to turn candidate discrimination on will grep the
obvious name. They find `isCandidateDiscriminationEnabled`, exported from the
package's public API, reading `options.enableCandidateDiscrimination` — and no caller
anywhere. The reasonable inference is **"this switch is off, and the feature is off
by construction."** That inference is false: the feature is on whenever
`CANDIDATE_DISCRIMINATION=1` is set, and it has been measured with ablation.

The two names are near-synonyms, which is the worst case. They are not so different
that a reader would suspect a second concept; they are similar enough that a reader
assumes they are the same switch at two layers.

### 3.4 This is the `AUDIT-B7-DEAD-SWITCH` family, and outside that audit's scope

`AUDIT-B7-DEAD-SWITCH.md` closed a three-break defect in the **live** switch: no
benchmark input could set it, the options type had no such field, and the
prompt-builder closure dropped the argument. All three were fixed.

That audit's subject was `candidateDiscrimination`. This symbol is the same feature's
**inert sibling** — a different name, never wired, never anyone's subject. It
survived an audit of the very feature it names, because the audit was looking for
whether the live switch worked, and this one is not the live switch.

---

## 4. Disposition of all 27

### 4.1 The 26 kept, with their reason

Grouped by what they are, since the reason is the same within each group:

| Group | Count | Members | Why `export` is load-bearing |
| --- | --- | --- | --- |
| `cortex-core` algorithm layer | 12 | `consolidate`, `createMemory`, `currentFacts`, `currentValue`, `decideRetrieval`, `decideWrite`, `defaultValueFunction`, `findContradictions`, `initialFsrsState`, `l2Distance`, `resolveContradiction`, `squaredEuclideanCostMatrix` | These are the package's stated product: "a validated library of cognitive contracts and pure algorithms" (`ARCHITECTURE.md`). Their value functions, bitemporal queries and FSRS state are exported for a consumer the repository does not contain — the missing `cortex-memory` seam specified in `AUDIT-CODE-VS-DOCS.md` §6 |
| Storage backends | 3 | `PgStorage`, `SqliteStorage`, `ensurePgSchema` | `cortex-node`'s entire purpose. `ARCHITECTURE.md` names them as the two `Storage` implementations. A storage class with a caller inside the repository would be a coupling, not a feature |
| Test infrastructure | 6 | `createLongMemEvalMini`, `generateSyntheticBenchmark`, `createEmbeddingFromEnv`, `FactMemorySystem`, `runEmbeddingBenchmark`, `flattenSessions` | Datasets and systems that suites construct directly. `createLongMemEvalMini` alone is used 11 times in `report-runner.test.ts` to build the dataset under test, and `index.test.ts:38` asserts it is reachable through the barrel |
| Diagnostics & measurement | 5 | `flattenTurns`, `candidateSpanCount`, `clearJudgeCache`, `sidesLandInDistinctClusters`, `createRetryStatsAggregate` | Instruments that measure or isolate. `clearJudgeCache` is test isolation that is itself asserted; the rest feed reporting |

Nothing here is wired to nothing. Their absence of internal callers is the definition
of the interface they are.

### 4.2 The 1 removed

`isCandidateDiscriminationEnabled`, its `enableCandidateDiscrimination` field, its
barrel line, and its two tests. See §5.

### 4.3 What this deliberately does NOT do

It does not touch the **182 barrel entries** from
`AUDIT-REFERENCED-LOCALLY-CONVERGENCE.md`. Those are a published-interface question
with a compatibility cost, and one symbol's deletion is not their precedent — the
same boundary that document states.

It also does not re-open the **live** `candidateDiscrimination` switch, which is wired
and measured.

---

## 5. The change

| # | Change | File |
| --- | --- | --- |
| 1 | Delete the reader and its field | `cortex-eval/src/candidate-context.ts` |
| 2 | Remove the barrel entry | `cortex-eval/src/index.ts` |
| 3 | Delete the two tests that drove it | `cortex-eval/src/__tests__/candidate-context.test.ts` |
| 4 | Add a guard test for the shape | `cortex-eval/src/__tests__/candidate-switch.test.ts` |

Item 4 is the point. Deleting one switch reader does not stop the next one; the guard
test asserts the property that made this one a defect:

- exactly one switch **name** exists for the feature and it is the live one;
- the live switch is **bound to an environment variable** at the entry point;
- the live switch is **read by the prompt builder**, so it is not merely plumbed;
- the retired name is absent from source, barrel and tests.

The third assertion is the one that would have caught the original B7 defect, where
the flag was declared, plumbed and then dropped by a three-parameter arrow that type-
checked perfectly.

---

## 6. Verification

### 6.1 Before deletion — five checks, all negative

1. No caller outside its own test (`grep` across `packages/`, `tools/`, `.github/`).
2. No environment or CLI binding: `ENABLE_CANDIDATE*` and `enableCandidate*` return
   **nothing** outside the declaration and its own tests.
3. No docstring anywhere promises it (`docs/`, `ARCHITECTURE.md`, `README.md`,
   `CONTRIBUTING.md` — the only two mentions in the repository are audits *listing*
   it as an orphan).
4. No workflow input maps to it.
5. The live switch is independently verifiable as the live one (§3.2).

### 6.2 The census moves by exactly one, in one direction

```
exports           430 -> 429
orphaned          214 -> 213
unreferenced       27 ->  26
referencedLocally 187 -> 187   (unchanged)
withCaller        216 -> 216   (unchanged)
```

Invariants hold: `knownOrphans = locations = sum(groups) = orphanClass = 213`, and
`referencedLocally + unreferenced = orphaned` (187 + 26 = 213). `census:check` exit 0.

### 6.3 Three defect injections, each caught by a different assertion

| Injection | Result |
| --- | --- |
| Re-declare the inert reader and its field | `1 failed \| 5 passed` — names the declaration |
| Sever `options.candidateDiscrimination` from the 3 prompt-builder reads | `1 failed \| 5 passed` — **the B7 shape**, reported as `expected 0 to be greater than or equal to 2` |
| Remove the `readToggle(process.env, 'CANDIDATE_DISCRIMINATION')` binding | `1 failed \| 5 passed` — reports the entry point lost its env route |

The second is the one worth having: it reproduces the original defect's *shape*
rather than its symbol, so it fails for the reason B7 happened.

### 6.4 A hole this audit's own first draft had

The guard test's fourth assertion originally required the live switch name in
`candidate-context.ts` — the file that owns the feature. **It failed on the
unmodified tree**, and that failure was informative rather than a bug to work around:
`candidate-context.ts` contains `CANDIDATE_DISCRIMINATION_INSTRUCTION` and **no switch
field at all**. The module that owns the feature declared a different switch name from
the one the feature is driven by — which is §3.2 restated as a property of the file
layout. The assertion was corrected to point at `runner.ts` and the instruction
constant, and the observation recorded here.

---

## 7. What this document does not claim

- **It does not claim the 26 are safe to delete.** It claims their `export` is
  load-bearing, for the reasons in §4.1. Whether the published surface should be this
  wide is a product decision, as `AUDIT-REFERENCED-LOCALLY-CONVERGENCE.md` §2.1 states.
- **It does not claim the class is now clean.** It is 26 public surface; that is a
  finding, not a resolution.
- **It does not claim assertion is unmeasurable.** §2.2 rejects a *proximity* heuristic
  for it, not the question. Measuring it properly needs traces (which calls execute)
  rather than lines, and that instrument does not exist here.
- **It does not claim `candidateDiscrimination`'s wiring is complete.** §3.2 shows it
  is wired and measurable; `AUDIT-B7-DEAD-SWITCH.md` owns its correctness.

---

## 8. Generalisable conclusion

**A zero-reference count is a measurement. "Unreferenced" as a label is a
classification. Neither is a work item, and the work item here was not the one the
class name predicted.**

Twenty-six of the 27 are unreferenced *because they are interfaces* — that is what
being an interface means inside a repository that contains no consumer. The
twenty-seventh is unreferenced *because it gates a feature that is gated by a
different name*, and that second kind is invisible to every reference-oriented
measure this repository owns: it has a caller (its test), it has coverage (100%), it
has a docstring, and it is exported.

The question that found it was not "who calls this?" but:

> **Does this symbol do work, or does it decide whether work happens?**

A symbol that decides needs a decision to feed. A gate with no input is not unused
code — it is a **false statement about the system**, published under a name a reader
will believe. Its cost is exactly the inference in §3.3, and it is paid by whoever
next tries to turn the feature on.

The rule: when a symbol is unreferenced, check whether it *is* the capability or
whether it *gates* the capability. Capabilities export cleanly with no caller. Gates
cannot — the absence of a caller for a gate means the thing it gates is unreachable,
or that the gate is fiction. Ask which one, and if the feature demonstrably runs,
the gate is fiction.

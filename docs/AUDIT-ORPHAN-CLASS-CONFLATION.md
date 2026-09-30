# AUDIT — The Orphan Class Conflation

**Status:** instrument defect found, fixed, and tested. The distinction the
census was missing now exists, and the 31 names nothing refers to anywhere are
readable for the first time.
**Found by:** the P1 item left open by the previous round — _make the census tell
"referenced only inside its own file" apart from "referenced nowhere"_.

---

## 1. What the census could say, and what it could not

`node tools/export-census.mjs` answered one question: does any non-test,
non-barrel file other than the declaring one mention this symbol? A zero means
orphan. The measure was correct and exactly checkable. It was also, on its own,
insufficient, and the insufficiency had a signature: **235 orphans and 0
defects were the same number.**

Both of these read identically as "orphan":

```ts
// Used by three functions in this file. `export` is unnecessary. The code is fine.
export function logGamma(z: number): number { /* ... */ }

// Nothing refers to this. Not another file, not this one.
export function consolidate(...): ConsolidationStats { /* ... */ }
```

The first is a keyword to delete. The second is a function to delete. A tool that
cannot tell them apart cannot be swept with, and the review it enables is a
per-entry argument from scratch every time.

## 2. The rule

A symbol is `referencedLocally` when its own declaring file still mentions it
**outside its declaration line and outside the declaration's own body**.

The body exclusion is the load-bearing half. Without it:

```ts
export function fuseRerank() {
  return fuseRerank(); // self-recursion, not a caller
}
```

reads as locally referenced. The sentinel for this already existed — the test
`does NOT count the declaring file itself` feeds exactly that fixture — and the
new flag is asserted against the same fixture, so the two rules cannot drift.

The span is found by a brace-balanced lexical scan (`bodyEndLine`) rather than an
AST. That keeps the module pure and synchronous, which is what lets every rule in
it be driven by a literal string in a unit test. The cost is that a brace inside a
string or template literal can shift the span; the consequence is bounded and in
the safe direction, because a drifted span is too _large_, which pushes a mention
into the body and classifies the symbol `unreferenced` — the class whose members
get read. The other direction would hide debt.

## 3. The measured split

| Class               | Count   | Meaning                                                     |
| ------------------- | ------- | ----------------------------------------------------------- |
| `referenced-locally` | **206** | live call site in its own file; the `export` may be unnecessary — see the amendment at §6 |
| `unreferenced`       | **31**  | nothing mentions it anywhere; a dead-code candidate         |
| total               | **237** | the old undifferentiated number                             |

The 31 were checked against a second, independently written scanner: for each
name, how many non-test, non-barrel, non-`dist` files mention it at all? The
answer was **exactly one — its own declaration file — for all 31**, and the two
classifications agreed on every key with no diff. They are, in full:

`ProvenanceNode`, `consolidate`, `createMemory`, `currentFacts`, `currentValue`,
`decideRetrieval`, `decideWrite`, `defaultValueFunction`, `findContradictions`,
`initialFsrsState`, `l2Distance`, `resolveContradiction`,
`squaredEuclideanCostMatrix`, `CANDIDATE_ANNOTATION_VERSION`, `FactMemorySystem`,
`candidateSpanCount`, `clearJudgeCache`, `createEmbeddingFromEnv`,
`createLongMemEvalMini`, `extractDate`, `flattenSessions`, `flattenTurns`,
`generateSyntheticBenchmark`, `isCandidateDiscriminationEnabled`,
`isTemporalQuestion`, `runEmbeddingBenchmark`, `sidesLandInDistinctClusters`,
`createRetryStatsAggregate`, `PgStorage`, `SqliteStorage`, `ensurePgSchema`.

They exist in exactly three places, and all three are places the census
deliberately excludes: their own `export` line, a barrel `export {} from`, and a
test `import`. That is the whole explanation of "235 orphans and 0 defects": the
tool could always see this list, it just had no way to say it.

## 4. The boundary that was decided, and why

A mention in a comment or a string counts as a local reference. This is a
deliberate over-count and it is the only choice that does not reclassify live
code as dead:

| Symbol                        | Evidence                                                    | Under a strict rule      |
| ----------------------------- | ----------------------------------------------------------- | ------------------------ |
| the text-hashing helper       | called **6×** inside template literals in `retrieval.ts`      | falsely **dead**         |
| the candidate schema key      | 2 template interpolations inside `appendLabel`                | falsely **dead**         |
| `sinkhorn`                    | 2 docstring/error-string mentions, no body use                | —                        |
| `retrieveTopK`                | **one comment line is its only mention in the repository**    | correctly dead, but      |

Two live, heavily-used symbols would be reported dead by the strict rule, and one
genuinely dead symbol would be reported correctly. A census that cries wolf is
one its readers stop believing, so the strict rule is the worse trade. The price
is that `retrieveTopK` stays in the `referenced-locally` class on the strength of
a single comment, and that is recorded here rather than papered over.

## 5. The defect this change introduced, and how it was caught

Writing the new docstrings **named four real orphans as examples** — the
text-hashing helper, the candidate schema key, `sinkhorn`, `retrieveTopK`. The
census matches whole-file text, comments included, so `export-census.ts` became a
caller of all four. Overnight:

- all four left the orphan list,
- `--check` reported **no new orphans** and exited 0,
- the baseline still listed them, so the ledger disagreed with the tool,
- and nothing failed, because a census that finds _less_ is quieter, not louder.

It was caught only by diffing the new orphan set against the baseline and asking
why four entries had gone. The fix was to describe those symbols instead of
naming them, and the behavior is now pinned by a test
(`counts a docstring mention as a caller, which is why prose must not name
orphans`) so that the next person who documents the over-count cannot retire a
finding with prose. The general shape is the one the B7 annotation producer had:
**the failure mode of a measurement is a clean run.**

## 6. What the gate does now, and what it still does not

`--check` is unchanged in what it enforces: an orphan absent from the baseline
still fails the gate, verified end-to-end by planting an export and watching the
gate exit 1, then removing it and watching it exit 0.

Added:

- `CensusReport.referencedLocallyCount` / `unreferencedCount`, with
  `referencedLocallyCount + unreferencedCount === orphanCount` asserted.
- `listReferencedLocally` / `listUnreferenced`, which partition `listOrphans`
  (asserted: the two lists sorted together equal the orphan list).
- `--json` gains `referencedLocally` and `unreferenced`; **`orphans` keeps its
  exact shape**, so the baseline rebuilder and every existing consumer are
  unaffected.
- The ledger gains `totals.referencedLocally`, `totals.unreferenced`, and an
  `orphanClass` map, with the schema self-check asserting that the map's key set
  equals `knownOrphans` exactly.

Still not measured, and deliberately: reachability. A symbol referenced only by
another orphan still counts as called. That needs a root set, and it is a
roadmap judgement rather than a mechanical one.

## 7. Not done, and why

**The 31 are not deleted.** Naming them is this round's deliverable; deleting them
is a separate, reviewable change that should be argued entry by entry — some may
be deliberate surface held for a roadmap item. The census now makes that argument
possible by producing the list on demand, which it could not do before.

**The 206 unnecessary `export` keywords are not removed.** That is API-surface
convergence, not defect repair, and it is the next P1 item. It is now mechanical:
`listReferencedLocally` produces the worklist.

> **Amendment, `AUDIT-REFERENCED-LOCALLY-CONVERGENCE.md`.** "It is now mechanical" and
> "produces the worklist" were both wrong, and the error is the kind this document
> exists to catch. `referenced-locally` says *where the references are*, not whether the
> `export` is load-bearing — and for 187 of the 206 it is: **182 are re-exported from a
> package barrel**, so the keyword **is** the published interface, and **5 are imported
> by tests**, so removing it breaks the suite. The actual worklist was **19**. Turning a
> classification into a worklist requires asking what each reference is *for*; that is
> two commands per symbol, and skipping them nearly produced a committed plan to change
> 206 declarations. The 19 are now converged and the class reads **187**.

# AUDIT — The Thirty-One Unreferenced Exports

**Status:** audited entry by entry. The classification is mechanical and re-runnable.
**31 audited at the start; one closed by the fix this audit produced, leaving 30.**
No entry is deleted by this document.
**Found by:** the `unreferenced` class introduced in
[`AUDIT-ORPHAN-CLASS-CONFLATION.md`](AUDIT-ORPHAN-CLASS-CONFLATION.md), which
narrowed 235 orphans to the 31 nothing mentions.

---

## 1. What "unreferenced" means here, precisely

The census classifies a symbol `unreferenced` when its name does not occur outside
its own declaration line, in its own function body, or in any other production
file. That is: no caller, and no local use either.

Before treating these as deletions, three questions have to be answered for each
one, because each has a different remedy:

| Question                                     | If yes                                    | If no                            |
| -------------------------------------------- | ----------------------------------------- | -------------------------------- |
| Is it exercised by a test?                    | it is built and unwired — **a defect**     | it is dead weight                |
| Is it publicly exported from a package barrel? | it is API surface — **a decision**        | it is an internal leftover       |
| Does a live sibling in the same file call it?  | the module works without it — **grooming** | the file is a stranded island    |

## 2. The measurement

Re-runnable: `node tools/export-census.mjs --json`, then classify `unreferenced`
against `packages/*/src/__tests__/*.ts`, the two repositories' `docs/`, and the
other `export` lines of the same file.

| Answer            | Count | Reading                                            |
| ----------------- | ----- | -------------------------------------------------- |
| exercised by tests | **29** | built and never wired — the B7 defect class         |
| not exercised      | **2**  | genuinely unreferenced anywhere                     |
| in a package barrel | **31** | every single one is public surface                  |

Re-measured after the fix in §3.2 closed one entry: **29 exercised, 1 not
exercised, 30 total.**

**The headline is 29, not 31.** Nearly every member of this class is a symbol with
a passing test and no production call site — which is not dead code, it is
implemented-but-unwired code, the exact shape of the annotation-producer defect
this repository has already paid for once.

> **Amendment, `AUDIT-UNREFERENCED-CLASSES.md`.** "Nearly every member" was the right
> hedge and the wrong resolution: the 29 are **not one class**. Re-reading them as four
> (public surface / test instrument / built-but-unwired / **superseded**) finds two
> members that a two-way split actively hid — `isTemporalQuestion` and `extractDate`
> were not unwired at all, they were replaced by `classifyTemporalQuestion`, which
> `natural-language-memory.ts:581` calls. Both are now deleted, moving the counts below
> to **27 exercised, 1 not exercised, 28 total**. The measurement in this table stands;
> what changed is that "has a test and no caller" turned out to be a question rather
> than an answer.

## 3. The two that are genuinely unreferenced

### 3.1 `cortex-core: ProvenanceNode` — `domain/provenance.ts:3`

The only one of the 31 that is isolated on all three axes: no test, no caller, no
local use, and no live sibling. It is the sole content of its file, which holds
nothing but the type declaration:

```ts
export type ProvenanceNode = {
  id: string;
  memoryId: string;
  kind: string;
  timestamp: number;
  parents: string[];
  metadata?: Record<string, unknown>;
};
```

Nothing imports the module.

> **Amendment, `AUDIT-COVERAGE-ANNOTATION-BLIND-SPOT.md`.** This file opens with
> `/* istanbul ignore file -- type-only declaration, no runtime code */`, and that
> sentence was quoted here as evidence that the type "also carries a coverage
> exclusion". **It did not.** The annotation was inert twice over: the file compiles
> to zero statements, so there was nothing to suppress, and vitest's v8 provider does
> not honour the `istanbul` prefix at all. Deleting it left the reported figure
> bit-identical. The quotation is replaced above with the code itself, because the
> conclusion in the paragraph below never rested on the annotation — the symbol is
> unreferenced on the census evidence, which is what the audit measured.

**Reading:** a domain type for memory provenance that was declared, exported from
the barrel, and never built on. `AUDIT-CODE-VS-DOCS.md` records the same class of
gap elsewhere: the type is part of the described design and not part of what runs.

**Disposition:** not a mechanical delete. It is either the seed of a roadmap item
(provenance tracking) or a speculative type that should be removed with that
decision recorded. **Requires a roadmap call, not a census call.**

### 3.2 `cortex-eval: CANDIDATE_ANNOTATION_VERSION` — `candidate-context.ts:45` — **CLOSED**

More interesting than it looks, because its docstring states a contract:

```ts
/**
 * Bumped when the annotation's shape changes in a way a reader could observe.
 * Two revisions that render the same context must be indistinguishable, so this
 * is a schema version rather than a library version.
 */
export const CANDIDATE_ANNOTATION_VERSION = 1;
```

It is exported from the barrel and **emitted into no artifact**. Searching the
whole repository for `annotationVersion`, `schemaVersion` and
`ANNOTATION_VERSION` finds only this declaration and its re-export.

**Reading:** the docstring describes a guarantee ("two revisions that render the
same context must be indistinguishable") that nothing enforces, because no
rendered context carries the version. This is not dead code — it is a **recorded
intent with no mechanism behind it**. The same shape as
`AUDIT-B7-DEAD-SWITCH.md`: a row that said `已实现，待 benchmark` and was neither.

**Disposition — taken: option 1, emit it.** The guarantee turned out to be
enforceable, because the render path is live: `renderDiscriminatedContext` is
reached from `natural-language-memory.ts`, so the annotation does run and the only
missing piece was that nothing recorded which revision rendered a context.

Closed in three parts:

1. `NaturalLanguageMemorySystem.annotateWithCandidateSides` now reports whether it
   applied, from the point where the decision is made. Four ways to decline exist
   (switch off, no turns, fewer than two sides, no clusters), and a caller
   recomputing them would be a second copy that drifts.
2. `DecisionTrace.candidateAnnotationApplied` carries that fact per question,
   because the annotation declines per question — it is a property of the
   retrieval, not of the arm.
3. `AblationReport.candidateAnnotationVersion` records the revision, **derived
   from the traces rather than from the option**. `retrievalSides: true` on a
   dataset where no question offers two sides annotates nothing, and a report
   reading the option would claim a revision it never used. `0` records "ran
   without the annotation", which is a different claim from an absent field
   meaning "artifact older than this field".

Verified by measurement, not by argument: the census moved the symbol out of the
`unreferenced` class (31 → 30) because it now has a real production consumer.

## 4. The twenty-nine exercised-but-unwired

Every one of these has at least one test file referencing it and no production
call site. Grouped by module, with the live siblings that show the module itself
is in use:

| Symbol                            | Package      | Test files | Live siblings in the same file |
| --------------------------------- | ------------ | ---------- | ------------------------------ |
| `consolidate`                     | cortex-core  | 3          | —                              |
| `createMemory`                    | cortex-core  | 4          | `MemoryValue`                  |
| `currentFacts`                    | cortex-core  | 1          | —                              |
| `currentValue`                    | cortex-core  | 3          | —                              |
| `decideRetrieval`                 | cortex-core  | 2          | —                              |
| `decideWrite`                     | cortex-core  | 2          | —                              |
| `defaultValueFunction`            | cortex-core  | 1          | —                              |
| `findContradictions`              | cortex-core  | 1          | —                              |
| `initialFsrsState`                | cortex-core  | 1          | `FsrsState`, `retrievability`, `review` |
| `l2Distance`                      | cortex-core  | 2          | `cosineSimilarity`, `norm`, `normalize` |
| `resolveContradiction`            | cortex-core  | 4          | —                              |
| `squaredEuclideanCostMatrix`      | cortex-core  | 1          | —                              |
| `FactMemorySystem`                | cortex-eval  | 5          | `splitKeyValue`, `tokenize`    |
| `candidateSpanCount`              | cortex-eval  | 1          | 8 live                         |
| `clearJudgeCache`                 | cortex-eval  | 1          | `AnswerJudge`, `createLlmJudge` |
| `createEmbeddingFromEnv`          | cortex-eval  | 2          | 2 live                         |
| `createLongMemEvalMini`           | cortex-eval  | 3          | —                              |
| `extractDate`                     | cortex-eval  | 1          | `daysBetween`                  |
| `flattenSessions`                 | cortex-eval  | 1          | 7 live                         |
| `flattenTurns`                    | cortex-eval  | 1          | 6 live                         |
| `generateSyntheticBenchmark`      | cortex-eval  | 1          | —                              |
| `isCandidateDiscriminationEnabled` | cortex-eval | 1          | 8 live                         |
| `isTemporalQuestion`              | cortex-eval  | 1          | `daysBetween`                  |
| `runEmbeddingBenchmark`           | cortex-eval  | 1          | 11 live                        |
| `sidesLandInDistinctClusters`     | cortex-eval  | 1          | 5 live                         |
| `createRetryStatsAggregate`       | cortex-llm   | 2          | 5 live                         |
| `PgStorage`                       | cortex-node  | 1          | —                              |
| `SqliteStorage`                   | cortex-node  | 1          | —                              |
| `ensurePgSchema`                  | cortex-node  | 1          | —                              |

**Reading:** this is not a deletion list. `PgStorage` and `SqliteStorage` are the
storage adapters a library consumer would instantiate by name — they have no
caller *in this repository* precisely because they are the entry points to it.
`l2Distance`, `initialFsrsState` and `extractDate` sit beside live siblings and are
the unused members of a coherent family. `runEmbeddingBenchmark` is one of 17
exports in `runner.ts`, 11 of which are live.

**Disposition:** these are **API-surface questions, not defect questions**. The
remedy for most is one of: wire it (if the roadmap wants it), narrow its `export`
to module scope (if only its own file needs it — but the census says its own file
does not need it either), or delete it together with its test. None of those is
mechanical, and doing them in bulk would be a large unreviewable change.

## 5. Why this document deletes nothing

The census can now prove a symbol is unreferenced. It cannot prove a symbol is
unwanted, and the difference is the whole of this document.

Three reasons not to batch-delete the 31:

1. **Two are not dead code.** `ProvenanceNode` is a roadmap decision, and
   `CANDIDATE_ANNOTATION_VERSION` is a contract with no mechanism. Deleting either
   silently would remove the evidence that a decision is owed.
2. **Twenty-nine have tests.** A symbol with a passing test is covered by the
   repository's own quality gate; removing it also removes test coverage the gate
   counts, so a bulk delete would move the coverage number for reasons unrelated
   to correctness.
3. **All thirty-one are in a package barrel.** They are public surface. A census
   that includes "exported for an external consumer" cannot distinguish that case
   from a leftover, and this repository being private does not make the API
   surface not-a-decision.

**What this document does deliver:** the 31 are now named, classified, and
re-runnable. The next person to touch any of them starts from evidence instead of
from a grep.

## 6. Closing one of them properly

The audit's own finding is acted on for the one entry where the remedy is
unambiguous and needs no roadmap call. See
[`FIX-ANNOTATION-VERSION-CONTRACT.md`](FIX-ANNOTATION-VERSION-CONTRACT.md).

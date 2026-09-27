# AUDIT — The B7 criterion named a count, and a count is not a roster

## 0. What this document is for

B7's pre-registered criterion (`09-progress-and-delivery-report.md` §2.5.10.6)
says the **9 targeted questions must move**. That sentence was publishable and
remains unfulfilled, because until now **nothing recorded which 9**.

This is not a caveat about sample size. It is a structural defect with a precise
shape: a criterion expressed as a **count** cannot be evaluated against an
**artifact**, because two runs can both report 9 and disagree about which 9, and
no comparison of the two artifacts would reveal it. The number agreeing is not
evidence that the populations agree.

`packages/cortex-eval/src/b7-cohort.ts` is the fix. This document records the
decision inside it, the two classifications it refuses to merge, and what its
mutation tooling found.

---

## 1. The decision: recompute the roster, never transcribe it

The tempting implementation is a constant:

```ts
// The 9 questions §2.5.10.2 separated. DO NOT EDIT.
const TARGETS = ['gpt4_76048e76', 'gpt4_e414231f', /* … seven more */];
```

This is wrong, and the reason is not style. A transcribed roster is
**unfalsifiable**: every later run is compared against a list that no artifact can
contradict. If the clustering is revised, or the dataset build shifts, or the
tokeniser changes, the constant keeps asserting *these 9 are targeted* while the
pipeline targets a different 9 — and the check passes and means nothing.

So the roster is **recomputed from the same inputs the intervention sees**:

| Input | Why this input and not a convenient equivalent |
| --- | --- |
| `groundTruth` / `answer` | The two values whose separability defines the target set |
| `turns` | The retrieved context — a roster computed against other turns is about a different question |
| `grounded` | The upstream classifier's judgement, applied **before** clustering |
| `questionId` | Ids, not indices: indices drift with the dataset build |

The consequence is deliberate: **this module can disagree with the published 9.**
`verifyTargetCohort` reports that disagreement rather than reconciling it. A
roster that can only ever confirm is not a criterion.

---

## 2. Two classifications that must not be merged

The first draft of this module had one bucket for "not a target". Writing tests
against real data split it, and the split is the more useful output of the whole
exercise.

| Observation | Bucket | What it is a fact about |
| --- | --- | --- |
| The reader produced the truth's value | `identical` | **The reader** |
| Two values exist but no cluster could be formed for one | `unseparable` | **The instrument** |

Merging them is the same error the upstream record already corrected once: a
reader that answered correctly is not a limitation of the method, and an
instrument that could not decide is not a finding about the reader. Reporting
them as one number would let an instrument failure read as a result.

The split also forced an ordering. `valuesAreIdentical` is checked **before**
clustering, because `candidateSides` returns no sides at all when both values
carry the same terms — so the identical case would otherwise fall into
`unseparable` and be reported as "the sides could not be told apart" for a reader
that simply answered right.

---

## 3. A branch that was removed because it is unreachable

`computeTargetCohort` originally classified into `targets` and `sameCluster`,
mirroring the prose ("truth and answer in different clusters" vs. the same one).

`sameCluster` is unreachable, and the reason is one line in a dependency:
`clusterCandidates` emits **one cluster per non-empty side**, so two non-empty
sides always produce two distinct cluster ids — the ids differ because they are
positional. "Truth and answer share a cluster" cannot happen through this pair.

Verified rather than assumed:

```
sides    -> [["chain"],["total"]]
clusters -> [{"id":1,"terms":["chain"],"idx":[0]},{"id":2,"terms":["total"],"idx":[1]}]
```

Two responses were possible, and the wrong one is attractive:

- **Keep the bucket.** It compiles, it reads as a classification, and it is always
  empty. This is the failure mode the record already names (§2.5.10.4): *they made
  a property look like it was carried by the code when it was always carried by
  the input shape.*
- **Assert the invariant instead.** The dependency's behaviour is now stated as
  `sidesLandInDistinctClusters`, exported and tested **against the real
  `clusterCandidates`**, so a change that started merging sides would fail a test
  rather than silently turning the target set into a subset of itself.

The second was taken.

---

## 4. Mutation injection: 15 of 16 caught, 1 declared equivalent

`tools/inject-b7-cohort.py`. Sixteen mutations aimed at the decisions above:
grounding applied before rather than after clustering, the identity check
disabled, truth's cluster read off the answer's side, an unmatched id compared as
`undefined`, the regression guard skipped, non-targets classified as targets.

Three survived the first run. Each was diagnosed by **reading the mutated
output**, not by editing the test suite.

| Mutation | Diagnosis | Action |
| --- | --- | --- |
| `identical-empty-value-counts-as-match` (`\|\|` → `&&`) | Genuine gap: both values empty is reachable and was untested | **Added a test** |
| `identical-set-equality-dropped` | Behaviourally equivalent | **Removed, measured** |
| `cluster-identity-by-reference` | Behaviourally equivalent | **Removed, measured** |

**Why the two are equivalent**, since "equivalent" is a claim and not an excuse:

- *Set equality.* The early `a.length !== b.length` return already holds, and
  `contentTerms` de-duplicates, so a subset of `b` with equal length implies
  `a === b`. Measured: `contentTerms('bike bike bike')` is `['bike']`.
- *Reference identity.* `clusterCandidates` builds `usable` with
  `sides.filter(s => s.length > 0)` and stores `usable[i]` **directly**, so when no
  side is empty the stored array *is* the side array. The lookup is reached only
  after `sides.length >= 2`, and an empty side is dropped by the filter without
  changing which sides survive. Measured: byte-identical `computeTargetCohort`
  output across the corpus.

Writing tests to kill them would freeze a distinction that **no input can
observe** — the fourth survival semantics, applied rather than argued around.

### 4.1 A survivor forced a simplification, not a test

An earlier `sameTerms` was an element-wise loop. Its mismatch branch was
unreachable for the same reference reason, so it was replaced with a
separator-joined comparison, with the equivalence recorded in the code comment.
A loop whose body only ever runs to completion **is** a `join`; leaving the loop
in place would have preserved a branch that reads as a safeguard.

---

## 5. What the criterion checks, and in what order

`judgeCriterion` implements all three clauses of §2.5.10.6, and the order is not
cosmetic:

1. **Non-targets must not regress.** Checked **first**, and not overridable by the
   clause it guards. A guard that can be overridden by the thing it guards is not
   a guard. Any change outside the target set is a regression — **including a flip
   to abstention**, which a bare accuracy comparison scores identically to a wrong
   answer.
2. **Targets must move.** If every target answers identically in both arms, the
   verdict is `no-move` and **not** `fail`. The published criterion says this is a
   finding about the reader, to be reported rather than tuned away.
3. Only then is a gain claimable.

---

## 6. Not claimed

- **Not** that the published 9 is wrong. It may be exactly right. What is
  established is that it was **unconfirmable**, and that a roster computed from
  artifacts can now confirm or contradict it.
- **Not** an end-to-end result. This module evaluates a criterion; it does not
  produce one. The A/B has not been dispatched.
- **Not** a scope change. The same 11-of-14 grounded TR failures, the same target
  definition, the same single-switch A/B.

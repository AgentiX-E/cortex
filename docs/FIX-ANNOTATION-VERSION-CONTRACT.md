# FIX — The Annotation Version Contract

**Status:** fixed, wired, and verified by measurement. The census moved the symbol
out of the `unreferenced` class as a result.
**Found by:** the audit of the 31 unreferenced exports
([`AUDIT-UNREFERENCED-EXPORTS.md`](AUDIT-UNREFERENCED-EXPORTS.md) §3.2), which is
the one entry of the 31 whose remedy needed no roadmap call.

---

## 1. The defect

`CANDIDATE_ANNOTATION_VERSION` was exported from `candidate-context.ts`, re-exported
from the package barrel, and read by nothing. Its own docstring states the contract
it exists to serve:

```ts
/**
 * Bumped when the annotation's shape changes in a way a reader could observe.
 * Two revisions that render the same context must be indistinguishable, so this
 * is a schema version rather than a library version.
 */
export const CANDIDATE_ANNOTATION_VERSION = 1;
```

No rendered context and no report carried the value. So the guarantee was
**unverifiable by construction**: two artifacts rendered by different revisions of
the annotation were indistinguishable in exactly the way the docstring forbids, and
nothing in the repository could tell.

This is the `AUDIT-B7-DEAD-SWITCH.md` shape — a contract that is described but has
no mechanism. The switch that was set and printed while its only consumer sat in a
branch that never ran is the same defect one level down: a thing that exists,
announces itself, and changes nothing.

## 2. Why the remedy was to emit it rather than delete it

The constant's docstring was not aspirational. `renderDiscriminatedContext` is
reached from `natural-language-memory.ts:1334`, so the annotation **does** run in
production; the only missing piece was the record. Deleting the constant would have
removed the evidence that a guarantee was claimed and unkept, which is the one
outcome that leaves the repository worse than before.

So the fix completes the contract rather than retracting it.

## 3. The three parts

| Part | Where | What it does |
| ---- | ----- | ------------ |
| the fact | `NaturalLanguageMemorySystem.annotateWithCandidateSides` | reports `{ context, applied }` from the point the decision is made |
| the trace | `DecisionTrace.candidateAnnotationApplied` | carries it per question |
| the report | `AblationReport.candidateAnnotationVersion` | records the revision, or `0` |

### 3.1 The fact is reported where it is decided

`annotateWithCandidateSides` has four ways to decline: the switch is off, there are
no turns, fewer than two sides, or no clusters. A caller inferring the outcome
would be a second copy of that logic, and the second copy is the one that drifts.
Same reasoning as the retry-fire counter, and the same sentence applies: only the
fact that a mechanism **ran** separates a feature that is inert on a dataset from
one that was never wired.

### 3.2 The trace carries it per question

The annotation declines per question — fewer than two sides is a property of the
question's retrieval, not of the arm. A run-level flag would assert the annotation
was applied to questions it silently skipped.

### 3.3 The report derives the version from the traces, not the option

This is the part that would have been easy to get wrong. The option says what was
**asked for**; the traces say what **happened**. `retrievalSides: true` is
perfectly compatible with a run that annotated nothing, and a report reading the
option would claim a revision it never used.

```ts
function annotationVersionOf(traces: readonly DecisionTrace[]): number {
  return traces.some((trace) => trace.candidateAnnotationApplied === true)
    ? CANDIDATE_ANNOTATION_VERSION
    : 0;
}
```

## 4. `0` is not the same claim as absent

The report field follows the rule `cohortCoverage`, `retryFires` and
`featureConfig` already share, with one addition:

| Value     | Claim                                              |
| --------- | -------------------------------------------------- |
| `1`       | the annotation rendered at revision 1 this run      |
| `0`       | this run rendered no annotation                     |
| *absent*  | this artifact was produced before the field existed |

Collapsing `0` and absent would let a report that predates the field pass for a
report that states the annotation was off — a claim about a run, made by an
artifact that says nothing about it. The Markdown renders the `0` case explicitly
as `` `not applied` `` rather than omitting the line, because the reader's question
is "was the annotation on, and at which revision", and an absent line answers
neither half.

## 5. Verification

Not an argument — a measurement, in three layers.

**Unit.** `report-annotation-version.test.ts` (4 tests) pins the render for a
present value, the explicit `not applied` for `0`, the absence for an old artifact,
and that the value survives the JSON round trip as a number (`0` must not become
`null` the way `NaN` does — `docs/FIX-REPORT-JSON-ROUNDTRIP.md`).

**Wiring.** `b7-main-path-wiring.test.ts` gains two tests. One asserts the flag
tracks the switch on **both** arms, because a flag that is always true and a flag
that is always false are equally useless and only the contrast is informative. The
other asserts the flag is `false` when the producer declines with the switch **on**
— a single-turn context has no second side to mark — which is the case a
run-level flag would get wrong.

**End to end.** `report-runner.test.ts` gains two tests driving
`runNaturalLanguageBenchmark` with `retrievalSides: true` over a dataset where no
question offers two sides, asserting the report records `0` and the Markdown says
`not applied`.

**The census closes the loop.** The whole point of the audit was a symbol nothing
reached. After the fix the census reports it as called:

```
before   cortex-eval: CANDIDATE_ANNOTATION_VERSION    in the `unreferenced` class
after    GONE: ['cortex-eval: CANDIDATE_ANNOTATION_VERSION']
         unreferenced: 31 -> 30
```

The `unreferenced` class shrank by exactly the one entry this document closes, and
`ProvenanceNode` remains — correctly, because its remedy is a roadmap decision
rather than a wiring fix.

## 6. What this does not claim

It does not claim the annotation's guarantee is now **enforced** — only that it is
now **recorded**. A reader can see which revision rendered an artifact, which is
what the docstring's "must be indistinguishable" requires to be checkable at all.
An active check would have to compare two artifacts and fail on equal context with
different versions; that is a genuinely new instrument and is not built here.

# Design: `cortex-memory`, the composition layer

> **Status:** implemented and green. `AUDIT-CODE-VS-DOCS.md` §6.2 step 2.
> **Verification:** `pnpm check` exit 0; 129 tests; 100 / 100 / 100 / 100 coverage;
> `memory-system-conformance.test.ts` passes unmodified against `CortexMemory`.

## 1. What the package is for

Before this package, `cortex-core`'s four cognitive primitives —
`decideWrite`, `decideRetrieval`, `consolidate`, `resolveContradiction` — had
**zero production callers**. Their only references were the barrel and their own
unit tests. The cognitive layer was not wrong; it was *unreachable*, and a layer
nothing can reach is a layer nothing can measure.

`cortex-memory` is the seam that makes it reachable. Its one job:

> Compose `cortex-core`'s value gates into a runnable object that satisfies
> `cortex-eval`'s `MemorySystem` contract.

It is deliberately **not** a copy of the reference pipeline. See §3.

## 2. The honest claim

Step 2 makes the cognitive layer **reachable**. It does not make it **better**.

The reference pipeline (`cortex-eval/src/natural-language-memory.ts`, 3151
lines) remains the control arm. Whether the gated composition beats it is a
measurement, and that measurement is step 3 — which must be pre-registered
before dispatch, per `AUDIT-CODE-VS-DOCS.md` §6.3. Building more cognition on an
unmeasured base is the error the audit documents.

## 3. Why not port the reference pipeline

Porting it would produce a second arm that differs from the first only in file
location. It would measure nothing, and it would carry the reference pipeline's
shape into a package whose stated purpose is to replace that shape.

The measurable difference is **what decides admission**:

| | Reference pipeline | `cortex-memory` |
| --- | --- | --- |
| Admission | lexical / embedding retrieval score clears a threshold | `cortex-core`'s value function clears a threshold |
| Prompt shape | eleven builders, one per capability, each restating the layout | one builder parameterised by an answer contract |
| Abstention | the model is asked to notice the absence | the gate detects it before the model is consulted |

The third row is the one that can be *mechanically* better rather than merely
different: a `retrieve: false` from `decideRetrieval` is a machine-derived
abstention, and it cannot hallucinate and does not cost a request.

## 4. Layout and dependency direction

```
packages/cortex-memory/
  src/
    types.ts       CortexMemoryOptions, GateOptions
    admission.ts   admitTurns, clockAwareValueFunction       PURE
    sessionize.ts  admitSessions, selectSessionBudget        PURE
    prompt.ts      buildPrompt, buildSessionPrompt           PURE
    parse.ts       parseAnswer, isAbstention, ABSTAIN_TOKEN  PURE
    memory.ts      CortexMemory                              the only async file
```

Five of six files are pure: no clock, no I/O, no randomness beyond a parameter.
That is what lets the whole admission and prompt layer be tested by direct
assertion rather than by orchestration.

```
cortex-core  <--  cortex-memory  -->  injected Storage / LLM / Embedding
                       ^
                       | devDependency, type-only
                  cortex-eval
```

`cortex-memory` imports `MemorySystem` and `Question` from `cortex-eval` as
**types only**, through a devDependency. No runtime cycle forms, and step 3's
bench arm will live under `bench/`, which is outside the library build. This
resolves the tension `AUDIT-CODE-VS-DOCS.md` §35.9 recorded; the fallback it
named — move `MemorySystem` into `cortex-core` — remains available and is not
needed.

## 5. The routing declarations

`runBenchmark` routes on the *presence* of optional members, so what
`CortexMemory` declares is not style — it is the thing under test.

| Member | Declared | Mechanism |
| --- | --- | --- |
| `answerSessions` | **required** | Session boundaries. Without it the system is not session-aware and MR questions fall to the flat path. |
| `answerTemporal?` | yes | The question date is the reference point for relative time, and the flat path cannot receive it at all. |
| `answerAbstention?` | yes | **Gate mechanism.** `decideRetrieval`'s below-threshold result is a machine-derived abstention. |
| `answerAssistant?` | yes | Evidence for `single-session-assistant` questions lives in an assistant turn. |
| `answerKnowledgeUpdate?` | yes | **Gate mechanism.** A previous-vs-current question is a bitemporal query, and `cortex-core` carries `currentFacts` / `currentValue` / `findContradictions` for it. |
| `answerPreference?` | **deferred** | A gate filters *evidence*; a preference question asks for a *suggestion*. Declaring it would route questions into a path with no mechanism behind it. |

Deferring `answerPreference` is asserted, not assumed: the conformance suite
checks that preference questions reach the flat path and that the contract tail
they receive is the extractive one.

## 6. Three defects found while building

### 6.1 `defaultValueFunction` reads the wall clock

`cortex-core`'s `defaultValueFunction` computes recency as
`Math.exp(-(Date.now() - lastAccessedAt) / 30 days)`. It is correct for a
library that cannot know its caller's clock, and wrong for a composition layer
that was handed one: `now` was injected all the way down and then ignored at the
bottom, so admission would be unreproducible and a replayed benchmark would
admit a different set of turns on every run.

`clockAwareValueFunction(now)` restates the same four arithmetic operations
against the injected clock. It is a deliberate duplicate, and the tests pin the
two together so they cannot drift.

### 6.2 The prompt budget could drop the abstention token

The first `fitToBudget` ended with `assembled.slice(0, maxChars)` under a
comment claiming the instructions "must survive verbatim". The comment described
an intention the code did not implement: the instruction block sits at the end,
so a small enough budget truncated it away while keeping the evidence — a
prompt that asked a question and removed the model's ability to decline.

The second version split the decision across an early return and a separate
truncation branch, and the two allocated differently, so the token appeared at
one budget, vanished at a larger one, and reappeared later. **Non-monotonic.**

The third version spends the budget in a stated priority order and never
revisits a decision:

1. the instruction block, which names the token;
2. the question;
3. the evidence, truncated to what is left.

A prompt that loses (1) and keeps (3) removes the ability to decline. A prompt
that loses (2) and keeps (1) is at least evaluable — the model abstains. The
tests assert monotonicity across *every* budget, not one boundary, which is what
distinguishes a priority order from two heuristics that agree at the sampled
points.

### 6.3 Two redundant branches, deleted rather than covered

`isAbstention` carried a trailing-label rule and a "leading label on a
single-line response" rule. For a single-line response the last line *is* the
whole text, so the second rule could never decide anything the first had not.
Two rules that always agree are one rule with a redundant copy.

`answerSessions` carried a `selected.length === 0` guard that no test could
reach, because `selectSessionBudget` admits the highest-value session when none
fits. The guard was found by failing to cover it, which is the useful failure
mode: an uncovorable branch is a claim that a state exists.

`parse.ts`'s `lastNonEmptyLine` needed `lines[i] ?? ''` under
`noUncheckedIndexedAccess` while `split` returns a dense array, so that arm
could never fire. It was replaced by a scan whose terminating case is reachable,
and `isAbstention` was exported so the blank-input case is asserted through the
predicate instead of being an untestable arm inside a private helper. No `v8
ignore` was used anywhere.

## 7. Defect injection

Three injections, each expected to be caught by a *different* subset:

| # | Injection | Caught by | Count |
| --- | --- | --- | --- |
| 1 | `answerTemporal` routed through the flat path, dropping `questionDate` | `memory-conformance.test.ts` | 2 / 126 |
| 2 | Write threshold tightened by `1e-9` | `admission.test.ts` | **0 / 126 at first** → 2 / 129 after adding the equality test |
| 3 | Session labels dropped from `formatEvidence` | `prompt.test.ts` + `branch-coverage.test.ts` | 2 / 129 |

Injection 2 is the instructive one. It passed every test in its first run,
because every threshold assertion sat clearly on one side of the line and none
of them exercised *equality*. `decideWrite` uses `>=`, so the boundary is a real
behaviour with a real observable difference, and it was untested until the
injection said so. The three equality tests added in response are the reason the
table's third column changes between runs.

## 8. What is deliberately absent

- **No provider.** `CortexMemory` takes a `cortex-core` `LLM` and never
  constructs one. No API key, no network call, no dependence on a quota. The
  Zhipu embedding quota exhaustion that currently blocks benchmark scheduling
  cannot affect this package's tests.
- **No storage.** `Storage` is injected but unused in step 2: the benchmark
  hands each question its own context, so a store would add an unmeasured
  dependency and buy nothing testable. It enters in step 3, when an arm has to
  survive across questions.
- **No claim of improvement.** See §2.
- **No `answerPreference`.** See §5.

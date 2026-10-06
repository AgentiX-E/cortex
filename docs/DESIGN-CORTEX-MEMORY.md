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

### 6.4 The value ceiling, and why it was a defect

`admission.ts` passed `sourceTrust: 0.5` explicitly to `createMemory`. Because the
value function is `confidence * sourceTrust * (0.5 + 0.5 * recency)` and admission
pins `lastAccessedAt` to the injected clock, `recency` is exactly `1` and the value
of **every** admitted turn is exactly `0.5`. Measured: content lengths 1, 29 and
10000 all give `0.5`; `threshold > 0.5` admits nothing.

This was found by dispatch, not by review. `PREREGISTRATION-CORTEX-MEMORY-ARM.md`
§7.5 records the reading — a repaired program scoring `6.45%` against `6.40%`,
because `retrievalThreshold=0` cannot close a gate whose maximum observable value
is `0.5`. §40.6 states the general form: **the value range is part of the
interface, it is just not written in the signature.**

`MemoryValue.sourceTrust` is documented as `[0, 1]`, so the composition layer had a
narrower domain than the model it composes, and the shrinkage was invisible:
`decideWrite` accepts any `number`, and an unreachable threshold produces no error,
only always-false. Three consequences, each wrong independently of any benchmark:

1. the write gate's upper half was unreachable, making it a two-state switch;
2. `selectSessionBudget` ranks by the best admitted value, and every value was
   identical — measured, three sessions with deliberately different evidence all
   ranked `0.5`, so best-of collapsed to its tie-break;
3. `contradiction/resolve.ts` fuses on `confidence * sourceTrust`, so a rumour and
   a first-hand observation were indistinguishable.

`GateOptions.sourceTrust?: number` fixes all three at once, and its **default does
not move**. That is what separates the change from a re-tuning: a caller who sets
nothing gets the previous behaviour, so every measurement taken before the field
existed keeps its meaning, and only the *reachable* set grows. Verified after the
change: `sourceTrust: 1` yields value `1`, a threshold of `0.6` admits a
fully-trusted turn and rejects a default one.

The validation rejects out-of-range and `NaN`, naming the value with `String` rather
than `JSON.stringify` — the latter renders `NaN` as `null`, which reports an
argument the caller never passed.

**This does not license arming the gate in a dispatch.** Choosing a value changes
the question, so it requires its own registration. The field is the remedy; the
registration is a separate deliverable.

### 6.5 Reachable is not discriminating: per-turn `confidence`

§6.4 raised the ceiling and its last paragraph said the arming needed its own
registration. It got one, the registration was dispatched, the gate did not close
once, and investigating that produced a second defect with the same shape one
level down.

The measurement is in `docs/09-progress-and-delivery-report.md` §49 (mirrored as
`07-sota-roadmap.md` §4.1.9): at `sourceTrust: 1` every admitted turn carries
exactly `1`, so the reachable range is the **set** `[0, 1]` and yet every cut
inside it is still all-or-nothing — `0.9999` admits everything, `1 + 1e-9` admits
nothing. §6.4's fix moved the point; it did not turn the point into a
distribution. **A gate whose input is constant cannot discriminate, whatever the
range it is compared against.**

The cause is structural, and `admitTurns` had fixed all three factors for every
turn it constructs:

| Factor | Value | Why it could not vary |
| --- | --- | --- |
| `confidence` | `1` | not passed, so `createMemory` defaulted it |
| `sourceTrust` | one value | one value per admission by definition |
| `recency` | `1` | `lastAccessedAt === createdAt === now`, so `exp(0)` |

`GateOptions.confidenceFor?: (turn: string) => number` is the repair, and
`confidence` is the only factor with room. It is a callback rather than a
`number[]` aligned with the input because it is evaluated against the turn it is
deciding: a parallel array could disagree with the input order and no type would
notice.

**The signal itself is deliberately not in this package.** A real quality estimate
is lexical overlap, retrieval rank, or an embedding score, and none of those can
be computed here — `cortex-memory` depends on `cortex-core` only and reads no
embedding model, so measuring turn quality in the composition layer would make it
depend on a retrieval mechanism it exists to sit above. This layer owns the
*mechanism*; whoever has a *measurement* injects one. It is the same boundary
`valueFunction` and `CortexMemoryOptions.llm` already use.

`confidence.ts` ships one signal anyway — `confidenceFromLength`, monotone
saturation over `min(1, length / 2000)` — and the reason is the arm: a
registration whose variation is a private closure inside an excluded entry point
is variation no test can reach and no reader can audit. It is chosen for being the
*weakest* defensible signal: no model, no vocabulary, no tuning corpus, and
legible enough that a reader can check it by eye. It is not a claim that length
predicts relevance, and the arm's artifact records which signal ran.

The property that separates a real signal from a plausible-looking one is worth
stating because it is the one a formula cannot show: **a signal that varies only
on inputs the run never contains is a constant signal in the run it is graded on.**
`min(1, length / 10_000)` is bounded, deterministic, content-only, and constant
over every turn in LongMemEval. `confidence.test.ts` therefore asserts variation
against a realistically shaped context rather than against the formula.

`admitTurns`' new `validateConfidence` rejects out-of-range and `NaN` values,
naming the turn they were computed for — a callback is evaluated per turn, so
"somewhere in this context" is not a location. `NaN` is the dangerous case for the
same reason as in §6.4's guard, with one addition: it would also be stamped onto a
memory that reaches `contradiction/resolve.ts`, where `confidence * sourceTrust` is
read as a field.

**The default does not move**, exactly as in §6.4 and for the same reason: an
absent `confidenceFor` leaves `confidence` at `createMemory`'s `1`, so every
measurement taken before the field existed was taken under this configuration and
keeps its meaning.

## 7. Defect injection

Six injections, each expected to be caught by a *different* subset:

| # | Injection | Caught by | Count |
| --- | --- | --- | --- |
| 1 | `answerTemporal` routed through the flat path, dropping `questionDate` | `memory-conformance.test.ts` | 2 / 126 |
| 2 | Write threshold tightened by `1e-9` | `admission.test.ts` | **0 / 126 at first** → 2 / 129 after adding the equality test |
| 3 | Session labels dropped from `formatEvidence` | `prompt.test.ts` + `branch-coverage.test.ts` | 2 / 129 |
| 4 | `sourceTrust` field ignored, reverted to the literal `0.5` | `admission.test.ts` + `index.test.ts` | 4 / 144 |
| 5 | `sourceTrust` hardcoded in `toMemoryArmConfig`, discarding the parsed value | `bench-memory-arm.test.ts` | 1 / 45 |
| 6 | Dispatched key renamed so it no longer matches a declared workflow input | `test_dispatch_inputs.py` | 2 / 4 |
| 7 | `confidenceFor` ignored, so per-turn variation never reaches the value | `retrieval-discrimination.test.ts` | 6 / 8 |
| 8 | `validateConfidence`'s range check relaxed to only `value < 0` | `retrieval-discrimination.test.ts` | 1 / 8 |
| 9 | `confidenceFor` forwarding dropped from `admissionOptionsFrom` | `index.test.ts` | 2 / 9 |
| 10 | `validateConfidence` clamped instead of throwing | `retrieval-discrimination.test.ts` | 1 / 8 |

Injection 2 is the instructive one. It passed every test in its first run,
because every threshold assertion sat clearly on one side of the line and none
of them exercised *equality*. `decideWrite` uses `>=`, so the boundary is a real
behaviour with a real observable difference, and it was untested until the
injection said so. The three equality tests added in response are the reason the
table's third column changes between runs.

Injection 4 restores the exact defect §6.4 describes, so it answers "would the
suite have caught the ceiling if it had been written as a fix?". It is caught in
two files rather than one because the ceiling has both a unit assertion (the value
moves) and an end-to-end one (a gate setting reaches the admitted value through
`admissionOptionsFrom`). Both were needed: the end-to-end case is what a unit test
alone would have missed, and the injection is what proved the second file was
contributing rather than duplicating.

Injections 5 and 6 are the same defect at two different layers, and they are
listed separately because they were caught in different packages by different
kinds of test. #5 hardcodes the projection so an already-parsed value never
reaches the artifact — a change that typechecks in every direction, which is why
only one test catches it: the projection assertion, not the parsed-options ones.
The count is deliberately reported as measured rather than rounded up; a first
draft predicted 2 and the run said 1, because "the parser read it correctly" and
"the parser's value reached the artifact" are two different properties and up to
this point only one test held the second. #6 renames a dispatch input so it no
longer matches the workflow's declaration, which GitHub accepts without error and
silently drops. Neither is reachable by the other's test: #5 never touches the
workflow, and #6 never touches `cortex-eval`. That is the property being asserted
— the plumbing crosses two languages and three artifacts, so a suite that only
guards its ends would report the middle wired while it is not.

Injections 7-10 are §6.5's, and they come in two pairs that fail for different
reasons. The first pair targets the mechanism and its guard: ignoring
`confidenceFor` entirely is caught by six assertions, and relaxing the range check
to `value < 0` — which keeps `1.5` and `NaN` alive — is caught by exactly one, the
test that sweeps four out-of-range values. The second pair targets the plumbing:
dropping the field in `admissionOptionsFrom` is caught in `index.test.ts` rather
than in `retrieval-discrimination.test.ts`, and that is the point of having both —
the discrimination suite calls `admitTurns` directly and stays green while the
composed system runs the constant behaviour. Clamping instead of throwing is caught
by one assertion and is listed separately because it is the shape a "more forgiving"
review would wave through: silently reinterpreting `1.5` as `1` turns a caller's
typo into an uninterpretable result, which is the same defect class as §6.4's
validation note.

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

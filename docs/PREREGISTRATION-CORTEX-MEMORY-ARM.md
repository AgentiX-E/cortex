# PREREGISTRATION — the `cortex-memory` benchmark arm

**Status:** registered before dispatch, as `AUDIT-CODE-VS-DOCS.md` §6.3 requires.
**Registered at revision:** the commit that adds `packages/cortex-eval/src/bench-memory-arm.ts`.
**Arm:** `cortex-memory` (`CortexMemory`) as the **feature** side; `cortex-eval`'s
`NaturalLanguageMemorySystem` reference pipeline as the **baseline** side.

---

## 1. Why this document exists before the code runs

§6.3 makes pre-registration mandatory for every arm from step 3 onward, and it
names three things that must be fixed in advance:

1. the point estimate the arm must beat,
2. the effect size that counts as success,
3. the stopping rule.

The requirement is not ceremony, and the repository holds its own proof.
`p3b-graph-verdict.md` records a TR recall-expansion arm that looked promising and
measured **77.95% → 70.87%** (Δ −7.09pp, one-sided exact McNemar p = 0.039, 15
broken / 6 repaired). It was the third consecutive rejection of that line. §6.3's
judgement is that pre-registration is what stopped that arm being rationalised into
the roadmap *after* the fact — and the failure mode it guards against is not fraud,
it is the ordinary human tendency to read a `+0.4pp` as a signal once it is already
on the page.

So the numbers below are written down **before** the dispatch, and they do not move
afterwards.

---

## 2. The point estimate the arm must beat

### 2.1 Where it comes from, and why not from `SOTA-BASELINE.md`

The obvious source is `SOTA-BASELINE.md`, which freezes Cortex at **83.55%** overall
on LongMemEval-S (full N=500, 4 interleaved runs, DeepSeek reader, Zhipu GLM-3
embeddings). That document carries its own warning, in bold:

> **This is a historical measurement, not a description of current `master`.**
> `a52628f` is **55 commits behind** `master`, and the evaluation harness changed
> substantially in between: `packages/cortex-eval/src` gained **8,326 lines and lost
> 227** across 30 files.

A frozen score whose measuring instrument has since been rewritten by 8,326 inserted
lines is not a baseline. Quoting it as "the number to beat" would make this arm's
result depend on two differences at once — the cognitive layer, *and* six weeks of
harness drift — which is precisely the confound the paired design exists to remove.

### 2.2 The point estimate this arm actually uses

**The arm's own baseline side, measured in the same dispatch.**

This is stronger than a historical anchor, not a substitute for one. The pairing
invariant is that both sides are evaluated by **one** `runAblationReport` call on the
same dataset under the same scorer. Its consequence is that the baseline arm's number
*is* the current-`master` reference number, measured under the current instrument, on
the same questions, in the same runner, at the same moment.

| Quantity | Value |
| --- | --- |
| Point estimate the feature must beat | **the baseline side's `abstentionAwareAccuracy` from the same dispatch** |
| Sample | full LongMemEval-S, **N = 500** |
| Runs | **4**, `temperature: 0` (deterministic) |
| Comparison statistics | exact paired McNemar over questions, per capability and overall; Wilson 95% intervals on both sides |

**This subsumes §6.2 step 5.** Step 5 asks for a re-measurement of LongMemEval-S at
current `master` with full N=500, 4 runs and Wilson intervals published. The baseline
side of this arm is that re-measurement. A second dispatch for step 5 would spend the
same guarded quota to answer the same question with a *staler* revision.

### 2.3 What is deliberately NOT claimed

The arm does **not** claim the cognitive layer is better than the reference pipeline
at producing answers — the two systems differ in *what decides admission*, not in the
reader or the extraction. `DESIGN-CORTEX-MEMORY.md` states the honest version: step 2
made the cognitive layer **reachable**, and this arm measures whether reachability
**costs** anything. A delta of zero is a legitimate and useful result; see §4.

---

## 3. The effect size that counts as success

### 3.1 The decision, stated as a rule before the data exists

The primary endpoint is **overall abstention-aware accuracy on the full N=500 set**,
compared between the two sides by an **exact paired McNemar test** over questions.

| Verdict | Rule |
| --- | --- |
| **The feature helps** | `Δ > 0` **and** McNemar `p < 0.05`, with the discordant pair set naming its questions |
| **Null (a real, reportable result)** | `|Δ|` within the noise floor and McNemar not significant — see §3.3 |
| **The feature hurts** | `Δ < 0` and McNemar `p < 0.05` → **reject the arm**, per the D2/B7 precedent |

### 3.2 Why overall accuracy alone is not the endpoint

`SOTA-BASELINE.md` §6 records the relevant lesson twice. Per-run within-arm spread is
**6–7 questions on 500**, which means a single-run comparison cannot resolve anything
smaller than ~1.4pp, and time-of-day drift alone is **1.7–2.1pp** — larger than most
effects an arm of this kind could plausibly find. So:

- overall accuracy is a **descriptive** estimate and is reported with its Wilson
  interval, never as a point claim;
- the **decisive** statistics are the per-capability paired results, because that is
  where a mechanism can be named;
- a pooled z-test is **not** used. Pooling the same questions across runs is
  pseudoreplication, and §6 forbids it explicitly.

### 3.3 The pre-registered mechanism prediction, and the null we expect

The cognitive layer's only lever is **admission**. `decideWrite` filters turns before
the prompt is built; the reference pipeline filters by retrieval score. This yields
predictions that are falsifiable *and* that a null result still satisfies:

| Capability | Prediction | Reason |
| --- | --- | --- |
| **IE** (single-session) | **Δ ≈ 0, expected null** | IE questions usually have one obvious evidence turn. Both gates admit it. |
| **MR** (multi-session) | **Δ ≥ 0 if it moves at all** | The session-preserving path is the one behavioural difference: `cortex-memory` admits per session and keeps boundaries, which the reference pipeline's flat context does not. |
| **KU / TR** | **Δ ≈ 0, expected null** | The gate does not change extraction or temporal reasoning, and both sides reach the same contract instructions. |
| **ABS** (abstention) | **Δ = 0 by construction** | The baseline scored **120/120 = 100.00%** at `a52628f`. A ceiling cannot move, so an ABS delta must be zero and any non-zero value is a bug report about the harness, not a finding. |

**The null hypothesis is the expected outcome** and is written down here so that a
null cannot later be reinterpreted as an unexpected failure. Specifically: `Δ ≈ 0` on
IE/KU/TR **confirms** that admission filtering is not the binding constraint on those
capabilities, which is itself the informative result — the reference pipeline's
retrieval scoring and `cortex-core`'s value function agree closely enough on which
turns matter that swapping one for the other does not change the answer.

### 3.4 The one-sided test that is NOT used, and why

The TR recall arm used a one-sided exact McNemar because it had a directional
hypothesis with a prior. This arm does not: the cognitive layer could plausibly help
(session-aware admission) or hurt (a value gate that drops a turn the retrieval score
would have kept). A one-sided test on a two-sided question would double the false
positive rate, so **two-sided** is used and the direction is read from the sign of the
discordant pair counts, which the artifact carries by question id.

---

## 4. The stopping rule

Registered before dispatch:

1. **One dispatch.** One A/B, full N=500, 4 runs, `temperature: 0`. No peeking, no
   early stopping on a partial sample, no "let us just see the first 60".
2. **No re-running to get a better draw.** If the first dispatch fails for an
   infrastructure reason (quota, network, artifact loss), it is re-dispatched with the
   reason recorded. A failure is not a result. A *bad result* is a result.
3. **The outcome terminates this line.** Whichever verdict §3.1 returns:
   - **helps** → the feature becomes the shipped path, and the reference pipeline
     stays in the harness as the control arm (`AUDIT-CODE-VS-DOCS.md` §6.1 already
     states it is retained for exactly this);
   - **null** → recorded as a null result, the arm is kept for regression detection,
     and no further tuning of `threshold`/`sessionBudget` is attempted to convert it
     into a positive. Tuning after a null is the rationalisation §6.3 exists to
     prevent, and the identity configuration (§4 of `DESIGN-CORTEX-MEMORY.md`) is the
     pre-committed one;
   - **hurts** → the arm is rejected and `cortex-memory` is documented as *reachable
     but not measured-better*, which is what it already was before this step.
4. **`Zhipu GLM embedding-3` is a known blocker.** Its quota was exhausted (429) and
   the offline fallback (`@agentix-e/embed-code-node`) produces different vectors, so
   the run must record which backend produced it. `bench/run.ts` already prints
   `Embedding backend: ...` before any request for this reason; a run that graded
   against the fallback and a run that graded against Zhipu each produced a real
   report, and only that line separates them. If the dispatch lands on the fallback,
   the result is **not** comparable to `SOTA-BASELINE.md` and is labelled as such.

---

## 5. The assembly decision this arm required

§6.2 step 3 assumes the arm is a small addition. It is not, because it is the first
arm in the package whose two sides are **different systems**.

Every other arm is an A/B *within* `NaturalLanguageMemorySystem` — two instances
differing by options, both constructed inside `cortex-eval` (`runRerankAblation` is
the template). This arm's feature side lives in `cortex-memory`, and today's
dependency graph gives `cortex-eval` no path to it:

```
cortex-core                     ← cortex-memory
cortex-core, cortex-llm         ← cortex-eval
cortex-memory  --(devDep, type-only)-->  cortex-eval
```

Three placements were considered.

| Option | Shape | Verdict |
| --- | --- | --- |
| **A — assembly in `cortex-eval/src/`, systems injected** | `bench-memory-arm.ts` takes both systems already constructed and never names `cortex-memory`; the CLI builds them and hands them over | **Chosen** |
| B — new `cortex-bench` package depending on both | Architecturally the cleanest: the coordinating layer depends on both sides | Rejected on cost: a 1051-line CLI moves house, plus a full toolchain, and `pnpm check` grows a stage |
| C — assembly in `cortex-memory/bench/` | Dependency direction is natural today | Rejected: `bench/**` is excluded from coverage, so the wiring would be untestable — the exact defect `bench-arm-options.ts` documents |

**Option A's cost is real and is accepted:** `cortex-eval` gains a module that exists
to serve a product package, which a reader may find impure. The counter-argument is
that the assembly is *the instrument's* job — it is the thing that decides what is
compared against what — and it belongs inside the coverage boundary. The dependency
edge itself is unchanged, which is what `AUDIT-EVAL-CONTRACTS.md` §2 relied on when it
found the edge acyclic; the arm's suite asserts that no `cortex-memory` dependency is
declared, so the decision cannot be reversed by a refactor that looks local.

### 5.1 What must NOT live in `bench/run.ts`

`bench-arm-options.ts` recorded the lesson and paid for it:

> the spread that carries the B7 toggle into the arm was, from the suite's point of
> view, unreachable code. Deleting it, defaulting it on, or reading the wrong
> environment variable each left every test green — because no test could import the
> file the line lived in.

So the environment parsing (`cortextMemoryArmOptions`) and the assembly
(`runCortexMemoryArm`) both live in `src/**`. What stays in the CLI is the part with
no decision in it: construct two systems, hand them over, write the artifact.

---

## 6. What is recorded in the artifact, and why it is not optional

The report carries a `memoryArmConfig` field (`threshold`, `sessionBudget`) beside
the existing `featureConfig` switch record. It is a **required** option on the arm,
not an optional one, so a new caller cannot silently produce an artifact without it.

The precedent is §20 of the progress report: two downloaded artifacts differed by two
questions and **neither said which side of the switch it was on**, so the delta's sign
was uninterpretable and the run had to be discarded. A `cortex-memory` artifact
without its gate configuration has that defect by construction — `threshold=0`
(gates open) and `threshold=0.9` (nearly closed) would produce two files that look
identical and mean opposite things.

It is a **separate** field rather than more entries in `FeatureConfig` because that
type is `Readonly<Record<string, boolean>>` with an `on`/`off` renderer, and
thresholds are numbers. Widening it would have changed the feature-config line of
every existing artifact; the narrower field is the smaller blast radius.

---

## 7. Acceptance criteria for the code half (delivered with this registration)

| Criterion | Result |
| --- | --- |
| Tests written before implementation (TDD) | ✅ module failed to load, then 16 → 20 → 25 tests |
| Coverage, all four dimensions, on the new module | ✅ **70/70 statements, 5/5 functions, 0 uncovered branches, 100% lines** |
| Package-level gate | ✅ 99.88 / 99.07 / 100 / 99.88, floor is 95 |
| A deliberately under-covered commit fails | ✅ see defect injection below |
| Defect injection, each caught by a named test | ✅ 5 injections, all caught after one real escape was closed |
| No mocks | ✅ real `runAblationReport`, real `exactMatchScorer`, hand-written recording systems |
| No `v8 ignore` | ✅ none added |
| `tsc` clean (`vitest` does not typecheck) | ✅ 3 errors caught by `tsc` that `vitest` reported green |

### 7.1 The escape, recorded because it is the useful part

Injection 5 (replace the single paired call with a staggered double evaluation) **was
not caught** by the first version of the pairing test. That test asserted on the
module's source text:

```ts
expect(source).not.toMatch(/\brunBenchmark\(/);
```

The injected break was `void runBenchmark;` — a reference with no call parentheses —
so the guard matched nothing and every test stayed green. Two things follow:

1. **A source-text assertion is the wrong instrument.** It fires on an equivalent
   rewrite and misses a real break, and it proves nothing about behaviour.
2. The replacement is a **behavioural** assertion: both systems are wrapped so each
   logs the questions it is asked, and the test asserts each is evaluated exactly
   **once per question**. Re-running the same injection then failed the test, which
   is the only evidence that the guard actually guards.

This is the same class of defect the arm exists to detect — a guard that appears to
hold a property while holding nothing — and it happened inside the guard itself.

### 7.2 A second false expectation, corrected

The first pairing test also asserted that the two sides were evaluated
**interleaved** (`[baseline, feature, baseline, feature]`). That failed, because
`runAblation` evaluates each side in full before starting the other. The assertion was
wrong, not the implementation: "paired" means the two sides are compared
**question-by-question on the same dataset under the same scorer**, which the
per-question discordant loop provides and a staggered *comparison* does not.
Interleaving is not part of the property. The corrected suite asserts the property
that is real — a fixture where each side is correct on a **different** question and
the marginals agree, so an unpaired comparison would report `Δ = 0.00pp` while the
paired one names both questions.

---

## 8. Reproducing the dispatch

```bash
python3 tools/dispatch-cortex-memory-ab.py            # registers the arm
# The workflow runs both sides in one job, full N=500, 4 runs, temperature 0.
# Read the artifact: packages/cortex-eval/benchmark-cortex-memory-ablation-report.json
```

The script locks the ref (not the SHA) for the reason `dispatch-b7-ab.py` documents:
without an explicit `ref` the workflow picks up whatever `master` is at dispatch time,
and two arms can land on different code — which is how the §13 run produced two
byte-identical arms and a verdict about the dispatch.

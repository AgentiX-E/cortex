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
| Defect injection, each caught by a named test | ✅ 5 injections in the arm (one escape, closed), 5 in the dispatch path (§7.3), 5 in the retrieval gate (§7.4), none escaping |
| No mocks | ✅ real `runAblationReport`, real `exactMatchScorer`, hand-written recording systems |
| No `v8 ignore` | ✅ none added |
| Blank dispatch inputs mean "not configured" | ✅ threshold 0, budget unbounded — and an explicit `'0'` still means zero (§7.3) |
| The abstention path computes its decision before consulting the model | ✅ asserted on observed model calls, not source text (§7.4) |
| Both thresholds recorded, set independently, and rendered into the artifact | ✅ `threshold` and `retrievalThreshold` on the config line and in the JSON (§7.4) |
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

### 7.3 Three defects in the dispatch path, found before the dispatch

The arm was assembled and pushed with its numbers unmeasured, and the next step was
to run it. Reading the wiring back — not a failing test, because nothing had run —
turned up three defects that each make the artifact unusable in a different way.

**The arm never touched `EMBEDDING_CACHE_PATH`.** `Run benchmark` and `Run
cortex-memory A/B` are two steps of one job sharing one cache file, and they are
separate processes: the first writes it at its end, the second started with an empty
in-process cache. Every one of the ~115k haystack-turn vectors would have been
re-embedded. Against a quota already returning 429 that is a guaranteed failure; against
a fresh quota it is a second full bill for vectors already paid for. The write side was
missing too, so no later dispatch could reuse them either. Both now go through
`cortexMemoryArmEmbeddingCachePath` / `restoreArmEmbeddingCache` /
`persistArmEmbeddingCache`, which live in `bench-memory-arm.ts` rather than in the CLI,
for §7.1's reason: a decision written in `bench/**` is a decision no test can reach.

**A blank dispatch input was read as a number.** GitHub passes an unfilled
`workflow_dispatch` input as the empty string rather than omitting the variable, and
`Number('')` is `0`. The threshold landed on its intended default by accident — the
more dangerous kind of bug, because the number is right and review passes. The session
budget landed on **zero turns**, which `selectSessionBudget` maps to `[]` and which
abstains on every question — and `readSessionBudget`'s own guard, written specifically
to reject "a budget <= 0 ... [that] abstains on every question for a reason no artifact
records", missed it because the guard tests `value < 0`. The arm would have completed,
written a report, and the report would have read as a real measurement of a memory
system that admits nothing.

**`CORTEX_MEMORY` was hardcoded to `'1'` while `if:` restated the same fact.** Two
statements of one fact can disagree, and this arm's reader is strict (`readToggle`: only
the literal `'1'` is on), so a disagreement would skip the arm inside a green run — the
§13 failure, where two arms came out byte-identical and the verdict was about the
dispatch. It is now derived from the input, which leaves the dispatch script as the
single place that decides. `TEMPERATURE`, `DEEPSEEK_MODEL` and `DEEPSEEK_THINKING` were
also missing from the step: omitting them runs the arm's two sides on a different reader
from the primary benchmark's, which is the one comparison §3 pins.

The fix for the second is a `trim()` test rather than a falsy test, so that blank means
"not configured" **without** making an explicit `'0'` unreachable. Turning "unset" into
"the default" by making a real zero inexpressible would be the same defect mirrored, and
that is what injection 5 below checks.

| Injection | Caught by |
| --- | --- |
| Drop the `mergeEmbeddingCache` call (reads the file, uses nothing) | 2 tests: `absorbs the provider calls a previous process already paid for`, `merges rather than replaces` |
| Clear the cache before merging (restore wipes in-process vectors) | the same 2 tests |
| Default `CORTEX_MEMORY` on | 3 tests, incl. `reports the arm as disabled when the toggle is off` |
| Revert to the `undefined`-only blank check (the original defect) | 3 tests, incl. `treats a blank session budget as UNBOUNDED, not as zero` |
| Falsy check instead of a blank check (explicit `0` becomes unreachable) | 1 test: `treats whitespace as blank, not as a number` |

Five injections, no escapes. The first is §7.1's failure mode in a new place — a restore
that reads the file and discards it looks wired in the diff and reuses nothing.

### 7.4 A fourth defect, found by reading the result

Run `37094200823` completed green, and the numbers it produced are the reason this
section exists:

| Side | Accuracy (4 runs) | Abstention rate |
| --- | --- | --- |
| `reference-pipeline` | 84.20% / 85.05% / 85.40% / 85.30% | 9.2% |
| `cortex-memory` | 6.40% / 6.50% / 6.60% / 6.50% | **95.40%** |

Δ = −78.55 pp, McNemar p = 4.920e−117. Per capability the feature scored IE 0.67%
(150), MR 0.83% (121), KU 0.00% (72), TR 0.00% (127), ABS 100% (30).

Same LLM, same dataset, same scorer, one paired call. The artifact's config line read
`threshold=0, sessionBudget=unbounded` — correct, and §7.3 is what made it correct — so
the gate configuration was not the cause. The cause was in the code the config line
describes:

**`decideRetrieval` had no call site in `cortex-memory`.** `memory.ts`'s docstring on
the abstention path stated that `decideRetrieval` returns `{retrieve: false,
reason: 'below-threshold'}` and that "that is a machine-derived abstention". A grep for
the identifier across the package returned the docstring and one barrel comment, and
nothing else. The function was imported nowhere and called nowhere, so every abstention
the arm produced came from the model's own wording. This is the exact defect class
`AUDIT-CODE-VS-DOCS.md` exists to find — **a documented property that was never
implemented** — and no test failed on it, because every existing test asked about the
model side of the path ("does a token round-trip") and none asked about the machine side
("was a decision computed before the model was consulted").

The repair adds a second threshold, `retrievalThreshold`, threaded from
`CORTEX_MEMORY_RETRIEVAL_THRESHOLD` through `GateOptions` to `decideRetrieval`. Two
thresholds rather than one because they gate different decisions and `GateOptions`
shares one `valueFunction` between them: `threshold` decides whether a turn is worth
**keeping** and `retrievalThreshold` whether the kept evidence is strong enough to
**answer with**. A single field cannot express "keep everything, answer only when the
evidence is good", which is the configuration this arm needs in order to test the
mechanism it claims.

| Injection | Caught by |
| --- | --- |
| Delete the `#retrievalAdmitted` call from the abstention path | 2 tests: `returns null WITHOUT calling the model when the retrieval gate closes`, `confines the machine decision to the abstention path` |
| Force the retrieval gate open (`decision.retrieve \|\| true`) | the same 2 tests |
| Hardcode the threshold in the call, ignoring the configuration | the same 2 tests |
| Project a constant into the artifact (`retrievalThreshold: 0`) | 1 test: `reports the retrieval threshold as set, separately from the write threshold` |
| Drop the field from the Markdown renderer | 2 tests, incl. `renders the gate configuration into the Markdown, so the artifact carries it` |

Five more injections, no escapes. The first was drafted wrong and caught itself: an
earlier version set a single `threshold: 0.9` to "close retrieval", and 4 of 5 tests
passed on unfixed code, because a high admission threshold empties the gate first and
`turns.length === 0` returns early — masking the absent call. Separating the two
thresholds (`threshold: 0` admits, `retrievalThreshold: 0.9` refuses) is what made the
red light name the right failure. The assertion is on observed model calls, not on
source text, because the string `decideRetrieval` was in the comment the whole time and
a text assertion would have passed on the broken code.

**On the boundary between repairing and tuning.** §4 forbids re-running for a better
draw and forbids promoting a configuration after a null. Neither applies here, and the
distinction is worth stating precisely rather than being left to look like a
technicality. A re-run after this repair measures **a different program**: the thing
that will be measured is the mechanism the document described and the arm claimed to
test, and it did not previously exist. That is not a second draw from the same
distribution, and no parameter of the experiment has been changed — the endpoint,
the dataset, the sample size, the effect size, the stopping rule and the two gate values
are all as registered. What changed is that the code now does what the registration says
it does. §4's prohibition stands unchanged for any dispatch that would differ from
`37094200823` in a knob rather than in the program, and the repair itself is required
whether or not a re-run is ever dispatched — shipping a system whose comment describes a
decision it does not make is the defect, independent of any measurement.

The `6.40%` reading therefore stands as the **recorded outcome of the program as it
was**, and is retained rather than superseded: it is the measurement that found the
defect. Whether the repaired program closes the gap is a new question, and it is put to
the endpoint in §3 without adjustment.

### 7.5 The repair ran, and changed nothing — because the threshold it was given was a no-op

Run [`37110579101`](https://github.com/AgentiX-E/cortex/actions/runs/37110579101) at
`master` = `2e8ff640` is the repaired program's first measurement. All 18 steps green,
3h00m, `check-output` confirming on the runner that `abstention-decision.test.ts` ran and
that `cortex-memory` reports `100/100/100/100`.

| Side | Run `37094200823` (pre-repair) | Run `37110579101` (post-repair) |
| --- | --- | --- |
| `reference-pipeline` | 85.20% | 84.70% (84.60–84.80) |
| `cortex-memory` | 6.40% | **6.45%** (6.40–6.60) |
| Δ | −78.55 pp | **−78.25 pp** |
| Abstention rate | 95.40% | **95.80%** |
| McNemar p | 4.920e−117 | 3.906e−116 |

**The repair did not move the number.** The artifact's config line is now
`threshold=0, retrievalThreshold=0, sessionBudget=unbounded` — so the second gate was
present, wired, and recorded, and the result is the same to within noise.

The reason is not that the repair was wrong. It is that **`retrievalThreshold=0` cannot
close a gate whose maximum observable value is `0.5`.** The measurement, taken locally
against the real value function:

```
valueFunction(mem) = 0.5

threshold=0     -> retrieve=true   confidence=0.5
threshold=0.25  -> retrieve=true   confidence=0.5
threshold=0.49  -> retrieve=true   confidence=0.5
threshold=0.5   -> retrieve=true   confidence=0.5
threshold=0.51  -> retrieve=false  confidence=0.5
threshold=0.75  -> retrieve=false  confidence=0.5
```

The ceiling is `confidence(1) × sourceTrust(0.5) × (0.5 + 0.5 × recency(1.0))`, and
`admission.ts` supplies `sourceTrust: 0.5` with `lastAccessedAt === now`, so recency is
exactly `1`. `decideRetrieval` compares `confidence >= threshold`, so the reachable
range for this arm is `[0, 0.5]`: every threshold at or below `0.5` is **always open**,
and every threshold above it is **always closed**.

This is the defect §7.4 fixed viewed from the other side. Before the repair there was no
call site, so *no* threshold could have had an effect and the config line could not say
so. After the repair there is a call site, and the config line says exactly what the
gate was — which is how the no-op became visible in one comparison instead of after
another three hours.

**What this does not license.** Re-dispatching with a closed gate would be tuning a
parameter toward a preferred outcome, which §4 forbids, and it would also be measuring
something else: with the gate at `> 0.5` every question abstains by construction, so the
score is `0%` by arithmetic rather than by experiment. The retrieval gate's *value* is
not the variable this arm is registered to optimise.

**What it does license, and what the registered endpoint now needs.** The arm's
hypothesis was that composing the cognitive layer is not worse than the reference
pipeline. That hypothesis was tested under a configuration where the cognitive layer's
only distinctive mechanism — a machine-derived retrieval decision — was **bypassed in
both runs**, once because it did not exist and once because it was handed a threshold it
cannot act on. Neither run is evidence about the hypothesis. Establishing that the
mechanism is reachable and observable was the prerequisite; choosing whether to arm it,
and at what value, is a **new registration**, because it changes the question.

The `0.5` ceiling itself is a finding about the arm rather than about the cognitive
layer, and it is worth stating plainly: the admission path hardcodes `sourceTrust: 0.5`
and pins `lastAccessedAt` to the injected clock, so a value function composed with it
cannot exceed `0.5` no matter how confident the evidence. Every threshold in this arm's
vocabulary therefore means half of what an intuitive `[0, 1]` reading suggests, which is
the same "correct number, wrong units" shape §38.3 recorded.
## 8. Reproducing the dispatch

> **Dispatched.** Run [`37094200823`](https://github.com/AgentiX-E/cortex/actions/runs/37094200823)
> at `master` = `23111689`, one invocation of the script below, `limit: 0`,
> `ablation_runs: 4`, `temperature: 0`. Per §4 the dispatch is not repeated for a
> better draw, and a failure for an infrastructure reason (quota, artifact loss) is
> re-dispatched with that reason recorded rather than treated as a result.
>
> **Read, and it found a defect.** The run was green and its numbers are in §7.4; they
> diagnosed an unimplemented `decideRetrieval`, now repaired. The reading is retained as
> the outcome of the pre-repair program, and the re-run is a measurement of a different
> program rather than a redraw — argued in §7.4.
>
> **Re-dispatched after the repair.** Run
> [`37110579101`](https://github.com/AgentiX-E/cortex/actions/runs/37110579101) at
> `master` = `2e8ff640`, the repair commit. Same endpoint, dataset, `limit: 0`,
> `ablation_runs: 4`, `temperature: 0`; the added input is
> `cortex_memory_retrieval_threshold: '0'` (§7.4). This is the measurement of the
> repaired program, not a second draw from the first one's distribution.


```bash
python3 tools/dispatch-cortex-memory-ab.py            # registers the arm
# The workflow runs both sides in one job, full N=500, 4 runs, temperature 0.
# Read the artifact: packages/cortex-memory/benchmark-cortex-memory-ablation-report.json
```

The script locks the ref (not the SHA) for the reason `dispatch-b7-ab.py` documents:
without an explicit `ref` the workflow picks up whatever `master` is at dispatch time,
and two arms can land on different code — which is how the §13 run produced two
byte-identical arms and a verdict about the dispatch.

---

## 9. The ceiling remedy: what changed, and why it is not a re-tuning

**Status:** code remedy, landed after §7.5. **No dispatch accompanies it**, and this
section exists to state why one does not.

### 9.1 What changed

`GateOptions` gained `sourceTrust?: number` (default `0.5`), threaded through
`admissionOptionsFrom` → `admitTurns` → `createMemory`. Before it, `admission.ts`
passed `sourceTrust: 0.5` as a literal with no way to pass anything else, so the
composition layer could not express a fully-trusted memory.

| Property | Before | After |
| --- | --- | --- |
| Reachable value range | `[0, 0.5]` | `[0, 1]` |
| `threshold > 0.5` | admits nothing | discriminates |
| Default behaviour | `sourceTrust = 0.5` | **unchanged** |

Verified on the built packages: the default still yields `0.5`, `sourceTrust: 1` yields
`1`, and at `threshold 0.6` a fully-trusted turn is admitted while a default one is not.

### 9.2 Why this is a remedy rather than tuning toward a preferred outcome

§4 forbids re-running for a better draw and forbids promoting a configuration after a
null. Neither applies, and the distinction is stated as a test rather than asserted:

| Test | Remedy | Tuning |
| --- | --- | --- |
| Are the registered parameters altered? | no | yes |
| Does it change what the code can *express* or what it is *set to*? | can express | is set to |
| Is the old behaviour wrong independent of any benchmark? | yes (§9.3) | no |
| Would reverting it be defended on principle? | yes | no |
| Does the default move? | **no** | usually yes |

The last row is the decisive one for this repository's purposes. Because the default is
unchanged, **every artifact produced before this field existed still describes the
configuration it ran under** — the `6.40%` and `6.45%` readings remain interpretable in
exactly the terms they were recorded in.

### 9.3 The defect, independent of the benchmark

`MemoryValue.sourceTrust` is documented as `[0, 1]`. The composition layer could only
produce one value, so its domain was narrower than the model it composes. Measured
consequences, each wrong regardless of what any arm scores:

1. **The write gate's upper half was unreachable**, making it a two-state switch.
   `decideWrite` accepts any `number`, so an unreachable threshold produces no error,
   only always-false — §40.6's "the value range is part of the interface" in the concrete.
2. **`selectSessionBudget`'s best-of ranking was dead in practice.** Three sessions with
   deliberately different evidence quality all admitted at `0.5`, and a budget of `1`
   selected index `1` via the tie-break alone. The function's documented distinction
   between best-of and mean could not be observed through any input this arm constructs.
3. **Contradiction resolution could not distinguish sources.** `resolve.ts` fuses on
   `confidence * sourceTrust`, so a rumour and a first-hand observation carried the same
   weight.

### 9.4 What this does not license

**Arming the gate in a dispatch is still a new registration.** §7.5 is unchanged: choosing
a `sourceTrust` (or a `retrievalThreshold` that the new range makes meaningful) changes
the question the arm asks, and it must be registered before it is dispatched. This section
records a code change that widens what is expressible; it does not authorise a run, and
§4's stopping rule stands.

The order matters: the field had to exist before a registration could name a value for it,
because a registration that specifies a configuration the code cannot accept is the
`7.5` failure with the sign flipped.

---

## 10. The armed-gate registration

**Status:** code + plumbing landed; **no dispatch accompanies it yet**, and §10.6 states
the precondition that must hold first.

### 10.1 Why this is a new registration rather than a continuation

§9.4 said arming the gate is a new registration, and this is it. The reason is not
ceremony: the arm now asks a *different question*. Through §7.5 the arm asked "does
composing the cognitive layer move accuracy at all", with both gates at their identity
settings so the only variable was composition. A run that sets a non-zero
`retrievalThreshold` asks "does the machine-derived abstention decision help", which is a
claim about a mechanism rather than about composition.

Three things are therefore re-stated rather than inherited, because a rule carried over
implicitly is a rule that was never decided for this question:

| Element | §7.5 (composition) | §10 (armed gate) |
| --- | --- | --- |
| Point estimate | the baseline side of the same dispatch | **unchanged** |
| Endpoint | overall abstention-aware accuracy, McNemar p < 0.05, N=500, 4 runs, T=0 | **unchanged** |
| Stopping rule | one dispatch, no peeking, no redraw for a better draw | **unchanged** |
| Gate settings | `threshold: 0`, `retrievalThreshold: 0` | **named in §10.3** |
| Mechanism prediction | §3.3 (positive-leaning, with the null stated) | **new, §10.4, and it is falsifiable in the opposite direction** |

The endpoint and the stopping rule are unchanged deliberately. If a mechanism claim were
allowed to select its own endpoint, every arm would be judged by the metric it happens to
move, and §3.4's argument against a one-sided test applies with more force to a bespoke
one.

### 10.2 What the plumbing required, and why it was not cosmetic

`sourceTrust` existed in `cortex-memory` after §9 but could not be dispatched. The gap was
in three layers at once:

| Layer | Before | After |
| --- | --- | --- |
| `tools/dispatch-cortex-memory-ab.py` | no `cortex_memory_source_trust` key | sent explicitly as `'0.5'` |
| `.github/workflows/benchmark.yml` | no input, no `env:` forward | input declared, forwarded as `CORTEX_MEMORY_SOURCE_TRUST` |
| `packages/cortex-eval/src/bench-memory-arm.ts` | `CortexMemoryArmOptions` had no field | parses, validates, projects into `MemoryArmConfig` |
| `packages/cortex-memory/bench/run-ablation.ts` | gate built from three fields | four, plus `sourceTrust=` on the logged line |

This is §7.3's defect in its third form, and it is worth naming precisely because the
symptom is invisible: a dispatch carrying an input the workflow never declared is accepted
by the API, the run starts, the arm executes, and the artifact records the configuration
the operator *intended*. Nothing in the run's output disagrees with anything else, because
from the workflow's point of view nothing was wrong. §7.3 found this once in the workflow
and once in the CLI; this is it again one layer further out.

**The remedy is a test rather than a resolution to be careful.**
`tools/__tests__/test_dispatch_inputs.py` asserts, in both directions, that every key a
dispatch script sends is a declared `workflow_dispatch` input and that every arm input is
forwarded into a step's `env`. Three injections were run against it:

| Injection | Caught by |
| --- | --- |
| rename the dispatched key to an undeclared `cortex_memory_ceiling` | `test_every_dispatched_key_is_a_declared_workflow_input`, `test_source_trust_is_dispatched_and_forwarded` |
| delete the `env:` forward, keep the input | `test_the_arm_inputs_have_an_env_forward` |
| delete the input declaration, keep the dispatch key | both of the above |

### 10.3 The configuration this registration names

* `sourceTrust: 0.5` — **the default, sent explicitly rather than omitted.**
* `threshold: 0` — unchanged from §7.5; every turn is admitted, so the only gate under
  test is the retrieval one.
* `retrievalThreshold: 0` — **amended from `0.25` by §10.9.** At `0.25` the gate abstained
  on 479/500, lost 186 questions the baseline got right, and won none (McNemar
  p = 2.039e-56). The pre-committed recovery for that outcome is the revert to `0`, so
  until a replacement arming is registered with its own prediction, the registered value
  is the control.
* `limit: 0`, `ablation_runs: 4`, `temperature: 0` — unchanged.

> **Amended by §10.9, in place rather than below.** The bullet list above is read by
> `tools/__tests__/test_preregistration_config.py`, whose `registered()` stops at the
> first blank line after the heading — so the amendment note belongs *after* the list,
> not between the heading and it. The first draft of this amendment put a blockquote
> directly under the heading and the guard's control test failed with `parsed []`, which
> is the guard catching a document edit that would have silently disabled the check. The
> `0.25` that was registered, and the prediction it was registered against, are not
> deleted: they remain in §10.4 and §10.9, because a refuted prediction is a result and
> removing it would destroy the evidence that it was stated in advance.

`sourceTrust: 0.5` is sent rather than left blank for the reason §7.4 gives about
`retrievalThreshold`: the blank path also lands on `0.5` today, but it lands there through
`''` → `readNumeric` → default, and a value the experiment depends on should not arrive by
an accident that happens to be correct. Sending it also makes the dispatch record name the
ceiling, which is the fact whose absence made `37110579101` unable to explain why it
reproduced `37094200823` to the digit.

**Stated plainly: this registration is the weakest arming available, and that is the
point.** At `sourceTrust: 0.5` the reachable interval is `[0, 0.5]`, so
`retrievalThreshold: 0.25` is a genuinely discriminating value — but the gate it drives is
still a **threshold on a quantity whose usable range is half the nominal one**. The
configuration tests *that the gate is wired and that its midpoint does something*, not
"the gate at its most expressive".

### 10.4 The falsifiable prediction, stated before the run

This is the part that differs in kind from §3.3, and it is the reason the section exists.

**Prediction.** With `retrievalThreshold: 0.25` and the ceiling at `0.5`, the feature arm's
**abstention rate falls** relative to `retrievalThreshold: 0` — the admission-side value
distribution is bounded by `0.5`, so a `0.25` cut sits near the middle of the mass rather
than at its top, and turns that previously produced an answer now fall below it.

**The null we expect, and would accept.** No significant change on the endpoint. §3.3's
reasoning for the composition arm applies unchanged here: the reference pipeline already
abstains deliberately, and a second gate on the same evidence has no obviously-superior
signal to add.

**What would refute the mechanism claim.** Abstention rate **unchanged to the digit**
across the two configurations. That is not a null result about the feature; it is evidence
that `0.25` is not in the reachable mass at all, i.e. that the gate is still effectively
binary — the §9.3 defect surviving in the arming layer. It would be reported as such and
**would not be repaired by moving the threshold to `0.1`**, because that would be a redraw
in the sense §4 forbids: a second configuration chosen after seeing the first one's number.

**The pre-committed reading of each outcome:**

| Observed | Verdict |
| --- | --- |
| abstention falls, endpoint significantly up | opened verdict: the machine-derived gate helps at the midpoint |
| abstention falls, endpoint unchanged | the gate is live and the signal is neutral — a mechanism result, reported as such |
| abstention unchanged to the digit | the arming is not in the reachable mass; the ceiling, not the threshold, is the binding constraint |
| p < 0.05 with delta < 0 | the gate harms; reported as a refutation and reverted to `retrievalThreshold: 0` |

The third row is the one worth having written down in advance. It is the outcome that
distinguishes "the mechanism is wired" from "the mechanism is wired *and reachable*", and
after §9 that distinction is exactly where this project's remaining uncertainty about the
arm sits.

### 10.5 What this registration does NOT claim

1. It is not a claim that `0.25` is the right threshold. It is the *midpoint of the
   reachable interval*, chosen before the data and defensible without it.
2. It is not a claim about a raised ceiling. That is a separate registration; a run that
   both raised the ceiling and armed the gate would confound two changes, and the whole
   point of §10.4's prediction table is to separate them.
3. It is not a sweep. §4 forbids one: a sweep is a search, and a search is a procedure
   whose stopping point is chosen after seeing the data it stops on.

### 10.6 The precondition, and what is still missing

§7.5's lesson was that a registration can be dispatched before the code can honour it, and
that the artifact then describes the intent. The same check applies here, and it now
passes **at the level of the plumbing**: the value survives every layer from the dispatch
input to `MemoryArmConfig`, asserted by `bench-memory-arm.test.ts` and
`test_dispatch_inputs.py`.

**Satisfied, and it found a fourth defect.** Run
[`37280315123`](https://github.com/AgentiX-E/cortex/actions/runs/37280315123) at `master` =
`b02aa5a7` was dispatched as a plumbing probe — the §10.3 configuration with `limit: 1`,
`ablation_runs: 1`, its numbers read as wiring evidence and never as a result. It met both
halves of the check:

| Half | Observation |
| --- | --- |
| log line names `sourceTrust=0.5` | `cortex-memory gate: threshold=0, retrievalThreshold=0.25, sessionBudget=unbounded, sourceTrust=0.5` |
| artifact names `sourceTrust=0.5` | JSON `memoryArmConfig.sourceTrust = 0.5`; the report header repeats the full line |

Both were read **before** the probe's accuracy was looked at, as this section requires.

The probe was dispatched from a script that was, at that moment, sending
`cortex_memory_retrieval_threshold: '0'` — so its own log line disagreed with §10.3 in
exactly the way §10.6 was not written to catch, and reading it is what exposed the fact.
Two defects, one class:

1. `cortex_memory_retrieval_threshold` sent `'0'` where this section registers `0.25`.
2. `cortex_memory_threshold` was **not sent at all**; the workflow default lands on `0`,
   which happens to equal the registered value — the `''` → `readNumeric` → default path
   §7.4 rejects, applied to the other gate.

Both are §7.3's side-channel in a fourth form: every layer works, the artifact records a
configuration, and the value is not the registered one. Repaired in `46e7251` (dispatch
sends `threshold: '0'` and `retrievalThreshold: '0.25'`), and guarded by
`tools/__tests__/test_preregistration_config.py`, which reads §10.3 itself and compares it
against the dispatch in both directions. `AUDIT-CODE-VS-DOCS.md` §6.4 carries the
generalisable statement: a gate on a key's plumbing is not a gate on its value.

**The precondition did its job**, and the job was larger than it was written to be. It
asked whether the value reaches the artifact; the answer was yes, and the same observation
showed that the value reaching it was the wrong one. A check that names one variable
verifies that variable and incidentally reports on the rest.

**Dispatched.** Run
[`37281155088`](https://github.com/AgentiX-E/cortex/actions/runs/37281155088) at `master` =
`ce7a0698`, one invocation of `tools/dispatch-cortex-memory-ab.py`, carrying all six §10.3
values. The script and the registration now agree, and `test_preregistration_config.py`
fails if they stop agreeing.

§4's stopping rule is now spent on this run. No redraw follows it, for a better draw or for
any other reason.

### 10.7 The dispatch did not produce a result, for a reason §8 already anticipated

Run `37281155088` completed as a **failure**, in step 14 (`Run cortex-memory A/B`). The
primary benchmark in step 13 succeeded and produced a full N=500 artifact; `pnpm check`
in step 9 succeeded. The arm's `benchmark-error.log` carries:

```
Error: LLM request failed: 402 Payment Required —
{"error":{"message":"Insufficient Balance", ...}}
    at ... OpenAICompatibleLLM.post (.../openai-compatible.ts:78:13)
    at ... NaturalLanguageMemorySystem.expandQuestion
    at ... runAblationReport (.../report.ts:276:20)
```

This is the case §8 names: *"a failure for an infrastructure reason (quota, artifact loss)
is re-dispatched with that reason recorded rather than treated as a result."* The LLM
account's balance was exhausted **during** the arm — the primary benchmark had already
completed at 08:33 and the arm ran until 09:25 before the first 402 — so this is not a
fast failure and not a code defect.

**It is not a result under §4, and it is not a redraw.** §4 forbids dispatching again for a
better draw; this is the same run re-attempted because it never produced a draw at all.
The distinction is the one §8 already draws, and it is recorded here rather than assumed.

**The client is correct to reject 402 rather than retry it.** `isRetryableStatus` is
`429 || status >= 500`, so a 402 is thrown on the first response and `retryableFetch`
does not spend its budget on it. A balance that is empty stays empty through any number
of attempts, so retrying would only delay the diagnostic.

**What the failure did establish**, none of which needed the arm to complete:

| Observation | Evidence |
| --- | --- |
| The dispatch carried all six §10.3 values | the dispatch log, and step 14 running at all |
| The arm reached the LLM reader with them | the stack: `expandQuestion` → `complete` → `post` |
| The failure is isolated to the arm, not the run | step 13 `success`, step 9 `success` |
| The primary benchmark is unaffected | its own N=500 artifact, `38.80%` → `44.80%` |

**Re-dispatch is gated on the account, not on the code.** Nothing in this repository
needs to change first, and no re-run should be attempted until the balance is restored --
a second attempt against an empty account would fail at a different question and record
nothing new.

**A gap worth naming, not yet repaired.** The error log carries a stack but no progress
counter: the arm ran ~52 minutes and the report says neither how many questions it
completed nor where it stopped. The embedding path already persists partial work on
failure (`run-ablation.ts` writes the cache from the `catch`), so the asymmetry is
deliberate for caches and absent for progress. Recorded here as an observation rather
than fixed in this commit, because it is a diagnostic improvement rather than the defect
this section is about.

### 10.8 The gap in 10.7 is now closed, and the re-dispatch is unblocked

§10.7's last paragraph named the missing progress counter and deliberately left it out of
that change. It is repaired in `0db7a9b`, on its own, so that a diagnostic improvement is
not smuggled in under an infrastructure failure's name.

**What changed.** `runBenchmark` gained an optional progress sink, forwarded with
conditional assignment through `evaluateWithScorer*` → `runAblation` → `runAblationReport`
→ `runCortexMemoryArm`. The entry point prints it (first question, last question, and every
`PROGRESS_EVERY`), and its failure handler now writes, above the stack:

```
progress: died on cortex-memory run=0 q=213/500 id=<question-id>
```

**Two design points are the whole value, and both are asserted by test.**

1. **It fires BEFORE the answer call.** `progress-callback.test.ts` records the
   interleaving (`progress:n` immediately precedes `answer:n`) and asserts that the
   question which threw is in the record while the next one is not. A completion-time
   callback would satisfy a "was it called" test and still leave the dying question
   unnamed — which is exactly what `37281155088` did over 52 minutes.
2. **It is an input and never an output.** The callback is a function, the report is
   JSON, and `report-json-roundtrip.test.ts` asserts the round-trip. So the option is a
   separate field rather than a pass-through of the options object, and
   `ablation-progress.test.ts` pins `'onProgress' in report === false`.

**Why the ordinal is a parameter.** `runAblation` evaluates the baseline to completion,
then the feature, then both again per extra run, so `(system, run, index)` identifies one
attempt. `run` is passed in by the loop that owns it rather than derived inside
`runBenchmark`, which cannot know its repetition — and that also keeps the two evaluation
wrappers free of a branch and a per-call closure, so there is no new branch to cover in
the hot path.

**Where the printing lives, and why.** In `packages/cortex-memory/bench/run-ablation.ts`,
not in `cortex-eval`. `cortex-eval/src` emits nothing to a stream anywhere in the package,
and an instrument that wrote to one would put output policy inside the measurement. The
sink is a callback for the same reason.

**Verification.** `pnpm check` `rc=0`; `cortex-eval` 1623 tests at `100/100/100/100` —
branch coverage moved `99.95` → `100`, so every branch the change introduced is covered;
census reports no new orphans (which is also why the new types are referenced by the entry
point rather than only by the barrel); the other four packages are unchanged.

**Unblocked.** With the balance restored and this in place, the §10.3 dispatch is
re-attempted as the next action. It is the same configuration as `37281155088` — that run
produced no draw, so this is the infrastructure re-dispatch §8 names, not a redraw — and
if it fails again the log will now say where.

---

### 10.9 The run produced a draw, and the draw refutes the gate

**Run** `37313582403`, `success`, on `8831b264` — the commit the re-dispatch was sent
against, now carrying §10.8's progress sink. Step 13 (`Run benchmark`, the reference
baseline) and step 14 (`Run cortex-memory A/B`) both completed. This is the first draw
this registration has produced: `37280315123` was the probe, `37280680006` was cancelled
inside 30 seconds for the §10.6 configuration defect, and `37281155088` produced no draw
at all (HTTP 402). No infrastructure reason applies here, so this is read as a result.

**The configuration is read off the artifact, not off the dispatch's intent.** The report
records `threshold=0`, `retrievalThreshold=0.25`, `sessionBudget=unbounded`,
`sourceTrust=0.5` — the four values §10.3 registers, and the two that
`test_preregistration_config.py` pins by parsing §10.3 itself. §10.6's precondition is
therefore satisfied in the strong sense it asked for: the artifact names the arming.

**The prediction was wrong, and the direction is the informative part.** §10.4 predicted
abstention would **fall**, on the argument that a `0.25` cut sits near the middle of a
mass bounded by the `0.5` ceiling. It did not fall. It moved almost the entire remaining
range the other way:

| Quantity | `reference-pipeline` (control) | `cortex-memory` (feature) | Δ |
| --- | --- | --- | --- |
| Abstention rate | 49.40% (247/500) | **95.80%** (479/500) | **+46.40pp** |
| Abstention-aware accuracy | 43.80% | **6.60%** | **−37.20pp** |
| Correct | 219 | 33 | −186 |
| Aggregate avg, 4 runs | 43.75% | 6.50% | −37.25% |

**Statistics.**

- McNemar **p = 2.039e-56**; discordant pairs **186 baseline-correct/feature-wrong** and
  **0 baseline-wrong/feature-correct**.
- Welch t-test over the four stochastic runs **p = 4.462e-10**; Cohen's d **−190.26**.
- Baseline Wilson CI **[39.51%, 48.18%]**; feature Wilson CI **[4.74%, 9.12%]** — the two
  intervals are disjoint by a wide margin.

A discordant split of 186 to 0 is the most extreme form this comparison can take. There is
no subset of the dataset on which this arming helps.

**Where the loss is, and what it says about the mechanism.** The damage is not diffuse. It
sits exactly on the two capabilities the baseline solves, and abstention is what eats them:

| Capability | Baseline abstained | Feature abstained | Baseline correct | Feature correct |
| --- | --- | --- | --- | --- |
| MR | 2 | 117 | 105 | 2 |
| TR | 20 | 122 | 83 | 0 |
| IE | 136 | 149 | 1 | 1 |
| KU | 59 | 61 | 0 | 0 |
| ABS | 30 | 30 | 30 | 30 |

MR falls `86.78% → 1.65%` and TR falls `65.35% → 0.00%`, each at McNemar p < 1e-24. IE and
KU are unchanged and were already near the floor before the arm; ABS is `30/30` on both
sides by construction. The feature's entire score, `30/500 = 6.00%`, is therefore the
**always-abstain floor** plus three questions: as armed, the arm is very nearly an
unconditional abstainer.

**The mechanism, as the numbers describe it.** A `0.5` ceiling bounds the admission scores
*from above*. For the `0.25` retrieval cut to behave as §10.4 predicted, the bounded mass
would have to sit largely **above** `0.25`. The observed behaviour is only consistent with
the mass sitting largely **below** it, so the gate closes on the questions the baseline was
answering instead of opening the ones it had declined. That is a concrete, falsifiable
statement about the admission-score distribution which §10.4's prediction got backwards —
and it is worth recording precisely because it was predicted in writing first. **The
reading is §10.4's fourth row, not its middle row.**

**Verdict, per the pre-committed table.** §10.4's fourth row applies verbatim:

> `p < 0.05 with delta < 0` → the gate harms; reported as a refutation and reverted to
> `retrievalThreshold: 0`

The gate is wired and reachable — abstention moved 46.40pp, so the third row ("unchanged to
the digit") does not apply — and at this arming it is strictly harmful. The recovery is the
revert §10.4 fixed before the number existed. It is executed as its own change, in §10.3
and in `tools/dispatch-cortex-memory-ab.py`, so a refuted configuration is not left
half-applied.

**What this does NOT claim.** It does not claim a machine-derived admission gate is
impossible, and it does not license sliding the threshold to `0.1` to hunt for a better
number — that is the redraw §4 forbids, and it is the specific temptation the third row of
the §10.4 table was written to pre-empt. What is established is narrower and firmer: **at
`retrievalThreshold: 0.25` with `sourceTrust: 0.5` and `threshold: 0`, this gate loses 186
questions and wins none.** A future attempt must be a new registration carrying its own
prediction, not a slide of this one's dial.

**One thing the run re-confirmed.** The control side's own number is reproduced at full
scale under the recharged key: `reference-pipeline` at **43.80%** abstention-aware accuracy
on 500 questions, consistent with §10.7's composition-arm finding on the same dataset.

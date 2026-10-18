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
exactly `1`. `decideRetrieval` thresholds the **value function's output** — not the
`confidence` field; see the correction in §10.10 — so the reachable range for this arm is
`[0, 0.5]`: every threshold at or below `0.5` is **always open**, and every threshold above
it is **always closed**.

Because the three factors multiply to the constant `0.5` for *every* admitted turn, the
reachable range is not merely bounded but **degenerate**: within `[0, 0.5]` the gate cannot
distinguish one threshold from another, and `0.25` is a no-op. The distinction matters
because it changes what a later comparison could have shown. A bounded-but-populated range
would make a cut at the midpoint a real experiment; a single point makes every threshold in
the range the same experiment, which is why §10.9's draw was read against the wrong
hypothesis.

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
* **The multi-session block's closing line — adopted by §13.61.** Under `enumerated` the
  block's last line is `Reply with the Step 2 number alone. If the Step 1 list is empty
  because the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE.`
  It replaces the `extractive` block's unconditional close, which was the last thing the
  model read and re-licensed the decline after every qualifier above it. Adopted on
  mechanism, not on the `+29.45pp` run that followed: the forbidden state fell 12 → 7,
  MR's declines fell 23 → 20, and the predicted cost appeared as `numeric_mismatch`
  27 → 32. §13.61.5 states what that decision does not claim.
* **`relevanceSignal: retrieval-hybrid` — adopted by §13.64.** Dense cosine fused with a
  rare-keyword channel by reciprocal rank (`retrieveTopKByQueriesHybrid`). Adopted on TR's
  +17 (85/127, eighteen declines turned into correct answers), no capability regressed, and
  the grounding share of TR's correct answers rose rather than fell. **Its three registered
  mechanism predictions were falsified** — the pool's reach did not improve — and §13.64.4
  records that the coverage instrument measures quantity while the effect moved *which*
  turn decides. A run with `relevanceSignal=retrieval` is the pre-§13.64 configuration.
* `limit: 0`, `ablation_runs: 4`, `temperature: 0` — unchanged.
* `promptContract: abstention-evidence-blocks` — **held from §12.5 while §13's ask is
  reverted by §13.9.** It stays in this list because §13's comparison is two-axis: the
  ask moved and the rendering did not, so a run that dropped back to the baseline
  rendering as well would move both at once and attribute the result to neither.
* `ask: enumerated` — **set by §13.34, after §13.26 sent `computed`.** It is `computed` plus
  a **two-step contract on the multi-session route alone**: enumerate every matching item with
  its date, compute the answer from that list per the question's kind, and make the abstain
  token conditional on the list existing. Run `38828538851` is why — MR's 47 wrong answers
  include **41 numeric mismatches**, and 22 questions abstained with 14–20 gold turns already
  in the window, so the reader holds the evidence and either miscounts it or declines with it
  in hand, while the reference pipeline scores 86.78% on MR over a *smaller* window using a
  two-step contract of its own. On flat and temporal this ask is **byte-identical to
  `computed`** (asserted in `evidence-ask-reach.test.ts`), so §13.26's TR gain and IE's 88.67%
  on the flat path are held and the only route whose reading moves is multi-session. The
  reach set is unchanged from `computed` — the artifact separates the two asks by this value
  beside an unchanged `askRoutes` — and the multi-session route needs its own scope argument
  because `buildSessionPrompt` and the flat path both build with the `extractive` contract.  Sent explicitly rather than left blank for the reason `sourceTrust` is. §13.3 records the
  four values this entry replaced, in order, and why each was retired.
  §13.8 falsified the ask
  hypothesis at the time -- with
  the `extractive` ask the feature side's MR went `13 -> 0` and TR `16 -> 0`, so
  `b✓f✗` rose by exactly the amount `b✗f✓` fell — a swap, not a repair — and §13.9
  marked the line dead. What §13.11 asks instead is a question about the evidence
  rather than about how it is asked: `QuestionRecord.turns` was `[]` on all 120
  records of the §13 dispatch, so "the reader was shown the wrong turn" and "the
  reader was shown nothing" were the same absence in the artifact. That capture is
  now wired end to end, and this registration names the run that exploits it. The
  ask is held at §13's value rather than reverted, because reverting it would restore
  the shipped per-route blocks and change the surface the evidence capture is being
  read from.
  *(**status: decided, by run `39005914398` (§13.45).** `+26.95pp` against `computed`'s
  `+25.75pp`, MR 51.24% against 42.15%, McNemar p = 6.053e-15 over four repetitions. The
  dispatch that decided it was §13.41.6's, and it required two instrument repairs first:
  §13.40's `+26.75pp` was a transcript being judged (gate-true **0** of 33 gate decisions)
  and §13.41's `+23.25pp` was a gate reading an operand. **Both of those numbers are in this
  document and neither is a measurement of this ask**; the third is.)*
  **That reason expired, and §13.20 is what expired it.** The capture is independent of
  the ask since §13.19 -- `goldOverlap` is measured against the captured context, not
  against the prompt -- so the fixed surface is no longer load-bearing. What replaced it
  is a reading: `38394103193` measured gold coverage per question for the first time and
  every one of the 56 MR and 88 TR abstentions had at least one gold turn **inside the
  context the model was shown** (56/56 and 87/88), and every abstention in the run was the
  bare `INSUFFICIENT_EVIDENCE` token. The ask is therefore not a wording preference: the
  `extractive` block *removes* each route's reasoning instruction, and the two instructions
  it removes are the temporal block's date resolution and the knowledge-update block's
  earlier-versus-later rule -- on exactly the two capabilities the feature side loses.
  Reverting to `route` restores them and moves nothing else.
  **§13.20's run confirmed that and localised what is left.** `38439899858` moved TR's
  abstention rate from 69.3% to 35.4% and its accuracy from 22.05% to 49.61%, KU from
  73.61% to 86.11%, ABS to 100%, and the arm's delta from +9.25pp to **+18.20pp** with
  McNemar `p = 2.737e-7` -- while **MR did not move at all** (56 of 121 abstentions, the
  same 56). That is the internal control behaving exactly as `ASK_ROUTES` says it must:
  MR's own ask already was `extractive`, so `route` is a no-op there.
  What is left is MR, and it is the only capability on which the feature side loses
  (27.27% against the reference pipeline's 88.4%). Its 56 abstentions all had the gold
  evidence carried and all were the bare decline token, so it needs an instruction rather
  than more evidence -- and it cannot be given a global one without disturbing the four
  routes §13.20 just repaired.
  Hence `aggregate`: the extractive block plus one sentence saying the answer may require
  combining evidence from more than one turn or session. It reaches exactly
  `multi-session` and `flat` (the two routes whose contract IS `extractive`) and leaves
  the other four byte-identical, which is both the mechanism and the control.
  **§13.21's run confirmed the mechanism and moved the target.** `38487229554` took MR from
  27.27% to 44.63% and its abstentions from 56 of 121 to 24 of 121, and the arm's delta from
  +18.20pp to **+23.25pp** with McNemar `6.479e-12` -- while **TR became the largest
  remaining loss**, 48.82% against the reference pipeline's 64.57%, with 51 of its 127
  questions abstaining. Those 51 are not a retrieval result: 50 had the gold turn carried,
  and the run's abstention tally is 121 of 500 with `llm` as the only counted reason.
  The questions are durations, differences and orderings assembled from several turns --
  the same property under which MR was declining before `aggregate` reached it -- and the
  temporal block does not address it, because its own instruction is about resolving dates
  and its closing line concedes that the evidence may not establish one.
  Hence `computed`: **each reached route's own block, with the sentence inserted immediately
  above its closing line**, reaching `multi-session`, `flat` and `temporal`. It composes
  rather than substitutes because §13.20 measured substitution as destructive -- deleting
  the temporal block cost TR 27.6 points and restoring it returned 27.6. On the two routes
  whose own block already IS the extractive one it is **byte-identical to `aggregate`**,
  asserted in `evidence-ask-reach.test.ts`, so the single variable between §13.21's run and
  this one is what the temporal route reads. `abstention` is deliberately out of reach:
  its block calls declining "expected and is a valid outcome" and ABS's gold IS abstention.
* `evidenceTurnsPerRecord: 256` — **added by §13.12, re-valued by §13.15.** Track `b✗f✓`. Run `38003036421`
  completed all four runs of all five hundred questions and then died writing the JSON
  with `Invalid string length` (§13.11.10). The evidence is carried
  unbounded — `admission.ts` declines to truncate and the arm admits every session — and
  carried **twice**, once in `ablation.featureRetrievedContexts` and once as
  `questions[].turns[].text`. This bounds what is **carried** and never what is
  **measured**: `evidenceTurns` and `evidenceChars` are recorded unreduced on every
  record, so §13.11.3's two predictions survive any bound. It is registered rather than
  discovered, because a bound that decides what the artifact contains is a measurement
  decision, and a measurement decision taken after the fact is what pre-registration
  exists to prevent.
* `relevanceSignal: retrieval` — **added by §13.17, and it is the selection variable.**
  §13.16 read run `38142407062` and found the prompt spending its entire budget correctly
  while buying the wrong turns: the delivered context contained the gold turn for **11.6%**
  of questions (14 of 121) against a ceiling of **92.1%**, the share of questions whose
  answer turn is in the bundle at all. The budget itself is settled arithmetic — 24,000
  characters against a capacity of roughly one hundred and sixty-seven turns, carrying
  4.69% of a 506,338-character mean context — so nothing about its size is left to vary.
  What is left is **which** turns it buys, and until this registration nothing beneath the
  prompt builder ranked anything: on this arm arrival order is the dataset's haystack
  order. `retrieval` builds an index over each question's own context with the arm's own
  embedding backend, using the same bi-encoder the reference pipeline retrieves with, so
  the two sides answer from one notion of relevance rather than two. Selection is by
  relevance and **presentation stays chronological**, because a prompt printed in relevance
  order would make relative-time and knowledge-update questions unanswerable. The signal is
  built from the question text and its context and never from the answer key: the case type
  has no ground-truth parameter, so this is structural rather than promised, and
  `relevance-index.test.ts` measures it by building two indices from cases that differ only
  in an unread field.
* `relevanceTopK: 64` — **added by §13.17.** The width the index scores at, registered
  separately because the signal's name and the signal's extent are different claims: a
  `retrieval` signal built at a width of `8` ranks almost nothing, and an artifact naming
  only the signal would make that run and this one look like the same experiment.
  `MEASURE-B2-RECALL-CURVE.md` measured `recall = 0.921` at `k = 50` with a curve that had
  already flattened, so any width at or above the knee is complete for this dataset's
  purpose and 64 is that with a margin for the six-question floor being an artifact of a
  different sample. It is also below the budget's own capacity of roughly one hundred and
  sixty-seven turns, which is the property that makes the width inert with respect to the
  budget: every scored turn survives selection, so widening the index would reorder the
  low-scoring turns rather than admit more high-scoring ones. Sent explicitly rather than
  left blank for the reason `sourceTrust` is: a value that never reaches the environment is
  a value this guard cannot compare against the registration.
* `relevanceUnits: turn` — **added by §13.27, refuted by §13.31, and held at the shipped
  default by §13.34** because the variable of that dispatch is the ask: §13.26 is its
  comparison, so the signal, the width, the room and the unit all stay where that run left
  them. §13.31's `session-fill` remains the repaired form of §13.27's rule and remains the
  best-known session allocation, but it is not what this run administers. The rest of this
  entry is the registration that produced run `38828538851`, kept because its refutation and
  its repair both rest on it: **added by §13.27 as the selection unit.** Registered separately from `relevanceSignal` because the two are different
  claims about one budget: the signal says **how a turn is scored** and this says **what a score
  buys**. A unit folded into the signal's name would make a run that changed only the unit
  indistinguishable, in its own configuration line, from one that changed the scoring — and each
  dispatch moves only the unit, holding the signal at `retrieval` and the width at `64` so a
  movement cannot be attributed to either. `session-fill` spends the room on whole sessions
  ordered by their best-scoring turn, **skipping** a session that does not fit and continuing
  down the ranking; the signal itself does not change, because a session's score is the maximum
  of its turns' scores, so this is a regrouping of the same numbers rather than a second signal.
  It reaches the **multi-session route alone**, which is what makes the dispatch single-variable:
  `buildPrompt` is handed no session boundary, so the unit cannot be expressed on flat, temporal,
  knowledge-update, abstention or assistant. Sent explicitly rather than left blank for the reason
  `sourceTrust` and `relevanceTopK` are: `turn` is the default, so omitting it would happen to
  match — and it would arrive through the `''`-to-default path §38 identified as the source of two
  separate defects.
  **Why this is a third value and not an edit to `session`.** §13.27 registered `session`, which
  carries the largest **prefix** of the ranking, and run `38753835652` refuted it: `+17.80pp`
  against the turn unit's `+25.75pp`, MR 12.40% against 42.15%, MR abstentions 24 → 63. The defect
  is not the unit but the search — a session is far larger than a turn, so the first session over
  the line ends the pass and the rest of the room is never spent (that run's MR records carry a
  median of **12** turns against a room that holds about **23**). Editing `session` in place would
  make both archived artifacts ambiguous, since a configuration line is the only thing either one
  records; so `session` is **frozen** at exactly the rule that was measured, exactly as a
  confirmed-negative configuration is kept elsewhere in this project, and the repair arrives as a
  value whose name says which rule it is. A reader can therefore execute either run's
  configuration and get the run that was reported.
* `budgetMinutes: 90` — **added by §13.30, and it is a run option rather than a measurement
  configuration.** Each **pass** (one system over one repetition) is abandoned once it exceeds
  this ceiling, and the pass itself enforces it between questions, so a hang ends with a
  failure record naming the question it stopped at. §13.30 records why this exists: run
  `38725510400` hung for over five hours inside the reference pipeline's first question and
  never ended — the job-level `timeout-minutes: 240` did not fire — so its durable record was
  **empty** rather than thin. Ninety minutes is roughly three and a half times the longest pass
  any completed run has produced here (a full run is about `3h32m` for eight passes), because a
  ceiling that fires on a slow pass destroys the measurement it was meant to protect. It is not
  a member of `memoryArmConfig` for the reason that type's own docs give: the config is what the
  numbers are conditioned on and it is serialized, while a ceiling changes only whether the run
  finishes. Sent explicitly rather than left blank for the reason `sourceTrust` is.


  The value moved from sixteen to two hundred and fifty-six because §13.15 changed
  what the roster holds, and that is a change to what the bound protects rather than a
  loosening of it. The roster used to be the **offered** context — 3,016 to 4,528 turns
  per question — so sixteen was a real cut and a small artifact. It now holds the
  **carried** evidence, which the prompt budget already bounds at roughly one hundred
  and sixty-seven turns on this arm, so sixteen would have cut a set that was already
  bounded and destroyed the one thing §13.11.5 needs: the identities of the turns the
  model actually read. Two hundred and fifty-six is twice what the budget carries at
  this arm's measured one hundred and forty-four characters per turn, so it is a
  writability guard rather than a measurement, and if it ever bites the marker and
  `evidenceReduction` both record it rather than the roster silently losing turns.
> **Amended by §12.5, in place rather than below**, for the reason §10.9's note gives:
> `registered()` reads the list and stops at the first blank line, so an amendment note
> placed between the heading and the list would silently disable the guard. This entry is
> the first that is not a gate knob, and that is deliberate — the registration is still a
> registration of *the run's independent variable*, and §12.5 is where that variable
> changed from a threshold to a rendering.

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

**The mechanism, as first written, was wrong — see §10.10.** The paragraph above was
drafted from the two rates alone and attributed all `46.40pp` to the retrieval gate closing.
That is arithmetically impossible at this arming: the admission value is the constant `0.5`,
so `0.25 ≥ 0.5` is false and the gate never closed once. The `186` lost questions were
declined by the **model**, not by the gate. The corrected account, and the reason the
original reading was reachable at all, is in §10.10.

**Verdict, per the pre-committed table.** Read literally, this run does not fit any row
cleanly, and the honest report says so. Abstention did not fall, and it did not stay
"unchanged to the digit" either — it moved `+46.40pp`. §10.10 establishes that the movement
was produced by the model rather than by the gate, so the run discharged the *third* row's
underlying proposition (the arming is not in the reachable mass) while arriving at it by a
route the table did not enumerate. The table's fourth row was applied at the time, and §10.4
requires a `delta < 0` with `p < 0.05` to be **reverted to `retrievalThreshold: 0`** — a
requirement that holds regardless of which mechanism produced the negative delta, and which
was executed as its own change, in §10.3 and in `tools/dispatch-cortex-memory-ab.py`, so a
refuted configuration is not left half-applied.

**What this does NOT claim.** It does not claim a machine-derived admission gate is
impossible, and it does not claim the gate harms — §10.10 shows the run could not test the
gate at all. It also does not license sliding the threshold to `0.1` to hunt for a better
number, which is the redraw §4 forbids and the specific temptation the third row of the
§10.4 table was written to pre-empt. What is established is narrower and firmer: **at
`retrievalThreshold: 0.25` with `sourceTrust: 0.5` and `threshold: 0`, this arming produces
a `6.60%` endpoint, 186 questions below the control and none above it — and §10.10 shows
the gate was inert while that happened, so the deficit is attributable to the arm's
composition, not to its retrieval cut.** A future attempt on the gate must be a new
registration carrying its own prediction *and a reachable arming*, not a slide of this one's
dial.

**One thing the run re-confirmed.** The control side's own number is reproduced at full
scale under the recharged key: `reference-pipeline` at **43.80%** abstention-aware accuracy
on 500 questions, consistent with §10.7's composition-arm finding on the same dataset.

### 10.10 Correction: the gate was inert, and §10.9 attributed the draw to it

**What was wrong.** Two statements, one in this file and one downstream of it.

1. §7.4-adjacent prose near the ceiling arithmetic said `decideRetrieval` compares
   `confidence >= threshold`. It does not. It thresholds the value function's output:
   `best = Math.max(best, clamp01(valueFn(m, queryContext)))` in
   `packages/cortex-core/src/value/value.ts`, and the local variable is named `confidence`
   only because it is the best value the loop found. The field named `confidence` on a
   memory is one *input* to that value and is never the compared quantity.
2. §10.9 therefore attributed the `+46.40pp` abstention movement to the retrieval gate
   closing. It could not have. `admission.ts` passes `sourceTrust: 0.5` to `createMemory`,
   sets `lastAccessedAt === createdAt === options.now`, and does not pass `confidence`, so
   the default of `1` applies. The value is `1 × 0.5 × (0.5 + 0.5 × exp(0)) = 0.5` for every
   admitted turn — a constant, not a distribution. `0.25 ≤ 0.5`, so `retrieve` was `true`
   on every question. **The gate never closed once, and this ablation never tested it.**

**How the correction was established.** Independently, not by re-reading:

| Probe | Threshold | `retrieve` |
| --- | --- | --- |
| `admitTurns(..., { sourceTrust: 0.5 })` → value | — | `0.5`, `0.5` (constant) |
| same candidates | `0` | `true` |
| same candidates | `0.25` (registered) | `true` |
| same candidates | `0.5` | `true` |
| same candidates | `0.5 + 1e-9` | `false` |
| same candidates | `0.51` | `false` |

The boundary sits exactly at the ceiling, so the reachable range is `[0, 0.5]` for opening
and `(0.5, 1]` for closing. The write gate is inert for the same reason: `threshold: 0` with
`sessionBudget: unbounded` admits all three sessions and all nine turns.

**Where the `95.80%` came from.** From the model. With both gates open, the only path to
`answerAbstention` returning `null` that remains is the LLM emitting `UNANSWERABLE`
(`reason: "llm"`). The feature arm is not an armed gate; it is a composition whose prompt
makes the model decline. That is a legitimate finding about the composition and it is
*not* a finding about the retrieval gate.

**A diagnostic gap this exposed.** `decisionReasons` is produced only by
`packages/cortex-eval/bench/run.ts` (the reference CLI). `cortex-memory/bench/run-ablation.ts`
does not emit it, so the arm's artifact cannot say whether an abstention came from `empty`,
`threshold`, or `llm`. The attribution above had to be reconstructed from source and a
separate probe rather than read off the run's own output. Closing that gap is the
prerequisite for any future arming registration: a gate experiment must be able to report
whether the gate fired.

**The lesson, which generalises past this arm.** Testing that a knob *has an effect* is not
testing that the knob is *reachable*. `abstention-decision.test.ts` exercised `0.9` (closed)
and `0.1` (open) and passed — but it varied the threshold and never the ceiling, and under
the single-point hypothesis those two samples are entirely consistent with an inert knob. A
parameter can be accepted, recorded in the artifact, echoed in the dispatch line, and still
be inert, because the quantity it thresholds has a range the caller's *other* settings
collapsed to a point. The guard is
`packages/cortex-memory/src/__tests__/retrieval-reachable-range.test.ts`, which pins the
constant, the boundary, and the widening — and which fails all four of its assertions if
`sourceTrust` is dropped from the value function.

**What is *not* being done about it.** §10.9's stats are untouched and remain correct as
statistics; only their attribution changes. The revert of `retrievalThreshold` to `0`
stands, and for a stronger reason than §10.9 gave: the arming was a no-op, so a new
registration is required regardless. No threshold will be slid to `0.1` to search for a
number — with a degenerate range, every value in `[0, 0.5]` is the same experiment, so the
next step is to make the range *reachable* (raise the ceiling, or admit with varying
`confidence`), then register a cut against a range that can respond to it.

## 11. The discriminating registration: what must exist before a cut is registered

§10.10 ended with two candidate repairs — raise the ceiling, or admit with varying
`confidence` — and left which one to a later round. §49 (`09-progress-and-delivery-report.md`)
took the first and measured that it is **not sufficient**, which turns the second from an
alternative into a prerequisite:

| Ceiling | Reachable range | Can it separate a strong turn from a weak one |
| --- | --- | --- |
| `0.5` (default) | `[0, 0.5]`, a point | no (§10.10) |
| `1` | `[0, 1]`, a set | **still no** |

At `sourceTrust: 1` every admitted turn carries exactly `1`, so `0.9999` admits everything
and `1 + 1e-9` admits nothing. The fix that §10.10 named makes the range reachable and
leaves every cut inside it all-or-nothing.

### 11.1 The prerequisite, delivered

`GateOptions.confidenceFor?: (turn: string) => number`
(`packages/cortex-memory/src/types.ts`) supplies the per-turn variation,
`AdmissionOptions.confidenceFor` carries it into `admitTurns`, and
`confidenceFromLength` (`packages/cortex-memory/src/confidence.ts`) is the signal the arm
passes. `DESIGN-CORTEX-MEMORY.md` §6.5 records the design; the short form is:

- **the mechanism is the composition layer's**, so the layer owns it and can test it;
- **the signal is the caller's**, because a real quality estimate needs an embedding or a
  lexical index and `cortex-memory` reads neither — measuring turn quality there would make
  the composition layer depend on the retrieval mechanism it sits above;
- **the default is absent**, so `confidence` stays at `createMemory`'s `1` and every run
  whose artifact predates the field keeps its meaning.

`min(1, length / 2000)` is the shipped signal. It is chosen for being the *weakest*
defensible one — no model, no vocabulary, no tuning corpus — and it is not a claim that
length predicts relevance. The artifact records which signal ran, so a later registration
can replace it and compare.

### 11.2 What a cut on top of it may and may not be

The next registration may now name a `retrievalThreshold` inside `(0, S]` and a
`confidenceSignal`, because the pair is what makes the cut *about* something. Two
constraints carry over from §4 and are not relaxed by the mechanism arriving:

1. **One dispatch, no threshold search.** The prediction is stated before the run and the
   stop rule is unchanged. Bringing the range to life does not license sliding a cut
   through it to find a number that wins — that is the sweep §4 exists to forbid, and it
   would be hidden rather than healed by the fact that the numbers now differ.
2. **The zero hypothesis is still the expected outcome** until a run says otherwise. §11.1
   makes a discriminating cut *expressible*; it does not predict that any particular cut
   helps, and the registration has to name its threshold and its prediction before dispatch.

### 11.3 The defect this round would have shipped without the gate

The first draft exported `ConfidenceFunction` and `CONFIDENCE_SATURATION_CHARS` through the
barrel. Both had only test callers, so `pnpm check`'s export census reported them as new
orphans and the check failed. The remedy was to narrow them, not to add them to
`tools/export-census-baseline.json`: the baseline is a debt ledger, and an entry added for a
symbol two hours old is a decision to keep an unused export forever.

This is §10.10's diagnostic-gap lesson one level over. There, the artifact could not say
which mechanism fired. Here, the *code* could not say which symbols have consumers — and
both are the same failure: a claim nobody could check from the evidence present. The census
gate is what made the second checkable before the commit rather than after a reader asked.

## 12. The reachable-cut registration

§11.2 permits a registration to name a `retrievalThreshold` inside `(0, S]` and a
`confidenceSignal`. This is that registration, and the two quantities are named from
measurement rather than from arithmetic — because the measurement says the arithmetic
was answering the wrong question.

### 12.1 What was measured, and where the numbers come from

The dispatched run `37313582403` published a `longmemeval-s-report` artifact whose
`benchmark-diagnostics.json` carries the embedding score distribution over the 100-question
diagnostic subset. That distribution was read, not re-derived:

| Quantity | Value |
| --- | --- |
| diagnostic questions | 100 (76 answerable) |
| `recallAt1` | 0.368 |
| `recallAt5` | 0.763 |
| hit scores (`n=28`) | range **`[0.5212, 0.7861]`**, median 0.686 |
| miss scores (`n=48`) | range **`[0.5165, 0.7944]`**, median 0.637 |
| `recommendedThreshold` | **0.6433** |
| minimum score over all 76 | **0.5165** |

### 12.2 The first finding: the dispatched threshold was below every score

The arm dispatched `retrievalThreshold: 0.25`. The minimum score in the dataset is
**0.5165**. So the retrieval gate admitted **every candidate on every question** — not
because the gate was inert in the §10.10 sense, but because the cut sat 0.267 below the
lowest value the gate could ever see.

§10.10 established one reason the gate could not close: `sourceTrust: 0.5` with no
`confidenceFor` makes the value a constant `0.5`, so `0.25 ≤ 0.5` gives `retrieve = true`
always. This adds a **second, independent** reason, present even after §11.1 makes the
value vary: the cut is below the data's support. Two independent inerting causes, and
§10.10 caught only the one visible from the code — the other is only visible from the
artifact, which is why §11.2's "state the quantity before the run" is not enough on its
own. The quantity also has to be **inside the range the data produces**, and that range
has to be read from a prior run rather than assumed.

### 12.3 The second finding: the cut cannot carry the arm

This is the part that changes the plan rather than the parameters. Sweeping the threshold
over the measured distributions:

| cut | hits admitted | misses admitted | precision | hit recall |
| --- | --- | --- | --- | --- |
| 0.25 (dispatched) | 28/28 | 48/48 | **0.368** | 1.000 |
| 0.50 | 28/28 | 48/48 | **0.368** | 1.000 |
| 0.598 | 27/28 | 31/48 | 0.466 | 0.964 |
| 0.6433 (recommended) | 22/28 | 21/48 | 0.512 | 0.786 |
| 0.70 | 11/28 | 7/48 | 0.611 | 0.393 |

The hit and miss distributions **overlap almost completely**: hits `[0.5212, 0.7861]`,
misses `[0.5165, 0.7944]`. The best precision reachable at full-ish recall is **0.466**,
and every cut that raises precision past `0.51` costs more than half the hits.

A cut with precision `0.466` against a base rate of `28/76 = 0.368` is a lift of **1.27×**.
That is a real but small effect, and it is nowhere near enough to move a benchmark whose
feature side currently sits at `6.6%` while the baseline sits at `43.8%`. **A Δ of −37.25pp
cannot be closed by a retrieval cut**, and registering one as the arm's mechanism would be
choosing a knob because it is available rather than because the evidence points at it.

**So this registration does not name a `retrievalThreshold`.** §11.2 permits one; the
measurement shows it cannot bear the weight, and naming it anyway would produce a run that
is expensive, falsifiable, and uninformative.

### 12.4 What the evidence does point at

The per-capability table in the same artifact localises the loss precisely:

| Capability | Total | Baseline | Feature | b✓f✗ | b✗f✓ |
| --- | --- | --- | --- | --- | --- |
| IE | 150 | 0.67% | 0.67% | 0 | 0 |
| MR | 121 | 86.78% | 1.65% | **103** | **0** |
| KU | 72 | 0.00% | 0.00% | 0 | 0 |
| TR | 127 | 65.35% | 0.00% | **83** | **0** |
| ABS | 30 | 100% | 100% | 0 | 0 |

Two facts, and they are the whole diagnosis:

1. **The damage is entirely in MR and TR**, the two capabilities with real baseline
   accuracy to lose. IE and KU are near-zero on both sides, and ABS is already perfect.
2. **`b✗f✓ = 0` across every capability.** The feature side repaired **not one question**.
   A gate that is merely mistuned produces some repairs and some breakages; zero repairs
   with 186 breakages is the signature of a gate that is shut, not a gate set wrong.

That contradicts the abstention reading. Feature abstention is `95.8%`, and §10.10 showed
the abstentions are the model's (`reason: "llm"`), not the gate's. So the feature side is
not declining to answer because evidence is filtered out — it is reaching the model, and
the model declines. Combined with `b✗f✓ = 0`, the question is therefore **what the feature
side sends to the model**, not what the cut admits.

### 12.5 The registration

**Hypothesis.** The `cortex-memory` feature side loses MR and TR because its prompt
contract does not present evidence in a form the reader can use, and not because the value
gate filters evidence out. The gate is a red herring for this arm.

**Prediction, stated before the run.** Replacing the `abstention` prompt contract's
evidence rendering — while leaving `threshold`, `retrievalThreshold`, `sessionBudget`,
`sourceTrust` and `confidenceFor` **exactly as dispatched** — will move MR and TR off zero.
In the same run:
- MR and TR feature accuracy will each be **> 0%**, since `0/121` and `0/127` are the
  numbers being explained;
- `b✗f✓` will be **non-zero** for at least one of MR/TR, because a rendering fix that
  repairs nothing is not a rendering fix;
- and the overall feature accuracy will stay **below** the baseline. A prompt-contract fix
  is not predicted to close a −37.25pp gap, and predicting that it would is the
  overclaim this section exists to prevent.

**What would falsify it.** If MR and TR stay at exactly 0% with `b✗f✓ = 0`, then the
evidence never reaches the prompt at all and the loss is upstream of rendering — which
would point at `#admit` returning nothing on those capabilities and make the next
investigation a trace of admitted-turn counts per question rather than a prompt change.

**What is explicitly NOT done.** No threshold is named. No sweep is performed: §4 forbids
it, and §12.3 shows the sweep's answer before spending the quota. The `0.25` that was
dispatched is recorded as a defect found, not repaired by sliding it to `0.598`.

### 12.6 The naming defect found while reading

`recommendedThreshold` is `percentile(sortedHits, 0.25)`
(`packages/cortex-eval/src/retrieval-diagnostics.ts:241`). For 28 hits that is
`sortedHits[6] = 0.6433` — the **25th percentile of the hit distribution**, a coverage
heuristic meaning "admit roughly 75% of hits". It does **not** maximize precision, it does
not consult the miss distribution at all, and its name asserts a recommendation it does
not compute.

A reader who saw `0.6433` and the word *recommended* pulled it into `INPUTS` as
`cortex_memory_retrieval_threshold` — that is how the dispatch came to carry a number whose
provenance was a percentile of the hits. The behaviour is defensible as a coverage rule;
the name is what misled, and the name is a two-word fix. It is recorded here rather than
silently renamed, so the next reader can see why the number in the artifact is `0.25` and
not `0.6433`.

### 12.7 The falsification condition cannot be reached by this dispatch, and that was not visible before the read

**Found while reading the artifact §12.5 was dispatched for.** This subsection does not
move the hypothesis or the prediction; it records that one of §12.5's four stated
outcomes was unreachable by construction, so the result below cannot be scored against
it.

#### What §12.5 said would falsify the hypothesis

> If MR and TR stay at exactly 0% with `b✗f✓ = 0`, then the evidence never reaches the
> prompt at all and the loss is upstream of rendering — which would point at `#admit`
> returning nothing on those capabilities and make the next investigation a trace of
> admitted-turn counts per question rather than a prompt change.

#### What the run returned, and why it is none of the four

`bcf66463`, `limit=120`, `ablation_runs=1`:

| capability | baseline | feature | `b+f-` | `b-f+` |
| --- | --- | --- | --- | --- |
| MR | 13/17 | 0/17 | 13 | 0 |
| TR | 15/17 | 0/17 | 15 | 0 |
| IE | 0/52 | 0/52 | 0 | 0 |
| KU | 0/17 | 0/17 | 0 | 0 |
| ABS | 17/17 | 17/17 | 0 | 0 |
| total | 45/120 | 17/120 | 28 | **0** |

MR and TR are at exactly 0%, and `b-f+ = 0`. Read against §12.5 as written, that is the
falsification: "the evidence never reaches the prompt at all".

**It does reach the prompt**, and that was measured rather than argued. Under the gate
values this artifact records (`threshold: 0`, `retrievalThreshold: 0`,
`sessionBudget: infin`, `sourceTrust: 0.5`) and `promptContract:
'abstention-evidence-blocks'`, an MR question's prompt carries both of its turns
verbatim, the temporal prompt carries the date and the evidence, and the abstention
prompt carries its context. The `#admit` trace §12.5 pointed at is not needed: 120 of
120 roster records carry a populated `rawOutput`, and `#lastRawOutput` is written only
after `#llm.complete` returns, so no gate returned early on any question.

#### Why the condition was unreachable, and what it assumed

`memory.ts` substitutes `promptContract` on one condition:

```ts
const resolved =
  contract === 'abstention' && this.#options.promptContract !== undefined
    ? this.#options.promptContract
    : contract;
```

`runBenchmark` dispatches `answerAbstention` for `capability === 'ABS'` only. So
`abstention-evidence-blocks` reaches **17 of 120 questions**, and ABS gold *is*
abstention — the variable is installed on the questions where declining is correct.

The falsification clause could therefore only ever fire on MR/TR, which never receive
the rendering. Its inference was: *MR/TR at zero, therefore evidence is absent.* Two
causes produce that antecedent, and the clause named one of them:

1. `#admit` returns nothing → evidence absent;
2. **the rendering the experiment installed never reaches these capabilities** → evidence
   present, treatment not administered.

The second is not a hypothetical. It is the arm's own shape, and it makes the clause a
loop: it would have used a null result on the untouched capabilities to reject a
hypothesis about the rendering — without the rendering ever having been applied there.

This is `VERDICT-B7-NULL-WITHOUT-ADMINISTRATION.md`'s defect class, arrived at
independently: **a treatment that was configured, logged, and never administered.** That
document's version was a toggle whose only consumer sat inside an off branch. This one is
a prompt contract whose only consumer sits on a route none of the lost questions takes.

#### What is claimed, and what is not

**Claimed.** The falsification clause as written is unreachable by any dispatch of this
arm, because the substitution is gated on a route and the loss is on capabilities that
route does not serve. `b-f+ = 0` at `bcf66463` is therefore **not evidence about the
rendering**, in either direction.

**Not claimed.** That the rendering is or is not useful. It was never applied to the
capabilities whose movement §12.5 predicted, so this run contains no information about
it. The hypothesis remains open and untested, and the next dispatch has to make it
administered before it can be scored.

**Not claimed either.** That §12.5's diagnosis was wrong. Its first clause — "the gate
is a red herring for this arm" — is consistent with everything measured here, and the
gate was already ruled out at `12.3`.

#### What the next dispatch must change

The `promptContract` substitution has to reach the routes whose loss is being explained,
or the registration has to state that its reachable set is ABS. The first is a code
change; the second is a registration change. Choosing between them is the P0 §4.1.21
records, and it is deliberately not decided here: the point of a registration is that
the choice is made before the run.

### 12.8 The registration is revised, before the code that would test it

**This subsection is a registration change and it is written before the code it
authorises.** The order matters and §6.3 is the reason: a registration that is
adjusted after the run can make any result look predicted, and the adjustment itself is
the thing that has to be visible.

#### What §12.4 and §12.5 said, and the contradiction inside the registration

§12.4 diagnosed the arm correctly:

> So the feature side is not declining to answer because evidence is filtered out — **it is
> reaching the model, and the model declines.**

§12.5's falsification clause then assumed the opposite:

> If MR and TR stay at exactly 0% with `b✗f✓ = 0`, then **the evidence never reaches the
> prompt at all** and the loss is upstream of rendering.

Both cannot hold of the same zero. §12.4 says a zero means the model saw evidence and
declined; §12.5 says a zero means the model saw nothing. The registration carried the
correct diagnosis in one subsection and a clause that contradicts it in the next, and the
`limit=120` read at `bcf66463` produced exactly the antecedent both describe — so the
contradiction became load-bearing rather than academic.

§12.7 records the measurement that separates them (the evidence reaches the prompt; the
`#admit` trace §12.5 pointed at is not needed). What follows is the decision §12.7
deferred.

#### The decision

**The `promptContract` substitution is extended to every route whose contract can carry
an evidence rendering.** The alternative — narrowing the registration to declare ABS as
the reachable set — is rejected, and the reason is not preference: the variable exists to
test whether *evidence presentation* moves MR and TR, and ABS gold IS abstention, so a
variable confined to ABS cannot test the hypothesis it was registered for. Narrowing the
registration would make the arm honest and useless.

Three consequences, stated before the code:

1. **The reachable set becomes a property the run reports.** A dispatch that installs a
   rendering must be able to show which routes received it, otherwise the next reader
   re-derives 12.7 from scratch. The arm's artifact will carry the routes the substitution
   applied to, not only the contract's name.
2. **The single-variable property is preserved, and it is harder to keep.** Expanding the
   substitution to more routes must not move any gate parameter. The guard that asserts
   the gates are untouched (`prompt-contract-switch.test.ts`) applies unchanged, and the
   new reach test applies to each added route.
3. **The prediction is restated, and it is weaker than §12.5's.** §12.5 predicted MR and TR
   each move off zero. With the rendering now actually administered to them, the
   prediction is: **at least one of MR/TR moves off zero, or the rendering hypothesis is
   dead.** A rendering that reaches MR/TR and still repairs nothing ends that line of
   work, which is a real and useful outcome and is stated here so it cannot be read as a
   near-miss afterwards.

#### What is explicitly not changed

The gate parameters, the dataset, `limit`, and `ablation_runs`. §4's prohibition on sweeps
stands. §12.3's finding that no `retrievalThreshold` can carry the arm stands. And the
`0.25` already dispatched is still recorded as a defect found rather than repaired by
sliding it — §12.6 explains why the number was there.

#### What would now falsify the hypothesis

MR and TR both stay at exactly 0% with `b-f+ = 0` in a run whose artifact shows the
rendering was administered to them. That is a reachable antecedent, unlike the one §12.5
wrote, and reaching it retires the rendering line rather than deferring it.

### 12.9 What §12.8 assumed, and the four things the code actually shows

§12.8 was written from the failure and before reading the three prompt builders line by
line. Writing it first was the point — a revision that follows the code it authorises is a
description, not a registration. Reading the code afterwards produced four corrections,
and one of them narrows §12.8's own decision rather than extending it.

#### (a) The rendering machinery already exists; only the gate is narrow

`buildPrompt` already branches on the contract name:

```ts
const evidence =
  contract === 'abstention-evidence-blocks'
    ? formatEvidenceWithSources(turns)
    : formatEvidence(turns);
```

So §12.8's phrasing — "the substitution is extended to every route whose contract can
carry an evidence rendering" — describes less work than it implies for the flat paths.
`answer`, `answerAssistant`, `answerKnowledgeUpdate`, `answerPreference` and
`answerAbstention` all funnel through `#prompt`, which is the only site that resolves the
substitution. For those five, the change is the width of one condition. Nothing new has to
be rendered; a renderer that was written, tested and never dispatched becomes dispatched.

#### (b) Two routes do not pass through the substitution at all

`#promptWithDate` (TR) and `#promptSessionAware` (MR) build their prompts by calling
`buildPromptWithDate` and `buildSessionPrompt` directly. Neither takes a `contract`
parameter, and neither consults `options.promptContract`. They are **not** "routes whose
condition is too narrow" — they are routes the substitution cannot express. §12.8 treated
all routes as one kind of thing. They are two kinds:

| kind | routes | why the substitution does not reach | what it takes |
|---|---|---|---|
| condition-narrow | `answer`, `answerAssistant`, `answerKnowledgeUpdate`, `answerPreference`, `answerAbstention` | `#prompt` names `contract === 'abstention'` | widen one condition |
| structurally-absent | `answerTemporal` (TR), `answerSessions` (MR) | their builders have no contract parameter | plumb a contract through the builder |

The second kind is the kind that carries **28 of the 28 lost questions**. The routes that
would be easiest to widen are the ones whose loss is zero or near it; the two that hold the
entire measured loss require a signature change in `prompt.ts`.

#### (c) MR has no rendering for its own contract to select

There is nothing for a widened condition to do on the MR route as it stands. Its builder
emits `CONTRACT_INSTRUCTIONS.extractive(undefined)` unconditionally, and it already renders
session boundaries through `{ sessionIndex }` — the very boundary 12.5's docstring says the
abstention route never got. So "extend the substitution to MR" cannot mean "let MR's
contract pick a rendering", because MR pins its own.

What MR *is* missing is the `formatEvidenceWithSources` treatment: it renders boundaries
without source identity. `formatEvidence(turns, { sessionIndex })` is called with
`session.turns` — and `AdmittedTurn` carries `id`, so the identity is available and unused.
The MR extension is therefore a **rendering choice inside `buildSessionPrompt`**, selected
by a new parameter, not a contract substitution arriving from `#prompt`.

This is a real narrowing of §12.8. §12.8 said "the substitution is extended"; for MR the
accurate statement is "the rendering is extended, and the substitution is what selects it".

#### (d) MR and TR cannot share one contract name

`abstention-evidence-blocks` is also its instruction block — the four-line conservative ask
with the abstention token. Its own docstring explains why the ask must not change: §12.4
could not separate "the ask is too forceful" from "the evidence is unusable", so the
candidate holds the ask FIXED and moves only the evidence.

That property dies if the same name is handed to MR, whose ask is `extractive` and whose
prompt must keep the `SESSION_NOTE`. Naming `abstention-evidence-blocks` on the MR route
would move the instruction text *and* the evidence rendering — two variables, in a run
whose entire value is that it has one. §12.8's consequence 2 said the single-variable
property "is harder to keep" and would be guarded by the reach test. The code shows it
cannot be kept by that route at all: the name is not separable from its ask.

#### What this changes in §12.8's decision

§12.8 held. The predicate stays "not a sweep, one variable", and the direction stays
"administer the rendering to the routes that carry the loss". Two details change:

1. **The reachable set is declared per route, and the naming is per route.** A rendering
   cannot be addressed by an abstention-named contract on a route whose ask is extractive.
   The variable is therefore *"the evidence rendering, selected by the run, applied to the
   routes whose contract can carry it"* — and for MR/TR the contract name that selects it
   is new, with its own instruction block held byte-identical to what the route emits
   today.
2. **The reachable set is reported as rendered-or-not per route, measured from the
   prompt.** §12.8's consequence 1 said the artifact reports "the routes the substitution
   applied to". That is a claim about the dispatcher. The stronger and cheaper property —
   and the one this round can actually assert — is that each route's prompt is inspected
   for the rendering, which is what `prompt-contract-reach.test.ts` already does and what
   the arm can log without trusting its own dispatch table.


### 12.10 The prediction was tested and it failed; the rendering line is retired

§12.9 wrote its falsifier before the code existed, and it was reachable this time:
*"MR and TR both stay at exactly 0% with `b-f+ = 0` in a run whose artifact shows the
rendering was administered to them."* Dispatch `37827496757` (`6000f5ab`, `limit=120`,
`ablation_runs=1`, `cortex_memory_prompt_contract=abstention-evidence-blocks`) produced
exactly that antecedent. The line is retired here rather than deferred.

#### The artifact first, because the reach is what makes the zero legible

```json
"memoryArmConfig": {
  "threshold": 0, "retrievalThreshold": 0, "sessionBudget": null,
  "sourceTrust": 0.5, "confidenceSignal": "none",
  "promptContract": "abstention-evidence-blocks",
  "renderingRoutes": ["abstention", "multi-session", "temporal",
                      "knowledge-update", "assistant", "flat"]
}
```

Six of six. This is the field §12.8 asked for and it did its job on its first run: the
previous artifact could not have said this, which is why the previous zero was
uninterpretable.

#### The numbers

| capability | baseline | feature | b+f− | b−f+ |
|---|---|---|---|---|
| MR | 14/17 | **0/17** | 14 | 0 |
| TR | 15/17 | **0/17** | 15 | 0 |
| IE | 0/52 | 0/52 | 0 | 0 |
| KU | 0/17 | 0/17 | 0 | 0 |
| ABS | 17/17 | 17/17 | 0 | 0 |
| **total** | **46/120** | **17/120** | **29** | **0** |

`delta = -0.2417`, `feature.abstentionRate = 0.9583` against the baseline's `0.6333`,
`abstentionReasons = {empty: 0, threshold: 0, llm: 17, answered: 0}`.

#### The confound that is not present

A zero on MR/TR is only about rendering if the evidence reached them. It did, and both
halves are measured rather than assumed:

- `retrievalThreshold = 0`, so `decideRetrieval` cannot close the gate — the
  `threshold` counter is `0`.
- `#lastRawOutput` is written only after `#llm.complete` returns, and all 17 MR and all
  17 TR records carry a non-null `rawOutput`. The model was consulted 17/17 on each.

So the treatment was configured, logged, administered, and reached the model. The zero
is a model behaviour, not a plumbing failure.

#### The output distribution, which is where the real finding is

| capability | bare token | engaged (prose) |
|---|---|---|
| MR | 16 | 1 (`"2"`) |
| TR | 17 | 0 |
| IE | 52 | 0 |
| KU | 13 | 4 (`"No."`, `"Thursday"`, `"200"`, a prose summary) |
| ABS | 17 | 0 |

116 of 120 outputs are a bare `INSUFFICIENT_EVIDENCE`, and every one of them is `null`
after the parse — the §60.2 finding reproduced. The four that engaged answered
**substantively and wrongly** (or unscored): one gave a bare `"2"`, three gave short
answers. The model is not struggling to *read* the evidence; it is declining to try,
and when it does try it is not finding the answer.

#### What this retires, stated precisely

It retires the **evidence-presentation** hypothesis: labelling each turn's origin, on
all six routes, does not move MR or TR off zero. Rendering the boundary more legibly
was the last remaining candidate after §12.4 (gate) and §12.3 (threshold) were excluded,
and it is now excluded by measurement.

It does **not** retire the abstention contract, and the distinction matters. Within this
ablation the feature abstains at 95.8% against the baseline's 63.3% — the feature is
*far more* willing to decline than the pipeline it is measured against, on the same
evidence, with the gate open. (These are the two figures inside
`benchmark-cortex-memory-ablation-report.json`'s `ablation` block. The main
`benchmark-report.json` shows the reference pipeline at `abstentionRate 0` because that
arm answers without the abstention contract at all — a different arm, not a
contradiction, and naming which file each number comes from is the difference between a
readable claim and an unreadable one.) That gap is the `abstention` vs `extractive`
**ask**, and no rendering change addresses it. §12.9(d) already recorded that the ask is
not separable from the contract name; the run shows that this separateness is exactly
what is needed next.

#### What this opens

The next variable is the **ask**, not the rendering — and it is a different experiment
with a different single variable. It is not started here. Recording the constraint
before any code: an ask change on MR/TR cannot be gated by
`RENDERING_BY_CONTRACT` (that maps to a rendering), so it needs its own knob and its own
reach report, for the same reason this round needed one.

The baseline is the existence proof that an ask which does not over-decline scores
14/17 and 15/17 on these two capabilities with the same admission and the same dataset.
So the capability is reachable; what is not reachable is the feature's current
willingness to answer.

---

## 13. The ask experiment: does REMOVING the invitation to decline repair MR and TR?

§12.10 retires the rendering and leaves one excluded candidate: the instruction block.
This section registers the experiment that tests it, written before the code, with its
prediction and its falsifier stated in advance.

### 13.1 The measurement the hypothesis rests on

Within `37827496757`'s ablation block, on the same dataset, the same admission
(`threshold = 0`, `retrievalThreshold = 0`, `sessionBudget = null`), and the same
evidence:

| arm | abstentionRate | accuracy |
|---|---|---|
| feature (`cortex-memory`, abstention ask) | **95.8%** | 14.2% |
| baseline (reference pipeline) | **63.3%** | 38.3% |

The baseline abstains 32.5 points less and scores 24.1 points higher. It has no
mechanism this arm lacks -- §12.4 established the gate is not what is declining. What
it does not have is the four-line instruction block that tells the model, twice, that
this question may have no answer, that declining is expected and valid, and that
choosing among candidates is wrong.

That is the variable. It is the one §12.5's docstring explicitly set aside, on the
grounds that "suspecting it is suspecting the thing most likely to be correct". The run
shows the grounds were wrong.

### 13.2 The single variable, stated exactly

The candidate ask is the `extractive` instruction block applied to every route — the
two lines the reference pipeline's contract uses:

```
Answer the question using only the evidence above.
Reply with the answer alone. If the evidence does not contain the answer, reply exactly
INSUFFICIENT_EVIDENCE.
```

Two things are held fixed on purpose, and each is a separate rejection:

1. **The evidence rendering does not move.** It stays whatever the run names, defaulting
   to `numbered`. The previous round showed rendering does not carry the effect, so
   pairing the two would confound a known-null variable with an untested one.
2. **The gate does not move.** `threshold`, `retrievalThreshold`, `sessionBudget`,
   `sourceTrust` and `confidenceSignal` keep the values §12.3 and §12.4 reached. §4's
   prohibition on sweeps stands.

### 13.3 Why this needs its own knob, and why it is not `promptContract`

`RENDERING_BY_CONTRACT` maps a contract name to a **rendering**. An ask is not a
rendering, so reusing the table would break its meaning — the same error §12.9(a)–(d)
records, reached from the other side. The ask needs its own input, and it needs its own
reach report for the same reason the rendering did: an artifact that names an ask it
never administered is unreadable, and `37827496757` is the proof that the field pays for
itself on its first use.

### 13.4 The prediction

**MR and TR together recover at least half the gap to the baseline.** Concretely, on a
`limit=120`, `ablation_runs=1` run: `MR >= 7/17` and `TR >= 8/17`, with `b-f+ > 0` on at
least one of them.

The threshold is half the baseline rather than the baseline itself because the ask is
the largest remaining candidate but not the only difference between the arms, and
predicting parity would make a partial repair read as a failure. Half is a real
repair — it is the difference between "the abstention contract is the problem" and "the
abstention contract is one problem among several", and those are different next steps.

### 13.5 The falsifier, which is reachable

**MR and TR both stay below 4/17 with `b-f+ = 0`** in a run whose artifact shows the
extractive ask was administered to them. Then the ask is not the cause either, and the
remaining candidates are the ones this project has not yet separated — retrieval
quality on these two capabilities, and the scorer's treatment of a short answer.

Reachability is asserted rather than hoped: the reach report is a field, the artifact is
downloaded before the verdict is written, and the previous round is the worked example of
a falsifier that could actually fire.

### 13.6 What would still not be known afterwards

Whether the reference pipeline's advantage is its ask or its retrieval. The baseline
differs from this arm in the instruction block AND in how it produces candidates, so a
recovery under this experiment identifies the ask as *sufficient to move the number*,
not as *the whole difference*. Stating this here prevents the result, if positive, from
being over-read.

### 13.7 Status

**Registered. Not yet implemented.** The knob, the reach field and the tests are the
next round's work; this section exists so that work has a falsifiable target rather than
a direction.

### 13.8 Verdict: the falsifier fired

**The prediction is dead.** `37871576339` (commit `58865a1`, `limit=120`,
`ablation_runs=1`, `cortex_memory_ask=extractive`) completed success, and the artifact
establishes every premise the falsifier required — and then meets it.

#### The premise: the ask WAS administered

This is the half that had to be checked before the number could be read, because §13's
own trap is that MR's ask is already `extractive` and a run could therefore report a
treatment it never applied. The artifact from `58865a1` carries the reach, and the
second axis is what makes it legible:

```
- Memory arm config: `threshold=0`, `retrievalThreshold=0`, `sessionBudget=unbounded`,
  `sourceTrust=0.5`, `confidenceSignal=none`, `promptContract=abstention`
- Evidence rendering reached: `none` (the baseline prompt is unchanged)
- Evidence ask: `extractive`
- Evidence ask reached: 4 route(s) — `abstention`, `temporal`, `knowledge-update`, `assistant`
```

Two things are proved by these four lines, and the second is new:

1. **The ask reached TR.** `temporal` is in the reach list, and TR is the capability the
   ask was predicted to repair. The rendering line reads `none` while the ask line reads
   four routes — so `renderingRoutes: []` and `askRoutes: [4 routes]` coexist in one
   artifact, which is the independence §13.2 required, demonstrated rather than asserted.
2. **The ask did not reach MR** — `multi-session` is correctly absent from the list, for
   the reason §13.5 recorded before the code existed: MR's own ask IS `extractive`, so the
   option is a byte-identical no-op there. The artifact says so rather than implying a
   treatment. A run without `askRoutes` would have published `ask: extractive` and let a
   reader assume MR was treated.

#### The reading

| Capability | n | baseline | feature (ask=extractive) | `b-f+` | `b+f-` |
| --- | --- | --- | --- | --- | --- |
| MR | 17 | 13 | **0** | 0 | 13 |
| TR | 17 | 16 | **0** | 0 | 16 |
| IE | 52 | 0 | 0 | 0 | 0 |
| KU | 17 | 0 | 0 | 0 | 0 |
| ABS | 17 | 17 | **17** | 0 | 0 |
| **total** | 120 | 46 | **17** | **0** | 29 |

`delta = -0.2417`; `pValue = null`; `significant = false`. Abstention rate 63.33% →
**94.17%**. **`b-f+ = 0` on every capability and MR/TR are both 0/17, which is below the
registered 4/17.** The falsifier fired.

#### What the mechanism was, since the falsifier alone does not say

The output census is the part worth keeping. Of 120 feature outputs:

| Shape | Count |
| --- | --- |
| bare `INSUFFICIENT_EVIDENCE` | **113** |
| engaged (produced text that was not the token) | 7 |
| empty | 0 |

and the abstention census reads `{"empty": 0, "threshold": 0, "llm": 17, "answered": 0}`.

Two sources of abstention, and separating them matters:

- **`threshold: 0`** — the retrieval gate never abstained. `retrievalThreshold: 0` is the
  identity configuration, so the gate admitted everything. No evidence was withheld
  upstream of the model.
- **`llm: 17`** — the model's own abstentions, as counted by the arm's census.

So the 113 bare-token outputs are not a plumbing failure — the evidence was admitted,
the model was consulted, and it emitted the abstention token anyway. **Removing the
sentence that calls declining "expected and is a valid outcome" did not stop the model
from declining.** The invitation was not what was holding MR and TR down.

ABS is the control and it holds: 17/17 both sides, `b-f+ = 0` on ABS too. A run that
had broken the abstention capability would show it here, and this one does not. The ask
change is therefore not a global regression that merely happened to spare ABS — it is
specifically inert on the two capabilities it was aimed at.

#### The candidate space, restated honestly

§13.6 registered that a positive result would identify the ask as *sufficient to move
the number*, not as *the whole difference*. The negative result has the mirror
obligation: it retires the ask as the cause of the MR/TR gap but does not, by itself,
promote any other candidate to the top. §13.5 named the two that remain — **retrieval
quality on these two capabilities, and the scorer's treatment of a short answer** — and
those are now the live hypotheses rather than asides.

One further observation belongs here because it constrains what "retrieval quality"
can mean. The arm reports `turns: []` for all 120 questions, which is deliberate: this
arm collects no retrieval trace, so it carries no turns rather than guessing (the
rationale is on `buildArmRoster`). That means **the artifact cannot currently distinguish
"retrieval returned the wrong evidence" from "retrieval returned nothing"** — and those
are different next steps. Resolving that is a prerequisite for testing the retrieval
candidate, not part of it.

### 13.9 Status

**Falsified.** The endpoint was registered in §13.4/§13.5 before the knob existed, the
knob was built to make the falsifier reachable only by measurement (§13.5's note; an
unrecognised ask is rejected rather than defaulted), and the run met it.

## 13.11 The evidence experiment: was the reader shown the wrong turn, or nothing?

§13.9 retires the ask and §13.8 names what remains. The paragraph at the end of §13.8
is the reason this section exists rather than being a footnote to the next plan: the
artifact could not distinguish the two surviving readings, because `turns: []` was a
**constant** on every record rather than a measurement. A hypothesis that cannot be
falsified by the artifact being read is not registered, it is asserted. This section
registers the run that makes it falsifiable.

### 13.11.1 The defect the previous runs could not see past

`buildArmRoster` passed `retrieved: ''` unconditionally. The arm collects no retrieval
trace, so the honest refusal to guess was the right *value* and the wrong *state*: with
the field hardcoded, "the reader was shown the wrong turn" and "the reader was shown
nothing" collapse into one absence on all 120 records, and the §13 dispatch could not
tell them apart even in principle.

This is the §12.8 defect one layer down. There, a run recorded the *name* of a
rendering while the rendering reached 17 of 120 questions, so a reader would have
attributed a 45→17 drop to a treatment four capabilities never received. Here, the
artifact recorded an *absence* that was the same bytes whether the arm retrieved badly
or retrieved nothing — and unlike §12.8's name, an empty list reads as a finding
("retrieval found nothing on MR") rather than as a gap.

### 13.11.2 The single variable, stated exactly

**The arm now captures, per question, the evidence its feature-side reader was shown.**
One entry per question: the admitted turns joined by newlines, or `null` when the
machine declined before a reader was shown anything.

* `null` and `''` are different statements and the code keeps them apart. `null` is "no
  reader was shown anything", which is what a machine decline produces. `''` would
  claim a context was shown and happened to be blank.
* The value is the **turns** and not the prompt. A prompt also carries the instruction
  block and the question, so a reader trying to separate the two hypotheses would have
  to parse the other two back out. The turns are the claim.
* Capture is an **observer**, not a participant: the answers are bit-identical with and
  without the sink, which `benchmark-retrieval-capture.test.ts` pins by running both.

The four transfers that could each drop the value independently are wired and each is
asserted at its own layer: `CortexMemory.#recordEvidence` →
`runBenchmark`'s `onRetrieved` → `ScoredEvaluation.retrievedContexts` →
`AblationResult.featureRetrievedContexts` → `QuestionRecord.turns`.

The last transfer is the one with a trap in it, and it is the same trap the raw-output
transfer has: the roster is built **after** the ablation finishes, so an implementation
that read the single-slot accessor at that point would give every record the *final*
question's evidence. `arm-roster-retrieval.test.ts` asserts per-record, with distinct
fixture values, so that shortcut cannot pass.

### 13.11.3 The prediction

On the §13.11 dispatch (same configuration as §13.8's run, plus the capture):

1. **MR and TR records carry non-empty `turns`.** The loss is 29 questions the baseline
   answered correctly; if retrieval returned nothing for them, `turns` is `[]` and the
   retrieval-quality hypothesis is refuted before any ranking work is done.
2. **The abstained records are not uniformly empty.** `retrievalThreshold: 0` means the
   gate never closed, so a record with `turns: []` was admitted nothing by the write
   gate and a record with `turns: [...]` reached the model and was declined. §13.8's
   mechanism claim ("the model saw evidence and declined") predicts the second shape
   dominates. If the first dominates instead, §13.8's mechanism reading is wrong and
   the loss is upstream of the model.

### 13.11.4 The falsifier, which is reachable

**If MR and TR records carry `turns: []` at the same rate as the whole set**, then
retrieval returned nothing for the lost questions and the surviving hypothesis in §13.8
is refuted. The pre-committed recovery is **not** another prompt or ask knob: it is a
look at `admission.ts`, because producing no evidence for a question whose context
demonstrably contains the answer is a write-gate defect, and the previous two rounds
have now moved every presentation variable without touching admission once.

### 13.11.5 What would still not be known afterwards

A non-empty `turns` on a lost question identifies the evidence as *present*, not as
*correct*. Whether the right turn was in it is a question about ranking, and it needs a
gold-turn attribution the dataset does not carry on this arm. §13.11 can therefore move
the candidate from "retrieval quality" to "ranking within a correct-length context" and
cannot, by itself, pick the ranker.

### 13.11.6 Status

**Registered.** The capture is implemented and asserted at every transfer; the dispatch
is armed with `ask: extractive` held from §13.8 and `promptContract:
abstention-evidence-blocks` held from §12.5, so the evidence vector is the only thing
that differs from the run whose artifact §13.8 read.

### 13.11.7 The dispatch failed on infrastructure, and the failure destroyed the measurement

Run `37942775447` (`b4d19c54`) is a **failure** and it is not a result. The job reached
`Run cortex-memory A/B` and died there:

```
progress: died on reference-pipeline run=2 q=157/500 id=a89d7624

TypeError: terminated
    at Fetch.onAborted (node:internal/deps/undici/undici:11472:53)
```

**§4.2 already covers this and the recovery is the one it names.** That rule anticipates
exactly this case — "if the first dispatch fails for an infrastructure reason (quota,
network, artifact loss), it is re-dispatched with the reason recorded. A failure is not a
result." So the re-dispatch is pre-committed rather than chosen after the fact, and no
endpoint moved.

Two things about the failure are worth separating, because they have different repairs.

**First, the transport retry was correctly configured and still lost.** The LLM adapter
defaults to `maxRetries: 5`, `baseDelayMs: 1000`, `timeoutMs: 60000` and a
`retryBudgetMs` of 120 s, and `isRetryableStatus` retries `429` and `>= 500`; a thrown
transport error is also caught and retried. But the budget is a **wall-clock ceiling on
the retry sequence**, checked *before* each sleep: once 120 s of backoff has been spent,
the next retry is not made and the loop re-throws. Two minutes is deliberately larger than
a throttle window measured in seconds — and still smaller than a connection that hangs for
the full per-attempt deadline twice. The configuration is not obviously wrong; the budget
is simply not the guarantee it reads as, because "retried five times with backoff" and
"attempted for as long as two minutes" are different promises and only the weaker one is
kept.

**Second, and this is the defect this section adds: the failure destroyed everything the
run had measured.** `bench/run-ablation.ts` writes
`benchmark-cortex-memory-ablation-report.md` and `.json` **only after
`runCortexMemoryArm` returns**, and the arm returns only on success. The failure path
writes `benchmark-error.log` and persists the embedding cache — it saves the *vectors*,
which are the cheapest thing the run paid for, and discards the *answers*, which are the
only thing it was measuring. The artifact listing for the run says this without ambiguity:

| Written | File | What it holds |
| --- | --- | --- |
| ✅ | `cortex-memory/benchmark-error.log` | the progress line and the stack |
| ❌ | `cortex-memory/benchmark-cortex-memory-ablation-report.json` | **absent** |
| ❌ | `cortex-memory/benchmark-cortex-memory-ablation-report.md` | **absent** |

So the run spent ~40 minutes grading questions across six routes and two sides and left no
record of a single answer. This is the §52.6 defect in a new place: there, a value reached
the JSON and not the Markdown; here, a value reaches **neither**, and the failure is silent
about it in exactly the way §12.8's unknown reach was silent. Worse, the answer cache is a
plain in-process `Map` (`bench/run-ablation.ts`, constructed beside `structuredCache`), so
it dies with the process. The embedding cache is persisted and the answer cache is not —
which is the wrong way round: a re-embed is a repeat of a deterministic, already-paid
computation, while a re-answer is a repeat of the measurement itself.

**What this changes before the re-dispatch.** The re-dispatch is cheap only because the
embedding cache survived (`Restore embedding cache` succeeded and the save step ran under
`always()`), so the ~115k vectors are not re-billed. The answers are. That cost is paid
again on the retry, and it would be paid a third time if the retry failed the same way —
so the durability of the measurement is repaired **before** re-dispatching rather than
after a second loss.

### 13.11.8 Status

**Registered, dispatched once, failed on infrastructure.** Per §4.2 the run is
re-dispatched with the reason recorded here; the endpoint, the effect size and the
stopping rule are unchanged. The measurement's durability is repaired first, so a second
infrastructure failure cannot cost another 40 minutes of grading for no record.

### 13.11.9 The artifact contract this registration now carries

§13.11.7 recorded that run `37942775447` died and left no measurement. §6.3.1 of
`AUDIT-CODE-VS-DOCS.md` turns that into a rule for every arm from here: a registered arm
declares what a **failure** leaves behind, not only what a success does. For this arm the
three sets are:

| Set | File | Written when |
| --- | --- | --- |
| Complete | `benchmark-cortex-memory-ablation-report.{md,json}` | `runCortexMemoryArm` returns |
| Diagnostic | `benchmark-error.log` | any throw |
| Partial | `benchmark-cortex-memory-partial.json` | any throw, if either side measured anything |

**What the partial set deliberately does not carry** — `delta`, any aggregate, any
per-capability table. Each is a function of both sides over one index vector; with a side
short they are arithmetic over data that was never paired, and `0/0` renders exactly like
`0/121` (§12.7). The set carries `system`, `reached`, `total`, `run` and the two answer
vectors, which is what decides whether the next move is a re-dispatch or a design change.

**Reading rule for this registration's outcome.** When this run's artifact is read, check
for `benchmark-cortex-memory-partial.json` **before** reading the complete set, and treat
its presence as "the arm did not finish" rather than as a smaller result. `reached`/`total`
says how far it got, and §4.2's pre-commitment to re-dispatch an infrastructure failure
applies — but the two predictions in §13.11.3 are **not** read off a partial set, because
they are statements about MR/TR versus the full population, and a truncated population
cannot falsify them.

### 13.11.10 Run `38003036421` failed at serialization, not at measurement

The re-dispatch ran at `16520439` and **failed in step `Run cortex-memory A/B`**. It is a
different failure from §13.11.7 and it is more informative.

```
progress: died on cortex-memory run=3 q=500/500 id=778164c6

RangeError: Invalid string length
    at JSON.stringify (<anonymous>)
    at main (.../packages/cortex-memory/bench/run-ablation.ts:273:13)
```

**The measurement completed.** All four runs of all five hundred questions finished; the
throw is on the last line of the happy path, writing the JSON, *after* the Markdown had
already been written (5636 bytes on disk).

#### What the artifact holds

| File | Present |
| --- | --- |
| `benchmark-cortex-memory-ablation-report.md` | yes, 5636 bytes |
| `benchmark-cortex-memory-ablation-report.json` | **no** -- the throw |
| `benchmark-cortex-memory-partial.json` | **no** -- and correctly so, see below |
| `benchmark-error.log` | yes, 312 bytes |

**`attachPartial` did not fire, and that is not a bug in it.** It attaches to a thrown
*error object* from `runAblation`; here the ablation **returned**. The throw is downstream,
in the arm's own writer, so there was no error to attach to. That is exactly why §13.11.9
does not claim the partial set covers every failure: it covers a failure *of the ablation*.

#### The mechanism: `JSON.stringify` has a hard ceiling

`Invalid string length` is thrown when the **result** would exceed V8's maximum string
length, `2**29 - 24` = 536,870,888 characters. Measured on this runtime:

```
400000 chunks -> ok      401.2 MB
530000 chunks -> ok      531.6 MB
536000 chunks -> THREW
```

#### Why this report crosses it, and why the primary benchmark does not

The primary benchmark's roster in the same artifact is **bounded**, and measurably so:

| | Primary benchmark roster |
| --- | --- |
| turns per question | median 53, max 262 |
| chars per question | median 11,771, max 28,194 |
| 500-record roster total | 6.98 MB, of which `turns` is 98% |

**The memory arm has no such bound.** Two independent reasons:

1. `admission.ts` declines to truncate, and says so in its own docstring -- *"Content is passed
   through untruncated: prompt budget is a property of prompt assembly"*.
2. This run set `sessionBudget = unbounded`, which the report header records. `selectSessionBudget`
   is the only capacity control on the session path, and `#retrievalAdmitted` is a **boolean**
   gate that decides *whether* to answer and never trims `turns`. With `threshold: 0` every
   turn clears the write gate, and with `retrievalThreshold: 0` the retrieval gate never closes.

The report carries the evidence **twice** -- once in `ablation.featureRetrievedContexts`, once
as `questions[].turns[].text`. At the measured 182.4 bytes per turn, that puts the per-question
budget at **536,871 chars, or ~2943 turns** -- about **19x** the primary benchmark's worst case.

#### The one thing this run does establish

The predictions of §13.11.3 concern MR/TR records against the full population, and both need
only **whether evidence existed and how much**. Neither needs the full text of every turn. So
the evidence can be carried in full for a bounded cohort and by size for the rest without
weakening either prediction -- which is the repair, registered as §13.12.

#### Registering the bound rather than discovering it

Consistent with §6.3, the bound is a **pre-registered decision**, not an emergent property of
what the harness happened to do. §13.12 is written before the next dispatch, and
`test_preregistration_config.py` is extended to compare the dispatch against it.

---

## 13.12 Evidence is carried as a bounded measurement, registered before dispatch

### 13.12.1 The single variable

§13.11 established that the evidence each reader was shown is a measurement. §13.11.10 then
established that carrying it **unbounded** makes the artifact unwritable, and that a complete
measurement with no artifact is indistinguishable from no measurement.

§13.12 changes **one thing**: the evidence is carried **in full for a declared cohort** and
**by size elsewhere**, with the reduction stated in the artifact. Everything else -- the
rendering (`abstention-evidence-blocks`), the ask (`extractive`), the gates
(`threshold: 0`, `retrievalThreshold: 0`, `sourceTrust: 0.5`) -- is held from §13.11.

### 13.12.2 The cohort, and why it is the right set to carry in full

The cohort is the **discordant identity set**: questions the baseline answered correctly and
the feature answered incorrectly, plus the reverse. It is declared by the artifact itself
(`discordantQuestions`), so the cohort is a fact about the run rather than a parameter.

That set is the right one for three reasons:

1. **It is where every mechanism question lives.** §12.4/§13's loss is entirely inside
   `b-f+`; a question both sides answered the same way cannot distinguish anything.
2. **It is bounded and small.** The §13 dispatch's `b-f+` was 190 ids; a cohort of that size
   at 28 KB per question is ~5 MB, two orders of magnitude under the ceiling.
3. **It is not chosen by looking at the outcome.** The cohort is a function of the correctness
   vectors, which are the primary result and are read either way. Selecting on them does not
   bias the evidence measurement, because the measurement being taken is *"what did this
   question's reader see"* -- a question about a record that is already in the set.

### 13.12.3 What every record carries regardless of cohort

| Field | Meaning |
| --- | --- |
| `turns` | in full for cohort members; for others, the first `k` turns plus a reduction marker |
| `evidenceTurns` | how many turns the reader was shown -- **always**, never reduced |
| `evidenceChars` | the size of the evidence -- **always**, never reduced |

`evidenceTurns` and `evidenceChars` are the measurement that survives any bound. Prediction 1
of §13.11.3 ("MR/TR records carry non-empty `turns`") is decided by `evidenceTurns > 0` and
is unaffected by truncation. Prediction 2 (abstention records are not uniformly empty) is
decided by comparing `evidenceTurns` against the population -- also unaffected.

### 13.12.4 The reduction must never read as absence

A truncated record and a record whose reader was shown nothing must not render the same. The
marker distinguishes three states, matching the `null`/`''` discipline the rest of the
artifact uses:

| State | `turns` | `evidenceTurns` |
| --- | --- | --- |
| reader shown nothing | `[]` | `0` |
| shown and carried in full | complete | `turns.length` |
| shown and reduced | prefix + marker | the true count |

A test fails if any two of the last three columns ever render identically. This is the
`§57.6` / `§13.11.2` shape again: an absence that reads as a value is worse than an error.

### 13.12.5 Prediction

**The reducible set is non-empty.** If every question's evidence were already small enough to
carry, this change would be a no-op and the bound would be decorative. Measured expectation:
the memory arm admits far more than 2943 turns on at least one question, since the
primary benchmark's bounded roster already reaches 262.

### 13.12.6 Falsification

If the artifact reports `evidenceTurns` equal to `turns.length` on **every** record, the bound
never engaged and §13.12.5 is falsified -- which would itself be a finding, because it would
mean §13.11.10's mechanism is not the one that crossed the ceiling. In that case the search
returns to what else in the report is unbounded, and the answer is recorded before another
dispatch.

### 13.12.7 The artifact contract this adds

§6.3.1 requires a registered arm to declare what a **failure** leaves behind. §13.11.10 showed
that a throw *after a complete measurement* is a case the partial set does not cover. §13.12
adds the fourth clause:

> **An artifact declares its own size bound, and a reduction is a recorded fact.**

Concretely: the JSON writer must not be able to destroy a measurement. If serialization would
exceed the runtime's limit, the arm writes a reduced report **plus a manifest naming exactly
what was reduced and by how much**. A run never ends with a complete measurement and no
artifact.

### 13.12.8 Status

Registered before the next dispatch. Predictions in §13.12.5, falsification in §13.12.6.

## 13.13 What the reader was shown is not what the artifact records

Registered because run `38044858147` was read against the §13.11.3 predictions and
the reading was wrong in the direction that matters: it overstated what reached the
model, and it turned a correct verdict into a hedged one.

### 13.13.1 The defect

`memory.ts` captures the evidence and then builds the prompt from the same list:

```ts
const prompt = buildPrompt(question, turns, contract, this.#promptOptions());
this.#recordEvidence(turns);          // memory.ts:535-536
```

`#recordEvidence` stores `turns.map((t) => t.content).join('\n')`, which is what
`lastRetrievedContext` returns and therefore what
`ablation.featureRetrievedContexts` and `QuestionRecord.retrieved` are built from.

`buildPrompt` does not necessarily carry those turns. When the assembled prompt
exceeds `maxChars` it calls `fitToBudget`, which spends the budget in priority
order -- instructions, then question, then **evidence truncated to whatever is
left**. The arm never sets `maxPromptChars`, so `maxChars` is
`DEFAULT_MAX_PROMPT_CHARS` = **24,000** on every question, and the run's evidence
averaged **506,338 characters** per question. Every question in the run was over
budget.

So the artifact's `evidenceTurns` (3,016-4,528) counts turns that were *offered*
to `buildPrompt`, while the model received at most 24,000 characters -- on the
run's own ratio of 144 characters per turn, roughly 150-160 turns. The
overstatement is about twenty times.

`#recordEvidence`'s own docstring says the accessor answers *"which turns reached
the reader"* and that a reader comparing it against the roster *"wants the same
turns the prompt carried, in the same order"*. Both sentences are false whenever
the prompt is over budget, and `QuestionRecord.evidenceTurns` was documented as
*"how many turns the reader was shown"*, inheriting the error. Those docstrings
are corrected as of this section; the measurement is not, which is what §13.13
registers.

### 13.13.2 Why this is not a documentation problem

`§13.11.5` hands the next round a single question: **was the gold turn inside what
the model saw?** That question is unanswerable from an artifact whose evidence
record stops at the truncation boundary -- the boundary is precisely where the
interesting turns stop. And it is not a small correction to the ranking problem:
the budget is 24,000 characters, not "all of it", so a ranker that leaves the gold
turn at position 200 loses the question no matter how complete retrieval was.

### 13.13.3 The two predictions this registers, so the repair is falsifiable

On the next arm run with the measurement in place:

1. **The prompt-carried evidence is strictly smaller than the admitted evidence on
   every question of this dataset**, since every question exceeds the budget. If
   the two are equal, the budget is not being reached and the defect is not the
   one this section describes.
2. **The prompt-carried size is bounded by `maxChars` minus the instruction and
   question blocks, and is the same bound on every route.** A per-route difference
   would mean the budget is being spent differently per contract, which would make
   prompt-carried size a function of the route rather than of the budget.

### 13.13.4 What would still not be known afterwards

Whether the gold turn is in the carried prefix. That needs gold-turn attribution,
which the dataset does not carry on this arm -- the same limit `§13.11.5` states.
Measuring the carried size is what makes that question askable; it does not answer
it.

### 13.13.5 What was built, and the decision it settled

**Implemented.** The open question was the measurement's shape, and it is settled by
carrying both quantities rather than by choosing between them:

| Quantity | Field | Answers |
| --- | --- | --- |
| admitted context | `evidenceTurns` / `evidenceChars` | `§13.11.3`'s two predictions: did retrieval *produce* evidence |
| prompt-carried evidence | `promptChars` | `§13.11.5`'s ranking question: did the evidence *reach the model* |

They are different questions about one run, so one field cannot answer both -- and
the repair is additive, which is why `§13.11.3`'s reading is unaffected.

The value is produced where it is known rather than re-derived by a caller:
`buildPrompt` and `buildSessionPrompt` return `AssembledPrompt`, carrying the
evidence characters the prompt actually holds after `fitToBudget` has run. A caller
that recomputed it from the prompt text would be re-deriving a value the builder
already has, which is the shape `report-write.ts` rejects by name.

It is captured under the **existing** `captureRetrievedContext` flag rather than a
new one, because the two are never wanted apart: a context vector without the
carried size overstates what the model saw and cannot be corrected after the fact.
One flag, one capture, two vectors.

`null` in the vector means the system exposes no such accessor, and it reaches the
record as **absent** rather than as zero. A system that cannot report this has not
reported a prompt that carried nothing.

The decision belongs in `cortex-eval`, not in `bench/**`, for the reason
`report-write.ts` records: a decision in an entry point is a decision no test can
reach. The record field and its forwarding through `withEvidenceBound` are both
asserted at the arm level, on the artifact, because every hop from the builder to
the record is a place the value can be dropped silently -- and a dropped field
renders exactly like a system that cannot report it.

### 13.13.6 How the repair is read

Both predictions in §13.13.3 are decided by `promptChars` against `evidenceChars`
in the same artifact: prediction 1 by the first being strictly smaller on every
question of this dataset, prediction 2 by being bounded by the budget rather than
by the route.

A run whose artifact reports the two as equal on most questions says the budget is
not binding, which would make this section's premise wrong for that configuration
rather than the repair wrong.

### 13.13.7 Read off run `38114272884` — both predictions hold

Run `38114272884` (`5241be13`, the commit carrying the measurement) completed
success. Its artifact is **3,897,380 bytes**, against **258,473,032** for
`38044858147` -- the second bound (§69's, now reaching both copies) turning a
258 MB artifact into a 3.9 MB one, a factor of 66. No partial file, so the arm
returned normally.

**The ablation reading replicated.** Against `38044858147`: baseline 44.30% vs
44.65%, feature 6.35% vs 6.20%, Δ -37.95pp vs -38.45pp, discordant 189 vs 193,
`empty` 0 and `threshold` 0 in both, and **0 questions the feature answers
correctly that the baseline does not** in both. Two runs on different commits under
the same registered configuration agree, so the next round can build on the
reading rather than on a draw.

**Prediction 1: confirmed.** `promptChars < evidenceChars` on **500 of 500**
questions. The prompt-carried evidence is strictly smaller than the admitted
evidence on every question of this dataset, which is what the budget being reached
on every question means.

**Prediction 2: confirmed.** `promptChars` spans **23,460 to 23,794**, with the
per-capability ranges almost entirely overlapping:

| Capability | n | min | median | max |
| --- | --- | --- | --- | --- |
| IE | 150 | 23,460 | 23,739 | 23,794 |
| MR | 121 | 23,649 | 23,746 | 23,782 |
| KU | 72 | 23,692 | 23,756 | 23,782 |
| TR | 127 | 23,572 | 23,735 | 23,781 |
| ABS | 30 | 23,702 | 23,751 | 23,787 |

The whole spread is **334 characters**, which is the instruction block and the
question line varying while the budget holds -- `evidenceRoom = maxChars -
instruction - questionLine - separators - header`. The carried size is a function
of the budget and not of the route, exactly as `fitToBudget`'s fixed priority order
requires.

### 13.13.8 What the measurement settles, and what it hands forward

The model receives **about 23,740 characters** of evidence against **about
506,338** offered -- **4.7%**.

`fitToBudget` truncates with `truncateCodePointSafe(evidenceText, evidenceRoom)`,
which takes a **prefix**. So the model reads the **first** turns in admission
order.

The size of that prefix in turns is an estimate, and the estimate is bounded on
both sides. The run's raw evidence is **144.24 characters per turn** (253,168,815
characters over 1,755,133 turns), so 23,740 carried characters is at most **165**
turns; the renderer adds a `N. ` index and a blank-line separator to every turn, so
the formatted cost per turn is higher and the true figure is lower -- roughly
**155 to 165**. The exact count is not carried, and that is a further refinement
this section does not make.

So the model reads roughly the first **160** of the roughly **3,496** median turns
offered -- **4.69%** of the evidence, on every question.

That converts §13.11.5's ranking question into a statement with a number in it:

> **Is the gold turn inside the top ~160 of ~3,500, by admission order?**

A ranker that leaves the gold turn below that position loses the question no matter
how complete retrieval was, and §13.11's reading already established that retrieval
is complete (minimum 3,016 turns, none empty). This is now the campaign's binding
constraint, and it is measurable -- but only against gold-turn attribution, which
this dataset does not carry on this arm (§13.11.5, §13.13.4).



## 13.14 The prompt carries a chronological prefix of the haystack, and the gold turn is outside it for 87.6% of questions

Registered because `§13.11.5` handed the next round a ranking question, `§13.13`
made the evidence size measurable, and measuring it turned up the answer to a
different question: **the feature has no ranking to blame.**

### 13.14.1 The finding, verified in code

The chain from the dataset to the model, read end to end:

| Step | Where | What it does to the order |
| --- | --- | --- |
| `flattenSessions(haystack_sessions, haystack_dates)` | `longmemeval-loader.ts` | session order, i.e. the dataset's own haystack order |
| `CortexMemory.answer(question, context)` | `memory.ts` | passes `context` straight to `#admit` |
| `#admit(context)` | `memory.ts:534` | `admissionOptionsFrom` + `admitTurns`, no reordering |
| `admitTurns(turns, options)` | `admission.ts:189` | `for (ordinal = 0; ordinal < turns.length; ordinal++)`, **push in iteration order**; no `sort` |
| `#prompt` → `buildPrompt` | `prompt.ts` | `formatEvidence(turns)`, preserving that order |
| `fitToBudget` | `prompt.ts` | `truncateCodePointSafe(evidenceText, evidenceRoom)` -- **a prefix** |

`memory.ts` contains **no** `retrieveTopK`, no `embedding`, no `similarity`, no
`rank` and no `sort(`. Its only retrieval-shaped member, `#retrievalAdmitted`, is a
**boolean** gate (`decideRetrieval` takes the maximum over candidates) and is called
from `answerAbstention` and nowhere else.

So on the flat route the evidence order is the **haystack order**, and the prompt
receives the **first `evidenceRoom` characters of it**. `§13.13` measured that
prefix at about 23,740 characters, roughly 155-165 of roughly 3,496 turns.

### 13.14.2 The finding, measured

The `benchmark-*-diagnostics.json` artifacts from run `38114272884` carry
`answer_session_ids`, `haystack_dates` and `answer_sessions_content` per question, so
the gold session's position in the haystack is derivable from an artifact that
already exists -- no new run and no dataset access needed.

For the **121** questions whose gold session could be located:

| Quantity | min | p25 | median | p75 | max |
| --- | --- | --- | --- | --- | --- |
| gold session position, as a fraction of the haystack | 0.000 | 0.115 | **0.220** | 0.438 | 0.891 |
| implied gold turn ordinal (fraction x `evidenceTurns`) | 0 | 400 | **748** | 1,452 | 3,136 |

**The gold turn falls inside the carried prefix for 15 of 121 questions -- 12.4%.**

The ordinal is an estimate: it assumes turns are spread evenly across sessions,
because the diagnostics carry session dates but not per-session turn counts. The
fraction is not an estimate and is what the conclusion rests on: the median gold
session sits at **22%** of the haystack while the prefix reaches **4.6%** of it, so
the search would have to be about five times deeper to reach the median question.
The two columns agree on the direction and on the order of magnitude, and a per-turn
attribution would refine the middle of the distribution rather than move it.

**Note the second-order fact.** 12.4% inside a prefix that covers 4.6% means golds
are about 2.7x more likely to be early than a uniform draw -- the dataset does front-
load some evidence. It does not change the verdict: **87.6% of questions have their
gold turn outside what the model was shown, and no prompt wording or model choice
can recover a question whose evidence never reached the prompt.**

### 13.14.3 This corrects a verdict of this document

`§13.11.4` pre-committed the recovery to the shape *"it is a look at `admission.ts`,
because producing no evidence for a question whose context demonstrably contains the
answer is a write-gate defect"*. `cortex-docs` §70.3 and §4.1.28 recorded that this
recovery **does not apply**, on the grounds that `empty = 0` proves the write gate
rejected nothing.

**That reading was wrong, and the correction matters more than the original
statement did.** `admission.ts` is exactly where the defect lives -- not in the gate
that decides *whether* a turn is admitted, which admits nearly everything at
`threshold: 0`, but in the **order** it admits them in, which is the caller's order
and carries no notion of relevance. The pre-committed recovery named the right file
for a reason that was close but not the reason the defect exists.

The lesson is recorded rather than the sentence rewritten: a pre-committed recovery
that names a module should be **executed** before it is declared inapplicable,
because "this module is not the problem" and "this module is the problem in a
different place" look identical from outside it.

### 13.14.4 The prediction this registers

The retrieval machinery this repository already measures is not the feature's.
`recall-curve.ts` drives `retrieveTopKByQueries` -- the bi-encoder the reference
pipeline uses -- and run `38114272884`'s curve reports:

| k | recall | ceiling | gain |
| --- | --- | --- | --- |
| 1 | 0.276 | 0.921 | 0.645 |
| 5 | 0.579 | 0.921 | 0.342 |
| 20 | 0.868 | 0.921 | 0.053 |
| 50 | **0.921** | 0.921 | **0.000** |

At k=50 the bi-encoder's own top-50 already contains every answer turn that is in
the pool at all: **gain is zero**, so reordering alone can add nothing more, and
`ceiling` is 0.921 rather than 1.0 because 6 of the 76 considered questions have
their answer outside the pool entirely -- a breadth problem, not an ordering one.

**Prediction: ordering the admitted turns by that ranking, and carrying the same
~160 turns, moves the gold turn inside the prefix from 12.4% to approximately the
curve's ceiling, 92%.** If the move is materially smaller, the gap is in the
transfer from retrieval scores to admission order rather than in the ranking.

### 13.14.5 What this does not establish

Whether the model answers correctly once the gold turn is present. `§13.13.8` and
this section together say the evidence now has to reach the model before that
question is even askable, and the current reading cannot separate "the gold never
arrived" from "the gold arrived and the model declined" because the first is true
for 87.6% of questions. The 12.4% where the gold did arrive are the only observations
that speak to the second, and there are 15 of them.

### 13.14.6 Status

**Registered.** The measurement is a reading of artifacts that already exist; the
repair it points at is not yet designed, because it changes what the feature's
admission path does and therefore what every number this arm has produced means.
## 13.15 The budget is spent on the turns that matter, and the roster names them

Registered because §13.14 located the root cause — the feature ranks nothing, so the
prompt received a chronological prefix of the haystack and the gold turn was inside it
for 12.4% of questions — and the repair it points at changes what every number this arm
has produced means.

### 13.15.1 What moved

| Surface | Before | After |
| --- | --- | --- |
| Evidence selection under budget | a character prefix of the arrival order | the largest prefix of the **relevance** order whose chronological rendering fits |
| Evidence presentation | arrival order | arrival order — **unchanged, deliberately** |
| Session note on an over-budget prompt | dropped | allocated after the question and rendered with the evidence |
| `lastRetrievedContext` / the roster `turns` | the turns **offered** to the builder | the turns the prompt **carried** |
| `evidenceTurnsPerRecord` (§10.3) | 16 | 256 |

### 13.15.2 The signal is injected, and that is the package boundary

`CortexMemoryOptions.relevanceFor` is `(question, turn) => number`, threaded into
`PromptOptions.relevanceFor` and read by the budget allocator.
`cortex-memory` reads no embedding model, so it cannot measure relevance and does not
try: it owns the mechanism and whoever has a measurement injects one, which is the same
boundary `confidenceFor` and `CortexMemoryOptions.llm` already use. The question is a
parameter rather than captured in a closure, so the callback is a pure function of its
arguments — the rule `fitToBudget` already applies to the ask.

**Absent means byte-identical.** Every prompt in every prior artifact is reproduced
character for character when no signal is supplied, and
`evidence-relevance.test.ts` characterises the unsignalled path as a **clip** (one
character of room buys one character of evidence) rather than asserting equality with a
remembered string.

### 13.15.3 Selection and presentation are different decisions

The repair does **not** reorder the log. A prompt that lists a later session before an
earlier one makes relative-time and knowledge-update questions unanswerable, which is
why `selectSessionBudget` pays for a second sort to put chosen sessions back into
chronological order. Selecting by relevance and *printing* in relevance order would
trade the 87.6% miss for a defect the session route already refused, so the tests pin
both halves: the selected set is the top-k by relevance, and it is printed in arrival
order.

The multi-session route keeps its boundaries and **drops a session that lost every
turn** — a boundary with nothing behind it is a claim about evidence that is not there —
while the surviving headers keep their original numbers, because renumbering `1, 2` over
what were the first and third conversations asserts an adjacency that does not exist.

### 13.15.4 The selection is a prefix of the relevance order, and what that costs

A prefix makes the size exact and the search monotone: rendered length is
non-decreasing in the number of turns, since every block keeps its place and its index
can only grow, so binary search lands on the largest fitting set. The alternative —
skipping a turn that does not fit and continuing — is a greedy fill whose cost model is
a second budget accounting, and this repository keeps one owner for the budget.

The cost is stated rather than hidden: **a single turn larger than the whole evidence
room ends the selection instead of being skipped past**, so the prompt carries no
evidence. That needs a turn more than 165 times this arm's mean turn length, and it is
observable when it happens — `evidenceChars` reports zero, the roster is empty, and both
are recorded per question.

### 13.15.5 The roster now holds what the model read, which is what made §13.11.5 askable

`§13.11.5` hands the campaign one question — was the gold turn inside what the model
saw — and it needs **membership**, not a size. The artifact had a size for the delivery
(`promptChars`, added by §13.13) and a roster of the **offer**, and a reader comparing
the gold turn against that roster was comparing it against evidence the model never
saw. With a relevance-driven selection the carried set is not a prefix, so nothing
outside the builder can name it: `AssembledPrompt.carried` travels out with the text and
`#recordEvidence` records it.

The three states are now readable from two fields, and they are different outcomes:

| State | `turns.length` | `evidenceTurns` |
| --- | --- | --- |
| no reader was consulted | 0 | 0 |
| nothing was cut | n | n |
| the budget or the bound removed turns | m | n, m < n |

### 13.15.6 The session note was a defect of the same family, found while wiring this

`buildSessionPrompt` assembles `[evidence, note, question, instruction]` and stated the
principle itself: *"a boundary that is rendered but unexplained is worse than one the
model is told about"*. On the over-budget path it called the allocator with no way to
pass the note, so **every over-budget multi-session prompt reached the model with the
boundaries drawn and the sentence explaining them missing** — and run `38114272884` had
every question over budget, so the note was absent from every MR, TR, ABS and KU prompt
in it.

That is the third instance of one family in this function: an intention stated in a
comment and not implemented on one branch (§12.9 (b), §57.6, §13.13 are the others).

**Registered prediction 1**: `promptChars` on the session routes is now about 172
characters lower than on the flat route at the same instruction and question lengths,
because the note occupies 170 characters plus one separator of the evidence room. §13.13's
second prediction — that the carried size is a function of the budget rather than of the
route — is now a function of the budget **and this one fixed offset**, and a spread
materially larger than that offset falsifies this reading.

**Registered prediction 2**: the note reaches the model, so `promptChars` decreases
rather than staying at the previous run's value for the same capability. The artifact
does not carry prompt text, so the size is the evidence; a run whose session-route
`promptChars` is unchanged falsifies the claim that the note was allocated.

**Open question, registered as open**: whether the note changes accuracy. The mechanism
claim is what this section registers; a directional prediction about MR would be a guess
about the model, and §13.14.5 records that this arm cannot yet separate "the evidence
never arrived" from "it arrived and the model declined".

### 13.15.7 Why the bound moved, which is a registration and not a tuning

`§13.12` registered `evidenceTurnsPerRecord: 16` when the roster held the **offered**
context, 3,016 to 4,528 turns per question — sixteen was then a real cut that kept the
artifact small. The roster now holds the **carried** evidence, which the prompt budget
already bounds at roughly 167 turns on this arm, so sixteen would cut an
already-bounded set and destroy the identities §13.11.5 needs.

The value is now **256**: twice what the budget carries at this arm's measured 144
characters per turn. It is a **writability** guard rather than a measurement — it exists
because a run that sets a large `maxPromptChars` would otherwise have no outer bound,
which is the failure §13.11.10 records reached from the configuration side — and if it
ever bites, the marker and `evidenceReduction` both record it rather than the roster
silently losing turns.

### 13.15.8 What this run tests, and what it deliberately does not

The dispatch that follows this section **supplies no relevance signal**, so the arm's
selection behaviour is unchanged and the only prompt-level change is the note. That is
deliberate: §13.14's repair moves the prompt's *content* for every session-route
question, and folding it into the same run as the note would leave two changes and no
attribution.

This run therefore measures three things, all of them about the instrument:

1. **the gold-inside-carried rate read from the artifact** rather than inferred. §13.14
   measured 12.4% by locating gold sessions in `benchmark-*-diagnostics.json`, whose
   turn ordinal was an estimate from session dates. The roster now names the carried
   turns, so the same fraction is measurable exactly and from the ablation artifact.
2. **the note's effect on the size**, per prediction 1 above.
3. **the note's effect on accuracy**, recorded as an observation and not as a claim,
   because this section registers a mechanism and not a direction.

The relevance signal is the next section's single variable, and it is not this one's.

## 13.16 What run 38142407062 read, and the measurement §13.15 broke

Registered because the run §13.15.8 scheduled completed, and reading it turned up both
a confirmed prediction and a defect in the change that made the prediction readable.

### 13.16.1 The run

`38142407062` @ `de8843ae`, all nineteen steps success. Artifact 26.6 MB, up from
3.9 MB, which is the roster now carrying ~143 carried lines per question instead of
sixteen offered ones.

| Metric | `38114272884` | `38142407062` |
| --- | --- | --- |
| baseline | 44.30% | 44.90% |
| feature | 6.35% | 6.40% |
| delta | -37.95pp | **-38.50pp** |
| discordant b✓f✗ / b✗f✓ | 189 / 0 | **192 / 0** |
| MR feature | 0.00% | **0.83%** (1 question) |
| abstention rate | 96.45% | **95.40%** |
| answered, per run | 70 | **92** |
| `empty` / `threshold` | 0 / 0 | **0 / 0** |

The model answered twenty-two more questions per run and got one of them right. The
movement is inside this endpoint's own noise, which §20 quantifies; **nothing here is
evidence that the note helped**, and that is how §13.15.6 registered it.

### 13.16.2 Prediction 1: the mechanism is confirmed and the magnitude was wrong

Registered: *"`promptChars` on the session routes is now about 172 characters lower than
on the flat route."*

`promptChars` per question, before and after:

| Capability | `38114272884` min / median / max | `38142407062` min / median / max |
| --- | --- | --- |
| IE (flat) | 23,460 / 23,739 / 23,794 | **identical** |
| MR (session) | 23,649 / 23,746 / 23,782 | **23,499 / 23,596 / 23,632** |
| TR, KU, ABS | -- | **identical** |

Two findings, and the second is the one worth the registration.

1. **The note is allocated, and it costs exactly 150 characters** -- 148 for the sentence
   plus one two-character separator. My registered figure was 172, which I had not
   measured; `SESSION_NOTE.length` is 148 and I would have got 150 by counting it. The
   correction is recorded rather than the prediction quietly restated.
2. **The note reaches ONE route, not four.** §13.15.6 wrote "every MR, TR, ABS and KU
   prompt". That is wrong: `buildSessionPrompt` has exactly one caller, `answerSessions`,
   which is the MR route. TR, ABS, KU and the assistant route go through `#prompt` and the
   flat builder, which draws no session boundaries and therefore never had a note to lose.
   The claim was reasoned from "these are the session-taking routes" -- which is true of
   `#admit`, and false of the prompt builder. The artifact says otherwise, and the
   artifact is the one that gets to decide.

### 13.16.3 The instrument reading: gold inside what the model read, measured

§13.14 measured 12.4% and labelled its turn ordinal an **estimate** from session dates.
The roster names the carried lines, so the same quantity is now exact:

| Quantity | Value |
| --- | --- |
| questions whose gold session could be located | 121 |
| **gold turn inside the carried set** | **14 / 121 = 11.6%** |
| cross-check: the session-index rule agrees with exact turn identity | **121 / 121** |

**The estimate was confirmed to 0.8pp**, and the cross-check is what makes the number
trustworthy: the rule "the first answer session's index is at or before the last carried
turn's index" is computable from date stamps alone, and it agrees with turn identity on
every question.

**A first attempt read 27.3% and was wrong.** It intersected *lines*: turn content in this
dataset spans newlines, so a line of one turn matches a line of another and every
question with a common phrase became a hit. The corrected probe parses turns -- a stamped
segment, its continuation lines attached -- and the two probes agree only after that fix.
Recorded because the error was invisible from inside the wrong probe: it produced a
plausible number for a non-existent effect, and only cross-checking two independent
routes exposed it.

The carried prefix reaches a **median of 1.1 sessions** of 47, while the first answer
session sits at a median of **11**. That is the whole of the 11.6%.

### 13.16.4 The defect §13.15 introduced, which the run exposed

`evidenceTurns` fell from 3,016-4,528 to a **median of 141**. It was not measuring the
offer any more: it is derived from the captured context, and §13.15 changed the captured
context from the **offer** to the **delivery**. So the record had `turns` and
`evidenceTurns` both describing the delivery, and nothing reporting how much evidence had
existed -- which is what §13.11.3 reads and what makes the budget's effect legible. The
artifact had been made *less* able to describe a run by the change that made it able to
answer §13.11.5.

**Fixed by giving the offer its own capture**, `MemorySystem.lastAdmittedEvidence`,
recorded in the same call as the other two measurements and carried as two counts
(`AdmittedEvidence`) rather than as text -- text would be the unbounded shape §13.13
removed.

**Fixed at the type level too, and this is the part worth keeping.** `QuestionRecordInput`
now requires `admitted`. The compiler therefore enumerated every producer, and it found
`withEvidenceBound` -- the reducer's rebuild, which is the **third** place a field has been
silently dropped by not being listed (`featureConfig`, then `promptChars`). For the first
time that family is a compile error rather than an artifact that quietly reports the wrong
number.

**Required and nullable**, not optional and not numeric:

- **required**, so the enumeration above happens and cannot be forgotten;
- **nullable**, because a system may legitimately have no accessor -- the arm's own test
  doubles have none -- and a fabricated zero would read as a system that admitted nothing,
  which is the collapse `evidenceTurns`' own docs warn about.

`admitted: null` reaches the record as an **absent** `evidenceTurns`, so the three states
are `absent` / `turns.length < evidenceTurns` / `turns.length === evidenceTurns`. One test
that asserted the old collapse (`evidenceTurns === 0` for a system with no accessor) was
rewritten to assert the absence, because the collapse was the defect.

Two readers round-trip artifacts back through `buildQuestionRecords` -- the reducer and
both `tools/*.mjs` -- so the reverse mapping has **one owner**, `admittedFromRecord`, used
by all three. Three hand-rolled copies of one mapping would drift, and the drift would be
silent: two readers reconstructing differently would report different runs from the same
file.

### 13.16.5 Two smaller repairs that fell out of the same wiring

**The bound's effect is now stated, not inferred.** `evidenceReductionOf` detected the
bound by comparing `turns.length` against `evidenceTurns`, which stopped meaning "the
bound bit" the moment `evidenceTurns` became the offer -- it would have fired on every
record of every run and reported a bound that never engaged. It now reads the marker, which
is the bound's own disclosure, and reports `droppedTurns` directly instead of leaving a
reader to compute `turnsMeasured - turnsCarried`. That arithmetic had already stopped
working: `turnsCarried` no longer counts the marker, and `turnsMeasured` is the bound's
pre-image rather than the offer.

**A context line that looks like a marker is not read as one.** A caller's own text can
begin with `[evidence reduced:`; the parse is anchored on the numbers, so a lookalike is
not taken for a reduction. Tested, because the alternative reading attributes a reduction
to a dataset phrase.

### 13.16.6 Registered: the roster counts LINES, and has since it existed

Measured on this run's artifact: of 17,341 roster entries across the MR questions,
**14,724 (84.9%) are not stamped starts** -- they are continuation lines of a turn whose
content spans newlines. Roster entry [1] is a turn start and entries [2]-[6] are five more
lines of the same assistant turn.

So `turns`, `evidenceTurns`, `evidenceChars` and every count derived from them are counts
of **lines of the joined context**, and the docs have called them turns throughout. The
magnitude of the error on this data is about **6.6 lines per turn**: the budget carries
~143 lines, which is roughly 22 turns, and `§13.13`'s "~165 turns" is ~165 lines.

**What this does not break.** The selection operates on turns and is unaffected. The
gold-turn identification in §13.16.3 works because a turn's first line is stamped and
therefore appears in the roster as its own entry, which is also why the two independent
probes agreed.

**What it does break.** Every count in this document's §13.13-13.16 that says "turns"
means lines. The unit is wrong, not the measurements: the ratio arguments hold on either
unit because both sides are in the same one.

**The fix is registered and not made**, deliberately: it changes `lastRetrievedContext`'s
contract from a joined string to a list of turns, which ripples through the capture, the
roster, `QuestionRecordInput.retrieved` and `boundRetrievedContexts` -- all registered
surface. Doing it in the same change as the offer repair would leave two changes to one
measurement and no way to attribute either.

### 13.16.7 Status and what is next

**Registered, with the offer repaired and the unit defect open.** Gate: `pnpm check`
exit 0, cortex-eval 1,790 tests and cortex-memory 269, all four coverage dimensions 100%
in both, census clean, pre-registration guard 300 passed with 20 subtests.

| Priority | Item |
| --- | --- |
| **P0** | Supply the retrieval relevance signal (§13.14.4's registered prediction: gold-inside-carried 11.6% -> ~92%). Now the single remaining variable, because the note is measured and the offer is reported again |
| **P0** | Read the next artifact for `admittedTurns` per question, which is the first run that can report how much evidence existed |
| P1 | Repair the line/turn unit (§13.16.6), as its own registered change |
| P1 | Per-turn gold attribution, to replace the session-index rule with a turn-level measurement |
| P2 | The in-band marker's ambiguity: a context line that happens to carry the exact marker shape would be read as a reduction |

## 13.17 The budget learns which turns matter, and what that is registered to change

§13.16 left exactly one variable open, and it is the one §13.14 predicted the whole loss
turns on. The prompt's budget is settled: 24,000 characters against a context whose mean is
506,338, carrying 4.69% of it. Its *size* is therefore not a live question — §13.13 measured
that enlarging it would buy a better chance of hitting the answer by luck — and what
remained is that it bought the **wrong** turns. Until this section nothing beneath the
builder ranked anything at all, so the prefix it spent the budget on was the dataset's
arrival order.

### 13.17.1 The finding this registers against, in one number

The gold turn was inside the evidence the model actually read for **11.6%** of questions —
14 of 121 — with a ceiling of **92.1%**, the share of questions whose answer turn is in the
bundle at all (`MEASURE-B2-RECALL-CURVE.md`: `recall = 0.921` at `k = 50`, curve already
flattened, six questions with no answer turn in the bundle). Both numbers come from run
`38142407062`, and §13.16.3 records how they were read and cross-checked (121 of 121
records agreed between the two independent paths).

The gap is therefore not between what retrieval *could* find and what it *did* find — the
ceiling is what the bundle offers — but between what the bundle offers and what the budget
pays for. Eleven point six per cent against ninety-two point one per cent is the whole of
the defect, and it is a selection defect rather than a budget, prompt or model defect.

### 13.17.2 What was built

A relevance index, built once per run before either side is graded, over each question's
**own** context with the arm's **own** embedding backend. It reuses
`retrieveTopKByQueries` — the same bi-encoder, the same fusion — so the ranking the feature
side selects with and the ranking the reference pipeline retrieves with are one ranking
rather than two that happen to agree. The prompt builder receives it as
`CortexMemoryOptions.relevanceFor`, spends the budget on the highest-ranking turns, and
presents them in **arrival order**, because a prompt printed in relevance order would make
relative-time and knowledge-update questions unanswerable — the same reason
`selectSessionBudget` pays for a second sort.

The width is registered rather than chosen at dispatch time (**§10.3**), and every layer of
its plumbing is guarded: the arm option (`readRelevanceSignal`, `readRelevanceTopK`), the
artifact (`MemoryArmConfig.relevanceSignal`, `relevanceTopK`, rendered on the config line),
the workflow input and its `env:` forward, and the dispatch's own value — which
`tools/__tests__/test_preregistration_config.py` compares against §10.3 in both directions.

### 13.17.3 The signal is non-oracle, and that is a type rather than a promise

`RelevanceCase` has two fields: a question and its context. The ground truth is **not a
parameter**, so "the index was sharpened with the answer key" is not a mistake a later edit
can make quietly — the type would have to change first. `relevance-index.test.ts` measures
the property end to end: two cases that differ only in an unread field produce one index,
including one `scoredPairs` count.

This matters more here than at any earlier layer, because a signal derived from the answer
key would not look wrong in any artifact. It would make `gold-in-carried` approach 100% and
the accuracy delta would improve, and both numbers would be true statements about a run that
graded itself.

### 13.17.4 The predictions this registers, so the repair is falsifiable

Both are read from the next run's artifact, and neither is a restatement of "the code
changed".

* **P1 — `gold-in-carried` rises to at least 0.80, point estimate 0.92.** The mechanism is
  arithmetic: the prompt holds roughly 167 turns at 24,000 characters and the index scores
  the top 64, so **every scored turn survives selection** and a gold turn that retrieval
  places inside its top 64 is carried regardless of where it sits in arrival order. The
  prediction is therefore `P(gold inside the index's top 64)` conditioned on the gold turn
  passing admission. `MEASURE-B2-RECALL-CURVE.md` measured `0.921` at `k = 50` — a lower
  width than this run's — so a reading materially below `0.80` falsifies the mechanism
  rather than the arithmetic, and the first thing to check would be whether the index's
  keys matched the admitted turns at all.
* **P2 — the feature side's abstention rate falls below 80%, from 95.40%.** This is the
  prediction that connects selection to the score. §13 established that the feature's
  abstentions are the **model's** (`reason: "llm"`, `retrievalThreshold: 0` so the gate
  never closed) and that 113 of 120 outputs were the bare `INSUFFICIENT_EVIDENCE` token —
  the model was shown evidence and declined. If the evidence it is shown is the evidence the
  question is about, a meaningful share of those declines should become answers. A run whose
  `gold-in-carried` rises while the abstention rate does not isolates the loss to the model
  rather than to retrieval, and that is a result about this arm rather than a failed repair.

**What the pair jointly excludes.** P1 holding and P2 failing would retire the retrieval
hypothesis for this arm — the evidence is present and the model still declines — which is
precisely the state §13.11 opened and could not close, because the artifact could not say
whether the evidence had been there. Either outcome narrows the remaining space, which is
the property a registered prediction is supposed to have.

### 13.17.5 What would still not be known afterwards

The width is a single point. `64` is registered because it sits at or above a **measured**
knee (`recall = 0.921` at `k = 50`), not because a sweep chose it, so the run cannot say
where between `50` and the budget's capacity the reading stops improving. A later
registration can sweep that axis, and this one deliberately does not: moving the width in
the same run as the signal would make a null result unattributable to either.

The unit defect of §13.16.6 is also still open and still registered. `evidenceTurns` counts
**lines** of the joined context rather than turns, and the offer's count matches it on
purpose so the ratio between offer and delivery stays meaningful. Repairing one side alone
would make that ratio a fact about two units.

### 13.17.6 Status

**Registered and built; awaiting its dispatch.** The single variable is
`relevanceSignal: retrieval` at `relevanceTopK: 64`; the rendering, the ask, both
thresholds, the ceiling and the session budget are all held at their §13 values, so a
non-zero delta cannot be attributed to any of them.

### 13.17.7 The first dispatch failed, one layer above everything this section tested

The dispatch was rejected before it started:

    422 Invalid Argument - failed to parse workflow: you may only define up to 25
    `inputs` for a `workflow_dispatch` event

`benchmark.yml` held 26 once this section's two inputs were added. Every layer §13.17.2
built tested green — the arm option, the artifact field, the `env:` forward, the dispatch
script's value, and `test_preregistration_config.py` comparing §10.3 against the dispatch in
both directions — and the run could not start. That is the §7.3 side-channel defect one level
up: the artifact would have described a configuration no run ever applied, because there was
no run, and no test in this repository could see it because the limit is enforced by the
platform rather than by any file under test.

**The repair is structural rather than a subtraction.** The ceiling is per workflow, so the
arm's inputs move to `benchmark-cortex-memory.yml` — fifteen in `benchmark.yml`, seventeen in
the new one. Removing a knob instead would have re-created the defect this section exists to
avoid: `cortex_memory_session_budget` and `cortex_memory_confidence` are the only two inputs
§10.3 does not register, so they are the only two whose deletion costs nothing this run
needs, and deleting either would have made a registered configuration un-dispatchable the
next time it was wanted. The split is also the shape the dependency graph already has:
this arm is the only entry point that can construct both of its sides, and it is the one job
whose inputs are about the cognitive layer rather than about the reference pipeline.

Two guards came out of the failure, both in `tools/__tests__/test_dispatch_inputs.py`:

* every dispatch script is pinned to the workflow that declares **its** inputs, so
  `dispatch-cortex-memory-ab.py` is no longer checked against a file that has nothing to do
  with it — and the pinning is itself asserted, so an unmapped script fails rather than
  skips;
* **no `workflow_dispatch` in this repository may hold 25 inputs.** A workflow at the maximum
  is one registration away from being un-dispatchable, and the failure that produces is a
  `422` at dispatch time rather than a red test. `benchmark.yml` now declares fifteen and the
  arm's own workflow seventeen, so both have room for the next registration.

The artifact name is unchanged (`longmemeval-s-report`) on purpose: the fetch tooling resolves
by name, and a second name would make every reader learn which workflow produced a report
before it could download it.

## 13.18 What run 38250133116 read: the selection hypothesis holds, and the metric I read it with does not

The run completed all 13 steps in 3 h 47 m and produced a 26.7 MB artifact. It is the first
run of this arm whose feature side **beats** the reference pipeline. It is also the first whose
headline metric I could not read honestly from the artifact alone, and that second fact is the
more useful one.

### 13.18.1 The headline, and it is not noise

| Metric | `38142407062` (no signal) | `38250133116` (retrieval @ 64) |
| --- | --- | --- |
| baseline / feature | 44.90% / 6.40% | 44.00% / **54.30%** |
| **Δ** | **−38.50pp** | **+10.30pp** |
| McNemar p | — | **2.724e-3** (significant) |
| discordant `b✓f✗` / `b✗f✓` | 192 / **0** | 130 / **184** |
| feature abstention rate | 95.40% | **38.00%** |
| per-run `llm` / `answered` | — | 195.5 / 304.5 |

`b✗f✓ = 184` is the first non-zero repair count this arm has produced. Every earlier artifact
had `b✗f✓ = 0` on every capability, which is what made the pre-§13 line dead rather than
merely weak: a feature that repairs nothing is a feature with no mechanism.

**P2 holds.** The registered prediction was an abstention rate below 80% against 95.40%, and
the reading is 38.00%. The mechanism §13.17.4 argued for — the model declines because what it
is shown is not what it was asked about — is consistent with a 57.4-point fall in declines.

### 13.18.2 P1 cannot be read off this artifact, and the reason is a defect in my predicate

The registered prediction was `gold-in-carried ≥ 0.80`. I computed it by testing whether a
record's `groundTruth` appears as a substring of any carried turn, and the first pass returned
`MR 47.1%`, `ALL 48.7%` against `31.4%` / `16.2%` on the same predicate over §13.16's run.

**Those numbers are not usable, and the artifact says why in three lines.** The predicate is
short-answer-blind:

| question id | `groundTruth` | the "match" it found |
| --- | --- | --- |
| `3a704032` | `3` | `3. **Humidity:** Peace lilies prefer a humid environment…` |
| `b46e15ed` | `2` | `2. What are your short-term and long-term goals for the product?` |
| `0a995998` | `3` | `3. store reusable produce bags in a cool, dry place…` |

A list marker is not an answer, and on a dataset where a large share of answers are small
cardinalities the predicate is dominated by them. Tightening it — word boundaries, skipping
list-item lines — removes these three and leaves the rest unverifiable, because "3 items" and
"3 days" are the same token and only the *question* says which one is the answer.

So P1 is **not falsified and not confirmed**. What can be said is the part that does not need
the predicate: the feature side went from repairing nothing to repairing 184 questions, and the
prediction that connected selection to score (P2) held.

### 13.18.3 Why §13.16 got a number and this reading could not

§13.16.3 reported `gold-in-carried = 11.6%` from the **same artifact family**, and the
difference is the predicate, not the data. `§13.11.5`'s measurement is about the **gold turn** —
the dataset's own annotation of which turn carries the answer — and §13.16 read it with a
turn-level rule (the gold session's turns, resolved by session index) rather than by string
matching a `groundTruth` field.

That rule is exactly what `§13.16.7`'s P1 list calls "per-turn gold attribution, to replace the
session-index rule with a turn-level measurement". This run makes that the **first** priority
rather than a later one, and for a reason that is not tidiness: without it, P1 is a prediction
that cannot be read, and a prediction that cannot be read cannot be falsified. A registration
whose outcome is unmeasurable is the §7.3 defect pointed at the pre-registration itself.

### 13.18.4 The deliverable readings, which need no predicate

| Quantity | `38142407062` | `38250133116` |
| --- | --- | --- |
| offer, lines per question | — | mean **3,510.3** |
| delivery, turns per question | median 141 | mean **152.3**, median 148, max 257 |
| `promptChars` | 23,499–23,632 | mean **22,814**, median 23,076 |
| evidence bound engaged | — | 7 records (256-turn guard) |

The offer is now reported beside the delivery for the first time, which is what `§13.16.4`
repaired: the artifact can say how much evidence existed and how much of it the model read.
The delivery ratio is `152.3 / 3510.3 = 4.34%`, against §13.13's 4.69% — **the budget buys
almost exactly as many turns as before**, and it buys different ones. That is the cleanest
statement this run supports: the change is in *which* turns, not in how many.

### 13.18.5 The capability split, and what it says about the next question

| Capability | baseline | feature | `b✓f✗` | `b✗f✓` |
| --- | --- | --- | --- | --- |
| IE | 0.67% | **84.67%** | 0 | 126 |
| KU | 0.00% | **73.61%** | 0 | 53 |
| ABS | 100.00% | 93.33% | 2 | 0 |
| MR | 85.95% | 31.40% | 67 | 1 |
| TR | 66.93% | 22.05% | 61 | 4 |

Two systems that are near-complementary, and the net is `+10.30pp`. The reference pipeline's
IE and KU figures are the surprise — `0.67%` and `0.00%` against a 44% overall — and they say
the two sides are not competing on the same questions: the feature side answers
entity-attribute and knowledge-update questions the baseline abstains on, and abstains on the
multi-session and temporal questions the baseline answers.

**MR and TR are where the feature still loses**, and the loss is dominated by declines rather
than by wrong answers: MR abstains on 56 of 121 (46.3%) and TR on 85 of 127 (66.9%). Whether
those questions' evidence is present but unread is the question `§13.18.2` could not answer,
and it is the same question per-turn gold attribution answers — which is why the two P0 items
below are one item.

### 13.18.6 Status, and the next two steps

**Registered, measured, and read as far as the artifact honestly allows.** Gate: `pnpm check`
exit 0, `test:tools` 302 passed + 29 subtests, cortex-eval 1,811 tests, cortex-memory 269
tests, 100% on all four coverage dimensions in both, census clean.

| Priority | Item |
| --- | --- |
| **P0** | **Put the gold turn in the artifact.** Read the dataset's answer-turn annotation into `QuestionRecord` as the carried indices it matches, so `gold-in-carried` becomes a number this repository computes rather than one it approximates. This is §13.11.5's measurement, §13.16.3's rule replaced by a turn-level one, and the precondition for reading P1 at all |
| **P0** | Re-read P1 with that field, and split MR/TR's 46.3% / 66.9% decline rate by whether the gold turn was carried — the per-turn attribution that decides retrieval-side from model-side |
| P1 | Repair the line/turn unit (§13.16.6) |
| P2 | The in-band marker's ambiguity; `grounded` is still hard-coded `false`; the writer's reduced manifest is not uploaded |
| P3 | `PATH` ordering, which waits on a rebuilt image |

## 13.19 The gold turn reaches the artifact, and the number stops being a guess

§13.18.2 could not read the prediction it had registered, and the reason was not the
artifact's completeness — it was that no field in it identified the evidence the dataset
says answers the question. This section puts that field there.

### 13.19.1 What was discarded, and for how long

`loadLongMemEval` read `haystack_session_ids` and `answer_session_ids` and used neither.
The minutes of the problem are short and worth stating exactly: the dataset names which
sessions hold an answer, the loader dropped both the names and the identifiers that would
have connected them to positions, and every downstream question about coverage was
therefore answered by a heuristic.

Two heuristics were tried. §13.16 resolved the gold session by **session index**, which
§13.16.7 recorded as a rule that should be replaced by a turn-level measurement. §13.18.2
tried the **answer text** as a substring and the artifact refuted it: `groundTruth` of `3`
matched `3. **Humidity:**`, `2` matched `2. What are your short-term goals`, `3` matched
`3. store reusable produce bags`. The second reading is the one that cost a round, because
it produced plausible numbers — `MR 47.1%`, `ALL 48.7%` — that could not be read.

### 13.19.2 The repair, and why it is one field rather than a better heuristic

`Question.goldTurns` carries the gold session's turns **rendered by the same function that
renders `context`** (`turnText`). That makes membership an **equality test between two
applications of one renderer** rather than a natural-language match, and it is the whole of
the design: a heuristic can be made better or worse, but an equality cannot be made
ambiguous.

The identifiers are intersected where they belong — in the loader, which is the only place
that has both lists:

    haystack_session_ids[i]  ∩  answer_session_ids   →  sessions[i]

and the result is absent rather than empty when the dataset names nothing, because `[]`
would be a claim ("this question has no gold turns, so nothing was missed") that an
abstention question does not support.

### 13.19.3 Where it is measured, and the two ways that could have gone wrong

`goldOverlapOf(retrieved, goldTurns)` is the single implementation, and it is called by the
arm against the **pre-bound** context. The alternative — computing it inside
`buildQuestionRecords` — was implemented first and reverted, because the reducer re-enters
through the same builder with a context it has already reduced: coverage would have **fallen
as the evidence bound tightened**, which is a writability guard moving a measurement. That
is the class of defect §13.12 exists to keep out of the artifact, and the test that pins it
asserts the carried value against a record whose turns were cut to a third of what it was
measured on.

The second near-miss is in the predicate itself. The first version used
`retrieved.includes(turn)`, which is a substring search one layer in — the same shape as
§13.18.2. It differs exactly where a gold turn is a **prefix** of another turn
(`[d] user: I went` inside `[d] user: I went to Lisbon`), and the reported coverage would
then depend on which of the two the dataset named. The implemented version pads the
haystack by one separator on each side and tests for `\n<turn>\n`, which asks "is this text
one of the carried blocks" — the question actually being asked. Both the prefix case and
§13.18.2's own counterexample are regression tests.

### 13.19.4 What the field makes readable, and what it still does not

`goldOverlap: { carried, total }` — two numbers rather than a boolean, because
`carried === total` is the coverage question while the denominator is what makes an
aggregate over questions meaningful. §13.18.2 is what a metric without a denominator cost:
a figure that could be moved by which questions were counted.

Three states, and they do not collapse: **absent** (nothing to measure — no annotation, or
no recorded context), **`carried: 0`** (measured, the gold turn was not carried), and
**`carried: total`** (measured, it was). The absent state is what the two heuristics could
not express, and a zero where a reader expects a measurement is how coverage was misread
once already.

What it still does not do: attribute a **partial** carry to a session boundary rather than
to the turn, and locate the gold turn inside the record's `turns` array. Both need the
turn's position rather than its text, and that is the line/turn unit defect of §13.16.6 —
registered, still open, and now the only thing standing between this field and a per-turn
attribution.

### 13.19.5 Status

**Implemented, tested, and about to be dispatched.** Gate: `pnpm check` exit 0, cortex-eval
**1,832** tests (21 new), cortex-memory 269, both packages 100% on all four coverage
dimensions, census clean, pre-registration guard 303 passed + 31 subtests.

The dispatch is the same one §13.17 made, unchanged: the single variable is still
`relevanceSignal: retrieval` at `relevanceTopK: 64`. Nothing in the workflow moves, because
this field is derived from the dataset rather than configured — so the run answers §13.17's
P1 against the same conditions it was registered under, this time with a number rather than
an approximation.

## 13.20 What run 38394103193 read: the coverage question answered, and MR/TR localised to the ask

Run `38394103193` completed all 13 steps in 3 h 31 m. It is the same configuration
§13.17 dispatched, with §13.19's field added, and it is the first run of this arm whose
central prediction could be read as a number.

### 13.20.1 The headline holds under a second sample

| Metric | `38250133116` | `38394103193` |
| --- | --- | --- |
| baseline / feature | 44.00% / 54.30% | 44.40% / **54.60%** |
| **Δ** | **+10.30pp** | **+9.25pp** |
| McNemar p | 2.724e-3 | **5.179e-3** |
| discordant `b✓f✗` / `b✗f✓` | 130 / 184 | 135 / **186** |
| abstention rate | 38.00% | 39.20% |
| per-run `llm` / `answered` | 195.5 / 304.5 | 196.8 / 303.3 |

Two independent runs of the same arming, agreeing to within a point. The selection
hypothesis is not a single-sample result.

### 13.20.2 P1, and the definition it required

The registered prediction was `gold-in-carried ≥ 0.80`. `goldOverlap` now measures it
directly, and the answer depends on which of two readings "carried" means:

| Reading | IE | MR | KU | TR | ABS | ALL |
| --- | --- | --- | --- | --- | --- | --- |
| **at least one** gold turn carried | 149/150 | **121/121** | 72/72 | 126/127 | 30/30 | **498/500 = 99.6%** |
| **every** gold turn carried | 51/150 | 1/121 | 0/72 | 2/127 | 0/30 | 54/500 = 10.8% |
| mean `carried / total` | 76.2% | 48.9% | 62.1% | 46.3% | 48.4% | — |

**P1 holds under the reading its own mechanism argued for.** §13.17.4's prediction was
`P(gold inside the index's top 64)` -- a statement about *a* gold turn being present, not
about every turn of the gold session fitting in a budget that holds roughly 167 turns.
Under that reading the figure is **99.6%** (MR **121/121, up from §13.16's 14/121 = 11.6%**
on the same 121 questions), against a registered floor of 0.80.

Two things are registered rather than glossed:

* **the definition was fixed after the fact, and that is a defect in how P1 was written.**
  Both readings were computable from the start and only one was named; a prediction whose
  outcome depends on an unspecified term is not falsifiable, which is the same complaint
  §13.18 raised about the metric one layer up.
* **there is no same-definition control.** §13.16's 11.6% used a session-index rule on a run
  without a signal, so the comparison `11.6% → 100%` is across two rules even though it is
  across the same 121 questions. The reading that needs no comparison is `carried == 0`:
  **2 of 500 questions**. Under the arrival-order prefix of `38142407062`, where the gold
  turn was inside the context for 11.6% of MR questions, a figure of 0.4% is not reachable
  by chance -- and a control arm that re-ran without the signal would settle it, which is
  the next registration after this one.

The stronger reading is kept in the artifact for the reason it was measured: a partial
carry is the ordinary case (444 of 500) and a metric that reported only the two extremes
would hide the difference between carrying one gold turn of two and one of forty-eight.

### 13.20.3 MR/TR are not a retrieval failure, and the artifact says so directly

This is the reading §13.18.5 asked for and could not perform. Splitting the abstentions by
whether the gold turn was carried:

| Capability | abstained | of those, gold carried ≥ 1 | gold carried 0 |
| --- | --- | --- | --- |
| MR | 56/121 (46.3%) | **56** | 0 |
| TR | 88/127 (69.3%) | **87** | 1 |
| IE | 20/150 (13.3%) | 19 | 1 |
| KU | 3/72 (4.2%) | 3 | 0 |

**Every MR abstention and 87 of 88 TR abstentions had the gold evidence in front of the
model.** A retrieval-side repair cannot reach them: there is nothing left to retrieve.

And the shape of the decline is uniform to the point of being diagnostic: **all 167
abstentions in the run -- 56 MR, 88 TR, 20 IE, 3 KU -- are the bare `INSUFFICIENT_EVIDENCE`
token.** Not one has prose, not one is a wrong answer. The model is shown relevant evidence,
given an instruction block, and emits the decline token.

### 13.20.4 What the instruction block removes, which is the finding

Both runs dispatched `ask: 'extractive'`, which replaces **every** route's block with the
reference pipeline's two-line one:

    Answer the question using only the evidence above.
    Reply with the answer alone. If the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE.

That block is not merely more abstention-flavoured than each route's own -- it is
**shorter**, and what it removes is each route's *reasoning* instruction. Two of them are
the ones the losing capabilities need:

* `temporal`: *"resolve every relative expression ('last week', 'two months ago') against
  that date"* and *"show the resolved date in your answer"* -- TR is 127 relative-time
  questions;
* `knowledge-update`: *"distinguish the earlier value from the later one"* and *"use the
  evidence with the latest date"* -- KU is 72 of them.

So the ask is not a wording preference. On this reading the feature side is being told, on
69% of its temporal questions, to answer a question whose reasoning instruction has been
removed, and it declines.

### 13.20.5 What this registers

**One variable: the ask, reverted to `route`.** Every other input is held at its §13.17
value -- `relevanceSignal: retrieval` at `relevanceTopK: 64`, the same rendering, the same
gates -- so a movement in MR or TR is attributable to the instruction block and nothing
else. §10.3 is amended in place, and the dispatch carries the value.

| Prediction | Reading | Falsified if |
| --- | --- | --- |
| **P1'** | TR's abstention rate falls **below 50%** (from 69.3%). Restoring the date-resolution instruction is the registered mechanism, and TR is where it is absent on 127 questions | TR stays above 60%, which would say the block was not what the model was reacting to |
| **P2'** | MR's abstention rate falls **below 35%** (from 46.3%). MR's own ask already *was* `extractive`, so this route is the control for "the ask changed nothing there" -- a movement here would mean something else moved with it | MR rises above 50% |
| **P3'** | ABS does **not** regress (93.33% currently). The abstention route keeps its own block under `route`, and ABS's gold *is* abstention, so a fall here would mean the reverted ask leaked into the one route where declining is correct | ABS falls below 85% |

**What P2' is for.** MR is the internal control: `ask: 'extractive'` left MR byte-identical
before the signal existed (§13.2), and it should leave it near-identical now. If MR moves as
much as TR, then the ask is not the mechanism and the next hypothesis is about the model's
handling of aggregation, which is a different registration.

### 13.20.6 Status

**Read, localised, and registered.** Gate: `pnpm check` exit 0, `test:tools` 303 passed + 31
subtests with the amended §10.3, cortex-eval 1,832 tests, cortex-memory 269, 100% on all
four coverage dimensions in both, census clean.

## 13.21 What run 38439899858 read: the ask axis returns +8.95pp, and MR is all that is left

Run `38439899858` completed in 3 h 30 m. It is the largest single movement this arm has
produced, and every capability that moved did so on the route whose instruction block the
previous run had replaced.

### 13.21.1 The headline

| Metric | `38394103193` (ask: `extractive`) | `38439899858` (ask: `route`) |
| --- | --- | --- |
| baseline / feature | 44.40% / 54.60% | 44.85% / **63.05%** |
| **Δ** | +9.25pp | **+18.20pp** |
| McNemar p | 5.179e-3 | **2.737e-7** |
| discordant `b✓f✗` / `b✗f✓` | 135 / 186 | **107 / 197** |
| abstention rate | 39.20% | **30.40%** |

The feature side is now **18.20 points above the reference pipeline** and 10.55 points
above the *unmeasured* ceiling §13.20 left it at, with the p-value falling four orders of
magnitude. `b✗f✓ = 197` is the highest repair count this arm has recorded.

### 13.21.2 The per-route reading is the mechanism, and it is exact

| Capability | `38394103193` acc | `38439899858` acc | Δ | abstention (before → after) | whose block changed |
| --- | --- | --- | --- | --- | --- |
| TR | 22.05% | **49.61%** | **+27.56pp** | 69.3% → **35.4%** | `temporal` — restored |
| KU | 73.61% | **86.11%** | **+12.50pp** | — → **1.4%** | `knowledge-update` — restored |
| ABS | 93.33% | **100.00%** | **+6.67pp** | 100% (correct) | `abstention` — restored |
| IE | 84.67% | 84.00% | −0.67pp | — → 13.3% | `extractive` — **unchanged** |
| MR | 31.40% | 27.27% | −4.13pp | 46.3% → **46.3%** | `extractive` — **unchanged** |

**The three capabilities that moved are the three whose blocks were restored, and the two
that did not move are the two whose blocks `route` leaves alone.** IE and MR both use the
`extractive` block, which is what `ask: 'extractive'` had already given them; their
movements (−0.67pp, −4.13pp) are inside the run-to-run spread this arm has measured
(1.7–2.1pp on the aggregate, more on a 121-question capability).

MR's abstention count is the sharpest single number in the run: **56 of 121 before, 56 of
121 after.** A global ask moved four routes; this one moved none of the two it should not.

### 13.21.3 P1' and P3' hold; P2' holds as a control and fails as a prediction

| Prediction | Registered | Measured | Verdict |
| --- | --- | --- | --- |
| **P1'** TR abstention < 50% | from 69.3% | **35.4%** | **holds**, by 14.6 points of margin |
| **P2'** MR abstention < 35% | from 46.3% | **46.3%** | **fails as a prediction, holds as a control** |
| **P3'** ABS does not regress | ≥ 85% | **100.00%** | **holds**, and improved |

P2' was written with its own interpretation attached -- "MR is the internal control; a
movement here would mean something else moved with it" -- and the reading is that it did
not move at all. A prediction that is registered as a control and behaves as one is a
weaker claim than a prediction that is confirmed, and it is recorded that way rather than
scored as a success.

### 13.21.4 MR is the whole of what remains, and it is not a retrieval problem

| Capability | feature acc | baseline acc | `b✓f✗` |
| --- | --- | --- | --- |
| MR | 27.27% | **86.78%** | the bulk of the 107 |

MR's 56 abstentions all had at least one gold turn carried (`121/121` questions carry one),
and all 56 are the bare `INSUFFICIENT_EVIDENCE` token. Under the `route` ask MR keeps the
extractive block, which is the block it has always had -- so this is not a regression the
last two runs introduced. It is the arm's floor.

The reading that fits: the dataset's multi-session questions ask for a **count or a
comparison across sessions** ("how many days did I spend camping", "how many hours in
total did I spend driving to my three road trips"), and **no single turn contains the
answer**. The extractive block's closing line -- "if the evidence does not contain the
answer, reply exactly ..." -- is literally true on those questions, and the model takes it.

### 13.21.5 What this registers

**One variable: `ask: aggregate`**, the extractive block plus one sentence -- *"the answer
may require combining evidence from more than one turn or session: gather every relevant
piece first, then compute the answer. Do not reply INSUFFICIENT_EVIDENCE merely because no
single piece states the answer outright."*

It reaches exactly two routes (`multi-session`, `flat`) because those are the two whose
contract IS `extractive`; the other four keep their own block and are the control. That
targeting is the point: §13.20's lesson is that a global instruction moves four routes at
once, and three of the four are now working.

| Prediction | Reading | Falsified if |
| --- | --- | --- |
| **P1''** | MR's abstention rate falls **below 30%** (from 46.3%) and its accuracy rises **above 40%** (from 27.27%) | MR stays above 40% abstention, which would say the model's difficulty on these questions is not about the instruction |
| **P2''** | the four untouched routes **do not move** beyond the measured run-to-run spread: TR within ±3pp, KU within ±3pp, ABS ≥ 93%, IE within ±3pp | any of the four moves more than 3pp, which would mean the ask leaked past `ASK_ROUTES` |
| **P3''** | the aggregate delta rises **above +20pp** | the delta falls below +15pp, which would mean MR's repair was bought at a cost elsewhere |

**What P2'' is for.** §13.20 could not measure leakage because it changed every block; this
registration can, and the four routes are the instrument. A movement there is a defect in
`instructionsFor` rather than a result about the model.

### 13.21.6 Status

**Implemented, tested, and dispatched.** Gate: `pnpm check` exit 0, `test:tools` 303 passed
+ 31 subtests, cortex-eval 1,832 tests, cortex-memory **277** tests (8 new on the ask's
reach), 100% on all four coverage dimensions in both, census clean.

## 13.22 What run 38487229554 read, and the two defects in how it was read

Run `38487229554` completed all 13 steps in 3 h 37 m. It is the largest movement this arm
has produced, it moved the loss to a capability the ask does not reach, and reading it
exposed two defects of mine -- one in what the reach table means and one in how a
threshold had been written down. Both are repaired here, and the repair to the second is a
tool rather than a paragraph.

### 13.22.1 The headline, and the three runs it stands on

| Metric | `38394103193` | `38439899858` | `38487229554` |
| --- | --- | --- | --- |
| ask | `extractive` | `route` | `aggregate` |
| baseline / feature | 44.40% / 54.60% | 44.85% / 63.05% | 44.10% / **67.35%** |
| **Δ** | +9.25pp | +18.20pp | **+23.25pp** |
| McNemar p | 5.179e-3 | 2.737e-7 | **6.479e-12** |
| discordant `b✓f✗` / `b✗f✓` | 135 / 186 | 107 / 197 | **88 / 205** |
| abstention rate | 39.20% | 30.40% | **24.20%** |

The feature side now abstains on 121 of 500 and repairs 205 questions the reference
pipeline misses. Feature range across the four runs is 66.60% to 68.40%, so the point
estimate is 67.35% +/- 0.9pp and the Wilson interval is `[62.97%, 71.17%]`.

### 13.22.2 P1'' holds, P3'' holds, and P2'' fails for a reason that is mine

| Capability | feature acc | baseline acc | Δ | feature abstentions | gold carried ≥ 1 |
| --- | --- | --- | --- | --- | --- |
| IE | 88.00% | 0.67% | +87.33pp | 15 / 150 (10.0%) | 149 / 150 |
| MR | 44.63% | 87.60% | −42.98pp | **24 / 121 (19.8%)** | 121 / 121 |
| KU | 81.94% | 0.00% | +81.94pp | 2 / 72 (2.8%) | 72 / 72 |
| TR | 48.82% | 64.57% | −15.75pp | **51 / 127 (40.2%)** | 126 / 127 |
| ABS | 96.67% | 100.00% | −3.33pp | 29 / 30 (correct) | 30 / 30 |

* **P1'' holds.** MR's abstention rate fell from 46.3% to **19.8%** (registered: below 30%)
  and its accuracy rose from 27.27% to **44.63%** (registered: above 40%).
* **P3'' holds.** The delta is **+23.25pp**, above the registered +20pp.
* **P2'' fails as written.** It registered `±3pp` for four named routes; KU moved
  −4.17pp and IE moved +4.00pp. That is a defect in the threshold, and §13.22.4 derives
  it properly.

### 13.22.3 The reach table was the instrument, and the reading mis-mapped it

`ASK_ROUTES.aggregate` is `['multi-session', 'flat']` and the artifact printed exactly
that, under `Evidence ask reached: 2 route(s) — multi-session, flat`. The reading still
named **IE as one of the four untouched controls**, and IE is the flat route: the
benchmark dispatch sends only MR to `answerSessions`, TR to `answerTemporal`, ABS to
`answerAbstention`, knowledge-update to `answerKnowledgeUpdate` and
single-session-assistant to `answerAssistant`; **everything else falls through to
`answer`, which is the flat path**. So the ask reached IE, IE improved by 4.00pp, and the
one capability I had listed as a control while changing it was the one that moved.

**The instrument was right and the mapping was wrong**, and the difference matters because
the reach table is the only thing in the artifact that says which capabilities received the
treatment. The genuine controls for that run were TR, KU, ABS and the assistant route:
TR −0.79pp, KU −4.17pp, ABS −3.33pp (one question). The mapping is now pinned rather than
remembered -- `bench-memory-arm.test.ts` compares the arm's copy of the reach against the
product's own table for **every** ask, in both directions. The previous guard checked that
the table existed and that one entry of it disagreed with the arm in one direction, which
cannot notice a route added to or dropped from any of the others.

### 13.22.4 The control band was asserted, and three registrations in a row did that

The registered band was `±3pp`. On KU -- 72 questions at an observed 86.11% -- one
question is 1.39pp, so the band was 2.78pp wide against a binomial standard deviation of
**4.08pp**. It was 0.68 sd, which no measurement of that quantity can satisfy reliably, and
the prediction could not have held.

This is the third instance of one defect class:

| Registration | The term that was not derived | What it cost |
| --- | --- | --- |
| §13.17 P1 | `carried` undefined | two readings of one artifact, 99.6% and 10.8%, neither wrong |
| §13.20 P2' | a prediction registered as a control | outcome not scoreable in either direction |
| §13.21 P2'' | a band asserted, not derived | 0.68 sd on KU, so the prediction had to fail |

`tools/registration-power.mjs` is the repair: given `n` and the observed proportion it
prints the one-question granularity, the binomial sd, and the band at a chosen multiple,
and it says when a two-question band would be narrower than one sd. `tools/__tests__/
test_registration_power.py` pins its arithmetic by hand. The derived bands for this
registration are in §13.22.7.

### 13.22.5 A measurement defect the read exposed: emphasised declines were read as answers

`isAbstention`'s contract is that the **last non-blank line decides**, and the whole point
of that rule is that a model which writes a trace and then concludes is read by its
conclusion. `**INSUFFICIENT_EVIDENCE**` on that line is such a conclusion, and it was read
as an **answer**, because the comparison was against the raw line after only a label strip.
Run `38487229554` records five of them, all on the temporal route -- which is not an
accident: the temporal block is the one that asks the model to *show its work*, and a trace
followed by an emphasised conclusion is what that produces. Four were scored as wrong
answers and one as a correct answer.

The counterfactual is exact, because it is a property of stored outputs and needs no run:

| Reading | as measured | with the corrected parser |
| --- | --- | --- |
| abstentions | 121 / 500 = 24.2% | **126 / 500 = 25.2%** |
| accuracy | 336 / 500 = 67.20% | **335 / 500 = 67.00%** |
| TR abstentions | 51 / 127 = 40.2% | **56 / 127 = 44.1%** |
| delta | +23.25pp | **+22.90pp** |

The one-question cost is real and is registered rather than absorbed: `gpt4_76048e76`
answers `bike` correctly and then declines on its last line, and under a rule where the last
line decides it is a decline. The alternative -- reading a decorated token as a mention --
is the same defect from the other side, and the predicate's tests keep a decorated line that
is *not* the token (`**INSUFFICIENT_EVIDENCE** was the wrong call here`) as an answer.

The repair is a fixpoint reduction in `parse.ts`: a symmetric wrapper (`**`, `__`, `*`,
`_`, backticks, four quote shapes) and the label may nest either way round, so one ordered
pass cannot cover both. Twenty-one new tests, and defect injection -- reverting the call to
`stripLabel` -- fails 21 of them. The reference pipeline is unaffected: it has its own token
(`UNANSWERABLE`) and its own comparison, and the arm injects no parser into it, which is why
the counterfactual moves the feature side alone.

### 13.22.6 TR is the whole of what remains, and the declines say why

| Capability | feature | baseline | gap | abstentions | of those, bare token | trace then token |
| --- | --- | --- | --- | --- | --- | --- |
| TR | 48.82% | 64.57% | −15.75pp | 51 | 36 | **15** |
| MR | 44.63% | 87.60% | −42.98pp | 24 | 21 | 3 |

Fifty of TR's 51 abstentions had the gold turn carried, so this is not retrieval. And the
fifteen trace-then-token declines are diagnostic in a way a bare token is not -- they show
the model reaching the end of the reasoning and declining on a specific ground:

    ... but the evidence does not explicitly state the exact number of days.
    INSUFFICIENT_EVIDENCE

That is the same structural property under which the multi-session route was declining at
56 of 121 before `aggregate` reached it: the question asks for a duration, a difference or
an ordering **assembled from several turns** ("how many weeks ago did I meet up with my
aunt", "how many days passed between the day I cancelled my subscription and the day I
...", "what is the order of the three trips I took"), and no single turn states the answer.
The temporal block does not address it: it says to resolve relative expressions against the
question date and to show the resolved date, and its closing line concedes that the
evidence may not establish a date.

### 13.22.7 What this registers

**One variable: `ask: computed`** -- each reached route's own block with the merging
sentence inserted immediately above its closing line, reaching `multi-session`, `flat` and
`temporal`. On the two routes whose own block already IS the extractive one it is
**byte-identical to `aggregate`**, which is asserted in `evidence-ask-reach.test.ts` rather
than described, so the single variable between `38487229554` and this run is **what the
temporal route reads**.

It composes rather than substitutes because §13.20 measured substitution as destructive:
deleting the temporal block's date-resolution instruction cost TR 27.6 points and restoring
it returned 27.6. `abstention` is deliberately out of reach -- its block calls declining
"expected and is a valid outcome" and ABS's gold IS abstention -- and `knowledge-update` and
`assistant` keep their own blocks and are the controls.

Every other input is held at its §13.21 value, and the parse repair above is included in the
same run. The baselines below are therefore the **corrected** ones, so a movement is
attributable to the ask; the derivation of every band is the output of
`tools/registration-power.mjs` at 1.5 standard deviations, which is `±4.91pp` on 30
questions, `±6.11pp` on 72 and `±3.98pp` on 150 -- all far below the 27.56-point movement
this arm would have to leak to be mistaken for a result.

| Prediction | Baseline (corrected) | Target | Falsified if |
| --- | --- | --- | --- |
| **P1'''** | TR's declined count falls to **≤ 36 of 127** and its accuracy rises **above 58%** | 56 / 127 (44.1%); 48.82% | TR stays above 45 declines, which would say the instruction is not the lever for computed answers |
| **P2'''** | MR's declined count falls to **≤ 20 of 121** and its accuracy rises **above 48%** | 24 / 121 (19.8%); 44.63% | MR stays above 24 declines, which would say the sentence's reach has been exhausted |
| **P3'''** | the controls stay inside their derived bands: **KU ≥ 75.83%**, **ABS ≥ 91.76%**, **IE ≥ 84.02%** | 81.94%, 96.67%, 88.00% | any control falls outside its band, which is a defect in `instructionsFor` rather than a result about the model |
| **P4'''** | the delta rises **above +25pp** | +22.90pp | the delta falls below +20pp, which would mean TR's repair was bought elsewhere |

**What P1''' can still not distinguish.** TR's gold sessions span 22 to 72 turns and its
mean `carried / total` is 46.03% -- the lowest of the five capabilities -- so a TR
improvement is consistent with two mechanisms: the sentence, or the selection carrying
more of what a TR question needs. §13.22.8 records the control that separates them and this
run does not run it.

**What P3''' is for.** §13.20 could not measure leakage because it changed every block and
§13.21's instrument was mis-mapped (§13.22.3). This one has three controls with derived
bands and a machine-checked reach table, so a movement outside a band is a code defect with
a name rather than a finding.

### 13.22.8 What would still not be known afterwards

* **The sentence's placement** is an argument, not a measurement: it sits immediately above
  the line that licenses declining because that is where an exception belongs, and nothing
  here has been run against the alternative.
* **TR's selection** is not varied, so a TR movement cannot be separated from the
  selection until a no-signal control arm is run at this ask -- the P0 item §13.20.6 left
  open and this registration still leaves open.
* The standing items are unchanged and still registered: the line/turn unit (§13.16.6),
  `grounded` hard-coded `false`, the writer's reduced manifest not reaching the artifact,
  and the in-band marker's ambiguity.

### 13.22.9 Status

**Read, two defects repaired, registered, and dispatched.** Gate: `pnpm check` exit 0,
cortex-memory **308** tests (+39), cortex-eval **1,833** tests, 100% on all four coverage
dimensions in both, census clean, `test:tools` 310 passed + 31 subtests including the new
threshold tool's 7.

## 13.23 The §13.22 dispatch failed, and the failure found two defects beneath every layer it tests

Run `38520676669` ran for **three hours and eight minutes** and left one file:
`benchmark-error.log`, containing a progress line and a stack. Its own progress stream says
what it had already done:

    reference-pipeline run=0 q=500/500
    cortex-memory      run=0 q=500/500
    reference-pipeline run=1 q=500/500
    cortex-memory      run=1 q=500/500
    progress: died on cortex-memory run=1 q=500/500 id=778164c6

Two of the four repetitions had completed on both sides -- two thousand graded answers --
and the run died on `TypeError: terminated` from undici, a TLS socket closed under the
fetch, at the start of the third. **No prediction in §13.22 was read, and the run is not a
result about the model.** It is a result about the harness, and reading it found two
defects that every test in this repository had been passing over.

### 13.23.1 The durability repair covered the first repetition only

`partial-ablation.test.ts` exists because of run `37942775447`: ~40 minutes of grading ended
by the same `TypeError: terminated`, and the artifact held a stack and nothing else. Its
repair gives each side's **first** evaluation an answer sink and wraps a throw in
`attachPartial`, which hangs the measured vectors off the error so the failure path in
`bench/run-ablation.ts` can write them.

The loop that runs the remaining repetitions had **neither a sink nor a catch**:

    for (let i = 1; i < runs; i++) {
      const b = await evaluateWithScorer(dataset, baseline, scorer, options.onProgress, i);
      const f = await evaluateWithScorer(dataset, feature,  scorer, options.onProgress, i);
      ...
    }

So a failure at repetition `i > 0` left `runAblation` unwrapped, `error.partial` was
`undefined`, and the failure path wrote an error log and nothing else. That is the original
defect, one repetition later, and eight times as expensive: `ABLATION_RUNS` is 4, so three
of the four repetitions run through the loop that had no durability at all.

The repair is the same sink and the same wrap, per repetition. What the partial then means
is carried by the field the type already had: the repetitions are sequential, so `run: i`
states that repetitions `0..i-1` completed on both sides and the vectors are repetition
`i`'s, up to wherever it got. No aggregate is added -- the no-delta rule is unchanged.

**And the no-measurement rule changes with it.** `attachPartial` refuses to attach a
partial whose two vectors are empty, because such a partial is byte-identical to a broken
capture. That is an argument about repetition **0**, the only repetition with nothing before
it: at `run: i > 0` an empty pair is a statement -- *repetition i died before it measured
anything* -- and discarding it would lose the only durable record that the earlier
repetitions happened. The predicate now includes `run === 0`, and the boundary is asserted
in both polarities.

### 13.23.2 The accounting could not see the call that mattered

`retryableFetchWithStats` records its counters through `withResponse`, which is reached only
on a path that **has** a response. The exhaustion path throws `lastError` without passing
through it, so a call that failed on every attempt was **absent** from the aggregate: the
counters described the calls that recovered and not the one that did not, which is backwards
for the only reading they are ever consulted for.

The second half is what the error carried. `TypeError: terminated` names no endpoint, no
provider and no attempt count, so the question that decides the response to an
infrastructure failure -- *transient and survived six attempts, or one abort from somewhere
the loop does not wrap* -- had no answer anywhere in the record. Three runs have now been
destroyed by this class (`37942775447`, `38003036421`, `38520676669`) and each time the log
was sufficient to name the error and insufficient to act on it.

Two repairs, both shaped by the same argument `attachPartial` makes: the diagnostic is
attached to the error rather than wrapped around it, because the stack that names
`Fetch.onAborted` is the only evidence that a loss was infrastructure rather than a defect
in the arm (`§13.11.7`).

* **`RetryExhaustion`** -- the url, the attempts issued, the retries performed, the 429s
  among them, the elapsed time and the transport message -- attached as `retryExhausted`.
  The parameter is an `Error` and there is no guard, because the loop converts a primitive
  throw one line above, so an `unknown` arm would be unreachable code that reads as a safety
  net; branch coverage would have been the thing to find it.
* **`RetryStatsAggregate.recordExhausted`**, so an exhausted call is counted. That needs a
  field: an exhausted call that never retried is **not clean** -- it did not complete -- and
  counting it as clean would let a run whose traffic was failing outright report a higher
  share of untroubled calls than a healthy one. Hence `exhaustedCalls`, and the identity
  `cleanCalls + retriedCalls + exhaustedCalls === calls`, which is asserted rather than
  intended. After that change the predicate is `retried === 0 && !exhausted`, because the
  three classes must partition the sample.

`bench/run-ablation.ts` prints both on the failure path: the exhausted call, and the
process-wide accounting, so a reader can tell a single cut connection from the last of many.

### 13.23.3 What this changes about §13.22, and what it does not

**Nothing in the measurement.** The repairs touch durability, accounting and one error
field; no prompt, no gate, no selection and no parse is different, so a re-dispatch is the
same experiment §13.22 registered. Its four predictions stand exactly as written, including
the corrected baselines the parse repair produces.

**What the lost run would have added** is not readable from its log: two repetitions of
aggregate statistics per system exist nowhere, because the answers were only ever in the
process. The re-dispatch buys them again, which is the cost of the defect rather than of
the experiment.

The failed run is the first look at repetition-level behaviour in this arm that does not
come from a completed artifact, and it is unusable for the purpose: the progress stream
names the questions and not the correctness, and a partial carries answers rather than
rates, deliberately -- a rate over a shortened vector is a number about the denominator
rather than about the system.

### 13.23.4 Status

**Two defects repaired, both proved by defect injection, and §13.22 re-dispatched
unchanged.** Gate: `pnpm check` exit 0, `test:tools` 310 passed + 31 subtests, census clean,
cortex-llm **146** tests (+8), cortex-eval **1,838** (+5), cortex-memory 308, 100% on all
four coverage dimensions in every package that gates on them, prettier clean. Dropping the
feature-side wrap fails 2 of the new tests and dropping the exhausted-call record fails 1.

## 13.24 The §13.22 measurement is blocked by an external condition, and here it is in the provider's own words

The re-dispatch (`38566578567`, §13.23) died too, and this time the record named both the
stage and the reason. It is not a defect in the arm, and it is not the transport fault
§13.23 repaired. **The embedding account has no credit.**

### 13.24.1 The reading

    Embedding backend: openai-compatible (model=embedding-3, dimensions=1024)
    progress: no question was started before the failure
    Error: Embedding request failed: 429 Too Many Requests —
      {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
        at OpenAIEmbedding.embed (packages/cortex-llm/src/embedding/openai.ts:61:13)
        at async embedManyCached (retrieval.ts:256)
        at async buildTurnIndex (retrieval.ts:397)
        at async retrieveTopKByQueries (retrieval.ts:981)
        at async buildRetrievalRelevanceIndex (relevance-index.ts:169)
        at async main (bench/run-ablation.ts:233)

`余额不足或无可用资源包,请充值` is the provider's own message and it is not ambiguous:
insufficient balance, no available resource package, please top up. The stage matters as
much as the message — the stack is entirely inside the **relevance index's** construction,
so **not one question was graded.** The run spent thirty minutes embedding and produced
nothing at all.

**And it is not the same failure as the one before it.** `38520676669` died on
`TypeError: terminated` after three hours and eight minutes, in the middle of repetition 2.
A socket abort and a billing refusal are different events with different remedies; what the
two have in common is that both runs needed the embedding provider, and both produced no
number. Whether the first was *caused* by the second cannot be settled from the record, and
this section does not claim it.

### 13.24.2 Three repairs, and the one measurement each is for

**The preflight.** `preflightEmbedding(embedding)` asks for **one** vector of one short
constant text before anything that takes time, and returns a verdict rather than throwing:
a refusal is a condition to act on and a crash is a defect to fix, and the two want
opposite readings. The message is the provider's own words, verbatim, because `429 Too Many
Requests` alone reads as a rate limit — something you wait out — and this condition is the
opposite of that. `ok` also requires the returned vector to be the declared dimension,
because reachable and usable are different claims.

*What it cannot do, stated because the honest scope matters more than the feature: it
cannot prevent a balance running out mid-run. In `38566578567` about nine thousand five
hundred requests were served before the provider began refusing, so an account funded at
`t=0` was empty at `t=30m`. The claim is narrow — every dispatch learns for one request
what the run would otherwise learn for a run.*

**The artifact now says which backend produced its numbers.** `MemoryArmConfig.embedding`
carries `provider`, `model`, `dimensions` and whether the preflight was run, rendered on
the config line. Until now the only statement of the backend was a line on the runner's
stdout, which no artifact carries, and `createEmbeddingWithProvenanceFromEnv` falls back
**silently** to a 256-dimension hash embedding when no credential is present — so a run
graded against the fallback and a run graded against Zhipu at 1024 dimensions each produce
a complete, internally consistent report. This closes the item that has been pending as
roadmap item 17.

**The embedding cache is no longer thrown away.** Both failed runs ended with

    Failed to save: Unable to reserve cache with key longmemeval-embedding-<hash>,
    another job may be creating this cache.

because the save step re-used the exact key the restore step had requested, so two runs
writing one key contended and the loser's vectors were discarded. That is the opposite of
what the failure path does deliberately — `persistArmEmbeddingCache` runs on the way out
precisely because a run that dies has still paid for its embeddings. The save key now
carries `github.run_id` and the restore matches on the dataset-hash prefix, so the cache is
written by every run and read by the next, and the two workflows still resolve to one
vector set.

### 13.24.3 The probe, and what it verifies

The repairs were verified by dispatching one run **deliberately** against the blocked
account, on the reasoning that either outcome is informative: if the account is still empty
the run fails in seconds and proves the guard, and if it has been topped up the run is the
measurement §13.22 registered. Run `38582212737` failed in under two minutes, and its log
is the verification:

    Embedding backend: openai-compatible (model=embedding-3, dimensions=1024)
    === transport retry accounting (process-wide) ===
    {"attempts":6,"retried":5,"rateLimited":6,"retryAfterHonoured":0,
     "calls":1,"retriedCalls":1,"cleanCalls":0,"exhaustedCalls":0,"retryRate":1}
    Error: embedding preflight failed against openai-compatible (model=embedding-3):
      Embedding request failed: 429 Too Many Requests — {"error":{...,"余额不足..."}}
        at main (bench/run-ablation.ts:195:11)

Four things, each of which was a defect an hour earlier:

* **`calls: 1`.** The same condition that cost nine thousand five hundred and eighty-nine
  provider calls and thirty minutes now costs **one**. The attempts counter reads `6`
  because one call retried five times, and `rateLimited: 6` says all six attempts were
  refused — which is the accounting read correctly rather than approximately.
* **`cleanCalls: 0`.** The call is not reported as untroubled. This is the field §13.23
  added, doing the job it was added for.
* **The stack names the preflight**, so a reader can tell "the check refused" from "the run
  died in the middle of its work".
* **`Save embedding cache` succeeded**, under the run-unique key
  `longmemeval-embedding-<hash>-38582212737`. The two runs before it both failed that step.

### 13.24.4 Status: blocked, and on what

**The §13.22 measurement cannot be produced until the embedding provider serves requests.**
No code change reaches that: the account needs credit, or the campaign needs a different
embedding backend.

Three facts bound the options, and all three are measured rather than assumed:

1. **The offline fallback is not usable for these measurements.** The only non-remote
   backend the factory builds is `HashEmbedding` — 256 dimensions, not a semantic model —
   so the relevance index would score turns by hash geometry. A run against it would
   produce a complete report about a different experiment, which is exactly why the new
   artifact field names the backend.
2. **A different provider needs no code, only an environment.** The factory reads
   `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY` and `EMBEDDING_DIMENSIONS`
   for any openai-compatible endpoint, so pointing the campaign at another provider is a
   secret plus three `env:` lines in the workflow. It is **not** wired here, because a
   backend switch re-embeds both sides of every comparison and is therefore a
   registration rather than a knob: the four archived runs would stop being comparable
   with anything that follows, while the *delta within* a run stays valid because both
   sides share one vector set.
3. **The archived numbers are intact.** `38250133116`, `38394103193`, `38439899858` and
   `38487229554` were all produced against Zhipu `embedding-3` at 1024 dimensions before the
   account ran out, and §13.20's and §13.21's readings stand on them. What is missing is one
   measurement, not the record of the previous four.

### 13.24.5 What is being advanced while the line is blocked

Two items on the standing list need no provider at all, and they are the ones this
iteration's remaining effort goes to: the **line/turn unit defect** (`§13.16.6`), which is
an instrument defect in the artifact every future run will produce, and the **no-signal
control** (`§13.22.8`), whose *dispatch* is blocked but whose design is not.

## 13.25 The capture counts the turns the reader was shown, and §13.16.6 is closed

§13.16.6 registered an instrument defect and deliberately did not repair it: repairing it in
the same change as the offer would have left two changes to one measurement and no way to
attribute either. This section makes the repair on its own, and it is the first work in this
campaign that needs no embedding provider at all. Commit `01d72d1` (local) / `6c2de8f1`
(remote), 17 files.

### 13.25.1 The repair is at the capture, and the boundary is never re-encoded

The capture held `assembled.carried.map((turn) => turn.content).join('\n')` — one string —
and every reader split it back on the same newline. The round trip is lossy in **one
direction only**: the split cannot tell a turn whose content spans newlines from several
turns, so the repair cannot be a cleverer split.

Three alternatives were rejected because each substitutes one implicit encoding for another
on content that is model-generated free text:

1. **A sentinel separator.** No sentinel can be shown to be absent from turn content, so a
   collision fails silently and in a data-dependent way.
2. **A quoted or percent-encoded form.** The same objection with more moving parts, and it
   makes the artifact's evidence a transformation of what the model read rather than what it
   read.
3. **One logical turn per `carried` entry with the boundary recorded elsewhere.** That is the
   repaired design with an extra hop, and it pays objection (2)'s cost.

`AssembledPrompt.carried` is the assembler's own list and it is in hand at the moment of
capture, so the only representation that keeps the boundary is the one that never destroyed
it. `lastRetrievedContext()` now returns that list, and `AdmittedEvidence.turns` is the
admission layer's own list length — measured arithmetically rather than by joining 500k
characters to call `.length`.

### 13.25.2 The unit is now a property of the producing capture, and the two producers differ

`QuestionRecordInput.retrieved` is a list of the units its producer reports. Two producers
write records, and after this change they do not report the same unit:

| Producer | Unit | Why |
| --- | --- | --- |
| `bench-memory-arm` | **turn** | The capture is `AssembledPrompt.carried`, a turn list |
| `buildRecordsFromDataset` | **line** | `DecisionTrace.retrieved` is a rendered string: `expandContextWindow*` returns text and the same text feeds the answer prompts |

The second is stated rather than hidden, because it was already the case and `respondWith`
already records the reason — "`retrieved` has already been through session completion and
truncation, so a newline in it is not a turn boundary". What is new is that the field can no
longer be read as if the two producers agreed.

The consequence for the trace product is registered rather than papered over:
`buildRecordsFromDataset` no longer reports `goldOverlap`, because a membership test over line
units would report a covered gold as uncovered whenever the gold turn spans a line, and a
wrong number is worse than an absent one (§13.11.2's rule). Both readers of that product
(`read-b7-criterion.mjs`, `quantify-endpoint-noise.mjs`) forward the field and neither decides
anything with it; the B7 criterion clusters over `turns`. Restoring it means giving the trace
the turn list `respondWith` already receives, which reaches `retrieveTurns`' two prompt
consumers and is therefore a separate registered change.

### 13.25.3 `goldOverlapOf` loses its haystack

The gold measurement asks whether a **gold turn** is one of the units the reader received. It
searched `'\n' + retrieved + '\n'` for `'\n' + turn + '\n'` — a padded substring search whose
padding existed only to reconstruct that statement from a joined string, and which rested on
turns being separated by exactly one newline.

With the units in hand the test is the statement itself: `retrieved.includes(gold)`. The same
class of defect as §13.18.2's answer-text search, and it cannot recur here, because a bare
substring search is not expressible against a list of units.

### 13.25.4 Verification

- `pnpm check` exit 0. cortex-eval **1,851** tests, cortex-memory **317**, all four coverage
  dimensions **100%** in both; `tools` 314 passed + 31 subtests; census clean.
- **Defect injection, two injections, both caught.** Re-joining the capture in `memory.ts`
  fails **15 tests across 3 files** — every test of the new contract plus the two pre-existing
  roster/order tests. Reverting the gold predicate to
  `retrieved.some((unit) => unit.includes(gold))` — a substring search wearing the repaired
  shape — fails exactly the three tests written for it: the prefix case, the list-marker
  counterexample, and the arm-level membership test.
- Every new assertion is behavioural: it reads what a call returns, not source text (§37's
  escape).

### 13.25.5 What the archived counts are, in the repaired unit

The four archived artifacts were produced before this change and their evidence vector is the
old joined string. **Their accuracy and abstention readings are unaffected** — the ask
experiment measures answers, and the ratio arguments in §13.13–§13.16 hold on either unit
because both sides of each ratio are in the same one. What changes is every absolute count
that says "turns":

- §13.16.6 measured **6.6 lines per turn** on this data;
- §13.13's "~165 turns" is ~165 lines, about **25 turns**;
- the offer's `3,016–4,528` and the delivery's median `141` are lines on that scale.

The four archived runs are not re-read here, because the numbers their verdicts rest on —
§13.20's `+18.20pp` and §13.21's `+23.25pp` — are deltas in answers.

### 13.25.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read run `38595325261` (`ask: computed`) against §13.21's predictions | no (in flight) |
| P1 | Give `DecisionTrace` the turn list `respondWith` already receives, restoring that product's `goldOverlap` | no |
| P1 | Design the **no-signal control** (§13.22.8) separating the merging sentence from the selection | no (dispatch later) |
| P2 | `grounded` is still hard-coded `false`; the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

## 13.26 `computed` returns +25.75pp, and TR stops being a significant loss

Run `38595325261`, dispatched at `5ac30ee0` (before the §13.16.6 repair), 500 questions,
4 repetitions, temperature 0. Artifact id `11923457465`. Everything below is read from
`benchmark-cortex-memory-ablation-report.json`; nothing is inferred from the log.

### 13.26.1 The judgement, against the registration §13.21 wrote before the number existed

| Registered | Required | Measured | Verdict |
| --- | --- | --- | --- |
| Point estimate beats the same dispatch's baseline | Δ > 0 | **+25.75pp** | holds |
| McNemar, two-sided, overall | p < 0.05 | **1.064e-13** | holds |
| Full N, four runs, temperature 0 | 500 × 4 | 500 × 4 | holds |
| One dispatch, no peeking | — | one dispatch | holds |

`ask: computed` reaches **3 routes** (`multi-session`, `flat`, `temporal`) against
`aggregate`'s 2, which is the design: it composes the merging sentence into each reached
route's own block rather than substituting one, and on the two routes whose block already
IS the extractive one the result is byte-identical to `aggregate` (asserted in
`evidence-ask-reach.test.ts`).

### 13.26.2 The control band: three capabilities could not have moved

Only the temporal route's instruction changed. `multi-session`, `flat`, `knowledge-update`,
`abstention` and `assistant` are byte-identical to the `aggregate` run, so any movement on
IE, MR, KU and ABS between the two runs is noise by construction. That makes them a control
band, which is the thing §13.22 lacked:

| Capability | Route touched | aggregate | computed | Δ questions |
| --- | --- | --- | --- | --- |
| IE | no | 132/150 | 133/150 | **+1** |
| MR | no | 54/121 | 51/121 | **−3** |
| KU | no | 59/72 | 62/72 | **+3** |
| ABS | no | 29/30 | 29/30 | **0** |
| **control total** | | **274/373** | **275/373** | **+1** |
| **TR** | **yes** | 62/127 | **72/127** | **+10** |

Two readings come out of this, and both are needed:

1. **The control band's net movement is +1 question over 373.** The endpoint is not drifting
   globally, so the run-to-run noise floor on an aggregate figure is small.
2. **Per-capability movement inside the band reaches ±3 questions** (MR −3, KU +3, in
   opposite directions on disjoint question sets). A single capability is the unit that
   matters here, and its noise reaches 3 questions.

TR moved **+10 questions**. That is above the largest band movement observed, in the one
capability whose prompt changed, in the direction the instruction was written to move it.

### 13.26.3 TR is no longer a significant loss

| | aggregate `38487229554` | computed `38595325261` |
| --- | --- | --- |
| TR accuracy | 48.82% | **56.69%** |
| TR b✓f✗ / b✗f✓ | 30 / 10 | 23 / 11 |
| TR McNemar p | **2.221e-3** (significant) | **5.761e-2** (not significant) |

§13.21 left TR as a **significant** net loss. It is now statistically indistinguishable from
the reference pipeline on that capability — the first time that has been true in this
campaign — while remaining numerically below it. That is a durable improvement under the
registered reading, and it is exactly the movement `computed` was registered to produce.

The `ask` axis' full arc, on the feature side's abstention rate and delta:

| run | ask | reached | Δ | abstention |
| --- | --- | --- | --- | --- |
| `38250133116` | extractive | 6 | +10.30pp | 38.00% |
| `38394103193` | extractive | 6 | +9.25pp | 39.20% |
| `38439899858` | route | 6 | +18.20pp | 30.40% |
| `38487229554` | aggregate | 2 | +23.25pp | 24.20% |
| **`38595325261`** | **computed** | **3** | **+25.75pp** | **20.60%** |

### 13.26.4 Where the remaining loss is, and it is one capability

| Capability | n | feature | baseline | b✓f✗ | b✗f✓ | net | McNemar p |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IE | 150 | 88.67% | 1.33% | 0 | 131 | +131 | 7.347e-40 |
| **MR** | **121** | **42.15%** | **86.78%** | **59** | **5** | **−54** | **9.003e-13** |
| KU | 72 | 86.11% | 0.00% | 0 | 62 | +62 | 4.337e-19 |
| TR | 127 | 56.69% | 66.14% | 23 | 11 | −12 | 5.761e-2 |
| ABS | 30 | 96.67% | 100.00% | 1 | 0 | −1 | 1.000e+0 |

**MR is now the only capability where the feature side loses significantly**, and it is a
large loss: 54 net questions. The arm's aggregate win comes from IE and KU, where the
reference pipeline answers essentially nothing correctly (1.33% and 0.00%).

The shape of MR's 70 non-correct questions, classified from the artifact:

| Failure shape | Count | What it means |
| --- | --- | --- |
| `numeric_mismatch` — both sides carry a number and they differ | **31** | The model counted or compared and got a different value |
| `other` | 7 | Neither numeric nor recognisably a refusal |
| `plan_output` — output opens with "Let me gather…" / "Step 1" | 4 | The model narrated its plan instead of answering |
| `soft_refusal` — "I don't have enough information" | 2 | The model declined in prose, so it is not counted as an abstention |
| `long_prose` — answer is 200+ characters of reasoning | 2 | The answer, if present, is buried |
| abstention (bare `INSUFFICIENT_EVIDENCE`) | 24 | Machine-readable decline |

### 13.26.5 The mechanism, measured: coverage is the variable

The artifact carries `goldOverlap` per question, and this run is the first whose unit repair
is not yet in the code — so the coverage number is the same measurement §13.16.6 registered,
not a new one. Grouping by outcome:

| Capability | correct | wrong | abstained |
| --- | --- | --- | --- |
| MR | **0.587** | 0.470 | 0.451 |
| TR | **0.579** | 0.407 | 0.342 |
| IE | **0.793** | — | 0.574 |

And for MR, bucketed:

| gold coverage (carried/total) | n | correct | accuracy |
| --- | --- | --- | --- |
| [0.00, 0.25) | 14 | 2 | **14.3%** |
| [0.25, 0.45) | 33 | 11 | 33.3% |
| [0.45, 0.65) | 41 | 17 | 41.5% |
| [0.65, 0.85) | 24 | 16 | **66.7%** |
| [0.85, 1.01) | 9 | 5 | 55.6% |

The relation is monotone across the four buckets that carry weight (the last has 9 questions
and is the one inversion). **Accuracy tracks how much of the answer session the reader was
shown**, and the levels are low: MR's carried count has a **median of 14 against a median
total of 24**, i.e. **58%**.

The `relevance: retrieval` signal ranks **turns**, and a multi-session question's answer is
smeared across a whole session. A turn-level ranking spends its budget on the highest-scoring
turns wherever they live, which scatters each answer session across the budget rather than
completing it. The reference pipeline does the opposite: `expandContextWindowBySession`
**completes the session behind each hit** before spending anything on neighbours, and it
scores 86.78% on MR.

### 13.26.6 What §13.26 does not claim

- **The +2.50pp over `aggregate` is not all TR.** TR supplies +10 questions of it; the
  control band supplies +1 and the interval between the two runs' aggregates is 2.5pp of
  500, i.e. ~13 questions, of which TR is 10. Stated so the increment is not read as larger
  than TR.
- **MR's −3 questions between the two runs is noise, not a regression.** Its prompt did not
  change. What §13.26 records about MR is the **level** (42.15%) and its shape, not a
  movement.
- **The failure classifier is mine, not the artifact's.** It is a reading of `rawOutput` and
  `answer`, run over the artifact, using the four patterns named in the table. It is reported
  as a reading, and §13.27 registers the mechanism it implies rather than this classifier.

## 13.27 The selection unit becomes the session, and what that is registered to move

§13.26.5 measures the mechanism: coverage of the answer session is monotone in accuracy, and
the current signal does not deliver it because it ranks turns.

**Registered before dispatch**: one dispatch of the same configuration as `38595325261`, with
a single variable changed — the relevance signal's **unit**.

| Field | Value | Note |
| --- | --- | --- |
| `cortex_memory_ask` | `computed` | held at §13.26's value, so a movement is not the instruction |
| `cortex_memory_relevance` | `retrieval` | held — **corrected by §13.31.4**: this row was written as `retrieval-session`, a value that was never implemented or dispatched, so the variable it described could not be read from the archive at all |
| `cortex_memory_relevance_units` | **`session`** | the variable; the field the implementation and the artifact both carry |
| `cortex_memory_relevance_top_k` | `64` | held |
| `cortex_memory_evidence_turns` | `256` | held |
| everything else | §13.26's values | held |

**What the new value does.** It ranks **sessions** by their best-scoring turn, and then admits
the highest-ranked sessions **whole** — the same preference `expandContextWindowBySession`
expresses, but ordered by the arm's own bi-encoder over the question instead of by the hit
list's arrival order. The signal still reads the question text and the context and never the
answer key: `relevance-index.ts` has no ground-truth parameter, and the new unit is a
grouping of the same cases, not access to more information.

**Predictions, in the order they would be read:**

1. **The gold session coverage rises.** MR's median `carried/total` moves from **0.58** to at
   least **0.75**. This is the primary prediction: if the unit is the mechanism, the
   coverage distribution moves first and by more than the accuracy does.
2. **MR accuracy rises** and the arm's delta exceeds **+25.75pp**. MR is where the loss is.
3. **TR does not fall back below its §13.26 level.** TR's answer is often a single turn and a
   session-completing budget could crowd it out; if TR regresses while MR improves, the two
   capabilities want different units and that is the finding.
4. **IE and KU do not move beyond the control band.** They are not multi-session. If they
   move, the budget they share with MR moved and the change is not confined to the unit.

**Falsifiers, stated before the number exists:**

- Median MR coverage does not rise above 0.65 while MR accuracy is unchanged → the coverage
  reading is correlational, not causal, and §13.26.5 does not name the mechanism.
- MR rises but TR falls by a comparable number → the arm is trading one capability for
  another under a shared budget, and the honest statement is that the budget is the binding
  constraint rather than the unit.
- Coverage rises and accuracy **falls** → the extra turns are diluting the reader, which
  would refute the direction `§13.22.8`'s no-signal control was written to separate.

**Stopping rule.** One dispatch, no peeking, no redraw. The point estimate must exceed the
BASELINE side of the same dispatch, McNemar p < 0.05 two-sided, full N = 500, 4 runs,
temperature 0 — the same instrument as §13.21 and §13.26, so the three are comparable.

### 13.27.1 Status: implemented, registered, dispatched

Commit `abbf694` (local) / `987d3376` (remote). Run **`38659495034`**, dispatched at that
commit with `cortex_memory_relevance_units: session` and every other input held at
§13.26's values.

What landed, and where the decisions are stated once:

| Piece | Where | Why it is there |
| --- | --- | --- |
| `RelevanceUnits`, `PromptOptions.relevanceUnits` | `cortex-memory/src/prompt.ts` | The unit is a second field rather than a second signal value, so a run that changed only the unit is not reportable as one that changed the scoring |
| `EvidencePlan.sessionOf` | same | The selection needs the boundary; `render` does not, because it closes over the sessions and decides membership by identity |
| `selectBySession` | same | Largest session **prefix**, no skipping: skipping would make the carried set depend on the sizes of sessions the signal did not choose |
| `CortexMemoryOptions.relevanceUnits` | `cortex-memory/src/types.ts` | Reaches the multi-session route alone, which is what makes this dispatch single-variable |
| `CORTEX_MEMORY_RELEVANCE_UNITS`, `relevanceUnits` | `cortex-eval/src/bench-memory-arm.ts` | Rejected rather than defaulted on an unknown value, so a run that did not apply the treatment cannot publish as one that did |
| The artifact's config line | `cortex-eval/src/report.ts` | The field is what §13.27's artifact is compared against §13.26's by |
| §10.3's registration of the value | this document, §10.3 | `test_preregistration_config.py` compares the dispatch against it, which is the guard that caught the omission when the key was first added |

Verification:

- `pnpm check` exit 0. cortex-eval **1,851**, cortex-memory **322**, all four coverage
  dimensions **100%** in both; `tools` 314 passed + 33 subtests; census clean.
- **Defect injection, two injections, both caught.** Removing the session branch from
  `fitToBudget` fails the two tests written for the unit (`admits the top session whole`
  and `keeps the rendered order chronological`). A plan whose `sessionOf` is empty -- so
  every turn looks like one session -- fails the same two.
- The tests assert **membership rather than exact lists**, because the room left for
  evidence depends on the instruction block's length: the properties hold across a band of
  four to six turns' worth of room, and stating them as membership keeps them true across
  that band instead of pinning an instruction block's character count.

## 13.28 The §13.27 dispatch failed, and the failure showed what a failure record was missing

Run `38659495034` ran for **1h49m** and died in the **reference pipeline's first question**.
Its entire durable record was:

```
progress: died on reference-pipeline run=0 q=1/500 id=e47becba

TimeoutError: The operation was aborted due to timeout
```

The artifact it uploaded is 362 bytes of that text. No report, no partial vector, no count of
how far the pass got.

### 13.28.1 What the record could not say, and why each one matters

| Missing fact | What a reader could conclude | What the two possibilities want |
| --- | --- | --- |
| How long the pass had been running | `q=1/500` is what a pass that died **immediately** would also print | a hang is retried or circuited; a slow pass is given a longer budget or a smaller sample |
| Whether the retry ladder was exhausted | not printed anywhere on the failure path | an endpoint that was **down** and one that was **throttling** are different providers' problems |

The first had to be reconstructed from the workflow's `created_at`/`completed_at`, which is a
fact about the runner rather than about the failure. The second existed -- the entry point
prints `retryStats()` and the `RetryExhaustion` to **stderr** -- but stderr is collected into
the job log, which is **not** the durable artifact, and the artifact is what a later reader
has. `37281155088` (52 minutes, a stack trace and nothing else) and `37942775447` are the same
class; this is the third run it has cost.

### 13.28.2 The repair, and why it is a module rather than four more lines

Two additions, both in `cortex-eval`:

1. **`BenchmarkProgress.elapsedMs`** -- measured monotonically once per pass, so a question's
   cost is exactly `events[i + 1].elapsedMs - events[i].elapsedMs`. This is why the field is
   on the **pass** and not computed per question: the callback fires before its question is
   answered, so the gap between consecutive events **is** the cost, with no extra state.
2. **`describeFailure({ progress, error })`** -- the block the entry point writes, with the
   duration in milliseconds and seconds and, when the error carries one, a `retry:` line
   summarising `attempts` / `retried` / `rateLimited` / `elapsedMs` / `url`.

The second is a module with tests rather than four more lines in `bench/run-ablation.ts`, and
that is the whole argument: the two earlier repairs of this class changed the entry point, and
an entry point is a layer no test reaches -- which is why they changed nothing. The summary is
pure, takes its inputs explicitly, and is asserted against a **real** progress event.

Two choices worth stating:

- **The exhaustion is read structurally**, by field name, off an `unknown`. `RetryExhaustion`
  is `cortex-llm`'s type and `cortex-eval` sits below that package; importing it would make the
  harness depend on one adapter, which is the arrangement every provider-agnostic layer here
  exists to prevent. `attempts` is required for the line to print and the rest are optional,
  because an annotation without it is not a summary of a retry ladder.
- **The `cause` chain is walked, with a bound**, because wrapping is normal and a top-level
  read would report the missing fact for exactly the deepest failures. The bound is 8, and a
  test holds it with a self-referential chain: the failure path is the one path that must
  always finish.

### 13.28.3 Verification

- `pnpm check` exit 0. cortex-eval **1,866** tests and cortex-memory **324**, all four coverage
  dimensions **100%** in both; `tools` 314 + 33 subtests; census clean.
- **Defect injection, two injections, both caught.** Pinning `elapsedMs` to `0` fails
  `advances by what each question cost`; dropping the duration from `describeFailure` fails
  `reports how long the pass had been running`.
- Both new files reached 100% on all four dimensions only after the tests were extended. The
  first pass left `bench-failure.ts` at 96.36/82.14 and `bench-memory-arm.ts` at 97.2, and the
  uncovered branches were the ones the fixes exist for: the omit-empty-fields path, the
  bounded-cause path, the unit-rejection path and the unit's own config-line rendering.

### 13.28.4 Status

**§13.27 was re-dispatched unchanged** as run **`38725510400`** -- same configuration, same
registration. The failure was the provider's and not the configuration's, so the registered
experiment stands and no variable moves. What the new run has that the last one did not is a
failure record that says how long it had been failing.

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read `38725510400` against §13.27's four predictions | no (in flight) |
| P1 | Give `DecisionTrace` the turn list `respondWith` already receives, restoring that product's `goldOverlap` | no |
| P1 | Design the **no-signal control** (§13.22.8) | no (dispatch later) |
| P2 | `grounded` is still hard-coded `false`; the writer's reduced manifest is not uploaded; `cortex-node` branch coverage is **98.64%** — the two branches its own suite could not reach are now covered, and the one that remains is v8's `finally` arm, a reporting convention rather than an uncovered path (see §13.29) | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

## 13.29 The one dimension below 100%, and why it is left there

`cortex-node` was the only package in the repository whose branch coverage sat below 100%,
at **98.61%**. Two of its uncovered branches were reachable and are now covered; the third is
not, and the argument for leaving it is the interesting part.

### 13.29.1 What was covered

| Branch | Why it was uncovered | What the test asserts |
| --- | --- | --- |
| `query({ offset, limit })` | The SQLite adapter's suite reaches it; the Postgres one only ever queried without a page | **Parity**, not a branch count: the two adapters must agree on what a page is, or a system moved from one to the other reads different rows for the same query and the difference looks like a change in what was stored |
| A transaction body that throws | Every transaction test in that suite succeeds | The **contract**: the error propagates and the connection returns to the pool — deliberately not the rollback's *effect*, because `pg-mem` does not implement ACID rollback (already recorded in that file), so asserting the effect would assert `pg-mem` rather than the adapter |

### 13.29.2 What is left, and why

`PgStorage.transaction`'s `finally` arm is reported by v8 with a count of **zero**, and that is
a reporting convention rather than an uncovered path: `finally` runs on every exit.

The repair that would move the number is to release the client on both paths instead of in
`finally`:

```ts
try { … client.release(); return result; }
catch (err) { await client.query('ROLLBACK'); client.release(); throw err; }
```

which is **wrong**: if the `ROLLBACK` itself throws, the release never runs and the connection
leaks out of the pool. A percentage point is not worth an error-handling shape that fails
precisely when the database is already unhappy, and the alternative — `/* v8 ignore */` — is
not used in this repository by policy, because it silences a measurement rather than
correcting one.

## 13.30 The §13.27 re-dispatch hung for five hours and left nothing, so the pass gets a ceiling

Run `38725510400` never ended. It sat inside the **reference pipeline's first question** for
**over five hours** and the workflow's job-level `timeout-minutes: 240` did not fire, so:

| | run `38659495034` | run `38725510400` |
| --- | --- | --- |
| How it ended | `TimeoutError` after 1h49m | never |
| Durable record | 362 bytes: progress + message | **none** |
| What §13.28's repair contributes | the elapsed time and a `retry:` line | **nothing — `catch` is never reached** |

That is the sequence worth recording: §13.28 made a **failure** say more, and the very next
dispatch failed in a way that produces no failure at all. A hang does not reach `catch`, does
not write `benchmark-error.log`, and does not upload an artifact.

### 13.30.1 The repair, and why the ceiling lives in the pass

`runBenchmark` takes a per-pass wall-clock ceiling and throws `BenchmarkBudgetExceeded` from
inside the loop, between questions. Three properties, each a decision:

1. **It is enforced between questions, not inside a request.** It cannot interrupt a call
   already in flight, and it does not pretend to — `cortex-llm`'s per-attempt timeout is what
   bounds one request. What it guarantees is that the **pass ends**, which is exactly what
   failed here.
2. **The error carries the question it stopped before.** So the entry point's existing
   `catch` writes the same record a thrown failure does — now with the elapsed time §13.28
   added, which is the pair of facts that were missing on the two previous failures.
3. **It is a run option, not a field of `memoryArmConfig`.** The config is what the numbers
   are conditioned on and it is serialized into the artifact; a ceiling changes only whether
   the run finishes. Putting it in the config would make two artifacts that measured the same
   thing differ in a field describing neither.

The ceiling reaches the run as `CORTEX_MEMORY_BUDGET_MINUTES`, registered in §10.3 as
`budgetMinutes: 90` — roughly three and a half times the longest pass any completed run has
produced here (`3h32m` for eight passes). Absent means **no ceiling**, which is what every
archived artifact was produced under, and a non-positive value is rejected rather than read as
"unset": zero would abandon every pass before its first question and produce a failed run that
reads as a healthy configuration.

### 13.30.2 Verification

- `pnpm check` exit 0, including the export census — which reported the exception class as
  `1 NEW orphan(s)` the moment it was exported, and is why it is module-private: nothing
  outside needs to identify it, since the entry point's `catch` is generic.
- **Defect injection, caught**: removing the budget check fails `abandons the pass when its
  wall-clock budget is spent, and stops where it ran out`. A second test holds the
  compatibility rule — with no budget the pass runs to completion, which is every archived
  run.
- **§13.27 was re-dispatched once more** as run **`38753835652`**, still with no variable
  moved: the ceiling is a run option, so the registered experiment is untouched and the four
  predictions of §13.27 stand exactly as written.

### 13.30.3 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read the §13.32 dispatch against its five predictions (§13.31.3 says what to read first: MR's `promptChars`, then the roster, then coverage, then accuracy) | yes — dispatched |
| P1 | Give `DecisionTrace` the turn list `respondWith` already receives, restoring that product's `goldOverlap` | no |
| P1 | Design the **no-signal control** (§13.22.8) | no (dispatch later) |
| P2 | `grounded` is still hard-coded `false`; the writer's reduced manifest is not uploaded; `cortex-node` branch coverage is 98.64% (§13.29) | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

**Three failures, three different layers, each now closed.** `38659495034` failed and could not
say how long it had been failing (§13.28). `38725510400` failed without failing — it hung, so
there was nothing to say (§13.30). The pattern is the same one §13.16.6 recorded for the
evidence unit: **the instrument was the defect**, and each repair was to make the thing that
was silent say something.

So the number stays at 98.64%, above the 95% floor and explained rather than suppressed. What
changed is that the two branches a test *could* reach now have one, and that the coverage
digits are no longer the only statement about them.

## 13.31 `session` is refuted: the unit was right, the search stranded the room

Run **`38753835652`** completed in `3h21m` and produced a full five-hundred-question artifact.
It is the first dispatch since §13.25 to finish on the first attempt, and the first in four
attempts to fail *in the measurement* rather than in the plumbing.

### 13.31.1 The judgement, against §13.27's four predictions

| §13.27 prediction | Registered | Measured | Verdict |
| --- | --- | --- | --- |
| MR's median `carried/total` rises from 0.58 to **≥ 0.75** | primary | **0.455** (turn: 0.500) | **FALSIFIED** |
| MR rises and the arm's delta exceeds **+25.75pp** | — | delta **+17.80pp**, MR **12.40%** (turn: 42.15%) | **FALSIFIED** |
| TR does not fall back below its §13.26 level | — | TR **62.99%** (turn: 56.69%, +8 questions) | holds |
| IE and KU do not move beyond the control band | — | IE **−4** questions, KU **−1** | holds, with a caveat below |

The registered falsifier **"coverage rises and accuracy falls"** did not fire. The one that
fired is worse for the design: **neither rose**. Coverage moved the wrong way while accuracy
moved by thirty percentage points, so the mechanism §13.26.5 named was not reached by this
design at all.

The headline numbers, side by side with the run they were compared against:

| | §13.26 `turn` | §13.27 `session` | Δ |
| --- | --- | --- | --- |
| Δ accuracy | **+25.75pp** | **+17.80pp** | −7.95pp |
| McNemar | 1.064e-13 | 1.787e-7 | — |
| MR | 42.15% (51/121) | **12.40%** (15/121) | **−36** |
| IE | 88.67% (133/150) | 86.00% (129/150) | −4 |
| KU | 86.11% (62/72) | 84.72% (61/72) | −1 |
| TR | 56.69% (72/127) | 62.99% (80/127) | +8 |
| ABS | 96.67% (29/30) | 100.00% (30/30) | +1 |
| Abstention rate | 20.60% | 28.40% | +7.80pp |

MR's paired counts are the part that cannot be noise: **92** questions the baseline had right
and this arm got wrong, against **zero** it gained. A rule that changes a capability from
"the arm's best result" to "92 lost, none won" is not a weak effect, it is the wrong rule.

One further correction to the registration, in the same class as §13.31.4. §13.27 wrote the
turn unit's MR median coverage as **0.58**; recomputed on the same predicate and the same
artifact, against the run this dispatch was compared with and against this one, it is
**0.500**. The registered direction ("rises") is what was falsified, and it was falsified
either way — but a registration that mis-states the starting value makes the target it names
(0.75) unanchored, so the number is corrected here rather than carried forward.

### 13.31.2 The control band, and why this dispatch's controls are weaker than §13.26's

§13.26 could argue that IE, MR, KU and ABS were controls, because `computed` reaches only
the temporal route on those four. **This dispatch cannot**: `relevanceUnits` reaches every
route whose plan carries session boundaries, and IE's own roster moved with it. The evidence
that the change was confined to MR is therefore not the band but the artifact's own
`promptChars`, which is the falsification test the band was standing in for:

- **375 of 500 questions have byte-identical `promptChars`** across the two runs.
- Every one of the 125 that differ is MR or a question whose MR route was taken: the median
  difference is exactly **0** for IE, KU, TR and ABS, and **−6,439** for MR.
- Of MR's 121 questions, **119** got a shorter prompt and 2 were unchanged.

So IE's −4 questions is not a second effect; it is what §13.26 measured as inside the noise
band on an untouched capability. Stated because a reader who took the table alone would
attribute it to the unit.

### 13.31.3 The mechanism: the prefix rule never spent the room

A session is much larger than a turn, so the first session over the line ends the pass. The
artifact measures the consequence directly, in a unit that does not depend on the code
version: the prompt's own length.

| MR, per question | `turn` | `session` |
| --- | --- | --- |
| room used, median | **0.940** | **0.673** |
| room used, p10 | — | 0.503 |
| room used, min | 0.843 | **0.205** |
| questions using under 20,000 of 24,000 | **0 / 121** | **102 / 121** |
| roster, median entries | 23 turns (149 lines, pre-§13.25 units) | 12 turns |

The rule stranded a median of **6,439 characters — 28% of the room — on 102 of 121 MR
questions**, and more than half the room on 48 of them. It is not the "cannot fit the top
session" path the suite tests: **no** MR question had an empty roster. It is the ordinary
case, where the third or fourth session did not fit and the rule stopped with the rest of
the room unread.

Two consequences follow, and the second is the one that matters for what to try next:

1. The carried set was smaller than the budget allows, so the run's MR result is a reading of
   an allocation fault rather than of the session unit.
2. **The coverage column agrees independently**: 0.500 to 0.455, with the `[0.65, 0.85)` band
   emptying from 24 questions to zero. If whole sessions were the mechanism, carrying them
   would have raised coverage even with a smaller budget. It did not.

**A units caveat, recorded because it nearly produced a wrong number here.** §13.26's artifact
was produced before §13.25 repaired the capture, so its `turns` counts **lines** (≈6.6 per
turn, the ratio §13.16.6 measured); this one counts turns. The two artifacts' roster lengths
are therefore not comparable, and an early reading of this run compared them directly and
concluded the budget had been halved. The comparable quantities are accuracy, `goldOverlap`,
and `promptChars` — the last one for the reason §13.25 gives: it is produced by a different
code path than the capture and did not change.

### 13.31.4 A defect this dispatch's audit found in §13.27's registration

§13.27's "Registered before dispatch" table names its variable as
`cortex_memory_relevance: retrieval-session`. That value **was never implemented and never
dispatched** — it appears nowhere in the repository outside that one row. The variable that
was actually moved is `relevanceUnits`, whose implementation §13.27.1 documents and whose
value the dispersed run's configuration line records. The table row is corrected here rather
than silently, because a registration that names a variable which does not exist is a
registration the guard cannot check: `test_preregistration_config.py` compares values it can
find in both places, and a concept with no input behind it is invisible to it.

### 13.31.5 The repair, and the two alternatives rejected

**Kept**: the scoring, the grouping, the ranking and the tie rule. `rankSessionTurns` is now
extracted so the two session rules cannot drift apart, and `chooseEvidence` owns the branch so
the "route must draw boundaries" precondition is tested once instead of once per rule.

**Repaired**: the search. `session-fill` walks the same ranked order and **skips** a session
that does not fit, continuing until the room is spent. The property the prefix rule was argued
for — the carried set is a function of the ranking and the room, so it does not depend on the
sizes of sessions the signal did not choose — is **given up and stated as a cost**, because
filling the room is worth more than a purity claim that leaves 28% of it unread on the median
question.

**Rejected, with reasons, so neither is re-proposed as new**:

| Alternative | Why not |
| --- | --- |
| Carry each session's **leading** turns up to a per-session quota | Re-introduces the "whole session" claim as a *partial* session, and needs a second ordering rule (where inside the session to start). One change at a time: the refuted rule's only fault that the artifact measures is the stopping rule, and this would move two things at once |
| Give `session` the filling rule **in place** | A configuration line is the only record an artifact carries. Editing the rule under the same value would make `38753835652` ambiguous with its successor, and the refutation unreproducible. `session` is frozen exactly as measured, as a confirmed-negative configuration is kept elsewhere in this project |
| Raise the room instead (`maxPromptChars`) | Not delegated: it changes the budget, and every number in this document is conditioned on 24,000. A budget sweep is a legitimate later experiment and a different one |

### 13.31.6 Verification

- `pnpm check` **exit 0**; cortex-eval **1,872**, cortex-memory **330**, **100% on all four
  coverage dimensions** in both; `tools` 314 passed + 35 subtests; census clean.
- **Three defect injections, all caught.** Making the filling loop `break` on the first
  session that does not fit fails the two fill tests. Routing `session-fill` to
  `selectBySession` fails the same two. Removing the `budgetMs` forwarding in the arm fails
  the ceiling test added when that branch was the only uncovered one in the repository.
- The two new coverage branches were closed by **writing the tests they imply**, not by
  excluding them: no-session-fits for the filling rule, and the arm's forwarding of the
  per-pass ceiling.

## 13.32 The session unit with the room actually spent, and what that is registered to move

**Registered before dispatch**: one dispatch of the same configuration as `38753835652`, with
a single variable changed — the session rule's search.

| Field | Value | Note |
| --- | --- | --- |
| `cortex_memory_relevance_units` | **`session-fill`** | the variable |
| `cortex_memory_ask` | `computed` | held at §13.26's value |
| `cortex_memory_relevance` | `retrieval` | held |
| `cortex_memory_relevance_top_k` | `64` | held |
| `cortex_memory_evidence_turns` | `256` | held |
| `cortex_memory_budget_minutes` | `90` | held (§13.30) |
| everything else | §13.26's values | held |

**Predictions, in the order they would be read:**

1. **MR's room usage returns to the turn unit's level.** Median `promptChars / 24000` moves
   from **0.673** to at least **0.90** — the same band the turn unit occupies (0.940 median,
   0.843 minimum). This is the primary prediction and it is about the *repair*, not about the
   unit: if filling does not spend the room, the search was not what the artifact measured.
2. **The MR roster grows past the turn unit's.** More than 23 turns on the median question,
   because a filling rule that skips can admit more sessions than a prefix that stops. If the
   roster is still near 12, the pass is stopping for a reason this section did not identify.
3. **MR coverage rises above 0.50, and the `[0.65, 0.85)` band refills.** §13.26.5's mechanism
   says coverage is what accuracy tracks, so coverage moves first.
4. **MR accuracy rises above the turn unit's 42.15%** and the arm's delta exceeds **+25.75pp**.
   This is the claim that replaces §13.27's falsified one: the session unit with the room spent
   beats the turn unit, or the unit is not the lever.
5. **TR stays at or above `session`'s 62.99%.** TR moved *up* under the session unit and there
   is no registered reason for the repair to give that back; if it does, the TR gain came from
   the stranding rather than from completing sessions, which would be a finding about TR.

**Falsifiers, stated before the number exists:**

- Room usage rises to the turn unit's level while MR accuracy stays near 12% → the MR collapse
  was about **which** sessions are chosen, not how much room is spent, and the ranking — not
  the search — is the lever.
- Coverage rises above 0.65 and MR accuracy does not improve → §13.26.5's coverage/accuracy
  reading is correlational, and the band table is not a mechanism.
- `promptChars` differs from the turn unit's on any IE, KU, TR or ABS question → the change is
  not confined to the multi-session route, and this dispatch is not single-variable.

**Stopping rule.** One dispatch, no peeking, no redraw. The point estimate must exceed the
BASELINE side of the same dispatch, McNemar p < 0.05 two-sided, full N = 500, 4 runs,
temperature 0 — the same instrument as §13.21, §13.26 and §13.27, so all four are comparable.

## 13.33 The arm reports groundedness, and the trace producer's repair is narrowed

Run `38828538851` (§13.32) is in flight and this section was written while it ran. Two
instrument repairs that need no provider, and one finding that shrinks a P1 this document has
carried since §13.25.

### 13.33.1 `grounded: false` was a constant, and that was not a refusal to guess

Every record the memory arm produced carried `grounded: false`. The docstring above the
roster function said why: grounding is a property of the upstream failure classifier, this arm
collects no classification, so the records say `false` rather than guessing. The premise is
right about the **trace** product — `buildRecordsFromDataset` takes the verdict from a
predicate its caller supplies — and wrong about this one. The classifier is a published rule
over two values this arm already holds: the **graded answer** and the **evidence the reader
received**. That is `classifyTrFailure`, and the arm can call it.

So `false` was not a refusal to guess. It was a value the arm had not measured, reported as if
it had measured it — which is `§13.11.2`'s rule ("a wrong number is worse than an absent one")
violated in the one direction that rule does not cover: not an absent number standing in for a
measurement, but a **constant** standing in for one.

**What the constant cost, exactly.** `computeTargetCohort` files an ungrounded question under
`notGrounded` and `continue`s before clustering. With the field constant, that bucket held
**every question of every arm artifact**, so:

- the published B7 criterion could not be executed against this product at all — a reader
  would have found zero targets and concluded the criterion was inapplicable;
- and the artifact asserted that five hundred questions had been **classified** as ungrounded,
  when in fact none had been classified. "Nobody classified these" and "these were all
  ungrounded" are different findings, and the artifact published the second.

The repair is a call in the arm's roster, and three decisions about it are stated in code:

| Decision | Where | Why |
| --- | --- | --- |
| The haystack is the **delivery** | `bench-memory-arm.ts` | Grounding asks what the reader had in hand, and the delivery is `retrievedContexts[i]` — the same vector `turns` is built from |
| It is read **before the bound** | same | The bound is an artifact setting applied after the run, so a verdict taken from the post-bound turns would make a question's groundedness depend on how the JSON was written. `goldOverlap` sits on the same line for the same reason |
| The arm supplies evidence and reads a verdict | `tr-failure-class.ts` | The arm does not decide what counts as a match. A test pins that a partial match is ungrounded, so an arm that recomputed or relaxed the rule would fail rather than quietly report the opposite |

`TrFailureInput.questionDate` became optional in the same change. It is declared and **read by
no verdict**; requiring it would have forced this new caller to fabricate a value for a field
nothing consumes. The docblock now says so, which is also the only place a reader would learn
that the field is inert.

### 13.33.2 A stale fixture the change exposed

Two pre-existing tests broke on first run, and the break is worth recording because of what it
means. Their `reportingSystem` returned a **joined string** from `lastRetrievedContext`, which
has been a turn list since §13.16.6. The arm's capture copied it through untouched, no caller
had ever joined it, and so **no test could observe the violation**: the fixture had described
the pre-§13.16.6 accessor for two sections and stayed green.

The new consumer is the first to treat the delivery as a list, and it found the fixture on its
first execution. Both are now list-shaped, with the offer's `chars` computed as the joined
length the real producer reports.

### 13.33.3 Why the trace producer's turn list is not a quick win, and what that narrows

§13.25 left one P1 open: give `DecisionTrace` the turn list `respondWith` already receives, so
the trace product reports turns and its `goldOverlap` can be restored. Investigating it
narrows the change in a way that is worth writing down, because the naive version would
produce an artifact **worse** than the one it replaces.

- Four of the six answering paths render through `expandContextWindow*`, which selects a set of
  corpus positions and joins them. Exposing the selection beside the render is mechanical
  there, and it touches no prompt.
- The **multi-session** path does not. `answerSessions` composes its context as
  `truncateText(hits.map((h) => truncateSession(h.text, maxChars)).join('\n\n'), maxAggregationChars)`
  — a join of joined sessions, then a character-level cut. The turn boundary is destroyed
  twice, and recovering it means changing how that path renders.

The consequence is decisive. The four repairable paths are the ones behind IE, KU, TR, ABS and
assistant; the pathological one is the path behind **MR** — the capability whose gold coverage
this document has been measuring since §13.26. So a partial repair would:

1. leave MR reporting lines while the other four report turns, making the artifact's `turns`
   **heterogeneous** — a reader aggregating across capabilities would be summing units; and
2. change nothing about the capability we are working on.

And a complete repair reaches the reference pipeline's rendering, which changes prompts and
therefore invalidates the comparability of every archived run. That is a registered dispatch of
its own, not a P1 cleanup, and it is second to §13.32's question: whether the **room** is MR's
binding constraint. This section exists so the next attempt does not rediscover it by
implementing the partial version first.

### 13.33.4 Verification

- `pnpm check` **exit 0**; all four coverage dimensions **100%** in every package except
  `cortex-node`'s branch column, which §13.29 explains; `tools` green; census clean.
- **Two defect injections, both caught.** Restoring the constant fails the three tests that
  assert a measured verdict. Giving the classifier the **reader's** answer as the graded one —
  the realistic mistake, since the arm holds both strings — fails three of the four, including
  the partial-token case.
- The four new tests are the four ways this can be wrong quietly: the verdict itself, the
  negative case, whose rule decides a match, and which copy of the evidence is measured.

### 13.33.5 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read run `38828538851` against §13.32 — MR's `promptChars` first, then the roster, then coverage, then accuracy | no (in flight) |
| P1 | Restore the trace product's turn unit and its `goldOverlap`. **Narrowed by §13.33.3**: the multi-session path destroys the turn boundary twice, so this is a registered change to that path's rendering — a dispatch that invalidates archived comparability — and not a cleanup. Second to §13.32's question | no |
| P1 | Design the **no-signal control** (§13.22.8): separates "the extra turns" from "the ordering" | no (dispatch later) |
| P2 | The writer's reduced manifest is not uploaded; the inline reduction marker is ambiguous | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

`grounded` is **closed** (§13.33.1) and drops off this list. `cortex-node`'s branch coverage stays
at 98.64% by §13.29's decision, and no item above is blocked on it.

## 13.34 `session-fill` spends the room and changes nothing, and MR's loss is not in the window

Run **`38828538851`** completed in `3h41m`. It was dispatched to repair §13.27's rule by
spending the room, and it did exactly that — and the measurement barely moved.

### 13.34.1 The judgement, against §13.32's five predictions

| §13.32 prediction | Registered | Measured | Verdict |
| --- | --- | --- | --- |
| MR room usage returns to the turn unit's level | ≥ 0.90 | **0.941** (turn 0.940, p10 0.882, min 0.843 — identical) | **holds** |
| MR roster grows past the turn unit's | > 23 turns | **26** (turn 23, prefix 12) | **holds** |
| Coverage rises above 0.50 and the `[0.65,0.85)` band refills | — | median **0.500** (unchanged), band refilled (24 from 0) | half |
| MR rises above 42.15% **and** the delta exceeds +25.75pp | — | MR **42.98%**, delta **+24.90pp** | half |
| TR stays at or above `session`'s 62.99% | — | TR **55.91%** | **FALSIFIED** |

The fifth was falsified exactly as written, including its stated meaning: *"if it does, the TR gain
came from the stranding rather than from completing sessions, which would be a finding about TR."*
TR went 62.99% → 55.91%, back to the turn unit's own level, so **§13.27's +8 TR questions were bought
by the room the prefix rule failed to spend** — a shorter, thinner context helped TR, and completing
sessions gave it back. That is a real finding about TR and it is now on the record rather than
absorbed into a delta.

### 13.34.2 The allocation axis is closed

| | §13.26 `turn` | §13.27 `session` | §13.32 `session-fill` |
| --- | --- | --- | --- |
| delta | **+25.75pp** | +17.80pp | +24.90pp |
| MR | 42.15% | 12.40% | 42.98% |
| IE / KU / TR / ABS | 88.67 / 86.11 / 56.69 / 96.67 | 86.00 / 84.72 / 62.99 / 100.00 | 88.67 / 81.94 / 55.91 / 96.67 |
| MR room used | 0.940 | 0.673 | 0.941 |
| MR roster | 23 turns | 12 turns | 26 turns |
| MR coverage bands `[0, .25)` … `[.85, 1]` | 14 / 33 / 41 / 24 / 9 | 23 / 35 / 51 / 0 / 12 | **14 / 33 / 41 / 24 / 9** |

Against the turn unit, `session-fill` moves **+1 question on MR and −3 across the other four** — inside
the ±3-question band this document has been using as noise since §13.26. And the coverage band counts
are **identical**, question for question, across two structurally different allocations: one spends the
room on the highest-scoring turns wherever they live, the other on whole sessions ranked by their best
turn. Two different sets of turns, the same gold coverage. So **how the room is spent is not the
constraint**, and the axis that began at §13.27 is closed with three measurements rather than one.

### 13.34.3 The room is nearly sufficient, which is the part that redirects

| MR, run `38828538851` | value |
| --- | --- |
| gold turns per question, median | **24** |
| carried gold, median | **14** |
| roster, median | **26** |
| questions whose roster ≥ their gold total | **52 / 121** |
| coverage a **perfect selector** would reach at this room, median | **0.917** |

The window already holds as many turns as the gold set contains, on the median question. A selector
that could *find* the gold would carry essentially all of it. So the missing 10 of 24 are not missing
for want of space — and the earlier plan for this iteration, a room sweep, was dropped once this table
existed: buying more room would be compensation for a ranking that spends half the window on
non-gold, and the reference pipeline scores 86.78% on MR with a **smaller** window (20,000 characters)
than this arm's 24,000.

### 13.34.4 Where the loss actually is: the answer contract, not the evidence

| MR, 121 questions | count |
| --- | --- |
| correct | **52** |
| wrong | **47**, of which **41 are numeric mismatches** |
| abstained | **22**, carrying 14–20 gold turns each |

The reader holds the evidence and either miscounts it or declines with it in hand. Note the shape of the
second row: these are not "the wrong fact" answers, they are *counts off by a little* on questions whose
gold is a small number (`3`, `8`, `15`). And the abstentions are not gates closing — `empty` and
`threshold` are both 0 in this run — they are the model taking a licence the block grants it.

An earlier check in this iteration ruled out the obvious retrieval explanation: the window already spans
a median of **8** sessions (p90 15), so it is not concentrated on one conversation, and the assistant-turn
share of the window is 0.364 with no difference between correct (0.368), wrong (0.333) and abstained
(0.383), so it is not noise crowding the answer out either.

### 13.34.5 Registration: the ask becomes `enumerated`

The reference pipeline's MR prompt is a **two-step contract** — enumerate every matching item with its
date, then compute per the kind of question — whose abstention clause requires the list to exist first.
`computed`'s single sentence asks for the gathering and never says how, or what a legitimate answer to a
counting question looks like. That is the difference between a 86.78% and a 42.98% on MR, and it is a
prompt, not a window.

**Registered before dispatch**: one dispatch of §13.26's configuration, with a single variable changed.

| Field | Value | Note |
| --- | --- | --- |
| `cortex_memory_ask` | **`enumerated`** | the variable |
| `cortex_memory_relevance` | `retrieval`, `top_k` `64` | held |
| `cortex_memory_relevance_units` | **`turn`** | held at the shipped default, so §13.26 is the comparison |
| `cortex_memory_evidence_turns` | `256` | held |
| `cortex_memory_budget_minutes` | `90` | held (§13.30) |
| everything else | §13.26's values | held |

**Predictions, in the order they would be read:**

1. **MR's abstentions fall.** 22 → **≤ 12**. This is the primary prediction because it is the half of
   the contract with a mechanical reading: `Do not reply INSUFFICIENT_EVIDENCE without first writing the
   Step 1 list` names the artefact it requires, and a question with 14 gold turns in the window has
   something to list.
2. **MR's wrong answers stop being numeric mismatches.** 41 of 47 → **≤ 25**, which is the counting half.
3. **MR rises above §13.32's 42.98%** by more than the noise band: **≥ 48%** (58/121).
4. **The arm's delta exceeds +25.75pp.**
5. **IE, KU and TR do not move beyond the band.** Unlike §13.27's dispatch, these *are* controls and
   the claim is structural rather than statistical: the flat path and the temporal route are asserted
   byte-identical to `computed` in `evidence-ask-reach.test.ts`, and KU's route is untouched by both asks.

**Falsifiers, stated before the number exists:**

- Abstentions fall to ≤ 12 and accuracy does not move → the abstentions were a *symptom* of an incomplete
  count rather than a cause, and the fix needs the evidence to be complete rather than the instruction to
  be structured. That would point back at the ranking, with the room already ruled out.
- Numeric mismatches stay near 41 → the two-step contract is not what the reference prompt contributes,
  and its 86.78% comes from something else in that path (its ledger parser, its critique pass, or its
  session-level retriever), which would then be the next thing to isolate.
- Any movement in IE, KU or TR beyond ±3 questions → the byte-identity assertions are not being honoured
  at the artifact, which is a defect in the arm rather than a result.

**Stopping rule.** One dispatch, no peeking, no redraw. The point estimate must exceed the BASELINE side
of the same dispatch, McNemar p < 0.05 two-sided, full N = 500, 4 runs, temperature 0.

### 13.34.6 The dispatch was refused, and the reason it gave was wrong

The first attempt returned:

```
POST /actions/workflows/benchmark-cortex-memory.yml/dispatches -> 422
{"message": "Workflow does not have 'workflow_dispatch' trigger"}
```

The trigger was there. An **apostrophe inside a single-quoted YAML scalar** — the word `question's`
in the `description` this section added — made the file unparseable, so GitHub registered no workflow
at all and reported the absence as a missing trigger. Every check passed: the full gate reads TypeScript
and Markdown, and both pre-registration guards read the YAML as **text**, which cannot see a quoting
error. The only thing that noticed was the dispatch, after the commit was pushed, and the artifact of
the failure was a run with **zero jobs** — also what a cancelled run looks like.

`tools/__tests__/test_workflow_yaml.py` closes it: every workflow must parse, and every workflow a
`dispatch-*.py` posts to must declare the trigger (a *valid* file without the trigger produces the same
422). Defect injection — the apostrophe put back — fails both assertions. The second attempt dispatched
as run **`38908223281`** at `c1f3dcb9`.

### 13.34.7 Verification

- `pnpm check` **exit 0**; all four coverage dimensions **100%** in every package except `cortex-node`'s
  branch column (§13.29); `tools` **316 passed + 40 subtests**; census clean; the §10.3 guard green
  against the re-registered `ask` and the held `relevanceUnits`.
- **Four defect injections, all caught.** The enumeration contract dropped from the multi-session route;
  the scope check removed so the flat path receives it too; and — in a second file — the apostrophe put
  back into the workflow.
- The two halves of §13.34.5's prediction 5 are **assertions, not claims**: flat and temporal are
  byte-identical to `computed`, and the multi-session block is not.

### 13.34.8 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read run `38908223281` against §13.34.5's five predictions — abstentions first, then the mismatch count | no (in flight) |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3: a registered change, not a cleanup) | no |
| P1 | The **no-signal control** (§13.22.8): separates "the extra turns" from "the ordering" | no (dispatch later) |
| P2 | The writer's reduced manifest is not uploaded; the inline reduction marker is ambiguous | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

**The selection axis is closed** (§13.34.2) and **the room is ruled out as the constraint on MR**
(§13.34.3). What remains for MR is the answer contract, which this dispatch tests, and the ranking, which
the falsifiers above route to if the contract is not it.

## 13.35 The dispatch died at startup, and the parity it needed was claimed in a comment

§13.34.6 records the *first* refusal (an apostrophe in YAML). The dispatch after that fix was
**accepted and then died before question one**:

```
CORTEX_MEMORY_ASK must be one of "route", "extractive", "aggregate", "computed" or unset,
got "enumerated".
    at readAsk (packages/cortex-eval/src/bench-memory-arm.ts:665:11)
```

The value was in the product's union and in the product's table. It was not in the **second**
declaration of the same fact.

### 13.35.1 The defect: one decision, two declarations, no check between them

| | Where | What it is |
| --- | --- | --- |
| the union and the reach table | `cortex-memory/src/prompt.ts` | decides what an instruction block actually says |
| a second `ASK_ROUTES` | `cortex-eval/src/bench-memory-arm.ts` | what `readAsk` validates a dispatched value against, and what the artifact's `askRoutes` comes from |

The second copy has to exist: `cortex-eval` may not depend on `cortex-memory` — the arm adapts a
system it does not own, and there is a test asserting the dependency is absent. But it was typed
`Record<string, readonly string[]>`, so **adding a value to the union changed nothing here**, and
a comment beside it stated the property that would have caught the omission:

> *"§13.21's ask, restated for the same reason as the two above: the artifact reports the reach
> from this table, and **the product's own table is asserted equal to it**."*

Nothing asserted it. That sentence is the same defect class as §13.24's docstring describing code
that did not exist and as the workflow guard two hours earlier: **a claim and a check have to be
the same thing**, and a comment is not a check. Three separate instances in one campaign is the
signal that this deserves a rule rather than three fixes.

### 13.35.2 The repair, and why the check reads source

`tools/__tests__/test_ask_table_parity.py` extracts the union members from `prompt.ts` and the
table keys from `bench-memory-arm.ts` and asserts they are equal, with a control that each parse
found something. Reading source is the only technique available: the two files live in packages
that may not reference each other, and a test inside either one can see only its own copy. That is
the same reason `test_dispatch_inputs.py` reads the workflow files as text and the same reason
`test_workflow_yaml.py` parses them — **the guard has to be written at the layer where the two
copies are visible at once**, which here is the repository.

The defect injection is the defect itself: remove the value from the arm's table and the guard
fails naming it.

### 13.35.3 What the failure record did, which is the part worth keeping

The run produced no report and no partial vector — and it produced a **complete** record in
`benchmark-error.log`, in this order:

```
progress: no question was started before the failure
CORTEX_MEMORY_ASK must be one of ... got "enumerated". An unrecognised ask is rejected ...
Error: ... at readAsk (bench-memory-arm.ts:665:11) at cortextMemoryArmOptions (460:10) at main ...
```

One line says how far the pass got, the next names the option, the rejected value and the accepted
set, and the stack names the line. That is §13.28's repair on its first real use, and it turned a
"the run failed" into a one-step diagnosis. The elapsed-time field added there is present too, at
a value that says the failure was immediate rather than a hang — which is what ruled out the pass
ceiling and the timeout as suspects before either was checked.

### 13.35.4 The second CI red of the iteration, and the same omission already on file

The workflow guard added in §13.34.6 imports PyYAML. It was not in `tools/requirements-dev.txt`,
so on a clean runner it failed **at collection** and `Verify library` went red at `c1f3dcb9` and
`4317c70c`. Locally it passed, because the development environment has PyYAML for other reasons —
which is exactly the story that file already tells once:

> *"Not a test dependency: `fetch-artifact.py` imports it at module scope ... Its absence on a
> clean runner is what the first CI run of `pnpm check` failed on."*

The guard raises `AssertionError` rather than skipping when the import fails, on the argument that a
control which skips is a control that is not there — so the omission failed the gate instead of
passing quietly, which is how it was found. The fix is one declared requirement, verified by
installing only that file into a fresh virtualenv (what the runner does) and running the suite
there: **318 passed + 40 subtests**, and with PyYAML deliberately absent the same suite errors at
collection, reproducing the runner's failure exactly.

### 13.35.5 Verification, and the re-dispatch

- `pnpm check` **exit 0**; four coverage dimensions **100%** in every package except `cortex-node`'s
  branch column (§13.29); `tools` **318 passed + 40 subtests**, the last two files being the two
  guards this iteration added.
- **Verify green at `45b1de63`**, after two reds, both traced to a single undeclared dependency.
- **Five defect injections across the iteration, all caught**: the enumeration contract dropped; the
  scope check removed; the apostrophe restored in the workflow; the ask value removed from the arm's
  table; and, earlier, the constant `grounded` restored (§13.33).
- **Re-dispatched unchanged** as run **`38910134192`** at `45b1de63`. No variable moved: the science
  of §13.34 was never in question — two configuration defects stopped the run before it began, and
  both were in the instrumentation.

### 13.35.6 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read run `38910134192` against §13.34.5's five predictions — abstentions first, then the mismatch count | no (in flight) |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P1 | The **no-signal control** (§13.22.8) | no (dispatch later) |
| P2 | The writer's reduced manifest is not uploaded; the inline reduction marker is ambiguous; **and a general parity rule** — every duplicated declaration across the `cortex-eval`/`cortex-memory` boundary needs a source-level guard, of which §13.35 is one instance and not the last | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

## 13.36 One rule for every table the arm restates, and the census that found four

§13.35 fixed one duplication. This section takes the census that produced it and turns the fix into
a rule, because the count is what made that necessary: **four** vocabularies are declared twice across
the `cortex-eval` / `cortex-memory` boundary, and in one iteration each of them turned out to carry a
comment claiming a check.

### 13.36.1 The census

The boundary is real and cannot be removed: `cortex-eval` measures `cortex-memory` and may not depend
on it, so every shared vocabulary is restated in the arm. What existed beside each restatement:

| Vocabulary | Product side | Arm side | Check before this section |
| --- | --- | --- | --- |
| ask names | `EvidenceAsk`, `ASK_ROUTES` | `ASK_ROUTES` | **none** — the comment said "the product's own table is asserted equal to it" |
| relevance units | `RelevanceUnits` | `RELEVANCE_UNITS` | **none** — `session-fill` was hand-added to both in §13.31 and nothing would have noticed if it had not been |
| prompt contracts | `PROMPT_CONTRACTS` | `PROMPT_CONTRACTS` | guarded, and the only one whose guard was real |
| rendering reach | `RENDERING_BY_CONTRACT` | `RENDERING_ROUTES` | guarded, but **weaker than its own comment**: the product's source was read only to assert the constant *exists*, and the route list was compared against a literal, so a route added on the product side could not fail it |

Four instances of the same defect in one iteration is not a run of bad luck; it is a missing rule. It is
also the same defect the campaign keeps meeting one layer over — §13.24's docstring describing code that
did not exist, §13.34.6's workflow whose trigger check was a text grep, and this. **A claim and a check
have to be the same thing.**

### 13.36.2 The rule

One data-driven `describe` in `bench-memory-arm.test.ts` now covers all four, and each axis is compared
in **both directions**: a value that exists only on the product side is a dispatch that dies at startup
(§13.35), and a value that exists only on the arm side is a run whose artifact claims a treatment the
product never administers — the `bcf66463` defect inverted.

Three properties make it stronger than the guards it replaces:

1. **It drives the option parser the dispatch uses.** The arm's accepted set is not read from its table
   but from the **error message it raises on a bad value**, because every reader in that file enumerates
   its own keys into the message. That asserts the set the arm *behaves* on, which is what a dispatch
   meets — and the helper throws rather than comparing an empty set if a reader ever stops listing.
2. **The route vocabulary comes from the product**, parsed out of its `ASK_ROUTES`, so a route name that
   exists only in the arm fails; and every ask that reaches anything must report a non-empty reach.
3. **It supersedes §13.35's `tools/` guard, which is deleted.** That guard was correct, and it was in the
   wrong place: the pattern already existed in this file, which can read the product's source *and* drive
   the parser, and one fact should have one check rather than two. §13.35's guard was correct for the
   reason it gave (it has to be written where both copies are visible); it just was not the only such
   place, and not the better one.

### 13.36.3 The check that cannot exist, stated instead of pretended

The rendering table's comment claimed a census test asserted the product's reach. Nothing can: which
routes a rendering reaches is a property of the **dispatch**, decided in `bench/run-ablation.ts` where the
contract is chosen, and that file is outside the coverage boundary. So the vocabulary is checked, the
per-contract list is not, and the comment now says so — with where a reader should verify it instead:
the artifact records the reach per run as `renderingRoutes`, so it is checked against the run rather than
against a table. Replacing a false claim with an honest boundary is the whole of this section's method.

### 13.36.4 Verification

- `pnpm check` **exit 0**; four coverage dimensions **100%** in every package except `cortex-node`'s
  branch column (§13.29); `tools` **316 passed + 40 subtests** (one file fewer than §13.35, by design).
- **Four defect injections, each caught by exactly one test**: the ask value removed from the arm's table;
  the unit value removed; a contract added that the product does not have; and a route added that the
  product does not name. "Exactly one" is the assertion that the axes are independent — a single
  over-broad check would fire on all four and would not tell a reader which vocabulary drifted.

### 13.36.5 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read run `38910134192` against §13.34.5's five predictions — abstentions first, then the mismatch count | no (in flight) |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P1 | The **no-signal control** (§13.22.8) | no (dispatch later) |
| P2 | The writer's reduced manifest is not uploaded; the inline reduction marker is ambiguous | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

The parity rule closes the last item that the instrumentation defects of this iteration had left open. The
remaining P2 pair is about what an artifact records about its own reductions, and neither blocks the
measurement in flight.

---

## 13.37 The cache the workflow read was never the cache the workflow wrote

### 13.37.1 The dispatch, and what it did and did not decide

Run `38910134192` was the `ask: enumerated` dispatch §13.34.5 registered five predictions for. **It adjudicated
none of them.** The job ran from `13:44:06Z` to `15:02:15Z` and ended `failure`, and the artifact it published
is a 612-byte artifact holding one file, `benchmark-error.log`:

```
progress: no question was started before the failure

Embedding request failed: 429 Too Many Requests — {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}

Error: Embedding request failed: 429 Too Many Requests — ...
    at OpenAIEmbedding.embed (packages/cortex-llm/src/embedding/openai.ts:61:13)
    at async embedManyCached (packages/cortex-eval/src/retrieval.ts:256:21)
    at async buildTurnIndex (packages/cortex-eval/src/retrieval.ts:397:21)
    at async retrieveTopKByQueries (packages/cortex-eval/src/retrieval.ts:981:16)
    at async buildRetrievalRelevanceIndex (packages/cortex-eval/src/relevance-index.ts:169:18)
    at async main (packages/cortex-memory/bench/run-ablation.ts:306:9)
```

Two things about that record are worth naming before anything else, because one is this iteration's only
success and the other is a number the record should not have had to carry.

**The failure record worked, for the first time, on a run that died before question 1.** §13.30 and §13.31
were written because `38659495034` spent 1h49m and left one line (`q=1/500`) and `38725510400` spent five hours
and left nothing. This run left the sentence those sections were written to produce — `no question was started
before the failure` — plus the stack at the frame that threw, plus the process-wide transport accounting
(`attempts 11482, calls 11477, cleanCalls 11476, retriedCalls 1, rateLimited 6, exhaustedCalls 0`). The
machinery did what it was specified to do at the first opportunity it had.

**And the stack is the wrong place for the failure to be, because the run had already done 1h17m of work it
did not need to do.** The bench step started at `13:44:47.9Z` and threw at `15:01:39.9Z`: **4,620 seconds, and
`progress: no question was started`**. The embedding preflight had passed at `13:44:50` — `ok (one vector of
1024 dimensions)` — so the account held credit when the run began and was drained by the run itself. 11,476
live embedding requests were issued, and the question loop had not begun. That is the shape of a defect, not of
a quota, and it is what this section is about.

### 13.37.2 The audit: 11 entries, 6.95 GB, and one that was read

`GET /repos/AgentiX-E/cortex/actions/caches` returned eleven entries totalling 6.95 GB. Three fields per entry
matter — `created_at`, `last_accessed_at`, and size — and they answer the question the workflow's comment had
settled by assertion:

| cache id | size | created | last accessed | key suffix |
| --- | --- | --- | --- | --- |
| `7119462708` | 691,302,445 B | 2026-08-29T15:04:45Z | **2026-10-16T13:44:41Z** | *(none — the bare dataset hash)* |
| `9054925741` | 1,001,342,784 B | 2026-10-16T15:02:12Z | 2026-10-16T15:02:12Z | `-38910134192` |
| `9030207266` | 1,100,096,763 B | 2026-10-16T03:57:12Z | 2026-10-16T03:57:12Z | `-38828538851` |
| `9009810001` | 1,099,782,579 B | 2026-10-15T18:04:12Z | 2026-10-15T18:04:12Z | `-38753835652` |
| `8999392707` | 691,302,483 B | 2026-10-15T14:25:27Z | 2026-10-15T14:25:27Z | `-38725510400` |
| `8971398298` | 1,094,577,381 B | 2026-10-15T02:09:32Z | 2026-10-15T02:09:32Z | `-38659495034` |
| `8957778187` | 1,099,711,460 B | 2026-10-14T19:38:50Z | 2026-10-14T19:38:50Z | `-38595325261` |
| `9050669935` | 216 B | 2026-10-16T13:30:00Z | 2026-10-16T13:30:00Z | `-38908223281` |
| `8943694690` | 212 B | 2026-10-14T14:39:01Z | 2026-10-14T14:39:01Z | `-38582212737` |

`last_accessed_at == created_at` on **every** run-keyed entry. The one entry with a later `last_accessed_at`
is the bare dataset hash, created on **29 August** and last read at `13:44:41Z` on 16 October — by every run
in between, including the four that each saved a cache one and a half times its size.

The mechanism is one sentence of `actions/cache` semantics: **the primary `key:` is tried first, and
`restore-keys` are consulted only after a miss.** The restore step asked for

```yaml
key: longmemeval-embedding-${{ hashFiles('data/longmemeval_s_cleaned.json') }}
restore-keys: |
  longmemeval-embedding-${{ hashFiles('data/longmemeval_s_cleaned.json') }}-
```

and the save step wrote

```yaml
key: longmemeval-embedding-${{ hashFiles('data/longmemeval_s_cleaned.json') }}-${{ github.run_id }}
```

The bare key was a **stale name from before the save learned to append a run id**, and it existed. So the
primary key hit, `restore-keys` were never reached, and the `-<run_id>` entries — the only ones the workflow
could still write — were read by nothing.

§13.24.2 made that change and stated its effect: *"the save key now carries `github.run_id` and the restore
matches on the dataset-hash prefix, so the cache is written by every run and read by the next."* The first
half is true. The second half is what the `last_accessed_at` column above measures, and it is false — **the
repair left the old key in the slot that decides**, and that slot is the primary key: a primary key that hits
is a primary key that ends the search.

### 13.37.3 What it cost, measured

Three consecutive runs, from their logs:

| run | restored | saved | `Relevance index` built in | job |
| --- | --- | --- | --- | --- |
| `38753835652` | **170,095 vectors** (659 MB) | 1,099,782,579 B | 1h37m42s | 3h21m27s |
| `38828538851` | **170,095 vectors** (659 MB) | 1,100,096,763 B | 1h49m23s | 3h40m48s |
| `38910134192` | **170,095 vectors** (659 MB) | 1,001,342,784 B *(died inside the build)* | — | 1h17m33s |

The same 170,095 every time, and a save 1.59x larger than the restore each time. The delta is the turns the
run re-embedded because the entry holding them was under a key the restore did not ask for.

`buildRetrievalRelevanceIndex` is the whole of that time — it is the one pass that runs before the question
loop, over all 500 questions' haystacks (`Relevance index: 32000 scored (question, turn) pairs over 500
questions at topK=64` is its completion line, and the failed run never reached it). **1h38m–1h49m of a
~3h20m job, half the wall clock, spent re-deriving vectors the previous run had already computed and saved.**
It also sits *outside* the §13.30 wall-clock ceiling, which bounds the question loop: the budget could not
have ended a pass that was spending its time here even if it had been reached.

And this is what drained the account. 11,476 requests × 3 paid runs of the same ~100k texts.

### 13.37.4 The other half, without which the first half is worse than the bug

Repairing the key alone makes the **newest** entry the one every run reads. Two of the newest run-keyed entries
were **216 and 212 bytes**, and their size is not an accident: `serializeEmbeddingCache` emits a 13-byte header
for an empty map, and a compressed copy of that header is ~216 bytes.

| run | size published | what the run did |
| --- | --- | --- |
| `38908223281` | 216 B | threw in `cortextMemoryArmOptions` (`run-ablation.ts:189`) — **before** the restore merged |
| `38582212737` | 212 B | hung before its first embed |

Both reached the failure path, which calls `persistArmEmbeddingCache` on the way out *deliberately* — "a run
that dies at question 300 of 500 has still paid for its embeddings" — and both wrote an **empty** file over the
691 MB file the workflow had just restored into the same directory. That call also destroyed the workspace
copy, not merely the published one.

So the two defects are one change, and this is the reason it is one change rather than two commits: ship the
key repair alone and the next dispatch restores 216 bytes and re-embeds ~270k texts **from an account that is
already dry**.

`persistEmbeddingCache` now refuses to write an empty snapshot, and `bench/run.ts` — which had the same
unconditional `writeFileSync` at two sites, in the other workflow that shares this cache — routes through the
same function. **This reverses a previously documented decision**, and the reversal is on the record: the
docstring that argued for writing the empty cache reasoned about the file *in the workspace*, and the file in
the workspace is not the copy that gets published. The dataset worry it raised is answered by the cache key
rather than by the file — `hashFiles` is in the key, so a file embedded from an older dataset cannot be
restored under a newer dataset's key, and a cross-dataset prefix restore only ever returns vectors for turn
texts that are literally identical.

### 13.37.5 The rule, so the class is closed rather than this instance

`tools/__tests__/test_embedding_cache_key.py` already pinned three properties of the save/restore pair: the
save key is unique per run, a prefix of it appears in some `restore-keys`, and the dataset hash is in it. All
three passed while this defect was live. The guard pinned **the pattern, and the defect was in the half of the
pattern it did not name**: the restore's primary key.

The rule added is exact and needs no knowledge of the cache store:

- a restore primary key must not be **strictly extended** by the save key — otherwise the primary name is one
  no save writes, so any entry under it is older than every run-keyed entry, and a hit on it suppresses the
  prefix fallback entirely;
- and, with the sign flipped, the restore primary key must not strictly extend the save key, which is the same
  name-nothing-writes defect.

The repair asks for the name **this run will write** — `...-${{ hashFiles(...) }}-${{ github.run_id }}-${{
github.run_attempt }}`, in both workflows, for both the restore and the save. The primary key therefore misses,
the prefix list resolves to the most recently created entry, and `run_attempt` in both keys is what makes a
**re-run resume from its predecessor's attempt** rather than from scratch.

This is the fourth consecutive instance of one defect class in this campaign, and the largest: §13.24's
docstring described code that did not exist, §13.34.6's workflow trigger check was a text grep, §13.36's
rendering comment claimed a census test that cannot exist, and both workflow comments here stated that the
prefix restore "means the next run picks up whichever entry was written most recently" — which three
consecutive runs' `last_accessed_at` values disprove. **A claim and a check have to be the same thing, and a
comment is not a check.**

### 13.37.6 Verification

- `pnpm check` **exit 0**; four coverage dimensions **100%** in every package except `cortex-node`'s branch
  column (§13.29). `tools`: **317 passed + 40 subtests** (was 316; the new rule is the +1).
- Both new guards were run against the **unfixed** tree first and failed with the message they were written to
  produce — the Python rule on `benchmark-cortex-memory.yml`, and the TypeScript rule on 8 tests including the
  one that used to assert the old behaviour (`persists an empty cache as a valid file rather than skipping the
  write`), which is now its reverse.
- The new tests use real files in a temp directory and the real `serialize`/`deserialize` pair; no mocks, and
  the empty-snapshot rule is asserted from **bytes on disk** (`readFileSync(...).equals(before)`) rather than
  from a flag.
- One test asserts the **count returned by the persist call** and three assert the sentence
  `describeEmbeddingCachePersist` produces, so a skipped publish cannot be silent in the log again — which is
  how two 216-byte entries sat in the store unnoticed for seven weeks.

### 13.37.7 The acceptance run

Run **`38939122161`** on `63c5ce9e`, dispatched **on purpose** against the account that is still dry, by
§13.24.3's method: a run that is expected to fail is still the only way to observe which cache the restore
resolves to, and either outcome is informative. Job `17:22:05Z` to `17:23:23Z` — **78 seconds**, `failure`.

| acceptance criterion | what the log says |
| --- | --- |
| the prefix path fires at all | `Cache hit for restore-key: longmemeval-embedding-fc18…-38910134192` |
| it resolves to the most recent entry | `Cache restored from key: …-38910134192`, `Cache Size: ~955 MB (1001342784 B)` |
| the new save key is written | `Cache saved with key: …-38939122161-1` — `run_id` **and** `run_attempt` |
| an empty snapshot is refused | `Embedding cache: nothing to persist, …/embedding-cache.bin left as restored` |
| a dry account is named, not inferred | `embedding preflight failed against openai-compatible (model=embedding-3): … 429 … {"error":{"code":"1113"…}}` |
| the failure record again | `progress: no question was started before the failure` |

`Cache hit for **restore-key**` is the action's own wording for "the primary key missed and a prefix matched",
which is the sentence this repository had never produced. Before the repair the same delivery was
`Cache hit for: …<bare hash>` — the primary, and the end of the search.

**78 seconds against 1h17m33s** for the same dry account before the repair. The difference is that the run no
longer spends 77 minutes re-embedding before it discovers it cannot embed at all.

**One residual, measured rather than hidden.** A run that dies at the preflight still has the *restored* file
on disk, so the save step re-publishes ~1.0 GB under a fresh key. That is the new rule behaving as specified —
"left as restored" — and it costs store churn rather than correctness: the re-published bytes are the ones the
restore just read, the store is bounded by the 10 GB LRU budget, and a run does this at most once.

### 13.37.8 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The `ask: enumerated` reading. **Not produced**: §13.34.5's five predictions remain unadjudicated, and the account must be topped up before any dispatch can start | **yes** |
| **P0 (done)** | The cache coupling: the restore's primary key now names the entry this run writes, and an empty snapshot is never published | no |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P1 | The **no-signal control** (§13.22.8) | no (dispatch later) |
| P2 | The writer's reduced manifest is not uploaded; the inline reduction marker is ambiguous | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

The experiment is where it was: `ask: enumerated` has not been measured, because the run that was to measure it
died before question 1 of 500. What changed is that the run no longer has to re-derive half its inputs to get
there — the first dispatch after the top-up restores ≈1.0 GB of vectors and should reach the question loop in
minutes rather than in 1h49m, which also puts the §13.30 ceiling back in charge of the pass it bounds.

---

## 13.38 The taxonomy behind a registered prediction was not in the repository

### 13.38.1 What the readout needs, and what exists

§13.34.5 registers five predictions for the run in flight. The second is:

> **MR's wrong answers stop being numeric mismatches.** 41 of 47 → **≤ 25**, which is the counting half.

`numeric_mismatch` appears **twice** in this document — as the largest row of §13.26.4's taxonomy and as the
subject of that sentence — and in **no file of the repository**:

```
$ grep -rn "numeric_mismatch" .
./docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md
```

The 41 was produced by a script that was run once and not committed. So the readout was going to be: write
another ad-hoc script, get some number, and compare it to 41 — with no way to tell whether a difference was
the run moving or **the rule being re-invented**. That is a registered prediction resting on a claim about a
script, and it is the same defect class as §13.37 one layer down: a number whose instrument is not a thing
that exists.

Two archived rosters make this checkable rather than arguable. Their reports are not in the repository, but
the per-question records they are built from now are:
`tools/__tests__/fixtures/mr-roster-38595325261.json` and `mr-roster-38828538851.json`, 121 MR questions each.

### 13.38.2 The calibration found two rules, not one

The definitions were **recovered by requiring them to reproduce the published tables**, and the result is that
**no single rule reproduces both**:

| published table | numbers | reproduced exactly by |
| --- | --- | --- |
| §13.26.4, run `38595325261` | `abstention 24 / plan 4 / soft 2 / numeric 31 / long 2 / other 7` | plan bucket applied, `numeric_mismatch` = **first** number on each side differs → **all six exact** |
| §13.34.4, run `38828538851` | `wrong 47, of which 41 are numeric` | `plan_output` **folded into** `numeric_mismatch`; the taxonomy's own precedence gives **39** |

The two records that separate them are the whole of the disagreement: a counting question answered with
`Let me gather all mentions ... **Session 6**`. Its gold and its prose both carry numbers, so a rule without
the plan bucket scores it as a numeric mismatch; the taxonomy scores it as `plan_output`.

The numeric rule itself is also pinned by calibration rather than by preference. Seven readings of "the numbers
disagree" were tried against the detailed table:

| reading | `numeric_mismatch` on run `38595325261` |
| --- | --- |
| **first number on each side differs** | **31** |
| multisets differ (§13.26.4's literal wording) | 32 |
| the answer's numbers are not a subset of the gold's | 32 |
| the last numbers differ | 32 |
| first differs or the counts differ | 32 |
| no number appears on both sides | 28 |
| the gold's numbers are not a subset of the answer's | 28 |

One reading out of seven gives 31, and it is the one adopted. The semantic story offered for it — a counting
question leads with the quantity it asks about, on both sides — is a **plausibility and not the evidence**;
the evidence is the exact match on all six rows. That distinction is written into the tool, because a
definition justified by a story would be indistinguishable from one that fits.

### 13.38.3 What this changes about §13.34.5, and what it does not

The prediction is **not** amended. It was written against 41, 41 is reproducible, and the readout will report
it. What changes is that the readout reports **both** and names which is which:

| reading | run `38828538851` | what it is |
| --- | --- | --- |
| `numeric_mismatch`, `plan_output` folded in | **41** | §13.34.4's number, and the one prediction 2 is stated against |
| `numeric_mismatch`, taxonomy precedence | **39** | the number whose rows define the vocabulary |

Registering a second definition of a word the same document already uses is the risk this creates, so the
tool prints both on every run rather than leaving the fold to a reader's memory. A prediction re-read against a
number it was not written against would be a redraw, which §4 forbids.

### 13.38.4 The instrument

`tools/classify-raw-outputs.py` gains the taxonomy beside its existing abstention classifier:

- `failure_shape(record)` → one of `abstention`, `plan_output`, `soft_refusal`, `numeric_mismatch`,
  `long_prose`, `other`, with the precedence documented in the source and two of its orderings pinned by tests:
  a plan output outranks the numbers in its own body, and a numeric mismatch outranks `long_prose`.
- **The abstention family comes from `classify()`**, the function the existing report already uses, so the two
  reports in one file cannot disagree about what a bare token is. That is §13.36's rule applied to itself.
- `failure_census(questions)` counts only the **non-correct** questions: every shape here is a way of being
  wrong, and counting a correct answer's length would put it in a bucket whose name then describes the wrong
  population.
- `--failures` prints the table, the definitions, and both comparability lines.
- The module docstring's usage line said `--dataset MR` while the parser has always defined `--capability`.
  A reader copying the documented invocation would have got `unrecognized arguments`. Fixed here.

### 13.38.5 Verification

- `pnpm check` **exit 0**; `tools` **338 passed + 40 subtests** (was 317; +21 by this section); coverage
  dimensions unchanged and still 100% except `cortex-node`'s branch column (§13.29) — no TypeScript changed.
- **Red first.** The 21 new tests were written before the implementation and 17 of them failed; the four that
  passed were the ones asserting the sentinel rules `classify` already owned.
- **The calibration is a test, not a claim.** `TestThePublishedTablesAreReproducible` requires all six numbers
  of §13.26.4's row and the 41/39 pair of §13.34.4 from committed fixtures, so a later edit to any rule fails
  in CI instead of quietly producing a different number under the same name.
- **One test of mine was wrong and is corrected rather than worked around.** I asserted `{groundTruth: '3',
  answer: '2'}` with no `rawOutput` classifies as `other`; it is a numeric mismatch, because the rule that
  reads it does not consult the raw output at all. The test now asserts what it was for — a missing raw output
  is not an abstention — and separately that a missing raw output does not suppress the rules that do not
  read it.

### 13.38.6 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Read run `38941095220` (`ask: enumerated`, in flight since `17:37:56Z`) against §13.34.5 — abstentions first, then the mismatch count, **now with a committed classifier** | no (in flight) |
| **P0 (done)** | The cache coupling (§13.37), and the taxonomy behind prediction 2 (§13.38) | no |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3: a registered change, not a cleanup) | no |
| P1 | The **no-signal control** (§13.22.8): separates "the extra turns" from "the ordering". Its mechanism already exists (`cortex_memory_relevance: none`); what it needs is a registered dispatch | no (dispatch later) |
| P2 | The writer's reduced manifest is not uploaded; the inline reduction marker is ambiguous | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

The prediction's instrument now exists, so the readout is executable the moment the run lands. Nothing else in
the P0 row was blocked by the provider, which is why this section was writable while the run was in flight.

---

## 13.39 Run `38941095220`: no reading, two defects, and the first honest cost accounting

### 13.39.1 What happened, in one table

The `ask: enumerated` dispatch ran `79m14s` and ended `failure`. Its artifact is 4,820 bytes.

| time | event |
| --- | --- |
| `17:37:59` | embedding preflight `ok` — the balance is live |
| `17:38:06` | **`Restored 239456 embedding vectors`** — the §13.37 repair reading a run-keyed key |
| `18:04:57` | `Relevance index: 32000 scored …` — **26m51s**, after which 21,709 vectors had been added |
| `18:28:47` | reference-pipeline `run=0` complete, 500/500 |
| `18:44:07` | cortex-memory `run=0` complete, 500/500 |
| `18:56:58` | reference-pipeline `run=1` **died at q=391** on `TimeoutError` |
| `18:57:09` | `Embedding cache: persisted 261165 vectors` |

**No prediction of §13.34.5 can be adjudicated**: the report is written only on success, and this run produced
none. What it did produce is two defects and the first measurement of what the §13.37 repair actually bought.

### 13.39.2 The cache repair, measured

`239456` restored, `261165` persisted. The repair works — a run-keyed key was read for the first time — and the
residual §13.37.7 recorded as "store churn rather than correctness" is **larger than that sentence implied**:
the 21,709 missing vectors cost **26m51s** of the 79-minute run, because the entry restored was the *955 MB*
one rather than the *1.10 GB* one.

The mechanism is worth stating because it is a direct consequence of the other half of the repair: the
acceptance run `38939122161` died at the preflight, left the restored file on disk, and republished it under a
fresher key. `restore-keys` resolves to the **most recently created** entry, so re-publishing content the entry
already had pinned the newest entry to the smaller cache — the 1.10 GB entries written by §13.32's and §13.26's
runs became unreachable by recency.

This is self-correcting as long as a run finishes enough work to publish a larger file, and this one did
(`261165`). It is recorded as a measured property rather than as a footnote: **a run that publishes only what it
restored can delay the cache's convergence by one full index build.**

### 13.39.3 Defect 1: a finished repetition was as disposable as a dead one

`benchmark-cortex-memory-partial.json`, written by the failure path exactly as §13.31 specifies:

```json
{"reached": 390, "total": 500, "run": 1, "baselineAnswers": [390], "featureAnswers": []}
```

**Repetition 0 had completed both sides at 500 of 500 each.** A complete, paired, N=500 measurement was in
memory when the failure path ran, and `featureAnswers` is an empty list.

§13.31 closed the same loss one repetition earlier: run `38520676669` "completed repetitions 0 and 1 on both
sides — two thousand graded answers — and died on `TypeError: terminated` at the start of repetition 2", and
the repair gave the **dying** repetition a sink and a catch. The rule it wrote down was broader than the
repair: *"a repetition is a measurement, and losing one silently is the defect that file exists to prevent."*
Only the dying one was ever durable.

`PartialAblation` now carries `completed: CompletedPass[]` — every repetition that finished, both sides, in
dataset order — and `runAblation` records repetition 0 where it ends and every later one at the bottom of its
loop. **Nothing is computed from them**: `delta` is still absent from a partial, because the registered
statistic is over four repetitions and a recovered repetition is a complete vector — the exact shape that
invites the subtraction §13.31 forbids. The reading a recovered repetition supports is labelled `1 of 4`, not
the pre-registered number.

### 13.39.4 Defect 2: the deadline covered the headers and not the body

The transport accounting from the same failing run:

```
{"attempts":6702,"retried":0,"rateLimited":0,"calls":6702,"retriedCalls":0,
 "cleanCalls":6702,"exhaustedCalls":0,"retryRate":0}
```

**Zero retries and zero exhausted calls across 6,702 calls, while a `TimeoutError` killed the process.** Those
two facts are jointly true in exactly one way. `attemptSignal` arms `AbortSignal.timeout(timeoutMs)` on the
**request**; `fetch` resolves as soon as the **headers** arrive; `retryableFetchWithStats` returns that
response. The deadline is therefore still armed when the **caller** reads the body — and a body still arriving
when it fires rejects at the caller's `res.json()`, one frame above the retry loop, where the call has already
been counted `clean` and no attempt is open to retry.

§13.31's comment named this possibility verbatim — *"a single abort from somewhere the retry loop does not
wrap"* — and listed it as the question that decides whether the right response is a re-dispatch or a code
change. It is now answered, and it is a code change.

**The repair**: an attempt is the complete exchange. The body is read inside the same `try` that issues the
request (`withBufferedBody`), so a body-level abort is a transport failure like any other and takes the
ordinary backoff and retry path; the response handed back is rebuilt from those bytes, so no caller changes.
What is *not* changed: the deadline's value, the retry count, the backoff, and the status classification.

### 13.39.5 Verification

- `pnpm check` **exit 0**; four coverage dimensions **100%** in every package except `cortex-node`'s branch
  column (§13.29). `tools` **338 passed + 40 subtests**; `cortex-llm` **149** (+3); `cortex-eval` **1888** (+5).
- **Red first, both fixes.** The five `completed` tests failed against the unfixed tree with
  `partial.completed` undefined; the deadline test failed by **resolving**, which is the defect itself — the
  loop returned a live stream and the abort happened outside every counter.
- **The deadline test is a discriminator, not a description.** Its fake returns headers immediately and never
  finishes the body, so it can only pass if the wrapper reads the body inside its own `try`. Two companion
  tests keep the buffering honest: a completed response must still yield its status, its headers and its parsed
  JSON, and a `204` with no body must still yield its status.
- **One test of mine was wrong and was corrected rather than worked around.** The first version of the
  `completed` tests assumed a single call counter shared by both systems; `countingSystem` counts its own
  calls, so the ordinals were twice what they should have been and every test resolved instead of rejecting.
  A probe run against the real ablation pinned the order (`base` 1-5, `feat` 6-10, `base` 11-15, …) and the
  ordinals were corrected from the measurement.

### 13.39.6 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Re-dispatch `ask: enumerated`. §13.34.5's five predictions are still unadjudicated; the instrument for prediction 2 exists (§13.38), and two of the three ways this dispatch could lose its work are now closed | **yes** (balance live) |
| **P0 (done)** | The cache coupling (§13.37); the taxonomy behind prediction 2 (§13.38); a finished repetition is durable (§13.39.3); the deadline covers the body (§13.39.4) | no |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3: a registered change, not a cleanup) | no |
| P1 | The **no-signal control** (§13.22.8): the mechanism exists as `cortex_memory_relevance: none`; it needs a registered dispatch | no (dispatch later) |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build (§13.39.2); the writer's reduced manifest is not uploaded; the inline reduction marker is ambiguous | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

The three ways this run could have kept its work were: the cache (fixed in §13.37 — and it did keep it: `261165`
vectors), the completed repetitions (fixed here), and the abort (fixed here). The next dispatch is the same
request with strictly more of its own work protected, which is the whole of what this iteration bought.

---

## 13.40 Run `38953157688`: the reading, and the channel the register did not name

### 13.40.1 The run

`ask: enumerated`, `19:12:17Z` → `21:05:50Z`, **1h53m33s**, `success`, artifact 6,917,136 bytes. The §13.37
cache repair delivered what §13.39 predicted it would:

| line | value |
| --- | --- |
| `Cache hit for restore-key` | `…-38941095220-1` — the previous run's entry, resolved by prefix ✓ |
| `Restored` | **261,165** vectors |
| `Relevance index: 32000 scored …` | built in **26 seconds** — against **26m51s** in §13.39, a **62x** change |
| `Embedding cache: persisted` | 261,354 (189 new) |

**The index build is now effectively free.** The 79-minute run of §13.39 and this 114-minute run differ by a
factor of 62 on the pass that used to dominate, and the difference is one repaired key.

### 13.40.2 The five predictions

| # | registered | observed | verdict |
| --- | --- | --- | --- |
| **1** | MR abstentions **22 → ≤ 12** | **33** | **falsified**, and with the opposite sign to the prediction |
| **2** | MR numeric mismatches **41 of 47 → ≤ 25** | **not adjudicable** | the bucket names a population that no longer exists — see §13.40.3 |
| **3** | MR **≥ 48%** (58/121) | **58/121 = 47.93%** | **met by the count spelling, missed by 0.07pp on the percentage spelling** — and not attributable to the contract (below) |
| **4** | arm delta **> +25.75pp** | **+26.75pp** (0.7000 vs 0.4460; McNemar p = 3.911e-14; 207 won / 80 lost; over four repetitions min 0.700, max 0.728, median 0.711) | **met — the arm's best delta** |
| **5** | IE, KU, TR within **±3 questions** of §13.26 | IE 133→132 (−1), KU 62→61 (−1), TR 72→70 (−2), ABS 29→29 (0) | **met, and clean** — §13.40.4 |

The register's own arithmetic is worth a line because it decided a verdict: it wrote **both** "≥ 48%" and
"(58/121)", and those disagree by a rounding step — 58/121 is **47.934%**. One spelling is met and the other is
missed by 0.07pp, and this section reports the miss rather than the match.

Its falsifier list is also incomplete in a way that this run met: every falsifier for prediction 1 covers the
abstentions **falling** too little, or the accuracy not moving. None covers the abstentions **rising**, which is
what happened, so the prediction was falsified by a direction the register had not written down.

### 13.40.3 Why prediction 2 cannot be read, and it is not a formality

`numeric_mismatch` requires the *answer* to carry a number. Under `enumerated` the arm's answer for MR is a
**349-character transcript** (§13.40.5), so the taxonomy classifies transcript shapes, not the model's
arithmetic: `plan_output` 30, `numeric_mismatch` **0**, abstention 33. The §13.38 instrument is doing exactly
what it is specified to do; the field it reads stopped meaning what the register assumed it means.

So prediction 2 is **not adjudicated**, and the reason is recorded: its baseline (41) and its subject (the
number the model computed) are both expressed in terms of a field that this run's ask replaced. Fixing the
field is §13.40.5; re-reading this run through the fix is §13.40.7.

### 13.40.4 The confound: the ask changed which scorer decides

This is the finding the register did not name, and it bounds every MR number above.

| run | MR correct | gate-decided | gate-true | judge-decided | median answer length |
| --- | --- | --- | --- | --- | --- |
| `38595325261` `computed` | 51 | 86 | **37** | 35 | **3** |
| `38828538851` `session-fill` | 52 | 89 | **36** | 32 | **2** |
| **`38953157688` `enumerated`** | **58** | **33** | **0** | **88** | **349** |

Per capability, `computed` → `enumerated`:

| capability | correct | gate (true) | judge | step headings in the raw |
| --- | --- | --- | --- | --- |
| ABS | 29 → 29 | 30 (29) → 30 (29) | 0 → 0 | 0 → 0 |
| IE | 133 → 132 | 90 (75) → 88 (73) | 60 → 62 | 0 → 0 |
| KU | 62 → 61 | 28 (26) → 27 (23) | 44 → 45 | 0 → 0 |
| **MR** | **51 → 58** | **86 (37) → 33 (0)** | **35 → 88** | **0 → 117** |
| TR | 72 → 70 | 35 (0) → 42 (0) | 92 → 85 | 0 → 0 |

The gates are the mechanical channels -- normalized equality and the numeric gate -- and they decide **every
verdict they can**. Under `enumerated` they decided 27% of MR's verdicts against 71% before, and **not one of
them was a true verdict**. MR's +7 is therefore entirely judge-accepted, and the judge was asked whether a
349-character transcript "matches" a gold like `3.5 weeks`.

So **prediction 3 is not attributable to the answer contract.** It is a joint statement about the contract and
about `judgeScorer`'s tolerance of a long enumerated list, and the register treated it as the former.

Predictions 4 and 5 inherit this only where MR contributes: prediction 4's delta is MR's movement plus four
controls that did not move, and prediction 5's three controls are the part that is clean.

### 13.40.5 The defect under all of it: the answer was the transcript

`parseAnswer` returns the **whole** trimmed response as the answer. `computed`'s MR responses have a median
length of **3 characters**, so "the whole response" and "the answer" were the same thing and the difference was
invisible for four runs. `enumerated` made them differ by two orders of magnitude:

```
Step 1 — list every item in the evidence that matches the question, one per line, with the date it was stated. …
- [2023/05/21 (Sun) 09:03] I am planning a project in Nigeria that connects 100 rural villages to running water.
…
Step 2 — compute the answer from that list, exactly as the question asks: …
3
```

The model writes the contract back out, fills in the list, and puts its answer on the final line. **41 of the
121 responses end with a line that IS the gold.** The arm returned all 349 characters.

**The repair**: when a response contains a step heading, the answer is what follows the **last** one, and the
abstention rule is still read **first** -- 29 of those responses write the Step 1 list and then the sentinel, and
a heading rule running first would score them as answers and move prediction 1's number from 33 to 4.

**Why it cannot change a published number.** A step heading appears in **0 of the 1,000** questions of runs
`38595325261` and `38828538851`, and in **118** of run `38953157688`'s 121 multi-session questions. The rule is
keyed on the heading rather than on length, so a long prose answer with no step in it is still returned whole,
and every archived number stays exactly as it was. That is measured, and the coupling is guarded: the test
builds a **real** `enumerated` multi-session prompt, reads the headings out of it, and requires the parser to
parse an echo of them -- which also fails if the contract stops reaching that route at all.

**The boundary, stated rather than guessed.** Of the 118 step-headed responses, **118** put the answer on its
own line after the last heading and **0** put it on the heading line. A heading with nothing after it is
therefore scored as a **blank answer**, which scores nothing, and never as the transcript. The unobserved shape
is answered conservatively, because the alternative is the defect this repair exists to remove.

### 13.40.6 What the repair does and does not restore, measured

Applying the repaired parser to this run's raw outputs, offline, and re-running the real scorer with the judge
stubbed so that only the gates can decide:

| | gate-decided | gate-true | judge-decided | median answer |
| --- | --- | --- | --- | --- |
| as run | 33 | 0 | 88 | 349 |
| **repaired parser** | **74** | **6** | **47** | **23** |

So the repair moves 41 verdicts back to the gates, and the gates verify **6** of them. `computed`'s gates
verified 37 of 86, so the contract's own answer *format* -- "3 days" where the gold is "3", "the total is 45
minutes" where it is "45" -- is also less mechanically checkable than a bare value. The repair recovers the
structure; it does not restore like-for-like, and §13.40.7 says so before the number exists.

### 13.40.7 Registration: the same dispatch with the repaired parser

Dispatched before this section was written, one variable against §13.40's configuration: the arm's parser.

| # | prediction | falsified if |
| --- | --- | --- |
| 1 | **The abstention count is unchanged at 33.** The abstention rule is read before the heading rule, so the repair cannot move it; a movement means the precedence is not what §13.40.5 says it is | outside 30–36 |
| 2 | **The gate-decided share of MR rises to about 74 of 121** and the judge-decided share falls to about 47 | gate below 60 |
| 3 | **MR's accuracy falls below 47.93%.** The judge stops being asked to accept a transcript; the offline bound is 6 gate-true, so unless the judge accepts almost all of the 47 it still sees, MR lands far below 58 correct | MR stays at or above 58 |
| 4 | **The delta falls below +26.75pp**, most of the movement being MR's | delta stays at or above +26.75pp |
| 5 | **IE, KU, TR and ABS are unchanged** — the repair is inert on them: 0 step headings each | any of them moves by more than 3 questions |

**The reading rule, registered with the predictions.** If MR falls, then §13.34's contract did not improve MR:
its 47.93% was a transcript being judged, and the honest comparison for `enumerated` becomes the repaired number
against §13.26's **42.15%**. A fall to around 30–40% would make the two-step contract a **regression on MR**,
and the next thing to isolate would be the contract's answer format (§13.40.6) rather than its two-step
structure.

### 13.40.8 Verification

- `pnpm check` **exit 0**; four coverage dimensions **100%** in every package except `cortex-node`'s branch
  column (§13.29). `cortex-memory` **345** tests (+7).
- **Red first**: the six behavioural tests failed against the unfixed parser, and the seventh -- the coupling
  guard -- failed on the export that was removed rather than kept.
- **Two of my own assertions were wrong and were corrected from measurement rather than worked around.** The
  first assumed a test fixture could share one call counter across both systems; the second asserted a
  "heading with the answer on the same line" shape that **0 of 118** responses produce. Both were replaced by
  what the data supports, and the unobserved shape is now covered as a stated boundary instead of a guess.
- The new exports the first draft introduced were removed rather than added to the census ledger: the guard now
  drives a real prompt, so nothing is exported for a test's benefit alone.

### 13.40.9 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The repaired-parse dispatch is **in flight**; §13.40.7's five predictions are registered | no (in flight) |
| **P0 (done)** | The cache coupling (§13.37); the taxonomy behind prediction 2 (§13.38); the finished-repetition loss (§13.39.3); the body-deadline hole (§13.39.4); the transcript answer (§13.40.5) | no |
| **P1** | **The register's comparison discipline**: `ask` changes the answer's *shape*, which changes *which scorer decides*. Every future ask registration must state the expected gate/judge split, or its accuracy number cannot be attributed | no |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P1 | The **no-signal control** (§13.22.8) | no (dispatch later) |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build (§13.39.2); the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

**The first honest reading of `ask: enumerated` is that it is not yet a reading of `ask: enumerated`.** Two of
its five predictions were answered (4 and 5, both met, one of them cleanly), one was falsified (1), one could
not be adjudicated (2), and one moved through a scoring channel the register did not name (3). The next number
is the one that removes the channel from MR.

---

## 13.41 The five predictions, and the gate that read an operand

### 13.41.1 The run

`38985220145` on `40c753ed`, `00:12:19Z` → `01:56:18Z`, **1h44m48s**, `success`, artifact 6,906,159 bytes.
§13.40.7's dispatch: the same `ask: enumerated` with one variable changed — the arm's parser.

| line | value |
| --- | --- |
| `Cache hit for restore-key` | `…-38953157688-1` (the previous run's own entry) |
| `Restored` | **261,354** vectors |
| `Relevance index: 32000 scored …` | **23 seconds** — §13.40 was 26, §13.39 26m51s |
| `Embedding cache: persisted` | 261,738 (**384 new**) |

The index build is now a fixed cost of half a minute, and the cache converges on its own: each run adds only the
turns the previous one had not embedded (`261,165 → 261,354 → 261,738`).

### 13.41.2 All five predictions were met

| # | registered in §13.40.7 | observed | verdict |
| --- | --- | --- | --- |
| **1** | abstentions unchanged at **33** | **35** | **met** (inside 30–36) — the precedence is what §13.40.5 says it is |
| **2** | gate-decided ≈ **74**, judge ≈ **47**; falsified below 60 | gate **77**, judge **44** | **met** |
| **3** | MR falls below **47.93%**; falsified if it stays ≥ 58 correct | **29/121 = 23.97%** | **met** |
| **4** | delta falls below **+26.75pp** | **+23.25pp** | **met** |
| **5** | ABS, IE, KU, TR unchanged within ±3 | ABS +1, IE −1, KU −1, TR **+3** | **met** |

Every prediction in a register of five was met, including the two that were predictions of a *fall*. The TR movement
of exactly +3 sits on the boundary of prediction 5's tolerance and is recorded as such rather than as a pass.

**And the fall is real.** MR went 58 → 29 because the transcript stopped being judged: the gate-decided share rose
33 → 77 and the judge-decided share fell 88 → 44, which is the channel shift §13.40.7 predicted and the reason the
58 was not a measurement of the contract's answer quality. `enumerated` on MR was, at 47.93%, a transcript being
accepted by a judge; the honest number for that configuration is **23.97%**, which is **−18.18pp against
§13.26's 42.15% for `computed`**. On the evidence of run `38985220145` alone, the two-step contract is a
regression on the counting half of the benchmark.

### 13.41.3 The second defect, and it is older than the contract

That conclusion was wrong, and what made it wrong was found by looking at *which* 92 records failed.

| | count |
| --- | --- |
| MR non-correct | 92 |
| of those, the answer is `null` (a decline) | 35 |
| of those, answered and wrong | 57 |
| of those, the answer's numbers differ from the gold's | **52** |

Reading the 52, the largest group was not arithmetic errors at all:

```
gold "17 days"    answer "10 days + 7 days = 17 days"        ->  marked WRONG
gold "$2,500"     answer "$800 + $1,200 + $500 = $2,500"     ->  marked WRONG
gold "$495"       answer "$225 + (20 x $7.5) + $120 = … = $495."  ->  marked WRONG
gold "190"        answer "440 total pages - 250 pages read = 190 pages left."  ->  marked WRONG
```

The arithmetic is right in every one of them. The gate read the **leading** number — the first operand — compared
it with the gold's total, and returned `false`.

`numericAnswerVerdict` compares `extractLeadingNumber(predicted)` with `extractLeadingNumber(expected)`. That rule
was correct for every run before this one, because every run before this one had bare answers: `computed`'s MR
answers have a median length of **3 characters**, so the leading number *was* the answer. §13.40.5's repair made the
answers ledgers, and a ledger leads with an operand.

So the crash of MR from 58 to 29 was **two events with opposite signs**, not one:

| | MR correct |
| --- | --- |
| run `38953157688`, transcript scored | 58 *(not a measurement of the contract)* |
| run `38985220145`, repaired parser, unrepaired gate | 29 |
| …the 28 records whose arithmetic is right but whose leading number is an operand | +28 |
| **the same run re-graded under the repaired gate** | **57** |

### 13.41.4 The rule, and why it is a widening rather than a trade

An answer is accepted when **the gold's value is any number the answer states**:

```ts
const p = extractLeadingNumber(predicted);   // still the deferral gate
const e = extractLeadingNumber(expected);
if (p === undefined || e === undefined) return undefined;
return statedNumbers(predicted).includes(e);
```

For a bare answer this is *exactly* the old comparison — its leading number is one of the numbers it states — so it
cannot reject anything the old rule accepted. It only ever accepts more. And the deferral is untouched: an answer
that does not **lead** with a number still returns `undefined` and still reaches the judge, which is what keeps the
archived runs comparable.

**Measured, on all four archived rosters, offline:**

| run | verdicts the rule changes | of which were recorded wrong |
| --- | --- | --- |
| `38595325261` `computed` | **0** | 0 |
| `38828538851` `session-fill` | **0** | 0 |
| `38953157688` `enum`, transcript scored | **0** | 0 |
| `38985220145` `enum`, repaired parser | **28** | 28 — all false → true, all with correct arithmetic |

Three of the four are **byte-identical**, which is the property that makes the fourth readable rather than a redraw.
The two rules that were tried and **rejected** are recorded because they failed a test rather than an argument:

- *"the gold equals the first or the last number"* — rejected: it rejects `3 items out of 5` against a gold of `3`,
  and on run `38595325261` it turns 7 records from correct to incorrect (TR 6, KU 1). A rule that can reject is not
  a widening.
- *"the gold appears among the numbers"* with the deferral dropped — rejected: it turns 1 further record per run
  from correct to incorrect, because `extractLeadingNumber` is anchored to the start on purpose and an answer whose
  only number is mid-prose is not this gate's to decide.

### 13.41.5 The honest reading, and what it does not settle

Re-grading run `38985220145` under the repaired gate, offline, with the judge's verdicts held fixed (the 28 records
the gate now decides never reached the judge in the first place, so no judge verdict can move):

| | recorded | re-graded |
| --- | --- | --- |
| ABS | 30/30 | 30/30 |
| IE | 132/150 | 132/150 |
| KU | 61/72 | 61/72 |
| **MR** | **29/121 = 23.97%** | **57/121 = 47.11%** |
| TR | 75/127 | 75/127 |
| total | 327/500 | **355/500 = 0.7100** |

**MR at 47.11% is +4.96pp over `computed`'s 42.15%**, and unlike the 58 of §13.40 it is a figure the mechanical
channels verify: gate-true rises 3 → 31 of 77 gate-decided, so 40% of the gate's MR verdicts are provably correct
against `computed`'s 43% (37 of 86). The contract's answer format costs about 3pp of machine-checkability and buys
about 5pp of accuracy.

**The delta is not re-derivable offline and is not claimed.** The registered statistic is the mean over four
repetitions, and the roster this analysis reads is one of them (the worst, `0.654`). Adding the 28 to that
repetition alone moves the mean by `28/4/500 = 0.014`, giving **+24.65pp**; the same 28 in all four gives
**+28.85pp**. The interval is recorded as `[+24.65, +28.85]`, and it contains `computed`'s **+25.75pp** — so this
analysis **does not** establish that `enumerated` beats `computed`. It establishes that the 23.97% was an
instrument's reading, not the contract's.

### 13.41.6 Registration: the same dispatch with the repaired gate

Dispatched before this section was written, one variable against §13.41's configuration: the numeric gate.

| # | prediction | falsified if |
| --- | --- | --- |
| 1 | **MR lands at about 57 of 121 (47%)** — the 28 records the gate now accepts plus the 29 it already accepted | outside 51–63 |
| 2 | **Gate-decided MR rises to about 77 of 121 and gate-true to about 31**, i.e. the channel split returns to roughly `computed`'s | gate below 60, or gate-true below 20 |
| 3 | **The delta lands above +25.75pp** — the interval of §13.41.5 is `[+24.65, +28.85]` and `computed` is the number to beat | at or below +25.75pp |
| 4 | **The other four capabilities are unchanged**: the rule changes 0 verdicts in any of them | any moves by more than 2 questions |
| 5 | **Abstentions stay at about 35** (the parser is unchanged, so the decline rate cannot move) | outside 32–38 |

**The reading rule, registered with the predictions.** Prediction 3 is the one that decides the configuration. If
the delta lands above `+25.75pp`, `enumerated` with the repaired parser and gate becomes the arm's best measured
configuration and the register moves on to the P1 items. If it lands at or below, `enumerated` is a null
result **on the benchmark as a whole** — the contract buys MR accuracy and pays for it elsewhere — and the correct
action is to keep `computed` as the registered default and to record `enumerated` as an ablation reference, not to
keep repairing it.

### 13.41.7 Verification

- `pnpm check` **exit 0**; four coverage dimensions **100%** in every package except `cortex-node`'s branch column
  (§13.29). `cortex-eval` **1899** tests (+6).
- **Red first.** The two behavioural tests failed against the unrepaired gate (`expected false to be true`,
  `expected undefined to be false`), and the second of those was **my own error**: `Distinct citrus fruits: … = 5`
  does not lead with a number, so the gate declines it rather than rejecting it. The test now asserts the deferral
  and a separate test asserts the rejection, so the two arms are distinguished instead of conflated.
- **Two coverage holes were closed by removing dead arms, not by asserting around them.** `statedNumbers` took
  `unknown` and had an unreachable `typeof value !== 'string'` arm; it now takes `string | number` behind an
  `isReadableValue` narrowing that the tests exercise from both sides, and reads with `matchAll` so the `?? []` arm
  cannot exist. The first `pnpm check` after the change reported `metrics.ts 99.31%` and the fix was the arm, not
  the threshold.
- The inertness claim is a **test**, not a sentence: `is a no-op for an answer whose leading number is its only
  number` compares the new verdict against the leading-number comparison on the shapes the archived runs contain.

### 13.41.8 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The repaired-gate dispatch is **in flight**; §13.41.6's five predictions are registered, and prediction 3 decides the configuration | no (in flight) |
| **P0 (done)** | The cache coupling (§13.37); the taxonomy behind prediction 2 (§13.38); the finished-repetition loss (§13.39.3); the body-deadline hole (§13.39.4); the transcript answer (§13.40.5); the numeric gate's operand (§13.41.4) | no |
| **P1** | **The register's comparison discipline** (§13.40.9): `ask` changes the answer's *shape*, which changes *which scorer decides*. It now has a second instance — the shape also changes which *number* the gate reads — so every ask registration must state both the expected channel split and the answer's form | no |
| P1 | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P1 | The **no-signal control** (§13.22.8) | no (dispatch later) |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build (§13.39.2); the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

The iteration's shape is worth stating plainly: a register of five predictions was met in full, and its central
number was still wrong — because the instrument that produced it was reading an operand. **A prediction can be met
by an instrument that is broken in the same direction as the prediction**, and the only defence is to read the
records the number was computed from.

---

## 13.42 The taxonomy was classifying transcripts, because it read the wrong field

### 13.42.1 The number that could not be computed

§13.41.3 reads "of the 57 answered-and-wrong, the answer's numbers differ from the gold's in **52**". That
number did not come from `tools/classify-raw-outputs.py`. It came from an inline analysis of `answer`, because the
committed tool reports something else on the same run:

| | `numeric_mismatch` | `plan_output` |
| --- | --- | --- |
| run `38985220145`, as the tool reports it | **0** | **57** |
| the same run, read from `answer` | **52** | **0** |

**A document and its instrument disagreeing about the central number of a section is the defect this campaign keeps
meeting**, and §13.38 is the section that built the instrument. It calibrated six rules against two rosters and
reproduced both tables exactly. What it did not examine was **which field the rules read** — and on those two
rosters the answer and the raw output are the same string, so the question could not arise.

### 13.42.2 Why it arose

`failure_shape` read `rawOutput` for two of its rules:

- **abstention**, via `classify(rawOutput)`, which recognises the sentinel in the last non-empty line;
- **plan_output**, via `PLAN_OUTPUT.match(rawOutput)`, which recognises "Let me gather" / "Step 1" at the start.

Both are statements about **what the model wrote**, and both were right while the arm returned what the model wrote.
§13.40.5 changed that: `parseAnswer` now returns the model's *answer*, and under `ask: enumerated` the raw output
is a transcript that opens with the contract's own Step 1 line. So `PLAN_OUTPUT` matched every response that echoed
the contract — **57 of 92** — and the plan bucket swallowed the arithmetic before `numeric_mismatch` could see it.

That is the same failure as §13.40.4 one layer down. There, the *ask* changed the answer's shape and thereby which
**scorer** decided; here, the *parser* changed the answer's shape and thereby which **field** the taxonomy read.
Both are statements about a measurement whose instrument was calibrated on a different shape.

### 13.42.3 The repair, and the shape of the guarantee

`failure_shape` now reads **`answer`** for every rule and reads `rawOutput` for none. Concretely:

- a decline is `answer is None`, because `parseAnswer` is what decides a decline and a decline has no answer —
  not "a string ends in a sentinel", which is a rule about the model's text rather than about the arm's decision;
- `plan_output` and `soft_refusal` match the answer;
- `numeric_mismatch` and `long_prose` already read the answer, and are unchanged.

**And an absent `answer` key is now a `KeyError` rather than an abstention.** `record.get('answer')` returning
`None` cannot distinguish a declined record from a report whose schema dropped the field, and the second reading
would report a **100% abstention rate** — which looks exactly like a contract working perfectly. A missing key is a
defect in the report and says so.

### 13.42.4 The invariant, measured on all four rosters

| run | `answer` vs `rawOutput` | census before | census after |
| --- | --- | --- | --- |
| `38595325261` `computed` | identical, or `answer` null | 24/4/2/31/2/7 | **24/4/2/31/2/7** |
| `38828538851` `session-fill` | identical, or `answer` null | 22/2/0/39/0/6 | **22/2/0/39/0/6** |
| `38953157688` `enum`, transcript scored | identical | 33/30/0/0/0/0 | **33/30/0/0/0/0** |
| `38985220145` `enum`, repaired parser | **differ** | 35/57/0/0/0/0 | **35/0/0/52/1/4** |

On the first three the two fields are the same value (or the answer is null), which is why the field change is a
**no-op** for every published table. On the fourth the fields differ, which is why the change is a repair there.

Two of the four rosters are now committed as fixtures — `mr-roster-38953157688.json` and
`mr-roster-38985220145.json`, 121 MR questions each — so the before/after above is a **test**, not a table in a
document. `TestTheRostersTheFieldChangeMustNotMove` asserts the three unchanged censuses; the fourth asserts
`35/0/0/52/1/4`, which is the number §13.41.3 reads.

### 13.42.5 The three tests that had to change, and why that is the point

Three tests from §13.38 failed against the repair, and every one of them failed because it had **encoded the old
coincidence**:

- `test_every_abstention_shape_is_the_abstention_shape` passed `answer: '2'` with a raw output ending in the
  sentinel — asserting that a sentinel in the text *is* a decline regardless of what the arm returned. It now passes
  `answer: None`, which is what a decline is.
- `test_a_plan_output_is_its_own_shape` and `test_step_1_is_a_plan_output` passed `answer: '4'` and `answer: '2'`
  alongside a plan-shaped raw output — asserting that a plan in the text outranks an answer that is a number. They
  now set both fields to the plan, which is the shape every archived roster has.

**The tests were not weakened; they were made to state their own premise.** A test that reads two fields and sets
only one is asserting that the other does not matter, and on these rosters that was true by accident.

### 13.42.6 Verification

- `pnpm check` **exit 0**; four coverage dimensions **100%** in every package except `cortex-node`'s branch column
  (§13.29). `tools` **347 passed + 40 subtests** (was 338; +9 by this section and §13.41).
- **Red first**: four of the nine new tests failed against the unrepaired tool — the step-headed transcript case,
  the right-answer case, the missing-key error, and the `38985220145` census.
- **A missing key is tested to raise**, not to fall through: `pytest.raises(KeyError, match='answer')`.
- Two new fixtures, 97 KB and 149 KB, carrying only the six fields the tool reads and a `provenance` block naming
  the run, the workflow, the artifact and the arm's configuration.

### 13.42.7 Status after this section

The P0 row is unchanged: §13.41.6's five predictions are registered against the dispatch that the numeric-gate
repair requires, and prediction 3 decides whether `enumerated` becomes the arm's registered configuration or an
ablation reference.

What changed is that **the taxonomy can now be read against an enumerated run at all**. Before this section,
`tools/classify-raw-outputs.py --failures` on such a run reported `numeric_mismatch: 0`, and a reader comparing that
with §13.34.5's registered prediction would have concluded the contract had eliminated numeric errors — which is the
opposite of what happened.

---

## 13.43 A report has to say which field it counted

### 13.43.1 What the two reports said, and how a reader would have read them

After §13.42 the tool has two reports that classify **two different strings**:

| invocation | field | run `38985220145`, MR |
| --- | --- | --- |
| default | `rawOutput` — the text the model wrote | `bare 2 / prose-then-token 33 / other 86` |
| `--failures` | `answer` — the string the scorer graded | `abstention 35 / plan_output 0 / numeric_mismatch 52 / long_prose 1 / other 4` |

On every roster published before §13.40 those two strings are the same value, so the tables agree and the
distinction is invisible. On an enumerated run they disagree about **86 of 121** records — and neither report said
which string it had counted. A reader who took the first table for the second would conclude that 71% of MR's
answers are neither numeric nor prose, when the truth is that 71% of its *raw outputs* are transcripts.

**This is the fifth instance of one class in this campaign and the cheapest to close**: §13.24's docstring, §13.34.6's
text-grep, §13.36's rendering comment, §13.37's workflow comment, and §13.40–13.42's field confusion. A report is a
claim about a field, so it names the field.

### 13.43.2 The change

Each report now prints one line before its table:

```
field: rawOutput -- the text the model wrote, not necessarily the graded answer. Pass --failures for the answer-level taxonomy.
field: answer -- the string the scorer graded (null where the arm declined)
```

And the `--failures` definitions block, which still described the rules as reading `rawOutput`, now describes them
as they are:

| shape | was | is |
| --- | --- | --- |
| `abstention` | "the last non-empty line of rawOutput is INSUFFICIENT_EVIDENCE" | "the arm returned no answer (`answer` is null)" |
| `plan_output` | "rawOutput opens with 'Let me gather' or 'Step 1'" | "the answer opens with …" |
| `soft_refusal` | "a refusal written out in prose, in the answer or the raw output" | "a refusal written out in prose, in the answer" |

**The definitions block is what a reader uses to decide whether a table means what they need**, and it was the one
part of §13.42's repair that still described the old rules. It would have been possible to change `failure_shape`
and leave the block alone — the numbers would have been right and the explanation of them wrong, which is the exact
failure this campaign keeps finding.

### 13.43.3 Verification

- `tools` **350 passed + 40 subtests** (was 347; +3, which is the three new tests in this section).
- **Red first**: all three new tests failed against the unrepaired tool — the two `field:` lines did not exist, and
  the census assertion could not match.
- **One of my own assertions was wrong and is corrected rather than worked around.** The first version pinned the
  column padding (`'other                86'`) and `'numeric_mismatch   52'`, both of which are the report's
  business rather than its meaning; the second of those failed on a count of spaces. They are now whitespace-loose
  matches, because a test that breaks on a cosmetic change while the defect it guards stays invisible is worse than
  no test.
- The `--failures` definitions block is asserted to name the answer, so a later edit that reverts the wording fails
  in CI rather than in a reader's understanding.

---

## 13.44 The readout was an inline script every time, which is how §13.38 happened

### 13.44.1 The pattern, and its cost

Four consecutive sections quoted numbers from a run through a script written for that section and not committed:

| section | the script | what it produced |
| --- | --- | --- |
| §13.38 | ad-hoc, never committed | the `41 of 47` behind §13.34.5's prediction 2 — **the prediction could not be re-derived** |
| §13.41 | inline, `python3 - <<'PY'` | the `52` numeric mismatches, and the transition matrix across four rosters |
| §13.42 | inline | the same 52, computed a second time |
| §13.43 | inline | the two fields' disagreement counts |

§13.38 is the section that repaired the *first* of these, and its own repair was reproduced by a script with the
same defect. **A number is only as durable as the code that produced it**, and the pattern also means that every
section re-derives the same quantities from scratch — the `total`, the per-capability counts, the taxonomy — with a
different chance of getting them right each time.

### 13.44.2 `tools/readout-arm-run.py`

```
$ python3 tools/readout-arm-run.py --reference run-38985220145.json

config: ask=enumerated relevanceUnits=turn relevanceSignal=retrieval relevanceTopK=64 promptContract=abstention-evidence-blocks
accuracy (this repetition): baseline 0.4440  feature 0.6540  -> +21.00pp
aggregates (the repetitions behind the register): baseline avg 0.442 (min 0.438 max 0.444)  feature avg 0.6745 (min 0.654 max 0.706)
registered statistic: delta +23.25pp -- the mean of the repetitions above, which is the number the register uses. McNemar p=1.814e-09 (significant)
discordant: baseline-incorrect/feature-correct 205, baseline-correct/feature-incorrect 100

per capability (feature side, counted from the roster):
  ABS: 30/30  against 38595325261: 29 (+1)
  IE: 132/150  against 38595325261: 133 (-1)
  KU: 61/72  against 38595325261: 62 (-1)
  MR: 29/121  against 38595325261: 51 (-22)
  TR: 75/127  against 38595325261: 72 (+3)

MR failure taxonomy (field: answer)
  abstention: 35
  plan_output: 0
  ...
  numeric_mismatch with plan_output folded in: 52  (§13.34.4's reading)
```

**The two accuracies are printed separately because they are different numbers.** `feature.metrics.accuracy` is
**one** repetition — the worst of four, which is why it equals `featureAggregate.min` — while `ablation.delta` is
the difference between the **means**. On run `38985220145` those read `+21.00pp` and `+23.25pp`, and §13.41.5 spent
a paragraph establishing which was which after the fact. The readout says it up front.

### 13.44.3 Three boundaries the tool holds

- **The taxonomy is imported, not re-implemented.** `failure_census` comes from `classify-raw-outputs.py`, so the
  two reports in this repository cannot disagree about what `numeric_mismatch` means — which is §13.42's defect and
  would otherwise be reintroduced by a tool written to summarise it.
- **§13.26's per-capability counts are constants shown only on `--reference`**, and only for the dataset they were
  produced on. A report that says `dataset: <something else>` gets a warning instead of a delta, because a delta
  against another benchmark's numbers is a claim nobody made.
- **The scorer-channel split is not computed here**, deliberately. That is `judgeScorer`'s accounting and needs the
  TypeScript judge; the arm prints it (`scorer channels: …`, on both the success and the failure path since
  §13.40.9) and the log is read. A Python re-implementation would be a second definition of the same number, one
  package away from the first.

### 13.44.4 Verification

- `tools` **358 passed + 40 subtests** (was 350; +8 by this section). `pnpm check` **exit 0**.
- **Red first**: all eight failed against the absent tool, then two failed on the output format (`MR 1/3` where the
  tool prints `MR: 1/3`) and were corrected in the tests rather than by changing the tool's format to match a
  guess — the format is the tool's, and the assertion is what has to describe it.
- **The archived case is a real artifact.** `TestAgainstAnArchivedRoster` runs against the committed MR fixture and
  asserts `MR: 29/121`, `abstention: 35` and `numeric_mismatch: 52`, so the roster path and the classifier import
  are exercised against data rather than a stub.
- One test asserts **both** accuracy readings from a synthetic report whose two numbers are deliberately different
  (`+20.00pp` from the metrics, `+24.00pp` from the aggregate), because a test where they coincide would pass
  against a tool that printed one of them twice.

### 13.44.5 Status

No change to the P0 row: §13.41.6's five predictions remain the thing being read. What changed is that the next
reading is reproducible by anyone who has the artifact, which is what §13.38 was written to establish and did not.

---

## 13.45 Run `39005914398`: the configuration is decided, and the register had it wrong twice

### 13.45.1 The run

`3df6a7d7`, `05:21:25Z` → `07:07:48Z`, **1h46m23s**, `success`, artifact 6,902,025 bytes. One variable against
§13.41's dispatch: the numeric gate.

| line | value |
| --- | --- |
| `Cache hit for restore-key` | `…-38985220145-1` |
| `Restored` | **261,738** vectors |
| `Relevance index: 32000 scored …` | **18 seconds** |
| `Embedding cache: persisted` | 262,318 (**580 new**) |
| **`scorer channels`** | `structural 1444, exact 791, numeric 340, judge 1425/4000 = 35.6%` |

The last line is §13.40.9's instrument **reporting itself for the first time**. Until this run the channel split
had to be reconstructed offline from the artifact with a stubbed judge, twice; now the run says it.

### 13.45.2 The five predictions

| # | registered in §13.41.6 | observed | verdict |
| --- | --- | --- | --- |
| **1** | MR ≈ 57 of 121 (falsified outside 51–63) | **62** | **met** |
| **2** | gate ≈ 77 decided, ≈ 31 true (falsified below 60 / 20) | gate **68**, gate-true **31** | **met** |
| **3** | delta **above +25.75pp** — the number `computed` must be beaten by | **+26.95pp** | **met** |
| **4** | the other four capabilities within 2 questions | ABS +0, IE **+2**, KU −1, TR **−2** | **met**, two on the boundary |
| **5** | abstentions ≈ 35, falsified outside 32–38 | **28** | **falsified** |

**Prediction 3 is the one that decides the configuration, and it is met.** The registered statistic reads
`+26.95pp` (baseline avg 0.4495, feature avg 0.719 over four repetitions spanning 0.714–0.726; McNemar
p = 6.053e-15; 212 won / 80 lost), against §13.26's `+25.75pp` for `computed`. **`ask: enumerated`, with the
repaired parser and the repaired gate, is the arm's best measured configuration.**

### 13.45.3 The table the whole iteration was for

| capability | `computed` §13.26 | `enumerated` transcript §13.40 | `enumerated` + parser §13.41 | **`enumerated` + parser + gate §13.45** |
| --- | --- | --- | --- | --- |
| ABS | 29/30 | 29/30 | 30/30 | 29/30 |
| IE | 133/150 | 132/150 | 132/150 | **135/150** |
| KU | 62/72 | 61/72 | 61/72 | 61/72 |
| **MR** | **51/121 = 42.15%** | 58/121 = 47.93% ✗ | 29/121 = 23.97% | **62/121 = 51.24%** |
| TR | 72/127 | 70/127 | 75/127 | 70/127 |
| total | 347/500 | 350/500 | 327/500 | **357/500 = 71.40%** |
| **delta** | **+25.75pp** | +26.75pp ✗ | +23.25pp | **+26.95pp** |

The ✗ marks the reading that was not a measurement: §13.40's 58 was a transcript being accepted by a judge, and
§13.41.2's decision to treat it as evidence was the iteration's first mistake. **MR is now 51.24%, +9.09pp over
`computed`**, and it is a figure the mechanical channels verify rather than a judge's tolerance:

| configuration | MR correct | gate decided | gate **true** | judge decided | judge true |
| --- | --- | --- | --- | --- | --- |
| `computed` | 51 | 86 | **37** | 35 | 14 |
| `enumerated`, transcript | 58 | 33 | **0** | 88 | 58 |
| `enumerated` + parser | 29 | 77 | **31** | 44 | 26 |
| **`enumerated` + parser + gate** | **62** | **68** | **31** | **53** | **31** |

The transcript row is the one that reads as a success and is not: `gate true 0` means **not one** of MR's verdicts
was decided by a mechanical comparison. The last row is the configuration: 31 provable verdicts from the gate and
31 from the judge, in near-equal proportion, which is what a contract that produces checkable answers looks like.

### 13.45.4 Prediction 5 was falsified, and the falsification is about the register

Abstentions fell 35 → 28, outside the registered 32–38. **Nothing in this dispatch can move the abstention rate**:
the parser is unchanged from §13.41 and the gate decision happens strictly after a decline is recognised
(`answer is None` is `structural`, which no numeric rule reads). So the -7 is **sampling variance**, and the
register's tolerance was derived from **one** prior observation of the same quantity.

That is the defect the falsification exposes, and it is not about the arm. §13.40.7 predicted 33 from a single
reading of 33; §13.41.6 predicted 35 from a single reading of 35; the truth ranges 28–35 across four runs of the
same configuration. **A tolerance derived from one observation is a tolerance the size of the noise**, and a
register that states one as a range the mechanism cannot violate will be falsified by noise at a rate that says
nothing about the mechanism.

The four capabilities show the same thing more quietly: `temperature: 0` does not make the repetitions identical.
`featureAggregate` spans 0.714–0.726 within one run and 0.654–0.706 within another, so **a single repetition's
accuracy carries several points of provider variance** — which is also why §13.41.5 refused to re-derive the delta
from one roster.

### 13.45.5 What the arm now is

| | value |
| --- | --- |
| `ask` | `enumerated` — `computed` plus a two-step contract on the multi-session route alone |
| `relevanceSignal` | `retrieval` |
| `relevanceUnits` | `turn` |
| `relevanceTopK` | 64 |
| `promptContract` | `abstention-evidence-blocks` |
| registered delta | **+26.95pp**, McNemar p = 6.053e-15, N = 500, 4 repetitions |
| per capability | ABS 96.67%, IE 90.00%, KU 84.72%, **MR 51.24%**, TR 55.12% |
| cost | 1h46m per run, of which 18s is the relevance index and 580 embeddings |

Compared with §13.26's run (`+25.75pp`, 3h21m, 170,095 re-embedded vectors every time), the arm is **+1.20pp more
accurate and roughly twice as cheap per run** — the second of which is §13.37's repair, and it is what makes four
repetitions of a single-variable dispatch affordable at all.

### 13.45.6 Verification

- `pnpm check` **exit 0** at `3df6a7d7`; `Verify` **success**. `tools` **358**; four coverage dimensions **100%**
  except `cortex-node`'s branch column.
- **The readout is the committed tool**, not an inline script: `python3 tools/readout-arm-run.py --reference` on
  this run's artifact produced every number in §13.45.2 and §13.45.3, including the per-capability counts and the
  taxonomy. §13.44 was written for exactly this.
- The channel table is the one number the tool deliberately does not compute (§13.44.3); it comes from the run's own
  `scorer channels` line for the whole benchmark and from a `judgeScorer` replay for MR alone. The two agree where
  they overlap: the log's `numeric 340` and the replay's per-capability counts are computed by the same counter.
- **Prediction 5's falsification is reported as a falsification.** It is not reinterpreted as "close enough", and
  the reason it was falsified is analysed (§13.45.4) rather than explained away.

### 13.45.7 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0 (done)** | The configuration is **decided**: `enumerated` + repaired parser + repaired gate, `+26.95pp`, MR 51.24%. §10.3's provisional marker is lifted | no |
| **P1** | The **no-signal control** (§13.22.8): `relevanceSignal: none` against this configuration separates "the ranking" from "the room". Its mechanism exists and is the arm's default, so this is a one-variable dispatch | yes |
| **P1** | **Register tolerances from repetition spread, not from one observation** (§13.45.4). A prediction whose range is narrower than the configuration's own variance cannot be falsified by a mechanism | no |
| **P1** | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3 — a registered dispatch, not a cleanup) | no |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build (§13.39.2); the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

**Three readings of one configuration, and only the third is a measurement.** `+26.75pp` was a judge accepting
transcripts; `+23.25pp` was a gate reading operands; `+26.95pp` is both instruments reading what they were built to
read. The difference between the last two is 3.70pp, and it was entirely an instrument.

---

## 13.46 The no-signal control, at last, and the dispatch can now say what it changed

### 13.46.1 Why this is the right next experiment

§13.22.8 registered a control separating "the extra turns" from "the ordering" and it has been the campaign's
oldest open P1. It was blocked first by the ask (a control at a refuted ask separates nothing) and then by the room
(a control at a selection unit that lost the room measures the loss). **Both are now settled**: §13.45 fixed the
configuration at `ask: enumerated` + `relevanceUnits: turn`, and `relevanceSignal: retrieval` is the one input
whose contribution has never been isolated.

The mechanism is the arm's **default**, so this is a one-variable dispatch with nothing to implement:

```yaml
cortex_memory_relevance: ''     # empty == none == the arrival-order prefix
```

### 13.46.2 What the arm is spending on, and what it is not known to be spending on

| input | value | isolated by |
| --- | --- | --- |
| `ask` | `enumerated` | §13.45: `+26.95pp`, MR 51.24% |
| `relevanceUnits` | `turn` | §13.32–13.34: `session-fill` and `session` both lost |
| `relevanceSignal` | `retrieval` | **never isolated** |
| `relevanceTopK` | 64 | §13.26's recall measurement, not an ablation |
| `promptContract` | `abstention-evidence-blocks` | §12.5, held |

`retrieval` costs a relevance index over 32,000 (question, turn) pairs per run. §13.37's cache repair cut that
from 1h38m to 18 seconds, which makes the *cost* irrelevant and leaves the *question*: does ranking the turns beat
taking the ones that arrived first?

### 13.46.3 Registration

**One variable**: `cortex_memory_relevance` from `retrieval` to `none`. Every other input held at §13.45's values,
including `ablation_runs: 4` and `temperature: 0`, so the comparison is against `+26.95pp` and not against a
single repetition.

| # | prediction | falsified if |
| --- | --- | --- |
| **1** | **The ranking's contribution is measurable**: the delta differs from **+26.95pp** by more than **3pp** | within ±3pp of +26.95pp |
| **2** | **If it is measurable, MR is where it shows**: MR differs from 62/121 by at least 5 questions | a delta outside ±3pp with MR within 4 of 62 |
| **3** | **`none` is not catastrophically worse.** A collapse to the arrival-order prefix would mean the ranking is doing the arm's whole job, and the configuration would then be a retrieval system with a prompt contract bolted on | delta below **+15pp** |

**The tolerance is 3pp because it is six times the configuration's own variance**, which is the lesson §13.45.4
records: `retrieval`'s four repetitions span `0.714–0.726`, so one repetition's standard deviation is about
0.005 — 2.5 questions of 500. The previous two registers predicted a quantity from **one** observation and both
were falsified by noise; this one names the noise first and sets the band outside it.

**Prediction 3 is directional and predictions 1–2 are not, deliberately.** Which way the ranking moves the arm is
the thing being measured; registering a direction would be registering a guess. What is registered is that a
collapse would mean something specific, and that a difference smaller than the noise means the ranking is not
what the arm is buying.

**The reading rule.** If prediction 1 is falsified — the delta lands within ±3pp — then `retrieval` is **not**
carrying the arm, and the honest configuration drops it: 18 seconds per run and an embedding dependency for the
index, in exchange for nothing measurable. If it is met and `none` is lower, the redundancy of ranking to the
two-step contract is the next question. If it is met and `none` is **higher**, then similarity ranking is
*costing* the arm accuracy — which would be the most consequential result of the campaign, because the whole
retrieval stack would be the thing to reconsider rather than the thing to lean on.

### 13.46.4 The dispatch script can now say what it changed

Every dispatch before this one edited the literal `INPUTS` table. That was workable while each dispatch changed
the constant it needed and stops being workable now: this dispatch changes one input and must leave the other
eleven at §13.45's values **in the record**, which editing the table would erase.

`tools/dispatch-cortex-memory-ab.py` gains `--set KEY=VALUE`, and the property that matters is that a **typo fails
loudly**:

| input | result |
| --- | --- |
| `--set cortex_memory_relevance=none` | applied; the log marks the line with `*` |
| `--set cortex_memory_relevance=` | applied as the empty string — a real value, not a missing one |
| `--set cortex_memory_releavnce=none` | **`SystemExit`** naming the typo and listing the keys that exist |
| `--set cortex_memory_relevance` | **`SystemExit`** naming the required `KEY=VALUE` shape |
| `--set a=1 --set a=2` | **`SystemExit`**: with last-wins the argument order would decide the experiment |

A silently-ignored override would dispatch the **previous** configuration while the commit message described the
new one, and the run would then be evidence for an experiment nobody ran. That is §13.34.6's defect class — a
check that is not a check — applied to the thing that decides what an experiment *is*.

One further test holds the other direction: **every key in `INPUTS` must be declared by the workflow**, parsed
from the workflow file rather than from a copy. A key renamed on one side and not the other would otherwise fail at
dispatch, where GitHub answers with a 422 whose message names nothing useful.

### 13.46.5 Verification

- `tools` **368 passed + 40 subtests** (was 358; +10 by this section). `pnpm check` **exit 0**.
- **Red first**: nine of the ten new tests failed against the script without `apply_overrides`; the tenth — the
  key-parity check — passed, which is the correct result for a table that was in fact in parity.
- The overrides are a **pure function** over a dict, so every refusal is tested without a network call and without
  a dispatch.

### 13.46.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The no-signal control is **dispatched**; §13.46.3's three predictions are registered | yes (in flight) |
| **P0 (done)** | The configuration (§13.45): `enumerated` + repaired parser + repaired gate, `+26.95pp` | no |
| **P1** | Tolerances from repetition spread rather than from one observation (§13.45.4) — **applied** here | no |
| **P1** | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build; the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

---

## 13.47 Ten tests that could not run on the machine the suite runs on

### 13.47.1 What happened

`pnpm check` was **exit 0** locally and `Verify` **failed** on `9fcb7fe1`. All ten new
dispatch-override tests errored with the same message:

```
SystemExit: no oauth2 token in .git/config
```

The overrides were fine. `tools/dispatch-cortex-memory-ab.py` read its PAT at **module level**:

```python
TOKEN = token()      # module level, and `token()` exits when there is none
```

so **importing** the script required a checkout with an oauth2 token in `.git/config`. A GitHub runner
checkout has neither, and `tools/__tests__` is collected on every push.

### 13.47.2 Why nothing had noticed, and it is the interesting part

Three other test files reference this script and all of them pass. Two of them —
`test_dispatch_inputs.py` and `test_preregistration_config.py` — read it as **source text**
(`ast.parse`), which does not execute it. My new file is the first test to **import** it, because
`apply_overrides` and `parse_argv` are pure functions and importing them is how you test a pure function.

**So the defect had been in the file since it was written and was invisible to a test suite that had
never imported it.** The suite covered the script's *contents* and never its *module*.

### 13.47.3 The repair

The read moves to first use, behind the accessor, with the value cached:

| operation | before | after |
| --- | --- | --- |
| `import` the script from anywhere | **required a token** | succeeds; `_TOKEN is None` |
| `apply_overrides(INPUTS, [...])` | unreachable without a token | works |
| `token()` | read at import | reads on first call, caches, exits with a sentence |

Only `req` needs a credential, so only `req` pays for one. And the accessor now distinguishes two problems
it used to conflate:

- **no `.git/config` at all** — "run this from the repository root". Before, `open` raised
  `FileNotFoundError` through a traceback about a path, which is a different fix from the next one.
- **a config without a token** — "no oauth2 token in .git/config".

### 13.47.4 Verification

- Four new tests, three of which reproduce the CI failure **exactly**: `chdir` to a directory that is not a
  checkout, assert the import succeeds, assert `_TOKEN is None`, assert `apply_overrides` works, and assert
  that only `token()` refuses. The fourth asserts the token is read once rather than once per request, because
  a re-read would pick up a rotated file rather than the token the run started with.
- **The fix was verified by simulating the runner before pushing**, not by reading the code: a temp directory
  with a `.git/config` containing `[remote "origin"] url = https://github.com/x/y` and no `oauth2:`. `import`
  succeeds, `_TOKEN` is `None`, `apply_overrides` applies, `token()` exits with the right sentence.
- `tools` **371 passed + 40 subtests** (+3). `pnpm check` exit 0 locally, then **`Verify` success** on
  `2d893799` — checked on the runner rather than inferred from the local run.

### 13.47.5 The lesson, which is about the test suite and not about the script

`pnpm check` passing is evidence about **this machine**. It is not evidence about a runner, and the difference
is exactly the class of state a module can depend on at import: credentials, working directory, environment,
the presence of a `.git` directory. **A test that imports a module executes its top-level code**, so a script
whose top level reaches for a credential is a script whose tests cannot run anywhere but a developer's checkout.

This is also the second CI failure in two iterations caused by a dependency the test made on the environment
rather than on the code — §13.36's was PyYAML, undeclared, failing at collection. Both were found by CI rather
than by the local gate, which is what CI is for, and both are recorded because **the gate's green is a claim
about the gate's environment**.

---

## 13.48 The defect was in three files, and only one of them had a test

### 13.48.1 The sweep

§13.47 fixed the dispatch script's module-level token read because a test that imported it broke CI. The obvious
follow-up question is **whether that script was the only one**, so: import every `tools/*.py` from a directory that
is not a checkout.

```
32 scripts; 3 fail to import from an empty directory
  dispatch-b7-ab.py:   FileNotFoundError: '.git/config'
  inject-b7-cohort.py: AttributeError: 'NoneType' object has no attribute '__dict__'
  push-via-api.py:     CalledProcessError: 'git remote get-url origin' returned non-zero
```

Two of those are the **same defect** as §13.47 and one is an artefact:

| file | what the top level did | verdict |
| --- | --- | --- |
| `dispatch-b7-ab.py` | `TOKEN = token()` — reads `.git/config` | **real** |
| `push-via-api.py` | `REPO, BRANCH = _origin()` — runs `git remote get-url origin`, and `TOKEN = token()` | **real** |
| `inject-b7-cohort.py` | nothing; the `AttributeError` is `@dataclass` looking itself up in `sys.modules`, which the loader had not populated | **artefact of the test** |

Neither of the two real ones had failed, and the reason is the same as §13.47's: **no test imported them.**
`push-via-api.py` is used by every push in this campaign and had never been imported by anything but the
interpreter running it as a script.

### 13.48.2 The repair, and the three problems behind one message

Both files move their reads behind cached accessors. `push-via-api.py` gains `origin()`, `repo()`, `branch()` and
keeps `token()`; `dispatch-b7-ab.py` gains `token()`. And all three accessors now **distinguish the problems they
used to conflate**, because each needs a different fix:

| situation | before | after |
| --- | --- | --- |
| no `.git` directory | `FileNotFoundError` about a path | "run this from the repository root" |
| `.git` but no `origin` | `CalledProcessError` about a subprocess | "run this from the repository root, in a checkout whose origin is the repository you mean to push" |
| `origin` but no token | `SystemExit` (already correct) | unchanged |

The middle one is the newly-named case, and it matters because `_origin`'s docstring already records a near-miss:
a push from the wrong checkout would have pushed cortex-docs content into the cortex repository. **"Which
repository am I pushing to" is exactly the question a `CalledProcessError` answers worst.**

### 13.48.3 The guard is over the directory, not the file

`tools/__tests__/test_tools_import_cleanly.py` parametrises **every** `tools/*.py` and imports it from a temp
directory. Per-script tests would have found the two defects §13.47 and §13.48 fixed; only a directory-wide sweep
finds the third one without someone thinking to look.

Three details make it honest:

- **A non-empty check.** `assert len(SCRIPTS) >= 20` — a parametrisation over zero files passes vacuously, which
  is the failure mode a sweep is most likely to have.
- **The loader registers each module in `sys.modules` before executing it**, because a `@dataclass` looks itself
  up there. Without that, `inject-b7-cohort.py` fails with an `AttributeError` that has nothing to do with the
  script — a test artefact that would have been reported as a finding.
- **The failure message says what to do**: naming §13.47 and "move it behind an accessor", so the next person
  who adds a module-level `git` call does not have to rediscover why it is refused.

Four further tests assert the accessors still return the right values **in** a checkout — `repo() ==
'AgentiX-E/cortex'`, `branch() == 'master'`, a token longer than 20 characters — because "lazy" would otherwise be
indistinguishable from "broken", and the file it was made lazy in is the one every push depends on.

### 13.48.4 Verification

- `tools` **408 passed + 40 subtests** (was 371; +37 — one parametrisation per script plus the four accessor
  tests). `pnpm check` **exit 0**.
- **The repair to the pusher was verified by pushing with it.** The commit that contains the change is the first
  one pushed by the changed code, which is the only test that matters for a file whose whole job is the push.
- Before committing, the accessors were checked by hand in the repository: `repo() = AgentiX-E/cortex`,
  `branch() = master`, `token()` 93 characters. Then from an empty directory: import succeeds for all 32.

### 13.48.5 What this says about the campaign's own tooling

The three files had been in the repository, working, for the whole campaign. They were not broken — **they were
untestable**, and nothing said so because nothing had tried. `pnpm check` green was never evidence about them:
their only execution path is "python3 tools/x.py" from a checkout.

That is the same shape as every other defect this iteration found. §13.38's taxonomy was correct and read the
wrong field. §13.41's gate was correct and read the wrong number. §13.47's dispatch worked and could not be
imported. **A thing can do its job and be unable to answer a question about itself**, and the only way to find out
is to ask the question in a place where the answer is not prearranged.

---

## 13.49 Three CI failures in three iterations, and the third one was the tests

### 13.49.1 The sequence

| commit | what failed | what it was |
| --- | --- | --- |
| (`c1f3dcb9`, `4317c70c`) | PyYAML not declared | a test's **dependency** was not in the requirements |
| `9fcb7fe1` (§13.47) | `SystemExit: no oauth2 token` on ten tests | the **code** read a credential at import |
| `c980a5d8` (§13.48) | the same message on **two of the four tests I had just added** | the **tests** read a credential |

The third one is the one worth recording, because of what it was: four tests asserting the accessors still work,
three of them written to say `len(module.token()) > 20` and `module.repo() == 'AgentiX-E/cortex'` against **this**
checkout. They passed here, where `.git/config` carries a token, and failed on a runner, where it does not.

**Three tests making the same mistake as the code they had just been written to guard**, one commit after the
section that named the mistake. The section is §13.47, whose whole argument is that a test depending on a
credential can only run on a developer's machine.

### 13.49.2 Why it happened, stated plainly

A user token is the most available thing in this environment and its absence is invisible from inside it. The
question "would this pass without the token" is not one that occurs while writing an assertion that starts
`assert module.token()` — the assertion *looks* like a test of the code, and it is a test of the machine.

The same is true of every environment fact: a working directory, a git remote, a running server, a populated
cache. **A test that reads one of them describes the environment and calls it a property.**

### 13.49.3 The repair, and the shape of the replacement

A **synthetic checkout**: `git init` in a temp directory plus

```
git remote add origin https://oauth2:checkout-token@github.com/AgentiX-E/cortex
```

whose URL carries the token a real config would carry. Then `repo() == 'AgentiX-E/cortex'`,
`branch() == 'master'` and `token() == 'checkout-token'` are assertions about the **parser** — which is the part
that has logic — rather than about the machine, which has none.

That is also strictly stronger than what it replaced. `len(token()) > 20` would pass for any 21-character string;
`== 'checkout-token'` fails unless the `oauth2:` prefix was found, split on `@`, and truncated where it should be.

### 13.49.4 The verification that should have come first

Before pushing, the tree was copied to `/tmp/ci-sim`, `git init` + `git add -A` + `git commit` was run **and an
origin added without a token**, and all 408 tests were run there. Green.

The first attempt at that simulation was wrong and worth recording: it fabricated a `.git/config` in an empty
directory instead of making a repository, and two tests failed on `test_every_mapped_workflow_is_tracked_by_git`
— which needs `git ls-files`. **A simulation that is easier than the real environment is a simulation of a
different environment.** The second attempt committed the tree and removed only the token, which is exactly what
`actions/checkout` produces.

### 13.49.5 What changes in practice

`pnpm check` green is a claim about **this machine**, and this iteration produced three counterexamples to reading
it as a claim about the runner. The gate that would have caught all three is the same one: **run the suite once
per iteration in a directory that is not a checkout, with no credential in it.**

That is not a new tool. It is `tar` + `git init` + `git remote add` + `pytest`, four commands, and it now has a
recorded reason to be run before a push rather than after a red CI.

---

## 13.50 The no-signal control: the ranking is not decoration, it is the arm

### 13.50.1 The run

`9fcb7fe1`, `07:24:20Z` → `08:56:32Z`, **1h32m12s**, `success`, artifact 6,718,654 bytes. One variable against
§13.45's configuration: `cortex_memory_relevance` from `retrieval` to `none`.

| line | value |
| --- | --- |
| `Cache hit for restore-key` | `…-39005914398-1` |
| `Restored` | 262,318 vectors |
| `Embedding cache: persisted` | 262,456 (**138 new**) |
| `scorer channels` | `structural 2884, exact 348, numeric 220, judge 548/4000 = 13.7%` |

The channel line said it before the accuracy did: `structural` **doubled** against §13.45's 1444, and `structural`
is the door an absent answer leaves by.

### 13.50.2 The result

| | `retrieval` §13.45 | `none` §13.50 | difference |
| --- | --- | --- | --- |
| delta | **+26.95pp** | **−37.35pp** | **−64.30pp** |
| feature accuracy | 0.719 | **0.0635** | |
| ABS | 29/30 | 30/30 | +1 |
| IE | 135/150 | **1/150** | −134 |
| KU | 61/72 | **0/72** | −62 |
| MR | 62/121 | **1/121** | −61 |
| TR | 70/127 | **0/127** | −70 |
| MR abstentions | 28 | **113** | +85 |

**The arm scores 6.35%.** Its non-ABS capabilities are 2 of 470 questions. It does not degrade — it stops
answering: 113 of MR's 121 questions decline, and the declines are correct declines to make, because the evidence
the question is about is not in the window.

### 13.50.3 The three predictions

| # | registered | observed | verdict |
| --- | --- | --- | --- |
| **1** | the ranking's contribution is measurable, `\|delta − 26.95pp\| > 3pp` | **−64.30pp** | **met**, by a factor of 21 over the tolerance |
| **2** | if measurable, MR is where it shows: ≥ 5 questions | MR −61 | **met literally, and the framing was wrong** |
| **3** | `none` is not catastrophically worse: delta not below +15pp | **−37.35pp** | **falsified** |

Prediction 3 was written as the guard against exactly this and it is the one that failed, which is the register
working: I thought a collapse was unlikely enough to be worth naming, and it happened.

**Prediction 2's framing was wrong and the data says so.** It assumed the ranking's contribution would be
concentrated in the capability the campaign has been working on — MR, the multi-session one. It is not: IE loses
134 questions, TR 70, KU 62, MR 61. **The ranking carries every capability that reads evidence**, which is all of
them but ABS. That is a different claim from the one I registered, and it is the more important one.

### 13.50.4 Why the collapse, and it is not "the ranking is good"

`relevanceSignal: none` spends the budget on the **first N turns that arrived**, and arrival order is the
sessionizer's chronological order. LongMemEval's haystack is hundreds of turns per question and the answer is
somewhere inside it, so "the first 64" is a window that almost never contains the evidence. The model then declines
— correctly, given what it was shown.

So this control measures **whether the evidence is in the window at all**, not **whether the ranking is better than
a good alternative**. Those are different questions and the difference matters:

- as evidence that `retrieval` is load-bearing, **−64.30pp is conclusive**: nothing else in the configuration
  changed, and the arm stopped working.
- as a **measurement of the ranking's contribution**, it is an **upper bound**. A control that put *random* turns
  in the window, or one that deliberately included the gold session, would land between `none` and `retrieval`, and
  the ranking's contribution against those is smaller than 64.30pp by an amount this run cannot tell us.

**Registered as a limitation rather than a footnote**, because the natural reading of "the ranking contributes
64pp" is the wrong one. What this run establishes is that a window built by arrival order **does not contain the
answers** on this benchmark, and that a similarity ranking is what makes the arm able to answer at all.

### 13.50.5 What it changes about the configuration

**Nothing is dropped.** The reading rule §13.46.3 registered for "prediction 1 falsified" — drop `retrieval`,
18 seconds per run and an embedding dependency for nothing measurable — does not apply, because prediction 1 was
met in the opposite direction from the one that rule anticipated.

| input | status after this run |
| --- | --- |
| `ask: enumerated` | held; §13.45 |
| `relevanceSignal: retrieval` | **load-bearing**, established here: without it the arm scores 6.35% |
| `relevanceUnits: turn` | held; §13.32–13.34 |
| `relevanceTopK: 64` | **the next thing worth isolating**, and see below |
| `promptContract` | held |

**`relevanceTopK: 64` is the natural follow-on and this run says why.** If arrival order fails because 64
chronological turns do not contain the evidence, then the width is doing real work alongside the ranking, and the
interesting question is where the knee is: §13.26 measured `recall = 0.921` at `k = 50` with a flattened curve, but
that was recall over the *index*, not accuracy over the *arm*. A `k = 16` run against this configuration would say
whether the ranking's value depends on being able to choose from a wide field or whether a narrow ranked window is
as good — and it is one variable.

### 13.50.6 Verification

- `pnpm check` **exit 0** at `9fcb7fe1`; `Verify` passed at `a7f6a580` (the next commit, which touched only tests).
- Every number came from `python3 tools/readout-arm-run.py --reference` on the run's artifact.
- The `scorer channels` line — the instrument §13.40.9 added and §13.45 saw work for the first time — predicted the
  result before the accuracy table did: `structural` doubling is a decline rate doubling, and the declines are what
  the accuracy measures.
- **Prediction 3 is reported as falsified**, and the limitation in §13.50.4 is registered rather than left for a
  reader to discover: the −64.30pp is an upper bound on the ranking's contribution, not the contribution.

### 13.50.7 Status after this section

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0 (done)** | The configuration (§13.45) and its load-bearing input (§13.50): `enumerated` + `retrieval` + `turn`, `+26.95pp`, MR 51.24% | no |
| **P1** | **`relevanceTopK`**: a `k = 16` run against this configuration, to separate "the ranking chooses well" from "the ranking needs a wide field to choose from" (§13.50.5) | yes |
| **P1** | A **better no-signal control**: random turns, or a window that includes the gold session, to turn §13.50.4's upper bound into a contribution | yes |
| **P1** | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build; the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

**The campaign's oldest open question is answered, and the answer is bigger than the question.** §13.22.8 asked
whether the arm's gain came from the extra turns or from the ordering. It came from the ordering — so completely
that without it there is no arm left to measure: 6.35%, two correct answers outside ABS, one per capability.

---

## 13.51 What actually limits the arm, measured before the next dispatch

### 13.51.1 The failure taxonomy of the configuration, per capability

Run `39005914398`'s roster, classified by `tools/classify-raw-outputs.py --failures` (§13.42's field — the graded
answer, not the transcript):

| capability | correct | abstention | numeric | long_prose | other | plan |
| --- | --- | --- | --- | --- | --- | --- |
| ABS | 29/30 | — | — | — | 1 | — |
| IE | 135/150 | **13** | — | 2 | — | — |
| KU | 61/72 | — | 7 | 1 | 3 | — |
| **MR** | **62/121** | **28** | **24** | 1 | 6 | — |
| **TR** | **70/127** | **41** | 5 | 9 | 1 | 1 |

**82 of the 143 failures are declines**, and they are not evenly spread: TR declines on 41 of its 57 failures
(72%), MR on 28 of 59 (47%), IE on 13 of 15 (87%). The campaign has spent six sections on MR's arithmetic and the
largest single failure mode is a model that says it cannot answer.

### 13.51.2 Whether that is "the evidence is not there" or "it is there and unused"

Every record carries `goldOverlap: {carried, total}` — the share of the question's gold turns that were in the
window the reader was shown. Across all 500 questions:

| gold coverage | n | correct | declined |
| --- | --- | --- | --- |
| 0% | 2 | 0.0% | **100.0%** |
| 1–24% | 43 | 37.2% | 46.5% |
| 25–49% | 120 | 55.0% | 20.0% |
| 50–74% | 183 | 77.0% | 13.1% |
| 75–99% | 99 | 82.8% | 12.1% |
| **100%** | 53 | **98.1%** | **0.0%** |

**Coverage predicts accuracy monotonically, from 0% to 98.1%, and at full coverage there are no declines at all.**
That is the strongest single relationship this campaign has measured, and it says the arm's ceiling is set by what
reaches the window.

Split by outcome:

| | MR median coverage | TR median coverage |
| --- | --- | --- |
| correct | 54.2% | 58.3% |
| **declined** | **52.8%** | **39.7%** |
| answered wrong | 37.0% | 45.8% |

**The two capabilities' declines have different causes, and that is the finding:**

- **TR's declines are a coverage problem.** 39.7% against 58.3% for the questions it answers correctly — a 19-point
  gap. The evidence is not in the window, so declining is right.
- **MR's declines are not.** 52.8% against 54.2% — a 1.4-point gap, inside the noise. The evidence **is** there at
  the same rate as on the questions it answers, and the model declines anyway.
- **MR's wrong answers sit at 37.0%**, below its declines. So MR has two distinct populations: questions whose
  evidence is largely missing (answered wrong, 37%), and questions whose evidence is present (answered or
  declined, ~53%), where the split is a decision rather than a retrieval failure.

### 13.51.3 What that makes the next variable, and it is not the one §13.50.5 proposed

§13.50.5 named `k = 16` as the follow-on, on the theory "does the ranking need a wide field". The coverage table
says the opposite question is the live one: **the field may be too narrow, not too wide.**

`relevanceTopK: 64` is a **candidate pool**, not the room. `retrieveTopKByQueries` fuses the per-query rankings and
takes `slice(0, topK)`, so a question's 47 admitted turns were chosen from 64 candidates — **a 27% filter**. The
room holds 256 turns and the character budget binds first, so widening the pool does not enlarge the window; it
changes **which** 47 turns are in it.

That is exactly the lever the coverage table responds to. Widening `k` raises the chance that a question's gold
turns are among the candidates at all, and 100% coverage is worth 98.1% accuracy.

### 13.51.4 Registration

**One variable**: `cortex_memory_relevance_top_k` from **64** to **256**. Every other input held at §13.45's values.

| # | prediction | falsified if |
| --- | --- | --- |
| **1** | **Median gold coverage rises.** MR from 52.8% (declines) / 54.2% (correct) to at least **60%**, and TR's declines from 39.7% to at least **50%** | MR median below 56%, or TR's decline median below 45% |
| **2** | **The delta rises above +26.95pp**, because coverage is the mechanism and the table is monotone | at or below +26.95pp |
| **3** | **The declines fall**, most of the drop in TR: TR's 41 declines fall to at most **30**, MR's 28 to at most **24** | either unchanged or higher |
| **4** | **The other capabilities do not regress beyond 3 questions**: widening a pool should not take anything away | any of ABS, IE, KU falls by more than 3 |
| **5** | **The index build stays under 5 minutes.** It was 18s at `k = 64`; `k = 256` is four times the per-question candidates and the same 32,000 scored pairs | over 5 minutes |

**Prediction 5 is a guard rather than a hypothesis**, and it is registered because the alternative is discovering a
20-minute index in the run's timing rather than in advance. The embedding cache is converged (`262,456` vectors,
138 new in the last run), so this run's index cost is the only new work.

**The reading rule.** If prediction 1 holds and 2 holds, `k` becomes a parameter to tune rather than a constant,
and the next dispatch is `k = 1024` or a two-point curve. If prediction 1 holds and 2 **fails**, then coverage is
not the mechanism after all — the table is correlational — and the honest next step is to read the records where
coverage rose but accuracy did not. If prediction 1 fails, `k = 64` is not the constraint, and the coverage table's
monotonicity has some other cause that this dispatch cannot see.

### 13.51.5 Verification

- The taxonomy and the coverage table are **not** from an inline script: the census is
  `tools/classify-raw-outputs.py`'s `failure_census` (§13.42), and the coverage table reads `goldOverlap` straight
  off the artifact, which is what `QuestionRecord` writes for the memory arm (§13.33.3).
- `pnpm check` **exit 0** at `231a49f6`, `Verify` **success**; no code changes in this section, so the coverage
  numbers are unchanged from the run that produced them.

### 13.51.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | `relevanceTopK: 256` is **dispatched**; §13.51.4's five predictions are registered | yes (in flight) |
| **P0 (done)** | The configuration (§13.45), its load-bearing signal (§13.50), and now the measured reason `k` is the constraint (§13.51.2) | no |
| **P1** | **MR's declines are not a coverage problem** (§13.51.2): 52.8% coverage against 54.2% on correct answers. Once `k` is settled, the next question is why a model shown the same amount of evidence declines on some questions and answers on others — a contract question, and the same shape as §13.40's | yes |
| **P1** | A better no-signal control (§13.50.4): random turns, to turn −64.30pp from an upper bound into a contribution | yes |
| **P1** | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build; the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

**The uncomfortable part, stated plainly:** §13.50.5 named the wrong next variable, one section ago, on a theory
rather than a measurement. The coverage table took twenty minutes to produce and would have saved a dispatch.
**That is the argument for reading the records before choosing the variable**, and it is why §13.41's and §13.50's
mistakes look different from this one: those were instruments misreading, and this was a plan made without looking.

---

## 13.52 The coverage table is a tool now, and it found a third case

### 13.52.1 Why it moved

§13.51 chose the next variable from a table it built inline, twenty minutes before dispatching. That is §13.44's
argument one section later: **a measurement that decides a dispatch belongs in a tool.** `readout-arm-run.py`
gains `--coverage`, and running it on the same artifact reproduces §13.51.2 **every number**:

```
records with coverage: 500 of 500

coverage (gold turns carried / stated)
  0%      n=  2  correct   0.0%  declined 100.0%
  1-24%   n= 43  correct  37.2%  declined  46.5%
  25-49%  n=120  correct  55.0%  declined  20.0%
  50-74%  n=183  correct  77.0%  declined  13.1%
  75-99%  n= 99  correct  82.8%  declined  12.1%
  100%    n= 53  correct  98.1%  declined   0.0%

by capability and outcome, median coverage
  ABS: correct  54.2% (n= 29)  wrong  70.8% (n=  1)
  IE: correct  83.3% (n=135)  declined  42.9% (n= 13)  wrong 100.0% (n=  2)
  KU: correct  62.5% (n= 61)  wrong  66.7% (n= 11)
  MR: correct  54.2% (n= 62)  declined  52.8% (n= 28)  wrong  37.0% (n= 31)
  TR: correct  58.3% (n= 70)  declined  39.7% (n= 41)  wrong  45.8% (n= 16)
```

### 13.52.2 The case §13.51 did not check, and it is the largest

§13.51.2 compared MR and TR, because those are the two capabilities the campaign has been working on. The tool
prints every capability, and **IE's gap is twice TR's**:

| capability | correct | declined | gap |
| --- | --- | --- | --- |
| **IE** | 83.3% | **42.9%** | **40.4 points** |
| TR | 58.3% | 39.7% | 18.6 points |
| MR | 54.2% | 52.8% | 1.4 points |

**Thirteen of IE's fifteen failures are declines, and their median coverage is 42.9% against 83.3% on the
questions IE answers.** So IE's declines are the same phenomenon as TR's, at twice the magnitude:
the evidence is missing, and the model correctly says so.

That strengthens §13.51's reasoning rather than changing it — wider `k` should recover all three — and it does so
**by finding a case I did not think to look at**, which is what a table printed by a tool does and a table printed
for a section does not.

**One cell is misleading and is left in rather than filtered:** IE's `wrong 100.0% (n=2)` is two questions at full
coverage answered wrongly. With n=2 the median is the value, and a reader who took it for a rate would conclude the
opposite of what the rest of the row says. It says `n=2`, which is the guard.

### 13.52.3 Verification

- `tools` **412 passed + 40 subtests** (was 408; +4). `pnpm check` **exit 0**.
- **Red first**: all four coverage tests failed against the tool without `--coverage`.
- Two boundary tests that exist because the measurement can be absent in two different ways: a record with **no
  `goldOverlap`** makes the whole report unreadable for coverage (exit 2 with a sentence saying why), and a record
  whose **`total` is 0** — a dataset that names no gold turns — is **excluded rather than counted as 0%**. Those are
  different states: 0% means "gold turns were named and none arrived", which is a measurement; `total: 0` means
  there was nothing to measure.
- The reproduction of §13.51.2's numbers is the acceptance test, and it is what §13.51.5 claimed without being able
  to check.

### 13.52.4 Status

The `k = 256` dispatch (§13.51.4) is in flight; nothing in this section changes its registration. What changed is
that its prediction 1 — "median coverage rises" — can now be checked with one command on the run that lands, and
the same command will show whether the IE recovery §13.52.2 predicts actually happened.

---

## 13.53 The declines, priced against what the same coverage is worth

### 13.53.1 Correcting §13.51.2

§13.51.2 said "MR's declines are not a coverage problem: 52.8% against 54.2% on the questions it answers". The
comparison is right and the conclusion drawn from it was too strong. Two further readings of the same artifact:

**The declines are questions with many gold turns.** Every one of MR's 28 declines names **at least 7** gold turns
(median **24**, range 18–36) and carries a median of **12**. For a counting question, half the evidence is not
"enough to try" — it is a number that cannot be computed. That part of §13.51.2 stands.

**But the same coverage is worth 67% elsewhere in the same capability.** MR's correct rate by coverage band:

| coverage | MR | TR | IE | KU |
| --- | --- | --- | --- | --- |
| 1–24% | 2/14 = 14% | 3/18 = 17% | 3/5 = 60% | 2/2 |
| 25–49% | 20/46 = 43% | 19/40 = 48% | 9/15 = 60% | 11/12 = 92% |
| **50–74%** | **28/42 = 67%** | 37/54 = 69% | **30/32 = 94%** | 35/43 = 81% |
| 75–99% | 12/19 = 63% | 9/13 = 69% | 43/47 = 91% | 13/15 = 87% |

**MR's declines sit at a 52.8% median — inside the band where MR answers 67% correctly.** If the 28 declines
behaved like the rest of their band, **19 of them would be right**. They are not a coverage story; they are a
**more conservative decision than the capability's own average at the same coverage**.

The same arithmetic prices the other two:

| capability | declines | median coverage | its band's rate | expected recoverable |
| --- | --- | --- | --- | --- |
| MR | 28 | 52.8% | 67% | **≈ 19** |
| TR | 41 | 39.7% | 48% | **≈ 20** |
| IE | 13 | 42.9% | 60% | **≈ 8** |
| **total** | **82** | | | **≈ 47 questions ≈ +9.4pp** |

**So the largest recoverable loss in the configuration is not retrieval and not arithmetic — it is 82 declines
whose evidence is worth roughly 47 correct answers at the rate the same coverage already achieves.**

### 13.53.2 What this does not license

It does not license "tell the model to answer more". The declines are *correct* decisions on the questions whose
evidence really is missing — §13.51.2's 0-coverage band declines 100% of the time and is right to. A contract that
pushes the model to answer would convert those into wrong answers, and the 47 above is an **upper bound** computed
by assuming every decline behaves like its band's average, which includes questions far better covered than they
are.

The distinction that would make this actionable is the one §13.40's contract already draws — **decline only when the
enumerated list is empty** — against what it currently permits, which is declining when the list is *incomplete*.
Those are different instructions and the run cannot tell them apart from the outside.

### 13.53.3 Why this is written now and not dispatched now

`k = 256` is in flight (§13.51.4) and it moves exactly the quantity this section prices: a wider candidate pool
raises coverage, and **higher coverage is worth more per question** (the 50–74% band is 67% against 43% for
25–49%). So the decline count after that run is the number that decides whether a contract change is the next
variable or a redundant one:

- if `k = 256` cuts the declines to §13.51.4's registered ≤ 30 (TR) and ≤ 24 (MR), a contract change buys less and
  the curve of `k` is worth more;
- if the declines barely move, the evidence for a contract change is this table, and it is strong.

**Registered as a decision rule rather than a prediction**, because the quantity it governs is measured by a run
that is already in flight.

### 13.53.4 Verification

- Every number comes from the roster of run `39005914398` read two ways: `python3 tools/readout-arm-run.py
  --coverage` for the band and median tables, and `failure_census` for the decline counts. No inline arithmetic is
  quoted that the tool does not reproduce.
- The "expected recoverable" column multiplies a count by a rate from the same band of the same capability. It is
  labelled an **upper bound** because it assumes each decline would have behaved like its band's average, which is
  the assumption §13.53.2 refuses to make on the model's behalf.

---

## 13.54 `k = 256`: the pool widened, the coverage did not, and the delta is inside the noise

### 13.54.1 The run

`795077a9`, `11:05:26Z` → `12:56:27Z`, **1h51m01s**, `success`, artifact 6,911,452 bytes. One variable against
§13.45's configuration: `relevanceTopK` from 64 to 256.

| line | value |
| --- | --- |
| `Restored` | 262,456 vectors |
| `Relevance index: 128000 scored …` | **21 seconds**, at `topK=256` — four times the pairs, three seconds more than `k = 64` |
| `Embedding cache: persisted` | 262,607 (151 new) |
| `scorer channels` | `structural 1433, exact 789, numeric 362, judge 1416/4000 = 35.4%` — against `k = 64`'s `1444 / 791 / 340 / 1425` |

The channel line is almost unchanged, and that was the first sign: **`structural` is the door an absent answer
leaves by, and it did not move.**

### 13.54.2 The five predictions

| # | registered in §13.51.4 | observed | verdict |
| --- | --- | --- | --- |
| **1** | median coverage rises: MR ≥ 60%, TR's declines ≥ 50% | MR **54.5%**, TR's declines **32.8%** | **falsified, and TR moved the wrong way** |
| **2** | the delta rises above +26.95pp | **+28.15pp** | **met**, by +1.20pp |
| **3** | the declines fall: TR ≤ 30, MR ≤ 24 | TR **37**, MR **32** | **falsified** — MR *rose* by 4 |
| **4** | ABS, IE, KU do not regress beyond 3 | ABS 0, IE **−2**, KU **−1** | **met** |
| **5** | the index build stays under 5 minutes | **21 seconds** | **met** |

### 13.54.3 What the falsification means: the pool was not the constraint

§13.51 reasoned that `topK` is a candidate pool and that widening it would put more gold turns in front of the
ranking. **The coverage did not rise.** MR's median coverage on the questions it answers is 54.5% against 54.2%,
and TR's decline median **fell** from 39.7% to 32.8%.

The coverage table still predicts accuracy — it did at `k = 64` and it does here, band for band — so coverage is
still the constraint. **What is falsified is that `k` is the lever on it.** A plausible reading, and it is a reading
rather than a finding: the window is bound by the **character budget**, not by the pool, so the 47 turns admitted
are chosen from 64 or from 256 and the extra 192 candidates are turns whose similarity score is close to the 47th's
— substitutes, not additions. Reciprocal-rank fusion over more candidates can reorder the same window without
enlarging it.

### 13.54.4 The delta, and why it is not adopted

`+28.15pp` against `+26.95pp` is a difference of **1.20pp**, and three facts say it is not evidence:

- **The repetitions disagree more than the runs do.** `k = 256`'s four repetitions span `0.708–0.738` (3.0pp) and
  `k = 64`'s span `0.714–0.726` (1.2pp), so the run-to-run difference is smaller than one run's own spread.
- **The baselines moved by 0.7pp** (0.4495 → 0.4425), which is more than half of the delta's movement, and the
  baseline is not under treatment.
- **The capabilities trade rather than improve**: MR −2, IE −2, KU −1, TR +2. A real improvement in the mechanism
  the registration named would not cost two questions in MR, which is the capability whose coverage it was
  supposed to raise.

So `k = 256` is **not adopted**. `k = 64` stays the registered value, and the reason is stated rather than the
`+28.15pp` being quoted: **the higher delta belongs to a configuration that regressed on the capability the
hypothesis was about.**

This is the campaign's own rule applied to a number that went the right way — §13.45 adopted `+26.95pp` over
`+25.75pp` on a mechanism the channel table supported, and this one has no such support.

### 13.54.5 What it settles, and the decision rule it triggers

§13.53.3 registered a decision rule rather than a prediction: *"if the declines barely move, the evidence for a
contract change is this table, and it is strong."*

**The declines barely moved, and in the wrong directions.** Total declines 82 → 83 (MR 28 → 32, TR 41 → 37, IE 13
→ 13, KU 0 → 1). §13.53 priced 82 declines at roughly 47 recoverable questions; nothing in `k = 256` recovered any
of them.

**So the next variable is the contract, not the pool.** That is §13.55.

### 13.54.6 Verification

- `pnpm check` **exit 0** at `cdc046fd`; `Verify` **success**. No code changed in this section.
- Every number came from the two committed tools: `python3 tools/readout-arm-run.py --reference` for the delta and
  the per-capability counts, and `--coverage` for the band and median tables. The `k = 64` comparison numbers are
  the same tools run on run `39005914398`'s artifact.
- **Predictions 1 and 3 are reported as falsified**, including the sign of prediction 1's TR movement, and the
  `+1.20pp` delta is declined on three stated grounds rather than on a preference.

---

## 13.55 The contract made the list the licence to decline, and a non-empty list withdraws it

### 13.55.1 What it said

```text
Do not reply INSUFFICIENT_EVIDENCE without first writing the Step 1 list:
a bare INSUFFICIENT_EVIDENCE with no list is not a valid response.
```

That forbids a **bare** decline and permits declining **after a list** — and the lists this contract produces are
long. Of run `39005914398`'s 28 MR declines, **every one names at least 7 gold turns** (median 24) and carries a
median of 12. The model is enumerating evidence and then declining with it in hand.

### 13.55.2 What it says

```text
Reply INSUFFICIENT_EVIDENCE only when the Step 1 list is empty. If it has at least one item,
Step 2 must state the number computed from it — the count of the items you listed, the total
of the amounts you listed, or the value it names — even when you believe the list is incomplete.
```

**It does not ask the model to answer more.** It makes the list the deciding fact. An **empty** list is a real
state and declining on it is right — §13.51.2's 0-coverage band declines 100% of the time and is correct to. A
non-empty list means there is a number to compute, whatever the list is missing.

The older sentence stays, because an empty Step 1 must be **written** as well as be empty, and the two together
say: write the list, and let its contents decide.

### 13.55.3 Reach, which is what makes this a single variable

The sentence is inserted into `ENUMERATION_CONTRACT`, which reaches **the multi-session route alone** — the
property §13.34 established and `evidence-ask-reach.test.ts` asserts byte-for-byte: on `flat` and `temporal`,
`enumerated` and `computed` build the same prompt. So:

| route | affected | why |
| --- | --- | --- |
| multi-session (MR) | **yes** | the only route that receives the two-step contract |
| flat, temporal (IE, KU, TR) | no | byte-identical to `computed` |
| abstention (ABS) | no | its own block, and §13.34 deliberately keeps `abstention` out of reach |

### 13.55.4 Registration

**One variable**: the contract sentence. Every input held at §13.45's values, `k = 64` (§13.54 declined `k = 256`).

| # | prediction | falsified if |
| --- | --- | --- |
| **1** | **MR's declines fall by at least a third**: 28 → **≤ 18** | above 22 |
| **2** | **The delta rises above +26.95pp** — the net of declines recovered against answers newly wrong | at or below +26.95pp |
| **3** | **Some declines become wrong answers**, and the taxonomy shows it: MR's `numeric_mismatch` rises above **24** | `numeric_mismatch` does not rise |
| **4** | **Nothing outside MR moves**: ABS, IE, KU, TR within 2 questions | any moves by more than 2 |
| **5** | **MR's median coverage on its declines does not fall.** A forced answer should be computed from the same evidence, not from worse evidence | declines' median coverage drops below 50% |

**Predictions 1 and 3 are a pair and that is the point.** §13.53 priced the declines at ≈47 recoverable questions
and called it an **upper bound** precisely because a contract that pushes the model to answer converts some correct
declines into wrong answers. A run that showed only prediction 1 and not 3 would be suspicious: it would mean the
declines had no evidence behind them at all, which §13.53's band table says is false for at least half of them.

**Prediction 5 is the one that distinguishes two mechanisms.** If the forced answers come with a coverage drop, the
model is answering from worse evidence — guessing — and the contract is trading accuracy for answers. If coverage
holds, it is computing from what it had and declining less often, which is the intended change.

**The reading rule.** If 2 holds, the contract is adopted and the next question is whether the same trick helps TR
(whose declines are 41 and whose block is a different one). If 2 fails while 1 and 3 hold, the trade is real and
negative: the right response is to revert the sentence and record that the declines were largely correct. Either
way the `numeric_mismatch` movement is the number that says what the trade cost.

### 13.55.5 Verification

- `pnpm check` **exit 0**; `cortex-memory` **347 tests** (+2); four coverage dimensions **100%**.
- **Red first in the sense that matters**: the two new assertions are about text the prompt did not contain, and
  the third test — that the sentence does not reach the flat route — was written, found to duplicate a property
  `evidence-ask-reach.test.ts` already asserts byte-for-byte, and **removed rather than kept as a weaker copy**.
  Its 37 tests pass unchanged, which is the check that this section's change is confined.
- The reach table is not an assertion in this section; it is `evidence-ask-reach.test.ts`'s existing one, and the
  reason it is quoted is that this change would be a two-variable dispatch if it were false.

### 13.55.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The contract change is **dispatched**; §13.55.4's five predictions are registered | yes (in flight) |
| **P0 (done)** | Configuration (§13.45), its load-bearing signal (§13.50), `k` excluded as the lever (§13.54), the declines priced (§13.53) | no |
| **P1** | If the contract holds: the same question for **TR**, whose 41 declines are the largest block and whose block is not the enumerated one | yes |
| **P1** | A better no-signal control (§13.50.4): random turns, turning −64.30pp from an upper bound into a contribution | yes |
| **P1** | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P2 | A run that publishes only what it restored can delay the cache's convergence by one index build; the writer's reduced manifest is not uploaded | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

## 13.56 The five predictions of §13.55.4, read against run `39035438120`

### 13.56.1 The run

`39035438120`, `13:10:00Z` → `15:03:44Z`, **1h53m44s**, `success`, artifact `12104633586`, 6,901,835 bytes. One
variable against §13.45's configuration: the §13.55 sentence, in the multi-session block.

| line | value |
| --- | --- |
| `Restored` | 262,607 vectors — the cache converged (§13.37's repair held for a third run) |
| `Relevance index: 32000 scored …` | 17 seconds at `topK=64` |
| `Embedding cache: persisted` | 262,703 (**96** new) |
| `scorer channels` | `structural 1424, exact 773, numeric 373, judge 1430/4000 = 35.8%` |

The channel line is the contract's fingerprint and it moved in the right direction: against §13.45's
`1444 / 791 / 340 / 1425`, the **numeric** gate decided 33 more questions and `structural` — the door an absent
answer leaves by — decided 20 fewer. More responses ended in a number, and that is what the sentence asked for.

### 13.56.2 The five predictions

| # | registered in §13.55.4 | observed | verdict |
| --- | --- | --- | --- |
| **1** | MR's declines fall by at least a third: 28 → **≤ 18** | **23** | **falsified** — 5 fewer, 17.9%, and above the 22 that falsifies it |
| **2** | delta rises above **+26.95pp** | **+26.90pp** | **falsified** — at the threshold |
| **3** | MR's `numeric_mismatch` rises above **24** | **27** | **met** (+3) |
| **4** | ABS, IE, KU, TR within 2 questions | ABS 0, IE 0, KU **−3**, TR +1 | **falsified** by KU |
| **5** | MR's declines' median coverage does not fall below 50% | **50.0%** (from 52.8%) | **met**, by 0.0pp of margin and in the wrong direction |

Predictions 1 and 3 were registered as a pair — a contract that pushes the model to answer converts correct
declines into wrong answers — and **that is exactly what the roster shows**: 3 of the declines it moved became
correct, 2 became `numeric_mismatch`, 2 became prose. The mechanism is confirmed; the size is not.

### 13.56.3 Why prediction 1 failed, which is the finding

The roster has both runs' questions, so the 28 declines of run `39005914398` can be followed into
`39035438120` one at a time:

| what happened to a §13.45 decline | n |
| --- | --- |
| declined again | **21** |
| became correct | 3 |
| became `numeric_mismatch` | 2 |
| became prose | 2 |

**The 21 that declined again are the finding.** Read with `--declines`, 12 of them carried a **non-empty Step 1
list**, one carried a list with no number, and 8 carried an honest empty list. The sentence said *decline only
when the list is empty*, the model wrote the list, and then declined anyway — because **the block's closing line
is the last thing it reads**:

```text
… Step 2 — compute the answer from that list …
Reply INSUFFICIENT_EVIDENCE only when the Step 1 list is empty. If it has at least one item, …
Reply with the answer alone. If the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE.
```

§13.55 inserted its rule **before** that last line, on the argument that an exception belongs adjacent to the rule
it excepts. The model reads the exception, then reads the rule, and follows the rule — which is last, and which
licenses declining on exactly the condition these questions meet (`the evidence does not contain the answer`,
because no single turn does).

**The witness.** `7024f17c`, gold `0.5 hours`, answered:

```text
Step 2 — Only one completed activity is in the list: the 30-minute jog. No yoga hours were performed.
Total = 0.5 hours of jogging; 0 hours of yoga.
INSUFFICIENT_EVIDENCE
```

It computed the gold and appended the sentinel. That is not a model that could not answer; it is a model whose
last-read instruction overrode its own arithmetic.

### 13.56.4 Prediction 4's falsification is a defect in the registration, and the control measures the instrument

KU moved by 3 and the threshold was 2. The prompt on KU is byte-identical between the two runs
(`evidence-ask-reach.test.ts`, 37 assertions), so nothing about the change can produce the movement — but
"it is noise" is an assertion unless the noise is measured.

**The four untouched capabilities are the measurement.** Same prompt, same configuration, two draws: of their 379
questions, **23 changed state** (correct ↔ decline ↔ one of the failure shapes) — **6.1%**. MR, whose prompt did
change, moved 24 of 121 — **19.8%**, three times as much, which is the independent evidence that the sentence was
not inert.

At 6.1%, the expected number of state changes in KU's 72 questions is **4.4**. The registered tolerance was 2.
**The tolerance was below the instrument's resolution**, for every capability: IE's is 9.2, TR's is 7.7. So
prediction 4 is falsified as written, and the falsification says the threshold was wrong rather than that the
change leaked. Both halves of that sentence belong in the record; the second does not cancel the first.

**The 6.1% is an average, and that is the second half of the correction.** `--paired` prints the rate per
capability, and the four untouched capabilities do not share one:

| capability | questions | changed state | rate |
| --- | --- | --- | --- |
| ABS | 30 | **0** | 0.0% |
| IE | 150 | 2 | 1.3% |
| KU | 72 | 6 | 8.3% |
| TR | 127 | 15 | **11.8%** |

So "two questions" is far below resolution for TR (15 expected) and KU (6), and it is **above** it for ABS and
IE. A single number would have been a better instrument than a guess and a worse one than four, and it is worth
saying which one this is: **the noise floor is a property of the capability, not of the run.** Every future
tolerance in this document is registered per capability with that capability's own rate beside it, or it is
registered as a direction rather than a count.

### 13.56.5 Prediction 2 fails, so the sentence is retired — and the replacement is not a second guess

The registered reading rule was: *"If 2 fails while 1 and 3 hold, the trade is real and negative: the right
response is to revert the sentence and record that the declines were largely correct."*

Prediction 2 failed. Prediction 1 failed too, so the rule's premise is not met exactly — but the conclusion is
the same and stronger: **the sentence changed the right population and moved nothing**, because its position
made it advisory. It is retired.

**What is not retired is the defect it named.** The census is a measurement, not a hypothesis:

| | §13.45 | §13.55 | what it means |
| --- | --- | --- | --- |
| MR declines | 28 | 23 | — |
| …with a non-empty list and a number in Step 2 | 19 | **12** | the contract forbids this state and it persists |
| …with an empty list | 6 | 9 | honest, and no wording repairs them |
| …with no Step 1 at all | 1 | 1 | the older sentence forbids this outright |

Twelve records where the model listed items, computed a number, and declined. Priced at **MR's own accuracy on
the questions it does answer in the same coverage band** — 68.3% at 50–74%, 38.3% at 25–49% — those twelve are
worth **8.5 correct answers**, or **+1.7pp**. That is the prize, and it is now measured rather than inferred from
§13.53's 47.

**The cheaper repair was priced and declined.** If the number is already in Step 2, the parser could salvage it
instead of asking the model to change. Of the 13 such records in this run (12 plus `ba358f49`, which has a list
and no number), the gold number appears anywhere in Step 2 in **2** — and one of those two is a coincidence
(`51c32626`, gold `February 1st`, matched by a session number `1`). A parser-side salvage is therefore worth **at
most one question and probably zero**, and it would answer where the model said it could not. Not adopted: the
cheap repair is cheap because it does almost nothing.

### 13.56.6 Verification

- Every number above comes from a committed tool: `--reference` and `--coverage` for the headline and band
  tables, and the new `--declines` for the census. `python3 -m pytest tools/__tests__ -q` → **426 passed,
  40 subtests**.
- `--declines` is §13.52's argument applied a fourth time: this census chose a variable, and a variable chosen by
  an inline script is a prediction its reader cannot re-derive (§13.38). Its 14 tests pin the four states, the
  negation rule that separates an honest empty list from a listed one, the heading shapes the model writes, and
  the near-misses it must not split on.
- The paired transitions are a cross-draw comparison — each report carries **one** repetition's roster — and are
  stated as such. The 6.1% control is the same comparison on questions whose prompt did not move, which is what
  makes it a control.

---

## 13.57 The closing line is the one that decides

### 13.57.1 The change

The multi-session block's **last line** is replaced. Nothing else in the prompt moves.

| | line |
| --- | --- |
| §13.45–§13.55 | `Reply with the answer alone. If the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE.` |
| §13.57 | `Reply with the Step 2 number alone. If the Step 1 list is empty because the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE.` |

### 13.57.2 Why replacement rather than another sentence

§13.55 treated the block as a place to put a rule and lost to position. A rule that has to decide cannot be a
second statement placed near the first; it has to **be** the first. The new line carries both halves the control
line carried — *reply with the answer alone* and *reply with the token when there is no answer* — with the
condition for the second moved from the evidence to the list.

That is also why `withReplacedClose` takes no `old` argument. "The closing line" is a position, not a string; a
function that named the text would let the prompt and the replacement drift apart silently, which is the
consolidation-clock shape this package removes elsewhere.

### 13.57.3 Reach, which is what keeps it one variable

`ENUMERATED_MULTI_SESSION_INSTRUCTION` is built by `buildSessionPrompt` under `ask: enumerated` and by nothing
else, so the reach is §13.55.3's table unchanged: multi-session only, ABS/IE/KU/TR byte-identical to `computed`.
`evidence-ask-reach.test.ts` asserts it byte for byte and passes unchanged (37 tests).

The one claim this section makes about its own size is a test: every line of `computed`'s prompt except its last
appears in `enumerated`'s, and the last does not. A future edit that adds a line to the contract breaks nothing;
an edit that lets the two closing lines agree again fails.

### 13.57.4 Registration

**One variable**: the block's closing line. Every input held at §13.45's values, `k = 64`, `promptContract:
abstention-evidence-blocks`. The control is run `39035438120`, because this run differs from it by exactly one
line.

| # | prediction | falsified if |
| --- | --- | --- |
| **1** | **The state the contract forbids collapses**: MR declines with a non-empty list and a number in Step 2 fall from **12 to ≤ 4** | ≥ 9 |
| **2** | **MR's declines fall from 23 to ≤ 15** | ≥ 20 |
| **3** | **MR's correct count rises from 61 to ≥ 66** — the 12 convert at more than half of 8.5, because a converted decline still has to be counted right | ≤ 63 |
| **4** | **The four untouched capabilities hold**: ABS+IE+KU+TR combined correct stays within ±6 of **293** | outside ±6 |
| **5** | **MR's declines' median coverage does not fall below 50%** | below 50% |

**Prediction 1 is the mechanism and 3 is the money**, and they are registered together for the reason §13.55.4
gives: a run that showed 1 without 3 would mean the converted declines were answered from worse evidence than the
ones it already answers, which is a trade rather than a repair.

**Prediction 3 is deliberately below the 8.5 the census prices**, because §13.53's band rates are the accuracy of
questions the model chose to answer — and the twelve are questions it chose to refuse. Half of the band rate is
the honest expectation, and it is stated as a choice rather than derived.

**The reading rule.** If 1 holds and 3 does not, the model is answering from the same evidence and counting it
wrongly, which makes the arithmetic — 27 `numeric_mismatch` in this run — the target, and no further contract
wording. If 1 fails again, then the closing line is not the operative instruction either, and the remaining
reading is that these twelve declines are **judgements about the evidence** that no prompt position overrides;
the next variable would then be on the retrieval side, where a gold turn that is present but not decisive is the
thing to measure. Both outcomes are informative, which is why the run is worth its 1h54m.

### 13.57.5 Verification

- **Red first, on the three assertions that state the change**: with `prompt.ts` at `6d13ab5`, `ends the
  multi-session block with the conditional line`, `no longer contains the unconditional licence anywhere` and
  `differs from the control by additions and exactly one replaced line` all fail; the two invariant tests —
  `computed` is byte-identical, a bare decline is still refused — pass before and after, which is what makes them
  invariants rather than restatements.
- `pnpm check` **exit 0**; `cortex-memory` **350 tests** (+3 net: two §13.55 assertions replaced by five);
  four coverage dimensions **100%** on every package except `cortex-node`'s branch column at 98.64%, which is
  §13.47's known and unrelated gap.
- The changed block is **one line shorter in effect**: §13.55's sentence is retained but the control's closing
  line is gone, so the prompt carries the same rule twice and the second statement is the one in the deciding
  position. If this run holds, a follow-up can delete the first — as its own registered variable, not as
  housekeeping.

### 13.57.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The closing-line change is **dispatched**; §13.57.4's five predictions are registered | yes (in flight) |
| **P0 (done)** | §13.55.4 read in full: 1 and 2 falsified, 3 and 5 met, 4 falsified by a threshold finer than the instrument; the sentence retired; the defect located in the closing line | no |
| **P0 (done)** | `--declines`, the census that chose this variable, with 14 tests | no |
| **P1** | If 1 holds: **TR's 42 declines**, all bare, at 39.7% median coverage, on a route the contract does not reach — the same two-step treatment, and the first experiment where coverage says the evidence is *not* there | yes |
| **P1** | A better no-signal control (§13.50.4): random turns, turning −64.30pp from an upper bound into a contribution | yes |
| **P1** | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P2 | The §13.55 sentence, now redundant, as its own variable once the closing line is settled | yes |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

---

## 13.58 The union of the two sides is the target line, and it is 86.20%

### 13.58.1 What was being measured instead

Every section since §13.26 has ranked work by **delta**, and delta is a difference of two totals: the feature's
correct count against the reference pipeline's. That number is 71.40% against 44.20%, and it says the arm wins —
but it cannot say **where**, and §13.56's own reading shows why that matters: the per-capability table of the same
run has the feature **33.89 points behind** the reference on MR and **13.38 behind** on TR.

The two facts are not in tension. The feature wins IE and KU by 88.67 and 80.56 points, against a reference that
scores 1.33% and 0%. **The delta is a capability-coverage win, and nothing in it argues that any single capability
is better than the reference's.**

### 13.58.2 The number that does say where work is worth doing

For each question, ask whether **either** side answered it correctly. That set is proof the information was
available to *some* pipeline on this exact input, which makes it recoverable in a way that "the reference is
better" is not.

| capability | n | reference | feature | **union** | gap |
| --- | --- | --- | --- | --- | --- |
| ABS | 30 | 30 | 29 | **30** | 1 |
| IE | 150 | 2 | 135 | **136** | 1 |
| KU | 72 | 0 | 58 | **58** | 0 |
| MR | 121 | 102 | 61 | **108** | **47** |
| TR | 127 | 88 | 71 | **99** | **28** |
| **total** | 500 | 222 | 354 | **431 = 86.20%** | **77** |

**75 of the 77 recoverable questions are in MR and TR.** The other three capabilities are 2 questions from
closed. So "make the union into one system" and "fix MR and TR" are the same sentence, and that is a much stronger
statement than either capability's delta.

### 13.58.3 Why it took a guard to get the number right

The roster carries the **feature's** correctness only; the reference's side has to be reconstructed from
`discordantQuestions`' two lists. The first attempt at that reconstruction had a sign wrong and read the
reference as **431/500** instead of 222 — which made the union look like 100%, a table with no gap in it at all.
Every number in it was individually plausible.

So `--union` recomputes the reference's total and **refuses to print** when it disagrees with the report's own
`baselineMetrics.correct`. The guard is not decoration: it is the only thing that distinguishes a derivation from
a coincidence, and §13.38's rule applies to a target line more than to a prediction — a target nobody can
re-derive is a target nobody can dispute.

### 13.58.4 What it changes about the campaign

- **The objective is 86.20%, not the next delta.** §13.57's five predictions stay as registered — they are about
  one line in one prompt and they will be read either way — but the ranking of what comes after them changes:
  MR's arithmetic (27 `numeric_mismatch`) outranks any further contract wording, and TR's 39.7%-coverage declines
  become "why is the gold turn not in the window", not "why will the model not answer".
- **The "beats all competitors" claim is now stated as false for this reading**, in the only form that can be
  argued with: 50.41% against 84.30% on the capability the benchmark is cited for. §13.56's finding is the first
  step of closing it, not a step towards a bigger total.

### 13.58.5 Verification

- `--union` is `readout-arm-run.py`'s fourth mode, with 3 tests: the union and the gap, and the guard firing on a
  report whose discordant lists do not describe its roster.
- `python3 -m pytest tools/__tests__ -q` → **429 passed, 40 subtests**. `pnpm check` **exit 0**, four coverage
  dimensions **100%** (`cortex-node` branch 98.64%).
- The table above is that tool's output on run `39035438120`'s artifact, unedited.

### 13.58.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Run `39076055833` (the closing line) is **in flight**; §13.57.4's five predictions stand | yes (in flight) |
| **P0 (done)** | The target line exists and is re-derivable; the roadmap's §11 is rewritten around it | no |
| **P1** | MR's arithmetic — 27 `numeric_mismatch`, and no variable has yet pointed at it | yes |
| **P1** | TR's evidence gap — 42 declines at 39.7% median coverage, measured before any prompt change | yes |
| **P1** | A better no-signal control (§13.50.4) | yes |
| **P1** | Restore the trace product's turn unit and its `goldOverlap` (§13.33.3) | no |
| P2 | The §13.55 sentence, now redundant, as its own variable | yes |
| P3 | `PATH` ordering | no |

---

## 13.59 MR's arithmetic is not the defect: in ten of twenty-seven the model counted its list correctly

### 13.59.1 What §13.58.4 said, and why it was one reading too early

§13.58.4 ranked MR's arithmetic first: *"27 `numeric_mismatch`, and no variable has pointed at it."* That
statement is true about the count and wrong about the mechanism, and the artifact settles it. This section
records the correction before the next dispatch rather than after it.

### 13.59.2 The measurement

`--counted` reads two fields that every other readout reads one at a time: the length of the model's own Step 1
list (`rawOutput`) and the first number in the graded answer (`answer`). For MR's 27 wrong numeric answers:

```
  question       listed answered  gold gold-ans    cov
  0a995998            2        2     3       +1   0.59  <- counted its list
  gpt4_15e38248       1        1     4       +3   0.17  <- counted its list
  88432d0a            2        2     4       +2   0.27  <- counted its list
  d23cf73b            3        3     4       +1   0.40  <- counted its list
  2ce6a0f2            3        3     4       +1   0.46  <- counted its list
  gpt4_31ff4165       3        3     4       +1   0.27  <- counted its list
  bf659f65            2        2     3       +1   0.41  <- counted its list
  81507db6            2        2     3       +1   0.29  <- counted its list
  21d02d0d            1        1     2       +1   0.27  <- counted its list
  gpt4_7fce9456       3        3     1       -2   0.35  <- counted its list
  …
  counted its list: 10 of 27 -- the answer is exactly the number of items Step 1 listed
  off by exactly one (gold one higher): 10 of 27
```

**Ten of the twenty-seven answers are exactly the number of items the model listed.** It counted its own list
faithfully; the list was short. Nine of the ten have a positive difference, and **eight of those nine are off by
exactly one**. Their coverage is 0.17–0.59 — the two lowest bands, where this run's MR answers correctly 28.6%
and 38.3% of the time.

(The tenth, `gpt4_7fce9456`, is a parse artifact rather than a data point: its gold is a sentence naming *four*
properties and `numbers_in` reads the `1` in `1-bedroom`. The counter is faithful there too; the ground truth is
not a number. Recorded rather than silently excluded, because it is one of the ten.)

### 13.59.3 What it settles

**Step 2 is not where MR fails.** In a third of MR's numeric errors the arithmetic is exactly right and the
input to it is short. So "ask the model to count more carefully" is aimed at a defect that is not occurring, and
the two candidate repairs are now distinguishable:

| defect | evidence | repair |
| --- | --- | --- |
| the model counts wrongly | **17 of 27** — answer differs from the listed count | arithmetic, a prompt or a verifier |
| the model is shown too little to count | **10 of 27** — answer = listed count, and gold is higher | enumeration recall, a selection problem |

And §13.34.3 already measured the second one's shape: **the room holds a median of 26 turns against a median
gold set of 24**, so a perfect selector at this room would reach **0.917** median coverage. The turns are not
missing for want of space. A faithful count of a 0.40-coverage window is therefore **the expected output of a
selector that finds two of four pieces**, and no instruction inside Step 2 can change it.

### 13.59.4 The correction it forces

§13.58.4 put MR's arithmetic first. **It moves below the selection question**, and MR's 47-question gap is not
recoverable by wording. What remains ranked is:

1. **The closing line** (in flight, `39076055833`) — unaffected: it targets the 12 refusals, which are a
   different population, and its prediction 1 counts that population rather than accuracy.
2. **The selector** — §13.26–13.34 have now excluded the pool size, the unit and the room; what is left is the
   **signal** that ranks a turn for a counting question. That is the largest open question in the campaign and
   it is a research question, not a registration.
3. **The arithmetic** — 17 questions, real, and downstream of the refusal/selection work rather than ahead of it.

This is the fourth time a measurement has demoted a variable that a plausible reading had promoted (`k`, the
sentence, the units, the arithmetic). The pattern is worth naming: **every one of those readings was about how
the model behaves, and every correction came from measuring what it was given.**

### 13.59.5 The same measure on the previous artifact, because one draw is not a mechanism

§13.56.4 measured this instrument's cross-draw resolution at 6.1%, so a claim about a *mechanism* has to be
checked on a second draw or it is a claim about one sample. The same tool, run on `39005914398`'s artifact:

| run | MR numeric failures | counted its list | off by exactly one |
| --- | --- | --- | --- |
| `39005914398` (§13.45) | 24 | 6 | **9** (37.5%) |
| `39035438120` (§13.55) | 27 | 10 | **10** (37.0%) |

The **off-by-one rate is stable at 37%** of MR's numeric failures across two independent draws, which is what
makes it a mechanism rather than a sample. The "counted its list" rate is less stable (25% → 37%), and the
difference between the two rows is the honest statement of what one draw can support: the *sign and size* of the
shortfall replicates, the *attribution* to faithful counting does not replicate as tightly.

### 13.59.6 Verification

- `--counted` is `readout-arm-run.py`'s fifth mode, with 4 tests: the predicate, the population it excludes, the
  sign of the difference (a faithful short count reads positive, and a column that read −1 would say the model
  over-counted), and the capability filter.
- `python3 -m pytest tools/__tests__ -q` → **433 passed, 40 subtests**.
- The table is the tool's output on run `39035438120`'s artifact, unedited and untruncated in the rows that
  matter; the `…` above hides rows whose answer differs from their list, which are the 17.

### 13.59.7 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | Run `39076055833` (the closing line) — read when it lands; §13.57.4's five predictions are unchanged | yes (in flight) |
| **P1** | **The selector's signal**, now the largest open question: pool, unit and room are excluded and the room is sufficient | no, to design; yes, to measure |
| **P1** | MR's 17 arithmetic errors — real, downstream | yes |
| **P1** | TR's 42 declines at 39.7% coverage — the same coverage story in a capability the contract does not reach | yes |
| **P1** | A better no-signal control (§13.50.4) | yes |
| P2 | The §13.55 sentence as its own variable | yes |
| P3 | `PATH` ordering | no |

---

## 13.60 Run `39076055833`: the closing line worked, and the reader threw the answers away

### 13.60.1 The run

`39076055833`, `22:40:53Z` → `00:24:25Z`, **1h43m32s**, `success`, artifact `12119497195`, 6,869,579 bytes.
One variable against `39035438120`: the block's closing line.

### 13.60.2 The five predictions

| # | registered in §13.57.4 | observed | verdict |
| --- | --- | --- | --- |
| **1** | MR declines with a non-empty list and a number in Step 2: 12 → **≤ 4** | **9** | **falsified** (at the line) |
| **2** | MR's declines fall from 23 to **≤ 15** | **20** | **falsified** (at the line) |
| **3** | MR's correct count rises from 61 to **≥ 66** | **55** | **falsified**, by 6 in the wrong direction |
| **4** | ABS+IE+KU+TR combined within ±6 of 293 | **298** (29+134+62+73) | **met** |
| **5** | MR's declines' median coverage ≥ 50% | **50.0%** | **met** |

**And those verdicts are not the run's verdict on the closing line**, which is the rest of this section.

### 13.60.3 What the artifact showed instead: a reader defect the run exposed

The transition table (`--paired` against `39035438120`) had one row nobody predicted:

| MR transition | n |
| --- | --- |
| **correct → other** | **11** |
| numeric_mismatch → other | 6 |
| abstention → correct | 3 |
| abstention → numeric_mismatch | 3 |
| other → correct | 3 |
| … | … |

Eleven *previously correct* MR answers became "other". Reading them is decisive: **nine of the eleven have an
empty answer** (`''`), and the raw output that produced them is not empty:

```text
Step 1 — items matching "plants I acquired in the last month":
- Peace lily and a succulent plant, obtained from the nursery two weeks before 2023/05/20 (Session 2)
- Snake plant, got from sister last month (Session 3)

Step 2 — 2
```

The answer is `2`, on the heading's line. The parser returned `''`.

**The defect.** `afterLastStepHeading` sliced from `offset + line.length + 1` — after the heading **line**,
because that is what skips an echoed instruction. The `+ 1` is the newline that ends the line. When the heading
line is the **last** line there is no such newline, `slice` starts past the end of the text, and every answer
written *beside* the heading reads as blank. The rule's own comment recorded the shape as unobserved — *"118 put
the answer on its own line after the last heading, and 0 put it on the heading line itself"* — so `''` was a
conservative answer rather than an error. **It is now observed, and it is the shape the closing line produces.**

### 13.60.4 The measurement, which is why this is not a bug report but a verdict

`parseAnswer` was rebuilt with the repair and run over the stored `rawOutputs` of three artifacts. This re-reads
**the same model outputs** — it is not a re-run, and it cannot re-derive the headline (the roster carries one
repetition and the registered statistic is a mean over four). What it does measure is exact:

| run | answers whose parse changes | of which were scored correct | gold number matches the new answer |
| --- | --- | --- | --- |
| `39005914398` (§13.45, the decided config) | 2 | 0 | 0 |
| `39035438120` (§13.55) | 8 | 0 | **1** |
| `39076055833` (§13.57) | **18** | 0 | **7** |

Three things follow, and the first is the verdict:

1. **The closing line worked.** The shape "the number beside the Step 2 heading" goes **2 → 8 → 18** across the
   three runs, and the closing line is what asks for it: *reply with the Step 2 number alone*. §13.57 asked the
   model to put the number there and it did. The reader then deleted it.
2. **The run's prediction 3 was measured through a broken instrument.** MR's observed 55 carries 7 questions the
   numeric gate would have accepted and 18 blanks that should not exist. So the honest reading of 55 is
   **"not less than 62"**, and the run **does not adjudicate §13.57**.
3. **The two published runs were slightly light too** — 2 and 8 answers — but in `39005914398` the gold never
   matched, so §13.45's headline is unaffected, and in `39035438120` at most one question of one repetition is,
   which is at most **0.2pp** on that repetition. Stated rather than left out, because the defect was in the
   tree when both numbers were produced.

### 13.60.5 The repair, and why the old test had to change

The rule is now: **if anything follows the heading line, the answer begins after that line** (the echo case,
unchanged); **otherwise it begins after the heading marker**, where the only content left is what the model
wrote.

The old test asserted `parseAnswer('Step 1 — …\n\nStep 2 — compute the answer from that list') === ''`, i.e. that
a heading-only response is blank. Under the new rule that response yields the echoed instruction, which is a
wrong answer rather than a blank one — and **the two score identically**: neither is `null`, so neither is an
abstention, and both classify as `other`. What the test was really guarding is that **the transcript is never the
answer**, and it is rewritten to assert exactly that, with a second test for the genuinely empty case
(`'Step 2 —'` with nothing after the marker). The three shapes are pinned separately: answer beside the heading,
answer below an echoed heading, and nothing at all.

**Red first**: `reads an answer that shares the heading line` fails on the old `parse.ts` and the other two pass
before and after, which is what makes them the invariants and the first one the change.

### 13.60.6 What this changes about the campaign

- **A run can be invalidated by a reader that no test covered**, and this one was: the parser had 6 tests and
  none of them had a heading as the last line with content beside it, because no archived artifact had ever
  produced that shape. **The closing line created the shape.** So the ordering rule this campaign has followed —
  register the prediction, dispatch, read — needs one more step that is cheap and was skipped: **before reading a
  run, re-parse its raw outputs with the current parser and confirm the answers the artifact carries are the
  answers it would produce today.** Two lines of `--` and a node script; it would have caught this in a minute.
- **The next dispatch is a re-run, not a new variable.** The closing line has never been measured. Its effect is
  bounded below by the 7 recovered questions in one repetition, and the 18 blanks are gone.
- **The re-read is not the number.** It is a lower bound on what the run would have shown, produced by one gate,
  and the section says so; the number comes from the next run.

### 13.60.7 Verification

- `cortex-memory` **352 tests** (+2 net); `pnpm check` **exit 0**; four coverage dimensions **100%**.
- **The new rule is a command, not a note.** `bench/reparse-report.ts` (run by `pnpm --filter
  @agentix-e/cortex-memory drift <report>`) prints every record whose stored `answer` differs from what today's
  parser produces, how many of those the gold's first number matches, and **exits 1**. On this run's artifact it
  reads 18 drifted records, 7 gold matches, and one example is enough to see the defect:
  `3a704032 stored "" -> today "2"` against a raw output that ends `Step 2 — 2`.
- The re-read used the **built** `dist/parse.js` of the repaired package rather than a Python re-implementation,
  so the "what would today's parser say" column is the parser's own answer and not a second definition of it.
- §13.60.3's transition table and §13.60.4's column are from `tools/readout-arm-run.py --paired` and the node
  script named above respectively; the script is two lines of `parseAnswer` over `rawOutput` and is reproducible
  from the artifact.

### 13.60.8 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | **Re-dispatch the closing line** on the repaired parser; the five predictions of §13.57.4 stand unchanged, because they were never read | yes |
| **P0 (done)** | The reader defect is fixed with three pinned shapes, and the two earlier runs are priced against it (0 and ≤1 question) | no |
| **P1** | The selector's signal (§13.59.4) — unchanged and still the largest open question | no, to design |
| **P1** | TR's 36 declines at 39.7% coverage — unchanged by this run, whose TR movement was inside its own 11.8% | yes |
| **P1 (done)** | The re-parse step: `pnpm --filter @agentix-e/cortex-memory drift <report>` compares every stored `answer` against today's parser and **exits 1 on any drift**, so a run cannot be read through a reader that no longer agrees with it | no |
| P2 | The §13.55 sentence as its own variable | yes |
| P3 | `PATH` ordering | no |

---

## 13.61 Run `39083274990`: the closing line is adopted on its mechanism, not on its delta

### 13.61.1 The run

`39083274990`, `00:34:44Z` → `02:24:18Z`, **1h49m34s**, `success`, artifact `12121877664`, 6,907,133 bytes.
Same variable as `39076055833` (§13.57), re-dispatched on the repaired parser (`d4eef555`). Its predecessor
is **not** a measurement of this variable and is not used as a control; the control is `39035438120`, the run the
closing line replaced.

**Drift check first**, per §13.60.6: `pnpm --filter @agentix-e/cortex-memory drift` → **500 of 500 records,
0 answers differ from today's parser**. So the roster this section reads is the roster today's reader produces,
which is the check that was missing last time.

| log line | value |
| --- | --- |
| `Restored` | 262,841 vectors |
| `Relevance index: 32000 scored …` | `topK=64`, 500 questions |
| `Embedding cache: persisted` | 263,098 (257 new) |
| `scorer channels` | `structural 1394, exact 833, numeric 405, judge 1368/4000 = **34.2%**` |

Against `39035438120`'s `1424 / 773 / 373 / 1430 = 35.8%`: **structural fell 30, numeric rose 32, judge fell
62**. Fewer declines, more answers decided by a number, and less work for the judge — the three moves the line was
written to produce, in one line of log.

### 13.61.2 The headline

| | `39035438120` control | `39083274990` | Δ |
| --- | --- | --- | --- |
| registered delta | +26.90pp | **+29.45pp** | **+2.55pp** |
| feature avg (4 reps) | 0.7115 | **0.7330** (0.724–0.740) | +2.15pp |
| baseline avg | 0.4425 | 0.4385 | −0.40pp |
| roster total | 354/500 | **365/500 = 73.00%** | +11 |
| ABS | 29 | **30/30** | +1 |
| IE | 135 | 134 | −1 |
| KU | 58 | 61 | +3 |
| **MR** | 61 | **64** | **+3** |
| TR | 71 | 76 | +5 |
| declines | 80 | **66** | −14 |
| McNemar | 3.0e-15 | **2.3e-18** | — |

**Every number in the table is the campaign's best except IE**, and the delta is 2.55pp above the configuration
§13.45 adopted. That is exactly the situation §13.54 was written for, and it is not enough.

### 13.61.3 The five predictions, including the band I failed to close

| # | registered in §13.57.4 | observed | verdict |
| --- | --- | --- | --- |
| **1** | forbidden state 12 → **≤ 4**; falsified if ≥ 9 | **7** | **neither** — fell 42%, missed the target, cleared the falsifier |
| **2** | MR declines 23 → **≤ 15**; falsified if ≥ 20 | **20** | **falsified**, at the line |
| **3** | MR correct 61 → **≥ 66**; falsified if ≤ 63 | **64** | **neither** — the band 64–65 decides nothing |
| **4** | ABS+IE+KU+TR within **±6** of 293 | **301** | **falsified** (+8) |
| **5** | MR declines' median coverage **≥ 50%** | **50.0%** | **met** |

**Two of these are defects in the registration rather than findings, and both are mine.**

- **Prediction 3 left 64–65 undecided.** I wrote a target and a falsifier with a gap between them and then
  produced an observation that landed in the gap. A prediction whose "met" and "falsified" conditions do not
  partition the integers is not a prediction; it is a wish with a tripwire. The rule going forward is the one
  §13.56.4 already stated for tolerances and this section states for targets: **the falsifier is the negation of
  the prediction**, not a second, looser number.
- **Prediction 4 contradicted the rule I had just written.** §13.56.4 concluded that *"every future tolerance is
  registered per capability with that capability's own rate beside it"*, and the very next registration pooled
  four capabilities into a ±6 band. TR's own cross-draw rate is **17.3%** this run (22 of 127 changed state), so
  TR +5 was inside its instrument before the run started; pooling made a noise floor look like a fence. The
  prediction is falsified as written and **it should not have been written that way.**

### 13.61.4 What actually moved, and how little of it the change can explain

The four capabilities whose prompts are **byte-identical** to the control moved **+8 questions** (ABS +1, IE −1,
KU +3, TR +5). The only capability the closing line reaches moved **+3**. So of the 11 questions that lifted the
roster, **MR accounts for 3 and 8 are on prompts this run did not change.**

That is the whole argument against reading the delta. Its rise is real as a number and **unattributable as an
effect**: the same 8 questions would have arrived from a run of the unchanged configuration, and TR's 17.3%
churn rate says so before any inference is attempted.

What *is* attributable is MR, and the paired transitions say how it got there:

| MR, `39035438120` → `39083274990` | n |
| --- | --- |
| numeric_mismatch → correct | **4** |
| other → correct | **3** |
| abstention → correct | **3** |
| **correct → numeric_mismatch** | **4** |
| correct → other | 2 |
| correct → abstention | 1 |
| other → numeric_mismatch | 2 |
| other → abstention | 2 |
| abstention → numeric_mismatch | 3 |

**Ten questions became correct and seven stopped being correct.** The seven are the cost §13.57.4 predicted —
*"some declines become wrong answers"* — and it is larger than a strict reading of the sentence would suggest,
because four of them were **already correct** and became wrong. Making the model commit to a bare number costs it
the answers that were right inside a longer sentence.

And `numeric_mismatch` rose **27 → 32**, which is that cost counted.

### 13.61.5 The decision, and what it rests on

**The closing line is adopted.** Not on `+29.45pp`, which §13.61.4 disassembles, but on three facts about MR that
all moved the way the registration said they would:

| the registration said | before | after |
| --- | --- | --- |
| the forbidden state collapses | 12 | **7** (−42%) |
| the declines fall | 23 | **20** |
| the cost appears as wrong answers | 27 `numeric_mismatch` | **32** |

Plus: the capability is +3 correct, no capability regressed beyond its own instrument, and the prompt is the same
length as the line it replaced.

**The caveat is part of the adoption.** +3 of 121 is inside a single draw's resolution — MR moved 24 questions
between two draws of *unchanged* configuration (§13.56.4). So this is a decision on mechanism, taken because three
independent predictions of the same intervention came true together, and it is deliberately **not** a claim that
MR is now 52.89%. If a later run of this configuration reads 61 again, that is consistent with everything here and
the mechanism numbers are what would disagree.

**What is explicitly not adopted**: any statement that the arm improved by 2.55pp. The number is recorded, the
attribution is refused, and the reason is in §13.61.4.

### 13.61.6 The union, which moves the roadmap's target again

| capability | n | reference | feature | union | gap |
| --- | --- | --- | --- | --- | --- |
| ABS | 30 | 30 | **30** | 30 | **0** |
| IE | 150 | 1 | 134 | 134 | **0** |
| KU | 72 | 0 | 61 | 61 | **0** |
| MR | 121 | 101 | 64 | 109 | **45** |
| TR | 127 | 87 | 76 | 102 | **26** |
| **total** | 500 | 219 | 365 | **436 = 87.20%** | **71** |

**Three of five capabilities now have a gap of zero** — the feature matches or beats the reference on ABS, IE and
KU, which it did not do in §13.58. The remaining 71 questions are **MR 45 and TR 26**, and nothing else. The
target line moves from 86.20% to **87.20%**, and the work is unchanged in kind: the two capabilities whose
evidence the selector does not find.

### 13.61.7 What the next iteration needs, and it is not another prompt

MR's 45 and TR's 26 have been localised as far as this artifact can take them: §13.59 showed the count is faithful
and the list is short, and §13.34.3 showed the room holds more turns than the gold set contains. What is missing
is **what the selector was choosing between** — the candidate pool and its scores. The artifact records what was
delivered (`featureRetrievedContexts`), what it cost (`promptChars`) and how much gold arrived (`goldOverlap`);
it does not record the ranked candidates the budget chose from, so the question "did the budget cut this gold
turn, or did the ranking never surface it" **cannot be asked of any run so far**.

That is the next piece of work: record the pool, with the gold membership of each candidate, so that the selector
question is answerable once instead of re-argued. It is the same lesson as §13.60 in a different place — the run
could not be read because the reader disagreed with it; this question cannot be asked because the artifact does
not carry the evidence. Both are cheap to fix and expensive to discover late.

### 13.61.8 Verification

- **Drift check passed before reading**: 500 of 500 records, 0 differences.
- `pnpm check` **exit 0**; `cortex-memory` **352 tests**; four coverage dimensions **100%** (`cortex-node`
  branch 98.64%, §13.47's known gap).
- Every number in this section is `tools/readout-arm-run.py`'s output on the artifact — `--reference`,
  `--coverage`, `--declines`, `--union`, `--counted`, `--paired` — plus the two log lines, which are the arm's
  own accounting.

### 13.61.9 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0 (done)** | The closing line is **adopted** on mechanism; run `39076055833` is retired as a measurement; drift is a command | no |
| **P0** | **Record the candidate pool** with gold membership, so "budget or ranking" becomes answerable | no, to build |
| **P1** | MR's 45 + TR's 26 (the whole of the remaining gap) — blocked on the pool measurement | yes, to measure |
| **P1** | A no-signal control with random turns (§13.50.4) | yes |
| P2 | The §13.55 sentence, now redundant, as its own variable | yes |
| P2 | Register targets whose falsifier is the negation of the prediction, and tolerances per capability (§13.61.3) | no |
| P3 | `PATH` ordering | no |

---

## 13.62 The candidate pool as a third count, so the next question can be asked once

### 13.62.1 The question six runs could not ask

`goldOverlap` has carried two numbers since §13.16: how many of the question's gold turns the reader
**received**, out of how many the dataset names. §13.61.7 is where the campaign noticed what those two cannot
say — **where the rest went** — and that the two destinations need opposite repairs:

| destination | what it means | what fixes it |
| --- | --- | --- |
| the ranking never surfaced it | the signal does not rank this turn for this question | a different signal |
| the ranking held it and the budget cut it | the order is wrong above the cut | a different order, or a bigger room |

`k = 64` and `k = 256` were both dispatched and both read without this distinction (§13.54 declined the second
on a coverage argument that could not name which of the two it had failed to move). So the instrument comes before
the next variable.

### 13.62.2 The change, which is three numbers and no behaviour

`GoldOverlap` gains an optional `pool`: the gold turns the ranking **offered**. With it the gold set partitions:

```text
total - pool      the ranking never surfaced it
pool  - carried   the ranking had it and the budget cut it
carried           it reached the reader
```

Three seams, each with its reason for being where it is:

- **`RelevanceIndex.candidatesFor(question)`** returns the turns the index holds a score for. It is the *keys of
  the map `relevanceFor` reads*, not a second structure, so "in the pool" and "scored above the floor" cannot
  disagree — the equivalence is asserted in `relevance-index.test.ts` rather than left to two implementations.
  A `Set` and not a ranked list, because the order belongs to the selection and this module deliberately discards
  the ranking `retrieveTopKByQueries` returns.
- **`goldOverlapOf(retrieved, goldTurns, poolGold?)`** counts the third membership. The parameter is spread rather
  than assigned, so a caller that consulted no ranking gets the two-field object it got before this existed —
  byte-identical in JSON, which is what keeps every archived artifact's meaning unchanged.
- **`CortexMemoryArmRunOptions.relevancePoolFor`** is the one option in this arm that is a **handle rather than a
  setting**. Eval owns the index and eval owns the gold, and the arm is the only place both are in scope; putting
  the pool on `CortexMemoryOptions` instead would put the dataset's annotation one field away from the selection,
  which is the boundary `relevance-index.ts` spends a paragraph defending.

### 13.62.3 The absence, which is the part that had to be right

With `relevanceSignal: none` there is no ranking and therefore no pool. That run's record must **omit** `pool`,
because a `0` would read as "the ranking surfaced none of the gold" — a measured miss standing in for a
measurement that never happened. This is the same rule as `goldOverlap: null` and the same rule `§13.11.2`
established, applied one field further out.

And the function does **not clamp**. A caller that passes a pool the retrieval did not produce gets
`carried > pool`, which is impossible and therefore visible. A clamp would turn a caller defect into a plausible
row that reads as a finding — the failure mode this package refuses everywhere else.

### 13.62.4 Registration

**One variable** — the pool capture — and it is **instrumentation, not a treatment**. Every input held at
§13.61's adopted configuration. Because it touches no prompt and no selection, the predictions are about the
instrument and about the question it makes askable, not about accuracy.

| # | prediction | falsified if |
| --- | --- | --- |
| **1** | **The instrument is inert**: the roster total stays within **±11** of 365, and `pool` is present on every record whose question names gold turns | outside ±11, or a record with gold and no `pool` |
| **2** | **The partition is well formed**: `carried ≤ pool ≤ total` on **every** record | any record violates it |
| **3** | **The loss is in the order, not the ranking's reach**: summed over MR, `pool − carried` **>** `total − pool` | the reverse |

**Prediction 1's tolerance is ±11 for a stated reason**, and it is the rule §13.61.3 said I would follow: the four
capabilities this change cannot reach have measured cross-draw rates of 0%, 1.3%, 8.3% and 11.8%, which over
379 questions is up to 8 state changes, plus MR's 3. A tighter tolerance would be a fence built below the
instrument again.

**Prediction 3 is a bet with a reason, and the reason is an existing measurement.** `MEASURE-B2-RECALL-CURVE.md`
reads **recall = 0.921 at k = 50** — the pool already contains 92% of the gold — while §13.34.3 reads a perfect
selector at this room reaching **0.917** median coverage and the actual order reaching **0.55**. A pool that holds
92% of the gold, feeding a room that could hold 92% of it, delivering 55%, is a pipeline whose loss is **in the
order between the two**. So the expectation is that `total − pool` is small and `pool − carried` is large.

**Falsifying 3 would be the more interesting outcome**, and it is worth saying why: it would mean the 0.921 curve
does not hold at this width on this configuration, the ranking's reach is the constraint after all, and the next
variable would be the signal rather than the order.

### 13.62.5 Verification

- **Red first**: `counts the gold turns a ranking offered` and `keeps carried <= pool <= total` fail on the old
  `goldOverlapOf`; `omits the pool when no ranking was consulted` passes before and after, which is what makes it
  the invariant rather than a restatement. `names the turns it scored` fails on the old index.
- A fifth test pins the shape the invariant cannot cover: an inconsistent delivery is **reported, not clamped**.
- `pnpm check` **exit 0**; `cortex-eval` **1907 tests** (+8); four coverage dimensions **100%** on every package
  except `cortex-node`'s branch column at 98.64% (§13.47).
- The arm's wiring is tested at the seam that actually carries it — `runCortexMemoryArm` with and without
  `relevancePoolFor` — rather than by asserting that a type has a field.

### 13.62.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The diagnostic run is **dispatched**; §13.62.4's three predictions are registered | yes (in flight) |
| **P0 (done)** | The third count exists, with the absence and the no-clamp rules pinned by tests | no |
| **P1** | The order between pool and room — what prediction 3 decides, and the largest open question in the campaign | depends on the read |
| **P1** | MR's 32 `numeric_mismatch`, of which 21 differ from the model's own listed count (§13.59) | yes |
| **P1** | A no-signal control with random turns (§13.50.4) | yes |
| P2 | The §13.55 sentence, now redundant, as its own variable | yes |
| P3 | `PATH` ordering | no |

### 13.62.7 The readout, which had to exist before the run landed

The partition is two subtractions and it decides the next variable, so it is `--pool` in
`tools/readout-arm-run.py` rather than a shell line. Its four rules are the ones the field's own doc gives, and
each has a test: the three sums, the per-capability split, records **without** a pool counted rather than summed
as zero, and an artifact with no pool anywhere **refusing** instead of printing a table of zeroes. A fifth pins
the impossible row — `carried > pool` is reported, not clamped.

Verified against the adopted run's artifact before the diagnostic was dispatched: it exits **2** with the message
that the artifact predates the field. That is the refusal working on a real file rather than on a fixture.

---

## 13.63 The pool's reach is the larger loss, so the variable is the ranking and not the order

### 13.63.1 The run

`39098246215`, `04:46:18Z` → `06:30:51Z`, **1h44m33s**, `success`, artifact `12127901203`, 6,870,784 bytes.
A diagnostic: the configuration §13.61 adopted, plus the pool capture. Drift check first —
**500 of 500 records, 0 differences**.

### 13.63.2 The partition, which is the first time this table has existed

`--pool`, on the run's own records:

| capability | n | gold | never surfaced | cut by the budget | delivered |
| --- | --- | --- | --- | --- | --- |
| ABS | 30 | 672 | 253 (37.6%) | 95 (14.1%) | 324 (48.2%) |
| IE | 150 | 1709 | 266 (15.6%) | 141 (8.3%) | 1302 (76.2%) |
| KU | 72 | 1688 | 360 (21.3%) | 284 (16.8%) | 1044 (61.8%) |
| **MR** | 121 | 3663 | **1026 (28.0%)** | **903 (24.7%)** | 1734 (47.3%) |
| **TR** | 127 | 3228 | **1056 (32.7%)** | **694 (21.5%)** | 1478 (45.8%) |
| **total** | 500 | 10960 | **2961 (27.0%)** | **2117 (19.3%)** | 5882 (53.7%) |

### 13.63.3 The five predictions of §13.62.4

| # | registered | observed | verdict |
| --- | --- | --- | --- |
| **1** | the roster stays within **±11** of 365, and `pool` is on every record with gold | **357**, `pool` on all 500, none missing | **met** |
| **2** | `carried ≤ pool ≤ total` on every record | **no violations reported** | **met** |
| **3** | on MR, `pool − carried` > `total − pool` | **903 against 1026** | **falsified** |

Prediction 1's −8 is inside the tolerance §13.62.4 built from the four untouched capabilities' own rates, and
the per-capability counts — ABS 29, IE 136, KU 60, MR 64, TR 68 — are all inside the rates the last two paired
comparisons measured (ABS 3.3%, IE 3.3%, KU 9.7%, TR 17.3%). **The instrument is inert**, which is what a
diagnostic run has to establish before its measurement means anything.

### 13.63.4 What the falsification says, and it is not a disappointment

§13.62.5 wrote: *"Falsifying 3 would be the more interesting outcome … it would mean the 0.921 curve does not hold
at this width on this configuration, the ranking's reach is the constraint after all, and the next variable would
be the signal rather than the order."*

That is what happened, and it holds for **every** capability, not only MR — the never-surfaced column is the
larger one in all five rows. Two consequences, and they agree with measurements this campaign already had:

- **`k = 256` could not have helped, and §13.54's reading was right for a reason it could not state.** Widening a
  pool from 64 to 256 does nothing when the missing turns are not merely below the cut but far below it. §13.54
  concluded "the pool is not the lever" from coverage that did not move; this says **why**.
- **The loss is roughly 27% of gold never seen, 19% seen and cut, 54% delivered.** Both channels matter, the
  first more, and the first is the ranking's *recall* rather than its ordering.

So the next variable is **how a candidate is retrieved**, and the campaign already contains the mechanism:
`retrieveTopKByQueriesHybrid` in `retrieval.ts` fuses the dense ranking with a **rare-keyword channel** by
reciprocal rank — turns carrying a keyword from the question that appears in very few turns
(`MAX_KEYWORD_DOC_FREQUENCY = 5`). It was written for the reference pipeline's own recall curve and **has never
been the arm's ranking**.

### 13.63.5 The change: the index takes a mechanism instead of hardwiring one

| seam | before | after |
| --- | --- | --- |
| `RelevanceIndexOptions` | `topK` | `topK`, and an optional `retrieve` of type `Retrieval` |
| `buildRetrievalRelevanceIndex` | calls `retrieveTopKByQueries` inside the loop | resolves the retriever **once**, outside the loop |
| `RELEVANCE_SIGNALS` | `none`, `retrieval` | `none`, `retrieval`, **`retrieval-hybrid`** |
| the artifact | `relevanceSignal=retrieval` | says which mechanism ranked |

**Why a new value rather than editing `retrieval`.** A value whose meaning changes between two runs makes both
artifacts ambiguous, which is the rule `RELEVANCE_UNITS` already states for `session`. The name is what the
artifact carries, so the mechanism has to be a name.

**Why the retriever is a callback here and a name one layer up.** The index cannot hold a string and pick a
function without importing every mechanism; the bench cannot carry a string into `memoryArmConfig` if the
config is a function. Each layer keeps the representation it can honestly record.

### 13.63.6 Registration

**One variable**: the relevance signal, from `retrieval` to `retrieval-hybrid`. Everything else held at §13.61's
adopted configuration. The control is `39098246215` — the same tree, the same configuration, only the ranking
differs — and every prediction is read on the two instruments §13.62 built.

| # | prediction | falsified if |
| --- | --- | --- |
| **1** | **MR's pool reach improves**: `total − pool` falls from 1026 to **≤ 820** (−20%) | ≥ 1026 |
| **2** | **MR's correct count rises from 64 to ≥ 68** | ≤ 64 |
| **3** | **MR's median coverage rises from 54.2% to ≥ 58%** | ≤ 54.2% |
| **4** | **No capability loses more than its own measured cross-draw rate**: ABS 1, IE 5, KU 7, TR 22 questions | outside any of the four |

**Prediction 1 is the mechanism, 2 is the money, 3 is the channel.** They are separated because the hybrid can
raise reach without raising accuracy — a lexical channel can surface a turn that matches a keyword and is not
gold — and the campaign has learned to price that possibility before dispatching rather than after (§13.55,
§13.57).

**Prediction 4 is per capability with each one's own rate beside it**, which is the rule §13.61.3 established
after violating it. The four rates are measured, not chosen: they are the state-change counts of the last two
paired comparisons (`39035438120`→`39083274990` and that→`39098246215`), and the larger of each pair is used.

**The reading rule.** If 1 holds and 2 does not, the lexical channel is reaching turns that are not gold — a
precision cost — and the next question is which keywords, which `MAX_KEYWORD_DOC_FREQUENCY` bounds and which a
count of non-gold surfaced turns can answer. If 1 fails, then the never-surfaced turns are not reachable by a
keyword channel either, and the reading is that they are **semantically distant** from their question — which
would make the next variable a different embedding, not a different fusion.

### 13.63.7 Verification

- **Red first**: `uses the retriever it is given, so the signal can move without moving the index` fails on the
  old index, which had no way to be handed one.
- The four coverage dimensions stay **100%**; the new `retrieve` branch is covered by that test, and the default
  branch by every test that builds an index without one.
- `pnpm check` **exit 0**; `cortex-eval` **1908 tests** (+1).
- `retrieveTopKByQueriesHybrid` is **not new code**: it has shipped since the reference pipeline's recall work,
  with its own tests, and this run is the first time the arm's ranking has used it. That is worth stating plainly
  because it changes what the run can fail for: a null result indicts the *fusion*, not an untested kernel.

### 13.63.8 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The hybrid run is **dispatched**; §13.63.6's four predictions are registered | yes (in flight) |
| **P0 (done)** | The partition is measured on all five capabilities; prediction 3 falsified; the signal is the variable | no |
| **P1** | If reach rises and accuracy does not: which keywords, and what the non-gold surfaced turns cost | yes |
| **P1** | If reach does not rise: the never-surfaced turns are semantically distant, and the variable is the embedding | yes |
| **P1** | MR's 33 `numeric_mismatch` — still real, still downstream | yes |
| P2 | The §13.55 sentence, now redundant, as its own variable | yes |
| P3 | `PATH` ordering | no |

---

## 13.64 Run `39106951421`: the hybrid is adopted, and not for the reason it was dispatched

### 13.64.1 The run

`39106951421`, `07:15:01Z` → `09:15:58Z`, **2h00m57s**, `success`, artifact `12131284784`, 7,035,877 bytes.
Config line confirms the dispatch took: **`relevanceSignal=retrieval-hybrid`**.

`scorer channels`: `structural 1340, exact 836, numeric 408, judge 1416/4000 = 35.4%`, against the dense control's
`1394 / 833 / 405 / 1368 = 34.2%`.

### 13.64.2 The four predictions

| # | registered in §13.63.6 | observed | verdict |
| --- | --- | --- | --- |
| **1** | MR's `total − pool` falls from 1026 to **≤ 820** | **1031** | **falsified**, and it rose |
| **2** | MR's correct count rises from 64 to **≥ 68** | **64** | **falsified** |
| **3** | MR's median coverage rises from 54.2% to **≥ 58%** | **54.2%** | **falsified** |
| **4** | no capability loses more than its own rate (ABS 1, IE 5, KU 7, TR 22) | ABS 0, IE 0, KU +1, TR **+17** | **met** — nothing lost |

**All three of the mechanism's predictions failed and the accuracy rose.** That is the finding, and it is worth
stating before the numbers that follow: the campaign registered "reach" as the channel and the effect came through
a different one.

### 13.64.3 What moved

| | dense control (`39098246215`) | hybrid | Δ |
| --- | --- | --- | --- |
| registered delta | +28.75pp | **+29.60pp** | +0.85pp |
| roster | 357/500 | **375/500 = 75.00%** | **+18** |
| ABS | 29 | 29 | 0 |
| IE | 136 | 136 | 0 |
| KU | 60 | 61 | +1 |
| MR | 64 | **64** | **0** |
| **TR** | 68 | **85** | **+17** |
| declines | 66 | **59** | −7 |
| union | 436 = 87.20% | **442 = 88.40%** | +6 |

**TR is the whole of the gain**, and its mechanism is in the transitions: **abstention → correct 18**, against
five correct answers lost. Not a reshuffle — eighteen questions TR used to decline are now answered.

### 13.64.4 The partition says the reach did not move, and the partition is right

| | dense | hybrid |
| --- | --- | --- |
| never surfaced | 2961 | **2942** (−19) |
| cut by the budget | 2117 | **2565** (+448) |
| delivered | 5882 | **5453** (−429) |

The keyword channel did not find more gold — it **reordered** what was already reachable, and the budget then cut
more of it. TR's correct answers arrive with a **lower** median coverage than before (58.3% → 50.0%) and fewer
delivered gold turns. So the effect is not "more evidence"; it is **more decisive evidence at lower coverage**.

**That is a defect in the instrument, not in the run.** `carried` counts gold turns, and a temporal question needs
*one specific* turn: carrying two of four rather than three of four is worth less than carrying the one that
states the date. The partition measures **quantity** and the mechanism moved **which**, so the campaign now has a
measurement that can be right and irrelevant at the same time — recorded here because it will happen again.

### 13.64.5 The check that decides adoption, because "+17 on a judge-scored capability" invites suspicion

Eighteen recovered answers, of which **ten are grounded** — and the question is whether that is normal. It is:
among TR's correct answers, the grounded share is **51.5%** in the dense run and **55.3%** in the hybrid, and the
recovered eighteen sit at 10/18 = 55.6%. MR's grounded share *rose* (56.2% → 67.2%). So the gain is not the judge
accepting unsupported text: **the hybrid's correct answers are more grounded than the dense run's, not less.**

The median coverage of the eighteen recovered answers is **36.9%** — the model usually answers TR from a minority
of the gold, which agrees with §13.64.4: the decisive turn is what it needed, not the full set.

### 13.64.6 The decision

**`retrieval-hybrid` is adopted.** On three facts, in this order:

1. **No capability regressed.** ABS 0, IE 0, MR 0, KU +1 — all inside their own measured rates, and TR +17
   exceeds any net movement this arm has recorded between two draws of one configuration (±8).
2. **The gain has a named mechanism in the per-question transitions** — eighteen TR declines became correct, not
   a diffuse swap — and the grounding check says the answers are as supported as the ones it already had.
3. **The union rose to 88.40%** and the remaining gap narrowed from 71 to **67**, of which **MR is 49**.

**What the adoption does not claim.** It does not claim the registered mechanism; predictions 1–3 were falsified
and are recorded as falsified. It does not claim the delta's +0.85pp, which is inside the repetition spread
(0.730–0.750). And it does not claim TR is now solved — 66.93% against the reference's 67.72%, which is parity
rather than a lead, and parity arrived with lower coverage.

**The cost, stated rather than buried**: MR's churn more than doubled (19.8% → 30.6% of its questions changed
state) with **zero net gain**, and 429 fewer gold turns reached the model overall. The keyword channel makes the
window more volatile on the capability that matters most and does not help it.

### 13.64.7 What the falsification leaves as the next question

§13.63.6's reading rule said: *"if 1 fails, the never-surfaced turns are not reachable by a keyword channel
either, and the reading is that they are semantically distant — which would make the next variable a different
embedding."*

That rule was written before this run showed its own incompleteness. What is now measurable is a **second split**
the partition cannot make: of MR's gold turns the ranker *did* find in the dense control — 2637 of 3663 —
**903 are cut by the budget, which is 34% of what was found**. If those are cut because they rank 30th against a
room of 26 turns, the order is the lever; if they rank 500th, no order helps and the room is the lever. **Neither can be read from a count** — it needs the gold turn's
**rank**, and the index discards the ranking today (`candidatesFor` returns a set, deliberately).

So the next instrument is a **gold-rank curve**: how many of a question's gold turns appear in the top 8, 16 and
32 of the ordered pool. Four integers per question, and they separate "the order is wrong above the cut" from
"the gold is far below any cut we would pay for" — which is the difference between an ordering change and an
embedding change, and the difference between a cheap run and a re-embedding that invalidates every archived
comparison.

### 13.64.8 Verification

- Drift check before reading: **500 of 500, 0 differences**.
- Every number above is `tools/readout-arm-run.py` (`--pool`, `--coverage`, `--paired`, `--union`, `--counted`)
  on the artifact, plus the two log lines. The grounded shares are the records' own `grounded` field, which is
  `classifyTrFailure`'s verdict computed by the arm.
- `pnpm check` **exit 0** before the run; four coverage dimensions **100%**.

### 13.64.9 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0 (done)** | `retrieval-hybrid` **adopted**; its three mechanism predictions recorded as falsified; the coverage instrument's blind spot recorded | no |
| **P0** | **The gold-rank curve** (top 8/16/32), the instrument that separates order from room for MR's 49 | no, to build |
| **P1** | MR is now **49 of the 67** remaining gap; nothing else is close | yes |
| **P1** | MR's 31 `numeric_mismatch`, of which 11 count their own short list | yes |
| P2 | The §13.55 sentence, now redundant, as its own variable | yes |
| P3 | `PATH` ordering | no |

---

## 13.65 A gold turn's rank, so "just below the cut" and "never close" stop being one number

### 13.65.1 The question §13.64 left open

`--pool` established where MR's gold goes: 1031 never surfaced, 1075 surfaced and cut, 1557 delivered. The middle
number is the one that matters for the next decision and it is **ambiguous by construction**:

| if the cut gold sits at | then the lever is | and the cost is |
| --- | --- | --- |
| rank 28 against a room of 26 | **the order** | one prompt-shaped change |
| rank 500 | **nothing an order can reach** | a different embedding, and every archived comparison |

A count cannot tell them apart. **A rank can**, and the campaign had thrown the rank away: `buildRetrievalRelevanceIndex`
kept `Map<turn, score>` and the design note said the ranking is discarded *because the consumer's own selection
is the only thing that should be ordering turns*. That argument is right about **selection** and was never about
**measurement**, which is the distinction this section adds.

### 13.65.2 The change

- **`RelevanceIndex.rankedCandidatesFor(question)`** returns the turns in the ranker's own order. `candidatesFor`
  now builds its `Set` from the same array, so "in the pool" and "has a position" cannot disagree — the
  equivalence is asserted, as is the unknown-question answer for both.
- **`GoldOverlap.goldRanks`** records each gold turn's position, `-1` when the ranking did not surface it. Same
  length as `total`, so any cut point is a prefix count rather than a field per cut. `pool` is the number of
  non-negative entries, and **that redundancy is asserted rather than assumed**.
- **`relevancePoolFor` must now be ordered.** The doc on `goldOverlapOf`'s third parameter says so, and
  `bench/run-ablation.ts` passes `rankedCandidatesFor` instead of `[...candidatesFor]` — a pool built from the
  set would have the right size and arbitrary ranks, which is the failure this section exists to prevent.

The selection still orders by `relevanceFor`, so **no behaviour moved**: this run changes what the artifact
records and nothing about what the model reads.

### 13.65.3 Registration

**One variable**: the rank capture, on §13.64's adopted configuration (`retrieval-hybrid`). A diagnostic, so the
predictions are about the instrument and about the question it makes askable.

| # | prediction | falsified if |
| --- | --- | --- |
| **1** | **The instrument is inert**: the roster stays within **±11** of 375 | outside |
| **2** | **The two encodings agree**: `pool` equals the count of non-negative `goldRanks` on every record | any record disagrees |
| **3** | **The curve is shallow at the head and steep after it**: across the whole run, top 32 captures **less than 85%** of the gold the ranking surfaced | top 32 ≥ 85% |

**Prediction 3 is a real bet and it is the one that decides the next variable.** If the head of the ranking is
already dense with gold — top 32 capturing nearly everything surfaced — then what the budget cuts is a long tail
and **the order cannot help**; the next variable is the embedding. If top 32 captures much less, then a better
order is leaving gold in the second half of a 64-wide pool and **a re-ranking is the cheap lever**.

**The decision rule, registered as a rule rather than a prediction**, in §13.53.3's form:

> If the median rank of the surfaced-but-cut gold is **below 2× the room** (≈52), the lever is **the order**.
> If it is **above 4× the room** (≈104 — which cannot happen inside a 64-wide pool, so this arm would read
> "never surfaced" instead), the lever is **the room**. Anything between is a mixed regime and is reported as one
> rather than rounded to a side.

### 13.65.4 Why the readout had to exist before the run this time

`--ranks` prints, per capability, how many gold turns sit in the top 8, 16 and 32 of the ordered pool, plus the
surfaced total. The three cuts are the three the argument needs rather than a sweep, and the percentages are of
**the gold**, not of the questions, because a 24-gold question and a 2-gold question should not weigh the same.

Verified against the adopted run's artifact, which predates the field: it exits **2** and says so. The refusal
works on a real file before it is needed.

### 13.65.5 Verification

- **Red first**: `keeps the ranking it was given, so a gold turn has a position and not only a membership` fails
  on the old index; `records where each gold turn sits in the ranking` fails on the old `goldOverlapOf`. Four
  existing assertions were **extended** rather than relaxed — they now name `goldRanks` beside `pool` — because
  the schema grew and a test that stopped at `pool` would no longer pin the object it produces.
- One branch was uncovered on the first pass (the unknown-question fallback in `rankedCandidatesFor`, 92.3% in
  that file); the test above closes it and the file returns to **100%**.
- `pnpm check` **exit 0**; `cortex-eval` **1910 tests** (+2); four coverage dimensions **100%** on every package
  except `cortex-node`'s branch column at 98.64% (§13.47).
- The rank capture touches **no prompt and no selection**, so the run is single-variable by construction rather
  than by an assertion about reach.

### 13.65.6 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0** | The rank diagnostic is **dispatched**; §13.65.3's three predictions and the decision rule are registered | yes (in flight) |
| **P0 (done)** | The rank is recorded, the two encodings are asserted equal, and `--ranks` refuses an artifact that predates it | no |
| **P1** | The order-or-embedding decision, which is the whole of MR's 49 | yes |
| **P1** | MR's 31 `numeric_mismatch`, of which 11 count their own short list | yes |
| P2 | The §13.55 sentence, now redundant, as its own variable | yes |
| P3 | `PATH` ordering | no |

---

## 13.66 The rank curve: the head is shallow, so the lever is the order

### 13.66.1 The run

`39116387165`, `09:42:20Z` → `11:32:53Z`, **1h50m33s**, `success`, artifact `12135385585`, 7,084,521 bytes.
The configuration §13.64 adopted, plus the rank capture. Drift check: **500 of 500, 0 differences**.

### 13.66.2 The three predictions

| # | registered in §13.65.3 | observed | verdict |
| --- | --- | --- | --- |
| **1** | the roster stays within **±11** of 375 | **371** (−4) | **met** |
| **2** | `pool` equals the count of non-negative `goldRanks` on every record | no record disagrees | **met** |
| **3** | top 32 captures **< 85%** of the surfaced gold | **79.7%** | **met** |

### 13.66.3 The curve

| capability | gold | top 8 | top 16 | top 32 | surfaced |
| --- | --- | --- | --- | --- | --- |
| ABS | 672 | 121 (18.0%) | 213 (31.7%) | 322 (47.9%) | 420 (62.5%) |
| IE | 1709 | 685 (40.1%) | 1037 (60.7%) | 1294 (75.7%) | 1444 (84.5%) |
| KU | 1688 | 455 (27.0%) | 774 (45.9%) | 1099 (65.1%) | 1327 (78.6%) |
| **MR** | 3663 | 664 (18.1%) | 1225 (33.4%) | **1984 (54.2%)** | 2632 (71.9%) |
| **TR** | 3228 | 659 (20.4%) | 1135 (35.2%) | 1694 (52.5%) | 2195 (68.0%) |
| **total** | 10960 | **2584 (23.6%)** | **4384 (40.0%)** | **6393 (58.3%)** | **8018 (73.2%)** |

**The head is shallow.** A third of the gold the ranker *can* find sits between rank 32 and the cut, and the first
eight turns of a 64-wide pool carry under a quarter of it. So the campaign's oldest suspicion — that the ranking is
the constraint — is now measurable in the currency the argument needs.

### 13.66.4 The decision, by the rule §13.65.3 registered before the number existed

The rule: *if the median rank of the surfaced-but-cut gold is below 2× the room (≈52), the lever is the order.*

MR's cut gold occupies ranks 26–63 with a median near **45**, and the run-wide picture is the same shape: top 32
holds 58.3% of the gold, the cut band holds another 14.9%, and the room is ~26 turns. **45 < 52. The lever is the
order.**

That closes the branch §13.64.7 opened: **the embedding is not the next variable.** The gold the model is missing
was found by the ranker and ordered below the cut, and a better order is a change to one function rather than a
re-embedding that would invalidate every archived comparison.

### 13.66.5 A second finding the run produced for free, about noise

**The pool and the delivered counts are identical to run `39106951421` to the turn** — 2942 never surfaced, 2565
cut, 5453 delivered, and the same per capability. Retrieval on this arm is **deterministic** given the dataset and
the configuration, so the evidence is byte-identical between the two runs.

Which means the two runs' accuracy difference — 375 against 371 — is **entirely model sampling**. That is the
cleanest separation of the two noise sources this campaign has had, and it makes §13.64's adoption arithmetic
sharper: the hybrid's +18 could not have been evidence variance, because there was none.

### 13.66.6 What the next variable is, and what it is not

- **Not the embedding.** The rule decided.
- **Not the room.** §13.34.3 measured the room holding 26 turns against a median gold set of 24; with a perfect
  order the room is sufficient, and top 32 already holds more gold than the room can buy.
- **Not `k`.** §13.54, and now for a second reason: the cut band is *inside* the pool.
- **The order.** A function that decides which 26 of the 64 scored candidates the model reads. The campaign has
  the artifact to argue about it — `goldRanks` says how far off each choice was — but the ordering signal itself
  is a design question that deserves its own registration rather than a reuse of `relevanceUnits`, which is
  frozen at `turn` for a measured reason.

### 13.66.7 Verification

- **Drift before reading**: 500 of 500, 0 differences.
- Prediction 2 is the invariant that keeps `pool` and `goldRanks` one fact; it is asserted at unit level
  (`pool` **is** the count of non-negative ranks) and checked here at run level on all 500 records.
- Every number is `--ranks`, `--pool`, `--union` and `--reference` on the artifact.
- `pnpm check` **exit 0** before the run; four coverage dimensions **100%**.

### 13.66.8 Status

| Priority | Item | Needs provider |
| --- | --- | --- |
| **P0 (done)** | The rank curve exists and decided: **the order**, not the embedding | no |
| **P0** | **Design the ordering function** and register it — the whole of MR's 49 and TR's 17 | no, to design |
| **P1** | MR's 31 `numeric_mismatch`, of which 11 count their own short list | yes |
| P2 | The §13.55 sentence, now redundant, as its own variable | yes |
| P3 | `PATH` ordering | no |

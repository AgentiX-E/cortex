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
* `limit: 0`, `ablation_runs: 4`, `temperature: 0` — unchanged.
* `promptContract: abstention-evidence-blocks` — **held from §12.5 while §13's ask is
  reverted by §13.9.** It stays in this list because §13's comparison is two-axis: the
  ask moved and the rendering did not, so a run that dropped back to the baseline
  rendering as well would move both at once and attribute the result to neither.
* `ask: computed` — **set by §13.22, after §13.21 sent `aggregate`.**
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
* `relevanceUnits: session` — **added by §13.27, and it is the selection unit.** Registered
  separately from `relevanceSignal` because the two are different claims about one budget:
  the signal says **how a turn is scored** and this says **what a score buys**. A unit folded
  into the signal's name would make a run that changed only the unit indistinguishable, in its
  own configuration line, from one that changed the scoring — and §13.27 moves only the unit,
  holding the signal at `retrieval` and the width at `64` so a movement cannot be attributed
  to either. `session` spends the room on whole sessions ordered by their best-scoring turn;
  the signal itself does not change, because a session's score is the maximum of its turns'
  scores, so this is a regrouping of the same numbers rather than a second signal. It reaches
  the **multi-session route alone**, which is what makes the dispatch single-variable:
  `buildPrompt` is handed no session boundary, so the unit cannot be expressed on flat,
  temporal, knowledge-update, abstention or assistant. Sent explicitly rather than left blank
  for the reason `sourceTrust` and `relevanceTopK` are: `turn` is the default, so omitting it
  would happen to match — and it would arrive through the `''`-to-default path §38 identified
  as the source of two separate defects.

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
| `cortex_memory_relevance` | **`retrieval-session`** | the variable |
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
| P2 | `grounded` is still hard-coded `false`; the writer's reduced manifest is not uploaded; `cortex-node` branch coverage is **98.61%**, which predates this change and is the only dimension below 100% anywhere in the repository | no |
| P3 | `PATH` ordering, which waits on a rebuilt image | no |

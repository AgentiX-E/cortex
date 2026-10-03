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

---

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

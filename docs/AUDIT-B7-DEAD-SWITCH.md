# AUDIT-B7-DEAD-SWITCH — the switch was not reachable, and then not measurable

**Status:** closed. Both defects fixed, both verified by defect injection.
**Trigger:** a pre-dispatch check of B7 before dispatching its A/B.

## 1. What was believed, and what was true

The roadmap carried B7 as `已实现，待 benchmark` — "implemented, awaiting
benchmark", with the intervention layer recorded as done (`13/17` labelled, `9/17`
truth/answer separated). That reading came from the module being present, its
unit tests green, and its functions exported.

A pre-dispatch check of the switch that turns the feature on found three
independent breaks, stacked:

| # | Break | Evidence |
|---|---|---|
| 1 | No benchmark input could set it | no `bench/run.ts` wiring, no workflow input |
| 2 | `NaturalLanguageMemorySystemOptions` had no such field | `grep candidateDiscrimination` returned two hits, both inside the file that *declared* it |
| 3 | The prompt-builder closure dropped it | `respondWith` passed it; `(q, c, token) =>` accepted three arguments |

Break 3 is the one that killed the feature, and it is the one a signature-blind
review passes: a three-parameter arrow satisfies the three-parameter
`PromptBuilder` type exactly, so discarding a fourth argument raises nothing.
`QaPromptOptions.candidateDiscrimination` was declared, read by two builders, and
assigned by nothing outside them.

Four exported functions — `clusterCandidates`, `discriminateContext`,
`candidateSides`, `renderDiscriminatedContext` — had no caller anywhere in the
repository. Their unit tests passed, because they call the functions directly and
therefore never traverse the layer that was missing.

This is the same shape as the batch-throttling gap (discipline 26): every part in
place, nothing connecting them.

## 2. Why no test caught it

Because no test could. The suite's observations were:

- **the leaf module**, `candidate-discrimination.ts`, mutated by
  `tools/inject-candidate-discrimination.py`. Every mutation there was caught.
  Every mutation there was also *irrelevant* to this defect: the arithmetic was
  correct, and the arithmetic was never reached.
- **the exported functions**, called directly by unit tests. Calling a function
  directly is the one way to use it that does not require it to be wired.

A leaf-module harness cannot see a wiring defect by construction. That is worth
stating as a general rule: **a mutation harness aimed at one layer certifies that
layer and says nothing about the edges.**

## 3. The judgement criterion was also unjudgeable

B7's pre-registered criterion (§2.5.10.6, item 1) is *"the targeted 9 questions
must move"*. `benchmark-gap-attribution.json` stored `rankingGapQuestions: 27` and
nothing else — a **count**, with no question ids.

So even with the switch wired, the artifact could not answer the criterion:
"the intervention did nothing" and "the intervention changed something elsewhere"
produced byte-identical gap attributions. This is the §9b `discordantQuestions`
gap in a second place, and it was closed the same way.

## 4. The fixes

### 4.1 The ids, so the population can be named

| File | Change |
|---|---|
| `src/recall-curve.ts` | `QuestionRank.questionId?`; single shared predicate `isRecalled`; new `classifyCurveMembership`; `RecallCurveResult.membership` |
| `src/retrieval-attribution.ts` | `membership` option (**required**); `rankingGapQuestionIds` / `retrievalGapQuestionIds` (**required**) |
| `bench/run.ts` | passes `recallCurve.membership`; prints both id lists with the count |

Required rather than optional, on the `discordantQuestions` precedent: an optional
field lets the three existing fixtures keep compiling while silently reporting no
population, which is the failure being fixed. Required turns each omission into a
compile error — and that is what happened: 17 `tsc` errors across the fixtures
until every call site declared its membership.

One predicate, two readers. `buildRecallCurve` counts with `isRecalled`;
`classifyCurveMembership` classifies with the same function. Two implementations
of "was this question recalled" would drift, and the drift would show as a count
that disagrees with the list beside it — worse than either alone, because a
reader cannot tell which to believe.

The membership is taken at `Math.min(...cutoffs)`, the strictest cutoff asked
about. A question admitted at k=1 but not at k=2 *is* the ranking gap; taking the
largest cutoff would empty the gap by relabelling it admitted.

### 4.2 The switch, wired through all three layers

| Layer | Change |
|---|---|
| `NaturalLanguageMemorySystemOptions` | new `candidateDiscrimination?: boolean` |
| `PromptBuilder` | fourth parameter `options?: QaPromptOptions` |
| `respondWith` | reads the option from `this.options` and passes it |
| `ConservativeQaPromptOptions` | new `candidateDiscrimination?: boolean` (the rerank arm answers through this builder, not `buildQaPrompt`) |
| the closure at the abstention path | forwards the fourth argument instead of dropping it |
| `BenchmarkRunnerOptions` | new `candidateDiscrimination?: boolean`, forwarded to the **feature only** |
| `benchmark.yml` | new `candidate_discrimination` input, default `0` |

Feature-only, on the `reranker` precedent: an arm whose control side carries the
feature measures nothing. The workflow default is `0` and the reader is strict
(`=== '1'`), which is the **opposite** convention from the neighbouring
`ENTITY_IDENTITY_CLAUSE` (`!== '0'`, default on) — deliberately, because an unset
`IDENTITY_CLAUSE` means "run the shipped configuration" while an unset
`CANDIDATE_DISCRIMINATION` means "this measurement was not requested".

## 5. Defect injection, and what it found this time

Three new harnesses; results below. `caught` means a mutation broke the suite,
which is the pass condition.

**`tools/inject-b7-wiring.py` — the wiring layer, 12 of 15 caught, 3 declared unobservable.**

The seven behavioural links (runner → system → `respondWith` → closure → builder
→ prompt text) are all caught, including
`closure-drops-the-option`, which is the defect that killed the feature.

Three mutations on the `bench/run.ts` environment read are **unobservable by
construction** and are marked as such in the harness rather than deleted:
`bench/run.ts` calls `main()` at import, so no test can import it, so its lines
cannot be reached. Deleting them would have hidden which link has no test;
reporting them as survivors alongside real findings would have made a known
limitation look like a defect. The harness prints the two classes separately and
will not return success while a *real* survivor exists.

**`tools/inject-recall-curve.py` — the curve and its membership, 11 of 11 caught.**

This harness did not exist before. The one that mattered:
`curve-membership-computed-on-a-different-k` (`Math.min` → `Math.max`) survived
the first run, and finding that needed a fixture the suite did not have — a curve
whose recall actually differs between two cutoffs. Every membership test passed
an explicit `k` and never traversed the choice.

**`tools/inject-retrieval-attribution.py` — extended with the id pipeline, 20 of 20 caught.**

The first extension found a real gap: `ids-aliased-not-copied` survived. The
existing test asserted that `attributeRecallGap` does not write to the caller's
membership; nothing asserted that a **reader** of the result cannot. Returning the
caller's array directly passes every test that came before, and the damage
appears later and elsewhere — a consumer that sorts what it received reorders the
curve it came from.

## 6. Two files extracted so their decisions could be tested

The `bench` mutations would have stayed unobservable if the decisions had stayed
in the CLI. Two extractions, both to `src/` where coverage applies:

- **`src/env-toggle.ts`** — `readToggle(env, name, { defaultOn })`. The comparison
  that was mutated in six ways left the suite green when it lived inline in an
  excluded file. Now: strict on presence (`'1'` on, anything else present off),
  `defaultOn` covers the opposite convention, and both properties have tests.
- **`src/bench-arm-options.ts`** — `rerankArmOptions(...)`, which decides **which
  keys the arm is constructed with**. Absence for anything unconfigured, because
  the runner forwards on `=== true` / `!== undefined` and an always-present
  `false` would be read as configured.

Both reached 100% on all four dimensions. The three call-site mutations that
survived when the object was built inline in the CLI are caught now that the
builder is testable — the same defects at the same place, moved to where an
assertion can see them.

## 7. What is not claimed

- **B7 has not been measured.** This round made the switch reachable and the
  criterion judgeable. The A/B has not run.
- **The three `bench` mutations remain unobservable.** The parsing is tested; the
  argument names in the CLI are not, and cannot be without importing a file that
  runs on import.
- **The leak into the control arm is unobservable on the suite's fixture.** A
  mutation wiring the flag into the baseline as well produced `prompts=4,
  instructed=1` — identical to the correct implementation. The defect is real and
  would be real in production; on this fixture the baseline never reaches
  `buildConservativeQaPrompt`, so it changes nothing observable. Closed by
  removing the mutation with the measurement recorded, not by writing a test that
  exists to make a mutation fail.
- **`candidateDiscrimination` defaults off, so shipped behaviour is unchanged.**
  Nothing in this round alters any existing measurement.

## 8. Amendment: the feature had a second switch, and it was fiction

**Added by `AUDIT-UNREFERENCED-GROUPS.md`.** This audit fixed the *live* switch for
candidate discrimination — the one this document's §1 table describes breaking in
three places. It did not notice that the same feature carried a **second, inert
switch**, and the reason is instructive about scope:

    // candidate-context.ts, exported from the barrel
    export function isCandidateDiscriminationEnabled(options: {
      readonly enableCandidateDiscrimination?: boolean;
    }): boolean {
      return options.enableCandidateDiscrimination === true;
    }

Nothing sets `enableCandidateDiscrimination`; nothing reads it but this function; the
function is called only by its own two tests. It survived an audit of the very feature
it names because **this audit asked whether the live switch worked, and this one is not
the live switch.** A symbol can be adjacent to a closed defect and invisible to the
change that closed it.

The near-synonym is the cost. `candidateDiscrimination` and
`enableCandidateDiscrimination` are similar enough that a reader assumes they are one
switch at two layers, and different enough that grepping for the obvious name finds the
wrong one. The reader then infers the feature is off by construction, when it is driven
by `CANDIDATE_DISCRIMINATION` and has been measured with ablation.

It is now deleted, with a guard test asserting the shape that made it a defect rather
than the symbol that embodied it — one switch name, bound to an env var at the entry
point, read by the prompt builder. The second of those assertions reproduces this
document's §1 break 3, where a three-parameter arrow type-checked while dropping the
flag.

**The §1 table above stands unchanged.** It measured the live switch and was right
about it; this amendment adds a symbol it did not have in scope.

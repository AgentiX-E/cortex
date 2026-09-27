# The B7 A/B ran two identical arms

**Status:** measured. The dispatch executed correctly and the result is a null,
but **not the null the criterion anticipated** — so it cannot be reported as one.
The switch was read, logged, and then never consulted by the code path that ran.

**Evidence:** runs `36318173064` (control) and `36318177666` (feature), both on
`56108517`, both `completed success`. Artifacts and logs fetched and quoted below.

## 1. Why this document exists

`AUDIT-B7-DEAD-SWITCH.md` closed two defects: the switch was not reachable from
the arm's entry point, and the criterion was not evaluable. Both were fixed and
verified by defect injection. The A/B was then dispatched with
`candidate_discrimination=0` and `=1`.

It is worth stating plainly what the result is, because the tempting reading —
"B7 has no effect on this sample" — is **not** what the run measured.

> The switch was set. The switch was printed. The switch was never read by
> anything that executed. Both arms are the same code path with the same
> configuration, so the null is a statement about the dispatch, not about the
> intervention.

This is the same class of defect the previous audit closed, one level up: the
previous one was a switch unreachable from the arm; this one is a switch
reachable from the arm but consumed only by an arm that did not run.

## 2. The evidence, in the order it was found

### 2.1 The artifacts are identical apart from a timestamp

```
$ diff control/benchmark-report.md feature/benchmark-report.md
6c6
< - Generated at: 2026-09-27T12:17:54.467Z
---
> - Generated at: 2026-09-27T12:18:14.928Z
```

Not "statistically indistinguishable" — **textually identical** except for when
they were written.

### 2.2 Per-question correctness is byte-identical

`featureCorrect` is a 60-element boolean vector, one per question:

```
featureCorrect length: control=60 feature=60
featureCorrect identical: True
positions differing: []
```

Every question right and wrong in exactly the same places. This is a stronger
statement than equal accuracy: equal accuracy admits compensating flips, and
there are none.

The cleanest instance of a metric where this distinction matters is
`discordantQuestions`, the identity field added by
`AUDIT-DISCORDANT-IDENTITY.md`. Both arms report the same nine ids, in the same
order:

```
baselineIncorrectFeatureCorrect: ["0862e8bf_abs", "15745da0_abs", "bc8a6e93_abs",
  "19b5f2b3_abs", "29f2956b_abs", "f4f1d8a4_abs", "88432d0a_abs",
  "80ec1f4f_abs", "eeda8a6d_abs"]
```

### 2.3 Every aggregate matches

| metric | control | feature |
| --- | --- | --- |
| accuracy | 0.716667 | 0.716667 |
| abstentionRate | 0.000000 | 0.000000 |
| abstentionAwareAccuracy | 0.716667 | 0.716667 |

Per capability (IE 24/26, MR 8/9, KU 5/8, TR 6/8, ABS 0/9) is identical on both
sides, including the abstained counts.

### 2.4 The switch was set, and the log proves it

The workflow's own environment dump records the difference:

```
control:  CANDIDATE_DISCRIMINATION: 0
feature:  CANDIDATE_DISCRIMINATION: 1
```

So this is not a workflow-input mis-plumbing defect of the kind `benchmark.yml`
was already fixed for once (the four rerank inputs that were absent from the
file entirely). The value arrived.

### 2.5 The consumer never ran

Both logs, at the end of the benchmark step:

```
control:  === reranking ablation skipped: CORTEX_RERANK is not enabled ===
feature:  === reranking ablation skipped: CORTEX_RERANK is not enabled ===
```

with `CORTEX_RERANK: off` in both environment dumps.

## 3. The defect

`packages/cortex-eval/bench/run.ts` reads the toggle at line 433:

```ts
const candidateDiscrimination = readToggle(process.env, 'CANDIDATE_DISCRIMINATION');
```

Its consumers are at lines 908 and 926 — **inside the `CORTEX_RERANK` branch**,
passed to `runRerankAblation` via `rerankArmOptions`. The main benchmark call at
line 437 does not receive it:

```ts
const { report, markdown } = await runNaturalLanguageBenchmark(sampled as never, embedding, llm, {
  abstainThreshold: threshold,
  entityIdentityClause,
  runs,
  temperature,
  onDecision: (trace) => decisions.push(trace),
  ...(reranker !== undefined ? { reranker } : {}),
  ...(rerankCandidatePool !== undefined ? { rerankCandidatePool } : {}),
  ...(rerankProtectedHead !== undefined ? { rerankProtectedHead } : {}),
});
```

`candidateDiscrimination` is computed here, and the local is used elsewhere, so
no linter or compiler flags it. With `CORTEX_RERANK=off` the only branch that
consumes it is skipped, and the feature is inert **regardless of the input**.

### 3.1 Why the dispatch was set up this way

The workflow input's help text says:

> `candidate_discrimination`: Enable candidate-context discrimination in the
> feature arm (roadmap B7): 1 = on, 0 = shipped behaviour. **The reranking A/B is
> the arm that measures it**

That is accurate, and it is the trap. B7's intervention is an instruction added
to the reader's prompt, so the arm that varies it has to be an arm that varies
the reader's prompt — which, as currently wired, is the rerank ablation. But the
rerank ablation exists to vary *reranking*, and B7 rides along inside it rather
than having an arm of its own. Dispatching `candidate_discrimination` without
`rerank` is therefore a no-op that looks exactly like a completed experiment:
the runs go green, the artifacts land, and every number is valid for a hypothesis
that was never administered.

### 3.2 What this is not

It is not a regression. Nothing that previously worked stopped working, and the
control arm is a faithful control for the shipped configuration.

It is also not a defect in `env-toggle.ts` or `bench-arm-options.ts`. Both are
correct and both are tested to 100%: the toggle parses strictly and the options
builder spreads conditionally. The gap is that the *call site* of the main
benchmark never asks for the value — and `bench/**` is outside coverage, which is
precisely why `env-toggle.ts` was extracted in the first place. The extraction
covered the parsing and left the wiring.

## 4. One difference, and why it is not the intervention

The ranking-gap roster differs by exactly one question:

```
control rankingGap (27): ... b5ef892d, 0edc2aef, b46e15ed ...
feature rankingGap (28): ... 830ce83f, 58bf7951, b5ef892d, 0edc2aef ...
only in feature: ['58bf7951']
only in control: []
```

and the retrieval diagnostics move with it:

| | control | feature |
| --- | --- | --- |
| recallAt1 | 0.3953488372093023 | 0.37209302325581395 |
| recallAt5 | 0.8372093023255814 | 0.8604651162790697 |
| admittedAtOne | 13 | 12 |
| rankingGapQuestions | 27 | 28 |
| coveredQuestions | 40 | 40 |

`58bf7951` moved from `admittedAtOne` to `rankingGap`: it fell out of rank 1 but
remained within rank 5, which is why `recallAt5` rises as `recallAt1` falls.
`coveredQuestions` is 40 in both arms — the same 40 questions remain answerable,
the same 40 were answered, and the same 32 were answered correctly.

This is **retrieval-order non-determinism**, not a treatment effect. It cannot
be the intervention for the structural reason in §3, and the shape corroborates
it: a prompt instruction cannot promote a document into rank 1, and the total
answerable set is unchanged. It is recorded here rather than dismissed because
it is the reason `recallAt1` is a hazardous input to a B7 decision — a one-rank
shift in a 43-question denominator is 2.33 pp, larger than most of the deltas the
roadmap treats as signal.

## 5. What must change, and what must not be claimed

### 5.1 Not claimable

- **Not** "B7 has no effect." The intervention was never administered.
- **Not** "the switch is broken." It parses, it is passed, it reaches a function.
- **Not** a B7 verdict of any kind. `judgeCriterion` would return `no-move` here,
  and that verdict would be true of two control arms.

### 5.2 The change

B7 needs an arm of its own. Two options, and the choice is not cosmetic:

1. **Give the main benchmark the toggle.** Pass `candidateDiscrimination` into
   the `runNaturalLanguageBenchmark` call at line 437. The main benchmark already
   varies the reader's prompt via `entityIdentityClause`, so the option belongs
   there and the A/B becomes two dispatches of the main run. This is the smaller
   change and it makes the input's documented meaning true.
2. **Split the arm.** Keep the rerank ablation as the rerank arm and add a
   dedicated B7 arm, so neither feature's measurement depends on the other
   being enabled. Larger, but it removes the coupling that made this dispatch
   silently vacuous.

Option 1 is the correct first move: it is the defect, the input already promises
this behaviour, and option 2 without option 1 leaves the main path still ignoring
the toggle.

### 5.3 The instrument this argues for

Both this defect and the previous one were invisible to 1589 green tests and to
a clean `pnpm check`. What would have caught either is cheaper than a test suite:
**a run must refuse to report a B7 result when the switch it was dispatched with
is not the switch any executed path read.**

That is a precondition, not an assertion about outcomes — the same shape as the
`benchmark.yml` comment that already exists for `ENTITY_IDENTITY_CLAUSE`, made
executable.

## 6. What this document does not establish

- It does not measure B7's effect. That measurement has not been made.
- It does not establish that the main benchmark call is B7's correct home; §5.2
  argues for it on the grounds that the input already documents that contract,
  not on grounds of measurement.
- It does not quantify the retrieval-order non-determinism in §4 beyond this one
  observed instance. One question in one pair of runs is a fact about these runs;
  the variance of `recallAt1` across repeated identical dispatches is unmeasured,
  and until it is, any `recallAt1` delta smaller than it should not be read.

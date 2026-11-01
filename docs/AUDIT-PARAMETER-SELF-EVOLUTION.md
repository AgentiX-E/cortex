# Whether prompts and sampling parameters should tune themselves

**Answer: not at run time, and not through a framework. The part of the request that is real is
model compatibility, and that is a measurement with an admission threshold rather than a search.**

Written 2026-11-01, while two benchmark runs were in flight. The question it answers was asked in
that window: should this project grow a self-evolution capability over prompt wording and
`temperature`, possibly by taking `@ax-llm/ax` as a dependency, so that a future model change
adapts rather than breaks?

The answer separates three things that the question joins, because they cost three different
amounts and one of them is free.

---

## 1. The three layers, and only one of them is free

| layer                              | what changes                                                                             | when                                   | measurable?                                       | verdict                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- | ---------------------------- |
| **L1 — model capability manifest** | nothing; a new model is _measured_ before it is used                                     | once per model, on ~40 probe questions | yes, and it is an admission threshold             | **do it**                    |
| **L2 — offline compilation**       | prompt wording or few-shot set, searched on a development split, **frozen and vendored** | once per model, off the critical path  | only with a holdout this repository does not have | **conditional, and not yet** |
| **L3 — run-time self-evolution**   | prompt or `temperature` per request or per run                                           | continuously                           | no, by construction                               | **refuse**                   |

The question as asked is L3 ("自适应的与优化的能力"), the cheapest thing to build and the only one
that destroys the measurement. L1 is what the underlying need actually is: a model that changes
should announce what it is before it enters a reading.

The rest of this document is the evidence for that table, and it is all from this repository's own
artifacts rather than from a general argument about optimizers.

---

## 2. What this arm has measured about its own noise

Four readings, each already committed, each produced by a run that had no treatment on the
questions it measures.

### 2.1 A declared parameter that nothing read

`PREREGISTRATION` §13.114: the workflow declared a `temperature` input defaulting to `'0'`, the
dispatch script sent it, the job forwarded it into `env`, and **nothing on the arm's path read it**.
The adapter omitted the field, so every reading this campaign had ever taken was served at the
provider's default `1.0` while every document said `0`.

This is the first reason L3 is refused. `temperature` has already been the object of a
declared-but-unread failure once, and its cost was a whole campaign of readings that could not be
compared. An optimizer that sets it per run reproduces that failure **on purpose and with a
variance**: the value would be real, changing, unregistered, and different in every run, which is
strictly worse than a hard-coded lie because at least the lie was constant.

### 2.2 `temperature 0` does not make the output deterministic

`PREREGISTRATION` §13.127, on run `40807829150`: on IE, KU, TR and ABS the prompt was
**byte-identical** to the control's, and **19 of 379 verdicts still changed** — a 4.8% flip rate.

`temperature 0 pins the sampling parameter and not the output.` The provider is non-deterministic
for reasons the request cannot reach: serving-side batching, routing among experts, version drift.

This is the second reason, and it is the stronger one. A search over `temperature` presumes the
knob controls the output. On this model it controls at most part of the variance and cannot remove
any of it, so the only thing a temperature search can do that a fixed temperature cannot is
**increase** the spread — and then select the best reading out of that larger spread, which is
exactly §13.157's `pass@k` problem happening inside our own harness instead of a competitor's.

### 2.3 Four repetitions of one configuration

`PREREGISTRATION` §13.118.5: four repetitions of **one** configuration, in one job, on one
dataset, produced roster totals of `407, 414.5, 414.5, 423` on 500 questions, and MR counts
spanning `81` to `88`.

Sample standard deviation: **6.54 questions = 1.31pp**. The registered effect it was compared
against was `+3`. The arm's own dispersion was more than twice the effect size.

### 2.4 The same reading from the other end

`PREREGISTRATION` §13.194.4: on 470 questions whose prompt was byte-identical, the net movement
across four repetitions was `+3, -1, +1, -5`. Under a symmetric null that is a standard deviation
of `sqrt(470 · p · (1 − p))` with `p = 19/470`, which is **4.27 questions**.

The two estimates differ by a factor of 1.5 and neither is wrong: one is the spread of a whole-roster
total across repetitions, the other is the spread of a net difference on a stratum of identical
prompts. They bound the same noise from two directions, and the tool accepts both rather than
choosing.

### 2.5 The smallest effect a single pair can resolve

From §13.194.4's rate, a 500-question run has about `500 × 0.048 ≈ 24` discordant questions. A
McNemar test on 24 discordant pairs resolves a net movement at `1.96 · sqrt(24 · 0.25) ≈ 4.8`
questions at `α = 0.05`.

**So the floor for one registered comparison against a control is about 5 questions, or 1pp.**
Every registration in this campaign is written in questions, and this is the number they have to
clear.

---

## 3. Why that makes a search unreadable, stated as arithmetic

A search over `k` configurations reports its best member. If none of them has any effect, the best
member still sits above the mean, by

```
E[max_k] = sigma * integral of  x * k * phi(x) * Phi(x)^(k-1)  dx
```

Evaluated exactly (`tools/search-budget.py`, checked against the published expected values of the
maximum of `k` standard normals to `1e-5`):

| candidates `k` | `E[max]` at σ = 6.54 questions | in points | readable against a 5-question effect? |
| -------------- | ------------------------------ | --------- | ------------------------------------- |
| 1              | 0.00                           | 0.00pp    | **yes** — no maximum is taken         |
| 2              | 3.69                           | 0.74pp    | **yes**                               |
| 3              | 5.53                           | 1.11pp    | no                                    |
| 5              | 7.61                           | 1.52pp    | no                                    |
| 10             | 10.06                          | 2.01pp    | no                                    |
| 20             | 12.21                          | 2.44pp    | no                                    |
| 50             | 14.71                          | 2.94pp    | no                                    |

Read the `k = 10` row against the two numbers this campaign treats as results. The `ask=recommend`
run moved the roster by **+9 questions (1.8pp)**; the MR screen's registered effect is **+5
questions (1pp)**. A ten-candidate search at this arm's noise produces an expected best-of-noise of
**10.06 questions**, which is larger than either.

**That is the finding: at this noise level, the search's expected best member is bigger than every
real effect this campaign has ever measured.** A +2pp gain reported by a ten-way search is not
evidence of anything, because a ten-way search on a no-op produces +2pp by construction.

### 3.1 The budget, which is the part that cannot be argued away

To resolve a 5-question effect at σ = 6.54 with ten candidates, each candidate needs **46
repetitions** after the family-wise correction (`α/k = 0.005`, power 0.8) — the uncorrected figure
is 27, and the correction is mandatory because a search reports its best member and that is exactly
where a false positive lands.

Ten candidates at 46 repetitions each is **460 runs**. At this arm's measured 44 minutes to 2 hours
per run, that is **14 to 38 days of continuous compute** to answer a question whose expected gain,
if the optimizer is honest, is zero.

Screen-and-confirm is cheaper — 10 + 46 = 56 runs — and it is **only valid when the confirmation
runs on questions the screen never saw**. This repository has no holdout split. Without one, the
screen and the confirm are the same sample and the selection bias returns in full, which makes the
cheap number a more expensive way to reach the same wrong answer.

### 3.2 The boundary is two candidates

`tools/search-budget.py --sigma 6.54 --effect 5` reports `candidates_for_readability = 2`.

Which is a precise restatement of what this arm already does by hand: **one change per run, against
one control, registered before dispatch.** That is `k = 1`, and at `k = 1` the selection bias is
exactly zero at any noise. The campaign's method is not a stylistic preference for small steps; it
is the only search shape the instrument can read.

And it names what would change that answer: `sigma ≤ 3.25 questions` (halving the noise) fits the
same ten candidates. §13.118.5's dispersion at unset temperature against 4.8% at `temperature 0` is
the evidence that the first half of that reduction is already bought and the second half is not
available by prompt or parameter choice.

---

## 4. The tool, and what it refuses to decide

`tools/search-budget.py` takes `sigma` from one of three places — supplied, computed from
repetitions, or computed from the identical-prompt flip rate — and answers one comparison:
`E[max_k] < effect`.

Exit codes are the verdict: `0` readable, `1` refused by the bar, `2` malformed. Three codes rather
than one because "this search is unreadable" and "you typed it wrong" must not look alike.

Two deliberate limitations, both tested:

- **It does not say whether a search is worth running.** A readable search is still expensive, and
  the tool prices it instead of approving it.
- **It refuses two repetitions rather than computing a sigma from them**, because one degree of
  freedom produces a number that exists and means nothing, and because an empty input defaulting to
  `sigma = 0` would pass every search. A tool whose failure mode is silent permission must not have
  a default in that direction.

Every `NOT READABLE` prints its own inverse — the `sigma` or the candidate count that would have
passed. A check that can only say no is decoration; this one states the condition under which it
would have said yes, and `test_the_inverse_is_consistent_with_the_decision` asserts that following
the printed advice arrives at the tool's own verdict.

### 4.1 The same number, attached to every paired reading

A tool nobody calls is a document. `--null` already measures a pair's own `sigma` from the questions
whose prompt did not change, so the candidate count is now printed there too:

```
$ python3 tools/readout-arm-run.py report.json --null control.json --search-effect 1.0
  null: a change of up to 1.3 question(s) on the identical stratum is the reader, not the treatment
  search: at this pair's sigma (0.66) a search of 9 candidate(s) stays under the 1.00 question effect
    (E[max] 0.98); 10 does not (1.02)
```

Three decisions in that wiring:

- **`sigma` is the printed value, not the unrounded one.** A reader doing the arithmetic by hand has
  only the digits in front of them; a tool whose answer changes at the third decimal is a tool that
  cannot be checked.
- **The effect is an argument with no default.** Defaulting it to the `2 sd` band, or to the last
  registered effect, would be choosing the bar to fit the answer.
- **A pair without an identical stratum says so** rather than staying silent. Silence reads as "no
  search fitted", which is a different statement from "this pair has no measurement of its own
  noise", and only the second is true.

And the integral is not re-implemented: `readout-arm-run.py` loads `search-budget.py` by path,
because a second definition of `E[max_k]` would drift from the first, which is the failure
`readout-arm-run.py`'s own docstring already names about the scorer channel.

---

## 5. `@ax-llm/ax`, evaluated and declined

The proposal named it specifically, so it gets a specific answer rather than a general one about
frameworks.

What it is: a TypeScript implementation of the DSPy idea — signatures instead of prompts, with
`AxBootstrapFewShot` (collect successful traces as few-shot demos) and `AxGEPA` (reflective
evolution on a Pareto frontier) among its optimizers. Apache-2.0, actively developed.

### 5.1 The dependency arithmetic

| property              | value                                       |
| --------------------- | ------------------------------------------- |
| version at evaluation | `25.4.7`                                    |
| published versions    | **454**                                     |
| runtime dependencies  | `@opentelemetry/api ^1.9.0` (one, not zero) |
| peer dependency       | `zod ^3.24 \|\| ^4`                         |
| unpacked size         | **22.36 MB**                                |

454 versions and a major version at 25 is not a criticism of the library; it is an accurate
description of a fast-moving young framework. It is a statement about what adopting it does to
**this** repository: this project's audit trail is a chain of committed constants and registered
numbers, and its baseline would then be pinned to somebody else's release cadence. A `^` range
here is not a version, it is a moving target, and the thing that moves is the component whose job
is to make readings comparable.

### 5.2 The architectural cost is the decisive one, not the size

The optimizers are not separable from the program model. `AxGEPA` optimizes an `AxProgram`, which
means a signature, which means rewriting what is currently `packages/cortex-memory/src/prompt.ts`:
**2,954 lines of prompt text in four declarative tables, where every entry carries the registration
number that produced it** (`ASK_ROUTES`, `ASK_CONTROLS`, `ASK_CHANGES`,
`ASK_CHANGES_WHEN_DERIVATION`).

That file is this project's principal asset. Its value is that a reviewer can read a line, find the
run that changed it, and find the section that predicted the change. Replacing it with signatures
whose rendered text is produced by a framework would trade an auditable constant table for an
opaque generated prompt, and it would do so **before** anyone has measured that the generated prompt
is better — at `k` candidates, which §3 says cannot be measured.

The same reasoning applies to the provider layer. `packages/cortex-core/src/interfaces/llm.ts` is
30 lines and defines exactly what this product needs: `complete` and `completeStructured` with
`temperature`, `maxTokens` and a schema. Ax ships fifteen providers, an intermediate
representation compiled to six languages, an agent runtime with a JS sandbox, and a flow graph.
None of that is on this product's path, and all of it would be installed.

### 5.3 Its own observed behaviour contradicts the arm's constraint

`AxBootstrapFewShot` raises `temperature` with each batch "starting from 0.7" to encourage
diversity across attempts. That is correct for collecting demos and it is exactly what §2.1 and
§2.2 forbid here: a run whose `temperature` is a function of an optimizer's batch index cannot be
compared to a control, and §13.114's whole finding is that the difference between `0` and unset was
enough to make a campaign unreadable.

### 5.4 Verdict, and what is taken from it instead

**Not adopted as a dependency.** Three ideas are worth having and cost about 600 lines to
implement in-frame, where the numbers stay comparable:

1. **Trace collection as few-shot** — collect successful traces, but filter them against the
   format contract, because our prompts carry a structured contract (`candidates` ask: one line per
   mention, `date | evidence | INCLUDE/EXCLUDE | clause`) and a demo that violates it teaches
   the violation.
2. **A Pareto frontier** — two objectives only, accuracy and prompt characters, which is the
   trade-off this arm has already been making by hand since §13.118.
3. **Reflective revision** — an LLM reads the failing cases and proposes a candidate, offline,
   producing a **candidate** rather than a change. This is what `tools/mr-failure-census.mjs` and
   `§13.204`'s manual reads already achieve, and the difference would be throughput.

All three are L2, and none of them runs until there is a development split.

---

## 6. Three independent reports of the same failure

The arithmetic above is this repository's. It is not unique to it.

### 6.1 GEPA's own documentation

> Without a separate valset, GEPA will tend to overfit the training data.

and, on the mechanism:

> the same program compiled against a different student LM will produce different instructions — the
> reflection LM tailors its output to what the student model responds to, which means the JSON is
> **not transferable across student models**.

That last sentence is the direct answer to the premise of the question. Optimized prompt artifacts
are **model-specific by construction**, so compiling them is not a way to be compatible across
models — it is a way to need one compilation per model, each requiring a trainset, a valset, a
holdout, and thousands of metric calls.

### 6.2 A measured failure on a real product prompt

Simon Willison, July 2026, running DSPy GEPA against Datasette Agent's production SQL system prompt:

|                                       | baseline     | after GEPA   |
| ------------------------------------- | ------------ | ------------ |
| training accuracy (20 questions)      | 90%          | **95%**      |
| held-out test accuracy (10 questions) | 95%          | **85%**      |
| prompt size                           | ~2,400 chars | ~8,800 chars |

A five-point training gain bought a **ten-point held-out loss**, on a smaller and simpler task than
anything here. The mechanism is worth keeping: the optimizer added a rule ("when unsure, run
`SELECT DISTINCT status FROM orders`") that collided with an existing display-mode rule, so the
model followed it literally, saw a row count instead of rows, re-ran the same query three times,
and exhausted its iteration budget. The author's own two conclusions:

> eval quality has to be debugged before optimizer quality is trusted

and, separately, that two of three apparent baseline failures were bugs in **his own scoring
metric**, not agent errors.

For this repository the second one is the one to sit with. We have spent sixty rounds finding that
our criteria were wrong rather than our system — §13.205's guard that could not fail, §13.157's
five-tuple that was unsound. An optimizer pointed at a criterion with that history optimizes the
defect.

### 6.3 A Pareto frontier is not a holdout

An independent replication of GEPA on AIME reports that performance on the Pareto set "has no direct
correlation (or at best, has a weak correlation) with the generalization performance", that GEPA
"selects the wrong candidate at the end", and that moving the validation examples into the Pareto
set — the DSPy argument that a larger Pareto set acts as regularization — "produced no meaningful
improvement". Same conclusion as §6.1 from a different direction: **only a split nobody selected on
is a holdout.**

---

## 7. L1, which is what the request actually needs

A model change should not be met with a search. It should be met with a **measurement before
admission**, and this is cheap: ~40 probe questions, one run, no holdout needed because nothing is
being selected.

`@agentix-e/cortex-ai`'s `LlmProfile` already does the half that is a value: which checkpoint,
which dtype, whether it can reach the network, and it refuses to fall back. What it does not yet
carry is **what the model can be trusted to do**, and that is the missing piece.

### 7.1 The six probes

| probe                 | what it measures                                                         | how                                                   | threshold                           |
| --------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------- |
| `abstention-fidelity` | does it emit the abstain token when the evidence genuinely holds nothing | 10 questions whose gold is a decline (ABS shape)      | ≥ 29/30, the shipped arm's own rate |
| `screen-compliance`   | does it write the `candidates` Step-1 line in the contracted form        | 10 multi-session questions, parsed                    | ≥ 90% of lines parse                |
| `step2-isolation`     | does Step 2 answer only from the INCLUDE lines                           | same 10, checking Step 2 for spans absent from Step 1 | ≥ 90%, the contract's own claim     |
| `context-ceiling`     | the character count at which the tail stops influencing the answer       | bisection on a known-answer probe                     | ≥ 96,000, the registered budget     |
| `determinism`         | the identical-prompt flip rate                                           | 2 repetitions of 250 questions, paired                | **≤ 2.6%** (see 7.2)                |
| `thinking`            | accuracy and token cost with the toggle on and off                       | 100 questions each                                    | recorded, not thresholded           |

### 7.2 Where 2.6% comes from

It is derived, not chosen. To read a 9-question roster effect (1.8pp, the `ask=recommend` movement)
at `k = 2`:

```
0.564·sigma + 1.96·sigma < 9     =>  sigma < 3.57 questions
sigma = sqrt(500 · p · (1-p))    =>  p < 2.6%
```

The shipped reader measures **4.8%**. So:

- At 4.8%, the smallest readable roster effect at `k = 2` is about `2.52 × 4.27 ≈ 10.8` questions.
- The `ask=recommend` result, +9, is **below that floor** — which is precisely why §13.135 called
  its seven untouched-capability conversions a "+1.5 point gain produced by nothing" and did not
  adopt it.
- A model at 2.6% or below would make that same effect readable.

This turns "which model should we use" from a preference into a decidable question, and it is the
first thing in this campaign that would let a **model swap** be evaluated rather than argued about.

### 7.3 What a manifest entry is

```jsonc
{
  "model": "deepseek-chat",
  "measuredAt": "<run id>",
  "abstentionFidelity": { "rate": "29/30", "probe": "abs-shape-10" },
  "screenCompliance": { "parseable": "...", "probe": "mr-screen-10" },
  "step2Isolation": { "violations": "...", "probe": "mr-screen-10" },
  "contextCeiling": 96000,
  "determinism": { "flips": 19, "of": 470, "rate": "4.8%", "admitted": true },
  "thinking": { "on": { "accuracy": "...", "tokens": "..." }, "off": { "...": "..." } },
}
```

`determinism.admitted` is the only field that can refuse a model, and it refuses it **for the
benchmark**, not for the product. A 20% flip rate is a usable product and an unusable measuring
instrument, and conflating those two has cost this campaign several rounds.

---

## 8. What would reopen L2

Three conditions, all necessary, none of them met today:

1. **A development split that is not the evaluation set.** 500 questions split as 350 dev / 150
   holdout leaves `sigma` on the holdout at `sqrt(150 × 0.048 × 0.952) = 2.6` questions — the
   holdout is _quieter per question_ than the full roster, which is the one genuinely attractive
   number in this analysis. But the split must first be shown not to differ in difficulty from the
   whole, and that check is itself a measurement nobody has run.
2. **A metric that is a registered criterion, not a free-scoring judge.** §6.2's failure was an
   optimizer reading its author's metric and folding it into the prompt. Our registered criteria are
   already the right shape; an LLM judge's prose feedback is not.
3. **`sigma` at or below 3.25 questions**, from §3.2. Without it, the compiled artifact cannot be
   shown to be better than the one a person writes in an afternoon, and the whole exercise is a more
   expensive way to pick a prompt.

Until all three hold, L2 is not a plan; it is a wish with a budget.

---

## 9. What this round did not establish

- **That a search would find nothing.** It established that at this noise a search cannot _show_
  what it found. A quiet enough instrument would change the answer, and §8 names the quietness.
- **That `temperature` is useless.** It is a real knob with a real effect on diversity. It is simply
  not a variable in a **comparison**, because a comparison needs both sides to differ in one thing.
- **That the framework is bad.** §5 is about fit. Ax's own numbers — 22 MB, 454 releases, a
  temperature-raising bootstrap — are accurate descriptions, and a project with a different
  constraint would reasonably adopt it.
- **That L1's thresholds are final.** 2.6% is derived from one campaign's effect sizes; a different
  target effect gives a different admission line, and §7.2's algebra is printed so the derivation can
  be redone rather than believed.

---

## 10. The one-line version

A parameter that tunes itself is a parameter nobody registered, and this arm has already paid for
that once (§13.114). What the request needs is not a search but an admission test: measure the model
before it enters a reading, refuse it if its identical-prompt flip rate makes the reading
unreadable, and keep writing one prompt change at a time — because `k = 1` is the only search shape
this instrument can resolve, and that is arithmetic rather than taste.

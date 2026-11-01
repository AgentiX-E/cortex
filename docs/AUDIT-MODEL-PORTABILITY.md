# Deploying on a reader nobody measured

The question is not whether Cortex should optimize its own prompts. `AUDIT-PARAMETER-SELF-EVOLUTION.md`
settled that: at this arm's noise level a search cannot *show* what it found, so a self-tuning prompt
is a prompt nobody registered. This document answers a different question, asked with four
constraints that are sharper than "should parameters adapt":

1. development and measurement use two providers (DeepSeek, Zhipu);
2. a deployment must not be locked to those two;
3. a deployment on a third provider must not stay worse silently and unfixably;
4. the operator must not have to integrate *their* model with Cortex, benchmark it, and tune it
   **before** first use.

The answer is **yes, with one leg of it conditional and the condition measurable**. The rest of this
document is the arithmetic and the exact place it stops being free.

---

## 1. The conclusion, in the form that can be checked

Four mechanisms, three of which do not depend on anything unmeasured:

| # | mechanism | depends on | status today |
| - | --------- | ---------- | ------------ |
| A | **capability probe set** — 12 probes, 6 must-pass, no ground truth | nothing | written (`CAPABILITY_PROBES`) |
| B | **one-way degradation guard** — downgrades on observable signals, never upgrades | nothing | written (`DegradationGuard`) |
| C | **configuration matrix** — 3 rows, every cell labelled with its evidence | `between > within` (§7) | written, **benefit unproven** |
| D | **pre-classified model table** — shipped with the release, 0 calls for known readers | C being worth it | not started |

A and B are the two that make constraint 3 survivable, and neither needs a comparison with another
model. C is where the real product gain is, and it is the one thing here that is **conditional on a
measurement this repository has never taken**. D is a release-engineering consequence of C.

So the honest one-line answer: *constraint 4 is satisfied by A (30–60 calls, no labels); constraint 3
is satisfied by B (self-downgrade within a deployment, no cross-model comparison); constraint 2 was
already satisfied by `resolveLlmProfile` having no default model on purpose; and the promise that a
substitute reader reaches the same score is C, which nobody can promise until §7's ratio is measured.*

---

## 2. Splitting "it performs worse" into the half that is ours

This is the part that makes the whole design defensible, and it is missing from every "auto-tuning"
proposal I have seen for this problem.

A substitute reader losing 6 questions out of 500 has two entirely different causes:

| cause | example | can Cortex repair it | how it would show up |
| ----- | ------- | -------------------- | -------------------- |
| **the reader's own capability** | it does not know the fact | no, and it should not pretend to | answers parse fine, and are wrong |
| **Cortex's adaptation to the reader** | it writes `7` where the parser reads `Answer: 7` | yes | the answer never reaches the field the scorer reads |

The first kind is the operator's model being weaker than this campaign's, and the only honest product
behaviour is to **report** it. The second kind is a defect **in Cortex**, and it is the kind that a
bare "your model scored X" message hides: the deployment does not look malformed, it looks
inaccurate.

Every probe in this round measures the second kind only. That is why none of them needs a labelled
dataset — `format-label` asks "does the reply carry the label", not "is the fact right". It is also
why the probe set is 12 items and not 250: capability needs a benchmark, **adaptation needs a
conformance test**, and a conformance test is cheap by construction.

> The line between the two is not always clean. A reader that cannot follow the two-step contract
> will produce Step-1 text that looks like a Step-2 answer; that is both. The design handles it by
> putting that probe on the **soft** side: a failure moves the deployment to `guarded`, where the
> prompt contract is simplified, rather than to `minimal`, where the product stops using structure
> at all.

---

## 3. What the probes are, and what each one is worth

`CAPABILITY_PROBES` is data, and every entry cites the reading in this repository that says what
that dimension costs when it goes wrong:

| id | dimension | must-pass | the reading behind it |
| -- | --------- | --------- | --------------------- |
| `format-label` | format-adherence | yes | `parse.ts` reads `Answer: X` / `Answer - X` |
| `format-single-line` | format-adherence | yes | the prose-answer repair exists because both shapes appeared |
| `abstain-token` | abstention-lexicon | yes | `ABSTAIN_TOKEN` is one literal by design (§13.107 census) |
| `abstain-last-line` | abstention-lexicon | no | the last-non-empty-line rule was written for preambles |
| `step2-only` | step-discipline | no | §13.197: +4 on `TR`, −16 on `IE` — a real axis |
| `step2-obeyed` | step-discipline | no | 118 of 121 multi-session questions wrote the contract out |
| `context-96k` | context-window | no | 85.75% at 96k + `ellipsis` against 83.40% at 48k |
| `context-tail` | context-window | yes | a tail-truncating reader answers from the first half, plausibly |
| `sample-repeat` | sampling-stability | yes | §13.118: 16 questions of spread against an effect of 3 |
| `sample-absent` | sampling-stability | no | §13.114: every reading before the fix ran at the provider default |
| `latency-plain` | latency-envelope | yes | DeepSeek V4-Pro blew past 60s on a large context |
| `latency-thinking` | latency-envelope | no | `resolveTimeoutMs` returns 300s for thinking, adapter default otherwise |

Two per dimension, not one: a single probe cannot tell "this reader cannot do it" from "this reader
declined this instance", and §13.118 measured the second kind at 16 questions of dispersion. A
classifier built on single instances would be measuring that dispersion and calling it a capability.

### 3.1 Why the bucket comes from a must-pass subset, never from a score

A weighted score lets four good dimensions hide the one that makes the product produce wrong answers.
`format-label` is the clear case: a reader emitting `7` where the parser expects `Answer: 7` is not
80% of a reader, it is a reader whose answers land in the wrong field. A score expresses that as a
small deduction; a must-pass subset expresses it as what it is.

`classifyPortability` therefore reports **which probes failed, by name**, and the bucket is a
function of membership in that subset.

### 3.2 Why an unmeasured must-pass probe is not a pass

`unverified` is a distinct outcome with its own type, not a fourth bucket, because `configFor` must
not have a row for it. A classifier that defaulted to pass would hand a new reader the shipped
configuration and call the deployment verified — which is §13.114 exactly: the dispatch declared a
temperature, nothing read it, and for a round of readings the artifact described a request nobody
made.

`configFor` throws on `unverified`. The error names the missing probes, because that is the repair.

---

## 4. The guard, and why it may only move one way

The guard watches four signals a call site can produce without labels: `parse-failed`,
`empty-completion`, `abstention-unrecognised`, `deadline-exceeded`. Three inside a window of twenty
calls forces one step down; it never moves up.

**Why never up.** Upgrading is the operation that needs a measurement, and a guard by construction
has none: it sees malformed replies and deadlines, never a correct answer. A guard that judged its
own repair to have worked would be optimizing against the signal it is repairing — the same defect
`AUDIT-PARAMETER-SELF-EVOLUTION.md` §2 refused, one level down. Upgrading is therefore an explicit
act — re-run the probes — and the type has no method that performs it.

**Why 3 of 20.** A single failure downgrading would turn one provider hiccup into a permanent
configuration change for every later session. A rate with no floor never fires, because a 5% signal
on 20 calls is one observation. 3/20 is 15%, against the largest published dispersion in this
repository (16 of 500, 3.2%). A signal that fires at twice the noise floor is a signal.

**Why per reader, not global.** §13.197 measured routes to differ in both directions (+4 on `TR`,
−16 on `IE`). A global window would let one route's failures downgrade another route's reader. One
guard per reader is the shape `readerByRoute` already has.

**Why ties resolve in a fixed order.** Without `SIGNAL_ORDER`, the guard's record of *which* signal
fired would depend on arrival order, and two deployments that observed the same 20 calls would end
with different `downgrades` entries while both being downgraded one step. The bucket would agree and
the explanation would not — `AUDIT-DISCORDANT-IDENTITY.md`'s shape, where the number is right, the
account of it is not, and only the account is auditable afterwards.

### 4.1 What the guard still needs, and it is not free

The guard is a state machine with no consumer yet. Wiring it means producing the four signals at
`cortex-memory`'s `#consult`, and that call site has a trap this repository has already paid for:

> `#recordOutcome` exists because a per-**call** counter made `selfConsistency: 3` publish a census
> summing to **2,968** against a 2,000-question roster, and `reviewPass: 'audit'` did the same with
> one surplus call. Nothing in the artifact said the denominator had changed.

The guard's window is **calls**, which is the right unit for a rate, while the census is
**questions**, which is the right unit for a score. The two must not be merged into one counter, and
the wiring round has to say which is which in the artifact. That is why this round ships the state
machine and not the wiring.

---

## 5. The matrix: three rows, and why not a continuum

`PORTABILITY_MATRIX` has three rows because there are three states of evidence: the configuration
this campaign measured, one that costs something measured, and one whose only claim is that it does
not produce unreadable answers. A fourth row would be a row nobody measured.

Every cell carries `value`, `evidence`, and `scope`, and `scope` is `arithmetic` or
`measured-single-model`. There is deliberately no `measured-cross-model` value: **no cell in this
matrix is backed by a cross-model reading**, and a label no cell can carry is better kept out of the
type than used as a placeholder.

Two rows look like tuning and are not:

- `promptContract` moves to `flat` in `minimal` not because it scores better on a weak reader
  (nothing measured that) but because the `enumerated` contract is the one whose *contract text* a
  weak reader is most likely to echo. Fixing the prompt without fixing the parser would move the
  failure, not remove it — so `parseTolerance` stays `heading-stripping` in **all three** rows.
- `repetitions` rises to 3 in `minimal` for §13.107's reason: a vote is three consultations and one
  outcome, and the counter's unit is the question.

Two invariants are asserted as tests rather than left to review: budgets never widen and deadlines
never shorten as the bucket weakens. Those are the two directions that cannot be argued, and a test
is the only thing that keeps a future cell edit from reversing them quietly.

---

## 6. The budget, which is the part that answers constraint 4

A benchmark answers "how good is this reader on questions whose answers we hold" and costs
`questions × runs`. A probe set answers "does this reader emit what the parser can read" and costs
`probes × repeats`, with **no labels**.

`tools/probe-budget.py` prints the number instead of asserting it:

```
$ python3 tools/probe-budget.py --probes 6
5 repeats x 6 must-pass probes = 30 calls
  per-probe error   0.001028
  report false-pass 0.006151  (target 0.0200)
  a benchmark of the same roster would be 500 x 4 = 2000 calls and would need ground truth
```

The arithmetic is exact binomial, not a normal approximation: at `r = 3, e = 0.048` the exact
answer is `0.0066908` against `0.048` for a single call, and the approximation errs optimistic in
this tail — the direction that ships an under-probed reader. `e = 4.8%` is `§13.194.4` (19 flips in
470 byte-identical prompts), the only figure in this repository that is directly the quantity being
raised to a power.

**Even repeat counts are refused.** An even count has a tie, and a tie needs a third convention
(round up? down?) that would silently become part of the classifier's definition.

So constraint 4 holds: **30 calls for the six must-pass probes, 60 for all twelve, no ground truth,
and the result is cacheable per `(provider, model, version)`.** With mechanism D — a table shipped
with the release — a reader on a common provider spends **zero**.

---

## 7. The conditional leg, stated as a comparison nobody has made

Classifying is worth its cost only if the buckets are further apart than the readers inside them.
Two readers in one bucket differ by `within`; adjacent buckets differ by `between`. If
`within ≥ between`, a bucket label carries nothing a coin flip would not, and the design collapses
to "publish the capability contract and refuse the reader".

`tools/probe-budget.py` refuses to invent either number, and refuses `--between` without `--within`
for the obvious reason: a default of 0 would report every classifier as separated.

**What this repository actually knows about `within`:** nothing cross-model. It knows the *within-
configuration* spread — §13.118.5's four repetitions of one configuration gave `407, 414.5, 414.5,
423`, a standard deviation of **6.54 questions**. That is a **lower bound** for `within` on any
bucket containing more than one model, and it is already larger than most effects this campaign has
published (registered effect: 3 questions).

If that lower bound holds, the classifier needs `between > 6.5` questions to be worth anything —
and no pair of readers in this repository has been measured to differ by that without differing in
provider, which is the confound. So the honest status is:

> **C is unproven, and the lower bound on its condition is already uncomfortable.** The design is not
> wrong; the evidence for its central assumption does not exist yet, and pretending otherwise would
> be the decorative-check failure `search-budget.py` was rewritten to avoid.

### 7.1 The net gain, which is what a product decision turns on

```
no classifier      expected loss = between
classifier         expected loss = Q·between + (1−Q)·residual
worth shipping  <=>  (1 − Q)·(between − residual) > 0
```

`--residual` is what turns this from a note into a verdict, and `residual > between` is **refused**
rather than printed as a negative gain: that case means the guarded row is worse than doing nothing,
which is a defect in the matrix, not a property of a reader.

---

## 8. The three pre-conditions, and where each stands today

| # | condition | today | how it gets measured |
| - | --------- | ----- | -------------------- |
| 1 | `between > within` for adjacent rows | **unknown**; `within` lower bound 6.54 questions | 3 readers × 2 providers × 60 questions, same harness, paired |
| 2 | the guard's signals are producible at `#consult` | not wired | the wiring round, with the call-vs-question unit stated in the artifact |
| 3 | the probe set is stable enough that `e` does not drift | `e = 4.8%` from §13.194.4 on one provider | re-measure `e` per provider when the probe runner lands |

Condition 1 is the one that decides whether C ships. Conditions 2 and 3 are engineering and
bookkeeping.

---

## 9. What would falsify this design

Written down before the measurement, so a disappointing result cannot be re-read as a success:

1. **`between` measured at or below `within`.** Then the buckets are labels on a continuum, the
   matrix is decoration, and the honest product answer is the capability contract: state the six
   requirements, test them in 30 calls, and **refuse** a reader that fails a must-pass probe rather
   than configuring around it. That is a worse product and a true one.
2. **A reader that passes every must-pass probe and still loses ≥ `between` questions.** Then the
   dimensions that matter are ones no conformance test can see, and the probe set's premise — that
   adaptation failures are observable at the boundary — is false.
3. **The guard firing on noise.** If deployments on a *measured* reader routinely downgrade, then
   `3 of 20` is calibrated to the wrong scale, and the guard is a random configuration changer. The
   check is mechanical: run the guard over the archived readings of the shipped configuration and
   count how many synthetic windows would have fired.
4. **`e` rising with provider.** If a substitute provider flips 20% of probe verdicts, 30 calls
   cannot separate a reader from its own noise at any repeat count this tool will spend, and
   classification stops being cheaper than measurement for that provider.

Falsifier 3 is the cheapest to run and the one I would run first: it needs no new calls at all, only
the archived readings already in the repository.

---

## 10. Why `@ax-llm/ax` does not enter this, given that it now has a place

`AUDIT-PARAMETER-SELF-EVOLUTION.md` §5 declined Ax for L2/L3. Nothing here reopens that, and the
reason is worth stating in this document's terms rather than pointing at the other one:

Ax's contribution to this problem would be **searching** for prompt and temperature settings. But §2
splits the failure into "the reader's capability" and "Cortex's adaptation", and search addresses
neither. A search over prompt wording cannot fix `format-label`, because the fix is a **parser
tolerance and a stated contract**, not a better instruction; and a search over temperature cannot
fix a reader whose plain path already needs the thinking deadline.

What C needs is not a search but a **table with three rows and a measured gap**. Ax has no facility
for measuring that gap, and adding a 22 MB dependency with `zod` as a peer and 454 releases to avoid
writing 60 lines of matrix would be paying the architectural cost
`AUDIT-PARAMETER-SELF-EVOLUTION.md` §5.2 describes — a second abstraction for LLM calls beside the
one the product already has — for none of the benefit.

There is one thing Ax does that this design would want: a stable way to describe a *model's*
parameters across providers. That is `LlmProfile`'s job in this repository, and it already exists.
It is 231 lines and it refuses to fall back, which is the property that matters more here than
breadth of provider support.

---

## 11. What this round did not establish

- **That C is worth shipping.** §7 says the opposite: the lower bound on its condition is
  uncomfortable and the measured value does not exist.
- **That 12 probes are the right 12.** They are the dimensions this repository has published costs
  for. A dimension nobody has measured would be a guess about what to ask, which is the failure this
  file exists to avoid — so the set is deliberately limited to what is citable, and it will grow
  only by gaining citations.
- **That the guard's thresholds are calibrated.** `3 of 20` is derived from the largest published
  dispersion; falsifier 3 is the check, and it has not been run.
- **That a pre-classified table would be accurate for a model it has never seen.** D is release
  engineering; it inherits every uncertainty above.

---

## 12. The one-line version

Constraint 4 is satisfiable because adaptation is a *conformance* question — 30 calls, no labels —
while capability is a *benchmark* question; constraint 3 is satisfiable because a deployment can
downgrade itself on its own failures without ever being compared to another model; and the promise
that a substitute reader reaches the same score is a **matrix whose rows must first be shown to be
further apart than the readers inside them**, which is the one measurement this document cannot
supply and the next one must.

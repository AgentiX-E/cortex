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

| id | dimension | must-pass | the reject it prices |
| -- | --------- | --------- | -------------------- |
| `answer-round-trip` | answer-fidelity | yes | the parsed answer is empty, so the question is scored blank |
| `answer-not-transcript` | answer-fidelity | yes | the parse returns the evidence block, so the transcript is scored |
| `abstain-token` | abstention-lexicon | yes | the decline is not the literal, so it is scored as an answer (§13.107 census) |
| `abstain-last-line` | abstention-lexicon | no | the decline is on the last line behind a preamble, and the rule reads it |
| `step2-only` | step-discipline | no | the clause's own axis is real and two-directional (§13.197: `TR` +4, `IE` −16) |
| `step2-obeyed` | step-discipline | no | the answer sits after an echoed contract heading |
| `context-48k` | context-window | no | the reader cannot hold the adopted budget at all |
| `context-tail` | context-window | yes | a tail-truncating reader answers from the first half, plausibly |
| `sample-repeat` | sampling-stability | yes | §13.118: 16 questions of spread against an effect of 3 |
| `sample-absent` | sampling-stability | no | §13.114: every reading before the fix ran at the provider default |
| `latency-plain` | latency-envelope | yes | DeepSeek V4-Pro blew past 60s on a large context |
| `latency-thinking` | latency-envelope | no | `resolveTimeoutMs` returns 300s for thinking, adapter default otherwise |

Two per dimension, not one: a single probe cannot tell "this reader cannot do it" from "this reader
declined this instance", and §13.118 measured the second kind at 16 questions of dispersion. A
classifier built on single instances would be measuring that dispersion and calling it a capability.

### 3.0 The first version of this table was wrong, and production data said so

Four of the twelve probes above did not exist this morning. The two that did — `format-label` and
`format-single-line` — were **both must-pass**, and their premise was that `parse.ts` requires the
`Answer:` label. It does not. Run `41254359622` archived 500 outputs from the highest-scoring arm
this campaign has run, and:

| shape | count | what it means |
| --- | --- | --- |
| carries `Answer:` | **0 of 500** | the label is an *accepted* form, not a required one |
| more than one line | **161 of 500** | the parser returns multiline answers intact |
| scored correct, overall | **451 of 500** (90.45%) | a reader that fails both probes scored 90.45% |

So the probe set would have classified the reader that produced the campaign's best number as
`minimal`. That is not conservatism; it is a probe measuring the prompt's house style instead of the
pipeline's rejects. **This is falsifier 2 of §9 firing on the probe set itself**, and it fired for
free, on data that was already on disk, within a day of the set being written.

The repair is a rule rather than four new strings, and it is worth stating because it will be the
test of every future probe:

> A probe may only be must-pass if its failure makes the answer **unreadable** — the parse is empty,
> or it is the transcript, or a decline is scored as an answer. A probe whose failure only makes the
> reply *less pretty* prices a cost the product does not pay.

The four `answer-fidelity` and `abstention-lexicon` entries above are the pipeline's actual rejects.
They are the ones that lose a question rather than an aesthetic.

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
`empty-completion`, `abstention-unrecognised`, `deadline-exceeded`. Three of them inside a window of
twenty calls, in **two consecutive windows**, forces one step down; it never moves up.

**Why never up.** Upgrading is the operation that needs a measurement, and a guard by construction
has none: it sees malformed replies and deadlines, never a correct answer. A guard that judged its
own repair to have worked would be optimizing against the signal it is repairing — the same defect
`AUDIT-PARAMETER-SELF-EVOLUTION.md` §2 refused, one level down. Upgrading is therefore an explicit
act — re-run the probes — and the type has no method that performs it.

**Why 3 of 20.** A single failure downgrading would turn one provider hiccup into a permanent
configuration change for every later session. A rate with no floor never fires, because a 5% signal
on 20 calls is one observation. 3/20 is 15%, against the largest published dispersion in this
repository (16 of 500, 3.2%). A signal that fires at twice the noise floor is a signal.

**Why two consecutive windows.** Because the downgrade is permanent, and a permanent action cannot be
priced by a per-window rate — §9.4. At the 5% tolerance a latched alarm downgrades **72.26%** of
working deployments within one 500-question run. Two consecutive firing windows take that to
**5.58%**, and only a reader that fails every window pays: it downgrades at 40 calls instead of 20.

**Why the three are counted together and not per signal.** Because 15% is a statement about a rate,
and four separate tallies ORed together is four tolerances rather than one — §9.3. Counting them
together is what makes the sentence above true; naming the most frequent one afterwards is what keeps
it auditable.

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

### 7.0 The one controlled study of this question, and the three things it says this design is missing

**Goyal & Ray, *Does Your Agent's Memory Survive a Model Upgrade? A Controlled Study of Memory
Portability*, arXiv:2609.05339 (4 Sep 2026).** Four storage formats over the same history, two
open-weight readers under 10B, 48 synthetic histories with randomised answer codes, **exact scoring
with no LLM judge**, and the model swapped in both directions:

| format | accuracy after a writer swap |
| --- | --- |
| fixed-schema knowledge graph | **+0.0004 ± 0.0020** — the uncertainty is five times the effect |
| model-compressed notes | **+9.91 or −13.28** depending on direction |
| chunked RAG, full re-embed | **+11.90** available |
| chunked RAG, 50/50 mixed index | **+4.96** — forfeits most of the gain |

Three results in that table bear directly on this file.

**One: the design is direction-blind, and direction dominates.** Cortex classifies one reader in
isolation and never compares A→B against B→A. Their measurement is that the same store gains ten
points one way and loses thirteen the other, so a one-sided classification can call a pair portable
when half of it is not. **This is a real gap in the design, not a difference of emphasis.** It also
reproduces here: last round's pair measured +23.50 for enabling the reader's thinking routes, and
§13.197 measured the same knob at −12 on a different ask. Two independent observations of the same
asymmetry, one external and one internal, and the file that classifies readers does not model it.

**Two: the embedding space is a harder lock-in than the reader, and this file does not mention it.**
Cortex is RAG-shaped: evidence is retrieved into a prompt, so the store's vectors came from whichever
embedding provider was running. Their partial-migration row is the one that applies — **4.96 of a
possible 11.90**, i.e. mixing old and new embedding spaces forfeits most of the gain while every call
still succeeds. Cortex ships Zhipu `embedding-3` and a deterministic hash embedding as its credential-less fallback,
so a deployment that runs both is exactly the mixed-index case.

Cortex is **ahead of the study on the field and behind it on the magnitude**. `EmbeddingProvenance`
already records `provider` / `model` / `dimensions` / `preflight` per run, and its own docstring
makes the study's argument a year early: *"a silent substitution between two deterministic-but-
incompatible embeddings is invisible in every downstream number: both produce stable vectors, so a
determinism probe reads `0` either way."* What does not exist is a **number for cortex's own store**
— nobody has measured full-versus-partial migration here — and `classifyPortability` has no
dimension for it at all: every row of the matrix describes the reader. **Reader portability is the
smaller half of portability**, and this file has so far been about the smaller half.

**Three: exact scoring is what makes their result citable, and it bounds what can be claimed about
a swap measured through a judge.** Their study keeps the judge out entirely. A pipeline that scores
through one cannot make that claim: the repeated audits of LLM-as-judge put identical-input flip
rates at **11–14%** (Yagubyan, GroundLM 2026, six judges, three providers, 29 tasks), and a
pre-registered audit of 52,988 requests found same-window Spearman agreement of **0.400 against a
0.90 gate**, with four providers spanning 0.74–0.88 on replay and **none reaching 0.99**
(arXiv, 2026). Cortex's own same-prompt flip rate is **4.8%** (§13.194.4) — better than those
figures because the first scoring tier is exact match rather than a judge, which is the same design
choice Goyal & Ray made. The tier below it is a judge, and **anything that reads a swap through that
tier inherits the judge's 11–14%, whatever the reader did.**

What this changes in the design, in priority order, and all of it is bigger than a probe:

1. **A measured migration cost for cortex's own store.** One index built across two providers is
   not a single space, and the study puts the gap between a full and a partial re-embed at
   **11.90 against 4.96 points**. Cortex has the provenance field and has never taken the
   measurement; until it does, the matrix's silence about embeddings is an assumption.
2. **A direction, recorded.** `classifyPortability` classifies a *reader*; it should classify a
   *migration*, because the study's asymmetry is the largest effect either document contains.
3. **The judge's contribution to any delta, stated.** If a reading moves and the judge is in the
   loop, part of the move is the judge — and the judge literature puts that part at 11–14%.

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

### 9.1 Falsifier 3, run: the guard is quiet, and one of its four signals is unreadable

`tools/guard-window.py` slides the guard's own window over a run's call stream. On the two archived
runs of the shipped configuration:

```
artifact  41254359622
  derivable  1 of 4 guard signals
    empty-completion          0 of 500 calls ( 0.000%)   windows fired   0 of 481 (  0.00%)
  not derivable from this artifact
    parse-failed           the artifact stores the parse result, never a judgement about it
    abstention-unrecognised needs a lexicon, and a lexicon is a guess until someone measures it
    deadline-exceeded      the adapter raises it and no artifact field carries it
verdict: quiet on the one signal this artifact can express
```

So falsifier 3 **does not fire on the signal that can be read**, and the other three are stated as
unreadable rather than as zero. That is the honest form of the result: one quarter of the falsifier
is answered and three quarters are blocked on fields nobody writes.

**The counterfactual is the part worth keeping.** The one failure-shaped thing every artifact does
record is the decline (`answer === null`). Counting it would fire the guard:

| run | declines | windows that would fire | of those declines, scored correct |
| --- | --- | --- | --- |
| `41254359622` | 32 of 500 (6.40%) | **105 of 481 (21.83%)** | **30 of 32** |
| `41222844945` | 45 of 500 (9.00%) | **136 of 481 (28.27%)** | **30 of 45** |

Thirty of the thirty-two declines are *correct answers* to questions whose evidence was absent. A
guard that counted declines would downgrade a deployment for abstaining properly, four times an
hour, and the two declines that were genuinely wrong occur at **2 in 500** — about a tenth of the
4.22% rate at which `3 of 20` fires on one window in twenty.

**And the clustering, which the first version of this section got wrong twice.** The claim here used
to be that the same 32 events fire on 21.83% of windows when they arrive in runs of six, against
13.27% if the calls were exchangeable — 1.65× — because LongMemEval groups questions by capability
and the absent-capability ones sit together. The mechanism is right. The number was not measured: it
came from a hand-built 500-element array with five runs of six and two singletons, and no archive
looks like that array. §9.2 replaces it with twelve measurements and retracts the 1.65×.

What survives §9.2 is stronger than what it replaces: the arrangement does move the firing rate by a
factor of two across archives, it just does not do so in the direction or the magnitude the
constructed example implied, and the largest single contributor is not dispersion at all but the
composition of the call stream.

---

### 9.2 The dispersion factor was constructed, not measured. Twelve archives, and what they say

The table below is `tools/guard-window.py` run over every 500-question ablation report this campaign
still has on disk. `exchangeable` is `P(X >= 3)` for `X ~ Binomial(20, p)` at the archive's own
decline rate; `sliding` is the share of the 481 start positions that actually reach three; `ICC` is
the one-way random-effects intraclass correlation of the decline stream in blocks of twenty;
`stratum-local` counts only windows that stay inside one capability label.

| run | declines | exchangeable | sliding | ratio | ICC | stratum-local |
| --- | --- | --- | --- | --- | --- | --- |
| `39367801501` | 74 | 58.53% | 46.36% | 0.79x | +0.131 | 30.45% (102/335) |
| `39449569048` | 72 | 56.54% | 44.70% | 0.79x | +0.123 | 27.76% (93/335) |
| `39509698041` | 69 | 53.46% | 46.36% | 0.87x | +0.104 | 27.46% (92/335) |
| `39529234665` | 73 | 57.54% | 46.57% | 0.81x | +0.122 | 27.46% (92/335) |
| `39641088296` | 114 | 86.73% | 66.11% | 0.76x | +0.158 | 54.93% (184/335) |
| `39699987781` | 77 | 61.43% | 51.56% | 0.84x | +0.121 | 37.31% (125/335) |
| `40083132802` | 482 | 100.00% | 100.00% | 1.00x | +0.064 | 100.00% (335/335) |
| `40088479628` | 75 | 59.51% | 48.02% | 0.81x | +0.100 | 29.85% (100/335) |
| `41159983913` | 48 | 30.03% | 34.51% | 1.15x | +0.108 | 15.52% (52/335) |
| `41185512391` | 50 | 32.31% | 34.51% | 1.07x | +0.107 | 16.72% (56/335) |
| `41188431321` | 100 | 79.39% | 46.36% | 0.58x | +0.267 | 28.96% (97/335) |
| `41203245999` | 50 | 32.31% | 29.73% | 0.92x | +0.100 | 10.15% (34/335) |

Three corrections come out of it.

**One. The ratio has no fixed sign and its range excludes the published number.** Across the eleven
non-degenerate archives the observed share runs from **0.58× to 1.15×** of the exchangeable
prediction, median **0.81×**. Nine of eleven fire *less* than exchangeable. The published 1.65× is
outside the range of every archive in this campaign — not because the arithmetic was wrong but
because the array it was computed on was chosen to be maximally clustered and the real streams are
not.

**Two. Positive dispersion coexists with a lower firing rate, and that is not a paradox.** ICC is
positive in all twelve archives (+0.064 to +0.267, mean +0.125) while nine of eleven fire less than
exchangeable. The mechanism is where the trigger sits relative to the window's expected count. At
`p = 0.048` the expected count is 0.96 and the trigger is three: clustering moves mass into the far
tail and the share goes from 6.85% to 13.27% at `rho = 0.1`. At `p = 0.10` the expected count is
2.0, one short of the trigger: packing events into runs now *reduces* the number of windows that
reach three, and the same `rho = 0.1` takes the share from 32.31% down to 30.95%. Both numbers are
`beta_binomial_tail(3, 20, p, 0.1)` and the tool prints them side by side. **So the guard's
operating point decides the sign of the correction, and a guard is by construction operated well
below its trigger** — which is the regime where exchangeability is optimistic by up to 1.9×.

That last sentence is the one that changes a decision. Inverting the rule at the measured `rho` of
+0.10 gives the per-call rate at which a working reader still fires on 5% of windows: **2.03%**
rather than 4.22%. The exchangeable figure is **2.08× too generous as a tolerance**, and the
direction of that error is the dangerous one — it promises quiet to readers the guard will actually
downgrade.

**Three. Composition beats dispersion, and by more than an order of magnitude.** Sliding windows that
straddle a capability boundary sample two populations, and on `41203245999` restricting to
stratum-local windows takes the share from **29.73% to 10.15%**, a factor of 2.93. Across the table
the stratified column is 35% to 66% below the sliding one. The archive's call order is a
concatenation of sub-populations with different decline rates; that is not a dispersion parameter,
it is a mixture, and no `rho` can recover it. `--stride` was also wrong: `DegradationGuard` resets
its counter every twenty calls, so it tumbles, and the tool slid. Both are now reportable and the
guard's own setting is the one named in the output.

None of this changes the shipped constant yet, because the two facts that would justify a change are
not in hand: the guard's own signals run at **0 of 2000 calls** on the measured reader, so no
archive contains a compliance-failure stream to calibrate against, and the audit's own rule is that a
threshold moves only when a measurement says it must. What changes now is the *claim*: 4.22% is a
tolerance under exchangeability, the exchangeable assumption is wrong in the direction of optimism at
the operating point, and the honest tolerance at the measured dispersion is 2.03%.

---

### 9.3 The trigger counts one signal, and the rule ORs four

Found while writing §9.2, and it is a defect in the shipped guard rather than in the audit.

`DegradationGuard` held one tally per signal and fired if **any** tally reached `GUARD_TRIGGER`. The
documented tolerance said `WINDOW = 20, TRIGGER = 3` is 15%, compared against a 3.2% noise floor.
Both statements are about *one* signal. The rule was a disjunction over four: at a per-call rate of
4.22% — the point where one signal fires on 5% of windows — the rule as written fires on
`1 - (1 - 0.05)^4 = **18.55%**` of them, assuming independence, and less only insofar as the four
signals correlate. So a reader sitting exactly at the documented tolerance was being downgraded up to
**3.7× more often** than the number promised, and a reader at a quarter of it was being downgraded at
the promised rate.

The fix is to count signals of every kind against one trigger, which makes 15% the total rate a
reader may carry before a typical window trips — the statement the constant was written to make. The
record keeps attribution by naming the most frequent signal (ties on `SIGNAL_ORDER`) and now carries
`total` beside `observed`, so a window that fired on `1 + 1 + 1` is distinguishable from one that
fired on `3 + 0 + 0` after the fact. Both are downgrades; only one of them is a reader that
mis-formats.

Nine existing tests passed unchanged under pooling, including the tie-break one, which means the
change is a strengthening of what the guard already claimed rather than a new behaviour. Four tests
were added: the three-way spread fires, the record separates `observed` from `total`, two failures of
two kinds still do not fire, and the union arithmetic is pinned at 18.55%.


---

### 9.4 A permanent action cannot be priced by a per-window rate

The last defect is the one that would have made the feature impossible to switch on.

`DegradationGuard` downgrades and **never recovers**. So the quantity an operator experiences is not
"5% of windows" but "has this fired at all", which over `n` windows is `1 - (1 - p)^n`. One
500-question run is 25 windows:

| per-window rate | latched, 25 windows | two consecutive windows |
| --- | --- | --- |
| 5.0% (the tolerance) | **72.26%** | **5.58%** |
| 13.0% (measured dispersion, §9.2) | 96.92% | 30.80% |
| 30.0% | 99.99% | 84.17% |
| 95.0% (a reader that fails every call) | 100.00% | 100.00% |

A guard calibrated to downgrade 72% of *working* deployments inside a single evaluation run is not a
safety feature; it is a configuration shredder, and the reason it had not been noticed is that the
guard's own signals run at **0 of 2000 calls** on the measured reader. The safety came entirely from
the signals being absent, never from the rule being conservative.

The fix is `GUARD_PERSISTENCE = 2`: a window that fires only arms the guard, and a second consecutive
firing window acts. That is the smallest change that makes "this reader is broken" different from
"this reader had a bad twenty calls", and it costs a genuinely broken reader twenty extra calls —
40 instead of 20 — while a reader that fails every call still downgrades with probability 1.

The SPC literature is what made this visible rather than the code: control charts quote an **average
run length**, `1 / p`, and every source that defines it also warns that the run-length distribution is
heavily skewed and that ARL alone misleads. `1 / p = 20` windows reads as "once every 20 windows" and
is in fact "27.7% chance of surviving 20 windows". A latching alarm is the case where quoting the ARL
is not merely imprecise but inverted.

Four tests were added for the new rule and four existing ones were rewritten to reach the second
window; the record gained no new field, because persistence is a property of the sequence rather than
of the window. `model-portability.ts` remains at 100% statements, branches, functions and lines.

---

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
  only by gaining citations. It has already shrunk once: §3.0 records the two style probes that
  were must-pass and that production data failed.
- **That the guard's thresholds are calibrated.** `3 of 20` is derived from the largest published
  dispersion. Falsifier 3 has now been run for one of its four signals (§9.1) and the guard is
  quiet there, but the other three are unreadable from an artifact, and the same section found that
  the rule's rate calibration is 1.65x too optimistic when the calls arrive in blocks.
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

Two corrections belong beside that sentence, because both came after it was written and both point
the same way — **the reader is not the main character.** The probe set's first version measured the
prompt's house style and would have refused the campaign's best reader (§3.0); and the only
controlled study of model swaps in an agent's memory puts the *storage format* and the *migration
direction* ahead of the reader's identity — `+0.0004` for a fixed schema against `+9.91 / −13.28`
for a note store, and 4.96 of a possible 11.90 points for a half-migrated index (§7.0). The design
in this file is sound about the reader and silent about the two things that are larger.

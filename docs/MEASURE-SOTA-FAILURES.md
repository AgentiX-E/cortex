# MEASURE-SOTA-FAILURES

Where the 96 misses on the `cortex-memory` arm actually are, measured from run `40088479628`'s
per-question records rather than argued from capability totals.

## 0. One paragraph

On the arm that ships, **the gold turn reaches the rendered prompt for 500 of 500 questions**
(`goldOverlap.carried > 0` everywhere, `pool = 0` nowhere). Retrieval on this arm is not the
bottleneck, and no retrieval experiment can recover the 96 misses by finding evidence it already
found. Of the 96, **45 are the reader declining** on evidence it was given and **51 are the reader
answering wrong**. The abstention gate is therefore the single largest failure source on the best
arm this repository has — while the capability that is *supposed* to abstain reads 30/30. Two shapes
account for the largest share of the rest: **12 of MR's 37 misses answer exactly one lower than
gold**, and **21 of TR's 33 are abstentions**, which is a route the recovery pass does not reach.

## 1. The decomposition

| capability | n | correct | failures | declined | answered wrong |
| --- | --- | --- | --- | --- | --- |
| IE | 150 | 134 | 16 | **12** | 4 |
| KU | 72 | 62 | 10 | 2 | 8 |
| MR | 121 | 84 | **37** | 10 | **27** |
| TR | 127 | 94 | 33 | **21** | 12 |
| ABS | 30 | 30 | 0 | — | — |
| **all** | **500** | **404** | **96** | **45** | **51** |

`ABS`'s thirty abstentions are correct by construction — its gold *is* a decline — and are excluded
from the declined column. Every other row's declined count is a miss.

### 1.1 The row that settles what kind of problem this is

| capability | gold turns present, as a fraction of the question's gold set | questions with **no** gold turn in the prompt |
| --- | --- | --- |
| IE | 75/150 complete, 150/150 at least one | 0 |
| KU | 5/72 complete, 72/72 at least one | 0 |
| MR | 85/121 complete, 121/121 at least one | 0 |
| TR | 89/127 complete, 127/127 at least one | 0 |
| ABS | 2/30 complete, 30/30 at least one | 0 |

**Zero questions in five hundred have no gold turn in the prompt.** This is the arm's defining
property and it is what makes it a different system from the reference pipeline: with a 256-wide
relevance pool and a 48,000-character room, recall of the annotated evidence is saturated, and the
score is decided entirely by what the reader does with it.

Partial carriage is common (36 of 121 MR questions, 38 of 127 TR) and it costs accuracy — 75.3%
against 55.6% on MR, 83.1% against 52.6% on TR — but it cannot be the whole gap, because the
questions that carry the *complete* gold set are still wrong **21 times out of 85** on MR.

### 1.2 What the artifact says, and what it cannot

`goldOverlap.carried` counts against `assembled.carried` — the set the renderer placed in the prompt,
which `#recordEvidence` stores as `#lastRetrievedContext`. So the 500/500 above is a statement about
the **rendered** prompt, not about an intermediate. That distinction is worth stating because the
same record also carries `featureAdmittedEvidence`, the pre-budget set, and the two differ whenever
`fitToBudget` binds — which on this arm is **almost always**: `promptChars` reads a median of 46,200
against a 48,000 ceiling on MR and 47,130 against the same ceiling on TR.

Three things it cannot say, and this document does not pretend otherwise:

1. **Whether a *phrase* survived.** A gold turn enters the prompt through a 400-character cap on
   `multi-session,temporal`. Measured: the answer phrase starts beyond character 400 in 4 MR
   questions and 0 TR questions, so the cap is not cutting answers materially — but the field that
   would tell you directly does not exist.
2. **Whether the answer is extractable at all**, for MR and TR. Their gold is a **computed** value —
   a count, a date — so requiring the gold string verbatim in the text measures nothing: MR has the
   phrase in some turn on 58 of 121 questions and TR on 37 of 127. The verbatim test that worked for
   IE (`MEASURE-BASELINE-DRIFT.md` §8.8, 4/150) is meaningless here and must not be quoted as if it
   were the same measurement.
3. **What an alternative ask would have done.** There are no per-question records for the baseline
   arm in this artifact, so the 18-question MR gap against `reference-pipeline` can be described
   (102 against 84) but not decomposed. That is a gap in the instrument, and §5 states its cost.

## 2. The largest single source: the reader declines

Forty-five of ninety-six. And it is not uniform across routes:

| capability | declined | share of that capability's misses |
| --- | --- | --- |
| TR | 21 | **64%** |
| IE | 12 | 75% |
| MR | 10 | 27% |
| KU | 2 | 20% |

The abstention machinery is *precise*: on the thirty false-premise questions it reads 30/30, and
`decisionReasons` shows `{empty: 0, threshold: 0, llm: 75}` — every decline is the model's, none is
a gate firing on an empty or low-scoring pool. So the gate does exactly what it was built to do, and
then fires 45 more times on questions whose gold the prompt contains.

**What the declines look like.** A TR case, verbatim from `rawOutput`:

```
Let me search the evidence for two charity events on consecutive days.

- Feb 14 (Tue) 09:06: "just got back from the '24-Hour Bike Ride' charity event, where I cycled
  for 4 hours non-stop" — charity event on Feb 14 (or just before).
- Feb 15 (Wed) 08:39: "I participated in the 'Ride to Cure Cancer' charity bike ride and rode
  40 miles on my road bike recently" — but "recently," not necessarily consecutive.
- Mar 19 (Sun) 15:02: "the 'Walk for Hunger' event I did today" — charity walk on Mar 19.

The clearest consecutive-day pair: Feb 14 ... and Feb 15 ... But Feb 15's ride is described as
```

The reader found the two events, ordered them, and then declined **because one of them carried the
word "recently"**. The evidence was sufficient; the hedge word in the evidence was read as a
disqualifier. That is a specific failure of the abstention contract on temporal questions, and it is
not what the contract says — the contract asks for `INSUFFICIENT_EVIDENCE` when the evidence *does
not establish* an answer, and two dated events on consecutive days do.

### 2.1 The recovery that exists for exactly this shape does not reach two of the four routes

`planAbstentionRecovery` retries a decline that contradicts its own Step 1 list, and it is wired into
`#promptSessionAware` — the `multi-session` route — and nowhere else:

```
$ rg -n "planAbstentionRecovery" packages/cortex-memory/src/memory.ts
# one call site, inside #promptSessionAware
```

The artifact's own counters say what that is worth there:

```
recovery: {attempted: 10, answered: 1}
```

Ten attempts — exactly MR's ten declines — and **one** conversion. So the mechanism as it stands
converts 10% of the population it targets, and the 33 declines on `temporal` and `flat` are never
retried at all.

Two readings, and the honest one is the second:

- *Extend it*: 33 untried declines, a mechanism that cannot hurt (it only consults on questions that
  are already wrong). At MR's measured 1/10 rate that is **+3 questions**. The adopted
  configuration's four genuine repeats span **397–412 — 15 questions** (`cortex-docs` 01 §2 item 5
  and its totals table, run `39367801501`). **A +3 marginal effect cannot be seen against a
  15-question marginal range**, and the prior is not a guess: it is the same mechanism's measured
  conversion rate on the route where it already runs.
- A correction to this section's first draft: it cited `409 / 392 / 404` as three readings of one
  arm. They are not. `392` is `relevanceUnits: session` (`39699987781`) and `409` is
  `reviewPass: none` (`39509698041`); only `404` is the shipped configuration. Three numbers from
  three configurations, presented as one arm's variance — the same mistake, at the same size, as
  `MEASURE-BASELINE-DRIFT.md` §8.7's `217/221/224`.
- *Fix the target*: the TR decline above is not a decline that contradicts a list — it is a decline
  that *has* the list and reads a hedge word as fatal. The recovery pass quotes the list back and
  asks again, which is the wrong correction for it.

**So the finding is the population, not the fix.** 33 declines on two routes that the only existing
remediation does not reach, with a documented example of what they look like. The experiment that
follows from this needs a mechanism aimed at *"the evidence is hedged, not absent"*, and this
document registers that as the open question rather than proposing a wording.

## 3. The second source: MR answers exactly one low, and the traces say why

| delta from gold | count |
| --- | --- |
| **−1** | **12** |
| > 3 (any direction) | 7 |
| +1 | 2 |
| +2 | 2 |
| −2 | 2 |
| non-numeric | 2 |

Twelve of MR's twenty-seven answered-wrong misses are *exactly* one short. That is not a random
error distribution — a reader guessing would scatter.

### 3.1 The hypothesis this section first carried, and why it is dead

The first draft reasoned from the ask's own contract to a mechanism: the contract says *"Do not reply
`INSUFFICIENT_EVIDENCE` without first writing the Step 1 list"*, so an answer one low should be a list
one short. The lists are in `rawOutput`, so it was checkable in a script rather than in a dispatch, and
it was checked:

| list length relative to gold | count |
| --- | --- |
| exactly gold − 1 | **3 of 12** |
| exactly gold | 4 of 12 |
| shorter still (1 item against gold 3) | 3 of 12 |
| longer than gold (8 against 5, 12 against 4) | 2 of 12 |

**The list length bears no relation to the answer.** One case answers 2 from a one-item list against a
gold of 3 (`10d9b85a`); another answers 22 from a three-item list against a gold of 23
(`gpt4_2f91af09`). The count is not derived from the list, so "a list with one item missing" is not
the mechanism, and the reasoning that produced it — *the contract orders these two steps, therefore
they disagree* — was sound and wrong.

### 3.2 What the traces do say: the model merges two events the gold counts separately

Reading the twelve raws rather than counting their lines:

```
[0a995998] gold 3, answered 2
  Step 1 — - Navy blue blazer (dry cleaning pick up) — Session 12
           - Boots from Zara (exchanged, need to pick up the larger size) — Session 20
           - Boots from Zara (exchanged on 2/5, still need to pick up the new pair) — Session 31
  Step 2 — The blazer is dry cleaning (pick up), and the Zara boots appear in two sessions but
           refer to the same exchange/pickup event. Distinct items: 1 blazer + 1 pair of boots = 2.
```

Three items listed, two counted, one sentence of justification. The gold counts three. The model
**de-duplicated across sessions** — and the ask's contract is what licenses it:

> Step 1 — list every item in the evidence that matches the question … **Treat one event mentioned in
> several turns as one item, and do not merge two items into one.**

Two clauses, and the first one wins when an event is mentioned in two sessions with different
wording. `10d9b85a` shows the same shape without the de-dup sentence: gold "3 days", answered 2, and
its single list item is *"2-day workshop attended on the 17th and 18th of April"* — two days
aggregated into one item before Step 2 was reached.

**Measuring it across the arm, in the reader's own words**, with the model's echo of the instruction
itself removed first (one of the twelve quoted the sentence back, which would otherwise have counted
as a merge):

| population | carries merge / de-dup language | rate |
| --- | --- | --- |
| exactly-one-low failures (n = 12) | **5** | **41.7%** |
| correct answers (n = 84) | 4 | 4.8% |

Fisher exact, two-sided: **p = 0.0012**.

**What that is and is not.** It is an association between a sentence in the output and the outcome,
not a manipulation — the sentence could be a rationalisation written after the count rather than the
cause of it. It is also the first MR finding in this repository that is *specific enough to be wrong*:
it predicts that a contract which forbids merging across sessions without a shared citation moves
these five, and that the seven without merge language do not move at all.

**And its ceiling is small.** Five questions, on an arm whose four genuine repeats span fifteen
(§2.1). A five-question marginal effect is inside a fifteen-question marginal range, so this is
measurable only as a **paired** comparison over the same 500 questions — which is what `paired-test.ts`
exists for, and which is why the next MR change should be registered with a discordant-pair criterion
rather than a marginal one.

### 3.3 What is *not* the cause, eliminated by measurement

- **Prompt dilution.** `promptChars` median is 46,200 for correct answers and 46,173 for wrong ones
  on MR; 47,130 against 47,188 on TR. The budget binds identically on both populations, so "too much
  evidence" does not separate them.
- **The 400-character turn cap.** §1.2: the answer phrase starts past the cap in 4 MR questions and 0
  TR questions.
- **Ranking.** `goldOverlap.pool` is non-zero for every question and `carried > 0` for every question.
  There is no rank at which gold is missing.
- **The abstention gate's threshold.** `decisionReasons.threshold: 0` — no decline is the gate's.
- **A Step 1 list one item short.** §3.1, measured and dead.

## 4. What this reframes

**The MR experiment that is running now tests a retrieval change on an arm whose retrieval is
saturated.** `retrieval-session` can still move MR, but not by finding gold it was already finding;
its only route to an effect is *budget allocation* — which of the other turns occupy the 48,000
characters around the gold. That is a legitimate mechanism and it is the one the reference pipeline
differs by, but the registration's own framing ("the operation `reference-pipeline` performs and this
arm cannot") overstated it: the reference pipeline's advantage is not recall, because we have recall.
**Prediction P2 stands as registered; its stated rationale does not**, and that correction is
recorded before the result is read rather than after.

**The reference pipeline's 102/121 is not a retrieval result.** Both arms carry gold. Whatever the
baseline does better is done to the reader or to the arrangement of the room, and 18 questions is
what it is worth. That makes the gap *smaller in mechanism-space* than it looked — one lever, not two
— and it is why §7 ranks by population rather than by evidence strength.

## 5. Two instrument gaps, and what closing them would cost

1. **No per-question records for the baseline arm.** `ablation.baseline` carries aggregate metrics
   only, so a paired comparison can compute a p-value over outcomes but cannot ask *why* the two
   arms differ on a specific question. Recording them costs one array in the artifact and no model
   call; it is not done here because the artifact is also the evidence archive and its size is
   already 50 MB.
2. **No field for what survived the cap.** §1.2's first item. `evidenceChars` and `carried` exist;
   a per-turn `renderedChars` would make "the cap cut the answer" a count instead of an inference.
   This is the same class as the two instrument defects the project has already found (a report that
   named neither of its two systems; a cache that named no model), and it is recorded rather than
   fixed because nothing in this round depends on it.

## 6. Where this leaves the numbers

| | value | source |
| --- | --- | --- |
| `cortex-memory` end to end | **404/500 = 80.80%** | `40088479628` |
| failures | **96** | above |
| reader declined | **45** | §2 |
| reader answered wrong | **51** | §3 |
| failures attributable to missing evidence | **0** | §1.1 |

## 7. What the next change has to clear, and why the bar moved

Three candidate mechanisms came out of this measurement, and each has a ceiling that can be stated
before a dispatch:

| candidate | population it addresses | ceiling | measurability at n=500 |
| --- | --- | --- | --- |
| forbid cross-session merging without a shared citation (§3.2) | 5 MR | **+5** | paired only — 5 is inside the 15-question marginal range (§2.1) |
| extend `reviewPass: recover` to `temporal` and `flat` (§2.1) | 33 declines, ~1/10 convert | **+3** | paired only |
| a contract for hedged-but-sufficient evidence (§2) | up to 45 declines | unknown | paired, and the biggest of the three |

**The bar is the discordant pair, not the marginal total.** `paired-test.ts` computes an exact McNemar
over the same 500 questions, so a change that wins 12 and loses 5 is significant even though its
+7 is inside the 15-question marginal spread. Every one of these has to be registered that way —
`MEASURE-MR-UNITS.md` §2 already shows what happens otherwise: prediction 2 failed on a
character-identical reproduction requirement that `runs=1` could not satisfy, and the failure carried
no information.

With that instrument, the budget for a round is a discordant count rather than a percentage. The
exactly-one-low population is 12, so no fix aimed at it can produce more than 12 discordant wins;
the decline population is 45, which is the only one of the three large enough to change the headline.

**So the ordering is by population, and it points at the declines.** Not because the merge finding is
weaker — it is the better-evidenced of the two — but because it caps at 12 questions while the
headline is 96 failures, and 45 of those are the same event: the reader declining on evidence the
prompt contains.

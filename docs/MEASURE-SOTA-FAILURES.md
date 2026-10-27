# MEASURE-SOTA-FAILURES

Where the 96 misses on the `cortex-memory` arm actually are, measured from run `40088479628`'s
per-question records rather than argued from capability totals.

## 0. One paragraph

On the arm that ships, **the gold turn reaches the rendered prompt for 500 of 500 questions**
(`goldOverlap.carried > 0` everywhere, `pool = 0` nowhere). Retrieval on this arm is not the
bottleneck, and no retrieval experiment can recover the 96 misses by finding evidence it already
found. Of the 96, **45 are the reader declining** on evidence it was given and **51 are the reader
answering wrong**. And the declines are mostly **one response shape**: 21 of them are a bare
`INSUFFICIENT_EVIDENCE` with nothing around it, on routes whose ask already calls that an invalid
response — while **29 of `ABS`'s 30 correct answers are that same bare token**. So the single largest
failure source on the best arm this repository has is a shape that is *optimal* on the one capability
that grades it and unpunished on the four that do not. Two shapes account for most of the rest:
**12 of MR's 37 misses answer exactly one lower than gold**, and TR's remaining declines read a hedge
word in the evidence as a disqualifier.

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

## 2. The largest single source, and it is one response shape

Forty-five of ninety-six. By route:

| capability | declined | share of that capability's misses |
| --- | --- | --- |
| TR | 21 | **64%** |
| IE | 12 | 75% |
| MR | 10 | 27% |
| KU | 2 | 20% |

The gate itself is not at fault: `decisionReasons` reads `{empty: 0, threshold: 0, llm: 75}`, so not
one of the 75 declines is a gate firing on an empty or low-scoring pool. Every one is the model's.

### 2.1 The shape, and what this measurement adds to what was already known

**The bare token is not a new observation and must not be presented as one.** `PREREGISTRATION` §13.22.6
already tabulated it per capability on an older configuration (TR 36 bare of 51 abstentions, MR 21 of
24), and the 120-question reading behind §13.22 recorded 116 of 120 outputs as a bare token across
five capabilities. `tools/classify-raw-outputs.py` is the shipped classifier that produces those
counts, and running it on this artifact reproduces the numbers below **to the case**.

What is new here is three things, and only three:

1. **All five capabilities in one run, including `ABS`.** `ABS` is the control the earlier tables did
   not carry beside the others, and it is what turns "the declines are mostly bare" into an argument:
   the bare token is **correct** there.
2. **`IE` at 12 of 12.** The earlier per-capability tables covered TR and MR; IE's declines are the
   same shape, plus a gold-shape fact §2.5 records.
3. **The retry attribution in §2.3** — that nine of MR's ten recorded declines are the recovery pass's
   *second* answer, which no field declares.

Stripping the token and measuring what is left:

| capability | declines | **bare token** (≤ 40 characters left) | does that route run a recovery pass? |
| --- | --- | --- | --- |
| IE | 12 | **12** | no (`flat`) |
| KU | 2 | 0 | no |
| MR | 10 | **9** | **yes** (`reviewPass: recover`) |
| TR | 21 | **9** | no (`temporal`) |
| **ABS (correct declines)** | **30** | **29** | no |

**`ABS` is the control, and it is the whole argument.** The thirty false-premise questions are the
only population where a decline is the right answer, and **29 of their 30 answers are the bare
token** — `tools/classify-raw-outputs.py` on this artifact: `ABS bare 29, prose-then-token 1`. That is
not a coincidence; it is what the contract rewards. `ABS` reads 30/30.

The same shape, on the four capabilities whose gold is never a decline, produces **30 failures**.
So the reader has learned one move — emit `INSUFFICIENT_EVIDENCE`, stop — and that move is optimal
exactly where it is graded and unpunished exactly where it is not:

> **A bare decline is the one response shape that scores 30/30 somewhere in this benchmark and
> scores zero everywhere else.**

### 2.2 The instruction that forbids it exists, and is violated 21 times

The `enumerated` ask, which reaches `flat`, `multi-session` and `temporal`, already says:

> Do not reply `INSUFFICIENT_EVIDENCE` without first writing the Step 1 list: **a bare
> `INSUFFICIENT_EVIDENCE` with no list is not a valid response.**

It is stated, and 21 first-attempt answers on the two routes that never retry (IE 12, TR 9) are
exactly the thing it calls invalid. **An instruction with no mechanical consequence is advice** —
this repository's own repeated finding — and here the consequence-free instruction is measured
against 21 violations.

### 2.3 The only remediation is blind to most of it, and its own retries are bare

`planAbstentionRecovery` retries a decline that contradicts its own Step 1 list. It is wired into one
call site:

```
$ rg -n "planAbstentionRecovery" packages/cortex-memory/src/memory.ts
# one call site, inside #promptSessionAware
```

So it reaches `multi-session` and nothing else. Three facts then line up exactly:

| | value |
| --- | --- |
| `recovery: {attempted, answered}` | **10, 1** |
| MR declines | 10 |
| MR declines that are bare tokens | **9** |

**Ten attempts, one conversion, nine bare retries.** The pass is handed the reader's own list, quotes
it back, and the reader declines again — with the same bare token. So on this artifact the recorded
`rawOutput` for those nine questions is **the retry's output, not the first attempt's**, because
`memory.ts` keeps the last reply on purpose ("the last thing the reader said about this question is
the more informative of the two declines"). That is a defensible choice and it has a cost that
nothing in the record discloses: **the first attempt's shape is unrecoverable for any question the
pass touched.** §5 counts it as an instrument gap.

Two readings of §2.1's 21, and the honest one is the second:

- *Extend the pass* to `temporal` and `flat`: 33 untried declines at MR's measured 1/10 is **+3**, and
  MR's own retries are bare — so the pass's prompt does not fix this shape either. **+3 against a
  15-question marginal range is not measurable without pairing**, and the prior says it stays +3.
- *Forbid the shape*: on the four capabilities whose gold is never a decline, a bare token is a
  **format violation**, and this repository already has a precedent for that — a reply in the wrong
  shape gets one corrective consultation. That pass targets *the shape*, not the content, so it is
  not blind to a reply that has no list to quote. **Population: 21 first-attempt + 9 retry = 30.**

That is the registrable mechanism, and it is a parse-level constraint rather than a wording change,
which is what the project's own rule requires. **The mechanism is registered here; the change is not
made in this round**, because the shapes have to be counted before they are changed and because
`40498191604` is still measuring a different intervention on one of these routes.

### 2.4 The secondary shape, on TR only

TR's twelve *reasoned* declines — 11 `prose-then-token` plus one `other`, per the classifier — share
one pattern, and it is worth naming because it is a different defect:

```
Let me search the evidence for two charity events on consecutive days.

- Feb 14 (Tue) 09:06: "just got back from the '24-Hour Bike Ride' charity event, where I cycled
  for 4 hours non-stop" — charity event on Feb 14 (or just before).
- Feb 15 (Wed) 08:39: "I participated in the 'Ride to Cure Cancer' charity bike ride and rode
  40 miles on my road bike recently" — but "recently," not necessarily consecutive.
- Mar 19 (Sun) 15:02: "the 'Walk for Hunger' event I did today" — charity walk on Mar 19.

The clearest consecutive-day pair: Feb 14 ... and Feb 15 ... But Feb 15's ride is described as
```

The reader found the two events, ordered them, and declined **because one carried the word
"recently"**. Measured across the population: **8 of TR's 21 declines** contain a hedge word
(`recently`, `about`, `around`, `a few`, `probably`, `might have`) — and **0 of IE's, KU's or MR's**
do. So this is a TR-specific shape, at most 8 questions, and it is *not* the larger problem.

### 2.5 IE's twelve declines are a question shape, not a reasoning failure

Ten of IE's twelve declined questions carry a gold that begins **"The user would prefer …"** — they are
`single-session-preference` questions, and the question text asks for a recommendation:

| question | gold |
| --- | --- |
| "Can you recommend some recent publications or conferences that I might find interesting?" | "The user would prefer suggestions related to recent research papers …" |
| "Can you suggest a hotel for my upcoming trip to Miami?" | "The user would prefer suggestions of hotels in Miami that offer great views …" |
| "How much is the painting of a sunset worth in terms of the amount I paid for it?" | "The painting is worth triple what I paid for it." |

Sixteen of IE's 134 *correct* answers are preference-shaped too, so the shape is answerable — but the
twelve that fail do so with a bare refusal, and the first one is a two-word lookup ("What breed is my
dog?" → "Golden Retriever") whose gold turn was carried 12 of 12.

So IE's declines are not "the preference route is broken". They are the same bare-token reflex landing
on questions where an evidence-QA contract has no instruction for *"suggest something"* — the contract
says answer from the evidence, and a recommendation request does not read like a question about the
evidence. That is a distinct repair from §2.2's format constraint and is recorded rather than merged
into it.

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
   named neither of its two systems; a cache that named no model).
3. **No field for the first attempt.** `rawOutput` is the *last* reply, so any question the recovery
   pass touched reports its retry. §2.3 is the arithmetic proof — `attempted 10, answered 1` and nine
   bare MR declines cannot both be true of first attempts when the module's own census says the first
   attempts carried lists. `firstRawOutput` would make "what did it say before we corrected it" a
   field instead of a subtraction, and the subtraction is only available because two unrelated
   counters happen to line up.

## 6. Where this leaves the numbers

| | value | source |
| --- | --- | --- |
| `cortex-memory` end to end | **404/500 = 80.80%** | `40088479628` |
| failures | **96** | above |
| reader declined | **45** | §2 |
| — of which a bare token | **30** (21 first attempt, 9 retry) | §2.1, §2.3 |
| reader answered wrong | **51** | §3 |
| failures attributable to missing evidence | **0** | §1.1 |

## 7. What the next change has to clear, and why the bar moved

Three candidate mechanisms came out of this measurement, and each has a ceiling that can be stated
before a dispatch:

| candidate | population it addresses | ceiling | measurability at n=500 |
| --- | --- | --- | --- |
| **forbid the bare token on the four routes whose gold is never a decline** (§2.2) | **21 first-attempt + 9 retry = 30** | **+30** | paired; the largest population available anywhere in this measurement |
| forbid cross-session merging without a shared citation (§3.2) | 5 MR | +5 | paired only — 5 is inside the 15-question marginal range (§2.3) |
| extend `reviewPass: recover` to `temporal` and `flat` (§2.3) | 33 declines, ~1/10 convert | +3 | paired only, and its own retries are bare, so the prior says +3 |
| a contract for hedged-but-sufficient evidence (§2.4) | 8 TR | +8 | paired |

Note what changed here: the first draft's top candidate was "a contract for hedged evidence", sized
"up to 45". The measurement cut it to **8** — the hedge word is a TR-only shape — and promoted a
candidate that had not been on the list at all, because the declines turned out to be one response
shape rather than forty-five reasons.

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

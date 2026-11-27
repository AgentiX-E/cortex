# Pre-registration: spending the room the prefix rule returns

**Status:** decided — run `45923435343`. `P2` holds, `P3` fails (net 0, twelve discordant pairs each way),
`P4` holds on tokens (1.0164), and `P1`'s shape is **falsified**: §10 reads the 63 MB artifact and finds
418 up / 72 level / 10 down against a predicted 215/285, because the census that sized the arm was taken
at `resolution: raw` and this run declared `layered`. §9 is the accuracy reading, §9.2 retires the
implication that made this arm look worth buying, and §10.5 declines the adoption on that basis.

Written before dispatch. The arithmetic it is conditioned on is `MEASURE-UNSPENT-ROOM.md`; the
refutation it repairs is run `38753835652`, recorded in `prompt.ts` at `selectBySessionFill`.

## 1. Treatment, byte for byte

One arm option changes and no other:

| input | shipped | this run | why |
| --- | --- | --- | --- |
| `cortex_memory_relevance_units` | `turn` | **`turn-fill`** | the same unit and the same ranking, spending the room on the next turn that fits |
| `cortex_memory_max_prompt_chars` | registered table | *unchanged* | 48,460 / 24,000 is the room the hole was measured in |
| `cortex_memory_max_turn_chars` | `400` | *unchanged* | the cap that makes the hole small on two routes and large on four |
| marker segment | `none` | *unchanged* | converts wrong answers into declines on four capabilities that do not grade abstention |
| window segment | `head` | *unchanged* | the window and the marker are one indivisible change; neither is this arm |
| everything else | shipped | *unchanged* | the dispatcher names the remaining inputs from the baseline |

### 1.1 Two things this section got wrong, and what fixed them

**The instrument did not exist.** The paragraph below used to read "the arm is the full 500 questions
with both sides in one job … so the comparison is this dispatch's own baseline side", and no such
instrument could be built: `CORTEX_MEMORY_AB` had five values (`reference`, `carry`, `clock`,
`resolution`, `ask`) and none of them put two **evidence units** in one job. `relevanceUnits` was read
from the dispatch inside the constructor, so both sides selected by the same unit — which means this
pre-registration described a reading it had no way to take, the same way
`PREREGISTRATION-RESOLUTION-LAYERING.md` described one for nine rounds. `arm-pairing.ts` now carries a
sixth value, `units`, and `run-ablation.ts`'s `buildPairBaseline` builds its control as
`{ ...armTreatment, units: 'turn' }`. Two consequences are worth stating because they are not
cosmetic:

* the pairing is **not** a second treatment. It names which two sides exist; the treatment is still
  exactly one unit, and `pairingViolation` refuses `pairing=units` with `turn` on the feature side,
  because that run would put the same unit on both sides and publish a null for a comparison in which
  nothing differed;
* the unit now travels in `ArmTreatment` rather than as a resolved value beside it, so every branch of
  `buildPairBaseline` reaches the constructor through one function (`relevanceUnitOption`) instead of
  two. A unit the forwarding table does not know still throws before a dataset is opened.

**The repetition count was left implicit.** The shipped value is `ablation_runs: 4`; this dispatch takes
**1**, and the table above did not say so. It is a departure from the registered configuration and it is
recorded here rather than discovered in the artifact:

| input | shipped | this run | why |
| --- | --- | --- | --- |
| `ablation_runs` | `4` | **`1`** | the rejection region of `P3` is three questions, and a paired comparison holds every other question fixed by construction. §6 prices the second pass and §5 says when it is taken. |

`MEASURE-SPEND-MINIMUM.md` §206.2 is the arithmetic: four repetitions buy variance reduction on a
metric whose noise floor is five questions, and this arm's quantity is a **paired** movement on a named
population of 215, not an absolute accuracy. The saving is 3/4 of the bill — **10.69 CNY** — which is
more than the entire remaining queue.

The arm is therefore the full 500 questions with both sides in one job, the pairing invariant of
`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §2.2, so the comparison is this dispatch's own baseline side
rather than an archived run from another day. **One pass**, priced in §1.2.

### 1.2 The bill, before it is spent

| quantity | value | how it is derived |
| --- | ---: | --- |
| question-runs | 500 | 500 questions × 1 pass; both sides are inside one pass, so the side count is not a multiplier |
| rate | 0.00713 CNY | `MEASURE-SPEND-MINIMUM.md` §206.1: `14.26 / (500 × 4)` on `42467` — the file rate, not the `MR` rate |
| projected bill | **3.57 CNY** | 500 × 0.00713 |
| label | `extrapolated` | a configuration `42467` did not run, at or below its repetition count. Not `billed` and not `proxy` |
| probe | the published artifact | `MEASURE-UNSPENT-ROOM.md` is the probe and it cost nothing: it falsifies the upper bound (215 questions, 10 wrong) before the reader is called. `P1` is the in-run probe for the mechanism having fired at all |

At 3.57 CNY the row does not reach the 10 CNY threshold that `guard:queue-price` prices a probe
against, and it carries one anyway. The probe it carries is unusual and better than a discount: the
population is **already known**, so a dispatch that spends the room and changes no answer is a
registered outcome (`P3`'s floor) rather than a failed experiment.


## 2. Population, and the number that is already known

This arm has an unusual property: **its ceiling is arithmetic, not a hypothesis.** Once the room is
fixed, the most a fill can add is the room that was previously returned, so the reachable gold is
computable from the published artifact before spending anything. On `45760081761`, over the 330
questions with a gold segment missing:

| route | questions | wrong | slack mean | gain gold | of them wrong | all of it | of them wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `multi-session` | 14 | 3 | **107** | **0** | **0** | 0 | 0 |
| `temporal` | 88 | 6 | 119 | 16 | 0 | 4 | 0 |
| `abstention` | 29 | 0 | 975 | 23 | 0 | 0 | 0 |
| `knowledge-update` | 71 | 5 | 1,346 | 66 | 4 | 0 | 0 |
| `assistant` | 32 | 1 | 1,494 | 28 | 1 | 17 | 1 |
| `flat` | 90 | 6 | 1,404 | 79 | 5 | 9 | 0 |
| **all** | **330** | **21** | **950** | **215** | **10** | **31** | **1** |

**`multi-session` is registered as a null by construction.** Its slack is 107 characters against a
400-character turn cap, so the fill cannot buy one segment there and any movement on that route is
noise or a defect rather than an effect. That matters because `multi-session` is where 13 of the
arm's 14 decision faults live and where `MR`'s 88.43% is decided: **this arm is not an `MR` arm and
`MR` is not its target.**

## 3. The prediction

**`P1` — the mechanism fires.** On the **215** questions the census names, `promptChars` rises; on the
**285** it does not name, `promptChars` and `promptDigest` are identical to the baseline side. This is
the primary claim, and it is the one this arm exists to settle: the unit was unreachable on five of six
routes until `buildPrompt` forwarded `relevanceOptions` this round, and a dispatch that changes nothing
is the §13.32 defect — a configuration recorded on the artifact that the prompt never received — which
this repository has already produced once with `session-fill`.

**`P2` — accuracy is non-inferior, on every capability.** No capability loses **3 or more questions**,
and the aggregate is **≥ −2 questions**. This is a floor rather than a target, and the reason is
measured: on this artifact a question with an absent gold reads **93.64%** against **91.76%** for one
whose gold arrived whole, so "more gold delivered" is not "more answers right" and the reachable
population of **10** wrong questions is an upper bound on an effect, not a forecast of one. A fill
that delivers more text and answers fewer questions correctly is the outcome the §13.72 precedent
(+13 `MR`, −30 `IE`) says is paid for elsewhere.

**`P3` — the reachable ten convert at a measurable rate.** **≥ 3 of the 10** reachable wrong questions
change to correct. Ten is the ceiling; three is the smallest movement that could be distinguished from
the ±2-question spread the arm shows between repetitions at this population. A reading below three with
`P1` and `P2` both holding is a **registered non-inferior change with no accuracy claim**, adopted for
the room-honesty reason and never cited as a score.

**`P4` — the bill does not move.** Total cost within **1.02×** the baseline side, and median
`promptChars` up by **no more than the slack it spent** — `313,372 / 500 = 627` characters per question
on average at most. A bill that rises more than 2% means the arm is backfilling from the pool rather
than from the room, which is a different mechanism and would have to be registered as one.

## 4. Controls and gates

| gate | condition | what a breach means |
| --- | --- | --- |
| **internal control** | on `multi-session`, `promptChars` rises by **≤ 108** characters on every question, and `carried` never gains a turn | the fill reached room the cap had already removed, which cannot happen — void, and a defect |
| **superset** | no question delivers **fewer** gold turns than the baseline side | the superset is a proof (`MEASURE-UNSPENT-ROOM.md` §3), so a counterexample is a code defect, not a reading |
| **cost** | bill ≤ **1.02×**; mean `promptChars` up ≤ **627** characters | the arm is backfilling rather than spending the room |
| **population** | the treatment side's `promptChars` rises on **≥ 200** of the 215 named questions | the census and the run disagree about which questions have slack |
| **guard** | no other capability drops 3 or more questions | §13.72 |

The **superset** gate is the one that makes this dispatch cheap to read: it is the only arm in this
campaign whose null hypothesis is a theorem, so a breach is a bug report rather than an argument.

## 5. Falsification

Any one of these closes the axis rather than inviting a second room experiment:

1. **`promptChars` unchanged on the named questions.** The unit did not reach the prompt. Void, and the
   defect is in the forwarding rather than in the rule — the same shape as `session-fill`'s missing
   row, and it would be found in `buildPrompt`'s plan rather than in `selectByTurnFill`.
2. **A question delivering fewer gold turns than the baseline.** The superset proof is falsified, which
   is a bug; the axis stays open and the bug is the finding.
3. **Any capability ≤ −3 questions, or the aggregate ≤ −3.** Rejected even if another capability gains,
   on the §13.72 precedent. The axis closes and the next candidate is the **per-question room**
   (`gap` has a median of 14 and a maximum of 50 over the 21, so a single route-wide number cannot
   close it) rather than the selection rule.
4. **Bill above 1.02×.** The arm is not spending the room; it is buying more. The unit stays unadopted
   and the next step is to find what took the room.

## 6. What is deliberately not in this dispatch

- **The room.** Every `max_prompt_chars` change moves the quantity this arm holds fixed, and
  `MEASURE-UNSPENT-ROOM.md` §6 is why the two must be read in this order: the registered 5.81 CNY row
  is a *buy*, and buying before spending is what §204.7 priced at 70–100 CNY for a plan nobody would run.
- **The unit.** `session-fill` stays frozen beside `session` and this arm does not touch either — the
  session boundary is absent on five of six routes and mixing the two units would make the delta a
  statement about two changes.
- **`multi-session`.** Not a target, and §2 registers it as a null. `turn-fill` gains nothing there
  by construction and a positive reading would be a defect.
- **A second repetition.** The rejection region of `P3` is three questions; a paired comparison at one
  pass holds every other question fixed by construction, and `MEASURE-SPEND-MINIMUM.md` §206.2 is the
  arithmetic for why the second pass buys variance reduction on a metric whose noise floor is five
  questions. Two passes are taken only if `P3` lands **exactly** on three.

## 7. Adoption path (decided now, so it cannot become a later argument)

If the reading passes §4 and survives §5:

1. `turn-fill` becomes the registered unit in `tools/arm-config-baseline.json`, and
   `pnpm guard:arm-config` is re-run so the shipped configuration and the baseline file cannot drift;
2. the product default in `packages/cortex-memory/src/assemble.ts` moves with it, because the
   evaluation-side configuration and the product-side default are one decision and §16 of the standing
   instruction is the rule that says so;
3. `MEASURE-UNSPENT-ROOM.md` §7's "unknown" row becomes measured, and the census in
   `tools/turn-fill-ceiling.mjs` is re-run against the new artifact so the two agree;
4. `SOTA-BASELINE.md` §0 takes a new number only from a full 500-question run, never from this arm's
   delta.

If `P1` and `P2` hold but `P3` does not, `turn-fill` is adopted for the **room-honesty** reason only:
the arm pays for the room and a rule that returns part of it unread has to justify returning it. That
adoption carries no score claim and the registry row says so.

Nothing about accuracy is adopted from this document. It is adopted from the artifact.

## 8. Dispatch record

| field | value |
| --- | --- |
| run | `45923435343` |
| dispatched | 2026-11-27T01:35:33Z |
| commit | `daeb72dc` |
| dispatcher | `tools/dispatch-cortex-memory-ab.py --set cortex_memory_relevance_units=turn-fill --set ablation_runs=1 --budget 5` |
| pairing | `CORTEX_MEMORY_AB=units` (written by the dispatcher, reset to `reference` by the next one) |
| declared departures | `ablation_runs`, `cortex_memory_relevance_units`, `resolution` |
| projected bill | **3.57 CNY** at 500 x 1 |

Three things about the dispatch itself are readings rather than procedure:

**The projection agrees with itself from two directions.** §1.2 prices the row at `500 x 0.00713 = 3.57`
from the file rate in `spend-baseline.json`; the dispatcher's own token-level projection -- 6.54M cached
input at 0.20, 0.27M uncached at 2.00, 0.57M output at 3.00 -- lands on the same 3.57. Those are two
independent paths (a bill divided by question-runs, and a token census priced at list), and the fact that
they agree is worth recording precisely because `MEASURE-SPEND-MINIMUM.md` §206.5 says they usually do
not: a rate rebuilt from `llmUsage` at list price came out 2.4x to 5.1x the money actually spent on
`42467`, because 96.0% of its prompt tokens were prefix-cache hits. Here the projection *starts* from the
cache split, which is why it lands on the bill instead of far above it.

**The first dispatch was refused by the budget, and the refusal was correct.** The dispatcher's default
ceiling is 3.00 CNY, the projection was 3.57, and it stopped. `--budget 5` was passed deliberately rather
than raising a default, so the number that authorised the spend is in the command that made it.

**A first attempt failed at the registration gate before spending anything.** Run `45922781800` was
dispatched through the raw workflow API with four inputs, and the preflight refused it on two counts:
`cortex_memory_max_prompt_chars` was absent (the raw API sends the default empty string, and an empty
budget map is not the registered arm) and `cortex_memory_relevance_units` was an undeclared departure.
Both are `tools/dispatch-cortex-memory-ab.py`'s job -- it sends all 24 registered inputs and writes the
departure list it computed. The cost of that lesson was zero, which is the point of a preflight that runs
before `Setup pnpm`.

## 9. Result — the room was spent, and nothing moved

Run `45923435343`, read at 2026-11-27T02:35Z. Twenty steps green in 51m57s. The configuration reached:
`config.relevanceUnits` is `turn-fill` on the artifact, and both sides came out of one job.

| side | all | IE | MR | KU | TR | ABS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| control (`turn`) | **467 (93.40%)** | 142 | 108 | 67 | 120 | 30 |
| feature (`turn-fill`) | **467 (93.40%)** | **145** | **109** | **65** | **118** | 30 |
| **delta** | **0** | **+3** | **+1** | **−2** | **−2** | 0 |

McNemar exact: **b = c = 12, p = 1.0**.

### 9.1 The four predictions

| | verdict | evidence |
| --- | --- | --- |
| **`P1`** the mechanism fires | **partly** | `config.relevanceUnits = turn-fill`, and **12 questions flipped at temperature 0** -- the same prompt must produce the same answer, so the prompt differed on at least those twelve. The *shape* `P1` names (215 questions up, 285 byte-identical) needs per-question `promptChars`, which lives in the 60 MB `longmemeval-s-report` artifact and was **not read this round** |
| **`P2`** non-inferior | **holds** | the largest single-capability loss is **2** (KU, TR), under the rejection region's 3; the aggregate is 0, above −2 |
| **`P3`** at least 3 of the reachable ten convert | **fails** | net movement is **0**. Even if three of the ten converted, three others moved the other way: 12 discordant pairs each direction. This is §13.72's shape at a smaller scale -- `+13 MR / −30 IE` was the precedent, this is `+3 IE / −2 KU / −2 TR` |
| **`P4`** the bill does not move | **unread** | `llmUsage` is in the same 60 MB artifact, and the provider-cost step's log is not reachable from this sandbox. Both are the next round's first task |

### 9.2 What the null means, and it is worth more than a win

§208's finding was that a third of the paid-for room was returned unread, and the implicit expectation was
that reading it would help. **This reading says: it was read, and nothing moved.** 313,372 characters of
empty room were filled, twelve questions flipped, twelve flipped back, net zero.

That is a stronger statement than "the fill did not help". It says the text in that room has **no marginal
value to this reader** -- not that it was sent to the wrong place, but that it is not worth sending.

Two consequences, and the first is the reason this section exists:

* **`MEASURE-UNSPENT-ROOM.md`'s implication is retired.** The room is not a lever. The census that sized the
  hole was a *supply* measurement and it was correct; what it could not say, and this dispatch now does, is
  that the demand side is flat.
* **The queue's row 1 is demoted rather than deleted.** "Rerun per-route room on `verbatim-acts`" (5.81 CNY)
  buys **more** room. If the room already paid for has no marginal value, more of the same has less. That is
  an inference and not a measurement, which is exactly why the row moves to the back of the queue instead of
  out of it -- the cost of demoting it is zero.

### 9.3 Adoption, by §7's own rule

§7 says a reading that holds `P1` and `P2` but fails `P3` is **"adopted for the room-honesty reason only:
the arm pays for the room and a rule that returns part of it unread has to justify returning it. That
adoption carries no score claim and the registry row says so."**

The condition is met, and the adoption is now a choice rather than a consequence: spending the room costs
zero tokens and moves no accuracy, so the argument for `turn-fill` is that leaving bought room unread is a
rule that needs justifying, not that filling it earns anything. **No accuracy is adopted from this run.** The
published number stays 93.40% and the registry row for `turn-fill` records `P3` as failed.

The adoption is **not** performed in this round, and that is deliberate: `P1`'s shape is unverified, so
"the mechanism fires on five of six routes" is still a claim about `buildPrompt` rather than a reading. Doing
the config change and the shape measurement in the same round is how a registry row ends up describing an
intent. The next round reads the 60 MB artifact, and the adoption follows that.

### 9.4 Three things still unread, named so they are not mistaken for done

1. **`P1`'s 215/285 split.** Needs `longmemeval-s-report` (60 MB; about 100 minutes at this proxy's 10 KB/s).
   It does not change `P2`'s verdict. It does decide *which routes* the mechanism reached, and therefore which
   route a future room experiment would have to be run on.
2. **`P4`'s bill.** One `llmUsage` line, in the same artifact.
3. **The superset gate.** §4's only theorem-shaped assertion. A counterexample is a bug report rather than a
   reading, so leaving it unread leaves the one claim that could turn this null into a defect unexamined.

**Spend: 3.57 CNY**, the only paid action this round, and the first dispatch where §1.2's file-rate projection
and the dispatcher's token-level projection both landed on the same number.

## 10. The shape, read from the artifact

§9.4 named three unread things and priced the reason: the artifact carrying them is 63.2 MB and the
sandbox moved it at 25 KB/s, which is **26 minutes 41 seconds** for four hundred kilobytes of integers.
That is the instrument being the bottleneck for the third time in this campaign, so this round built the
instrument instead of waiting on the transfer: `tools/pair-shape-readout.mjs` (`guard:pair-shape`) reads
any pair report in 0.8 s, and `.github/workflows/pair-shape-readout.yml` runs it on a runner where the
artifact is one API call away.

| reading | value |
| --- | ---: |
| compared | 500 |
| **rose / level / fell** | **418 / 72 / 10** |
| characters added | **+350,852** |
| mean / median / max delta | **+701.7** / +212 / +13,817 (`b86304ba`) |
| bill, treatment over control | **1.0164** |

By route, characters added: `flat` +129,916 · `knowledge-update` +94,810 · `assistant` +75,042 ·
`abstention` +28,161 · `temporal` +13,700 · **`multi-session` +9,223**.
By capability: `IE` +204,958 · `KU` +94,810 · `ABS` +28,161 · `TR` +13,700 · **`MR` +9,223**.

### 10.1 `P1`'s shape is falsified, and the census is why

`P1` predicted **215 up and 285 byte-identical**. The artifact reads **418 up, 72 level, 10 down**. The
volume is wrong in the same direction: `turn-fill-ceiling.mjs` sized the unspent room at **313,372**
characters across the arm, and the fill spent **350,852** — 12.0% more room than the supply measurement
said existed.

The fill is not what is wrong. The ceiling was computed on an artifact at `resolution: raw`; this run
declared `resolution` as a departure and ran `layered`, which prints a long turn as a window around the
match or as one line of its opening, and therefore fits more turns into the same room. **A supply
measurement is a property of a configuration**, and this one was carried across a configuration change
that the same pre-registration's own §1 table records. It is §13.278's shape for the fourth time: a stale
premise with a number attached, and the number is exactly why nobody re-derived it.

### 10.2 Where the room went, which is the reading the null needed

93.5% of the 350,852 characters landed on the four routes with room to spare — `flat`, `KU`, `assistant`,
`abstention`. **2.6% landed on `multi-session`**, the route the arm was aimed at, where the room is already
full and a filling rule can only re-cut it.

That is the mechanism behind `P3`'s failure, and it is not a criticism of the selector: the fill did what
it promised, on every route, and the route that needed it had nothing left to sell. The queue's demotion of
"rerun per-route room" (§9.2) survives this, and now it has an arithmetic reason rather than an inference.

### 10.3 Two gates breached, and what each of them means

| gate | registered | observed | reading |
| --- | --- | --- | --- |
| **internal control** | rises ≤ **108** on every `multi-session` question, never falls | rises up to **+326** (`gpt4_194be4b3`), **seven falls**, largest **−114** (`8cf4d046`) | the 108 is the census's estimate for a configuration this run did not run (§10.1) |
| **cost: bill** | ≤ **1.02×** | **1.0164** | holds |
| **cost: prompt growth** | mean up ≤ **627** | **701.7** | the 627 is `313,372 / 500`, i.e. the same stale census divided by the population |
| **population** | rises on ≥ 200 of the 215 named | **418 of 500** | necessary and not sufficient; the 215 are not on the artifact |
| **guard** | no capability drops 3 | largest drop **2** (`KU`) | holds |
| **superset** | no question delivers fewer gold turns | unreadable | the control side records its prompt *length* and not the turns it delivered |

**The seven falls are not explained by a stale bound, and they are registered open.** The containment
theorem is about the **carried set**; what the artifact records for the control side is a **length**. Under
a capped, layered rendering the same room can buy more turns and less text, so characters are not monotone
in the carried set — which is a statement about the rendering rather than about the containment, and the
two are being separated rather than conflated. The discriminator is named: the same pair at
`resolution: raw`, where the renderer is the archived one, would either show zero falls or localize them.
Ten questions, none larger than 114 characters, none of them a verdict: **not repaired this round, and not
called a defect either.**

### 10.4 `P4`: the bill holds, and the price is not readable

Control 4,201,812 tokens against treatment 4,270,578: **1.0164**, inside the registered 1.02. `P4` holds.

A cache-weighted price over the same counters reads **2.357** (2.50 against 5.88 CNY), because the credited
cache-hit share moved **0.969 → 0.470**. It is **not** reported as money. `AUDIT-CACHE-CREDIT.md` §0
measured this counter against the prompts it claims to describe — 96.4% credit on a shard whose 63 prompts
share **22 characters** of prefix at the longest, against a ceiling its own two repetitions bound at 50% —
and a byte-identical repeat is credited 82.7%. A price built on that counter already refused
`resolution: 'layered'` at 1.55× and was overruled when the mechanism measured +0.07% prompt tokens. It
gets a diagnostic row and no verdict, which is why the registered gate is phrased on tokens.

The near-miss is worth recording: this file's own tool evaluated the bound on money first, read 2.357, and
would have headlined a 2.36× cost increase that the counter cannot support.

### 10.5 The decision: measured and declined

§9.3 said the adoption was a choice rather than a consequence, and §9.2 had already retired the only
argument for it — the implication that room left unread is room wasted. This round makes that retirement
arithmetic: **12.0% more room than the census believed existed was spent, and the net movement is 0**
(b = c = 12, p = 1.0).

What adoption would buy: 24 verdict changes that cancel, an `O(n)` render on every question, and a
published number resting on one pass. What it would cost: the same. What it would not buy: a point.

So the shipped unit stays `turn`, and the registry row reads **measured, net 0, declined**. The re-open
condition is named rather than implied: **a positive paired delta on this arm under a reasoning reader**,
where the extra text has a mechanism to act on. Until that reading exists, spending the room is a way to
move 24 answers without moving the score.

### 10.6 What this round's instrument cost, and what it removes

`tools/pair-shape-readout.mjs` costs nothing to run: it reads JSON and calls no model. It replaced a
26-minute transfer with 0.8 s, and it is the reader that would have caught the field-name trap earlier
than a human did — `ablation.baselinePromptChars` is the control's **whole** prompt and
`questions[].promptChars` is that side's **evidence**, and the first version of the tool compared them.
The wrong comparison read 333 questions *falling* by a mean of 306.2 characters; the right one reads 418
rising by 701.7, and the difference between the two means is **1,007.9**, which is exactly the mean prompt
overhead on this artifact. A constant bias wearing a delta's clothes, caught by an identity rather than by
a suspicion.

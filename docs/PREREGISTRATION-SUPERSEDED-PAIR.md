# Pre-registration: the inline superseded rendering, measured in one job

**Status:** decided — the axis is off at its price. Dispatched as run `46011982917` at master `fab2c727`. The treatment has existed in the product since §18 (sixteen unit tests,
an assembly test, `CORTEX_MEMORY_SUPERSEDED` on the workflow) and has never been dispatched. Its price was
written down as `14.26 CNY` with the note "needs ABAB interleaving"; §3 replaces that note with an
instrument, and the price with `3.48 CNY`.

---

## 0. What this is, and why it has never run

`supersededRendering` marks, **inside the turn that states it**, a value the evidence later replaces:

```
I work out with a trainer twice a week. [superseded: the evidence later states three times a week]
```

`'mark'` appends one bracketed clause; `'collapse'` keeps only the sentence at issue. It reaches
`multi-session` and the four flat routes; `abstention` is excluded because a refusal has no value to
replace.

The mechanism has a target population that is not a hypothesis. `AUDIT-MR-ENUMERATION.md` §4 read the seven
stable `KU` failures on `41284575092` and found **five of the seven answered with the superseded value**,
although the instruction block already carries four sentences forbidding exactly that and the evidence is
time-monotone on all 72 questions. The instruction is a sentence in a preamble; this treatment puts the
correction on the sentence it contradicts. That difference is the whole of what is being measured.

**Why it has not run, stated as the plan stated it.** The tracking report's `I6` row carries
`14.26 CNY / needs ABAB interleaving`, and the reason is a measurement rather than caution: a sibling
in-line-annotation form had read **−4.75**, and the four runs that produced it were executed in sequence, so
"this form is worth −4.75" and "the fourth run in a sequence is worse than the first" were the same reading.
ABAB interleaving was named as the only instrument that could separate them, and it costs four dispatches.

## 1. Treatment, byte for byte

| input                      | value            | why                                                                          |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `CORTEX_MEMORY_AB`         | **`superseded`** | one job, one corpus, both sides                                              |
| `CORTEX_MEMORY_SUPERSEDED` | **`mark`**       | the conservative form: the clause is added, the turn is kept whole           |
| `capability`               | **`KU`**         | §2                                                                           |
| `ablation_runs`            | **`2`**          | two repetitions per side, so a single-question flip is not read as an effect |
| `limit`                    | **`0`**          | the whole route, not a prefix of it                                          |
| `CORTEX_MEMORY_RESOLUTION` | **`layered`**    | the rendering the 93.40% reading was taken under -- see below                |
| everything else            | registered       | the control side is the shipped configuration by construction                |

`layered` rather than the arm's own default `raw`, and the line is in the table rather than folded into
"everything else" because it is a declared departure: `tools/arm-config-baseline.json` carries
`resolution: null`, which the arm resolves to `raw`, while every artifact since `45923435343` renders
`layered`. Pairing `I6` against `raw` would measure the rendering on a configuration nothing has been
reported on since that artifact. The pair is valid either way -- the two sides stay one key apart -- but the
reading would be about a configuration the register does not quote.

`mark` rather than `collapse` because the two are different **product decisions** and only one of them is
reversible by the reading: `collapse` deletes text from the turn, so a null on it cannot be distinguished
from "the deleted text was load-bearing". `mark` adds one clause and loses nothing, and if it wins,
`collapse` becomes a follow-up with a reason to run.

The treatment, written as the assignments `guard:prereg-knobs` reads: `CORTEX_MEMORY_AB=superseded` and
`CORTEX_MEMORY_SUPERSEDED=mark`, over `capability=KU` and `ablation_runs=2`. All four are names the
dispatch path already accepts -- the first two are the pairing selector and §18's rendering switch, both
written unconditionally by `tools/dispatch-cortex-memory-ab.py`, and the last two are arm inputs the
dispatcher diffs against the registration. That sentence is not decoration: three rounds of this campaign
wrote a registration whose treatment did not exist in the tree (§208.10's command that could not fail,
§209.1's pairing that held no unit, §211's `readerSearch` before the string existed), and this gate is the
one that catches it before the money is spent.

**What that gate covers here, stated so the coverage is not overread.** It extracts `name=value`
assignments whose name begins lowercase, which is the shape of an **arm input**; `CORTEX_*` names are
workflow variables and are outside its rule by design. So it reports `capability` and `ablation_runs`
`buildable` and says nothing about the two switches. That gap is covered by a different instrument and this
document names it rather than leaving it to be assumed: `tools/__tests__/test_read_merged_population.py`
holds the pairing vocabulary in this repository to the one `arm-pairing.ts` builds, and
`test_dispatch_departures.py` holds `CORTEX_MEMORY_SUPERSEDED`'s unconditional write. A reader who took the
knob census for full coverage of this section would be reading a check on four names as a check on two.

## 2. Population: `KU`, and what that costs in power

`KU` is **72 questions**. That is small, and the smallness is the reason the treatment was written off as
expensive rather than the reason it is being run here:

| population    | calls (2 sides × 2 repetitions) |         price | what it can resolve                                                                          |
| ------------- | ------------------------------: | ------------: | -------------------------------------------------------------------------------------------- |
| all 500       |                           2,000 |    ≈14.26 CNY | any effect ≥ 2.5 questions (`AUDIT-MR-ENUMERATION.md` §9's floor)                            |
| **`KU` only** |                         **288** | **≈3.48 CNY** | the **identity** of the questions that flip, on the population the mechanism was written for |

The 72-question population cannot resolve a two-question effect at `p < 0.05` — exact McNemar needs a net
`+5` at that size — so §3 does not ask it to. What it asks is the question `I6`'s own criterion asks:
**which of the stale twins stopped answering with the old value.** That is a question about identities, not
about a rate, and 72 questions is the whole population of it.

If `P2` or `P3` passes, the full-population reading becomes a **follow-up with a measured reason**, at the
`14.26` the register already carries. If both fail, `I6` is retired on the population it was written for,
which is a stronger retirement than four sequential runs ever produced.

## 3. Bars, written before the dispatch

Every bar below is computable from one artifact. `P1` comes first because a run that did not move a byte
cannot read any of the others.

|      # | bar                      | threshold                                                                                                                            | what failing it means                                                                           |
| -----: | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **P1** | the mechanism executed   | **≥ 72 of 72** `KU` questions carry a different `promptDigest` on the two sides                                                      | the rendering never reached the prompt: this is a wiring defect, not a null                     |
| **P2** | paired accuracy          | net **≥ +4 questions**, exact McNemar `p < 0.05`                                                                                     | `I6`'s registered criterion; below `+4` the axis closes on `KU`                                 |
| **P3** | the stale twins          | **≥ 3** of the questions that answered with a superseded value now answer with the current one, and none of them flips the other way | the mechanism's own target, read by identity                                                    |
| **P4** | no capability regression | no other capability loses **≥ 3** questions                                                                                          | the rendering reaches the four flat routes too, so a gain bought by breaking them is not a gain |
| **P5** | the bill                 | prompt tokens per question **≤ 1.02×**                                                                                               | one bracketed clause per superseded turn, on the turns that have one                            |

**The seven questions `P3` is read on, named before the dispatch.** They are the `KU` failures of
`45923435343` (the 500-question artifact the 93.40% reading came from), and six of the seven answered with a
value the evidence later replaced rather than refusing:

| question id | gold                        | what the run answered                         |
| ----------- | --------------------------- | --------------------------------------------- |
| `852ce960`  | $400,000                    | **$350,000** -- the superseded pre-approval   |
| `a2f3aa27`  | 1,300                       | **1,250** -- the superseded follower count    |
| `69fee5aa`  | 38                          | **37** -- the count before the coin was added |
| `59524333`  | 6:00 pm                     | **7:00 pm** -- the superseded gym time        |
| `07741c45`  | in a shoe rack in my closet | **Under my bed** -- the previous location     |
| `ce6d2d27`  | Friday                      | **Thursday** -- the day the class used to be  |
| `c4ea545c`  | Yes                         | **None** -- declined in prose                 |

Naming them is what makes `P3` a criterion rather than an impression: the reading is which of these six
identities stops answering with the old value, and the seventh is listed because a rendering that turns a
prose decline into a number would move it too -- in either direction.

`P1`'s threshold is 72 of 72 rather than "most of them" because `mark` fires on a property of the corpus
rather than of the question: if a `KU` question's evidence contains no superseded value, its digest is
legitimately unchanged. The receipt therefore reads `promptDigest` **and** the count of turns the renderer
marked, and `P1` is judged on the second: a run whose marks are zero on every question is the §10.10 shape.

## 4. The instrument, and why it is not ABAB

`CORTEX_MEMORY_AB=superseded` builds **one** `CortexMemory` twice, spreading `armTreatment` with one key
rewritten (`superseded: 'off'`). The two instances run in one job, over one corpus, and
`createAblationPool` interleaves them question by question.

That is a stronger instrument than ABAB for the confound ABAB was invented to separate. ABAB estimates a
sequence effect by averaging over four runs and assumes it is linear in position; a pair in one job removes
position from the comparison rather than estimating it, because the two sides are not at different positions
— they are at the same one. `PREREGISTRATION-MULTI-STEP.md` §3.2 makes the same argument for the second look
and `AUDIT-MR-ENUMERATION.md` §9 prices what it is worth: two dispatches of an arm nobody changed differ by
**2.5 questions**, against a paired exact test that needs no such allowance.

## 5. Receipt: the evidence that the mechanism ran

The failure this campaign has paid for four times is a treatment that reports a delta while never executing
(§212's missing field, §213's wrong formula, §214's pinned-to-zero counter). So the artifact must carry, for
this pairing:

| field                                               | what it establishes                                    |
| --------------------------------------------------- | ------------------------------------------------------ |
| `featureConfig.supersededPair: true`                | the delta belongs to one rendering, not to two systems |
| `memoryArmConfig.supersededRendering` on both sides | the control reads `off` and the feature reads `mark`   |
| per-question `promptDigest` inequality              | the bytes changed, question by question                |
| the count of marked turns in the census             | the clause fired, and how often                        |

A run whose `promptDigest` is equal on both sides of a question with a marked turn is an artifact whose two
sides cannot be the same configuration, and the reader refuses it rather than printing a delta.

## 6. What this does not license

- **Not a headline reading.** 72 questions of 500 cannot move the published 93.40%; even `P2` at its ceiling
  is `+4 / 500 = +0.8` points.
- **Not an adoption.** `mark` becomes the shipped default only after the full-population reading, and that
  dispatch is contingent on this one.
- **Not a verdict on `collapse`.** The two forms differ in what they delete, and this run does not delete.

## 7. Result — the rendering executed on 67 of 72 questions and moved no question

Run `46011982917` at master `fab2c727`: `KU`, 72 questions, two repetitions, both sides in one job,
`superseded: mark` against `off`, 1.03 CNY as `projected_spend` estimated it.

| bar                             | threshold                             | reading                                                                                                    | verdict                                                                                             |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **P1** the mechanism executed   | every question's bytes moved          | **67 of 72** digests differ; the five that agree are the questions with no replaceable value in the window | **pass** -- and the marks are countable: 2, 4, 2 and 5 on the four failures below, 0 on the refusal |
| **P2** paired accuracy          | net ≥ +4, exact McNemar `p < 0.05`    | **net 0**, `b = 1`, `c = 1`, `p = 1.0000`                                                                  | **fail**                                                                                            |
| **P3** the stale twins          | ≥ 3 stop answering with the old value | **none did**, and §7.1 is why the denominator was not what this document said                              | **fail**                                                                                            |
| **P4** no capability regression | no capability down ≥ 3                | only `KU` was dispatched                                                                                   | n/a                                                                                                 |
| **P5** the bill                 | prompt tokens ≤ 1.02×                 | **1.0034×** (+2,518 tokens over 144 calls, 17.5 per call)                                                  | **pass**                                                                                            |

Both sides read 68 of 72 on the first repetition and 93.75% over two. The two discordant questions are the
whole of the difference between the systems:

| question                          | baseline | feature                                      | what happened next                        |
| --------------------------------- | -------- | -------------------------------------------- | ----------------------------------------- |
| `852ce960` mortgage pre-approval  | correct  | **wrong** (`$350,000`, the superseded value) | **wrong on both sides** in repetition two |
| `07741c45` where the sneakers are | wrong    | **correct**                                  | **wrong on both sides** in repetition two |

So the rendering moved one question each way and **both movements disappeared on the second
repetition**. That is not an effect with a sign; it is `b = c = 1` produced by two unstable questions, and
the exact test says so with `p = 1`.

### 7.1 The registration's own population was stale, and this document wrote it

`P3` was defined on the seven `KU` failures of `45923435343`. This run's **control side** already answers
three of them correctly:

| question             | `45923435343`     | this run, `superseded: off`                 |
| -------------------- | ----------------- | ------------------------------------------- |
| `59524333` gym time  | wrong (`7:00 pm`) | **correct on both sides, both repetitions** |
| `a2f3aa27` followers | wrong (`1,250`)   | **correct on both sides, both repetitions** |
| `07741c45` sneakers  | wrong             | correct once, wrong once, on both sides     |

The first two are between-run drift on a question the treatment never touched, and the third is
instability. So the population the criterion was written on is **four questions, not seven** -- and three of
those four are the ones below, which are the ones the mechanism cannot reach anyway:

| question   | gold   | answer, both sides, both repetitions | marks | why the marker cannot help                                                                    |
| ---------- | ------ | ------------------------------------ | ----: | --------------------------------------------------------------------------------------------- |
| `ce6d2d27` | Friday | Thursday                             |     5 | the day is not stated as a _replacement_; the two turns are two sessions about the same class |
| `69fee5aa` | 38     | 37                                   |     4 | `38` is a **derivation** (`37 + 1`), so no turn states it and no marker can be put on it      |
| `c4ea545c` | Yes    | `None`                               |     0 | a prose refusal, and `replyRepair` is `off` in this arm                                       |

**This is the same defect §215.3 of the tracking report charged to other documents, committed by this one
in the same round**: a criterion whose population was measured on an earlier artifact. The number was
correct when it was written and it was stale before the dispatch. What the rule should have been is the one
the artifact can compute -- _of the questions this run's control answers wrongly, how many does the feature
answer correctly_ -- which is exactly `c`, and `c = 1` with a second repetition that reverses it.

### 7.2 What the reading establishes about the mechanism

The two questions that carry marks and stay wrong are the useful half of this result. `ce6d2d27` has
**five** marked turns and the reader answers with the superseded day anyway; `69fee5aa` has four and answers
with the value the marker does not cover. So an in-line clause placed **on the sentence that states the old
value** does not make a reader prefer the newer one, and that is the same finding
`AUDIT-MR-ENUMERATION.md` §4 recorded about the four instruction sentences already in the preamble.

The two mechanisms fail the same way, and knowing that is worth more than the 1.03 CNY: **this project's
`KU` loss is not a presentation problem.** It is three questions with three different causes -- a temporal
relation the evidence does not mark as a replacement, a derivation no turn states, and a refusal -- and none
of them is reached by showing the transcript differently.

### 7.3 What this does not close

`collapse` was never dispatched, and it is not retired here. The two forms differ in what they **delete**,
and a null on `mark` says nothing about a rendering that removes the superseded sentence instead of
labelling it. It stays unregistered rather than refused, for the reason §1 gives: `mark` was chosen because
a null on it is interpretable, and `collapse`'s null would not have been.

What is closed is the price: the axis cost **1.03 CNY** rather than the 14.26 the register carried, and the
next in-line-rendering idea can be priced the same way -- one job, one route, one key.

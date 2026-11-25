# The strong reader's loss is not the decline it was recorded as

**Status:** read. Two archived artifacts (`40698867439`, `40698883428`), 500 questions each, paired by
`questionId` with `tools/paired-delta-census.mjs`. Every number below is recomputable from those two files
and no model call was spent producing this document.

## 0. One paragraph

The reader-axis pair on record reads **417 → 381** (`deepseek-chat` → `deepseek-v4-pro`, −7.20 points), and the
sentence attached to it in the tracking report attributes the whole loss to one population: *bare declines on
questions whose gold is an answer, every one of them on the abstention route*. The per-question records refuse
that sentence in three separate ways. `ABS` **gains** a question and loses none. Of the 58 lost questions, **9**
are declines, **33** are well-formed answers that are wrong, and **16** are contract violations — a population
the record never mentions. And the strong reader is worse on the population that is *not* a shape failure at
all: 87.6% → 79.4% on replies that instantiate the contract, which is 76% of the file. The inversion is not a
decline artefact and it is not concentrated anywhere; it is a **uniform** degradation under this contract, and
that is a different problem with a different repair.

## 1. The pair, and what the artifact cannot say about it

| item | control | treatment |
| --- | --- | --- |
| dispatch | `40698867439` | `40698883428` |
| reader | `deepseek-chat` | `deepseek-v4-pro` |
| `feature.metrics.correct` | **417 / 500 = 83.40%** | **381 / 500 = 76.20%** |
| net | — | **−36 questions, −7.20 points** |

The two artifacts' `featureConfig` and `memoryArmConfig` are **byte-identical**. That is not a defect in either
run: the product's option table describes the product, the reader is injected, and a model id is a property of
the deployment. It is a defect in the *pair*, and it is the reason this document exists at all — the difference
between the two numbers is not recoverable from the artifacts, only from the dispatch record beside them. The
report schema has carried an optional `reader` block since §13.212, which landed **after** these two runs, so
every future pair names its own deployment and this one has to be quoted with its dispatch numbers attached.

## 2. The 2×2, per capability

```
node tools/paired-delta-census.mjs <control.json> <treatment.json> --discriminant heading-instantiation
```

| capability | n | lost | gained | both | neither | net |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `IE` | 150 | 14 | 2 | 127 | 7 | **−12** |
| `MR` | 121 | 13 | 10 | 70 | 28 | **−3** |
| `KU` | 72 | 10 | 2 | 54 | 6 | **−8** |
| `TR` | 127 | 21 | 7 | 79 | 20 | **−14** |
| `ABS` | 30 | **0** | **1** | 29 | 0 | **+1** |
| **all** | 500 | **58** | **22** | 359 | 61 | **−36** |

Three facts are load-bearing and none of them survives an aggregate:

1. **`ABS` did not move down.** The claim under audit was that the strong reader's extra declines are all
   abstention questions. It lost zero there and gained one, which is the opposite sign on the route the claim
   named.
2. **The net is −36, and the movement is 80.** Twenty-two questions came *up*. A sentence about "the extra
   declines" describes neither the 22 nor the 58.
3. **The loss is broad.** `TR` −14, `IE` −12, `KU` −8, `MR` −3. No capability is exempt, and the largest loss
   is on the route with the weakest claim to being a reasoning failure in the first place.

## 3. What the 58 and the 22 actually are

Through the product's own `classifyReply`, imported rather than re-implemented:

| reply shape (treatment) | lost | gained |
| --- | ---: | ---: |
| `declined` (`bare-decline` + `prose-decline`) | **9** | 1 |
| `committed` — an answer in the shape the contract asked for | **33** | 12 |
| `evidence-echo` | 0 | 0 |
| `shape-failed` | **16** | 9 |

So the attribution on record overstates the decline population by a factor of **6.4** (58 claimed, 9 observed),
and the largest single bucket — 33 of 58 — is replies that obeyed the contract and answered wrongly. That bucket
is not repairable by any pass in `reply-repair.ts`: a repair needs a broken shape, and these are not broken.

The 16 `shape-failed` losses are the other population the record never named, and they are the only one a
mechanism in this repository can reach at all. They are also, at 16 losses against 9 gains, the *smallest* of
the three buckets — which is the arithmetic that keeps `replyRepair` closed.

## 4. The predicate that separates, and what it separates

`heading-instantiation` asks a question that can be answered from the record without a model call: does the
reply carry a `Step N` heading whose content terms are disjoint from the question's? A reader that instantiates
the contract paraphrases the question into the heading; a reader that copies the contract writes its generic
wording back.

| side | predicate | matched | correct | accuracy |
| --- | --- | ---: | ---: | ---: |
| control (`deepseek-chat`) | true | 106 | 72 | **67.9%** |
| control | false | 394 | 345 | **87.6%** |
| treatment (`deepseek-v4-pro`) | true | 121 | 80 | **66.1%** |
| treatment | false | 379 | 301 | **79.4%** |

Two readings, and the second is the one that decides the strategy:

- **The predicate separates on both sides, by 19.7 and 13.3 points.** An uninstantiated heading is a marker of a
  reply that is about to be wrong, whoever wrote it. That makes it a property of **the contract**, not of the
  reader — the contract asks for a heading, and a heading that does not name the question is a reader that has
  not started answering it.
- **The strong reader is worse in the negative group too**: 87.6% → 79.4%, −8.2 points on the 379–394 questions
  that are not echoes. The echo population grew by 15 questions, which explains at most a fraction of a 36-question
  net once the echo group's own accuracy barely moved (67.9% → 66.1%).

The strategy consequence is stated here rather than in a plan: **the gap this pair exposes cannot be closed by
re-wiring the reader.** A reader swap that costs 8.2 points on well-formed replies is a contract that penalises
whatever a reasoning model does differently, and the fix has to be in what the contract asks for.

### 4.1 The confound this pair carries, stated rather than buried

`deepseek-v4-pro` enables thinking by default, and the registered arm sets `thinking` to `multi-session+temporal`.
So the two sides of this pair differ in the model **and**, on four of the six routes, in whether the reader reasons
at all. Nothing in either artifact separates those two, and `docs/AUDIT-READER-THINKING-REVERSES.md` has the
adjacent reading that makes the confound material rather than theoretical: the same arm with thinking on two routes
reads **90.45%** against **85.75%** with it off, on 500/500 byte-identical prompts, while §13.197 measured the knob
at **−12** questions overall with **`IE` −16**. `IE` is −12 here. That is one number agreeing with a mechanism this
pair did not isolate, and it is the reason §4's sentence is *"worse on this contract"* rather than *"worse because it
reasons"*: a strong model that reasons everywhere lands on `IE` with the same sign and nearly the same size as the
thinking knob alone, and a pair that changes two things cannot say which.

The experiment that would separate them is one field wide and is **not** run here: the same `deepseek-v4-pro`
treatment with `thinking: disabled` on every route, against the same control. It is priced like the pair above
(500 × 2 × 2 arms, ≈¥16), and until it exists the honest statement is the conditional one.

## 5. What this document does not claim

- It does not re-price the SOTA gap. This is one pair on one contract; `cortex`'s adopted position is unchanged
  at 93.50% (`resolution: layered`, 500 questions, 2 repetitions), and the number above is a historical arm.
- It does not conclude that `deepseek-v4-pro` is worse in general. It concludes that it is worse **on this
  contract**, which is the only claim the artifact supports.
- It does not open the `replyRepair` family again. 16 losses against 9 gains inside a 36-question net is not a
  population, and §13.334's census already prices that trade at nine re-asks for one correct answer.
- It does not treat `43.80%` or any reference-pipeline row as comparable. Those are a different arm.

## 6. The three things that changed on the record

| # | what was on the record | what the artifacts say | where |
| --- | --- | --- | --- |
| 1 | the 36-question loss is bare declines on abstention questions | `ABS` **+1**; 9 declines of 58; 33 well-formed wrong answers; 16 contract violations | this file §2–§3, `RETRACTIONS.md` §26 |
| 2 | the reader axis is the largest measured lever here (+4.70 was quoted from an older pair) | the *sign* of the lever is reader-and-contract dependent, and this pair reads **−7.20**; the two are not the same configuration and neither may be quoted as "the reader axis" | `docs/PREREG-READER-AXIS.md` §8 |
| 3 | an uninstantiated `Step N` heading is a strong-reader artefact | it is a **contract** marker: it separates by 19.7 points on the control and 13.3 on the treatment, and the strong reader merely produces more of them | this file §4 |

## 7. Reproduction

```
# the two artifacts, from the dispatch record
gh run download 40698867439 -n longmemeval-s-report -D control
gh run download 40698883428 -n longmemeval-s-report -D treatment

node tools/paired-delta-census.mjs \
  control/benchmark-cortex-memory-ablation-report.json \
  treatment/benchmark-cortex-memory-ablation-report.json \
  --discriminant heading-instantiation

# the same census as a file, which is what `cortex-docs` carries
node tools/paired-delta-census.mjs ... --json > reader-axis-paired.json
```

The tool refuses a pair whose `dataset`, `questionCount` or id set differ, because an intersection is the
quantity that makes two populations print one table. It is wired into `pnpm check` as `guard:paired-delta`, on
its self-test only — a guard that needs a 15 MB artifact is a guard that runs nowhere.

## 6. The recommendation this document made, checked against the arm that ships

§4 closed on a step: change the `Step N` heading the contract asks for, because replies that copy it instead of
instantiating it are wrong twice as often. That reading was taken on `enumerated`. The adopted arm reads
`verbatim-acts`, whose multi-session `Step 1` is a different sentence, and over shard 0's 63 replies **none** of
either sentence appears: readers write `Step 1:` bare or their own heading. The discriminant's prevalence on the
shipped configuration is zero, so the step had no population to move and `RETRACTIONS.md` §27 retires it as a
recommendation while keeping the reading. `AUDIT-EXCLUSION-CENSUS.md` picks the axis up from the artefact the
adopted arm actually produces.


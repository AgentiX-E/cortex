# Half of this arm's failures are one draw's, and three of the four queued mechanisms cannot be measured

**Read from:** `42355323615` — 500 questions x **4 repetitions**, `deepseek-chat` reader with thinking
on `multi-session`+`temporal`, Zhipu GLM-3 embeddings, `ask=verbatim-acts`, per-route caps 48,460 /
48,000 / 24,000.

**Registered before this reading:** nothing. This is a **census**, not an experiment: it reads masks
the artifact has carried since §13.118.5 and dispatches nothing, so it has no prediction to violate
and nothing to spend.

## 0. One paragraph

`ablation.featureCorrectByRun` is one `'0'`/`'1'` mask **per repetition**, in dataset order. Nothing
in this repository read it per question, so every mechanism arm in the queue was designed against
**one repetition's failure list**. Read as repetitions, `MR`'s 20 failures of `42355323615` are
**13 questions wrong in all four and 13 wrong in at least one**, and the file as a whole splits
27 / 27. The population's own repetition spread is **4.16 questions on `MR`** while the three
mechanisms the queue registers have ceilings of **2.25** (deterministic summation), **4.00** (entity
grouping) and **3.75** (decline repair) — all at or below the movement the same population produces
with **nothing changed**. On `KU` the ordering reverses: **7** stable failures against a **2.52**
spread, six of them a single failure mode, worth **8.33 points** — which is the entire `KU` gap to
Synap's 97.2%. So the queue is reordered by arithmetic rather than by preference: the `MR` mechanism
axis is **closed before dispatch**, and `KU` is the only row in the file where a mechanism is large
enough to be seen.

## 1. The data was already there, in the field beside the one everybody read

Every artifact carries `featureCorrect` — one boolean per question, for **repetition zero**. The
campaign's censuses use it, and they are right to: it is the run's published accuracy's numerator.
The field beside it is `featureCorrectByRun`, a list of one mask per repetition, written since
§13.118.5 argued that one repetition is a sample. Its only readers were the paired tests and the
cost join, both of which consume it as a **rate**.

The distinction the per-question read buys is not subtle:

```
$ node tools/failure-stability.mjs --report <artifact> --capability MR
population 121 questions x 4 repetitions = 484 question-runs
mean accuracy 83.88%   recoverable 19.50 question-equivalents

| repetitions correct | questions | share |
| ------------------: | --------: | ----: |
| 0 of 4 | 13 | 10.7% |
| 1 of 4 |  5 |  4.1% |
| 2 of 4 |  3 |  2.5% |
| 3 of 4 |  5 |  4.1% |
| 4 of 4 | 95 | 78.5% |

stable failures 13   flaky 13   stable passes 95
repetition spread 101 / 104 / 102 / 99 -> sd 2.08, 2 sd 4.16 questions
```

**Thirteen of the twenty failures of `MEASURE-MR-CEILING.md` §3 never fail again in any of the four
repetitions**, and thirteen questions the census counts as passes fail at least once. That is what a
one-repetition census is: half of its rows are a property of the draw.

The same partition on the other capabilities, and it is the first column that decides the queue:

| capability | n | mean over 4 reps | recoverable | wrong in all 4 | flaky | spread per repetition | 2 sd (questions) |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| `ABS` | 30 | 100.00% | 0.00 | 0 | 0 | 30 / 30 / 30 / 30 | 0.00 |
| `KU` | 72 | 88.54% | 8.25 | **7** | 3 | 64 / 64 / 62 / 65 | **2.52** |
| `MR` | **121** | 83.88% | **19.50** | **13** | **13** | 101 / 104 / 102 / 99 | **4.16** |
| `TR` | 127 | 96.06% | 5.00 | 2 | 6 | 122 / 125 / 120 / 121 | 4.32 |
| `IE` | 150 | 95.00% | 7.50 | 5 | 5 | 140 / 143 / 143 / 144 | 3.46 |
| *file* | 500 | **91.95%** | 40.25 | 27 | 27 | 457 / 466 / 457 / 459 | 8.54 |

Two readings from it that are not obvious from any per-run figure:

- **`MR` is the least accurate row and the most volatile one.** It owns 13 of the file's 27 stable
  failures and 13 of its 27 flaky ones — while `ABS` owns none of either, which is the only row where
  "100%" is a property rather than an average.
- **`KU` is the most *reliable* row in the file.** It is the only capability with **no question at
  1 of 4**: its failures are 7 that never work and 3 that mostly work, and there is nothing in
  between. Its spread is 1.26 questions, the smallest of the five.

The file mean is **91.95%**, against the 91.20% that `S1` and the landscape table quote. Both are
real: 91.20% is repetition one and 91.95% is the mean of four, and §13.298's `S1` attestations
already require the second. The 0.75-point difference is the same phenomenon this document is about,
one level up.

## 2. A ceiling below the population's own noise is not a result

The campaign has a standing null of **6.54 questions** (§13.118.5, four repetitions of one
configuration on a 127-question column). Applying that number to a 121-question or a 72-question
subset is the unit error §13.340.3 refused once already: a smaller population has a wider
per-question variance for the same rate. So the null here is derived from **the same four numbers on
the same questions** — `repetitionNull` — and reported in **questions**, so that a ceiling and a null
are subtracted rather than converted.

Against that, each mechanism the queue registers, with its target set named by the question ids the
census listed:

| population | mechanism | target set | wrong in all 4 | ceiling | points | 2 sd | resolvable |
| --- | --- | ---: | ---: | ---: | ---: | ---: | :---: |
| `MR` | deterministic summation (§5.2) | 3 | 1 | **2.25** | 1.86 | 4.16 | **no** |
| `MR` | entity grouping (`H3`) | 5 | 3 | **4.00** | 3.31 | 4.16 | **no** |
| `MR` | decline repair (§3) | 4 | 3 | **3.75** | 3.10 | 4.16 | **no** |
| `MR` | under-count repair (§3) | 7 | 6 | 6.00 | 4.96 | 4.16 | yes |
| `KU` | stale-value selection | 6 | 6 | **6.00** | **8.33** | 2.52 | **yes** |
| `KU` | the same, including the decline | 7 | 7 | 7.00 | 9.72 | 2.52 | **yes** |
| `KU` | the three flaky questions | 3 | 0 | 1.25 | 1.74 | 2.52 | **no** |

The ceiling is `sum(1 - passRate)` over the target set and **not** the size of the set, because a
question that four repetitions answered correctly three times is worth a quarter of a question to a
mechanism that would make it deterministic. That is why deterministic summation reads **2.25** where
§5.2 prices it at "the two operation failures it would get": of the three questions
`37f165cf`, `9ee3ecd6` and `gpt4_2ba83207`, only the first is wrong in every repetition. Entity
grouping clears §13.340.6's "≥ 3 of 121" bar on its **stable** count — 3 exactly — and that is the
whole of its margin, against a null of 4.16.

`MEASURE-MR-CEILING.md` §4 already refused to set the bar lower to admit a three-question treatment.
The repetition data makes the same refusal stronger and cheaper: **three questions is not a bar the
arm can lower, it is a movement the arm cannot see.**

## 3. Every stable `KU` failure is the same failure, and it is worth the whole gap

The seven `KU` questions that are wrong in all four repetitions:

| question | gold | the reply | the later turn that supersedes the reply |
| --- | --- | --- | --- |
| `ce6d2d27` | `Friday` | `Thursday` | a later restatement of the class day |
| `9ea5eabc` | `Paris` | `Hawaii` | the reply quotes the 2023/05/26 trip; a later trip is the answer |
| `ed4ddc30` | `20` | `30 dozen` | `30 dozen` is stated 2023/01/11 and revised down later |
| `59524333` | `6:00 pm` | `7:00 pm on Mondays, Wednesdays, and Fridays` | the day set is right, the time is a statement the corpus changes |
| `69fee5aa` | `38` | `37` | the reply quotes "a total of 37 coins", which a later turn adds to |
| `a2f3aa27` | `1300` | `1250` | a follower count, which only ever moves one way here |
| `0977f2af` | `Instant Pot` | *declined* | absent, not superseded |

Six of seven are one failure mode: **the reply answers with a statement the corpus later supersedes.**
Six questions on 72 is **8.33 points**, and the `KU` gap on the same 72 questions is **8.31** — 97.2%
against 88.89% at repetition one, `COMPETITOR-SYNAP-DECOMPOSITION.md` §5; at the four-repetition mean
of 88.54% the same gap reads 8.66, so the ceiling covers 96% of it rather than 100%. Either way this
is the first time in this campaign that a competitor's lead has had a **local mechanism of the same
size** behind it rather than a differently-sized one.

This is **not** a wording problem, and the artifact says so without a new experiment. The `KU` route's
answer block already reads:

> Some evidence may state a value that was later changed. When it does, distinguish the earlier value
> from the later one. Use the evidence with the latest date in the evidence that is consistent with
> the time qualifier in the question. If the question asks for a previous value, reply with the
> earlier one. If it asks for the current or most recent value, reply with the later one.

That is the rule, in the prompt, on every one of these seven questions, four times each. A rule that
is present and fails 24 times out of 24 is not a rule that needs rewording — it is a **comparison the
reader is being asked to perform over 23,084 characters** when Synap hands it the comparison already
made (`valid_until`, `event_precision`). And the shape of the failure agrees: on `852ce960` — the one
`KU` question where the reader *found* the later value and talked itself out of it, at 2 of 4 — the
reply's own text is "A later message (2023/11/30) mentions a pre-approval for $400,000, but that
message also states the assistant has no access to previous conversations". A reader performing the
comparison correctly and then discounting the result is the failure mode of an instruction that asks
for arithmetic on a haystack, not of an instruction that is missing.

### 3.1 The population is not evidence-blocked, so no arm on it can be blocked either

The artifact's own `goldOverlap` settles the precondition `H2` needs before it is worth registering.
All seven stable failures carry gold turns inside the delivered window:

| question | gold turns carried | gold turns total | delivered turns |
| --- | ---: | ---: | ---: |
| `ce6d2d27` | 16 | 24 | 66 |
| `9ea5eabc` | 17 | 24 | 64 |
| `ed4ddc30` | 17 | 24 | 100 |
| `59524333` | 14 | 22 | 87 |
| `69fee5aa` | **22** | **22** | 61 |
| `a2f3aa27` | 17 | 20 | 62 |
| `0977f2af` | 17 | 24 | 65 |

The fifth row is the one that matters. `69fee5aa` carries **every** gold turn and answers `37` against
a gold of `38` — a derivation miss with the whole evidence set on the page. The same shape holds on
`a2f3aa27`, where `nearing 1300 followers` is delivered at turn 51 of 61 and the reply answers `1250`,
and on `0977f2af`, where `using my new Instant Pot` is delivered at turn 31 and the reply **declines**.

So the `KU` population is representational end to end, and the comparison `H2` proposes to hand the
reader is one it currently has to perform over 23,084 characters. That is the same conclusion
`MEASURE-MR-CEILING.md` §1 reached on `MR` from the other direction, and it makes the two rows one
finding stated twice: **in this arm, retrieval is not where the accuracy is going.**

## 4. What this does to the queue

| queued item | was | is now |
| --- | --- | --- |
| `H3` entity grouping (`MR`) | "≥ 3 of 121 changes" | **cancelled** — ceiling 4.00 against a 4.16 null, and the 3 stable conversions are the whole of its margin |
| deterministic summation (`MR`, §5.2) | "not registered here" | **cancelled** — ceiling 2.25 against 4.16, and `gpt4_2ba83207` is already correct in three repetitions of four |
| decline repair (`MR`) | `E3.2`, ~2.9 CNY | **spent and not adopted** — `42791109966` bought the same-room pair for 14.26 CNY; it fires 1.5 times per repetition at the shipping room against a registered 3–5, the headline moves +0.25 points with p = 0.607, and `E3.2` still cannot be read because the artifact names no targets (§13.358) |
| `H2` date properties | scoped to `KU`, "≥ 3 of 72" | **promoted to the head of the queue**, scoped to the 6 stable stale-value questions, with a ceiling of 8.33 points against a 2.52 null |
| `M1` reader axis | blocked on a key | **unchanged, and now cheaper to argue**: on `MR` no mechanism below 4.16 questions is readable, so the reader remains the only lever the row has |
| `P1` portability | blocked on a 1.41-question-per-minute provider | unchanged |

The bar `H2` should be registered with is **no longer "≥ 3 of 72"**. Three questions is 4.17 points,
and the `KU` null in points is 3.50 — so a three-conversion result would be inside the noise on a
population where six are available at 24 opportunities each. The registered bar becomes **≥ 4 stable
conversions of the six, at no other capability worse than 2 sd of its own spread**, and the falsifier
**≤ 2** — which is the first time in this campaign a bar has been derived from a measured null rather
than from a convention.

## 5. What this census does not say

It does not say the `MR` failures are not real. They are: thirteen questions are answered wrongly
every time. It says the **named mechanisms** are each smaller than the noise on that population, and
that the only `MR` class above the null is under-count (ceiling 6.00), for which nothing in the queue
proposes a mechanism — `MEASURE-MR-CEILING.md` §1 already showed that every one of the twenty carries
its gold, so a short list is not a retrieval failure either.

It does not say the 6.54-question figure is wrong. It says it belongs to a 127-question column and
that each capability has its own, and that the file's own null (8.54) is larger than the `MR` one
(4.16) — a subset's null is not the file's, in either direction.

It does not say `KU` will convert. Six questions with one failure mode is a population, not a
treatment. The treatment has to be built, and the bar in §4 is what it will be measured against.

## 6. Reproducing the reading

Zero model calls. The artifact is a published workflow artefact.

```
node tools/failure-stability.mjs --report <artifact>                              # the file
node tools/failure-stability.mjs --report <artifact> --capability MR             # one capability
node tools/failure-stability.mjs --report <artifact> --capability MR --targets q.json
node tools/failure-stability.mjs --report <artifact> --json                      # for a script
```

`--targets` is a JSON object of `mechanism -> question ids`; a target id the artifact does not carry
is a refusal rather than a silently smaller set, for the reason every other refusal in this
repository gives: a denominator that shrinks without saying so is a number that cannot be compared to
the one it replaced. `stabilityOf`, `repetitionNull` and `conversionCeiling` are the library behind
it (`packages/cortex-eval/src/failure-stability.ts`), with six named refusals of their own — the
important one being **one repetition**, which is refused rather than read as "every failure is
stable".

## 7. The null in this file is the wrong yardstick, and the correction cancels the queue

§3 judges every mechanism against each capability's own **repetition 2 sd** — 4.16 questions on `MR`, 2.52
on `KU`. That number answers "how much would this configuration move if it were re-run", and it is not the
question the queue asks. The question is "how large must a true difference be before this population sees it",
and the answer is the **resolution floor** `2.8016 * sqrt(p(1-p)/n)` (Miller, `arXiv:2411.00640`): **9.37
points on `MR`**, **10.52 on `KU`**.

| population | mechanism | ceiling | points | floor | detectable |
| --- | --- | ---: | ---: | ---: | :---: |
| `MR` | deterministic summation | 2.25 | 1.86 | 9.37 | **no** |
| `MR` | entity grouping (`H3`) | 4.00 | 3.31 | 9.37 | **no** |
| `MR` | decline repair (`E3.2`) | 3.75 | 3.10 | 9.37 | **no** |
| `MR` | under-count repair | 6.00 | 4.96 | 9.37 | **no** |
| `KU` | stale-value selection (`H2`) | 6.00 | 8.33 | 10.52 | **no** |
| `KU` | the same, including the decline | 7.00 | 9.72 | 10.52 | **no** |

Every ceiling in §3 is below its population's floor, including the one §3 promoted to the head of the queue.
`docs/MEASURE-RESOLUTION-WALL.md` is the full argument; this section records the consequence for the two
mechanisms §3 left open.

**Under-count is cancelled, on reach rather than on size.** §3 has it as the one `MR` class above the null with
no mechanism proposed. The artifact answers the reach question at zero cost through `goldOverlap`: of the six
questions the class is stable-wrong on, **three carry every gold turn** (`2b8f3739` 18/18, `bf659f65` 17/17,
`gpt4_2f91af09` 17/17) and three do not (`gpt4_731e37d7` 22/23, `gpt4_372c3eed` 16/17, `21d02d0d` 10/11). So a
prompt that enumerates before summing can reach **3.00 questions = 2.48 points** against a floor of 9.37, and
the class at its absolute ceiling of 6.00 questions is 4.96 — also below. Two independent reasons, both
zero-cost, and the mechanism is not dispatched.

The half that is *not* reachable is the informative half. `21d02d0d` answers 1 where the truth is 2 and one of
its eleven gold turns is outside the delivered window, so the reader was short one **fact**, not one act of
counting: `enumerate what you see before you add` cannot enumerate what was never delivered. That is the
distinction `MEASURE-MR-ENUMERATION`-class work kept blurring — a counting failure and a retrieval failure
produce the same wrong integer.

**`H2`'s two rejections were arithmetically correct and evidentially empty.** `§13.354.2` rejected a +1.74-point
mean against a falsifier that fired, on 10 discordant questions of 72 — `pi` = 13.9%, which at n = 72 makes the
paired floor **12.3 points**. The block moved 1.74 points against a floor of 12.3: no reading of that dispatch
could have been a gain, and the sign test's `p = 1.000` is the wall showing through, not a property of the
block. The verdict of *rejected* stands, because the bar was registered in advance and firing a registered
falsifier is a rejection however the number is later explained; what changes is its **weight**: it is not
evidence that the mechanism does nothing, and the shelving decision in `§13.354.3` — relocation of cost rather
than size — is the only durable part of it.

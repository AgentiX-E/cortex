# MEASURE — The reply that is not an answer, and which of its two shapes can be repaired

## 0. One paragraph

`MEASURE-ORACLE-CEILING.md` §7.4 reads all 35 questions this arm loses with the gold sessions in the window and
classifies fourteen of them as **contract violations rather than reasoning failures**: eight refusals in prose and six
lists of quotations. That is a hand classification of the losses, and a hand classification of losses has no
denominator — it counts the replies that failed without counting the replies of the same shape that succeeded. So this
round built the classifier, ran it over the `rawOutput` of every question in **three** archived artifacts, and counted
both columns. The answer splits the fourteen in two: the refusals are **3 to 5 per run and every one of them is a
loss**, and the lists of quotations are **42 to 47 per run of which only 7 to 13 are losses**. The first shape is
dispatched. The second is refused, and the reason is arithmetic rather than aesthetic: re-asking 42 to 47 questions to
reach 7 to 13 wrong ones spends nine times the calls to consult 35 to 38 answers that were already right.

## 1. What the two retries the arm already carries cannot see

| pass | fires when | what it misses |
| --- | --- | --- |
| `reviewBareDecline` | `isBareDecline` — the token **and nothing else** | a refusal in prose, and a reply of `None` that names no token at all |
| `reviewPass: 'recover'` | a decline **whose Step 1 list is non-empty** | `parseAnswer` reads "Not specified in the evidence" as **an answer**, so this pass is told the question was answered and returns `none` |

The second row is the mechanical reason a new mechanism was needed rather than a stronger sentence in an existing
one: the recovery pass does not decline to act, it is **told there is nothing to act on**. And the first row explains
why the arm's bare retry reported `72/72` converted in the same run whose eight refusals went untouched — its
population is the token alone, and that is a different population.

## 2. The census, on three artifacts

`tools/reply-shape-census.mjs` reads an artifact's per-question `rawOutput` and classifies each reply with the
product's own `classifyReply`. The `wrong` column is the record's own `correct` field, so it is the judge's verdict
that the report's accuracy is built from rather than a second scorer.

| artifact | configuration | `bare-decline` | `prose-decline` | `shape-failed` |
| --- | --- | ---: | ---: | ---: |
| `42521885948` | gold sessions, top-k 256 | 30 (**0** wrong) | 5 (**5** wrong) | 42 (7 wrong) |
| `42500867182` | corpus, top-k 256 | 30 (**0** wrong) | 4 (**4** wrong) | 47 (9 wrong) |
| `42522552589` (`E2`) | corpus, top-k 32 | 30 (**0** wrong) | 3 (**3** wrong) | 47 (13 wrong) |

Three readings, in the order they matter.

1. **`prose-decline` is 100% wrong in all three artifacts.** Every reply the classifier calls a refusal cost a
   question. That is a stronger statement than the hand classification could make, because it is a rate rather than a
   list.
2. **`bare-decline` is 100% correct and all thirty are `ABS`.** The token is the right answer on the one capability
   whose gold is a decline, and the population a blind retry would reach is **exactly** the population that reads
   30/30. The exclusion `reviewBareDecline` argues for in prose is now a row in a table: a treatment with the wrong
   reach here would not buy nothing, it would spend 30 calls to lose questions.
3. **`shape-failed` is 17-28% wrong.** 42 to 47 replies per artifact are lists of quotations; 7 to 13 of those are
   losses. The rest are correct answers that happen to be lists — a preference question legitimately answers with a
   bulleted recommendation set, and `8a2466db` ("Based on the evidence, here are resources for learning more about
   video editing: …") is a correct answer in that shape.

### 2.1 Why the fourteen did not reproduce

The six dump-shaped losses §7.4 read are inside the 42 to 47 replies of that shape, and the section never had the
denominator. So "fourteen contract violations of two kinds" was two different statements joined by a conjunction: six
losses of one shape, eight of another, with no count of how many replies of each shape there were.

`shape-failed`'s precision is also **config-dependent**: 7 of 42 under gold sessions, 9 of 47 at top-k 256, 13 of 47
at top-k 32. Narrowing the retrieval pool made the dump shape *more* likely to be a loss, which is the one direction
that would justify the repair — and it still leaves two thirds of its targets correct.

## 3. What is dispatched, and what is refused

| | `commitment` | `shape` |
| --- | ---: | ---: |
| consultations per run | **3 to 5** | 42 to 47 |
| already correct | **0** | 35 to 38 |
| can lose, structurally | **no** — no route outside `abs` has a decline for a gold answer | **yes** — two thirds of the targets are answers |
| verdict | **dispatched** (`E3`) | **measured, refused** |

The refusal is not a hunch about quality. §13.100.2 measured **24 of 121** answers differ between two consultations of
one prompt, so re-asking 35 to 38 correct questions would apply a ~20% churn rate to 35 answers in order to reach 13
wrong ones. The expected value is negative before any conversion rate is assumed, and the cost is nine times
`commitment`'s.

## 4. The mechanism

One pass, at most one extra consultation per question, two sentences:

| kind | trigger | prompt | why the evidence does not move |
| --- | --- | --- | --- |
| `commitment` | the reader declined, and not with the bare token | the evidence again, plus *"a refusal is not acceptable here"* and the list-then-compute procedure | it carries `AssembledPrompt.carried`, the exact text the first call read |
| `shape` | the reply is a list of quotations | the evidence again, plus the `Answer: <phrase>` shape | same set, same rendering: `renderCarried` is shared by all three corrective builders |

The two are **disjoint by construction**: `classifyReply` reads the bare shape first, so a reply that
`reviewBareDecline` owns can never become a plan for this pass. That is what keeps the cost at one call per question
when both switches are on, and it is asserted over a reply table rather than trusted to the ordering. The constructor
refuses `replyRepair` beside `reviewPass` for the reason `selfConsistency` refuses `audit`: two second consultations
on one route with overlapping populations would make any movement two variables.

`tools/reply-shape-census.mjs` is the instrument that sized it and the reason the `shape` value exists at all: a
mechanism that cannot be counted on an artifact is a mechanism whose population is a guess.

## 5. The literature this sits next to

Three published results bear on the design, and none of them is a substitute for the census above.

- **AbstentionBench** (Kirichenko, Ibrahim, Chaudhuri & Bell, NeurIPS 2025 D&B) evaluates abstention over 20 datasets
  and 20 frontier models and finds it unsolved: scaling helps little, and reasoning fine-tuning **degrades** abstention
  by 24% on average. The part that matters here is its own qualification — a carefully crafted system prompt **can**
  boost abstention in practice without resolving the underlying inability. Our arm measures the mirror image of that:
  the bare retry converts **83 of 83** on the shipped configuration, not by asking harder but by removing the token
  from the prompt, i.e. by withdrawing an affordance rather than restating an instruction. `commitment` is the same
  move applied to the other way a reader refuses.
- **Self-Refine** (Madaan et al., 2023) is the canonical statement that a second pass pays when it is given
  *feedback about what was wrong with the first*, not when it is asked again. That is the difference between this pass
  and `selfConsistency`: the repair names the defect ("your previous reply reported that the evidence does not answer
  this question") and re-sends the same evidence.
- **Refusal is a low-dimensional behaviour** (Arditi et al., 2024) is the mechanistic support for treating the token
  as an affordance: a behaviour that lives on one direction is switched by changing what is offered, not by arguing.

None of the three licenses a repair of the `shape` kind, and the corpus says so first: two thirds of the replies of
that shape are answers.

## 6. What this document can and cannot say

**Can.** The refusal population is 3 to 5 per run, every one of them a loss, and a deterministic re-ask reaches all
of them on three archived artifacts. At absolute perfection that is **+0.6 to +1.0 points**, which is inside the
17-question floor — so the axis is decided by the paired count (`commitment.attempted == answered`) and by nothing
else.

**Cannot.** Say that the repair *works*. Three to five questions is a population, not a result; the dispatch that
converts them is the result, and it is registered in §13.334 with its own falsifiers. Nor can this document say the
quotation dump is harmless: 7 to 13 losses per run is real, and the repair that would reach them is not a re-ask of
the same question. The next idea for that shape has to be one that changes what the reply must *contain* rather than
how it must be shaped, because the shape is not the defect — the commitment is, and the shape is how it shows.

## 7. How the dispatch is read, and the divisor that is not optional

`tools/readout-arm-run.py --reply-repair` prints the census and `E3.1`'s verdict, and the exit code is the verdict:
`0` converted and in band, `1` either falsifier, `2` the artifact does not say.

The reason it is a tool rather than a paragraph is a factor of four. A memory instance is reused across every
repetition (§12.5), so the artifact's census is **`per-repetition x runs`**: a four-repetition run that fires on four
questions per pass reports `16`. Read against §13.334.4's band of `[3, 5]` without dividing, a working mechanism looks
broken — and this repository has already published one census of `120` beside a capability table of `30` without
saying which was which.

So the reader divides by `report.runs`, the count that was actually configured, prints the divisor it used, and
**refuses to score** an artifact that carries none. Deriving the divisor from `questionCount` would assume every
question was asked exactly `runs` times, which a partially-failed run falsifies; assuming `1` would invent a reading
rather than report one. The two refusals the reader makes — no divisor, malformed half — are exit `2` and not a
verdict, because "the artifact does not say" and "the mechanism failed" are different statements and the four-state
classifier's entire argument is that collapsing them hides a real fault behind a plausible zero.

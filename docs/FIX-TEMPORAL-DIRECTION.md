# The pass reads the evidence and never reads the question

**Run read:** the `semantic-carry` merged artifact — 500 corpora × 2 windows = 1,000 questions ×
**4 repetitions**, `reviewPass=supersede` on both arms, `deepseek-chat` reader, Zhipu GLM-3 embeddings,
per-route caps 48,460 / 48,000 / 24,000, `carryPair=true` (one arm with the semantic carry on, one off).

**Registered before this reading:** nothing. This is a **fix**, not an experiment: it reads an artifact
already on disk, names a defect the artifact evidences, and repairs it without a dispatch. What it
spends is 0 CNY.

## 0. One paragraph

`adjudicateSupersession` refuses a substitution in seven named ways — `unreadable`, `no-change`,
`no-quote`, `agrees`, `restates`, `not-in-evidence`, `date-not-on-line`, `not-later` — and **not one of
them reads the question**. That was a stated boundary, and it is right about relevance: whether a later
statement bears on the question is the reader's judgement, and a second model call to make it is the
thing this campaign refuses to buy. **Direction is not relevance.** "What was my previous status" and
"what is my status now" are the same two records and want opposite answers, and the difference is a
qualifier spelled in a closed vocabulary that the product already holds a rule about — in the prompt, on
every one of these questions, where it fails 24 times out of 24. `50635ada` is the measurement: with the
pass off it answered `Premier Silver` and was right; with the pass on it answered `Premier Gold` — the
value the corpus moved to later — **seven times**, because the question says *previous*. This round reads
the direction as a function, refuses the substitution when the question asked for the earlier end, and
retires a second proposal of its own on the way, because four repetitions say the proposal was one
sample.

## 1. The case, as the artifact records it

| | pass off | pass on |
| --- | --- | --- |
| `50635ada` "What was my **previous** frequent flyer status on United Airlines **before** I got the current status?" | `Premier Silver` — **gold** | `Premier Gold status` |
| reader's report | — | `CHANGED: yes` / `LATER: Premier Gold status` / `WHEN: 2023/05/30` |
| substitutions on the question | 0 | **7** of 8 consultations |

Every field the adjudicator checks is true. The quote is in the evidence character for character, the
date sits on the record that carries it, and that record is later than the one the first answer rests
on. The substitution is authorised by every test the mechanism has — and it answers the wrong half of a
before/after question.

Two more of the population are the same defect reached from the other end:

| question | gold | the reply the pass shipped | substitutions |
| --- | --- | --- | ---: |
| `0ddfec37` "… in the **first three months** of collection" | `15` | `20 autographed` | 8 |
| `10e09553` "the **earlier** fishing trip … **before** the 7/22 trip" | `7` | `9 largemouth` | 7 |

Three questions, 22 substitutions, one cause. Both of the last two are also wrong with the pass off, so
the mechanism is not their only defect — but it is a defect that runs in the same direction, and on
`50635ada` it is the whole distance between a correct answer and a wrong one.

## 2. The classifier, and why it is a classifier and not a prompt edit

`packages/cortex-memory/src/temporal-intent.ts` — `classifyTemporalIntent(question)` returns `earlier`,
`latest` or `both`.

The vocabulary is closed and short, and every word in it was checked against the 72 `KU` questions
before it was added. The partition is **60 `latest` / 10 `earlier` / 2 `both`**, and the ten are exactly
the questions in that population that name an old value:

| direction | n | of which substituted by the pass |
| --- | --: | ---: |
| `latest` | 60 | 7 |
| `earlier` | 10 | **3** |
| `both` | 2 | 0 |

The two questions that ask for both ends in one string (`f685340e` "how often … previously? how often
… now?" and `031748ae` "… when I just started … how many do I lead now?") are their own direction rather
than a refusal, because their golds span both answers: a replacement answers one half and drops the
other, which is worse than leaving the first answer standing when the first answer belongs to one of
the two halves.

Three boundary rules, each with a question behind it rather than a hunch:

- **`first` is a direction only when it bounds a span** — "the first three months" is a window, "the
  First Aid kit" is a name. `0ddfec37` is the case the rule exists for.
- **A qualifier inside a comma-bracketed aside does not set the direction** — `5a4f22c0` asks where
  Rachel works **now**, and its `previous` sits in the appositive that says who Rachel is.
- **A direction word inside a longer word is not a direction word** — the tokenizer keeps digits attached
  to their letters, so `Before20` is one token and matches nothing.

At the adjudicator the check is one line, placed after `restates` and before the evidence checks,
because it costs one regex over the question and because a direction error is a defect of the
**substitution** rather than of the evidence: an authorised quote in a perfect record still answers the
wrong half of a before/after question. It reports a new refusal reason, `asks-earlier`, so a run whose
refusals are all `asks-earlier` is legible as "the reader kept offering later values to questions that
asked for earlier ones" rather than as a generic refusal count.

**Why not a prompt edit.** The `knowledge-update` contract already says, on every one of these
questions, in every one of the four repetitions:

> Use the evidence with the latest date in the evidence that is consistent with the time qualifier in
> the question. If the question asks for a previous value, reply with the earlier one.

A rule that is present and fails 24 times out of 24 is not a rule that needs rewording. It is a rule the
**mechanism** did not implement, and the mechanism is where a decision can be made without a model call.

## 3. What the fix is worth, stated at the resolution the population actually has

Not much, and the number is small enough that saying so is the point.

Over four repetitions of the `KU` population (144 questions × 4 = 576 question-runs), the carry arm's paired
difference is **4 questions lost, 3 gained** — a net of −1 question-run. Of the four losses:

| question | lost | gained | substitutions | does `asks-earlier` reach it? |
| --- | --: | --: | --: | :--- |
| `50635ada` | **2** | 1 | 7 | **yes** |
| `830ce83f` | 1 | 0 | 0 | no — the pass never substituted |
| `c4ea545c` | 1 | 0 | 0 | no — the pass never substituted |
| `10e09553` | 0 | 1 | 7 | n/a — already gained |
| `f685340e` | 0 | 1 | 0 | n/a — already gained |

So the repair converts **two** question-runs, both of them `50635ada`, and nothing else moves. That is
below the population's own repetition spread (`MEASURE-FAILURE-STABILITY.md` §1: 2.52 questions on
`KU`) and it is not a result. **The repair is not claimed as one.** It is a correctness repair: a
mechanism that replaces a value on a question that asked for the previous one is wrong on that question
by construction, in every population, whatever a 72-question sample can resolve.

What the repair is worth in the **registered arm** is exactly zero, and that is a fact about reach
rather than about the fix: the registered arm runs `reviewPass=none`, and this pass has never been on.
The `V`-shape that matters here is the one this campaign keeps finding — a mechanism can be present,
tested, and **unable to move the published number because its switch is off in the configuration that
publishes it**. `MEASURE-FAILURE-STABILITY.md` §4 already records the same thing about `factTimeline`
(six substitutions worth 8.33 points, on a mechanism whose reach is 6% of the population).

## 4. The proposal this round drafted and then killed, with its own instrument

The same artifact's per-route pairing looked, at repetition 0, like a decisive result:

| capability | route | n | off | on | delta | off-only | on-only |
| --- | --- | --: | --: | --: | --: | --: | --: |
| `TR` | `temporal` | 254 | 206 | 216 | **+10** | 2 | 12 |
| `IE` | `flat` | 188 | 173 | 168 | **−5** | 5 | 0 |
| `MR` | `multi-session` | 242 | 191 | 188 | −3 | 8 | 5 |
| `KU` | `knowledge-update` | 144 | 123 | 122 | −1 | 1 | 0 |
| `ABS` | `abstention` | 60 | 60 | 60 | 0 | 0 | 0 |
| `IE` | `assistant` | 112 | 108 | 108 | 0 | 0 | 0 |

Read one repetition and the conclusion writes itself: carry helps `temporal` by ten questions and hurts
`flat` by five, so the option should be a route list rather than a boolean, and the product should ship
`semanticCarry: ['temporal']`. A `carry-routes.ts` module was written for it, with `carriesOn` and a
stable artifact projection, and deleted before it was committed.

The same artifact carries `baselineCorrectByRun` and `featureCorrectByRun` — four repetitions each, not
one — and over those four the table reads:

| capability | route | off (mean) | on (mean) | delta | question-run pairs off-only / on-only | McNemar p |
| --- | --- | --: | --: | --: | --- | --: |
| `TR` | `temporal` | 208.50 | 210.50 | **+2.00** | 23 / 31 | **0.34** |
| `IE` | `flat` | 171.50 | 170.25 | −1.25 | 11 / 6 | 0.33 |
| `MR` | `multi-session` | 189.25 | 187.50 | −1.75 | 22 / 15 | 0.32 |
| `KU` | `knowledge-update` | 122.50 | 122.25 | −0.25 | 4 / 3 | 1.00 |
| `ABS` | `abstention` | 60.00 | 60.00 | 0.00 | 0 / 0 | 1.00 |
| `IE` | `assistant` | 108.00 | 108.00 | 0.00 | 0 / 0 | 1.00 |
| *file* | — | 859.75 | 858.50 | **−1.25** | 60 / 55 | 0.71 |

The +10 is one repetition of a movement whose four-repetition mean is +2.00 at p = 0.34. Every row is
insignificant; the sign of the file total is negative. **A route list would have shipped a treatment
derived from a single draw**, on an option whose documented reason for defaulting to off is that there
is no reading behind it yet. The module is not in the tree.

Two things this does not say. It does not say the carry is useless — `TR`'s direction is positive in
both readings and the mechanism has a stated physical reason to help a question that asks when something
changed. It says the effect is **below what 254 questions can resolve**, so the next move on that axis is
a larger population or a stronger mechanism, not a configuration change. And it does not say the
repetition-0 table was wrong: it is what repetition 0 measured, and `MEASURE-FAILURE-STABILITY.md` §1 is
the document that already established that half of a one-repetition read is a property of the draw.

## 5. What this changes in the queue

| item | was | is now |
| --- | --- | --- |
| `supersede` pass, direction of substitution | not checked | **checked**, `asks-earlier`, zero model calls |
| `semanticCarry` as a route-scoped option | drafted this round | **rejected** — +2.00 questions at p = 0.34 over four repetitions; not shipped |
| `H2` date properties (`KU`, ceiling 8.33 against a 2.52 null) | head of the queue | **unchanged** — this round removes a defect from the mechanism `H2` would ride on, and adds no accuracy |
| `MEASURE-FAILURE-STABILITY.md` §3's six stable failures | "the reply uses a superseded value" | **unchanged** — five of the six never reach this pass, because the pass is off in the arm that measured them |

## 6. One product signal this repair surfaced, and what was done about it

Adding a module to `cortex-memory` failed `entry-guard`'s closure budget for the first time: **1,053,626
bytes of source against a 1,048,576 budget**. The budget's own comment recorded the number it was derived
from — *"its closure measures 818 KiB of source"* — so the reading is not "this round broke the budget",
it is **the package grew 26% in eight months and consumed the 25% the budget allowed**.

Three things were measured before touching it:

| reading | value |
| --- | ---: |
| source closure of `packages/cortex-memory/src/index.ts` | 1,053,626 bytes (1,029 KiB) |
| the same entry bundled for the browser, minified | 109,991 bytes (107 KiB) |
| the same entry, **gzipped** — what a user downloads | **37,310 bytes (36 KiB)** |

So the source-byte budget is a **28:1 proxy** for the number a consumer pays, and what it is a tripwire
for — an ONNX runtime or a native driver arriving through a browser-claimed entry — is still two orders
of magnitude away. The budget was raised to `1152 * 1024` **and the rule made tighter, not looser**:
1,029 × 1.12, where the old figure was 818 × 1.25. What that costs is sensitivity to ordinary source
growth; the cost is written into the guard's comment rather than absorbed by a number nobody re-derived.

This is recorded here because it is the kind of finding that is easiest to hide: the fix could have been
"shrink the comments until the numbers fit", which would have bought 9 KB by deleting the reasoning the
repository exists to keep.

## 7. Reproducing the reading

Zero model calls. The artifact is a published workflow artefact.

```bash
node -e '
const d = require("./merged-evidence.json");
const b = d.ablation.baselineCorrectByRun.map((s) => [...s].map((c) => c === "1"));
const f = d.ablation.featureCorrectByRun.map((s) => [...s].map((c) => c === "1"));
// per-route, per-repetition, and the McNemar pairs
'
```

The classifier's own partition over the 72 `KU` questions is a test, not a command:
`packages/cortex-memory/src/__tests__/temporal-intent.test.ts` carries ten questions it must call
`earlier`, nine it must call `latest`, both it must call `both`, and the three boundary rules above.

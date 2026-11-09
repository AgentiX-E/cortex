# MR is at the reader's ceiling, and the bill says it is where the money goes

**Run:** `42533236864` — 500 questions × 4 repetitions, `deepseek-chat` reader, Zhipu GLM-3
embeddings, six-route window allocation, `ask=verbatim-acts`.

**Registered before this reading:** nothing. This document is a **census**, not an experiment: it
reads an artifact that is already on disk and the queue that `§13.348.3` wrote. It dispatches
nothing, so it has no prediction to violate.

## 0. One paragraph

`§13.348.3` closed the representation axis and pointed MR's remaining work at *the answer side* — a
rewrite of Step 2's operation list — and this round was going to dispatch it as `I2`. **It is not
dispatched.** The artifact on disk refutes the premise of a wording change three ways, and each one
is a count rather than an argument: every one of MR's **20** failures has its gold turns inside the
delivered window, the reference pipeline reads the **same instruction block** and misses **19 of the
same 121**, and **10 of the 20** are missed by both arms. A prompt edit moves a population; that
population is empty. The 8 CNY `I2` would have cost is not spent, and the finding that replaced it
is free.

The same pass prices the second finding: **MR is 33.0% of the prompt characters in the file and
buys 2.52 times the prompt tokens per correct answer that `ABS` does** — the worst exchange rate of
the five capabilities, ahead of `TR` at 2.18 and against `IE` at 1.06.

## 1. Every failure carried its evidence

`goldOverlap` measures, per question, how many of the **gold answer's own turns** the delivered
prompt contained. On the 121 MR questions:

| population | n   | gold fully carried | gold partly carried | gold absent | carried / total |
| ---------- | --: | -----------------: | ------------------: | ----------: | --------------: |
| correct    | 101 |                 89 |                  12 |       **0** |           0.988 |
| **wrong**  |  20 |                 11 |                   9 |       **0** |           0.966 |

**Zero of the twenty failures is a retrieval failure.** Nine of them carried all but one to four of
the gold sentence's turns, out of windows that carry ten to thirty; the shortest of those ratios is
`gpt4_2ba83207` at 24 of 24 and the longest is `gpt4_ab202e7f` at 26 of 30. So the answer was on the
page for every question this arm got wrong, and the arm read it and answered something else.

That closes the two levers this campaign has already spent money on. Room is not the constraint: the
window is saturated (median 48,334 characters against a cap of 48,460, minimum 48,074, and **all 121
prompts are within 400 characters of the cap**) and the gold fits inside it. Representation is not
the constraint: `§13.348` measured the item identifier at **83.06% against 83.06%** and retired the
axis.

## 2. The other arm reads the same instruction and misses the same questions

The baseline side of every artifact is the reference pipeline — the system whose two-step
multi-session prompt `§13.246` migrated into this arm **verbatim**, held to line equality by
`ask-verbatim.test.ts`. On these 121 questions:

|                    | this arm | reference pipeline |
| ------------------ | -------: | -----------------: |
| correct, first run |  **101** |          **102** |
| accuracy           |  83.47%  |             84.30% |

| which arm was right | questions |
| ------------------- | --------: |
| both                |        92 |
| this arm only       |         9 |
| the reference only  |        10 |
| **neither**         |    **10** |

A one-question difference between two systems that read the same block, on questions whose evidence
both windows carry, is not a prompt difference. It is the sampling this repository has measured
before (`MEASURE-READING-STAGE.md` §1.1: a 127-question column swings ten questions with the prompt
held byte-identical).

And the ten the reference gets right while this arm does not are not a block a missing sentence could
explain: **four declines, three under-counts, two over-counts and one operation failure**
(`88432d0a`, `gpt4_7fce9456`, `gpt4_2ba83207`, `60bf93ed`, `2b8f3739`, `gpt4_2f91af09`, `d905b33f`,
`d6062bb9`, `c18a7dc8`, `21d02d0d`). They are the shape of one arm drawing one better sample on the
same questions, not the shape of a rule one arm has and the other lacks — which is also what the
nine questions the *other* direction buys says.

## 3. The twenty split into two populations, and the classifier already names both

`classifyQuestionShape` (the reference's own derivation test, copied with a parity test holding the
two copies together) partitions the 121 without being told about failures:

| shape         | n   | correct | accuracy |
| ------------- | --: | ------: | -------: |
| `derivation`  |  27 |      25 |   92.59% |
| `enumeration` |  94 |      76 |   80.85% |

**18 of the 20 failures are enumeration questions.** The derivation population — the one `§13.166`
built a block for and `§13.246` kept on that block — is at 92.59%, which is where the whole MR route
was a year of iterations ago. Whatever is left is the other population: the arm lists items and the
count is wrong, in both directions.

| direction  | n  | questions                                                     |
| ---------- | -: | ------------------------------------------------------------- |
| over-count |  5 | `88432d0a`, `gpt4_7fce9456`, `d851d5ba`, `gpt4_ab202e7f`, `gpt4_2f8be40d` |
| under-count|  7 | `3a704032`, `gpt4_731e37d7`, `2b8f3739`, `bf659f65`, `gpt4_372c3eed`, `gpt4_2f91af09`, `21d02d0d` |
| verb filter|  1 | `6d550036`                                                    |
| decline    |  4 | `60bf93ed`, `d905b33f`, `c18a7dc8`, `d6062bb9`                |
| operation  |  3 | `37f165cf`, `9ee3ecd6`, `gpt4_2ba83207`                       |

The two counting directions roughly cancel — five above the gold, seven below — which is the shape
of an arm whose Step 1 is at its own noise floor rather than the shape of a rule that is mis-set.
`verbatim-acts` already moved this balance once and measured **+5.75 questions** for it (`§13.294`);
the rule it replaced was one-sided toward omission, and the rule that has now been measured is not.

## 4. The three operation failures are not a wording problem, and here is the proof

These are the questions `§13.348.3` was pointing at — the reply has the operands on the page and
answers something the operands do not imply:

| question       | gold     | the reply's own answer                     | what went wrong                        |
| -------------- | -------- | ------------------------------------------ | -------------------------------------- |
| `37f165cf`     | `856`    | `440 pages and 416 pages`                  | listed the two operands, did not add   |
| `9ee3ecd6`     | `100`    | `300 points`                               | read the points *held*, not *needed*   |
| `gpt4_2ba83207`| `Thrive Market` | `Walmart`                           | named a store whose amount it had excluded |

A Step 2 that says "the total of the two things you listed is their sum" would address exactly
these. **Three questions — and two of them (`37f165cf`, `9ee3ecd6`) are questions the reference
pipeline also gets wrong**, reading the block this arm copied from it byte for byte. Set against that,
the same edit's blast radius is the eighteen enumeration questions whose failure is a wrong list, and
a stronger instruction to *compute* is an instruction to compute more confidently from a list that is
already wrong in seven cases. `gpt4_2f8be40d` is the clearest: the reply lists **six** rows marked
`attended` and answers `6` — internally consistent — and the gold is `3`, because three weddings are
described under two names each in the evidence. No instruction about *how to compute* reaches a list
that counted one wedding as two. `d851d5ba` is the same defect in money: `$8,750` against a gold of
`$3,750`, where the sum is right and the items summed are not.

The bar `§13.346` wrote for this population is **≥5 net conversions with a falsifier at ≤1**, because
`§13.348.1` measured what a capability-sized claim with no mechanism looks like: 2 conversions and 4
regressions at identical means. A treatment that addresses three questions cannot clear a bar of
five, and setting the bar lower to admit it would be the exact failure `§6.3` exists to prevent.

## 5. What the census does not say

It does not say MR cannot improve. It says **a change of wording has no population left**, and it
narrows the two things that could still move the route to ones the campaign has already priced:

1. **A reader change.** Mastra's published ablation moves the same memory system **84.23% → 94.87%**
   on the reader alone. This arm has priced one variant of that axis and the price was **negative**
   (`deepseek-v4-pro` at 381/500 against `deepseek-chat` at 417/500, −7.20pp). So the axis is real
   and its sign is not implied by "bigger" — which makes it a screening criterion with a contract,
   not a purchase. `M1` stays blocked on a frontier reader key.
2. **Aggregation outside the reader.** `37f165cf` and `gpt4_372c3eed` are arithmetic on numbers the
   reply already lists, and an arm that emits a structured list and sums it deterministically would
   get both. It would not get the twelve counting failures, because in those the list itself is
   wrong — so the ceiling on that mechanism is the enumeration error rate, and it is a design with a
   measured ceiling rather than a hope. It is not registered here.

## 6. The bill, split by capability

`tools/cost-per-capability.mjs` joins the per-capability accuracy to the run's token ledger. It
reconstructs this artifact's feature-side bill at **11.078 CNY** against the 11.06 the round was
recorded at, which is the check that its apportionment is the artifact's own.

| capability |   n | chars/q | share of prompt | tok/q-run | accuracy |  CNY | CNY/correct | × money | tok/correct | × **prompt** |
| ---------- | --: | ------: | --------------: | --------: | -------: | ---: | ----------: | ------: | ----------: | -----------: |
| `IE`       | 150 |  22,981 |           19.4% |     5,965 |   94.17% | 2.86 |      0.0051 |   1.06× |       6,334 |    **1.06×** |
| `MR`       | 121 |  48,311 |       **33.0%** |    12,539 |   83.06% | 3.07 |      0.0076 |   1.60× |  **15,097** |    **2.52×** |
| `KU`       |  72 |  23,084 |            9.4% |     5,992 |   87.15% | 1.37 |      0.0055 |   1.15× |       6,875 |    **1.15×** |
| `TR`       | 127 |  47,841 |       **34.3%** |    12,417 |   95.08% | 3.21 |      0.0066 |   1.39× |      13,060 |    **2.18×** |
| `ABS`      |  30 |  23,099 |            3.9% |     5,995 |  100.00% | 0.57 |      0.0048 |   1.00× |       5,995 |    **1.00×** |

Two readings, both measured:

- **The allocation and the return are inverted.** `MR` and `TR` take **67.3%** of the prompt
  characters and return 83.06% and 95.08%. `IE` takes 19.4% and returns 94.17%. The capability with
  the worst accuracy in the file is also the second-largest line on the bill.
- **Per correct answer, `MR` costs 2.52 times what `ABS` does and 2.38 times what `IE` does.** The
  money column reads lower (1.60×) only because completion is 60% of this run's bill and the
  artifact records none of it per question, so the tool apportions it by question-runs — a null
  model, printed beside the measured ratio rather than in place of it.

Neither reading is an argument for shrinking `MR`'s window. `MEASURE-COST-LEVER.md`'s retraction 12
prices the clean 48k→24k pair at **−2.75 MR questions, −2.65 points** — MR's room is genuinely
load-bearing at the smaller size, and a capability that is both the least accurate and the most
expensive is the one whose accuracy is worth buying, not the one whose prompt is worth cutting.

## 7. What this round spent, and what it bought

**0 CNY.** The registered queue wanted 8 for `I2`. The artifact that cancelled it was paid for by an
earlier round and read this time through a join nobody had built, and the join is now a library
function, a CLI, and 34 fixture-level tests with the artifact's own totals as their check.

For the queue this means `I2` is **cancelled rather than deferred**, on the same rule `§13.348.3`
applied to `I1`'s follow-up: an increment on top of a mechanism that moved nothing has no hypothesis
behind it. The next MR entry must be either a reader (`M1`, blocked) or an aggregation mechanism
with a stated ceiling (§5.2), and neither is a prompt.

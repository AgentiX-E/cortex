# MEASURE — The cost criterion was never met, and the allocation that cut the bill raised the floor

## 0. One paragraph

`C1` asks for **at most 6,000** billed prompt tokens per question per repetition, and this repository has
recorded a configuration as passing it. It did not pass. The row that says so divides the *median evidence
characters* by 4.06 and compares the result to a threshold written on *mean billed tokens* — three departures
in one arithmetic, and the ledger's own reading of that arm is **6,077**, 1.3% over. That is the smaller half of
this document. The larger half is a bound that no allocation of the current mechanism can get under: the two
capabilities that lose accuracy when their window narrows are 248 of the 500 questions, and at the room
`S3` needs they bill **6,167 tokens per question on their own**, before the other four routes spend anything.
So `C1` and `S3` are not two rows that both need work — they are two rows that no configuration in this family
satisfies at once, and the per-route allocation made that worse while making everything else better: it cut the
bill 24.6% and **raised the floor 2.2%**, because the characters it removed were exactly the ones giving the
floor its headroom. What the bound does not cover is a design that stops paying per turn, and the same
instrument prices that: a window sized to each question's own evidence bills **40% of today's** at twice its gold
per question, which is below the threshold with room to spare.

## 1. The row that was wrong

`PROMPT-ROOM-IS-LOAD-BEARING.md` §1 reads:

| id | prediction | reading | verdict |
| --- | --- | --- | --- |
| `C1` | prompt tokens per question fall to **at most 6,000** | `22,830 / 4.06` = **5,623** | **pass** |

Three things are wrong with the right-hand cell and each is a different quantity:

| what | the cell used | what the criterion reads | why it differs |
| --- | --- | --- | --- |
| the statistic | **median** delivered characters (22,830) | the **mean** over questions and repetitions | the delivered distribution has a floor at the 24,000 room and a tail above it, so the median sits under the mean by 2.7% |
| the numerator | **evidence** characters | **billed** prompt tokens | 260 tokens of instructions, session header and question are billed and are not evidence |
| the ratio | **4.06** chars/token, inferred | **3.8528**, measured on the same artifact | `MEASURE-TOKEN-BASIS.md` §1 derives 3.8528 from 34,447 evidence characters over 8,941 evidence tokens; 4.06 came from dividing a median by an evidence-token count and then dividing again |

`tools/cost-ledger.py` on the same artifact, which is the instrument the acceptance row reads:

```
  feature promptTokens         6,077,236
  calls                            1,042
  per question per run             6,077
  per correct answer               6,890   prompt tokens
  at accuracy                     88.20%
```

**6,077, not 5,623.** The arm failed `C1` by 77 tokens, which is 1.3%, and it is the closest any dispatched
configuration has come. The correction is not that the room is not worth cutting — the arm's 6,077 at 88.20% is
the best cost-per-correct-answer reading in the archive (§5) — it is that a row recorded as a pass was a
comparison of two different units, and the next round should not have been able to cite it.

## 2. The floor, and the algebra that makes it exact

`tools/cost-floor.mjs` computes, from one artifact and no model calls:

```
floor = (heavyChars / questions / ratio) x (billed / (deliveredChars / questions / ratio))
      = (heavyChars / deliveredChars) x billed
```

**The character ratio cancels.** The floor is the heavy routes' *share of the delivered characters* multiplied by
the run's own bill, so it carries no density assumption, and a change to `--chars-per-token` moves the
informational evidence-token line without moving the verdict. That matters because the archive has already been
wrong once by leaning on 4.06.

"Heavy" is `MR` and `TR`, and it is not a choice made here: `PROMPT-ROOM-IS-LOAD-BEARING.md` §2 measures the
capabilities that lose accuracy when the room halves, and it is these two by a wide margin.

| capability | n | Δ accuracy at half the room | mean delivered characters | gold share of the window |
| --- | --: | --: | --: | --: |
| `ABS` | 30 | 0.00 | 23,099 | 119.8% |
| `IE` | 150 | −0.67 | 22,981 | 52.4% |
| `KU` | 72 | −1.39 | 23,084 | 124.4% |
| `MR` | 121 | **−6.61** | **48,311** | **9.1%** |
| `TR` | 127 | **−4.72** | **47,841** | **8.1%** |

Two columns in that table are the argument. **`MR` and `TR` deliver 48,000 characters and 8–9% of them are gold**
— the other 91% are the turns a count-over-sessions question needs to be surrounded by. And the four "light"
routes are not light in the sense of having room to give: **`KU`'s gold turns are 124% of its window and `ABS`'s
are 120%**, so their evidence already does not fit at 24,000 characters, and a cut there deletes evidence rather
than filler.

### 2.1 Four dispatched configurations, one verdict

| arm | allocation | billed | floor | floor as share of bill | `C1` | accuracy | tokens per correct |
| --- | --- | --: | --: | --: | :-: | --: | --: |
| `42310779222` | 48,000 everywhere | 12,105 | 6,057 | 50.0% | **blocked** (+1.0%) | 90.20% | 13,420 |
| `42373407439` | 24,000 everywhere | **6,077** | 3,070 | 50.5% | reachable, **bill still over** (+1.3%) | 88.20% | **6,890** |
| `42533236864` | 48,460/48,000 on two, 24,000 on four | 9,201 | 6,189 | **67.3%** | blocked (+3.2%) | 91.20% | 10,088 |
| `43140878641` | the same, with the closing-label repair | 9,168 | 6,167 | **67.3%** | blocked (+2.8%) | 91.40% | 10,030 |

Read the fourth column down and the interesting row is the third. **The per-route allocation cut the bill 24.6%
and raised the floor 2.2%**, from 6,057 to 6,167. It is not a paradox: the four routes it narrowed were 48.4% of
the characters in the 48,000-everywhere arm, so removing half of them took the *denominator* out from under the
two routes that stayed. Concentrating the bill on the load-bearing capabilities raises the share the load-bearing
capabilities carry, and the floor is that share.

The consequence for the criterion is direct and does not depend on which allocation ships:

> Under the two-route allocation that `S3` requires, the `MR` and `TR` windows bill **6,167 tokens per question**
> with every other route delivering nothing. `C1` asks for 6,000. **No allocation of the remaining four routes
> reaches it, and the shortfall is 167 tokens before any of them spends a character.**

## 3. Why this is not a tuning failure

The temptation is to read §2 as "the threshold is 3% too tight, relax it". That reading is wrong, and the same
table says why: the arm that reaches 6,077 reaches it by halving `MR`, and halving `MR` costs 6.61 points of the
capability `S3` is about.

| row | asks for | reads at the registered allocation | what would move it |
| --- | --- | --- | --- |
| `S3` | `MR` ≥ 85.0% | **83.06%** (100.5 of 121) | more of the aggregation, not more turns — the window is already 48,311 characters and 91% of it is not gold |
| `C1` | ≤ 6,000 tokens | 9,168 | a cheaper unit than the turn |

`S3` fails at the *widest* room the mechanism has, and `C1` fails at the *narrowest* allocation that keeps that
room. A configuration that satisfies either makes the other worse, and the two shortfalls are 1.9 points and 2.8%
on quantities that move in opposite directions when the room moves. **The constraint is the unit, not the
number.** A reader handed 200 turns to count them is being asked to do in its context what a loop does in a
millisecond, and it is paying roughly 48,000 characters for the privilege.

## 4. The bound on the other side of the unit

If the unit is the problem, the instrument should price the alternative rather than assert it. `cost-floor.mjs`
also computes what a window would bill if it were **sized to its own question** — each question given twice its
gold characters, capped at what it receives today:

| arm | billed | adaptive (2× gold, capped) | adaptive as share of bill | `C1` at the adaptive width |
| --- | --: | --: | --: | :-: |
| `42310779222` | 12,105 | 5,274 | 43.6% | reachable |
| `42373407439` | 6,077 | 3,711 | 61.1% | reachable |
| `42533236864` | 9,201 | 3,716 | 40.4% | reachable |
| `43140878641` | 9,168 | **3,703** | **40.4%** | reachable |

**3,703 billed tokens per question on the registered configuration, at 91.4% accuracy, is 4,051 tokens per
correct answer** — against the 10,030 the arm actually spends. That is a factor of 2.48 on the axis a buyer
purchases.

Three things this is not, stated before anyone reads it as a result:

1. **Not a configuration.** Production does not know the gold turns. The figure is an *oracle* that says how much
   of the bill is the sizer rather than the evidence.
2. **Not a promise for `MR` and `TR`.** Their gold is 9% of their window because a count question needs the
   turns around the gold, so a 2×-gold window is very likely too narrow for them. The bound is a bound on cost;
   whether accuracy survives at that width is the experiment, and for `MR` the 9.1% gold share is a warning
   rather than an invitation.
3. **Not a reason to relax `C1`.** It is the reason to stop treating `C1` as a room setting. The arm it licenses
   is an allocator driven by a signal available at read time, and its ceiling is this number.

## 5. Where that puts the efficiency frontier

Tokens per correct answer, every row on the basis it was published on, with this arm's figure computed the
conservative way — it divides the **whole prompt** (instructions and retries included) by the correct count,
which no vendor row does:

| system | context per question | accuracy | tokens per correct answer | basis |
| --- | --: | --: | --: | --- |
| cortex, registered (`43140878641`) | 9,168 | 91.40% | 10,030 | own harness, whole prompt |
| cortex, 24,000 everywhere | 6,077 | 88.20% | **6,890** | own harness, whole prompt |
| cortex, adaptive bound | 3,703 | 91.40% | **4,051** | oracle sizer, not a run |
| Mem0, published | 6,800 | 94.40% | 7,203 | retrieved context only |
| Mem0, independent re-run | 6,800 | 73.80% | 9,214 | retrieved context only |
| Zep | 4,400 | 90.20% | 4,878 | retrieved context only |
| Synap | 7,400 | 95.60% | 7,740 | retrieved context only |
| Hindsight | 43,600 | 94.60% | 46,089 | retrieved context only |
| Mastra | 30,000 | 94.87% | 31,622 | retrieved context only |
| Graphon Labs | 15,100 | 92.80% | 16,271 | retrieved context only |

Two readings, and the second is why the first is not a win:

- **The configuration that ships is not on the efficient frontier.** 10,030 per correct answer is 1.39× Mem0's
  published 7,203 and 1.30× Synap's 7,740. On this axis the registered allocation is the expensive one, and it is
  expensive because it buys 1.9 points of `MR` that `S3` still does not award.
- **The 24,000-everywhere arm *is* on it, and it is the cheapest published figure in the table** at 6,890 —
  ahead of Mem0's 7,203 and Synap's 7,740 — but at 88.20% it is 7.4 points behind Synap on accuracy, and a
  product cannot sell 88.2% as SOTA. So the frontier position is real and it is not where the score is.

Which is the same conclusion §3 reaches from the other side: **cheap and accurate are not in tension here, they
are both short of the same missing mechanism.** `MR` at 83.06% in a 48,311-character window is the evidence that
turns are not converting into counts; 10,030 tokens per correct answer is what those turns cost.

## 6. What this licenses, and what it refuses

**Licensed.**

1. **`C1` is annotated, not relaxed.** The row keeps 6,000 and gains the floor: under the shipping allocation the
   floor is 6,167, so the row's status becomes *blocked by arithmetic* on the current mechanism rather than *aim
   not met*, and the annotation names the arm that could reach it.
2. **`C6` is registered** (§7): a read-time allocator, measured against the registered configuration on one
   variable, with the adaptive bound as its ceiling.
3. **The archive's `C1` pass row is corrected** in place, with the three-unit decomposition of §1, because a
   wrong numerator that reads as a pass is worse than a fail.

**Refused.**

1. **Relaxing the threshold to meet it.** 6,000 is not an arbitrary number — it is where the incumbent publishes
   (Mem0 6,800, Zep 4,400), and moving it to 9,200 would make the row pass at the cost of the comparison the row
   exists for.
2. **Cutting the four light routes.** They are at 120–124% gold coverage; the cut would delete evidence.
3. **Quoting the adaptive bound as a cost.** It is an oracle over gold. §4 says so three times because this
   repository has already published one ratio computed on the wrong basis (`MEASURE-TOKEN-BASIS.md`).

## 7. `C6`: the arm this licenses (registered, not implemented)

| item | value |
| --- | --- |
| claim | sizing each window from a read-time signal holds accuracy within 1.0 point of the registered configuration at **≤ 6,500 billed tokens per question** |
| variable | the allocator only. `ask`, ranking, contract, pool, evidence source, retry shape and the two load-bearing rooms' *ceiling* are unchanged |
| signal | the allocator may read the question and the retrieval scores; it may not read gold |
| ceiling | the adaptive bound of §4, recomputed per artifact, is the number the arm is scored against |
| falsifier | accuracy below 90.40% (the registered 91.40% minus one point) — then the width costs more than the allocator recovers and the family closes |
| instrument | `tools/cost-floor.mjs` on the arm's artifact, plus the ledger for the accuracy side |
| cost | one full pass, 14.26 CNY, or 2.85 CNY at 200 questions × 2 repetitions for screening |

The screening shape is named because the first question is not "is it better" but "does any allocator survive at
all": at 200 questions and 2 repetitions the arm costs a fifth of a full pass and answers the falsifier.

## 8. The instrument

`tools/cost-floor.mjs`, 30 tests in `tools/__tests__/test_cost_floor.py`. Four decisions are pinned, and each one
changed a verdict during this round:

| decision | the trap it avoids | test |
| --- | --- | --- |
| delivered characters = `deliveredPromptChars` | `evidenceChars` holds the evidence *available* before the room — 289,387 characters per question against 35,447 delivered — so using it made the floor read 1,082 instead of 6,167 | `test_delivered_prompt_chars_is_preferred_over_the_assembled_prompt` |
| the bill = `usageBySide.feature` | the top-level `llmUsage` **sums both arms**; on `43140878641` that overstates one arm by 15.9% | `test_the_feature_side_is_the_bill_and_the_two_arm_total_is_not` |
| the floor = heavy share × bill | a floor that moves with `--chars-per-token` is resting on an inferred constant | `test_the_floor_does_not_move_with_the_character_ratio` |
| the adaptive bound caps at today's width | an uncapped bound prices windows nobody would deliver | `test_adaptive_never_delivers_more_than_the_question_already_gets` |

The third of those tests failed on its first run against a real defect: the entry point passed
`{ ...options, charsPerToken: DEFAULT_CHARS_PER_TOKEN }`, which silently discarded `--chars-per-token`. That is
the class of error this campaign keeps finding — a parameter written down twice and one copy ignored — and it
was caught by asserting an invariant rather than a value.

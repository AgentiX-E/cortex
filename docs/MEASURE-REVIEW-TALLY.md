# The arithmetic pass: the reader tags, the product adds

**Arms:** `reviewPass: tally` against the shipped `reviewPass: bare`, one input moved, 500 questions × 4
repetitions, `deepseek-chat` reader, Zhipu `embedding-3` retrieval.

**Registered before the dispatch:** `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.362 — population, three
gates, four predictions and the stopping rule. This document is the design and the census; §13.362 is
what the artifact is read against.

## 0. One paragraph

Multi-session is where this arm's four and a half points live: on `42533236864` the 44 wrong questions
split **MR 20, IE 9, KU 9, TR 6, ABS 0**, and every one of the twenty carries its gold turns
(`goldOverlap` 0.966 against 0.988 on the correct ones). **102 of the 121 multi-session questions ask
for a count or a total, and 18 of the 20 failures are inside that 102** — 82.4% there against 19 of 19
on the questions that ask for something else. The misses are off-by-one counts, wrong sums, and one
reply that listed its own operands and did not add them. So the mechanism does not ask a model to be
better at arithmetic; it stops asking a model to do arithmetic at all.

## 1. The census that named the mechanism

`37f165cf` — *"What was the page count of the two novels I finished in January and March?"*, gold
**856** — answered:

```
- The Nightingale by Kristin Hannah | finished | 2023/05/22 (Session 10) — page count: 440 pages
- a 416-page novel | finished | 2023/05/27 (Session 34) — page count: 416 pages
- The Power by Naomi Alderman | finished | ... — excluded: evidence says it was read in December

Answer: 440 pages and 416 pages
```

Both operands, correctly attributed, correctly excluded for the third candidate, and no addition. The
other seventeen failures are the same shape at other scales: `2` against 3, `5` against 4, `22` against
23, `1` against 2, `$8,750` against `$3,750`, `$700` against `$720`, `$375` against `$495`.

## 2. Why the answer is not "parse the list the reader already wrote"

The first version of this mechanism was an offline one and it was measured before any code was written:
take the reader's own Step-1 list out of the archived reply, extract the numbers, add them. It answers
**1 of the 20**. The lists are prose — `2023/05/22` and `Session 34` are numbers, `440 pages` is a
number inside a sentence, and no rule that reads them can tell a contribution from a date without
guessing.

That failure is the design constraint rather than an obstacle. A parser cannot recover the operands
from prose, so the pass **asks for them in a shape a parser can read**: one line per item, the line's
last token a bare number. This is also why the mechanism cannot be an audit: the audit reviews
membership in prose and is explicitly told not to touch a total, because run `42054107910` measured 22
correct answers destroyed by exactly that request.

## 3. The three gates

| gate | rule | why | population on `42533236864` |
| --- | --- | --- | ---: |
| route | `multi-session` only | the pass lives in `answerSessions`; the other five capabilities answer from byte-identical prompts | 121 |
| shape | `enumeration` | `question-shape.ts` sends derivations to an operand prompt, and "how many years older am I" would be summed into an age | 121 − derivations |
| request | count or total | a question whose answer is a name, a maximum or a price band has nothing to add; `gpt4_2ba83207` is a *maximum* | **100** |

Of the twenty failures, **16 are inside the intersection**. The two outside it are the maximum
(`gpt4_2ba83207`, `Walmart` against `Thrive Market`) and a derivation (`c18a7dc8`, "how many years
older"), and both are refused on purpose: a mechanism that widened to reach them would be summing a
question it does not understand.

## 4. What a refused ledger does

The ledger is all-or-nothing. A line that does not end in a bare number refuses the **whole** ledger and
the first pass's answer stands. This is arithmetic, not caution: `37f165cf` needs both operands, so a
parser that dropped the line it could not read would answer 440 against a gold of 856 — a smaller total
stated with a complete one's confidence.

`auditCensus()` therefore reports three numbers under `tally` rather than the audit's two:

| field | meaning |
| --- | --- |
| `attempted` | second consultations issued — `≥ 60` is the admissibility bar in §13.362.4 |
| `changed` | consultations whose computed total differed from the answer they were handed |
| `refused` | ledgers the parser would not read (`untagged-entry`, `no-entries`) |

The third field is why the artifact can tell **a mechanism that never fired from one that fired and
was refused** — the same defect class the recovery census was introduced to remove in the other
direction. It is optional on the shared census type, so an `audit` run does not print a zero for a
branch it cannot enter.

## 5. What this does not claim

- **Not that the items are right.** Membership is the audit's question and this pass inherits whatever
  list it is given. A ledger of the wrong four items sums to a wrong total, correctly.
- **Not a cost win.** The pass issues one extra consultation on about a fifth of the corpus and
  re-renders the window for it, so the bill rises; §13.362.4 bounds the rise at 25% and a run above
  that bound is read as a dispatch that administered more than the population.
- **Not a prompt-identity comparison.** This is a mechanism: the prompts differ on the population by
  construction, and quoting `promptDigest` identity as an admissibility condition here would be the
  `MEASURE-BASELINE-DRIFT` §8 defect in the opposite direction — a condition that cannot hold being
  stated as though it had.
- **Not evidence about `IE`, `KU`, `TR` or `ABS`.** Their prompts and windows are unchanged to the
  character, so a movement there is a reading of sampling rather than of this mechanism.

## 6. The reading: the arithmetic moved, and the failure moved with it

`42855433242`, `cortex_memory_review_pass=tally`, 500 questions × 4 repetitions, every other input at
its shipped value, 2 h 11 m against the control's 43 m.

| | control `42533236864` | `tally` `42855433242` | Δ |
| --- | ---: | ---: | ---: |
| accuracy | **91.05%** (456) | **89.60%** (448) | **−1.45 pt** |
| `MR` | 101 | **91** (mean of four) | **−10 questions** |
| `IE` | 141 | 140.5 | −0.5 |
| `KU` | 63 | 63.25 | +0.25 |
| `TR` | 121 | 122 | +1 |
| `ABS` | 30 | 30 | 0 |
| feature spend | 11.08 CNY | **21.45 CNY** | **+93.6%** |
| wall clock | 43 m | 2 h 11 m | **3.1x** |

The paired census is the reading a capability column cannot give: **4 repaired, 12 broken, net −8**
(exact p = 0.077) and on `MR` alone **1 repaired against 10 broken, net −9, p = 0.0117**. The
mechanism is not "unproven": it is significantly worse on the capability it was built for.

`audit: { attempted: 342, changed: 173, refused: 7 }` — 85.5 consultations per repetition, **half of
which disagreed with the answer they were handed**, and the roster sums to the census exactly (342 and
173 over 500 records).

### 6.1 What the ten `MR` losses actually are

| question | gold | control | tally | what the tag counted |
| --- | --- | --- | --- | --- |
| `0100672e` | `$12` | `$12 per mug` | **60** | the mugs, not the price |
| `87f22b4a` | `$120` | `$120` | **43** | an unrelated count |
| `bb7c3b45` | `$300` | `$300` | **700** | the spend, not the earning |
| `e25c3b8d` | `$300` | `$300` | **700** | the same shape as the row above |
| `2311e44b` | `190` | `190 pages` | **690** | a second book's pages added in |
| `a4996e51` | `50` | `50 hours per week` | **40** | hours without the extra shift |
| `a08a253f` | `4 days` | `4 days a week` | **3** | three of the four days |
| `7024f17c` | `0.5 hours` | `0.5 hours` | **0** | nothing, because 0.5 is not an integer count |
| `b3c15d39` | `5 days` | `5 days` | **0** | nothing |
| `0a995998` | `3` | `3` | **2** | two of the three items |

**Not one of the ten is an addition error.** Every one is the ledger tagging the wrong quantity: a
count where the question wanted a price, a partial where it wanted the whole, zero where the item was
real but fractional. The arithmetic never failed — `tallyTotal` added exactly what it was given. What
failed is the sentence *"the single bare number this item contributes to the answer"*, which is a
judgement about the question, and it is as hard as the arithmetic was.

That is the finding, and it is the one TallyMem's paper states about its own residual errors: separating
specification from execution "allows errors in specifying the intended events to be distinguished from
errors in combining them", and executing specifications "exposes event-selection mistakes as the
largest residual system-error category". This run is that sentence, measured on this arm, at the cheap
end of that design — where there is no typed ledger and no compiled query, only a prose list and a
number after each line.

### 6.2 All four predictions, scored

| prediction | stated | read | verdict |
| --- | --- | --- | --- |
| `P1` population | `MR` ≥ **+2.0** points (≥ 3 questions) | **−10 questions** (−8.3 points) | **falsified** |
| `P2` no destruction | ≤ **3** of the control's 101 correct `MR` turn wrong | **10** | **falsified** |
| `P3` admissibility | `attempted` ≥ 60, `refused` ≤ 20% of it | 85.5 per repetition, 7 of 342 = **2.0%** | **holds** |
| `P4` cost bound | ≤ **+25%** feature spend | **+93.6%** (output tokens doubled, 2.22M → 4.41M) | **falsified** |
| `P5` load concentration | ≥ 2 of the net on > 14 gold turns | moot: the net is negative | — |

`P4` deserves its own line because it is the requirement-8 answer: the pass did not buy accuracy with
tokens, it bought **less accuracy with twice the tokens**. The extra consultation re-renders the window
and, with `thinking` on, writes a long tagged ledger — 4.41M output tokens against 2.22M — so the
mechanism is dominated on both axes it was supposed to improve. Rejected.

### 6.3 What the round did buy

1. **A population priced and closed.** "The reader cannot add" is now a measured claim with a sign:
   handing the addition to the product costs 10 multi-session questions, because the operand selection
   is the hard part and it stays with the reader either way.
2. **A gate that had never seen this pass.** `readout-arm-run.py` treated only `reviewPass: audit` as
   publishing the second-consultation census, so a correct `tally` artifact failed the arm audit — the
   run is red for that reason and not for a broken artifact (the roster sums to the census exactly,
   re-audited after the fix). The check is now a membership with a three-integer invariant: `refused`
   is **required** under `tally` and **forbidden** under `audit`, and `changed + refused ≤ attempted`.
   Five tests, one of them the real artifact.
3. **The literature read backwards.** TallyMem's +13.8 is a *compiled specification over a typed
   ledger*; this pass is a prose list with a number at the end of each line, and the difference between
   +13.8 and −1.45 is exactly the specification layer. The next attempt at this axis is that layer, not
   a longer prompt.

### 6.4 Status

`reviewPass: tally` is **not adopted**; the shipped default stays `bare`. Nothing in the acceptance
matrix moves: `S3` is still 83.1% against an 85.0% bar, and the cost row is unchanged. The mechanism
stays in the product as an off-by-default value, because a negative result that can be re-run is worth
more than a paragraph that says it was tried.

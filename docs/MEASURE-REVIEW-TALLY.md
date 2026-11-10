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

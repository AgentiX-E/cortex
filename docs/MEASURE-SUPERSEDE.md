# The supersession pass failed, and the reason is two of its own rules

**Read from:** `42976296380` (the `supersede` arm, 500 questions × 4 repetitions, completed 08:30Z, 08:30 of
runner time) against `42533236864` (its control, same dataset, same job, byte-identical prompt on every route but
`KU`).

**Cost:** 14.26 CNY dispatched, ~3.9% more provider calls than the control (5,936 against 5,707).

## 0. One paragraph

`K1` **fails**: **1 of 8** of the control's stable `KU` failures converted (the bar was six), with three damages on
the column, and on the eight questions the pass actually touched it repaired two and damaged two — a coin flip at
`p = 1.0`. The mechanism is inert and stays off by default. But this is not a null result, because the census and
the artifact together locate the failure precisely, and it is **not** in the premise: the correction was in the
window for 72 of 72 questions (`MEASURE-STALE-EXPOSURE.md`), the guard never saw a fabricated quote (zero
`no-quote`, zero `not-in-evidence`, zero `date-not-on-line`), and every one of the ten questions the reader did
identify was identified **correctly** — span in the evidence, date on the same line. The failure is in two rules I
wrote: an instruction that told the reader a wrong `yes` is worse than a wrong `no` (it answered `no` on 62 of 72),
and a quote ceiling meant to stop a sentence from being substituted (it refused 6 of the 10 correct identifications
on length alone, two of them gate targets).

## 1. The gates

| # | verdict | reading |
| --- | --- | --- |
| `K1` | **fails** | 1/8 converted (bar 6), 3 regressions on the `KU` column — exact `p = 1.0`, flip-floor `p = 0.187` |
| `K2` | holds | no other capability outside its own 2 sd |
| `K3` | holds | 0 non-`KU` `promptDigest` differences |
| `K4` | holds | replaced 19, refused 269 — the pass fired and the guard fired |
| `K5` | holds | prompt **+6.6%**, completion **+1.8%** |

`K4` and `K5` are the interesting passes: the mechanism ran on every `KU` question (288 consultations, four
repetitions of 72), it substituted 19 times, and it cost almost nothing because the second call shares a
byte-identical evidence prefix — 21.77M of 22.92M prompt tokens were cache hits.

## 2. Where the movement came from

| population | n | repairs | damages | net |
| --- | ---: | ---: | ---: | ---: |
| questions the pass touched (≥1 replacement) | 8 | 2 | 2 | 0.00 |
| questions it did not touch | 64 | 1 | 1 | 0.00 |

The one repair and one damage among the untouched are the flip floor: 4.1% of 72 questions is three, and this is
two. So **the entire net effect of the pass is a wash on its own population**, and the column-level `+0.35` points
is the arithmetic of two coin flips.

Per question, on the eight it touched:

| question | control | treatment | replacements |
| --- | ---: | ---: | ---: |
| `830ce83f` | 1.00 | 1.00 | 4 |
| `2698e78f` | 1.00 | 1.00 | 4 |
| `9bbe84a2` | 1.00 | **0.25** | 3 |
| `4b24c848` | 1.00 | 1.00 | 2 |
| `852ce960` | 0.50 | **1.00** | 2 |
| `a1eacc2a` | 0.00 | **0.50** | 2 |
| `031748ae` | 1.00 | **0.75** | 1 |
| `e493bb7c` | 1.00 | 1.00 | 1 |

## 3. The census

```
attempted 288   replaced 19   refused 269
refusals: no-change 242, too-long 27, no-quote 0, agrees 0,
          not-in-evidence 0, date-not-on-line 0, unreadable 0
```

`19 + 269 = 288` — the identity holds, and it is the first time this campaign has read a pass's own guard as a
*measurement of the reader* rather than as a bookkeeping check. Three of its four checks never fired: the reader
never invented a span, never quoted one that was not in the evidence, never attached a date from another line. The
fourth — "is there a later version at all" — fired **242 times**.

## 4. Cause one: the instruction argued for the wrong answer

The prompt ends with:

> `CHANGED: no` when the evidence never restates this fact with a different value. **That is the common case and a
> wrong `yes` is worse than a wrong `no`.**

Read against the measurement that mattered — the correction is present in **72 of 72** windows — that sentence is
false about this population, and it was written to be conservative about a cost that the arm had already priced.
The reader obeyed the emphasis: **62 of 72** questions came back `CHANGED: no` in the last repetition's recorded
output, on windows that provably contained a later version of the fact.

This is not a hypothesis about the model's temperament. It is the only way to read 242 `no-change` refusals on a
population where the structural instrument says the correction is in the window every single time.

## 5. Cause two: the ceiling refused the answers that arrived

Ten questions came back `CHANGED: yes`. In all ten the span was a character-for-character substring of the evidence
and the date was on the same line — so all ten reached the length check, and six of them failed it:

| question | first answer | span | ceiling | refused | gate target |
| --- | --- | ---: | ---: | --- | --- |
| `9bbe84a2` | `level 150` | 9 | 20 | no | |
| `2698e78f` | `I see Dr. Smith every week` | 26 | 52 | no | |
| `a1eacc2a` | `seven short stories …` | 35 | 70 | no | ✓ |
| `830ce83f` | `My friend Rachel …` | 62 | 80 | no | |
| `ed4ddc30` | `20 dozen` | 22 | **20** | **yes** | **✓** |
| `a2f3aa27` | `1250` | 29 | **20** | **yes** | **✓** |
| `0ddfec37` | `15` | 75 | **20** | **yes** | |
| `10e09553` | `7` | 36 | **20** | **yes** | |
| `dad224aa` | `7:30 am` | 41 | **20** | **yes** | |
| `7401057b` | `Two free night's stays …` | 80 | **44** | **yes** | |

For the four rows that passed, the artifact's recorded answer **is** the substituted span, so the ceiling shown is
derived from the span itself and those rows are here for completeness rather than as evidence. The six refused rows
are the evidence: for them the answer never changed, so the recorded answer is the first one.

`quoteCeiling = min(80, max(20, 2 × len(first answer)))`. On a four-character answer the ceiling is twenty
characters, and a clause is longer than twenty characters. `ed4ddc30` was refused by **two characters** —
`30 dozen at the moment` against a ceiling of twenty — and `a2f3aa27` was refused while answering
`I think I'm close to 1300 now` against a gold of `1300`.

**So two of the eight gate targets were identified correctly and then thrown away by the guard**, and one of the
eight converted.

The census agrees with the table to within three: six questions refused on length, four repetitions each, is
twenty-four of the twenty-seven `too-long` refusals, and the remaining three are repetitions of questions whose
last recorded output happened to say `no`. `K1` did not fail because the reader could not find the update; it failed because the pass is
built so that finding it is not enough.

## 6. Why the ceiling existed, and why it is the wrong instrument

The ceiling was added for a real defect: an earlier draft let a 47-character sentence replace a four-character
answer, which is a different answer *shape* graded against a value. The repair was to bound the length. The repair
was wrong in kind: the defect is that **the substituted thing should be the value, not the quotation**. A span is
how the reader demonstrates it copied; it is not what should become the answer.

`dad224aa` shows the second face of the same mistake: its span is `I like to wake up at 7:30 am on Saturdays`,
which restates the first answer's own value. A length rule cannot tell a restatement from an update — both are
long, and one of them is not a change at all. Only comparing the **value inside the span** to the first answer can.

## 7. What this does and does not say

- **It does not refute the premise.** The correction is in the window 72/72 and 8/8 of the gate's population. The
  family of mechanisms the pass belongs to is still unrefuted; this member's implementation is refuted.
- **It does not say the reader cannot do the comparison.** Every `CHANGED: yes` was correct. The reader's
  precision on the ten it answered is 10/10 for the two checkable fields, which is the strongest statement any
  increment in this campaign has produced about a reader's ability to audit its own substitution.
- **It does say the pass is inert as built**, and per this campaign's rule a mechanism that moved nothing is not
  enabled. `reviewPass: supersede` stays an experimental mode; nothing ships it.

## 8. The next arm, pre-registered before the fix

Two changes, both mine, both zero-cost to implement, and the same `6/0` bar — one arm, ~14 CNY:

1. **Delete the asymmetry sentence.** The instruction states the question and the output format and says nothing
   about which error is worse. The population fact (the correction is present 72/72) is the reason.
2. **Replace the ceiling with a value rule.** The substituted answer becomes the numeral the span shares with
   nothing in the first answer: the span must contain at least one numeral that the first answer does not, and that
   numeral is what gets substituted. `I think I'm close to 1300 now` then yields `1300`, and `30 dozen at the
   moment` yields `30`. A span with no new numeral is refused as `restates` — a new reason, counted separately,
   because `dad224aa` is not a fabrication and not a length problem.

Registered criterion, unchanged from §13.366.1 in shape: **≥ 6 of the control's 8 stable `KU` failures convert, and
no `KU` regression**. If the two changes together do not clear it, the mechanism is refuted as a member of its
family and the queue moves to `assemble()` — that decision is written here so that a second inert arm cannot be
read as "one more tweak away".

## 9. Reproducing

```
python3 tools/supersede-reading.py \
  --treatment art-42976296380/benchmark-cortex-memory-ablation-report.json \
  --control   art-42533236864/benchmark-cortex-memory-ablation-report.json
python3 tools/stale-exposure.py \
  --artifact art-42533236864/benchmark-cortex-memory-ablation-report.json \
  --dataset data/longmemeval_s_cleaned.json
```

The first prints the five gates and the per-capability table; the second prints the premise the first one's
diagnosis depends on. Neither dispatches anything.

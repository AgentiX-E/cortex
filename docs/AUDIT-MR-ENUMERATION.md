# What the multi-session route is actually losing, read from one artifact

A reading of `41284575092` — `48,000` prompt characters, `ellipsis` turn cap, thinking on
`multi-session` and `temporal`, four repetitions, `449 / 500`. Its purpose was to answer a question the
two dispatches before it could not: **is MR losing evidence, or losing arithmetic?**

The answer is neither, in the form the question assumed, and the reading is written down because the
two candidate repairs that follow from the wrong answer were both implemented before this file existed
— one of them shipped to a PR and reverted, the other built and measured and not dispatched.

## 1. The aggregate never errs. The set does.

`ENUMERATION_CONTRACT`'s Step 2 says *"compute the answer from that list … Do not re-filter the list at
this step"*, and Step 1 is the list. Across the twenty-two MR questions wrong on all four repetitions,
**the recorded answer equals the number of Step 1 lines in twenty-two of twenty-two**:

| question | gold | answer | Step 1 lines |
| --- | --- | --- | --- |
| items of clothing to pick up or return | 3 | 2 | 2 |
| movie festivals attended | 4 | 3 | 3 |
| weddings this year | 3 | 5 | 5 |
| times I baked in two weeks | 4 | 5 | 5 |
| properties viewed before the Brookside offer | 1 | 5 | 5 |
| art events this month | 4 | 2 | 2 |
| kitchen items replaced or fixed | 5 | 4 | 4 |

The four rows where the answer is *not* the line count are the four whose Step 1 is empty or prose: a
total over amounts, an elapsed time, a page count. Those are §2.

**Consequence.** Every increment aimed at Step 2 — a better aggregation wording, a second pass that
re-reads the list, a prompt that asks the model to double-check its arithmetic — is aimed at a step
that has not made an error in this run. The list is the whole of the treatment.

## 2. All twenty-eight are numeric golds, and ten of them are not counts

`MR` is `121` questions, of which `105` have a gold that *begins* with a number (`3`, `$3,750`; a gold
like `I attended four movie festivals` does not count here — §3 uses a wider test and reads `109`, and
that is why the two totals differ). **All twenty-eight failures are among those `105`**; the sixteen MR
questions whose gold is a name, a place, or a list are correct on all four repetitions.

The twenty-two stable failures split by what the answer actually is:

| shape | n | examples | Step 1 lines |
| --- | --- | --- | --- |
| count, off by ±1 or ±2 | 12 | clothing 3→2, festivals 4→3, art events 4→2, kitchen 5→4 | 1–5, equal to the answer |
| total of additive quantities | 6 | charity total 3750→8750, workshops 720→700, views 1998→1456, page count 856→1, years of education 10→4, money earned 495→1 | **0–2** |
| derivation from two operands | 4 | discount 20%→1, age when Alex born 11→1, years since college 7→1, weekly hours 50→40 | **0–1** |

The bottom two rows are the mechanism `OPERAND_CONTRACT` was written for (§13.166): *"identify the
numbers this question needs"*, with **a sum** among its named operations. Its docblock says the contract
is correct and the classifier does not route these questions to it. That is still true, and §6 is what
happens when it is repaired.

## 3. Evidence coverage is not the bottleneck

For every question whose gold contains digits anywhere — `109` of MR's `121`, a wider test than §2's
"begins with a number" and the reason the two totals differ — the reading checks whether **the gold's
digits appear anywhere in the offered evidence**:

| capability | gold value present, and correct | present, wrong | absent, correct | absent, wrong |
| --- | --- | --- | --- | --- |
| `MR` | 61 | **18** | 25 | 5 |
| `KU` | 34 | **4** | 0 | 1 |
| `TR` | 61 | **1** | 2 | 0 |
| `IE` | 45 | **0** | 0 | 0 |

`absent, correct` is the large MR cell and it is not a defect: a total, a difference, an average, and an
elapsed time are values that no turn states, which is the premise of the operand contract.

**The cells that matter are `present, wrong`: 18 of MR's 22 stable failures have the answer's own digits
in the window.** The `48,000`-character budget discards two thirds of the haystack and it is still not
what costs MR its points. Any repair aimed at retrieval — a wider top-k, a second index, a reranker —
is aimed at a cell that is already mostly filled.

This is also the point where `AUDIT-BENCHMARK-WALLCLOCK.md` §5's first bullet stops being an
uncomfortable footnote and becomes a limit on the reading itself: the digest `datasetFingerprint` now
records did not exist when this artifact was produced, so all of it is comparable only to itself.

## 4. Knowledge update is the capability nobody has looked at

`KU` is `72` questions and reads `63` on this run, and `61–62` on the two dispatches beside it. Its
seven stable failures are one shape:

| question | gold | answer |
| --- | --- | --- |
| pre-approved mortgage amount | `$400,000` | `$350,000` |
| Instagram followers now | `1300` | `1250` |
| pre-1920 coins in the collection | `38` | `37` |
| usual time at the gym | `6:00 pm` | `7:00 pm on Mondays, Wednesdays, and Fridays` |
| where the old sneakers are now | `in a shoe rack in my closet` | `Under my bed` |
| do I go to the gym more than before | `Yes` | declined in prose |
| kitchen gadget before the Air Fryer | `Instant Pot` | declined in prose |

**Five of the seven answered with the superseded value.** The instruction block already carries the
four sentences that forbid it — *"Some evidence may state a value that was later changed … Use the
evidence with the latest date"* — and the evidence is **time-monotone on all 72 questions**, so the
ordering is not fighting the model.

The coins row is different and is the only one of the seven that no wording can reach: `38` appears
**nowhere** in the offered evidence, and `37` does. This paragraph read that as *"the turn carrying
the update was discarded by the budget"* and made a `KU`-aware retention rule a registered increment
(§13.211.3, P1).

**That reading is wrong, and §13.213.4 is the correction.** Read against the artifact's own
`promptTexts`, all seven of these questions carry the gold-bearing content: the coins question's
`37` is stated in block 25 and the update is in block 45 — *"I just added a new coin to my collection
of pre-1920 American…"* — so `38` is a **derivation** (`37 + 1`), not a turn that fell outside the
window. The retention rule would have changed none of the seven, and it is withdrawn. What replaces
it is a delta step in the counting contract, which is where the arithmetic lives.

## 5. Three offline grounded checks, and why all three were worthless

Before any of §6, the obvious question was whether the enumerated items are *real*. Three checks were
run over the artifact itself, and all three have no discriminating power:

| check | stable-wrong | stable-right | verdict |
| --- | --- | --- | --- |
| token coverage of each item against the evidence | 100% of items ≥ 0.5 | 100% of items ≥ 0.5 | no signal — a 12,000-token window contains every common word |
| longest contiguous token run of each item present in the evidence | median 5–6, 39.3% below 5 | median 5–6, 39.1% below 5 | no signal — items are paraphrases, not quotations |
| item dates vs the evidence's own timestamps | — | — | no signal — a session's turns share a date |

The third check is the interesting failure. On `gpt4_...` weddings, **all five enumerated lines carry
the same date `2023/10/15`**, which is the date of the session, not of the five weddings — and the
session genuinely does have turns on `2023/10/15`, so a timestamp check accepts every line.

**What this establishes is a requirement rather than a result:** groundedness on a long evidence block
cannot be audited after the fact from a transcript. It can only be produced, by asking the reader for a
quotation and checking the quotation — which is a *format* change and is registered, not shipped,
because the seventeen archived artifacts could never be re-read that way.

## 6. The classifier widening: measured, and not dispatched

§2's second and third rows say the classifier does not reach them. Extending `DERIVATION` to read
totals as derivations — a `total <quantifier>` marker that must co-occur with an additive noun, plus
`<quantity> count` — was implemented, unit-tested, and then **measured against the run before being
dispatched**. It reaches **19 MR questions that are currently on the enumeration contract**:

| pattern | newly reached | currently correct | currently wrong |
| --- | --- | --- | --- |
| `in total` / `altogether` / `combined` | 6 | 4 | 2 |
| `total <quantifier>` | 10 | 7 | 3 |
| `page count` / `word count` / `view count` | 1 | 0 | 1 |
| **total** | **19** | **13** | **6** |

**Thirteen correct questions would be re-contracted to reach six wrong ones**, and no sub-pattern in the
table has an upside larger than its downside. The distinguishing feature between the two groups is not
in the question text — both classes are phrased as totals over a period, and the difference is in the
evidence and the gold — so no classifier can separate them from the question alone.

The change was reverted. What ships from it is the parity test `question-shape-parity.test.ts`: the
classifier's docblock had claimed a guard in the other package that did not exist, and had the
dependency direction backwards. The test pins the shipped boundary question by question, so the next
widening is a failing test and a measurement rather than an edit.

## 7. Four prose declines the retry cannot see

`reviewPass: 'bare'` re-asks a question when the reply is a bare `INSUFFICIENT_EVIDENCE`, and
`isBareDecline` is what decides. Across the run there are **forty prose declines** — replies that say
*"cannot be determined"*, *"the evidence does not state"*, *"insufficient"* — of which thirty are `ABS`
and correct, and **ten are elsewhere and eight of them are wrong**, including four MR questions whose
gold is a number.

A prose decline is not a bare token, so the retry does not fire on any of them. This is a real gap and
it is **not** registered as a fix, because two of the four MR cases are declines that are *right* about
the evidence (`38` is absent; the novels' page count is absent), so a retry would spend a call to turn a
correct refusal into a wrong number. The gap is recorded here as a fact about the census: `bareRetry`
counts attempts, and a decline in prose is invisible to it.

## 8. What this leaves

The numbers say the remaining MR loss is not evidence, not aggregation, and not the classifier — it is
the reader's own enumeration over a long window, which is the one thing this list of readings has not
been able to move with any instrument available to it. That is a statement about the instrument, and
the next increment is chosen accordingly:

1. **A strong reader, measured** (P0). The contract's requirement is that a reasoning model scores
   better than a non-reasoning one on the same contract and the same window. `deepseek-chat` with
   thinking enabled is one model; the run has never been repeated with the provider's reasoning model
   on the same artifact, so the requirement is **unmeasured** rather than satisfied. This is the only
   registered change that could plausibly move twenty-two stable questions at once.
2. ~~**A `KU` retention rule** (P1).~~ **Withdrawn in §13.213.4**: seven of seven carry the
   evidence, so there is no dropped update turn to retain. Kept here, struck through, because the
   reading it rested on was made in good faith and its correction is the point. The original text
   read: one question is provably unfixable without it (`38` absent), five
   are supersession misses with both values in the window, and the instruction that forbids picking the
   old value is already there — so the treatment is a retention rule that keeps the latest turn of each
   session in the window, not another sentence.
3. **Quotation-grounded enumeration** (P2). §5 says it cannot be audited after the fact; it can be
   produced. The cost is output tokens on every MR question, and the acceptance is that a line without
   a verifiable quotation is dropped before Step 2 counts.

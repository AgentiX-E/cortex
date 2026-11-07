# The call budget: 2,071 calls, and the 71 that never earned their tokens

Requirement 8 asks whether the LLM calls this system makes are justified and whether tokens can come down
without costing accuracy. This document answers it with the ledger rather than with an opinion, and it
finds exactly one removable call — which is not the one a "reduce LLM calls" instinct would reach for.

Source: `cortex-docs/evidence/longmemeval/cost.json`, written by `tools/cost-ledger.py` from run
`42310779222`.

---

## 1. The arithmetic

| quantity | value | derived from |
| --- | ---: | --- |
| prompt tokens | 24,209,976 | `inputs.promptTokens` |
| calls | 2,071 | `inputs.calls` |
| questions | 500 | `inputs.questionCount` |
| repetitions | 4 | `inputs.runs` |
| calls a minimal configuration needs | **2,000** | 500 × 4 |
| **surplus calls** | **71** | 2,071 − 2,000 |
| tokens per call | 11,690 | 24,209,976 / 2,071 |
| **tokens the surplus costs** | **≈ 830,000** | 71 × 11,690 |
| share of the bill | **3.4%** | 830k / 24.2M |
| cache hits | 18,933,570 | `inputs.cacheHitPromptTokens` |
| cache-hit share | **78.2%** | — |

**The product path makes exactly one LLM call per question.** 2,071 against a floor of 2,000 is 3.6% over a
minimum, so there is no redundant call to remove in the pipeline: no query rewrite, no extraction pass, no
rerank call, no verification call. Whatever this arm's problems are, "it calls the model too often" is not
one of them, and a plan to reduce call *count* has 71 calls of headroom and nothing else.

That inverts the usual shape of this question. For a retrieval pipeline the levers are normally (a) fewer
calls, (b) smaller prompts, (c) cheaper model. Here (a) is exhausted, (c) is `M1`/`P1`'s question, and (b) is
blocked by a measurement: §13.291 delivered every gold turn and bought **+0.00**, which is evidence that
adding evidence does not help and **not** evidence that removing it is free.

---

## 2. The 71 calls, and what they bought

They are the **bare-decline retry**: when a reply is the abstention token and nothing else, the question is
asked once more with that token removed from the prompt.

The criterion that already exists for this mechanism is `R1`:

| | |
| --- | --- |
| metric | net correct answers gained by the recovery pass |
| reading | **−1** |
| threshold | ≥ 1 |
| status | **`accept`** — a known miss the project decided not to fix |
| `onMiss` | "Measured at 404 against 405: the pass converts one refusal and costs two. Keep `reviewPass: none` as the default; the criterion stays here so a future run cannot quietly re-enable it." |

So the ledger and the criterion disagree with the code, and the disagreement is worth stating plainly:

> A mechanism that measured **net −1** on 500 questions is still spending **71 calls and 830,000 prompt
> tokens (3.4% of the bill)** on every repetition.

Two caveats, both of which matter and neither of which changes the direction:

1. **`R1` was measured on an earlier configuration** (404 against 405 is a five-question-scale reading from
   the recovery-pass registration), so −1 is not a reading of the current arm. It is the only reading that
   exists.
2. **−1 is inside the noise floor.** One question in 500 is 0.2 points; this arm's floor is 1.6–2.2. So the
   mechanism has neither proved a gain nor proved a loss, and *that* is the actual state of the evidence.

---

## 3. The decision rule that resolves it, and why the burden is asymmetric

A change that adds a mechanism must clear the noise floor to be believed. A change that **removes** one
should not have to: the null is "this does nothing", and a mechanism that has never cleared the floor is
indistinguishable from the null while costing 3.4% of every dispatch. Applying the floor symmetrically
means keeping every unproven mechanism forever, because a null result can never justify removing it.

So the rule this document proposes — and it is general, not specific to the retry:

> **A mechanism that has never produced a reading above the noise floor is a candidate for removal, and the
> removal is accepted when a paired dispatch shows accuracy not lower than the floor. A mechanism that has
> produced such a reading is kept until a paired dispatch shows it gone.**

The retry is the first application. It has a reading, the reading is negative, and the reading is inside the
floor. On the rule above: **remove it, and let a paired dispatch be the referee.**

---

## 4. What the paired dispatch would have to show, stated before it runs

| | |
| --- | --- |
| arms | `retry: bare-decline` (current) against `retry: none` |
| dataset | LongMemEval-S, 500 questions, four repetitions |
| the number that must move | `inputs.calls`: **2,071 → 2,000** (−71), tokens −3.4% |
| the number that must not move | overall accuracy, and the five per-category readings |
| the bar | accuracy not lower by more than the floor, **and** no category down by more than 2 questions |
| if the bar is missed | the retry goes back in, and `R1` becomes a `gate` at its measured value instead of an `accept` |
| why this is worth a dispatch | it is a **removal**, it is 3.4% of every future dispatch, and its own criterion already says the default should be off |

Two things this dispatch will **not** settle, stated so that they are not read into it:

- **It does not move `T3`.** `MR` will move by whatever the retry was doing on the multi-session route, and
  the retry's own reading says that is about one question. A `T3` reading that moves by more than that is a
  different mechanism, and the paired design is what would say so.
- **It does not make the arm cheaper in the way the cost axis needs.** 3.4% is not 30%. `C2` needs the
  budget's *unit* fixed (characters, §13.293.2) and the prefix's *stability* measured; this is a rounding
  correction next to that.

---

## 5. The eval-side calls, and the one that is already minimal

| caller | calls per question per repetition | can it be fewer |
| --- | --- | --- |
| the arm's reader | 1 | no — one answer per question is the shape of the benchmark |
| the official judge | 1 | no — the judge may not be batched without changing the metric |
| `tools/cost-ledger.py` | 0 | it reads the artifact |
| the gate checker | 0 | it reads the artifact |
| `tools/acceptance-check.mjs` | 0 | it reads the artifact and evaluates the controlled set in-process |

So the eval side is also one call per question per stage, and the only lever there is the **judge's own
prompt**, which is the benchmark's, not ours — changing it would change the metric's identity and is
therefore out of scope permanently, not just this round.

The one place the eval side can genuinely spend less is **repetitions**. Four runs of 500 questions exist to
defeat the noise floor, and the floor is 1.6–2.2 points. If the campaign ever needs a 4x cheaper schedule,
the honest form is three repetitions on the primary arm and one on each ablation, with the primary's
variance reported — not two, because two cannot separate a reader effect from a repetition effect.

---

## 6. The conclusion, in one line

> **The call count is already minimal (1.0049 calls per question, against a minimum of 1.0000), the token
> count is at the arm's own character cap, and the only removable spend is a retry that its own criterion
> says should be off — 71 calls and 3.4% of the bill for a mechanism that measured net −1.**

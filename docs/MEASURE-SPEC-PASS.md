# The specification pass, dispatched: a negative result with a precise cause

**Status.** Run `42930900136`, artifact `13824633060`, 500 questions × 4 repetitions on both sides,
`deepseek-chat` as the reader, 2 h 44 m, 14.26 CNY. Control is `42533236864` (the shipped arm).
Every number below is read from the two artifacts by `tools/arm-flip-census.py` and
`tools/readout-arm-run.py`; none of it is hand-classified.

The registered predictions were `P1`–`P5` in `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.363.3.
**Four of five fail.** This file is the reading and the cause, not an attempt to rescue the pass.

---

## 1. The five predictions

| #    | prediction                                    | measured                                                | verdict                               |
| ---- | --------------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| `P1` | `MR` ≥ +2.0 points                            | **−39 questions** (repair 6, damage 45), p = 1.8 × 10⁻⁸ | **fails**, and in the wrong direction |
| `P2` | damage ≤ 3 questions                          | **45**                                                  | **fails**, 15× the ceiling            |
| `P3` | `attempted` ≥ 60 and `refused` ≤ 40%          | `attempted` **341**, `refused` **127** = 37.2%          | **holds**                             |
| `P4` | completion tokens ≤ +20%                      | **+133%** (2,301,401 → 5,361,716)                       | **fails**                             |
| `P5` | ≥ 2 of the net repairs on high-load questions | 6 repairs in total, so at most 6                        | **vacuous** — there is no net repair  |

Overall accuracy: **83.40%** against the control's **91.20%**, a loss of 7.8 points on 500 questions.

`P4` has a second half that matters more than the headline. Prompt tokens moved **+0.15%**
(21,497,392 → 21,530,494) across an extra 285 calls, which is the structural claim in
`MEASURE-SPEC-CEILING.md` §5 confirmed: the plan prompt is bounded by the question, not by the
window. What cost 133% was **completion**, and it was not the plan: it is the second consultation
plus the judge's reading of it. The design was right about where the cost would not be and wrong
about where it would.

---

## 2. The four groups, and what each one says

The split was frozen to `tools/spec-reachability-groups.json` **before** the dispatch.

| group                 |   n | repair | damage | reading                                                                                                                                                                                                                                                                              |
| --------------------- | --: | -----: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `question-vocabulary` |   8 |  **3** |      0 | 3 of the 8 questions a plan can reach from the question's own words were repaired. The contract is followed on 37.5% of the population it was written for.                                                                                                                           |
| `history-only`        |   4 |      1 |      0 | one question reached only by a word the history supplies was repaired without being named.                                                                                                                                                                                           |
| `unreachable`         |   5 |  **1** |      0 | one of the five the grammar cannot reach was repaired anyway — a contradiction of the ceiling measurement worth recording: the plan search was over the control's failures, so a plan that fails to reach the gold can still produce a _better wrong answer_ that the judge accepts. |
| `no-numeric-gold`     |   3 |      1 |      0 | not the instrument, as registered.                                                                                                                                                                                                                                                   |
| `unclassified`        | 101 |      0 | **45** | the damage side, structurally, and it is 15× the registered ceiling.                                                                                                                                                                                                                 |

Identity: **20 grouped + 101 unclassified = 121 graded; repair 6 − damage 45 = net −39 — PASS.**

**The grouped repair is real and is not the problem.** Six questions moved from wrong to right
through the grammar, three of them on the population the prompt was written for. The problem is
entirely on the other side, and it is not random: the treatment broke **45 of the 101 questions
the control answered correctly**.

---

## 3. Why the damage, in the artifact's own words

The `answer` field is the executor's output, and it is what the judge reads — this was checked
rather than assumed, because a `rawOutput` carrying the plan JSON looks at first like a scoring
pipeline defect. It is not. `rawOutput` holds the plan; `answer` holds what the plan computed; the
four questions below are the shape of every one of the 45.

| question        | control    | treatment | gold           | the plan that produced it                     |
| --------------- | ---------- | --------- | -------------- | --------------------------------------------- |
| `0a995998`      | `3` ✓      | `2`       | `3`            | `text contains "items"` + `sum`               |
| `b5ef892d`      | `8 days` ✓ | `15`      | `8 days`       | `text contains "camping"` + `sum`             |
| `gpt4_f2262a51` | `3` ✓      | `2`       | three doctors  | `text contains "doctors"` + `number unit-is`  |
| `gpt4_a56e767c` | `4` ✓      | `3`       | four festivals | `text contains "attended"` + `number unit-is` |

Every one is **syntactically valid and semantically too wide**. `scope: [0, 241]` is the whole
history; `text contains "items"` matches every turn that says "items"; `sum` then adds a slice of
the conversation. The executor is faithful — it computes exactly what the plan says, and the
plan's predicate is the defect.

And the control was not lucky. Its answers on these questions are **enumerations**:

```
Step 1 — Matching items:
- Navy blue blazer | pick up | 2023/02/15
- Old pair of Zara boots | return | 2023/02/15
```

The reader had already listed the evidence, with dates, and then counted it correctly. `spec`
replaced a listed enumeration — a form that is delivering on these questions — with an arithmetic
result computed from a wider predicate.

> **This is not a grain problem and it is not a vocabulary problem. It is a substitution problem:
> the pass replaces an answer without asking whether the answer it is replacing is any good.**

That distinction matters because §13.363.4 pre-registered the grain explanation, and the grain
explanation is **not** what happened. The pass can express the answers; it chose to overwrite
answers that were already right.

### 3.1 The obvious guard is not enough, measured before writing the guard

The natural first move is a shape floor: an answer that is already an evidence enumeration — a
bulleted line carrying a date — is not a candidate for replacement. Both artifacts can be read to
find out whether that would work, so it was read rather than assumed. Classification: a reply whose
first-pass text contains both a `-`/`*` line and a `YYYY/MM/DD` date.

| population                        |   n | enumeration-shaped first-pass answer |
| --------------------------------- | --: | -----------------------------------: |
| control's correctly answered `MR` | 101 |                       **73** (72.3%) |
| broken by the treatment           |  47 |                       **43** (91.5%) |
| repaired by the treatment         |   8 |                        **5** (62.5%) |

So the floor protects 91.5% of the damage **and discards 62.5% of the repair**, which nets to
3 repairs against 4 breaks — still negative, on a single-pass count that is smaller than the
census's 45.

> **One guard cannot rescue this mechanism.** The shape floor separates the cases badly, and it
> separates them badly for a reason worth stating: the five repairs it would discard are questions
> whose first-pass answer was a **wrong short value** (`0` where the gold is `2`, `Walmart` where it
> is `Thrive Market`), and no property of the first-pass _text_ distinguishes a wrong short value
> from a right one. Shape is the wrong axis.

A second signal exists and has not been tested: whether the first-pass answer appears inside the
executor's `support`. If it does, the plan computed over the same evidence the reader already used,
and the enumeration should win; if it does not, the first pass was inferring and the computation
should win. That signal is available to the treatment without seeing the control, it is a property
of the _relation_ rather than of the shape, and it requires implementation before it can be
measured — which is why it is named here as the next increment rather than claimed as a fix.

---

## 4. What the reading licenses

Three things, in order of how cheap they are.

1. **A floor on the substitution, which is eight lines and costs nothing to evaluate — and which §3.1
   already shows is insufficient on its own.** The support-membership signal in §3.1 is the shape the
   floor has to take: a property of the relation between the two answers, not of either answer's text.
   Both are testable offline against the two artifacts that already exist, before any dispatch.
2. **Keep `P3` as an established fact.** `attempted` 341 of 500 with 37.2% refusal means the
   grammar is _reachable in practice_ at a rate the registration predicted. The parsing, the
   refusal codes and the rendering all worked. What failed is a decision about when to speak.
3. **`spec` stays off by default, and `tally` stays off by default.** Two passes have now been
   dispatched that lose points on `MR` (`tally` −9.5, `spec` −7.8 overall). The mechanism that
   repairs aggregation questions is still not found, and two negative results are a better
   position than one unfalsified claim.

---

## 5. What this reading does not license

1. **It does not say arithmetic over a ledger is wrong.** It says arithmetic over a _wide_
   predicate, substituted for an enumeration that was already correct, is wrong. The six repairs
   are the existence proof for the other half.
2. **It does not retire the annotated ledger.** The five `unreachable` questions still cannot be
   reached by this grammar, and the one that was repaired was repaired by a plan the ceiling
   search did not find — which means the ceiling is a lower bound in a second way, and the
   event-level ledger still has its own work to do.
3. **It does not price the substitution floor.** That is one more 500 × 4, and it should not be
   dispatched until the floor is shown offline to separate the six repairs from the forty-five
   breaks on the artifacts that already exist.

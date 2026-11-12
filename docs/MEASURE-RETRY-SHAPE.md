# The dump that was a parser's reading

Run `43121298653` was dispatched to catch the 15 evidence dumps `MEASURE-COMPETITOR-PAIRING.md` section 4 counted, and
recorded `replyRepair.echo.attempted: 0` on all 500 questions. `MEASURE-ECHO-REACH.md` explained the zero with the call
arithmetic. This file answers the question that leaves open: **if the gate never fired, why do 14 replies still look
like dumps?**

They do not. The parser read them as dumps, and the parser was reading a shape this arm's own prompt had just changed.

## 1. The measurement

`answer` is the parsed string the judge scores. Across the 500 questions of the control artifact, **16 answers contain a
line-initial `[YYYY/MM/DD` stamp** — evidence text that `parseAnswer` was supposed to strip and did not:

| artifact | answers carrying a stamp | of which classified `evidence-echo` on `rawOutput` |
| --- | ---: | ---: |
| `42533236864` (control) | 16 | 15 |
| `43121298653` (echo arm) | 16 | 14 |

The 16th (`71a3fd6b`) carries a stamp mid-answer rather than on half its lines, so the majority-of-lines rule does not
call it a dump. So the population is 16 questions, and it is the same 16 in both runs.

## 2. Why those 16 are retry replies, by construction

`parseAnswer` applies `afterLastStepHeading` before the closing-label rule, and `ENUMERATION_STEP_HEADING` matches
`^\s*step\s*\d+\s*[\u2014:-]`. Every contract in `CONTRACT_INSTRUCTIONS` that asks for a list asks for it **as a step**
— `Step 1 — list every item …`, `Step 2 — compute …` — so a first-pass reply that writes the list has its list stripped
before the answer is read.

`buildRetryPrompt` and `buildCommitPrompt` were the two builders that ask for a numbered list **without** a step
heading:

```ts
'Write the items in the evidence that match the question as a numbered list first, one per line, each with the',
'date it was stated, then compute the answer from that list.',
'Reply with the answer alone on the last line.',   // <- a sentence, not a label
```

`CLOSING_ANSWER_LABEL` is `^\s*(?:final\s+)?answer(?:\s*[:-\u2013\u2014])\s*`. Neither builder produced a heading for
the first rule nor a label for the second, so on these two paths the list, the blank line and the answer concatenated
into one string and that string became `answer`.

Therefore: **a stamp in `answer` means the reply came from a builder with no step heading**, and the only such builders
are the retry and the commit. The 16 are retry replies — which is the same conclusion `MEASURE-ECHO-REACH.md` reached
from the call count, arrived at from the text instead. Two independent routes to one number.

## 3. What this corrects

`MEASURE-COMPETITOR-PAIRING.md` section 4 reported `evidence-echo` at 15 questions, 8 wrong, 53.3%, against 7.1% for
committed answers, and read that as *"the evidence written back is the worst reply form"*. The wrong-rate is real; the
attribution is not. Reading the 16 by hand:

| what the reply actually contains | n |
| --- | ---: |
| a stamped list followed by an answer line | 16 |
| a stamped list and nothing else | **0** |

**There is no dump in this corpus.** Every one of the 16 ends with an answer; the answer is sometimes right
(`75832dbd` → `NeurIPS, CVPR, ICML, ICLR, and ICCV`) and sometimes an older value or a refusal (`5d3d2817`,
`cc539528`), but it is always there. The 53.3% wrong-rate belongs to *being retried* — the retry runs only on questions
whose first reply was a bare decline, which is a population selected for difficulty — and not to a reply form.

That is the same defect class as `sections 3.1 and 4` were written to correct: a measurement whose name asserts a
mechanism the data does not contain.

## 4. The repair, and why it is the smallest one that binds

All three list-asking builders now close on

```
End your response with a single line in exactly this form, and write nothing after it:
Answer: <the answer>
```

`buildShapePrompt` already asked in exactly this form, so this removes an inconsistency between three builders rather
than introducing a fourth format. Nothing the model is asked to *do* changes — list first, then compute — only the
shape of the line that says which is which, and `parseAnswer` already reads both the heading rule and the label rule
that make the shape readable.

The proposal is pinned in `packages/cortex-memory/src/__tests__/retry-shape-label.test.ts` (7 tests): each of the four
builders ends on the label; a stamped list plus `Answer: 20%` parses to `20%`; the same list with a prose close parses
to the whole reply, which is the pre-repair behaviour recorded rather than deleted; a bare `Answer:` with nothing after
it parses to the empty answer.

## 5. The arm this licenses, and its ceiling

| item | value |
| --- | --- |
| variable | the closing line of `buildRetryPrompt` / `buildCommitPrompt` / `buildEchoPrompt`; nothing else changes |
| added calls | **0** (same 2,000 + retries; the prompt grows by 47 characters on the 75 retried questions) |
| criterion 1 | answers carrying a line-initial stamp: 16 → **0** |
| criterion 2 | total correct ≥ **455** (control 456; this is a parser repair and must not buy points by accident) |
| criterion 3 | the 30 `bare-decline` questions stay **30/30** |
| criterion 4 | `bareRetry.answered` ≥ **70 / 75** |
| cost | one dispatch, ~14 CNY |
| terminal | criterion 1 unmet: the label is not what the parser lacked, and the 16 stay as the record |

Criterion 2 is a **non-inferiority** bound, not an improvement target. A parser repair that moves the score by +4 would
mean the judge had been scoring dumps as answers, and that would need its own file.

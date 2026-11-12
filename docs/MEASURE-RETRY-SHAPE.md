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

## 6. The dispatch, and all four criteria met

`43140878641`, 500 questions, four repetitions, one variable (the closing line of three builders), 70 retries.

| criterion | threshold | reading | |
| --- | --- | --- | :---: |
| answers carrying a line-initial date stamp | 16 → **0** | **0** | pass |
| total correct | ≥ **455** | repetitions **457 / 456 / 454 / 458**, mean **456.25** | pass |
| the 30 `bare-decline` questions | **30/30** | **30/30** in all four | pass |
| `bareRetry.answered` | ≥ **70** | **70 of 70 attempted** | pass |

Against the control (`42533236864`, repetitions 456 / 453 / 457 / 455, mean 455.25) the net is **+1.00 question**
(0.20 points), which is inside the arm's own draw spread and is reported as such. Paired over 2,000 question-repetitions
the movement is **33 converted, 29 broken**, and by question **19 up, 16 down** — so the repair is real at the level it
was aimed at (16 unparseable replies became parseable) and noise-level at the level of the score.

| capability | n | control mean | feature mean | delta |
| --- | ---: | ---: | ---: | ---: |
| `IE` | 150 | 141.25 | 138.50 | **−2.75** |
| `MR` | 121 | 100.50 | 102.00 | +1.50 |
| `KU` | 72 | 62.75 | 63.50 | +0.75 |
| `TR` | 127 | 120.75 | 122.25 | +1.50 |
| `ABS` | 30 | 30.00 | 30.00 | 0.00 |

The one named conversion this file can claim is `852ce960` (`0110 → 1101`), the mortgage pre-approval question that
`MEASURE-KU-STALE.md` reads as a stale twin: it is wrong in two of four repetitions under the control and right in three
under the repair. `89941a93` also recovers (`1011 → 1101`), which matters because that is one of the two questions the
`conflicts: true` block broke. Neither is claimed as a mechanism: the variable here is which line the parser reads.

`IE`'s −2.75 is the cost and it is the one number a reader should check first, since `IE` is the capability with the
least room (150 questions, 95.0% mean). Four questions going `1111 → 1011`/`1010` is what that delta is made of, and
22 of the 29 broken repetitions are inside `IE` and `MR` while 26 of the 33 conversions are in `MR` and `TR`.

**Adopted**, because the four criteria were written before the dispatch and all four were met, and because what it
repairs is a parser reading rather than a model behaviour. The transcript story closes with it: there never were
answers that were pure transcripts, and now there are no answers that *look* like them either.

### 6.1 The configuration this run carried, and why the evidence files still describe the older one

`registration-attest.py` **refuses** `43140878641`, and the refusal is correct rather than noise:

```
  applied    sha256:9da51cc2…87732a
  registered sha256:0c6c25e7…480075  (run 42533236864, adopted by §13.336)
```

The diff of the two artifacts' `memoryArmConfig` is two keys of 33, and both are **defaults written out**:

| key | `42533236864` | `43140878641` |
| --- | --- | --- |
| `conflicts` | absent (default `false`) | `false` |
| `replyRepair` | absent (default `off`) | `off` |

So the two runs are behaviourally the same configuration and the fingerprint differs because the projection now
carries the two switches explicitly — which is the documented failure mode of a hash over a projection
(`ACCEPTANCE-MATRIX.md` §2.3: "the fingerprint decides and the difference list only diagnoses"). The consequence
is stated rather than worked around: **`cost.json`, `categories.json` and `frontier.json` still describe
`42533236864`**, and refreshing them requires `arm-config-record.py --record` in the change that adopts this run as
the shipping baseline — in that order, because the second is what makes the first true. That change is not this
one; a label repair that also silently re-bases five acceptance rows would be two changes wearing one commit.

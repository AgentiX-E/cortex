# The correction is in the window, and the reader does not treat it as one

**Read from:** `42533236864` (the arm's control: 72 `KU` questions × 4 repetitions), the per-question windows
that artifact records verbatim, and `data/longmemeval_s_cleaned.json` (`sha256:d6f21ea9…`, the fingerprint the
artifact carries).

**Cost:** zero. Nothing here dispatches; every fact below is a comparison of two lists of strings that were
already paid for.

## 0. One paragraph

The supersession pass is justified by a sentence that had never been a column: *the correction is already in
front of the reader, and the reader does not treat it as a correction*. If that sentence were false — if the
corrective turn were not retrieved for most failing questions — then a prompt-level pass could not help, and the
conversion bar in §13.366.1 would be unreachable by construction rather than by outcome. Measured: **72 of 72**
`KU` windows carry both the statement that was replaced and the statement that replaced it, and **8 of 8** of
the gate's own population (the control's stable failures) do. The obvious rival explanation — the obsolete value
has a better position in the window — is **refuted**: one window in 72 shows the correction first, and that
question is answered correctly. What is left is a reader that meets two statements about one slot, in
chronological order, ending on the correction, and returns the value the correction replaced. That is the
failure the pass is built for, and it is now a measurement rather than a belief.

## 1. Why this could be measured before the arm ran out

Two facts already on disk, and nothing else:

- `questions[].turns[]` in the artifact is the **window itself** — the exact text the reader was handed, with the
  date and speaker prefix on each turn. It is written for every question, in reading order.
- `answer_session_ids` in the dataset names the sessions that carry the two values of an update question, and
  `haystack_dates` dates each of them. All 72 `KU` questions have exactly two, and no two of them share a date.

So *"was the correction in the window"* is the question *"does any window turn reproduce a turn of the later
answer session"* — string equality after whitespace collapse, in both directions between the two lists. No
model, no judge, no dispatch.

## 2. The four states, and the one that matters

| state | questions | a wrong answer there means |
| --- | ---: | --- |
| `both` — obsolete and correction both present | **72** | reading failure: the pass's population |
| `earlier-only` — the correction is missing | 0 | retrieval failure; no prompt reaches it |
| `later-only` — the obsolete value is missing | 0 | retrieval failure of the other end |
| `neither` | 0 | retrieval failure, and probably a different one |
| `single-session` | 0 | not an update question with two ends |

**0 of 72** `KU` questions can be attributed to retrieval, and the same holds on the gate's population:
**8 of 8** stable failures are `both`. That closes the objection that would have voided the arm before its
result arrived, and it is the first time in this campaign that a mechanism's *premise* has been checked against
an artifact before the mechanism's *effect* was.

## 3. The rival explanation, and its refutation

A reader that prefers the most recent thing it read would answer with the correction, not the obsolete value —
unless the window's order is inverted. Two columns test that:

| group | n | inverted (correction met first) | obsolete value has the last word |
| --- | ---: | ---: | ---: |
| all | 72 | 1 | 1 |
| correct | 63 | 1 | 1 |
| wrong | 9 | **0** | **0** |

Both are 1 in 72, both on a question the reader answered **correctly**. Every window in this population is
chronological: the obsolete statement arrives first, the correction last or near it. So position does not
explain a single failure, and recency — the cheapest available story — is dead. It is worth saying what that
removes: if the failures had been inverted, the fix would have been ordering, which is free and mechanical; the
fact that they are not means the fix has to be about *interpretation*, which is what the pass does and why it
costs a second call.

## 4. Was the answer's own value in the window

A lower bound, printed as one because the matcher is deliberately narrow — numeric tokens only:

| | wrong answers (9) |
| --- | ---: |
| carry at least one of the answer's numeric tokens | 4 |
| carry **all** of them | 3 |
| carry none | 2 |
| state the answer without a number at all | 3 |

`seven`, `five`, and `in a shoe rack in my closet` are real answers in this set, and a matcher broad enough to
find those would need the reader's judgement — the thing under test. So this column cannot carry a gate. It
carries a direction: at least three of nine wrong answers had the gold value spelled out in the prompt, and were
answered with the value it replaced.

## 5. Why presence is exact and the turn count is not

Per-turn agreement between window and dataset is 60.5% (1,022 of 1,688 turns). That is not a discrepancy — the
arm truncates long turns to its own budget, so a truncated turn cannot equal its source. Presence needs **one**
untruncated turn per session, and every answer session here has twelve; the consequence is that `both` is a
lower bound on how many windows carried both statements, which is the direction a claim like this needs. A
`neither` verdict would have been the weaker evidence and would have been reported as such.

## 6. What this does to the plan

- **The instrument scheduled as §14.105.5 order 2 is done**, and its reading is negative on retrieval. It cost
  nothing, it removes a hypothesis from the queue, and it was available before the remaining items were paid for.
- **The arm is now read against a premise that holds.** `K1` asks for six of the eight; the eight are all
  reachable in principle, so a shortfall will be a fact about the instruction rather than about the harness.
- **The successor question is the refusal census.** If the arm converts the eight, the pass is a mechanism. If it
  does not, `K4`'s refusal reasons say which of the three checks fired — a `no-quote` refusal means the reader
  saw the conflict and quoted the wrong span, `not-in-evidence` means it invented a span, `no-later-value` means
  it found nothing later to prefer. Those three point at three different next changes, and none of them is
  available from an accuracy number.

## 7. What it does not measure

- **The treatment's own prompt.** The pass appends a second message with the *byte-identical* evidence block, so
  exposure is unchanged by construction — but this tool reads the control, and the treatment's windows are a
  different column.
- **Whether an explicit instruction helps.** That is what the arm is for. This document establishes only that
  the information was present for every question the arm has to convert.
- **Any capability other than `KU`.** `--only` exists so the same measurement can be asked of another column,
  and it has not been asked; on `TR`/`MR`/`IE` there is no second statement, so the states would mostly read
  `single-session` and the count would mean nothing.

## 8. Reproducing

```
python3 tools/stale-exposure.py \
  --artifact art-42533236864/benchmark-cortex-memory-ablation-report.json \
  --dataset data/longmemeval_s_cleaned.json
python3 tools/stale-exposure.py --artifact … --dataset … --json   # the same counts, machine-readable
```

The tool refuses three inputs rather than guessing past them: a roster question the dataset does not carry, an
answer session id the question's own haystack does not carry, and an artifact with no recorded window. Each
refusal exists because the silent alternative is a healthy-looking rate over a population chosen by a defect.

# MEASURE — the per-turn window: a ninth of the evidence is a turn that stops

**Registered before the dispatch exists.** This document is written against a mechanism that is implemented,
tested and dispatchable, and it is written first so that the reading cannot become a description. It
dispatches nothing; the first sentence that needs a number says which number and from which file.

## 0. One paragraph

The arm caps one turn at 400 characters on `multi-session` and `temporal`, and on the 200 × 2 pair of
2026-11-13 (`43401057514`) **2,569 of 23,609 delivered blocks reach that cap — 10.9%** — while
`turnCutMarker` is `'none'`, so not one of them says it was cut. What the reader receives for those blocks is
the **beginning** of a turn, chosen by position. `a4996e51` is the case on record: the operand arrived and
then stopped, and the reader declined, correctly, on a prompt that had lost it. `turnWindow: 'match'` spends
the same characters on the window around the question's densest lexical match, and marks every elision. The
claim is non-inferiority at an identical bill; the falsifier is −5 questions.

## 1. Why this is not a cost lever, and why that matters to the reading

Three cost arms are already spent and each one closes a door:

| lever | reading | consequence |
| --- | --- | --- |
| fewer turns (`planEvidenceRoom`, `C6`) | −27.1% bill, **−4.00 points**, McNemar p = 0.0574 | the family closed at `coverage = 0.9` (`MEASURE-WIDTH-PLAN.md` §7) |
| narrower room everywhere | −51.3% bill, −2.65 points | refused by `A` (`PROMPT-ROOM-IS-LOAD-BEARING.md` §1, corrected in §5) |
| a per-route room | −24.6% bill, and the **floor rose** 2.2% to 6,167 | `C1` is blocked by arithmetic, not by tuning (`MEASURE-COST-FLOOR.md` §2.1) |

The exchange rate those three establish is **−1 point per 6.8% of the bill**. `C1` needs 22.7%, which the
straight line prices at −3.3 points. So the next mechanism on the cost axis has to deliver the tokens
*without removing events* — and that is a different sentence from the one this document is about. **The window
does not deliver tokens at all**: `maxTurnChars` is unchanged, the number of turns is unchanged, and the block
length is within two characters of the cap on both sides. It exists to make the characters that are already
being spent land on the sentence that answers the question.

That is deliberate, and it is why the row is `S10` rather than a second `C` row: an accuracy claim at a fixed
bill is the only kind of claim the cost axis has left room for.

## 2. The two sides, and the one variable

| | control | treatment |
| --- | --- | --- |
| dispatch | the registered configuration | the same, with `cortex_memory_max_turn_chars=400::match` |
| cap | 400 characters on `multi-session` and `temporal` | the same |
| marker | `none` | the window **always** marks its elisions |
| turns delivered | *n* | *n*, the same set |
| bill | 9,201 tokens per question | the same, ±2 characters per cut block |
| reader, judge, corpus, questions | `deepseek-chat`, the registered judge, fingerprint `d6f21ea9…`, 500 ids | the same |

The marker is the one field that moves with the window and it is not a second variable: an excerpt that does
not say it is an excerpt is the defect being repaired, so the two are one decision. A run that wants the
marker without the window already exists (`400:ellipsis`), and its reading is the control for *that* half.

## 3. The three readings, and where each comes from

| reading | instrument | what it answers |
| --- | --- | --- |
| 1. paired accuracy, per question, four repetitions | the arm's own artifact, `ablation.featureAggregate` and the per-question vector | does the window beat the head, tie it, or lose to it |
| 2. blocks at the cap, and blocks carrying an elision | `featurePromptTexts`, counted the way §4 counts them | did the mechanism reach the prompt at all — the inert-option failure this campaign has caught twice |
| 3. prompt tokens per question | `tools/cost-ledger.py` on the treatment's artifact | is the bill unchanged, which is the premise of calling it a free accuracy claim |

Reading 2 is the one that is not a score, and it is the one that would have caught the three defects this
series keeps finding: a field validated at the boundary, recorded on the artifact, and then not branched on.

## 4. P1–P4, written before the run

- **P1 — the mechanism reaches the prompt.** At least 90% of the blocks that the control cut are rendered with
  an elision in the treatment, and the treatment's blocks at the cap fall to **zero** (a window that ends
  exactly at the cap would be a coincidence, not a rule). If this fails, the reading is void and the cause is
  in the wiring, not the hypothesis.
- **P2 — the window is not a budget cut.** Mean delivered characters per question move by less than **2%**,
  and mean delivered turns are **identical**. A larger movement means the window is spending fewer characters
  and the accuracy delta would belong to the amount.
- **P3 — accuracy is non-inferior.** Paired delta at or above **−5 questions** (−1.0 point on 500).
- **P4 — the per-capability shape is not a trade.** No capability falls by more than **2 points** even if the
  total holds. The failure mode a total can hide is `MR` paying for `IE`: the window's anchor is lexical, and
  an aggregation's decisive turns share few terms with its question, which is `MR`'s known shape.

## 5. The pre-committed decisions

1. **`P3` holds and `P4` holds:** adopt `':match'` into the registered configuration, and record the marker as
   part of the same value. `S10` becomes a reading, and the `C` rows are untouched — this increment is not
   allowed to move a cost number, because a cost claim built on an accuracy change is the confound
   `PROMPT-ROOM-IS-LOAD-BEARING.md` already paid for once.
2. **`P3` holds and `P4` fails:** adopt on the routes that hold, i.e. narrow the window's reach with
   `cortex_memory_max_turn_chars_routes`, and register the narrowed arm as its own reading. A total that
   passes while one capability falls is the shape `S3` exists to refuse.
3. **`P3` fails:** the lexical anchor is falsified, not the idea of a window. The successor is a window chosen
   by the **reader's own extraction** (`buildTallyPrompt`'s artefact, +4.0pp on the same capability in
   `MEASURE-READING-STAGE.md` §203) rather than by term overlap, and it is more expensive per question because
   it spends a call. Recorded here so the falsification is not read as the end of the family.
4. **`P1` or `P2` fails:** no verdict. Fix the wiring and re-dispatch; a delta read on a mechanism that did not
   reach the prompt is a number about the harness.

## 6. What this cannot tell us

- **It cannot price the head cut's total cost.** Only the blocks that reach the cap are in reach, and of
  those only the ones whose decisive sentence sits past it. A question whose answer is in the head of a long
  turn is unaffected by either window, so the ceiling on this mechanism is unknown until the delta exists —
  and it is likely to be small: 10.9% of blocks × the share whose fact is deep × the share where the reader
  fails on it.
- **It cannot compare against a competitor.** No published system reports which characters of a turn it
  prints, so the cross-vendor comparison this row carries is a **mechanism** comparison (`Mem0` extracts
  instead of rendering, and pays a model call per turn for it) rather than a number.
- **It cannot license a claim about sentence ranking.** A span around a match is not a ranker. `C7`'s family
  — "the same events at fewer characters" — is a different mechanism and this reading does not speak for it.

## 7. What was done to the tests before they were trusted

A green suite is a claim about the code only if the suite can go red. Four mutations were applied to the
implementation, each run against the tests, then reverted from a copy of the file — the same procedure
`ARCHITECTURE.md`'s gate table describes, applied here because this increment's whole claim is that one field
changes **which characters** are printed, and a test that passes with the field inert would be the fourth
inert-option defect of the campaign rather than a check on it.

| mutation | what breaks in the product | tests that went red |
| --- | --- | --- |
| `contentFor`'s `match` branch falls back to the plain cut | the field is recorded on the artifact and never branched on — the exact defect `S9` was registered for | `prompt-turn-window.test.ts`, **2 failed** |
| `snapToWords` returns its input | cuts land mid-word, so the reader gets the tail of a word with no beginning | `excerpt.test.ts`, **1 failed**: `expected 'h' to match /\s/` |
| `LEAD_SHARE = 0` | the window opens on the match, so the answer arrives without its operand | `excerpt.test.ts`, **2 failed**: `expected '…pottery class I had been putting off…' to contain 'booked the pottery class'` |
| `excerptAround` ignores `question` | the head, marked — i.e. `turnCutMarker: 'ellipsis'`, which is a different arm and not this one | `excerpt.test.ts`, **8 failed** |

The second mutation is the one that initially did **not** fail, and the reason is recorded because it is a
lesson about fixtures rather than about the code. The boundary test read a single cap, and at that cap the
unsnapped cut happened to land on a space; `.trim()` then removed it, so the character before the kept span
was whitespace either way and the assertion could not tell a snapped cut from an unsnapped one. The fix was
not a stricter assertion but a wider fixture: the test now reads **every cap from 24 to 200** and counts the
boundaries it asserted — **354** of them, `177 × 2` — and requires more than 100, so a loop that stopped
asserting fails instead of passing vacuously. With that fixture the mutation is caught, and so is
`LEAD_SHARE = 0`, which the single-cap version had also missed.

What this does **not** establish: that the window is better than the head. Four mutations say the tests can
see the mechanism; only the dispatch can say whether the mechanism helps, and it is `S10`'s job.


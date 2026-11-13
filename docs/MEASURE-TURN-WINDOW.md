# MEASURE — the per-turn window: a ninth of the evidence is a turn that stops

**Registered before the dispatch exists.** This document is written against a mechanism that is implemented,
tested and dispatchable, and it is written first so that the reading cannot become a description. It
dispatches nothing; the first sentence that needs a number says which number and from which file.

## 0. One paragraph

The arm caps one turn at 400 characters on `multi-session` and `temporal`, and on the 200 × 2 pair of
2026-11-13 (`43424939177`, whose prompts are byte-identical to `43401057514`'s) **644 of the 10,381 items
those two routes deliver reach that cap — 6.2%** — while `turnCutMarker` is `'none'`, so not one of them
says it was cut. What the reader receives for those items is the **beginning** of a turn, chosen by
position. `a4996e51` is the case on record: the operand arrived and then stopped, and the reader declined,
correctly, on a prompt that had lost it. `turnWindow: 'match'` spends the same characters on the window
around the question's densest lexical match, and marks every elision. The claim is non-inferiority at an
identical bill; the falsifier is −5 questions.

**The number is a correction, and §8 records why.** This document was written against 2,569 of 23,609
(10.9%) split across five capabilities. That table cannot be right: `IE`, `KU` and `ABS` carry no cap on
this arm — the reach is `multi-session,temporal` — so they cannot have a share of *cut* items, and the
earlier count was partly measuring long turns. The defect is smaller than claimed and so is the ceiling on
what a window can recover, which is why §6 prices that ceiling as unknown.

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
  and it is likely to be small: 6.2% of the items on the two capped routes × the share whose fact is deep ×
  the share where the reader fails on it.
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


## 8. What the first dispatch found, and why it is not a verdict

Two screening runs were made on `a0264108`, 200 × 2 each, serial, 2.85 CNY each:

| | run | artifact | `maxTurnChars` | marker | window |
| --- | --- | --- | --- | --- | --- |
| control | `43424939177` | `14038312388` | 400 | `none` | absent |
| treatment | `43427857069` | `14039216945` | 400 | `ellipsis` | `match` |

### 8.1 The correction to §0

The counting rule is stated so it can be re-run: an evidence item is a chunk of `featurePromptTexts`
matching `^N. `; the cap applies to the rest of that chunk (`[date] role: content`), so an item is cut
when that remainder is exactly 400 characters.

| route | items | cut | share |
| --- | --- | --- | --- |
| `MR` (multi-session) | 4,495 | 281 | 6.25% |
| `TR` (temporal) | 5,886 | 363 | 6.17% |
| both capped routes | **10,381** | **644** | **6.20%** |
| all five routes | 16,762 | 644 (+1,360 long items on the uncapped three) | 3.84% |

The old figure — 2,569 of 23,609, 10.9%, with a share printed for each of five capabilities — does not
reproduce, and the reason it could not be right is visible in its own table: three of those five routes
carry no cap, so a share of *cut* items is not a quantity they have. The defect is real and the ceiling
on this mechanism is correspondingly smaller.

### 8.2 `P2` holds, and by more than the threshold

| | control | treated | delta |
| --- | --- | --- | --- |
| mean delivered evidence characters per question | 29,340.19 | 29,338.95 | **−1.24 (−0.004%)** |
| sum over 200 questions | 5,868,038 | 5,867,790 | −248 |
| admitted turns | 85,055 | 85,055 | 0 |
| admitted characters | 76,351,015 | 76,351,015 | 0 |

The threshold was 2%. The window spends one character per mark and gives back whatever the word-boundary
snap takes, so the bill does not move: this is the premise of calling the change a free accuracy claim,
and it is the one prediction that held to the character.

### 8.3 `P1` fails, and the failure is the useful part

- the treatment's items at the cap fell from 644 to **17** on the capped routes, and **16 of those 17 carry
  no elision at all** — so they are items whose unwindowed content is exactly 400 characters rather than
  cuts, and the single remaining item that lands exactly on 400 *is* windowed and marked. The first version
  of this paragraph explained the 17 as "fallbacks to a marked head", which was a guess: a fallback marks,
  these do not, and the artifact says so. `P1`'s first clause — at least 90% of the items the control cut
  carry an elision — needs an item-level reading, and this pair cannot give one because dropping the
  dateline changed how many items each prompt splits into (**+187** on the two capped routes), so the two
  sides no longer align one to one. §9 reads it on the pair that ran after the fix;
- **226 of the 10,381 capped-route items lost their dateline** (`MR` 87, `TR` 139). On the two capped
  routes a turn's content arrives with its own `[2026/11/13 (Thu) 09:15] user: ` head attached, and the cap
  has always counted that head. A window anchored on content terms can land *after* it, so the window was
  cutting away the date and the role.

The second bullet is why this pair is not a verdict. `TR` asks which month something happened in: a window
that removes the date is worse than the head cut it replaced, and the pair measured a mechanism that was
not the one registered. Per §5 decision 4 — *no verdict; fix the wiring and re-dispatch* — the accuracy
numbers below are recorded and **not read**:

| | control | treated | delta |
| --- | --- | --- | --- |
| aggregate | 178.50 / 200 = 89.25% | 179.00 / 200 = 89.50% | **+0.50** |
| discordant | 5 control-only | 6 treated-only | exact sign-flip p = **1.0000** |
| `MR` | 24.50 | 23.50 | −1.00 |
| `TR` | 25.00 | 25.00 | 0.00 |
| `IE` | 76.50 | 77.00 | +0.50 |
| `KU` | 23.50 | 24.50 | +1.00 |
| `ABS` | 29.00 | 29.00 | 0.00 |

`P4` is not evaluable on this instrument and that is worth saying plainly: the bucket holds 29 questions,
so one question is 3.45 points and the 2-point bound is finer than the instrument's own resolution. This
is the same lesson as round 90's `−1.50` — a threshold registered for 500 questions cannot be read off a
200-question ruler.

### 8.4 The fix, and the test that would have caught it

`contentFor` now takes the dateline out before it windows the rest, and gives the window
`max - dateline.length` rather than `max`:

```ts
const head = DATELINE.exec(turn.content)?.[0] ?? '';
return `${head}${excerptAround(turn.content.slice(head.length), cap.focusQuery, max - head.length)}`;
```

Two tests were written first and both were red: the window keeps the dateline when it lands well past it,
and it keeps it when the cap is too small to hold a window beside it (31 of 40 characters spent on the
head, so the rule degenerates to a plain cut *of the remainder*). The grammar is anchored rather than
permissive — a false negative costs one dateline inside a window, a false positive costs a window that
starts mid-sentence.

**What this says about the instrument rather than about the mechanism:** the pair was checked against three
readings that are not scores — items at the cap, items carrying an elision, and (added here) items that kept
their dateline. The first two said "the window reached the prompt". The third said "and it took something
with it". A reading that only looked at accuracy would have reported `+0.50` and adopted a window that
deletes dates on the capability that asks about dates.

## 9. The pair that ran after the fix, and the instrument it exposed

Both sides at `8443c4f2`, 200 × 2, serial, 2.85 CNY each. The control's prompts are **byte-identical**
to the previous dispatch's and to `43401057514`'s, so the fix moved nothing on the head path:

| | run | artifact | window | marker |
| --- | --- | --- | --- | --- |
| control | `43433744411` | `14042349235` | absent | `none` |
| treatment | `43437140082` | `14045142548` | `match` | `ellipsis` |

### 9.1 What holds, and it holds hard

| reading | control | treated | delta |
| --- | --- | --- | --- |
| delivered evidence characters per question | 29,340.19 | 29,338.74 | **−1.45 (−0.005%)** |
| admitted turns / admitted characters | 85,055 / 76,351,015 | 85,055 / 76,351,015 | **0** |
| items that lost their dateline | — | **0** | the fix, measured |
| chunks at the cap on the capped routes | 644 | 19 | 16 of the 19 are unwindowed items of exactly 400 |

`P2` settles: the window spends two characters per mark and gives back whatever the boundary snap takes.
The roster is untouched — the same 85,055 turns and the same 76,351,015 characters on both sides — so an
accuracy delta cannot belong to the amount of evidence.

**A number this round did not have before: the instrument's own noise.** Two control runs, identical
prompts to the byte, three hours apart:

| | `43424939177` | `43433744411` |
| --- | --- | --- |
| aggregate | 178.50 / 200 | **180.00 / 200** |

**1.50 questions between two draws of the same bytes.** Every delta below ±1.50 on this instrument is a
redraw.

### 9.2 Accuracy: −1.00, which is inside the redraw

| | control | treated | delta |
| --- | --- | --- | --- |
| aggregate | 180.00 / 200 = 90.00% | 179.00 / 200 = 89.50% | **−1.00** |
| discordant | 6 control-only | 3 treated-only | exact sign-flip p = **0.7812** |
| `MR` | 23.50 | 25.00 | +1.50 |
| `TR` | 26.00 | 25.50 | −0.50 |
| `IE` | 77.00 | 75.00 | −2.00 |
| `KU` | 24.50 | 24.50 | 0.00 |
| `ABS` | 29.00 | 29.00 | 0.00 |

`P3` holds (−1.00 ≥ −5). **`P4` is not evaluable here and that is a defect in the prediction, not a
result:** on a 29-question bucket one question is 3.45 points and on an 86-question bucket it is 1.16, so
a 2-point bound is finer than the instrument on one bucket and coarser on another. `MR`'s +1.50 and `IE`'s
−2.00 are both one to two questions. Round 90 wrote this lesson down for `S9` and this row repeated the
mistake: a bound registered for 500 questions cannot be read off a 200-question sample.

### 9.3 `P1` cannot be read from prose, and that is the finding

`P1` asks what share of the items the control cut now carries an elision. Answering it requires knowing
*which* control items were cut, and the only source is the prompt text. Both parsers available are wrong in
a way that matters:

- splitting on blank lines undercounts, because a cut prefix that contains a blank line becomes two chunks;
- splitting on `^N. ` overcounts, because an assistant's numbered list in the turn's own content looks
  exactly like an item head. **53 of 200 prompts** split differently between the two sides for this
  reason alone.

On the aligned subset the reading is **60 of 69 at-cap chunks carry an elision, 87%** — under `P1`'s 90%,
but measured by an instrument whose own error is larger than the 3-point gap. So the honest sentence is:
**`P1` is unread, not failed.** Its fixture tests (`prompt-turn-window.test.ts`) pin the property on single
turns; what is missing is a count in the artifact rather than a parse of the prompt.

### 9.4 The pre-committed decision, applied

§5 decision 4 says: if a reading shows the mechanism did not administer as designed, there is no verdict;
fix the wiring and re-dispatch. Here the wiring is fixed (dateline, measured at zero losses) and the
*instrument* is not. So:

1. `S10` stays **`unrun`** and the registered value does not move. The 500 × 4 pair is not dispatched yet.
2. The next increment's first item is the counter, not the dispatch: the arm records, per question, how
   many delivered turns were **cut**, how many of those were **marked**, and how many arrived **whole** —
   computed where the cut happens, so that `P1` is a field and not a parse.
3. The three readings that are instrument-free (P2, the roster equality, the dateline count) are already
   enough to say the mechanism is honest about the budget; they are not enough to say it helps.

**One thing this pair does establish, and it is negative:** with 1.50 questions of redraw noise on 200
questions, a mechanism that can only reach 6.2% of the items on two of five capabilities cannot be resolved
at this sample size. The 500 × 4 instrument exists for exactly that reason, and dispatching it before the
counter exists would spend 28.5 CNY to answer a question that a parse cannot settle.

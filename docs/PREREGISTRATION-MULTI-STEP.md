# Pre-registration — the reader looks twice

**Status:** decided — the axis is off at its price. The treatment exists in the product
(`CortexMemoryOptions.readerSearch`), in the arm (`CORTEX_MEMORY_READER_SEARCH`) and in the dispatch
script, and `guard:prereg-knobs` reads it `buildable`. It was dispatched twice. The first dispatch
(`45974552492`) returned a null from a run in which the stage never executed, because `maxTokens: 32`
was spent on the `multi-session` route's reasoning tokens (§3.3). The second (`45989342121`) executed —
185 of 242 questions wrote a query, and `selfIndex.indexes` is exactly `attempted + queries` — and read
**−1.65 points, p = 0.2266** on 121 paired `MR` questions (§3.4). Bar 1's own failure row says `< +1`
closes the axis, so it is closed for ¥5.87 per dispatch, ¥11.74 for the row.

## 0. What is being tested, and why now

`MR` is the only capability where this repository is level with its own reference pipeline and behind
every published competitor. The figure this paragraph quoted until §3.2 was written — **102 of 121
(84.3%)** — is four rounds and three configurations stale: the registered arm reads **105** (86.78%) on
`45760081761` and **108** (89.26%) on `45923435343`'s control side, and the gap to Synap's 92.6 is
therefore **2.9 to 5.8 points rather than 8.3**. Both numbers are quoted because the spread between two
runs of one configuration is the reason §3.2 exists. Three plans
have been written against that gap — `[thing N]` item identity, a listing contract, and more room — and
each was dispatched against the explanation the previous document happened to name. Two of the three
are now retired by measurement (`RETRACTIONS` #12 for the room, #24 for the listing contract), and the
third offline clue points somewhere new.

`44962474136`'s wrong `MR` questions, read at the level of the reader's own `Step 1`:

| question   | reader's list                              | answer | gold |
| ---------- | ------------------------------------------ | -----: | ---: |
| `0a995998` | blazer at the dry cleaner, boots at Zara   |      2 |    3 |
| `2ce6a0f2` | gallery lecture, "Women in Art" exhibition |      2 |    4 |

Both questions delivered **every gold turn** (`goldOverlap.carried == total`: 17/17 and 11/11) and both
blocks were **46,758 and under** of a 48,460-character room. So the reader was shown the evidence, had
room left, and listed two of three or two of four. That is neither a retrieval result nor a room
result, and it is the one shape no `ask` can fix: `enumerated` was designed for exactly this population
and made `MR` **worse by 6.2 questions**.

The mechanism this document registers is the other remedy the evidence allows: **give the reader a
second look, aimed by what it saw the first time.** A reader that lists two of three items and then
searches for the third has a chance; a reader handed the same 194 turns twice does not.

## 1. What is already measured, and what is not

`44867629266` (probe, `maxSteps=1`, `MR` 121 questions) read:

```
gold seed / selected / carried / total : 862 / 1448 / 1377 / 3663
searches that added evidence            : 118 of 121 questions
found but not carried                   : 71
```

Two facts, and they are both needed:

1. **The reader's own search adds evidence on 118 of 121 questions** (+586 gold turns over the seed).
   The loop is not neutral; it is the largest single source of new gold this repository has measured.
2. **71 of 121 questions have gold found and not carried.** The room then refused it. On the questions
   in §0 the room refused nothing, so these 71 are a different population — and both populations are
   large enough that a single mechanism could plausibly reach either.

What is _not_ measured: whether any of it converts to a correct answer. The probe reports evidence
coverage, not accuracy, and this campaign has made the mistake of reading a delivery fact as a
capability fact twice (`RETRACTIONS` #22 is the first).

## 2. The mechanism, and where it lives

`cortex-ai/agent` already holds the loop: `retrieveStepwise` takes a `Retrieval`, a `Renderer` and an
`LLM`, and returns the ids the reader chose. It depends on `cortex-core` and nothing else, which is
what makes it legal for an evaluation arm to call without reversing a dependency.

The measurement needs one thing that did not exist when this document was written: a way for the arm to
ask **the product's own index** for a query, so the second look uses the registered ranking rather than a
second implementation
of it. The product change is one public method:

```ts
// packages/cortex-memory/src/memory.ts
/**
 * The turns this memory would show for a query, in the order it would show them.
 *
 * Public because "what do you have about X" is a question a user asks, not only a harness, and
 * because the alternative -- an arm building its own index -- would make the second look a
 * measurement of a different ranking than the one under test.
 */
async search(query: string, options?: { readonly k?: number }): Promise<readonly SearchHit[]>;
```

`SearchHit` stays module-internal (the census already retired it as an export); the return type is
`readonly { turn: number; score: number }[]` spelled out at the boundary.

**Built later than the dispatch, and with the corpus as an argument.** The method shipped as
`search(query, context, { k })`, not as the two-argument sketch above: `CortexMemory` receives its corpus
per question (`answerSessions(question, sessions)`), so a `search` without one would have had to read a
field that does not exist. The four properties the sketch was after are unchanged — the product's own
ranking, the prompt's comparator, ids a caller can index with, and no second index built beside it — and
`docs/DESIGN-MULTI-STEP-RETRIEVAL.md` §2.1 records what the missing entry cost the probe that ran without
it.

## 3. The registered comparison

| field         | control                                                     | treatment                   |
| ------------- | ----------------------------------------------------------- | --------------------------- |
| configuration | the registered arm, **in the same job** (`CORTEX_MEMORY_AB=reader`) | same, plus `readerSearch=1` |
| capability    | all five                                                    | all five                    |
| questions     | 500                                                         | 500                         |
| repetitions   | 4                                                           | 4                           |
| reader        | `deepseek:deepseek-chat`, `thinking=multi-session+temporal` | same                        |
| room          | 48,460 multi-session / 24,000 elsewhere                     | same                        |

`readerSearch=1` means: after the registered retrieval, the reader is asked once for **one** additional
query, the product's index answers it, and the union is ranked by the same relevance signal before the
room is applied. Not a re-render of everything found — the union goes through the registered ranking,
so the second look costs ordering, not characters.

### 3.1 The treatment did not exist, and the nearest thing that does already ran

`guard:prereg-knobs` (`tools/prereg-knobs.mjs`) reads every `pending` registration, extracts the
assignments it writes in backticks, and refuses a build where one of them is in no workflow input, no
arm option and no dispatch script. On its first run it reads:

```
registration                       knob                  state
PREREGISTRATION-MULTI-STEP.md      maxSteps              buildable
PREREGISTRATION-MULTI-STEP.md      readerSearch          missing
PREREGISTRATION-MULTI-STEP.md      thinking              buildable
```

`readerSearch` is the treatment this document was written for, and `grep -r readerSearch` returned
**nothing** in the repository — for four rounds, while this file was cited as the queue's first row at a
price, with a bar and with a control run. That is `§209.1`'s shape (a pre-registration describing an
instrument the harness cannot build) arriving a third time, and the first two were caught by reading,
which is not a method. The gate above is the method; it was added to catch this one and it did.

**Where it is now.** The mechanism shipped on 2026-11-27, after the gate named the row:

| layer | what was added |
| --- | --- |
| product | `CortexMemoryOptions.readerSearch` (`cortex-memory/src/reader-search.ts`, `memory.ts`) |
| arm | `CORTEX_MEMORY_READER_SEARCH` → `CortexMemoryArmOptions.readerSearch` → the product option |
| gate | `assertReaderSearchReachesRanking` before the run, `assertReaderSearchReached` after it |
| receipt | `readerSearchCounts` on the artifact, beside `semanticCarry` rather than in the config block |
| dispatch | `tools/dispatch-cortex-memory-ab.py` writes the variable on **every** dispatch |

The receipt carries six counters, not five: `empty` was split from `refused` after §3.3, because the run
that read as 242 refusals had 242 replies cut by the stage's own token bound.

The seam is the one §3.1 predicted, and it is worth recording where it actually is because it is one
frame higher than the sketch: `#relevanceFor` builds the product's index per question, so the first pass
exists only inside `answerSessions`, and the public `search()` this document sketched — though it
shipped — was not the missing piece. The digest has to be a line from each turn the prompt is about to
carry, and only that method knows which turns those are. `#secondLook` is therefore a private method on
the class, and the arm-side work is the five rows above rather than one call site.

**Where the knob would go, since the seam is now known.** `queryExpansion=llm` already produces
phrases **before** the index is built, one model call per multi-session question, and delivers them to
the ranking through `RelevanceCase.queries` and `SearchIndexOptions.queryPlan`
(`packages/cortex-eval/src/bench-memory-arm.ts`, `packages/cortex-memory/bench/run-ablation.ts`).
`readerSearch` is that path plus one thing: the query is written **after** a first pass has been
ranked, so the digest the model reads is a line from each of the top turns rather than the question
alone. The product change this document originally sketched — a public `search()` — shipped
(`packages/cortex-memory/src/memory.ts`), so the remaining work is arm-side and is one call site.

**And the nearest measurement has already been taken, which re-prices this row.** `S17`
(`ACCEPTANCE-MATRIX.md`) is `queryExpansion: llm` on the product's own ranking, paired, 121 `MR`
questions: it read **+1.75 points against a bar of +5** and is marked `aim`. That is the *blind*
version of this mechanism — the model writes phrases from the question with no view of what retrieval
found — and on the same denominator it is inside the campaign's own 2.5-question cross-run noise floor
(`MEASURE-PAIRED-POWER.md` §1). So the honest description of the gap this document was written for is:

| | value |
| --- | --- |
| blind phrase expansion on this arm (`S17`) | **+1.75 points**, bar was +5 |
| the bar this document registers for the aimed version | **+3 questions** of 121 = 2.48 points |
| the difference between them | the model reads a digest before writing the query |

A bar *below* the measurement of the mechanism's blind half is not a bar. §4 is therefore re-derived
below rather than inherited: the aimed version must clear **+3 questions** *and* show that the
questions it converts are ones whose first-look list was short (§6), because otherwise it is S17 with a
longer prompt and the mechanism name is wrong even when the number is positive.

### 3.2 The control had to be a side, and until this round it was a run

§3 used to read "the registered arm (`91.25%`, run `43140878641`)" in its control column. That is a
**different run**, and three numbers make the objection arithmetic rather than stylistic:

| reading | run | repetitions | `MR` | share |
| --- | --- | ---: | ---: | ---: |
| `43140878641` (the old control) | one 500-question pass | 1 | 102 | 84.30% |
| `45760081761` (the published arm) | two passes, `layered` | 2 | 105 | 86.78% |
| `45923435343` (control side) | one pass, `layered` | 1 | 108 | 89.26% |

Three readings of one arm, **six questions apart**, and §4's bar 1 is three. A bar smaller than the
spread of the control it is read against cannot fail, which means it also cannot pass: the reading would
have been the reader's prior, priced at ¥5.87.

So the control is a side of the same job. `CORTEX_MEMORY_AB=reader` is the sixth one-flag pairing
(`cortex-eval/src/arm-pairing.ts`): both sides are `CortexMemory`, the control passes no `readerSearch`
key, the feature passes the registered configuration, and the two share the corpus, the reader, the
judge and the clock. One dispatch, and the delta is the second look's -- not the cognitive layer's whole
difference from the reference pipeline, and not a difference between two runs.

Two consequences worth stating because they were wrong before this round:

1. **`readerSearch` had no pairing, so a dispatch would have measured the wrong thing.** The switch was
   read from `armOptions` inside `buildCortex`, which is one value per process: with the registered pair
   the artifact would have compared *the cognitive system plus a second look* against the *reference
   pipeline*, and the delta would have been charged to the second look while belonging to the cognitive
   layer. The sentence in that comment — "this is not one of the axes `CORTEX_MEMORY_AB` flips, so there
   is no second side to disagree with" — was true only because there was no way to ask the question.
2. **The receipt that was supposed to catch that could not pass.** It read `selfIndex.queries >
   selfIndex.indexes`, which is the *query-expansion* ratio (one index, k queries). The second look
   issues one query against one more index, so the two counts rise together and the inequality is false
   on every correct run: it would have thrown at the end of the dispatch, after the money was spent. It
   now reads `indexes >= attempted + queries` — one index per question the stage reached, one more per
   query it wrote — and `--second-look` applies the same floor to a finished artifact.

### 3.3 The first dispatch read a null from a run in which the mechanism never executed

The row was dispatched on the fixed instrument — one job, `CORTEX_MEMORY_AB=reader`, 121 `MR` questions
twice, ¥5.87 — and the paired reading is negative and flat:

| side | correct | share | discordant | McNemar |
| --- | ---: | ---: | --- | --- |
| control (`readerSearch` off) | 107 / 121 | 88.43% | `b = 4` | |
| feature (`readerSearch` on) | 106 / 121 | 87.60% | `c = 3` | **p = 1.000** |

Net **−1 question**. §4.1's stop rule reads that as "the axis closes"; it is not applied here, and the
reason is in the artifact's own counters rather than in the delta:

| field | value | what it says |
| --- | ---: | --- |
| `readerSearchCounts.attempted` | 242 | the stage reached every multi-session question |
| `readerSearchCounts.queries` | 0 | it wrote no query, on any of them |
| `readerSearchCounts.refused` | 242 | and the census called all 242 of them refusals |
| `readerSearchCounts.promoted` | 0 | nothing was promoted, so nothing could be measured |
| `llmUsage.truncatedCalls` | 242 | **the replies were cut, not declined** |

`242` is the whole run: the stage fired on both repetitions of all 121 questions and came back with no
usable line every time. The cause is one number in this stage's own configuration. The decision call is
made through the question's own route reader, and that reader is asked for `thinking` on `multi-session`
(`§13.197`) — so the stage's `maxTokens: 32` was spent on reasoning tokens and the reply was cut before
its first content token. Every one of those calls was billed, and the census reported the model as
declining 242 times.

**This is the meter being wrong again, in the same direction as §3.2.** The delta was real, the
comparison was clean, the receipt passed — and the run measured a stage that answered nothing. It is a
null about the instrument, not about the mechanism, and applying the stop rule to it would have closed a
¥5.87 axis on the strength of a configuration defect.

Three changes follow, and the third is the one that would have caught it without a reader:

1. `DEFAULT_READER_SEARCH.maxTokens` **32 → 1024** — four times the widest query the stage accepts,
   with room for a short trace. Whether it is enough is on the artifact either way.
2. **`empty` is its own census counter.** A reply with no usable line is not a refusal: a reader
   answering `NONE` is the mechanism's stop rule working, and a reply cut by the bound is a defect in
   this stage's configuration. Collapsed into `refused`, the first reads as the second — which is exactly
   what the artifact above says.
3. **`--second-look` refuses a starved run.** `queries == 0` with `empty > 0` is a verdict of its own
   (exit 1), printed with `llmUsage.truncatedCalls` beside it, so the §4.1 stop rule cannot be applied to
   a run in which the mechanism produced nothing to measure. A stage that reached every question and the
   model declined every time still passes: that is a null, and it is allowed to be one.

The row keeps its price, its bars and its control. What it does not keep is the reading above.

### 3.4 Result — the second dispatch executed, and the axis closed

`45989342121` re-ran the row at the same configuration with one change: `maxTokens` 1024. The stage ran this
time, and the reading is negative on both bases:

| basis | control | feature | difference |
| --- | ---: | ---: | ---: |
| first-repetition roster | 109 / 121 = 90.08% | 104 / 121 = 85.95% | −5 questions |
| mean over two repetitions | 89.26% | 87.60% | **−1.65 points (−2 questions)** |

Exact McNemar on the 121 pairs: `b = 8`, `c = 3`, **p = 0.2266**. Bar 3 passed — prompt tokens per question
12,890 → 13,644, **1.058×** of the control — so the mechanism is cheap and the miss is not a bill.

Three counters say the mechanism is what missed, and this is the whole of §3.3's repair working:

| field | value | what it rules out |
| --- | ---: | --- |
| `readerSearchCounts.queries` | **185** of 242 reached (76.4%) | "the model wrote nothing" — 0 on the voided run |
| `selfIndex.indexes` | **427** | "the queries never reached a ranking": the floor is 242 + 185 = 427, an exact equality |
| feature-side `completionTokens` | 773,494 (was 592,928) | "the queries were empty": 180,566 extra tokens are the queries |

**§4.1 applies, and the verdict is that the axis closes at ¥5.87 per dispatch** — ¥11.74 for the row, because
the first ¥5.87 bought a defective instrument rather than a reading. Bar 1's failure row already said
"`< +1` closes the axis"; the reading is −2 on the mean and −5 on the paired roster, with p nowhere near 0.05.

**One counter in that artifact is not readable, and saying so is part of the record.** `promoted: 0`, and the
census's own docstring calls it "the one number that separates *looked twice* from *got a longer prompt*". It
counts sessions in the final budget whose entry the second query is the only reason for — and this
configuration has `sessionBudget: null`, which `provider.ts` resolves to unbounded, so the first pass already
holds every eligible session and `selected \ firstPass` is empty **by construction**. That is a third kind of
dead instrument, beside §3.2's wrong formula and §3.3's missing field: a value pinned by the gate. Three
places now say so — the census docstring, a test that pins the invariant (`queries: 1, promoted: 0` under an
unbounded budget even when the query does reorder), and `--second-look`, which prints a `no budget` line so a
reader cannot take the zero for a verdict.

**And 1024 is still short for a quarter of the calls**: `empty: 57` and `truncatedCalls: 57` are the same 57,
23.6% of the attempts. The queries are capped at 120 characters, so what is being cut is the `multi-session`
route's `thinking` trace rather than the answer — a budget for any future stage on this route has to be sized
from `completionTokens`, not from the prompt.

## 4. Bars, both directions, written before the dispatch
| #   | bar                                                              | verdict if missed                                                  |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `MR` **≥ +3 questions** (102 → ≥105)                             | < +1 closes the axis; +1..+2 is a null and is not dispatched again |
| 2   | exact McNemar, two-sided, **p < 0.05** on the paired `MR` roster | a ≥3-question move at p ≥ 0.05 is a null at this sample            |
| 3   | prompt tokens per question **≤ 1.30×** (7,448 → ≤9,682)          | > 1.30× needs its own justification before a second dispatch       |
| 4   | **no capability moves down by more than 2 questions**            | any row at −3 or worse fails the run whatever `MR` does            |
| 5   | total accuracy **≥ 91.25%**                                      | below the control means the mechanism trades `MR` for elsewhere    |

Bar 4 exists because of §2 of `MEASURE-ENUMERATED-ASK.md`: an untreated row moved 3 questions on four
repetitions, so a two-question floor is the largest claim this sample supports.

**Bars 1 and 2 cannot both hold at a net `+3`, and the exact test is what says so.** On 121 paired
questions the two-sided exact McNemar reaches `p < 0.05` only from:

| discordant, control-correct | smallest `b` | net | `p` | net one short | `p` there |
| ---: | ---: | ---: | ---: | ---: | ---: |
| `c = 0` | 6 | **+6** | 0.031 | +5 | 0.063 |
| `c = 1` | 8 | **+7** | 0.039 | +6 | 0.070 |
| `c = 2` | 10 | **+8** | 0.039 | +7 | 0.065 |
| `c = 3` | 12 | **+9** | 0.035 | +8 | 0.057 |

So bar 1 is **necessary and never sufficient**: every verdict this screen can reach is `+6` at best and
`+6 + c` in general, and a `+3` reading lands in bar 1's second row ("a null and is not dispatched
again") only if bar 2 is consulted at all. The row is not rewritten, because a bar written before a
dispatch is worth more than a tidier one written after; the operative threshold is stated instead, and
it is **+6 with no regressions**, which is a 5% `MR` effect. `S17` measured the blind form of this idea
at +1.75 questions, so the screen's most likely verdict is "the axis closes at its price" -- and that is
the honest reading of a ¥5.87 instrument rather than a reason to spend ¥25.

## 5. Cost

| item                                                     | estimate     |
| -------------------------------------------------------- | ------------ |
| one 500×4 dispatch at 1.3× prompts                       | **≈ 24 CNY** |
| the probe re-run before dispatch (121 questions, 1 step) | ≈ 0.6 CNY    |
| total to a verdict                                       | **≈ 25 CNY** |

**This price is not on the queue, and the queue's own number was for a different run.** The queue row
that cites this document reads **¥5.87 for `MR` 121 questions** — a paired comparison at a fifth of the
price — while §3 and §4 above register 500 questions × 4 repetitions. The ¥5.87 is `MR` at **two**
repetitions: `tools/spend-baseline.json` derives it as `5.87 / (121 × 2)` from the bill of the scoped
dispatch that was over its projection by 3.4×, so "one pass" was a word this document added rather than
a number it read. Two prices for one
registration is how a row ends up approved on the cheaper one and read against the stricter criteria;
the row is corrected in `cortex-docs` §211.9, and the criterion that survives is §4's: **exact McNemar
on the paired `MR` roster**, which 121 questions can carry, and bar 4's `−2` capability floor, which
they cannot (four capabilities are not on that run). A 121-question dispatch therefore prices at
¥5.87 and answers `MR` only, and it is a *different* registration from this one — `§4.1` below.

The budget is stated before the dispatch for the reason `03-execution-plan.md` §13.147.3 gives: a run
whose price is discovered afterwards is a run nobody can decide about in advance, and the last three
dispatches in this campaign were approved on an estimate that had been computed the same way.

### 4.1 The cheap form, and what it cannot answer

| | 121-question paired run (¥5.87) | 500×4 run (¥25) |
| --- | --- | --- |
| `MR` bar 1 / bar 2 | answerable | answerable |
| bar 3 (prompt tokens ≤ 1.30×) | answerable on `MR` | answerable on all five |
| bar 4 (no capability down 3) | **not answerable** — four capabilities absent | answerable |
| bar 5 (total accuracy) | **not answerable** | answerable |

So the cheap form is a **screen**, and this campaign has a measurement of what its screens are worth:
`MEASURE-READER-LADDER.md` §4 records a 200-question pair reading **+0.5** and the 500-question
completion of the same pair reading **−4.35**. A screen that reverses sign at scale is not evidence for
spending the larger sum; it is evidence about the instrument. The cheap form is therefore registered as
a screen with a **stop rule**: a positive `MR` delta at `p < 0.05` licenses the 500×4 run, and anything
else closes the axis at ¥5.87 rather than at ¥25.

## 6. What would falsify the mechanism being the one that mattered

If `MR` moves but the **discordant set** is dominated by questions whose first-look list was already
complete, the gain came from something other than the second look (a longer prompt, a different order,
noise) and the mechanism name would be wrong even with a positive number. The reading therefore
includes, for every flipped question, whether the reader's `Step 1` list on the control was short —
that is `tools/readout-arm-run.py --lists` and it is the only check that separates "looked twice" from
"got lucky".

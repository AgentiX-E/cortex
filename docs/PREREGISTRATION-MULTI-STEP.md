# Pre-registration — the reader looks twice

**Status:** pending — dispatchable. The treatment existed only in this document for four rounds (§3.1);
it now exists in the product (`CortexMemoryOptions.readerSearch`), in the arm
(`CORTEX_MEMORY_READER_SEARCH`) and in the dispatch script, and `guard:prereg-knobs` reads it
`buildable`. Not dispatched, and no Result section exists for it.

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

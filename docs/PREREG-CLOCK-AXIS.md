# PREREG-CLOCK-AXIS

**Status:** decided

The axis is **retired**. The dispatch read a null once the control is the arm it actually ran against, and the
reading that looked like a regression was a configuration the run never named. §6 states the result, §7 the defect
it exposed, `RETRACTIONS.md` §28 the number it withdraws.

The act rule's other clock. `verbatim-scope` bought a bound on the period and lost four questions; this buys the
prohibition of that bound, and the reason it is worth buying is the adopted arm's own merged artifact rather than
the symmetry of the two claims.

## 0. What is being tested

One sentence, and it is a claim about the corpus rather than about arithmetic: **a turn is dated by when it was
said, not by when the thing happened**, so the session date is not a licence to leave an item out.

The mechanism is registered on a population that was counted before the dispatch, at zero cost, from the merged
artifact of the adopted arm (`45543010618`: eight shards, 500 of 500 questions, two repetitions, 93.50%).

| reading, `MR` only                                                     |                                                    value |
| ---------------------------------------------------------------------- | -------------------------------------------------------: |
| questions                                                              |                                                      121 |
| correct                                                                |                                         **108** (89.26%) |
| failures carrying **every** gold turn (`goldOverlap.carried == total`) | **9 of 13**, the other four short by 1, 1, 2 and 5 turns |
| replies that exclude nothing                                           |                      49, of which **47 correct (95.9%)** |
| replies that exclude something                                         |                      72, of which **61 correct (84.7%)** |
| replies citing a period or a date                                      |                          50, of which 42 correct (84.0%) |
| failures among those                                                   |                                              **8 of 13** |

Nine of the thirteen failures had every gold turn in the window and the other four are short by one to five, so
this is at most a one-turn delivery gap on one question: no ranking change, no budget change and no wider room
reaches it. The reply says what it decided, and three of them were read to
the gold turn:

| question        | gold   | the reply's stated exclusion                                                  | what it lost    |
| --------------- | ------ | ----------------------------------------------------------------------------- | --------------- |
| `3a704032`      | `3`    | snake plant _"received last month, which points to the prior calendar month"_ | the third plant |
| `gpt4_731e37d7` | `$720` | two workshops _"outside last four months"_ from a `2023/02/26` question       | the `$500`      |
| `37f165cf`      | `856`  | both novels _"finished in May, not January or March"_                         | `440 + 416`     |

`$200 + $20 + $500 = $720` and `440 + 416 = 856` close without interpretation, and the plant the reply called
_"prior calendar month"_ is the one the evidence dates _"last month"_ — the period the question names. The
annotation's clock is the mention's, never the turn's.

## 1. The design

One field, one line, one route. `cortex_memory_ask` moves from the adopted `verbatim-acts` to `verbatim-clock`,
which is that block with a **third line on the act rule** and nothing else: `ask-verbatim-clock.test.ts` holds the
render as a diff (nothing removed, exactly one added, order preserved), and `ask-changes.test.ts` holds the change
set to the multi-session route against the `ASK_CHANGES` registration.

| field               | control                           | treatment            |
| ------------------- | --------------------------------- | -------------------- |
| `cortex_memory_ask` | `verbatim-acts` (the adopted arm) | **`verbatim-clock`** |
| everything else     | the registered arm                | **identical**        |
| population          | `capability=MR`, 121 questions    | **identical**        |
| repetitions         | 2                                 | **identical**        |

The control is the **archived** arm rather than a second dispatch: `45543010618` is the same configuration at the
same load, and its eight shards are byte-comparable this round because the merge that was refused at the time
(§190.1, `selfIndex`) now runs — verified by reproducing `feature 0.9350` exactly.

> **§6 corrects the sentence above.** _"The same configuration"_ was true of the ask and false of the rendering:
> the dispatch ran `resolution=raw` and the archived arm renders `layered`, because this workflow cannot name that
> field. The reading is re-derived against the paired baseline side, which is the same configuration.

## 2. Predictions, stated so that a failure is a failure

| #    | claim                                       | bar                                                                                                                                                                                                        |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C1` | the clock licence is what the failures used | `MR` converts **at least 4** of the 8 clock-citing failures net of regressions (`b − c ≥ 4`)                                                                                                               |
| `C2` | and the direction is not noise              | exact McNemar `p ≤ 0.05` on the paired verdicts; at `c = 0` that needs `b ≥ 6`                                                                                                                             |
| `C3` | the mechanism moves the census it names     | citations of a period or a date fall from **50 to ≤ 25** of 121 replies                                                                                                                                    |
| `C4` | it is not a licence to count everything     | the over-count population does not grow: of the 13 failures, at most **1** may move from below-gold to above-gold                                                                                          |
| `R1` | the route's total                           | `MR ≥ 112` of 121                                                                                                                                                                                          |
| `R3` | the prompt bill                             | paired prompt tokens move **≤ +1.0%** (`usageBySide`), because one 500-character line on 121 of 500 questions is ~0.5% of the file average and the arm's own cache behaviour is not re-measured by a ratio |

## 3. The falsifier, and what a negative reading would mean

`C3` passing with `R1` failing is the interesting negative: the licence disappears and the accuracy does not
move, which says the exclusion was a **symptom** of an incomplete screen rather than its cause. That would close
this axis in both directions — the bound costs four questions (§13.291's `S17`) and the prohibition of the bound
buys nothing — and it would move the remaining `MR` error to the screen itself, which is where `candidates`
(§13.205) already aimed.

`C1` passing while `C4` fails would mean the line trades over-counts for under-counts. That is not adoption
either: the two directions are different questions and the plan's next step would be the actor bound, which
§13.290 measured as annotation-dependent rather than fixable.

## 4. What this registration does not claim

- **Not** that the dataset's dates are wrong in general. It claims the annotation's clock is the mention's, which
  is what three replies' own arithmetic shows, and it states a rule a memory system can hold: a mention of a past
  event arrives later than the event.
- **Not** that every date exclusion is wrong. `gpt4_2f8be40d`'s extra weddings and `gpt4_7fce9456`'s extra
  property are excluded by the gold for act, duplicate and actor reasons, and the line keeps the act rule's bound
  for exactly those.
- **Not** a re-run of `verbatim-scope`. That arm added the bound; this one forbids it. A pair that moved both in
  one field would price neither, which is why the control is `verbatim-acts` rather than `verbatim-scope`.

## 5. Price

**¥5.87** — `MR` at two repetitions at the measured rate (`0.0243 CNY` per question-run, `§13.348.2`'s invoice in
`tools/spend-baseline.json`), quoted by `tools/spend-projection.mjs --capability MR --runs 2` and gated by the
same number the dispatch script reads. The line adds ~500 characters to 121 of 500 prompts, so the bill for the
other four capabilities is unchanged and the projection's only extrapolated axis is repetitions.

## 6. Result — a null, and a control that was not the arm this run imagined

Run `45636994046` (`verbatim-clock`, `capability=MR`, two repetitions, 242 question-runs, ¥5.87, head
`815712af`). The artifact read **102 of 121 (84.30%)** against the archived arm's **108 (89.26%)**: `−4.96` points,
paired `b=5, c=11`, exact McNemar `p=0.2101`. Read against that control, `C1` and `R1` both fail and the axis is
dead.

**The control was the wrong arm, and §1's premise — _"the same configuration at the same load"_ — is false.** The
dispatch's own `memoryArmConfig` says `resolution=raw`; `45543010618`'s feature side is `resolution=layered`.
`benchmark-cortex-memory.yml` wires that variable as `${{ vars.CORTEX_MEMORY_RESOLUTION || 'raw' }}` — a repository
setting with a fallback to the **control rendering** — so a dispatch of this workflow cannot name the arm that
ships, and the fallback is silent. Two fields moved: the ask and the rendering.

The pairing does not need a second dispatch to be read like-for-like, because `45543010618` **is** a resolution
pairing: its baseline side is `raw` + `verbatim-acts` on the same 500 questions at the same load, archived inside
the same eight artifacts (`ablation.baselineCorrectByRun`). The extraction is validated by reproducing the
published means exactly — baseline `91.80 / 91.60 → 91.70`, feature `93.20 / 93.80 → 93.50`.

The table below is reproducible with the repository's own instrument, which now reads a pairing's control side and
refuses to print anything until the two arms' differences are declared:

```sh
node tools/merge-ablation.mjs --dir <the eight shards> --shards 8 --out merged.json
node tools/paired-delta-census.mjs merged.json <clock artifact> \
  --capability MR --control-side baseline --allow-arm-drift ask,resolution
```

| `MR`, 121 questions                                      |            rep 1 |        rep 2 |       mean |
| -------------------------------------------------------- | ---------------: | -----------: | ---------: |
| `raw` + `verbatim-acts` (`45543010618` baseline side)    |     101 (83.47%) | 100 (82.64%) | **83.06%** |
| `raw` + `verbatim-clock` (`45636994046`)                 | **102 (84.30%)** | 101 (83.47%) | **83.88%** |
| `layered` + `verbatim-acts` (`45543010618` feature side) |     108 (89.26%) | 108 (89.26%) | **89.26%** |

| paired comparison                          | treatment | control | both | neither | `b` | `c` |    net | McNemar |
| ------------------------------------------ | --------: | ------: | ---: | ------: | --: | --: | -----: | ------: |
| clock vs `raw`+acts, first repetition      |       102 |     101 |   98 |      16 |   4 |   3 | **+1** |  1.0000 |
| clock vs `raw`+acts, correct in both runs  |        98 |      99 |   95 |      19 |   3 |   4 | **−1** |  1.0000 |
| clock vs `raw`+acts, correct in either run |       105 |     102 |  102 |      16 |   3 |   0 | **+3** |  0.2500 |
| clock vs `layered`+acts, first repetition  |       102 |     108 |   97 |       8 |   5 |  11 | **−6** |  0.2101 |

The three like-for-like variants bracket zero, and the arithmetic of the difference closes to the second decimal:

```text
102 − 108 = −6 questions (−4.96 points)   the reading this round was dispatched to make
101 − 108 = −7 questions (−5.79 points)   the resolution, from 45543010618's own MR row (+6.20 mean)
102 − 101 = +1 question  (+0.83 points)   the clock line, on the arm the run actually ran
−5.79 + 0.83 = −4.96                       nothing unexplained
```

**Criteria.** `C1` fails (`+1` first repetition, `−1` both-runs, against a bar of `≥ +4`). `C2` fails
(`p = 1.0000`). `R1` fails (`102 < 112`). `R3` **passes** like-for-like and is the one informative number here:
delivered prompt characters against the raw control are median **+0**, mean **+0.005%**, range `−270 … +286`. The
line is not free — at the 48,460-character cap a 610-character instruction displaces 610 characters of evidence —
and the exchange was a wash.

`C3` and `C4` are **unreadable**, not failed: both are censuses of `rawOutput`, and the artifact stores replies for
its feature side only. The `50 → 53` period-citation movement reported in `AUDIT-EXCLUSION-CENSUS.md` compared
`raw`+clock against `layered`+acts, so it is a reading of the rendering rather than of the line (`§7` of that
audit now says so).

**Verdict: retired.** By its own rule, a line that buys no question on 121 and cannot be shown to move the census
it names has nothing to adopt. `verbatim-acts` stays.

## 7. What the round found instead, and it is worth more than the axis

Two runs can differ in a field neither the population rule nor the accuracy table can see. The population rule
compared `questionCount`, `dataset` and the id set; those were equal, and the table printed a delta that belonged
to a field nobody had named. That is the same shape as `S8`'s first dispatch (`44835820692` against
`44829684980`, control at `multi-session:62000`), which had to be re-derived through a third arm — the second
occurrence of a class the repository had already paid for once.

The fix is mechanical rather than another paragraph:

1. `tools/paired-delta-census.mjs` now compares `memoryArmConfig` key by key and **refuses to print a table** when
   the two artifacts differ outside the two exempt classes (`census` fields, which two runs of one configuration
   disagree on by design, and `derived` fields, which would report one cause twice). A difference the run _was_
   dispatched for is declared on the command line (`--allow-arm-drift ask`) and printed with the table, so the
   reading cannot be quoted without the sentence that makes it readable. Six new self-test assertions, one of them
   on the exact refusal message this round would have produced.
2. `repo-gates.test.ts` classifies every `CORTEX_MEMORY_*` variable `bench-memory-arm.ts` reads by **how a
   dispatch can reach it** — `input`, `setting` (a `vars.` lookup), `pairing`, `literal` — and fails on any axis
   with no written reason. The count is the round's second finding and it is worse than one field: **twelve of
   the arm's twenty-nine axes cannot be moved by a dispatch payload**, ten of them because the workflow is at 24
   of GitHub's 25 inputs and keeps a repository setting instead, two because `semantic-carry.yml` expresses them
   as a pairing. A dispatch that believes it moved one field is also administering whatever those ten settings
   say, and its artifact reports them as decisions.
3. The same test asserts the two facts that made this round possible and that nothing stated before: the workflow
   that can move the ask falls back to `raw`, and the workflow that renders `layered` hardcodes
   `CORTEX_MEMORY_ASK: verbatim-acts`. **No workflow prices an ask at the rendering that ships.** Asserted as an
   absence, so the day an input exists the test is red and the sentence has to be rewritten.

**What is now open, and it is an audit rather than a gain:** the ask axis's adoption row (`§13.291`/`§13.318`) was
priced on `raw` — every ask dispatch went through this same workflow — while the arm that ships renders
`layered`. Closing it needs no code: `vars.CORTEX_MEMORY_RESOLUTION` is read before the `'raw'` fallback, so
setting that repository variable to `layered` makes the next A/B dispatch render the shipped arm, and the artifact
records the value it rendered. One `MR` dispatch of `verbatim-acts` against the reference block, both at
`layered`, re-prices the shipped ask at **¥5.87**. It is a settings change rather than a commit, which is why the
round that makes it has to say so in its report: git cannot see it, and the artifact is the only record.

### 7.1 Two paragraphs above were superseded one round later, and the replacements are better

Kept as written rather than edited, because both are the readings of their round and a document that quietly
improved would hide which of its sentences were wrong.

**Item 3 is now a positive assertion.** It read _"no workflow prices an ask at the rendering that ships"_, asserted
as an absence with the note that the day an input exists the test is red and the sentence has to be rewritten. It
went red in `§197`. The replacement asserts three facts: `semantic-carry.yml` takes the ask from `${{ inputs.ask }}`,
its `CORTEX_MEMORY_RESOLUTION` branch names both `resolution` and `ask` on the `layered` side, and the declared
default is `verbatim-acts` — so a bare `pairing=ask` dispatch prices **the shipped block** against the reference
block.

**The last paragraph's route is not the route taken.** Setting `vars.CORTEX_MEMORY_RESOLUTION=layered` would have
made the next A/B dispatch render the shipped arm — but as a **settings change**, invisible to git, with the
artifact as the only record, and it would still have compared two dispatches rather than two sides of one pass. The
`pairing=ask` value added in `§197` does the same reading with neither drawback: one job, one corpus, one
instruction block between the sides, both rendering `layered`. It costs no dispatch input because
`semantic-carry.yml`'s `pairing` is an enumerable axis selector and that workflow is at 13 of GitHub's 25 inputs,
where the ask's own workflow is at 24.

The reason the better route was not obvious from here is worth recording: this round's diagnosis was _"the field
cannot be named"_, and `§197`'s was _"the field does not need to be named — the axis selector already exists one
workflow over."_

### 7.2 The open item is closed, and it closed with a p-value

§7.1 left one thing open and named its price: one `MR` dispatch of `verbatim-acts` against the reference
block, both at `layered`, **¥5.87**. It was dispatched as `45781692092` and it read:

| population | gap | exact McNemar |
| --- | --- | --- |
| `MR`, first window (the one whose prompt can be the registered one) | **+8.27** points, 99/97 → 108/108 of 121 | `p = 0.0117 · 0.0074` |
| `MR`, both windows pooled (the table's default is two) | **+8.88** points, 390/484 → 433/484 | `p = 1.5e-6 · 5.4e-4` |

`MR` is 24.2% of the 500 and `verbatim-acts` changes that route and no other, so the set-level value is
**+2.00 points** — one question from the +1.80 an unpaired comparison of two artifacts had been quoting.
Nothing is adopted (the block already ships and is already inside the 93.40); what changed is that the
largest single mechanism in this register now has a test on the arm that ships, and that `§13.294`'s
`+4.13` is explained as a reading against a **different control** (`verbatim`, not `route`) rather than as
a number this one contradicts.

The dispatch cost **¥12.83**, not ¥5.87, and the difference is the table's own `windows: 2` default that
this dispatch did not override. `docs/MEASURE-ASK-PRICE.md` carries the reading, the arithmetic of the
overrun, the instrument gap it exposed (a merged artifact drops all thirty-three statistic fields, and the
tool that reads one never tested), and the one prediction it leaves open: `verbatim` against `route` has
never been measured, and the arithmetic says it is worth about +4.1 for ≈¥3.0.

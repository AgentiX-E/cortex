# The first row where a competitor answers our questions under our reader

Every "gap" this campaign has quoted was a difference between two **harnesses**: our arm's 91.25% against a
vendor's self-report produced by a different reader, a different judge and a different prompt. `PLAN-COMPETITOR-HARNESS.md`
§7 replaced that with the only arrangement that measures anything — fix the instrument, vary whose memory answers.

This file is the first reading from that arrangement. It cost four dispatches and about three hours of runner
time, and it produced four results, of which **two are decidable**:

1. **The T1 table has two rows with an accuracy cell each, read under one instrument.** `mem0` 2.2.1 ran its own
   code on our 20 questions, our `con` reader, our judge, and `k = 10`, and answered **11 of 20**. The control
   arm, `cortex-session`, answered **13 of 20** (`43199357450`, `temp=0` both sides).
2. **The pair is two discordant questions, both ours, and that is not a ranking.** Exact McNemar over
   `(11, 2, 0, 7)` is **p = 0.50**: `mem0` converted none of the seven questions we missed, we converted two of
   the nine it missed, and twenty questions cannot turn that into a verdict. The direction is one-sided; the
   size is unmeasured.
3. **The cost difference is decidable and large.** 1,768 prompt tokens per question against 33,556: **19.0×**,
   in `mem0`'s favour, on the same twenty questions and the same reader.
4. **The arm is repeatable at this size, task-level.** Three `temp=0` dispatches — `43197264759`,
   `43198214714`, `43199357450` — all read `cortex-session` at **13 of 20**, and the first two produced
   **byte-identical artifacts**. §3 keeps the history of the reading that failed this check before the
   workflow's temperature was pinned.

## 0. What ran

| | run A `43170314351` | run B `43178388235` | run C `43199357450` |
| --- | --- | --- | --- |
| questions | 20 (round-robin, `id`-sorted within capability) | same 20 | same 20 |
| `sut` | `mem0`, `sut_infer=0` | same | same |
| read arms | `mem0,cortex-session` **→ mem0 absent** | `mem0,cortex-session` | `mem0,cortex-session` |
| read prompts | `con` | `con` | `con` |
| reader | `deepseek-chat` (Chain-of-Note, one request, `temp=default`) | same | `deepseek-chat` (Chain-of-Note, **`temp=0`**) |
| judge | `deepseek-chat`, `longmemeval-official-per-type` | same | same, `temp=0` |
| `k` / scoring | 10 / `single` | same | same |
| dataset | LongMemEval-S cleaned | same | same |
| mem0 ingest | 972/972 sessions, 0 refused | 972/972, 0 refused | 972/972, 0 refused, embedder cache keyed on the dataset digest |
| mem0 manifest | `2.2.1`, `build=embedding`, `infer=false`, `faiss`, `embedding-3` @1024d | same | same |

Run A did not read `mem0` at all: the reading stage is a second invocation and it never launched the competitor,
so `--read-arms mem0` matched nothing and the run finished green with the only A-grade arm absent from the table
it exists to fill. That is fixed in `.github/workflows/competitor-retrieval.yml` and pinned by
`tools/__tests__/test_sut_read_wiring.py` (§4).

Run C differs from B in one field and one field only — the sampling temperature, which B never received (§3) —
and it is the run §1 quotes. Its reader identity is written into the artifact by
`tools/reader-identity.mjs`, so the field cannot be absent from a table again:
`deepseek-chat (chain-of-note/con, temp=0, one request)`.

## 1. The table (`43199357450`, both arms at `temp=0`)

> The accuracy column was withdrawn for one round (§3) and is restored here from the pinned re-read. The
> retrieval and cost columns never moved: they are properties of the systems, not of the sampler, and run B's
> figures reproduce to the token.

| provider | build | recall@k | all-gold | MRR | **accuracy** | ~tok/question |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `cortex-session` | none | 85.0% | **80.0%** | 0.792 | **13/20 = 65.0%** | 33,556 |
| **`mem0` 2.2.1** | embedding | **100.0%** | 0.0% | **0.908** | **11/20 = 55.0%** | **1,768** |

The interval, which is the part a reader must take with the point estimate:

| arm | correct | 95% Wilson | what the interval rules out |
| --- | ---: | --- | --- |
| `cortex-session` | 13/20 | **[43.3%, 81.9%]** | any accuracy claim above 82% or below 43% |
| `mem0` 2.2.1 | 11/20 | **[34.2%, 74.2%]** | the same, one question lower |

The two intervals overlap across 31.7 points of their length, so **the row order is a point estimate and not a
measurement of which system is better**. What the row does establish is that the arrangement runs end to end
with a competitor's own process, its own vector store and its own embedding model, under one reader and one
judge — `comparability()` grade **A**.

Per capability, accuracy:

| capability | `cortex-session` | `mem0` |
| --- | ---: | ---: |
| `ABS` | **4/4** | 3/4 |
| `IE` | 1/4 | 1/4 |
| `KU` | 4/4 | 4/4 |
| `MR` | **3/4** | 2/4 |
| `TR` | 1/4 | 1/4 |

Both arms are read by one function with one prompt, so the only difference between the two rows is whose memory
produced the text. `TR` at 1/4 in both is the `con` prompt's known omission (no date, no arithmetic), not a
finding about either system. `IE` at 1/4 in both is the reader failing on the same four questions, which is why
the inter-arm difference sits in the two capabilities where the retrieval shape differs.

## 2. The pairing, which is the evidence and the totals are not

| | `mem0` wrong | `mem0` right |
| --- | ---: | ---: |
| **`cortex-session` wrong** | 7 | **0** |
| **`cortex-session` right** | **2** (`031748ae_abs`, `0100672e`) | 11 |

Two discordant pairs, both in one direction, eleven ties: exact McNemar **p = 0.50**. The sign test over two
discordant questions is `2⁻¹`, so the honest reading is *the direction survived the repair and the count did
not grow*: at `temp=default` the same table was `(1, 2, 10, 7)` — one for us, two for `mem0` — and at `temp=0`
`mem0` converts nothing of the seven we miss.

`031748ae_abs` is an `ABS` question and `0100672e` is `MR`. At `temp=default` the two capabilities told the
opposite story (`IE` and `KU` for `mem0`, `MR` for us), which is what a sampler moving one question per arm
does to a capability claim built on four questions per capability. **No mechanism story is quoted from this
table at n = 20**, and the two that were quoted last round are retracted in place rather than re-explained.

## 3. `H5` failed — and the cause was the workflow, not the arm

The control arm was read twice, on the same 20 questions, through the same reader and the same judge:

| run | reader identity | `cortex-session` correct | per-question agreement |
| --- | --- | ---: | ---: |
| A `43170314351` | `temp=default` | **13/20** | — |
| B `43178388235` | `temp=default` | **11/20** | **16/20 = 80.0%** |

Four questions flipped: `0100672e`, `031748ae`, `031748ae_abs` (right → wrong) and `09ba9854_abs`
(wrong → right). `H5`'s threshold is 90%, so by the criterion written before the dispatch:

> **at n = 20 this arm's run-to-run movement (2 questions) is twice the inter-arm difference (1 question), so no
> ranking of two systems may be taken from a single 20-question pass.**

**The second half of that sentence stands; the first half was re-attributed one round later.** This file
called the movement a property of the arm. It was a property of the workflow: `competitor-retrieval.yml`
forwarded no `TEMPERATURE`, so every T1 row was served at the provider's default, while the product table
was pinned at 0. `MEASURE-READER-DETERMINISM.md` records the repair and the two dispatches that close it —
`43197264759` and `43198214714`, identical inputs at `temperature=0`, **13/20 both times, 20/20 = 100.0%
agreement, zero flips**.

So three things are now separable, and this file had them fused:

| statement | status after the repair |
| --- | --- |
| the arm is noisy at n = 20 | **falsified** — the pinned arm is bit-stable on this population |
| the numbers 55.0% and 60.0% in §2 are quotable | **withdrawn** — they were read at `temp=default`, and the control's own two readings differed by more than the inter-arm difference. Restored as **65.0% and 55.0%** from `43199357450` |
| n = 20 cannot rank anyone | **established by the interval, not by the gate.** `H5` passes; the ranking objection is now `[43.3%, 81.9%]` against `[34.2%, 74.2%]` and `p = 0.50` |

The third draw is what closes the loop rather than the second. `43199357450` re-ran the whole pipeline — ingest,
both arms, `con`, judge — and read `cortex-session` at **13/20** for the third time, with the retrieval and cost
columns reproducing `43178388235` exactly (85.0% / 80.0% / 0.792 and 33,556 tokens; `mem0` 100.0% / 0.0% / 0.908
and 1,768). A count that survives one re-dispatch is a pair; three of them, one of which took a different path
through the workflow, is the population being stable and the sampler being the variable that moved.

This is the same defect class the campaign already found once in this instrument — two invocations of one
harness disagreed by five questions per arm, which is why `--json-out` exists — except the movement was on
the accuracy column rather than on the table's provenance, and the mechanism was a missing request field
rather than a second process.

## 4. The defect run A found, and the guard on it

Run A's reading table carried no `mem0` row while its retrieval table carried `mem0` at 100.0% recall. Cause: the
three reading stages are separate processes, `--read-arms` selects providers **by name**, and a process that never
launched the competitor has no provider by that name. The filter matched nothing, silently.

The repair forwards `SUT`, `MEM0_INFER` and `ZHIPU_API_KEY` into all three reading stages and passes `--sut` when
the input is non-empty (`--sut ""` is an error rather than "none", so the flag is built by a shell test). The
guard, `tools/__tests__/test_sut_read_wiring.py`, **derives** the reading stages from the workflow — any step that
invokes `competitor-harness.mjs` with `--read` must be able to host a system under test — so a fourth prompt added
later is covered the moment it exists. Verified both ways: three of its five assertions fail against the previous
workflow, all five pass against this one.

## 5. What this licenses

- **A statement about cost, against us:** `mem0` reads **1,768** prompt tokens per question where we read
  **33,556** — 19.0× — while scoring one question lower on this population. The direction has a mechanism: it
  returns extracted memory entries rather than turns, and its `all-gold` is **0.0%** against 80.0%. It finds
  *one* annotated evidence item every time and *all* of them never. That is the cost the product pays for
  delivering turns verbatim, and it is the number `C1` argues about in house terms (9,168 tokens/question) on a
  different axis.
- **A statement about the harness:** the T1 pipeline runs end to end with a competitor's own code, its own
  process, its own vector store and its own embedding model, under our reader and our judge. Four dispatches,
  `comparability()` grade **A**, and three of them reproduce the control arm's count exactly.
- **A statement about the sign, not the size:** `mem0` converted **0 of 7** questions our arm missed, and our arm
  converted **2 of 9** of its misses. At n = 20 that is `p = 0.50`; what it does rule out is the inverted
  reading, that `mem0` answers questions we cannot.

## 6. What it does not license

- **No ranking.** `p = 0.50`, and the intervals overlap across 31.7 points.
- **No comparison with 91.25%.** That is T2 — the product's own reader and routes. This is T1. Subtracting across
  the two is what `comparability()` grades `B`, and the campaign has already made that mistake twenty times.
- **No claim about `mem0`'s published 94.4%.** `infer=false` is a different system from the one that number
  describes, and the manifest says so beside the row.
- **No claim about `MR`/`TR` or about any capability.** Both arms are at 1/4 on `TR` because the reader is; the
  arm-level gap is two questions, so a per-capability gap of one question is the sampler's resolution.
- **No claim that the 19.0× is `mem0`'s ceiling.** It is what its `infer=false` configuration returned at `k = 10`
  on this corpus.

## 7. What a decision costs, and what the last row got wrong

| step | questions | ingest wall clock | read+judge wall clock | calls | decides |
| --- | ---: | ---: | ---: | ---: | --- |
| smoke (this) | 20 | 49m13s | **50m48s** | 80 | that the pipeline runs |
| **decision** | **100** | minutes (cache warm) | **~4h14m** | **400** | a ranking, if the count holds at five times the population |
| cost-matched | 100 | same | **~35m** | 400 | a ranking at equal context budget (§7.2) |
| full row | 500 | ~21 h cold / minutes warm | ~21 h | 2,000 | a quotable row beside the product table |

### 7.1 The "55×" this file used to quote was a measurement of the wrong stage

The previous version of this table said the ingest was **55×** the answering cost — 49m42s against 54s — and
concluded that the ingest was the lever. The 54s was a retrieval-only stage: the reading stage in that dispatch
answered **nothing**, because the arm it was asked to read was absent (§4). `43199357450` ran both stages and
spends **49m13s** ingesting and **50m48s** reading and grading — `0.97×`, not 55×.

The correction changes which lever matters, so it is recorded rather than quietly deleted:

- The embedder cache (`03` §14.130) removes the **ingest** half of a repeat dispatch. Worth having, and it does
  not make the run cheap, because the other half is now the floor.
- The floor is the reader's **context**, not the vendor's pipeline: 40 calls over 33,556 tokens each take 50
  minutes at roughly 76 s per call, so 400 calls take four hours. A 19× smaller context is a 19× cheaper
  measurement — and that is an argument about what to *measure*, not only about what to build.

### 7.2 The row that is missing is the cost-matched one

`cortex-session` answers from **whole sessions** and `mem0` from **extracted entries**, and the table compares
them at equal `k` with a **19×** difference in delivered context. A cost-accuracy claim cannot be built on that
pair, in either direction: our +2 questions cost 19× the tokens, and a 19× budget is not a fair handicap to
give ourselves.

The same artifact already carries the row that can: `cortex/trim-2.8k`, **2,799** tokens at `k = 10`, which is
**1.58×** `mem0`'s 1,768 rather than 19×. Its retrieval on the full 500 is weaker — recall@k 80.8% against 94.0%,
all-gold 12.4% against 82.2% — and that is exactly the trade the reading would price. Reading
`mem0,cortex/trim-2.8k` at n = 100 is the cheapest row in this file that could support a SOTA statement about
cost *and* accuracy at once, and it is the next dispatch this file recommends.

> It ran on `43216630823` and the answer is §9: **1.44×** the tokens, 54/100 against 59/100, paired
> p = 0.4583. The 1.58× quoted above was the n = 20 reading; the n = 100 dispatch delivered 2,799 against
> 1,942, which is 1.44×. The trade is real, it is priced, and it is not yet resolved in either direction.

## 8. Reproduction

```sh
# the table in §1: both arms, pinned sampler
gh workflow run competitor-retrieval.yml \
  -f questions=5 -f read_questions=20 \
  -f sut=mem0 -f sut_infer=0 \
  -f read_arms=mem0,cortex-session -f read_prompts=con -f limit=10 -f temperature=0

# the two artifacts this file reads
#   art-43199357450/competitor-read.txt   temp=0: cortex-session 13/20, mem0 11/20
#   art-43178388235/competitor-read.txt   temp=default: cortex-session 11/20, mem0 12/20  (accuracy withdrawn)
```

## 9. The decision row: n = 100, with the cost-matched arm in it (`43216630823`)

`7.2` named the missing row and recommended it. It ran: `read_arms` carried `mem0`, `cortex-session` and
`cortex/trim-2.8k`, one invocation, one sample of 100 questions round-robin across the five capabilities, reader
and judge both `deepseek-chat` at `temp=0`, `k = 10`. One artifact, so every row below answered the same questions
— which is what makes §9.2 a paired test rather than two percentages.

### 9.1 The table

| provider | build | recall@k | all-gold | MRR | accuracy | ~tok | per correct answer |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `cortex-session` | none | 87.0% | **73.0%** | 0.746 | **65/100** | 33,310 | 51,246 |
| `cortex/trim-2.8k` | none | 73.0% | 6.0% | 0.708 | 54/100 | 2,799 | 5,183 |
| `mem0` 2.2.1 | embedding | **99.0%** | 4.0% | **0.846** | 59/100 | **1,942** | **3,292** |

`~tok` is `meanContextChars / 4` per question — delivered evidence, not the whole prompt. The last column is
`~tok × 100 / correct`: the bill for one right answer, which is the quantity `H9` asks about because a cost
comparison whose denominator is questions rewards an arm for answering *less*.

Configuration was identical across the three rows, and the harness printed `comparability(identical): A`. Ingest
stored **4,713 of 4,713** sessions with 0 refused; the SUT returned 0 refusals and 0 empty results over 100
questions. The two retrieval-only rows in the same run (`cortex/whole-8t`, `null-floor`) and the two unread
`cortex/trim-8t` / `lexical-reference` rows are excluded here because they carry no accuracy — §9.4 is about what
their absence means.

### 9.2 The pairing, and the one line that reaches significance

`node tools/paired-test.mjs --within competitor-read.json` — three pairs, exact McNemar, alpha 0.05:

| baseline -> treatment | n | + | − | delta | p | verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `cortex-session -> cortex/trim-2.8k` | 100 | 6 | 17 | **−11.0%** | **0.0347** | regressed |
| `cortex-session -> mem0` | 100 | 11 | 17 | −6.0% | 0.3449 | not significant |
| `cortex/trim-2.8k -> mem0` | 100 | 17 | 12 | +5.0% | 0.4583 | not significant |

Three sentences, and the first is the uncomfortable one:

0. **At α = 0.01 this run has no significant line at all.** The same command at `--alpha 0.01` prints three
   `not significant` verdicts, so the one result below survives at the conventional threshold and nothing
   stronger. A single p = 0.0347 with three comparisons is also the weakest form of evidence there is
   (Bonferroni would put it at 0.104), and it is quoted here because it is *against us*: no multiplicity
   correction is needed to take a loss seriously.

1. **The only real difference in this run is between our two arms.** `cortex/trim-2.8k` is 11 points behind
   `cortex-session` (17 questions lost against 6 gained, p = 0.0347). That is a *cost curve*, not a competitor
   result: cutting 91.6% of the delivered context costs 11 points of accuracy. `C6` measured the same shape from
   the other end — a 27.1% bill cut for 4 points — so the two now agree on the price of evidence in this task.
2. **Our +6 over `mem0` is not a win.** 17 questions went to `mem0` and 11 to us; p = 0.3449. A 6-point gap on 100
   questions is a coin (28 discordant pairs split 11:17 does not clear 0.05). Writing "+6" in a table without this
   line is the error `MEASURE-PAIRED-POWER.md` exists to price.
3. **Our −5 at cost parity is not a loss either.** `trim-2.8k` trails `mem0` by 5 points at **1.44×** the tokens
   and p = 0.4583. Same coin, other side.

### 9.3 What §9.2 licenses and what it does not

**`H8` is satisfied for the first time.** The cost-parity hypothesis needed a pair whose delivered context is
within 2×; `cortex-session` against `mem0` is **17.15×** and cannot answer it, `cortex/trim-2.8k` against `mem0` is
**1.44×** and can. So the comparison now exists — and its result is "no significant difference in either
direction at n = 100", which is a *different* statement from "we are behind" and from "we are ahead".

**No accuracy claim is available from this run at n = 100, in either direction.** That is not a reason to run more
of the same: a 5-point difference at this discordance needs roughly four times the questions to resolve, and the
four-hours-per-100 wall clock in §7 makes that a day of runner time for one sentence. The cheaper route is the one
§9.4 opens — raise the accuracy of the cheap arm so the gap is no longer near zero, and only then spend the
questions on proving it.

**`all-gold` is an arm-shape statistic, not a quality statistic.** `mem0` covers every gold turn on 4.0% of
questions and still answers 59 of 100; `cortex-session` covers every gold turn on 73.0% and answers 65. An
extractor that returns short entries rarely contains *all* of a multi-turn gold set, and that says nothing about
whether the reader can answer from what it did return. Any future row that quotes `all-gold` as evidence of
retrieval quality across providers of different granularity is reading a property of the unit size.

### 9.4 The two defects this run found, and what each cost

**The paired step could not express this comparison at all.** `competitor-paired.txt` carried two lines, both
`skipped, a run file is missing`, because the step pairs *prompt shapes* of one arm across two files — `con` and
`dispatch`, `dispatch` and `dispatch2` — and this dispatch asked for neither. The job reported success, the Summary
printed two skip lines, and the three arms in `competitor-read.json` were never compared by anything in the
workflow. The three-arm table above was a hand computation in a shell before this section existed, which is exactly
the second-comparer defect `tools/paired-test.mjs` was written to prevent, one level up.

The repair is `compareArmsInRun` in `cortex-eval` and `--within` on the tool: one run file, every pair of *read*
arms, the same McNemar over the same records. It refuses the four ways this can be asked wrongly — a self-pair
(zero by construction), a name absent from the run (a dispatch that did not select it), an arm that was never read
(`correct: false` throughout, so it scores as a floor), and two arms over different question lists (within one run
that is a lost record, not a property of the systems). `competitor-retrieval.yml` now runs it as its own step, so
the numbers in §9.2 come from the artifact rather than from a shell.

**`below-cap` was being reported on runs whose window was full.** The cost ledger's fill test divides one room by
the mean tokens per call; on a redistribution that quotient is scaled by `narrowest / mean_room`, so a run that
filled **every** route still lands below the band. `43264749133` read `below-cap` at 3.29 while
`tools/evidence-budget.py` measured **99.0% median utilisation** against the same rooms. The ledger now withholds
the reading (`indeterminate`) whenever the room spread could move a full delivery out of the band, and names the
instrument that can answer it. Two readings of one artifact disagreeing is not a matter of taste; the one that was
wrong is now silent about the question it cannot answer.

**A third defect, found while writing §9.5: `--alpha` had never worked.** The tool split `argv` on the `--` prefix
and then read `argv[at + 1]` for the value, so `--alpha 0.01` left `0.01` in the positional list and the run
printed its usage instead of a table. The flag is documented in the tool's own header, which is the part that makes
this worse than an absent option: the header promised a comparison at a stated threshold and no invocation could
ask for one. §9.2's zero-th sentence is the reading it exists for.

### 9.5 Reproduction
```sh
# the reading stage in §9.1: one invocation, three read arms, pinned sampler
gh workflow run competitor-retrieval.yml \
  -f questions=5 -f read_questions=100 \
  -f sut=mem0 -f sut_infer=0 \
  -f read_arms=mem0,cortex-session,cortex/trim-2.8k -f read_prompts=con \
  -f limit=10 -f temperature=0

# §9.2, from the artifact alone
node tools/paired-test.mjs --within competitor-read.json
node tools/paired-test.mjs --within competitor-read.json --alpha 0.01   # and how much of it survives
```

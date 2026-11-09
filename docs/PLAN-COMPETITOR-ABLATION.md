# Racing the two leaders, or porting their variables

**The question.** Should we run MemStrata and Zep on our Runner, find out why MemStrata is more accurate and
Zep more token-efficient, and then replicate both to surpass them?

**The answer, in one line.** The question is right and the method as stated cannot answer it: **neither
system can be raced**, and one of the two gaps is not a mechanism gap at all. What can be done is to port
each mechanism as a **single-variable toggle inside our own pipeline** — which is also the only arrangement
in which the comparison is paired, same judge, same reader, same 500 questions.

---

## 1. Why the code cannot be run, stated per system

`COMPETITOR-CODE-AVAILABILITY.md` §4 is the inventory, checked against the GitHub API on 2026-11-07:

| system | reported | repository | consequence |
| --- | ---: | --- | --- |
| MemStrata (`arXiv:2610.05343`) | 92.6% (463/500) | **none found** | there is nothing to clone. The **arms** are single-variable and reproducible; the system is not. |
| Zep / Graphiti | ~4,400 tokens/question | `getzep/zep`, Apache-2.0 | runnable, and running it measures something other than the claim (§1.2). |
| Letta | 438/500 = 87.6%, **matched reader** | `letta-ai/letta`, Apache-2.0 | the only row with a published number *on this benchmark at a comparable reader*. This is what "race a competitor" means, and it is already first in the queue. |

### 1.1 MemStrata: the ablation we want is in their paper, and it is single-variable

The "why is it more accurate" question is already measured by its authors, on 500 questions, one variable at
a time:

| arm | score | what it isolates |
| --- | ---: | --- |
| CL1, the bounded packet (24,000 tokens, pinned tokenizer) | 463/500 = 92.6% | the system |
| keyword-only selection, **same budget** | 425/500 = 85.0% | **ranking is worth 7.6 points** |
| matched-reader Letta | 438/500 = 87.6% | their system against a competing design |
| full history, ~4.7x the evidence | 464/500 = 92.8% | **volume is worth +0.2 points, i.e. nothing** |

So the answer to "why is MemStrata more accurate" is **not** compression and **not** volume. It is
**selection**: 7.6 of the 10.6 points between their packet and a bag of keywords come from which spans are
chosen, and the 5.0-point gap to Letta is a memory-design gap at a matched reader. Reproducing that requires
no clone; it requires our own selection to be as good, which is what `S3`'s 71.7% on 121 multi-session
questions is the current reading of.

**The one MemStrata variable nobody has run** is attribution. Their packet carries **non-duplicated, dated,
speaker-attributed source spans** and reaches 92.6% at 24,000 tokens; this arm withholds the per-turn source
id (§13.283, on a census showing the reader reproduces an id in 4 of 500 answers) and reaches 90.20% at
12,105. Both are true and the difference is the price. **A fixed-budget arm that adds attribution back** is a
single-variable test of what the extra tokens buy, and neither paper has it. That is the experiment worth
running, and it is ours to run.

### 1.2 Zep: the number is not a retrieval number, and ours is not either

Zep's ~4,400 tokens per question is the cheapest published point on the board and `C1` quotes it as the bar.
Two things have to be said before anyone tries to reproduce it.

**Their number comes from a graph service configuration, not from the Apache-2.0 package.** Graphiti needs
Neo4j or FalkorDB, its `add_episode()` runs a **model call per episode** to infer `valid_at`/`invalid_at`,
and Zep's published LongMemEval figure came from its own deployment. Running the OSS package with our
extraction model is a measurement of **our ingest**, and the per-question LLM extraction cost would dominate
the dispatch. That is not a reason to refuse a reading; it is a reason to stop calling it a reproduction.

**And the comparison would be between two different quantities.** `§13.293.2` measured that this arm's
delivery **fills** its 48,000-character cap: 48,000 / 4.13 = 11,620 tokens, against 12,105 reported. So
**our context number is a configuration constant, not a retrieval outcome** — retrieval improving would not
move it. Zep's 4,400 *is* a retrieval outcome: a subgraph selected per question. Comparing them is comparing
a cap to a selection.

The repair is therefore not "run Zep". It is:

1. **State the cap as a cap**, which `C1`'s own text now does, and
2. **change the unit to tokens** so the same budget is comparable, which `§13.287.2` registered and no arm
   has read, and
3. **read the bill**, because a cache hit is priced at 2% of a miss and the registered arm runs at 98.34%
   hits — so the axis a customer pays on is not the axis `C1` reads. **That reading does not exist yet**, and
   the reason is recorded rather than estimated: the only reduced-budget arm ran two repetitions against a
   control that ran four, the hit share moves with the repetition count, and `tools/efficiency-frontier.mjs`
   now refuses the comparison instead of printing a column (`C3` is `unrun` with that blocker named).

So the answer to "why is Zep more token-efficient" is: **on context, because it selects and we fill a
window** — that is measured (§13.293.2) and it is a configuration, not a mechanism we lack. On money, the
claim has not been tested, and the first two readings this project produced on it (1.07x, then 6.90x) were
both the repetition count. That is `A3`'s job and it is one dispatch.

---

## 2. The rule this leaves, for every future competitor

> **Race the systems that published a matched-reader number on this benchmark. Port the variables of the
> systems that did not. Never port a number.**

| class | test | examples | instrument |
| --- | --- | --- | --- |
| **raceable** | published number *on LongMemEval-S* at a comparable reader, plus permissive licence | Letta (438/500), Mem0, MemOS | `tools/competitor-sut/`, same reader, same judge, same 500 |
| **portable** | published single-variable ablation, no repository | MemStrata, Agent Zero, TEPA | toggle inside our pipeline; the variable is the arm |
| **quotable only** | vendor number, no recipe, no ablation | Recallium 98.4%, ContextStream 96.8% | a bar on `C1` and nothing else |

The middle class is the one this round is about, and its protocol has four rules that make it a measurement
rather than an impression:

1. **One variable.** The toggle is a field, not a pipeline. If two things move, nothing is learned.
2. **Paired, same dispatch.** Both arms in one run over the same 500 questions, so the accuracy axis is
   compared within the noise floor of one judge rather than across two (§13.312.8 measured an 8–9 point
   judge main effect across dispatches and 0–1 questions of arm effect inside one).
3. **Both cost axes.** Context tokens **and** billed tokens, because the first is comparable to the field and
   the second is what is paid (`C3` exists because one of them moved the wrong way).
4. **A pre-registered criterion before the arm is dispatched**, in `acceptance.ts`, with `onMiss`.

---

## 3. Four substitution ablations, registered

Each is a field on the existing arm, each has a criterion, and each is priced in dispatches rather than
described as work. None is dispatched this round; the queue order is the order below.

| id | variable | what it tests | criterion | cost |
| --- | --- | --- | --- | --- |
| **A1** | attribution back at a **fixed** budget (per-turn source id + turn date, cap held at 48,000 chars) | MemStrata's 2x attribution spend: is the accuracy theirs or the tokens'? | `MR` ≥ the registered arm's within the 2.5 pp margin, **and** `C3`'s bill not above 1.0x | 1 dispatch, 4 repetitions |
| **A2** | budget unit **characters → tokens** (cap expressed at 11,620 tokens) | `§13.287.2`: the same budget buys 2.62x more tokens when written in tokens, or 2.62x fewer when written in characters | `C1` ≤ 6,000 with `S1` ≥ 90.20% − 2.5 pp, read on the frontier | 1 dispatch |
| **A3** | **selection instead of fill**: a per-route room (`multi-session` keeps the cap, single-turn routes shrink) | 252 of 500 questions answer from one turn and 248 count over turns; the flat 24,000-character cut bought `MR −6.61` and `TR −4.72` against `ABS 0.00` and `IE −0.67` | `C2` ≤ 0.70 **and** no gated capability drops beyond the margin, with `C3` readable — i.e. `dominates` on the three-axis order | 1 dispatch, **4 repetitions** (2 cannot make `C3` readable, see below) |
| **A4** | **legacy retrieval**: last-write-wins over the ledger, no revocation | TEPA's reversal table says append-only lands *below no memory at all*; this asks whether the same is true of a store that already has the state field | on a reversal set (key, two values, one reversal, no generation): `V1` ≥ +64.7 pp against `flat`, and retired facts served = 0 | 1 synthetic run, no judge |

`A3` is the one that decides the cost axis, and it is the direct answer to "why is Zep more token-efficient":
because we do not select. `A1` is the one that decides the accuracy axis against MemStrata, and it is the only
arm in the table whose result could be published as a comparison rather than as a reading.

### 3.5 `A3` has been read, and it did not reach its own bar

`A3` was dispatched as `C5` (`42533236864`) and adopted by `§13.336`; the criteria have to be compared
one at a time, because they were not all met.

| criterion | registered | read | verdict |
| --- | --- | ---: | --- |
| `C2` (context per question, against 12,105) | **≤ 0.70** (8,473) | **0.76** (9,201) | **not met** |
| `C5`'s own registration (`MEASURE-COST-LEVER.md` §5) | ≤ 9,300 with accuracy ≥ 90.80% | 9,201 at 91.05% | met |
| no gated capability beyond the margin | — | `ABS` 30/30, `TR` 95.28%, `IE` 94.00%, `KU` 87.50%, `MR` 83.47% | met |
| `C3` readable | — | 94.93% prefix-cache share, 0 retries | readable |

The stricter of the two registrations is the one that governs, so the honest reading is **`A3` fell 8% short
of its own bar**, and the previous round reported `C5` as passing without saying so. `§13.338.4` records the
correction.

**What this changes about the Zep question.** The remaining room inside the allocation mechanism is 8% and
the distance to Zep's 4,400 is 52%, so the cost axis cannot be closed by splitting rooms further. It also
crystallises something §1.2 already said: this arm's number is a **cap constant** in every configuration,
including the six-cap one, so `12,105 → 9,201` was bought by **shrinking a cap, not by improving retrieval**.
Shrinking a cap spends evidence; retrieval does not. The next 52% therefore has to come from sending fewer
*turns* while keeping the ones that carry the answer -- selection **inside** the turns, which is the one
version of the competitor's mechanism that `40614772262` did not test, because it replaced the turns instead.

`§13.338.3` prices the alternative: at this corpus's 1:1 amortisation, porting Graphiti's ingest costs
**37 questions per haystack** more than it saves, and LongMemEval asks one.

---

## 4. What would make a real race possible, and what it would cost

**MemStrata.** Nothing available. The paper publishes no repository field; `COMPETITOR-CODE-AVAILABILITY.md`
§4 records the search. A reproduction would be a reimplementation, and a reimplementation of a competitor is a
measurement of the person who wrote it. **Refused, with the reason.**

**Zep.** Runnable, and the blocker is not the licence: it is that (a) the published figure comes from a service
configuration the OSS package does not reproduce, and (b) ingestion runs an LLM extraction call per episode,
so 500 questions over ~115K-token histories is a dispatch whose cost dwarfs the comparison. The only version
worth paying for is **one frontier point**: their 4,400 tokens at whatever accuracy their OSS pipeline reaches
under *our* reader on *our* corpus — a number that would sit on `C1` beside our 12,105 and would not be
comparable to their 92.6% or to anything else they publish. Registered as **A5**, behind A1–A4, and only
after the `C3` reading stabilises, because a bill comparison against a system whose cache behaviour we do not
control is not a comparison.

**Letta.** Already first in the queue for a different reason: it is the only row with a published
matched-reader number on this benchmark (438/500). Reproducing it validates the whole competitor path end to
end. It is not a substitute for A1–A3: it tells us where the field is, not what to change.

---

## 5. What this round actually changes

| change | evidence |
| --- | --- |
| the "why is MemStrata more accurate" question is answered by its own arms — **ranking 7.6, volume 0.2** — and needs no clone | `COMPETITOR-MECHANISMS-2026-11.md` §3.4, re-read against `S3` = 71.7% |
| "Zep is more token-efficient" is **not yet a like-for-like claim**: our number is a cap constant, theirs is a selection | `§13.293.2`, `C1`'s own `onMiss` |
| **the bill has not been measured at all**, and the first two readings of it were the repetition count | `C3` = `unrun`; `docs/DESIGN-EFFICIENCY-FRONTIER.md` §1.1 |
| four substitution ablations are registered with criteria and costs, in queue order | §3 above; `A1`–`A3` map onto `C3`, `C1`, `C2` |

**The honest summary against the board.** MemStrata 92.6%, this arm 91.40%, Letta 87.6%, Reglos 87.2%. We are
above Letta and Reglos on the aggregate and below MemStrata by **1.2 points** — inside the **±2.47-point
interval** this instrument resolves, so the gap to the leader is not distinguishable from zero at n = 500 on
this reader. That is why `A1` (attribution at a fixed budget) is the experiment that matters and why the cost
axes are where a claim can be demonstrated first.

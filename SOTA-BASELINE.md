# Cortex — LongMemEval-S SOTA Baseline

This document freezes the current LongMemEval-S position of Cortex as a reproducible
baseline: where we stand, which capability each gap lives in, what has been validated,
and what the hard constraint on further gains is.

**Measured on:** `master` @ `a52628f` (revert of the DCG experiment), DeepSeek LLM +
Zhipu GLM embedding-3, temperature 0, full N=500, 4 interleaved runs.

> **This is a historical measurement, not a description of current `master`.**
> `a52628f` is **55 commits behind** `master` @ `31a3371`, and the evaluation harness
> changed substantially in between: `packages/cortex-eval/src` gained **8,326 lines
> and lost 227** across 30 files. Every capability number below is therefore an
> *anchor from the DCG-revert point*, useful for measuring deltas against that exact
> revision — it is **not** the current score, and should not be quoted as the current
> state without re-running. See
> [`docs/AUDIT-CODE-VS-DOCS.md`](docs/AUDIT-CODE-VS-DOCS.md) §2 for the drift detail
> and the reproduction command.

---

## 0. Current position (2026-11-03), and why the frozen anchor below is still here

§1 onward freezes the position at `a52628f`. This section is the **current** one, and it exists because
`docs/AUDIT-CODE-VS-DOCS.md` §2 records that quoting the frozen number as the current score is a P0
defect. The two are kept side by side rather than by rewriting the anchor: a baseline that moves with the
code is not a baseline.

**Current position, measured on `45760081761`** (the arm `S18`; 500 questions, 2 repetitions,
`resolution: layered` declared as the one departure from the registration):

| item | value |
| --- | --- |
| `feature.metrics.correct` (repetition 1) | **465 / 500 = 93.00%** |
| `featureAggregate` (two passes) | mean **93.40%**, min 93.00, max 93.80 |
| per capability, mean of the two passes | `IE` 285/300 = 95.00 · `MR` 214/242 = 88.43 · `KU` 134/144 = 93.06 · `TR` 241/254 = 94.88 · `ABS` 60/60 = 100.00 |
| reader | `deepseek:deepseek-chat`, `thinking = enabled on multi-session+temporal`, `temperature 0` |
| budget | `abstention 24,000 · assistant 24,000 · flat 24,000 · knowledge-update 24,000 · multi-session 48,460 · temporal 24,000`, `maxTurnChars 400` on `multi-session,temporal`, `turnCutMarker none` |
| prompt tokens per question | **7,346** (7,866 per correct answer) |
| ranking | `self-index`, `relevanceTopK 256`, `relevanceUnits turn` |
| embedding | `openai-compatible/embedding-3`, 1024 |
| bill | prompt 9,810,118 (92.65% prefix-cached) · completion 970,343 · 3,219 calls with a `usage` block, 0 retries, 0 throttling |

This table used to state `44017278305` (`S16`) as the current position — **91.20% at four repetitions** —
and that number was the **control's**, not the shipped arm's. `S16` rendered every capped turn whole
(`resolution: raw`); the arm the product ships resolves `layered` (`assemble.ts` defaults it from
`REGISTERED_ARM`, adopted on `45543010618`). Two dispatches of the shipped rendering now exist and they
agree: `45543010618` read **93.50%** at two repetitions and **7,224** prompt tokens per question,
`45760081761` reads **93.40%** at two repetitions and **7,346**. Four passes over the two therefore span
**93.00–93.80 with mean 93.45**, and they are reported as a distribution rather than merged, because the
two dispatches differ by 1.7% in prompt tokens and byte-identity of their prompts was not compared
question by question.

The two are 0.10 points apart, which is the arm's own run-to-run spread at two passes, and that is worth
stating precisely: it is smaller than any mechanism this campaign has tried to certify (the smallest
certifiable effect at `c = 0` is six questions, 1.2 points), so a *level* stated to one decimal is a level
stated to inside its own noise. What is not inside the noise is the rendering: `raw` 91.20 against
`layered` 93.40 is 2.2 points on the same 500 questions and the same reader.

**The per-capability row was one repetition of two, and it was the low one.** It printed
`IE 95.33 · MR 86.78 · TR 94.49` — the artifact's own `feature.metrics.perCapability`, which is
**repetition 1** — beside a headline that was the mean of both repetitions. `tools/paired-flip.mjs` prints
that reconciliation as its first line, and reading the 62 MB artifact it had never been able to download
showed the other repetition: `MR` 109/121 = 90.08, `IE` 142/150, `TR` 121/127. The mean over the two is the
row this table now carries, and the difference is not cosmetic: `MR`'s gap to `Maximem` narrows from 8.8
points to 7.2, and `MR`'s **durable** misses — the only part of that gap a fix can reach — are **four
questions**. Twelve more are `contested`: the same code answers them differently on two byte-identical
prompts, so before anything can be fixed there they have to be made to decide.

This section used to state `90.15%` from run `41546569106` as the current position. It was the current
position when it was written and it has not been the current position since `S16`: the per-route budget
table, the `self-index` ranking signal and `ask: verbatim-acts` all landed after it, and the arm moved
**90.15 → 91.20** on the same 500 questions. The `90.15` row is kept in `docs/COMMITTED-READINGS.md`
because a superseded reading is still a reading; what is not kept is the word **current** in front of it.

**The headroom, which is the number that decides what to do next.** The same artifact, cut by how many
repetitions each question was right in (`docs/MEASURE-REACHABLE-HEADROOM.md`):

| | questions | |
| --- | ---: | --- |
| right in **every** repetition | **460** | banked: no mechanism can add to it |
| right in **some** | **14** | undecided; worth `7.0` of the mean, and `14` if every one were decided right |
| right in **none** | **26** | the whole of the headroom |
| … of those 26, the reference pipeline answers at least once | **6** | a fix is *demonstrated* able to reach them |
| … of those 26, the reference pipeline never answers either | **20** | a ceiling of the harness, not a gap between the arms |

The ceiling those numbers define is **`96.00`** — not `100`, and not the `93.40` above. It splits the gap
to `Maximem Synap` (`95.6`, i.e. `478` questions) into eighteen: **fourteen that have to be made to decide
and four that have to be made to answer**. Both blocks have already been measured — `selfConsistency`
against the first (`MR` 86.2 on a floor of 89, `§13.102`), the numeric institution against the second (ten
readings, all within a question of break-even) — so the eighteen are reachable only by a capability this
repository does not have. That is the reason this section now leads with the headroom rather than with the
gap: the gap says how far away the number is, and the headroom says what the number can be.

One measurement sits on top of this number and it is not in it:

| mechanism | reading | why it is not added here |
| --- | --- | --- |
| `single-session preference` route | **+7 of 10** treated questions converted, twice, the same seven both draws (§`PREREGISTRATION-PREFERENCE-ROUTE.md` §9) | measured on `IE`'s 150 questions only; the other 350 were not re-run, so the roster projection (+0.9 points) is not a measurement |

`resolution: layered` was the second row here, and two things had to move for it to leave: the product
stopped defaulting `raw` (`assemble.ts` resolves the registered arm, and `resolution-default.test.ts`
holds the two layers apart), and the **cost objection was withdrawn** — the 1.55x cache-adjusted price is
`docs/AUDIT-CACHE-CREDIT.md`'s subject, and it credits 96.4% of prompts whose bytes permit 1.4% of reuse,
so the credit tracks *when a call arrived* rather than what the prompt contains (`45574814660` measured a
byte-identical repeat at 82.7%). `tools/arm-adoptions.json` carries the adoption and states the
withdrawal.

**The measurement default is still `raw`, and deliberately so.** `bench-memory-arm.ts`'s
`DEFAULT_RESOLUTION` is the *renderer's* record: every archived prompt was rendered whole, and a default
that moved would make each of them unreproducible from the code. A dispatch that names no rendering is
therefore a dispatch of the control, which is why `tools/dispatch-cortex-memory-ab.py` prints
`CORTEX_MEMORY_RESOLUTION = raw` on every run it does not override, and why
`tools/paired-delta-census.mjs` refuses to compare two artifacts whose renderings differ. The gap that
remains is that the *default* is the control while the *shipped* arm is the treatment — a dispatch that
forgets the variable measures an arm the product does not ship. `45636994046` is that mistake, and it
charged an ask with a rendering worth +7 `MR` questions.

The third replication is also the round that made that cost objection precise. Its eight shards
answered the whole population and were refused by `tools/merge-ablation.mjs`, because `selfIndex` — the
product's own embedding bill, counted after the questions — was being compared across shards as if it
were configuration. The reading was recovered from the archived artifacts rather than re-bought, the
artifact now declares which of its fields are readings (`memoryArmConfig.censusKeys`), and the bill's
two readings printed together: **+0.07% in tokens and 1.55x in price**. Both are true and the second one
is not about the mechanism: `AUDIT-CACHE-CREDIT.md` shows the credit tracks arrival time, not prompt
content, and the probe that repeated one call byte for byte read 82.7% — so a price ratio assembled from
`usageBySide` sums is a measurement of the scheduler, not of the arm.

### 0.1 Where that sits, corrected against the published field

| system | score | what decides whether it compares |
| --- | ---: | --- |
| **cortex** (this run) | **91.20** | public prompt, official judge, 500 questions, 4 repetitions, reproducible |
| Recallium | 98.4 | Claude Opus 5.5 reader, self-reported; the same harness reads 90.2 with the official GPT-4o reader |
| agentmemory V4 | 96.2 | single deterministic run, Claude Opus 4.6 reader |
| Maximem Synap | 95.6 | self-reported, 2026-10-28 |
| Agent Zero Memory | 95.6 | arXiv 2026-08, setting and judge not named |
| Mastra OM | 94.87 | GPT-5-mini reader; the same memory reads **84.23** with GPT-4o |
| Hindsight | 94.6 | self-reported |
| Mem0 managed | 94.4 | GPT-5 as answer model **and** as judge |
| Honcho / Zep | 90.4 / 90.2 | self-reported; Zep with gpt-5.4 reading and judging |
| Supermemory | **85.2 accuracy** | its advertised 97% is **Recall@20**, a retrieval metric — `docs/SOTA-LANDSCAPE.md` §1 |
| RAW-RAG (naive) | 87.5 | arXiv:2610.30755, no extraction, no rewriting |

The cortex row read `90.15` until this round, and the correction is the paragraph three lines above applied
to the table it was written for. `§0` states `91.20` from `S16`; `§0.1` kept quoting the superseded
`41546569106` reading under the words "this run", so one file carried two current positions and the older
one was in the table a reader compares against competitors. Both numbers are real — `90.15` is the arm
before the per-route budget table, the `self-index` ranking signal and `ask: verbatim-acts` landed — and
`docs/COMMITTED-READINGS.md` is where the superseded one stays, because a superseded reading is still a
reading and the word that had to go was **current**, not the number.

**A second row of this table is worth stating explicitly, because it decides what "SOTA" means here.**
`Maximem Synap` at `95.6` is self-reported and closed; `Recallium` at `98.4` runs Claude Opus 5.5 and reads
`90.2` with the official GPT-4o reader — the same harness, eight points apart, on the reader alone. The
cortex column is reproducible end to end (public prompt, official judge, 4 repetitions, archived artifact),
which is a property none of the rows above it carry. That is not a claim to the top of the table; it is the
reason a two-point gap against a self-reported number is not a two-point gap against a measurement.

### 0.2 Three rows added on 2026-11-20, and the one that changes an argument

| system | score | cost | why it is here |
| --- | ---: | ---: | --- |
| Perpetuity | 94.0 (470/500) | **3,600** tokens, median frame in the reader's tokenizer | a vendor self-measurement with the official GPT-4o judge. It is the cheapest published path to 94 and therefore the row that decides what the remaining gap is made of |
| Graphon Labs | 92.8 at 15.1K (96.2 best case, no cost) | 15,100 | vendor page, November 2026; two figures for one system, and only the one that names a cost is entered |
| Honcho | 90.4 | 11,600 | Claude Haiku 4.5 reader, run data public |

**Perpetuity is the row this iteration is worth remembering**, because it prices an argument this repository
has been making from its own room curve for three rounds. `S15` shows 24,000 characters costs accuracy;
`C1` shows the registered arm delivering 48,460 characters for 7,448 tokens. Perpetuity reaches 94.0 with a
median 3,600-token frame — half this arm's bill and 2.9 points above it — which says the lever is **which**
text the frame holds rather than **how much**. That is the same conclusion the 36-fold completion gap led to
from the cost side (`ANALYSIS-COMPLETION-GAP.md`): nothing is saved by generating less, and everything is
decided by what is selected.

Two caveats travel with it and are stated rather than resolved: the figure is the vendor's own run with the
vendor's own prompt, and 46x leaner than the full history is a comparison against 165K in the same tokenizer
rather than against this arm's 115K-character corpus.

### 0.3 The benchmarks this project does not run, named

`LongMemEval-V2` (May 2026, 451 questions over environments up to 500 trajectories and 115M tokens) reports
72.5% for its best method against 48.5% for the strongest RAG baseline. `BEAM` (ten-million-token histories,
contradictions and event order), `DolphinBench` (task success with cost and latency beside it), `LoCoMo` and
`MemoryAgentBench-FactConsolidation` are the other axes a memory system is now measured on in public.

None of them is in this repository's acceptance matrix, and that is a gap rather than a claim: every number
above is on LongMemEval-S, and a system tuned on one benchmark with one judge has not been shown to hold
anywhere else. `MemoryAgentBench-FactConsolidation` is the first one scheduled, because it is the second
instrument for knowledge-update — the capability where the supersession ledger is the failure mode rather
than the remedy.

**cortex is above the reproducible frontier this repository tracks (85.8–86.5%) and is not SOTA overall.**
The 94.4–96.2 band is vendor-reported, and every row in it runs a stronger reader than `deepseek-chat`
except Mem0's judge choice. The reader axis is measured four times and its sign is not given by size:
Mastra +10.64, Recallium +8.2, this repository's own `deepseek-v4-pro` swap **−7.20**, and this run's
thinking-on-two-routes **+6.25**. What the axis buys is contract compliance, not parameters.

---

## 1. Position at the frozen anchor (`a52628f`, 2026-10)

Every number in §1–§5 was measured at that commit. §0 above is the current one.

| System | Overall | Reader |
| --- | --- | --- |
| Claude Opus 4.6 | 95.6% | Claude Opus |
| GPT-4o (raw reader) | 92.6% | GPT-4o |
| Hindsight | 91.4% | Gemini 3 Pro |
| HydraDB | 90.79% | Gemini 3.0 Pro |
| Emergence | 86.0% | GPT-4o |
| AgentOS | 85.6% | GPT-4o |
| Supermemory | 85.2% | Gemini 3 Pro |
| Mastra OM | 84.23% | GPT-4o |
| **cortex** | **83.55%** | **DeepSeek** |
| Original paper GPT-4o Oracle | 82.4% | GPT-4o (gold sessions only) |
| Original paper full-context | 63.8% | GPT-4o |

Cortex sits **above the original paper's Oracle baseline** (82.4%, which is handed the
gold answer sessions) and within ~0.7–1.7pp of the Mastra/Supermemory commercial tier —
**while using a strictly weaker reader (DeepSeek) than every system above it.**

## 2. Per-capability decomposition at the frozen anchor (4 runs pooled)

| Capability | Correct | Accuracy | Abstention | Wrong |
| --- | --- | --- | --- | --- |
| IE (single-session) | 567/600 | **94.50%** | 2.3% | 3.2% |
| MR (multi-session) | 373/484 | **77.07%** | 8.1% | 14.9% |
| KU (knowledge update) | 226/288 | **78.47%** | 3.8% | 17.7% |
| TR (temporal) | 385/508 | **75.79%** | 7.3% | 16.9% |
| ABS (abstention) | 120/120 | **100.00%** | 100% | — |
| **Overall** | **1671/2000** | **83.55%** | — | — |

The dominant error mode has shifted from **abstention** (largely fixed) to **wrong
answers**, which now outnumber abstentions 2–7× on MR/KU/TR.

## 3. Validated fixes (all ACCEPTED, in `master`)

Each fix was gated by a same-instant 4-vs-4 A/B with an exact permutation test on a
mechanism endpoint; overall accuracy was treated as a noise-floored descriptive estimate
only (per-run within-arm spread is 6–7 questions, exceeding small effects).

| Commit | Fix | Mechanism endpoint result |
| --- | --- | --- |
| `eb1bc3c` | KU questions with no time qualifier get a selection rule instead of abstaining | KU `other` abstention 14.36% → 4.26% (−10.11pp, p = 0.0143); KU accuracy 75.35% → 79.51% (+4.17pp, p = 0.0143) |
| `4640c86` | Bound every fetch attempt with its own abort deadline | Inert guard (no LLM-pattern change); shipped alongside `eb1bc3c` |
| `a104ea0` | Route duration/age-difference questions to the derivation prompt | "current role" (3y9m − 2y4m = 1y5m) and "grandma older" (75 − 32 = 43) both 4/4 abstain → 4/4 correct |
| `a45b32a` | Expand derivation questions into operands, not activities | "Alex born" operand "32" recall 0/2 → 2/2 (p = 0.0143); 4/4 abstain → 4/4 correct |
| `bc687b9` | Annotate per-question diagnostics with the scored verdict | Observability fix (no model behavior); unlocks wrong-answer root-cause analysis |

## 4. Negative results (scientifically valuable, reverted)

| Commit | Experiment | Result |
| --- | --- | --- |
| `51b573f` → `a52628f` | DCG session scoring (rank-discounted turn gain, mirroring EmergenceMem/AgentOS) | **REJECT**: MR 77.07% → 73.14% (−3.9pp, p ≈ 0.029). LongMemEval-S MR questions are mostly single-fact; `max` turn reduction is locally optimal and DCG lets noisy mid-relevance turns outrank the single strong evidence turn. |

The DCG result is recorded as evidence that frontier heuristics do **not** transfer
blindly: each change must pass the benchmark, which is exactly why the A/B gate exists.

## 5. Why the remaining gap is a reader ceiling

The wrong-answer pool was root-caused exhaustively:

- **TR duration errors** reproduce identically across runs (deterministic), but the
  arithmetic (`daysBetween`) is correct — the error is *event-date extraction* (e.g.
  "yesterday" inside a turn) and entity disambiguation, not math.
- **MR counting errors** enumerate the items correctly but misjudge *which items count*
  (e.g. "dry cleaning ≠ store pickup"), an LLM semantic judgment, not arithmetic or
  enumeration completeness. Deterministic summation was already implemented and
  reverted (`900dcf6`/`377c34d`) because the bottleneck is extraction/judgment, not
  summing.
- **The LLM judge is sound**: semantically-equivalent surface differences
  (`"The Nightingale"` vs `"'The Nightingale' by Kristin Hannah"`) are correctly scored
  as correct — there is no evaluation bug to reclaim.

The remaining errors are heterogeneous semantic-judgment failures of the DeepSeek
reader. **83.55% is a strong result at the DeepSeek ceiling**; the residual gap to
85–95% is gated by the reader model, which is a fixed constraint in this configuration.
A stronger reader (GPT-4o/Claude/Gemini) would be the single largest lever, at the cost
of leaving the DeepSeek-only constraint.

> **Correction (2026-09-20).** The two sentences above do not survive contact with the
> published evidence and are retained only so the error is on the record.
>
> 1. **DeepSeek is not the weaker reader here.** On LongBench v2 — raw long-context
>    reading with no memory layer — DeepSeek-R1 scores **58.3** against GPT-4o's
>    **51.4**. Systems running the *same or a smaller* reader tier already reach
>    **94.87%** (GPT-5-mini) and **96.4%** (Gemini 3 Flash).
> 2. **Architecture explains far more than the reader.** Holding the reader fixed at
>    GPT-4o, the spread across systems is **37.0pp** (EmergenceMem 86.00 vs Mem0 49.00).
>    Holding the architecture fixed, swapping 20B → Gemini 3 Pro is worth **7.8pp**
>    (Hindsight). Architecture variance is **4.7x** reader variance.
> 3. Therefore 82–86% is a **pipeline** ceiling, not a reader ceiling. The binding
>    constraint is the structure of the context we hand the reader — we run no
>    reranker, our query expansion takes only top-3 per query, and we have no
>    specialised extraction channels.
>
> See `cortex-docs/docs/08-reader-parity-analysis.md` for the full attribution and the
> reproduction script. "The reader is the remaining lever" is **withdrawn**.

> **Correction (2026-09-20, second pass).** §5's second bullet — "MR counting errors
> enumerate the items correctly but misjudge *which items count*, an LLM semantic
> judgment, not arithmetic or enumeration completeness" — is **confirmed** by a
> per-question read of `benchmark-mr-diagnostics.json`, and the reason it was right
> is worth recording because the first pass got the *mechanism* wrong. For
> `0a995998` ("How many items … to pick up or return"), the model's own trace
> enumerates all three items correctly, then reasons itself down to 2 by ruling out
> dry cleaning and collapsing an exchange into one item. The failure is semantic
> attribution, not counting. A deterministic numeric gate is therefore not the fix,
> and a re-score of all 29 MR questions under `numericAnswerVerdict`'s rules
> reproduces the stored verdict exactly (22/29 = 75.9%) — it moves nothing.
>
> **Retrieval is not MR's constraint either.** In `6a1eabeb` ("personal best in the
> charity 5K run") the gold string `25:50` is present in the retrieved context at
> offset 7839, alongside the superseded `27:12`. The reader had both and chose the
> older one. This is a *knowledge-update* failure surfaced through a KU question,
> not a recall failure.
>
> **And the breadth question is now closed by measurement.** The recall curve
> (run `35498421148`, `docs/MEASURE-B2-RECALL-CURVE.md`) reports a pool `ceiling` of
> **93.02%** for answerable questions with `gain` decaying 65.12% → 2.33% from
> `k=1` to `k=20`. Only 6.98% of answerable questions are unreachable by any
> reordering, so "add recall channels" is a proposal for a ≥6.98% prize, not for
> the third that `recall@5` alone appeared to imply.

## 6. Methodology (standing)

- Same-instant 4-vs-4 A/B only; never staggered (time-of-day drift is ~1.7–2.1pp).
- Mechanism endpoints (abstention rate, operand recall, per-question correct) are
  decisive; overall accuracy is descriptive.
- Exact permutation tests, not pooled z-tests (pooling the same questions across runs
  is pseudoreplication).
- `pnpm check` green, ≥95% coverage on all four dimensions, no skipped tests.

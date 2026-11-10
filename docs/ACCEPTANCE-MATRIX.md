# The acceptance matrix

Every criterion this project claims, what it is measured on, what a competitor reports on the same axis, and
what happens when it is missed. The table below is **generated from `packages/cortex-eval/src/acceptance.ts`**
by `node tools/acceptance-check.mjs`; the numbers in this file are recomputed by
`node tools/docs-crosscheck.mjs` on every check, so a document cannot quote a value the code does not produce.

## 1. Why this file exists

Before it, acceptance criteria lived in eight `PREREG-*.md` files and four measurement reports, written as
prose. That arrangement fails twice, and both failures are silent:

- **A number drifts from the code that produced it.** Nothing reads the document, so nothing notices.
- **A criterion with no current value cannot fail.** "Multi-session should reach 85%" is a wish until
  something compares 69.6% against 85% and decides.

So a criterion is a record with six fields that each do work:

| Field                               | What it prevents                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `metric` + `dataset`                | a number whose measurement is not stated, which is a number nobody can reproduce        |
| `comparator` + `threshold` + `unit` | a gap written as a ratio, so 28 points reads as 0.28                                    |
| `source`                            | a value typed into the table, which would be a second copy of a measurement             |
| `kind` (`gate` / `aim`)             | a build that can never be green, or a project that cannot block a regression            |
| `onMiss`                            | a threshold that is decoration, because nothing was decided in advance about missing it |
| `competitors` + `grade`             | a comparison with a number that was measured differently                                |

## 2. Three statuses, and the two axes that decide whether a miss blocks

```
pass     the value was computed and met the threshold
fail     the value was computed and missed it
unrun    no value could be computed — reported, never counted as a pass
```

`fail` is split by `kind`:

- **`gate`** — a number already reached. Falling below it is a regression and **exits 1**.
- **`aim`** — a number not yet reached. Missing it is the work; it is printed and does not block, because a
  build that cannot be green while the project is honest teaches people to delete rows.
- **`accepted`** — a known miss the project decided not to fix, with the reason in `onMiss`. Printed as
  `accept`, never blocking, never deleted. There is currently one: `R1`, the abstention-recovery pass that
  measured net **−1**.

## 3. The matrix

| id  | current                   | threshold | status | capability                             | measured on                                                 |
| --- | ------------------------- | --------- | ------ | -------------------------------------- | ----------------------------------------------------------- |
| G1  | <!-- reading:G1 -->75.0%  | ≥ 70.0%   | pass   | relation-preserving split              | the 20 pairs the reviewer judged                            |
| G2  | <!-- reading:G2 -->5      | = 5       | pass   | relation-preserving split              | the same 20 pairs                                           |
| G3  | <!-- reading:G3 -->40.6%  | ≥ 30.0%   | pass   | relation-preserving split              | `g00`, grouped against self-contained                       |
| K1  | <!-- reading:K1 -->64.7pp | ≥ 40.0pp  | pass   | assumption ledger                      | controlled set, `gated − flat`                              |
| K2  | <!-- reading:K2 -->58.8%  | ≤ 65.0%   | pass   | assumption ledger                      | controlled set, `−persistence`                              |
| K3  | <!-- reading:K3 -->0      | = 0       | pass   | assumption ledger                      | controlled set, `gated`                                     |
| V1  | <!-- reading:V1 -->0.0pp  | ≥ 0.0pp   | pass   | memory pollution                       | controlled set, `flat` minus `no-memory`                    |
| T1  | <!-- reading:T1 -->88.2%  | ≤ 90.0%   | pass   | settled fact versus plan               | controlled set, `−temporality`                              |
| T2  | <!-- reading:T2 -->94.1%  | ≤ 95.0%   | pass   | settled fact versus plan               | controlled set, `−immutability`                             |
| T3  | <!-- reading:T3 -->94.1%  | ≤ 95.0%   | pass   | settled fact versus plan               | controlled set, `−fulfil`                                   |
| T4  | <!-- reading:T4 -->100.0% | = 100.0%  | pass   | settled fact versus plan               | controlled set, `−lapse`                                    |
| D1  | —                         | ≤ 45.0%   | unrun  | extraction fidelity                    | A3 round 2, verbatim share                                  |
| R1  | <!-- reading:R1 -->-1     | ≥ 1       | accept | abstention recovery                    | LongMemEval-S, 500 questions                                |
| S1  | <!-- reading:S1 -->92.0%  | ≥ 85.0%   | aim    | end-to-end memory, `cortex-memory` arm | LongMemEval-S, 500 questions, `benchmark-cortex-memory.yml` |
| S2  | <!-- reading:S2 -->88.5%  | ≥ 85.0%   | pass   | knowledge update                       | LongMemEval-S, 72 of the 78 published                     |
| S3  | <!-- reading:S3 -->83.9%  | ≥ 85.0%   | aim    | multi-session reasoning                | LongMemEval-S, 121 of the 133 published                   |
| S4  | <!-- reading:S4 -->96.1%  | ≥ 94.0%   | pass   | temporal reasoning                     | LongMemEval-S, 127 of the 133 published                   |
| S5  | <!-- reading:S5 -->100.0% | ≥ 80.0%   | pass   | abstention                             | LongMemEval-S, 30 questions                               |
| S6  | <!-- reading:S6 -->—      | ≤ 0       | unrun  | reranking                              | LongMemEval-S, 500 questions, one rerank call each          |
| S7  | <!-- reading:S7 -->—      | ≥ 3       | unrun  | reranking                              | LongMemEval-S, 121 multi-session questions, paired          |
| S8  | <!-- reading:S8 -->—      | ≥ 9       | unrun  | multi-session reasoning                | LongMemEval-S, 121 multi-session questions, paired          |
| C1  | <!-- reading:C1 -->12137  | ≤ 6,000   | aim    | cost                                   | LongMemEval-S, 500 questions, prompt tokens per question    |
| B1  | <!-- reading:B1 -->0      | = 0       | pass   | browser persistence                    | committed Chromium reading, 24 checks over 2,000 rows        |
| B2  | <!-- reading:B2 -->0      | = 0       | pass   | browser persistence                    | committed Firefox reading, the same suite                    |
| C2  | <!-- reading:C2 -->48.7%  | ≤ 70.0%   | pass   | cost                                   | LongMemEval-S, paired, median evidence tokens per question   |
| C3  | <!-- reading:C3 -->—      | ≤ 100.0%   | unrun  | cost                                   | LongMemEval-S, billed prompt tokens per question at the reduced budget, as a fraction of the registered configuration |
| C4  | <!-- reading:C4 -->0      | = 0       | pass   | cost                                   | every full-500 arm read, against the newest four-repetition artifact |
| M1  | <!-- reading:M1 -->—      | ≥ 3.0pp   | unrun  | reader strength                        | LongMemEval-S, one dispatch, two readers, prompt bytes held  |
| P1  | <!-- reading:P1 -->—      | ≤ 2.0pp   | unrun  | provider portability                   | LongMemEval-S, one dispatch, two providers, prompt bytes held |

Every `S*` row and `R1` are the **`cortex-memory`** arm, measured by `benchmark-cortex-memory.yml`. The
`benchmark.yml` workflow measures a different system (the reference pipeline) and reads 43.40% end to end;
its numbers are not on this page and must not be substituted for these. `MEASURE-BASELINE-DRIFT.md` §8 is
the record of what happens when they are.

`D1` is `unrun` and that is stated rather than hidden: the distillation reading needs an A3 run with a fresh
prompt, and no such run exists. A row with no value is the honest form of "we have not measured this".

`C1` was added on 2026-11-07, when the October board became the first that prints context length beside
accuracy. It was `unrun` for an arithmetic reason rather than a scheduling one: `llmUsage.promptTokens` is a
four-repetition total over 500 questions **and** over the bare-decline retries, and its three defensible
divisions give 11,690 (per call), 12,105 (per question per repetition) and 48,420 (per question across all
four) — a 4.14x spread from one number. The row now reads a generated evidence file instead of carrying a
hand-typed figure: `tools/cost-ledger.py` names the division (per question, retries included, §13.293.1) and
writes `cortex-docs/evidence/longmemeval/cost.json` with the run id it came from. The reading is **12,105**,
2.02x the threshold, so the row is an `aim` and not a `gate` — 6,000 is the cheapest published competitor
point rounded up (Zep 4.4K, Mem0 6.8K) and nothing there has been reached.

Two things the reading itself settles. It is **not** a selection from the window: the arm ran under
`maxPromptChars: 48000` and 48,000 / 11,690 = 4.11 characters per token, i.e. the delivery fills its cap, so
the row currently measures a configuration constant and retrieval improving will not move it (§13.293.2).
And the cap is not a free win: §13.291 measured that adding every gold turn moved accuracy by exactly +0.00,
which is evidence that more room does not help, not evidence that less room is free. Cache hits are also not
a discount here — 18,933,570 of the 24,209,976 prompt tokens were cache hits, which changes the bill and not
the context the reader had to read.

Five rows were added on 2026-11-07, and they are of three different kinds because the page had three different
holes. `LANDSCAPE-CONTROLLED-BOARD.md` §7 is the argument; this is the record of what changed.

- **`B1` and `B2` are the first rows with a value on the browser axis**, and they cost nothing: the readings
  (`packages/cortex-storage/test/browser/last-run.json` and its Firefox twin) were already committed and are
  already regenerated in CI. They read `summary.failed` rather than `summary.passed` because a `passed: 24`
  threshold hard-codes the suite's size, so the next person to add a check would either break a gate or edit a
  threshold — and both are indistinguishable from lowering the bar. Requirement 9 puts product maturity ahead
  of the SOTA chase, and until these rows "maturity" was the number 24/24 typed into three documents.
- **`C2` exists because a document said it did.** `PREREGISTRATION` §13.297.7 states that "the adaptive-budget
  criterion is `C2` … registered as an aim". It was not registered; `acceptance.ts` had no such row. That is
  the matrix's own failure mode one level up — not a number drifting from its code, but a *criterion* living
  only in prose, where nothing can read it. Its unit is a **fraction of our own window**, which is why it
  carries no competitor figure: 4,400 tokens is 36% of 12,105 and 0% of whatever a reader assumed, so an
  absolute external number cannot be placed in that column. The absolute figures stay on `C1`.
- **`M1` and `P1` price requirements 11 and 12**, which until now were properties the architecture was said to
  have. `M1` is the paired reader-strength gain (≥ 3.0 points, against a measured noise floor of 1.6–2.2 and an
  external +10.64); `P1` is the cross-provider loss (≤ 2.0 points). Both are `unrun` and the reason is written
  into the row: a pair exists for `M1` on an **older** configuration (`41222844945` 85.75% against
  `41254359622` 90.45%, +4.70, every prompt byte-identical), and using it would be quoting a reading of a
  system this row does not gate. For `P1`, `AUDIT-MODEL-PORTABILITY.md` §7 names the ratio the criterion needs
  and states it has never been measured — so the row makes the omission a list item instead of a footnote.

### 2.1 `S1` read a stale artifact for three rounds, and the repair is an attestation

`S1` used to read **83.45%** from `cortex-docs/evidence/longmemeval/summary.json` while the arm it names
measured **90.85%** on the same 500 questions. The file was not wrong: it is four *independent dispatches* of a
**thinking-disabled** configuration that no longer ships. The row was therefore correctly labelled, in a
footnote, as stale — and a footnote is not a status. Three rounds of documents quoted 83.45% and the matrix
printed it in the `current` column with nothing beside it.

The repair is not an edit to the figure. `S1` now reads `frontier.json#shipping.accuracy`, a file that
`tools/efficiency-frontier.mjs --ship route-room` writes from the artifacts, and it carries three
**attestations** that the reading describes the system this build ships:

| clause | why it is needed |
| --- | --- |
| `shipping.accuracySource == repetition-mean` | `feature.metrics` is one repetition and read 90.20% where the four-repetition mean read 90.85% |
| `shipping.runs == 4` | a two-repetition mean carries twice the standard error of the mean, so it is not the same reading |
| `shipping.arm == route-room` | the shipping arm is a **label** the tool resolves to an artifact on every run, so a label that stops existing cannot silently resolve to an older file |

A clause that fails produces a fourth status, **`stale`**, which is neither `pass` nor `fail`: nothing was
compared, because the number describes something else. It is listed with the missing rows, it counts toward
`--strict-unrun`, and it is never counted as a pass. `eval` on a clean checkout with no `frontier.json` gives
`S1 = unrun`; a `frontier.json` from a different configuration gives `S1 = stale`; only the current
configuration gives a number.

The old reading stays in `summary.json` with its configuration named, because deleting a real measurement to
avoid a stale warning is the opposite of the fix.

### 2.1.1 Two rows already are generated, and that is the difference

`C1` and `C2` no longer have this problem, and the way they stopped having it is the shape the repair should
take for `S1`. Both are written by a tool from a report artifact, with the run id in the file:

```
python3 tools/cost-ledger.py       <artifact> --json --write evidence/longmemeval/cost.json --run 42355323615
python3 tools/evidence-budget.py   <artifact> --json --write evidence/longmemeval/evidence-budget.json --run 42355323615
```

`--write` refuses without `--run`, so a file that cannot name its provenance cannot exist. Regenerating both this
round moved `C1` from 12,105 to **12,137** and produced `C2`'s denominator for the first time; neither number was
touched by hand.

`S1` moved to that shape this round: `tools/efficiency-frontier.mjs --ship route-room` writes
`evidence/longmemeval/frontier.json`, and the row reads `shipping.accuracy` out of it with the three
attestations above. `S2`/`S4`/`S5` still come from `evidence/longmemeval/summary.json`, which is written by a
different path with no `--run` discipline and no attestation — the distance between the two is one script, and
it is the script `13.298.4` specified.

`P1` also carries an empty competitor field on purpose. Every published portability claim in this field is a
sentence ("works with any model"), a sentence is not a value, and a fabricated row would be worse than the gap.

`S6` and `S7` are `unrun` for the same reason and became rows before the run that fills them, which is the point
of writing a criterion early: `S6` is a **gate on the instrument** rather than on accuracy — the number of
questions whose rerank reply had to be discarded — and `S7` is the paired gain in the multi-session category.
Neither can be evaluated from an artifact that does not exist, so both print as `unrun` and neither can pass by
default. `S6`'s threshold is an invariant and not a measurement: `rerankHits` degrades to the retrieved order on
a thrown request, a short reply or a non-finite score, so an endpoint answering `401` five hundred times and a
cross-encoder that agreed every time produce the **same accuracy**. One fallback makes the pair unreadable, and
the census carries `calls` beside `fallbacks` so that a stage which never ran cannot be mistaken for a clean one.

`S8` is the third row written before its run, and the one with the widest gap between its threshold and what the
field has published. It prices the **instruction** rather than the retrieval: §13.123.1 measured that every wrong
answer already carries its gold in the prompt, with a median best rank of **0**, so the eighteen multi-session
questions this arm trails the `reference-pipeline` by cannot be recovered by any change to the pool, the width or
the budget. What remains is what the reader is told to do, and the two arms are told opposite things — this one
asks for the list to be written out, the reference asks for it to be kept private. `S8` is measured against an
`enumerated` control whose flat and temporal blocks are byte-identical, so it is the rare row where an assembly
failure is detectable from the control side: a movement in TR or IE means the dispatch administered more than one
route and no number in the row is readable.

### 2.2 Four rows still read a dead configuration, and fixing it moved them 12 to 18 points

The §2.1 repair turned `S1` into an attested row and left `S2`, `S3`, `S4` and `S5` reading
`summary.json` — the same file, the same defect, four rows over. It was written down at the time as "the
distance between the two is one script, and it is the script `13.298.4` specified", and it stayed that way
because a stale reading does not fail anything: it prints a plausible percentage in the `current` column and
looks like a measurement.

`tools/capability-ledger.py` is that script. It reads one artifact, takes the repetition mean off
`ablation.featureCorrectByRun` rather than off `featureByCapability`'s `min / avg / max`, and writes
`evidence/longmemeval/categories.json` with the run id in it. Both files describe the same 500 questions; they
describe **different systems**:

| row | stale reading | corrected | delta |  | consequence |
| --- | ---: | ---: | ---: | --- | --- |
| `S2` knowledge update | 87.2% | **88.5%** | +1.4 | | stays `pass` |
| `S3` multi-session | 71.7% | **83.9%** | +12.2 | | stays `aim`, but the deficit shrinks from 13.3 points to 1.1 |
| `S4` temporal | 78.3% | **96.1%** | +17.8 | | **promoted `aim` → `gate`**, threshold 85% → 94% |
| `S5` abstention | 96.7% | **100.0%** | +3.3 | | stays `pass`; the row has zero wrong answers and no room |

`S4`'s promotion is not decoration in the other direction. An aim that is met and left as an aim prints `pass`
and blocks nothing — the failure `S1`'s own comment names — so the row changes class in the edit that re-hangs
it, and the new threshold is **derived**: the arm reads 96.06%, its four repetitions are 120/122/125/121 of
127, the standard deviation is 2.08 points, the standard error of the mean is 1.04, and 94.0 is 1.98 standard
errors below the measured value.

### 2.2.1 The interval and the resolution floor, which the page did not have

Every row on this page prints a point estimate. Two rows cannot be read without a second number, and the
ledger now writes both:

| capability | n | mean | exact 95% (Clopper-Pearson) | half-width | resolution floor |
| --- | ---: | ---: | --- | ---: | ---: |
| `IE` | 150 | 95.00% | [89.76, 97.67] | 3.95 | **4.99** |
| `MR` | 121 | 83.88% | [75.63, 89.60] | 6.98 | **9.36** |
| `KU` | 72 | 88.54% | [77.59, 94.12] | 8.26 | **10.52** |
| `TR` | 127 | 96.06% | [91.05, 98.71] | 3.83 | **4.83** |
| `ABS` | 30 | 100.00% | [88.43, 100.00] | 5.79 | — |
| overall | 500 | 91.95% | [89.04, 94.05] | 2.51 | **3.41** |

The interval is **exact** rather than Wilson because the denominators are 30 to 127, which is where
Bowyer, Aitchison and Ivanova (`arXiv:2402.04702`) measured CLT-based intervals to under-cover badly. The cost
of exactness is conservatism, and that is the direction a gate may err in. `ABS`'s floor is `—` rather than
`0.00` on purpose: `p(1-p)` is zero at 30 of 30, so the formula returns zero, and a zero floor reads as "this
population resolves any difference" when the exact interval is 11.6 points wide.

The floor is `2.8016 * sqrt(p(1-p)/n)` — Miller's smallest detectable effect at 5% significance and 80% power
(`Adding Error Bars to Evals`, `arXiv:2411.00640`), with Wang's `p(1-p)` rule of thumb in place of the true
paired variance. It is a **design** quantity and it is not the same number as the 2 sd of observed repetition
spread this project uses to judge mechanism bars; the two answer different questions ("what would this
population see?" versus "what did this configuration do?"), and this page now carries both.

Two consequences, and the second one is why the table is here:

- **`S3`'s remaining 1.1 points are not measurable.** The floor at 121 questions is 9.36 points. A threshold
  1.1 points above a reading whose own interval is 14 points wide is a number that cannot go red for the reason
  it names. The row stays — the measurement is real and a *large* regression must be caught — and the
  measurable form of the same target is `S8`, which counts paired conversions instead of differencing two
  ratios.
- **The repetition count does not buy resolution.** Four repetitions per question costs 2.8x the sampling of
  one and divides the reader's own noise; it does not touch `p(1-p)/n`, which is the question sample. Every
  "run it again to be sure" instinct in this campaign's history is priced by that sentence, and
  `docs/MEASURE-RESOLUTION-WALL.md` works through what it means for the mechanism queue.

### 2.2.2 What the four attestations are for

Each of the four rows now carries four clauses, and each closes a way the number could be about something
else:

| clause | what it prevents |
| --- | --- |
| `accuracySource == repetition-mean` | `feature.metrics` is one repetition; on `MR` the four repetitions span 99 to 104 of 121, so a one-repetition row and a mean row are four points apart |
| `runs == 4` | a two-repetition mean carries twice the standard error of the mean |
| `arm == route-room` | the capability file is only about the shipping system if it was generated from it; a file regenerated from `registered` would read 3.4 points lower on `TR` and be perfectly well-formed |
| `pooled.denominator == 500` | the per-category counts are taken out of the full suite; a file generated from a 72-question scoped arm has categories too, and they are not these |

A failing clause produces `stale`, not `fail`: nothing was compared, and the row says so instead of quoting a
number about a different system.

### 3.1 One row prices memory itself, and it can come out negative

Every arm on the controlled set was compared to another arm, so the set could price a *mechanism* and could never
price *memory*. TEPA (`arXiv:2608.07429`) is what makes that a defect: during full reversal, append-only and
last-write-wins both score **0.210** while **no memory at all** scores **0.309** — a persistent store that keeps
superseded evidence is worth less than not remembering, because a reader with nothing declines and a reader
handed the stale value answers.

`V1` is `flat` minus `no-memory`, and it reads **0.0pp**: six cases gained against six lost, so an append-only
store is worth exactly nothing on a set built to contain contradictions, while the ledger (`K1`) is worth
**64.7pp** over the same baseline. The `no-memory` arm is not a special case in the code — `resolve` passes
`ranked: []` down the same `assemble` call every other arm uses, so a difference between the floor and an arm is a
difference the product would also show.

### 3.2 The budget was met by halving the room, and the halving is not free

`42373407439` is `42355323615` with `max_prompt_chars` moved from 48,000 to 24,000 and nothing else.
`C1` reads **5,623** tokens per question on it and `C2` reads **0.487**, so both cost rows clear their
bars for the first time — and `A`, the accuracy registration written beside them, refuses the result.

| capability | n | 48,000 | 24,000 | delta | `gold-room.py` predicted |
| --- | ---: | ---: | ---: | ---: | --- |
| ABS | 30 | 100.00% | 100.00% | 0.00 | 9 exposed |
| IE | 150 | 93.33% | 92.67% | -0.67 | 2 exposed |
| KU | 72 | 88.89% | 87.50% | -1.39 | 38 exposed |
| MR | 121 | 83.47% | 76.86% | **-6.61** | 0 exposed |
| TR | 127 | 96.06% | 91.34% | **-4.72** | 0 exposed |

The instrument named three capabilities and the loss was in the other two. Every capability lost about
half its delivered turns; only the two that **aggregate** lost accuracy. `IE`, `KU` and `ABS` ask for one
fact in one turn and half a packet still holds it; `MR` and `TR` ask for a count over turns and a count
over a sample is not the count. `tools/gold-room.py`'s `room` column is therefore a **lower bound on
exposure**: a gold-coverage model is sufficient for a single-turn question and irrelevant for an
aggregation. `docs/PROMPT-ROOM-IS-LOAD-BEARING.md` has the whole reading; §13.302 registers the arm the
asymmetry licenses — 24,000 on four routes and 48,000 on the two that aggregate, predicted at `-0.36`
points for `-26%` tokens, every cell of it a measured number rather than a model.

## 4. How each increment is tested, on four levels

The user-facing question is "how do you know it works". The answer has to be four answers, because each level
catches a different defect and none of them subsumes the others.

| Level          | What it catches                                         | Where it lives                                                                 | Threshold                                         |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| **unit**       | a rule that does not do what its comment says           | `packages/*/src/**/__tests__`                                                  | 100% statements per file; ≥95% branch per package |
| **controlled** | a mechanism that does not act where it claims           | `assumption-ablation.ts`, 17 cases; `answer-transition.ts` on every paired run | each ablation moves only its targeted families    |
| **artifact**   | a mechanism that works but is not wired                 | `tools/export-census.mjs`, `tools/acceptance-check.mjs`                        | every export has a caller or a recorded reason    |
| **end to end** | a mechanism that helps on a fixture and not on a corpus | LongMemEval-S, 500 questions                                                   | S1–S7                                             |

The **artifact** level is the one that is usually missing, and it is the one that caught the largest defect in
this line of work: `assumptionPenalty` and `planFactor` existed, were tested, and had **no caller outside
their tests** until `assemble` was written. The export census reported them as orphans, which is how the gap
became visible; it is now zero, because `assemble` calls them.

### 4.1 The increments, one row each

Six columns, because a mechanism can be correct, act where it claims, be wired, help on a corpus — and still be
aimed at an axis nobody else competes on. The last column names the axis and who else reports on it, so an
increment that cannot be compared says so before it is built rather than after it is measured.

| Increment                           | unit                                           | controlled                                                                                                                                                                | artifact                                                                                           | end to end                           | axis, and who else reports on it                                                                          |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| relation-preserving split (step 28) | `knowledge/*.test.ts`, 149 tests               | G1/G2/G3 on 20 reviewed pairs                                                                                                                                             | `knowledge-probe.mjs`                                                                              | not measured yet                     | internal only — no competitor publishes a relation-split corpus                                           |
| assumption ledger (step 29)         | `assumption`/`revision`, 39 tests              | K1/K2/K3                                                                                                                                                                  | census: `assumptionPenalty` gained a caller                                                        | not measured yet                     | internal only                                                                                             |
| temporality and plans (step 30)     | `temporality`, 34 tests                        | T1–T4                                                                                                                                                                     | census: `planFactor` gained a caller                                                               | not measured yet                     | temporal reasoning; every published system reports it, and all of them collapse on it                     |
| context assembler (step 33)         | `assemble`, 42 tests                           | all arms now call it                                                                                                                                                      | census: `Penalty`, `assumptionPenalty` left the orphan list                                        | not measured yet                     | context budget; agentmemory V4's per-capability token budgets are the public comparison                   |
| memory pollution floor              | `assumption-ablation.test.ts`, 9 tests          | V1: `flat` minus `no-memory` on the same 17 cases, plus a synthetic set that proves the number can go negative                                                            | `pollutionGap` is called by both the tool and the checker, so a floor nobody reads cannot pass       | not measured yet                     | memory pollution; TEPA (arXiv:2608.07429) reports append-only 0.210 against no memory 0.309, the same subtraction in the same unit |
| abstention recovery (step 26)       | `abstention-recovery`, 21 tests                | —                                                                                                                                                                         | `recovery` in the artifact                                                                         | R1, net −1                           | abstention; LongMemEval's 30 ABS questions are the only public axis                                       |
| date frame                          | pre-registered                                 | —                                                                                                                                                                         | —                                                                                                  | A7, unrun                            | temporal; the paper's own time-aware index ablation (+7–11pp)                                             |
| **`reviewPass: 'bare'`**            | `bare-decline-retry`, 12 tests                 | reach: `flat` + `temporal`, ABS excluded in code                                                                                                                          | `## Bare-decline retry` section, `bareRetry` in JSON                                               | run `40522788515`, 80.80% — see §4.2 | response shape; no competitor publishes a decline-shape ablation                                          |
| **ingest completeness**             | `test_competitor_sut.py`, 17 tests             | partial loss survives, total loss aborts                                                                                                                                  | `ingest: N of M session(s) stored, K refused` line                                                 | `40519523383` — see §4.2             | **all of them**: the benchd.ai 0.0%/20.0%/32.4% rows are unreconciled instrument results of this shape    |
| **store width declaration**         | 3 parametrised tests                           | faiss 1024/256, qdrant 768                                                                                                                                                | `vector_store_dims` in the manifest                                                                | `40519523383` reproduced and fixed   | **all of them**: any comparison whose store was built at a different width than its embedder              |
| **cross-encoder rerank** (§13.115)  | `rerank-census` / `relevance-rerank`, 24 tests | a pool wider than the endpoint's declared limit is rejected at construction, before one retrieval; a discarded reply keeps the original order **and** the original cosine | `## Rerank stage` section in the report, `rerank` in the arm config, five counters in the artifact | S6/S7, unrun — one dispatch pending  | reranking; RAW-RAG's own single-variable ablation (−3.92) is the only published price of this exact stage |

### 4.2 The two increments built this round, and what settling them requires

| Increment            | what would make it a result                                                                | what would not                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reviewPass: 'bare'` | `attempted` > 0 and IE/TR each move by ≥3 questions, with ABS still 30/30 and MR unchanged | an unchanged total. `40522788515` returned 80.80% — the control's number exactly — and its artifact said the pass was _configured_, which is not the same statement as _fired_ |
| ingest completeness  | a competitor run that either reports `N of M stored` or aborts, never a 0.0% row           | a fixed driver that is only ever tested on a healthy corpus                                                                                                                    |

The first row is why the census was built: the prediction `attempted > 0` is unfalsifiable against an artifact
that does not carry the count, and `40522788515` is exactly such an artifact. A mechanism whose firing is
unobservable is not yet measured, whatever the accuracy column says.

## 4.2.1 The resolution of S1, now that it has been measured

`S1` reads **83.5%** (`417.25 / 500`, five 48,000-character runs). Two facts about that number were measured
after it was written and belong beside it:

- **The arm's own dispersion is wider than most of the increments it is used to judge.** Four repetitions of
  one configuration, one job, one dataset (`40722772896`) produced totals of **407 / 414.5 / 414.5 / 423** and
  MR counts spanning **81–88**. Any prediction of the form "±3 questions" is therefore not resolvable on this
  arm as configured — which is why `S6`/`S7` carry a criterion and not only a threshold, and why the
  temperature pin (§13.119) is queued ahead of the rerank.
- **Buying more room does not move it.** `max_prompt_chars=96000` was dispatched as one variable and **rejected**:
  82.95% mean against 83.40%, with the coverage it bought (+9 questions where the gold was incomplete) almost
  exactly cancelled by the dilution it sold (−8 where the gold was already complete). 48,000 stays, and on the
  two capabilities that decide the gap every wrong answer now has **complete** gold coverage — so no further
  coverage work can be aimed at them (§13.118).

## 4.3 What is honestly not measured

**None of the four model-side increments has an end-to-end reading.** They are justified by the level below — a
mechanism that acts where it claims, on a set built to contain the failure — and that justification is weaker than
a benchmark number. The next run of S1–S4 is what converts it.

## 5. What a competitor number may and may not be used for

The memory-benchmark literature has a comparability problem that is worse than the usual noise: one system
reports **four different LoCoMo scores** depending on judge, reader and subset, and vendor self-reports diverge
from independent runs by **18–24 points**. So every competitor figure carries a grade.

| Grade | Meaning                                                                          | May be used for    |
| ----- | -------------------------------------------------------------------------------- | ------------------ |
| `A`   | same dataset, judge, reader and metric                                           | claiming a gap     |
| `B`   | same dataset and metric, different reader or judge, or a proxy metric            | noting a direction |
| `C`   | different dataset, different subset, or a vendor figure with no published recipe | motivation only    |

### 5.1 LongMemEval-S, the only axis where a grade-A comparison exists

| System                           | Score                    | Grade | Recipe                                                                                                                             |
| -------------------------------- | ------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| memoricai                        | 85.8%                    | A     | 500 questions, official prompts, gpt-4o-2024-08-06 as reader and judge, ~11k-token contexts                                        |
| Supermemory                      | 81.6%                    | A     | the published GPT-4o-reader configuration, per the same independent comparison                                                     |
| oracle context, GPT-4o           | 82.4%                    | B     | one oracle configuration — **not a ceiling**, see consequence 3                                                                    |
| **Raw-RAG (naive, GPT-4o-mini)** | **87.5%**                | B     | timestamps, chunking, dense retrieval, reranking over raw turns — no extraction, no rewriting                                      |
| StateMem (DeepSeek reader)       | 65.6%                    | B     | state-tracking memory; the only published DeepSeek-reader figure on this benchmark                                                 |
| **Cortex** (`cortex-memory` arm) | <!-- reading:S1 -->92.0% | —     | DeepSeek reader, official judge prompts, four runs, `maxPromptChars=48000` / `relevanceTopK=256`                                   |
| Mastra OM, GPT-4o                | 84.2%                    | B     | vendor research page, observational memory, GPT-4o reader and judge                                                                |
| Mem0 OSS, reproduced             | 32.4%                    | B     | benchd.ai, six systems on 500 questions — a reproduction of a vendor 94.4% that configures LLM extraction this run does not        |
| no-memory baseline               | 57.6%                    | B     | benchd.ai: the whole history in the window, no memory system                                                                       |
| Zep                              | 71.2%                    | A     | as reported in Zep's own LongMemEval paper, GPT-4o reader                                                                          |
| full-context GPT-4o              | 60.2%                    | A     | the paper baseline: the whole history in the window                                                                                |
| Hindsight (vendor)               | 94.6%                    | C     | vendor-reported; reader, judge and preprocessing not published reproducibly                                                        |
| Mastra OM, GPT-5-mini            | 94.9%                    | C     | the strongest reader; the same memory system as the GPT-4o row, which is what makes the 10.6-point gap an experiment on the reader |
| agentmemory V4                   | 96.2%                    | C     | single deterministic run, Claude Opus 4.6 reader, six-signal retrieval                                                             |
| Graphonomous                     | 92.6%                    | C     | keyword-recall proxy on an oracle split — not the official metric                                                                  |
| Recallium (Claude Opus 5.5 reader) | 98.4%                  | C     | vendor benchmark page, 500 questions, official GPT-4o grading prompts, 3.8 results per question                                    |
| ContextStream (Claude Opus 5.5 reader) | 96.8%              | C     | vendor benchmark page, 484/500 through the production API, official pinned GPT-4o judge, held-out half 96.0%                       |
| Recallium (GPT-4o reader)        | 90.2%                    | B     | the same memory and the same official prompts with the official GPT-4o reader — the like-for-like row for this arm                  |

Four consequences, and the last two are uncomfortable:

1. **The gap to close is 85.8% in the reproducible class, and 98.4% is the published ceiling.** The
   published, reproducible frontier on this benchmark with a GPT-4o-class reader is memoricai's 85.8%;
   everything above it is either a vendor claim or a different metric. The vendor rows that sit above 95%
   are kept in the table precisely so this section cannot be read as a frontier claim — and the like-for-like
   row, Recallium at 90.2 with a GPT-4o reader, is the one number here that this arm is level with rather than
   ahead of.
2. **Most open-source memory systems lose to having no memory at all.** The reproduced no-memory baseline is
   57.6%, and four of the six systems in the same harness scored below it. So the first acceptance question is
   "beats full context", and only then "beats the leaderboard". Cortex's 83.5% clears that bar by 25.9 points.
3. **A reading here is withdrawn rather than quietly corrected.** An earlier version of this section called the
   82.4% oracle the reader ceiling and inferred that 80.8% sitting 1.6 points under it meant retrieval had
   little left to buy. arXiv:2610.30755 retires that inference: a naive raw-RAG pipeline reads **87.53** with a
   GPT-4o-mini reader, five points _above_ the oracle. So 82.4 was one configuration and not a bound. The gap is
   still not all retrieval, but the reason now has to come from a measurement — same hits, different reader,
   recall held constant — rather than from a seat under an oracle.
4. **The reader axis is larger than the gap, and a second argument now agrees with it.** Mastra's own ablation
   moves one memory system from 84.23% to 94.87% by changing only the reader — a 10.6-point single-variable
   delta against the 4.8 points this project needs. And Raw-RAG reaches 87.5% with a mid-tier reader using this
   project's own shape: raw turns, dates, hybrid retrieval, no rewriting. Two independent lines, one conclusion:
   a reader swap is its own increment, measured, never assumed into a memory result. Judge prompts stay fixed at
   the benchmark's own either way.

The category split is where the deficit is, and it is not uniform. Knowledge update is at
<!-- reading:S2 -->88.5%, above the threshold and above the frontier's implied position; multi-session is at
<!-- reading:S3 -->83.9% and temporal reasoning at <!-- reading:S4 -->96.1%, so **the two categories that used
to hold essentially all of the gap are one pass and one 1.1-point miss**, not two deep deficits. That reading
replaced three that were four to eighteen points wrong; §2.2 is the record, and the reason it changed is not
that the system improved but that four rows were reading a configuration that no longer ships.

**How the current value was reached, because it changed this round.** The reading is now the mean of four runs
of one configuration (`reviewPass: bare`) rather than four runs of the previous one: 417 / 415 / 416 / 421
against the control's 404 / 399. No category is lower, `ABS` is 29/30 in all six runs, and the two arms' ranges
— 415–421 against 399–404 — do not overlap. The previous configuration's numbers are kept under
`previousConfiguration` in the evidence file rather than overwritten, so a reader can see what moved instead of
only where it landed.

### 5.2 The reranking axis, where no grade-A figure exists

The one component of the strongest published pipeline this arm has never had at all is the cross-encoder rerank
stage, and it is the axis where the literature is least comparable. Nobody publishes a cross-encoder ablation on
LongMemEval-S, so there is no grade-A row to place beside ours and no grade-B row either. What exists is
RAW-RAG's own ablation on **their** 20,000-sample set: removing the reranker takes them from 48.32 to 44.40,
**−3.92 points**, more than any mechanism they _added_. Different corpus, different window unit, different
`k` — so the figure is **grade `C`**: it may motivate the increment and it may price the mechanism, and it may
not appear in a claim of the form "we are behind them by 3.92". The row is attached to `S7` with that grade
rather than omitted, because a comparison that says what it cannot support is more useful than silence.

## 6. The methodology that produced these numbers

Five rules, each of which was learned by breaking it:

1. **One run is a direction, two runs are a conclusion.** Every reading quoted here is a mean of at least two
   runs, or is deterministic and re-executable to the byte.
2. **Check the dispatched configuration before reading the score.** An empty field once meant "product default"
   rather than "adopted configuration", and the difference was eleven fields and a 482/500 refusal rate.
3. **An injection must be single-variable.** Changing a gate and a prompt in one step makes both readings
   unattributable, which is why the relation gate landed with the prompt untouched.
4. **Unmeasured is not zero.** Absence has its own status (`unrun`), its own note, and its own line in the
   report.
5. **Fixing a measurement must bring the original number back, not move the threshold to meet the code.** When
   `stripComments` failed to recognise a regex literal, the census denominator lost one row; the fix restored
   319 rather than re-baselining to 318.

## 7. Running it

```bash
node tools/acceptance-check.mjs            # the table; exits 1 on a broken gate
node tools/acceptance-check.mjs --json     # the same, machine-readable
node tools/docs-crosscheck.mjs             # every reading marker against the code
node tools/docs-crosscheck.mjs --list      # the markers a document should carry
node tools/assumption-ablation.mjs         # the controlled set, verbose
```

The two checkers are wired into `pnpm check`. `--strict-unrun` turns an absent reading into exit 2, which is
the flag a release uses and a normal check does not: during ordinary work, one unrun benchmark should not stop
the other sixteen criteria from being enforced.

`docs-crosscheck` reports three counts rather than one, because a bare checkout and a full one are different
environments: **verified** (a value was computed and matched), **skipped** (no value here — the evidence for
that criterion lives in the paired documents repository) and **mismatched** (both existed and disagreed). Only
the third fails. Reporting the middle one is what stops a CI run without the documents repository from
"passing" while silently comparing nothing, and it is also what stops it from failing twelve documented
numbers for a reason that has nothing to do with the numbers.

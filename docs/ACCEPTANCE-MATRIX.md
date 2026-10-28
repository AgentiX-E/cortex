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

| Field | What it prevents |
| --- | --- |
| `metric` + `dataset` | a number whose measurement is not stated, which is a number nobody can reproduce |
| `comparator` + `threshold` + `unit` | a gap written as a ratio, so 28 points reads as 0.28 |
| `source` | a value typed into the table, which would be a second copy of a measurement |
| `kind` (`gate` / `aim`) | a build that can never be green, or a project that cannot block a regression |
| `onMiss` | a threshold that is decoration, because nothing was decided in advance about missing it |
| `competitors` + `grade` | a comparison with a number that was measured differently |

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

| id | current | threshold | status | capability | measured on |
| --- | --- | --- | --- | --- | --- |
| G1 | <!-- reading:G1 -->75.0% | ≥ 70.0% | pass | relation-preserving split | the 20 pairs the reviewer judged |
| G2 | <!-- reading:G2 -->5 | = 5 | pass | relation-preserving split | the same 20 pairs |
| G3 | <!-- reading:G3 -->40.6% | ≥ 30.0% | pass | relation-preserving split | `g00`, grouped against self-contained |
| K1 | <!-- reading:K1 -->64.7pp | ≥ 40.0pp | pass | assumption ledger | controlled set, `gated − flat` |
| K2 | <!-- reading:K2 -->58.8% | ≤ 65.0% | pass | assumption ledger | controlled set, `−persistence` |
| K3 | <!-- reading:K3 -->0 | = 0 | pass | assumption ledger | controlled set, `gated` |
| T1 | <!-- reading:T1 -->88.2% | ≤ 90.0% | pass | settled fact versus plan | controlled set, `−temporality` |
| T2 | <!-- reading:T2 -->94.1% | ≤ 95.0% | pass | settled fact versus plan | controlled set, `−immutability` |
| T3 | <!-- reading:T3 -->94.1% | ≤ 95.0% | pass | settled fact versus plan | controlled set, `−fulfil` |
| T4 | <!-- reading:T4 -->100.0% | = 100.0% | pass | settled fact versus plan | controlled set, `−lapse` |
| D1 | — | ≤ 45.0% | unrun | extraction fidelity | A3 round 2, verbatim share |
| R1 | <!-- reading:R1 -->-1 | ≥ 1 | accept | abstention recovery | LongMemEval-S, 500 questions |
| S1 | <!-- reading:S1 -->81.0% | ≥ 85.0% | aim | end-to-end memory, `cortex-memory` arm | LongMemEval-S, 500 questions, `benchmark-cortex-memory.yml` |
| S2 | <!-- reading:S2 -->86.8% | ≥ 85.0% | pass | knowledge update | LongMemEval-S, 72 questions |
| S3 | <!-- reading:S3 -->69.6% | ≥ 85.0% | aim | multi-session reasoning | LongMemEval-S, 121 questions |
| S4 | <!-- reading:S4 -->74.6% | ≥ 85.0% | aim | temporal reasoning | LongMemEval-S, 127 questions |
| S5 | <!-- reading:S5 -->97.5% | ≥ 80.0% | pass | abstention | LongMemEval-S, 30 questions |

Every `S*` row and `R1` are the **`cortex-memory`** arm, measured by `benchmark-cortex-memory.yml`. The
`benchmark.yml` workflow measures a different system (the reference pipeline) and reads 43.40% end to end;
its numbers are not on this page and must not be substituted for these. `MEASURE-BASELINE-DRIFT.md` §8 is
the record of what happens when they are.

`D1` is `unrun` and that is stated rather than hidden: the distillation reading needs an A3 run with a fresh
prompt, and no such run exists. A row with no value is the honest form of "we have not measured this".

## 4. How each increment is tested, on four levels

The user-facing question is "how do you know it works". The answer has to be four answers, because each level
catches a different defect and none of them subsumes the others.

| Level | What it catches | Where it lives | Threshold |
| --- | --- | --- | --- |
| **unit** | a rule that does not do what its comment says | `packages/*/src/**/__tests__` | 100% statements per file; ≥95% branch per package |
| **controlled** | a mechanism that does not act where it claims | `assumption-ablation.ts`, 17 cases | each ablation moves only its targeted families |
| **artifact** | a mechanism that works but is not wired | `tools/export-census.mjs`, `tools/acceptance-check.mjs` | every export has a caller or a recorded reason |
| **end to end** | a mechanism that helps on a fixture and not on a corpus | LongMemEval-S, 500 questions | S1–S5 |

The **artifact** level is the one that is usually missing, and it is the one that caught the largest defect in
this line of work: `assumptionPenalty` and `planFactor` existed, were tested, and had **no caller outside
their tests** until `assemble` was written. The export census reported them as orphans, which is how the gap
became visible; it is now zero, because `assemble` calls them.

### 4.1 The increments, one row each

Six columns, because a mechanism can be correct, act where it claims, be wired, help on a corpus — and still be
aimed at an axis nobody else competes on. The last column names the axis and who else reports on it, so an
increment that cannot be compared says so before it is built rather than after it is measured.

| Increment | unit | controlled | artifact | end to end | axis, and who else reports on it |
| --- | --- | --- | --- | --- | --- |
| relation-preserving split (step 28) | `knowledge/*.test.ts`, 149 tests | G1/G2/G3 on 20 reviewed pairs | `knowledge-probe.mjs` | not measured yet | internal only — no competitor publishes a relation-split corpus |
| assumption ledger (step 29) | `assumption`/`revision`, 39 tests | K1/K2/K3 | census: `assumptionPenalty` gained a caller | not measured yet | internal only |
| temporality and plans (step 30) | `temporality`, 34 tests | T1–T4 | census: `planFactor` gained a caller | not measured yet | temporal reasoning; every published system reports it, and all of them collapse on it |
| context assembler (step 33) | `assemble`, 42 tests | all arms now call it | census: `Penalty`, `assumptionPenalty` left the orphan list | not measured yet | context budget; agentmemory V4's per-capability token budgets are the public comparison |
| abstention recovery (step 26) | `abstention-recovery`, 21 tests | — | `recovery` in the artifact | R1, net −1 | abstention; LongMemEval's 30 ABS questions are the only public axis |
| date frame | pre-registered | — | — | A7, unrun | temporal; the paper's own time-aware index ablation (+7–11pp) |
| **`reviewPass: 'bare'`** | `bare-decline-retry`, 12 tests | reach: `flat` + `temporal`, ABS excluded in code | `## Bare-decline retry` section, `bareRetry` in JSON | run `40522788515`, 80.80% — see §4.2 | response shape; no competitor publishes a decline-shape ablation |
| **ingest completeness** | `test_competitor_sut.py`, 17 tests | partial loss survives, total loss aborts | `ingest: N of M session(s) stored, K refused` line | `40519523383` — see §4.2 | **all of them**: the benchd.ai 0.0%/20.0%/32.4% rows are unreconciled instrument results of this shape |
| **store width declaration** | 3 parametrised tests | faiss 1024/256, qdrant 768 | `vector_store_dims` in the manifest | `40519523383` reproduced and fixed | **all of them**: any comparison whose store was built at a different width than its embedder |

### 4.2 The two increments built this round, and what settling them requires

| Increment | what would make it a result | what would not |
| --- | --- | --- |
| `reviewPass: 'bare'` | `attempted` > 0 and IE/TR each move by ≥3 questions, with ABS still 30/30 and MR unchanged | an unchanged total. `40522788515` returned 80.80% — the control's number exactly — and its artifact said the pass was *configured*, which is not the same statement as *fired* |
| ingest completeness | a competitor run that either reports `N of M stored` or aborts, never a 0.0% row | a fixed driver that is only ever tested on a healthy corpus |

The first row is why the census was built: the prediction `attempted > 0` is unfalsifiable against an artifact
that does not carry the count, and `40522788515` is exactly such an artifact. A mechanism whose firing is
unobservable is not yet measured, whatever the accuracy column says.

## 4.3 What is honestly not measured

**None of the four model-side increments has an end-to-end reading.** They are justified by the level below — a
mechanism that acts where it claims, on a set built to contain the failure — and that justification is weaker than
a benchmark number. The next run of S1–S4 is what converts it.

## 5. What a competitor number may and may not be used for

The memory-benchmark literature has a comparability problem that is worse than the usual noise: one system
reports **four different LoCoMo scores** depending on judge, reader and subset, and vendor self-reports diverge
from independent runs by **18–24 points**. So every competitor figure carries a grade.

| Grade | Meaning | May be used for |
| --- | --- | --- |
| `A` | same dataset, judge, reader and metric | claiming a gap |
| `B` | same dataset and metric, different reader or judge, or a proxy metric | noting a direction |
| `C` | different dataset, different subset, or a vendor figure with no published recipe | motivation only |

### 5.1 LongMemEval-S, the only axis where a grade-A comparison exists

| System | Score | Grade | Recipe |
| --- | --- | --- | --- |
| memoricai | 85.8% | A | 500 questions, official prompts, gpt-4o-2024-08-06 as reader and judge, ~11k-token contexts |
| Supermemory | 81.6% | A | the published GPT-4o-reader configuration, per the same independent comparison |
| oracle context, GPT-4o | 82.4% | B | one oracle configuration — **not a ceiling**, see consequence 3 |
| **Raw-RAG (naive, GPT-4o-mini)** | **87.5%** | B | timestamps, chunking, dense retrieval, reranking over raw turns — no extraction, no rewriting |
| StateMem (DeepSeek reader) | 65.6% | B | state-tracking memory; the only published DeepSeek-reader figure on this benchmark |
| **Cortex** (`cortex-memory` arm) | <!-- reading:S1 -->81.0% | — | DeepSeek reader, official judge prompts, four runs, `maxPromptChars=48000` / `relevanceTopK=256` |
| Mastra OM, GPT-4o | 84.2% | B | vendor research page, observational memory, GPT-4o reader and judge |
| Mem0 OSS, reproduced | 32.4% | B | benchd.ai, six systems on 500 questions — a reproduction of a vendor 94.4% that configures LLM extraction this run does not |
| no-memory baseline | 57.6% | B | benchd.ai: the whole history in the window, no memory system |
| Zep | 71.2% | A | as reported in Zep's own LongMemEval paper, GPT-4o reader |
| full-context GPT-4o | 60.2% | A | the paper baseline: the whole history in the window |
| Hindsight (vendor) | 94.6% | C | vendor-reported; reader, judge and preprocessing not published reproducibly |
| Mastra OM, GPT-5-mini | 94.9% | C | the strongest reader; the same memory system as the GPT-4o row, which is what makes the 10.6-point gap an experiment on the reader |
| agentmemory V4 | 96.2% | C | single deterministic run, Claude Opus 4.6 reader, six-signal retrieval |
| Graphonomous | 92.6% | C | keyword-recall proxy on an oracle split — not the official metric |

Four consequences, and the last two are uncomfortable:

1. **The gap to close is 85.8%, not 96.2%.** The published, reproducible frontier on this benchmark with a
   GPT-4o-class reader is memoricai's 85.8%; everything above it is either a vendor claim or a different
   metric. Writing 96.2% into a target would be targeting a number nobody has reproduced.
2. **Most open-source memory systems lose to having no memory at all.** The reproduced no-memory baseline is
   57.6%, and four of the six systems in the same harness scored below it. So the first acceptance question is
   "beats full context", and only then "beats the leaderboard". Cortex's 81.0% clears that bar by 23.4 points.
3. **A reading here is withdrawn rather than quietly corrected.** An earlier version of this section called the
   82.4% oracle the reader ceiling and inferred that 80.8% sitting 1.6 points under it meant retrieval had
   little left to buy. arXiv:2610.30755 retires that inference: a naive raw-RAG pipeline reads **87.53** with a
   GPT-4o-mini reader, five points *above* the oracle. So 82.4 was one configuration and not a bound. The gap is
   still not all retrieval, but the reason now has to come from a measurement — same hits, different reader,
   recall held constant — rather than from a seat under an oracle.
4. **The reader axis is larger than the gap, and a second argument now agrees with it.** Mastra's own ablation
   moves one memory system from 84.23% to 94.87% by changing only the reader — a 10.6-point single-variable
   delta against the 4.8 points this project needs. And Raw-RAG reaches 87.5% with a mid-tier reader using this
   project's own shape: raw turns, dates, hybrid retrieval, no rewriting. Two independent lines, one conclusion:
   a reader swap is its own increment, measured, never assumed into a memory result. Judge prompts stay fixed at
   the benchmark's own either way.

The category split is where the deficit is, and it is not uniform. Knowledge update is at
<!-- reading:S2 -->86.8%, above the threshold and above the frontier's implied position; multi-session is at
<!-- reading:S3 -->69.6% and temporal reasoning at <!-- reading:S4 -->74.6%, and those two categories hold
essentially all of the gap.

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

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
| S1 | <!-- reading:S1 -->81.0% | ≥ 85.0% | aim | end-to-end memory | LongMemEval-S, 500 questions |
| S2 | <!-- reading:S2 -->86.8% | ≥ 85.0% | pass | knowledge update | LongMemEval-S, 72 questions |
| S3 | <!-- reading:S3 -->69.6% | ≥ 85.0% | aim | multi-session reasoning | LongMemEval-S, 121 questions |
| S4 | <!-- reading:S4 -->74.6% | ≥ 85.0% | aim | temporal reasoning | LongMemEval-S, 127 questions |
| S5 | <!-- reading:S5 -->97.5% | ≥ 80.0% | pass | abstention | LongMemEval-S, 30 questions |

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

| Increment | unit | controlled | artifact | end to end |
| --- | --- | --- | --- | --- |
| relation-preserving split (step 28) | `knowledge/*.test.ts`, 149 tests | G1/G2/G3 on 20 reviewed pairs | `knowledge-probe.mjs` | not measured yet |
| assumption ledger (step 29) | `assumption`/`revision`, 39 tests | K1/K2/K3 | census: `assumptionPenalty` gained a caller | not measured yet |
| temporality and plans (step 30) | `temporality`, 34 tests | T1–T4 | census: `planFactor` gained a caller | not measured yet |
| context assembler (step 33) | `assemble`, 42 tests | all arms now call it | census: `Penalty`, `assumptionPenalty` left the orphan list | not measured yet |
| abstention recovery (step 26) | `abstention-recovery`, 21 tests | — | `recovery` in the artifact | R1, net −1 |
| date frame | pre-registered | — | — | A7, unrun |

The last column is the honest one: **none of the four model-side increments has an end-to-end reading yet.**
They are justified by the level below — a mechanism that acts where it claims, on a set built to contain the
failure — and that justification is weaker than a benchmark number. The next run of S1–S4 is what converts it.

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
| **Cortex** | <!-- reading:S1 -->81.0% | — | DeepSeek reader, official judge prompts, four runs |
| Zep | 71.2% | A | as reported in Zep's own LongMemEval paper, GPT-4o reader |
| full-context GPT-4o | 60.2% | A | the paper baseline: the whole history in the window |
| Hindsight (vendor) | 94.6% | C | vendor-reported; reader, judge and preprocessing not published reproducibly |
| Graphonomous | 92.6% | C | keyword-recall proxy on an oracle split — not the official metric |

Three consequences, and the third is uncomfortable:

1. **The gap to close is 85.8%, not 94.6%.** The published, reproducible frontier on this benchmark with a
   GPT-4o-class reader is memoricai's 85.8%; everything above it is either a vendor claim or a different
   metric. Writing 94.6% into a target would be targeting a number nobody has reproduced.
2. **Cortex sits inside the grade-A band already.** 81.0% is above Zep (71.2%), above full context (60.2%),
   and level with Supermemory's published figure. The honest claim is "competitive, not leading".
3. **The category split is where the deficit is, and it is not uniform.** Knowledge update is at
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

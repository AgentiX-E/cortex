# Reading an external review against the tree

**What this is.** A 191-file external review of this repository's evaluation system was delivered on
2026-11-08 with four P0 recommendations, three P1 and two P2. This document checks every claim it makes
against `master` at `0d2eef3`, records which of them were already closed, which are real, and which are
wrong about the tree — including one that is wrong in the way the review's own §7 predicts.

**Why it is written down.** The review is largely right about the field and partly wrong about this
repository, and the two are hard to separate on a first read because every claim carries a citation. A
citation to an audit document is not a citation to the code: `docs/AUDIT-CODE-VS-DOCS.md` is dated
2026-09-20 at revision `31a3371`, and four of its rows have been closed since. Quoting it as current is the
same failure the review's §7 names — *the document is not the state* — and it is worth one page to show
that the failure is not confined to the documents under review.

---

## 1. Verdicts

| # | claim | verdict | evidence |
| --- | --- | --- | --- |
| 1 | "the cognitive layer is not on the benchmark path; the harness consumes 7 symbols of core" | **closed before the review** | `packages/cortex-memory` exists, `benchmark-cortex-memory.yml` dispatches it, and `S1`–`S5` / `R1` are that arm's rows. `memory-system-conformance.test.ts` asserts the 7-member routing contract the review asked for. `AUDIT-EVAL-CONTRACTS.md` §3 is the audit that produced it. |
| 2 | "memory-poisoning defence appears only in a doc comment" | **true** | `packages/cortex-core/src/domain/memory.ts:15` is the only occurrence, and it is a comment on `origin`. `V1` measures append-only against no-memory on a 17-case contradiction set — TEPA's reversal experiment, not an adversarial injection. There is no attack set, no lane and no `ASR` column anywhere. |
| 3 | "≥95% coverage is not written into any `vitest.config.ts`" | **wrong** | all five packages carry `thresholds: { statements, branches, functions, lines }` at 95. `docs/AUDIT-CODE-VS-DOCS.md` §5 row 4 already carries the correction in its own text — *"Premise needs re-checking — all five packages already carry thresholds"* — and the same cell carries the finding that survives (see §2). |
| 4 | "the two workflows measured different systems; 81.0% → 44.2%" | **true, and closed** | `MEASURE-BASELINE-DRIFT.md` is the post-mortem; `ACCEPTANCE-MATRIX.md` §3 now states which workflow owns which number, and `benchmark.yml` writes `data/dataset.sha256` for the embedding-cache key. |
| 5 | "the corpus is fetched from a moving `resolve/main` URL and the sha256 is printed, not pinned" | **half true** | the URL is still `resolve/main`; the digest is printed **and assertable** (`corpus_sha256` input, non-empty ⇒ mismatch exits 1). It defaults to empty, so the pin is available and not on. `datasetFingerprint` is written into every artifact from the bytes actually read. |
| 6 | "`judge-audit.yml` is `workflow_dispatch` only, so the judge is not gated" | **true, with the reason** | the workflow's own header says why: it spends credits and its reading is only meaningful against a *specific artifact*, which is an input rather than a constant. The review's proposed `push:` trigger would run it with no artifact to audit. A `--plan-only` push lane is possible and is not built (§3). |
| 7 | "31 rows in the acceptance matrix" | **stale count** | 30 criteria as of this round (`C3` added), rendered as 33 printed rows plus competitor sub-rows. The count is not the point; the review's *structural* claim under it — that a `gate` row is the only kind that can go red — is correct and is how the file works. |
| 8 | "no claim-level grounding: only correct / wrong / abstain" | **true** | `metrics.ts` scores exact match and the judge's verdict. There is no decomposition into *not recalled* / *stale evidence* / *unfaithful generation*. |
| 9 | "`SOTA-BASELINE.md` §5's reader-ceiling conclusion was overturned twice" | **true, already recorded** | the Correction blocks are in the file and §13.307.2 records the reversal the review is describing. |
| 10 | "94 markdown documents, 30+ `AUDIT-*`, one per experiment" | **true** | 89 under `docs/` plus 5 at the root; 30 `AUDIT-*`. The review's proposed remedy (a generated index with frontmatter) is not adopted this round (§3). |

Eight of ten stand in some form. The two that do not are the two that a five-minute `grep` would have
settled, and both are cited to a section of an audit document whose own text contains the correction.

---

## 2. The one P0 that is real, and larger than the review says

The review's P0-4 is *"put the threshold in the config"*. The threshold is in the config. The measurement
the review did not take is what the config means, and it is worse than a missing gate:

> `vitest`'s `thresholds` are checked against the **package average**, so **a single under-covered file
> cannot fail CI.** `AUDIT-CODE-VS-DOCS.md` §5 records the experiment (an injected unreached export took
> `cortex-memory/src/prompt.ts` to 94.36 / 90.90 while the package averaged 97.88 / 97.43 and
> `vitest run --coverage` exited 0), and the per-file audit it names was never closed.

Measured on this tree with `--coverage.thresholds.perFile=true`, the gate is standing in front of this:

| package | files under the 95 floor | worst |
| --- | ---: | --- |
| `cortex-core` | 12 (8 real, 4 pure-declaration `0/0`) | `knowledge/markers.ts` **68.75% branches** |
| `cortex-ai` | 6 (2 real, 4 `0/0`) | `openai-compatible.ts` 86.27 / 84.21 / 84.61 / 85.41 |
| `cortex-eval` | 6 | `judge-audit.ts` 82.81 branches; `system-mirror.ts` 81.25 branches |
| `cortex-storage` | 2 | `sqlite.ts` 80.00 branches (the documented `close()` idempotence guard) |
| `cortex-memory` | 2 | `sessionize.ts` 94.54 branches |

**30 files, and four of them are far below the floor** — `markers.ts` at 68.75% branches, `sqlite.ts` at
80%, `system-mirror.ts` at 81.25%, `paired-flip.ts` at 85.41%. These are not rounding: they are unexercised
branches in the knowledge layer, the storage engine, the system mirror and the paired-flip tool. The
average-scoped gate has been reporting a number that these files could not move below 95 on their own.

Two of the 30 are a different kind of thing and were already known: the `0/0` modules (pure `export *`
barrels and pure declaration files) report 0% without containing anything to execute. `coverage-annotations.test.ts`
already asserts the `0/0` versus `0/n` distinction for exactly this reason, and any per-file gate has to
honour it or it will fail on files that have no code.

**What this round does not do** is close 30 files. What it does is state the measurement, because a gate
that reads as closed and is average-scoped is worse than no gate: it converts "we have not tested this"
into "we have", and the review read it that way.

**Registered next, in this order:** (1) `0/0` barrels excluded by the same rule as `types.ts`; (2) a
**ratchet** rather than a wall — a committed `per-file-baseline.json` and a checker that fails when a
baselined file gets worse, when a new file lands under the floor, or when a baselined file crosses 95 (it
must then leave the baseline, so slack cannot accumulate); (3) the five worst files fixed, `markers.ts`
first. That ordering is what makes the gate strict *now* without requiring 30 fixes *first*.

---

## 3. What is adopted, deferred, and refused

**Adopted this round.**

| review item | what was done |
| --- | --- |
| §6 P1-1 claim-level grounding, first half | not the NLI decomposition — the **joint accuracy × cost reading**, because the same defect (one axis at a time) made the matrix unable to say whether a 49.9% context cut at `MR −6.61` was a win. `docs/DESIGN-EFFICIENCY-FRONTIER.md`, `C3`. |
| §4 "the 2–3-question effects are inside the judge's noise" | taken further than the review: the resolution arithmetic is now the reason the composite is an order and not a score, and `underpowered` is a first-class outcome. |
| §7 "a row that has never been met teaches people to delete rows" | already the file's own rule; `C3` was added as an `aim` with a met-adjacent reading rather than as a `gate` that would be red on day one. |

**Deferred with a reason, not dropped.**

| review item | why not now |
| --- | --- |
| P0-1 pin the corpus digest by default | the digest is already computed, written and assertable; turning the assertion on by default requires a first reproduction to pin against, and the review's own template carries `__填入首次复现的 sha256__`. The measured 12,105 / 90.20% pair in `frontier.json` now carries `datasetFingerprint`, so the value exists for the next round to pin. |
| P0-2 judge-audit on push | possible only in `--plan-only` form (no artifact, no credits, asserts the case list rather than the rate). Worth doing; it gates the *instrument's* shape, not the judge's bias, and the review's phrasing would have a push run measure nothing. |
| P1-2 poisoning lane | the review is right that the capability is a comment. The design that fits this repository is **three attacks judged by state diff, not by a judge** (`inject-high-trust`, `supersede-hijack`, `retrieval-flood`), reporting `utilityNoAttack / utilityUnderAttack / targetedASR`. It is not built because a lane that reports a rate nobody has a baseline for is the `unrun` failure mode in expensive form; `V1`'s 17-case set is the seam it would extend. |
| P1-3 LoCoMo as a second benchmark | agreed in principle and blocked on the thing the review does not mention: `COMPETITOR-CODE-AVAILABILITY.md` §2 records that `longmemeval-cleaned` **replaces** the original release and that published numbers are produced on a file we do not have. A second set whose gold answers were written by a different process multiplies that problem rather than fixing it. `FinLoCoMo` is the registered third set instead, because it isolates *revised figures* — our `KU` — as its own class. |
| P2-1 online trace | no production deployment exists to trace. The columns proposed (`evidenceIds + validFrom`, `sourceTrust`, `judgeVersion`, `cost`) are already in the artifact for the offline runs; what is missing is a service. |

**Refused.**

| review item | why |
| --- | --- |
| §7 merge 30 `AUDIT-*` into one index and archive the rest | the audits are the evidence for claims the matrix makes, and `docs-crosscheck.mjs` reads documents for numbers. An index with frontmatter is a good idea *once the numbers live in artifacts*; done now it would be a second place for a stale value to hide, which is the failure it is meant to prevent. |
| §7 frontmatter template with `status: pass / fail` per document | two sources of truth for one status. The matrix already has a four-state status with `onMiss`, generated from code. |
| DeepEval / Promptfoo as the L2 gate | the matrix is already an executable gate (`acceptance-check.mjs` exits 1 on a missed `gate`). Adopting a second runner would put the criteria in two schemas. |

---

## 4. What the review is right about that hurts most

Not the P0s. This:

> *"its statistical tools, pre-registration, negative-result records are exemplar-level, but the high score
> measures the harness's own reference pipeline rather than the product's cognitive layer."*

That was true on 2026-09-20 and is false now — but the review could read it as true from the tree, because
`AUDIT-CODE-VS-DOCS.md` says so and nothing marks it superseded. **A closed audit looks exactly like an open
one.** That is a documentation defect with a real cost: an external reviewer spent effort on four P0s, three
of which were already done, and the two they got wrong are the two that would have been settled by one
`grep`.

The remedy this round is the smallest one that works: the verdict table above, and the measured per-file
coverage list, both of which are claims with a command behind them.

---

## 5. Reproducing every number in this document

```bash
# 1. the per-file coverage measurement (§2) — 30 files, four far below the floor
for p in core ai eval storage memory; do
  (cd packages/cortex-$p && npx vitest run --coverage \
      --coverage.thresholds.perFile=true --coverage.reporter=text)
done

# 2. the accuracy x cost pair (§1 of DESIGN-EFFICIENCY-FRONTIER.md)
node tools/efficiency-frontier.mjs --label window --label squeezed \
  run-42310779222/benchmark-cortex-memory-ablation-report.json \
  run-42373407439/benchmark-cortex-memory-ablation-report.json

# 3. that the thresholds exist and are average-scoped (§1 row 3, §2)
grep -n "thresholds" packages/*/vitest.config.ts

# 4. that poisoning is a comment (§1 row 2)
grep -rn "poison" packages/cortex-core/src --include=*.ts
```

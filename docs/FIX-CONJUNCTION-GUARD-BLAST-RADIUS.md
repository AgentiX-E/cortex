# FIX — The Conjunction Guard's Blast Radius

**Status:** fixed at `bench/run.ts` + `src/ablation-skip.ts`; 17 new tests.

This document records a defect found by running the benchmark rather than by
reading it, because the code was correct in isolation: the guard did exactly
what it was designed to do, and the run was still destroyed by it.

---

## 1. The observed failure

Run `35498421148` (commit `16ca1ea`, `LIMIT=60`) failed after 11 minutes:

```
conjunction ablation cohort is incomplete: 1/7 present, missing 6456829e_abs,
edced276_abs, e5ba910e_abs, gpt4_70e84552_abs, gpt4_c27434e8_abs,
gpt4_fe651585_abs. ...
    at runQueryExpansionDecompositionAblation (runner.ts:831:11)
    at main (bench/run.ts:397:37)
```

The guard is **correct and must stay loud.** R4's P2/P3 predictions are
pre-registered against seven specific questions; at `LIMIT=60` the stratified
sample keeps 1 of the 6 controls, and scoring that subset would publish a
different experiment under the same name. Refusing is the right call.

## 2. What actually went wrong

The guard's *verdict* was right; its *position in the program* was not.

`bench/run.ts` writes every other report before the conjunction arm runs, and
`main().catch` persists the embedding cache only at the very end. So the throw
unwound through all of it:

| Consequence | Detail |
| --- | --- |
| Main benchmark report lost | `benchmark-report.md` / `.json` were written at 08:08 but never in the artifact set as a success |
| Markdown report lost | same |
| Embedding cache not persisted | `Save embedding cache` ran, but `bench/run.ts` had already exited before its own persist step — 11 minutes of billed embedding calls not reused next run |
| Workflow red | `Run benchmark` = failure, so the run reads as "produced nothing" |

The artifact set preserved the earlier reports only because `Upload benchmark
report` uses `if: always()`. That is a second, accidental defence keeping the
loss from being total — not a design.

**The defect class:** a pre-flight precondition check placed *after* the work it
protects, in a program whose failure handler discards completed work. The guard
was written to prevent a wrong number, and it prevented the whole number set
instead.

## 3. Fix

Two changes, deliberately separate:

**3.1 `bench/run.ts` catches the guard.** The conjunction arm is wrapped in a
`try`/`catch`. The guard still throws, the message still goes to stderr as
`conjunction ablation skipped: ...`, and every other report plus the embedding
cache survives. The skip is *recorded*, not *hidden*.

**3.2 `src/ablation-skip.ts` records why.** A structured record —
ablation name, unmodified reason, the missing cohort member ids, and the
denominator — is written to `benchmark-ablation-skipped.json` on every run,
including as `[]`.

Rationale for the second half: without it, a reader who finds no
`benchmark-conjunction-ablation-report.json` cannot tell "declined for a stated
reason" from "crashed" or "never wired". The artifact set now explains its own
gap.

### 3.3 Why the guard was not softened

The tempting fix is `requireCohortCoverage: false` by default. It is wrong: that
is precisely the vacuous pass the guard exists to prevent — at `LIMIT=60` P3
reduces to a 0-of-1 bound whose one-sided 95% upper bound on collateral damage is
95%, i.e. it cannot fail. The option is now exposed (`REQUIRE_CONJUNCTION_COHORT`,
default `0`) so the strict behaviour is reachable, but the default keeps the
guard loud and the reports alive rather than trading one defect for another.

## 4. The parsing bug found by the tests

`parseMissingCohortMembers` first used `/\bmissing\s+([^.]*)\./`. A test written
against a plausible non-cohort error caught it:

```ts
parseMissingCohortMembers('the response is missing content.')
// expected [] — got ['content']
```

The un-anchored pattern treats any sentence containing the word "missing" as a
cohort shortfall, so a provider error would have been recorded as a shortfall
naming the question `content`. Fixed by anchoring on the guard's own wording —
`present, missing <ids>.` — which is both more specific and self-documenting.

A second test drove a change to the implementation for a different reason: the
`match[1] ?? ''` fallback was branch-unreachable (the capture group is mandatory
when `match` is non-null), so it was replaced with a direct assertion plus a
comment explaining why no fallback is needed. An unreachable branch in a parser
hides a future pattern change that drops the group; removing it is the fix, not
covering it with `v8 ignore`.

## 5. Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| Guard still refuses a short cohort loudly | Guard code unchanged; `requireCohortCoverage` default flips the *caller's* behaviour, not the guard's verdict |
| A short cohort no longer loses completed reports | `try`/`catch` in `bench/run.ts`; conjunction report absent, everything else persisted |
| The skip is visible in the artifact set, not just a log line | `benchmark-ablation-skipped.json`, emitted unconditionally including `[]` |
| A non-cohort error is not mis-parsed as a shortfall | Test: `'the response is missing content.'` → `[]` |
| A truncated message does not over-capture | Test: message without the terminating period → `[]` |
| Fully-missing and partially-missing cohorts stay distinguishable | Test: `required` is the caller's denominator, never inferred from `missing.length` |
| `ablation-skip.ts` at 100% on all four dimensions | Verified: 100 / 100 / 100 / 100 |
| Workspace green | 1094 tests, 0 failures; all four packages ≥95% on all four dimensions |

## 6. Not claimed

- **The conjunction arm still did not run.** This fix preserves the other
  reports; it does not make R4 measurable at `LIMIT=60`. R4 needs `LIMIT=200`.
- **No accuracy claim is affected.** Every number in the preserved reports is
  from the graded path, which the conjunction arm does not touch.
- **The broader pattern is not yet audited.** Other pre-flight checks placed
  after their protected work would have the same defect. This fix addresses the
  one that was observed; a systematic pass is not claimed here.

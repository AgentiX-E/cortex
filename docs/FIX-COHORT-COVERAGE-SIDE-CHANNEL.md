# FIX — Cohort Coverage Was a Side Channel

**Status:** fixed in `report.ts` + `runner.ts` + `bench/run.ts`; 5 new tests.

This is the second defect in the conjunction guard, found one round after the
first. The first was the guard's blast radius (`FIX-CONJUNCTION-GUARD-BLAST-RADIUS.md`);
fixing that one *introduced* this one, which is why it is recorded separately.

---

## 1. What the previous fix got wrong

The first fix stopped the guard from discarding every completed report when it
fired. It caught the throw and had the caller write a skip record. Correct as far
as it went.

But it also flipped the caller's `requireCohortCoverage` default to `false`, so
an under-covered cohort now *succeeds* instead of throwing. Verifying that fix
produced this artifact (run `35502712132`):

```
benchmark-conjunction-ablation-report.md      <- present, rendered as an ordinary report
benchmark-ablation-skipped.json               <- []
```

and inside the JSON:

```
cohortCoverage.present: ["80ec1f4f_abs"]
cohortCoverage.missing: 6 of 7
cohortCoverage.ratio:   0.1428
```

A **1-of-7 cohort** produced a full report. The Markdown contained no occurrence
of the words `cohort`, `coverage`, `incomplete`, or `missing` — verified by
grep across the whole file.

## 2. Why this is worse than the failure it replaced

| | Before | After the first fix |
| --- | --- | --- |
| Run outcome | red | green |
| Reports kept | none | all |
| Wrong-experiment risk | **visible** (the run died loudly) | **silent** (the report looks complete) |

The guard exists because R4's P2/P3 are pre-registered against seven specific
questions, so scoring a subset "is not a weaker test, it is a different test that
happens to share a name" — the guard's own words, in the source. The first fix
preserved the guard's verdict for the *strict* configuration and then made the
permissive configuration the default, which moved the wrong-experiment outcome
from a loud failure to a quiet artifact.

**A degraded run that looks healthy is strictly worse than one that fails**,
because the failure is self-announcing and the healthy-looking number is not.

## 3. Root cause

`runQueryExpansionDecompositionAblation` computed `coverage` and returned it:

```ts
return { report, markdown: formatAblationReport(report), coverage };
```

`formatAblationReport(report)` receives only the report, and `report` did not
contain the coverage. So the renderer had no way to print the caveat even if it
wanted to, and the caller that *did* hold the coverage wrote it only to JSON.

The information existed at the return site and was separated from the thing it
qualifies. That is the defect: **coverage is not metadata about the report, it is
part of what the report means.**

## 4. Fix

**4.1 `AblationReport` carries `cohortCoverage`.** Optional, because most arms
declare no cohort. The comment on the field records why it is not a
side-channel return value.

**4.2 `runner.ts` attaches it before formatting**, so `formatAblationReport`
cannot render the numbers without the coverage in hand:

```ts
const result = await runAblationReport(...);
const report: AblationReport = { ...result, cohortCoverage: coverage };
return { report, markdown: formatAblationReport(report), coverage };
```

**4.3 `formatAblationReport` prints a banner above the results** — above, because
a caveat below three tables of Wilson intervals is a caveat nobody reads. An
incomplete cohort gets `**COHORT INCOMPLETE — read these numbers with care.**`
plus the present/total count, the ratio, and the missing ids. A complete cohort
gets an explicit `**Cohort complete**` line, so "satisfied precondition" and
"no precondition declared" are distinguishable.

**4.4 `bench/run.ts` serialises the report as-is** instead of spreading the
side-channel field back in, removing the second path that could disagree about
coverage.

## 5. Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| An incomplete cohort is visible in the Markdown | Test: banner contains `INCOMPLETE`, the ratio, and the missing ids |
| The banner precedes the results | Test: `indexOf('INCOMPLETE') < indexOf('Δ accuracy')` |
| A complete cohort is announced, not silent | Test: `100.00%` + `complete`, and no `INCOMPLETE` |
| Arms without a cohort are unchanged | Test: no `/[Cc]ohort/` in the rendered output |
| Ratio formatted like every other rate | Test: `14.29%` for 1/7 |
| The report carries coverage through the formatter | `AblationReport.cohortCoverage`; fixture built from real types, no cast |
| No workspace regression | 1099 tests, 0 failures; all four packages ≥95% on all four dimensions |

## 6. Not claimed

- **The conjunction arm is still under-covered at `LIMIT=60`.** This fix makes
  the shortfall visible; it does not make R4 measurable. R4 needs `LIMIT=200`.
- **No other arm was audited for the same pattern.** The defect is "information
  that qualifies a result is returned beside it rather than inside it". Other
  arms return `{ report, markdown, ...extras }` and were not checked. Stated as
  a known gap rather than claimed clean.
- **The `[]` skip record from run `35502712132` is correct.** `requireCohortCoverage:
  false` means the guard did not fire, so nothing was skipped — the report
  succeeded and carried its own caveat. Both artifacts were individually
  consistent; the defect was that the caveat never reached the reader.

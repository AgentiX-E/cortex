# FIX — The Report Dies When It Is Re-Read From JSON

**Status:** fixed in `report.ts`; 6 new tests. Found by re-rendering a *real
archived artifact*, not by reading code.

This is the third defect in the conjunction-guard sequence, and the first that is
not about the guard at all. It was found while verifying the second fix: feeding
the persisted `benchmark-conjunction-ablation-report.json` from run `35502712132`
back through `formatAblationReport` — the operation a reader of the artifact set
naturally performs — threw.

---

## 1. Symptom

```
TypeError: Cannot read properties of null (reading 'toExponential')
    at formatAblationReport (report.ts:124)
```

The report had rendered correctly at the moment it was produced. It became
unrenderable once written to disk and read back.

## 2. Root cause

`JSON.stringify` has no representation for `NaN` or `±Infinity`; it writes
`null`. A single-run ablation produces exactly those values:

| Field | Live value | Why | After `JSON.stringify` |
| --- | --- | --- | --- |
| `ablation.pValue` | `NaN` | Welch over-run t-test with `runs < 2` | `null` |
| `ablation.effectSize` | `±Infinity` | the two arms never disagreed | `null` |

The renderer guarded the p-value with `Number.isNaN(ab.pValue)`. That guard is
**wrong for this input**: `Number.isNaN(null)` is `false`, because `null` is not
the `NaN` value — it is a different value entirely. So a null p-value took the
numeric branch and `null.toExponential(3)` threw.

The `effectSize` path had no guard at all beyond the infinity comparisons, all of
which are `false` for `null`, so it fell through to `null.toFixed(3)` — the same
throw on the next line.

## 3. Why the existing tests could not catch it

Every test of `formatAblationReport` builds a report **in memory**, where
`pValue: Infinity` and `effectSize: -Infinity` are real numbers. The tests
`renders positive and negative infinite effect sizes` exercise exactly the values
that do not survive serialisation — and pass, because they never serialise.

The defect lives in the boundary between the runtime representation and the
persisted one, and no test crossed it. **A test suite that only ever exercises
in-memory objects cannot see a serialisation defect**, however thoroughly it
covers the render function itself.

## 4. Why this matters more than a crash

The crash is the *loud* half. The quiet half is what the numbers would have said:

- A `null` effect size rendered by a naive `?? 0` or `Number(null)` fix becomes
  `0.000`, which reads as **"no effect"**. The truth is an infinite effect — the
  arms differed on every question. A silent inversion of a finding is worse than
  a stack trace.
- `JSON` is the durable artifact. The Markdown is derived and regenerable; the
  JSON is what gets archived, diffed across runs, and re-read when someone asks
  why a number moved. **A report that cannot be re-read cannot be defended.**

## 5. Fix

Two small formatters with explicit `null` handling, in place of inline
expressions:

```ts
function formatPValue(p: number | null, fallback: string): string {
  if (p === null || Number.isNaN(p)) {
    return fallback;
  }
  return p.toExponential(3);
}

function formatEffectSize(d: number | null): string {
  if (d === null) {
    return 'n/a';
  }
  ...
}
```

Decisions worth stating:

1. **`null` is checked explicitly, not via `Number.isNaN`.** The original bug was
   precisely the assumption that "not-a-number" and `null` are the same, and the
   replacement should not restate it in a different spelling.
2. **The fallback is `n/a`, not `0`.** For the effect size this is a correctness
   requirement, not a style choice (§4).
3. **The parameter is typed `number | null`** so a caller passing a persisted
   report type-checks. Typing it `number` and relying on a runtime guard would
   have kept the call sites misleading.
4. **The t-test fallback string moved into the signature** (`'n/a
   (deterministic)'` vs `'exact'`), because the McNemar p-value is an exact test
   that is never `NaN` while the t-test legitimately is — the two need different
   words for the same absent number.

## 6. The evidence test

`report-json-roundtrip.test.ts` uses the `ablation` object **verbatim from the
real archived artifact** (run `35502712132`), including `pValue: null` and
`effectSize: null` as `JSON.parse` yields them. The decisive test is not a
hand-built null but the actual serialise/deserialise pair:

```ts
const live = report({ ablation: { pValue: NaN, effectSize: -Infinity } });
const persisted = JSON.parse(JSON.stringify(live));
expect(persisted.ablation.pValue).toBeNull();
expect(() => formatAblationReport(persisted)).not.toThrow();
```

End-to-end confirmation on the real artifact, after the fix:

```
> **COHORT INCOMPLETE — read these numbers with care.**
> This arm's pre-registered predictions name 7 specific questions.
  **1/7 (14.29%) are present**; ...
> Missing: 6456829e_abs, edced276_abs, e5ba910e_abs,
           gpt4_70e84552_abs, gpt4_c27434e8_abs, gpt4_fe651585_abs
```

The same file, re-read from disk, now renders both the cohort banner it was
missing and the numbers it previously crashed on.

## 7. Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| A persisted report renders without throwing | Test: real archived payload |
| A null p-value is labelled, not numbered | Test: `n/a (deterministic)` |
| A null effect size is `n/a`, never `0.000` | Test: `Cohen's d: **n/a**` |
| Real numeric values are unaffected | Test: `1.000e-3`, `0.420` |
| The failure is reproduced through real `JSON.stringify`/`parse` | Test: asserts `null` before rendering |
| The cohort banner survives persistence | Test: banner above `Δ accuracy` in a parsed report |
| No workspace regression | See `09-progress-and-delivery-report.md` for the current count |

## 8. Not claimed

- **No other report was audited for the same pattern.** This fix covers
  `AblationReport`. The other `benchmark-*.json` writers were not checked for
  fields that are `NaN`/`Infinity` in memory and consumed after a read-back.
  Stated as a known gap.
- **The `null` representation itself is not changed.** `JSON.stringify` still
  writes `null`; the reader now handles it. Making the writer emit a sentinel
  string would change the artifact schema, which is a larger decision than this
  defect justifies.

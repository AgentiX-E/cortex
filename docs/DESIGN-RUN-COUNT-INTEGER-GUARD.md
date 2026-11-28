# A run count must be a whole number, or `NaN` silently becomes one pass

**The defect this records.** `bench/run.ts` and `bench/run-ablation.ts` read the repetition count with
`Number(process.env.RUNS ?? 1)`. `Number('abc')` is `NaN`. `runAblation` guarded with `if (runs < 1)`, but
`NaN < 1` is false, so a mistyped `RUNS` was accepted. The repeat loop `for (let i = 1; i < runs; i++)` then ran
zero extra passes (`1 < NaN` is also false), accuracy was computed from the single first pass, and the report
published `"runs": NaN` — which serializes to `null` in JSON. A configuration that reads "8 runs" and a
measurement that ran 1 is indistinguishable in the artifact from an honest one-run result.

## 1. The root-cause pattern: comparisons against `NaN` are all false

This is the same class as the two input-boundary defects fixed in the preceding iteration (`LIMIT=abc` ->
empty sample, and `2023/02/30` -> negative elapsed days): a value crosses a boundary without being checked
against the contract the consumer assumes. Here the specific mechanism is that every relational operator with
`NaN` returns false, so a guard written as a lower bound passes the very value it was meant to reject.

A sweep of the other count consumers confirms this was the sole gap:

- `two-window.ts` (`CORTEX_WINDOWS`) and `shard.ts` (`CORTEX_SHARD(S)`) already parse with a digits-only
  regex / `readWhole` **before** their `< 1` guards;
- `readTemperature`, `readMilliseconds`, `readWhole` and the previous iteration's `readWholeNumberLimit` all
  reject non-numeric text at the source.

`RUNS`/`ABLATION_RUNS` were the only count that reached a comparison guard as a raw `Number(...)`, so the fix
belongs at the point of consumption, where it covers every caller — not only the two env-var entry points.

## 2. The fix

`runAblation`'s guard now requires a positive integer:

```ts
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error(`ablation requires at least 1 whole run, got ${runs}`);
}
```

`Number.isInteger` rejects `NaN`, `Infinity` and fractions; `< 1` still rejects zero and negatives. Because the
guard sits in `runAblation`, every path — the bench entry points, the specific ablations, and direct API callers —
fails fast with a clear message rather than publishing a mislabeled single-pass report.

`PROGRESS_EVERY` is deliberately left alone: `NaN > 0` is false and it only disables progress logging, which does
not touch a score. Fixing a non-score-affecting log knob in the same change would be a speculative edit without a
reproduced defect (note 13).

## 3. Acceptance

| Check | Result |
|---|---|
| Red test | `runAbstentionRetryAblation` with `runs` = `NaN`, `Infinity`, `1.5`, `0`, `-1` — each previously resolved or published; each now rejects |
| Reproduced defect | old code published a report with `"runs": NaN`; the test output recorded the exact serialized artifact |
| Regression | `ablation-runs` 4 passed, `benchmark-ablation` 23 passed, `ablation-progress` 5 passed (32 total) |
| No legitimate caller broken | all existing `runs:` values in tests and entry points are positive integers; `runs: 0` callers already expected rejection |
| Format | Prettier clean; no new export, so export-census totals are unchanged |

## 4. Why this matters for the leaderboard

Like the preceding fixes, this defect is in the code that *labels* a measurement, not in a score. A reviewer
reading only the leaderboard could not detect that a "3-run" row actually ran one pass — the accuracy number
looks ordinary. The instrument must state what it did before the number it prints can be trusted. The three
un-adopted mechanism leads (per-question routing, extractive memory, multi-step ReAct) and Cortex's 93.40%
position are unchanged.

---

## 5. A second fix from the same iteration: unjudged pairs in McNemar

A parallel read-only audit of the statistics/aggregation layer found a HIGH-severity defect in the same
"instrument reports what it did" family. `runAblation`'s paired-flip loop walked only `correct[]`, where a judge
failure is recorded as `false` (`scoreOrRecordUnjudged` in `metrics.ts`). The `unjudged[]` vectors — present at
that exact point and written to the artifact a few lines later — were never consulted. A judge timeout in the
baseline arm therefore counted as a genuine `baselineIncorrectFeatureCorrect` gain. Both `metrics.ts` and the
`AblationResult.unjudged` type contract state explicitly that a pair containing an unjudged verdict is an
instrument-created discordance that must be excluded from McNemar's b/c counts.

**Reproduced:** a scorer that throws on the baseline's answer produced three false gains (`expected 0, got 3`)
and could move `mcnemarSignificant` from no to yes on a small sample.

**Fix:** the flip loop builds `Set`s of unjudged question ids from both arms and `continue`s past the flip
branches for such pairs. Accuracy buckets are still counted for both sides first, so the stated pessimistic
`false` bound on accuracy is preserved — only the paired significance test drops the instrument's own failure.
Per-capability buckets obey the same rule because they are incremented in the same loop.

**Acceptance:** `benchmark-ablation.test.ts` 25 passed (23 established + 2 new): one case fails the judge in
the baseline arm and asserts the discordant count is 0, the gain list omits the unjudged id, `mcnemarPValue === 1`,
`mcnemarSignificant === false`, and `perCapability.IE.baselineIncorrectFeatureCorrect === 0`; the mirror case
fails the judge in the feature arm and asserts no regression flip is booked. Both failed at the flip count
against the old code. The coverage ratchet forced the mirror case too: without a feature-side unjudged verdict
the feature-set lambda was unreachable, and the per-function floor caught it. `ablation.ts` coverage returned to
177/179 statements (98.88%, above the recorded 98.82%) and 31/31 functions.

**Registered for the next iteration (not rushed):** cost-accounting coherence — `runAblationReport` writes
`runs` only when the caller passes it although the ablation defaults to 3, so `attachCostEfficiency` silently
drops `costEfficiency`; and `cost-per-capability.ts` defaults `runs` to 1 when `featureCorrectByRun` is present,
overstating per-correct cost by the repetition factor. Both need a design decision about where the effective
run count is persisted, so they are recorded rather than folded unverified into a reproduced fix.

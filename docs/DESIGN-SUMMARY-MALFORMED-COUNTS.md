# A malformed count must not fail the summary that guards the run

**The defect this records.** `tools/benchmark-summary.py` is the second, independent sink for benchmark numbers,
added after a green run's artifact and logs were both unfetchable. Its contract is explicit in its own header:
*never fail the step*. The retry-fires block, however, computed `rate = treatment / questions` directly. A report
that is valid JSON but carries `null` where the live run carried a number — the same persisted-NaN round-trip the
file already documents for `pValue` — raised `TypeError: unsupported operand type(s) for /: 'NoneType' and 'int'`
and exited 1. The renderer failed the very run it exists to protect, exactly when the artifact channel was least
trustworthy.

## 1. Why this is the same failure the last five iterations closed

Each prior iteration found one instrument recording a fact that another reported differently or lost entirely: a
zero-usage frame erasing a bill, a dimension-blind cache key, a manifest naming a model the client never called,
a workflow environment name the driver never read, a billed non-JSON response retried twice more. Here the shape is
a malformed number turning a best-effort sink into a hard failure. The common thread is a value crossing a boundary
without being checked against the contract the consumer assumes.

The file already handles the same class for `pct()`: `None`, booleans and non-numbers render as `n/a` rather than a
fabricated `0`. The retry-fires block was the one place that bypassed that discipline and did arithmetic first.

## 2. The concrete failure, reproduced

A report with `retryFires: { controlFires: null, treatmentFires: null, questions: 60 }`:

```
File "tools/benchmark-summary.py", line 99, in ablation_table
    rate = 0 if not questions else treatment / questions
TypeError: unsupported operand type(s) for /: 'NoneType' and 'int'
```

Exit code 1. The red test drives the real script as a subprocess (`execFileSync`, which throws on non-zero exit), so
the failure is the script's, not a re-implementation's.

## 3. The fix

`ablation_table` now checks all three count fields as real non-boolean numbers before any arithmetic:

```python
counts_are_numbers = all(
    isinstance(v, (int, float)) and not isinstance(v, bool)
    for v in (control, treatment, questions)
)
rate = treatment / questions if counts_are_numbers and questions else None
```

- Valid counts keep their exact behaviour and wording (`control 0, treatment 1 of 60 (1.67%)`, the
  `INVALID EXPERIMENT` / `INERT` verdicts) — the three existing retry-fire tests are unchanged and still pass.
- A null, string or boolean count renders as `n/a` with `-- UNREADABLE: retry-fire counts are not numbers`,
  never as a fabricated zero and never as an exception.
- The verdicts only run when the counts are numbers, so a garbage value cannot masquerade as "never fired".

Booleans are excluded explicitly because `bool` is a subclass of `int` in Python: `True / 60` is a number, but a
boolean is not a retry count.

## 4. Acceptance

- New test `renders a null retry-fire count as a labelled value instead of dividing by it`: the previously crashing
  report now exits 0 and prints a labelled `n/a` retry-fires row.
- All 16 tests in `benchmark-summary.test.ts` pass, including the three untouched retry-fire verdict tests that
  pin the valid-count behaviour.
- Full `pnpm check` and `pnpm test:tools` green; per-file coverage gate satisfied.

No API spend: the test writes a local temp directory and runs the script as a subprocess.

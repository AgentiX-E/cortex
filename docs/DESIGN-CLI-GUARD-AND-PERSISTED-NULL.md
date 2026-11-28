# Silent Scope Loss and a Null That Failed the Step It Protects

## Summary

Three command-line tools accepted a malformed input and produced a plausible, green result instead of
refusing it. Two scoped readers parsed `--capability` by taking the raw next token; when the flag was
last, or was followed by another flag, the scope silently became `undefined`, which both readers treat
as "every capability" — a whole-population read indistinguishable from the scoped read the caller
asked for. The third tool, the job-summary renderer, called `len()` on a persisted `null`, raising
`TypeError` and failing the very step whose purpose is to keep a succeeded run from going red. All
three were found by reading the argument boundary and the summary's own contract, then pinned with
red tests that failed against the real defects before the fixes were written.

## 1. A flag without a value is a usage error, not a broader scope

`paired-delta-census.mjs` parsed `--capability` as `capability = argv[(index += 1)]`, and
`membership-reach.mjs` as `capability = argv[i + 1]; i += 1`. Both then advanced the index. The
failure has two shapes:

- A trailing `--capability` yields `undefined`. Both tools define an undefined capability as "no
  scope": `index()` filters with `capability === undefined ? all : ...`, and `censusOf()` does the
  same. The tool prints a full census, exits 0, and writes nothing to stderr.
- A `--capability` immediately followed by another flag (e.g. `--capability --json`) swallows that
  flag's name as the capability. The reader then either refuses on a nonexistent capability or, worse,
  reads a population no one requested, depending on the tool.

Both shapes are dangerous because the output is well-formed. There is no exception, no warning, and
the exit code is 0 — the caller has no signal that the scope it requested was discarded. A paired
census whose scope vanished is not a smaller version of the same result; it is a different claim about
a different population, reported under the name of the scoped read.

The fix refuses both shapes at the boundary. Each reader now checks the next token before assigning
it: if it is `undefined` or starts with `--`, the tool writes `refused: --capability requires a NAME`
to stderr and returns a non-zero exit. A valid NAME still advances the index and runs exactly as
before. The check is deliberately at parse time rather than inside `index()`/`censusOf()`, because
those functions legitimately accept `undefined` for the unscoped case; only the CLI flag promises a
NAME.

## 2. A persisted `null` where a count belongs must render, not raise

`benchmark-summary.py` states two contracts in its own docstring: "Never fails the step — every error
is rendered into the output instead of raised", and "`null` is handled explicitly ... must render as
a label, never as a number" (`NaN` and `±Infinity` survive a `JSON.stringify` round-trip as `null`).
The retry-fire counter already honoured this by guarding each field with `isinstance(v, (int, float))`.
The cohort-coverage counter did not:

```python
present = len(coverage.get("present", []))
missing = coverage.get("missing", [])
total = present + len(missing)   # TypeError when missing is null
```

A report carrying `"missing": null` — the documented persisted form — raised `TypeError` out of
`ablation_table`, escaped `summarise`, and failed the whole job-summary step. The step exists
precisely so that a succeeded run with an unfetchable artifact still has a second sink for its
numbers; a malformed count made that sink fail the run.

The fix treats both sides as optional lists. When both `present` and `missing` are real lists, the
cohort line renders exactly as before (`2/3 (INCOMPLETE, missing ABS)`). When either is `null` or a
non-list, the line renders the readable side's length and `n/a` for the other with a
`(n/a = not recoverable)` note — never a fabricated `0/0`, which would read as a complete empty cohort
and invert the finding just as silently as the original crash.

## 3. Method: red against the real defect, then mutation

For each of the three fixes a pytest test was written first and run against the unmodified tool:

- a trailing `--capability` and a `--capability --json` pair must be refused with a non-zero exit
  that names the missing argument (four assertions across two files);
- a `cohortCoverage` with `missing: null`, and with both fields `null`, must render an `n/a` cohort
  line without raising, while a well-formed cohort still renders its counts.

Against the defects the suite reported 5 failed / 4 passed: the two trailing-capability cases, the
membership flag-swallower case, and both null-coalescing cases failed. After the fixes it reported
9 passed. A reverse mutation — restoring each guard to its defective form — reproduced the failures,
confirming the new assertions bind the intended behavior rather than passing vacuously. The tools'
`--self-test` suites remained green, so no existing invariant was narrowed.

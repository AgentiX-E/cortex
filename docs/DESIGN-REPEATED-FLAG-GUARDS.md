# Five More Boundaries That Turned a Missing NAME Into a Plausible Result

## Summary

A previous round fixed the same defect in two scoped readers and one summary renderer: a flag whose
value was missing, or was another flag, silently degraded into a broader read or a crash. A targeted
audit of the remaining `tools/` scripts found five more instances of the same shape — four JavaScript
parsers that took `argv[index + 1]` without checking it, and one Python loop that tested membership
in a persisted `null`. All five are now refused at the boundary. Each fix was written red first (the
defect reproduced), then made green, then mutation-checked by restoring the defect and confirming the
tests fail again.

## The shared failure mode

A command-line flag that promises a NAME (`--capability KU`) has three inputs: a real NAME, no value
at all, and another flag standing where the NAME should be. The defective parsers handled only the
first. For the other two they assigned the raw next token:

- a trailing `--capability` produced `undefined`;
- `--capability --json` produced the string `"--json"`.

Neither was rejected. Downstream, `undefined` is a meaningful value — it means "no capability scope"
— and a string like `"--json"` filters the population to zero rows. Both are well-formed outputs with
exit code 0, so the caller gets a census, verdict, or reading that looks normal but describes a
different population than the one requested. This is the same class as the null-laundering defect: a
missing input is coerced into a concrete value instead of being named as missing.

A subtlety drove a second correction during the fix: the `flag(argv, name)` helper returns `undefined`
both when the flag is **absent** and when it is **present but trailing**. Checking only the returned
value cannot distinguish the two. The guards therefore check flag *presence* (`argv.includes(name)`)
as well as the value, so an omitted flag keeps its documented default while a valueless flag is
refused.

## The five fixes

| Tool | Defect | Guard added |
| --- | --- | --- |
| `arm-verdict.mjs` | trailing `--capability` widened to every capability; `--capability --json` swallowed the flag and read zero questions | presence + value check before `project`; refuse with usage, exit 2 |
| `paired-flip.mjs` | trailing value widened the paired read; `--capability --list` was swallowed as the NAME | presence + value check in `main`; refuse, exit 2 |
| `ku-stale-census.mjs` | `--capability --json` filtered to zero rows and printed `capability --json: 0 ...` with exit 0 | value check in the parse loop; `refused`, exit 2 |
| `arm-transition.mjs` | trailing value silently reproduced the `MR` default; `--capability --json` produced a zero-applicable reading | presence + value check in `main`; refuse, exit 2 |
| `audit-discordant-identity.py` | `coverage.get("present", [])` with a persisted `null` raised `TypeError: argument of type 'NoneType' is not iterable`, escaping the audit loop | guard `coverage` is a dict and `present` is a list before membership; a malformed field contributes no target row instead of crashing |

The Python fix mirrors `benchmark-summary.py`: a `null` where a list belongs is a real persisted
state, not an empty list. The audit's existing try/except covers only JSON loading, so the exception
used to escape the main loop and fail a step whose own contract is to report what it can verify.

## Method and limits

Five tests were written against the unmodified tools and reproduced the defects (7 failures across
the new and existing files; the control cases — a valid NAME, an omitted flag, a well-formed cohort —
stayed green). After the fixes all passed. A reverse mutation restored each defective guard and
reproduced 7 failures, confirming the assertions bind the intended behavior. The existing full test
files for the two tools with prior coverage (`test_arm_verdict.py`, `test_paired_flip.py`) stayed green
(25 passed), so no earlier invariant was narrowed.

These are boundary guards only. No downstream statistics, defaults, or thresholds changed: a valid
capability and an omitted flag behave exactly as before, and a malformed input is now named rather
than silently reinterpreted.

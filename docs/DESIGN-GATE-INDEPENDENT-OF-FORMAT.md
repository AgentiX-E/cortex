# A check stays a check regardless of the format it prints

**Status:** implemented — `tools/export-census.mjs`, `tools/readings-census.mjs`.
**Supersedes:** nothing. **Amends:** `AUDIT-CENSUS-CALLER-BY-NAME.md`.

## 1. The rule

A tool's `--check` flag is a policy: it says *refuse when the claim does not reconcile*. An output
flag such as `--json` is a format: it says *encode the same result for a machine*. Format must never
decide policy. Two defects let a caller silence a gate by changing how the result was printed, and
both passed every existing test because those tests exercised only one flag at a time.

## 2. `--json` returned before the gate ran

`export-census.mjs` computed the orphan report, then branched: `if (json) { print JSON; return 0; }`.
The baseline reconciliation — the part that decides whether a *new* unreferenced export appeared —
lived after that branch. So `node tools/export-census.mjs --check --json` printed a perfectly good
JSON document and exited 0 on a tree that `--check` alone refused. A caller could not tell that the
two flags meant different things; the second silently cancelled the first.

The fix extracts the verdict from the rendering:

- `freshOrphans(orphans)` is the single policy — the orphans not covered by the recorded baseline.
- `writeVerdict(fresh, write)` renders that verdict through a caller-supplied writer and returns the
  exit status.

Both output modes now call the same two functions. In text mode the verdict goes to stdout, exactly
as before. In `--check --json` mode the JSON stays on stdout (so the machine consumers that parse
it still work) and the human verdict goes to stderr. The gate's status is the same in both modes.

## 3. A missing generated document passed the check

`readings-census.mjs --check` compares a generated document against the record it derives from. The
comparison was guarded by `existsSync(document) &&`: when the file was absent, the whole check was
skipped and the tool printed `ok`. A gate that passes when its own output has been deleted is a gate
that can be removed by accident — a bad merge, a stale `.gitignore`, a partial checkout — with no
signal.

Absence is the same defect as a stale document: a claim with nothing that re-derives it. Both now
push a problem with the same remedy (`pnpm readings:write`). The green fixture in the test suite was
updated to generate its document before checking, the way the real `write` + `check` pipeline runs;
the tests that expect a refusal still refuse, now with one more reason, and none asserts an exact
problem count, so no test passes for the wrong reason.

## 4. Deliberately not changed

A third finding — `reader-cost-census.mjs --check` promises "exit 1 unless every field is
computable" but only refuses when the feature side is absent — was left alone. That tool is not in
the CI check chain, and its `ok` flag means "a usable feature side exists", not "every optional
reading is priced"; per-call figures are legitimately `null` when a side made zero calls. The
promise in the usage comment is wider than the contract the tool implements. Narrowing the comment
is a documentation edit, not a correctness fix, and is recorded for a later documentation pass
rather than bundled into a gate repair.

## 5. Verification

Strict red → green. Before the fix, the new tests failed for the documented reasons: `--json
suppressed the gate: expected +0 to be 1`, and `assert 0 == 1` where the missing document printed
`ok`. After the fix the full `export-census-gate.test.ts` passes 24/24 and
`test_readings_census.py` passes 20/20. The JSON payload remains parseable by `JSON.parse` in the
combined-flag case, and the pipe tests still receive the full report through a reader that does not
drain eagerly.

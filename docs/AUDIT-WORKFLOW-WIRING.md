# A workflow is not compiled, so nothing checked what it called

**Status:** closed. Two gates added, one defect fixed that had been live for four days and had never
run. No dispatch, no spend.

## 0. In one paragraph

`pnpm --filter @agentix-e/cortex-eval probe:multi-step` has been in
`.github/workflows/probe-multi-step.yml` since commit `5d1d1f7f` and the script it names has been in
`cortex-memory` since that same commit. The workflow would have failed at its measurement step —
after the checkout, the install, the build and a 100 MB corpus download — and nothing in the tree
would have said so, because a workflow is not compiled, is not typechecked, and is not imported by
anything. A new gate resolves **every** `pnpm --filter <package> <script>` in **every** workflow
against the workspace manifests, and its first run found this one. The probe it disabled is the one
that decides whether the two-step retrieval arm is worth buying, so the research line it prices has
been unmeasurable since 2026-11-22 without anyone choosing that.

## 1. The defect, with its evidence

| when | what |
| --- | --- |
| 2026-11-21 04:45 | run `44867629266` completes **success** — the last time this workflow worked |
| 2026-11-22 03:23 | commit `5d1d1f7f` folds the loop into `cortex-ai`, moves the probe to `cortex-memory`, and rewrites the workflow's package filter from `cortex-agent` to `cortex-eval` |
| 2026-11-22 → 2026-11-26 | four days, **zero dispatches**, and the workflow could not have produced a reading in any of them |

The three runs before it are the record of how expensive this seam is: `44863794098` failed for want
of pytest, `44865288439` failed on a suite that reads a sibling repository, `44866169073` was
cancelled. Each cost a dispatch. The fourth succeeded because the filter was right at the time, and
the fifth has never been attempted — which is why a break introduced by a *move* survived: moves are
verified by tests that import the moved file, and no test imports a workflow.

The move was correct. `packages/cortex-agent` stopped existing; the loop became `cortex-ai/agent` and
the probe went to `cortex-memory/bench`. The workflow was the one artefact the move could not break
loudly.

## 2. The second gate, which is not a defect but a permit

`.github/workflows/measure-spec-ceiling.yml` exists to price a dispatch while spending nothing: it
searches a grammar over a programme-built ledger and never consults a model. The way such a file
becomes expensive is by being copied from one that does — the corpus download, the install and the
build are all identical to `benchmark-cortex-memory.yml`'s, so the `env:` block is one paste away
from carrying `DEEPSEEK_API_KEY`. A gate asserts that no `DEEPSEEK_API_KEY` or `ZHIPU_API_KEY` is
**assigned from a secret** in that file, and it is written as an assignment match rather than a
substring match because the file explains in prose why it has no key and a check that refused the
word would forbid the sentence documenting the rule.

## 3. What the gates are, and what turning them off looks like

| gate | asserts | three mutations that must fail it |
| --- | --- | --- |
| script resolution | every `pnpm --filter <pkg> <script>` in `.github/workflows/*.yml` names a script that package declares | rename `measure:spec-ceiling` to `measure:spec-ceilingX` → **failed**; the pre-existing `cortex-eval probe:multi-step` → **failed**, which is how the defect was found |
| credential purity | `measure-spec-ceiling.yml` assigns no model key from a secret | add `DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}` to its `env:` → **failed** |
| population binding | the ceiling workflow passes `--population` and searches both vocabularies | drop `--population` → **failed** (the assertion is on the flag, not on the file name) |

`pnpm --filter ... --` is skipped by the parser and by nothing else: a turbo fan-out is the one
filtered call that names no script, and an exemption list for it would be a second place to look when
the gate fails.

## 4. The same seam, found by a different gate: arithmetic in `bench/` is arithmetic nobody measures

The ceiling instrument was written in `bench/measure-spec-ceiling.ts` and exported eighteen symbols so
its test could reach them. Two gates reported that as two different problems, and both were right:

| gate | reading | why |
| --- | --- | --- |
| `census:check` | **18 new orphans** | a bench script is an entry point; its exports are symbols a customer never installs and nothing calls |
| coverage | the file is **outside the boundary** | `vitest.config.ts` measures TypeScript under `src/` only, so a test of the search moved no counter |

The repair was not an exemption in `tools/export-census-baseline.json`. The search is a function of a
corpus question and a ledger, and the script that feeds it a 100MB corpus is a caller like any other,
so the search moved to `src/aggregation/ceiling.ts` and the script kept only the command line. After
the move the census reads **no new orphans** and the arithmetic is measured in the same four
dimensions as everything else in the package.

Nine helpers stayed private, because their only caller is `measure`. The test therefore asserts
through `measure`/`summarise`/`selectPopulation` rather than through the helpers — a deliberate loss
of reach in exchange for a gain in meaning, since a test that pinned a private helper would go red on
a refactor that changed no reading.

## 5. What this does not claim

1. **Not a YAML schema check.** The gates read the files as text. A workflow can still be invalid
   YAML, or reference an action version that no longer exists; `guard:ci`
   (`tools/ci-gate-audit.py`) covers the prerequisite half, and neither covers GitHub's own schema.
   A local schema validator was rejected as a third mechanism for a class of defect that fails fast
   and visibly at dispatch rather than silently.
2. **Not a claim that every script is called.** The reverse direction — a `bench/` instrument with no
   caller — is deliberately not gated. `measure-spec-ceiling` had no caller for one round and that was
   correct: the instrument is written, then registered, then dispatched, and a gate that demanded a
   caller would force the registration to be written after the reading it is supposed to constrain.
3. **Not a repair of the probe's own reading.** The workflow now names the package that owns the
   script. Whether the two-step arm is worth buying is still an open question with a registered
   criterion (§14.98.8, `gainedQuestions ≥ 5`), and this document does not touch it.

# FIX — Six Dependency Advisories, and the Three Things the Upgrade Changed Underneath

**Status:** fixed and guarded. Six open Dependabot alerts closed by moving `vitest` 2.1.9 → 5.0.5
and three transitive packages inside the ranges their parents already allowed. The upgrade also
changed three behaviours that no test in this repository would have reported on its own — collected
test files, a test's time budget, and the coverage instrument — and each of those is recorded here
with the measurement that found it.

**Found by:** reading the open alerts rather than the build. Nothing was red. Every alert was on a
`development` dependency, so none of them was reachable in a shipped artifact, and the suite was
green throughout — which is exactly the state in which a lockfile rots.

---

## 1. What was open

Six alerts, all `pnpm-lock.yaml`, all `development` scope. Read from
`GET /repos/AgentiX-E/cortex/dependabot/alerts?state=open` on 2026-11-01:

| # | package | advisory | CVSS | vulnerable range | first patched |
| --- | --- | --- | --- | --- | --- |
| 6 | `@vitest/mocker` | GHSA-qxg6-89mg-rqv8 | 4.7 medium | `>= 2.1.0-beta.7, < 4.1.12` | 4.1.12 |
| 5 | `source-map-js` | GHSA-68fv-2mgg-jv7q | 7.5 high | `>= 1.0.0, < 1.2.2` | 1.2.2 |
| 4 | `brace-expansion` | GHSA-q2hr-2g5m-vwhr | 5.3 medium | `< 1.1.21` | 1.1.21 |
| 3 | `js-yaml` | GHSA-2883-xcg3-v3hh | 7.5 high | `>= 4.0.0, < 4.3.2` | 4.3.2 |
| 2 | `vitest` | GHSA-82fw-gwwq-j7x9 | 5.9 medium | `>= 2.1.0, < 4.1.11` | 4.1.11 |
| 1 | `@vitest/mocker` | GHSA-82fw-gwwq-j7x9 | 5.9 medium | `>= 2.1.0, < 4.1.11` | 4.1.11 |

Two things about that table are worth stating because they decide the shape of the fix.

**The two vitest advisories are one axis with two floors.** Alert 6 asks for 4.1.12 and alerts 1 and 2
ask for 4.1.11, so the real floor on the axis is **4.1.12**, not the lower number, and `vitest` and
`@vitest/mocker` must move together — `@vitest/mocker` is published at exactly `vitest`'s version, so
an override of one without the other produces a resolver error rather than a fix.

**Three of the six never needed an override.** `js-yaml` was 4.3.1 under `@eslint/eslintrc`'s
`^4.1.0`, `brace-expansion` was 1.1.18 under `minimatch@3.1.5`'s `^1.1.7`, and `source-map-js` was
1.2.1 under `postcss`'s and `magicast`'s `^1.2.1`. All three patches were already inside the
declared ranges; the lockfile had simply pinned an older resolution. `pnpm update js-yaml
brace-expansion source-map-js -r` moved them to 4.3.2, 1.1.21 (and the 5.x line to 5.0.12), and
1.2.2, and `pnpm.overrides` stayed empty. A pin is a smaller fix than an override, and an override
is a smaller fix than a fork — this is the first of those.

## 2. The one thing that did not resolve itself: vite

`vitest` 5 declares `vite` as a peer of `^6.4.0 || ^7.0.0 || ^8.0.0`. `vite` is not a dependency of
this workspace, so it was present only because the previous `vitest` had auto-installed 5.4.21 to
satisfy its own peer. After the bump, `pnpm install` reported, five times, once per package:

```
├── ✕ unmet peer vite@"^6.4.0 || ^7.0.0 || ^8.0.0": found 5.4.21
```

`pnpm` reused the existing resolution instead of re-resolving an auto-installed peer, so the
workspace had `vitest@5.0.5` paired with `vite@5.4.21` and the install exited 0 while saying so.
That is the shape to watch for: **a green install with unmet peers**. The fix is explicit rather
than emergent — `vite ^7.3.7` is now a root `devDependency`, and `resolve-peers-from-workspace-root`
(pnpm's default) makes that one declaration satisfy every package's peer. Vite 8 was available and
inside the range; 7 was chosen because it is the line `vitest@5.0.5`'s own lockfile was cut against,
and an upgrade that fixes advisories is not the commit in which to also move a bundler major.

## 3. Three behaviours the upgrade changed underneath

### 3.1 `**/dist/**` is no longer excluded by default

Vitest 5's default `exclude` is `['**/node_modules/**', '**/.git/**']`. Vitest 2 also carried
`**/dist/**`. `tsc` emits the compiled copies of the test files into `dist/`, so after the bump
every compiled test was collected a second time:

| | files | tests |
| --- | --- | --- |
| vitest 5, defaults | **74** | **1,561** |
| vitest 5, `dist/**` restored | **37** | **820** |

Most of the duplicates failed on fixtures, because `tsc` copies no fixtures into `dist/` — 23
failures, all `ENOENT ... dist/triage/__tests__/fixtures/triage-labels.json`.

One of them did something worse. `export-census-gate.test.ts` *writes to a tracked source file*: it
appends a probe export to `packages/cortex-core/src/math/vector.ts`, runs the census CLI against
it, and restores the file from its own snapshot in a `finally`. Two copies of that test ran
concurrently against one file, each holding a different "original", and the last writer won. The
tree came back with three probe exports in it:

```
export function orchestratedCensusGateProbe(value: number): number
export function restoreIsByteLevel(): number
export function pipedCensusGateProbe(value: number): number
```

The census gate then failed on `3 NEW orphan(s) not in the baseline` — the gate correctly reporting
its own test's residue — and eight tests in that file failed downstream of it. Nothing was lost:
`git checkout` restored the file and the failures disappeared once the duplicate collection
stopped.

The duplicate collection is the root cause and the concurrency hazard was a *consequence*, so the
fix is the `exclude` and not a lock around the file. It is written into all five configs as
`exclude: [...configDefaults.exclude, 'dist/**']` rather than as a bare list, so the set of
collected tests is a decision in this repository and not a default that can move underneath it
again. The account lives in `packages/cortex-core/vitest.config.ts`; the other four point at it.

### 3.2 A 4.99-second test and a 5,000 ms default

`export-census-gate.test.ts` spawns three `node` processes to prove the census CLI writes its whole
payload through a pipe, and each one re-reads the workspace:

| invocation | wall clock |
| --- | --- |
| `node tools/export-census.mjs --json \| wc -c` | 1.66 s |
| `node tools/export-census.mjs --json > file && wc -c < file` | 1.66 s |
| `node tools/export-census.mjs --json \| cat` | 1.67 s |

4.99 seconds against vitest's 5,000 ms default. It passed before the upgrade by ten milliseconds,
which is not a property of the code — it is a property of how large the tree has grown and how fast
the machine is. The test now carries an explicit `{ timeout: 60_000 }`. Every assertion is
unchanged, because widening a clock cannot make a truncated payload parse: the byte-count equality
is what fails when the pipe drops output.

### 3.3 The coverage instrument changed, and five "100%" claims were the old instrument's

This is the finding that matters beyond the upgrade, and the lockfile states it exactly. The old
provider mapped V8's byte ranges back through source maps — its dependencies were
`@bcoe/v8-coverage`, `@ampproject/remapping`, `istanbul-lib-source-maps`. The new one depends on
**`ast-v8-to-istanbul`** and `@vitest/istanbul-lib-*`, and it decides coverage from the AST rather
than from the ranges. The practical effect is that a `switch` arm, or the third clause of a
comparator, is attributed to itself rather than to the enclosing function's covered range — so code
that was never executed stops being reported as executed.

| package | configured claim | reading under vitest 2 | reading under vitest 5 |
| --- | --- | --- | --- |
| `cortex-core` | "100% on all four dimensions for every file that contains runtime code" | 100 / 100 / 100 / 100 | **98.29 / 95.61 / 99.49 / 98.76** |
| `cortex-ai` | "100 stmts / 98.47 branch / 100 funcs / 100 lines" | as claimed | **99.79 / 100 / 99.01 / 100** |
| `cortex-eval` | "100 / 99.95 / 100 / 100" | as claimed | **99.21 / 97.74 / 99.65 / 99.39** |
| `cortex-memory` | no figure recorded | — | **100 / 99.5 / 100 / 100** |
| `cortex-storage` | "100 stmts / 98.9 branch / 100 funcs / 100 lines" | as claimed | **100 / 99.12 / 100 / 100** (after the two tests below) |

The thresholds are 95 on all four dimensions and every package clears them, so the gate never went
red. The claims in the config comments did, and they are corrected in place.

Two of the gaps are not artefacts, and were proved so by reading the code they name:

- **`cortex-core/src/knowledge/revision.ts`** — `RevisionOptions.invalidations` is a documented
  public option ("STALE's Type II conflict … recording it, once somebody or something has said so,
  is bookkeeping") with **no test anywhere in the repository**. The 15-line loop that applies it
  reads `100%` under the old instrument and `87.09 / 74.41 / 100 / 90.00` under the new one, which
  is the honest number for a feature nothing calls.
- **`cortex-eval/src/acceptance.ts`** — `currentOf` dispatches one `Criterion` over seven source
  kinds; the `arm`, `gap`, `leak`, `ablation` and `artifact` arms are never exercised by a unit test
  (they are exercised at runtime by `docs-crosscheck.mjs`, which is not the same thing).

The first was closed rather than recorded: seven cases now cover `invalidations` — the refutation
and the slot refutation it implies, the declaring fact staying untouched, a backwards pair, an equal
pair, a pair naming an absent id, and survival of an agreement reached elsewhere in the same batch —
and `revision.ts` reads **95.96 / 86.04 / 100 / 99.00** with `cortex-core` at **98.77 / 96.29 /
99.49 / 99.20**. The `acceptance.ts` arms are named here as an open gap rather than closed, because
they are five delegating arms of one switch and closing them is a separate, testable change.

Two more gaps in `cortex-storage` were real and are now covered, and one of them was a promised
invariant rather than a line. `SqlStorage.close()`'s own comment says *"a failed schema application
must not prevent the engine from being released"*, and that is the single path where the eager
`#ready` promise rejects — a `close()` that awaited it plainly would reject instead of releasing,
handing the caller a handle they cannot get rid of. `sql-storage.test.ts` now injects the failure
over a real engine (refusing exactly `KV_SCHEMA` and delegating everything else, the same technique
`failingRollback` uses) and asserts that `close()` resolves, that the engine's own `close` ran, and
that a read afterwards still reports `StorageClosedError` rather than pretending the schema exists.
`sql-storage.ts` went from 98.55 / 100 / 95.65 to **100 on all four dimensions**.

The storage reading also settles an older argument by observation. That config file spent a long
section establishing that the two `} finally {` branch counters at `pg.ts:82` and
`sql-storage.ts:170` were a provider artefact rather than untested code. Under vitest 5 **neither
counter is emitted at all** — both files read 100 / 100 / 100 / 100 with no code change — which is
the second, independent confirmation that the original judgement was right. The one branch that
remains anywhere in the package is `sqlite.ts:47`, `if (this.db.open)`, whose false arm the public
API cannot reach: `BetterSqliteSession` is not exported and `SqlStorage.close()` calls it exactly
once. It is kept, because it encodes `SqlSession`'s documented idempotence at the engine boundary,
and documented rather than annotated away.

One case is worth recording from writing them: the first version of the "survives an agreement"
test used a *repeat on the invalidated slot* as the agreement, and it failed — because a repeat on
the same slot is a genuine agreement, and confirming it is correct behaviour. The test was wrong,
not the code, and the version that ships asserts the case the ordering comment actually claims:
agreement **elsewhere** in the batch.

## 4. The guard

`tools/dependency-advisories.json` holds the six rows with the advisory range verbatim, and
`tools/__tests__/test_dependency_advisories.py` (15 cases) parses `pnpm-lock.yaml` and asserts no
resolved version sits inside any of them.

The design decision worth defending is **range, not floor**. "At least the patched version" is what
a human applies and it is wrong in a decidable way: `source-map-js >= 1.0.0, < 1.2.2` says nothing
about 0.9, and `brace-expansion < 1.1.21` says nothing about 5.0.12, a different line entirely. So
the range is stored as text and parsed, and the parser is tested before it is trusted:

- `< 1.1.21` admits 1.1.18 and 1.1.20, rejects 1.1.21 and 1.1.22.
- `>= 4.0.0, < 4.3.2` admits 4.3.1, rejects 3.5.0 **and** 5.5.0 — both ends, not just the top.
- `>= 2.1.0-beta.7, < 4.1.12` admits 2.1.0 and 2.1.0-beta.9, rejects 2.1.0-beta.6. Prerelease
  ordering is the one semver rule that matters here; without it the lower bound would read
  `>= 2.1.0` and clear a version the advisory covers.
- `^1.2.3`, a bare `1.2.3`, and `1.0.0+sha` **raise**. A parser that treated an unknown operator as
  "probably fine" would report a vulnerable version as safe, which is worse than stopping.

Two properties the file asserts about itself, because a guard that cannot fail is a sentence about
an intent: a synthetic lockfile with `js-yaml 4.3.1` is caught and the message names both the
advisory and the patch, and a package that has vanished from the lockfile is reported rather than
forgiven — removing a dependency is a legitimate fix and also a way to make a guard vacuous by
accident.

## 5. What this does not do

**It is not `pnpm audit`.** A seventh advisory filed tomorrow leaves both this table and this test
green. That is the honest limit of an offline check; `pnpm audit` and Dependabot answer the other
question, and both need the network. What this file guarantees is that these six cannot regress.

**It does not claim the packages were exploitable.** All six are `development` scope. The two
vitest ones describe `@vitest/mocker` reading files on behalf of a mock the *test author* wrote, and
the three DoS ones need attacker-controlled input into a build-time parser. The reason to fix them
is not that a shipped artifact was vulnerable — it is that a lockfile with six open advisories
stops being evidence of anything, and the next person reads the alert list instead of the code.

**It does not restore the five "100%" claims to their old numbers.** They were measured by an
instrument that has been superseded. The numbers in the configs are now the ones this instrument
reports, and the difference is recorded rather than absorbed by changing a threshold.

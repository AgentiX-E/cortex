# The gate's own tests were writing to the tree the gate measures

**Found 2026-11-02, during a run of `pnpm check`.** A probe export that no test and no
commit had authored appeared in `packages/cortex-core/src/math/vector.ts`:

```ts
export function proseMentionedCensusGateProbe(): number {
  return 0;
}
```

The name is the harness's. `export-census-gate.test.ts` appends exports to that file to
prove `--check` reports a new orphan, and restores them in `finally`. The restore works.
The file was dirty anyway, and this document is about why "the restore works" was never
the property that needed to hold.

## 1. What the restore does and does not cover

Five sites injected into real source:

| test | file written | marker |
| --- | --- | --- |
| `fails when a new orphan appears, naming it` | `packages/cortex-core/src/math/vector.ts` | `orchestratedCensusGateProbe` |
| `detects a new orphan even when its name already appears in prose` | `vector.ts` + `math/fsrs.ts` | `proseMentionedCensusGateProbe` |
| `survives a tree with no .git` | `vector.ts` | `restoreIsByteLevel` |
| `still reports the new orphan through a pipe` | `vector.ts` | `pipedCensusGateProbe` |

Each ends with:

```ts
} finally {
  writeFileSync(victim, original);
  expect(readFileSync(victim, 'utf8')).toBe(original);
}
```

That is a correct restore, and it has its own regression test — `restores byte-for-byte
from memory, so no repository is required` — because the first version used
`git checkout --`, which fails at exit 128 in a tree unpacked by `git archive` and leaves
the export behind. The fix was right and the test for it is right. **The remaining failure
is not in the restore; it is in the assumption that a restore is the thing to test.**

## 2. Two ways to lose the race, and one of them happened here

### 2.1 Two processes on one checkout

The restore is scoped to one test in one process. It says nothing about what a second
process is doing to the same bytes:

```text
process A: read vector.ts        (original)
process B: read vector.ts        (original)
process A: write vector.ts       (original + probeA)
process B: write vector.ts       (original + probeB)
process A: write vector.ts       (original)          <- restore
process B: write vector.ts       (original)          <- restore
```

That interleaving is fine. The damaging one is:

```text
process B: write vector.ts       (original + probeB)
process A: write vector.ts       (original)          <- A's restore, before B's write landed
process B: write vector.ts       (original)          <- B's restore
```

also fine — until a third writer or an unequal number of tests. The version that produces
residue is the simplest one: **A restores the bytes it read before B's write landed, and B
never restores because B's assertion already ran.** Concretely, running a package suite
beside a full `pnpm check` — which is what a developer does while waiting for the first to
finish — is enough, and it is what happened here. Twelve `vitest` workers, each isolated
per file, and this file in two of them.

### 2.2 A run that never reaches `finally`

`SIGKILL`, an OOM kill, or a CI timeout does not run `finally`. The probe stays, and the
next thing that reads the file is the census gate itself, which then reports an orphan
nobody wrote — attributed to the ledger rather than to the harness. The repository has a
test timeout in this exact file for an unrelated reason (`41279597942` timed out at 5000 ms
on a slower runner), which is how close the two are.

### 2.3 Why the existing tests could not see it

They assert the state **inside** the process that made the change. A file that is dirty
because of *another* process, or because of a run that died, is a state no in-process
assertion reaches. The suite was proving "I put it back" while the question was "did you
put it back, and did anyone else touch it, and did the run before you get that far".

## 3. The repair: an injection needs a tree of its own

`tools/export-census.mjs` now takes `EXPORT_CENSUS_ROOT`, and the ledger follows it:

```js
const ROOT_OVERRIDE = process.env.EXPORT_CENSUS_ROOT;
const REPO_ROOT = ROOT_OVERRIDE ? resolve(ROOT_OVERRIDE) : resolve(HERE, '..');
const BASELINE_PATH = ROOT_OVERRIDE
  ? join(REPO_ROOT, 'tools', 'export-census-baseline.json')
  : join(HERE, 'export-census-baseline.json');
```

The script does not branch on which tree it is given: it walks `packages/` and `tools/`
under the root either way, and the census logic is untouched. What the override buys is
that a test can build a three-symbol tree, inject into **that**, and leave the checkout
read-only for the whole suite.

The fixture is seeded to reconcile exactly — `usedThing` has a caller, `orphanThing` is in
the seeded ledger — so each injection test keeps its positive control: the tree passes a
moment before it fails, and the failure is therefore the probe's. That control is stronger
than the one it replaced, which was implicit in a different test (`passes on the committed
tree`) passing earlier in file order.

The pipe test needed one more thing: its invocation ran `node tools/export-census.mjs` from
the working directory, and the fixture tree has no `tools/export-census.mjs` — the tool that
measures a tree is not part of the tree it measures. It now calls the script by absolute
path with `cwd` set to the fixture.

## 4. The assertion that distinguishes a working restore from a rewrite

The new test is one line of substance:

```ts
expect(statSync(WITNESS).mtimeMs).toBe(WITNESS_MTIME_BEFORE);
```

`WITNESS` is `packages/cortex-core/src/math/vector.ts` and its mtime is captured at module
load, before any test runs.

**Why mtime and not content.** A correct restore produces the original bytes, so a
content assertion passes whether the file was rewritten or never touched. mtime is the only
cheap signal that separates "restored" from "never written", and "never written" is the
property that survives concurrency and kills.

**Mutation-checked.** Pointing one injection back at the checkout makes it fail with the
two timestamps:

```text
AssertionError: expected 1793583993531.0159 to be 1793583680645.288
Tests  1 failed | 21 passed (22)
```

and the file's content is clean afterwards, which is the point: the restore still worked,
and the assertion still caught the write.

## 5. What this does not claim

- **Not a claim that the census numbers were wrong.** The probe was an orphan; the gate
  reported it; `--check` exited 1. The tree was dirty, not mismeasured. Every artifact in
  this repository predates the contamination.
- **Not a claim that the fixture is the repository.** The tests that assert something about
  *this* repository — `passes on the committed tree`, the baseline schema checks, the
  `bench/run.ts` caller tests — still run against `REPO_ROOT`. What moved is only the
  injection, because injection is the one operation that has to write.
- **Not a general defence against a dirty tree.** A tree can be dirty for reasons this
  change does not address. The claim is narrower: this suite no longer produces a dirty
  tree, and there is now an assertion that says so.

## 6. Acceptance

| property | criterion | how it is judged |
| --- | --- | --- |
| the checkout is never written | mtime unchanged after the full file | one assertion, on the file every injection used to target |
| no probe survives | four marker strings absent from the witness | the same test, four assertions |
| the gate still detects a new orphan | exit 1, names the symbol, names the file | `orchestratedCensusGateProbe` on the fixture |
| the matcher is still comment-blind | exit 1 with prose present | `proseMentionedCensusGateProbe`, with its positive control |
| the exit status survives a pipe | exit 1 through `cat` | `pipedCensusGateProbe` on the fixture |
| the baseline still reconciles this repo | exit 0, no new orphans | `passes on the committed tree`, unchanged |
| the override does not leak | a run without `EXPORT_CENSUS_ROOT` measures this checkout | every test that does not pass a root |

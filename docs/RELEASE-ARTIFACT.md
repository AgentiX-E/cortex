# The release artifact: what a stranger downloads, and the three things nobody had installed

**Status:** shipped. Five `tsconfig.build.json` files, one new guard (`tools/install-smoke.mjs`,
`guard:install`, **21 self-test assertions**), and one packaging defect removed: **821 compiled test
files**, which were 70% of the `cortex-memory` tarball and 45% of everything this repository publishes.

## 0. One paragraph

Every other check in this repository reads the **checkout**. `entry-guard.mjs` walks `src/` as text to
ask which specifiers a published entry can reach. `bundle-guard.mjs` bundles a subpath for the browser
and asks what a consumer's build pays. `manual:check` compiles the manual's examples against the built
declarations. None of them **installs** anything, and the three defects below are only visible from
the outside: a tarball that contains the test suite, source maps that name files the tarball does not
contain, and a `workspace:` protocol that `npm publish` does not rewrite. The first was found by
running `pnpm pack` for the first time in this project's history and listing what came out.

## 1. The defects, and which guard was supposed to see them

| defect | why every existing gate was silent | what a consumer received |
| --- | --- | --- |
| the compiled test suite ships | `files: ["dist"]` is true, and `tsc -p tsconfig.json` compiles `src/__tests__` into `dist/__tests__`. Every gate that looks at `dist` looked at the *entries*; none listed the *contents* | 821 files of assertions about `multi-session`, importing `vitest` and three packages the manifest declares as `devDependencies` |
| every source map is a dead end | `sourceMap` and `declarationMap` are on; `files` ships `dist` only, so each map's `sources` entry is `../src/x.ts`, which the tarball does not contain | a debugger that knows the line numbers and cannot find the file — worse than no map, because it looks like one |
| `workspace:*` reaches the registry | `pnpm pack` rewrites the protocol to a concrete version, so the local tarball is fine; `npm publish` from a workspace does not, and nothing in CI packs | a tarball npm refuses, or one that resolves a sibling package from the public registry by accident |

Two of the three are the same shape as the defects `AUDIT-PRODUCT-SURFACE.md` collects: **a property
that is true in the layer that was checked and assumed in the layer that was not.** `entry-guard`
proved the *source* is clean, and the published artifact is not source.

## 2. What was in the tarball, counted

`pnpm pack` for each of the five published packages, in three states: the `dist` as it stood when this
round began (**as found**), a clean rebuild of that same code with the old command (**clean**), and the
shipped configuration (**after**).

| package | files as found | tests | clean | tests | after | tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `cortex-core` | 277 | 3 | 366 | 172 | 146 | 0 |
| `cortex-storage` | 102 | 44 | 114 | 60 | 41 | 0 |
| `cortex-ai` | 209 | 59 | 222 | 104 | 89 | 0 |
| `cortex-eval` | 699 | 333 | 1,030 | 664 | 275 | 0 |
| `cortex-memory` | 547 | **382** | 701 | **540** | 122 | 0 |
| **total** | **1,834** | **821** | **2,433** | **1,540** | **673** | **0** |

| state | bytes | of which tests |
| --- | ---: | ---: |
| as found | 3,389,897 | 821 files |
| clean rebuild | 3,964,838 | 1,540 files |
| after | **3,337,596** | **0** |

**The middle column is the finding, not a footnote.** The same source, packed twice, differs by
**599 files and 575 KiB** — because `build` was `tsc -p tsconfig.json` with `incremental: true`, so the
published artifact was a function of *what had been built before it* rather than of the commit. The
numbers in the first column are the state that had accumulated; the second is what a fresh checkout
would have published. A release artifact that cannot be described without its build history is the
same defect class as an arm that cannot be described without its dispatch history, and this repository
already refuses the second (`docs/DESIGN-ARM-ADOPTION.md`).

The byte totals barely move — **−1.5%** from as-found, **−15.8%** from a clean rebuild — and that is
the other half of the reading. Removing 1,540 files bought almost nothing in bytes, because
`inlineSources` fills each surviving `.js.map` with the source text it maps. So the defect was never
the download size:

> The package was not too big to publish. It was too big to **read**: a consumer auditing a dependency
> tree found assertions about this library's internals in their production install, and a
> `devDependency` on `vitest` arriving through the back door with no declaration that would let them
> refuse it.

## 3. The fix, and why a build config rather than a `files` negation

`files: ["dist", "!dist/__tests__"]` was the first instinct and it is the wrong one: the negation is
implemented by the packer, this repository packs with `pnpm`, and a rule that depends on which packer
runs is a rule that stops holding when the release path changes. The defect is that **the compiler
emits tests into the published tree**, so the repair is at the compiler.

Each package now has a `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "inlineSources": true, "declarationMap": false },
  "exclude": ["src/__tests__/**", "src/**/__tests__/**"]
}
```

and `build` is `rm -rf dist tsconfig.build.tsbuildinfo && tsc -p tsconfig.build.json`. Three decisions
inside that line:

1. **The clean is not tidiness.** `incremental: true` means a second build trusts a `.tsbuildinfo`, and
   a `dist/__tests__` left by an earlier build is still on disk and still inside `pnpm pack`'s view. A
   build whose output depends on what was there before is a build whose artifact cannot be described.
2. **`declarationMap` is off rather than shipped.** `inlineSources` fills a `.js.map` with the source
   text; it does **not** do that for a `.d.ts.map`, which keeps pointing at `../src/x.ts`. A declaration
   map that cannot be made honest is refused, so an editor following "go to definition" lands on the
   `.d.ts` — the published type — instead of a missing file.
3. **`tsconfig.json` keeps the tests.** `typecheck` still runs `tsc -p tsconfig.json --noEmit` over
   `src` including `__tests__`, so nothing stopped being type-checked; only the *emit* is narrowed.

## 4. The guard: four questions, and only the fourth is about the product

`node tools/install-smoke.mjs` packs all five packages, then:

| kind | what it reads | what it proves |
| --- | --- | --- |
| **inventory** | the tarball, not `package.json` | no `__tests__/` path, no `*.test.js`, `dist/index.js` present, every `exports` target resolves inside the tarball, no `.d.ts.map`, every `.js.map` carries one `sourcesContent` entry per source |
| **manifest** | the **packed** `package.json` | no `workspace:` in any of the four dependency fields |
| **install** | a temporary project whose only dependencies are the tarballs, by `file:` | the resolution a stranger gets. A runtime dependency declared as `devDependency` fails here and nowhere else, because `pnpm -r build` resolves through the workspace |
| **quickstart** | the installed product, asked one question | `assembleMemory` defaults to the `reader` profile, the room table is the registered one (`multi-session` 48,460; the other five 24,000), four appended turns come back as four, the memory returns the reader's own sentence, and the delivered prompt contains the evidence and the shipped multi-session block |

The fourth row is the one that ties this document to the accuracy record, and it is the only check in
the repository that says **the installed artifact renders the registered arm**:

```
quickstart: profile=reader turns=4 promptChars=2675 multi-session room=48460
tarballs: 5 packages, 673 files, 3259 KiB
```

`promptChars=2675` for a four-turn corpus is the registered rendering, not a fixture of it: the
three literals the check pins — the evidence (`Lisbon`, `Berlin`) and the instruction block
(`Work in two steps.`) — are asserted on the **delivered** prompt. A rendering change now arrives as a
red check and a person decides whether it is an adoption or a regression, which is the property
`MEASURE-PROMPT-IDENTITY.md` established for the benchmark artifact, applied to the package.

## 5. The mutations that prove the guard can fail

`--self-test` is hermetic (six fixtures, no network, no tarball) and asserts **21** things. Each
mutation has to turn **exactly one** rule red — a check that fires for the wrong reason is a failure,
not a pass with noise:

| fixture | rule that must fire |
| --- | --- |
| a `dist/__tests__/index.test.js` entry | `tests-shipped` |
| a `dist/thing.test.js` entry outside `__tests__` | `test-file-shipped` |
| an `exports` target with no file behind it | `export-target-missing` |
| a map with `sources` and no `sourcesContent` | `map-not-self-contained` |
| a `workspace:*` dependency | `workspace-protocol` |
| a shipped `.d.ts.map` | `declaration-map-without-source` |
| a quickstart reading with the wrong profile, count, reply, prompt or room | `quickstart-failed`, one per mutation |

The live mutation is the one that matters, because a fixture proves the predicate and not the
pipeline. Restoring `cortex-memory`'s old build command (`tsc -p tsconfig.json`), rebuilding from an
empty `dist` and re-running the guard produced **890 findings in three rule families** on that one
package — `tests-shipped` x540, `declaration-map-without-source` x175, `map-not-self-contained` x175,
exit 1 — every one of them a file that had no business in a published tarball. Rebuilding the package
with its own script returned the run to **zero findings**, which is the pair that makes the reading
evidence rather than a demonstration.

The counts are also a third measurement of the same defect: 540 test files on a clean build of
`cortex-memory` against the 382 that the as-found `dist` contained, which is the incremental-emit
variance §2 reports, arriving through a different instrument.

## 6. What this document does not prove

1. **It does not prove the packages install from the registry.** `pnpm pack` + `file:` is the closest
   approximation available without publishing, and it is a *good* approximation for four of the five
   rules — but `pnpm publish` runs a different packer over a different manifest than `npm publish`, and
   the difference is exactly the `workspace:` rewrite this guard checks the *result* of rather than the
   behaviour of.
2. **It does not prove a native peer resolves.** `better-sqlite3` and `pg` are optional peers and the
   probe installs with `--ignore-scripts`, so a broken prebuild is out of scope. The backend parity
   suite is where that lives.
3. **It does not prove the browser path.** `guard:browser` and `guard:bundle` cover the subpaths; this
   check imports the root plus the probe's own `Storage`, which is a `Map`.
4. **It does not prove an upgrade.** Nothing here installs version *n* and then version *n+1* over it.
5. **It does not make the numbers comparable to the benchmark.** `promptChars=2675` is a four-turn
   corpus; it proves the rendering reaches the artifact, not that the arm scores anything.

## 7. Where the rest of the release questions live

| question | answered by |
| --- | --- |
| does the entry reach a native module or an ONNX runtime | `tools/entry-guard.mjs` |
| what does a browser subpath cost, and does a bundler emit its worker | `tools/bundle-guard.mjs` |
| are the manual's examples true, and are its option tables complete | `pnpm manual:check` |
| does the installed package answer a question with the registered arm | `tools/install-smoke.mjs` (this document) |
| is the arm that ships the arm that was measured | `docs/DESIGN-ARM-ADOPTION.md`, `registered-arm.test.ts` |

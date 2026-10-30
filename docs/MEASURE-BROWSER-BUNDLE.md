# MEASURE — the browser boundary: what a bundler does to the published subpaths

> Tools: `tools/bundle-guard.mjs` (static, in `pnpm check`), `packages/cortex-storage/test/browser/bundle-probe.mjs`
> (runtime, real Chromium). Readings below from Chromium 144 on Linux, esbuild 0.28.2, `pnpm build` at
> `cortex-storage@0.1.0`.

## Why this measurement exists

Two of the four gates standing between this repository and a release statement are about the browser axis, and
neither could be closed by any test that imports `src/`. The existing `tools/entry-guard.mjs` walks sources as
text and answers a _different_ question well: can a portable entry reach a native module. That walk cannot see
`exports` pointing at a file `tsc` never wrote, cannot see what a browser build pulls in through a dependency,
and cannot see what the user pays in bytes. All three are properties of the published artefact.

So the gate is two instruments and the second one is the one that found something.

## Instrument 1: `tools/bundle-guard.mjs`

Bundles every subpath in `package.json#exports` with esbuild, once per **declared platform** — the platform is
data in the tool, not inferred from whether the build succeeds, because inferring it would turn a portability
regression into a silent reclassification. A subpath with no declared platform fails the run, so a new backend
cannot arrive without someone deciding what building it means.

| subpath         | platform | gzip (minified) | baseline | reaches                                     |
| --------------- | -------- | --------------: | -------: | ------------------------------------------- |
| `.`             | browser  |              20 |       20 | — (root is `export {}`, and stays free)     |
| `./idb`         | browser  |           1,349 |    1,349 | —                                           |
| `./opfs`        | browser  |           3,813 |    3,813 | —                                           |
| `./opfs/worker` | browser  |           1,273 |    1,273 | —                                           |
| `./pg`          | node     |           1,105 |    1,105 | — (the driver is an injected `Pool`)        |
| `./sqlite`      | node     |           7,037 |    7,037 | `better-sqlite3`, expected on this platform |

Two facts in that table are worth more than the bytes.

**`./pg` bundles for the browser and is still Node-only.** Its `pg` import is type-only, so the emitted adapter
carries no client and costs 1 KB; a consumer who reads "bundles for browser" as "works in a browser" gets a
PostgreSQL connection that cannot open a socket. The manifest therefore declares `node` for it, and the tool
prints the successful bundle anyway. Portability and usability are different claims.

**`./opfs` does not emit its worker.** The guard reports:

```
worker: ./opfs-worker.js NOT emitted -- the consumer must copy it or pass workerUrl
```

## The claim that was wrong, and what it cost

`openOpfsStorage` defaults its worker to `new URL('./opfs-worker.js', import.meta.url)`. Its docstring said
`import.meta.url` "is rewritten by Vite, webpack 5 and esbuild". **Two of those three are true.** Vite and
webpack 5 have first-class worker handling; esbuild has none, so the expression survives into the consumer's
output verbatim and names a file the bundler never wrote. The failure is a 404 at runtime, and its symptom is a
worker that never speaks.

Instrument 2 measured what "never speaks" looks like to a caller, and the answer was worse than a 404:

| check (real Chromium, esbuild output served as a module) | reading                                               |
| -------------------------------------------------------- | ----------------------------------------------------- |
| default worker URL, bundled                              | **fails with an empty message** (`RpcError: ""`)      |
| explicit `workerUrl` at a `./opfs/worker` second entry   | opens `opfs` on `sqlite-wasm 3.54.1` / `opfs-sahpool` |
| `openBrowserStorage` with the same `workerUrl`           | picks `opfs`, `refused: []` — no silent fall-back     |
| 200 rows through the bundled worker                      | digest `2868196997` read back in 97 ms                |

The empty message is a defect in its own right. Chrome dispatches a plain `Event` — not an `ErrorEvent` — for a
module script whose fetch 404s, so `event.message` is `undefined`; the handler tested `=== ''`, `undefined`
passed through, and `new Error(undefined)` reached the caller with nothing in it. On the one path the
surrounding comment warns about. `RpcError` now names the URL, quotes the browser's message when there is one,
and otherwise says which bundler situation produces this:

```
the storage worker failed to start: http://…/bundle/opfs-worker.js -- the module did not load (a bundler that
does not emit worker assets needs `workerUrl`, see the `@agentix-e/cortex-storage/opfs/worker` subpath)
```

## The two supported deployments, now written down and measured

| deployment | worker source                                                       | what it costs the consumer                    |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------- |
| unbundled  | `./dist/browser/opfs-worker.js` next to the module                  | nothing: the default URL resolves             |
| bundled    | `@agentix-e/cortex-storage/opfs/worker` as a **second entry point** | one build entry, then `workerUrl: new URL(…)` |

`./opfs/worker` did not exist before this iteration. Copying `opfs-worker.js` out of `node_modules` was never
sufficient — it imports `./rpc.js` — and there was no supported way to obtain the worker as a bundleable unit.

## The tests, and the injections that prove they bite

- `tools/__tests__/test_bundle_guard.py` (new, 8): the package bundles for every declared platform; the worker
  line reaches the report; a shrunken baseline fails the run and names the overspend; a subpath with no declared
  platform is refused with the subpath in the message; the self-test's six cases pass; the JSON reading carries
  `platform`, `workerAssets` and `forbidden` per entry; the baseline records every subpath; a missing baseline is
  reported rather than skipped.
- `tools/bundle-guard.mjs --self-test` (6 cases): a browser-clean entry bundles; a `node:` builtin is refused by
  the browser platform; a native addon that **resolves** is named; a subpath whose file is absent is refused; a
  worker URL survives and is reported as not emitted; a clean entry reports no worker.
- `packages/cortex-storage/src/__tests__/opfs-startup.test.ts` (new, 6): the empty-message defect and the two
  shapes a 404 arrives in across engines; a message the browser did provide is kept verbatim; the timeout says
  how long and where; the worker is terminated on every failure path; the sqlite/db/pool parameters reach the
  worker URL.
- Injection: restoring the `event.message === ''` handler fails **4** of those 6. Raising the `./opfs` budget by
  the new error text (+127 gzip bytes, +3.4%) fails the budget row — which is why the baseline was rewritten
  deliberately in the same commit rather than silently.

## What this closes, and what it does not

Closes `§10.2` gate 1: the size guard is green **and** in `pnpm check`, the browser subpaths resolve and bundle
in a real bundler, and the bundled artefact opens the tier in a real browser with a round trip that survives.

Does not close gate 2 (a second browser engine) or gate 3 (the false-share upper bound). It also does not claim
that Vite or webpack 5 work: neither was run here, and the docstring that used to assert they do was corrected
rather than re-asserted from memory.

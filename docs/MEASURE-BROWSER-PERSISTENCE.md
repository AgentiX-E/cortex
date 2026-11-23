# MEASURE — the second engine: OPFS persistence across a restart, on Chromium **and** Firefox

> Tools: `packages/cortex-storage/test/browser/probe.mjs` (Chromium), `…/probe-firefox.mjs` (Firefox),
> both driven by `…/restart-suite.mjs` through `cdp.mjs` / `bidi.mjs`. Readings below at 2,000 rows,
> `cortex-storage@0.1.0`, Chromium and **Firefox 159.0** on Linux. Raw output:
> `test/browser/last-run.json`, `test/browser/last-run-firefox.json` (both committed).

## Why this measurement exists

`§10.2` gate 2 asks whether the browser tier's persistence reproduces on **at least two engines**. The
thing that can fail is `FileSystemSyncAccessHandle`, and a second Chromium profile cannot exercise a
second implementation of it: same VFS, same SQLite build, same bug surface, same quota accounting. Two
Chromium profiles agreeing would prove the suite is deterministic, not that the contract holds.

So the suite was split rather than duplicated. `restart-suite.mjs` owns the whole four-phase flow —
matrix, deterministic write, **restart**, read, digest compare — and an engine supplies one thing:
`open(origin)`, which launches a browser, navigates, waits for `window.__ready`, and returns
`{ evaluate, close }`. Which modes run, how many rows, whether the digest matches, and the 24th check
are therefore *not* per-engine code. A second probe that reimplemented the flow would eventually
disagree with the first about something that is not the engine — the row count, the digest function, or,
the silent one, whether the second launch reused the **origin**. OPFS is per-origin storage: a second
launch on a fresh port reads an empty database and passes.

## The reading

| # | criterion                                       | Chromium (CDP)                                    | Firefox 159 (BiDi)                                 |
| - | ----------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| 1 | the tier obtained                               | `opfs`, `refused: []`                             | `opfs`, `refused: []`                              |
| 2 | the engine string                               | `sqlite-wasm 3.54.1 on opfs-sahpool (journal: delete)` | **identical**                                  |
| 3 | checks                                          | **24 / 24**                                       | **24 / 24**                                        |
| 4 | the 24 names                                    | —                                                 | **identical in order and in string**               |
| 5 | 2,000 rows after a browser restart              | digest `4000247205`, `matches: true`              | digest `4000247205`, `matches: true`               |
| 6 | commit-per-row                                  | 120,444 ms (17 rows/s)                            | 124,949 ms (16 rows/s)                             |
| 7 | one transaction over the same 2,000 rows        | 208 ms (9,625 rows/s)                             | 270 ms (7,407 rows/s)                              |
| 8 | read back                                       | 15.8 ms                                           | 15.0 ms                                            |

Row 5 is the claim gate 2 was making: two engines, two implementations of the sync-access-handle, two
storage backends underneath, the same 2,000 rows in the same order and the same **integer**. The digest
is FNV-1a over `JSON.stringify` of the rows in query order — pure integer arithmetic with no engine
surface — so "same rows, same order" implies "same integer". It was registered at exactly `4000247205`
*before* the Firefox run, which is what makes the agreement a reading rather than a fitted one.

Rows 6–8 are **not** criteria. They move ~15% between two runs of one engine on this host, and across
engines there is nothing to compare: the surfaces are a different WASM compile and a different VFS
implementation. A gate on them would fire on a legitimate run (`§11.4`).

## The protocol defect that cost the first run, and why it is now tested without a browser

The first Firefox attempt died three lines into the **shared** module:

```
TypeError: Cannot read properties of undefined (reading 'hash')
    at runRestartSuite (restart-suite.mjs:40:42)
```

OPFS on Firefox was fine and had never been asked. The cause is in the wire format:

> WebDriver BiDi does not send an object as an object. `script.evaluate` returns
> `{ type: 'object', value: [ ['hash', { type: 'number', value: 4000247205 }], … ] }` — an ordered list
> of `[key, RemoteValue]` pairs, and an array as `{ type: 'array', value: [RemoteValue, …] }`.

`evaluate` returned `outcome.result.value`, so the restart suite held an array of pairs where it expected
`{ digest: { hash } }`. A live round trip settled the three shapes a reader would otherwise guess, and one
of the guesses is wrong in the quiet direction:

| expression                | wire                                                              | naive `.value` gives |
| ------------------------- | ----------------------------------------------------------------- | -------------------- |
| `({ a: 1 })`              | `{type:'object', value:[['a',{type:'number',value:1}]]}`          | `[['a', …]]`         |
| `NaN`                     | `{type:'number', value:'NaN'}`                                    | the **string** `'NaN'` |
| `-0`                      | `{type:'number', value:'-0'}`                                     | `'-0'` — and `0` after any JSON hop |
| `undefined`               | `{type:'undefined'}` — no `value` field at all                    | `undefined` (correct by luck) |

The conversion is `deserialize` + `valueOf` in `bidi.mjs`; `evaluate` is now six lines of transport. The
branch that was wrong is covered **without a browser**, which is the only way it can be covered on a host
without Firefox:

- `bidi.mjs --self-test` — 8 cases, fixtures transcribed from the live round trip: a number; the pair
  list; an array with a null; `undefined` (and that the key still survives); the four numbers JSON cannot
  carry; an object with no pairs; a nested pair list inside an array; an exception. `8 passed, 0 failed`.
- `tools/__tests__/test_bidi_deserialize.py` — 4 tests inside `pnpm check`: the self-test passes, every
  case is reported **by name**, importing the module runs no test, and a **mutation** that reverts the
  object branch to `return remote.value;` fails by name (`4 passed, 4 failed` — the four cases whose
  result is an object).

Two more facts paid for along the way, recorded where they are needed: `browsingContext.getTree` was
refused on Firefox 159 with *"System access is required. Start Firefox with the
MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1"*, so the tab id is exposed as a read-only accessor
(`connection.context`) instead of rediscovered — **and on Firefox 132 that refusal does not happen**,
which is what made the CI job below possible; the self-test guard cannot be `argv[1].endsWith('bidi.mjs')`,
because a mutation fixture under another name would then skip the test — it is
`import.meta.url === pathToFileURL(argv[1]).href`.

## Engine differences the suite deliberately does not depend on

| surface            | Chromium                                          | Firefox                                            |
| ------------------ | ------------------------------------------------- | -------------------------------------------------- |
| a 404'd module import | `Failed to fetch dynamically imported module`   | `error loading dynamically imported module`        |
| handshake path     | `/json/new` over HTTP, then CDP on the socket      | BiDi only, and the upgrade path is **`/session`**  |
| `WebDriver BiDi listening on ws://host:port` | —                                       | that URL answers `200 OK` with an `httpd.js` page  |

The first row is why the fallback check asserts that a refusal is **reported**, not what it says. The
third is the trap worth an hour of anyone's afternoon: the printed URL is the HTTP endpoint, the upgrade
is one segment down, and the failure reads `non-101 status code` — like a handshake bug, actually a path
bug. `curl` cannot settle it either (GET returns `200`, POST returns *"the handshake request must use GET
method"*).

## What this closes, and what it does not

Closes `§10.2` **gate 2**: persistence on two engines, 24/24 each, one digest, one commit.

Not closed by it:

- **gate 3** (false-share upper bound ≤5%) needs a corpus and a reader, not a browser;
- **gate 4** (a LongMemEval reading with run id, configuration row and per-question records) is the
  accuracy campaign's own output;
- **Safari/WebKit** — its OPFS has no persistent profile in the session model this suite uses, so a third
  engine needs a real device; that stays a listed boundary, not a gap;
- **multi-tab concurrency, private browsing, quota exhaustion** — none is exercised by either probe;
- **that Firefox is supported as a product.** Obtaining the tier and surviving a restart is the API
  contract. Quota behaviour, eviction order and sync-handle contention across many tabs are a different
  sentence with a different measurement.

## The reading reproduces on a second Firefox build — and the harness could not have said so

The reading above was taken by hand on Firefox 159. Nothing re-derived it: `git grep firefox
.github/workflows` returned nothing until this section existed, so gate 2's evidence was a file whose
only consumer was `guard:browser` — which compares it to the **Chromium** reading. Two committed
artefacts agreeing with each other prove the two engines agree about a tree neither of them had to
describe.

Making it a job needed one fix in the harness first, and the failure was a hang rather than a message:
on the Firefox that `npx --yes playwright@1.49.1 install firefox` provides (132.0, playwright build
1466), `browsingContext.create` is answered with **nothing at all** — no error, no reply — so
`start()`'s await never settled and the probe sat there until the job's timeout. `session.new` and
`browsingContext.getTree` on the same build both answer in well under a second. `start()` now reuses
the session's own tab, which is the shape WebDriver BiDi is designed around (`session.new` is followed
by a context that already exists) and keeps `create` as the fallback for an engine that reports none.

The reading it produces, at 10 rows locally and 400 rows in CI:

| criterion | committed reading (Firefox 159) | fresh run (Firefox 132) |
| --------- | ------------------------------- | ----------------------- |
| checks | 24 / 24 | **24 / 24** |
| the 24 names | — | **identical in order and in string** |
| the tier | `opfs`, `refused: []` | `opfs`, `refused: []` |
| the digest after a restart | `matches: true` | `matches: true` (`1489868687 == 1489868687` at 10 rows) |

So gate 2's claim survives a 27-version gap between the build the reading was taken on and the build
that now reproduces it, and there is a job that keeps asking.

## Where this runs now

The readings above were taken by hand. The two comparators need no browser, which is why they gate
every push; the runs happen where a browser exists.

| where | asserts | browser |
| ----- | ------- | ------- |
| `pnpm check` → `guard:browser` | the two **committed** readings run the same 24 checks, same order, same strings, both `opfs`, both digest-matched | no |
| `Verify` job `browser` | the suite still passes on a real Chromium at 400 rows, and `last-run.json`, `corpus-run.json` **and** `bundle-run.json` still describe the tree | Chromium |
| `Verify` job `browser-firefox` | the suite still passes on a real Firefox at 400 rows, and `last-run-firefox.json` still describes the tree | Firefox |
| both browser jobs → `tools/readings-in-place.mjs` | the suites changed no tracked file, so no reading was regenerated in place | Chromium, Firefox |
| `tools/__tests__/test_browser_reading_check.py` (11) | the comparator bites: renamed check, dropped check, `idb` reading, unread digest, missing argument, a bundle reading whose tier or round-trip digest disagrees, and the verdict naming both files instead of "the tree" | no |
| `tools/__tests__/test_readings_in_place.py` (4) | the checkout assertion bites: ignored build output passes, a rewritten reading is named with the variable that prevents it, a new file counts, a non-repository fails with a reason | no |

Two of those rows exist because of what the third one could not say. `guard:browser` runs no browser,
so its verdict names the two files it read (`…/last-run-firefox.json agrees with …/last-run.json`)
rather than claiming the tree; and `bundle-run.json` — the only evidence for the `workerUrl` contract,
whose first check quotes the product's own refusal text — was compared by nothing at all until the
reader learned that this reading records its tier at `facts.tier` and its digest as
`facts.roundTrip.written == .read`, because it runs once and has no phase to stage a restart in.

`CORTEX_RESULTS` (restart probes) and `CORTEX_RESULTS_BUNDLE` (the bundle suite) exist so a CI run writes its own
reading instead of overwriting the committed evidence — one shared variable let the bundle reading clobber the restart
one, and the comparison then read 24 checks against 4.

## The set, not only these four

Everything above is about four files, and each was found by someone reading. Four identical defects found
by reading is an argument that the fifth is not findable that way, so the question was generalised:
**for every committed reading, what turns these bytes into a fact again?** The answer is required, in
`tools/committed-readings.json`, for all 23 JSON files this repository commits under a test directory,
and `pnpm readings:check` refuses the three ways a row can be wrong:

| kind | the row has to carry | refused when |
| ---- | -------------------- | ------------ |
| `recomputed` | the job and workflow that re-run it | the job does not exist, does not name this file, or never names a path outside the checkout |
| `one-shot` | the SHA-256 of the bytes that were measured | the file no longer hashes to it |
| `input` | a reason, and nothing else | no tracked `.ts`, `.mjs` or `.py` names it |

The four browser readings are the `recomputed` rows. `docs/COMMITTED-READINGS.md` is generated from the
same record and lists the other nineteen with their reasons: the parity run needs two Xenova models from
a mirror, the profile and echo readings are timings and belong to a host, the three `mr-census` readings
need a 62 MB benchmark artefact that is not in this repository.

One of the nineteen is the finding. `mr-roster-38953157688.json` was committed so that `§13.40`'s table
could be re-derived without the artifact store, and **no test read it** — the only mention anywhere was a
comment in `tools/classify-raw-outputs.py`. The `input` row is what surfaced it on the check's first run,
and the repair was the test that re-derives `33 abstain / 30 plan_output` from it. A row that only says
"this is an input" would have been a rubber stamp; requiring something to *name* the file is what makes
the kind worth having.

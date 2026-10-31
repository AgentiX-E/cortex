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

Two more facts paid for along the way, recorded where they are needed: `browsingContext.getTree` is
refused with *"System access is required. Start Firefox with the MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1"*, so
the tab id is exposed as a read-only accessor (`connection.context`) instead of rediscovered; and the
self-test guard cannot be `argv[1].endsWith('bidi.mjs')`, because a mutation fixture under another name
would then skip the test — it is `import.meta.url === pathToFileURL(argv[1]).href`.

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

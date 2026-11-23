# A second tab is a second database, unless something says otherwise

**Status:** implemented (`packages/cortex-storage/src/browser/writer-claim.ts`,
`src/browser/open-policy.ts`, `test/browser/two-tab-probe.mjs`)
**Amends:** `MEASURE-BROWSER-PERSISTENCE.md` §"What this closes, and what it does not", which listed
multi-tab concurrency as an unexercised boundary. It is exercised now.

## 1. What a user does, and what the product did

Open the app. Open it again in a second tab.

The first tab holds the OPFS access handle for `/cortex.sqlite3`. The second tab's SAH-pool install fails —
`Access Handles cannot be created if there is another open Access Handle or Writable stream associated with
the same file` — and `openBrowserStorage` treated every reason alike, so it fell through to IndexedDB.

| tab | tier | where its rows go |
| --- | --- | --- |
| first | `opfs` | `/cortex.sqlite3` in the origin's OPFS pool |
| second | `idb` | an IndexedDB database, same origin, **different place** |

Both tabs work. Neither is wrong on its own. The user's memory is in two places, and the only field that
says so is `refused[0].reason` — a sentence belonging to sqlite-wasm, which no caller has a rule for reading.
That is the failure this round removes, and it is the same shape as the four product-side defects audited in
`AUDIT-SEMANTIC-REACH.md`: **a mechanism that produces no error, only silence.**

## 2. Why the reason can't be classified

`opfs-worker.ts` already refuses to inspect message text, and says why: the retry that recovers from
*"handles released asynchronously"* does not look at the message, because its wording belongs to
sqlite-wasm and moves between releases. A classifier here would be the same mistake one layer up, and it
would be a classifier over the one string that decides whether a second database is created.

So the question is asked **before** any tier is tried, using the platform's own facility.

## 3. The mechanism

```
openBrowserStorage
   ├── validate sqliteModuleUrl        (a caller's bug, reported as one, claim or no claim)
   ├── claimWriter({ pool })           ← navigator.locks, ifAvailable
   │        └── refused && onSecondTab === 'refuse'  → BrowserStorageBusy, no tier opened
   ├── openClaimedStorage              ← source/browser/open-policy.ts, measured in Node
   │        ├── tiers in order
   │        └── all failed → release the claim, then report
   └── storage.close()                 → releases the claim
```

`navigator.locks.request(name, { ifAvailable: true }, callback)` is the whole mechanism: the lock is held
while the callback's promise is pending, the callback is invoked with `null` when somebody else holds the
name, and the platform releases it when the tab goes away — which is exactly a writer's lifetime.

Three answers, because two would lie:

| `writer` | meaning |
| --- | --- |
| `{ acquired: true, mechanism: 'web-locks' }` | this context holds the origin |
| `{ acquired: false, mechanism: 'web-locks' }` | somebody else does — only reachable under `onSecondTab: 'allow'` |
| `{ acquired: true, mechanism: 'none' }` | nobody can be asked: no `navigator.locks` on this platform |

## 4. The reading

`test/browser/two-tab-probe.mjs`, two Chromium targets, one user-data-dir, one origin, HTTP on
`127.0.0.1`. Eight checks, all green; the committed artifact is
`packages/cortex-storage/test/browser/two-tab-run.json` and CI re-derives and compares it.

| # | check | verdict |
| ---: | --- | --- |
| 1 | tab 1 opens OPFS and claims the origin | `opfs`, `acquired: true`, `web-locks` |
| 2 | tab 1 wrote the row a later tab must find | `marker` |
| 3 | tab 2 is refused by name, on the claim | `BrowserStorageBusy`, `pool: 'cortex'` |
| 4 | the refusal names the pool and the option that changes it | message quotes `"cortex"` and `onSecondTab` |
| 5 | tab 2 with `allow` proceeds and reports a shared origin | `acquired: false` |
| 6 | **the allowed tab does not see the first tab's row** | `read: null`, tier `idb` |
| 7 | tab 1 releases the origin on close | `closed: true` |
| 8 | tab 2 then opens OPFS and reads tab 1's row | `opfs`, `read.v === 42` |

Check 6 is the one that makes the refusal defensible: it is the divergence, measured, rather than warned
about. Check 8 is the one that makes the release real: without it, "refused" and "released" would both look
like success.

### The bug this reading found, in this round's own code

The first run reported `mechanism: 'none'` in a Chromium that has Web Locks. `claimWriter` distinguished
"field absent" from "field present and `undefined`" with `'locks' in args`, and `openBrowserStorage` always
passes the field it was given — so the platform was never asked, every tab claimed successfully, and tab 2
was refused by nothing and diverted to IndexedDB exactly as before.

The Node suites could not catch it: each of them either hands a manager over explicitly or calls
`claimWriter` without the key at all. The untested seam was the **wiring between the two modules**, and only
a real browser crossing it could see it. `??` replaced the `in` test; the docstring on the option now says
that `undefined` means "ask the platform" rather than "there is no platform".

## 5. Where the decision lives, and why it moved

`src/browser/opfs.ts` is excluded from the Node coverage number (`vitest.config.ts` says why, correctly:
`Worker`, OPFS and IndexedDB do not exist in Node and a shim would assert the shim). The policy this round
adds needs none of them, so leaving it there would have meant writing tests into an exclusion — the version
of "we cannot cover it" that is really "we put it in the unmeasured file".

`src/browser/open-policy.ts` now holds the ordering (claim → tiers → release) and takes the tier openers as
a parameter. It reads **100 / 100 / 100 / 100**, and `opfs.ts` keeps the platform glue. The seam used by the
tests (`OpenBrowserOptions.openers`) is documented as a seam, not as configuration.

## 6. What the defaults are, and what a caller can choose

| option | default | why |
| --- | --- | --- |
| `onSecondTab` | `'refuse'` | the alternative is silent: two tabs, one origin, two sets of rows |
| `poolName` | `'cortex'` | the same literal the worker installs the pool under; `pool-name.test.ts` reads both files and fails if they drift |

`refuse` throws `BrowserStorageBusy` **before** any tier opens, so a second tab neither spends the pool's
four-install retry budget nor classifies an error. `allow` proceeds and reports `acquired: false`, which is
the honest description of what it got: a second database, not a second view.

## 7. What this does not claim

- **Not a multi-tab feature.** There is no cross-tab synchronisation, no leader election beyond the claim,
  and no `onSecondTab: 'wait'` — a page that blocks its first render on another tab's lifetime is a page
  that appears frozen. The claim makes a second writer *visible*; it does not make two writers safe.
- **Not measured on Firefox.** Firefox's BiDi cannot create a second browsing context on the build this
  suite has (132, `MEASURE-BROWSER-PERSISTENCE.md`), so two tabs cannot be driven there. The claim is
  platform-level (`navigator.locks`), and Firefox has it since 96, but that is a fact about the API, not a
  reading of this product on that engine.
- **Not a quota measurement.** Quota exhaustion and private-browsing behaviour remain unexercised, and they
  remain listed as boundaries rather than being quietly dropped.
- **Not a claim about Safari.** Its OPFS has no persistent profile in this suite's session model, which is
  the same boundary the persistence reading already records.

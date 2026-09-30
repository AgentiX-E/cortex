# AUDIT-CONSOLIDATION-CLOCK

**Scope:** `consolidate` — the module that decides which memories Cortex forgets —
and the FSRS state it consults.
**Verdict:** a **wrong unit**, not a wrong constant. With the shipped defaults,
`consolidate` **deleted every memory in the store on its first run**, including
memories created milliseconds earlier and never accessed. The forgetting threshold
was reachable only because stability is measured in milliseconds, where `1` means
"one millisecond of durability".
**Found while** scoping the `cortex-memory` seam (`AUDIT-CODE-VS-DOCS.md` §6.2),
not while looking for it. `consolidate` has no production caller, which is both why
the defect survived and why the seam scoping is the thing that surfaced it.
**Measured at revision** `9035011`. Fixed as part of this change.

---

## 1. The measurement

Before any change, against the built output:

```
retrievability(1000, 1)  = exp(-1000) = 0        // one second after creation
retrievability(5,    1)  = exp(-5)    = 0.0067   // five milliseconds
```

`consolidate` defaults `forgettingThreshold` to `0.01` and deletes every memory
whose retrievability is below it. Since `exp(-5) < 0.01`:

```js
const memories = new Map();            // 10 freshly created memories, zero accesses
for (let i = 0; i < 10; i++) { ... }
consolidate(memories, new MemoryGraph(), []);
memories.size   // 0
// stats: { strengthened: 0, decayedEdges: 0, forgotten: 10 }
```

Ten in, zero out, with no access, no failure, and no stale data. A memory system
whose default configuration forgets everything is not misconfigured — it is not a
memory system.

## 2. The two reasons it survived

Neither is "nobody noticed". Both are structural, and both are worth pinning so the
same shape cannot recur.

### 2.1 Nothing calls it

`consolidate` has **no production caller**. `AUDIT-CODE-VS-DOCS.md` §6 records that
the composition layer which would call it — `cortex-memory` — does not exist. The
only consumers are its four unit tests. A store was never consolidated, so the
deletion was never observed outside a test that was not looking for it.

This also explains why §6.2 step 2 has never been done: **wiring `cortex-memory`
to real storage would have exposed this immediately.** The defect was load-bearing
for the seam's absence, in the sense that any honest attempt to build the seam
starts by stepping on it.

### 2.2 The tests drove the mechanism and avoided the defaults

| Test | What it does | What it therefore never checks |
| --- | --- | --- |
| `forgets memories whose retrievability falls below threshold` | `createMemory({ stability: 1, lastAccessedAt: 0 })` + `{ forgettingThreshold: 0.9 }` | Both the default threshold and the default stability are overridden, and `lastAccessedAt: 0` is arbitrary |
| `skips graph decay when disabled` | Two memories, asserts `stats.decayedEdges === 0` and `g.edgeCount() === 1` | **Both fixture memories are silently deleted.** The count is never asserted |
| `strengthens graph edges among co-activated memories` | Asserts `strengthened` and edge weight | Memory survival |
| `skips access records for unknown memories` | Asserts `strengthened === 0` on an empty store | Everything else |

> A test that proves "a high threshold forgets" says nothing about whether the
> shipped threshold forgets everything.

The second row is the sharper one. The existing suite contained a test whose
fixtures were being emptied out from under it, and it passed, because it asserted
the one property that did not depend on them being present.

### 2.3 The third reason: only relative magnitudes were asserted

`math.test.ts` and `edge-cases.test.ts` constrained stability but never its unit:

```ts
expect(success.stability).toBeGreaterThan(s0.stability);   // successful review grows S
expect(failure.stability).toBeLessThan(s0.stability);      // failed review shrinks S
expect(s.stability).toBeGreaterThan(0);                    // "valid state"
retrievability(100, 0) === 0;                              // non-positive guard
```

Every one of these is invariant under a change of unit. `toBeGreaterThan(0)` is
satisfied by `1` and by `1e-9` alike. **A suite that only constrains ratios cannot
detect a scale error**, and this defect was a pure scale error.

## 3. The fix: the unit, not the constant

The tempting fix is to raise the threshold to something large enough to leave
memories alone. That is the wrong axis: it makes the default depend on a second
constant that has to agree with the first, in a unit nobody wrote down.

FSRS stability is conventionally **a duration of the same order as the review
interval**. For a memory store that interval is days. `1` is not a plausible value
for "one millisecond of durability" in any system that stores memories, and
expressing days in milliseconds (`86_400_000`) makes every tuning range
unreadable.

| File | Before | After |
| --- | --- | --- |
| `math/fsrs.ts` | `retrievability(deltaMs, stabilityMs)` = `exp(-Δt / S)`, both ms | `retrievability(deltaMs, stabilityDays)`, Δt converted to days inside |
| `math/fsrs.ts` | `const MIN_STABILITY = 1` (ms) | `export const MIN_STABILITY = 1` (day) |
| `domain/memory.ts` | `stability: partial.stability ?? 1` | `stability: partial.stability ?? fsrs.stability` |
| `domain/memory.ts` | `difficulty: partial.difficulty ?? 5` | `difficulty: partial.difficulty ?? fsrs.difficulty` |

Two deliberate decisions inside that table.

**The time argument stays in milliseconds.** Every timestamp in the domain is epoch
milliseconds, so `deltaMs` cannot be passed by mistake; a days argument can, and
would scale the curve by 86 400 000. The conversion lives at the boundary where the
timestamp is already being converted anyway.

**`createMemory` derives its defaults from `initialFsrsState()` instead of
restating them.** The old code had two independent literals — `1` in
`initialFsrsState()` and `1` in `createMemory` — that had to agree, did agree, and
agreed on the wrong unit. Reading the initial state removes the second place to be
wrong. This is why `MIN_STABILITY` and `MAX_REVIEW_BOOST` are now exported and
re-exported from the barrel: the derivation needs them, and `cortex-core` has no
package-private visibility (§2.2's rationale in `tools/rebuild-export-census-baseline.py`
records the same constraint for the census tool).

### 3.1 A second clock error, found while fixing the first

`consolidate` charged each access's stability boost against `now - lastAccessedAt`,
where `now` is the **batch** clock. A live caller replays a batch of records, some
of which are older than the batch; using `now` credits them with decay they had
already suffered. It now uses `access.at - mem.lastAccessedAt`.

With the default state the two clocks are indistinguishable — both give `exp(0)` —
so this is invisible unless a test separates them deliberately. One does:
`the access clock is the access record, not the batch`.

### 3.2 A third defect, exposed by the fix

Correcting the unit exposed a degenerate case in `review`. The success boost is
`1 + (1 - R) * 2`, proportional to how close the memory was to being forgotten. At
`Δt = 0` we have `R = 1`, so the boost is exactly `1`:

```
review({ stability: 1, difficulty: 5 }, 'success', 1)
  → { stability: 1, difficulty: 4 }     // stability unchanged
```

A memory could be accessed any number of times in a row, at no elapsed cost, and
its durability would never move. Under the old unit this was masked: stability was
in milliseconds, so "no elapsed cost" was a five-millisecond window nobody could
land in. **Fixing the unit made a permanently-unreachable branch reachable**, and
the branch was wrong. `review` now applies a floor of `+25%` when the computed boost
would be `no-op`:

```ts
const immediate = state.stability * boost <= state.stability;
nextStability = immediate
  ? state.stability * (1 + MAX_REVIEW_BOOST)
  : Math.max(MIN_STABILITY, state.stability * boost);
```

The floor's condition implies `R = 1`, so no memory that has actually decayed is
affected, and the plain `review`-then-`retrievability` composition stays exactly
reversible — a property the tests rely on to attribute a change to one step at a
time.

**Named simplification, not FSRS.** Real FSRS derives the target interval from
difficulty and the review rating; Cortex has no rating to draw on. The curve here
is FSRS-shaped, not FSRS-faithful, and the difference is now recorded rather than
implied.

## 4. What is asserted

`packages/cortex-core/src/__tests__/consolidation-clock.test.ts`, 12 assertions
over four groups. Written before the fix and run red first:

```
× does not forget a memory that has existed for an hour
    → an hour-old memory was forgotten: expected 1 to be +0
× gives a fresh memory a stability that keeps it retrievable for a day
    → initialFsrsState().stability is 1; a memory must be retrievable a day later
× keeps the default stability of createMemory in the same regime
    → createMemory().stability is 1, which cannot express a day of durability
× leaves a reviewed memory more retrievable an hour later than an unreviewed one
    → reviewed=0 should exceed unreviewed=0 after an hour
× keeps both kinds of memory alive through a default consolidation
    → a recent reviewed memory was forgotten: expected 2 to be +0
Tests  5 failed | 5 passed (10)
```

Note which one **passed**: `does not forget a memory created moments ago`. The
fixtures were created microseconds before consolidation ran, so they were still
inside the five-millisecond window. The next assertion — an hour old — failed. The
deletion was a function of the clock, not of age, and the passing assertion is the
proof.

The assertions were extended to 12 by the two clock tests in §3.1.

| Group | Assertion | Guards |
| --- | --- | --- |
| Fresh memory survives | `does not forget a memory created moments ago` | the regression, 10 in / 10 out |
| | `does not forget a memory that has existed for an hour` | three orders of magnitude past the old wall |
| | `still forgets a memory that is genuinely stale` | **the counter-assertion**: a year untouched *is* forgotten |
| | `honours an explicit threshold over the default` | an explicit threshold still overrides, as the old test relied on |
| Stability is a duration | `gives a fresh memory a stability that keeps it retrievable for a day` | the unit, stated via `retrievability(DAY, S) > 0.01` |
| | `keeps the default stability of createMemory in the same regime` | the second default, so the two cannot drift |
| | `does not treat the initial state as expiring within the same millisecond` | names the specific absurdity in the failure message |
| | `recovers a fresh memory to full retrievability via initialFsrsState` | `initialFsrsState` and `retrievability` agree on a live memory |
| Access extends life | `leaves a reviewed memory more retrievable an hour later than an unreviewed one` | the boost reaches the curve |
| | `keeps both kinds of memory alive through a default consolidation` | end to end, reviewed and ignored alike |
| The record is the clock | `credits an access with the retrievability it actually had` | the boost is a property of the record, asserted against the closed form `1 + (1 - 1/e) * 2` |
| | `does not credit a decayed access with a fresh one` | a 29-day-old access outperforms a no-spacing one |

The third row is the one that keeps the fix honest. It would be easy to "fix" the
defect by disabling forgetting, which passes every other assertion in the file.
A year untouched must still be dropped.

The last two rows separate the two clocks in §3.1 by construction: same memory,
same record, and a closed-form expectation that is not the no-spacing floor.

## 5. Three injections

Each edit was applied to a green tree, run, and reverted. Each is caught by a
different subset, which is what makes them worth recording separately.

| # | Injection | Caught by | Failure |
| --- | --- | --- | --- |
| 1 | Put the unit back: `MIN_STABILITY = 1 / MS_PER_DAY`, `exp(-Δt / S)` | **7 of 12** | `an hour-old memory was forgotten`; `initialFsrsState().stability is 1.157e-8`; `a fresh memory is gone after 1 ms: expected 0 to be greater than 0.01`; the closed form off by `8.5e-9` |
| 2 | Charge the build against `now` instead of `access.at` | **1 of 12** | `a day-old access must not be charged the no-spacing floor: expected 2.294 to be close to 2.264` |
| 3 | Remove the no-spacing floor in `review` | 2 of 12, across two files | `reviewed=0.959 should exceed unreviewed=0.959`; `expected 10 to be greater than 10` |

Injection 1 is the original defect restored and is caught by the majority of the
file — the suite would not have let this ship. Injection 2 is caught by exactly one
assertion, and that assertion was written for it; without §3.1 this clock error
would have no witness at all. Injection 3 spans two files, which is the point of
`math.test.ts`'s `still strengthens a memory reviewed with no elapsed time`.

## 6. Repository-wide acceptance

`pnpm check` — `test:tools && build && lint && typecheck && census:check && test && format` —
exits 0.

```
packages/cortex-core  Tests  216 passed  98.75 | 98.67 | 100 | 98.75
packages/cortex-node  Tests   16 passed   100 | 98.61 | 100 |  100
packages/cortex-llm   Tests  131 passed  99.27 | 98.11 | 100 | 99.27
packages/cortex-eval  Tests 1516 passed  99.88 | 99.05 | 100 | 99.88
                             1879 tests, 0 failures
```

All four dimensions of all four packages clear the 95% gate. The suite grew 1865 → 1879:
+12 for `consolidation-clock.test.ts`, +2 for the new `math.test.ts` assertions.

Two existing tests were corrected rather than deleted, and both corrections are evidence:

- `math.test.ts`'s `retrievability decays to near zero after long delay` asserted
  `retrievability(1_000_000_000, 1000)` — a delay of 11.6 days against a stability of 1000.
  It only passed because the old curve read stability as milliseconds. **The literal was the
  defect in disguise**: it looked like a large delay and was 11 days. It now reads
  `retrievability(100_000 * DAY_MS, 1000)` and says so.
- Adding `retrievability(DAY_MS, 1) === 1/e` makes the *definition* of stability assertable.
  Before the unit fix that sentence could not be written at all, because "one stable interval"
  was one millisecond.

## 7. Ledger movement

`tools/export-census-baseline.json`, rebuilt from a fresh census:

| Total | Before | After | Why |
| --- | --- | --- | --- |
| `exports` | 429 | **431** | `MIN_STABILITY` and `MAX_REVIEW_BOOST` exported |
| `withCaller` | 216 | **218** | both have callers (`review`, `memory.ts`) |
| `orphaned` | 213 | 213 | unchanged |
| `referencedLocally` | 187 | **189** | both are referenced inside their declaring file |
| `unreferenced` | 26 | **24** | `consolidate` and `initialFsrsState` each gained a caller |

The movement in the last row is the informative one, and it is a **reduction
produced by adding a caller, not by deleting code**: `consolidate` and
`initialFsrsState` were in the `unreferenced` class because nothing called them.
`initialFsrsState` is now called by `createMemory` (§3), and `consolidate` by the
new tests as before — its classification changed because the audit made its
contract explicit rather than because it acquired a production consumer.

Invariants hold on the rebuilt ledger:

```
referencedLocally + unreferenced === orphaned          189 + 24 === 213
knownOrphans === locations === orphanClass === orphaned   213 === 213 === 213 === 213
```

## 8. What this does not fix

- **`consolidate` still has no production caller.** The seam that would give it one
  is `cortex-memory` (`AUDIT-CODE-VS-DOCS.md` §6.2 step 2). This audit removes the
  blocker; it does not do the work.
- **The threshold's value is still a judgement.** `0.01` now means "about 4.6
  stable intervals without an access" instead of "4.6 ms", but whether 4.6 days,
  weeks or months is right is a product question, and the observability to answer it
  does not exist yet.
- **`ot.ts` is still exported and still unwired** from `consolidate`, as its
  docstring has said since it was written.
- **The census cannot see this class of defect.** It counts references, not units.
  Nothing in the gate would have failed on the millisecond version of this module.
  The defence is the `retreivabilityIsSane`-style *unit* assertion, which is why §4
  pins a property of the curve rather than a literal.

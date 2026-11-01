import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported — see cortex-core/vitest.config.ts for
 * the rationale. This package previously had no config at all, so it inherited
 * vitest's defaults and enforced nothing.
 *
 * ## Reading under vitest 5: 100 / 99.12 / 100 / 100
 *
 * The `} finally {` counters this file used to argue about no longer appear at all. `pg.ts` and
 * `sql-storage.ts` both read 100 / 100 / 100 / 100, so the two residual branch points are gone
 * without a line of code changing -- which is what settles the question the long section below
 * spent so long on: they were the old provider's mapping, not the code. The section stays as the
 * record of how that was established, not as a claim that is still true.
 *
 * One branch remains, at `sqlite.ts:47`, and it is a different kind of thing: `close()` guards
 * `if (this.db.open)` to satisfy `SqlSession`'s documented idempotence. `BetterSqliteSession` is
 * not exported and `SqlStorage.close()` calls it exactly once, so the false arm cannot be reached
 * through the public API. It is kept rather than deleted because it encodes a contract at the
 * engine boundary, and recorded rather than annotated because a reader of the number deserves to
 * know which of the two situations they are looking at.
 *
 * Two tests were added alongside this reading, for gaps the new instrument exposed as real:
 * `sql-storage.test.ts` now covers `close()` after a rejected schema (the one path where the eager
 * `#ready` rejects, and the comment on `close` promises the engine is released anyway) and the read
 * that follows it. `sql-storage.ts` went 98.55 / 100 / 95.65 to 100 on all four.
 *
 * ## The residual branch gap was a provider artefact, and that is measured (superseded)
 *
 * **Historical.** The measurement below, and the V8 sub-range analysis that follows it, described
 * vitest 2's `v8-to-istanbul` mapping. Under vitest 5's AST remapping neither counter is emitted.
 * The reasoning is kept verbatim because it is the reason nobody restructured correct code to
 * satisfy a reporting bug.
 *
 * Measured then: 100 stmts / 98.9 branch / 100 funcs / 100 lines. The remaining branch
 * points were two counters, one at `pg.ts:82:4` and one at `sql-storage.ts:170:4` -- both of them
 * the `} finally {` line of a transaction method, both reading `[0]` on every run. The second
 * arrived with the shared `SqlStorage`; it is the same artefact, not a second defect.
 *
 * The path it appears to describe is executed. The test `commits a transaction
 * that does not throw` writes inside a transaction and reads the row back through
 * a separate storage instance, and instrumenting the pool showed the real
 * statement sequence `BEGIN` → `INSERT` → `COMMIT`. So `COMMIT` runs; only the
 * counter does not move.
 *
 * This was verified as a property of the tool rather than of this file, by
 * reproducing it in isolation: a minimal function with `try { ... } catch { ... }
 * finally { ... }`, tested on both the throwing and non-throwing paths, reports
 * the identical `[0]` at the `} finally` column while both tests pass. A `finally`
 * on its own line therefore always contributes one never-satisfiable branch
 * counter in this vitest/v8 version.
 *
 * The mechanism was later pinned down at the V8 level, which is what makes the
 * conclusion safe rather than merely plausible. Raw `NODE_V8_COVERAGE` output for
 * that isolated function shows the `} finally {` line carrying exactly ONE
 * sub-range, with `count = 0`, even though the driver awaited the function and the
 * release call demonstrably ran. The control case is the same function with the
 * `try/finally` removed: it emits ZERO sub-ranges on that line. So the counter is
 * manufactured from a sub-range V8 emits solely because of the `finally` clause,
 * and a `branch` record with one location has no decision to measure — it can only
 * ever read zero. The threshold is unaffected either way; what changes is that the
 * claim "this is an artefact" now rests on the emitted ranges rather than on an
 * inference from the failure.
 *
 * It is recorded here rather than `exclude`d or annotated away, for the same
 * reason the `0/0` interface files are: the number is wrong, but the code is not,
 * and a suppression would leave the next reader unable to tell which of those two
 * situations they were looking at. The threshold stays at 95 on all four
 * dimensions and this package clears it with the artefact included. Deleting the
 * counter would require restructuring correct code to satisfy a reporting bug,
 * which is the wrong trade — the same judgement as not widening the gate to
 * absorb noise.
 */
/**
 * ## Three files are excluded from the Node coverage number, and they are not uncovered
 *
 * `src/browser/opfs.ts`, `src/browser/opfs-worker.ts` and `src/browser/idb.ts` need `Worker`, `OPFS`
 * and `IndexedDB`. None of the three exists in Node, and a jsdom-style shim would assert the shim:
 * the interesting failures in this layer are exactly the platform behaviours a shim does not have --
 * access handles released asynchronously, a pool that cannot be installed twice, a transaction that
 * auto-commits across an `await`.
 *
 * They are covered instead by `test/browser/probe.mjs`, which runs the **built** package in a real
 * Chromium, twice, across a browser restart, and asserts 24 named checks. That run is what a green
 * coverage number for these files would have been standing in for.
 *
 * Everything else in `src/browser` -- the protocol, the session, the request validation -- is here,
 * exercised over a real `MessageChannel` against a real engine, and held to the same threshold.
 */
export default defineConfig({
  test: {
    // vitest 5 dropped `**/dist/**` from its default exclude, so `tsc`'s compiled copies of these
    // tests were being collected and run a second time. Restored explicitly -- see
    // cortex-core/vitest.config.ts for the full account.
    exclude: [...configDefaults.exclude, 'dist/**'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'src/browser/opfs.ts',
        'src/browser/opfs-worker.ts',
        'src/browser/idb.ts',
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});

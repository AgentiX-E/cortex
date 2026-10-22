import { defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported — see cortex-core/vitest.config.ts for
 * the rationale. This package previously had no config at all, so it inherited
 * vitest's defaults and enforced nothing.
 *
 * ## The residual branch gap is a provider artefact, and that is measured
 *
 * Measured now: 100 stmts / 98.61 branch / 100 funcs / 100 lines. Every point of
 * the remaining 1.39 branch points is a single counter at `pg.ts:82:4`, which is
 * the `} finally {` line of `PgStorage.transaction`. It reads `[0]` on every run.
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
export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/__tests__/**'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});

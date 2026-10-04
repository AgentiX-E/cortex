import { defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported — see cortex-core/vitest.config.ts for
 * the rationale. The config existed but had no thresholds, so the harness that
 * decides whether a memory claim is real was itself unguarded.
 *
 * Current reading: **100 / 99.95 / 100 / 100** over the instrumented set, with
 * every source file that contains runtime code at 100 on all four dimensions.
 * `runner.ts`, `rerank-factory.ts` and `retrieval-diagnostics.ts` were the last
 * three to reach it; each was a real gap in the fixtures rather than a v8
 * artifact, confirmed by instrumenting the line and counting which arm ran.
 *
 * `src/types.ts` is excluded as a declaration-only module. It exports nothing but
 * `type` and `interface` declarations, all 26 of its import sites use `import
 * type`, and no runtime value ever loads it — so the instrumenter reports an
 * empty file, which reads as 0/0/0/0 and drags the package figure down for a
 * module with nothing to execute. This is the same reason `*.d.ts` is excluded
 * rather than annotated: there is no code to cover, so a percentage would be a
 * statement about the instrument, not about the code.
 *
 * Excluding a file that DOES contain runtime logic would forfeit the gate, so the
 * exclusion is deliberately name-specific (`src/types.ts`, not `src/types*.ts`)
 * and the file itself carries a note pointing back here.
 */
export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/__tests__/**', 'src/types.ts'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});

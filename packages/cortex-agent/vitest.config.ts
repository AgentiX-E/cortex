import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported — see cortex-core/vitest.config.ts for the rationale.
 *
 * The floor matters more here than in a package that re-exports a mature engine: every branch in
 * this package is a **stop rule, a parse fallback or a budget**, and each of those is a way a
 * dispatch can be lost. A stop rule that no test reaches is a stop rule that has never been
 * observed to fire, which is how the campaign lost three runs to an instrument that printed the
 * same word for two different failures.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    coverage: {
      include: ['src/**/*.ts'],
      // `types.ts` emits nothing but types (`Decision`, `Retrieval`, `AgentTrace` and the option
      // bag), so it reads 0/0 and is recorded as `nothing-to-execute` in the per-file baseline
      // rather than claimed as covered. `index.ts` is a barrel of `export … from` for the same
      // reason. Neither exemption is an assumption: the per-file gate fails on an unrecorded
      // 0/0 file, so the two names have to be justified in that ledger to exist.
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

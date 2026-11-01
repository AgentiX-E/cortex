import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported — see cortex-core/vitest.config.ts for
 * the rationale. This package previously had no config at all, so it inherited
 * vitest's defaults and enforced nothing.
 *
 * Reading under vitest 5: **99.79 stmts / 100 branch / 99.01 funcs / 100 lines**.
 * The figure this file used to carry (100 / 98.47 / 100 / 100) was measured by the
 * provider vitest 2 shipped, which attributed fine-grained arms to the enclosing
 * function; since vitest 3 the v8 provider remaps through the AST and reports them
 * on their own. Branch coverage went UP and statement coverage went DOWN in the same
 * upgrade, which is what an instrument change looks like rather than a code change.
 * See `docs/FIX-DEPENDENCY-ADVISORIES.md`.
 */
export default defineConfig({
  test: {
    // vitest 5 dropped `**/dist/**` from its default exclude, so `tsc`'s compiled copies of these
    // tests were being collected and run a second time. Restored explicitly -- see
    // cortex-core/vitest.config.ts for the full account.
    exclude: [...configDefaults.exclude, 'dist/**'],
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

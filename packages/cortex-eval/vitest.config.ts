import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported — see cortex-core/vitest.config.ts for
 * the rationale. The config existed but had no thresholds, so the harness that
 * decides whether a memory claim is real was itself unguarded.
 *
 * Reading under vitest 5: **99.21 / 97.74 / 99.65 / 99.39** over the instrumented
 * set. The 100 / 99.95 / 100 / 100 this file used to carry was measured by the
 * provider vitest 2 shipped; since vitest 3 the v8 provider remaps counters through
 * the AST, so switch arms and comparator clauses are counted on their own instead of
 * being folded into the enclosing function's covered range. The largest single gap
 * it revealed is `acceptance.ts` (62.96 / 68.96 / 83.33 / 61.53): `currentOf`
 * dispatches one criterion over seven source kinds and the `arm`, `gap`, `leak`,
 * `ablation` and `artifact` arms have no unit test. That is an open gap, recorded in
 * `docs/FIX-DEPENDENCY-ADVISORIES.md` section 3.3 rather than papered over.
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
    // vitest 5 dropped `**/dist/**` from its default exclude, so `tsc`'s compiled copies of these
    // tests were being collected and run a second time. Restored explicitly -- see
    // cortex-core/vitest.config.ts for the full account.
    exclude: [...configDefaults.exclude, 'dist/**'],
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

import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported — see cortex-core/vitest.config.ts for
 * the rationale.
 *
 * This package is the composition layer: it exists to make `cortex-core`'s
 * value gates *reachable*, and the gates are the thing under test. A gate that
 * is not covered here is a gate that is not wired, which is the exact defect
 * this package was created to close.
 */
export default defineConfig({
  test: {
    // vitest 5 dropped `**/dist/**` from its default exclude, so `tsc`'s compiled copies of these
    // tests were being collected and run a second time. Restored explicitly -- see
    // cortex-core/vitest.config.ts for the full account.
    exclude: [...configDefaults.exclude, 'dist/**'],
    coverage: {
      include: ['src/**/*.ts'],
      // `types.ts` is **not** excluded any more, and the reason it once was had gone stale.
      //
      // The exclusion said "pure type declarations: it emits no runtime code, so v8 reports it as
      // 0/0". That was true when it was written and stopped being true when `TURN_CAP_ROUTES`
      // arrived -- a real array literal, evaluated at import, that `index.ts` re-exports and the
      // prompt builder routes on. An `exclude` entry is a claim nobody re-checks: the file kept its
      // exemption long after the premise was false, and the only reading it produced was the one
      // the exemption had written for it. Measured instead, it reads 1 statement, 100%.
      //
      // `index.ts` stays in scope, but not for the reason a threshold would suggest: it re-exports,
      // and `export ... from` produces no counter under the v8 provider, so it reports 0/0 and is
      // recorded in `tools/coverage-per-file-baseline.json` as `nothing-to-execute` rather than
      // claimed as "covered by `index.test.ts`". That test is still worth having -- importing the
      // barrel is what proves the entry surface resolves -- but it cannot move a counter that does
      // not exist, and saying otherwise is how a 0/0 file gets mistaken for a covered one.
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

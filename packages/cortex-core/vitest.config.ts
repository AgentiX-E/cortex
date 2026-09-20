import { defineConfig } from 'vitest/config';

/**
 * Coverage is gated, not merely reported.
 *
 * Before this file existed, cortex-core ran with vitest's defaults and no
 * `thresholds`, so the project's ">=95% on every dimension" rule was a
 * convention that a commit could violate silently — `vitest run --coverage`
 * would print a low number and still exit 0. The rule is only real if a
 * violating commit fails.
 *
 * All four dimensions are gated because they fail independently: statement
 * coverage can be high while branches (ternaries, `??`, short-circuit `&&`, the
 * default arm of a switch) are untested, which is exactly the class of defect a
 * memory system hides — an unexercised fallback path.
 *
 * Measured at the time of writing: 98.73 stmts / 97.62 branch / 100 funcs /
 * 98.73 lines. The gate sits at 95 so normal refactoring is not hostile, while
 * any real loss of coverage fails CI.
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

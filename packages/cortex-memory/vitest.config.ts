import { defineConfig } from 'vitest/config';

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
    coverage: {
      include: ['src/**/*.ts'],
      // `types.ts` is pure type declarations: it emits no runtime code, so v8
      // reports it as 0/0 and it would drag the denominator without anything
      // being untested. `index.ts` stays in scope and is covered by
      // `index.test.ts`, because a barrel's re-exports are the consumer API.
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

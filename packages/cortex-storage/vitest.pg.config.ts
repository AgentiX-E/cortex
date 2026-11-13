import { defineConfig } from 'vitest/config';

/**
 * The configuration for the PostgreSQL integration suite, and nothing else.
 *
 * ## Why this is a second config rather than a second `include` in the first one
 *
 * The unit config must never collect `test/pg/**`. If it did, `pnpm test` would report
 * `1 skipped` on every machine without a database, and a suite that reports itself as skipped
 * next to 292 passing files reads as "accounted for". It is not accounted for: nothing ran. So the
 * integration suite is not reachable from `pnpm test` at all, which makes its absence a missing
 * command (`pnpm test:pg`) rather than a quiet line in a summary.
 *
 * ## Why coverage is off
 *
 * `src/storage/pg.ts` already reports 100 / 100 / 100 / 100 from `pg-mem`, and that number is part
 * of the problem this file exists to answer: line coverage says a statement was reached, not that
 * the engine agreed. Running the instrument here would produce a second number over the same lines
 * and invite the reader to average them. What this suite produces is passes and failures.
 *
 * ## Why one worker and no file parallelism
 *
 * The suite shares one database. Two workers would interleave `DELETE` and `INSERT` on the same
 * `cortex_kv` table and produce failures that depend on timing, which is the class of test this
 * repository refuses to keep. One worker, one database, deterministic order.
 *
 * `poolOptions` is not used. vitest 5 removed it in favour of top-level options, and the deprecation
 * notice it printed on this file's first run was itself a finding: a config key that is silently
 * ignored reads as a constraint that is being enforced.
 */
export default defineConfig({
  test: {
    include: ['test/pg/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: { enabled: false },
  },
});

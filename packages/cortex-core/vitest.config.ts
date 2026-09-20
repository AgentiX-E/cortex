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
 * ## The reported figure is not reproducible, and that is measured
 *
 * Identical runs of this package have produced **98.48, 98.73, 98.99 and 99.24**
 * across twelve consecutive invocations with no edit between them: four distinct
 * numerators — 777, 779, 781, 783 — over a **constant** 789 statements. The
 * denominators never moved, so the code did not change; only the attribution of
 * executed counters to statements did. The full diagnosis is in
 * `docs/FIX-COVERAGE-GATE-NOISE.md`; the movement is confined to the six
 * `c8 ignore` guard bodies in `src/math/stats.ts` plus the annotated guard at
 * its line 76.
 *
 * ## The annotations on those guards state a reason that is false
 *
 * The guards in `src/math/stats.ts` are annotated *"defensive guard, unreachable
 * via valid inputs"*. They are **reachable**: replacing each guard body with a
 * throwing sentinel fails six tests for every one of the five loop guards. The
 * reachability was measured with that method rather than with counters, because a
 * counter probe adds a statement to the line under investigation and is then
 * credited to a different line — it reported 20,000 hits on a body that the
 * arithmetic proves is never entered. See the document, §5 and §5.1.
 *
 * The consequence is that these annotations hide *reachable and untested* code,
 * not unreachable code: with all six removed, the real suite earns 789/795 =
 * 99.25%, and the six still-uncovered statements are genuine gaps. Repairing the
 * annotations properly means testing those bodies first, which moves the reported
 * figure and therefore belongs in its own change with its own evidence.
 *
 * Two consequences are recorded here rather than only in the document, because
 * this is the file someone edits when they want to change the gate:
 *
 *   1. **A spread of about ±0.8pp around the reported value is normal.** A drop
 *      of that size is not evidence of a regression. A drop materially larger
 *      is. I twice dismissed a low figure as "a stale cached report" before
 *      measuring it, so the number is written down here to stop that.
 *   2. **The threshold is not being widened to absorb this.** 95 stays. The
 *      correct response to a noisy measurement is to reduce the noise or state
 *      it; raising the gate until the noise fits would hide a real regression
 *      behind a wider band, which is the same failure as a `|| true` in CI.
 *
 * The `json` reporter is enabled so every claimed number is re-derivable from raw
 * counters instead of from a rendered table. The text table is a rendering; the
 * JSON is the evidence. `packages/cortex-core/coverage/coverage-final.json` is
 * what made the diagnosis above possible, and it is what will make the next one
 * possible too — see `coverage-annotations.test.ts` for the other half.
 */
export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/__tests__/**'],
      // `json` in addition to the default `text`: the raw counters are the
      // evidence behind any percentage, and without them an unexplained shift
      // can only be argued about rather than measured.
      reporter: ['text', 'json'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});

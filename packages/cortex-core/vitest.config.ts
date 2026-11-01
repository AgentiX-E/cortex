import { configDefaults, defineConfig } from 'vitest/config';

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
 * ## The reported figure was not reproducible, and that was measured
 *
 * Identical runs of this package once produced **98.48, 98.73, 98.99 and 99.24**
 * across twelve consecutive invocations with no edit between them: four distinct
 * numerators — 777, 779, 781, 783 — over a **constant** 789 statements. The
 * denominators never moved, so the code did not change; only the attribution of
 * executed counters to statements did. The full diagnosis is in
 * `docs/FIX-COVERAGE-GATE-NOISE.md`; the movement was confined to the six
 * `c8 ignore` guard bodies in `src/math/stats.ts` plus the annotated guard at
 * its line 76.
 *
 * ## The guards those annotations covered are now extracted, not suppressed
 *
 * The annotations stated a reason that was false when written ("unreachable via
 * valid inputs" — `Infinity` reaches them). The guards then became genuinely
 * unreachable after two unrelated defects were fixed, which settled the
 * annotation's own claim but not the problem: `@vitest/coverage-v8` honours
 * neither `c8 ignore` nor `v8 ignore`, so the arms stayed in the denominator and
 * the file sat at 93.29% against a 95% floor.
 *
 * The fix was to **extract** the guards into `clampAwayFromZero` and
 * `degenerateDfPValue`, driven directly by `stats-degenerate.test.ts`. Coverage
 * is earned rather than excluded: no annotations, and no `exclude` patterns
 * beyond tests and `.d.ts`.
 *
 * ## The 100% that the extraction produced was partly the instrument's
 *
 * This file used to say the package "reports 100% on all four dimensions for
 * every file that contains runtime code". Under `vitest` 5 it reports
 * **98.77 statements / 96.29 branches / 99.49 functions / 99.20 lines**, and the
 * code did not get worse in between: the provider changed. Since vitest 3,
 * `@vitest/coverage-v8` remaps V8's counters through the AST instead of through
 * `v8-to-istanbul`, so a `switch` arm or the third clause of a comparator is now
 * attributed to itself rather than to the enclosing function's covered range.
 *
 * Two of the newly visible gaps were real, and were proved so by reading them:
 * `knowledge/revision.ts`'s `RevisionOptions.invalidations` is a documented
 * public option that had no test anywhere (87.09 / 74.41 before the seven cases
 * appended to `revision.test.ts`, 95.96 / 86.04 after), and `markers.ts:156` is
 * the third arm of a sort comparator that no fixture reaches. The rest of the
 * gap is the same mechanism applied to `switch` arms across the package.
 *
 * The gate did not move. 95 on all four dimensions is what it was and what it
 * stays, and the measurement that changed is recorded rather than absorbed by
 * widening a band — which is the same judgement this file makes about not
 * raising the threshold to fit the old noise. `docs/FIX-DEPENDENCY-ADVISORIES.md`
 * holds the full before/after.
 *
 * Two consequences are recorded here rather than only in the document, because
 * this is the file someone edits when they want to change the gate:
 *
 *   1. **A spread of about ±0.8pp around a reported value is normal while any
 *      un-honoured annotation is present.** A drop of that size was not evidence
 *      of a regression. With the annotations gone the figure is stable, so a
 *      future drift is now meaningful rather than noise — which is the real
 *      benefit of removing them rather than pinning them.
 *   2. **The threshold was not widened to absorb the noise.** 95 stays. The
 *      correct response to a noisy measurement is to reduce the noise or state
 *      it; raising the gate until the noise fits would hide a real regression
 *      behind a wider band, which is the same failure as a `|| true` in CI.
 *
 * The `json` reporter is enabled so every claimed number is re-derivable from raw
 * counters instead of from a rendered table. The text table is a rendering; the
 * JSON is the evidence — and it is what distinguishes a `0/0` file (the pure-type
 * modules under `src/interfaces/`, which render as `0%` without being a gap) from
 * a `0/n` file, which would be a real hole. `coverage-annotations.test.ts` asserts
 * that distinction rather than leaving it to a reader's eye.
 */
export default defineConfig({
  test: {
    // vitest 5 collects `**/*.{test,spec}.*` under a default exclude of `node_modules` and `.git`
    // only -- the `**/dist/**` entry vitest 2 shipped was removed from the defaults. `tsc` emits the
    // compiled copies of the test files into `dist/`, so without this line every compiled test runs a
    // second time and the ones that read a fixture by path fail, because `tsc` copies no fixtures.
    // Restored explicitly rather than inherited, so the set of collected tests is a decision in this
    // file and not a default that can move underneath it again.
    exclude: [...configDefaults.exclude, 'dist/**'],
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

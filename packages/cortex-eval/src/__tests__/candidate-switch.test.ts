/**
 * The candidate-discrimination feature has ONE switch, and it is not the one a
 * reader of `candidate-context.ts` would guess.
 *
 * ## The defect this pins
 *
 * `isCandidateDiscriminationEnabled(options)` reads
 * `options.enableCandidateDiscrimination` and is exported from the package barrel.
 * Nothing else in the repository ever reads that field, and nothing ever calls the
 * function outside its own unit test. So the pair describes a switch that does not
 * control anything:
 *
 *     export function isCandidateDiscriminationEnabled(options: {
 *       readonly enableCandidateDiscrimination?: boolean;
 *     }): boolean {
 *       return options.enableCandidateDiscrimination === true;
 *     }
 *
 * The feature it *appears* to gate is real and **is** wired — through a different
 * name, end to end:
 *
 *     CANDIDATE_DISCRIMINATION (env)          bench/run.ts:433  readToggle
 *       → BenchmarkRunnerOptions.candidateDiscrimination   runner.ts:144
 *       → NaturalLanguageMemorySystemOptions.candidateDiscrimination
 *       → natural-language-memory.ts:1818 / 1899  (the instruction is appended)
 *
 * Two names for one concept, one of them inert. That is worse than dead code: a
 * reader who greps `isCandidateDiscriminationEnabled` to learn how to turn the
 * feature on finds a function that returns a boolean nobody consults, and
 * reasonably concludes the feature is off by construction.
 *
 * This is the same family as `AUDIT-B7-DEAD-SWITCH.md`, whose subject was
 * `candidateDiscrimination` itself. That audit found and fixed the *live* switch;
 * this inert sibling was outside its scope and survived it.
 *
 * See [`docs/AUDIT-UNREFERENCED-GROUPS.md`](../../../../docs/AUDIT-UNREFERENCED-GROUPS.md) §3.
 *
 * ## What the assertions point at
 *
 * Deleting the function and its two tests is the fix. The parts worth pinning are
 * the ones that prevent the *same shape* from returning:
 *
 *   1. exactly one switch name exists for this feature (`candidateDiscrimination`);
 *   2. the env var that sets it is bound by the benchmark entry point;
 *   3. the flag reaches the prompt builder, so it is not merely plumbed;
 *   4. the retired name is gone from source, barrel and tests.
 *
 * Assertion 3 is the one that would have caught the original B7 defect, where the
 * flag was declared and consumed but dropped by a three-parameter arrow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `__dirname` is `packages/cortex-eval/src/__tests__`; four levels up is the repo root.
const ROOT = join(__dirname, '..', '..', '..', '..');

function pkgFile(...parts: string[]): string {
  return readFileSync(join(ROOT, 'packages', 'cortex-eval', ...parts), 'utf8');
}

const RETIRED = /(?<![A-Za-z0-9_$])isCandidateDiscriminationEnabled(?![A-Za-z0-9_$])/;
const RETIRED_FIELD = /(?<![A-Za-z0-9_$])enableCandidateDiscrimination(?![A-Za-z0-9_$])/;

/** The live switch, spelled the one way that must keep working. */
const LIVE = /(?<![A-Za-z0-9_$])candidateDiscrimination(?![A-Za-z0-9_$])/;

describe('candidate discrimination has exactly one switch', () => {
  it('removes the inert reader and its field from the module', () => {
    const source = pkgFile('src', 'candidate-context.ts');
    expect(
      source,
      'candidate-context.ts still declares isCandidateDiscriminationEnabled, whose field nothing sets',
    ).not.toMatch(RETIRED);
    expect(
      source,
      'candidate-context.ts still declares the enableCandidateDiscrimination field',
    ).not.toMatch(RETIRED_FIELD);
  });

  it('removes it from the barrel, so it is not published API', () => {
    const barrel = pkgFile('src', 'index.ts');
    expect(barrel, 'cortex-eval barrel still exports the retired reader').not.toMatch(RETIRED);
  });

  it('removes its unit test rather than leaving a test for a deleted symbol', () => {
    // A test that survives its subject is worse than no test: it makes the suite
    // green while asserting nothing about the code that exists.
    const test = pkgFile('src', '__tests__', 'candidate-context.test.ts');
    expect(test, 'candidate-context.test.ts still drives the retired reader').not.toMatch(RETIRED);
    expect(test, 'candidate-context.test.ts still names the retired field').not.toMatch(
      RETIRED_FIELD,
    );
    // The module it tests must survive -- this is a deletion of one function, not
    // of the file.
    expect(test, 'the candidate-context suite lost its subject').toMatch(/discriminateContext/);
  });

  it('keeps exactly one switch name for this feature, and it is the live one', () => {
    // The counter-assertion. Deleting the inert name is only half the fix; the
    // other half is that the live name survives and stays the only one.
    //
    // Note where the live name is NOT: `candidate-context.ts` holds the instruction
    // text (`CANDIDATE_DISCRIMINATION_INSTRUCTION`) and never the option field. The
    // first draft of this assertion required the live name in that file and failed
    // on the unmodified tree -- which is itself the defect's fingerprint: the module
    // that owns the feature declared a *different* switch name from the one the
    // feature is actually driven by.
    const runner = pkgFile('src', 'runner.ts');
    expect(runner, 'runner.ts lost the live switch option').toMatch(LIVE);
    expect(
      runner,
      'runner.ts no longer reads the live option when building the feature config',
    ).toMatch(/options\.candidateDiscrimination === true/);

    // And the instruction the live switch appends must still exist, or the feature
    // would be wired to nothing.
    const source = pkgFile('src', 'candidate-context.ts');
    expect(
      source,
      'candidate-context.ts lost CANDIDATE_DISCRIMINATION_INSTRUCTION, the thing the switch appends',
    ).toMatch(/CANDIDATE_DISCRIMINATION_INSTRUCTION/);
  });

  it('binds the live switch to an environment variable at the entry point', () => {
    // A switch that no dispatch can set is a switch that cannot be measured. This
    // is the assertion `AUDIT-B7-DEAD-SWITCH.md` was written to establish, and it
    // is what distinguishes the live name from the retired one.
    const bench = pkgFile('bench', 'run.ts');
    expect(
      bench,
      'bench/run.ts no longer reads CANDIDATE_DISCRIMINATION from the environment',
    ).toMatch(/CANDIDATE_DISCRIMINATION/);
    expect(bench, 'bench/run.ts no longer routes the env value through readToggle').toMatch(
      /readToggle\([^)]*CANDIDATE_DISCRIMINATION/,
    );
  });

  it('carries the live switch all the way to the prompt builder', () => {
    // The B7 defect was not a missing flag but a flag dropped one frame in. The
    // prompt builders read `options.candidateDiscrimination`; if that read ever
    // disappears the feature is inert while every other assertion here stays green.
    const nlm = pkgFile('src', 'natural-language-memory.ts');
    const reads = nlm.match(/options\.candidateDiscrimination === true/g) ?? [];
    expect(
      reads.length,
      'natural-language-memory.ts no longer reads options.candidateDiscrimination in a prompt builder',
    ).toBeGreaterThanOrEqual(2);
  });
});

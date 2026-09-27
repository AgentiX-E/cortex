import { describe, expect, it } from 'vitest';

import { readToggle } from '../env-toggle.js';

/**
 * The bench CLI reads its configuration from environment variables, and until
 * this module existed those reads were untested by construction: `bench/**` is
 * excluded from coverage as a CLI entry point, so a line like
 *
 *   const on = process.env['CANDIDATE_DISCRIMINATION'] === '1';
 *
 * had no test that could fail. Defect injection proved the cost -- mutating that
 * line to `= false`, or to `!== '0'`, or deleting it from the call site below,
 * each left the whole suite green.
 *
 * The parsing is not CLI plumbing, so it does not belong behind the exclusion.
 * It is a small decision with a default and a strictness, both of which are easy
 * to get wrong in ways that produce a run measuring nothing.
 */
describe('readToggle', () => {
  it('is off when the variable is absent', () => {
    // The default has to be the absence of the feature. Every arm that is not
    // measuring it runs with the variable unset, and an unset variable that
    // switches a feature on would put it into every run's prompts.
    expect(readToggle({}, 'CANDIDATE_DISCRIMINATION')).toBe(false);
  });

  it('is on for the string "1"', () => {
    expect(readToggle({ CANDIDATE_DISCRIMINATION: '1' }, 'CANDIDATE_DISCRIMINATION')).toBe(true);
  });

  it('is off for the string "0"', () => {
    expect(readToggle({ CANDIDATE_DISCRIMINATION: '0' }, 'CANDIDATE_DISCRIMINATION')).toBe(false);
  });

  it('is off for any other value rather than treating presence as truth', () => {
    // A presence test (`!== undefined`) is the tempting shortcut and it is wrong
    // here: a workflow that passes `off`, or an operator who exports `false`,
    // would silently enable the feature and destroy the control arm.
    for (const value of ['off', 'false', 'no', '2', '', 'TRUE']) {
      expect(readToggle({ CANDIDATE_DISCRIMINATION: value }, 'CANDIDATE_DISCRIMINATION')).toBe(
        false,
      );
    }
  });

  it('reads the variable named by its argument, not a fixed one', () => {
    // Two toggles sit next to each other in the workflow with opposite defaults;
    // a helper that ignored the name would make them indistinguishable.
    expect(readToggle({ A: '1', B: '0' }, 'A')).toBe(true);
    expect(readToggle({ A: '1', B: '0' }, 'B')).toBe(false);
  });

  it('defaults to on when the caller asks for that, for the shipped-config case', () => {
    // `ENTITY_IDENTITY_CLAUSE` has the opposite convention: unset means "run the
    // shipped configuration", which has the sentence. The helper has to support
    // both or the two variables cannot share it.
    expect(readToggle({}, 'ENTITY_IDENTITY_CLAUSE', { defaultOn: true })).toBe(true);
    expect(
      readToggle({ ENTITY_IDENTITY_CLAUSE: '0' }, 'ENTITY_IDENTITY_CLAUSE', { defaultOn: true }),
    ).toBe(false);
  });
});

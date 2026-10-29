/**
 * `review_pass` names a configuration, not a single pass, and this file pins what the name covers.
 *
 * ## The defect this exists for
 *
 * `reviewPass` reached the arm as one of four names, and two of them are passes that act on
 * **disjoint routes**: `bare` re-asks a first-pass bare decline on the non-multi-session routes,
 * and `recover` re-asks a multi-session decline that contradicted its own list. The arm derived
 * `reviewBareDecline` from `pass === 'bare'`, so dispatching `recover` **removed** the bare ladder
 * while adding the recovery pass -- two mechanisms on two populations behind one field.
 *
 * §13.128 registers that dispatch as a single-field experiment whose pass "can only ever consult on
 * questions that are already wrong", and under the coupled reading both halves of that sentence are
 * false: the run would also be measuring the withdrawal of a shipped treatment, and a question the
 * bare ladder had converted would go back to being a decline.
 *
 * The repair is at this layer rather than in `CortexMemory`, which keeps the two options orthogonal
 * on purpose: the product can be configured with either, both, or neither, and a test of the product
 * that hard-wired one into the other would remove a configuration the type system offers. The arm's
 * env var is the thing that names a *configuration*, because the dispatch is what has a single field.
 */
import { describe, expect, it } from 'vitest';

import { cortextMemoryArmOptions } from '../bench-memory-arm.js';

function options(pass: string) {
  return cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_REVIEW_PASS: pass });
}

describe('what a review pass name covers', () => {
  it('runs the bare ladder alone under `bare`', () => {
    expect(options('bare').reviewPass).toBe('bare');
    expect(options('bare').reviewBareDecline).toBe(true);
  });

  it('runs the bare ladder AND the recovery pass under `recover`', () => {
    // The whole assertion in two lines. `recover` adds a pass on `multi-session`; the routes the
    // bare ladder reaches are not `multi-session`, so a run that turned it off would be measuring
    // a withdrawal it did not intend to register.
    expect(options('recover').reviewPass).toBe('recover');
    expect(options('recover').reviewBareDecline).toBe(true);
  });

  it('runs neither ladder under `audit`, which is a second full consultation', () => {
    // `audit` re-asks with the whole window. Stacking a bare retry under it would make any movement
    // two consultations rather than one, which is the reason the product's own constructor refuses
    // `audit` beside a vote.
    expect(options('audit').reviewBareDecline).toBe(false);
    expect(options('none').reviewBareDecline).toBe(false);
  });

  it('keeps the two names distinguishable in the artifact', () => {
    // A reader comparing a run against its control has to be able to see which configuration ran.
    // The `reviewPass` string is what differs; `reviewBareDecline` is the derived fact and is
    // recorded rather than inferred, so the pair cannot be reconstructed wrongly by a reader who
    // assumes the coupling this file just changed.
    expect([options('bare').reviewPass, options('recover').reviewPass]).toEqual([
      'bare',
      'recover',
    ]);
    expect([options('bare').reviewBareDecline, options('recover').reviewBareDecline]).toEqual([
      true,
      true,
    ]);
  });
});

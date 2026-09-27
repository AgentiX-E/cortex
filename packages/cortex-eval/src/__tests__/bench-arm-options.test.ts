import { describe, expect, it } from 'vitest';

import { rerankArmOptions } from '../bench-arm-options.js';

/**
 * The set of options handed to the B1/B7 rerank arm.
 *
 * This is not CLI plumbing, which is why it is not in `bench/run.ts`. Defect
 * injection proved the cost of leaving it there: `bench/**` has no test harness,
 * so deleting the `candidateDiscrimination` spread from the arm's call site, or
 * defaulting it on, or dropping the environment read, each left the entire suite
 * green. A wiring defect in an entry point is invisible to every test that
 * cannot import the entry point.
 *
 * The function below is the arms' construction decision moved to where it can be
 * observed. It returns options, so the tests assert which keys are present --
 * which is the property that matters, because the runner forwards on
 * `=== true` and an always-present `false` would be a different program.
 */
describe('rerankArmOptions', () => {
  it('omits the feature option when the toggle is off', () => {
    // Absence, not `false`. The runner's forwarding reads `=== true`, so both
    // work at runtime today -- but an always-present key makes the option's
    // default unreachable and hides which arm a config describes.
    const options = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: false });
    expect('candidateDiscrimination' in options).toBe(false);
  });

  it('sets the feature option to true when the toggle is on', () => {
    const options = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: true });
    expect(options.candidateDiscrimination).toBe(true);
  });

  it('carries the reranker through in both cases', () => {
    // The arm is meaningless without it -- both sides would be identical -- so
    // this is the one key that must never depend on the B7 toggle.
    const reranker = { name: 'r' };
    for (const candidateDiscrimination of [false, true]) {
      expect(rerankArmOptions({ reranker, candidateDiscrimination }).reranker).toBe(reranker);
    }
  });

  it('passes a candidate pool through only when one was given', () => {
    // Same absence convention as the toggle, for the same reason: the runner
    // distinguishes "not configured" from a value, and a pool of `undefined`
    // would be read as configured.
    const without = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: false });
    expect('rerankCandidatePool' in without).toBe(false);

    const withPool = rerankArmOptions({
      reranker: { name: 'r' },
      candidateDiscrimination: false,
      rerankCandidatePool: 50,
    });
    expect(withPool.rerankCandidatePool).toBe(50);
  });

  it('passes a protected head through, including the value zero', () => {
    // Zero is a meaningful setting here -- "the whole list is reorderable" -- so
    // the presence test must be against `undefined` and not against falsiness.
    const zero = rerankArmOptions({
      reranker: { name: 'r' },
      candidateDiscrimination: false,
      rerankProtectedHead: 0,
    });
    expect(zero.rerankProtectedHead).toBe(0);

    const absent = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: false });
    expect('rerankProtectedHead' in absent).toBe(false);
  });

  it('passes temperature and run count through only when given', () => {
    // Temperature 0 is the deterministic default and the most common setting, so
    // the falsy trap applies here too.
    const set = rerankArmOptions({
      reranker: { name: 'r' },
      candidateDiscrimination: false,
      temperature: 0,
      runs: 3,
    });
    expect(set.temperature).toBe(0);
    expect(set.runs).toBe(3);

    const absent = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: false });
    expect('temperature' in absent).toBe(false);
    expect('runs' in absent).toBe(false);
  });

  it('passes the entity-identity flag through in both directions', () => {
    // `false` must survive. The runner's default for this option is ON, so a
    // dropped `false` would silently restore the sentence the A/B removed --
    // the exact confound the option exists to break.
    const off = rerankArmOptions({
      reranker: { name: 'r' },
      candidateDiscrimination: false,
      entityIdentityClause: false,
    });
    expect(off.entityIdentityClause).toBe(false);

    const absent = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: false });
    expect('entityIdentityClause' in absent).toBe(false);
  });

  it('omits every unconfigured key at once, leaving only the reranker and the toggle', () => {
    // The composition, not the individual cases. An object built from six
    // independent spreads can be wrong in the way that matters only when they
    // are combined: a key that leaks in from a neighbouring condition.
    const both = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: true });
    expect(Object.keys(both).sort()).toEqual(['candidateDiscrimination', 'reranker']);

    const neither = rerankArmOptions({ reranker: { name: 'r' }, candidateDiscrimination: false });
    expect(Object.keys(neither)).toEqual(['reranker']);
  });
});

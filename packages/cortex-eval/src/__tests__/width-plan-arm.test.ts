/**
 * `CORTEX_MEMORY_WIDTH_PLAN`: the grammar, the refusals, and the three places the plan has to appear.
 *
 * ## Why a strictly-parsed input rather than a permissive one
 *
 * Because the failure mode of a permissive one is already in this campaign's record. `§14.131` found a
 * run whose sampling field was never forwarded: the input parsed as empty, the request went out without
 * it, and two arms that looked like one configuration were two. The same shape arrives here through a
 * typo -- `coverage` misspelled leaves the plan absent while the dispatch history says a cut was asked
 * for -- so every malformed form is refused at the boundary rather than dropped.
 *
 * What the tests pin, in the order the mechanism can go wrong:
 *
 * 1. **Absence is absent.** No variable, a blank one, and a whitespace one all produce no `widthPlan`,
 *    which is what every archived artifact carries.
 * 2. **The defaults are the registered ones.** `coverage` has none -- a target that defaults is a target
 *    nobody chose -- while `floor` and `margin` default to §14.126's registered values.
 * 3. **Every refusal names its reason.** Nine malformed shapes, each with the sentence a reader needs,
 *    because a parser that throws "invalid" is a parser whose callers add `catch {}`.
 * 4. **The plan reaches the artifact.** The config block carries it, the config line prints it, and an
 *    artifact without one prints neither -- so two runs at different coverage cannot share bytes.
 */
import { describe, expect, it } from 'vitest';

import { cortextMemoryArmOptions, toMemoryArmConfig } from '../bench-memory-arm.js';

/** The arm on, with the width plan as the budget input's third shape states it. */
function arm(raw: string | undefined) {
  return cortextMemoryArmOptions({
    CORTEX_MEMORY: '1',
    ...(raw === undefined ? {} : { CORTEX_MEMORY_MAX_PROMPT_CHARS: raw }),
  });
}

/** A preflight that resolved, so `toMemoryArmConfig` can be called on its own. */
const EMBEDDING = {
  provider: 'offline',
  model: null,
  dimensions: 1_024,
  preflight: 'not-run',
} as const;

describe("the budget input's third shape: a per-question plan", () => {
  it('is absent when the input is absent, blank or whitespace', () => {
    expect(arm(undefined).widthPlan).toBeUndefined();
    expect(arm('').widthPlan).toBeUndefined();
    expect(arm('   ').widthPlan).toBeUndefined();
  });

  it('takes the registered floor and margin when only the coverage is named', () => {
    expect(arm('coverage=0.9').widthPlan).toEqual({
      coverage: 0.9,
      floorChars: 4_000,
      renderMargin: 1.15,
    });
  });

  it('takes every value it is given, in any order', () => {
    const one = arm('coverage=0.8,floor=2500,margin=1.2').widthPlan;
    const other = arm('margin=1.2,coverage=0.8,floor=2500').widthPlan;
    expect(one).toEqual({ coverage: 0.8, floorChars: 2_500, renderMargin: 1.2 });
    expect(other).toEqual(one);
  });

  it('refuses a pair with no key or no value', () => {
    expect(() => arm('=0.9')).toThrow(/key=value/);
    // A bare word has no discriminator at all, so it is not a plan -- it reaches the scalar parser and
    // is refused there. That is the right refusal: `coverage` alone is not a budget of any shape, and a
    // parser that guessed "probably a plan" would be guessing which experiment the run meant.
    expect(() => arm('coverage')).toThrow(/must be a positive integer/);
  });

  it('refuses a key it does not know, rather than silently applying nothing', () => {
    // The whole reason for the refusal: `coverege=0.9` would otherwise leave the plan absent while the
    // dispatch history claimed a cut, which is the sampler defect wearing a typo.
    expect(() => arm('coverege=0.9')).toThrow(/does not know "coverege"/);
    expect(() => arm('coverage=0.9,flor=4000')).toThrow(/does not know "flor"/);
  });

  it('refuses a key named twice', () => {
    expect(() => arm('coverage=0.9,coverage=0.5')).toThrow(/twice/);
  });

  it('requires a coverage, because a plan with no target has no reading', () => {
    expect(() => arm('floor=4000')).toThrow(/requires `coverage`/);
  });

  it('refuses a coverage outside (0, 1], at both ends', () => {
    expect(() => arm('coverage=0')).toThrow(/coverage in \(0, 1\]/);
    expect(() => arm('coverage=1.5')).toThrow(/coverage in \(0, 1\]/);
    // 1 is a value, not an error: it is the identity, and a run may ask for it to record that the
    // mechanism was dispatched and declined rather than never requested.
    expect(arm('coverage=1').widthPlan?.coverage).toBe(1);
  });

  it('refuses a floor that is negative or fractional', () => {
    expect(() => arm('coverage=0.9,floor=-1')).toThrow(/non-negative integer floor/);
    expect(() => arm('coverage=0.9,floor=4000.5')).toThrow(/non-negative integer floor/);
  });

  it('refuses a margin below 1, which is the direction that costs accuracy', () => {
    expect(() => arm('coverage=0.9,margin=0.9')).toThrow(/margin of at least 1/);
  });

  it('refuses a value that is not a number', () => {
    expect(() => arm('coverage=nine')).toThrow(/wants a number for `coverage`/);
    expect(() => arm('coverage=')).toThrow(/wants a number for `coverage`/);
  });

  it('reaches the artifact config as one object, and is absent from it otherwise', () => {
    const withPlan = toMemoryArmConfig(arm('coverage=0.9,floor=3000,margin=1.1'), EMBEDDING);
    expect(withPlan.widthPlan).toEqual({ coverage: 0.9, floorChars: 3_000, renderMargin: 1.1 });
    // Absent, not defaulted: an artifact from before the field must stay distinguishable from one that
    // dispatched a plan and had it declined.
    expect(toMemoryArmConfig(arm(undefined), EMBEDDING)).not.toHaveProperty('widthPlan');
  });
});

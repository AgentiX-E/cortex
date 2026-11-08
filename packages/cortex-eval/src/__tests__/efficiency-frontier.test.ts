/**
 * The joint reading, and the three ways it can refuse to make one.
 *
 * Every fixture here is a real pair of readings from this campaign, because the module's whole job is
 * to order arms that differ by amounts this dataset can barely resolve, and an invented pair would
 * settle nothing about whether the ordering rule is right:
 *
 * - **`window`** — `42310779222`, the registered configuration: **12,137** prompt tokens per question,
 *   92.0% overall, `MR` 87/121, `TR` 100/127.
 * - **`squeezed`** — `42373407439`, the same arm at a 24,000-character window: **5,623** tokens and
 *   **−3.20** overall, which is `MR −6.61` and `TR −4.72` against `ABS 0.00`, `IE −0.67`, `KU −1.39`.
 *
 * The pair is the reason the module exists. `C1` reads `squeezed` as a 53.7% win, `S1` reads it as a
 * loss, and the two rows never meet.
 */
import { describe, it, expect } from 'vitest';

import {
  CACHE_HIT_PRICE_RATIO,
  DEFAULT_EFFICIENCY_POLICY,
  compareEfficiency,
  efficiencyFrontier,
  profileOf,
  type EfficiencyPoint,
  type EfficiencyPolicy,
} from '../efficiency-frontier.js';

/** The registered arm: the reading every other point is compared against. */
function windowArm(overrides: Partial<EfficiencyPoint> = {}): EfficiencyPoint {
  return {
    arm: 'window',
    overall: { correct: 460, total: 500 },
    perCapability: [
      { capability: 'IE', correct: 86, total: 90 },
      { capability: 'MR', correct: 87, total: 121 },
      { capability: 'KU', correct: 50, total: 72 },
      { capability: 'TR', correct: 100, total: 127 },
      { capability: 'ABS', correct: 29, total: 30 },
    ],
    promptTokensPerQuestion: 12_137,
    cacheHitShare: 0.782,
    runs: 4,
    ...overrides,
  };
}

/** The same arm with a quarter of the room: cheaper, and it loses on two capabilities. */
function squeezedArm(overrides: Partial<EfficiencyPoint> = {}): EfficiencyPoint {
  return {
    arm: 'squeezed',
    overall: { correct: 444, total: 500 },
    perCapability: [
      { capability: 'IE', correct: 85, total: 90 },
      { capability: 'MR', correct: 79, total: 121 },
      { capability: 'KU', correct: 49, total: 72 },
      { capability: 'TR', correct: 94, total: 127 },
      { capability: 'ABS', correct: 29, total: 30 },
    ],
    promptTokensPerQuestion: 5_623,
    cacheHitShare: 0.782,
    runs: 4,
    ...overrides,
  };
}

/** Same accuracy as `window`, 30% cheaper: the shape a dominance claim has to have. */
function cheaperTwin(overrides: Partial<EfficiencyPoint> = {}): EfficiencyPoint {
  return windowArm({
    arm: 'economy',
    promptTokensPerQuestion: 8_500,
    ...overrides,
  });
}

describe('profileOf', () => {
  it('reports the proportion with the Wilson interval the rest of the harness uses', () => {
    const profile = profileOf(windowArm());
    // 460/500 with z = 1.96: [0.8929, 0.9407], a half-width of 2.39 points.
    expect(profile.overall.value).toBeCloseTo(0.92, 10);
    expect(profile.overall.lower).toBeCloseTo(0.8929, 4);
    expect(profile.overall.upper).toBeCloseTo(0.9407, 4);
    expect(profile.overall.halfWidth).toBeCloseTo((0.9407 - 0.8929) / 2, 4);
  });

  it('breaks the interval down per capability rather than reusing the aggregate', () => {
    const profile = profileOf(windowArm());
    const mr = profile.perCapability.find((entry) => entry.capability === 'MR');
    expect(mr?.value).toBeCloseTo(87 / 121, 10);
    // 121 questions cannot resolve better than about eight points, and the module has to say so.
    expect(mr?.halfWidth).toBeGreaterThan(0.07);
  });

  it('prices the bill the provider charges while leaving the context figure alone', () => {
    const profile = profileOf(windowArm());
    const expected = 12_137 * (0.782 * CACHE_HIT_PRICE_RATIO + (1 - 0.782));
    expect(profile.billedPromptTokensPerQuestion).toBeCloseTo(expected, 6);
    // The context reading is untouched: a cache hit changes who pays, not what was read.
    expect(profile.promptTokensPerQuestion).toBe(12_137);
    expect(profile.billedPromptTokensPerQuestion).toBeLessThan(12_137);
  });

  it('refuses a token reading that is absent or zero, because the ratio would be invented', () => {
    expect(() => profileOf(windowArm({ promptTokensPerQuestion: 0 }))).toThrow(/no token reading/);
    expect(() => profileOf(windowArm({ promptTokensPerQuestion: Number.NaN }))).toThrow(
      /no token reading/,
    );
  });

  it('refuses a cache share outside [0, 1] rather than clamping it', () => {
    expect(() => profileOf(windowArm({ cacheHitShare: 1.2 }))).toThrow(/cache share outside/);
    expect(() => profileOf(windowArm({ cacheHitShare: -0.1 }))).toThrow(/cache share outside/);
    expect(() => profileOf(windowArm({ cacheHitShare: Number.NaN }))).toThrow(
      /cache share outside/,
    );
  });

  it('refuses counts that are not counts, and a population that is not one', () => {
    const bad = (correct: number, total: number): EfficiencyPoint =>
      windowArm({ overall: { correct, total } });
    expect(() => profileOf(bad(4.5, 500))).toThrow(/needs counts/);
    expect(() => profileOf(bad(0, 0))).toThrow(/needs a population/);
    expect(() => profileOf(bad(-1, 500))).toThrow(/out of range/);
    expect(() => profileOf(bad(501, 500))).toThrow(/out of range/);
  });
});

describe('compareEfficiency', () => {
  it('orders a twin that answers identically for less', () => {
    const verdict = compareEfficiency(profileOf(cheaperTwin()), profileOf(windowArm()));
    expect(verdict.outcome).toBe('dominates');
    expect(verdict.tokenRatio).toBeCloseTo(8_500 / 12_137, 10);
    expect(verdict.blocking).toEqual([]);
  });

  it('orders it the other way round when the twin is dearer', () => {
    const dear = windowArm({ arm: 'dear', promptTokensPerQuestion: 18_000 });
    const verdict = compareEfficiency(profileOf(dear), profileOf(windowArm()));
    expect(verdict.outcome).toBe('dominated');
  });

  it('calls the window cut a trade-off, which is what it is', () => {
    // 5,623 against 12,137 saves 53.7%, and the aggregate loses 3.20 points against a 2.5-point
    // margin. `A` refused this configuration; the rule has to reach the same verdict from the numbers.
    const verdict = compareEfficiency(profileOf(squeezedArm()), profileOf(windowArm()));
    expect(verdict.outcome).toBe('incomparable');
    expect(verdict.blocking).toContain('overall');
    expect(verdict.blocking).toContain('MR');
    expect(verdict.blocking).toContain('TR');
    // `ABS 0.00` and `IE -0.67` are inside the margin and must not be named as blocking.
    expect(verdict.blocking).not.toContain('ABS');
    expect(verdict.blocking).not.toContain('IE');
  });

  it('reports a saving that comes with a blocking drop as the reference being better', () => {
    const worseAndDearer = squeezedArm({ arm: 'worse-dearer', promptTokensPerQuestion: 20_000 });
    const verdict = compareEfficiency(profileOf(worseAndDearer), profileOf(windowArm()));
    expect(verdict.outcome).toBe('dominated');
    expect(verdict.blocking).toContain('overall');
  });

  it('refuses to call a window cut cheaper when it takes the prefix cache with it', () => {
    // The reading this rule was rebuilt for, off the two artifacts rather than off the documents:
    // `42310779222` at 12,105 context tokens and 78.21% cache hits, `42373407439` at 6,077 and
    // 51.07%. Half the context, and **7.4% more money**, because a hit is charged at 2% of a miss.
    const cut = squeezedArm({ cacheHitShare: 0.5107, promptTokensPerQuestion: 6_077 });
    const verdict = compareEfficiency(
      profileOf(cut),
      profileOf(windowArm({ cacheHitShare: 0.7821 })),
    );
    expect(verdict.tokenRatio).toBeCloseTo(6_077 / 12_137, 6);
    expect(verdict.billedTokenRatio).toBeGreaterThan(1.05);
    expect(verdict.outcome).toBe('incomparable');
    // And the reverse reading is the same reading: a rule that said `dominated` in one direction and
    // `dominates` in the other would be a rule with a sign error, so both directions are asserted.
    const reverse = compareEfficiency(
      profileOf(windowArm({ cacheHitShare: 0.7821 })),
      profileOf(cut),
    );
    expect(reverse.outcome).toBe('incomparable');
  });

  it('refuses the bill as evidence when the two arms ran different repetition counts', () => {
    // The first reading this module produced, and the reason it was wrong. `42373407439` ran **two**
    // repetitions and `42355323615` ran **four**; the cache-hit share is a function of `runs` (one
    // repetition misses, the rest hit), so the 6.90x this pair reads on the bill is a measurement of
    // the repetition count wearing the name of a cost. The accuracy and context axes are unaffected.
    const reduced = squeezedArm({ runs: 2, cacheHitShare: 0.5107, promptTokensPerQuestion: 6_077 });
    const verdict = compareEfficiency(
      profileOf(reduced),
      profileOf(windowArm({ cacheHitShare: 0.9834 })),
    );
    expect(verdict.billComparable).toBe(false);
    expect(verdict.billedTokenRatio).toBeGreaterThan(6);
    expect(verdict.tokenRatio).toBeCloseTo(6_077 / 12_137, 6);
    expect(verdict.outcome).toBe('incomparable');
  });

  it('admits the bill as evidence only when the repetition counts agree', () => {
    const reduced = squeezedArm({ runs: 2, cacheHitShare: 0.5107, promptTokensPerQuestion: 6_077 });
    const verdict = compareEfficiency(
      profileOf(reduced),
      profileOf(windowArm({ cacheHitShare: 0.9834, runs: 2 })),
    );
    expect(verdict.billComparable).toBe(true);
    expect(verdict.billedTokenRatio).toBeGreaterThan(6);
  });

  it('refuses a point with no repetition count, because the bill cannot be read without one', () => {
    expect(() => profileOf(windowArm({ runs: 0 }))).toThrow(/no repetition count/);
    expect(() => profileOf(windowArm({ runs: 2.5 }))).toThrow(/no repetition count/);
  });

  it('orders a twin only when both the context and the bill fall', () => {
    const cut = squeezedArm({ cacheHitShare: 0.7821, promptTokensPerQuestion: 6_077 });
    const verdict = compareEfficiency(
      profileOf(cut),
      profileOf(windowArm({ cacheHitShare: 0.7821 })),
    );
    expect(verdict.billedTokenRatio).toBeCloseTo(6_077 / 12_137, 6);
    // `TR` still blocks: the token saving does not buy back the four questions the room cost.
    expect(verdict.outcome).toBe('incomparable');
    expect(verdict.blocking).toContain('TR');
  });

  it('names the capability subsets whose margin the sample cannot resolve', () => {
    const verdict = compareEfficiency(profileOf(cheaperTwin()), profileOf(windowArm()));
    // The aggregate at n = 500 resolves 2.38 points against a 2.5-point margin: it is resolvable.
    expect(verdict.unresolvable).not.toContain('overall');
    // Every breakdown does not, and a capability-level claim is not licensed by the aggregate test.
    expect(verdict.unresolvable).toContain('MR');
    expect(verdict.unresolvable).toContain('KU');
    expect(verdict.unresolvable).toContain('TR');
  });

  it('refuses to certify when the pre-registered margin is finer than the sample', () => {
    const tight: EfficiencyPolicy = { margin: 0.01, tokenTolerance: 0.05 };
    const verdict = compareEfficiency(profileOf(cheaperTwin()), profileOf(windowArm()), tight);
    expect(verdict.outcome).toBe('underpowered');
  });

  it('reports a tie as a tie when neither arm clears the token tolerance', () => {
    const near = windowArm({ arm: 'near', promptTokensPerQuestion: 12_300 });
    const verdict = compareEfficiency(profileOf(near), profileOf(windowArm()));
    expect(verdict.outcome).toBe('incomparable');
    expect(verdict.blocking).toEqual([]);
    expect(verdict.tokenRatio).toBeCloseTo(12_300 / 12_137, 10);
  });

  it('does not treat an unchanged token count as a saving when the tolerance is zero', () => {
    const policy: EfficiencyPolicy = { margin: 0.025, tokenTolerance: 0 };
    const identical = windowArm({ arm: 'identical' });
    const verdict = compareEfficiency(profileOf(identical), profileOf(windowArm()), policy);
    expect(verdict.outcome).toBe('incomparable');
  });

  it('gates only the capabilities the policy names', () => {
    // `MR` blocks by default; excluding it from the gate leaves the drop uncounted, so the same pair
    // that read as a trade-off now certifies. That is the policy doing what a policy does, and it is
    // asserted so that a later change to the default gate cannot be silent.
    const cheap = squeezedArm({
      overall: { correct: 460, total: 500 },
      perCapability: [windowArm().perCapability[0]!],
    });
    const policy: EfficiencyPolicy = { margin: 0.025, tokenTolerance: 0.05, gated: ['IE'] };
    const verdict = compareEfficiency(profileOf(cheap), profileOf(windowArm()), policy);
    expect(verdict.outcome).toBe('dominates');
  });

  it('refuses a gate on a capability the reference never measured', () => {
    const noKu = windowArm({ arm: 'no-ku', perCapability: [windowArm().perCapability[0]!] });
    const policy: EfficiencyPolicy = { margin: 0.025, tokenTolerance: 0.05, gated: ['KU'] };
    expect(() => compareEfficiency(profileOf(noKu), profileOf(noKu))).toThrow(/two arms/);
    expect(() => compareEfficiency(profileOf(cheaperTwin()), profileOf(noKu), policy)).toThrow(
      /pass by being absent/,
    );
  });

  it('refuses to compare an arm against a reference that lacks a gated reading', () => {
    const partial = windowArm({ arm: 'partial', perCapability: [windowArm().perCapability[0]!] });
    expect(() => compareEfficiency(profileOf(partial), profileOf(windowArm()))).toThrow(
      /carries no MR reading/,
    );
  });

  it('refuses the four inputs that would make a verdict meaningless', () => {
    const profile = profileOf(windowArm());
    expect(() => compareEfficiency(profile, profile)).toThrow(/two arms/);
    expect(() =>
      compareEfficiency(profileOf(cheaperTwin()), profile, { margin: -0.1, tokenTolerance: 0.05 }),
    ).toThrow(/accuracy margin/);
    expect(() =>
      compareEfficiency(profileOf(cheaperTwin()), profile, { margin: 0.025, tokenTolerance: -1 }),
    ).toThrow(/token tolerance/);
    expect(() =>
      compareEfficiency(profileOf(cheaperTwin()), profile, {
        margin: Number.NaN,
        tokenTolerance: 0.05,
      }),
    ).toThrow(/accuracy margin/);
  });
});

describe('efficiencyFrontier', () => {
  it('puts the trade-off pair on the front and names nothing as dominating it', () => {
    const frontier = efficiencyFrontier([windowArm(), squeezedArm()]);
    expect(frontier.front).toEqual(['window', 'squeezed']);
    expect(frontier.dominated).toEqual([]);
  });

  it('drops a point that another point beats on both axes', () => {
    const frontier = efficiencyFrontier([windowArm(), cheaperTwin(), squeezedArm()]);
    // `economy` ties `window` on accuracy at 30% fewer tokens, so `window` leaves the front.
    expect(frontier.front).toEqual(['economy', 'squeezed']);
    expect(frontier.dominated).toEqual([{ arm: 'window', by: ['economy'] }]);
  });

  it('counts the pairs whose margin the sample could not resolve', () => {
    const tight: EfficiencyPolicy = { margin: 0.01, tokenTolerance: 0.05 };
    const frontier = efficiencyFrontier([windowArm(), cheaperTwin()], tight);
    // **One** direction, not two. Only the promotion is refused for want of power; the demotion in
    // the other direction is a claim that gets no stronger as the interval tightens, so it is made.
    // A count of two would mean the rule was symmetric and therefore reading the wrong thing.
    expect(frontier.underpoweredPairs).toBe(1);
    // An underpowered pair is not an ordering, so neither arm leaves the front.
    expect(frontier.front).toEqual(['window', 'economy']);
  });

  it('refuses an aggregate-only arm, because the aggregate is the reading that hid the loss', () => {
    const bare = windowArm({ arm: 'bare', perCapability: [] });
    expect(() => profileOf(bare)).toThrow(/no capability breakdown/);
    expect(() => efficiencyFrontier([windowArm(), bare])).toThrow(/no capability breakdown/);
  });

  it('refuses two arms with one name, because the frontier is keyed on it', () => {
    expect(() =>
      efficiencyFrontier([windowArm(), windowArm({ promptTokensPerQuestion: 9_000 })]),
    ).toThrow(/both named window/);
  });

  it('returns an empty front for an empty set rather than inventing one', () => {
    const frontier = efficiencyFrontier([]);
    expect(frontier.front).toEqual([]);
    expect(frontier.dominated).toEqual([]);
    expect(frontier.underpoweredPairs).toBe(0);
  });
});

describe('the default policy', () => {
  it('is the one the design document registers', () => {
    expect(DEFAULT_EFFICIENCY_POLICY.margin).toBe(0.025);
    expect(DEFAULT_EFFICIENCY_POLICY.tokenTolerance).toBe(0.05);
  });

  it('is not stricter or looser than the aggregate can resolve, in either direction', () => {
    const profile = profileOf(windowArm());
    // 2.38 points of resolution against a 2.5-point margin: the gate is reachable, barely.
    expect(profile.overall.halfWidth).toBeLessThan(DEFAULT_EFFICIENCY_POLICY.margin);
    expect(profile.overall.halfWidth).toBeGreaterThan(0.023);
  });
});

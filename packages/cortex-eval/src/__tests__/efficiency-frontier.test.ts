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
  mcnemarExact,
  profileOf,
  signFlipExact,
  type EfficiencyPoint,
  type EfficiencyPolicy,
  type PairedEvidence,
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
    // A question count is a count. Half a question is not a population, and a percentile of one would be a
    // number about nothing.
    expect(() => profileOf(bad(4.5, 500.5))).toThrow(/needs counts/);
    expect(() => profileOf(bad(Number.NaN, 500))).toThrow(/needs counts/);
    expect(() => profileOf(bad(0, 0))).toThrow(/needs a population/);
    expect(() => profileOf(bad(-1, 500))).toThrow(/out of range/);
    expect(() => profileOf(bad(501, 500))).toThrow(/out of range/);
  });

  it('keeps the half-question a repetition mean produces instead of rounding it away', () => {
    // Four repetitions of 451, 452, 460 and 454 correct out of 500 average 454.25, and the arm's own
    // artifact reports 90.85%. Requiring an integer here rounded that to 454 and printed **90.80%** — a
    // systematic half-question in one direction on every even repetition count, which is the same class of
    // defect as reading one repetition: a reading whose precision is discarded before anyone looks at it.
    const mean = profileOf(windowArm({ overall: { correct: 454.25, total: 500 } }));
    expect(mean.overall.value).toBeCloseTo(0.9085, 10);
    expect(mean.overall.lower).toBeLessThan(mean.overall.value);
    expect(mean.overall.upper).toBeGreaterThan(mean.overall.value);
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

  it('refuses a dominance claim that rests on the cache alone', () => {
    // `42310779222` and `42355323615` are two dispatches of one arm, four repetitions each, the same
    // 24.2M prompt tokens, and 78.21% against 98.34% cache hits. Priced at 2% of a miss that is
    // **0.156x the bill on 1.003x the context** with accuracy tied, and the rule as first written
    // called it `dominates`. Nothing about the system changed between those two runs.
    const cached = windowArm({
      arm: 'cached',
      promptTokensPerQuestion: 12_173,
      cacheHitShare: 0.9834,
      overall: { correct: 462, total: 500 },
    });
    const plain = windowArm({ arm: 'plain', cacheHitShare: 0.7821 });
    const verdict = compareEfficiency(profileOf(cached), profileOf(plain));
    expect(verdict.billedTokenRatio).toBeLessThan(0.2);
    expect(verdict.tokenRatio).toBeCloseTo(12_173 / 12_137, 6);
    // The accuracy axis does not block and does not lead: 462 against 460 is inside the margin. The
    // only thing that moves is the cache, and the cache is not a system.
    expect(verdict.blocking).toEqual([]);
    expect(verdict.outcome).toBe('incomparable');
  });

  it('keeps the veto though the bill has lost its vote', () => {
    // The same cache collapse in the direction that can only overstate if it were ignored: a fifth of
    // the context and a bill that went up. `incomparable`, and the saving is not certified either.
    const cut = squeezedArm({ cacheHitShare: 0.5107, promptTokensPerQuestion: 6_077 });
    const verdict = compareEfficiency(
      profileOf(cut),
      profileOf(windowArm({ cacheHitShare: 0.9834 })),
    );
    expect(verdict.billedTokenRatio).toBeGreaterThan(1);
    expect(verdict.outcome).toBe('incomparable');
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
    const tight: EfficiencyPolicy = { margin: 0.01, tokenTolerance: 0.05, alpha: 0.05 };
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
    const policy: EfficiencyPolicy = { margin: 0.025, tokenTolerance: 0, alpha: 0.05 };
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
    const policy: EfficiencyPolicy = {
      margin: 0.025,
      tokenTolerance: 0.05,
      alpha: 0.05,
      gated: ['IE'],
    };
    const verdict = compareEfficiency(profileOf(cheap), profileOf(windowArm()), policy);
    expect(verdict.outcome).toBe('dominates');
  });

  it('refuses a gate on a capability the reference never measured', () => {
    const noKu = windowArm({ arm: 'no-ku', perCapability: [windowArm().perCapability[0]!] });
    const policy: EfficiencyPolicy = {
      margin: 0.025,
      tokenTolerance: 0.05,
      alpha: 0.05,
      gated: ['KU'],
    };
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
      compareEfficiency(profileOf(cheaperTwin()), profile, {
        margin: -0.1,
        tokenTolerance: 0.05,
        alpha: 0.05,
      }),
    ).toThrow(/accuracy margin/);
    expect(() =>
      compareEfficiency(profileOf(cheaperTwin()), profile, {
        margin: 0.025,
        tokenTolerance: -1,
        alpha: 0.05,
      }),
    ).toThrow(/token tolerance/);
    expect(() =>
      compareEfficiency(profileOf(cheaperTwin()), profile, {
        margin: Number.NaN,
        tokenTolerance: 0.05,
        alpha: 0.05,
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
    const tight: EfficiencyPolicy = { margin: 0.01, tokenTolerance: 0.05, alpha: 0.05 };
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

describe('mcnemarExact', () => {
  it('reproduces the p-value this campaign already published from an independent implementation', () => {
    // §10.9 recorded `retrievalThreshold: 0.25` losing 186 questions and winning none at
    // `p = 2.039e-56`, computed when the gate was first measured. Agreement to three significant
    // figures is the check that the exact tail here is the same quantity and not a lookalike.
    expect(mcnemarExact(186, 0) / 2.039e-56).toBeCloseTo(1, 2);
  });

  it('is symmetric in its two counts, because the test is two-sided', () => {
    expect(mcnemarExact(27, 11)).toBeCloseTo(mcnemarExact(11, 27), 12);
    expect(mcnemarExact(3, 40)).toBeCloseTo(mcnemarExact(40, 3), 12);
  });

  it('reads 27 lost to 11 won as significant and 6 lost to 12 won as not', () => {
    // The two real pairs: the window cut, and the `ask` + route-room change. One is a result and the
    // other is a redraw, and the difference between them is what the paired instrument is for.
    expect(mcnemarExact(27, 11)).toBeCloseTo(0.013853, 5);
    expect(mcnemarExact(6, 12)).toBeCloseTo(0.23788, 5);
  });

  it('returns 1 for no discordant pair, and 1 for a perfectly even split', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(5, 5)).toBe(1);
  });

  it('refuses counts that are not non-negative integers', () => {
    expect(() => mcnemarExact(-1, 4)).toThrow(/non-negative integers/);
    expect(() => mcnemarExact(2.5, 4)).toThrow(/non-negative integers/);
  });
});

describe('compareEfficiency with paired evidence', () => {
  /** `a` is the reduced-window arm and `b` the registered one, both at four repetitions. */
  const pair = (): [ReturnType<typeof profileOf>, ReturnType<typeof profileOf>] => [
    profileOf(squeezedArm({ runs: 4, cacheHitShare: 0.9834, promptTokensPerQuestion: 6_077 })),
    profileOf(windowArm({ cacheHitShare: 0.9834 })),
  ];

  it('certifies a loss the unpaired interval called unresolvable', () => {
    const [reduced, window] = pair();
    const unpaired = compareEfficiency(reduced, window);
    // The reading this module shipped first: −3.20 points against a ±2.47-point interval, reported as
    // `incomparable` with nothing certified. That is the answer the interval can give and it is not
    // the answer the design supports.
    expect(unpaired.outcome).toBe('incomparable');
    expect(unpaired.pairedUsed).toBe(false);

    const evidence: PairedEvidence = [
      { kind: 'discordant', label: 'overall', wonByA: 11, wonByB: 27 },
    ];
    const paired = compareEfficiency(reduced, window, DEFAULT_EFFICIENCY_POLICY, evidence);
    expect(paired.pairedUsed).toBe(true);
    expect(paired.paired[0]!.pValue).toBeCloseTo(0.013853, 5);
    expect(paired.paired[0]!.resolved).toBe(true);
    // 27 questions the reduced arm lost that the control kept, against 11 it won: a certified loss.
    expect(paired.blocking).toContain('overall');
    expect(paired.outcome).toBe('incomparable');
  });

  it('reads a non-significant pair as a resolved tie rather than as missing power', () => {
    const [reduced, window] = pair();
    const evidence: PairedEvidence = [
      { kind: 'discordant', label: 'overall', wonByA: 12, wonByB: 6 },
    ];
    const verdict = compareEfficiency(reduced, window, DEFAULT_EFFICIENCY_POLICY, evidence);
    expect(verdict.paired[0]!.resolved).toBe(false);
    // The distinction the outcome type exists for: `unresolvable` would say the instrument cannot see
    // the difference, and here it looked at 18 discordant pairs and found nothing.
    expect(verdict.unresolvable).not.toContain('overall');
    // It still blocks, and that is the asymmetry rather than a slip: the point estimate is 3.8 points
    // below the reference, the margin is 2.5, and a drop beyond the margin is evidence against whatever
    // the pair significance is. A rule that demoted only on a significant pair promoted a −3.20-point
    // arm once, which is why demotion takes the union of the two instruments and promotion takes the
    // paired test alone.
    expect(verdict.blocking).toContain('overall');
  });

  it('does not treat zero discordant pairs as a tie the data established', () => {
    const [reduced, window] = pair();
    const verdict = compareEfficiency(reduced, window, DEFAULT_EFFICIENCY_POLICY, [
      { kind: 'discordant', label: 'overall', wonByA: 0, wonByB: 0 },
    ]);
    expect(verdict.paired[0]!.pValue).toBe(1);
    expect(verdict.paired[0]!.resolved).toBe(false);
  });

  it('replaces the power check instead of passing it, so a paired promotion can be certified', () => {
    // A full-window arm two questions better at fewer tokens: the unpaired rule refuses to promote it
    // because the aggregate resolves 2.47 points and the margin is 2.5. With the discordant pairs
    // counted, the same data licenses the promotion — and both readings are asserted, because the
    // point is that they differ.
    // The counts have to agree with the marginals or the fixture would be two numbers rather than one
    // measurement: 14 won to 3 lost is a net +11 questions, so the point reads 471 where the control
    // reads 460. 471/500 at a 20% narrower window is a real promotion, and the margin is set to 2.0
    // points so that the unpaired rule cannot certify it — 471 against 460 resolves ±2.47.
    const better = windowArm({
      arm: 'better',
      overall: { correct: 471, total: 500 },
      promptTokensPerQuestion: 11_000,
    });
    const evidence: PairedEvidence = [
      { kind: 'discordant', label: 'overall', wonByA: 14, wonByB: 3 },
    ];
    const policy: EfficiencyPolicy = { margin: 0.02, tokenTolerance: 0.05, alpha: 0.05 };
    const unpaired = compareEfficiency(profileOf(better), profileOf(windowArm()), policy);
    expect(unpaired.outcome).toBe('underpowered');
    const paired = compareEfficiency(profileOf(better), profileOf(windowArm()), policy, evidence);
    expect(paired.paired[0]!.resolved).toBe(true);
    expect(paired.outcome).toBe('dominates');
  });

  it('gives the paired instrument sole authority on a label it covers', () => {
    // `MR` is significantly worse and the aggregate is not: the label blocks on its own pairs, and the
    // gap is not re-read through the margin rule afterwards.
    const [reduced, window] = pair();
    const verdict = compareEfficiency(reduced, window, DEFAULT_EFFICIENCY_POLICY, [
      { kind: 'discordant', label: 'MR', wonByA: 3, wonByB: 15 },
    ]);
    expect(verdict.blocking).toContain('MR');
    expect(verdict.paired.map((entry) => entry.label)).toEqual(['MR']);
    // `MR` is covered by the pairs, so it is not also reported as unresolvable — the two labels mean
    // different things and a label cannot be both. The subsets nobody paired still are.
    expect(verdict.unresolvable).not.toContain('MR');
    expect(verdict.unresolvable).toContain('KU');
  });

  it('refuses paired evidence that names one label twice', () => {
    const [reduced, window] = pair();
    expect(() =>
      compareEfficiency(reduced, window, DEFAULT_EFFICIENCY_POLICY, [
        { kind: 'discordant', label: 'overall', wonByA: 1, wonByB: 2 },
        { kind: 'discordant', label: 'overall', wonByA: 3, wonByB: 4 },
      ]),
    ).toThrow(/names overall twice/);
  });

  it('refuses a discordant count that is not a count', () => {
    const [reduced, window] = pair();
    expect(() =>
      compareEfficiency(reduced, window, DEFAULT_EFFICIENCY_POLICY, [
        { kind: 'discordant', label: 'overall', wonByA: -1, wonByB: 2 },
      ]),
    ).toThrow(/not a pair of counts/);
    expect(() =>
      compareEfficiency(reduced, window, DEFAULT_EFFICIENCY_POLICY, [
        { kind: 'discordant', label: 'overall', wonByA: 1.5, wonByB: 2 },
      ]),
    ).toThrow(/not a pair of counts/);
  });

  it('refuses an alpha outside the open unit interval', () => {
    const [reduced, window] = pair();
    for (const alpha of [0, 1, -0.05, Number.NaN]) {
      expect(() =>
        compareEfficiency(reduced, window, { margin: 0.025, tokenTolerance: 0.05, alpha }),
      ).toThrow(/paired alpha/);
    }
  });
});

describe('signFlipExact', () => {
  // The two readings that turned "repetition-mean pairing" from a hypothesis into a requirement. Both are the
  // integer per-question differences of `42355323615` against `42310779222`, recovered from
  // `ablation.featureCorrectByRun`: `a - b` over four repetitions, non-zero entries only.
  const OVERALL = [
    1, 1, 1, 1, 2, -1, 1, 2, 3, -1, 3, -1, 4, -1, 2, 1, -1, -1, -1, 1, 1, 1, -1, 2, 1, 1, 2, 1, 2,
    -1, -2, -1, -1, 1,
  ];
  const MR = [1, 1, 1, 1, 2, -1, 1, 2, 3, -1, 3, -1, 4, -1, 2, 1, -1, 2, 1, 1, 2];

  it('reproduces the aggregate reading the campaign reported', () => {
    // 22 net questions over 34 that disagreed. This is the number that replaced "MR 2 won to 9 lost,
    // p = 0.0654" with "+1.10 overall at p = 0.0211", and it is asserted to five decimals because it is
    // the figure in the design document.
    expect(OVERALL.reduce((total, value) => total + value, 0)).toBe(22);
    expect(signFlipExact(OVERALL)).toBeCloseTo(0.0211099, 6);
  });

  it('reproduces the MR reading that the first-repetition pairing could not see', () => {
    expect(MR.reduce((total, value) => total + value, 0)).toBe(23);
    expect(signFlipExact(MR)).toBeCloseTo(0.00440407, 7);
  });

  it('is symmetric in the sign of every difference', () => {
    const flipped = MR.map((value) => -value);
    expect(signFlipExact(flipped)).toBeCloseTo(signFlipExact(MR), 12);
  });

  it('returns 1 when nothing disagreed, and 1 for an even split', () => {
    expect(signFlipExact([])).toBe(1);
    expect(signFlipExact([0, 0, 0])).toBe(1);
    // Eight +1 against eight -1 is the definition of no signal, whatever the sample size.
    expect(signFlipExact([...Array<number>(8).fill(1), ...Array<number>(8).fill(-1)])).toBe(1);
  });

  it('agrees with McNemar when every difference is one repetition wide', () => {
    // The degenerate case has to line up with the other instrument, because the other instrument is what a
    // single-repetition artifact uses and the two must not disagree about the same data.
    for (const [won, lost] of [
      [27, 11],
      [6, 12],
      [14, 3],
      [1, 1],
    ] as const) {
      const differences = [...Array<number>(won).fill(1), ...Array<number>(lost).fill(-1)];
      expect(signFlipExact(differences)).toBeCloseTo(mcnemarExact(won, lost), 12);
    }
  });

  it('falls back to the normal approximation above the exact limit, conservatively', () => {
    // 60 differences is past `SIGN_FLIP_EXACT_LIMIT`, so the folded table is not used. The approximation errs
    // high — a larger p — which is the direction that cannot manufacture a claim.
    const many = Array.from({ length: 60 }, (_, index) => (index < 44 ? 1 : -1));
    const p = signFlipExact(many);
    expect(p).toBeLessThan(0.05);
    expect(p).toBeGreaterThan(0);
  });

  it('gives a large negative reading the same magnitude as its mirror', () => {
    // 60 differences with a negative sum takes the normal fallback, and the tail is two-sided by construction
    // rather than by an `abs` applied afterwards.
    const many = Array.from({ length: 60 }, (_, index) => (index < 16 ? 1 : -1));
    const positive = many.map((value) => -value);
    expect(signFlipExact(many)).toBeCloseTo(signFlipExact(positive), 12);
    expect(signFlipExact(many)).toBeLessThan(1);
  });

  it('refuses a difference that is not an integer count', () => {
    expect(() => signFlipExact([0.5, -0.25])).toThrow(/integer per-question differences/);
  });
});

describe('compareEfficiency over a repetition series', () => {
  const series = (
    label: 'overall' | 'MR',
    questions: { a: number; b: number }[],
  ): PairedEvidence => [{ kind: 'series', label, runs: 4, questions }];

  /** `a` is the reduced-window arm and `b` the registered one, both at four repetitions. */
  const pair = (): [ReturnType<typeof profileOf>, ReturnType<typeof profileOf>] => [
    profileOf(squeezedArm({ runs: 4, cacheHitShare: 0.9834, promptTokensPerQuestion: 6_077 })),
    profileOf(windowArm({ cacheHitShare: 0.9834 })),
  ];

  // The `MR` integer differences of `42355323615` against `42310779222`, repeated here so the series tests do
  // not depend on the sign-flip block above.
  const MR = [1, 1, 1, 1, 2, -1, 1, 2, 3, -1, 3, -1, 4, -1, 2, 1, -1, 2, 1, 1, 2];

  it('certifies a win the first repetition alone called a tie', () => {
    // The exact reading this change is about: on repetition 0 the same 121 MR questions gave 2 won to 9 lost
    // (p = 0.0654, not significant) while the four-repetition means give an integer sum of 23 over 21 pairs.
    const [reduced, window] = pair();
    const verdict = compareEfficiency(
      reduced,
      window,
      DEFAULT_EFFICIENCY_POLICY,
      // Any pair of counts whose difference is the real one carries the same test: the statistic is the sum of
      // the differences, so only their values matter. Both halves are pinned to the four repetitions.
      series(
        'MR',
        MR.map((difference) =>
          difference >= 0 ? { a: 4, b: 4 - difference } : { a: 4 + difference, b: 4 },
        ),
      ),
    );
    const reading = verdict.paired.find((entry) => entry.label === 'MR');
    expect(reading?.test).toBe('sign-flip');
    expect(reading?.pairs).toBe(21);
    expect(reading?.pValue).toBeCloseTo(0.00440407, 7);
  });

  it('counts a 2-2 split as agreement rather than as half a win', () => {
    const [reduced, window] = pair();
    const questions = Array.from({ length: 40 }, () => ({ a: 2, b: 2 }));
    const verdict = compareEfficiency(
      reduced,
      window,
      DEFAULT_EFFICIENCY_POLICY,
      series('MR', questions),
    );
    const reading = verdict.paired.find((entry) => entry.label === 'MR');
    // Zero pairs, p = 1, unresolved — and `pairs` says zero rather than 40, so the reader can see that the
    // sample was of agreement and not of evidence.
    expect(reading?.pairs).toBe(0);
    expect(reading?.pValue).toBe(1);
    expect(reading?.resolved).toBe(false);
  });

  it('keeps the direction of a win the floor blocks out of the verdict', () => {
    // +0.5 points, p = 0.354 on the real `ask` step: ahead, not certified. It must appear somewhere, because
    // "ahead by less than we can see" and "level" argue for different next experiments.
    const ahead = windowArm({
      arm: 'ahead',
      overall: { correct: 462.5, total: 500 },
    });
    const verdict = compareEfficiency(profileOf(ahead), profileOf(windowArm()));
    expect(verdict.outcome).toBe('incomparable');
    expect(verdict.belowNoise).toContain('overall');
    expect(verdict.leading).not.toContain('overall');
  });

  it('promotes only above the noise floor as well as above alpha', () => {
    const policy: EfficiencyPolicy = {
      margin: 0.02,
      tokenTolerance: 0.05,
      alpha: 0.05,
      noiseFloor: { delta: 0.05, source: 'test' },
    };
    const evidence: PairedEvidence = [
      { kind: 'discordant', label: 'overall', wonByA: 33, wonByB: 17 },
    ];
    // 16 net questions is +3.2 points and p = 0.026, i.e. a certified win — and it is still under a
    // 5-point floor, so the floor is what decides it rather than the pairs.
    const under = windowArm({ arm: 'under', overall: { correct: 476, total: 500 } });
    const floorBlocks = compareEfficiency(
      profileOf(under),
      profileOf(windowArm()),
      policy,
      evidence,
    );
    expect(floorBlocks.paired[0]?.resolved).toBe(true);
    expect(floorBlocks.belowNoise).toContain('overall');
    expect(floorBlocks.leading).not.toContain('overall');

    // The same pair with no floor is promoted, which is what makes the floor the thing that decided it.
    const noFloor = compareEfficiency(
      profileOf(under),
      profileOf(windowArm()),
      { ...policy, noiseFloor: undefined },
      evidence,
    );
    expect(noFloor.leading).toContain('overall');
  });

  it('never lets the floor block a demotion', () => {
    // Asymmetric by construction: a noisy floor cannot make a loss look smaller than it is.
    const policy: EfficiencyPolicy = {
      margin: 0.02,
      tokenTolerance: 0.05,
      alpha: 0.05,
      noiseFloor: { delta: 0.5, source: 'absurdly wide, on purpose' },
    };
    const behind = windowArm({ arm: 'behind', overall: { correct: 440, total: 500 } });
    const verdict = compareEfficiency(profileOf(behind), profileOf(windowArm()), policy);
    expect(verdict.blocking).toContain('overall');
  });

  it('refuses a series whose counts exceed its repetition count', () => {
    expect(() =>
      compareEfficiency(
        profileOf(windowArm()),
        profileOf(cheaperTwin()),
        DEFAULT_EFFICIENCY_POLICY,
        [{ kind: 'series', label: 'overall', runs: 4, questions: [{ a: 5, b: 1 }] }],
      ),
    ).toThrow(/cannot be right more often than it was asked/);
  });

  it('refuses a series with no questions rather than reading it as a tie', () => {
    expect(() =>
      compareEfficiency(
        profileOf(windowArm()),
        profileOf(cheaperTwin()),
        DEFAULT_EFFICIENCY_POLICY,
        [{ kind: 'series', label: 'overall', runs: 4, questions: [] }],
      ),
    ).toThrow(/carries no questions/);
  });

  it('refuses a series with no repetition count', () => {
    expect(() =>
      compareEfficiency(
        profileOf(windowArm()),
        profileOf(cheaperTwin()),
        DEFAULT_EFFICIENCY_POLICY,
        [{ kind: 'series', label: 'overall', runs: 0, questions: [{ a: 1, b: 0 }] }],
      ),
    ).toThrow(/has no repetition count/);
  });
});

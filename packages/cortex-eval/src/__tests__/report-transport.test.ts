/**
 * The transport section: what the provider did with the requests, not just what it billed.
 *
 * ## The gap this closes
 *
 * `llmUsage` counts the calls that RETURNED. A call the provider rejected six times and then
 * served is one call there and seven requests on the wire, and no artifact in this campaign
 * could tell it apart from one served first time. That is not a missing table: it is the
 * number that decides whether the next dispatch is affordable, and its absence was invisible
 * because both states render as a successful run.
 *
 * Run `41346610318` is the receipt. A 20-question probe answered `429` at question 13 and the
 * pass died inside the retry ladder; the artifact it left holds twelve graded answers, a
 * stack trace, and no counter anywhere saying a rate limit had been hit. The counters existed
 * in `cortex-ai` and were printed to stderr on the failure path only, which is the channel
 * that expires first.
 *
 * ## What these tests hold
 *
 * That the section is a property of the report rather than of a call site, that it renders
 * the reading the numbers imply instead of leaving eight counters to the reader, and that the
 * three states which call for different actions -- throttled, retried-without-a-429, and not
 * retried at all -- are separable in the document a human reads.
 */
import { describe, it, expect } from 'vitest';

import { attachTransport, formatAblationReport, type AblationReport } from '../report.js';
import type { TransportRetryReport } from '../retrieval-diagnostics.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(): Metrics {
  return {
    total: 40,
    correct: 34,
    accuracy: 0.85,
    abstentionRate: 0.1,
    abstentionCorrectRate: 0.75,
    abstentionAwareAccuracy: 0.85,
    perCapability: {
      IE: { total: 16, correct: 15, accuracy: 0.9375, abstained: 0 },
      MR: { total: 8, correct: 6, accuracy: 0.75, abstained: 1 },
      KU: { total: 6, correct: 5, accuracy: 0.8333333333333334, abstained: 1 },
      TR: { total: 6, correct: 5, accuracy: 0.8333333333333334, abstained: 1 },
      ABS: { total: 4, correct: 3, accuracy: 0.75, abstained: 1 },
    },
  };
}

function paired(total: number): PerCapabilityPairedStats {
  return {
    total,
    baselineCorrect: total,
    featureCorrect: total,
    baselineCorrectFeatureIncorrect: 0,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
  };
}

function report(): AblationReport {
  const ablation: AblationResult = {
    feature: 'cortex-memory',
    baselineAggregate: { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 },
    featureAggregate: { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 },
    delta: 0,
    pValue: Number.NaN,
    significant: false,
    effectSize: Number.NEGATIVE_INFINITY,
    baselineConfidence: { lower: 0.5, upper: 0.95 },
    featureConfidence: { lower: 0.5, upper: 0.95 },
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 0 },
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: [],
      baselineIncorrectFeatureCorrect: [],
    },
    baselineMetrics: metrics(),
    featureMetrics: metrics(),
    featureCorrect: Array.from({ length: 40 }, () => true),
    perCapability: Object.fromEntries(
      CAPABILITIES.map((c) => [c, paired(c === 'IE' ? 16 : 6)]),
    ) as Record<Capability, PerCapabilityPairedStats>,
  };
  return {
    dataset: 'longmemeval',
    questionCount: 40,
    baseline: { name: 'reference-pipeline', metrics: metrics() },
    feature: { name: 'cortex-memory', metrics: metrics() },
    ablation,
    generatedAt: '2026-11-02T04:00:00.000Z',
  };
}

/** A snapshot with the partition closed, so only the fields under test move. */
function transport(overrides: Partial<TransportRetryReport> = {}): TransportRetryReport {
  const base: TransportRetryReport = {
    provider: 'run',
    scope: 'process',
    calls: 100,
    attempts: 100,
    retried: 0,
    rateLimited: 0,
    retryAfterHonoured: 0,
    retriedCalls: 0,
    cleanCalls: 100,
    exhaustedCalls: 0,
    refusedCalls: 0,
    retryRate: 0,
  };
  const merged = { ...base, ...overrides };
  // `retryRate` is derived in `cortex-ai`; recomputing it here keeps a fixture that moves the
  // call counts from producing a report whose rate contradicts its own table.
  return {
    ...merged,
    retryRate: merged.calls === 0 ? 0 : merged.retriedCalls / merged.calls,
  };
}

function rendered(snapshot: TransportRetryReport): string {
  return formatAblationReport(attachTransport(report(), snapshot));
}

describe('the transport section is a property of the report', () => {
  it('renders from the report object alone, with no call site involved', () => {
    // The defect class this repository has paid for three times (`cohortCoverage`,
    // `retryFires`, the abstention census): a section assembled at the return site reaches the
    // Markdown and not the JSON, or the reverse, and the persisted artifact is the one a
    // reader six months later holds.
    const md = rendered(transport());
    expect(md).toContain('Transport (what the provider did with the requests)');
    expect(md).toContain('| calls | 100 |');
    expect(md).toContain('| requests issued (first attempts + retries) | 100 |');
  });

  it('omits the section entirely when the report predates the field', () => {
    // Absence is not zero. An artifact written before this instrument existed must not grow a
    // table of zeros, because "not measured" and "measured, nothing happened" are the two
    // readings this field exists to separate.
    const md = formatAblationReport(report());
    expect(md).not.toContain('Transport (what the provider did with the requests)');
  });

  it('attaches even when no call reached the layer, and says that is a defect', () => {
    // The one asymmetry with `attachLlmUsage`: the retry loop counts a call BEFORE the provider
    // answers, so a graded run cannot reach zero. Attaching it means absence is unambiguously
    // "written before the field existed", and a zero in the artifact is a statement about the
    // wiring rather than about the provider.
    const attached = attachTransport(report(), transport({ calls: 0, attempts: 0, cleanCalls: 0 }));
    expect(attached.transportRetry?.calls).toBe(0);
    const md = formatAblationReport(attached);
    expect(md).toContain('**NOT WIRED**');
  });
});

describe('the reading the counters imply', () => {
  it('says nothing was throttled when every call was served first time', () => {
    const md = rendered(transport());
    expect(md).toContain('**Nothing was throttled**');
    expect(md).toContain('Retry rate: **0.00%** of 100 calls');
    expect(md).not.toContain('**The provider throttled**');
  });

  it('separates retries without a rate limit from a rate limit', () => {
    // A transport failure or a 5xx is retried and is NOT a throttle. Folding the two into one
    // number would report a rate limit the provider never sent -- the same reason `rateLimited`
    // and `retried` are separate fields one layer down.
    const md = rendered(
      transport({ attempts: 112, retried: 12, retriedCalls: 12, cleanCalls: 88, rateLimited: 0 }),
    );
    expect(md).toContain('**Retries, but no rate limit**');
    expect(md).not.toContain('**The provider throttled**');
    expect(md).toContain('Retry rate: **12.00%** of 100 calls');
  });

  it('names a rate limit, with both denominators, when the provider throttled', () => {
    const md = rendered(
      transport({ attempts: 180, retried: 80, retriedCalls: 60, cleanCalls: 40, rateLimited: 80 }),
    );
    expect(md).toContain('**The provider throttled**');
    // 80 of 180 requests and 60 of 100 calls: a reader who is given only one of the two cannot
    // tell a run that retried the same call eighty times from one that retried eighty calls.
    expect(md).toContain('80 of the 180 requests');
    expect(md).toContain('60 of the 100 calls');
    expect(md).toContain('| attempts answered `429` | 80 |');
  });

  it('flags a partition that does not close instead of printing a rate over it', () => {
    // The identity `cleanCalls + retriedCalls + exhaustedCalls === calls` is asserted in
    // `cortex-ai`. A reader holding an artifact cannot run that test, and a partition that does
    // not close means the counters were read across a boundary -- two processes, or a reset in
    // the middle -- which makes every rate above it uninterpretable.
    const md = rendered(transport({ cleanCalls: 90, retriedCalls: 5, exhaustedCalls: 0 }));
    expect(md).toContain('**COUNTERS DO NOT PARTITION**');
    expect(md).toContain('90 + 5 + 0 + 0 ≠ 100');
  });

  it('says an exhausted call should not appear in a completed artifact', () => {
    const md = rendered(
      transport({ attempts: 108, retried: 8, retriedCalls: 8, cleanCalls: 91, exhaustedCalls: 1 }),
    );
    expect(md).toContain('**1 calls exhausted every attempt**');
    expect(md).toContain('should report `0` here');
  });
});

describe('a refusal is not a quiet run', () => {
  it('names the calls the ladder declined, and says the counters cannot say why', () => {
    // The reading that inverted this run's meaning. `retried: 0` alone prints "nothing was
    // throttled -- every call was served on its first attempt", which is exactly what
    // `41393748964`'s artifact said while the process was dying of a declined retry. With the
    // fourth class present the same counters say the opposite, and they have to be read
    // together because each one alone is true and the pair is not.
    const md = rendered(transport({ cleanCalls: 99, refusedCalls: 1, calls: 100, attempts: 100 }));

    expect(md).toContain('| calls whose retry the ladder declined | 1 |');
    expect(md).toContain('**1 calls were refused without a retry**');
    // The three reasons are not in the artifact -- only on the error message -- so the section
    // says so rather than implying one of them.
    expect(md).toContain('that reason travels on the error message');
    // The partition still closes, so the warning above it must not appear.
    expect(md).not.toContain('COUNTERS DO NOT PARTITION');
  });

  it('says nothing extra when nothing was refused', () => {
    // The control. A section that printed the refusal reading unconditionally would train a
    // reader to skip it, which is the failure mode every conditional warning in this report is
    // written against.
    const md = rendered(transport({ cleanCalls: 100, calls: 100 }));
    expect(md).not.toContain('refused without a retry');
    expect(md).toContain('| calls whose retry the ladder declined | 0 |');
  });
});

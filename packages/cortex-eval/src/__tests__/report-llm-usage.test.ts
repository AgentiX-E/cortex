/**
 * The bill must survive persistence, and an unmeasured run must not look free.
 *
 * ## The defect this file is written against
 *
 * `OpenAICompatibleLLM.complete` read the `usage` block off every provider response and
 * returned only `choices[0]`. Nothing in the campaign had ever stated a token count, so
 * the cost of a change to the window, the instruction block or the retry ladder was a
 * fact about an invoice rather than a fact about a run. §13.140 adds the instrument; this
 * file pins the two decisions that make its output readable:
 *
 *   - a snapshot with `calls === 0` is NOT attached, because no request passed through
 *     the adapter and a zeroed object would report an unmeasured run as a free one;
 *   - a snapshot whose calls all came back without a `usage` block IS attached, because
 *     that is the case that says the bill exists and cannot be read.
 *
 * The two rules are one line apart and point in opposite directions, which is why they
 * are tested against each other rather than inspected in a review.
 */
import { describe, it, expect } from 'vitest';
import { attachLlmUsage, formatAblationReport, type AblationReport } from '../report.js';
import type { AblationResult, Capability, Metrics, PerCapabilityPairedStats } from '../types.js';
import type { UsageSnapshot } from '@agentix-e/cortex-ai';

const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function metrics(): Metrics {
  return {
    total: 60,
    correct: 51,
    accuracy: 0.85,
    abstentionRate: 0.15,
    abstentionCorrectRate: 0.8888888888888888,
    abstentionAwareAccuracy: 0.85,
    perCapability: {
      IE: { total: 26, correct: 23, accuracy: 0.8846153846153846, abstained: 2 },
      MR: { total: 9, correct: 8, accuracy: 0.8888888888888888, abstained: 1 },
      KU: { total: 8, correct: 5, accuracy: 0.625, abstained: 2 },
      TR: { total: 8, correct: 6, accuracy: 0.75, abstained: 1 },
      ABS: { total: 9, correct: 9, accuracy: 1, abstained: 9 },
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
    feature: 'memory-arm',
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
    featureCorrect: Array.from({ length: 60 }, () => true),
    perCapability: Object.fromEntries(
      CAPABILITIES.map((c) => [c, paired(c === 'MR' ? 9 : 8)]),
    ) as Record<Capability, PerCapabilityPairedStats>,
  };
  return {
    dataset: 'longmemeval-s',
    questionCount: 60,
    baseline: { name: 'control', metrics: metrics() },
    feature: { name: 'treatment', metrics: metrics() },
    ablation,
    generatedAt: '2026-10-29T09:00:00.000Z',
  };
}

/** A run that called twice over 100,000 prompt tokens, a third of them from the cache. */
const PRICED: UsageSnapshot = {
  calls: 2,
  unpricedCalls: 0,
  promptTokens: 100_000,
  completionTokens: 500,
  cacheHitPromptTokens: 33_333,
};

describe('attachLlmUsage', () => {
  it('attaches a priced run without mutating the report it was given', () => {
    const base = report();
    const attached = attachLlmUsage(base, PRICED);
    expect(attached.llmUsage).toEqual(PRICED);
    // The input is untouched: `formatAblationReport` may already have been called on it,
    // and a function that edited its argument would make the caller's report and the
    // persisted report two different documents.
    expect(base.llmUsage).toBeUndefined();
  });

  it('declines to attach a run in which nothing called the instrumented adapter', () => {
    const base = report();
    const attached = attachLlmUsage(base, {
      calls: 0,
      unpricedCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitPromptTokens: 0,
    });
    // Identity, not merely equality: an attached zeroed object would serialize into the
    // artifact and every reader would take it for a measurement of zero spend.
    expect(attached).toBe(base);
    expect('llmUsage' in attached).toBe(false);
  });

  it('attaches a run whose calls all came back unpriced', () => {
    // The informative case. `promptTokens: 0` here is not "spent nothing" -- it is
    // "1000 calls, none of them priced" -- and the call count is what says so.
    const unpriced: UsageSnapshot = {
      calls: 1_000,
      unpricedCalls: 1_000,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitPromptTokens: 0,
    };
    expect(attachLlmUsage(report(), unpriced).llmUsage).toEqual(unpriced);
  });
});

describe('the provider-spend section', () => {
  it('renders the call count, both token totals and the cache share', () => {
    const md = formatAblationReport(attachLlmUsage(report(), PRICED));
    expect(md).toContain('Provider spend (as reported by the provider)');
    expect(md).toContain('| calls that returned a response | 2 |');
    expect(md).toContain('| prompt tokens | 100,000 |');
    expect(md).toContain('| completion tokens | 500 |');
    // The share is computed from the two numbers the provider published, so a reader can
    // re-derive it: 33,333 of 100,000.
    expect(md).toContain('33.33%');
  });

  it('issues no warning when every call was priced', () => {
    const md = formatAblationReport(attachLlmUsage(report(), PRICED));
    expect(md).not.toContain('NO PROVIDER COST WAS REPORTED');
    expect(md).not.toContain('**PARTIAL**');
  });

  it('warns that the token columns are unmeasured when no call was priced', () => {
    const md = formatAblationReport(
      attachLlmUsage(report(), {
        calls: 40,
        unpricedCalls: 40,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitPromptTokens: 0,
      }),
    );
    expect(md).toContain('**NO PROVIDER COST WAS REPORTED**');
    expect(md).toContain('all 40 calls');
    // The distinction the whole module rests on, stated in the document a human reads.
    expect(md).toContain('unmeasured rather than zero');
  });

  it('warns about the shortfall when only some calls were priced', () => {
    const md = formatAblationReport(
      attachLlmUsage(report(), { ...PRICED, calls: 10, unpricedCalls: 8 }),
    );
    expect(md).toContain('**PARTIAL**');
    expect(md).toContain('8 of 10 calls');
    // The partial case must NOT claim the full warning: the totals above cover two calls
    // and are real numbers, and forbidding a reader to use them would be wrong in the
    // other direction.
    expect(md).not.toContain('NO PROVIDER COST WAS REPORTED');
  });

  it('omits the section for a report that never measured a call', () => {
    const md = formatAblationReport(report());
    expect(md).not.toContain('Provider spend');
  });

  it('renders the same section from a report that has been through JSON', () => {
    // The recurring defect in this file's neighbours: a section that exists in the live
    // report and disappears from the persisted one. `llmUsage` is a plain object of five
    // numbers, so the round trip is exact and the assertion is that the renderer reads it
    // from the report rather than from a closure over the run.
    const persisted = JSON.parse(
      JSON.stringify(attachLlmUsage(report(), PRICED)),
    ) as AblationReport;
    const md = formatAblationReport(persisted);
    expect(md).toContain('| prompt tokens | 100,000 |');
    expect(md).toContain('33.33%');
  });

  it('sits below the ablation tables, like the other footnotes', () => {
    const md = formatAblationReport(attachLlmUsage(report(), PRICED));
    expect(md.indexOf('Δ accuracy')).toBeLessThan(md.indexOf('Provider spend'));
  });
});

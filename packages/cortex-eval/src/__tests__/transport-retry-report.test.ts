/**
 * The transport-retry counter must reach the artifact, not just the library.
 *
 * `retryableFetch` retries internally and returns only the final response. Before
 * this wiring existed, a request that was rejected twice and then succeeded and a
 * request that succeeded on the first attempt produced **byte-identical**
 * artifacts. The consequence was concrete: the A/B that compared a paced arm
 * (`batchIntervalMs = 250`) against an unpaced control could not report a
 * throttling rate at all, because nothing in the pipeline was recording one. The
 * run was completed, both arms succeeded, and the question the A/B was built to
 * answer stayed unanswerable.
 *
 * The gap is structural rather than a missing measurement. "Run it again and read
 * the number" does not close it -- there is no number to read. Only an explicit
 * instrument does.
 *
 * What this file pins, in order:
 *
 *   1. The counter is exposed through a single reader that the report can call.
 *   2. The report block carries the retry counters *under the embedding section*,
 *      where the embedding provenance already lives -- a reader looking for the
 *      request-rate behaviour of the embedding backend should not have to know
 *      that the counter is global.
 *   3. The block states which provider it is describing, so a counter that
 *      measured the LLM's traffic cannot be misread as the embedding's.
 *
 * Point 3 is the reason this is a function and not a bare object spread. The
 * process-level aggregate is deliberately shared: `retryableFetch` is the single
 * choke point for every remote call, so per-provider attribution is not something
 * the counter can recover after the fact from a shared total. Naming the scope in
 * the artifact is the honest alternative to inventing a breakdown the counter
 * does not have.
 */
import { describe, it, expect } from 'vitest';
import { createRetryStatsAggregate, retryStats, resetRetryStats } from '@agentix-e/cortex-llm';
import {
  formatIdPreview,
  transportRetryReport,
  type TransportRetryScope,
} from '../retrieval-diagnostics.js';

describe('transport retry report', () => {
  it('reports the counters the aggregate holds', () => {
    const aggregate = createRetryStatsAggregate();
    aggregate.record({ attempts: 3, retried: 2, rateLimited: 2, retryAfterHonoured: 1 });
    aggregate.record({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });

    const report = transportRetryReport(aggregate.snapshot(), { provider: 'embedding' });

    expect(report.attempts).toBe(4);
    expect(report.retried).toBe(2);
    expect(report.rateLimited).toBe(2);
    expect(report.retryAfterHonoured).toBe(1);
  });

  it('carries the per-call rate rather than the per-retry rate', () => {
    const aggregate = createRetryStatsAggregate();
    // One call retried 40 times, one call clean. A `retried / calls` ratio would
    // report 40 here, which is not a rate. The share of calls that retried is 1/2.
    aggregate.record({ attempts: 41, retried: 40, rateLimited: 40, retryAfterHonoured: 0 });
    aggregate.record({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });

    const report = transportRetryReport(aggregate.snapshot(), { provider: 'embedding' });

    expect(report.calls).toBe(2);
    expect(report.retriedCalls).toBe(1);
    expect(report.retryRate).toBeCloseTo(0.5);
  });

  it('reports zero rather than NaN when no call has been made', () => {
    const report = transportRetryReport(createRetryStatsAggregate().snapshot(), {
      provider: 'embedding',
    });

    expect(report.calls).toBe(0);
    expect(report.retryRate).toBe(0);
    expect(Number.isNaN(report.retryRate)).toBe(false);
  });

  it('names the scope it measured, because the counter is shared across providers', () => {
    // `retryableFetch` is the choke point for embedding AND LLM traffic, so the
    // total is process-wide. The artifact must say so instead of presenting a
    // shared number as if it were the embedding's alone.
    const aggregate = createRetryStatsAggregate();
    aggregate.record({ attempts: 2, retried: 1, rateLimited: 1, retryAfterHonoured: 1 });

    const report = transportRetryReport(aggregate.snapshot(), { provider: 'embedding' });

    expect(report.provider).toBe('embedding');
    expect(report.scope).toBe('process');
  });

  it('accepts the LLM scope so a second section can describe the same total', () => {
    const aggregate = createRetryStatsAggregate();
    aggregate.record({ attempts: 2, retried: 1, rateLimited: 1, retryAfterHonoured: 0 });

    const scope: TransportRetryScope = { provider: 'llm' };
    const report = transportRetryReport(aggregate.snapshot(), scope);

    expect(report.provider).toBe('llm');
    expect(report.retried).toBe(1);
  });

  it('reads the live process counters when handed the process snapshot', () => {
    resetRetryStats();
    const report = transportRetryReport(retryStats(), { provider: 'embedding' });

    // `retryStats()` is the only reader the process aggregate exposes, and the
    // run reports from it, so a fresh process reads a genuine zero rather than a
    // fabricated one.
    expect(report.calls).toBe(0);
    expect(report.retryRate).toBe(0);
  });

  it('does not mutate the aggregate it reads', () => {
    const aggregate = createRetryStatsAggregate();
    aggregate.record({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });

    transportRetryReport(aggregate.snapshot(), { provider: 'embedding' });
    transportRetryReport(aggregate.snapshot(), { provider: 'embedding' });

    // A reporter that recorded its own read would double the counts on the second
    // call and silently corrupt the artifact it is describing.
    expect(aggregate.snapshot().calls).toBe(1);
    expect(aggregate.snapshot().attempts).toBe(1);
  });

  it('survives JSON round-tripping with every counter intact', () => {
    const aggregate = createRetryStatsAggregate();
    aggregate.record({ attempts: 5, retried: 4, rateLimited: 3, retryAfterHonoured: 2 });

    const report = transportRetryReport(aggregate.snapshot(), { provider: 'embedding' });
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(parsed).toEqual(report);
    expect(parsed.retryAfterHonoured).toBe(2);
  });
});

/**
 * A population's size and its names are read together, and a log line that
 * shows five of them without saying so is a line that misleads.
 *
 * This lives in `src/` rather than in `bench/run.ts` because it has logic worth
 * testing -- an empty population, a population that exactly fills the preview,
 * and one that overflows all take different branches -- and `bench/**` is
 * excluded from coverage as a CLI entry point. A function with three branches
 * and no test is a function whose third branch is discovered by an operator
 * reading a truncated log.
 */
describe('formatIdPreview', () => {
  it('says so when the population is empty rather than returning nothing', () => {
    // "No question is in this gap" is a finding. An empty string in a log reads
    // as a line that failed to render.
    expect(formatIdPreview([])).toBe('(none)');
  });

  it('lists a population that fits without a truncation marker', () => {
    expect(formatIdPreview(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('does not claim truncation when the population exactly fills the preview', () => {
    // The boundary. `<= limit` and `< limit` differ only here, and getting it
    // wrong appends "… +0 more" -- a line that says there is more to see when
    // there is not.
    expect(formatIdPreview(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, e');
  });

  it('states how many are not shown when the population overflows', () => {
    const ids = Array.from({ length: 270 }, (_, i) => `q${i}`);
    const preview = formatIdPreview(ids);
    expect(preview.startsWith('q0, q1, q2, q3, q4 … +265 more')).toBe(true);
    // The count in the marker must reconcile with the population size, or a
    // reader cannot reconstruct how many the artifact will hold.
    expect(preview).toContain('+265 more');
  });

  it('honours a caller-supplied limit', () => {
    expect(formatIdPreview(['a', 'b', 'c'], 2)).toBe('a, b … +1 more');
  });
});

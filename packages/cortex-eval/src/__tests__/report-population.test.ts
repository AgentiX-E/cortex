/**
 * The population reaches the report and the Markdown, or `S12` cannot be read.
 *
 * ## The claim, and why the fingerprint is not enough
 *
 * `datasetFingerprint` identifies the **file**; `questionCount` counts what was graded. A run over
 * 500 LongMemEval-S questions and a run over 500 corpora asked twice carry the same fingerprint, and
 * the second carries twice the count -- which a reader would take for a bigger file rather than for
 * a population of pairs. `S12`'s paired delta is registered on 500 questions, and the two-window
 * population's delta is computed over the second windows, so an artifact that did not state how many
 * windows it graded would let a reader pair it against a single-window run and read a population
 * difference as a mechanism.
 *
 * ## The two failure modes
 *
 * 1. **Computed and then lost on the way to the renderer** -- the side channel this repository has
 *    removed three times (`cohortCoverage`, `retryFires`, `abstentionReasons`).
 * 2. **An absent field rendered as an identity** -- `windows: 1` on every archived run would be a
 *    claim about those runs that nobody made, which is why the identity writes no field at all.
 *
 * The round-trip assertion is here for the reason `report-dataset-fingerprint.test.ts` gives: an
 * archived report is re-rendered long after its run, and a field that survives `JSON.stringify` but
 * not `formatAblationReport` is invisible exactly when someone goes looking for it.
 */
import { describe, it, expect } from 'vitest';
import { formatAblationReport, runAblationReport, type PopulationRecord } from '../report.js';
import { FactMemorySystem } from '../fact-memory.js';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';

const POPULATION: PopulationRecord = { windows: 2, corpora: 3, marker: '#w' };

async function report(population?: PopulationRecord) {
  const ds = createLongMemEvalMini();
  const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
  const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
  return runAblationReport(ds, baseline, feature, {
    runs: 1,
    ...(population === undefined ? {} : { population }),
  });
}

describe('population in the report', () => {
  it('is absent, not the identity, when the run asked each corpus once', async () => {
    // Every archived artifact was produced under one window per corpus. A `windows: 1` record would
    // make those artifacts and a run that named the identity two different bytes for one fact.
    const one = await report();
    expect('population' in one).toBe(false);
    expect(formatAblationReport(one)).not.toContain('Population:');
  });

  it('carries the counts and the marker the ids are split on', async () => {
    const two = await report(POPULATION);
    expect(two.population).toEqual(POPULATION);

    const markdown = formatAblationReport(two);
    expect(markdown).toContain('- Population: 3 corpora x 2 windows');
    // The marker travels with the counts rather than being assumed by the reader: the analysis that
    // pairs the windows splits ids on it, and a marker written in one place and inferred in another
    // is two definitions of one format with nothing checking that they agree.
    expect(markdown).toContain('ids carry `#wN`');
  });

  it('renders under the fingerprint, because the two describe one thing at two resolutions', async () => {
    const two = await report(POPULATION);
    const withFingerprint = await runAblationReport(
      createLongMemEvalMini(),
      new FactMemorySystem('naive', { fallback: 'unknown' }),
      new FactMemorySystem('abstain', { abstainThreshold: 0.3 }),
      { runs: 1, population: POPULATION, datasetFingerprint: `sha256:${'ab'.repeat(32)}` },
    );
    expect(two.questionCount).toBe(withFingerprint.questionCount);

    const lines = formatAblationReport(withFingerprint).split('\n');
    const fileLine = lines.findIndex((line) => line.startsWith('- Dataset file: '));
    const populationLine = lines.findIndex((line) => line.startsWith('- Population: '));
    expect(fileLine).toBeGreaterThan(-1);
    expect(populationLine).toBe(fileLine + 1);
  });

  it('survives the JSON round-trip every archived artifact goes through', async () => {
    const two = await report(POPULATION);
    const parsed: unknown = JSON.parse(JSON.stringify(two));
    expect((parsed as typeof two).population).toEqual(POPULATION);
    expect(formatAblationReport(parsed as typeof two)).toContain(
      '- Population: 3 corpora x 2 windows',
    );
  });
});

describe('a shard says that it is a part', () => {
  const SHARDED: PopulationRecord = {
    windows: 2,
    corpora: 3,
    marker: '#w',
    shard: { index: 7, shards: 16 },
  };

  it('renders the shard beside the counts, so the counts cannot be read as the population', async () => {
    // `corpora: 31` on an artifact that is one sixteenth of 500 is indistinguishable from a dispatch
    // of 31. The line has to say both, and it has to say it in the same place the counts are.
    const markdown = formatAblationReport(await report(SHARDED));
    expect(markdown).toContain('SHARD 7 of 16');
    expect(markdown).toContain('one part of the dispatch and its counts are that part');
  });

  it('says nothing about a shard when the dispatch was not split', async () => {
    // The identity again: an unsplit run's line must be the line every archived artifact has.
    const markdown = formatAblationReport(await report(POPULATION));
    expect(markdown).not.toContain('SHARD');
  });

  it('is recorded even at one window, which is why the record is not keyed on the multiplication', async () => {
    // A sharded single-window run has no multiplication to record, and its `population` still has to
    // exist: without it the artifact carries no statement that it is a part at all.
    const oneWindowShard: PopulationRecord = {
      windows: 1,
      corpora: 31,
      marker: '#w',
      shard: { index: 0, shards: 16 },
    };
    const sharded = await report(oneWindowShard);
    expect(sharded.population).toEqual(oneWindowShard);
    expect(formatAblationReport(sharded)).toContain('SHARD 0 of 16');
  });
});

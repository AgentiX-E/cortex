/**
 * The progress callback across an ablation's two sides and its repeated runs.
 *
 * `runAblation` evaluates the baseline fully, then the feature fully, and then
 * repeats BOTH for every additional run. So `(system, run, index)` -- not
 * `index` alone -- is what identifies one attempt, and a progress record that
 * omitted either would be unreadable on a multi-run arm. Run `37281155088` died
 * on the feature side of run 0, and nothing in its log said so.
 *
 * Two properties are pinned here that the callback's own tests cannot reach:
 * the sides are not interleaved (a run that alternated them would measure a
 * different pairing), and the callback stays out of the persisted report (it is
 * a function, and `report-json-roundtrip.test.ts` would fail if it leaked in).
 */
import { describe, it, expect } from 'vitest';
import { runAblation } from '../ablation.js';
import { runAblationReport } from '../report.js';
import { exactMatchScorer } from '../metrics.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';
import type { BenchmarkProgress } from '../benchmark.js';

const dataset: BenchmarkDataset = {
  name: 'progress-ablation',
  questions: [
    { id: 'a-1', capability: 'IE', question: 'Q1', expected: 'a', context: ['a'] },
    { id: 'a-2', capability: 'IE', question: 'Q2', expected: 'b', context: ['b'] },
    { id: 'a-3', capability: 'TR', question: 'Q3', expected: 'c', context: ['c'] },
  ],
};

function fixedSystem(name: string, answer: string): MemorySystem {
  return { name, answer: async () => answer };
}

function collect(): { events: BenchmarkProgress[]; onProgress: (p: BenchmarkProgress) => void } {
  const events: BenchmarkProgress[] = [];
  return { events, onProgress: (p) => events.push(p) };
}

describe('runAblation progress reporting', () => {
  it('reports the baseline side in full before the feature side begins', async () => {
    const { events, onProgress } = collect();
    await runAblation(dataset, fixedSystem('base', 'a'), fixedSystem('feat', 'a'), {
      runs: 1,
      scorer: exactMatchScorer,
      onProgress,
    });
    const sides = events.map((e) => e.system);
    // Every baseline event precedes every feature event. Asserted as a sequence
    // rather than as a count, because a count would pass on an interleaved order
    // -- and interleaving is what would break the same-job pairing.
    expect(sides).toEqual(['base', 'base', 'base', 'feat', 'feat', 'feat']);
    expect(events.every((e) => e.run === 0)).toBe(true);
    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('gives every repeated run its own ordinal on both sides', async () => {
    const { events, onProgress } = collect();
    await runAblation(dataset, fixedSystem('base', 'a'), fixedSystem('feat', 'a'), {
      runs: 3,
      scorer: exactMatchScorer,
      onProgress,
    });
    // The exact key set, so a dropped side or a collapsed run cannot pass. Runs
    // 1 and 2 re-evaluate BOTH systems, which is the loop this pins.
    const keys = new Set(events.map((e) => `${e.system}/${e.run}/${e.index}`));
    expect(keys.size).toBe(3 * 2 * 3);
    for (const run of [0, 1, 2]) {
      for (const system of ['base', 'feat']) {
        const forSide = events.filter((e) => e.system === system && e.run === run);
        expect(forSide.map((e) => e.index)).toEqual([0, 1, 2]);
      }
    }
  });

  it('is inert when no callback is supplied', async () => {
    // The control for the conditional forwarding in both this module and the
    // report runner: the absent path is the one every pre-existing caller used.
    const result = await runAblation(dataset, fixedSystem('base', 'a'), fixedSystem('feat', 'a'), {
      runs: 2,
      scorer: exactMatchScorer,
    });
    expect(result.featureCorrect).toHaveLength(3);
  });
});

describe('runAblationReport forwards progress without persisting it', () => {
  it('delivers events to the caller and keeps the callback out of the report', async () => {
    const { events, onProgress } = collect();
    const report = await runAblationReport(
      dataset,
      fixedSystem('base', 'a'),
      fixedSystem('feat', 'a'),
      { runs: 1, scorer: exactMatchScorer, onProgress },
    );
    expect(events).toHaveLength(6);
    // The report is serialized to JSON, and a function cannot survive that. This
    // is also why the option is a separate field and not a pass-through of the
    // whole options object.
    expect('onProgress' in report).toBe(false);
    expect(JSON.stringify(report)).not.toContain('onProgress');
  });
});

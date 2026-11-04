/**
 * The pace a run was under has to survive the run.
 *
 * ## Why this file exists at all
 *
 * §13.227 installed the pacing and put it on the gate line, and the gate line is a log. This
 * repository has that failure on record more than once -- `41393748964`'s reader identity lived only
 * in a container log, and §13.224 left the width in exactly the same place for exactly the same
 * reason. The block is the repair, and the repairs have to be tested where they are decided, not
 * where they are printed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAblationPool } from '../ablation.js';
import { passShapeLines, passShapeReport } from '../pass-shape.js';
import { formatAblationReport, runAblationReport } from '../report.js';
import { exactMatchScorer } from '../metrics.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

const dataset: BenchmarkDataset = {
  name: 'shape-fixture',
  questions: [
    { id: 'q1', question: 'one?', expected: 'a', capability: 'IE', context: ['a'] },
    { id: 'q2', question: 'two?', expected: 'a', capability: 'IE', context: ['a'] },
    { id: 'q3', question: 'three?', expected: 'a', capability: 'IE', context: ['a'] },
  ],
};

function fixedSystem(name: string, answer: string): MemorySystem {
  return { name, answer: async () => answer };
}

describe('passShapeReport keeps "nobody said" apart from "said zero"', () => {
  it('records an unset pace as null', () => {
    // `null` is not `0`. A deployment that considered its provider's rate and decided against a
    // floor has made a decision this artifact should show; one that said nothing has not, and an
    // artifact that folded them together would make an unconfigured run read as a deliberate one.
    expect(
      passShapeReport({
        workers: 1,
        pacing: { minIntervalMs: undefined, retryBudgetMs: undefined },
      }),
    ).toEqual({ workers: 1, minIntervalMs: null, retryBudgetMs: null });
  });

  it('keeps a stated zero as zero', () => {
    expect(passShapeReport({ workers: 4, pacing: { minIntervalMs: 0, retryBudgetMs: 0 } })).toEqual(
      {
        workers: 4,
        minIntervalMs: 0,
        retryBudgetMs: 0,
      },
    );
  });

  it('carries the width, which is the one of the three that changes what a duration means', () => {
    expect(
      passShapeReport({ workers: 8, pacing: { minIntervalMs: 6_000, retryBudgetMs: 600_000 } }),
    ).toEqual({ workers: 8, minIntervalMs: 6_000, retryBudgetMs: 600_000 });
  });
});

describe('passShapeLines states the three values and says what they are not', () => {
  it('names every value', () => {
    const lines = passShapeLines({ workers: 4, minIntervalMs: 6_000, retryBudgetMs: null });
    const text = lines.join('\n');
    expect(text).toContain('**4**');
    expect(text).toContain('**6000 ms**');
    expect(text).toContain('**default**');
  });

  it('renders an absent pace as none rather than as zero milliseconds', () => {
    // The control for the mapping above, at the other end of the pipe: a run with no pace must not
    // print a `0 ms` that a reader would take for a deliberately unthrottled deployment.
    const text = passShapeLines({ workers: 1, minIntervalMs: null, retryBudgetMs: null }).join(
      '\n',
    );
    expect(text).toContain('**none**');
    expect(text).not.toContain('**0 ms**');
  });

  it('prints a stated budget as the number, and the default as the word', () => {
    // The pair below is the whole point of `null`: `default` means the code's value, a number means
    // a deployment chose it. Rendering both as `default` would erase the only difference a reader
    // comparing two runs has, and rendering both as numbers would attribute the code's default to
    // whoever dispatched the run. `0` is the third case and is a number.
    const stated = passShapeLines({ workers: 1, minIntervalMs: null, retryBudgetMs: 1_800_000 });
    expect(stated.join('\n')).toContain('**1800000 ms**');
    expect(stated.join('\n')).not.toContain('**default**');
    expect(
      passShapeLines({ workers: 1, minIntervalMs: null, retryBudgetMs: 0 }).join('\n'),
    ).toContain('**0 ms**');
  });

  it('says the three are not the arm, in the section itself', () => {
    // A reader who finds this block and not the registration will otherwise assume the width is
    // part of the configuration `--registration` compares, which is the misreading that would make
    // a concurrency change look like an undeclared departure.
    const text = passShapeLines({ workers: 2, minIntervalMs: null, retryBudgetMs: null }).join(
      '\n',
    );
    expect(text).toContain('None of the three is part of the arm');
    expect(text).toContain('memoryArmConfig');
  });
});

describe('the report carries the shape from the option that configured the client', () => {
  it('attaches what the entry point resolved', async () => {
    const report = await runAblationReport(
      dataset,
      fixedSystem('base', 'a'),
      fixedSystem('feat', 'a'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        readerPacing: { minIntervalMs: 6_000, retryBudgetMs: 600_000 },
        pool: createAblationPool({
          workers: 4,
          first: { baseline: fixedSystem('base', 'a'), feature: fixedSystem('feat', 'a') },
          baselineFor: () => fixedSystem('base', 'a'),
          featureFor: () => fixedSystem('feat', 'a'),
        }),
      },
    );
    expect(report.passShape).toEqual({ workers: 4, minIntervalMs: 6_000, retryBudgetMs: 600_000 });
  });

  it('is absent when the caller did not resolve a pace', async () => {
    // Absent rather than a block of nulls: the reference pipeline entry never stated a pace, and an
    // artifact from it claiming `workers: 1` would be describing a fact it never resolved.
    const report = await runAblationReport(
      dataset,
      fixedSystem('base', 'a'),
      fixedSystem('feat', 'a'),
      {
        runs: 1,
        scorer: exactMatchScorer,
      },
    );
    expect('passShape' in report).toBe(false);
  });

  it('survives into the Markdown the artifact is read from', async () => {
    const report = await runAblationReport(
      dataset,
      fixedSystem('base', 'a'),
      fixedSystem('feat', 'a'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        readerPacing: { minIntervalMs: 6_000, retryBudgetMs: undefined },
      },
    );
    const markdown = formatAblationReport(report);
    expect(markdown).toContain('## The shape of the pass');
    expect(markdown).toContain('**6000 ms**');
  });
});

describe('the entry point that resolves the pace is the one that records it', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'cortex-memory', 'bench', 'run-ablation.ts'),
    'utf8',
  );

  it('passes the same resolution the gate line prints', () => {
    // One read, two uses. A second `readReaderPacing(process.env)` for the artifact would be a
    // second chance to record a pace the client did not run at -- the `41393748964` shape.
    expect(source.match(/readReaderPacing\(process\.env\)/g) ?? []).toHaveLength(1);
    expect(source).toContain('readerPacing: pacing');
  });

  it('and the arm forwards it instead of dropping it on the floor', () => {
    // The middle link, and the one a resolved option dies in: `run-ablation` names the pace,
    // `runCortexMemoryArm` has to hand it to `runAblationReport`, and a `...` spread that silently
    // omits one key is indistinguishable from an option nobody set. `41393748964` is the same
    // failure one option over, and it cost an afternoon.
    const arm = readFileSync(join(import.meta.dirname, '..', 'bench-memory-arm.ts'), 'utf8');
    expect(arm).toContain(
      '...(options.readerPacing === undefined ? {} : { readerPacing: options.readerPacing })',
    );
  });
});

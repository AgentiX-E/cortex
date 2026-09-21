/**
 * The job-summary renderer is a real code path and gets real tests.
 *
 * `tools/benchmark-summary.py` feeds a second, independent sink for the benchmark
 * numbers, added because a green run's artifact and logs were both unfetchable
 * (see `docs/OPS-UNFETCHABLE-ARTIFACT.md`). A summary is the archetype of code
 * that is never exercised until the day it is needed, and an untested summary
 * that throws would fail the very run it was added to make more robust.
 *
 * These tests run the actual script as a subprocess, because the contract that
 * matters is the file's behaviour, not a re-implementation of its logic in
 * TypeScript. Fixtures are the real persisted shapes: the recall curve is a
 * top-level LIST, and the ablation reports hold `null` where the live run held
 * `NaN` or an infinity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'tools/benchmark-summary.py');

let dir: string;

function run(dirPath: string): string {
  return execFileSync('python3', [SCRIPT, dirPath], { encoding: 'utf8' });
}

function write(name: string, data: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
}

/** A persisted ablation report: `null` where the live run held NaN/-Infinity. */
function ablationReport(extra: Record<string, unknown> = {}): unknown {
  return {
    dataset: 'longmemeval',
    questionCount: 500,
    baseline: { name: 'baseline', metrics: {} },
    feature: { name: 'feature', metrics: {} },
    generatedAt: '2026-09-20T09:45:00.000Z',
    ablation: {
      feature: 'feature',
      baselineAggregate: { min: 0.7, max: 0.7, avg: 0.7, median: 0.7 },
      featureAggregate: { min: 0.85, max: 0.85, avg: 0.85, median: 0.85 },
      delta: 0.15,
      // The persisted forms. These are what a real artifact holds.
      pValue: null,
      significant: false,
      effectSize: null,
      mcnemarPValue: 0.0039062500000000095,
      mcnemarSignificant: true,
      discordant: { baselineCorrectFeatureIncorrect: 1, baselineIncorrectFeatureCorrect: 2 },
      baselineConfidence: { lower: 0.6, upper: 0.8 },
      featureConfidence: { lower: 0.8, upper: 0.9 },
      baselineMetrics: {},
      featureMetrics: {},
      featureCorrect: [true],
      perCapability: {},
    },
    ...extra,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'summary-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('the job summary renders the persisted shapes', () => {
  it('renders an ablation report with its aggregate numbers', () => {
    write('benchmark-report.json', ablationReport());
    const out = run(dir);
    expect(out).toContain('## LongMemEval-S results');
    expect(out).toContain('### `benchmark-report`');
    expect(out).toContain('| questions | 500 |');
    expect(out).toContain('| baseline avg | 70.00% |');
    expect(out).toContain('| feature avg | 85.00% |');
    expect(out).toContain('| delta | 15.00% |');
  });

  it('renders a null p-value and effect size as n/a, never as a number', () => {
    // The whole point of the round-trip fix, restated for this consumer: a
    // fabricated `0.000` for Cohen's d reads as "no effect" when the truth is an
    // unbounded one, and a `0` p-value reads as overwhelming evidence when the
    // run produced none.
    write('benchmark-report.json', ablationReport());
    const out = run(dir);
    expect(out).toContain('| Welch p | n/a |');
    expect(out).toContain("| Cohen's d | n/a |");
    expect(out).not.toMatch(/\| Cohen's d \| 0\.000 \|/);
    expect(out).not.toMatch(/\| Welch p \| 0 \|/);
  });

  it('renders an incomplete cohort with the missing ids', () => {
    write(
      'benchmark-conjunction-ablation-report.json',
      ablationReport({
        cohortCoverage: {
          present: ['80ec1f4f_abs'],
          missing: ['6456829e_abs', 'edced276_abs'],
          ratio: 1 / 3,
        },
      }),
    );
    const out = run(dir);
    expect(out).toContain('INCOMPLETE');
    expect(out).toContain('6456829e_abs');
    expect(out).toContain('1/3');
  });

  it('renders a complete cohort as complete', () => {
    write(
      'benchmark-conjunction-ablation-report.json',
      ablationReport({
        cohortCoverage: { present: ['a', 'b'], missing: [], ratio: 1 },
      }),
    );
    const out = run(dir);
    expect(out).toContain('2/2 (complete)');
    expect(out).not.toContain('INCOMPLETE');
  });

  it('renders the retry-fire counts and their verdict', () => {
    write(
      'benchmark-mr-retry-ablation-report.json',
      ablationReport({
        retryFires: { controlFires: 0, treatmentFires: 1, questions: 60 },
      }),
    );
    const out = run(dir);
    expect(out).toContain('control 0, treatment 1 of 60');
    expect(out).toContain('1.67%');
    // The summary must carry the verdict, not just the counts: a bare number
    // leaves the reader to decide whether one fire means broken or merely weak.
    expect(out).toContain('under-powered');
  });

  it('flags a control that fired as invalid rather than as a null result', () => {
    write(
      'benchmark-mr-retry-ablation-report.json',
      ablationReport({
        retryFires: { controlFires: 2, treatmentFires: 3, questions: 60 },
      }),
    );
    const out = run(dir);
    expect(out).toContain('INVALID EXPERIMENT');
  });

  it('flags a treatment that never fired as inert', () => {
    write(
      'benchmark-mr-retry-ablation-report.json',
      ablationReport({
        retryFires: { controlFires: 0, treatmentFires: 0, questions: 60 },
      }),
    );
    const out = run(dir);
    expect(out).toContain('never fired');
  });

  it('renders the recall curve from the object form the writer now emits', () => {
    // The writer emits `{points, considered, excluded}`. A summary that assumed
    // a bare array printed `_Unexpected top-level type: dict_` and lost the one
    // table that separates a breadth failure from an ordering failure.
    write('benchmark-recall-curve.json', {
      points: [
        {
          k: 1,
          recalled: 142,
          recall: 0.3317757009345794,
          ceiling: 0.9626168224299065,
          gain: 0.6308411214953271,
        },
        {
          k: 50,
          recalled: 412,
          recall: 0.9626168224299065,
          ceiling: 0.9626168224299065,
          gain: 0,
        },
      ],
      considered: 428,
      excluded: [
        { questionId: 'a_abs', reason: 'abstention' },
        { questionId: 'b_abs', reason: 'abstention' },
        { questionId: 'ku1', reason: 'derived' },
      ],
    });
    const out = run(dir);
    expect(out).toContain('| k | recall | ceiling | gain |');
    expect(out).toContain('| 1 | 33.18% | 96.26% | 63.08% |');
    expect(out).toContain('| 50 | 96.26% | 96.26% | 0.00% |');
  });

  it('states the curve denominator and the shortfall by reason', () => {
    // The defect this guards: a curve over 428 questions was read as if it were
    // over the run's 500, because neither the artifact nor the summary said
    // otherwise. The exclusion may be correct; staying silent about it is not.
    write('benchmark-recall-curve.json', {
      points: [{ k: 1, recalled: 1, recall: 0.5, ceiling: 0.5, gain: 0 }],
      considered: 428,
      excluded: [
        { questionId: 'a_abs', reason: 'abstention' },
        { questionId: 'ku1', reason: 'derived' },
        { questionId: 'ku2', reason: 'derived' },
      ],
    });
    const out = run(dir);
    expect(out).toContain('Covered **428** questions');
    expect(out).toContain('Excluded **3**');
    expect(out).toContain('abstention 1');
    expect(out).toContain('derived 2');
  });

  it('renders the legacy bare-array curve without a denominator block', () => {
    // Older artifacts are a bare array and carry no denominator. The summary
    // must still render their table rather than treating the absence of
    // `considered` as a parse failure.
    write('benchmark-recall-curve.json', [
      {
        k: 1,
        recalled: 14,
        recall: 0.32558139534883723,
        ceiling: 0.9302325581395349,
        gain: 0.6046511627906976,
      },
      { k: 50, recalled: 40, recall: 0.9302325581395349, ceiling: 0.9302325581395349, gain: 0 },
    ]);
    const out = run(dir);
    expect(out).toContain('| k | recall | ceiling | gain |');
    expect(out).toContain('| 1 | 32.56% | 93.02% | 60.47% |');
    expect(out).not.toContain('Covered **');
  });
});

describe('the summary never fails the run it exists to protect', () => {
  it('exits zero with no reports at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'summary-empty-'));
    const out = run(empty);
    expect(out).toContain('## LongMemEval-S results');
    expect(out).toContain('No report JSON found');
    rmSync(empty, { recursive: true, force: true });
  });

  it('exits zero when a report is not valid JSON', () => {
    write('benchmark-report.json', { ok: true });
    writeFileSync(join(dir, 'benchmark-mr-ablation-report.json'), '{ not json');
    const out = run(dir);
    // The unparseable file is reported, not thrown, and the good file still
    // renders -- one bad report must not suppress the others.
    expect(out).toContain('Could not parse');
    expect(out).toContain('### `benchmark-report`');
  });

  it('reports an unrecognised shape instead of printing nothing', () => {
    write('benchmark-report.json', { unexpected: true });
    const out = run(dir);
    expect(out).toContain('No recognised report shape');
    expect(out).toContain('unexpected');
  });

  it('handles an unexpected top-level type without throwing', () => {
    write('benchmark-mr-ablation-report.json', 'a string');
    const out = run(dir);
    expect(out).toContain('Unexpected top-level type: str');
  });

  it('renders every report it finds, not just the first', () => {
    write('benchmark-report.json', ablationReport());
    write('benchmark-mr-ablation-report.json', ablationReport());
    write('benchmark-tr-ablation-report.json', ablationReport());
    const out = run(dir);
    expect(out).toContain('### `benchmark-report`');
    expect(out).toContain('### `benchmark-mr-ablation-report`');
    expect(out).toContain('### `benchmark-tr-ablation-report`');
  });
});

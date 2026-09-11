import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';
import * as cortexEval from '../index.js';

describe('createLongMemEvalMini', () => {
  it('returns a well-formed dataset', () => {
    const ds = createLongMemEvalMini();
    expect(ds.name).toBe('longmemeval-mini');
    expect(ds.questions.length).toBeGreaterThan(0);
    for (const q of ds.questions) {
      expect(q.id).toBeTruthy();
      expect(q.context.length).toBeGreaterThan(0);
      expect(['IE', 'MR', 'KU', 'TR', 'ABS']).toContain(q.capability);
    }
  });

  it('covers all five capabilities', () => {
    const ds = createLongMemEvalMini();
    const caps = new Set(ds.questions.map((q) => q.capability));
    expect(caps).toEqual(new Set(['IE', 'MR', 'KU', 'TR', 'ABS']));
  });

  it('marks abstention questions with null expected', () => {
    const ds = createLongMemEvalMini();
    for (const q of ds.questions.filter((x) => x.capability === 'ABS')) {
      expect(q.expected).toBeNull();
    }
  });
});

describe('package exports', () => {
  it('exposes the evaluation API surface', () => {
    expect(typeof cortexEval.computeMetrics).toBe('function');
    expect(typeof cortexEval.runBenchmark).toBe('function');
    expect(typeof cortexEval.runAblation).toBe('function');
    expect(typeof cortexEval.FactMemorySystem).toBe('function');
    expect(typeof cortexEval.createLongMemEvalMini).toBe('function');
  });

  it('exposes the P4 temporal-engine surface through the package root', () => {
    // The ablation runners and their two options live in the public surface: a
    // consumer drives the deterministic-coverage and time-window experiments
    // through them. Asserting the constants are NOT undefined matters more than
    // it looks — a renamed or dropped re-export resolves to `undefined`, and a
    // runner that reads `undefined` silently falls back to the engine's defaults
    // while still reporting a successful run. That is exactly how the
    // annotation arm was inert on its first TDD pass.
    expect(typeof cortexEval.runDeterministicCoverageAblation).toBe('function');
    expect(typeof cortexEval.runTimeWindowAnnotationAblation).toBe('function');
    expect(cortexEval.EXTENDED_ENGINE_OPTIONS).toBeDefined();
    expect(cortexEval.EXTENDED_ENGINE_OPTIONS).toEqual({
      extendedTimeRange: true,
      extendedSecondEventReference: true,
    });
    expect(cortexEval.TIME_WINDOW_ANNOTATION_HORIZON_DAYS).toBe(3);
  });

  it('exposes the between-run variance surface through the package root', () => {
    // Same guard as the temporal surface above, for the same reason: a dropped or
    // renamed re-export resolves to `undefined` at runtime, so an analysis script
    // would fail obscurely — or, worse, a caller would skip the floor check and
    // report an unguarded comparison as a result.
    expect(typeof cortexEval.summarizeVariance).toBe('function');
    expect(typeof cortexEval.compareQuestionVectors).toBe('function');
    expect(typeof cortexEval.requiredEffectSize).toBe('function');
  });

  it('keeps the extended engine strictly stronger than the default', () => {
    // The default configuration must leave every refinement OFF, or the graded
    // baseline silently inherits unmeasured behaviour and every ablation that
    // claims to isolate a refinement is measuring the wrong contrast.
    expect(cortexEval.EXTENDED_ENGINE_OPTIONS.extendedTimeRange).toBe(true);
    expect(cortexEval.EXTENDED_ENGINE_OPTIONS.extendedSecondEventReference).toBe(true);
    // A weekday-anchored question has no window without the refinement, and a
    // resolved one with it — the observable difference the arms depend on.
    expect(cortexEval.resolveTimeRange('What did I do last Saturday?', '2023/04/10')).toBeNull();
    expect(
      cortexEval.resolveTimeRange(
        'What did I do last Saturday?',
        '2023/04/10',
        cortexEval.EXTENDED_ENGINE_OPTIONS,
      ),
    ).toEqual({ start: '2023/04/08', end: '2023/04/08' });
  });
});

describe('typecheck coverage', () => {
  // `bench/run.ts` is an entry point, not a library module: it is executed by
  // `node --import tsx` and never imported, so neither the test suite nor the
  // build touches it. Its only guard is the compiler, and the compiler only
  // sees a file that some tsconfig `include`s.
  //
  // For a long time no tsconfig did. `tsconfig.json` includes `src` only, so an
  // undefined identifier in `bench/run.ts` — `hasDiagnosticRecord`, used but
  // never imported — survived `pnpm check` and reached a live paid benchmark
  // run, which failed 50 minutes in on `ReferenceError: hasDiagnosticRecord is
  // not defined`. ESLint did not catch it either: `no-undef` is off for
  // TypeScript, because the compiler owns that check. The two gates each assumed
  // the other covered the file.
  //
  // These assertions are the guard on the guard. They do not typecheck anything
  // themselves; they fail if the second tsconfig is removed, if `bench` stops
  // being the directory it includes, or if the `typecheck` script stops running
  // it — any of which reopens exactly this hole.
  const packageRoot = new URL('../../', import.meta.url);
  const readJson = (relative: string) =>
    JSON.parse(readFileSync(new URL(relative, packageRoot), 'utf8')) as {
      include?: string[];
      compilerOptions?: Record<string, unknown>;
      scripts?: Record<string, string>;
    };

  it('typechecks the bench entry point, which no other gate covers', () => {
    const benchTsconfig = readJson('tsconfig.bench.json');
    expect(benchTsconfig.include).toEqual(['bench']);
    // `noEmit` must be set: this project exists purely to check bench/, and
    // letting it emit would drop a second copy of the sources into dist/.
    expect(benchTsconfig.compilerOptions?.noEmit).toBe(true);
  });

  it('runs the bench typecheck as part of the package typecheck script', () => {
    const { scripts } = readJson('package.json');
    expect(scripts?.typecheck).toContain('tsconfig.bench.json');
  });

  it('keeps the build tsconfig scoped to src so bench is not published', () => {
    const buildTsconfig = readJson('tsconfig.json');
    expect(buildTsconfig.include).toEqual(['src']);
  });
});

import { describe, it, expect } from 'vitest';
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

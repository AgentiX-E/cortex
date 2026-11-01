/**
 * The portability classifier, the matrix it selects, and the guard that downgrades one way.
 *
 * ## What these tests are defending, in one sentence each
 *
 * `AUDIT-MODEL-PORTABILITY.md` argues that a deployment on an unmeasured reader can be made safe
 * without being measured against a labelled benchmark, provided three things hold: the classifier
 * refuses to guess, the matrix cannot be read without a classification, and the guard cannot move
 * in the direction that needs evidence it does not have. Each block below pins one of the three.
 *
 * ## Why the unverified cases are the interesting ones
 *
 * It is easy to write a classifier that passes everything and hard to write one that says so when it
 * does not know. The asymmetry matters because the two errors are not equally expensive: a false
 * `as-measured` publishes a number from a reader nobody checked, while a false `unverified` costs an
 * operator twenty-four calls. So the tests below are weighted toward the refusal — including the
 * case where a reader has both a failure and a gap, where the gap has to win.
 */
import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_PROBES,
  DegradationGuard,
  PORTABILITY_MATRIX,
  classifyPortability,
  configFor,
  type PortabilityBucket,
  type ProbeOutcome,
} from '../model-portability.js';

/** A report where every probe passed, which is the only fully-known state. */
const ALL_PASS: readonly ProbeOutcome[] = CAPABILITY_PROBES.map((probe) => ({
  id: probe.id,
  passed: true,
}));

/** The same report with the named probes flipped. */
function withFailures(...ids: readonly string[]): readonly ProbeOutcome[] {
  const failing = new Set(ids);
  return CAPABILITY_PROBES.map((probe) => ({ id: probe.id, passed: !failing.has(probe.id) }));
}

describe('the probe set', () => {
  it('names every id exactly once', () => {
    const ids = CAPABILITY_PROBES.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cites a reading for every probe, because an uncited probe is a guess about what to ask', () => {
    for (const probe of CAPABILITY_PROBES) {
      expect(probe.evidence.length, probe.id).toBeGreaterThan(20);
      expect(probe.asks.length, probe.id).toBeGreaterThan(20);
    }
  });

  it('pins the must-pass set, because it is what makes a bucket a bucket', () => {
    const mustPass = CAPABILITY_PROBES.filter((probe) => probe.mustPass).map((probe) => probe.id);
    // Exact rather than "contains": a probe promoted to must-pass without one, or demoted with one,
    // changes how many calls an operator spends and which readers get refused, and it has to show
    // up as a diff here rather than arrive as a quiet edit.
    expect(mustPass).toEqual([
      'answer-round-trip',
      'answer-not-transcript',
      'abstain-token',
      'context-tail',
      'sample-repeat',
      'latency-plain',
    ]);
    // The soft side has to be non-empty, or `guarded` would be an unreachable bucket.
    expect(CAPABILITY_PROBES.some((probe) => !probe.mustPass)).toBe(true);
  });

  it('probes what the parser rejects rather than what the prompt would prefer', () => {
    // The first version of this set demanded the `Answer:` label and a single-line reply, and made
    // both must-pass. Run 41254359622 archived 500 outputs at 90.45%: zero carried the label and
    // 161 were multi-line. Both probes would have failed the reader that produced the campaign's
    // best number, so the set now names the four shape rejections the pipeline actually has.
    const ids = CAPABILITY_PROBES.map((probe) => probe.id);
    for (const absent of ['format-label', 'format-single-line']) {
      expect(ids, absent).not.toContain(absent);
    }
    // And every must-pass probe is one whose failure loses the answer rather than costing calls.
    expect(CAPABILITY_PROBES.filter((p) => p.mustPass).map((p) => p.dimension)).toEqual([
      'answer-fidelity',
      'answer-fidelity',
      'abstention-lexicon',
      'context-window',
      'sampling-stability',
      'latency-envelope',
    ]);
  });

  it('keeps the must-pass count at six, because the probe budget is priced from it', () => {
    // `tools/probe-budget.py` prints `5 repeats x 6 must-pass probes = 30 calls`. A seventh
    // must-pass probe silently makes that sentence false, and the sentence is what an operator
    // decides on.
    expect(CAPABILITY_PROBES.filter((probe) => probe.mustPass)).toHaveLength(6);
    expect(CAPABILITY_PROBES).toHaveLength(12);
  });
});

describe('classification', () => {
  it('is as-measured when every probe passed', () => {
    const result = classifyPortability(ALL_PASS);
    expect(result).toEqual({ kind: 'verified', bucket: 'as-measured', blocking: [], soft: [] });
  });

  it('is guarded when only a soft probe failed, and names which one', () => {
    const result = classifyPortability(withFailures('step2-only'));
    expect(result).toEqual({
      kind: 'verified',
      bucket: 'guarded',
      blocking: [],
      soft: ['step2-only'],
    });
  });

  it('is minimal when a must-pass probe failed, and keeps the soft failures too', () => {
    const result = classifyPortability(withFailures('abstain-token', 'context-48k'));
    expect(result).toEqual({
      kind: 'verified',
      bucket: 'minimal',
      blocking: ['abstain-token'],
      soft: ['context-48k'],
    });
  });

  it('is unverified when a must-pass probe is absent, and says which one', () => {
    const partial = ALL_PASS.filter((outcome) => outcome.id !== 'sample-repeat');
    expect(classifyPortability(partial)).toEqual({
      kind: 'unverified',
      missing: ['sample-repeat'],
    });
  });

  it('reports a gap ahead of a failure, because a gap could hide a second failure', () => {
    // `abstain-token` failed and `sample-repeat` was never asked. Both are must-pass; the answer
    // must not be `minimal`, because the unasked probe might have failed as well and the deployment
    // would then be configured from a partial picture.
    const partial = withFailures('abstain-token').filter((o) => o.id !== 'sample-repeat');
    expect(classifyPortability(partial)).toEqual({
      kind: 'unverified',
      missing: ['sample-repeat'],
    });
  });

  it('ignores a soft probe that was never asked, since soft failures only lower the bucket', () => {
    const partial = ALL_PASS.filter((outcome) => outcome.id !== 'step2-only');
    expect(classifyPortability(partial)).toEqual({
      kind: 'verified',
      bucket: 'as-measured',
      blocking: [],
      soft: [],
    });
  });

  it('ignores an id it does not know, so a newer prober and an older classifier can ship apart', () => {
    const report = [...ALL_PASS, { id: 'probe-from-the-future', passed: false }];
    expect(classifyPortability(report)).toEqual({
      kind: 'verified',
      bucket: 'as-measured',
      blocking: [],
      soft: [],
    });
  });

  it('rejects a duplicated id rather than letting array order decide', () => {
    const report = [...ALL_PASS, { id: 'answer-round-trip', passed: false }];
    expect(() => classifyPortability(report)).toThrow(/answer-round-trip.*reported twice/s);
  });

  it('prints failures in probe order, not in report order', () => {
    const reversed = [...withFailures('abstain-token', 'context-48k')].reverse();
    const result = classifyPortability(reversed);
    expect(result.kind === 'verified' && result.blocking).toEqual(['abstain-token']);
    expect(result.kind === 'verified' && result.soft).toEqual(['context-48k']);
  });

  it('is unverified on an empty report rather than passing by default', () => {
    const result = classifyPortability([]);
    expect(result.kind).toBe('unverified');
    expect(result.kind === 'unverified' && result.missing.length).toBeGreaterThan(0);
  });
});

describe('the matrix', () => {
  const buckets: readonly PortabilityBucket[] = ['as-measured', 'guarded', 'minimal'];

  it('has a row for every bucket, so no classification is configurable-by-accident', () => {
    expect(Object.keys(PORTABILITY_MATRIX).sort()).toEqual([...buckets].sort());
  });

  it('cites evidence on every cell of every row', () => {
    for (const bucket of buckets) {
      for (const [name, cell] of Object.entries(PORTABILITY_MATRIX[bucket])) {
        expect(cell.evidence.length, `${bucket}.${name}`).toBeGreaterThan(20);
        expect(['arithmetic', 'measured-single-model'], `${bucket}.${name}`).toContain(cell.scope);
      }
    }
  });

  it('never widens a budget as the bucket weakens, which is the one direction that cannot be argued', () => {
    const contract = PORTABILITY_MATRIX['as-measured'].contextChars.value;
    const guarded = PORTABILITY_MATRIX.guarded.contextChars.value;
    const minimal = PORTABILITY_MATRIX.minimal.contextChars.value;
    // Non-widening, not strict decrease. These were `<` while the rows read 96k / 48k / 24k, which
    // was a ladder built on a budget the register had declined: §13.118.1 measured 96,000 as no
    // better than 48,000 at twice the prompt, so the top rung came down to the adopted value and
    // the rungs below it had nowhere to go. Leaving `<` here would have forced a fourth number
    // nobody measured, and inventing a value to satisfy a test is the wrong repair.
    expect(guarded).toBeLessThanOrEqual(contract);
    expect(minimal).toBeLessThanOrEqual(guarded);
    // What must still hold is that the ladder is not flat: a row that changed nothing would be a
    // bucket with no behaviour, which is worse than a bucket with a small one.
    for (const [weaker, stronger] of [
      [PORTABILITY_MATRIX.guarded, PORTABILITY_MATRIX['as-measured']],
      [PORTABILITY_MATRIX.minimal, PORTABILITY_MATRIX.guarded],
    ] as const) {
      const moved = (Object.keys(stronger) as (keyof typeof stronger)[]).filter(
        (field) => weaker[field].value !== stronger[field].value,
      );
      expect(moved.length).toBeGreaterThan(0);
    }
  });

  it('never shortens a deadline as the bucket weakens, since a weak reader is the slower one', () => {
    const contract = PORTABILITY_MATRIX['as-measured'].readerTimeoutMs.value;
    const guarded = PORTABILITY_MATRIX.guarded.readerTimeoutMs.value;
    const minimal = PORTABILITY_MATRIX.minimal.readerTimeoutMs.value;
    expect(guarded).toBeGreaterThan(contract);
    expect(minimal).toBeGreaterThan(guarded);
  });

  it('keeps temperature pinned in every row, because absence is the state §13.114 could not recover', () => {
    for (const bucket of buckets) {
      expect(PORTABILITY_MATRIX[bucket].temperature.value, bucket).toBe(0);
    }
  });

  it('keeps heading stripping on in every row, since dropping it converts an echo into an answer', () => {
    for (const bucket of buckets) {
      expect(PORTABILITY_MATRIX[bucket].parseTolerance.value, bucket).toBe('heading-stripping');
    }
  });

  it('labels the shipped row as single-model evidence rather than cross-model', () => {
    // No cell in this matrix has been confirmed on a second provider yet. If that changes, this
    // assertion is the one to delete — deliberately, with the reading that earned it.
    const scopes = Object.values(PORTABILITY_MATRIX['as-measured']).map((cell) => cell.scope);
    expect(scopes.every((scope) => scope !== ('measured-cross-model' as string))).toBe(true);
  });
});

describe('configFor', () => {
  it('returns the row the classification named', () => {
    const config = configFor({ kind: 'verified', bucket: 'guarded', blocking: [], soft: ['x'] });
    expect(config).toBe(PORTABILITY_MATRIX.guarded);
  });

  it('throws on an unverified reader rather than handing it the shipped row', () => {
    expect(() => configFor({ kind: 'unverified', missing: ['answer-round-trip'] })).toThrow(
      /unverified.*answer-round-trip.*13\.114/s,
    );
  });
});

describe('the degradation guard', () => {
  /** Call the guard `times` times, placing `signal` on the calls named by `at`. */
  function observe(guard: DegradationGuard, times: number, signalAt: readonly number[] = []): void {
    const at = new Set(signalAt);
    for (let call = 1; call <= times; call += 1) {
      guard.observe(at.has(call) ? 'parse-failed' : undefined);
    }
  }

  it('does not downgrade on two failures in a window of twenty', () => {
    const guard = new DegradationGuard('as-measured');
    observe(guard, 20, [3, 11]);
    expect(guard.bucket).toBe('as-measured');
    expect(guard.downgrades).toEqual([]);
  });

  it('downgrades one step on three failures in a window of twenty', () => {
    const guard = new DegradationGuard('as-measured');
    observe(guard, 20, [3, 11, 19]);
    expect(guard.bucket).toBe('guarded');
    expect(guard.downgrades).toEqual([
      { from: 'as-measured', to: 'guarded', signal: 'parse-failed', observed: 3 },
    ]);
  });

  it('never upgrades, however many clean calls follow', () => {
    const guard = new DegradationGuard('as-measured');
    observe(guard, 20, [1, 2, 3]);
    observe(guard, 400);
    expect(guard.bucket).toBe('guarded');
  });

  it('stops at minimal after a second window, and records both steps', () => {
    const guard = new DegradationGuard('as-measured');
    observe(guard, 20, [1, 2, 3]);
    observe(guard, 20, [1, 2, 3]);
    expect(guard.bucket).toBe('minimal');
    expect(guard.downgrades.map((step) => step.to)).toEqual(['guarded', 'minimal']);
  });

  it('does not accumulate across windows, so one failure per window never fires', () => {
    const guard = new DegradationGuard('as-measured');
    observe(guard, 20, [5]);
    observe(guard, 20, [5]);
    observe(guard, 20, [5]);
    expect(guard.bucket).toBe('as-measured');
  });

  it('is inert at minimal rather than counting calls it cannot act on', () => {
    const guard = new DegradationGuard('minimal');
    observe(guard, 100, [1, 2, 3, 4]);
    expect(guard.bucket).toBe('minimal');
    expect(guard.downgrades).toEqual([]);
  });

  it('names one signal deterministically when two would both fire', () => {
    // `parse-failed` and `deadline-exceeded` both reach three. The recorded signal must not depend
    // on which arrived first, or two deployments with the same 20 calls would explain themselves
    // differently — AUDIT-DISCORDANT-IDENTITY's shape.
    const forward = new DegradationGuard('as-measured');
    for (let call = 0; call < 20; call += 1) {
      forward.observe(call < 3 ? 'deadline-exceeded' : call < 6 ? 'parse-failed' : undefined);
    }
    const backward = new DegradationGuard('as-measured');
    for (let call = 0; call < 20; call += 1) {
      backward.observe(call < 3 ? 'parse-failed' : call < 6 ? 'deadline-exceeded' : undefined);
    }
    expect(forward.downgrades).toEqual(backward.downgrades);
    expect(forward.downgrades[0]?.signal).toBe('parse-failed');
  });

  it('counts an unobservable call toward the window, since the window is calls', () => {
    const guard = new DegradationGuard('as-measured');
    // 17 calls with nothing observable, then three signals: the twentieth call closes the window.
    // If the plain calls were not counted, this would need twenty of the 23 to fire the trigger.
    observe(guard, 17);
    guard.observe('empty-completion');
    guard.observe('empty-completion');
    expect(guard.bucket).toBe('as-measured');
    guard.observe('empty-completion');
    expect(guard.bucket).toBe('guarded');
    expect(guard.downgrades[0]?.observed).toBe(3);
  });
});

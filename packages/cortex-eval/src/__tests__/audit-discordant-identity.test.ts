/**
 * `tools/audit-discordant-identity.py` exists because roadmap item 9b asked for
 * the conjunction arm's four regressions to be *located*, and the archived
 * artifacts cannot do it -- they carry the flip count, the feature's
 * per-question vector, and a per-capability breakdown, but never the question
 * ids behind the flips and never the baseline's vector. That gap is now closed
 * going forward by `discordantQuestions`; this tool extracts what the existing
 * archive still supports and says plainly where it stops.
 *
 * The tests run the real script as a subprocess, because the contract that
 * matters is the file's behaviour: the exit status, the table it prints, and the
 * distinction between "verified" and "unverifiable". The fixtures are synthetic
 * reports written to a temporary directory, so the tests do not depend on
 * whatever artifacts happen to be on the machine.
 *
 * ## Why the discrimination tests are the important ones
 *
 * The tool's whole value is refusing to answer when the evidence does not
 * support an answer. A version that guessed which IE questions regressed would
 * print exactly the same shape of output while manufacturing a finding, so these
 * tests pin the three cases apart: blocks that verify, blocks that cannot be
 * verified, and an ABS population that moved.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(REPO_ROOT, 'tools/audit-discordant-identity.py');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync('python3', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * A minimal report whose feature vector is exactly the IE block followed by the
 * ABS block, so the block arithmetic is stated rather than implied.
 */
function report(options: {
  ieTotal: number;
  ieFeatureCorrect: number;
  absTotal: number;
  absFeatureCorrect: number;
  ieRegressions?: number;
  ieGains?: number;
  absRegressions?: number;
  absGains?: number;
  cohort?: string[];
}): unknown {
  const {
    ieTotal,
    ieFeatureCorrect,
    absTotal,
    absFeatureCorrect,
    ieRegressions = 0,
    ieGains = 0,
    absRegressions = 0,
    absGains = 0,
    cohort = [],
  } = options;
  // Build the vector to match the requested per-capability true-counts. The
  // exact arrangement inside each block is irrelevant to the tool, which reads
  // only counts from positions it has already verified.
  const vector = [
    ...Array.from({ length: ieFeatureCorrect }, () => true),
    ...Array.from({ length: ieTotal - ieFeatureCorrect }, () => false),
    ...Array.from({ length: absFeatureCorrect }, () => true),
    ...Array.from({ length: absTotal - absFeatureCorrect }, () => false),
  ];
  return {
    dataset: 'longmemeval-conjunction',
    questionCount: ieTotal + absTotal,
    baseline: { name: 'conjunction-fused', metrics: {} },
    feature: { name: 'conjunction-decomposed', metrics: {} },
    generatedAt: '2026-09-22T00:00:00.000Z',
    ...(cohort.length > 0 ? { cohortCoverage: { present: cohort, missing: [], ratio: 1 } } : {}),
    ablation: {
      feature: 'conjunction-decomposed',
      delta: -0.0167,
      discordant: {
        baselineCorrectFeatureIncorrect: ieRegressions + absRegressions,
        baselineIncorrectFeatureCorrect: ieGains + absGains,
      },
      featureCorrect: vector,
      perCapability: {
        IE: {
          total: ieTotal,
          featureCorrect: ieFeatureCorrect,
          baselineCorrectFeatureIncorrect: ieRegressions,
          baselineIncorrectFeatureCorrect: ieGains,
        },
        ABS: {
          total: absTotal,
          featureCorrect: absFeatureCorrect,
          baselineCorrectFeatureIncorrect: absRegressions,
          baselineIncorrectFeatureCorrect: absGains,
        },
      },
    },
  };
}

function withArtifacts(files: Record<string, unknown>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'discordant-audit-'));
  for (const [name, data] of Object.entries(files)) {
    const sub = join(dir, name);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'benchmark-conjunction-ablation-report.json'), JSON.stringify(data));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * An artifact whose vector TOTAL is right but whose blocks are not — which is
 * what a report written under an older question ordering looks like.
 *
 * Constructing this needs care: moving a `true` across the block boundary
 * changes the total unless the ABS block has a `false` to trade for it. So the
 * fixture gives ABS one failure (`absFeatureCorrect < absTotal`), which is also
 * the realistic case — the conjunction arm's ABS block always has at most one.
 */
function orderingMismatchedReport(): unknown {
  const data = report({
    ieTotal: 4,
    ieFeatureCorrect: 3,
    absTotal: 2,
    absFeatureCorrect: 1,
  }) as { ablation: { featureCorrect: boolean[] } };
  // [T,T,T,F | T,F] -> swap the boundary pair -> [T,T,T,T | F,F].
  // Total stays 4, IE block becomes 4 (want 3), ABS block becomes 0 (want 1).
  data.ablation.featureCorrect[3] = true;
  data.ablation.featureCorrect[4] = false;
  return data;
}

describe('audit-discordant-identity CLI', () => {
  it('exits 1 with a message when no artifact is present, not with a traceback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discordant-empty-'));
    try {
      const r = run([dir]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('No benchmark-conjunction-ablation-report.json found');
      expect(r.stderr).not.toContain('Traceback');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies a well-formed artifact and says so', () => {
    const { dir, cleanup } = withArtifacts({
      run_a: report({
        ieTotal: 4,
        ieFeatureCorrect: 3,
        absTotal: 2,
        absFeatureCorrect: 2,
        ieRegressions: 1,
      }),
    });
    try {
      const r = run([dir]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Block verification: 1/1 artifacts verified.');
      expect(r.stdout).toContain('ok');
      expect(r.stdout).not.toContain('not verifiable');
    } finally {
      cleanup();
    }
  });

  it('reports an ordering-mismatched artifact as unverifiable rather than as ok', () => {
    const { dir, cleanup } = withArtifacts({ run_stale: orderingMismatchedReport() });
    try {
      const r = run([dir]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('all-true');
      expect(r.stdout).toContain('predates the current question ordering');
      expect(r.stdout).toContain('0/1 artifacts verified');
    } finally {
      cleanup();
    }
  });

  it('still counts an unverifiable artifact toward the ABS totals', () => {
    // Per-capability counts do not depend on ordering, so excluding them would
    // understate the evidence for the finding that decides P2 and P3.
    const { dir, cleanup } = withArtifacts({ run_stale: orderingMismatchedReport() });
    try {
      const r = run([dir]);
      expect(r.stdout).toContain('ABS questions scored : 2');
    } finally {
      cleanup();
    }
  });

  it('declares the target population clean when it never moved', () => {
    const { dir, cleanup } = withArtifacts({
      lm_report: report({
        ieTotal: 150,
        ieFeatureCorrect: 141,
        absTotal: 30,
        absFeatureCorrect: 29,
        ieRegressions: 4,
        ieGains: 1,
        cohort: ['6456829e_abs', 'edced276_abs'],
      }),
    });
    try {
      const r = run([dir]);
      expect(r.stdout).toContain('ABS questions scored : 30');
      expect(r.stdout).toContain('ABS flips (either)   : 0');
      expect(r.stdout).toContain('P2 (target abstains -> ABS 30/30) is therefore refuted');
      // The target's presence must be reported, because P2 is unscoreable if the
      // cohort member is absent -- the difference between "refuted" and "not run".
      expect(r.stdout).toContain('Runs with the P2 target present');
      expect(r.stdout).toContain('cohort 2/7');
    } finally {
      cleanup();
    }
  });

  it('refuses to resolve the IE ambiguity, stating its size instead', () => {
    // 9 IE failures with 4 regressions admits C(9,4) = 126 consistent
    // assignments. Naming one would be a fabrication.
    const { dir, cleanup } = withArtifacts({
      lm_report: report({
        ieTotal: 150,
        ieFeatureCorrect: 141,
        absTotal: 30,
        absFeatureCorrect: 29,
        ieRegressions: 4,
        ieGains: 1,
      }),
    });
    try {
      const r = run([dir]);
      expect(r.stdout).toContain('which 4 is not recoverable');
      expect(r.stdout).toContain('baseline per-question vector absent');
    } finally {
      cleanup();
    }
  });

  it('flags an ABS population that did move instead of reporting zero', () => {
    // The negative finding must be contingent on the measurement, so a fixture
    // where ABS moves has to produce different output. Without this case the
    // "zero flips" assertion could pass for a tool that always prints zero.
    const { dir, cleanup } = withArtifacts({
      moved: report({
        ieTotal: 4,
        ieFeatureCorrect: 3,
        absTotal: 2,
        absFeatureCorrect: 2,
        absGains: 1,
      }),
    });
    try {
      const r = run([dir]);
      expect(r.stdout).toContain('ABS flips (either)   : 1');
      expect(r.stdout).toContain('1 ABS flip(s) observed -- inspect before concluding.');
      expect(r.stdout).not.toContain('P2 (target abstains -> ABS 30/30) is therefore refuted');
    } finally {
      cleanup();
    }
  });

  it('accepts a glob and several directories in one invocation', () => {
    const { dir, cleanup } = withArtifacts({
      run_a: report({ ieTotal: 4, ieFeatureCorrect: 4, absTotal: 2, absFeatureCorrect: 2 }),
      run_b: report({ ieTotal: 4, ieFeatureCorrect: 4, absTotal: 3, absFeatureCorrect: 3 }),
    });
    try {
      const r = run([join(dir, '*')]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Block verification: 2/2 artifacts verified.');
      expect(r.stdout).toContain('ABS questions scored : 5');
    } finally {
      cleanup();
    }
  });
});

/**
 * The dataset fingerprint reaches the report and the Markdown, or it does not exist.
 *
 * Two failure modes are being closed here, and both have already cost this campaign a
 * run each:
 *
 * 1. **A value computed and then lost on the way to the renderer.** The repository has
 *    removed this side channel three times (`cohortCoverage`, `retryFires`,
 *    `abstentionReasons`), every time after an artifact reported a number whose
 *    condition was missing from the document a human opens. The digest is the same
 *    shape of claim: a score without the file it was scored against is half a reading.
 * 2. **An absent field rendered as an empty one.** A dataset constructed in code has no
 *    file, and `Dataset file: \`\`` would read as "read a file, it was empty" rather
 *    than "read no file". The absent branch is the only branch that says that, which is
 *    the rule `abstentionReasons` documents and this test enforces for the digest.
 *
 * The round-trip assertion is not ceremony either: `report-json-roundtrip.test.ts`
 * exists because a persisted report is re-rendered long after its run, and any field
 * that survives `JSON.stringify` but not `formatAblationReport` is invisible exactly
 * when someone goes looking for it.
 */
import { describe, it, expect } from 'vitest';
import { formatAblationReport, runAblationReport } from '../report.js';
import { FactMemorySystem } from '../fact-memory.js';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';

const FINGERPRINT = `sha256:${'ab'.repeat(32)}`;

describe('datasetFingerprint in the report', () => {
  it('is absent, not empty, when the caller read no file', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const report = await runAblationReport(ds, baseline, feature, { runs: 1 });

    // `in` rather than `=== undefined`: an explicit `undefined` key serialises to
    // nothing but is a different object, and the artifact writer spreads the report.
    expect('datasetFingerprint' in report).toBe(false);
    expect(formatAblationReport(report)).not.toContain('Dataset file:');
  });

  it('reaches the report and the Markdown exactly as it was taken', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const report = await runAblationReport(ds, baseline, feature, {
      runs: 1,
      datasetFingerprint: FINGERPRINT,
    });

    expect(report.datasetFingerprint).toBe(FINGERPRINT);

    const markdown = formatAblationReport(report);
    expect(markdown).toContain(`- Dataset file: \`${FINGERPRINT}\``);
    // Under the name, and above every number: the two lines are one claim, and a digest
    // printed below the results is a footnote rather than a condition on them.
    const lines = markdown.split('\n');
    const datasetLine = lines.findIndex((line) => line.startsWith('- Dataset: '));
    const fingerprintLine = lines.findIndex((line) => line.startsWith('- Dataset file: '));
    expect(datasetLine).toBeGreaterThan(-1);
    expect(fingerprintLine).toBe(datasetLine + 1);
  });

  it('survives the JSON round-trip that every archived artifact goes through', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const report = await runAblationReport(ds, baseline, feature, {
      runs: 1,
      datasetFingerprint: FINGERPRINT,
    });

    // Byte-identity between the live render and the persisted render is NOT the
    // invariant, and asserting it would pin a defect: a live report holds `NaN` and
    // `Infinity` in its p-values, `JSON.stringify` writes `null`, and the two render
    // differently by design. That is what `report-json-roundtrip.test.ts` measures.
    // The invariant that matters here is narrower and is the one a re-rendered
    // artifact reader depends on: the digest is still there, and it is still above the
    // results.
    const persisted: unknown = JSON.parse(JSON.stringify(report));
    const parsed = persisted as typeof report;
    expect(parsed.datasetFingerprint).toBe(FINGERPRINT);

    const lines = formatAblationReport(parsed).split('\n');
    const datasetLine = lines.findIndex((line) => line.startsWith('- Dataset: '));
    expect(lines[datasetLine + 1]).toBe(`- Dataset file: \`${FINGERPRINT}\``);
  });
});

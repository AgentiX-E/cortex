/**
 * Grade the answers a dead run recorded, without re-running the arm.
 *
 * ## Why this exists
 *
 * `41625442265` was dispatched to test §13.234's four predictions at `relevanceTopK=512`. It reached
 * question 146 of the fifth pass and was killed by its own ceiling: the eight passes needed 400
 * minutes of pacing alone and the budget was 340 (`§13.237`). No report was written, so the
 * predictions are still untested.
 *
 * What the artifact does hold is `completed[]` with **two complete repetitions of both arms** --
 * 2,000 answers, and `Answer` is `string | null`, so nothing is lost in the recording. The arm's own
 * channel census (structural 556, exact 485, numeric 204, judge 755 of 2,000) says the grading is
 * reproducible from the answers alone.
 *
 * So the measurement exists and its report does not. This produces the report.
 *
 * ## What it will not do
 *
 * It does not re-answer, so it cannot recover the passes that never ran, and it reports what
 * `completed[]` holds rather than the four repetitions the dispatch asked for. It does not
 * interpolate, and it does not touch the other side of the pair. The two arms are replayed from the
 * same record and scored by the same instrument, which is the pairing the live arm had.
 *
 * ## The alignment claim
 *
 * The recorded list is aligned to the dataset by index, and the index is meaningful only relative to
 * `loadLongMemEval(sampleInstances(parsed, 0))` -- file order, no sampling. `REGRADE_EXPECT_IDS`
 * carries `<index>:<question-id>` pairs taken from the dead run's own progress log (`q=1/500
 * id=e47becba` and two more), and the script refuses to grade if any of them does not match. Without
 * that check, a dataset file that had moved would produce a full, plausible report for a pairing
 * nobody made.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createJudgeFromEnv,
  describeJudgeTransport,
  fingerprintBytes,
  formatAblationReport,
  judgeScorer,
  createLlmJudge,
  loadLongMemEval,
  readCompletedPasses,
  replaySystem,
  runAblationReport,
  sampleInstances,
  type AblationReport,
  type Capability,
  type LongMemEvalInstance,
} from '@agentix-e/cortex-eval';

/** The abilities the artifact reports, in the order its tables use. */
const CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

/** `<index>:<question-id>` pairs, comma separated. See the header for why they are not optional. */
function readExpectedIds(raw: string | undefined): [number, string][] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((piece): [number, string] => {
      const [index, id] = piece.split(':');
      if (index === undefined || id === undefined || !/^\d+$/.test(index.trim())) {
        throw new Error(
          `REGRADE_EXPECT_IDS entry ${JSON.stringify(piece)} is not <index>:<question-id>`,
        );
      }
      return [Number(index.trim()), id.trim()];
    });
}

function pct(correct: number, total: number): string {
  return total === 0 ? 'n/a' : `${((correct / total) * 100).toFixed(2)}%`;
}

/** A per-run summary line for an arm, with the multi-session count the predictions are stated in. */
function armLine(label: string, report: AblationReport, side: 'baseline' | 'feature'): string {
  const metrics = report[side].metrics;
  const mr = metrics.perCapability.MR;
  return (
    `| ${label} | ${metrics.correct}/${metrics.total} | ${pct(metrics.correct, metrics.total)} | ` +
    `${CAPABILITIES.map((c) => pct(metrics.perCapability[c].correct, metrics.perCapability[c].total)).join(' | ')} | ` +
    `${mr.correct}/${mr.total} |`
  );
}

async function main(): Promise<void> {
  const datasetPath = required('LONGMEMEVAL_PATH');
  const partialPath = required('PARTIAL_PATH');
  const rawDataset = readFileSync(datasetPath);
  const parsed = JSON.parse(rawDataset.toString('utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`LONGMEMEVAL_PATH must contain a JSON array, got ${typeof parsed}`);
  }
  // File order and no sampling, which is the order the dead run graded: `LIMIT` was unset.
  const dataset = loadLongMemEval(sampleInstances(parsed as LongMemEvalInstance[], 0));
  const fingerprint = fingerprintBytes(rawDataset);
  console.log(
    `Dataset fingerprint: ${fingerprint} (${parsed.length} instances in file, ` +
      `${dataset.questions.length} graded after sampling)`,
  );

  const expected = readExpectedIds(process.env['REGRADE_EXPECT_IDS']);
  for (const [index, id] of expected) {
    const actual = dataset.questions[index]?.id;
    if (actual !== id) {
      throw new Error(
        `alignment check failed at index ${index}: the dead run graded ${JSON.stringify(id)} there ` +
          `and this file has ${JSON.stringify(actual)}. The recorded answers are aligned by index, ` +
          'so grading them against this file would produce a full report for a pairing nobody made.',
      );
    }
  }
  console.log(
    `Alignment: ${expected.length} index/id pair(s) confirmed against the dispatched run's progress log`,
  );

  const record = JSON.parse(readFileSync(partialPath, 'utf8')) as unknown;
  const passes = readCompletedPasses(record);
  console.log(
    `Record: ${passes.length} completed repetition(s), runs ${passes.map((p) => p.run).join(', ')}`,
  );

  // The same instrument the live arm scores with, assembled the same way: `judgeScorer` runs the
  // structural, exact and numeric channels first and calls the model only for the remainder, and
  // that order is what makes 2,000 gradings cost 755 requests.
  const judgeLlm = createJudgeFromEnv(process.env);
  console.log(describeJudgeTransport());
  const scorer = judgeScorer(createLlmJudge(judgeLlm));

  const lines: string[] = [
    '# Regrade of a recorded pass',
    '',
    `- Source artifact: \`${partialPath}\``,
    `- Dataset: \`${datasetPath}\` (${fingerprint})`,
    `- Repetitions replayed: ${passes.length} (runs ${passes.map((p) => p.run).join(', ')})`,
    `- Alignment: ${expected.length} index/id pair(s) confirmed against the dispatched run's log`,
    '',
    'The answers are the dead run\'s own, replayed through the scorer that was going to grade them. ' +
      'No answer was regenerated, no missing pass was filled in, and each side is replayed from its ' +
      'own list.',
    '',
    '| arm | correct/total | accuracy | ' +
      `${CAPABILITIES.join(' | ')} | MR |`,
    `| --- | --- | --- | ${CAPABILITIES.map(() => '---').join(' | ')} | --- |`,
  ];

  const json: Record<string, unknown> = {
    source: partialPath,
    datasetFingerprint: fingerprint,
    repetitions: passes.length,
  };
  const perRun: unknown[] = [];

  for (const pass of passes) {
    console.log(`Grading run ${pass.run}...`);
    const report = await runAblationReport(
      dataset,
      replaySystem('reference-pipeline', dataset, pass.baselineAnswers),
      replaySystem('cortex-memory', dataset, pass.featureAnswers),
      { runs: 1, scorer, datasetFingerprint: fingerprint },
    );
    for (const side of ['baseline', 'feature'] as const) {
      lines.push(armLine(`run ${pass.run} ${report[side].name}`, report, side));
    }
    lines.push('');
    perRun.push({
      run: pass.run,
      baseline: report.baseline.metrics,
      feature: report.feature.metrics,
      delta: report.ablation.delta,
      discordant: report.ablation.discordant,
      mcnemarPValue: report.ablation.mcnemarPValue,
    });
    // The full rendering, per repetition, so a reader who wants the per-capability McNemar table
    // gets the same document a live run would have produced rather than a summary of it.
    lines.push(`## Run ${pass.run}`, '', formatAblationReport(report), '');
  }

  json['runs'] = perRun;
  // Written to `REGRADE_OUT_DIR` rather than the process's working directory, because the two are
  // not the same thing under `pnpm --filter`: the upload step looks where the job put it, and the
  // first dispatch of this script (`41740721672`) read its input from a relative path that resolved
  // against the package directory instead of the repository root. `PWD` is a fine default for a
  // human and a trap for a job.
  const outDir = process.env['REGRADE_OUT_DIR'] ?? '.';
  writeFileSync(join(outDir, 'benchmark-regrade-report.md'), lines.join('\n'));
  writeFileSync(join(outDir, 'benchmark-regrade.json'), JSON.stringify(json, null, 2));
  console.log(`Wrote ${join(outDir, 'benchmark-regrade-report.md')} (${passes.length} repetition(s))`);
}

await main();

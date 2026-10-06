/**
 * The `cortex-memory` A/B entry point.
 *
 * ## Why this file exists in this package rather than in `cortex-eval`
 *
 * This is the only place in the repository that can construct **both** sides of the
 * comparison, and that is a fact about the dependency graph rather than a choice:
 *
 *   cortex-core                     <- cortex-memory
 *   cortex-core, cortex-llm         <- cortex-eval
 *   cortex-memory --(devDep)--> cortex-eval
 *
 * `cortex-eval` cannot see `CortexMemory`, so it cannot build the feature side.
 * `cortex-memory` dev-depends on `cortex-eval`, so it can build the baseline side and
 * call the harness. The edge that made `cortex-memory` conformant in step 2 is the
 * same edge that makes this file possible, which is why the arrow points this way.
 *
 * ## What is NOT here
 *
 * Every decision. The environment parsing is `cortextMemoryArmOptions` and the
 * assembly is `runCortexMemoryArm`, both in `cortex-eval/src/` and both inside the
 * coverage boundary. `bench-arm-options.ts` documents why: this directory is excluded
 * from coverage as an entry point, so "deleting it, defaulting it on, or reading the
 * wrong environment variable each left every test green -- because no test could
 * import the file the line lived in."
 *
 * What remains is construction and delegation, and neither has a branch worth
 * testing: build the reader from the environment, build the reference system, build
 * the cognitive system from the parsed options, hand both to the arm, write what it
 * returns. A change to any *decision* belongs in `cortex-eval`, not here.
 *
 * ## Why `NaturalLanguageMemorySystem` is constructed here
 *
 * The baseline is `cortex-eval`'s reference pipeline -- the system the 83.55% figure
 * was measured on -- and it is built with the same reader and the same caches as the
 * feature. The caches are shared deliberately: they pin the two sides to identical
 * evidence for identical prompts, so a difference between them is a difference in
 * admission and not a difference in what the model was asked.
 */
import { createLlmFromEnv, createEmbeddingWithProvenanceFromEnv } from '@agentix-e/cortex-eval';
import {
  NaturalLanguageMemorySystem,
  createLlmJudge,
  judgeScorer,
  loadLongMemEval,
  cortexMemoryArmEmbeddingCachePath,
  cortextMemoryArmOptions,
  persistArmEmbeddingCache,
  restoreArmEmbeddingCache,
  runCortexMemoryArm,
  sampleInstances,
  toMemoryArmConfig,
  type BenchmarkProgress,
} from '@agentix-e/cortex-eval';
import { CortexMemory, confidenceFromLength } from '../src/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The last progress event seen, read by the failure handler.
 *
 * Module-level because the handler runs outside `main()`'s scope and after it has
 * unwound. `null` means no question was ever started, which is itself a fact worth
 * recording -- it distinguishes "died before the first call" from "died at
 * question N" and both from a crash on startup.
 *
 * This exists because of run `37281155088`: the arm spent ~52 minutes in the LLM,
 * died on an HTTP 402 when the account's balance ran out, and its
 * `benchmark-error.log` carried a stack trace that named no question and no side.
 * The embedding cache was already being persisted from the `catch` below, on the
 * argument that "a run that dies at question 300 of 500 has still paid for its
 * embeddings". The question of WHERE it died had no such record.
 */
let lastProgress: BenchmarkProgress | null = null;

/**
 * How often to print, in questions, per side and per run. `0` prints only the
 * first and last of each.
 *
 * A 500-question dataset evaluated four times is 4000 events; one line each would
 * bury the run's own report. The first and last always print because they are what
 * a truncated log is read for -- the last one is the line a reader greps for.
 */
const PROGRESS_EVERY = Number(process.env['PROGRESS_EVERY'] ?? 25);

/**
 * The progress sink, printing to stdout so a live run is watchable.
 *
 * The printing policy lives here rather than in `cortex-eval` for the reason this
 * file's header gives: `cortex-eval/src` emits nothing to a stream, and output
 * policy is not a measurement decision.
 */
function onProgress(progress: BenchmarkProgress): void {
  lastProgress = progress;
  const isFirst = progress.index === 0;
  const isLast = progress.index === progress.total - 1;
  const atInterval = PROGRESS_EVERY > 0 && progress.index % PROGRESS_EVERY === 0;
  if (!isFirst && !isLast && !atInterval) return;
  console.log(
    `[progress] ${progress.system} run=${progress.run} ` +
      `q=${progress.index + 1}/${progress.total} id=${progress.questionId}`,
  );
}

async function main(): Promise<void> {
  const dataPath = process.env['LONGMEMEVAL_PATH'];
  if (!dataPath) throw new Error('LONGMEMEVAL_PATH is required');

  const armOptions = cortextMemoryArmOptions(process.env);
  if (!armOptions.enabled) {
    console.log('=== cortex-memory arm skipped: CORTEX_MEMORY is not enabled ===');
    return;
  }

  const parsed = JSON.parse(readFileSync(dataPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`LONGMEMEVAL_PATH must contain a JSON array, got ${typeof parsed}`);
  }
  const limit = Number(process.env['LIMIT'] ?? 0);
  const sampled = sampleInstances(parsed as never, limit);
  const dataset = loadLongMemEval(sampled as never);

  const llm = createLlmFromEnv(process.env);
  const runs = Number(process.env['ABLATION_RUNS'] ?? 4);

  // Constructed and logged before any question is graded. The embedding backend is
  // the single largest determinant of the numbers that follow, and the factory falls
  // back silently to a 256-dimension hash embedding when no credential is present --
  // so a run that graded against the fallback and a run that graded against Zhipu
  // each produce a real report, and only this line separates them.
  const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv(process.env);
  console.log(
    `Embedding backend: ${provenance.provider} (model=${provenance.model ?? 'n/a'}, ` +
      `dimensions=${provenance.dimensions})`,
  );

  // Restore the persisted vector cache BEFORE either system touches a turn.
  //
  // This step runs in the same job as `bench/run.ts`, which writes the cache at
  // its end, and the two are separate processes: the primary benchmark's
  // in-process cache does not survive into this one. Without the restore, every
  // haystack turn is re-embedded against the provider -- roughly 115k vectors --
  // which on a quota that is already returning 429 is a guaranteed failure, and on
  // a fresh quota is a second full bill for vectors that were already paid for.
  //
  // Both the path resolution and the restore are `cortex-eval` functions rather
  // than inline code, for the reason this file's header gives: `bench/**` is
  // excluded from coverage as an entry point, so a decision written here is a
  // decision no test can reach. What remains here is the call.
  const cachePath = cortexMemoryArmEmbeddingCachePath(process.env);
  const restored = restoreArmEmbeddingCache(cachePath);
  console.log(`Restored ${restored} embedding vectors from ${cachePath ?? '(no cache path)'}`);

  // One cache per system, plus a shared structured cache. Shared across the two
  // sides so an identical prompt is answered once: the endpoint is not reproducible
  // across calls, so re-querying would inject discordance the experiment never meant
  // to measure.
  const answerCache = new Map<string, string>();
  const structuredCache = new Map<string, unknown>();

  const baseline = new NaturalLanguageMemorySystem('reference-pipeline', {
    embedding,
    llm,
    enableAbstention: true,
    answerCache,
    structuredCache,
  });

  const feature = new CortexMemory({
    llm,
    now: Date.now(),
    gate: {
      threshold: armOptions.threshold,
      retrievalThreshold: armOptions.retrievalThreshold,
      sessionBudget: armOptions.sessionBudget,
      sourceTrust: armOptions.sourceTrust,
      // Spread conditionally rather than passing `undefined`. The distinction is
      // the config type's own rule (`bench-arm-options.ts`): an always-present key
      // holding `undefined` reads as "configured" to a `!== undefined` check, and
      // `admission.ts` uses exactly that check to decide whether the callback ran.
      ...(armOptions.confidenceSignal === 'length' ? { confidenceFor: confidenceFromLength } : {}),
    },
    name: 'cortex-memory',
  });

  // Stated before the numbers, not after. Every figure below is conditioned on this
  // configuration, and `threshold=0` (gates open) and a near-1 threshold produce two
  // artifacts that look identical and mean opposite things.
  //
  // Both thresholds are printed for the same reason, and run `37094200823` is why.
  // That run logged `threshold=0` and published a `6.40%` accuracy with a `95.40%`
  // abstention rate; the line described the admission gate correctly and said
  // nothing about the retrieval decision, which did not exist. A reader with the
  // log alone had no way to see that, so the log must name the second gate now
  // that there is one.
  //
  // `sourceTrust` is on the line because it is the ceiling the thresholds are compared
  // against, and at its `0.5` default the reachable interval is `[0, 0.5]` -- so the
  // same `retrievalThreshold=0.25` means "the gate opens" under the default and "the
  // gate is near its midpoint" under a raised ceiling. `37110579101` reproduced
  // `37094200823`'s number to the digit and neither log named the ceiling.
  //
  // `confidenceSignal` is on the line because it is the other half of the same
  // question, and §49 is what separated them: raising the ceiling makes the gate
  // REACHABLE, and only per-turn confidence makes it DISCRIMINATING. A log naming
  // the ceiling alone therefore still cannot say whether a `retrievalThreshold`
  // in the reachable range had anything to cut -- which is precisely the reading
  // §10.10 had to retract.
  console.log(
    `cortex-memory gate: threshold=${armOptions.threshold}, ` +
      `retrievalThreshold=${armOptions.retrievalThreshold}, ` +
      `sessionBudget=${Number.isFinite(armOptions.sessionBudget) ? armOptions.sessionBudget : 'unbounded'}, ` +
      `sourceTrust=${armOptions.sourceTrust}, ` +
      `confidenceSignal=${armOptions.confidenceSignal}`,
  );

  const result = await runCortexMemoryArm(dataset, baseline, feature, {
    runs,
    scorer: judgeScorer(createLlmJudge(llm)),
    memoryArmConfig: toMemoryArmConfig(armOptions),
    featureConfig: { cortexMemory: true },
    onProgress,
  });

  // The census is already inside `result.report` -- `runCortexMemoryArm` puts it
  // there before rendering, so this file has nothing to merge. That is deliberate:
  // a second merge site here is the side channel the report type exists to close
  // (`report.ts`'s `abstentionReasons` doc, and `report-retry-fires.test.ts`).
  // The JSON and the Markdown are therefore two renderings of one object and
  // cannot disagree about whether the census is present.
  writeFileSync('benchmark-cortex-memory-ablation-report.md', result.markdown);
  writeFileSync(
    'benchmark-cortex-memory-ablation-report.json',
    `${JSON.stringify(result.report, null, 2)}\n`,
  );

  persistArmEmbeddingCache(cachePath);

  // Printed as well as written, for §10.8's reason: the log is what survives when
  // the artifact is not collected, and `37281155088` lost a ~52-minute arm with no
  // trace of what it had measured. A census the reader must download to see is a
  // census that does not answer the question at the moment the question is asked.
  // Read back off the report rather than off `result`, so the printed value is the
  // one the artifact carries.
  if (result.report.abstentionReasons !== undefined) {
    console.log('=== cortex-memory abstention reasons ===');
    console.log(JSON.stringify(result.report.abstentionReasons));
  }

  console.log('=== cortex-memory ablation ===');
  console.log(result.markdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // Name the question the run died on, before the stack. This is the half of the
  // failure record that run `37281155088` was missing: an HTTP 402 ended a
  // ~52-minute arm and the only durable trace said nothing about how far it got,
  // so the next attempt could not avoid repeating the spend up to an unknown
  // point. The progress event fires BEFORE a question is answered, so this line
  // names the question the throw happened inside -- not the one before it.
  const where =
    lastProgress === null
      ? 'progress: no question was started before the failure'
      : `progress: died on ${lastProgress.system} run=${lastProgress.run} ` +
        `q=${lastProgress.index + 1}/${lastProgress.total} id=${lastProgress.questionId}`;
  writeFileSync('benchmark-error.log', `${where}\n\n${message}\n`);
  console.error(where);
  console.error(message);
  // Persist whatever was embedded before the failure, on the failure path too.
  // `bench/run.ts` does the same, and the reason is the same: a run that dies at
  // question 300 of 500 has still paid for its embeddings, and discarding them
  // charges the next run for the same vectors. Best-effort, so it can never mask
  // the original error.
  try {
    persistArmEmbeddingCache(cortexMemoryArmEmbeddingCachePath(process.env));
  } catch {
    // The console output and `benchmark-error.log` are the primary diagnostics.
  }
  process.exitCode = 1;
});

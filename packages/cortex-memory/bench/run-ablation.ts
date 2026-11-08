/**
 * The `cortex-memory` A/B entry point.
 *
 * ## Why this file exists in this package rather than in `cortex-eval`
 *
 * This is the only place in the repository that can construct **both** sides of the
 * comparison, and that is a fact about the dependency graph rather than a choice:
 *
 *   cortex-core                     <- cortex-memory
 *   cortex-core, cortex-ai         <- cortex-eval
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
import {
  assertRerankReachesRanking,
  // §13.197.4's pair rather than the single reader: a route-scoped `thinking` value names the routes
  // that carry a second reader, and `createLlmFromEnv` refuses such a value instead of building the
  // base reader and letting the artifact claim a treatment the run never administered.
  createJudgeFromEnv,
  createReadersFromEnv,
  describeJudgeTransport,
  // §13.312: the judge's identity, read by the same function the client above was built from.
  resolveJudgeIdentity,
  // §13.306. The reader's bound is printed before the first question for the reason the judge's is:
  // `42381840503` lost a 500-question pass to a 300 s deadline that appeared in no line of its log,
  // and the loss it produced named the bound only after it had already ended the arm.
  describeReaderTransport,
  describeTransportLosses,
  // §13.306's ceiling, printed on the gate line: a bound the pass enforces and a reader cannot see
  // is the same defect as the deadline that only appeared in the error object of the question that
  // reached it.
  deadlineLossCeiling,
  lostToTransport,
  createMemoryArmReranker,
  resolveReaderIdentity,
  resolveRerankBounds,
  resolveRerankIdentity,
  createEmbeddingWithProvenanceFromEnv,
  resolveEmbeddingProvenance,
  describeFailure,
  // §14.22's width. Read here rather than inside the arm: it is a property of the invocation, not
  // of the registered configuration, and the registration check compares the latter field for field.
  readWorkers,
  // §13.227's two transport variables. Read here for the gate line only: the factory reads the same
  // environment with the same function, so the log and the client cannot disagree, and a run whose
  // pace is not on the line is a run whose wall clock and 429 rate cannot be interpreted later.
  readReaderPacing,
  retrieveTopKByQueriesHybrid,
  // §13.153's two readers. Both are the arm's to supply because both are facts about a corpus: the
  // turn stamp is this corpus's rendering, and the range inference is the reference's own arithmetic
  // (`temporal-engine.ts`), not the product's.
  readTurnStamp,
  resolveTimeRange,
  EXTENDED_ENGINE_OPTIONS,
  type Retrieval,
} from '@agentix-e/cortex-eval';
import { retryStats, type RetryExhaustion } from '@agentix-e/cortex-ai';
import {
  NaturalLanguageMemorySystem,
  buildRetrievalRelevanceIndex,
  buildSessionRelevanceIndex,
  type SessionRelevanceCase,
  createLlmJudge,
  judgeScorer,
  loadLongMemEval,
  cortexMemoryArmEmbeddingCachePath,
  cortextMemoryArmOptions,
  describeEmbeddingCachePersist,
  describeOracleCensus,
  assertOracleReached,
  oracleEvidenceDataset,
  type OracleEvidenceCensus,
  type OracleEvidenceDataset,
  expandMultiSessionQueries,
  fingerprintBytes,
  persistEmbeddingCache,
  restoreArmEmbeddingCache,
  roleOfTurn,
  preflightEmbedding,
  createAblationPool,
  runCortexMemoryArm,
  sampleInstances,
  toMemoryArmConfig,
  toRerankRecord,
  // §13.274's restore counterfactual. The four calls are the whole of the intervention on this
  // side: parse the plan, narrow the dataset, decorate the feature-side readers, and let the ledger
  // fall out of the decorator. Every decision behind them is in `cortex-eval/src/restore-plan.ts`,
  // where a test can reach it.
  readRestorePlanFromEnv,
  restoringReader,
  restoreBlock,
  restrictDatasetToPlan,
  type BenchmarkProgress,
  type EmbeddingPreflight,
  type ExpansionTarget,
  type RelevanceCase,
  type RelevanceIndex,
  type RelevanceIndexOptions,
  type QuestionExpansion,
  type RestoreCall,
} from '@agentix-e/cortex-eval';
import {
  CortexMemory,
  confidenceFromLength,
  type EvidenceAsk,
  type PromptContract,
  type RelevanceUnits,
  type ReviewPass,
  type TurnCapRoute,
  // Named at this boundary rather than inferred from the literal below: the two readers are the product's
  // injection point, so the shape belongs to the product's public surface and this file only supplies an
  // instance of it. Inferred, the type would have no caller outside its own module and
  // `tools/export-census.mjs` would report it as an export nothing names.
  type WindowOrdering,
} from '../src/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  REDUCED_TURNS_MARKER,
  describeProviderRefusals,
  describeScorerChannels,
  providerRefusals,
  scorerChannelStats,
  serializeReportOrReduce,
} from '@agentix-e/cortex-eval';

/**
 * The evidence bound used when the dispatch did not name one.
 *
 * `§13.12` registers `CORTEX_MEMORY_EVIDENCE_TURNS` as the dispatch input, and a
 * configured run takes its value from the parsed arm options. This constant is the
 * FALLBACK, and it exists because the arm's own default is `unbounded` while the
 * writer needs a finite number to reduce toward.
 *
 * The asymmetry is deliberate rather than an oversight: an unconfigured run should
 * carry everything, and an unconfigured run must still produce an artifact. So the
 * arm is handed no bound (carry everything) and the writer is handed this one (so
 * that a report which cannot be written is reduced rather than lost). When the
 * fallback engages, the artifact's `evidenceReduction` field records it -- a
 * reduced report is never silently reduced.
 *
 * The number is two hundred and fifty-six rather than a round one, and §13.15 is
 * why. The roster it bounds holds the evidence the prompt **carried**, which the
 * prompt budget already bounds at roughly one hundred and sixty-seven turns on this
 * arm, so this is a writability guard and not a measurement. It stays finite
 * because a run that sets a large `maxPromptChars` would otherwise have no outer
 * bound at all -- which is the failure `§13.11.10` records, reached from the
 * configuration side.
 */
const EVIDENCE_TURNS_PER_RECORD = 256;

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
/**
 * The per-pass wall-clock ceiling, from the environment, or `undefined` for none.
 *
 * ## Why an environment variable and not a constant
 *
 * A ceiling exists because a pass can hang, and how long "too long" is belongs to the
 * dispatch: the same code runs a 500-question arm and a 60-question probe, and a constant
 * would have to be wrong for one of them. It also has to be **visible in the workflow**, so
 * a reader of a run can see the ceiling it ran under without reading this file -- which is
 * the same argument `evidenceTurnsPerRecord` is an input for.
 *
 * ## Why absent means "no ceiling" rather than a default
 *
 * Every archived artifact was produced without one, so a default would silently change what
 * those runs measured -- the compatibility rule `maxPromptChars`, the prompt contract and
 * the relevance unit are all under.
 *
 * `0` and negatives are rejected rather than treated as "no ceiling": a ceiling of zero
 * would abandon every pass before its first question, which is a run that produces a
 * failure record and no measurement while reading as a healthy configuration.
 */
function readBudgetMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env['CORTEX_MEMORY_BUDGET_MINUTES'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const minutes = Number(raw.trim());
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(
      `CORTEX_MEMORY_BUDGET_MINUTES must be a positive number of minutes or unset, got ` +
        `${JSON.stringify(raw)}. It is the ceiling for the whole run -- every pass shares one ` +
        'deadline, so 0 abandons the run before its first question, which fails the measurement ' +
        'while looking like a healthy configuration.',
    );
  }
  return minutes * 60_000;
}

/**
 * The unit each arm-level name forwards to the product, or `undefined` for the shipped default.
 *
 * ## Why this is a table keyed by the product's union instead of a comparison
 *
 * Because the comparison was wrong, it ran, and nothing could see it. This forwarding used to read
 *
 *     armOptions.relevanceUnits === 'session' ? { relevanceUnits: 'session' } : {}
 *
 * which accepted `session-fill` at the arm's parser, projected `relevanceUnits=session-fill` into the
 * artifact's configuration line, and then ran the **turn** unit. Run `38828538851` was registered as
 * §13.32 and read as §13.34's "`session-fill` spends the room and changes nothing" -- a sentence
 * about the turn unit, which is exactly why it agreed with the turn unit to within a question.
 *
 * `Record<RelevanceUnits, ...>` is the repair rather than a test, because the failure mode
 * is **omission** and `bench/**` is excluded from coverage: a fifth unit added to the product's union
 * fails to compile here until this table names it, and the compiler runs on every commit. A test
 * would have to read the source to notice, and the source was the thing that was wrong -- the same
 * shape as the four "the comment claims a check" defects `bench-memory-arm.test.ts` records.
 */
const RELEVANCE_UNIT_FORWARDING: Record<RelevanceUnits, RelevanceUnits | undefined> = {
  turn: undefined,
  session: 'session',
  'session-fill': 'session-fill',
  'anchor-window': 'anchor-window',
};

/**
 * The value to forward, refusing a name this table does not know.
 *
 * `undefined` and "not in the table" are different states and the index alone cannot separate them,
 * which is the bug above repeated one layer down: an unlisted name would index to `undefined`, forward
 * nothing, and behave exactly like `turn`. The `in` check makes that loud. It should be unreachable --
 * `readRelevanceUnits` throws first -- and it is here because "should be unreachable" is what the
 * guard at the other end always says.
 */
function relevanceUnitToForward(units: string): RelevanceUnits | undefined {
  if (!(units in RELEVANCE_UNIT_FORWARDING)) {
    throw new Error(
      `relevanceUnits ${JSON.stringify(units)} has no forwarding rule. Add it to ` +
        'RELEVANCE_UNIT_FORWARDING; forwarding nothing would run the turn unit under a ' +
        'configuration line that names another one, which is the §13.286.2 defect.',
    );
  }
  return RELEVANCE_UNIT_FORWARDING[units as RelevanceUnits];
}

function onProgress(progress: BenchmarkProgress): void {
  lastProgress = progress;
  const isFirst = progress.index === 0;
  const isLast = progress.index === progress.total - 1;
  const atInterval = PROGRESS_EVERY > 0 && progress.index % PROGRESS_EVERY === 0;
  if (!isFirst && !isLast && !atInterval) return;
  console.log(
    `[progress] ${progress.system} run=${progress.run} ` +
      `q=${progress.index + 1}/${progress.total} id=${progress.questionId} ` +
      // §13.28: the duration beside the counter, because the counter alone cannot tell a
      // pass that died immediately from one that spent hours inside a single question.
      // Run `38659495034` printed `q=1/500` after 1h49m and the two were indistinguishable.
      `+${(progress.elapsedMs / 1000).toFixed(0)}s`,
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

  // One read, two uses: the parsed instances and the bytes they came from. The
  // fingerprint is taken here because this is the only place in the process that holds
  // the file -- by the time the arm is called the dataset is parsed and the bytes are
  // gone, which is why `CortexMemoryArmRunOptions.datasetFingerprint` is an input rather
  // than something the arm computes. `AblationReport.datasetFingerprint` says why the
  // report carries it: the workflow fetches this name from `resolve/main`, so a score is
  // a property of (pipeline, file) and only half of that pair was ever written down.
  const rawDataset = readFileSync(dataPath);
  const datasetFingerprint = fingerprintBytes(rawDataset);
  const parsed = JSON.parse(rawDataset.toString('utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`LONGMEMEVAL_PATH must contain a JSON array, got ${typeof parsed}`);
  }
  const limit = Number(process.env['LIMIT'] ?? 0);
  const sampled = sampleInstances(parsed as never, limit);
  const fullDataset = loadLongMemEval(sampled as never);
  // §13.274's restore counterfactual narrows the run to the population the plan names.
  //
  // The restriction is applied to the dataset rather than to the arm because both consumers of the
  // questions -- the relevance index and the graded passes -- read this value, and a run whose
  // index was built over 500 questions while the arm graded 22 would report a pool the questions
  // never had. `readRestorePlanFromEnv` answers `null` for an ordinary run, so an unset variable
  // leaves every number below byte-identical to the run before it.
  const restorePlan = readRestorePlanFromEnv(process.env, (path) => readFileSync(path, 'utf8'));
  const restricted =
    restorePlan === null ? fullDataset : restrictDatasetToPlan(fullDataset, restorePlan);
  // §1.38.5's oracle condition, applied AFTER the restriction so its census describes the graded
  // population rather than the file. Both arms are handed this dataset, which is what makes the
  // condition a single variable: the two sides differ in their system, never in their evidence.
  //
  // `armOptions.oracleEvidence` is read from the environment by the arm's own parser, so a
  // dispatch that leaves it blank runs the shipped corpus byte-identically to every run before it.
  // Annotated rather than inferred: the union is the whole point of the conditional, and
  // `OracleEvidenceDataset` is the type both the transform and the post-run check agree on.
  const oracle: OracleEvidenceDataset | undefined = armOptions.oracleEvidence
    ? oracleEvidenceDataset(restricted)
    : undefined;
  const dataset = oracle === undefined ? restricted : oracle.dataset;
  if (oracle !== undefined) {
    // Printed before the fingerprint line, because that line describes the FILE and this one
    // describes the run: two runs of the same file, one shipped and one oracle, share a digest
    // and differ in what their evidence was. The pool/shipped ratio is on the line because it is
    // the confound this condition cannot remove -- the reader sees correct AND far less evidence.
    // Typed at the boundary rather than passed inline: the census is what the post-run check is
    // held to, so the one object the log prints and the one `assertOracleReached` compares are
    // declared to be the same type here instead of meeting for the first time inside a call.
    const census: OracleEvidenceCensus = oracle.census;
    console.log(describeOracleCensus(census));
  }
  if (restorePlan !== null) {
    // Printed before the fingerprint line, because the fingerprint describes the FILE and this
    // describes the run: two runs of the same file, one of 500 and one of 22, share a digest and
    // differ in what they measured.
    console.log(
      `Restore plan: ${restorePlan.entries.length} question(s) from ${restorePlan.source} ` +
        `(${restorePlan.entries.filter((entry) => entry.recordedOutcome === 'incorrect').length} ` +
        'recorded incorrect, the rest are the control)',
    );
  }
  // Printed as well as recorded, because the two cross-check each other: the log is what
  // a triage reader sees while the job still exists, and the artifact is what survives it.
  // Printing the file's instance count beside the digest is what distinguishes a 500-question
  // run from a `LIMIT=220` probe over the same file -- the digest is equal in both.
  console.log(
    `Dataset fingerprint: ${datasetFingerprint} (${(parsed as unknown[]).length} instances in file, ` +
      `${dataset.questions.length} graded after sampling)`,
  );

  // The base reader, plus -- only when `thinking` names routes -- the map `CortexMemory` resolves per
  // route. The baseline below keeps `llm`: the reference pipeline is not the treatment, and a pair
  // that reached it would move both sides of the comparison.
  const { llm, readerByRoute } = createReadersFromEnv(process.env);
  if (readerByRoute !== undefined) {
    console.log(`Route-scoped reader: ${Object.keys(readerByRoute).sort().join(',')}`);
  }

  // §13.274's intervention, on the feature side only.
  //
  // `restoreCalls` is one ledger shared by every decorated reader, so a run that resolves a second
  // client per route still produces one record. The baseline keeps the undecorated `llm` on
  // purpose and for the reason the line above gives: this arm's pair is the product against the
  // reference pipeline, and decorating both would restore evidence into a system that is not the
  // treatment.
  const restoreCalls: RestoreCall[] = [];
  const featureLlm =
    restorePlan === null ? llm : restoringReader(llm, restorePlan, restoreCalls).llm;
  const featureReaderByRoute =
    restorePlan === null || readerByRoute === undefined
      ? readerByRoute
      : Object.fromEntries(
          Object.entries(readerByRoute).map(([route, reader]) => [
            route,
            restoringReader(reader, restorePlan, restoreCalls).llm,
          ]),
        );
  // A second client for the scoring instrument, on the same identity and the same pace, with the
  // pair a one-token verdict needs (§13.236). Logged because it is the pipe the verdicts travelled
  // through: `41585013786` died on a judge call and no line in its log said what that call had
  // been given.
  const judgeLlm = createJudgeFromEnv(process.env);
  // Read once, beside the client it describes, and handed to the report rather than re-read there:
  // two readings of one environment are two chances to name a judge the run did not use.
  const judgeIdentity = resolveJudgeIdentity(process.env);
  // Read once, here, and shared by the two transport lines below and by the arm further down: a
  // second read is a second answer to "what deadline did this run have", and the file's own rule for
  // the pace (§13.227) is that one function is what makes the log and the client agree.
  const pacing = readReaderPacing(process.env);
  console.log(describeJudgeTransport());
  // The subject's bound beside the instrument's, in the order the run meets them. Printed for both
  // thinking modes because the reader that died was the base one: the thinking routes had 300 s and
  // the four others had less, and a single line naming both is what makes that visible before the
  // first question rather than in the error object of the two-hundredth.
  for (const mode of ['disabled', 'enabled'] as const) {
    console.log(describeReaderTransport({ type: mode }, pacing));
  }
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

  // One request, before anything that takes time, to learn whether the provider will serve
  // this run at all.
  //
  // The two failures that motivate it both died on the embedding provider: `38520676669`
  // after three hours (a socket the provider terminated) and `38566578567` after thirty
  // minutes of building the relevance index, with the provider's own refusal -- `429 Too
  // Many Requests — {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}`.
  // The second one is the case this check is for: the account had no credit, and the only
  // way the run could find out was to spend the thirty minutes first.
  //
  // It cannot prevent a balance running out mid-run -- in `38566578567` about nine
  // thousand five hundred requests were served before the provider started refusing -- so
  // the claim is narrow and worth stating: every dispatch learns for one request what the
  // run would otherwise learn for a run.
  //
  // Thrown rather than logged-and-continued. A run that cannot embed cannot answer, and
  // the whole point of moving the discovery earlier is to not spend the money that
  // follows. The message carries the provider's own words, because `429` reads as a rate
  // limit -- something you wait out -- and this condition is the opposite.
  const preflight: EmbeddingPreflight = await preflightEmbedding(embedding);
  if (!preflight.ok) {
    throw new Error(
      `embedding preflight failed against ${provenance.provider} ` +
        `(model=${provenance.model ?? 'n/a'}): ${preflight.message}`,
    );
  }
  console.log(`Embedding preflight: ok (one vector of ${preflight.dimension} dimensions)`);

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
  const restored = restoreArmEmbeddingCache(cachePath, provenance);
  console.log(`Restored ${restored} embedding vectors from ${cachePath ?? '(no cache path)'}`);

  // One cache per system, plus a shared structured cache. Shared across the two
  // sides so an identical prompt is answered once: the endpoint is not reproducible
  // across calls, so re-querying would inject discordance the experiment never meant
  // to measure.
  const answerCache = new Map<string, string>();
  const structuredCache = new Map<string, unknown>();

  // A factory rather than a value, because the pool below needs one instance per worker and
  // a `MemorySystem` carries per-question state in single slots. The caches and the embedding
  // client are shared deliberately -- they pin every worker to the same answer for the same
  // prompt, which is what makes a concurrent pass comparable to a serial one at all.
  const builtAt = Date.now();
  const buildBaseline = (): NaturalLanguageMemorySystem =>
    new NaturalLanguageMemorySystem('reference-pipeline', {
      embedding,
      llm,
      enableAbstention: true,
      answerCache,
      structuredCache,
    });

  // §13.17's single variable, built before either side is graded.
  //
  // The index is a retrieval measurement over the arm's own embedding backend, and it
  // is built here rather than inside the arm because the prompt builder's relevance
  // callback is synchronous while embedding is not: `cortex-eval` turns that into a
  // pure table lookup (`relevance-index.ts`), and this is the call that fills the
  // table.
  //
  // The cost is one retrieval per question, against the same process-wide vector
  // cache the two graded sides read. That sharing is why the extra pass is not a
  // doubling of the embedding bill: the reference pipeline embeds the same haystack
  // turns, so the second reader finds them cached.
  //
  // The switch is read from the parsed arm options rather than decided here, for the
  // reason `evidenceBound` is below: `bench/**` is outside the coverage boundary, so a
  // decision written in this file is a decision no test can reach, and a value that
  // never reaches the environment is a value the pre-registration guard cannot compare
  // against `§10.3`.
  // §13.97's single variable, produced before the index it feeds.
  //
  // The phrases cannot be written while answering: `CortexMemory`'s `relevanceFor` is a
  // synchronous table lookup filled by the index below, so a phrase produced at answer time
  // would score every turn at the index's floor and the treatment would be unmeasurable.
  // That is why the call sits here rather than in the product, and why the index takes the
  // phrases as data (`RelevanceCase.queries`).
  //
  // Only the multi-session questions are expanded. The other four capabilities keep the
  // exact queries, ranking and window they had in the prior run, which is this dispatch's
  // internal control -- `expandMultiSessionQueries` owns the routing rule so a caller cannot
  // widen it by passing a different dataset.
  // The targets are named with their type rather than inlined, because the routing rule that
  // confines expansion to one capability lives behind `ExpansionTarget.capability` and a
  // caller that let the shape be inferred could pass a field the callee never reads.
  const expansionTargets: readonly ExpansionTarget[] = dataset.questions.map((question) => ({
    question: question.question,
    capability: question.capability,
  }));
  const expansion: QuestionExpansion | null =
    armOptions.queryExpansion === 'llm'
      ? await expandMultiSessionQueries(llm, expansionTargets)
      : null;
  if (expansion !== null) {
    console.log(
      `Query expansion: ${expansion.questions} multi-session questions, ` +
        `${expansion.phrases} phrases, ${expansion.empty} refused`,
    );
  }

  // The cases the index is built over: each question with its own context, and nothing
  // else. The type carries no ground-truth field, which is what makes the signal
  // non-oracle structurally rather than by convention -- the answer key is not a value
  // this call could reach even if a later edit wanted it to.
  const relevanceCases: readonly RelevanceCase[] = dataset.questions.map((question) => {
    const phrases = expansion?.byQuestion.get(question.question);
    return {
      question: question.question,
      context: question.context,
      // Carried unconditionally rather than only for `retrieval-session`. `loadLongMemEval` sets
      // `context: sessions.flat()`, so the two are index-aligned by construction and a case that
      // chose to include boundaries only sometimes would make the alignment a per-run fact. The
      // turn-scored builder ignores the field; `session-relevance.ts` refuses without it.
      // `Question.sessions` is optional in the contract, so the spread is conditional rather than
      // `?? []`: an empty array would tell `session-relevance.ts` the question has boundaries and
      // none, which is a different statement from "this dataset did not carry them" and would be
      // refused with the wrong message. Absent propagates, and that builder's refusal names the
      // real cause.
      ...(question.sessions === undefined ? {} : { sessions: question.sessions }),
      ...(phrases === undefined ? {} : { queries: phrases }),
    };
  });
  // §13.115. The reranker is resolved from the arm's own switch and handed to the index below; the
  // identity comes from the same resolver, so the model that reorders the pool and the model the
  // artifact names cannot be two readings of one environment. `arm: true` is what keeps the switch
  // off `CORTEX_RERANK`, which belongs to the reference pipeline this run pairs against.
  const rerankIdentity = resolveRerankIdentity(process.env, { arm: true });
  const rerankBounds = resolveRerankBounds(process.env);
  const rerank = createMemoryArmReranker(process.env);
  // Refused before any retrieval: an arm whose ranking cannot carry the stage must not produce a
  // number at all, because its delta would be read as the reranker's verdict.
  assertRerankReachesRanking(armOptions.relevanceSignal, rerankIdentity);
  if (rerank !== undefined) {
    console.log(
      `Rerank stage: ${rerankIdentity.provider}` +
        `${rerankIdentity.provider === 'none' ? '' : ` (${rerankIdentity.model ?? 'n/a'})`}`,
    );
  }
  const relevanceOptions: RelevanceIndexOptions = {
    topK: armOptions.relevanceTopK,
    ...(rerank === undefined ? {} : { rerank }),
    // The endpoint's declared wire limits travel with the stage, because they decide whether a pool of
    // this width can be scored at all and how much of a long turn the ordering saw. Undeclared stays
    // undeclared rather than defaulting to one vendor's numbers.
    ...(rerankBounds.maxDocuments === null
      ? {}
      : { rerankMaxDocuments: rerankBounds.maxDocuments }),
    ...(rerankBounds.maxDocumentChars === null
      ? {}
      : { rerankMaxDocumentChars: rerankBounds.maxDocumentChars }),
  };
  // §13.63. Two mechanisms behind one name-typed switch, so the artifact's
  // `relevanceSignal` says which one ranked the turns and the two arms are comparable
  // across runs. `retrieval` is dense cosine alone and is what every archived run used;
  // `retrieval-hybrid` fuses that ranking with a rare-keyword channel by reciprocal rank.
  // Both share `Retrieval`'s signature, so the index takes a mechanism rather than a flag.
  const retriever: Retrieval | undefined =
    armOptions.relevanceSignal === 'retrieval-hybrid' ||
    armOptions.relevanceSignal === 'retrieval-anchored'
      ? (queries, context, topK) =>
          retrieveTopKByQueriesHybrid(embedding, [...queries], [...context], topK)
      : undefined;
  // Two builders behind one name-typed switch, for the same reason `retriever` above is a
  // mechanism rather than a flag: the artifact says which operation ranked the turns, and two runs
  // whose `relevanceSignal` differs can be compared because the difference is a value.
  //
  // `retrieval-session` is not a wider `retrieval`: it scores a session as one unit and projects the
  // score onto that session's turns, which is the operation `reference-pipeline` performs and this
  // arm could not express. Pair it with `relevanceUnits=session` — see `RELEVANCE_SIGNALS`.
  const relevance: RelevanceIndex | null =
    armOptions.relevanceSignal === 'retrieval-session'
      ? await buildSessionRelevanceIndex(
          embedding,
          relevanceCases as readonly SessionRelevanceCase[],
          {
            topK: armOptions.relevanceTopK,
          },
        )
      : armOptions.relevanceSignal === 'retrieval' ||
          armOptions.relevanceSignal === 'retrieval-hybrid' ||
          armOptions.relevanceSignal === 'retrieval-anchored'
        ? await buildRetrievalRelevanceIndex(embedding, relevanceCases, {
            ...relevanceOptions,
            ...(retriever === undefined ? {} : { retrieve: retriever }),
            // §13.256's increment. The empty object is the registration: `anchor-recall.ts` owns the
            // three parameters, so a dispatch that names the mechanism cannot also move the count,
            // the radius or the decay without editing the module the gates were written against.
            ...(armOptions.relevanceSignal === 'retrieval-anchored' ? { anchors: {} } : {}),
          })
        : null;
  if (relevance !== null) {
    console.log(
      `Relevance index: ${relevance.scoredPairs} scored (question, turn) pairs over ` +
        `${relevance.questions} questions at topK=${relevance.topK}`,
    );
    // The stage's own line, because the artifact's counters are only trustworthy if the log and the
    // report agree -- and because `fallbacks > 0` is worth seeing before a 40-minute run finishes.
    if (relevance.rerank !== undefined) {
      const { calls, pairs, fallbacks, changed, clipped } = relevance.rerank;
      console.log(
        `Rerank census: ${calls} calls, ${pairs} pairs, ${fallbacks} fallback(s), ` +
          `${changed} question(s) reordered, ${clipped} passage(s) clipped`,
      );
    }
    // §13.257. The same rule for the restoration: its counts are what separates "the selection fired
    // on nothing" from "the selection never ran", and the three parameters beside them are what
    // separates this dispatch of the mechanism from the last one -- both publish
    // `relevanceSignal=retrieval-anchored`, and the artifact's config line carries the parameters
    // while this line carries what they produced.
    if (relevance.anchors !== undefined) {
      const { questions, anchors, restored, count, radius, decay } = relevance.anchors;
      console.log(
        `Anchor census: ${questions} question(s), ${anchors} anchor(s), ` +
          `${restored} restored turn(s) at count=${count} radius=${radius} decay=${decay}`,
      );
    }
  }
  // The identity and the census travel together into the artifact. Split, a report could name a model
  // it never consulted -- the ambiguity §13.115 registers as unreadable rather than negative.
  const rerankRecord = toRerankRecord(rerankIdentity, rerankBounds, relevance?.rerank);

  // §13.153's mechanism. One decision, read by the two places that need it -- the product's readers and the
  // artifact's feature line -- and stated once for the reason `reviewBareDecline` is derived in the arm
  // rather than here: two reads of the same field cannot disagree about whether the mechanism was on.
  const windowReorder = armOptions.queryExpansion === 'window';

  // §13.286.2. Resolved once, next to the option block it feeds, so the value the product receives and
  // the value the artifact reports come from the same read -- the defect was not that they disagreed
  // but that one of them was never consulted.
  const forwardedUnit = relevanceUnitToForward(armOptions.relevanceUnits);

  // The two readers the product asks for. Absent unless the run named it, so a dispatch of any other
  // configuration hands the product nothing it could reorder by.
  //
  // `EXTENDED_ENGINE_OPTIONS` rather than the default engine options, because the language the profile
  // was derived under is the extended one (the same options `answerTemporal`'s own reach was measured
  // with); the default profile would leave a third of the period families unresolved and the mechanism
  // would then be administered on a population nobody registered.
  const windowOrdering: WindowOrdering | undefined = windowReorder
    ? {
        dateOf: (content: string) => readTurnStamp(content)?.date,
        // `?? undefined` rather than a fallback range: `resolveTimeRange` answers `null` for a
        // question that names no period, and substituting the corpus span would promote the whole
        // delivered list -- a permutation that moves nothing while reporting that it fired.
        windowOf: (question: string, questionDate: string | undefined) =>
          questionDate === undefined
            ? undefined
            : (resolveTimeRange(question, questionDate, EXTENDED_ENGINE_OPTIONS) ?? undefined),
      }
    : undefined;

  // One instance per worker, for the reason the pool states: the optional accessors that carry a
  // question's prompt, evidence and raw output are single slots, and a shared instance under
  // concurrency attributes one question's prompt to another without throwing. Every value the
  // factory closes over is either immutable or shared on purpose (the answer cache, the embedding
  // client, the relevance table).
  const buildFeature = (): CortexMemory =>
    new CortexMemory({
      // Decorated only when the run restores (§13.274). `featureLlm` IS `llm` otherwise, so an
      // ordinary run constructs the identical object it always did.
      llm: featureLlm,
      // Hoisted out of the object literal so every worker's instance agrees: `now` participates in
      // the gate's decay arithmetic, and two instances built milliseconds apart would make the
      // workers disagree about the clock rather than about the questions.
      now: builtAt,
      gate: {
        threshold: armOptions.threshold,
        retrievalThreshold: armOptions.retrievalThreshold,
        sessionBudget: armOptions.sessionBudget,
        sourceTrust: armOptions.sourceTrust,
        // Spread conditionally rather than passing `undefined`. The distinction is
        // the config type's own rule (`bench-arm-options.ts`): an always-present key
        // holding `undefined` reads as "configured" to a `!== undefined` check, and
        // `admission.ts` uses exactly that check to decide whether the callback ran.
        ...(armOptions.confidenceSignal === 'length'
          ? { confidenceFor: confidenceFromLength }
          : {}),
      },
      name: 'cortex-memory',
      // §12.5's single variable, spread conditionally for the same reason as
      // `confidenceFor` above: an always-present key holding `undefined` reads as
      // "configured" to a `!== undefined` check, and `memory.ts` uses exactly that check
      // to decide whether to substitute the contract. The baseline contract is expressed
      // by NOT passing the key, so a run that does not name one reproduces the previous
      // prompt byte for byte.
      //
      // The cast is at this boundary rather than on the option's type. `cortex-eval` carries
      // the contract as `string` because it cannot import this package's union (the
      // dependency runs the other way), and it validates the string against the product's
      // own list at parse time -- `readPromptContract` throws on anything unrecognised. So by
      // the time execution reaches here the value IS one of the union's members, and the
      // assertion states that rather than re-checking it. Widening the option to `string`
      // would move the check to a place with no validation behind it.
      ...(armOptions.promptContract === 'abstention'
        ? {}
        : { promptContract: armOptions.promptContract as PromptContract }),
      // §13's single variable, on its own axis and spread conditionally for the same
      // reason: `route` IS the shipped behaviour and is expressed by NOT passing the key,
      // so a run that does not name an ask reproduces the previous prompt byte for byte.
      // Passing `'route'` explicitly would read as "configured" to the `!== undefined`
      // check in `#promptOptions` and take a different branch to the same result -- which
      // is harmless today and is exactly the kind of harmless-until-it-is-not that the
      // conditional spreads above exist to avoid.
      //
      // The cast is at this boundary for the same reason as `promptContract`: `cortex-eval`
      // carries the ask as `string` because the dependency runs the other way, and
      // `readAsk` validates it against the product's own list at parse time, throwing on
      // anything unrecognised. So the value IS one of the union's members here.
      ...(armOptions.ask === 'route' ? {} : { ask: armOptions.ask as EvidenceAsk }),
      // §13.94's second consultation. `none` IS the shipped behaviour and is expressed by NOT passing
      // the key, for the reason every other conditional spread here is: every archived artifact was
      // produced without a pass, and a present-but-inert key would make the option indistinguishable
      // from a configured one to a `!== undefined` check.
      // `bare` is a value of `reviewPass` at the dispatch boundary but not a member of the product's `ReviewPass`
      // union: it is a different treatment, not a different pass over the same reply. Excluded here so the cast below
      // cannot smuggle it into a field the product would interpret as `recover`.
      ...(armOptions.reviewPass === 'none' ||
      armOptions.reviewPass === undefined ||
      armOptions.reviewPass === 'bare'
        ? {}
        : { reviewPass: armOptions.reviewPass as ReviewPass }),
      // Same conditional shape as `reviewPass`: absent is the shipped behaviour, and a present-but-false key would
      // make "the control ran" indistinguishable from "the switch was configured off" to a `!== undefined` check.
      ...(armOptions.reviewBareDecline === true ? { reviewBareDecline: true } : {}),
      // §13.197.4's knob, spread conditionally like every other treatment here: absent is the shipped
      // configuration every archived artifact was produced under, and a present-but-empty map would
      // read as configured to the `!== undefined` check `#readerFor` performs while resolving no route
      // at all -- an artifact then claiming a treatment the product never administered.
      ...(featureReaderByRoute === undefined ? {} : { readerByRoute: featureReaderByRoute }),
      // §13.153. Same conditional shape and for the same reason: absent is the shipped behaviour, and a
      // present-but-empty reader pair would read as configured to a `!== undefined` check while resolving
      // no window at all -- an artifact then claiming a treatment the product never administered.
      ...(windowOrdering === undefined ? {} : { windowOrdering }),
      // §13.101's sample count. `none` IS one consultation and is expressed by NOT passing the key, for
      // the reason every conditional spread here is: every archived artifact was produced with one
      // consultation, and a present-but-inert key would make the option indistinguishable from a
      // configured one to a `!== undefined` check. The cast is at this boundary because the arm carries
      // the count as a string so the artifact can spell `none`, and `readSelfConsistency` has already
      // rejected anything that is not one of the two names.
      ...(armOptions.selfConsistency === 'none' || armOptions.selfConsistency === undefined
        ? {}
        : { selfConsistency: Number(armOptions.selfConsistency) }),
      // §13.17's single variable, spread conditionally for the same reason as the two
      // above: `none` IS the shipped behaviour (the budget buys the first turns that
      // arrived) and is expressed by NOT passing the key, so a run that names no signal
      // reproduces the previous prompt byte for byte. `relevance.index`'s lookup is a
      // plain table read, so extracting it from its object does not lose a receiver.
      ...(relevance === null ? {} : { relevanceFor: relevance.relevanceFor }),
      // §13.27's single variable, spread conditionally for the reason `relevanceFor` above
      // is: `turn` IS the shipped behaviour (the budget buys individual turns wherever they
      // score highest) and is expressed by NOT passing the key, so a run that names no unit
      // reproduces the previous prompt byte for byte. The cast is at this boundary rather
      // than on the option's type, for the reason the contract's cast is: `cortex-eval`
      // carries the unit as `string` because it cannot import this package's union, and it
      // validates against the product's own list at parse time -- `readRelevanceUnits`
      // throws on anything unrecognised -- so by the time execution reaches here the value
      // IS one of the union's members.
      ...(forwardedUnit === undefined ? {} : { relevanceUnits: forwardedUnit }),
      // §13.67's single variable, spread conditionally for the reason the three above are:
      // no cap IS the shipped behaviour and is expressed by NOT passing the key, so a run that
      // names no cap reproduces the previous prompt byte for byte. This is the one line in the
      // chain that no test reaches -- `bench/**` is excluded from coverage as an entry point --
      // which is why the same value is echoed in the log line below and projected into the
      // artifact's config: a spread deleted here would leave the run's own log and its own
      // config claiming a treatment the prompt never received.
      ...(armOptions.maxTurnChars === undefined ? {} : { maxTurnChars: armOptions.maxTurnChars }),
      // §13.187.6D's mark. Spread only when named, for the reason every conditional spread in this
      // constructor is: `none` IS the historical rendering and is expressed by NOT passing the key,
      // so a run that names no marker reproduces every archived capped prompt byte for byte. The
      // cast is at this boundary because `cortex-eval` carries the name as a `string` (it cannot
      // import this package's union) and validates it against its own copy at parse time -- which is
      // why `readTurnCutMarker` throws on anything unrecognised and `assertMarkerNeedsCap` refuses
      // it without a cap.
      ...(armOptions.turnCutMarker === 'ellipsis' ? { turnCutMarker: 'ellipsis' as const } : {}),
      // §13.81's budget. Absent means the product's 24,000, which is what every archived run used; a
      // number raises the room without touching a single turn, which is the only lever §13.80 left.
      ...(armOptions.maxPromptChars === undefined
        ? {}
        : { maxPromptChars: armOptions.maxPromptChars }),
      // §13.239's redistribution. The cast is at this boundary for the reason the reach's is: the
      // arm carries the route names as `string` because it cannot import this package's union, and
      // validates every one of them against its own copy at parse time, so what arrives here is a
      // checked fact rather than a widened option.
      ...(armOptions.maxPromptCharsByRoute === undefined
        ? {}
        : {
            maxPromptCharsByRoute: armOptions.maxPromptCharsByRoute as Partial<
              Record<TurnCapRoute, number>
            >,
          }),
      // §13.73's reach, passed beside the width and for the same reason. `undefined` on the arm's
      // side means every route, which is what §13.68 shipped; an explicit six-route list is the same
      // state reached by a different path, and the product treats both as "reaches everything". The
      // cast is at this boundary because `cortex-eval` carries the names as `string` -- it cannot
      // import this package's union -- and validates them against its own copy at parse time.
      ...(armOptions.maxTurnCharsRoutes === undefined
        ? {}
        : { maxTurnCharsRoutes: armOptions.maxTurnCharsRoutes as readonly TurnCapRoute[] }),
      // §13.83's filter. The classifier is passed with the roles rather than beside them, because
      // a role filter without one is refused by the product: the arm knows this dataset's prefix
      // and the product does not, which is the boundary the option exists to keep. Both reach and
      // classifier travel only when a filter was named, so an unfiltered run's options are
      // byte-identical to the previous run's.
      ...(armOptions.evidenceRoles === undefined
        ? {}
        : {
            evidenceRoles: armOptions.evidenceRoles,
            roleOf: roleOfTurn,
            ...(armOptions.evidenceRolesRoutes === undefined
              ? {}
              : { evidenceRolesRoutes: armOptions.evidenceRolesRoutes as readonly TurnCapRoute[] }),
          }),
    });

  // Workers in flight (§14.22). The first worker reuses the instances just built rather than
  // constructing a second pair, so a serial run is byte-identical to what it always was and a
  // concurrent one differs only in how many questions are open at once.
  //
  // §13.244: built through `createAblationPool` rather than as an object literal, because a literal
  // factory could not be enumerated and the arm's censuses are per-instance state. The literal this
  // replaces was `worker === 0 ? feature0 : buildFeature()`, so workers 1..n-1 got a **fresh instance
  // per pass**: the set of instances a run answered through was a function of (worker, pass) and no
  // reader could have listed it, which is how `41773546221` published a census covering a quarter of
  // its questions while every other field in the artifact agreed with itself.
  const baseline0 = buildBaseline();
  const feature0 = buildFeature();
  const workers = readWorkers(process.env);
  const pool =
    workers === 1
      ? undefined
      : createAblationPool({
          workers,
          first: { baseline: baseline0, feature: feature0 },
          baselineFor: () => buildBaseline(),
          featureFor: () => buildFeature(),
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
      `confidenceSignal=${armOptions.confidenceSignal}, ` +
      // On the same line and for the same reason as the rest: it is a prompt input that
      // changes what every number below means. §13 dispatches the ask change to the
      // routes that carry the loss, and a reader with the log alone has to be able to
      // tell an ask change from a gate change.
      `ask=${armOptions.ask}, ` +
      // On the same line for the same reason, and it is the variable §13.16 left open:
      // every other input to the prompt has been measured, and whether the budget buys
      // the turns that matter has not. A reader comparing this run against
      // `38142407062` needs both halves -- the signal and the width it was built at --
      // because `retrieval` at a width of `8` and at `64` are different experiments.
      `relevanceSignal=${armOptions.relevanceSignal}` +
      (armOptions.relevanceSignal === 'none' ? '' : `, relevanceTopK=${armOptions.relevanceTopK}`) +
      // Printed under the same rule as the width: the unit is a property of the ranking the
      // budget was spent by, and with no signal there is no ranking for it to describe.
      (armOptions.relevanceSignal === 'none'
        ? ''
        : `, relevanceUnits=${armOptions.relevanceUnits}`) +
      // Printed on every run, unlike the width and the unit: this one is a property of the
      // evidence section rather than of a ranking, so `none` is a fact about the prompt. It
      // is also the log's only record of the one spread in this file that no test covers.
      `, maxTurnChars=${armOptions.maxTurnChars ?? 'none'}` +
      // Printed on every run beside the width it modifies, and for the same reason: the marker is
      // a fact about the evidence section (`none` = the cut stays silent), and it is the only place
      // the log and the artifact config can be compared against the prompt that was rendered.
      `, turnCutMarker=${armOptions.turnCutMarker ?? 'none'}` +
      `, maxPromptChars=${armOptions.maxPromptChars ?? 'default'}` +
      // The width the pass ran at, on the line every other run property is on. It is not part
      // of the arm's configuration (§14.22) but it is part of what the wall clock means, and a
      // reader comparing two durations needs it.
      `, workers=${workers}` +
      // §13.227. The pace is not part of the arm (§14.22) but it is the difference between a run
      // that finished and one that died at question 55, and `41553176719` left no trace of which
      // pace it had run at because there was none to have.
      `, minIntervalMs=${pacing.minIntervalMs ?? 'none'}` +
      `, retryBudgetMs=${pacing.retryBudgetMs ?? 'default'}` +
      // §13.306, on the same line for the same reason: the deadline is the third transport number
      // and the only one whose absence is invisible -- a run that took the implied 300 s and one
      // that declared 600 s produced the same bytes before this clause existed.
      `, readerTimeoutMs=${pacing.timeoutMs ?? 'implied'}` +
      // How many questions this pass may lose to a deadline before it stops being a measurement.
      // Computed through the same function the ceiling check uses, so the printed number and the
      // enforced one cannot be two answers.
      `, deadlineLossCeiling=${deadlineLossCeiling(dataset.questions.length)}`,
  );

  const result = await runCortexMemoryArm(dataset, baseline0, feature0, {
    runs,
    // The same resolution the gate line above printed, handed to the report rather than re-read:
    // the artifact and the log then cannot disagree about the pace, which is the whole reason the
    // pace is in the artifact (§13.228).
    readerPacing: pacing,
    ...(pool === undefined ? {} : { pool }),
    scorer: judgeScorer(createLlmJudge(judgeLlm)),
    memoryArmConfig: toMemoryArmConfig(
      armOptions,
      {
        provider: provenance.provider,
        model: provenance.model,
        dimensions: provenance.dimensions,
        preflight: 'ok',
      },
      // §13.97's reach, as measured rather than as configured. The counts are what makes the
      // run falsifiable from its own artifact: `questions=121` says the treatment reached the
      // route, `phrases` says the model produced usable phrases, and `refused` separates a
      // model problem from a wiring problem. Absent when the arm ran the control, because a
      // zeroed object would read as "expanded nothing" rather than "did not expand".
      expansion === null
        ? undefined
        : {
            questions: expansion.questions,
            phrases: expansion.phrases,
            refused: expansion.empty,
          },
      // §13.110's debt, paid: which reader answered, in the artifact rather than in a job log
      // that expires. Resolved by the same function `createLlmFromEnv` calls, so the model that
      // answers and the model this record names cannot be two readings of one environment --
      // and `temperature: null` states the fact §13.114 registers rather than the value the
      // workflow input claims.
      resolveReaderIdentity(process.env),
      // §13.115: which scorer reordered the pool, and what it reported. Always present -- `provider:
      // 'none'` for the control -- so an artifact written from here never leaves "dispatched the
      // control" and "predates the field" as the same bytes.
      rerankRecord,
      // §13.312: which judge **graded**, which is not the same question as which reader answered
      // and was the same answer for so long that no artifact could tell them apart. Resolved by the
      // function `createJudgeFromEnv` itself calls, so the model that scores and the model this
      // record names cannot be two readings of one environment -- the same rule the reader line
      // above follows, applied to the object that moved.
      {
        providerId: judgeIdentity.providerId,
        model: judgeIdentity.model,
        temperature: judgeIdentity.temperature,
        source: judgeIdentity.source,
      },
    ),
    // §13.153's mechanism is recorded beside the flag that says the arm ran at all, because the two
    // artifacts this dispatch compares differ by exactly this entry: the config line is the only place
    // a reader of the JSON can see that the treatment was administered rather than merely dispatched.
    featureConfig: { cortexMemory: true, windowReorder },
    datasetFingerprint,
    // Read from the parsed arm options, not decided here: §13.12 registers the
    // bound, and a value written in this file would never appear in the
    // environment the pre-registration guard compares against `§10.3`.
    //
    // The `undefined` branch omits the key rather than assigning `undefined` to
    // it: the workspace runs `exactOptionalPropertyTypes`, under which "no bound"
    // and "a bound of undefined" are different types, and only the omission means
    // what this branch means.
    ...(Number.isFinite(armOptions.evidenceTurnsPerRecord)
      ? { evidenceBound: { maxTurnsPerRecord: armOptions.evidenceTurnsPerRecord } }
      : {}),
    // §13.62. The candidate pool, so a record can say whether a gold turn it did not
    // receive was never ranked or was ranked and cut by the budget. Absent when no ranking
    // was built, which is the truth: with `relevanceSignal: none` there is no pool, and a
    // record that reported `pool: 0` would describe a ranking that surfaced nothing.
    //
    // The list arrives from `rankedCandidatesFor`, which is the same structure `candidatesFor`
    // reads as a set -- one ordered array, two views -- and it is the view this line needs.
    //
    // It used to spread `candidatesFor` instead, which worked only because a `Set` preserves
    // insertion order. That is a property of the JavaScript `Set`, not of this interface:
    // `candidatesFor`'s own docblock says the returned set deliberately answer only "was this
    // turn a candidate" and refuses the ordering question, so a caller reading the order out of
    // it was depending on a guarantee nobody made. `goldRanks` and the window composition both
    // read this array as ordered, and `rankedCandidatesFor` exists precisely so they can.
    ...(relevance === null
      ? {}
      : { relevancePoolFor: (question: string) => relevance.rankedCandidatesFor(question) }),
    // §13.85's policy, forwarded to the RECORD as well as to the product. The two are different
    // objects and this line is the whole difference: without it the prompt filters roles and the
    // artifact divides by a denominator the run could never fill. `bench/**` is an entry point and
    // is not covered, which is why the arm's own tests pin the behaviour and this line is stated
    // where a reader of the run's configuration will look.
    ...(armOptions.evidenceRoles === undefined
      ? {}
      : {
          evidenceRoles: armOptions.evidenceRoles,
          ...(armOptions.evidenceRolesRoutes === undefined
            ? {}
            : { evidenceRolesRoutes: armOptions.evidenceRolesRoutes }),
        }),
    onProgress,
    // §13.30, and it is set by the workflow rather than defaulted here: an absent value
    // means no ceiling, which is what every archived run was produced under, so a default
    // would silently change what those runs measured. See `readBudgetMs`.
    ...(readBudgetMs(process.env) === undefined ? {} : { budgetMs: readBudgetMs(process.env) }),
  });

  // §1.38.5's wiring proof, and it is a check on the ARTIFACT rather than on the variable.
  //
  // Between the transform above and this line sit the arm's own keying, the pool's per-worker
  // factories and four repetitions. A run whose transform never reached the graded dataset -- a
  // spread deleted at the call, a dataset replaced after the transform -- would publish a
  // shipped-corpus score under a name that says `+oracle`, and that number would be read as a
  // ceiling by everyone including this project's own readouts. The check is after the fact and on
  // the field a reader reads, so it cannot pass while the two describe different evidence.
  if (oracle !== undefined) {
    assertOracleReached(result.report, oracle.census);
  }

  // The census is already inside `result.report` -- `runCortexMemoryArm` puts it
  // there before rendering, so this file has nothing to merge. That is deliberate:
  // a second merge site here is the side channel the report type exists to close
  // (`report.ts`'s `abstentionReasons` doc, and `report-retry-fires.test.ts`).
  // The JSON and the Markdown are therefore two renderings of one object and
  // cannot disagree about whether the census is present.
  // The JSON is written through `serializeReportOrReduce` rather than by calling
  // `JSON.stringify` here, and the reason is run `38003036421`: the arm completed
  // all four runs of all five hundred questions and then died on this line with
  // `RangeError: Invalid string length`. A complete measurement -- about forty
  // minutes of grading -- was destroyed by a serialization limit, and the artifact
  // could not distinguish "measured and un-writable" from "never measured". The
  // decision of what to do when the report does not fit lives in `cortex-eval`
  // (`report-write.ts`) because `bench/**` is outside the coverage boundary and a
  // decision written here is a decision no test can reach.
  //
  // The Markdown stays the plain write it was. It renders the same object, it is
  // three orders of magnitude smaller, and routing it through the reducer would
  // imply it can be too large, which would be a claim about a document that has
  // never been near a limit.
  writeFileSync('benchmark-cortex-memory-ablation-report.md', result.markdown);
  const written = serializeReportOrReduce(
    result.report,
    { serialize: (value) => JSON.stringify(value, null, 2) },
    {
      // The fallback is the §13.12 bound, used only when the dispatch did not name
      // one. `Infinity` is the arm option's "carry everything" default, and this
      // writer cannot express that -- so an unconfigured run still gets a bound it
      // can write, and the artifact's `evidenceReduction` field says so. A bound of
      // at least 1 is required by the reducer itself.
      maxTurnsPerRecord: Number.isFinite(armOptions.evidenceTurnsPerRecord)
        ? armOptions.evidenceTurnsPerRecord
        : EVIDENCE_TURNS_PER_RECORD,
    },
  );
  writeFileSync('benchmark-cortex-memory-ablation-report.json', `${written.json}\n`);

  // §13.274's ledger, written beside the report and never inside it.
  //
  // Inside would put an instrument's bookkeeping into the artifact schema, where every gate that
  // reads `questions[].promptChars` would start seeing a run whose prompts were edited after the
  // product built them -- and the gates that exist to notice that would be right to fail. A
  // separate file says the same thing without teaching the report a new shape: this run's prompts
  // grew by exactly these many characters, on these questions.
  //
  // Written only when the run restored, because an empty ledger on an ordinary run would be a
  // record of an experiment that was not administered.
  if (restorePlan !== null) {
    const matched = restoreCalls.filter((call) => call.questionId !== null);
    const perQuestion = new Map<string, { calls: number; grewBy: number }>();
    for (const call of matched) {
      if (call.questionId === null) continue;
      const current = perQuestion.get(call.questionId) ?? { calls: 0, grewBy: 0 };
      perQuestion.set(call.questionId, {
        calls: current.calls + 1,
        grewBy: current.grewBy + (call.afterChars - call.beforeChars),
      });
    }
    const ledger = {
      source: restorePlan.source,
      entries: restorePlan.entries.map((entry) => {
        const seen = perQuestion.get(entry.questionId);
        return {
          questionId: entry.questionId,
          recordedOutcome: entry.recordedOutcome,
          restoredTurns: entry.turns.length,
          restoredChars: restoreBlock(entry).length,
          // Absent rather than zero when the question was never asked: the same rule the artifact
          // follows, and the one §13.268.7 cost this campaign a table to learn.
          ...(seen === undefined ? {} : { calls: seen.calls, grewBy: seen.grewBy }),
        };
      }),
      // A non-zero count is an instrument defect, not a result: some prompt reached the provider
      // without a question line this plan could name, so its answer is not part of the intervention
      // and cannot be told apart from one that is.
      unmatchedCalls: restoreCalls.filter((call) => call.questionId === null).length,
      calls: restoreCalls.length,
    };
    writeFileSync('restore-calls.json', `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(
      `Restore ledger: ${ledger.calls} call(s) over ${perQuestion.size} of ` +
        `${restorePlan.entries.length} planned question(s), ${ledger.unmatchedCalls} unmatched`,
    );
  }

  // Stated on the console as well as in the artifact, for §10.8's reason: the log
  // is what survives when the artifact is not collected, and a reader of the log
  // alone must not conclude that a reduced report is a complete one. The marker
  // constant comes from `cortex-eval` rather than being respelled here, so the
  // console line and the `turns` entries it describes can never disagree about
  // what a reduction looks like.
  if (written.reduced && written.manifest !== null) {
    console.log(`=== cortex-memory report REDUCED (${REDUCED_TURNS_MARKER} ...]) ===`);
    console.log(JSON.stringify(written.manifest));
  }

  // Read back off the return value rather than re-deriving the rule here. The
  // number is the only thing that distinguishes "the run published the vectors it
  // paid for" from "the run published nothing", and the workflow's cache entry for
  // this run is a copy of this file -- so a reader of the log can tell, without
  // opening the cache store, whether the next run will start from this one's work.
  console.log(
    describeEmbeddingCachePersist(persistEmbeddingCache(cachePath, provenance), cachePath),
  );

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

  // Which channel decided each verdict, printed beside the run that produced them.
  //
  // Run `38953157688` raised MR's accuracy by 4.95pp and the entire rise came from
  // the LLM judge: the mechanical channels decided 86 of MR's 121 verdicts before the
  // ask changed and 33 after, none of the latter true. Nothing in that run said so,
  // and the split had to be reconstructed offline from the artifact with a stubbed
  // judge. §13.40.9 registers this line as the fix.
  console.log(`=== ${describeScorerChannels(scorerChannelStats())} ===`);

  // How many questions a provider's moderation gate refused, printed beside the number it affects.
  //
  // Run `42368550937` died instead of printing this: one refusal was one throw and the pass ended at
  // 83 of 500. The line exists so the next such run reports `provider refusals: 1 (IE 1)` and a score
  // rather than a stack, and so that a reader of the number can see the denominator it was computed
  // over is the denominator it claims.
  console.log(`=== ${describeProviderRefusals(providerRefusals())} ===`);
  // §13.309. One line for both kinds of transport loss, because they share the ceiling; the kinds
  // are named apart because their repairs differ, and a reader sent to `CORTEX_READER_TIMEOUT_MS`
  // over a quota problem would re-dispatch and lose the next pass the same way.
  console.log(`=== ${describeTransportLosses(lostToTransport(), dataset.questions.length)} ===`);

  console.log('=== cortex-memory ablation ===');
  console.log(result.markdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // Name the question the run died on, before the stack, and say how long it had been
  // running and whether the retry ladder under it was exhausted.
  //
  // The first half is the one run `37281155088` was missing -- an HTTP 402 ended a
  // ~52-minute arm and the only durable trace said nothing about how far it got. The
  // progress event fires BEFORE a question is answered, so this line names the question
  // the throw happened inside, not the one before it.
  //
  // The second half is §13.28, and it is the half run `38659495034` was missing: it spent
  // 1h49m inside the reference pipeline's FIRST question, and `q=1/500` -- which is also
  // what a pass that died immediately would print -- was the whole record. The summary is
  // built by `describeFailure` rather than here so that it has tests; an entry point that
  // assembles a log line by hand is a log line no test can execute, which is why the
  // previous two incidents of this class changed nothing.
  const summary = describeFailure({
    progress: lastProgress ?? undefined,
    error,
  });
  writeFileSync('benchmark-error.log', `${summary}\n${message}\n`);
  // Write what the run MEASURED, not only what it embedded.
  //
  // Run `37942775447` is why this exists: ~40 minutes of grading across six routes
  // and two sides, ended by `TypeError: terminated`, and the artifact held a stack
  // trace and nothing else. The failure path persisted the embedding cache and not
  // the answers -- the wrong way round, since a re-embed repeats a deterministic,
  // already-paid computation while a re-answer repeats the measurement itself.
  //
  // What is written is the answer VECTORS and their extent, never `delta`, an
  // aggregate or a per-capability table: every one of those is a function of both
  // sides over the same index vector, so with one side short they would be
  // arithmetic over data that was never paired and would read exactly like a real
  // result. The `partial` field is attached by `runAblation` (`attachPartial`),
  // which is where that rule lives and is tested -- this file only writes it out.
  const partial = (error as { partial?: unknown }).partial;
  if (partial !== undefined) {
    writeFileSync('benchmark-cortex-memory-partial.json', `${JSON.stringify(partial, null, 2)}\n`);
    console.log('=== cortex-memory partial measurement (INCOMPLETE, no delta) ===');
    console.log(JSON.stringify(partial));
  }
  // What the transport layer observed, and why it is printed rather than left in the
  // stack.
  //
  // Run `38520676669` spent three hours and eight minutes over four thousand questions
  // and ended on `TypeError: terminated`. The log named no endpoint, no provider and no
  // attempt count, so "was this a transient fault that survived six attempts, or a single
  // abort from somewhere the retry loop does not wrap" -- the only question that decides
  // whether the correct response is a re-dispatch or a code change -- had no answer in
  // the record. `RetryExhaustion` carries the first three; `retryStats()` carries the
  // run's whole retry history, which is what says whether the failing call was the only
  // trouble or the last of many.
  const exhaustion = (error as { retryExhausted?: RetryExhaustion }).retryExhausted;
  if (exhaustion !== undefined) {
    console.error('=== exhausted provider call ===');
    console.error(JSON.stringify(exhaustion));
  }
  // The channel split matters MOST on a failure: a run that died mid-pass has no
  // artifact to reconstruct it from, and this is the only record of which scorer the
  // answers it did grade went through.
  console.error(`=== ${describeScorerChannels(scorerChannelStats())} ===`);
  console.error(`=== ${describeProviderRefusals(providerRefusals())} ===`);
  console.error('=== transport retry accounting (process-wide) ===');
  console.error(JSON.stringify(retryStats()));
  console.error(summary);
  console.error(message);
  // Persist whatever was embedded before the failure, on the failure path too.
  // `bench/run.ts` does the same, and the reason is the same: a run that dies at
  // question 300 of 500 has still paid for its embeddings, and discarding them
  // charges the next run for the same vectors. Best-effort, so it can never mask
  // the original error.
  try {
    // Reported on stderr, next to the failure record rather than in the middle of
    // it. A failure path that persists nothing is now a normal outcome -- the
    // process may have died before it restored -- and the line saying so is what
    // separates that from a salvage that worked.
    console.error(
      describeEmbeddingCachePersist(
        // Like `bench/run.ts`, resolved here rather than closed over: this handler runs when
        // main threw, and the provenance is a pure function of the environment.
        persistEmbeddingCache(
          cortexMemoryArmEmbeddingCachePath(process.env),
          resolveEmbeddingProvenance(process.env),
        ),
        cortexMemoryArmEmbeddingCachePath(process.env),
      ),
    );
  } catch {
    // The console output and `benchmark-error.log` are the primary diagnostics.
  }
  process.exitCode = 1;
});

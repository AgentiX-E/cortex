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
import {
  createLlmFromEnv,
  createEmbeddingWithProvenanceFromEnv,
  describeFailure,
  retrieveTopKByQueriesHybrid,
  type Retrieval,
} from '@agentix-e/cortex-eval';
import { retryStats, type RetryExhaustion } from '@agentix-e/cortex-llm';
import {
  NaturalLanguageMemorySystem,
  buildRetrievalRelevanceIndex,
  createLlmJudge,
  judgeScorer,
  loadLongMemEval,
  cortexMemoryArmEmbeddingCachePath,
  cortextMemoryArmOptions,
  describeEmbeddingCachePersist,
  persistEmbeddingCache,
  restoreArmEmbeddingCache,
  roleOfTurn,
  preflightEmbedding,
  runCortexMemoryArm,
  sampleInstances,
  toMemoryArmConfig,
  type BenchmarkProgress,
  type EmbeddingPreflight,
  type RelevanceCase,
  type RelevanceIndex,
  type RelevanceIndexOptions,
} from '@agentix-e/cortex-eval';
import {
  CortexMemory,
  confidenceFromLength,
  type EvidenceAsk,
  type PromptContract,
  type TurnCapRoute,
} from '../src/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  REDUCED_TURNS_MARKER,
  describeScorerChannels,
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
        `${JSON.stringify(raw)}. It is the per-pass ceiling: 0 abandons every pass before ` +
        'its first question, which fails the run while looking like a healthy configuration.',
    );
  }
  return minutes * 60_000;
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
  // The cases the index is built over: each question with its own context, and nothing
  // else. The type carries no ground-truth field, which is what makes the signal
  // non-oracle structurally rather than by convention -- the answer key is not a value
  // this call could reach even if a later edit wanted it to.
  const relevanceCases: readonly RelevanceCase[] = dataset.questions.map((question) => ({
    question: question.question,
    context: question.context,
  }));
  const relevanceOptions: RelevanceIndexOptions = { topK: armOptions.relevanceTopK };
  // §13.63. Two mechanisms behind one name-typed switch, so the artifact's
  // `relevanceSignal` says which one ranked the turns and the two arms are comparable
  // across runs. `retrieval` is dense cosine alone and is what every archived run used;
  // `retrieval-hybrid` fuses that ranking with a rare-keyword channel by reciprocal rank.
  // Both share `Retrieval`'s signature, so the index takes a mechanism rather than a flag.
  const retriever: Retrieval | undefined =
    armOptions.relevanceSignal === 'retrieval-hybrid'
      ? (queries, context, topK) =>
          retrieveTopKByQueriesHybrid(embedding, [...queries], [...context], topK)
      : undefined;
  const relevance: RelevanceIndex | null =
    armOptions.relevanceSignal === 'retrieval' || armOptions.relevanceSignal === 'retrieval-hybrid'
      ? await buildRetrievalRelevanceIndex(embedding, relevanceCases, {
          ...relevanceOptions,
          ...(retriever === undefined ? {} : { retrieve: retriever }),
        })
      : null;
  if (relevance !== null) {
    console.log(
      `Relevance index: ${relevance.scoredPairs} scored (question, turn) pairs over ` +
        `${relevance.questions} questions at topK=${relevance.topK}`,
    );
  }

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
    ...(armOptions.relevanceUnits === 'session' ? { relevanceUnits: 'session' as const } : {}),
    // §13.67's single variable, spread conditionally for the reason the three above are:
    // no cap IS the shipped behaviour and is expressed by NOT passing the key, so a run that
    // names no cap reproduces the previous prompt byte for byte. This is the one line in the
    // chain that no test reaches -- `bench/**` is excluded from coverage as an entry point --
    // which is why the same value is echoed in the log line below and projected into the
    // artifact's config: a spread deleted here would leave the run's own log and its own
    // config claiming a treatment the prompt never received.
    ...(armOptions.maxTurnChars === undefined ? {} : { maxTurnChars: armOptions.maxTurnChars }),
    // §13.81's budget. Absent means the product's 24,000, which is what every archived run used; a
    // number raises the room without touching a single turn, which is the only lever §13.80 left.
    ...(armOptions.maxPromptChars === undefined
      ? {}
      : { maxPromptChars: armOptions.maxPromptChars }),
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
      `, maxPromptChars=${armOptions.maxPromptChars ?? 'default'}`,
  );

  const result = await runCortexMemoryArm(dataset, baseline, feature, {
    runs,
    scorer: judgeScorer(createLlmJudge(llm)),
    memoryArmConfig: toMemoryArmConfig(armOptions, {
      provider: provenance.provider,
      model: provenance.model,
      dimensions: provenance.dimensions,
      preflight: 'ok',
    }),
    featureConfig: { cortexMemory: true },
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
    // The set arrives from `candidatesFor`, which returns the keys `relevanceFor` is built
    // from, so the two counts cannot disagree. Copied to an array here rather than handed
    // through as a `Set` because `goldOverlapOf` takes the same list type as the delivery
    // it counts against -- one shape for the two memberships it tests.
    ...(relevance === null
      ? {}
      : { relevancePoolFor: (question: string) => [...relevance.candidatesFor(question)] }),
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
  console.log(describeEmbeddingCachePersist(persistEmbeddingCache(cachePath), cachePath));

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
        persistEmbeddingCache(cortexMemoryArmEmbeddingCachePath(process.env)),
        cortexMemoryArmEmbeddingCachePath(process.env),
      ),
    );
  } catch {
    // The console output and `benchmark-error.log` are the primary diagnostics.
  }
  process.exitCode = 1;
});

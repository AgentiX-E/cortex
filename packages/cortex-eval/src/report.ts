/**
 * Scientific benchmark report: runs a baseline-vs-feature ablation and produces
 * a structured report plus a Markdown rendering for CI artifacts.
 */
import type { UsageSnapshot } from '@agentix-e/cortex-ai';

import type {
  AblationResult,
  AggregateStats,
  BenchmarkDataset,
  MemorySystem,
  Metrics,
} from './types.js';
import type { CohortCoverage } from './datasets/sampling.js';
import type { EvidenceReduction, QuestionRecord } from './question-record.js';
import { runAblation, type AblationOptions, type AblationPool } from './ablation.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import { exactMatchScorer, type AnswerScorer } from './metrics.js';
import type { RerankCensus } from './rerank-census.js';
import type { RerankBounds } from './rerank-factory.js';
import type { TransportRetryReport } from './retrieval-diagnostics.js';
import { passShapeLines, passShapeReport, type PassShape } from './pass-shape.js';
import type { ReaderPacing } from './reader-transport.js';
import type { EndpointCheck, ReaderProviderId } from './reader-provider.js';
import {
  bothSides,
  costEfficiencyFrom,
  residualUsage,
  type CostEfficiency,
  type UsageBySide,
} from './usage-by-side.js';
import { dominantFlow } from './answer-transition.js';
import type { AnswerTransition } from './types.js';

export type AblationReport = {
  dataset: string;
  questionCount: number;
  baseline: { name: string; metrics: Metrics };
  feature: { name: string; metrics: Metrics };
  ablation: AblationResult;
  generatedAt: string;
  /**
   * The content identity of the dataset FILE this run graded, as `sha256:<hex>`.
   *
   * `dataset` is a name (`longmemeval`) and `questionCount` is a sample size; neither
   * says which bytes were read, and the workflow fetches that name from
   * `resolve/main`, a reference that can move without any commit here. So a score is
   * a property of (pipeline, file) and this artifact only ever wrote one of the two.
   *
   * Absent rather than defaulted when no file was named -- `longmemeval-mini` is
   * constructed in code, and a synthesized digest for it would claim a file
   * provenance it does not have. The absent branch is what keeps "predates the
   * field" and "read no file" from being the same bytes, which is the same rule
   * `abstentionReasons` states below.
   *
   * Recording only. Refusing on a mismatch needs a pinned expected digest, and there
   * is no file in this environment to take one from --
   * `cortex/docs/AUDIT-BENCHMARK-WALLCLOCK.md` §7.2 keeps that half open.
   */
  datasetFingerprint?: string | undefined;
  /**
   * Coverage of the pre-registered cohort, when the arm declares one.
   *
   * Part of the report rather than a side-channel return value because a
   * coverage shortfall changes what the numbers below it MEAN. Returning it
   * beside the report let `bench/run.ts` write the coverage to JSON while the
   * Markdown rendered a 1-of-7 cohort as an ordinary 35-question ablation, with
   * no caveat anywhere a human reader would look — the exact "same name,
   * different experiment" outcome the guard exists to prevent. Carrying it in
   * the report makes it impossible to render the results without having the
   * coverage in hand.
   *
   * Absent for arms with no cohort, which is why the banner is conditional.
   */
  cohortCoverage?: CohortCoverage | undefined;
  /**
   * Retry-fire counts for the abstention-retry arm, when the arm runs a counter.
   *
   * Carried in the report for the same reason `cohortCoverage` is: the fire count
   * is not metadata about the result, it is what makes the result interpretable.
   * This arm's published finding is a null one (accuracy unchanged), and the
   * source comment on `formatRetryFireSection` states why the counter is
   * load-bearing -- `Δ = 0.00 pp` is equally predicted by a working feature on a
   * dataset it cannot help and by a feature that was never wired in. Only the fire
   * count separates those two.
   *
   * Returning it beside the report was the same defect class as the cohort
   * coverage side channel (`docs/FIX-COHORT-COVERAGE-SIDE-CHANNEL.md`): the
   * Markdown received the section through a string concatenation at the return
   * site and the JSON through a spread at the call site, so neither the renderer
   * nor a consumer holding the report could produce the section. Re-rendering the
   * persisted artifact dropped it silently.
   */
  retryFires?: RetryFireCounts | undefined;
  /**
   * Why the feature side abstained, when the system under test can say.
   *
   * Carried in the report for the third time and the same reason as
   * `cohortCoverage` and `retryFires`: a value computed correctly, returned
   * beside the report, and then lost on the path to the Markdown reader. Both
   * earlier instances are documented in `retryFireLines`; this one was found by
   * auditing for the pattern rather than by paying for it again.
   *
   * The evidential weight is specific and high. `docs/09-progress-and-delivery-report.md`
   * §10.10 records a run armed at `retrievalThreshold: 0.25` whose abstention
   * moved `+46.40pp`, read from the ablation tables alone as the retrieval gate
   * closing on the questions the baseline answered. The gate had never closed
   * once -- the value function returns the constant `0.5` at that arming, so the
   * cut was inert and all `479` abstentions were the model's. **The tables could
   * not contradict the reading**; only the census could, and it was not in the
   * document a reader opens.
   *
   * Absent for systems with no census, so the section is conditional. A zeroed
   * default is deliberately not used: it is indistinguishable from a run that
   * genuinely abstained nowhere, which is the class of ambiguity this field
   * exists to remove.
   */
  abstentionReasons?: AbstentionReasons | undefined;
  /**
   * What the abstention-recovery pass did: consultations attempted, and how many produced an answer.
   *
   * Beside `abstentionReasons` rather than inside it, because that census counts one question once
   * and folding a retry into it would either double-count a question or hide the pass. Present only
   * when the system exposes `recoveryCensus()`, which is the statement "this build carries the pass";
   * absent therefore means the pass could not have fired, not that it fired zero times.
   */
  recovery?: RecoveryCensus | undefined;
  /**
   * What the bare-decline retry did: consultations attempted, and how many produced an answer.
   *
   * A third field rather than a value inside `recovery`, because the two treatments act on different declines.
   * `recovery` consults when a decline contradicted its own evidence list; `bareRetry` consults when the first
   * answer was the abstention token and nothing else, and the second prompt is built without that token. A system
   * can carry either, both, or neither, and folding them together would let a reader credit a conversion to the
   * treatment that did not produce it.
   *
   * Present only when the system exposes `bareRetryCensus()`, which is the statement "this build carries the
   * pass". Run `40522788515` ran `reviewPass: 'bare'` over five hundred questions and reported an accuracy
   * identical to its control, with nothing in the artifact to say whether the pass fired and converted nothing or
   * never fired at all — the ambiguity this field exists to remove.
   */
  bareRetry?: BareRetryCensus | undefined;
  /**
   * What the reply-contract repair did, split by kind, and absent unless the run carried it.
   *
   * A fifth field rather than another value of `bareRetry`, because the two repairs act on shapes that retry cannot
   * see: a prose refusal parses as an answer, and a list of quotations parses as an answer too, so `bareRetry`
   * reporting `0` on a run whose repair fired eight times would be a census of the wrong mechanism. Absent means
   * the build could not have fired it -- the reading §13.268 gives `audit` -- which is why the producer writes the
   * field only when the accessor answers.
   */
  replyRepair?: ReplyRepairCensus | undefined;
  /**
   * What the membership audit did: consultations issued, and how many moved the answer.
   *
   * A fourth field, absent unless the run carried `reviewPass: 'audit'`. Its absence is a statement that the
   * mechanism could not have fired, which is the only reason the field is conditional rather than zeroed: a
   * zeroed audit on a `bare` run would be the "a mechanism that never ran looks like one that ran and agreed"
   * ambiguity `bareRetry` above was introduced to remove. See {@link AuditCensus}.
   */
  audit?: AuditCensus | undefined;
  /**
   * What the supersession pass did: consultations issued, answers replaced, and every refusal by name.
   *
   * A sixth field, absent unless the run carried `reviewPass: 'supersede'`, for the reason `audit` above is
   * absent unless the run carried its pass: the mechanism is the only thing that knows whether the build
   * carried it, and a zeroed record from a build without it reads exactly like a pass that looked at every
   * `KU` answer and superseded none.
   *
   * The refusals are a record rather than four integers because the reasons are a property of the population
   * rather than of the mechanism: a run whose refusals are all `not-in-evidence` has a fabricating reader,
   * and a run whose refusals are all `agrees` has a reader that restated its own answer. Two defects with one
   * name is one defect the census can no longer see -- §22.88.6's finding, applied before it cost another run.
   */
  supersession?: {
    readonly attempted: number;
    readonly replaced: number;
    readonly refused: number;
    readonly refusals: Readonly<Record<string, number>>;
  };
  /**
   * The switches this run was configured with, recorded in the report itself.
   *
   * Every number in the report is conditioned on this object, and without it the
   * same artifact is produced by both arms of an A/B -- so a reader holding only
   * the file cannot tell whether the feature was on, off, or inert. That was not
   * hypothetical: the C5 B7 comparison downloaded two artifacts that differed by
   * 2 questions, and neither one said which side of `retrievalSides` it was on.
   * The delta's sign was therefore uninterpretable, and the run had to be
   * discarded (`docs/09-progress-and-delivery-report.md` §20).
   *
   * It was previously written at a single call site, inside the reranking
   * ablation. That arm is guarded on the reranker existing, so a run without a
   * reranker lost the record of its configuration entirely -- and the ablation
   * itself was silently skipped when the enable flag was given a provider name
   * (`rerank=local`), which is how the C5 artifacts came to have no such field.
   * Carrying it in the report type makes the record a property of the report
   * rather than of one branch that happens to run.
   */
  featureConfig?: FeatureConfig | undefined;
  /**
   * The per-question records this report was computed from, one per graded
   * question, in dataset order.
   *
   * This is the field three separate readers were blocked on, and the reason it
   * belongs in the report rather than beside it is the same reason
   * `cohortCoverage` does -- except stronger, because unlike a coverage caveat
   * this array is the only copy of the evidence:
   *
   * 1. `tools/read-b7-criterion.mjs` needs it to recompute the target roster and
   *    apply the three clauses. Absent, the reader fails with "no per-question
   *    array found" and the pre-registered criterion cannot be executed at all.
   * 2. `compareQuestionVectors` needs two aligned correctness vectors to measure
   *    how far the endpoint moves on its own. `variance.ts` was written for
   *    exactly this and had no real caller, because the artifacts carried counts
   *    and discordant ids but never a roster.
   * 3. A reader asking *which* questions moved needs the ids. A count is not a
   *    roster: §20 records an A/B whose two arms differed by two questions and
   *    whose artifacts could not name them.
   *
   * Absent rather than empty when a caller does not supply it. `[]` would say
   * "this run graded zero questions", which is a claim; absence says nobody
   * recorded a roster, which is the truth for an arm that predates this field.
   * The distinction is the same one the retry-fire counters draw between `null`
   * and `0`.
   */
  questions?: readonly QuestionRecord[] | undefined;
  /**
   * What the evidence bound did to this report's records, when it did anything.
   *
   * ## Why a run must state its own reduction
   *
   * Run `38003036421` completed all four runs of all five hundred questions and
   * then died writing the JSON with `RangeError: Invalid string length`. The
   * measurement was complete and could not be written down, and the artifact
   * could not distinguish that from a run that never measured anything. `§13.12`
   * bounds what is carried so the artifact can always be written; this field is
   * how the bound is disclosed rather than hidden.
   *
   * Absent when no record was reduced -- not an object full of zeros, because
   * "no bound was applied" and "a bound was applied and dropped nothing" are
   * different facts about a run, and a manifest that renders them identically
   * would make a decorative bound read as a working one. This is the same
   * `null`-versus-`0` rule the retry-fire counters draw one field over.
   */
  evidenceReduction?: EvidenceReduction | undefined;
  /**
   * What the provider said this run cost, in tokens.
   *
   * ## Why the artifact states a bill at all
   *
   * Every number in this campaign is produced by a process that pays per token, and
   * until §13.140 no artifact stated a single one: `OpenAICompatibleLLM.complete` read
   * the `usage` block off every response and returned only `choices[0]`. The cost of
   * that omission was not the invoice -- it was that no experiment could say whether a
   * change to the window, the instruction block or the retry ladder moved the bill, so
   * a treatment that bought one question with 40% more prompt had no price on it.
   *
   * ## Why absent rather than zeroed
   *
   * For the reason `evidenceReduction` is, one field up. A run whose reader never passed
   * through the instrumented adapter made no measurable call, and a zeroed snapshot would
   * report it as a free one. A run that DID call and whose provider returned no `usage`
   * block is the third case and is the informative one: it attaches, with
   * `unpricedCalls` equal to its call count and its token totals at `0`, which says the
   * bill exists and cannot be read.
   *
   * Nothing here is a currency. Tokens are what the provider published; a price is a
   * fact about a contract that this repository does not own.
   */
  llmUsage?: UsageSnapshot | undefined;
  /**
   * The same spend, split by the side that spent it, with the remainder named.
   *
   * §13.189's instrument. `llmUsage` is the whole bill and cannot say which arm caused it, so a
   * saving on the feature arm was indistinguishable from a saving on the judge -- and the only
   * token question worth asking ("can this cost less without losing answers") starts from that
   * split. The three parts close exactly (`baseline + feature + residual === llmUsage`), and the
   * closure is a property of the definition rather than of a tag applied at each call site:
   * `residual` is the difference, so the judge and the phrasing stage are named by construction.
   *
   * Optional for the reason `llmUsage` is: an artifact written before the instrument existed has
   * no split, and that absence must not read as "both sides spent nothing".
   */
  usageBySide?: UsageBySide | undefined;
  /**
   * What one correct answer cost, and which population its accuracy came from.
   *
   * §13.308. `usageBySide` prices a question; this prices a question **answered correctly**, which
   * is the only version of the number that cannot be improved by answering less. The numerator is
   * the same spend the split reports; the denominator is the mean accuracy over every repetition,
   * so the two populations agree.
   *
   * Absent for four reasons the artifact can really be in, each of which a number would misreport:
   * no side split, no question or repetition count, a run that spent nothing, and a run that
   * answered nothing right. `costEfficiencyFrom` states each refusal at the point it is decided.
   */
  costEfficiency?: CostEfficiency | undefined;
  /**
   * What the transport layer saw: attempts, retries, and how many were `429`.
   *
   * ## Why the spend section is not enough
   *
   * `llmUsage` counts the calls that RETURNED. A call the provider rejected three times and
   * then served is one call there and four requests on the wire, and the artifact could not
   * tell it apart from one served first time — which is precisely the question that decides
   * whether the next dispatch is affordable. Run `41346610318` died on a `429` after six
   * attempts, and no artifact from any run in this campaign has ever carried a retry count.
   *
   * ## Why it attaches even at zero
   *
   * `attachLlmUsage` omits the field when `calls === 0`, because a run whose provider
   * reported no `usage` block is a real state. This one is different: the counters are
   * incremented by the retry loop itself, before any provider answers, so a graded run
   * cannot have zero calls. `calls: 0` here therefore means the counters were not wired —
   * a defect, not a quiet provider — and that is a statement the artifact should be able to
   * make. Absence means the artifact predates the field.
   */
  transportRetry?: TransportRetryReport | undefined;
  /**
   * How much concurrency, how fast, and how long a call could keep trying.
   *
   * Absent on every artifact written before §13.227, and on the reference-pipeline entry, which
   * never resolved a pace. Present on the A/B arm from §13.228 onwards -- see `pass-shape.ts` for
   * why the three values are not in `memoryArmConfig`.
   */
  passShape?: PassShape | undefined;
  /**
   * How many times each question was asked, as the report's own record of it.
   *
   * ## Why this had to become a field rather than stay an option
   *
   * It was an input only -- used to configure the ablation and then dropped -- and
   * the §12.5 artifact shows what that cost. `CortexMemory.#reasons` counts CALLS,
   * and the arm reuses one instance across all repetitions, so the census total is
   * `questions x runs`. The renderer labelled that total "questions through the
   * abstention path": a false statement about the artifact whenever `runs > 1`.
   *
   * §12.5 dispatched with `runs = 4` over a dataset whose `ABS` capability holds 30
   * questions. The census reported `120`, the capability table reported `30`, and
   * both numbers were correct and referred to one quantity -- but nothing in the
   * document said which was which or how they reconciled. A reader comparing them
   * would have had to invent the divisor.
   *
   * The divisor is not guessed at render time either. Deriving it from
   * `questionCount` would assume every question was asked exactly `runs` times,
   * which the census cannot confirm and which a partially-failed run falsifies.
   * Publishing the count that was actually configured is the honest form: the
   * reader divides, and can see that they are dividing by the run count rather
   * than by a number the report invented.
   *
   * Absent when a caller did not configure one, matching `runs`' existing role as
   * an optional ablation input. `1` would be a claim about a run that may not have
   * been single-pass.
   */
  runs?: number | undefined;
  /**
   * The candidate-annotation schema version this run rendered with, or `0` when
   * the annotation was not applied.
   *
   * `CANDIDATE_ANNOTATION_VERSION` states its own contract: "two revisions that
   * render the same context must be indistinguishable, so this is a schema version
   * rather than a library version." The constant was exported and read by nothing,
   * so no rendered context and no report carried the value, and the guarantee was
   * unverifiable by construction — two artifacts produced by different annotation
   * revisions were indistinguishable in exactly the way the docstring forbids.
   *
   * Carried in the report for the same reason `cohortCoverage` and `retryFires`
   * are: it is not metadata about the result, it is what makes the result
   * interpretable. An arm that ran with the annotation and an arm that did not can
   * produce the same accuracy, and only this field separates them.
   *
   * `0` rather than absent when the annotation was off, because "off" is a
   * statement about this run and absence is a statement about this artifact's age.
   * Absent means the run predates the field.
   */
  candidateAnnotationVersion?: number | undefined;
  /**
   * The `cortex-memory` arm's gate configuration, when that arm produced this
   * report.
   *
   * Present exactly when the cross-system arm ran, so its absence is itself the
   * statement "this artifact was produced by a different arm" — which is what a
   * reader comparing the reference pipeline's report against the cognitive layer's
   * needs in order to know the comparison is valid.
   */
  memoryArmConfig?: MemoryArmConfig | undefined;
};

/**
 * The feature switches a benchmark run was configured with.
 *
 * Open-ended by key so a new switch is recorded by adding to the object rather
 * than to a type and a renderer. The values are booleans because every switch
 * here is one: a flag that is only meaningful in combination (as
 * `retrievalSides` is without `candidateDiscrimination`) needs both entries
 * present, which the object shape gives naturally.
 *
 * `false` must be recorded, not omitted: a report that lists only the enabled
 * features cannot distinguish "this switch was off" from "this run predates the
 * switch", and those are different claims about the same file.
 */
export type FeatureConfig = Readonly<Record<string, boolean>>;

/**
 * The `cortex-memory` arm's numeric gate configuration.
 *
 * A separate field rather than more entries in `FeatureConfig`, because that type
 * is `Record<string, boolean>` and its renderer writes `` k=on ``/`` k=off ``.
 * `threshold`, `retrievalThreshold` and `sessionBudget` are numbers, and a boolean
 * projection of them would destroy the value the reader needs: "the threshold was
 * on" is true of every threshold, including the one that admits nothing.
 *
 * Widening `FeatureConfig` to `boolean | number` was the alternative. It was
 * rejected because its renderer would have to start formatting mixed types, which
 * changes the feature-config line of **every** existing artifact, and because a
 * union type would make the boolean arms' `=== true` reads no longer exhaustive.
 * The narrower change is this field, which only the arm that needs it emits.
 *
 * Carried in the report rather than returned beside it for the reason
 * `cohortCoverage` (this file, above) and `retryFires` record at length: a value
 * that reaches the JSON through a spread at the call site and the Markdown through
 * a string concatenation is a value whose renderer can drop it silently. Here it
 * would be worse than a dropped caveat — the numbers ARE the configuration, so an
 * artifact without them cannot be compared against another artifact at all.
 *
 * Absent rather than defaulted for a run that is not this arm. `threshold: 0` is a
 * real configuration ("gates open"), so a defaulted object would make "this arm did
 * not run" indistinguishable from "this arm ran with the identity gate".
 */
/**
 * How many routes the cap vocabulary has, for the `all` shorthand on the config line.
 *
 * A count rather than a list, because this module only needs to answer "is this the whole
 * vocabulary" and duplicating the six names here would be a third copy of a vocabulary that
 * already exists twice for a documented reason. The count is tied to the vocabulary by
 * `tools/__tests__/test_ask_table_parity.py`, which fails if a seventh route is added without
 * updating this -- so the number is guarded rather than merely written down.
 */
/**
 * A reach as the config line spells it: `all`, `none`, or the sorted names joined with `+`.
 *
 * `+` rather than a comma because the line already separates fields with commas, so a comma
 * inside a value would make one field read as three. `all` covers both the absent reach and the
 * full list, because they are the same state reached by two spellings and the artifact must not
 * distinguish them.
 */
function renderReach(reach: readonly string[] | undefined): string {
  if (reach === undefined) return 'all';
  if (reach.length === 0) return 'none';
  if (reach.length === TURN_CAP_ROUTE_COUNT) return 'all';
  return [...reach].sort().join('+');
}

const TURN_CAP_ROUTE_COUNT = 6;

/**
 * The §13.97 reach as one configuration field.
 *
 * One field rather than three, because the configuration line is a sentence about the run
 * and not a table: `expansion=121q/417p/0r` reads as "one hundred and twenty-one questions
 * were asked, four hundred and seventeen phrases reached the index, none were refused", and
 * the fact a reader needs first -- that the treatment reached the route at all -- is the
 * first number. The letters are the unit, so no legend is needed beside it.
 *
 * Rendered only when counts exist: a control run has no reach to report, and `0q/0p/0r`
 * would claim an expansion that reached nothing rather than one that did not run.
 */
/**
 * The §13.101 vote census as one configuration field.
 *
 * `vote=60/52/9` reads as "sixty questions were answered unanimously, fifty-two by a majority that
 * was not unanimous, nine split three ways". The three are separated because a run of nothing but
 * unanimous votes means the treatment never fired, and one line that printed only the total would
 * make that indistinguishable from a run where every vote decided the answer.
 */
function renderVoteCounts(counts: {
  readonly unanimous: number;
  readonly majority: number;
  readonly split: number;
}): string {
  return `, \`vote=${String(counts.unanimous)}/${String(counts.majority)}/${String(counts.split)}\``;
}

function renderExpansionCounts(counts: {
  readonly questions: number;
  readonly phrases: number;
  readonly refused: number;
}): string {
  return `, \`expansion=${String(counts.questions)}q/${String(counts.phrases)}p/${String(counts.refused)}r\``;
}

export type MemoryArmConfig = {
  /**
   * Which evidence the arm graded: the shipped corpus, or each question's gold sessions.
   *
   * The one field on this block that is not a product option, and the reason it is here
   * rather than beside it: `'gold-sessions'` turns the run's accuracy into a reader
   * **ceiling**, and every other number in the artifact then means something different from
   * what it means for a shipped run -- the delta is the cognitive layer's contribution at
   * perfect evidence, not at retrieved evidence. Optional because every archived artifact
   * predates it; `toMemoryArmConfig` sets it on every run from now on, so `undefined` means
   * "this artifact cannot answer the question" rather than "corpus".
   */
  readonly evidenceSource?: 'corpus' | 'gold-sessions' | undefined;
  /** Admission threshold handed to `decideWrite`. In `[0, 1]`. */
  readonly threshold: number;
  /**
   * Retrieval threshold handed to `decideRetrieval`. In `[0, 1]`.
   *
   * Recorded as its own field rather than folded into `threshold`, because the two
   * govern different decisions: `threshold` decides whether a turn is worth
   * KEEPING, and this one decides whether the kept evidence is strong enough to
   * ANSWER with. A single number cannot express the configuration that run
   * `37094200823` actually ran under.
   *
   * That run is why this field exists. It produced a `6.40%` feature accuracy
   * against an `85.20%` baseline, and the artifact's config line said only
   * `threshold=0` -- which reads as the identity configuration and leaves a reader
   * unable to tell whether the abstention path was gated, ungated, or absent. It
   * was absent: `decideRetrieval` had no call site in `cortex-memory` at all, so
   * the 95.40% abstention rate came from the prompt rather than from a decision.
   * One number could not say that, and the artifact therefore recorded a
   * configuration that no reader could act on.
   */
  readonly retrievalThreshold: number;
  /**
   * The per-turn character cap the prompt was assembled under, or absent for none.
   *
   * §13.67's variable: how much of a turn the evidence section may show. Recorded for the
   * reason every other member of this type is -- two artifacts that differ only here read as
   * the same run, and this one changes what the model sees on **every** route, so the
   * difference would be invisible in the numbers and unattributable in the prose.
   *
   * Absent rather than `Infinity` or `0`, because every archived run carried no cap: a
   * sentinel would make an artifact claim a treatment on a run that administered none, which
   * is the §7.4 defect this type exists to prevent.
   */
  readonly maxTurnChars?: number | undefined;
  /**
   * The evidence budget in UTF-16 code units, or absent for the product default.
   *
   * Recorded because it is the one input that changes the room without changing any turn: §13.80
   * showed the room cannot be bought by truncating, so a run that raises the budget and a run that
   * lowers the cap are different experiments with the same coverage and different text.
   *
   * Absent is not the same statement it was before §13.299: the default itself moved (24,000 to
   * 48,000), so this field's absence names a resolution rule and not a number. `effectivePromptChars`
   * carries the number.
   */
  readonly maxPromptChars?: number | undefined;
  /**
   * The room each of the six routes actually assembled a prompt under, always present.
   *
   * §13.299. `maxPromptChars` and `maxPromptCharsByRoute` record how the room was *requested*; the
   * third term in the resolution is the product default, which the artifact cannot otherwise see.
   * `42355323615` is the case that made the difference load-bearing: five routes took the default
   * and `multi-session` took 48,460, the artifact recorded only `{multi-session: 48460}`, and the
   * cost instrument -- whose row exists to say whether the window filled -- read it as uncapped.
   *
   * Recorded for every run rather than only when a route was named, because the artifact that most
   * needed it was the one that named a route and quietly left five alone.
   */
  readonly effectivePromptChars?: Readonly<Record<string, number>> | undefined;
  /**
   * The evidence budget per route, or absent for one room for every route.
   *
   * §13.239. A room is not a depth: at 48,000 characters `41546569106` delivered 61 turns on `flat`
   * (723 characters each) and 179 on `temporal` (205 each), and coverage ran 84.2% to 96.4% across
   * the routes for exactly that reason. Recorded because the redistribution is a statement about
   * *which* route was deepened, and a delta attributed to it from the bare score would be
   * unattributable -- the other four routes are byte-identical by construction.
   */
  readonly maxPromptCharsByRoute?: Readonly<Record<string, number>> | undefined;
  /**
   * The per-question evidence budget this run applied, or absent for the route's room (`03` §14.126).
   *
   * Three numbers, because the plan is three numbers: the share of a question's relevance mass the cut
   * was asked to explain, the floor below which it refuses to go, and the margin between a raw prefix
   * length and its rendered length. Recorded as one object rather than as three top-level fields, since
   * a record carrying `coverage` without `margin` would describe a cut nobody could recompute.
   *
   * Absent on every archived artifact, and that absence is a fact about the run: the room was the only
   * bound. `C6`'s reading is a comparison against exactly that state, so the field has to distinguish
   * "no plan" from "a plan at coverage 1" -- which is why it is not defaulted here.
   */
  readonly widthPlan?:
    | {
        readonly coverage: number;
        readonly floorChars: number;
        readonly renderMargin: number;
      }
    | undefined;
  /**
   * The routes that cap reached. Every route when the run named none.
   *
   * Recorded even when `maxTurnChars` is absent, because the two answer different questions: the
   * width says how much of a turn the prompt may show, and this says where the run intended it to
   * apply. §13.73's experiment changes only this, so two artifacts differing here are the
   * comparison itself -- and without it both would read as the same run.
   */
  readonly maxTurnCharsRoutes?: readonly string[] | undefined;
  /**
   * Whether a turn the per-turn cap cut said so: `'none'` or `'ellipsis'`.
   *
   * §13.187.6D's field. Recorded on every run for the reason `reviewPass` is: `none` is a state
   * this experiment dispatches as its control, so an artifact that spelled nothing could not be
   * told apart from one written before the field existed. Optional on the type only because
   * artifacts written before §13.188 do not carry it.
   */
  readonly turnCutMarker?: string | undefined;
  /**
   * Which slice of a long turn the per-turn cap kept: `'head'` or `'match'`, absent before the field existed.
   *
   * Recorded for the reason `turnCutMarker` is, and absent for the same reason it is recorded: the window
   * changes which characters the reader saw without changing a single count in the artifact -- the same
   * number of turns, the same `evidenceChars` order of magnitude, the same bill -- so two runs that differ
   * only in the window are indistinguishable below this line. A reading compared across them without this
   * field would attribute a difference in *which text* was printed to a difference in *how much*.
   */
  readonly turnWindow?: string | undefined;
  /**
   * The turn roles the evidence was built from, or absent for every role.
   *
   * §13.83's field, and it is recorded for the reason the cap's width is: the treatment is a
   * statement about what the reader was allowed to see, and a run that filtered to user turns
   * and one that did not differ in every number below this line while both claim the same
   * budget. Absent is the state every run before §13.83 was in.
   */
  readonly evidenceRoles?: readonly string[] | undefined;
  /**
   * Which routes the role filter reached. Every route when the run named none.
   *
   * Recorded even when {@link MemoryArmConfig.evidenceRoles} is absent, so two artifacts can be
   * compared on where a filter *would* have applied -- the same rule the cap's reach follows.
   */
  readonly evidenceRolesRoutes?: readonly string[] | undefined;
  /**
   * The second consultation the run administered on the multi-session route (§13.94).
   *
   * Always present, `none` included, for the reason the cap's reach is: an artifact has to answer
   * what the run did, and a field that is only present under treatment makes "no pass" and "a pass
   * that was not recorded" the same row.
   */
  readonly reviewPass?: string | undefined;
  /**
   * Whether a decline that named nothing was asked once more, with the abstention token not offered.
   *
   * Optional in the type for the same reason `reviewPass` is, and always written by the producer: `false` is a state
   * a run can be dispatched to, so an artifact that spelled nothing would leave "ran the control" and "predates the
   * field" as the same bytes. The type stays permissive because archived artifacts genuinely predate it; the
   * producer is where the guarantee lives, and `test/` pins it there.
   */
  readonly reviewBareDecline?: boolean | undefined;
  /**
   * Which reply-contract repairs the run administered (§13.334).
   *
   * Always written by the producer, `off` included, for the reason {@link MemoryArmConfig.reviewPass} is: an
   * artifact has to answer what the run did, and a field that is only present under treatment makes "no repair" and
   * "a repair that was not recorded" the same row. Optional in the type because archived artifacts predate it.
   */
  readonly replyRepair?: string | undefined;
  /**
   * Whether the multi-session route's ranking was built from the question alone or from the
   * question plus model-written activity phrases (§13.97).
   *
   * Always present, `none` included, for the reason {@link MemoryArmConfig.reviewPass} is: an
   * artifact has to answer what the run did, and a field that is only present under treatment
   * makes "no expansion" and "an expansion that was not recorded" the same row.
   */
  readonly queryExpansion?: string | undefined;
  /**
   * Whether the product printed the statements that state one detail twice (§13.352).
   *
   * Always present, `false` included, for the reason {@link MemoryArmConfig.reviewPass} is: an
   * artifact has to answer what the run did, and a field that is only present under treatment makes
   * "ran the control" and "predates the field" the same row.
   */
  readonly conflicts?: boolean | undefined;
  /**
   * The multi-session consultation count the run used (§13.101).
   *
   * Always present, `none` included, for the reason {@link MemoryArmConfig.reviewPass} is: an artifact
   * has to answer what the run did, and a field that is only present under treatment makes "one
   * consultation" and "a count that was not recorded" the same row.
   */
  readonly selfConsistency?: string | undefined;
  /**
   * How far the expansion reached, when one ran (§13.97).
   *
   * `questions` is the number of distinct multi-session questions the arm asked the model
   * about, `phrases` the number of distinct phrases the index was actually built with, and
   * `refused` the questions whose response the parser discarded entirely. Recorded rather
   * than inferred, because the three separate the two failures this treatment can have: a
   * model that refuses (phrases low, refused high) and a wiring that never reached the route
   * (questions zero). Absent when the run administered the control, for the same reason the
   * optional fields above are: a zeroed object would read as "expanded nothing" while a
   * missing one reads as "did not expand".
   */
  /**
   * How every multi-session vote resolved in a run that voted (§13.101).
   *
   * Read from the feature system after the ablation, like `abstentionReasons`, because it is a
   * count of what happened rather than a configuration. Present only when the run consulted more
   * than once: an absent field is a run that did not vote, which is a different fact from a vote
   * count of zero.
   */
  readonly voteCounts?:
    | {
        readonly unanimous: number;
        readonly majority: number;
        readonly split: number;
      }
    | undefined;
  readonly queryExpansionCounts?:
    | {
        readonly questions: number;
        readonly phrases: number;
        readonly refused: number;
      }
    | undefined;
  /**
   * Source trust stamped on every memory admission constructs. In `[0, 1]`.
   *
   * The ceiling of the value function is
   * `confidence * sourceTrust * (0.5 + 0.5 * recency)`, so this number is what
   * decides whether a threshold above `0.5` can ever admit anything. Recorded for
   * the same reason the two thresholds are: a reader asking "could this run's gate
   * close at all" is answered by this value and by nothing else, and two artifacts
   * that differ only here would otherwise be indistinguishable.
   *
   * `admission.ts` passed `0.5` as a literal until the field was added, so every
   * artifact that predates it carries `0.5` implicitly and a run that raises the
   * ceiling is a different experiment.
   */
  readonly sourceTrust: number;
  /**
   * Turn budget across all presented sessions.
   *
   * `null` rather than `Infinity` when unbounded, because `Infinity` is not
   * representable in JSON: `JSON.stringify` writes it as `null` anyway, so the
   * round-tripped artifact would carry `null` while the in-memory report carried
   * `Infinity`, and a comparison between a live report and a re-read one would
   * disagree. Stating `null` up front makes the persisted form the only form.
   */
  readonly sessionBudget: number | null;
  /**
   * Which per-turn confidence signal admission ran under, or `none`.
   *
   * Recorded because the whole reason the field exists is that §49 separated the
   * two repairs an earlier round had conflated: raising `sourceTrust` makes the
   * retrieval gate *reachable*, and supplying per-turn confidence is what makes it
   * *discriminating*. A reader comparing two artifacts that differ in
   * `retrievalThreshold` needs to know whether either could have discriminated at
   * all, and this string is the only thing in the artifact that says so.
   *
   * `none` is written rather than omitted when no signal ran, for the reason
   * `sourceTrust` is emitted even at its default: omitting a defaulted field makes
   * "this run supplied no variation" and "this artifact predates the field" the
   * same bytes, and those are different claims about the same file. The string is
   * a signal *name* rather than a number because the value it selects is a
   * function, not a knob -- the arming is "variation or not", and the function
   * itself is tested in the product layer.
   */
  readonly confidenceSignal: string;
  /**
   * The prompt contract the run named, i.e. the knob that selects the rendering.
   *
   * Written even when it is the baseline, for the reason every other field here is:
   * omitting a defaulted value makes "this run used the baseline rendering" and "this
   * artifact predates the field" the same bytes, and those are different claims.
   *
   * ## What this field does NOT say, and why `renderingReach` exists
   *
   * This is the **name the run passed**, not the treatment the run administered, and
   * the two were different at `bcf66463`. That artifact recorded
   * `promptContract=abstention-evidence-blocks` while the rendering reached 17 of the
   * 120 questions -- so a reader comparing runs would have attributed a 45→17 drop to
   * a rendering that four of the five capabilities never received. §12.8 made the
   * reachable set a reported property for exactly this reason; the field below is
   * that property, and this one keeps its meaning as the input name.
   *
   * The docstring formerly read "the evidence rendering the abstention route used"
   * and "§12.5's experiment turns on it and nothing else". Both stopped being true
   * when the rendering was separated from the contract name (§12.9): the rendering is
   * no longer abstention-specific, and this field no longer identifies it.
   *
   * A `string` rather than an enum because the arm validates against the product's
   * list at parse time; restating the union here would be a second definition to keep
   * in step, which is the drift the arm's own constants avoid.
   */
  readonly promptContract: string;
  /**
   * The routes the evidence rendering actually reached, measured from their prompts.
   *
   * A run that names a rendering and administers it to nothing is the failure this
   * field is designed to make unreadable-as-success. It is a list of route names
   * rather than a count, because "two routes" does not say whether the two were the
   * ones that carried the loss.
   *
   * Empty when the run named no rendering, which is a real answer: the baseline arm
   * administers nothing by construction and must not be reported as covering routes
   * with the baseline rendering.
   *
   * Optional, and `undefined` is not the same claim as `[]`. Every artifact produced
   * before §12.9 lacks this field, and those artifacts were produced by the code whose
   * reach was wrong -- so a reader comparing against one needs to know the reach is
   * unknown rather than zero. This is the distinction `sourceTrust` and
   * `confidenceSignal` record at length in their own docs.
   */
  readonly renderingRoutes?: readonly string[] | undefined;
  /**
   * The instruction block the run asked with. §13's single variable.
   *
   * Recorded for the same reason `promptContract` is: the two runs §13 compares carry
   * identical gate parameters and differ here, so an artifact without it would make the
   * pair the same bytes.
   */
  readonly ask?: string | undefined;
  /**
   * The routes the ask actually changed, measured from their prompts.
   *
   * This field is not symmetry with `renderingRoutes` -- it is the whole reason §13 can
   * be read at all. MR's own ask IS `extractive`, so dispatching `ask: 'extractive'`
   * leaves MR's prompt byte-identical, and §13's headline prediction is about MR. A run
   * reporting only the ask's name would claim a treatment MR never received, which is
   * the `bcf66463` failure on a new axis.
   *
   * Absent rather than `[]` when the field predates the reader, the same distinction
   * `renderingRoutes` draws and for the same reason.
   */
  readonly askRoutes?: readonly string[] | undefined;
  /**
   * The assembly order §13.279 dispatched, when the run named one.
   *
   * Recorded because the treatment is an **order**, and an order leaves no trace in the prompt's
   * length or its segment set: a run that named the contract but whose builder ignored the option
   * would produce a prompt with the same characters as the control and the same tokens, and every
   * other field of this config would agree too. The name is the only field that can say the run
   * asked, and {@link assemblyRoutes} is the only field that can say the asking arrived.
   */
  readonly promptAssembly?: string | undefined;
  /**
   * The routes whose assembly moved, restated from the product's table.
   *
   * `[]` when the run named no assembly, and absent when the artifact predates the field -- the
   * same distinction `renderingRoutes` draws, for the same reason: `[]` is a claim about a run
   * that administered nothing, and `undefined` is the absence of a claim.
   */
  readonly assemblyRoutes?: readonly string[] | undefined;
  /**
   * Which per-turn relevance signal the prompt budget was spent under.
   *
   * Written even at its default (`none`), for the reason every other field here is:
   * omitting a defaulted value makes "this run spent its budget on arrival order"
   * and "this artifact predates the field" the same bytes, and the two runs this
   * field exists to separate differ in nothing else.
   *
   * ## What it separates, and why a name rather than a number
   *
   * The feature side's prompt carried 4.69% of a 506,338-character mean context
   * (`§13.13`) and the gold turn sat inside what the model read for 11.6% of
   * questions (`§13.16`). A budget is not usefully small or large; it is usefully
   * spent on the right turns, and this field says whether anything ranked them.
   *
   * A `string` rather than an enum for the reason `confidenceSignal` gives: the arm
   * validates it against its own list at parse time, and restating the union here
   * would be a second definition to keep in step.
   */
  readonly relevanceSignal: string;
  /**
   * How many turns per question the relevance index scored.
   *
   * Recorded beside the signal because it is the same claim's second half: a
   * `retrieval` signal built at a width of `8` ranks almost nothing, and an artifact
   * naming the signal without the width would make that run and one built at `64`
   * look like the same experiment.
   *
   * The width is what bounds the scored set, and the prompt budget holds roughly 167
   * turns at 24,000 characters -- so at the default `64` every scored turn survives
   * selection and the width does not interact with the budget at all. Stating it
   * makes that argument checkable against the artifact rather than against the
   * source.
   */
  readonly relevanceTopK: number;
  /**
   * The unit the relevance budget was spent in: `turn` or `session`.
   *
   * ## Why the artifact carries both the signal and the unit
   *
   * A run's budget is described by two independent claims -- how a turn was **scored** and
   * what a score **bought** -- and §13.27 moves only the second while §13.17 moved only the
   * first. A single field would make the two experiments publish the same configuration
   * line, and §13.26's artifact is the thing §13.27's is compared against, so the field
   * being present is what makes the comparison a comparison of one variable.
   *
   * Optional, and absent reads as `turn`. Every artifact written since §13.27 carries it,
   * so an artifact without it predates the field rather than having run under some
   * unrecorded unit -- the convention `embedding` is written under one field down.
   * Requiring it would force every fixture that builds a `MemoryArmConfig` by hand to
   * invent a value, and the value they would write is the default: the field's purpose is
   * to tell two dispatches apart, and both of those go through `toMemoryArmConfig`.
   */
  readonly relevanceUnits?: string;
  /**
   * The parameters anchor restoration ran with, when `relevanceSignal` named it.
   *
   * ## Why the config line needs three numbers for one mechanism
   *
   * The signal names a family. §13.256 dispatched its first point -- decay `0.5`, radius `3`,
   * four anchors -- and the pool it widened was ordered well enough to deliver 21 more gold turns
   * while losing eight MR questions, because a restored turn carried half its anchor's score and
   * therefore outranked hits the retriever had placed far below that anchor (§13.257). The repair
   * steepens the decay, and the artifact of the repairing run differs from the artifact of the run
   * it repairs in **no other field**: same signal, same width, same unit, same reader, same prompt.
   * A reader comparing the two would otherwise be comparing two artifacts that look identical.
   *
   * Resolved rather than configured, because the options carry what a dispatch asked for while the
   * artifact has to carry what ran: an omitted `decay` and a `decay` equal to the registered value
   * are the same pool and must not be two different records.
   *
   * Absent for every other signal. That absence is not ambiguous, because `relevanceSignal` is
   * always present: the mechanism's name beside an absent field is an artifact written before the
   * field existed, and any other name is a run that restored nothing.
   */
  readonly anchors?: { readonly count: number; readonly radius: number; readonly decay: number };
  /**
   * What the product's own retrieval cost the run, when `relevanceSignal` was `self-index`.
   *
   * ## Why a cost record sits beside the ranking fields
   *
   * Every signal before this one ranked turns with an index **this package** built, and its cost was the
   * arm's ordinary embedding bill -- visible in `C1` and in the usage ledger. `self-index` moves the index
   * inside the product, where the corpus arrives per question (`answerSessions(question, sessions)`), and
   * that shape means the index is rebuilt for every question. Whether that is affordable is not a detail
   * of the implementation: it is the difference between a retrieval stack a deployment can run and one it
   * cannot, and it is invisible in accuracy, in `C1` (which counts the *reader's* prompt tokens) and in
   * every other field on this page.
   *
   * ## Why `embedTexts` and `memoHits` are both here
   *
   * `embedTexts` is the bill; `memoHits` is the part of it a store absorbed. A run on a corpus that repeats
   * and a run on a per-question haystack have the same *configuration* and a hundredfold difference in
   * `embedTexts`, and printing only the total would make the second look like a regression in the first's
   * units. `reuse` is the third: `false` means at least one index ran without a store, which makes the
   * total incomparable with a run that had one throughout.
   *
   * `rerankCalls` beside `rerankDegraded` is the pair `SearchCensus` already established: an endpoint that
   * failed five hundred times and a cross-encoder that agreed every time produce one accuracy.
   *
   * Absent means the product did not build an index -- either the signal was not `self-index`, or the run
   * predates the field. Both are facts a reader should be able to tell from the signal's own value.
   */
  readonly selfIndex?:
    | {
        readonly indexes: number;
        readonly turns: number;
        readonly embedCalls: number;
        readonly embedTexts: number;
        readonly memoHits: number;
        readonly reuse: boolean;
        readonly rerankCalls: number;
        readonly rerankDegraded: number;
      }
    | undefined;
  /**
   * What the product's write gate computed for every turn it was shown, and what it did.
   *
   * ## The defect this closes, and why the field is counts rather than a verdict
   *
   * `threshold`, `retrievalThreshold`, `sourceTrust` and `confidenceSignal` are all recorded
   * on this object, so an artifact could always say what the gate was **configured** with.
   * Run `37110579101` is the recorded case of that being useless: `retrievalThreshold: 0`
   * could not close a gate whose maximum observable value was `0.5`, so the repaired program
   * scored what the unrepaired one did, and the artifact described a mechanism that had not
   * been reached. In the registered configuration both gates are `0`, which makes
   * `value >= threshold` true for every turn — a **pass-through**, by arithmetic rather than
   * by observation.
   *
   * `rejected` is the field that turns that into an observation. It is the count of candidate
   * turns whose value fell below the threshold, so `rejected: 0` on a run whose configuration
   * is a pass-through is the artifact saying "this gate did not decide anything", and a
   * reader no longer has to infer it from two zeros in the configuration block.
   *
   * ## Why the counts are over candidates and not over admitted turns
   *
   * Because a census of admitted turns reports `rejected: 0` for every configuration that has
   * ever run: the admission test is `value >= threshold`, so every admitted turn is above the
   * cut by construction. The first draft of this instrument had exactly that shape and was
   * arithmetically incapable of answering its own question. `cortex-memory`'s
   * `admission-census.test.ts` records the correction.
   *
   * ## Why `distinct` is a floor and says so
   *
   * Each instance caps its distinct-value set at 64, and the roll-up across a pool reports the
   * maximum of the parts. Both are floors. `distinctSaturated` distinguishes "64 distinct
   * values" from "at least 64", and the criterion this field serves — `distinct >= 2` — is
   * decided well below the cap, so the floor is enough to answer it.
   *
   * Absent means the run admitted nothing at all (no candidate reached any instance), which is
   * a different statement from a gate that refused everything — the latter has
   * `candidates > 0` and `admitted: 0`.
   */
  readonly admission?:
    | {
        readonly threshold: number;
        readonly candidates: number;
        readonly admitted: number;
        readonly rejected: number;
        readonly min: number;
        readonly max: number;
        readonly mean: number;
        readonly distinct: number;
        readonly distinctSaturated: boolean;
      }
    | undefined;
  /**
   * Which embedding backend this artifact's numbers were produced against.
   *
   * ## Why the artifact has to say it
   *
   * `createEmbeddingWithProvenanceFromEnv` falls back to a **256-dimension hash
   * embedding** when no credential is present, so a run graded against the fallback and a
   * run graded against Zhipu `embedding-3` at `1024` dimensions both produce a complete,
   * internally consistent report. `embedding.test.ts` makes that explicit: both are
   * deterministic and they differ by a factor of four in dimension, so two artifacts that
   * agree on a determinism score are not therefore comparable.
   *
   * Until this field the only statement of which backend was used was a line on the
   * runner's **stdout**, which is not in the artifact: an archived report could not be
   * read for the question a comparison depends on. This was pending as roadmap item 17.
   *
   * ## Why it carries the check as well as the backend
   *
   * A backend name says what produced the vectors and not whether the provider was
   * serving when the run started. Run `38566578567` died **before grading a question**
   * because the provider had no credit, and the only trace was a log line; a report that
   * named the backend alone would be consistent with exactly that run had it happened to
   * finish. `preflight: 'ok'` says the run asked first and was answered, and `'not-run'`
   * says nothing was asked -- which is the honest value for every artifact that predates
   * the check and for any caller that constructs a config without one.
   *
   * Absent when the caller names no backend at all, which keeps an artifact that predates
   * this field distinguishable from one whose backend is unrecorded.
   */
  readonly embedding?:
    | {
        readonly provider: string;
        readonly model: string | null;
        readonly dimensions: number;
        readonly preflight: 'ok' | 'not-run';
      }
    | undefined;
  /**
   * Which reader answered, recorded where a reader of the artifact looks.
   *
   * ## Why this is a field and not a log line
   *
   * `PREREGISTRATION` §13.109 fixed three conditions for the reader axis before its first
   * run existed, and the first of them was "a pinned model identity in the artifact". The
   * run happened (`40698883428`) and the condition was **not** met: the model id existed
   * only in the job log's `DEEPSEEK_MODEL:` line, and two artifacts that differ by seven
   * points carried identical `memoryArmConfig` blocks. §13.110 records that as debt rather
   * than arguing it away; this field pays it.
   *
   * ## Why `temperature` is `number | null` and not a number
   *
   * Because the arm has never sent one. `TEMPERATURE` is declared by the workflow and
   * forwarded into `env`, and **nothing on this arm's path reads it**: `createLlmFromEnv`
   * ignores it and `#consult` calls `complete(prompt)` with no options, so the request body
   * carries no `temperature` field and the provider's own default applies. `null` is that
   * sentence in one value -- "the request carried none" -- and it is deliberately distinct
   * from `0`, which is what the workflow input claims. §13.114 registers the defect; this
   * field is how a future run can prove it was fixed.
   */
  readonly reader?:
    | {
        /**
         * The backend the run **declared**, never a guess about it.
         *
         * §13.212: this was `provider: string` and held the host-derived family -- `'deepseek'`
         * for one domain and `'openai-compatible'` for every other. That field was a vendor for
         * one provider and a protocol for the rest, so two runs could not be compared on it and a
         * second vendor could only be reached by substituting a credential into a variable named
         * after the first. The declared name is a fact a dispatch can set and an artifact can be
         * held to.
         */
        readonly providerId: ReaderProviderId;
        readonly model: string;
        readonly baseUrl: string;
        /**
         * Whether the endpoint is the one `providerId` implies.
         *
         * `'overridden'` is rendered as an `endpoint=` clause, because the declaration and the
         * reach are two facts and a reader line that showed only the declaration would attribute
         * a proxy's numbers to the named vendor. `'none'` (a `custom` provider) makes no claim, so
         * there is nothing to render -- an unconditional clause would warn on every correct custom
         * run.
         */
        readonly endpoint: EndpointCheck;
        readonly thinking: 'enabled' | 'disabled';
        /**
         * The routes `thinking` applies to, or absent when it applies to every route.
         *
         * §13.197.4: the value can name a reach (`multi-session+temporal`), and a reader line that
         * said only `thinking=enabled` would describe a configuration the run did not administer --
         * half of the run was answered with thinking off. The line therefore reads
         * `thinking=enabled on multi-session+temporal`. Absent stays absent rather than becoming an
         * empty list, so every archived artifact renders the bytes it always rendered.
         */
        readonly thinkingRoutes?: readonly string[] | undefined;
        readonly temperature: number | null;
        /**
         * The per-attempt deadline the run declared, or absent when it took the implied one.
         *
         * §13.306. `42381840503` answered 291 of 500 and died with
         * `attemptsMs=[299999,300001], timeoutMs=300000` -- two attempts, both reaching a bound that
         * lived in a module constant. A reader of that artifact could learn the deadline only from
         * the failure object inside the error, which is the §13.110 shape on a different field: the
         * fact existed and the artifact did not state it.
         *
         * Absent rather than a default, because the deadline a run did not declare is a different
         * claim from one it declared at the value the code would have chosen, and every archived
         * artifact must keep rendering the bytes it rendered.
         */
        readonly deadlineMs?: number | undefined;
      }
    | undefined;
  /**
   * The judge that scored this run, and whether a dispatch pinned it.
   *
   * §13.312. `reader` names the model that **answered**; this names the model that **graded**, and
   * until this field existed the artifact could not tell them apart because they were always the
   * same object. That identity is right for one arm over time and wrong for two arms at one time: on
   * the `M1` pair the judge was `deepseek-v4-pro` for one arm and `deepseek-flash` for the other, and
   * on the 29 preference questions -- whose golds are criteria, so the verdict is entirely the
   * judge's opinion -- one judge rejected 10 answers the other accepted. The 34.5-point capability
   * gap that produced was an instrument swap, and no field in either artifact said so.
   *
   * `source` is the load-bearing half. `'reader'` is the state of every run before this field and
   * means "nobody chose a judge, it followed the arm"; `'pinned'` means `CORTEX_JUDGE_MODEL` named
   * one independent of the arm. A comparison across two artifacts is a comparison only when both say
   * `pinned` with the same model, and that is checkable from the two files alone.
   *
   * Absent rather than defaulted, for the reason every other block here is: an artifact written
   * before §13.312 must read as predating the field rather than as having followed its reader by
   * choice.
   */
  readonly judge?:
    | {
        readonly providerId: ReaderProviderId;
        readonly model: string;
        readonly temperature: number | null;
        readonly source: 'reader' | 'pinned';
      }
    | undefined;
  /**
   * The reranking stage this run carried, and what it did.
   *
   * ## Why the toggle is recorded even for the control
   *
   * `provider: 'none'` is a state a dispatch can name, so an artifact that spelled nothing would
   * leave "ran the control" and "predates the field" as the same bytes — the rule `reviewPass`
   * follows, and the reason §13.107 was unreadable for a whole round.
   *
   * ## Why the census is inside the same record rather than beside it
   *
   * The identity answers *which* scorer ran; the census answers *whether it ran*. Splitting them
   * would allow an artifact to name a model it never consulted, which is precisely the failure the
   * counters exist to expose: `cortex-core`'s `rerankHits` degrades to the retrieved order on a
   * thrown request, a short reply or a non-finite score, so an arm whose endpoint answered `401` five
   * hundred times produces the same accuracy as one whose cross-encoder agreed with the retriever
   * every time. §13.115 registers `fallbacks > 0` as an **assembly failure**, not a null result.
   *
   * `census` is absent when the caller could not measure it — a replayed artifact, or an index built
   * before the counter existed — and never zeroed, because `fallbacks: 0` is the single most
   * reassuring number in the record and must not be fabricated.
   */
  readonly rerank?:
    | {
        readonly provider: 'none' | 'openai-compatible' | 'llm' | 'local';
        readonly model?: string | undefined;
        readonly host?: string | null | undefined;
        /**
         * The endpoint's declared wire limits, when the deployment named any.
         *
         * Recorded because they change what the counters mean: a `clipped` count is only interpretable
         * beside the limit that produced it, and a `fallbacks: 0` on a run that declared 128 documents
         * says something different from one that declared nothing and happened to fit.
         */
        readonly bounds?: RerankBounds | undefined;
        readonly census?: RerankCensus | undefined;
      }
    | undefined;
};

/**
 * One field of the configuration line, for the reader that answered.
 *
 * Slash-separated rather than comma-separated because the line already uses commas between
 * fields, so a comma inside a value would make one field read as three -- the same reason
 * `maxTurnCharsRoutes` joins with `+`.
 *
 * The host, not the full URL: the scheme and the version segment are the same for every
 * provider this project has run and the host is the part that says **which service** answered.
 * A URL with a query string would put a credential in an artifact if one ever arrived that way,
 * which is why this reads `URL.host` and never echoes the string it was given.
 *
 * ## Why the provider is the declared name
 *
 * §13.212 replaced the host-derived family with the name the dispatch declared. For every
 * archived run the two agree -- the default provider is `deepseek` and every archived dispatch
 * named a `deepseek.com` endpoint -- so the bytes do not move. They stop agreeing in the two
 * cases that matter: a second vendor (`zhipu:glm-4.6`), where the old field said
 * `openai-compatible` and named nothing; and an endpoint override, which is where the `endpoint=`
 * clause appears. That clause is the reason the host is still printed: the declaration says what
 * was selected, the host says what was reached, and the clause says they differ.
 */
function renderReader(reader: {
  readonly providerId: ReaderProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly endpoint: EndpointCheck;
  readonly thinking: 'enabled' | 'disabled';
  readonly thinkingRoutes?: readonly string[] | undefined;
  readonly temperature: number | null;
  readonly deadlineMs?: number | undefined;
}): string {
  // `new URL` throws on a malformed string, and a rendered report is not the place to throw:
  // the identity is still worth stating without its host, and a crash here would destroy the
  // whole artifact over a field that exists to describe one.
  let host = 'unknown';
  try {
    host = new URL(reader.baseUrl).host;
  } catch {
    host = reader.baseUrl.replace(/^https?:\/\//, '').split('/')[0] ?? 'unknown';
  }
  return (
    `reader=${reader.providerId}:${reader.model}@${host}` +
    `${reader.endpoint === 'overridden' ? '/endpoint=override' : ''}` +
    `${renderThinking(reader)}` +
    `/temp=${reader.temperature === null ? 'default' : String(reader.temperature)}` +
    // §13.306. Printed only when the run declared one, so every archived line keeps its bytes and
    // a missing clause is the honest statement that the deadline was whatever the code implied.
    `${reader.deadlineMs === undefined ? '' : `/deadline=${reader.deadlineMs}`}`
  );
}

/**
 * The thinking field of the reader line, with its reach when it has one.
 *
 * `/thinking=enabled` is what every archived artifact carries and stays byte-identical. A
 * route-scoped run renders `/thinking=enabled on multi-session+temporal`, because the two claims are
 * different: the first says thinking was on for the whole run, the second says it was on for two of
 * six routes and off for four. An artifact that spelled only `enabled` would be describing a
 * configuration the run did not administer -- and §13.197 is precisely the measurement of what the
 * four unnamed routes cost when they carry it.
 */
function renderThinking(reader: {
  readonly thinking: 'enabled' | 'disabled';
  readonly thinkingRoutes?: readonly string[] | undefined;
}): string {
  const routes = reader.thinkingRoutes;
  // Absent and empty both render as the plain mode. The empty list is not a state the parser can
  // produce (a value that names no routes IS the plain mode), so this branch exists only so a
  // replayed artifact with `[]` cannot print a trailing `on ` with nothing after it.
  if (routes === undefined || routes.length === 0) return `/thinking=${reader.thinking}`;
  return `/thinking=${reader.thinking} on ${routes.join('+')}`;
}

/**
 * One field of the configuration line, for the reranking stage.
 *
 * `none` is spelled rather than omitted, for the reason `reviewPass` is: a run that dispatched the
 * control and an artifact that predates the field must not read the same. `local` carries no host
 * because a cross-encoder in the process talks to no service, and writing `@null` would look like a
 * missing value rather than like the truth.
 */
function renderRerank(rerank: {
  readonly provider: 'none' | 'openai-compatible' | 'llm' | 'local';
  readonly model?: string | undefined;
  readonly host?: string | null | undefined;
  readonly bounds?:
    { readonly maxDocuments: number | null; readonly maxDocumentChars: number | null } | undefined;
}): string {
  if (rerank.provider === 'none') {
    return 'rerank=none';
  }
  const model = rerank.model ?? 'n/a';
  const endpoint =
    rerank.host === null || rerank.host === undefined
      ? `rerank=${rerank.provider}:${model}`
      : `rerank=${rerank.provider}:${model}@${rerank.host}`;
  // The wire limits are part of the identity of the *treatment*: a stage clipped at 4,096 characters
  // and one that was never clipped are different experiments, and `fallbacks` reads the same on both.
  const bounds = rerank.bounds;
  if (bounds === undefined || (bounds.maxDocuments === null && bounds.maxDocumentChars === null)) {
    return endpoint;
  }
  const docs = bounds.maxDocuments === null ? '-' : String(bounds.maxDocuments);
  const chars = bounds.maxDocumentChars === null ? '-' : String(bounds.maxDocumentChars);
  return `${endpoint}/max=${docs}turns,${chars}chars`;
}

/**
 * Distinct questions on which each arm's retry actually re-queried.
 *
 * Declared here rather than imported from `runner.ts` so the report type does not
 * depend on the module that produces it -- `runner.ts` already imports from this
 * one, and closing the cycle would make the type unavailable while `report.ts` is
 * still initialising.
 */
export type RetryFireCounts = {
  controlFires: number;
  treatmentFires: number;
  questions: number;
};

/**
 * Why each abstention happened, as counted by the system under test.
 *
 * The four keys are mutually exclusive and cover every question the abstention
 * path is asked exactly once, so their sum is the denominator of every share
 * rendered below. Declared here rather than imported from `bench-memory-arm.ts`
 * for the same reason as `RetryFireCounts`: the arm imports from this module, and
 * closing the cycle would make the type unavailable during initialisation.
 *
 * `empty` and `threshold` are **machine-derived** and consume no request;
 * `llm` and `answered` are the model's two outcomes. The split matters because
 * only `threshold` is a statement about the gate -- reading `llm` as though the
 * gate produced it is the error §10.10 had to retract.
 */
/**
 * The recovery pass's own tally.
 *
 * `attempted` counts corrective consultations and `answered` counts the ones that came back with an
 * answer. A run reporting `attempted: 0` carries the pass and never fired it, which is a different
 * fact from one that fired and converted nothing.
 */
export type RecoveryCensus = {
  readonly attempted: number;
  readonly answered: number;
};

/**
 * The bare-decline retry's own tally.
 *
 * Same shape as {@link RecoveryCensus} and deliberately a separate type: two structurally identical records whose
 * numbers count different events should not be interchangeable in a signature, because the compiler would then
 * accept a call site that passed one where the other belongs. `attempted` counts questions re-asked without the
 * abstention token offered; `answered` counts the ones that came back with something other than the token.
 */
export type BareRetryCensus = {
  readonly attempted: number;
  readonly answered: number;
};

/**
 * The reply-contract repair's tally, split by the kind of violation that earned it.
 *
 * ## Why the kinds are carried rather than summed away
 *
 * The two repairs are different sentences on disjoint populations (§13.334): `commitment` re-asks a refusal written
 * in prose, `shape` re-asks a list of quotations for an answer line. A run reporting `attempted: 9, answered: 3`
 * has said nothing about which treatment earned the three, and the fourteen questions this pass was registered
 * against split 8 / 6 between them -- so the totals are derived from these two and not the other way round.
 *
 * ## Why `attempted` is not a rate
 *
 * `answered` counts consultations that returned something other than a decline, which is what "the repair
 * produced a reply" means. Whether that reply was **right** needs the gold, which lives in the roster beside this
 * tally and not in it -- the same split `AuditCensus.changed` states for the audit.
 *
 * ## Why each kind also carries its questions
 *
 * `E3.2` is a criterion about a **set**: the 494 to 497 non-targets must reproduce their correctness mask, so the
 * 3 to 6 targets have to be nameable. Two integers cannot name them, and run `42791109966` is what that costs --
 * the room finally matched the control, the pair was finally single-variable, and the criterion stayed unscorable
 * because the artifact could say `attempted: 6` and not which six. The strings are the questions themselves rather
 * than indices because an index is a position in a roster the census does not have, and the question text is
 * already in `questions[].question` for every one of them.
 */
export type ReplyRepairCensus = {
  readonly attempted: number;
  readonly answered: number;
  readonly commitment: {
    readonly attempted: number;
    readonly answered: number;
    readonly questions: readonly string[];
  };
  /**
   * The evidence-echo repair (`MEASURE-COMPETITOR-PAIRING.md` section 4): replies that wrote the evidence block
   * back instead of answering, 16 of 500 on `42533236864` of which 9 were wrong. Its own field rather than a
   * wider `commitment`, because the two were dispatched separately and one number cannot describe two
   * populations.
   */
  readonly echo: {
    readonly attempted: number;
    readonly answered: number;
    readonly questions: readonly string[];
  };
  readonly shape: {
    readonly attempted: number;
    readonly answered: number;
    readonly questions: readonly string[];
  };
};

/**
 * The membership audit's own tally.
 *
 * A third type rather than a reuse of {@link RecoveryCensus}, and the second field is why: this pass is handed an
 * answer that already exists, so "came back with an answer" is true of every consultation it makes. What a reader
 * needs is `changed` -- the consultations whose answer differed from the one they were given. A run reporting
 * `attempted: 486, changed: 0` has measured a review that read every answer and agreed with all of them, which is
 * a result; the same run without the field would read as a mechanism whose effect nobody counted.
 */
export type AuditCensus = {
  readonly attempted: number;
  readonly changed: number;
  /**
   * Ledgers the second pass could not read, present only under `reviewPass: tally`.
   *
   * Optional rather than defaulted to zero, because the audit pass has no such state: a run that prints
   * `refused: 0` under `audit` would be stating a measurement of a branch it cannot enter, which is the
   * defect this file's `recovery` census was introduced to remove in the other direction.
   */
  readonly refused?: number;
  /**
   * The `spec` pass's authorization arithmetic, present only under `reviewPass: 'spec'`.
   *
   * §13.365 registers a veto — substitute the plan's value only if the first answer's own token is among the
   * rows the plan selected — and these are the four numbers plus two denominators that decide it. They are
   * recorded on the run **before** the one that depends on them, because a relation nobody persisted cannot be
   * measured afterwards: `support` was computed on every call in the `spec` pass and dropped, which is the
   * defect that made this field exist.
   *
   * `evaluated` counts substitutions the pass offered, so a refused plan is outside this population and
   * `evaluated + refused = attempted` stays true. `ledgerRows` and `tokens` are the denominators — a hit rate
   * over two rows and a hit rate over two hundred are different readings, and `tokens: 0` is the case where the
   * veto could not run at all.
   */
  readonly authorization?: {
    readonly evaluated: number;
    readonly authorized: number;
    readonly selected: number;
    readonly supportHits: number;
    readonly ledgerRows: number;
    readonly tokens: number;
  };
};

export type AbstentionReasons = {
  /** The write gate admitted nothing, so there was no evidence to decline from. */
  empty: number;
  /** The retrieval gate computed `retrieve: false`. */
  threshold: number;
  /** The model was consulted and declined. */
  llm: number;
  /** The model was consulted and answered. */
  answered: number;
};

export type AblationReportOptions = {
  runs?: number;
  alpha?: number;
  abstentionAware?: boolean;
  generatedAt?: string;
  /**
   * The content identity of the dataset file, when the caller read one.
   *
   * Passed in rather than computed here because this module never sees a path: the
   * dataset arrives already parsed, and by then the bytes are gone. The entry point
   * that reads the file is the only place that can take the digest, so it takes it
   * and this function carries it into the report
   * (`AblationReport.datasetFingerprint` says why it is in the report at all).
   */
  datasetFingerprint?: string;
  /**
   * Workers in flight, forwarded to the ablation. See `AblationOptions.pool`.
   *
   * Absent means one worker, so every caller that does not name it keeps the serial pass
   * its artifacts were produced by.
   */
  pool?: AblationPool | undefined;
  /**
   * What the entry point read about the reader's transport, recorded rather than re-derived.
   *
   * Passed by the entry point instead of read here for the reason every option in this type is
   * passed: this module never sees a `process.env`, and a second parse of the same variables is a
   * second answer to "what pace did this run run at".
   */
  readerPacing?: ReaderPacing | undefined;
  scorer?: AnswerScorer;
  featureConfig?: FeatureConfig;
  /**
   * Per-question records for the graded set, in dataset order.
   *
   * Passed in rather than built here because building them needs the retrieval
   * context the systems saw and the scorer's per-question verdicts, and this
   * module's only view of a run is the aggregate `AblationResult`. The runner
   * holds both, so it assembles the records and this function carries them.
   */
  questions?: readonly QuestionRecord[];
  /** The `cortex-memory` arm's gate configuration, when it produced this report. */
  memoryArmConfig?: MemoryArmConfig;
  /**
   * Optional per-question progress sink, forwarded to the ablation.
   *
   * Carried here rather than written into the returned report on purpose: the
   * report is serialized to JSON, a function does not survive that, and
   * `report-json-roundtrip.test.ts` asserts the round-trip. So the callback is an
   * input and only an input -- `ablation-progress.test.ts` pins that it is absent
   * from the output.
   */
  onProgress?: BenchmarkProgressCallback;
  /** Wall-clock ceiling for each pass. See `AblationOptions.budgetMs`. */
  budgetMs?: number | undefined;
};

export async function runAblationReport(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
  options: AblationReportOptions = {},
): Promise<AblationReport> {
  const scorer = options.scorer ?? exactMatchScorer;
  const ablationOptions: AblationOptions = { scorer };
  if (options.runs !== undefined) {
    ablationOptions.runs = options.runs;
  }
  if (options.alpha !== undefined) {
    ablationOptions.alpha = options.alpha;
  }
  if (options.budgetMs !== undefined) {
    ablationOptions.budgetMs = options.budgetMs;
  }
  if (options.pool !== undefined) {
    ablationOptions.pool = options.pool;
  }
  if (options.abstentionAware !== undefined) {
    ablationOptions.abstentionAware = options.abstentionAware;
  }
  // Conditional assignment, not a pass-through, for two reasons that both bite:
  // `exactOptionalPropertyTypes` rejects an explicit `undefined` here, and the
  // absent path is the one every pre-existing caller takes.
  if (options.onProgress !== undefined) {
    ablationOptions.onProgress = options.onProgress;
  }
  // The ablation already evaluates both systems once; reuse those metrics so the
  // report never re-evaluates them (which would double LLM cost and introduce
  // non-determinism between the ablation table and the per-capability section).
  const ablation = await runAblation(dataset, baseline, feature, ablationOptions);
  return {
    dataset: dataset.name,
    questionCount: dataset.questions.length,
    baseline: { name: baseline.name, metrics: ablation.baselineMetrics },
    feature: { name: feature.name, metrics: ablation.featureMetrics },
    ablation,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    ...(options.datasetFingerprint === undefined
      ? {}
      : { datasetFingerprint: options.datasetFingerprint }),
    ...(options.featureConfig === undefined ? {} : { featureConfig: options.featureConfig }),
    ...(options.questions === undefined ? {} : { questions: options.questions }),
    ...(options.memoryArmConfig === undefined ? {} : { memoryArmConfig: options.memoryArmConfig }),
    ...(options.runs === undefined ? {} : { runs: options.runs }),
    // The width comes from the pool rather than from a second option: the pool IS the concurrency,
    // and a caller that named one and not the other would leave the block describing a run that
    // did not happen.
    ...(options.readerPacing === undefined
      ? {}
      : {
          passShape: passShapeReport({
            workers: options.pool?.workers ?? 1,
            pacing: options.readerPacing,
          }),
        }),
  };
}

/**
 * `0.9195` → `91.95%`.
 *
 * Lifted out of `formatAblationReport` by §13.308 so the two renderers that are not that
 * function's body — the spread row and the cost-per-correct-answer line — format a fraction the
 * same way it does. Two decimals because a denominator a reader cannot recompute is a number a
 * reader has to trust, and the whole point of carrying the denominator in the artifact is that
 * nobody has to.
 */
function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

export function formatAblationReport(report: AblationReport): string {
  const ab = report.ablation;
  const lines: string[] = [
    // The arm goes in the title because two workflows write this document for two
    // different systems, and a bare "Cortex Benchmark Report" made them the same
    // document to anyone reading a table of contents. Run `40088479628` measures both
    // in one run -- `reference-pipeline` 43.40%, `cortex-memory` 80.80% -- which is
    // exactly the pair a headline without an arm name invites a reader to compare.
    `# Cortex Benchmark Report — \`${report.feature.name}\``,
    '',
    `- Dataset: \`${report.dataset}\` (${report.questionCount} questions)`,
    // Immediately under the name, because the name is the half that does not move and
    // the digest is the half that can. Conditional: a dataset constructed in code has
    // no file, and printing an empty fingerprint for it would be a claim.
    ...(report.datasetFingerprint === undefined
      ? []
      : [`- Dataset file: \`${report.datasetFingerprint}\``]),
    // Both arms, on one line, above every number in the document. The line is what
    // makes a screenshot of this report self-describing, which the per-section labels
    // below are too far down the page to do.
    `- System under test: \`${report.feature.name}\` vs baseline \`${report.baseline.name}\``,
    `- Generated at: ${report.generatedAt}`,
    `- Feature: \`${report.feature.name}\` vs baseline \`${report.baseline.name}\``,
  ];

  // The configuration goes above the results, with the cohort banner and for the
  // same reason: it is what the numbers below are conditioned on. Rendered as a
  // single line so a reader comparing two arms can diff it visually, and written
  // sorted so the two arms' lines differ only where the switch does.
  const config = report.featureConfig;
  if (config !== undefined) {
    const entries = Object.entries(config).sort(([a], [b]) => (a < b ? -1 : 1));
    if (entries.length > 0) {
      lines.push(
        `- Feature config: ${entries.map(([k, v]) => `\`${k}=${v ? 'on' : 'off'}\``).join(', ')}`,
      );
    }
  }

  // The cross-system arm's numeric configuration. Rendered next to the boolean
  // switches and for the same reason, but separately because it carries values
  // rather than flags: `threshold=0.35` is not expressible as `on`/`off`, and the
  // reader's question -- "how much evidence did the gate demand before admitting a
  // turn" -- is answered by the number and by nothing else. An arm whose artifact
  // omits it produces a delta that cannot be compared against another arm's.
  //
  // BOTH thresholds are rendered, on separate lines, because they answer two
  // different reader questions and the run that motivated this field is the proof
  // that one line is not enough. `threshold=0` alone is the identity configuration
  // as far as a reader can tell, and run `37094200823` used exactly that line to
  // describe a run whose abstention path did not exist. With both lines the third
  // state is expressible: `retrievalThreshold` present and nonzero says the gate
  // was armed, and its absence from an artifact says only that the artifact
  // predates the field -- a distinction the single-line form could not draw at all.
  const memoryArm = report.memoryArmConfig;
  if (memoryArm !== undefined) {
    // Its own line rather than a clause on the config line below, and above it rather than
    // after: it is the only value here that changes what the NUMBER means rather than what
    // the run did. Under `gold-sessions` the accuracy is a reader ceiling and the delta is
    // the cognitive layer's contribution at perfect evidence. A reader who scanned the
    // config line and missed this one would compare the two artifact kinds as if they were
    // the same measurement.
    if (memoryArm.evidenceSource !== undefined) {
      lines.push(
        `- Evidence source: \`${memoryArm.evidenceSource}\`` +
          (memoryArm.evidenceSource === 'gold-sessions'
            ? ' -- each question is graded against its gold sessions, so the accuracy below' +
              ' is a reader ceiling rather than a system score'
            : ''),
      );
    }
    lines.push(
      `- Memory arm config: \`threshold=${memoryArm.threshold}\`` +
        `, \`retrievalThreshold=${memoryArm.retrievalThreshold}\`` +
        `, \`sessionBudget=${memoryArm.sessionBudget === null ? 'unbounded' : memoryArm.sessionBudget}\`` +
        // Rendered even at its default. The reader's question is "was the value
        // ceiling raised this run", and omitting the default would make "left
        // alone" and "predates the field" look the same -- the distinction the two
        // thresholds above already had to be taught to draw.
        `, \`sourceTrust=${memoryArm.sourceTrust}\`` +
        // Rendered on the same line and with the same "always present" rule. This
        // one answers the question the two above cannot: whether the gate had any
        // per-turn variation to threshold. §49's finding is that a raised ceiling
        // puts `retrievalThreshold` in a set rather than a point and still leaves
        // every cut all-or-nothing, so a reader holding only the numbers would
        // read a `retrievalThreshold` of `0.25` as a working cut when it may have
        // had nothing to cut. `none` is the honest value and is written.
        `, \`confidenceSignal=${memoryArm.confidenceSignal}\`` +
        // §12.5's single variable, rendered with the same always-present rule. It is
        // the field that makes the experiment readable at all: the two runs this arm
        // compares carry IDENTICAL `threshold`, `retrievalThreshold`, `sourceTrust` and
        // `confidenceSignal`, so without this line their artifacts would be the same
        // bytes and a reader would have no way to see which prompt produced which score.
        `, \`promptContract=${memoryArm.promptContract}\`` +
        // The budget's signal, on the same line and with the same always-present
        // rule, because the run this field exists to make readable is one whose every
        // other number on this line is identical to the run before it. `relevanceTopK`
        // is appended only when a signal ran: the width is a property of the index, and
        // the index does not exist without the signal -- rendering `64` beside
        // `relevanceSignal=none` would describe a ranking the run never built.
        `, \`relevanceSignal=${memoryArm.relevanceSignal}\`` +
        (memoryArm.relevanceSignal === 'none'
          ? ''
          : `, \`relevanceTopK=${memoryArm.relevanceTopK}\``) +
        // The cap, and unlike the width and the unit it is rendered on EVERY run, including
        // the ones with no ranking: it is a property of the evidence section rather than of
        // an ordering, so `none` is a fact about the prompt rather than the absence of one.
        // Omitted entirely by an artifact that predates the field, which is why the value is
        // spelled "none" here and the field is absent there.
        `, \`maxTurnChars=${memoryArm.maxTurnChars ?? 'none'}\`` +
        // `default` rather than `none`: there is always a budget, and the absent state means the
        // product default. The rendered room itself comes from `effectivePromptChars` below, so the
        // line never asks a reader to know what the default was on the day of the run.
        `, \`maxPromptChars=${memoryArm.maxPromptChars ?? 'default'}\`` +
        // §13.299, beside the two fields it resolves: the room every route actually assembled under.
        // Collapsed to one number when all six agree -- which is every run that never redistributed
        // -- because six copies of the same value is a line a reader stops reading.
        (memoryArm.effectivePromptChars === undefined
          ? ''
          : `, \`room=${
              new Set(Object.values(memoryArm.effectivePromptChars)).size === 1
                ? String(Object.values(memoryArm.effectivePromptChars)[0])
                : Object.entries(memoryArm.effectivePromptChars)
                    .map(([route, width]) => `${route}:${width}`)
                    .join('+')
            }\``) +
        // §13.239, rendered only when a redistribution was dispatched: the absent state is one room
        // for every route, which is what every archived artifact used, so spelling it on every line
        // would make the 30 artifacts that predate the field indistinguishable from the ones that
        // declined it. `+` rather than a comma for the reason the reach uses it -- the line already
        // separates fields with commas.
        (memoryArm.maxPromptCharsByRoute === undefined
          ? ''
          : `, \`maxPromptCharsByRoute=${Object.entries(memoryArm.maxPromptCharsByRoute)
              .map(([route, width]) => `${route}:${width}`)
              .join('+')}\``) +
        // §14.126, rendered only when a plan was dispatched, for the reason the redistribution above is:
        // the absent state is the route's room, which every archived artifact used, and spelling it on
        // every line would make those artifacts indistinguishable from ones that declined a plan. `/`
        // rather than `+` or `,` for the reason the reach uses `+` -- the line already separates fields
        // with commas -- and because the three numbers are one plan rather than three settings.
        (memoryArm.widthPlan === undefined
          ? ''
          : `, \`widthPlan=${memoryArm.widthPlan.coverage}/${memoryArm.widthPlan.floorChars}/${memoryArm.widthPlan.renderMargin}\``) +
        // The reach, rendered on every run beside the width and joined with `+` rather than a
        // comma: the line already separates fields with commas, so a comma inside a value would
        // make one field look like three.
        `, \`maxTurnCharsRoutes=${renderReach(memoryArm.maxTurnCharsRoutes)}\`` +
        // §13.187.6D, beside the width it modifies: the marker is a fact about the same cut, and
        // a reader comparing a marked run against its control must see the value on both lines.
        // `none` is spelled rather than omitted, for the reason every always-present field here
        // is -- the control ran, and that is information.
        `, \`turnCutMarker=${memoryArm.turnCutMarker ?? 'none'}\`` +
        // §14.143, rendered only when the run named one: unlike the marker, the window's default is the
        // archived state rather than a state a control arm has to be able to name, so printing `head` on
        // every line would add a field to every historical comparison without adding a fact.
        (memoryArm.turnWindow === undefined ? '' : `, \`turnWindow=${memoryArm.turnWindow}\``) +
        // §13.83, rendered on every run for the reason the cap is: `all` is a fact about the
        // prompt (every turn was eligible) rather than the absence of one, and a reader comparing
        // two artifacts must be able to see which of them filtered.
        `, \`reviewPass=${memoryArm.reviewPass ?? 'none'}\`` +
        // §13.334, rendered on every run for the reason `reviewPass` is: `off` is a fact about the run
        // (it repaired nothing) rather than a missing field, and the dispatch that carries the repair has to be
        // distinguishable from its control on the line a human reads, not only in the JSON.
        `, \`replyRepair=${memoryArm.replyRepair ?? 'off'}\`` +
        // §13.97, rendered on every run for the reason the pass is: `none` is a fact about the
        // run's retrieval (it used the bare question) rather than a missing field, and the two
        // artifacts this experiment compares differ only in this value.
        // §13.101, rendered on every run for the reason the pass is: `none` is a fact about the
        // run's consultations (one per question) rather than a missing field.
        `, \`selfConsistency=${memoryArm.selfConsistency ?? 'none'}\`` +
        `, \`queryExpansion=${memoryArm.queryExpansion ?? 'none'}\`` +
        // §13.352. Rendered on every run for the reason the two above are: the block's absence is a
        // fact about the run rather than a missing field, and the artifact this experiment compares
        // differs from this one only in this value.
        `, \`conflicts=${memoryArm.conflicts === true}\`` +
        // The reach, in the run's own units: how many multi-session questions were asked,
        // how many distinct phrases the index received, and how many responses the parser
        // refused whole. One field rather than three so the line stays a configuration
        // rather than a table, and the letters are the unit -- `q` questions, `p` phrases,
        // `r` refusals.
        (memoryArm.queryExpansionCounts === undefined
          ? ''
          : renderExpansionCounts(memoryArm.queryExpansionCounts)) +
        // §13.101's census, rendered only on a run that voted: a control run has no votes to count,
        // and `0/0/0` would claim a mechanism that ran and agreed nothing rather than one that did
        // not run.
        (memoryArm.voteCounts === undefined ? '' : renderVoteCounts(memoryArm.voteCounts)) +
        `, \`evidenceRoles=${
          memoryArm.evidenceRoles === undefined
            ? 'all'
            : [...memoryArm.evidenceRoles].sort().join('+')
        }\`` +
        `, \`evidenceRolesRoutes=${renderReach(memoryArm.evidenceRolesRoutes)}\`` +
        // The unit, under the same rule as the width and for the same reason: it has no
        // meaning without a ranking to act on, because with `relevanceSignal=none` the
        // budget buys the arrival-order prefix and there is no ordering for a unit to
        // change. §13.27's reading is a comparison of this field against §13.26's, so a
        // value that never reached this line would leave the two artifacts describing the
        // same run while differing in what they spent the budget on.
        (memoryArm.relevanceSignal === 'none' || memoryArm.relevanceUnits === undefined
          ? ''
          : `, \`relevanceUnits=${memoryArm.relevanceUnits}\``) +
        // §13.257, beside the signal it parameterises and under the same conditional rule: the three
        // numbers describe a pool that only `retrieval-anchored` builds. Joined with `+` rather than
        // comma-separated, for the reason `maxPromptCharsByRoute` is -- this line already separates
        // fields with commas, so a comma inside a value would make one field look like three.
        (memoryArm.anchors === undefined
          ? ''
          : `, \`anchorParams=count:${memoryArm.anchors.count}` +
            `+radius:${memoryArm.anchors.radius}` +
            `+decay:${memoryArm.anchors.decay}\``) +
        // `self-index`'s cost, beside the signal that produced it. Rendered only when the record exists, for
        // the reason the anchors are: the mechanism's name is always on the line, so a signal naming
        // `self-index` with no record here reads as a run whose product index was never priced -- which is
        // the state every artifact before this field is in, and a state a reader must be able to see rather
        // than infer. Joined with `+` because the fields are one measurement of one stack.
        (memoryArm.selfIndex === undefined
          ? ''
          : `, \`selfIndex=indexes:${memoryArm.selfIndex.indexes}` +
            `+turns:${memoryArm.selfIndex.turns}` +
            `+texts:${memoryArm.selfIndex.embedTexts}` +
            `+hits:${memoryArm.selfIndex.memoHits}` +
            `+reuse:${memoryArm.selfIndex.reuse}` +
            `+rerank:${memoryArm.selfIndex.rerankCalls}/${memoryArm.selfIndex.rerankDegraded}\``) +
        // §14.146's write-gate census, on the line rather than only in the JSON, because the
        // numbers above it are conditioned on this gate and the configuration block cannot say
        // whether it decided anything. `rejected:0` is the disclosure: a gate whose threshold is
        // below every value is a pass-through, and `37110579101` is the recorded cost of reading
        // that as a mechanism. Rendered only when the record exists, under the same rule as the
        // self-index bill: a run whose configuration names a gate it never measured reads as
        // unmeasured rather than as a zero.
        //
        // Joined with `+` and not commas, for the reason the two fields above are: this line
        // already separates fields with commas, so a comma inside a value would make one
        // measurement look like several.
        (memoryArm.admission === undefined
          ? ''
          : `, \`admission=candidates:${memoryArm.admission.candidates}` +
            `+admitted:${memoryArm.admission.admitted}` +
            `+rejected:${memoryArm.admission.rejected}` +
            `+min:${memoryArm.admission.min.toFixed(3)}` +
            `+max:${memoryArm.admission.max.toFixed(3)}` +
            `+mean:${memoryArm.admission.mean.toFixed(3)}` +
            `+distinct:${memoryArm.admission.distinct}${
              memoryArm.admission.distinctSaturated ? '+' : ''
            }\``) +
        // The backend, and the check that it was serving. Appended only when the caller
        // named one, so an artifact that predates the field reads as pre-dating it rather
        // than as having run against an unrecorded backend. Both halves are rendered
        // together because they answer one question -- what produced these vectors, and
        // was it up -- and either alone is consistent with the run that died before it
        // graded a question.
        (memoryArm.embedding === undefined
          ? ''
          : `, \`embedding=${memoryArm.embedding.provider}/` +
            `${memoryArm.embedding.model ?? 'n/a'}@${memoryArm.embedding.dimensions}\`` +
            `, \`embeddingPreflight=${memoryArm.embedding.preflight}\``) +
        // Which reader answered. Appended only when the caller named one, for the reason the
        // embedding field is: an artifact that predates the field must read as pre-dating it
        // rather than as having run against an unrecorded reader. `temp=default` is the state
        // every run before §13.114 was in and is spelled rather than omitted, because "the
        // request carried no temperature" and "this artifact predates the field" are the same
        // bytes otherwise -- the distinction the `reviewPass` field exists to keep.
        (memoryArm.reader === undefined ? '' : `, \`${renderReader(memoryArm.reader)}\``) +
        // §13.312, under the rule the `endpoint=override` clause follows one line up: printed only
        // when the judge is **not** the reader it would otherwise have followed. A run that pinned
        // nothing already says so through the reader clause, and an unconditional clause would move
        // the bytes of every archived line to state something it already stated.
        (memoryArm.judge === undefined || memoryArm.judge.source === 'reader'
          ? ''
          : `, \`judge=${memoryArm.judge.providerId}:${memoryArm.judge.model}` +
            `/temp=${memoryArm.judge.temperature === null ? 'default' : String(memoryArm.judge.temperature)}\``) +
        // Which reranking stage the run carried. Appended only when the caller recorded one --
        // the arm always does, so an artifact without the field predates §13.115 and must not be
        // read as having run the control.
        (memoryArm.rerank === undefined ? '' : `, \`${renderRerank(memoryArm.rerank)}\``),
    );

    // The reachable set, rendered beside the name and for the reason §12.8 gives: the
    // name is the input and this is the treatment. At `bcf66463` the line above said
    // `promptContract=abstention-evidence-blocks` while the rendering reached 17 of 120
    // questions, so the pair is what a reader needs and neither half is sufficient.
    //
    // `undefined` and `[]` are rendered differently on purpose. `[]` is the baseline's
    // real answer -- it administers nothing -- and is a claim the control arm's numbers
    // depend on. `undefined` means the artifact predates the field, and those artifacts
    // were produced by the code whose reach was wrong, so calling that `none` would
    // state as measured what is in fact unknown.
    const reached = memoryArm.renderingRoutes;
    if (reached === undefined) {
      lines.push(`- Evidence rendering reach: \`not recorded\` (artifact predates the field)`);
    } else if (reached.length === 0) {
      lines.push(`- Evidence rendering reached: \`none\` (the baseline prompt is unchanged)`);
    } else {
      lines.push(
        `- Evidence rendering reached: ${reached.length} route(s) — ` +
          reached.map((route) => `\`${route}\``).join(', '),
      );
    }

    // §13's axis, rendered with its reach for the same reason and one more: the ask's
    // reach is the difference between a readable result and a misleading one. MR's own
    // ask IS the candidate, so an artifact naming `extractive` without saying that MR
    // was unchanged would let an unchanged MR be read as evidence the ask does not work.
    if (memoryArm.ask !== undefined) {
      lines.push(`- Evidence ask: \`${memoryArm.ask}\``);
    }
    const askReached = memoryArm.askRoutes;
    if (askReached === undefined) {
      lines.push(`- Evidence ask reach: \`not recorded\` (artifact predates the field)`);
    } else if (askReached.length === 0) {
      lines.push(`- Evidence ask reached: \`none\` (each route's own instruction block)`);
    } else {
      lines.push(
        `- Evidence ask reached: ${askReached.length} route(s) — ` +
          askReached.map((route) => `\`${route}\``).join(', '),
      );
    }

    // §13.279's axis, rendered beside the other two for the reason all three are rendered:
    // a treatment whose artifact cannot say which route it reached is a claim, not a
    // measurement. The assembly is the hardest of the three to see -- reordering leaves the
    // prompt's length and its segment set unchanged -- so the pair of lines below is the only
    // place a reader can check that the run that produced the numbers is the run the
    // registration described.
    if (memoryArm.promptAssembly !== undefined) {
      lines.push(`- Prompt assembly: \`${memoryArm.promptAssembly}\``);
    }
    const assemblyReached = memoryArm.assemblyRoutes;
    if (assemblyReached === undefined) {
      lines.push(`- Prompt assembly reach: \`not recorded\` (artifact predates the field)`);
    } else if (assemblyReached.length === 0) {
      lines.push(`- Prompt assembly reached: \`none\` (the shipped order is unchanged)`);
    } else {
      lines.push(
        `- Prompt assembly reached: ${assemblyReached.length} route(s) — ` +
          assemblyReached.map((route) => `\`${route}\``).join(', '),
      );
    }
  }

  // The annotation version goes with the configuration, for the same reason: it
  // is a property of how the run was set up, not of its outcome, and it changes
  // what a comparison between two artifacts means.
  //
  // Rendered explicitly as "not applied" when zero rather than omitted. The
  // reader's question is "was the candidate annotation on, and at which revision",
  // and an absent line answers neither half. The line is only omitted when the
  // field itself is absent, which marks an artifact older than the field.
  const annotationVersion = report.candidateAnnotationVersion;
  if (annotationVersion !== undefined) {
    lines.push(
      `- Annotation version: ` +
        (annotationVersion === 0
          ? '`not applied`'
          : `\`${annotationVersion}\` (candidate labels were rendered this run)`),
    );
  }

  // Cohort coverage goes ABOVE the results. A caveat printed below three tables
  // of Wilson intervals is a caveat nobody reads, and the point of printing it is
  // that a short cohort changes what every number beneath it means.
  const coverage = report.cohortCoverage;
  if (coverage !== undefined) {
    const required = coverage.present.length + coverage.missing.length;
    lines.push('');
    if (coverage.missing.length > 0) {
      lines.push(
        `> **COHORT INCOMPLETE — read these numbers with care.**`,
        `>`,
        `> This arm's pre-registered predictions name ${required} specific questions. ` +
          `**${coverage.present.length}/${required} (${pct(coverage.ratio)}) are present**; ` +
          `the results below were scored on that subset and are therefore a ` +
          `**different experiment** from the pre-registered one, not a weaker version of it.`,
        `>`,
        `> Missing: ${coverage.missing.join(', ')}`,
      );
    } else {
      lines.push(
        `> **Cohort complete** — all ${required} pre-registered questions present ` +
          `(${pct(coverage.ratio)}).`,
      );
    }
  }

  lines.push(
    '',
    '## Ablation (abstention-aware accuracy)',
    '',
    '| System | min | avg | max | median |',
    '|---|---|---|---|---|',
    spreadRow(report.baseline.name, ab.baselineAggregate),
    spreadRow(report.feature.name, ab.featureAggregate),
    '',
    `- Δ accuracy (feature − baseline): **${(ab.delta >= 0 ? '+' : '') + pct(ab.delta)}**`,
    `- Baseline 95% Wilson CI: **[${pct(ab.baselineConfidence.lower)}–${pct(ab.baselineConfidence.upper)}]**`,
    `- Feature 95% Wilson CI: **[${pct(ab.featureConfidence.lower)}–${pct(ab.featureConfidence.upper)}]**`,
    `- Paired McNemar p-value: **${formatPValue(ab.mcnemarPValue, 'exact')}** (significant: ${ab.mcnemarSignificant ? 'yes' : 'no'})`,
    `- Discordant pairs: baseline-correct/feature-wrong = ${ab.discordant.baselineCorrectFeatureIncorrect}, baseline-wrong/feature-correct = ${ab.discordant.baselineIncorrectFeatureCorrect}`,
    `- Welch t-test p-value (over stochastic runs): **${formatPValue(ab.pValue, 'n/a (deterministic)')}** (significant: ${ab.significant ? 'yes' : 'no'})`,
    `- Cohen's d: **${formatEffectSize(ab.effectSize)}**`,
    '',
    '## Per-capability breakdown (`' + report.feature.name + '` arm)',
    '',
    // §13.88: the accuracy below is the FIRST repetition's, and it used to be the only number on
    // the page while the section above quoted a mean over four. The spread columns are added when
    // the artifact holds them, so a capability's movement can be read in the unit it was measured
    // in -- which is what §13.87's replication showed was missing.
    ...(ab.featureByCapability === undefined
      ? ['| Capability | Accuracy (first repetition) | Total |', '|---|---|---|']
      : [
          '| Capability | Accuracy (first repetition) | Total | min | mean | max |',
          '|---|---|---|---|---|---|',
        ]),
  );
  for (const [capability, result] of Object.entries(report.feature.metrics.perCapability)) {
    const spread = ab.featureByCapability?.[capability];
    lines.push(
      spread === undefined
        ? `| ${capability} | ${pct(result.accuracy)} | ${result.total} |`
        : `| ${capability} | ${pct(result.accuracy)} | ${result.total} | ${spread.min} | ` +
            `${spread.avg.toFixed(1)} | ${spread.max} |`,
    );
  }
  // The three lines a reader quotes in isolation, so each carries the arm. The noun is
  // repeated on every line rather than announced once above them, because these lines are
  // copied out by line -- into a summary table, a commit message, a plan -- and a heading
  // three lines up does not travel with them.
  //
  // §13.122: the same argument, one step further. All three come from
  // `report.feature.metrics`, which is ONE repetition, and they sit eleven lines under a
  // table whose whole purpose is to say the repetitions disagree. Runs `40751377644` and
  // `40751394094` differed in one arming and quoted 86.20% against 83.40% here while their
  // four-run means were 84.30% and 84.20%: the first repetitions implied a `+2.80pp` effect
  // where the means imply `+0.10pp`. Neither line was wrong; the line simply did not say
  // which of the two questions it answered, and the stronger reading was the one a reader
  // reached for. So the repetition is named, and when the artifact holds more than one the
  // comparable number is published beside it rather than left to be found in the table.
  const repetition =
    report.runs === undefined || report.runs <= 1 ? '' : `, first of ${report.runs} runs`;
  lines.push(
    '',
    `- Overall accuracy (\`${report.feature.name}\`${repetition}): ${pct(report.feature.metrics.accuracy)}`,
  );
  lines.push(
    `- Abstention rate (\`${report.feature.name}\`${repetition}): ${pct(report.feature.metrics.abstentionRate)}`,
  );
  lines.push(
    `- Abstention correct rate (\`${report.feature.name}\`${repetition}): ${pct(report.feature.metrics.abstentionCorrectRate)}`,
  );
  if (repetition !== '') {
    const spread = ab.featureAggregate;
    lines.push(
      `- Overall accuracy over all runs (\`${report.feature.name}\`): ${pct(spread.avg)} ` +
        `(min ${pct(spread.min)}, max ${pct(spread.max)})`,
    );
  }
  // §13.176. One question's prompt per repetition. The per-record `promptVariants` count is what a reader
  // checks first, and it is exactly the field that cannot say **what** moved: run `41090564131` read `4` on
  // all 500 questions while two dispatches delivered identical evidence. Rendering the witness here is what
  // turns that count into an addressable question rather than a verdict with no address.
  if (ab.featurePromptRepeatWitness !== undefined) {
    const witness = ab.featurePromptRepeatWitness;
    lines.push('', '## Prompt repeats (`§13.176` witness)', '');
    lines.push(
      `Question \`${witness.questionId}\` at dataset position ${witness.index}, one prompt per repetition.`,
      '',
      '| pass | bytes | leading bytes shared with pass 1 |',
      '|---|---|---|',
    );
    witness.texts.forEach((text, i) => {
      const shared = witness.commonPrefix[i] ?? null;
      lines.push(
        `| ${i + 1} | ${text === null ? '—' : text.length} | ${shared === null ? '—' : shared} |`,
      );
    });
    lines.push(
      '',
      "A `1` in a record's `promptVariants` means the passes resent the same request; this table is what a",
      'reader opens when it says otherwise, because a count cannot name the bytes that moved and `—` at pass 1',
      'is the pass agreeing with itself rather than a measurement.',
    );
  }
  lines.push('', '## Per-capability paired significance (McNemar + Wilson CI)', '');
  lines.push(
    '| Capability | Total | Baseline acc | Feature acc | b✓f✗ | b✗f✓ | McNemar p | Significant |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [capability, stats] of Object.entries(ab.perCapability)) {
    if (stats.total === 0) {
      continue;
    }
    lines.push(
      `| ${capability} | ${stats.total} | ${pct(stats.baselineCorrect / stats.total)} | ${pct(stats.featureCorrect / stats.total)} | ${stats.baselineCorrectFeatureIncorrect} | ${stats.baselineIncorrectFeatureCorrect} | ${stats.mcnemarPValue.toExponential(3)} | ${stats.mcnemarSignificant ? 'yes' : 'no'} |`,
    );
  }
  // The identity of the discordant pairs is printed directly beneath the table
  // whose counts it explains. A count tells a reader how many questions moved; it
  // does not tell them whether the arm's *target* population was among them, and
  // that is the question the conjunction arm needed answered -- four flips, all
  // in IE, while ABS never moved. A reader who wants to check a per-capability
  // count against the underlying questions should not have to open the JSON.
  //
  // `(none)` rather than `0`: an empty list is a measured absence, and writing
  // `0` alongside a count of `0` would make "nothing moved" and "nothing was
  // recorded" render identically -- the same distinction the fallback counters
  // draw between `null` and `0`.
  lines.push('', '### Discordant questions (identity)', '');
  const regression = ab.discordantQuestions.baselineCorrectFeatureIncorrect;
  const gain = ab.discordantQuestions.baselineIncorrectFeatureCorrect;
  lines.push(
    `- Baseline-correct/feature-wrong (${regression.length}): ${regression.length > 0 ? regression.join(', ') : '(none)'}`,
    `- Baseline-wrong/feature-correct (${gain.length}): ${gain.length > 0 ? gain.join(', ') : '(none)'}`,
  );
  // The split of those same two counts along the abstention line. It goes here rather than beside the
  // ablation table because it is a reading of the flips, and the flips are named on the two lines above --
  // a reader who has just seen "5 moved" is the reader asking "moved how".
  lines.push(...transitionLines(ab.transitions));
  // The retry-fire table goes BELOW the results, unlike the cohort banner. The
  // ordering is deliberate and the two are opposite for a reason: the banner
  // qualifies what the numbers below it mean, so it must come first; the fire
  // table is supporting evidence for a null delta, and reads as a footnote to it.
  if (report.retryFires !== undefined) {
    lines.push(...retryFireLines(report.retryFires));
  }
  // The bill, below the results for the same reason and in one line per fact. Rendered
  // from the report rather than concatenated at the call site: the three previous
  // sections that lived at a call site (`cohortCoverage`, `retryFires`, the abstention
  // census) each vanished from a re-rendered artifact, and a reader with the JSON and no
  // Markdown could not tell a free run from an unmeasured one.
  if (report.llmUsage !== undefined) {
    lines.push(
      ...llmUsageLines(report.llmUsage, report.usageBySide, report.costEfficiency, report.runs),
    );
  } else if (report.costEfficiency !== undefined) {
    // §13.308. The price of a correct answer is computable from the side split alone, so a report
    // that has a split but no total bill can still state it. Leaving this out would make the field
    // depend on a section it does not use -- and `attachCostEfficiency` reads `usageBySide`, not
    // `llmUsage`, so the two absences are genuinely independent.
    lines.push(...costEfficiencyLines(report.costEfficiency, report.runs));
  }
  // Directly beside the bill, because the two together are what a run cost: the spend
  // section counts the calls that RETURNED, and this one counts the requests that were
  // made. A run whose provider rejected a third of its attempts is not more expensive in
  // tokens and is far more expensive in wall clock, and only this section can say so.
  if (report.transportRetry !== undefined) {
    lines.push(...transportRetryLines(report.transportRetry));
  }
  // Beside the transport counters and for the same reason: the counters say what the provider did
  // to this run, and this says what the run was doing to the provider. Neither is an arm property,
  // and a reader with only one of them cannot tell "slow because throttled" from "slow because
  // paced", which are opposite next dispatches.
  if (report.passShape !== undefined) {
    lines.push(...passShapeLines(report.passShape));
  }
  // The census also goes BELOW the results, for the `retryFires` reason: it
  // explains a delta's attribution rather than changing what the delta means, so
  // it reads as a footnote. `report.memoryArmConfig` is passed alongside because
  // the inert warning has to compare the census against the arming that was
  // registered -- a zero `threshold` count means "never closed" only if the gate
  // was configured to close.
  if (report.abstentionReasons !== undefined) {
    lines.push(
      ...abstentionReasonLines(report.abstentionReasons, report.memoryArmConfig, report.runs),
    );
  }
  // Its own guard, deliberately: the two censuses come from different optional capabilities, and
  // nesting this one inside the abstention test would hide a recovery pass on a system that reports
  // no bottleneck census -- which is exactly the system the recovery pass was written for.
  lines.push(...recoveryLines(report.recovery));
  // Its own line and its own guard, for the reason above: a system may carry one pass, the other, both, or
  // neither, and a section that only appeared when `recovery` did would hide the bare pass on exactly the builds
  // that have it without the older one.
  lines.push(...bareRetryLines(report.bareRetry));
  // §13.334's own section, on the same rule and for the strongest version of the same reason: this repair acts on
  // the two reply shapes that neither retry above can reach, so folding it into `bareRetry` would print a zero for a
  // mechanism that fired and a number for one that could not.
  lines.push(...replyRepairLines(report.replyRepair));
  // Its own section and its own guard, for the same reason as the two above and one of its own: this pass is
  // the only one whose product is a **difference**, so a section that appeared only when a conversion happened
  // would hide the run that most needs reading -- the audit that ran everywhere and agreed everywhere.
  lines.push(...auditLines(report.audit, report.memoryArmConfig?.reviewPass));
  // Its own section and its own guard, like the two retry passes above: the stage is a property of
  // the arm's ranking rather than of the abstention path, so it must not be nested under a census
  // that a different layer produces.
  lines.push(...rerankLines(report.memoryArmConfig?.rerank));
  lines.push('');
  return lines.join('\n');
}

/**
 * The abstention-census section, as lines.
 *
 * **Not exported**, unlike `retryFireLines` beside it. That one has a second
 * caller -- `formatRetryFireSection` in `runner.ts` renders the same table for the
 * retry arm -- so its export is earned. This one has exactly one caller,
 * `formatAblationReport`, and exporting it would add an orphan by the repository's
 * own census (`pnpm check`). If a second renderer ever needs it, export it then,
 * at which point the export has a caller that justifies it.
 *
 * ## The warning branch, and why it is conditional rather than unconditional
 *
 * The section warns when the retrieval gate was **armed and never closed**: a
 * `retrievalThreshold` above `0` with a `threshold` count of `0`. That is exactly
 * the condition that produced §10.10's wrong write-up, and it is a fact a reader
 * should not have to derive by cross-referencing the config line against the
 * table.
 *
 * The condition is deliberately narrow in both directions:
 *
 * - **`retrievalThreshold: 0` is not inert**, it is the identity configuration
 *   ("answer whenever anything was admitted"), so a zero count is expected. A
 *   warning there would be a false positive, and a warning that fires when
 *   nothing is wrong is a warning readers learn to skip.
 * - **A non-zero count is not inert either**: the gate closed some questions, so
 *   it demonstrably works at this arming.
 *
 * Only the intersection -- armed above zero, closed nothing -- is reported, which
 * is why the tests exercise both controls alongside the true positive.
 */
/**
 * The recovery pass, rendered only when the run could have fired it.
 *
 * One line rather than a table: there are two numbers and a reader needs both together -- an attempt
 * that converted nothing and a pass that never fired look identical in a percentage and mean opposite
 * things. `attempted: 0` is stated rather than omitted for the same reason the config field is.
 */
function recoveryLines(census: RecoveryCensus | undefined): string[] {
  if (census === undefined) return [];
  const { attempted, answered } = census;
  const converted = attempted === 0 ? 'n/a' : `${((answered / attempted) * 100).toFixed(1)}%`;
  return [
    '',
    '## Abstention recovery',
    '',
    '| Consultations | Answered | Converted |',
    '|---|---|---|',
    `| ${attempted} | ${answered} | ${converted} |`,
    '',
    'Attempted counts declines that contradicted their own Step 1 list; a decline with an empty list',
    'is the state the contract licenses and is not consulted. This pass fires only on a decline, so',
    'no answer that was already correct can move.',
  ];
}

/**
 * The bare-decline retry, rendered only when the run could have fired it.
 *
 * The footnote states the two exclusions because both are the difference between a mechanism and a regression.
 * The abstention route is excluded in code: its gold is a decline, so re-asking would spend a call to convert a
 * correct answer into a wrong one. Questions answered on the first attempt never reach the pass, which is why
 * `attempted` is bounded by the decline count rather than by the question count -- and why a zero here is a
 * statement about the population, not about the switch.
 */
/**
 * The reranking stage's section, as lines.
 *
 * ## Why this section names an assembly failure rather than reporting a null result
 *
 * `rerankHits` degrades to the retrieved order on every scorer failure, so a `0.00pp` delta is
 * consistent with two opposite worlds: a cross-encoder that agreed with the retriever on all five
 * hundred questions, and one that never answered the phone. §13.115 pre-registers the distinction —
 * `fallbacks > 0` means the arm did not administer its treatment — and a report that printed four
 * bare numbers would leave a reader to work that out. The warning below is that sentence, in the one
 * place a reader of the Markdown will see it.
 *
 * ## Why `changed` is rendered beside `fallbacks`
 *
 * They are the two halves of "did the stage do anything": `fallbacks: 0, changed: 0` is a reranker
 * that ran and confirmed the retrieval order, which is a **result**, while `fallbacks: 500,
 * changed: 0` is a stage that never executed. Printing either alone makes those two rows identical.
 */
function rerankLines(
  rerank:
    | {
        readonly provider: 'none' | 'openai-compatible' | 'llm' | 'local';
        readonly model?: string | undefined;
        readonly host?: string | null | undefined;
        readonly bounds?:
          | { readonly maxDocuments: number | null; readonly maxDocumentChars: number | null }
          | undefined;
        readonly census?: RerankCensus | undefined;
      }
    | undefined,
): string[] {
  // No stage configured is not a section, and neither is an artifact that predates the field: both
  // are stated on the configuration line, which is where "this run had none" belongs.
  if (rerank === undefined || rerank.provider === 'none') return [];
  const census = rerank.census;
  if (census === undefined) {
    return [
      '',
      '## Rerank stage',
      '',
      'Configured, but the index did not report what it did, so no count below is available. Treat the arm as',
      'unmeasured: an unreported census cannot distinguish a stage that never fired from one that fired and',
      'changed nothing.',
    ];
  }
  const { calls, pairs, fallbacks, changed, clipped } = census;
  const share = calls === 0 ? 'n/a' : `${((changed / calls) * 100).toFixed(1)}%`;
  const lines = [
    '',
    '## Rerank stage',
    '',
    '| Calls | Pairs scored | Fallbacks | Questions reordered | Passages clipped |',
    '|---|---|---|---|---|',
    `| ${calls} | ${pairs} | ${fallbacks} | ${changed} (${share}) | ${clipped} |`,
    '',
    'Calls counts scoring invocations and pairs counts `(question, passage)` pairs, so the second number is the cost',
    'and the first is the population. Fallbacks counts invocations whose reply could not be trusted — a thrown',
    'request, a short reply, a non-finite score — after which the retrieved order stood. Clipped counts passages',
    'shortened to the endpoint declared per-document limit before scoring; the reader still saw the whole turn, so',
    'only the ordering judged a prefix.',
  ];
  if (fallbacks > 0) {
    lines.push(
      '',
      `> **Assembly failure, not a null result.** ${fallbacks} of ${calls} invocations returned nothing usable, so`,
      '> the questions behind them were ranked by the retriever and this arm did not administer its treatment.',
      '> §13.115 registers that state as unreadable rather than negative: the delta it produces measures the',
      '> provider, not the reranker.',
    );
  } else if (changed === 0) {
    lines.push(
      '',
      '> **The stage ran and reordered nothing.** Every reply parsed and every question kept its retrieved order.',
      '> That is a result rather than a failure — the cross-encoder agreeing with the ranking is what a zero',
      '> delta has to mean before it can be read as one — but it also means the increment had no room to act on',
      '> this corpus, which is the reading §13.115 asks for next.',
    );
  }
  return lines;
}

function bareRetryLines(census: BareRetryCensus | undefined): string[] {
  if (census === undefined) return [];
  const { attempted, answered } = census;
  const converted = attempted === 0 ? 'n/a' : `${((answered / attempted) * 100).toFixed(1)}%`;
  return [
    '',
    '## Bare-decline retry',
    '',
    '| Consultations | Answered | Converted |',
    '|---|---|---|',
    `| ${attempted} | ${answered} | ${converted} |`,
    '',
    'Attempted counts questions whose first answer was the abstention token and nothing else, re-asked with',
    'that token absent from the prompt. The abstention route is excluded: its gold is the decline, so a retry',
    'there could only spend a call to turn a correct answer into a wrong one. A question answered first time',
    'is never re-asked.',
  ];
}

/**
 * The reply-contract repair's own section (§13.334).
 *
 * ## Why the kinds are two rows rather than one
 *
 * The pass acts on two shapes that no other retry can see, and the registration that asks for it names both
 * populations separately: eight prose refusals and six quotation dumps out of the fourteen questions in
 * `MEASURE-ORACLE-CEILING.md` §7.4 that are contract violations rather than reasoning failures. A section that
 * printed one pair of numbers would let a reader credit the commitment repair with the shape repair's conversions --
 * and the run that matters most is the one where one kind fires and the other does not.
 *
 * ## Why the note says what a conversion is not
 *
 * `answered` counts consultations that came back with something other than a decline. Whether that something was
 * right needs the gold, and a section that implied otherwise would turn a census into a score -- the mistake
 * `AuditCensus.changed` states explicitly for the audit.
 */
function replyRepairLines(census: ReplyRepairCensus | undefined): string[] {
  if (census === undefined) return [];
  const rate = (part: { attempted: number; answered: number }): string =>
    part.attempted === 0 ? 'n/a' : `${((part.answered / part.attempted) * 100).toFixed(1)}%`;
  return [
    '',
    '## Reply-contract repair',
    '',
    '| Kind | Trigger | Consultations | Answered | Converted |',
    '|---|---|---|---|---|',
    `| commitment | a refusal written in prose | ${census.commitment.attempted} | ${census.commitment.answered} | ${rate(census.commitment)} |`,
    `| echo | the evidence block written back instead of an answer | ${census.echo.attempted} | ${census.echo.answered} | ${rate(census.echo)} |`,
    `| shape | a list of quotations instead of an answer | ${census.shape.attempted} | ${census.shape.answered} | ${rate(census.shape)} |`,
    `| **both** | — | **${census.attempted}** | **${census.answered}** | **${rate(census)}** |`,
    '',
    'Re-asked once, with the evidence the first call read and nothing else changed. `commitment` answers a reply that',
    'reported the evidence holds no answer; `echo` answers a reply that wrote the whole evidence block back -- it is',
    'separated from `shape` because its lines carry the `[YYYY/MM/DD` stamp this product renders, and on `42533236864`',
    '15 dumps are wrong 53.3% of the time against 14.3% for the 28 shape failures that are not dumps; `shape` answers',
    'a reply that quoted the evidence and stopped. None of the three is',
    '`bareRetry`: that one needs the abstention token and nothing else, and both shapes here parse as answers, which',
    'is why no retry could reach them. The abstention route is excluded -- its gold is the decline.',
    '',
    '`Answered` means the second call returned something other than a decline. It does not mean correct: the gold',
    'lives in the roster beside this tally, and the delta on the run is what scores it.',
    '',
    'Each kind also carries its questions, in `replyRepair.<kind>.questions`. That is the target set: a criterion',
    'about whether the repair stayed inside its population is a criterion about a set, and a pair of counts cannot',
    'name it.',
  ];
}

/**
 * The membership audit's own section.
 *
 * ## Why `changed` is printed before any rate
 *
 * The pass is handed an answer that already exists, so "it returned something" is true of every consultation.
 * The only number here that a reader can act on is how often the review disagreed, and the share beside it is
 * `changed / attempted` rather than a conversion rate -- calling it a conversion would import the vocabulary of
 * the two retry passes, where a consultation that changes nothing is a failure. Here it is not: an audit that
 * agrees with every answer has measured the reader's stability, which is a result about the arm.
 *
 * ## Why the section says what it cannot say
 *
 * The census counts consultations and differences. It does not say whether a difference was an improvement --
 * that needs the gold, which lives in the roster beside it and not in this tally. Printing a "fixed" column here
 * would be a second definition of accuracy computed from the same records, and the campaign has paid for two
 * definitions of one number more than once (§13.41.5 is the first).
 */
/**
 * The second consultation's rows, named by the pass that produced them.
 *
 * The header used to be keyed off `refused === undefined`, which was correct while `tally` was the only
 * pass that could refuse and became a mislabel the moment `spec` arrived: a specification run would
 * have printed *"reviewPass: tally"* over its own census. The pass name is now passed in, and the
 * refusal column still follows the field rather than the name -- a pass that cannot refuse must not
 * print a zero for a branch it cannot enter.
 */
function auditLines(census: AuditCensus | undefined, pass?: string | undefined): string[] {
  if (census === undefined) return [];
  const { attempted, changed, refused } = census;
  const label = pass === 'spec' ? 'spec' : 'tally';
  const share = attempted === 0 ? 'n/a' : `${((changed / attempted) * 100).toFixed(1)}%`;
  // The refusal column is printed only when the pass that can refuse ran. A row of zeros under `audit`
  // would be a measurement of a branch the audit cannot enter -- the reason `AuditCensus.refused` is
  // optional rather than defaulted.
  return [
    '',
    refused === undefined
      ? '## Membership audit (`reviewPass: audit`)'
      : `## Second consultation (\`reviewPass: ${label}\`)`,
    '',
    refused === undefined
      ? '| Consultations | Moved the answer | Share moved |'
      : '| Consultations | Moved the answer | Share moved | Refused ledgers | Refused share |',
    refused === undefined ? '|---|---|---|' : '|---|---|---|---|---|',
    refused === undefined
      ? `| ${attempted} | ${changed} | ${share} |`
      : `| ${attempted} | ${changed} | ${share} | ${refused} | ${attempted === 0 ? 'n/a' : `${((refused / attempted) * 100).toFixed(1)}%`} |`,
    '',
    'Attempted counts consultations this pass issued: it runs on the multi-session route, on an answer that was',
    'not a decline, and it re-reads the same evidence with the first pass quoted and a membership-only',
    'instruction. "Moved" counts the consultations whose answer differed from the one they were handed -- a',
    'review that agreed everywhere reports `0` here and has still measured something. Whether a move was an',
    'improvement is not in this table: that needs the gold, and it is read from the roster.',
    ...(refused === undefined
      ? []
      : [
          '',
          `Under \`reviewPass: ${label}\` the second consultation is not a membership review of every answered`,
          'question: it runs on the multi-session route, on an answer that was not a decline, and only where the',
          'question asks for a count or a total (`tally.ts`). It asks for the same list with every line tagged',
          label === 'spec'
            ? 'a question asks for a count or a total (`tally.ts`), and it asks for a PLAN rather than a list: a'
            : 'by what it contributes, and the answer is the sum of the tags rather than the model own total.',
          ...(label === 'spec'
            ? [
                'scope, a conjunction of field filters and an operation, run by a deterministic executor over a',
                'ledger compiled by programme before the question arrived. A **refused** plan is one the parser',
                'could not read, one whose scope runs past the history, or one whose execution produced no value',
                '-- an empty selection, or a sum whose numbers disagreed about their unit. The first pass answer',
                'stands in every one of those cases.',
              ]
            : [
                'A **refused** ledger is one where a line carried no tag, or where there were no lines at all; the',
                'first pass answer stands in that case, because a partial sum is a smaller total stated with the same',
                'confidence as a complete one.',
              ]),
        ]),
    ...(census.authorization === undefined
      ? []
      : [
          '',
          '## Authorization (`reviewPass: spec`, §13.365)',
          '',
          '| Substitutions offered | Veto would authorize | Share | Rows selected | Supporting rows | Ledger rows | Answer numerals |',
          '|---|---|---|---|---|---|---|',
          `| ${census.authorization.evaluated} | ${census.authorization.authorized} | ${
            census.authorization.evaluated === 0
              ? 'n/a'
              : `${((census.authorization.authorized / census.authorization.evaluated) * 100).toFixed(1)}%`
          } | ${census.authorization.selected} | ${census.authorization.supportHits} | ${
            census.authorization.ledgerRows
          } | ${census.authorization.tokens} |`,
          '',
          'The registered veto substitutes the plan value only when the first answer own numeral appears among the',
          'rows the plan selected. **Nothing acts on that verdict in this build**: the arithmetic is recorded on',
          'the run before the dispatch that prices it, because a relation nobody persisted cannot be measured',
          'afterwards -- `support` was computed on every call in this pass and dropped, which is the defect this',
          'table exists to close. `Supporting rows` counts selected rows carrying one of the answer numerals, so',
          'the identity to check is `supporting <= selected <= ledger rows`, and `Answer numerals: 0` is the case',
          'where the veto could not run at all.',
        ]),
  ];
}

function abstentionReasonLines(
  reasons: AbstentionReasons,
  config?: MemoryArmConfig | undefined,
  runs?: number | undefined,
): string[] {
  const total = reasons.empty + reasons.threshold + reasons.llm + reasons.answered;
  const share = (n: number): string =>
    total === 0 ? '0.00%' : `${((n / total) * 100).toFixed(2)}%`;

  // The machine's share is `empty` plus `threshold`: both are decided before the
  // model is consulted, and both cost no request. The model's share is `llm`.
  // `answered` is neither -- it is the path that produced an answer.
  const machineDerived = reasons.empty + reasons.threshold;

  const lines = [
    '',
    '## Abstention reasons',
    '',
    // The SCOPE is stated before the table, because the table reads as though it
    // covers one thing and the honest answer changed. It used to count the
    // abstention route alone: `CortexMemory.#reasons` was written only in
    // `answerAbstention`, and `runBenchmark` dispatches that method only for
    // `capability === 'ABS'`.
    //
    // That was misread into a whole round of work. §12.5's `llm = 120` was read as
    // "the model declined 120 times" and §55.4 opened an investigation into the 30
    // ABS outputs -- but `30 x 4 runs = 120` exactly, ABS gold IS abstention, and
    // ABS scored 30/30 correct. Those calls were the capability passing.
    //
    // §58 fixed the reading by naming the narrow scope here rather than widening
    // the counter, on the grounds that the misreading came from the number. §13 is
    // what made that untenable: MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0`, all
    // of it on routes the census did not cover, and no other field in the artifact
    // could say which route declined.
    //
    // So the scope is now the run, and the one thing that is NOT run-wide is named
    // explicitly: `threshold` is reachable only through `answerAbstention`, since
    // that is the only caller of `#retrievalAdmitted`. Saying so matters because a
    // reader who sees `threshold: 0` should know whether the gate was open or
    // absent, and on every route but `ABS` it is absent.
    '> Scope: **every route that can decline** (session, temporal, abstention, ' +
      'knowledge-update, assistant, preference, flat). One exception, stated rather ' +
      'than implied: `threshold` is reachable only on the abstention route, because ' +
      'that is the only caller of the retrieval gate — on every other route the key ' +
      'is `0` because no gate exists there, not because the gate stayed open. This ' +
      "table used to count the abstention route alone, which is how §12.5's `llm = " +
      '120` came to be read as the model declining 120 times when it was 30 `ABS` ' +
      'questions passing across 4 runs.',
    '',
    '| Reason | Count | Share | Decided by |',
    '|---|---|---|---|',
    `| \`empty\` | ${reasons.empty} | ${share(reasons.empty)} | machine (no evidence admitted) |`,
    `| \`threshold\` | ${reasons.threshold} | ${share(reasons.threshold)} | machine (retrieval gate closed; abstention route only) |`,
    `| \`llm\` | ${reasons.llm} | ${share(reasons.llm)} | model (declined) |`,
    `| \`answered\` | ${reasons.answered} | ${share(reasons.answered)} | model (answered) |`,
    '',
    // The counting unit is stated because getting it wrong is not hypothetical.
    // `CortexMemory` tallies CALLS on an instance the arm reuses across every
    // repetition, so this total is `questions x runs`. The first version of this
    // line called it "questions through the abstention path", which was false by a
    // factor of `runs` whenever `runs > 1` -- and §12.5 is exactly that case: 30
    // `ABS` questions, `runs = 4`, a census total of `120`, and a capability table
    // saying `30`, with nothing in the document reconciling them.
    //
    // "questions that reached a decision" rather than "calls through the abstention
    // path": the latter named one route and the census now covers seven, and a unit
    // that names the wrong population is the same defect one layer up from the
    // count itself.
    `- Total: **${total}** questions that reached a decision`,
  ];

  // The divisor, published rather than applied. Deriving it from `questionCount`
  // would assert that every question was asked exactly `runs` times, which the
  // census cannot confirm and which an interrupted run falsifies. Stating the
  // configured count lets a reader divide and see what they divided by.
  if (runs !== undefined && runs > 1) {
    lines.push(
      `- Accumulated over **${runs} runs** of ${total / runs === Math.floor(total / runs) ? `${total / runs}` : `~${(total / runs).toFixed(1)}`} ` +
        'questions each, because the arm reuses one feature instance across repetitions',
      `- Per-run counts, comparable against the capability table above: \`empty\` ${reasons.empty / runs}, ` +
        `\`threshold\` ${reasons.threshold / runs}, \`llm\` ${reasons.llm / runs}, ` +
        `\`answered\` ${reasons.answered / runs}`,
    );
  }

  lines.push(
    `- Machine-derived share (\`empty\` + \`threshold\`): **${share(machineDerived)}**`,
    `- Model-side share (\`llm\`): **${share(reasons.llm)}**`,
  );

  const armed = config !== undefined && config.retrievalThreshold > 0;
  if (armed && reasons.threshold === 0) {
    lines.push(
      '',
      `- **INERT GATE**: \`retrievalThreshold: ${config.retrievalThreshold}\` was armed, but the ` +
        "gate closed on **0** questions. The abstentions above are not the gate's. This is the " +
        'condition `docs/09-progress-and-delivery-report.md` §10.10 documents — a value function ' +
        'whose reachable range collapsed to a point makes every threshold at or below the ' +
        'ceiling permanently open, so the cut cannot discriminate and any delta measured here ' +
        'is not attributable to it.',
    );
  }

  return lines;
}

/**
 * The abstention-line split of the discordant pairs, as lines.
 *
 * ## Why the four numbers are printed as a table with a named flow
 *
 * `recovered` and `corrected` both mean "this question was bought", and a reader who is shown them side by
 * side without a label will read the larger one as the mechanism. The label is the sentence underneath, and
 * it is computed by `dominantFlow` rather than written by hand so that the phrase and the counts cannot
 * disagree — the failure mode of a report that names its own result is a report that names the wrong one.
 *
 * ## Why the identity is printed
 *
 * The two bought cells must sum to the bought count above and the two sold cells to the sold count. Printing
 * the sums is what lets a reader check that this table is a refinement of those counts rather than a second
 * measurement of something else — and it is the line that would show a future edit double-counting a flip.
 *
 * ## The absent branch
 *
 * An artifact written before this field existed has no split. That is printed as a sentence, not omitted:
 * a section that silently disappears reads as a section that had nothing to say, and the difference between
 * "nothing crossed the decline line" and "nobody recorded which side each question was on" is the whole
 * reason this exists.
 */
function transitionLines(transition: AnswerTransition | undefined): string[] {
  if (transition === undefined) {
    return [
      '',
      '### What kind of change each flip was',
      '',
      'Not recorded in this artifact: it was written before this split existed. The two flip counts above ' +
        'stand; what is missing is which side of the abstention line each flipped question was on, so ' +
        '"started speaking" and "started being right" cannot be separated here.',
    ];
  }
  const { recovered, corrected, declined, missed } = transition;
  const bought = recovered + corrected;
  const sold = declined + missed;
  const flow = dominantFlow(transition);
  const reading =
    flow === 'none'
      ? '**Nothing crossed either line**: no question changed verdict, which is a null result rather than a ' +
        'table with four zeroes in it.'
      : flow === 'decline'
        ? '**The decline flow carried it**: every question that changed verdict crossed the abstention line ' +
          'in one direction or the other, so this increment changed *whether* the system speaks.'
        : flow === 'content'
          ? '**The content flow carried it**: no flipped question crossed the abstention line, so this ' +
            'increment changed *what* the system says, not whether it says anything.'
          : '**Two mechanisms moved together**: flips crossed the abstention line and changed content, so ' +
            'the net figure below is the sum of a response-shape effect and a knowledge effect and must not ' +
            'be reported as one of them.';
  const declineFlow = recovered + declined;
  const contentFlow = corrected + missed;
  return [
    '',
    '### What kind of change each flip was',
    '',
    '| flip | baseline | treatment | count |',
    '|---|---|---|---|',
    `| recovered | declined | answered correctly | ${recovered} |`,
    `| corrected | answered wrongly | answered correctly | ${corrected} |`,
    `| declined | answered correctly | declined | ${declined} |`,
    `| missed | answered correctly | answered wrongly | ${missed} |`,
    '',
    `- ${reading}`,
    `- Decline flow (recovered + declined) = ${declineFlow} against content flow (corrected + missed) = ${contentFlow}`,
    `- Identity: recovered + corrected = ${bought} is the bought count above, declined + missed = ${sold} is ` +
      'the sold count above — this table refines those two numbers and cannot disagree with them.',
  ];
}

/**
 * The retry-fire section, as lines.
 *
 * Exported so that `formatRetryFireSection` in `runner.ts` and
 * `formatAblationReport` above render it from ONE implementation. Two renderers
 * for the same table is the defect this refactor removes: before it, the section
 * reached the Markdown by string concatenation at the call site and the JSON by a
 * spread at a different call site, so the two could disagree and a re-rendered
 * report lost the section entirely.
 *
 * The two warning branches are the reason the section exists at all. A retry
 * ablation publishes a null result by design, and a null is produced both by a
 * feature that works on a dataset it cannot help and by a feature that was never
 * wired in. The counters are what separate those readings, so an arm with a
 * misconfigured control must not be allowed to look like a clean negative finding.
 */
export function retryFireLines(fires: RetryFireCounts): string[] {
  const rate = fires.questions === 0 ? 0 : fires.treatmentFires / fires.questions;
  const lines = [
    '',
    '## Abstention-retry fires',
    '',
    '| Arm | Retry fires |',
    '|---|---|',
    `| control (\`enableAbstentionRetry: false\`) | ${fires.controlFires} |`,
    `| treatment (\`enableAbstentionRetry: true\`) | ${fires.treatmentFires} |`,
    '',
    `- Treatment fire rate: **${(rate * 100).toFixed(2)}%** of ${fires.questions} questions`,
  ];
  if (fires.controlFires !== 0) {
    lines.push(
      '',
      `- **INVALID EXPERIMENT**: the control arm fired ${fires.controlFires} times despite ` +
        '`enableAbstentionRetry: false`. The flag is not reaching the retry, so the two arms ' +
        'are not the comparison this ablation claims to make.',
    );
  } else if (fires.treatmentFires === 0) {
    lines.push(
      '',
      '- **INERT ON THIS DATASET**: the treatment arm never fired. The retry had zero ' +
        'opportunities, so the Δ accuracy above measures nothing and must not be read as ' +
        'evidence the feature does not work.',
    );
  } else if (fires.treatmentFires <= 2) {
    // The third branch exists because the middle branch was read too broadly.
    //
    // "The treatment never fired" and "the treatment fired once or twice" are not
    // the same finding, and the published result for this arm is the LATTER: a
    // single fire across the whole dataset. A fire rate this low is still an INERT
    // result -- with one opportunity the Δ accuracy can move by at most 1/N -- but
    // it is inert for a different reason, and the remedy differs.
    //
    // Zero fires means the mechanism had no opportunity and the correct next step
    // is to look for a population that produces bare abstentions. One or two fires
    // means the mechanism works and is active, but that the retry-armed population
    // is essentially disjoint from the one that fails. Collapsing the second case
    // into the first would send the next iteration hunting for a wiring bug that
    // does not exist -- which is exactly the misreading the counters are here to
    // prevent, so the renderer must not commit it itself.
    lines.push(
      '',
      `- **INERT ON THIS DATASET**: the treatment arm fired only ${fires.treatmentFires} ` +
        `time${fires.treatmentFires === 1 ? '' : 's'} across ${fires.questions} questions ` +
        `(${(rate * 100).toFixed(2)}%). The mechanism is wired and active — the control's 0 ` +
        'confirms the flag reaches the retry — but it found almost no opportunities, so the ' +
        'Δ accuracy above is bounded by ' +
        `${((fires.treatmentFires / (fires.questions === 0 ? 1 : fires.questions)) * 100).toFixed(2)} pp ` +
        'and carries no information about whether the feature helps. Do not read it as a ' +
        'negative result; read it as an under-powered one.',
    );
  }
  return lines;
}

/**
 * Attach a run's spend to its report, or decline to.
 *
 * The rule is one line and the reason is the whole function: a snapshot with `calls === 0`
 * means no request in this run passed through the instrumented adapter. Attaching it
 * would state "this run spent nothing" about a run whose spend is UNKNOWN -- which is the
 * exact misreading `cortex-ai/src/usage.ts` was written to prevent one layer down, where
 * a response with no `usage` block is an unpriced call and not a free one. Absent means
 * not measured; a report that predates the instrument must not be distinguishable from a
 * run that never called a provider, and neither may be distinguishable from a free run,
 * because neither is one.
 *
 * ## Why the zero-call case is not the interesting one
 *
 * A run whose provider returned no `usage` block DOES attach: `calls` is its call count,
 * `unpricedCalls` equals it, and the token columns are `0`. That combination is the
 * informative one -- it says the bill exists and cannot be read -- and dropping it for
 * looking zero would delete the only evidence that the instrument is pointed at a
 * provider that never answers it. Only `calls === 0` is silence.
 *
 * Exported rather than inlined at the one call site for the reason the three earlier
 * sections in this file record at length: a rule expressed as a conditional spread in an
 * object literal is a rule no test can reach, and this repository has paid for that shape
 * three times (`cohortCoverage`, `retryFires`, the abstention census).
 */
export function attachLlmUsage(report: AblationReport, usage: UsageSnapshot): AblationReport {
  return usage.calls === 0 ? report : { ...report, llmUsage: usage };
}

/**
 * Attach the per-side split, on the same absence rule as the total.
 *
 * A run in which neither side made an instrumented call has no split to report, and attaching
 * zeros would claim both arms were free rather than unmeasured -- the distinction `unpricedCalls`
 * exists to keep one layer down.
 */
export function attachUsageBySide(report: AblationReport, bySide: UsageBySide): AblationReport {
  return bothSides(bySide).calls === 0 ? report : { ...report, usageBySide: bySide };
}

/**
 * Attach the price of one correct answer, on the same absence rule and one layer downstream.
 *
 * §13.308. This exists because the ratio had no owner. `tools/cost-ledger.py` computed it from an
 * artifact by dividing `usageBySide.feature.promptTokens / (questionCount × runs)` -- an
 * **all-repetitions** mean -- by `feature.metrics.accuracy`, which is **one repetition**. On the
 * §13.305 pair that is a 0.60% overcharge on the arm whose first repetition was its worst and a
 * 0.06% undercharge on the arm whose first repetition was its best, and the pair's cost gap reads
 * 0.57% where the honest figure is 1.23%.
 *
 * The two accuracies are both in the artifact, so nothing had to be measured to fix this -- the
 * division simply used the wrong one, in a tool, once. A ratio that every consumer recomputes is a
 * ratio every consumer can get differently right, so the run writes it down: `costEfficiency`
 * carries the ratio, the numerator, the denominator, and **which population the denominator came
 * from**. Reading `featureAggregate.avg` is the whole fix; naming it in the artifact is what makes
 * the fix checkable a year later.
 *
 * ## Why `featureAggregate` and not `feature.metrics`
 *
 * Numerator and denominator have to describe the same repetitions, and the numerator is a sum over
 * all of them. `featureAggregate.avg` is the unweighted mean of each repetition's accuracy; every
 * repetition grades the same questions, so it equals the pooled proportion. When the field is
 * absent -- an artifact written before the spread existed, or one that only ever had a single
 * repetition -- the two populations coincide, and `accuracySource` says `first-repetition` rather
 * than letting a coincidence pass for a measurement.
 *
 * ## Why the guard is here and not in the type
 *
 * `AblationResult.featureAggregate` is required, and the artifacts this reader must survive are
 * JSON. A required field is a claim about what this build writes; it is not a claim about what a
 * file on disk contains.
 */
export function attachCostEfficiency(report: AblationReport): AblationReport {
  const feature = report.usageBySide?.feature;
  if (feature === undefined || report.usageBySide === undefined) return report;
  // `runs` absent is not one repetition. A four-repetition artifact that lost the field would be
  // priced at a quarter of its spend, so the count is required exactly as `questionCount` is.
  if (report.runs === undefined) return report;
  // A split that does not close is not a split. `residualUsage` refuses when the two sides claim
  // more than the run reported, which means the tallies did not come from one ledger -- and the
  // renderer already declines to print a per-arm column in that case. This reading is computed
  // from that column, so it declines for the same reason: an absent ratio reads as "not measured"
  // while a wrong one reads as a measurement. Conditional on the total because `llmUsage` and
  // `usageBySide` attach independently, and requiring one to check the other would make a report
  // that carries only the split unpriceable for no reason.
  if (report.llmUsage !== undefined) {
    try {
      residualUsage(report.llmUsage, report.usageBySide);
    } catch {
      return report;
    }
  }
  const aggregate = report.ablation.featureAggregate;
  const accuracy = aggregate === undefined ? report.feature.metrics.accuracy : aggregate.avg;
  const efficiency = costEfficiencyFrom({
    promptTokens: feature.promptTokens,
    questionCount: report.questionCount,
    runs: report.runs,
    accuracy,
    accuracySource: aggregate === undefined ? 'first-repetition' : 'all-runs',
  });
  // `null` is a state, not a failure: the report is returned unchanged so absence means "not
  // measured" and a consumer cannot mistake a refused division for a zero-cost one.
  return efficiency === null ? report : { ...report, costEfficiency: efficiency };
}

/**
 * Attach what the transport layer saw, unconditionally.
 *
 * ## Why this does not follow the absence rule the two above use
 *
 * `attachLlmUsage` omits the field when the run made no instrumented call, because a
 * provider that reports no `usage` block is a real state and attaching zeros would call
 * that state free. The retry counters are different in kind: they are incremented by the
 * loop itself before the provider answers, so any run that reached a provider at all has a
 * non-zero `attempts`. A zero here is therefore not "a quiet provider" -- it is "the
 * instrument was not wired", and an artifact should be able to say so rather than leaving a
 * reader to guess whether the field is absent because the code predates it.
 *
 * That makes absence unambiguous: every artifact written after this field existed carries
 * it, so an artifact without it was written before.
 */
export function attachTransport(
  report: AblationReport,
  transport: TransportRetryReport,
): AblationReport {
  return { ...report, transportRetry: transport };
}

/**
 * One row of the ablation spread table, or dashes when the artifact never held a spread.
 *
 * §13.308. A reader that survives an artifact written before `featureAggregate` existed must not
 * crash on it, and `—` is not `0.00%`: the same `null`-versus-`0` rule this file applies to retry
 * counters and to the token columns, one table up. The dash says the repetitions were never spread
 * because there was only one of them, which is a fact about the run and not a stability result.
 */
function spreadRow(name: string, spread: AggregateStats | undefined): string {
  if (spread === undefined) return `| ${name} | — | — | — | — |`;
  return (
    `| ${name} | ${pct(spread.min)} | ${pct(spread.avg)} | ` +
    `${pct(spread.max)} | ${pct(spread.median)} |`
  );
}

/**
 * The price of one correct answer, rendered with the denominator it was divided by.
 *
 * §13.308. The sentence carries three facts because the ratio is unusable without two of them: the
 * divisor's value, and **which population it came from**. `all-runs` and `first-repetition` coincide
 * on a one-repetition arm and differ on a four-repetition one, so a bare ratio would let two
 * artifacts be compared on denominators that describe different populations -- which is the
 * defect this field replaced, moved from the tool into the reader's head.
 */
function costEfficiencyLines(efficiency: CostEfficiency, runs?: number): string[] {
  const repetitions = runs === undefined ? '' : ` over ${runs} repetition${runs === 1 ? '' : 's'}`;
  return [
    '',
    `- \`feature\` arm costs **${efficiency.perCorrectAnswerPromptTokens.toLocaleString('en-US', {
      maximumFractionDigits: 0,
    })} prompt tokens per correct answer** — ` +
      `${efficiency.promptTokensPerQuestion.toLocaleString('en-US', {
        maximumFractionDigits: 0,
      })} per question ÷ ${pct(efficiency.accuracy)} accuracy ` +
      `(\`${efficiency.accuracySource}\`${repetitions}).`,
  ];
}

/**
 * The provider-spend section, as lines.
 *
 * **Not exported**, unlike `retryFireLines` beside it: that one has a second renderer in
 * `runner.ts` and so earns its export, while this section has exactly one caller. Two
 * renderers for one table is the defect `retryFireLines`'s docblock records; a single
 * caller is the reason that defect cannot recur here.
 *
 * ## Why the section leads with calls and not with tokens
 *
 * Because a token total is only meaningful next to the denominator that produced it. Nine
 * million prompt tokens over a thousand calls is a 9,000-token prompt; the same total over
 * fifty calls is a runaway loop. The call count is also the only field that separates "the
 * provider reported nothing" from "nothing was spent", which is the whole reason
 * `unpricedCalls` exists one layer down.
 *
 * ## Why the reading line is a share of the prompt and not of the bill
 *
 * A currency figure would need a rate card this repository does not own (see
 * `cortex-ai/src/usage.ts`), so what is rendered is the one ratio that is a property of
 * the run rather than of the contract: how much of the prompt the provider served from
 * its prefix cache. That share is the quantity that prices a prompt-ordering change, and
 * a run that reports it makes the next dispatch's cost predictable before it is paid.
 */
function llmUsageLines(
  usage: UsageSnapshot,
  bySide?: UsageBySide,
  efficiency?: CostEfficiency,
  reportRuns?: number,
): string[] {
  const hitShare = usage.promptTokens === 0 ? 0 : usage.cacheHitPromptTokens / usage.promptTokens;
  const lines = [
    '',
    '## Provider spend (as reported by the provider)',
    '',
    '| Field | Value |',
    '|---|---|',
    `| calls that returned a response | ${usage.calls} |`,
    `| of those, with no \`usage\` block | ${usage.unpricedCalls} |`,
    `| prompt tokens | ${usage.promptTokens.toLocaleString('en-US')} |`,
    `| completion tokens | ${usage.completionTokens.toLocaleString('en-US')} |`,
    `| prompt tokens served from the prefix cache | ${usage.cacheHitPromptTokens.toLocaleString('en-US')} |`,
    '',
    `- Prefix-cache share of the prompt: **${(hitShare * 100).toFixed(2)}%** ` +
      `(${usage.cacheHitPromptTokens.toLocaleString('en-US')} of ${usage.promptTokens.toLocaleString('en-US')})`,
  ];
  if (bySide !== undefined) {
    // Rendered only when it closes. A negative residual means the two snapshots did not come from
    // one ledger, and printing that as a side that spent nothing would be worse than printing no
    // split at all -- so the section says the split is unavailable instead of printing one that
    // does not add up.
    let residual: UsageSnapshot | null = null;
    try {
      residual = residualUsage(usage, bySide);
    } catch {
      residual = null;
    }
    if (residual === null) {
      lines.push(
        '',
        '- **SPLIT UNAVAILABLE**: the two sides together claim more spend than the run reported, ' +
          'so the snapshots were not taken from one ledger. No per-arm column is printed rather ' +
          'than one that does not add up.',
      );
    } else {
      const rows: Array<[string, UsageSnapshot]> = [
        ['baseline (`reference-pipeline`)', bySide.baseline],
        ['feature (`cortex-memory`)', bySide.feature],
        ['neither arm (judge, phrasing, setup)', residual],
      ];
      lines.push(
        '',
        '| Side | calls | prompt tokens | completion tokens | cached prompt |',
        '|---|---|---|---|---|',
        ...rows.map(
          ([label, part]) =>
            `| ${label} | ${part.calls} | ${part.promptTokens.toLocaleString('en-US')} | ` +
            `${part.completionTokens.toLocaleString('en-US')} | ` +
            `${part.cacheHitPromptTokens.toLocaleString('en-US')} |`,
        ),
        '',
        // The identity, stated rather than left to the reader: three columns that are supposed to
        // sum to the total above are the easiest place for an instrument to drift quietly.
        `- Attribution closes: **${bothSides(bySide).promptTokens + residual.promptTokens === usage.promptTokens ? 'yes' : 'no'}** ` +
          `(${bothSides(bySide).promptTokens.toLocaleString('en-US')} + ` +
          `${residual.promptTokens.toLocaleString('en-US')} prompt tokens)`,
      );
    }
  }
  if (efficiency !== undefined) {
    lines.push(...costEfficiencyLines(efficiency, reportRuns));
  }
  if (usage.unpricedCalls === usage.calls) {
    // Every call unpriced is the strongest warning this section can carry and it is not
    // the same statement as a large unpriced share: it means the instrument is pointing
    // at a provider that never answers it, so the token columns above are not "small",
    // they are unmeasured, and no comparison between two runs can be priced at all.
    lines.push(
      '',
      `- **NO PROVIDER COST WAS REPORTED**: all ${usage.calls} calls returned no \`usage\` ` +
        'block, so every token column above is unmeasured rather than zero. The run is ' +
        'costed from the invoice and not from this artifact; treat any comparison of ' +
        'spend against a run that reports numbers as unavailable.',
    );
  } else if (usage.unpricedCalls > 0) {
    lines.push(
      '',
      `- **PARTIAL**: ${usage.unpricedCalls} of ${usage.calls} calls reported no \`usage\` ` +
        'block, so the token totals above cover the rest. The shortfall is not recoverable ' +
        'from this artifact.',
    );
  }
  return lines;
}

/**
 * The transport section: what the provider did with the requests, as lines.
 *
 * ## Why this is not part of the spend section
 *
 * They count different things and disagree by construction. A call rejected three times
 * and then served is ONE call in the spend table and FOUR requests here. Stating them in
 * one table would invite reading a rate against the wrong denominator, and the rate is the
 * whole point: it is the only number that says whether the provider was a cost in wall
 * clock rather than in tokens.
 *
 * ## Why the reading lines are shaped like findings
 *
 * A table of eight counters leaves the reader to decide what a non-zero `rateLimited`
 * means. Three states are separable and each implies a different next action: nothing was
 * retried (the provider was healthy, or the counters are not wired -- `calls` decides
 * which), retries happened but none was a `429` (transient faults or `5xx`, not a rate
 * limit), and a non-zero `429` count (the provider throttled, and the next dispatch's
 * wall clock inherits it). The section says which one it is rather than making the reader
 * derive it.
 *
 * ## What it deliberately does not say
 *
 * The per-call waiting ceiling. It is a code constant (`DEFAULT_RETRY_BUDGET_MS` in
 * `cortex-ai`), not a value this run carried, and an artifact that printed a number no run
 * recorded would be describing the code rather than the measurement. The counters are what
 * the run can substantiate.
 */
function transportRetryLines(transport: TransportRetryReport): string[] {
  // Four classes, and the fourth is the one whose absence was read as its opposite: a call
  // answered `429` and then not retried used to be counted as clean, so an artifact could say
  // "every request was served first time" about a run that was dying of a declined retry.
  const closes =
    transport.cleanCalls +
      transport.retriedCalls +
      transport.exhaustedCalls +
      transport.refusedCalls ===
    transport.calls;
  const lines = [
    '',
    '## Transport (what the provider did with the requests)',
    '',
    '| Field | Value |',
    '|---|---|',
    `| calls | ${transport.calls} |`,
    `| requests issued (first attempts + retries) | ${transport.attempts} |`,
    `| retries | ${transport.retried} |`,
    `| calls served on the first attempt | ${transport.cleanCalls} |`,
    `| calls that had to retry | ${transport.retriedCalls} |`,
    `| calls that exhausted every attempt | ${transport.exhaustedCalls} |`,
    `| calls whose retry the ladder declined | ${transport.refusedCalls} |`,
    `| attempts answered \`429\` | ${transport.rateLimited} |`,
    `| retries whose wait came from \`Retry-After\` | ${transport.retryAfterHonoured} |`,
    '',
    `- Retry rate: **${(transport.retryRate * 100).toFixed(2)}%** of ${transport.calls} calls ` +
      `(${transport.retriedCalls} retried at least once)`,
  ];
  if (!closes) {
    // The three classes partition the sample in `cortex-ai` and the identity is asserted
    // there. Printing the failure here rather than only there is deliberate: the reader
    // holding an artifact cannot run that test, and a partition that does not close means
    // the counters were read across a boundary -- two processes, or a reset in the middle.
    lines.push(
      '',
      `- **COUNTERS DO NOT PARTITION**: ${transport.cleanCalls} + ${transport.retriedCalls} + ` +
        `${transport.exhaustedCalls} + ${transport.refusedCalls} ≠ ${transport.calls}. Every class ` +
        'is still an honest count, but they were not read from one aggregate, so no rate above ' +
        'can be trusted.',
    );
  }
  if (transport.calls === 0) {
    // The one state that is a defect rather than a finding: the loop counts a call before
    // the provider answers, so a graded run cannot reach this line with zero.
    lines.push(
      '',
      '- **NOT WIRED**: no call reached the retry layer at all. On a run that graded ' +
        'answers this is impossible, so it means the counters were never incremented — not ' +
        'that the provider was quiet.',
    );
  } else if (transport.retried === 0) {
    lines.push(
      '',
      `- **Nothing was throttled**: every one of the ${transport.calls} calls was served on its ` +
        'first attempt, so this run spent no wall clock waiting for a window to reopen.',
    );
  } else if (transport.rateLimited === 0) {
    lines.push(
      '',
      `- **Retries, but no rate limit**: ${transport.retried} of the ` +
        `${transport.attempts} requests were retried after a transport failure or a \`5xx\`. ` +
        'The provider was not throttling; the network or the server was.',
    );
  } else {
    lines.push(
      '',
      `- **The provider throttled**: ${transport.rateLimited} of the ${transport.attempts} ` +
        `requests were answered \`429\`, and ${transport.retriedCalls} of the ${transport.calls} ` +
        'calls went through the ladder at least once. The cost is wall clock, not tokens, and ' +
        'the next dispatch inherits it.',
      '',
      // Not "absorbed", and the difference is not pedantry. `retriedCalls` counts calls that
      // retried, and a call that retried eight times and was then **refused** is one of them --
      // run `41552258320` died on exactly such a call while this sentence read "the ladder
      // absorbed 55 of the 140 calls". On a completed artifact the two readings coincide; on a
      // failure record they do not, and the failure record is where the sentence is most read.
      `  What the ladder did with each of them is a property of how the call ended, and a call ` +
        'that retried and was then refused is counted here rather than in `refusedCalls`: the ' +
        'partition is disjoint by the retry rather than by the ending, which is why the ' +
        'refusal counter says "without a retry". A run that died therefore names its refusal ' +
        'on the error, not in this line.',
    );
  }
  if (transport.refusedCalls > 0) {
    // Its own reading, because it inverts the one above: `retried === 0` with a non-zero
    // refused count means "nothing was throttled" is FALSE -- something was answered "not now"
    // and the ladder did not chase it. The distinction is a tuning question versus an outage,
    // so it is named rather than left for the reader to infer from two fields.
    lines.push(
      '',
      `- **${transport.refusedCalls} calls were refused without a retry**: the provider answered ` +
        'with a retryable status and the ladder declined to ask again -- the budget was spent, a ' +
        '`Retry-After` named a window longer than the allowance, or the count ran out. This is a ' +
        'policy outcome, not an outage, and the numbers above cannot say which of the three it ' +
        'was: that reason travels on the error message.',
    );
  }
  if (transport.exhaustedCalls > 0) {
    // Not expected on a completed artifact: an exhausted call throws, which ends the pass
    // and writes a partial measurement instead. Saying so keeps a reader from reading the
    // number as "these calls were merely slow".
    lines.push(
      '',
      `- **${transport.exhaustedCalls} calls exhausted every attempt**: a call that reaches ` +
        'this state throws, so a completed artifact should report `0` here. A non-zero value ' +
        'means the counters span a failure that did not end the run.',
    );
  }
  return lines;
}

/**
 * Render a p-value that may have been through JSON.
 *
 * `runAblation` produces `NaN` for the over-run t-test when `runs < 2`, and
 * `-Infinity`/`Infinity` for Cohen's d when the two arms never disagree. JSON has
 * no representation for either, so `JSON.stringify` writes `null` — and the
 * archived artifact, which is the durable record of a run, holds `null` where the
 * live report held a number.
 *
 * `Number.isNaN(null)` is `false`, so the original `Number.isNaN(p) ? … :
 * p.toExponential(3)` guard routed `null` into the numeric branch and threw. The
 * report rendered correctly at the moment it was produced and became unrenderable
 * once archived, which is the worst possible ordering: the failure surfaces long
 * after the run, when the only remaining copy is the one that cannot be read.
 *
 * `null` is checked explicitly rather than with `p == null` matching both, because
 * `undefined` means a malformed object and `null` means "JSON had no number here";
 * both are unrenderable, so both take the fallback, but the reason is the same and
 * the check reads as one condition.
 */
function formatPValue(p: number | null, fallback: string): string {
  if (p === null || Number.isNaN(p)) {
    return fallback;
  }
  return p.toExponential(3);
}

/**
 * Format Cohen's d, including the infinities JSON cannot carry.
 *
 * A `null` here is a serialised infinity, which is a *real, meaningful* result —
 * it means the two arms differed on every question — so it must render as `n/a`
 * and never as `0.000`, which would read as "no effect" and invert the finding.
 */
function formatEffectSize(d: number | null): string {
  if (d === null) {
    return 'n/a';
  }
  if (d === Infinity) {
    return '+∞';
  }
  if (d === -Infinity) {
    return '-∞';
  }
  return d.toFixed(3);
}

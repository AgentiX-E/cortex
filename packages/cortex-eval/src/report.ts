/**
 * Scientific benchmark report: runs a baseline-vs-feature ablation and produces
 * a structured report plus a Markdown rendering for CI artifacts.
 */
import type { AblationResult, BenchmarkDataset, MemorySystem, Metrics } from './types.js';
import type { CohortCoverage } from './datasets/sampling.js';
import type { EvidenceReduction, QuestionRecord } from './question-record.js';
import { runAblation, type AblationOptions } from './ablation.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import { exactMatchScorer, type AnswerScorer } from './metrics.js';

export type AblationReport = {
  dataset: string;
  questionCount: number;
  baseline: { name: string; metrics: Metrics };
  feature: { name: string; metrics: Metrics };
  ablation: AblationResult;
  generatedAt: string;
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
   * The evidence budget in UTF-16 code units, or absent for the product default (24,000).
   *
   * Recorded because it is the one input that changes the room without changing any turn: §13.80
   * showed the room cannot be bought by truncating, so a run that raises the budget and a run that
   * lowers the cap are different experiments with the same coverage and different text.
   */
  readonly maxPromptChars?: number | undefined;
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
   * Whether the multi-session route's ranking was built from the question alone or from the
   * question plus model-written activity phrases (§13.97).
   *
   * Always present, `none` included, for the reason {@link MemoryArmConfig.reviewPass} is: an
   * artifact has to answer what the run did, and a field that is only present under treatment
   * makes "no expansion" and "an expansion that was not recorded" the same row.
   */
  readonly queryExpansion?: string | undefined;
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
        readonly provider: string;
        readonly model: string;
        readonly baseUrl: string;
        readonly thinking: 'enabled' | 'disabled';
        readonly temperature: number | null;
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
 */
function renderReader(reader: {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly thinking: 'enabled' | 'disabled';
  readonly temperature: number | null;
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
    `reader=${reader.provider}:${reader.model}@${host}` +
    `/thinking=${reader.thinking}` +
    `/temp=${reader.temperature === null ? 'default' : String(reader.temperature)}`
  );
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
    ...(options.featureConfig === undefined ? {} : { featureConfig: options.featureConfig }),
    ...(options.questions === undefined ? {} : { questions: options.questions }),
    ...(options.memoryArmConfig === undefined ? {} : { memoryArmConfig: options.memoryArmConfig }),
    ...(options.runs === undefined ? {} : { runs: options.runs }),
  };
}

export function formatAblationReport(report: AblationReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
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
        // product's 24,000 -- the value every archived run used.
        `, \`maxPromptChars=${memoryArm.maxPromptChars ?? 'default'}\`` +
        // The reach, rendered on every run beside the width and joined with `+` rather than a
        // comma: the line already separates fields with commas, so a comma inside a value would
        // make one field look like three.
        `, \`maxTurnCharsRoutes=${renderReach(memoryArm.maxTurnCharsRoutes)}\`` +
        // §13.83, rendered on every run for the reason the cap is: `all` is a fact about the
        // prompt (every turn was eligible) rather than the absence of one, and a reader comparing
        // two artifacts must be able to see which of them filtered.
        `, \`reviewPass=${memoryArm.reviewPass ?? 'none'}\`` +
        // §13.97, rendered on every run for the reason the pass is: `none` is a fact about the
        // run's retrieval (it used the bare question) rather than a missing field, and the two
        // artifacts this experiment compares differ only in this value.
        // §13.101, rendered on every run for the reason the pass is: `none` is a fact about the
        // run's consultations (one per question) rather than a missing field.
        `, \`selfConsistency=${memoryArm.selfConsistency ?? 'none'}\`` +
        `, \`queryExpansion=${memoryArm.queryExpansion ?? 'none'}\`` +
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
        (memoryArm.reader === undefined ? '' : `, \`${renderReader(memoryArm.reader)}\``),
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
    `| ${report.baseline.name} | ${pct(ab.baselineAggregate.min)} | ${pct(ab.baselineAggregate.avg)} | ${pct(ab.baselineAggregate.max)} | ${pct(ab.baselineAggregate.median)} |`,
    `| ${report.feature.name} | ${pct(ab.featureAggregate.min)} | ${pct(ab.featureAggregate.avg)} | ${pct(ab.featureAggregate.max)} | ${pct(ab.featureAggregate.median)} |`,
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
  lines.push(
    '',
    `- Overall accuracy (\`${report.feature.name}\`): ${pct(report.feature.metrics.accuracy)}`,
  );
  lines.push(
    `- Abstention rate (\`${report.feature.name}\`): ${pct(report.feature.metrics.abstentionRate)}`,
  );
  lines.push(
    `- Abstention correct rate (\`${report.feature.name}\`): ${pct(report.feature.metrics.abstentionCorrectRate)}`,
  );
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
  // The retry-fire table goes BELOW the results, unlike the cohort banner. The
  // ordering is deliberate and the two are opposite for a reason: the banner
  // qualifies what the numbers below it mean, so it must come first; the fire
  // table is supporting evidence for a null delta, and reads as a footnote to it.
  if (report.retryFires !== undefined) {
    lines.push(...retryFireLines(report.retryFires));
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

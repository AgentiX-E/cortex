/**
 * The cross-system arm: `cortex-memory` against the reference pipeline.
 *
 * ## What this module is, and what it deliberately is not
 *
 * `AUDIT-CODE-VS-DOCS.md` §6.2 step 3 asks for "a benchmark arm that supplies
 * `cortex-memory` instead of the reference pipeline", verified by a "paired
 * same-instant A/B against the reference arm". This module is the assembly half of
 * that arm. It is **not** the construction half.
 *
 * Every other arm in this package builds both of its own systems from options
 * (`runRerankAblation` is the template: two `NaturalLanguageMemorySystem`
 * instances, one carrying the feature flags). This arm cannot, because its two
 * sides live in different packages: the baseline is `cortex-eval`'s own reference
 * pipeline and the feature is `cortex-memory`'s `CortexMemory`. So the arm takes
 * **both systems already constructed** and owns only what happens next.
 *
 * ## Why the injection boundary is load-bearing rather than stylistic
 *
 * `cortex-eval` is the measurement instrument. Its `package.json` depends on
 * `cortex-core` and `cortex-ai` and on nothing in the product layer, and
 * `AUDIT-EVAL-CONTRACTS.md` §2 relies on that when it records the edge to
 * `cortex-memory` as "type-only ... and acyclic". Importing `CortexMemory` here to
 * build it inline would reverse that: the harness would depend on the thing it
 * measures, and a change to the product could not be evaluated without rebuilding
 * the instrument. The last test in the arm's suite asserts this boundary rather
 * than trusting it.
 *
 * The alternative considered was a new `cortex-bench` package depending on both,
 * which is architecturally cleaner and costs moving a 1051-line CLI plus a full
 * toolchain. Recorded in `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §4.
 *
 * ## Why the wiring cannot live in `bench/run.ts`
 *
 * `bench-arm-options.ts` already paid for this lesson and wrote it down: the CLI is
 * excluded from coverage as an entry point, so the spread carrying the B7 toggle
 * into the arm was, from the suite's point of view, unreachable code -- "deleting
 * it, defaulting it on, or reading the wrong environment variable each left every
 * test green -- because no test could import the file the line lived in."
 *
 * The wiring therefore lives here, in `src/**`, which is inside
 * `coverage.include`. What stays in the CLI is the part that has no decision in
 * it: construct two systems, hand them over, write the file.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  createUsageTally,
  llmUsage,
  resetRetryStats,
  retryStats,
  usageDelta,
  type UsageSnapshot,
  type UsageTally,
} from '@agentix-e/cortex-ai';

import { readToggle } from './env-toggle.js';
import type { RerankCensus } from './rerank-census.js';
import type { RerankBounds, RerankIdentity } from './rerank-factory.js';
import { promptDigest } from './prompt-digest.js';
import { ALL_TURN_CAP_ROUTES, PROMPT_ROOM_DEFAULT, TURN_CAP_ROUTES } from './turn-cap-routes.js';
import type {
  AblationReport,
  AbstentionReasons as ReportAbstentionReasons,
  AuditCensus,
  BareRetryCensus,
  ReplyRepairCensus,
  MemoryArmConfig,
  RecoveryCensus,
} from './report.js';
import {
  boundRetrievedContexts,
  buildQuestionRecords,
  evidenceReductionOf,
  goldOverlapOf,
  windowCompositionOf,
  type EvidenceBoundOptions,
  type QuestionRecord,
  type WindowComposition,
} from './question-record.js';
import {
  attachCostEfficiency,
  attachLlmUsage,
  attachTransport,
  attachUsageBySide,
  formatAblationReport,
  runAblationReport,
  type FeatureConfig,
} from './report.js';
import type { AblationPool } from './ablation.js';
import type { ReaderPacing } from './reader-transport.js';
import { transportRetryReport } from './retrieval-diagnostics.js';
import { traceUsage, type UsageSide } from './usage-by-side.js';
import { mirrorMembers } from './system-mirror.js';
import type { AnswerScorer } from './metrics.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import {
  deserializeEmbeddingCache,
  mergeEmbeddingCache,
  serializeEmbeddingCache,
  snapshotEmbeddingCache,
} from './retrieval.js';
import { DEFAULT_RELEVANCE_TOP_K } from './relevance-index.js';
import { resolveAnchorParameters } from './anchor-recall.js';
import { classifyTrFailure } from './tr-failure-class.js';
import type { EmbeddingProvenance } from './embedding-factory.js';
import type { AblationResult, BenchmarkDataset, GoldOverlap, MemorySystem } from './types.js';

/** The environment variables this arm reads. A subset of `process.env`. */
export type CortexMemoryArmEnv = Readonly<Record<string, string | undefined>>;

/**
 * The arm's parsed configuration.
 *
 * `enabled` is separate from the numeric knobs on purpose. An unset environment
 * means "this measurement was not requested", and a run that is not this arm must
 * not fail because an unrelated variable holds a typo. So the numeric guards run
 * only when the arm is on, and `enabled: false` carries defaults that are never
 * used.
 */
export type CortexMemoryArmOptions = {
  /** True only when `CORTEX_MEMORY` is the strict string `'1'`. */
  enabled: boolean;
  /** Admission threshold handed to `decideWrite`. In `[0, 1]`. */
  threshold: number;
  /**
   * Retrieval threshold handed to `decideRetrieval`. In `[0, 1]`.
   *
   * Read from its own variable because it answers a different question from
   * {@link threshold} and the arm's first measured run is the reason the
   * distinction exists. That run left `threshold` at `0` (keep everything, the
   * identity configuration) and there was no second knob, so the abstention path
   * had no gate either: every abstention was the model's wording, and the arm
   * scored 6.40% against the reference pipeline's 85.20%.
   *
   * Kept separate rather than derived, so a run can hold admission wide open and
   * still gate answering -- which is the configuration this arm now needs.
   */
  retrievalThreshold: number;
  /** Turn budget across all presented sessions. A positive integer, or unbounded. */
  sessionBudget: number;
  /**
   * Source trust stamped on every memory the composition layer admits. In `[0, 1]`.
   *
   * Defaults to `0.5`, which is what `admission.ts` hardcoded before the field
   * existed. It is a knob rather than a constant because the value function is
   * bounded by `confidence * sourceTrust * (0.5 + 0.5 * recency)`, so this number
   * sets the ceiling: at `0.5` the write gate's upper half is unreachable and
   * `retrievalThreshold` can only ever be always-open or always-closed. Run
   * `37110579101` scored what run `37094200823` did for exactly that reason.
   */
  sourceTrust: number;
  /**
   * Whether to supply per-turn confidence to admission, from the turn's length.
   *
   * A switch rather than a number because the value it selects is a *signal*, not
   * a knob: the arming is "variation supplied or not", and the signal itself lives
   * in the product layer (`cortex-memory/src/confidence.ts`) where it can be
   * tested. An arm that took the signal as a parameter would need a caller to
   * construct it, and the CLI is excluded from coverage -- which is the defect
   * `bench-arm-options.ts` was extracted to fix.
   *
   * It exists because §49 measured that raising `sourceTrust` makes the retrieval
   * gate *reachable* without making it *discriminating*: with all three value
   * factors pinned per turn, every admitted turn carries the same value, so no
   * interior `retrievalThreshold` separates a strong candidate from a weak one.
   * A registration that changed only the threshold would therefore repeat §10.10's
   * mistake in a new arming. See `docs/07-sota-roadmap.md` §4.1.10.
   *
   * Defaults to the empty string, i.e. off, so every prior run's configuration and
   * every prior artifact's meaning are unchanged.
   */
  confidenceSignal: string;
  /**
   * Whether this run grades **gold-only evidence** instead of the shipped corpus.
   *
   * `true` replaces every question's `context`/`sessions` with its gold sessions before the
   * arm is called (`oracle-evidence.ts`), which turns the run's accuracy into the reader's
   * ceiling rather than a system measurement: the difference between the ceiling and the
   * shipped score is what retrieval lost, and the difference between the ceiling and 100%
   * is what the reader lost. `Caura` publishes this decomposition (92.2% shipped, 94.6%
   * oracle) and `docs/MEASURE-READING-STAGE.md` §5.2 records that this project could not.
   *
   * It is a *measurement mode*, not a treatment: the product is untouched, both sides see
   * the same pool, and the artifact is marked at the top level (`dataset` gains
   * `'+oracle'`) so its number cannot be filed beside a shipped one.
   *
   * Absent means `false`, and the difference is the reason this one is optional while
   * `enabled` is not: every construction site that predates the field is a run that graded the
   * shipped corpus, which is exactly what absence says. `toMemoryArmConfig` writes the resolved
   * value on every run, so the artifact never has to express the default by omission.
   */
  oracleEvidence?: boolean | undefined;
  /**
   * The evidence rendering the **abstention route** uses. §12.5's single variable.
   *
   * §12.4 localised the arm's loss to what the feature side presents: `b✗f✓ = 0` on every
   * capability (not one question repaired) with abstention at 95.8% and every abstention
   * attributed to the model. §12.3 then measured that the gate cannot carry the arm. So
   * the surviving hypothesis is about presentation, and this is the knob that changes it
   * while every gate parameter stays exactly as dispatched.
   *
   * Defaults to the baseline contract, so every prior run's configuration and every prior
   * artifact's meaning are unchanged.
   */
  promptContract: string;
  /**
   * The instruction block the arm asks with. §13's single variable.
   *
   * A separate field from `promptContract` because §12.9 established they are separate
   * axes: a contract selects a rendering, an ask selects an instruction block. §12.10
   * retired the rendering hypothesis by measuring it, which leaves the ask as the
   * candidate §13 registers.
   *
   * Defaults to `route`, i.e. each route's own block, so every prior artifact keeps its
   * meaning.
   */
  ask: string;
  /**
   * Which second consultation the arm administers on the multi-session route (§13.94).
   *
   * `none` is the identity. `audit` doubles the consultations on that route, so it is named rather
   * than enabled.
   *
   * Optional, unlike {@link CortexMemoryArmOptions.ask}, because `none` is both the default and the
   * state every archive is in: a missing field cannot mean a treatment that was not administered.
   * `toMemoryArmConfig` normalises it so the artifact always states a value rather than leaving the
   * difference between "no pass" and "not recorded" to a reader.
   */
  reviewPass?: string | undefined;
  /**
   * Whether a decline that named nothing is asked once more without the abstention token being offered
   * (`CORTEX_MEMORY_REVIEW_BARE_DECLINE`).
   *
   * A boolean rather than a pass name because it is a treatment, not a mode: `true` adds at most one call per
   * question, and only on questions that already declined bare. Optional for the reason `reviewPass` is — absent
   * means the shipped behaviour, which is what every archived artifact was produced under.
   */
  reviewBareDecline?: boolean | undefined;
  /**
   * Which reply-contract repairs a run administers (`CORTEX_MEMORY_REPLY_REPAIR`, §13.334).
   *
   * A value rather than a boolean pair because the two kinds act on disjoint reply shapes, and a run has to be able
   * to administer one of them: the commitment repair prices the prose refusals, the shape repair the quotation dumps.
   * Optional for the reason `reviewPass` is -- absent means `off`, which is the shipped behaviour, and
   * `toMemoryArmConfig` normalises it so the artifact always states a value rather than leaving the difference
   * between "no repair" and "not recorded" to a reader.
   */
  replyRepair?: string | undefined;
  /**
   * Whether the multi-session route's relevance index is built from the question alone or
   * from the question plus model-written activity phrases (§13.97).
   *
   * ## What the variable changes, and what it cannot
   *
   * `llm` adds one model call per multi-session question **before** the relevance index is
   * built, and retrieves that question against `[question, ...phrases]`. Nothing else moves:
   * the phrases reach `RelevanceCase.queries` for MR questions only, so the four untouched
   * capabilities keep the exact queries, the exact ranking and therefore the exact window
   * they had in the prior run -- which is this dispatch's internal control.
   *
   * The phrases cannot be produced during answering. `CortexMemory`'s `relevanceFor` is a
   * synchronous table lookup built before the ablation, so a phrase written at answer time
   * would read the index's floor score and the treatment would be unmeasurable. That is why
   * the call sits here, beside the index construction, rather than in the product.
   *
   * Optional, and `none` is the identity: every archived artifact was produced without it, so
   * a missing field cannot mean a treatment that was not administered. `toMemoryArmConfig`
   * normalises it so the artifact always states a value.
   *
   * ## `window` reaches a different route, and that is not a widening of `llm`
   *
   * `llm` writes phrases for the **multi-session** question and can only move the ranking that route
   * builds before answering. `window` reorders the **delivered** set inside `buildPrompt`, and it is
   * administered only on the questions the harness gives a reference date -- on this roster that is
   * the temporal route, whose capability is TR (§13.152.3, §13.153.3). Written down because a reader
   * comparing the two artifacts would otherwise take the different populations for a different
   * mechanism's effect, and because a run may not administer both: `#orderingFor` would resolve a
   * window for a question whose ranking `llm` had already rewritten, and the two would then be one
   * reading of two stages.
   */
  queryExpansion?: string | undefined;
  /**
   * How many times the multi-session route consults the model on one prompt (§13.101).
   *
   * `none` is one consultation, which is the shipped behaviour and the state every archived run is
   * in. `3` samples the judgement §13.100.2 measured moving on 24 of 121 answers and returns a strict
   * majority.
   *
   * A string rather than a number at this layer because the artifact's configuration line is a
   * string table and the two values are named: `none` has to be sayable, or "ran the control" and
   * "predates the field" become the same bytes. The product takes a number (`selfConsistency`), and
   * `run-ablation.ts` converts at the boundary.
   */
  selfConsistency?: string | undefined;
  /**
   * How many turns of evidence each roster record carries. `§13.12`'s bound.
   *
   * ## Why this is an option rather than a constant in the entry point
   *
   * It started as a constant in `bench/run-ablation.ts`, and that is the defect
   * `bench-arm-options.ts` was extracted to fix: `bench/**` is excluded from
   * coverage, so a decision written there is a decision no test can reach. Worse,
   * the pre-registration guard (`tools/__tests__/test_preregistration_config.py`)
   * compares the dispatch against `§10.3` by parsing the environment the runner is
   * given -- and a value baked into the entry point never appears in that
   * environment, so the guard could not see it and no artifact could show that the
   * registered bound was the applied one.
   *
   * ## Why the bound exists
   *
   * Run `38003036421` completed all four runs of all five hundred questions and
   * then died writing the JSON with `RangeError: Invalid string length`. The memory
   * arm carries the evidence unbounded -- `admission.ts` declines to truncate, and
   * this arm runs at `sessionBudget: unbounded` -- and carries it **twice**, once
   * in `ablation.featureRetrievedContexts` and once as `questions[].turns[].text`.
   *
   * `evidenceTurns` and `evidenceChars` are **never** reduced, so the measurement
   * `§13.11.3` reads survives any bound; only the carried text is bounded.
   *
   * Defaults to `Number.POSITIVE_INFINITY`, i.e. carry everything, so every prior
   * run's behaviour is unchanged and a caller must opt into a bound.
   */
  evidenceTurnsPerRecord: number;
  /**
   * Whether the prompt budget is spent on retrieval-ranked turns, and by what.
   *
   * §13.16's single remaining variable. Run `38142407062` established that the
   * feature side's loss is not the size of the budget: the prompt carried 4.69% of a
   * 506,338-character mean context (`§13.13`) and the gold turn sat inside what the
   * model read for 11.6% of questions, against a ceiling of 92.1% -- the share of
   * questions whose answer turn is in the bundle at all
   * (`MEASURE-B2-RECALL-CURVE.md`). Everything else about the budget has been
   * measured; whether the turns it spends on are the turns that matter has not.
   *
   * A signal *name* rather than a callback, for the reason `confidenceSignal` gives:
   * the arming is "ranked or not", the callback itself lives in
   * `cortex-eval/src/relevance-index.ts` where it can be tested, and the CLI is
   * excluded from coverage -- so an option taking a function would move the signal
   * into the one file no test can reach. `bench-arm-options.ts` records that
   * defect.
   *
   * Defaults to `none`, i.e. the arrival-order prefix every prior run used, so every
   * prior artifact's meaning is unchanged.
   */
  relevanceSignal: string;
  /**
   * How many turns per question the relevance index scores.
   *
   * Paired with `relevanceSignal` rather than folded into it, because the two are
   * different claims: the name says a ranking was applied, and this says how much of
   * the context the ranking could speak about. `MEASURE-B2-RECALL-CURVE.md` measured
   * `recall = 0.921` at `k = 50` with a flattened curve, so a width at or above that
   * knee is what makes the ranking complete rather than partial -- and a run reported
   * only by name would make a width of `8` and a width of `64` look like one
   * experiment.
   *
   * Defaults to the index's own default, so the CLI does not carry a second copy of
   * the number.
   */
  relevanceTopK: number;
  /**
   * The unit the evidence room is spent in: `turn` or `session`.
   *
   * ## Why this is a third field rather than a second `relevanceSignal` value
   *
   * The signal says **how a turn is scored**; the unit says **what a score buys**. They
   * are different claims about one budget and the experiment needs them to move
   * independently, so §13.27 holds the signal at `retrieval` and moves only this. A unit
   * folded into the signal's name would make a run that changed only the unit
   * indistinguishable, in its own configuration line, from one that changed the scoring.
   *
   * ## Why the name says "relevance" and not "evidence"
   *
   * The unit only has a meaning where the budget is spent by a ranking. With
   * `relevanceSignal: none` the budget buys the arrival-order prefix and there is no
   * ranking for a unit to act on, so the two names must stay adjacent -- a reader who saw
   * `relevanceUnits=session` beside `relevanceSignal=none` would be reading a unit that
   * nothing consumed.
   *
   * Defaults to `turn`, i.e. the behaviour every prior artifact was produced under, so
   * every archived run stays reproducible from the code.
   */
  relevanceUnits: string;
  /**
   * The three parameters anchor restoration ran with, when the signal was `retrieval-anchored`.
   *
   * ## Why these numbers are on the record rather than implied by the signal's name
   *
   * `retrieval-anchored` names a **family of pools**, not one pool. The campaign has already run two
   * points on its decay axis: the first widened each question's pool by its anchors' session
   * neighbourhoods and lost eight MR questions to displacement -- restored turns carried half their
   * anchor's score and outranked hits the retriever had placed far above that anchor (§13.257) -- so
   * the second one steepened the decay. Both dispatches publish `relevanceSignal=retrieval-anchored`,
   * and without this field their artifacts are the same bytes on the one axis that differed.
   *
   * ## Why it is resolved here rather than read from the environment
   *
   * `anchor-recall.ts` owns the three numbers, for the reason it owns the stopping rule: they were
   * chosen against a registered gate rather than tuned per dispatch, and an environment variable
   * would let a dispatch move a parameter the gates were written against without moving a name. The
   * projection is therefore derived from the module's own resolver, so the artifact and the pool
   * cannot disagree -- and a reader comparing two artifacts can see, without the source, which point
   * of the axis produced which number.
   *
   * Absent for every signal other than `retrieval-anchored`, because restoration is the only
   * mechanism whose parameters this field describes. That absence is readable against
   * `relevanceSignal`, which is always present: a signal that names the mechanism beside an absent
   * `anchors` is an artifact written before the field existed, and any other signal is a run that
   * administered no restoration at all. A zeroed object would instead be a third reading -- a
   * mechanism that fired with every parameter zero -- which no dispatch can mean.
   */
  anchors?: { readonly count: number; readonly radius: number; readonly decay: number } | undefined;
  /**
   * Upper bound on the characters one turn may contribute to the prompt, or absent for none.
   *
   * ## Why this is a `number | undefined` rather than a number with a sentinel
   *
   * `Infinity` would be the natural "no cap" and it is wrong here for the reason
   * `sessionBudget` gives: it would make the field always present, and §13.67's whole claim
   * is that archived runs carried **no cap at all**. An absent field says that; an infinite
   * one says "capped at infinity", which is a configuration nobody chose and which would
   * make the artifact's config line claim a treatment on every prior run.
   *
   * ## Where it reaches
   *
   * `CortexMemoryOptions.maxTurnChars` and from there the renderer, so it applies on every
   * route including the multi-session one. It is presentation only: `lastRetrievedContext`,
   * the roster and every coverage count describe the turns as they arrived, because a
   * record that described the capped text would report a prompt the model never read with a
   * number that looks like a coverage measurement.
   */
  maxTurnChars?: number | undefined;
  /**
   * Which routes the per-turn cap reaches. Every route when the run names none.
   *
   * Present rather than folded into `maxTurnChars`, because §13.72's result is that the width and
   * the reach are different claims about the same cap and this experiment moves only the second.
   * An empty list is a reach of nothing -- a run that configures a cap it does not apply -- and is
   * kept distinct from absent so the config line can tell a reader which of the two it was.
   */
  maxTurnCharsRoutes?: readonly string[] | undefined;
  /**
   * Whether a turn the cap cut says so: `'none'` (the default, and every archived run) or
   * `'ellipsis'`.
   *
   * §13.187's finding, registered as §13.187.6D. One of the five durable MR declines --
   * `a4996e51` -- is not a retrieval miss: the turn that answers it was **delivered and cut
   * mid-sentence** by `maxTurnChars`, and the contract tells the reader to decline when an
   * operand is missing. The reader was right and the prompt was wrong, so the treatment is a
   * mark of omission at the cut rather than a different retrieval.
   *
   * A `string` rather than the product's union, for the reason `promptContract` and `ask` are:
   * `cortex-memory` is imported type-only here for the acyclicity rule, and the value is
   * validated against `TURN_CUT_MARKERS` at parse time, so the cast at the boundary in
   * `bench/run-ablation.ts` states a checked fact rather than widening an option.
   *
   * Carried beside `maxTurnChars` and refused without it, because the marker describes a cut:
   * a run that named the marker and no cap would publish `turnCutMarker=ellipsis` over a prompt
   * that never cut anything, which is the §7.4 defect the guards in this file exist to prevent.
   */
  turnCutMarker?: string | undefined;
  /**
   * The evidence budget in UTF-16 code units, or absent for the product default.
   *
   * What the default *is* has moved (24,000 before §13.82, 48,000 after), which is why an absent
   * field is no longer the whole statement: `effectivePromptChars` on the artifact records the room
   * every route assembled under, so a reader never has to resolve the default at the time of the
   * run from a constant that has since changed.
   *
   * A separate axis from `maxTurnChars`, and the pair is what §13.80 separated: the cap decides how
   * much of one turn is shown, the budget decides how many turns fit. Lowering the cap buys room by
   * destroying text; raising the budget buys room by spending tokens — and only the second has no
   * measured floor.
   */
  maxPromptChars?: number | undefined;
  /**
   * The evidence budget per route, overriding {@link maxPromptChars} for the routes it names.
   *
   * A room is not a depth: at 48,000 characters `41546569106` delivered 61 turns on `flat` (723
   * characters each) and 179 on `temporal` (205 each), so one number is five different amounts of
   * ranking paid for. Coverage -- the share of in-pool gold inside the delivered depth, recomputed
   * from that artifact's own `goldOverlap.goldRanks` -- runs 84.2% to 93.6% across the five routes
   * for the same reason. §13.239 registers the redistribution this field makes expressible.
   *
   * A plain record rather than a typed one, for the reason `maxTurnCharsRoutes` is a `string[]`:
   * `cortex-memory` is imported type-only here under the acyclicity rule, so the route names are
   * validated against this module's own copy at parse time and the cast at the boundary in
   * `bench/run-ablation.ts` states a checked fact.
   */
  maxPromptCharsByRoute?: Readonly<Record<string, number>> | undefined;
  /**
   * The turn roles the evidence may be built from, or absent for every role.
   *
   * §13.82's measurement, not a hypothesis: 51.9% of the multi-session route's rendered room is
   * assistant turns, while the reference pipeline reaches 85.95% on that capability at half the
   * budget by reading user turns only. `['user']` is the treatment §13.83 registers.
   *
   * Absent rather than an all-roles list, for the reason `maxTurnChars` is absent rather than
   * infinite: every archived run is the absent state, and a present list would make the config
   * line claim a filter on runs that had none.
   */
  evidenceRoles?: readonly string[] | undefined;
  /**
   * Which routes the role filter reaches. Every route when the run names none.
   *
   * Projected even when {@link CortexMemoryArmOptions.evidenceRoles} is absent, so the artifact
   * always answers what the filter *would* have reached.
   */
  evidenceRolesRoutes?: readonly string[] | undefined;
};

/** The signal names `CORTEX_MEMORY_CONFIDENCE` accepts, and what each supplies. */
const CONFIDENCE_SIGNALS = {
  /** No callback: `confidence` stays at `createMemory`'s `1`. The pre-§50 behaviour. */
  none: 'none',
  /** `min(1, turn.length / 2000)`, the only model-free signal this round ships. */
  length: 'length',
} as const;

/** The signal a run gets when it does not name one. */
const DEFAULT_CONFIDENCE_SIGNAL = CONFIDENCE_SIGNALS.none;

/**
 * The relevance signals `CORTEX_MEMORY_RELEVANCE` accepts, and what each supplies.
 *
 * `none` is the arrival-order prefix and `retrieval` is `buildRetrievalRelevanceIndex`
 * over the arm's own embedding backend. Both are names, not functions, for the layering
 * reason `CortexMemoryArmOptions.relevanceSignal` records.
 */
const RELEVANCE_SIGNALS = {
  /** No callback: the budget buys the first turns that arrived. The pre-§13.17 behaviour. */
  none: 'none',
  /** Cosine against the question, from the same bi-encoder the reference pipeline uses. */
  retrieval: 'retrieval',
  /**
   * Dense cosine fused with a rare-keyword channel, by reciprocal rank.
   *
   * ## Why this is a second value and not an edit to `retrieval`
   *
   * §13.62's partition put the loss where it had not been located before: across MR's 3663
   * gold turns, **1026 were never surfaced by the ranker** and 903 were surfaced and cut by
   * the budget, and the same ordering holds for all five capabilities. So the pool's reach
   * is the larger constraint, and `k = 256` failing to raise coverage (§13.54) says the
   * missing turns are not merely just below the cut -- they score far below it.
   *
   * `retrieveTopKByQueriesHybrid` already exists in `retrieval.ts`: it adds the turns
   * carrying a rare keyword from the question and fuses the two rankings by reciprocal
   * rank, so a turn that is BOTH lexically identifying and semantically close outranks one
   * with a single signal. It was written for the reference pipeline's own recall curve and
   * has never been the arm's ranking.
   *
   * Editing `retrieval`'s meaning instead would make every archived artifact ambiguous
   * about which mechanism produced it, which is the rule `RELEVANCE_UNITS` states for
   * `session`: a value whose meaning changed between two runs makes both unreadable.
   */
  'retrieval-hybrid': 'retrieval-hybrid',
  /**
   * Each **session** scored as one unit, projected onto its turns.
   *
   * ## Why this is a signal and not a fourth `relevanceUnits` value
   *
   * `session` in `RELEVANCE_UNITS` ranks *turns* and then takes the largest prefix of whole sessions
   * that fits; run `39699987781` measured it losing 11 questions to the turn unit. What the
   * reference pipeline does is different — one embedding per session, top-k sessions — and no value
   * of the unit could express it, because the unit decides what the budget buys while this decides
   * what the ranking is over.
   *
   * Pair it with `relevanceUnits=session`: a score constant inside a session makes the unit's own
   * "rank by best-scoring turn" rule rank by session, which is the point. On `turn` units the
   * constant score degenerates to arrival order, so the two are meant to travel together and the
   * registration fixes both.
   */
  'retrieval-session': 'retrieval-session',
  /**
   * `retrieval-hybrid`, then its pool widened by each anchor's session neighbourhood.
   *
   * ## Why this is a signal and not a wider `topK`
   *
   * §13.54 already spent the width: `k = 256` did not raise coverage, because the missing turns
   * are not below the cut -- they are far below it. §13.255.2 then located the population exactly:
   * for **145** of 500 questions the gold turn that never arrived is one the ranking never
   * surfaced, and §13.254.3 showed not one of MR's missing questions is room-limited. A count asks
   * for the **property** ("how many", "in total") while its evidence states the **items**, so the
   * members of the set score far under a cut no width can reach.
   *
   * So the pool is widened by *construction* instead: a few anchors chosen by question coverage and
   * lexical novelty, then each anchor's own session neighbourhood restored verbatim
   * (`anchor-recall.ts`, after Chain on Demand, arXiv:2611.02480). Both §13.254.5 gates are
   * structural rather than promised: **0** added model calls, and **0** added prompt characters --
   * restoration changes which turns the ordering knows, not how much room the reader gets.
   *
   * ## Why the name carries it rather than a flag
   *
   * The artifact's `relevanceSignal` is the only place a reader can see which operation produced a
   * pool, and `relevanceTopK` cannot express "the pool was widened after retrieval". A boolean
   * beside `retrieval-hybrid` would make two runs comparable only if a reader also compared the
   * flag, which is the shape of the defects §13.63 and §13.27 both fixed by naming the mechanism.
   */
  'retrieval-anchored': 'retrieval-anchored',
} as const;

/** The signal a run gets when it does not name one. */
const DEFAULT_RELEVANCE_SIGNAL = RELEVANCE_SIGNALS.none;

/**
 * The units `CORTEX_MEMORY_RELEVANCE_UNITS` accepts, and what each supplies.
 *
 * Separate from `RELEVANCE_SIGNALS` rather than a second value of it, for the reason
 * `CortexMemoryArmOptions.relevanceUnits` records: the signal says how a turn is scored
 * and this says what a score buys.
 *
 * `session` and `session-fill` are read by the multi-session route alone. `buildPrompt` is
 * handed no session boundary, so a selection in sessions cannot be expressed on flat,
 * temporal, knowledge-update, abstention or assistant -- which is what makes each dispatch
 * a single-variable one rather than a claim about five routes at once.
 *
 * `session` is **frozen**: it is the rule run `38753835652` measured, it lost, and it stays
 * reachable so that reading is reproducible from the code that produced it. §13.31's repair
 * is a third value rather than an edit to this one, for exactly that reason -- a value whose
 * meaning changed between two archived runs would make both artifacts ambiguous.
 */
const RELEVANCE_UNITS = {
  /** The budget buys individual turns wherever they score highest. The pre-§13.27 behaviour. */
  turn: 'turn',
  /** The budget buys whole sessions, ordered by their best-scoring turn, on the prefix rule. */
  session: 'session',
  /** The same, skipping a session that does not fit instead of ending the pass on it. */
  'session-fill': 'session-fill',
  /**
   * The budget buys an anchor and its same-session neighbourhood, `±2` turns on each side.
   *
   * §13.286. Distinct from `retrieval-anchored`, which also restores neighbourhoods, and the
   * difference is where they land: that signal puts restored turns **into the pool**, where they
   * compete on a decayed fraction of their anchor's score and displace hits the retriever ranked
   * above them (§13.257 lost eight MR questions that way). Here the neighbourhood is bought
   * **with** the anchor, indivisibly, so the neighbours are never ranked and cannot displace
   * anything -- which is the whole point, because §13.283 measured that the MR turns still
   * missing carry `goldRanks = -1`: they were never ranked to begin with.
   *
   * The radius is not an input, deliberately. It is the reference implementation's frozen
   * `expand window ±2` (`cod/expand.py`), the workflow is at its dispatch-input ceiling, and a
   * radius axis would be a second variable in a dispatch whose value is that it has one.
   */
  'anchor-window': 'anchor-window',
} as const;

/** The unit a run gets when it does not name one. */
const DEFAULT_RELEVANCE_UNITS = RELEVANCE_UNITS.turn;

const THRESHOLD_VARIABLE = 'CORTEX_MEMORY_THRESHOLD';
const RETRIEVAL_THRESHOLD_VARIABLE = 'CORTEX_MEMORY_RETRIEVAL_THRESHOLD';
const BUDGET_VARIABLE = 'CORTEX_MEMORY_SESSION_BUDGET';
const SOURCE_TRUST_VARIABLE = 'CORTEX_MEMORY_SOURCE_TRUST';
const CONFIDENCE_VARIABLE = 'CORTEX_MEMORY_CONFIDENCE';
/**
 * The variable naming the **evidence source** for this run: the shipped corpus, or the
 * gold sessions alone (`oracle-evidence.ts`).
 *
 * Not a treatment and therefore not an arm input in the usual sense: it changes what the
 * reader is handed, not what the product does with it, and its number is a *ceiling* rather
 * than an accuracy. It is read here anyway, with the other arm options, because every layer
 * that would otherwise have to carry it -- the dispatch script, the workflow, the artifact --
 * already carries this block, and a switch read at the bench entry point could not be seen
 * by the pre-registration guard.
 */
const ORACLE_EVIDENCE_VARIABLE = 'CORTEX_MEMORY_ORACLE';
/**
 * The variable naming how many turns of evidence each record carries.
 *
 * `§13.12`'s bound. It is an environment variable rather than a constant in the
 * entry point because the pre-registration guard compares the DISPATCH against
 * `§10.3`, and a value that never reaches the environment is a value the guard
 * cannot see -- so a run could apply a bound the registration does not name and
 * no artifact would show it. See `CortexMemoryArmOptions.evidenceTurnsPerRecord`.
 */
const EVIDENCE_BOUND_VARIABLE = 'CORTEX_MEMORY_EVIDENCE_TURNS';
/**
 * The variable naming the §12.5 evidence-rendering experiment.
 *
 * Separate from `CONFIDENCE_VARIABLE` because the two answer different questions about
 * different layers: confidence is an *admission* input (which turns survive the value
 * gate) and the contract is a *presentation* input (what the surviving turns look like
 * to the model). A run that moved both would confound §12.5 with §11's registration.
 */
const PROMPT_CONTRACT_VARIABLE = 'CORTEX_MEMORY_PROMPT_CONTRACT';

/** Names the instruction block the arm asks with (§13). */
const ASK_VARIABLE = 'CORTEX_MEMORY_ASK';

/**
 * Names the relevance signal the prompt budget is spent under (§13.16).
 *
 * Its own variable rather than a reuse of `CORTEX_MEMORY_CONFIDENCE`, because the two
 * move different decisions: confidence is an **admission** input (which turns survive
 * the value gate) and this is a **selection** input (which admitted turns the budget
 * buys). `cortex-memory/src/types.ts` states the same boundary from the product side --
 * a signal that moved admissions would put two variables in a run whose whole value is
 * that it has one.
 */
const RELEVANCE_VARIABLE = 'CORTEX_MEMORY_RELEVANCE';

/**
 * Names the unit the relevance budget is spent in (§13.27).
 *
 * Its own variable rather than a second value of `CORTEX_MEMORY_RELEVANCE`, because the
 * artifact's configuration line has to be able to say which of the two moved. A run that
 * changed only the unit and one that changed only the scoring would otherwise publish the
 * same key with the same value, and the two are different experiments.
 */
const RELEVANCE_UNITS_VARIABLE = 'CORTEX_MEMORY_RELEVANCE_UNITS';

/**
 * Names how many turns per question the relevance index scores.
 *
 * Separate from the signal for the reason the signal is separate from confidence: the
 * name and the width are different claims, and a run that moved both would report a
 * ranking whose extent is unknown.
 */
const RELEVANCE_TOP_K_VARIABLE = 'CORTEX_MEMORY_RELEVANCE_TOP_K';

/**
 * The per-turn character cap: how much of one turn the prompt may show.
 *
 * §13.67 registered it from a measurement rather than from a hypothesis. §13.34.3 argued the
 * evidence room is not the constraint, on **counts** -- a median of 26 turns in the window
 * against a median gold set of 24 -- and `--turns` on the adopted run's artifact showed the
 * other half: the delivered turns have a **median of 272 characters** with a p90 of 2,305,
 * so 26 of them are 7,072 characters in a 24,000-character room. The room is spent on a
 * tail, which is why the cut that decides coverage falls at rank 26 while the pool holds 64.
 *
 * Separate from every other variable on this arm because it is the only one that changes
 * **how much of a turn** fits rather than **which turns** are chosen: the ranking, the unit,
 * the pool width and the gate all stay where §13.27-§13.66 put them.
 */
const MAX_TURN_CHARS_VARIABLE = 'CORTEX_MEMORY_MAX_TURN_CHARS';

/**
 * The evidence budget in UTF-16 code units: how many characters one prompt may hold.
 *
 * ## Why this input did not exist until §13.81
 *
 * `DEFAULT_MAX_PROMPT_CHARS` was 24,000 and every run before §13.82 used it, so every experiment up
 * to then traded truncation against room **inside** that budget. §13.213 has since raised the
 * constant to 48,000 -- the budget this variable's every published run already passed -- so the
 * sentence above is history rather than a description of the default. §13.80 found the trade's floor: at
 * a 200-character cap the room reached 100 turns and MR fell to 29 of 121, because a 223-character
 * mean turn is a fragment and the model declines from fragments. The only way past the floor is to
 * raise the budget, and until this variable existed the arm could not express that.
 *
 * **"Every run used it" stopped being true when this variable was added**, and the sentence stayed
 * in this comment for long enough that it misdescribed the archive: of the seventeen artifacts on
 * disk, ten ran at 48,000, six at 96,000 and one at the default. Absent still means the product
 * default — and the default is now the exception rather than the rule, which is why the resolved
 * room is written down per route as `effectivePromptChars` instead of being left to this field's
 * absence. The gap between the default and the dispatched widths is the subject of
 * `AUDIT-BENCHMARK-WALLCLOCK.md` §7.
 */
const MAX_PROMPT_CHARS_VARIABLE = 'CORTEX_MEMORY_MAX_PROMPT_CHARS';

/**
 * What the cap's value may also say: whether the cut it makes is visible.
 *
 * ## Why this rides on the cap's value instead of an input of its own
 *
 * The workflow sits one input below GitHub's 25-input ceiling and the suite **forbids** sitting
 * at the ceiling, so the campaign's rule for a new knob is a new **value** -- the same rule that
 * put `bare` and `recover` on `cortex_memory_review_pass`. This is the rare case where the
 * carrier is also the truer shape: a marker without a cap cannot mark anything, so the grammar
 * makes the impossible combination unexpressible rather than guarding against it at runtime.
 *
 * ## The grammar
 *
 *   `<width>`            -- cap at `<width>`, silent cut: the historical rendering
 *   `<width>:<marker>`   -- cap at `<width>`, the cut says so; `<marker>` is `none` or `ellipsis`
 *   `none`, or blank     -- no cap at all, which is what every archived run was produced under
 *
 * The width is still parsed by the same guard with the same message, so a dispatch that names
 * `0` or `1.5` is refused for the reason it always was. A malformed marker is refused rather
 * than ignored: a run dispatched to mark its cuts that rendered them silently would publish an
 * unchanged number reading as evidence that the mark does not matter, and only its own config
 * line would show the difference.
 *
 * The artifact records the two halves as **separate fields** (`maxTurnChars`, `turnCutMarker`),
 * so the compound syntax exists only at the dispatch boundary -- which is the only layer that has
 * a ceiling -- and no reader of an artifact has to parse it back apart.
 */
/**
 * Which routes the per-turn cap reaches: `all`, `none`, or a comma-separated list of route names.
 *
 * §13.72 measured one cap over every route and got `+13` on MR and `−30` on IE in the same run, so
 * the reach is a separate dispatched value rather than a wider default or a different width. The
 * accepted names are `TURN_CAP_ROUTES` below, which is this package's copy of the product's
 * vocabulary -- the dependency runs the other way, so the names are declared twice and
 * `tools/__tests__/test_ask_table_parity.py` asserts the two copies agree.
 */
const MAX_TURN_CHARS_ROUTES_VARIABLE = 'CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES';

/**
 * The marker names the cap's value may carry, and this module's copy of the product's
 * `TurnCutMarker`.
 *
 * Declared twice for the reason `TURN_CAP_ROUTES` is -- the dependency runs the other way, so
 * `cortex-eval` cannot import the product's union -- and the parity test in `tools/__tests__`
 * asserts the two copies agree on the names they accept.
 */
const TURN_CUT_MARKERS: Record<string, true> = { none: true, ellipsis: true };

/** The marker a run gets when it does not name one: the historical rendering, byte for byte. */
const DEFAULT_TURN_CUT_MARKER = 'none';

/**
 * Which turn roles the evidence may be built from: `all` (the identity), or a comma-separated
 * list drawn from the roles this dataset's haystack can carry.
 *
 * §13.82 measured the composition of the 48,000-character room and found **51.9% of the
 * multi-session route's rendered characters are assistant turns**, against a reference pipeline
 * that reaches 85.95% on the same capability at half the budget by restricting retrieval to user
 * turns. §13.83 registers this as the variable.
 *
 * `all` rather than `none` for the identity, because the product refuses an empty role list: an
 * empty list admits nothing and would spend a decline per question, so "no filter" has to be
 * expressible and it is expressed by naming no roles.
 */
const EVIDENCE_ROLES_VARIABLE = 'CORTEX_MEMORY_EVIDENCE_ROLES';

/**
 * Which routes the role filter reaches: `all`, `none`, or a comma-separated list of route names.
 *
 * Scoped from the start for §13.73's two reasons: a global filter moves three capabilities that
 * are not part of the experiment (75.8-77.3% of *their* rendered characters are assistant
 * turns), and the untouched routes are the experiment's own control.
 */
const EVIDENCE_ROLES_ROUTES_VARIABLE = 'CORTEX_MEMORY_EVIDENCE_ROLES_ROUTES';

/**
 * The roles a haystack turn can carry, in the order the config line spells them.
 *
 * The vocabulary is this dataset's, and it is closed here rather than open, because a run that
 * named a role the classifier can never return would filter out every parsed turn -- a run that
 * declines on almost every question while its artifact records a filter rather than a defect.
 */
const EVIDENCE_ROLE_ORDER: readonly string[] = ['user', 'assistant'];

/** The same vocabulary as a membership test, so validation and lookup are one operation. */
const EVIDENCE_ROLES: Record<string, true> = { user: true, assistant: true };

/**
 * The role a haystack turn carries, read from the prefix this dataset's rendering uses.
 *
 * `[2023/02/15 (Wed) 03:14] user: ...` is the shape, and it is **this package's** knowledge:
 * `cortex-memory` takes a classifier rather than parsing a format, so that the product's
 * behaviour is not a fact about one dataset. `undefined` means this turn's role could not be
 * read, and the product keeps such a turn -- a classifier failure must not empty the evidence.
 *
 * Anchored at the start with a non-empty bracketed prefix, so a turn that merely *mentions*
 * `assistant:` later in its text is not mislabelled, and so `[] user:` (an empty prefix) is not
 * read as a timestamp.
 */
export function roleOfTurn(turn: string): string | undefined {
  const match = EVIDENCE_ROLE_PREFIX.exec(turn);
  return match?.[1]?.toLowerCase();
}

/**
 * The route whose reach decides whether a question's gold is role-filtered.
 *
 * ## Why this table exists, and why it is in this package
 *
 * The filter's reach is expressed in routes, so the gold denominator has to know which route a
 * question answers on. That routing is `benchmark.ts`'s (`MR` to `answerSessions`, `TR` to
 * `answerTemporal`, `ABS` to `answerAbstention`, `KU` to `answerKnowledgeUpdate`, everything
 * else to `answer`), and duplicating it anywhere but here would be a second place for it to
 * drift. It lives in the same package as the dispatch so a test can read both.
 *
 * ## The one row that is approximate, stated
 *
 * `IE` covers `single-session-user`, `single-session-assistant` and `single-session-preference`,
 * which dispatch to three different methods. The table answers `flat`, which is exact for the
 * registered reach (`multi-session,temporal` — none of IE's routes) and would be wrong only for
 * a reach that named `assistant` or `preference` without naming `flat`. That is written down
 * rather than guarded because a guard would have to re-derive `questionType` routing here, which
 * is the duplication this table exists to avoid.
 *
 * ## Why it is exported
 *
 * A reading tool outside this package needs the same table to name a population by **route**
 * rather than by capability. `tools/recovery-reach.mjs` reads the abstention-recovery pass's
 * population, and that pass is wired into one route -- so a tool that hard-coded `MR` would be a
 * second copy of this switch, which is exactly what the paragraph above refuses. Exporting the
 * table is the alternative to duplicating it.
 */
export function evidenceRouteOf(capability: string): string {
  switch (capability) {
    case 'MR':
      return 'multi-session';
    case 'TR':
      return 'temporal';
    case 'ABS':
      return 'abstention';
    case 'KU':
      return 'knowledge-update';
    default:
      return 'flat';
  }
}

/**
 * The gold turns a question's policy admits, or every gold turn when no filter reaches it.
 *
 * ## Why the denominator, and not the numerator, is what moves
 *
 * `carried` counts delivered turns, and a filtered run can only deliver admitted roles. Comparing
 * it against a dataset total that includes excluded roles bounds the ratio by the policy rather
 * than by the room: §13.84 read MR at 48.35% on a window that had just grown by twenty turns.
 * The gold the policy admits is the largest set the record could ever carry, so it is the honest
 * denominator; the dataset's own count stays on the record as `totalAll`.
 *
 * An unreadable role is **kept**, for the reason the filter itself keeps it: a classifier failure
 * must not shrink a denominator.
 */
function eligibleGoldOf(
  goldTurns: readonly string[] | undefined,
  roles: readonly string[] | undefined,
  reach: readonly string[] | undefined,
  capability: string,
): readonly string[] | undefined {
  if (goldTurns === undefined || roles === undefined) return goldTurns;
  if (reach !== undefined && !reach.includes(evidenceRouteOf(capability))) return goldTurns;
  return goldTurns.filter((gold) => {
    const role = roleOfTurn(gold);
    return role === undefined || roles.includes(role);
  });
}

/** The prefix `roleOfTurn` reads. Exported nowhere: the shape is stated by the function. */
const EVIDENCE_ROLE_PREFIX = /^\[[^\]]+\]\s*(user|assistant)\s*:/i;

/**
 * The route names a reach may name, and the arm's own copy of the product's `TURN_CAP_ROUTES`.
 *
 * It is imported rather than declared here as of §13.197.4: the route-scoped `thinking` value gives
 * the table a second reader in `llm-factory`, and two copies in one package would be the drift the
 * copy exists to prevent. Both names are imported above and used below (`readRouteReach` validates
 * against the table, the parsers default to every route); neither is re-exported, because nothing
 * outside this module ever read them.
 */

/**
 * The contract a run gets when it does not name one.
 *
 * A local literal, and this file's own boundary rule requires it: `cortex-eval` depends
 * only on `cortex-core` and `cortex-ai`, while `cortex-memory` is the layer that depends
 * on `cortex-core` and is measured *by* this package. Importing `PROMPT_CONTRACTS` from
 * the product would reverse that direction and create a cycle.
 *
 * The first version of this comment claimed the import was safe because a renamed
 * constant would fail to compile. That is true and irrelevant: there is no edge to fail
 * to compile across. The duplication is real and it is the price of the acyclic layering,
 * so it is guarded instead of assumed -- `bench-memory-arm.test.ts` asserts this literal
 * is a member of the product's own list, which is a check that can actually run.
 *
 * The value is `abstention` because that is the contract the product hardcodes for this
 * route, so a run that names nothing reproduces every prior artifact's prompt.
 */
const DEFAULT_PROMPT_CONTRACT: string = 'abstention';

/**
 * The source trust a run gets when it does not name one.
 *
 * `0.5`, and it is the *same* `0.5` `admission.ts` hardcoded before the field
 * existed. Restating the literal here rather than importing it is deliberate and
 * is the one place this package's independence from the product layer must not be
 * traded away: `cortex-eval` is the measurement instrument, and an arm whose
 * default moved because the product's default moved would silently stop comparing
 * against the historical runs. `37110579101` and `37094200823` both ran under a
 * ceiling of `0.5`; a default that drifted would make every later number
 * incomparable to them without any artifact saying so.
 *
 * The reachable interval at this value is `[0, 0.5]`, so `retrievalThreshold` can
 * only be always-open or always-closed -- see
 * `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §9.3.
 */
const DEFAULT_SOURCE_TRUST = 0.5;

/**
 * Parses the arm's configuration out of the environment.
 *
 * The numeric guards are strict because both variables have a failure mode that
 * a satisfied type system cannot see:
 *
 *  - `decideWrite` admits on `>=` against a value bounded by
 *    `confidence * sourceTrust * (0.5 + 0.5 * recency)` with `recency < 1`
 *    strictly. So a threshold above `1` admits nothing and a threshold below `0`
 *    admits everything, and both are what a percent typed as `85` instead of
 *    `0.85` produces. Either way the run completes and the number is a fact about
 *    the typo.
 *  - `Number('abc')` is `NaN`, and `NaN >= x` is false for every `x`, so a
 *    non-numeric threshold admits nothing while every type in the program holds.
 *  - `selectSessionBudget` returns `[]` for `budget <= 0`, so a negative budget
 *    abstains on every question for a reason no artifact records. A fractional
 *    budget is meaningless because the unit is turns.
 *
 * The defaults are the **identity configuration**: threshold `0` opens the gates
 * (every turn is admitted), and an unbounded budget presents every session. That
 * is the honest first measurement -- "does composing the cognitive layer move
 * anything at all" -- with the gate knobs left out of it.
 */
export function cortextMemoryArmOptions(env: CortexMemoryArmEnv): CortexMemoryArmOptions {
  const enabled = readToggle(env, 'CORTEX_MEMORY');
  if (!enabled) {
    return {
      enabled: false,
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: Number.POSITIVE_INFINITY,
      sourceTrust: DEFAULT_SOURCE_TRUST,
      confidenceSignal: DEFAULT_CONFIDENCE_SIGNAL,
      // Projected in the disabled state as well, because it is a property of the evidence
      // rather than of the arm: a disabled run measures nothing on either pool, and
      // `false` is the only truthful statement about which pool that was.
      oracleEvidence: false,
      promptContract: DEFAULT_PROMPT_CONTRACT,
      ask: DEFAULT_ASK,
      evidenceTurnsPerRecord: Number.POSITIVE_INFINITY,
      relevanceSignal: DEFAULT_RELEVANCE_SIGNAL,
      relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
      relevanceUnits: DEFAULT_RELEVANCE_UNITS,
      // The reach is projected even when the cap is absent, so an artifact always answers "what
      // would the cap have reached" -- and so a run whose cap was removed cannot leave a stale
      // reach behind it. `all` is the shipped state.
      maxTurnCharsRoutes: ALL_TURN_CAP_ROUTES,
      // §13.83's reach, projected in the disabled state for the same reason: an artifact always
      // answers where the filter would have applied, and a run that turned the arm off cannot
      // leave a stale reach behind it.
      evidenceRolesRoutes: ALL_TURN_CAP_ROUTES,
      // Projected too, because it is a state rather than a treatment: a disabled arm cuts
      // nothing, so the only truthful value is the one that says so.
      turnCutMarker: DEFAULT_TURN_CUT_MARKER,
      // Absent, not zero and not `Infinity`: no cap is the state every archived run was
      // produced under, and a present key would let an artifact claim a treatment on a run
      // that administered none. `exactOptionalPropertyTypes` keeps the two distinguishable.
    };
  }
  // Parsed once, above the object, because one value carries both halves: the width and whether
  // the cut it makes is visible. See `readTurnCap` for the grammar and for why the marker rides
  // on the cap instead of an input of its own.
  const turnCap = readTurnCap(env[MAX_TURN_CHARS_VARIABLE]);
  return {
    enabled: true,
    threshold: readThreshold(THRESHOLD_VARIABLE, env[THRESHOLD_VARIABLE]),
    retrievalThreshold: readThreshold(
      RETRIEVAL_THRESHOLD_VARIABLE,
      env[RETRIEVAL_THRESHOLD_VARIABLE],
    ),
    sessionBudget: readSessionBudget(env[BUDGET_VARIABLE]),
    sourceTrust: readSourceTrust(env[SOURCE_TRUST_VARIABLE]),
    confidenceSignal: readConfidenceSignal(env[CONFIDENCE_VARIABLE]),
    oracleEvidence: readOracleEvidence(env[ORACLE_EVIDENCE_VARIABLE]),
    promptContract: readPromptContract(env[PROMPT_CONTRACT_VARIABLE]),
    ask: readAsk(env[ASK_VARIABLE]),
    reviewPass: readReviewPass(env[REVIEW_PASS_VARIABLE]),
    // A value of `reviewPass` rather than an input of its own: the workflow is at the dispatch-input ceiling.
    //
    // `bare` is not the only name that turns this on, and that correction is the whole point of the
    // helper: the two passes act on **disjoint routes** (`bare` on the non-multi-session ones,
    // `recover` inside the multi-session one), so deriving this from `=== 'bare'` made a dispatch of
    // `recover` withdraw a shipped treatment on the route that did not gain anything. §13.128
    // registers that dispatch as one `recover` against its control; under the old derivation the run
    // would have measured a withdrawal it did not name.
    reviewBareDecline: carriesBareLadder(readReviewPass(env[REVIEW_PASS_VARIABLE])),
    // §13.334. Its own variable rather than a value of `REVIEW_PASS`, because it is a different treatment on a
    // disjoint population -- the same reason `reviewBareDecline` was split out of the pass name.
    replyRepair: readReplyRepair(env[REPLY_REPAIR_VARIABLE]),
    queryExpansion: readQueryExpansion(env[QUERY_EXPANSION_VARIABLE]),
    selfConsistency: readSelfConsistency(env[SELF_CONSISTENCY_VARIABLE]),
    evidenceTurnsPerRecord: readEvidenceBound(env[EVIDENCE_BOUND_VARIABLE]),
    relevanceSignal: readRelevanceSignal(env[RELEVANCE_VARIABLE]),
    relevanceTopK: readRelevanceTopK(env[RELEVANCE_TOP_K_VARIABLE]),
    relevanceUnits: readRelevanceUnits(env[RELEVANCE_UNITS_VARIABLE]),
    maxTurnCharsRoutes: readMaxTurnCharsRoutes(env[MAX_TURN_CHARS_ROUTES_VARIABLE]),
    // Spread conditionally, because "the product default" is an absent field rather than a number
    // this module would have to keep in step with `prompt.ts`.
    ...readPromptBudget(env[MAX_PROMPT_CHARS_VARIABLE]),
    // Spread rather than assigned, because "no cap" is an absent field on this type rather
    // than an infinite one -- see `CortexMemoryArmOptions.maxTurnChars`.
    ...(turnCap.width === undefined ? {} : { maxTurnChars: turnCap.width }),
    // §13.83's filter. Absent for the same reason the cap is: "every role" is the state every
    // archived run was produced under, and a present-but-empty list would be a filter that
    // admits nothing.
    ...(() => {
      const roles = readEvidenceRoles(env[EVIDENCE_ROLES_VARIABLE]);
      return roles === undefined ? {} : { evidenceRoles: roles };
    })(),
    // Projected even when the roles are absent, for the reason `maxTurnCharsRoutes` is: an
    // artifact always answers "what would the filter have reached", and a run whose filter was
    // removed cannot leave a stale reach behind it.
    evidenceRolesRoutes: readRouteReach(
      env[EVIDENCE_ROLES_ROUTES_VARIABLE],
      EVIDENCE_ROLES_ROUTES_VARIABLE,
    ),
    // §13.187.6D. Always present for the reason `queryExpansion` is: `none` is a state a run is
    // dispatched to -- the control arm of this experiment -- so an artifact that spelled nothing
    // would leave "ran the control" and "predates the field" as the same bytes. It comes from the
    // same parse as the width, so the two can never describe different caps.
    turnCutMarker: turnCap.marker,
  };
}

/**
 * The number a variable holds, or `undefined` when it holds no configuration.
 *
 * `''` and whitespace both collapse to `undefined` because that is what an
 * unfilled `workflow_dispatch` input actually is. GitHub writes the empty string
 * into the environment rather than omitting the variable, and `Number('')` is `0`
 * -- so the "not configured" case would arrive as a perfectly valid zero.
 *
 * For the threshold that accident lands on the intended default, which is the more
 * dangerous kind of bug: it passes review because the number is right. For the
 * session budget it lands on `0` turns, which is the exact value the guard below
 * was written to reject, and it is not rejected because the guard tests `< 0`.
 *
 * The blank check is `trim() === ''` rather than a falsy test, so an explicit `'0'`
 * stays reachable. Turning "unset" into "the default" by making a real zero
 * unexpressible would be the same defect mirrored.
 */
function readNumeric(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return Number(raw);
}

/**
 * Read the per-turn confidence signal name, rejecting anything unrecognised.
 *
 * Thrown rather than defaulted, and that is the whole point of this function.
 * `readToggle` treats an unrecognised value as off, which is right for a boolean
 * switch -- a typo runs the control arm, and the artifact's configuration line
 * says so. Here it would be wrong in the direction that matters: §49 established
 * that a registration whose variation is missing repeats §10.10's mistake, so a
 * run dispatched to introduce per-turn confidence and silently falling back to
 * *none* would produce an artifact claiming a mechanism it did not run. The delta
 * would then be read as evidence that variation does not help.
 *
 * The accepted set is enumerated from `CONFIDENCE_SIGNALS`, so adding a signal is
 * a deliberate edit in one place and the error message lists what does exist.
 */
function readConfidenceSignal(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONFIDENCE_SIGNAL;

  const value = raw.trim();
  const known = Object.keys(CONFIDENCE_SIGNALS);
  if (!known.includes(value)) {
    throw new Error(
      `${CONFIDENCE_VARIABLE} must be one of ${known.map((k) => JSON.stringify(k)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}. An unrecognised signal is rejected rather ` +
        'than defaulted to "none": a run dispatched to introduce per-turn confidence would ' +
        'otherwise run the constant behaviour and its artifact would read as evidence that ' +
        'variation does not help.',
    );
  }
  return value;
}

/**
 * Read the evidence-source switch, rejecting anything unrecognised.
 *
 * ## Why this does not call `readToggle`
 *
 * `readToggle` reads an unrecognised value as off, and for a *treatment* that is the right
 * direction: a typo runs the control arm, and the artifact says the treatment was not
 * administered. This is not a treatment. `CORTEX_MEMORY_ORACLE=oracle` would run the
 * shipped corpus and publish a number that a reader -- including this project's own
 * readouts -- would file as a **ceiling**, which is the one class of number that cannot be
 * corrected later by re-reading it. The volume in which the silently-wrong value is
 * plausible is exactly the volume where it does the most damage.
 *
 * So the accepted set is `'0'`, `'1'` and the empty string (what an unfilled dispatch input
 * actually is), and anything else throws with those three named.
 */
function readOracleEvidence(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim();
  // `''` is the unfilled input rather than a value: GitHub writes it into the environment
  // for every input a dispatch leaves blank, and reading it as on would put the condition
  // into every run whose dispatch predates the field.
  if (value === '') return false;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(
    `${ORACLE_EVIDENCE_VARIABLE} must be '1', '0' or unset, got ${JSON.stringify(raw)}. ` +
      'An unrecognised value is rejected rather than read as off: a run dispatched for the ' +
      'reader ceiling would otherwise grade the shipped corpus, and a shipped score published ' +
      'under an oracle label is a number no later re-reading can repair.',
  );
}

/**
 * The contract names `CORTEX_MEMORY_PROMPT_CONTRACT` accepts.
 *
 * The product's own list, restated here, for the layering reason
 * {@link DEFAULT_PROMPT_CONTRACT} records. The duplication is checked rather than
 * trusted: `bench-memory-arm.test.ts` asserts these are exactly the contracts
 * `cortex-memory` exports, so a name added or removed on the product side fails a test
 * here instead of silently becoming an accepted-but-unimplemented value.
 */
export const PROMPT_CONTRACTS = {
  /** The baseline rendering: numbered turns, blank-line separated. */
  abstention: 'abstention',
  /** §12.5's candidate: every turn labelled with the memory it came from. */
  'abstention-evidence-blocks': 'abstention-evidence-blocks',
  /**
   * §13.279's candidate: the same rendering, assembled in the reference pipeline's order.
   *
   * A contract rather than a new dispatch input because the workflow sits at GitHub's 25-input
   * ceiling, and because the contract is already the axis that carries "how this run renders".
   */
  'evidence-blocks-instruction-first': 'evidence-blocks-instruction-first',
  /**
   * §13.283's candidate: the same instruction and the same order, with no per-turn source id.
   *
   * A contract rather than a new dispatch input for the reason the entry above gives, and one
   * variable rather than two because `ASSEMBLY_ROUTES` and `RENDERING_ROUTES` both report the
   * comparison it is read against.
   */
  'evidence-blocks-unsourced': 'evidence-blocks-unsourced',
  /**
   * §13.346's candidate: the same instruction and order, with the item identifier running across
   * the session blocks.
   *
   * A contract rather than a dispatch input for the reason the two entries above give -- the
   * workflow is at GitHub's 25-input ceiling -- and one variable rather than two because it
   * delegates the instruction to the contract above and keeps its assembly.
   */
  'evidence-blocks-item-ids': 'evidence-blocks-item-ids',
} as const;

/**
 * The routes each contract's rendering reaches, restated for the report.
 *
 * Duplicated from `cortex-memory` for the same layering reason as
 * {@link PROMPT_CONTRACTS}. What is checked, and what is not, stated plainly because the
 * sentence that stood here claimed more than the check did: the route **vocabulary** is the
 * product's and a name that exists only here fails a test, but the **list per contract** has no
 * authority on the product side to compare against -- which routes a rendering reaches is a
 * property of the dispatch, decided in `bench/run-ablation.ts` where the contract is chosen, and
 * that file is outside the coverage boundary. So the list is the arm's claim about the dispatch,
 * the artifact records it per run as `renderingRoutes`, and a reader verifies it against the run
 * rather than against a table.
 *
 * ## Why the artifact needs this at all
 *
 * `promptContract` records the name the run passed. At `bcf66463` that name was
 * `abstention-evidence-blocks` and the rendering reached 17 of 120 questions,
 * because `memory.ts` gated it on `contract === 'abstention'` and only the ABS
 * capability dispatched that route. An artifact naming the contract therefore
 * described a treatment four of five capabilities never received, and the 45→17
 * drop read as a fact about the rendering. It was a fact about the dispatch.
 *
 * §12.8 made the reachable set a reported property for exactly that reason. The
 * list is written per contract rather than measured per run because the reach is a
 * property of the product's dispatch, not of a dataset -- and because measuring it
 * per run would require the arm to trust its own dispatch table, which is the thing
 * that was wrong.
 *
 * The baseline contract reaches nothing: it administers no rendering, so reporting
 * it as covering routes would claim a treatment the control arm did not receive.
 * That empty list is a real answer and is emitted as `[]` rather than omitted.
 */
const RENDERING_ROUTES: Record<string, readonly string[]> = {
  abstention: [],
  'abstention-evidence-blocks': [
    'abstention',
    'multi-session',
    'temporal',
    'knowledge-update',
    'assistant',
    'flat',
  ],
  // The same six, because the contract also selects the sourced rendering: §13.279's treatment
  // is additively "the adopted rendering plus a different order", so the evidence text is
  // identical to the control's and only the multi-session order moves.
  'evidence-blocks-instruction-first': [
    'abstention',
    'multi-session',
    'temporal',
    'knowledge-update',
    'assistant',
    'flat',
  ],
  // The same six, and the entry that stood here said `[]` -- which was wrong, and run `42310779222`'s
  // own audit said so: `FAIL reach  ask=verbatim touches ['multi-session', 'flat', 'temporal',
  // 'abstention'], of which all four never rendered`.
  //
  // The mistake was reading this table as "which routes draw a **sourced** rendering" and answering
  // "none" -- true, and not what the field means. `[]` is the baseline's answer and the baseline's
  // alone: `abstention` administers no rendering, so naming routes would claim a treatment the control
  // never received. Every other contract here **is** administered on every route, because
  // `instructionsFor` returns the contract's own block (`const own = CONTRACT_INSTRUCTIONS[contract]`)
  // for every route an ask does not override -- with `ask=verbatim` that is all of them. What
  // `unsourced` administers on those six routes is the withholding of the id, and §13.283 measures it
  // against `42237543941`, which drew the id on the same six.
  //
  // So `[]` here was a false claim in the one direction that matters: it read as the §12.8 defect
  // (an artifact naming a contract four of five capabilities never received) when the run had
  // administered it everywhere. The audit is the check that exists for that defect and it fired
  // correctly -- the artifact was what was wrong.
  'evidence-blocks-unsourced': [
    'abstention',
    'multi-session',
    'temporal',
    'knowledge-update',
    'assistant',
    'flat',
  ],
  // The same six, for the same reason: `formatEvidence` is reached by both builders, so the
  // numbering is administered wherever evidence is rendered. The entry describes the **contract**;
  // a dispatch that restricts the population (`capability=MR`, §13.345) records the population it
  // graded in `questionsByCapability`, so the two fields together say what actually rendered rather
  // than this table claiming a reach the run did not exercise.
  'evidence-blocks-item-ids': [
    'abstention',
    'multi-session',
    'temporal',
    'knowledge-update',
    'assistant',
    'flat',
  ],
};

/**
 * The routes each contract's assembly reaches, restated for the report.
 *
 * One entry, and its emptiness for the other two is the point: the shipped order is the baseline,
 * so a run that named a contract without an assembly administered no order change and reporting
 * one would claim a treatment nobody received.
 *
 * The reach is one route because `buildSessionPrompt` is the only builder that takes
 * `PromptOptions.assembly`; the five flat routes render through `buildPrompt`, whose signature
 * does not carry it. That is why §13.279's fourth gate can read their movement as leakage.
 */
const ASSEMBLY_ROUTES: Record<string, readonly string[]> = {
  abstention: [],
  'abstention-evidence-blocks': [],
  'evidence-blocks-instruction-first': ['multi-session'],
  // The same route as the contract above, because the order is held fixed: §13.283's single
  // variable is the rendering, and an assembly that moved as well would make the delta a statement
  // about two changes.
  'evidence-blocks-unsourced': ['multi-session'],
};

/**
 * The assembly each contract names, restated for the report.
 *
 * `undefined` rather than a default string for the two contracts that name none: `'shipped'`
 * would be a value, and a value is indistinguishable in an artifact from a run that chose it.
 */
const ASSEMBLY_BY_CONTRACT: Record<string, string | undefined> = {
  abstention: undefined,
  'abstention-evidence-blocks': undefined,
  'evidence-blocks-instruction-first': 'instruction-first',
  'evidence-blocks-unsourced': 'instruction-first',
};

/**
 * The routes each ask reaches, restated for the report.
 *
 * Checked rather than trusted, like the table above, and the check is the census test's
 * job. The trap this exists to make unreadable-as-success is specific and measured:
 *
 *   **MR's own ask IS `extractive`.** `buildSessionPrompt` hardcodes it, so an
 *   `ask: 'extractive'` run leaves MR's prompt byte-identical -- and §13's headline
 *   prediction is `MR >= 7/17`. A run that reported only the ask's name would claim a
 *   treatment MR never received, in the experiment written to learn from exactly that
 *   mistake.
 *
 * `route` reaches nothing by definition: it IS the shipped behaviour.
 */
const ASK_ROUTES: Record<string, readonly string[]> = {
  route: [],
  extractive: ['abstention', 'temporal', 'knowledge-update', 'assistant'],
  // §13.21's ask, restated for the same reason as the two above: the artifact reports
  // the reach from this table. §13.35 is why "restated" is a hazard rather than a
  // formality -- this copy is what `readAsk` validates against, a value added to the
  // product's union alone is accepted by every type here, and the first
  // `ask: enumerated` dispatch was rejected at startup with a stack trace pointing at
  // `readAsk`. `tools/__tests__/test_ask_table_parity.py` now compares the two key sets
  // by source; until it existed, the sentence that stood here claimed an assertion nobody
  // had written.
  aggregate: ['multi-session', 'flat'],
  // §13.22's ask: `aggregate` plus the temporal route. The artifact's `askRoutes` is how
  // the run states that the temporal block was composed with rather than replaced, which
  // is the one thing a reader of the headline delta cannot otherwise tell -- §13.20 and
  // §13.21 have the same `ask`-shaped delta from opposite directions.
  computed: ['multi-session', 'flat', 'temporal'],
  // §13.34's ask: `computed` plus the two-step enumeration contract, on the multi-session
  // route alone. The reach set equals `computed`'s because flat and temporal are
  // byte-identical to it -- which is exactly what makes the single-variable claim about
  // §13.26's run true -- so an artifact separates the two asks by this value beside an
  // unchanged `askRoutes`, and `tools/__tests__/test_ask_table_parity.py` holds this
  // table and the product's own to the same key set.
  enumerated: ['multi-session', 'flat', 'temporal'],
  // §13.92's ask, and the first entry whose reach is a single route. Unlike `enumerated`, the other
  // five routes are NOT `computed`: they fall through to the shipped block, so the run's artifact
  // can be read as one treatment with five controls rather than six subjects.
  //
  // The value is what `readAsk` validates a dispatch against, and the reason this table is
  // restated at all is §13.35 -- a value added to the product's union alone type-checks, is
  // accepted by every guard, and fails at startup in `readAsk`. `test_ask_table_parity.py` compares
  // the two key sets by source, and it is the only thing that makes this copy safe.
  sweep: ['multi-session'],
  // §13.103's ask, corrected by §13.104: the same three routes as `enumerated`, because the flat path
  // and the temporal route read `computed`'s block in both. The first dispatch declared one route and
  // fell through to the control's block elsewhere, which removed the merging sentence from flat and
  // temporal -- TR fell 21 questions in a run registered as a single-variable test.
  aggregation: ['multi-session', 'flat', 'temporal'],
  // §13.123's ask: `enumerated`'s reach and `enumerated`'s block on flat and temporal, with the
  // Step 1 notes made private on the multi-session route. Dispatchable against an `enumerated`
  // control as a single variable because the other two routes are byte-identical, which is what
  // keeps TR and IE from moving under a registration that names only multi-session.
  silent: ['multi-session', 'flat', 'temporal'],
  // §13.124's ask: the flat route alone, and the first whose reach is one route the session builder
  // cannot name. It states a reply SHAPE where `extractive` states a reply LENGTH, written against
  // nine of IE's ten wrong answers being the evidence block copied back, a sentence about not
  // finding anything, free prose, or an empty reply.
  //
  // Run `40807829150` measured it and the reach below is the corrected one. The first dispatch
  // declared one route and fell through to the *shipped* block on the other two, which cost MR 48
  // questions and TR 12 -- §13.104's defect a fourth time. The reach is therefore `enumerated`'s,
  // with flat the only route whose bytes change, and `ASK_CHANGES` in the product states that set.
  'answer-line': ['multi-session', 'flat', 'temporal'],
  // §13.129's ask: the flat route's licence to compose a recommendation and its ban on quoting the
  // evidence. Same reach and same change set as `answer-line`, and the two are separated by the
  // `ask` value beside an unchanged `askRoutes` -- exactly the argument the entry above makes.
  recommend: ['multi-session', 'flat', 'temporal'],
  // §13.132's ask: `enumerated` with the licence to combine evidence read **last**, on the
  // multi-session route alone. Same reach and same change set as `enumerated`, and the two are
  // separated by the `ask` value beside an unchanged `askRoutes`. Written against twelve MR declines
  // on `40751394094`, none correct, ten of them questions the reference pipeline answers and every one
  // carrying its gold turns: eleven of the twelve refuse to join two stated facts ("a separate
  // session and cannot be merged", "does not state the user's age"), which is what `MERGING_SENTENCE`
  // licenses and what `enumerated` buries six lines above its closing rule.
  derive: ['multi-session', 'flat', 'temporal'],
  // §13.166's ask: derivation-shaped questions read an operand-identification block on the
  // multi-session route, and every other question on every route reads `enumerated`'s bytes. Same
  // reach as `enumerated` and a conditional change set, which is why the arm reports `askRoutes`
  // here and the population itself is counted by `tools/mr-failure-census.mjs` through the product's
  // own classifier -- a dispatch field cannot express "for some questions", so the artifact must not
  // pretend it does.
  operands: ['multi-session', 'flat', 'temporal'],
  // §13.190's ask: the abstention route alone, and the first one whose subject is the route whose gold is
  // a decline. `operands`' complement rather than its extension -- `operands` asks the reading route to
  // find the numbers a derivation question needs, this asks the abstention route to notice that one of the
  // things the question names is absent from the evidence.
  //
  // The reach is a single route that is not `multi-session`, which is what makes this dispatch readable
  // without a second control run: the abstention route is the only route that reads the abstention
  // contract, so MR, IE, KU and TR cannot be moved by this value and their `promptChars` in the artifact
  // are a check on the claim rather than a hope about it.
  'operand-gap': ['abstention'],
  // §13.193.5's value: the two asks above, composed. The reach is their union -- four of the six routes
  // -- and the artifact states it because a reader comparing this run with `41185512391` (which ran
  // `operands`) needs to see that the difference is the abstention route and not a fourth route the
  // dispatcher forgot to name.
  //
  // This is the entry that would have been missing on the day the product's union grew: `readAsk`
  // validates against THIS table, so a composite added to `EvidenceAsk` alone type-checks everywhere and
  // is rejected at startup -- §13.35's failure, which `test_ask_table_parity.py` now reads out of both
  // sources. The value is spelled the way the product spells it, with a `+`, because a name that
  // restated the composition in words would let the two copies disagree about what is being composed.
  'operands+operand-gap': ['multi-session', 'flat', 'temporal', 'abstention'],
  // §13.205's value: `enumerated`'s reach, with the multi-session block's two steps replaced by a screen
  // -- one line per mention, included or excluded, and Step 2 counting the inclusions. The reach equals
  // `enumerated`'s and the change set is one route, so a run at the same load is a single variable on MR;
  // the artifact states the reach rather than the change set, which is why both are written here.
  candidates: ['multi-session', 'flat', 'temporal'],
  // §13.246's value: the reference pipeline's aggregation contract on the multi-session route, and the
  // registration's own composition everywhere else. The reach is one route because the other five read
  // the **control's** bytes by delegation, which is what makes a run at this load a single variable on
  // MR. §13.240.4 read the reference's ask off `conInstruction` -- the single-session skeleton -- and
  // concluded it was a silent Step 1; the multi-session path calls `buildAggregationQaPrompt`, which
  // enumerates in writing. This value is that builder, migrated whole.
  //
  // Four routes, because the reach is measured against the shipped block and this ask is composed on
  // the registered arm: the three routes `operands`/`operand-gap` moved stay moved.
  verbatim: ['multi-session', 'flat', 'temporal', 'abstention'],
  // §13.290's value: `verbatim` with **one line of it replaced**, on the question shape that line was
  // written for. Same reach, because the block is the same block; the change set is the multi-session
  // route alone, which is where the reference's aggregation contract is read.
  //
  // Why the line and not the block: §13.289 classified `MR`'s twenty-seven failures on `42310779222` and
  // found eighteen **below** the gold against four above — a one-sided error, which is the signature of
  // a missing item rather than a wrong computation. Eight of the eighteen carry the exclusion that cost
  // them in their own reply, and every one of those exclusions is licensed by one sentence of this
  // contract: *"Do NOT substitute or infer a different verb"*. `bc149d6b` excluded a 20-pound bag because
  // the question said "purchased" and the evidence said "bought"; 50 + 20 = the gold's 70. `129d1232`
  // excluded a $600 event because the evidence said "helped organize"; $5,250 + $600 = the gold's $5,850.
  //
  // The rule is not wrong — it was written for a real over-counting failure — it is mis-calibrated
  // against an arm whose error is one-sided toward omission, and the only way to find out is to move it
  // alone. The replacement keeps a rule (the act must be absent, or a different kind of act) so the four
  // above-gold failures are not licensed by the fix.
  'verbatim-acts': ['multi-session', 'flat', 'temporal', 'abstention'],
};

/**
 * Read the prompt-contract name, rejecting anything unrecognised.
 *
 * The same argument as {@link readConfidenceSignal}, applied to the §12.5 experiment.
 * §12.4 measured `b✗f✓ = 0` on every capability with the feature side's abstentions
 * attributed to the model (`reason: "llm"`), and §12.3 measured that no
 * `retrievalThreshold` can carry the arm -- the best reachable precision is 0.466 against
 * a base rate of 0.368. What remains is what the arm *presents* to the model, and this
 * variable is the one thing that changes it.
 *
 * Defaulted rather than thrown on the blank case, because unset is a real configuration:
 * every run before this one used the baseline rendering, and a blank input has to keep
 * reproducing it. Thrown on an *unrecognised* value, because that case is different in
 * kind -- a run dispatched to test a rendering, silently falling back to the baseline,
 * would publish an artifact whose `b✗f✓` of zero reads as evidence that the rendering
 * does not help. The delta would then be a fact about the typo.
 */
function readPromptContract(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROMPT_CONTRACT;

  const value = raw.trim();
  const known = Object.keys(PROMPT_CONTRACTS);
  if (!known.includes(value)) {
    throw new Error(
      `${PROMPT_CONTRACT_VARIABLE} must be one of ${known.map((k) => JSON.stringify(k)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}. An unrecognised contract is rejected rather ` +
        'than defaulted to the baseline: a run dispatched to test a different evidence ' +
        'rendering would otherwise run the baseline and its artifact would read as evidence ' +
        'that the rendering does not help.',
    );
  }
  return value;
}

/**
 * The ask a run gets when it names none: each route's own instruction block.
 *
 * The same shape as {@link DEFAULT_PROMPT_CONTRACT} and for the same reason -- every
 * prior run used the shipped block, so a blank input has to keep reproducing it or the
 * historical artifacts stop being comparable.
 */
const DEFAULT_ASK = 'route';

/**
 * Read the ask name, rejecting anything unrecognised.
 *
 * The same rule {@link readPromptContract} applies, on the second axis. A run dispatched
 * to change the ask and silently falling back to the shipped block would publish an
 * artifact whose unchanged MR/TR read as evidence that the ASK does not matter -- when
 * in fact the ask was never administered. That is precisely the reading §13.5 registers
 * as its falsifier, so a typo must not be able to produce it.
 *
 * Blank is defaulted rather than rejected: unset is a real configuration (every run
 * before §13), and the shipped block is what it means.
 */
function readAsk(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ASK;

  const value = raw.trim();
  const known = Object.keys(ASK_ROUTES);
  if (!known.includes(value)) {
    throw new Error(
      `${ASK_VARIABLE} must be one of ${known.map((k) => JSON.stringify(k)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}. An unrecognised ask is rejected rather than ` +
        'defaulted, because a run dispatched to widen the instruction block would otherwise ' +
        'run the shipped one and its artifact would read as evidence that the ask does not ' +
        'matter -- which is the falsifier §13.5 registers, reached by a typo instead of by ' +
        'measurement.',
    );
  }
  return value;
}

/**
 * The second consultation a run performs on the multi-session route (§13.94).
 *
 * `none` is the identity and every archived artifact was produced under it. `audit` re-asks with the
 * first pass quoted and the review restricted to membership, which is the decision §13.93 measured as
 * the one the reader gets wrong: a response that walked all forty-four sessions still named two
 * items, and the record it produced acted on a list that was short.
 */
const REVIEW_PASS_VARIABLE = 'CORTEX_MEMORY_REVIEW_PASS';

/** The passes this arm can dispatch, in the order the config line spells them. */
const REVIEW_PASSES: readonly string[] = ['none', 'audit', 'recover', 'bare'];

/**
 * Read the review pass, rejecting anything the product does not implement.
 *
 * Rejected rather than defaulted for the reason `readAsk` rejects: a run dispatched to administer a
 * treatment that silently ran the control would publish an unchanged result, and that result would
 * read as evidence the treatment does not matter.
 */
function readReviewPass(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '') return 'none';
  if (!REVIEW_PASSES.includes(trimmed)) {
    throw new Error(
      `${REVIEW_PASS_VARIABLE} must be one of ${REVIEW_PASSES.map((name) => JSON.stringify(name)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}.`,
    );
  }
  return trimmed;
}

/**
 * Whether a review-pass name carries the bare-decline ladder.
 *
 * ## Why this is a function and not `=== 'bare'`
 *
 * Because the two passes it distinguishes act on **disjoint populations**, and the equality hid that.
 * `bare` re-asks a reply that is the abstention token and nothing else, and it is reached from every
 * route except `abstention` and `multi-session` (`#answerWithBareRetry`). `recover` re-asks a
 * `multi-session` decline that contradicted its own Step 1 list (`#promptSessionAware`). No question
 * can reach both, so "the bare ladder plus the recovery pass" is one configuration rather than two
 * treatments administered at once -- and the dispatch, which has one field, is the right place to
 * name it.
 *
 * The version this replaces read `=== 'bare'`, so `review_pass=recover` silently **removed** the
 * bare ladder from `flat`, `temporal`, `assistant` and `knowledge-update`. §13.128 registers that
 * dispatch as a pass that "can only ever consult on questions that are already wrong"; with the
 * ladder withdrawn, a question it had converted would go back to being a decline, and the section's
 * no-loss property would be false for a reason nothing in the artifact would show.
 *
 * `audit` used to be excluded, and the exclusion was wrong for the same reason the `=== 'bare'`
 * version was wrong -- it read a **field name** instead of asking which populations the passes act on.
 * The stated reason was that stacking a bare retry under `audit` "would make any movement two
 * consultations rather than one", and that cannot happen: `answerSessions` retries a bare decline and
 * returns before the audit branch, which requires a first pass that was **not** a decline. The two act
 * on disjoint outcomes of one call, so a run carrying both still gives each question at most one
 * extra consultation of each kind.
 *
 * Run `42054107910` is what the exclusion cost. It was dispatched as a single-field experiment against
 * `42013256884` and it moved two mechanisms: the control converted `71` bare declines
 * (`bareRetry: {attempted: 71, answered: 71}`) and the treatment converted none, while its decline
 * count rose from `134` to `209`. Every accuracy number in that dispatch is therefore the sum of the
 * audit and the withdrawal of a shipped pass, and neither can be read off it. The rule this file
 * already applied to `recover` -- a name covers the passes its dispatches intend, and `none` is the
 * only name that means "no ladder" -- now applies to `audit` too.
 */
function carriesBareLadder(pass: string): boolean {
  return pass !== 'none';
}

/** The variable this arm reads for §13.101's sample count. */
const SELF_CONSISTENCY_VARIABLE = 'CORTEX_MEMORY_SELF_CONSISTENCY';
/** The counts this arm can dispatch, in the order the config line spells them. */
const SELF_CONSISTENCY_COUNTS: readonly string[] = ['none', '3'];

/**
 * Read the sample count, rejecting anything this arm does not implement.
 *
 * Rejected rather than clamped, for the reason `readQueryExpansion` rejects: a run dispatched at a
 * count the product would clamp would publish a configuration it never administered, and a run that
 * silently ran one consultation under a treatment's name would read as evidence that voting does not
 * help. Only `3` is offered because a vote needs an odd count above one, and nothing has measured
 * five.
 */
function readSelfConsistency(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '') return 'none';
  if (!SELF_CONSISTENCY_COUNTS.includes(trimmed)) {
    throw new Error(
      `${SELF_CONSISTENCY_VARIABLE} must be one of ` +
        `${SELF_CONSISTENCY_COUNTS.map((name) => JSON.stringify(name)).join(', ')} or unset, ` +
        `got ${JSON.stringify(raw)}.`,
    );
  }
  return trimmed;
}

/** The variable this arm reads for §13.97's query expansion. */
const QUERY_EXPANSION_VARIABLE = 'CORTEX_MEMORY_QUERY_EXPANSION';

/**
 * The expansions this arm can dispatch, in the order the config line spells them.
 *
 * `window` is the reference pipeline's own index expansion (§13.151.1, §13.153): the same stage as
 * `llm`, implemented without a model. Its `temp_query_search_pruning.py` spends one gpt-4o call to
 * infer a date range and then moves the items inside it to the front of the list retrieval already
 * produced; this arm resolves the range with `resolveTimeRange` and moves them with a stable
 * partition of the delivered set. So the three values are three implementations of **one stage**
 * rather than three stages, and a run can administer one of them -- which is what one field says.
 */
const QUERY_EXPANSIONS: readonly string[] = ['none', 'llm', 'window'];

/**
 * Read the query expansion, rejecting anything this arm does not implement.
 *
 * Rejected rather than defaulted for the reason `readReviewPass` rejects: a run dispatched to widen
 * retrieval that silently ran the bare question would publish the control's reading under the
 * treatment's name. The two values are named rather than boolean because `none` has to be
 * *sayable* -- an absent field and a run that chose the control are different facts, and an
 * artifact that spells `none` is the one a reader can compare against `llm`.
 */
function readQueryExpansion(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '') return 'none';
  if (!QUERY_EXPANSIONS.includes(trimmed)) {
    throw new Error(
      `${QUERY_EXPANSION_VARIABLE} must be one of ${QUERY_EXPANSIONS.map((name) => JSON.stringify(name)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}.`,
    );
  }
  return trimmed;
}

/**
 * The reply-contract repair a run administers on every route whose gold is not a decline (§13.334).
 *
 * The population is what `tools/reply-shape-census.mjs` counts over an artifact's own replies: 3 to 5 prose refusals
 * per run, every one of them a loss, and 42 to 47 lists of quotations of which only 7 to 13 are losses. Neither shape
 * is visible to the two retries the product already carries -- `reviewBareDecline` needs the token and nothing else,
 * and `reviewPass: 'recover'` is told `answered: true` because `parseAnswer` reads "Not specified in the evidence" as
 * an answer.
 *
 * Four values, because the two kinds are disjoint populations and a run has to be able to administer one of them.
 * `off` is a value rather than an absent field so a control arm can say it ran the control, the same reason
 * `QUERY_EXPANSIONS` carries `none`.
 */
const REPLY_REPAIR_VARIABLE = 'CORTEX_MEMORY_REPLY_REPAIR';

/** The repairs this arm can dispatch, in the order the config line spells them. */
const REPLY_REPAIRS: readonly string[] = ['off', 'commitment', 'shape', 'both'];

/**
 * Read the reply repair, rejecting anything the product does not implement.
 *
 * Rejected rather than defaulted for the reason `readReviewPass` rejects: a run dispatched to administer a repair that
 * silently ran the control would publish an unchanged result, and that result would read as evidence the repair does
 * not matter -- on a population this repository has already spent a dispatch measuring.
 */
function readReplyRepair(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '') return 'off';
  if (!REPLY_REPAIRS.includes(trimmed)) {
    throw new Error(
      `${REPLY_REPAIR_VARIABLE} must be one of ${REPLY_REPAIRS.map((name) => JSON.stringify(name)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}.`,
    );
  }
  return trimmed;
}

/**
 * Read a `[0, 1]` threshold, naming the variable that was wrong.
 *
 * `variable` is a parameter rather than each gate carrying its own copy: the two
 * thresholds are compared against the same clamped `[0, 1]` utility and have the
 * same three failure modes, so two functions would be one rule with a redundant
 * copy -- and the copy is where the second one would eventually lose its guard.
 * What must differ is the message, because a run that fails has to say *which*
 * variable to fix.
 */
function readThreshold(variable: string, raw: string | undefined): number {
  const value = readNumeric(raw);
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `${variable} must be a number in [0, 1], got ${JSON.stringify(raw)}. ` +
        'The gate compares it against a value bounded by 1, so a threshold above 1 ' +
        'admits nothing, a threshold below 0 admits everything, and NaN admits nothing — ' +
        'each of which completes a full run whose result describes the typo.',
    );
  }
  return value;
}

/**
 * Read the evidence bound, defaulting to unbounded.
 *
 * ## Why the default is unbounded rather than a number
 *
 * A default bound would silently change what every prior artifact means. `§13.12`
 * registers the bound as a dispatch input precisely so that the run which applies
 * one says so, and so the pre-registration guard can compare it against `§10.3`.
 * A default of, say, `16` would make an unconfigured run look identical to a
 * configured one in every artifact.
 *
 * ## Why at least one
 *
 * A bound of `0` would carry no evidence while the record still reported
 * `evidenceTurns > 0` — making a reduced record read as one whose reader was shown
 * nothing. That is the confusion `REDUCED_TURNS_MARKER` exists to prevent, so the
 * value is rejected here rather than clamped, and `buildQuestionRecords` rejects it
 * again at the point where the bound is applied.
 *
 * Non-integers are rejected for the same class of reason as the session budget's:
 * the unit is turns, and a fractional bound has no meaning the artifact could
 * report.
 */
function readEvidenceBound(raw: string | undefined): number {
  const value = readNumeric(raw);
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${EVIDENCE_BOUND_VARIABLE} must be a positive integer or unset, got ${JSON.stringify(raw)}. ` +
        'The unit is turns per record; a bound of 0 would carry no evidence while the record ' +
        'still reported evidenceTurns > 0, making a reduced record indistinguishable from one ' +
        'whose reader was shown nothing.',
    );
  }
  return value;
}

/**
 * Read the relevance signal name, rejecting anything unrecognised.
 *
 * Thrown rather than defaulted, and the direction is the opposite of `readToggle`'s for
 * the reason `readConfidenceSignal` gives at length: an unrecognised *boolean* switch
 * running the control arm is safe because the artifact's config line says so, while an
 * unrecognised signal here would let a run dispatched to introduce a ranking publish a
 * delta taken under arrival order. That artifact's own config line would read
 * `relevanceSignal=none`, which is honest and arrives too late -- §13.16's reading of
 * run `38142407062` had to reconstruct the applied configuration from a delta whose two
 * sides differed by a variable the run never named.
 *
 * The accepted set is enumerated from `RELEVANCE_SIGNALS`, so adding a signal is a
 * deliberate edit in one place and the error message lists what does exist.
 */
function readRelevanceSignal(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RELEVANCE_SIGNAL;

  const value = raw.trim();
  const known = Object.keys(RELEVANCE_SIGNALS);
  if (!known.includes(value)) {
    throw new Error(
      `${RELEVANCE_VARIABLE} must be one of ${known.map((k) => JSON.stringify(k)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}. An unrecognised signal is rejected rather ` +
        'than defaulted to "none": a run dispatched to rank the turns its budget buys ' +
        'would otherwise run the arrival-order prefix, and its artifact would read as ' +
        'evidence that ranking does not help.',
    );
  }
  return value;
}

/**
 * Read the unit the relevance budget is spent in.
 *
 * Rejected rather than defaulted on an unrecognised value, for the reason every guard in
 * this file gives: a run dispatched to spend the room on whole sessions that silently ran
 * the turn unit would publish an unchanged result reading as evidence that the unit does
 * not matter. The measurement and the claim would be about different experiments, and only
 * the artifact's own configuration line would show it -- which is exactly what the guard
 * makes impossible.
 */
function readRelevanceUnits(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RELEVANCE_UNITS;

  const value = raw.trim();
  const known = Object.keys(RELEVANCE_UNITS);
  if (!known.includes(value)) {
    throw new Error(
      `${RELEVANCE_UNITS_VARIABLE} must be one of ${known.map((k) => JSON.stringify(k)).join(', ')} ` +
        `or unset, got ${JSON.stringify(raw)}. An unrecognised unit is rejected rather ` +
        'than defaulted to "turn": a run dispatched to complete whole sessions would ' +
        'otherwise spend the room on turns, and its artifact would read as evidence that ' +
        'the unit does not matter.',
    );
  }
  return value;
}

/**
 * Read how many turns per question the relevance index scores.
 *
 * Strict, for the same class of reason as `readEvidenceBound`: the unit is turns, so a
 * fraction or a non-number describes nothing, and `0` is the dangerous value rather than
 * the harmless one. At `0` the retrieval returns no hits, every turn receives the
 * unscored floor, the selection degenerates to arrival order -- and the artifact's config
 * line says `relevanceSignal=retrieval`. That is a run reporting a treatment it did not
 * administer, which is the defect every "reject rather than default" guard in this file
 * exists to prevent.
 */
function readRelevanceTopK(raw: string | undefined): number {
  const value = readNumeric(raw);
  if (value === undefined) return DEFAULT_RELEVANCE_TOP_K;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${RELEVANCE_TOP_K_VARIABLE} must be a positive integer or unset, got ` +
        `${JSON.stringify(raw)}. The unit is turns scored per question; a width of 0 ` +
        'scores nothing, which leaves every turn at the unscored floor -- so the ' +
        'selection would be arrival order while the config line claimed a ranking.',
    );
  }
  return value;
}

/**
 * Read the evidence budget, defaulting to the product's own default (`PROMPT_ROOM_DEFAULT`).
 *
 * ## Why a smaller budget is accepted but zero is not
 *
 * A run may legitimately want a smaller room — it is the cheapest way to test whether the room
 * matters at all — so any positive integer is allowed. `0` is refused because the allocator would
 * fail at its first step and every question would answer from no evidence while the artifact
 * recorded a budget; that is a defect reading as a configuration, which is §7.4's failure mode.
 */
function readMaxPromptChars(raw: string | undefined): number | undefined {
  const value = readNumeric(raw);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${MAX_PROMPT_CHARS_VARIABLE} must be a positive integer or unset, got ` +
        `${JSON.stringify(raw)}. The unit is UTF-16 code units of the whole prompt; a budget of 0 ` +
        'leaves the allocator nothing to spend and every question answers from no evidence, while ' +
        'the artifact would record a budget rather than a defect.',
    );
  }
  return value;
}

/** The cap as the dispatch states it: a width, and whether a cut prints a mark of omission. */
type TurnCapSpec = {
  width?: number;
  marker: string;
};

/**
 * The evidence budget as one input carries it: a scalar, a map, or nothing.
 *
 * Two shapes on one variable because the workflow is one dispatch input below GitHub's ceiling of
 * 25 and its suite forbids sitting at the ceiling. They cannot be confused -- a scalar is digits and
 * a map contains a colon -- so the grammar decides the branch rather than a heuristic, and a value
 * that is neither reaches `readMaxPromptChars` and is refused there.
 *
 * An absent or blank input returns an **empty object**, not a default: "the product default" is the
 * absence of the field, and a field carrying the number would make an artifact from before §13.213
 * indistinguishable from one that chose 24,000.
 */
function readPromptBudget(raw: string | undefined): {
  maxPromptChars?: number;
  maxPromptCharsByRoute?: Record<string, number>;
} {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return {};
  if (trimmed.includes(':')) return { maxPromptCharsByRoute: readRouteRooms(trimmed) };
  const width = readMaxPromptChars(raw);
  return width === undefined ? {} : { maxPromptChars: width };
}

/**
 * Read the per-route rooms a budget input carries, or `undefined` for one room for every route.
 *
 * ## Why this rides the budget input rather than taking one of its own
 *
 * The workflow sits one dispatch input below GitHub's ceiling of 25, and its own suite forbids
 * sitting *at* the ceiling -- the reason `maxTurnChars` already carries `:ellipsis` in its grammar
 * (the same precedent, and `maxTurnChars`'s own docstring records it). The two shapes cannot be
 * confused: a scalar budget is digits, and a map contains a colon, so the parse is decided by a
 * character rather than by a guess. A run that wants both states the map and takes the product
 * default (48,000 since §13.213, which is the value the registered arm passed explicitly) for the
 * routes it does not name.
 *
 * ## Why every malformed input is refused rather than dropped
 *
 * Three shapes are rejected: a pair with no width, a route this module does not know, and a width
 * that is not a positive integer. All three would otherwise be *applied to nothing*, and the run
 * would proceed with the global room while its artifact's config line claimed a redistribution --
 * the §7.4 defect, in the one field a reader uses to attribute the whole delta.
 *
 * A duplicate is the fourth and the quietest. `Object.entries` over a map built by assignment keeps
 * the last value, so `flat:20000,flat:29000` would apply 29,000 and record one of the two numbers
 * depending on the order the record was serialised, which is a difference no field announces.
 *
 * Ordering is by the product's own route list, so two spellings of one map produce one config line
 * and the artifact does not distinguish `flat:29000,multi-session:55900` from its reverse.
 */
function readRouteRooms(raw: string): Record<string, number> {
  const trimmed = raw.trim();
  const out: Record<string, number> = {};
  for (const part of trimmed.split(',')) {
    const pair = part.trim();
    const colon = pair.lastIndexOf(':');
    if (colon <= 0 || colon === pair.length - 1) {
      throw new Error(
        `${MAX_PROMPT_CHARS_VARIABLE} must be a comma-separated list of "<route>:<chars>" ` +
          `pairs, got ${JSON.stringify(raw)}. The pair ${JSON.stringify(pair)} names no width.`,
      );
    }
    const name = pair.slice(0, colon).trim();
    const widthText = pair.slice(colon + 1).trim();
    if (!Object.hasOwn(TURN_CAP_ROUTES, name)) {
      throw new Error(
        `${MAX_PROMPT_CHARS_VARIABLE} named ${JSON.stringify(name)}, which is not a route; ` +
          `the routes are ${Object.keys(TURN_CAP_ROUTES)
            .map((route) => JSON.stringify(route))
            .join(
              ', ',
            )}. An unrecognised name is refused rather than ignored, because a run that ` +
          'applied six of seven entries would report every number consistent with having applied ' +
          'all of them.',
      );
    }
    if (Object.hasOwn(out, name)) {
      throw new Error(
        `${MAX_PROMPT_CHARS_VARIABLE} named ${JSON.stringify(name)} twice. The last value ` +
          'would win while the config line recorded both, so the artifact would describe a room ' +
          'the prompt was not assembled under.',
      );
    }
    const width = Number(widthText);
    if (!/^\d+$/u.test(widthText) || !Number.isInteger(width) || width < 1) {
      throw new Error(
        `${MAX_PROMPT_CHARS_VARIABLE} gave ${JSON.stringify(name)} the width ` +
          `${JSON.stringify(widthText)}, which is not a positive integer. The unit is UTF-16 code ` +
          "units of that route's whole prompt; `0` leaves the allocator nothing to spend and the " +
          'route would answer from no evidence while the artifact recorded a room.',
      );
    }
    out[name] = width;
  }
  // Ordered by the product's own list, so two spellings of one map produce one config line. Built
  // with a loop rather than `fromEntries` so the value is read once and is known to be present.
  const ordered: Record<string, number> = {};
  for (const route of ALL_TURN_CAP_ROUTES) {
    const width = out[route];
    if (width !== undefined) ordered[route] = width;
  }
  return ordered;
}
/**
 * Read the per-turn character cap and its marker, defaulting to none.
 *
 * ## Why zero is refused rather than treated as "no cap"
 *
 * A cap of `0` is not an empty configuration, it is a prompt whose evidence section reads
 * `1. `, `2. `, `3. ` with nothing after the numbers -- while `carried` still reports 26
 * turns and every coverage count is computed from the turns as they arrived. The artifact
 * would then show a run that delivered 54% of its gold with an empty evidence section, and
 * no reader could tell that from a retrieval failure. The guard refuses the state rather
 * than discovering it in a reading.
 *
 * A fraction is refused for the reason the width's fraction is: the unit is characters of
 * text, and `1.5` completes a run whose cap is not the number it names.
 *
 * ## Why one reader for the width and the marker
 *
 * The grammar (`<width>`, `<width>:<marker>`, blank or `none`) makes them one value, so two
 * readers would have to agree about where the split is. The marker is enumerated from
 * `TURN_CUT_MARKERS` and refused when unknown, for the reason every guard in this file gives --
 * a run dispatched to mark its cuts that rendered them silently would publish an unchanged
 * number reading as evidence that the mark does not matter.
 *
 * `none` as a spelling of "no cap" is kept from the original reader because §10.3 registers the
 * adopted configuration that way and a dispatch must be able to send the value its registration
 * names.
 */
function readTurnCap(raw: string | undefined): TurnCapSpec {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '' || trimmed.toLowerCase() === 'none') {
    return { marker: DEFAULT_TURN_CUT_MARKER };
  }

  const parts = trimmed.split(':');
  const widthText = parts[0] ?? '';
  const markerText = parts[1];
  if (parts.length > 2) {
    throw new Error(
      `${MAX_TURN_CHARS_VARIABLE} takes one optional marker, got ${JSON.stringify(raw)}. ` +
        'The grammar is `<width>` or `<width>:<none|ellipsis>`; the marker is a presentation ' +
        "of the cap's cut, so it cannot be a list.",
    );
  }
  if (markerText !== undefined && !(markerText in TURN_CUT_MARKERS)) {
    throw new Error(
      `${MAX_TURN_CHARS_VARIABLE}'s marker must be one of ` +
        `${Object.keys(TURN_CUT_MARKERS)
          .map((k) => JSON.stringify(k))
          .join(', ')}, got ` +
        `${JSON.stringify(raw)}. An unrecognised marker is rejected rather than ignored: the ` +
        'run would render every cut silently while its config claimed a mark, and its result ' +
        'would read as evidence that the mark does not matter.',
    );
  }

  const value = Number(widthText);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${MAX_TURN_CHARS_VARIABLE} must be a positive integer or unset, got ` +
        `${JSON.stringify(raw)}. The unit is characters per turn, and a cap of 0 emits every ` +
        'turn number with no text after it while every coverage count still reports the ' +
        'turns as they arrived -- a prompt that reads as empty evidence and an artifact ' +
        'that reads as a delivery. The optional suffix is the marker: `<width>:ellipsis` ' +
        'prints a mark of omission where the cap cut.',
    );
  }

  return {
    width: value,
    marker: markerText ?? DEFAULT_TURN_CUT_MARKER,
  };
}

/**
 * Read the routes the cap reaches: `all` (default), `none`, or a comma-separated list of names.
 *
 * ## Why three spellings rather than two
 *
 * `all` is the shipped state and is what §10.3 registers, so a dispatch can send the value the
 * registration names rather than relying on a blank resolving to it through a different path --
 * the defect §13.69 records for `maxTurnChars: none`. `none` is a reach of **nothing**, which is a
 * different statement from absence and is the only way to configure a cap the run does not apply.
 * Collapsing them into one would make the config line unable to say which it was.
 *
 * ## Why an unknown name is rejected
 *
 * Because the failure is silent otherwise. A typo would run the cap on five routes while the
 * artifact said six, and every number in the run would be consistent with the claim -- the §7.4
 * side-channel defect, in the one field where the artifact is the only witness.
 */
function readMaxTurnCharsRoutes(raw: string | undefined): readonly string[] {
  return readRouteReach(raw, MAX_TURN_CHARS_ROUTES_VARIABLE);
}

/**
 * Read a route reach: `all`, `none`, or a comma-separated list of route names.
 *
 * Shared by the cap's reach and the role filter's, because the semantics are identical and two
 * copies would eventually disagree about `none` or about ordering. The variable name is a
 * parameter so each caller's rejection names the input the operator actually set.
 */
function readRouteReach(raw: string | undefined, variable: string): readonly string[] {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return ALL_TURN_CAP_ROUTES;
  if (trimmed.toLowerCase() === 'none') return [];
  const named = trimmed.split(',').map((part) => part.trim());
  for (const name of named) {
    // `Object.hasOwn`, not `in`. The table is an object literal, so `in` also answers true for
    // every inherited member -- `toString`, `constructor`, `__proto__` -- and such a name would
    // pass validation and then be dropped by the filter below, which is exactly the silent
    // five-of-six application the message argues against. §13.198 gave the table a second reader
    // in `llm-factory`, and the same hole was there; both sides were fixed together.
    if (!Object.hasOwn(TURN_CAP_ROUTES, name)) {
      throw new Error(
        `${variable} must be "all", "none", or a comma-separated list of ` +
          `${Object.keys(TURN_CAP_ROUTES)
            .map((route) => JSON.stringify(route))
            .join(', ')}; ` +
          `got ${JSON.stringify(raw)}. An unrecognised route is rejected rather than ignored, ` +
          'because a run that applied the filter to five of six routes would report every ' +
          'number consistent with having applied it to six.',
      );
    }
  }
  // De-duplicated and ordered by the product's own list, so two spellings of one reach produce
  // one config line and the artifact does not distinguish `flat,temporal` from `temporal,flat`.
  return ALL_TURN_CAP_ROUTES.filter((route) => named.includes(route));
}

/**
 * Read the roles the evidence may be built from, or `undefined` for no filter.
 *
 * Blank and `all` are the identity, which is the state every archived run is in. `none` is
 * **refused** rather than read as the empty list: the product rejects an empty list because it
 * admits no evidence at all, so a run that spelled `none` would fail at construction with a
 * message about a different layer. Rejecting it here names the input.
 */
function readEvidenceRoles(raw: string | undefined): readonly string[] | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return undefined;
  const named = trimmed
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (named.length === 0) {
    throw new Error(
      `${EVIDENCE_ROLES_VARIABLE} must be "all" or a comma-separated list of ` +
        `${EVIDENCE_ROLE_ORDER.map((role) => JSON.stringify(role)).join(', ')}; ` +
        `got ${JSON.stringify(raw)}.`,
    );
  }
  for (const name of named) {
    if (!(name in EVIDENCE_ROLES)) {
      throw new Error(
        `${EVIDENCE_ROLES_VARIABLE} must be "all" or a comma-separated list of ` +
          `${EVIDENCE_ROLE_ORDER.map((role) => JSON.stringify(role)).join(', ')}; ` +
          `got ${JSON.stringify(raw)}. \`none\` is refused because an empty role set admits ` +
          'no evidence at all: omit the input to run unfiltered, which is the state every ' +
          'archived run is in.',
      );
    }
  }
  // De-duplicated and in the vocabulary's order, for the reason the reach is: one configuration
  // must have one spelling in the artifact's line.
  return EVIDENCE_ROLE_ORDER.filter((role) => named.includes(role));
}

/**
 * Read how many turns a session budget admits, defaulting to unbounded.
 *
 * The blank rule is `readNumeric`'s; `Infinity` is the honest default because
 * `selectSessionBudget` returns every session that fits and the identity
 * configuration presents all of them.
 */
function readSessionBudget(raw: string | undefined): number {
  const value = readNumeric(raw);
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${BUDGET_VARIABLE} must be a non-negative integer or unset, got ${JSON.stringify(raw)}. ` +
        'The unit is turns, and selectSessionBudget returns [] for a budget <= 0 — which ' +
        'abstains on every question for a reason no artifact records.',
    );
  }
  return value;
}

/**
 * Read the ceiling of the value function, defaulting to the hardcoded `0.5`.
 *
 * The blank rule is `readNumeric`'s, so an unfilled dispatch input arrives as
 * "not configured" and falls back to `DEFAULT_SOURCE_TRUST` -- the value every
 * prior run effectively used. Blank is deliberately NOT read as `0`: `0` is a
 * meaningful configuration ("trust nothing", which admits nothing and abstains on
 * every question) and collapsing the two would make the historical default
 * unreachable while looking identical to "left alone". `'0'` stays expressible,
 * which is the mirrored-defect rule from `readNumeric`'s docstring.
 *
 * The range check matches the thresholds' and exists for the same three reasons,
 * with one addition specific to this field: because the value function is
 * `confidence * sourceTrust * (0.5 + 0.5 * recency)`, a `sourceTrust` above `1`
 * makes the model's own ceiling `1` unattainable-but-exceedable, so the number in
 * the artifact would no longer describe the bound the code enforced.
 */
function readSourceTrust(raw: string | undefined): number {
  const value = readNumeric(raw);
  if (value === undefined) return DEFAULT_SOURCE_TRUST;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `${SOURCE_TRUST_VARIABLE} must be a number in [0, 1], got ${JSON.stringify(raw)}. ` +
        'It scales the value function confidence * sourceTrust * (0.5 + 0.5 * recency), so it ' +
        'sets the ceiling the thresholds are compared against: above 1 the model bound no longer ' +
        'holds, below 0 or NaN admits nothing — each completing a full run whose result describes ' +
        'the argument.',
    );
  }
  return value;
}

/**
 * Projects the parsed options onto the persisted report field.
 *
 * `Infinity` becomes `null`, and the conversion happens here rather than at
 * `JSON.stringify` time. `JSON.stringify(Infinity)` is `null`, so an artifact that
 * carried `Infinity` in memory would be re-read as `null` while a comparison made
 * in the same process still saw `Infinity` — the persisted form and the live form
 * would disagree, and only one of them is what a reader downloads. Stating `null`
 * on the way in makes the persisted form the only form.
 *
 * Both thresholds are projected verbatim. They are already validated `[0, 1]`
 * numbers and have no unrepresentable value, so there is nothing to convert — and
 * converting them would be the bug this field exists to close. The arm's
 * `retrievalThreshold` reached the report only after run `37094200823` published a
 * `6.40%` feature accuracy whose artifact described its configuration as
 * `threshold=0`, i.e. as the identity gate, while the retrieval decision the
 * docstring promised was not being made at all.
 *
 * `sourceTrust` is projected for the same reason, and it is emitted even when it
 * holds the default. Omitting a defaulted field would make "this run left the
 * ceiling alone" and "this artifact predates the field" the same bytes, which is
 * precisely the ambiguity `37110579101` created when it reproduced `37094200823`'s
 * number without either artifact naming the ceiling.
 */
/**
 * Refuse a reranker that the arm's ranking cannot reach.
 *
 * ## Why this is a refusal and not a warning
 *
 * The stage reorders the retrieved pool, and the pool exists only when a relevance signal builds
 * one: with `relevanceSignal: none` the budget spends arrival order, and with `retrieval-session` the
 * score is a **session** constant projected onto its turns — neither has a pool for a cross-encoder
 * to permute. Configuring `CORTEX_MEMORY_RERANK=on` in either state produces an arm whose artifact
 * names a stage that provably never ran, and whose delta would then be read as the reranker's
 * verdict. That is the inert-configuration defect `retrievalThreshold: 0.25` cost a round for
 * (§10.10), and the test is cheap.
 *
 * Throwing rather than logging: a run that is provably incapable of administering its treatment must
 * not produce a number at all. The dispatch is one line away from correct, and the message says which
 * line.
 */
/**
 * The reranking record the artifact carries, assembled from what the run actually built.
 *
 * ## Why this is here rather than at the call site
 *
 * The assembly is a decision, not plumbing: the control must be spelled `provider: 'none'` while the
 * treatment must carry the identity **and** the census **and** the declared wire limits, and those
 * three travel together because any two of them alone is the ambiguity §13.115 exists to remove. The
 * CLI is excluded from coverage as an entry point, so a branch written there would be a branch no test
 * could reach -- the defect `bench-arm-options.ts` was written about, where "deleting it, defaulting
 * it on, or reading the wrong environment variable each left every test green".
 *
 * `census` is threaded only for a real stage: a control has nothing to count, and a zeroed census would
 * claim the stage ran and found nothing.
 */
export function toRerankRecord(
  identity: RerankIdentity,
  bounds: RerankBounds,
  census: RerankCensus | undefined,
): NonNullable<MemoryArmConfig['rerank']> {
  if (identity.provider === 'none') {
    return { provider: 'none' };
  }
  return {
    ...identity,
    bounds,
    ...(census === undefined ? {} : { census }),
  };
}

export function assertRerankReachesRanking(
  relevanceSignal: string,
  rerank: MemoryArmConfig['rerank'] | undefined,
): void {
  if (rerank === undefined || rerank.provider === 'none') {
    return;
  }
  // `retrieval-anchored` is included because the reranker runs over its pool too: restoration is
  // downstream of the stage, so enabling both means the cross-encoder reorders the retrieved pool and
  // the neighbourhoods are restored around the anchors that reordering produced.
  if (
    relevanceSignal === 'retrieval' ||
    relevanceSignal === 'retrieval-hybrid' ||
    relevanceSignal === 'retrieval-anchored'
  ) {
    return;
  }
  throw new Error(
    `CORTEX_MEMORY_RERANK is enabled but relevanceSignal="${relevanceSignal}" builds no ranked pool ` +
      'for the stage to reorder, so the reranker would never fire and the artifact would name a ' +
      'treatment that did not run. Set CORTEX_MEMORY_RELEVANCE=retrieval, retrieval-hybrid or ' +
      'retrieval-anchored, or leave the reranker off.',
  );
}

export function toMemoryArmConfig(
  options: CortexMemoryArmOptions,
  /**
   * The embedding backend the run will be graded against, when the caller knows it.
   *
   * A parameter rather than a read of the environment from here, because this module
   * never constructs a backend: `bench/run-ablation.ts` builds one from the environment
   * and is the only layer that can say what it built. Passing it keeps the fact where it
   * is known, and the field is optional so every existing caller keeps compiling and its
   * artifact keeps reading as "predates the field".
   */
  embedding?: MemoryArmConfig['embedding'],
  /**
   * How far §13.97's expansion reached, when the run administered it.
   *
   * Measured by the caller rather than derived from the option, for the reason `embedding`
   * is: the counts exist only in the process that made the model calls, and an option
   * projection cannot invent them. Absent means the control ran, which is a different fact
   * from a treatment that reached zero questions.
   */
  expansion?: MemoryArmConfig['queryExpansionCounts'],
  /**
   * Which reader will answer, when the caller knows it.
   *
   * A parameter for the reason `embedding` is one: this module never constructs a reader, so
   * only `bench/run-ablation.ts` can say which model it built. `PREREGISTRATION` §13.110 is
   * the run that made it necessary -- two artifacts 7.20 points apart with identical blocks.
   */
  reader?: MemoryArmConfig['reader'],
  /**
   * The reranking stage the index was built with, and what it reported.
   *
   * A parameter for the reason `reader` and `embedding` are: this module never constructs a scorer,
   * so only `bench/run-ablation.ts` can say which model answered or what the counters reached. It is
   * a single record rather than two parameters because the identity without the census is the
   * ambiguity §13.115 exists to remove -- an artifact naming a model it may never have consulted.
   */
  rerank?: MemoryArmConfig['rerank'],
  /**
   * Which judge graded this run, when the caller knows it.
   *
   * A parameter for the reason `reader` is one: this module never constructs a judge, so only
   * `bench/run-ablation.ts` can say which model scored the answers. §13.312 is the section that made
   * the fact necessary -- two artifacts graded by two judges, compared as if one instrument had
   * produced both, with a 34.5-point difference between the verdicts on the question type whose gold
   * is a criterion rather than an answer.
   */
  judge?: MemoryArmConfig['judge'],
): MemoryArmConfig {
  return {
    threshold: options.threshold,
    retrievalThreshold: options.retrievalThreshold,
    sessionBudget: Number.isFinite(options.sessionBudget) ? options.sessionBudget : null,
    sourceTrust: options.sourceTrust,
    confidenceSignal: options.confidenceSignal,
    promptContract: options.promptContract,
    // `?? []` rather than `?? []`-by-accident: the contract is validated against
    // `PROMPT_CONTRACTS` on the way in, so an unknown name cannot arrive here from a
    // dispatch. The fallback exists for a caller that constructs options directly, and
    // it reports "reached nothing" rather than "reached everything", because the two
    // mistakes are not equal -- claiming a treatment that was not administered is the
    // defect this field was added to close, and claiming one that was is merely a
    // missing list.
    renderingRoutes: RENDERING_ROUTES[options.promptContract] ?? [],
    // §13.279. Spread conditionally in both halves: an absent assembly is the shipped order and
    // the control's own state, so an always-present `assemblyRoutes: []` would be a claim the
    // pre-§13.279 artifacts cannot make either.
    ...(ASSEMBLY_BY_CONTRACT[options.promptContract] === undefined
      ? {}
      : { promptAssembly: ASSEMBLY_BY_CONTRACT[options.promptContract] as string }),
    assemblyRoutes: ASSEMBLY_ROUTES[options.promptContract] ?? [],
    ask: options.ask,
    reviewPass: options.reviewPass ?? 'none',
    // Recorded unconditionally rather than only when true: "the control ran" and "the field predates the run" are
    // the same bytes otherwise, and this field exists because a claim of treatment nobody can check is the defect
    // the whole `featureConfig` block was added to close.
    reviewBareDecline: options.reviewBareDecline === true,
    // §13.334. Always present, for the reason every field above is: `off` is the state of every archived run and also
    // what a blank switch selects, so an artifact that spelled nothing would leave "ran the control" and "predates the
    // field" as the same bytes -- and the arm that carries the repair would have no contrast.
    replyRepair: options.replyRepair ?? 'off',
    // The evidence source. Always present, like every field whose absence would otherwise be
    // ambiguous: `corpus` is the state of every archived run, and it is also what a dispatch
    // that leaves the switch blank selects -- so an artifact that spelled nothing would leave
    // "graded the shipped corpus" and "predates the field" as the same bytes, and the one
    // reading that matters (`'gold-sessions'`) would have no contrast on the page.
    evidenceSource: options.oracleEvidence ? ('gold-sessions' as const) : ('corpus' as const),
    // §13.97. Always present for the reason `reviewPass` is: `none` is a state a run can be
    // dispatched to, so an artifact that spelled nothing would leave "ran the control" and
    // "predates the field" as the same bytes.
    queryExpansion: options.queryExpansion ?? 'none',
    // §13.101. Always present for the reason `queryExpansion` is: `none` is a state a run can be
    // dispatched to, so an artifact that spelled nothing would leave "ran the control" and
    // "predates the field" as the same bytes.
    selfConsistency: options.selfConsistency ?? 'none',
    // §13.97's reach. Spread conditionally because the absent state is "the control ran", and
    // a zeroed object would answer a question the run never asked.
    ...(expansion === undefined ? {} : { queryExpansionCounts: expansion }),
    askRoutes: ASK_ROUTES[options.ask] ?? [],
    // Projected rather than inferred from the signal name, for the reason the two
    // thresholds are projected verbatim: the width is a separate claim about the same
    // run, and a reader recomputing it from the name would have to know this module's
    // constants to do it.
    relevanceSignal: options.relevanceSignal,
    relevanceTopK: options.relevanceTopK,
    // Projected rather than inferred, for the reason the width is: the unit is a separate
    // claim about the same budget, and a reader recomputing it from the signal's name
    // would have to know this module's constants to do it. §13.27's artifact is read by
    // comparing this field against §13.26's, so it has to be on the record.
    relevanceUnits: options.relevanceUnits,
    // §13.257. Conditional on the signal rather than unconditional, because the numbers describe a
    // mechanism that only this signal runs: projecting them for `retrieval` would put a decay on the
    // record of a run that restored nothing. Resolved through the module's own resolver, so the
    // artifact states the values the pool was built with rather than a second reading of the
    // defaults -- the drift this field exists to make impossible.
    ...(options.relevanceSignal === 'retrieval-anchored'
      ? { anchors: resolveAnchorParameters({}) }
      : {}),
    // §13.68. Spread conditionally for the reason the optional fields above are: an absent
    // cap is a run that carried none, and a present-but-undefined key would read as
    // configured to every `!== undefined` check downstream and as pre-dating-the-field to a
    // reader of the JSON.
    ...(options.maxTurnChars === undefined ? {} : { maxTurnChars: options.maxTurnChars }),
    // §13.81. Absent means the product default, which is what every archived run used, so the
    // absence is a fact about the run rather than a missing field -- but which default is a
    // question the bytes do not answer, and `effectivePromptChars` below answers it.
    ...(options.maxPromptChars === undefined ? {} : { maxPromptChars: options.maxPromptChars }),
    // §13.239. Absent means one room for every route, which is what every archived run used, so the
    // absence is a fact about the run rather than a missing field -- and a reader who wanted to know
    // whether a delta came from a redistribution could otherwise not tell it from a lost field.
    ...(options.maxPromptCharsByRoute === undefined
      ? {}
      : { maxPromptCharsByRoute: options.maxPromptCharsByRoute }),
    // §13.299. Always present, and the only field here that is computed rather than projected.
    //
    // The two fields above describe how the room was *requested*; neither describes the room the
    // prompt was *assembled under*, because the resolution has a third term the artifact cannot
    // see -- the product default -- and that term moved from 24,000 to 48,000 in §13.82. So an
    // artifact whose only room field is `maxPromptCharsByRoute` describes a run at 48,000 and a
    // run at 24,000 with the same bytes, and `42355323615` is exactly that shape: five routes took
    // the default and one took 48,460, while the artifact recorded `{multi-session: 48460}` and
    // nothing else. `tools/cost-ledger.py` read that as *uncapped*, in the row whose whole purpose
    // is to say whether the window was filled.
    //
    // Resolved here through the same three-term expression the product's `#promptCharsFor` uses,
    // rather than by reading `DEFAULT_MAX_PROMPT_CHARS` after the fact, so the artifact states the
    // room each of the six routes assembled under and a reader does not have to reconstruct it.
    effectivePromptChars: Object.fromEntries(
      ALL_TURN_CAP_ROUTES.map((route) => [
        route,
        options.maxPromptCharsByRoute?.[route] ?? options.maxPromptChars ?? PROMPT_ROOM_DEFAULT,
      ]),
    ),
    // §13.73. Always present, unlike the width: the reach is a statement about the run's intent
    // that survives the cap being absent, and a reader comparing two artifacts needs to see that
    // the second one reached two routes where the first reached six.
    ...(options.maxTurnCharsRoutes === undefined
      ? {}
      : { maxTurnCharsRoutes: options.maxTurnCharsRoutes }),
    // §13.187.6D. Always present, unlike the width: `none` is a state the run was dispatched to
    // (this experiment's control), and the artifact that answered it has to be distinguishable
    // from one that predates the field. Projected from the option rather than parsed again, so
    // the config line and the prompt cannot disagree about which marker was rendered.
    turnCutMarker: options.turnCutMarker ?? DEFAULT_TURN_CUT_MARKER,
    // §13.83. Absent means every role, which is what every archived run read; the routes are
    // always present for the reason the cap's are.
    ...(options.evidenceRoles === undefined ? {} : { evidenceRoles: options.evidenceRoles }),
    ...(options.evidenceRolesRoutes === undefined
      ? {}
      : { evidenceRolesRoutes: options.evidenceRolesRoutes }),
    // Spread conditionally rather than assigned, for the reason the two options above
    // are spread conditionally in the constructor: an always-present key holding
    // `undefined` is indistinguishable from a missing one under this workspace's
    // `exactOptionalPropertyTypes`, and the distinction -- a run that named no backend
    // versus an artifact that predates the field -- is the one the type exists to keep.
    ...(embedding === undefined ? {} : { embedding }),
    // Same rule and the same reason as `embedding`: a run that named no reader and an artifact
    // that predates the field are different facts, and only the conditional spread keeps them so.
    ...(reader === undefined ? {} : { reader }),
    // Same rule again. The arm's producer always passes one (`provider: 'none'` for the control), so
    // an artifact without this key is one written before §13.115 rather than a run that declined the
    // stage -- which is why the field is not defaulted here.
    ...(rerank === undefined ? {} : { rerank }),
    // Same rule once more (§13.312). The arm always passes one, so an artifact without this key is
    // one written before the judge's identity was recorded -- and that absence is itself the fact
    // that made the `M1` pair unreadable rather than a missing nicety.
    ...(judge === undefined ? {} : { judge }),
  };
}

/**
 * Resolve the embedding-cache path the arm should use, treating blank as absent.
 *
 * `undefined` and `''` are collapsed into one answer deliberately. GitHub passes
 * an unfilled `workflow_dispatch` input as the empty string rather than as an
 * absent variable, and for a PATH the difference is not cosmetic: `''` resolves
 * to the working directory, so a write to `''` is a failed stat on a directory
 * and a write to `''` under a different cwd is a stray file nobody looks for. The
 * read side has the mirror problem — `existsSync('')` is false, so a blank value
 * silently disables the restore, which is the defect this module was written to
 * close. Collapsing both spellings of "not configured" into `undefined` makes the
 * behaviour independent of which one the caller happened to hand over.
 *
 * `firstNonEmpty` in `embedding-factory.ts` draws the same line for credentials
 * and `readToggle` draws it for switches; this is the same rule applied to a path.
 */
export function cortexMemoryArmEmbeddingCachePath(env: CortexMemoryArmEnv): string | undefined {
  const raw = env['EMBEDDING_CACHE_PATH'];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw;
}

/**
 * Restore a persisted embedding cache into the process-wide cache the retrieval
 * functions read, and report how many vectors were absorbed.
 *
 * Returns a COUNT rather than nothing, and returns `0` rather than throwing, for
 * a reason specific to what this arm is: it exists to produce a report, and a
 * cache it cannot read is not a reason to fail — re-embedding is the recovery
 * path, not a failure mode. `deserializeEmbeddingCache` throws on a corrupt or
 * incompatible buffer on purpose (a stale cache must never be silently trusted),
 * so the decision to swallow that here has to live somewhere, and `cortex-eval`
 * rather than the excluded CLI is where a decision can be tested.
 *
 * The count is what makes the restore observable. A silent restore that in fact
 * did nothing is indistinguishable from a working one in every downstream number:
 * both produce a valid report, and the difference between them is a few cents of
 * embedding quota and a `429`. Recording the number lets the entry point say
 * `Restored N embedding vectors` — the same line `bench/run.ts` logs — so a run
 * whose cache did not load says `0` in its own log.
 *
 * `mergeEmbeddingCache` is what does the work, and its direction is load-bearing:
 * entries already present win, so a stale file can never override a vector this
 * process computed. Without that, an arm that restored at the wrong moment would
 * grade its two sides against inconsistent evidence.
 */
export function restoreArmEmbeddingCache(
  path: string | undefined,
  provenance: EmbeddingProvenance,
): number {
  // The blank check is repeated here rather than left to the caller. These two
  // functions accept a `string | undefined`, not a parsed environment, so a
  // caller may hand over the raw variable. Every other "not configured" spelling
  // was already collapsed by `cortexMemoryArmEmbeddingCachePath`, and `''` is not
  // a path on any filesystem -- `readFileSync('')` throws ENOENT, which would
  // make this return the right number for the wrong reason.
  if (path === undefined || path.trim() === '') {
    return 0;
  }
  try {
    const persisted = deserializeEmbeddingCache(readFileSync(path), provenance);
    mergeEmbeddingCache(persisted);
    return persisted.size;
  } catch {
    // Deliberately both catch and read: `readFileSync` throws ENOENT for an
    // absent file and `deserializeEmbeddingCache` throws for a foreign one, and
    // both mean the same thing to this arm -- "start from an empty cache".
    return 0;
  }
}

/**
 * Persist the shared embedding cache so a later run can skip the provider.
 *
 * Named for the cache rather than for the arm because both entry points publish
 * this file. `cortex-memory/bench/run-ablation.ts` and `cortex-eval/bench/run.ts`
 * are separate processes that share `EMBEDDING_CACHE_PATH` and, through the
 * workflow's Actions cache, one entry -- so a rule about what may be published is
 * a rule about the file, not about either caller. It sits next to
 * `restoreArmEmbeddingCache` because they are the two halves of that contract.
 *
 * ## A write that would lose vectors is not a write
 *
 * This used to write even when the cache was EMPTY, and the reasoning was stated
 * as a choice: "an empty file is a true statement ('this run embedded nothing');
 * a stale file is a false one", the concern being that skipping the write would
 * leave a previous run's file in the workspace and the next run would restore
 * vectors for turns this run never saw. The reversal here is forced by what that
 * reasoning could not see: **the file in the workspace is not the only copy**.
 * The workflow publishes it to the Actions cache under a key fresher than any
 * before it, so "a true statement" was in practice "the newest entry in the
 * cache store", and the next run's prefix restore prefers the newest.
 *
 * Two such entries are in the store now, and both are 200-odd bytes:
 *
 * | cache | size | run | why the snapshot was empty |
 * | --- | --- | --- | --- |
 * | `9050669935` | 216 B | `38908223281` | threw in `cortextMemoryArmOptions` before the restore |
 * | `8943694690` | 212 B | `38582212737` | hung before its first embed |
 *
 * 216 bytes is a compressed copy of the thirteen-byte header
 * `serializeEmbeddingCache` emits for an empty map, so the size alone identifies
 * the contents. Each of those runs ALSO overwrote the populated file the workflow
 * had just restored into the same directory, destroying the workspace copy as
 * well as publishing the empty one -- the salvage path calls this function on the
 * way out, which is exactly when the in-memory cache is most likely to be empty.
 *
 * Both were harmless while nothing read a run-keyed key (see
 * `tools/__tests__/test_embedding_cache_key.py` for that half). They stop being
 * harmless the moment the key coupling is repaired, because the repair makes the
 * newest entry the entry every run reads, and an empty newest entry would send
 * the next run back to embedding ~270k texts from an exhausted account.
 *
 * The counter-argument about the dataset is answered by the cache KEY rather than
 * by the file: the key carries `hashFiles` of the dataset, so a file embedded
 * from an older dataset can never be restored under a newer dataset's key, and a
 * prefix restore across datasets only ever returns vectors for turn texts that
 * are literally identical -- the same text, the same vector, by definition.
 *
 * So an empty snapshot is written nowhere, and the file on disk is left as the
 * restore left it. Nothing is lost that a write could have preserved.
 *
 * @param path the file to write, or an unconfigured path for a no-op.
 * @returns the number of vectors written, or `0` when nothing was written --
 *   either because the process held none or because no path was configured. The
 *   count exists for the same reason `restoreArmEmbeddingCache` returns one: a
 *   skipped publish and a publish of the whole cache are indistinguishable in
 *   every downstream number, and `describeEmbeddingCachePersist` is what puts the
 *   difference in the log.
 */
export function persistEmbeddingCache(
  path: string | undefined,
  provenance: EmbeddingProvenance,
): number {
  if (path === undefined || path.trim() === '') {
    return 0;
  }
  const snapshot = snapshotEmbeddingCache();
  if (snapshot.size === 0) {
    return 0;
  }
  writeFileSync(path, serializeEmbeddingCache(snapshot, provenance));
  return snapshot.size;
}

/**
 * One line describing what {@link persistEmbeddingCache} did, for an entry point
 * to print.
 *
 * Built here rather than assembled at the call site for the reason
 * `bench-failure.ts` gives about `describeFailure`: `bench/**` is excluded from
 * the coverage boundary, so a sentence assembled there is a sentence no test can
 * execute, and an untestable sentence is how a run that published an empty cache
 * managed to say nothing about it for seven weeks.
 */
export function describeEmbeddingCachePersist(written: number, path: string | undefined): string {
  if (written > 0) {
    return `Embedding cache: persisted ${written} vectors to ${path}`;
  }
  if (path === undefined || path.trim() === '') {
    return 'Embedding cache: not configured, nothing persisted';
  }
  return `Embedding cache: nothing to persist, ${path} left as restored`;
}

/** Options for {@link runCortexMemoryArm}. */
export type CortexMemoryArmRunOptions = {
  /** Independent runs handed to the ablation. Defaults to the ablation's own default. */
  runs?: number;
  /** Significance threshold. Defaults to the ablation's own default. */
  alpha?: number;
  /** Answer scorer. Required in practice: the arm is meaningless without one. */
  scorer?: AnswerScorer;
  /**
   * Workers in flight, and the per-worker instances that answer their questions.
   *
   * Forwarded verbatim to the ablation, which is where the concurrency lives. Absent means
   * one worker -- the serial pass every archived artifact was produced by -- so this option
   * changes nothing about a run that does not name it.
   */
  pool?: AblationPool | undefined;
  /**
   * What the entry point read about the reader's transport (§13.227), recorded in the artifact.
   *
   * Forwarded rather than read here for the reason `pool` is: this module has no environment, and
   * the entry point that DID read the variables is the only thing that can say what the client ran
   * at. Absent means the caller resolved no pace, which is every reference-pipeline invocation.
   */
  readerPacing?: ReaderPacing | undefined;
  /** Fixed timestamp, so a report is reproducible. */
  generatedAt?: string;
  /**
   * The content identity of the dataset file this run graded, as `sha256:<hex>`.
   *
   * Set by the entry point that reads the file, because this function is handed the
   * dataset already parsed -- the bytes are gone by the time it is called. Forwarded
   * into the report rather than logged: the artifact is the only thing that outlives
   * the job, and `AblationReport.datasetFingerprint` states the reasoning.
   */
  datasetFingerprint?: string;
  /**
   * §13.85's policy, so the gold denominator follows the filter the product applied.
   *
   * ## Why the run needs it when the product already has it
   *
   * Two different objects: the product's options decide what reaches the prompt, these decide what
   * the **record** compares the delivery against. The record is built after the run from the
   * capture, in this package, and a measurement that did not know the policy would divide by a
   * denominator the run could never fill -- §13.84's MR read 48.35% that way on a window that had
   * just grown by twenty turns.
   *
   * Absent means every role, which is the state every artifact before §13.84 was produced in.
   */
  evidenceRoles?: readonly string[] | undefined;
  /** Which routes the filter reached, so the denominator follows the same reach. */
  evidenceRolesRoutes?: readonly string[] | undefined;
  /**
   * The switches this run was configured with.
   *
   * Recorded in the report rather than only logged, for §20's reason: two
   * downloaded artifacts differed by 2 questions and neither said which side of the
   * switch it was on, so the delta's sign was uninterpretable and the run was
   * discarded.
   */
  featureConfig?: FeatureConfig;
  /**
   * The arm's own gate configuration.
   *
   * Required, and required rather than optional on purpose: this arm's entire
   * result is conditioned on it, and a caller that forgets it produces an artifact
   * whose numbers cannot be compared against another arm's. Making it required
   * means the omission is a type error at the call site rather than a silently
   * thinner report. The `rerankArmOptions` precedent (`bench-arm-options.ts`) is
   * the same judgement: its B7 field is required so "adding a new caller cannot
   * silently omit it and run the control configuration while believing it enabled
   * the feature."
   */
  /**
   * The turns the ranking offered under a question, or `undefined` when it offered none.
   *
   * ## Why this one field is a handle rather than a value
   *
   * Every other field here is a setting read from the environment, and the reason is
   * stated beside `relevanceSignal`: a callback parsed from a string does not exist, and
   * moving the signal into the CLI would put it in the one file coverage cannot reach.
   * This is the opposite kind of thing -- **a measurement handle**, not a configuration.
   * The index that holds the candidates is built in `bench/run-ablation.ts` and consumed
   * by `CortexMemory`, so the arm is the only place where the candidates and the gold
   * turns are both in scope, and passing the set is the smallest way to get them to meet.
   *
   * The set is the ranking's own answer, not a second derivation: `candidatesFor` returns
   * the keys the lookup is built from, so "in the pool" and "scored above the floor" are
   * one fact with two readers.
   *
   * ## Why it is not on `CortexMemoryOptions`
   *
   * The memory package must not learn the gold. A pool-carrying option there would put
   * the dataset's annotation one field away from the selection, and `relevance-index.ts`
   * spends a paragraph on keeping it out of the signal at all. Eval owns both the index
   * and the gold, so eval is where they may meet.
   *
   * Absent means **no ranking was consulted** -- `relevanceSignal: none` -- and the record
   * then omits `goldOverlap.pool` rather than reporting a zero, which would read as a
   * ranking that surfaced nothing.
   */
  relevancePoolFor?: (question: string) => readonly string[] | undefined;
  memoryArmConfig: MemoryArmConfig;
  /**
   * Optional per-question progress sink, forwarded to the report runner.
   *
   * The arm is the longest-running thing this repository dispatches -- run
   * `37281155088` spent ~52 minutes before an HTTP 402 ended it -- so the runner
   * needs a way to say how far it got. Forwarded rather than consumed here for the
   * same reason the arm delegates everything else: the question index only exists
   * inside the benchmark loop, and a decision written in this file about it would
   * have no test that could reach it.
   */
  onProgress?: BenchmarkProgressCallback;
  /**
   * Wall-clock ceiling for **each pass**, in milliseconds. Absent means no ceiling.
   *
   * A run option rather than a member of `memoryArmConfig`, and the distinction is the
   * artifact's: the config is what the numbers are conditioned on and it is serialized,
   * while a ceiling changes only whether the run finishes. Putting it there would make two
   * artifacts that measured the same thing differ in a field describing neither.
   *
   * §13.30 records why it exists: run `38725510400` hung for over five hours inside the
   * reference pipeline's first question and never ended, and the workflow's own
   * `timeout-minutes: 240` did not fire -- so the durable record was **empty** rather than
   * thin, which is worse than the run before it, whose `TimeoutError` at least reached
   * `catch`.
   */
  budgetMs?: number | undefined;
  /**
   * How much of each record's evidence to carry in the artifact.
   *
   * ## Why a bound exists at all
   *
   * Run `38003036421` completed all four runs of all five hundred questions and
   * then died on the last line of the happy path:
   *
   *     RangeError: Invalid string length
   *         at JSON.stringify
   *
   * A complete measurement, destroyed by a serialization limit. The memory arm
   * carries the evidence unbounded -- `admission.ts` declines to truncate, and
   * this run set `sessionBudget: unbounded`, so every turn that clears the write
   * gate reaches the prompt -- and it carries the evidence **twice**, once in
   * `ablation.featureRetrievedContexts` and once as `questions[].turns[].text`.
   *
   * `§13.11.3`'s predictions need to know *whether* evidence reached a reader and
   * *how much*, not the text of every turn. `§13.12` therefore bounds what is
   * carried while leaving what is measured untouched: `evidenceTurns` and
   * `evidenceChars` are always the unreduced truth, and a reduction is stated
   * with a marker rather than rendered as a shorter context.
   *
   * Absent means carry everything, which is the pre-existing behaviour.
   */
  evidenceBound?: EvidenceBoundOptions;
};

/** What the arm returns: the report, its Markdown, and the delta it measured. */
export type CortexMemoryArmResult = {
  report: AblationReport;
  markdown: string;
  /** Feature accuracy minus baseline accuracy, abstention-aware. */
  delta: number;
  /**
   * Why the feature side abstained, when it can say.
   *
   * `undefined` when the feature system does not expose an abstention census, so
   * this is additive: an arm assembled over a system that cannot attribute its
   * abstentions is unaffected, and its artifact simply lacks the field rather than
   * carrying a fabricated one.
   *
   * It exists because a delta alone cannot distinguish the three mechanisms that
   * produce an abstention. `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.10 is
   * the cost: an arm at `retrievalThreshold: 0.25` moved abstention `+46.40pp`, the
   * movement was written up as the retrieval gate closing, and the gate had never
   * closed once -- the value at that arming is the constant `0.5`, so the cut was
   * inert and all `479` abstentions were the model's. The run's own artifact could
   * not contradict the reading. With this field it can: a census dominated by `llm`
   * says the model declined, and one dominated by `threshold` says the gate did.
   *
   * The reference CLI's `benchmark-report.json` already carries an equivalent
   * census as `decisionReasons`. This is the same shape under this arm's naming,
   * produced by the system rather than reconstructed by the harness -- so the two
   * bench entry points cannot disagree about the same run.
   */
  abstentionReasons?: AbstentionReasons;
};

/**
 * The abstention census: one count per outcome, and the four cover every question.
 *
 * Imported from `report.ts` rather than redeclared, so the arm that produces it,
 * the report that carries it, and the renderer that tables it cannot drift on the
 * key set. Redeclaring the same four keys here would create a second place to be
 * wrong about them, which is the defect `createMemory`'s `stability` field was
 * fixed for (`domain/memory.ts`: "two literals that had to agree and did, in the
 * wrong unit").
 */
type AbstentionReasons = ReportAbstentionReasons;

/**
 * Runs the paired same-instant A/B and returns an attributable artifact.
 *
 * ## The pairing invariant
 *
 * Both sides go through **one** `runAblationReport` call, which evaluates them once
 * each and reuses those metrics for the report tables. That is what makes the pair
 * simultaneous. Two separate `runBenchmark` calls would be a staggered comparison,
 * and `SOTA-BASELINE.md` §6 measures time-of-day drift at 1.7-2.1pp -- larger than
 * most effects this arm could plausibly find. The arm's suite asserts the call
 * shape, because the violation is a property of the call graph and no value in the
 * result exposes it.
 *
 * ## The two guards, and why they reject rather than warn
 *
 * A mis-assembled arm does not fail; it produces a plausible number. Two
 * misassemblies are checkable from the arguments, so they are checked:
 *
 *  - **Identical sides.** Passing the same system twice yields `Δ = 0.00pp`, which
 *    is the same artifact a genuinely-null result produces. §13 recorded exactly
 *    this: two byte-identical arms and a verdict that described the dispatch rather
 *    than the feature. Identity is cheap to test, so the tuple is rejected.
 *  - **Empty dataset.** `wilsonScoreInterval(0, 0)` and a McNemar over no
 *    discordant pairs both return confident-looking values, so a run that graded
 *    nothing would publish an interval over nothing.
 */
/**
 * What one question's census said about the review mechanisms, **as counts**.
 *
 * §13.262: these were booleans, and a boolean is the right unit only at one repetition. A dispatch runs
 * four, so a question is answered four times and can be corrected four times; `4199…` reported
 * `attempted: 469` at the run level against `118` records flagged, and the ratio was the repetition
 * count, not a defect in either side. A count is the unit both ledgers can be held to, and the identity
 * is then exact: the roster's column sums to the run-level tally.
 */
export type ReviewMechanismTrace = { attempted: number; answered: number };

/**
 * What one question's census said about the membership audit, as counts.
 *
 * `changed` is not a synonym for `answered`: an audit that ran and returned the first pass's own answer has
 * a consultation and no change, and that is the state a run needs to be able to report.
 */
type AuditMechanismTrace = { attempted: number; changed: number };

/**
 * Wrap a system so each answer records whether the review mechanisms fired **on that question**.
 *
 * ## Why this exists
 *
 * `recoveryCensus()` and `bareRetryCensus()` answer "how many, so far". A per-question read of the same
 * fact is a delta taken around **one** answer, which means the accessor that already exists is enough --
 * no second counter, and nothing that can drift from the total it is part of.
 *
 * The alternative considered and rejected was to keep a flag inside the product and reset it per question
 * (§13.145.6 option 1's first form): a stateful beacon is stale for every question the mechanism did not
 * touch, so a non-MR question would report the previous MR question's value. A delta cannot be stale,
 * because it is computed from two readings of a monotonic counter.
 *
 * ## Why the wrapper is a prototype chain, with every member delegated
 *
 * `Object.create(system)` rather than `{ ...system }`: a class instance keeps its methods on the
 * prototype, so a spread would copy no method at all and `isSessionAware` -- which tests for
 * `answerSessions` -- would see a flat-only system. The wrapper is also returned unchanged when the system
 * exposes no `recoveryCensus`, so "not measured" stays distinguishable from "did not fire".
 *
 * The chain alone was not enough, and `40984213349` is the run that proved it: a method reached through
 * the chain is called with `this` set to the wrapper, and a wrapper derived from an instance cannot read
 * that instance's private fields. `mirrorMembers` above does the delegation, and the defect is written up
 * there.
 *
 * ## What it does not do
 *
 * It does not filter, reorder or modify an answer. The wrapper's only effect is that the returned map
 * gains one entry per question, and it is keyed by the question string the caller passed -- the same
 * string the record builder is handed, which is what makes the join exact rather than approximate.
 */
export function traceReviewMechanisms(
  system: MemorySystem,
  trace: Map<string, ReviewMechanismTrace>,
): MemorySystem {
  return traceCensus(
    system,
    'recoveryCensus',
    trace,
    (delta) => ({ attempted: delta.attempted, answered: delta.answered }),
    (prev, next) => ({
      attempted: prev.attempted + next.attempted,
      answered: prev.answered + next.answered,
    }),
  );
}

/**
 * Wrap a system so each answer records whether the **membership audit** ran on that question, and whether it
 * moved the answer.
 *
 * ## Why this is a second wrapper and not a wider first one
 *
 * The recovery trace answers "did the corrective consultation fire"; the audit trace answers "did the review
 * disagree with the answer it was handed". They are different populations -- the recovery pass only runs on a
 * decline, the audit only runs on a non-decline -- so a single map keyed by question would have to carry two
 * meanings per entry and every reader would have to know which. Two maps, two types, one implementation each.
 *
 * ## Why the shared implementation is the point
 *
 * The two differ only in the accessor they read and the shape they project. Duplicating the delta, the
 * prototype mirroring and the "an accessor that throws is an instrument that is not there" rule would mean two
 * copies of four decisions, and the campaign has already paid for that shape once: §13.145.5 records a wrapper
 * that read `this` off an instance and silently measured nothing for three runs. One helper, two thin callers.
 */
function traceAuditPass(
  system: MemorySystem,
  trace: Map<string, AuditMechanismTrace>,
): MemorySystem {
  return traceCensus(
    system,
    'auditCensus',
    trace,
    (delta) => ({ attempted: delta.attempted, changed: delta.changed }),
    (prev, next) => ({
      attempted: prev.attempted + next.attempted,
      changed: prev.changed + next.changed,
    }),
  );
}

/**
 * The machinery both traces above share: take a census before and after every `answer*` call and record the
 * difference against the question string the caller passed.
 *
 * ## Why the accessor is a name and not a function
 *
 * A function would be read off the instance once, and the whole point of the read is that it is taken through
 * `this` on every question. The name is resolved inside the wrapper for the same reason `mirrorMembers` exists.
 */
function traceCensus<T>(
  system: MemorySystem,
  accessor: 'recoveryCensus' | 'auditCensus',
  trace: Map<string, T>,
  project: (delta: { attempted: number; answered: number; changed: number }) => T,
  merge: (prev: T, next: T) => T,
): MemorySystem {
  const source = system as Partial<
    Record<typeof accessor, () => { attempted: number; answered?: number; changed?: number } | null>
  >;
  const census = source[accessor];
  if (typeof census !== 'function') return system;
  const traced = mirrorMembers(system);
  // A census that throws is an instrument that is not there, which is the rule the report-level readers
  // already follow (`recoveryOf` turns a throwing accessor into an absent count rather than a failed run).
  // Checked once and then abandoned rather than retried per question: an accessor that throws on the first
  // read throws on the five-hundredth, and a per-question `try` would pay for the same failure every time.
  //
  // §13.268: a census that answers `null` is the same verdict reached on purpose rather than by fault. The
  // product states its own absence that way (`CortexMemory.auditCensus` under `reviewPass: bare`), and the
  // distinction between "no mechanism" and "a mechanism that measured zero" is the whole reason the member
  // exists. It is read as an explicit absence rather than left to the `try`: a `null` that reached
  // `reading.attempted` would throw a `TypeError` and take the same path by accident, which is a behaviour
  // no reader of this function could see.
  let usable = true;
  const readCensus = (): { attempted: number; answered: number; changed: number } | null => {
    if (!usable) return null;
    try {
      const reading = census.call(system);
      if (reading === null) {
        usable = false;
        return null;
      }
      // One shape for two accessors: the recovery census carries `answered` and the audit census carries
      // `changed`, and a projection that had to branch on which one it was holding would be a second place
      // the two can disagree. The absent member reads as zero, which is exactly what a delta over it means.
      return {
        attempted: reading.attempted,
        answered: reading.answered ?? 0,
        changed: reading.changed ?? 0,
      };
    } catch {
      usable = false;
      return null;
    }
  };
  const names = new Set<string>([
    ...Object.getOwnPropertyNames(system),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(system) as object),
  ]);
  for (const name of names) {
    // Every member the harness can dispatch through starts with `answer`; the routing members are
    // `answer`, `answerSessions`, `answerTemporal`, `answerAbstention`, `answerAssistant`,
    // `answerPreference` and `answerKnowledgeUpdate`, and a member added later is covered by the prefix
    // rather than by a list that would have to be edited in step with it.
    if (!name.startsWith('answer')) continue;
    const original = (system as unknown as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    (traced as unknown as Record<string, unknown>)[name] = async (
      question: string,
      ...rest: unknown[]
    ) => {
      const before = readCensus();
      const answer = await (original as (...args: unknown[]) => unknown).call(
        system,
        question,
        ...rest,
      );
      const after = readCensus();
      // No entry when either read failed: the record then omits the fields, and `--treated` reports the
      // question as `unknown` rather than as one the mechanism did not reach.
      if (before !== null && after !== null) {
        // Accumulated, not overwritten: the map is keyed by question and a dispatching run asks each
        // question `runs` times, so the last write would have described one repetition out of four and
        // the roster would disagree with the tally by exactly that factor (§13.262).
        const entry = project({
          attempted: after.attempted - before.attempted,
          answered: after.answered - before.answered,
          changed: after.changed - before.changed,
        });
        const prev = trace.get(question);
        trace.set(question, prev === undefined ? entry : merge(prev, entry));
      }
      return answer;
    };
  }
  return traced;
}

export async function runCortexMemoryArm(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
  options: CortexMemoryArmRunOptions,
): Promise<CortexMemoryArmResult> {
  if (baseline === feature) {
    throw new Error(
      'the arm was handed the same system object for both sides, so the delta would be ' +
        '0.00pp by construction — the artifact would read "the feature does not help" when ' +
        'no feature was supplied. See docs/09-progress-and-delivery-report.md §13.',
    );
  }
  if (dataset.questions.length === 0) {
    throw new Error(
      'the arm was handed a dataset with no questions, so every interval below would be ' +
        'computed over an empty denominator',
    );
  }

  // §13.140: what the provider said this run cost, taken as a difference across the
  // ablation rather than read as a process total. The two arms, the judge and the
  // retry ladder all issue requests through the same adapter, so this number is the
  // whole bill and not the reader's share of it -- which is the only version of the
  // number that can answer "did this change make the run more expensive".
  //
  // Taken BEFORE the ablation call so the arm's own setup -- a preflight, an embedding
  // warm-up -- is included. It is not included today (the adapter's first request is
  // the first answer), but a snapshot taken after the call would silently exclude it if
  // that ever changed, and the exclusion would be invisible in the artifact.
  const usageBefore = llmUsage();
  // §13.216: the transport counters describe THIS arm's passes and nothing before them.
  //
  // Reset here rather than in the entry point, and the placement is the same argument the
  // spend snapshot above makes one line up: the counters live in a process-level aggregate,
  // so without a reset they would include whatever the process did before the first
  // question -- an embedding preflight, a probe, a warm-up -- and the artifact would present
  // that residue as part of the measured run. A number nobody can attribute is worse than no
  // number, because it looks like a measurement.
  //
  // The cost of resetting inside a library function is that a caller measuring something
  // else across this call would lose its own counts. There is no such caller: this function
  // runs the whole ablation, and the CLI's only other question is what to write.
  resetRetryStats();
  // §13.145.6: which questions the review mechanisms reached, taken as a census delta around each answer.
  // The wrapper is a prototype chain and is a no-op for a system with no census, so this changes nothing
  // about what the run measures -- it only makes the population addressable in the artifact.
  const recoveryTrace = new Map<string, ReviewMechanismTrace>();
  // §13.260: the membership audit's own per-question trace. Separate map, separate type, same machinery --
  // this pass runs on non-declines where the recovery pass cannot, so one map keyed by question would carry
  // two meanings per entry.
  const auditTrace = new Map<string, AuditMechanismTrace>();
  // §13.189: the same ledger, read per side. Wrapped on BOTH arms so the split closes against
  // `llmUsage` above; the judge and the phrasing stage land in the residual by construction.
  //
  // §13.262: a tally per side rather than a snapshot, because `42054107910` measured the delta
  // method at 3.43x the whole run's calls under four workers. The pair is built once and handed to
  // every worker, so four concurrent answers credit one ledger instead of four overlapping ones.
  const usageLedger: Record<UsageSide, UsageTally> = {
    baseline: createUsageTally(),
    feature: createUsageTally(),
  };
  // §13.259. Under a pool the ablation answers through the pool's factories, so the two wrappers
  // below are never called -- the pool has to be wrapped instead, and both paths are kept because a
  // serial run is the one every archived artifact was produced by.
  const usagePool =
    options.pool === undefined ? undefined : tracedPool(options.pool, usageLedger, auditTrace);
  const report = await runAblationReport(
    dataset,
    traceUsage(baseline, 'baseline', usageLedger),
    traceAuditPass(
      traceReviewMechanisms(traceUsage(feature, 'feature', usageLedger), recoveryTrace),
      auditTrace,
    ),
    {
      ...(options.runs === undefined ? {} : { runs: options.runs }),
      ...(options.alpha === undefined ? {} : { alpha: options.alpha }),
      ...(options.readerPacing === undefined ? {} : { readerPacing: options.readerPacing }),
      ...(options.scorer === undefined ? {} : { scorer: options.scorer }),
      // Stamped inside `runAblationReport`, after the ablation returns -- never here.
      //
      // This was `generatedAt: options.generatedAt ?? new Date().toISOString()`, which is an
      // ARGUMENT: it is evaluated when the call is made, so the stamp landed before the first
      // question and `runAblationReport`'s own post-run default never ran. Run `40722772896`
      // wrote `16:08:38Z` into a report whose artifact was uploaded at `18:15:55Z`, and a reader
      // auditing that run's duration from the artifact alone gets 92 seconds for 2h08m of work.
      // `PREREGISTRATION` §13.118.5 is where the wrong number was first read.
      ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
      ...(options.datasetFingerprint === undefined
        ? {}
        : { datasetFingerprint: options.datasetFingerprint }),
      ...(options.featureConfig === undefined ? {} : { featureConfig: options.featureConfig }),
      memoryArmConfig: options.memoryArmConfig,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
      // The traced pool, not the caller's: a pooled run answers through this one, and passing the
      // original here is exactly the defect §13.259 registers.
      ...(usagePool === undefined ? {} : { pool: usagePool }),
    },
  );

  // The census is read BEFORE the Markdown is rendered, and put into the report
  // rather than returned beside it. That ordering is the whole point of this
  // block: `formatAblationReport` can only render what the report carries, so a
  // census produced after the render call would persist to JSON and be missing
  // from the document a human reads -- which is `retryFires`' defect for the third
  // time (`report-retry-fires.test.ts`), and exactly the gap §48.11.4 left open.
  //
  // Mutating the report object is safe here because `runAblationReport` just built
  // it and nothing else holds a reference: the return value below is the first
  // exposure. The alternative -- returning the census and having each caller
  // remember to feed it back into a render -- is the side channel this repository
  // has already removed twice.
  // Read immediately after the ablation returns, before any rendering: everything the
  // provider billed for has happened by now, and a snapshot taken after
  // `formatAblationReport` would include the renderer's own calls if it ever made any.
  const usage: UsageSnapshot = usageDelta(usageBefore, llmUsage());
  // §13.244. Every census below is **per-instance** state, and a pool gives each worker its own
  // instance -- so reading them off `feature` reads worker 0's share of the run. `41773546221`
  // published `llm=28, answered=460` for 2,000 question-answers; 488 is 122 per pass, which is
  // exactly what worker 0 claims out of 500 at four workers, and it looked plausible enough that
  // only the artifact's own `census-unit` check caught it.
  const censusSystems = censusSourcesOf(feature, options.pool);
  const census = {
    ...abstentionReasonsAcross(censusSystems),
    ...recoveryAcross(censusSystems),
    ...bareRetryAcross(censusSystems),
    ...replyRepairAcross(censusSystems),
    ...auditAcross(censusSystems),
  };
  const questions = buildArmRoster(
    dataset,
    report.ablation,
    options.featureConfig,
    options.evidenceBound,
    // §13.85's policy travels beside the pool, because the denominator and the numerator are two
    // halves of one measurement and a caller that passed one without the other would publish a
    // ratio between populations.
    {
      ...(options.evidenceRoles === undefined ? {} : { roles: options.evidenceRoles }),
      ...(options.evidenceRolesRoutes === undefined ? {} : { reach: options.evidenceRolesRoutes }),
    },
    options.relevancePoolFor,
    recoveryTrace,
    auditTrace,
  );
  // Derived from the records rather than tallied while building them, so the
  // manifest and the records it describes cannot disagree (`evidenceReductionOf`).
  // `null` means no record was reduced, which is a different fact from "a bound
  // was applied and dropped nothing" -- `§13.12.5` predicts the reducible set is
  // non-empty, and this field is what makes that prediction falsifiable.
  const evidenceReduction = evidenceReductionOf(questions);
  // §13.101's census, read after the ablation for the reason `abstentionReasonsOf` is: it counts what
  // happened rather than what was configured. Merged into the arm's config rather than carried at the
  // top level because the configuration line renders it beside the count that produced it.
  const vote = voteCountsAcross(censusSystems);
  const reported: AblationReport = {
    ...report,
    // The evidence is carried twice, and the registered bound has to reach both
    // copies. `buildArmRoster` above bounded `questions[].turns`; this is the
    // other copy, and run `38044858147` measured what leaving it alone costs --
    // a 258 MB artifact in which the records were down to seventeen turns each
    // while 256 MB of it was this vector, untruncated. Carrying one copy whole is
    // not a bound: it keeps the artifact one order of magnitude from V8's 537 MB
    // string limit, and it makes the writer's own reducer unable to make room
    // (`report-write.ts`'s `withBoundedAblationEvidence` records that failure).
    //
    // Bounded through the same function the records use, so the two copies cannot
    // describe different evidence: the vector's `i`-th entry splits into exactly
    // `questions[i].turns`.
    ablation: {
      ...report.ablation,
      featureRetrievedContexts: boundRetrievedContexts(
        report.ablation.featureRetrievedContexts!,
        options.evidenceBound,
      ),
    },
    ...(census.abstentionReasons === undefined
      ? {}
      : { abstentionReasons: census.abstentionReasons }),
    // The recovery pass's own tally, spread on the same rule: absent means the system does not
    // carry the pass, which is a different statement from "it fired zero times".
    ...(census.recovery === undefined ? {} : { recovery: census.recovery }),
    // The bare-decline retry's tally, on the same rule and in its own field: it counts a different
    // treatment on a different population, and a run that carries it must be able to say how often it
    // fired without a reader inferring it from an unchanged accuracy.
    ...(census.bareRetry === undefined ? {} : { bareRetry: census.bareRetry }),
    // §13.334's tally, on the same rule and in its own field: it counts a different treatment on populations the
    // retries above cannot see, so a run that carries it must be able to say how often each kind fired without a
    // reader inferring it from an unchanged accuracy.
    ...(census.replyRepair === undefined ? {} : { replyRepair: census.replyRepair }),
    // The membership audit's tally, on the same rule: a `bare` run has no audit to report, and writing
    // `attempted: 0` there would make "this build carries no audit" and "the audit ran and agreed with every
    // answer" produce the same artifact.
    ...(census.audit === undefined ? {} : { audit: census.audit }),
    // Spread conditionally on both sides: a run that did not vote has no census, and a report built
    // without an arm config has nowhere to put one. Either absence means "not measured", which the
    // field's optionality already says.
    ...(vote.voteCounts === undefined || report.memoryArmConfig === undefined
      ? {}
      : { memoryArmConfig: { ...report.memoryArmConfig, voteCounts: vote.voteCounts } }),
    questions,
    ...(evidenceReduction === null ? {} : { evidenceReduction }),
  };
  // §13.140's spend, attached LAST and through a function rather than as a conditional
  // spread in the literal above. The rule it encodes -- a run with no instrumented call
  // omits the field instead of stating zeros -- is a claim about what absence means, and
  // this repository has already paid three times for such a rule living in a spread at a
  // call site: it cannot be tested, so it cannot be wrong out loud.
  // The split is attached after the total, so the section that renders both reads them from one
  // place and the two cannot disagree about which run they describe.
  //
  // §13.308: the price of a correct answer follows the split, because it divides the split's feature
  // column by an accuracy the ablation already computed. Attaching it here rather than inside the
  // renderer is the same argument the two calls above record: a reading produced at render time
  // describes the moment of rendering, and the JSON and the Markdown must describe one reading.
  const withUsage = attachCostEfficiency(
    attachUsageBySide(attachLlmUsage(reported, usage), {
      baseline: usageLedger.baseline.snapshot(),
      feature: usageLedger.feature.snapshot(),
    }),
  );
  // §13.216: read after everything that talks to a provider has finished, and attached
  // unconditionally -- see `attachTransport` for why this field does not use the absence rule
  // the two above do. Snapshotted here rather than inside the renderer so the JSON and the
  // Markdown describe one reading; a renderer that took its own snapshot would describe the
  // moment of rendering, which is later than the run and would drift with any future work
  // done between the two writes.
  const withTransport = attachTransport(
    withUsage,
    transportRetryReport(retryStats(), { provider: 'run' }),
  );
  return {
    report: withTransport,
    markdown: formatAblationReport(withTransport),
    // Read from the ablation's own aggregate rather than recomputed here, so the
    // returned value cannot disagree with the tables rendered beside it.
    delta: report.ablation.delta,
    ...census,
  };
}

/**
 * Build this arm's per-question roster from its own ablation result.
 *
 * ## Why the arm was the gap
 *
 * `AblationReport.questions` is a declared, documented field whose own docstring
 * names three consumers -- `tools/read-b7-criterion.mjs` executes the
 * pre-registered criterion with it, `compareQuestionVectors` needs two aligned
 * correctness vectors, and a reader asking *which* questions moved needs the ids
 * -- and §12.5's artifact had none of them. The arm never supplied it, and
 * nothing beneath it could: `evaluateWithScorerDetailed` returned `{ metrics,
 * correct }` and discarded the `answers` array `runBenchmark` produced, so the
 * model's output for every question existed during the run and was thrown away
 * before any record could be written. That is the `runs` defect's shape one layer
 * lower, and it is what blocked §55.4's cheapest next step: 30 ABS questions were
 * declined and not one of the 30 outputs survived.
 *
 * ## Why the records are built here and not in `runAblationReport`
 *
 * `questions` is a caller-supplied field by contract: it is absent when nobody
 * supplies one, because `[]` would claim "this run graded zero questions" while
 * absence says "nobody recorded a roster". `runEmbeddingBenchmark` depends on
 * that -- it runs a system with no decision tracing and its own test requires the
 * roster to stay absent rather than be fabricated from an answer vector. So the
 * roster is assembled by the caller that can observe the answers, which is this
 * arm, and it is assembled AFTER the ablation because `featureAnswers` is the
 * ablation's own output.
 *
 * ## Why there is no absent-answer branch
 *
 * This arm is handed an `AblationResult` it produced itself, one line above, by
 * `runAblation` over `runBenchmark` over `scoreEvaluation`. That chain pushes
 * exactly one answer per dataset question and now returns them, so
 * `featureAnswers` is present on every path this function can be reached by. A
 * `?? []` or `if (answers === undefined)` guard here would be dead code that
 * reads as a safety net, which is the shape `report-runner.test.ts` calls out by
 * name: a fallback that can only fire on a misalignment would silently file an
 * unaligned question as abstained. The absent case is the report BUILDER's
 * contract, where it is exercised by every caller that supplies no roster, and it
 * is asserted there (`report-json-roundtrip.test.ts`, `report-runner.test.ts`)
 * rather than duplicated as an unreachable branch here.
 *
 * The read below is therefore an assertion, not a fallback: `featureAnswers` is
 * required to be present because the code path that reaches this function always
 * produces it, and a `!` states that rather than hiding it behind a default.
 *
 * ## What the records can and cannot say
 *
 * `answer` is read from the answer vector rather than from a decision trace,
 * because the answer is what this arm can observe with certainty: it is the value
 * the system returned and the value the scorer graded, so a record built from it
 * cannot disagree with the paired tables rendered beside it. It is carried
 * through verbatim -- `null` stays `null`, which is "the system abstained" and is
 * the finding §55.4 exists to explain; it is never collapsed to a missing field,
 * which would say "nobody recorded an answer" and report the model's behaviour as
 * a recording gap.
 *
 * `turns` is now reportable and no longer an absence. The evidence each reader was
 * shown is captured per question through the benchmark's retrieval hook, so a
 * record carries the turns that reached the model rather than an empty list. This
 * is what makes the question §13 left open askable: "the reader was shown the
 * wrong turn" and "the reader was shown nothing" reach the artifact as different
 * records instead of as the same `turns: []`.
 *
 * A record still reads `turns: []` when the machine declined before a reader was
 * shown anything, which is a true statement about that question and is the same
 * outcome the abstention census files at `empty`.
 *
 * `grounded` is reported since §13.33, and the paragraph that used to stand here said it
 * could not be. It argued that grounding is a property of the upstream failure classifier
 * and that this arm collects no classification, so the records said `false` rather than
 * guessing. The premise was right about the trace product and wrong about this one: the
 * classifier is a published rule over the graded answer and the delivered evidence, both
 * of which this arm holds, so `false` was not a refusal to guess -- it was a value the arm
 * had not measured, reported as if it had.
 *
 * What that cost is specific. `computeTargetCohort` files an ungrounded question under
 * `notGrounded` and excludes it **before** clustering, so a constant made that bucket
 * hold every question of every arm artifact: the published B7 criterion could not be run
 * against this product at all, and a reader would have seen five hundred questions the
 * classifier had called ungrounded. "Nobody classified these" and "these were all
 * ungrounded" are different findings, and the artifact was publishing the second.
 */
/**
 * One question's two accounts: where the gold went, and where the room went.
 *
 * ## Why one function returns both
 *
 * Both are membership tests against **the same pool**, and the pool arrives from a
 * callback the arm does not own (`relevancePoolFor`, which answers from the index's
 * `candidatesFor`). Calling that callback twice would leave two orderings possible in
 * principle and unverifiable in the artifact: a reader holding a record whose `goldOverlap`
 * and `windowComposition` disagree about what the ranking offered would have no way to tell
 * which of the two calls was the stale one. One read, two readers.
 *
 * ## The gold half, and the denominator the run's policy implies
 *
 * `totalAll` is attached only when the eligible set is **smaller** than the dataset's. Length
 * rather than identity: a filter that reaches a question but excludes nothing returns a new list
 * of the same size, and a field saying "the dataset named 2 and the policy admitted 2" is noise
 * standing where a reader looks for a difference.
 *
 * `null` passes through: a question with no gold turns has no ratio, and inventing one here would
 * make "the dataset names no gold" indistinguishable from "none of the gold reached the reader".
 *
 * ## The room half
 *
 * `windowCompositionOf`'s own docblock carries the argument; the point of returning it here is
 * that it is measured against the delivery as captured, before `evidenceBound` reduces it --
 * the same rule `goldOverlap` follows, so a writability guard cannot move either figure.
 */
function accountOf(
  question: BenchmarkDataset['questions'][number],
  retrieved: readonly string[],
  poolFor: ((question: string) => readonly string[] | undefined) | undefined,
  rolePolicy: { roles?: readonly string[]; reach?: readonly string[] } | undefined,
): { goldOverlap: GoldOverlap | null; windowComposition: WindowComposition | null } {
  const eligible = eligibleGoldOf(
    question.goldTurns,
    rolePolicy?.roles,
    rolePolicy?.reach,
    question.capability,
  );
  // Counted before the null check rather than after it, so both `?? 0` arms are reachable: a
  // question with no gold turns at all evaluates them, and that is the only state in which the
  // overlap is null. A `?? 0` inside the returned object would be dead code that reads as a
  // guard -- the shape §57.6 removed a field over.
  const eligibleCount = eligible?.length ?? 0;
  const goldCount = question.goldTurns?.length ?? 0;
  const pool = poolFor?.(question.question);
  const overlap = goldOverlapOf(retrieved, eligible, pool);
  return {
    goldOverlap:
      overlap === null || eligibleCount === goldCount
        ? overlap
        : { ...overlap, totalAll: goldCount },
    windowComposition: windowCompositionOf(retrieved, pool),
  };
}

/**
 * The record fields for one question's mechanism trace, or nothing when it was not traced.
 *
 * The absence case is the load-bearing one: a system with no `recoveryCensus` leaves the map empty, and
 * writing `recoveryConsultations: 0` for every question would turn "this instrument does not apply" into
 * "the mechanism did not fire", which `--treated` would then classify as `untouched` instead of `unknown`.
 *
 * §13.262: the four fields are **counts**, and the names say so. They were `recoveryAttempted` and
 * friends, booleans, which collapsed a question's four repetitions into one and made the column
 * unsummable against the run-level tally -- `4199…` published `attempted: 469` over a roster of 118
 * flags. A count is the unit in which "the tally is the sum of its rows" is an identity rather than a
 * coincidence, and renaming was part of the repair: a field whose unit changed under an unchanged name
 * is the defect this campaign has paid for as `bareRetry`'s silent loss (§13.259).
 */
function traceOf(
  trace: ReadonlyMap<string, ReviewMechanismTrace> | undefined,
  question: string,
  audit?: ReadonlyMap<string, AuditMechanismTrace>,
): {
  recoveryConsultations?: number;
  recoveryAnswers?: number;
  auditConsultations?: number;
  auditChanges?: number;
} {
  const entry = trace?.get(question);
  const reviewed = audit?.get(question);
  const recovery: { recoveryConsultations?: number; recoveryAnswers?: number } =
    entry === undefined
      ? {}
      : { recoveryConsultations: entry.attempted, recoveryAnswers: entry.answered };
  const auditing: { auditConsultations?: number; auditChanges?: number } =
    reviewed === undefined
      ? {}
      : { auditConsultations: reviewed.attempted, auditChanges: reviewed.changed };
  return { ...recovery, ...auditing };
}

function buildArmRoster(
  dataset: BenchmarkDataset,
  ablation: AblationResult,
  featureConfig: FeatureConfig | undefined,
  evidenceBound?: EvidenceBoundOptions,
  /**
   * §13.85's policy, so the gold denominator can follow it.
   *
   * Two arrays rather than the arm's options object, because this function's other parameters are
   * already the narrowest thing each caller needs and an options bag here would make it depend on
   * fields it never reads.
   */
  rolePolicy?: { roles?: readonly string[]; reach?: readonly string[] },
  /**
   * The candidates the ranking offered under a question, or `undefined` when none was.
   *
   * Passed in rather than captured here because this function holds the gold and not the
   * index; the caller holds the index. `MemoryArmOptions.relevancePoolFor` documents why
   * the two meet at this seam.
   */
  poolFor?: (question: string) => readonly string[] | undefined,
  /**
   * Whether the review mechanisms fired on each question, keyed by the question text.
   *
   * Passed in for the reason `poolFor` above is: this function holds the records and the caller holds the
   * trace, and a trace captured here would have to be captured after the pass, when only the last question
   * is reachable. Empty when the system exposes no census, and a question missing from the map writes no
   * field at all -- `false` would be a statement about the mechanism rather than about the instrument.
   */
  recoveryTrace?: ReadonlyMap<string, ReviewMechanismTrace>,
  /**
   * Whether the membership audit ran on each question, and whether it moved the answer.
   *
   * A separate map for the reason {@link AuditMechanismTrace} gives, and passed in for the reason
   * `recoveryTrace` above is: the trace is captured around each answer and the roster is built after the whole
   * pass, so a reader inside this function would see only the last question.
   */
  auditTrace?: ReadonlyMap<string, AuditMechanismTrace>,
): readonly QuestionRecord[] {
  const answers = ablation.featureAnswers!;
  // Captured per question inside the answer loop and carried alongside the
  // answers. Reading `lastRawOutput()` here instead would report the LAST
  // question's text for every record, because the accessor holds one slot and
  // this runs after the whole pass -- the defect the capture hook exists to
  // prevent.
  //
  // A `!` and not a `?? []` guard, for the reason the answer read above states:
  // this arm is handed an `AblationResult` by the chain it called itself, and
  // `runAblation` requests the capture on the line that evaluates the feature, so
  // the vector is present on every path that reaches this function. A guard would
  // be dead code that reads as a safety net and would file a capture that failed
  // as a question whose model was never consulted.
  const rawOutputs = ablation.featureRawOutputs!;
  // The evidence vector, read the same way as the raw-output vector above and for
  // the same reason: this arm is handed an `AblationResult` by the chain it called
  // itself, and `runAblation` requests both captures on the same line with no
  // condition. So the vector is present on every path that reaches this function,
  // and a `?? []` guard here would be the "unreachable code that reads as a safety
  // net" shape -- one that would file a capture that FAILED as a fixture that never
  // retrieved anything.
  //
  // The type still declares it optional, because `AblationResult` is also a report
  // shape tests build by hand; that is a statement about the type, not licence for a
  // branch here. A hand-built `AblationResult` never reaches this function.
  const retrievedContexts = ablation.featureRetrievedContexts!;
  // The other half of the same capture. Read with `!` for the same reason as the
  // context vector: this arm is handed an `AblationResult` by the chain it called
  // itself, and `runAblation` asks for both under one flag on one line. Mapped per
  // question rather than passed whole, because a `null` entry means the system
  // exposes no accessor and must reach the record as *absent*, not as zero.
  const promptEvidenceChars = ablation.featurePromptEvidenceChars!;
  // The offer, captured under the same flag on the same line as the two above. Read
  // with `!` for the same reason, and mapped per question for the same reason: a
  // `null` entry means the system exposes no accessor, and there is no number that
  // honestly stands in for it -- `§13.16` records that a zero would read as a system
  // that admitted nothing, which is the opposite of what an absent accessor says.
  const admittedEvidence = ablation.featureAdmittedEvidence!;
  // The prompt text, captured under the same flag on the same line as the three above.
  // Read with `!` for the same reason, and mapped per question for the same reason: a
  // `null` entry means the system exposes no prompt, and there is no fingerprint that
  // honestly stands in for one -- `promptDigest('')` would be a claim about a request
  // that was never sent.
  //
  // Hashed here rather than in `ablation.ts` or in the benchmark loop because this is the
  // only hop that already imports from `node`, and `prompt-digest.ts` is the only file in
  // this package that imports `node:crypto`. Keeping the hash at the edge keeps the
  // package entry point's import graph host-free.
  const promptTexts = ablation.featurePromptTexts!;
  // §13.174. The same prompt measured across the run's own passes instead of across artifacts. Absent
  // when the ablation ran one pass, and `null` per question when a pass declined to report; both reach
  // the record as absent, which is the rule `promptDigest` follows one field over.
  const promptVariantCounts = ablation.featurePromptVariants;
  return buildQuestionRecords(
    dataset.questions.map((question, i) => ({
      questionId: question.id,
      question: question.question,
      capability: question.capability,
      // Carried through when the question states one, because a time qualifier resolves
      // against this date and nothing else in the artifact records it (§13.152.2). A run
      // whose artifact omits it leaves every window read from that artifact an
      // approximation; the field costs one line here and removes that.
      ...(question.questionDate === undefined ? {} : { questionDate: question.questionDate }),
      groundTruth: question.expected,
      answer: answers[i]!,
      rawOutput: rawOutputs[i]!,
      correct: ablation.featureCorrect[i]!,
      // Reported, not declared unreportable. The §13.33 repair: this arm used to write
      // `false` on the argument that grounding belongs to the upstream failure
      // classifier and no classification is collected here. That argument holds for the
      // *trace* product, whose predicate its caller supplies; it does not hold for this
      // one, because the classifier is a published rule over two values this arm already
      // holds -- the graded answer and the evidence the reader received -- and
      // `classifyTrFailure` is that rule. The arm supplies the haystack and reads a
      // verdict; it decides nothing about what counts as a match.
      //
      // The haystack is the **delivery** (`retrievedContexts[i]`), because grounding is a
      // statement about what the reader had in hand. And it is read here, beside
      // `goldOverlap` and before the bound, for the reason that field's own comment gives:
      // the bound is an artifact setting applied after the run, so a verdict taken from
      // the record's post-bound `turns` would make a question's groundedness depend on
      // how the JSON was written.
      grounded:
        classifyTrFailure({
          question: question.question,
          groundTruth: question.expected,
          answer: answers[i]!,
          retrieved: (retrievedContexts[i] ?? []).join('\n'),
        }) === 'grounded',
      // `null` becomes `[]`, because `QuestionRecordInput.retrieved` is a list of
      // turns and "no reader was shown anything" reaches the record as `turns: []`,
      // which is the same statement made in the shape the record can hold. `null` is
      // not collapsed into `[]` in the VECTOR, where the distinction is still
      // expressible -- and where it is what separates "the machine declined before a
      // reader" from "the reader was reached and carried nothing".
      //
      // This vector is the evidence the reader **received** since §13.15, because
      // it is built from `lastRetrievedContext` and that accessor reports what the
      // prompt carried rather than what admission offered. So the record's `turns`
      // are the turns the model read, which is what makes the artifact able to answer
      // whether the gold turn was among them.
      //
      // `admittedTurns`/`admittedChars` were previously derived from this same string
      // and therefore stopped describing the offer -- run `38142407062` is where that
      // was noticed, as `evidenceTurns` falling from thousands to a median of 141.
      // They now come from their own capture, and a system that cannot report the
      // offer is reported as `0`, which the record's own docs call a system that
      // admitted nothing rather than an unknown.
      retrieved: retrievedContexts[i] ?? [],
      // `!` for the same reason as `featureCorrect[i]` above: this arm is handed an
      // `AblationResult` by the chain it called itself, and the capture pushes one entry
      // per question. `null` flows through and is not a defect -- it is the system saying
      // it has no accessor for the offer, which the record then omits.
      admitted: admittedEvidence[i]!,
      promptChars: promptEvidenceChars[i] ?? null,
      // §13.231. The other term of the only subtraction that decomposes a prompt. `promptChars` is
      // the evidence the builder printed; this is the text it printed it into. Both are free here --
      // the prompt was already captured for the digest one line down, and a length is not a second
      // capture -- and without it the overhead is only bounded by `maxPromptChars`, which is how
      // §13.230.2 came to attribute 19% of a prompt to a 339-character instruction block.
      deliveredPromptChars:
        promptTexts[i] === null || promptTexts[i] === undefined ? null : promptTexts[i]!.length,
      // `§13.168.8`. The fingerprint of the bytes this question's reader was sent, so a
      // reader of two artifacts can tell four repetitions from four prompts. `null` when
      // the system exposes no prompt, which the record renders as absent rather than as
      // the digest of an empty string.
      promptDigest: promptDigest(promptTexts[i] ?? null),
      // The within-run half: how many different prompts this question cost. `undefined` at one pass,
      // which the record renders as absent rather than as the constant it would otherwise print.
      promptVariants: promptVariantCounts?.[i] ?? null,
      // §13.145.6. Two fields rather than one because a retry that fired and declined again is `attempted`
      // without `answered`, and that half is what says the mechanism ran rather than which way it went.
      ...traceOf(recoveryTrace, question.question, auditTrace),
      // Measured here rather than inside `buildQuestionRecords`, because the
      // measurement needs the **pre-bound** context and this is the last place it
      // exists: the record's `turns` are what the bound left. Computing it a hop later
      // would make coverage fall whenever the writability guard bit, which would make
      // two runs incomparable for a reason that is not about the system.
      //
      // The units are the accessor's own turns since §13.16.6, so this is a membership
      // test between two applications of `turnText` rather than a search through a
      // rendered string -- the gold turn either is one of the carried turns or is not.
      // The third count, when a ranking was consulted: how much of this question's gold
      // the ranking offered at all. `total - pool` is the ranking's miss, `pool - carried`
      // is the budget's -- while the delivery comes from the pool. Since §13.68's per-turn
      // cap the window can be wider than the pool, so `carried` can exceed `pool` and the
      // three counts become marginals rather than a partition (§13.214). §13.61.7 is what
      // six runs could not say without them.
      ...accountOf(question, retrievedContexts[i] ?? [], poolFor, rolePolicy),
    })),
    featureConfig,
    ablation.featureCorrect,
    evidenceBound,
  );
}

/**
 * Read the feature system's abstention census, if it exposes one.
 *
 * ## What it counts, which used to be one route
 *
 * The census covers every route that can decline. It used to cover only
 * `answerAbstention` -- which `runBenchmark` dispatches for `capability === 'ABS'`
 * alone -- so the arm's sustained loss (MR and TR) never entered it. §13 measured
 * MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every capability, and no field
 * in the artifact could say which route those declines came from: `turns` is `[]`
 * by design and `rawOutput` carries the text but not the decision. Widening the
 * counter is what makes the retrieval hypothesis testable.
 *
 * `threshold` remains reachable on the abstention route only, because
 * `#retrievalAdmitted` is called from `answerAbstention` and nowhere else. The
 * four-key shape is unchanged, so this reader and every artifact already written
 * keep working; what changed is which declines the four keys are counting.
 *
 * ## Why this is a structural read rather than a member of `MemorySystem`
 *
 * `MemorySystem` is the benchmark's *injection* contract: `{ name, answer }` plus
 * optional routing members. It is deliberately wider than any single system, and
 * `memory-system-conformance.test.ts` verifies that a bare `{ name, answer }`
 * object receives every question. Adding a census to it would make every system
 * -- including test doubles and the reference pipeline -- responsible for a field
 * only a value-gated system can fill, and the conformant minimum would stop being
 * conformant.
 *
 * So the census is read as an optional capability, the same way the router reads
 * `answerSessions`. The validation is not decorative: a system could expose the
 * name with a malformed value, and `{ ...payload }` would then put nonsense in the
 * artifact. A field that is present but wrong is worse than one that is absent,
 * because it is indistinguishable from a real reading -- so anything that is not
 * four finite non-negative integers is treated as absent rather than reported.
 */
/**
 * One instance's vote verdicts, or `null` when it has no vote census to report.
 *
 * ## Why this is an optional capability rather than a `MemorySystem` member
 *
 * The same reason `abstentionReasonsOf` gives: the contract is wider than any single system, and
 * adding a vote census to it would make every test double and the reference pipeline responsible for
 * a field only a voting system can fill. The reference pipeline never votes, and a shared type that
 * said it did would be a lie the conformance suite could not see.
 *
 * ## Why a malformed value is discarded rather than reported
 *
 * A field that is present but wrong is worse than an absent one: the artifact would show a vote
 * census that no mechanism produced, and a reader could not tell it from a real reading. Anything
 * that is not three finite non-negative integers is treated as absent.
 *
 * ## Why `null` and not `{}` for "all zeros" here
 *
 * Because under a pool a worker that took no votes is the **normal** case, and the zero rule
 * belongs to the total rather than to a part. `voteCountsAcross` applies it once, after summing;
 * applying it here would discard a worker that had nothing to vote on and then add up the rest.
 */
function voteVerdictsOf(
  system: MemorySystem,
): { unanimous: number; majority: number; split: number } | null {
  const candidate = (system as { voteCounts?: unknown }).voteCounts;
  if (typeof candidate !== 'function') return null;

  let payload: unknown;
  try {
    payload = (candidate as () => unknown).call(system);
  } catch {
    // A throwing accessor is a broken optional capability, not a failed run.
    return null;
  }

  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const keys = ['unanimous', 'majority', 'split'] as const;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  }
  return {
    unanimous: record.unanimous as number,
    majority: record.majority as number,
    split: record.split as number,
  };
}

/**
 * The instances a census has to be read over: every one this run answered through.
 *
 * ## Why the guard throws instead of falling back to `feature`
 *
 * A pool that cannot name the instance the arm was handed is a pool built from different factories than
 * the arm's, and the only two possible behaviours there are both wrong: reading `feature` alone
 * reproduces the defect, and reading the pool alone silently drops worker 0's share. The arm refuses.
 *
 * ## Why `feature` is compared by identity and can be
 *
 * `runCortexMemoryArm`'s `feature` parameter is the caller's object, not a wrapper: the tracers this
 * function builds (`traceUsage`, `traceReviewMechanisms`) are constructed below and handed to the
 * ablation, so the census read keeps using the instance the caller passed -- which is exactly the
 * object `createAblationPool({ first: { feature } })` puts at index 0.
 */
/**
 * A pool whose instances are wrapped for the per-side spend split.
 *
 * ## The defect this fixes (§13.259)
 *
 * `traceUsage` wraps the two systems passed to `runCortexMemoryArm` positionally -- and under a
 * pool the ablation answers through `pool.baselineFor(worker)` / `pool.featureFor(worker)`, so
 * those two wrappers are **never called**. Both sides then read zero calls, and
 * `attachUsageBySide` drops the field when the sides sum to zero, which is why the loss was
 * invisible: `41546569106` (no pool, `workers` unset) carried `usageBySide`; `41970746908` and
 * `41990597116` (four workers) do not, and all three are complete 500-question runs of the same
 * arm.
 *
 * ## Why the enumeration passes through untouched
 *
 * `featureInstances()` is what `censusSourcesOf` reads to fold the arm's censuses across workers,
 * and it compares the caller's `feature` **by identity**. The wrapper delegates every call to the
 * instance it wraps, so the instance still accumulates its own per-question state and the census
 * path is unaffected; only the object that answers has changed.
 *
 * ## Why the memo is per worker
 *
 * `createAblationPool` memoises one instance per worker, so a factory that returned a fresh
 * wrapper each call would make instance identity a function of (worker, pass) -- the second half
 * of the defect that function documents. The map here restores that guarantee one layer out.
 */
function tracedPool(
  pool: AblationPool,
  ledger: Record<UsageSide, UsageTally>,
  auditTrace?: Map<string, AuditMechanismTrace>,
): AblationPool {
  const wrapped: Record<UsageSide, Map<number, MemorySystem>> = {
    baseline: new Map<number, MemorySystem>(),
    feature: new Map<number, MemorySystem>(),
  };
  const once = (side: UsageSide, worker: number, build: () => MemorySystem): MemorySystem => {
    const existing = wrapped[side].get(worker);
    if (existing !== undefined) return existing;
    const spent = traceUsage(build(), side, ledger);
    // The audit trace rides on the same per-worker object, and only on the feature side: the baseline is the
    // reference pipeline, which carries no `reviewPass` at all. Wrapping here rather than positionally is the
    // lesson §13.259 wrote down -- under a pool the positional wrapper is never called, so the trace would be
    // empty and the artifact would say the mechanism did not fire on any question.
    const traced =
      side === 'feature' && auditTrace !== undefined ? traceAuditPass(spent, auditTrace) : spent;
    wrapped[side].set(worker, traced);
    return traced;
  };
  return {
    workers: pool.workers,
    baselineFor: (worker) => once('baseline', worker, () => pool.baselineFor(worker)),
    featureFor: (worker) => once('feature', worker, () => pool.featureFor(worker)),
    featureInstances: () => pool.featureInstances(),
  };
}

function censusSourcesOf(feature: MemorySystem, pool: AblationPool | undefined): MemorySystem[] {
  if (pool === undefined) return [feature];
  const instances = [...pool.featureInstances()];
  if (!instances.includes(feature)) {
    throw new Error(
      'the pool does not enumerate the feature instance this arm measured, so the census could ' +
        'only be a subset of the run -- worker 0 answers through `feature`, and a sum that omits ' +
        'it understates every rate by one worker. Build the pool with createAblationPool and pass ' +
        'its `first.feature` here. See PREREGISTRATION §13.244.',
    );
  }
  return instances;
}

/**
 * The three per-question censuses, summed over every instance the run answered through.
 *
 * ## Why a partial answer is no answer
 *
 * These counts are per-instance state under a pool, so the correct total is a sum over the instances
 * that answered. The failure this function is written against is the **truncated** sum: `41773546221`
 * published a census summing to 488 against 2,000 question-answers, and 488 is worker 0's quarter.
 * A number that is a quarter of the run reads exactly like a measurement, which is why the rule here
 * is all-or-nothing -- if any instance cannot report, the field is absent, and the artifact's
 * `census-unit` check then says "no census" instead of a plausible lie.
 *
 * ## Why the zero rule is applied to the total and not per instance
 *
 * It is not: that rule belongs to the vote census (a system that took no votes), where an instance
 * with no votes is the normal case rather than a missing capability. It lives in
 * {@link voteCountsAcross}, one function down, for exactly that reason.
 */
function summedOver(
  systems: readonly MemorySystem[],
  read: (system: MemorySystem) => Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (systems.length === 0) return undefined;
  const total: Record<string, number> = {};
  for (const system of systems) {
    const one = read(system);
    if (one === undefined) return undefined;
    for (const [key, value] of Object.entries(one)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}

function abstentionReasonsAcross(systems: readonly MemorySystem[]): {
  abstentionReasons?: AbstentionReasons;
} {
  const total = summedOver(systems, (system) => abstentionReasonsOf(system).abstentionReasons);
  if (total === undefined) return {};
  return {
    abstentionReasons: {
      empty: total.empty as number,
      threshold: total.threshold as number,
      llm: total.llm as number,
      answered: total.answered as number,
    },
  };
}

function recoveryAcross(systems: readonly MemorySystem[]): { recovery?: RecoveryCensus } {
  const total = summedOver(systems, (system) => recoveryOf(system).recovery);
  if (total === undefined) return {};
  return {
    recovery: { attempted: total.attempted as number, answered: total.answered as number },
  };
}

function bareRetryAcross(systems: readonly MemorySystem[]): { bareRetry?: BareRetryCensus } {
  const total = summedOver(systems, (system) => bareRetryOf(system).bareRetry);
  if (total === undefined) return {};
  return {
    bareRetry: { attempted: total.attempted as number, answered: total.answered as number },
  };
}

/**
 * The reply-contract repair's census, summed over every instance the run answered through.
 *
 * ## Why this one flattens the payload to reuse `summedOver`
 *
 * The payload is nested by kind, and the nesting is the point: the two kinds are different sentences on disjoint
 * populations, and flattening it in the report would put the naming of the kinds in the arm. So the flattening is
 * local to the sum -- `summedOver` sees six integers and this function reassembles the two records -- and the rule it
 * carries comes for free: an instance that cannot report makes the whole field absent rather than making it a partial
 * sum, which is §13.244's defect (worker 0's quarter published as the run's).
 */
function replyRepairAcross(systems: readonly MemorySystem[]): { replyRepair?: ReplyRepairCensus } {
  const total = summedOver(systems, (system) => {
    const one = replyRepairOf(system).replyRepair;
    if (one === undefined) return undefined;
    return {
      attempted: one.attempted,
      answered: one.answered,
      commitmentAttempted: one.commitment.attempted,
      commitmentAnswered: one.commitment.answered,
      shapeAttempted: one.shape.attempted,
      shapeAnswered: one.shape.answered,
    };
  });
  if (total === undefined) return {};
  return {
    replyRepair: {
      attempted: total.attempted as number,
      answered: total.answered as number,
      commitment: {
        attempted: total.commitmentAttempted as number,
        answered: total.commitmentAnswered as number,
      },
      shape: {
        attempted: total.shapeAttempted as number,
        answered: total.shapeAnswered as number,
      },
    },
  };
}

/**
 * The audit census, summed over every instance the run answered through.
 *
 * Summed for the reason §13.244 gives about the other three: a pooled run answers through N instances and reading
 * the census off the feature object reads worker 0's share. The audit is the pass most exposed to that defect,
 * because it fires only on the multi-session route -- so a run at four workers would have published roughly a
 * quarter of its consultations and every reader would have compared that against the run's own call count and
 * found the two agreeing, since the call count is a process total and the census would not have been.
 */
function auditAcross(systems: readonly MemorySystem[]): { audit?: AuditCensus } {
  const total = summedOver(systems, (system) => auditOf(system).audit);
  if (total === undefined) return {};
  return { audit: { attempted: total.attempted as number, changed: total.changed as number } };
}

/**
 * The vote census, summed and then judged.
 *
 * The two rules are separate on purpose and in this order:
 *
 * 1. **Sum over instances**, all-or-nothing, for the reason {@link summedOver} gives.
 * 2. **A total of three zeros is not a census.** Every vote lands in exactly one of the three buckets,
 *    so their sum is the number of votes taken. Publishing `vote=0/0/0` on a control run -- which run
 *    `39641088296` did -- makes an artifact claim a mechanism that never ran, which is the reading
 *    §13.101.2 says the census exists to prevent.
 *
 * The order matters under a pool: an individual worker may legitimately take zero votes (it drew no
 * questions from the voting route), so applying rule 2 per instance would discard a worker that had
 * nothing to vote on and then sum the rest -- a truncated census again, hiding inside a guard that
 * looks like it is protecting the reader.
 */
function voteCountsAcross(systems: readonly MemorySystem[]): {
  voteCounts?: { unanimous: number; majority: number; split: number };
} {
  const total = summedOver(systems, (system) => voteVerdictsOf(system) ?? undefined);
  if (total === undefined) return {};
  const counts = {
    unanimous: total.unanimous as number,
    majority: total.majority as number,
    split: total.split as number,
  };
  if (counts.unanimous + counts.majority + counts.split === 0) return {};
  return { voteCounts: counts };
}

/**
 * The recovery census, read the way `abstentionReasonsOf` reads its own.
 *
 * Same three decisions: an absent accessor is a system without the pass, a throwing one is a broken
 * optional capability rather than a failed run, and a payload that is not two non-negative integers
 * is discarded rather than coerced. The last one is what stops `NaN` from reaching a table and
 * rendering as a real observation.
 */
function recoveryOf(system: MemorySystem): { recovery?: RecoveryCensus } {
  const candidate = (system as { recoveryCensus?: unknown }).recoveryCensus;
  if (typeof candidate !== 'function') return {};

  let payload: unknown;
  try {
    payload = (candidate as () => unknown).call(system);
  } catch {
    return {};
  }

  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  for (const key of ['attempted', 'answered'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return {};
  }
  return {
    recovery: { attempted: record.attempted as number, answered: record.answered as number },
  };
}

/**
 * The bare-decline retry's tally, read the way `recoveryOf` reads its own.
 *
 * Same three decisions, for the same reasons: an absent accessor means the system does not carry the pass (which
 * the report must say by omission rather than by a zero), a throwing one is a broken optional capability rather
 * than a failed run, and a payload that is not two whole non-negative counts is discarded rather than coerced.
 */
function bareRetryOf(system: MemorySystem): { bareRetry?: BareRetryCensus } {
  const candidate = (system as { bareRetryCensus?: unknown }).bareRetryCensus;
  if (typeof candidate !== 'function') return {};

  let payload: unknown;
  try {
    payload = (candidate as () => unknown).call(system);
  } catch {
    return {};
  }

  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  for (const key of ['attempted', 'answered'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return {};
  }
  return {
    bareRetry: { attempted: record.attempted as number, answered: record.answered as number },
  };
}

/**
 * Read the reply-contract repair's census off one instance, or `{}` when it carries none.
 *
 * The same three-step shape as `bareRetryOf` and one extra step, because this payload has parts: an absent member is
 * a build without the repair, a throwing one is a broken optional capability rather than a failed run, and a payload
 * whose **kinds** are missing or malformed is discarded rather than coerced -- a total without its parts is the shape
 * `ReplyRepairCensus` exists to prevent, since a reader could then credit a conversion to a treatment that never
 * fired.
 */
function replyRepairOf(system: MemorySystem): { replyRepair?: ReplyRepairCensus } {
  const candidate = (system as { replyRepairCensus?: unknown }).replyRepairCensus;
  if (typeof candidate !== 'function') return {};

  let payload: unknown;
  try {
    payload = (candidate as () => unknown).call(system);
  } catch {
    return {};
  }

  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  for (const key of ['attempted', 'answered'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return {};
  }
  const kinds = {} as Record<'commitment' | 'shape', { attempted: number; answered: number }>;
  for (const kind of ['commitment', 'shape'] as const) {
    const part = record[kind];
    if (part === null || typeof part !== 'object') return {};
    const counts = part as Record<string, unknown>;
    for (const key of ['attempted', 'answered'] as const) {
      const value = counts[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return {};
    }
    kinds[kind] = { attempted: counts.attempted as number, answered: counts.answered as number };
  }
  return {
    replyRepair: {
      attempted: record.attempted as number,
      answered: record.answered as number,
      commitment: kinds.commitment,
      shape: kinds.shape,
    },
  };
}

/**
 * Read the audit census off one instance, or `{}` when the instance carries no such accessor.
 *
 * The same three-step shape as its two siblings -- absent member, throwing member, malformed payload -- because a
 * reader of the artifact has to be able to tell "this build has no audit" from "the audit ran and moved nothing",
 * and a `try` that returned zeros on a fault would collapse them. A negative or fractional count is treated as
 * malformed rather than clamped: the only producer is a counter incremented by one, so a non-integer can only mean
 * the field is not the counter it claims to be.
 */
function auditOf(system: MemorySystem): { audit?: AuditCensus } {
  const candidate = (system as { auditCensus?: unknown }).auditCensus;
  if (typeof candidate !== 'function') return {};

  let payload: unknown;
  try {
    payload = (candidate as () => unknown).call(system);
  } catch {
    return {};
  }

  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  for (const key of ['attempted', 'changed'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return {};
  }
  return { audit: { attempted: record.attempted as number, changed: record.changed as number } };
}

function abstentionReasonsOf(system: MemorySystem): { abstentionReasons?: AbstentionReasons } {
  const candidate = (system as { abstentionReasons?: unknown }).abstentionReasons;
  if (typeof candidate !== 'function') return {};

  let payload: unknown;
  try {
    payload = (candidate as () => unknown).call(system);
  } catch {
    // A throwing accessor is a broken optional capability, not a failed run. The
    // endpoint is already measured by this point, so discarding the census is the
    // right trade against discarding the arm.
    return {};
  }

  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const keys = ['empty', 'threshold', 'llm', 'answered'] as const;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return {};
  }
  return {
    abstentionReasons: {
      empty: record.empty as number,
      threshold: record.threshold as number,
      llm: record.llm as number,
      answered: record.answered as number,
    },
  };
}

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

import { readToggle } from './env-toggle.js';
import type { RerankCensus } from './rerank-census.js';
import type { RerankBounds, RerankIdentity } from './rerank-factory.js';
import type {
  AblationReport,
  AbstentionReasons as ReportAbstentionReasons,
  BareRetryCensus,
  MemoryArmConfig,
  RecoveryCensus,
} from './report.js';
import {
  boundRetrievedContexts,
  buildQuestionRecords,
  evidenceReductionOf,
  goldOverlapOf,
  type EvidenceBoundOptions,
  type QuestionRecord,
} from './question-record.js';
import { formatAblationReport, runAblationReport, type FeatureConfig } from './report.js';
import type { AnswerScorer } from './metrics.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import {
  deserializeEmbeddingCache,
  mergeEmbeddingCache,
  serializeEmbeddingCache,
  snapshotEmbeddingCache,
} from './retrieval.js';
import { DEFAULT_RELEVANCE_TOP_K } from './relevance-index.js';
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
   * The evidence budget in UTF-16 code units, or absent for the product default (24,000).
   *
   * A separate axis from `maxTurnChars`, and the pair is what §13.80 separated: the cap decides how
   * much of one turn is shown, the budget decides how many turns fit. Lowering the cap buys room by
   * destroying text; raising the budget buys room by spending tokens — and only the second has no
   * measured floor.
   */
  maxPromptChars?: number | undefined;
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
} as const;

/** The unit a run gets when it does not name one. */
const DEFAULT_RELEVANCE_UNITS = RELEVANCE_UNITS.turn;

const THRESHOLD_VARIABLE = 'CORTEX_MEMORY_THRESHOLD';
const RETRIEVAL_THRESHOLD_VARIABLE = 'CORTEX_MEMORY_RETRIEVAL_THRESHOLD';
const BUDGET_VARIABLE = 'CORTEX_MEMORY_SESSION_BUDGET';
const SOURCE_TRUST_VARIABLE = 'CORTEX_MEMORY_SOURCE_TRUST';
const CONFIDENCE_VARIABLE = 'CORTEX_MEMORY_CONFIDENCE';
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
 * `DEFAULT_MAX_PROMPT_CHARS` is 24,000 and every run in this campaign used it, so every experiment
 * traded truncation against room **inside** that budget. §13.80 found the trade's floor: at a
 * 200-character cap the room reached 100 turns and MR fell to 29 of 121, because a 223-character
 * mean turn is a fragment and the model declines from fragments. The only way past the floor is to
 * raise the budget, and until this variable existed the arm could not express that.
 *
 * Absent means the product default, which is what every archived run used — so an artifact without
 * this field is a run at 24,000 rather than an unrecorded budget.
 */
const MAX_PROMPT_CHARS_VARIABLE = 'CORTEX_MEMORY_MAX_PROMPT_CHARS';

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
 */
function evidenceRouteOf(capability: string): string {
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
 * A table rather than an array because the value is a *set membership test*, and a table keyed by
 * the name makes a lookup the same operation as the validation -- an array would need `includes`
 * at one site and `find` at another, and the two would eventually disagree about case.
 */
const TURN_CAP_ROUTES: Record<string, true> = {
  'multi-session': true,
  temporal: true,
  flat: true,
  'knowledge-update': true,
  abstention: true,
  assistant: true,
};

/** Every route, in the order the product declares them. */
const ALL_TURN_CAP_ROUTES: readonly string[] = Object.keys(TURN_CAP_ROUTES);

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
      // Absent, not zero and not `Infinity`: no cap is the state every archived run was
      // produced under, and a present key would let an artifact claim a treatment on a run
      // that administered none. `exactOptionalPropertyTypes` keeps the two distinguishable.
    };
  }
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
    promptContract: readPromptContract(env[PROMPT_CONTRACT_VARIABLE]),
    ask: readAsk(env[ASK_VARIABLE]),
    reviewPass: readReviewPass(env[REVIEW_PASS_VARIABLE]),
    // A value of `reviewPass` rather than an input of its own: the workflow is at the dispatch-input ceiling,
    // and these are two treatments rather than two knobs — no run should administer both.
    reviewBareDecline: readReviewPass(env[REVIEW_PASS_VARIABLE]) === 'bare',
    queryExpansion: readQueryExpansion(env[QUERY_EXPANSION_VARIABLE]),
    selfConsistency: readSelfConsistency(env[SELF_CONSISTENCY_VARIABLE]),
    evidenceTurnsPerRecord: readEvidenceBound(env[EVIDENCE_BOUND_VARIABLE]),
    relevanceSignal: readRelevanceSignal(env[RELEVANCE_VARIABLE]),
    relevanceTopK: readRelevanceTopK(env[RELEVANCE_TOP_K_VARIABLE]),
    relevanceUnits: readRelevanceUnits(env[RELEVANCE_UNITS_VARIABLE]),
    maxTurnCharsRoutes: readMaxTurnCharsRoutes(env[MAX_TURN_CHARS_ROUTES_VARIABLE]),
    // Spread conditionally, because "the product default" is an absent field rather than a number
    // this module would have to keep in step with `prompt.ts`.
    ...(() => {
      const budget = readMaxPromptChars(env[MAX_PROMPT_CHARS_VARIABLE]);
      return budget === undefined ? {} : { maxPromptChars: budget };
    })(),
    // Spread rather than assigned, because "no cap" is an absent field on this type rather
    // than an infinite one -- see `CortexMemoryArmOptions.maxTurnChars`.
    ...(() => {
      const cap = readMaxTurnChars(env[MAX_TURN_CHARS_VARIABLE]);
      return cap === undefined ? {} : { maxTurnChars: cap };
    })(),
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
 * The contract names `CORTEX_MEMORY_PROMPT_CONTRACT` accepts.
 *
 * The product's own list, restated here, for the layering reason
 * {@link DEFAULT_PROMPT_CONTRACT} records. The duplication is checked rather than
 * trusted: `bench-memory-arm.test.ts` asserts these are exactly the contracts
 * `cortex-memory` exports, so a name added or removed on the product side fails a test
 * here instead of silently becoming an accepted-but-unimplemented value.
 */
const PROMPT_CONTRACTS = {
  /** The baseline rendering: numbered turns, blank-line separated. */
  abstention: 'abstention',
  /** §12.5's candidate: every turn labelled with the memory it came from. */
  'abstention-evidence-blocks': 'abstention-evidence-blocks',
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

/** The expansions this arm can dispatch, in the order the config line spells them. */
const QUERY_EXPANSIONS: readonly string[] = ['none', 'llm'];

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
 * Read the per-turn character cap, defaulting to none.
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
 */
function readMaxTurnChars(raw: string | undefined): number | undefined {
  // Three spellings of "no cap": absent, blank (what an unfilled `workflow_dispatch` input
  // actually is), and the literal `none`. The third exists because §10.3 registers the
  // adopted configuration as `maxTurnChars: none` and the dispatch must send the value the
  // registration names -- the alternative is a registration that says one thing and a
  // payload that says another, which is the defect `test_preregistration_config.py` exists
  // to catch. It is the same sentinel `confidenceSignal` and `relevanceSignal` use, so the
  // three read alike on a config line.
  //
  // The blank rule is restated here rather than delegated to `readNumeric`, and that is a
  // consequence of the third spelling: `readNumeric` collapses only the blank, so a caller
  // would have to pre-test `none` and then call it -- and the resulting `value === undefined`
  // branch is one v8 counts and no input can reach. It was written that way first and the
  // branch showed up uncovered, which is the census's usual reading: there is no way to
  // arrive there. `trimmed` is a `string` after the guard, so `Number` needs no second one.
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${MAX_TURN_CHARS_VARIABLE} must be a positive integer or unset, got ` +
        `${JSON.stringify(raw)}. The unit is characters per turn, and a cap of 0 emits every ` +
        'turn number with no text after it while every coverage count still reports the ' +
        'turns as they arrived -- a prompt that reads as empty evidence and an artifact ' +
        'that reads as a delivery.',
    );
  }
  return value;
}

/**
 * Read the evidence budget, defaulting to the product's 24,000.
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
    if (!(name in TURN_CAP_ROUTES)) {
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
  if (relevanceSignal === 'retrieval' || relevanceSignal === 'retrieval-hybrid') {
    return;
  }
  throw new Error(
    `CORTEX_MEMORY_RERANK is enabled but relevanceSignal="${relevanceSignal}" builds no ranked pool ` +
      'for the stage to reorder, so the reranker would never fire and the artifact would name a ' +
      'treatment that did not run. Set CORTEX_MEMORY_RELEVANCE=retrieval or retrieval-hybrid, or ' +
      'leave the reranker off.',
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
    ask: options.ask,
    reviewPass: options.reviewPass ?? 'none',
    // Recorded unconditionally rather than only when true: "the control ran" and "the field predates the run" are
    // the same bytes otherwise, and this field exists because a claim of treatment nobody can check is the defect
    // the whole `featureConfig` block was added to close.
    reviewBareDecline: options.reviewBareDecline === true,
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
    // §13.68. Spread conditionally for the reason the optional fields above are: an absent
    // cap is a run that carried none, and a present-but-undefined key would read as
    // configured to every `!== undefined` check downstream and as pre-dating-the-field to a
    // reader of the JSON.
    ...(options.maxTurnChars === undefined ? {} : { maxTurnChars: options.maxTurnChars }),
    // §13.81. Absent means the product's 24,000, which is what every archived run used, so the
    // absence is a fact about the run rather than a missing field.
    ...(options.maxPromptChars === undefined ? {} : { maxPromptChars: options.maxPromptChars }),
    // §13.73. Always present, unlike the width: the reach is a statement about the run's intent
    // that survives the cap being absent, and a reader comparing two artifacts needs to see that
    // the second one reached two routes where the first reached six.
    ...(options.maxTurnCharsRoutes === undefined
      ? {}
      : { maxTurnCharsRoutes: options.maxTurnCharsRoutes }),
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
  /** Fixed timestamp, so a report is reproducible. */
  generatedAt?: string;
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

  const report = await runAblationReport(dataset, baseline, feature, {
    ...(options.runs === undefined ? {} : { runs: options.runs }),
    ...(options.alpha === undefined ? {} : { alpha: options.alpha }),
    ...(options.scorer === undefined ? {} : { scorer: options.scorer }),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    ...(options.featureConfig === undefined ? {} : { featureConfig: options.featureConfig }),
    memoryArmConfig: options.memoryArmConfig,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });

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
  const census = {
    ...abstentionReasonsOf(feature),
    ...recoveryOf(feature),
    ...bareRetryOf(feature),
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
  const vote = voteCountsOf(feature);
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
    // Spread conditionally on both sides: a run that did not vote has no census, and a report built
    // without an arm config has nowhere to put one. Either absence means "not measured", which the
    // field's optionality already says.
    ...(vote.voteCounts === undefined || report.memoryArmConfig === undefined
      ? {}
      : { memoryArmConfig: { ...report.memoryArmConfig, voteCounts: vote.voteCounts } }),
    questions,
    ...(evidenceReduction === null ? {} : { evidenceReduction }),
  };
  return {
    report: reported,
    markdown: formatAblationReport(reported),
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
 * One question's gold overlap, with the denominator the run's policy implies.
 *
 * `totalAll` is attached only when the eligible set is **smaller** than the dataset's. Length
 * rather than identity: a filter that reaches a question but excludes nothing returns a new list
 * of the same size, and a field saying "the dataset named 2 and the policy admitted 2" is noise
 * standing where a reader looks for a difference.
 *
 * `null` passes through: a question with no gold turns has no ratio, and inventing one here would
 * make "the dataset names no gold" indistinguishable from "none of the gold reached the reader".
 */
function overlapOf(
  question: BenchmarkDataset['questions'][number],
  retrieved: readonly string[],
  poolFor: ((question: string) => readonly string[] | undefined) | undefined,
  rolePolicy: { roles?: readonly string[]; reach?: readonly string[] } | undefined,
): GoldOverlap | null {
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
  const overlap = goldOverlapOf(retrieved, eligible, poolFor?.(question.question));
  if (overlap === null || eligibleCount === goldCount) return overlap;
  return { ...overlap, totalAll: goldCount };
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
  return buildQuestionRecords(
    dataset.questions.map((question, i) => ({
      questionId: question.id,
      question: question.question,
      capability: question.capability,
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
      // is the budget's. §13.61.7 is what six runs could not say without it.
      goldOverlap: overlapOf(question, retrievedContexts[i] ?? [], poolFor, rolePolicy),
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
 * The vote counts a feature system reports, or nothing when it does not vote.
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
 */
function voteCountsOf(system: MemorySystem): {
  voteCounts?: { unanimous: number; majority: number; split: number };
} {
  const candidate = (system as { voteCounts?: unknown }).voteCounts;
  if (typeof candidate !== 'function') return {};

  let payload: unknown;
  try {
    payload = (candidate as () => unknown).call(system);
  } catch {
    // A throwing accessor is a broken optional capability, not a failed run.
    return {};
  }

  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const keys = ['unanimous', 'majority', 'split'] as const;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return {};
  }
  const counts = {
    unanimous: record.unanimous as number,
    majority: record.majority as number,
    split: record.split as number,
  };
  // A census of three zeros is a run that did not vote, not a run whose votes all failed to
  // resolve: every vote lands in exactly one of the three buckets, so their sum is the number of
  // votes taken. Publishing `vote=0/0/0` on a control run -- which run `39641088296` did -- makes
  // an artifact claim a mechanism that never ran, which is the reading §13.101.2 says the census
  // exists to prevent.
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

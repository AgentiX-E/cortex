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
 * `cortex-core` and `cortex-llm` and on nothing in the product layer, and
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
import type {
  AblationReport,
  AbstentionReasons as ReportAbstentionReasons,
  MemoryArmConfig,
} from './report.js';
import { buildQuestionRecords, type QuestionRecord } from './question-record.js';
import { formatAblationReport, runAblationReport, type FeatureConfig } from './report.js';
import type { AnswerScorer } from './metrics.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import {
  deserializeEmbeddingCache,
  mergeEmbeddingCache,
  serializeEmbeddingCache,
  snapshotEmbeddingCache,
} from './retrieval.js';
import type { AblationResult, BenchmarkDataset, MemorySystem } from './types.js';

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

const THRESHOLD_VARIABLE = 'CORTEX_MEMORY_THRESHOLD';
const RETRIEVAL_THRESHOLD_VARIABLE = 'CORTEX_MEMORY_RETRIEVAL_THRESHOLD';
const BUDGET_VARIABLE = 'CORTEX_MEMORY_SESSION_BUDGET';
const SOURCE_TRUST_VARIABLE = 'CORTEX_MEMORY_SOURCE_TRUST';
const CONFIDENCE_VARIABLE = 'CORTEX_MEMORY_CONFIDENCE';
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
 * The contract a run gets when it does not name one.
 *
 * A local literal, and this file's own boundary rule requires it: `cortex-eval` depends
 * only on `cortex-core` and `cortex-llm`, while `cortex-memory` is the layer that depends
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
 * {@link PROMPT_CONTRACTS}, and checked the same way: the census test asserts this
 * matches the product's own reach, so a route added or lost on the product side
 * fails a test here rather than silently becoming a reach the artifact claims.
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
export function toMemoryArmConfig(options: CortexMemoryArmOptions): MemoryArmConfig {
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
    askRoutes: ASK_ROUTES[options.ask] ?? [],
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
export function restoreArmEmbeddingCache(path: string | undefined): number {
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
    const persisted = deserializeEmbeddingCache(readFileSync(path));
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
 * Persist the process-wide embedding cache so a later run can skip the provider.
 *
 * Writing even when the cache is EMPTY is the intended behaviour, not an
 * oversight. Skipping the write would leave the previous run's file in place, and
 * the next run would restore vectors for haystack turns this run never saw —
 * silently grading against another dataset's evidence. An empty file is a true
 * statement ("this run embedded nothing"); a stale file is a false one.
 *
 * Symmetric with `restoreArmEmbeddingCache`, including the blank-path rule: an
 * unconfigured path is a no-op rather than a write to `''`.
 */
export function persistArmEmbeddingCache(path: string | undefined): void {
  if (path === undefined || path.trim() === '') {
    return;
  }
  writeFileSync(path, serializeEmbeddingCache(snapshotEmbeddingCache()));
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
  const census = abstentionReasonsOf(feature);
  const questions = buildArmRoster(dataset, report.ablation, options.featureConfig);
  const reported: AblationReport = {
    ...report,
    ...(census.abstentionReasons === undefined
      ? {}
      : { abstentionReasons: census.abstentionReasons }),
    questions,
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
 * `grounded` and `turns` are the parts this arm genuinely cannot report. Grounding
 * is a property of the retrieval trace and the turn split is derived from the
 * text a reader was shown; this arm collects neither, so the records say `false`
 * and carry no turns rather than guessing. B7 excludes an ungrounded question
 * before clustering, which is the right outcome for a run that did not record its
 * evidence -- a fabricated `true` would admit a question no trace supports.
 */
function buildArmRoster(
  dataset: BenchmarkDataset,
  ablation: AblationResult,
  featureConfig: FeatureConfig | undefined,
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
  return buildQuestionRecords(
    dataset.questions.map((question, i) => ({
      questionId: question.id,
      question: question.question,
      capability: question.capability,
      groundTruth: question.expected,
      answer: answers[i]!,
      rawOutput: rawOutputs[i]!,
      correct: ablation.featureCorrect[i]!,
      grounded: false,
      retrieved: '',
    })),
    featureConfig,
    ablation.featureCorrect,
  );
}

/**
 * Read the feature system's abstention census, if it exposes one.
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

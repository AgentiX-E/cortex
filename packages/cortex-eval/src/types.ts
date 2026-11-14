import type { ConfidenceInterval } from '@agentix-e/cortex-core';
import type { TransportRetryReport } from './retrieval-diagnostics.js';

/**
 * Core types for the Cortex scientific evaluation harness.
 *
 * Declaration-only: every export below is a `type` or an `interface`, and all of
 * this module's import sites use `import type`. Nothing here produces a runtime
 * value, which is why `vitest.config.ts` lists this exact path as excluded from
 * coverage — an instrumented module with no executable code reports 0/0/0/0, and
 * that number would describe the instrument rather than the code. Adding a
 * runtime export to this file would silently void that exclusion, so a value
 * belongs in its own module instead.
 */

/** LongMemEval-style capability tags. */
export type Capability = 'IE' | 'MR' | 'KU' | 'TR' | 'ABS';

export type Question = {
  id: string;
  capability: Capability;
  /** The raw LongMemEval `question_type` (e.g. `single-session-assistant`). */
  questionType?: string;
  question: string;
  /** Expected answer; `null` means the correct response is to abstain. */
  expected: string | null;
  /** Session facts available to the memory system before answering. */
  context: string[];
  /**
   * Session-grouped context (each element is one session's ordered turns). It
   * preserves session boundaries for multi-session reasoning. When present, a
   * session-aware system receives this instead of the flattened `context`.
   */
  sessions?: string[][];
  /** The date the question was asked; needed for relative-time (TR) answers. */
  questionDate?: string;
  /**
   * The corpus this question reads, when the population answers one corpus more than once.
   *
   * ## The contract, which is a property of the array's ORDER
   *
   * Questions sharing this value are **contiguous** in `questions`, and they are answered by
   * **one** system instance, in ascending index order. Both halves are requirements rather than
   * observations:
   *
   * - contiguous, because `runBenchmark` claims a whole run of equal `corpus` values atomically
   *   (`claimRun` in `benchmark.ts`), and a population that scattered a corpus's windows would
   *   leave each of them claimed alone;
   * - one instance, because a later window is later **in one store**. The pool gives each worker
   *   its own `MemorySystem` (`AblationPool` in `ablation.ts`), so a window answered by a second
   *   instance reads a store that never absorbed the first window's update -- the treatment would
   *   be administered and reach nothing, which is the exact reading `S13` exists to refuse.
   *
   * This is what a two-window population needs and what the registered one cannot supply: every
   * LongMemEval-S question brings its own haystack, so no question's window ever carries another
   * question's record (`AUDIT-SEMANTIC-REACH.md` §15.2). `two-window.ts` builds the one population
   * where both windows read one corpus.
   *
   * ## Why absent is the archived state
   *
   * Every dataset loaded before this field existed carries no `corpus`, so a question with none is
   * claimed and answered exactly as it always was: one index, one claim, no ordering requirement.
   * A default of `id` would have made every question a one-window corpus and put every archived
   * run's behaviour behind a new branch, which is a change to the pass nobody could see.
   */
  corpus?: string;
  /**
   * The dataset's **gold turns**, rendered exactly as they appear in `context`.
   *
   * ## What this is, and why it is not `expected`
   *
   * `expected` is the answer *text*; this is the evidence the answer was drawn from.
   * They are different kinds of thing and only this one can answer "did the reader
   * see the evidence", which is `§13.11.5`'s question and the one run `38250133116`
   * left unreadable.
   *
   * The strings are produced by the same renderer that built `context` (`turnText`),
   * so a membership test against the carried context is an **equality test on one
   * function's output** rather than a natural-language match. That distinction is
   * the whole reason this field exists: §13.18.2 tested membership with the answer
   * text and was refuted by its own artifact -- `groundTruth` of `3` matched
   * `3. **Humidity:**`, because a list marker and a cardinality are the same token.
   *
   * ## Why it is absent rather than empty when there is no annotation
   *
   * `[]` would be a claim: "this question has no gold turns, so nothing was missed".
   * A question the dataset did not annotate -- every `_abs` question, and any
   * instance whose `answer_session_ids` are missing -- supports no such claim, and a
   * reader averaging over an empty list would understate coverage. Absent says the
   * dataset did not name the evidence, which is a different statement from naming
   * none.
   *
   * Not an oracle: nothing in the prompt path reads it. It is measured against the
   * carried context and never into it, so a signal built from this field could not
   * reach a prompt even if a later edit wanted it to -- the field is consumed by
   * `QuestionRecord`, which is written after the answer is graded.
   */
  goldTurns?: readonly string[];
};

export type BenchmarkDataset = {
  name: string;
  questions: Question[];
};

// The memory-system protocol moved to `cortex-core` (see `protocol/memory-system.ts` for why: the
// shipping class implemented these types while its package did not depend on the harness that owned
// them). Re-exported here so `cortex-eval`'s public surface is unchanged and every existing import site
// -- the benchmark, the conformance suite, the ablation arms -- keeps compiling untouched.
import type { Answer, MemorySystem, SessionAwareMemorySystem } from '@agentix-e/cortex-core';

export type { Answer, MemorySystem, SessionAwareMemorySystem };

export type PerCapabilityResult = {
  total: number;
  correct: number;
  accuracy: number;
  abstained: number;
};

export type Metrics = {
  /** Exact-match (Top-1) accuracy over all questions. */
  accuracy: number;
  /** Fraction of questions answered with `null`. */
  abstentionRate: number;
  /** Fraction of abstentions that were the correct response. */
  abstentionCorrectRate: number;
  /** Accuracy computed treating `null` as a first-class answer. */
  abstentionAwareAccuracy: number;
  total: number;
  correct: number;
  perCapability: Record<Capability, PerCapabilityResult>;
};

export type AggregateStats = {
  min: number;
  max: number;
  avg: number;
  median: number;
};

/** Paired significance statistics for a single capability. */
export type PerCapabilityPairedStats = {
  total: number;
  baselineCorrect: number;
  featureCorrect: number;
  /** Questions the baseline got right and the feature got wrong. */
  baselineCorrectFeatureIncorrect: number;
  /** Questions the baseline got wrong and the feature got right. */
  baselineIncorrectFeatureCorrect: number;
  /** Exact paired McNemar two-tailed p-value within this capability. */
  mcnemarPValue: number;
  /** True when the per-capability McNemar test is significant at alpha. */
  mcnemarSignificant: boolean;
  /** Wilson 95% confidence interval for baseline accuracy within this capability. */
  baselineConfidence: ConfidenceInterval;
  /** Wilson 95% confidence interval for feature accuracy within this capability. */
  featureConfidence: ConfidenceInterval;
};

/**
 * What an ablation had measured when it died, attached to the error it threw.
 *
 * ## Why this exists
 *
 * Run `37942775447` graded questions for ~40 minutes and then lost the connection.
 * Its artifact held `benchmark-error.log` and no report at all, because
 * `bench/run-ablation.ts` writes its report only after the arm RETURNS and the arm
 * returns only on success. Every graded answer was discarded, and the answer cache
 * that held them was a plain in-process `Map` that died with the process.
 *
 * The asymmetry that made this indefensible: the failure path persisted the
 * EMBEDDING cache and not the answers. Re-embedding repeats a deterministic,
 * already-paid computation; re-answering repeats the measurement itself.
 *
 * ## Why it is attached to the error rather than returned
 *
 * An ablation that did not finish must not resolve -- a caller cannot tell a
 * returned partial from a complete result by looking at it, and `delta` is the
 * specific number that would be fabricated if it tried. So the function still
 * rejects, and the measurement travels on the error as `partial`.
 *
 * ## What it deliberately does NOT carry
 *
 * No `delta`, no `pValue`, no `perCapability`, no aggregate. Every one of those is
 * a function of BOTH sides over the SAME index vector, so with one side short they
 * are arithmetic over data that was never paired. A rate over an empty denominator
 * is the shape §12.7 records as unreadable -- `0/0` renders identically to `0/121`
 * in a table, so an unreached capability would read as a measured zero. The answer
 * VECTORS are carried because they are the raw observation and cannot be misread
 * as a comparison; the derived statistics are not, because they can.
 */
export type PartialAblation = {
  /** The side that was running when the failure happened. */
  system: string;
  /** How many questions THAT side answered before it died. */
  reached: number;
  /** The dataset size, so `reached` is readable as `reached / total`. */
  total: number;
  /** The repetition ordinal, which disambiguates any arm with `runs > 1`. */
  run: number;
  /** The baseline's answers, in dataset order, up to wherever the baseline got. */
  baselineAnswers: Answer[];
  /** The feature's answers, in dataset order, up to wherever the feature got. */
  featureAnswers: Answer[];
  /**
   * Every repetition that FINISHED before the one that died, in ordinal order.
   *
   * ## Why this is carried rather than merely counted
   *
   * `run` says how many repetitions completed; it does not say what they measured,
   * and those are different losses. Run `38941095220` completed both sides of
   * repetition 0 at 500 of 500 each and died in repetition 1: a complete, paired,
   * N=500 measurement existed in memory when the failure path ran, and the artifact
   * published `featureAnswers: []`. Run `38520676669` had lost two of them the same
   * way. The rule this field honours is stated in `partial-ablation.test.ts` -- "a
   * repetition is a measurement, and losing one silently is the defect that file
   * exists to prevent" -- and until this field existed the rule held only for the
   * repetition that was dying.
   *
   * ## And why nothing is computed from it here
   *
   * The entries are data. `AblationResult.delta` is still absent from a partial, for
   * the reason `attachPartial` gives: the registered statistic is over four
   * repetitions, and a run that finished one of them has a reading that says `1 of
   * 4`, not the pre-registered number. A recovered repetition is a COMPLETE vector,
   * which is exactly the shape that invites the subtraction, so the boundary is
   * stated in the type rather than left to the writer.
   */
  completed: CompletedPass[];
  /**
   * What the transport layer saw before the failure, read at the moment of the throw.
   *
   * ## Why a failure record needs it more than a report does
   *
   * The counters say how many requests the provider rejected and how many calls had to retry,
   * and the reading that matters is the one taken when a run DIES: `41346610318` ended on a
   * `429` at question 13 of a 20-question probe and its artifact could not say whether the
   * ladder had been beaten by a per-minute window or by a quota nobody can wait out. Those are
   * different next dispatches.
   *
   * Optional for the reason every field here that predates an instrument is optional: a partial
   * written before `13.216` has none, and its absence must read as "not measured" rather than
   * as "nothing was retried".
   */
  transportRetry?: TransportRetryReport | undefined;
};

/** One finished repetition, both sides, in dataset order. */
export type CompletedPass = {
  /** The ordinal `BenchmarkProgress` reported for this repetition. */
  run: number;
  /** The baseline's answers for the whole dataset. */
  baselineAnswers: Answer[];
  /** The feature's answers for the whole dataset. */
  featureAnswers: Answer[];
};

/**
 * How much evidence admission produced for one question, as two counts.
 *
 * ## Why this is a type rather than two loose numbers
 *
 * It travels four hops -- the system's accessor, this package's capture, the
 * ablation result, and the per-question record -- and at every hop it is one fact
 * that must stay together. Two numbers threaded separately are two numbers that can
 * be paired wrongly, and the pairing is not checkable from the data.
 *
 * ## Why counts and not the context
 *
 * The pre-`§13.15` capture held the offered **text**, which was unbounded on this arm
 * and produced the 258 MB artifact `§13.14` records. The identities of the offer are
 * not wanted -- the model did not read them, which is the whole point -- and a bound
 * on a list that is only ever summarised is a bound on a summary that does not need
 * to be a list.
 *
 * The unit is the record's own, and `§13.16.6` repaired it: this counted **lines of
 * the joined context** -- about 6.6 lines per turn on this data, so a budget's "143
 * turns" was 22 -- because the record derived its count from a joined string the same
 * way, and the two had to agree. Both sides now count the turns admission produced,
 * which is what `turns` names.
 */
export type AdmittedEvidence = {
  readonly turns: number;
  readonly chars: number;
};

/**
 * The evidence one reader was shown, as the turns themselves.
 *
 * ## Why a list of contents rather than the joined text, since §13.16.6
 *
 * This was `string` -- the carried turns joined with newlines -- and every reader of
 * it split the string back into turns on the same newline. The round trip is lossy in
 * one direction only: a turn whose content spans newlines is then indistinguishable
 * from several turns, and no reader can recover the boundary. Run `38142407062`
 * measured the cost: 84.9% of the MR roster's entries were continuation lines, and
 * every count named "turns" was a count of lines.
 *
 * The list is the assembler's, never re-derived, so the boundary is not destroyed and
 * re-guessed. It is what `MemorySystem.lastRetrievedContext` returns and what both
 * copies of the evidence in an artifact carry -- the vector and the roster -- so the
 * two cannot describe different units.
 *
 * `[]` is "the reader was reached and carried nothing"; `null`, at the use sites, is
 * "no reader was reached". A `string` could express the first only as `''`, which is
 * the collapse the two states exist to prevent.
 */
export type RetrievedTurns = readonly string[];

/**
 * The roles a delivered window carried, as the product's own classifier counted them.
 *
 * ## Why this is a structural mirror rather than the product's type
 *
 * `cortex-eval` cannot import `cortex-memory` — the dependency runs the other way, which is why
 * `RetrievedTurns` and `AdmittedEvidence` above are shapes as well. `RoleCensus` in that package is the
 * same three fields with the same invariant (`sum(counts) + unclassified === total`), and the arm's
 * conformance tests are what keep the two from drifting.
 *
 * ## What question this answers that the filter's configuration could not
 *
 * Screening run `43465626013` recorded `evidenceRoles: ["user"]` on every record and nothing about what
 * that filter did. Its audit then reported four windows carrying an assistant turn, and separating "the
 * filter stopped working" from "the audit read the wrong set" required reconstructing four records by
 * hand — which found a third answer neither reading had.
 *
 * `counts` beside the configuration is that question answered per question: `assistant: 0` under
 * `evidenceRoles: ["user"]` is a filter that ran, `assistant: 3` is a filter that did not reach the
 * route, and `unclassified: 3` is neither — the contract keeps a turn whose role cannot be read, so it
 * is the escape hatch working rather than a defect.
 */
export type DeliveredRoleCensus = {
  /** Delivered turns per role the classifier named. */
  readonly counts: Readonly<Record<string, number>>;
  /** Delivered turns the classifier returned `undefined` for. */
  readonly unclassified: number;
  /** Delivered turns in the window. Always `sum(counts) + unclassified`. */
  readonly total: number;
};

/**
 * How much of the dataset's gold evidence the carried context contained.
 *
 * ## Why two numbers and not a boolean
 *
 * `carried === total` is the "gold-in-carried" question `§13.11.5` asks, and a
 * boolean would answer exactly that -- while throwing away the denominator a reader
 * needs to know what the answer is about. A question with one gold turn and one
 * carried scores the same as a question with twelve and twelve, and the two are not
 * the same evidence: the second says selection works across a session, the first
 * says one turn happened to survive. `§13.18.2` is what a metric without a
 * denominator cost: an aggregate that could be moved by which questions were counted.
 *
 * ## Why this is a shape rather than two loose fields
 *
 * The pair travels together from the loader through four hops to the record, which is
 * the argument `AdmittedEvidence` makes one field over: two numbers that must agree
 * have four chances to be transposed, and a transposition here would report perfect
 * coverage from an empty context.
 *
 * ## What makes it computable, which is the point of the field
 *
 * `GoldOverlap` is only answerable because the dataset's own annotation reaches the
 * record. Before this existed, `§13.11.5` was read through a session-index rule and
 * then through a substring match on the answer text, and the second was refuted by
 * its own artifact: `groundTruth` of `3` matched `3. **Humidity:**`, because a list
 * marker and a cardinality are the same token. A metric that can be read two ways is
 * not a metric.
 */
export type GoldOverlap = {
  /** Gold turns the carried context contains. */
  readonly carried: number;
  /**
   * Gold turns the **policy** admits for this question.
   *
   * Equal to the dataset's count unless the run filtered by role, in which case it is the count
   * of gold turns in an admitted role — because those are the only ones the record could ever
   * carry. §13.84's run is why: with `evidenceRoles: user`, MR's delivered share read 48.35%
   * against a dataset total that included gold turns in the excluded role, and the reading
   * looked like a retrieval collapse rather than a policy.
   */
  readonly total: number;
  /**
   * Gold turns the dataset names, present only when it differs from {@link GoldOverlap.total}.
   *
   * Absent rather than equal, so an unfiltered run is byte-identical to every artifact that
   * predates the field, and so the difference is a number on the record rather than a footnote
   * in a document that a reader of the artifact cannot see.
   */
  readonly totalAll?: number | undefined;
  /**
   * Gold turns the ranking offered, when a ranking was consulted.
   *
   * ## Why the third number exists, and what its absence means
   *
   * `carried` and `total` say how much gold reached the reader out of the gold the
   * dataset names. They cannot say **where the rest went**, and those are two different
   * failures with opposite repairs: a gold turn the ranking never surfaced is a signal
   * problem, and one the ranking held but the budget did not buy is an allocation
   * problem. Until this field existed the campaign could measure `k = 64` and `k = 256`
   * and still not tell them apart (`§13.61.7`).
   *
   * With `pool` present the three numbers partition the gold set **while the delivery
   * comes from the pool**:
   *
   * ```text
   * total - pool      the ranking never surfaced it
   * pool  - carried   the ranking had it and the budget cut it
   * carried           it reached the reader
   * ```
   *
   * ## The precondition, and the regime that breaks it
   *
   * The partition needs `carried <= pool <= total`. The upper bound cannot fail -- the
   * ranking cannot surface more gold than the dataset names -- but the lower one can:
   * since §13.68's per-turn cap the window is often wider than the pool, so selection
   * continues past the scored set and delivers gold the ranking never offered. Then
   * `carried > pool`, the same gold turn is counted in both `total - pool` and `carried`,
   * and the three numbers are **marginal counts rather than a partition**.
   *
   * §13.214 is where that was measured: run `41284575092` delivers 53 gold turns from
   * beyond its pool and run `41254359622` delivers 185, so the reader's totals, which
   * clamped `pool - carried`, printed a cut 8% and 62% smaller than its own rows and a
   * **zero** in the beyond-the-pool column that the data contradicts. A reader that adds
   * the three columns must therefore expect `total + beyond`, not `total`, and
   * `tools/readout-arm-run.py --pool` now says so in a line of its own.
   *
   * So the partition is the statement to make when `carried <= pool`, and the accounting
   * is the statement to make otherwise. Neither is a clamp: a negative `pool - carried`
   * is the measurement `carried - pool`, which is why the reader reports both directions
   * and the artifact keeps the raw counts.
   *
   * ## Absent, never zero
   *
   * A run with `relevanceSignal: none` spends an arrival-order prefix and consults no
   * ranking, so it has no pool -- and a `0` there would read as "the ranking surfaced
   * nothing", which is a measured miss standing in for a measurement that never
   * happened. Same rule as `goldOverlap` itself and for the same reason.
   *
   * ## The precondition it assumes
   *
   * `carried <= pool <= total` holds when the delivery came from the pool, which is what
   * the budget does below the pool's width. A caller that passes a pool the retrieval did
   * not produce gets an impossible row rather than a clamped one: the impossible row is
   * visible, and a clamped row would read as a finding. The lower bound fails for a
   * legitimate reason documented above -- a window wider than the pool -- and `pool > total`
   * stays a caller defect in both regimes.
   */
  readonly pool?: number | undefined;
  /**
   * Where each gold turn sits in the ranking, or `-1` when the ranking did not surface it.
   *
   * Same length as `total`, in the gold turns' own order, so a reader can count any prefix
   * without a field per cut point. `pool` is the number of non-negative entries, which is a
   * redundancy the tests assert rather than a second measurement.
   *
   * §13.65: this is the instrument that separates "ordered just below the cut" from "never
   * reachable". `pool` says how many arrived; this says how nearly.
   */
  readonly goldRanks?: readonly number[] | undefined;
  /**
   * The text of every gold turn, in the same order as {@link GoldOverlap.goldRanks}.
   *
   * ## Why the record has to carry the text, and not only its delivery
   *
   * `goldDelivered` answers *which* gold turns reached the reader, and until this field existed that
   * was the whole of the record's account of them. The turns that did **not** reach the reader then
   * had no text anywhere on the artifact: `turns` holds what the reader was shown, and a gold turn
   * dropped by the budget left with the budget.
   *
   * §13.267 needs exactly that text. The restore counterfactual reinstates a question's missing gold
   * evidence and reruns the same reader, and it cannot reinstate what it cannot quote -- so the
   * instrument that would turn §13.265.7's "twelve failures are retrieval-shaped" from an inference
   * into a measurement was blocked by one absent field. The cost is small: twelve turns at the
   * 400-character cut is under 5 KB per record and ~2.4 MB on a 500-question artifact.
   *
   * ## Absent rather than empty, and the privacy this acknowledges
   *
   * Absent when the dataset named no gold, alongside the whole block. It is **not** absent when the
   * turns were simply not delivered, which is the case it exists for.
   *
   * The marginal exposure is the gold turns that were not delivered, so exposure grows exactly where
   * the diagnostic is most needed. That trade is stated here rather than discovered later: the
   * artifact is a research record, not a product surface, and no gate in §13.267 reaches it.
   */
  readonly goldTurns?: readonly string[] | undefined;
  /**
   * Whether each gold turn reached the reader, in the same order as {@link GoldOverlap.goldRanks}.
   *
   * ## Why a count was not enough
   *
   * {@link GoldOverlap.carried} says how many arrived; it cannot say **which**. Every question this
   * campaign classified as "the ranking missed the gold" was classified from `goldRanks` alone, and
   * that inference is invalid in two independent ways (§13.253):
   *
   * 1. `rank >= turns` is not "cut". `turns` counts every delivered turn, including ones the
   *    ranking never scored, and the admission loop skips a turn that does not fit and keeps going
   *    -- so the delivered set is not a prefix of the ranking. On `41860773768` **48 questions
   *    carry a gold ranked beyond `turns` that the reader nevertheless received**.
   * 2. `rank < 0` is not "missing". A gold the ranking never scored is admitted by leftover room,
   *    and on that run **16 questions were reported as pool-missing with `carried == total`**.
   *
   * So "some gold is missing" and "some gold was never surfaced" can both be true while the missing
   * gold is not the unsurfaced one. Without these flags the intersection is not observable, and a
   * stratum built on it is a guess wearing a column header.
   *
   * ## The identity
   *
   * `goldDelivered.filter(Boolean).length === carried` and `goldDelivered.length === total`. Both
   * are redundancies in the same sense `pool` is, and both are asserted rather than trusted: a
   * producer that fills one and computes the other from a different list is the defect the
   * one-implementation rule in `goldOverlapOf` exists to prevent.
   *
   * Absent on artifacts that predate it, which is why its absence means "not recorded" rather than
   * "nothing delivered" -- `readout-arm-run.py --strata` keeps a third column for exactly that
   * state instead of reading the silence as a measurement.
   */
  readonly goldDelivered?: readonly boolean[] | undefined;
};

/** A count's spread across repetitions: the smallest, the mean and the largest. */
export type CountSpread = {
  /** Fewest correct in any repetition. */
  readonly min: number;
  /** Mean correct over the repetitions. */
  readonly avg: number;
  /** Most correct in any repetition. */
  readonly max: number;
};

/**
 * The four ways a discordant question can change verdict, split by the abstention line.
 *
 * Lives here rather than beside the classifier because `AblationResult` carries it and this file is where
 * every report shape lives; the classifier in `answer-transition.ts` imports the type rather than declaring
 * a second one. Read as two pairs: `recovered`/`declined` is the decline flow, `corrected`/`missed` the
 * content flow.
 */
export type AnswerTransition = {
  /** Baseline declined, treatment answered correctly: the treatment made it speak, and it was right. */
  readonly recovered: number;
  /** Baseline answered wrongly, treatment answered correctly: already speaking, now right. */
  readonly corrected: number;
  /** Baseline answered correctly, treatment declined: the treatment stopped it speaking. */
  readonly declined: number;
  /** Baseline answered correctly, treatment answered wrongly: still speaking, now wrong. */
  readonly missed: number;
};

/**
 * A question the scorer could not decide, and why.
 *
 * Declared here rather than in `metrics.ts` because `AblationResult` -- the shape every
 * report is built from -- carries these, and `metrics.ts` already imports from this module:
 * the reverse import would be a cycle. `metrics.ts` re-exports it under the name its own
 * docblock argues for, so there is one shape and two readers rather than two shapes.
 */
export type UnjudgedVerdict = {
  readonly questionId: string;
  readonly cause: string;
};

export type AblationResult = {
  feature: string;
  baselineAggregate: AggregateStats;
  featureAggregate: AggregateStats;
  /** Mean accuracy difference (feature − baseline). */
  delta: number;
  /** Welch two-tailed p-value over stochastic runs; NaN when runs < 2. */
  pValue: number;
  /** True when the over-run t-test is significant at alpha. */
  significant: boolean;
  /** Cohen's d effect size over stochastic runs. */
  effectSize: number;
  /** Wilson 95% confidence interval for baseline accuracy. */
  baselineConfidence: ConfidenceInterval;
  /** Wilson 95% confidence interval for feature accuracy. */
  featureConfidence: ConfidenceInterval;
  /** Exact paired McNemar two-tailed p-value (paired over questions). */
  mcnemarPValue: number;
  /** True when the paired McNemar test is significant at alpha. */
  mcnemarSignificant: boolean;
  /** Discordant pairs feeding the McNemar test. */
  discordant: {
    /** Questions the baseline got right and the feature got wrong. */
    baselineCorrectFeatureIncorrect: number;
    /** Questions the baseline got wrong and the feature got right. */
    baselineIncorrectFeatureCorrect: number;
  };
  /**
   * Identity of every discordant pair, so a flip COUNT can be audited.
   *
   * The counts answer "how many" and leave "which" unanswerable, and "which" is
   * what separates a mechanism from a coincidence. The conjunction arm reported
   * four flips against one, all inside IE, while its target population (ABS)
   * never moved — zero flips across six runs and 143 ABS questions. That is the
   * difference between "the intervention did nothing" and "the intervention did
   * something somewhere else", and the earlier report could not show it: it
   * carried the flip count and the feature's per-question vector, but neither the
   * question ids nor the baseline's vector, so no archived artifact could name
   * the questions that moved.
   *
   * Ids rather than indices, because an index is meaningful only relative to a
   * dataset order that is not itself recorded. Ids survive reordering, and they
   * let a reader confirm a per-capability count instead of trusting it.
   */
  discordantQuestions: {
    /** Ids of questions the baseline got right and the feature got wrong. */
    readonly baselineCorrectFeatureIncorrect: readonly string[];
    /** Ids of questions the baseline got wrong and the feature got right. */
    readonly baselineIncorrectFeatureCorrect: readonly string[];
  };
  /**
   * The same two flip counts, split by which side of the abstention line each question was on.
   *
   * `discordant` above says how many questions changed verdict. It cannot say whether the change was the
   * system **starting to speak** or **starting to be right**, because `correct` is a boolean and a decline is
   * a value in `answers`, not in `correct`. A +3 net built from decline crossings is a response-shape change;
   * a +3 net built from corrected answers is a knowledge change; the two sum to the same number and call for
   * different work. `answer-transition.ts` holds the classification and the rule for reading it, and
   * `recovered + corrected` must equal `discordant.baselineIncorrectFeatureCorrect` — an identity the tests
   * assert against this very structure, so the refinement cannot drift into a rival count.
   *
   * Optional for the reason `featureAnswers` above is: this type is also the shape of a **report read back
   * from disk**, and every artifact written before this field existed lacks it. `runAblation` — the only
   * producer — sets it unconditionally, so a missing value means an old artifact and never a new run that
   * skipped the work. The renderer prints that absence in words rather than omitting the section, because a
   * silently shorter report is how a field goes missing for a year.
   */
  transitions?: AnswerTransition | undefined;
  /**
   * Per-capability correct counts across the repetitions: min, mean and max.
   *
   * ## Why this exists beside `featureAggregate`
   *
   * `featureAggregate` is a spread over the runs; every per-capability count in the roster is **one
   * run's**. §13.87's replication is what that cost: the same configuration, code and data moved MR
   * from 90 to 83 between two runs, and the artifact held no per-capability spread to say so.
   *
   * ## Absent, not degenerate
   *
   * With one repetition min, mean and max are the same number, and a spread of zero would read as
   * perfect stability — the strongest possible claim from no evidence. So the field is omitted
   * unless there were at least two repetitions.
   */
  featureByCapability?: Record<string, CountSpread> | undefined;
  /** The baseline side of {@link AblationResult.featureByCapability}. */
  baselineByCapability?: Record<string, CountSpread> | undefined;
  /**
   * Questions per capability, so a count can be turned into a rate without re-reading the dataset.
   *
   * Present on the same condition as the spreads: without them there is nothing to divide.
   */
  questionsByCapability?: Record<string, number> | undefined;
  /**
   * Per-question correctness on **every** repetition, run-major: one string per repetition, one
   * character per dataset question, `'1'` correct and `'0'` not (see `correctnessMask`).
   *
   * ## What the spreads above cannot say
   *
   * `featureByCapability` is `{min, avg, max}` of a *count*. Three numbers cannot name a question,
   * cannot be recomputed for a population smaller than a capability, and cannot separate one question
   * flapping four times from four questions flapping once each — the same spread, opposite readings.
   *
   * That matters most for exactly the populations this campaign keeps asking about. A review pass is
   * reachable on ten of the 121 MR questions; a `+4` on those ten is a large effect and a `+4` spread
   * over 121 is inside the noise, and the collapsed counts cannot tell the two apart because the
   * denominator was thrown away before they were computed.
   *
   * ## Absent, not duplicated
   *
   * With one repetition this field would be a second copy of `featureCorrect`, and two arrays that
   * must agree are two arrays that can disagree — the reason `correctnessVector` derives rather than
   * stores. So it is omitted at one repetition, on the same condition as the spreads.
   */
  featureCorrectByRun?: readonly string[] | undefined;
  /** The baseline side of {@link AblationResult.featureCorrectByRun}. */
  baselineCorrectByRun?: readonly string[] | undefined;
  /** Metrics from the first evaluation of the baseline system. */
  baselineMetrics: Metrics;
  /** Metrics from the first evaluation of the feature system. */
  featureMetrics: Metrics;
  /** Per-question correctness of the feature system, in dataset question order. */
  featureCorrect: boolean[];
  /**
   * The feature system's answers, in dataset question order, when the run recorded them.
   *
   * `featureCorrect` says whether each answer was graded right; it does not say
   * what the answer was. Every investigation that needs to read the model's
   * actual output -- §55.4's "what do the 30 abstentions have in common?" above
   * all -- was blocked on that gap: the vector recorded the verdict and the
   * output itself was dropped in `scoreEvaluation` one layer below this result.
   * An abstention appears here as `null`, which is a value and not a hole.
   *
   * Optional because `AblationResult` is a report shape that a dozen tests
   * construct by hand from a correctness vector alone, and a required field would
   * force every one of them to invent an answer list to satisfy the type --
   * putting fabricated data into fixtures to satisfy a compiler. The guarantee
   * that belongs to the measurement is asserted where it can be: the arm's suite
   * requires the records it is built from to carry the answer each system
   * actually produced, and requires them to agree with this vector.
   */
  featureAnswers?: Answer[];
  /**
   * The feature system's raw model output per question, in dataset question order.
   *
   * ## Why `featureAnswers` above is not enough to read
   *
   * `Answer` is `string | null`, and a decline is recognised from the last
   * non-empty line only after a label like `Answer:` is stripped. So the bare
   * token, a labelled token, and an explanation followed by the token all arrive
   * as `null`. Dispatch `37792539133` is the measurement of what that costs: 115
   * of its 120 roster records read `null`, and the 29 questions it exists to
   * explain -- 13 baseline-correct MR and 16 TR -- cannot be told apart. The
   * text that would tell them apart existed in the process and died at
   * `parseAnswer`'s return.
   *
   * `null` here means the model was not consulted (a machine-derived abstention)
   * or the feature exposes no raw output. Both are "no text", and neither is the
   * empty string, which would claim the model replied with nothing.
   *
   * Optional for the same reason `featureAnswers` is: `AblationResult` is a
   * report shape that tests build by hand from a correctness vector, and a
   * required field would make every such fixture invent raw text to satisfy the
   * type. The measurement's guarantee is asserted where it can be -- the arm's
   * suite requires the records to be aligned with the answers they explain.
   */
  featureRawOutputs?: (string | null)[];
  /**
   * The evidence each question's feature-side reader was shown.
   *
   * One entry per question, holding the admitted turns joined by newlines, or
   * `null` when the machine declined before a reader was shown anything.
   *
   * §13 measured MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every
   * capability. The next hypothesis is retrieval quality, and it cannot be asked
   * without this: "the reader was shown the wrong turn" and "the reader was shown
   * nothing" are repaired in different places, and before this vector existed the
   * roster carried `turns: []` for every record, so the artifact reported both as
   * the same absence.
   *
   * `null` and `''` are different statements. `null` is "no reader was shown
   * anything", which is what a machine-derived abstention produces. `''` would
   * claim a context was shown and happened to be blank, which this package treats
   * as an answer rather than as an abstention.
   *
   * Optional for the reason `featureRawOutputs` is: a hand-built fixture that
   * omits it yields records with `turns: []`, which is the honest reading of a
   * fixture that never retrieved anything.
   *
   * ## Why this is `readonly`, and why that is not cosmetic
   *
   * Every writer that bounds this vector (`boundRetrievedContexts`) returns a
   * fresh array it does not hand out for mutation, and the type says so. Declaring
   * it mutable forced the bound to be applied through a widening cast, which is
   * the shape that lets a later writer mutate evidence some other reader is still
   * holding. Read-only here makes the bounded copy assignable without one.
   */
  featureRetrievedContexts?: readonly (RetrievedTurns | null)[];
  /**
   * The evidence characters the feature side's prompts actually carried, per
   * question.
   *
   * The second half of the same fact as `featureRetrievedContexts`, and the half
   * that keeps it from being misleading. The captured context is what the reader
   * was shown; this is how much of it survived the prompt builder's character
   * budget. Run `38044858147` met that budget on every question -- 506,338
   * characters of evidence against 24,000 -- so the context vector overstates
   * what the model received by about twenty times, and `§13.11.5`'s ranking
   * question needs this one.
   *
   * Optional for the same reason, and `readonly` for the same reason: it is the
   * measurement rather than the thing measured, and a writer that mutated it in
   * place would be editing evidence another reader holds.
   */
  featurePromptEvidenceChars?: readonly (number | null)[];
  /**
   * What admission produced for the feature side, per question.
   *
   * ## Why the artifact needs this at all
   *
   * `featurePromptEvidenceChars` is the **delivery** and `featureRetrievedContexts`
   * is its roster, so together they say what the model read. Neither says how much
   * evidence **existed**, and §13.15's run is why that matters: with only the
   * delivery, `evidenceTurns` fell from 3,016-4,528 to a median of 141 and a reader
   * could no longer tell a budget that had cut ninety-eight per cent of the context
   * from a retrieval that had found almost nothing. Those two runs want opposite
   * repairs.
   *
   * Optional for the same reason as the other captures, and `readonly` likewise.
   */
  featureAdmittedEvidence?: readonly (AdmittedEvidence | null)[];
  /**
   * Questions each side's scorer could not decide.
   *
   * ## Why this is on the result and not only in the log
   *
   * `41585013786` reported `unjudged: 0`'s absence as an absence: the judge failed on one
   * question, the process exited 1, and no report was written, so a reader of the log learns
   * the count and a reader of any artifact learns nothing. The census belongs to the
   * measurement -- an accuracy over 500 questions of which 2 were never judged is a different
   * claim from one over 500 judged, and only the artifact can say which one it is holding.
   *
   * Two sides rather than one array because the paired test needs them separate: a question
   * unjudged in one arm only is a discordant pair the instrument invented, and it has to be
   * removable from `discordant` without also removing the other arm's legitimate verdict.
   *
   * Optional on the type because `AblationResult` is a shape tests build by hand, and
   * `runAblation` -- the only producer -- writes it on every path.
   */
  unjudged?: {
    readonly feature: readonly UnjudgedVerdict[];
    readonly baseline: readonly UnjudgedVerdict[];
  };
  /**
   * The prompt the feature side's reader was sent, per question.
   *
   * ## Why the ablation carries the text and not a fingerprint
   *
   * `§13.168.8` wants a fingerprint per record, and the two candidate layers are this
   * one and the arm that writes the artifact. `cortex-memory` cannot hash -- it imports
   * no host API -- so the text has to reach a Node-side consumer either way. Hashing
   * here would work, but this file's `feature*` vectors are the ablation's own record of
   * what happened, and a digest is a lossy projection chosen for artifact size rather
   * than a measurement: the arm that decides how much of each prompt to keep is the arm
   * that should decide how to fingerprint it.
   *
   * Optional for the reason the other captures are, and `readonly` likewise. A `null`
   * entry means the system exposes no prompt, which is not an empty prompt.
   */
  featurePromptTexts?: readonly (string | null)[];
  /**
   * The path the product says each question took, in dataset order.
   *
   * ## Why an audit needs this and the capability is not a substitute
   *
   * `capability` is the **dataset's** word for a question's shape; a route is the **arm's** word for the path
   * it took, and the two diverge exactly where an audit is most likely to be wrong. A `TR` question on a
   * system that does not declare `answerTemporal` falls through to the flat path, and `ABS` can carry
   * `single-session-assistant`. An audit that checks a per-route option against a capability therefore checks
   * it against a path the question may never have taken — which is one of the two readings screening run
   * `43465626013` could not distinguish.
   *
   * `null` per question means the system does not report a route. That is a different statement from "it took
   * the flat path", and folding them would let an unreported route read as a routed one.
   */
  featureRoutes?: readonly (string | null)[];
  /**
   * The roles the delivered window carried on the feature side, per question, in dataset order.
   *
   * The filter's **effect**, beside its configuration. `evidenceRoles: ["user"]` beside `assistant: 0` is a
   * filter that ran; the same configuration beside `assistant: 3` is a filter that did not reach the route;
   * and `unclassified: 3` is neither, because the contract keeps a turn whose role cannot be read.
   *
   * `null` per question means the system was not given a classifier, which is a different statement from a
   * window in which every turn was unclassifiable.
   */
  featureRoleCensuses?: readonly (DeliveredRoleCensus | null)[];
  /**
   * How many distinct prompts each question cost across the repetitions, in dataset order.
   *
   * `1` means every pass resent the same bytes for that question, which is the premise `§13.147.3`'s 60-80%
   * prefix-cache prediction rests on. The premise was falsified twice -- 6.47% (`§13.148`) and 11.16%
   * (`§13.168`) -- and neither artifact could say whether the arm had sent four prompts or the provider had
   * declined to cache one, because a fingerprint per record is taken from one pass and a length is not a
   * identity.
   *
   * Absent at `runs: 1`, where the count would be the constant `1` and would read as a measurement. `null`
   * for a question where any pass reported no prompt: a system that answered "no prompt" once has not shown
   * that it matched. Present per question rather than as one number for the run, because a divergence on a
   * handful of questions is the shape most likely to be true and the one a run-level flag would erase.
   */
  featurePromptVariants?: readonly (number | null)[];
  /**
   * One question's prompt, kept textually for every repetition, so a reader can see the bytes that moved.
   *
   * ## Why a count is not enough, and §13.175 is why the count is not enough
   *
   * `featurePromptVariants` answers *whether* the passes resent the same request. It cannot answer *what
   * moved*, and the first run that carried it reported `4` on every one of the 500 questions while two
   * dispatches of the identical configuration delivered **byte-identical evidence** -- same turns, same
   * order, same character count, `0/500` digests equal. That combination leaves only the invariant part of
   * the prompt, and no count can point at it.
   *
   * A witness is the cheapest object that can: one question, all of its passes, in full. It is bounded by
   * the prompt budget rather than by the roster (`4 x 48,000` characters at the registered settings), which
   * is why it is one question and not a vector.
   *
   * ## Which question
   *
   * The first dataset position whose first pass reported a prompt. Not a random draw and not the worst
   * case: a witness is read by diffing passes against each other, so any question that was answered twice
   * serves, and the first one is the only choice that is reproducible without a seed.
   *
   * Absent at `runs: 1`, where there is no second pass to compare against.
   */
  featurePromptRepeatWitness?: {
    /** Dataset position of the witnessed question, so the two texts can be joined to a record. */
    readonly index: number;
    readonly questionId: string;
    /** One entry per repetition, in repetition order. */
    readonly texts: readonly (string | null)[];
    /**
     * Leading bytes shared with `texts[0]`, per repetition.
     *
     * `null` at index `0` by construction: a pass agrees with itself everywhere, and writing the length
     * there would read as a measurement of agreement. `null` wherever either pass reported no prompt,
     * because a pass that sent nothing has not been shown to match.
     *
     * Stored rather than derived by every reader, because the comparison is the whole cost of this field
     * and the artifact is read far more often than it is written. The lengths also make the document
     * self-describing: `0` says the passes diverge at the first byte, which cannot be told by eye from a
     * pair of 48,000-character blobs.
     */
    readonly commonPrefix: readonly (number | null)[];
  };
  /** Paired significance statistics broken down per capability. */
  perCapability: Record<Capability, PerCapabilityPairedStats>;
};

/**
 * One increment's discordant identity, in a form two increments can be compared in.
 *
 * `discordantQuestions` already holds these two lists, and it holds them inside a result that also holds
 * the baseline's metrics, the feature's metrics, five confidence intervals and the per-capability table.
 * Comparing two increments would otherwise mean carrying two whole results into a function whose only
 * question is set intersection, and the risk in that shape is not verbosity: it is that one caller decides
 * "bought" from `discordant` counts and another from `discordantQuestions` ids, and the two disagree about
 * the same run with nothing failing.
 *
 * So the ledger keeps the ids and the label and nothing else. The label is required because a portfolio of
 * anonymous lists renders as a set and a reader cannot attribute a purchase to the increment that paid.
 */
export type IncrementLedger = {
  /** How the increment will be named in a document, e.g. `silent`. */
  readonly label: string;
  /** Ids the increment got right that its own baseline got wrong. */
  readonly bought: readonly string[];
  /** Ids the increment got wrong that its own baseline got right. */
  readonly sold: readonly string[];
};

/**
 * What a group of increments bought and lost, with the double-counting made visible.
 *
 * Every field is derived from the `IncrementLedger`s and none of it is a new measurement of accuracy: the
 * union sizes answer "how many distinct questions moved", the sums answer "what adding the per-increment
 * gains would claim", and the two differ exactly when two increments paid for the same question.
 */
export type Portfolio = {
  /** Distinct ids bought by at least one increment, in first-appearance order. */
  readonly bought: readonly string[];
  /** Distinct ids sold by at least one increment, in first-appearance order. */
  readonly sold: readonly string[];
  /** Ids bought by two or more increments: the questions a sum counts more than once. */
  readonly doubleCounted: readonly string[];
  /** Ids one increment bought and another sold: the questions a sum of nets cancels to nothing. */
  readonly conflicting: readonly string[];
  /** Σ|bought| across increments -- the claim "+9 and +6 make +15" makes. */
  readonly summedBought: number;
  /** Σ|sold| across increments. */
  readonly summedSold: number;
};

/**
 * The part of an ablation result a ledger reads, and why the field is optional here when it is required
 * on `AblationResult`.
 *
 * A ledger asks one question of a run -- which questions crossed the verdict line -- and reading it
 * through the whole result would tie the portfolio to sixteen fields it never touches, including five
 * confidence intervals and a per-capability table. Narrowing the parameter is not decoration: it is what
 * lets a caller build a portfolio from a **report read back from disk**, and a report read back from disk
 * is exactly the shape that may predate `discordantQuestions`. On the live path the field is always
 * present -- `runAblation` is its only producer and it sets the field unconditionally -- so the
 * optionality describes the archive, not the pipeline, and `ledgerOf` refuses rather than guessing when an
 * archived artifact has neither.
 */
export type LedgerSource = {
  readonly discordantQuestions?:
    | {
        readonly baselineCorrectFeatureIncorrect: readonly string[];
        readonly baselineIncorrectFeatureCorrect: readonly string[];
      }
    | undefined;
};

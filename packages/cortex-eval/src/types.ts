import type { ConfidenceInterval } from '@agentix-e/cortex-core';

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

/** A single answer: a string, or `null` to abstain. */
export type Answer = string | null;

/**
 * A memory system under evaluation.
 *
 * **The contract is wider than this type.** `runBenchmark` routes on the presence
 * of the optional members declared by `SessionAwareMemorySystem` below, so a system
 * must be conformant not only in shape but in behaviour: every optional path it
 * declares will be called, with a particular argument shape, and must return
 * `Answer`. `{ name, answer }` alone is fully conformant and receives every
 * question.
 *
 * [`memory-system-conformance.test.ts`](./__tests__/memory-system-conformance.test.ts)
 * asserts that routing contract executably — which member each question shape is
 * routed to, in what order, and what happens when a member is absent. It is the
 * suite an implementation of this type is verified against; see
 * [`docs/AUDIT-EVAL-CONTRACTS.md`](../../../docs/AUDIT-EVAL-CONTRACTS.md) for why it
 * did not exist until it was needed.
 */
export type MemorySystem = {
  name: string;
  /**
   * `sessions` is the session-grouped view of `context` when the caller has it.
   * Optional and additive: a system that wants only the flat list is unaffected,
   * and the benchmark already carries it on every question that has one.
   */
  answer: (question: string, context: string[], sessions?: string[][]) => Answer | Promise<Answer>;
};

/**
 * A memory system that can exploit session boundaries. The benchmark routes
 * session-grouped questions to `answerSessions` and falls back to `answer` with
 * the flattened context otherwise.
 */
export type SessionAwareMemorySystem = MemorySystem & {
  answerSessions: (question: string, sessions: string[][]) => Answer | Promise<Answer>;
  /**
   * Temporal-reasoning answering with the question date; optional for simpler
   * systems. Falls back to `answer` when absent.
   *
   * `sessions` is the session-grouped form of the same turns as `context`, when
   * the caller has it. It is OPTIONAL and additive: a system that wants only the
   * flat list keeps receiving exactly that. It exists because admission is
   * bounded by a turn budget, and a session boundary is what lets a system spend
   * that budget on a session retrieval already judged relevant instead of on
   * scattered neighbours. Measured on run 34915402976, correct answers admit
   * 52.4% of their evidence session against 40.0% for failures.
   */
  answerTemporal?: (
    question: string,
    context: string[],
    questionDate?: string,
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering that includes assistant turns. The evidence for a
   * `single-session-assistant` question lives in an assistant turn, so the
   * user-turn-only `answer` path would drop it. Falls back to `answer` when
   * absent.
   */
  answerAssistant?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for abstention questions (the correct answer is to
   * abstain because no answer exists). Uses a conservative abstention wording
   * that does not push the model to choose among candidates. Falls back to
   * `answer` when absent.
   */
  answerAbstention?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for preference/recommendation questions. Unlike the
   * extractive `answer` path, which asks for a single fact and abstains when
   * none is present, these questions ask for a suggestion that reflects the
   * user's stated preferences. Falls back to `answer` when absent.
   */
  answerPreference?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for knowledge-update questions. These questions ask
   * which value a time qualifier selects ("previous" → the earlier value,
   * "currently/most recent" → the later value), which the generic extractive
   * prompt does not make explicit. Falls back to `answer` when absent.
   */
  answerKnowledgeUpdate?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
};

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
  /** Gold turns the dataset names for this question. */
  readonly total: number;
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
   * With `pool` present the three numbers partition the gold set:
   *
   * ```text
   * total - pool      the ranking never surfaced it
   * pool  - carried   the ranking had it and the budget cut it
   * carried           it reached the reader
   * ```
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
   * the budget does. A caller that passes a pool the retrieval did not produce gets an
   * impossible row rather than a clamped one: the impossible row is visible, and a
   * clamped row would read as a finding.
   */
  readonly pool?: number | undefined;
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
  /** Paired significance statistics broken down per capability. */
  perCapability: Record<Capability, PerCapabilityPairedStats>;
};

/**
 * Per-question artefact: the record an ablation must persist for its own verdict
 * to be auditable.
 *
 * Three readers need this and none can be served by an aggregate:
 *
 *   1. **The B7 criterion** (`tools/read-b7-criterion.mjs`). It recomputes the
 *      target roster from the run's own inputs and then applies the three
 *      clauses. Until this existed it failed with "no per-question array found"
 *      on every archived report, because the artifacts carried counts and
 *      discordant IDS but no per-question roster. A criterion that cannot be
 *      executed is not a criterion.
 *
 *   2. **Noise quantification** (`variance.ts`). `compareQuestionVectors` takes
 *      two `boolean[]` vectors aligned by question id. Nothing produced those
 *      vectors, so the module that exists to answer "how many questions does the
 *      endpoint move on its own?" had no real caller and no real data. That is
 *      the P4 lesson restated: a delta is not a measurement unless the noise it
 *      must clear has been measured, and the noise cannot be measured from
 *      counts.
 *
 *   3. **A reader asking "which questions moved"**. `docs/09-...` §20 records an
 *      A/B whose two arms differed by two questions and whose artifacts could
 *      not name them. A count is not a roster.
 *
 * ## What this module does NOT do
 *
 * It does not score anything and it does not decide correctness. `correct` is
 * passed in, and when a correctness vector is supplied it is authoritative --
 * because the vector is what the scorer returned, while a caller-set `correct`
 * is that caller's summary of it. Two sources for one boolean is how a report
 * and the vector inside it come to disagree.
 *
 * ## Why `turns` is derived here rather than stored pre-split
 *
 * `computeTargetCohort` clusters over `turns`, and a single blob would place
 * every candidate in one turn, so no two clusters could form and every question
 * would classify `unseparable`. The derived split is therefore load-bearing for
 * the criterion, not cosmetic.
 */

import type { TurnLike } from './candidate-context.js';
import type { FeatureConfig } from './report.js';

/**
 * One graded question, with everything a downstream reader needs to re-derive a
 * verdict about it.
 *
 * Field names follow `CohortQuestion` in `b7-cohort.ts` for the four fields the
 * criterion consumes (`questionId`, `question`, `groundTruth`, `answer`) plus
 * `grounded`, so the criterion reader transcribes rather than translates. A
 * translation layer between two spellings of the same field is a place for them
 * to drift apart silently.
 */
export type QuestionRecord = {
  /** Stable identifier. Ids, not indices — an index is meaningful only relative
   * to a dataset order that is not itself recorded, so ids survive reordering. */
  readonly questionId: string;
  readonly question: string;
  readonly capability: string;
  /**
   * The dataset's gold answer. `string | number` because LongMemEval stores some
   * golds as JSON numbers, and coercing here would make `85` and `"85"`
   * indistinguishable downstream. `null` is a gold of "no answer", which is a
   * real value and not an absence.
   */
  readonly groundTruth?: string | number | null;
  /**
   * What the system produced. `null` means it abstained; `undefined` means
   * nobody recorded an answer. The criterion has a branch for the first and
   * none for the second, and conflating them reports a recording gap as reader
   * behaviour.
   */
  readonly answer?: string | number | null;
  /**
   * The system's raw model output for this question, before it was parsed.
   *
   * ## Why `answer` above cannot stand in for it
   *
   * `answer` is the parsed value, and `Answer` is `string | null`. `parseAnswer`
   * recognises a decline from the **last non-empty line only**, after stripping
   * a label like `Answer:` and comparing case-insensitively, so the bare token,
   * a labelled token and an explanation followed by the token all arrive as
   * `null`. Dispatch `37792539133` carried the first real roster built from this
   * shape and 115 of its 120 records read `null`; the 29 baseline-correct
   * questions the read exists to explain were three behaviours collapsed into
   * one value.
   *
   * `undefined` means nobody captured raw output for this question, `null` means
   * the model was not consulted (a machine-derived abstention) or the system
   * exposes none. The two are different statements, which is the same
   * distinction `answer` above draws one field earlier.
   */
  readonly rawOutput?: string | null;
  /** The scorer's verdict for this question. */
  readonly correct: boolean;
  /**
   * Whether the upstream classifier called this a grounded failure at all.
   * `false` excludes the question from B7 before clustering, so a change in the
   * classifier cannot silently enlarge the target set.
   */
  readonly grounded: boolean;
  /** The retrieved context the reader was shown, split into admission order. */
  readonly turns: readonly TurnLike[];
  /**
   * How many turns the reader was shown, before any bound was applied.
   *
   * ## Why this is not `turns.length`
   *
   * Run `38003036421` completed all four runs of all five hundred questions and
   * then died writing the JSON with `RangeError: Invalid string length`: the
   * memory arm carries the evidence **unbounded**, and carries it twice -- once
   * in `ablation.featureRetrievedContexts`, once as `turns[].text` here. The
   * report that would have documented the run could not be written, and the
   * artifact could not distinguish a measurement that failed to serialize from a
   * run that never measured.
   *
   * The fix is to bound what is carried without bounding what is measured. This
   * field is the measurement: it is the true count and is **never** reduced.
   * `turns` may be, and when it is, `turns.length !== evidenceTurns` is the
   * signal.
   *
   * `§13.11.3`'s first prediction -- MR/TR records carry a non-empty evidence
   * vector -- is decided by `evidenceTurns > 0`, so it survives any bound. The
   * second, that abstention records are not uniformly empty, is decided by
   * comparing this field against the population, and survives likewise.
   */
  readonly evidenceTurns: number;
  /**
   * The size in characters of the evidence the reader was shown, un-reduced.
   *
   * Carried beside `evidenceTurns` because the two fail differently: a question
   * can be shown one enormous turn or a thousand small ones, and a bound chosen
   * on turn count alone would be defeated by the first. A reader deciding
   * whether the bound engaged needs both, and a reader auditing the bound's cost
   * needs `evidenceChars`.
   *
   * Measured, never reduced, for the reason `evidenceTurns` states.
   */
  readonly evidenceChars: number;
  /**
   * The switches this record was produced under, stamped per record.
   *
   * Per record rather than once beside the array: a reader handed one record out
   * of the array — which is what a diff or a filtered subset gives them — must
   * still be able to see which configuration produced it. Absent when no
   * configuration was recorded; omitted rather than defaulted to all-off,
   * because a fabricated "everything off" reads as evidence about a run nobody
   * recorded.
   */
  readonly featureConfig?: FeatureConfig | undefined;
};

/** One question's inputs, before the record is assembled. */
export type QuestionRecordInput = {
  readonly questionId: string;
  readonly question: string;
  readonly capability: string;
  readonly groundTruth?: string | number | null;
  readonly answer?: string | number | null;
  /** The system's raw model output, when a caller captured it. */
  readonly rawOutput?: string | null;
  /** The caller's summary of the verdict; overridden by `correctness` if given. */
  readonly correct: boolean;
  readonly grounded: boolean;
  /** The retrieved context as the reader received it, one turn per line. */
  readonly retrieved: string;
};

/**
 * The marker appended as a final turn when a record's evidence was reduced.
 *
 * ## Why a marker rather than a flag
 *
 * A boolean field would say "this was reduced" and leave a reader unable to see
 * *how much* -- and the `turns` array would then read as a complete record whose
 * `turns` happened to be short. The marker travels inside the array it describes,
 * so it cannot be separated from the thing it is a statement about: a reader who
 * filters or diffs `turns` carries the disclosure with them.
 *
 * It is deliberately not a valid turn: `commit` boundaries and the clustering
 * criterion both treat it as text, and a marker that could be mistaken for
 * evidence would let a reduction enlarge the target set.
 *
 * The three states this distinguishes, per `§13.11.2`'s requirement that an
 * absence must never render as a value:
 *
 * | State | `turns` | `evidenceTurns` |
 * | --- | --- | --- |
 * | reader shown nothing | `[]` | `0` |
 * | shown, carried in full | complete | `turns.length` |
 * | shown, reduced | prefix + this marker | the true count |
 */
export const REDUCED_TURNS_MARKER = '[evidence reduced:';

/**
 * How much of each record's evidence to carry, when a bound is wanted.
 *
 * Absent means carry everything -- the pre-existing behaviour, kept as the
 * default so no existing caller changes meaning. Present bounds `turns` only;
 * `evidenceTurns` and `evidenceChars` are never reduced.
 */
export type EvidenceBoundOptions = {
  /**
   * The maximum number of real turns to carry per record, before the marker.
   *
   * Must be at least 1. A bound of `0` would carry no evidence at all while
   * still reporting `evidenceTurns > 0`, which is the "reduced reads as absent"
   * confusion this type exists to prevent -- so it is rejected rather than
   * silently clamped.
   */
  readonly maxTurnsPerRecord: number;
};

/**
 * Split retrieved context into ordered turns.
 *
 * Blank lines are dropped rather than emitted as empty turns: a blank turn
 * carries no content terms, so it can never be clustered, and keeping it only
 * inflates the index space a reader has to walk. `contextRadius`-style
 * neighbours are not reconstructible from the joined text, which is why the
 * record is a faithful transcription of what the reader saw and not a
 * reconstruction of the hits list.
 */
function toTurns(retrieved: string, bound?: EvidenceBoundOptions): TurnLike[] {
  const turns: TurnLike[] = [];
  for (const line of retrieved.split('\n')) {
    if (line.trim().length === 0) continue;
    turns.push({ index: turns.length, text: line });
  }
  if (bound === undefined || turns.length <= bound.maxTurnsPerRecord) {
    return turns;
  }
  const dropped = turns.length - bound.maxTurnsPerRecord;
  const kept = turns.slice(0, bound.maxTurnsPerRecord);
  // The marker is the LAST turn, so a reader who reads `turns` in order sees the
  // disclosure after the evidence it qualifies rather than before it.
  kept.push({
    index: kept.length,
    text: `${REDUCED_TURNS_MARKER} ${dropped} of ${turns.length} turns not carried]`,
  });
  return kept;
}

/**
 * Assemble the per-question records for one arm.
 *
 * `correctness`, when supplied, is the authority for `correct` and must align
 * with `inputs`; a length mismatch throws rather than truncating. A vector and a
 * record list that are off by one align every question after the gap against the
 * wrong one, and `compareQuestionVectors` would then compare two runs on that
 * basis and return a plausible number derived from meaningless data — which is
 * the specific error `variance.ts` throws to prevent one layer down. Catching it
 * here keeps the cause visible at the point of construction.
 *
 * Duplicate ids throw for the same class of reason: ids are the join key for
 * every comparison this artefact feeds, and a map built from a duplicated key
 * silently keeps one record and drops the other, so a moved question would read
 * as stable.
 */
export function buildQuestionRecords(
  inputs: readonly QuestionRecordInput[],
  featureConfig?: FeatureConfig,
  correctness?: readonly boolean[],
  evidenceBound?: EvidenceBoundOptions,
): QuestionRecord[] {
  if (correctness !== undefined && correctness.length !== inputs.length) {
    throw new Error(
      `correctness vector length ${correctness.length} is not ${inputs.length}, the number of question records`,
    );
  }
  if (evidenceBound !== undefined && evidenceBound.maxTurnsPerRecord < 1) {
    throw new Error(
      `maxTurnsPerRecord must be at least 1, got ${String(evidenceBound.maxTurnsPerRecord)}. ` +
        'A bound of 0 would carry no evidence while still reporting evidenceTurns > 0, which ' +
        'makes a reduced record read as one whose reader was shown nothing.',
    );
  }

  const seen = new Set<string>();
  const records: QuestionRecord[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    if (seen.has(input.questionId)) {
      throw new Error(`duplicate question id in per-question records: ${input.questionId}`);
    }
    seen.add(input.questionId);

    // Measured before the bound is applied, which is the whole point: these two
    // fields are the evidence, and `turns` is what is carried of it.
    const measuredTurns = toTurns(input.retrieved);
    records.push({
      questionId: input.questionId,
      question: input.question,
      capability: input.capability,
      ...(input.groundTruth === undefined ? {} : { groundTruth: input.groundTruth }),
      ...(input.answer === undefined ? {} : { answer: input.answer }),
      ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
      correct: correctness === undefined ? input.correct : correctness[i]!,
      grounded: input.grounded,
      turns: toTurns(input.retrieved, evidenceBound),
      evidenceTurns: measuredTurns.length,
      evidenceChars: input.retrieved.length,
      ...(featureConfig === undefined ? {} : { featureConfig }),
    });
  }
  return records;
}

/**
 * What a bound did to a record set, or `null` when it did nothing.
 *
 * ## Why this is derived rather than tallied during construction
 *
 * A caller that incremented counters while building would hold a second source
 * for what the records already say, and the two could disagree -- `§12.7`'s
 * shape, where a value is reported one way and stored another. Deriving it from
 * the records means a report's reduction manifest and its records cannot
 * contradict each other, and it lets the manifest be computed after the fact by
 * a reader that was handed only the artifact.
 *
 * `null` rather than a zero-valued object, because "no bound was applied" and "a
 * bound was applied and dropped nothing" are different facts about a run, and a
 * manifest that renders them identically would make a decorative bound look like
 * a working one. `§13.12.5` predicts the reducible set is non-empty; this is what
 * makes that prediction falsifiable.
 */
export function evidenceReductionOf(records: readonly QuestionRecord[]): EvidenceReduction | null {
  const reduced = records.filter((record) => record.turns.length !== record.evidenceTurns);
  if (reduced.length === 0) return null;

  let turnsCarried = 0;
  let turnsMeasured = 0;
  let charsMeasured = 0;
  for (const record of records) {
    turnsCarried += record.turns.length;
    turnsMeasured += record.evidenceTurns;
    charsMeasured += record.evidenceChars;
  }
  return {
    reducedQuestionIds: reduced.map((record) => record.questionId),
    turnsCarried,
    turnsMeasured,
    charsMeasured,
    maxTurnsPerRecord: Math.max(...reduced.map((record) => record.turns.length - 1)),
  };
}

/**
 * The per-question correctness vector of a record set, in record order.
 *
 * Derived from the records rather than kept as a second array. Two arrays that
 * must agree are two arrays that can disagree, and the disagreement would be
 * invisible until a comparison reported a flip that never happened.
 */
export function correctnessVector(records: readonly QuestionRecord[]): boolean[] {
  return records.map((record) => record.correct);
}

/** The question ids of a record set, in record order, for vector comparison. */
export function recordIds(records: readonly QuestionRecord[]): string[] {
  return records.map((record) => record.questionId);
}

/**
 * What an evidence bound did to a record set.
 *
 * Present only when something was actually dropped -- see
 * {@link evidenceReductionOf} for why absence is `null` rather than zeros.
 */
export type EvidenceReduction = {
  /** Ids of the records whose `turns` is shorter than `evidenceTurns`. */
  readonly reducedQuestionIds: readonly string[];
  /** The number of turns actually carried across all records, after the bound. */
  readonly turnsCarried: number;
  /** The number of turns measured across all records, before the bound. */
  readonly turnsMeasured: number;
  /** The characters of evidence measured across all records, before the bound. */
  readonly charsMeasured: number;
  /** The largest number of real turns any reduced record carries. */
  readonly maxTurnsPerRecord: number;
};

/**
 * The minimum a question must expose for a record to be built from it.
 *
 * Stated structurally rather than importing `Question`, so this module does not
 * depend on the dataset type: the same builder serves LongMemEval instances and
 * synthetic datasets, and a caller that has only a question id and a gold is not
 * forced to fabricate the rest.
 */
export type RecordableQuestion = {
  readonly id: string;
  readonly question: string;
  readonly capability: string;
  /** `null` is the dataset's "no answer" gold, a real value and not an absence. */
  readonly expected: string | null;
};

/**
 * What one question's decision trace contributes to its record.
 *
 * A structural subset of `DecisionTrace` on purpose. `question-record.ts` must
 * not import `natural-language-memory.ts`: that module is a system
 * implementation, this one is artefact assembly, and depending on it would make
 * the record shape track the one system that currently produces traces.
 */
export type RecordableTrace = {
  readonly question: string;
  /** Context injected into the LLM; empty or absent when the reader abstained. */
  readonly retrieved?: string | undefined;
  readonly answer?: string | number | null | undefined;
  /** Read by the caller's groundedness classifier, not by this module. */
  readonly llmRaw?: string | undefined;
};

/**
 * Assemble per-question records from a dataset, a trace stream and a scorer.
 *
 * The join is by **question text**, which is what `DecisionTrace` carries. Two
 * questions with identical text therefore share a trace, and that is a real
 * limitation rather than an oversight: the alternative is to reconstruct the
 * trace-to-question mapping from call ORDER, which is invisible to this function
 * and silently wrong if any path short-circuits. Text is at least falsifiable --
 * a dataset with a repeated question produces records that obviously share a
 * trace, where an order-based join produces records that look fine and are not.
 *
 * `grounded` is supplied by the caller as a predicate rather than inferred here.
 * Groundedness is a property of the failure classifier, not of the record, and
 * an inlined guess would become a second implementation of it that a dataset
 * change could not break.
 */
export function buildRecordsFromDataset(
  questions: readonly RecordableQuestion[],
  traces: readonly RecordableTrace[],
  correctness: readonly boolean[],
  isGrounded: (input: {
    question: RecordableQuestion;
    trace: RecordableTrace | undefined;
  }) => boolean,
  featureConfig?: FeatureConfig,
): QuestionRecord[] {
  if (correctness.length !== questions.length) {
    throw new Error(
      `correctness vector length ${correctness.length} is not ${questions.length}, the number of questions`,
    );
  }

  // Last trace wins, matching the consumer in `bench/run.ts`, which scans the
  // trace list in reverse. A system may emit more than one trace for a question
  // -- the abstention retry re-queries -- and the LAST one describes the answer
  // that was actually scored.
  const traceByQuestion = new Map<string, RecordableTrace>();
  for (const trace of traces) {
    traceByQuestion.set(trace.question, trace);
  }

  return buildQuestionRecords(
    questions.map((question, i) => {
      const trace = traceByQuestion.get(question.question);
      return {
        questionId: question.id,
        question: question.question,
        capability: question.capability,
        groundTruth: question.expected,
        // `answer` is taken from the trace when a trace exists, and left absent
        // when none does. It is NOT defaulted to `null`: `null` means the reader
        // abstained, which is a finding, and a missing trace means nobody
        // recorded what happened, which is a gap. The criterion has a branch for
        // the first and none for the second.
        ...(trace === undefined ? {} : { answer: trace.answer ?? null }),
        correct: correctness[i]!,
        grounded: isGrounded({ question, trace }),
        retrieved: trace?.retrieved ?? '',
      };
    }),
    featureConfig,
  );
}

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
  /** The caller's summary of the verdict; overridden by `correctness` if given. */
  readonly correct: boolean;
  readonly grounded: boolean;
  /** The retrieved context as the reader received it, one turn per line. */
  readonly retrieved: string;
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
function toTurns(retrieved: string): TurnLike[] {
  const turns: TurnLike[] = [];
  for (const line of retrieved.split('\n')) {
    if (line.trim().length === 0) continue;
    turns.push({ index: turns.length, text: line });
  }
  return turns;
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
): QuestionRecord[] {
  if (correctness !== undefined && correctness.length !== inputs.length) {
    throw new Error(
      `correctness vector length ${correctness.length} is not ${inputs.length}, the number of question records`,
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

    records.push({
      questionId: input.questionId,
      question: input.question,
      capability: input.capability,
      ...(input.groundTruth === undefined ? {} : { groundTruth: input.groundTruth }),
      ...(input.answer === undefined ? {} : { answer: input.answer }),
      correct: correctness === undefined ? input.correct : correctness[i]!,
      grounded: input.grounded,
      turns: toTurns(input.retrieved),
      ...(featureConfig === undefined ? {} : { featureConfig }),
    });
  }
  return records;
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

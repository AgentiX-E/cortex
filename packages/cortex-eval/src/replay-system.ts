/**
 * A `MemorySystem` that answers from a recorded list instead of from a model.
 *
 * ## The run that made this necessary
 *
 * `41625442265` was dispatched to test §13.234's four predictions and produced no measurement: the
 * pass died on `BenchmarkBudgetExceeded` at question 146 of 500 in the fifth of eight passes. What
 * it did produce is a partial record holding **two complete repetitions of both arms** -- 2,000
 * answers, as 2,000 `Answer` values, because `Answer` is `string | null` and nothing is lost when
 * one is written to disk. The prediction was never tested and the data that could test it was
 * sitting in the artifact.
 *
 * Re-running the arm would cost five more hours and would measure a *different* draw from the same
 * process, not the same one. Replaying the recorded answers through the same scorer costs the
 * grading alone -- 755 judge calls for those 2,000 answers -- and measures exactly the pass that
 * happened.
 *
 * ## Why this is not interpolation
 *
 * A regrade is the *instrument* applied twice, not a number invented for a missing one. The answers
 * are the measurement; the scorer is how they are read. `attachPartial` already keeps them for
 * exactly this reason (`types.ts`: "a partial result must not report a delta"), and the artifact's
 * own channel census -- structural 556, exact 485, numeric 204, judge 755 -- is reproducible from
 * the answers alone, which is what makes the two readings comparable.
 *
 * The line this must not cross is the one §13.236.7 drew: a *missing* answer is not a wrong answer
 * and must never be filled in from the other arm. A replay system is constructed from one side's
 * list and answers only from it; it has no access to the other side, so it cannot borrow.
 *
 * ## Why it is keyed by the question rather than by a cursor
 *
 * A cursor is the shortest implementation and it silently absorbs the one bug this tool could have:
 * if the recorded list and the dataset order ever disagree, a cursor returns answer `i` to question
 * `i` and the artifact reports a real score for a misaligned pairing. Keying by the question text
 * makes the misalignment a thrown error instead -- one that names the question that had no answer.
 *
 * Duplicate question text is then the one input this cannot serve, and it is refused at
 * construction rather than resolved by "first wins": two questions sharing a text would each receive
 * whichever answer the map kept, and the report would be a mixture of two passes that no field in it
 * would announce.
 */
import type { Answer, BenchmarkDataset, MemorySystem } from './types.js';

/** How much of a question the refusal message quotes, so a 4,000-character prompt stays readable. */
const QUOTE_CHARS = 120;

/**
 * One repetition of both arms, as the partial record wrote it.
 *
 * The field names are the record's, not this module's invention: `attachPartial` has written
 * `{ run, baselineAnswers, featureAnswers }` into `completed[]` since run `37942775447` lost forty
 * minutes of grading to a dropped connection, and a reader that renamed them would be a second
 * schema for the same file.
 */
export type CompletedPass = {
  readonly run: number;
  readonly baselineAnswers: readonly Answer[];
  readonly featureAnswers: readonly Answer[];
};

/**
 * The completed repetitions inside a partial artifact, or a refusal that says why there are none.
 *
 * ## What this is for, and what it is not
 *
 * `41625442265` died on `BenchmarkBudgetExceeded` in its fifth pass and wrote no report, but it
 * wrote `completed[]` with two repetitions of both arms in it. This reads them back so the
 * measurement can be graded without repeating it.
 *
 * It does not fill in the passes that did not finish, and it cannot: `completed[]` holds what ran.
 * A reader that returned three passes for a two-pass artifact -- by repeating one, or by taking the
 * in-flight pass's partial answers -- would be inventing the measurement §13.236.7 refused to
 * invent.
 *
 * ## Why empty is refused rather than returned as `[]`
 *
 * A caller that receives an empty list can compute an accuracy over zero questions, and `0 / 0` in
 * `computeMetrics` is a report saying `0.00%` rather than a report saying nothing was measured.
 * The distinction the partial record exists to preserve is exactly this one.
 */
export function readCompletedPasses(record: unknown): CompletedPass[] {
  if (typeof record !== 'object' || record === null) {
    throw new Error(`a partial record must be an object, got ${typeof record}`);
  }
  const completed = (record as { completed?: unknown }).completed;
  if (!Array.isArray(completed)) {
    throw new Error(
      'this record has no `completed` array, so it holds no pass to replay. A record without one is ' +
        'either not a partial artifact or older than the field.',
    );
  }
  if (completed.length === 0) {
    throw new Error(
      'this record completed no pass, so there is nothing to grade. An empty replay would report an ' +
        'accuracy over zero questions, which reads as a score rather than as an absence.',
    );
  }
  const seen = new Set<number>();
  return completed.map((entry: unknown, index: number): CompletedPass => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`completed[${index}] is not an object`);
    }
    const { run, baselineAnswers, featureAnswers } = entry as {
      run?: unknown;
      baselineAnswers?: unknown;
      featureAnswers?: unknown;
    };
    if (typeof run !== 'number' || !Number.isInteger(run)) {
      throw new Error(`completed[${index}].run must be an integer, got ${JSON.stringify(run)}`);
    }
    if (seen.has(run)) {
      throw new Error(
        `completed[] names run ${run} twice, so the record cannot say which repetition is which. ` +
          'Refused rather than deduplicated: the two entries are different measurements and either ' +
          'choice would silently drop one.',
      );
    }
    seen.add(run);
    if (!Array.isArray(baselineAnswers) || !Array.isArray(featureAnswers)) {
      throw new Error(
        `completed[${index}] (run ${run}) must carry both \`baselineAnswers\` and ` +
          '`featureAnswers` as arrays: one side alone cannot be paired against the other.',
      );
    }
    return {
      run,
      baselineAnswers: baselineAnswers as Answer[],
      featureAnswers: featureAnswers as Answer[],
    };
  });
}

/**
 * Wrap a recorded answer list as a system the ablation can score.
 *
 * The dataset is required rather than optional because the alignment claim is the whole point: a
 * constructor that accepted a bare array could only check lengths, and lengths are the one thing a
 * misordered list still gets right.
 */
export function replaySystem(
  name: string,
  dataset: BenchmarkDataset,
  answers: readonly Answer[],
): MemorySystem {
  if (answers.length !== dataset.questions.length) {
    throw new Error(
      `replay ${JSON.stringify(name)} has ${answers.length} answers for ${dataset.questions.length} ` +
        'questions. The two must be the same length: a shorter list would leave the last questions ' +
        'unanswered and a longer one would mean the recording was graded against a different file.',
    );
  }
  const byQuestion = new Map<string, Answer>();
  for (let i = 0; i < dataset.questions.length; i++) {
    const question = dataset.questions[i]!;
    if (byQuestion.has(question.question)) {
      throw new Error(
        `replay ${JSON.stringify(name)} cannot key question ${JSON.stringify(question.id)}: its text ` +
          `is shared with another question in ${JSON.stringify(dataset.name)}, so a lookup by text ` +
          'would return one of the two answers for both. Refused rather than resolved by first ' +
          'match, because the result would be a mixture no field in the report announces.',
      );
    }
    byQuestion.set(question.question, answers[i]!);
  }
  return {
    name,
    answer: (question: string): Answer => {
      if (!byQuestion.has(question)) {
        throw new Error(
          `replay ${JSON.stringify(name)} was asked a question it has no answer for: ` +
            `${JSON.stringify(question.slice(0, QUOTE_CHARS))}. The recorded list is aligned to the ` +
            'dataset by text, so this means the pass was graded against a different file than the ' +
            'one being replayed against.',
        );
      }
      return byQuestion.get(question)!;
    },
  };
}

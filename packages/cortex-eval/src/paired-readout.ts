/**
 * The per-question half of a report, small enough to keep and complete enough to pair.
 *
 * ## The defect this exists for
 *
 * `41741547141` regraded two complete repetitions of a dead run's answers and produced a report
 * containing, per repetition, exactly five numbers: the two arms' metrics, the delta, the discordant
 * **counts**, and the McNemar p-value. Those five numbers answered §13.234's predictions 1, 3 and 4.
 * They could not answer prediction 2, which is stated about a **cohort of questions** -- "the gain
 * concentrates in the 41 questions whose gold sat outside the pool: at least 3 of 16 convert" --
 * and a cohort is not recoverable from an aggregate.
 *
 * The prediction was therefore recorded as untested, and the reason recorded with it was wrong: the
 * note said `goldRanks` caps at 255 and so "outside the pool" and "at 255" are the same value. They
 * are not -- `-1` is the encoding for a gold turn the ranking never surfaced, and 254 is a rank
 * inside a 256-wide pool. The artifact was able to answer the question; **the tool had discarded the
 * rows that answer it.**
 *
 * That is the third instance in this campaign of the same shape (§13.236.5's fixture written against
 * the reader, §13.238.2's dead zone, and this): a field exists, is correct, and is not carried to the
 * place where the decision is made. The repair is not a new measurement. It is to make the row a
 * first-class output and to state its cost.
 *
 * ## What a row costs, and why these fields
 *
 * The live artifact is 75 MB for 500 questions because each record carries the delivered turns and
 * the model's raw output. None of that is needed to pair two arms, and all of it would make a
 * regrade report unreadable. So a row carries:
 *
 * - `id` and `capability`, because a cohort is defined by questions and reported by capability;
 * - `correct`, because the pairing is the measurement;
 * - `goldRanks`, because the cohort in question is "gold the ranking never surfaced", and `-1` is the
 *   only place that fact is recorded;
 * - `goldPool`, the number of gold turns the ranking did surface, so a reader can tell a question
 *   with no outside gold from one whose gold was never retrieved at all;
 * - `deliveredTurns` and `promptChars`, because the two arms of a room experiment differ in exactly
 *   those and a paired reading that cannot see them cannot attribute the difference.
 *
 * ## Why the projection is here and not in the script that calls it
 *
 * `bench/regrade-partial.ts` is a bench script: typechecked, not covered. A projection living there
 * would be the only code in this campaign that decides what a paired reading can see and is never
 * tested. Here it is a pure function over the record type, and the shape it emits is what the readout
 * consumes.
 */

import type { QuestionRecord } from './question-record.js';

/** One question, as a paired reading needs it. */
export type PairedRow = {
  readonly id: string;
  readonly capability: string;
  readonly correct: boolean;
  /**
   * Where each gold turn sat in the run's own relevance order, `-1` for never surfaced.
   *
   * Absent when the run consulted no ranking, which is a different state from an empty list: a
   * caller that conflated them would read "no ranking" as "the ranking surfaced nothing".
   */
  readonly goldRanks?: readonly number[];
  /** Gold turns the ranking offered; absent for the same reason {@link goldRanks} is. */
  readonly goldPool?: number;
  /** Turns the prompt carried, or `null` when the run recorded no window composition. */
  readonly deliveredTurns: number | null;
  /** Characters the whole prompt held, or `null` when the record predates the field. */
  readonly promptChars: number | null;
};

/**
 * Project a report's question records into rows a paired reading can use.
 *
 * Order is the report's order, which is the dataset's order in every artifact this campaign has
 * produced. It is preserved rather than sorted because a reader comparing two runs of the same arm
 * expects the same question at the same index, and sorting by id would hide a misalignment instead of
 * exposing it.
 */
export function pairedRows(questions: readonly QuestionRecord[]): PairedRow[] {
  return questions.map((question) => {
    const ranks = question.goldOverlap?.goldRanks;
    const pool = question.goldOverlap?.pool;
    return {
      id: question.questionId,
      capability: question.capability,
      correct: question.correct,
      // Spread rather than assigned `undefined`, so a run with no ranking produces a row without the
      // two keys rather than one carrying `undefined` -- the distinction this file's header draws.
      ...(ranks === undefined ? {} : { goldRanks: [...ranks] }),
      ...(pool === undefined ? {} : { goldPool: pool }),
      deliveredTurns: question.windowComposition?.turns ?? null,
      promptChars: question.promptChars ?? null,
    };
  });
}

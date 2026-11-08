/**
 * The **oracle evidence** condition: hand the reader the gold sessions instead of
 * whatever retrieval surfaced, and change nothing else.
 *
 * ## The question this answers, and why it could not be answered before
 *
 * §1.38.5 of the competitor analysis registers one decomposition that every serious
 * rival publishes and this project never has: split the distance to 100% into the part
 * **retrieval** lost and the part the **reader** lost. `Caura` publishes both numbers on
 * LongMemEval-S (92.2% shipped, 94.6% oracle) and the split is 2.4 points of retrieval
 * against 5.4 of reading. We publish a shipped number and a *pool* ceiling (`recall-curve`
 * answers "what if this pool were perfectly reordered", 93.02%), which is a different
 * quantity: a perfect reordering of a pool that does not contain the answer still cannot
 * answer.
 *
 * `docs/MEASURE-READING-STAGE.md` §5.2 states the gap in its own words -- "not the oracle
 * ceiling ... it cannot separate 'the reader is weak' from 'this reader is weak on this
 * context'". This module closes it.
 *
 * ## Why a dataset transform rather than a system wrapper
 *
 * The evidence reaches a `MemorySystem` as an argument (`answer(question, context,
 * sessions)`), so the pool can be replaced at two layers: wrap the system and substitute
 * the argument, or rewrite the dataset the arm is handed. The transform wins on one
 * property that matters here -- **it cannot lose a member**. A wrapper has to re-expose
 * `answerSessions`, `answerTemporal`, `answerAssistant`, `answerPreference`,
 * `answerKnowledgeUpdate`, `answerAbstention` and the five optional accessors
 * (`lastRawOutput`, `lastRetrievedContext`, `lastPromptEvidenceChars`,
 * `lastAdmittedEvidence`, `lastPromptText`), and the harness decides *routing* from the
 * presence of those members. A wrapper that forgets one does not throw: the router falls
 * through to `answer`, the reserved path is never taken, and the artifact reports a
 * ceiling measured under a different prompt. The transform leaves the system untouched and
 * moves only the evidence, which is exactly the single variable this measurement is
 * supposed to move.
 *
 * ## What the gold pool is
 *
 * `Question.goldTurns` is already the complete set of turns from the dataset's
 * `answer_session_ids` -- the same set LongMemEval's official oracle file ships as its
 * `haystack_sessions`. `sessionize` rebuilds the session boundaries by membership against
 * `Question.sessions`, so the pool keeps the boundaries a multi-session answer needs. A
 * turn that appears in no session is **refused with an error** rather than dropped: `goldTurns`
 * is derived from the sessions by the same renderer (`goldTurnsOf`), so an unplaceable turn
 * is a renderer disagreement, and a ceiling computed over a pool that quietly lost the
 * answer turn understates the reader for a reason no reader of the artifact could see.
 *
 * ## What the condition does and does not hold fixed
 *
 * Held fixed: the reader, the judge, the temperature, the prompt contract, the admission
 * gate, the per-turn cap, the prompt budget, the answer cache and the repetition count.
 * Every one of them is read from the same environment by the same code, because the only
 * edit is to `context`/`sessions`.
 *
 * Not held fixed, and it must be said in the artifact rather than in a footnote: the pool
 * is ~12 turns instead of ~550, so the prompt is a fraction of its shipped size. The
 * reading ceiling is therefore measured at a *shorter* context as well as a *correct* one,
 * and this condition cannot separate "better evidence" from "less evidence". Caura's
 * published 94.6% has the same property; it is the definition of the condition rather than
 * a weakness of this implementation. The budget curve (`E1`) is the measurement that
 * separates them, which is why the two are registered together.
 */

import type { BenchmarkDataset, Question } from './types.js';

/**
 * The suffix the graded dataset's name carries, and the only field a reader of the
 * artifact has to look at to know which evidence produced the numbers.
 *
 * The name rather than a new top-level field: `AblationReport.dataset` is
 * `dataset.name` (report.ts), it is rendered in the artifact and in the Markdown, and
 * `assertOracleReached` below checks the value *after* the arm returns. A separate field
 * would need its own plumbing through the arm's options, and the failure mode that
 * plumbing is supposed to prevent -- the transform not reaching the graded run -- is
 * caught more cheaply by the field the artifact already carries.
 */
const ORACLE_DATASET_SUFFIX = '+oracle';

/** What the transform did, as counts. Every field is a count of questions or units. */
export type OracleEvidenceCensus = {
  /** Questions in the graded dataset. */
  readonly questions: number;
  /** Questions whose context was replaced by their gold sessions. */
  readonly sourced: number;
  /**
   * Questions the dataset annotated with no gold evidence, kept at their shipped context.
   *
   * Counted rather than ignored because a ceiling over a mixed population is not a
   * ceiling: the sourced subset is the reader's upper bound and the unsourced questions are
   * a shipped-retrieval measurement wearing the same label. This dataset annotates all 500
   * (including the 30 `ABS` questions, whose gold is a session that must be read and then
   * declined), so a non-zero value here refutes the transform rather than the product.
   */
  readonly unsourced: number;
  /** Turns in the graded pools, summed over questions. */
  readonly turns: number;
  /** UTF-16 code units in the graded pools, summed over questions. */
  readonly chars: number;
  /** Turns in the *shipped* contexts of the same questions, for the comparison in the log. */
  readonly shippedTurns: number;
  /** UTF-16 code units in the shipped contexts of the same questions. */
  readonly shippedChars: number;
};

export type OracleEvidenceDataset = {
  /** The dataset to hand the arm. Same questions, same order, gold-only evidence. */
  readonly dataset: BenchmarkDataset;
  readonly census: OracleEvidenceCensus;
};

/**
 * Rewrite every question's evidence to its gold sessions.
 *
 * Pure: the input dataset and every `Question` in it are left untouched, and the output
 * shares the question objects it did not need to rewrite. That matters because the caller
 * holds the shipped dataset for the relevance index, and an in-place edit would make the
 * index describe a corpus the arm never read.
 *
 * @throws when the dataset already carries the suffix (a second application would silently
 * measure the oracle of the oracle and report it under a name that says it was applied
 * once), or when a gold turn belongs to no session.
 */
export function oracleEvidenceDataset(dataset: BenchmarkDataset): OracleEvidenceDataset {
  if (dataset.name.endsWith(ORACLE_DATASET_SUFFIX)) {
    throw new Error(
      `oracle evidence was applied twice: dataset is already named ${JSON.stringify(dataset.name)}. ` +
        'The second application would replace the gold pool with itself and record a census that ' +
        'describes neither population, and the artifact would still say the condition ran once.',
    );
  }

  let sourced = 0;
  let unsourced = 0;
  let turns = 0;
  let chars = 0;
  let shippedTurns = 0;
  let shippedChars = 0;

  const questions = dataset.questions.map((question) => {
    shippedTurns += question.context.length;
    shippedChars += totalChars(question.context);

    const gold = question.goldTurns;
    if (gold === undefined || gold.length === 0) {
      unsourced += 1;
      return question;
    }

    const sessions =
      question.sessions === undefined
        ? undefined
        : goldSessionsOf(question, gold, question.sessions);

    // The flat context is derived from the graded pool rather than computed twice, so the
    // two views the router can reach (`context` for the flat routes, `sessions` for `MR`)
    // cannot describe different evidence. When the dataset carried no session grouping the
    // pool is the gold list itself, and `sessions` stays absent rather than becoming a
    // one-element array: a fabricated boundary would route every question to the session
    // path and change the prompt for a reason the condition never named.
    const context = sessions === undefined ? [...gold] : sessions.flat();

    sourced += 1;
    turns += context.length;
    chars += totalChars(context);

    return {
      ...question,
      context,
      ...(sessions === undefined ? {} : { sessions }),
      // `goldTurns` is carried unchanged, which is what makes the artifact's own
      // `goldOverlap` a check on this transform: after it runs, every retrieved turn is
      // drawn from the gold set, so `carried` can fall short of `total` only if the
      // reader's own prompt assembly dropped a turn it was handed.
      goldTurns: gold,
    } satisfies Question;
  });

  return {
    dataset: { name: `${dataset.name}${ORACLE_DATASET_SUFFIX}`, questions },
    census: {
      questions: dataset.questions.length,
      sourced,
      unsourced,
      turns,
      chars,
      shippedTurns,
      shippedChars,
    },
  };
}

/**
 * One log line, printed before the first question is answered.
 *
 * Both populations are on it because the ratio is the fact a reader needs and neither
 * number is interpretable alone: 7,516 turns is a pool and 550 per question is a corpus.
 * `shipped / graded` is the multiplier the *prompt* shrinks by, which is the confound the
 * condition cannot remove.
 */
export function describeOracleCensus(census: OracleEvidenceCensus): string {
  const ratio = census.turns === 0 ? 'n/a' : (census.shippedTurns / census.turns).toFixed(1);
  return (
    `Oracle evidence: ${census.sourced}/${census.questions} question(s) carry the gold sessions` +
    (census.unsourced === 0 ? '' : `, ${census.unsourced} keep their shipped context`) +
    `; pool ${census.turns} turns / ${census.chars} chars against ${census.shippedTurns} / ` +
    `${census.shippedChars} shipped (${ratio}x fewer turns)`
  );
}

/**
 * Refuse a finished run whose artifact does not say the condition reached it.
 *
 * `assertRerankReachesRanking`'s precedent, one layer out: the transform is applied by the
 * bench entry point, the artifact is written by the arm, and between them sit a dataset
 * hand-off, a restriction plan and a sampler. A run whose transform was applied *after* the
 * arm was called, or applied to a dataset that was then replaced, produces a shipped-pool
 * number under `dataset: "longmemeval+oracle"` -- and the number would be read as a ceiling,
 * which is the one thing it is not. Tying the check to the artifact rather than to the
 * local variable is what makes it a check.
 */
export function assertOracleReached(
  reported: { readonly dataset: string; readonly questionCount: number },
  census: OracleEvidenceCensus,
): void {
  if (!reported.dataset.endsWith(ORACLE_DATASET_SUFFIX)) {
    throw new Error(
      `the artifact says dataset=${JSON.stringify(reported.dataset)}, which is not an oracle ` +
        'dataset -- the transform was applied to a dataset the arm did not grade. The numbers ' +
        'would be a shipped-retrieval score published under an oracle label.',
    );
  }
  if (reported.questionCount !== census.questions) {
    throw new Error(
      `the artifact graded ${reported.questionCount} question(s) while the oracle census ` +
        `describes ${census.questions} -- the two describe different populations, so the ` +
        'sourced/unsourced split cannot be applied to the number it is quoted beside.',
    );
  }
}

/**
 * The gold turns, grouped by the session each belongs to, in the dataset's own order.
 *
 * Iterating the sessions rather than the gold list is what preserves turn order inside a
 * session, which matters for `TR` (a date line precedes the facts it dates) and for any
 * reader that resolves pronouns against the preceding turn.
 */
function goldSessionsOf(
  question: Question,
  gold: readonly string[],
  sessions: readonly string[][],
): string[][] {
  const wanted = new Set(gold);
  const placed = new Set<string>();
  const groups: string[][] = [];
  for (const session of sessions) {
    const kept = session.filter((turn) => wanted.has(turn));
    if (kept.length === 0) continue;
    for (const turn of kept) placed.add(turn);
    groups.push(kept);
  }
  const missing = gold.filter((turn) => !placed.has(turn));
  if (missing.length > 0) {
    throw new Error(
      `question ${JSON.stringify(question.id)} names ${missing.length} gold turn(s) that belong ` +
        'to no session, e.g. ' +
        JSON.stringify(missing[0]!.slice(0, 120)) +
        '. `goldTurns` is derived from the sessions by the same renderer, so this is a ' +
        'renderer disagreement rather than a dataset property -- and a pool that quietly ' +
        'dropped the answer turn would understate the reader for a reason no reader of the ' +
        'artifact could see.',
    );
  }
  return groups;
}

function totalChars(turns: readonly string[]): number {
  let sum = 0;
  for (const turn of turns) sum += turn.length;
  return sum;
}

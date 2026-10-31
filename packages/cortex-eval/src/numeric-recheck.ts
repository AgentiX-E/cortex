/**
 * Score a numeric capability without the judge.
 *
 * ## Why the name screen was the wrong instrument for MR
 *
 * `§13.185` ran the name screen on the 84 accepted MR answers of `41159983913` and found **0 candidates
 * with a reach of 2 of 84**: 82 of those golds name nothing at all. Reading the population explains it.
 * MR golds are `2`, `$50`, `20%`, `3 days`, `$5,850`, `140 hours`, `190`. Multi-session reasoning on this
 * dataset is arithmetic over several sessions, so a screen built on *which name appears* cannot see the
 * capability the campaign's head-to-head is about — and the audit's 44.90% on `entity-swap` is therefore
 * a statement about the 122 accepted answers whose golds do name something, two of which are MR.
 *
 * ## What replaces it
 *
 * A judge-free reading of the number the answer states. The arm's replies end with the answer
 * (`$60 ÷ 5 = $12 per mug. 12`), so the **last** numeric token in the reply is a candidate for "the value
 * the reader committed to". That is a property of this arm's output format, not of truth, and it is
 * checked rather than assumed: the agreement between this rule and the judge on the accepted population
 * is published with the reading, and a rule that picked the wrong token would show up there as
 * systematic disagreement.
 *
 * ## The two directions, both of which are judge-free
 *
 * | judge said | the number says | what it is |
 * | --- | --- | --- |
 * | accepted | differs | a **false accept**, found without asking the judge |
 * | accepted | agrees | agreement |
 * | rejected | agrees | a **false reject**, which the audit could not measure at all |
 * | rejected | differs | agreement |
 *
 * The second row is the reason this instrument exists beside the audit: the audit perturbs answers the
 * judge *accepted*, so it is structurally blind to answers the judge rejected while they were right.
 *
 * ## Four ways this is not a truth machine
 *
 * 1. **Units.** `3 days` and `72 hours` parse to 3 and 72 and are called different. The class size is
 *    reported so the reading cannot be quoted without it.
 * 2. **Golds without digits.** `an hour and a half` yields nothing to compare, and is counted as
 *    unreachable rather than as agreement.
 * 3. **Percentages and scales.** `20%` is read as 20, so an answer saying `0.2` differs. Deliberate: a
 *    normaliser that guessed the scale would be deciding the answer.
 * 4. **Arithmetic shown.** An answer that computes the gold and then states something else is
 *    `agrees-early` — its own relation, because folding it into either side would hide the one failure
 *    that looks most like success.
 */

import { wilsonUpper } from './judge-audit.js';

/** How the number the answer states relates to the number the gold states. */
type NumericRelation =
  'agrees' | 'agrees-early' | 'differs' | 'gold-unreachable' | 'answer-unreachable';

/** One graded answer, as the artifact records it. */
type NumericSource = {
  readonly questionId: string;
  readonly gold: string;
  readonly answer: string;
  readonly capability?: string;
  readonly accepted: boolean;
};

/** One screened answer: the values on both sides, so the predicate can be audited from the reading. */
type NumericRow = {
  readonly questionId: string;
  readonly capability: string;
  readonly accepted: boolean;
  readonly relation: NumericRelation;
  readonly goldValues: readonly number[];
  /** The last number the answer states — what this reader committed to. */
  readonly stated: number | undefined;
  readonly answerValues: readonly number[];
};

type NumericTally = Readonly<Record<NumericRelation, number>> & { readonly total: number };

type NumericReading = {
  readonly rows: readonly NumericRow[];
  readonly accepted: NumericTally;
  readonly rejected: NumericTally;
  /** Accepted answers that state a number differing from the gold's: false accepts, judge-free. */
  readonly falseAccepts: readonly NumericRow[];
  /** Rejected answers that state the gold's number: false rejects, which the audit cannot see. */
  readonly falseRejects: readonly NumericRow[];
  /**
   * Accuracy over the rows this instrument can read, computed from the numbers alone.
   *
   * `unreachable` is excluded rather than counted either way, and reported beside it, because a
   * denominator that silently absorbed unreadable golds would make the instrument look better the
   * blinder it got.
   */
  readonly judgeFree: {
    readonly correct: number;
    readonly total: number;
    readonly unreachable: number;
  };
  /**
   * False accepts per accepted answer this instrument could read, with a Wilson 95% upper bound.
   *
   * `0 of 80` is not a measurement on its own: it is consistent with a rate as high as the bound. The
   * pair is what makes the number quotable, and the bound is the same function the audit's gate uses, so
   * "this capability is under 5%" and "the judge accepts 19.38% overall" are the same arithmetic.
   */
  readonly falseAccept: {
    readonly accepted: number;
    readonly readable: number;
    readonly rate: number;
    readonly upper: number;
  };
};

/**
 * Every number the text states, in order, commas removed.
 *
 * Not a unit-aware parser and not a calculator: an answer stating `$60 ÷ 5 = $12` yields `60, 5, 12`,
 * and the last of them is what the reader answered. Evaluating the expression instead would make this
 * module a second arithmetic implementation and would silently disagree with the reader's own arithmetic
 * on every rounding it does differently.
 */
function valuesIn(text: string): number[] {
  const found = text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found
    .map((token) => Number(token.replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
}

function relationOf(
  goldValues: readonly number[],
  answerValues: readonly number[],
): NumericRelation {
  if (goldValues.length === 0) return 'gold-unreachable';
  if (answerValues.length === 0) return 'answer-unreachable';
  const stated = answerValues[answerValues.length - 1]!;
  if (goldValues.includes(stated)) return 'agrees';
  // The reader computed the gold and then committed to something else. Its own relation, because it is
  // the failure that most resembles success: the right number is *in* the answer.
  if (answerValues.some((value) => goldValues.includes(value))) return 'agrees-early';
  return 'differs';
}

function emptyTally(): Record<NumericRelation, number> & { total: number } {
  return {
    total: 0,
    agrees: 0,
    'agrees-early': 0,
    differs: 0,
    'gold-unreachable': 0,
    'answer-unreachable': 0,
  };
}

/**
 * Read every answer's stated number against its gold's, with no model and no judge.
 *
 * Pure and order-preserving, like `nameScreen`: the same artifact produces the same reading, so a
 * published number can be re-derived by a reader who has the artifact and nothing else.
 */
export function numericScreen(sources: readonly NumericSource[]): NumericReading {
  const rows: NumericRow[] = [];
  const accepted = emptyTally();
  const rejected = emptyTally();
  let correct = 0;
  let reachable = 0;
  let unreachable = 0;

  for (const source of sources) {
    const goldValues = valuesIn(source.gold);
    const answerValues = valuesIn(source.answer);
    const relation = relationOf(goldValues, answerValues);
    rows.push({
      questionId: source.questionId,
      capability: source.capability ?? '',
      accepted: source.accepted,
      relation,
      goldValues,
      stated: answerValues.length === 0 ? undefined : answerValues[answerValues.length - 1],
      answerValues,
    });
    const tally = source.accepted ? accepted : rejected;
    tally[relation] += 1;
    tally.total += 1;

    if (relation === 'gold-unreachable' || relation === 'answer-unreachable') {
      unreachable += 1;
      continue;
    }
    reachable += 1;
    if (relation === 'agrees') correct += 1;
  }

  const falseAccepts = rows.filter((row) => row.accepted && row.relation === 'differs');
  // The denominator is the accepted answers this instrument could read, not all of them: a gold with no
  // digits cannot produce a false accept here, and including it would dilute the rate with rows the
  // instrument never examined.
  const readableAccepted = rows.filter(
    (row) =>
      row.accepted && row.relation !== 'gold-unreachable' && row.relation !== 'answer-unreachable',
  ).length;

  return {
    rows,
    accepted,
    rejected,
    falseAccepts,
    falseRejects: rows.filter((row) => !row.accepted && row.relation === 'agrees'),
    judgeFree: { correct, total: reachable, unreachable },
    falseAccept: {
      accepted: falseAccepts.length,
      readable: readableAccepted,
      rate: readableAccepted === 0 ? 0 : falseAccepts.length / readableAccepted,
      upper: wilsonUpper(falseAccepts.length, readableAccepted),
    },
  };
}

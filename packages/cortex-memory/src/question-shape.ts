/**
 * Whether a question asks for a count of things, or for a value computed from numbers.
 *
 * ## Why the arm needs a name for this, and needed it before this file existed
 *
 * The multi-session route gives every question the same two-step block: *list every item that
 * matches the question, then compute from that list*. That instruction is right for "how many items
 * of clothing do I need to pick up" and wrong for "how many years older is my grandma than me" --
 * not wrong in emphasis, wrong in **kind**, because the second question has no items to list. Its
 * answer is a number that does not appear in the evidence, and a reader looking for a statement that
 * grants it will find nothing and say so.
 *
 * Measured on run `40989420944`, the arm's twenty-six reference-only MR failures split 10 / 10 / 6
 * (decline / off-by-one / aggregation), and **six of the ten declines are derived values**: a
 * percentage of shoes packed, a discount, an age at a birth, a future age, two age gaps. Every one
 * of those replies lists a fact and then explains that the answer is not stated:
 *
 * | question | gold | the reply's own words |
 * | --- | --- | --- |
 * | `a1cc6108` | `11` | "The evidence states Alex is 21, but it does not state the user's age" |
 * | `157a136e` | `43` | "No item in the evidence states the user's age or the grandma's age" |
 * | `e6041065` | `40%` | "the exact total number of shoes packed is not stated" |
 *
 * Both facts those questions need are in the window. What is missing is a Step 1 that asks for the
 * **operands** instead of the items.
 *
 * ## Why this is a copy, and what holds it to the original
 *
 * The reference pipeline -- the arm inside every artifact that answers these correctly -- classifies
 * the same way, with `classifyAggregationKind` in `cortex-eval`, and routes derivation questions to a
 * prompt that identifies operands. That decision is measured: §13.x of the reference's own history
 * reads 35.42% -> 18.75% declines on derivation questions from the prompt swap alone.
 *
 * This module cannot import it: `cortex-eval` depends on `cortex-memory`, so the dependency runs the
 * other way. The project's rule for a pair that cannot share a constant is a **test** rather than a
 * cycle -- `parse-stepped.test.ts` does it for the parser's headings and `abstention-recovery.ts` for
 * the decline token. Here the test is `cortex-eval`'s `question-shape-parity.test.ts`, which runs both
 * classifiers over a corpus of real questions and requires them to agree, so a drift in either
 * direction is a failure rather than a divergence nobody notices.
 *
 * ## Why the pattern is not widened
 *
 * Four of the ten declines are *not* derivation questions by this pattern: a bedtime on the day
 * before an appointment, elapsed days between purchase and arrival, weekly hours, a sum of view
 * counts. They are derived in the same sense and the pattern misses them, and it is deliberately
 * left missing them: the mechanism being dispatched is the reference's, verbatim, because that is
 * the one with a measurement behind it. Widening the pattern in the same run would make the
 * treatment "our classifier and our prompt", and no reading of the result could say which part
 * earned it. The four are registered as a separate population for a later increment.
 */
export type QuestionShape = 'derivation' | 'enumeration';

/**
 * The reference pipeline's derivation test, copied literally.
 *
 * Every alternative is a question whose answer is a computed value -- a ratio, an average, a
 * difference, an elapsed time, a future age, a margin -- rather than a count of listed items.
 * `discount` and `cashback` are there for the same reason: both name an amount that is derived from
 * two stated numbers (a price and a sale price, a spend and a rate).
 */
const DERIVATION =
  /\b(percentage|percent|average|mean|difference (?:in|between)|how much (?:more|less|faster|earlier|older)|increase in|decrease in|discount|cashback|minimum|maximum|how old was|how long (?:have|has) [a-z]+ been|how many (?:years|months|weeks|days) older|how many (?:years|months) (?:old )?will [a-z]+ be when|exceed [\w ]+? by)\b/i;

/** Which of the two readings a question calls for. */
export function classifyQuestionShape(question: string): QuestionShape {
  return DERIVATION.test(question) ? 'derivation' : 'enumeration';
}

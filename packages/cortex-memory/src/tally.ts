/**
 * The arithmetic half of a count: the reader tags each item, the product adds them up.
 *
 * ## The population this exists for, counted on an artifact
 *
 * Run `42533236864` — 500 questions, four repetitions, `deepseek-chat`, six-route allocation — gets
 * **20 of its 121 multi-session questions wrong**, and the failures are not retrieval:
 * `goldOverlap.carried / total` is 0.966 on the twenty against 0.988 on the 101 correct, no failure
 * carries zero gold turns, and `MEASURE-MR-CEILING.md` §1 puts every one of them inside a window that
 * already holds the answer. `IE`, `ABS` and `TR` are not where this lives either: on the same
 * artifact `ABS` reads 30 of 30, `TR` 121 of 127 and `IE` 141 of 150.
 *
 * Sorting the twenty by what the answer *is* splits them cleanly. **102 of the 121 multi-session
 * questions ask for a count or a total**, and **18 of the 20 failures are inside that 102** — 82.4%
 * there against 19 of 19 on the questions that ask for something else. The failures are off-by-one
 * (`2` for 3, `5` for 4, `22` for 23, `1` for 2), a wrong sum (`$8,750` for `$3,750`, `$700` for
 * `$720`, `$375` for `$495`), and one reply that enumerated its own operands and then declined to add
 * them: `37f165cf` lists "440 pages" and "416 pages" and answers **"440 pages and 416 pages"** against
 * a gold of **856**.
 *
 * That last one is the mechanism in one line. The reader can find the items — every failure proves it
 * — and it cannot reliably perform the operation over them. So the operation is taken away from it:
 * the second pass tags each item with the number it contributes, and `parseTallyLedger` adds them.
 *
 * ## Why the audit pass cannot be widened into this
 *
 * `reviewPass: 'audit'` already re-asks with the first response quoted, and its instruction contains
 * the sentence *"do not adjust a total for any reason other than the list changing"*. That sentence
 * was written after run `42054107910` measured **22 correct answers destroyed**, every one rewritten
 * as a bare integer, 17 of them on questions whose gold was a name, a price, a date or a list. The
 * audit's own history therefore says a model asked to correct a total will damage questions that were
 * right, which is the reason this file does not ask a model to total anything: it asks for the
 * operands and computes.
 *
 * ## What this deliberately does not do
 *
 * It does not decide *which* items count. Membership stays the audit's question and the mechanism
 * only reads the list it is handed, refusing when a line is not tagged. It does not run on
 * `derivation` questions — `question-shape.ts` sends those to an operand prompt, and "how many years
 * older am I" would be summed by this arithmetic into an age instead of a difference. It does not
 * run when the first pass declined: a decline has no list, which is `reviewPass: 'audit'`'s own rule.
 * And it does not run on the five capabilities that never ask for a count: reach is the
 * `multi-session` route by construction, so their prompts stay byte-identical.
 */

import { classifyQuestionShape } from './question-shape.js';

/** What the question asks the answer to *be*, when the answer is a number. */
export type AnswerRequest = 'count' | 'total' | 'other';

/**
 * `how many` and `number of` ask for a count of items; `total`, `altogether` and a money verb ask
 * for the sum of their values.
 *
 * The two are the same arithmetic — a count is a sum of ones — and both are read here because they
 * are the two shapes whose answer this module can compute. Everything else is `other`, and `other`
 * is the reason no question is tallied by accident: `gpt4_2ba83207` ("which grocery store did I
 * spend the most money at") is a **maximum**, not a sum, and it is one of the two multi-session
 * failures outside the population rather than a question this mechanism would have summed.
 */
const COUNT_REQUEST = /\bhow many\b|\bnumber of\b|\bhow often\b/i;
const TOTAL_REQUEST =
  /\btotal\b|\baltogether\b|\bsum of\b|\bcombined\b|\bhow much\b|\bamount\b|\bcount\b/i;

/** Which arithmetic the question asks for, if any. */
export function classifyAnswerRequest(question: string): AnswerRequest {
  if (COUNT_REQUEST.test(question)) return 'count';
  if (TOTAL_REQUEST.test(question)) return 'total';
  return 'other';
}

/** One line of the ledger: the item as the reader named it, and what it contributes. */
export type TallyEntry = {
  readonly text: string;
  readonly contribution: number;
};

/**
 * A complete ledger, or the reason the response is not one.
 *
 * `refused` carries a code rather than a sentence so a census can count the codes and a reader can
 * tell "the reader wrote prose instead of lines" apart from "the reader tagged nothing". The
 * distinction is the whole diagnostic value of a null: a mechanism that fired and was refused reads
 * the same as one that never ran unless the two refusals are named.
 */
export type TallyLedger =
  | { readonly kind: 'ledger'; readonly entries: readonly TallyEntry[] }
  | { readonly kind: 'refused'; readonly reason: 'no-entries' | 'untagged-entry' };

/** A list line: a bullet, or an ordinal, at the start of the line. */
const ENTRY_LINE = /^\s*(?:[-*\u2022]|\d+[.)])\s+(\S.*)$/;

/**
 * A trailing bare number, which is the only tag shape the instruction asks for.
 *
 * Deliberately not "the last number in the line": an item's own text carries dates
 * (`2023/05/22`), prices and counts, so a parser that took the last number wherever it was would
 * read `- Research paper on sentiment analysis, Session 3` as a contribution of 3. The tag has to be
 * the line's final token, unadorned, which is a shape the prompt states and this predicate checks.
 */
const TRAILING_NUMBER = /(?:^|\s)([0-9][0-9,]*(?:\.[0-9]+)?)$/;

/**
 * Read the second pass's response as a ledger.
 *
 * ## Why the separator is not required
 *
 * The instruction asks for `<item> — <number>`, and a model that writes `<item> 440` or
 * `<item>: 440` has done the same thing. Requiring the exact dash would refuse three replies for
 * punctuation, which is a mechanism measuring its own formatting rather than the arithmetic.
 *
 * ## Why a single untagged line refuses the whole ledger
 *
 * Because a partial sum is not a partial answer: it is a *smaller* total presented with the same
 * confidence as a complete one. `37f165cf` is the case in point — two operands that must both be
 * present for 856 — and dropping the line that failed to parse would answer 440. The refusal keeps
 * the first pass's answer instead, which is the reading an instrument owes when it cannot compute.
 */
export function parseTallyLedger(response: string): TallyLedger {
  const entries: TallyEntry[] = [];
  for (const line of response.split('\n')) {
    const match = ENTRY_LINE.exec(line);
    if (match === null) continue;
    const body = match[1] as string;
    const tagged = TRAILING_NUMBER.exec(body);
    if (tagged === null) return { kind: 'refused', reason: 'untagged-entry' };
    // The separator the instruction asks for is not part of the item's name: `- boots — 1` names
    // `boots`, and the em dash belongs to the tag.
    const text = body.slice(0, tagged.index).replace(/[\s\u2014\u2013\-:|]+$/u, '');
    entries.push({ text, contribution: Number(tagged[1]!.replaceAll(',', '')) });
  }
  if (entries.length === 0) return { kind: 'refused', reason: 'no-entries' };
  return { kind: 'ledger', entries };
}

/**
 * The sum, rounded to the precision the reader stated.
 *
 * `0.1 + 0.2` is `0.30000000000000004` in binary floating point, and a total rendered that way is an
 * answer no scorer matches. Six decimals is finer than any currency, page count or day count in the
 * corpus and coarser than the representation error, so the rounding is a rendering decision rather
 * than a measurement one.
 */
export function tallyTotal(entries: readonly TallyEntry[]): number {
  const sum = entries.reduce((running, entry) => running + entry.contribution, 0);
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * How the computed total is written back as an answer.
 *
 * A **bare number**, because that is the shape the count questions' golds take and the shape the
 * arm's own answers already take. No thousands separators: `1,998` and `1998` are the same number to
 * a judge and the second is what a machine states.
 */
export function renderTally(total: number): string {
  return String(total);
}

/**
 * Whether this question is one the tally pass administers.
 *
 * Two gates, and both are refusals rather than conveniences. **Shape**: `question-shape.ts` routes a
 * derivation question to an operand prompt, and "how many years older am I than when I graduated"
 * (`c18a7dc8`, gold 7) would be summed here into an age — a wrong answer invented by arithmetic that
 * was correct in a population it does not belong to. **Request**: a question whose answer is a name, a
 * price band or a maximum has nothing to sum; `gpt4_2ba83207` ("which grocery store did I spend the
 * most money at") is a maximum, and summing its six amounts would answer a question nobody asked.
 *
 * Reach is therefore the intersection, which on run `42533236864` is **100 of 121 multi-session
 * questions carrying 16 of its 20 failures** — the population the mechanism is registered against.
 */
export function isTallyQuestion(question: string): boolean {
  return (
    classifyQuestionShape(question) === 'enumeration' && classifyAnswerRequest(question) !== 'other'
  );
}

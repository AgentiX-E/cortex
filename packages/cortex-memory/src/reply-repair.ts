/**
 * The repair a reply earns when it broke the contract it was given.
 *
 * ## The population this exists for, and why two measured treatments could not reach it
 *
 * `MEASURE-ORACLE-CEILING.md` §7.4 classifies all 35 questions the reader loses with the gold sessions in the
 * window. **Fourteen of them are not reasoning failures at all**: eight are refusals ("Not specified in the
 * evidence", "Cannot be determined", `None`, "No items in the evidence match") and six are lists of quotations
 * where an answer was asked for. Both are contract violations rather than mistakes of inference, and both have a
 * repair that does not touch the instruction content.
 *
 * Neither of the two retry treatments the product already carries can see them, and the reason is mechanical
 * rather than a matter of tuning:
 *
 * | pass | fires when | why it misses these fourteen |
 * | --- | --- | --- |
 * | `reviewBareDecline` | `isBareDecline`, i.e. the token **and nothing else** | a prose refusal is not bare, and a reply of `None` names no token at all |
 * | `reviewPass: 'recover'` | a decline **whose Step 1 list is non-empty** | `parseAnswer` reads "Not specified in the evidence" as an answer, so the pass is told the reader answered and returns `none` |
 *
 * The second row is the one worth stating precisely, because it is the reason this module cannot be a flag on
 * `abstention-recovery.ts`: that pass asks `answered`, and `answered` is `parseAnswer(raw) !== null`. A reply that
 * declines **in words** is scored as an answer, so the recovery pass is not merely declining to act -- it is
 * being told there is nothing to act on. `39367801501`, `39509698041` and `39699987781` all carry both shapes,
 * which is how the bare retry came to report `72/72` converted while eight declines per run stayed wrong.
 *
 * ## One pass, two kinds, and why they are one option
 *
 * The two populations are disjoint (a reply is one shape or the other), the repair for each is a single
 * consultation on the evidence the first pass already carried, and both are triggered by the same event: **the
 * reply did not obey the contract that was rendered above it**. So they are one mechanism with two kinds rather
 * than two options, and the census reports the kinds separately because the treatments are different sentences.
 *
 * ## The ordering with the bare retry, which is what makes at most one extra call
 *
 * {@link classifyReply} reads the bare shape **first**. A reply that is the token and nothing else is therefore
 * `bare-decline` and never becomes a repair plan, so enabling both treatments on one run cannot consult twice on
 * one question -- the property is structural rather than a rule the call sites have to remember, and
 * `reply-repair.test.ts` asserts it over a reply table instead of trusting the ordering.
 */

import { isBareDecline } from './abstention-recovery.js';
import { isAbstention, parseAnswer, stripDecoration } from './parse.js';
import type { ReplyRepair } from './types.js';

/**
 * What the first reply did, as four states that call for four different responses.
 *
 * `committed` is not "correct": it is "the reply is an answer in the shape the contract asked for", which is the
 * only thing a pass reading the reply's text can know. Whether it is right is the judge's question.
 */
type ReplyKind = 'committed' | 'bare-decline' | 'prose-decline' | 'shape-failed';

/**
 * Which repairs a run administers.
 *
 * Declared in `types.ts` beside `ReviewPass`, because it is an option's type rather than a property of the
 * predicate: the module that reads a reply must be importable by the option table without the option table
 * importing the module. The values are documented there.
 */

/** What, if anything, to do about the first reply. */
type RepairPlan =
  { readonly kind: 'none' } | { readonly kind: 'commitment' } | { readonly kind: 'shape' };

/**
 * The longest reply that can be read as a refusal rather than as an answer that mentions one.
 *
 * The archived refusals are three to eight words (`None`, `Cannot be determined`, `No items in the evidence
 * match`). A sentence containing "not specified" inside an answer -- "the receipt does not specify a tip, so the
 * total is $42" -- is thirty words and an answer, and the length bound is what keeps the predicate off it. It is
 * a separate constant from {@link REFUSAL_OPENER} because the two fail differently: a wider opener admits the
 * wrong sentence, a wider bound admits the wrong length.
 */
const MAX_REFUSAL_CHARS = 120;

/**
 * A reply that opens by reporting the absence of an answer.
 *
 * Closed rather than semantic, the same way `ABSENCE_OPENER` in `abstention-recovery.ts` is closed: these are the
 * openers the archived declines actually use, and a wider test ("contains 'no'") would read "No, I did not renew
 * it -- the charge was $30" as a refusal. `None` is included because four of the eight archived refusals are that
 * single word, and it is matched as a **whole word** so "None of the receipts" is caught while "Nonetheless" is
 * not.
 */
const REFUSAL_OPENER =
  /^(?:none\b|no\s+items?\b|no\s+information\b|no\s+mention\b|not\s+(?:specified|stated|mentioned|provided|listed|available|found|enough)|nothing\s+in\s+the\s+evidence|cannot\s+be\s+determined|can\s*not\s+be\s+determined|can'?t\s+be\s+determined|unable\s+to\s+determine|insufficient\s+evidence|there\s+(?:is|are)\s+no\b)/i;

/** `- item`, `* item`, `• item`, `1. item`, `1) item` -- the shapes a list is written in. */
const BULLET = /^(?:[-*\u2022]|\d+[.)])\s+\S/;

/** A line that opens with a quotation mark, which is a quotation rather than an answer. */
const QUOTED = /^["\u201c'\u2018]/;

/** Two non-empty lines are the minimum a list can have. */
const MIN_LIST_LINES = 2;

/**
 * Whether a parsed answer is a list of quotations rather than an answer.
 *
 * ## Why the test is on the parsed answer and not on the raw reply
 *
 * `parseAnswer` is the layer that decides which part of a reply is the answer: it takes the text after the last
 * step heading, or after a closing `Answer:` label, and falls back to the whole reply when neither appears. So a
 * reply that listed its quotations and then wrote `Answer: 3` parses to `3` and is an answer; a reply that is
 * only the list parses to the list and is not. Reading the raw text here would classify both as shape failures
 * and re-ask a question that had already answered -- a consultation spent to change a correct answer.
 *
 * ## Why two lines and one bullet
 *
 * A single line is an answer no matter what it opens with (`- 42` is a strange answer and a parseable one). Two
 * or more lines where **at least one** is a bullet or a quotation is the shape the six archived failures have,
 * and the shape a contract that asked for one line cannot have meant. The `QUOTED` half is what covers the
 * dumps that write the turn text as quoted paragraphs rather than as bullets.
 */
function isListAnswer(answer: string): boolean {
  const lines = answer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length < MIN_LIST_LINES) return false;
  return lines.some((line) => BULLET.test(line) || QUOTED.test(line));
}

/**
 * What the reply was, read in the order that keeps the four states disjoint.
 *
 * The order is the contract, not an implementation detail: `bare-decline` before `prose-decline` is what makes
 * `replyRepair` and `reviewBareDecline` mutually exclusive on any single reply, and `prose-decline` before
 * `shape-failed` is what stops a refusal written as a list from being re-asked for a shape instead of for an
 * answer. Both are asserted over the reply table in `reply-repair.test.ts`.
 */
export function classifyReply(raw: string | null): ReplyKind {
  // No reply text is not a violation: a provider fault and an empty completion are different states with their
  // own paths, and a repair that fired on them would spend a call to repair nothing.
  if (raw === null) return 'committed';
  const text = raw.trim();
  if (text === '') return 'committed';
  if (isBareDecline(text)) return 'bare-decline';
  // The token on the closing line with company: `parseAnswer` calls this a decline, and the recovery pass is told
  // so. It is a prose refusal for the purpose of who repairs it.
  if (isAbstention(text)) return 'prose-decline';
  const undecorated = stripDecoration(text).trim();
  if (undecorated.length <= MAX_REFUSAL_CHARS && REFUSAL_OPENER.test(undecorated)) {
    return 'prose-decline';
  }
  const answer = parseAnswer(text);
  if (answer !== null && isListAnswer(answer)) return 'shape-failed';
  return 'committed';
}

/**
 * Whether a reply earns a consultation, and which one.
 *
 * `repair` is `undefined` on a product built without the option, which is the state every archived artifact was
 * produced in, and it plans nothing -- the same reading `reviewBareDecline` gives an absent boolean.
 */
export function planReplyRepair(raw: string | null, repair: ReplyRepair | undefined): RepairPlan {
  if (repair === undefined || repair === 'off') return { kind: 'none' };
  const kind = classifyReply(raw);
  if (kind === 'prose-decline' && (repair === 'commitment' || repair === 'both')) {
    return { kind: 'commitment' };
  }
  if (kind === 'shape-failed' && (repair === 'shape' || repair === 'both'))
    return { kind: 'shape' };
  return { kind: 'none' };
}

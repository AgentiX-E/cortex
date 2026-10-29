/**
 * What to do when the reader declines a question it had already written a list for.
 *
 * ## The state this exists for, and why the code believed it could not happen
 *
 * The `enumerated` contract tells the multi-session reader to list the matching items, compute
 * from that list, and reply `INSUFFICIENT_EVIDENCE` **only when the list is empty**. The audit pass
 * in `memory.ts` was written on the premise that this contract holds: it skips an abstention with
 * the sentence *"an abstention is a decision, and this pass audits a list that does not exist"*.
 *
 * Measured on three archived runs of the adopted configuration, that premise is false. Almost every
 * MR abstention carries a **non-empty** list:
 *
 * | run | MR abstentions | with a non-empty Step 1 list |
 * | --- | --- | --- |
 * | `39367801501` | 10 | **8** |
 * | `39509698041` | 9 | **7** |
 * | `39699987781` | 9 | **8** |
 *
 * The two that are not are the honest case and the reason this table was corrected: their only
 * bullets read "No item in the evidence states ...", an absence rather than an item, which
 * `ABSENCE_OPENER` excludes. The first version of this reading counted those bullets as items and
 * reported 10 of 10 -- **a number that would have made the pass look like it should fire on an
 * honest decline.** `test/mr-census/run.mjs` reproduces the table through this module's own
 * predicate rather than a copy of it.
 *
 * TR shows the same shape at a lower rate (4 to 7 of 15 to 23), and ABS shows none of it (30
 * abstentions, 0 with a list) -- which is the control this reading needed: questions whose gold
 * answer is a decline produce no list, so a rule about lists cannot touch them.
 *
 * An abstention is only ever correct when the gold answer is a decline. On MR and TR it is always
 * wrong, so these 13 to 17 questions per run are pure loss, and they are insensitive to every
 * retrieval and prompt change that has been tried: the reader had the evidence and declined.
 *
 * ## Why the list is enough to re-ask with
 *
 * The list is the reader's own extraction of the evidence. For a counting question the answer is
 * the number of distinct items in it, which means the retry does **not** need the evidence again:
 * quoting the list back is a complete restatement of what the reader decided was relevant. That
 * matters because a retry that re-sent the window would cost the same as the first call and could
 * re-read a different subset -- a second sample rather than a correction of the first.
 *
 * The retry is therefore small, single-variable and auditable: same question, same list, one
 * instruction that the contract already contained.
 *
 * ## Why the reply may still decline
 *
 * A list can be non-empty and still answer nothing: `d905b33f` lists one item about a book and
 * reports that no discount percentage is stated anywhere. Forcing a number there would invent one,
 * which is the failure the grounding gates exist to prevent. So the retry re-states the licence in
 * the one case where it is discharged -- a counting question, where the count of the list *is* an
 * answer -- and leaves every other question free to decline again.
 */

import { stripDecoration } from './parse.js';

/**
 * Whether a reply was the token and nothing else.
 *
 * ## What this separates, and why the parser cannot
 *
 * `parse.ts` collapses three shapes to `null`: the token alone, the token after a list, and the token after prose.
 * To everything downstream those are one outcome, and they call for three different repairs:
 *
 * | shape | what it means | repair |
 * | --- | --- | --- |
 * | token alone | the reader never engaged | ask again, **without offering the token** |
 * | token after a list | the reader engaged and gave up | the list is worth quoting back |
 * | token after prose | the reader engaged and reasoned | read the reasoning |
 *
 * `MEASURE-SOTA-FAILURES.md` §2 measures the population: 30 of 45 wrong declines on the shipped arm are the first
 * shape, and 29 of `ABS`'s 30 *correct* answers are that same shape — which is why the treatment that consumes
 * this predicate must never reach the abstention route.
 *
 * Wrappers count as bare. A model that writes `**INSUFFICIENT_EVIDENCE**` said nothing but the token, and
 * **so does a model that writes `Answer: INSUFFICIENT_EVIDENCE`** — the fix run `40807829150` needed, and the
 * reason this predicate now reads decoration through `parse.ts`'s own function rather than its own pattern.
 *
 * ## Why the labelled shape is not a detail
 *
 * `answer-line` asked for one line of the form `Answer: <phrase>`, and a reader that ran out of evidence
 * declined **in that form**. `parse.ts` accepted it (`isAbstention` strips the label), so the question was
 * scored as a decline; this predicate did not, so the retry pass never fired. Six IE questions in that run
 * end at `Answer: INSUFFICIENT_EVIDENCE`, and the control converts 92 of 92 bare declines into answers when
 * the pass does fire. A prompt that names a reply shape could therefore disable a recovery mechanism without
 * moving a single field of the artifact: the pass reported `attempted: 0` and nothing said why.
 *
 * The repair belongs here and not in the ask. `parse.ts` already owns the answer to "which part of a reply is
 * presentation", and two implementations of that question is how the two layers came to disagree — so this
 * imports the function instead of restating the pattern, and `bare-decline-label.test.ts` holds them together
 * over the shapes a model actually emits.
 */
export function isBareDecline(raw: string | null): boolean {
  if (raw === null) return false;
  const text = raw.trim();
  // Empty is *not* bare: nothing was said, which is a different state and belongs to the empty-evidence path.
  if (text === '') return false;
  const stripped = stripDecoration(text).replace(new RegExp(DECLINE_TOKEN, 'gi'), ' ').trim();
  // Only wrappers left means the token stood alone. Anything else is content and the reader engaged.
  return /^[*_`"'\s]*$/.test(stripped);
}

/** A reply that declined, and the items it had already listed. */
export type RecoveryPlan =
  | { readonly kind: 'none'; readonly why: 'disabled' | 'answered' | 'no-list' }
  | { readonly kind: 'retry'; readonly items: readonly string[] };

/**
 * The token the contract requires for a decline, restated here rather than imported.
 *
 * `parse.ts` owns the constant and this module must not import it: `parse.ts` is the layer this
 * decision sits above, and the project's rule for a pair that cannot share a constant is a test
 * rather than a cycle (`parse-stepped.test.ts` does the same for the contract's headings). The
 * test below asserts the two literals agree.
 */
export const DECLINE_TOKEN = 'INSUFFICIENT_EVIDENCE';

/**
 * The shortest bullet that can be an item rather than a heading or a placeholder.
 *
 * The echo case is what this is sized against. When a model repeats the contract instead of
 * following it -- three of the ten MR abstentions in `39367801501` do -- the reply opens with the
 * contract's own sentence on one line, which is not a bullet and is dropped by the pattern. A
 * bullet of " - none" or " - n/a" carries no item either, and both are shorter than this.
 */
const MIN_ITEM_CHARS = 12;

/** How many items the retry quotes. Beyond this the list is a document rather than an answer. */
const MAX_QUOTED_ITEMS = 40;

/** `- item`, `* item`, `• item`, `1. item`, `1) item` -- the shapes the contract asks for. */
const BULLET = /^([-*•]|\d+[.)])\s+(\S.*)$/;

/**
 * A bullet that reports the absence of an item rather than an item.
 *
 * The honest decline is written as a list too: `37f165cf` answers `INSUFFICIENT_EVIDENCE` with two
 * bullets reading "No item in the evidence states a novel finished in January with a page count."
 * Both are bullets, both are long, and counting them would turn an honest decline into a
 * "non-empty list" and quote the model's own apology back to it as evidence.
 *
 * The set is closed rather than semantic: it is the openers the archived declines actually use. A
 * wider test ("does the line contain 'does not'") would drop real items, because a listed item
 * often carries the reader's own doubt -- "the new release from my favorite author, priced at $30,
 * no discount stated" is an item.
 */
const ABSENCE_OPENER =
  /^(?:no\b|none\b|nothing\b|not\s+(?:stated|mentioned|found|present)|there\s+(?:is|are)\s+no\b)/i;

/** A heading line, which separates the two steps and is never an item. */
const STEP_HEADING = /^step\s*\d+\s*(?:[—\-:.]|$)/i;

/** Lines before this heading are Step 1; the list lives there and nowhere else. */
const STEP_TWO = /^\s*step\s*2\s*(?:[—\-:.]|$)/im;

/**
 * The items a declining reply had already listed.
 *
 * Only the text before the Step 2 heading is read, because that is where the contract puts the
 * list. A bullet the model writes while explaining its refusal in Step 2 is not a listed item, and
 * treating it as one would quote the model's own excuse back to it as evidence.
 */
export function declinedItems(raw: string): string[] {
  const heading = STEP_TWO.exec(raw);
  const firstStep = heading === null ? raw : raw.slice(0, heading.index);
  const items: string[] = [];
  for (const line of firstStep.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || STEP_HEADING.test(trimmed)) continue;
    const match = BULLET.exec(trimmed);
    if (match === null) continue;
    const item = (match[2] as string).trim();
    if (item.length < MIN_ITEM_CHARS) continue;
    if (ABSENCE_OPENER.test(item)) continue;
    items.push(item);
    if (items.length === MAX_QUOTED_ITEMS) break;
  }
  return items;
}

/**
 * Whether an outcome is worth one corrective consultation, and with what.
 *
 * Three states return `none`, and they are different reasons rather than one falsy value: the
 * feature is off (a measurement that was not requested), the reader answered (nothing to correct),
 * or the decline was honest (an empty list is the state the contract licenses).
 */
export function planAbstentionRecovery(
  raw: string | null,
  answered: boolean,
  enabled: boolean,
): RecoveryPlan {
  if (!enabled) return { kind: 'none', why: 'disabled' };
  if (answered) return { kind: 'none', why: 'answered' };
  const items = declinedItems(raw ?? '');
  if (items.length === 0) return { kind: 'none', why: 'no-list' };
  return { kind: 'retry', items };
}

/** Whether the question asks for a count, where the list's length is itself an answer. */
export function asksForCount(question: string): boolean {
  return /\b(?:how many|number of|total number|count of)\b/i.test(question);
}

/**
 * The corrective prompt: the list, the question, and the one instruction that was not obeyed.
 *
 * It carries no evidence. The list is the reader's own summary of the evidence, and re-sending the
 * window would make this a second sample rather than a correction of the first -- which is the
 * difference between a treatment and a re-roll.
 */
export function buildRecoveryPrompt(question: string, items: readonly string[]): string {
  const listed = items.map((item, index) => `${index + 1}. ${item}`).join('\n');
  const counting = asksForCount(question);
  return [
    'You were asked a question about a conversation history. You listed the items below and then',
    `declined with ${DECLINE_TOKEN} instead of answering.`,
    '',
    'ITEMS YOU LISTED:',
    listed,
    '',
    `QUESTION: ${question}`,
    '',
    'Answer from the list above. Do not repeat the list, do not explain, and do not search for',
    'evidence you did not list -- if the answer followed from the list you would have given it.',
    ...(counting
      ? [
          'This is a counting question, so the answer is the number of distinct items in the list:',
          'count them, and reply with that number. Two lines describing one event are one item.',
        ]
      : []),
    // The bare answer, not `Answer: <value>`. `parseAnswer` reads the text after the last step
    // heading and strips quotes, so a prefixed line would be scored as the literal string
    // "Answer: 2" -- found by the route test, which is the only place the two halves meet.
    'Reply with the answer alone -- a word, a name, a number or a short phrase, and nothing else.',
    `Reply ${DECLINE_TOKEN} only if no item above is relevant to the question at all.`,
  ].join('\n');
}

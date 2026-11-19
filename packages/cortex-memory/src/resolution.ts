/**
 * How much of a long turn a room spends, when the answer is "make each one carry more".
 *
 * ## The number this exists for
 *
 * `C1` asks for 6,000 prompt tokens per question against the 7,448 the registered arm bills, and the two
 * cost routes already measured both pay in accuracy: the room table bought -18.8% of the bill for -1.15
 * points (`44017278305`), and the width plan bought -27.1% (5,660 tokens, already under the target) for
 * **-4.00 points** (`43259830582`). The exchange rate is about one point per 6.8% of the bill, so `C1`'s
 * 22.7% is priced at roughly three points by that line -- and the width plan's actual -4.00 is worse than
 * the line, because cutting the prefix removes **events**, and events are what the answers are made of.
 *
 * There is nothing left to compress: a prompt assembled through the product's own entry point is 27,268
 * characters, of which the instruction block is **207 (0.76%)**, in the same band as the 3.0% `width.ts`
 * records. The bill is the evidence, and the evidence is turns.
 *
 * So this does not remove evidence. It spends the same room on turns that are **cheaper to print and no
 * less complete**, and lets the selector -- unchanged -- reach further into the same ranking with the
 * characters that are left.
 *
 * ## What it changes and what it is forbidden to change
 *
 * Only `render`: one turn's text. `chooseEvidence`'s rule is "the largest prefix that still fits the
 * room, after rendering", and it finds that prefix by binary search over `render` because `render` is
 * monotone. A shorter rendering therefore buys a longer prefix **by construction** -- no greedy fill, no
 * skipping, no second selection rule. That is the whole mechanism.
 *
 * The boundary matters because the alternative was tried: skipping turns that do not fit and continuing
 * with smaller ones turns the delivered set from a **prefix** into a **subset**, and then a reading
 * cannot tell "denser" from "a different selector".
 *
 * ## Three forms, one of which is genuinely new
 *
 * | form | when | text | ceiling |
 * | --- | --- | --- | --- |
 * | `raw` | the turn is already at or under the cap | the turn, unchanged | `rawCap` |
 * | `excerpt` | a long turn that shares a content term with the question | the window around its densest match (`excerptAround`) | 1.5 x `rawCap` |
 * | `record` | a long turn that shares **no** content term | its first sentence plus every later sentence carrying a digit, on one line | 0.6 x `rawCap` |
 *
 * The ceilings are multiples of the one number a run already registers (`maxTurnChars`), rather than two
 * new constants: a benchmark-tuned constant encodes the benchmark, and a ratio of the existing width is a
 * statement about *shape* (a window needs room on both sides of its match; a record is a line, not a
 * paragraph) that stays true at any width.
 *
 * ## This replaces the cap rather than stacking on it
 *
 * The first draft of the design stacked layering on top of `maxTurnChars` and was self-contradictory:
 * `excerpt`'s 1.5x ceiling is *larger* than the cap, so a layering applied after the cap would leave the
 * excerpt no room at all and the mechanism would degenerate into "240 instead of 400" -- a width cut
 * wearing a resolution label, which is exactly the confound the criterion forbids.
 *
 * So under `layered` the cap does not bound a turn; the form does. Density comes from the **average**
 * falling -- most long turns become one-line records -- while the few turns that actually share a term
 * with the question **gain** half a cap. It is a reallocation, not a compression, and the average is what
 * moves (`eventsFitted` is the evidence: turns delivered for the same room).
 *
 * ## Every cut is marked, including `record`'s
 *
 * `excerptAround` already marks its elisions, which is why the window and the mark are one decision in
 * `excerpt.ts`. `record` drops whole sentences, so it marks too -- always, on one character at the end --
 * because a record that silently omitted the tail would be the defect that file exists to repair, one
 * form further out. The mark is inside the ceiling, not beyond it.
 *
 * That is also why layered mode needs no sentence in the instruction block: every shortened turn says so
 * on its own line, so the reader is never looking at a shortened turn it was not told about, and the
 * mechanism does not have to buy honesty with a block of prompt every question pays for.
 */

import { contentTerms, contentTokens } from './relevance.js';
import { ELISION, excerptAround, truncateCodePointSafe } from './excerpt.js';

/** Whether turns are rendered whole (every archived run) or by form. */
export type ResolutionMode = 'raw' | 'layered';

/**
 * Which of the three renderings a turn received.
 *
 * Exported because the census that publishes the split (`prompt.ts`'s `EvidenceForms`) names the same three
 * forms in the same order, and two unions spelling one vocabulary is how a fourth form gets added to the
 * renderer and not to the artifact.
 */
export type EvidenceForm = 'raw' | 'excerpt' | 'record';

/** One turn's rendering: the text, the form that chose it, and what it costs the room. */
interface ResolutionPlan {
  /** What the reader will see. */
  readonly text: string;
  /** Which form produced it. */
  readonly form: EvidenceForm;
  /** `text.length`, carried so no caller re-derives it and disagrees. */
  readonly chars: number;
  /** Whether material was dropped -- i.e. whether `text` already says so with a marker. */
  readonly elided: boolean;
}

/**
 * How much room an excerpt gets, as a multiple of the cap it replaces.
 *
 * A window has to hold text on both sides of the match -- `excerpt.ts` keeps a quarter of its budget
 * before the anchor and the rest after -- so a window the size of the cap would spend a quarter of the
 * cap on context and print three quarters of what a head cut printed. Half again as much room is what
 * makes the matching turn *gain* by being matched rather than merely lose less.
 */
const EXCERPT_RATIO = 1.5;

/**
 * How much room a record gets, as a fraction of the cap.
 *
 * A record is a first sentence plus the sentences that carry digits, on one line. At 400 that is 240
 * characters -- about two short sentences and a number, which is the whole of what a turn that shares no
 * term with the question can be trusted to contribute. It is the only form whose output is *shorter* than
 * the cap, so it is the form the density comes from.
 */
const RECORD_RATIO = 0.6;

/**
 * The dateline and role a capped route's turn carries inside its own content.
 *
 * Anchored and strict rather than permissive: `[2023/05/20 (Sat) 03:51] user: ` is the shape the
 * multi-session and temporal builders emit, and a turn that only resembles it keeps its bytes -- the cost
 * of a false negative here is one dateline inside a window, and the cost of a false positive is a window
 * that starts mid-sentence because eight characters it should have kept were dropped.
 *
 * It lives here rather than in `prompt.ts` because it is part of what "render one turn" means, and every
 * function that answers that question must answer this one the same way: the window version in
 * `prompt.ts` and the layered version below. Two copies of this rule is how the budget and the renderer
 * end up disagreeing about a turn's length.
 */
export const DATELINE = /^\[\d{4}\/\d{2}\/\d{2} \([A-Za-z]{3}\) \d{2}:\d{2}\] [a-z]+: /;

/** A sentence ends at one of these, when whitespace or the end of the text follows it. */
const SENTENCE_END = new Set(['.', '!', '?']);

/** A digit, which is what makes a sentence a candidate for a record. */
const DIGIT = /[0-9]/;

/** Any run of whitespace, collapsed so a record is one line. */
const WHITESPACE_RUN = /\s+/g;

/**
 * One turn's rendering under `layered`.
 *
 * Pure: same arguments, same bytes, no clock, no environment, no model. The cap is floored and clamped to
 * at least one because a zero ceiling would let a turn render as the empty string, and an empty string in
 * the evidence is a turn the prefix search can always afford -- the room would then be filled by an
 * unbounded number of turns that say nothing.
 */
function resolveTurn(question: string, content: string, rawCapOption: number): ResolutionPlan {
  const rawCap = Math.max(1, Math.floor(rawCapOption));
  if (content.length <= rawCap) {
    return { text: content, form: 'raw', chars: content.length, elided: false };
  }

  if (sharesQuestionTerm(question, content)) {
    const ceiling = Math.max(1, Math.floor(rawCap * EXCERPT_RATIO));
    const text = excerptAround(content, question, ceiling);
    return { text, form: 'excerpt', chars: text.length, elided: text !== content };
  }

  const ceiling = Math.max(1, Math.floor(rawCap * RECORD_RATIO));
  const text = recordOf(content, ceiling);
  return { text, form: 'record', chars: text.length, elided: text !== content };
}

/**
 * {@link resolveTurn} for a turn as it arrives on a capped route: dateline first, then the form.
 *
 * The dateline is not the ceiling's to spend. On `multi-session` and `temporal` a turn's content arrives
 * with its own `[date] {role}:` head attached, so a form chosen on the remainder and printed under the
 * head would overrun the ceiling by the head's length -- the same accounting `prompt.ts`'s window does,
 * and the same measurement (`43427857069`: 226 of 10,381 capped-route items lost their dateline before
 * that line existed, 139 of them on `TR`, whose answers are dates).
 *
 * This is the function both the renderer and the budget call. One call, one answer: the failure this
 * avoids is the one `43259468403` was cancelled for -- a plan that budgeted raw lengths against a
 * rendering that was cut.
 */
export function resolveCappedTurn(
  question: string,
  content: string,
  rawCap: number,
): ResolutionPlan {
  const head = DATELINE.exec(content)?.[0] ?? '';
  if (head === '') return resolveTurn(question, content, rawCap);
  const body = resolveTurn(question, content.slice(head.length), rawCap - head.length);
  return {
    text: `${head}${body.text}`,
    form: body.form,
    chars: head.length + body.chars,
    elided: body.elided,
  };
}

/**
 * Whether this turn contains any content term the question asks about.
 *
 * The same test `excerptAround` makes before it can anchor, asked here because it is what chooses the
 * form rather than what places the window: a long turn with no shared term has nothing to anchor on, so a
 * window around "the best match" would be a window around an arbitrary offset. Distinct terms, not
 * occurrences, for `lexicalRelevance`'s reason -- a turn that repeats one word of the question forty times
 * is not about the question.
 */
function sharesQuestionTerm(question: string, content: string): boolean {
  const asked = new Set(contentTerms(question));
  if (asked.size === 0) return false;
  return contentTokens(content).some((token) => asked.has(token.term));
}

/**
 * The turn compressed to one line: its opening sentence, then every later sentence that carries a digit.
 *
 * ## Why the digits come first when both cannot fit
 *
 * Because the form exists for arithmetic. `ANALYSIS-AGGREGATION-GAP.md` §1 locates `MR`'s gap in its
 * aggregation questions and finds the **items present in every window** and the total wrong -- so what a
 * long, unrelated turn can contribute is an operand, and an operand is a number. A verbose opening
 * sentence is what makes a record readable, not what makes it right, so the numeric sentences are
 * reserved first and the opening is printed from whatever room is left.
 *
 * The first draft spent the room in reading order and truncated the whole line at the ceiling. On a
 * 425-character turn with a 245-character opening that dropped the only sentence carrying a number --
 * the record kept the prose and lost the operand, which is the failure the form was built to prevent.
 * `resolution.test.ts` pins the reserved-first behaviour with that turn.
 *
 * ## Why there is no cut after the line is assembled
 *
 * Because the separators are paid for exactly, and a cut that never fires is a violation nobody sees. The
 * reservation charges every operand its own separator and charges the space before the first one to the
 * opening's allowance, so `lead + separators + operands` is at most `room` **by construction** -- the bound
 * is an identity rather than a margin. The first version of this function still ran
 * `truncateCodePointSafe` over the finished line and backed the result up to a word boundary; 93 turn
 * renderings in `resolution.test.ts` never made it fire, so the branch was unreachable and the arithmetic
 * above was never actually tested. The bound is now asserted where it can fail -- the sweep over ceilings
 * in that file, which includes the turn that fits its room exactly -- instead of being silently absorbed
 * here, and `truncateAtWord` keeps the one case that has to be decided rather than repaired: an opening
 * with no room left for it renders as nothing and leaves the operands alone.
 *
 * ## Why the opening sentence and not the best one
 *
 * Because "best" needs the question, and the turns this form handles share no content term with it, so
 * any ranking would be a ranking by something else (recency, length, position) dressed as relevance. The
 * first sentence is where a speaker establishes what the turn is about, and taking it unconditionally is a
 * rule that cannot be tuned on a benchmark.
 *
 * ## Why the filter is this crude
 *
 * A sentence with a digit is a candidate operand; a sentence without one is prose the question can
 * usually be answered without. No model call and no classifier: a `record` that cost a call would turn the
 * cost lever into a cost increase and make the arm non-repeatable, which is the one thing a mechanism
 * priced against the bill cannot be.
 *
 * ## Why it always ends with a marker
 *
 * Because it always drops something. A turn reaches this function only when it is longer than the cap, and
 * the record's ceiling is below the cap, so a record that fits its ceiling has still left the turn's other
 * sentences behind. A silent record would be a shortened turn the reader was not told about -- the defect
 * `excerpt.ts` exists for, one form out.
 */
function recordOf(content: string, ceiling: number): string {
  const sentences = splitSentences(content);
  const opening = sentences[0] ?? '';
  if (opening === '') return ELISION;

  // The marker is inside the ceiling, not beyond it, for the reason `cutWithMarker` reserves its own
  // unit: a rendering one character over its ceiling is an overrun every caller's arithmetic assumes
  // cannot happen.
  const room = Math.max(0, ceiling - ELISION.length);

  const operands: string[] = [];
  let spent = 0;
  for (const sentence of sentences.slice(1)) {
    if (!DIGIT.test(sentence)) continue;
    const cost = sentence.length + (operands.length === 0 ? 0 : 1);
    if (spent + cost > room) break;
    operands.push(sentence);
    spent += cost;
  }

  const openingRoom = room - spent - (operands.length === 0 ? 0 : 1);
  const lead = truncateAtWord(collapse(opening), openingRoom);
  const line = collapse([lead, ...operands].filter((part) => part.length > 0).join(' '));
  return line === '' ? ELISION : `${line}${ELISION}`;
}

/** `text` cut to at most `room` characters at its last word boundary, or `''` when there is no room. */
function truncateAtWord(text: string, room: number): string {
  if (room <= 0) return '';
  if (text.length <= room) return text;
  return cutAtWord(truncateCodePointSafe(text, room)).trim();
}

/**
 * Split into sentences, keeping the punctuation, with each sentence's whitespace collapsed.
 *
 * A scan rather than a `split(/(?<=[.!?])\s+/)`, because a lookbehind over a 20,000-character turn is
 * rebuilt on every call and this runs once per turn per render. The rule is the same: a sentence ends at
 * `.`, `!` or `?` when whitespace or the end of the text follows, so `3.5` and `e.g.` stay inside their
 * sentence and an abbreviation costs at most one merge.
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_END.has(text[index] as string)) continue;
    const next = text[index + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    sentences.push(collapse(text.slice(start, index + 1)));
    start = index + 1;
  }
  if (start < text.length) sentences.push(collapse(text.slice(start)));
  return sentences.filter((sentence) => sentence.length > 0);
}

/** One line: every whitespace run becomes a single space, and the ends are trimmed. */
function collapse(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Back `text` up to the last word boundary it can reach, so a record does not end mid-word.
 *
 * A single word longer than the ceiling is the one case where the cut stays inside a word, and it stays
 * deliberately -- the alternative is to print nothing.
 */
function cutAtWord(text: string): string {
  for (let index = text.length - 1; index > 0; index -= 1) {
    if (/\s/.test(text[index] as string)) return text.slice(0, index).trimEnd();
  }
  return text;
}

/**
 * The date a block of evidence happened, read from the block itself and written onto its boundary.
 *
 * ## The reading that motivated it
 *
 * `44017278305` (`S16`, the registered arm) answers 101.25 of 121 multi-session questions per run, and
 * 16 of those 121 are wrong in all four repetitions. Reading the sixteen, one signature recurs: the
 * reader names the right candidates and then stamps them all with **one** date. `gpt4_2f8be40d` counts
 * five weddings, every one printed `2023/10/15`; `d851d5ba` sums eight donations, every one
 * `2023/03/20`; `gpt4_372c3eed` dates two events from two different sessions `2021/08/20`. Those are
 * the *question's* date, not the evidence's.
 *
 * The dates are not missing and they are not lost in rendering — verified rather than assumed: 0 of that
 * artifact's 41,822 delivered turns lack a `[YYYY/MM/DD …]` stamp. What a 200-turn, 45,000-character
 * window costs is not bytes but **attribution**: the stamp sits at the head of a paragraph the reader is
 * skimming for a candidate, and by the time the candidate is written down the date is no longer attached
 * to anything. The association is measurable: a reply that repeats one date across three or more items
 * appears in **17 of the 57** questions that are ever wrong (29.8%) and in **39 of the 443** that never
 * are (8.8%) -- 3.39 times the rate.
 *
 * So the boundary — the one line already drawn twenty-odd times in such a window — carries the date its
 * block states. Twenty anchored dates instead of two hundred, at the place where the reader is deciding
 * which conversation a candidate came from. `SESSION_NOTE` already says the blocks are separate
 * conversations; this says *when* each one happened.
 *
 * ## Why this runs on the assembled prompt
 *
 * The first draft computed the label from the turns the budget **selected**, and a test written as a
 * property rather than as a fixture caught it: a 700-character room selected four turns, rendered two and
 * a half, and the label read `2023-05-21..2023-12-31` — a date whose text the reader never received. The
 * clip ends inside a turn, so "selected" and "rendered" are different sets on exactly the route this
 * mechanism is for. Reading the rendered text cannot make that mistake, and it makes the operation a
 * function of the prompt alone: no coordinate of the delivered multiset can move, which is the same
 * property `insertRelatedStatements` has and the reason both are applied after the budget.
 *
 * ## Why a bracketed date and not a bare one
 *
 * `I moved on 2023/05/21` is content: it dates an *event*, and a boundary labelled with it would be a claim
 * the evidence does not make. The bracket is the transcript's own notation for *when this was recorded*, and
 * it is the only shape this reads. No anchoring to the start of a turn is possible here and none is wanted:
 * the renderer writes `1. ` or `#3 ` in front of every stamp, so the stamp is never at the start of a line
 * in the string this function sees — anchoring would make the mechanism fire on nothing.
 */

/**
 * Any bracketed stamp, wherever it sits in the rendered block.
 *
 * The annotation reads the block rather than the turns, so it sees the stamp in the position the renderer
 * put it: after `1. ` or `#3 `, not at the start of the string. Requiring the turn-start anchor here would
 * make the mechanism fire on no rendered prompt at all — the exact defect the property test exists for.
 */
const BLOCK_STAMP = /\[\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?=[\s\])])/g;

/** A boundary line as the renderer writes it, and only that: `Session 12` alone on its line. */
const BOUNDARY = /^Session (\d+)$/gm;

/** Days per month, with February resolved by {@link isLeapYear}. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `YYYY-MM-DD` for a stamp's parts, or `null` when those parts name no day. */
function isoDate(year: string, month: string, day: string): string | null {
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12) return null;
  const limit = m === 2 && isLeapYear(Number(year)) ? 29 : MONTH_DAYS[m - 1]!;
  if (d < 1 || d > limit) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The label a run of stamps holds, or `null` when it holds none.
 *
 * A range when the stamps disagree, because a block whose turns span two days is a fact about that block
 * and rounding it would be the same error as attributing one date to every candidate. Lexicographic
 * comparison is correct for `YYYY-MM-DD`, and `..` cannot be parsed as part of a date.
 */
function span(stamps: readonly string[]): string | null {
  if (stamps.length === 0) return null;
  let first = stamps[0]!;
  let last = stamps[0]!;
  for (const stamp of stamps) {
    if (stamp < first) first = stamp;
    if (stamp > last) last = stamp;
  }
  return first === last ? first : `${first}..${last}`;
}

/** The `[YYYY/MM/DD]`-style stamps a block of rendered text contains, as `YYYY-MM-DD`. */
function stampsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(BLOCK_STAMP)) {
    const date = isoDate(match[1]!, match[2]!, match[3]!);
    if (date !== null) found.push(date);
  }
  return found;
}

/**
 * Write each session boundary's date into the boundary line of an already-assembled prompt.
 *
 * Pure, and a no-op on every prompt that draws no boundary, so the only prompts it can change are the
 * multi-session ones it exists for. Idempotent by construction: an annotated boundary no longer matches
 * {@link BOUNDARY}, so running this twice cannot produce `Session 1 (x) (x)`.
 *
 * Returns the input unchanged — the same string, not a copy — when nothing was annotated, so a caller can
 * compare identity rather than text to learn whether the mechanism acted.
 */
export function annotateSessionBoundaries(prompt: string): string {
  const boundaries = [...prompt.matchAll(BOUNDARY)];
  if (boundaries.length === 0) return prompt;

  let annotated = '';
  let cursor = 0;
  for (const [index, match] of boundaries.entries()) {
    const bodyStart = match.index + match[0].length;
    const next = boundaries[index + 1];
    const bodyEnd = next === undefined ? prompt.length : next.index;
    const label = span(stampsIn(prompt.slice(bodyStart, bodyEnd)));
    annotated += prompt.slice(cursor, match.index) + match[0];
    if (label !== null) annotated += ` (${label})`;
    cursor = bodyStart;
  }
  annotated += prompt.slice(cursor);
  return annotated;
}

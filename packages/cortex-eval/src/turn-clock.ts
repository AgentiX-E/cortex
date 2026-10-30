/**
 * The clock a delivered turn carries in its own text: read it, and partition a
 * delivered list by a window without ever changing which turns the list holds.
 *
 * ## Why this module exists
 *
 * §13.151 read the reference pipeline's `temp_query_search_pruning.py` and found the
 * mechanism it registers: infer a date range from the question, then move the items
 * inside that range to the front of the list the retrieval already produced. The move
 * is a **permutation**, so it cannot add evidence -- and that is the property that
 * makes it registrable on its own, because the delivered multiset is invariant and the
 * only thing a reading can attribute movement to is order.
 *
 * The reference pays an index-time LLM pass (`timestamped_facts`) to learn each
 * session's date, and a second call at question time to infer the range. This arm pays
 * neither: the turn already opens with `[2023/02/15 (Wed) 01:41]`, so a date is a
 * **prefix parse**. §13.151.3 recorded that as the arm's advantage; this module is the
 * parse, and §13.152.1 records what it reads on the control run's own artifact.
 *
 * ## Why the read is a function and not a regex at the call site
 *
 * §13.151.5's first criterion is that the parse resolves a date on **every** turn of
 * every question *or names the questions it cannot*. A regex inlined where the reorder
 * needs it cannot satisfy the second half: an unreadable turn would silently fall into
 * "not in the window" and be ranked last, which is a mechanism administering itself on
 * a population it never reported. So the failures are a return value here, and
 * `tools/prefix-coverage.mjs` prints them per question.
 *
 * ## Why it lives in `cortex-eval` and not in `cortex-memory`
 *
 * Same reason `roleOfTurn` does: the product takes a classifier rather than knowing a
 * dataset's rendering, so the product's behaviour is not a fact about one benchmark.
 * `cortex-memory` receives a window and a date reader; this module is the reader the
 * arm hands it.
 *
 * ## Why the weekday is checked against the date instead of being ignored
 *
 * The stamp carries two encodings of the same fact. On the control run's 60,438
 * delivered turns they agree on **every one** (§13.152.1), so a disagreement is not
 * noise to be tolerated -- it is a renderer that has moved a turn's date or its label,
 * and the reorder would then move the wrong turns. Refusing the stamp costs a question
 * nothing (it stays where it was) and turns a silent misordering into a count.
 *
 * The same argument covers the time-of-day and the calendar: a stamp whose minute is
 * `61`, or whose day is `2023/02/30`, is not this renderer's output either.
 */

import type { TimeRange } from './temporal-engine.js';

/** The three-letter weekday labels this dataset's renderer emits, indexed by `Date#getUTCDay`. */
const WEEKDAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A turn prefix: `[YYYY/MM/DD (Day) HH:MM]`.
 *
 * Anchored, because a turn whose *content* quotes another turn's prefix is common in
 * this corpus (the assistant repeats the user's dates back), and an unanchored pattern
 * would read the quoted date as the turn's own.
 *
 * The weekday and the time are both optional in the pattern and validated when
 * present, so the same reader serves a renderer that emits `[2023/02/15] user: ...` --
 * the shape `formatStructuredContext` also accepts -- without a second format here. The
 * mechanism needs the date; requiring fields it never reads would refuse work over a
 * rendering detail.
 */
const TURN_STAMP = /^\[(\d{4})\/(\d{2})\/(\d{2})(?: \(([A-Za-z]{3})\))?(?: (\d{2}):(\d{2}))?\]/;

/** One turn's clock, as read from the prefix. */
type TurnStamp = {
  /** The turn's date, `YYYY/MM/DD`. The only field the reorder consumes. */
  readonly date: string;
  /**
   * The weekday label exactly as written, or `undefined` when the prefix carries none.
   *
   * Kept rather than discarded because it is the consistency check that makes a
   * mis-rendered date countable: a stamp that disagrees with its own calendar is
   * refused by {@link readTurnStamp} instead of being returned with a note.
   */
  readonly weekday: string | undefined;
  /**
   * Minutes since midnight, or `undefined` when the prefix carries no time.
   *
   * Parsed and validated but not consumed: no registered mechanism in this campaign
   * separates two turns by their time of day, and a field added to a returned record is
   * cheaper than a second reader when one does. It is validated rather than stored
   * blindly for the reason in the module comment -- a minute above 59 is a renderer that
   * is not the one measured, and the date beside it is then not to be trusted either.
   */
  readonly minuteOfDay: number | undefined;
};

/** Days in a calendar month (1-based), accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The weekday label a date falls on, in UTC so no local zone shifts the answer. */
function weekdayOf(year: number, month: number, day: number): string {
  return WEEKDAY_LABELS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] as string;
}

/**
 * Read one turn's stamp, or `undefined` when the prefix is absent or inconsistent.
 *
 * `undefined` is a **refusal**, not an error: an undated turn is a turn the reorder
 * leaves in place, and the caller counts it. Every refusal below is reachable by a
 * specific input and named in the suite, so none of them is a defensive branch no test
 * can honestly cover:
 *
 * - no anchored prefix (a truncated turn, or a rendering this arm does not emit);
 * - a month outside `01`-`12`, a day outside the month, an hour above `23` or a minute
 *   above `59` (a shape that carries numbers where a date belongs);
 * - a weekday label that is not one of the seven (a three-letter word in the weekday
 *   slot, e.g. a locale that abbreviates differently);
 * - a weekday label that disagrees with the date's own calendar.
 */
export function readTurnStamp(turn: string): TurnStamp | undefined {
  const match = TURN_STAMP.exec(turn);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // `Number('00')` is 0, so the lower bounds are explicit: a `0000` year is not a date
  // this corpus can hold, and `Date.UTC` would silently roll `2023/00/10` into 2022.
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  const date = `${match[1]}/${match[2]}/${match[3]}`;
  const written = match[4];
  if (written !== undefined && written !== weekdayOf(year, month, day)) {
    return undefined;
  }
  const hour = match[5];
  const minute = match[6];
  // Both or neither: the pattern makes them one optional group, so a prefix carrying an
  // hour without a minute cannot reach here. Validated as a pair for that reason.
  let minuteOfDay: number | undefined;
  if (hour !== undefined && minute !== undefined) {
    const hours = Number(hour);
    const minutes = Number(minute);
    if (hours > 23 || minutes > 59) {
      return undefined;
    }
    minuteOfDay = hours * 60 + minutes;
  }
  return { date, weekday: written, minuteOfDay };
}

/**
 * What a delivered list's clocks read as, with the failures named rather than dropped.
 *
 * `dates` is parallel to the input so `partitionByWindow` can be given a reader that
 * costs one parse per turn rather than one per comparison, and `undatedIndices` is what
 * lets a report say *which* turns of *which* question could not be read -- criterion 1's
 * second half. The counts are present because an artifact wants a number, but they are
 * derived from the indices rather than accumulated beside them, so the two cannot
 * disagree.
 */
type TurnClockCensus = {
  readonly dates: readonly (string | undefined)[];
  readonly dated: number;
  readonly undatedIndices: readonly number[];
};

/**
 * Read every turn's stamp, keeping the reading parallel to the input.
 *
 * The census type is declared without `export`: it is this function's return shape and nothing in
 * this checkout names it, and `tools/export-census.mjs` is right that an export nothing calls is a
 * second spelling of a shape one module owns. A caller that needs to name it can import the module
 * rather than the package entry.
 */
export function readTurnClocks(turns: readonly string[]): TurnClockCensus {
  const dates: (string | undefined)[] = [];
  const undatedIndices: number[] = [];
  for (const [index, turn] of turns.entries()) {
    const date = readTurnStamp(turn)?.date;
    dates.push(date);
    if (date === undefined) {
      undatedIndices.push(index);
    }
  }
  return { dates, dated: dates.length - undatedIndices.length, undatedIndices };
}

/**
 * The delivered list split into the turns a window admits and the rest, both keeping
 * their original relative order.
 *
 * ## Why this is the whole mechanism and not a step of one
 *
 * Concatenating the two lists is the reference's `ranked_items_new = left + right`
 * (§13.151.1 step 3). Because the split is a partition, the concatenation is a
 * permutation of the input: same multiset, same length, same bytes per turn. §13.151.5's
 * second criterion -- "the multiset of delivered turns is byte-identical to the
 * control's" -- is therefore a property of this function's type, not a thing the run has
 * to hope for.
 *
 * ## Why stability is required on both sides
 *
 * The undated side is the one that matters. An undated turn cannot be shown to be
 * outside the window, only to be unreadable, so promoting it would be a claim the parse
 * did not make; demoting it below turns that *are* outside would be a second, silent
 * judgement. Leaving it in its own relative order is the only arrangement that says
 * nothing about it. The in-window side keeps its order for the different reason that the
 * retrieval's ranking inside the window is still the best evidence available.
 *
 * ## Why the window is not widened here
 *
 * The reference widens its inferred range by two days at each end (§13.151.1 step 2)
 * because a model-inferred boundary is a guess about a single event date. The window this
 * arm hands in comes from `resolveTimeRange`, which already applies its own per-unit
 * margin (`RANGE_MARGIN_DAYS`); widening again would buy a wider window twice for the
 * same question and make the mechanism's reach a function of two multipliers.
 */
export function partitionByWindow<T>(
  items: readonly T[],
  window: TimeRange,
  dateOf: (item: T) => string | undefined,
): { readonly inWindow: readonly T[]; readonly outOfWindow: readonly T[] } {
  const inWindow: T[] = [];
  const outOfWindow: T[] = [];
  for (const item of items) {
    const date = dateOf(item);
    // Lexicographic comparison is correct for `YYYY/MM/DD` and is why the format was
    // chosen; both bounds are inclusive, matching `TimeRange`'s own contract.
    if (date !== undefined && date >= window.start && date <= window.end) {
      inWindow.push(item);
    } else {
      outOfWindow.push(item);
    }
  }
  return { inWindow, outOfWindow };
}

/**
 * The span the delivered turns cover, or `undefined` when none of them is dated.
 *
 * ## Why a caller needs this
 *
 * A window outside the delivered span moves nothing, and a run that reports "fired on 70
 * questions" without also reporting "and 41 of them could not move a turn" has published
 * a reach it did not have. Measuring the span is what separates *fired* from *moved*,
 * and `tools/prefix-coverage.mjs` reports both (§13.152.3).
 *
 * The span is also the cheapest sanity check available on the window resolver itself: a
 * range that does not intersect the span means either the question's reference date is
 * outside the haystack or the resolver picked a unit the question did not state, and both
 * are worth a count before a dispatch spends 560 calls.
 */
export function deliveredWindow(turns: readonly string[]): TimeRange | undefined {
  let start: string | undefined;
  let end: string | undefined;
  for (const turn of turns) {
    const date = readTurnStamp(turn)?.date;
    if (date === undefined) {
      continue;
    }
    // Lexicographic min/max on a padded fixed-width format is date order.
    if (start === undefined || date < start) {
      start = date;
    }
    if (end === undefined || date > end) {
      end = date;
    }
  }
  return start === undefined || end === undefined ? undefined : { start, end };
}

/**
 * Deterministic temporal-reasoning engine for LongMemEval-style questions.
 *
 * Temporal questions fail when an LLM is asked to BOTH locate the event turn and
 * compute elapsed time or event ordering, because language models are unreliable
 * at reading `[YYYY/MM/DD]` prefixes and at arithmetic. This module splits that
 * work: the LLM only reports which event(s) the question refers to (copied from
 * the evidence turns), and every elapsed-time / interval / ordering computation
 * is performed here with exact date arithmetic. The result is reproducible and
 * independent of the LLM's arithmetic ability.
 *
 * Every exported function is pure: it takes strings and returns strings/numbers
 * with no I/O, so the whole engine is unit-testable without a network or a
 * provider.
 */
import { daysBetween } from './temporal.js';

export type TemporalKind = 'relative' | 'interval' | 'ordering' | 'eventLookup' | 'other';

/**
 * Which refinements of the deterministic engine are active.
 *
 * The engine's outputs feed the graded benchmark path, so a refinement that has
 * not yet been measured by its own ablation must not be able to change that path
 * silently. Each flag names one independently measured capability, and the
 * defaults preserve the pre-refinement behaviour so an ablation can vary exactly
 * one of them.
 */
export type TemporalEngineOptions = {
  /**
   * Resolve a named weekday ("last Saturday", "this Monday", "next Friday") to a
   * concrete date, and scale the window margin with the offset unit. Before this
   * refinement the engine returned `null` for every weekday-anchored question —
   * 6 of the 20 LongMemEval-S `eventLookup` questions — and widened every offset
   * by a flat ±7 days.
   */
  extendedTimeRange: boolean;
  /**
   * Treat "before/after <event>" as introducing a second event, so a two-event
   * interval question reaches the deterministic interval path instead of the
   * LLM's own arithmetic.
   */
  extendedSecondEventReference: boolean;
};

const DEFAULT_ENGINE_OPTIONS: TemporalEngineOptions = {
  extendedTimeRange: false,
  extendedSecondEventReference: false,
};

/** Every refinement enabled: the configuration an accepted ablation promotes to. */
export const EXTENDED_ENGINE_OPTIONS: TemporalEngineOptions = {
  extendedTimeRange: true,
  extendedSecondEventReference: true,
};

/** A question event paired with the date copied from its evidence turn. */
export type TemporalEvent = {
  name: string;
  /** Event date: absolute `YYYY/MM/DD`, or a verbatim relative time ("yesterday"). */
  date: string;
  /**
   * The evidence turn's `[YYYY/MM/DD]` prefix, which anchors a relative `date`.
   * "yesterday" means the day before THIS turn, not the day before the question,
   * so the relative-to-absolute conversion must use the turn date as its
   * reference when one is supplied.
   */
  turnDate?: string;
};

/**
 * Classify a question by the temporal computation it requires:
 *  - `relative`: "how many days/weeks/months ago/since …"
 *  - `interval`: "how many days between X and Y" / "did I spend …" / "how long …"
 *  - `ordering`: "which/who … first" / "before or after" / "most recently"
 *  - `eventLookup`: a who/what/which/where question anchored to a time qualifier
 *    ("… ago", "last …", "recently", "on …") whose answer is the entity itself,
 *    not a computed number.
 *  - `other`: anything that needs no date arithmetic and no time-anchored lookup.
 */
export function classifyTemporalQuestion(question: string): TemporalKind {
  if (
    /\b(before or after|happened first|which .*? first|order from first to last|what is the order|who .*? first|most recently|became .*? first|graduated .*? first)\b/i.test(
      question,
    )
  ) {
    return 'ordering';
  }
  if (/\b(between|did I spend|how long)\b/i.test(question)) {
    return 'interval';
  }
  // Only "how many X ago/since/passed" asks for an elapsed-time count. An
  // event-lookup question ("Which book did I finish a week ago?") asks for the
  // event itself, not a number, so it must NOT be classified as relative.
  if (/\bhow many\b/i.test(question) && /\b(ago|since|passed)\b/i.test(question)) {
    return 'relative';
  }
  // A who/what/which/where question anchored to a time qualifier asks for the
  // event/entity at that time, not for a date computation, so it is routed to a
  // dedicated lookup prompt rather than the date-arithmetic engine.
  if (
    /\b(who|what|which|where|whom)\b/i.test(question) &&
    /\b(ago|last|recently|on)\b/i.test(question)
  ) {
    return 'eventLookup';
  }
  return 'other';
}

/**
 * True when a relative-time question names a SECOND event to measure to.
 *
 * "How many days had passed since I started ukulele lessons when I took my
 * guitar to the tech?" asks for the span between the two events; the question
 * date is not a term of that question at all. `computeTemporalAnswer` measured
 * every relative question from the first event to the question date, so it
 * answered 59 where the gold is 24 — identically on all four benchmark runs,
 * because the computation is deterministic rather than sampled.
 *
 * Measured over the 25 relative questions of LongMemEval-S: 18 of 19
 * single-event questions answered correctly, and 0 of 6 two-event ones.
 *
 * Two shapes introduce a second event:
 *  - a `when` clause with a subject ("when I …", "when the …"). A bare "when it
 *    was on sale" describes the one event rather than naming another.
 *  - a `before`/`after <event>` clause, as in "How many days BEFORE my best
 *    friend's birthday party did I order her gift?" — that question names two
 *    orderable events and its gold answer is their interval, but the `when`
 *    predicate never matched it, so it never reached the deterministic interval
 *    path and the LLM computed "5" against a gold of "7".
 *
 * The `before`/`after` match requires a determiner or possessive directly after
 * the preposition AND a noun phrase that is not a bare temporal word, so
 * "before my best friend's birthday party" (an event) matches while "before the
 * sale ended" / "before the holidays" (a deadline or a season, with no second
 * event to measure to) does not. The predicate errs toward false negatives by
 * design: a false negative leaves an already-failing question as it is, a false
 * positive breaks one that works.
 */
export function hasSecondEventReference(
  question: string,
  options: TemporalEngineOptions = DEFAULT_ENGINE_OPTIONS,
): boolean {
  if (/\bwhen\s+(?:I|we|you|he|she|they|the|my|our|his|her|their|a|an)\b/i.test(question)) {
    return true;
  }
  if (!options.extendedSecondEventReference) {
    return false;
  }
  const beforeAfter = question.match(
    /\b(?:before|after)\s+(?:the|my|our|his|her|their|your|a|an)\s+([a-z][a-z'’-]*)/i,
  );
  if (!beforeAfter) {
    return false;
  }
  // A season, deadline, or bare time word after the preposition is not a second
  // event: "before the sale ended", "before the holidays", "after the fact".
  return !/^(?:sale|holidays?|weekend|fact|event|end|time|day|week|month|year|moment|meanwhile)\b/i.test(
    beforeAfter[1]!,
  );
}

/**
 * Extract the leading `YYYY/MM/DD` from a date string that may carry a
 * weekday/time suffix (e.g. `2023/02/01 (Wed) 10:20`) or a turn prefix
 * (e.g. `[2023/03/04 (Sat) 22:43]`). Returns `''` when no date is present.
 */
export function normalizeDate(raw: string): string {
  const match = raw.trim().match(/^\s*\[?\s*(\d{4})\/(\d{2})\/(\d{2})/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : '';
}

/** True when a string is exactly a `YYYY/MM/DD` date. */
export function isValidDate(date: string): boolean {
  return /^\d{4}\/\d{2}\/\d{2}$/.test(date);
}

/** Small number words the LLM may use when reporting a relative date. */
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  few: 3,
};

/**
 * Parse a relative date like "a month ago" / "two weeks before" / "3 days ago" /
 * "yesterday" / "a couple of days ago" into a numeric offset. Returns `null` when
 * the string is not a recognised relative-time expression, so callers fall back
 * to treating it as unparseable.
 */
export function parseRelativeOffset(raw: string): { amount: number; unit: RelativeUnit } | null {
  const lower = raw.toLowerCase();
  // "yesterday" is a single day in the past and does not fit the
  // "<number> <unit> ago" pattern below.
  if (/\byesterday\b/.test(lower)) {
    return { amount: 1, unit: 'day' };
  }
  const match = lower.match(
    /\b(a\s+couple\s+of|a\s+few|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(day|week|month)s?\s+(ago|before)\b/,
  );
  if (!match) {
    return null;
  }
  const token = match[1]!;
  const amount =
    token === 'a couple of' ? 2 : token === 'a few' ? 3 : (NUMBER_WORDS[token] ?? Number(token));
  return { amount, unit: match[2] as RelativeUnit };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Add a signed number of days to a `YYYY/MM/DD` date, in UTC. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('/').map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}/${pad2(shifted.getUTCMonth() + 1)}/${pad2(shifted.getUTCDate())}`;
}

/** Days in a calendar month (1-based month), accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Add a signed number of calendar months, clamping to the last valid day. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('/').map(Number);
  const totalMonths = y! * 12 + (m! - 1) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = totalMonths - newYear * 12; // 0-based, always in [0, 11]
  const newDay = Math.min(d!, daysInMonth(newYear, newMonth + 1));
  return `${String(newYear).padStart(4, '0')}/${pad2(newMonth + 1)}/${pad2(newDay)}`;
}

/**
 * Resolve an event date to an absolute `YYYY/MM/DD`. The LLM reports either an
 * absolute turn date (returned unchanged) or a relative time copied verbatim
 * ("a month ago"); this function converts the latter against `questionDate`.
 * Returns `''` when the date is neither absolute nor a recognised relative time.
 * Performing the conversion HERE (exact date arithmetic) instead of in the LLM
 * removes the model's arithmetic error, which is the whole point of the
 * deterministic engine.
 */
export function resolveTemporalDate(raw: string, questionDate: string): string {
  const absolute = normalizeDate(raw);
  if (isValidDate(absolute)) {
    return absolute;
  }
  const offset = parseRelativeOffset(raw);
  if (offset === null) {
    return '';
  }
  const reference = normalizeDate(questionDate);
  if (!isValidDate(reference)) {
    return '';
  }
  if (offset.unit === 'month') {
    return addMonths(reference, -offset.amount);
  }
  const days = offset.unit === 'week' ? offset.amount * 7 : offset.amount;
  return addDays(reference, -days);
}

/** A half-open date interval [start, end], both inclusive, as `YYYY/MM/DD`. */
export type TimeRange = { start: string; end: string };

/**
 * Margin around a resolved point time, by the unit the offset was stated in.
 *
 * A single constant cannot serve every scale. The question's phrasing is the
 * user's own approximation, so *some* tolerance is honest — but ±7 days turns
 * "10 days ago" into a 15-day window, which inside a two-week context stops
 * discriminating the anchor turn from its neighbours (it was the whole point of
 * the range to discriminate). Month-scale offsets are genuinely fuzzier ("a
 * month ago" is often 4-6 weeks in speech), so they keep the widest margin.
 */
const RANGE_MARGIN_DAYS: Record<'day' | 'week' | 'month' | 'plainWeek' | 'legacy', number> = {
  day: 2,
  week: 3,
  month: 7,
  // "last week" is already a seven-day span, so it needs no extra widening
  // beyond the day-scale tolerance on each edge.
  plainWeek: 2,
  // The pre-refinement flat margin, kept so an ablation can reproduce the
  // original engine exactly rather than approximating it.
  legacy: 7,
};

/**
 * How many days outside the window a turn may sit and still be worth calling out
 * in the prompt. Beyond this the turn is simply "not the window" and annotating
 * it adds noise rather than signal.
 */
export const TIME_WINDOW_ANNOTATION_HORIZON_DAYS = 3;

/** Weekday names in `Date.getUTCDay()` order, longest forms first for matching. */
const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Recognised abbreviations, mapped to their full weekday index. */
const WEEKDAY_ABBREVIATIONS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};

/** The weekday index (0 = Sunday) a `YYYY/MM/DD` date falls on. */
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('/').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/**
 * Locate a named weekday ("last Saturday", "this Monday", "next Friday" or a
 * bare "on Tuesday") and return its resolved date, or `null` when the question
 * names no weekday.
 *
 * Convention, fixed by test so both directions are pinned:
 *  - `last <day>` / `on <day>` / bare `<day>` → the most recent occurrence
 *    STRICTLY BEFORE the question date (a question asked on a Saturday that says
 *    "last Saturday" means the week before, not itself).
 *  - `this <day>` → the occurrence within the question date's own week, which
 *    may be earlier or equal to the question date but never later.
 *  - `next <day>` → the next occurrence strictly after the question date.
 */
function resolveWeekday(lower: string, reference: string): TimeRange | null {
  const match = lower.match(
    /\b(last|this|next|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thur|thurs|thu|fri|sat)\b/,
  );
  if (!match) {
    return null;
  }
  const qualifier = match[1]!;
  const token = match[2]!;
  const fullIndex = (WEEKDAY_NAMES as readonly string[]).indexOf(token);
  const target = fullIndex >= 0 ? fullIndex : WEEKDAY_ABBREVIATIONS[token]!;
  const current = weekdayIndex(reference);

  let delta: number;
  if (qualifier === 'next') {
    // Strictly forward: 1 to 7 days ahead.
    delta = ((target - current + 6) % 7) + 1;
  } else if (qualifier === 'this') {
    // Within the current week, backwards: 0 to 6 days back.
    delta = -((current - target + 7) % 7);
  } else {
    // "last" / "on" / bare: strictly backwards, 1 to 7 days.
    delta = -((current - target + 7) % 7 || 7);
  }

  const day = addDays(reference, delta);
  return { start: day, end: day };
}

/**
 * Resolve a question's time qualifier into an absolute date range against the
 * question date, mirroring Hindsight's deterministic temporal parsing: "two
 * weeks ago" / "yesterday" / "last week" / "last Saturday" / "next month" /
 * "next year" become a concrete [start, end] that a downstream step can use to
 * constrain event lookup — instead of asking the LLM to convert
 * "ago"/"last"/"next" itself (its arithmetic is the error the deterministic
 * engine exists to remove).
 *
 * Order of preference is explicit-offset-first: a question that states both an
 * offset and a weekday ("two weeks ago last Friday") resolves through the
 * offset, which is the precise signal.
 *
 * Returns `null` when the question carries no recognised time qualifier or the
 * question date is not a valid `YYYY/MM/DD`.
 */
export function resolveTimeRange(
  question: string,
  questionDate: string,
  options: TemporalEngineOptions = DEFAULT_ENGINE_OPTIONS,
): TimeRange | null {
  const reference = normalizeDate(questionDate);
  if (!isValidDate(reference)) {
    return null;
  }
  const lower = question.toLowerCase();

  if (/\byesterday\b/.test(lower)) {
    const day = addDays(reference, -1);
    return { start: day, end: day };
  }

  if (/\blast\s+week\b/.test(lower)) {
    if (options.extendedTimeRange) {
      // "last week" is a point seven days back, widened by the day-scale margin
      // on each edge.
      const margin = RANGE_MARGIN_DAYS.plainWeek;
      return { start: addDays(reference, -7 - margin), end: addDays(reference, -7 + margin) };
    }
    // Legacy behaviour: the seven-to-thirteen-day window with no extra widening.
    return { start: addDays(reference, -13), end: addDays(reference, -7) };
  }

  if (/\blast\s+month\b/.test(lower)) {
    const prev = addMonths(reference, -1);
    return monthRange(prev);
  }

  if (/\bnext\s+month\b/.test(lower)) {
    const next = addMonths(reference, 1);
    return monthRange(next);
  }

  if (/\bnext\s+year\b/.test(lower)) {
    const year = Number(reference.slice(0, 4)) + 1;
    return { start: `${year}/01/01`, end: `${year}/12/31` };
  }

  // An explicit numeric offset outranks a weekday: "two weeks ago last Friday"
  // states the precise anchor, and the weekday is incidental.
  const offset = parseRelativeOffset(question);
  if (offset !== null) {
    const target =
      offset.unit === 'month'
        ? addMonths(reference, -offset.amount)
        : addDays(reference, offset.unit === 'week' ? -offset.amount * 7 : -offset.amount);
    const margin = options.extendedTimeRange
      ? RANGE_MARGIN_DAYS[offset.unit]
      : RANGE_MARGIN_DAYS.legacy;
    return { start: addDays(target, -margin), end: addDays(target, margin) };
  }

  // Only reached when the question states no numeric offset, so a named weekday
  // is the sole anchor available. Before the refinement there was no weekday
  // path at all, and these questions resolved to no window.
  if (!options.extendedTimeRange) {
    return null;
  }
  return resolveWeekday(lower, reference);
}

/** First and last day of the month containing `date`, both `YYYY/MM/DD`. */
function monthRange(date: string): TimeRange {
  const [year, month] = date.split('/').map(Number);
  const lastDay = daysInMonth(year!, month!);
  return {
    start: `${String(year).padStart(4, '0')}/${pad2(month!)}/01`,
    end: `${String(year).padStart(4, '0')}/${pad2(month!)}/${pad2(lastDay)}`,
  };
}

/** Signed whole days from `from` to `to` (positive when `to` is later). */
export function elapsedDays(from: string, to: string): number {
  return daysBetween(from, to);
}

/**
 * Whole weeks elapsed from `from` to `to`, rounded to the nearest week. The
 * LongMemEval ground truth rounds ("13 days ago" → "2 weeks ago"), so flooring
 * would under-count partial weeks that are closer to the next week.
 */
export function elapsedWeeks(from: string, to: string): number {
  return Math.round(daysBetween(from, to) / 7);
}

/**
 * Calendar months elapsed from `from` to `to`, ignoring the day-of-month. This
 * is the meaning of "how many months have passed" (a date in October 2022 and a
 * date in March 2023 are five calendar months apart regardless of the day).
 */
export function elapsedMonths(from: string, to: string): number {
  const [y1, m1] = splitDate(from);
  const [y2, m2] = splitDate(to);
  return (y2 - y1) * 12 + (m2 - m1);
}

/** Absolute whole days between two dates (interval length). */
export function intervalDays(a: string, b: string): number {
  return Math.abs(daysBetween(a, b));
}

/** Sort events ascending by date without mutating the input. */
export function orderByDate<T extends { date: string }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => {
    const da = normalizeDate(a.date);
    const db = normalizeDate(b.date);
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

type RelativeUnit = 'day' | 'week' | 'month';

/**
 * Compute the deterministic answer for a temporal question from its extracted
 * events. Returns `null` when the question cannot be answered deterministically
 * (wrong kind, missing question date, or too few valid events), signalling the
 * caller to fall back to the LLM temporal prompt.
 */
export function computeTemporalAnswer(
  question: string,
  kind: TemporalKind,
  questionDate: string,
  events: readonly TemporalEvent[],
  options: TemporalEngineOptions = DEFAULT_ENGINE_OPTIONS,
): string | null {
  if (kind === 'other' || kind === 'eventLookup') {
    return null;
  }
  // Resolve each event date to an absolute date: the LLM reports either the
  // turn's [YYYY/MM/DD] prefix or a verbatim relative time ("a month ago",
  // "yesterday"). A relative time is anchored to the event's own turn date when
  // one is supplied (the turn that states "yesterday" is the day AFTER the
  // event), and to the question date only as a fallback.
  const normalized = events
    .filter((e) => {
      // The structured extractor types these as TemporalEvent, but the LLM does
      // not honour `required: ["name", "date"]` at runtime — after the turnDate
      // prompt change it can move the date into turnDate and emit an event with
      // no `date`, or omit `name`. Drop malformed events instead of letting
      // `undefined.trim()` throw and abort the whole benchmark run.
      const candidate = e as unknown as { name?: unknown; date?: unknown };
      return typeof candidate?.name === 'string' && typeof candidate?.date === 'string';
    })
    .map((e) => ({
      name: e.name.trim(),
      date: resolveTemporalDate(e.date, e.turnDate ?? questionDate),
    }))
    .filter((e) => e.name !== '' && isValidDate(e.date));
  if (normalized.length === 0) {
    return null;
  }

  switch (kind) {
    case 'relative': {
      // A relative question that names a second event measures BETWEEN the two
      // events, not from the first event to the question date. Measuring to the
      // question date answered 0 of those 6 questions in LongMemEval-S, while
      // answering 18 of the 19 that name only one event.
      if (hasSecondEventReference(question, options)) {
        if (normalized.length < 2) {
          return null;
        }
        return String(
          intervalValue(normalized[0]!.date, normalized[1]!.date, relativeUnit(question)),
        );
      }
      const reference = normalizeDate(questionDate);
      if (!isValidDate(reference)) {
        return null;
      }
      const value = elapsedValue(normalized[0]!.date, reference, relativeUnit(question));
      return String(value);
    }
    case 'interval': {
      if (normalized.length < 2) {
        return null;
      }
      return String(
        intervalValue(normalized[0]!.date, normalized[1]!.date, relativeUnit(question)),
      );
    }
    case 'ordering': {
      if (normalized.length < 2) {
        return null;
      }
      return formatOrdering(question, normalized);
    }
  }
}

/** Detect the elapsed-time unit a relative question asks about. */
function relativeUnit(question: string): RelativeUnit {
  if (/\bweeks?\b/i.test(question)) {
    return 'week';
  }
  if (/\bmonths?\b/i.test(question)) {
    return 'month';
  }
  return 'day';
}

/** Compute elapsed time in the question's unit. */
function elapsedValue(from: string, to: string, unit: RelativeUnit): number {
  if (unit === 'week') {
    return elapsedWeeks(from, to);
  }
  if (unit === 'month') {
    return elapsedMonths(from, to);
  }
  return elapsedDays(from, to);
}

/**
 * Compute an interval length in the question's unit. Unlike `elapsedValue`,
 * this is always non-negative: the two event dates may be extracted in either
 * order, so the length is measured as an absolute span.
 */
function intervalValue(from: string, to: string, unit: RelativeUnit): number {
  if (unit === 'week') {
    return Math.round(intervalDays(from, to) / 7);
  }
  if (unit === 'month') {
    return Math.abs(elapsedMonths(from, to));
  }
  return intervalDays(from, to);
}

/**
 * Format an ordering answer. `events` preserves the LLM's extraction order,
 * which matches the question's mention order for before/after questions; the
 * events are re-sorted by date for the other ordering shapes.
 */
function formatOrdering(question: string, events: readonly TemporalEvent[]): string {
  if (/\bbefore or after\b/i.test(question)) {
    // `daysBetween(first, second) > 0` means the second is later than the first,
    // i.e. the first-mentioned event happened BEFORE the second-mentioned event.
    const firstEarlier = daysBetween(events[0]!.date, events[1]!.date) > 0;
    return firstEarlier ? 'before' : 'after';
  }
  const ordered = orderByDate(events);
  // "most recently" asks for the latest event, the opposite of "first".
  if (/\bmost recently\b|\blatest\b|\bnewest\b/i.test(question)) {
    return ordered[ordered.length - 1]!.name;
  }
  // A full ranking ("first, second and third", "order from first to last",
  // "what is the order") reports the whole sequence, not just the earliest.
  if (/\border from first to last\b|\bwhat is the order\b|\bfirst, second\b/i.test(question)) {
    const names = ordered.map((e) => e.name);
    if (names.length === 2) {
      return `First, ${names[0]}, then ${names[1]}.`;
    }
    const last = names[names.length - 1]!;
    const middle = names
      .slice(1, -1)
      .map((name) => `then ${name}`)
      .join(', ');
    return `First, ${names[0]}, ${middle}, and lastly ${last}.`;
  }
  // "which/who … first" → the earliest event's name.
  return ordered[0]!.name;
}

function splitDate(date: string): [number, number] {
  const match = date.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) {
    throw new Error(`invalid date "${date}", expected YYYY/MM/DD`);
  }
  return [Number(match[1]), Number(match[2])];
}

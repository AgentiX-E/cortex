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

/** A question event paired with the date copied from its evidence turn. */
export type TemporalEvent = {
  name: string;
  date: string;
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
 * The match requires the `when` clause to introduce a subject ("when I …",
 * "when the …"). A bare "when it was on sale" describes the one event rather
 * than naming another, and a false positive would move a WORKING question off
 * the question-date path, so the predicate errs toward false negatives: a false
 * negative leaves an already-failing question as it is, a false positive breaks
 * one that works.
 */
export function hasSecondEventReference(question: string): boolean {
  return /\bwhen\s+(?:I|we|you|he|she|they|the|my|our|his|her|their|a|an)\b/i.test(question);
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
};

/**
 * Parse a relative date like "a month ago" / "two weeks before" / "3 days ago"
 * into a numeric offset. Returns `null` when the string is not a recognised
 * relative-time expression, so callers fall back to treating it as unparseable.
 */
export function parseRelativeOffset(raw: string): { amount: number; unit: RelativeUnit } | null {
  const match = raw
    .toLowerCase()
    .match(
      /\b(a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(day|week|month)s?\s+(ago|before)\b/,
    );
  if (!match) {
    return null;
  }
  const amount = NUMBER_WORDS[match[1]!] ?? Number(match[1]);
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
): string | null {
  if (kind === 'other' || kind === 'eventLookup') {
    return null;
  }
  // Resolve each event date to an absolute date: the LLM reports either the
  // turn's [YYYY/MM/DD] prefix or a verbatim relative time ("a month ago"),
  // which is converted here against the question date.
  const normalized = events
    .map((e) => ({ name: e.name.trim(), date: resolveTemporalDate(e.date, questionDate) }))
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
      if (hasSecondEventReference(question)) {
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

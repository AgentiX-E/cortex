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

export type TemporalKind = 'relative' | 'interval' | 'ordering' | 'other';

/** A question event paired with the date copied from its evidence turn. */
export type TemporalEvent = {
  name: string;
  date: string;
};

/**
 * Classify a question by the temporal computation it requires:
 *  - `relative`: "how many days/weeks/months ago/since …"
 *  - `interval`: "how many days between X and Y" / "how many days did I spend …"
 *  - `ordering`: "which … first" / "before or after" / "order from first to last"
 *  - `other`: anything that needs no date arithmetic.
 */
export function classifyTemporalQuestion(question: string): TemporalKind {
  if (
    /\b(before or after|happened first|which .*? first|order from first to last|what is the order)\b/i.test(
      question,
    )
  ) {
    return 'ordering';
  }
  if (/\b(between|did I spend)\b/i.test(question)) {
    return 'interval';
  }
  // Only "how many X ago/since/passed" asks for an elapsed-time count. An
  // event-lookup question ("Which book did I finish a week ago?") asks for the
  // event itself, not a number, so it must NOT be classified as relative.
  if (/\bhow many\b/i.test(question) && /\b(ago|since|passed)\b/i.test(question)) {
    return 'relative';
  }
  return 'other';
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
  if (kind === 'other') {
    return null;
  }
  const normalized = events
    .map((e) => ({ name: e.name.trim(), date: normalizeDate(e.date) }))
    .filter((e) => e.name !== '' && isValidDate(e.date));
  if (normalized.length === 0) {
    return null;
  }

  switch (kind) {
    case 'relative': {
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
  if (/\border from first to last\b|\bwhat is the order\b/i.test(question)) {
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
  // "which … first" → the earliest event's name.
  return ordered[0]!.name;
}

function splitDate(date: string): [number, number] {
  const match = date.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) {
    throw new Error(`invalid date "${date}", expected YYYY/MM/DD`);
  }
  return [Number(match[1]), Number(match[2])];
}

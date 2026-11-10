/**
 * The executor: a pure function from a ledger and a plan to a value and its supporting steps.
 *
 * ## Why this is a pure function and not a method
 *
 * Because the interesting property is **agreement with a reference**, and only a pure function can
 * be tested that way. The tests generate random ledgers and random conjunctions, evaluate the plan,
 * and compare against "filter the rows by hand, then count", over a thousand cases. A method that
 * consulted a model, cached a window or read instance state could not be compared to anything; it
 * could only be compared to itself.
 *
 * ## What `support` is for, and why the answer is not just a number
 *
 * Every result carries the step ids it was computed from. This is what turns a wrong answer into a
 * diagnosis: `$12` tagged as `60` in the previous pass left no trace of *which* sixty, and the
 * autopsy in `MEASURE-REVIEW-TALLY.md` had to reconstruct it from the ledger text. Here the same
 * failure would read `sum($) = 60 over steps [41, 42]`, and step 41 could be quoted.
 *
 * It is also the mechanism by which the executor is allowed to be trusted at all: the number is
 * checked against the rows it names, by anyone, without re-running anything.
 *
 * ## The three refusals that are not errors
 *
 * An empty selection returns `kind: 'empty'` rather than `count 0`. It is tempting to answer zero --
 * zero is a number, and the question asked for one -- but "no row matched my filters" and "the
 * answer is zero" are different claims, and only one of them is what the ledger says. The arm keeps
 * the first pass's answer instead, which is the same rule the tally pass applies to an untagged
 * ledger: an instrument that cannot compute does not invent the reading it could not take.
 */

import type { Ledger, LedgerRow } from './ledger.js';
import type { EventSpec, SpecPredicate } from './spec.js';

/** What a plan computes, once its rows are selected. */
type AggregateValue = number | string | readonly string[] | Readonly<Record<string, number>>;

/** A computed value, the steps that support it, and the unit its numbers shared. */
export type AggregationResult =
  | {
      readonly kind: 'value';
      readonly operation: EventSpec['operation'];
      readonly value: AggregateValue;
      /** Step ids, ascending. Every number and every string in `value` came from these rows. */
      readonly support: readonly number[];
      /**
       * The unit every summed number shared, when `sum` was asked for.
       *
       * `null` when the numbers disagreed -- summing `$3,750` and `2 pages` is a plan error the
       * executor cannot repair, and rendering `3752` would hide it. The renderer refuses a mixed
       * sum for that reason; this field is how it knows.
       */
      readonly unit: string | null;
      /**
       * Whether the summed numbers disagreed about their unit.
       *
       * `unit: null` alone cannot say this: a sum of bare counts has no unit either, and rendering
       * it is correct. Two different units is the plan error, and it is named separately so the
       * renderer can refuse that case and only that case.
       */
      readonly mixed: boolean;
    }
  | {
      readonly kind: 'empty';
      readonly operation: EventSpec['operation'];
    };

/** A filter on the numbers inside a row, as opposed to a filter on the row itself. */
type NumericPredicate = Extract<SpecPredicate, { field: 'number' }>;

/** Whether a number passes one numeric filter. */
function numberPasses(predicate: NumericPredicate, value: number, unit: string | null): boolean {
  switch (predicate.op) {
    case 'unit-is':
      return unit === predicate.value;
    case 'at-least':
      return value >= predicate.value;
    case 'at-most':
      return value <= predicate.value;
  }
}

/**
 * Whether a turn mentions a keyword: a match at a word's start, not anywhere in the string.
 *
 * The difference is not cosmetic. `text.indexOf('read')` finds `bread`, and the first version of this
 * predicate did exactly that: a keyword table for *"how many books did I read"* selected a turn that
 * said *"I baked bread"* and reported its two hours in the sum. A stem-based vocabulary makes the
 * hazard worse, because stems are short and collide with the middles of longer words.
 *
 * A word-start prefix keeps what the vocabulary was built for while refusing the interior match that
 * made a bread turn look like a reading turn. Its reach is stated rather than assumed: `bake` reaches
 * `baked` and `bakes`, and does **not** reach `baking`, whose stem is `bak` -- an e-dropping inflection
 * has no common prefix with the base form, and a rule cannot invent the pair. The keyword list carries
 * both forms when the question supplies them; a sentence promising more recall than the predicate has
 * would be a docstring the tests contradict.
 */
export function mentions(text: string, value: string): boolean {
  const needle = value.toLowerCase();
  if (needle === '') return false;
  const haystack = text.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1] as string)) return true;
  }
  return false;
}

/**
 * Whether a row passes one non-numeric filter.
 *
 * The type is what makes the `number` case unnecessary rather than unreachable: numeric filters never
 * reach this function (they filter the numbers inside a row), so a `case 'number'` here would be a
 * branch no caller can enter -- a guard that reads as safety while measuring nothing.
 */
function rowPasses(
  predicate: Exclude<SpecPredicate, { field: 'number' }>,
  row: LedgerRow,
): boolean {
  switch (predicate.field) {
    case 'text':
      return mentions(row.text, predicate.value);
    case 'role':
      return row.role === predicate.value;
    case 'session':
      return predicate.value.includes(row.session);
    case 'date': {
      // A row without a date cannot satisfy a date filter: `null` is not a date, and treating it as
      // "in range" would put undated turns into a window the question bounded.
      if (row.date === null) return false;
      return predicate.op === 'on-or-after'
        ? row.date >= predicate.value
        : row.date <= predicate.value;
    }
  }
}

/** The numbers of a row that survive the plan's numeric filters. */
function numbersOf(row: LedgerRow, numeric: readonly NumericPredicate[]): readonly number[] {
  return row.numbers
    .filter((number) =>
      numeric.every((predicate) => numberPasses(predicate, number.value, number.unit)),
    )
    .map((number) => number.value);
}

/** The units of a row's surviving numbers. */
function unitsOf(row: LedgerRow, numeric: readonly NumericPredicate[]): readonly (string | null)[] {
  return row.numbers
    .filter((number) =>
      numeric.every((predicate) => numberPasses(predicate, number.value, number.unit)),
    )
    .map((number) => number.unit);
}

/**
 * The sum, rounded to six decimals.
 *
 * The same rounding `tallyTotal` uses and for the same reason: `0.1 + 0.2` must not be rendered as
 * `0.30000000000000004`, and six decimals is finer than any currency or day count in the corpus and
 * coarser than the representation error.
 */
function round(sum: number): number {
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * Run a plan over a ledger.
 *
 * Numeric filters apply to the numbers *inside* a row, and a row survives only if a number survives
 * them; every other filter applies to the row. That split is what makes `sum` expressible at all in
 * a turn-grain ledger: "the dollars the user mentions between these steps" is a filter on numbers,
 * not on rows, and a plan that could not say it would have to sum every number in every matched row,
 * which is the "which quantity counts" mistake with a different name.
 */
export function executeSpec(ledger: Ledger, spec: EventSpec): AggregationResult {
  const [from, to] = spec.scope;
  const numeric = spec.predicates.filter(
    (predicate): predicate is NumericPredicate => predicate.field === 'number',
  );
  const structural = spec.predicates.filter(
    (predicate): predicate is Exclude<SpecPredicate, { field: 'number' }> =>
      predicate.field !== 'number',
  );

  const matched = ledger.rows.filter((row) => {
    if (row.step < from || row.step > to) return false;
    if (!structural.every((predicate) => rowPasses(predicate, row))) return false;
    if (numeric.length === 0) return true;
    return numbersOf(row, numeric).length > 0;
  });

  if (matched.length === 0) return { kind: 'empty', operation: spec.operation };

  const support = matched.map((row) => row.step);

  switch (spec.operation) {
    case 'count':
      return {
        kind: 'value',
        operation: 'count',
        value: support.length,
        support,
        unit: null,
        mixed: false,
      };
    case 'sum': {
      let total = 0;
      const units = new Set<string | null>();
      for (const row of matched) {
        for (const value of numbersOf(row, numeric)) total += value;
        for (const unit of unitsOf(row, numeric)) units.add(unit);
      }
      // A single shared unit is a fact about the sum; two is a plan error the renderer refuses.
      return {
        kind: 'value',
        operation: 'sum',
        value: round(total),
        support,
        unit: units.size === 1 ? [...units][0]! : null,
        mixed: units.size > 1,
      };
    }
    case 'list':
      return {
        kind: 'value',
        operation: 'list',
        value: matched.map((row) => row.text),
        support,
        unit: null,
        mixed: false,
      };
    // `matched` is in ledger order and the ledger numbers steps 0..n-1 in order, so the first and the
    // last selected row are the ends of the list. A `reduce` comparing steps would have one dead side
    // each -- the comparison can only ever answer the same way -- which is a branch that reads as
    // generality while measuring nothing.
    case 'first': {
      const row = matched[0] as LedgerRow;
      return {
        kind: 'value',
        operation: 'first',
        value: row.text,
        support: [row.step],
        unit: null,
        mixed: false,
      };
    }
    case 'last': {
      const row = matched[matched.length - 1] as LedgerRow;
      return {
        kind: 'value',
        operation: 'last',
        value: row.text,
        support: [row.step],
        unit: null,
        mixed: false,
      };
    }
    case 'group-count': {
      const counts: Record<string, number> = {};
      for (const row of matched) {
        const key = spec.groupBy === 'session' ? String(row.session) : row.role;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      // Sorted keys, because "the same input gives the same result" must hold for the object too and
      // insertion order is a function of row order that no caller promised to keep.
      const ordered: Record<string, number> = {};
      for (const key of Object.keys(counts).sort()) ordered[key] = counts[key] as number;
      return {
        kind: 'value',
        operation: 'group-count',
        value: ordered,
        support,
        unit: null,
        mixed: false,
      };
    }
  }
}

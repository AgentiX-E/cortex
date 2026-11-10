/**
 * The specification: a typed plan naming what to count, parsed with whole-refusal semantics.
 *
 * ## What the previous pass got wrong, in one distinction
 *
 * `tally` asked the reader for "the single bare number this item contributes to the answer" and got
 * ten wrong ledgers out of twenty failures, every one of them a wrong *quantity* rather than a wrong
 * sum. The instruction named the shape of the answer and never named the shape of the question, so
 * the reader had to invent, per line, which quantity the question was about. That invention is what
 * this file replaces: a plan is `scope` (which steps), `predicate` (which rows inside them) and
 * `operation` (what to compute), and each of the three is checked before it is executed.
 *
 * The distinction is TallyMem's (arXiv 2610.19474, §3) and it is the reason a wrong answer becomes
 * diagnosable: a plan that selects the wrong events still produces a plan, with its filters and its
 * supporting step ids, so the error is visible in the output rather than absent from it. The paper's
 * own residual-error analysis names misspecification as its largest remaining category, which is the
 * ceiling this arm is registered against rather than a surprise it can fail to find.
 *
 * ## Why every failure refuses instead of defaulting
 *
 * Because a default is a specification nobody wrote. `parseTallyLedger` refuses a *whole* ledger when
 * one line is untagged, for the same reason: a partial total is a smaller answer presented with a
 * complete answer's confidence. Here the same rule runs one level up. An unknown field, an operation
 * outside the six, a scope that ends past the last step, an empty predicate -- each returns a code
 * and the first pass's answer stands. The codes are enumerated rather than free text so a census can
 * count *why*, and "the reader wrote prose" can be told apart from "the reader's plan was unreadable"
 * and from "the reader's plan was out of the history's range".
 *
 * ## Why the predicate is a conjunction of field filters and nothing else
 *
 * Because a boolean algebra over events is a query language, and a query language that this package
 * cannot check is a language a model can use to express a wrong answer in a form nobody can inspect.
 * `text contains 'bake'` is checkable against a row; `(text contains 'bake' or 'cook') and not
 * (date before X)` is checkable too, and it is the *shape* that decides whether the executor's
 * agreement tests mean anything. Four filters in a conjunction is what the corpus's questions ask
 * for; a disjunction is a second increment with its own measurement.
 */

/** The fields a predicate may filter on. */
export const SPEC_FIELDS = ['text', 'role', 'session', 'date', 'number'] as const;

/** A field a predicate may filter on. */
type SpecField = (typeof SPEC_FIELDS)[number];

/** The operations a plan may ask for. */
export const SPEC_OPERATIONS = ['count', 'sum', 'list', 'first', 'last', 'group-count'] as const;

/** What a plan may compute once its rows are selected. */
type SpecOperation = (typeof SPEC_OPERATIONS)[number];

/** One filter: a field, an operator the field supports, and a value of the field's own type. */
export type SpecPredicate =
  | { readonly field: 'text'; readonly op: 'contains'; readonly value: string }
  | { readonly field: 'role'; readonly op: 'is'; readonly value: string }
  | { readonly field: 'session'; readonly op: 'in'; readonly value: readonly number[] }
  | { readonly field: 'date'; readonly op: 'on-or-after' | 'on-or-before'; readonly value: string }
  | { readonly field: 'number'; readonly op: 'unit-is'; readonly value: string }
  | { readonly field: 'number'; readonly op: 'at-least' | 'at-most'; readonly value: number };

/** Which operators each field accepts, which is what makes an unknown pair a refusal. */
const OPERATORS: Readonly<Record<SpecField, readonly string[]>> = {
  text: ['contains'],
  role: ['is'],
  session: ['in'],
  date: ['on-or-after', 'on-or-before'],
  number: ['unit-is', 'at-least', 'at-most'],
};

/**
 * A plan, or the reason the response is not one.
 *
 * The codes are the diagnostic value of a null. `unparsed` means the reader wrote prose where a plan
 * was asked for; `unknown-field` and `unknown-operation` mean it wrote a plan in a vocabulary this
 * executor does not have; `out-of-scope` and `empty-predicate` mean it wrote a plan that would have
 * computed something over a set it did not name. A single "refused" counter would collapse four
 * different findings into one number, which is the mistake `auditCensus` was already fixed for.
 */
export type ParsedSpec =
  | { readonly kind: 'spec'; readonly spec: EventSpec }
  | { readonly kind: 'refused'; readonly reason: SpecRefusalReason };

/** Why a plan was refused. */
type SpecRefusalReason =
  | 'unparsed'
  | 'empty-scope'
  | 'out-of-scope'
  | 'empty-predicate'
  | 'too-many-predicates'
  | 'unknown-field'
  | 'unknown-operation'
  | 'bad-predicate'
  | 'missing-group';

/** A plan the executor can run. */
export type EventSpec = {
  /** Inclusive step range, in the ledger's own numbering. */
  readonly scope: readonly [number, number];
  /** The conjunction of filters that selects rows inside the scope. */
  readonly predicates: readonly SpecPredicate[];
  /** What to compute over the selected rows. */
  readonly operation: SpecOperation;
  /** The field `group-count` groups by; absent for every other operation. */
  readonly groupBy?: 'role' | 'session';
};

/** How many filters a conjunction may carry before it stops being a specification. */
const MAX_PREDICATES = 4;

/** Read a JSON object out of a response that may have been wrapped in prose or a fence. */
function readObject(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether a value is a whole number that could be a step index. */
function isStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Read one filter, or say why it is not one. */
function readPredicate(entry: unknown): SpecPredicate | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const field = record['field'];
  const op = record['op'];
  const value = record['value'];
  if (typeof field !== 'string' || typeof op !== 'string') return null;
  if (!(SPEC_FIELDS as readonly string[]).includes(field)) return null;
  // Narrowed rather than re-checked, so the switch below is exhaustive over the five fields and needs
  // no `default`. A `default` here would be a branch no input can reach, because the membership test
  // above already refused every other field.
  const known = field as SpecField;
  const allowed = OPERATORS[known];
  if (!allowed.includes(op)) return null;

  switch (known) {
    case 'text':
      return typeof value === 'string' && value.length > 0
        ? { field: 'text', op: 'contains', value }
        : null;
    case 'role':
      return typeof value === 'string' && value.length > 0
        ? { field: 'role', op: 'is', value: value.toLowerCase() }
        : null;
    case 'session': {
      if (!Array.isArray(value) || value.length === 0) return null;
      if (!value.every((item) => isStep(item))) return null;
      return { field: 'session', op: 'in', value: value as number[] };
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return null;
      return op === 'on-or-after'
        ? { field: 'date', op: 'on-or-after', value }
        : { field: 'date', op: 'on-or-before', value };
    }
    case 'number': {
      if (op === 'unit-is') {
        return typeof value === 'string' && value.length > 0
          ? { field: 'number', op: 'unit-is', value: value.toLowerCase() }
          : null;
      }
      return typeof value === 'number' && Number.isFinite(value)
        ? op === 'at-least'
          ? { field: 'number', op: 'at-least', value }
          : { field: 'number', op: 'at-most', value }
        : null;
    }
  }
}

/**
 * Parse a plan out of a response.
 *
 * `steps` is the ledger's length and is the only thing the parse needs from the ledger: a scope is
 * validated against it, so a plan cannot silently compute over a history that does not exist.
 * `sessions` bounds a `session in` filter the same way.
 *
 * The order of the checks is the order a reader would want the errors in: is it a plan at all, is
 * its scope inside the history, does it name a set, does the set fit the conjunction, does each
 * filter type-check, is the operation one of the six.
 */
export function parseEventSpec(raw: string, steps: number, sessions: number): ParsedSpec {
  const record = readObject(raw);
  if (record === null) return { kind: 'refused', reason: 'unparsed' };

  const scopeRaw = record['scope'];
  if (!Array.isArray(scopeRaw) || scopeRaw.length !== 2)
    return { kind: 'refused', reason: 'empty-scope' };
  const [from, to] = scopeRaw as [unknown, unknown];
  if (!isStep(from) || !isStep(to)) return { kind: 'refused', reason: 'empty-scope' };
  if (from > to) return { kind: 'refused', reason: 'empty-scope' };
  if (steps === 0 || to >= steps) return { kind: 'refused', reason: 'out-of-scope' };

  const predicatesRaw = record['predicates'];
  if (!Array.isArray(predicatesRaw) || predicatesRaw.length === 0) {
    return { kind: 'refused', reason: 'empty-predicate' };
  }
  if (predicatesRaw.length > MAX_PREDICATES)
    return { kind: 'refused', reason: 'too-many-predicates' };

  const operationRaw = record['operation'];
  if (typeof operationRaw !== 'string') return { kind: 'refused', reason: 'unknown-operation' };
  if (!(SPEC_OPERATIONS as readonly string[]).includes(operationRaw)) {
    return { kind: 'refused', reason: 'unknown-operation' };
  }
  const operation = operationRaw as SpecOperation;

  const predicates: SpecPredicate[] = [];
  for (const entry of predicatesRaw) {
    const predicate = readPredicate(entry);
    if (predicate === null) {
      // A field this executor does not have is a different finding from a filter that has the
      // field but the wrong value type, and the census is what distinguishes them.
      const field = (entry as Record<string, unknown> | null)?.['field'];
      return {
        kind: 'refused',
        reason:
          typeof field === 'string' && !(SPEC_FIELDS as readonly string[]).includes(field)
            ? 'unknown-field'
            : 'bad-predicate',
      };
    }
    if (predicate.field === 'session' && predicate.value.some((session) => session >= sessions)) {
      return { kind: 'refused', reason: 'out-of-scope' };
    }
    predicates.push(predicate);
  }

  if (operation === 'group-count') {
    const groupBy = record['groupBy'];
    if (groupBy !== 'role' && groupBy !== 'session')
      return { kind: 'refused', reason: 'missing-group' };
    return { kind: 'spec', spec: { scope: [from, to], predicates, operation, groupBy } };
  }

  return { kind: 'spec', spec: { scope: [from, to], predicates, operation } };
}

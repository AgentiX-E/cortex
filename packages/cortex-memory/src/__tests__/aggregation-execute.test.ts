/**
 * The executor and the renderer: agreement with a reference, not agreement with itself.
 *
 * The design document's acceptance standard for this layer was a property test -- a thousand random
 * ledgers and random plans, compared against a hand-rolled "filter, then count" reference -- so that
 * is what the last block here does. The examples before it pin the semantics the reference encodes:
 * inclusive scope, numeric filters on the numbers inside a row rather than on the row, an undated row
 * failing a date filter, and `support` naming exactly the rows the value came from.
 */

import { describe, expect, it } from 'vitest';

import type { Ledger, LedgerRow } from '../aggregation/ledger.js';
import { executeSpec } from '../aggregation/execute.js';
import { renderAggregate } from '../aggregation/render.js';
import type { EventSpec, SpecPredicate } from '../aggregation/spec.js';

/** A row with only the fields a test cares about. */
function row(
  step: number,
  text: string,
  options: {
    role?: string;
    session?: number;
    date?: string | null;
    numbers?: LedgerRow['numbers'];
  } = {},
): LedgerRow {
  return {
    step,
    session: options.session ?? 0,
    date: options.date === undefined ? '2023/01/01' : options.date,
    role: options.role ?? 'user',
    text,
    numbers: options.numbers ?? [],
  };
}

const ledgerOf = (rows: LedgerRow[]): Ledger => ({ rows, steps: rows.length, sessions: 3 });

const LEDGER = ledgerOf([
  row(0, 'I baked sourdough on Tuesday.', { numbers: [] }),
  row(1, 'I sold the bike for $3,750.', { numbers: [{ value: 3750, unit: '$' }] }),
  row(2, 'Then I sold a helmet for $120.', { session: 1, numbers: [{ value: 120, unit: '$' }] }),
  row(3, 'I read 440 pages of one book and 416 pages of another.', {
    session: 1,
    numbers: [
      { value: 440, unit: 'pages' },
      { value: 416, unit: 'pages' },
    ],
  }),
  row(4, 'No date on this one, and it mentions baking.', { date: null }),
  row(5, 'The assistant replied about 3 loaves and 40 minutes.', {
    role: 'assistant',
    session: 2,
    numbers: [
      { value: 3, unit: 'loaves' },
      { value: 40, unit: 'minutes' },
    ],
  }),
]);

describe('the text predicate matches at a word start', () => {
  const count = (value: string) =>
    executeSpec(
      ledgerOf([
        row(0, 'I read three books.'),
        row(1, 'I baked bread with the starter.'),
        row(2, 'Already read; rereading anyway.'),
      ]),
      { scope: [0, 2], predicates: [{ field: 'text', op: 'contains', value }], operation: 'count' },
    );

  it('matches at the start of a word, so a stem reaches its inflections', () => {
    expect(count('read')).toMatchObject({ kind: 'value', value: 2, support: [0, 2] });
  });

  it('does not match inside a word, which is how `bread` became a reading turn', () => {
    const bread = executeSpec(ledgerOf([row(0, 'I baked bread with the starter.')]), {
      scope: [0, 0],
      predicates: [{ field: 'text', op: 'contains', value: 'read' }],
      operation: 'count',
    });
    expect(bread).toEqual({ kind: 'empty', operation: 'count' });
  });

  it('matches at the very start of a turn and after punctuation', () => {
    const start = executeSpec(ledgerOf([row(0, 'Baked it myself.')]), {
      scope: [0, 0],
      predicates: [{ field: 'text', op: 'contains', value: 'bake' }],
      operation: 'count',
    });
    expect(start).toMatchObject({ kind: 'value', value: 1 });
    const after = executeSpec(ledgerOf([row(0, 'Two things: baked and sold.')]), {
      scope: [0, 0],
      predicates: [{ field: 'text', op: 'contains', value: 'bake' }],
      operation: 'count',
    });
    expect(after).toMatchObject({ kind: 'value', value: 1 });
  });

  it('does not reach an inflection that drops the final e, and that is a stated limit', () => {
    // `bake` is not a prefix of `baking`, whose stem is `bak`. The keyword list carries both forms when
    // the question supplies them; a prefix rule cannot invent the pair, and pretending otherwise would
    // be a docstring promising a recall the predicate does not have.
    const result = executeSpec(ledgerOf([row(0, 'Baking happened.')]), {
      scope: [0, 0],
      predicates: [{ field: 'text', op: 'contains', value: 'bake' }],
      operation: 'count',
    });
    expect(result).toEqual({ kind: 'empty', operation: 'count' });
  });

  it('keeps searching after a rejected interior match', () => {
    // The first occurrence is inside `bread` and the second is a word of its own; a predicate that
    // gave up on the first interior match would miss the real one.
    const result = executeSpec(ledgerOf([row(0, 'bread, then read.')]), {
      scope: [0, 0],
      predicates: [{ field: 'text', op: 'contains', value: 'read' }],
      operation: 'count',
    });
    expect(result).toMatchObject({ kind: 'value', value: 1, support: [0] });
  });

  it('refuses an empty keyword rather than matching everything', () => {
    const result = executeSpec(ledgerOf([row(0, 'anything at all')]), {
      scope: [0, 0],
      predicates: [{ field: 'text', op: 'contains', value: '' }],
      operation: 'count',
    });
    expect(result).toEqual({ kind: 'empty', operation: 'count' });
  });
});

describe('executeSpec', () => {
  it('counts the rows a text filter selects, with an inclusive scope', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 4],
      predicates: [{ field: 'text', op: 'contains', value: 'bake' }],
      operation: 'count',
    });
    // `baking` does not contain `bake`, and the ledger's substring filter is literal for that
    // reason: a stemmed match would put a row inside a scope the plan did not name.
    expect(result).toEqual({
      kind: 'value',
      operation: 'count',
      value: 1,
      support: [0],
      unit: null,
      mixed: false,
    });
  });

  it('matches text case-insensitively on both sides', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'text', op: 'contains', value: 'SOURDOUGH' }],
      operation: 'count',
    });
    expect(result).toMatchObject({ kind: 'value', value: 1, support: [0] });
  });

  it('filters on the speaker', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'role', op: 'is', value: 'assistant' }],
      operation: 'count',
    });
    expect(result).toMatchObject({ kind: 'value', value: 1, support: [5] });
  });

  it('filters on the session list', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'session', op: 'in', value: [1] }],
      operation: 'count',
    });
    expect(result).toMatchObject({ kind: 'value', value: 2, support: [2, 3] });
  });

  it('treats a date filter as a closed interval and excludes an undated row', () => {
    const after = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'date', op: 'on-or-after', value: '2023/01/01' }],
      operation: 'count',
    });
    expect(after).toMatchObject({ kind: 'value', value: 5, support: [0, 1, 2, 3, 5] });
    const before = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'date', op: 'on-or-before', value: '2023/01/01' }],
      operation: 'count',
    });
    expect(before).toMatchObject({ kind: 'value', value: 5 });
  });

  it('sums only the numbers whose unit the plan named', () => {
    const dollars = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'number', op: 'unit-is', value: '$' }],
      operation: 'sum',
    });
    expect(dollars).toEqual({
      kind: 'value',
      operation: 'sum',
      value: 3870,
      support: [1, 2],
      unit: '$',
      mixed: false,
    });
    const pages = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'number', op: 'unit-is', value: 'pages' }],
      operation: 'sum',
    });
    expect(pages).toMatchObject({ kind: 'value', value: 856, support: [3], unit: 'pages' });
  });

  it('sums every number in a row when the plan names no unit, and reports the disagreement', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'text', op: 'contains', value: 'bike' }],
      operation: 'sum',
    });
    expect(result).toMatchObject({ kind: 'value', value: 3750, unit: '$', mixed: false });

    const mixed = executeSpec(LEDGER, {
      scope: [5, 5],
      predicates: [{ field: 'role', op: 'is', value: 'assistant' }],
      operation: 'sum',
    });
    expect(mixed).toMatchObject({ kind: 'value', value: 43, unit: null, mixed: true });
  });

  it('narrows numbers with a bound as well as a unit', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [
        { field: 'number', op: 'unit-is', value: '$' },
        { field: 'number', op: 'at-least', value: 1000 },
      ],
      operation: 'sum',
    });
    expect(result).toMatchObject({ kind: 'value', value: 3750, support: [1] });
    const upper = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [
        { field: 'number', op: 'unit-is', value: '$' },
        { field: 'number', op: 'at-most', value: 1000 },
      ],
      operation: 'sum',
    });
    expect(upper).toMatchObject({ kind: 'value', value: 120, support: [2] });
  });

  it('lists the matched rows and takes the first and the last of them', () => {
    const plan = {
      scope: [0, 5] as const,
      predicates: [{ field: 'text', op: 'contains', value: 'sold' }] as const,
    };
    expect(
      executeSpec(LEDGER, { ...plan, predicates: [...plan.predicates], operation: 'list' }),
    ).toMatchObject({
      kind: 'value',
      value: ['I sold the bike for $3,750.', 'Then I sold a helmet for $120.'],
      support: [1, 2],
    });
    expect(
      executeSpec(LEDGER, { ...plan, predicates: [...plan.predicates], operation: 'first' }),
    ).toMatchObject({
      kind: 'value',
      value: 'I sold the bike for $3,750.',
      support: [1],
    });
    expect(
      executeSpec(LEDGER, { ...plan, predicates: [...plan.predicates], operation: 'last' }),
    ).toMatchObject({
      kind: 'value',
      value: 'Then I sold a helmet for $120.',
      support: [2],
    });
  });

  it('groups by speaker and by session, with sorted keys', () => {
    const byRole = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'text', op: 'contains', value: 'I ' }],
      operation: 'group-count',
      groupBy: 'role',
    });
    expect(byRole).toMatchObject({ kind: 'value', value: { user: 4 } });

    const bySession = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'text', op: 'contains', value: 'I ' }],
      operation: 'group-count',
      groupBy: 'session',
    });
    expect(bySession).toMatchObject({ kind: 'value', value: { '0': 2, '1': 2 } });
  });

  it('returns empty rather than zero when nothing matches', () => {
    for (const operation of ['count', 'sum', 'list', 'first', 'last', 'group-count'] as const) {
      const result = executeSpec(LEDGER, {
        scope: [0, 5],
        predicates: [{ field: 'text', op: 'contains', value: 'nothing here says this' }],
        operation,
        ...(operation === 'group-count' ? { groupBy: 'role' as const } : {}),
      });
      expect(result, operation).toEqual({ kind: 'empty', operation });
    }
  });

  it('never returns a value outside the scope it was given', () => {
    const result = executeSpec(LEDGER, {
      scope: [2, 3],
      predicates: [{ field: 'role', op: 'is', value: 'user' }],
      operation: 'count',
    });
    expect(result).toMatchObject({ kind: 'value', value: 2, support: [2, 3] });
  });

  it('is deterministic over repeated calls', () => {
    const spec: EventSpec = {
      scope: [0, 5],
      predicates: [{ field: 'text', op: 'contains', value: 'a' }],
      operation: 'group-count',
      groupBy: 'session',
    };
    const first = JSON.stringify(executeSpec(LEDGER, spec));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(JSON.stringify(executeSpec(LEDGER, spec))).toBe(first);
    }
  });
});

describe('renderAggregate', () => {
  const spec = (operation: EventSpec['operation'], groupBy?: 'role' | 'session'): EventSpec => ({
    scope: [0, 5],
    predicates: [{ field: 'role', op: 'is', value: 'user' }],
    operation,
    ...(groupBy === undefined ? {} : { groupBy }),
  });

  it('renders a count as a bare integer', () => {
    expect(renderAggregate(executeSpec(LEDGER, spec('count')))).toBe('5');
  });

  it('renders a sum of currency with its symbol', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'number', op: 'unit-is', value: '$' }],
      operation: 'sum',
    });
    expect(renderAggregate(result)).toBe('$3870');
  });

  it('renders a sum of a non-currency unit as the bare number', () => {
    const result = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'number', op: 'unit-is', value: 'pages' }],
      operation: 'sum',
    });
    expect(renderAggregate(result)).toBe('856');
  });

  it('refuses a sum whose numbers disagreed about their unit', () => {
    const result = executeSpec(LEDGER, {
      scope: [5, 5],
      predicates: [{ field: 'role', op: 'is', value: 'assistant' }],
      operation: 'sum',
    });
    expect(renderAggregate(result)).toBeNull();
  });

  it('refuses to render anything that is not a count or a sum', () => {
    expect(renderAggregate(executeSpec(LEDGER, spec('list')))).toBeNull();
    expect(renderAggregate(executeSpec(LEDGER, spec('first')))).toBeNull();
    expect(renderAggregate(executeSpec(LEDGER, spec('last')))).toBeNull();
    expect(renderAggregate(executeSpec(LEDGER, spec('group-count', 'role')))).toBeNull();
  });

  it('refuses to render an empty selection', () => {
    const empty = executeSpec(LEDGER, {
      scope: [0, 5],
      predicates: [{ field: 'text', op: 'contains', value: 'absent phrase' }],
      operation: 'count',
    });
    expect(renderAggregate(empty)).toBeNull();
  });
});

describe('agreement with a hand-rolled reference', () => {
  /** A deterministic generator, so a failure is reproducible from its seed alone. */
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  const WORDS = ['bake', 'sold', 'read', 'plant', 'run', 'book', 'cake'];
  const ROLES = ['user', 'assistant'];
  const UNITS = ['$', 'pages', 'hours', null];

  function randomLedger(next: () => number): Ledger {
    const count = 1 + Math.floor(next() * 12);
    const rows: LedgerRow[] = [];
    for (let step = 0; step < count; step += 1) {
      const words = [
        WORDS[Math.floor(next() * WORDS.length)]!,
        WORDS[Math.floor(next() * WORDS.length)]!,
      ];
      const numbers =
        next() < 0.6
          ? [{ value: Math.floor(next() * 100), unit: UNITS[Math.floor(next() * UNITS.length)]! }]
          : [];
      rows.push({
        step,
        session: Math.floor(next() * 3),
        date: next() < 0.8 ? `2023/0${1 + Math.floor(next() * 9)}/01` : null,
        role: ROLES[Math.floor(next() * ROLES.length)]!,
        text: words.join(' '),
        numbers,
      });
    }
    return { rows, steps: rows.length, sessions: 3 };
  }

  function randomSpec(next: () => number, steps: number): EventSpec {
    const from = Math.floor(next() * steps);
    const to = from + Math.floor(next() * (steps - from));
    const predicates: SpecPredicate[] = [];
    if (next() < 0.7) {
      predicates.push({
        field: 'text',
        op: 'contains',
        value: WORDS[Math.floor(next() * WORDS.length)]!,
      });
    }
    if (next() < 0.5)
      predicates.push({ field: 'role', op: 'is', value: ROLES[Math.floor(next() * 2)]! });
    if (next() < 0.3)
      predicates.push({ field: 'session', op: 'in', value: [Math.floor(next() * 3)] });
    if (next() < 0.3) {
      predicates.push({
        field: 'date',
        op: 'on-or-after',
        value: `2023/0${1 + Math.floor(next() * 9)}/01`,
      });
    }
    const numeric = next() < 0.4;
    if (numeric)
      predicates.push({ field: 'number', op: 'at-least', value: Math.floor(next() * 60) });
    if (predicates.length === 0) predicates.push({ field: 'role', op: 'is', value: 'user' });
    return { scope: [from, to], predicates, operation: 'count' };
  }

  /** The reference: explicit loops over explicit comparisons, sharing no code with the executor. */
  function referenceCount(ledger: Ledger, spec: EventSpec): number {
    let total = 0;
    for (const candidate of ledger.rows) {
      if (candidate.step < spec.scope[0] || candidate.step > spec.scope[1]) continue;
      let keep = true;
      let numericFloor: number | null = null;
      for (const predicate of spec.predicates) {
        if (predicate.field === 'text') {
          if (!candidate.text.toLowerCase().includes(predicate.value.toLowerCase())) keep = false;
        } else if (predicate.field === 'role') {
          if (candidate.role !== predicate.value) keep = false;
        } else if (predicate.field === 'session') {
          if (!predicate.value.includes(candidate.session)) keep = false;
        } else if (predicate.field === 'date') {
          if (candidate.date === null) keep = false;
          else if (candidate.date < predicate.value) keep = false;
        } else if (predicate.op === 'at-least') {
          numericFloor = predicate.value;
        }
      }
      if (!keep) continue;
      if (numericFloor !== null) {
        let any = false;
        for (const number of candidate.numbers) if (number.value >= numericFloor) any = true;
        if (!any) continue;
      }
      total += 1;
    }
    return total;
  }

  it('agrees over a thousand random ledgers and plans', () => {
    const next = generator(20_261_110);
    for (let trial = 0; trial < 1_000; trial += 1) {
      const ledger = randomLedger(next);
      const spec = randomSpec(next, ledger.steps);
      const result = executeSpec(ledger, spec);
      const expected = referenceCount(ledger, spec);
      const actual = result.kind === 'empty' ? 0 : result.value;
      expect(actual, `trial ${trial}: ${JSON.stringify(spec)}`).toBe(expected);
      if (result.kind === 'value') expect(result.support).toHaveLength(expected);
    }
  });
});

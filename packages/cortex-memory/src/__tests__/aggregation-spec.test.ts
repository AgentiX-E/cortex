/**
 * The parser: two outcomes and nine refusal codes, and the codes are the point.
 *
 * A single "refused" counter would collapse four different findings -- prose where a plan was asked
 * for, a plan in an unknown vocabulary, a plan whose scope runs past the history, and a plan that
 * names no set -- into one number. The last pass was already fixed once for exactly this
 * (`auditCensus` grew a `refused` field so "the pass changed nothing" and "the pass could not run"
 * stopped reading the same), so this file's tests are mostly about which code comes back.
 */

import { describe, expect, it } from 'vitest';

import { parseEventSpec, SPEC_FIELDS, SPEC_OPERATIONS } from '../aggregation/spec.js';

/** Ten steps in three sessions, which is the smallest history that can hold an out-of-range plan. */
const STEPS = 10;
const SESSIONS = 3;

const parse = (plan: unknown) => parseEventSpec(JSON.stringify(plan), STEPS, SESSIONS);

describe('a plan that parses', () => {
  it('reads a scope, one filter and an operation', () => {
    const parsed = parse({
      scope: [0, 9],
      predicates: [{ field: 'text', op: 'contains', value: 'bake' }],
      operation: 'count',
    });
    expect(parsed).toEqual({
      kind: 'spec',
      spec: {
        scope: [0, 9],
        predicates: [{ field: 'text', op: 'contains', value: 'bake' }],
        operation: 'count',
      },
    });
  });

  it('accepts every operation the executor has', () => {
    for (const operation of SPEC_OPERATIONS) {
      const plan =
        operation === 'group-count'
          ? {
              scope: [0, 9],
              predicates: [{ field: 'role', op: 'is', value: 'user' }],
              operation,
              groupBy: 'role',
            }
          : { scope: [0, 9], predicates: [{ field: 'role', op: 'is', value: 'user' }], operation };
      expect(parse(plan).kind).toBe('spec');
    }
  });

  it('accepts every field the ledger has', () => {
    const byField: Record<string, unknown> = {
      text: { field: 'text', op: 'contains', value: 'x' },
      role: { field: 'role', op: 'is', value: 'user' },
      session: { field: 'session', op: 'in', value: [0, 2] },
      date: { field: 'date', op: 'on-or-after', value: '2023/01/01' },
      number: { field: 'number', op: 'at-least', value: 100 },
    };
    for (const field of SPEC_FIELDS) {
      const parsed = parse({ scope: [0, 9], predicates: [byField[field]], operation: 'count' });
      expect(parsed.kind, field).toBe('spec');
    }
  });

  it('reads a plan out of a fenced block and out of prose around it', () => {
    const plan =
      '{"scope":[0,9],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}';
    expect(parseEventSpec('```json\n' + plan + '\n```', STEPS, SESSIONS).kind).toBe('spec');
    expect(parseEventSpec('Here is the plan: ' + plan + ' — done.', STEPS, SESSIONS).kind).toBe(
      'spec',
    );
    expect(parseEventSpec('```\n' + plan + '\n```', STEPS, SESSIONS).kind).toBe('spec');
  });

  it('lowercases a speaker and a unit, because the ledger stores them lowercased', () => {
    const parsed = parse({
      scope: [0, 9],
      predicates: [
        { field: 'role', op: 'is', value: 'User' },
        { field: 'number', op: 'unit-is', value: 'Pages' },
      ],
      operation: 'count',
    });
    expect(parsed).toMatchObject({
      kind: 'spec',
      spec: { predicates: [{ value: 'user' }, { value: 'pages' }] },
    });
  });

  it('keeps a one-step scope and a full-history scope', () => {
    expect(
      parse({
        scope: [4, 4],
        predicates: [{ field: 'role', op: 'is', value: 'user' }],
        operation: 'count',
      }).kind,
    ).toBe('spec');
    expect(
      parse({
        scope: [0, 9],
        predicates: [{ field: 'role', op: 'is', value: 'user' }],
        operation: 'count',
      }).kind,
    ).toBe('spec');
  });

  it('accepts a conjunction of four filters and refuses a fifth', () => {
    const four = [
      { field: 'text', op: 'contains', value: 'a' },
      { field: 'role', op: 'is', value: 'user' },
      { field: 'session', op: 'in', value: [0] },
      { field: 'date', op: 'on-or-before', value: '2023/12/31' },
    ];
    expect(parse({ scope: [0, 9], predicates: four, operation: 'count' }).kind).toBe('spec');
    expect(parse({ scope: [0, 9], predicates: [...four, four[0]], operation: 'count' })).toEqual({
      kind: 'refused',
      reason: 'too-many-predicates',
    });
  });

  it('accepts both date operators', () => {
    for (const op of ['on-or-after', 'on-or-before'] as const) {
      const parsed = parse({
        scope: [0, 9],
        predicates: [{ field: 'date', op, value: '2023/01/01' }],
        operation: 'count',
      });
      expect(parsed).toMatchObject({ kind: 'spec', spec: { predicates: [{ op }] } });
    }
  });

  it('accepts both numeric comparison operators', () => {
    for (const op of ['at-least', 'at-most'] as const) {
      const parsed = parse({
        scope: [0, 9],
        predicates: [{ field: 'number', op, value: 3 }],
        operation: 'sum',
      });
      expect(parsed).toMatchObject({ kind: 'spec', spec: { predicates: [{ op, value: 3 }] } });
    }
  });

  it('accepts a group-count grouped by session', () => {
    const parsed = parse({
      scope: [0, 9],
      predicates: [{ field: 'number', op: 'unit-is', value: '$' }],
      operation: 'group-count',
      groupBy: 'session',
    });
    expect(parsed).toMatchObject({
      kind: 'spec',
      spec: { operation: 'group-count', groupBy: 'session' },
    });
  });
});

describe('the refusals, one code each', () => {
  const refused = (raw: string) => {
    const parsed = parseEventSpec(raw, STEPS, SESSIONS);
    return parsed.kind === 'refused' ? parsed.reason : 'parsed';
  };

  it('refuses prose with no object in it', () => {
    expect(refused('I could not find the answer.')).toBe('unparsed');
    expect(refused('{"scope": [0, 9], "predicates": [], "operation": "count"')).toBe('unparsed');
    expect(refused('')).toBe('unparsed');
  });

  it('refuses text that has braces but is not JSON', () => {
    // The brace scan finds a candidate and `JSON.parse` rejects it, which is a different path from
    // "there is no object here at all" and has to be refused the same way.
    expect(refused('{"scope": [0, 9], "predicates": [}, "operation": "count"}')).toBe('unparsed');
  });

  it('refuses a closing brace that comes before the opening one', () => {
    expect(refused('} not a plan {')).toBe('unparsed');
  });

  it('refuses a filter whose field or operator is not a string', () => {
    for (const predicate of [
      { field: 7, op: 'contains', value: 'a' },
      { field: 'text', op: 7, value: 'a' },
      { op: 'contains', value: 'a' },
    ]) {
      expect(
        refused(JSON.stringify({ scope: [0, 9], predicates: [predicate], operation: 'count' })),
        JSON.stringify(predicate),
      ).toBe('bad-predicate');
    }
  });

  it('refuses a JSON array or scalar where an object was asked for', () => {
    expect(refused('[1, 2, 3]')).toBe('unparsed');
    expect(refused('"count"')).toBe('unparsed');
    expect(refused('null')).toBe('unparsed');
  });

  it('refuses a scope that is not two integers in order', () => {
    expect(
      refused('{"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}'),
    ).toBe('empty-scope');
    expect(
      refused(
        '{"scope":[0],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}',
      ),
    ).toBe('empty-scope');
    expect(
      refused(
        '{"scope":["0",9],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}',
      ),
    ).toBe('empty-scope');
    expect(
      refused(
        '{"scope":[0,9.5],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}',
      ),
    ).toBe('empty-scope');
    expect(
      refused(
        '{"scope":[-1,9],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}',
      ),
    ).toBe('empty-scope');
    expect(
      refused(
        '{"scope":[5,4],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}',
      ),
    ).toBe('empty-scope');
  });

  it('refuses a scope that runs past the history', () => {
    expect(
      refused(
        '{"scope":[0,10],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"count"}',
      ),
    ).toBe('out-of-scope');
  });

  it('refuses any plan at all against an empty history', () => {
    const parsed = parseEventSpec(
      JSON.stringify({
        scope: [0, 0],
        predicates: [{ field: 'text', op: 'contains', value: 'a' }],
        operation: 'count',
      }),
      0,
      0,
    );
    expect(parsed).toEqual({ kind: 'refused', reason: 'out-of-scope' });
  });

  it('refuses a session index the history does not have', () => {
    expect(
      refused(
        '{"scope":[0,9],"predicates":[{"field":"session","op":"in","value":[3]}],"operation":"count"}',
      ),
    ).toBe('out-of-scope');
  });

  it('refuses a plan that names no set', () => {
    expect(refused('{"scope":[0,9],"operation":"count"}')).toBe('empty-predicate');
    expect(refused('{"scope":[0,9],"predicates":[],"operation":"count"}')).toBe('empty-predicate');
  });

  it('refuses an operation outside the six, and one that is missing', () => {
    expect(
      refused(
        '{"scope":[0,9],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":"median"}',
      ),
    ).toBe('unknown-operation');
    expect(
      refused('{"scope":[0,9],"predicates":[{"field":"text","op":"contains","value":"a"}]}'),
    ).toBe('unknown-operation');
    expect(
      refused(
        '{"scope":[0,9],"predicates":[{"field":"text","op":"contains","value":"a"}],"operation":7}',
      ),
    ).toBe('unknown-operation');
  });

  it('distinguishes a field it does not have from a filter with a bad value', () => {
    expect(
      refused(
        '{"scope":[0,9],"predicates":[{"field":"topic","op":"contains","value":"a"}],"operation":"count"}',
      ),
    ).toBe('unknown-field');
    for (const predicate of [
      { field: 'text', op: 'contains', value: '' },
      { field: 'text', op: 'matches', value: 'a' },
      { field: 'text', op: 'contains' },
      { field: 'role', op: 'is', value: 7 },
      { field: 'role', op: 'is', value: '' },
      { field: 'session', op: 'in', value: [] },
      { field: 'session', op: 'in', value: ['0'] },
      { field: 'session', op: 'in', value: [1.5] },
      { field: 'date', op: 'on-or-after', value: '2023-01-01' },
      { field: 'date', op: 'on-or-after', value: 3 },
      { field: 'number', op: 'unit-is', value: '' },
      { field: 'number', op: 'at-least', value: '100' },
      { field: 'number', op: 'at-least', value: Number.POSITIVE_INFINITY },
      { field: 'number', op: 'roughly', value: 1 },
    ]) {
      expect(
        refused(JSON.stringify({ scope: [0, 9], predicates: [predicate], operation: 'count' })),
        JSON.stringify(predicate),
      ).toBe('bad-predicate');
    }
  });

  it('refuses a predicate that is not an object at all', () => {
    expect(refused('{"scope":[0,9],"predicates":["text contains a"],"operation":"count"}')).toBe(
      'bad-predicate',
    );
    expect(refused('{"scope":[0,9],"predicates":[[1,2]],"operation":"count"}')).toBe(
      'bad-predicate',
    );
    expect(refused('{"scope":[0,9],"predicates":[null],"operation":"count"}')).toBe(
      'bad-predicate',
    );
  });

  it('refuses a group-count that does not say what to group by', () => {
    expect(
      refused(
        '{"scope":[0,9],"predicates":[{"field":"role","op":"is","value":"user"}],"operation":"group-count"}',
      ),
    ).toBe('missing-group');
    expect(
      refused(
        '{"scope":[0,9],"predicates":[{"field":"role","op":"is","value":"user"}],"operation":"group-count","groupBy":"date"}',
      ),
    ).toBe('missing-group');
  });
});

/**
 * The SQL vocabulary: statements, the two helpers whose order matters, and the prefix predicate.
 *
 * These are unit tests of pure functions, and they exist because every one of the behaviours below
 * was a *decision* rather than a transcription. A prefix filter implemented with `LIKE` passes
 * every test written from the outside, so the test has to be written from the side: a prefix
 * containing `_`, a prefix that differs only in case.
 */
import { describe, expect, it } from 'vitest';
import {
  KV_PUT,
  kvPutParams,
  kvQuery,
  matchesAllTags,
  parseTags,
  selectPage,
  type KvRow,
} from '../storage/sql.js';

describe('kvPutParams', () => {
  it('stores the tags as JSON and no expiry when no options are given', () => {
    expect(kvPutParams('t', 'k', { a: 1 }, undefined, 1_000)).toEqual([
      't',
      'k',
      '{"a":1}',
      '[]',
      null,
    ]);
  });

  it('turns a ttl into an absolute deadline from the supplied clock', () => {
    // The clock is a parameter so this assertion is arithmetic rather than a race with a timer.
    expect(kvPutParams('t', 'k', 1, { ttlMs: 500 }, 1_000)[4]).toBe(1_500);
  });

  it('keeps a zero ttl, which expires immediately rather than meaning "no expiry"', () => {
    // `ttlMs: 0` is the value a caller reaches for when it wants the row gone by the time the call
    // returns. Treating falsy as absent would silently make it permanent.
    expect(kvPutParams('t', 'k', 1, { ttlMs: 0 }, 1_000)[4]).toBe(1_000);
  });

  it('serialises the tag list', () => {
    expect(kvPutParams('t', 'k', 1, { tags: ['x', 'y'] }, 0)[3]).toBe('["x","y"]');
  });

  it('names both conflict columns, because a single-column target throws on rewrite', () => {
    expect(KV_PUT).toContain('ON CONFLICT(table_name, key)');
  });
});

describe('kvQuery', () => {
  it('binds the table and nothing else when there is no prefix', () => {
    expect(kvQuery('facts', {})).toEqual({
      sql: 'SELECT value, tags FROM kv WHERE table_name = ?',
      params: ['facts'],
    });
  });

  it('adds length and value for a prefix, never making the prefix a pattern', () => {
    const { sql, params } = kvQuery('facts', { keyPrefix: 'a_b' });
    expect(sql).toContain('substr(key, 1, ?) = ?');
    expect(sql).not.toContain('LIKE');
    expect(params).toEqual(['facts', 3, 'a_b']);
  });

  it('ignores an empty prefix rather than matching everything explicitly', () => {
    expect(kvQuery('facts', { keyPrefix: '' }).sql).not.toContain('substr');
  });
});

describe('matchesAllTags', () => {
  it('treats an absent filter as no filter', () => {
    expect(matchesAllTags(['a'], undefined)).toBe(true);
    expect(matchesAllTags(['a'], [])).toBe(true);
  });

  it('requires every requested tag', () => {
    expect(matchesAllTags(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(matchesAllTags(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('selectPage', () => {
  const rows: KvRow[] = [
    { value: '{"n":1}', tags: '["a"]' },
    { value: '{"n":2}', tags: '["b"]' },
    { value: '{"n":3}', tags: '["a"]' },
    { value: '{"n":4}', tags: '["a","b"]' },
  ];

  it('filters on tags before paginating', () => {
    // The assertion that distinguishes the two orders. Filtered first, the `["a"]` rows are 1, 3, 4
    // and `limit: 2, offset: 1` is [3, 4]. Paged first, the window would be rows 2, 3 and the
    // answer would be [3] -- fewer rows than asked for, and wrong.
    expect(selectPage<{ n: number }>(rows, { tags: ['a'], limit: 2, offset: 1 })).toEqual([
      { n: 3 },
      { n: 4 },
    ]);
  });

  it('returns everything when the predicate is empty', () => {
    expect(selectPage<{ n: number }>(rows, {})).toHaveLength(4);
  });

  it('treats a limit of zero as zero rows and not as "unlimited"', () => {
    expect(selectPage(rows, { limit: 0 })).toEqual([]);
  });

  it('returns an empty page past the end', () => {
    expect(selectPage(rows, { offset: 99 })).toEqual([]);
  });
});

describe('parseTags', () => {
  it('reads a stored tag array', () => {
    expect(parseTags('["a","b"]')).toEqual(['a', 'b']);
  });

  it('refuses a payload that is not an array', () => {
    expect(() => parseTags('{"a":1}')).toThrow(TypeError);
  });

  it('refuses an array holding something other than strings', () => {
    // Otherwise a numeric tag would be compared against a string filter and simply never match,
    // which is a row the tag index cannot find rather than a corrupt row being reported.
    expect(() => parseTags('[1,2]')).toThrow(TypeError);
  });
});

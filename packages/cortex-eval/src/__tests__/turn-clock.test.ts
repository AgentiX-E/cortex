import { describe, expect, it } from 'vitest';
import {
  deliveredWindow,
  partitionByWindow,
  readTurnStamp,
  readTurnClocks,
} from '../turn-clock.js';

/**
 * The reader is asserted through the four things a caller can observe: one turn's stamp,
 * a list's census, a list's partition, and a list's span. Every refusal is named, because
 * §13.151.5's first criterion is that an unreadable turn is *reported* rather than ranked
 * last -- a branch that silently folds into "undated" would satisfy the type and fail the
 * criterion.
 *
 * The stamps are the shapes the control run's artifact actually carries
 * (`[2023/05/20 (Sat) 03:51] user: ...`), plus the neighbouring shapes a renderer change
 * would produce. A test that used invented stamps would pass while the arm's own format
 * went unread.
 */

/** One delivered turn as the arm renders it: prefix, role, content. */
function turn(prefix: string, content = 'their content'): string {
  return `${prefix} user: ${content}`;
}

/** The date a turn reads as, or the string `'refused'` so a failure names itself. */
function dateOf(t: string): string {
  return readTurnStamp(t)?.date ?? 'refused';
}

describe('readTurnStamp', () => {
  it('reads the date, the weekday and the minute of a full stamp', () => {
    const stamp = readTurnStamp(turn('[2023/02/15 (Wed) 01:41]'));
    // `toStrictEqual` on the whole object, not on three fields: the reader's contract is that it
    // returns these three keys and no fourth, so an extra field is a failure rather than a detail.
    expect(stamp).toStrictEqual({
      date: '2023/02/15',
      weekday: 'Wed',
      minuteOfDay: 1 * 60 + 41,
    });
  });

  it('reads a stamp whose prefix is followed immediately by the role', () => {
    expect(readTurnStamp('[2023/05/20 (Sat) 03:51] assistant: ok')).toStrictEqual({
      date: '2023/05/20',
      weekday: 'Sat',
      minuteOfDay: 3 * 60 + 51,
    });
  });

  it('accepts a date-only prefix, which is the other rendering this package emits', () => {
    expect(readTurnStamp(turn('[2023/02/15]'))).toStrictEqual({
      date: '2023/02/15',
      weekday: undefined,
      minuteOfDay: undefined,
    });
  });

  it('accepts a date-and-time prefix that carries no weekday', () => {
    expect(readTurnStamp(turn('[2023/02/15 23:59]'))).toStrictEqual({
      date: '2023/02/15',
      weekday: undefined,
      minuteOfDay: 23 * 60 + 59,
    });
  });

  it('refuses a weekday label that disagrees with the date it is written beside', () => {
    // 2023/02/15 is a Wednesday; a `Thu` beside it means the renderer moved one of the
    // two, and the reorder would then move the wrong turns.
    expect(readTurnStamp(turn('[2023/02/15 (Thu) 01:41]'))).toBeUndefined();
  });

  it('refuses a weekday label that is not one of the seven', () => {
    expect(readTurnStamp(turn('[2023/02/15 (Xyz) 01:41]'))).toBeUndefined();
  });

  it('refuses a month outside 01-12 rather than letting the calendar roll it over', () => {
    // `Date.UTC(2023, 0, 10)` is a real day in January 2023; without the explicit bound
    // the day would be accepted as December 2022 and the turn would land in the wrong
    // window -- a silent answer, which is the failure mode this reader exists to remove.
    expect(readTurnStamp(turn('[2023/00/10 (Tue) 01:41]'))).toBeUndefined();
    expect(readTurnStamp(turn('[2023/13/10 (Tue) 01:41]'))).toBeUndefined();
  });

  it('refuses a day outside the month, including a non-leap 29 February', () => {
    expect(readTurnStamp(turn('[2023/02/30 (Thu) 01:41]'))).toBeUndefined();
    expect(readTurnStamp(turn('[2023/02/00 (Wed) 01:41]'))).toBeUndefined();
    expect(readTurnStamp(turn('[2023/04/31 (Mon) 01:41]'))).toBeUndefined();
  });

  it('accepts 29 February in a leap year, which is the case the bound must not over-refuse', () => {
    expect(readTurnStamp(turn('[2024/02/29 (Thu) 01:41]'))?.date).toBe('2024/02/29');
  });

  it('refuses a year of 0000, which no turn in this corpus can carry', () => {
    expect(readTurnStamp(turn('[0000/01/01 (Sat) 01:41]'))).toBeUndefined();
  });

  it('refuses an hour or minute outside the clock', () => {
    expect(readTurnStamp(turn('[2023/02/15 (Wed) 24:00]'))).toBeUndefined();
    expect(readTurnStamp(turn('[2023/02/15 (Wed) 23:60]'))).toBeUndefined();
  });

  it('refuses a prefix with no date in it, such as an empty bracket', () => {
    expect(readTurnStamp('[] user: their content')).toBeUndefined();
  });

  it('refuses a truncated turn that never closes its bracket', () => {
    expect(readTurnStamp('[2023/02/15 (Wed) 01:41 user: their content')).toBeUndefined();
  });

  it('refuses an undated turn, which is the shape a non-matching rendering produces', () => {
    expect(readTurnStamp('user: their content')).toBeUndefined();
  });

  it('reads the prefix, not a stamp quoted inside the content', () => {
    // The assistant repeating the user's date back is common in this corpus, and an
    // unanchored pattern would read the quoted date as the turn's own -- which would move
    // the reciting turn instead of the turn the date belongs to.
    const quoted = 'user: you told me on "[2023/02/15 (Wed) 01:41]" that ...';
    expect(readTurnStamp(quoted)).toBeUndefined();
  });
});

describe('readTurnClocks', () => {
  it('keeps the reading parallel to the input and names every unreadable index', () => {
    const turns = [
      turn('[2023/02/15 (Wed) 01:41]'),
      'a turn this reader cannot date',
      turn('[2023/02/16 (Thu) 02:00]'),
      turn('[2023/02/17 (Fri) 03:00]'),
    ];
    const census = readTurnClocks(turns);
    expect(census.dates).toStrictEqual(['2023/02/15', undefined, '2023/02/16', '2023/02/17']);
    expect(census.undatedIndices).toStrictEqual([1]);
    expect(census.dated).toBe(3);
  });

  it('reports an empty list as fully dated, with nothing dated', () => {
    // The two counts are derived from the same array, so the degenerate case cannot claim
    // a turn that does not exist -- an artifact reads `dated + undated.length === turns`.
    expect(readTurnClocks([])).toStrictEqual({ dates: [], dated: 0, undatedIndices: [] });
  });

  it('counts a list with no readable stamp as entirely undated rather than throwing', () => {
    const census = readTurnClocks(['one', 'two']);
    expect(census.dated).toBe(0);
    expect(census.undatedIndices).toStrictEqual([0, 1]);
  });
});

describe('partitionByWindow', () => {
  const window = { start: '2023/02/14', end: '2023/02/16' };
  const byStamp = (t: string): string | undefined => readTurnStamp(t)?.date;

  it('moves the in-window turns to the front and keeps both sides in their own order', () => {
    const turns = [
      turn('[2023/02/10 (Fri) 10:00]', 'a'),
      turn('[2023/02/15 (Wed) 10:00]', 'b'),
      turn('[2023/02/09 (Thu) 10:00]', 'c'),
      turn('[2023/02/14 (Tue) 10:00]', 'd'),
    ];
    const { inWindow, outOfWindow } = partitionByWindow(turns, window, byStamp);
    // `c` precedes `a` in the input and must still precede it: the window decides the
    // side, and nothing decides the order inside a side.
    expect(inWindow).toStrictEqual([
      turn('[2023/02/15 (Wed) 10:00]', 'b'),
      turn('[2023/02/14 (Tue) 10:00]', 'd'),
    ]);
    expect(outOfWindow).toStrictEqual([
      turn('[2023/02/10 (Fri) 10:00]', 'a'),
      turn('[2023/02/09 (Thu) 10:00]', 'c'),
    ]);
  });

  it("treats both bounds as inclusive, which is TimeRange's own contract", () => {
    const turns = [
      turn('[2023/02/13 (Mon) 10:00]', 'before'),
      turn('[2023/02/14 (Tue) 10:00]', 'start'),
      turn('[2023/02/16 (Thu) 10:00]', 'end'),
      turn('[2023/02/17 (Fri) 10:00]', 'after'),
    ];
    const { inWindow } = partitionByWindow(turns, window, byStamp);
    expect(inWindow).toStrictEqual([
      turn('[2023/02/14 (Tue) 10:00]', 'start'),
      turn('[2023/02/16 (Thu) 10:00]', 'end'),
    ]);
  });

  it('leaves an undated turn on the trailing side, in its own relative order', () => {
    // An undated turn cannot be shown to be outside the window, only to be unreadable, so
    // it is neither promoted nor demoted below a turn that is genuinely outside.
    const turns = [
      turn('[2023/02/15 (Wed) 10:00]', 'in'),
      'unreadable one',
      turn('[2023/02/01 (Wed) 10:00]', 'far'),
      'unreadable two',
    ];
    const { inWindow, outOfWindow } = partitionByWindow(turns, window, byStamp);
    expect(inWindow).toStrictEqual([turn('[2023/02/15 (Wed) 10:00]', 'in')]);
    expect(outOfWindow).toStrictEqual([
      'unreadable one',
      turn('[2023/02/01 (Wed) 10:00]', 'far'),
      'unreadable two',
    ]);
  });

  it('is a permutation: the concatenation has the same multiset as the input', () => {
    // §13.151.5's second criterion, asserted as a property of the function rather than of
    // a run. Sorting both sides removes order, which is exactly what a permutation is
    // allowed to change.
    const turns = [
      turn('[2023/02/10 (Fri) 10:00]', 'a'),
      'unreadable',
      turn('[2023/02/15 (Wed) 10:00]', 'b'),
      turn('[2023/02/01 (Wed) 10:00]', 'c'),
      turn('[2023/02/16 (Thu) 10:00]', 'd'),
    ];
    const { inWindow, outOfWindow } = partitionByWindow(turns, window, byStamp);
    const rejoined = [...inWindow, ...outOfWindow];
    expect([...rejoined].sort()).toStrictEqual([...turns].sort());
    expect(rejoined).toHaveLength(turns.length);
  });

  it('moves nothing when no turn falls in the window, which is the fired-but-inert case', () => {
    const turns = [turn('[2023/02/10 (Fri) 10:00]', 'a'), turn('[2023/02/09 (Thu) 10:00]', 'b')];
    const { inWindow, outOfWindow } = partitionByWindow(turns, window, byStamp);
    expect(inWindow).toStrictEqual([]);
    expect(outOfWindow).toStrictEqual(turns);
  });
});

describe('deliveredWindow', () => {
  it('spans the earliest and latest dated turn, ignoring the undated ones', () => {
    const turns = [
      turn('[2023/02/15 (Wed) 10:00]'),
      'unreadable',
      turn('[2022/12/19 (Mon) 12:04]'),
      turn('[2023/02/17 (Fri) 09:00]'),
    ];
    expect(deliveredWindow(turns)).toStrictEqual({ start: '2022/12/19', end: '2023/02/17' });
  });

  it('reports a single dated turn as a one-day span', () => {
    expect(deliveredWindow([turn('[2023/02/15 (Wed) 10:00]')])).toStrictEqual({
      start: '2023/02/15',
      end: '2023/02/15',
    });
  });

  it('returns undefined when nothing in the list can be dated', () => {
    // `undefined` rather than a sentinel range: a caller that compared a window against a
    // sentinel would report every question as inert, which is the shape of a silent no-op.
    expect(deliveredWindow(['one', 'two'])).toBeUndefined();
    expect(deliveredWindow([])).toBeUndefined();
  });
});

describe('the two readings agree with each other', () => {
  it('names the same undated turns that the span leaves out', () => {
    const turns = [
      turn('[2023/02/15 (Wed) 10:00]'),
      'unreadable',
      turn('[2023/02/16 (Thu) 10:00]'),
    ];
    const census = readTurnClocks(turns);
    const span = deliveredWindow(turns);
    expect(census.undatedIndices).toStrictEqual([1]);
    // The span is drawn from the dated turns alone, so a list whose every turn is undated
    // has no span even though it has turns.
    expect(span).toStrictEqual({ start: '2023/02/15', end: '2023/02/16' });
    expect(dateOf(turns[1]!)).toBe('refused');
  });
});

import { describe, it, expect } from 'vitest';
import {
  classifyTemporalQuestion,
  normalizeDate,
  isValidDate,
  elapsedDays,
  elapsedWeeks,
  elapsedMonths,
  intervalDays,
  orderByDate,
  computeTemporalAnswer,
  parseRelativeOffset,
  resolveTemporalDate,
  parseTimeRange,
  turnDateInRange,
  type TemporalKind,
} from '../temporal-engine.js';

describe('classifyTemporalQuestion', () => {
  it('classifies relative-time questions', () => {
    expect(classifyTemporalQuestion('How many weeks ago did I receive the chandelier?')).toBe(
      'relative',
    );
    expect(
      classifyTemporalQuestion(
        'How many months have passed since I participated in two charity events?',
      ),
    ).toBe('relative');
    expect(classifyTemporalQuestion('How many days ago did I attend a baking class?')).toBe(
      'relative',
    );
    expect(classifyTemporalQuestion("How many days had passed since I finished reading 'X'?")).toBe(
      'relative',
    );
  });

  it('classifies interval questions', () => {
    expect(
      classifyTemporalQuestion(
        'How many days passed between my visit to MoMA and the Ancient Civilizations exhibit?',
      ),
    ).toBe('interval');
    expect(
      classifyTemporalQuestion('How many days did I spend on my solo camping trip to Yosemite?'),
    ).toBe('interval');
  });

  it('classifies "how long" duration questions as interval', () => {
    expect(
      classifyTemporalQuestion(
        'How long had I been bird watching when I attended the bird watching workshop?',
      ),
    ).toBe('interval');
    expect(
      classifyTemporalQuestion(
        'How long did I use my new binoculars before I saw the goldfinches returning?',
      ),
    ).toBe('interval');
  });

  it('classifies ordering questions', () => {
    expect(classifyTemporalQuestion("Which event happened first, my cousin's wedding or X?")).toBe(
      'ordering',
    );
    expect(
      classifyTemporalQuestion(
        'Which three events happened in the order from first to last: A, B, C?',
      ),
    ).toBe('ordering');
    expect(classifyTemporalQuestion('Did X happen before or after Y?')).toBe('ordering');
    expect(classifyTemporalQuestion('What is the order of the three trips I took?')).toBe(
      'ordering',
    );
  });

  it('classifies "who … first" and "most recently" questions as ordering', () => {
    expect(classifyTemporalQuestion('Who did I meet first, Mark and Sarah or Tom?')).toBe(
      'ordering',
    );
    expect(
      classifyTemporalQuestion(
        'Who graduated first, second and third among Emma, Rachel and Alex?',
      ),
    ).toBe('ordering');
    expect(
      classifyTemporalQuestion('Which streaming service did I start using most recently?'),
    ).toBe('ordering');
    expect(classifyTemporalQuestion('Who became a parent first, Rachel or Alex?')).toBe('ordering');
  });

  it('classifies non-temporal questions as other', () => {
    expect(classifyTemporalQuestion('What is my favorite color?')).toBe('other');
    expect(classifyTemporalQuestion('Where do I take yoga classes?')).toBe('other');
  });

  it('classifies time-anchored entity questions as eventLookup, not relative', () => {
    // These ask for the event/object/person at a time anchor, not an elapsed-time
    // count, so they route to the lookup prompt instead of the arithmetic engine.
    expect(classifyTemporalQuestion('Which book did I finish a week ago?')).toBe('eventLookup');
    expect(classifyTemporalQuestion('What charity event did I participate in a month ago?')).toBe(
      'eventLookup',
    );
    expect(classifyTemporalQuestion('What did I do with Rachel two months ago?')).toBe(
      'eventLookup',
    );
    expect(classifyTemporalQuestion('I received a piece of jewelry last Saturday from whom?')).toBe(
      'eventLookup',
    );
    expect(classifyTemporalQuestion('What time do I wake up on Tuesdays and Thursdays?')).toBe(
      'eventLookup',
    );
  });

  it('keeps a yes/no time-anchored question as other', () => {
    // A yes/no question ("Did I visit with a friend?") asks for a boolean, not an
    // entity name, so it is not an event lookup.
    expect(
      classifyTemporalQuestion(
        'I mentioned visiting a museum two months ago. Did I visit with a friend?',
      ),
    ).toBe('other');
  });
});

describe('normalizeDate', () => {
  it('strips the weekday and time suffix', () => {
    expect(normalizeDate('2023/02/01 (Wed) 10:20')).toBe('2023/02/01');
    expect(normalizeDate('2023/04/01 (Sat) 08:09')).toBe('2023/04/01');
  });

  it('keeps a bare date unchanged', () => {
    expect(normalizeDate('2023/02/01')).toBe('2023/02/01');
  });

  it('returns an empty string when no date is present', () => {
    expect(normalizeDate('no date here')).toBe('');
  });

  it('handles leading whitespace', () => {
    expect(normalizeDate('  2023/02/01  ')).toBe('2023/02/01');
  });
});

describe('isValidDate', () => {
  it('accepts a valid YYYY/MM/DD date', () => {
    expect(isValidDate('2023/02/01')).toBe(true);
  });

  it('rejects a malformed or non-date string', () => {
    expect(isValidDate('02/01/2023')).toBe(false);
    expect(isValidDate('yesterday')).toBe(false);
    expect(isValidDate('')).toBe(false);
  });
});

describe('parseRelativeOffset', () => {
  it('parses number-word relative times', () => {
    expect(parseRelativeOffset('a month ago')).toEqual({ amount: 1, unit: 'month' });
    expect(parseRelativeOffset('two weeks before')).toEqual({ amount: 2, unit: 'week' });
    expect(parseRelativeOffset('three days ago')).toEqual({ amount: 3, unit: 'day' });
  });

  it('parses digit relative times', () => {
    expect(parseRelativeOffset('3 months ago')).toEqual({ amount: 3, unit: 'month' });
  });

  it('returns null for non-relative strings', () => {
    expect(parseRelativeOffset('2023/04/21')).toBeNull();
    expect(parseRelativeOffset('last Friday')).toBeNull();
    expect(parseRelativeOffset('sometime recently')).toBeNull();
  });
});

describe('resolveTemporalDate', () => {
  it('returns an absolute date unchanged', () => {
    expect(resolveTemporalDate('2023/04/21', '2023/05/21')).toBe('2023/04/21');
    expect(resolveTemporalDate('[2023/04/21 (Fri) 10:00]', '2023/05/21')).toBe('2023/04/21');
  });

  it('converts a relative time against the question date', () => {
    expect(resolveTemporalDate('a month ago', '2023/05/21')).toBe('2023/04/21');
    expect(resolveTemporalDate('two weeks ago', '2023/05/21')).toBe('2023/05/07');
    expect(resolveTemporalDate('3 days ago', '2023/05/21')).toBe('2023/05/18');
  });

  it('clamps a month subtraction to the last valid day', () => {
    // March 31 minus one month is February 28 (29 in a leap year).
    expect(resolveTemporalDate('a month ago', '2023/03/31')).toBe('2023/02/28');
    expect(resolveTemporalDate('a month ago', '2024/03/31')).toBe('2024/02/29');
  });

  it('returns an empty string for an unrecognized or unresolvable date', () => {
    expect(resolveTemporalDate('last Friday', '2023/05/21')).toBe('');
    expect(resolveTemporalDate('a month ago', '')).toBe('');
    expect(resolveTemporalDate('', '2023/05/21')).toBe('');
  });
});

describe('parseTimeRange', () => {
  it('parses a JSON start/end range', () => {
    expect(parseTimeRange('{"start": "2023/06/01", "end": "2023/06/30"}')).toEqual({
      start: '2023/06/01',
      end: '2023/06/30',
    });
  });

  it('tolerates markdown code fences around the JSON', () => {
    expect(parseTimeRange('```json\n{"start": "2023/06/01", "end": "2023/06/30"}\n```')).toEqual({
      start: '2023/06/01',
      end: '2023/06/30',
    });
  });

  it('returns null for N/A and other non-range outputs', () => {
    expect(parseTimeRange('N/A')).toBeNull();
    expect(parseTimeRange('n/a')).toBeNull();
    expect(parseTimeRange('No temporal reference')).toBeNull();
    expect(parseTimeRange('not json')).toBeNull();
  });

  it('returns null for a range with invalid dates', () => {
    expect(parseTimeRange('{"start": "yesterday", "end": "2023/06/30"}')).toBeNull();
    expect(parseTimeRange('{"start": "2023/06/01"}')).toBeNull();
  });

  it('returns null for malformed JSON that throws on parse', () => {
    expect(parseTimeRange('{start: 2023/06/01, end: 2023/06/30}')).toBeNull();
  });
});

describe('turnDateInRange', () => {
  it('accepts a turn whose timestamp is inside the range', () => {
    expect(
      turnDateInRange('[2023/06/15 (Thu) 10:00] user: hi', {
        start: '2023/06/01',
        end: '2023/06/30',
      }),
    ).toBe(true);
  });

  it('accepts a turn within the two-day tolerance on either side', () => {
    expect(
      turnDateInRange('[2023/05/30 (Tue) 10:00] user: hi', {
        start: '2023/06/01',
        end: '2023/06/30',
      }),
    ).toBe(true);
    expect(
      turnDateInRange('[2023/07/02 (Sun) 10:00] user: hi', {
        start: '2023/06/01',
        end: '2023/06/30',
      }),
    ).toBe(true);
  });

  it('rejects a turn far outside the range', () => {
    expect(
      turnDateInRange('[2023/01/01 (Sun) 10:00] user: hi', {
        start: '2023/06/01',
        end: '2023/06/30',
      }),
    ).toBe(false);
  });

  it('rejects a turn with no parseable timestamp', () => {
    expect(turnDateInRange('user: no date here', { start: '2023/06/01', end: '2023/06/30' })).toBe(
      false,
    );
  });
});

describe('elapsedDays', () => {
  it('returns positive days when the reference is later', () => {
    expect(elapsedDays('2023/01/08', '2023/01/15')).toBe(7);
  });

  it('returns negative days when the reference is earlier', () => {
    expect(elapsedDays('2023/01/15', '2023/01/08')).toBe(-7);
  });
});

describe('elapsedWeeks', () => {
  it('rounds to the nearest week for an exact multiple', () => {
    expect(elapsedWeeks('2023/03/04', '2023/04/01')).toBe(4); // 28 days
  });

  it('rounds a partial week up when it is closer to the next week', () => {
    // 13 days is closer to two weeks than one, so it rounds to 2.
    expect(elapsedWeeks('2023/11/18', '2023/12/01')).toBe(2);
  });

  it('rounds a short partial week to one week', () => {
    expect(elapsedWeeks('2023/03/04', '2023/03/10')).toBe(1); // 6 days
    expect(elapsedWeeks('2023/03/01', '2023/03/08')).toBe(1); // 7 days
  });
});

describe('elapsedMonths', () => {
  it('computes calendar-month difference within a year', () => {
    expect(elapsedMonths('2023/02/14', '2023/04/18')).toBe(2);
  });

  it('computes calendar-month difference across a year boundary', () => {
    expect(elapsedMonths('2022/10/22', '2023/03/25')).toBe(5);
  });

  it('ignores the day-of-month (calendar months, not day-flooring)', () => {
    // 30 elapsed days would floor to 0 months by a 30-day convention, but the
    // calendar month count is what "how many months have passed" means.
    expect(elapsedMonths('2023/01/30', '2023/03/01')).toBe(2);
  });

  it('returns zero for dates in the same calendar month', () => {
    expect(elapsedMonths('2023/03/04', '2023/03/25')).toBe(0);
  });

  it('throws on a malformed date', () => {
    expect(() => elapsedMonths('not-a-date', '2023/03/25')).toThrow();
  });
});

describe('intervalDays', () => {
  it('returns the absolute day difference', () => {
    expect(intervalDays('2023/01/08', '2023/01/15')).toBe(7);
    expect(intervalDays('2023/01/15', '2023/01/08')).toBe(7);
  });

  it('returns zero for the same date', () => {
    expect(intervalDays('2023/01/15', '2023/01/15')).toBe(0);
  });
});

describe('orderByDate', () => {
  it('sorts events ascending by date', () => {
    const events = [
      { name: 'third', date: '2023/03/10' },
      { name: 'first', date: '2023/01/05' },
      { name: 'second', date: '2023/02/20' },
    ];
    expect(orderByDate(events).map((e) => e.name)).toEqual(['first', 'second', 'third']);
  });

  it('does not mutate the input array', () => {
    const events = [
      { name: 'later', date: '2023/03/10' },
      { name: 'earlier', date: '2023/01/05' },
    ];
    orderByDate(events);
    expect(events.map((e) => e.name)).toEqual(['later', 'earlier']);
  });

  it('preserves order for equal dates', () => {
    const events = [
      { name: 'a', date: '2023/03/10' },
      { name: 'b', date: '2023/03/10' },
    ];
    expect(orderByDate(events).map((e) => e.name)).toEqual(['a', 'b']);
  });
});

describe('computeTemporalAnswer', () => {
  it('returns the elapsed weeks for a relative question', () => {
    expect(
      computeTemporalAnswer(
        'How many weeks ago did I receive the crystal chandelier?',
        'relative',
        '2023/04/01',
        [{ name: 'receive crystal chandelier', date: '2023/03/04' }],
      ),
    ).toBe('4');
  });

  it('returns the elapsed months for a relative question', () => {
    expect(
      computeTemporalAnswer(
        'How many months have passed since I participated in two charity events?',
        'relative',
        '2023/04/18',
        [{ name: 'charity events', date: '2023/02/14' }],
      ),
    ).toBe('2');
  });

  it('returns the elapsed days for a relative question', () => {
    expect(
      computeTemporalAnswer(
        'How many days ago did I attend a baking class?',
        'relative',
        '2022/04/15',
        [{ name: 'baking class', date: '2022/03/25' }],
      ),
    ).toBe('21');
  });

  it('normalizes the question date and event dates before computing', () => {
    expect(
      computeTemporalAnswer(
        'How many weeks ago did I receive the crystal chandelier?',
        'relative',
        '2023/04/01 (Sat) 08:09',
        [{ name: 'chandelier', date: '[2023/03/04 (Sat) 22:43]' }],
      ),
    ).toBe('4');
  });

  it('returns the interval days between two events', () => {
    expect(
      computeTemporalAnswer(
        'How many days passed between my visit to MoMA and the exhibit?',
        'interval',
        '2023/02/01',
        [
          { name: 'visit MoMA', date: '2023/01/08' },
          { name: 'exhibit', date: '2023/01/15' },
        ],
      ),
    ).toBe('7');
  });

  it('returns interval weeks when the question asks for weeks between events', () => {
    expect(
      computeTemporalAnswer(
        'How many weeks passed between the day I bought my tennis racket and the day I played?',
        'interval',
        '2023/06/01',
        [
          { name: 'buy tennis racket', date: '2023/05/08' },
          { name: 'play tennis', date: '2023/05/15' },
        ],
      ),
    ).toBe('1'); // 7 days = 1 week
  });

  it('returns interval months when the question asks for months between events', () => {
    expect(
      computeTemporalAnswer(
        'How many months passed between the day I moved in and the day I moved out?',
        'interval',
        '2023/06/01',
        [
          { name: 'move in', date: '2023/01/15' },
          { name: 'move out', date: '2023/04/15' },
        ],
      ),
    ).toBe('3'); // January to April = 3 calendar months
  });

  it('returns the earlier event name for a "which first" ordering question', () => {
    expect(
      computeTemporalAnswer(
        "Which event happened first, my cousin's wedding or Michael's engagement party?",
        'ordering',
        '2023/10/01',
        [
          { name: "my cousin's wedding", date: '2023/05/15' },
          { name: "Michael's engagement party", date: '2023/04/06' },
        ],
      ),
    ).toBe("Michael's engagement party");
  });

  it('returns "before"/"after" for a before-or-after question', () => {
    // First-mentioned event is later than the second-mentioned event.
    expect(
      computeTemporalAnswer(
        "Did my cousin's wedding happen before or after Michael's engagement party?",
        'ordering',
        '2023/10/01',
        [
          { name: "my cousin's wedding", date: '2023/05/15' },
          { name: "Michael's engagement party", date: '2023/04/06' },
        ],
      ),
    ).toBe('after');
    // First-mentioned event is earlier than the second-mentioned event.
    expect(
      computeTemporalAnswer(
        "Did my cousin's wedding happen before or after Michael's engagement party?",
        'ordering',
        '2023/10/01',
        [
          { name: "my cousin's wedding", date: '2023/03/15' },
          { name: "Michael's engagement party", date: '2023/04/06' },
        ],
      ),
    ).toBe('before');
  });

  it('formats an order-from-first-to-last list', () => {
    expect(
      computeTemporalAnswer(
        'Which three events happened in the order from first to last: A, B, C?',
        'ordering',
        '2023/03/22',
        [
          { name: 'event C', date: '2023/02/20' },
          { name: 'event A', date: '2023/01/26' },
          { name: 'event B', date: '2023/02/05' },
        ],
      ),
    ).toBe('First, event A, then event B, and lastly event C.');
  });

  it('formats a two-event order-from-first-to-last list', () => {
    expect(
      computeTemporalAnswer(
        'What is the order of the two trips I took, X and Y?',
        'ordering',
        '2023/06/01',
        [
          { name: 'trip Y', date: '2023/05/15' },
          { name: 'trip X', date: '2023/03/10' },
        ],
      ),
    ).toBe('First, trip X, then trip Y.');
  });

  it('returns the latest event for a "most recently" ordering question', () => {
    expect(
      computeTemporalAnswer(
        'Which streaming service did I start using most recently?',
        'ordering',
        '2023/06/01',
        [
          { name: 'Netflix', date: '2023/02/10' },
          { name: 'Disney+', date: '2023/04/20' },
          { name: 'Hulu', date: '2023/01/05' },
        ],
      ),
    ).toBe('Disney+');
  });

  it('formats a full first-second-third ranking', () => {
    expect(
      computeTemporalAnswer(
        'Who graduated first, second and third among Emma, Rachel and Alex?',
        'ordering',
        '2023/08/20',
        [
          { name: 'Rachel', date: '2023/06/10' },
          { name: 'Emma', date: '2023/05/15' },
          { name: 'Alex', date: '2023/07/01' },
        ],
      ),
    ).toBe('First, Emma, then Rachel, and lastly Alex.');
  });

  it('returns null for an unclassifiable question', () => {
    expect(
      computeTemporalAnswer('What is my favorite color?', 'other', '2023/01/01', [
        { name: 'color', date: '2023/01/01' },
      ]),
    ).toBeNull();
  });

  it('returns null for an event-lookup question', () => {
    // Event-lookup questions are answered by the LLM lookup prompt, never by the
    // deterministic engine, even when events are present.
    expect(
      computeTemporalAnswer('Which book did I finish a week ago?', 'eventLookup', '2023/01/01', [
        { name: 'finish book', date: '2023/01/01' },
      ]),
    ).toBeNull();
  });

  it('returns null when there are no valid events', () => {
    expect(
      computeTemporalAnswer(
        'How many weeks ago did I receive the chandelier?',
        'relative',
        '2023/04/01',
        [],
      ),
    ).toBeNull();
  });

  it('returns null for a relative question without a valid question date', () => {
    expect(
      computeTemporalAnswer('How many weeks ago did I receive the chandelier?', 'relative', '', [
        { name: 'chandelier', date: '2023/03/04' },
      ]),
    ).toBeNull();
  });

  it('returns null for an interval question with fewer than two events', () => {
    expect(
      computeTemporalAnswer('How many days between X and Y?', 'interval', '2023/02/01', [
        { name: 'X', date: '2023/01/08' },
      ]),
    ).toBeNull();
  });

  it('returns null for an ordering question with fewer than two events', () => {
    expect(
      computeTemporalAnswer('Which happened first, X or Y?', 'ordering', '2023/10/01', [
        { name: 'X', date: '2023/01/08' },
      ]),
    ).toBeNull();
  });

  it('filters out events with invalid dates', () => {
    expect(
      computeTemporalAnswer(
        'How many weeks ago did I receive the chandelier?',
        'relative',
        '2023/04/01',
        [
          { name: 'chandelier', date: '2023/03/04' },
          { name: 'garbage', date: 'not a date' },
        ],
      ),
    ).toBe('4');
  });

  it('covers every TemporalKind branch exhaustively', () => {
    const kinds: TemporalKind[] = ['relative', 'interval', 'ordering', 'eventLookup', 'other'];
    for (const kind of kinds) {
      const result = computeTemporalAnswer('Q?', kind, '2023/04/01', [
        { name: 'a', date: '2023/01/01' },
        { name: 'b', date: '2023/02/01' },
      ]);
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });
});

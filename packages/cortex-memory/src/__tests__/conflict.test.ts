/**
 * The block that puts two statements of one detail side by side.
 *
 * ## What these tests are for
 *
 * The mechanism is a heuristic over text, so the tests split in two. The unit half pins the
 * arithmetic (which terms count, which statements survive the cap, when the block is empty) against
 * hand-built turns. The half that matters is the last suite: it takes the **five `KU` questions that
 * fail in all four repetitions of run `42355323615` with a value the corpus later replaced**, and
 * asserts that the block names both statements and that the later one carries the gold. Those are
 * the artifact's own words, so the reading is a property of the mechanism rather than of a fixture
 * written to agree with it.
 */
import { describe, expect, it } from 'vitest';
import type { AdmittedTurn } from '../admission.js';
import {
  conflictBlock,
  conflictStatements,
  contentTerms,
  insertRelatedStatements,
  renderConflicts,
} from '../conflict.js';

/**
 * A turn as the window holds it: the content **is** the rendered line, timestamp prefix included,
 * because that is what `formatEvidence` prints and therefore what the block has to quote.
 */
function turn(content: string): AdmittedTurn {
  return {
    id: content,
    content,
    value: 0.5,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic',
    tags: [],
    createdAt: 0,
    lastAccessedAt: 0,
    stability: 1,
    difficulty: 5,
    memoryType: 'episodic',
    activation: 0.5,
    decay: 0.5,
    rehearsalCount: 0,
    ordinal: 0,
  } as AdmittedTurn;
}

describe('contentTerms', () => {
  it('drops the words that appear in every question', () => {
    expect(contentTerms('What day of the week do I take a cocktail-making class?')).toEqual([
      'day',
      'week',
      'take',
      'cocktail-making',
      'class',
    ]);
  });

  it('keeps a number, because a number is what most of these questions ask for', () => {
    expect(contentTerms('How many followers do I have on Instagram now?')).toEqual([
      'follower',
      'instagram',
    ]);
    expect(contentTerms('am I close to 1300 followers')).toContain('1300');
  });

  it('folds the plurals that have to meet, and only those', () => {
    expect(contentTerms('coins')).toEqual(contentTerms('coin'));
    expect(contentTerms('classes')).toEqual(contentTerms('class'));
    expect(contentTerms('stories')).toEqual(contentTerms('story'));
    expect(contentTerms('glass')).not.toEqual(contentTerms('glas'));
  });

  it('strips a possessive rather than treating it as a word', () => {
    expect(contentTerms("my sister's trip")).toEqual(['sister', 'trip']);
  });

  it('is empty for a question that names nothing', () => {
    expect(contentTerms('what is it?')).toEqual([]);
    expect(contentTerms('')).toEqual([]);
    expect(contentTerms('?! ... --')).toEqual([]);
  });
});

describe('conflictStatements', () => {
  const question = 'What day of the week do I take a cocktail-making class?';

  it('finds the two statements of one detail and reports their dates', () => {
    const statements = conflictStatements(question, [
      turn(
        '[2023/06/16 (Fri) 13:26] user: I have a cocktail-making class on Thursday, so I am excited.',
      ),
      turn(
        '[2023/06/23 (Fri) 09:00] user: I bought a new kettle for the kitchen and it boils fast.',
      ),
      turn(
        '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
      ),
    ]);
    expect(statements.map((entry) => entry.date)).toEqual([
      '2023/06/16 (Fri) 13:26',
      '2023/06/30 (Fri) 22:49',
    ]);
    expect(statements[0]!.sentence).toContain('Thursday');
    expect(statements[1]!.sentence).toContain('Fridays');
  });

  it('returns nothing when the subject is stated once', () => {
    const statements = conflictStatements(question, [
      turn(
        '[2023/06/16 (Fri) 13:26] user: I have a cocktail-making class on Thursday, so I am excited.',
      ),
      turn(
        '[2023/06/23 (Fri) 09:00] user: I bought a new kettle for the kitchen and it boils fast.',
      ),
    ]);
    expect(statements).toEqual([]);
  });

  it('keeps the earliest and latest statement when every candidate is equally relevant', () => {
    // Eight candidates tied at two terms is the shape that broke relevance-ordered selection:
    // the cap keeps six, and the one it dropped was the earlier half of the pair being repaired.
    const window = [
      turn(
        '[2023/06/16 (Fri) 13:26] user: I have a cocktail-making class on Thursday, so I am glad.',
      ),
      turn(
        '[2023/06/17 (Sat) 13:26] assistant: That class on Thursday sounds like a good time to me.',
      ),
      turn(
        '[2023/06/18 (Sun) 13:26] assistant: A cooking class is a fine way to spend an evening.',
      ),
      turn(
        '[2023/06/19 (Mon) 13:26] assistant: The roaster class takes participants through roasting.',
      ),
      turn(
        '[2023/06/20 (Tue) 13:26] assistant: Any class on cocktails rewards experimentation, truly.',
      ),
      turn(
        '[2023/06/21 (Wed) 13:26] assistant: Your cocktail-making class is a lovely idea, honestly.',
      ),
      turn(
        '[2023/06/22 (Thu) 13:26] assistant: A cocktail-making class needs a shaker and a jigger.',
      ),
      turn(
        '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
      ),
    ];
    const statements = conflictStatements(question, window, { maxStatements: 3 });
    // Two, not three: the value gate drops the asides that name no day at all, which is the whole
    // difference between this and the version run 42754985453 priced.
    expect(statements).toHaveLength(2);
    expect(statements[0]!.sentence).toContain('Thursday');
    expect(statements[statements.length - 1]!.sentence).toContain('Fridays');
  });

  it('keeps the most relevant statements after the two endpoints', () => {
    const window = [
      turn(
        '[2023/06/16 (Fri) 13:26] user: I have a cocktail-making class on Thursday, so I am glad.',
      ),
      turn(
        '[2023/06/17 (Sat) 13:26] assistant: A class on Thursday is a good use of an evening, yes.',
      ),
      turn('[2023/06/18 (Sun) 13:26] assistant: Cocktail-making needs a shaker, a jigger and ice.'),
      turn(
        '[2023/06/19 (Mon) 13:26] assistant: The week has seven days and each is a fresh start.',
      ),
      turn(
        '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
      ),
    ];
    const statements = conflictStatements(question, window, { maxStatements: 2 });
    expect(statements.map((entry) => entry.date)).toEqual([
      '2023/06/16 (Fri) 13:26',
      '2023/06/30 (Fri) 22:49',
    ]);
  });

  it('drops a candidate that shares only one term, because one term matches filler', () => {
    const window = [
      turn(
        '[2023/06/16 (Fri) 13:26] user: I have a cocktail-making class on Thursday, so I am glad.',
      ),
      turn(
        '[2023/06/17 (Sat) 09:00] user: I signed up for a pottery class at the community centre.',
      ),
      turn(
        '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
      ),
    ];
    const dates = conflictStatements(question, window).map((entry) => entry.date);
    expect(dates).not.toContain('2023/06/17 (Sat) 09:00');
    expect(dates).toHaveLength(2);
  });

  it('takes one statement per turn, the one that mentions the most of the question', () => {
    const statements = conflictStatements(question, [
      turn(
        '[2023/06/16 (Fri) 13:26] user: I have a cocktail-making class on Thursday. ' +
          'The class is at a bar near the office and it runs for two hours.',
      ),
      turn(
        '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
      ),
    ]);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.sentence).toContain('Thursday');
  });

  it('marks a truncated statement rather than ending it silently', () => {
    const statements = conflictStatements(
      question,
      [
        turn(
          '[2023/06/16 (Fri) 13:26] user: I have a cocktail-making class on Thursday and it runs ' +
            'for two hours every week at a bar near the office, which is a long walk from home.',
        ),
        turn(
          '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
        ),
      ],
      { sentenceChars: 40 },
    );
    expect(statements[0]!.sentence).toHaveLength(40);
    expect(statements[0]!.sentence.endsWith('…')).toBe(true);
    expect(statements).toHaveLength(2);
  });

  it('returns nothing when only the latest mention qualifies, because one statement is no pair', () => {
    // The union of "the qualifying statements" and "the latest mention" is one statement here: the
    // later turn is the only one that shares two terms, and it is also the latest. Two scored turns
    // and one candidate is the state where the endpoints rule has nothing to place.
    const statements = conflictStatements(question, [
      turn(
        '[2023/06/16 (Fri) 13:26] user: The class starts at seven and runs for two hours, honestly.',
      ),
      turn(
        '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
      ),
    ]);
    expect(statements).toEqual([]);
  });

  it('ignores a turn whose sentences are all too short to be a statement', () => {
    const statements = conflictStatements(question, [
      turn('[2023/06/16 (Fri) 13:26] user: Thursday class!'),
      turn(
        '[2023/06/30 (Fri) 22:49] user: I have a cocktail-making class on Fridays, so maybe then.',
      ),
    ]);
    expect(statements).toEqual([]);
  });

  it('returns nothing for a question that names nothing', () => {
    expect(
      conflictStatements('what is it?', [turn('[2023/06/16 (Fri) 13:26] user: it is.')]),
    ).toEqual([]);
  });

  it('refuses a cap that would silence it rather than narrow it', () => {
    expect(() => conflictStatements(question, [], { maxStatements: 1 })).toThrow(RangeError);
    expect(() => conflictStatements(question, [], { maxStatements: 0 })).toThrow(/at least 2/);
  });

  it('reads a turn with no timestamp prefix rather than failing on it', () => {
    const statements = conflictStatements(question, [
      turn('I have a cocktail-making class on Thursday, and it is every week.'),
      turn('I have a cocktail-making class on Fridays, so maybe then, every week.'),
    ]);
    expect(statements.map((entry) => entry.date)).toEqual([undefined, undefined]);
    expect(renderConflicts(statements)).not.toContain('[]');
  });
});

describe('renderConflicts', () => {
  it('prints nothing below two statements, because one statement has no pair', () => {
    expect(renderConflicts([])).toBe('');
    expect(
      renderConflicts([{ date: '2023/06/16 (Fri) 13:26', sentence: 'Thursday.', position: 0 }]),
    ).toBe('');
  });

  it('prints the dates, the sentences and the conditional rule, in evidence order', () => {
    const block = renderConflicts([
      { date: '2023/06/16 (Fri) 13:26', sentence: 'I have a class on Thursday.', position: 0 },
      { date: '2023/06/30 (Fri) 22:49', sentence: 'I have a class on Fridays.', position: 2 },
    ]);
    expect(block).toContain('RELATED STATEMENTS');
    expect(block.indexOf('Thursday')).toBeLessThan(block.indexOf('Fridays'));
    expect(block).toContain('[2023/06/16 (Fri) 13:26]');
    expect(block).toContain('the later statement is the value');
    // The directional correction: a third sentence inviting the earlier value cost three conversions
    // on run 42754985453, so the block no longer offers one.
    expect(block).not.toContain('previous state');
  });

  it('does not assert that the last statement is the answer', () => {
    const block = renderConflicts([
      { date: '2023/06/16 (Fri) 13:26', sentence: 'I have a class on Thursday.', position: 0 },
      { date: '2023/06/30 (Fri) 22:49', sentence: 'Remember to have fun.', position: 2 },
    ]);
    expect(block).not.toMatch(/the (last|most recent) (one|statement) is the answer/i);
  });
});

describe('the four stable KU failures the corpus later replaced', () => {
  /**
   * The artifact's own statements, verbatim, with the turns that are not about the asked detail
   * kept in place so that the block is computed over a window rather than over its answer.
   */
  const cases: {
    readonly id: string;
    readonly question: string;
    readonly later: string;
    readonly earlier: string;
    readonly window: readonly string[];
  }[] = [
    {
      id: 'ce6d2d27',
      question: 'What day of the week do I take a cocktail-making class?',
      later: 'Fridays',
      earlier: 'Thursday',
      window: [
        '[2023/06/16 (Fri) 13:26] assistant: And by the way, I have a cocktail-making class on Thursday, so I am excited.',
        '[2023/06/21 (Wed) 03:41] user: They also have a Roaster Class that takes participants through the coffee roasting process.',
        '[2023/06/29 (Thu) 17:31] user: We actually made an Indian-inspired feast in my cooking class last week.',
        '[2023/06/30 (Fri) 22:49] user: By the way, I have a cocktail-making class on Fridays, so maybe something I can experiment with then.',
      ],
    },
    {
      id: '9ea5eabc',
      question: 'Where did I go on my most recent family trip?',
      later: 'Paris',
      earlier: 'Hawaii',
      window: [
        '[2023/05/26 (Fri) 23:05] user: I was thinking about my recent family trip to Hawaii and how we had a great time snorkeling together.',
        '[2023/05/27 (Sat) 10:02] user: I have been to Japan before, but it was a family trip and we spent 10 days island-hopping.',
        '[2023/05/28 (Sun) 04:50] assistant: The City of Light is always a great idea for a family trip.',
        '[2023/05/28 (Sun) 04:51] user: Since I have been thinking about my recent family trip to Paris, could you help me compare it with the other one?',
      ],
    },
    {
      id: 'ed4ddc30',
      question: 'How many dozen eggs do we currently have stocked up in our refrigerator?',
      later: '20 dozen',
      earlier: '30 dozen at the moment',
      window: [
        '[2023/01/11 (Wed) 23:12] user: I need to start using up some of our eggs, we have a lot stocked up in the fridge - 30 dozen at the moment!',
        '[2023/01/11 (Wed) 23:13] assistant: Wow, 30 dozen eggs is a lot!',
        '[2023/03/15 (Wed) 08:11] user: I was thinking of using some of our fresh eggs from the coop - we have got 20 dozen stocked up in the fridge right now.',
      ],
    },
    {
      id: '59524333',
      question: 'What time do I usually go to the gym?',
      later: '6:00 pm',
      earlier: '7:00 pm',
      window: [
        '[2023/02/11 (Sat) 07:02] user: Can you suggest the best way to set reminders for my gym sessions, which I usually go to at 7:00 pm on Mondays, Wednesdays, and Fridays?',
        '[2023/05/30 (Tue) 07:53] user: I usually go to the gym on Mondays, Wednesdays, and Fridays, so I would rather avoid that slot.',
        '[2023/05/30 (Tue) 07:54] user: I need to make sure I am done with the meeting before I head to the gym, which is usually at 6:00 pm.',
      ],
    },
  ];

  for (const entry of cases) {
    it(`${entry.id}: the block names both statements and the gold is the later one`, () => {
      const block = conflictBlock(entry.question, entry.window.map(turn));
      expect(block).not.toBe('');
      expect(block).toContain(entry.later);
      expect(block).toContain(entry.earlier);
      // The mechanism is only worth a dispatch if the two ends are in the order the reading needs:
      // the statement carrying the gold must print after the statement carrying the replaced value.
      expect(block.lastIndexOf(entry.later)).toBeGreaterThan(block.lastIndexOf(entry.earlier));
    });
  }

  it('does not reach a2f3aa27 on its real window, and the reason is segmentation', () => {
    // The artifact's own turn, at its own length. The replacing statement ("I think I am close to
    // 1300 now") is the last sentence of a long turn whose opening is about an Instagram post, so the
    // turn's best-scoring sentence is the opening and the number never enters the block. Documented
    // as a reach limit rather than fixed by widening the threshold: the widening that would reach
    // this sentence also admits every turn that mentions Instagram once, and on the 72 `KU` questions
    // that is 33 blocks that already name no gold.
    const block = conflictBlock('How many followers do I have on Instagram now?', [
      turn(
        '[2023/05/25 (Thu) 05:21] user: And by the way, I have got 1250 followers on Instagram ' +
          'now, so it would be great to get some insights on how to optimize my content for them.',
      ),
      turn(
        '[2023/05/25 (Thu) 09:28] user: I am looking to create a new Instagram post about a recent ' +
          'industry event I attended. Can you help me come up with a caption? I have been meaning to ' +
          'check my current follower count too, and I think I am close to 1300 now.',
      ),
    ]);
    expect(block).toContain('1250');
    expect(block).not.toContain('1300');
  });

  it('does not reach the two failures that are not supersession', () => {
    // `69fee5aa` states 37 coins and then adds one, so the value is an increment rather than a
    // replacement, and `0977f2af` names neither the gadget nor its predecessor. Both are registered
    // as a reach limit rather than as a target: counting them as reachable is how a ceiling becomes
    // a hope.
    const increment = conflictBlock(
      'How many pre-1920 American coins do I have in my collection?',
      [
        turn(
          '[2023/05/27 (Sat) 18:09] user: I have a total of 37 coins in that collection, and I want to display them.',
        ),
        turn(
          '[2023/05/29 (Mon) 00:51] user: I just added a new coin to my collection of pre-1920 American coins - a 1915-S Barber quarter.',
        ),
      ],
    );
    // The block does surface the pair -- both turns are about the collection -- but nothing in it says
    // "38": the increment is still the reader's. That is why this question is a reach limit rather
    // than a target, and the assertion is on the absence of the gold rather than on an empty block.
    expect(increment).toContain('Barber quarter');
    expect(increment).not.toContain('38');

    const relational = conflictBlock(
      'What new kitchen gadget did I invest in before getting the Air Fryer?',
      [
        turn(
          '[2023/05/21 (Sun) 22:50] user: I am actually thinking of using the Air Fryer I got yesterday to make sweet potato fries.',
        ),
        turn(
          '[2023/05/21 (Sun) 22:51] assistant: Air Fryer sweet potato fries are a fantastic side dish for those meals.',
        ),
      ],
    );
    expect(relational).not.toContain('Instant Pot');
  });
});

describe('insertRelatedStatements', () => {
  const prompt = 'EVIDENCE:\n1. something\n\nQUESTION: what day?\n\nanswer it.';
  const block = 'RELATED STATEMENTS:\n- one\n- two';

  it('places the block as its own section immediately before the question', () => {
    expect(insertRelatedStatements(prompt, block)).toBe(
      `EVIDENCE:\n1. something\n\n${block}\n\nQUESTION: what day?\n\nanswer it.`,
    );
  });

  it('hands an empty block back as the prompt it was given', () => {
    expect(insertRelatedStatements(prompt, '')).toBe(prompt);
  });

  it('hands a prompt with no question section back untouched rather than appending', () => {
    // A block printed after the question would be evidence arriving after the thing it informs.
    expect(insertRelatedStatements('no sections here', block)).toBe('no sections here');
  });
});

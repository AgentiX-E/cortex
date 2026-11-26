/**
 * The specification ceiling instrument, tested on a history whose answer is known.
 *
 * ## Why this file exists rather than a comment saying "it was run"
 *
 * `src/aggregation/ceiling.ts` decides whether a `reviewPass: 'spec'` dispatch can succeed at all,
 * and it decides it by search. A search that reports the wrong number is worse than no search: it
 * closes a mechanism that would have worked, or buys one that cannot. The numbers a registration is
 * judged on are therefore pinned here on a corpus small enough to count by hand:
 *
 * - a **count** via a keyword the question itself uses, where the gold is what the rows say;
 * - a **sum** whose unit the ledger's own vocabulary carries, so a plan that ignores the unit is not
 *   silently the same plan;
 * - the **copy** ceiling, which must be true when a row states the gold and false when none does;
 * - the **plan share**, which must be a ratio of the plans that hit over the plans that were tried,
 *   and not of the hits over the questions.
 *
 * Every assertion goes through `measure` rather than through the helpers it calls. That is a
 * deliberate loss of reach in exchange for a gain in meaning: the helpers are private because their
 * only caller is `measure`, and a test that pinned them would go red on a refactor that changed
 * nothing a reading can see. Each behaviour below is one a reading would report differently if it
 * broke.
 *
 * ## The three things this file guards that are not arithmetic
 *
 * 1. **A population id missing from the corpus is a failed reading.** Dropping it would lower the
 *    denominator and raise the ceiling, and a ceiling that rises when the corpus is thinner is the
 *    one direction this measurement must never move by accident.
 * 2. **The registered population cannot drift from the audit.** Every id in
 *    `tools/spec-ceiling-population.json` is read back out of `docs/AUDIT-NUMERIC-MEMBERSHIP.md`, and
 *    the group sizes and the required conversion rate are recomputed rather than trusted. A frozen
 *    list that nothing checks is a list that gets edited after the reading, which is the definition
 *    of a population chosen by its result.
 * 3. **The gate is the pass's own gate.** `reviewPass: 'spec'` runs only on an enumeration question
 *    asking for a count or a total, so the row carries that verdict and the fold reports a gated
 *    numerator beside the full one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  measure,
  selectPopulation,
  summarise,
  type DatasetQuestion,
  type PopulationFile,
} from '../aggregation/ceiling.js';

/** A corpus question with the fields the instrument reads, and nothing it does not. */
function corpusQuestion(input: {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly sessions: readonly (readonly string[])[];
}): DatasetQuestion {
  return {
    question_id: input.id,
    question_type: 'multi-session',
    question: input.question,
    answer: input.answer,
    haystack_dates: input.sessions.map((_, index) => `2023/03/0${index + 1} (Wed) 10:00`),
    haystack_sessions: input.sessions.map((turns) =>
      turns.map((content) => ({ role: 'user', content })),
    ),
  };
}

/** The two-session history every arithmetic case below is read against. */
const TWO_BOOKS = corpusQuestion({
  id: 'two-books',
  question: 'How many books did I read?',
  answer: '2',
  sessions: [
    ['[2023/03/01 (Wed) 10:00] user: I read a book about otters.'],
    ['[2023/03/02 (Thu) 11:00] user: I read another book, and it cost $10.'],
  ],
});

/**
 * The keyword a plan selected, quoted as the plan writes it, and asserted to be the question's own.
 *
 * Asserting `"book"` by name was the first version of the two tests below and it was wrong for a
 * reason worth keeping: `read` reaches the same two rows, is also in the question, and is the plan
 * the search reports first. The property that matters is not which of the question's words the plan
 * chose but that it chose one of them, so the helper reads the keyword out and the caller asserts it
 * appears in the question.
 */
function questionKeywordOf(plan: string | null): string {
  const keyword = /\("([^"]+)"/.exec(plan ?? '')?.[1];
  if (keyword === undefined) throw new Error(`no keyword in ${String(plan)}`);
  expect(TWO_BOOKS.question.toLowerCase()).toContain(keyword.toLowerCase());
  return `"${keyword}"`;
}

describe('a count the question vocabulary can name', () => {
  it('reaches the gold, and says which plan did', () => {
    const reading = measure(TWO_BOOKS, 'question');
    expect(reading.goldNumbers).toEqual([2]);
    expect(reading.grammarCeiling).toBe(true);
    expect(reading.matchingPlans).toBeGreaterThan(0);
    expect(reading.bestPlan).toContain('count');
    // The keyword the plan selected is the question's own word, not one of the history's: that is
    // the whole difference between a plan a reader could write and one only a search could find.
    expect(reading.bestPlan).toContain(questionKeywordOf(reading.bestPlan));
  });

  it('shares the hits over the plans it tried, not over the questions', () => {
    const reading = measure(TWO_BOOKS, 'question');
    expect(reading.plansTried).toBeGreaterThan(1);
    expect(reading.planShare).toBeCloseTo(reading.matchingPlans / reading.plansTried, 12);
    expect(reading.planShare).toBeLessThan(1);
  });

  it('forwards an explicit keyword budget to the history search rather than ignoring it', () => {
    const capped = measure(
      { ...TWO_BOOKS, question: 'How many of these did I finish?' },
      'history',
      1,
    );
    const uncapped = measure(
      { ...TWO_BOOKS, question: 'How many of these did I finish?' },
      'history',
    );
    expect(capped.keywordsTried).toBeLessThanOrEqual(1);
    expect(uncapped.keywordsTried).toBeGreaterThan(capped.keywordsTried);
  });

  it('searches one count plan per keyword plus one sum plan per keyword and unit', () => {
    // A search that dropped the unit axis, or the count axis, would report a different total and a
    // different share for the same question -- which is how a ceiling quietly changes meaning.
    const reading = measure(TWO_BOOKS, 'question');
    expect(reading.plansTried % reading.keywordsTried).toBe(0);
    expect(reading.plansTried / reading.keywordsTried).toBeGreaterThanOrEqual(2);
  });

  it('reads a gold the corpus states as a number, which is what a count question carries', () => {
    // The corpus states `answer: 3` for a count and `$3,750` for a price. An instrument typed
    // `string` read the first one's characters and threw, which is how run `45750764632` died.
    const numeric = measure({ ...TWO_BOOKS, answer: 2 }, 'question');
    expect(numeric.goldNumbers).toEqual([2]);
    expect(numeric.gold).toBe('2');
    expect(numeric.grammarCeiling).toBe(true);
  });

  it('says no, and says it with a zero share, when nothing in the grammar reaches the gold', () => {
    const unreachable = measure({ ...TWO_BOOKS, answer: '7' }, 'question');
    expect(unreachable.goldNumbers).toEqual([7]);
    expect(unreachable.grammarCeiling).toBe(false);
    expect(unreachable.matchingPlans).toBe(0);
    expect(unreachable.planShare).toBe(0);
    expect(unreachable.bestPlan).toBeNull();
  });
});

describe('a sum whose unit the ledger carries', () => {
  it('reaches a dollar gold by filtering on the unit rather than by summing every number', () => {
    const reading = measure({ ...TWO_BOOKS, answer: '$10' }, 'question');
    expect(reading.goldNumbers).toEqual([10]);
    expect(reading.grammarCeiling).toBe(true);
    expect(reading.bestPlan).toContain(questionKeywordOf(reading.bestPlan));
    // The plan that reaches it is a sum, because `count` cannot produce ten out of two rows.
    expect(reading.bestPlan).toContain('sum');
  });

  it('accepts a gold that hedges between two numbers', () => {
    // `5 days. 6 days (including the last day) is also acceptable.` is a real gold shape in this
    // corpus, and a parser that read only the first number would report an unreachable question
    // that is reachable.
    const hedged = measure(
      { ...TWO_BOOKS, answer: '2 items. 3 items if the gift counts.' },
      'question',
    );
    expect(hedged.goldNumbers).toEqual([2, 3]);
    expect(hedged.grammarCeiling).toBe(true);
  });
});

describe('a vocabulary the history supplies', () => {
  it('searches words the question never used, and reaches a gold the question vocabulary cannot', () => {
    // The two vocabularies answer different questions. `question` is what a specifier could reason
    // from; `history` is an allowance the model does not get, and measuring it is what turns a
    // ceiling into two numbers: what a reader could find, and what the ledger could express.
    const gold = measure(
      { ...TWO_BOOKS, question: 'How many of these did I finish?', answer: '2' },
      'question',
    );
    const wide = measure(
      { ...TWO_BOOKS, question: 'How many of these did I finish?', answer: '2' },
      'history',
    );
    expect(gold.grammarCeiling).toBe(false);
    expect(wide.grammarCeiling).toBe(true);
    expect(wide.keywordsTried).toBeGreaterThan(0);
    // The history vocabulary is wider than the question's, so the same gold is a smaller share of it.
    expect(wide.plansTried).toBeGreaterThan(gold.plansTried);
  });

  it('keeps a stem so an inflected history word can be reached', () => {
    // `sold` has no rule that reaches `sell`; the stem pass is what lets `books` answer `book`.
    const reading = measure(
      corpusQuestion({
        id: 'stems',
        question: 'How many did I finish?',
        answer: '2',
        sessions: [
          ['[2023/03/01 (Wed) 10:00] user: finished one otters book.'],
          ['[2023/03/02 (Thu) 11:00] user: finished another otters book.'],
        ],
      }),
      'history',
    );
    expect(reading.grammarCeiling).toBe(true);
  });
});

describe('a median over an even population', () => {
  it('averages the two middle shares rather than taking one of them', () => {
    // Two eligible questions with different windows: a median that returned `sorted[floor(n/2)]`
    // would report the larger share, which is the number a reader would act on.
    const narrow = measure(
      { ...TWO_BOOKS, question_id: 'a', question: 'How many books did I read?' },
      'question',
    );
    const wide = measure(
      {
        ...TWO_BOOKS,
        question_id: 'b',
        question: 'How many books, magazines and journals did I read?',
      },
      'question',
    );
    const reading = summarise([narrow, wide], 'question');
    expect(reading.eligible).toBe(2);
    expect(reading.planShareMedian).toBeGreaterThan(0);
    expect(reading.planShareMedian).toBeLessThanOrEqual(Math.max(narrow.planShare, wide.planShare));
  });
});

describe('a history the corpus states incompletely', () => {
  it('renders a turn with no date rather than dropping it from the ledger', () => {
    // A ledger quietly shorter than the history is the defect the ledger exists to remove: a count
    // over fewer rows is a number nobody can trace. A session with no date still has a turn.
    const undated: DatasetQuestion = { ...TWO_BOOKS, haystack_dates: [] };
    const reading = measure(undated, 'question');
    expect(reading.ledgerSteps).toBe(2);
    expect(reading.grammarCeiling).toBe(true);
  });

  it('ignores a numeral too large to be a finite number instead of counting it as a value', () => {
    // A gold of four hundred nines parses to `Infinity`, and an `Infinity` in the accepted set would
    // accept every infinite sum. The parser refuses it rather than comparing against it.
    const absurd = measure({ ...TWO_BOOKS, answer: '9'.repeat(400) }, 'question');
    expect(absurd.goldNumbers).toEqual([]);
    expect(absurd.grammarCeiling).toBe(false);
  });
});

describe('a plan the renderer refuses', () => {
  it('does not count a mixed-unit sum as having reached the gold', () => {
    // `$10` and `2 pages` summed is a plan error the executor cannot repair, and the renderer
    // declines to write it. A search that counted the unrendered number would report a ceiling over
    // an answer the product would never produce.
    const mixed = measure(
      corpusQuestion({
        id: 'mixed',
        question: 'How many books did I read?',
        answer: '12',
        sessions: [
          ['[2023/03/01 (Wed) 10:00] user: I read a book that cost $10.'],
          ['[2023/03/02 (Thu) 11:00] user: I read another book of 2 pages.'],
        ],
      }),
      'question',
    );
    expect(mixed.grammarCeiling).toBe(false);
  });

  it('does not count a plan that selected nothing as having reached a zero gold', () => {
    // `sum` over no rows is `empty`, not zero. Reporting it as a hit would make every question with
    // a gold of zero reachable by every plan.
    const empty = measure({ ...TWO_BOOKS, answer: '0' }, 'question');
    expect(empty.grammarCeiling).toBe(false);
  });
});

describe('a question whose words are all stopwords', () => {
  it('searches no plan at all, and reports a zero share rather than dividing by zero', () => {
    // `questionKeywords` drops `how`, `many`, `did`, `you`, `have` and the rest; a question made
    // only of them has no vocabulary, and `hits / 0` would be `NaN` in a table a reader acts on.
    const reading = measure({ ...TWO_BOOKS, question: 'How many did you have?' }, 'question');
    expect(reading.keywordsTried).toBe(0);
    expect(reading.plansTried).toBe(0);
    expect(reading.planShare).toBe(0);
    expect(reading.grammarCeiling).toBe(false);
  });
});

describe('the copy ceiling, which is not the grammar ceiling', () => {
  it('is true when a row states the gold and false when no row does', () => {
    const stated = measure({ ...TWO_BOOKS, answer: '10' }, 'question');
    expect(stated.copyCeiling).toBe(true);
    const absent = measure({ ...TWO_BOOKS, answer: '99' }, 'question');
    expect(absent.copyCeiling).toBe(false);
  });

  it('counts a question with no numeric gold as neither, because the grammar was never its instrument', () => {
    const named = measure({ ...TWO_BOOKS, answer: 'Lisbon' }, 'question');
    expect(named.goldNumbers).toEqual([]);
    expect(named.copyCeiling).toBe(false);
    expect(named.grammarCeiling).toBe(false);
  });
});

describe('the gate the pass will apply, carried on every row', () => {
  it('marks an enumeration question asking for a count as one the pass runs on', () => {
    expect(measure(TWO_BOOKS, 'question').tallyEligible).toBe(true);
    expect(
      measure({ ...TWO_BOOKS, question: 'How much did I spend in total?' }, 'question')
        .tallyEligible,
    ).toBe(true);
  });

  it('marks a derivation question and a question whose answer is a name as outside it', () => {
    // The two refusals `tally.ts` documents: a derivation would be summed into an age, and a maximum
    // has nothing to total.
    expect(
      measure(
        { ...TWO_BOOKS, question: 'How many years older am I than when I graduated?' },
        'question',
      ).tallyEligible,
    ).toBe(false);
    expect(
      measure({ ...TWO_BOOKS, question: 'Which city did I visit last?' }, 'question').tallyEligible,
    ).toBe(false);
  });

  it('is reported as a separate denominator rather than folded into the numerator', () => {
    const rows = [
      measure(TWO_BOOKS, 'question'),
      measure(
        {
          ...TWO_BOOKS,
          question_id: 'd',
          question: 'How many years older am I than when I graduated?',
        },
        'question',
      ),
      measure(
        { ...TWO_BOOKS, question_id: 'n', question: 'Which city did I visit last?' },
        'question',
      ),
      measure(
        { ...TWO_BOOKS, question_id: 't', answer: 'Lisbon', question: 'Which city did I visit?' },
        'question',
      ),
    ];
    const reading = summarise(rows, 'question');
    expect(reading.questions).toBe(4);
    // The text-answer question is outside the numeric population entirely.
    expect(reading.numeric).toBe(3);
    expect(reading.eligible).toBe(1);
    expect(reading.grammarOfEligible).toBeLessThanOrEqual(reading.eligible);
    expect(reading.grammar).toBeLessThanOrEqual(reading.numeric);
  });

  it('reports a median of zero when the population the pass reaches is empty', () => {
    // Not a not-a-number: a fold that divided by zero questions would print `NaN%` in a summary a
    // reader is meant to act on.
    const reading = summarise(
      [measure({ ...TWO_BOOKS, question: 'Which city did I visit last?' }, 'question')],
      'question',
    );
    expect(reading.eligible).toBe(0);
    expect(reading.planShareMedian).toBe(0);
  });
});

describe('a population named by hand', () => {
  const dataset = [
    corpusQuestion({ id: 'a', question: 'q', answer: '1', sessions: [['x']] }),
    corpusQuestion({ id: 'b', question: 'q', answer: '2', sessions: [['x']] }),
  ];

  it('takes the ids it was given and reports a missing one instead of dropping it', () => {
    const { selected, missing } = selectPopulation({
      dataset,
      artifact: null,
      population: { ids: ['a', 'gone'] },
      capability: null,
      includeCorrect: false,
    });
    expect(selected.map((entry) => entry.corpus.question_id)).toEqual(['a']);
    expect(missing).toEqual(['gone']);
  });

  it('reads the gold from the corpus when the population names no gold', () => {
    const { selected } = selectPopulation({
      dataset,
      artifact: null,
      population: { ids: ['b'] },
      capability: null,
      includeCorrect: false,
    });
    expect(selected[0]?.gold).toBe('2');
  });

  it('keeps the report cap and drops the questions the report already answered', () => {
    const { selected } = selectPopulation({
      dataset,
      artifact: {
        questions: [
          { questionId: 'a', question: 'q', capability: 'MR', groundTruth: '1', correct: false },
          { questionId: 'b', question: 'q', capability: 'MR', groundTruth: '2', correct: true },
        ],
      },
      population: null,
      capability: 'MR',
      includeCorrect: false,
    });
    expect(selected.map((entry) => entry.corpus.question_id)).toEqual(['a']);
  });

  it('drops a question from another capability, and keeps a correct one only when asked to', () => {
    const report = {
      questions: [
        { questionId: 'a', question: 'q', capability: 'MR', groundTruth: '1', correct: false },
        { questionId: 'b', question: 'q', capability: 'TR', groundTruth: '2', correct: false },
        { questionId: 'a', question: 'q', capability: 'MR', groundTruth: '1', correct: true },
      ],
    };
    const multiSession = selectPopulation({
      dataset,
      artifact: report,
      population: null,
      capability: 'MR',
      includeCorrect: false,
    });
    // Two MR rows, one wrong and one correct: only the wrong one is a failure to measure.
    expect(multiSession.selected).toHaveLength(1);
    const everything = selectPopulation({
      dataset,
      artifact: report,
      population: null,
      capability: 'MR',
      includeCorrect: true,
    });
    expect(everything.selected).toHaveLength(2);
  });

  it('selects nothing when neither a population nor a report was named, rather than throwing', () => {
    // The command line refuses this combination with a usage error before it reads a corpus, so the
    // function only has to be total; a throw here would be a crash in a gate rather than a message.
    const { selected, missing } = selectPopulation({
      dataset,
      artifact: null,
      population: null,
      capability: null,
      includeCorrect: false,
    });
    expect(selected).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('reports a question the report names and the corpus does not carry, rather than skipping it', () => {
    const { selected, missing } = selectPopulation({
      dataset,
      artifact: {
        questions: [
          { questionId: 'gone', question: 'q', capability: 'MR', groundTruth: '1', correct: false },
        ],
      },
      population: null,
      capability: null,
      includeCorrect: false,
    });
    expect(selected).toEqual([]);
    expect(missing).toEqual(['gone']);
  });

  it('reads the gold the report states rather than the corpus answer, because the report is the arm', () => {
    // A judge's gold and the corpus answer can differ; the ceiling has to be measured against the
    // one the run was graded on, or the two readings describe different questions.
    const { selected } = selectPopulation({
      dataset,
      artifact: {
        questions: [
          { questionId: 'a', question: 'q', capability: 'MR', groundTruth: '42', correct: false },
        ],
      },
      population: null,
      capability: null,
      includeCorrect: false,
    });
    expect(selected[0]?.gold).toBe('42');
  });
});

describe('the registered population cannot drift from the audit that names it', () => {
  // Four levels: this file sits in `src/__tests__/`, so `..` is `src`, `../..` the package,
  // `../../..` `packages/` and `../../../..` the repository root. The path is resolved rather than
  // guessed, and a wrong depth fails loudly here instead of quietly skipping the guard.
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const population = JSON.parse(
    readFileSync(`${root}tools/spec-ceiling-population.json`, 'utf8'),
  ) as PopulationFile & { numericGold: number; floor: number; required: number };
  const audit = readFileSync(`${root}docs/AUDIT-NUMERIC-MEMBERSHIP.md`, 'utf8');

  it('names twelve distinct questions, each of them in the audit', () => {
    expect(population.ids).toHaveLength(12);
    expect(new Set(population.ids).size).toBe(12);
    for (const id of population.ids) {
      expect(audit, `${id} is not named by the audit`).toContain(id);
    }
  });

  it('partitions the twelve into the audit three groups, six and four and two', () => {
    const groups = population.groups ?? [];
    expect(groups.map((group) => group.ids.length)).toEqual([6, 4, 2]);
    const union = groups.flatMap((group) => group.ids);
    expect([...union].sort()).toEqual([...population.ids].sort());
  });

  it('recomputes the required conversion rate from the ceiling and the paired floor', () => {
    // The floor is six questions of the 121 the capability carries, and the ceiling is the twelve
    // numeric failures, so the bar is six of twelve. Pinned as arithmetic so a later edit to either
    // number has to move this test rather than pass beside it.
    const gains = Math.round((population.floor / 100) * 121);
    expect(gains).toBe(6);
    expect(population.numericGold).toBe(12);
    expect(population.required).toBeCloseTo(gains / population.numericGold, 12);
  });

  it('carries the audit ceiling arithmetic, which is what makes the population worth measuring', () => {
    // 12/121 is the whole numeric institution and 10/121 the membership subset the audit isolates.
    expect(((population.numericGold / 121) * 100).toFixed(2)).toBe('9.92');
    expect(((10 / 121) * 100).toFixed(2)).toBe('8.26');
  });
});

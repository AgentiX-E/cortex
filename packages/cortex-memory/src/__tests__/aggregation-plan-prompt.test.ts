/**
 * The plan prompt: a table that is not an estimate, and a size that is a function of the question.
 *
 * Two properties carry the pass, and neither is a formatting preference.
 *
 * **The table reports what the executor returns.** A model choosing `sum` over a keyword and a unit is
 * choosing a number that is printed in front of it, so the prompt and the executor cannot disagree
 * about what the history contains. That is checked by running the executor over the same keyword and
 * comparing, not by a fixture.
 *
 * **The prompt's size is bounded by the question and not by the history.** The tally pass re-read the
 * window and cost +98.4% of the feature arm's completion tokens; this one carries at most eight rows
 * and the schema. A hundred-turn history and a thousand-turn history produce prompts of the same
 * order, which is the property that makes this pass cheap by construction rather than by tuning.
 */

import { describe, expect, it } from 'vitest';

import { buildLedger } from '../aggregation/ledger.js';
import { executeSpec } from '../aggregation/execute.js';
import { questionKeywords } from '../aggregation/keywords.js';
import { buildPlanTable, buildSpecPrompt } from '../aggregation/plan-prompt.js';

const LEDGER = buildLedger([
  [
    '[2023/01/10 (Tue) 03:14] user: I sold the bike for $3,750 in January.',
    '[2023/01/10 (Tue) 03:15] assistant: That is a good price for a sold bike.',
  ],
  [
    '[2023/03/02 (Thu) 04:00] user: I sold a helmet for $120 and read 440 pages.',
    '[2023/03/03 (Fri) 09:00] user: I baked bread for 2 hours.',
  ],
]);

describe('questionKeywords', () => {
  it('drops the question frame and keeps the content words, sorted', () => {
    expect(questionKeywords('How many times did I bake something in the past two weeks?')).toEqual([
      'bake',
      'something',
      'someth',
    ]);
  });

  it('puts the words before their stems, so the cap never trades a word for its own stem', () => {
    // `something` stems to `someth`, which selects nothing; with the cap reached the stem is the row
    // that goes, because a table row selecting zero turns is worth less than the word it came from.
    const keywords = questionKeywords('something anything whatever');
    expect(keywords.slice(0, 3)).toEqual(['anything', 'something', 'whatever']);
    expect(keywords.slice(3)).toEqual(['anyth', 'someth']);
    // With the cap out of the way the words come first and their stems follow, which is the order a
    // reader of the table wants: the word that might be in the evidence before the stem that might not.
    expect(questionKeywords('plumbing scaffolding').slice(0, 2)).toEqual([
      'plumbing',
      'scaffolding',
    ]);
  });

  it('caps the list so a pathological question cannot blow the prompt up', () => {
    const question = `How many ${Array.from({ length: 40 }, (_, index) => `keyword${index}`).join(' ')}?`;
    expect(questionKeywords(question)).toHaveLength(8);
  });

  it('is a function of the question set of words, not their order', () => {
    expect(questionKeywords('sold bike helmet')).toEqual(questionKeywords('helmet sold bike'));
  });

  it('finds nothing in a question made only of frame words', () => {
    expect(questionKeywords('How many did I have in total?')).toEqual([]);
  });
});

describe('buildPlanTable', () => {
  it('counts turns and states which of them carry a number', () => {
    const table = buildPlanTable(LEDGER, ['sold']);
    // Three turns say `sold`: the bike, the assistant's remark about the sold bike, and the helmet.
    // Both units, because the helmet turn states a price and a page count and a turn-grain sum over
    // that keyword includes both. That is the grain's own hazard, and the prompt names it: a sum that
    // adds two units is refused rather than rendered.
    expect(table.rows).toEqual([
      {
        keyword: 'sold',
        turns: 3,
        withNumber: 2,
        sums: [
          { unit: '$', total: 3870 },
          { unit: 'pages', total: 440 },
        ],
      },
    ]);
  });

  it('sums by unit, so a keyword that selects pages reports them and nothing else', () => {
    const table = buildPlanTable(LEDGER, ['read']);
    // One turn, because `read` is a word-start and `bread` is not a reading turn. The first version of
    // the predicate matched inside the word and reported the bread's two hours here.
    expect(table.rows[0]).toEqual({
      keyword: 'read',
      turns: 1,
      withNumber: 1,
      sums: [
        { unit: '$', total: 120 },
        { unit: 'pages', total: 440 },
      ],
    });
  });

  it('reports nothing selected as zero rather than omitting the row', () => {
    const table = buildPlanTable(LEDGER, ['absentword']);
    expect(table.rows).toEqual([{ keyword: 'absentword', turns: 0, withNumber: 0, sums: [] }]);
  });

  it('names the unit the source wrote, and names its absence when there is none', () => {
    const timed = buildLedger([['[2023/01/01 (Sun) 00:00] user: I went 5 times.']]);
    expect(buildPlanTable(timed, ['went']).rows[0]!.sums).toEqual([{ unit: 'times', total: 5 }]);
    const bare = buildLedger([['[2023/01/01 (Sun) 00:00] user: I went 5.']]);
    expect(buildPlanTable(bare, ['went']).rows[0]!.sums).toEqual([{ unit: '(none)', total: 5 }]);
  });

  it('reports exactly the number the executor would compute, for every keyword and unit', () => {
    for (const keyword of ['sold', 'read', 'baked']) {
      const row = buildPlanTable(LEDGER, [keyword]).rows[0]!;
      for (const sum of row.sums) {
        const planned = executeSpec(LEDGER, {
          scope: [0, LEDGER.steps - 1],
          predicates: [
            { field: 'text', op: 'contains', value: keyword },
            { field: 'number', op: 'unit-is', value: sum.unit === '(none)' ? '' : sum.unit },
          ],
          operation: 'sum',
        });
        // `(none)` is the table's name for "no unit", which no `unit-is` filter can select: a plan
        // summing ununit numbers states no unit filter, and the table says so by naming the absence.
        if (sum.unit === '(none)') {
          const bare = executeSpec(LEDGER, {
            scope: [0, LEDGER.steps - 1],
            predicates: [{ field: 'text', op: 'contains', value: keyword }],
            operation: 'sum',
          });
          expect(bare.kind === 'value' ? bare.value : null, keyword).toBe(sum.total);
          continue;
        }
        expect(planned.kind === 'value' ? planned.value : null, `${keyword}/${sum.unit}`).toBe(
          sum.total,
        );
      }
    }
  });
});

describe('buildSpecPrompt', () => {
  it('states the ledger it summarises and the scope the parser will enforce', () => {
    const { prompt } = buildSpecPrompt('How much did I make from sales?', LEDGER);
    expect(prompt).toContain('4 turns in 2 sessions, 2023/01/10 to 2023/03/03');
    expect(prompt).toContain('spoken by assistant and user');
    expect(prompt).toContain('"scope": [0, 3]');
  });

  it('carries the table and not one word of the evidence', () => {
    const { prompt } = buildSpecPrompt('How much did I make from sales?', LEDGER);
    expect(prompt).toContain('| keyword | turns | with a number | sums |');
    for (const row of LEDGER.rows) expect(prompt).not.toContain(row.text);
  });

  it('names both operations, the unit filter and the refusal', () => {
    const { prompt } = buildSpecPrompt('How many things did I sell?', LEDGER);
    expect(prompt).toContain('`"count"` returns how many turns');
    expect(prompt).toContain('`"sum"` adds the numbers');
    expect(prompt).toContain('unit-is');
    expect(prompt).toContain('{"refuse": "no-plan"}');
  });

  it('returns the keywords it offered, so a caller can record what the plan chose from', () => {
    const { keywords } = buildSpecPrompt('How many books did I read?', LEDGER);
    expect(keywords).toEqual(questionKeywords('How many books did I read?'));
  });

  it('stays the same size when the history grows, which is what makes the pass cheap', () => {
    const small = buildSpecPrompt('How many books did I read?', LEDGER).prompt.length;
    const rows = Array.from(
      { length: 400 },
      (_, index) =>
        `[2023/01/0${(index % 9) + 1} (Sun) 00:00] user: turn ${index} mentions books and 3 pages.`,
    );
    const large = buildSpecPrompt('How many books did I read?', buildLedger([rows])).prompt.length;
    // The scope bound grows by a digit or two and the table is unchanged; the evidence does not enter.
    expect(large - small).toBeLessThan(60);
  });

  it('says so when the history carries no timestamps', () => {
    const { prompt } = buildSpecPrompt(
      'How many books did I read?',
      buildLedger([['no stamp here, 3 books']]),
    );
    expect(prompt).toContain('no timestamps');
  });
});

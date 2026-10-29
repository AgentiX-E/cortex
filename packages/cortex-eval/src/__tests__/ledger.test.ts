/**
 * The portfolio: which questions two increments each bought, and whether it was the same ones.
 *
 * ## What this file pins, and why the identity is the point
 *
 * `discordantQuestions` already names the questions one pair of runs disagreed on. That answers "how many"
 * and "which" for a single increment, and it leaves the question that decides the roadmap unanswered: if
 * `silent` is worth +9 and `answer-line` is worth +6, is the pair worth +15 or +9? Both numbers are
 * consistent with the two artifacts, and no aggregate in this repository can tell them apart — a report
 * prints one delta per run and there is no field in any artifact that says whether two deltas are spent on
 * the same questions.
 *
 * So the tests below come in two kinds. The first kind builds portfolios by hand to pin the arithmetic.
 * The second kind is the one that keeps the module from drifting into a rival measurement: a single
 * increment's ledger must reproduce the count `runAblation` publishes, asserted against the real ablation
 * rather than against a fixture. If a future edit dedupes one list and not the other, or reorders `bought`
 * against `sold`, that assertion fails and names the disagreement.
 *
 * ## The refusal cases are the load-bearing ones
 *
 * An empty gain list and an unrecorded one render identically in a portfolio and mean opposite things: the
 * first says the increment bought nothing, the second says nobody kept the record. Every other instrument in
 * this package that reads an optional field had to make the same decision (`recoveryCensus`, the `ingest`
 * line, `rerankCensus`), and all of them choose to refuse rather than to substitute a zero. The same choice
 * is made here, and the message names the increment so a reader is not left guessing which artifact is old.
 */

import { describe, expect, it } from 'vitest';
import { ledgerOf, portfolioOf } from '../ledger.js';
import { runAblation } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import type { Answer, BenchmarkDataset, LedgerSource, MemorySystem } from '../types.js';

/** The shape `discordantQuestions` has, as a fixture, so a test can state its own lists. */
function ablationWith(bought: readonly string[], sold: readonly string[]): LedgerSource {
  return {
    discordantQuestions: {
      baselineIncorrectFeatureCorrect: bought,
      baselineCorrectFeatureIncorrect: sold,
    },
  };
}

const dataset: BenchmarkDataset = {
  name: 'portfolio-shapes',
  questions: [
    { id: 'q1', capability: 'MR', question: 'Q1', expected: 'a', context: ['a'] },
    { id: 'q2', capability: 'MR', question: 'Q2', expected: 'a', context: ['a'] },
    { id: 'q3', capability: 'IE', question: 'Q3', expected: 'a', context: ['a'] },
    { id: 'q4', capability: 'IE', question: 'Q4', expected: 'a', context: ['a'] },
    { id: 'q5', capability: 'TR', question: 'Q5', expected: 'a', context: ['a'] },
  ],
};

function scripted(name: string, answers: Record<string, Answer>): MemorySystem {
  return { name, answer: (question) => answers[question] ?? null };
}

describe('ledgerOf: one increment, read from the artifact that already records it', () => {
  it('carries the label and both lists exactly as the ablation published them', () => {
    const ledger = ledgerOf('silent', ablationWith(['q1', 'q3'], ['q5']));

    expect(ledger.label).toBe('silent');
    expect(ledger.bought).toEqual(['q1', 'q3']);
    expect(ledger.sold).toEqual(['q5']);
  });

  it('refuses an artifact that did not record the identity instead of reading it as an empty list', () => {
    // The real case this guards: every report generated before `discordantQuestions` existed. Its
    // `bought` list is absent, and a portfolio built from it would silently claim the increment bought
    // nothing -- the same rendering as a genuine zero, with the opposite meaning.
    const legacy: LedgerSource = {};

    expect(() => ledgerOf('legacy', legacy)).toThrow(/legacy/);
    expect(() => ledgerOf('legacy', legacy)).toThrow(/discordantQuestions/);
  });

  it('reproduces the count the ablation publishes, against the real ablation', async () => {
    // Two questions bought, one sold, and the aggregate counts must agree with the lists: this is the
    // identity that stops the ledger from becoming a second measurement of the same thing.
    const ab = await runAblation(
      dataset,
      // Keys are the question TEXT, not the id: `runAblation` hands the system `question.question`
      // and the system has no idea what the dataset calls the row.
      scripted('baseline', { Q1: 'b', Q2: 'a', Q3: 'a', Q4: 'b', Q5: 'a' }),
      scripted('feature', { Q1: 'a', Q2: 'a', Q3: 'a', Q4: 'a', Q5: 'b' }),
      { runs: 1, scorer: exactMatchScorer },
    );

    const ledger = ledgerOf('real', ab);

    expect(ledger.bought).toEqual(ab.discordantQuestions.baselineIncorrectFeatureCorrect);
    expect(ledger.sold).toEqual(ab.discordantQuestions.baselineCorrectFeatureIncorrect);
    expect(ledger.bought).toHaveLength(ab.discordant.baselineIncorrectFeatureCorrect);
    expect(ledger.sold).toHaveLength(ab.discordant.baselineCorrectFeatureIncorrect);
    expect(ledger.bought).toEqual(['q1', 'q4']);
    expect(ledger.sold).toEqual(['q5']);
  });

  it('refuses a list that names the same question twice', () => {
    // A duplicate means the artifact is corrupt -- a run cannot buy the same question twice. Deduping
    // would repair the corruption invisibly, and the repaired list would then disagree with the count
    // printed one line above it in the same report.
    expect(() => ledgerOf('corrupt', ablationWith(['q1', 'q1'], []))).toThrow(/corrupt/);
    expect(() => ledgerOf('corrupt', ablationWith(['q1', 'q1'], []))).toThrow(/q1/);
  });
});

describe('portfolioOf: the number two increments are worth together', () => {
  it('unions the purchases in first-appearance order and adds nothing to them', () => {
    const portfolio = portfolioOf([
      ledgerOf('silent', ablationWith(['m1', 'm2', 'm3'], [])),
      ledgerOf('answer-line', ablationWith(['i1', 'i2'], [])),
    ]);

    expect(portfolio.bought).toEqual(['m1', 'm2', 'm3', 'i1', 'i2']);
    expect(portfolio.summedBought).toBe(5);
    // The sum and the union agree only when nothing was bought twice; that equality is the claim a
    // "+9 and +6, so +15" sentence is making, and it is what this module exists to check.
    expect(portfolio.summedBought - portfolio.bought.length).toBe(0);
    expect(portfolio.doubleCounted).toEqual([]);
  });

  it('names the questions a naive sum counts twice', () => {
    const portfolio = portfolioOf([
      ledgerOf('silent', ablationWith(['m1', 'm2', 'shared'], [])),
      ledgerOf('answer-line', ablationWith(['shared', 'i1'], [])),
    ]);

    expect(portfolio.bought).toEqual(['m1', 'm2', 'shared', 'i1']);
    expect(portfolio.summedBought).toBe(5);
    expect(portfolio.doubleCounted).toEqual(['shared']);
    expect(portfolio.summedBought - portfolio.bought.length).toBe(portfolio.doubleCounted.length);
  });

  it('names a question bought by three increments once, not twice', () => {
    // A roster of three arms is the shape a re-measurement produces: the same increment dispatched twice,
    // then a third on top. Counting the repetition would report two double-counted questions where there
    // is one, and the union arithmetic is what a roadmap sentence quotes.
    const portfolio = portfolioOf([
      ledgerOf('a', ablationWith(['shared'], [])),
      ledgerOf('b', ablationWith(['shared'], [])),
      ledgerOf('c', ablationWith(['shared'], [])),
    ]);

    expect(portfolio.bought).toEqual(['shared']);
    expect(portfolio.doubleCounted).toEqual(['shared']);
    expect(portfolio.summedBought).toBe(3);
  });

  it('reports a question one increment bought and another sold, which a sum of nets cancels to nothing', () => {
    // This is the failure a portfolio catches that no delta can: +1 and -1 sum to zero, and the truth
    // is that two increments moved the same question in opposite directions. A reader shown only the
    // sum would conclude neither increment touched it.
    const portfolio = portfolioOf([
      ledgerOf('silent', ablationWith(['q7'], [])),
      ledgerOf('answer-line', ablationWith([], ['q7'])),
    ]);

    expect(portfolio.conflicting).toEqual(['q7']);
    expect(portfolio.bought).toEqual(['q7']);
    expect(portfolio.sold).toEqual(['q7']);
    // The cancellation, stated as arithmetic: the summed nets of the two increments are +1 and -1.
    expect(portfolio.summedBought - portfolio.summedSold).toBe(0);
  });

  it('unions the losses too, because the same question can be lost twice', () => {
    const portfolio = portfolioOf([
      ledgerOf('a', ablationWith([], ['x', 'y'])),
      ledgerOf('b', ablationWith([], ['y', 'z'])),
    ]);

    expect(portfolio.sold).toEqual(['x', 'y', 'z']);
    expect(portfolio.summedSold).toBe(4);
  });

  it('treats zero increments as a legal portfolio rather than an error', () => {
    // Before any dispatch there is nothing to report, and a caller that renders the section anyway
    // should get empty sets instead of a crash.
    const portfolio = portfolioOf([]);

    expect(portfolio).toEqual({
      bought: [],
      sold: [],
      doubleCounted: [],
      conflicting: [],
      summedBought: 0,
      summedSold: 0,
    });
  });

  it('never mutates the lists it was handed', () => {
    const bought = ['m1'];
    const ledger = ledgerOf('silent', ablationWith(bought, []));
    portfolioOf([ledger, ledgerOf('other', ablationWith(['m2'], []))]);

    expect(bought).toEqual(['m1']);
    expect(ledger.bought).toEqual(['m1']);
  });
});

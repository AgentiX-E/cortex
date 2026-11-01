/**
 * The two classifiers, held to the same answers.
 *
 * `cortex-memory/src/question-shape.ts` says, in its own docblock, that the coupling between the two
 * copies of this regex is a **test** rather than a cycle. The sentence named
 * `cortex-eval`'s `question-shape-parity.test.ts`, a file that did not exist, and it also had the
 * dependency backwards: `cortex-memory` carries `cortex-eval` as a devDependency, so the parity test
 * can only live here. This file is the guarantee the sentence claimed.
 *
 * ## Why it imports the barrel, and what that constrains
 *
 * The obvious stronger form — importing `../../../cortex-eval/src/natural-language-memory.js` so the
 * test compares two *source texts* — does not build: `cortex-memory`'s `tsconfig.json` pins `rootDir`
 * to its own `src`, and a cross-package source import is `TS6059` ("not under rootDir") at compile
 * time. So the import is the facade, and the test therefore reads whatever `cortex-eval` last built.
 *
 * That is acceptable only because `pnpm check` builds before it tests, which is the order turbo
 * enforces in CI. It was not acceptable while this file was being written: with a one-build-stale
 * `dist`, six questions read `enumeration` from one side and `derivation` from the other, and the
 * failure looks like a pattern divergence rather than what it is. Anyone running this file alone after
 * editing the classifier must build that package first — which the failure mode makes obvious, because
 * it is exactly six questions and they are the six the last classifier change touched.
 *
 * ## And why it pins the current reading rather than only the agreement
 *
 * Agreement alone is satisfied by two classifiers that are wrong together. The table below is the
 * shipped boundary, question by question, and it is pinned so that widening either copy is a
 * deliberate act with a failing test rather than an edit that quietly moves 121 questions onto a
 * different contract. §13.211 has the measurement behind that warning: widening this pattern to read
 * totals as derivations reaches **19 MR questions of which 13 are currently correct and 6 wrong**, so
 * the increment was implemented, measured, and **not dispatched** — the change cannot reach the six
 * without also re-contracting the thirteen.
 */

import { describe, expect, it } from 'vitest';

import { classifyAggregationKind } from '@agentix-e/cortex-eval';

import { classifyQuestionShape } from '../question-shape.js';

/**
 * The shipped boundary, as a table.
 *
 * Each `derivation` row is a question whose answer is a value computed from numbers and stated
 * nowhere in the evidence. Each `enumeration` row is a question whose answer is the size of a set of
 * items — including six that ask for a *total*, which is deliberate and is the subject of §13.211.
 */
const BOUNDARY: ReadonlyArray<readonly [string, 'derivation' | 'enumeration']> = [
  ['What percentage of packed shoes did I wear on my last trip?', 'derivation'],
  ['What percentage discount did I get on the book from my favorite author?', 'derivation'],
  ['How old was I when Alex was born?', 'derivation'],
  ['How many years older is my grandma than me?', 'derivation'],
  ['How many years older am I than when I graduated from college?', 'derivation'],
  ['How long have I been working in my current role?', 'derivation'],
  ['What is the average age of my family?', 'derivation'],

  // The six totals §13.211 measured and left alone. A total has no items to list, so the
  // enumeration contract is a poor fit for them — and the operand contract reaches them only by
  // also re-contracting thirteen questions that are already right.
  ['How much money did I raise for charity in total?', 'enumeration'],
  [
    'How much total money did I spend on attending workshops, lectures, and conferences?',
    'enumeration',
  ],
  ['What is the total amount of money I earned from selling my old belongings?', 'enumeration'],
  [
    'What is the total number of views on my most popular videos on YouTube and TikTok?',
    'enumeration',
  ],
  [
    'What was the page count of the two novels I finished reading in January and March?',
    'enumeration',
  ],
  ['How many years in total did I spend in formal education?', 'enumeration'],

  ['How many items of clothing do I need to pick up or return from a store?', 'enumeration'],
  ['How many movie festivals that I attended?', 'enumeration'],
  [
    'How many babies were born to friends and family members in the last few months?',
    'enumeration',
  ],
  ['How many times did I bake something in the past two weeks?', 'enumeration'],
  ['How many properties did I view before making an offer on the townhouse?', 'enumeration'],
  ['How many health-related devices do I use in a day?', 'enumeration'],
  ['How many fitness classes do I attend in a typical week?', 'enumeration'],
  ['How many music albums or EPs have I purchased or downloaded?', 'enumeration'],
  [
    'How many total pieces of writing have I completed since I started writing again?',
    'enumeration',
  ],
  ['How many fun runs did I miss in March due to work commitments?', 'enumeration'],
  ['How many days did I spend attending workshops, lectures, and conferences?', 'enumeration'],
  ['How many different art-related events did I attend in the past month?', 'enumeration'],
  ["What time did I go to bed on the day before I had a doctor's appointment?", 'enumeration'],
  ['How many days did it take for my laptop backpack to arrive after I bought it?', 'enumeration'],
  ['How many hours do I work in a typical week during peak campaign seasons?', 'enumeration'],
  ['How many albums in total have I bought?', 'enumeration'],
];

describe('the two copies of the derivation pattern', () => {
  it('agree on every question in the table', () => {
    for (const [question] of BOUNDARY) {
      // `toBe` rather than a length comparison: the two return types are structurally identical
      // today, and a third value on one side is exactly the drift this file exists to catch.
      expect(classifyAggregationKind(question), question).toBe(classifyQuestionShape(question));
    }
  });

  it('agree on the degenerate inputs that would otherwise be the way in', () => {
    for (const question of ['', ' ', 'How many?', 'WHAT PERCENTAGE of shoes?']) {
      expect(classifyAggregationKind(question), question).toBe(classifyQuestionShape(question));
    }
  });
});

describe('the shipped boundary', () => {
  for (const [question, shape] of BOUNDARY) {
    it(`reads ${shape}: ${question.slice(0, 56)}`, () => {
      expect(classifyQuestionShape(question)).toBe(shape);
    });
  }

  it('does not read a count of countable objects as a total', () => {
    // The near miss any widening has to survive: `total` is present, the noun is a countable object
    // rather than an additive quantity, and the gold is `23` — a count of pieces of writing.
    expect(
      classifyQuestionShape(
        'How many total pieces of writing have I completed since I started writing again?',
      ),
    ).toBe('enumeration');
    expect(classifyQuestionShape('How many albums in total have I bought?')).toBe('enumeration');
  });

  it('does not read a percentile as a percentage', () => {
    // A boundary marker on the alternatives is what stops this; without one, `percent` matches
    // inside `percentile` and a rank question is sent to the operand contract.
    expect(classifyQuestionShape('What was my percentile rank on the exam?')).toBe('enumeration');
  });
});

import { describe, expect, it } from 'vitest';

import {
  asksForCount,
  buildRecoveryPrompt,
  DECLINE_TOKEN,
  declinedItems,
  planAbstentionRecovery,
} from '../abstention-recovery.js';
import { ABSTAIN_TOKEN } from '../parse.js';

/**
 * Real replies from run `39367801501`, whose shape is the reason this module exists.
 *
 * They are abbreviated but not rewritten: the heads and tails are what the artifact holds, and the
 * two that matter are the echo (a model repeating the contract) and the honest decline (a list that
 * answers nothing).
 */
const ECHO_DECLINE = [
  "Step 1 — list every item in the evidence that matches the question, one per line, with the date it was stated. Use the question's own wording for the action and do not substitute a similar one.",
  '',
  'The evidence does not state the date the laptop backpack was bought, only that it arrived on 1/20; therefore the number of days between purchase and arrival cannot be computed.',
  '',
  DECLINE_TOKEN,
].join('\n');

const LISTED_DECLINE = [
  'Step 1:',
  '- Session 34, turn 3 [9b1c46b6] [2023/05/27]: "the new release from my favorite author, originally priced at $30" (mentions original price but no discount percentage)',
  '',
  'Step 2:',
  'The relevant items list is not empty (one item exists about the book), but it contains no discount value to compute.',
  '',
  DECLINE_TOKEN,
].join('\n');

const EMPTY_DECLINE = [
  'Step 1 — items matching the question:',
  '- No item in the evidence states a novel finished in January with a page count.',
  '- No item in the evidence states a novel finished in March with a page count.',
  '',
  'Step 2:',
  'The list is empty.',
  '',
  DECLINE_TOKEN,
].join('\n');

describe('the decline token is the one the parser reads', () => {
  it('matches ABSTAIN_TOKEN, because a test is what couples them', () => {
    // The two literals are in different layers and cannot share a constant without a cycle; see
    // the module's own note. If `parse.ts` renames the token, this fails rather than the recovery
    // silently ceasing to recognise a decline.
    expect(DECLINE_TOKEN).toBe(ABSTAIN_TOKEN);
  });
});

describe('declinedItems', () => {
  it('reads the bullets before the Step 2 heading', () => {
    expect(declinedItems(LISTED_DECLINE)).toHaveLength(1);
    expect(declinedItems(LISTED_DECLINE)[0]).toContain('favorite author');
  });

  it('reads nothing from a reply that repeated the contract instead of following it', () => {
    // Three of the ten MR declines in `39367801501` look like this: the contract's own sentence on
    // one line, then a sentence of reasoning. Nothing here is a listed item, and quoting the
    // contract back as evidence would be the worst possible prompt.
    expect(declinedItems(ECHO_DECLINE)).toEqual([]);
  });

  it('reads an empty list as empty, even when it is spelled out as two bullets', () => {
    // "No item in the evidence states ..." is a bullet *about* the absence of items. Both lines are
    // longer than the floor, so the pattern alone would count them; they are excluded because a
    // retry that quotes two negations back would be asking the model to count its own apology.
    // This is the honest-decline case the contract licenses, and it must not be corrected.
    const items = declinedItems(EMPTY_DECLINE);
    expect(items).toEqual([]);
  });

  it('reads numbered items and a middot bullet', () => {
    const raw = [
      'Step 1:',
      '1. A peace lily from the nursery, dated 2023/05/20',
      '• A succulent, dated 2023/05/20',
      '',
      'Step 2: cannot compute',
    ].join('\n');
    expect(declinedItems(raw)).toHaveLength(2);
  });

  it('ignores a bullet the model wrote while explaining its refusal', () => {
    // The Step 2 heading ends the list, so an excuse written after it is not an item even though it
    // is a bullet.
    const raw = [
      'Step 1:',
      '- One item about the book, dated 2023/05/27',
      '',
      'Step 2:',
      '- I cannot find the discount percentage anywhere in the evidence',
      DECLINE_TOKEN,
    ].join('\n');
    expect(declinedItems(raw)).toHaveLength(1);
    expect(declinedItems(raw)[0]).toContain('One item about the book');
  });

  it('ignores a placeholder bullet too short to be an item', () => {
    // `- n/a`, `- none found`, `- ?` are shapes a model writes when a list has a hole in it. Quoting
    // one back as evidence would be asking the model to count its own placeholder.
    const raw = [
      'Step 1:',
      '- n/a',
      '- ?',
      '- One real item with enough text in it',
      '',
      'Step 2:',
      DECLINE_TOKEN,
    ].join('\n');
    expect(declinedItems(raw)).toEqual(['One real item with enough text in it']);
  });

  it('keeps at most forty items, so the retry prompt stays a prompt', () => {
    const raw = [
      'Step 1:',
      ...Array.from({ length: 60 }, (_, i) => `- Item number ${i} with enough text to count`),
      '',
      'Step 2:',
      DECLINE_TOKEN,
    ].join('\n');
    expect(declinedItems(raw)).toHaveLength(40);
  });

  it('reads nothing at all from an empty reply', () => {
    expect(declinedItems('')).toEqual([]);
  });
});

describe('planAbstentionRecovery', () => {
  it('does nothing when the feature was not asked for', () => {
    expect(planAbstentionRecovery(LISTED_DECLINE, false, false)).toEqual({
      kind: 'none',
      why: 'disabled',
    });
  });

  it('does nothing when the reader answered', () => {
    expect(planAbstentionRecovery(LISTED_DECLINE, true, true)).toEqual({
      kind: 'none',
      why: 'answered',
    });
  });

  it('does nothing when the decline was honest', () => {
    expect(planAbstentionRecovery(EMPTY_DECLINE, false, true)).toEqual({
      kind: 'none',
      why: 'no-list',
    });
  });

  it('retries with the list when the reader declined despite listing items', () => {
    const plan = planAbstentionRecovery(LISTED_DECLINE, false, true);
    expect(plan.kind).toBe('retry');
    if (plan.kind !== 'retry') throw new Error('expected a retry');
    expect(plan.items).toHaveLength(1);
  });

  it('treats a missing raw reply as no list rather than throwing', () => {
    // `rawOutput` is `null` when the arm captured nothing. A recovery that threw here would turn a
    // measurement gap into a failed run.
    expect(planAbstentionRecovery(null, false, true)).toEqual({ kind: 'none', why: 'no-list' });
  });
});

describe('asksForCount', () => {
  it('sees the phrasings the benchmark uses', () => {
    for (const question of [
      'How many items of clothing do I need to pick up or return from a store?',
      'What is the total number of views on my most popular videos?',
      'What is the number of plants I bought?',
    ]) {
      expect(asksForCount(question)).toBe(true);
    }
  });

  it('does not see a question that asks for a value', () => {
    expect(asksForCount('What percentage discount did I get on the book?')).toBe(false);
  });
});

describe('buildRecoveryPrompt', () => {
  const question = 'How many plants did I acquire in the last month?';
  const items = ['A peace lily, dated 2023/05/20', 'A succulent, dated 2023/05/20'];

  it('quotes every item, numbered, and never re-sends evidence', () => {
    const prompt = buildRecoveryPrompt(question, items);
    expect(prompt).toContain('1. A peace lily, dated 2023/05/20');
    expect(prompt).toContain('2. A succulent, dated 2023/05/20');
    expect(prompt).toContain(`QUESTION: ${question}`);
    expect(prompt).not.toContain('EVIDENCE:');
  });

  it('tells a counting question that the list length is the answer', () => {
    expect(buildRecoveryPrompt(question, items)).toContain(
      'the answer is the number of distinct items in the list',
    );
  });

  it('does not tell a value question that, because a count would be invented', () => {
    const prompt = buildRecoveryPrompt('What percentage discount did I get on the book?', items);
    expect(prompt).not.toContain('the number of distinct items in the list');
    expect(prompt).toContain(DECLINE_TOKEN);
  });
});

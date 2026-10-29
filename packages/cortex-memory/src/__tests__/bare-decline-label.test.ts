/**
 * A decline written in the shape the prompt asked for is still a decline.
 *
 * ## The measurement this is written against
 *
 * Run `40807829150` dispatched `ask: answer-line`, whose block requires one line of the form
 * `Answer: <phrase>`. A reader that ran out of evidence declined **in that form**, and the two layers
 * disagreed about it:
 *
 * | layer | reads `Answer: INSUFFICIENT_EVIDENCE` as |
 * | --- | --- |
 * | `parse.ts` (`isAbstention`, via `stripDecoration`) | a decline — the label is presentation |
 * | `isBareDecline` before this fix | **content** — `Answer:` survived the token strip |
 *
 * The consequence is not a mis-scored answer, it is a **disabled mechanism**: the bare-decline retry
 * fires only on a bare decline, so it reported `attempted: 0` on those questions and the artifact had
 * no field saying a recovery pass existed and did not run. Six IE questions in that run end at exactly
 * that string, and the control converts 92 of 92 bare declines into answers when the pass does fire.
 *
 * ## Why the fix is here and not in the ask
 *
 * A prompt must not be able to switch off a recovery path by naming a reply shape — that is a hidden
 * coupling between two layers that no artifact can show. So the predicate now reads decoration through
 * `parse.ts`'s own function: one definition of "which part of a reply is presentation", two callers.
 * The second half of this file holds the two layers together over the shapes a model actually emits.
 */

import { describe, expect, it } from 'vitest';

import { isBareDecline } from '../abstention-recovery.js';
import { ABSTAIN_TOKEN, isAbstention, parseAnswer, stripDecoration } from '../parse.js';

describe('isBareDecline reads a labelled token as the token', () => {
  const LABELLED = [
    `Answer: ${ABSTAIN_TOKEN}`,
    // A trailing period is content by the shared rule -- `isAbstention` refuses `TOKEN.` too -- so it
    // is deliberately absent from this list rather than tolerated: the two layers must agree on every
    // shape, and this file's third block asserts that they do.
    `answer: ${ABSTAIN_TOKEN}`,
    `Answer - ${ABSTAIN_TOKEN}`,
    `Answer: **${ABSTAIN_TOKEN}**`,
    `**Answer: ${ABSTAIN_TOKEN}**`,
    `Final answer: ${ABSTAIN_TOKEN}`,
    `"${ABSTAIN_TOKEN}"`,
  ];

  for (const raw of LABELLED) {
    it(`treats ${JSON.stringify(raw)} as bare`, () => {
      expect(isBareDecline(raw)).toBe(true);
    });
  }

  it('treats the plain token as bare, which is every prior artifact', () => {
    // The behaviour that must not change: 29 of ABS's 30 correct answers and 92 retries per run of
    // the control arm are this exact string.
    expect(isBareDecline(ABSTAIN_TOKEN)).toBe(true);
    expect(isBareDecline(`  ${ABSTAIN_TOKEN}\n`)).toBe(true);
  });
});

describe('isBareDecline still refuses everything that carries content', () => {
  const ENGAGED = [
    // The list-then-decline shape the recovery pass exists for: it quotes the list, so it is not bare.
    `1. Spitfire kit\n2. Paint\n\n${ABSTAIN_TOKEN}`,
    // Reasoning then a decision: the reader engaged.
    `The evidence names two kits but not the count.\n\n${ABSTAIN_TOKEN}`,
    // A prose decline, which is a different failure and not this pass's population.
    'No evidence items match the question about a Miami hotel.',
    // A token mentioned inside prose is a mention, not a decision.
    `${ABSTAIN_TOKEN} was the wrong call here`,
    // The label survives when there is content beside it.
    `Answer: ${ABSTAIN_TOKEN}\n\nbecause the list is empty`,
  ];

  for (const raw of ENGAGED) {
    it(`refuses ${JSON.stringify(raw.slice(0, 40))}`, () => {
      expect(isBareDecline(raw)).toBe(false);
    });
  }

  it('refuses null and the empty reply, which are different states', () => {
    expect(isBareDecline(null)).toBe(false);
    expect(isBareDecline('')).toBe(false);
    expect(isBareDecline('   \n ')).toBe(false);
  });
});

describe('the two layers agree about what a decline is', () => {
  /**
   * Every shape above, plus the ones only one layer used to accept.
   *
   * `isBareDecline` implies `isAbstention` — a reply that is the token and nothing else is a decision
   * by the last-line rule — and the converse must fail only where content remains, which is exactly
   * what the two tests above separate. Asserting the implication here catches the drift that produced
   * the defect: a new decoration shape accepted by `parse.ts` and not by this predicate.
   */
  const CORPUS = [
    ABSTAIN_TOKEN,
    `Answer: ${ABSTAIN_TOKEN}`,
    `**${ABSTAIN_TOKEN}**`,
    `Answer: **${ABSTAIN_TOKEN}**`,
    `\`${ABSTAIN_TOKEN}\``,
    `“${ABSTAIN_TOKEN}”`,
    `Step 1: two kits\nStep 2: ${ABSTAIN_TOKEN}`,
    'Spitfire',
    'Answer: Spitfire',
    '',
  ];

  for (const raw of CORPUS) {
    it(`agrees on ${JSON.stringify(raw)}`, () => {
      if (isBareDecline(raw)) expect(isAbstention(raw)).toBe(true);
      // And the parsed answer agrees with the decoration rule rather than with the raw string.
      const answer = parseAnswer(raw);
      if (isBareDecline(raw)) expect(answer).toBeNull();
    });
  }

  it('shares one decoration rule rather than two', () => {
    // The property that makes the agreement structural: `stripDecoration` is idempotent, and a
    // decorated token strips to the token itself.
    expect(stripDecoration(`Answer: **${ABSTAIN_TOKEN}**`)).toBe(ABSTAIN_TOKEN);
    expect(stripDecoration(stripDecoration(`Answer: **${ABSTAIN_TOKEN}**`))).toBe(ABSTAIN_TOKEN);
  });
});

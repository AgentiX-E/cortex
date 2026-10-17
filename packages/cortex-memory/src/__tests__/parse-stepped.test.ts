/**
 * A response that writes out the two-step contract must not be scored as a whole.
 *
 * ## The defect, measured
 *
 * `parseAnswer` returns the **whole** trimmed response as the answer. That was
 * harmless while answers were short -- `computed`'s MR responses have a median
 * length of **3 characters** -- and it became decisive the moment an ask made the
 * responses long. Run `38953157688` (`ask: enumerated`) answered 118 of its 121
 * multi-session questions by writing the contract's own two lines back out, with
 * the model's real answer on the final line:
 *
 *     Step 1 — list every item in the evidence that matches the question, ...
 *
 *     - [2023/05/21 (Sun) 09:03] I am planning a project in Nigeria ...
 *     - [2023/05/28 (Sun) 03:42] I was promoted to a senior software engineer ...
 *
 *     Step 2 — compute the answer from that list, ...
 *
 *     3
 *
 * The arm returned the first line plus everything after it -- a 349-character
 * answer -- and the scorer's exact and numeric gates can never match a gold like
 * `3.5 weeks` against that. Across the 121 MR questions the share of verdicts the
 * gates decided fell **37 -> 0** and the share the LLM judge decided rose
 * **35 -> 88**, while 41 of the responses end with a line that IS the gold. The
 * contract's apparent +4.95pp on MR is therefore at least as much a statement
 * about `judgeScorer`'s tolerance of a long enumerated list as about the answers.
 *
 * ## Why this repair is inert on every archived run
 *
 * A step heading appears in **0 of the 1,000** questions of runs `38595325261` and
 * `38828538851`, and in **118** of run `38953157688`'s 121 multi-session questions.
 * So the rule below cannot fire on a run whose numbers are published, and every
 * archived comparison stays exactly as it was. That is measured, not assumed:
 * `test_the_reader_and_the_prompt_cannot_drift_apart` pins the pattern against the
 * contract's own lines, and the rule is keyed on the heading rather than on length
 * so that a prose answer which happens to be long is still returned whole.
 */

import { describe, expect, it } from 'vitest';

import type { AdmittedTurn } from '../admission.js';
import type { AdmittedSession } from '../sessionize.js';
import { parseAnswer } from '../parse.js';
import { buildSessionPrompt } from '../prompt.js';

/** The smallest admitted turn the prompt accepts, matching the arm's own shape. */
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
    ordinal: 0,
  };
}

/** The first record of run `38953157688` that carries the contract's two lines. */
const ECHOED = [
  "Step 1 — list every item in the evidence that matches the question, one per line, with the date it was stated. Use the question's own wording for the action and do not substitute a similar one. Treat one event mentioned in several turns as one item, and do not merge two items into one.",
  '',
  '- [2023/05/21 (Sun) 09:03] I am planning a project in Nigeria that connects 100 rural villages to running water.',
  '- [2023/05/28 (Sun) 03:42] I was promoted to a senior software engineer position three months ago.',
  '',
  'Step 2 — compute the answer from that list, exactly as the question asks: the number of distinct items, the total of the durations or amounts, or the single value or event it names. Do not re-filter the list at this step.',
  '',
  '3',
].join('\n');

describe('a stepped response is scored by its answer, not by its transcript', () => {
  it('returns what follows the last heading', () => {
    expect(parseAnswer(ECHOED)).toBe('3');
  });

  it('does not return the transcript', () => {
    const answer = parseAnswer(ECHOED) as string;
    expect(answer).not.toContain('Step 1');
    expect(answer.length).toBeLessThan(20);
  });

  it('returns a blank answer when the heading is all there is', () => {
    // The boundary, measured before it was written: of run `38953157688`'s 118
    // step-headed multi-session responses, **118** put the answer on its own line
    // after the last heading, and **0** put it on the heading line itself. So the
    // unobserved shape is answered conservatively rather than guessed at: a heading
    // with nothing after it is a blank answer, which scores nothing, and never the
    // transcript, which is what this repair exists to stop being scored.
    const headingOnly = 'Step 1 — list the items\n\nStep 2 — compute the answer from that list';
    expect(parseAnswer(headingOnly)).toBe('');
    expect(parseAnswer(headingOnly)).not.toContain('Step 2');
  });

  it('still declines when the response declines, list and all', () => {
    // The load-bearing precedence. 29 of run `38953157688`'s multi-session
    // responses write the Step 1 list and then the sentinel; if the heading rule
    // ran before the abstention rule those 29 would become *answers*, and the
    // abstention rate -- prediction 1's number -- would read 4 instead of 33.
    const declining = `${ECHOED.slice(0, ECHOED.lastIndexOf('\n3'))}\nINSUFFICIENT_EVIDENCE`;
    expect(parseAnswer(declining)).toBeNull();
  });

  it('leaves a response with no heading exactly as it was', () => {
    // The archived-comparability guard, and the reason the rule is keyed on the
    // heading rather than on length: a long prose answer with no step in it is
    // still returned whole.
    const prose = 'The user visited three different doctors.\n\nOf those, two were specialists.';
    expect(parseAnswer(prose)).toBe(prose);
    expect(parseAnswer('2')).toBe('2');
  });

  it('does not treat a mention of a step as a heading', () => {
    // The heading is a line that OPENS with it. `Step 1` inside a sentence is a
    // mention, and truncating there would delete the answer.
    const mentioned = 'I followed Step 1 of the method and the answer is 7.';
    expect(parseAnswer(mentioned)).toBe(mentioned);
  });

  it('the reader and the prompt cannot drift apart', () => {
    // §13.36's rule applied to a pair that cannot share a constant: `prompt.ts`
    // imports `ABSTAIN_TOKEN` from `parse.ts`, so the parser may not import the
    // contract back, and the prompt must not be made to export it merely so a test
    // can read it. So the guard builds the REAL prompt and drives the parser with an
    // echo of it -- strictly stronger than comparing two constants, because it also
    // fails if the contract stops reaching the multi-session route at all.
    const session: AdmittedSession = {
      index: 0,
      size: 2,
      turns: [turn('I planned a project in Nigeria.'), turn('I was promoted.')],
    };
    const { prompt } = buildSessionPrompt('How many events are there?', [session], {
      ask: 'enumerated',
    });

    const headings = prompt.split('\n').filter((line) => /^\s*Step\s/i.test(line));
    expect(headings.length).toBe(2);

    // The model echoes the contract and then answers, which is the shape 118 of run
    // `38953157688`'s 121 multi-session responses had.
    const echoed = `${headings.join('\n\n')}\n\n2`;
    expect(parseAnswer(echoed)).toBe('2');
  });
});

/**
 * The Step 1 list is the licence to decline, and a non-empty list withdraws it.
 *
 * ## The measurement behind this
 *
 * §13.53 priced run `39005914398`'s 82 declines against what their own coverage band is
 * worth in the same capability: MR's 28 declines sit at 52.8% median coverage, inside the
 * band where MR answers 67% correctly, so about 19 of them would have been right. TR's 41
 * at 39.7% sit in a 48% band (about 20), IE's 13 at 42.9% in a 60% band (about 8).
 *
 * ## What the contract said, and what it now says
 *
 * It said: *"Do not reply INSUFFICIENT_EVIDENCE without first writing the Step 1 list."*
 * That forbids a bare decline and **permits declining after a list** — and the lists the
 * model writes are long. Of MR's 28 declines, every one names at least 7 gold turns and
 * carries a median of 12, so the model is enumerating evidence and then declining with it
 * in hand.
 *
 * The repair does not tell the model to answer more. It makes the list the deciding fact:
 * **decline only when the list is empty.** An empty list is a real state — §13.51.2's
 * 0-coverage band declines 100% of the time and is right to — while a non-empty list means
 * there is a number to compute, even if the list is short.
 */
describe('a non-empty Step 1 list withdraws the licence to decline', () => {
  const session: AdmittedSession = {
    index: 0,
    size: 2,
    turns: [turn('I planned a project in Nigeria.'), turn('I was promoted.')],
  };

  const sessionPrompt = (): string =>
    buildSessionPrompt('How many events are there?', [session], { ask: 'enumerated' }).prompt;

  it('says a decline needs an empty list, not merely a written one', () => {
    const prompt = sessionPrompt();
    expect(prompt).toContain('only when the Step 1 list is empty');
    // The stronger sentence does not replace the older one: a bare decline is still refused,
    // because an empty Step 1 must be WRITTEN as well as be empty.
    expect(prompt).toContain('without first writing the Step 1 list');
  });

  it('says what Step 2 must do with a list that has items', () => {
    const prompt = sessionPrompt();
    expect(prompt).toContain('Step 2 must state the number computed from it');
    expect(prompt).toContain('even when you believe the list is incomplete');
  });
});

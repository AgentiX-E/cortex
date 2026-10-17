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
 * The rule that decides is the last line, so the rule moved there.
 *
 * ## What §13.55 built, and why it lost
 *
 * §13.55 added the sentence *"Reply INSUFFICIENT_EVIDENCE only when the Step 1 list is
 * empty."* and inserted it **before** the block's closing line —
 * `Reply with the answer alone. If the evidence does not contain the answer, reply
 * exactly INSUFFICIENT_EVIDENCE.` — on the argument that an exception belongs adjacent to
 * the rule it excepts. Run `39035438120` priced that argument: the delta did not move
 * (`+26.90pp` against `+26.95pp`), and of the 28 MR declines it inherited, **21 declined
 * again — 12 of them with a non-empty Step 1 list**. The model read the exception, then
 * read the rule, and followed the rule, because the rule was last.
 *
 * The witness is `7024f17c`: it listed the jog, computed *"Total = 0.5 hours of jogging"*,
 * and appended the sentinel. The gold is `0.5 hours`. The answer was in Step 2 and the
 * closing line took it away.
 *
 * ## The repair, which is one line in one position
 *
 * The closing line is **replaced**, not qualified, and it is the last thing the model
 * reads. `computed` keeps the original line unchanged, so the pair of tests below is also
 * the reach assertion at line granularity: everything `enumerated` adds is additive, and
 * the one line it does not share is the only line this section changes.
 *
 * ## Why that is not the same experiment as §13.55
 *
 * §13.55 added a competitor to a rule and the competitor lost on position. This makes the
 * rule itself conditional, in the position where a conditional wins. The wording of the
 * condition is unchanged — the list decides — so the mechanism under test is placement,
 * and the prompt is one line shorter than it would be if both statements were kept.
 */
describe('the closing line makes the decline conditional on the list', () => {
  const session: AdmittedSession = {
    index: 0,
    size: 2,
    turns: [turn('I planned a project in Nigeria.'), turn('I was promoted.')],
  };

  const promptFor = (ask: 'enumerated' | 'computed'): string =>
    buildSessionPrompt('How many events are there?', [session], { ask }).prompt;

  it('ends the multi-session block with the conditional line', () => {
    const lines = promptFor('enumerated').trimEnd().split('\n');
    expect(lines.at(-1)).toContain('If the Step 1 list is empty');
    expect(lines.at(-1)).toContain('Reply with the Step 2 number alone');
  });

  it('no longer contains the unconditional licence anywhere', () => {
    // The line, not the fragment: the conditional line legitimately contains "the evidence
    // does not contain the answer", and a substring assertion would forbid the repair.
    expect(promptFor('enumerated')).not.toContain(
      'Reply with the answer alone. If the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE.',
    );
  });

  it('leaves the control ask byte-identical', () => {
    const computed = promptFor('computed').trimEnd();
    expect(
      computed.endsWith(
        'Reply with the answer alone. If the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE.',
      ),
    ).toBe(true);
  });

  it('differs from the control by additions and exactly one replaced line', () => {
    // The claim this section makes about itself. `enumerated` is `computed` plus the
    // two-step contract, with the closing line replaced -- so every line of `computed`
    // except its last must appear in `enumerated`, and the last must not.
    const enumerated = promptFor('enumerated').trimEnd().split('\n');
    const computed = promptFor('computed').trimEnd().split('\n');
    const replaced = computed.at(-1) as string;
    for (const line of computed.slice(0, -1)) {
      expect(enumerated).toContain(line);
    }
    expect(enumerated).not.toContain(replaced);
  });

  it('still refuses a bare decline', () => {
    // An empty Step 1 has to be WRITTEN as well as be empty, and removing the
    // unconditional closing line must not remove that requirement with it.
    expect(promptFor('enumerated')).toContain('without first writing the Step 1 list');
  });
});

/**
 * A contract that names its terminator must have that terminator read.
 *
 * ## The defect, measured on a real run
 *
 * `ask=verbatim` (§13.246) migrates the reference pipeline's aggregation contract whole. That
 * contract does not end with *"reply with the number alone"* — it ends with a named terminator:
 *
 *     Answer: <final answer>
 *
 * followed by a bare `Answer:` cue, which the arm's assembly places as the **last line of the
 * prompt** so the model continues from it. Run `41860773768` administered it on 500 questions and
 * the replies came back in the contract's own shape:
 *
 *     - Peace lily | acquired | 2023/05/20
 *     - Succulent | acquired | 2023/05/20
 *     - Snake plant | acquired | 2023/05/25 — excluded: outside "the last month"
 *
 *     Answer: 2
 *
 * and the arm returned the **whole transcript** as the answer, `Answer: 2` line included. 94 of
 * the run's 121 multi-session records are that shape, and the artifact says so in one field:
 * `answer` equals `rawOutput` on every one of them.
 *
 * ## Why the accuracy did not collapse, and why that is not a defence
 *
 * `judgeScorer` reads the answer *and* the ground truth, and 49 of those 94 transcripts contain the
 * gold verbatim — so the judge said "correct" and the headline was not wrong. That is the reason
 * this is a **product** defect rather than a measurement one: a user of `ask=verbatim` receives a
 * four-line list where they asked for a number. The number being recoverable by a judge that reads
 * the whole thing is not the product working.
 *
 * ## The rule, and why it is inert on every archived run
 *
 * A closing label is a **line that opens** with `Answer:` / `Final answer:` / `Answer -`, and only
 * the **last non-empty line** can close a reply. That is the same rule `isAbstention` already
 * applies, for the same reason: a decision lives on the closing line, and a label mentioned
 * mid-sentence is a mention. Our own asks never request a label — `enumerated` ends with *"Reply
 * with the Step 2 number alone"*, and `parse-stepped.test.ts` measured a step heading in 0 of the
 * 1,000 questions of runs `38595325261` and `38828538851` — so no published number can contain the
 * shape this reads.
 *
 * The interaction that makes this a *composition* rather than a new branch: when the model puts the
 * label beside the last step heading (`Step 2 — Answer: 2`), the heading rule slices to
 * `Answer: 2` and the label rule then strips it. `abstention-recovery.ts` names that exact string as
 * the shape a previous repair had to work around — *"a prefixed line would be scored as the literal
 * string `Answer: 2`"* — so the two rules have to run in this order.
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

/** The reply shape 94 of run `41860773768`'s 121 multi-session records have. */
const LABELLED = [
  '- Peace lily | acquired | 2023/05/20',
  '- Succulent | acquired | 2023/05/20',
  '- Snake plant | acquired | 2023/05/25 — excluded: outside "the last month"',
  '',
  'Answer: 2',
].join('\n');

describe('a reply that names its answer is scored by that line', () => {
  it('returns what follows the closing label', () => {
    expect(parseAnswer(LABELLED)).toBe('2');
  });

  it('does not return the transcript it followed', () => {
    const answer = parseAnswer(LABELLED) as string;
    expect(answer).not.toContain('Peace lily');
    expect(answer).not.toContain('Answer:');
    expect(answer.length).toBeLessThan(20);
  });

  it('declines when the closing label carries the sentinel', () => {
    // The precedence that has to hold: `answer-line` asked for `Answer: <phrase>` and a reader
    // that ran out of evidence declined **in that form**. `isAbstention` reads the label through
    // `stripDecoration`, so the decline is recognised before any answer is taken.
    expect(parseAnswer('Answer: INSUFFICIENT_EVIDENCE')).toBeNull();
    expect(parseAnswer(`${LABELLED}\n\nAnswer: INSUFFICIENT_EVIDENCE`)).toBeNull();
  });

  it('returns a blank answer when the label carries nothing', () => {
    // A contract whose last line is the cue itself: the model stopping there wrote no answer.
    // `''` is an answer — a blank, wrong one — and not an abstention, which is the same rule
    // `afterLastStepHeading` states for a heading with nothing after it.
    expect(parseAnswer('Answer:')).toBe('');
    expect(parseAnswer('- a\n- b\n\nAnswer: ')).toBe('');
  });

  it('reads a label the model puts beside the last step', () => {
    // `abstention-recovery.ts` names this string as the artefact a previous repair worked around:
    // the heading rule slices to `Answer: 2`, and without the label rule that literal is the
    // answer. The two rules are ordered by this test.
    expect(parseAnswer('Step 2 — Answer: 2')).toBe('2');
    expect(parseAnswer('Step 1 — list\n- a\n\nStep 2 — Answer: $375')).toBe('$375');
  });

  it('reads the label shapes models produce unprompted', () => {
    // `LABEL_PREFIX`'s own description, narrowed to the two words a contract names: `Answer:` and
    // `Final answer:`, with `:` or `-`. `The answer: …` is **not** in the set, and the next test is
    // why — it is how a prose sentence begins, and a rule that reads it as a terminator would cut
    // the sentence's own subject off its answer.
    expect(parseAnswer('Final answer: $375')).toBe('$375');
    expect(parseAnswer('Answer - 5 days')).toBe('5 days');
  });

  it('does not read an identifier that begins with the label word', () => {
    // The conformance suite's fake reader answers `answer-0`, and a separator class of `[:\-]`
    // matched the hyphen inside it and returned `0` — a legitimate answer shortened by three
    // characters. The rule needs the space, and this is the regression that says so.
    expect(parseAnswer('answer-0')).toBe('answer-0');
    expect(parseAnswer('answer-42')).toBe('answer-42');
    // A spaced dash is still a label, which is what makes the space the deciding character.
    expect(parseAnswer('Answer - 42')).toBe('42');
    expect(parseAnswer('Answer — 42')).toBe('42');
  });

  it('leaves a reply with no closing label exactly as it was', () => {
    // The archived-comparability guard. Every published run's replies are these shapes, and the
    // rule must be invisible to all of them.
    const prose = 'The user visited three different doctors.\n\nOf those, two were specialists.';
    expect(parseAnswer(prose)).toBe(prose);
    expect(parseAnswer('2')).toBe('2');
    expect(parseAnswer('Step 1 — list\n- a\n\nStep 2 — 2')).toBe('2');
  });

  it('does not treat a label that is not the closing line as the terminator', () => {
    // The label is the **last** non-empty line, not any line. A reply that states its answer and
    // then adds a closing remark is returned whole, which is the conservative direction: the
    // judge reads the whole thing, and the alternative would silently delete the remark.
    const narrated = 'Answer: 2\n\nNote: the snake plant was planted in April.';
    expect(parseAnswer(narrated)).toBe(narrated);
    // And a mention inside a sentence is a mention.
    const mentioned = 'The answer: 7 follows from the list above.';
    expect(parseAnswer(mentioned)).toBe(mentioned);
  });

  it('the reader and the contract terminator cannot drift apart', () => {
    // §13.36's rule applied to a pair that cannot share a constant, in the same form
    // `parse-stepped.test.ts` uses for the headings: build the REAL prompt, read the terminator
    // out of it, and drive the parser with a reply that ends in it. Strictly stronger than
    // comparing two literals, because it also fails if the contract stops reaching the route.
    const session: AdmittedSession = {
      index: 0,
      size: 2,
      turns: [turn('I acquired a peace lily.'), turn('I bought a coffee table.')],
    };
    const { prompt } = buildSessionPrompt('How many plants did I acquire?', [session], {
      ask: 'verbatim',
    });

    const lastNonEmpty = prompt
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .at(-1);
    // The assembly places the cue last so the model continues from it. If that stops being true,
    // the reply shape this test drives is no longer the one the contract asks for.
    expect(lastNonEmpty).toBeDefined();
    expect(lastNonEmpty!.trim().toLowerCase()).toBe('answer:');

    const cue = lastNonEmpty!.trim();
    const replied = `${LABELLED.split('\n\nAnswer: 2')[0]}\n\n${cue} 2`;
    expect(parseAnswer(replied)).toBe('2');
  });
});

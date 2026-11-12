import { describe, expect, it } from 'vitest';

import { parseAnswer } from '../parse.js';
import {
  buildCommitPrompt,
  buildEchoPrompt,
  buildRetryPrompt,
  buildShapePrompt,
} from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

/**
 * The three corrective builders that ask for a list must close on a label the parser reads.
 *
 * `MEASURE-RETRY-SHAPE.md` is the measurement behind this file. `43121298653` ended 14 of its 500 replies
 * with a stamped list plus a correct answer line; `parseAnswer` returned the whole reply, because the close
 * was the sentence *"Reply with the answer alone on the last line"* and `CLOSING_ANSWER_LABEL` reads a
 * colon-form label. The reply was then counted as `evidence-echo` -- a dump -- and the answer that was on
 * the last line was scored inside the list that preceded it.
 *
 * The tests below are structural rather than behavioural: they do not claim the model obeys, they claim that
 * **if** it writes the shape it is asked for, the parser reads the answer and not the list. The behavioural
 * half is a dispatch, and its criteria live in `03-execution-plan.md` 14.120.
 */

const TURNS = [
  {
    index: 0,
    text: '[2023/05/27 (Sat) 03:55] user: I got 20% off that book at my favourite bookstore.',
    at: 1_685_200_000_000,
    role: 'user',
    sessionId: 's1',
  },
] as unknown as AdmittedTurn[];

const BUILDS = [
  ['retry', buildRetryPrompt],
  ['commit', buildCommitPrompt],
  ['echo', buildEchoPrompt],
  ['shape', buildShapePrompt],
] as const;

describe('a corrective prompt closes on a label the parser reads', () => {
  for (const [name, build] of BUILDS) {
    it(`${name} ends on the Answer label`, () => {
      const prompt = build('What percentage discount did I get?', TURNS);
      const lines = prompt.split('\n').filter((line) => line.trim() !== '');
      // The last non-empty line is what `afterClosingLabel` reads, so the label has to be on that line --
      // a label followed by "and write nothing after it" prose would be read as the answer's prefix.
      expect(lines.at(-1)).toMatch(/^Answer: <the answer/);
    });
  }
});

describe('parseAnswer reads the label off a list, which is the defect the label removes', () => {
  it('returns the answer line after a numbered dump, not the dump', () => {
    const reply = [
      '1. [2023/05/27 (Sat) 03:55] user: I got 20% off that book at my favourite bookstore.',
      '2. [2023/05/27 (Sat) 03:55] user: The original price was $30.',
      '',
      'Answer: 20%',
    ].join('\n');
    expect(parseAnswer(reply)).toBe('20%');
  });

  it('returns the whole reply when the close is a sentence instead of a label', () => {
    // The pre-label shape, kept as the record of what the old prompt produced: the answer is the last line
    // and the parsed answer is all four lines, so every consumer downstream -- the judge included -- sees the
    // list as part of the answer.
    const reply = [
      '1. [2023/05/27 (Sat) 03:55] user: I got 20% off that book at my favourite bookstore.',
      '2. [2023/05/27 (Sat) 03:55] user: The original price was $30.',
      'The discount works out to 20%.',
    ].join('\n');
    expect(parseAnswer(reply)).toContain('2023/05/27');
    expect(parseAnswer(reply)).toContain('20%');
  });

  it('reads a bare label with an empty tail as an empty answer', () => {
    expect(parseAnswer('1. [2023/05/27] user: a fact.\nAnswer:')).toBe('');
  });
});

/**
 * The two reply shapes the reader produces that are not answers, and the repair each one earns.
 *
 * ## The measurement these tables are built from
 *
 * `docs/MEASURE-ORACLE-CEILING.md` §7.4 reads all 35 questions the arm loses when the gold sessions are in the
 * window, and classifies 14 of them as contract violations rather than reasoning failures: **8 refusals in prose**
 * (`MR 4, IE 3, TR 1`) and **6 lists of quotations** (`MR 2, IE 4`). This file holds the predicate against the
 * reply shapes those questions actually produced, and holds the two builders against the parse layer -- because a
 * repair prompt whose reply does not parse is a consultation that cannot be credited to the treatment.
 */
import { describe, expect, it } from 'vitest';

import { classifyReply, planReplyRepair } from '../reply-repair.js';
import { ABSTAIN_TOKEN, parseAnswer } from '../parse.js';
import { buildCommitPrompt, buildPrompt, buildShapePrompt } from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

/**
 * The reply shapes from the eight refusals, as the artifact recorded them.
 *
 * Four are the single word `None` (`60bf93ed`, `37f165cf`, `75832dbd`, `778164c6`), which is the case neither
 * retry can see: it names no token, so `isBareDecline` is false, and `parseAnswer` returns it as an answer, so the
 * recovery pass is told the question was answered.
 */
const PROSE_REFUSALS = [
  'Not specified in the evidence',
  'Cannot be determined',
  'None',
  'No items in the evidence match',
  'None.',
];

/** The token on the closing line with company: parsed as a decline, and not bare. */
const TOKEN_IN_PROSE = [
  `The evidence does not state the purchase date, only the arrival date.\n\n${ABSTAIN_TOKEN}`,
  `- one event on 2023/05/20\n\n${ABSTAIN_TOKEN}`,
];

/** A list of quotations with no answer line, which is what the six shape failures produced. */
const QUOTATION_DUMPS = [
  [
    '- [2023/04/02] user: "I bought a new bike for $600"',
    '- [2023/04/09] user: "sold the bike for $450"',
  ].join('\n'),
  [
    '"I have been reading a lot of science fiction lately"',
    '"the last one was about a generation ship"',
  ].join('\n'),
  ['1. [2023/05/01] "ran 5 km"', '2. [2023/05/03] "ran 7 km"', '3. [2023/05/04] "ran 3 km"'].join(
    '\n',
  ),
];

/** Replies that are answers, including the two shapes that a looser predicate would misread. */
const ANSWERS = [
  'Business Administration',
  '42',
  // A refusal-shaped sentence that carries an answer: the length bound is what keeps the predicate off it.
  'The receipt does not specify a tip, so the total of $42 is the answer',
  // `No` as an answer to a yes/no question. `^none\b` does not match it, which is why the opener set is closed.
  'No, I did not renew it -- the charge was $30',
  // A one-line bullet is an answer no matter how odd: two lines are the minimum a list can have.
  '- 42',
  // `Answer:` label, the shape `ask=verbatim` migrated: parsed down to the answer, so not a list.
  'Answer: 3',
];

describe('classifyReply', () => {
  it('reads the four states apart', () => {
    for (const reply of PROSE_REFUSALS) expect(classifyReply(reply), reply).toBe('prose-decline');
    for (const reply of TOKEN_IN_PROSE) expect(classifyReply(reply), reply).toBe('prose-decline');
    for (const reply of QUOTATION_DUMPS) expect(classifyReply(reply), reply).toBe('shape-failed');
    for (const reply of ANSWERS) expect(classifyReply(reply), reply).toBe('committed');
  });

  it('keeps the bare token for the retry that owns it', () => {
    // The ordering that makes the two treatments disjoint. A reply that is the token and nothing else is
    // `reviewBareDecline`'s population, and `planReplyRepair` must never plan for it -- otherwise a run with both
    // treatments on would consult twice on one question and the movement would be two variables.
    expect(classifyReply(ABSTAIN_TOKEN)).toBe('bare-decline');
    expect(classifyReply(`**${ABSTAIN_TOKEN}**`)).toBe('bare-decline');
    expect(planReplyRepair(ABSTAIN_TOKEN, 'both')).toEqual({ kind: 'none' });
  });

  it('treats a missing or empty reply as nothing to repair', () => {
    // A provider fault and an empty completion are different states with their own paths, and a repair that fired
    // on them would spend a call to repair nothing.
    expect(classifyReply(null)).toBe('committed');
    expect(classifyReply('')).toBe('committed');
    expect(classifyReply('   \n ')).toBe('committed');
  });

  it('reads decoration through stripDecoration rather than its own pattern', () => {
    expect(classifyReply('**None**')).toBe('prose-decline');
    expect(classifyReply('"Cannot be determined."')).toBe('prose-decline');
  });
});

describe('the list-answer rule, read through the classifier that owns it', () => {
  it('needs two non-empty lines, so a single line is always an answer', () => {
    // The rule is not exported: `classifyReply` is the interface, and a second entry point would be a second
    // place for the four states to disagree. A one-line bullet is an answer no matter how odd.
    expect(classifyReply('- 42')).toBe('committed');
    expect(classifyReply('42')).toBe('committed');
    expect(classifyReply('')).toBe('committed');
  });

  it('is false for two plain lines that are not a list', () => {
    // Two sentences are a chatty answer. The predicate is about the *shape of a list*, not about length:
    // treating every multi-line reply as a shape failure would re-ask every reader that thinks on the page --
    // and `tools/reply-shape-census.mjs` measures what that would cost (42-47 targets for 7-13 wrong answers).
    expect(classifyReply('the total is $42\nwhich is what I spent')).toBe('committed');
  });

  it('is true for a bullet list and for quoted paragraphs', () => {
    expect(classifyReply('- one\n- two')).toBe('shape-failed');
    expect(classifyReply('"one"\n"two"')).toBe('shape-failed');
    expect(classifyReply('1. one\n2. two')).toBe('shape-failed');
  });
});

describe('planReplyRepair', () => {
  const refusal = 'Not specified in the evidence';
  const dump = '- [2023/04/02] "bought a bike"\n- [2023/04/09] "sold the bike"';

  it('plans nothing when the option is absent or off', () => {
    // Absent is the state every archived artifact was produced in, and `off` is a value a control arm can name.
    expect(planReplyRepair(refusal, undefined)).toEqual({ kind: 'none' });
    expect(planReplyRepair(refusal, 'off')).toEqual({ kind: 'none' });
  });

  it('routes each kind only where the run asked for it', () => {
    expect(planReplyRepair(refusal, 'commitment')).toEqual({ kind: 'commitment' });
    expect(planReplyRepair(refusal, 'shape')).toEqual({ kind: 'none' });
    expect(planReplyRepair(dump, 'shape')).toEqual({ kind: 'shape' });
    expect(planReplyRepair(dump, 'commitment')).toEqual({ kind: 'none' });
    expect(planReplyRepair(refusal, 'both')).toEqual({ kind: 'commitment' });
    expect(planReplyRepair(dump, 'both')).toEqual({ kind: 'shape' });
  });

  it('plans nothing for an answer, under every mode', () => {
    for (const mode of ['commitment', 'shape', 'both'] as const) {
      expect(planReplyRepair('Business Administration', mode)).toEqual({ kind: 'none' });
    }
  });
});

describe('the repair prompts', () => {
  const turns: AdmittedTurn[] = [
    {
      content: '[2023/05/20] user: I graduated with a degree in Business Administration.',
      role: 'user',
      date: '2023/05/20',
      session: 1,
      turn: 1,
      relevance: 1,
    } as unknown as AdmittedTurn,
  ];
  const question = 'What degree did I graduate with?';

  it('carry the evidence block the first pass carried, byte for byte', () => {
    // The property the whole design rests on: the second call reads the same characters, so a difference between
    // the two answers is a difference of instruction. Asserted as a prefix, the way `bare-decline-retry.test.ts`
    // asserts it, because the instruction block below the evidence is the treatment.
    const first = buildPrompt(question, turns, 'extractive').prompt;
    for (const build of [buildCommitPrompt, buildShapePrompt]) {
      const repair = build(question, turns);
      const head = repair.slice(0, repair.indexOf('QUESTION:'));
      expect(first.startsWith(head)).toBe(true);
      expect(repair).toContain(question);
    }
  });

  it('say what the first reply did, and each says something different', () => {
    const commit = buildCommitPrompt(question, turns);
    const shape = buildShapePrompt(question, turns);
    expect(commit).toContain('reported that the evidence above does not answer this question');
    expect(shape).toContain('quoted the evidence instead of answering');
    // Neither may repeat the bare retry's sentence: that one answers a reply that named nothing, and telling a
    // reader that it said nothing when it wrote a sentence is the one thing a corrective prompt cannot afford.
    for (const prompt of [commit, shape]) {
      expect(prompt).not.toContain('The previous reply named no evidence');
    }
  });

  it('carry the no-evidence placeholder rather than an empty block', () => {
    // The state a builder can be handed directly: the product returns `#declinedEmpty()` before consulting, so this
    // is reachable only through the exported API -- and a builder that printed `EVIDENCE:` with nothing under it
    // would be asking a question about a window the reader cannot see.
    for (const build of [buildCommitPrompt, buildShapePrompt]) {
      const prompt = build(question, []);
      expect(prompt).toContain('EVIDENCE:');
      expect(prompt).not.toMatch(/EVIDENCE:\n\n/);
      expect(prompt).toContain(question);
    }
  });

  it('ask for the shape that the parse layer reads', () => {
    // A repair prompt whose reply does not parse is a consultation that cannot be credited to the treatment, which
    // is the defect the recovery prompt's own test found ("Answer: 2" scored as that literal string).
    const shape = buildShapePrompt(question, turns);
    expect(shape).toContain('Answer: <the answer');
    expect(parseAnswer('Answer: 3')).toBe('3');
    expect(parseAnswer('Business Administration')).toBe('Business Administration');
  });
});

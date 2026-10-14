/**
 * Parsing turns raw model text into an `Answer`.
 *
 * `Answer = string | null` where `null` is an abstention. The distinction that
 * matters: an empty string is an *answer* (a wrong one), not an abstention.
 * `computeMetrics` counts abstentions separately from wrong answers, so
 * conflating the two silently moves every metric.
 */
import { describe, expect, it } from 'vitest';
import { parseAnswer, isAbstention, ABSTAIN_TOKEN } from '../parse.js';

describe('parseAnswer', () => {
  it('returns the trimmed answer for plain text', () => {
    expect(parseAnswer('  Paris  ')).toBe('Paris');
  });

  it('returns null for the abstain token', () => {
    expect(parseAnswer(ABSTAIN_TOKEN)).toBeNull();
  });

  it('recognises the abstain token case-insensitively', () => {
    expect(parseAnswer(ABSTAIN_TOKEN.toUpperCase())).toBeNull();
  });

  it('recognises the abstain token after a label prefix', () => {
    // Models emit `Answer: INSUFFICIENT` even when told not to label. Treating
    // that as a literal answer would count an abstention as a wrong answer.
    expect(parseAnswer(`Answer: ${ABSTAIN_TOKEN}`)).toBeNull();
  });

  it('recognises the abstain token as the last line of a chatty response', () => {
    const raw = `The context mentions nothing relevant.\n${ABSTAIN_TOKEN}`;
    expect(parseAnswer(raw)).toBeNull();
  });

  it('does NOT treat an empty string as abstention', () => {
    // This is the assertion the metrics depend on: `null` is a first-class
    // answer meaning "I decline", while '' is a blank answer. Collapsing them
    // would inflate `abstentionCorrectRate` on every empty completion.
    expect(parseAnswer('')).toBe('');
  });

  it('does NOT treat whitespace-only output as abstention', () => {
    expect(parseAnswer('   ')).toBe('');
  });

  it('does not abstain when the token appears inside a real answer', () => {
    // A token appearing mid-sentence is evidence about wording, not a decision.
    // Only a whole-line or whole-response occurrence is a decision.
    const raw = 'The user said the word insufficiently specifically.';
    expect(parseAnswer(raw)).toBe('The user said the word insufficiently specifically.');
  });

  it('keeps interior newlines in a multi-line answer', () => {
    const raw = 'first line\nsecond line';
    expect(parseAnswer(raw)).toBe('first line\nsecond line');
  });

  it('strips surrounding quotes', () => {
    expect(parseAnswer('"Paris"')).toBe('Paris');
    expect(parseAnswer("'Paris'")).toBe('Paris');
  });

  it('does not strip an unbalanced quote', () => {
    expect(parseAnswer('"Paris')).toBe('"Paris');
  });

  it('strips curly quotes, which a model may emit as typography', () => {
    expect(parseAnswer('\u201cParis\u201d')).toBe('Paris');
  });

  it('does not strip mismatched quote styles', () => {
    // A straight open with a curly close is two separate decisions about
    // delivery, so neither is treated as wrapping.
    expect(parseAnswer('"Paris\u201d')).toBe('"Paris\u201d');
  });

  it('does not strip a lone quote character', () => {
    // `text.length >= 2` guards this: a one-character response of `"` is an
    // answer, and slicing it would produce an empty string.
    expect(parseAnswer('"')).toBe('"');
  });

  it('trims trailing whitespace and newlines', () => {
    expect(parseAnswer('Paris\n\n')).toBe('Paris');
  });

  it('handles a bare token with surrounding whitespace', () => {
    expect(parseAnswer(`\n  ${ABSTAIN_TOKEN}  \n`)).toBeNull();
  });
});

describe('isAbstention', () => {
  it('is false for blank input', () => {
    // `parseAnswer` short-circuits before reaching the predicate, so this is
    // the only way to exercise "nothing at all is not a decision" — and it is
    // worth exercising, because a predicate that answered `true` here would
    // turn every empty completion into a correct abstention.
    expect(isAbstention('')).toBe(false);
    expect(isAbstention('   ')).toBe(false);
    expect(isAbstention('\n\n')).toBe(false);
  });

  it('is true for the token alone and false for a mention', () => {
    expect(isAbstention(ABSTAIN_TOKEN)).toBe(true);
    expect(isAbstention(`${ABSTAIN_TOKEN} is the token the prompt names.`)).toBe(false);
    expect(isAbstention('the reasoning was insufficiently specific')).toBe(false);
  });

  it('reads the token through a short label on the deciding line', () => {
    // Models label their output even when told not to. The label must be short
    // and delimited, which is what distinguishes `Answer: TOKEN` from a
    // sentence that happens to end in the token.
    expect(isAbstention(`Answer: ${ABSTAIN_TOKEN}`)).toBe(true);
    expect(isAbstention(`Answer - ${ABSTAIN_TOKEN}`)).toBe(true);
  });

  it('does not read the token through prose on the same line', () => {
    // `I cannot answer. TOKEN` is a sentence, not a label, so the token is
    // being mentioned rather than deciding. Prose before a token on one line is
    // exactly the shape `parseAnswer`'s trailing-line rule exists to reject.
    expect(isAbstention(`I cannot answer. ${ABSTAIN_TOKEN}`)).toBe(false);
  });

  it('reads only the last non-blank line', () => {
    expect(isAbstention(`${ABSTAIN_TOKEN}\n\nParis`)).toBe(false);
    expect(isAbstention(`Paris\n\n${ABSTAIN_TOKEN}`)).toBe(true);
  });
});

describe('isAbstention reads the token through presentation', () => {
  /**
   * Every wrapper a model has actually been seen to put *around* its conclusion.
   *
   * The failure this covers is not cosmetic. Run `38487229554` records five
   * responses whose deciding line is `**INSUFFICIENT_EVIDENCE**`; four were scored as
   * wrong answers and one as a correct answer, when all five are decisions to
   * decline under `isAbstention`'s own trailing-line contract. The route is telling:
   * the temporal block asks the model to *show its work*, and markdown emphasis on the
   * final line is what a trace-then-conclude answer looks like.
   */
  const WRAPPERS: ReadonlyArray<readonly [string, string, string]> = [
    ['markdown bold', '**', '**'],
    ['markdown bold underscore', '__', '__'],
    ['markdown italic', '*', '*'],
    ['markdown italic underscore', '_', '_'],
    ['backtick code span', '`', '`'],
    ['straight double quotes', '"', '"'],
    ['straight single quotes', "'", "'"],
    ['curly double quotes', '\u201c', '\u201d'],
    ['curly single quotes', '\u2018', '\u2019'],
  ];

  for (const [name, open, close] of WRAPPERS) {
    it(`reads a conclusion wrapped in ${name}`, () => {
      expect(isAbstention(`${open}${ABSTAIN_TOKEN}${close}`)).toBe(true);
    });

    it(`reads it through ${name} around a label, and around a wrapped label`, () => {
      // Labels and wrappers nest both ways round, which is why the reduction is a
      // fixpoint rather than one ordered pass: `Answer: **TOKEN**` needs the label
      // peeled first and `**Answer: TOKEN**` needs the wrapper peeled first, and a
      // single order can only do one of them.
      expect(isAbstention(`${open}Answer: ${ABSTAIN_TOKEN}${close}`)).toBe(true);
      expect(isAbstention(`Answer: ${open}${ABSTAIN_TOKEN}${close}`)).toBe(true);
    });
  }

  it('reads the token through nested wrappers', () => {
    expect(isAbstention(`**"${ABSTAIN_TOKEN}"**`)).toBe(true);
  });

  it('accepts a lower-case token, because one rule decides case', () => {
    expect(isAbstention('**insufficient_evidence**')).toBe(true);
  });

  it('does not read a token that is only part of a decorated line', () => {
    // The line is the unit. `**TOKEN** was the wrong call here` is a sentence with
    // emphasis in it, not a decorated token, and the whole predicate rests on a
    // mention staying an answer -- a wrapper stripper that scanned the interior of a
    // line would turn every response that discusses the token into a decline.
    expect(isAbstention(`**${ABSTAIN_TOKEN}** was the wrong call here`)).toBe(false);
    expect(isAbstention(`I considered saying ${ABSTAIN_TOKEN}.`)).toBe(false);
  });

  it('does not turn an emphasised short answer into a decline', () => {
    // The other half of the same rule: unwrapping must leave content, and content
    // that is not the token is an answer. Without this the fix would be
    // indistinguishable from "any emphasised last line abstains".
    expect(isAbstention('**Paris**')).toBe(false);
    expect(isAbstention('"Business Administration"')).toBe(false);
  });

  it('finds no decision in a line that is only presentation', () => {
    expect(isAbstention('"')).toBe(false);
    expect(isAbstention('**')).toBe(false);
    expect(isAbstention('``')).toBe(false);
  });

  it('carries the shape end to end, so the answer is a decline and not prose', () => {
    // What the artifact shows for those five records: a trace, a blank line, and an
    // emphasised conclusion. `parseAnswer` must return `null` -- the prose is
    // reasoning, not the answer -- because a non-null answer is scored, and a decline
    // scored as an answer is wrong twice: it adds a wrong answer and it hides a
    // decline from the abstention rate.
    expect(
      parseAnswer(`Let us trace the timeline.\n\n- recovered 2023/01/19\n\n**${ABSTAIN_TOKEN}**`),
    ).toBeNull();
  });
});

describe('ABSTAIN_TOKEN', () => {
  it('is a single stable token, so parse and prompt agree by construction', () => {
    // The prompt injects this token and the parser reads it. Two literals that
    // must agree is exactly the shape of the consolidation-clock defect; there
    // is one literal and both sides import it.
    expect(ABSTAIN_TOKEN).toBe('INSUFFICIENT_EVIDENCE');
  });
});

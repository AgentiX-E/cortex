/**
 * The probe that decides whether a price ratio is a price.
 *
 * The assertions are about **shape**, not about the provider: the prompts must be a controlled
 * experiment (identical control, three perturbations, one alien text) before any number they produce
 * can be read. The one thing this file does assert is the separation between the two models, because a
 * probe whose two hypotheses predict the same thing on all five prompts cannot decide anything and
 * would still print a verdict.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCacheCreditPrompts,
  contentExpectation,
  fitCacheCreditModels,
  positionExpectation,
  renderCacheCreditReport,
  sharedPrefixChars,
  type CacheCreditPrompt,
  type CacheCreditSample,
  type CacheCreditVariant,
} from '../cache-credit.js';

const textsOf = (prompts: readonly CacheCreditPrompt[]): readonly string[] =>
  prompts.map((prompt) => prompt.text);

const sample = (
  variant: CacheCreditVariant,
  promptTokens: number,
  cacheHitPromptTokens: number,
): CacheCreditSample => ({ variant, promptTokens, cacheHitPromptTokens });

const THOUSAND = 1000;

/** Samples whose credit is exactly one model's expectation, rounded to tokens. */
function samplesFor(prompts: readonly CacheCreditPrompt[], model: 'position' | 'content') {
  const texts = textsOf(prompts);
  return prompts.map((prompt, index) =>
    sample(
      prompt.variant,
      THOUSAND,
      Math.round(
        (model === 'position'
          ? positionExpectation(texts, index)
          : contentExpectation(texts, index)) * THOUSAND,
      ),
    ),
  );
}

describe('the five prompts are a controlled experiment', () => {
  it('is deterministic and seeded', () => {
    const first = buildCacheCreditPrompts();
    const again = buildCacheCreditPrompts();
    const other = buildCacheCreditPrompts({ seed: 7 });
    expect(textsOf(first)).toEqual(textsOf(again));
    expect(textsOf(other)).not.toEqual(textsOf(first));
  });

  it('sends the variants in the order their expectations assume', () => {
    expect(buildCacheCreditPrompts().map((prompt) => prompt.variant)).toEqual([
      'reference',
      'repeat',
      'head-changed',
      'paragraphs-swapped',
      'unrelated',
    ]);
  });

  it('has a repeat that is byte-identical to the reference', () => {
    const texts = textsOf(buildCacheCreditPrompts());
    expect(texts[1]).toBe(texts[0]);
  });

  it('changes only the first 200 characters in head-changed', () => {
    const texts = textsOf(buildCacheCreditPrompts());
    const reference = texts[0] as string;
    const changed = texts[2] as string;
    expect(changed.length).toBe(reference.length);
    expect(changed.slice(200)).toBe(reference.slice(200));
    expect(sharedPrefixChars(reference, changed)).toBe(0);
  });

  it('reorders the paragraphs of the swapped variant and keeps their characters', () => {
    const texts = textsOf(buildCacheCreditPrompts());
    const reference = texts[0] as string;
    const swapped = texts[3] as string;
    // Same characters, different order: a multiset test, so a generator change that dropped a
    // paragraph would fail here rather than quietly shrinking the content expectation.
    expect([...swapped].sort().join('')).toBe([...reference].sort().join(''));
    expect(sharedPrefixChars(reference, swapped)).toBe(0);
  });

  it('shares no prefix and no sentence with the unrelated one, beyond the instruction', () => {
    const texts = textsOf(buildCacheCreditPrompts());
    expect(sharedPrefixChars(texts[0] as string, texts[4] as string)).toBe(0);
    // The instruction is the only thing the fifth prompt has in common, and a model that pretended
    // otherwise would be scoring itself generously.
    expect(contentExpectation(texts, 4)).toBeLessThan(0.05);
    expect(contentExpectation(texts, 4)).toBeGreaterThan(0);
  });

  it('ends every prompt with the same instruction', () => {
    for (const prompt of buildCacheCreditPrompts()) {
      expect(prompt.text.endsWith('Reply with exactly one word: OK')).toBe(true);
    }
  });

  it('is long enough for the content model to have sentences to score', () => {
    for (const prompt of buildCacheCreditPrompts()) {
      // Forty sentences is the floor at which "one sentence of fifty" is a share and not a coin.
      expect(prompt.text.length).toBeGreaterThan(2000);
    }
  });
});

describe('sharedPrefixChars', () => {
  it('reads the common run and stops at the first difference', () => {
    expect(sharedPrefixChars('abcd', 'abce')).toBe(3);
    expect(sharedPrefixChars('abcd', 'abcd')).toBe(4);
    expect(sharedPrefixChars('abcd', 'xbc')).toBe(0);
  });

  it('is bounded by the shorter text', () => {
    expect(sharedPrefixChars('ab', 'abcdef')).toBe(2);
    expect(sharedPrefixChars('', 'abcdef')).toBe(0);
  });
});

describe('positionExpectation', () => {
  it('credits nothing for the first prompt', () => {
    expect(positionExpectation(['abcdef'], 0)).toBe(0);
  });

  it('credits the whole of an identical second prompt', () => {
    expect(positionExpectation(['abcdef', 'abcdef'], 1)).toBe(1);
  });

  it('credits the shared run as a share of this prompt, not of the other one', () => {
    expect(positionExpectation(['abcdef', 'abcxyzxyz'], 1)).toBeCloseTo(3 / 9, 6);
  });

  it('takes the best earlier prompt rather than the most recent one', () => {
    expect(positionExpectation(['abcdef', 'zzzzzz', 'abcdee'], 2)).toBeCloseTo(5 / 6, 6);
  });

  it('refuses an index it has no prompt for', () => {
    expect(() => positionExpectation(['abc'], 1)).toThrow(/no prompt at index 1/);
  });

  it('reads an empty prompt as nothing to credit', () => {
    expect(positionExpectation(['abc', ''], 1)).toBe(0);
  });
});

describe('contentExpectation', () => {
  it('credits nothing for the first prompt', () => {
    expect(contentExpectation(['One. Two. Three.'], 0)).toBe(0);
  });

  it('credits the whole of an identical second prompt', () => {
    expect(contentExpectation(['One. Two. Three.', 'One. Two. Three.'], 1)).toBe(1);
  });

  it('credits a reordering that a position cache would score at zero', () => {
    const texts = ['One. Two. Three.', 'Three. One. Two.'];
    expect(positionExpectation(texts, 1)).toBe(0);
    expect(contentExpectation(texts, 1)).toBe(1);
  });

  it('weights the share by characters, not by sentence count', () => {
    // `One.` and `Two.` are 4 characters each against `Four.`'s 5, so two of three sentences is
    // 8/13 of the text. A count-based model would call this 2/3 and call a numbered list reused.
    expect(contentExpectation(['One. Two. Three.', 'One. Two. Four.'], 1)).toBeCloseTo(8 / 13, 6);
  });

  it('refuses an index it has no prompt for', () => {
    expect(() => contentExpectation(['One.'], 3)).toThrow(/no prompt at index 3/);
  });

  it('reads a prompt with no sentence boundary as one sentence', () => {
    expect(contentExpectation(['abc', 'abc'], 1)).toBe(1);
  });

  it('reads an empty prompt as nothing to credit', () => {
    expect(contentExpectation(['One. Two.', ''], 1)).toBe(0);
  });
});

describe('fitCacheCreditModels', () => {
  it('names the position model when the credit follows the prefix', () => {
    const prompts = buildCacheCreditPrompts();
    const fit = fitCacheCreditModels(samplesFor(prompts, 'position'), prompts);
    expect(fit.verdict).toBe('position');
    expect(fit.position.meanAbsoluteResidual).toBeCloseTo(0, 3);
    expect(fit.position.worstResidual).toBeLessThan(0.01);
  });

  it('names the content model when the credit follows the sentences', () => {
    const prompts = buildCacheCreditPrompts();
    const fit = fitCacheCreditModels(samplesFor(prompts, 'content'), prompts);
    expect(fit.verdict).toBe('content');
    expect(fit.content.meanAbsoluteResidual).toBeCloseTo(0, 3);
  });

  it('has two hypotheses that disagree by most of a prompt on the swapped variant', () => {
    const prompts = buildCacheCreditPrompts();
    const texts = textsOf(prompts);
    const swapped = prompts.findIndex((prompt) => prompt.variant === 'paragraphs-swapped');
    expect(positionExpectation(texts, swapped)).toBe(0);
    expect(contentExpectation(texts, swapped)).toBeGreaterThan(0.8);
  });

  it('refuses a verdict when neither model explains the credit', () => {
    const prompts = buildCacheCreditPrompts();
    const flat = prompts.map((prompt) => sample(prompt.variant, THOUSAND, THOUSAND / 2));
    const fit = fitCacheCreditModels(flat, prompts);
    expect(fit.verdict).toBe('neither');
    expect(fit.closest).toBeGreaterThan(0.15);
  });

  it('reports the worst row so one bad prompt cannot hide behind four good ones', () => {
    const prompts = buildCacheCreditPrompts();
    const samples = samplesFor(prompts, 'position').map((entry, index) =>
      index === 3 ? { ...entry, cacheHitPromptTokens: THOUSAND } : entry,
    );
    const fit = fitCacheCreditModels(samples, prompts);
    expect(fit.position.worstResidual).toBeGreaterThan(0.9);
    expect(fit.position.meanAbsoluteResidual).toBeLessThan(fit.position.worstResidual);
  });

  it('refuses an empty probe', () => {
    expect(() => fitCacheCreditModels([], buildCacheCreditPrompts())).toThrow(/no samples/);
  });

  it('refuses a probe with no prompts', () => {
    expect(() => fitCacheCreditModels([sample('reference', 10, 0)], [])).toThrow(/no prompts/);
  });

  it('refuses a sample for a prompt that was never sent', () => {
    const prompts = buildCacheCreditPrompts().filter((prompt) => prompt.variant !== 'unrelated');
    const samples = [sample('unrelated', 10, 0)];
    expect(() => fitCacheCreditModels(samples, prompts)).toThrow(/variant unrelated/);
  });

  it('refuses a call that billed no prompt tokens', () => {
    expect(() =>
      fitCacheCreditModels([sample('reference', 0, 0)], buildCacheCreditPrompts()),
    ).toThrow(/billed 0 prompt tokens/);
  });

  it('refuses a credit larger than the prompt it describes', () => {
    expect(() =>
      fitCacheCreditModels([sample('reference', 10, 11)], buildCacheCreditPrompts()),
    ).toThrow(/more than the prompt/);
  });
});

describe('renderCacheCreditReport', () => {
  it('prints every variant with both predictions and the credit', () => {
    const prompts = buildCacheCreditPrompts();
    const report = renderCacheCreditReport(
      fitCacheCreditModels(samplesFor(prompts, 'content'), prompts),
    );
    for (const prompt of prompts) expect(report).toContain(`| ${prompt.variant} |`);
    expect(report).toContain('| variant | position model | content model | credited |');
    expect(report).toContain('Verdict: **content**');
  });

  it('states what a neither verdict licenses, so the reader does not have to infer it', () => {
    const prompts = buildCacheCreditPrompts();
    const flat = prompts.map((prompt) => sample(prompt.variant, THOUSAND, 0));
    const report = renderCacheCreditReport(fitCacheCreditModels(flat, prompts));
    expect(report).toContain('Verdict: **neither**');
    expect(report).toContain('cannot be a bill');
  });
});

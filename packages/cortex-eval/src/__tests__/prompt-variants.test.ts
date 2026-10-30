/**
 * How many different prompts one question cost across the passes of a run.
 *
 * `§13.168.8` read a registered 60-80% prefix-cache hit share against two artifacts that measured 6.47% and
 * 11.16%, and could not say which of three explanations held, because the only per-question prompt field in
 * that artifact was `promptChars` -- a length, which a prompt that changed within its budget keeps. `§13.171`
 * put a fingerprint on each record, and a fingerprint answers the *across-run* half of the question: two
 * artifacts, same digest, same bytes.
 *
 * It cannot answer the half the cache prediction is actually about. The prediction is that passes 2-4 resend
 * the requests pass 1 sent, so the repeats are free; a single digest per record is taken from pass 1 and
 * says nothing about what the other passes sent. That is a defect in the instrument rather than in the
 * prediction, and these tests are what makes it visible:
 *
 *   - the count is over the passes that ran, so `4` means four prompts and `1` means one prompt sent four
 *     times -- the two readings the cache model separates, as one integer per question;
 *   - a pass that exposes no prompt makes the count unknowable rather than one, because "no accessor" is not
 *     "the same accessor twice";
 *   - one pass is not a repetition measurement, so the field is absent at `runs: 1` rather than uniformly 1;
 *   - the artifact does not grow: the exported text vector is still pass 1's, and the later passes' bytes are
 *     compared and dropped.
 */
import { describe, expect, it } from 'vitest';
import { runAblation } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import type { AblationResult, BenchmarkDataset, MemorySystem } from '../types.js';

const dataset: BenchmarkDataset = {
  name: 'prompt-variants',
  questions: [
    { id: 'q1', capability: 'IE', question: 'Q1', expected: 'a', context: ['a'] },
    { id: 'q2', capability: 'MR', question: 'Q2', expected: 'a', context: ['a'] },
    { id: 'q3', capability: 'TR', question: 'Q3', expected: 'a', context: ['a'] },
  ],
};

function constant(name: string): MemorySystem {
  return { name, answer: () => 'a' };
}

/**
 * A feature arm whose prompt for each question is chosen by `(pass, question)`.
 *
 * The pass ordinal is derived from how many times that question has been answered rather than kept in a
 * counter shared across questions, because the shared-counter form silently depends on the order the
 * benchmark walks the dataset -- and the point of these tests is the count, not the walk.
 */
function promptScripted(script: (pass: number, question: string) => string | null): MemorySystem {
  const seen = new Map<string, number>();
  let current = '';
  return {
    name: 'feature',
    answer: (question: string) => {
      current = question;
      seen.set(question, (seen.get(question) ?? 0) + 1);
      return 'a';
    },
    lastPromptText: () => script((seen.get(current) ?? 1) - 1, current),
  } as unknown as MemorySystem;
}

function variantsOf(result: AblationResult): readonly (number | null)[] | undefined {
  return result.featurePromptVariants;
}

describe('promptVariants: one integer per question, read over the passes that ran', () => {
  it('counts one when every pass resent the same bytes', async () => {
    const result = await runAblation(
      dataset,
      constant('base'),
      promptScripted((_p, q) => `same-${q}`),
      {
        runs: 4,
        scorer: exactMatchScorer,
      },
    );
    expect(variantsOf(result)).toEqual([1, 1, 1]);
  });

  it('counts two when one pass differed, and only for the question that differed', async () => {
    const result = await runAblation(
      dataset,
      constant('base'),
      promptScripted((pass, q) => (pass === 2 && q === 'Q2' ? 'diverged' : `same-${q}`)),
      { runs: 4, scorer: exactMatchScorer },
    );
    expect(variantsOf(result)).toEqual([1, 2, 1]);
  });

  it('counts four when no pass resent anything, which is the reading that voids a cache claim', async () => {
    const result = await runAblation(
      dataset,
      constant('base'),
      promptScripted((pass, q) => `${q}-pass${pass}`),
      { runs: 4, scorer: exactMatchScorer },
    );
    expect(variantsOf(result)).toEqual([4, 4, 4]);
  });

  it('reports a question whose prompt is unknowable on one pass as unknowable, not as one', async () => {
    // The honest answer to "how many distinct prompts" when one pass declined to say is `null`: a system
    // that exposes its prompt on three of four passes has not shown that the fourth matched.
    const result = await runAblation(
      dataset,
      constant('base'),
      promptScripted((pass, q) => (pass === 1 && q === 'Q1' ? null : `same-${q}`)),
      { runs: 4, scorer: exactMatchScorer },
    );
    const variants = variantsOf(result)!;
    expect(variants[0]).toBeNull();
    expect(variants.slice(1)).toEqual([1, 1]);
  });

  it('is absent at one pass, because one pass is not a repetition measurement', async () => {
    const result = await runAblation(
      dataset,
      constant('base'),
      promptScripted((_p, q) => `same-${q}`),
      {
        runs: 1,
        scorer: exactMatchScorer,
      },
    );
    expect(variantsOf(result)).toBeUndefined();
  });

  it('keeps the exported text vector at pass one, so the artifact does not grow by `runs`', async () => {
    // If the later passes' texts were what reached the vector, the artifact would be `runs` times larger for
    // a per-question field whose reader is a digest of one prompt. The count is what the comparison keeps.
    const result = await runAblation(
      dataset,
      constant('base'),
      promptScripted((pass, q) => `pass${pass}-${q}`),
      { runs: 3, scorer: exactMatchScorer },
    );
    expect(result.featurePromptTexts).toEqual(['pass0-Q1', 'pass0-Q2', 'pass0-Q3']);
    expect(variantsOf(result)).toEqual([3, 3, 3]);
  });

  it('does not dedupe across questions, so identical prompts for two questions count one each', async () => {
    const result = await runAblation(
      dataset,
      constant('base'),
      promptScripted(() => 'identical'),
      {
        runs: 3,
        scorer: exactMatchScorer,
      },
    );
    expect(variantsOf(result)).toEqual([1, 1, 1]);
  });
});

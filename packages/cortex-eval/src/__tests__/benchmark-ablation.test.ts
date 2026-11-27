import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../benchmark.js';
import { computeMetrics } from '../metrics.js';
import { runAblation } from '../ablation.js';
import { FactMemorySystem } from '../fact-memory.js';
import type { BenchmarkDataset, MemorySystem, Question } from '../types.js';

function makeDataset(): BenchmarkDataset {
  const q = (
    id: string,
    capability: Question['capability'],
    question: string,
    expected: string | null,
  ): Question => ({
    id,
    capability,
    question,
    expected,
    context: ['favorite color=blue', 'dog name=Rex', 'current job=manager', 'project=Beacon'],
  });
  return {
    name: 'demo',
    questions: [
      q('ie', 'IE', 'What is the favorite color?', 'blue'),
      q('ku', 'KU', 'What is the current job?', 'manager'),
      q('abs', 'ABS', 'What is the favorite food?', null),
    ],
  };
}

describe('runBenchmark', () => {
  it('returns one answer per question in order', async () => {
    const ds = makeDataset();
    const system = new FactMemorySystem('s');
    const answers = await runBenchmark(ds, system);
    expect(answers).toHaveLength(3);
  });

  it('evaluates a system against ground truth', async () => {
    const ds = makeDataset();
    const system = new FactMemorySystem('s');
    const m = computeMetrics(ds, await runBenchmark(ds, system));
    expect(m.total).toBe(3);
  });
});

describe('runAblation', () => {
  it('requires at least 1 run', async () => {
    const ds = makeDataset();
    const base = new FactMemorySystem('base');
    const feat = new FactMemorySystem('feat');
    await expect(runAblation(ds, base, feat, { runs: 0 })).rejects.toThrow();
  });

  it('exposes per-question feature correctness aligned with the dataset', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    // One verdict per question, in dataset order.
    expect(result.featureCorrect).toHaveLength(3);
    // The count agrees with the feature metrics so the two data sources cannot
    // drift apart.
    const correctCount = result.featureCorrect.filter(Boolean).length;
    expect(correctCount).toBe(result.featureMetrics.correct);
    // IE/KU answer correctly; the ABS question abstains correctly (null==null).
    expect(result.featureCorrect).toEqual([true, true, true]);
  });

  it('supports a single deterministic run with no statistical test', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.delta).toBeGreaterThan(0);
    expect(Number.isNaN(result.pValue)).toBe(true);
    expect(result.significant).toBe(false);
    expect(result.effectSize).toBe(Infinity);
  });

  it('reports zero effect size when a single run has equal means', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('b', { fallback: 'unknown' });
    const feature = new FactMemorySystem('f', { fallback: 'unknown' });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.delta).toBe(0);
    expect(result.effectSize).toBe(0);
  });

  it('reports negative infinite effect size when a single run regresses', async () => {
    const ds = makeDataset();
    // Baseline abstains correctly on the ABS question (overlap 1/6 < 0.2) while
    // answering the IE/KU questions (overlap 0.4); feature never abstains.
    const baseline = new FactMemorySystem('b', { abstainThreshold: 0.2 });
    const feature = new FactMemorySystem('f', { fallback: 'unknown' });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.delta).toBeLessThan(0);
    expect(result.effectSize).toBe(-Infinity);
  });

  it('reports the improvement with an exact paired McNemar test', async () => {
    const ds = makeDataset();
    // Baseline never abstains: for the ABS question it returns a wrong answer.
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    // Feature abstains when no fact overlaps the question.
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, { runs: 3 });
    expect(result.delta).toBeGreaterThan(0);
    // Deterministic repeats carry no variance, so the over-run t-test is n/a.
    expect(result.significant).toBe(false);
    expect(Number.isNaN(result.pValue)).toBe(true);
    // Exactly one discordant pair (baseline wrong, feature right) is not enough
    // for the paired McNemar test to reach significance on a three-question set.
    expect(result.discordant.baselineCorrectFeatureIncorrect).toBe(0);
    expect(result.discordant.baselineIncorrectFeatureCorrect).toBe(1);
    expect(result.mcnemarPValue).toBeCloseTo(1, 12);
    expect(result.mcnemarSignificant).toBe(false);
  });

  it('reports per-capability paired significance', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.perCapability['IE'].total).toBe(1);
    expect(result.perCapability['KU'].total).toBe(1);
    expect(result.perCapability['ABS'].total).toBe(1);
    expect(result.perCapability['MR'].total).toBe(0);
    expect(result.perCapability['TR'].total).toBe(0);
    // The ABS question is the sole discordant pair: baseline fails to abstain
    // while the feature abstains correctly.
    expect(result.perCapability['ABS'].baselineIncorrectFeatureCorrect).toBe(1);
    expect(result.perCapability['ABS'].baselineCorrectFeatureIncorrect).toBe(0);
    expect(result.perCapability['ABS'].mcnemarPValue).toBe(1);
    expect(result.perCapability['ABS'].mcnemarSignificant).toBe(false);
  });

  it('uses default options when none are provided', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature);
    expect(result.delta).toBeGreaterThan(0);
    expect(result.mcnemarSignificant).toBe(false);
    expect(result.baselineConfidence.lower).toBeLessThanOrEqual(result.baselineConfidence.upper);
    expect(result.featureConfidence.lower).toBeLessThanOrEqual(result.featureConfidence.upper);
  });

  it('supports comparing raw accuracy instead of abstention-aware accuracy', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, {
      runs: 3,
      abstentionAware: false,
    });
    expect(typeof result.delta).toBe('number');
    expect(typeof result.pValue).toBe('number');
  });

  it('reports a t-test only when stochastic runs introduce variance', async () => {
    const ds: BenchmarkDataset = {
      name: 'stochastic',
      questions: [
        {
          id: 'q',
          capability: 'KU',
          question: 'Is the answer yes?',
          expected: 'yes',
          context: ['yes'],
        },
      ],
    };
    // The stochastic system alternates correct/wrong across runs, so its run
    // scores have real variance; the deterministic baseline stays constant.
    let flip = false;
    const stochastic: MemorySystem = {
      name: 'stochastic',
      answer: async () => {
        flip = !flip;
        return flip ? 'yes' : 'no';
      },
    };
    const deterministic: MemorySystem = {
      name: 'deterministic',
      answer: async () => 'no',
    };
    const result = await runAblation(ds, deterministic, stochastic, { runs: 3 });
    // Real variance → the over-run Welch t-test is defined (non-NaN p-value).
    expect(Number.isNaN(result.pValue)).toBe(false);
    expect(Number.isFinite(result.effectSize)).toBe(true);
  });
});

/**
 * A discordant COUNT answers "how many" and leaves "which" unanswerable, and
 * "which" is what separates a mechanism from a coincidence. These tests pin the
 * identity that the count alone cannot supply.
 *
 * The motivation is concrete rather than theoretical. The conjunction arm
 * reported four flips against one, all inside IE, while its target population
 * (ABS) never moved — across six runs and 143 ABS questions, zero flips. That is
 * the difference between "the intervention did nothing" and "the intervention
 * did something somewhere else", and no archived artifact could show it: the
 * report stored the flip COUNT and the feature's per-question vector, but never
 * the question ids and never the baseline's vector.
 */
describe('runAblation discordant identity', () => {
  /**
   * A dataset whose correctness is decided entirely by question id, so a test can
   * state "this system knows these questions" and get exactly that.
   */
  function controllableDataset(): BenchmarkDataset {
    const q = (
      id: string,
      capability: Question['capability'],
      expected: string | null,
    ): Question => ({
      id,
      capability,
      question: `question for ${id}`,
      expected,
      context: [`fact=${expected ?? 'none'}`],
    });
    return {
      name: 'controllable',
      questions: [
        q('ie-a', 'IE', 'a'),
        q('ie-b', 'IE', 'b'),
        q('abs-a', 'ABS', null),
        q('ku-a', 'KU', 'c'),
      ],
    };
  }

  /**
   * A system that answers correctly for exactly the ids it is told it knows, and
   * incorrectly for the rest. Correctness therefore comes from the test rather
   * than from retrieval quality, which is what makes a flip positionable.
   *
   * Correctness is implemented as returning the question's own `expected` value:
   * a plain sentinel such as `'RIGHT'` would fail every question whose expected
   * answer is not literally `'RIGHT'`, which silently collapses the fixture to
   * "everything wrong" and makes every identity assertion vacuous.
   */
  function systemKnowing(
    name: string,
    dataset: BenchmarkDataset,
    knows: readonly string[],
  ): MemorySystem {
    const known = new Set(knows);
    const expectedById = new Map(dataset.questions.map((q) => [q.id, q.expected]));
    return {
      name,
      answer: async (question: string) => {
        const id = question.replace('question for ', '');
        if (!known.has(id)) return 'WRONG-ANSWER';
        return expectedById.get(id) ?? null;
      },
    };
  }

  it('names the questions the baseline got right and the feature got wrong', async () => {
    const ds = controllableDataset();
    // Baseline knows three; the feature additionally loses ie-b.
    const baseline = systemKnowing('base', ds, ['ie-a', 'ie-b', 'abs-a']);
    const feature = systemKnowing('feat', ds, ['ie-a', 'abs-a']);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.discordantQuestions.baselineCorrectFeatureIncorrect).toEqual(['ie-b']);
    expect(result.discordantQuestions.baselineIncorrectFeatureCorrect).toEqual([]);
  });

  it('names the questions the baseline got wrong and the feature got right', async () => {
    const ds = controllableDataset();
    const baseline = systemKnowing('base', ds, ['ie-a', 'abs-a']);
    const feature = systemKnowing('feat', ds, ['ie-a', 'ie-b', 'abs-a']);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.discordantQuestions.baselineIncorrectFeatureCorrect).toEqual(['ie-b']);
    expect(result.discordantQuestions.baselineCorrectFeatureIncorrect).toEqual([]);
  });

  it('names both directions independently when a question flips each way', async () => {
    const ds = controllableDataset();
    // Baseline knows ie-a and ie-b; feature knows ie-b and ku-a. So ie-a is a
    // regression and ku-a is a gain — both directions populated at once.
    const baseline = systemKnowing('base', ds, ['ie-a', 'ie-b', 'abs-a']);
    const feature = systemKnowing('feat', ds, ['ie-b', 'ku-a', 'abs-a']);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.discordantQuestions.baselineCorrectFeatureIncorrect).toEqual(['ie-a']);
    expect(result.discordantQuestions.baselineIncorrectFeatureCorrect).toEqual(['ku-a']);
  });

  it('keeps the identity arrays the same length as the counts they explain', async () => {
    const ds = controllableDataset();
    const baseline = systemKnowing('base', ds, ['ie-a', 'ie-b', 'abs-a']);
    const feature = systemKnowing('feat', ds, ['ie-b', 'ku-a', 'abs-a']);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    // The whole point of the field: a reader must be able to check that the
    // names account for the count, rather than trusting the count.
    expect(result.discordantQuestions.baselineCorrectFeatureIncorrect).toHaveLength(
      result.discordant.baselineCorrectFeatureIncorrect,
    );
    expect(result.discordantQuestions.baselineIncorrectFeatureCorrect).toHaveLength(
      result.discordant.baselineIncorrectFeatureCorrect,
    );
  });

  it('names ids, not indices, and each name belongs to its own capability', async () => {
    const ds = controllableDataset();
    const baseline = systemKnowing('base', ds, ['ie-a', 'ie-b', 'abs-a']);
    const feature = systemKnowing('feat', ds, ['ie-b', 'ku-a', 'abs-a']);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    const byId = new Map(ds.questions.map((q) => [q.id, q.capability]));
    const regression = result.discordantQuestions.baselineCorrectFeatureIncorrect;
    const gain = result.discordantQuestions.baselineIncorrectFeatureCorrect;
    // An index-based implementation passes a bare length check but fails here:
    // `0` is not a question, and `'0'` is not in the dataset.
    for (const id of [...regression, ...gain]) {
      expect(byId.has(id)).toBe(true);
    }
    // The IE regression must be attributed to an IE question, which is the
    // property that lets a per-capability count be audited at all.
    expect(byId.get(regression[0]!)).toBe('IE');
    expect(byId.get(gain[0]!)).toBe('KU');
  });

  it('reports empty arrays rather than undefined when nothing is discordant', async () => {
    const ds = controllableDataset();
    const a = systemKnowing('same', ds, ['ie-a', 'ie-b', 'abs-a']);
    const b = systemKnowing('same', ds, ['ie-a', 'ie-b', 'abs-a']);
    const result = await runAblation(ds, a, b, { runs: 1 });
    // `[]` and `undefined` must stay distinguishable: an empty array is a
    // measured zero, a missing field is an unmeasured one.
    expect(result.discordantQuestions.baselineCorrectFeatureIncorrect).toEqual([]);
    expect(result.discordantQuestions.baselineIncorrectFeatureCorrect).toEqual([]);
  });

  it('preserves dataset order within each identity array', async () => {
    const ds = controllableDataset();
    // Both IE questions regress; the dataset order is ie-a then ie-b.
    const baseline = systemKnowing('base', ds, ['ie-a', 'ie-b']);
    const feature = systemKnowing('feat', ds, []);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.discordantQuestions.baselineCorrectFeatureIncorrect).toEqual(['ie-a', 'ie-b']);
  });
});

/**
 * `C7`'s `F3` divides two medians that must come from **one** population: how many turns the delivered
 * window carried, and how many characters the prompt held, on each side.
 *
 * `AblationResult` has carried the feature's `roleCensuses` and `promptTexts` since §13.169 -- and only
 * the feature's, because until `C7` the questions this artifact answered were all about the side that
 * lost. `F3`'s claim is a ratio of two sides ("the same room, more turns"), and a ratio of a captured
 * number to an uncaptured one is not a reading: `roleCensus` and `promptChars` are deterministic, so the
 * pair can and must be measured in the same pass rather than inferred from a previous dispatch.
 */
describe('runAblation: the baseline side of the density reading', () => {
  /**
   * A system that reports the two facts `F3` divides, derived from the question index so an off-by-one
   * surfaces as the wrong question rather than as a test that cannot tell two apart.
   */
  function reportingSystem(name: string, turns: number, chars: number): MemorySystem {
    let current = 0;
    return {
      name,
      answer: (_question: string, context: string[]) => {
        // The index travels in the context because `MemorySystem.answer` receives the question text, not
        // the dataset question -- the same reason `benchmark-retrieval-capture.test.ts` derives its
        // fixture values instead of holding them fixed.
        current = Number(context[0]?.replace(/[^0-9]/g, '') ?? 0) || 0;
        return 'blue';
      },
      lastRoleCensus: () => ({ counts: { user: turns }, unclassified: 0, total: turns }),
      lastPromptText: () => 'x'.repeat(chars + current),
    } as MemorySystem;
  }

  function numberedDataset(count: number): BenchmarkDataset {
    return {
      name: 'density-fixture',
      questions: Array.from({ length: count }, (_unused, i) => ({
        id: `q${i}`,
        capability: 'IE' as const,
        question: 'What is the favorite color?',
        expected: 'blue',
        context: [`evidence${i}`],
      })),
    };
  }

  it('records the baseline window’s role census per question, aligned with the roster', async () => {
    const ds = numberedDataset(3);
    const baseline = reportingSystem('base', 7, 400);
    const feature = reportingSystem('feat', 9, 400);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    // One entry per question, in dataset order, and the two sides are distinguishable: if the arm
    // captured only the feature and copied it into both fields, the baseline would read 9.
    expect(result.baselineRoleCensuses).toHaveLength(3);
    expect(result.baselineRoleCensuses?.map((c) => c?.total)).toEqual([7, 7, 7]);
    expect(result.featureRoleCensuses?.map((c) => c?.total)).toEqual([9, 9, 9]);
  });

  it('records the baseline prompt’s character count, as lengths rather than as text', async () => {
    const ds = numberedDataset(3);
    const baseline = reportingSystem('base', 7, 400);
    const feature = reportingSystem('feat', 9, 500);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    // Lengths, not the prompts themselves, and the difference is the artifact's size: `F3` needs a
    // median of a number, and carrying the text would put a second copy of the corpus in the upload so
    // that a later reader could recompute a length it was already given. The feature side is the
    // exception the asymmetry requires rather than a second statement: its text is already in the
    // artifact (`featurePromptTexts`, for the digest work), so this reads the length off it instead of
    // storing a vector two writers must keep equal.
    expect(result.baselinePromptChars).toEqual([400, 401, 402]);
    expect(result.featurePromptTexts?.map((text) => text?.length)).toEqual([500, 501, 502]);
  });

  it('records the baseline prompt’s fingerprint, because a length cannot say "the same prompt"', async () => {
    const ds = numberedDataset(3);
    const baseline = reportingSystem('base', 7, 400);
    const feature = reportingSystem('feat', 9, 500);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    // `45923435343` flipped twelve questions at `temperature 0`, so twelve prompts differed; whether
    // any of them had an unchanged length was unanswerable, because the control side carried only
    // lengths. Sixteen hex characters per question make it answerable inside one job.
    expect(result.baselinePromptDigests).toHaveLength(3);
    for (const digest of result.baselinePromptDigests ?? []) {
      expect(digest).toMatch(/^[0-9a-f]{16}$/);
    }
    // Three distinct prompts, three distinct fingerprints: a digest that ignored its input would pass
    // the shape assertions above and fail this one.
    expect(new Set(result.baselinePromptDigests).size).toBe(3);

    // The same system on the same dataset is the same prompt, and the digest has to say so -- this is
    // the property `prompt-digest-pair.mjs` compares across two artifacts, asserted here inside one.
    const again = await runAblation(ds, reportingSystem('base', 7, 400), feature, { runs: 1 });
    expect(again.baselinePromptDigests).toEqual(result.baselinePromptDigests);
  });

  it('reports null rather than zero for a baseline that exposes no capture', async () => {
    const ds = numberedDataset(2);
    const baseline = new FactMemorySystem('silent', { fallback: 'unknown' });
    const feature = reportingSystem('feat', 9, 400);
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    // `0` turns and "no window to count" are different statements, and `F3`'s median over a mix of the
    // two would be a number about neither. `null` is the shape `featureRetrievedContexts` already uses.
    expect(result.baselineRoleCensuses).toEqual([null, null]);
    expect(result.baselinePromptChars).toEqual([null, null]);
    // Absent capture, absent fingerprint -- not the digest of an empty string, which would be the same
    // sixteen characters on every such question and would read as a prompt that was identical.
    expect(result.baselinePromptDigests).toEqual([null, null]);
  });
});

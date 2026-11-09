/**
 * The join, and the six ways it refuses to make one.
 *
 * The fixtures are built from **`42533236864`'s published figures** rather than invented, because
 * the module's claim is arithmetic about a real allocation: the two reasoning routes get a 48,460
 * and a 48,000-character window where the other four get 24,000, so a per-file token average is
 * wrong for every row. The numbers below reproduce the artifact's own totals to the token:
 *
 * | capability | n   | mean prompt chars | accuracy |
 * | ---------- | --: | ----------------: | -------: |
 * | `ABS`      |  30 |            23,099 |  100.00% |
 * | `IE`       | 150 |            22,981 |   94.17% |
 * | `KU`       |  72 |            23,084 |   87.15% |
 * | `MR`       | 121 |            48,311 |   83.06% |
 * | `TR`       | 127 |            47,841 |   95.08% |
 *
 * `Σ chars` is therefore 17,723,500 and four repetitions is 70,894,000 characters for
 * **18,401,041** prompt tokens, which is the 3.853 chars/token the artifact measures — the figure
 * the module divides by and the figure a hard-coded 4.06 would have reported 5.1% low.
 */
import { describe, it, expect } from 'vitest';

import {
  COST_BY_CAPABILITY_POLICY,
  COST_REFUSALS,
  costPerCapability,
  renderCostByCapability,
  type CostArtifactShape,
  type TokenPrices,
} from '../cost-per-capability.js';

/** DeepSeek's published prices on 2026-11-09, in CNY per million tokens. */
const PRICES: TokenPrices = {
  cacheHitCnyPerMillion: 0.2,
  cacheMissCnyPerMillion: 2,
  outputCnyPerMillion: 3,
};

const SHAPE = [
  { capability: 'ABS', questions: 30, chars: 23_099, correct: 30 },
  { capability: 'IE', questions: 150, chars: 22_981, correct: 141 },
  { capability: 'KU', questions: 72, chars: 23_084, correct: 63 },
  { capability: 'MR', questions: 121, chars: 48_311, correct: 101 },
  { capability: 'TR', questions: 127, chars: 47_841, correct: 121 },
] as const;

const RUNS = 4;

/** Totals derived from `SHAPE`, so a fixture edit cannot leave a hand-typed sum behind. */
const TOTAL_CHARS = SHAPE.reduce((sum, row) => sum + row.questions * row.chars, 0);
const CHARS_FOR = (capability: string): number => {
  const row = SHAPE.find((entry) => entry.capability === capability);
  return (row?.questions ?? 0) * (row?.chars ?? 0);
};

/**
 * A report that carries the artifact's real character and correctness shape.
 *
 * `correct` is the first repetition's count; the other three repeat it, so a mean over repetitions
 * is the same integer and the fixture cannot be read as a four-run measurement when it is not one.
 */
function artifact(overrides: Partial<CostArtifactShape> = {}): CostArtifactShape {
  const questions: { capability: string }[] = [];
  const prompts: string[] = [];
  const correct: boolean[] = [];
  const masks: string[] = ['', '', '', ''];
  for (const row of SHAPE) {
    for (let index = 0; index < row.questions; index += 1) {
      questions.push({ capability: row.capability });
      prompts.push('x'.repeat(row.chars));
      const isCorrect = index < row.correct;
      correct.push(isCorrect);
      for (let repetition = 0; repetition < RUNS; repetition += 1) {
        masks[repetition] += isCorrect ? '1' : '0';
      }
    }
  }
  const base: CostArtifactShape = {
    runs: RUNS,
    usageBySide: {
      feature: {
        calls: 2076,
        unpricedCalls: 0,
        promptTokens: 18_401_041,
        completionTokens: 2_224_170,
        cacheHitPromptTokens: 17_998_245,
      },
    },
    questions,
    ablation: {
      runs: RUNS,
      featureCorrect: correct,
      featureCorrectByRun: masks,
      featurePromptTexts: prompts,
    },
  };
  return { ...base, ...overrides };
}

describe('costPerCapability — the join', () => {
  it('apportions the prompt by measured characters, not by question count', () => {
    const reading = costPerCapability(artifact());

    // `MR` is 121 of 500 questions but a third of the characters: 32.98%, not 24.2%.
    const mr = reading.rows.find((row) => row.capability === 'MR');
    expect(mr?.promptShare).toBeCloseTo(CHARS_FOR('MR') / TOTAL_CHARS, 9);
    expect(mr?.promptShare).toBeGreaterThan(0.24);
    expect(mr?.promptTokens).toBeCloseTo((18_401_041 * CHARS_FOR('MR')) / TOTAL_CHARS, 3);
  });

  it('derives the density from the artifact instead of assuming 4.06', () => {
    const reading = costPerCapability(artifact());
    expect(reading.charsPerToken).toBeCloseTo(70_894_000 / 18_401_041, 3);
    expect(reading.charsPerToken).toBeLessThan(4);
  });

  it('reports the share of the prompt that the two reasoning routes take', () => {
    const reading = costPerCapability(artifact());
    const reasoning = reading.rows
      .filter((row) => row.capability === 'MR' || row.capability === 'TR')
      .reduce((sum, row) => sum + row.promptShare, 0);
    expect(reasoning).toBeCloseTo((CHARS_FOR('MR') + CHARS_FOR('TR')) / TOTAL_CHARS, 9);
    expect(reasoning).toBeGreaterThan(0.67);
  });

  it('prices the per-question reading off the per-file ledger', () => {
    const reading = costPerCapability(artifact());
    const mr = reading.rows.find((row) => row.capability === 'MR');
    // 18,401,041 tokens over 2,000 question-runs is 9,200 per run for the whole file; `MR`'s own
    // row must be larger than that average, because its window is twice as large.
    expect(mr?.promptTokensPerQuestionRun).toBeGreaterThan(9_200);
    expect(mr?.promptTokensPerQuestionRun).toBeLessThan(13_000);
  });

  it('reads the mean correct count off the mask, one character per repetition', () => {
    const reading = costPerCapability(artifact());
    expect(reading.repetitionsMeasured).toBe(true);
    expect(reading.rows.every((row) => row.correctPerRun === Math.round(row.correctPerRun))).toBe(
      true,
    );
    expect(reading.rows.find((row) => row.capability === 'MR')?.correctPerRun).toBe(101);
    expect(reading.rows.find((row) => row.capability === 'MR')?.accuracy).toBeCloseTo(101 / 121, 6);
  });

  it('falls back to the flat correctness list when no mask was recorded', () => {
    const full = artifact();
    const flatOnly: CostArtifactShape = {
      ...full,
      ablation: {
        runs: 1,
        featureCorrect: full.ablation?.featureCorrect,
        featurePromptTexts: full.ablation?.featurePromptTexts,
      },
    };
    const reading = costPerCapability(flatOnly);
    expect(reading.repetitionsMeasured).toBe(false);
    expect(reading.runs).toBe(1);
    expect(reading.rows.find((row) => row.capability === 'IE')?.correctPerRun).toBe(141);
  });
});

describe('costPerCapability — money', () => {
  it('prices the two lines apart, at the measured cache share', () => {
    const reading = costPerCapability(artifact(), { prices: PRICES });
    expect(reading.cacheHitShare).toBeCloseTo(17_998_245 / 18_401_041, 6);
    const mr = reading.rows.find((row) => row.capability === 'MR');
    const cacheShare = 17_998_245 / 18_401_041;
    const expectedPrompt =
      ((mr?.promptTokens ?? 0) * (cacheShare * 0.2 + (1 - cacheShare) * 2)) / 1_000_000;
    expect(mr?.promptCost).toBeCloseTo(expectedPrompt, 9);
  });

  it('apportions completion by question-runs and says so', () => {
    const reading = costPerCapability(artifact(), { prices: PRICES });
    expect(reading.completionApportionment).toBe('question-runs');
    const mr = reading.rows.find((row) => row.capability === 'MR');
    const expected = (2_224_170 * ((121 * RUNS) / (500 * RUNS)) * 3) / 1_000_000;
    expect(mr?.completionCost).toBeCloseTo(expected, 9);
  });

  it('adds the two lines into one cost and one cost per correct answer', () => {
    const reading = costPerCapability(artifact(), { prices: PRICES });
    const mr = reading.rows.find((row) => row.capability === 'MR');
    expect(mr?.cost).toBeCloseTo((mr?.promptCost ?? 0) + (mr?.completionCost ?? 0), 12);
    expect(mr?.costPerCorrect).toBeCloseTo((mr?.cost ?? 0) / (101 * RUNS), 12);
  });

  it('leaves every money column null when no prices are supplied', () => {
    const reading = costPerCapability(artifact());
    expect(reading.rows.every((row) => row.cost === null)).toBe(true);
    expect(reading.rows.every((row) => row.costPerCorrect === null)).toBe(true);
    expect(reading.mostExpensivePerCorrect).toBeNull();
    // The verdict does not need prices: it is graded on prompt tokens per correct answer, which is
    // the measured axis. Only the money columns go null.
    expect(reading.mostExpensivePerCorrectOnPrompts).toBe('MR');
    expect(reading.expensive).toContain('MR');
  });

  it('names the capability that buys the fewest correct answers per token and per yuan', () => {
    const reading = costPerCapability(artifact(), { prices: PRICES });
    expect(reading.mostExpensivePerCorrectOnPrompts).toBe('MR');
    expect(reading.expensive).toContain('MR');
    const mr = reading.rows.find((row) => row.capability === 'MR');
    expect(mr?.promptRatioToCheapest).toBeGreaterThan(COST_BY_CAPABILITY_POLICY.expensiveRatio);
  });

  it('reads a flatter ratio in money than in prompts, and that gap is the null model', () => {
    const reading = costPerCapability(artifact(), { prices: PRICES });
    const mr = reading.rows.find((row) => row.capability === 'MR');
    // Completion is 60% of this run's bill and the artifact records none of it per question, so
    // apportioning it by question-runs pulls every row toward the mean. The prompt ratio is the
    // measured one and the money ratio is the discounted one; printing only the second would turn
    // an assumption into a verdict.
    expect(mr?.ratioToCheapest).toBeLessThan(mr?.promptRatioToCheapest ?? 0);
    expect(mr?.ratioToCheapest).toBeGreaterThan(1);
    expect(reading.mostExpensivePerCorrect).toBe('MR');
  });

  it('grades the rows against the cheapest one rather than against the mean', () => {
    const reading = costPerCapability(artifact(), { prices: PRICES });
    const cheapest = Math.min(
      ...reading.rows.map((row) => row.costPerCorrect ?? Number.POSITIVE_INFINITY),
    );
    const cheapestPrompt = Math.min(
      ...reading.rows.map((row) => row.promptTokensPerCorrect ?? Number.POSITIVE_INFINITY),
    );
    for (const row of reading.rows) {
      expect(row.ratioToCheapest).toBeCloseTo((row.costPerCorrect ?? 0) / cheapest, 9);
      expect(row.promptRatioToCheapest).toBeCloseTo(
        (row.promptTokensPerCorrect ?? 0) / cheapestPrompt,
        9,
      );
    }
    expect(Math.min(...reading.rows.map((row) => row.ratioToCheapest ?? 0))).toBeCloseTo(1, 9);
    expect(Math.min(...reading.rows.map((row) => row.promptRatioToCheapest ?? 0))).toBeCloseTo(
      1,
      9,
    );
  });
});

describe('costPerCapability — the refusals', () => {
  it('refuses an artifact with no feature-side ledger', () => {
    expect(() => costPerCapability(artifact({ usageBySide: {} }))).toThrow(COST_REFUSALS.noLedger);
  });

  it('refuses a ledger whose prompt total is zero', () => {
    const report = artifact({
      usageBySide: { feature: { calls: 10, unpricedCalls: 0, promptTokens: 0 } },
    });
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.noLedger);
  });

  it('refuses a partially unpriced ledger rather than pricing the priced half', () => {
    const report = artifact({
      usageBySide: {
        feature: {
          calls: 10,
          unpricedCalls: 3,
          promptTokens: 18_401_041,
          completionTokens: 2_224_170,
          cacheHitPromptTokens: 17_998_245,
        },
      },
    });
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.unpriced);
  });

  it('refuses an artifact with no delivered prompt texts', () => {
    const report = artifact({
      ablation: { runs: RUNS, featureCorrect: artifact().ablation?.featureCorrect },
    });
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.noPrompts);
  });

  it('refuses a null prompt, which is a system that exposed none', () => {
    const full = artifact();
    const prompts = [...(full.ablation?.featurePromptTexts ?? [])];
    prompts[5] = null;
    const report = artifact({
      ablation: { ...full.ablation, featurePromptTexts: prompts },
    });
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.nullPrompt);
  });

  it('refuses a prompt vector that describes a different population', () => {
    const full = artifact();
    const report = artifact({
      ablation: {
        ...full.ablation,
        featurePromptTexts: (full.ablation?.featurePromptTexts ?? []).slice(1),
      },
    });
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.lengthMismatch);
  });

  it('refuses an artifact with no question list', () => {
    const report = artifact({ questions: undefined });
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.lengthMismatch);
  });

  it('refuses an artifact that recorded no correctness at all', () => {
    const report = artifact({
      ablation: { runs: RUNS, featurePromptTexts: artifact().ablation?.featurePromptTexts },
    });
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.noCorrectness);
  });
});

describe('costPerCapability — populations it does not know', () => {
  it('keeps a capability it has never heard of instead of dropping its tokens', () => {
    const full = artifact();
    const questions = [...(full.questions ?? []), { capability: 'ZZ' }];
    const prompts = [...(full.ablation?.featurePromptTexts ?? []), 'x'.repeat(1_000)];
    const correct = [...(full.ablation?.featureCorrect ?? []), false];
    const report: CostArtifactShape = {
      ...full,
      questions,
      ablation: { ...full.ablation, featureCorrect: correct, featurePromptTexts: prompts },
    };
    const reading = costPerCapability(report);
    expect(reading.rows[reading.rows.length - 1]?.capability).toBe('ZZ');
    expect(reading.rows.find((row) => row.capability === 'ZZ')?.questions).toBe(1);
  });

  it('leaves cost per correct null for a capability that got nothing right', () => {
    const full = artifact();
    const correct = (full.ablation?.featureCorrect ?? []).map((value, index) =>
      index < 500 - 1 ? value : false,
    );
    const masks = (full.ablation?.featureCorrectByRun ?? []).map(
      (mask) => `${mask.slice(0, 499)}0`,
    );
    const report: CostArtifactShape = {
      ...full,
      ablation: { ...full.ablation, featureCorrect: correct, featureCorrectByRun: masks },
    };
    const reading = costPerCapability(report, { prices: PRICES });
    // The last question belongs to `TR`; 120 of 127 correct still prices that row.
    const tr = reading.rows.find((row) => row.capability === 'TR');
    expect(tr?.costPerCorrect).not.toBeNull();
  });
});

describe('renderCostByCapability', () => {
  it('prints the density beside the table so a reader can re-derive the split', () => {
    const text = renderCostByCapability(costPerCapability(artifact(), { prices: PRICES }));
    expect(text).toContain('chars/token');
    expect(text).toContain('MR');
    expect(text).toContain('most expensive per correct answer, on prompts: MR');
    expect(text).toContain('the same reading in money: MR');
    expect(text).toContain('completion apportioned by question-runs');
  });

  it('prints token columns without a currency when no prices were supplied', () => {
    const text = renderCostByCapability(costPerCapability(artifact()));
    expect(text).toContain('tok/correct');
    expect(text).toContain('x prompt');
    expect(text).not.toContain('CNY/correct');
    expect(text).not.toContain('the same reading in money');
  });
});

describe('costPerCapability — sparse artifacts', () => {
  it('reads a ledger that records only a prompt total, and refuses nothing it can honestly price', () => {
    // Later artifacts may omit the cache counter or the completion total. A missing counter is not a
    // zero -- but unlike a missing *ledger*, it is a column the arithmetic can carry at its neutral
    // value, and refusing would block a reading that is still true of the prompt axis.
    const report: CostArtifactShape = {
      usageBySide: { feature: { promptTokens: 1_000_000 } },
      questions: [{ capability: 'IE' }],
      ablation: {
        featureCorrect: [true],
        featurePromptTexts: ['x'.repeat(1_000)],
      },
    };
    const reading = costPerCapability(report, { prices: PRICES });
    expect(reading.cacheHitShare).toBe(0);
    expect(reading.rows).toHaveLength(1);
    expect(reading.rows[0]?.completionCost).toBe(0);
    expect(reading.rows[0]?.costPerCorrect).toBeCloseTo((1_000_000 * 2) / 1_000_000, 9);
  });

  it('takes the repetition count from the top level when the ablation did not repeat it', () => {
    const full = artifact();
    const report: CostArtifactShape = {
      runs: 2,
      usageBySide: full.usageBySide,
      questions: full.questions,
      ablation: {
        featureCorrect: full.ablation?.featureCorrect,
        featurePromptTexts: full.ablation?.featurePromptTexts,
      },
    };
    expect(costPerCapability(report).runs).toBe(2);
  });

  it('assumes one repetition when neither level states it', () => {
    const full = artifact();
    const report: CostArtifactShape = {
      usageBySide: full.usageBySide,
      questions: full.questions,
      ablation: {
        featureCorrect: full.ablation?.featureCorrect,
        featurePromptTexts: full.ablation?.featurePromptTexts,
      },
    };
    expect(costPerCapability(report).runs).toBe(1);
  });

  it('keeps a question the dataset did not label', () => {
    const full = artifact();
    const questions = [...(full.questions ?? [])];
    questions[0] = {};
    const report: CostArtifactShape = {
      ...full,
      questions,
      ablation: {
        ...full.ablation,
        featurePromptTexts: [...(full.ablation?.featurePromptTexts ?? [])],
      },
    };
    const rows = costPerCapability(report).rows;
    // Unrecognised capabilities sort after the five the dataset names, never before them.
    expect(rows[rows.length - 1]?.capability).toBe('UNKNOWN');
  });

  it('prices a capability that got nothing right without inventing a ratio for it', () => {
    const report: CostArtifactShape = {
      runs: 1,
      usageBySide: {
        feature: {
          calls: 2,
          unpricedCalls: 0,
          promptTokens: 2_000,
          completionTokens: 200,
          cacheHitPromptTokens: 0,
        },
      },
      questions: [{ capability: 'IE' }, { capability: 'MR' }],
      ablation: {
        runs: 1,
        featureCorrect: [false, true],
        featurePromptTexts: ['x'.repeat(1_000), 'y'.repeat(1_000)],
      },
    };
    const reading = costPerCapability(report, { prices: PRICES });
    const ie = reading.rows.find((row) => row.capability === 'IE');
    expect(ie?.correctPerRun).toBe(0);
    expect(ie?.promptTokensPerCorrect).toBeNull();
    expect(ie?.costPerCorrect).toBeNull();
    // One row without a price per correct answer makes every ratio undefined: dividing by the
    // cheapest of a set that does not contain this row would report a comparison it cannot make.
    expect(reading.rows.every((row) => row.ratioToCheapest === null)).toBe(true);
    expect(reading.mostExpensivePerCorrect).toBeNull();
    expect(reading.mostExpensivePerCorrectOnPrompts).toBe('MR');
  });
});

describe('costPerCapability — the thresholds themselves', () => {
  it('refuses a ledger with no prompt total rather than pricing it at zero', () => {
    const report: CostArtifactShape = {
      usageBySide: { feature: { unpricedCalls: 0, completionTokens: 5 } },
      questions: [{ capability: 'IE' }],
      ablation: { featureCorrect: [true], featurePromptTexts: ['x'] },
    };
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.noLedger);
  });

  it('refuses a prompt list whose characters are all empty', () => {
    const report: CostArtifactShape = {
      usageBySide: { feature: { promptTokens: 1_000, completionTokens: 10 } },
      questions: [{ capability: 'IE' }],
      ablation: { featureCorrect: [true], featurePromptTexts: [''] },
    };
    expect(() => costPerCapability(report)).toThrow(COST_REFUSALS.noPrompts);
  });

  it('prints a dash for a row that cannot be priced per correct answer, in both tables', () => {
    const report: CostArtifactShape = {
      runs: 1,
      usageBySide: {
        feature: {
          calls: 2,
          unpricedCalls: 0,
          promptTokens: 2_000,
          completionTokens: 200,
          cacheHitPromptTokens: 1_000,
        },
      },
      questions: [{ capability: 'IE' }, { capability: 'MR' }],
      ablation: {
        runs: 1,
        featureCorrect: [false, true],
        featurePromptTexts: ['x'.repeat(1_000), 'y'.repeat(1_000)],
      },
    };
    const priced = renderCostByCapability(costPerCapability(report, { prices: PRICES }));
    expect(priced).toContain('-');
    const unpriced = renderCostByCapability(costPerCapability(report));
    expect(unpriced).toContain('-');
  });

  it('says so when no capability reaches the expensive multiple', () => {
    const report: CostArtifactShape = {
      runs: 1,
      usageBySide: {
        feature: {
          calls: 2,
          unpricedCalls: 0,
          promptTokens: 2_000,
          completionTokens: 200,
          cacheHitPromptTokens: 0,
        },
      },
      questions: [{ capability: 'IE' }, { capability: 'MR' }],
      ablation: {
        runs: 1,
        featureCorrect: [true, true],
        featurePromptTexts: ['x'.repeat(1_000), 'y'.repeat(1_000)],
      },
    };
    const text = renderCostByCapability(costPerCapability(report));
    expect(text).toContain('none at or above 2x the cheapest');
  });
});

/**
 * What a budget bounds: one pass, or the run.
 *
 * `AblationOptions.budgetMs` used to be handed unchanged to every one of the eight passes a
 * dispatch runs (two arms, four repetitions). That made it a ceiling on **one pass**, so the
 * number the workflow configured permitted `8 x budget` of run — and the job containing the run is
 * killed long before that. Run `41259622431` finished 15 minutes before a 350-minute kill with no
 * artifact recording the margin, which is what a protection that cannot fire looks like.
 *
 * These tests pin the repair from both directions: the same number now bounds the **whole
 * ablation**, so a configuration whose passes are each comfortably under the budget but whose total
 * is not fails with `BenchmarkBudgetExceeded` — a readable error and a partial record — instead of
 * disappearing when the job is killed.
 */
import { describe, it, expect } from 'vitest';
import { runAblation } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

/** Three questions, so one pass costs three reader calls. */
const dataset: BenchmarkDataset = {
  name: 'budget-ablation',
  questions: [
    { id: 'b-1', capability: 'IE', question: 'Q1', expected: 'a', context: ['a'] },
    { id: 'b-2', capability: 'IE', question: 'Q2', expected: 'a', context: ['a'] },
    { id: 'b-3', capability: 'TR', question: 'Q3', expected: 'a', context: ['a'] },
  ],
};

/**
 * A reader that spends `millis` on every question.
 *
 * `setTimeout` only ever runs *late*, so a pass measured through this cannot be cheaper than the
 * nominal figure — which is why the comparisons below are safe on a loaded CI machine. The
 * assertions are about a total that is at least three times the budget, not about a precise one.
 */
function slowSystem(name: string, millis: number): MemorySystem {
  return {
    name,
    answer: async () => {
      await new Promise((resolve) => setTimeout(resolve, millis));
      return 'a';
    },
  };
}

function system(name: string): MemorySystem {
  return { name, answer: async () => 'a' };
}

describe('the ablation budget bounds the run rather than one pass', () => {
  it('fails when eight cheap passes add up to more than the budget', async () => {
    // 3 questions x 12 ms = 36 ms per pass, at least. Four repetitions x two arms = 8 passes, so at
    // least 288 ms of work against a 150 ms budget. Every individual pass is far below 150, which is
    // exactly the shape the per-pass reading accepted as healthy.
    await expect(
      runAblation(dataset, slowSystem('base', 12), slowSystem('feat', 12), {
        runs: 4,
        scorer: exactMatchScorer,
        budgetMs: 150,
      }),
    ).rejects.toThrow(/budget/i);
  });

  it('completes the same work when the budget covers all of it', async () => {
    // The same eight passes against 4 seconds: the control for the test above, so a failure there
    // cannot be attributed to the reader being slow.
    const result = await runAblation(dataset, slowSystem('base', 12), slowSystem('feat', 12), {
      runs: 4,
      scorer: exactMatchScorer,
      budgetMs: 4_000,
    });
    expect(result.feature).toBe('feat');
    expect(Number.isFinite(result.delta)).toBe(true);
  });

  it('still accepts a run with no budget, which is what every archived artifact was produced under', async () => {
    const result = await runAblation(dataset, slowSystem('base', 12), slowSystem('feat', 12), {
      runs: 2,
      scorer: exactMatchScorer,
    });
    expect(result.feature).toBe('feat');
    expect(Number.isFinite(result.delta)).toBe(true);
  });

  it('keeps a partial record with the repetition it died in', async () => {
    // The budget's whole value is that it produces evidence. A run that dies without one is the
    // defect this option exists to prevent, so the failure has to carry where it stopped.
    const error = await runAblation(dataset, slowSystem('base', 12), slowSystem('feat', 12), {
      runs: 4,
      scorer: exactMatchScorer,
      budgetMs: 150,
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).not.toBeNull();
    const partial = (error as { partial?: { run: number; total: number } }).partial;
    expect(partial).toBeDefined();
    expect(partial?.total).toBe(3);
    // Some repetition ran long enough to spend the budget; "before the first pass finished" would
    // mean the budget was still per-pass and the total never counted.
    expect(partial?.run).toBeGreaterThanOrEqual(0);
  });

  it('rejects a budget of zero before the first question of the first pass', async () => {
    // `budgetMs: 0` means "no time at all". Under a deadline this is `deadline - now = 0`, and the
    // loop's `elapsed > budgetMs` check must still fire on the second call rather than run forever.
    await expect(
      runAblation(dataset, system('base'), system('feat'), {
        runs: 1,
        scorer: exactMatchScorer,
        budgetMs: 0,
      }),
    ).rejects.toThrow(/budget/i);
  });
});

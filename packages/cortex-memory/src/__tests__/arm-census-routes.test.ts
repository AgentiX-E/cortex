/**
 * One question on each of the five routes, through the arm's own construction path.
 *
 * ## Why the previous test could not have found this
 *
 * `abstention-reasons.test.ts` calls `memory.answerAbstention(...)` on one instance and asserts the
 * tally. That is the right unit for "does the route count", and it is blind to the defect §13.244
 * records, because the defect is not in a route at all: it is in **which instance** the arm reads
 * after the run. `41773546221` published a census summing to 488 against 2,000 question-answers,
 * which is 122 per pass -- worker 0's share of 500 at four workers -- and every unit test in this
 * package passed while it did.
 *
 * So this file builds the product the way the CLI builds it: a `CortexMemory` over a stub reader, one
 * question per route, and the arm run twice -- once serial and once behind a three-worker pool. The
 * assertion is the one the audit makes: **the census sums to the number of answers the run produced**,
 * and the pooled total equals the serial total.
 *
 * ## Why the routes are enumerated here rather than in the arm's tests
 *
 * `cortex-eval` cannot construct `CortexMemory` (the dependency runs the other way), so the only place
 * a real instance meets a real pool is this package. The eval-side tests use a counting double, which
 * proves the fold; this one proves the fold is over the object that actually tallies.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import {
  createAblationPool,
  exactMatchScorer,
  runCortexMemoryArm,
  DEFAULT_RELEVANCE_TOP_K,
  type BenchmarkDataset,
  type MemoryArmConfig,
  type MemorySystem,
} from '@agentix-e/cortex-eval';

import { CortexMemory } from '../memory.js';

const NOW = 1_759_470_000_000;

const CONFIG: MemoryArmConfig = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
};

/** A reader that answers every prompt, so no route declines for a reason of its own. */
function reader(): LLM {
  return {
    complete: async () => 'Berlin',
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function memory(): CortexMemory {
  return new CortexMemory({
    llm: reader(),
    now: NOW,
    name: 'cortex-memory',
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
  });
}

/** One question per route: `IE` (flat), `MR`, `TR`, `ABS`, `KU`. */
function fiveRoutes(): BenchmarkDataset {
  const turn = 'user: I moved to Berlin in 2023.';
  return {
    name: 'fixture',
    questions: [
      {
        id: 'ie',
        capability: 'IE',
        question: 'Where do I live?',
        expected: 'Berlin',
        context: [turn],
      },
      {
        id: 'mr',
        capability: 'MR',
        question: 'Where do I live now?',
        expected: 'Berlin',
        context: [turn],
        sessions: [[turn]],
      },
      {
        id: 'tr',
        capability: 'TR',
        question: 'Where did I move two years ago?',
        expected: 'Berlin',
        context: [turn],
        questionDate: '2025/07/10',
      },
      {
        id: 'abs',
        capability: 'ABS',
        question: 'What is my passport number?',
        expected: null,
        context: [turn],
      },
      {
        id: 'ku',
        capability: 'KU',
        questionType: 'knowledge-update',
        question: 'Where do I live as of now?',
        expected: 'Berlin',
        context: [turn],
      },
    ],
  };
}

const ROUTES = 5;

describe('the arm census covers every route it answered', () => {
  it('sums to one outcome per question on the serial path', async () => {
    const result = await runCortexMemoryArm(
      fiveRoutes(),
      { name: 'reference-pipeline', answer: () => 'Berlin' } as MemorySystem,
      memory(),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...CONFIG },
      },
    );

    const census = result.abstentionReasons;
    expect(census).toBeDefined();
    expect(
      (census?.empty ?? 0) +
        (census?.threshold ?? 0) +
        (census?.llm ?? 0) +
        (census?.answered ?? 0),
    ).toBe(ROUTES);
  });

  it('sums to the same total behind a three-worker pool', async () => {
    // The defect in one assertion. At three workers each instance answers roughly a third of the
    // questions, so a census read off one instance reports `1` or `2` here instead of `5` -- and
    // scales to `122` against `500` on a real run, which is the number that reached an artifact.
    const first = memory();
    const pool = createAblationPool({
      workers: 3,
      first: {
        baseline: { name: 'reference-pipeline', answer: () => 'Berlin' } as MemorySystem,
        feature: first,
      },
      baselineFor: () => ({ name: 'reference-pipeline', answer: () => 'Berlin' }) as MemorySystem,
      featureFor: () => memory(),
    });

    const result = await runCortexMemoryArm(
      fiveRoutes(),
      { name: 'reference-pipeline', answer: () => 'Berlin' } as MemorySystem,
      first,
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...CONFIG },
        pool,
      },
    );

    const census = result.abstentionReasons;
    expect(census).toBeDefined();
    expect(
      (census?.empty ?? 0) +
        (census?.threshold ?? 0) +
        (census?.llm ?? 0) +
        (census?.answered ?? 0),
    ).toBe(ROUTES * 2);
  });
});

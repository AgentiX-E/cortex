/**
 * What the write gate did over a whole run, read from the product rather than from a harness.
 *
 * ## Why this is not `admission-census.test.ts`
 *
 * That file pins the instrument: one call, hand-computed arithmetic, the cap, the empty case.
 * This file pins the thing the instrument is *for* — the claim "the threshold cut something"
 * stated about an instance that has answered several questions, on both of the paths
 * `CortexMemory` admits on.
 *
 * ## The two paths, and why the second one is the one that matters
 *
 * `#admit` admits a flat context directly and admits sessions session-by-session. The
 * session path keeps only the admitted turns of each session and drops the sessions that
 * came back empty — so a census folded from `admitSessions`' **return value** would be blind
 * to exactly the refusals the abstention route produces most of, and would report a gate
 * that never cut anything. The sink is threaded through the calls instead, and
 * `the session path counts what it refused` is the assertion that keeps it there.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const CORPUS = [
  'the bicycle was repaired on tuesday',
  'a parcel arrived for the neighbour',
  'the invoice was paid late again',
  'rain cancelled the football match',
];

const SESSIONS = [CORPUS.slice(0, 2), CORPUS.slice(2)];

/** Answer with a constant, so nothing about the reader can move the census. */
function reader(): LLM {
  return {
    complete: () => Promise.resolve('42'),
    completeStructured: () => Promise.reject(new Error('unused by this package')),
  };
}

function system(overrides: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({
    now: NOW,
    llm: reader(),
    gate: {
      // The identity configuration: everything is admitted, so the gate cannot have decided
      // anything. This is the state whose census must read as a non-experiment.
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: Number.POSITIVE_INFINITY,
      valueFunction: ((_memory) => 1) as ValueFunction,
    },
    ...overrides,
  });
}

/** A gate that does cut: half the corpus is worth nothing to it. */
function cuttingGate() {
  return {
    threshold: 0.5,
    retrievalThreshold: 0,
    sessionBudget: Number.POSITIVE_INFINITY,
    sourceTrust: 1,
    confidenceFor: (content: string) =>
      content.includes('invoice') || content.includes('rain') ? 0 : 1,
  };
}

describe('CortexMemory reports what its write gate did', () => {
  it('reports the identity configuration as adding nothing', async () => {
    // `threshold: 0` with a value function bounded below by 0 is a pass-through: `value >= 0`
    // holds for every turn. `rejected: 0` is the artifact saying so, which is what stops a
    // run from attributing an accuracy delta to a gate that never operated.
    const instance = system();
    await instance.answer('when was the bicycle repaired?', [...CORPUS]);

    expect(instance.admissionCensus()).toEqual({
      threshold: 0,
      candidates: 4,
      admitted: 4,
      rejected: 0,
      min: 1,
      max: 1,
      mean: 1,
      distinct: 1,
      distinctSaturated: false,
    });
  });

  it('reports a gate that cut, with the count and the spread it cut between', async () => {
    const instance = system({ gate: cuttingGate() });
    await instance.answer('when was the bicycle repaired?', [...CORPUS]);

    const census = instance.admissionCensus();
    expect(census.candidates).toBe(4);
    expect(census.admitted).toBe(2);
    expect(census.rejected).toBe(2);
    expect(census.distinct).toBe(2);
    expect(census.min).toBe(0);
    expect(census.max).toBe(1);
    expect(census.threshold).toBe(0.5);
  });

  it('accumulates rather than reporting the last question', async () => {
    // The defect this closes is one layer down from `indexCost`: a per-call census is
    // overwritten by the next call, so a report read after a run prices one question and
    // calls it all of them.
    const instance = system({ gate: cuttingGate() });
    await instance.answer('when was the bicycle repaired?', [...CORPUS]);
    await instance.answer('did the parcel arrive?', [...CORPUS]);
    await instance.answer('why was the invoice late?', [...CORPUS]);

    const census = instance.admissionCensus();
    expect(census.candidates).toBe(12);
    expect(census.admitted).toBe(6);
    expect(census.rejected).toBe(6);
    // Two values, seen on every question, so saturation is not reachable and the count is
    // exact rather than a floor.
    expect(census.distinct).toBe(2);
    expect(census.distinctSaturated).toBe(false);
  });

  it('counts what the session path refused, which is where the refusals are', async () => {
    // `admitSessions` keeps only the admitted turns and drops empty sessions, so the sink
    // has to be threaded rather than derived. Without it this reads `rejected: 0` and the
    // abstention route — the one that declines most — prices its own gate at nothing.
    const instance = system({ gate: cuttingGate() });
    await instance.answerSessions('when was the bicycle repaired?', SESSIONS);

    const census = instance.admissionCensus();
    expect(census.candidates).toBe(4);
    expect(census.rejected).toBe(2);
    expect(census.admitted).toBe(2);
  });

  it('reports an empty run as empty, not as a saturated minimum', async () => {
    // A product that has answered nothing has cut nothing. The census must say `candidates:
    // 0` rather than a minimum of zero that reads like a measurement.
    const instance = system();
    expect(instance.admissionCensus().candidates).toBe(0);
    expect(instance.admissionCensus().distinct).toBe(0);
  });
});

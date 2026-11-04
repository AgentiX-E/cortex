/**
 * Capturing a system's raw model output needs a hook *inside* the answer loop.
 *
 * ## Why the roster could not be built from the artifact alone
 *
 * Section 57 wired the answers through to the per-question roster and dispatch
 * `37792539133` carried them for the first time. The read that dispatch existed
 * for still came back empty: 115 of 120 records read `null`, because `Answer` is
 * `string | null` and `parseAnswer` collapses three distinct declines -- the
 * bare token, a labelled token, and an explanation followed by the token -- into
 * one value. The third of those says what the model thought and is the whole
 * point of the read.
 *
 * `CortexMemory.lastRawOutput()` now retains that text, one slot. A slot cannot
 * serve a roster, because the roster is assembled after every question has been
 * answered and by then the slot holds only the last question's reply. So the
 * text has to be collected *per question*, at the moment it exists.
 *
 * ## Why this is a hook on `runBenchmark` and not a field on `MemorySystem`
 *
 * `MemorySystem` is the injection contract: `{ name, answer }` plus optional
 * routing members, and `memory-system-conformance.test.ts` requires that a bare
 * object receives every question. Adding a raw-output member would make every
 * system -- including the reference pipeline and the test doubles -- responsible
 * for a field only a value-gated system can fill.
 *
 * It is also not a return-type change. `runBenchmark` returns `Answer[]` and ten
 * call sites in `benchmark.test.ts` alone depend on that. An optional trailing
 * hook leaves all of them untouched, and the hook's absence is the shipped
 * behaviour rather than a degraded one.
 *
 * ## Why a callback and not reading the system afterwards
 *
 * Reading `lastRawOutput()` after a 500-question run returns the five-hundredth
 * question's text. Attributing it to all five hundred is the exact defect the
 * control in `raw-output-retention.test.ts` guards against one layer down. The
 * capture point has to be where the answer is produced, which is this loop.
 */

import { describe, expect, it } from 'vitest';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';
import { runBenchmark } from '../benchmark.js';

/** A dataset of `count` questions, all on the flat route. */
function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'capture-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      expected: `answer-${i}`,
      capability: 'IE' as const,
      context: [`evidence ${i}`],
    })),
  };
}

/** An `Answer`-only system, which is the contract's minimum. */
function plainSystem(answers: Answer[]): MemorySystem {
  let cursor = 0;
  return {
    name: 'plain',
    answer: async () => answers[cursor++]!,
  };
}

/** A system that also exposes the optional raw-output capability. */
function rawSystem(answers: Answer[], raw: (string | null)[]): MemorySystem {
  let cursor = 0;
  let last: string | null = null;
  return {
    name: 'raw',
    answer: async () => {
      last = raw[cursor]!;
      return answers[cursor++]!;
    },
    lastRawOutput: () => last,
  } as MemorySystem & { lastRawOutput: () => string | null };
}

describe('runBenchmark captures the raw output per question, not once per run', () => {
  it('reports one raw value per question, in question order', async () => {
    const captured: (string | null)[] = [];
    const system = rawSystem(['a', 'b', 'c'], ['raw-a', 'raw-b', 'raw-c']);
    await runBenchmark(datasetOf(3), system, undefined, 0, (text) => captured.push(text));
    expect(captured).toEqual(['raw-a', 'raw-b', 'raw-c']);
  });

  it('captures the value belonging to each question rather than the last one seen', async () => {
    // The defect this exists to prevent: three questions, three different
    // replies, and a collector that reports the third three times because it
    // read a single slot after the loop finished.
    const captured: (string | null)[] = [];
    const system = rawSystem(['a', 'b', 'c'], ['first', 'second', 'third']);
    await runBenchmark(datasetOf(3), system, undefined, 0, (text) => captured.push(text));
    expect(captured[0]).toBe('first');
    expect(captured[2]).toBe('third');
    expect(new Set(captured).size).toBe(3);
  });

  it('reports null for a question whose system exposes no raw output', async () => {
    // A machine-derived abstention never calls the model, so there is nothing to
    // report. `null` says that; an empty string would be a blank answer.
    const captured: (string | null)[] = [];
    const system = plainSystem([null, null]);
    await runBenchmark(datasetOf(2), system, undefined, 0, (text) => captured.push(text));
    expect(captured).toEqual([null, null]);
  });

  it('keeps a decline’s explanation intact, which is the text the read needs', async () => {
    const explained = ['The evidence does not name a city.', 'INSUFFICIENT_EVIDENCE'].join('\n');
    const captured: (string | null)[] = [];
    await runBenchmark(datasetOf(1), rawSystem([null], [explained]), undefined, 0, (text) =>
      captured.push(text),
    );
    expect(captured[0]).toBe(explained);
  });

  it('omitting the hook changes nothing about the answers', async () => {
    // The hook is optional and its absence is the shipped behaviour. Without it
    // the run must be byte-identical to one that never had the capability.
    const system = rawSystem(['a', 'b'], ['raw-a', 'raw-b']);
    expect(await runBenchmark(datasetOf(2), system)).toEqual(['a', 'b']);
  });

  it('does not swallow a throwing accessor, because a broken read must not pass as absent', async () => {
    // `abstentionReasonsOf` treats a throwing accessor as an absent capability,
    // and that is right there: the endpoint is already measured and discarding a
    // census beats discarding the arm. Here the opposite is true. The capture is
    // the measurement, so a failure has to surface rather than be filed as "this
    // system has no raw output", which is indistinguishable from a normal
    // machine-derived abstention.
    const system = {
      name: 'throws',
      answer: async () => null,
      lastRawOutput: () => {
        throw new Error('accessor exploded');
      },
    } as unknown as MemorySystem;
    await expect(runBenchmark(datasetOf(1), system, undefined, 0, () => {})).rejects.toThrow(
      'accessor exploded',
    );
  });

  it('leaves the answers array aligned with the raw array when a system returns a mix', async () => {
    // The roster pairs `answer` and raw text by index. An off-by-one here would
    // attribute one question's wording to another's answer, which is worse than
    // recording nothing.
    const captured: (string | null)[] = [];
    const system = rawSystem(['Lisbon', null, '3'], ['Lisbon', 'INSUFFICIENT_EVIDENCE', '3']);
    const answers = await runBenchmark(datasetOf(3), system, undefined, 0, (text) =>
      captured.push(text),
    );
    expect(answers).toEqual(['Lisbon', null, '3']);
    expect(captured.length).toBe(answers.length);
    expect(captured[1]).toBe('INSUFFICIENT_EVIDENCE');
    expect(answers[1]).toBeNull();
  });
});

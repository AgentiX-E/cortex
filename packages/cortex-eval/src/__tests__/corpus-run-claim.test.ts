/**
 * A corpus's windows must be answered by **one** store, in order.
 *
 * ## The defect this file is written against
 *
 * `runBenchmark` claims questions from a shared counter: `next++`, one index per claim, and
 * whichever worker is free takes it. That is the right shape for an independent population -- it is
 * why the pool is not a pre-sliced array, and the comment above the counter says so -- and it is the
 * wrong shape for a population whose questions are **windows of one corpus**. Two windows claimed by
 * two workers are answered against two `CortexMemory` instances, so the second window reads a store
 * that never absorbed the first one's update: the treatment is administered, reaches nothing, and
 * `semanticCarry.matched` reads `0`. That zero is indistinguishable from "the layer carried nothing",
 * which is the one ambiguity `S13` exists to remove.
 *
 * So `Question.corpus` states a contract -- contiguous, one instance, ascending -- and `claimRun`
 * takes a whole run of equal `corpus` values atomically. This suite is the executable form of it.
 *
 * ## Why the fixture delays answers
 *
 * A system that answered instantly would let the counter hand out adjacent indices in order and the
 * defect would not appear. The fixture sleeps for a duration that depends on the question, so the
 * completion order differs from the claim order and workers overlap the way they do on a real pass.
 */
import { describe, expect, it } from 'vitest';

import { runBenchmark, type BenchmarkWorkerPool } from '../benchmark.js';
import { withWindows } from '../two-window.js';
import type { Answer, BenchmarkDataset, MemorySystem, Question } from '../types.js';

/** A question whose expected answer is its own id, so an answer names its question. */
function corpusQuestion(id: string): Question {
  return {
    id,
    capability: 'KU',
    questionType: 'knowledge-update',
    question: `question ${id}`,
    expected: id,
    context: ['a turn'],
    sessions: [['a turn']],
  };
}

function corpora(size: number): BenchmarkDataset {
  return {
    name: 'two-window',
    questions: Array.from({ length: size }, (_, i) => corpusQuestion(`q${String(i)}`)),
  };
}

/**
 * The two-window population, with the window named in the question **text**.
 *
 * The real population does not do this: a window is the same question over the same corpus, so the
 * ids differ and the text does not. But a `MemorySystem` is handed the text and never the id, which
 * is precisely why the corpus contract has to live in the dataset rather than in the system -- and
 * why this fixture, whose only channel is the text, spells the window out. The contract under test
 * (`corpus` and `id`) is the one `withWindows` set; only the text is decorated.
 */
function windowed(size: number): BenchmarkDataset {
  const built = withWindows(corpora(size), 2);
  return {
    name: built.name,
    questions: built.questions.map((question) => ({
      ...question,
      question: `question ${question.id}`,
    })),
  };
}

type Recorder = {
  readonly pool: BenchmarkWorkerPool;
  /** Which instance answered each question id, in the order it answered them. */
  readonly byQuestion: Map<string, string>;
  /** The per-instance answer stream, so order within a corpus is checkable. */
  readonly streams: Map<string, string[]>;
};

/**
 * A pool whose instances each record what they answered.
 *
 * The sleep is what makes the claim order and the completion order differ: `delay` derives from the
 * question's own id, so the pass interleaves the way a real one does without a random source.
 */
function recordingPool(workers: number): Recorder {
  const byQuestion = new Map<string, string>();
  const streams = new Map<string, string[]>();
  const systemFor = (worker: number): MemorySystem => {
    const name = `w${String(worker)}`;
    const stream: string[] = [];
    streams.set(name, stream);
    return {
      name,
      answer: async (text: string): Promise<Answer> => {
        const id = text.replace('question ', '');
        const delay = [...id].reduce((total, char) => total + char.codePointAt(0)!, 0) % 3;
        await new Promise((resolve) => setTimeout(resolve, delay));
        byQuestion.set(id, name);
        stream.push(id);
        return id;
      },
    };
  };
  return {
    pool: { workers, systemFor },
    byQuestion,
    streams,
  };
}

/**
 * The pooled pass, with every argument after the capture callbacks spelled out.
 *
 * `budgetMs` sits between the callbacks and the pool, and omitting it puts the pool in **its** slot
 * -- a serial pass wearing a concurrent pass's arguments. That is not hypothetical: the first
 * version of this suite omitted it and passed against a `claimRun` mutated to claim one index at a
 * time, because no worker but the first ever ran.
 */
async function runPooled(dataset: BenchmarkDataset, recorder: Recorder): Promise<Answer[]> {
  return runBenchmark(
    dataset,
    recorder.pool.systemFor(0),
    undefined,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    recorder.pool,
  );
}

/** The serial pass: no pool at all, which is what every archived artifact was produced by. */
async function runSerial(dataset: BenchmarkDataset, recorder: Recorder): Promise<Answer[]> {
  return runBenchmark(dataset, recorder.pool.systemFor(0));
}

describe('the corpus contract in the claim loop', () => {
  it('keeps every corpus on one instance, at any width', async () => {
    const dataset = windowed(12);
    const recorder = recordingPool(4);

    await runPooled(dataset, recorder);

    // The property, stated as a property rather than as a distribution: for every corpus, the
    // instances that answered its windows are one.
    const instancesByCorpus = new Map<string, Set<string>>();
    for (const question of dataset.questions) {
      const instance = recorder.byQuestion.get(question.id);
      expect(instance).toBeDefined();
      const seen = instancesByCorpus.get(question.corpus!) ?? new Set<string>();
      seen.add(instance!);
      instancesByCorpus.set(question.corpus!, seen);
    }
    expect([...instancesByCorpus.values()].filter((seen) => seen.size > 1)).toEqual([]);
    expect(instancesByCorpus.size).toBe(12);
  });

  it('answers a corpus’s windows in ascending order on that instance', async () => {
    const dataset = windowed(12);
    const recorder = recordingPool(4);

    await runPooled(dataset, recorder);

    // Order is half the contract: a window is later than the one before it, and a store that
    // absorbed `#w2` before it answered `#w1` would be answering a question nobody asked. Read off
    // each instance's own stream, because that is the sequence the store actually saw.
    for (const [instance, stream] of recorder.streams) {
      for (let at = 0; at + 1 < stream.length; at += 1) {
        const [before, after] = [stream[at]!, stream[at + 1]!];
        if (before.split('#w')[0] !== after.split('#w')[0]) continue;
        expect(Number(before.slice(before.lastIndexOf('#w') + 2))).toBeLessThan(
          Number(after.slice(after.lastIndexOf('#w') + 2)),
        );
        expect(instance).toBe(recorder.byQuestion.get(before));
      }
    }
  });

  it('still writes every answer at its own index', async () => {
    // The claim now takes a run rather than an index, and the answers vector is index-addressed --
    // so the alignment between the two is the thing a batching change can break silently. A pass
    // that recorded a run's answers into consecutive slots would publish a correct number of
    // answers, in the wrong places, and every aggregate downstream would still agree with itself.
    const dataset = windowed(12);
    const recorder = recordingPool(3);

    const answers = await runPooled(dataset, recorder);

    // The fixture answers with the id it was asked about, so the answer vector is a statement about
    // which question each slot received: `answers[i] === questions[i].id` is exactly the alignment.
    expect(answers).toEqual(dataset.questions.map((question) => question.id));
  });

  it('claims one question at a time when the population names no corpus', async () => {
    // Every archived artifact was produced by a population with no `corpus`, so the run must be the
    // one it always was: twelve indices, twelve claims, no ordering guarantee beyond the counter.
    // Asserted through the serial pass, which is the strongest available statement -- one worker
    // answers all twelve, in index order, and the batching path is not on the route at all.
    const dataset = corpora(12);
    const recorder = recordingPool(1);

    const answers = await runSerial(dataset, recorder);

    expect(answers).toEqual(dataset.questions.map((question) => question.id));
    expect(recorder.streams.get('w0')).toEqual(dataset.questions.map((question) => question.id));
  });
});

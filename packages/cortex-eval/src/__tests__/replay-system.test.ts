/**
 * Replaying a recorded answer list through the scorer.
 *
 * The property that matters is not "the answers come back" -- that is a `Map` -- but that a
 * **misaligned** recording cannot produce a number. Run `41625442265` left two complete repetitions
 * of both arms in a partial artifact and no report; replaying them is the only way to read that
 * measurement without buying a second one, and a replay tool that silently shifted by one question
 * would publish a plausible accuracy for a pass nobody made.
 *
 * So four refusals are pinned beside the happy path, and the last two tests drive a real
 * `runAblationReport` to show the module composes with the scoring path rather than with a stand-in
 * for it.
 */
import { describe, expect, it } from 'vitest';
import { readCompletedPasses, replaySystem } from '../replay-system.js';
import { runAblationReport } from '../report.js';
import { exactMatchScorer } from '../metrics.js';
import type { Answer, BenchmarkDataset } from '../types.js';

const dataset: BenchmarkDataset = {
  name: 'replay-fixture',
  questions: [
    { id: 'q-1', capability: 'IE', question: 'Where was the meeting?', expected: 'Lisbon', context: [] },
    { id: 'q-2', capability: 'MR', question: 'How many trips?', expected: '3', context: [] },
    { id: 'q-3', capability: 'ABS', question: 'When was the launch?', expected: null, context: [] },
  ],
};

describe('replaySystem', () => {
  it('answers each question with the recording made for it', async () => {
    const replay = replaySystem('baseline', dataset, ['Lisbon', '3', null]);
    expect(replay.name).toBe('baseline');
    expect(await replay.answer('How many trips?', [])).toBe('3');
    // A decline is a value, not a missing one: `null` must survive the round trip or the
    // abstention census would read a replay as a system that answered everything.
    expect(await replay.answer('When was the launch?', [])).toBeNull();
  });

  it('is a function of the question, so a second repetition replays the same answer', async () => {
    const replay = replaySystem('feature', dataset, ['Lisbon', '3', null]);
    const first = await replay.answer('Where was the meeting?', []);
    const second = await replay.answer('Where was the meeting?', []);
    expect(first).toBe('Lisbon');
    expect(second).toBe(first);
  });

  it('refuses a recording whose length is not the dataset length', () => {
    expect(() => replaySystem('short', dataset, ['Lisbon', '3'])).toThrow(/has 2 answers for 3/);
    expect(() => replaySystem('long', dataset, ['Lisbon', '3', null, 'extra'])).toThrow(
      /has 4 answers for 3/,
    );
  });

  it('refuses a dataset whose question text is not unique', () => {
    const duplicated: BenchmarkDataset = {
      name: 'duplicated',
      questions: [
        { id: 'a', capability: 'IE', question: 'Same text', expected: 'x', context: [] },
        { id: 'b', capability: 'IE', question: 'Same text', expected: 'y', context: [] },
      ],
    };
    expect(() => replaySystem('dup', duplicated, ['x', 'y'])).toThrow(/"b": its text is shared/);
  });

  it('refuses a question it has no recording for, and quotes it', () => {
    const replay = replaySystem('baseline', dataset, ['Lisbon', '3', null]);
    expect(() => replay.answer('A question from another file', [])).toThrow(
      /no answer for: "A question from another file"/,
    );
  });
});

describe('readCompletedPasses', () => {
  const pass = { run: 0, baselineAnswers: ['Lisbon', '3', null], featureAnswers: ['Lisbon', '3', null] };

  it('returns the repetitions the record holds, in its order', () => {
    const passes = readCompletedPasses({ completed: [pass, { ...pass, run: 1 }] });
    expect(passes.map((p) => p.run)).toEqual([0, 1]);
    expect(passes[0]!.baselineAnswers).toEqual(['Lisbon', '3', null]);
  });

  it('refuses a record with no completed array at all', () => {
    expect(() => readCompletedPasses({ reached: 142 })).toThrow(/no `completed` array/);
    expect(() => readCompletedPasses('nope')).toThrow(/must be an object/);
  });

  it('refuses a record that completed no pass', () => {
    // The distinction the field exists to make: "nothing was measured" must not be readable as
    // "zero percent".
    expect(() => readCompletedPasses({ completed: [] })).toThrow(/completed no pass/);
  });

  it('refuses an entry that cannot name its repetition or its two sides', () => {
    expect(() => readCompletedPasses({ completed: [{ ...pass, run: 'zero' }] })).toThrow(
      /run must be an integer/,
    );
    expect(() =>
      readCompletedPasses({ completed: [{ run: 0, baselineAnswers: ['a'] }] }),
    ).toThrow(/must carry both/);
  });

  it('refuses two entries claiming the same repetition', () => {
    expect(() => readCompletedPasses({ completed: [pass, pass] })).toThrow(/names run 0 twice/);
  });
});

describe('a recording read back through the report path', () => {
  it('reports zero delta and p = 1 when both sides are the same recording', async () => {
    const answers: Answer[] = ['Lisbon', '3', null];
    const report = await runAblationReport(
      dataset,
      replaySystem('baseline', dataset, answers),
      replaySystem('feature', dataset, answers),
      { runs: 1, scorer: exactMatchScorer },
    );
    expect(report.baseline.metrics.correct).toBe(3);
    expect(report.feature.metrics.correct).toBe(3);
    expect(report.ablation.delta).toBe(0);
    expect(report.ablation.mcnemarPValue).toBe(1);
    expect(report.ablation.discordant).toEqual({
      baselineCorrectFeatureIncorrect: 0,
      baselineIncorrectFeatureCorrect: 0,
    });
  });

  it('names the questions that changed verdict, on the side each moved', async () => {
    const report = await runAblationReport(
      dataset,
      replaySystem('baseline', dataset, ['Lisbon', 'wrong', null]),
      replaySystem('feature', dataset, ['wrong', '3', null]),
      { runs: 1, scorer: exactMatchScorer },
    );
    expect(report.ablation.discordant).toEqual({
      baselineCorrectFeatureIncorrect: 1,
      baselineIncorrectFeatureCorrect: 1,
    });
    expect(report.ablation.discordantQuestions.baselineCorrectFeatureIncorrect).toEqual(['q-1']);
    expect(report.ablation.discordantQuestions.baselineIncorrectFeatureCorrect).toEqual(['q-2']);
  });
});

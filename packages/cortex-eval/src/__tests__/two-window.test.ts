import { describe, expect, it } from 'vitest';

import { readWindowCount, withWindows, WINDOW_MARKER } from '../two-window.js';
import type { BenchmarkDataset, Question } from '../types.js';

/**
 * Two corpora, the second annotated the way `loadLongMemEval` annotates one, so the transform can
 * be shown to preserve every field a graded run reads rather than only the turns.
 */
function dataset(): BenchmarkDataset {
  const question = (id: string, extra: Partial<Question> = {}): Question => ({
    id,
    capability: 'KU',
    questionType: 'knowledge-update',
    question: `question ${id}`,
    expected: 'a',
    context: ['turn one', 'turn two'],
    sessions: [['turn one'], ['turn two']],
    questionDate: '2024/03/01',
    goldTurns: ['turn one'],
    ...extra,
  });
  return { name: 'fixture', questions: [question('q1'), question('q2')] };
}

describe('readWindowCount', () => {
  it('treats unset, blank and one as the registered population', () => {
    // Three spellings, one state, and the state is not a special case: it is the population every
    // archived artifact was produced on, so the reader has to answer it without a value.
    expect(readWindowCount(undefined)).toBe(1);
    expect(readWindowCount('')).toBe(1);
    expect(readWindowCount('   ')).toBe(1);
    expect(readWindowCount('1')).toBe(1);
  });

  it('reads two, which is the population S13 names', () => {
    expect(readWindowCount('2')).toBe(2);
  });

  it('reads the widest value it will honour', () => {
    // The boundary is asserted from both sides: this test and the next are one fact.
    expect(readWindowCount('8')).toBe(8);
  });

  it('refuses a width that would multiply the bill without a use for it', () => {
    // A typo guard rather than a cost guard: `20` is a keypressed zero far more often than it is an
    // intent, and the failure it prevents is a run that outruns its own budget while looking normal.
    expect(() => readWindowCount('9')).toThrow(/multiplies the population by 9/);
  });

  it('refuses a value that is not a whole number rather than rounding it', () => {
    // `2 ` with a trailing space trims; `two`, `2.5` and `-2` do not survive. Each is refused with
    // the same message, because the repair is the same: write a number.
    expect(() => readWindowCount('two')).toThrow(/positive whole number/);
    expect(() => readWindowCount('2.5')).toThrow(/positive whole number/);
    expect(() => readWindowCount('-2')).toThrow(/positive whole number/);
  });

  it('refuses zero with its own message, because its repair is different', () => {
    // `0` is a number and would pass a range test written as "not negative". It grades nothing, and
    // the run would publish `null` over an empty denominator -- a failed dispatch reported as a
    // failed arm. So it is refused where it is read rather than three layers down.
    expect(() => readWindowCount('0')).toThrow(/would grade no window at all/);
  });
});

describe('withWindows', () => {
  it('returns its argument for one window, because that is the archived population', () => {
    // `toBe`, not `toEqual`: an unfiltered run must be the same object it always was, and a copy
    // with the same contents would still be a second code path through the dataset.
    const one = dataset();
    expect(withWindows(one, 1)).toBe(one);
  });

  it('asks every corpus once per window, in corpus-major order', () => {
    // The order is the contract, not a detail: `claimRun` claims a contiguous run of equal `corpus`
    // values atomically, so a population that interleaved two corpora would leave each window
    // claimed alone and answered by whichever instance asked for it next.
    const two = withWindows(dataset(), 2);
    expect(two.questions.map((question) => question.id)).toEqual([
      'q1#w1',
      'q1#w2',
      'q2#w1',
      'q2#w2',
    ]);
    expect(two.questions.map((question) => question.corpus)).toEqual(['q1', 'q1', 'q2', 'q2']);
    expect(two.name).toBe('fixture');
  });

  it('carries every field a graded run reads', () => {
    // A window is the same question in the same corpus: the turns, the gold, the date and the gold
    // annotation all have to survive, or the second window would be graded against a different
    // question than the first.
    const [first] = withWindows(dataset(), 2).questions;
    expect(first).toMatchObject({
      capability: 'KU',
      questionType: 'knowledge-update',
      question: 'question q1',
      expected: 'a',
      context: ['turn one', 'turn two'],
      sessions: [['turn one'], ['turn two']],
      questionDate: '2024/03/01',
      goldTurns: ['turn one'],
    });
  });

  it('names the window in the id, so a reader can pair the rows it grades', () => {
    // The format is pinned here rather than in prose: the evidence script splits on this marker, and
    // an artifact whose ids do not carry it is a population no analysis can pair.
    const ids = withWindows(dataset(), 2).questions.map((question) => question.id);
    expect(ids.every((id) => id.includes(WINDOW_MARKER))).toBe(true);
    expect(WINDOW_MARKER).toBe('#w');
  });

  it('multiplies: n corpora become n x windows questions', () => {
    expect(withWindows(dataset(), 3).questions).toHaveLength(6);
  });

  it('refuses a population it has already been applied to', () => {
    // Two meanings in one field, and a graded id of `q1#w1#w1`. The transform is a run-level
    // selector that runs once; a second application is a caller that composed it with itself.
    expect(() => withWindows(withWindows(dataset(), 2), 2)).toThrow(/already carries corpus/);
  });

  it('refuses an empty dataset, because the multiplication of nothing is nothing', () => {
    expect(() => withWindows({ name: 'empty', questions: [] }, 2)).toThrow(/the dataset is empty/);
  });

  it('refuses a window count no reader produced', () => {
    // The reader is the only sanctioned source, and this is the branch that says so: a caller that
    // reached the transform with zero or a fraction bypassed `readWindowCount`.
    expect(() => withWindows(dataset(), 0)).toThrow(/not a positive integer/);
    expect(() => withWindows(dataset(), 1.5)).toThrow(/not a positive integer/);
  });
});

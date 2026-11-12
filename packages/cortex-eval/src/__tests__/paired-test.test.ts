/**
 * The paired test, checked against the arithmetic a reviewer would do by hand.
 *
 * Every expected value below is computable without running the code: with `b` questions improving and `c`
 * regressing, the two-tailed exact McNemar p is `2 * sum_{i<=min(b,c)} C(b+c,i) / 2^(b+c)`. Writing the numbers
 * out rather than comparing against a library is deliberate — a test that asks a statistics package for the
 * answer cannot tell whether this implementation is the thing being checked or the thing checking it.
 */

import { describe, expect, it } from 'vitest';
import { compareArmsInRun, compareRecords, compareRuns, mcnemarExact } from '../paired-test.js';
import type { ProviderScore, QuestionRecord } from '../harness.js';

describe('mcnemarExact', () => {
  it('returns 1 when nothing changed, because no discordant pair is no evidence', () => {
    // A zero here would report the absence of any change as maximal significance, which inverts the meaning.
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it('agrees with the hand-computed tail for five improvements and no regression', () => {
    // 2 * (1/2)^5 = 0.0625.
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 12);
  });

  it('is symmetric in its two arguments', () => {
    for (const [improved, regressed] of [
      [3, 0],
      [7, 2],
      [10, 1],
      [4, 4],
    ] as const) {
      expect(mcnemarExact(improved, regressed)).toBe(mcnemarExact(regressed, improved));
    }
  });

  it('crosses 0.05 between four and six one-way changes', () => {
    // The threshold the whole exercise turns on: 4/0 is 0.125 and 6/0 is 0.03125, so "four questions moved" is
    // not a result and "six questions moved" is.
    expect(mcnemarExact(4, 0)).toBeCloseTo(0.125, 12);
    expect(mcnemarExact(4, 0)).toBeGreaterThan(0.05);
    expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 12);
    expect(mcnemarExact(6, 0)).toBeLessThan(0.05);
  });

  it('never exceeds 1 when both directions are common', () => {
    // 2 * sum_{0..5} C(10,i)/1024 = 1.246, which is not a probability.
    expect(mcnemarExact(5, 5)).toBe(1);
    expect(mcnemarExact(30, 30)).toBe(1);
  });

  it('reports a net improvement and a net regression with the same p', () => {
    expect(mcnemarExact(9, 1)).toBeCloseTo(mcnemarExact(1, 9), 12);
  });
});

function record(
  id: string,
  correct: boolean,
  overrides: Partial<QuestionRecord> = {},
): QuestionRecord {
  return {
    id,
    capability: 'TR',
    found: true,
    foundAll: true,
    read: true,
    correct,
    ...overrides,
  };
}

describe('compareRecords', () => {
  it('counts each of the four cells', () => {
    const before = [
      record('a', false), // improved
      record('b', false), // improved
      record('c', true), // regressed
      record('d', true), // both correct
      record('e', false), // both wrong
    ];
    const after = [
      record('a', true),
      record('b', true),
      record('c', false),
      record('d', true),
      record('e', false),
    ];
    const result = compareRecords(
      { provider: 'arm', records: before },
      { provider: 'arm', records: after },
    );
    expect(result.improved).toBe(2);
    expect(result.regressed).toBe(1);
    expect(result.bothCorrect).toBe(1);
    expect(result.bothWrong).toBe(1);
    expect(result.n).toBe(5);
    expect(result.delta).toBeCloseTo(0.2, 12);
    expect(result.p).toBe(1);
  });

  it('excludes a question that only one run contains, and says how many', () => {
    // A subset that shrank between runs is a fact about the runs; averaging it away would hide that the two
    // denominators are not the same.
    const result = compareRecords(
      { provider: 'arm', records: [record('a', true), record('b', false)] },
      { provider: 'arm', records: [record('a', true)] },
    );
    expect(result.n).toBe(1);
    expect(result.unmatched).toBe(1);
  });

  it('reports a delta of zero for an empty intersection rather than dividing by zero', () => {
    const result = compareRecords(
      { provider: 'arm', records: [record('a', true)] },
      { provider: 'arm', records: [] },
    );
    expect(result.n).toBe(0);
    expect(result.delta).toBe(0);
    expect(result.p).toBe(1);
  });

  it('refuses to pair two different providers', () => {
    // Two arms also differ in their question set, so a per-question pairing would compare two experiments.
    expect(() =>
      compareRecords({ provider: 'a', records: [] }, { provider: 'b', records: [] }),
    ).toThrow(/one provider on both sides/);
  });

  it('reaches significance on the 100-question reading this repository actually ran', () => {
    // TR went 11/20 -> 15/20: four improved, none regressed. The test says that is not a difference, which is the
    // sentence the prose had to argue for before this function existed.
    const before = Array.from({ length: 20 }, (_, i) => record(`q${i}`, i < 11 ? true : false));
    const after = Array.from({ length: 20 }, (_, i) => record(`q${i}`, i < 15 ? true : false));
    const result = compareRecords(
      { provider: 'lexical-reference', records: before },
      { provider: 'lexical-reference', records: after },
    );
    expect(result.improved).toBe(4);
    expect(result.regressed).toBe(0);
    expect(result.delta).toBeCloseTo(0.2, 12);
    expect(result.p).toBeCloseTo(0.125, 12);
    expect(result.p).toBeGreaterThan(0.05);
  });
});

describe('compareRuns', () => {
  function score(provider: string, records: readonly QuestionRecord[]): ProviderScore {
    return {
      provider,
      build: 'none',
      questions: records.length,
      measured: records.length,
      unmeasurable: 0,
      found: records.filter((r) => r.found).length,
      foundAll: 0,
      empty: 0,
      recallAtK: 0,
      recallAllAtK: 0,
      mrr: 0,
      sessions: 0,
      turns: 0,
      meanContextChars: 0,
      correct: null,
      read: 0,
      accuracy: null,
      abstained: 0,
      skipped: [],
      byCapability: {},
      ingestSkipped: 0,
      records,
    };
  }

  it('pairs only the providers present in both runs', () => {
    const baseline = [
      score('arm', [record('a', false)]),
      score('only-before', [record('a', true)]),
    ];
    const treatment = [score('arm', [record('a', true)]), score('only-after', [record('a', true)])];
    const results = compareRuns(baseline, treatment);
    expect(results.map((r) => r.provider)).toEqual(['arm']);
  });

  it('skips an arm that was not read in either run', () => {
    // Two columns of `false` would report perfect stability as though it had been measured.
    const unread = [record('a', false, { read: false })];
    expect(compareRuns([score('arm', unread)], [score('arm', unread)])).toEqual([]);
  });
});

describe('compareArmsInRun', () => {
  function arm(provider: string, records: readonly QuestionRecord[]): ProviderScore {
    return {
      provider,
      build: 'none',
      questions: records.length,
      measured: records.length,
      unmeasurable: 0,
      found: records.filter((r) => r.found).length,
      foundAll: 0,
      empty: 0,
      recallAtK: 0,
      recallAllAtK: 0,
      mrr: 0,
      sessions: 0,
      turns: 0,
      meanContextChars: 0,
      correct: null,
      read: records.filter((r) => r.read).length,
      accuracy: null,
      abstained: 0,
      skipped: [],
      byCapability: {},
      ingestSkipped: 0,
      records,
    };
  }

  it('counts the four cells for two arms that answered the same questions', () => {
    // The 100-question reading: `cortex-session` 65/100 against `mem0` 59/100, and the question is whether the
    // six-question gap is a difference or a draw. Every arm in one harness run answers the same sampled list, so
    // the pairing is established by the file rather than by matching provider names.
    const run = [
      arm('cortex-session', [
        record('a', true), // both correct
        record('b', true), // regressed: mem0 got it, we did not
        record('c', false), // improved: we did not, mem0 did
        record('d', false), // both wrong
      ]),
      arm('mem0', [record('a', true), record('b', false), record('c', true), record('d', false)]),
    ];
    const result = compareArmsInRun(run, 'cortex-session', 'mem0');
    expect(result.improved).toBe(1);
    expect(result.regressed).toBe(1);
    expect(result.bothCorrect).toBe(1);
    expect(result.bothWrong).toBe(1);
    expect(result.n).toBe(4);
    expect(result.delta).toBe(0);
    expect(result.p).toBe(1);
  });

  it('labels the pair in the direction the counts are read', () => {
    // `improved` means "right under the treatment, wrong under the baseline", so the label has to name both arms
    // and the arrow has to point the same way the delta does. A bare provider name here would make `delta > 0`
    // mean "the other arm is better", which is the misreading this label exists to prevent.
    const run = [arm('ours', [record('a', false)]), arm('theirs', [record('a', true)])];
    expect(compareArmsInRun(run, 'ours', 'theirs').provider).toBe('ours->theirs');
    expect(compareArmsInRun(run, 'ours', 'theirs').delta).toBeGreaterThan(0);
    expect(compareArmsInRun(run, 'theirs', 'ours').delta).toBeLessThan(0);
  });

  it('refuses a self-pair, which has no direction and no p-value to report', () => {
    // Comparing an arm with itself yields delta 0 and p 1 by construction. Printed, that reads as "measured, no
    // difference" -- a statement about the system, when it is a statement about the call.
    const run = [arm('ours', [record('a', true)])];
    expect(() => compareArmsInRun(run, 'ours', 'ours')).toThrow(/two different arms/);
  });

  it('names the arm that is not in the run instead of skipping the pair', () => {
    const run = [arm('ours', [record('a', true)])];
    expect(() => compareArmsInRun(run, 'ours', 'mem0')).toThrow(/'mem0' is not in this run/);
    expect(() => compareArmsInRun(run, 'mem0', 'ours')).toThrow(/'mem0' is not in this run/);
  });

  it('refuses an arm that was not read, because the caller named this pair', () => {
    // `compareRuns` may skip an unread arm: it is sweeping whatever the two runs happen to share. Here the pair
    // was asked for by name, and a silent empty result would be read as "no difference".
    const run = [
      arm('ours', [record('a', true)]),
      arm('retrieval-only', [record('a', false, { read: false })]),
    ];
    expect(() => compareArmsInRun(run, 'ours', 'retrieval-only')).toThrow(/was not read/);
  });

  it('refuses two arms over different question sets, which in one run is a harness fault', () => {
    // Across runs a shrinking subset is a fact about the runs and `unmatched` reports it. Within one run every arm
    // answers the same list, so a different list means the harness lost a record; reporting it through `unmatched`
    // would file a defect as a property of the systems being compared.
    const run = [
      arm('ours', [record('a', true), record('b', true)]),
      arm('theirs', [record('a', true)]),
    ];
    expect(() => compareArmsInRun(run, 'ours', 'theirs')).toThrow(/2 and 1 questions/);
  });
});

describe('compareArmsInRun on a run with no arms', () => {
  it('says the run measured nothing rather than listing an empty set', () => {
    // A run whose `scores[]` is empty is a dispatch that failed before retrieval. The message has to say that,
    // because "is not in this run. The run measured ." reads as a truncation rather than as emptiness.
    expect(() => compareArmsInRun([], 'ours', 'mem0')).toThrow(/measured nothing/);
  });
});

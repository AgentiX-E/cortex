/**
 * Tests for the retrieval recall curve (roadmap measure B2).
 *
 * The existing diagnostics report recall@1 and recall@5. That pair cannot answer
 * the question that decides B2 — how much recall is still on the table at 10,
 * 20, 50 — and without that number the candidate-pool width is a guess. This
 * module measures the curve.
 *
 * The distinction the tests pin most carefully is between the two ceilings:
 *
 *   - `retrievalCeilingAt(k)` — the best any reranker could do if it saw a pool
 *     of width k, because the evidence turn is somewhere in that pool.
 *   - `recallAt(k)` — what the bi-encoder's own top-k ordering already achieves.
 *
 * The gap between them is exactly the value B1 reranking can unlock, and the
 * point where `recallAt` saturates is exactly the pool width B2 should stop at.
 * Conflating the two would make the reranker look useless (its own input already
 * contains the answer, so "recall@k is high" is not its contribution).
 */

import { describe, expect, it } from 'vitest';

import {
  buildRecallCurve,
  DEFAULT_CURVE_CUTOFFS,
  computeRecallCurve,
  rankOfFirstAnswer,
  type RecallCurvePoint,
} from '../recall-curve.js';

describe('buildRecallCurve', () => {
  it('reports recall at each requested cutoff', () => {
    const curve = buildRecallCurve(
      [
        { rankOfFirstAnswer: 0 },
        { rankOfFirstAnswer: 2 },
        { rankOfFirstAnswer: 9 },
        { rankOfFirstAnswer: null },
      ],
      [1, 5, 10],
    );

    expect(curve.map((p) => p.k)).toEqual([1, 5, 10]);
  });

  it('counts a question as recalled when its answer rank is below the cutoff', () => {
    const curve = buildRecallCurve(
      [{ rankOfFirstAnswer: 0 }, { rankOfFirstAnswer: 4 }, { rankOfFirstAnswer: 5 }],
      [5],
    );

    // Ranks 0 and 4 are inside top-5; rank 5 is the sixth hit and is not.
    expect(curve[0]!.recalled).toBe(2);
    expect(curve[0]!.recall).toBeCloseTo(2 / 3, 10);
  });

  it('treats an unfound answer as a miss at every cutoff', () => {
    const curve = buildRecallCurve([{ rankOfFirstAnswer: null }], [1, 10, 100]);

    for (const point of curve) {
      expect(point.recalled).toBe(0);
      expect(point.recall).toBe(0);
    }
  });

  it('reports zero rather than NaN when there are no questions', () => {
    const curve = buildRecallCurve([], [1, 5]);

    expect(curve.every((p) => p.recall === 0 && p.recalled === 0)).toBe(true);
  });

  it('reports the pool ceiling as recall at the widest pool seen', () => {
    // The ceiling is a property of the pool, not of a cutoff: it answers "if a
    // reranker could reorder the pool perfectly, what is the most it could get".
    const curve = buildRecallCurve([{ rankOfFirstAnswer: 30 }, { rankOfFirstAnswer: 2 }], [1, 5], {
      poolWidth: 50,
    });

    for (const point of curve) {
      expect(point.ceiling).toBeCloseTo(1, 10);
    }
  });

  it('excludes answers outside the pool from the ceiling', () => {
    // A turn the retrieval never fetched cannot be promoted by any reranker, so
    // it must not inflate the ceiling.
    const curve = buildRecallCurve([{ rankOfFirstAnswer: 3 }, { rankOfFirstAnswer: 80 }], [5], {
      poolWidth: 50,
    });

    expect(curve[0]!.ceiling).toBeCloseTo(0.5, 10);
  });

  it('reports the potential gain as ceiling minus achieved recall', () => {
    // One of two answers is inside top-1; both are inside the pool.
    const curve = buildRecallCurve([{ rankOfFirstAnswer: 0 }, { rankOfFirstAnswer: 1 }], [1], {
      poolWidth: 10,
    });

    expect(curve[0]!.recall).toBeCloseTo(0.5, 10);
    expect(curve[0]!.ceiling).toBeCloseTo(1, 10);
    expect(curve[0]!.gain).toBeCloseTo(0.5, 10);
  });

  it('reports zero gain when the ordering is already perfect', () => {
    const curve = buildRecallCurve([{ rankOfFirstAnswer: 0 }, { rankOfFirstAnswer: 0 }], [1, 5], {
      poolWidth: 10,
    });

    for (const point of curve) {
      expect(point.gain).toBeCloseTo(0, 10);
    }
  });

  it('uses the widest cutoff as the pool width when none is given', () => {
    const curve = buildRecallCurve([{ rankOfFirstAnswer: 7 }], [1, 10]);

    // Unspecified pool defaults to the widest cutoff, so the ceiling is
    // computed at 10 rather than assumed infinite.
    expect(curve[0]!.ceiling).toBeCloseTo(1, 10);
  });

  it('never reports a gain below zero, even if the pool excludes an answer', () => {
    // Defensive: with poolWidth narrower than a cutoff, achieved recall at that
    // cutoff can exceed the ceiling. A negative gain would read as "reranking
    // is harmful" when the truthful statement is "the pool is too narrow".
    const curve = buildRecallCurve(
      [{ rankOfFirstAnswer: 0 }, { rankOfFirstAnswer: 0 }, { rankOfFirstAnswer: 0 }],
      [10],
      { poolWidth: 1 },
    );

    expect(curve[0]!.gain).toBeGreaterThanOrEqual(0);
  });

  it('sorts and de-duplicates the requested cutoffs', () => {
    const curve = buildRecallCurve([{ rankOfFirstAnswer: 0 }], [10, 1, 10, 5]);

    expect(curve.map((p) => p.k)).toEqual([1, 5, 10]);
  });

  it('ignores non-positive cutoffs', () => {
    const curve = buildRecallCurve([{ rankOfFirstAnswer: 0 }], [0, -3, 1]);

    expect(curve.map((p) => p.k)).toEqual([1]);
  });

  it('identifies the smallest cutoff at which a reranker has nothing left to add', () => {
    // The actionable output for B2. `gain === 0` means the bi-encoder's own
    // ordering already surfaces everything the pool holds, so a reranker cannot
    // help; only a WIDER pool that brings in a new answer turn can.
    //
    // Worked through, with poolWidth 100 so all three ranks are in the pool:
    //   ranks 2, 4, 60  ->  ceiling = 3/3 = 1
    //   k=1   recall 0    gain 1     (nothing admitted yet)
    //   k=5   recall 2/3  gain 1/3   (ranks 2 and 4 admitted)
    //   k=100 recall 3/3  gain 0     (the ordering has caught up with the pool)
    const curve = buildRecallCurve(
      [{ rankOfFirstAnswer: 2 }, { rankOfFirstAnswer: 4 }, { rankOfFirstAnswer: 60 }],
      [1, 5, 10, 100],
      { poolWidth: 100 },
    );

    expect(curve[0]!.gain).toBeCloseTo(1, 10);
    expect(curve[1]!.gain).toBeCloseTo(1 / 3, 10);
    // Gain is flat across 5 and 10: rank 60 sits past both, so widening from 5
    // to 10 buys nothing. That flatness is the signal that 10 is not the width
    // worth paying for here.
    expect(curve[2]!.gain).toBeCloseTo(1 / 3, 10);
    expect(curve[3]!.gain).toBeCloseTo(0, 10);
    expect(saturationK(curve)).toBe(100);
  });

  it('reports a distinct ceiling that does not vary with the cutoff', () => {
    // The ceiling is a property of the POOL, not of a cutoff: it is the recall
    // a perfect reranker could reach by reordering alone. A ceiling that moved
    // with k would make `gain` meaningless, because the reranker does not get
    // to choose its own cutoff.
    const curve = buildRecallCurve(
      [{ rankOfFirstAnswer: 50 }, { rankOfFirstAnswer: 0 }],
      [1, 10, 100],
      { poolWidth: 100 },
    );

    expect(curve.map((p) => p.ceiling)).toEqual([1, 1, 1]);
    // But achieved recall climbs, so the gain shrinks as the cutoff widens.
    expect(curve[0]!.recall).toBeCloseTo(0.5, 10);
    expect(curve[2]!.recall).toBeCloseTo(1, 10);
  });

  it('returns null for saturation when nothing is recallable', () => {
    const curve = buildRecallCurve([{ rankOfFirstAnswer: null }], [1, 10]);

    expect(saturationK(curve)).toBeNull();
  });
});

/**
 * The smallest cutoff at which the reranker's remaining gain reaches zero, or
 * null when there is no such point. Derived here rather than in the module so
 * the test states the intended meaning independently of the implementation.
 */
function saturationK(curve: readonly RecallCurvePoint[]): number | null {
  const point = curve.find((p) => p.gain === 0 && p.ceiling > 0);
  return point?.k ?? null;
}

describe('rankOfFirstAnswer', () => {
  it('returns the zero-based rank of the first answer hit', () => {
    const hits = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    const answers = new Set(['c']);

    expect(rankOfFirstAnswer(hits, answers)).toBe(2);
  });

  it('returns zero when the top hit is an answer', () => {
    expect(rankOfFirstAnswer([{ text: 'a' }, { text: 'b' }], new Set(['a']))).toBe(0);
  });

  it('returns null when no hit is an answer', () => {
    expect(rankOfFirstAnswer([{ text: 'a' }, { text: 'b' }], new Set(['z']))).toBeNull();
  });

  it('returns null for an empty hit list', () => {
    expect(rankOfFirstAnswer([], new Set(['a']))).toBeNull();
  });

  it('returns null when the answer set is empty, rather than matching everything', () => {
    // An abstention question has no evidence turn. Returning 0 here would score
    // it as a perfect retrieval and inflate every cutoff.
    expect(rankOfFirstAnswer([{ text: 'a' }], new Set())).toBeNull();
  });
});

describe('computeRecallCurve', () => {
  const embedding = (dimensions: Record<string, number[]>) => ({
    dimension: () => 3,
    embed: async (texts: string[]) =>
      texts.map((t) => {
        const v = dimensions[t] ?? [0, 0, 1];
        const n = Math.hypot(...v) || 1;
        return new Float64Array(v.map((x) => x / n));
      }),
  });

  function instance(question: string, turns: { text: string; answer?: boolean }[]) {
    return {
      question,
      question_date: '2024-01-01',
      haystack_sessions: [
        turns.map((t) => ({
          role: 'user',
          content: t.text,
          ...(t.answer === true ? { has_answer: true } : {}),
        })),
      ],
      haystack_dates: ['2024-01-01'],
      answer: 'x',
      question_type: 'single-session-user',
    };
  }

  it('measures the curve over answerable questions only', async () => {
    const inst = instance('Where did I put the keys?', [
      { text: 'unrelated turn', answer: false },
      { text: 'the keys are in the drawer', answer: true },
    ]);
    const curve = await computeRecallCurve([inst as never], embedding({}), {
      cutoffs: [1, 5],
      poolWidth: 5,
    });

    expect(curve.map((p) => p.k)).toEqual([1, 5]);
    // The answer turn is in a pool of 5, so it is recallable at every cutoff.
    expect(curve[0]!.ceiling).toBeGreaterThan(0);
  });

  it('skips questions with no answer turn so they cannot inflate the curve', async () => {
    const abstention = instance('What did I say about nothing?', [
      { text: 'a turn with no evidence flag' },
    ]);
    const curve = await computeRecallCurve([abstention as never], embedding({}), {
      cutoffs: [1, 5],
    });

    for (const point of curve) {
      expect(point.recall).toBe(0);
      expect(point.ceiling).toBe(0);
      expect(point.gain).toBe(0);
    }
  });

  it('returns an empty curve for an empty dataset', async () => {
    const curve = await computeRecallCurve([], embedding({}), {
      cutoffs: [1, 5],
    });

    expect(curve).toHaveLength(2);
    expect(curve.every((p) => p.recall === 0)).toBe(true);
  });

  it('accepts an embedding-only options object without an llm', async () => {
    const inst = instance('q', [{ text: 'answer here', answer: true }]);
    const curve = await computeRecallCurve([inst as never], embedding({}), {
      cutoffs: [5],
      poolWidth: 5,
    });

    expect(curve).toHaveLength(1);
  });

  it('returns an empty curve when every cutoff is invalid', () => {
    // Guards the early return: a caller passing only zeros or fractions gets no
    // points rather than a curve anchored on a nonsensical k.
    expect(buildRecallCurve([{ rankOfFirstAnswer: 0 }], [0, -1])).toEqual([]);
    expect(buildRecallCurve([{ rankOfFirstAnswer: 0 }], [])).toEqual([]);
  });

  it('excludes assistant turns from the candidate pool, as the graded path does', async () => {
    // An assistant turn is never a retrieval candidate on the graded path
    // (retrieveTurns filters to user turns before searching). Measuring the
    // curve over a pool that included them would report a ceiling for a
    // retrieval the pipeline does not perform.
    const inst = {
      question: 'q',
      question_date: '2024-01-01',
      haystack_sessions: [
        [
          { role: 'assistant', content: 'assistant reply' },
          { role: 'user', content: 'the real evidence', has_answer: true },
        ],
      ],
      haystack_dates: ['2024-01-01'],
      answer: 'x',
      question_type: 'single-session-user',
    };
    const curve = await computeRecallCurve([inst as never], embedding({}), {
      cutoffs: [1, 5],
      poolWidth: 5,
    });

    // The answer turn is the only candidate, so it is recalled at every cutoff.
    expect(curve[0]!.ceiling).toBe(1);
  });

  it('skips a question whose only turns are assistant turns', async () => {
    const inst = {
      question: 'q',
      question_date: '2024-01-01',
      haystack_sessions: [[{ role: 'assistant', content: 'reply', has_answer: true }]],
      haystack_dates: ['2024-01-01'],
      answer: 'x',
      question_type: 'single-session-user',
    };
    const curve = await computeRecallCurve([inst as never], embedding({}), {
      cutoffs: [1],
      poolWidth: 1,
    });

    // The pool is empty after filtering, so the question contributes nothing.
    expect(curve[0]!.ceiling).toBe(0);
  });

  it('falls back to the default cutoffs and pool width when none are given', async () => {
    // Both defaults are load-bearing: the default cutoffs define the curve a
    // caller gets for free, and the default pool width must equal the widest
    // cutoff or the ceiling would describe a pool nobody fetched.
    const inst = {
      question: 'q',
      question_date: '2024-01-01',
      haystack_sessions: [[{ role: 'user', content: 'evidence', has_answer: true }]],
      haystack_dates: ['2024-01-01'],
      answer: 'x',
      question_type: 'single-session-user',
    };
    const curve = await computeRecallCurve([inst as never], embedding({}));

    expect(curve.map((p) => p.k)).toEqual([...DEFAULT_CURVE_CUTOFFS]);
    // The single candidate is inside every cutoff, so ceiling is 1 throughout.
    expect(curve.every((p) => p.ceiling === 1)).toBe(true);
  });

  it('handles a haystack with no dates array', async () => {
    // `haystack_dates` is optional in the loader type. A dataset without dates
    // must still measure rather than throw, because the dates only annotate the
    // turn text -- they do not change which turn is the answer.
    const inst = {
      question: 'q',
      question_date: '2024-01-01',
      haystack_sessions: [[{ role: 'user', content: 'evidence', has_answer: true }]],
      answer: 'x',
      question_type: 'single-session-user',
    };
    const curve = await computeRecallCurve([inst as never], embedding({}), {
      cutoffs: [1],
      poolWidth: 1,
    });

    expect(curve[0]!.ceiling).toBe(1);
  });
});

/**
 * The criteria table, and the rule that turns a number into a verdict.
 *
 * Half of this file tests the rule; the other half tests the **table**. A criterion set is code, and it can be
 * wrong in ways no single criterion notices: two rows sharing an id, a threshold that contradicts its unit, a
 * gate nobody can satisfy because the source is missing. Those are checked here, because a gate that silently
 * stops being evaluated is worse than no gate — it reads as green.
 */

import { describe, expect, it } from 'vitest';
import {
  CRITERIA,
  describe as describeSource,
  unrun,
  verdictOf,
  type Criterion,
} from '../acceptance.js';

function criterionOf(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'X1',
    capability: 'test',
    metric: 'a metric',
    dataset: 'a fixture',
    comparator: 'at-least',
    threshold: 0.5,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'unrun', reason: 'not run' },
    onMiss: 'do not ship',
    ...overrides,
  };
}

describe('verdictOf: three comparators and one absence', () => {
  it('passes when a lower bound is met and fails when it is missed', () => {
    expect(verdictOf(criterionOf({ threshold: 0.5 }), 0.5).status).toBe('pass');
    expect(verdictOf(criterionOf({ threshold: 0.5 }), 0.49).status).toBe('fail');
  });

  it('passes when an upper bound is respected and fails when it is exceeded', () => {
    const upper = criterionOf({ comparator: 'at-most', threshold: 0.2 });
    expect(verdictOf(upper, 0.2).status).toBe('pass');
    expect(verdictOf(upper, 0.21).status).toBe('fail');
  });

  it('requires exactness for a count that must be zero', () => {
    const none = criterionOf({ comparator: 'equals', threshold: 0, unit: 'count' });
    expect(verdictOf(none, 0).status).toBe('pass');
    expect(verdictOf(none, 1).status).toBe('fail');
  });

  it('reports an absent number as unrun rather than as a pass', () => {
    const evaluation = verdictOf(criterionOf(), null);
    expect(evaluation.status).toBe('unrun');
    expect(evaluation.current).toBeNull();
    expect(evaluation.blocking).toBe(false);
  });

  it('lets a zero be a measurement, which is not the same as an absence', () => {
    const evaluation = verdictOf(criterionOf({ comparator: 'equals', threshold: 0 }), 0);
    expect(evaluation.status).toBe('pass');
  });
});

describe('blocking: a gate that broke stops a build, an aim that is unmet does not', () => {
  it('blocks on a broken gate', () => {
    expect(verdictOf(criterionOf({ kind: 'gate' }), 0.1).blocking).toBe(true);
  });

  it('does not block on an unmet aim', () => {
    expect(verdictOf(criterionOf({ kind: 'aim' }), 0.1).blocking).toBe(false);
  });

  it('does not block on an accepted miss, which is a decision rather than a defect', () => {
    expect(verdictOf(criterionOf({ kind: 'gate', accepted: true }), 0.1).blocking).toBe(false);
  });

  it('never blocks on an unrun row, whatever the kind', () => {
    expect(verdictOf(criterionOf({ kind: 'gate' }), null).blocking).toBe(false);
  });

  it('does not block when the gate is met', () => {
    expect(verdictOf(criterionOf({ kind: 'gate' }), 0.9).blocking).toBe(false);
  });
});

describe('describe: every source can be named, because an unrun row has to say why', () => {
  it('names each kind of source', () => {
    expect(describeSource({ kind: 'arm', arm: 'gated' })).toBe('arm:gated');
    expect(describeSource({ kind: 'gap' })).toBe('gap:gated-flat');
    expect(describeSource({ kind: 'leak' })).toBe('leak:served-not-current');
    expect(describeSource({ kind: 'ablation', removed: 'persistence' })).toBe(
      'ablation:-persistence',
    );
    expect(describeSource({ kind: 'probe', reading: 'block-saving' })).toBe('probe:block-saving');
    expect(describeSource({ kind: 'artifact', path: 'a/b.json', key: 'c.d' })).toBe('a/b.json#c.d');
    expect(describeSource({ kind: 'unrun', reason: 'later' })).toBe('unrun');
  });
});

describe('the table is well formed', () => {
  it('has a unique id per row', () => {
    const ids = CRITERIA.map((criterion) => criterion.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every row a rule for what to do when it is missed', () => {
    // The revert rule is the part that makes a threshold binding. A row without one is a wish and would pass
    // review by looking like the others.
    for (const criterion of CRITERIA) {
      expect(criterion.onMiss.length, criterion.id).toBeGreaterThan(20);
    }
  });

  it('keeps the threshold inside the range its unit implies', () => {
    for (const criterion of CRITERIA) {
      if (criterion.unit === 'ratio') {
        expect(criterion.threshold, criterion.id).toBeGreaterThanOrEqual(0);
        expect(criterion.threshold, criterion.id).toBeLessThanOrEqual(1);
      }
      if (criterion.unit === 'points') {
        expect(Math.abs(criterion.threshold), criterion.id).toBeLessThanOrEqual(1);
      }
    }
  });

  it('marks a gate as something already reached, so a fail is a regression', () => {
    // Not a tautology: a row can be switched from `gate` to `aim` to silence it, and this asserts the switch
    // has not been used on the rows that are green today.
    const green = CRITERIA.filter((criterion) => criterion.kind === 'gate');
    expect(green.length).toBeGreaterThan(5);
  });

  it('gives the benchmark rows a competitor figure with a grade', () => {
    const benchmark = CRITERIA.find((criterion) => criterion.id === 'S1');
    expect(benchmark?.competitors?.length).toBeGreaterThan(3);
    for (const peer of benchmark?.competitors ?? []) {
      expect(['A', 'B', 'C']).toContain(peer.grade);
      // A grade without a recipe is an opinion. The recipe is what lets a reader dispute the grade.
      expect(peer.recipe.length).toBeGreaterThan(20);
    }
  });

  it('records at least one grade-C figure, and does not use it as a target', () => {
    // The point of the grade is that vendor numbers exist and may not be quoted as a gap. If every competitor
    // were grade A, this test would be vacuous rather than protective.
    const graded = CRITERIA.flatMap((criterion) => criterion.competitors ?? []);
    expect(graded.some((peer) => peer.grade === 'C')).toBe(true);
    expect(graded.some((peer) => peer.grade === 'A')).toBe(true);
  });

  it('lists the rows without a value rather than leaving them to be discovered', () => {
    const missing = unrun();
    for (const criterion of missing) {
      expect(criterion.source.kind).toBe('unrun');
    }
    expect(missing.length).toBeLessThan(CRITERIA.length);
  });

  it('keeps a row for every mechanism this repository shipped, including the null results', () => {
    // A null result with no row is a null result that gets quietly re-litigated every few months.
    const ids = new Set(CRITERIA.map((criterion) => criterion.id));
    for (const id of ['K1', 'K2', 'T1', 'T2', 'T3', 'T4', 'G1', 'G2']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(CRITERIA.find((criterion) => criterion.id === 'R1')?.accepted).toBe(true);
  });
});

describe('the reranking rows, written before the run that fills them', () => {
  const s6 = CRITERIA.find((criterion) => criterion.id === 'S6');
  const s7 = CRITERIA.find((criterion) => criterion.id === 'S7');

  it('gates the instrument and aims at the paired gain, which are two different numbers', () => {
    // The instrument row is a gate because a discarded reply is not a small effect — it is an unreadable
    // run. The gain row is an aim because the number does not exist yet. Collapsing the two into one row
    // would make either the gate block on an unmeasured aim or the aim inherit a threshold of zero.
    expect(s6?.kind).toBe('gate');
    expect(s6?.comparator).toBe('at-most');
    expect(s6?.threshold).toBe(0);
    expect(s6?.unit).toBe('count');
    expect(s7?.kind).toBe('aim');
    expect(s7?.comparator).toBe('at-least');
    expect(s7?.threshold).toBe(3);
    expect(s7?.unit).toBe('count');
  });

  it('reads both rows out of one artifact, so a run cannot fill one and not the other', () => {
    const first = s6?.source;
    const second = s7?.source;
    expect(first?.kind).toBe('artifact');
    expect(second?.kind).toBe('artifact');
    if (first?.kind !== 'artifact' || second?.kind !== 'artifact') return;
    expect(first.path).toBe(second.path);
    expect(first.key).not.toBe(second.key);
  });

  it('points at a file rather than at the word unrun, so the row starts reporting when the run lands', () => {
    // `{ kind: 'unrun' }` is a row that can never become live without an edit, and an edit is exactly the
    // moment somebody re-derives the threshold. An artifact path that does not exist yet resolves to `unrun`
    // today and to a number tomorrow, with no change to this file.
    for (const criterion of [s6, s7]) {
      expect(criterion?.source.kind, criterion?.id).toBe('artifact');
    }
  });

  it('says a discarded reply is an assembly failure rather than a null result', () => {
    // The whole reason the census exists: `rerankHits` degrades to the retrieved order, so an endpoint
    // answering 401 five hundred times and a cross-encoder that agreed every time produce the same accuracy.
    expect(s6?.onMiss).toContain('assembly failure');
    expect(s6?.onMiss).toContain('401');
    expect(s7?.onMiss).toContain('delete the stage');
  });

  it('grades the only published price of this stage as C, because it is another corpus', () => {
    const peer = s7?.competitors?.[0];
    expect(peer?.grade).toBe('C');
    expect(peer?.recipe).toContain('3.92');
    // The grade is doing work: a C figure may motivate the increment and may price the mechanism, and it may
    // not become the threshold. The threshold is 3 questions on our own 121, not 3.92 points on theirs.
    expect(peer?.value).not.toBe(s7?.threshold);
  });
});

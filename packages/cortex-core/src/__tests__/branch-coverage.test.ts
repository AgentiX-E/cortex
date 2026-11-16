import { describe, it, expect } from 'vitest';
import { consolidate } from '../consolidation/consolidate.js';
import { resolveContradiction } from '../contradiction/resolve.js';
import { MemoryGraph } from '../graph/memory-graph.js';
import { sinkhorn } from '../math/ot.js';
import { currentValue } from '../temporal/bitemporal.js';
import { createMemory } from '../domain/memory.js';
import type { Fact } from '../domain/fact.js';

describe('branch coverage', () => {
  it('consolidate handles undefined coactiveWith', () => {
    const mem = new Map<string, ReturnType<typeof createMemory>>();
    const a = createMemory({ content: 'a' });
    mem.set(a.id, a);
    const g = new MemoryGraph();
    const stats = consolidate(mem, g, [{ memoryId: a.id, outcome: 'success', at: Date.now() }], {
      now: Date.now(),
    });
    expect(stats.strengthened).toBe(1);
  });

  it('resolveContradiction breaks ties by most recent validFrom', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'p',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 0.5,
      confidence: 0.5,
      ...over,
    });
    const facts = [
      mk({ id: 'older', object: 'x', validFrom: 100 }),
      mk({ id: 'newer', object: 'x', validFrom: 200 }),
      mk({ id: 'worse', object: 'y', confidence: 0.1 }),
    ];
    const r = resolveContradiction(facts);
    expect(r.winner.id).toBe('newer');
  });

  it('resolveContradiction keeps the earlier fact when a tie breaks the other way', () => {
    // The temporal tie-break has THREE outcomes and the reduce only ever saw two
    // of them. `sb > sa` returns `b`, `sb === sa && b.validFrom > a.validFrom`
    // returns `b`, and everything else falls through to `return a`. A corpus that
    // only ever presents an ascending pair exercises the first two, so the
    // fall-through was never taken and `resolve.ts` measured 91.30% branches.
    //
    // This case is the fall-through, reached by the path a caller actually
    // produces: two equally-trusted facts where the reduce visits the NEWER one
    // first. `validFrom` is then compared as `b.validFrom > a.validFrom` with `b`
    // being the older fact, which is false, so the accumulated `a` survives.
    //
    // The array order is deliberate and is the whole point. Writing the pair in
    // ascending order would take the `validFrom >` branch again and leave the gap
    // open while looking like a new test.
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'p',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 0.5,
      confidence: 0.5,
      ...over,
    });
    const facts = [
      mk({ id: 'newer', object: 'x', validFrom: 200 }),
      mk({ id: 'older', object: 'x', validFrom: 100 }),
      mk({ id: 'worse', object: 'y', confidence: 0.1 }),
    ];
    const r = resolveContradiction(facts);
    expect(r.winner.id).toBe('newer');
  });

  it('resolveContradiction keeps the accumulator on an exact tie', () => {
    // BOTH tie-break conditions false, which is the arm the corpus never reached.
    //
    // The comparison is `sb === sa && b.validFrom > a.validFrom`:
    //   - `sb === sa` is read FIRST and is at column 34; it was never true in any
    //     existing test, because every existing pair had unequal confidence or
    //     sourceTrust and short-circuited at the `sb > sa` test above.
    //   - `b.validFrom > a.validFrom` is at column 64 and is only evaluated once
    //     `sb === sa` holds.
    //
    // Both facts therefore carry IDENTICAL confidence, sourceTrust AND validFrom,
    // so the reduce returns the first element. That is the required behaviour
    // rather than a detail: `resolveContradiction` feeds reconstruction, and a
    // winner that depended on iteration accident would make a replay disagree
    // with itself.
    //
    // One object only. A second object, however weak, is what the previous draft
    // of this test added -- and because `bestBelief` starts at -1 the first
    // inserted object always wins the `belief > bestBelief` scan, so a decoy can
    // silently decide which group the reduce ever sees. Keeping a single object
    // removes that degree of freedom and makes the assertion about the reduce.
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'p',
      object: 'x',
      validFrom: 100,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 0.5,
      confidence: 0.5,
      ...over,
    });
    const facts = [mk({ id: 'first' }), mk({ id: 'second' })];
    const r = resolveContradiction(facts);
    expect(r.winner.id).toBe('first');
  });

  it('resolveContradiction picks the highest score within a group', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'p',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 1,
      confidence: 0.5,
      ...over,
    });
    const facts = [
      mk({ id: 'low', object: 'x', confidence: 0.2 }),
      mk({ id: 'high', object: 'x', confidence: 0.9 }),
      mk({ id: 'mid', object: 'x', confidence: 0.5 }),
    ];
    const r = resolveContradiction(facts);
    expect(r.winner.id).toBe('high');
  });

  it('currentValue skips non-current facts', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'job',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 1,
      confidence: 0.5,
      ...over,
    });
    const expired = mk({ id: 'old', object: 'engineer', validUntil: 50 });
    const current = mk({ id: 'now', object: 'manager', validFrom: 50 });
    const best = currentValue([expired, current], 'u', 'job', 100);
    expect(best?.id).toBe('now');
  });

  it('sinkhorn updates scaling on an asymmetric problem', () => {
    const res = sinkhorn(
      [0.9, 0.1],
      [0.1, 0.9],
      [
        [0, 1],
        [1, 0],
      ],
      0.5,
      50,
      1e-12,
    );
    expect(res.cost).toBeGreaterThan(0);
  });

  it('shortestPath returns null for a non-existent node', () => {
    const g = new MemoryGraph();
    g.ensureNode('a');
    expect(g.shortestPath('a', 'missing')).toBeNull();
    expect(g.shortestPath('missing', 'a')).toBeNull();
  });

  it('sinkhorn does not claim convergence it has not achieved', () => {
    // Regression test for a real bug: the convergence detector was inert.
    //
    // `uPrev` used to hold a *reference* to `u`, and `u` is mutated in place on
    // the next few lines. The loop therefore compared `u` against itself, so the
    // residual `maxDiff` was exactly 0 on every iteration for every input, and
    // `maxDiff < tol` was trivially true. The function reported
    // `converged: true` after a single iteration whether or not the marginals
    // had actually converged.
    //
    // The tell was `tol = 0`: with a genuinely computed residual that can never
    // be satisfied, yet the old code still returned `converged: true`. That is
    // asserted below because it fails loudly on the old implementation and is
    // the cheapest way to state "the residual is real".
    const impossible = sinkhorn(
      [0.5, 0.5],
      [0.5, 0.5],
      [
        [0, 1],
        [1, 0],
      ],
      0.5,
      1000,
      0,
    );
    expect(impossible.converged).toBe(false);
    expect(impossible.iterations).toBe(1000);

    // Symmetrically, an achievable tolerance must still converge — and it must
    // be reached by the iteration rather than being asserted up front.
    const reachable = sinkhorn(
      [0.5, 0.5],
      [0.5, 0.5],
      [
        [0, 1],
        [1, 0],
      ],
      1,
      500,
      1e-9,
    );
    expect(reachable.converged).toBe(true);
    expect(reachable.iterations).toBeGreaterThan(0);
    expect(reachable.iterations).toBeLessThan(500);
  });

  it('sinkhorn reports non-convergence when the iteration budget is exhausted', () => {
    // With the residual actually computed, a hard problem that cannot settle in
    // one step must exhaust the budget instead of exiting on the first pass.
    const res = sinkhorn(
      [0.5, 0.5],
      [0.3, 0.3, 0.4],
      [
        [0, 1, 2],
        [2, 1, 0],
      ],
      0.001,
      25,
      1e-12,
    );
    expect(res.converged).toBe(false);
    expect(res.iterations).toBe(25);
  });

  it('sinkhorn returns non-converged when maxIter is exhausted', () => {
    const res = sinkhorn(
      [0.5, 0.5],
      [0.5, 0.5],
      [
        [0, 1],
        [1, 0],
      ],
      0.01,
      1,
      0,
    );
    expect(res.converged).toBe(false);
  });

  it('sinkhorn survives an all-underflow kernel without producing NaN', () => {
    // Covers the `s === 0 ? 1 : a[i] / s` guard in the row update (ot.ts:66) and
    // its column twin (ot.ts:73).
    //
    // Reachability here is decided by floating-point underflow, not by algebra.
    // The kernel is K = exp(-C / epsilon), which is strictly positive in exact
    // arithmetic, so `s = sum_j K[i][j] * v[j]` cannot be zero on paper and the
    // guard looks unreachable. But `Math.exp` underflows to zero once its
    // argument drops below about -745.5 (measured, not assumed: `exp(-745)`
    // still returns the smallest denormal `5e-324`, while `exp(-745.5)` is
    // exactly 0). With `C / epsilon = 1000` every kernel entry collapses to 0,
    // every row sum is exactly 0, and the guard's true arm executes.
    //
    // Without the guard the update would evaluate `a[i] / 0` and write
    // `Infinity` into the scaling vector. That poisons the coupling with
    // `Infinity * 0` -> `NaN` and makes `cost` NaN, which is far worse than a
    // wrong number: a NaN Sinkhorn distance silently disables every comparison
    // built on top of it. The guard substitutes 1, keeping the arithmetic
    // finite. What it cannot do is recover the transport plan, and it does not
    // pretend to: the coupling must come back as all zeros rather than as
    // garbage.
    const res = sinkhorn(
      [0.5, 0.5],
      [0.5, 0.5],
      [
        [1000, 1000],
        [1000, 1000],
      ],
      1,
      3,
      0,
    );

    const entries: number[] = [];
    for (let i = 0; i < res.coupling.rows; i++) {
      for (let j = 0; j < res.coupling.columns; j++) {
        entries.push(res.coupling.get(i, j));
      }
    }

    expect(entries.every((e) => Number.isFinite(e))).toBe(true);
    expect(entries.every((e) => e === 0)).toBe(true);
    expect(Number.isFinite(res.cost)).toBe(true);
    expect(res.cost).toBe(0);
    // A kernel of zeros carries no information, so it cannot have converged --
    // and in particular must not report convergence just because both scaling
    // vectors sat still.
    expect(res.converged).toBe(false);
  });

  it('sinkhorn treats a zero cost matrix as a finite, well-defined coupling', () => {
    // POSITIVE CONTROL for the underflow case above, and the reason the guard
    // must be written as `s === 0` rather than as a near-zero tolerance.
    //
    // A zero cost matrix gives K = exp(0) = 1 everywhere, so every row sum is
    // exactly 2 and the guard does NOT fire. The marginals are satisfied after
    // one iteration at the uniform coupling 1/(m*n), and the transport cost is
    // exactly 0. This pins the difference between "zero kernel" (degenerate,
    // all-underflow, guard fires) and "flat kernel" (perfectly conditioned,
    // guard silent) -- two cases that both look like `C` is constant.
    const res = sinkhorn(
      [0.5, 0.5],
      [0.5, 0.5],
      [
        [0, 0],
        [0, 0],
      ],
      1000,
      1,
      0,
    );

    expect(res.coupling.get(0, 0)).toBeCloseTo(0.25, 12);
    expect(res.coupling.get(0, 1)).toBeCloseTo(0.25, 12);
    expect(res.coupling.get(1, 0)).toBeCloseTo(0.25, 12);
    expect(res.coupling.get(1, 1)).toBeCloseTo(0.25, 12);
    expect(res.cost).toBe(0);
    // `maxIter = 1` with `tol = 0`: the update ran once, so the residual has no
    // chance to be tested. Reporting non-convergence is the honest answer.
    expect(res.iterations).toBe(1);
    expect(res.converged).toBe(false);
  });

  it('currentValue replaces the best candidate by confidence', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'job',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 1,
      confidence: 0.5,
      ...over,
    });
    const low = mk({ id: 'low', object: 'engineer', confidence: 0.3 });
    const high = mk({ id: 'high', object: 'manager', confidence: 0.9 });
    const best = currentValue([low, high], 'u', 'job', 100);
    expect(best?.id).toBe('high');
  });
});

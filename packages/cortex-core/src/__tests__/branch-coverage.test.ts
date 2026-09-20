import { describe, it, expect } from 'vitest';
import { consolidate } from '../consolidation/consolidate.js';
import { resolveContradiction } from '../contradiction/resolve.js';
import { MemoryGraph } from '../graph/memory-graph.js';
import { sinkhorn } from '../math/ot.js';
import { studentTCdf, logGamma } from '../math/stats.js';
import { currentValue } from '../temporal/bitemporal.js';
import { createMemory } from '../domain/memory.js';
import type { Fact } from '../domain/fact.js';

describe('branch coverage', () => {
  it('consolidate handles undefined coactiveWith', () => {
    const mem = new Map<string, ReturnType<typeof createMemory>>();
    const a = createMemory({ content: 'a' });
    mem.set(a.id, a);
    const g = new MemoryGraph();
    const stats = consolidate(mem, g, [{ memoryId: a.id, outcome: 'success', at: Date.now() }]);
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

  it('logGamma reflection formula handles z < 0.5', () => {
    expect(Number.isFinite(logGamma(0.3))).toBe(true);
    // Γ(z)Γ(1-z) = π/sin(πz)
    const gz = Math.exp(logGamma(0.3));
    const g1z = Math.exp(logGamma(0.7));
    expect(gz * g1z).toBeCloseTo(Math.PI / Math.sin(Math.PI * 0.3), 6);
  });

  it('logGamma is finite and correct for negative non-integer inputs', () => {
    // REGRESSION. The version of this test above asserts only `z = 0.3` and
    // `z = 0.7`, which are both POSITIVE, so despite its name it never took the
    // `z < 0.5` branch with a negative argument. The reflection formula was
    // therefore free to divide by a negative sine and take `Math.log` of the
    // result, which is NaN -- and it did:
    //
    //   logGamma(-0.5) returned NaN, and so did every other negative
    //   non-integer z in (-1, 0), (-3, -2), ... .
    //
    // `logGamma(-1.5)` kept working only because `sin(-1.5 * pi)` happens to be
    // positive, which is exactly why the defect survived: a spot check on the
    // wrong half-period looks healthy.
    //
    // Reference values are `math.lgamma` from the C library. The sign of the
    // sine carries no information -- it only says which half-period z is in --
    // so the identity uses `|sin(pi z)|`.
    const reference: [number, number][] = [
      [-2.5, -0.05624371649767457],
      [-1.75, 1.0160888092144358],
      [-1.5, 0.8600470153764812],
      [-1.25, 1.3664317612369756],
      [-0.75, 1.5757045971498589],
      [-0.5, 1.265512123484645],
      [-0.25, 1.5895753125511862],
    ];
    for (const [z, expected] of reference) {
      const actual = logGamma(z);
      expect(Number.isFinite(actual), `logGamma(${z}) must be finite`).toBe(true);
      expect(actual, `logGamma(${z})`).toBeCloseTo(expected, 12);
    }
  });

  it('logGamma satisfies the reflection identity across both half-periods', () => {
    // The identity is the property the implementation is built on, so assert it
    // directly rather than only through a table of constants: it must hold for
    // negative z as well, where the sign of the sine flips.
    for (const z of [-0.25, -0.5, -0.75, -1.25, -1.5, 0.25, 0.3, 0.7]) {
      const lhs = logGamma(z) + logGamma(1 - z);
      const rhs = Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z)));
      expect(lhs, `reflection identity at z=${z}`).toBeCloseTo(rhs, 10);
    }
  });

  it('studentTCdf is a valid CDF at extremes', () => {
    expect(studentTCdf(0, 10)).toBeCloseTo(0.5, 12);
    expect(studentTCdf(Infinity, 10)).toBeCloseTo(1, 12);
    expect(studentTCdf(-Infinity, 10)).toBeCloseTo(0, 12);
    expect(studentTCdf(1, 10)).toBeGreaterThan(0.5);
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

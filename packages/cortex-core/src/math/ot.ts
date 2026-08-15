/**
 * Entropy-regularized optimal transport (Sinkhorn-Knopp). Used to measure memory
 * diversity and to constrain consolidation so semantic distillation preserves the
 * information distribution of episodic memory.
 */
import { Matrix } from 'ml-matrix';

export type SinkhornResult = {
  /** The optimal coupling matrix P of shape [m x n]. */
  coupling: Matrix;
  /** The regularized transport cost (Sinkhorn distance). */
  cost: number;
  /** Number of iterations performed. */
  iterations: number;
  /** True if the marginal constraints were satisfied within tolerance. */
  converged: boolean;
};

/**
 * @param a source histogram (length m), normalized to sum 1.
 * @param b target histogram (length n), normalized to sum 1.
 * @param cost m×n cost matrix.
 * @param epsilon entropy regularization strength (>0; smaller = closer to exact OT).
 */
export function sinkhorn(
  a: number[],
  b: number[],
  cost: number[][],
  epsilon: number,
  maxIter = 2000,
  tol = 1e-9,
): SinkhornResult {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) {
    throw new Error('sinkhorn: histograms must be non-empty');
  }
  if (cost.length !== m || cost.some((row) => row.length !== n)) {
    throw new Error('sinkhorn: cost matrix shape mismatch');
  }
  // Kernel K = exp(-C / epsilon).
  const k = new Matrix(m, n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      k.set(i, j, Math.exp(-cost[i]![j]! / epsilon));
    }
  }
  const u = new Float64Array(m).fill(1);
  const v = new Float64Array(n).fill(1);
  let converged = false;
  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const uPrev = u;
    // Update scaling vectors (Knopp iteration).
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) {
        s += k.get(i, j) * v[j]!;
      }
      u[i] = s === 0 ? 1 : a[i]! / s;
    }
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) {
        s += k.get(i, j) * u[i]!;
      }
      v[j] = s === 0 ? 1 : b[j]! / s;
    }
    // Check convergence of u (the more sensitive scaling).
    let maxDiff = 0;
    for (let i = 0; i < m; i++) {
      const d = Math.abs(u[i]! - uPrev[i]!);
      if (d > maxDiff) {
        maxDiff = d;
      }
    }
    if (maxDiff < tol) {
      converged = true;
      break;
    }
  }
  // Assemble coupling P = diag(u) K diag(v).
  const p = new Matrix(m, n);
  let transportCost = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const value = u[i]! * k.get(i, j) * v[j]!;
      p.set(i, j, value);
      transportCost += value * cost[i]![j]!;
    }
  }
  return { coupling: p, cost: transportCost, iterations, converged };
}

/** Squared Euclidean cost matrix between two sets of row vectors. */
export function squaredEuclideanCostMatrix(x: number[][], y: number[][]): number[][] {
  return x.map((xi) =>
    y.map((yj) => {
      let s = 0;
      for (let d = 0; d < xi.length; d++) {
        const diff = xi[d]! - yj[d]!;
        s += diff * diff;
      }
      return s;
    }),
  );
}

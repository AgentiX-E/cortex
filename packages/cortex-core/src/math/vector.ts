/**
 * High-precision vector primitives operating on Float64Array. All reductions use
 * Kahan compensated summation to avoid catastrophic cancellation.
 */
import { kahanSum } from './stats.js';

export function dot(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    throw new Error(`vector dimension mismatch: ${a.length} != ${b.length}`);
  }
  let sum = 0;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    const y = a[i]! * b[i]! - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

export function norm(v: Float64Array): number {
  return Math.sqrt(kahanSum(Array.from(v, (x) => x * x)));
}

export function normalize(v: Float64Array): Float64Array {
  const n = norm(v);
  if (n === 0) {
    return new Float64Array(v);
  }
  return new Float64Array(v.map((x) => x / n));
}

export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot(a, b) / (na * nb);
}

export function l2Distance(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    throw new Error(`vector dimension mismatch: ${a.length} != ${b.length}`);
  }
  let sum = 0;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    const y = d * d - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return Math.sqrt(sum);
}

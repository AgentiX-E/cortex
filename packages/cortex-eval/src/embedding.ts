/**
 * Deterministic hashing embedding: maps text tokens to a fixed-dimension sparse
 * unit vector via FNV-1a hashing. It is a real (if simple) embedding model used
 * for reproducible, network-free evaluation; production systems inject a learned
 * `EmbeddingModel` (transformers.js or a remote API) through the same contract.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';

export class HashEmbedding implements EmbeddingModel {
  private readonly dim: number;

  constructor(dim: number) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`dimension must be a positive integer, got ${dim}`);
    }
    this.dim = dim;
  }

  dimension(): number {
    return this.dim;
  }

  async embed(texts: string[]): Promise<Float64Array[]> {
    return texts.map((text) => embedOne(text, this.dim));
  }
}

export function embedOne(text: string, dim: number): Float64Array {
  const vector = new Float64Array(dim);
  let touched = false;
  for (const token of tokenize(text)) {
    const h = fnv1a(token);
    vector[h % dim] = 1;
    touched = true;
  }
  if (!touched) {
    return vector;
  }
  const norm = Math.sqrt(vector.reduce((acc, x) => acc + x * x, 0));
  return new Float64Array(vector.map((x) => x / norm));
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** FNV-1a 32-bit hash (deterministic across runs and platforms). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

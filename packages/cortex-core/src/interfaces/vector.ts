/* istanbul ignore file -- type-only declaration, no runtime code */
/**
 * Vector index abstraction: approximate or exact nearest-neighbour search over
 * Float64Array vectors. Implementations: brute-force (exact, all environments),
 * sqlite-vec (embedded), pgvector (remote), in-memory (browser).
 */
export type VectorHit = {
  id: string;
  /** Similarity in [0, 1] where 1 is identical; higher is better. */
  score: number;
  meta?: unknown;
};

export type VectorFilter = {
  /** Only consider vectors whose metadata matches all these tags. */
  tags?: string[];
};

export interface VectorIndex {
  add(id: string, vector: Float64Array, meta?: unknown): Promise<void>;
  search(query: Float64Array, k: number, filter?: VectorFilter): Promise<VectorHit[]>;
  remove(id: string): Promise<void>;
  size(): Promise<number>;
}

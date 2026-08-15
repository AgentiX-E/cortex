/**
 * Brute-force exact nearest-neighbour search over Float64Array vectors. The
 * universal fallback that works in every environment; doubles as the accuracy
 * reference against which approximate indexes are measured.
 */
import type { VectorHit, VectorIndex, VectorFilter } from '../interfaces/vector.js';
import { cosineSimilarity } from '../math/vector.js';

type Entry = { id: string; vector: Float64Array; meta?: unknown };

export class BruteForceVectorIndex implements VectorIndex {
  private readonly entries = new Map<string, Entry>();

  async add(id: string, vector: Float64Array, meta?: unknown): Promise<void> {
    this.entries.set(id, { id, vector: new Float64Array(vector), meta });
  }

  async search(query: Float64Array, k: number, filter?: VectorFilter): Promise<VectorHit[]> {
    const hits: VectorHit[] = [];
    for (const entry of this.entries.values()) {
      if (filter?.tags && !matchesTags(entry.meta, filter.tags)) {
        continue;
      }
      hits.push({
        id: entry.id,
        score: cosineSimilarity(query, entry.vector),
        meta: entry.meta,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async size(): Promise<number> {
    return this.entries.size;
  }
}

function matchesTags(meta: unknown, tags: string[]): boolean {
  if (meta == null || typeof meta !== 'object') {
    return false;
  }
  const record = meta as Record<string, unknown>;
  const metaTags = Array.isArray(record['tags']) ? (record['tags'] as string[]) : [];
  return tags.every((t) => metaTags.includes(t));
}

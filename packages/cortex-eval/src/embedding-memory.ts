/**
 * A realistic embedding-based memory system. Ingests key=value facts into a
 * vector index, retrieves the nearest neighbour by cosine similarity, and
 * abstains when the best similarity is below a calibrated threshold. This
 * demonstrates the M2 feature (value-driven retrieval + abstention) end-to-end
 * on top of the cortex-core primitives.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { BruteForceVectorIndex } from '@agentix-e/cortex-core';
import type { Answer, MemorySystem } from './types.js';
import { splitKeyValue } from './fact-memory.js';
import { fnv1a } from './embedding.js';

export type EmbeddingMemorySystemOptions = {
  embedding: EmbeddingModel;
  /** Abstain (return null) when the best cosine similarity is below this value. */
  abstainThreshold?: number;
  /** Number of neighbours to consider (default 1). */
  topK?: number;
  /** Fallback answer when the system never abstains (baseline behavior). */
  fallback?: string;
};

type StoredFact = { key: string; value: string };

export class EmbeddingMemorySystem implements MemorySystem {
  readonly name: string;
  private readonly options: EmbeddingMemorySystemOptions;
  private readonly index = new BruteForceVectorIndex();
  private readonly facts = new Map<string, StoredFact>();

  constructor(name: string, options: EmbeddingMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  async answer(question: string, context: string[]): Promise<Answer> {
    await this.ingest(context);

    const [queryVec] = await this.options.embedding.embed([question]);
    const hits = await this.index.search(queryVec!, this.options.topK ?? 1);

    if (hits.length === 0) {
      return this.options.fallback ?? null;
    }
    const best = hits[0]!;
    if (this.options.abstainThreshold != null && best.score < this.options.abstainThreshold) {
      return null;
    }
    return this.facts.get(best.id)?.value ?? this.options.fallback ?? null;
  }

  private async ingest(context: string[]): Promise<void> {
    for (const fact of context) {
      const entry = splitKeyValue(fact);
      if (!entry) {
        continue;
      }
      const id = `f-${fnv1a(entry.key)}`;
      if (this.facts.has(id)) {
        continue;
      }
      const [vec] = await this.options.embedding.embed([entry.key]);
      await this.index.add(id, vec!);
      this.facts.set(id, { key: entry.key, value: entry.value });
    }
  }
}

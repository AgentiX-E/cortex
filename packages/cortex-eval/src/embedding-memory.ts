/**
 * A realistic embedding-based memory system. Ingests key=value facts into a
 * vector index, retrieves the nearest neighbour by cosine similarity, and
 * abstains when the best similarity is below a calibrated threshold. This
 * demonstrates the M2 feature (value-driven retrieval + abstention) end-to-end
 * on top of the cortex-core primitives.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { BruteForceVectorIndex, EmbeddingSpace } from '@agentix-e/cortex-core';
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
  /**
   * The index and the model that fills it, bound once.
   *
   * This system keeps its store on the instance, so the space is opened on the first question and
   * kept: a model whose identity is unstated works here, because the store is never reopened and
   * therefore never has to be re-described. A class that has to reopen a persisted index is the case
   * `stored` exists for, and `EmbeddingSpace`'s own docstring is where that is spelled out.
   */
  private space: EmbeddingSpace | null = null;

  constructor(name: string, options: EmbeddingMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  async answer(question: string, context: string[]): Promise<Answer> {
    const space =
      this.space ??
      (await EmbeddingSpace.open({ model: this.options.embedding, index: this.index }));
    this.space = space;
    await this.ingest(space, context);

    const [queryVec] = await this.options.embedding.embed([question]);
    const hits = await space.searchVector(queryVec!, this.options.topK ?? 1);

    if (hits.length === 0) {
      return this.options.fallback ?? null;
    }
    const best = hits[0]!;
    if (this.options.abstainThreshold != null && best.score < this.options.abstainThreshold) {
      return null;
    }
    // `ingest` adds an entry to the index and to the fact map in the same
    // iteration, and both are private, so a returned hit always has a payload
    // (`BruteForceVectorIndex.remove` exists but has no caller here).
    return this.facts.get(best.id)!.value;
  }

  private async ingest(space: EmbeddingSpace, context: string[]): Promise<void> {
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
      await space.addVector(id, vec!);
      this.facts.set(id, { key: entry.key, value: entry.value });
    }
  }
}

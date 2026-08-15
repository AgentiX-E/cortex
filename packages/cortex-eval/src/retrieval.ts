/**
 * Shared retrieval primitives for natural-language memory. Keeping a single
 * retrieval implementation (bounded-batch embedding + per-question index +
 * cosine search) removes code drift between the benchmark system and the
 * diagnostics harness, so any remaining score discrepancy can only come from the
 * embedding provider rather than from divergent retrieval logic.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { BruteForceVectorIndex } from '@agentix-e/cortex-core';

/** Zhipu embedding-3 accepts at most 64 inputs per request. */
const EMBED_BATCH = 64;

/** Shared cache of embedding vectors keyed by source text. */
const embeddingCache = new Map<string, Float64Array>();

/** Clear the shared embedding cache (used by tests and long-running processes). */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

/** Stable 32-bit string hash used only for internal vector-index ids. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Embed many texts in bounded batches, reusing cached vectors. */
export async function embedManyCached(
  embedding: EmbeddingModel,
  texts: string[],
): Promise<Float64Array[]> {
  const result = new Array<Float64Array>(texts.length);
  const missing: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = embeddingCache.get(texts[i]!);
    if (cached) {
      result[i] = cached;
    } else {
      missing.push(i);
    }
  }
  for (let start = 0; start < missing.length; start += EMBED_BATCH) {
    const chunk = missing.slice(start, start + EMBED_BATCH);
    const vectors = await embedding.embed(chunk.map((i) => texts[i]!));
    for (let j = 0; j < chunk.length; j++) {
      const idx = chunk[j]!;
      const vector = vectors[j] ?? new Float64Array(0);
      embeddingCache.set(texts[idx]!, vector);
      result[idx] = vector;
    }
  }
  return result;
}

/** Embed a single text via the shared cache. */
export async function embedOneCached(
  embedding: EmbeddingModel,
  text: string,
): Promise<Float64Array> {
  return (await embedManyCached(embedding, [text]))[0]!;
}

export type RetrievalHit = {
  id: string;
  text: string;
  score: number;
};

/**
 * Build a per-question index over `context` and return the top-k turns for
 * `question`. The index is rebuilt on every call so state never leaks across
 * LongMemEval questions (which have independent haystacks).
 */
export async function retrieveTopK(
  embedding: EmbeddingModel,
  question: string,
  context: string[],
  topK: number,
): Promise<RetrievalHit[]> {
  const index = new BruteForceVectorIndex();
  const texts = new Map<string, string>();

  const pending: string[] = [];
  for (const turn of context) {
    const id = `t-${hashText(turn)}`;
    if (!texts.has(id)) {
      pending.push(turn);
    }
  }
  if (pending.length > 0) {
    const vectors = await embedManyCached(embedding, pending);
    for (let i = 0; i < pending.length; i++) {
      const turn = pending[i]!;
      const id = `t-${hashText(turn)}`;
      await index.add(id, vectors[i]!);
      texts.set(id, turn);
    }
  }

  const queryVec = await embedOneCached(embedding, question);
  const hits = await index.search(queryVec, topK);
  // Every hit id was inserted via `texts.set`, so the lookup is always defined.
  return hits.map((h) => ({ id: h.id, text: texts.get(h.id)!, score: h.score }));
}

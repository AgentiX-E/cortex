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
  /** Position of this turn in the original `context` array. */
  index: number;
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
  const idToIndex = new Map<string, number>();

  const pending: string[] = [];
  for (let i = 0; i < context.length; i++) {
    const turn = context[i]!;
    const id = `t-${hashText(turn)}`;
    if (!texts.has(id)) {
      pending.push(turn);
      idToIndex.set(id, i);
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
  // Every hit id was inserted via `texts.set`, so the lookups are always defined.
  return hits.map((h) => ({
    id: h.id,
    text: texts.get(h.id)!,
    score: h.score,
    index: idToIndex.get(h.id) ?? -1,
  }));
}

/**
 * Expand a set of retrieved turn indices into a coherent context window: return
 * the turns at `indices` plus up to `radius` neighbours on each side, preserving
 * order and de-duplicating overlaps.
 */
export function expandContextWindow(context: string[], indices: number[], radius: number): string {
  const selected = new Set<number>();
  for (const idx of indices) {
    if (idx < 0 || idx >= context.length) {
      continue;
    }
    const start = Math.max(0, idx - radius);
    const end = Math.min(context.length - 1, idx + radius);
    for (let j = start; j <= end; j++) {
      selected.add(j);
    }
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => context[i]!)
    .join('\n');
}

/** Mean-pool a list of equal-length vectors into a single centroid vector. */
export function meanPool(vectors: readonly Float64Array[]): Float64Array {
  if (vectors.length === 0) {
    return new Float64Array(0);
  }
  const dim = vectors[0]!.length;
  const sum = new Float64Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] = sum[i]! + v[i]!;
    }
  }
  for (let i = 0; i < dim; i++) {
    sum[i] = sum[i]! / vectors.length;
  }
  return sum;
}

export type SessionHit = {
  id: string;
  /** Index of this session in the input `sessions` array. */
  sessionIndex: number;
  /** The full session text (all turns joined). */
  text: string;
  score: number;
};

/**
 * Session-level retrieval: represent each session by the mean of its turn
 * embeddings, index those session centroids, and return the top-k sessions for
 * `question`. Retrieving whole sessions (rather than isolated turns) lets a
 * multi-session question aggregate evidence that is spread across sessions.
 */
export async function retrieveTopKSessions(
  embedding: EmbeddingModel,
  question: string,
  sessions: string[][],
  topK: number,
): Promise<SessionHit[]> {
  // Flatten all turns once so a single batched embedding pass covers every
  // session, and remember where each session's turns begin/end.
  const flat: string[] = [];
  const bounds: number[] = [0];
  for (const session of sessions) {
    flat.push(...session);
    bounds.push(flat.length);
  }

  const vectors = flat.length > 0 ? await embedManyCached(embedding, flat) : [];
  const index = new BruteForceVectorIndex();
  const texts = new Map<string, string>();
  const idToSession = new Map<string, number>();

  for (let s = 0; s < sessions.length; s++) {
    const session = sessions[s]!;
    if (session.length === 0) {
      continue;
    }
    const sessionVec = meanPool(vectors.slice(bounds[s], bounds[s + 1]));
    if (sessionVec.length === 0) {
      continue;
    }
    const id = `s-${hashText(session.join('\n'))}`;
    await index.add(id, sessionVec);
    texts.set(id, session.join('\n'));
    idToSession.set(id, s);
  }

  if (texts.size === 0) {
    return [];
  }
  const queryVec = await embedOneCached(embedding, question);
  const hits = await index.search(queryVec, topK);
  // Every hit id was inserted via `texts.set`, so the lookups are always defined.
  return hits.map((h) => ({
    id: h.id,
    sessionIndex: idToSession.get(h.id) ?? -1,
    text: texts.get(h.id)!,
    score: h.score,
  }));
}
